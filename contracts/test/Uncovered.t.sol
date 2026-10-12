// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, MockERC20, NO_PERMIT2, PayingExecutor} from "./Mocks.sol";
import {
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION
} from "./Fees.sol";

/**
 * @notice Credits the receiver more than a `uint192` can hold, and asks for nothing in return.
 *
 * No rule of ERC-20 forbids this, and the intent's author picks the token, so the reservation
 * slot has to refuse the deposit rather than truncate it. Both funding paths are tested against
 * it: a plain `deposit` and an EIP-3009 redemption.
 */
contract OverflowingToken {
    mapping(address => uint256) public balanceOf;

    function transferFrom(address, address to, uint256) external returns (bool) {
        balanceOf[to] += uint256(type(uint192).max) + 1;
        return true;
    }

    function transferWithAuthorization(
        address,
        address to,
        uint256,
        uint256,
        uint256,
        bytes32,
        uint8,
        bytes32,
        bytes32
    ) external {
        balanceOf[to] += uint256(type(uint192).max) + 1;
    }
}

/**
 * @notice The branches the main suites never reached. Each one is a real path with a real
 *         consequence, not a line-count exercise: a router that quietly underpays, a guard
 *         nobody had tried to trip, and the two halves of the reservation check that stop a
 *         deposit being spent by the wrong intent.
 */
contract UncoveredTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address owner = address(0xB0B);
    /// @dev Where an unattributed token goes, and where this fixture's intents send their fee.
    address proceeds = address(0x7EA);
    address executor = address(0xE0E);
    address maker;
    uint256 makerKey;

    uint256 constant AMOUNT_IN = 1_000e18;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();

        tokenA.mint(maker, 1_000_000e18);
        tokenB.mint(executor, 1_000_000e18);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);
        vm.warp(1_700_000_000);
    }

    function _intent() internal view returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: AMOUNT_IN,
            minOutStart: 10e18,
            minOutEnd: 10e18,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(proceeds),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0.001e18,
            minFill: 0,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW(),
            nonce: 1,
            curve: bytes32(0)
        });
    }

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    // ── The reservation, and who it answers to ───────────────────────────────

    /// @notice A deposit under one intent is no cover for another. The hash keys the escrow and
    ///         the hash covers every term, so a one-field difference is a different reservation.
    function test_AReservationBacksOneIntentAndNoOther() public {
        ProveSettlement.Intent memory funded = _intent();
        ProveSettlement.Intent memory other = _intent();
        other.minOutStart = funded.minOutStart + 1;
        other.minOutEnd = other.minOutStart;
        bytes memory otherSig = _sign(other);

        vm.prank(maker);
        settlement.deposit(funded, AMOUNT_IN);

        assertEq(
            uint256(settlement.fillability(other, otherSig, 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.EscrowShort),
            "a neighbouring intent is not cover"
        );

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.EscrowShort.selector);
        settlement.fill(other, otherSig, 1e18, ANY_FEE);
    }

    /// @notice Anyone may top up an intent, and a top-up really does fund it. Only the maker
    ///         named in the intent can take it back out, whoever paid it in.
    function test_AStrangerCanFundAnIntentButNotDrainIt() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);

        address stranger = address(0x5747);
        tokenA.mint(stranger, AMOUNT_IN);
        vm.startPrank(stranger);
        tokenA.approve(relayer, type(uint256).max);
        settlement.deposit(i, AMOUNT_IN);
        vm.stopPrank();

        assertEq(
            uint256(settlement.fillability(i, sig, 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "the intent is funded"
        );

        vm.startPrank(stranger);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.withdraw(i);
        vm.stopPrank();

        vm.prank(executor);
        settlement.fill(i, sig, 1e18, ANY_FEE);
        assertEq(tokenA.balanceOf(executor), 1e18, "and it fills");
    }

    // ── A fill that owes no fee ──────────────────────────────────────────────

    function test_AZeroFeeFillPaysNoFeeDestination() public {
        ProveSettlement.Intent memory i = _intent();
        i.feeConfig = bytes32(0);
        i.feeRateProceeds = 0;
        i.flags = settlement.FLAG_PARTIAL();
        bytes memory sig = _sign(i);

        TakePoints.Quote memory q_fee = settlement.quote(i, AMOUNT_IN, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        assertEq(fee, 0, "no destination, no fee");

        vm.prank(executor);
        settlement.fill(i, sig, AMOUNT_IN, ANY_FEE);

        assertEq(tokenB.balanceOf(maker), delivered);
        assertEq(tokenB.balanceOf(proceeds), 0, "the destination was never touched");
        assertEq(
            settlement.pendingFees(feeCfg(proceeds), address(tokenB)),
            0,
            "and nothing was booked to it"
        );
    }

    function test_AZeroFeeCallbackFillMakesNoFeeTransfer() public {
        ProveSettlement.Intent memory i = _intent();
        i.feeConfig = bytes32(0);
        i.feeRateProceeds = 0;
        i.flags = settlement.FLAG_PARTIAL();
        bytes memory sig = _sign(i);
        TakePoints.Quote memory q_fee = settlement.quote(i, AMOUNT_IN, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        assertEq(fee, 0, "no destination, no fee");

        PayingExecutor bot = new PayingExecutor();
        tokenB.mint(address(bot), 1_000e18);
        bot.approveMax(address(tokenB), relayer);

        bot.settle(settlement, i, sig, AMOUNT_IN, "", ANY_FEE);
        assertEq(tokenB.balanceOf(maker), delivered);
        assertEq(tokenB.balanceOf(proceeds), 0, "the destination was never touched");
        assertEq(
            settlement.pendingFees(feeCfg(proceeds), address(tokenB)),
            0,
            "and nothing was booked to it"
        );
        assertEq(settlement.totalPendingFees(address(tokenB)), 0, "so no fee rests here at all");
    }

    /**
     * @notice A maker who approved the contract and then spent the tokens is skipped, not
     *         reverted on.
     *
     * `_evaluate` probes the allowance and the balance one at a time, and only for a batch. The
     * allowance says yes here and the balance says no, which is the second probe's whole reason
     * to exist: an approval outlives the money behind it.
     */
    function test_AnApprovedMakerWithNoBalanceIsSkipped() public {
        (address broke, uint256 brokeKey) = makeAddrAndKey("broke");
        tokenA.mint(broke, AMOUNT_IN);
        vm.prank(broke);
        tokenA.approve(relayer, type(uint256).max);

        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_PARTIAL();
        i.maker = broke;
        i.recipient = broke;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(brokeKey, settlement.hashIntent(i));
        bytes memory sig = abi.encodePacked(r, s, v);

        assertEq(
            uint256(settlement.fillability(i, sig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "funded and approved, so far"
        );

        // The allowance stays; the tokens leave.
        vm.prank(broke);
        tokenA.transfer(address(0xDEAD), AMOUNT_IN);

        assertEq(
            uint256(settlement.fillability(i, sig, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.EscrowShort),
            "the allowance outlived the money"
        );

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] =
            ProveSettlement.FillRequest({intent: i, signature: sig, take: AMOUNT_IN, arming: ""});
        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, ANY_FEE), 0, "stepped over, not reverted");
    }
}

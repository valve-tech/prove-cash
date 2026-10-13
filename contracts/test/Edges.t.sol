// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FeeConfig} from "../src/FeeConfig.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, MockERC20, NO_PERMIT2} from "./Mocks.sol";
import {
    feeCfg,
    singleConfig,
    newSettlement,
    claimFor,
    pendingFor,
    claimedBalance,
    strayConfig,
    STRAY_DESTINATION,
    availableOf
} from "./Fees.sol";

/// @notice The corners: the admin surface, the view helpers, and every revert that the happy
///         paths never reach. Cheap to write, and they are exactly where an untested branch
///         hides a wrong `if`.
contract EdgesTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address owner = address(0xB0B);
    /// @dev Where an unattributed token goes, and where this fixture's intents send their fee.
    ///      A plain address: the settlement never calls it, and nothing here needs it to be a
    ///      contract.
    address proceeds = address(0x7EA);
    address stranger = address(0x5747);
    address executor = address(0xE0E);
    address maker;
    uint256 makerKey;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        vm.warp(1_700_000_000);
    }

    function _intent() internal view returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: 1_000e18,
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
            flags: settlement.FLAG_PARTIAL(),
            nonce: 1,
            curve: bytes32(0)
        });
    }

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    // ── Construction ─────────────────────────────────────────────────────────

    /**
     * @notice An intent that pays this contract, or the relayer, is refused rather than filled.
     *
     * Both addresses are one-way. `withdraw` pays `_reserved[h]` and `_reserved` is keyed by
     * intent hash, so the settlement cannot even work out which part of its own balance is
     * unclaimed; the relayer's whole surface is `pull`. Neither has a rescue path and neither
     * should, because a rescue is an owner switch over a maker's money.
     *
     * A maker could reach both by filling in a form. Refusing the terms turns a delivery nobody
     * can retrieve into a signature that never settles.
     */
    function test_AnIntentPayingAnAddressItCannotLeaveIsRefused() public view {
        address[2] memory oneWay = [address(settlement), settlement.relayer()];

        for (uint256 k = 0; k < oneWay.length; k++) {
            ProveSettlement.Intent memory toThem = _intent();
            toThem.recipient = oneWay[k];
            assertEq(
                uint256(settlement.fillability(toThem, _sign(toThem), 1, executor, ANY_FEE)),
                uint256(ProveSettlement.Reason.BadTerms_),
                "recipient"
            );

            // A fee destination is no longer visible at fill time (the intent signs a hash), so
            // there is nothing to refuse there. The settlement and the relayer are refused at
            // the one place the preimage is known: `claim` (see the next test).
        }

        // The ordinary intent the two are varied from fails its terms for no reason at all, so
        // the destination is what those two were refused for and not the fixture. Not `Ok`: this
        // fixture has no allowance behind it, and that is a different complaint.
        ProveSettlement.Intent memory ok = _intent();
        assertTrue(
            settlement.fillability(ok, _sign(ok), 1, executor, ANY_FEE)
                != ProveSettlement.Reason.BadTerms_,
            "the control"
        );
    }

    // ── Ownership ────────────────────────────────────────────────────────────

    // ── Views ────────────────────────────────────────────────────────────────

    /// @notice The constructor refuses a stray config that is not valid, and a zero Permit2.
    function test_ConstructorRejectsABadStrayConfig() public {
        FeeConfig.Config memory bad = strayConfig();
        bad.weights[0] = 1; // does not sum to WAD
        vm.expectRevert(
            abi.encodeWithSelector(
                ProveSettlement.InvalidConfig.selector, FeeConfig.Fault.WeightsDoNotSumToWad
            )
        );
        new ProveSettlement(bad, NO_PERMIT2);

        vm.expectRevert(ProveSettlement.BadParameter.selector);
        new ProveSettlement(strayConfig(), address(0));
    }

    /// @notice The settlement and the relayer are one-way: a fee booked to a config that names
    ///         either can never be paid out, and `claim` says so instead of burning the book.
    function test_AConfigNamingAOneWayAddressCannotBeClaimed() public {
        address[2] memory oneWay = [address(settlement), settlement.relayer()];
        for (uint256 k = 0; k < oneWay.length; k++) {
            FeeConfig.Config memory c = singleConfig(oneWay[k]);
            vm.expectRevert(
                abi.encodeWithSelector(
                    ProveSettlement.InvalidConfig.selector, FeeConfig.Fault.ReservedDestination
                )
            );
            settlement.claim(c, address(tokenA));
        }
    }

    function test_AvailableTracksTheLifecycle() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        tokenA.mint(maker, 1_000e18);
        tokenB.mint(executor, 1_000e18);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        (uint256 remaining, bool live) = availableOf(settlement, i);
        assertEq(remaining, i.amountIn);
        assertTrue(live);

        vm.prank(executor);
        settlement.fill(i, sig, 400e18, ANY_FEE);
        (remaining, live) = availableOf(settlement, i);
        assertEq(remaining, 600e18);
        assertTrue(live);

        vm.warp(i.endTime);
        (, live) = availableOf(settlement, i);
        assertFalse(live, "expired is not live");
    }

    function test_FillabilityExplainsWhyNot() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        tokenA.mint(maker, 1_000e18);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);

        assertEq(
            uint256(settlement.fillability(i, sig, 100e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok)
        );
        assertEq(
            uint256(settlement.fillability(i, sig, 0, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.NothingToFill)
        );
        assertEq(
            uint256(settlement.fillability(i, sig, 2_000e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.TooMuch)
        );

        vm.prank(maker);
        settlement.cancel(i);
        assertEq(
            uint256(settlement.fillability(i, sig, 1, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Cancelled)
        );
    }

    function test_FillabilityReportsAnEmptyEscrow() public view {
        ProveSettlement.Intent memory i = _intent();
        i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
        bytes memory sig = _sign(i);

        assertEq(
            uint256(settlement.fillability(i, sig, 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.EscrowShort)
        );
    }

    function test_FillabilityReportsAMissingAllowance() public view {
        // The maker signed but never approved: a batch must be able to see that and step over.
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        assertEq(
            uint256(settlement.fillability(i, sig, 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.EscrowShort)
        );
    }

    function test_FillabilityRejectsNonsenseTerms() public view {
        ProveSettlement.Intent memory rising = _intent();
        rising.minOutEnd = rising.minOutStart + 1;
        assertEq(
            uint256(settlement.fillability(rising, _sign(rising), 1, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.BadTerms_)
        );

        ProveSettlement.Intent memory sameToken = _intent();
        sameToken.tokenOut = sameToken.tokenIn;
        assertEq(
            uint256(settlement.fillability(sameToken, _sign(sameToken), 1, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.BadTerms_)
        );
    }

    function test_DomainSeparatorFollowsTheChain() public {
        bytes32 here = settlement.domainSeparator();
        vm.chainId(block.chainid + 1);
        assertTrue(settlement.domainSeparator() != here, "a fork gets its own domain");
    }

    // ── Escrow corners ───────────────────────────────────────────────────────

    function test_DepositRejectsZero() public {
        ProveSettlement.Intent memory i = _intent();
        vm.prank(maker);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.deposit(i, 0);
    }

    /// @notice The token a deposit moves comes from the intent, never from the caller. Two
    ///         intents that differ only in `tokenIn` hash differently, so they never share a
    ///         reservation and no caller can key one to a token of their choosing.
    function test_AReservationTakesItsTokenFromTheIntent() public {
        ProveSettlement.Intent memory inA = _intent();
        ProveSettlement.Intent memory inB = _intent();
        inB.tokenIn = address(tokenB);

        tokenA.mint(maker, 100e18);
        tokenB.mint(maker, 100e18);

        vm.startPrank(maker);
        tokenA.approve(relayer, type(uint256).max);
        tokenB.approve(relayer, type(uint256).max);
        settlement.deposit(inA, 100e18);
        vm.stopPrank();

        assertEq(tokenA.balanceOf(address(settlement)), 100e18, "it moved token A");
        assertEq(settlement.reserved(settlement.hashIntent(inA)), 100e18);
        assertEq(settlement.reserved(settlement.hashIntent(inB)), 0, "a separate reservation");
    }

    function test_OnlyTheMakerWithdraws() public {
        ProveSettlement.Intent memory i = _intent();
        tokenA.mint(maker, 100e18);
        vm.startPrank(maker);
        tokenA.approve(relayer, type(uint256).max);
        settlement.deposit(i, 100e18);
        vm.stopPrank();

        vm.startPrank(stranger);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.withdraw(i);
        vm.stopPrank();
    }

    function test_InvalidateBeforeOnlyMovesForward() public {
        vm.startPrank(maker);
        settlement.invalidateBefore(10);

        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.invalidateBefore(10);

        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.invalidateBefore(9);

        // The floor is one number and it bites at once. It used to share a slot with an
        // effective-at time, for a cooldown that no longer exists, and the slot's width is what
        // made a floor past uint192 an error. Neither constraint survives.
        assertEq(settlement.nonceFloor(maker), 10);

        // Forward means forward IN THIS LANE. `type(uint256).max` is a nonce in the top lane, so
        // it raises the top lane's floor and lane 0 does not hear about it. Before #131 this line
        // read `nonceFloor(maker) == type(uint256).max`; the number moved because the argument is
        // now a coordinate rather than a magnitude.
        settlement.invalidateBefore(type(uint256).max);
        assertEq(
            settlement.laneFloor(maker, type(uint192).max),
            type(uint64).max,
            "the top lane took the floor"
        );
        assertEq(settlement.nonceFloor(maker), 10, "and lane 0 kept its own");

        // Monotonicity is per lane, so a lane nobody has touched still starts at zero and a
        // floor of 1 is a step forward there even after the line above.
        settlement.invalidateBefore((uint256(5) << 64) | 1);
        assertEq(settlement.laneFloor(maker, 5), 1, "lane 5 moved");
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.invalidateBefore((uint256(5) << 64) | 1);
        vm.stopPrank();
    }

    // ── Authorization corners ────────────────────────────────────────────────

    /**
     * @notice An authorization funds escrow, so the door refuses an intent that is not escrowed.
     *
     * It is the same flag `_armLeg` reads to pick its arm, so the door and a batch leg cannot
     * disagree about which signature a maker's bytes hold.
     */
    function test_AuthorizationRequiresTheEscrowFlag() public {
        ProveSettlement.Intent memory i = _intent(); // no escrow flag
        bytes memory sig = _sign(i);
        ProveSettlement.Authorization memory a;

        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.fillWithAuthorization(i, sig, 1e18, a, ANY_FEE);

        assertEq(tokenA.allowance(maker, relayer), 0, "the maker granted nothing");
    }

    // ── The minimum fill ─────────────────────────────────────────────────────

    /**
     * @notice A floor of 30 on an amount of 100 fills 30, 30, 30 — and then the last 10.
     *
     * The second clause of the rule is what this test exists for. `take >= minFill` alone leaves
     * every floored intent ending in dust that no fill can reach: the remainder is under the
     * floor from one side and the whole of what is left from the other. `|| take == remaining`
     * is what closes it out, and without it this test's last line reverts.
     */
    function test_AMinFillLeavesNoDust() public {
        ProveSettlement.Intent memory i = _intent();
        i.amountIn = 100e18;
        i.minOutStart = 100e18;
        i.minOutEnd = 100e18;
        i.minFill = 30e18;
        i.feeConfig = bytes32(0);
        i.feeRateProceeds = 0;
        bytes memory sig = _sign(i);

        tokenA.mint(maker, 100e18);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        tokenB.mint(executor, 1_000e18);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        // Under the floor while the intent is whole. Nothing to close out yet.
        vm.prank(executor);
        vm.expectRevert(ProveSettlement.BelowMinFill.selector);
        settlement.fill(i, sig, 29e18, ANY_FEE);

        vm.startPrank(executor);
        settlement.fill(i, sig, 30e18, ANY_FEE);
        settlement.fill(i, sig, 30e18, ANY_FEE);
        settlement.fill(i, sig, 30e18, ANY_FEE);

        // Ten left, and ten is under the floor. It closes the intent out, so it goes through.
        settlement.fill(i, sig, 10e18, ANY_FEE);
        vm.stopPrank();

        assertEq(settlement.filled(settlement.hashIntent(i)), 100e18, "no dust was left behind");
        assertEq(tokenA.balanceOf(executor), 100e18, "the executor took the lot");
    }

    /// @notice A floor of zero is no floor, which is what every intent signed before this field
    ///         existed carries. One wei still fills.
    function test_AZeroMinFillIsNoFloor() public {
        ProveSettlement.Intent memory i = _intent();
        assertEq(i.minFill, 0, "the default");
        bytes memory sig = _sign(i);

        tokenA.mint(maker, 1_000e18);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        tokenB.mint(executor, 1_000e18);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        vm.prank(executor);
        settlement.fill(i, sig, 1, ANY_FEE);
        assertEq(settlement.filled(settlement.hashIntent(i)), 1, "one wei went through");
    }

    /// @notice An all-or-nothing intent satisfies the floor on its only legal fill, whatever the
    ///         floor says. `PartialNotAllowed` is what refuses anything smaller, and it comes
    ///         first.
    function test_AMinFillNeverBitesOnAnAllOrNothingIntent() public {
        ProveSettlement.Intent memory i = _intent();
        i.flags = 0;
        i.minFill = type(uint256).max;
        bytes memory sig = _sign(i);

        tokenA.mint(maker, 1_000e18);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        tokenB.mint(executor, 1_000e18);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        assertEq(
            uint256(settlement.fillability(i, sig, 1e18, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.PartialNotAllowed),
            "a smaller take is refused for being partial, not for the floor"
        );

        vm.prank(executor);
        settlement.fill(i, sig, i.amountIn, ANY_FEE);
        assertEq(settlement.filled(settlement.hashIntent(i)), i.amountIn, "the whole of it filled");
    }

    // ── Callback corners ─────────────────────────────────────────────────────

    /// @notice The callback target is the caller, so a wallet cannot use this path at all: the
    ///         contract tries to call back an address with no code and the call itself fails.
    ///         An executor on this path is a contract or it is nothing.
    function test_ACallbackFillFromAnEoaCannotPay() public {
        ProveSettlement.Intent memory i = _intent();
        bytes memory sig = _sign(i);
        tokenA.mint(maker, 1e18);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);

        vm.prank(executor);
        vm.expectRevert();
        settlement.fillWithCallback(i, sig, 1e18, "", ANY_FEE);
    }
}

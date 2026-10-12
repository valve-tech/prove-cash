// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, BatchExecutor, MockERC3009, NO_PERMIT2} from "./Mocks.sol";
import {MockERC2612} from "./Permit.t.sol";
import {TaxedERC3009} from "./Arming.t.sol";
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
 * @notice Pricing a batch before paying for it — `dryRun`.
 *
 *   forge test --match-path test/DryRun.t.sol -vv
 *
 * `fillability` reads storage, and since a leg may carry `arming` that is no longer the whole
 * question. Whether a permit lands, and whether a redemption comes up short, are facts about a
 * transfer that has already happened, so the only honest way to answer is to make the calls and
 * then throw them away. That is what `dryRun` does, and the last group of tests here is the one
 * that matters: it proves the throwing away is real.
 */
contract DryRunTest is Test {
    ProveSettlement settlement;
    /// @dev Read once. `vm.prank` is single-shot and a call inside a pranked line eats the prank.
    address relayer;
    BatchExecutor exec;

    MockERC2612 tokenA;
    MockERC3009 tokenB;

    address owner = address(0x0117E1);
    address proceeds = address(0x9BEE);

    uint256 constant SIZE = 100e18;

    /// @dev One maker per rung, so a reason names the rung that produced it.
    address permitMaker;
    uint256 permitKey;
    address approvalMaker;
    uint256 approvalKey;
    address gaslessMaker;
    uint256 gaslessKey;

    function setUp() public {
        (permitMaker, permitKey) = makeAddrAndKey("permit maker");
        (approvalMaker, approvalKey) = makeAddrAndKey("approval maker");
        (gaslessMaker, gaslessKey) = makeAddrAndKey("gasless maker");

        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        exec = new BatchExecutor();

        tokenA = new MockERC2612();
        tokenB = new MockERC3009();

        tokenA.mint(permitMaker, SIZE);
        tokenA.mint(approvalMaker, SIZE);
        tokenB.mint(gaslessMaker, SIZE);

        vm.prank(approvalMaker);
        tokenA.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── What the walk reports ────────────────────────────────────────────────

    /// @notice A batch with nothing wrong with it reports `Ok` on every leg.
    function test_ACleanBatchReportsOkOnEveryLeg() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _approvalLeg(SIZE / 2);
        reqs[1] = _approvalLeg(SIZE / 2);

        ProveSettlement.Reason[] memory reasons = _dryRun(reqs);

        assertEq(reasons.length, 2, "one reason per leg");
        _assertOk(reasons[0], "the first leg fills");
        _assertOk(reasons[1], "and so does the second");
    }

    /// @notice Two halves of one intent. The second only reads `Ok` because the walk booked the
    ///         first, which is what makes this a walk rather than two independent questions.
    function test_TheWalkBooksEachLegForTheOnesBehindIt() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](3);
        reqs[0] = _approvalLeg(SIZE / 2);
        reqs[1] = _approvalLeg(SIZE / 2);
        reqs[2] = _approvalLeg(SIZE / 2);
        // One intent, taken in halves. The third half is one more than there is.
        reqs[1].intent.nonce = reqs[0].intent.nonce;
        reqs[2].intent.nonce = reqs[0].intent.nonce;
        reqs[1].signature = _sign(reqs[1].intent, approvalKey);
        reqs[2].signature = _sign(reqs[2].intent, approvalKey);

        ProveSettlement.Reason[] memory reasons = _dryRun(reqs);

        _assertOk(reasons[0], "the first half fills");
        _assertOk(reasons[1], "and the second empties it");
        _assertReason(reasons[2], ProveSettlement.Reason.TooMuch, "the third has nothing to take");
    }

    /// @notice A leg that needs arming reports `Ok`, because the arming worked. Nothing short of
    ///         making the call could have said so.
    function test_ALegThatNeedsArmingReportsOkWhenTheArmingWorks() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _permitLeg();
        reqs[1] = _gaslessLeg(tokenB);

        assertEq(tokenA.allowance(permitMaker, relayer), 0, "no allowance to fill against");
        assertEq(settlement.reserved(settlement.hashIntent(reqs[1].intent)), 0, "no escrow either");

        ProveSettlement.Reason[] memory reasons = _dryRun(reqs);

        _assertOk(reasons[0], "the permit landed");
        _assertOk(reasons[1], "and the redemption funded the escrow");
    }

    /// @notice The same two legs with nothing to arm them. `EscrowShort` is what "the maker's
    ///         funds are out of reach" reads as, on both rungs.
    function test_TheSameLegsWithoutTheirArmingReportEscrowShort() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _permitLeg();
        reqs[1] = _gaslessLeg(tokenB);
        reqs[0].arming = "";
        reqs[1].arming = "";

        ProveSettlement.Reason[] memory reasons = _dryRun(reqs);

        _assertReason(reasons[0], ProveSettlement.Reason.EscrowShort, "no allowance");
        _assertReason(reasons[1], ProveSettlement.Reason.EscrowShort, "no reservation");
    }

    /**
     * @notice A fee-on-transfer token reports `EscrowShort` on a redemption that worked.
     *
     * This is the case a view function cannot reach. The authorization is valid, the token
     * accepts it, and the escrow is still short — because the token kept a cut of the transfer.
     * A leg that cannot be armed keeps the reason it already had, so nothing new is invented for
     * it and no client has to learn a new number.
     */
    function test_AFeeOnTransferRedemptionReportsEscrowShort() public {
        TaxedERC3009 taxed = new TaxedERC3009();
        taxed.mint(gaslessMaker, SIZE);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _gaslessLeg(MockERC3009(address(taxed)));
        reqs[1] = _approvalLeg(SIZE);

        ProveSettlement.Reason[] memory reasons = _dryRun(reqs);

        _assertReason(reasons[0], ProveSettlement.Reason.EscrowShort, "the token kept a cut");
        _assertOk(reasons[1], "and the leg beside it is untouched by that");
    }

    /// @notice A reason storage already knew, reported beside one only the walk could learn.
    function test_ADeadLegKeepsItsOwnReason() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _approvalLeg(SIZE);
        reqs[1] = _permitLeg();

        vm.prank(approvalMaker);
        settlement.cancel(reqs[0].intent);

        ProveSettlement.Reason[] memory reasons = _dryRun(reqs);

        _assertReason(reasons[0], ProveSettlement.Reason.Cancelled, "the maker called it off");
        _assertOk(reasons[1], "and the walk carried on to the next leg");
    }

    /// @notice `maxFeeRate` is part of the question. A leg that asks for more than this caller
    ///         will pay is a leg the batch steps over, so the walk has to say so.
    function test_AFeeAboveTheCallersBoundReportsFeeTooHigh() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _approvalLeg(SIZE);
        reqs[0].intent.feeConfig = feeCfg(address(0xFEE));
        reqs[0].intent.feeRate = 1e16;
        reqs[0].signature = _sign(reqs[0].intent, approvalKey);

        ProveSettlement.Reason[] memory reasons = _dryRunAt(reqs, 1e15);

        _assertReason(reasons[0], ProveSettlement.Reason.FeeTooHigh_, "above the bound");
    }

    // ── What the walk leaves behind ──────────────────────────────────────────

    /**
     * @notice Nothing. This is the test the whole design rests on.
     *
     * The walk spends a maker's 3009 nonce, moves their tokens into the escrow, books the fill
     * and releases the tokens to the caller — all of it for real, because predicting any of them
     * is the guess this function exists to replace. Then it reverts, and every one of them
     * unwinds. A `dryRun` that left one behind would be a way for anybody to burn a maker's
     * signature for free.
     */
    function test_TheWalkLeavesNoStateBehind() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = _gaslessLeg(tokenB);
        reqs[1] = _approvalLeg(SIZE);
        bytes32 gasless = settlement.hashIntent(reqs[0].intent);
        bytes32 approval = settlement.hashIntent(reqs[1].intent);

        ProveSettlement.Reason[] memory reasons = _dryRun(reqs);
        _assertOk(reasons[0], "the redemption ran");
        _assertOk(reasons[1], "and so did the release");

        assertFalse(tokenB.authorizationState(gaslessMaker, gasless), "the nonce is unspent");
        assertEq(tokenB.balanceOf(gaslessMaker), SIZE, "the maker's tokens never moved");
        assertEq(tokenA.balanceOf(approvalMaker), SIZE, "nor the other maker's");
        assertEq(settlement.reserved(gasless), 0, "nothing is stranded in escrow");
        assertEq(settlement.totalReserved(address(tokenB)), 0, "and the book agrees");
        assertEq(settlement.filled(gasless), 0, "nothing was booked");
        assertEq(settlement.filled(approval), 0);
        assertEq(tokenA.balanceOf(address(exec)), 0, "and the caller was handed nothing");
        assertEq(tokenB.balanceOf(address(exec)), 0);

        // The assertion that says the most: the same two signatures still settle afterwards.
        tokenA.mint(address(exec), SIZE);
        tokenB.mint(address(exec), SIZE);
        exec.approveMax(address(tokenA), relayer);
        exec.approveMax(address(tokenB), relayer);
        vm.prank(address(exec));
        assertEq(settlement.fillBatch(reqs, false, ANY_FEE), 2, "both legs fill for real");
    }

    /// @notice Broadcast as a transaction it is inert: the sender pays gas and changes nothing.
    ///         That is why it needs no access control.
    function test_ItRevertsEvenWhenEveryLegIsFine() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = _approvalLeg(SIZE);

        vm.prank(address(exec));
        vm.expectRevert();
        settlement.dryRun(reqs, ANY_FEE);
    }

    /// @notice An empty batch is an empty answer, not a revert with no data.
    function test_AnEmptyBatchReportsAnEmptyList() public {
        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](0);
        assertEq(_dryRun(reqs).length, 0, "no legs, no reasons");
    }

    // ── Calling it ───────────────────────────────────────────────────────────

    function _dryRun(ProveSettlement.FillRequest[] memory reqs)
        internal
        returns (ProveSettlement.Reason[] memory)
    {
        return _dryRunAt(reqs, ANY_FEE);
    }

    /// @dev The whole client side of this function: call it, expect the revert, and read the
    ///      reasons out of the revert data.
    function _dryRunAt(ProveSettlement.FillRequest[] memory reqs, uint256 maxFeeRate)
        internal
        returns (ProveSettlement.Reason[] memory)
    {
        vm.prank(address(exec));
        (bool ok, bytes memory data) =
            address(settlement).call(abi.encodeCall(ProveSettlement.dryRun, (reqs, maxFeeRate)));

        assertFalse(ok, "dryRun must never return");
        assertEq(bytes4(data), ProveSettlement.DryRun.selector, "and it carries the reasons");

        bytes memory body = new bytes(data.length - 4);
        for (uint256 k = 0; k < body.length; k++) {
            body[k] = data[k + 4];
        }
        return abi.decode(body, (ProveSettlement.Reason[]));
    }

    function _assertOk(ProveSettlement.Reason r, string memory why) internal pure {
        _assertReason(r, ProveSettlement.Reason.Ok, why);
    }

    function _assertReason(
        ProveSettlement.Reason got,
        ProveSettlement.Reason want,
        string memory why
    ) internal pure {
        assertEq(uint256(got), uint256(want), why);
    }

    // ── Building the legs ────────────────────────────────────────────────────

    function _intent(address maker, address tokenIn, address tokenOut, uint8 flags)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i.maker = maker;
        i.recipient = maker;
        i.tokenIn = tokenIn;
        i.tokenOut = tokenOut;
        i.amountIn = SIZE;
        // Flat, and one for one, so nothing here turns on the decay curve.
        i.minOutStart = SIZE;
        i.minOutEnd = SIZE;
        i.startTime = uint64(block.timestamp);
        // Half an hour: open now, shut soon. Nothing on chain requires it to be short.
        i.endTime = uint64(block.timestamp + 30 minutes);
        i.feeConfig = bytes32(0);
        i.feeRateProceeds = 0;
        i.flags = flags;
        i.nonce = uint256(uint160(maker));
    }

    function _sign(ProveSettlement.Intent memory i, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /// @dev The rung that needs no arming: the maker granted the allowance themselves. Partial,
    ///      so one intent can be walked in halves.
    function _approvalLeg(uint256 take)
        internal
        view
        returns (ProveSettlement.FillRequest memory req)
    {
        req.intent = _intent(approvalMaker, address(tokenA), address(tokenB), 1);
        // A nonce per size, so two of these are two intents unless a test says otherwise.
        req.intent.nonce = uint256(uint160(approvalMaker)) + take;
        req.signature = _sign(req.intent, approvalKey);
        req.take = take;
    }

    function _permitLeg() internal view returns (ProveSettlement.FillRequest memory req) {
        req.intent = _intent(permitMaker, address(tokenA), address(tokenB), 0);
        req.signature = _sign(req.intent, permitKey);
        req.take = SIZE;

        ProveSettlement.Permit memory p;
        p.value = SIZE;
        p.deadline = block.timestamp + 1 days;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                tokenA.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        tokenA.PERMIT_TYPEHASH(),
                        permitMaker,
                        relayer,
                        p.value,
                        tokenA.nonces(permitMaker),
                        p.deadline
                    )
                )
            )
        );
        (p.v, p.r, p.s) = vm.sign(permitKey, digest);
        req.arming = abi.encode(p);
    }

    function _gaslessLeg(MockERC3009 token)
        internal
        view
        returns (ProveSettlement.FillRequest memory req)
    {
        req.intent =
            _intent(gaslessMaker, address(token), address(tokenA), settlement.FLAG_ESCROW());
        req.signature = _sign(req.intent, gaslessKey);
        req.take = SIZE;

        ProveSettlement.Authorization memory a;
        a.validAfter = 0;
        a.validBefore = block.timestamp + 1 days;
        // The authorization names the intent it funds, so it arms that one and nothing else.
        a.nonce = settlement.hashIntent(req.intent);
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                token.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                        gaslessMaker,
                        address(settlement),
                        SIZE,
                        a.validAfter,
                        a.validBefore,
                        a.nonce
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 sv) = vm.sign(gaslessKey, digest);
        a.signature = abi.encodePacked(r, sv, v);
        req.arming = abi.encode(a);
    }
}

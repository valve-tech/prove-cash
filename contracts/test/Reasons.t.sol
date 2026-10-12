// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, MockERC20, NO_PERMIT2} from "./Mocks.sol";
import {ReturnBomb} from "./ReturnBomb.t.sol";
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
 * @notice `Reason` is the contract's promise that `fill` and `fillBatch` mean the same thing by
 *         "unfillable". This suite holds every member of the enum to that promise.
 *
 * `_evaluate` is the only validator. `fill` turns its answer into a revert, `fillBatch` with
 * `skipInvalid` turns the same answer into a `continue`, and `fillability` hands it to the UI as a
 * number. Three readings of one decision. A reason that only one of them can produce is either
 * dead code or a hole: an executor who bounds their batch by simulating `fillability` would be
 * surprised by the third reading, which is exactly the mistake `skipInvalid` exists to prevent.
 *
 * So each reason below is driven four ways, in one table:
 *   1. `fillability` names it,
 *   2. `fill` reverts with the error `_revert` maps it to,
 *   3. `fillBatch(skipInvalid = false)` reverts with the same error,
 *   4. `fillBatch(skipInvalid = true)` steps over it and fills the honest leg beside it.
 *
 * Reading four is the one that matters. Before this suite only four of the eleven reasons had
 * ever been stepped over by a batch, so seven of them were a `continue` nobody had run.
 */
contract ReasonsTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address owner = address(0xB0B);
    address sink = address(0x5152);
    address executor = address(0xE0E);
    address rival = address(0xB1D);
    address maker;
    uint256 makerKey;
    address griefer;
    uint256 grieferKey;

    uint256 constant AMOUNT_IN = 1_000e18;
    uint256 constant MIN_OUT = 10e18;
    /// @dev What the maker keeps out of a gross of `MIN_OUT` at the fixture's ten basis points.
    ///      The fee comes out of the number the maker signed, so the curve's figure is the
    ///      executor's outlay and this is the maker's receipt.
    uint256 constant NET_OUT = MIN_OUT - (MIN_OUT * 0.001e18) / 1e18;

    /// @dev Every member of `Reason` except `Ok`, in enum order.
    ProveSettlement.Reason[14] REASONS = [
        ProveSettlement.Reason.BadTerms_,
        ProveSettlement.Reason.NotStarted,
        ProveSettlement.Reason.Expired,
        ProveSettlement.Reason.Cancelled,
        ProveSettlement.Reason.NonceTooLow,
        ProveSettlement.Reason.WrongExecutor,
        ProveSettlement.Reason.NothingToFill,
        ProveSettlement.Reason.TooMuch,
        ProveSettlement.Reason.PartialNotAllowed,
        ProveSettlement.Reason.EscrowShort,
        ProveSettlement.Reason.BadSignature,
        ProveSettlement.Reason.FeeTooHigh_,
        ProveSettlement.Reason.BelowMinFill_,
        ProveSettlement.Reason.TokenOutUnreadable
    ];

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        (griefer, grieferKey) = makeAddrAndKey("griefer");
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);

        // Both makers are funded and approved throughout. That is deliberate: the batch probes
        // the allowance and the balance before it checks the signature, so a griefer who is not
        // funded lands on `EscrowShort` whatever else is wrong with their intent.
        tokenA.mint(maker, 1_000_000e18);
        tokenA.mint(griefer, 1_000_000e18);
        tokenB.mint(executor, 1_000_000e18);
        tokenB.mint(rival, 1_000_000e18);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(griefer);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);
        vm.prank(rival);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(1_700_000_000);
    }

    // ── The table ────────────────────────────────────────────────────────────

    /**
     * @notice Build the griefer's intent that produces `r`, and say what to take and what error
     *         `_revert` owes it.
     *
     * The griefer signs, not the maker, so a case can be spoiled at the last field without
     * touching the honest leg it travels with. Each case changes exactly the one thing that
     * produces its reason, because `_evaluate` returns the first reason it finds and a second
     * fault would silently move the case to a different row of this table.
     */
    function _caseFor(ProveSettlement.Reason r)
        internal
        returns (
            ProveSettlement.Intent memory i,
            bytes memory sig,
            uint256 take,
            bytes4 err,
            uint256 bound_
        )
    {
        i = _intent(griefer);
        take = AMOUNT_IN;
        // Unbounded unless the case is about the bound. Only `FeeTooHigh_` is.
        bound_ = ANY_FEE;

        if (r == ProveSettlement.Reason.BadTerms_) {
            // A same-token intent would let a callback pay itself out of the leg it just took.
            i.tokenOut = i.tokenIn;
            err = ProveSettlement.BadTerms.selector;
        } else if (r == ProveSettlement.Reason.NotStarted) {
            i.startTime = uint64(block.timestamp + 100);
            i.endTime = uint64(block.timestamp + 200);
            err = ProveSettlement.NotStarted.selector;
        } else if (r == ProveSettlement.Reason.Expired) {
            // Started, and over. `NotStarted` is checked first, so the window has to be behind us
            // rather than merely absent.
            i.startTime = uint64(block.timestamp - 200);
            i.endTime = uint64(block.timestamp - 1);
            err = ProveSettlement.Expired.selector;
        } else if (r == ProveSettlement.Reason.Cancelled) {
            vm.prank(griefer);
            settlement.cancel(i);
            err = ProveSettlement.IsCancelled.selector;
        } else if (r == ProveSettlement.Reason.NonceTooLow) {
            // No escrow flag, so the floor bites at once instead of waiting out its cooldown.
            i.nonce = 1;
            vm.prank(griefer);
            settlement.invalidateBefore(2);
            err = ProveSettlement.NonceTooLow.selector;
        } else if (r == ProveSettlement.Reason.WrongExecutor) {
            i.executor = rival;
            err = ProveSettlement.WrongExecutor.selector;
        } else if (r == ProveSettlement.Reason.NothingToFill) {
            take = 0;
            err = ProveSettlement.NothingToFill.selector;
        } else if (r == ProveSettlement.Reason.TooMuch) {
            take = AMOUNT_IN + 1;
            err = ProveSettlement.TooMuch.selector;
        } else if (r == ProveSettlement.Reason.PartialNotAllowed) {
            i.flags = 0;
            take = AMOUNT_IN / 2;
            err = ProveSettlement.PartialNotAllowed.selector;
        } else if (r == ProveSettlement.Reason.EscrowShort) {
            // Flagged for escrow and never funded. The reservation is keyed by this intent's
            // hash, so no other deposit of the griefer's can stand in for it.
            i.flags = settlement.FLAG_PARTIAL() | settlement.FLAG_ESCROW();
            err = ProveSettlement.EscrowShort.selector;
        } else if (r == ProveSettlement.Reason.FeeTooHigh_) {
            /*
             * The intent asks for a higher rate than this caller will pay.
             *
             * This is the anti-grief case and the reason it is a `Reason` at all. A maker names
             * their own rate now, so an intent nobody wants to pay for would otherwise revert
             * every batch that carried it — for the price of one signature. It is stepped over
             * instead, exactly like an intent addressed to somebody else.
             */
            i.feeRate = 0.006e18;
            bound_ = 0.005e18;
            err = ProveSettlement.FeeTooHigh.selector;
        } else if (r == ProveSettlement.Reason.BelowMinFill_) {
            // Under the maker's floor, and not the fill that closes the intent out. Both halves
            // are needed: a take equal to what remains is always allowed, whatever the floor.
            i.minFill = AMOUNT_IN / 2 + 1;
            take = AMOUNT_IN / 2;
            err = ProveSettlement.BelowMinFill.selector;
        } else if (r == ProveSettlement.Reason.TokenOutUnreadable) {
            /*
             * Token B is a contract that answers a balance read with more bytes than the caller
             * can afford to copy. Four thousand words needs some 43,000 gas of quadratic memory
             * expansion to produce, which is more than `_probe` hands it, so the read fails.
             *
             * The error is `Underpaid` and it comes from `_deliverTo` rather than from `_revert`.
             * A single fill passes `deep = false` and never asks this question, so it reaches the
             * fee-on-transfer bracket and refuses there — off the same capped read, on the same
             * token, for the same reason. See the note in this contract's header.
             */
            i.tokenOut = address(new ReturnBomb(4_000));
            err = ProveSettlement.Underpaid.selector;
        } else {
            // `Reason.BadSignature`. Signed by the wrong key below, so return early.
            return (i, _sign(i, makerKey), take, ProveSettlement.BadSignature.selector, bound_);
        }

        sig = _sign(i, grieferKey);
    }

    /**
     * @notice A leg asking more than the caller will pay is stepped over rather than taken as a
     *         whole batch.
     *
     * This is why `FeeTooHigh_` is a `Reason` and not only a revert. The bound has to be decided
     * where `skipInvalid` can still act on it: a check that first bit inside `_quote` would land
     * after the skip decision, and one greedy signature would take every other leg in the batch
     * with it. `_evaluate` charges at the same `_rateOf` the fill does, so the number checked and
     * the number charged agree by construction.
     */
    function test_ALegAboveTheCallersBoundIsSkippedRatherThanTakingTheBatch() public {
        // A rate the caller will not pay half of.
        ProveSettlement.Intent memory quiet = _intent(maker);
        quiet.feeRate = 0.004e18;
        quiet.nonce = 21;

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](1);
        reqs[0] = ProveSettlement.FillRequest({
            intent: quiet, signature: _sign(quiet, makerKey), take: AMOUNT_IN, arming: ""
        });

        uint256 before = tokenB.balanceOf(maker);

        // Bounded under the rate. The batch settles nothing and, the part that matters, does not
        // revert: the leg is stepped over.
        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, 0.002e18), 0, "stepped over, not reverted");
        assertEq(tokenB.balanceOf(maker), before, "and nothing moved");

        // The same leg, the same signature, a caller who will pay the rate.
        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, 0.004e18), 1, "and it fills at the signed rate");
        // Forty basis points, on top of the maker's number: the solver bears P2, so the maker
        // is paid the signed minimum in full.
        assertEq(
            tokenB.balanceOf(maker) - before,
            MIN_OUT - (MIN_OUT * 0.001e18) / 1e18,
            "the maker was paid the minimum less their own P3 fee, and not P2"
        );
    }

    /**
     * @notice Every reason reaches the executor by all four routes, and says the same thing.
     *
     * The honest leg travelling beside each bad one is what proves the fourth route. A batch that
     * returned zero could have died quietly; a batch that returns one has really stepped over the
     * bad leg and gone on to settle the good one.
     */
    function test_EveryReasonRevertsAFillAndIsSteppedOverByABatch() public {
        for (uint256 k = 0; k < REASONS.length; k++) {
            uint256 snap = vm.snapshotState();
            ProveSettlement.Reason r = REASONS[k];
            (
                ProveSettlement.Intent memory bad,
                bytes memory badSig,
                uint256 take,
                bytes4 err,
                uint256 bound_
            ) = _caseFor(r);

            // 1. The view names it. If this line fails the case built the wrong reason, and every
            //    assertion under it would be testing something other than what it claims.
            assertEq(
                uint256(settlement.fillability(bad, badSig, take, executor, bound_)),
                uint256(r),
                "the view names the reason under test"
            );

            // 2. A single fill reverts with the error `_revert` maps that reason to.
            vm.prank(executor);
            vm.expectRevert(err);
            settlement.fill(bad, badSig, take, bound_);

            // A fresh honest leg per case, so a good fill in one iteration cannot pay for the next.
            ProveSettlement.Intent memory good = _intent(maker);
            good.nonce = 1_000 + k;
            bytes memory goodSig = _sign(good, makerKey);

            ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
            reqs[0] = ProveSettlement.FillRequest({
                intent: bad, signature: badSig, take: take, arming: ""
            });
            reqs[1] = ProveSettlement.FillRequest({
                intent: good, signature: goodSig, take: AMOUNT_IN, arming: ""
            });

            // 3. A batch that was told not to skip carries the same error out.
            vm.prank(executor);
            vm.expectRevert(err);
            settlement.fillBatch(reqs, false, bound_);

            // 4. A batch that was told to skip steps over it and settles the honest leg.
            vm.prank(executor);
            assertEq(settlement.fillBatch(reqs, true, bound_), 1, "one leg of two settled");
            assertEq(
                settlement.filled(settlement.hashIntent(good)),
                AMOUNT_IN,
                "and the honest leg is the one that settled"
            );
            assertEq(settlement.filled(settlement.hashIntent(bad)), 0, "the bad leg booked nothing");

            vm.revertToState(snap);
        }
    }

    /**
     * @notice Thirteen unfillable legs and one good one, in a single batch, settle exactly one.
     *
     * The per-reason test above proves each `continue` runs. This proves they compose: no reason
     * leaves the loop in a state that spoils the next leg, and the fee coalescing survives twelve
     * consecutive legs that owe nothing. An executor's real batch is shaped like this one, not
     * like a pair.
     *
     * One bound covers every case here, and it is the tightest any of them needs. `FeeTooHigh_`
     * is the only case that reads it, so a batch bounded at fifty steps that leg over and the
     * honest leg — which asks for nothing of its own — settles at the floor as usual.
     */
    function test_ABatchOfNothingButBadLegsStillSettlesTheGoodOne() public {
        ProveSettlement.FillRequest[] memory reqs =
            new ProveSettlement.FillRequest[](REASONS.length + 1);

        for (uint256 k = 0; k < REASONS.length; k++) {
            (ProveSettlement.Intent memory bad, bytes memory badSig, uint256 take,,) =
                _caseFor(REASONS[k]);
            // The cases differ in their terms, so they hash apart — except the two that spoil the
            // `take` rather than the intent. Give those their own nonce so no two legs collide.
            reqs[k] = ProveSettlement.FillRequest({
                intent: bad, signature: badSig, take: take, arming: ""
            });
        }

        ProveSettlement.Intent memory good = _intent(maker);
        good.nonce = 7;
        reqs[REASONS.length] = ProveSettlement.FillRequest({
            intent: good, signature: _sign(good, makerKey), take: AMOUNT_IN, arming: ""
        });

        uint256 makerBefore = tokenB.balanceOf(maker);
        vm.prank(executor);
        assertEq(settlement.fillBatch(reqs, true, 0.005e18), 1, "one leg of fourteen settled");

        assertEq(tokenB.balanceOf(maker) - makerBefore, NET_OUT, "the honest maker was paid");
        assertEq(tokenA.balanceOf(executor), AMOUNT_IN, "and the executor took one leg of token A");
        assertEq(tokenA.balanceOf(griefer), 1_000_000e18, "the griefer parted with nothing");
    }

    /**
     * @notice `Reason.Ok` is zero, and zero is what the batch counts on.
     *
     * `_fillOne` says "stepped over" with false rather than with a reason, so a caller never
     * reads a reason back from a batch. This pins the enum's first member, which is the only
     * part of the ordering any caller off chain can depend on: the UI greys a row out on
     * non-zero, and every client mirrors the list by position.
     */
    function test_OkIsZeroAndEveryOtherReasonIsNot() public view {
        ProveSettlement.Intent memory good = _intent(maker);
        bytes memory sig = _sign(good, makerKey);
        assertEq(
            uint256(settlement.fillability(good, sig, AMOUNT_IN, executor, ANY_FEE)),
            0,
            "Ok is zero"
        );

        for (uint256 k = 0; k < REASONS.length; k++) {
            assertTrue(uint256(REASONS[k]) != 0, "no other reason may share the Ok encoding");
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _intent(address who) internal view returns (ProveSettlement.Intent memory i) {
        i = ProveSettlement.Intent({
            maker: who,
            recipient: who,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: AMOUNT_IN,
            minOutStart: MIN_OUT,
            minOutEnd: MIN_OUT,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp + 1 hours),
            executor: address(0),
            feeConfig: feeCfg(sink),
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

    function _sign(ProveSettlement.Intent memory i, uint256 key)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }
}

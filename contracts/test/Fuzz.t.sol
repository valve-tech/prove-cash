// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test} from "forge-std/Test.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";
import {ANY_FEE, MockERC20, NO_PERMIT2} from "./Mocks.sol";
import {
    proceedsRate,
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
 * @notice Properties of a single intent, checked over the whole input space rather than at the
 *         handful of points a unit test picks. These are the statements the maker is relying on
 *         when they sign, so none of them may hold "usually".
 */
contract FuzzTest is Test {
    ProveSettlement settlement;
    /// @dev The address makers approve. Read once: `vm.prank` is single-shot and a call to
    ///      `settlement.relayer()` inside a pranked line eats the prank.
    address relayer;
    MockERC20 tokenA;
    MockERC20 tokenB;

    address sink = address(0x5152);
    address executor = address(0xE0E);
    address maker;
    uint256 makerKey;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");
        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();
        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);

        tokenA.mint(maker, type(uint128).max);
        tokenB.mint(executor, type(uint128).max);
        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);
        vm.warp(1_700_000_000);
    }

    function _intent(uint256 amountIn, uint256 minOutStart, uint256 minOutEnd, uint64 duration)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: amountIn,
            minOutStart: minOutStart,
            minOutEnd: minOutEnd,
            startTime: uint64(block.timestamp),
            endTime: uint64(block.timestamp) + duration,
            executor: address(0),
            feeConfig: feeCfg(sink),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0.001e18,
            minFill: 0,
            authNonce: bytes32(0),
            flags: settlement.FLAG_PARTIAL(),
            nonce: 7,
            curve: bytes32(0)
        });
    }

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    // ── The price curve ──────────────────────────────────────────────────────

    /// @notice A dutch price only ever falls, and never below the floor the maker signed.
    function testFuzz_DecayIsMonotonicAndBounded(
        uint128 startRate,
        uint128 endRate,
        uint32 duration,
        uint32 t1,
        uint32 t2
    ) public view {
        uint256 hi = bound(startRate, 1, type(uint128).max);
        uint256 lo = bound(endRate, 0, hi);
        uint64 span = uint64(bound(duration, 1, 365 days));

        ProveSettlement.Intent memory i = _intent(1e24, hi, lo, span);
        uint256 a = i.startTime + bound(t1, 0, span);
        uint256 b = i.startTime + bound(t2, 0, span);
        if (a > b) (a, b) = (b, a);

        uint256 rateA = settlement.minOutAt(i, a);
        uint256 rateB = settlement.minOutAt(i, b);

        assertGe(rateA, rateB, "the price never rises");
        assertLe(rateA, hi, "never above the start");
        assertGe(rateB, lo, "never below the floor");
    }

    /// @notice Whatever the split, the gross the executor pays is at least the signed rate on
    ///         every wei taken, and the fee is the rate on that gross and nothing else.
    function testFuzz_QuoteNeverShortChangesTheMaker(uint128 amountIn, uint128 minOut, uint128 take)
        public
        view
    {
        uint256 total = bound(amountIn, 1, type(uint128).max);
        uint256 rate = bound(minOut, 0, type(uint128).max);
        uint256 part = bound(take, 1, total);

        ProveSettlement.Intent memory i = _intent(total, rate, rate, 1 hours);
        TakePoints.Quote memory q_fee = settlement.quote(i, part, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        uint256 gross = delivered + fee;

        assertGe(gross * total, part * rate, "rounding favours the maker");

        // The fee rounds down now, so a fill small enough at a rate small enough charges nothing
        // and the maker keeps the dust. What must always hold is that the fee is the rate on the
        // gross, that the two halves add back to it, and that nothing is charged on nothing.
        assertEq(
            fee, (gross * proceedsRate(settlement, i)) / settlement.WAD(), "the rate on the gross"
        );
        assertEq(delivered, gross - fee, "and the maker keeps the remainder");
        if (gross == 0) assertEq(fee, 0, "no proceeds, no fee");
    }

    /**
     * @notice The split totals to the gross at every rate the terms admit, and the executor's
     *         outlay does not depend on the rate at all.
     *
     * That independence is the whole claim of the change, so it is asserted directly rather than
     * inferred: the same leg quoted at a fuzzed rate and at zero costs the executor the same
     * number. Everything the rate decides is how that number divides.
     */
    function testFuzz_TheSplitTotalsToTheGrossAtEveryRate(
        uint128 amountIn,
        uint128 minOut,
        uint128 take,
        uint64 rawRate,
        uint32 skip
    ) public view {
        uint256 total = bound(amountIn, 1, type(uint128).max);
        uint256 start = bound(minOut, 0, type(uint128).max);
        uint256 part = bound(take, 1, total);
        uint64 rate = uint64(bound(rawRate, 0, settlement.WAD()));

        ProveSettlement.Intent memory i = _intent(total, start, start / 2, 1 hours);
        i.feeRateProceeds = rate;
        uint256 at = uint256(i.startTime) + bound(skip, 0, 3600);

        TakePoints.Quote memory q_fee = settlement.quote(i, part, at);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        uint256 curve = settlement.minOutAt(i, at);
        uint256 gross = (part * curve + total - 1) / total;

        assertEq(delivered + fee, gross, "the two halves are the curve's own number, exactly");
        assertEq(fee, (gross * rate) / settlement.WAD(), "and the fee is the rate on it, floored");
        assertLe(fee, gross, "so the subtraction can never underflow");

        i.feeRateProceeds = 0;
        TakePoints.Quote memory q_noFee = settlement.quote(i, part, at);
        uint256 free = q_noFee.delivered;
        uint256 noFee = q_noFee.feeProceeds;
        assertEq(noFee, 0, "no rate signed, no fee charged");
        assertEq(free, gross, "and the outlay is the same number the fuzzed rate cost");
    }

    /**
     * @notice The rounding at both ends of the rate. One wei of rate charges nothing below a
     *         whole `WAD` of gross; a rate of `WAD` takes all of it and pays the maker nothing.
     *
     * These are the two edges the floor division creates, and `_termsOk` refuses everything above
     * the second one. Below it the maker can always be paid and the subtraction always holds.
     */
    function testFuzz_TheFeeRoundsDownAtBothExtremes(uint128 minOut, uint128 take) public view {
        uint256 total = 1e24;
        uint256 start = bound(minOut, 1, type(uint128).max);
        uint256 part = bound(take, 1, total);

        ProveSettlement.Intent memory i = _intent(total, start, start, 1 hours);

        i.feeRateProceeds = 1;
        TakePoints.Quote memory q_fee = settlement.quote(i, part, block.timestamp);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        uint256 gross = delivered + fee;
        if (gross < settlement.WAD()) {
            assertEq(fee, 0, "one wei of rate rounds away below a whole unit of gross");
            assertEq(delivered, gross, "and the maker keeps every wei");
        }
        assertLe(fee, gross, "the fee never exceeds the gross");

        i.feeRateProceeds = uint64(settlement.WAD());
        TakePoints.Quote memory q_5 = settlement.quote(i, part, block.timestamp);
        delivered = q_5.delivered;
        fee = q_5.feeProceeds;
        assertEq(fee, gross, "a rate of one takes the whole gross");
        assertEq(delivered, 0, "and the maker receives nothing");
        assertLe(fee, gross, "which is still the bound, at the edge of it");
    }

    /// @notice Splitting an intent into two fills never pays the maker less than one fill would,
    ///         so an executor cannot shave the maker by choosing the split.
    function testFuzz_SplittingAFillNeverPaysTheMakerLess(
        uint128 amountIn,
        uint128 minOut,
        uint128 cut
    ) public {
        uint256 total = bound(amountIn, 2, 1e30);
        uint256 rate = bound(minOut, 1, 1e30);
        uint256 first = bound(cut, 1, total - 1);

        ProveSettlement.Intent memory i = _intent(total, rate, rate, 1 hours);
        bytes memory sig = _sign(i);

        uint256 before = tokenB.balanceOf(maker);
        vm.startPrank(executor);
        settlement.fill(i, sig, first, ANY_FEE);
        settlement.fill(i, sig, total - first, ANY_FEE);
        vm.stopPrank();

        // The maker's own half of the whole signed minimum. Splitting can only raise it: the fee
        // floors on each piece, so two pieces round away at least as much as one does.
        uint256 whole = rate - (rate * proceedsRate(settlement, i)) / settlement.WAD();
        assertGe(tokenB.balanceOf(maker) - before, whole, "two fills pay the whole signed minimum");
        assertEq(settlement.filled(settlement.hashIntent(i)), total, "and consume the intent");
    }

    // ── Signatures ───────────────────────────────────────────────────────────

    /// @notice Random bytes are never a valid signature, whatever their shape.
    function testFuzz_GarbageNeverPassesAsASignature(bytes calldata garbage, uint8 v) public {
        ProveSettlement.Intent memory i = _intent(1e21, 1e18, 1e18, 1 hours);
        bytes memory sig = garbage.length >= 64
            ? abi.encodePacked(bytes32(garbage[0:32]), bytes32(garbage[32:64]), v)
            : garbage;

        vm.prank(executor);
        vm.expectRevert();
        settlement.fill(i, sig, 1e21, ANY_FEE);
    }

    /// @notice Changing any signed field invalidates the signature.
    function testFuzz_TamperingWithTheTermsBreaksTheSignature(uint8 field, uint128 value) public {
        ProveSettlement.Intent memory i = _intent(1e21, 1e18, 1e18, 1 hours);
        bytes memory sig = _sign(i);

        // Every branch forces a value different from the signed one, so a "tamper" is always
        // really a tamper and a pass can never be an accidental no-op.
        uint256 v = bound(value, 1, type(uint128).max - 1);
        uint8 which = uint8(bound(field, 0, 5));
        if (which == 0) {
            i.amountIn = v == i.amountIn ? v + 1 : v;
        } else if (which == 1) {
            i.minOutStart = v == i.minOutStart ? v + 1 : v;
        } else if (which == 2) {
            i.minOutEnd = v == i.minOutEnd ? v + 1 : v;
        } else if (which == 3) {
            i.recipient = address(uint160(v == uint160(maker) ? v + 1 : v));
        } else if (which == 4) {
            i.nonce = v == i.nonce ? v + 1 : v;
        } else {
            uint8 flipped = uint8(v % 4);
            i.flags = flipped == i.flags ? (flipped + 1) % 4 : flipped;
        }

        vm.prank(executor);
        vm.expectRevert();
        settlement.fill(i, sig, 1, ANY_FEE);
    }

    // ── The minimum fill ─────────────────────────────────────────────────────

    /// @dev The five floors worth signing. Zero is what every intent carried before the field
    ///      existed; one is the smallest floor that is not none; a third of the lot is the
    ///      ordinary case and the one that leaves a remainder under its own floor; the lot and
    ///      one more than the lot both turn a partial intent into an all-or-nothing one through
    ///      `take == remaining` rather than through the flag.
    function _floorFor(uint8 shape, uint256 total) internal pure returns (uint256) {
        uint256 pick = shape % 5;
        if (pick == 0) return 0;
        if (pick == 1) return 1;
        if (pick == 2) return total / 3;
        if (pick == 3) return total;
        return total + 1;
    }

    /**
     * @notice A fill is refused exactly when it is under the floor and does not close the intent
     *         out. Every floor, every take.
     *
     * The rule is one line — `take >= minFill || take == remaining` — and a unit test can only
     * show it at the points it picks. The interesting half is the second clause, and the
     * interesting floors are the two at and above `amountIn`, where every partial take is
     * refused and the only legal fill is the whole lot.
     */
    function testFuzz_AFillIsRefusedExactlyWhenItIsUnderAnOpenFloor(uint8 shape, uint128 takeSeed)
        public
    {
        uint256 total = 1_000e18;
        uint256 floor = _floorFor(shape, total);

        ProveSettlement.Intent memory i = _intent(total, total, total, 1 hours);
        i.minFill = floor;
        i.feeConfig = bytes32(0);
        i.feeRateProceeds = 0;
        bytes memory sig = _sign(i);

        uint256 take = bound(takeSeed, 1, total);
        // Nothing is filled yet, so the whole lot is the remainder and closing it out is legal
        // whatever the floor says.
        bool legal = take >= floor || take == total;

        vm.prank(executor);
        if (!legal) {
            vm.expectRevert(ProveSettlement.BelowMinFill.selector);
            settlement.fill(i, sig, take, ANY_FEE);
            assertEq(settlement.filled(settlement.hashIntent(i)), 0, "and nothing was booked");
            return;
        }
        settlement.fill(i, sig, take, ANY_FEE);
        assertEq(settlement.filled(settlement.hashIntent(i)), take, "the fill stands");
    }

    /**
     * @notice A floor never strands dust. Whatever the floor and whatever the first take, one
     *         more fill closes the intent.
     *
     * This is the whole argument for the second clause. `take >= minFill` alone leaves every
     * floored intent ending in a remainder that is under the floor from one side and the whole
     * of what is left from the other — unreachable from both, with the maker's escrow behind it
     * until they withdraw. The remainder is the case a uniform draw over the take reaches about
     * never, so this asks for it by name.
     */
    function testFuzz_AFloorNeverStrandsDust(uint8 shape, uint128 firstSeed) public {
        uint256 total = 1_000e18;
        uint256 floor = _floorFor(shape, total);

        ProveSettlement.Intent memory i = _intent(total, total, total, 1 hours);
        i.minFill = floor;
        i.feeConfig = bytes32(0);
        i.feeRateProceeds = 0;
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);

        // A floor at or above the lot leaves no legal partial take at all, so there is no first
        // fill and no remainder. The whole lot still goes, which is the offer the maker wrote.
        if (floor >= total) {
            vm.prank(executor);
            settlement.fill(i, sig, total, ANY_FEE);
            assertEq(settlement.filled(h), total, "an all-or-nothing floor still fills whole");
            return;
        }

        uint256 first = bound(firstSeed, floor == 0 ? 1 : floor, total - 1);
        vm.startPrank(executor);
        settlement.fill(i, sig, first, ANY_FEE);
        // Whatever is left, however far under the floor it is.
        settlement.fill(i, sig, total - first, ANY_FEE);
        vm.stopPrank();

        assertEq(settlement.filled(h), total, "no dust was left behind");
        assertEq(tokenA.balanceOf(executor), total, "and the executor took the lot");
    }

    // ── Escrow ───────────────────────────────────────────────────────────────

    /// @notice A reservation is a ledger, not a pot: what a maker puts in is what they take out.
    function testFuzz_EscrowRoundTripsExactly(uint128 depositAmount) public {
        uint256 in_ = bound(depositAmount, 1, type(uint96).max);
        ProveSettlement.Intent memory i = _intent(in_, 1e18, 1e18, 1 hours);
        bytes32 h = settlement.hashIntent(i);

        uint256 before = tokenA.balanceOf(maker);
        vm.startPrank(maker);
        settlement.deposit(i, in_);
        assertEq(settlement.reserved(h), in_);

        settlement.withdraw(i);
        vm.stopPrank();

        assertEq(settlement.reserved(h), 0, "ledger");
        assertEq(tokenA.balanceOf(maker), before, "wallet whole again");
    }

    /**
     * @notice A maker's escrow comes back whenever they ask, and never to anyone else.
     *
     * This used to assert the opposite — that a cooldown held for its whole length. The cooldown
     * protected an executor who commits capital in one transaction and fills in another, and
     * every path here settles in one, so it was charging every maker for a risk an executor can
     * decline. What has to stay true is the half about ownership.
     */
    function testFuzz_EscrowComesBackWheneverTheMakerAsksAndNeverToAnyoneElse(
        uint128 amount,
        uint32 wait,
        address stranger
    ) public {
        vm.assume(stranger != maker);
        uint256 value = bound(amount, 1, type(uint96).max);
        ProveSettlement.Intent memory i = _intent(value, 1e18, 1e18, 1 hours);
        bytes32 h = settlement.hashIntent(i);

        vm.prank(maker);
        settlement.deposit(i, value);
        vm.warp(block.timestamp + bound(wait, 0, 30 days));

        vm.prank(stranger);
        vm.expectRevert(ProveSettlement.BadParameter.selector);
        settlement.withdraw(i);
        assertEq(settlement.reserved(h), value, "a stranger moves nothing");

        vm.prank(maker);
        settlement.withdraw(i);
        assertEq(settlement.reserved(h), 0, "and the maker gets it, at any moment they like");
    }

    // ── Lifecycle ────────────────────────────────────────────────────────────

    /// @notice Outside its window an intent is dead, whichever side of the window you are on.
    function testFuzz_OnlyFillableInsideTheWindow(uint32 offset, bool late) public {
        uint64 duration = 1 hours;
        ProveSettlement.Intent memory i = _intent(1e21, 1e18, 1e18, duration);
        bytes memory sig = _sign(i);
        uint256 start = i.startTime;

        if (late) {
            vm.warp(i.endTime + bound(offset, 0, 365 days));
        } else {
            vm.warp(start - bound(offset, 1, start - 1));
        }

        vm.prank(executor);
        vm.expectRevert();
        settlement.fill(i, sig, 1e21, ANY_FEE);
    }

    /// @notice `invalidateBefore` kills exactly the nonces below the floor and no others.
    function testFuzz_InvalidateBeforeIsExact(uint64 floor, uint64 nonce) public {
        uint256 f = bound(floor, 1, type(uint32).max);
        uint256 n = bound(nonce, 0, type(uint32).max);

        vm.prank(maker);
        settlement.invalidateBefore(f);

        ProveSettlement.Intent memory i = _intent(1e21, 1e18, 1e18, 1 hours);
        i.nonce = n;
        bytes memory sig = _sign(i);

        vm.prank(executor);
        if (n < f) {
            vm.expectRevert(ProveSettlement.NonceTooLow.selector);
            settlement.fill(i, sig, 1e21, ANY_FEE);
        } else {
            settlement.fill(i, sig, 1e21, ANY_FEE);
            // A gross of 1e18 at ten basis points, and the maker keeps the rest.
            assertEq(tokenB.balanceOf(maker), 1e18 - 1e15);
        }
    }
}

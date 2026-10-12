// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {Test, console} from "forge-std/Test.sol";
import {ProveSettlement} from "../src/ProveSettlement.sol";

/**
 * @notice What a curve at an address would cost, against the branch that shipped instead.
 *
 *   forge test --match-path test/CurveCost.t.sol -vv
 *
 * `minOutAt` runs inside `_quote`, so it runs once per quote and once per fill leg. Anything
 * added there is paid by every maker on every leg, so the question was worth a number rather
 * than an estimate. Three shapes are measured against the shipped straight line:
 *
 *   - a staticcall to a curve contract, given only the five pricing values
 *   - a staticcall to a curve contract, given the whole intent
 *   - a branch on the `flags` kind bits, which is what the contract now does
 *
 * The curve contracts do the same linear arithmetic the shipped code does, so each number is the
 * floor: the dispatch and the call, with nothing charged for the curve's own work.
 *
 * **The decision this file informed has been taken.** `Intent.curve` is a signed word, the kind
 * lives in two bits of `flags`, and `_stretchAt` is the one shape built. So the file's job has
 * changed: it no longer weighs an option, it holds the reason the option was refused where a
 * future contributor proposing it again will find it. Read the conclusion at the bottom before
 * proposing a curve registry, an SSTORE2 blob, or a curve contract.
 */

/**
 *  The lean interface: the four signed pricing fields and a timestamp.
 */
interface ILeanCurve {
    function priceAt(uint256 startOut, uint256 endOut, uint64 t0, uint64 t1, uint256 ts)
        external
        view
        returns (uint256);
}

/**
 *  The wide interface: everything the maker signed, which is what a real curve would want.
 */
interface IWideCurve {
    function priceAt(ProveSettlement.Intent calldata i, uint256 ts) external view returns (uint256);
}

contract LeanCurve is ILeanCurve {
    function priceAt(uint256 startOut, uint256 endOut, uint64 t0, uint64 t1, uint256 ts)
        external
        pure
        returns (uint256)
    {
        if (ts <= t0 || endOut == startOut) return startOut;
        if (ts >= t1) return endOut;
        return startOut - ((startOut - endOut) * (ts - t0)) / (uint256(t1) - uint256(t0));
    }
}

contract WideCurve is IWideCurve {
    function priceAt(ProveSettlement.Intent calldata i, uint256 ts)
        external
        pure
        returns (uint256)
    {
        if (ts <= i.startTime || i.minOutEnd == i.minOutStart) {
            return i.minOutStart;
        }
        if (ts >= i.endTime) return i.minOutEnd;
        return i.minOutStart - ((i.minOutStart - i.minOutEnd) * (ts - uint256(i.startTime)))
            / (uint256(i.endTime) - uint256(i.startTime));
    }
}

/**
 * @dev The measurements run inside one call frame so each number is the operation and not the
 *      test harness. Every measured call takes `ts + 1` after a warm-up at `ts`, because the
 *      optimiser folds two calls to the same pure function with the same arguments into one.
 */
/// @dev The kind bits and the one kind that is built, mirroring the settlement's private
///      constants. Bits 1, 2 and 4 are the three custody flags.
uint8 constant FLAG_CURVE_KIND = 24;
uint8 constant KIND_STRETCH = 8;
uint256 constant CURVE_ONE = 65_535;

contract Bench {
    /**
     * @dev Both built-in shapes are `internal`, so via-IR inlines them exactly as it inlines
     *      `minOutAt` into `_quote` today. A `public` helper called internally does not inline the
     *      same way, and measuring one against the other charges the flag branch for the
     *      difference rather than for the branch.
     */
    /// @dev A copy of the shipped `minOutAt`.
    function _linear(ProveSettlement.Intent calldata i, uint256 ts)
        internal
        pure
        returns (uint256)
    {
        if (ts <= i.startTime || i.minOutEnd == i.minOutStart) {
            return i.minOutStart;
        }
        if (ts >= i.endTime) return i.minOutEnd;
        uint256 span = uint256(i.endTime) - uint256(i.startTime);
        return i.minOutStart - ((i.minOutStart - i.minOutEnd) * (ts - uint256(i.startTime))) / span;
    }

    /**
     * @dev The shipped `minOutAt`: the line, or the stretch, chosen by the kind bits.
     *
     * A copy of the contract's own body, because the numbers below have to come from one call
     * frame and an external call is the thing being measured. A copy that drifts mis-measures
     * and nothing worse — `Curve.t.sol` is what holds the real `_stretchAt` to its arithmetic,
     * and this file asserts only orderings that no drift could reverse.
     */
    function _switched(ProveSettlement.Intent calldata i, uint256 ts)
        internal
        pure
        returns (uint256)
    {
        if (ts <= i.startTime || i.minOutEnd == i.minOutStart) return i.minOutStart;
        if (ts >= i.endTime) return i.minOutEnd;
        uint256 span = uint256(i.endTime) - uint256(i.startTime);
        uint256 elapsed = ts - uint256(i.startTime);
        if (i.flags & FLAG_CURVE_KIND != KIND_STRETCH) {
            return i.minOutStart - ((i.minOutStart - i.minOutEnd) * elapsed) / span;
        }
        uint256 startF = uint256(i.curve) >> 240;
        uint256 lenF = (uint256(i.curve) >> 224) & 0xffff;
        if (lenF == 0) lenF = CURVE_ONE - startF;
        uint256 pos = elapsed * CURVE_ONE;
        uint256 begin = startF * span;
        if (pos <= begin) return i.minOutStart;
        uint256 den = lenF * span;
        uint256 num = pos - begin;
        if (num >= den) return i.minOutEnd;
        return i.minOutStart - ((i.minOutStart - i.minOutEnd) * num) / den;
    }

    /// @dev The fuzz test needs the envelope from outside; nothing measured goes through this.
    function linear(ProveSettlement.Intent calldata i, uint256 ts) external pure returns (uint256) {
        return _linear(i, ts);
    }

    /*
     * Each shape is measured in its own call frame. Measuring all five in one frame made the last
     * row pay for the memory the earlier rows had already expanded into, which flattered whatever
     * ran first. Every entry point below warms its own path, then measures it at `ts + 1`.
     */

    function measureInline(ProveSettlement.Intent calldata i, uint256 ts)
        external
        view
        returns (uint256 gas_, uint256 keep)
    {
        keep = _linear(i, ts);
        uint256 g = gasleft();
        keep += _linear(i, ts + 1);
        gas_ = g - gasleft();
    }

    function measureFlag(ProveSettlement.Intent calldata i, uint256 ts)
        external
        view
        returns (uint256 gas_, uint256 keep)
    {
        keep = _switched(i, ts);
        uint256 g = gasleft();
        keep += _switched(i, ts + 1);
        gas_ = g - gasleft();
    }

    function measureLean(ProveSettlement.Intent calldata i, uint256 ts, address curve)
        external
        view
        returns (uint256 gas_, uint256 keep)
    {
        keep = ILeanCurve(curve).priceAt(i.minOutStart, i.minOutEnd, i.startTime, i.endTime, ts);
        uint256 g = gasleft();
        keep += ILeanCurve(curve)
            .priceAt(i.minOutStart, i.minOutEnd, i.startTime, i.endTime, ts + 1);
        gas_ = g - gasleft();
    }

    function measureWide(ProveSettlement.Intent calldata i, uint256 ts, address curve)
        external
        view
        returns (uint256 gas_, uint256 keep)
    {
        keep = IWideCurve(curve).priceAt(i, ts);
        uint256 g = gasleft();
        keep += IWideCurve(curve).priceAt(i, ts + 1);
        gas_ = g - gasleft();
    }

    /// @dev No warm-up. The caller must `vm.cool` the curve first, or this measures a warm call.
    function measureCold(ProveSettlement.Intent calldata i, uint256 ts, address curve)
        external
        view
        returns (uint256 gas_, uint256 keep)
    {
        uint256 g = gasleft();
        keep = ILeanCurve(curve).priceAt(i.minOutStart, i.minOutEnd, i.startTime, i.endTime, ts);
        gas_ = g - gasleft();
    }
}

contract CurveCostTest is Test {
    Bench bench;
    LeanCurve lean;
    WideCurve wide;
    LeanCurve cold;

    function setUp() public {
        bench = new Bench();
        lean = new LeanCurve();
        wide = new WideCurve();
        cold = new LeanCurve();
    }

    function _intent(uint8 flags) internal pure returns (ProveSettlement.Intent memory i) {
        // Flat a quarter, dutch a quarter, flat a half — the shape the field exists to draw. It
        // is read only when `flags` names kind 1, and paid for on the wire either way.
        i = _intent(flags, bytes32(uint256(16_384) << 240 | uint256(16_384) << 224));
    }

    function _intent(uint8 flags, bytes32 curve)
        internal
        pure
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: address(0xA11CE),
            recipient: address(0xA11CE),
            tokenIn: address(0xAAA1),
            tokenOut: address(0xBBB2),
            amountIn: 25_000e18,
            minOutStart: 24_910e6,
            minOutEnd: 24_750e6,
            startTime: 1_000,
            endTime: 1_480,
            executor: address(0),
            feeConfig: bytes32(0),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0,
            minFill: 0,
            authNonce: bytes32(0),
            flags: flags,
            nonce: 1,
            curve: curve
        });
    }

    function test_WhatAPluggableCurveCostsPerEvaluation() public {
        uint256 ts = 1_240;
        ProveSettlement.Intent memory plain = _intent(1);
        ProveSettlement.Intent memory curved = _intent(1 | KIND_STRETCH);

        (uint256 gInline,) = bench.measureInline(plain, ts);
        (uint256 gFlagOff,) = bench.measureFlag(plain, ts);
        (uint256 gFlagOn,) = bench.measureFlag(curved, ts);
        (uint256 gLean,) = bench.measureLean(plain, ts, address(lean));
        (uint256 gWide,) = bench.measureWide(plain, ts, address(wide));

        vm.cool(address(cold));
        (uint256 gCold,) = bench.measureCold(plain, ts, address(cold));

        console.log("shipped, inline linear         ", gInline);
        console.log("staticcall, five values, warm  ", gLean);
        console.log("staticcall, whole intent, warm ", gWide);
        console.log("staticcall, five values, cold  ", gCold);
        console.log("kind branch, line (bits clear) ", gFlagOff);
        console.log("kind branch, stretch (kind 1)  ", gFlagOn);
        console.log("--- premium over the shipped path, per evaluation ---");
        console.log("external, lean, warm           ", gLean - gInline);
        console.log("external, wide, warm           ", gWide - gInline);
        console.log("external, lean, cold           ", gCold - gInline);
        console.log("kind bits, curve unused        ", gFlagOff - gInline);
        console.log("kind bits, stretch walked      ", gFlagOn - gInline);

        // A staticcall can never beat the arithmetic it replaces, however lean the interface.
        assertGt(gLean, gInline, "an external curve costs more than inline");
        assertGt(gWide, gLean, "the whole intent costs more than five values");
        assertGt(gCold, gLean, "a cold curve account costs more than a warm one");

        /*
         * **The conclusion, now that the branch has shipped.**
         *
         * A built-in kind beats a curve at an address on gas, and the margin is real but smaller
         * than it first looked. Against the leanest interface anyone could write — five words in,
         * one out, and the same arithmetic inside — a warm call is roughly a tie with the
         * stretch. The margin only opens up against the *wide* interface, which is the honest
         * comparison, because a curve worth plugging in needs the fields the maker signed. There
         * the branch wins several times over warm, and by more again the first time an intent
         * names a curve nobody has touched.
         *
         * **So do not argue the gas.** A full eight-knot walk was measured at +2,416 gas on
         * `minOutAt`, which is more than a warm wide staticcall costs. The gas case does not
         * survive contact with a shape anybody would actually want.
         *
         * **Argue the invariant.** The maker's payout is a function of time alone. An address in
         * the intent lets a curve read something other than the clock, and the moment the payout
         * depends on market state the solver — who controls the sale, the venue and the block —
         * can move that state and change what they owe. That is the one thing a curve contract
         * can do that a kind cannot, and it is the thing that must not be possible. It also
         * gives up `pure` on `minOutAt` and on `quote`, and needs `_probe`-grade defence against
         * a curve that reverts or loops.
         *
         * Two neighbours of the idea were measured and lose on arithmetic alone, so they need no
         * invariant argument. A registry pays a cold `SSTORE` of 20,000 and a cold `SLOAD` of
         * 2,100 on every first read, against 128 gas of zero-word calldata — the load alone is
         * sixteen times the calldata it saves. Curve bytes deployed as code cost 92,337 to write
         * and 120 warm or 2,620 cold to read, against 320 gas for the densest word anybody could
         * inline: break-even is around 1,280 fills sharing one curve, and against a stretch's
         * four bytes an address costs more before the read even happens.
         *
         * Only ordering is asserted, never a magnitude or a ratio against a fixed number.
         * Coverage instrumentation moves every absolute figure — `Gas.t.sol` asserts nothing at
         * all for the same reason — but it cannot make a call cheaper than the arithmetic it
         * replaces.
         */
        assertLt(gFlagOn, gWide, "the built-in stretch beats a call that sees the intent");
        assertLt(gFlagOn, gCold, "and beats a call to a curve nobody has touched");
        assertLt(gFlagOff, gLean, "an unused kind costs less than the cheapest call");
    }

    /// @dev The clamp that makes an external curve safe: it may ask for more, never less.
    function testFuzz_AClampedCurveCanNeverPayTheMakerBelowTheSignedFloor(
        uint256 answer,
        uint256 ts
    ) public view {
        ProveSettlement.Intent memory i = _intent(1);
        ts = bound(ts, 0, 3_000);

        uint256 envelope = bench.linear(i, ts);
        uint256 clamped =
            answer > i.minOutStart ? i.minOutStart : (answer < i.minOutEnd ? i.minOutEnd : answer);

        assertGe(clamped, i.minOutEnd, "the clamp holds the signed floor");
        assertLe(clamped, i.minOutStart, "the clamp holds the signed ceiling");
        // The envelope itself always sits inside the same bounds, whatever the curve answers.
        assertGe(envelope, i.minOutEnd);
        assertLe(envelope, i.minOutStart);
    }
}

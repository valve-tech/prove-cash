// SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.24;

import {TakePoints} from "../src/TakePoints.sol";
import {Test, console} from "forge-std/Test.sol";
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
    STRAY_DESTINATION
} from "./Fees.sol";

/**
 * @notice `Intent.curve` — the shape the maker draws between the two ends they signed.
 *
 * **The claim these tests pin: the price is still a function of time alone, and the two numbers
 * the maker signed are still the whole envelope.** `minOutStart` is the ceiling, `minOutEnd` is
 * the floor, and the word says where between them the price sits at each moment. Nothing a
 * caller, a venue or a token does reaches the answer, and no word — not one of the 2^256 — takes
 * it outside the envelope or panics on the way.
 *
 * There is no `_termsOk` rule for `curve`, and that absence is the thing under test. The
 * arithmetic in `_stretchAt` is written so that every reachable word is safe, so a guard would
 * be a line spending gas on every fill to refuse nothing. `testFuzz_TheEnvelopeHolds` and
 * `testFuzz_NoWordPanicsThroughQuote` are what stand in its place: delete the argument and they
 * are the tests that notice.
 *
 * Kind 0 reads none of the word, kind 1 reads four bytes, and kinds 2 and 3 are reserved and
 * read nothing. So an unread byte prices identically to a zero byte, which is asserted here
 * rather than assumed — it is the rule that lets a later kind widen its reading without a
 * validation rule appearing at the same time.
 */
contract CurveTest is Test {
    ProveSettlement settlement;
    address relayer;

    MockERC20 tokenA;
    MockERC20 tokenB;

    address maker;
    uint256 makerKey;
    address executor = address(0xE0E);

    /// @dev `FLAG_PARTIAL | KIND_STRETCH`. The kind bits are private to the contract, so the
    ///      number is written out here — and `Fixture.t.sol` is what stops the two drifting,
    ///      because it pins prices a wrong bit cannot reproduce.
    uint8 constant PARTIAL_STRETCH = 1 | 8;
    uint8 constant PARTIAL = 1;

    uint256 constant AMOUNT_IN = 100_000e18;
    uint256 constant HI = 3_000e18;
    uint256 constant LO = 1_500e18;
    uint64 constant T0 = 1_700_000_000;
    uint64 constant SPAN = 3_600;

    /// @dev Full scale for a curve fraction, mirroring `CURVE_ONE`.
    uint256 constant ONE = 65_535;

    function setUp() public {
        (maker, makerKey) = makeAddrAndKey("maker");

        settlement = newSettlement(NO_PERMIT2);
        relayer = settlement.relayer();

        tokenA = new MockERC20("A", "A", 18);
        tokenB = new MockERC20("B", "B", 18);
        tokenA.mint(maker, 10_000_000e18);
        tokenB.mint(executor, 10_000_000e18);

        vm.prank(maker);
        tokenA.approve(relayer, type(uint256).max);
        vm.prank(executor);
        tokenB.approve(relayer, type(uint256).max);

        vm.warp(T0);
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function _intent(uint8 flags, bytes32 curve, uint256 nonce)
        internal
        view
        returns (ProveSettlement.Intent memory i)
    {
        i = ProveSettlement.Intent({
            maker: maker,
            recipient: maker,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            amountIn: AMOUNT_IN,
            minOutStart: HI,
            minOutEnd: LO,
            startTime: T0,
            endTime: T0 + SPAN,
            executor: address(0),
            feeConfig: bytes32(0),
            feeRate: 0,
            feeRateIn: 0,
            feeRateProceeds: 0,
            minFill: 0,
            authNonce: bytes32(0),
            flags: flags,
            nonce: nonce,
            curve: curve
        });
    }

    function _sign(ProveSettlement.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(makerKey, settlement.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    /// @dev A stretch word from its two fractions, which is the whole of the kind-1 encoding.
    function _word(uint16 startF, uint16 lenF) internal pure returns (bytes32) {
        return bytes32((uint256(startF) << 240) | (uint256(lenF) << 224));
    }

    /**
     * @dev The straight line this contract walked before `curve` existed, written out once.
     *
     * Copied rather than called, on purpose. A reference that asks `minOutAt` proves only that a
     * function agrees with itself; this is the expression the shipped code carried, and the
     * fuzz below is what holds the new branch to it.
     */
    function _shippedLine(uint256 hi, uint256 lo, uint64 t0, uint64 t1, uint256 ts)
        internal
        pure
        returns (uint256)
    {
        if (ts <= t0 || lo == hi) return hi;
        if (ts >= t1) return lo;
        return hi - ((hi - lo) * (ts - uint256(t0))) / (uint256(t1) - uint256(t0));
    }

    // ── The zero word is the shipped line ────────────────────────────────────

    /**
     * @notice Kind 1 with a word of zeros prices exactly as the line did, at every instant.
     *
     * Not approximately. `startF` is zero and a `lenF` of zero folds to full scale, so the
     * return is `hi - (range * elapsed * 65535) / (65535 * span)`, and `floor(a*k / b*k)`
     * is `floor(a / b)`. The two expressions are the same number for every input, and that is
     * what makes the field free to a maker who does not use it: the SDK can set the bit, sign a
     * zero word, and change no price it ever quoted.
     */
    function testFuzz_AZeroWordIsTheShippedLine(
        uint128 hi,
        uint128 lo,
        uint64 t0,
        uint32 span,
        uint32 offset
    ) public view {
        lo = uint128(bound(lo, 0, hi));
        span = uint32(bound(span, 1, type(uint32).max));
        t0 = uint64(bound(t0, 0, type(uint64).max - span));
        uint256 ts = uint256(t0) + bound(offset, 0, span);

        ProveSettlement.Intent memory line = _intent(PARTIAL, bytes32(0), 1);
        line.minOutStart = hi;
        line.minOutEnd = lo;
        line.startTime = t0;
        line.endTime = t0 + span;

        ProveSettlement.Intent memory stretched = line;
        stretched.flags = PARTIAL_STRETCH;

        assertEq(
            settlement.minOutAt(stretched, ts),
            _shippedLine(hi, lo, t0, t0 + span, ts),
            "kind 1 with a zero word is the shipped line"
        );
        assertEq(
            settlement.minOutAt(line, ts),
            settlement.minOutAt(stretched, ts),
            "and so the two kinds agree at every instant"
        );
    }

    /**
     * @notice The maker's price still rounds up, whatever the word says.
     *
     * `_stretchAt` floors the subtrahend, so the price it returns is the ceiling of the exact
     * fraction. The direction is the maker's, and it was the maker's before the field existed. A
     * refactor that moved the division inside the subtraction would flip it and cost the maker a
     * wei on every fill that does not divide, which nothing else here would notice.
     */
    function testFuzz_TheRoundingStillFavoursTheMaker(uint16 startF, uint16 lenF, uint32 offset)
        public
        view
    {
        // Inside the window, not on the close: `minOutAt` answers the floor there before it
        // reads a kind, and this is a test of the kind's own arithmetic.
        uint256 ts = T0 + bound(offset, 0, SPAN - 1);
        ProveSettlement.Intent memory i = _intent(PARTIAL_STRETCH, _word(startF, lenF), 1);

        uint256 got = settlement.minOutAt(i, ts);
        // The same arithmetic with the division taken exactly, in a wider unit than the answer.
        uint256 folded = lenF == 0 ? ONE - startF : lenF;
        uint256 pos = (ts - T0) * ONE;
        uint256 begin = uint256(startF) * SPAN;
        uint256 exactScaled; // (hi - got) * den, against (hi - lo) * num
        if (pos <= begin || folded == 0) {
            assertEq(got, HI, "before the fall the price rests at the ceiling");
            return;
        }
        uint256 den = folded * SPAN;
        uint256 num = pos - begin;
        if (num >= den) {
            assertEq(got, LO, "after the fall it rests at the floor");
            return;
        }
        exactScaled = (HI - LO) * num;
        // `got` is the ceiling of the exact price, so the drop it took is the floor of the exact
        // drop: one more wei of drop would cross the exact value.
        assertLe((HI - got) * den, exactScaled, "the drop never overshoots");
        assertGt((HI - got + 1) * den, exactScaled, "and it is the largest drop that does not");
    }

    // ── The envelope, which is the rule `_termsOk` does not carry ────────────

    /**
     * @notice No word takes the price outside `[minOutEnd, minOutStart]`, and no word panics.
     *
     * The whole 32 bytes are fuzzed, along with the window, the instant and both ends. This is
     * the only thing standing between a hostile word and an arithmetic panic, and a panic is the
     * failure that matters: `skipInvalid` cannot step over one, so a single greedy signature
     * would take a whole batch down with it.
     *
     * The prices are bounded at `uint128` and the floor at the ceiling because that is exactly
     * what `_termsOk` admits. An intent outside those bounds is refused before any of this runs,
     * and `fillability` says `BadTerms_` — the same contract `_quote` has always had.
     */
    /// forge-config: default.fuzz.runs = 20000
    function testFuzz_TheEnvelopeHolds(
        bytes32 curve,
        uint128 hi,
        uint128 lo,
        uint64 t0,
        uint64 span,
        uint64 offset
    ) public view {
        lo = uint128(bound(lo, 0, hi));
        span = uint64(bound(span, 1, type(uint64).max - 1));
        t0 = uint64(bound(t0, 0, type(uint64).max - span));
        uint256 ts = uint256(t0) + bound(offset, 0, span);

        ProveSettlement.Intent memory i = _intent(PARTIAL_STRETCH, curve, 1);
        i.minOutStart = hi;
        i.minOutEnd = lo;
        i.startTime = t0;
        i.endTime = t0 + span;

        uint256 got = settlement.minOutAt(i, ts);
        assertGe(got, lo, "the floor the maker signed holds");
        assertLe(got, hi, "and so does the ceiling");
    }

    /**
     * @notice The same fuzz through `quote`, so the fee arithmetic and `_ceilDiv` are inside the
     *         blast radius.
     *
     * `minOutAt` answering inside the envelope is not on its own enough. `_quote` multiplies that
     * answer by the take, divides up, then carves a fee out of the gross and subtracts — three
     * more places a hostile word would have to survive if it could move the price. It cannot, and
     * this is the assertion that says so at the site where the money is decided.
     */
    /// forge-config: default.fuzz.runs = 20000
    function testFuzz_NoWordPanicsThroughQuote(
        bytes32 curve,
        uint128 amountIn,
        uint128 hi,
        uint128 lo,
        uint64 rate,
        uint64 offset,
        uint256 takeSeed
    ) public view {
        amountIn = uint128(bound(amountIn, 1, type(uint128).max));
        lo = uint128(bound(lo, 0, hi));
        rate = uint64(bound(rate, 0, 1e18));
        uint256 take = bound(takeSeed, 1, amountIn);
        uint256 ts = T0 + bound(offset, 0, SPAN);

        ProveSettlement.Intent memory i = _intent(PARTIAL_STRETCH, curve, 1);
        i.amountIn = amountIn;
        i.minOutStart = hi;
        i.minOutEnd = lo;
        i.feeConfig = feeCfg(address(0xFEE));
        i.feeRateProceeds = rate;

        TakePoints.Quote memory q_fee = settlement.quote(i, take, ts);
        uint256 delivered = q_fee.delivered;
        uint256 fee = q_fee.feeProceeds;
        assertLe(delivered + fee, uint256(hi) + 1, "the gross never exceeds the signed ceiling");
        assertLe(fee, delivered + fee, "and the fee is a share of it, never more");
    }

    // ── A kind reads only the bytes it names ─────────────────────────────────

    /**
     * @notice A kind-0 intent prices identically whatever the word holds.
     *
     * The bytes are signed and hashed, so the maker cannot be tricked about what they hold, and
     * the two intents below have different digests. What they do not have is different prices.
     * A byte nobody reads is the maker's own calldata to waste, exactly as `feeRate` is on an
     * intent whose `feeTo` is zero — and refusing it would spend gas on every fill to protect a
     * signer from themselves.
     */
    function testFuzz_AnUnreadWordChangesNoPrice(bytes32 curve, uint64 offset) public view {
        uint256 ts = T0 + bound(offset, 0, SPAN);
        ProveSettlement.Intent memory bare = _intent(PARTIAL, bytes32(0), 1);
        ProveSettlement.Intent memory loaded = _intent(PARTIAL, curve, 1);

        assertEq(
            settlement.minOutAt(loaded, ts),
            settlement.minOutAt(bare, ts),
            "kind 0 reads none of the word"
        );
        if (curve != bytes32(0)) {
            assertTrue(
                settlement.hashIntent(loaded) != settlement.hashIntent(bare),
                "and still signs a different offer"
            );
        }
    }

    /**
     * @notice Kinds 2 and 3 are reserved and unbuilt, so an intent naming one walks the line.
     *
     * This deployment reads no byte for either, so the price is kind 0's. That is the honest
     * outcome and not a hazard: building kind 2 changes `minOutAt`, changing `minOutAt` needs a
     * redeploy, and a redeploy moves the domain separator — so no signature written here can
     * ever be read by the contract that gives the number a meaning.
     */
    function test_AReservedKindPricesAsTheLine() public view {
        uint256 ts = T0 + SPAN / 3;
        bytes32 curve = _word(uint16(ONE / 2), uint16(ONE / 4));
        uint256 line = settlement.minOutAt(_intent(PARTIAL, curve, 1), ts);

        assertEq(settlement.minOutAt(_intent(1 | 16, curve, 1), ts), line, "kind 2 is the line");
        assertEq(settlement.minOutAt(_intent(1 | 24, curve, 1), ts), line, "and so is kind 3");
        assertTrue(
            settlement.minOutAt(_intent(PARTIAL_STRETCH, curve, 1), ts) != line,
            "while kind 1, on the same word, is not"
        );
    }

    // ── The four shapes, at their own boundaries ─────────────────────────────

    /// @notice `00000000` — today's line, and the word an SDK writes when the maker draws none.
    function test_ShapeTodaysLine() public view {
        ProveSettlement.Intent memory i = _intent(PARTIAL_STRETCH, _word(0, 0), 1);
        assertEq(settlement.minOutAt(i, T0), HI, "at the open, the ceiling");
        assertEq(settlement.minOutAt(i, T0 + SPAN / 4), HI - (HI - LO) / 4, "a quarter down");
        assertEq(settlement.minOutAt(i, T0 + SPAN / 2), HI - (HI - LO) / 2, "half way down");
        assertEq(settlement.minOutAt(i, T0 + SPAN), LO, "at the close, the floor");
    }

    /**
     * @notice `00004000` — dutch over the first quarter, then flat at the floor.
     *
     * The shape asked for first, and the one a cubic cannot draw. `lenF` of 16,384 is a quarter
     * of full scale, so the fall ends at 16384/65535 of the window — 900.02 seconds of 3,600,
     * which is why the floor is reached a shade after the round quarter and not before it.
     */
    function test_ShapeDutchThenFlat() public view {
        ProveSettlement.Intent memory i = _intent(PARTIAL_STRETCH, _word(0, 16_384), 1);
        assertEq(settlement.minOutAt(i, T0), HI, "the open is still the ceiling");
        // Half way through the fall: the price has given up half the range, less the rounding
        // the maker keeps.
        assertEq(settlement.minOutAt(i, T0 + 450), HI - ((HI - LO) * 450 * ONE) / (16_384 * SPAN));
        assertGt(settlement.minOutAt(i, T0 + 900), LO, "the round quarter is a shade above it");
        assertEq(settlement.minOutAt(i, T0 + 901), LO, "and one second later it rests");
        assertEq(settlement.minOutAt(i, T0 + SPAN / 2), LO, "still resting at the midpoint");
        assertEq(settlement.minOutAt(i, T0 + SPAN), LO, "and at the close");
    }

    /// @notice `80000000` — flat at the ceiling for half the window, then dutch to the close.
    ///         `lenF` of zero runs the fall to the end of the window, so the two ends still meet.
    function test_ShapeFlatThenDutch() public view {
        ProveSettlement.Intent memory i = _intent(PARTIAL_STRETCH, _word(32_768, 0), 1);
        assertEq(settlement.minOutAt(i, T0), HI, "the open is the ceiling");
        assertEq(settlement.minOutAt(i, T0 + SPAN / 4), HI, "and so is the first quarter");
        assertEq(settlement.minOutAt(i, T0 + 1_800), HI, "the round midpoint is a shade early");
        assertLt(settlement.minOutAt(i, T0 + 1_801), HI, "one second later the fall has begun");
        assertGt(settlement.minOutAt(i, T0 + SPAN - 1), LO, "it is still above the floor");
        assertEq(settlement.minOutAt(i, T0 + SPAN), LO, "and reaches it exactly at the close");
    }

    /// @notice `40004000` — flat a quarter, dutch a quarter, flat a half. Two corners, which is
    ///         the shape the whole field exists to draw.
    function test_ShapeFlatDutchFlat() public view {
        ProveSettlement.Intent memory i = _intent(PARTIAL_STRETCH, _word(16_384, 16_384), 1);
        assertEq(settlement.minOutAt(i, T0), HI, "flat at the ceiling to begin");
        assertEq(settlement.minOutAt(i, T0 + 900), HI, "and through the first quarter");
        assertLt(settlement.minOutAt(i, T0 + 901), HI, "then the fall starts");
        assertApproxEqAbs(
            settlement.minOutAt(i, T0 + 1_350), (HI + LO) / 2, 1e17, "half way down at the middle"
        );
        assertGt(settlement.minOutAt(i, T0 + 1_800), LO, "a shade above the floor at the half");
        assertEq(settlement.minOutAt(i, T0 + 1_801), LO, "resting on it a second later");
        assertEq(settlement.minOutAt(i, T0 + 2_700), LO, "still resting three quarters through");
        assertEq(settlement.minOutAt(i, T0 + SPAN), LO, "and at the close");
    }

    /// @notice The price never rises as the clock moves, on any of the four shapes.
    ///         A solver bisects for the first profitable second, and a fall that stepped back up
    ///         would put the bisection in the wrong basin.
    function testFuzz_TheStretchNeverRises(uint16 startF, uint16 lenF, uint64 offset) public view {
        uint256 ts = T0 + bound(offset, 0, SPAN - 1);
        ProveSettlement.Intent memory i = _intent(PARTIAL_STRETCH, _word(startF, lenF), 1);
        assertGe(settlement.minOutAt(i, ts), settlement.minOutAt(i, ts + 1), "monotone in time");
    }

    // ── Fills ────────────────────────────────────────────────────────────────

    /**
     * @notice Two partial fills either side of a breakpoint pay the two prices the curve names.
     *
     * The curve is `40004000`, so the first fill lands in the opening flat and pays the ceiling,
     * and the second lands in the closing flat and pays the floor. What is being pinned is that
     * the price is read at each fill's own instant and that the book between them is the plain
     * one: `filled[h]` carries the first take and nothing else, so the second fill's price owes
     * nothing to the first.
     */
    function test_PartialFillsAcrossABreakpointPayTheirOwnPrice() public {
        ProveSettlement.Intent memory i = _intent(PARTIAL_STRETCH, _word(16_384, 16_384), 1);
        bytes memory sig = _sign(i);
        bytes32 h = settlement.hashIntent(i);

        uint256 take = AMOUNT_IN / 4;

        vm.warp(T0 + 600); // inside the opening flat
        uint256 before = tokenB.balanceOf(maker);
        vm.prank(executor);
        settlement.fill(i, sig, take, ANY_FEE);
        assertEq(tokenB.balanceOf(maker) - before, (take * HI) / AMOUNT_IN, "paid the ceiling");
        assertEq(settlement.filled(h), take, "and booked exactly the take");

        vm.warp(T0 + 3_000); // inside the closing flat
        before = tokenB.balanceOf(maker);
        vm.prank(executor);
        settlement.fill(i, sig, take, ANY_FEE);
        assertEq(tokenB.balanceOf(maker) - before, (take * LO) / AMOUNT_IN, "paid the floor");
        assertEq(settlement.filled(h), 2 * take, "and the book is the sum of the two takes");
    }

    /**
     * @notice What the stretch costs on a real warm fill, against the line in the same binary.
     *
     *   forge test --match-test test_WhatTheStretchCostsOnAWarmFill -vv
     *
     * Two fills of the same size, at the same instant, through the same code. Only the kind bits
     * and the word differ, so there is no via-IR codegen between the two numbers — which is the
     * one thing a before-and-after of the whole table cannot say, because a struct that changes
     * shape moves stack scheduling by several hundred gas in either direction.
     *
     * What the field costs a maker who never sets the bits is a different number and is not
     * measured here: it is 128 gas of transaction calldata for one zero word, plus one keccak
     * round in `_structHash`. `gasleft` cannot see the calldata half, because the caller has
     * already paid it by the time this frame starts.
     */
    function test_WhatTheStretchCostsOnAWarmFill() public {
        vm.warp(T0 + 1_200);
        // Warm the slots and the balances, so neither row pays a first touch.
        ProveSettlement.Intent memory warmUp = _intent(PARTIAL, bytes32(0), 100);
        // Signed before the prank, never inside it: `_sign` asks the settlement for the digest,
        // and an external call inside a pranked line eats the prank.
        bytes memory warmSig = _sign(warmUp);
        vm.prank(executor);
        settlement.fill(warmUp, warmSig, AMOUNT_IN / 2, ANY_FEE);

        ProveSettlement.Intent memory line = _intent(PARTIAL, bytes32(0), 1);
        bytes memory lineSig = _sign(line);
        ProveSettlement.Intent memory stretch = _intent(PARTIAL_STRETCH, _word(16_384, 16_384), 2);
        bytes memory stretchSig = _sign(stretch);

        /*
         * Each row runs from the same state, not one after the other.
         *
         * A fill warms slots the next one would not pay for, and the two intents here settle
         * into different `filled` slots, so running them in sequence made the second row read
         * 4,076 gas cheaper than the first — the warmth, not the curve. A snapshot either side
         * removes the whole question.
         */
        uint256 snap = vm.snapshotState();

        vm.prank(executor);
        uint256 g = gasleft();
        settlement.fill(line, lineSig, AMOUNT_IN / 2, ANY_FEE);
        uint256 gLine = g - gasleft();

        vm.revertToState(snap);

        vm.prank(executor);
        g = gasleft();
        settlement.fill(stretch, stretchSig, AMOUNT_IN / 2, ANY_FEE);
        uint256 gStretch = g - gasleft();

        console.log("fill, allowance, warm, kind 0  ", gLine);
        console.log("fill, allowance, warm, kind 1  ", gStretch);

        console.log("the stretch, walked            ", gStretch - gLine);
        assertGt(gStretch, gLine, "walking the stretch costs more than not walking it");
        // Only an order of magnitude is asserted. The premium is the branch and one division,
        // and a build that made it cost thousands would have grown something else.
        assertLt(gStretch - gLine, 2_000, "and it is a branch and a division, not a walk");
    }

    /**
     * @notice One batch carrying a kind-0 leg and a kind-1 leg settles both.
     *
     * `skipInvalid` is passed `false`, which is the strict batch: a leg it cannot settle reverts
     * the whole call. So the assertion is not only that both legs paid their own price but that
     * a curve is never something a batch has to step over. There is no reason code for a curve
     * and there is nothing for one to say.
     */
    function test_ABatchOfMixedKindsSettlesBoth() public {
        vm.warp(T0 + 1_800);

        ProveSettlement.Intent memory line = _intent(PARTIAL, bytes32(0), 1);
        // Flat at the ceiling for the whole window, so the two legs cannot agree by accident.
        ProveSettlement.Intent memory held = _intent(PARTIAL_STRETCH, _word(60_000, 0), 2);

        ProveSettlement.FillRequest[] memory reqs = new ProveSettlement.FillRequest[](2);
        reqs[0] = ProveSettlement.FillRequest({
            intent: line, signature: _sign(line), take: AMOUNT_IN, arming: ""
        });
        reqs[1] = ProveSettlement.FillRequest({
            intent: held, signature: _sign(held), take: AMOUNT_IN, arming: ""
        });

        // Asked before the money moves, because that is where `skipInvalid` would step over a
        // leg. The curved leg is `Ok`, the same answer the flat one gives.
        assertEq(
            uint256(settlement.fillability(held, reqs[1].signature, AMOUNT_IN, executor, ANY_FEE)),
            uint256(ProveSettlement.Reason.Ok),
            "a curve is never a reason of its own"
        );

        uint256 before = tokenB.balanceOf(maker);
        vm.prank(executor);
        uint256 count = settlement.fillBatch(reqs, false, ANY_FEE);

        assertEq(count, 2, "a strict batch settled both legs");
        assertEq(
            tokenB.balanceOf(maker) - before,
            (HI + LO) / 2 + HI,
            "the line paid its midpoint and the stretch paid its ceiling"
        );
    }
}

# The signed intent, before mainnet

**Status: Built.** All three parts are on `master`:

| part | commit |
|---|---|
| Part 1, the curve field (`Intent.curve`, `_stretchAt`) | `78e0ef4`, 2026-09-05 |
| Part 2, the fee from the maker's number (#119) | `d1dd385`, 2026-09-05 |
| Part 2, the fee book and `claim` (#122) | `36701c9`, 2026-09-04 |
| Part 3, parked capital (`park`, `_parked`) (#120) | `8b7d92a`, 2026-09-08 |

The body below is the argument as it stood on 2026-09-03, when it said "proposed. Nothing here
is built." `contracts/src/ProveSettlement.sol` is the authority where the two differ.

Three changes that want the same window.

Every number below is measured on this repository at commit `a7c5d7f`, on 2026-09-03, with
`forge 1.8.0` and `solc 0.8.30` under the shipped `foundry.toml` — via-IR, optimizer at 1000
runs. Each measurement ran in a throwaway `git worktree`; the checkout was never written to.
Where I could not measure something I say "unmeasured" rather than guess.

## The window, and what it actually is

It is not the typehash. **Any change to a deployed contract needs a redeploy**, and a redeploy of
`ProveSettlement` mints a new `ProveRelayer` with it, so every maker's standing approval points
at an address that no longer settles anything. The EIP-712 domain separator changes at the same
time, so every standing signature is unspendable. Both happen whatever the codec does.

Today that costs nothing. Mainnet 369 still carries `settlement: ZERO_ADDRESS` — backlog #52,
blocked on #35 (`docs/ROADMAP.md:338-339`) — so there are no standing allowances and no standing
offers to orphan. The day #35 ships, there are.

So the question for each of the three changes is not "is it worth doing" but "is it worth doing
**now**, while doing it is free". That is a different question and it has different answers.

## The three parts

| | what it changes | reviewed with |
|---|---|---|
| **Part 1** — the curve field | what the maker's number is at a given moment | Part 2 |
| **Part 2** — the fee split (#119) and its settlement (#122) | how that number divides between the maker and the destination, and when it moves | Part 1 |
| **Part 3** — escrow rollover (#120) | where the maker's token A comes from | on its own |

**Parts 1 and 2 change what a signature means.** They land in the same function — `_quote` calls
`minOutAt` — in the same test files, the same generated fixture, the same sign form and the same
35 locales. A maker reading "you receive at least X" needs both answers at once or the sentence
is wrong. Review them together.

**Part 3 adds a funding path and changes no signed field.** It is independent, and it does not
need the window at all except that it is a contract change like any other.

### Build order

1. **#122 first**, on its own. It fixes a hazard that exists today and needs neither of the other
   changes, and it moves all 54 fee-destination assertions from a balance to a book. Landing it
   first means those are rewritten once rather than twice.
2. **Part 2's split next**, alone. It is the smallest contract diff in this document and the
   largest change in meaning, and it breaks 90 tests that each need a human decision. Land it and
   let the suite settle before anything else moves.
3. **Part 1 next**, on top. It is mechanical in the contracts and expensive only in the SDK and
   the app.
4. **Part 3 whenever.** It shares no file with any of them.

Only Part 1 needs the window. #122 and Part 2 change no signed field and could ship after mainnet
— at the cost of a redeploy that orphans every allowance, which is a reason to do them now and
not a reason the format demands it.

---

# Part 1 — A curve the maker draws

## What exists today

`minOutAt` (`contracts/src/ProveSettlement.sol:628`) walks one straight line from `minOutStart`
at `startTime` to `minOutEnd` at `endTime`. The maker gets exactly that value at the fill
timestamp: `_quote` computes `delivered = _ceilDiv(take * minOutAt(i, ts), i.amountIn)`
(line 684) and `_payMaker` pays it (line 1137), no more and no less.

## The invariant every option here protects

**The maker's payout is a function of time alone.** The market decides whether the offer fills
and what the solver keeps. It never decides what the maker gets. `docs/FEE-MODEL.md` Part 5
states the same rule as "signed inputs and live inputs, and mixing them is the bug".

## The shape of the proposal: a field, and kinds

The expensive thing is the **field**. It is the EIP-712 typehash, the wire version, a calldata
word on every fill forever, 63 TypeScript files and 35 locales. A **kind** is a branch in
`minOutAt` and two bits of a `flags` byte that is already inside `INTENT_TYPEHASH`.

So separate them:

```solidity
bytes32 curve;                                   // one new signed field

uint8 private constant FLAGS_CURVE_KIND = 24;    // bits 8 and 16 of `flags`
uint8 private constant KIND_LINEAR   = 0;        // today. `curve` is not read
uint8 private constant KIND_STRETCH  = 8;        // decay over one stretch, flat either side
uint8 private constant KIND_KNOTS    = 16;       // eight knots, nine linear segments
uint8 private constant KIND_CUBIC    = 24;       // a cubic Bernstein blend
```

`flags` is `uint8` with bits 1, 2 and 4 taken (`FLAG_PARTIAL`, `FLAG_ESCROW`, `FLAG_PERMIT2` at
lines 294–304). Bits 8 and 16 are free, and the struct comment at line 300 already explains why a
free `flags` bit costs nothing: it is inside the typehash and always has been.

**A kind reads only the bytes it names.** Kind 0 reads none. Kind 1 reads four. Kind 2 reads
thirty-two. An intent whose kind ignores a byte prices identically whatever that byte holds, and
pays calldata for it — the maker's own waste, exactly as `feeRate` with `feeTo == 0` is today. No
validation rule, no gas.

### Do I agree with reserving twenty-eight unused bytes?

Yes, but not for the reason I was given, and the difference matters.

The argument I was given is that the window closes at #35. **That argument is weak**, because a
later kind needs a settlement redeploy anyway — it is a change to `minOutAt` — and that redeploy
already orphans every allowance and every signature. So the marginal cost of *also* widening the
field at that later date is a typehash string, a codec version bump and the TypeScript churn.
Real, but not the cliff the framing implies.

The argument that works is arithmetic. **A `bytes32` and a `uint16` cost exactly the same
calldata**: every static member of an ABI-encoded struct gets its own 32-byte word, so both are
128 gas of zeros on every fill. And the msgboard codec writes only the bytes a kind uses, so an
unused byte costs nothing on the wire either. The wide field is free at the margin, and the
narrow one saves nothing anybody can measure.

A reserved field is a smell. This one costs nothing per fill, nothing per post, and one sentence
of documentation. Take it.

## Which kind to build: the three forms, measured

All three were built into one binary and measured against each other on the same intent, the same
fill, the same instant. Only the kind and the word differ, so there is no codegen noise in these
numbers.

| kind | word used | gas for a warm `fill` | over kind 0 |
|---|---|---|---|
| 0 — linear | none | 106,035 | — |
| **1 — stretch** | 4 bytes | 106,515 | **+480** |
| 3 — cubic | 4 bytes | 107,179 | +1,144 |
| 2 — knots, one knot | 4 bytes | 107,300 | +1,265 |
| 2 — knots, eight knots | 32 bytes | 109,763 | +3,728 |

Read that table next to what each form can draw.

### Kind 1 — the stretch. Two `uint16`, and it is the recommendation

```
price(u) = lerp(minOutStart, minOutEnd, clamp01((u - start) / length))
```

`start` is where the decay begins and `length` is how long it takes, both as a fraction of the
window in units of 1/65535. Flat at the ceiling before, falling across the stretch, flat at the
floor after.

```solidity
function _stretchAt(uint256 hi, uint256 lo, bytes32 curve, uint256 elapsed, uint256 span)
    private pure returns (uint256)
{
    uint256 startF = uint256(curve) >> 240;             // bytes 0-1
    uint256 lenF = (uint256(curve) >> 224) & 0xffff;    // bytes 2-3
    if (lenF == 0) lenF = KNOT_ONE - startF;            // zero means "to the end of the window"
    uint256 pos = elapsed * KNOT_ONE;
    uint256 begin = startF * span;
    if (pos <= begin) return hi;
    uint256 den = lenF * span;
    uint256 num = pos - begin;
    if (num >= den) return lo;
    return hi - ((hi - lo) * num) / den;
}
```

**The zero word is today's line, exactly.** With `startF = 0` and `lenF = 0 → 65535`, the return
is `hi - (range · elapsed · 65535) / (65535 · span)`, and `floor(a·k / b·k) = floor(a / b)`, so it
is `hi - (range · elapsed) / span` — the shipped expression, character for character.

**Rounding is unchanged.** The subtrahend floors, so the maker's price rounds up, exactly as
today.

**No input can panic.** `pos ≤ 2⁸⁰`, `begin ≤ 2⁸⁰`, `den ≤ 2⁸⁰`, `range · num ≤ 2²⁰⁸`. `den` is
zero only when `startF = 65535` and `lenF = 0`, and then `begin = 65535 · span > pos` for every
reachable `ts`, so the early return fires first. `num < den` at the division by the guard above
it. **Zero new `_termsOk` rules.**

Worked examples, for a 4-byte prefix:

| shape | `startF` | `lenF` | first four bytes |
|---|---|---|---|
| today's line | 0 | 0 | `00000000` |
| dutch over the first quarter, then flat | 0 | 16384 | `00004000` |
| flat for half, then dutch to the close | 32768 | 0 | `80000000` |
| flat a quarter, dutch a quarter, flat a half | 16384 | 16384 | `40004000` |

### Kind 2 — knots. One word, nine segments

Eight knots of four bytes: a `uint16` **delta** in time and a `uint16` price fraction between
`minOutEnd` (0) and `minOutStart` (65535), with implicit endpoints `(0, 65535)` and `(65535, 0)`,
and a zero word as the terminator.

**I changed one thing in the sketch I was given: the times are deltas, not absolute.** With
absolute times a maker can sign knots out of order, and `(t_right − t_left)` underflows into a
panic — and `_termsOk`'s own comment says why a panic is the wrong failure: *"a panic is not a
reason: `skipInvalid` steps on it and the batch dies with it"* (line 1833). Absolute times
therefore need a validation loop over all eight knots on every leg of every batch. Deltas cannot
go backwards, so **the encoding buys the validation rule for free** and the answer to "count the
comparisons" is zero.

```solidity
function _knotsAt(uint256 hi, uint256 lo, bytes32 curve, uint256 elapsed, uint256 span)
    private pure returns (uint256)
{
    if (curve == bytes32(0)) return hi - ((hi - lo) * elapsed) / span;   // a gas fast path only
    uint256 pos = elapsed * KNOT_ONE;
    uint256 tL;                 // left knot time
    uint256 pL = KNOT_ONE;      // left knot price — the implicit open, until a knot replaces it
    uint256 tR = KNOT_ONE;      // right knot time — the implicit close, likewise
    uint256 pR;
    uint256 c = uint256(curve);
    for (uint256 k; k < 8; ++k) {
        uint256 word = c >> 224;
        if (word == 0) break;                      // the terminator
        uint256 t = tL + (word >> 16);             // deltas, so this can never go backwards
        if (t * span > pos) { tR = t; pR = word & 0xffff; break; }
        tL = t;
        pL = word & 0xffff;
        c <<= 32;
    }
    uint256 den = (tR - tL) * span;
    uint256 num = pos - tL * span;
    return lo + _ceilDiv((hi - lo) * (pL * (den - num) + pR * num), KNOT_ONE * den);
}
```

The whole answer comes out of **one** `_ceilDiv`, so nothing rounds at a knot and no drift
accumulates across nine segments. The numerator is a plain weighted average of the two end
prices, which stays unsigned whether the segment rises or falls.

**On a knot boundary the two neighbouring segments give the same wei.** At `num = den` the left
segment gives `w = pR·den`; at `num = 0` the right gives `w = pR·den'`; and
`ceil(a·c / b·c) = ceil(a / b)`, so both reduce to
`minOutEnd + _ceilDiv(range · p_knot, 65535)`. The schedule is continuous. The walk takes the
later segment, and it does not matter which.

**Two knots cannot share a time in a way that divides by zero.** The walk always advances past
every knot at or before the position, so the left end is the last of any equal-time run and its
successor is strictly later. A run that reaches the end of the array falls through to the
implicit close at 65535.

**No input can panic, for any of the 2²⁵⁶ words**, under `_termsOk`'s existing caps alone:

| quantity | bound | why |
|---|---|---|
| `pos` | < 2⁸⁰ | `elapsed < span ≤ 2⁶⁴`, times 2¹⁶ |
| `tL` | ≤ 65534 | only set when `tL·span ≤ pos < 65535·span` |
| `den` | > 0, < 2⁸¹ | strict on both exit branches |
| `num` | ≥ 0, < `den` | strict, from the walk's stopping rule |
| `(hi−lo)·w` | < 2²²⁵ | 2¹²⁸ × 2⁹⁷, against a word's 2²⁵⁶ |
| result | in `[lo, hi]` | `w ≤ 65535·den` |

Worked example — convex decay, `p = 65535·(1−x)²` sampled every eighth, seven knots of `0x2000`
each and an eighth word as the terminator:

```
curve = 0x2000c3ff20008fff200064002000400020002400200010002000040000000000
```

Sixteen non-zero bytes, so 320 gas of calldata rather than 128.

### Kind 3 — the cubic. The algebra checks out, and it still loses

Space the control points evenly in x and the horizontal parameterisation collapses:

```
x(t) = 3(1-t)²t·(1/3) + 3(1-t)t²·(2/3) + t³ = t[(1-t) + t]² = t
```

Exactly, as claimed. So price is a cubic Bernstein blend of four y-values at `u = elapsed/span`,
`y0 = minOutStart` and `y3 = minOutEnd` are already signed, and **only y1 and y2 are free — two
`uint16`, four bytes**. That is right too. The envelope holds for free, because the Bernstein
weights are non-negative and sum to one, so the price is a convex combination of the four
y-values and can never leave `[minOutEnd, minOutStart]`.

**Reject the general Bezier and say so once.** A raw cubic is parameterised by `t`, not by time,
so pricing at a timestamp means solving `x(t) = ts` first — Newton or Cardano, in fixed point,
with input-dependent gas and an iteration count an adversary picks. It is not `pure`-friendly, it
is not constant-gas, and the even spacing above removes the need for it entirely.

**Overflow is the real constraint, and the naive form does not fit.** Scaling by `span³` gives a
numerator up to `65535·s³ ≈ 2²⁰⁸`, and `range · that` is 2³³⁶. It overflows a word. Two ways out:

- bound the span at `uint32` (136 years, nobody notices) — exact, but one new `_termsOk` rule;
- reduce `u` to a Q32 fraction first, `u = (elapsed << 32) / span` — no rule, no bound, one extra
  division, and a time quantisation of 2⁻³² of the window.

Take the second. The price error from quantisation is at most `3·range/2³²`, which for a 1e24-wei
range is 7e14 wei — 0.0007 tokens at eighteen decimals. Deterministic in time, so the invariant
holds, but **the cubic is the only one of the three that is not exact.**

```solidity
uint256 u = (elapsed << 32) / span;
uint256 v = (1 << 32) - u;
uint256 n = KNOT_ONE * v * v * v + 3 * v * v * u * p1 + 3 * v * u * u * p2;
return lo + _ceilDiv((hi - lo) * n, KNOT_ONE << 96);
```

**Monotonicity: do not check it.** A cubic can wiggle, and the sign of `y'(u)` is a quadratic
discriminant rather than a comparison of neighbours. But we established that monotonicity is not
required for safety — the envelope holds by convexity — and a rising segment can only delay a
fill, never make one worse for the maker. So an on-chain check buys nothing and costs a
discriminant on every leg. The SDK can warn at drawing time.

**Where the cubic loses, and it is the owner's own first request.** A single cubic cannot make a
corner. To hold flat at the floor from `u = 1/3` you would need the cubic to be identically zero
there, which no non-degenerate cubic is. With `y1 = y2 = 0` the curve is `65535(1−u)³`, which at
`u = 1/3` still sits at 19,418 — **29.6% of the range above the floor.** Dutch-then-flat is the
shape that was asked for first and the shape a cubic is worst at.

Against that, eight knots approximate any smooth cubic to within about 0.4% of the range. **Knots
dominate the cubic.** Build the cubic only if somebody produces a shape knots cannot make, and
nobody has.

## The recommendation, and the two cases it has to survive

**Ship the field, the kind bits, and kind 1 — the stretch. Document knots as kind 2 and the cubic
as kind 3, for a later redeploy to add without touching the format.**

The stretch is 2.6× cheaper than one knot and 7.8× cheaper than eight, on the same fill, in the
same binary. It produces dutch-then-flat exactly, flat-then-dutch exactly, and
flat-then-dutch-then-flat exactly — every shape anybody has actually asked for — in four bytes,
with one comparison and one division, and no new failure mode.

Two cases were agreed earlier to have real value. Both have to be re-examined against the stretch,
and I do not think either survives as a reason to build more today.

**Convex decay, for faster price discovery.** The stretch beats it. A convex curve approaches the
floor and only reaches it at the close; a stretch reaches the floor at `start + length` and then
**rests there**. "Find the clearing price quickly, then sit at my floor" is better discovery than
an asymptote, and it is what a maker means when they say convex. The case does not survive.

**Stepped decay, so a solver's quote is not stale by the time their transaction lands.** This one
half survives. The benefit is real: inside a flat region `minOutAt` is constant, so a solver's
simulated `delivered` is exact for every block in that region, and a multi-leg ring whose amounts
must line up stays lined up. The stretch gives one flat region, or two with both parameters, and
an offer that spends most of its life resting at the floor gets the benefit for most of its life.
What it does not give is a staircase through the *falling* part. **Nobody has reported needing
one.** The day a solver does, that is the day kind 2 earns its branch — and adding it then costs
a redeploy that a contract change was going to cost anyway.

## What was rejected, and why

**No external curve contract.** An address in the intent lets a curve read something other than
the clock, and the moment the maker's payout depends on market state, the solver — who controls
the sale, the venue and the block — can move that state and change what they owe. That is the
invariant, broken by the feature's only unique capability. It also gives up `pure` on `minOutAt`
and `quote`, and needs `_probe`-grade defence against a hostile curve.

**Drop the gas half of that argument.** Re-running `test/CurveCost.t.sol` at `a7c5d7f` gives 438
gas for a warm staticcall on a lean interface, 1,373 for one that sees the whole intent, and
2,919 for a cold account. An eight-knot walk costs +2,416 on `minOutAt` in isolation — **more
than a warm wide staticcall.** The case against a curve contract is the invariant. Say it that
way; the gas half does not survive contact with a full word.

**No on-chain curve registry.** A cold `SSTORE` is 20,000 gas plus 2,100 for a cold `SLOAD` on
every first read, against 128 gas of zero-word calldata. The `SLOAD` alone is sixteen times the
calldata it saves. The break-even never arrives.

**Curve data deployed as bytecode (SSTORE2), measured rather than argued.** This one deserved a
real number because none of the objections above apply to it: no code executes, the bytes are
immutable, no reentrancy, no gas bomb, and the payout stays a function of time alone.

| | measured |
|---|---|
| deploy 32 bytes as contract code | **92,337** |
| `EXTCODECOPY` read, warm | **120** |
| `EXTCODECOPY` read, cold | **2,620** |
| inline: 32 zero bytes of calldata | 128 |
| inline: 16 non-zero and 16 zero | 320 |
| a 20-byte address in calldata | 320 |

**It never pays.** Against the densest possible word (512 gas), the saving is
`512 − 320 − 120 = 72` gas per warm fill, and the first fill in each transaction pays 2,500 more
for the cold account. Break-even inside one transaction is about 35 legs sharing one curve; the
92,337 deploy amortises at 72 gas a fill over about 1,280 fills. Against a stretch's four-byte
word — 140 gas of calldata — an address costs **more** before the read even happens. And
`minOutAt` and `quote` stop being `pure`, which is the same cost the external-curve design was
rejected for. Document it and do not build it.

## The wire format

`sdk/src/intent.ts` hand-packs the payload with varints and a one-byte presence bitmap. Six of
eight bits are taken (`P_RECIPIENT` through `P_AUTH_NONCE`, lines 350–382). Bits `0x40` and
`0x80` are free.

**`curve` takes `0x40`.** Bit clear means `bytes32(0)`.

A varint is wrong here: it strips *leading* zeros and a curve's zeros are at the *trailing* end,
so `varint(uint256(curve))` would spend 33 bytes on a four-byte stretch. Write a length byte
`n` in 1..32 followed by `n` bytes, zero-padded on decode. The kind bits say how to read them.

Sizes, measured with `encodeIntent` at `a7c5d7f`, 65-byte signature, no gasless tail:

| intent | today | + stretch (4 B) | + 3 knots (13 B) | + 8 knots (33 B) |
|---|---|---|---|---|
| bare — no fee, no options | **165** | 170 | 178 | 198 |
| typical — names a `feeTo` and a `feeRate` | **193** | 198 | 206 | 226 |
| rich — every presence bit set | **275** | 280 | 288 | 308 |

The "~175 bytes" I was given is the bare case. The intent the app actually signs names a fee
destination, so **193** is the number to plan against.

`VERSION` in `sdk/src/intent.ts:327` goes 3 → 4. `decodeIntent` refuses a version it does not
know (line 495), which is the point: an old reader drops a new post rather than misreading it. A
new `KIND_*` will not do — kinds exist so an unknown *tail* costs one dropped post, and this
changes the head every reader parses.

## The msgboard

There is **no per-message size cap** in this repository or in the vendored `@msgboard/sdk`. The
board has an aggregate cap upstream in the node, and a message that does not fit waits for older
ones to age out. A bigger intent is not refused; it is priced, and the price is proof of work,
linear in bytes (`sdk/src/board.ts:117`):

```ts
((2n ** 24n + BigInt(dataLen) * 10_000n) * workMultiplier) / workDivisor
```

On a 193-byte intent the base difficulty is 18,707,216. The stretch adds **+0.27%**; three knots
**+0.69%**; eight knots **+1.76%**. Expected grind iterations scale with difficulty, so those are
also the browser's cost. The multiplier and divisor cancel out of the ratio, so the percentages
hold at any board floor.

## The gas

**For a maker who never uses the feature.** One static struct member is exactly 32 more calldata
bytes: **128 gas** under EIP-2028. `_structHash` goes from 17 words to 18: one `CALLDATALOAD`,
one `MSTORE`, three gas of memory expansion and one keccak round at 6 — **about 15 gas**. Total
**≈ 143 gas per fill**, which is 0.14% of `fill, allowance, warm` (104,700) and 0.25% of a
marginal batch leg (52,572).

The "~134" I was given is right, and it is the only number this harness can defend. Here is why:

| `fill, allowance, warm` | gas |
|---|---|
| shipped, 16 fields | 104,700 |
| + one `bytes32`, 17 fields | 105,133 (+433) |
| + two `bytes32`, 18 fields | 104,913 (+213) |

**Two extra words cost less than one.** That is conclusive: the +433 is via-IR codegen noise —
stack scheduling and jump-table layout shifting under a struct that changed shape — worth roughly
±400 gas, which swamps the ~15 the word actually costs. `fillWithCallback` moves the same way and
changes sign: 119,577 → 119,930 → 119,382. **Do not quote 433.**

*Measured 2026-09-05:* **EIP-7623 is not active on either chain**, so the 128 is the whole cost
and there is no floor under it. Chain 369 at block 27,467,834 and chain 943 at block 25,309,296
both return a header carrying `withdrawalsRoot` and carrying neither `excessBlobGas` nor
`requestsHash` — Shanghai, before Cancun and well before Prague. Calldata is priced at plain
EIP-2028: 16 gas for a non-zero byte, 4 for a zero one. Re-check this the day either chain forks.

**For a maker who uses it**, see the kind table above: +480 for a stretch, +1,265 for one knot,
+3,728 for eight. Isolating `minOutAt` through an external view gives the same picture for the
walk: zero word 5,284, one knot 6,338, seven knots 7,604, eight knots 7,700 — **+1,054 to enter
the branch at all, then about +195 per knot walked.**

Two honest caveats. **The entry cost is roughly eight times what counting the opcodes predicts**
(about 130 gas for one knot). It is consistent across every measurement, and all three kinds pay
about the same ~500–1,200 to leave the shipped straight line, which points at a via-IR frame
rather than at the arithmetic. I could not attribute it and did not chase it; treat the tables as
upper bounds a careful implementation ought to beat. **And writing the knot walk in inline
assembly saves about 130 gas at one knot and 1,040 at eight** — but an assembly block in this
codebase needs a target in `contracts/tools/prove-yul-runs.py`, which pays a cold build and a
full suite run every time it runs. Not worth it for kind 2, and irrelevant for kind 1.

## The typehash

One member at the tail, where every downstream reader already expects the end of the struct:

```
Intent(address maker,address recipient,address tokenIn,address tokenOut,uint256 amountIn,
uint256 minOutStart,uint256 minOutEnd,uint64 startTime,uint64 endTime,address executor,
address feeTo,uint64 feeRate,uint256 minFill,bytes32 authNonce,uint8 flags,uint256 nonce,
bytes32 curve)
```

The domain separator does not change: `NAME_HASH` and `VERSION_HASH` (line 345) name the
contract, not the struct, and a new settlement address already produces a new separator.

## Monotonicity, and the rule that stays

`_termsOk` refuses `minOutEnd > minOutStart` (line 1844), and `docs/FEE-MODEL.md` Part 4 flags the
stated reason as *"an implementation artefact, not a policy"*. Two questions hide behind it.

**A rising segment inside a curve is allowed.** It costs nothing to permit, cannot panic, and a
solver fills at the first profitable moment — so a rising segment can only delay a fill or
prevent one, never make one worse for the maker. `a7c5d7f` deleted `MAX_WALLET_WINDOW` on exactly
that reasoning, for a hazard whose loss "falls on the signer alone". This one has no loss at all.

**`minOutEnd > minOutStart` stays refused, because the curve makes it redundant.** Under kind 2 a
knot at `t = 65535` overrides the implicit close, so a schedule that rises from the floor to the
ceiling and finishes there is fully expressible with the fields in their present order. The
refusal stops meaning "no rising prices" and starts meaning something cleaner:

> `minOutStart` is the ceiling and `minOutEnd` is the floor. The curve says where between them the
> price sits at each moment.

That reading keeps `hi − lo` from underflowing without a branch, keeps the `uint128` cap on one
field instead of two, and makes the envelope true by construction — which is what a UI needs to
draw axes before it knows the shape. The comment at line 1833 and the FEE-MODEL row both need
rewriting to say the new reason, because the old one stops being true.

## What it costs the solver

`sdk/src/solver/plan.ts`'s `profitableFrom` finds the first profitable moment by **bisecting over
integer seconds**, calling `sizeRing` and `planOf` at each probe, then walking back up to eight
seconds because integer rounding makes the chain "only almost monotone". It never solved a linear
crossing, so nothing algebraic is lost.

What changes is the assumption underneath. **Bisection needs the profitability predicate to be
monotone in time.** A flat region does not break that. A rising segment does, outright: the
window can open, close and open again, and a bisection between an unprofitable start and a
profitable deadline can land in the wrong basin — or return `null` while a profitable interval
sits in the middle.

The fix is cheap because every kind here is piecewise linear or smooth-with-known-breakpoints:

1. Compute the breakpoints. Kind 1 has two (`start`, `start + length`); kind 2 has at most nine;
   kind 0 has none.
2. Probe each. At most ten `planOf` calls.
3. Bisect **only** inside a segment whose start is unprofitable and whose end is profitable —
   monotone there by construction.
4. Take the earliest hit.

For a ten-minute window: today is about ten bisection probes plus up to eight walk-back probes.
Kind 1 is two boundary probes plus one bisection, so **about the same**. Kind 2 with nine
segments is about twenty-four against eighteen. A naive "nine independent bisections" would be
sixty-four; do not write that one. **A solver that only ever meets kind 0 or kind 1 pays
nothing measurable.**

`sdk/src/market.ts:298`'s `edgeOf` evaluates at a single instant and needs only the new
`minOutAt`. `ringDeadline` is a min-reduce over window bounds and is unaffected.

## The blast radius, measured by building it

**Contracts.** I built the full `bytes32 curve` field — struct, mirrored struct, typehash, and the
walk — and ran the suite.

| file | change |
|---|---|
| `contracts/src/ProveSettlement.sol` | the member, `INTENT_TYPEHASH`, `minOutAt`, the kind constants and one `_*At` per kind, and the rewritten reason at line 1833 |
| `contracts/src/ProveExecutor.sol:20` | the **mirrored** struct. Its own comment says a drift here builds, deploys, and reverts on every call. The compiler will not catch it |
| 30 test files, **44 construction sites** | one `curve: bytes32(0)` each, mechanical |
| `contracts/test/ProveSettlement.t.sol` | `test_TheStructHashIsTheFieldByFieldEncoding` lists the fields and asserts `17 * 32`. **The only test in the suite that fails on the mechanical edit** |
| `contracts/test/Fixture.t.sol` | writes `app/src/lib/__fixtures__/eip712.json`; regenerate, and extend its `minOutAt` samples to cover a curved intent |
| `contracts/test/CurveCost.t.sol` | keep the file, rewrite its conclusion |
| `contracts/abi/*.json`, `sdk/src/abi.ts` | generated by `sdk/scripts/gen-abi.mjs`; CI fails on a diff |

**587 passed, 1 failed, 14 skipped.** Invariant suites excluded for time and unmeasured.

**SDK.** `intent.ts` (the type, `TYPES`, `VERSION`, `P_CURVE`, encoder, decoder, and the
`minOutAt` mirror at 271–278), `settlement.ts` (`toStruct`, the `quote` mirror at 503),
`decay.ts`, `rfq.ts` (`mirrorFor` — keep the mirror flat), `store/types.ts`, `solver/plan.ts`,
and the three test files that import the fixture and fail on a stale digest.

**63 TypeScript files carry 159 `minOutStart:` object literals.** Make `curve` required on the
`Intent` type, as `minFill` was: `tsc -b` then names every one, and a field that changes the
digest should not be forgettable.

**App.** `Compose.tsx` (the intent at 408–447, `offerCurve()` at 107–124),
`charts/MarketPanel.tsx`, `charts/chart.ts` (`decayShape` at 161 draws a two-point fall; a stretch
needs three points, knots need a polyline), `lib/schedule.ts`, `rfq/MakeQuote.tsx`,
`landing/decay.ts`, and 27 scripts under `app/scripts/`.

**35 locales.** `parity.test.ts` fails the build for any locale missing a key English holds, and
nothing generates a translation. 82 `sign.*` keys exist today. **This is the largest single cost
in Part 1 and it is entirely in the UI** — which is the strongest argument for kind 1: a stretch
is two sliders on a chart the sign form already draws, not a knot editor.

Calibration: `git log --stat 3960d16`, the last commit that moved the typehash, is **111 files,
+2,146, −317** — and it bundled four changes.

## The test plan

- **`testFuzz_AZeroWordIsTheShippedLine`** — for every kind whose zero word is defined as the
  line, over fuzzed prices and timestamps. Passes today for kind 1 and kind 2.
- **`testFuzz_TheWalkItselfIsTheShippedLine`** — kind 2 with the `curve == 0` fast path removed,
  so the fast path is proven to be a gas optimisation and not a semantic one. Passes, 512 runs.
- **`testFuzz_TheEnvelopeHolds`** — fuzz the full `bytes32`, the timestamp, the span and both
  prices; assert the answer lies in `[minOutEnd, minOutStart]`. Passes, 512 runs. **Run this at a
  high run count in CI**: it is the only thing standing between a hostile word and a panic, and it
  is what stands in for the `_termsOk` rule that does not exist.
- **`testFuzz_KnotBoundariesAreContinuous`** — the closed form at a knot's own instant. Passes,
  512 runs.
- **No word panics** — the same fuzz through `quote`, so `_ceilDiv` and the fee arithmetic are
  inside the blast radius.
- **Partial fills across a breakpoint** — two fills either side, asserting both curve values and
  that `filled[h]` is untouched.
- **A batch of mixed kinds** — one `fillBatch` carrying kinds 0, 1 and 2, proving `skipInvalid`
  never has to step over a curve.
- **The fixture pins the mirror segment by segment**, not only at the endpoints.

---

# Part 2 — The fee comes out of the maker's number (#119)

## What changes

Today the filler's outlay is `delivered + fee`: `_payMaker` delivers to the maker (line 1137) and
`_payFee` pulls the fee to `feeTo` (line 2137). Under the change the filler's outlay is the
maker's signed number, and it **splits**: the maker receives `gross − fee`, the destination
receives `fee`.

> 1000 token A for 1000 token B as the maker describes means that on a 1% fee the maker walks with
> 990, with 10 going to the buy-and-burn or whatever `feeTo` the intent names.

## The argument for it

`docs/FEE-MODEL.md` Part 3 is the argument the current design needs. A solver fills at the first
moment

```
proceeds − delivered − delivered × rate − gas > 0     ⟺     delivered < (proceeds − gas) / (1 + rate)
```

so a higher rate lowers the delivery a solver will accept, and on a decaying offer the curve has
to fall further before anyone takes it. **The fill lands later and lower.** The maker pays the fee
in time and in clearing price, not in a line item, which is precisely why it is the thing that
"gets written down wrong".

Under the split that `(1 + rate)` term leaves the inequality entirely. The solver's condition
becomes `proceeds − gross − gas > 0`, which does not mention the rate at all. **The fee costs the
maker a fixed, visible amount and costs them nothing in time.** That is the whole case, and it is
a good one: it replaces a cost nobody can see or price with one that appears on the screen.

Part 3 of `FEE-MODEL.md` has to be rewritten to say what the new design needs instead, and the
new sentence is short: *the rate moves money from the maker to the destination and changes nothing
else. It does not move the fill.*

## The contract diff, and it is three lines

```solidity
uint256 gross = _ceilDiv(take * minOutAt(i, ts), i.amountIn);
fee = (gross * _rateOf(i)) / WAD;
delivered = gross - fee;
```

plus one rule in `_termsOk`. That is all.

**Rounding flips direction, and the principle does not.** Today `_ceilDiv` rounds `delivered` up
and then `fee` up: the maker first, the destination second. Under a split the same ordering is
`fee = floor(gross · rate)` and `maker = gross − fee`, so the dust stays with the maker and the
destination absorbs it.

One thing is lost and it should be recorded. `_quote`'s comment today says the fee rounds up so
that *"any delivery above zero pays at least one wei at any rate above zero — which is what keeps
a five basis point rate meaning something on a six-decimal token"*. Under floor rounding a small
fill at a small rate pays no fee at all. That is a gift to the maker and a loss of dust to the
destination, and it is the right direction for a protocol that earns nothing from a fill. Keep
floor. Say so in the comment that replaces the old one.

**A new `_termsOk` rule is required, and I proved it rather than assuming it.** `feeRate` is a
`uint64` against a `WAD` denominator, so it tops out near 1844%. At any rate above 100%,
`fee > gross` and `gross − fee` underflows. I removed the guard and ran it: `quote` on an intent
with `feeRate = 1.5e18` reverts with `stdError.arithmeticError` — a panic, which `skipInvalid`
cannot step over and which takes a whole batch down. So:

```solidity
if (i.feeRate > WAD) return false;
```

One comparison, on every leg of every batch and every `fillability` call. The struct comment at
line 111 that says *"There is no ceiling on it either, beyond the width of the field"* becomes
false: there is a ceiling now, it is 100%, and the reason is arithmetic rather than policy.

I chose `i.feeRate` over `_rateOf(i)` deliberately. `_rateOf` folds a zero `feeTo` to a zero rate,
so using it would cost a second comparison to permit an intent that charges nothing and signed an
absurd rate — an intent the maker could have written with `feeRate = 0`.

A clamp — `fee = min(fee, gross)` — would be cheaper, because `_quote` runs once per settling leg
while `_termsOk` runs on every leg including skipped ones. Reject it: a clamp silently pays the
maker zero. Refusing the terms is the honest failure and it is what `_termsOk` is for.

## Three claims to check, and two of them hold

**No typehash change.** Holds. The split touches no signed field. Confirmed by building it: the
patch compiles with `INTENT_TYPEHASH` untouched.

**Two transfers, not three.** Holds. `_deliverTo(tokenOut, recipient, delivered)` and
`_payFee(tokenOut, feeTo, fee)` are the same two pulls, and `_accrue`/`_flush` coalesce fee runs
across a batch exactly as before.

**No extra gas.** Nearly. Measured, `fill, allowance, warm` goes 104,700 → **104,767 (+67)**, and
the marginal batch leg 52,572 → 52,588 (+16). Both are inside the ±400 codegen noise floor
established in Part 1. By opcode count the honest figure is about **+10 gas** — a `_ceilDiv`
traded for a plain division and a subtraction, roughly neutral, plus the one new `_termsOk`
comparison on every leg. Call it free, but do not say "no extra gas": there is a new comparison
and it runs on legs that never settle.

**Two expressions elsewhere turn out to be correct in both designs**, which is worth knowing
before somebody "fixes" them:

- `ProveSettlement.sol:1211` tells the callback it owes `delivered + fee`. Under the split that is
  `(gross − fee) + fee = gross` — still the outlay. No change.
- `ProveBatchExecutor.sol:741` sums `owed[j].amount + owed[j].fee` for a token. Same identity. No
  change.
- `_requireSwept` (`ProveBatchExecutor.sol:604`) only checks that owed tokens appear in the sweep
  list. It touches no fee arithmetic. No change.

And the `Filled` event keeps its meaning if you define `delivered` as **what the maker received**
and `fee` as **what the destination received**. Their sum is the executor's outlay in both
designs, so every consumer that computes an outlay stays correct. A consumer that reads
`delivered` as "what the curve asked for" does not — name that in the migration note.

## Is `maxFeeRate` dead? No. Keep it.

The hypothesis is reasonable: the filler's outlay is `gross` whatever the rate is, so a cap
protects them from no money. But it protects them from something else, and I checked before
recommending.

`_payFee` calls `ProveRelayer.pull(token, msg.sender, to, fee)` — a `transferFrom` from the filler
to `feeTo`. A blacklisting token, a `feeTo` on a deny-list, or a destination contract with an
expensive receive hook reverts or grieves the whole fill. Today a filler can pass `maxFeeRate = 0`
and `Reason.FeeTooHigh_` steps over every leg that would touch a fee destination at all. **That is
the only switch in the contract for "do not engage with a fee destination", and deleting the
parameter deletes it.**

Removal is also not free on the wire. The enum's own comment says so:

> Appended, never inserted. The numbers are a wire format: clients mirror this enum and a shifted
> value renames every reason at once.
> — `contracts/src/ProveSettlement.sol:1908`

`FeeTooHigh_` sits at ordinal 12 with `BelowMinFill_` at 13, and `sdk/src/settlement.ts:542`
mirrors the list positionally. Removing a member shifts `BelowMinFill_` and renames a reason for
every client, and Solidity enums cannot carry a hole without a placeholder member.

**So keep both, and change what they mean in the docs**: from "the highest fee I will pay" to "the
highest rate whose destination I will engage with". The `@param` at line 880 and the
`docs/FEE-MODEL.md` Part 4 row both need rewriting. The alternative saves 128–512 gas of calldata
per fill and costs a wire-format break and a capability; it is not a good trade.

## Book the fee, do not transfer it (#122)

**Decided: unconditional booking.** `_payFee` stops paying anybody. It pulls the fee to the
settlement and records `_pendingFees[feeTo][token] += fee`, and the destination — or anybody
willing to spend the gas on their behalf — takes it out later with `claim`.

The owner's licence for this was explicit: *"we need to not worry about gas costs right now. we
need to worry about getting this out to the world securely. if we have to spend 50+% more gas then
so be it."* The measured cost is well inside that. It is stated in full below, because a decision
taken with eyes open should show what was seen.

### The hazard, proven both ways

A fee destination is an address the maker signed and nobody vetted. Today, if it will not receive
the token, **the whole fill reverts and the maker gets nothing** — and nothing tells them they
signed something dead. I proved both halves with a token that denies one address the way a
deny-listed stablecoin does:

- against `a7c5d7f`, `fill` reverts with the token's own `"denied"` and the maker's balance stays
  at zero;
- with the fee booked, the same fill settles, the maker is paid in full, and the fee waits.

Part 2's split sharpens it. Once the fee is carved out of the maker's number rather than added on
top, the destination sits inside the maker's own payment, and a destination that could ever be
exposed to `tokenIn` as well as `tokenOut` doubles the number of tokens that can refuse it. The
failure belongs to whoever chose the destination, not to the maker whose fill it kills.

### The argument is simplicity, and it removes a class rather than catching a case

```solidity
function _payFee(address token, address to, uint256 fee) private {
    if (fee == 0) return;
    ProveRelayer(relayer).pull(token, msg.sender, address(this), fee);
    _pendingFees[to][token] += fee;
    _totalPendingFees[token] += fee;
}
```

One path. No branch, no failure mode, nothing to reason about at the call site.

**The destination of the fee transfer stops being attacker-chosen.** It is `address(this)` on every
fill, whatever the intent said. A deny list, a reverting receive hook, a reentrant callback, a gas
bomb — none of them are reachable from a fill any more, because the address that would run them is
never called during one. That is a class removed, not a case caught, and it is the reason to
prefer this to anything that handles the hostile destination rather than never reaching it.

**One correction, because the stronger version of that sentence is not true.** I was given it as
"the fee transfer leaves the fill path entirely — no token code runs for a fee during a fill at
all". It does not, and it cannot: the executor must part with the fee inside the fill or they can
walk away with it, and ERC-20 has no way to split one transfer. So a transfer still runs. What
changes — and it is the whole of the safety benefit — is that it targets a constant the maker
cannot choose, in a token the fill already touches for the maker's delivery. Nothing new is
reached; one arbitrary address is removed.

### What it costs, measured

Steady state first, because that is what it will actually cost. The same intent filled four times
in a row, so every slot after the first is warm:

| `fill, allowance` | today | booked | delta |
|---|---|---|---|
| first touch | 143,376 | **205,102** | **+61,726 (+43.0%)** |
| second | 104,688 | **115,114** | **+10,426 (+10.0%)** |
| third | 104,689 | 115,115 | +10,426 |
| fourth | 104,702 | 115,128 | +10,426 |

**The delta is flat at +10,426 — ten per cent — from the second fill onward.** The +43% first touch
is a one-off per `(destination, token)` pair: two zero slots at 20,000 each, plus the settlement's
own zero balance in that token. The owner expects two or three whitelisted `feeTo` addresses in
total, so across the life of a deployment that is a handful of one-off payments and then never
again. **Ten per cent is the number to plan against, against a licence for fifty.**

The other paths move by the same amount:

| path | today | booked | delta |
|---|---|---|---|
| `fill, escrow, warm` | 111,962 | 122,388 | +10,426 |
| `fillWithCallback` | 119,577 | 130,003 | +10,426 |
| `fillBatch x1` | 129,440 | 139,884 | +10,444 |
| `claim`, a destination emptying its book | — | **50,017** | new |

And in a batch, per leg:

| per leg, x20 | today | booked |
|---|---|---|
| one destination | 1,113 | 2,486 |
| two destinations | 5,815 | 7,910 |
| twenty destinations | 27,372 | 28,612 |
| twenty destinations, second batch | 10,406 | 11,646 |
| one destination, second batch | 1,657 | 2,175 |

### Correcting the gas reasoning that was offered for this

The change was put to me as a gas improvement — *"a warm SSTORE against a token transfer, so a
twenty-leg batch sharing a destination stops paying for twenty transfers"*. **It already pays for
one.** `_accrue` coalesces on the token *and* the destination (line 2110), so twenty legs naming
one place cost one transfer today; `Gas.t.sol` measures it at 1,113 gas a leg against 5,815 when
the run breaks. And `_payFee` never moved money through the settlement at all — it calls
`ProveRelayer.pull(token, msg.sender, to, fee)` (line 2137), executor straight to destination. So
booking does not remove a transfer. It redirects one and adds two `SSTORE`s.

There is a variant that wins on gas, and it is worth recording because somebody will think of it.
Coalescing the *pull* on the token alone, so a batch pays one transfer per token however many
destinations it names, measures 3,666 a leg against 5,815 at two destinations and 24,367 against
27,372 at twenty. **One destination still loses** (2,550 against 1,113), and repeated fills to one
place never cross over. It is more code — a wider `FeeRun` and a separate book step — for a win
only in batches naming several destinations, which is not the shape the owner expects. Not
recommended, but measured, so the option is not lost.

### What was rejected, and why it was right before the licence

Attempting the transfer under a gas cap and booking only on failure costs **+53 gas** on the happy
path — inside the codegen noise floor — with the fee-per-leg unchanged and the same safety
outcome. Under a gas constraint it is the better design and I recommended it.

It is the wrong design without one, because it is the more complex of the two: a gas-bounded
external call, a failure branch, a bound somebody has to choose and defend, and a swallowed revert
to reason about. It also *handles* the hostile destination instead of never reaching it, so every
new call site has to remember that the fee path can fail. **There is no `PAY_FEE_GAS` and no
`_probe`-style bound in the recommended design. Do not re-add them.**

### The second book, and the sweep that would eat it

`sweepUnowned` pays `balanceOf(this) - _totalReserved[token]` to `defaultProceeds`. A booked fee
sits in the settlement and belongs to no reservation, so **without a second total the owner's
sweep takes the destinations' money.** The fix is one term:

```solidity
uint256 booked = _totalReserved[token] + _totalPendingFees[token];
```

`test_TheSweepCannotTakeABookedFee` pins it, and it passes. Under unconditional booking this is
not an edge case waiting for a hostile destination — the settlement holds fee balances from the
first fill of the first intent that names anywhere, so a sweep before this term is added takes real
money on day one.

The per-destination map must sum to that total, exactly as `_reserved` sums to `_totalReserved`.
That invariant already exists — `Invariants.t.sol:379-402`,
`invariant_TheReservationsStillAddUpToTheBookTheSweepReads` — and its second assertion
(lines 396–400, that the settlement's real balance equals the reservations) **is false from the
first fee-charging fill**, not from the first hostile one. It needs the same term.

**What the handlers already have, and what they lack.** The reservation invariant enumerates
hashes from two ghost arrays, `SettlementHandler.intents` (line 72) and `armedIntents` (line 212),
and the token axis from a fixed seven-slot universe (`tokenAt`, lines 663–679). The destination
axis already exists as a fixed two-slot universe, `feeTos = [0xF1, 0xF2]` (lines 77–80). Both index
sets are reusable as they stand.

What is missing is the bookkeeping. `contracts/test/handlers/FeeGhost.sol` keeps three scalars —
`ghostCharged`, `ghostToFeeTo`, `ghostUnnamedFills` — and `_bookFee(address feeTo, uint64 feeRate,
uint256 delivered)` (line 49) **takes `feeTo` and discards it** after the zero-address check. It has
no token parameter at all. So `invariant_TheFeeReachesTheDestinationTheIntentNamed`
(`Invariants.t.sol:215-223`) can only compare one combined total against summed balances, and under
booking it is comparing against balances that no longer move.

`FeeGhost` needs `mapping(address => mapping(address => uint256)) ghostPendingFees` and a `token`
argument on `_bookFee`. Then the new invariant is the old one with different keys: loop the two
destinations against the seven tokens, assert `pendingFees(f, t) == ghostPendingFees[f][t]`, and
assert `Σ_f pendingFees(f, t) == totalPendingFees(t)`. **Extend the existing proof; do not invent a
new one.**

### The name: `claim`

`_flush` is taken internally, `sweepUnowned` owns "sweep", `withdraw` is escrow's and `_collect` is
the batch callback's. `claim` is free as a function name, and the word already carries exactly this
meaning in this codebase's prose — `ProveCallSink` and `ProveBatchExecutor` both describe a
standing approval as *"a claim on their own money and nobody else's"*. One word, one meaning, and
the meaning is already fixed.

### Who may call it: anybody, pushing to the recorded address

`claim(address to, address token)` takes the destination as an argument and pays **that address**,
not `msg.sender`. Anybody may spend the gas.

That is the right call for the same reason anybody may re-post a maker's intent, and for a concrete
one: the destinations this feature exists for are buy-and-burn contracts and frontend sinks, which
will never send a transaction of their own. A `msg.sender`-only claim would strand the money it was
invented to hold.

The attack surface is small and worth stating rather than assuming. Nobody can redirect the
payment, because the destination is the map key. Nobody can drain a book they do not own, because
the amount is read from that key. Nobody can grief a destination beyond forcing them to receive
their own money. The one real consideration is that a destination which is a contract now receives
a transfer at a moment it did not choose; `claim` holds `nonReentrant` and writes both books to
zero before transferring, so a reentering destination finds an empty book.

A destination that cannot receive its token at all — the deny-listed case this whole section
exists for — simply has a `claim` that always reverts. Its money stays booked and unreachable,
which is the right outcome: the fill settled, the maker was paid, and the loss falls on whoever
named an address that cannot be paid.

### `Filled` stops meaning the fee moved

It means the fee was **charged and booked**. It moves when somebody calls `claim`.

`watchdog.ts` does not break. I read the file: `checkFills` (lines 232–267) reads only `take`,
`delivered` and `intentHash` off `Filled`, recomputes the maker's floor from the signed terms at
line 257, and asserts `delivered < owed` at line 258. It never touches `ev.args.fee` and it makes
**no `balanceOf` call anywhere in the file**. So booking changes nothing it checks — which is the
finding, not the reassurance: **the watchdog has zero assertions about the fee today.** It cannot
catch a fee that goes to the wrong place, and it will not catch a book that disagrees with a
balance.

That is the check to add, and it is also the cross-settlement invariant the owner asked for. One
line, holding for every deployed settlement independently:

> For every settlement address and every token: `balanceOf(settlement) >= totalReserved(token) +
> totalPendingFees(token)`, and `Σ pendingFees(destination, token)` over the destinations the board
> has seen equals `totalPendingFees(token)`.

After #35 an old settlement still holds claimable balances and unwithdrawn reservations, and both
halves must keep holding there with no fills ever landing again. So `watchdog.ts` should carry a
list of settlement addresses rather than one `SETTLEMENT`, and check each. The `>=` is deliberate:
a donation or a rebase-up leaves the settlement holding more than the two books, and `sweepUnowned`
is what reconciles it. A settlement holding **less** than its books is the alarm, and it is the
only shape of that alarm that matters.

One caveat before it is wired: per the internal risk assessment no `WEBHOOK` is configured, so
every alert this bot raises currently lands in a local log and nowhere else.

### The correction I owe on the payout assertions

I was told every payout assertion in the repo tests a floor where the contract promises equality,
and that it was worth fixing in the same pass. **I checked, and the claim is false.** Across
`contracts/test`, `sdk/src`, `app/src` and `app/scripts/e2e`: **179 equality assertions against 15
floors.** In `contracts/test` alone the maker-payout ratio is 126 equalities to 4 floors.

The floors are not sloppiness. Nine of the fifteen are the maker checks in `app/scripts/e2e/*`,
where the script recomputes `requiredOut` off-chain against a decaying curve and can be a block
adrift of the timestamp the contract used — a floor is the only honest assertion available there.
The rest bracket `ceilDiv`'s rounding direction on both sides, which is a stronger statement than
either.

**There is nothing to fix. There is something to rewrite, on every path rather than an exceptional
one.** All 54 fee-destination assertions in the repo are equalities on the destination's balance,
and that balance no longer moves during a fill. Each becomes an assertion about `pendingFees`, plus
a `claim` and a balance delta where the test cares that the money can get out. That work is
additional to the 90 failures Part 2's split already causes, and it is the reason to land #122
before the split rather than after: otherwise those 54 assertions are rewritten twice.

### The posture this changes, stated plainly

Today everything the settlement holds is a reservation owned by a named intent, and `sweepUnowned`
proves it: whatever is not reserved belongs to nobody and goes to `defaultProceeds`.

After this the settlement holds fee balances **continuously**, from the first fill that charges
anything, belonging to no intent and to no reservation. They are unreachable by the owner, by the
maker and by any solver, indefinitely, including for a destination that never claims and for one
that cannot. The contract becomes a place money rests as well as a place it passes through.

That is a new kind of thing for this contract to be. Under try-then-book it would have been entered
only by a destination that had already demonstrated it could not be paid; under the decided design
it is the normal state. It is worth saying in the contract's own header comment, next to the two
rules already there, because the next person to reason about `sweepUnowned` needs to know it before
they read the subtraction.

## What breaks, measured

I built the split and ran the suite. **90 tests fail across 17 suites** — against 1 for the whole
of Part 1.

| suite | failed |
|---|---|
| `TokenMatrix.t.sol` | 28 |
| `ProveSettlement.t.sol` | 13 |
| `BatchExecutor.t.sol` | 9 |
| `BatchCallback.t.sol` | 7 |
| `RfqVenue.t.sol` | 6 |
| `Permit.t.sol` | 4 |
| `EconAudit`, `Adversarial` (×2), `Custody`, `Fuzz` | 3 each |
| `Executor`, `FaucetToken`, `Reasons` | 2 each |
| `FeeTo`, `Relayer`, `ReturnBomb` | 1 each |

Almost all are the same shape — an assertion that the maker received exactly the signed rate —
and **each one is a correct failure needing a human decision, not a mechanical edit.** Three are
worth reading before anyone starts:

- **`FeeTo.t.sol: test_TheMakerPaysNothingForNamingADestination`.** The test's *name* becomes
  false. That is the design change stated in six words, and the file should keep a test with the
  opposite name saying what the maker now pays.
- **`RfqVenue.t.sol: test_AQuoteWithNoSpreadCannotPayForItsExclusivity`** and
  **`test_ADonationCannotPayTheQuotesOwnFee`** fail with "next call did not revert as expected".
  Under the split a quote with **no spread at all can now pay for its own exclusivity**, because
  the fee comes out of the maker rather than out of a spread the counterparty must bring. That is
  a real change to the RFQ venue's economics, not a stale assertion. Decide whether it is wanted.
- **`BatchExecutor.t.sol: test_ADonationIsNotSweptToTheNextCaller`** and
  **`test_ATokenNamedTwiceInTheSweepIsHarmless`** change the caller's realised spread. The sweep
  logic is untouched; the numbers moved.

**Combined with Part 1 the suite reports 91 failures — exactly 90 + 1.** The two parts fail
disjoint sets of tests, which is the cleanest evidence available that they are orthogonal in the
arithmetic even though they land in the same function.

## `minOut` stops being a net guarantee, and that is the real cost

`docs/FEE-MODEL.md` Part 3 opens with *"`minOut` is a genuine net guarantee"*. That sentence dies.
The maker signs a gross and receives `gross × (1 − rate)`.

**What the sign form must do.** Let the maker type the number they will **receive**, and let the
form derive the gross it signs. Given a target net `N` and a rate `r`, sign
`G = ceil(N · WAD / (WAD − r))`; then `G − floor(G·r/WAD) ≥ G·(WAD−r)/WAD ≥ N` always, so the
maker's stated figure is met or beaten with one ceiling division. Show the derived gross and the
fee beside it: *"you receive N; we sign for G, of which F goes to {destination}"*. That keeps the
guarantee the maker cares about, moves it from the contract to the app, and says out loud where
the money goes — which is the point of `feeTo` being the frontend's choice.

**The copy that becomes false.** These are the ones I found; `app/src/i18n/en.ts` line numbers,
and each needs 35 translations.

| key | why it dies |
|---|---|
| `sign.fee.note` (293) | *"so it is not deducted from what you receive"* — the exact opposite |
| `landing.fact.rate.head` (733) | *"The rate you sign is the rate you get"* |
| `landing.fact.rate.body` (734) | *"The executor pays the fee on top of that floor... not the amount you signed"* |
| `landing.control.rate.title` (1001) | *"Nobody can change what you receive."* |
| `landing.control.rate.body` (1002) | *"works out what you are owed... before it works out anybody's fee"* |
| `landing.control.where.rate` (989) | cites `_quote`'s compute order literally |
| `landing.step.execute.body` (793) | *"The executor pays the gas and the fee"* |
| `landing.solver.earn.body` (963) | *"they pay the fee you named"* |
| `landing.solver.term.floor.body` (967) | *"pays you from that number and hands the solver the remainder"* |
| `rfq.make.rate.note` (1112) | *"It rides on top of the fill"* |

And the "at least" family, which currently equals the gross and would become gross-minus-fee
unless the form derives as above: `sign.want` (204), `sign.want.start` (209),
`sign.floor.spoken` (230), `landing.card.atLeast`/`receive` (752, 760), `landing.cost.atLeast`
(1057), `rfq.accept.wants` (1163), `row.amounts.spoken` (470), `landing.step.sign.body` (787).
`batch.pay`/`batch.receive`/`batch.fee` (542–544) are not false but become misleading, because
`BatchTray.tsx:193-197` shows `fee` as an addition beside `pay` and under the split that
double-counts.

Non-i18n: the comment at `app/src/components/Compose.tsx:986` — *"The fee rides on top of the
fill, so naming a destination costs the maker nothing"* — sits directly above the rendered note
and becomes a false comment.

## The rest of the blast radius

**SDK.** `settlement.ts` — `feeOn` (492) and `quote` (503), and the `QuoteResult` comment at 496
that says *"the fee on top"*. `fee.ts` — no code change, but `suggestFeeRate`'s doc block (18–26)
reasons entirely from the old economics and inverts.

**Solver — this is where the split pays off and where it must not be missed.**
`sdk/src/solver/size.ts:71-78`'s `legPay` returns `q.delivered + q.fee`, and `sizeRing` (321)
repeats it into `SizedLeg.pay`. Under the split an intent leg's `pay` is just the gross.
`sdk/src/solver/rings.ts:115-163` carries `effectiveFee` and folds `(1 + φ)` into
`ringCondition`'s inequality, with a doc at 105–110 that states the old assumption outright:
*"the executor's real rate is that rate"*. That whole term comes out. `size.ts:172`'s
`phi.den + phi.num` in `rationalCeiling` comes out with it. Nothing in `market.ts`, `price.ts` or
`depth.ts` needs to change: their fee arithmetic is the AMM's own swap fee, which is a different
thing.

**RFQ.** `sdk/src/rfq.ts:176-178`'s `exclusiveQuoteCost` is fine as it stands, but its doc
(168–174) describes the additive model. The arithmetic that changes is at the call sites:
`app/src/rfq/QuoteCard.tsx:83` (`const sells = cost.delivered + cost.fee`, fed to `mirrorFor`) and
`app/src/rfq/SettleQuote.tsx:200` (`const needsB = cost.delivered + cost.fee`, which drives the
submitter's displayed `keepsB`). Both become `cost.delivered`.

**E2E scripts, and this is the operationally loud one.** `app/scripts/e2e/{batch,gasless,partial,
escrow,permit}.ts` all carry the pattern

```ts
const owed = requiredOut(intent, take, at)
must(got >= owed, `the maker received ${show(OUT, got)}, signed for ${show(OUT, owed)}`)
```

which passes today because the maker receives the whole gross. **Every one of these fails under
the split** and each needs `owed` recomputed net. `permit2.ts:232` has the same shape against
`MIN_OUT`.

## Test plan for Part 2

- **Fuzz the split's total.** For every `take`, `ts` and `rate ≤ WAD`:
  `delivered + fee == gross` exactly, and `gross == _ceilDiv(take · minOutAt, amountIn)`. The
  executor's outlay must be independent of the rate — that is the whole claim.
- **Fuzz the rounding direction at both extremes.** At `rate = 1` wei the fee is zero for any
  gross below `WAD` and the maker keeps everything; at `rate = WAD` the fee is the whole gross and
  the maker receives zero. Assert `fee ≤ gross` for every input, so the subtraction can never
  underflow once the `_termsOk` rule is in.
- **The panic the rule prevents.** Keep the `feeRate = 1.5e18` case as a `Reason.BadTerms_` test,
  and keep a comment saying it used to be an arithmetic panic.
- **A batch whose legs charge different rates** pays one coalesced fee run per destination, as
  today, and each maker's net is right independently.
- **`fillability` refuses a rate above `WAD`** before any money moves, so a batch steps over it.

For #122, on top:

- **A destination the token refuses does not kill the fill.** Written and passing:
  `test_ADestinationTheTokenRefusesDoesNotKillTheFill` against a token that denies one address.
  Keep the mirror test against today's behaviour as the thing that documents what was fixed.
- **The sweep cannot take a booked fee.** Written and passing:
  `test_TheSweepCannotTakeABookedFee`. This is the one I would write first.
- **A destination that reverts inside `claim` cannot reenter into a second payout**, and finds
  both books at zero.
- **No fill ever calls a fee destination.** The strongest form is a destination whose fallback
  reverts unconditionally, filled through every rung and every batch shape: none of them fail.
  That is the class-removal claim, asserted rather than described.
- **A destination that cannot receive its token has a `claim` that reverts**, and its book stays
  intact and unreachable afterwards.
- **The second book's invariant**, keyed by destination and token, extending
  `invariant_TheReservationsStillAddUpToTheBookTheSweepReads` rather than replacing it — and the
  balance half of that invariant gains `+ totalPendingFees(token)`.
- **`FeeBooked` fires exactly when, and only when, the direct transfer failed.**

---

# Part 3 — Escrow that outlives the intent it was deposited for (#120)

## The problem

`_reserved[h]` is earmarked per intent hash (written at `ProveSettlement.sol:748`). When an offer
expires, the maker's only route back is `withdraw` (line 778) — which returns the tokens **and**
cancels the offer — followed by a fresh `deposit` against the new intent. Two token transfers to
move capital that never needed to leave the contract, plus two maker transactions.

## Not an external function. A fourth arming arm

A `rollover(old, new)` external call needs a transaction from the maker, which barely beats the
withdraw-and-deposit it replaces. Do it the way every other custody rung is already done.

`_armLeg` (line 1485) has three arms, each driven by `arming` bytes **the solver supplies**,
inside `try this.armLeg`:

```solidity
if (i.flags & FLAG_PERMIT2 != 0)      _pullPermit2In(i, h, take, arming);
else if (i.flags & FLAG_ESCROW != 0)  _redeemInto(i, h, take, arming);
else                                  _grantAllowance(i, take, arming);
```

A fourth source is the same shape: the solver names where the tokens are, the settlement moves
them into `_reserved[h]`, `_evaluate` re-runs, and the leg either fills or fails. **No maker
transaction, no second transaction, and the filler pays the gas exactly as on every other rung.**

## Hash chain or shared balance? Shared balance, and the deciding argument is off-chain

I was asked to weigh `_reserved[oldHash] → _reserved[newHash]` against
`_balance[maker][token] → _reserved[newHash]`. They are not close.

**The hash chain cannot be driven, because the solver cannot get the preimage.** To roll an old
reservation the solver must supply the *whole* old intent — `deposit` takes the intent rather than
the hash for exactly this reason, and the comment at line 729 explains it: the preimage is what
decides `maker` and `tokenIn`, and taking the digest instead lets the first caller decide them. So
the solver needs sixteen fields of a possibly months-old offer. The msgboard is ephemeral — 120
blocks — and `emit Deposited(h, i.maker, i.tokenIn, received)` carries **only the hash**. There is
no on-chain record of the preimage anywhere. A solver who was not watching the board when that
offer was posted, and did not archive it, cannot construct the call at all.

That makes the hash chain a feature only for solvers with a complete historical archive, which is
a centralising property in a protocol whose whole argument is that anybody can fill.

The shared balance needs one read: `_balance[maker][token]`. The solver already knows the maker
and the token from the intent in front of them.

**The objection I was given against the shared balance, and why it does not apply.** The objection
was that `_reserved[h] >= take` is what makes an escrowed intent *certainly* funded, and a shared
balance turns three 1000-intents against a 1000 balance into first-come. Two answers:

1. **The guarantee is not degraded, because the balance is additive.** `_reserved[h]` still
   exists, is still written by `deposit`, and is still what `_evaluate` checks (line 1974). An
   intent funded the old way is certainly funded exactly as today, and a solver still sees that
   with one read. The balance is a *second source that needs arming*, not a replacement for the
   first.
2. **The first-come property is identical under the hash chain.** Three live intents competing for
   one dead intent's reservation is the same race. The objection was about a naive mapping
   replacing reservations, and neither design does that.

And the degraded thing — the solver's *preview* — already exists. `EscrowShort` has meant "needs
arming, not never" on an armable leg since the arming work, and the enum comment at line 1905 says
so: *"On a leg that asked to be armed this means 'not now' rather than 'not ever'"*. `dryRun`
(line 1752) was built to answer exactly this class of post-transfer question.

## The guards, and the one place the authorisation argument is false

The claimed authorisation is: the maker signed the intent being filled, so moving their own dead
capital into it is doing what they asked. **I tested that and found one case where it is false,
and it is the most important thing in Part 3.**

**An unfunded escrow signature stops being inert.** Today an intent carrying `FLAG_ESCROW` that
the maker never funded can never fill: `_evaluate` answers `EscrowShort` for ever, and the maker
has to send a transaction for it to become live. That makes "signed but not deposited" a real way
to hold a signature back — and it is the one property escrow has that no other rung has. Under
this arm, that signature fills the moment any other offer of theirs dies with a balance behind it,
chosen by a solver, with no action by the maker.

Is that acceptable? It is the same shape as a decision already taken. `a7c5d7f` accepted that a
revoked allowance leaves a wallet signature alive and that re-approving revives every signature
the maker ever wrote — `test_ARevivedAllowanceRevivesEverySignatureStillInsideItsWindow` pins it.
This is that hazard arriving at the rung that used to be exempt. **It is defensible and it must be
said out loud**, in the struct docs and in the app, because a maker who used "I just won't deposit"
as an off switch will lose it. `cancel` and `invalidateBefore` remain the real off switches, and
the app should say so where it says anything about escrow.

The other cases I checked and found harmless: a maker cannot be over-filled, because `amountIn` in
their own signature bounds it; which dead offer the solver drains does not matter, because the
tokens are fungible and all theirs; and a wallet-rung intent is untouched, because the arm only
applies to intents carrying `FLAG_ESCROW`.

**The minimum guard set**, and every one of them is answering "who owns this" on behalf of
somebody who is not present — the shape of the `ProveCallSink` defect the roadmap records as #112
(`docs/ROADMAP.md:81`), where a shared resource with no owner check let a stranger arm a standing
approval:

1. **The source is keyed by the maker, not by a hash.** `_balance[i.maker][i.tokenIn]` — read from
   the intent's own preimage, which the signature covers. This is what makes the design safe by
   construction rather than by check: there is no hash whose owner has to be established.
2. **Same token.** Implied by (1); state it anyway in the doc.
3. **The new intent is not cancelled and the nonce is above the floor.** `_evaluate` already
   checks both (lines 1947–1949), and `_armLeg` re-runs `_evaluate` after arming (line 1503).
4. **The amount is bounded by the leg.** Move `min(balance, take)`, never the whole balance.
   A solver must not be able to sweep a maker's parked capital into one hash on a one-wei fill.
5. **`_totalReserved` must include the parked balance.** This is a hazard, not a nicety:
   `sweepUnowned` transfers `balanceOf(this) − _totalReserved[token]` to `defaultProceeds`, so a
   balance the accounting does not know about **is swept to the owner's address.** Either count
   `_balance` in `_totalReserved` when it is credited, or the first sweep takes every maker's
   parked money.

## How the balance gets filled

The arm spends the balance; something has to credit it. One permissionless function:

```solidity
function expire(Intent calldata i) external;   // dead intent -> the maker's own balance
```

It moves `_reserved[h]` to `_balance[i.maker][i.tokenIn]`, writes `cancelledAt[h]` exactly as
`withdraw` does, and transfers nothing. It needs no caller check at all, because it can only move
the maker's money into the maker's own balance — there is no destination for it to be pointed at.
That is a much smaller surface than `withdraw`, which pays out.

**"Dead" should mean `block.timestamp >= i.endTime` or `cancelledAt[h] != 0`, not an explicit
cancel.** Demanding a cancel puts the maker's transaction back into the loop, which is the whole
thing this is avoiding. `endTime` is signed by the maker and read from calldata, and an expired
intent can never fill again — `_evaluate` returns `Expired` (line 1937) — so nothing the maker
still wants is being taken. A cancelled intent is dead by the maker's own act.

The maker's route out is unchanged: `withdraw` still pays a live intent's reservation back, and a
`withdrawBalance(token)` pays the parked balance back. Both are maker-only.

## The rest of Part 3

**Error.** A new `Reason` member is not needed: a leg the balance cannot fund answers
`EscrowShort` exactly as it does today, and that already means "not now" on an armable leg. Adding
a member would append to a wire format for no new information. For the arm's own failures, reuse
`BadTerms`.

**Invariants.** `test/Invariants.t.sol:365` already asserts that `totalReserved` equals the sum of
the reservations after arbitrary arming, and `SettlementHandler.sol:1396` fingerprints
`totalReserved` on every action. The assertion needs widening to *reservations plus parked
balances*, and the handler needs two new actions — `expire` and a fill armed from a balance — or
the invariant will pass over a path it never takes.

**SDK.** `sdk/src/solver/arming.ts` builds the `arming` bytes per rung and gains a fourth shape.
`sdk/src/solver/book.ts` reads `_reserved[h]` when it decides whether a leg is fundable and must
also read the balance. A new `readBalances` alongside `readReservations` in `settlement.ts`.

**The Mine tab** already lists a maker's intents with a withdraw button. Rollover is not a second
button on that row — under this design there is nothing for the maker to press. What the tab needs
instead is a **parked balance line**: "you have N token A resting here, and it will fund your next
escrow offer", with a withdraw button beside it. That is a smaller UI change than a per-row action
and it tells the truth about where the money is.

**The theft attempts, as tests.** A stranger calling `expire` on a live intent. A stranger calling
`withdrawBalance` for somebody else. A solver arming a leg from a balance of a different maker. A
solver arming across tokens. A solver arming more than `take`. A fill armed from a balance into a
cancelled intent, and into one below the nonce floor. `sweepUnowned` after a credit, asserting the
parked balance is untouched — that one is the hazard in item 5 above and it is the test I would
write first.

---

# Open

- ~~Whether chain 369 prices calldata under EIP-7623.~~ Answered 2026-09-05: no. Both chains sit
  at Shanghai, so calldata is plain EIP-2028 and Part 1's headline 128 gas stands. See Part 1's
  gas section.
- Whether the ~1,000 gas floor on leaving the shipped straight line is real or a via-IR artefact.
  Counting the opcodes predicts about a tenth of it, and all three kinds pay roughly the same,
  which points at the frame. Somebody should read the Yul before the numbers are quoted anywhere.
- The invariant suites were not run against any of the three builds.
- Part 2's `Filled` event keeps its arithmetic identity but not its meaning for a consumer that
  reads `delivered` as the curve's value. `sdk/src/solver/execute.ts:596` (`deliveredFromLogs`)
  and `sdk/src/archive.ts` should be checked against that reading.
- Whether the RFQ venue *wants* a no-spread quote to be able to pay for its own exclusivity.
  Part 2 makes it possible; nobody has said whether it should be.
- Whether the two books belong in `sweepUnowned`'s subtraction or in a single accessor both it and
  the watchdog read. One term is smaller; one accessor is harder to forget when a third book
  appears.
- Whether `watchdog.ts` should take a list of settlement addresses instead of one `SETTLEMENT`.
  The cross-settlement invariant needs it, and nothing else does yet.
- No `WEBHOOK` is configured for `watchdog.ts` (the internal risk assessment), so any alarm added
  for the two books currently lands in a local log and nowhere else.

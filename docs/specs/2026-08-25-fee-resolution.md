# The fee is measured in basis points, and basis points are too coarse

**Status: Built** (it said "Done"), in `3af12d3` (contracts) and `3070196` (SDK, app, 34 dictionaries). The
recommendation below is what shipped: `uint64` against `1e18`. What the note got wrong is
recorded at the bottom, under "What the estimate missed".

## The complaint

A rate in basis points has a denominator of 10,000, so the smallest fee anyone can name is one
basis point — a hundredth of one per cent. That is a fine unit for a retail swap and a bad one at
both ends of the size range.

At the small end it does not bind. On a sixty-cent intent every rate is swamped by gas, and no
rate fixes that; size does.

At the large end it is the binding constraint. On a trade worth a million dollars, one basis point
is a hundred dollars, and that is the *smallest step available*. An interface that wants to charge
ten dollars on that trade cannot say so. It rounds to zero or it rounds to a hundred, and there is
nothing in between. The unit, not the policy, is deciding the price.

## What already landed

Two changes are in the tree and are not what this note proposes.

**`MAX_FEE_BPS` went from 100 to 2,000, and stopped being the binding ceiling.** It was written as
a bound a rate should never need, and it became the thing that decided what business an interface
on this protocol was allowed to run. It is a backstop now: the bound an executor can rely on
*before* it has read an intent, which is what keeps a caller that passes `type(uint256).max` for
its own `maxBps` bounded rather than open.

**The maker's own signed rate is the ceiling.** `_clampFee` holds a fee policy to
`_rateOf(i.feeBps, floorBps)` — the same number the built-in arithmetic charges at. On the
ordinary path the clamp is exact. Under a policy, a maker who signed nothing pays nothing, and a
maker who signed fifty basis points cannot be charged fifty-one.

That second one is a real change of who decides. The fee is pulled from the filler in `_payFee`,
after `_payMaker` has already delivered the maker's number in full, so the old rule cost a maker
nothing directly. It still let an owner-installed policy charge a rate against an intent whose
maker had named a different one. The party whose signature is on the intent is the party who
decides what their offer costs to fill.

Neither change needs a new struct, a new typehash or a new wire format. This note's does.

## The proposal

Change the unit the rate is expressed in, from basis points to a fixed-point fraction of one
ether, and widen the field to carry it.

```
Intent.feeBps  int16    →  Intent.feeRate  uint64
BPS = 10_000            →  WAD = 1e18
```

### Why `1e18` and not `1e9`

Both give more resolution than anyone needs. `1e9` — the square root of one ether — resolves to a
ten-millionth of a per cent, and `1e18` to far less than a wei of any real trade. Resolution is
not what separates them.

What separates them is that `1e18` is the unit every Solidity reader already has in their head.
`0.003e18` reads as three tenths of one per cent to anyone who has written a token contract.
`3_000_000` against a denominator of `1e9` reads as nothing at all, and every integration has to
go and look up which power of ten this protocol chose. A wire format is read by strangers.

### Why `uint64` and not `uint256`

`uint64` holds up to 18,446,744,073,709,551,615, which in WAD is 18.44 — a rate of 1,844 per cent.
The range is already absurd for a fee, and the type is doing useful work by making a twenty-times
fee unrepresentable rather than merely refused.

It also packs beside the two `uint64` timestamps the struct already carries, and it costs eight
bytes on the wire instead of thirty-two.

Overflow does not bite. `_termsOk` already refuses an intent whose `minOutStart` is above
`type(uint128).max`, so `delivered × rate` is bounded by `3.4e38 × 1.8e19 = 6.2e57`, and a
`uint256` holds `1.16e77`.

### What happens to the dials

`feeFloorBps`, `executorRebateBps` and `protocolShareBps` are fractions of a fee rather than
fractions of a delivery. They could stay in basis points.

**They should not.** Two denominators in one arithmetic path is how a rounding bug gets written,
and the rounding direction here is a promise — `_ceilDiv` rounds the maker's delivery up, on
purpose, and the fee split rounds each of its three parts. Move all of them to WAD, and there is
one denominator in the file.

## What it costs

Six things, and the third is the one that is easy to miss.

**1. Every resting signature dies.** A new field changes the EIP-712 typehash, so every intent
signed under the old one becomes unfillable. On mainnet today that is a heartbeat bot's own book.
On testnet it is ours. **The cost of this change only goes up from here**, which is the argument
for doing it now rather than after the app can see mainnet.

**2. The wire format changes, and it is versioned for exactly this.** `encodeIntent` writes a
`VERSION` byte and a presence bitmap, and the fee field is only encoded when it is non-zero. So an
intent that names no fee costs no extra bytes at all, and one that does costs six more. The
archive holds old-format posts; the decoder needs to refuse them by version rather than
misread them.

**3. The word "bps" is in thirty-four dictionaries.** `batch.bound` renders `{bps} bps` in every
language and `batch.bound.spoken` says "basis points" in every language — and those spoken strings
were *just* corrected across nine locales for numeral agreement. Changing the unit changes all of
them again. Anyone planning the landing-page translation should sequence around this rather than
translate twice.

**4. The economics review touched this arithmetic.** Six findings live in `test/EconAudit.t.sol`,
and the rounding-direction proofs are stated in basis points. Re-establish them at the new scale
rather than assuming they carry.

**5. A redeploy.** `ProveSettlement`, and with it `RfqVenue` and `ProveBatchExecutor`, which read
`relayer()` from the settlement in their constructors. Both of those went on chain on 2026-08-25,
hours before this came up, at a cost of 2,818 PLS. That money is spent either way.

**6. `MAX_FEE_BPS` needs a new name.** It is not basis points any more, and a public constant with
a stale unit in its name is worse than no constant.

## Recommendation

Do it, and do it as one piece rather than in the middle of something else. The wire format, the
dials, the SDK's public constants, the config files and thirty-four dictionaries all move
together, and half of that migration is worse than none of it.

Do it **before** the landing-page translation, so "basis points" is only translated once.

## Open

- Does the rate stay a *rate*? An absolute fee — a token amount rather than a fraction — would
  serve the small-ticket case better than any denominator, because a fixed cost is what an
  interface actually has. It is a bigger change and a different argument, and it is not proposed
  here.
- Should `feeRate` be unsigned? `int16` today carries a negative value meaning "a client's
  arithmetic went below zero, treat it as asking for nothing". Unsigned removes the quirk and
  the branch. It also removes the signal, which nothing currently reads.


## What the estimate missed

Three things, found in the doing.

**The unit was hiding in more places than the fee.** A blanket rename swallowed `FeeSink`'s
slippage dials, the taxing token's cut, the rebasing token's index scale and the test matrix's
own denominator — four separate arithmetics that count in basis points and always did, none of
which has anything to do with an intent's fee. Each is back with its own named constant, so the
next rename cannot repeat it. This was the single largest source of failures.

**`src/solver/abi.ts` shares a filename with the generated `src/abi.ts`.** The rename loop was
told to leave the generated one alone and skipped both. It is hand-written, it maps the `Intent`
struct for every call the solver sends, and it would have shipped a solver sending an undefined
fee. One test caught it.

**Taking the unit out of the sentence was cheaper than translating it.** The note assumed 34
dictionaries would need the word "basis points" retranslated. They did not: formatting the rate
as a locale-aware percentage in code and leaving `{rate}` unqualified in the sentence turns the
edit into a *deletion* of a known phrase, which is safe in a language you cannot read. It also
retires the numeral-agreement bug class — a percent sign inflects in no language — and means the
next change of unit touches no dictionary at all.

One thing the note called a cost turned out not to be. The wire format was already versioned and
already had a presence bitmap, so an intent that names no fee pays nothing for the wider field
and the decoder refuses version 1 cleanly.



## Appendix: who sets what, in the order it happens

Five numbers can bound a fee. They are set by three different parties at three different times,
and reading them as one setting is the mistake this appendix exists to prevent.

### Step 1 — the owner, once, before any of this

Configuration, in `contracts/config/<chainid>.json`. It can move later, and a move reaches every
intent already resting on the board.

| | shipped guess | ceiling | what it does |
|---|---|---|---|
| `feeFloorRate` | 0.05% | 0.5% | a minimum. A maker asking for less is charged this instead |
| `executorRebate` | 20% | 50% | the filler's discount on the fee, taken off the top |
| `protocolShare` | 50% | 80% | how the rest splits: the sink's share, and the remainder to the intent's own destination |

### Step 2 — the maker, signing

Fixed for the life of the offer. No later change to configuration reaches these.

| | example |
|---|---|
| `amountIn` | give at most 1,000 A |
| `minOutStart` / `minOutEnd` | want at least 1,000 B |
| `feeRate` | 0.3% — what this offer charges |
| `feeTo` | where that fee goes, or nobody |

### Step 3 — the filler, at fill time

| | example |
|---|---|
| `take` | 1,000 A — all of it |
| `maxFeeRate` | 1% — the most this caller will pay |

If `max(feeRate, feeFloorRate)` is above `maxFeeRate`, the leg is refused here, before any
arithmetic — and in a batch it is stepped over rather than taking the batch down.

### Step 4 — the arithmetic, in this order

```
1  delivered = the maker's own curve at this take          1000.000 B
2  rate      = max(maker 0.3%, floor 0.05%)                    0.3%
3  charged   = delivered x rate            round UP           3.000 B
4  rebate    = charged x rebate 20%        round DOWN         0.600 B
5  left      = charged - rebate                              2.400 B
6  toSink    = left x share 50%            round UP           1.200 B
7  toFeeTo   = left - toSink                                  1.200 B
```

### Step 5 — what moves

The rebate moves nothing. It is a discount, so it is simply never charged.

```
maker's recipient   <-  1000.000 B     from the filler
fee sink            <-     1.200 B     from the filler
the intent's feeTo  <-     1.200 B     from the filler
                        ----------
the filler pays         1002.400 B     and keeps the 1,000 A it took
```

**The maker receives `delivered` in full, always.** The fee is pulled from the filler in
`_payFee`, after `_payMaker` has already delivered the maker's number. Nothing in this appendix
can reduce what the maker gets.

### Change one thing at a time

Each row keeps the case above and moves a single number. Delivered stays 1000 B throughout.

| change | rate used | charged | rebate | sink | feeTo | filler pays |
|---|---|---|---|---|---|---|
| *the case above* | 0.3% | 3.000 | 0.600 | 1.200 | 1.200 | 1002.400 |
| maker signs nothing | 0.05% floor | 0.500 | 0.100 | 0.200 | 0.200 | 1000.400 |
| maker signs nothing, and names nobody | 0.05% floor | 0.500 | 0.100 | **0.400** | — | 1000.400 |
| maker signs 1 bp, under the floor | 0.05% floor | 0.500 | 0.100 | 0.200 | 0.200 | 1000.400 |
| maker signs 20%, the backstop | 20% | 200.000 | 40.000 | 80.000 | 80.000 | 1160.000 |
| maker signs 20% + 1 wei | — | — refused at `_termsOk`, `BadTerms` | | | | |
| filler bounds at 0.1% | — | — refused at `_evaluate`, `FeeTooHigh`; skipped in a batch | | | | |
| owner sets `protocolShare` to 0 | 0.3% | 3.000 | 0.600 | **0** | 2.400 | 1002.400 |
| owner sets `executorRebate` to 50% | 0.3% | 3.000 | **1.500** | 0.750 | 0.750 | 1001.500 |
| owner raises the floor to 0.5% | 0.5% floor | 5.000 | 1.000 | 2.000 | 2.000 | 1004.000 |

### Four things to know

**A rate under the floor is not an error.** It is ignored and the floor is charged. A maker
cannot undercut the protocol by signing small, and cannot be surprised by signing large.

**The sink can be starved, and only the owner can do it.** `protocolShare = 0` sends an intent's
whole net fee to its own destination. Rounding can never do it: the rebate is capped below one,
so something is always left, and the sink's share rounds up.

**A named destination is guaranteed a fifth** of any fee big enough to divide, because
`protocolShare` is capped at 80%. At one wei of fee the rounding hands that wei to the sink and
the destination is not named at all — one transfer, not two.

**A fee never rounds to nothing** while the rate and the delivery are both positive: `ceilDiv`
guarantees at least one wei. The only zero-fee fill is a zero rate, which needs the owner's floor
at zero and a maker asking for nothing.

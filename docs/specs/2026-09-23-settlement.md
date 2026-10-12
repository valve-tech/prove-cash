# The settlement: intended behaviour

**Status: Proposed.** The owner approves. Written 2026-09-23 against `ce37983`.

**Built since (2026-09-23):** the fee-sink rules FE-6 to FE-10 in `4d48379`, and the fixes for
B-1 (`4d48379`) and B-2 (`64224af`). §14 names the tests and §15 the gaps that remain. The rest
of this document is still Proposed.

**Changed 2026-10-01 (owner decision):** the default-sink exception is gone. An intent with
`feeTo = 0` pays no fee, and `defaultFeeSink` is a sign-time pointer that no fill reads. See §1
promise 2, PX-5, FE-8, OW-1 and OW-2.

This document states what `contracts/src/ProveSettlement.sol` MUST do, what it MUST NEVER do, and
why. It is normative. The code is checked against it, not the other way round. When the two
disagree, one of them is wrong, and the owner decides which.

It is not a code tour. Each rule names the threat it stops or the promise it keeps. Each rule that
came from a decision cites where the decision was recorded. A rule that nobody recorded is an
**OPEN QUESTION (owner)**, with the options. I did not promote current code to intent without a
record.

## How to read this

- **MUST**, **MUST NOT**, **SHOULD** and **MAY** mean what RFC 2119 says.
- Each rule has an ID, such as `SI-3`. The traceability table uses the IDs.
- Code is cited by symbol: `_termsOk`, `minOutAt`, `Reason.BadTerms_`. Line numbers rot, so this
  document has none.
- "Recorded:" names the place a decision was written down: a spec, a commit, a doc, or NatSpec.
- `FEE-MODEL.md` is the authority for who gets what from a fill. This document states only the
  invariants of that model and refers to it for the rest.
- `2026-09-23-fee-sink-fixed-destination.md` (Approved) is the authority for fee sinks. This
  document repeats its rules as MUSTs and does not add to them.

## 1. The promise

A maker signs terms off chain: "take up to `amountIn` of token A, deliver at least the signed
minimum of token B". Anyone may execute them. The settlement makes four promises.

1. **The maker gets at least what they signed, or nothing moves.** No fill pays the maker less
   than the curve asks, less the fee the maker signed.
2. **Nothing decided after signing reaches a signed offer.** No owner, solver, or later
   configuration can change the price, the rate, or where the fee goes. There is no exception:
   an intent with `feeTo = 0` pays no fee, and no setting can give it one (OW-2).
3. **The maker's money leaves only through the maker's own intent or back to the maker.**
4. **prove.cash earns nothing from a fill.** The settlement holds no rate and takes no share.

Recorded: `2026-08-26-neutral-protocol.md` §"The decision" ("prove.cash takes no fee ... it earns
nothing from a fill"); commit `84e8895` ("The contract reads them and pays that address. It cannot
raise the rate, lower it, or take a cut on the way"); commit `a7c5d7f` ("nothing decided later
reaches an offer you have already signed"); `2026-09-23-fee-sink-fixed-destination.md` §"The rule".

---

## 2. The signed intent

### 2.1 The type

`INTENT_TYPEHASH` is the authority. It has seventeen members, in this order:

```
Intent(address maker,address recipient,address tokenIn,address tokenOut,uint256 amountIn,
uint256 minOutStart,uint256 minOutEnd,uint64 startTime,uint64 endTime,address executor,
address feeTo,uint64 feeRate,uint256 minFill,bytes32 authNonce,uint8 flags,uint256 nonce,
bytes32 curve)
```

| # | Field | Meaning | Unit | Bound (`_termsOk` unless noted) |
|---|---|---|---|---|
| 1 | `maker` | The signer, and the account token A leaves | address | Must sign (§2.3) |
| 2 | `recipient` | Where token B lands | address | Not the settlement, not the relayer |
| 3 | `tokenIn` | Token A, leaving the maker | ERC-20 | Not equal to `tokenOut` |
| 4 | `tokenOut` | Token B, arriving | ERC-20 | Not equal to `tokenIn` |
| 5 | `amountIn` | The most token A this intent will ever release | raw units of A | `<= type(uint128).max` |
| 6 | `minOutStart` | Token B owed for the whole `amountIn` at or before `startTime`. The ceiling of the curve | raw units of B | `<= type(uint128).max` |
| 7 | `minOutEnd` | Token B owed for the whole `amountIn` at or after `endTime`. The floor of the curve | raw units of B | `<= minOutStart` |
| 8 | `startTime` | Not fillable before this instant | unix seconds | None (§2.4) |
| 9 | `endTime` | Not fillable at or after this instant. The expiry | unix seconds | None (§2.4) |
| 10 | `executor` | The only address that may fill. Zero means anyone | address | None |
| 11 | `feeTo` | The fee sink this intent pays. Zero means no fee | address | Zero, or a registered sink at any rate (FE-8) |
| 12 | `feeRate` | The fee, as a fraction of `WAD` (1e18) of the gross | WAD fraction | `<= WAD`; zero when `feeTo` is zero; `>=` the sink's `minRate` otherwise (FE-8) |
| 13 | `minFill` | The smallest partial fill. Zero means no floor | raw units of A | None |
| 14 | `authNonce` | The EIP-3009 or Permit2 nonce that funds this intent. Zero means the intent's own hash | bytes32 | None |
| 15 | `flags` | Bit field (§2.5) | bits | ESCROW and PERMIT2 not both set |
| 16 | `nonce` | High 192 bits: lane. Low 64 bits: position in the lane | uint256 | None |
| 17 | `curve` | The shape of the price between the two ends (§2.6) | bytes32 | None |

**SI-1.** The struct and its typehash MUST grow only at the end. The `Reason` enum MUST grow only
at the end. Why: clients mirror both as wire formats, and an inserted member renames every member
after it. Recorded: NatSpec on `Intent.feeRate` ("The struct grows only at its end") and on
`Reason.FeeTooHigh_` ("Appended, never inserted. The numbers are a wire format").

### 2.2 What signing binds

**SI-2.** The digest MUST be EIP-712 over the domain `{name: "prove.cash", version: "1", chainId,
verifyingContract: this settlement}`. `domainSeparator` MUST recompute when `block.chainid`
differs from the chain it was built on. Why: a signature for one chain or one deployment must be
worthless on any other. Recorded: `2026-08-10-prove-cash-design.md` §5.1.

**SI-3.** The signature binds every one of the seventeen members, including bytes of `curve` that
the chosen kind does not read. Nothing outside the digest MAY change what a fill pays, releases,
or charges. `filled` and `cancelledAt` MUST be keyed by the digest. Why: promise 2 in §1.

**SI-4.** A redeploy moves the domain separator. Every standing signature MUST die with the old
deployment, and none MAY be read by the new one. Recorded:
`2026-09-03-the-signed-intent-before-mainnet.md` §"The window, and what it actually is"; NatSpec
on `KIND_KNOTS`.

### 2.3 The signature

**SI-5.** A 65-byte signature MUST be tried with ECDSA first. A signature that does not recover to
`maker`, or has another length, MUST fall through to ERC-1271 when `maker` has code. The ERC-1271
call MUST be gas-capped and MUST read a whole word, so a wallet that answers badly reads as "did
not sign" and never reverts a batch. Why: contract wallets must be able to make offers, and a
hostile maker must not burn a solver's gas. Recorded: commit `0c1766e`; NatSpec on
`_validSignature`.

**SI-6.** The signature MUST NOT be part of the digest. Two encodings of one signature then fill the
same `filled[h]`, so signature malleability cannot double a fill. Not recorded as a decision; it
is what INV-3 needs.

### 2.4 Terms no clock and no caller can rescue: `_termsOk`

`_termsOk` reads only the intent and fee-sink storage. An intent that fails it is dead against
every caller at every time, and every reader says `Reason.BadTerms_`.

**SI-7.** `_termsOk` MUST refuse:

| Refusal | Threat |
|---|---|
| `minOutEnd > minOutStart` | A curve with no readable ceiling and floor; `minOutAt` would underflow |
| `tokenIn == tokenOut` | A callback pays the maker with the maker's own money |
| `minOutStart` or `amountIn` above `uint128` | `_quote` overflows into a panic, which `skipInvalid` cannot step over |
| `feeRate > WAD` | `fee > gross`, and `gross - fee` panics |
| `FLAG_ESCROW` and `FLAG_PERMIT2` both set | The branch order in `_armLeg` would decide which of the maker's signatures a solver spends |
| `recipient` or `feeTo` is the settlement or the relayer | Money sent there reaches no named party and has no rescue path |
| `feeRate > 0` and `feeTo` is not a registered sink, or `feeRate` is below that sink's `minRate` | §4 |

Recorded: NatSpec on `_termsOk`; commit `d1dd385` (the `WAD` rule); commit `383cb64` (an intent
that pays an address it cannot leave); `2026-09-23-fee-sink-fixed-destination.md` §"Terms check".

**SI-8.** `_termsOk` MUST NOT bound the window's length or how far ahead it opens. Why: a stale
wallet-rung signature costs only the maker who signed it, and a rule that overrides a signed term
is what the settlement claims not to be. The app carries the ceiling as advice. Recorded: commit
`a7c5d7f` ("the maker decides how long their own signature stands"); `AUDIT-SCOPE.md` §6.8.

**SI-9.** `_termsOk` MUST NOT clamp a bad term into a good one. It refuses. Why: a clamp of `fee`
to `gross` pays the maker zero in silence. Recorded: NatSpec on `_termsOk`; `AUDIT-SCOPE.md` §6.8.

**OPEN QUESTION (owner) OQ-1: terms `_termsOk` does not check.** Nothing records a decision on
these, and I will not promote the current behaviour to intent:

- `recipient == address(0)`. Today it passes `_termsOk`. The fill then reverts inside most tokens'
  transfer, as an ERC-20 error, not as a `Reason`. A strict batch dies on it.
- `amountIn == 0`. Today it passes. Every take reads `TooMuch` or `NothingToFill`. It is dead but
  says the wrong reason.
- `endTime <= startTime`. Today it passes. It reads `NotStarted` then `Expired`, and never fills.
- `minFill > amountIn`. Today it passes and acts as all-or-nothing.

Options:

- (a) Refuse each in `_termsOk`, so every reader says `BadTerms_`.
- (b) Accept them, and write down that the app refuses them.
- (c) Refuse `recipient == 0` only. It is the one that turns a reason into a revert that kills a
  batch.

### 2.5 Flags

| Bits | Value | Name | Meaning |
|---|---|---|---|
| 0 | 1 | `FLAG_PARTIAL` | Partial fills allowed |
| 1 | 2 | `FLAG_ESCROW` | Token A is held in the settlement against this intent (§5) |
| 2 | 4 | `FLAG_PERMIT2` | Token A is reached through a Permit2 signature (§5) |
| 3-4 | 8, 16 | `FLAGS_CURVE_KIND` | The curve kind: 0 linear, 1 stretch, 2 and 3 reserved |
| 5-7 | 32, 64, 128 | — | Spare |

A note on the count: `flags` is a `uint8`. Five bits are in use, so **three** bits are spare, not
six.

**SI-10.** An intent MUST carry at most one custody flag (see SI-7).

### 2.6 Curve kinds

**SI-11.** Kind 0 (`KIND_LINEAR`) MUST walk the straight line from `minOutStart` to `minOutEnd`.
Kind 1 (`KIND_STRETCH`) MUST read only bytes 0-3 of `curve`, and its all-zero word MUST price
exactly as kind 0. Recorded: `2026-09-03-the-signed-intent-before-mainnet.md` Part 1 §"The
recommendation"; NatSpec on `_stretchAt`.

**SI-12.** A byte of `curve` that the chosen kind does not read MUST NOT change the price. The
settlement MUST NOT refuse an intent for such bytes. Why: they are signed and hashed, so nothing
can rewrite them, and a rule would spend gas on every fill to refuse a waste that falls on the
signer alone. Recorded: NatSpec on `Intent.curve`.

**SI-13.** Reserved kinds 2 (`KIND_KNOTS`) and 3 (`KIND_CUBIC`) MUST price as the straight line
and MUST NOT be refused. A later deployment MAY implement them. It cannot read a signature made for
this one, because a redeploy moves the domain separator (SI-4). Recorded:
`2026-09-03-the-signed-intent-before-mainnet.md` Part 1 §"The recommendation" ("Document knots as
kind 2 and the cubic as kind 3, for a later redeploy to add without touching the format") and
§"The shape of the proposal" ("A kind reads only the bytes it names ... No validation rule, no
gas"); built in `78e0ef4`; NatSpec on `KIND_KNOTS`.

**OPEN QUESTION (owner) OQ-2: the three spare flag bits.** Nothing records what the contract must do
with bits 5-7. Today it ignores them: they change no behaviour, and they are signed and hashed.
Two documents only mention them as free (`2026-08-12-hooks-design.md` §6.4; the delegation spec
Part 7, "three are free"). The hazard: a client that sets a bit expecting a future meaning gets
today's meaning and is not told. Options:

- (a) Ignore them, as today. Keeps the bits free for a later deployment with no cost now.
- (b) Refuse them in `_termsOk` as `BadTerms_`. One comparison per leg, including skipped legs.
  A client learns at once.

I lean to (a) for consistency with SI-12 and SI-13: an unread signed byte costs only its signer.
A related note on SI-13: a maker whose client thinks it signed a knot curve gets a line and is not
told. The spec that built kind 1 accepted that.

---

## 3. Price and fee arithmetic

`docs/FEE-MODEL.md` is the specified model: Part 1 (the table), Part 2 (each quantity), Part 4
(what bounds each). This section states its invariants only.

### 3.1 The formulas

```
minOutAt(i, ts) = the curve's minimum for the whole amountIn, at ts
gross           = ceilDiv(take × minOutAt(i, now), amountIn)
fee             = floor(gross × rateOf(i) / WAD)
delivered       = gross − fee
```

**PX-1.** `minOutAt` MUST be a pure function of the intent and the clock. No caller, balance,
venue or oracle MAY reach it. Recorded: NatSpec on `minOutAt`;
`2026-09-03-the-signed-intent-before-mainnet.md` Part 1 §"The invariant every option here
protects".

**PX-2.** `minOutAt` MUST stay inside `[minOutEnd, minOutStart]` for every kind and every instant.
It MUST be `minOutStart` at or before `startTime`, `minOutEnd` at or after `endTime`, and
`minOutStart` throughout when the two ends agree. Why: a client can draw the axes before it reads
the shape, and a flat intent is flat under every kind, which `RfqVenue`'s mirror check relies on.
Recorded: NatSpec on `minOutAt` and `_stretchAt`.

**PX-3.** The filler's whole outlay MUST be `gross`, at every rate. The fee MUST come out of the
maker's number, not on top of it. `delivered + fee == gross` exactly. Why: a rate that entered
the solver's fill condition made a decaying offer fill later and lower, and the maker paid for it
invisibly. Recorded: commit `d1dd385` ("The rate is now the only thing that reaches the maker's
proceeds, and it must never reach the outlay"); `FEE-MODEL.md` Part 3.

**PX-4.** Rounding MUST favour the maker on both halves. `gross` rounds up, so a partial fill never
shorts the curve. `fee` rounds down, so the dust of the split stays with the maker. Recorded:
commit `d1dd385` ("`fee` floors and `delivered` is the remainder, so the dust stays with the
maker"); `AUDIT-SCOPE.md` §6.10 (E-5 partly reopened, on purpose). The consequence is accepted: a
small enough fill at a small rate pays no fee.

**PX-5.** `_evaluate` and `_quote` MUST read the rate through one function (`_rateOf`), so the rate
checked against `maxFeeRate` and the rate charged are one number. Recorded: commit `3be2f81`
("the skip decision and the charge agree by construction"); NatSpec on `_rateOf`.

`_rateOf` MUST fold `feeTo == 0` to a zero rate, and MUST read nothing but the intent. Under FE-8
an intent with `feeRate > 0` and `feeTo == 0` is `BadTerms_`, so the fold changes nothing for an
intent that can fill. It decides what `rateOf` reports for such an intent: zero. No fill and no
view MAY read `defaultFeeSink` (OW-2).

**PX-6.** Under the bounds of SI-7 no pricing function MAY overflow or underflow. A term that
would panic MUST be refused as `BadTerms_` before any money moves. Why: a panic is not a `Reason`,
so `skipInvalid` cannot step over it and one signature kills a batch. Recorded: NatSpec on
`_quote`, `_stretchAt` and `_termsOk`.

**PX-7.** `quote` and `minOutAt` price the terms they are given and validate none of them. They
MAY panic on terms `_termsOk` refuses. A caller who wants a verdict MUST ask `fillability`.
Recorded: NatSpec on `quote` and `minOutAt`.

---

## 4. Fees

The authority is `2026-09-23-fee-sink-fixed-destination.md` (Approved 2026-09-23). The rejected
split design (`2026-09-23-fee-sink-registry.md`, commit `ad661e0`) is not intended behaviour and
this document does not describe it. The code at `ce37983` still carries that design's revocable
allowlist; §16 B-1 says where it differs.

The owner's words, recorded in that spec: "we need one destination, we need 1 sink per intent";
"the fees can never be updated after the fact without also being checked by the fee sink"; "a fee
sink should be linked to a destination for all time". Earlier, in commit `d49dbf8`: "no rebate
shit. just fees. that is all we care about."

### 4.1 Book, then claim

**FE-1.** A fill MUST pull the fee from the filler to the settlement itself and book it in
`_pendingFees[feeTo][token]`. A fill MUST NOT transfer to, or call, `feeTo` or its destination.
Why: an address the maker chose must never revert, grief or reenter a fill. Before booking, a
destination that refused the token took the whole fill down and the maker got nothing. Recorded:
`2026-09-03-the-signed-intent-before-mainnet.md` Part 2 §"Book the fee, do not transfer it
(#122)"; commit `36701c9`; the fixed-destination spec §"Terms check" ("The settlement still makes
no call to `feeTo` inside a fill").

**FE-2.** `_payFee` MUST book what arrived, measured as a balance change, not the nominal fee.
Why: a token that taxes its own transfer delivers less, and booking the nominal number
over-credits the destination and makes the sweep under-report. Recorded: commit `4f67e4d`.

**FE-3.** A booked fee MUST NOT be reachable by the owner, the maker, the filler, `withdraw`,
`park`, or `sweepUnowned`. The only way out is `claim`. Recorded: NatSpec on `_pendingFees` ("A
booked fee is not a reservation and `withdraw` cannot reach it") and on `sweepUnowned`.

**FE-4.** `_pendingFees` and `_totalPendingFees` MUST move together, by the same amount, at every
site. Recorded: NatSpec on `_totalPendingFees`; commit `36701c9`.

**FE-5.** A batch MAY coalesce fees that share a token and a sink into one pull. It MUST NOT
change the amount any sink is booked. Recorded: NatSpec on `fillBatch` and `_accrue`.

### 4.2 Fee sinks

**FE-6.** A fee sink is an immutable record: one non-zero `destination` and one `minRate` in
`[0, WAD]`. It has no owner and no setters. Recorded: fixed-destination spec §"`FeeSink` — an
immutable record".

**FE-7.** The settlement is the registry. `registerFeeSink` (owner only) MUST read the sink's
`destination` and `minRate` once, store a copy, and refuse a sink that is already registered, has
no code, or reports a zero destination. There MUST be no unregister, and no path that changes a
registered sink's destination or rate. Why: switching a sink off bricks every signed intent that
names it, and changing its destination redirects a fee the maker already signed. Recorded:
fixed-destination spec §"Registry — in the settlement, append only" ("There is **no
unregister**").

**FE-8.** `_termsOk` MUST apply these fee rules, and the fill MUST charge exactly what they say:

| The intent signs | The fill |
|---|---|
| `feeTo = 0`, `feeRate = 0` | no fee: `fee = 0`, `delivered = gross` |
| `feeTo = 0`, `feeRate > 0` | refused (`BadTerms_`): a signed rate is never silently dropped |
| `feeTo` = a registered sink, `feeRate >= minRate` | pays that sink, at the signed rate |
| `feeTo` = a registered sink, `feeRate < minRate` | refused (`BadTerms_`) |
| `feeTo` = any unregistered address, any rate (zero included) | refused (`BadTerms_`) |

The check MUST read storage only, so the settlement makes no external call to `feeTo` in a fill
(FE-1). It MUST NOT read a sink's `retired` flag or `defaultFeeSink`. Why: every fee term is fixed
at signing (OW-2). An unregistered `feeTo` at rate zero is refused rather than ignored, because
a stray address in a signed term is a client bug, and a refusal says so before any money moves.
Recorded: fixed-destination spec §"Terms check"; review L-2 of 2026-09-30, closed here by matching
the spec to the code.

**FE-9.** One fee MUST go to one sink. The settlement MUST NOT divide a fee. Recorded:
fixed-destination spec §"Several destinations" ("One fee is never divided").

### 4.3 Claim

**FE-10.** `claim(sink, token)` MUST be callable by anyone. It MUST pay the booked amount to
`feeSinks[sink].destination`, zero the book before the transfer, and hold the reentrancy guard.
The caller MUST decide nothing but the timing. Why: destinations are buy-and-burns and frontend
sinks that never send a transaction, so a claim only they could call is a claim nobody calls.
Recorded: fixed-destination spec §"Claim"; `2026-09-03-the-signed-intent-before-mainnet.md` Part 2
§"Who may call it: anybody, pushing to the recorded address".

**FE-11.** `claim` MUST return zero, and move nothing, when the book is empty. Why: a keeper
calls it for destinations that may owe nothing. Recorded: NatSpec on `claim`.

**FE-12.** A destination that cannot receive its token has a `claim` that always reverts, and its
book stays unreachable. That is accepted. Recorded: NatSpec on `claim`; `AUDIT-SCOPE.md` §6.9.

**OPEN QUESTION (owner) OQ-3: `claim` for an unregistered address.** The fixed-destination spec
delegates this to the implementation. The options are to pay the address as master does, or to
refuse it if no such balance can exist on a fresh deploy. I list it so the answer lands in this
spec. On a fresh
deploy with FE-8 in force, no unregistered address can ever be booked, so a refusal costs nothing.
I recommend the refusal, stated in a comment, and a test that no booking path reaches an
unregistered key.

---

## 5. Custody rungs

Five rungs back an intent. Only escrow commits a token before the fill. The three gasless rungs
are permissions the maker can defeat by spending the balance first, so the transfer at fill time
decides. Recorded: the `ProveSettlement` header; `AUDIT-SCOPE.md` §4 "The five custody rungs".

**CU-1.** No allowance MAY live on the settlement. Every `transferFrom` MUST go through
`ProveRelayer.pull` or `ProveRelayer.pullWithPermit2`, and only the settlement MAY call the
relayer. Makers approve the relayer for `tokenIn`; fillers approve it for `tokenOut`. Why: the
settlement calls addresses it did not choose, and an allowance reachable from such a call is
spendable by anyone (Transit Swap 2022, CoW 2023). Recorded: the header's rule 3 ("Rule 3 has no
exception, and that is the point of it"); `AUDIT-SCOPE.md` §4 "Why the relayer holds the
allowances".

**CU-2.** The settlement MAY call an address it did not choose only through a selector it chose.
No call site MAY take a selector or a calldata blob from a caller. Recorded: the header's rule 1.

**CU-3.** No call site MAY target the relayer or the settlement itself (`callableTarget`). Recorded:
the header's rule 2.

| Rung | Flag | Who moves token A, and when | What the maker can lose at worst |
|---|---|---|---|
| Approval | none | The relayer pulls `take` from the wallet at each fill | A fill at the signed price, up to `amountIn`. Revoking the allowance does not cancel the signature, and re-approving revives it (CU-7) |
| EIP-2612 permit | none | The filler's call turns the permit into a relayer allowance; then as approval | As approval. The permit sets a reusable allowance, which can outlive the intent |
| EIP-3009 | ESCROW | The token moves the whole `amountIn` into escrow at the first arming, whatever the take | As approval, and a small first take locks the whole `amountIn` in escrow until it fills or the maker withdraws. `minFill` prices this; it does not stop it (FP-4) |
| Permit2 | PERMIT2 | Permit2 moves up to `amountIn` into escrow at the first arming | As EIP-3009 |
| Escrow | ESCROW | The maker, or anyone, deposits in advance; parked capital can fund it at fill (CU-19) | A fill at the signed price, up to `amountIn`. An unfunded escrow signature can be funded from the maker's parked capital (CU-21) |

On every rung the worst case has the same ceiling: the intent fills at the price the maker signed,
for no more than `amountIn`. No rung lets a fill pay less than the curve. Escrowed money is
always the maker's until it fills.

### 5.1 Approval and EIP-2612

**CU-4.** On the wallet rungs `_release` MUST pull `take` from the maker through the relayer.
Recorded: NatSpec on `_release`; the header's rule 3.

**CU-5.** `_grantAllowance` MUST call `permit` only when the relayer's allowance is below `take`.
Why: anyone can front-run the permit from the mempool, and the front-runner's copy must satisfy
the fill rather than revert it. Recorded: NatSpec on `_grantAllowance`.

**CU-6.** `fillWithPermit` MUST refuse an intent carrying `FLAG_ESCROW` or `FLAG_PERMIT2`.
`fillWithAuthorization` MUST refuse an intent without `FLAG_ESCROW`, and `fillWithPermit2` one
without `FLAG_PERMIT2`. Why: a permit must never fund a stronger rung, and no door may spend a
signature meant for another. Recorded: NatSpec on `fillWithPermit` and `_armLeg`.

**CU-7.** Revoking an allowance does not cancel a signature. Re-approving revives every signature
still inside its window. This is accepted. Recorded: commit `a7c5d7f`;
`AUDIT-SCOPE.md` §6.11.

### 5.2 Escrow: deposit and withdraw

**CU-8.** Escrow MUST be committed to one intent hash, never pooled. `_evaluate` MUST read
`_reserved[h]` and nothing else for a custodied rung. Why: with pooled escrow a maker who saw a
fill in the mempool could sign a second intent paying themselves a worthless token and walk the
funds out. Recorded: NatSpec on `_reserved`.

**CU-9.** `deposit` MUST take the full intent, not its hash, so the preimage decides `maker` and
`tokenIn`. Anyone MAY deposit. `deposit` MUST credit what arrived, not what was asked. `deposit`
MUST refuse a cancelled intent. Why: a digest would let the first caller decide the owner of a
reservation; a cancelled intent refunded by a stranger would come back to life. Recorded: NatSpec
on `deposit`.

**CU-10.** `withdraw` MUST be callable only by `maker`. It MUST pay the whole reservation to the
maker in one call, with no cooldown, and it MUST cancel the intent (write `cancelledAt` if not
already set). Why: `deposit` is permissionless, so an emptied hash could be refunded by a stranger
and an abandoned signature would fill months later; "withdrawn means withdrawn". Recorded: commit
`e6a1c81` ("The owner's model, and it is the right one. An escrow intent is armed by its deposit.
Withdrawing undoes that action, so it should undo the offer"); commit `66c43fa` on the cooldown ("The
owner's argument, which is right ... the wait was charging every maker for a risk an executor can
decline"); NatSpec on `withdraw`. Verified in the code: `withdraw` pays and cancels in one call.

**CU-11.** A donation (a plain transfer to the settlement) MUST NOT fund an intent. Only `deposit`,
a redeemed authorization, a spent Permit2 signature, or a draw from the maker's own parked capital
MAY credit a reservation. Recorded: NatSpec on `sweepUnowned`.

### 5.3 EIP-3009 and Permit2

**CU-12.** An authorization MUST be redeemed with `receiveWithAuthorization`, never
`transferWithAuthorization`. Why: the latter is a permissionless relay, and anyone holding the
board's copy could push the tokens in with nothing credited, spending the maker's nonce for
nothing. Recorded: commit `4c1d7ba`; NatSpec on `_receive`.

**CU-13.** The funding nonce MUST be `authNonce`, or the intent hash when `authNonce` is zero. A
Permit2 transfer MUST name `tokenIn` as its token. Both checks MUST run before the token or
Permit2 is called. Why: one signature funds one offer, and two offers naming one nonce are
mutually exclusive. Recorded: commit `3960d16`; NatSpec on `Intent.authNonce` and
`_pullPermit2In`.

**CU-14.** The first arming of a Permit2 leg MUST draw up to `amountIn` into the reservation, not
only `take`. Why: a Permit2 nonce is single-use; drawing `take` alone left the rest of a partial
intent unreachable. Recorded: commit `42aee0a`; NatSpec on `_pullPermit2`.

**CU-15.** A redemption and a Permit2 draw MUST credit the measured balance change. A balance read
that fails MUST refuse the arming. Recorded: NatSpec on `_held` and `_pullPermit2`.

**CU-16.** The authorization's own window (`validAfter`, `validBefore`) and the intent's window are
not reconciled on chain. This is accepted. Recorded: `AUDIT-SCOPE.md` §6.8.

### 5.4 Parked capital

**CU-17.** `park(i)` MUST move a reservation to `_parked[maker][tokenIn]` only when the intent is
dead: `endTime` has passed, it is cancelled, or the maker's lane floor retired its nonce. It MUST
refuse a live intent. It MUST cancel the intent if not already cancelled. Anyone MAY call it. Why:
it has no destination to point, because both keys come from the signed preimage. Recorded: commit
`8b7d92a`; commit `1844073` (the floor as the third door); NatSpec on `park`.

**CU-18.** `withdrawParked(token)` MUST pay only `msg.sender`'s own row, and MUST revert on an
empty row. Why: a maker asking about their own money must learn that their token argument was
wrong. Recorded: NatSpec on `withdrawParked`; commit `8b7d92a`.

**CU-19.** No fill MAY read `_parked`. Parked capital MUST back no offer until an arming call with
`ARM_FROM_PARKED` moves it into `_reserved[h]` inside the transaction that spends it. The draw MUST
be the shortfall (`take − reserved`), never the pot, and all of it or none. Recorded: commit
`8b7d92a`; NatSpec on `_drawFromParked`.

**CU-20.** `ARM_FROM_PARKED` MUST refuse an intent whose `authNonce` is set. Why: parked capital
spends no nonce, so it would fund both of two offers the maker made mutually exclusive. Recorded:
commit `8b7d92a`; `AUDIT-SCOPE.md` §6.11.

**CU-21.** An unfunded escrow signature is not inert. A solver may fund it from the maker's parked
capital. `cancel` and `invalidateBefore` are the only off switches. This is accepted and MUST be
disclosed wherever the app speaks of escrow. Recorded: commit `8b7d92a` ("It is a decision, not
an oversight"); `AUDIT-SCOPE.md` §6.11; NatSpec on `FLAG_ESCROW`.

### 5.5 Arming a batch leg

**CU-22.** `FillRequest.arming` MUST be read according to the intent's flags alone: a
`Permit2Transfer` for PERMIT2, an `Authorization` or the one word `ARM_FROM_PARKED` for ESCROW, a
`Permit` for neither. A 32-byte ESCROW arming that is not `ARM_FROM_PARKED` MUST be refused.
Recorded: NatSpec on `FillRequest.arming`, `ARM_FROM_PARKED` and `_redeemInto`.

**CU-23.** Arming in a batch MUST run in its own call frame (`armLeg` via `try this.armLeg`). A leg
that cannot be armed MUST leave nothing behind: no spent nonce, no moved token. It MUST come back
`EscrowShort`, whatever reason it walked in with. Why: without the frame, a taxed token burns a
maker's authorization and costs a solver a whole batch. One posted signature could do that for
ever. And a leg kept at `Ok` went on to die inside the token's own `transferFrom`. Recorded:
commit `1daa379` ("Arming runs inside its own frame, through try this.armLeg"); commit `2b4d869`
(a leg that could not be armed says so); NatSpec on `armLeg` and `_arm`.

**CU-24.** `armLeg` MUST refuse every caller but the settlement itself. Recorded: NatSpec on
`armLeg`.

**CU-25.** After arming, the whole leg MUST be re-evaluated deep, signature included. Why:
`_evaluate` reads funds before the signature. So a leg can read `EscrowShort` while its signature
is worthless. Arming it would spend a real authorization on an intent that can never fill.
Recorded: NatSpec on `_armLeg`.

---

## 6. Nonces, lanes and cancellation

**CN-1.** `cancel(i)` MUST be callable only by `maker`, and MUST take effect in the block it lands,
on every custody rung. Recorded: commit `66c43fa` ("cancel's escrow branch gone; immediate on every
custody mode"); NatSpec on `cancel`.

**CN-2.** `invalidateBefore(floor)` MUST read `floor` as a nonce: high 192 bits the lane, low 64
bits the position. It MUST raise that lane's floor for `msg.sender` and no other lane. It MUST
refuse a floor that does not rise. It MUST take effect at once. Why: a maker who groups
signatures by lane retires one group with one write. Recorded: commit `1844073`
("`invalidateBefore` keeps its single `uint256` argument"; the top-lane price "is stated rather
than hidden").

**CN-3.** A nonce is dead when its position is below its lane's floor. `_evaluate`, `available`
and `park` MUST share one reading (`_retired`). Recorded: NatSpec on `_retired`.

**CN-4.** A lane floor MUST only rise. A signature it kills MUST never come back. Recorded:
NatSpec on `invalidateBefore` ("Monotonic per lane").

**CN-5.** The top position of a lane (`type(uint64).max`) cannot be retired by a floor, only by
`cancel`. This is accepted and measured. Recorded: NatSpec on `_laneFloor`; commit `1844073`.

**CN-6.** Nonces are not a counter. Fills MUST be possible in any order. Why: makers post many live
signatures and solvers fill them as they find them. Recorded: NatSpec on `_laneFloor`.

**What replaced §5.3 of the 2026-08-10 design.** That section's correction gave `cancel` and
`invalidateBefore` an `effectiveAt` one `UNLOCK_COOLDOWN` out for escrow intents. Commit
`66c43fa` (2026-08-13) removed the cooldown and everything it needed: `requestUnlock`, `unlockAt`,
`WITHDRAW_WINDOW`, `NonceFloor.effectiveAt`, and `cancel`'s escrow branch. The owner's argument,
recorded in that commit: every shipped fill path settles in one transaction, so the only executor
the cooldown protected is one who chose the worse strategy. What replaced it: `cancel`,
`invalidateBefore` and `withdraw` all bite at once (CN-1, CN-2, CU-10). The F-4 audit finding is
marked withdrawn, not fixed (`AUDIT-SCOPE.md` §6.6).

**OPEN QUESTION (owner) OQ-4: `cancelledAt` is a time, but no time but "now" is ever written.**
The mapping stores a timestamp and `_evaluate` compares `block.timestamp >= c`. Every writer
(`cancel`, `withdraw`, `park`) writes `block.timestamp`, so the comparison is always true once set.
The shape is a leftover of `effectiveAt`. Options: (a) keep it as is, and record that a future
delayed cancel needs no storage change; (b) at the next redeploy, make it a `bool` and drop the
comparison. The ABI name `cancelledAt` is read by the app, so (b) is a client change too.

---

## 7. Fill paths

### 7.1 One validator

**FP-1.** Every fill path and every reader MUST decide fillability with the one function
`_evaluate`. A single fill MUST turn a `Reason` into a revert; a skipping batch MUST turn it into a
skip. Why: the batch, the single fill and the view must never disagree. Recorded:
`2026-08-10-prove-cash-design.md` §8.5; NatSpec on `Reason`.

**FP-2.** `filled[h]` MUST never exceed `amountIn`. Recorded: `2026-08-10-prove-cash-design.md`
§5.1 ("maximum of token A this intent will ever release"). Safety against a reentrant token rests
on `nonReentrant` on every fill door and on `armLeg`'s caller check (`msg.sender == address(this)`),
not on the order of writes. The order of writes is not a recorded decision and MUST NOT be relied on.

**FP-3.** A leg MUST satisfy, in addition to SI-7:

- `take > 0`;
- `startTime <= now < endTime`;
- `executor == 0` or `executor == msg.sender` (the exclusive executor);
- `rateOf(i) <= maxFeeRate`;
- the nonce is above its lane floor and the intent is not cancelled;
- `take <= amountIn − filled`;
- without `FLAG_PARTIAL`, `take == amountIn − filled`;
- `take >= minFill`, unless `take` closes the intent;
- the maker's funds cover `take`;
- the signature is valid.

**FP-4 (`minFill`).** A take equal to what remains MUST always pass the floor. Why: otherwise a
floor of 30 on 100 strands the last 10 for good. `minFill` prices a griefing draw of a gasless
maker's whole balance into escrow; it does not prevent one. Recorded: commit `0c1766e`; NatSpec on
`Intent.minFill`.

**FP-5 (`maxFeeRate`).** `maxFeeRate` MUST bound the rate of the fee destinations a fill touches,
not the filler's outlay. The fee comes out of the maker's number, so the rate costs the filler
nothing. A filler who wants no part of a fee destination passes zero and skips every leg that
names one. It MUST be decided in `_evaluate`, where a batch can still skip. Recorded: commit
`d1dd385` ("they are the filler's only switch for 'do not engage with a fee destination at all'");
`2026-09-03-the-signed-intent-before-mainnet.md` Part 2 §"Is `maxFeeRate` dead? No. Keep it." (its
meaning moves "from 'the highest fee I will pay' to 'the highest rate whose destination I will
engage with'"); NatSpec on `fill`. Verified in the code: `_evaluate` compares
`_rateOf(i) > maxFeeRate`, and the outlay is `gross` at every rate.

**FP-5a (exclusive executor).** When `executor` is non-zero, only that address MAY fill, on every
path, and `fillability` MUST answer for the `executor` argument it is given. Recorded:
`2026-08-10-prove-cash-design.md` §5.1 ("address(0) = anyone may fill").

### 7.2 The doors

| Function | What it does | Guard |
|---|---|---|
| `fill` | Validate (shallow), book, release token A to the caller, pull `delivered` to the recipient, pull the fee to the settlement | `nonReentrant` |
| `fillBatch(reqs, skipInvalid, maxFeeRate)` | Each leg as `fill`; fees coalesced per (token, sink) run; arming per leg | `nonReentrant` |
| `fillWithCallback` | Validate, book, release token A to the caller, call `proveCallback` on the caller, then pull `delivered` and the fee | `nonReentrant`, `callableTarget` |
| `fillBatchWithCallback` | Every leg released first, one `proveBatchCallback` on the caller with one line per surviving leg, then every payment pulled | `nonReentrant`, `callableTarget` |
| `fillWithPermit` | `_armLeg` with a `Permit`, then book | `nonReentrant`; wallet rung only |
| `fillWithAuthorization` | Pre-flight `_evaluate`; carry on only on `Ok` or `EscrowShort`; `_armLeg` with an `Authorization`, then book | `nonReentrant`; ESCROW only |
| `fillWithPermit2` | As `fillWithAuthorization`, with a `Permit2Transfer` | `nonReentrant`; PERMIT2 only |

**FP-6.** `skipInvalid` MUST step over every `Reason` and nothing else. A reverting token still
reverts the batch. Recorded: NatSpec on `fillBatch`; `AUDIT-SCOPE.md` §6.8.

**FP-7.** The callback paths MUST call `msg.sender` only, through a fixed selector, with the
caller's `data` as an argument. Recorded: commit `ddab838` ("The callback target is `msg.sender`
... pull the payment"); `2026-08-12-hooks-design.md` §5; the header's rule 1; NatSpec on
`fillWithCallback`.

**FP-8.** The callback paths MUST pull payment with directed transfers after the callback. They
MUST NOT infer payment from a balance change. Why: a delta reads a donation as payment and lets
two debts share one measurement (UniswapX audit). Recorded: NatSpec on `fillWithCallback` and
`fillBatchWithCallback`.

**FP-9.** Every payment to a recipient MUST be measured. A token that delivers less than `delivered`
MUST fail the fill (`Underpaid`). Why: the maker is promised an amount received. Recorded: NatSpec
on `_deliverTo`; `2026-08-10-prove-cash-design.md` §8.4.

**FP-10.** `fillBatchWithCallback` MUST tell the callback which request each line came from
(`Payment.leg`), and MUST NOT leave a zeroed line for a skipped leg. Recorded: commit `2339577`.

**FP-11.** `fillWithAuthorization` and `fillWithPermit2` MUST NOT spend a maker's signature on an
intent that is dead for any reason but `EscrowShort`. Why: a spent authorization cannot be got
back, and the token's own error hides that the intent was dead. Recorded: NatSpec on both.

**FP-12.** A recipient that is the caller cannot be settled on any path. This is accepted.
Recorded: `AUDIT-SCOPE.md` §6.8.

---

## 8. Readers

### 8.1 `Reason`, and its precedence

`_evaluate` returns the first reason that applies, in this order:

| Order | `Reason` | When |
|---|---|---|
| 1 | `BadTerms_` | `_termsOk` refuses |
| 2 | `NothingToFill` | `take == 0` |
| 3 | `NotStarted` | `now < startTime` |
| 4 | `Expired` | `now >= endTime` |
| 5 | `WrongExecutor` | an exclusive executor that is not the caller |
| 6 | `FeeTooHigh_` | `rateOf > maxFeeRate` |
| 7 | `NonceTooLow` | the lane floor retired the nonce |
| 8 | `Cancelled` | `cancelledAt` is set and in effect |
| 9 | `TooMuch` | `take` exceeds what remains |
| 10 | `PartialNotAllowed` | not partial, and `take` is not all that remains |
| 11 | `BelowMinFill_` | under `minFill`, and not the closing fill |
| 12 | `EscrowShort` | custodied: the reservation is short. Wallet, deep only: allowance or balance short, or unreadable |
| 13 | `BadSignature` | neither ECDSA nor ERC-1271 accepts |
| 14 | `TokenOutUnreadable` | deep only: `tokenOut` does not answer a capped balance read |

`Ok` is zero. The numbering is a wire format (SI-1).

**RD-1.** The checks that read only calldata or one slot MUST come before `ecrecover`. Everything a
griefer can reach without the maker's key MUST be metered (`_probe`). The `tokenOut` probe MUST
come after the signature, so only the maker's key can reach it. Recorded: NatSpec on `_evaluate`.

**OPEN QUESTION (owner) OQ-5: is the precedence normative?** Nothing records that clients may rely
on the order. It matters: `fillability` reports one reason, so the order decides what a maker is
told ("Expired" beats "Cancelled"). Options: (a) the order above is normative and a change needs a
spec change; (b) only "the first reason is a true reason" is normative.

### 8.2 The views

**RD-2. `fillability(i, sig, take, executor, maxFeeRate)`** MUST return exactly the reason a deep
batch would reach for this caller and size, for a leg with no arming bytes. It MUST NOT move money.
Recorded: `2026-08-10-prove-cash-design.md` §8.5 ("The view runs the same deep check a skipping
batch runs"); NatSpec on `fillability`. Arming is a fact about a transfer, so only `dryRun` can
answer for an armed leg (RD-3).

**RD-3. `dryRun(reqs, maxFeeRate)`** MUST walk the legs as a batch does. It MUST arm, for real,
the legs that ask for it. It MUST record one `Reason` per leg in request order, and then always
revert with `DryRun`. Nothing MAY survive it. It MUST always step over a bad leg. It MUST pay no maker, so it is
pessimistic for a maker funded by an earlier leg's delivery, never optimistic. Recorded: commit
`0d31e5a`; NatSpec on `dryRun` and `_walkLeg`; `AUDIT-SCOPE.md` §6.8.

**RD-4. `available(i)`** MUST return `remaining = amountIn − filled` and `live`. `live` MUST be
false whenever a fill would refuse on terms, time, cancellation or nonce. `live` is a ceiling: it
cannot speak for the signature, the funds, or an exclusive executor. Recorded: commit `4a4a2b7`
(`available` reads the same `_termsOk`); NatSpec on `available`.

**RD-5. `minOutAt`, `quote`, `rateOf`** MUST be pure and MUST return what a fill at that instant
charges (PX-1 to PX-7).

**RD-6.** `nonceFloor(maker)` answers lane 0; `laneFloor(maker, lane)` answers any lane.
`reserved`, `totalReserved`, `parked`, `totalParked`, `pendingFees` and `totalPendingFees` MUST
return the books as stored, so a maker can check them before a deposit. Recorded: NatSpec on
`totalReserved`.

### 8.3 What the readers do not answer

The owner asked on 2026-09-23 whether the readers tell a caller three things.

| Question | Answer today |
|---|---|
| The least a filler must pay | Yes. `quote(i, take, now)` gives `delivered` and `fee`; the sum is the outlay |
| How many tokens are left | Yes. `available(i).remaining` |
| How long until the intent dies | **No single reader.** A caller must combine `endTime` (calldata), `cancelledAt(h)`, and `laneFloor(maker, lane)`; for the gasless rungs also the authorization's `validBefore` or the Permit2 `deadline`, which the contract never sees |

**OPEN QUESTION (owner) OQ-6: a `deadline(intent)` view.** Proposed and not decided. It would
return the instant after which the intent can never fill: `endTime`, or earlier if cancelled or
retired. It would return `min(endTime, cancelledAt)`, or zero when the nonce is already retired.
Options: (a) add it at the next redeploy; (b) leave it to the SDK, which already reads all three. Note: it cannot see an authorization's `validBefore`, so it is an upper
bound on the gasless rungs.

---

## 9. `sweepUnowned` and `defaultProceeds`

**SW-1.** `sweepUnowned(token)` MUST be callable by anyone and MUST pay only `defaultProceeds`. It
MUST pay `balance − totalReserved − totalPendingFees − totalParked`, and nothing when that is not
positive. It MUST return zero rather than revert when the balance is under the books. Why: the
caller chooses the timing and nothing else, so no caller and no owner can reach a wei that belongs
to anyone. A keeper walking a list must not lose the list to one insolvent token. Recorded:
`2026-08-26-neutral-protocol.md` §"The one thing that needs a destination"; NatSpec on
`sweepUnowned`.

**SW-2.** `_reserved`/`_totalReserved`, `_pendingFees`/`_totalPendingFees` and
`_parked`/`_totalParked` MUST each move together, by the same amount, at every site. Why: a total
that drifts from its map pays somebody's money to `defaultProceeds`. Recorded: NatSpec on
`_totalReserved`, `_totalPendingFees` and `_totalParked`; commit `8b7d92a` (the third book).

**SW-3.** A sweep MUST NOT credit any reservation (see CU-11). Recorded: NatSpec on
`sweepUnowned` ("A donation still cannot pay for a fill").

**SW-4.** The gain of a positive rebase leaves for `defaultProceeds`, not the maker. This is
accepted. Recorded: `AUDIT-SCOPE.md` §6.2; NatSpec on `sweepUnowned`.

**SW-5.** `defaultProceeds` MUST be non-zero, set at construction and by `setDefaultProceeds`.
It MUST NOT be a fee destination. It is repointable, not immutable, because a buy-and-burn key can
rotate or be lost. Recorded: `2026-08-26-neutral-protocol.md` ("the owner can say where lost tokens
go, and nothing else"; "Immutable would be the stronger claim, and it is the wrong one"); NatSpec
on `defaultProceeds`.

---

## 10. The owner

**OW-1. The complete owner power set** is:

| Function | Power |
|---|---|
| `transferOwnership(next)` | Hand the owner role to a non-zero address |
| `setDefaultProceeds(to)` | Point `sweepUnowned` at a non-zero address |
| `registerFeeSink(sink)` | Add one fee sink makers may name (§4.2) |
| `retireFeeSink(sink)` | Mark a registered sink closed to new intents, one way. Advisory: no fill reads the flag (review L-1, 2026-09-30) |
| `setDefaultFeeSink(sink)` | Name the registered, unretired sink, and its `defaultRate` (`minRate <= rate <= WAD`), that clients write into NEW intents. No fill reads it (OW-2, 2026-10-01) |

There MUST be nothing else. Recorded: `2026-08-26-neutral-protocol.md` ("No pause, no upgrade, no
fee, no reach into escrow"); `AUDIT-SCOPE.md` §4 "The owner"; fixed-destination spec §"Registry".

**OW-2. The owner MUST NEVER be able to:**

- redirect the fee of a live intent that names a sink, or change any registered sink's
  destination or rate;
- remove, disable, or replace a registered fee sink;
- set, raise, lower, or share in any signed fee rate;
- touch a reservation, parked capital, or a booked fee;
- pause, upgrade, or rescue;
- change any signed term, or revive a cancelled or retired intent;
- change the fee rate or the fee destination of any signed intent, including one signed with
  `feeTo = 0`.

**There is no exception, the default included.** Every fee term of a signed intent is fixed at
signing. `defaultFeeSink` is a sign-time pointer: a client reads it and writes that sink's address
and rate into the intent as signed terms. `setDefaultFeeSink` changes only what clients sign next.
No fill and no pricing view reads it, and an intent with `feeTo = 0` pays no fee. The owner's words
(2026-10-01): "no exceptions for the default. they should all be the same. override the intent if
you need to." This revokes the exception the owner approved on 2026-09-24, under which a zero
`feeTo` paid whatever `defaultFeeSink` named at fill time, at that sink's rate (review M-1,
2026-09-30). A proof of concept (`poc/contracts-review-2026-09-30`, `d3d637c`) showed the
exception was worse than a reprice: an owner that also fills could register a sink at `WAD`, make
it the default, fill every open `feeTo = 0` intent itself, and claim the fee back. It took every
such maker's token A, escrowed principal included, for zero net cost. A regression test MUST hold
that path to a fair fill: the maker receives the whole gross and the owner's sink books nothing.

The contract names one owner address, and only that address changes the settings. Any delay is
that address's job, not this contract's. The owner's words (2026-09-24): "don't handle timelock inside of this contract. it should be enforced by the admin address", and "the only thing we need is the ability to name an address. that address is responsible for implementing time delays. that address would have exclusive access over updating the settings".

Why: each of these reaches money a maker signed away on terms they were promised. A rescue
function is an owner key over a maker's money. Recorded: `AUDIT-SCOPE.md` §6.8 "Rejected outright"
("A rescue function on any contract"); fixed-destination spec ("It can never remove one, redirect
one, or change a rate").

**OPEN QUESTION (owner) OQ-7: single-step `transferOwnership`.** Today it is single-step: one call
to a mistyped address loses the role for good. the internal risk assessment item 8 asks the owner to "Make
`transferOwnership` two-step, or accept the risk in writing". Neither has happened. Options: (a)
two-step (`transferOwnership` then `acceptOwnership`) at the next redeploy; (b) accept in writing.
Note that `transferOwnership` refuses zero, so there is also no renounce. The power set is small
(OW-1), so a lost owner strands only `setDefaultProceeds` and `registerFeeSink`.

---

## 11. Reentrancy, external calls and tokens

**SA-1.** Every function that moves a token MUST hold `nonReentrant`: `deposit`, `withdraw`,
`withdrawParked`, `sweepUnowned`, `claim`, and every fill door. `cancel`, `invalidateBefore` and
`park` MAY omit it because they call nothing and transfer nothing. `dryRun` MAY omit it because it
always reverts. `armLeg` MAY omit it because only the settlement can call it, inside a guarded
fill. Recorded: NatSpec on `park`, `armLeg`, `dryRun`.

**SA-2.** Every balance or allowance read on a token the intent named, on a batch leg's path, MUST
go through `_probe`: a gas cap (`PROBE_GAS`) and a one-word copy. This includes `_grantAllowance`.
A failed read MUST mean "no", never a revert that a skipping batch cannot step over. `deposit` is
exempt: it is a single call by the maker, and a revert there harms only that call. The arming call
itself runs under `ARM_GAS`, so an armed hostile leg costs one capped frame (L-1, 2026-09-28). Why: the intent author chose the token, so each read is a call
into code a griefer wrote; a return bomb must cost one cap. Recorded: NatSpec on `_probe`;
`test/ReturnBomb.t.sol`.

**SA-3. Fee-on-transfer tokens.** Every inbound credit MUST be the measured change (`deposit`,
`_redeem`, `_pullPermit2`, `_payFee`). Every delivery to a recipient MUST be measured and fail if
short (`_deliverTo`). The result: a taxing `tokenOut` cannot fill; a taxing `tokenIn` on the
gasless rungs cannot fill at full size. Recorded: commit `4f67e4d`; `AUDIT-SCOPE.md` §6.3.

**SA-4. USDT-shaped tokens.** Token transfers MUST go through `SafeERC20`, so a token that returns
nothing is accepted and a token that returns `false` is refused. The settlement calls no
`approve`, so USDT's "approve to zero first" rule never arises here. Recorded: commit `36701c9`
("USDT's shape is represented"); commit `20f641c` ("the matrix is the specification of which
tokens this protocol supports").

**SA-5. Rebasing tokens.** They are not supported. A negative rebase makes the escrow insolvent,
first come first served. The settlement MUST NOT use share accounting, because shares would let a
donation pay for a fill. The defence is an off-chain token allowlist. Recorded: NatSpec on
`_reserved`; `AUDIT-SCOPE.md` §6.1 and §6.7 (the allowlist does not exist yet).

**SA-6.** The settlement MUST NOT accept native currency. It has no `receive` and no payable
function. Recorded: `AUDIT-SCOPE.md` §6.8 ("Native currency is not supported anywhere").

### 11.1 Invariants the suite holds

Each of these is a MUST. The fuzzer holds it over any sequence the handlers invent.

| ID | The settlement MUST keep... | Invariant |
|---|---|---|
| INV-1 | no allowance on itself, ever | `invariant_NoAllowanceEverAccumulatesOnTheSettlement` |
| INV-2 | the relayer holding no balance | `invariant_TheRelayerNeverHoldsABalance` |
| INV-3 | `filled` at or under the signed `amountIn` | `invariant_FilledNeverExceedsTheSignedAmount` |
| INV-4 | token A held equal to the escrow books | `invariant_ContractHoldsExactlyTheEscrow`, `invariant_TheContractHoldsExactlyTheEscrow` |
| INV-5 | token B held equal to the fees it owes, and no more | `invariant_ContractNeverHoldsTokenOutBeyondTheFeesItOwes`, `invariant_TheContractNeverHoldsTheOutputBeyondTheFeesItOwes` |
| INV-6 | tokens conserved across all parties | `invariant_TokensAreConserved` |
| INV-7 | makers paid what the curve owed | `invariant_MakersReceivedWhatTheyWereOwed`, `invariant_AnArmedMakerIsPaidTheCurve`, `invariant_TheSixDecimalMakersArePaidTheCurve` |
| INV-8 | no reservation below zero | `invariant_EscrowIsNeverNegative` |
| INV-9 | every fee booked to the sink the intent named | `invariant_TheFeeReachesTheDestinationTheIntentNamed` |
| INV-10 | a fee never paid out of committed money | `invariant_AFeeNeverReachesCommittedMoney` |
| INV-11 | a 3009 or Permit2 nonce spent only by a leg that filled | `invariant_AnAuthorizationNonceIsSpentOnlyByALegThatFilled`, `invariant_APermit2NonceIsSpentOnlyByALegThatFilled` |
| INV-12 | `dryRun` leaving state untouched | `invariant_ADryRunLeavesTheStateExactlyWhereItFoundIt` |
| INV-13 | no fill under `minFill` unless it closed the intent | `invariant_NoFillLandsBelowTheFloorUnlessItClosedTheIntent` |
| INV-14 | each per-token total equal to the sum of its map | `invariant_TheReservationsStillAddUpToTheBookTheSweepReads` |
| INV-15 | two offers sharing an `authNonce` never both filling | `invariant_TwoOffersSharingAnAuthorizationNeverBothFill` |
| INV-16 | a transfer tax paid by the filler, not the maker | `invariant_TheTaxIsPaidByTheExecutor`, `invariant_TheMakersPartWithExactlyWhatTheySigned`, `invariant_TheTaxedTokenIsAccountedFor` |
| INV-17 | the fee exactly `rate × gross`, floored | `invariant_TheDestinationEarnsExactlyTheRateOnTheGross` |

No invariant drives a non-zero `curve` (`AUDIT-SCOPE.md` §5 "What is not covered by an invariant").
`Curve.t.sol` fuzz properties cover it instead.

---

## 12. What this spec replaces

For the settlement's behaviour, this document supersedes the sections below. Another agent is
marking the files. Where a listed section also covers the app, the solver or another contract,
only its settlement content is superseded.

| Document | Sections |
|---|---|
| `2026-08-10-prove-cash-design.md` | §2 (the settlement rows), §4, §4.1, §5.1, §5.2, §5.3, §6.1-6.4, §8.1-8.5, §9 intro, §9.1, §9.4, §12, §12.1, §15, and §16 items on the settlement |
| `2026-08-12-escrow-exit.md` | All of it. Never built; overtaken by `66c43fa` |
| `2026-08-12-surfaces-and-claims.md` | "True, and worth leading with"; "True, and must be said" (its cancel table still shows the cooldown) |
| `2026-08-12-hooks-design.md` | §1, §2, §5, §6 (the settlement's call rules) |
| `2026-08-12-solver-design.md` | "What the contract gives the solver" |
| `2026-08-14-checkpoint.md` | "The rule that governs an intent's lifetime"; "The cap is two bounds" (reversed by `a7c5d7f`) |
| `2026-08-14-scale-and-rationing.md` | §1 "Not in the contract"; §4 |
| `2026-08-25-fee-resolution.md` | "The proposal"; the Appendix |
| `2026-08-26-neutral-protocol.md` | All of it, for the settlement. Its owner surface and "`_payFee` transfers to `feeTo`" are out of date |
| `2026-09-03-the-signed-intent-before-mainnet.md` | Parts 1, 2 and 3, for the settlement's behaviour. Its measurements and rejected alternatives stay as history |
| `2026-09-08-delegation-and-bulk-maker-actions.md` | Parts 1, 2, 5, 6, for the settlement |
| `2026-09-08-netting-a-coincidence-of-wants.md` | Parts 2-4, for the settlement |
| `2026-09-23-fee-sink-registry.md` | All of it. Rejected; the fixed-destination spec replaced it |

`2026-09-23-fee-sink-fixed-destination.md` is **not** superseded. It stays the authority for §4,
and this document defers to it.

---

## 13. Open questions (owner)

| ID | Question | Section |
|---|---|---|
| OQ-1 | Should `_termsOk` refuse `recipient == 0`, `amountIn == 0`, `endTime <= startTime`, `minFill > amountIn`? | §2.4 |
| OQ-2 | What must the contract do with the three spare flag bits? | §2.6 |
| OQ-3 | Should `claim` refuse an address that is not a registered sink? | §4.3 |
| OQ-4 | Keep `cancelledAt` as a time, or make it a flag at the next redeploy? | §6 |
| OQ-5 | Is the `Reason` precedence normative? | §8.1 |
| OQ-6 | Add a `deadline(intent)` view? | §8.3 |
| OQ-7 | Single-step `transferOwnership`: make it two-step, or accept the risk in writing? | §10 |
| OQ-8 | `TokenOutUnreadable` on the three single-fill arming doors: map it in `_revert`, or change the NatSpec that forbids a mapping? | §16 |

## 14. Traceability

Each MUST maps to the tests that prove it, by function name. File names are short: `Custody` is
`contracts/test/Custody.t.sol`. "—" means no test; §15 lists those.

### 14.1 The suite is red at `ce37983`

I ran `forge test --no-match-contract 'Fork|Live'` on this commit: **607 passed, 16 failed**. Every
failure is a `BadTerms` from the rejected allowlist (`ad661e0`), or a `setUp` that calls the
allowlist before the settlement exists. The invariant campaigns all pass. The table below does not
cite a red test as proof. The red tests are:

- `Adversarial`: `AdversarialRoundingTest.setUp` calls `setFeeSinkAllowed` on the settlement one
  line before it deploys it, so every test in that contract fails.
- `EconAudit`: `test_E5_TheFeeOffMeansTheFeeOff`.
- `ProveSettlement`: `test_ABatchSplitsItsFeesByDestination`,
  `test_TheDestinationCannotBeChangedAfterSigning` (now `BadTerms`, not `BadSignature`).
- `FaucetToken`: eight tests, among them `test_GaslessFillNeedsNoMakerTransaction` and
  `test_FillRevertsAgainstAFeeOnTransferToken`.
- `RfqVenue`: `test_AQuoteThatNamesNoDestinationChargesNothing`.
- `Uncovered`: `test_AZeroFeeFillPaysNoFeeDestination`, `test_AZeroFeeCallbackFillMakesNoFeeTransfer`.
- `RfqVenueInvariants`: `test_HandlerActionsReallyDoSomething`.

Several of these assert the pre-allowlist rule that `feeTo == 0` charges nothing at any rate. Under
the approved design that intent is `BadTerms_` (D-4), so those tests need a new expectation, not a
revert of the code. Two more cautions, from reading and not from running. `Executor.t.sol`'s
`test_AHopReachesTheSettlementAndTheGuardRefusesIt` encodes a 12-field `Intent`, so it passes on an
unknown selector, not on the guard. `Live369.t.sol` tests the deployed mainnet bytecode, not this
source.

### 14.2 The table

| MUST | Tests |
|---|---|
| SI-1 | `ProveSettlement`: `test_TheTypehashStringIsTheOneEveryWalletWillHash`; `Reasons`: `test_OkIsZeroAndEveryOtherReasonIsNot`; `Fixture`: `test_WriteEip712Fixture` (pins the digest and the reason numbers to the TypeScript codec) |
| SI-2 | `ProveSettlement`: `test_TheStructHashIsTheFieldByFieldEncoding`; `Fixture`: `test_ATypeScriptSignatureRecoversOnChain`; `Edges`: `test_DomainSeparatorFollowsTheChain` |
| SI-3 | `ProveSettlement`: `test_RejectsATamperedRate`; `Fuzz`: `testFuzz_TamperingWithTheTermsBreaksTheSignature`; `FeeTo`: `test_AnExecutorCannotRedirectTheFee` |
| SI-4 | — |
| SI-5 | `ProveSettlement`: `test_RejectsAForgedSignature`, `test_ContractMakerSignsThroughErc1271`, `test_AContractMakerThatCannotAnswerIsJustABadSignature`, `test_AContractWalletFillsThroughTheBatchAndTheCallback`; `Security`: `test_M2_DirtyErc1271ReturnIsJustABadSignature`; `Fuzz`: `testFuzz_GarbageNeverPassesAsASignature` |
| SI-6 | — |
| SI-7 | `Security`: `test_M1_ARisingMinimumIsRejectedNotReverted`, `test_L2_SameTokenBothSidesIsRejected`; `Edges`: `test_FillabilityRejectsNonsenseTerms`, `test_AnIntentPayingAnAddressItCannotLeaveIsRefused`; `Custody`: `test_AvailableRefusesEveryTermTheValidatorRefuses`, `testFuzz_EveryRateAboveOneIsRefusedOnEverySurface`; `EconAudit`: `test_F3d_AnUnboundedPriceIsAPanicNotAReason`, `test_F3e_ARateAboveOneIsAReasonNotAPanic`; `Arming`: `test_AnIntentCannotWearTwoCustodyFlags`. **Gap:** `amountIn > uint128` |
| SI-8 | `Custody`: `test_AnOfferMayOpenFarInTheFutureOnEveryRung`, `test_AWalletIntentLastsAsLongAsTheMakerSignedFor`; `Permit`: `test_APermitIntentMayRunLongerThanAnHour` |
| SI-9 | `EconAudit`: `test_F3e_ARateAboveOneIsAReasonNotAPanic` |
| SI-10 | `Arming`: `test_AnIntentCannotWearTwoCustodyFlags` |
| SI-11 | `Curve`: `testFuzz_AZeroWordIsTheShippedLine`, `test_ShapeTodaysLine`, `test_ShapeDutchThenFlat`, `test_ShapeFlatThenDutch`, `test_ShapeFlatDutchFlat`; `ProveSettlement`: `test_DutchDecayWalksFromStartToEnd` |
| SI-12 | `Curve`: `testFuzz_AnUnreadWordChangesNoPrice` |
| SI-13 | `Curve`: `test_AReservedKindPricesAsTheLine` |
| PX-1 | `Fixture`: `test_WriteEip712Fixture` (pins `minOutAt` at ten instants); `Curve`: `testFuzz_TheEnvelopeHolds` |
| PX-2 | `Curve`: `testFuzz_TheEnvelopeHolds`, `testFuzz_TheStretchNeverRises`; `Fuzz`: `testFuzz_DecayIsMonotonicAndBounded` |
| PX-3 | `ProveSettlement`: `test_TheFeeIsCarvedOutOfTheDelivery`, `test_TheDestinationChangesNeitherSideOfTheTrade`; `Custody`: `testFuzz_TheFeeRateNeverReachesTheExecutorsOutlay`; `Fuzz`: `testFuzz_TheSplitTotalsToTheGrossAtEveryRate`; `FeeTo`: `test_TheMakerPaysTheWholeFeeForNamingADestination`; `invariant_AFeeNeverReachesCommittedMoney` |
| PX-4 | `ProveSettlement`: `test_RoundingFavoursTheMaker`, `testFuzz_TheGrossNeverFallsBelowTheSignedRate`; `Fuzz`: `testFuzz_QuoteNeverShortChangesTheMaker`, `testFuzz_TheFeeRoundsDownAtBothExtremes`; `Curve`: `testFuzz_TheRoundingStillFavoursTheMaker`; `EconAudit`: `test_E5_ADustFillPaysNoFeeAndTheMakerKeepsTheWei`; `invariant_TheDestinationEarnsExactlyTheRateOnTheGross` |
| PX-5 | `Reasons`: `test_ALegAboveTheCallersBoundIsSkippedRatherThanTakingTheBatch`; `Custody`: `testFuzz_MaxFeeRateIsExactlyTheBound`; `Defaults`: `test_AZeroFeeToPassesTheTightestBound` (2026-10-01) |
| PX-6 | `Curve`: `testFuzz_NoWordPanicsThroughQuote`; `Custody`: `testFuzz_EveryRateAboveOneIsRefusedOnEverySurface`; `EconAudit`: `test_F3d_AnUnboundedPriceIsAPanicNotAReason` |
| PX-7 | A rule for callers; nothing to test |
| FE-1 | `FeeTo`: `test_NoFillEverTransfersToAFeeDestination`, `test_ADestinationTheTokenRefusesDoesNotKillTheFill`, `test_EveryPathPaysTheDestinationTheIntentNamed`; `invariant_TheFeeDestinationsTookExactlyTheSignedFee` (RFQ campaign: the destination's balance stays 0 during fills) |
| FE-2 | — |
| FE-3 | `Sweep`: `test_TheSweepCannotTakeABookedFee`, `test_ADonationBesideABookedFeeIsStillSweepable`; `invariant_TheReservationsStillAddUpToTheBookTheSweepReads` |
| FE-4 | `invariant_TheReservationsStillAddUpToTheBookTheSweepReads`; `invariant_ContractNeverHoldsTokenOutBeyondTheFeesItOwes` |
| FE-5 | `FeeTo`: `test_ABatchCoalescesLegsThatShareATokenAndADestination`, `test_AMixedBatchPaysOneTransferPerRun`, `test_ABatchPaysEachNamedDestinationItsOwn`; `BatchCallback`: `test_FeesForOneTokenCoalesceIntoASingleTransfer` |
| FE-6 | Built in `4d48379`. `FeeSink`: `test_ASinkRecordsItsTwoTerms`, `test_ASinkRefusesAZeroDestination`, `test_ASinkRefusesAFloorAboveOneWhole`, `test_ASinkHasNoOwnerNoSetterAndNoWayToMoveAToken`; `invariant_ASinkNeverHoldsATokenAndItsTermsNeverMove` |
| FE-7 | Built in `4d48379`. `FeeSink`: `test_RegisteringCopiesTheSinksTermsAndSaysSo`, `test_OnlyTheOwnerRegisters`, `test_ASinkRegistersOnce`, `test_AnAddressWithNoCodeIsRefused`, `test_ASinkReportingAZeroDestinationIsRefused`, `test_ASinkReportingAFloorAboveOneWholeIsRefused`, `test_ASinkThatPaysTheSettlementOrTheRelayerIsRefused`, `test_AContractThatIsNotASinkIsRefused`, `test_NoFunctionCanRemoveOrChangeARegistration` |
| FE-8 | Built in `4d48379`. `FeeSink`: `test_ARateOfExactlyTheFloorFills`, `test_OneWeiBelowTheFloorIsBadTerms`, `test_AnUnregisteredSinkIsBadTerms`, `test_AZeroFeeIntentIgnoresTheRegistryAndTheFloor`, `test_AHostileSinkOrDestinationCannotTouchAFill`; `FeeTo`: `test_UnauthorizedFeeSinkIsRefusedWhenRatePositive`, `test_PositiveRateWithZeroFeeToIsBadTerms`, `test_ZeroRateIgnoresTheRegistry`; `Defaults`: `test_Row1_AZeroFeeToPaysNoFee`, `test_EveryFillDoorChargesAZeroFeeToNothing` (2026-10-01) |
| FE-9 | `invariant_TheFeeReachesTheDestinationTheIntentNamed`; `FeeSink`: `test_SeveralSinksSideBySide` |
| FE-10 | Built in `4d48379`. `FeeSink`: `test_ClaimPaysTheDestinationNotTheSink`, `test_ClaimForAnUnregisteredAddressIsRefused`; `FeeTo`: `test_AnybodyMayClaimAndItAlwaysPaysTheRecordedDestination`, `test_ADestinationThatReentersClaimFindsAnEmptyBook` |
| FE-11 | `FeeTo`: `test_ClaimingAnEmptyBookMovesNothing` |
| FE-12 | `FeeTo`: `test_ADestinationThatCannotReceiveHasAClaimThatReverts` |
| CU-1 | `Relayer`: `test_ApprovingTheSettlementNoLongerFundsAFill`, `test_NoAllowanceOfAnyKindEndsUpOnTheSettlement`, `testFuzz_TheSettlementIsNeverASpender`, `test_OnlyTheSettlementCanMakeTheRelayerMoveAnything`; `Permit`: `test_TheAllowanceLandsOnTheRelayerAndNotTheSettlement`; `invariant_NoAllowanceEverAccumulatesOnTheSettlement`; `invariant_TheRelayerNeverHoldsABalance` |
| CU-2 | `ProveSettlement`: `test_TheFixedSelectorIsTheOnlyThingProtectingTheCallbackPath`; `BatchCallback`: `test_TheFixedSelectorProtectsTheBatchCallbackPath` |
| CU-3 | `Relayer`: `test_TheCallbackTargetCanNeverBeTheRelayerOrTheSettlement`, `testFuzz_TheCallbackGuardRefusesTheRelayerAndTheSettlementAndNothingElse`, `test_TheForbiddenTargetIsRefusedBeforeAnyReleaseHappens` |
| CU-4 | `Relayer`: `test_OneApprovalCoversBothCustodyModes`; `Uncovered`: `test_AnApprovedMakerWithNoBalanceIsSkipped` |
| CU-5 | `Permit`: `test_AFrontRunPermitDoesNotCostTheFill`, `test_AStandingAllowanceSkipsThePermitEntirely` |
| CU-6 | `Permit`: `test_APermitCannotFundAnEscrowIntent`; `Arming`: `test_FillWithPermitRefusesAPermit2Intent` |
| CU-7 | `Custody`: `test_RevokingAnAllowanceIsNotCancellingAndReApprovingRevivesEveryOldIntent`, `test_ARevivedAllowanceRevivesEverySignatureStillInsideItsWindow` |
| CU-8 | `ProveSettlement`: `test_EscrowIsCommittedToOneIntentOnly`; `Uncovered`: `test_AReservationBacksOneIntentAndNoOther`; `EconAudit`: `test_F1a_FrontRunningDepositForStealsTheWholeEscrow` |
| CU-9 | `Edges`: `test_AReservationTakesItsTokenFromTheIntent`, `test_DepositRejectsZero`; `Custody`: `test_AStrangersTopUpFundsTheFillAndBelongsToTheMaker`, `test_WithdrawingEndsTheOfferAndNobodyCanFundItBack`; `Sweep`: `test_ATaxedDepositBooksWhatArrivedInBothBooks` |
| CU-10 | `Edges`: `test_OnlyTheMakerWithdraws`; `Custody`: `test_WithdrawingEndsTheOfferAndNobodyCanFundItBack`; `Fuzz`: `testFuzz_EscrowComesBackWheneverTheMakerAsksAndNeverToAnyoneElse`, `testFuzz_EscrowRoundTripsExactly` |
| CU-11 | `Sweep`: `test_AFundedEscrowIsNeverSweptAndADonationBesideItIs`, `test_APlainTransferIsSweptToTheProceedsAddress`. **Gap:** no test asserts that a donation leaves an escrow leg at `EscrowShort` |
| CU-12 | `FaucetToken`: `test_AProveCashAuthorizationCannotBeRelayedByAStranger`, `test_ReceiveWithAuthorizationOnlyAnswersToThePayee` |
| CU-13 | `Custody`: `test_TwoIntentsSharingAnAuthNonceAreMutuallyExclusive`, `test_AZeroAuthNonceStillMeansTheIntentHash`, `test_ASiblingOfADifferentSizeCannotShareTheAuthorization`; `Security`: `test_M4_AnAuthorizationCannotFundADifferentIntent`; `Arming`: `test_APermit2SignatureOverAnotherTokenDoesNotArmThisLeg`, `test_APermit2SignatureNamingAnotherNonceDoesNotArmThisLeg`, `test_AnAuthorizationForAnotherIntentDoesNotArmThisOne` |
| CU-14 | `Arming`: `test_TheFirstPermit2FillPromotesTheWholeIntentIntoEscrow`, `test_TheRestOfAPermit2IntentFillsFromTheReservation`, `test_APermit2DrawNeverExceedsThePermissionSigned`, `testFuzz_ManyPermit2PartialsDrawTheWalletOnce` |
| CU-15 | `Arming`: `test_ATokenThatWillNotSayWhatItMovedCannotArmALeg`; `DryRun`: `test_AFeeOnTransferRedemptionReportsEscrowShort`; `TokenMatrix`: `test_TaxAuthWhole`, `test_TaxPermit2Whole` |
| CU-17 | `Parked`: `test_ParkingRefusesALiveOffer`, `test_ParkingRefusesAnOfferWithNothingBehindIt`, `test_ParkAcceptsAnIntentTheNonceFloorKilled`, `test_ACancelledOfferParksSoAMakerCanRePriceEarly`, `test_ParkingEndsTheOfferSoNobodyCanRefundItBackToLife`; `Lanes`: `test_ParkTakesAnIntentAnyLanesFloorKilled`, `test_ParkStillRefusesALiveIntentInALaneNobodyRetired` |
| CU-18 | `Parked`: `test_OnlyTheMakerReachesTheirOwnParkedCapital`, `test_WithdrawingAnEmptyRowReverts`, `test_AMakerTakesTheirParkedCapitalHome` |
| CU-19 | `Parked`: `test_ParkedCapitalBacksNoOfferUntilSomebodyArmsIt`, `test_TheDrawIsBoundedByTheLegAndNotByThePot`, `test_ALegTheCapitalCannotCoverDrawsNothing`, `test_ASolverCannotArmOneMakersLegFromAnothersCapital`, `test_ASolverCannotArmAcrossTokens` |
| CU-20 | `Parked`: `test_AnOfferWeldedToASiblingCannotBeFundedFromParkedCapital`; `invariant_TwoOffersSharingAnAuthorizationNeverBothFill` |
| CU-21 | `Parked`: `test_AnUnfundedEscrowSignatureIsNoLongerInert` |
| CU-22 | `Parked`: `test_AWrongWordIsRefused`; `Arming`: `test_APermitLegRidesInABatch`, `test_AGaslessLegRidesInABatch`, `test_APermit2LegRidesInABatch` |
| CU-23 | `Arming`: `test_ARequestedLegThatCannotBeArmedIsSteppedOver`, `test_APermitThatCannotBeGrantedReadsAsEscrowShort`, `test_ABadPermit2SignatureLeavesNothingBehind`; `invariant_AnAuthorizationNonceIsSpentOnlyByALegThatFilled`; `invariant_APermit2NonceIsSpentOnlyByALegThatFilled` |
| CU-24 | `Arming`: `test_ArmLegRefusesEveryCallerButTheContract` |
| CU-25 | `Arming`: `test_ABadIntentSignatureNeverSpendsTheAuthorization`; `Adversarial`: `test_AGoodPermit2SignatureOnABadIntentLeavesTheNonceUnspent` |
| CN-1 | `ProveSettlement`: `test_CancelStopsAFill`, `test_OnlyTheMakerCancels`; `EconAudit`: `test_F4_EveryWayOutIsImmediateNowAndAtomicityIsWhatProtectsTheExecutor` |
| CN-2 | `Lanes`: `test_OneWordRetiresOneLaneAndSparesEveryOther`, `test_ALaneFloorNeverReachesTheNeighbouringLane`, `test_AFloorBelongsToTheMakerWhoWroteItAndToNobodyElse`, `test_LaneZeroIsExactlyTheFloorTheContractAlwaysHad`; `ProveSettlement`: `test_InvalidateBeforeKillsAWholeRange`; `Fuzz`: `testFuzz_InvalidateBeforeIsExact`; `EconAudit`: `test_F4b_InvalidateBeforeIsImmediateAndKeepsTheEscrowRecoverable` |
| CN-3 | `Lanes`: `test_TheFillPathRefusesARetiredNonceInAnyLane`, `test_ParkTakesAnIntentAnyLanesFloorKilled` |
| CN-4 | `Lanes`: `test_AFloorOnlyRisesSoARetiredSignatureNeverComesBack`; `Edges`: `test_InvalidateBeforeOnlyMovesForward` |
| CN-5 | `Lanes`: `test_TheTopPositionInALaneIsTheOneAFloorCannotReach` |
| CN-6 | — |
| FP-1 | `Reasons`: `test_EveryReasonRevertsAFillAndIsSteppedOverByABatch` |
| FP-2 | `ProveSettlement`: `testFuzz_FillsNeverExceedTheSignedAmount`, `test_PartialFillsAccumulate`; `invariant_FilledNeverExceedsTheSignedAmount` |
| FP-3 | `Reasons`: `test_EveryReasonRevertsAFillAndIsSteppedOverByABatch`; `ProveSettlement`: `test_RejectsBeforeStartAndAfterExpiry`, `test_AllOrNothingRejectsAPartialTake`; `Fuzz`: `testFuzz_OnlyFillableInsideTheWindow` |
| FP-4 | `Edges`: `test_AMinFillLeavesNoDust`, `test_AZeroMinFillIsNoFloor`, `test_AMinFillNeverBitesOnAnAllOrNothingIntent`; `Fuzz`: `testFuzz_AFloorNeverStrandsDust`, `testFuzz_AFillIsRefusedExactlyWhenItIsUnderAnOpenFloor`; `invariant_NoFillLandsBelowTheFloorUnlessItClosedTheIntent` |
| FP-5 | `Custody`: `testFuzz_MaxFeeRateIsExactlyTheBound`, `testFuzz_TheFeeRateNeverReachesTheExecutorsOutlay`; `EconAudit`: `test_F6_AnIntentCannotChargeMoreThanTheExecutorPriced`; `FeeTo`: `test_TheCallersOwnBoundIsTheOnlyCeiling`; `BatchCallback`: `test_TheFeeBoundIsHonouredHere` |
| FP-5a | `ProveSettlement`: `test_PinnedExecutorLocksOthersOut`; `RfqVenue`: `test_NobodyButTheVenueCanFillTheQuoteOnTheSettlement`, `test_NobodyButTheVenueCanBatchTheQuoteEither` |
| FP-6 | `Reasons`: `test_ABatchOfNothingButBadLegsStillSettlesTheGoodOne`; `ProveSettlement`: `test_BatchSkipsWhatSomebodyElseAlreadyTook`; `EconAudit`: `test_F3a_OneHostileTokenKillsTheWholeBatch`; `BatchCallback`: `test_SkipInvalidStepsOverALegAndStillSettlesTheOthers`, `test_WithoutSkipInvalidTheWholeBatchReverts` |
| FP-7 | `ProveSettlement`: `test_TheFixedSelectorIsTheOnlyThingProtectingTheCallbackPath`; `Edges`: `test_ACallbackFillFromAnEoaCannotPay` |
| FP-8 | `ProveSettlement`: `test_ADonationDoesNotDischargeADebt`, `test_CallbackUnderpaymentReverts`; `BatchCallback`: `test_ADonationDoesNotDischargeADebt`, `test_TheReleaseIsNotAPayment`, `test_TwoLegsToOneRecipientAreBothPaid` |
| FP-9 | `Security`: `test_M3_ATaxedOutputTokenCannotUnderpayTheMaker`; `BatchCallback`: `test_ATaxedOutputTokenStillFailsTheFill`; `TokenMatrix`: `test_ATaxingTokenInShortsTheExecutorAndATaxingTokenOutIsRefused` |
| FP-10 | `Adversarial`: `test_TheLegIndexSurvivesAHoleInTheMiddle` (through `ProveBatchExecutor`); `BatchCallback`: `test_ABatchWhereEveryLegIsSkippedOwesNothing` |
| FP-11 | `Arming`: `test_FillWithPermit2LooksAtTheIntentBeforeSpendingTheSignature`; `Custody`: `test_ADeadGaslessIntentIsRefusedBeforeTheTokenIsTouched` |
| RD-1 | `ReturnBomb`: `test_ATokenThatAnswersNothingIsSkippedAndTheBatchSettles`; `EconAudit`: `test_F3c_AReturnBombBurnsTheExecutorsWholeGasBudget`. **Gap:** no test pins that the cheap checks run before `ecrecover` |
| RD-2 | `Reasons`: `test_EveryReasonRevertsAFillAndIsSteppedOverByABatch`; `Edges`: `test_FillabilityExplainsWhyNot`, `test_FillabilityReportsAnEmptyEscrow`, `test_FillabilityReportsAMissingAllowance` |
| RD-3 | `DryRun`: `test_ACleanBatchReportsOkOnEveryLeg`, `test_ADeadLegKeepsItsOwnReason`, `test_TheWalkBooksEachLegForTheOnesBehindIt`, `test_ALegThatNeedsArmingReportsOkWhenTheArmingWorks`, `test_AFeeAboveTheCallersBoundReportsFeeTooHigh`; `invariant_ADryRunLeavesTheStateExactlyWhereItFoundIt` |
| RD-4 | `Edges`: `test_AvailableTracksTheLifecycle`; `Custody`: `test_AvailableRefusesEveryTermTheValidatorRefuses`; `Lanes`: `test_TheFillPathRefusesARetiredNonceInAnyLane` |
| RD-5 | As PX-1 to PX-7 |
| RD-6 | `invariant_TheReservationsStillAddUpToTheBookTheSweepReads` reads every book getter |
| SW-1 | `Sweep`: `test_AnyoneMaySweep`, `test_APlainTransferIsSweptToTheProceedsAddress`, `test_SweepingNothingReturnsZeroAndMovesNothing`, `test_ARebaseDownSweepsNothingAndDoesNotRevert`, `test_TheSweepCannotTakeABookedFee`; `Parked`: `test_TheSweepCannotTakeParkedCapital` |
| SW-2 | `invariant_TheReservationsStillAddUpToTheBookTheSweepReads`; `Sweep`: `test_AWithdrawalClearsTheBookAsWellAsTheBalance`, `test_AFillOutOfEscrowMovesBothBooks`; `Parked`: `test_AParkedWithdrawalClearsTheBookAsWellAsTheBalance` |
| SW-3 | `Sweep`: `test_AFundedEscrowIsNeverSweptAndADonationBesideItIs` |
| SW-4 | `Sweep`: `test_ARebaseUpBecomesSweepableAndTheMakerKeepsTheirBookedAmount` |
| SW-5 | `Edges`: `test_ConstructorRejectsZeroAddresses`, `test_TheProceedsAddressIsSettable` |
| OW-1 | `Edges`: `test_OwnershipMoves`, `test_TheProceedsAddressIsSettable`; `FeeSink`: `test_OnlyTheOwnerRegisters`, and `test_NoFunctionCanRemoveOrChangeARegistration`, which holds every state-changing function in the exported ABI to a vetted list of 20. **Gap:** no test asserts that the other 17 on that list are not owner-gated |
| OW-2 | `Sweep`: `test_TheOwnerMayRepointTheSweepAndReachNothingElse`; `ProveSettlement`: `test_MovingTheProceedsAddressChangesNoFill`, `test_TheOwnerMayOnlyMoveWhereUnownedTokensGo`; `FeeTo`: `test_TheOwnersOneSwitchTouchesNoFill`; `FeeSink`: `test_NoFunctionCanRemoveOrChangeARegistration` ("never remove a sink", since `4d48379`); `NoDefaultAtFill`: `test_AWadDefaultAfterSigningChargesAZeroFeeToNothing`, `test_AnOwnerThatFillsGainsNothingFromTheDefault` (the M-1 proof of concept, as a regression), `test_ASignedDefaultKeepsItsSinkAndRateAfterTheOwnerMovesIt`; `Defaults`: `test_ASwitchAfterSigningChangesNoSignedIntent`, `test_RetiringTheDefaultSinkChangesNoFill` (2026-10-01) |
| SA-1 | `ProveSettlement`: `test_NoGuardedEntryPointCanBeReenteredFromACallback`, `test_CallbackCannotReenter`; `BatchCallback`: `test_TheCallbackCannotReenterAFill`; `Custody`: `test_TheUnguardedDoorsOpenFromACallbackAndChangeNothing`; `FeeTo`: `test_ADestinationThatReentersClaimFindsAnEmptyBook`. **Gap:** no reentry test for `withdrawParked` or `sweepUnowned` |
| SA-2 | `ReturnBomb`: `test_ATokenThatAnswersNothingIsSkippedAndTheBatchSettles`, `test_ATokenBThatLiesToTheSimulationIsSteppedOverByTheBatch`; `EconAudit`: `test_F3c_AReturnBombBurnsTheExecutorsWholeGasBudget` |
| SA-3 | `TokenMatrix`: `test_TaxApproval`, `test_TaxEscrowFunded`, `test_TaxAuthWhole`, `test_TaxPermit2Whole`; `Sweep`: `test_ATaxedDepositBooksWhatArrivedInBothBooks`; `invariant_TheTaxIsPaidByTheExecutor`; `invariant_TheTaxedTokenIsAccountedFor`. **Gap:** `_payFee` (FE-2) |
| SA-4 | `TokenMatrix`: the `test_Silent*` cells; `Relayer`: `test_ATransferThatAnswersWithNothingIsStillAPayment`, `test_ATransferThatAnswersFalseIsNotAPayment` |
| SA-5 | `TokenMatrix`: `test_ARebaseDownLeavesTheEscrowBookShortOfTheBalance`; `Sweep`: `test_ARebaseDownSweepsNothingAndDoesNotRevert` |
| SA-6 | — |
| INV-1 to INV-17 | The invariant named in §11.1 is the test |

## 15. MUSTs with no test

Each of these is a finding. A MUST that no test holds can break in silence.

| MUST | What is missing |
|---|---|
| SI-4 | No test deploys twice and shows a signature for one deployment is refused by the other |
| SI-6 | No test shows a second encoding of a signature cannot fill again. OpenZeppelin's `tryRecover` refuses high-`s`, and `filled` is keyed by the digest, so the risk is low; the property is still unpinned |
| SI-7 | `amountIn > type(uint128).max` has no test |
| FE-2 | `_payFee` booking what arrived has no direct test. A uniformly taxing `tokenOut` fails `_deliverTo` first, so only a token that taxes some transfers and not others reaches it. The test needs such a token |
| CU-11 | A donation next to an escrow intent leaves it `EscrowShort` |
| CN-6 | No test fills a maker's intents out of nonce order |
| RD-1 | The order "cheap checks before `ecrecover`, token-B probe after it" is unpinned |
| OW-1 | The ABI test pins the set of state-changing functions, not which of them are owner-gated |
| SA-1 | Reentry into `withdrawParked` and `sweepUnowned` from a token hook |
| SA-6 | No test that the settlement refuses native currency |
| — | The constructor with a zero `permit2` has no test. It is a constructor guard with no MUST here; I note it for completeness. (`setFeeSinkAllowed` went with `4d48379`, and B-2 has three tests since `64224af`.) |

## 16. Code that contradicts a recorded decision

These are bugs against the record, at `ce37983`. The first is the known gap the fixed-destination
work is closing now. I list it so that the list is complete.

**B-1. The fee-sink allowlist is revocable, and it is the rejected design.**
`setFeeSinkAllowed(sink, false)` switches a sink off. `_termsOk` runs on every fill and in
`available`, so a switch-off makes every live, signed intent that names the sink `BadTerms_`, not
only new ones. The approved spec says: "That bricks every signed intent that names it.
Registration becomes permanent." Also missing: the `minRate` check (FE-8), and `claim` paying the
sink's destination (FE-10) — `claim` pays `feeTo` itself. The NatSpec on `setFeeSinkAllowed` says
"claim and distribute continue to work"; the settlement has no `distribute`. While B-1 stands,
`AUDIT-SCOPE.md` §1 "nothing decided later reaches an offer already signed" is false.
**Fixed in `4d48379`.** The allowlist is gone. `registerFeeSink` is append only, `_termsOk` checks
`minRate`, and `claim` pays `feeSinks[sink].destination`. §14 names the tests.

**B-2. `TokenOutUnreadable` reverts as `BadSignature` on three doors.** The NatSpec on
`Reason.TokenOutUnreadable` (from `1655e35`) says: "`fill` and a strict batch pass `deep = false`,
so neither can produce this reason ... There is no `_revert` mapping and there must not be one."
But `fillWithPermit`, `fillWithAuthorization` and `fillWithPermit2` reach `_armLeg`, which calls
`_evaluate` with `deep = true` and then `_revert(r)`. `_revert` has no branch for this reason, so
it falls through to `revert BadSignature()`. A filler is told the maker's signature is bad when
the real fault is token B. I found this by reading the code.
**Fixed in `64224af`, with option (a) below.** `_revert` maps the reason to `Underpaid`, and
three tests in `Arming.t.sol` drive one door each: `test_AnUnreadableTokenBIsUnderpaidThroughFillWithPermit`,
`test_AnUnreadableTokenBIsUnderpaidThroughFillWithAuthorization` and
`test_AnUnreadableTokenBIsUnderpaidThroughFillWithPermit2`.

**OPEN QUESTION (owner) OQ-8.** Options:

- (a) Map it in `_revert` to `Underpaid`, the error `fill` gives for the same token.
- (b) Map it to a new error.
- (c) Keep the code, correct the NatSpec, and accept a misleading revert.

Option (a) or (b) needs a test that drives a single-fill arming door with an unreadable
`tokenOut`.

**Documentation that contradicts a recorded decision** (the code follows the record; the NatSpec
or a doc does not):

- **D-1.** `@param maxFeeRate` on `fillBatch`, `fillBatchWithCallback` and `dryRun` says "the
  highest `feeRate` this caller will pay". Commit `d1dd385` and the signed-intent spec Part 2
  changed the meaning to a bound on the destinations a fill touches. Only `fill` was updated.
- **D-2.** The NatSpec on `Permit2Transfer`, and the first of the two `@dev` blocks above
  `_pullPermit2`, say a partial take draws only what it fills. Commit `42aee0a` changed the draw
  to `min(amount, amountIn)`, and the code does that.
- **D-3.** The NatSpec on `dryRun` and on `FillRequest.arming` says a leg that cannot be armed
  "keeps the reason it already had". Commit `2b4d869` made it `EscrowShort`, and `_arm` does that.
- **D-4.** The NatSpec on `Intent.feeTo`, `Intent.feeRate` and `rateOf`, and `FEE-MODEL.md`
  Part 2, say a zero `feeTo` charges nothing "whatever rate it signed". Under the allowlist, and
  under the approved fixed-destination spec, `feeRate > 0` with `feeTo == 0` is `BadTerms_`.
- **D-5.** The NatSpec on `sweepUnowned` says an intent is funded "by `deposit` or by a redeemed
  authorization, and by nothing else". Permit2 promotion (`42aee0a`) and `ARM_FROM_PARKED`
  (`8b7d92a`) also credit reservations.
- **D-6.** `2026-08-10-prove-cash-design.md` §5.3 still says "Both functions now emit an
  `effectiveAt`". Commit `66c43fa` removed it. `2026-08-26-neutral-protocol.md` still says the
  owner has one function and that `_payFee` transfers to `feeTo`.
- **D-7.** `AUDIT-SCOPE.md` §4 and the internal risk assessment count two owner functions. The code has
  three today (`setFeeSinkAllowed`), and the approved design has three (`registerFeeSink`).
- **D-8.** Smaller NatSpec errors. `Intent.feeRate` says the rate is a fraction "of the delivery";
  `_quote` charges it on the gross. `Filled` says the fee is at least "1 wei"; a floored fee can be
  zero (PX-4). `FLAGS_CURVE_KIND` says "bits 8 and 16"; it means the values 8 and 16, which are
  bits 3 and 4. `_probe` cites `test_ATokenThatAnswersNothingIsSkipped`; the test is
  `test_ATokenThatAnswersNothingIsSkippedAndTheBatchSettles`.

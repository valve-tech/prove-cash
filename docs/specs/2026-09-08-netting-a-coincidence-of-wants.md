# Netting a coincidence of wants

**Status: proposed. Nothing here is built.** `docs/ROADMAP.md:464-486` lists it under "Designed,
not booked", says the settlement should verify a claimed coincidence the way `_requireSwept`
does, and blocks it on this document.

`contracts/src/ProveSettlement.sol` is the authority. Every gas figure came from one command,
named beside it. Every slippage figure is derived from the pool arithmetic this repository
already ships, and I reproduced the one number a test asserts before I used the formula for
anything else. Where I could not measure something I write "unmeasured" and say what would
measure it.

**Read this before you trust a line number here.** I wrote this on 2026-09-08 at commit
`59c670f`, with `contracts/src/ProveSettlement.sol` uncommitted and changing under me — another
agent was landing parked capital (`park`, `_drawFromParked`, `ARM_FROM_PARKED`) at the same time.
Every citation resolves against that working tree and `contracts/tools/check-citations.py` was
run against this file. The day that work commits, run the checker again before trusting a number.
Section 10 of `docs/AUDIT-SCOPE.md` exists because exactly this has happened twice.

**This document reverses two claims in the roadmap.** Part 6 has the arithmetic.

---

## Part 0 — The short answer

1. **The donation guarantee survives.** A netted transfer is still a directed pull: a named
   source, a named destination, an amount `_quote` decided. No balance delta becomes evidence of
   payment. Part 2 works the adversarial cases.
2. **A second guarantee does not survive, and that is the case that decides the design.** Today a
   taxing token's cut on the release falls on the executor, and
   `invariant_TheTaxIsPaidByTheExecutor` asserts it. Netting deletes the address that was
   absorbing the cut, so it lands on the counterparty maker instead. It survives only if the
   netted release is bracketed the way `_deliverTo` brackets a delivery today.
3. **The coincidence of wants already settles on this chain, with no pool and no slippage.**
   `test_ATwoLegRingSettlesFromAnAddressHoldingNothing` proves it, and
   `contracts/src/RfqVenue.sol` is a second contract doing the same thing for one named
   counterparty. The payoff the roadmap claims — avoided slippage — is already collected.
4. **What netting would actually buy is gas and attack surface, and the gas is a sixth of a cent
   for a whole cross.** Part 5 measures it.
5. **So the case for booking it is weak on today's numbers.** Part 7 says what would make it
   strong. Part 8 says what should stop it.

---

## Part 1 — What netting is, in this contract's vocabulary

Two makers cross. Maker A signs an intent selling token X for token Y. Maker B signs one selling
Y for X. `_termsOk` refuses an intent whose `tokenIn` equals its `tokenOut`, at
`contracts/src/ProveSettlement.sol:2564`, so a cross is always between two intents in
two distinct tokens.

### What happens today

A solver settles the pair through `ProveBatchExecutor.settleRing` with an empty swap list. The
settlement releases both legs before it pays either maker — that is what `fillBatchWithCallback`
is for — so the token one maker sells is in the executor's hands when the other maker's payment
goes out. `_sinkFor` returns the zero address for a route naming no venue, at
`contracts/src/ProveBatchExecutor.sol:582`, so a pure ring mints nothing.

Eight ERC-20 movements and two approvals, in this order:

| # | Where | From | To | Amount |
|---|---|---|---|---|
| 1 | `_release`, `contracts/src/ProveSettlement.sol:3034` | maker A | the executor | A's `take` of X |
| 2 | `_release`, the same `pull` | maker B | the executor | B's `take` of Y |
| 3 | `_oweEveryLine` writes two `forceApprove`, `contracts/src/ProveBatchExecutor.sol:936` | — | — | no tokens move |
| 4 | `_deliverTo`, `contracts/src/ProveSettlement.sol:3001` | the executor | A's `recipient` | A's `delivered` of Y |
| 5 | `_deliverTo`, the same `pull` | the executor | B's `recipient` | B's `delivered` of X |
| 6 | `_reserve` (`_payFee` before the fee config change), `contracts/src/ProveSettlement.sol:2934` | the executor | the settlement | A's `fee` of Y |
| 7 | `_payFee`, the same `pull` | the executor | the settlement | B's `fee` of X |
| 8 | `_sweepAbove`, `contracts/src/ProveBatchExecutor.sol:962` | the executor | the solver | the X residual |
| 9 | `_sweepAbove`, the same `safeTransfer` | the executor | the solver | the Y residual |

Plus four balance probes — `_deliverTo` reads the recipient's balance twice around each delivery,
the first at `contracts/src/ProveSettlement.sol:3006` — and four `balanceOf` marks inside
`settleRing` before the ring, plus two after it.

Each maker's `delivered` and `fee` are `_quote`'s two outputs for that leg, computed at
`contracts/src/ProveSettlement.sol:1055-1055` from that maker's own signed curve
and nothing else.

### What would happen instead

The solver claims the coincidence. The settlement verifies it and names the counterparty's
`recipient` as the destination of the release, instead of naming `msg.sender`:

| # | From | To | Amount |
|---|---|---|---|
| 1 | maker A | B's `recipient` | B's `delivered` of X |
| 2 | maker A | the settlement | B's `fee` of X |
| 3 | maker A | the solver | what is left of A's `take` of X |
| 4 | maker B | A's `recipient` | A's `delivered` of Y |
| 5 | maker B | the settlement | A's `fee` of Y |
| 6 | maker B | the solver | what is left of B's `take` of Y |

**Nothing about who owes what changes.** Every amount is still `_quote`'s number for that leg.
The only thing that moves is the address the relayer names as the source of each pull. That
sentence is the whole design, and it is also the whole safety argument.

### The transfer arithmetic, stated honestly

The roadmap says four transfers through a solver become a direct swap. Counted against the
settlement alone, today's path moves six times — two releases, two deliveries, two fees — and
netting also moves six. The residual is why. What maker A parts with and what B's side of the
cross is worth are equal only by accident, and whatever is left over is the solver's spread,
which needs a transfer of its own.

**Netting collapses two transfers into one only when the residual in that token is zero.** That
is the exact match, which is precisely the case the roadmap says netting must not depend on.

What netting removes for certain is the executor: two sweeps, two approvals, six `balanceOf`
marks and a whole contract frame. Part 5 prices that.

### The nearest thing already in the tree

`_drawFromParked` at `contracts/src/ProveSettlement.sol:2179` is the closest
precedent, and it landed while this document was being written. It moves a maker's own capital
out of the parked book and into a reservation with **no token transfer at all** — a book move,
four writes, two pairs. It is safe for a reason netting must copy: both map keys come out of the
intent's own preimage, so `_parked` is read at `i.maker` and `i.tokenIn`
(`contracts/src/ProveSettlement.sol:2176`) and there is no hash whose owner has to be
established and no caller whose word has to be taken.

It also spends something. An escrow intent the maker never funded used to be inert for ever, and
a solver can now fund it out of the same maker's parked capital at a moment the solver picks —
the comment above `FLAG_ESCROW` at `contracts/src/ProveSettlement.sol:388` says so.
**Netting spends nothing further there.** One maker's tokens discharging another maker's delivery
is one transfer instead of two, not a new way to reach a maker's money.

---

## Part 2 — The donation argument

### The guarantee, as the code enforces it today

Two halves, and both are needed. Neither is one line; each is a property of how several functions
fit together.

**Half one: no balance measurement ever discharges a debt.** Every payment out of a fill is a
directed pull through the relayer. The maker's delivery is a `pull` from `msg.sender` inside
`_deliverTo`, at `contracts/src/ProveSettlement.sol:3005`. The fee is the same `pull`
to `address(this)` inside `_payFee`, at `:2741`. Each names a source, a destination and
an amount, and none of the three is inferred. `fillWithCallback`'s header says why: a delta
proves the balance rose, not that the executor caused it, so `_payMaker` and `_payFee` make
payment a thing this contract does rather than a thing it infers
(`contracts/src/ProveSettlement.sol:1759`). OpenZeppelin rejected the same
instrument for this architecture in their UniswapX audit.

The balance reads inside `_deliverTo` are **not** the payment check. They bracket one forced
transfer and catch a token that taxes it. The header calls it the fee-on-transfer guard and tells
you not to delete it as a leftover of the delta design, at
`contracts/src/ProveSettlement.sol:1762`.

**Half two: nothing enters the escrow books except a directed pull attributed to a named owner.**
`deposit` pulls through the relayer at `contracts/src/ProveSettlement.sol:1152` and
credits the reservation in the next statement, keyed by the intent hash so the preimage — not the
caller — decides the owner. `_redeem` and `_pullPermit2` credit the same pair the same way.
`_drawFromParked` is the one credit with no transfer behind it, and it reads both its keys off
the intent instead. A plain `transfer` into the settlement credits nothing, and `sweepUnowned` is
the proof: it hands the unbooked balance to `defaultProceeds` and credits no reservation on the
way out, which the comment above it states as a rule at
`contracts/src/ProveSettlement.sol:1360`.

`sweepUnowned` at `contracts/src/ProveSettlement.sol:1361` subtracts every book —
reservations, booked fees and parked capital — before it computes what is unowned, so the sweep
can reach none of the three.

Section 6.1 of `docs/AUDIT-SCOPE.md` calls this the guarantee that a donation can never pay for a
fill, "which the whole architecture rests on". The unit test is
`test_ADonationDoesNotDischargeADebt`, at `contracts/test/ProveSettlement.t.sol:826`.

### Does it survive?

**Yes, and the reason is one sentence: netting changes the source address of a pull and nothing
else.** `_release` already takes its destination as an argument, at
`contracts/src/ProveSettlement.sol:3034`, and every call site passes `msg.sender` today.
Passing a counterparty's `recipient` instead does not make the transfer less directed. The amount
still comes from `_quote`. The destination still comes out of an intent. The source is still an
address the settlement chose rather than one it observed.

Now the cases.

#### Case 1 — a maker who donates to themselves

Two shapes: a maker crossing two of their own intents, and a maker naming themselves as the
counterparty's recipient. Neither reaches the guarantee, and one of them is impossible.

A maker cannot cross with themselves in one token, because `_termsOk` refuses an intent whose
`tokenIn` equals its `tokenOut`, at `contracts/src/ProveSettlement.sol:2564`. A maker
crossing two of their own intents in two tokens moves X from themselves to themselves and Y
likewise. That is a self-transfer, which moves no balance. Today `_deliverTo` reads a
self-transfer as a short delivery and reverts `Underpaid`, at
`contracts/src/ProveSettlement.sol:2994` — the shape `fillWithCallback`'s header
records, where `fill` and `fillBatch` behave the same way
(`contracts/src/ProveSettlement.sol:1784`). If the netted release keeps that
bracket, and Case 2 says it must, the self-match reverts for the same reason.

If it did not revert, the maker would advance the fill on both intents at no cost and mint a
`Filled` event. That is a wash trade, not a donation: no reservation is credited, no debt is
discharged, and nobody else's money moves. It belongs in the audit scope as a volume-reporting
hazard. It is not a break in this guarantee.

#### Case 2 — a rebasing or taxing token

**This is the case that decides the design, and it breaks a different guarantee.**

Today a token that keeps a cut of its own transfers costs the executor, not the maker.
`test_ATaxingTokenInShortsTheExecutorAndATaxingTokenOutIsRefused` at
`contracts/test/TokenMatrix.t.sol:912` asserts both halves at `:919-920`: the maker parts with
exactly what they signed, and the executor is short the tax.
`invariant_TheTaxIsPaidByTheExecutor` at `contracts/test/Invariants.t.sol:899` holds the same
property across a stateful campaign.

That is not a property of the token. It is the shape of the path. `_release` hands the take to
`msg.sender` with no bracket at all — the wallet rung's `pull` at
`contracts/src/ProveSettlement.sol:3005`, and `_releaseFromEscrow`'s `safeTransfer`
at `:3012` — and the executor is then obliged to deliver the full amount through
`_deliverTo`, which **is** bracketed. The tax lands between the two and the executor eats it.

Netting deletes the address that was eating it. If maker A's release discharges maker B's
delivery and the token keeps 1% of the transfer, maker B receives 99% of what B was owed and
nothing in the contract notices. The books still balance, `sweepUnowned` still reads a solvent
contract, and the invariant that would have caught it no longer describes the path.

**So a netted release must be bracketed exactly as `_deliverTo` brackets a delivery.** Read the
recipient's balance, move the tokens, read it again, and revert `Underpaid` when the delta is
short. That is two `_probe` calls per netted leg at the `PROBE_GAS` cap, and it is not optional.
It also means the netted path must probe `tokenIn` under `deep` the way `_evaluate` already
probes `tokenOut` before it commits — `Reason.TokenOutUnreadable` at
`contracts/src/ProveSettlement.sol:2650` — or a batch will find out inside the
transfer after it has decided not to skip.

A rebasing token needs no new rule. The escrow pays the number it booked, a gain leaves for
`defaultProceeds` through `sweepUnowned`, and a rebase down makes the contract insolvent against
its own book — `test_ARebaseDownLeavesTheEscrowBookShortOfTheBalance` at
`contracts/test/TokenMatrix.t.sol:967` measures it, and section 6.1 of `docs/AUDIT-SCOPE.md`
accepts it. Netting changes none of that, because netting changes no book. What it changes is who
is standing where when a short release lands.

**Stated plainly: the donation guarantee survives this case. A second guarantee — the maker
receives the amount, not the amount sent — does not survive it without a new bracket.** The
second is the one an auditor finds first, because there is already a named invariant standing
behind the version netting would break.

#### Case 3 — a partial fill on one side of a match

No effect on the guarantee. Part 4 has the rounding.

The reason it is safe is worth stating here anyway. `_quote` prices each leg from that leg's own
take and that leg's own curve, at `contracts/src/ProveSettlement.sol:1088`. **No quantity
is shared between the two sides of a cross**, so a partial on one side cannot change what the
other side is owed. What a partial changes is the residual, and the residual is the solver's.

#### Case 4 — a match a solver claims falsely

A false claim cannot steal, provided the settlement decides every amount and every destination.
Each destination comes out of an intent's `recipient` field, and `_termsOk` already refuses a
`recipient` that is the settlement or the `relayer`, at
`contracts/src/ProveSettlement.sol:2550`. Each amount comes from `_quote`. A solver
who claims that one leg pays another when the tokens do not cross gets a pull that either fails a
check or moves the right money to the right place anyway.

One shape must be refused explicitly: a claim naming the same leg on both sides. The refusal of
an intent whose `tokenIn` equals its `tokenOut`
(`contracts/src/ProveSettlement.sol:2564`) is the only thing standing between that and
a free spread, and it is enough — but only because it is checked against the intent rather than
against the claim. **The claim must be checked against the intents, not merely for internal
consistency.** That is the lesson `_wanted` records at
`contracts/src/ProveBatchExecutor.sol:775`: an index naming a leg the batch could not have had
must be refused rather than quietly answered, because a fallback keyed past the end of a batch
fired on every ring.

#### Case 5 — a match that pays a fee to two different `feeTo` addresses

Safe, and it is safe for a reason worth writing down.

`_book1` (`_payFee` before the fee config change) books against `_pendingFees` under the fee config that intent signed, at
`contracts/src/ProveSettlement.sol:2944`, and it moves `_totalPendingFees` in the next
statement at `:2945` so `sweepUnowned`'s subtraction stays exact. Two makers naming two
destinations in one token means two book entries. `_accrue` coalesces only a run of identical
token-and-destination pairs, so a broken run costs one transfer per leg and nothing more.

Netting does not touch any of that, whichever source pays the fee. Pulled from `msg.sender`, the
path is byte for byte what it is today. Netted — pulled from the counterparty maker's balance to
`address(this)` — it is still a directed pull of a `_quote` amount to a constant destination,
credited to the book after it lands. Both are sound.

**Prefer pulling the fee from `msg.sender` anyway.** It leaves `_payFee` untouched, it keeps the
fee out of the bracket Case 2 requires, and it preserves the property that the destination
address is never called during a fill. What netting a fee saves is one transfer on an exact
match, which Part 5 prices at a fraction of a cent.

#### Case 6 — a donation into the settlement during a netted fill

Unchanged. A stranger's `transfer` into the settlement raises the balance and credits no book. A
netted pull reads no balance to decide an amount, so it cannot spend the gift, and the gift
leaves for `defaultProceeds` on the next sweep — `swept` is the balance less the books, at
`contracts/src/ProveSettlement.sol:1365`.

**Note the coverage gap this reveals.** It is not netting's fault and it becomes netting's
problem. No invariant in `contracts/test/Invariants.t.sol` exercises a donation into the
settlement, because no handler action pushes tokens in. The settlement-side property lives in one
unit test, `test_ADonationDoesNotDischargeADebt` at
`contracts/test/ProveSettlement.t.sol:826`, and in prose. The stateful donation
invariants are on the periphery — `invariant_ADonationIsNeverSpent` at
`contracts/test/ExecutorInvariants.t.sol:97` and
`invariant_ADonationIsNeverSpentAndNothingElseRests` at
`contracts/test/RfqVenueInvariants.t.sol:66`. Netting moves the guarantee back inside the
settlement, where the machine is not currently watching it.

### The verdict

| Case | Donation guarantee | Note |
|---|---|---|
| Maker crosses with themselves | **holds** | reverts on the bracket; a wash trade, not a discharge |
| Taxing token | **holds** | but the maker-receives-what-was-promised guarantee fails without a new bracket |
| Rebasing token | **holds** | no book changes, and the insolvency section 6.1 of `docs/AUDIT-SCOPE.md` accepts is unaffected |
| Partial fill on one side | **holds** | no quantity is shared between the two sides |
| Falsely claimed match | **holds** | if the settlement decides every amount and every destination |
| Two `feeTo` addresses | **holds** | keep the fee pulled from `msg.sender` and nothing moves at all |

---

## Part 3 — What the settlement must verify, and what it can leave to the solver

Two contracts here already split this responsibility, and they split it the same way. Copy the
split; do not invent a third.

`_requireSwept` at `contracts/src/ProveBatchExecutor.sol:742` refuses an `owed` token the route's
sweep list does not name. Its own comment says the mark already covers that token, so the rule is
stricter than the marks need — and stricter on purpose, because a ring that owes a token it never
listed is running a plan that no longer matches the batch, and it should fail rather than settle
on a coincidence.

`_checkBinding` at `contracts/src/RfqVenue.sol:349` does the same job for a two-leg cross. It
refuses legs that do not mirror, at `contracts/src/RfqVenue.sol:384`, and it enforces three
properties of the mirror the binding cannot commit to, the first of them the mirror's `endTime`
at `:420`. Its comment gives the standard: the venue accepted a shape our own client never
writes, and a safety argument that rests on our own client is no argument.

**The settlement must verify these, because a wrong answer moves money:**

| Check | Why |
|---|---|
| The legs cross: each side's `tokenIn` is the other's `tokenOut` | A pull is directed at a `recipient` out of the other intent. If the tokens do not cross, that party is paid in an asset its maker never asked for |
| Each side covers the other, `delivered` plus `fee` and not `delivered` alone | A shortfall makes the settlement pull from an escrow that is not there, or from a maker who did not sign for it |
| Every amount comes from `_quote`, at `contracts/src/ProveSettlement.sol:1088`, and nowhere else | Part 5 of `docs/FEE-MODEL.md` is the rule. A netted amount from a new formula is a live quantity answering a signed question |
| Every claimed index names a leg the batch has | `_wanted` at `contracts/src/ProveBatchExecutor.sol:775` learned this the expensive way |
| Both legs pass `_evaluate`, at `contracts/src/ProveSettlement.sol:2673`, before either release lands | Unchanged from the credit batch |
| The netted release delivers what it says | Part 2, Case 2. The bracket |

**The solver may decide these, because a wrong answer costs only the solver:**

| Decision | Why it is safe to delegate |
|---|---|
| Which legs to pair | A bad pairing fails a check above and reverts. The solver pays the gas |
| How big each take is | `_evaluate` bounds it against the signed amount and the floor, and the reservation check at `contracts/src/ProveSettlement.sol:2648` bounds it again. Every size the settlement admits is a size the maker signed for |
| Whether netting beats a pool for this pair | `_quote` fixes what each maker gets, so the solver's arithmetic moves only the solver's take |
| Which token the residual lands in | The solver named the pairing |

That is the same split the credit batch already runs: the settlement decides what is owed, the
caller decides how it is raised, and the settlement pulls rather than measures. Netting adds one
row to the first table and nothing to the second.

---

## Part 4 — Partial fills, and which way the rounding must go

Partial fills are the point, because an exact cross is a coincidence and a partial cross is order
flow.

`_quote` prices a partial by scaling the curve. The `gross` is a ceiling division in `owedFor` at
`contracts/src/TakePoints.sol:91`, the `fee` is a floor in `price` at
`contracts/src/TakePoints.sol:73-83`, and `delivered` is their difference at
`contracts/src/TakePoints.sol:84`. Part 2 of `docs/FEE-MODEL.md` states the
direction: rounding favours the maker twice, once on each half of the split.

**The two sides of a cross round independently, and they must.** Each maker's number is a
function of their own take, their own curve and the block timestamp. Netting introduces no third
number, and **it must not introduce one.** A netted amount computed from both curves at once
would be a quantity with no signature behind it — a live number answering a signed question,
which is the defect class Part 5 of `docs/FEE-MODEL.md` names and which cost this repository
three defects on 2026-09-03.

So the rounding rule is a comparison rule, not an arithmetic rule:

> Compute each side with the existing `_quote`. Compare with a "greater than or equal", never
> with an equality. Send the difference to the solver.

Three properties follow.

1. **Each maker is paid the number their own signature produces.** Every existing assertion of
   the form "maker A got the rate they signed" keeps holding — the pair of assertions on
   `makerA` and `makerB` at `contracts/test/BatchExecutor.t.sol:421-422` is the two-leg case.
2. **Rounding never creates a shortfall.** Both `delivered` figures round in their maker's
   favour, so both requirements round up, and comparing two rounded-up numbers is conservative in
   the only direction that matters.
3. **The dust is the solver's cost, never a maker's loss.** A cross that rounds to one wei of
   residual is a cross the solver pays one wei to settle. It is still a cross.

The failure to write a test against is the tempting one: a cross where one side covers the
other's `delivered` but not `delivered` plus `fee`. The fee sits inside the gross rather than
beside it, but the **outlay** is still the sum. `_oweEveryLine` warns in as many words not to
reduce its allowance to the `amount`, at `contracts/src/ProveBatchExecutor.sol:915`, and
`docs/AUDIT-SCOPE.md:499` records that three sites add `amount + fee` and all three are right. A
netting check comparing against `delivered` alone would underfund every fee-charging cross by
exactly the fee.

---

## Part 5 — What it costs, measured

### Gas

Every figure came from one command, run on 2026-09-08 from `contracts/`:

```
forge test --match-path test/Gas.t.sol -vv
```

I ran it twice, because the settlement changed under me. The first column is commit `59c670f`
with a clean working tree; the second is the same commit with the uncommitted parked-capital work
in place. Use the second, and re-measure when that work lands.

| Row | Clean | With parked capital | What it is |
|---|---|---|---|
| `ring, no venue call` | 457,799 | **457,887** | a whole two-leg coincidence, settled today through `settleRing` with an empty swap list |
| `fillBatchWithCallback x1` | 117,223 | **117,311** | one credit leg, cold |
| `its marginal intent` | 53,242 | **53,242** | what each further credit leg adds |
| `the credit premium, per leg` | 505 | **505** | credit against inventory, per leg |
| `fill, allowance, warm` | 115,543 | **115,609** | one whole fill, one intent |
| `a broken run, per leg` | 7,845 | **7,845** | an uncoalesced fee transfer, per leg |

The generated table the landing page draws from is `app/src/landing/gas.ts`, written by
`node app/scripts/gen-gas.mjs` out of the same command. It carries none of the ring rows.

**What netting removes.** Not four transfers. From the settlement's own six it removes at most one
per token, and only when the residual in that token is zero. What it removes for certain is the
executor's frame: two `_sweepAbove` transfers, two `forceApprove` writes, six `balanceOf` marks
and one `settleRing` call. Against that it adds two `_probe` reads per netted leg for the bracket
Part 2 requires.

**I did not measure the netted path, because it does not exist.** The bound I can state is the
gap between what a coincidence costs today and what the settlement's own share of it is: 457,887
for the ring, against 117,311 plus 53,242, or 170,553, for two credit legs. So the executor's
frame is roughly 287,000 gas on that fixture, and netting could recover most of it and would
spend some of it back. **Unmeasured.** A row in `contracts/test/Gas.t.sol` against a prototype is
what would settle it.

### The gas in money

Two live inputs decide this, and both are dated. The only PLS price and gas price recorded in
this repository are at `docs/specs/2026-08-14-scale-and-rationing.md:23`: gas at
376,140 gwei, and 1 PLS at $0.0000097 read off the `WPLS/DAI` pair, on mainnet 369 on
2026-08-14.

| Path | Gas | PLS | USD at those inputs |
|---|---|---|---|
| a whole two-leg coincidence today | 457,887 | 172.2 | **$0.00167** |
| one warm allowance fill | 115,609 | 43.5 | **$0.00042** |

**`docs/ROADMAP.md:495` says a `fill` costs about a cent of gas here. At the only inputs this
repository records, it costs about four hundredths of a cent.** Both inputs are live quantities
and both are three weeks old, so the direction of that error is far more reliable than its size.
The claim should carry its inputs or be dropped.

### The slippage

Derived, not assumed. The curve is `poolAmountOut` at `sdk/src/solver/price.ts:73`, and the fee
constants are `PULSEX_FEE_NUM` at `sdk/src/config.ts:174` and `PULSEX_FEE_DEN` at `:176` — solved
from `getReserves` against `getAmountsOut` on three live venues rather than copied from Uniswap.

The one price-impact figure this repository asserts is at `app/src/lib/pool.test.ts:66-69`:
selling 259.4 tPLSX into the chain-943 board pair, 10,000 tPLSX against 400 tUSDC, moves the pool
2.804%. It is computed by `movePct` at `app/src/lib/pool.ts:195`. I ran
`npx vitest run src/lib/pool.test.ts` from `app/` on 2026-09-08 — twelve tests pass — and then
reproduced 2.8040% from the formula alone before using it for anything else.

From the same formula, one way, as a share of the input reserve:

| Trade size | Move against spot |
|---|---|
| 0.01% of the reserve | 0.3000% |
| 0.1% | 0.3895% |
| 0.5% | 0.7846% |
| 1% | 1.2744% |
| 2.59% | 2.8002% |
| 5% | 5.0250% |
| 10% | 9.3306% |

A cross a solver cannot net costs **two** of those, one in each direction. Selling 259.4 tPLSX
and then selling the 10.085 tUSDC back costs 2.8040% plus 2.7352%, so **5.5392% on the round
trip**. `app/scripts/heartbeat.ts:430-431` says half a percent to three percent of a reserve
moves the `price` enough to be worth an `executor`'s attention, and
`app/scripts/heartbeat.ts:219-220` measures that band on the `WPLS/PLSX` pair at $2,233 to
$10,695.

So on a $2,233 cross at that depth the pool takes about **$124**, against **$0.00167** of gas.
The pool costs about 74,000 times the gas. The roadmap is right that the payoff is not gas.

### But the payoff is already collected

**A coincidence of wants settles today with no pool.**
`test_ATwoLegRingSettlesFromAnAddressHoldingNothing` at
`contracts/test/BatchExecutor.t.sol:410` is the proof: an address holding nothing in either token
settles both legs, "maker A got the rate they signed" at `:411`, maker B likewise at `:410`, and
the caller keeps the spread. No venue is called and no sink is minted —
`test_APureCreditRingMintsNoSink` at `contracts/test/BatchExecutor.t.sol:2075` holds that
separately.

`contracts/src/RfqVenue.sol` is a second contract doing the same thing for a named counterparty.
Its header says it settles a ring of exactly two intents and holds no inventory, so the
counterparty's tokens pay the maker and the maker's tokens pay the counterparty. `LEGS` is the
constant that pins it to two, at `contracts/src/RfqVenue.sol:132`.

**So netting does not avoid that $124. The ring already avoided it.** What netting would avoid is
part of the $0.00167. That reverses the roadmap's stated payoff, and it is the single most
important sentence in this document.

---

## Part 6 — Two claims in the roadmap that this document reverses

Section 10 of `docs/AUDIT-SCOPE.md` is where this repository records claims it has had to
reverse. Both of these belong there.

| Claim | Where | What is true |
|---|---|---|
| The payoff is avoided `slippage`, not avoided gas | `docs/ROADMAP.md:494` | The slippage is already avoided. `test_ATwoLegRingSettlesFromAnAddressHoldingNothing` at `contracts/test/BatchExecutor.t.sol:410` settles a two-leg coincidence with no venue, and `LEGS` at `contracts/src/RfqVenue.sol:132` does it again for a named counterparty. Netting's marginal payoff is gas and attack surface, and Part 5 prices it at a sixth of a cent for a whole cross |
| A `fill` costs about a cent of gas here | `docs/ROADMAP.md:495` | About four hundredths of a cent, at 115,609 gas measured by `contracts/test/Gas.t.sol`, against the `gas` price and PLS price at `docs/specs/2026-08-14-scale-and-rationing.md:23`. Both of those inputs are live and dated |

A third thing is worth recording without calling it a reversal. The roadmap's "four transfers
through a solver" fairly describes the executor's path and unfairly describes the settlement's.
The settlement moves six times for a cross today, and would move six times under netting, except
on an exact match.

---

## Part 7 — What would have to be true to book it

Six things. The first three are the argument; the last three are the build.

1. **The bracket is in the design from the first commit.** A netted release that is not bracketed
   moves a taxing token's cut from the executor onto a maker, and
   `invariant_TheTaxIsPaidByTheExecutor` at `contracts/test/Invariants.t.sol:899` is a named
   invariant standing behind the version that would break. Design it in; do not add it after an
   auditor asks.
2. **Every amount still comes from `_quote`.** No new formula, no netted quantity, no shared
   rounding. Part 5 of `docs/FEE-MODEL.md` is the rule and 2026-09-03 is what it cost to learn.
3. **The claim is checked against the intents, not for internal consistency.** `_wanted` at
   `contracts/src/ProveBatchExecutor.sol:775` and `_checkBinding` at
   `contracts/src/RfqVenue.sol:349` are the two precedents, and `_drawFromParked` at
   `contracts/src/ProveSettlement.sol:2179` is the newest one: it takes both its map
   keys off the intent's preimage, so there is nothing to authorise and no check to forget.
4. **A stateful invariant covers a donation into the settlement.** There is none today. The
   property lives in one unit test, `test_ADonationDoesNotDischargeADebt` at
   `contracts/test/ProveSettlement.t.sol:826`, and netting moves it back inside the contract
   that holds every maker's escrow. Worth doing whether or not netting is booked.
5. **The gas is measured on a prototype before the design is fixed.** The 287,000-gas bound in
   Part 5 is a subtraction between two fixtures, not a measurement of the thing.
6. **It waits for #35**, the redeploy queued in `docs/ROADMAP.md`. A redeploy mints a new
   relayer and orphans every standing approval, so netting should ride a window rather than
   open one.

---

## Part 8 — What would make it not worth building

Any one of these should stop it.

**The coincidence already settles.** This is the strongest argument against, and Part 5 has the
evidence. Two contracts already do the job, one of them for exactly two legs. A third path to the
same outcome buys a fraction of a cent and adds a verification surface to the one contract that
holds every maker's escrow.

**Nobody has measured how often a coincidence occurs.** The whole case rests on real crossing
order flow, and this repository has none. `findRings` at `sdk/src/solver/rings.ts:241` enumerates
cycles, `sizeRing` at `sdk/src/solver/size.ts:274` sizes them and `planOf` at
`sdk/src/solver/plan.ts:331` prices them, so the instrument exists; what is missing is a live
board with two-sided flow to point it at. **Unmeasured.** What would measure it: run `findRings`
over a day of the 943 board and count the two-leg cycles carrying no market leg. If that count is
near zero, everything above is theory.

**It moves the coincidence check inside the settlement.** Today it lives in periphery —
`_requireSwept` and `_checkBinding` — where a bug costs a solver a transaction. Inside the
settlement a bug costs a maker their escrow. Section 4 of `docs/AUDIT-SCOPE.md` describes the
trust model that separation buys, and netting spends some of it.

**A taxing token makes it strictly worse than today.** Even with the bracket, a netted cross on a
taxing token reverts where today's ring succeeds, because today the executor absorbs the cut and
under netting nobody does. Section 6.3 of `docs/AUDIT-SCOPE.md` already accepts that a taxing
token cannot fill at full size on two rungs, and netting would widen that on a chain where such
tokens are common.

**The saving is dominated by the base cost.** 457,887 gas for a cross, of which the executor's
frame is roughly 287,000 and the two credit legs are 170,553. Even a perfect netting path pays
the legs. At the price inputs above, the whole recoverable amount is 287,000 gas, or about a
tenth of a cent per cross, and the bracket Part 2 requires spends some of it back.

---

Written 2026-09-08 against `master` at commit `59c670f`, with uncommitted work on
`contracts/src/ProveSettlement.sol` in the working tree. Gas from
`forge test --match-path test/Gas.t.sol -vv` in `contracts/`. Pool arithmetic reproduced from
`sdk/src/solver/price.ts` and checked against `npx vitest run src/lib/pool.test.ts` in `app/`. If
a number here does not hold, this file is wrong and the code is right.

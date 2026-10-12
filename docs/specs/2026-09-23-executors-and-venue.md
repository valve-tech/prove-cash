# The executors and the RFQ venue

**Status: Proposed.** Nobody has approved this document yet. It states what the contracts
around `ProveSettlement` must do. The code at `ce37983` is the thing measured against it, not
the source of it.

The owner asked for this: "we should be writing specs so that we can reference our intent against
a formal document." So this is not a tour of the code. For each contract it says what it MUST do,
what it MUST NEVER do, and why: the attack it stops or the promise it keeps to a user.

## How to read this

**MUST** and **MUST NOT** are requirements. **MAY** is a permission. Each requirement has an ID,
such as `EX-5`, and the Traceability table at the end maps each ID to the tests that hold it.

Each requirement names its source. The sources are not equal, so each one carries a grade:

| Grade | Meaning |
|---|---|
| **[O]** | The owner decided it, in words the owner wrote or approved. |
| **[D]** | A committed document states it as a requirement or a decision: `docs/AUDIT-SCOPE.md`, the internal risk assessment, `docs/ECON-AUDIT.md`, or a spec in this folder. |
| **[C]** | A commit message states it as a decision, with its reason. |
| **[H]** | Only the contract's own NatSpec states it. The code does it and says why, but no document outside the code records it as intent. |

An **[H]** requirement is not promoted to intent here. Each one is listed in
[Open questions](#open-questions-owner) so that the owner can confirm or reject it. Where no source
states any intent, the text says **OPEN QUESTION (owner)** and gives options.

Code is cited by symbol, never by line number. Commits are cited by short hash.

## Scope

| Contract | File | Role |
|---|---|---|
| `ProveRelayer` | `contracts/src/ProveRelayer.sol` | Holds every maker's ERC-20 allowance. Moves tokens only when the settlement asks. |
| `ProveExecutor` | `contracts/src/ProveExecutor.sol` | Fills one intent with no inventory, through one venue call. |
| `ProveCallSink` | `contracts/src/ProveCallSink.sol` | Makes the venue call, from one clone per caller, so that no executor does. |
| `ProveBatchExecutor` | `contracts/src/ProveBatchExecutor.sol` | Settles a ring or batch of intents on credit, with buy-side swaps and disposals. |
| `ProveBatchExecutorCallSink` | none of its own | The deployment-record name of the `ProveCallSink` template that `ProveBatchExecutor` deploys. See [its section](#provebatchexecutorcallsink). |
| `RfqVenue` | `contracts/src/RfqVenue.sol` | Settles one exclusive quote against its counterparty's mirror intent. |

`ProveSettlement` is out of scope. This document states only what these contracts rely on it to
do, in [What the periphery relies on](#what-the-periphery-relies-on-in-the-settlement).

`FeeSink` is out of scope. The approved spec `2026-09-23-fee-sink-fixed-destination.md` governs it.
That spec changes one thing here: an intent's `feeTo` must be a registered sink. The effect on the
venue is in [RV-18](#rfqvenue).

Rejected work is out of scope. The split-sink code in `ad661e0` is rejected, and nothing here
depends on it.

---

## Rules that hold for every contract in scope

These rules apply to the relayer, both executors, the call sink and the venue unless a section says
otherwise.

**G-1. No owner, no admin, no upgrade.** Each contract MUST have no owner, no operator, no pause,
no setter and no upgrade path. Every address it depends on MUST be an immutable set in its
constructor.
*Why:* an admin key over a contract that touches maker funds is a key worth stealing, and a setter
can move between the moment a user signs and the moment the transaction lands.
*Source:* [C] `f66303a` ("no owner, no writable storage, no upgrade path"); [C] `1681708`
("written once, unowned, for everybody"); [C] `6779256` ("no owner, no operator, no setter").

**G-2. Nothing held between transactions.** At the end of every transaction, each contract MUST
hold the same balance of each token the entry names as it held at the start. It MUST NOT carry any
allowance it granted. The only exceptions are listed per contract: the sink's strand, the venue's
`spent` book, the reentrancy words, and a token a venue pays that the route never named. [Holdings](#what-each-contract-may-hold-and-for-how-long)
gives the proof for each contract.
*Why:* a contract that holds something between transactions is a target, and its balance can be
mistaken for payment.
*Source:* [C] `1681708` ("The contract holds nothing between transactions and sweeps to its
caller"); [D] `AUDIT-SCOPE.md` §4, "What a malicious solver can do".

G-2 is deliberately weaker than "holds nothing". A donation stays where it lands, and so does a
token a route forgets to name. [D] `AUDIT-SCOPE.md` §6.8 accepts that "A token forgotten by a route
strands on the executor for ever". Several contract headers still say "holds nothing". See
[OQ-2](#open-questions-owner).

**G-3. A donation is never spent.** An executor or the venue MUST measure each token it names
before it calls the settlement. It MUST revert if it would end below that mark. It MUST hand on
only the increase.
*Why:* the settlement pulls each payment from the executor with a directed `transferFrom`. A
balance that was already there could pay a maker, which lets a stranger's gift fund somebody
else's fill. A sweep of the whole balance would also hand the gift to whoever called next.
*Source:* [C] `46c0f09` ("A donated balance could pay for a fill"); [D] `AUDIT-SCOPE.md` §4,
"Cannot: Spend a balance that was donated to an executor rather than earned".

**G-4. Approve the relayer, never the settlement.** Where a contract must let the settlement take
a payment, it MUST approve `settlement.relayer()`, read in its constructor. It MUST approve the
exact sum the settlement will pull, so that no allowance survives the transaction.
*Why:* `ProveRelayer` is the only address that calls `transferFrom`. An allowance on the settlement
would put allowances back on the contract that calls strangers.
*Source:* [D] `AUDIT-SCOPE.md` §4, "Why the relayer holds the allowances", rule 3; [H]
`IProveCallback` and `IProveBatchCallback` NatSpec.

**G-5. Only the settlement calls a callback.** `proveCallback` and `proveBatchCallback` MUST revert
`NotSettlement` for any other caller.
*Why:* the callback approves the relayer and drives a sink. The settlement calls back only the
address that called it, so this check keeps the payload one that the contract wrote itself.
*Source:* [C] `1681708`; [H] `proveBatchCallback` NatSpec in both contracts.

**G-6. The relayer and the settlement are never a target.** No caller-supplied `target` or
`spender` may be the relayer or the settlement.
*Why:* the relayer obeys the settlement. A call that reaches either one with a caller's calldata
reaches every maker's allowance. This is rule 2 of the relayer split.
*Source:* [D] `AUDIT-SCOPE.md` §4, rule 2; [C] `f66303a` ("Without it the split is decorative").

**G-7. One entry at a time.** Each executor and the venue MUST refuse reentry into its own entry
point (`Reentered`).
*Why:* a venue the caller chose runs inside the entry. It must not start a second entry that reads
half-written marks.
*Source:* [C] `1681708` ("a venue that reenters"); [D] `AUDIT-SCOPE.md` §4, "Re-enter a fill".

**G-8. Wrapped tokens only.** No contract in scope has a `receive` or `fallback`. A route that
pays native currency MUST revert.
*Why:* a venue that refunds gas currency, or a route that unwraps to it, has nowhere to land.
*Source:* [D] `AUDIT-SCOPE.md` §6.8, "Native currency is not supported anywhere" (an accepted
limit).

**G-9. One `Intent` mirror.** `IProveSettlementFill.Intent` MUST match `ProveSettlement.Intent`
field for field. `ProveBatchExecutor` and `RfqVenue` MUST import it, not type a second copy.
*Why:* the compiler does not compare them. A drift builds, deploys and reverts every call.
*Source:* [D] `AUDIT-SCOPE.md` §6.8 ("`ProveExecutor`'s `Intent` struct is a hand-kept copy the
compiler does not check"; the mitigation is `test/Executor.t.sol`); [H] `IProveSettlementBatch`
NatSpec for the single import.

**G-10. Bound to one settlement.** Each executor and the venue MUST read `relayer()` from its
settlement in its constructor, and MUST refuse a settlement with no code or a zero relayer
(`BadSettlement`). A settlement redeploy MUST redeploy all of them.
*Why:* a periphery contract bound to a dead settlement settles nothing, and one bound to the wrong
relayer approves an address that pulls nothing.
*Source:* [D] `docs/ROADMAP.md`: "**Redeploying the settlement means redeploying both**, or a quote
and a ring point at a settlement nobody uses."

---

## ProveRelayer

The relayer is the address a maker approves. It holds allowances and nothing else.

**RL-1.** `pull` and `pullWithPermit2` MUST revert `NotSettlement` for every caller except
`settlement`.
*Why:* the relayer can spend every allowance any maker ever granted. The blast radius of any caller
that reaches it is the sum of all approvals.
*Source:* [O] `2026-08-12-hooks-design.md`, amendment of 2026-08-13: "The relayer split shipped.
The owner took it". The rule it leaves, from §5 rule 2 of the same doc: "no call site may target
the relayer, and no maker allowance may live on the settlement." Also [C] `f66303a`; [D]
`AUDIT-SCOPE.md` §4, "Why the relayer holds the allowances".

**RL-2.** `settlement` MUST be the deployer, and the settlement MUST deploy the relayer in its own
constructor. `permit2` MUST be an immutable handed down by that constructor. The relayer MUST
write no storage.
*Why:* the two contracts point at each other with no initializer and no window in which either is
wrong.
*Source:* [C] `f66303a`.

**RL-3.** `pullWithPermit2` MUST send only to `settlement`. It MUST NOT take a destination
parameter. It MUST call only `permit2`.
*Why:* a Permit2 maker granted the relayer nothing. A destination parameter would let a future call
site aim a maker's Permit2 balance where the maker never named. Every such transfer credits a
reservation, and only the settlement holds reservations.
*Source:* [C] `7f4620c`; [D] `AUDIT-SCOPE.md` §4 ("`pullWithPermit2` does not").

**RL-4.** `pull` MUST use `SafeERC20`. A token that returns `false` MUST read as a failure, and a
token that returns nothing MUST read as a success.
*Source:* [C] `36701c9` (the guard "no test defended", now pinned).

**RL-5.** `pullWithPermit2` MUST NOT catch a Permit2 refusal. It MUST NOT pre-read the Permit2
nonce bitmap.
*Why:* the settlement calls it inside the revertable arming frame, so a revert costs one skipped
leg. The pre-read was measured and pays only when more than 31% of armed Permit2 legs meet a burnt
nonce.
*Source:* [C] `f457494` ("the nonce pre-check, measured and not taken").

**What the relayer relies on.** The settlement MUST refuse the relayer as a callback caller
(`callableTarget`), as a `recipient` and as a `feeTo`. Without these, the split is decorative.
This spec does not own those checks. It lists them so that a change to the settlement is checked
against them.

---

## ProveExecutor

`ProveExecutor` fills one intent through `fillWithCallback`. It sells the maker's token A at one
venue the caller names and hands the caller the spread.

### Who may call

**EX-1.** `fill` MUST be open to any caller.
*Source:* [C] `1681708` ("so an EOA can fill from any venue").

**EX-2.** `proveCallback` MUST be open only to the settlement (G-5).

### What it must do

**EX-3. It never makes the caller's call.** Every venue call MUST run from the caller's own
`ProveCallSink` clone. No caller calldata may execute with the executor as `msg.sender`.
*Why:* a contract that both runs arbitrary calldata and may be granted an allowance is Transit Swap
($23M). A selector denylist does not close it, because the set of ways to spend an allowance is
open: ERC-4626 `redeem`, ERC-721 `safeTransferFrom`, Permit2, ERC-777 `operatorSend`, credit
delegation, `multicall`.
*Source:* [C] `46c0f09` ("The selector denylist was wrong in kind, not in detail"). This reverses
the backstop that `1681708` shipped ("the transferFrom selector is refused outright").

**EX-4.** `proveCallback` MUST revert `ForbiddenTarget` when `Swap.target` or `Swap.spender` is the
relayer or the settlement (G-6).
*Source:* [C] `1681708` ("rejects it as a target and as a spender").

**EX-5. Marks.** `fill` MUST read its balance of `tokenIn`, `tokenOut` and every `Swap.extra`
before it calls the settlement. After the call it MUST revert `BalanceWentDown` if any balance is
below its mark, and MUST send only the increase to `msg.sender` (G-3).
*Source:* [C] `46c0f09` for the two intent tokens; [C] `b76eea3` for `extra` ("an extra token had
no mark, so a donation left with the caller").

**EX-6.** `fill` MUST revert `IntentTokenInExtra` if `Swap.extra` names `tokenIn` or `tokenOut`.
*Why:* one token swept twice against two marks makes the second mark meaningless.
*Source:* [H].

**EX-7. The venue gets what arrived.** `proveCallback` MUST measure what reached the sink as a
balance difference and hand the sink that figure. The sink then approves the venue for it, not for
`amountIn` and not for the sink's whole balance.
*Why:* a token that taxes its transfers delivers less than `amountIn`. The sink may also hold an
earlier strand or a gift, and the venue must not spend it.
*Source:* [H]. The strand half follows from [C] `21a4240`.

**EX-8. The proceeds are here.** Before it approves the relayer, `proveCallback` MUST check that
the executor holds at least `amountOwed` of `tokenOut`. If not, it MUST revert
`ProceedsNotHere(token, held, owed)`.
*Why:* a payout aimed at `sinkTemplate` or at any address that does not sweep otherwise fails deep
in the token with a message that names nothing. The check refuses nothing that used to settle.
*Source:* [C] `4ba9a66`.

**EX-9.** `proveCallback` MUST approve the relayer for exactly `amountOwed` (G-4).

**EX-10.** `fill` MUST pass `maxFeeRate` to the settlement unchanged.
*Why:* the caller bounds the rate the fill touches. The executor must not widen that bound.
*Source:* [D] `AUDIT-SCOPE.md` §4, "Engage a caller with a fee destination the caller refused".

**EX-11. The template is not a destination.** `sinkTemplate` MUST never be driven and MUST never
hold anything. `sinkFor(caller)` MUST return the address of `caller`'s clone, before and after it
exists.
*Why:* the 369 fork rehearsal lost a run to a payout aimed at the template, when the accessor was
still called `sink()`.
*Source:* [C] `4ba9a66`.

### What it must never do

- It MUST NEVER sweep a balance that was there before the fill (EX-5).
- It MUST NEVER let a donation pay the maker (EX-5, G-3).
- It MUST NEVER approve anything to the settlement (G-4).
- It MUST NEVER run caller calldata itself (EX-3).

### What the user is promised

The maker cannot lose tokens without being paid, whatever the caller does. The release and the
payment are in one transaction, so a venue that underpays or a caller that walks off makes the
settlement's pull fail, and the whole fill reverts. That promise comes from the settlement, not
from the executor. It rests on the settlement's refusal of `tokenIn == tokenOut`.
*Source:* [H] `ProveExecutor` header; [D] `AUDIT-SCOPE.md` §4, "Cannot: Pay a maker with the
maker's own token".

---

## ProveCallSink

The sink is the address that makes the arbitrary venue call, so that the executor does not. It is
the relayer split one level down.

### Who may call

**CS-1.** `run` MUST revert `NotExecutor` for every caller except `executor`. In a clone,
`executor` MUST read as the address that deployed the template, because the immutable lives in the
template's code.
*Source:* [C] `3432bfb` ("The immutable survives cloning, proved rather than assumed").

### One clone per caller

**CS-2.** Each executor MUST deploy its own template in its constructor. It MUST drive one
EIP-1167 clone per caller, at `cloneDeterministic(template, salt = caller)`. It MUST mint the clone
on the caller's first entry that makes a venue call, and MUST reuse it on every later entry. No
caller's entry may drive another caller's clone.
*Why:* this is the answer to the pre-armed approval vector below. Only the sink can grant an
allowance over the sink's own balance, and only the caller's own entry makes their sink run. So
an `approve` that a caller's calldata writes is a claim on that caller's own money.
*Source:* [C] `21a4240`; [D] `AUDIT-SCOPE.md` §4 ("that — not obscurity — is the argument").

**CS-3.** The template MUST never be driven. `run` MUST revert `ForbiddenTarget` when `target` is
the executor, the clone itself or the template, or when `spender` is the executor.
*Why:* a call aimed back at the executor drives it with the sink's authority. The clone and the
template are both "the sink" to a caller.
*Source:* [C] `3432bfb` (template and self); [C] `36701c9` (the `spender == executor` clause, now
pinned).

### What `run` must do

**CS-4.** `run` MUST approve `spender` for exactly `amountIn` of `tokenIn`, make the call, and set
that allowance back to zero before it returns.
*Source:* [C] `1681708` ("Approvals are for exact amounts and reset to zero inside the same call").

**CS-5.** If the venue call fails, `run` MUST revert `SwapFailed` with the reason cut to 256 bytes.
It MUST NOT swallow the failure.
*Why:* a swallowed failure on the buy side leaves the maker's payment unfunded, and the revert
reason from a hostile target must not cost the caller quadratic memory.
*Source:* [H] for the clip. [C] `6318d83` for the revert ("reverts with the router's
INSUFFICIENT_OUTPUT_AMOUNT inside SwapFailed, and the maker keeps their tokens").

**CS-6.** After the call, `run` MUST send its whole balance of `tokenOut`, `tokenIn` and every
`extra` to the executor.

### What it may hold

**CS-7.** A clone MAY keep a token its caller did not name. That token is the caller's strand. Only
that caller's later entry can move it, by naming it. A recovered strand MAY pay that caller's own
makers inside the recovering transaction.
*Why:* recovery was the reason to move from one clone per transaction to one per caller.
*Source:* [C] `21a4240` ("What comes back is recovery"); [D] `AUDIT-SCOPE.md` §4.

**CS-8. Accepted residual.** An `approve` written by the caller's own calldata outlives the call. It
reaches only that caller's own clone. A caller that is itself a public contract shares one clone
among its users, so one of them can arm a claim on what another strands there. That is the author
of that contract's choice.
*Source:* [D] `AUDIT-SCOPE.md` §4 ("the caveat the header keeps"); [C] `21a4240`.

### The pre-armed approval vector, and how it was closed

This is issue #112, closed in `3432bfb` and refined in `21a4240`.

The attack worked on one sink shared by every caller:

1. The attacker sent one cheap `settleRing`: no legs, one swap, `amountIn` zero, `target` a token, `data`
   an `approve` naming the attacker, and a `spender` that was some other address. The sink's reset
   in CS-4 cleared the allowance of `spender`, not of the attacker, so the approval stayed.
2. A later solver's venue paid a token that their route did not name. The token stranded on the
   shared sink.
3. The attacker called `transferFrom` on the token and took it.

The cheap fix does not work. Refusing a `target` equal to `tokenIn`, `tokenOut` or any `extra`
matches only the first exploit's shape. Name a worthless token on both sides, aim `target` at the
victim token, and the approval is still written.
*Source:* [C] `3432bfb`.

The fix is CS-2. The attacker can still arm an approval, but only on their own clone, which holds
only their own strand. Predicting a victim's clone address buys nothing, because a clone only runs
inside its own caller's entry.

**CS-9.** No change may reintroduce a sink that two callers drive. Any future executor MUST keep
CS-2.
*Source:* [C] `3432bfb`, `21a4240`.

---

## ProveBatchExecutor

`ProveBatchExecutor` settles several intents through `fillBatchWithCallback`. The settlement
releases every leg's token A, calls back once, then pulls every payment. So a ring of intents that
pay each other needs no working capital.

The credit path itself is an owner decision. [O] `2026-08-12-hooks-design.md`, amendment of
2026-08-12: "`fillBatchWithCallback` shipped. The owner reversed the call below and asked for it."

### Who may call

**BX-1.** `settleRing` MUST be open to any caller. `proveBatchCallback` MUST be open only to the
settlement (G-5). `sellSurplus` MUST be open only to the contract itself; it is external only so
that `settleRing` can `try` it.
*Source:* [H] for `sellSurplus`. [C] `f60f79e` for the open entry.

### The credit path

**BX-2. Order.** Buy-side swaps (`Route.swaps`) MUST run inside the callback, before the settlement
pulls. Disposals (`Route.disposal`) MUST run after `fillBatchWithCallback` returns, when every
payment has been pulled.
*Why:* the buy side spends tokens that are owed to makers. A disposal spends only the caller's own
surplus, because by then there is no payment left to reach.
*Source:* [C] `32d1de3`; [H] `Route.disposal` NatSpec.

**BX-3. Marks over every named token.** `settleRing` MUST mark every token the route names in any
field: `Route.sweep`, and the `tokenIn`, `tokenOut` and `extra` of every swap and every disposal.
After the ring it MUST revert `BalanceWentDown` below any mark, and MUST send only increases to
`msg.sender` (G-3).
*Why:* marking only the sweep list let a caller name a donation as a swap's `tokenIn`, sell it and
sweep the proceeds against a mark of zero. A token named only in `tokenOut` also used to strand for
ever, because a later ring marks the strand first.
*Source:* [D] `AUDIT-SCOPE.md` §4 ("`ProveBatchExecutor._tokensNamedBy` collects the sweep list,
every swap's two tokens and every `extra`"); [H] `settleRing` NatSpec for the stranding reason.

**BX-4. Every owed token is on the sweep list.** `proveBatchCallback` MUST revert
`OwedTokenNotSwept` when an `owed` line pays in a token that `Route.sweep` does not name.
*Why:* the sweep list is where the route states what it expects to pay in. A ring that owes a token
it never listed is running a plan that does not match the batch. It must fail, not settle by
coincidence.
*Source:* [D] `AUDIT-SCOPE.md` §4 ("`_requireSwept` also refuses an `owed` token the sweep list does
not name"); [H] `_requireSwept` NatSpec.

**BX-5. One allowance per token.** `proveBatchCallback` MUST approve the relayer, per token, for
the sum of `amount + fee` over every `owed` line in that token. It MUST check that it holds that
sum first, and revert `ProceedsNotHere` if not.
*Why:* `forceApprove` writes an exact value, so a per-line approval would let the second line
replace the first. The sum must be `amount + fee`, never `amount`, because the fee comes out of the
maker's number and the settlement pulls both.
*Source:* [C] `4ba9a66` (the check); [C] `d1dd385` (the sum); [D] `AUDIT-SCOPE.md` §4, "Three sites
add `amount + fee`, and all three are right".

**BX-6.** `_sell` MUST refuse the relayer and the settlement as `target` or `spender` (G-6). It MUST
approve the venue only for what reached the sink, as EX-7 says.

**BX-7. No patch on the buy side.** A buy-side swap MUST have `amountOffset == NO_PATCH`, or the
callback reverts `PatchOnTheBuySide`.
*Why:* "whatever I hold" on the buy side includes the makers' payments.
*Source:* [C] `c4d69da`; [H].

**BX-8. A pure credit ring mints no sink.** A route with no swaps and no disposals MUST NOT create
a clone.
*Source:* [C] `21a4240` ("A pure credit ring still mints nothing").

### Tolerant rings and the `WHEN_ABSENT` fallback

**BX-9. `skipInvalid` is the caller's flag.** `settleRing` MUST pass `skipInvalid` and
`maxFeeRate` to the settlement unchanged. The contract decides nothing about atomicity. A solver
that needs an unbroken ring passes `false` and gets exactly that.
*Source:* [C] `7d038a9` ("**The caller decides, and this contract decides nothing.**" The author
corrected an earlier draft that read "as us choosing for the solver").

This is the contract's stance, not the solver's policy. Our own solver still passes `false`:
[D] `2026-08-12-solver-design.md` says "A ring is atomic or it is nothing", and [D]
`docs/ROADMAP.md` says "`--tolerant` is off and stays off until a live board says the loss rate
clears the break-even". The two do not conflict.

**BX-10. Fewer lines are ordinary.** `proveBatchCallback` MUST accept fewer `owed` lines than
`Route.legs`. It MUST revert `LegCountMismatch` on more.
*Why:* a batch is not a ring. If six of eight legs arm, the caller owes six. `Payment.leg` names
which six.
*Source:* [C] `2339577`; [D] `AUDIT-SCOPE.md` §9.3 (asked of the auditor, not yet answered).

**BX-11. `Swap.leg` semantics.** For every swap and every disposal:

| `Swap.leg` | The call runs when |
|---|---|
| `ANY_LEG` (`type(uint256).max`) | always |
| `k` | leg `k` settled |
| `k \| WHEN_ABSENT` | leg `k` did not settle |

`ANY_LEG` MUST be tested before the `WHEN_ABSENT` bit is masked off. A call and its fallback for
the same `k` MUST be mutually exclusive: exactly one runs.
*Why:* a ring short one leg is short the token that leg would have supplied. The fallback buys it
at market, so the ring closes with a market leg in the hole.
*Source:* [C] `7d038a9`.

**BX-12. The fallback bound.** A leg index MUST name a leg the batch carried. `settleRing` MUST
revert `LegsExceedBatch` when `Route.legs > reqs.length`. `_wanted` MUST revert `LegOutOfRange` when
the index, with `WHEN_ABSENT` masked off, is `>= Route.legs`. Both checks MUST run before the first
venue call.
*Why:* `owed` lists only the legs that settled. "Leg 7 is absent" cannot tell a leg that went
missing from a leg that never existed. Before the bound, a fallback keyed past the end of the batch
fired on every ring and spent tokens the settlement was about to pull. Bounding against
`Route.legs` alone "would have been theatre", because the caller writes that number. So the index
is bound against `Route.legs`, and `Route.legs` against `reqs.length`.
*Source:* [C] `36701c9` (#113); [D] `AUDIT-SCOPE.md` §4 ("Name a leg the batch never carried") and
§9.2.

**BX-13. The `WHEN_ABSENT` bit is free.** The encoding MUST NOT depend on any off-chain cap on batch
size. It rests on the fact that no calldata array can reach `2^255` elements.
*Why:* `MAX_BATCH_LEGS` is a constant in our own solver. "A safety argument that rests on our own
client is no argument."
*Source:* [C] `20e62e4`; [D] `AUDIT-SCOPE.md` §9.2.

### Disposals

**BX-14. Best effort.** Each disposal MUST run in its own frame through `this.sellSurplus`. A
failure MUST be caught, MUST emit `SurplusUnsold`, and MUST leave the token to sweep home unsold.
*Why:* a batch that has paid every maker must not be undone because a pool moved during the
caller's own tidying up. Only the caller loses either way.
*Source:* [C] `32d1de3`; [H] `Route.disposal` NatSpec.

**BX-15. Never into the mark.** A disposal MUST NOT sell more than this batch earned in its
`tokenIn`. `sellSurplus` MUST revert `OversizedDisposal` before it calls the venue.
*Why:* an oversized disposal once spent into a donation, succeeded, and then `_sweepAbove` reverted
the whole ring outside every frame. One donation armed that against every solver.
*Source:* [C] `36701c9` (#113); [D] `AUDIT-SCOPE.md` §4, "Oversize a disposal".

**BX-16. A patched amount carries its bound.** A disposal that sets `amountOffset` MUST set
`minOutOffset` (`PatchWithoutBound`). The contract MUST write the amount and
`amount * minOutPerIn / 1e18` together. It MUST revert `NothingToSell` when the increase is zero,
and `PatchOutOfRange` when a word would fall outside the calldata.
*Why:* patching the amount up and leaving the floor alone sells more for the same floor, quietly.
*Source:* [C] `c4d69da`; [C] `36701c9` ("The disposal's slippage bound could be written as zero").

**BX-17. The disposal filter.** A disposal MUST read `Swap.leg` on the same terms as a buy-side
swap (BX-11). The callback MUST decide it, because only the callback sees `owed`. The answer MUST
travel in `_skipDisposal`, one bit per disposal, and `settleRing` MUST clear it in the same
transaction. A route MUST NOT carry more than `MAX_DISPOSALS` (256) disposals (`TooManyDisposals`).
*Source:* [C] `36701c9`; [D] `AUDIT-SCOPE.md` §9.2 and §9.6.

---

## ProveBatchExecutorCallSink

There is no contract by this name in `contracts/src`. It is the key that
`contracts/deployments/943.json` gives to the `ProveCallSink` template that `ProveBatchExecutor`
deploys in its constructor. The 369 record calls the same thing `ProveBatchCallSink`
(`app/scripts/deployment.ts`). `contracts/tools/verify-bytecode.mjs` maps it to the `ProveCallSink`
artifact.

**BS-1.** Every requirement in [ProveCallSink](#provecallsink) applies to it unchanged.

**BS-2.** Its `executor` MUST be `ProveBatchExecutor`, never `ProveExecutor`. The two executors'
templates, and so their clones, MUST be disjoint.
*Why:* a clone of one executor's template must not answer to the other. Salts cannot collide
across executors, because the prediction reads the deployer's own address.
*Source:* [H] `ProveBatchExecutor` constructor and `_sinkFor` NatSpec; [D] `AUDIT-SCOPE.md` §9.4
asks the auditor to confirm it.

See [OQ-8](#open-questions-owner) on the two record names.

---

## RfqVenue

`RfqVenue` lets a maker reserve a price for one named counterparty. The counterparty accepts by
signing an ordinary intent, the mirror, and sends no transaction. Anybody may submit the pair, pay
the gas and keep the spread.

### Who may call

**RV-1.** `settleExclusive` MUST be open to any caller. The submitter MUST receive every token the
ring leaves above the venue's marks.
*Why:* the spread is what pays a submitter's gas. The settlement collects the quote's own fee. The
venue prices nothing. (There is no protocol fee; see F-2 item 2.)
*Source:* [C] `6779256` ("anybody can submit the pair").

**RV-2.** `proveBatchCallback` MUST be open only to the settlement (G-5).

### Binding semantics

**RV-3. Exclusivity rides on `Intent.executor`.** The quote's `executor` MUST be the venue
(`QuoteNotExclusiveToThisVenue`), and so MUST the mirror's (`MirrorNotExclusiveToThisVenue`).
*Why:* the settlement refuses an executor that is not `msg.sender`, but accepts `executor == 0`
from anybody. A quote with an open executor is a public order and the binding guards nothing. A
mirror with an open executor is a standing public order at the counterparty's rate.
*Source:* [C] `6779256` ("that second check is the one that is easy to miss"); [D]
`AUDIT-SCOPE.md` §4, "The RFQ venue".

**RV-4. The binding.** The quote's maker MUST sign `Exclusive(intentHash, counterparty, take,
expiry, nonce)` under the venue's own EIP-712 domain (`"prove.cash rfq"`, `"1"`, chain id, venue
address). The venue MUST refuse a binding that:

- is at or past `expiry` (`BindingExpired`);
- names a `take` other than `reqs[0].take` (`TakeNotBound`);
- names an `intentHash` other than `settlement.hashIntent(quote)` (`BindingIsForAnotherIntent`);
- has been spent (`BindingSpent`);
- is not signed by `quote.maker`, by ECDSA or by ERC-1271 (`BadBinding`).

*Why:* the counterparty can prove before signing that the price is theirs and settles only here.
The maker cannot widen the audience later, because that needs a new signature. `intentHash`
commits to all seventeen terms of the quote, the rate included.
*Source:* [C] `6779256`; [D] `AUDIT-SCOPE.md` §4, "The RFQ venue".

**RV-5. The settlement decides the hash.** The venue MUST ask `settlement.hashIntent` and MUST NOT
keep its own copy of the intent's EIP-712 encoding.
*Source:* [H] `IProveSettlementHash` NatSpec.

**RV-6. One shot.** A binding MUST settle once. The venue MUST key `spent` by the binding's EIP-712
digest and MUST write it before it calls the settlement.
*Why:* a repeatable binding needs a second ledger beside `ProveSettlement.filled`, "and two books
for one order is where money goes missing". Over a Dutch quote it is also a free option. A maker
who wants slices signs one binding per slice.
*Source:* [C] `6779256` ("A binding settles once").

**RV-7. ERC-1271 bounds.** A contract maker's `isValidSignature` MUST run under a 60,000 gas cap.
The venue MUST decode the answer as a whole word, and MUST read a failure or a short answer as "did
not sign", not as a revert.
*Source:* [H]; the settlement's own rule in [D] `AUDIT-SCOPE.md` §4 ("Capped at 60,000 gas").

### The mirror check

**RV-8. It is a mirror.** The mirror's `tokenIn` MUST be the quote's `tokenOut` and its `tokenOut`
the quote's `tokenIn` (`NotAMirror`). The mirror's maker MUST be `ex.counterparty`
(`NotTheCounterparty`).

**RV-9. The acceptance dies with its deal.** The mirror MUST NOT end after `ex.expiry`
(`MirrorOutlivesTheBinding`). It MUST be flat, `minOutStart == minOutEnd` (`MirrorIsNotFlat`). It
MUST be taken whole, `reqs[1].take == mirror.amountIn` (`MirrorNotTakenWhole`).
*Why:* `Exclusive` commits to the quote and to nothing about the mirror, because the maker signs
first. Without these three, a rogue could mint their own quote for the same pair, sign their own
`Exclusive` naming the same counterparty, and settle the acceptance against it. A reviewer ran it:
the counterparty got 500.11 A where their own rate said 900.
*Source:* [C] `55091bd`; [D] `AUDIT-SCOPE.md` §4 and §9.5.

**RV-10. Exactly two legs.** `settleExclusive` MUST take exactly two requests, quote then mirror
(`NotTwoLegs`). It MUST pass `skipInvalid = false`, and `maxFeeRate` unchanged. The callback MUST refuse any `owed` that is not
two lines, and `settleExclusive` MUST refuse a count that is not two (`LegCountMismatch`).
*Why:* a two-leg ring with one leg stepped over is not a ring. The surviving maker's tokens would
be released with no payment behind them.
*Source:* [H] `settleExclusive` NatSpec.

### The spread and the money path

**RV-11. No inventory.** The venue MUST settle through `fillBatchWithCallback`, so the
counterparty's tokens pay the maker and the maker's tokens pay the counterparty.
*Source:* [C] `6779256`.

**RV-12. Marks from the intents.** `settleExclusive` MUST mark the quote's `tokenIn` and `tokenOut`,
read from the intent and not from a caller's list, before the ring. It MUST revert
`BalanceWentDown` below either mark and send only the increase to `msg.sender` (G-3). The callback
MUST revert `OwedTokenNotMarked` unless line 0 pays in the quote's `tokenOut` and line 1 in its
`tokenIn`.
*Source:* [C] `6779256` ("it comes out of the spread by the same clause that protects a
donation"); [H] for `OwedTokenNotMarked`.

**RV-13.** The callback MUST approve the relayer for `amount + fee` on each line, and nothing else
(G-4).

**RV-14. No fee of its own.** The venue MUST NOT charge, collect or cap a fee. The exclusivity fee
is the quote's own `Intent.feeRate`, paid to the quote's own `feeTo`, pulled by the settlement.
*Why:* an owner-set rate can move between the counterparty signing and the transaction landing.
The binding's `intentHash` commits the counterparty to the rate they read.
*Source:* [C] `6779256` ("The exclusivity fee is signed, not owner-set"); [C] `25e699e`, which moved
the rate from the binding into `Intent.feeRate` and deleted `MAX_EXCLUSIVE_FEE_BPS`.

**RV-15. A zero spread is allowed.** A mirror that leaves exactly the quote's gross MUST close the
ring. The submitter then takes zero.
*Source:* [D] `AUDIT-SCOPE.md` §4 ("A zero-spread quote is now fillable ... records the change and
its acceptance").

**RV-16. No caller-chosen call.** The venue MUST call nothing but the settlement, the two tokens the
two intents name, and a contract maker's `isValidSignature`. It has no sink and takes no target or
calldata.
*Why:* an allowance granted to the venue is then unreachable.
*Source:* [C] `6779256` ("no `ProveCallSink` — a two-leg ring names no venue").

### Quote encryption

The encryption of a quote to its counterparty is done off chain, in the app and SDK. The venue has
no encryption code and reads no ciphertext.

**RV-17. The venue relies on no secrecy.** Every requirement above MUST hold when the quote, the
binding and the mirror are all public. Exclusivity comes from RV-3 and RV-4, not from who can read
the quote.
*Why:* a guarantee that rests on our own client is no guarantee. Anyone may read a mempool.

What secrecy buys is off-chain only: other takers do not learn the private price. What it cannot
buy is protection from a searcher who copies a submitted pair and outbids the submitter. That
attack is open. "The answer is private orderflow."
*Source:* [C] `6779256` ("Two attacks stay open and neither is closable here").

What the SDK does today, for the record and not as a requirement on the contract:

- The counterparty signs `'prove.cash rfq key v1'`. HKDF-SHA256 turns that signature into an
  x25519 key pair. The secret half is never stored. A signed key announcement puts the public half
  on the board. Only ECDSA announcements count, so a contract wallet cannot receive a sealed
  quote (`sdk/src/rfq.ts`).
- Each quote is sealed to that key with a fresh ephemeral x25519 key and XChaCha20-Poly1305
  (`sdk/src/rfq-crypto.ts`). The terms are hidden. The counterparty address rides in clear.
- Quotes travel on their own board category, `provecash-rfq`. A quote is posted sealed when the
  counterparty has announced a key, and plain when not (`docs/ROADMAP.md`).
- [D] `docs/ROADMAP.md`: "no production RFQ protocol encrypts to a named counterparty; they all
  keep quotes private by not publishing them".

**RV-17a.** Sealing ends at settlement. `settleExclusive` puts every term of the quote, the binding
and the mirror in public calldata. Nothing in the contract MAY assume otherwise.

**RV-18. The maker's fee choice.** `6779256` recorded a second open attack: the maker picks `feeTo`
and the rate, so they can pay themselves back out of the concession. Under the approved fee-sink
spec, a `feeTo` must be a registered sink with a fixed destination. That narrows the attack to a
maker whose own address the owner has registered. A counterparty MUST still price against the net
delivered amount, and a screen that says "exclusive price" MUST show the fee.
*Source:* [C] `6779256`; [O] `2026-09-23-fee-sink-fixed-destination.md`.

---

## Multi-hop routes through the executor

The executor bot now prices routes of up to three hops and sends the whole path in one
`swapExactTokensForTokens`. Nothing in `ProveExecutor` names a path. The path is inside the opaque
venue calldata. `contracts/test/ForkMultiHop.t.sol` proves a two-hop and a three-hop fill against
PulseX on a fork of 369.
*Source:* [C] `6318d83`; [H] `ForkMultiHop.t.sol` header.

The executor cannot read a path, so it cannot check one. These are the guarantees it MUST give for
any path, and the ones it leaves to the caller.

**MH-1. No token left behind in the executor.** After a fill, the executor MUST hold exactly its
starting balance of every token the route names. This is G-2 and EX-5, and it holds for every path.
An intermediate token that a venue pays to the executor and the route does not name stays on the
executor for ever, so a route MUST NOT do that.
*Source:* [C] `6318d83` ("no token on the path rests on the executor or the sink").

**MH-2. No token left behind in the sink, unless it is the caller's.** The sink MUST return
`tokenIn`, `tokenOut` and every `extra` (CS-6). An intermediate hop token that a venue leaves on
the sink rests on the caller's own clone, and nobody else can reach it (CS-7). A caller whose venue
can leave an intermediate token MUST name it in `Swap.extra`.
*Why:* a V2 router moves each intermediate from pair to pair and never pays it to the caller. An
aggregator may not.
*Source:* [C] `6318d83`; [H] `ForkMultiHop.t.sol` header ("If one did, `extra` would have to name
it, or it would strand").

**MH-3. Output is measured, not trusted.** The executor MUST measure its proceeds as a balance
increase over its mark. It MUST revert `ProceedsNotHere` before it approves the relayer if the
proceeds do not cover `amountOwed` (EX-8). The settlement MUST then pull the maker's payment and
check what arrived. The executor MUST NOT read any output figure out of the venue's return data.
*Source:* [D] `2026-08-12-hooks-design.md` §5 rule 3: "Prove payment by making the transfer, not
by measuring a balance." [C] `4ba9a66` for `ProceedsNotHere`.

**MH-4. Slippage reverts the fill.** A venue that reverts, such as a router that meets its
`amountOutMin`, MUST revert the whole fill through `SwapFailed` (CS-5). The maker keeps their
tokens. A venue that pays less than the maker is owed MUST revert the fill at MH-3 or at the
settlement's pull.
*Why:* the maker's floor is enforced by the settlement whatever the path does. The caller's own
floor is the `amountOutMin` in their calldata, and it protects only the caller's spread.
*Source:* [C] `6318d83` ("A route quoted before someone moved its first pool reverts with the
router's INSUFFICIENT_OUTPUT_AMOUNT inside SwapFailed, and the maker keeps their tokens").

**MH-5. The same holds in a batch.** `ProveBatchExecutor` buy-side swaps and disposals MUST give
MH-1 to MH-4 on the same terms. A buy-side venue failure MUST revert the ring. A disposal failure
MUST NOT (BX-14). The disposal patch offsets MUST NOT move with path length; for
`swapExactTokensForTokens` the amount is at byte 4 and the floor at byte 36 whatever the path.
*Source:* [H] `sdk/src/solver/abi.ts` for the offsets. No test runs a multi-hop path through
`ProveBatchExecutor`.

**MH-6. One router per path.** The SDK builds a path that never mixes venues, so one call carries
it. The contract does not enforce this and MUST NOT depend on it: a route that needs two venues
MUST be two `Swap` entries, each with its own tokens named.
*Source:* [H] `sdk/src/solver/graph.ts` ("A path never mixes venues").

See [OQ-6](#open-questions-owner): the executor does not enforce a floor of its own.

---

## Who may call what

| Function | Who may call | Enforced by |
|---|---|---|
| `ProveRelayer.pull` | the settlement | `NotSettlement` |
| `ProveRelayer.pullWithPermit2` | the settlement | `NotSettlement` |
| `ProveExecutor.fill` | anyone | none, by design (EX-1) |
| `ProveExecutor.proveCallback` | the settlement | `NotSettlement` |
| `ProveExecutor.sinkFor` | anyone (view) | none |
| `ProveCallSink.run` | the executor that deployed the template | `NotExecutor` |
| `ProveBatchExecutor.settleRing` | anyone | none, by design (BX-1) |
| `ProveBatchExecutor.proveBatchCallback` | the settlement | `NotSettlement` |
| `ProveBatchExecutor.sellSurplus` | the contract itself | `ForbiddenTarget` |
| `ProveBatchExecutor.sinkFor` | anyone (view) | none |
| `RfqVenue.settleExclusive` | anyone | none, by design (RV-1) |
| `RfqVenue.proveBatchCallback` | the settlement | `NotSettlement` |
| `RfqVenue.hashExclusive`, `domainSeparator`, `spent` | anyone (view) | none |

The settlement calls a callback only on `msg.sender`, and only from `fillWithCallback` and
`fillBatchWithCallback`. Both refuse the relayer and the settlement as `msg.sender`
(`callableTarget`). So a stranger who calls the settlement directly is called back on their own
address, and never reaches an executor's callback.

---

## What each contract may hold, and for how long

The rule is G-2: nothing between transactions. This table states each exception, then the proof
for each contract.

| Contract | Storage between transactions | Tokens between transactions | Allowances it granted, between transactions |
|---|---|---|---|
| `ProveRelayer` | none | none it receives | none |
| `ProveExecutor` | `_entered == 1` | exactly what it held before (donations stay, untouched) | none |
| `ProveCallSink` clone | none | the caller's own strand, if any (CS-7) | any the caller's own calldata wrote (CS-8) |
| `ProveCallSink` template | none | none | none |
| `ProveBatchExecutor` | `_entered == 1`, `_skipDisposal == 0` | exactly what it held before | none |
| `RfqVenue` | `_entered == 1`, `spent` (grows, by design) | exactly what it held before | none |

**Proof for `ProveRelayer`.** No function transfers to `address(this)`. `pull` moves from `from` to
`to`, and the settlement refuses the relayer as a `recipient` or `feeTo`. `pullWithPermit2` sends
to `settlement`. The contract has no storage variables. A token sent to it by mistake cannot leave,
because no function moves the relayer's own balance.

**Proof for `ProveExecutor`.** Let `m(t)` be the mark for token `t`, read at the start of `fill`.
At the end, `_sweepAbove` reverts if `balance(t) < m(t)` and sends `balance(t) - m(t)` if it is
larger. So after `fill` returns, `balance(t) == m(t)` for `tokenIn`, `tokenOut` and every `extra`.
The one allowance it grants is `amountOwed` of `tokenOut` to the relayer. The settlement then pulls
`delivered` through `_payMaker` and `fee` through `_payFee`, and `amountOwed == delivered + fee`, so
the allowance ends at zero. `_entered` returns to 1 on every path that does not revert.
Two limits: a token the venue pays to the executor that the route does not name is not marked or
swept, and stays. A donation stays too. Both are kept apart from every later caller by G-3.

**Proof for `ProveCallSink`.** `run` sets the allowance of `spender` to `amountIn`, calls, and sets
it to zero. It then sends its whole balance of every named token to the executor. The clone
therefore ends with zero of every token `run` names and zero allowance to `spender`. It can keep an
unnamed token and a caller-written allowance, and both are confined to one caller's clone by CS-2.
The template is never driven (CS-3), so it holds nothing unless somebody sends it a token. A token
sent to the template cannot leave.

**Proof for `ProveBatchExecutor`.** The marks work as in `ProveExecutor`, over every token the
route names (BX-3). A token named twice is marked twice with the same value, because every mark is
read in one loop before the ring. The first sweep takes the increase and the second finds nothing,
so `_increaseAbove` returning the first match is safe. The relayer allowance per token is the sum of
`amount + fee` over that token's lines, and `_collect` pulls exactly `amount` per line through
`_deliverTo` and the fees through `_flush`, so each allowance ends at zero.
`_skipDisposal` is written only when a disposal is unwanted. An unwanted disposal has
`leg != ANY_LEG`, so `_disposalSkips` sees a conditioned route, reads the word and clears it. If
the ring reverts, the write reverts with it. So the word is zero between transactions.

**Proof for `RfqVenue`.** The two marks are read from the intents. `_sweepAbove` holds each balance
at its mark. The two allowances are `amount + fee` per line, and the two lines are in different
tokens (RV-8 and the settlement's `tokenIn != tokenOut`), so neither overwrites the other and both
are pulled to zero. `spent` grows by one digest per settled binding. That is the one-shot book of
RV-6, and it is intended to persist.

The proofs above are arguments, and the tests only partly back them. `ProveBatchExecutor` and
`RfqVenue` each have an invariant that the relayer allowance ends at zero. `ProveExecutor` has no
such test and no invariant suite at all. See [Findings](#findings).

---

## Approvals each contract grants

| Grantor | Spender | Token | Amount | Lifetime |
|---|---|---|---|---|
| `ProveExecutor` | the relayer | `tokenOut` | `amountOwed` | spent by the settlement in the same transaction |
| `ProveBatchExecutor` | the relayer | each owed token | sum of `amount + fee` over its lines | spent by the settlement in the same transaction |
| `RfqVenue` | the relayer | each of the two owed tokens | `amount + fee` of its line | spent by the settlement in the same transaction |
| `ProveCallSink` clone | `Swap.spender` | `tokenIn` | what arrived at the sink | set to zero inside `run` |
| `ProveCallSink` clone | anyone the caller's calldata names | any | any | persists, on that caller's clone only (CS-8) |
| `ProveRelayer` | none | | | |

None of these contracts MAY approve the settlement (G-4).

---

## What the periphery relies on in the settlement

The periphery's safety arguments rest on these settlement behaviours. A change to any one of them
MUST be checked against this document.

1. The callback target is `msg.sender`, never an address a caller names. [D]
   `2026-08-12-hooks-design.md` §5 rule 4: "Callbacks go to `msg.sender`. A caller-named target is
   a wider surface than any trade needs."
2. `callableTarget` refuses the relayer and the settlement as `msg.sender` of a callback entry.
3. The settlement pulls every payment with a directed `transferFrom` through the relayer, after the
   callback returns. It never measures a balance delta.
4. `_evaluate` refuses an intent whose non-zero `executor` is not `msg.sender`. The venue's
   exclusivity rests on this.
5. `_termsOk` refuses `tokenIn == tokenOut`, and refuses the relayer or the settlement as
   `recipient` or `feeTo`.
6. `fillBatchWithCallback` sets `Payment.leg` to the request index, and compacts `owed` in leg
   order.
7. `hashIntent` is the one EIP-712 encoding of an intent.
8. Every settlement entry point is `nonReentrant`, and the guard is held for the whole callback.

---

## Open questions (owner)

No document records an intent for any of these. Each needs an owner's answer before this spec can
move to Approved.

**OQ-1. Tokens nobody can move.** A token can rest for ever in four places: on an executor (a
donation, or a venue payout the route did not name), on the relayer, on a sink template, and on
the venue. [D] `AUDIT-SCOPE.md` §6.8 accepts the executor case. No document decides the other three,
or whether any of them should be recoverable.
- (a) Accept the loss everywhere. This is what the code does.
- (b) Add a permissionless sweep of each contract's unmarked balance to the settlement's
  `defaultProceeds`. It adds a function to contracts that today have none of that kind.
- (c) An owner rescue. This breaks G-1.

**OQ-2. What "holds nothing" means.** The headers of `ProveExecutor`, `ProveBatchExecutor`,
`ProveCallSink` and `RfqVenue`, and `docs/AUDIT-READINESS.md` §1, say the contract "holds nothing".
The accepted limits in [D] `AUDIT-SCOPE.md` §6.8 say strands and donations stay.
- (a) Adopt G-2 as written here (net zero per transaction, and no surviving allowance), and correct
  the headers.
- (b) Require a true zero, which needs OQ-1 (b).

**OQ-3. Should `Route.legs` equal `reqs.length`?** BX-12 bounds `Route.legs <= reqs.length`. A
route may still plan for fewer legs than the batch carries, and then no swap can name the legs
past `Route.legs`. [D] `AUDIT-SCOPE.md` §9.2 asks the auditor whether the two bounds are tight.
- (a) Keep `<=`. A route may ignore trailing requests.
- (b) Require equality. A route then always describes the whole batch.

**OQ-4. The mirror fields the venue does not check.** RV-9 checks the mirror's end time, flatness
and take. It does not check `flags`, `startTime`, `nonce`, `recipient`, `feeTo` or `feeRate`. [D]
`AUDIT-SCOPE.md` §9.5 asks whether three checks is the right number.
- (a) Accept. Each of these is the counterparty's own signed choice.
- (b) Add checks on named fields, such as `recipient == counterparty` or `feeRate == 0`.
- (c) Have the counterparty sign a second binding that names the quote's hash.

**OQ-5. The quote's own shape.** The app writes quotes with no decay and no partial fill, on
purpose ([D] `docs/ROADMAP.md`, "Exclusive quotes have an app surface"). The venue accepts a
decaying quote and a partial binding.
- (a) Keep it as app policy. A maker's own quote shape is the maker's risk.
- (b) Enforce it in the venue, as RV-9 does for the mirror.

**OQ-6. A floor of the executor's own.** MH-4 leaves the caller's floor to the venue calldata. The
executor enforces only the maker's floor (through the settlement) and `ProceedsNotHere`.
- (a) Keep it. The caller writes the calldata and owns the spread.
- (b) Add a `minProfit` argument to `fill` and `settleRing`, checked on the swept increase.

**OQ-7. The exclusivity fee under fixed fee sinks.** The venue header says the maker sets "`feeTo`
to wherever they want the money". The approved fee-sink spec says `feeTo` must be a registered
sink. RV-18 follows the approved spec.
- (a) Confirm: an exclusive quote may charge a fee only to a registered sink. The header changes.
- (b) Carve out an exception for the venue. This contradicts [O] the fee-sink spec.

**OQ-8. One name for the batch sink.** Record 943 calls it `ProveBatchExecutorCallSink`. Record 369
calls it `ProveBatchCallSink`. `app/scripts/deployment.ts` carries both.
- (a) Pick one at the next redeploy.
- (b) Keep both, and keep the code that reads both.

**OQ-9. Caps on legs and hops.** Nothing on chain bounds `reqs.length`, the number of swaps, or the
length of a path. `MAX_BATCH_LEGS = 8`, the three-leg ring cap and the three-hop cap are all in
the SDK. [D] `docs/ROADMAP.md` says "Rings of up to three legs" as if it were the contract's rule.
- (a) Keep them off chain. BX-13 already refuses to lean on them.
- (b) Add an on-chain cap.

**OQ-10. Sealed quotes for contract wallets.** Only ECDSA key announcements count, so a Safe cannot
receive a sealed quote. The venue accepts an ERC-1271 binding.
- (a) Accept. Such a counterparty receives plain quotes.
- (b) Design a key announcement a contract wallet can make.

**OQ-11. Requirements stated only in code.** These requirements have grade [H] and no other source:
EX-6, EX-7, BX-1 (`sellSurplus`), BX-7 (in part), CS-5 (the 256-byte clip), BS-2, RV-5, RV-7,
RV-10, RV-12 (`OwedTokenNotMarked`), MH-5 (the offsets) and MH-6. The owner should confirm each one
as intent, or reject it.

---

## Traceability

Test files are in `contracts/test/`. Abbreviations: **Rel** `Relayer.t.sol`, **Ex**
`Executor.t.sol`, **BE** `BatchExecutor.t.sol`, **Adv** `Adversarial.t.sol`, **Arm**
`Arming.t.sol`, **Rfq** `RfqVenue.t.sol`, **EI** `ExecutorInvariants.t.sol` (it drives
`ProveBatchExecutor` only), **RI** `RfqVenueInvariants.t.sol`, **FMH** `ForkMultiHop.t.sol` (fork
only; it skips without `PULSECHAIN_RPC`).

"Generic" means the test expects a revert but not the named error. **NONE** means no test asserts
the requirement. The map was built by reading test bodies at `ce37983`; forge was not run.

| ID | Tests |
|---|---|
| G-1 | NONE. Structural; checked by review of the ABI. |
| G-2 | EI `invariant_NothingRestsInTheSinkOrTheSettlement`, `invariant_NoAllowanceOutlivesARing`, `invariant_TheGuardIsOpenBetweenRings`; RI `invariant_ADonationIsNeverSpentAndNothingElseRests`, `invariant_NoAllowanceRestsOnEitherSideOfTheVenue`; Ex `test_ACallerWithNoInventoryFillsAnIntentAndKeepsTheSpread`. **Partial**: no allowance check for `ProveExecutor`. |
| G-3 | See EX-5, BX-3, RV-12. |
| G-4 | See EX-9, BX-5, RV-13. |
| G-5 | Ex `test_TheCallbackRefusesEveryCallerButTheSettlement`; BE `test_AnArbitraryCallerCannotMakeItApproveAnything`; Rfq `test_TheCallbackRefusesAnyCallerButTheSettlement`. |
| G-6 | Rel `test_TheCallbackTargetCanNeverBeTheRelayerOrTheSettlement`, `test_TheForbiddenTargetIsRefusedBeforeAnyReleaseHappens`, `testFuzz_TheCallbackGuardRefusesTheRelayerAndTheSettlementAndNothingElse`; see EX-4, BX-6. |
| G-7 | Rfq `test_ASecondSettlementFromInsideTheFirstIsRefused` (exact `Reentered`); Ex `test_AVenueCannotReenterTheExecutor` (generic); BE `test_AVenueCannotStartASecondRingFromInsideTheFirst` (generic); Adv `test_EveryDoorBackIntoTheExecutorIsShutMidRing` (generic); EI `invariant_TheGuardIsOpenBetweenRings`. |
| G-8 | **NONE.** |
| G-9 | Every Ex fill test, which fills through the mirror against the real settlement. |
| G-10 | Ex `test_TheConstructorRefusesASettlementThatCannotBeOne`; BE `test_ItRefusesASettlementThatIsNotOne`; Rfq `test_AVenueRefusesASettlementWithNoCode`, `test_AVenueRefusesASettlementWithNoRelayer`. |
| RL-1 | Rel `test_OnlyTheSettlementCanMakeTheRelayerMoveAnything`, `testFuzz_PullRefusesEveryCallerButTheSettlement`, `test_OnlyTheSettlementCanSpendAPermit2Signature`. |
| RL-2 | Rel `test_TheRelayerIsBoundToItsSettlementAtConstruction`, `test_TheRelayerIsBoundToItsPermit2AtConstruction`. |
| RL-3 | Indirect only: Arm `test_TheFirstPermit2FillPromotesTheWholeIntentIntoEscrow`. |
| RL-4 | Rel `test_ATransferThatAnswersFalseIsNotAPayment`. |
| RL-5 | Not a behaviour. `test/Gas.t.sol` holds the measurement. |
| EX-1 | Ex `test_ACallerWithNoInventoryFillsAnIntentAndKeepsTheSpread`. |
| EX-2 | See G-5. |
| EX-3 | Ex `test_TheVenueSeesTheCallersCloneAndNoTwoCallersShare`, `test_ACallerCannotLeaveAStandingApprovalOnTheExecutor`. |
| EX-4 | Ex `test_TheCallCanNeverBeAimedAtTheRelayer` (target and spender), `test_TheCallCanNeverBeAimedAtTheSettlement` (**target only**). |
| EX-5 | Ex `test_ADonatedBalanceCannotPayForAFillAndCannotBeSweptAway`, `test_ADonationInAnExtraTokenIsNotSwept`. |
| EX-6 | Ex `test_TheExtraListCannotNameAnIntentToken`. |
| EX-7 | Ex `test_ADonationToTheSinkDoesNotWidenTheVenueAllowance`. **NONE** for a fee-on-transfer token. |
| EX-8 | Ex `test_APayoutAimedAtTheSinkTemplateIsRefusedByName`. |
| EX-9 | **NONE.** |
| EX-10 | **NONE** for `ProveExecutor`. |
| EX-11 | Ex `test_APayoutAimedAtTheSinkTemplateIsRefusedByName` (a payout to `sinkFor(caller)` settles). No direct `sinkFor` equality test. |
| CS-1 | Ex `test_ACloneKnowsWhichExecutorItAnswersTo`, `test_TheSinkRefusesEveryCallerButTheExecutor`; BE `test_NobodyElseCanDriveTheSink`. |
| CS-2 | Ex `test_TheVenueSeesTheCallersCloneAndNoTwoCallersShare`; BE `test_APureCreditRingMintsNoSink`; Adv `test_AStrangerCanNoLongerPreArmAStandingApprovalOutOfTheSink`. |
| CS-3 | Ex `test_TheSinkRefusesToBeAimedAtTheExecutorOrItself`, `test_ACloneRefusesToBeAimedAtItselfOrAtItsTemplate`, `test_TheSinkRefusesAnApprovalAimedAtTheExecutorWithNothingElseWrong`; BE `test_TheCallCanNeverBeAimedAtTheExecutorOrItsSink`. |
| CS-4 | Ex `test_ATokenThatAnswersAnApproveWithNothingIsStillSellable`; BE `test_NoVenueAllowanceSurvivesTheSwap`; EI `invariant_NoAllowanceOutlivesARing`. |
| CS-5 | Ex `test_AFailingSwapRevertsTheFillAndBubblesTheReason`, `test_AHugeRevertReasonIsClipped`, `test_ALongRevertReasonKeepsItsFirst256BytesAndLosesTheRest`, `test_AShortRevertReasonComesBackWholeRightUpToTheCap`; BE `test_ALongRevertReasonIsClippedAndStillIdentifiesItself`. |
| CS-6 | Ex `test_AThirdTokenComesHomeOnlyIfTheCallerNamesIt`; EI `invariant_NothingRestsInTheSinkOrTheSettlement`. |
| CS-7 | Adv `test_ARecoveredStrandPaysTheCallersOwnRing`, `test_ASolverRecoversTheirOwnStrandAndNobodyElseCan`; Ex `test_AStrandOnOneCallersSinkIsOutOfAnotherCallersReach`. |
| CS-8 | Adv `test_AStrangerCanNoLongerPreArmAStandingApprovalOutOfTheSink` (the claim reaches only the writer's clone). The public-contract caveat is accepted, not tested. |
| CS-9 | Adv `test_AStrangerCanNoLongerPreArmAStandingApprovalOutOfTheSink`, `test_NamingDifferentTokensWalksPastAnyTargetCheck`. **Batch executor only.** |
| BS-1 | As CS-1 to CS-9. |
| BS-2 | **NONE** that one executor cannot drive the other's clone. |
| BX-1 | BE `test_OnlyTheExecutorItselfMaySellSurplus`; see G-5. |
| BX-2 | BE `test_ARingWithAPoolLegClosesInsideTheSameTransaction`, `test_ADisposalSellsWhatTheBatchEarnedAndNotADonation`. |
| BX-3 | BE `test_ADonationIsNotSweptToTheNextCaller`, `test_ADonationCannotBeSoldAtAVenueEither`, `test_ADonationCannotPayForAStrangersFill`, `test_TheWiderSweepStillCannotTakeADonation`; Adv `test_EveryFieldOfARouteIsMarkedAndSwept`, `test_ADonationSurvivesAnEmptyRingThatTriesToSellIt`, `test_ADonationCannotPayAMakerOnARingThatLostALeg`; EI `invariant_ADonationIsNeverSpent`. |
| BX-4 | BE `test_ARouteThatDoesNotNameAnOutputTokenIsRefused`; Adv `test_AnOwedTokenOffTheSweepListIsRefused`. |
| BX-5 | BE `test_NoAllowanceSurvivesTheRing`, `test_TwoLinesInOneTokenAreBothPaid`, `test_ARoutePayingTheSinkTemplateIsRefusedByName`; Adv `test_NoAllowanceOutlivesAPartialRing`; EI `invariant_NoAllowanceOutlivesARing`. No test asserts the size of a coalesced allowance. |
| BX-6 | BE `test_TheCallCanNeverBeAimedAtTheRelayer`, `test_TheCallCanNeverBeAimedAtTheSettlement`; EI `invariant_ARingTheContractMustRefuseNeverSettles`. |
| BX-7 | BE `test_TheBuySideMayNotSizeItselfToTheBalance`. |
| BX-8 | BE `test_APureCreditRingMintsNoSink`. |
| BX-9 | BE `test_AFallbackBuysWhatTheMissingLegWouldHaveSupplied`, `test_ASteppedOverLegFailsClosedWhenTheRouteCannotCoverIt`, `test_TheFeeBoundIsHonoured` (`maxFeeRate`). |
| BX-10 | BE `test_ARouteExpectingFewerLinesThanSettledIsRefused`, `test_ASteppedOverLegSettlesTheRestWhenTheRouteSaysHow`; Adv `test_ARouteThatPlansForFewerLegsThanSettleIsRefused`. |
| BX-11 | Adv `test_ExactlyOneOfAPairRunsWhateverTheBatchDid`, `test_TheLegIndexSurvivesAHoleInTheMiddle`, `test_AnyLegAndWhenAbsentDoNotCollide`; BE `test_AFallbackStaysOutOfTheWayWhenItsLegSettles`, `test_SeveralFallbacksFireInTheFundingOrderThePlannerEmits`, `test_TwoLostLegsOnTheWrongSideOfTheWalkFailClosed`. |
| BX-12 | Adv `test_AFallbackKeyedPastTheEndOfTheBatchIsRefused` (`LegOutOfRange` and `LegsExceedBatch`, and the venue is never called), `test_AnyLegAndWhenAbsentDoNotCollide`. |
| BX-13 | Adv `test_AnyLegAndWhenAbsentDoNotCollide`. |
| BX-14 | BE `test_ADisposalThatFailsDoesNotUndoTheBatch`, `test_ADisposalRefusesAPriceBelowItsScaledBound`. |
| BX-15 | Adv `test_ADisposalCannotOversellIntoAMark` (the outcome). **NONE** asserts `OversizedDisposal`. |
| BX-16 | BE `test_APatchWithoutABoundIsRefused`, `test_APatchOffThePlotIsRefused`, `test_ADisposalRefusesAPriceBelowItsScaledBound`. **NONE** asserts `NothingToSell`. |
| BX-17 | Adv `test_ADisposalReadsItsOwnLegIndex` (the clear, indirectly), `test_ARouteWithMoreDisposalsThanOneWordIsRefused`. |
| RV-1 | RI `invariant_TheSubmittersKeptExactlyTheSpread`. |
| RV-2 | Rfq `test_TheCallbackRefusesAnyCallerButTheSettlement`. |
| RV-3 | Rfq `test_AQuoteWithAnOpenExecutorIsRefused`, `test_AMirrorWithAnOpenExecutorIsRefused`, `test_NobodyButTheVenueCanFillTheQuoteOnTheSettlement`, `test_NobodyButTheVenueCanBatchTheQuoteEither`. **NONE** fills the mirror directly on the settlement. |
| RV-4 | Rfq `test_AnExpiredBindingSettlesNothing`, `test_ATakeTheMakerDidNotSignSettlesNothing`, `test_ABindingDoesNotFollowARewrittenQuote`, `test_ABindingIsSpentOnce`, `test_AForgedBindingSettlesNothing`, `test_ABindingFromAnotherVenueSettlesNothing`, `test_TheDigestIsTheOneAClientWouldBuild`. **NONE** replays a binding on another chain id. |
| RV-5 | Rfq `test_ABindingDoesNotFollowARewrittenQuote`. |
| RV-6 | Rfq `test_ABindingIsSpentOnce`; RI `invariant_EveryBindingItSettledIsStillSpent`, `invariant_NoBindingSettlesTwice`. |
| RV-7 | Rfq `test_AContractWalletCanSignTheBinding`, `test_AContractWalletThatRevertsHasNotSigned`, `test_AContractWalletThatMumblesHasNotSigned`. **NONE** for the gas cap or for dirty bytes in a full word. |
| RV-8 | Rfq `test_TwoLegsThatDoNotCrossAreRefused`, `test_AStrangersMirrorCannotTakeTheQuote`. |
| RV-9 | Rfq `test_AnAcceptanceCannotBeCarriedToARogueQuote`, `test_AnAcceptanceThatDecaysIsRefused`, `test_TheSubmitterCannotSliceTheAcceptance`. No invariant. |
| RV-10 | Rfq `test_AnythingButTwoLegsIsRefused`, `test_TheCallbackRefusesAnyLegCountButTwo`, `test_ASettlementThatFillsOneLegAndSaysSoIsRefused`; RI `invariant_ARingIsExactlyTwoLegs`. |
| RV-11 | RI `invariant_BothSidesGotExactlyTheSignedRate`, `invariant_TokensAreConserved`. |
| RV-12 | Rfq `test_ADonationIsNotSweptToTheSubmitter`, `test_ADonationCannotPayTheQuotesOwnFee`, `test_ADonationCannotDischargeAMakersPayment`, `test_TheCallbackRefusesAnOwedTokenItDidNotMark`, `test_TheCallbackRefusesAMirrorTokenItDidNotMark`; RI `invariant_ADonationIsNeverSpentAndNothingElseRests`. |
| RV-13 | RI `invariant_NoAllowanceRestsOnEitherSideOfTheVenue`. |
| RV-14 | RI `invariant_TheFeeDestinationsTookExactlyTheSignedFee`; Rfq `test_AGreedyQuoteIsRefusedByTheSubmittersOwnBound`. |
| RV-15 | Rfq `test_AQuoteWithNoSpreadPaysForItsOwnExclusivity`. |
| RV-16 | Structural. RI `invariant_NoAllowanceRestsOnEitherSideOfTheVenue` in part. |
| RV-17, RV-17a | Structural. Every Rfq test runs with public data. |
| RV-18 | **NONE** yet. It depends on the fee-sink work in flight. |
| MH-1, MH-2 | FMH `test_TwoHopRouteSettlesThroughTheExecutor`, `test_ThreeHopRouteSettlesThroughTheExecutor` (executor and `sinkFor(caller)` hold zero of every path token). Fork only. |
| MH-3 | Ex `testFuzz_TheMakerNeverGetsLessThanTheySignedWhateverTheVenuePays`; see EX-8. |
| MH-4 | FMH `test_AReserveThatMovedAfterTheQuoteRevertsTheFill` (exact `SwapFailed` with the router's reason; the maker keeps their tokens); Ex `test_AFailingSwapRevertsTheFillAndBubblesTheReason`; BE `test_AVenueThatRefusesTheTradeRevertsTheWholeRing`. |
| MH-5 | BE `test_AVenueThatRefusesTheTradeRevertsTheWholeRing` (one hop). **NONE** for a multi-hop path. |
| MH-6 | Not a contract behaviour. |

---

## Findings

### F-1. MUSTs with no test

Ranked by what a regression would cost.

| # | Requirement | What no test asserts |
|---|---|---|
| 1 | EX-9, G-2 | `ProveExecutor`'s relayer allowance is zero after a fill. `ProveExecutor` has no invariant suite; `ExecutorInvariants.t.sol` drives only `ProveBatchExecutor`. |
| 2 | EX-7 | A fee-on-transfer token sold through either executor. The venue approval is sized by a balance difference, and nothing taxes that path. |
| 3 | EX-4 | `Swap.spender == settlement` on `ProveExecutor`. Only `target` is tested. |
| 4 | CS-9 | The pre-armed approval attack through `ProveExecutor`. Both attack tests drive `ProveBatchExecutor`. |
| 5 | BX-15, BX-16 | The selectors `OversizedDisposal` and `NothingToSell`. The tests see only the swallowed outcome, so deleting either check might leave them green. |
| 6 | G-7 | The `Reentered` selector on either executor. Every test is generic. |
| 7 | RV-3 | A counterparty's mirror filled directly on the settlement by a stranger. |
| 8 | RV-7 | The 60,000 gas cap on `isValidSignature`, and a full 32-byte answer with dirty low bytes. |
| 9 | RV-4 | A binding replayed under another chain id. |
| 10 | MH-5 | A multi-hop path through `ProveBatchExecutor`. MH-1 and MH-2 are proven only on a fork that CI skips without an RPC. |
| 11 | G-8 | Native currency sent to any contract in scope. |
| 12 | EX-10 | `maxFeeRate` passed through `ProveExecutor.fill`. |
| 13 | BS-2 | That one executor cannot drive the other executor's clone. |
| 14 | RL-3 | That `pullWithPermit2` pays the settlement. Only an indirect escrow test shows it. |
| 15 | EX-11, BX-5 | A direct `sinkFor(caller)` equality, and the size of a coalesced allowance. Both are implied, not asserted. |

One test is weaker than its name. `Ex test_TheVenueAllowanceIsSetBackToZero` reads
`allowance(executor, venue)`. The executor never approves the venue (the sink does), so the test
cannot fail. CS-4 is held by other tests.

### F-2. Code and records that disagree with a recorded decision

No contract in scope behaves against a recorded owner decision. The disagreements are in NatSpec,
in the SDK and in docs. Each one can mislead the next reader.

1. **The venue's fee destination.** `RfqVenue`'s header says the maker sets "`feeTo` to wherever
   they want the money". [O] `2026-09-23-fee-sink-fixed-destination.md` says `feeTo` must be a
   registered sink. See OQ-7. (The settlement at `ce37983` still carries the switchable allowlist
   that spec replaces; that work is in flight elsewhere.)
2. **"Protocol fee" in three `@param maxFeeRate` notes.** `ProveExecutor.fill` and
   `ProveBatchExecutor.settleRing` say "the highest protocol fee this caller will pay".
   `RfqVenue.settleExclusive` says "The settlement reads its floor" and that the concession must
   cover "the protocol fee". [C] `84e8895` removed the protocol fee and the floor: "prove.cash
   charges nothing and keeps nothing".
3. **The mirror builder.** `RfqVenue`'s mirror-check comment says `sdk/src/rfq.ts`'s `mirrorFor`
   "already builds all three". `mirrorFor` clamps the mirror's `endTime` to the quote's `endTime`,
   not to `ex.expiry`. The app sets the two equal, so the app is safe. A third-party quote with a
   later `endTime` gets a mirror the venue refuses. This fails closed.
4. **"Holds nothing".** See OQ-2. The headers and `docs/AUDIT-READINESS.md` §1 say it; [D]
   `AUDIT-SCOPE.md` §6.8 accepts strands that stay for ever.
5. **`IProveBatchCallback.Payment.leg`** says a ring "stays atomic and this field changes nothing
   for it". [C] `7d038a9` lets a ring survive a lost leg through `WHEN_ABSENT`.
6. **`settleRing`'s `@param skipInvalid`** opens with "TRUE is not usable yet" and later says "That
   gap is closed". The later sentence is the current one ([C] `7d038a9`).
7. **[D] `2026-08-12-hooks-design.md`** still names "executor allowances still sit on the
   settlement" as the residual of the relayer split. Every executor now approves the relayer (G-4).
   The doc is stale; the code follows the later decision.
8. **[D] the internal risk assessment PR.AA-05** says "No `delegatecall` ... no proxy ... exists in
   `contracts/src`". Every sink clone is an EIP-1167 proxy that delegatecalls its template.
9. **`ForkMultiHop.t.sol`'s header** says "The fork is taken at the head". `70bff5e` moved it 64
   blocks behind the head.

### F-3. Recorded decisions this spec relies on that were later reversed

These are resolved. They are listed so that nobody restores the older shape.

- `1681708` refused the `transferFrom` selector as a backstop. `46c0f09` removed the idea: "The
  selector denylist was wrong in kind, not in detail." EX-3 is the replacement.
- `3432bfb` gave every transaction its own sink. `21a4240` replaced that with one sink per caller,
  to restore strand recovery and save gas. CS-2 is the current rule.
- `6779256` put an exclusivity rate in the binding, capped by `MAX_EXCLUSIVE_FEE_BPS`. `25e699e`
  moved it to `Intent.feeRate` and deleted the cap. RV-14 is the current rule.

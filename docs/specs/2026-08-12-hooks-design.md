# Executor hooks, maker hooks, and the allowance that sits under both

**Status: Built in part.** The decision was to ship no hooks. §2 was reversed the same day:
`fillBatchWithCallback` is built. `fillWithCallback` calls `msg.sender` and pulls the payment (`ddab838`). Both are in
`contracts/src/ProveSettlement.sol`.

> **Amended 2026-08-12, later the same day. `fillBatchWithCallback` shipped.** The owner reversed
> the call below and asked for it. It is on `master`, deployed to 943 inside
> `0x7F12CE818316D04AEcb698d13cE0f6C6404A88A4`, and a two-leg ring settles through it on chain
> from an executor holding no inventory. The **2,500 gas a leg** figure in the paragraph below is
> stale in both directions: `fillBatch` got 6,358 a leg cheaper afterwards and the credit path did
> not, so the measured premium is now **7,407 a leg**. §2.4's table is the old baseline. **§6
> answers a later question** — pluggable decay curves — and concludes flags, not hooks.
>
> **Decision, 2026-08-12. Ship none of it for now.** — superseded above for §2 only.
>
> The owner settled the question the design turned on: solvers are **not** capital-constrained.
> That removes the case for `fillBatchWithCallback`. It buys a solver the ability to walk a ring
> without inventory, and inventory is available — so the protocol would be charging roughly 2,500
> gas a leg, plus a small tax on paths that never use it, for a capability nobody needs. The
> recommendation in §2 stands on its own terms and is wrong only against that constraint. Revisit
> it the day a solver's capital is the thing limiting the book.
>
> Maker hooks: no, and three analyses reached that separately. See §3. **§3.3 recommended a
> `ProveShed` per-maker proxy; §3.4 withdraws even that** — three of the four motivating cases need
> no proxy and the fourth should not be served. §3.5 answers the last open question: a hash
> commitment does not remove the need for a hook whitelist, and says what does.
>
> §4 carries a measurement that changes the frame: **PulseChain is on Shanghai, so EIP-7702 does
> not exist on 369 or 943.** There is no smart-account escape hatch, which raises the bar for a
> proxy rather than lowering it.
>
> **Three things here are worth taking anyway, and none of them needs a hook:**
>
> - **The selector rule.** Every call the contract makes carries a selector the contract chose
>   itself. That is the only thing standing between `ProveSettlement` and every allowance approved
>   to it, and nothing said so until now. It is asserted in a test. Read §1 before changing any
>   call site.
> - **Pull, do not measure.** `fillWithCallback` verifies payment by snapshotting balances and
>   checking a delta. A donation reads as a payment, and any maker-controlled code inside the
>   window pays the maker's fill with the maker's own money. UniswapX's audit rejected delta
>   checks for this exact architecture. This applies to shipped, deployed surface.
> - **`_deliverTo(address,address,uint256)`.** Splitting the delivery helper so it takes plain
>   arguments instead of re-reading a calldata struct pointer measured **net negative**: −401 gas
>   on a warm fill, −4,114 on a twenty-leg batch. It stands alone and can be taken on its own.
>
> The remaining open question is the relayer split — §1.5(a), laid out as a ladder in §1.7 — which
> costs 984 gas, or 3.2% of a warm fill, and buys a structural guarantee rather than a conventional
> one. Not taken. It is the owner's call and nothing here should be read as having made it.
>
> **Amended 2026-08-13. The relayer split shipped.** The owner took it, and it is tier 2 of §1.7:
> (a), (a′) and (c), which is what §1.6 recommended. `ProveRelayer` holds every maker allowance;
> `ProveSettlement` holds none and forbids its own callback context from targeting it. It cost
> **803 gas on a warm approval-custody fill, 2.63%** — cheaper than the 984 predicted above — and
> **17 gas** on an escrow fill. §1.8 has the table and the residual, which is that executor
> allowances still sit on the settlement. The trampoline, (b), was not built.
>
> Deployed to 943: settlement `0x5C1230515eb0351D913A41595ddd9029fA608519`, relayer
> `0xC40b4dbDF4123f6F88af5b23fdA7EefE8d581BFc`, fee sink
> `0x61Ca8D1b333f6facB6cB40FA0aec21Cbc5CcE00C`.


Two additions were on the table: a batch form of `fillWithCallback`, and maker hooks. Working on
the second one turned up something that matters more than either. This document leads with that.

Prior-art research ran in parallel and corrected the batch design on a central point. That
correction is folded in below, and the prototype was rebuilt around it — it turned out to be both
safer and cheaper, so there is no trade-off to argue about.

**The short version.**

1. `ProveSettlement` is both the contract that holds every maker's ERC-20 approval and the
   contract that would run a hook. Those two roles must not live at the same address. Today one
   property keeps them apart: every call the contract makes carries a selector the contract chose
   itself. That property is load-bearing and nothing in the code said so. **Split the allowance
   holder out, forbid the arbitrary-call context from reaching it, and write the rule down.**
2. `fillBatchWithCallback` is built and worth shipping. It pulls payments rather than measuring
   balances, releases to `msg.sender` rather than a named target, and costs about 2,500 gas a leg
   more than `fillBatch` at the margin.
3. Do not ship maker hooks. (This first read "ship a `ProveShed` per-maker proxy instead". §3.4
   withdraws that too — the cases it would serve are served already, or should not be served.)
4. Adding all this made every existing path **cheaper**, by 401 gas on a warm fill.

Everything below is measured. The commands are in each section.

> **Where the code is.** The decision was to ship none of it, so the prototype was never merged.
> `Allowance.t.sol`, `BatchCallback.t.sol`, `HookCost.t.sol`, `Eip7702.t.sol`, `IProveMakerHook.sol`,
> the `Relayer` and the trampoline live on branch `worktree-agent-a94f73e6fc7cd30ee`, commits
> `392c91c` and `930d0d5`. **They are not on `master`**, so the `forge test` commands below only run
> after checking that branch out. Three things did land on `master`, and they are the three the
> decision record lists: the pull redesign, `_deliverTo`, and the selector rule — the last as
> `test_TheFixedSelectorIsTheOnlyThingProtectingTheCallbackPath` in `test/ProveSettlement.t.sol`,
> not in `Allowance.t.sol` as §1.4 says.

---

## 1. The allowance finding

### 1.1 What the contract is today

`ProveSettlement` plays three parts at one address:

- **The approval target.** A maker in approval custody calls `tokenIn.approve(settlement, max)`.
  The app asks for an unbounded approval, because a maker who re-approves per fill pays twice.
- **The custodian.** A maker in escrow custody deposits into the contract. `reservations` is a
  ledger over the contract's own token balances.
- **The caller.** `fillWithCallback` calls an address the executor names. `_validSignature` calls
  the maker. A maker hook would add a third call site.

The first two make the address worth attacking. The third decides whether it can be.

### 1.2 What an attacker gets

`contracts/test/Allowance.t.sol` builds `NaiveHookSettlement` — the real contract, plus a maker
hook written the obvious way:

```solidity
function runMakerHook(address target, bytes calldata data) external returns (bool ok) {
    (ok,) = target.call(data);
}
```

In a finished design that call sits inside `fill`, after the contract checks that the maker signed
the hook. **The signature check narrows nothing.** The attacker is the maker. They pick the target,
pick the calldata, then sign their own choice.

Four capabilities follow, each with a passing test:

| Capability | Test | Effect |
|---|---|---|
| Spend any allowance granted to the contract | `test_PoC_AHookDrainsAThirdPartysAllowance` | A third-party maker loses 1,000,000 tokens. The attacker never touches that maker's intent, signature, nonce or custody mode. |
| Move anything the contract holds | `test_PoC_AHookDrainsEveryEscrowedReservation` | Every escrowed reservation leaves. `reservations` still says the money is there, so the honest fill and the maker's `withdraw` both revert for ever. |
| Write an approval and come back later | `test_PoC_AHookCanApproveItselfAndComeBackTomorrow` | The hook calls `approve`, returns, and the fill completes with every check passing. The theft lands 30 days later, outside the reentrancy guard and outside any post-condition the contract could check. |
| Speak with the contract's voice | `test_PoC_AHookSpeaksWithTheSettlementContractsVoice` | The callee reads `msg.sender == settlement`. No contract trusts that today. Every future one becomes reachable the day it ships, with no change here. |

The third is the worst. It defeats defences that operate inside the transaction, which is where
all of this contract's defences live.

The blast radius is every approval ever granted, not the size of any one trade.

### 1.3 The prior art says the same thing, twice, in blood

CoW Protocol separates the roles: users approve `GPv2VaultRelayer`, never `GPv2Settlement`. And
`executeInteractions` carries a literal prohibition:

```solidity
require(interaction.target != address(vaultRelayer), "GPv2: forbidden interaction");
// To prevent possible attack on user funds
```

**Read the second half.** The split alone is not the fix. The arbitrary-call context must also be
forbidden from *reaching* the contract that holds the authority. Otherwise the settlement contract
simply asks the relayer to do the drain on its behalf, and the relayer obliges, because the
settlement contract is exactly who it trusts.

Two incidents make the point sharper than any argument:

- **Transit Swap, October 2022, $23M.** They did the split. They omitted the prohibition.
- **CoW Protocol, February 2023, ~$166k.** The architecture was right and it happened anyway. A
  permissioned, bonded solver granted a max DAI approval from `GPv2Settlement` to a helper
  contract with an arbitrary-call function. The bond turned a theft into a nuisance.

**We have no solver bond and no solver permissioning.** Anyone can call `fillWithCallback` today.
So the CoW failure mode is available to us on strictly easier terms, and the mitigation that
capped their loss does not exist here.

### 1.4 What holds the line today

The shipped contract already calls an address the caller picked. `fillWithCallback` takes `target`
and `data` straight from the executor. It is safe for exactly one reason: the calldata always
opens with the `proveCallback` selector, and the executor's `data` is buried inside that frame as
an argument.

`test_TheFixedSelectorIsTheOnlyThingProtectingTheCallbackPath` asserts it with `vm.expectCall`,
and shows an ERC-20 is not reachable through the path.

That is a real defence. But it is a single implicit property of one call site, and it holds only
while every future call site repeats it. Nothing in the code or the tests said so before today.

### 1.5 The fixes, measured

> **Shipped 2026-08-13. (a), (a′) and (c) are on `master`, exactly as §1.6 recommended.** The
> prices below were predictions from a synthetic harness. The real ones are in §1.8, and the
> split came in cheaper than this section says: **803 gas, not 984. 2.63% of a warm fill, not
> 3.3%.** (b), the trampoline, was not built — §6.5 says there is nothing left for it to wrap.

`forge test --match-path test/Allowance.t.sol -vv`

```
fix                                            gas   delta
-----------------------------------------------------------
transferFrom, called by the settlement        4376   0
transferFrom, called by a relayer             5360   984
hook call, straight from the settlement       1961   0
hook call, through a trampoline               2965   1004
```

**(a) Split the allowance holder out.** A `Relayer` holds nothing and does one thing —
`pull(token, from, to, amount)` — and only for the settlement contract. Makers approve the
relayer. `_release` goes through it in the approval branch.

- Cost: **984 gas** on every approval-custody fill, about 3.3% of a warm fill.
- It removes capability 1 for every call site, present and future.
- It needs a migration. Every existing approval points at the wrong address. **Today that costs
  nothing, because there are no users. The cost grows every day and never shrinks.**

**(a′) Forbid the arbitrary-call context from reaching the relayer.** One line, following CoW:
the callback target and any future hook target may not be the relayer. Without it, (a) is
decorative. Also forbid the settlement contract itself.

**(b) Run hooks through a privilege-free trampoline.** 1,004 gas, paid only by fills that use a
hook. `test_TheTrampolineHoldsNothingSoItsHooksStealNothing` runs the drain payload through it and
the token refuses. It closes all four capabilities **for the call site it wraps, and only that
one.** It is a discipline, not a structure.

**(c) Write the rule down and test it:**

> `ProveSettlement` may call an address it did not choose only through a selector it did choose.
> No call site may take a selector, or a whole calldata blob, from a caller. No call site may
> target the relayer.

### 1.6 What I would do

**Do (a), (a′) and (c) before the first real approval. Treat (b) as what you reach for if a
free-form call site ever becomes unavoidable.**

(b) protects one call site. (a) protects the contract's identity, so the settlement address stops
being worth impersonating whatever future code does. A structural fix survives contributors; a
per-call-site discipline does not — which is precisely what the CoW incident demonstrates, since
their structure was right and a solver reintroduced the hazard on top of it.

(a) alone still leaves escrow exposed if a free-form call ever lands, because the contract holds
escrowed balances directly. (c) is what keeps that from happening. Moving escrow into a vault is
the right end state and it is not urgent.

### 1.7 Three tiers, and what each one actually buys

A later pass restated the split as a ladder, which is a clearer frame than (a)/(b)/(c). Recorded
here with the parts that hold and the one part that does not.

| tier | shape | approvals | isolation |
|---|---|---|---|
| **1 — today** | allowances, escrowed principal and the call surface all at one address | one | none |
| **2 — a shared relayer** | CoW's design: `pull` behind `onlyCreator`, plus a hard prohibition on the settlement targeting it | one, to a different address — **UX identical to today** | one honeypot remains, but it is unreachable from the call surface |
| **3 — per-maker proxies** | N small isolated honeypots, lazy CREATE2 | one per maker, to a per-maker address | a bug or a future call site in `ProveSettlement` reaches nothing without a maker signature that already bounds token, amount and recipient |

**The sharpest form of the argument is that the call surface is already shipped.**
`fillWithCallback` calls `msg.sender` between the release and the payment, on the same contract
that holds every allowance through `_release`'s `safeTransferFrom(i.maker, to, take)` branch. Only
the selector rule stands in between. Tier 2 is a prerequisite for the batch callback ever being
safe, not a companion to it.

### 1.8 What it actually cost, and what it did not buy

Built and deployed 2026-08-13. `ProveRelayer` has no owner, no writable storage, no upgrade path
and one function. `ProveSettlement` deploys it in its own constructor and holds it as an
immutable, so the two point at each other with no initializer, no address prediction and no window
where either is wrong. Three call sites moved: `_release`'s approval branch, `deposit`, and
`_evaluate`'s allowance pre-screen.

`forge test --match-path test/Gas.t.sol -vv`, the same tree before and after:

| path | before | after | delta |
|---|---:|---:|---:|
| `fill`, allowance, warm | 30,506 | 31,309 | **+803** · 2.63% |
| `fill`, allowance, first touch | 110,497 | 113,800 | +3,303 · a cold relayer account |
| `deposit`, first touch | 58,362 | 59,155 | +793 |
| `fill`, escrow, warm | 30,837 | 30,854 | **+17** |
| `fillBatch`, marginal leg | 41,006 | 41,809 | +803 |
| `fillBatchWithCallback`, marginal leg | 48,413 | 49,216 | +803 |
| the credit premium, per leg | 7,407 | 7,407 | **0** |

Cheaper than §1.5 predicted, and flat: one relayer hop per maker release, 803 gas, wherever it
happens. An escrow fill pays 17 gas for carrying the immutable and touches the relayer not at all.
The credit premium is unchanged because the executor side did not move — which is the residual.

**The residual, stated rather than hidden.** An executor's allowance still sits on the settlement.
`_deliverTo` and `_payFee` pull from `msg.sender`, so the sentence "this contract holds no
allowances" is **not** true — only "this contract holds no *maker* allowances" is. The difference
matters if a free-form call site ever lands: a professional executor with a standing max approval
is still drainable through it. Two things make that a smaller problem than the maker case and
neither makes it zero: the executor is the caller, in the transaction, rather than a third party
who never touched the attacker's intent; and an executor can bound their approval per fill, which
a maker signing an offer for later cannot. Moving it too costs another 803 gas on each of the two
executor pulls. **Not taken. It is a separate decision with a real number attached.**

**What the split does not fix.** Escrowed principal is still held at the settlement address, so
rule 1 still guards real money and §1.7's warning stands: the escrow asymmetry argues for a vault,
which nobody has costed, and it was not a reason to take tier 2.

**(a′) is load-bearing, not decorative.** `_requireCallableTarget` refuses a callback whose target
is the relayer or the settlement itself. Neither can call in today — the relayer has one function
and `nonReentrant` stops a self-call — so `test/Relayer.t.sol` reaches the guard with `vm.prank`.
A check that can only be reached by spoofing is still worth writing, because the call site it
protects has not been written yet. That is the whole argument for the split in miniature.

**The migration cost what §1.5 said it would: nothing, and it will never be this cheap again.**
Every approval to the old address now does nothing. There were no real makers, so the whole bill
was 58 approval lines in the test suite and one rename in the SDK.

---

**One argument in that pass does not survive, and it matters because it is the one that sounds
strongest.** It observes that CoW's settlement holds only fee buffers and in-flight amounts — which
is why the February 2023 incident cost $166k rather than everything — while `ProveSettlement` holds
escrowed principal keyed by intent hash, so our blast radius exceeds theirs. True, and it argues
for a **vault**, not a relayer. Tier 2 moves allowances and leaves every escrowed balance exactly
where it is. §1.6 already said so. Do not let the escrow asymmetry be counted as a reason to take
tier 2; it is a reason to take a fourth thing nobody has costed.

**If tier 3 is ever built, the proxy must verify the maker's intent signature itself.** A proxy
that merely installs `ProveSettlement` as a trusted executor re-creates the honeypot with one extra
hop, because the settlement contract can then pull from every proxy that trusts it. The proxy
duplicates a little validation and in exchange `ProveSettlement` carries no standing authority at
all. That is the only version worth the deploy.

Two consequences for §3.4, stated plainly because they cut against what it concludes. §3.4 priced
the proxy as friction bought for one use case; if tier 3 exists for isolation anyway, that pricing
is gone. The batch pre-screen objection then becomes solvable — `_evaluate`'s deep branch would
call a gas-capped `previewAvailable()` `view` on the proxy instead of reading `allowance` and
`balanceOf`, which keeps the cheap skip and can account for what a pre-hook would unlock. And the
escrow objection inverts: a per-maker proxy is a **better** escrow than `reservations`, since the
funds sit where only that maker's signature moves them. **None of this makes the case for building
tier 3. It says the case must be made on isolation, and that hooks then come nearly free.**

**A tension to settle before Pectra lands.** A CREATE2 proxy isolates because it is a *different*
address holding a *scoped* approval. A 7702 delegate puts code at the maker's *own* address, where
every approval they have ever granted and their whole balance already sit. The EIP's own security
section says that after delegation it becomes impossible to know statically whether the balance has
been swept. So 7702 is a convenience upgrade for the hook half and a regression for the custody
half. `executeHooks(calls, nonce, deadline, sig)` is the same interface either way, so designing it
now costs nothing later — but decide which of the two properties you are buying, because the answer
changes what gets built. (An earlier draft of §4 said Pectra was not near-term. That was an
inference, not a measurement. Only the absence today is measured. Treat the fork as arriving.)

---

## 2. `fillBatchWithCallback`

Built, tested, measured. `contracts/src/ProveSettlement.sol`,
`contracts/test/BatchCallback.t.sol`.

```solidity
function fillBatchWithCallback(FillRequest[] calldata reqs, bool skipInvalid, bytes calldata data)
    external nonReentrant returns (uint256 count);
```

### 2.1 The capital efficiency comes from the ordering, not the callback

Validate every leg, write every `filled`, release every `tokenIn` to the caller, call once, pay
every leg. The coincidence of wants nets because the releases all land before any payment is due —
the token one maker sells is already in the executor's hands when the next maker's payment goes
out. This is CoW's `settle` ordering: pull the sell tokens in, run the interactions, pay the buy
tokens out. The callback is only how the executor gets a chance to swap or route in the middle. It
is not the source of anything.

`test_ARingSettlesWithNoWorkingCapital` holds the claim to that standard. The executor starts with
zero of both tokens and is funded with **exactly the two fees and nothing else** — the one thing a
ring does not generate. Both legs settle and the solver keeps the spread.

### 2.2 The contract pulls; it does not measure

**This is the correction that reshaped the design, and the prototype agrees with it.**

The first draft proved payment by snapshotting each payee and checking the balance delta after the
callback. UniswapX's audit considered exactly that for exactly this architecture and rejected it:

> It is imperative to ensure the filler has called the `_fill` function, but this must be done
> without checking the balances of the recipients.

Both UniswapX and 1inch instead make a directed `safeTransferFrom(msg.sender, recipient, amount)`
after the callback. `_deliverTo` now does the same, so payment is something the contract **does**
rather than something it infers.

That kills three bug classes at once, each with a test that would fail under the delta design:

| Bug | Test | Under a delta check |
|---|---|---|
| A donation looks like a payment | `test_ADonationDoesNotDischargeADebt` | The callback gifts the payee the full delivery, the delta passes, the executor pays nothing. Under a pull the payee ends up with both. |
| One payee's two debts share one measurement | `test_TwoLegsToOneRecipientAreBothPaid` | Two legs to one recipient, one payment satisfies both. Under a pull they are two transfers and both happen. |
| Any code in the window pays with someone else's money | `test_TheReleaseIsNotAPayment` | The release lands inside the measured window and counts. Under a pull the release and the payment are transfers in opposite directions, and the arithmetic shows it. |

Two things fall out of this that the delta design had to work for:

- **The aggregation problem disappears.** The delta design had to sum debts per `(token, payee)`
  pair, or one measurement covered two debts. I measured a memory linear scan against a storage
  mapping for that: the scan wins until about 118 distinct pairs, so it was the right answer to a
  question that should never have been asked. The pull needs no aggregation at all, and the code
  and the benchmark are both gone.
- **`SinkIsRecipient` becomes unnecessary on this path.** That guard is the two-party special case
  of the double-count bug — a delta cannot tell the delivery from the fee when the payee is the
  same. A pull does not need to tell them apart. `test_ARecipientThatIsTheSinkGetsBothTransfers`.

**What remains is not a delta check in the same sense.** `_deliverTo` still brackets its own
transfer with a balance read, and that is a different job: it catches a token that taxes its own
transfers, so the maker gets the amount they were promised rather than the amount that was sent.
`test_ATaxedOutputTokenStillFailsTheFill` keeps it honest.

One consequence to know about: a leg whose recipient **is** the executor cannot settle, because the
pull becomes a self-transfer, which moves no balance, and the fee-on-transfer guard reads that as a
short delivery. `fill` and `fillBatch` have always behaved this way. It is a property of the guard,
not of this function.

### 2.3 The caller is the callback target

`target` is gone. The contract releases to and calls back `msg.sender`.

Every comparable system does this — Uniswap V3 `flash`, V4 `unlock`, UniswapX `reactorCallback` —
and it is why none of them needs an ERC-3156-style acceptance magic value. Releasing a maker's
tokens to an address the caller merely names is a wider surface than the trade needs, and closing
it costs nothing.

**Recommend the same one-line change to the existing `fillWithCallback`.** It is an API break:
`app/src/lib/settlement.ts` builds the call and `BatchTray.tsx` renders the target, and both would
need the argument dropped. There are no users, so this is the cheapest it will ever be.

> **Taken, 2026-08-12** (commit `ddab838`). `fillWithCallback` dropped `target` and now calls
> `msg.sender`. The five-argument selector `0xd9d39901` is what answers on chain; the six-argument
> form is gone. `BatchTray.tsx` lost its callback mode with it — a browser wallet cannot be a
> callback target — so the path now belongs to bots, through the SDK, which is who it always
> served.

### 2.4 Gas

`forge test --match-test test_GasReportBatchCallback -vv`. Same intents both ways, one recipient
per leg. Both executors hold inventory, so the difference measures the contract and not the mock,
and both paths are warmed first so no row pays for a cold account.

| legs | `fillBatch` | per leg | `fillBatchWithCallback` | per leg | difference per leg |
|---:|---:|---:|---:|---:|---:|
| 1  | 56,344  | 56,344 | 61,477  | 61,477 | +5,133 |
| 2  | 103,618 | 51,809 | 111,393 | 55,696 | +3,887 |
| 3  | 150,927 | 50,309 | 161,145 | 53,715 | +3,406 |
| 5  | 245,607 | 49,121 | 260,719 | 52,143 | +3,022 |
| 10 | 482,617 | 48,261 | 510,033 | 51,003 | +2,742 |

The marginal leg costs 47,364 through `fillBatch` and 49,839 through the callback form — **about
2,500 gas more**, plus a fixed 5,133 for the callback dispatch and the `Payment[]` encoding. The
pull design is cheaper than the delta design it replaced, which cost 3,939 a leg at the margin.

A solver still chooses on capital, not gas: with inventory, `fillBatch` is cheaper; without it,
`fillBatch` cannot walk a ring at all.

### 2.5 It made everything else cheaper

Against the untouched baseline:

| path | before | after | delta |
|---|---:|---:|---:|
| `fill`, allowance, warm | 30,319 | 29,918 | **−401** |
| `fill`, escrow | 55,407 | 55,006 | **−401** |
| `fill`, allowance, first touch | 110,298 | 109,897 | **−401** |
| `fillBatch` x1 | 56,446 | 56,340 | −106 |
| `fillBatch` x5 | 222,538 | 221,588 | −950 |
| `fillBatch` x20 | 841,432 | 837,318 | −4,114 |

The batch path needed to pay a maker without holding a calldata `Intent`, so `_deliverOnly` split
into itself and `_deliverTo(address token, address to, uint256 amount)`. Plain arguments beat a
calldata struct pointer: the old code re-read `i.tokenOut` and `i.recipient` from calldata on each
of the three touches. That refactor is independent of everything else here and can be taken on its
own.

### 2.6 Verdict

**Ship it.** It is the only way a solver without inventory can settle a ring, it costs about 2,500
gas a leg over `fillBatch` when inventory exists, and it pays for itself in the paths it did not
change. The payment proof is a directed transfer, which is what the systems with the most capital
at risk converged on.

---

## 3. Maker hooks

**Do not ship them.** The research and my prototype agree, and I have nothing to argue back with.
This section first said "ship `ProveShed` instead"; §3.4 withdraws that, so read §3.1 to §3.3 as
the case against in-protocol hooks and §3.4 as the case against the replacement.

### 3.1 What the evidence says

UniswapX has the most capital and the most audit coverage of any system in this shape, and it
shipped its maker hook as `external view` — a veto, not a wallet. The one system going further,
UniswapX v4, is unreleased, untagged, and has zero audit coverage. That is the whole industry
position in two sentences.

CoW solved every motivating case — just-in-time funding, post-fill actions, conditional validation
— **without touching the settlement contract**, with `cow-shed`: a per-user CREATE2 proxy that
verifies an EIP-712 signature over an ordered call array, with a nonce, a deadline and per-call
`allowFailure`. The maker names it as `recipient`.

### 3.2 Where my prototype agrees, and where it adds something

My draft design was a signed envelope — a second EIP-712 struct naming the intent hash, carried in
a separate entrypoint so `fill` and `fillBatch` kept their exact bytecode. I measured the
alternatives so the comparison is real:

| shape | execution | calldata | per no-hook intent |
|---|---:|---:|---:|
| 12 fields, as shipped | 2,070 | — | 0 |
| 13 fields, one `bytes32 hooksHash` | +99 | +128 | **+227** |
| 14 fields, `address` + `bytes` in the struct | +947 | +512 | **+1,459** |
| a separate signed envelope | 0 | 0 | **0** |

`forge test --match-path test/HookCost.t.sol -vv`.

**The envelope is dominated by the shed**, and I should say so plainly. Both cost a no-hook intent
zero. The envelope adds a call site to the contract that holds every approval — which is section 1
— and a `Reason`, and a gas cap, and an ordering rule against the balance checks. The shed adds
nothing to the settlement contract at all. There is no dimension on which the envelope wins.

Two things my prototype contributes that are worth keeping:

**The pull redesign removed the hardest hook constraint.** Under the delta design, a maker
post-hook running between a snapshot and its check could satisfy the check with money that was not
a payment — a hook that claims a reward or triggers a distribution to the recipient, and the
executor keeps the maker's `tokenIn` for free. With directed pulls there is no window to run
inside. The ordering rule that took a section to state is now enforced by the shape of the code.
That is a good reason to prefer the pull independently of hooks.

**A shed cannot do just-in-time funding of the sell side, and neither could an in-protocol
pre-hook without making section 1 worse.** The maker's `tokenIn` must be present when `_release`
runs, and we have no interaction slot before it. CoW does — `settle` has pre-interactions that run
before any transfer — and that slot is exactly the arbitrary-call surface section 1 is about. So:

- Post-fill actions: the shed does them, today, with zero protocol change.
- Conditional validation: the shed does them.
- Just-in-time funding: **not available, and I recommend it stays that way.** Makers who need
  their funds provably present should use escrow custody, which the protocol already sells as the
  "proven" badge, or an ERC-3009 authorization, which funds the escrow at fill time with no maker
  gas. Those two paths exist precisely for this.

### 3.3 What ships instead — superseded by §3.4

A `ProveShed` factory: one CREATE2 proxy per maker, deployed on first use, verifying an EIP-712
signature over an ordered call array with a nonce, a deadline and per-call `allowFailure`. The
maker sets `recipient` to their shed address, which they can compute before it exists.

The settlement contract does not change. It does not learn about hooks, it gains no call site, and
an intent with no hook pays zero because there is nothing to pay for.

`contracts/src/interfaces/IProveMakerHook.sol` carries the in-protocol design and the reasoning
against it. Nothing implements it, and nothing should.

### 3.4 The shed is not needed either — the four cases, one at a time

**Correction to §3.3.** I recommended `ProveShed` as though it were free. It is cheap to deploy —
CREATE2, lazy, address knowable before it exists, authorised by a plain EIP-712 signature from an
ordinary wallet. But it **costs the maker an approval to a second address**, and §4 says there is no
7702 on this chain to make that go away later. So the shed has to earn its place against the cases
one at a time, and it does not.

| case | needs a proxy? | what serves it |
|---|---|---|
| Tokens in the wallet, not approved | **no** | Already shipped. `fillWithAuthorization` with EIP-3009 is the permit pre-hook — the most common hook on CoW in production — gasless, enforced on chain, pinned to the intent hash. |
| Post-fill actions: deposit the proceeds, chain into a position | **no** | A shared, stateless handler named as `recipient`. It spends only what it was just handed, so it acts as itself, not as the maker. `Intent` already separates `maker` from `recipient`. Known cost, stated the same way by Across and CoW: anything left sitting in a shared handler is claimable by anyone. |
| Conditional validation against live state | **no** | A `view` hook, gas-capped, failing to its own `Reason`. §3.5 below; the ERC-1271 probe is already this. |
| Tokens staked, in a vault, or in an LP | yes — **and skip it** | See below. |

The fourth is the only case that must act *as* the maker, and it fails on its own merits before the
approval cost is counted:

- **A proxy only half-solves it.** It can unwind only positions it has access to. Either the maker
  moves the position in — a large ask — or grants an approval, which works for allowance-style
  positions and does nothing for an LP NFT that was never approved or a staking contract keyed to
  the EOA. You build the whole apparatus and still miss cases.
- **It fights the batch pre-screen.** `_evaluate` with `deep = true` reads `allowance(maker, this)`
  and `balanceOf(maker)` so `fillBatch` can skip what cannot settle, and the comment on that branch
  says stepping over a maker who revoked "is the whole point of skipping." A hook that funds
  *during* the fill makes that check lie — it would skip intents that would have worked once the
  hook ran. Weakening it trades a certain, cheap, correct screen for an uncertain one, and that
  screen is what makes batches predictable for executors.
- **Escrow already occupies the niche.** `deposit` is just-in-time funding moved earlier and paid
  for by the maker, and it is what earns the "proven" badge. A maker who declines to escrow because
  they want their capital working until fill time is exactly the maker an executor should price as
  risky. A hook turns a clean no into a maybe, and an executor burns gas discovering which.

**The one shape to never build**, under any framing, is the shortcut that avoids both the proxy and
the approval: a shared contract holding standing allowances from every maker, so hooks can pull on
their behalf. That is Transit Swap, Rubic, Socket and both LI.FI incidents — one contract,
everyone's approvals, a call path somebody can steer. It looks like the wallet-friendly answer and
it is the one that has cost the most money.

### 3.5 Does a hash commitment remove the need for a whitelist?

**No.** The two answer different questions, and treating them as one is what pushes a design into
a whitelist it does not need.

`keccak256(hookData) == i.hooksHash` proves the maker authorised *this exact* hook. It is blind to
content. A whitelist asks something else — may this hook exist at all? — and you only have to ask
it when a hostile hook can hurt somebody other than the maker who signed it.

**The execution context decides that, not the commitment.** CoW is the proof: hooks are arbitrary
`(target, callData, gasLimit)` with no allowlist of any kind, and that is safe because the
trampoline holds no funds, no allowances and no privileges. Their guidance is the inverse of a
whitelist — *do not grant any permissions to the trampoline*. The blast radius of a malicious CoW
hook is the maker's own money.

Run the same hook from `ProveSettlement`, which holds every allowance and every reservation, and a
whitelist becomes forced — and a forced whitelist is a bad trade. Rubic had one and lost $1.4M,
because somebody allowlisted USDC's own address as a router. LI.FI's post-incident code allowlists
`(contract, selector)` pairs instead of addresses, which is stricter and still narrows the maker to
a curated menu. So the ordering is: **an unprivileged context buys permissionless generality**, and
the hash then makes that generality safe against the *executor*. Two defences, both wanted.

**What the hash does constrain is calldata, and that bites harder than a whitelist.** A hash fixes
the bytes at signing time, so the maker must know them before they sign. `FLAG_PARTIAL` makes that
a live problem: a maker cannot commit to "withdraw exactly `take`" when the executor picks `take`
at fill time. CoW handles it by rule rather than by mechanism — pre-hooks run on the first fill
only, post-hooks on every fill — so a pre-hook must cover the whole order in one shot.

The production fix is to split the hook in two. 1inch commits the target plus static `extraData`
and injects the live numbers as separate arguments:

```solidity
IPreInteraction(listener).preInteraction(
    order, extension, orderHash, msg.sender,
    makingAmount, takingAmount, remainingMakingAmount,   // injected by the protocol
    data                                                  // committed in the extension hash
);
```

The maker commits to *which contract runs and how it is configured*. The protocol says *how much*,
and the hook cannot lie about a number it did not supply. Across does the same thing in the ugliest
available way — `makeCallWithBalance` splices the live balance into a pre-zeroed offset in the
committed calldata — which shows how real the constraint is.

**If hooks ever ship here, three classes with different rules, and only one ever wants a
whitelist:**

- **Hooks spending only the maker's own authority** (post-fill deposits, routing). Arbitrary target,
  arbitrary calldata, no whitelist — provided they run from a context holding nothing, carry a
  maker-declared gas cap, and never run inside a payment-measurement window.
- **Hooks that inform protocol arithmetic** (conditional validation, live-state price checks). These
  must be `view`, because they decide the numbers. UniswapX's `IValidationCallback.validate` is
  `external view` for this reason, and it is the only maker hook they shipped. A failure returns a
  new `Reason`, so it invalidates one intent rather than a batch.
- **Hooks inside the measurement window.** None, ever.

The 60,000-gas ERC-1271 staticcall is already the second class done correctly: committed by the
signature scheme, `view`, capped, and its failure returns `Reason.BadSignature` instead of
reverting a batch. One of these exists and works.

**None of this moves the recommendation.** A per-maker shed reaches every case above and asks
`ProveSettlement` for no new call site. `cow-shed`'s `Call` struct even carries the per-call
`allowFailure` the maker chooses. The hash question only becomes urgent if hooks go into the
settlement contract, which is the thing not to do.

### 3.6 The account model, and why the protocol should not pick one

A fourth pass cleared a conflation this document was close to making, and then proposed a design
that its own §3.2 measurement contradicts. Both are recorded.

**A cow-shed proxy is not account abstraction.** It needs CREATE2 and `ecrecover`. No EntryPoint,
no bundler, no paymaster, no 4337, no 7702. The maker signs an ordinary EIP-712 message with an
ordinary wallet — cow-shed's own README has EOAs signing 65 bytes and reserves ERC-1271 for
contracts. **It works on Shanghai, so it works here today.** §4's finding does not rule it out; it
only removes the version that costs no new address.

**And it isolates authority, not code.** cow-shed proxies are ERC-1967 proxies over one shared
implementation. A bug in that implementation reaches every maker at once. Tier 3 in §1.7 buys
blast-radius isolation against a compromised *settlement contract* and against per-maker state
confusion. It does not buy isolation against a bug in the shed. That narrows tier 3's advantage
over tier 2 considerably.

**Which is the case for the relayer over N proxies.** `ProveSettlement` is 937 lines carrying
pricing, Dutch decay, escrow with cooldowns, EIP-3009 redemption, batching with skip semantics, a
callback and fee accounting — and it holds every allowance. `GPv2VaultRelayer` is 85 lines and two
`onlyCreator` functions, and it holds all of CoW's. A relayer is one shared honeypot whose defence
is that there is almost nothing in it to get wrong. That is the bet CoW has run since 2021 without
an approval loss, and their one loss came from a solver granting an allowance out of the settlement
contract, not from the relayer.

**A safety line worth writing down, for any shared-allowance contract:** no function may have a
caller-controlled destination. Transit Swap, Rubic, Socket and both LI.FI incidents were all shared
allowances plus an arbitrary-call surface. A shared allowance with one fixed action and a hardcoded
destination — a "poke" that can only move a maker's funds to the maker — is a different animal,
because anyone may trigger it and nobody profits. It stops being one the moment somebody adds a
`callTo`/`callData` pair.

**On case 4, this changes §3.4's conclusion in one respect.** §3.4 rejected serving staked and
LP'd capital because a proxy only half-solves it. The better answer is that the protocol need not
serve it *or* reject it: a maker deploys whatever contract they want and the intent commits to it.
**You do not have to ship an account system for market makers. You have to permit one.** That
requires no factory, no proxy standard and no guess about which account model wins.

> **Correction, same day.** This first read "capital staked or LP'd across a fill window is a
> professional maker's problem," and that is sloppy. Retail holds staked PLSX, LP tokens and locked
> HEX, and wants out of them. Two different needs were hiding under one label:
>
> - **Inventory efficiency** — capital productive until the instant of fill. Genuinely
>   professional. It pays only when orders rest for hours at size across many quotes. A retail
>   maker in a five-minute Dutch auction forgoes fractions of a cent.
> - **Atomic convenience** — unstake and swap as one action. **Universal**, and CoW's canonical
>   pre-hook example.
>
> **The fact that decides it is neither of those: a proxy cannot unwind a position the EOA already
> holds.** `stakingContract.withdraw()` pays `msg.sender`. Run the hook from a proxy or a
> trampoline and the caller is not the maker, so the call reverts or pays the wrong address. A
> proxy manages only what it *owns*, which means the maker had to stake through it from the start.
>
> That cuts both ways and lands in the same place. Proxies never served the retail case — someone
> holding a 2021 HEX stake opened from their EOA cannot retroactively hand it over, so no amount of
> shed infrastructure reaches them. And professionals already have the capability free, not through
> sophistication but because they chose custody up front. **So the reason not to build proxy
> infrastructure is stronger than §3.4 gave: the users it would be built for still could not use
> it.** For a position already sitting in an EOA, EIP-7702 is the only mechanism that ever works,
> and there is no substitute.
>
> The honest product line: atomic unstake-and-swap is two transactions for an EOA-held position,
> one for anyone custodying through a contract, and one for everybody the day Pectra ships.

**Where the proposal breaks against this document's own numbers.** It recommends adding
`bytes32 hooksHash` to `Intent` — "build the binding, not the actor" — so the protocol takes no
position on the target and stays forward-compatible with 7702. The reasoning is right and the
mechanism is the expensive one. §3.2 measured it: a thirteenth field costs **+227 gas on every
intent that never uses a hook**, forever, while a separate signed envelope costs **zero** and is
equally agnostic about the target. Adding a field also changes the typehash, which invalidates
every signature format in the repo — the fixture, the SDK codec, the app. So if the binding is ever
built, build it as the envelope. The choice between envelope and struct field is settled by
measurement, not by taste, and §3.2 already did the measuring. (The struct field has now been
proposed twice, the second time as "one field, one line of typehash and one keccak." The count is
right and the price is still 227 gas on every intent that never uses it.)

**The sequencing that follows, if hooks are ever revisited:** the relayer split first, because it
is breaking, cheap, and helps whatever else is decided; then a `view` validation hook and a
post-fill handler, which cover cases 2 and 3 with no proxy anywhere; and leave case 4 to
maker-deployed contracts. Nothing here overturns the decision at the top of this document. It
changes what to build *if* that decision is ever reversed.

---

## 4. EIP-7702 makers

> **Measured, 2026-08-12: PulseChain cannot do this yet, on either network.** Live header fields,
> mainnet 369 at block 27,271,992 and testnet 943 at block 25,115,835:
>
> | field | fork it signals | 369 | 943 |
> |---|---|---|---|
> | `withdrawalsRoot` | Shanghai | present | present |
> | `blobGasUsed`, `excessBlobGas`, `parentBeaconBlockRoot` | **Cancun** | absent | absent |
> | `requestsHash` | **Prague** | absent | absent |
>
> Both chains are on Shanghai. **EIP-7702 shipped in Prague, so no delegated EOA can exist here.**
> Everything below is insurance against a fork that has not happened, not a live defence. Keep it —
> the ordering costs nothing and the day the fork lands nobody will re-derive this — but do not
> count it as a shipped protection, and note that `Eip7702.t.sol` is on the research branch, not on
> `master`.
>
> Two live consequences fall out of the same measurement, and both are already handled:
>
> - **No transient storage.** `_entered` toggling 1↔2 in real storage is the correct pattern here,
>   not a legacy one. Any batch accounting must stay in memory; a Uniswap-V4-style delta ledger
>   would cost real `SSTORE`s.
> - **No `MCOPY`.** This is why `foundry.toml` pins `evm_version = "paris"`, and why the faucet
>   tokens hand-roll EIP-712 instead of inheriting OpenZeppelin's, which reaches code that emits it.
>
> The smart-account argument cuts the opposite way from the hopeful reading, and it is worth being
> plain about: 7702 does not make maker hooks redundant here. It removes the escape hatch. That
> **raises** the bar for building a per-maker proxy rather than lowering it.
>
> Read that precisely, because the near miss is easy: it does **not** mean a proxy is unavailable.
> A cow-shed proxy needs only CREATE2 and `ecrecover` and runs on Shanghai — see §3.6. What is
> unavailable is the version that costs the maker no new address.

A delegated EOA carries 23 bytes of code: `0xef0100` and the delegate address. So
`code.length != 0`, and any checker that asks "is this a contract?" before trying `ecrecover`
takes the ERC-1271 branch. Permit2 and OpenZeppelin's `SignatureChecker` both do that, and both
fail for a delegated EOA whose delegate does not implement ERC-1271 — which is most of them.

`_validSignature` tries `ecrecover` first and falls through to ERC-1271 only when the recovery does
not match. A delegated EOA still holds its own key, so the recovery matches and the fall-through
never runs. This is the 1inch, Seaport and CoW ordering and it is the right one.

**It is right by accident until somebody writes it down.** `contracts/test/Eip7702.t.sol` now does:

- `test_ADelegatedEoaHasCodeAndStillFills` — asserts `code.length == 23`, then fills.
- `test_TheViewAgreesBeforeAndAfterDelegation` — `fillability` returns `Ok` either way.
- `test_TheErc1271BranchAloneWouldRejectTheSameMaker` — the branch a code-length-first checker
  would reach answers nothing, and `fillBatch` with `skipInvalid` does not drop the maker over it.

Do not reorder `_validSignature` into a code-length check. The tests are the tripwire.

---

## 5. Rules that follow, whatever ships

1. `ProveSettlement` may call an address it did not choose only through a selector it did choose.
   No call site takes a selector or a calldata blob from a caller. Test it at every call site.
2. ~~Split the allowance holder out before the first real approval, and forbid the arbitrary-call
   context from reaching it. 984 gas a fill. Both halves, or neither is worth doing.~~ **Done,
   2026-08-13, both halves. 803 gas a fill.** The rule it leaves behind: no call site may target
   the relayer, and no maker allowance may live on the settlement. §1.8.
3. Prove payment by making the transfer, not by measuring a balance. A balance read is for
   catching a dishonest token, and it brackets one transfer and nothing else.
4. Callbacks go to `msg.sender`. A caller-named target is a wider surface than any trade needs.
5. `ecrecover` first, ERC-1271 second. A delegated EOA has code and still signs with its key.

---

## 6. Pluggable decay, and what else deserves a hook

> **Asked 2026-08-12, after `fillBatchWithCallback` shipped:** can the decay curve be defined by
> another contract, and are there other parts of the trade that should become hooks?
>
> **Answer: do curves with spare `flags` bits, not with a hook.** Measured below. An external
> curve costs 1,130 gas a leg for the interface a real curve would need, and 2,919 the first time
> an intent names a curve nobody has touched. A second built-in curve, chosen by a bit the maker
> already signs, costs **231** — and **96** on every intent that does not ask for one.
>
> Everything else the question reaches for is already answered: executor-side payment shipped
> today, and §3.4 showed conditional validation and post-fill delivery need no protocol change at
> all. Just-in-time funding stays refused.

### 6.1 The signature is the bound

`minOutAt` is `public pure` (`ProveSettlement.sol:290`). The maker signs four numbers and the
price at any timestamp follows from them alone. The maker knows their worst case before they sign:
it is `minOutEnd`. `_evaluate:888` enforces the direction too — `minOutEnd > minOutStart` is
`BadTerms_`, so the floor can only fall.

Replace those numbers with an `address` and the signature stops bounding the trade. It delegates
the bound to code the maker never read. Three separate costs follow, and only the first is about
gas.

**Determinism.** A solver simulates, then fills. A curve that reads storage its owner can change,
or a balance, or an oracle, answers differently between the two. The solver buys the other leg,
and then the fill reverts or pays worse. That is the harm the escrow cooldown exists to prevent
reintroduced one layer up where no cooldown is watching.

**Purity is unenforceable.** There is no on-chain check for "this is a pure function of the signed
fields and the timestamp". A whitelist of curve addresses would work, and a whitelist is the thing
§3.5 concluded you cannot avoid — which is an argument against the whole shape, not for it.

**Gas, measured.** Below.

### 6.2 What a curve costs, per evaluation

`minOutAt` runs inside `_quote`, and `_quote` runs once per fill leg. So a per-evaluation number
is a per-leg number.

`forge test --match-path test/CurveCost.t.sol -vv`. Each shape is measured in its own call frame —
measured together, the last row pays for memory the earlier rows expanded into. Both built-in
shapes are `internal`, so via-IR inlines them the way it inlines `minOutAt` into `_quote` today.
The curve contracts run the same linear arithmetic the shipped code runs, so every external number
is a **floor**: dispatch and call, with nothing charged for the curve's own work.

| shape | gas | premium per leg | % of a 41,006 gas leg |
|---|---:|---:|---:|
| shipped, inline linear | 1,011 | — | — |
| flag branch, bit clear | 1,107 | **+96** | 0.23% |
| flag branch, bit set, squared decay | 1,242 | **+231** | 0.56% |
| staticcall, five values, warm | 1,449 | +438 | 1.07% |
| staticcall, whole intent, warm | 2,141 | **+1,130** | 2.76% |
| staticcall, five values, cold | 3,930 | **+2,919** | 7.12% |

Deterministic across runs.

**Read the table honestly.** Against the leanest interface anyone could write — five words in, one
word out — a warm call is +438 and a second built-in curve is +231. That is a factor of two, not
an order of magnitude. My first estimate — "about 2,600 gas, call it 6% of a leg" — turns out to
describe the **cold** row, at 2,919 and 7.1%, and to overstate a warm call by six times. It named
the wrong case rather than mis-multiplying, which is the more useful kind of error to record: a
curve is cheap once an address is warm, and the first intent to name it pays for all the others.
But the lean interface is not the interesting one either: a curve worth plugging in wants the
fields the maker signed, and that is the +1,130 row. Against that the branch wins by 4x, and by
12x on the cold row, which is what an intent naming an unfamiliar curve pays.

The row that decides it is **+96**. That is what a plain intent pays for the existence of a curve
bit it never sets — a quarter of one percent of a leg. An external curve cannot get near that,
because the branch has to exist either way and the call is on top of it.

### 6.3 If an external curve is ever built, clamp it

The safe shape keeps the signed envelope and lets the curve move only inside it:

```
out = clamp(curve(...), minOutEnd, minOutStart)
```

A broken or hostile curve can then only ask for **more** than the floor, never less. The maker
cannot be harmed by code they did not read; the worst case is still the number they signed. What
remains is a solver whose simulation was wasted, which is a solver's own risk to price, and
solvers can refuse curve addresses they do not know.

`testFuzz_AClampedCurveCanNeverPayTheMakerBelowTheSignedFloor` holds the clamp to that over 512
runs. It is a property test for a design that is not built, kept because the clamp is the whole
reason the design would be admissible.

### 6.4 Six spare bits

`flags` is a signed `uint8` and uses two: `FLAG_PARTIAL = 1`, `FLAG_ESCROW = 2`
(`ProveSettlement.sol:77-78`). Six are free. They cost nothing to carry — `flags` is already in the
struct, already in the typehash, already signed — so a curve library selected by those bits adds
**no calldata, no field, no typehash change and no external call**.

Three curves would cover what people ask for:

- **squared** — front-loaded decay, most of the concession in the first part of the window. The
  measured row above.
- **staircase** — discrete price steps, which is what an RFQ-style flow wants instead of a
  continuous slide.
- **linear** — what ships, and the default when no bit is set.

The signature still determines the outcome completely, the code stays pure and auditable, and a
maker can still compute their worst case before signing. Every property §6.1 is about survives.

### 6.5 The rest of the trade

Ranked by whether a hook is the answer, not by how appealing the feature is.

| stage | hook? | why |
|---|---|---|
| executor pays for the fill | **shipped** | `fillWithCallback`, `fillBatchWithCallback` |
| conditional validation | no protocol change | §3.4: a maker-deployed contract does it today |
| post-fill delivery | no protocol change | §3.4: the recipient can already be a contract |
| pricing / decay | **flags, not hooks** | §6.2 |
| just-in-time funding of the sell side | **refused** | §3.2 |
| fee routing | **no** | a per-intent fee hook is a fee-dodge surface |

Two of those deserve a sentence each.

**Validity predicates are the best hook on their merits, and still should not be one.** A
predicate can only restrict: a revert or a false means no fill, so the failure mode is safe by
construction, unlike pricing where a wrong answer moves money. That makes it the one place where
delegating to unread code does not endanger the maker. But §3.4 already showed a maker-deployed
contract does conditional validation with zero protocol change, so the merit is not in dispute —
the necessity is.

**Post-fill delivery has a griefing edge that pricing does not.** Depositing the output into a
lending market, staking it, bridging it — all wanted, all available through the recipient today.
In-protocol, the hook's gas lands on the executor, who never agreed to it, so it would need a
maker-signed gas cap priced into the quote. That is a second field and a second failure mode for a
capability that already exists outside the contract.

### 6.6 Verdict

**Curves: flags, if anyone asks for them.** +96 gas on intents that do not, +231 on intents that
do, no new field and no new call surface. Nothing here is urgent; no maker has asked.

**Hooks: nothing changes.** Every remaining stage is either shipped, served outside the protocol,
or refused for a reason §1 through §3 already gave. The relevant point is the one that has held
through this whole document: each hook declined is a call surface that never lands on the contract
holding every allowance. That is the same argument as the relayer split in §1.5(a), which is still
open and still the owner's call.

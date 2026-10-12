# Delegation, and a maker's actions in one transaction

**Status: recommendation 1 is built; the rest is still proposed.** The keyed nonce floor and
`park` reading it landed as backlog #131, and `docs/ROADMAP.md` now carries a row for it.
Nothing else here is built: no multicall, no plural maker functions, no delegation. This
document is the place that argues all of them.

**What #131 changed against this document.** The lane layout is what Part 5 recommends. The
argument's shape is unchanged: one word per lane, monotonic, no preimage, and nothing a
wallet signs moves. Two things the built version says that this document did not. The
argument to `invalidateBefore` is a nonce rather than a lane and a position side by side, so
the selector, the ABI and every existing caller survive — the price is that
`invalidateBefore(type(uint256).max)` now retires the top lane rather than everything. And a
strict floor can never retire the top position of its own lane, which was already true of
`type(uint256).max` under the single floor and is now true once per lane; `cancel` reaches
those. Both are tested in `contracts/test/Lanes.t.sol`.

**The archive query this document asked for was not run.** It is still the right check and it
is still unmeasured: no intent whose nonce exceeds 2^64 should exist, and nothing in this
repository can produce one — `app/src/lib/nonce-lane.test.ts` reads every source that builds
a nonce and pins the set. That is a claim about our own code, not about the board.

`contracts/src/ProveSettlement.sol` is the authority. Every gas figure came from one command,
named beside it. Every opcode fact came from a probe against the two chains in the registry, not
from a configuration file's comment. Where I could not measure something I write "unmeasured" and
say what would measure it.

**Read this before you trust a number here.** I wrote it on 2026-09-08 at commit `59c670f`, with
`contracts/src/ProveSettlement.sol` uncommitted and changing under me — escrow rollover (#120)
was landing at the same time. Every citation resolves against that working tree, and
`contracts/tools/check-citations.py` was run against this file:

```
cd contracts && python3 tools/check-citations.py --doc docs/specs/2026-09-08-delegation-and-bulk-maker-actions.md
```

72 citations, 0 stale. Two citations in this document are outside the tool's reach — it checks
`.sol`, `.ts`, `.tsx` and `.md` only, so the two into `.yml` and `.mjs` are hand-checked and
will rot unguarded. This file belongs in that tool's `DOC_FILES`, beside
`docs/FEE-MODEL.md`, `docs/AUDIT-SCOPE.md` and the netting spec, for the reason the tool's own
comment gives: it is a live decision document, not a dated record. The day escrow rollover
commits, run the checker again.

**Two sentences before anything else.** Nothing recommended here changes what a wallet signs.
Everything recommended here needs a redeploy, because nothing in this repository is upgradeable
and the domain separator hashes `address(this)`.

---

## Part 0 — The short answer

1. **The owner is right that the defence is patchwork, and the measurement says why.** A maker
   has two off switches. The selective one needs the whole intent, one transaction each, at
   57,954 gas. The cheap one is positional and cannot spare a single signature. Neither of them
   frees the escrow behind a signature it kills, which is the half nobody had counted.
2. **The best fix is neither delegation nor a multicall. It is a keyed nonce floor**, and it
   costs nothing a wallet signs, because `nonce` is already a signed `uint256` and the high bits
   of it are free. Part 5 has the argument and the backward-compatibility measurement.
3. **A generic `multicall` is safe here and buys about a fifth of the gas.** It fixes no part of
   the real problem: a maker who cannot produce eight preimages cannot send eight cancels, folded
   into one transaction or not. **No comparable settlement contract ships one** — not UniswapX,
   not Seaport, not CoW — and Part 3 says what they built instead.
4. **Delegation is a much smaller feature than it sounds, and the reason is a good one.** Of the
   seven maker-facing operations, three take no caller check at all, so any contract can already
   batch them for any maker. Of the four that do check `msg.sender`, two move principal to the
   caller and can be delegated only with the payee pinned. What is left worth delegating is the
   right to cancel. The owner's premise is also half wrong: a contract can already be a maker,
   through ERC-1271.
5. **The case that decides the delegation design is the destination.** `withdraw` can pin its
   payee for free, because `i.maker` is already in its calldata. `withdrawParked` cannot, because
   it has no intent and therefore no maker — pinning it means a breaking change to a live
   function signature. That asymmetry, and nothing else, sets the shape. A survey of the field
   found almost nothing pins a destination, and that **this contract already pins the one that
   matters most**: `recipient` is a signed field, so the fill path uses the strongest pattern
   anybody has built. The exit path does not, and delegation is what makes that gap real.

---

## Part 1 — What a maker can do today, checked rather than assumed

Six claims were handed to me. Five hold exactly. One is right in substance and wrong in the
error it names.

| claim | verdict |
|---|---|
| `cancel` takes one intent, needs the full preimage, checks the caller against `i.maker` | Holds. `contracts/src/ProveSettlement.sol:1429` takes `Intent calldata`, and `contracts/src/ProveSettlement.sol:1429` reverts. The error is `NotOwner`, not `BadParameter` — `withdraw` is the one that answers `BadParameter` to the same test, at `contracts/src/ProveSettlement.sol:1144` |
| `invalidateBefore` sets a monotonic per-maker floor, enforced on the fill path, positional | Holds. Monotonic at `contracts/src/ProveSettlement.sol:1469`, written at `contracts/src/ProveSettlement.sol:1469`, enforced by `_evaluate` at `contracts/src/ProveSettlement.sol:2677` and read by `ProveReader.available` (moved off the settlement) at `contracts/src/ProveReader.sol:236` |
| There is no multicall on the settlement | Holds. `ProveSettlement.sol` contains no `delegatecall` and no multicall of any kind |
| `withdraw` and `withdrawParked` both pay `msg.sender`, and `_parked` is keyed by `msg.sender` | Holds. `contracts/src/ProveSettlement.sol:1429` and `contracts/src/ProveSettlement.sol:1278` both `safeTransfer` to the caller; the row is read at `contracts/src/ProveSettlement.sol:1325` and cleared at `contracts/src/ProveSettlement.sol:1203` |
| The guard is a plain flag; `deposit`, `withdraw`, `withdrawParked` and `claim` take it, `cancel`, `invalidateBefore` and `park` do not | Holds. The slot is `_entered` at `contracts/src/ProveSettlement.sol:731`, the modifier at `contracts/src/ProveSettlement.sol:897-900`. `sweepUnowned` and every fill entry point also take it; the claim was about maker functions and it is correct about those |
| ERC-1271 makers are supported, so a contract can already be a maker | Holds. `_validSignature` tries `ecrecover` first and falls through to a capped staticcall at `contracts/src/ProveSettlement.sol:3059` |

### Every maker-facing operation, and what it costs

The gas column comes from one command:

```
cd contracts && forge test --match-path test/Gas.t.sol -vv
```

The `park` and `withdrawParked` rows have no entry in that table, so they come from a second
command, which reports the callee frame rather than the caller's `gasleft` delta:

```
cd contracts && forge test --match-path test/Parked.t.sol --gas-report
```

| operation | who may call it | what it needs | guard | gas |
|---|---|---|---|---|
| `deposit(Intent,uint256)` | anybody | the whole intent | `nonReentrant` | 91,780 new, 69,814 top-up |
| `withdraw(Intent)` | `i.maker` alone | the whole intent | `nonReentrant` | 78,084 |
| `park(Intent)` | anybody | the whole intent | none | 29,523 min, 99,225 max |
| `withdrawParked(address)` | whoever owns the row | one address | `nonReentrant` | 29,903 min, 44,244 max |
| `cancel(Intent)` | `i.maker` alone | the whole intent | none | 57,954 |
| `invalidateBefore(uint256)` | any maker, for themselves | one word | none | 45,855 |
| `claim(address,address)` | anybody | two addresses | `nonReentrant` | 51,877 |

**None of the maker rows reach the landing page.** `app/src/landing/gas.ts` is generated from the
same test and gated in CI by `node app/scripts/gen-gas.mjs --check`, at
`.github/workflows/ci.yml:182`. But it carries a curated subset: `deposit, first touch` and
`claim, a destination empties its book` are in it, and `cancel, one intent`, `withdraw, and the
offer ends`, `deposit, new reservation`, `deposit, top-up` and `invalidateBefore, the whole book`
are not. So the figures a maker would care about are measured on every CI run and shown to
nobody. If either feature here is built, the maker rows should be added to the `WANTED` list in
`app/scripts/gen-gas.mjs:51`, so a regression in the cost of getting out is a build failure
rather than a thing somebody notices later.

Two notes on the numbers, because mixing them would be the fourth wrong number this repository
has carried forward. `forge test -vv` measures a `gasleft` delta around the call, so it includes
encoding the struct and the CALL itself, and excludes the 21,000 intrinsic cost of a transaction.
`--gas-report` measures only the callee frame, so its `cancel` reads 51,024 to 51,036 where the
table reads 57,954. The spread on `park` and `withdrawParked` is cold slots against warm ones,
and on `park` it also covers reverts, which the report counts.

**The split that matters is not gas. It is authority.** Three of the seven — `deposit`, `park`
and `claim` — take no caller check at all. Any contract can already loop them today, for any
maker, with no change to the settlement. Four check `msg.sender`. Those four, and only those
four, are what a bulk primitive cannot reach from outside and what a delegate would have to hold.

That is why Part A and Part B are the same problem seen from two sides.

---

## Part 2 — The gap escrow rollover opened, and whether the defence closes it

### What was lost

The contract says it in its own words, above `FLAG_ESCROW` at
`contracts/src/ProveSettlement.sol:375-394`:

> An escrow intent the maker never funded used to be inert for ever: `_evaluate` answered
> `EscrowShort` and only a transaction from the maker could change that. It was the one property
> this rung had that no other rung had. Since `_drawFromParked`, any solver may fund it from
> capital `park` freed out of another offer of theirs — no action by the maker, at a moment the
> solver picks.

And then the defence, naming `cancel` and `invalidateBefore`, at
`contracts/src/ProveSettlement.sol:382-384`:

> `cancel` and `invalidateBefore` are the off switches, they always were, and they are now the
> only ones. A maker who calls off one offer to move its capital must call off every other
> signature they do not want funded with it.

`docs/AUDIT-SCOPE.md:1214-1217` carries the same `cancel` paragraph as section 6.11, and
`docs/ROADMAP.md:93` records `park` as the reason #120 cost the property.

### The defence, measured

Take a maker with twelve resting signatures who wants to retire eight and keep four.

**With `invalidateBefore`.** One transaction, 45,855 gas — but only if the four survivors are the
four newest. The floor is a single number and every signature below it dies. Both surfaces that
build an intent set `nonce: BigInt(Date.now())`, at `app/src/components/Compose.tsx:559` and
`app/src/rfq/MakeQuote.tsx:274`, so the ordering the floor sorts by is signing time and nothing
else. A maker whose survivors are interleaved by age cannot use it at all.

**With `cancel`.** Eight transactions. 8 × 57,954 = 463,632 gas of execution, plus 8 × 21,000 =
168,000 of intrinsic cost, plus the calldata. An `Intent` is seventeen static fields
(`contracts/src/ProveSettlement.sol:525` names all seventeen), so it encodes to 544 bytes and a
`cancel` call carries 548 bytes with its selector. At the Paris rule of 16 gas a non-zero byte and
4 a zero one, that is between 2,192 and 8,768 gas per call depending on how many bytes are zero —
so the honest total is roughly 650,000 to 700,000 gas across eight transactions.

**And the maker must hold eight preimages.** This is the part that gas cannot fix. `cancel` takes
`Intent calldata`, not a hash, and it must: `deposit` takes the preimage for the same reason, so
that the signature rather than the caller decides who owns a reservation. A maker who cleared
their browser has lost their `IndexedDB` store. The preimages are recoverable from the public
board — the `msgboard` archive at `sdk/src/archive.ts:5-7` is a read-only endpoint holding up to
a year of messages — but that is a third-party service the protocol does not run, and its own doc
says it "gives the book breadth; it proves nothing".

### The half nobody had counted

**`invalidateBefore` kills the signature and leaves the money stuck.** Its own doc says the first
half, at `contracts/src/ProveSettlement.sol:1429-1430`: escrowed funds are not released by it.
What the doc does not say is the consequence. `park` refuses any intent that is neither expired
nor cancelled, at `contracts/src/ProveSettlement.sol:1278`, and it reads `endTime` and
`cancelledAt` and never the floor. So an escrow intent below the maker's floor is dead to
`_evaluate` and still unparkable. Its capital sits in `_reserved` until `endTime` passes, or
until the maker sends a per-intent `cancel` or `withdraw` after all.

So the bulk switch does not compose with the bulk exit. **That is the patchwork, stated as a
mechanism rather than as a feeling**, and it is the strongest single argument in this document
for doing something.

### Three realistic situations, counted

| situation | transactions today | the binding constraint |
|---|---|---|
| Retire eight of twelve signatures, keep four, interleaved by age | 8 | `cancel` is per-intent and needs each preimage |
| Retire eight of twelve, keep the four newest | 1 | none — `invalidateBefore` already does this |
| Park five dead offers in two tokens and take the capital home | 2, if anybody parks them | `park` is permissionless, so a keeper folds all five into one transaction of their own |
| The same, with nobody else willing to park | 7 | 5 × `park` plus 2 × `withdrawParked` |
| Cancel everything and withdraw across three tokens, six funded escrow offers | 6 | `withdraw` refunds and ends the offer in one call, but it is per-intent, and `invalidateBefore` cannot substitute because it does not make the escrow parkable |

The third row is the one that should change how this reads. **The capital side of the bulk
problem is already solved, and `park` being permissionless is what solved it.** A keeper, a
solver or the maker's own contract can retire and pool any number of dead reservations today,
with no protocol change, because `park` takes no authority and pays nobody.

---

## Part 3 — Bulk maker actions

### Option 1 — a generic `multicall(bytes[] calldata)` over `delegatecall`

Work the hazard classes properly. Three of the four are answered by facts about this contract
rather than by design.

**`msg.value` in a loop.** Not a hazard here, and the reason is measurable rather than argued:

```
cd contracts && grep -n 'payable' src/ProveSettlement.sol src/ProveRelayer.sol
```

That returns nothing. Neither contract has a single `payable` function, so no entry point reads
`msg.value` and there is nothing for a loop to spend twice. OpenZeppelin's own `Multicall` is not
`payable` either. **But this becomes a standing constraint rather than a closed question.** The
double-spend needs a payable function that reads `msg.value` once per iteration. Adding a
multicall today makes adding a payable function tomorrow a vulnerability rather than a feature,
and nobody would remember why.

**`delegatecall` and `msg.sender`.** A self-`delegatecall` preserves both `msg.sender` and
`address(this)`. So inside a multicall, `withdraw` still pays the outer caller at
`contracts/src/ProveSettlement.sol:1393`, and `withdrawParked` still reads the outer caller's row
at `contracts/src/ProveSettlement.sol:1200`. That preservation is exactly what makes a multicall
safe here — and it is exactly what delegation has to break. **The two features want opposite
things out of the same word.** Build the multicall first and delegation gets harder, because
every `msg.sender` read becomes a place two callers can arrive.

**The reentrancy flag blocking its own contents.** It does, if the multicall carries the
modifier. OpenZeppelin states the rule in `ReentrancyGuard`'s own doc: functions marked
`nonReentrant` may not call one another. A guarded multicall over this contract could therefore
carry only `cancel`, `invalidateBefore` and `park` — the three unguarded ones — and would revert
`Reentrant` on `withdraw`, `withdrawParked`, `deposit` and `claim`, which are most of the reason
to want it. So the multicall must be unguarded.

An unguarded multicall over guarded functions is correct, and the reason is worth writing down
because it is not obvious. Each inner call takes the flag and releases it, so nothing deadlocks;
what changes is that the flag now brackets each payout in a sequence instead of bracketing the
whole transaction. A token that calls back during the third of five withdrawals finds the guard
shut for that withdrawal and open between them. That is safe here because every guarded function
finishes its book writes before its transfer: `withdraw` zeroes `_reserved`, decrements
`_totalReserved` and writes `cancelledAt` before the `safeTransfer` at
`contracts/src/ProveSettlement.sol:1151`; `withdrawParked` clears the row at
`contracts/src/ProveSettlement.sol:1318` before the transfer at
`contracts/src/ProveSettlement.sol:1278`; `claim` does the same. `deposit` transfers first, but it
credits from a balance delta it brackets itself, at `contracts/src/ProveSettlement.sol:1149`.
Checks-effects-interactions holds on all four, so the window between them exposes nothing.

**Whether a generic entry point composes a sequence no single call permits.** This is the one
that deserved the question, and `park` being permissionless is why. The sequence to fear is
`park(A); park(B); withdrawParked(token)` — two permissionless calls feeding a payout. A stranger
can build it. It pays them nothing, because `withdrawParked` reads `_parked[msg.sender][token]`
at `contracts/src/ProveSettlement.sol:1472` and the stranger's row is empty. The parks credited
`_parked[i.maker]`, keyed off the preimage. **Every payout in this contract is keyed by the
address that will receive it, so composition adds no authority.** That is the same property that
makes `park` safe to leave open in the first place.

What a maker gains is real but small: they can park their own dead offers and sweep the proceeds
in one transaction instead of several. They could already do that from a contract of their own.

**What it would cost, and what it buys.**

```
cd contracts && forge build --sizes
```

`ProveSettlement` is 22,000 bytes of runtime code with 2,576 bytes of margin under the EIP-170
limit. That is enough for a multicall and not enough to be casual about it. How much OpenZeppelin's
`Multicall` costs here is unmeasured; what would settle it is inheriting it and running that
command again.

The gas it buys is 21,000 per folded transaction, less about 64 bytes of array overhead per
element — an offset word and a length word that a standalone call does not pay. Folding eight
cancels saves seven intrinsic costs, about 147,000 gas, and gives back at most 7,200. Call it a
fifth of the total. Real, and not the problem.

### Option 2 — targeted plural functions

`cancelMany(Intent[])`, `parkMany(Intent[])`, `withdrawMany(Intent[])`,
`withdrawParkedMany(address[])`.

They are strictly easier to reason about. There is no `delegatecall`, so `msg.sender` never
becomes a question. There is no composition, so the fourth hazard class does not arise. They
carry less calldata per item than the generic form, because an array of a static struct needs no
per-element offset or length.

They cost more surface. Four functions are four more places `msg.sender` is read and four more
selectors in a contract with 2,576 bytes of margin. And they inherit an open question the audit
scope already records: `docs/AUDIT-SCOPE.md:1951-1953` notes that `MAX_BATCH_LEGS` is an
off-chain bound in `sdk/src/solver/plan.ts:119` and that nothing in `ProveSettlement` bounds an
array length. A plural maker function adds a second unbounded array to that finding.

`parkMany` should not be built under any circumstance. `park` is permissionless, so a keeper's
own contract can loop it today. Adding it to the settlement pays bytecode for something the
outside world can already do.

### Option 3 — neither, and what makes that acceptable

Three things make it acceptable, and they are cumulative.

1. **The capital side is already batchable by anybody**, because `park` and `deposit` take no
   caller check. The measurement in Part 2 shows the five-offer cleanup costing the maker two
   transactions when a keeper parks, not seven.
2. **The signature side is better fixed by a keyed nonce floor than by any amount of batching.**
   A multicall makes eight cancels cheaper. A keyed floor makes them unnecessary, and it needs no
   preimage — which is the constraint gas cannot touch. Part 5 has the argument.
3. **Neither bulk form fixes the escrow that a killed signature leaves stranded.** Batching
   `cancel` works, because `cancel` writes `cancelledAt` and that makes the intent parkable. But
   at that point the maker is sending eight preimages again, which is the thing they could not
   do.

**Recommendation for Part A: build neither.** Say so in the roadmap, so the next person does not
re-derive it.

### What every comparable settlement contract built instead

I surveyed the field for this too, because a negative result is worth more when somebody else
reached it first.

**No settlement contract in this class ships a generic multicall over its own ABI.** UniswapX's
reactor has four entry points, every one of them guarded, and the arbitrary code a filler wants is
not a list of calls back into the reactor — it is one callback into the filler's own contract,
between a fixed prepare and a fixed fill. Seaport ships plural fulfilment functions and no
multicall. CoW's settlement does take an arbitrary interaction list, and fences it four ways: an
allow-listed solver, an explicit refusal to let an interaction target the vault relayer, three
fixed phases the solver cannot interleave, and a modifier that makes certain functions reachable
only from inside a batch.

**The CoW fence is a lesson rather than a rule to copy, and this contract already has its shape.**
That one address comparison is enough only because every fund-pulling authority sits at a single
immutable address. `ProveRelayer` is that address here, and `callableTarget` at
`contracts/src/ProveSettlement.sol:2902` already refuses both it and the settlement as callers.
The structure transfers. The multicall does not.

The 2023 CoW solver incident is the case that tested it, and it is the one worth reading. A solver
deployed a helper with an arbitrary-call interface and granted it a maximum token approval **from
the settlement contract**. An attacker drained through the helper, and reached only the week's
accumulated protocol fees — roughly $166,500 — because user orders were protected exactly as the
design said. The fence held. **The lesson for any batch: enumerate not only what the batch may
call, but what authority it may leave behind.** A multicall here can leave behind nothing, because
the settlement grants no allowances to anybody. That is one more reason the generic form is safe
here, and one more reason it buys so little.

Two incidents fill in hazard classes this section worked abstractly.

**The `msg.value` case is MISO, August 2021.** BoringSolidity's batch helper delegatecalls in a
loop, and MISO's auction credited a bid by `msg.value`, so one payment bought as many bids as the
array was long. Around 109,000 ETH was exposed and a whitehat rescue closed it the same day, so
nothing was lost. The rule from that disclosure is the one to write down: **if you use `msg.value`
to check that payment was received, you cannot put that logic in a loop.** Nothing in this
contract is payable, so the rule is a constraint on the future rather than a finding today.

**The composition case is Abracadabra's batch entry point, October 2025, about $1.7M.** It relaxed
a per-call solvency check into one check at the end of the batch — which is the right design, and
what UniswapX and Uniswap V4 both do — and then let a sub-action overwrite the flag that decided
whether the check ran. Two rules follow, and they are the ones to hold if a batch is ever built
here: **a batch-final invariant must be monotone, and it must be owned by the contract holding the
funds rather than by the dispatcher.**

One version note, if OpenZeppelin's `Multicall` is ever inherited. The ERC-2771 spoofing fix was a
blog disclosure with no CVE, but backporting it to the 4.9 branch left a duplicated
`delegatecall`, so **every subcall ran twice in 4.9.4** — CVE-2023-49798, fixed in 4.9.5. The copy
vendored here is v5.5.0 and carries neither defect. Pin a version; do not track a branch.

Finally, the read side is already on the safe side of this and should stay there.
`sdk/src/multicall.ts:13` names `MULTICALL3` and uses it for view calls only, and Multicall3's own
documentation says never to approve it to spend tokens. Nothing in this repository does.

---

## Part 4 — Delegation

The owner's framing: *"an owner of an intent can delegate a certain threshold of control over to
a contract, otherwise users are stuck with EOAs."*

One correction before the design, because it changes the size of the problem. **Users are not
stuck with EOAs.** A contract can be a maker today: `_validSignature` falls through to `ERC-1271`
at `contracts/src/ProveSettlement.sol:3059`, `docs/ROADMAP.md:33` lists `ERC-1271` makers as
live, and `docs/AUDIT-SCOPE.md:742` already runs an action matrix against an `ERC-1271` maker. What a user
cannot do today is keep an EOA as the maker and hand a contract bounded powers over it. That is
the real feature, and it is narrower.

### What may be delegated

A right set, one bit each, and the honest set is small.

| right | verdict | why |
|---|---|---|
| `cancel` and `invalidateBefore` | **Delegate this.** It is nearly the whole feature | Neither moves a token. A rogue delegate retires offers the maker wanted; the maker signs again. The loss is gas and opportunity, and it falls only on the maker |
| `park` | Do not build it | `park` is already permissionless. A right to do what anyone may do is a right that means nothing |
| `deposit` | **Never.** | `deposit` pulls from `msg.sender` through the `relayer` at `contracts/src/ProveSettlement.sol:1152`. A delegate calling it spends the delegate's own tokens, which is useless. A delegate that could spend the *maker's* allowance to the relayer holds a spend right over every token the maker approved, which is the most dangerous object in this design |
| `withdraw` | Delegate it only with the destination pinned | It moves principal, and today it moves it to the caller |
| `withdrawParked` | Delegate it only with the destination pinned, and only if somebody asks | Same, and pinning it costs a breaking signature change |
| `claim` | Nothing to delegate | Already permissionless, and it always pays the sink's registered destination (since `4d48379`; it paid `feeTo`, the map key, when this was written). `docs/AUDIT-SCOPE.md:550` states that `msg.sender` decides nothing there |

**So the set is: cancel, and optionally withdraw.** That is a much smaller feature than the
framing implies, and the smallness is the point rather than a disappointment. Every "the delegate
profits" story in Part 4's adversarial section needs the delegate to be able to sign an intent,
and no right in this set can.

### What "a certain threshold" should mean

Four candidates, and three of them lose for one reason.

**An amount ceiling loses because the destination has already solved what it defends.** A ceiling
bounds how much a delegate can move. Once the payee is pinned to the maker, the money goes home
whatever the amount, so the ceiling protects nothing and costs a storage word and a decrement on
every call. It is a defence against theft, and pinning the destination is what stops theft.

**A per-token limit loses for the same reason, and costs a mapping per triple.**

**A right set is not optional.** Without one, "delegate" is a single boolean and the boolean has
to mean the union of everything, which is the maximal grant. That is precisely what nobody wants
to sign.

**A time bound earns its slot, and it is the only bound that does.** Permit2 is the prior art and
its packing is the argument: `approve(token, spender, amount, expiration)` stores a `uint160`
amount, a `uint48` expiration and a `uint48` nonce, which is one storage word, one `SSTORE` to
grant and one `SLOAD` to spend. An expiry is the only bound that survives a maker who has lost the
delegate's address, lost interest, or simply forgotten. Every other bound needs the maker to come
back and act.

Permit2 also shows what a revoke call does not do. `lockdown` zeroes the amount and leaves the
expiration untouched, so a reader of the slot after a revocation still sees a live-looking
timestamp. And killing a grant there takes two calls, not one: `lockdown` for the standing
allowance and `invalidateNonces` for the unspent signatures that would reinstall it. **A grant
made by transaction rather than by signature has neither problem**, which is the shape recommended
here.

**Recommendation: a right bitmap and an expiry, in one storage word.** One mapping from maker to
delegate to a `uint256`, with rights in the low bits and a `uint64` expiry above them. One
`SSTORE` to grant, one to revoke, one `SLOAD` on the authority check. No per-token map, no
amount, no decrement.

```solidity
// Illustrative only. Nothing here is built.
uint256 constant RIGHT_CANCEL   = 1;
uint256 constant RIGHT_WITHDRAW = 2;

mapping(address maker => mapping(address delegate => uint256)) private _granted;

function _mayAct(address maker, uint256 right) private view returns (bool) {
    if (msg.sender == maker) return true;
    uint256 g = _granted[maker][msg.sender];
    return g & right != 0 && block.timestamp < (g >> 64);
}
```

### The destination problem, which is the crux

Today control and destination are the same address by construction. `withdrawParked`'s own doc
leans on that: there is no argument naming a maker, so there is nothing for a caller to point at
somebody else. `docs/AUDIT-SCOPE.md:596` states the same property as a defence — `withdrawParked`
reads `msg.sender`, so it cannot name the payee. **A delegate calling either function today would
be paid the maker's principal.** Any delegation design that does not answer this is a theft
mechanism.

There are three ways to pin the payee and they cost wildly different amounts.

**1. A `to` parameter, refused unless it equals the maker.** Reject it. If the only legal value is
derivable, do not ask a caller for it; you have added a way to get it wrong and bought nothing.

**2. `withdraw` pins its payee for free.** `i.maker` is already in its calldata. Pay `i.maker`
instead of `msg.sender` at `contracts/src/ProveSettlement.sol:1105`, and check the caller with
`_mayAct(i.maker, RIGHT_WITHDRAW)` instead of the equality at
`contracts/src/ProveSettlement.sol:1144`. **For every caller who can call it today, the behaviour
is bit-identical**, because today the caller must already be `i.maker`. That is the whole change,
and it costs nothing.

**3. `withdrawParked` cannot pin its payee without a breaking change.** It has no intent, so it
has no maker — it has only `msg.sender`, at `contracts/src/ProveSettlement.sol:1472`. Letting a
delegate call it means growing the signature to `withdrawParked(address maker, address token)`,
paying `maker`, keying the row on `maker`, and adding an authority check to replace the property
that keying on the caller used to give for free.

**What that costs elsewhere.** The selector changes, so every client pinned to the old one
breaks. `contracts/abi/ProveSettlement.json` is generated and the SDK reads it, so the ABI
follows automatically — but `sdk/src/abi.ts` and any deployed bot carry a copy that must be
regenerated. It also deletes a sentence from the audit scope: `docs/AUDIT-SCOPE.md:595` currently
says a solver cannot name the row and `withdrawParked` cannot name the payee. After the change,
a caller does name the row, and only the authority check stops them naming somebody else's. That
is a real reduction in safety-by-construction, traded for a feature nobody has yet asked for.

**Recommendation: pin `withdraw`, and leave `withdrawParked` alone until somebody asks.**

### What everybody else does about the destination

I ran a survey of the field before recommending anything. **Almost nothing pins the destination.**
Bounded delegation on EVM overwhelmingly bounds *how much* and *which action*, and leaves *where*
to the caller.

| grant | amount bound | destination bound |
|---|---|---|
| ERC-4626 share allowance | yes, in shares | no — `receiver` is a free parameter |
| ERC-7540 `setOperator` | no, one boolean | no, and the spec warns about it |
| Compound III `allow` | no, one boolean | no — free `to` |
| Morpho `setAuthorization` | no, one boolean | no — free `receiver` |
| Euler EVC operator | no, one bit per sub-account | no — arbitrary call |
| Uniswap V3 and V4 position approval | no | no — an approved operator decreases liquidity and takes the proceeds to itself |
| Permit2 `permitTransferFrom` | a ceiling | no — `to` is calldata, outside the typehash |
| Safe's Allowance module | token, amount and period | no — free `to`, including the delegate itself |
| Aave credit delegation | yes | none to argue about: the cash is hardcoded to `msg.sender` |

Two protocols pin it, and both do the same thing: **they put the destination inside the
signature.** A 1inch limit order carries `receiver` in its type hash. UniswapX carries
`OutputToken.recipient` inside the Permit2 witness, so the maker signs where their output goes and
the filler chooses only its own side.

**prove.cash already does that, and it is worth noticing before designing anything new.**
`recipient` is one of the seventeen signed fields at `contracts/src/ProveSettlement.sol:525`, and
`_payMaker` delivers to `i.recipient` at `contracts/src/ProveSettlement.sol:1726`. **The fill path
already uses the strongest pattern the survey found.** The exit path does not — and it did not
need to, because `withdraw` and `withdrawParked` were written under a rule that made a destination
unnecessary. Delegation is exactly the change that retires that rule.

Two more patterns are directly usable, and both are already deployed elsewhere.

**Sablier pins the payee by rule for a caller who is not the owner.** Anyone at all may call its
withdraw; a caller who is neither the owner nor approved must send to the owner, or the call
reverts. That is the recommendation of the previous section, running in production.

**Gearbox withholds the exit instead.** A bot holds per-account permission bits, and a grant with
the withdraw-collateral bit off genuinely cannot take funds out, because there is no destination to
argue about. That is this document's cancel-only recommendation, also running in production.

The survey supplies one caution I did not have, and it settles the ranking in the previous
section. **An amount ceiling is not the defence people think it is.** Safe's Allowance module is a
real, audited, deployed bounded spend delegate — `(safe, delegate, token)` to an amount, a spent
counter and a rolling reset period, packed into one word. Its `to` parameter has no check of any
kind. The bound is "drain up to this much of this token per period, **to any address I choose,
including my own**". It bounds how much, how often and which token, and not where.

And one that cuts the other way, which is why the pin has to be checked rather than assumed.
ERC-4626's free `receiver` looks like a hole and is mostly cosmetic: an approved spender could
equally `transferFrom` the shares and redeem as the owner. **Pinning a payout buys nothing if the
claim itself is transferable under the same authority.** Checked here: a reservation is not
transferable. `_reserved` is keyed by the intent hash, and the only thing that moves a row is
`park`, which moves it to `_parked[i.maker]` — a key the preimage decides, at
`contracts/src/ProveSettlement.sol:1266`. So the pin holds.

### Why not honour an existing delegation registry

delegate.xyz's registry is the nearest off-the-shelf right set, and it should not be used here.

It is an **attestation** registry. It holds nothing, enforces nothing, and never checks that the
grantor still owns what they delegated — every consumer must re-check ownership itself. Its amount
field is a declared upper bound with no consume path anywhere in the contract, so a consumer
wanting a real allowance tracks the spending in its own storage. Nothing expires: there is no
validity window, no epoch, no time-to-live.

The rights semantics are the sharp edge. **A `rights` value of zero is not "no rights" — it is the
superset**, and the hierarchy is a hard-coded chain, so a maker who granted a delegate the right to
*see* their tokens finds the fungible-token check answering `type(uint256).max`. It is also not
standardised: ERC-5639 is in Review and describes the earlier API, without rights or amounts.
Honouring the registry would mean importing every integrator's private reading of an unnamespaced
string. **One word of this contract's own storage is smaller and says exactly what it means.**

ERC-7710's caveat model is worth taking one idea from and no more. It splits what the delegator
signs (`terms`) from what the redeemer supplies at redemption (`args`), and only the first is
covered by the signature. Here there is no signature over a grant at all — the grant is a
transaction — so the split collapses and every bound lives in storage, which is simpler and
strictly stronger. What that model gets wrong is the asymmetry to avoid: **a delegation is free to
issue off-chain and costs an on-chain transaction to revoke, on every chain it reaches.** That is
the second argument for the expiry.

### Revocation

Three properties, and the design gets all three from one storage word.

**Immediate.** One `SSTORE` of zero, biting on the block it lands, exactly as `cancel` does at
`contracts/src/ProveSettlement.sol:1437`. No cooldown, for the reason `withdraw`'s doc gives for
having none: every path settles in a single transaction, and a single transaction cannot be
front-run by the person sending it.

**Reachable by a maker who has lost the delegate contract.** The grant lives in the settlement's
own map, keyed by `(maker, delegate)`, and revoking never calls the delegate. So a delegate that
has self-destructed, been paused, or turned hostile cannot block its own revocation. **Authority
must live where it is checked.**

Seaport's conduits get that half right and the other half wrong, and the contrast is the reason to
write the rule down. A conduit's channels live in the `ConduitController`, so opening and closing
one never calls the channel — good. But only the conduit's owner may close a channel, and a
channel bounds nothing: it can move any approved token, of any user, in any amount, to any
recipient. `Conduit` says so in its own header, warning that a malicious or negligent owner can
add a channel that takes any approved token immediately. **A user's only revocation is to set their
token approval to zero, across every marketplace using that conduit.** The grant here must be
revocable by the grantor, one delegate at a time, and that is not a detail.

**Reachable by a maker who has lost the delegate's address.** They read it off the grant event.
Failing that, the expiry closes the grant without them, which is the whole argument for the
expiry in the previous section.

**One invariant to state and test: no delegate right can lower a nonce floor.**
`invalidateBefore` is monotonic at `contracts/src/ProveSettlement.sol:1469`, and it must stay
monotonic per maker regardless of who called it. A maker's floor is the maker's floor. A delegate
may raise it and may never move it back.

### How it interacts with ERC-1271, permissionless `park`, and a forgotten signature

**ERC-1271.** A delegation check must never route through the signature path. `_validSignature`
staticcalls the maker under a 60,000 gas cap at `contracts/src/ProveSettlement.sol:3059`, and
`docs/AUDIT-SCOPE.md:2050-2052` already carries an open audit question about whether that cap is
enough for a real Safe. A delegate is an authority check on `msg.sender`, so it must stay a map
read and inherit none of that.

**A contract maker with a delegate under it.** Recommend honouring a grant identically for an EOA
maker and a contract maker, with no special case. A contract maker's own logic already bounds
what its owner may do; a settlement-level delegate beneath it would be a second, weaker bound
that the contract's author never wrote. Adding a special case would be a rule the maker never
signed.

**`park` being permissionless, and parked capital funding a signature the maker forgot.**
Delegation does not touch the mechanism and must not pretend to. What it changes is who can shut
the forgotten signature off. A delegate holding only the cancel right can retire it — which is
the entire point, and the reason that right is the one worth building. A delegate holding the
withdraw right closes the hole differently, by taking the capital out of play; that is a blunter
answer to the same question.

### The adversarial cases

**A malicious delegate holding the cancel right.** It retires the maker's whole book. Nobody else
loses anything: a cancelled intent cannot fill, and a solver who raced it reads `Cancelled` out
of `_evaluate` rather than taking a loss. The maker loses gas and missed fills and signs again.
**Accepted**, and this is the grant that is safe enough to ship.

**A malicious delegate holding the withdraw right.** With the payee pinned to `i.maker` it is not
theft — the money goes home. It is griefing, and it is strictly stronger than what a stranger can
do today: a stranger can `park` only a dead offer, because `park` refuses a live one at
`contracts/src/ProveSettlement.sol:1186`, while `withdraw` ends a live one and moves its capital.
So this grant hands a delegate a power no outsider has. **Accepted only if the maker is told
that, in the words the grant is made in.**

**A delegate contract that is later upgraded.** A grant to an upgradeable address is a grant to
whoever holds its upgrade key, and the settlement cannot see that. It must not try:
`EXTCODEHASH` pinning breaks every proxy, and the delegates people would actually use — a Safe,
an ERC-4337 account — are proxies. **The expiry is the whole answer**, because it forces the
maker to look again. Say plainly in the client that a grant to a proxy is a grant to its admin.
This document does not solve that and no on-chain mechanism can.

**A delegate that is itself the solver.** The sharpest case. A solver holding the cancel right
over a maker can retire that maker's *other* offers immediately before filling one, removing the
maker's own competing liquidity. It cannot move the price of the fill in hand, because `_quote`
reads that maker's own signed curve and nothing else, at
`contracts/src/ProveSettlement.sol:1088`. So the harm is confined to the maker's other
signatures. **The protocol cannot detect this conflict.** `i.executor` names an exclusive
executor, and a delegate is not that field; and refusing a grant to an address that appears as
`i.executor` on any live intent is not enforceable, because the settlement holds no index of a
maker's intents. What would settle it is a client-side warning built off the board, and a
client-side warning is not a protocol guarantee. Say so.

**A delegate holding rights over a maker whose intents name a `feeTo` the delegate controls.**
Work it through and the interaction is almost null, for a reason worth stating. `feeConfig` (`feeTo` before the fee config change) and
`feeRate` are signed fields, at `contracts/src/ProveSettlement.sol:125` and
`contracts/src/ProveSettlement.sol:142`, so a delegate cannot move the destination or raise the
rate. No right in the set lets a delegate sign an intent, and none must. So the delegate's `feeTo`
earns exactly what the maker already agreed to.

The residual is real and small. A delegate with the cancel right can retire the maker's zero-fee
signatures and spare the fee-bearing ones, steering fills toward its own destination. The maker
set both rates themselves. Name it in the disclosure and move on.

---

## Part 5 — Audited parts, named constants, and the fix that beats both features

The standing rule is to prefer known, audited contracts over hand-rolled ones. OpenZeppelin is
already a dependency — `ProveExecutor.sol` imports `Clones` and `SafeERC20` is used throughout —
so adopting more of it costs no new trust. `contracts/lib/openzeppelin-contracts/contracts/utils/`
vendors `Multicall.sol`, `ReentrancyGuard.sol`, `ReentrancyGuardTransient.sol`, `Nonces.sol`,
`NoncesKeyed.sol` and `Context.sol`.

I read all five. Two should be adopted in spirit and none in substance, and the reasons are
specific rather than a preference for local code.

### The reentrancy guard

**What is there.** `uint256 private _entered = 1` at `contracts/src/ProveSettlement.sol:731`, and
a modifier comparing against bare literals at `contracts/src/ProveSettlement.sol:976-979`. The
slot comment says 1 is idle and 2 is inside a fill, and never zero, because a slot returning to
zero pays the 20,000-gas `SSTORE` again.

**Does the linter catch it?**

```
cd contracts && forge lint src/ProveSettlement.sol
```

Twelve `literal-instead-of-constant` findings in this file, and the guard's 1 and 2 are not among
them. So no tool is asking for this. The case is readability, and it is a good case anyway.

**What OpenZeppelin's `ReentrancyGuard` actually is.** The same design with `NOT_ENTERED` and
`ENTERED` constants and an audit behind it — with two differences worth knowing.

First, it does **not** sit in the sequential storage layout. It keeps the flag in an ERC-7201
namespaced slot, `REENTRANCY_GUARD_STORAGE`, derived from a hashed string. So adopting it moves
the guard out of slot order rather than shifting anything after it. That makes the layout
question smaller than it looks — and the question turns out not to bite either way, because
nothing depends on the settlement's layout. Nothing puts it behind a proxy: `Clones` appears only
in the two executors, minting `ProveCallSink` clones. The one test that pins a guard slot by
number pins the executor's, in `invariant_TheGuardIsOpenBetweenRings` at
`contracts/test/ExecutorInvariants.t.sol:240`, not the settlement's.

Second, and this is what decides it: **OpenZeppelin has already deprecated it.** The file says so
in its own header — this storage-based guard will be removed and replaced by the transient
variant in v6.0.

**And the transient variant cannot run here.** Not by inference from a configuration file, but by
measurement. `app/scripts/check-opcodes.ts` executes hand-written creation code through
`eth_call` on each registered chain — `PUSH1 1, PUSH1 0, <opcode>` and a return, each probe paired
with an identical `SSTORE` control so a broken probe cannot be read as a missing opcode.

```
cd app && npm run check:opcodes
```

Chain 369 and chain 943, identical, on 2026-09-08: `SSTORE` activated, `TSTORE` **not activated**
— the node answers `revert: NotActivated` — `MCOPY` not activated, `PUSH0` **activated**.

So `ReentrancyGuardTransient` is rejected for a measured reason: the opcode it needs does not
exist on either chain this protocol runs on.

**Recommendation: take the constants, not the contract.** Declare `NOT_ENTERED` and `ENTERED` in
`ProveSettlement.sol` and use them in the modifier. Identical bytecode, no slot movement, no
inheritance, and it delivers exactly what the rule asks for. Adopting the base contract would buy
an audit over a design this file already copies line for line, at the price of inheriting a
deprecation and moving a slot.

**Behaviour change: none. What a wallet signs: nothing.** One caveat if the base contract is ever
adopted anyway — the revert becomes `ReentrancyGuardReentrantCall` instead of `Reentrant`, which
is a client-visible change to a decoded error.

### `PUSH0`, and what the Paris pin is actually buying

The probe turned up something the reentrancy question did not ask for. **`PUSH0` is activated on
both chains in the registry.** `contracts/foundry.toml:9-11` pins `evm_version = "paris"` with the
comment that the bytecode then runs on any EVM chain the registry might add later, without
anybody checking which hard forks that chain took. Both chains that exist today are past
Shanghai. So the pin is paying size on the two real chains to stay portable to chains nobody has
added.

Measured, with the same command under an override:

```
cd contracts && forge build --sizes
cd contracts && FOUNDRY_EVM_VERSION=shanghai forge build --sizes
cd contracts && FOUNDRY_EVM_VERSION=cancun forge build --sizes
```

| setting | runtime size | margin under EIP-170 | what the pin costs |
|---|---|---|---|
| `paris`, as pinned | 22,000 B | 2,576 B | — |
| `shanghai` | 21,665 B | 2,911 B | 335 B |
| `cancun` | 21,625 B | 2,951 B | 375 B |

**335 bytes to reach what both chains already run, or 13% of the remaining margin.** Cancun adds
only 40 bytes more, and the probe says neither chain would accept it. That is the price, and it is
small in absolute terms and not small relative to what is left.

**Recommendation: keep Paris.** The saving is 335 bytes; the cost of being wrong is a contract
that will not deploy on a chain somebody adds, discovered at deploy time. The pin buys optionality
against a failure that is expensive and hard to see coming, and `app/scripts/check-opcodes.ts`
already watches the assumption so the choice is reviewed rather than remembered. Revisit it only
if the margin becomes the binding constraint on a feature — which, given Part 3 recommends
building no multicall, it is not.

### `Nonces` and `NoncesKeyed` — and the fix that beats both features

This is the most important section in the document.

**OpenZeppelin's `NoncesKeyed` cannot be inherited here.** Its semantics are wrong, not merely
inconvenient. It follows ERC-4337's semi-abstracted nonce: `_useCheckedNonce` demands the exact
next value and increments by one. prove.cash makers post many live signatures at once, and fills
land in whatever order solvers find them. The floor is a high-water mark, not a counter —
`_laneFloor`, at `contracts/src/ProveSettlement.sol:583`, declares it that way and `_retired`, at
`contracts/src/ProveSettlement.sol:2697`, reads it that way. Inheriting `NoncesKeyed` would force
every signature to be filled in signing order, which deletes the resting book. **Reject the
contract.**

**Adopt its idea.** `NoncesKeyed` packs a `uint192` key and a `uint64` sequence into one
`uint256` — key in the high bits, sequence in the low 64. Apply that to the floor rather than to a
counter:

```solidity
// This is what #131 built, with one change from the sketch this section first carried.
mapping(address maker => mapping(uint192 lane => uint64)) private _laneFloor;

// The sketch took a lane and a position side by side. The built version takes ONE word, read
// the way every nonce here is read, so the selector does not move and a maker can retire a
// dead signature by passing `deadNonce + 1` without splitting it themselves.
function invalidateBefore(uint256 floor) external { /* monotonic per lane */ }

// and, in _evaluate, in place of the single comparison:
//   if (uint64(i.nonce) < _laneFloor[i.maker][uint192(i.nonce >> 64)]) return NonceTooLow;
```

A maker groups their signatures into lanes when they sign — one lane per pair, per strategy, per
session, whatever they choose. Then one word retires one lane and spares every other. **That is
selective bulk revocation with no preimage at all**, which is the constraint neither a multicall
nor a delegate can touch.

**It costs nothing a wallet signs.** `nonce` is already a `uint256` and already inside
`INTENT_TYPEHASH`, at `contracts/src/ProveSettlement.sol:512`. Reading its high bits as a lane
changes no field name, no type and no ordering. This is the identical move `FLAG_PERMIT2` made,
and the contract already argues it at `contracts/src/ProveSettlement.sol:394-400`: a free bit of a
field that was already in the signed struct cost no type-hash change, no codec version and no
re-signing of anything. The counterexample is on the record too — `docs/ROADMAP.md:87` says
`minFill` moved the type hash, so the wire codec went to VERSION 3 and every intent signed before
it stopped verifying. A keyed nonce is the first kind of change, not the second.

**It is backward compatible with every signature this repository has ever produced, and that is
measured rather than assumed.** Both surfaces that build an intent set `nonce: BigInt(Date.now())`
— `app/src/components/Compose.tsx:559` and `app/src/rfq/MakeQuote.tsx:274`. A millisecond epoch is
about 1.8 × 10^12. A `uint64` holds about 1.8 × 10^19. So every nonce in the wild has a zero high
192 bits and sits in lane 0, and lane 0's floor is exactly today's `_nonceFloor`. Today's
`invalidateBefore(floor)` keeps its meaning for every signature resting on the board.

**The honest caveat.** The migration is safe *because* of that, and not in general. A maker who
hand-rolled an intent with a nonce above 2^64 would find their signature moved to a different
lane and their old floor no longer covering it. What would settle it is a query over the msgboard
archive for any intent whose nonce exceeds 2^64; I have not run it, and it should be run before
this ships.

> **Amended 2026-09-09, after the query ran.** `app/scripts/check-nonce-lanes.ts` is that query,
> and it reports 9,125 intents across chains 369 and 943 — every one of them in lane 0, the
> highest nonce among them 1,788,959,897,310,104. It reads all four wire versions rather than the
> current one, and that mattered: the mainnet board carries versions 1 and 3, so a first run
> through the SDK's own `decodeIntent` parsed nothing there and would have reported a clean sweep
> of an empty set.
>
> The paragraph above also undercounts the producers. A third one signs intents — `heartbeat.ts`,
> the bot, at `nonce: BigInt(Date.now()) * 1000n + jitter`. That is about 1.8 × 10^15, a
> thousandfold above the two surfaces named above, and it is what the highest archived nonce
> actually is. It is still six thousand times below a lane, so the conclusion holds and only the
> reasoning was short. Three other repository claims said "every nonce is a millisecond epoch" on
> the strength of this paragraph, and all three are corrected.

**One more thing must land in the same change.** A keyed floor kills a lane's signatures and still
does not free their escrow, because `park` reads `endTime` and `cancelledAt` at
`contracts/src/ProveSettlement.sol:1288` and never reads the floor. Part 2 measured that gap for
today's `invalidateBefore`, and keying the floor inherits it exactly. Teach `park` to accept an
intent that sits below its maker's floor, or the bulk switch still leaves the money stuck.

### Adopting OpenZeppelin's `Multicall`, if a multicall is ever built

What it actually does: `multicall(bytes[] calldata data)` loops `Address.functionDelegateCall`
against `address(this)`. It is not `payable`. Since 5.0.1 it detects a non-canonical context —
`msg.sender != _msgSender()` — and re-appends the trailing context bytes of `msg.data` to each
subcall, so it is safe under `ERC2771Context`.

Its own documented warning: any assumption about calldata validation performed by the sender may
be violated, and a relay address that filters function selectors will not filter calls nested
inside a multicall.

Checked against this contract: `ProveSettlement` does not inherit `Context` and has no ERC-2771
anything, so `msg.sender` always equals `_msgSender()` and the suffix logic is dead weight — a
branch and a call on every multicall, plus `Context` in the inheritance chain of a contract with
2,576 bytes of margin. The selector-filter warning has one place to bite: the `callableTarget`
modifier at `contracts/src/ProveSettlement.sol:2902` refuses the relayer and the contract itself
as callers. A `delegatecall` from `multicall` does not change `msg.sender`, so it cannot smuggle
a call past that check. **The warning does not bite here, and it would bite the moment anybody
adds a caller-based filter.**

Verdict: if a multicall is ever built, inherit OpenZeppelin's rather than write one. Part 3 says
do not build one.

---

## Part 6 — The recommendation

**Nothing here is upgradeable, and that constrains every option.** The settlement has no proxy —
`Clones` appears only in the executors, minting `ProveCallSink` clones. So changing the guard,
the `evm_version`, the nonce reading or anything else about the bytecode means a new address, and
the domain separator hashes `address(this)` at `contracts/src/ProveSettlement.sol:926`. A new
address re-domains every EIP-712 signature ever made against the old one.

**So every flip in this document is a redeploy event and belongs in the same redeploy as #35.**
`docs/ROADMAP.md:72` already says the deployed `settlement` is older than the source and
everything below it needs #35 first. The item itself is `Redeploy all contracts under the new
key`, at `docs/ROADMAP.md:429`. **There is no runtime switch worth
building here**, and this paragraph exists so that nobody proposes one later. A flag that chooses
between two guard designs, or two nonce readings, buys a branch on every call and a second code
path to audit, to avoid a redeploy that is happening anyway.

In order:

1. **Build the keyed nonce floor**, and teach `park` about it in the same change. It is the
   smallest thing that closes the gap escrow rollover opened, it needs no preimage, it costs one
   storage word per lane, and it costs nothing a wallet signs. Run the archive query for nonces
   above 2^64 first.
2. **Name the guard's constants.** `NOT_ENTERED` and `ENTERED` in `ProveSettlement.sol`, not
   OpenZeppelin's deprecated base contract, and not the transient one, whose opcode the node
   answers `revert: NotActivated` for.
3. **Keep `evm_version = "paris"`.** The measured price is 335 bytes.
4. **Build no multicall and no plural maker functions.** Record the negative result in the
   roadmap with the measurement, so it is not re-derived.
5. **Build delegation only if a user asks for it**, and then only the cancel right, with an
   expiry, revocable in one `SSTORE` that never calls the delegate. Pin `withdraw` to `i.maker`
   in the same change, because that is free. Leave `withdrawParked` alone.
6. **Never delegate `deposit`.**

### Does anything a wallet signs change?

**No.** This is the loudest fact in the document, so it gets its own answer.

`INTENT_TYPEHASH` does not move. Its seventeen fields, at
`contracts/src/ProveSettlement.sol:524-525`, keep their names, their types and their order. The
SDK's mirror of that list, `TYPES` at `sdk/src/intent.ts:288-310`, does not move either — and its own comment
says why that matters: change one entry there and every signature the package produces becomes
unspendable.

The keyed nonce reinterprets the high bits of a field the maker already signs. The guard
constants change no bytes of behaviour. Pinning `withdraw`'s payee changes an authority check,
not a signed term. A delegate grant is a map keyed on `msg.sender`, checked at call time, and
signed by nobody.

The one thing that does change is the address, and only because a redeploy changes it. Every
signature resting on the board today is already domained to the deployed `settlement`, which
`docs/ROADMAP.md:72` records as older than this source. #35 re-domains them whatever this
document recommends.

---

## Part 7 — What would change the answer

- **A maker who signs a nonce above 2^64.** Then the keyed reading is a behaviour change and needs
  a flag bit — three are free — rather than a reinterpretation. Settle it with a query over the
  msgboard archive before shipping.
- **A real user who wants a contract to run their book.** Delegation moves from fifth place to
  second. Until somebody asks, the cancel right is a feature with no user.
- **PulseChain shipping Cancun.** `TSTORE` becomes available, `ReentrancyGuardTransient` stops
  being rejected, and the guard question reopens with a real gas saving behind it.
  `app/scripts/check-opcodes.ts` is wired into the nightly soak, so this arrives as a failing
  check rather than as a thing somebody remembered.
- **The runtime margin becoming binding.** At 2,576 bytes, every option here fits. A feature that
  eats the margin makes the Paris pin and the multicall compete for the same bytes, and the
  recommendation in Part 5 would have to be re-argued.
- **EIP-7702 reaching either chain.** It would weaken neither feature as much as it sounds.
  A 7702 authorization is `[chain_id, address, nonce, y_parity, r, s]` — no amount, no target
  list, no expiry, no selector. **It is a pointer, not a policy**, and every bound still lives in
  whatever contract the pointer names, which is the contract this document is about. It also
  installs one code pointer per account per chain, so a maker whose wallet already delegated
  elsewhere could not install a bounded delegate of their own. The record is not encouraging
  either: by mid-2025, more than 97% of mainnet authorizations pointed at one reused sweeper
  contract. And it is not close here anyway —
  `docs/specs/2026-08-10-prove-cash-design.md:169-174` already forbids depending on a
  delegated EOA, it is the entry that keeps `_validSignature` trying `ecrecover` first, and the
  probe says `PUSH0` is the newest thing either chain has taken.

## What I could not settle

- **The bytecode cost of inheriting OpenZeppelin's `Multicall` here.** Unmeasured. Inherit it and
  run `forge build --sizes`.
- **Whether any live intent carries a nonce above 2^64.** Unmeasured. Query the `msgboard`
  archive endpoint that `sdk/src/archive.ts:5-7` describes.
- **Whether a 60,000-gas cap is enough for a Safe as an `ERC-1271` maker.** That question is
  already open against `_validSignature`, at `docs/AUDIT-SCOPE.md:2052-2054`. Delegation does not
  depend on the answer, because a delegate check is a map read. A contract maker holding a
  delegate does.

**On the outside sources.** Every number about another protocol in this document — the CoW solver
incident, the MISO exposure, the Abracadabra loss, the ERC-2771 regression, the EIP-7702 adoption
figure — came from a survey of published sources, not from a command I ran. They are cited to
carry an argument about shape, and none of them decides a recommendation on its own. The measured
claims in this document are the ones with a command printed beside them. Delegation does not depend on the answer, because a delegate
  check is a map read, but a contract maker holding a delegate does.

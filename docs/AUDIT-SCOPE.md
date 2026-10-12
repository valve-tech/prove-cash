# Audit scope — prove.cash contracts

> **Update 2026-10-03: the fee config change (`feat/fee-config-hash`, merged to `master` at `fa1c696` on 2026-10-05, not deployed).**
> This pack was written against the sink-registry design. That design is gone. **The body was
> rewritten for the fee config design on 2026-10-05** (sections 1 to 4, 6.2, 6.4, 6.7, 6.9, 8 and
> 9.1); sections 7 and 10 keep the sink design on purpose, because they are history. Where this box
> and the body still disagree, this box wins. Re-derive any number you rely on.
>
> **What changed in scope.** `FeeSink.sol` is deleted. New: `FeeConfig`, `FeeConfigView`,
> `FeeDefaults`, `FeeClaimLib` (a linked external library), `IntentTerms`, `ProveReader`,
> `TakePoints`. `contracts/src` is 13 files, 6,790 lines (`docs/AUDIT-READINESS.md` section 1).
> The settlement runtime is **23,427 B, 1,149 B under EIP-170**; `ProveReader` is 22,225 B.
>
> **What changed in the model** (`docs/FEE-MODEL.md` has all of it).
> - An intent signs `feeConfig`, a hash of a destination list and weights, and **three rates**
>   (P1 `feeRateIn` in tokenIn, P2 `feeRate` on top in tokenOut, P3 `feeRateProceeds` out of the
>   maker's proceeds). There are 19 signed fields. `feeTo`, the sink registry, `minRate` and
>   `defaultFeeSink` no longer exist. Sections 3, 4 (owner), 6.7 and 9.1 below say so.
> - **The settlement has no owner and no owner-gated function.** `setDefaultProceeds`,
>   `registerFeeSink`, `retireFeeSink`, `setDefaultFeeSink`, `transferOwnership` and
>   `acceptOwnership` are deleted. Unattributed tokens are booked to the immutable **stray
>   config** the constructor takes. The only owned contract is `FeeDefaults`, advisory, which the
>   settlement never reads.
> - `claim(cfg, token)` is permissionless, takes the preimage, and pays by weight. A failing share
>   is re-booked under the destination's own config (`ShareDeferred`); each transfer is capped at
>   200,000 gas. `claim` and `announceFeeConfig` run in `FeeClaimLib` by `DELEGATECALL`.
> - `available` moved to `ProveReader`; `ratesOf` is gone. `IntentTerms.ok` **copies** `_termsOk`
>   and a fuzz test pins the two: **review them together.**
>
> **New things to attack, in order.** (1) The delegatecall into `FeeClaimLib`: storage-layout
> agreement for the two mappings it is passed, and the library's address fixed at link time.
> (2) The reserved-fee ledger: P1/P2/P3 are reserved before the solver's single pull, and a
> shortfall must revert the whole call. (3) `claim` gas griefing and re-booking under
> `singleHash`. (4) The `_termsOk` / `IntentTerms.ok` duplicate. (5) The wire/typehash change:
> the old 943/369 deployments are ABI-incompatible and are not upgraded in place.
>
> **Re-measured 2026-10-05:** the test counts in sections 5 and 8 (forge, SDK and app), the
> invariant and fuzz tallies, and the invariant list; then, at the same `contracts/src` tree, the
> coverage gate (section 8, re-run 2026-10-06: 1,583 of 1,606 lines, 327 of 327 branches, 213 of
> 213 functions, 2,087 of 2,113 statements; the 23 uncovered lines are all forgiven Yul), the gas table
> (`app/src/landing/gas.ts`, unchanged: a warm allowance fill 124,975 gas, a twenty-leg batch
> 64,227 per intent) and the Slither run (`docs/slither-triage.md`: 125 findings, none confirmed).
> The tree pin and the line citations were re-anchored. On 2026-10-06 `prove-yul-runs.py` was
> re-run (351 / 5 / 13 / 25 / 24×4) and the blocks' safety margins were written up below.
> **Still not re-run:** the fork suites' chain figures.


Read this first. It tells you what the protocol does, which code is in scope,
what runs on which chain, who can hurt whom, what the test suite already proves,
and which limits we have accepted on purpose. The last section says where we are
least sure.

Every number here was checked against the code, not copied from another
document. Where a document and the code disagreed, the code won and the
disagreement is recorded.

**Scope.** The audited code is the `contracts/src` tree whose git object id is
`09c2233a7f1ab75ed02e6d37772559f7beaef050`. Check it from any commit, in one
command:

```
git rev-parse HEAD:contracts/src
```

**Re-pinned on 2026-10-01 for the fee fix (M-1 of the 2026-09-30 review).** `315f5b2`
makes a zero `feeTo` charge no fee: no fill reads `defaultFeeSink`, which is now only a
sign-time pointer. The pin before this one was `04469f62`. No line count in `contracts/src` moved.

**Re-pinned on 2026-09-28 for L-1** (section 7, the 2026-09-28 review). `_arm` caps the
arming frame at `ARM_GAS`, and `_grantAllowance` reads the allowance through `_probe`. The
pin before this one was `324fb057`, and the paragraph below describes how it came to be.

**Re-pinned on 2026-09-23 against `HEAD` of `feat/fee-sink-fixed`**, because the
fee-sink work moved the tree from `90331506`, the pin of 2026-09-16. Three
commits moved it. `ad661e0` built fee sinks with owner-set splits and a
revocable allowlist. The owner rejected that design, and `4d48379` replaced it
the same day: `FeeSink.sol` joins the scope as an immutable record, the
settlement gains an append-only registry, `_termsOk` checks it, and `claim` pays
the registered destination. `64224af` fixed B-2: an unreadable token B now
reverts `Underpaid` through the three arming doors, not `BadSignature`. All
three change behaviour. `master` still carries `90331506`, so this pack
describes the branch until it merges. The pin of 2026-09-16 was the fourth to go
stale; section 10 keeps the earlier history of the pin.

**One tree, and every number below was measured against it.** Every line-number
citation points into it too, and a gate checks each one:
`contracts/tools/check-citations.py` reads every citation, resolves the file, and
fails CI unless the cited line carries the term the sentence names. It reports
319 citations here and 0 stale, out of 510 across the four it checks (2026-10-05).

**That hash is the control, and it holds by construction.** It names content,
not a moment. Git derives it from the bytes under `contracts/src` and from
nothing else, so it moves when the audited code moves and at no other time. A
commit that edits this document leaves it alone. So does one that touches
`app/`, `sdk/`, `contracts/test` or `contracts/script`. That is the whole
difference. Three earlier editions each pinned a commit hash and each promised
that a diff against it printed nothing; all three were false within a day,
because a commit hash names a point in history and every later commit falsifies
it whatever it changed. A tree hash answers the question the reader is actually
asking — is the code in front of me the code this pack describes — and it keeps
answering it.

If the command prints anything else, this document is out of date. Read what
moved:

```
git diff --stat 09c2233a7f1ab75ed02e6d37772559f7beaef050 HEAD:contracts/src
```

Then re-derive the pack rather than trusting it.

**Two holes, stated plainly.** The command reads `HEAD`, not your working copy,
so run `git status --short -- contracts/src` beside it; anything that prints is
code the hash does not cover. And an editor can write a new hash next to old
numbers, which git cannot catch. The defence against the second one is the rest
of this document: every number in it comes from a command you can re-run against
the tree the hash names.

**The commands, so you can re-run any of them.**

```
wc -l contracts/src/*.sol                          # section 2, the line counts
ls contracts/test/*.t.sol | wc -l                  # section 2, the test-file count
git log --format='%h|%ad|%s' --date=short HEAD -- contracts/src   # section 3
cd contracts && forge test -vv                     # section 8, the summary line
cd contracts && python3 tools/coverage-gate.py     # section 8, the coverage counts
cd contracts && python3 tools/check-citations.py   # every line number in this file
grep -c 'function testFuzz_' contracts/test/*.t.sol   # section 5, the fuzz count
grep -c 'function invariant_' contracts/test/*Invariants*.t.sol
```

Read a test count off `forge test`'s own summary line. **Never off
`forge test --list`**, which declares 722 against a run of 679, and **never by
counting `[FAIL` lines**, which forge prints twice per failure. Both traps have
put a wrong number in this repository already; section 8 has the arithmetic.

**What this edition measured.** Commit `315f5b2`, the last commit that changes
`contracts/src` and the one whose tree the hash above names. Every test count
below was read from the `contracts/test` tree `3d64ab7f`, at `a0bb95e`. Test
line numbers that section 5 and section 7 cite hold at that tree, and
`check-citations.py` checks each one. One thing the tree hash cannot cover: the redeploy of 2026-09-09
rewrote `contracts/deployments/943.json`, `docs/ADDRESSES.md` and
`sdk/src/config.ts` in the working copy, and none of those is under either tree
hash. Run `git status --short` beside the two commands above. **Testnet 943 runs
the tree this pack pinned on 2026-09-09, not the tree it pins now** — section 3
says what that costs.

**Fee configs replaced fee sinks on 2026-10-03.** The sinks of 2026-09-23 (a registered
`FeeSink` per destination, an owner-gated `registerFeeSink`) are gone. An intent now signs
`feeConfig`, the EIP-712 hash of a destination list and weights, and three rates; the settlement
has no owner and reads no registry. Sections 1, 2, 4, 6.7, 6.9 and 9.1 describe it.

**Eleven days of work landed between 2026-08-29 and 2026-09-09.** If you were
sent an earlier copy of this document, throw it away. The old burner `FeeSink` is gone, the fee
is booked rather than sent, the fee now comes out of the maker's number instead
of the filler's, `MAX_WALLET_WINDOW` is gone, the call sink is one clone per
caller, the RFQ mirror gained three checks, every `tokenOut` read is bounded,
and the maker signs the shape of their own price decay in a new `curve` field.
Section 3 lists every commit.

---

## 1. What this protocol does

A maker signs an offer instead of sending a transaction. The offer says: take up
to `amountIn` of token A, and deliver at least a signed minimum of token B. A
solver fills it and keeps whatever the market pays above that minimum. This
deployment charges no protocol fee of its own.

`ProveSettlement` verifies the maker's EIP-712 signature and moves both sides in
one transaction. It holds no ERC-20 allowance. `ProveRelayer` holds every
allowance, and it can only pull. A maker picks one of five custody rungs, from a
plain allowance up to tokens escrowed against one intent hash.

Two periphery contracts let a solver fill with no inventory. `ProveExecutor`
sells one maker's token A at a venue the solver names. `ProveBatchExecutor`
settles a ring of legs that pay for each other. The settlement releases token A
before it pulls any payment, so neither contract needs capital.

**The minimum falls over the window, and the maker signs the shape of the fall.**
`minOutStart` is the ceiling, `minOutEnd` is the floor, and a signed `bytes32`
`curve` says where between them the price sits at each moment. Two bits of
`flags` — `FLAGS_CURVE_KIND` (`ProveSettlement.sol:448`) — say how to read the
word. Kind 0 reads none of it and walks the straight line every intent walked
before the field existed. `KIND_STRETCH` (`ProveSettlement.sol:466`) reads four
bytes and draws flat, then falling, then flat; `_stretchAt`
(`ProveSettlement.sol:974`) is the whole of that arithmetic. Kinds 2 and 3 are
reserved, read nothing, and price as the line. This landed on 2026-09-05 in
`78e0ef4`, and it made `curve` the seventeenth member of `INTENT_TYPEHASH`, so
every intent signed against an older settlement is unspendable here.

The fee is a term of the offer. The maker signs `feeConfig` — the hash of a canonical list of
up to eight destinations and their weights (`FeeConfig.sol`) — and three rates, one per take
point: `feeRateIn` (P1, in token A), `feeRate` (P2, in token B, on top) and `feeRateProceeds`
(P3, out of the maker's proceeds). `TakePoints.sol` prices all three. A zero `feeConfig` charges
nothing, and then `_termsOk` refuses any non-zero rate so a signed rate is never silently dropped
(`ProveSettlement.sol:2606`). Any other hash is accepted whatever it names: the contract cannot
know the preimage at fill time and does not need to, because the fee is booked under the hash
and only `claim`, handed a preimage that hashes to it, pays it out. So what the maker signs is
where the fee goes, and nobody — no owner, no solver — can register, rewrite or redirect a
destination. **The P3 fee comes out of the maker's number, not on top of it.** The filler owes
the signed gross whatever that rate is; the fee is floored out of the gross and the maker is
paid the rest, so that rate moves money from the maker to the destinations and changes nothing
about when a solver fills. The app is what turns a maker's desired net into the gross it signs.
The carve-out landed on 2026-09-05 in `d1dd385` and the three take points on 2026-10-03; see
`docs/FEE-MODEL.md`.

**`minOut` is no longer a net guarantee, and nothing on chain replaces it.** The
maker's guarantee is `gross - fee`. The app derives the gross from the net the
maker types, `G = ceil(N x WAD / (WAD - r))`, and shows both numbers beside the
fee. A reader who takes `minOutStart` for what the maker receives will be wrong
by the fee on every intent that names a destination.

**The fee is booked, not sent.** This changed on 2026-09-04 and it is the single
most important thing to hold while you read the rest. `_reserve`
(`ProveSettlement.sol:2929`) books the fee, and the solver's single strict pull at the end of the
call moves it to `address(this)`; it is credited to
`_pendingFees[feeConfig][token]`. The destination — or anybody willing to spend the
gas for them — takes it out later with `claim` (`:1106`). So the settlement now
holds fee balances continuously, belonging to no intent and to no reservation.
The contract's own header states it at `:72-90`: this is a place money rests as
well as a place it passes through. Section 4 says who can reach it, which is
nobody, and section 6.9 says what it costs.

**The rate has left the solver's fill condition.** A solver fills at the first
moment `proceeds - gross - gas > 0`, and the rate is not in that expression. So
a fee no longer pushes a decaying offer further down before somebody takes it,
and it no longer changes the solver's margin. It moves a fixed, visible share of
the maker's own delivery to the address the maker named. Under the old model the
condition was `delivered < (proceeds - gas) / (1 + rate)`, and the maker paid the
fee in time and in clearing price rather than in a number anybody could read.
`docs/FEE-MODEL.md` carries the derivation.

**A rate above 100% is refused, and arithmetic sets that ceiling.** `_termsOk`
rejects any of the three rates above `WAD` (`ProveSettlement.sol:2566`). Above `WAD` the fee exceeds the gross and
`gross - fee` underflows into a panic — and a panic is not a `Reason`, so
`skipInvalid` cannot step over it and one greedy signature takes a whole batch
down. `fillability` answers `BadTerms_` instead, before any money moves. This
rule is new in `d1dd385` and it is the only on-chain bound on a rate. A filler's
`maxFeeRate` bounds `feeRateIn + feeRate`, the two it bears.

This deployment charges no protocol fee. Commit `84e8895` deleted the storage
and every setter — `feeSink`, `feeFloorRate`, `protocolShare`, `feePolicy`,
`setFees` and `setFeePolicy` — so no owner can switch one on. The contract
cannot raise the maker's rate or take a share of it. A protocol fee would need a
different contract at a different address. A maker's signature binds to this
deployment's domain separator, so nothing decided later reaches an offer already
signed.

---

## 2. Scope

Thirteen files, 6,790 lines, all in `contracts/src`. All thirteen are in scope. Every
count below is `wc -l contracts/src/*.sol` at the tree hash above, re-measured on 2026-10-05
rather than adjusted. Runtime sizes are `forge build --sizes`.

| Contract | Lines | What it does | Scope |
|---|---|---|---|
| `ProveSettlement.sol` | 3,081 | Verifies signed intents and moves both sides. Five custody rungs, partial fills, a signed price curve, parked capital, a keyed nonce floor, direct / batch / callback fills, a simulate-only `dryRun`, and the fee book keyed by fee config hash. **No owner, no setter.** The custodian of every escrowed balance. Runtime 23,427 B, 1,149 B under EIP-170 | **IN** |
| `ProveBatchExecutor.sol` | 966 | Settles a ring of legs on credit, closing it through venue calls the caller writes. Drives one `ProveCallSink` clone per caller | **IN** |
| `ProveReader.sol` | 695 | The read views that left the settlement for size, including `available`. Holds nothing. Runtime 22,225 B | **IN** |
| `RfqVenue.sol` | 529 | Settles an exclusive two-leg quote. A maker reserves a price for one named counterparty, who accepts by signature | **IN** |
| `ProveExecutor.sol` | 348 | Fills one intent with no inventory. Sells the maker's token A at one venue, pays the maker, keeps the rest | **IN** |
| `TakePoints.sol` | 227 | Pure pricing of the three take points and the callback `Terms` | **IN** |
| `FeeDefaults.sol` | 195 | Advisory fee defaults and their append-only history. **The one owned contract**; reaches no funds, and the settlement never reads it | **IN** |
| `ProveCallSink.sol` | 166 | Makes the caller's arbitrary venue call, so an executor never does. A template, cloned once per caller | **IN** |
| `ProveRelayer.sol` | 163 | The one address makers and executors approve. Two functions, both callable only by the settlement | **IN** |
| `FeeConfig.sol` | 128 | The config struct, its validity rule and its EIP-712 hash | **IN** |
| `IntentTerms.sol` | 122 | A **copy** of the settlement's `_termsOk` for the reader, pinned to it by a fuzz test. Review the two together | **IN** |
| `FeeClaimLib.sol` | 116 | `claim` and `announceFeeConfig`, a linked external library reached by `DELEGATECALL` from the settlement. No storage of its own | **IN** |
| `FeeConfigView.sol` | 54 | Pure config math shared by the defaults and the reader | **IN** |

**The previous table listed seven contracts and 5,563 lines** (with `FeeSink.sol`, 44 lines, and
a settlement of 3,369). The fee config change deleted `FeeSink.sol`, moved `available` and
`claim` out of the settlement for EIP-170, and added the six fee config files.

### Out of scope, stated explicitly

| Path | Lines | Why it is out |
|---|---|---|
| `contracts/src/interfaces/` (10 files) | 462 | Type declarations only. No `contract`, `library` or `abstract` declaration exists in any of them, so nothing there is deployed or executable. Four of the nine — `IPulseXRouter`, `IPulseXFactory`, `IPulseXPair`, `IWrappedToken` — are no longer referenced by `src` at all and survive only for the fork tests. The count of nine and those four names are from before the fee config change; re-read them |
| `contracts/script/` (7 files) | 968 | Deploy scripts. They run from a developer machine, never on chain. The coverage gate does measure them, and they are fully covered — section 8 records the one commit that broke that and the two tests that repaired it. `1655e35` added `Guards.sol`, now 221 lines: every broadcasting script derives the signer from the key forge was handed and refuses a key the chain's `config/<chainid>.json` does not list. `4d48379` added `DeployFeeSink.s.sol`; the fee config change deleted it. `Deploy.s.sol` now deploys `FeeClaimLib`, links it, constructs the settlement with the stray config from `config/fee-configs.json`, and deploys `FeeDefaults` with the last history entry, handing it to the configured owner |
| `contracts/test/` — 47 `*.t.sol` files | 31,827 | Tests. Read them as evidence, not as code to review |
| `contracts/test/Mocks.sol`, `Fees.sol` | 1,057 and 111 | Shared mocks, and the fee config helpers |
| `contracts/test/handlers/` and `contracts/test/tokens/` (11 files) | 4,355 | Fuzz handlers and mock tokens. They exist to drive the invariant campaigns |
| `contracts/lib/` | — | Git submodules: OpenZeppelin contracts and forge-std. Not ours |
| Permit2 | — | `0x000000000022D473030F116dDEE9F6B43aC78BA3`, the canonical Uniswap deployment. We deploy nothing there. Verified byte-identical on both chains on 2026-08-27 |
| `sdk/`, `app/`, `app/scripts/` | — | TypeScript. The SDK builds intents and plans rings; the app signs them; the bots run solvers. None of it can move a token that a contract does not let it move |

---

## 3. What is deployed where, and what is not

**Two trees exist, and they are not the same.** Say which one you are auditing
before you start.

| Tree | Contents | Where |
|---|---|---|
| Mainnet 369 | The 2026-08-22 set, plus `RfqVenue` and `ProveBatchExecutor` from 2026-08-25 | Live on chain |
| `feat/fee-config-hash`, the audited tree | Object id `09c2233a`, the tree this document pins | NOT deployed. Testnet 943 and mainnet 369 still run the earlier set (tag `deploy/943-2026-10-01`), which is ABI-incompatible; a redeploy is required before this tree is live |

**The audited tree is not deployed yet: testnet 943 runs the earlier set (`deploy/943-2026-10-01`) until the redeploy.**
Measured that day with `cd contracts && node tools/verify-bytecode.mjs 943` from
the deploy checkout: 8 identical, 0 same program from a different build, 0
different code, 0 not verifiable, exit 0. From 2026-09-09 until then it ran older
trees, and the tool said so. The verdict per contract, and what explains each
one, is in `docs/ADDRESSES.md`.

**This row was false for four days and nothing noticed, which is why the check
now runs nightly.** Between 2026-09-05 and 2026-09-09 testnet 943 ran the tree at
`78e0ef4`, object id `b003eb80`, while this document and the roadmap both said it
ran `master`. `parked`, `totalParked` and `laneFloor` all reverted on that
settlement. `verify-bytecode.mjs` existed, worked and was wired into nothing;
`.github/workflows/soak.yml` runs it every night now.

**Audit this tree.** It is `master`, and it is the tree the next mainnet deploy will carry. Backlog
item #35 is that deploy. A finding against `master` no longer reproduces on 943
by construction: the two trees parted at `8efa7d2`, eight commits ago. It does
**not** reproduce on mainnet 369 — read the next section before you report one.

### Mainnet 369 is old, and the app cannot see it

Mainnet runs code from 2026-08-22, before the protocol went neutral. That
settlement still carries `feeSink`, `feeFloorRate`, `protocolShare`, `feePolicy`,
`setFees` and `setFeePolicy`, and three rate ceilings. **None of those exist in
`master`.** Do not report a finding against a fee dial that `master` deleted.

Mainnet also has no permit2 rung, no batch arming, no `dryRun`, no `minFill`, no
ERC-7598 signature width, no `Payment.leg`, no fee book, no bounded `tokenOut`
read, no `feeRate` ceiling and no `curve` field. Its fee is charged on top of the
maker's number, which is the model `d1dd385` inverted.

`sdk/src/config.ts` carried a zero settlement for chain 369 until 2026-10-10,
when the owner turned mainnet on (#52). It now names the 2026-10-06 settlement,
so order flow reaches mainnet from any client built from this tree.

### Twelve behavioural changes since the 2026-09-01 testnet set

Twenty commits touch `contracts/src` between the 2026-09-01 testnet deploy and
the 2026-09-09 redeploy, which carries all twenty. Twelve change behaviour. Seven
change only comments — every added and removed line sits inside a `//` or a
`/* */` — and an eighth, `335f9d9`, is `forge fmt`. Eight more have landed since
the redeploy. The pin note at the top names the last three, and section 10's pin row the five before them. Read the
list with `git log --format='%h|%ad|%s' --date=short HEAD -- contracts/src`.

**Mainnet 369 carries none of the twenty.** The "Behaviour?" column below says
what each one changed, and every row of it is absent from mainnet.

| Commit | Date | Change | Behaviour? |
|---|---|---|---|
| `f457494` | 09-02 | 28 comment lines in `ProveRelayer`, recording a Permit2 nonce pre-check that was measured and rejected | No |
| `9224318` | 09-02 | 19 comment lines in `ProveBatchExecutor` | No |
| `7d038a9` | 09-02 | `WHEN_ABSENT`, and the inverted branch in `_wanted` | **Yes** |
| `20e62e4` | 09-03 | Seven comments in three contracts that no longer described the code | No |
| `3432bfb` | 09-03 | One call sink per transaction, so a stranger cannot arm the next one | **Yes** |
| `21a4240` | 09-03 | One deterministic sink clone per caller, minted once and reused | **Yes** |
| `895fa7d` | 09-03 | Three comment lines in `ProveSettlement` | No |
| `a7c5d7f` | 09-03 | `MAX_WALLET_WINDOW` and both of `_termsOk`'s time bounds deleted | **Yes** |
| `55091bd` | 09-03 | Three mirror checks and three errors in `RfqVenue._checkBinding` | **Yes** |
| `cf61733` | 09-03 | `FeeSink` deleted from the repository | **Yes** |
| `36701c9` | 09-04 | The fee book; three `WHEN_ABSENT` and disposal defects; three undefended guards defended | **Yes** |
| `5d7f35f` | 09-04 | Two comment lines in `RfqVenue`, describing an hour-wide window `a7c5d7f` had deleted | No |
| `1655e35` | 09-05 | The return bomb's other half: six unbounded `balanceOf` reads go through `_probe`, `_evaluate` probes `tokenOut` on the deep path, and `Reason.TokenOutUnreadable` is appended at 14 | **Yes** |
| `d1dd385` | 09-05 | The fee comes out of the maker's number instead of the filler's, and `_termsOk` refuses a rate above `WAD` | **Yes** |
| `78e0ef4` | 09-05 | The `curve` field: a signed `bytes32`, two kind bits in `flags`, `_stretchAt`, and a seventeenth member of `INTENT_TYPEHASH` | **Yes** |
| `8b7d92a` | 09-08 | Parked capital: escrow that outlives the intent it was deposited for, `park`, `withdrawParked` and `ARM_FROM_PARKED` | **Yes** |
| `1844073` | 09-08 | The nonce floor gets lanes, and `park` reads it | **Yes** |
| `4ae8c69` | 09-09 | Six comment lines in `ProveSettlement`, on the lane-0 measurement | No |
| `335f9d9` | 09-09 | `forge fmt` across five contracts. No statement moves | No |
| `7f74fd4` | 09-09 | Two comment lines in `ProveSettlement`, replacing an archive count that decays with the measurement that re-asks it. **This is the tree testnet 943 still runs**, and the one this pack pinned until 2026-09-16 | No |

`20e62e4` matters to you even though it changes no behaviour: it fixed seven
comments that earlier editions of this document listed as wrong. Section 10 marks
each of them.

### Addresses

`contracts/deployments/369.json` and `contracts/deployments/943.json` are the
records. `docs/ADDRESSES.md` tabulates both. Every address changes at a redeploy
except Permit2, because `RfqVenue` and `ProveBatchExecutor` read `relayer()` from
the settlement in their constructors, and the settlement makes its own relayer.
The sink addresses change too: each executor deploys its own template, and a
clone's address derives from that template and its deployer.

**All seven testnet addresses moved on 2026-09-09, and every 943 address in an
older copy of this pack is dead.** The record's `_superseded` key names the set
they replace. Two consequences an auditor should hold: the relayer moved, so every
standing ERC-20 approval on the approval and permit rungs is orphaned, which is
the risk the approval rung's row in section 4 describes arriving in practice; and
the domain separator moved with the settlement, so every intent signed against
the previous settlement is unspendable. `INTENT_TYPEHASH` did not move.

### The stray config replaced `defaultProceeds`

There is no `defaultProceeds` address any more. The settlement's constructor takes an immutable
**stray config** (`STRAY_CONFIG`), and `sweepUnowned` books unattributed tokens under it for
`claim` to pay like any other book. `config/fee-configs.json` names it per chain, with the
initial `FeeDefaults` entry `Deploy.s.sol` publishes:

| Chain | Stray config | Initial defaults (`burn-0.5-v1`) |
|---|---|---|
| 369 | One destination, `0xd6cA7ee047a6F45d20d2962E4394E070cF27724F`, PulseX v2's own buy-and-burn (that factory's `feeTo()`) | Same destination; P2 0.5%, P1 and P3 zero; warn at 1% |
| 943 | One destination, `0x7cD43983A963c62Add34694E83E896c5AfC3333f`, the testnet factory's `feeTo()` | Same destination; P2 0.5%, P1 and P3 zero |

Neither chain runs this tree yet, so neither carries a stray config or a `FeeDefaults`. The
`defaultProceeds` addresses the deployed (older) sets were built with are in
`contracts/deployments/*.json`. The burner `FeeSink` of 2026-09-03 and the registry `FeeSink`
of 2026-09-23 are both gone from the source; the old testnet contracts still answer at their
recorded addresses and still hold what they held. Read section 6.4 for what the buy-and-burn
destination costs.

---

## 4. The trust model

Every claim below names a function. Read the function, not this paragraph.

### The owner

**`ProveSettlement` has no owner and no owner-gated function (since the fee config change, 2026-10-03).**
`setDefaultProceeds`, `transferOwnership`, `acceptOwnership`, `registerFeeSink`, `retireFeeSink` and
`setDefaultFeeSink` are gone. The constructor takes two inputs and nothing else is decided after
deployment: the **stray config** (a fee config, `STRAY_CONFIG`, immutable) and the Permit2 address.
`sweepUnowned` books unattributed tokens under the stray config and `claim` pays them out like any
other book, so there is no longer a `defaultProceeds` address anyone can repoint.

The only owned contract is `FeeDefaults`, and it is advisory: the settlement never reads it and does
not know its address. Its owner (two-step handover) has one power, `setDefaults`, which appends a
history entry. It reaches no funds, no book and no signed intent. See `docs/FEE-MODEL.md` Part 4.

There is no pause, no upgrade path, no proxy, no rescue function, and no fee
dial. `_reserved` and `_totalReserved` move together in the same statement at
every site, and so do `_pendingFees` and `_totalPendingFees` (`_book1`), and so do `_parked`
and `_totalParked`. That is what makes the sweep's subtraction exact, and it has
three terms rather than two.

**`ProveRelayer`, `ProveExecutor`, `ProveCallSink`, `ProveBatchExecutor`,
`RfqVenue`, `ProveReader`, `FeeConfigView` and `FeeClaimLib` have no owner at all.** No initializer, no pause. They hold three
kinds of mutable storage between them, and none of it is owner-settable:

| Storage | Where | Who writes it |
|---|---|---|
| `_entered` | `ProveExecutor.sol:145`, `ProveBatchExecutor.sol:358`, `RfqVenue.sol:184` | The reentrancy guard, 1 or 2 |
| `spent` | `RfqVenue.sol:176` | Write-once, keyed by a binding's own EIP-712 digest, so a caller can only set the key they hold a valid signature for |
| `_skipDisposal` | `ProveBatchExecutor.sol:374` | **New in `36701c9`.** A caller's own disposal-skip bitmap, written in `proveBatchCallback` (`:686`) and read and cleared by the `settleRing` that started it (`:553-558`), inside one transaction |

`_skipDisposal` is the one place a caller directs a storage word in a periphery
contract, and the previous edition's flat claim that these contracts hold "no
storage any caller can direct" is no longer true. See question 9.6.

`ProveCallSink`, `ProveRelayer`, `ProveReader` and `FeeClaimLib` hold no mutable storage of
their own — only immutables, or none. `FeeClaimLib` writes the settlement's two fee books,
because it runs by `DELEGATECALL` in the settlement's storage context, and it is handed both
mappings as storage pointers rather than reaching them by slot. `FeeDefaults` holds its history
and its owner; nothing that moves a token reads either.

### The five custody rungs, and what each one risks

`ProveSettlement` header, and `_release` / `_evaluate`.

**There is no longer any on-chain bound on how long an intent runs.** Commit
`a7c5d7f` deleted `MAX_WALLET_WINDOW` and both of `_termsOk`'s time bounds, so
`_termsOk` reads no clock at all. The reasoning is in the commit and at
`ProveSettlement.sol:2551-2581`: a stale wallet signature costs the maker who
signed it and nobody else, so the choice was never the contract's. The app
carries the advice instead — `SUGGESTED_WALLET_WINDOW_S`, one hour
(`sdk/src/settlement.ts:77`), and `adviceOf` returns `zombie` past it
(`app/src/lib/schedule.ts:151`; `app/src/components/Compose.tsx:881`). **Every "Time cap" the previous edition of
this document printed is gone, and so is every mitigation that rested on one.**

| Rung | Flag | Where token A rests | What it risks |
|---|---|---|---|
| `approval` | none | The maker's wallet, under an ERC-20 allowance to `ProveRelayer` | The allowance can vanish between simulation and inclusion. A solver pays gas for nothing. A settlement redeploy orphans the approval. And the signature is immortal: revoke the approval, restore it a year later, and every intent signed against it wakes up |
| `permit` | none | Same as `approval`. An EIP-2612 signature sets the allowance at fill time | Everything `approval` risks, plus a front-runner who spends the maker's permit nonce first. `_grantAllowance` only calls `permit` when the standing allowance falls short, so the front-runner's copy satisfies the fill |
| `escrow` | `FLAG_ESCROW` | The settlement, reserved against one intent hash | Nothing can move it but that intent or the maker's `withdraw`. This is the strong rung. It rests indefinitely because `withdraw` is a real off switch |
| `authorization` | `FLAG_ESCROW` | The maker's wallet until fill time, then escrow | `_redeem` pulls the whole `amountIn`, not the fill size. A one-wei take of a partial intent moves the maker's whole lot into escrow, where it stays until they withdraw. `minFill` prices that; it does not stop it, because an EIP-3009 authorization is one fixed value |
| `permit2` | `FLAG_PERMIT2` | The maker's wallet until fill time, then escrow | The only rung a settlement redeploy cannot orphan, because the maker approves Permit2 and not the relayer. Permit2 spends the nonce on the first transfer, so `_pullPermit2` draws `min(p.amount, i.amountIn)` and promotes the signature into a reservation |

`FLAGS_CUSTODIED = FLAG_ESCROW | FLAG_PERMIT2` (`:412`) is the set whose token A
is in the contract's hands. **Three sites read it, and they are not the three the
previous edition named.** They are:

| Line | Function | What it does with the flag |
|---|---|---|
| `:1838` | `fillWithPermit` | Refuses an intent wearing either flag |
| `:2648` | `_evaluate` | Asks the reservation, not an allowance |
| `:3034` | `_release` | Pays out of the reservation rather than pulling |

`_termsOk` no longer reads the composite constant. It read it exactly once, to
gate the two window bounds, and `a7c5d7f` deleted that block. It still reads the
two flags **separately**, at `:2568`, to refuse an intent wearing both.

`_termsOk` now checks eight things, and every one reads only the intent: `minOutEnd >
minOutStart` or `tokenIn == tokenOut` (`ProveSettlement.sol:2564`), the `uint128` caps on
`minOutStart` and `amountIn` (`:2565`), any of the three rates above `WAD` (`:2566`), both
custody flags at once (`:2574`), a zero `recipient` or the settlement or the relayer as
`recipient` (`:2599`), and a non-zero rate under a zero `feeConfig` (`:2606`). **It reads no
storage and calls nothing**, so a fee destination cannot revert, grief or re-enter a fill. The
sink registry `4d48379` added, and the two storage reads it made here, went with the fee config
change. A fee destination is never checked at fill time at all; `claim` refuses a preimage that
names the settlement or the relayer (`FeeClaimLib.pay`), and the app refuses to sign one.

### Three sites add `amount + fee`, and all three are right

The sum is the executor's whole outlay. That was true when the fee rode on top
of the maker's delivery and it is still true now the fee is carved out of it,
because the split moved the fee inside the gross rather than beside it. **Do not
report any of these as a double charge, and do not reduce one to `amount`.**

| Site | Line | What the sum is |
|---|---|---|
| `ProveSettlement._settleViaCallback` | `:1801` | The debt handed to `proveCallback`, which is the gross the curve asked for |
| `ProveBatchExecutor._oweEveryLine` | `:917` | The per-token total the executor approves to the relayer, summed over every line naming that token |
| `RfqVenue.proveBatchCallback` | `RfqVenue.sol:483-484` | The same allowance, one line per leg, because the venue carries exactly two |

Each site carries a comment saying so, added in `d1dd385` after the split made
the reading ambiguous. `IProveBatchCallback.Payment`'s own NatSpec says it too:
`amount` is the maker's delivery after the carve-out, `fee` is what the
destination is charged, and an implementation that needs an allowance needs
their sum.

### Why the relayer holds the allowances

`ProveSettlement` calls addresses it did not choose — the executor's callback and
a contract maker's `isValidSignature`. Any contract that both accepts arbitrary
calldata and holds allowances is Transit Swap, which lost $23M in 2022. CoW
Protocol lost $166k to the same shape in 2023.

Three rules keep the roles apart, and the header states all three:

1. The settlement may call an address it did not choose only through a selector
   it chose. No call site takes a selector or a calldata blob from a caller. The
   executor's `data` rides inside the `proveCallback` / `proveBatchCallback`
   frame as an argument.
2. No call site may target the relayer or the settlement. The `callableTarget`
   modifier (`ProveSettlement.sol:2901`), on `fillWithCallback` and `fillBatchWithCallback`.
3. No allowance lives on the settlement. Every `transferFrom` goes through
   `ProveRelayer.pull` or `ProveRelayer.pullWithPermit2`.

`ProveRelayer` has no owner, no writable storage, and two functions. `pull` takes
a destination. `pullWithPermit2` does not — every transfer ends at the
settlement, because that is the only place a reservation can be credited.

`ProveCallSink` is the same split one level down. It makes the venue call, so the
executor does not, and nothing advertises it as an approval target.

**The sink is now one deterministic clone per caller, and that — not obscurity —
is the argument.** Each executor deploys a template in its constructor and clones
it (EIP-1167) at an address derived from `msg.sender`
(`ProveBatchExecutor._sinkFor`, `ProveBatchExecutor.sol:581`; `ProveExecutor._sinkFor`, `ProveExecutor.sol:334`). The
caller's first entry mints it and every entry after reuses it. The address is
trivially predictable, and that buys nothing: only its own caller's entry makes a
clone run, so an `approve` a caller's own venue calldata writes is a claim on
their own money and nobody else's. `ProveExecutor.sol:79-83` and
`ProveCallSink.sol:28-58` carry the argument in full. **The previous edition of
this document said the sink was "protected by obscurity, and the header says so".
Neither half is true any more** — `21a4240` replaced the argument, and the header
now says the opposite.

Two consequences worth carrying:

- **A strand on the sink is recoverable.** A token the sink is not told to sweep
  rests on the caller's own clone, and their next entry sweeps it home. It is
  even spendable inside the recovering transaction, because the executor sweeps
  the sink before the settlement pulls —
  `test_ARecoveredStrandPaysTheCallersOwnRing` pins both halves.
- **A caller that is itself a public contract shares one `sink` across its own
  users**, so one of its users can arm a claim on what another strands there.
  That is the caveat the header keeps (`ProveCallSink.sol:55-58`), and it is a
  choice that contract's author makes rather than one this contract can make for
  them.

### What a malicious solver can do

| Can | Where |
|---|---|
| Choose the timing of any fill, and race any other solver | Every fill path is permissionless unless `Intent.executor` is set |
| Choose which legs of a batch to arm, and which to skip | `FillRequest.arming`, `skipInvalid` |
| Write arbitrary venue calldata and pick the target | `ProveExecutor.Swap`, `ProveBatchExecutor.Swap` |
| Overwrite one word of their own venue calldata on the disposal path | `sellSurplus`, bounded by `_write` against `data.length` |
| Burn a maker's EIP-3009 or Permit2 nonce on a leg that then fails to fill | `_redeem`, `_pullPermit2`. The nonce is spent for good; the maker takes the money back with `withdraw` and signs again |
| Move a partial gasless maker's whole `amountIn` into escrow with a one-wei take | `_redeem` redeems `amountIn`, not `take` |
| Call `sweepUnowned` | Permissionless by design. It moves no token: it books the unowned balance under the immutable stray config, which only `claim` pays |
| Call `park` on any dead intent | Permissionless by design, and it can only move a maker's reservation into that maker's own parked row. It pays nobody and transfers nothing. It also ends the offer, exactly as `withdraw` does |
| Fund a maker's escrow leg out of capital another of their offers left behind | `FillRequest.arming` carrying the one word `ARM_FROM_PARKED`. **The maker need not act, and an escrow signature they never funded is no longer inert** — see 6.11 |
| Call `claim` on somebody else's behalf | `claim` (`ProveSettlement.sol:1405`) is permissionless and always pays the destinations of the config preimage it is handed, by the weights in it; the preimage must hash to the book's key (`FeeClaimLib.pay`). It refuses a non-contract token with `BadParameter` and a malformed config with `InvalidConfig`. The worst a stranger can do is force a destination to receive its own money at a moment it did not choose. That is deliberate: the destinations are burners and frontend wallets that never send a transaction, so a `msg.sender`-only claim would strand the book. A destination that reverts or burns gas cannot block the others: its share is re-booked under its own one-destination config (`ShareDeferred`) |

| Cannot | Where |
|---|---|
| Pay a maker less than their share of the signed curve | `_quote` rounds the gross up and floors the fee, so the dust of the split stays with the maker; `_deliverTo` (`:3006`) brackets the transfer with a balance read and reverts `Underpaid`. **The maker's guarantee is `gross - fee`, not `minOut`** — see 6.10 |
| Pay a maker with the maker's own token | `_termsOk` refuses `tokenIn == tokenOut` (`:2564`) |
| Aim a venue call at the relayer or the settlement | `ProveCallSink.run` refuses the executor, itself and the template (`ProveCallSink.sol:117-129`); `_sell` refuses the relayer and the settlement on both `target` and `spender` |
| Redirect a fee | The book's key is the hash of the signed config, `claim` pays the preimage that hashes to it, and no function rewrites a preimage. `msg.sender` decides nothing |
| Reach a fee that has been booked and not claimed | `sweepUnowned` subtracts `_totalPendingFees` (`ProveSettlement.sol:1360-1360`). No other path reads the book |
| Reach a maker's parked capital | `sweepUnowned` subtracts `_totalParked` in the same statement. `_drawFromParked` reads `_parked[i.maker][i.tokenIn]` off the signed preimage, so a solver cannot name the row; `withdrawParked` reads `msg.sender`, so it cannot name the payee |
| Draw more parked capital than the leg spends | `_drawFromParked` moves `take - reserved[h]` and refuses anything it cannot cover in full. A one-wei fill takes one wei |
| Fund two offers welded to one `authNonce` from parked capital | `_drawFromParked` refuses an intent whose `authNonce` is set. That field's only purpose is to make siblings mutually exclusive through the token's single-use nonce, and this source spends no nonce |
| Spend a balance that was donated to an executor rather than earned | Every executor marks each named token before the ring and refuses to end below the mark — `_sweepAbove` reverts `BalanceWentDown`. `ProveBatchExecutor._tokensNamedBy` collects the sweep list, every swap's two tokens and every `extra` |
| Discharge a maker's payment out of a donation | The settlement pulls with a directed `transferFrom` after the callback returns; it never measures a delta. `_requireSwept` also refuses an `owed` token the sweep list does not name |
| Oversize a disposal so it eats into the mark | `sellSurplus` reverts `OversizedDisposal` (`ProveBatchExecutor.sol:802`) **before** the venue is called. New in `36701c9`; see 6.8 |
| Name a leg the batch never carried | `_wanted` reverts `LegOutOfRange` (`:780`), and `settleRing` reverts `LegsExceedBatch` when `route.legs > reqs.length` (`:437`). Both new in `36701c9` |
| Arm another caller's sink | Only that caller's own executor entry drives their clone |
| Reach an allowance granted to the settlement | There is none |
| Pay a fee to an address the maker did not sign | `_reserve` (`ProveSettlement.sol:2934`) books under `i.feeConfig`, which the maker signed as the hash of the whole destination list |
| Engage a caller with a fee destination the caller refused | `maxFeeRate` is an argument on `fill`, `fillBatch`, `fillWithCallback`, `fillWithAuthorization`, `fillWithPermit`, `fillWithPermit2` and `dryRun`, checked in `_evaluate` before `skipInvalid` decides. **It bounds no outlay of the caller's since `d1dd385`** — the fee comes out of the maker's number — it bounds what a fill touches |
| Re-enter a fill | `nonReentrant` on every settlement entry point (`ProveSettlement.sol:896`); a separate guard on each executor, read directly out of slot 0 by an invariant |

### What a malicious maker can do

| Can | Where |
|---|---|
| Sign a window of any width, opening at any time | `_termsOk` reads no clock. Nothing on chain bounds either end |
| Revoke an allowance, or spend the balance, after a solver has priced the fill | The approval and permit rungs are permissions, not commitments. **This risk now has no on-chain mitigation.** The previous edition named `MAX_WALLET_WINDOW` here, and the constant is gone. A solver's defence is `dryRun` and its own inclusion risk |
| Withdraw an escrow in front of a pending fill, and keep the option either way | `withdraw` is immediate and ends the offer. This is finding F-5, accepted — see 6.5 |
| Sign two offers that share one `authNonce`, so only one can ever arm | `_redeemInto`, `_pullPermit2In`. Mutual exclusion is the point |
| Charge any rate from zero up to 100% at each of the three take points | `_termsOk` refuses a rate above `WAD` (`ProveSettlement.sol:2566`), so the field's own 1,844% reach is unusable. There is no floor: nobody rules on the number below that. A filler bounds what it bears with `maxFeeRate` (P1 + P2); P3 costs only the maker who signed it |
| Name a fee config whose destinations cannot receive the token, or that nobody can reproduce | The fill still settles and the maker is still paid; the fee books under the hash. A destination that reverts strands only its own share, which `claim` re-books under that destination's one-destination config (`ShareDeferred`). A hash with no known preimage is a book nobody can claim, and only the signer's money is in it. See 6.9 |
| Sign an offer whose EIP-3009 window and whose `startTime`/`endTime` disagree | Two windows, and nothing reconciles them. The token enforces one, `_evaluate` the other |
| Answer `isValidSignature` with anything, from a contract wallet | Capped at 60,000 gas (`ProveSettlement.sol:3072`). A dirty word reads as "did not sign" rather than reverting the batch |
| Name a hostile `tokenIn` and force every batch that includes the leg to probe it | `_probe` (`:2799`) caps each read at `PROBE_GAS` 30,000 and copies exactly one word |

| Cannot | Where |
|---|---|
| Spend the same escrow twice | `_reserved` is keyed by intent hash, not pooled per maker. This was finding H-1 |
| Withdraw another maker's escrow | `withdraw` refuses anybody but `i.maker` |
| Have a reservation credited by a stranger's front-run | `deposit` takes the whole `Intent` preimage, so `maker` and `tokenIn` come from the signed struct. This was finding F-1 |
| Sign a floor above their own ceiling, an unbounded price, or a rate that underflows the split, and panic a batch | `_termsOk` refuses `minOutEnd > minOutStart` (`:2564`), caps `minOutStart` and `amountIn` at `uint128` (`:2564`), and refuses `feeRate > WAD` (`:2565`). **`curve` changed what the first one means**: a price may rise *inside* the window and this does not stop it — see `:359-2802` |
| Name the settlement, the relayer or the zero address as `recipient` | `_termsOk` refuses all three (`ProveSettlement.sol:2599`) |
| Have a fill pay, call or read a fee destination | The fill books under the hash and calls nothing; only `claim` transfers. A preimage naming the settlement or the relayer is refused there (`FeeClaimLib.pay`, `ReservedDestination`) |
| Sign a rate with no config to pay it to | `_termsOk` refuses a non-zero rate under a zero `feeConfig` (`:2606`) |
| Wear two custody flags | `_termsOk` refuses an intent carrying both `FLAG_ESCROW` and `FLAG_PERMIT2` (`:2568`) |
| Point one EIP-3009 authorization at a different intent | `_redeemInto` requires `auth.nonce == (authNonce ? authNonce : h)`. This was finding M-4 |
| Point one Permit2 signature at a different token or intent | `_pullPermit2In` checks `p.token == i.tokenIn` and the same nonce rule |
| Take a payment the offer promised in a token the offer did not name | `hashIntent` commits to `tokenIn` and `tokenOut` |

### The RFQ venue

`RfqVenue` has no owner. Exclusivity rides on `Intent.executor`: name the venue
there and only the venue can fill the intent. The maker signs a second EIP-712
message, `Exclusive`, under the venue's own domain — `intentHash`,
`counterparty`, `take`, `expiry`, `nonce`. `LEGS` is 2 and nothing else.

`intentHash` commits to every term of the quote, including its rate, so a
counterparty who read the terms cannot be surprised. `INTENT_TYPEHASH` has
**seventeen** fields since the curve landed, and the venue's header (`RfqVenue.sol:105`) says
seventeen. This count has now been stale twice — `20e62e4` moved it from fourteen
to sixteen — so a test states the typehash string a second time by hand and fails
when the two disagree.

**`55091bd` bound the acceptance to the deal it answered.** `Exclusive` names the
quote by hash and names nothing about the mirror, because the maker signs first
and cannot know a hash the counterparty has not produced yet. Without the three
checks below, a counterparty's acceptance survived the binding it answered: any
rogue could mint their own quote for the same pair, sign their own `Exclusive`
naming that counterparty, and settle the acceptance against it. The counterparty
would never see them, and the maker whose binding it was might be long expired.

| Check | Line | Error | What it stops | Test |
|---|---|---|---|---|
| `mirror.endTime > ex.expiry` | `RfqVenue.sol:423` | `MirrorOutlivesTheBinding` | An acceptance that outlives its binding | `test_AnAcceptanceCannotBeCarriedToARogueQuote` (`RfqVenue.t.sol:620`) |
| `mirror.minOutStart != mirror.minOutEnd` | `RfqVenue.sol:424` | `MirrorIsNotFlat` | An acceptance repriced by settling late | `test_AnAcceptanceThatDecaysIsRefused` (`RfqVenue.t.sol:680`) |
| `mirrorTake != mirror.amountIn` | `RfqVenue.sol:425` | `MirrorNotTakenWhole` | An acceptance sliced by the submitter | `test_TheSubmitterCannotSliceTheAcceptance` (`RfqVenue.t.sol:699`) |

**A zero-spread quote is now fillable, and that is a change to the venue's own
economics.** The exclusivity fee comes out of the quoting maker's own delivery,
so a mirror that leaves exactly the quote's gross and not a wei more is enough to
close the ring. It used to revert, because the counterparty had to bring a spread
big enough to carry the fee. `test_AQuoteWithNoSpreadPaysForItsOwnExclusivity`
(`RfqVenue.t.sol:999`) records the change and its acceptance: every number in the
ring is one of the two makers' own signatures, and a submitter who runs it takes
zero. The test used to be
`test_AQuoteWithNoSpreadCannotPayForItsExclusivity` and it asserted the revert.

`_checkBinding` gained a `mirrorTake` parameter (`RfqVenue.sol:350`), passed as
`reqs[1].take` (`:304`). Three other checks in the same function do related work:
`quote.executor != address(this)` (`:367`), `mirror.executor != address(this)`
(`:378`) and `mirror.maker != ex.counterparty` (`:388`).

---

## 5. Invariants — what is already machine-checked

Four invariant suites, holding **42 properties plus 4 call-summary receipts** —
46 `invariant_` functions in total (re-counted 2026-10-05). Forge gives each function its own
budget, so the default run is 46 campaigns of 128 runs by 256 depth.

Every suite calls `targetContract(address(handler))` in `setUp`. There is no
`targetSelector`, `excludeContract`, `targetSender` or `excludeSender` anywhere
in `contracts/test`. Foundry therefore fuzzes each handler's whole
state-mutating ABI in any order. **`fail_on_revert = false` in both invariant
profiles**, so a handler call that reverts is discarded rather than failing the
campaign — read each handler's call-summary counters to see what a run actually
exercised.

Every expected value is a ghost recomputed from the signed terms. No invariant
reads a number back off the contract and compares it with itself.

**The fee book moved six of these properties, and the fee split moved four
more.** A fee no longer transfers during a fill, so a property that watched a
destination's balance would witness nothing; six were rewritten in `36701c9` to
read `pendingFees` / `totalPendingFees` as well. Then `d1dd385` carved the fee
out of the maker's number, so four properties that asserted the maker received
the whole curve now assert the maker received the curve less their own fee, with
the gross checked beside it. Three were renamed. All of them are marked below.

### `InvariantsTest` — `test/Invariants.t.sol:36`

Drives one `ProveSettlement` through `SettlementHandler`: 14 actions (`fillSome`,
`fillDust`, `fillBatchSome`, `depositEscrow`, `withdrawEscrow`, `claimFees`,
`cancelOne`, `signNewIntent`, `fillViaCallback`, `skipTime`, `armAndFill`,
`fillArmedAgain`, `armTwins`, `dryRunArmed`), 3 makers, 4 signature-only makers,
2 executors, 2 fee destinations each signed as its own single-destination fee config, a paying callback bot, and 7 tokens covering
EIP-2612, legacy EIP-3009, ERC-7598, a taxing EIP-3009 token and a Permit2 token.
Every intent it signs carries `curve: bytes32(0)`, so the campaigns price the
straight line and never the stretch.

| Property | Line | What it asserts |
|---|---|---|
| `NoAllowanceEverAccumulatesOnTheSettlement` | `:90` | No actor ever holds an allowance naming the settlement, and the Permit2 maker names no relayer allowance either |
| `TheRelayerNeverHoldsABalance` | `:138` | All seven tokens read zero at the relayer |
| `FilledNeverExceedsTheSignedAmount` | `Invariants.t.sol:146` | `filled(h) <= amountIn` for every intent |
| `ContractHoldsExactlyTheEscrow` | `Invariants.t.sol:156` | The settlement's token A balance equals the sum of `reserved()` over every intent |
| `ContractNeverHoldsTokenOutBeyondTheFeesItOwes` | `Invariants.t.sol:179` | **Renamed for the fee book.** Token B at the settlement equals `totalPendingFees(tokenB)` exactly. It used to read `== 0`. Equality rather than `assertLe` is what keeps it a statement: a wei of token B here that no destination is owed is a maker's delivery that got stuck |
| `TokensAreConserved` | `Invariants.t.sol:185` | Both tokens sum to `totalSupply()` across all fourteen known holders |
| `MakersReceivedWhatTheyWereOwed` | `:230` | The makers hold at least the ghost owing |
| `EscrowIsNeverNegative` | `:239` | No single reservation exceeds the settlement's balance |
| `TheFeeReachesTheDestinationTheIntentNamed` | `:269` | **Rewritten for the fee book.** Balance *plus book* at each named destination equals the ghost charged, and the stray config's destination both holds zero and is booked zero by fills (the test still names it `SINK`) |
| `AFeeNeverReachesCommittedMoney` | `:299` | **Rewritten for the fee split.** The makers received the curve less the fee their own intents carve out of it, `owed + charged` equals the gross exactly — so no rate moved what the executors parted with — and escrowed token A equals the net escrow ghost. Its first half asserted the opposite claim until `d1dd385`: that a rate could not move what a fill delivered |
| ~~`ASinkNeverHoldsATokenAndItsTermsNeverMove`~~ | retired | **Removed with `FeeSink` (fee config change, 2026-10-03).** There is no sink and no registry; the fee book invariants above cover where fees rest |
| `AnAuthorizationNonceIsSpentOnlyByALegThatFilled` | `:353` | Every filled EIP-3009 leg redeemed its authorization, and no nonce was burned by a leg that never filled |
| `APermit2NonceIsSpentOnlyByALegThatFilled` | `:383` | No Permit2 bitmap bit was consumed by a leg that never filled |
| `ADryRunLeavesTheStateExactlyWhereItFoundIt` | `Invariants.t.sol:408` | No dry run moved a reservation, `filled`, `totalReserved`, a balance or a 3009 nonce, and no dry run returned instead of reverting |
| `NoFillLandsBelowTheFloorUnlessItClosedTheIntent` | `Invariants.t.sol:430` | No fill landed under `minFill` while the intent stayed open — checked by ghost and by reading `filled` |
| `TheReservationsStillAddUpToTheBookTheSweepReads` | `Invariants.t.sol:476` | For all 7 tokens, `totalReserved` equals the summed reservations, and equals the balance |
| `TwoOffersSharingAnAuthorizationNeverBothFill` | `Invariants.t.sol:539` | For each twin pair sharing one `authNonce`, at most one has `filled > 0` |
| `AnArmedMakerIsPaidTheCurve` | `:552` | The four signature-only makers hold exactly what the curve owed them |

### `AwkwardTokenInvariantsTest` — `test/Invariants.t.sol:851`

A `WeirdToken` input that taxes its own transfers and can answer with no data, a
six-decimal output token, and an ERC-1271 contract maker. Nine actions.

| Property | Line | What it asserts |
|---|---|---|
| `TheTaxIsPaidByTheExecutor` | `:896` | The transfer tax comes out of the executor, not the maker. Stated as a finding, not a defect |
| `TheMakersPartWithExactlyWhatTheySigned` | `:906` | Supply less maker holdings equals the maker-debit ghost |
| `TheTaxedTokenIsAccountedFor` | `Invariants.t.sol:918` | Every holder sums to `totalSupply()`, and supply shrank by exactly the tax burned |
| `TheContractHoldsExactlyTheEscrow` | `:932` | Balance equals summed reservations equals the net escrow ghost |
| `TheContractNeverHoldsTheOutputBeyondTheFeesItOwes` | `Invariants.t.sol:945` | **Renamed for the fee book.** Six-decimal output at the settlement equals `totalPendingFees` for that token |
| `TheSixDecimalMakersArePaidTheCurve` | `:960` | **Rewritten for the fee split.** Received equals owed at six decimals, and `owed + charged` equals the gross beside it |
| `TheDestinationEarnsExactlyTheRateOnTheGross` | `:979` | **Rewritten and renamed twice** — for the fee book, then for the split. Balance plus book equals the ghost charged, the per-destination book agrees, and one destination's book is the whole total. `defaultProceeds` holds zero. It was `TheDestinationEarnsOnEveryFill` and it no longer earns on every fill: the floor-rounded fee on a hundred-wei gross at ten basis points is nothing, and the claim is now that the two books agree about that wei for wei |

### `ExecutorInvariantsTest` — `test/ExecutorInvariants.t.sol:36`

Drives `ProveBatchExecutor` + `ProveCallSink` + `ProveSettlement` through
`RingHandler`: 11 actions including four forbidden-target attempts, a reentrant
venue, an unnamed payout token and an attempt to sell a donation.

| Property | Line | What it asserts |
|---|---|---|
| `ADonationIsNeverSpent` | `:97` | For each of 4 tokens the executor's balance equals the donated ghost exactly — a donation survives every later ring, and nothing a ring owed was left unswept |
| `NothingRestsInTheSinkOrTheSettlement` | `:119` | All four tokens read zero at the sink **template**, at the last clone a venue saw, and at the settlement |
| `NoAllowanceOutlivesARing` | `:137` | Executor-to-relayer and sink-to-venue allowances are zero, and an armed leg leaves the permit maker no standing claim |
| `ARingCarryingBytesThatCannotArmNeverSettles` | `:176` | A ring never settles around a leg it could not arm |
| `ARingTheContractMustRefuseNeverSettles` | `:199` | Four forbidden shapes never settled, none was refused for the wrong reason, and the venue's last caller is always a sink |
| `TheGuardIsOpenBetweenRings` | `:239` | Slot 0 of `ProveBatchExecutor` reads 1 between calls, read with `vm.load` because the variable is private |
| `MakersHoldExactlyWhatTheRingsMoved` | `:254` | For 4 makers by 4 tokens plus the permit maker, `balance == start + got - sent`, both ghosts from signed terms |
| `TokensAreConserved` | `ExecutorInvariants.t.sol:280` | Each token sums to `totalSupply()` across fifteen holders |

### `RfqVenueInvariantsTest` — `test/RfqVenueInvariants.t.sol:36`

Eight actions, five of which are refusal shapes: a stranger's mirror, a spent
binding, an expired binding, an open quote, and a take the maker did not sign.

| Property | Line | What it asserts |
|---|---|---|
| `ADonationIsNeverSpentAndNothingElseRests` | `:65` | The venue's balances equal the donated ghosts exactly |
| `EveryBindingItSettledIsStillSpent` | `:79` | Every tracked binding hash still reads `spent() == true` |
| `NoBindingSettlesTwice` | `:92` | No double settlement, and tracked bindings never exceed total settlements |
| `NoPairingItMustRefuseEverSettles` | `:100` | Zero bad pairings accepted across all five refusal shapes |
| `ARingIsExactlyTwoLegs` | `:112` | `LEGS() == 2` and legs equal twice the settlements |
| `NoAllowanceRestsOnEitherSideOfTheVenue` | `:124` | The venue holds no allowance to the relayer or settlement, and nobody has approved the venue |
| `BothSidesGotExactlyTheSignedRate` | `:146` | Maker and counterparty balances equal their ghosts |
| `TheSubmittersKeptExactlyTheSpread` | `:164` | The submitters hold exactly what was swept |
| `TheFeeDestinationsTookExactlyTheSignedFee` | `:181` | **Rewritten for the fee book.** The destination's *book* carries the whole signed fee in both tokens, and its balance is zero because nothing in the run claims |
| `TokensAreConserved` | `RfqVenueInvariants.t.sol:204` | **Rewritten for the fee book.** The relayer holds nothing, the settlement holds exactly its booked fees, and nine holders sum to `totalSupply()` |

**All five refusal shapes predate `55091bd`.** No invariant drives the three new
mirror checks — see question 9.5. `RfqVenueInvariants.t.sol` is unchanged since
`36701c9`; its two fee properties read the book and were not touched by the
split, because the venue's ghosts already priced the fee out of the gross.

### Fuzz properties — 44: 42 at 512 runs, and 2 at 20,000

All 44 are named `testFuzz_*`, and all 44 take parameters. No test with arguments
hides under a plain `test_` name — `grep -E 'function test_[A-Za-z0-9_]*\([^)]+\)'`
over `contracts/test` matches nothing. Two of the 44 override the profile with
`/// forge-config: default.fuzz.runs = 20000` — `testFuzz_TheEnvelopeHolds`
(`Curve.t.sol:241`) and `testFuzz_NoWordPanicsThroughQuote` (`Curve.t.sol:275`) —
because they stand in for a `_termsOk` rule on `curve` that does not exist.

| File | Count | What they cover |
|---|---|---|
| `Fuzz.t.sol` | 13 | Dutch decay monotonic and bounded; `_quote` never short-changes the maker; **the split totals to the gross at every rate**; **the fee floors at both extremes**; splitting a fill never pays less; garbage never passes as a signature; tampering with any signed field always reverts; `BelowMinFill` fires exactly when it should; a floor never strands dust; escrow round-trips exactly; escrow returns to the maker and to nobody else; fillable only inside the window; `invalidateBefore` is exact |
| `Curve.t.sol` | 6 | A zero `curve` word prices the straight line exactly; the stretch's rounding still favours the maker; the price never leaves the `minOutStart`/`minOutEnd` envelope; no word of the 2^256 panics through `quote`; a byte the kind does not read changes no price; the stretch never rises |
| `Adversarial.t.sol` | 4 | **The gross** never shorts the curve; a whole take is exactly the curve; splitting never pays less; the curve decays no faster than it says |
| `FeeConfig.t.sol` | 3 | **New with the fee config change.** A config's shares add up and never exceed the amount; `feeOf` floors and never exceeds its base; `grossForNet` always leaves at least the net |
| `ProveReader.t.sol` | 2 | **New with the fee config change.** `takeForOut` is the smallest take that covers; `ProveReader.available` uses the settlement's own terms rule (`testFuzz_AvailabilityUsesTheSettlementsTermsRule`, the pin on the `IntentTerms.ok` copy) |
| `Relayer.t.sol` | 4 | `pull` refuses every caller but the settlement; `callableTarget` refuses exactly the relayer and the settlement; the relayer keeps nothing; the settlement is never a spender |
| `Custody.t.sol` | 4 | `maxFeeRate` is exactly the bound (`:831-853`); **the fee rate never reaches the executor's outlay** (`testFuzz_TheFeeRateNeverReachesTheExecutorsOutlay`, `:937`); **every rate above `WAD` is refused on `available`, `fillability`, `fill` and `fillBatch`** (`:868-903`); nothing fills an intent the expired exit would empty (`:1009-1031`) |
| `Arming.t.sol` | 2 | Many Permit2 partials draw the wallet once; the signature width decides which EIP-3009 overload the token is asked |
| `Executor.t.sol` | 2 | The maker never gets less than they signed whatever the venue pays; no spender keeps an allowance after the fill |
| `ProveSettlement.t.sol` | 2 | Fills never exceed the signed amount; **the gross** never falls below the signed rate. The second was `testFuzz_MakerNeverReceivesLessThanTheSignedRate` and it is a different claim now: the maker receives the gross less their own fee |
| `CurveCost.t.sol` | 1 | A clamped external curve can never pay the maker below the signed floor |
| `EconAudit.t.sol` | 1 | Every fill pays the rate on its `gross` (`testFuzz_E5_EveryFillPaysTheRateOnItsGross`, `:752`) |

`78e0ef4` added the six in `Curve.t.sol`, all of them new with the field.
`d1dd385` added three before that: two in `Fuzz.t.sol` for the split's
arithmetic, and `testFuzz_EveryRateAboveOneIsRefusedOnEverySurface` in
`Custody.t.sol`. It also
renamed `testFuzz_TheFeeRateNeverReachesTheMakersProceeds` to
`testFuzz_TheFeeRateNeverReachesTheExecutorsOutlay`, which inverts what it
asserts. **The rate now reaches the maker's proceeds and that is the design; what
it must never reach is the filler's outlay.** An auditor reading the old name
would have the model exactly backwards.

### What is not covered by an invariant

- No fuzz or invariant property exercises `ProveBatchExecutor.WHEN_ABSENT`. Its
  coverage is nine unit tests across two files. `BatchExecutor.t.sol`:
  `test_AFallbackBuysWhatTheMissingLegWouldHaveSupplied` (`BatchExecutor.t.sol:768`),
  `test_AFallbackStaysOutOfTheWayWhenItsLegSettles` (`BatchExecutor.t.sol:785`),
  `test_WhatAFallbackCostsARingThatDoesNotNeedIt` (`BatchExecutor.t.sol:1001`).
  `Adversarial.t.sol`: `test_ExactlyOneOfAPairRunsWhateverTheBatchDid` (`Adversarial.t.sol:357`),
  `test_TheLegIndexSurvivesAHoleInTheMiddle` (`Adversarial.t.sol:409`),
  `test_AFallbackKeyedPastTheEndOfTheBatchIsRefused` (`Adversarial.t.sol:461`),
  `test_ADisposalReadsItsOwnLegIndex` (`Adversarial.t.sol:500`),
  `test_AnyLegAndWhenAbsentDoNotCollide` (`Adversarial.t.sol:565`),
  `test_NoAllowanceOutlivesAPartialRing` (`Adversarial.t.sol:641`).
- No invariant drives a non-zero `curve`. Every handler writes `curve: bytes32(0)`,
  so the four campaigns price `KIND_LINEAR` and never `KIND_STRETCH`. The field's
  cover is `Curve.t.sol` — 14 tests, 6 of them fuzz properties.
- The three RFQ mirror checks have unit coverage only.
- `OversizedDisposal` is exercised by `test_ADisposalCannotOversellIntoAMark`
  (`Adversarial.t.sol:699`), which asserts the venue was never reached and that
  `SurplusUnsold` fired. No test names the error selector, because `settleRing`'s
  bare `catch` swallows it.
- `fail_on_revert = false` means a campaign can be green while a handler action
  reverted every time it was called. The `invariant_CallSummary` receipts exist
  to make that visible; read them.

---

## 6. Known limits, accepted

Report one of these as a finding and you will have spent your time and ours. Each
one is measured, not predicted, and each is accepted for a stated reason.
**Accepted is not the same as closed.** 6.5 is an open finding we chose to keep,
and 6.10 is an audit finding this repository partly reopened last week. Both say
so in their own words. Tell us if you disagree with the price we put on either —
that is a useful finding and we will read it.

### 6.1 A rebase down is a real insolvency

`_reserved` is a number per intent. The tokens behind every reservation of one
asset sit in a single balance on the settlement. A token whose balance falls on
its own leaves the reservations adding up to more than the contract holds.

Two makers each escrow 1,000, the token halves, and the first to withdraw takes
their whole 1,000. The second finds nothing, and their own `withdraw` reverts on a
reservation the contract cannot pay. It is first-come, and the loss lands on
whoever is slower.

Tests: `test_ARebaseDownLeavesTheEscrowBookShortOfTheBalance`
(`TokenMatrix.t.sol:967`) walks all three claims. The matrix cells are
`test_RebaseDownApproval` (`:467`), `test_RebaseDownEscrow` (`:471`),
`test_RebaseDownPermit` (`:466`) and `test_RebaseDownPermit2` (`:486`).

**Mitigation: an off-chain token allowlist.** Do not escrow an asset whose
balance can fall. **That allowlist does not exist** — see 6.7.

**Why not fixed.** A share-denominated reservation would spread the loss fairly.
It would also spend the guarantee that a donation can never pay for a fill, which
the whole architecture rests on — see `fillBatchWithCallback`'s note that the
contract pulls and never measures. That guarantee is worth more than the tokens
share accounting would admit. `sweepUnowned` returns zero rather than reverting
in this state, so a keeper walking a list of tokens does not lose the list to one
of them.

**Precision.** The maker's `withdraw` reverts only after a partial fill has
drained the balance, and it reverts with the token's own
`ERC20InsufficientBalance`, not with a settlement error. There is no protocol
signal that the contract is insolvent against its own book.

### 6.2 A rebase up does not reach the maker: the surplus is booked to the stray config

Escrow pays out the number it booked. A positive rebase leaves a surplus reserved
to nobody.

**`sweepUnowned` reaches it, and books it under the stray config.** Anybody may call the
function. The stray config is immutable, fixed at construction, and `claim` pays it to its
destinations like any other book. The gain never returns to the maker whose tokens grew.

**This is the only flow where a maker's asset goes to a destination the maker did not sign.**
It is deliberate and it is not a fee. Before the fee config change that destination was an
owner-set `defaultProceeds`; now nobody can repoint it. Read `sweepUnowned`'s NatSpec
(`:1338-1361`) before allowlisting an elastic asset, and read it beside 6.1 — an
auditor will ask why the two answers differ, and the answer is the same refusal
of share accounting.

**Stale elsewhere.** `test_ARebaseUpStrandsTheGainInsideTheContract`
(`TokenMatrix.t.sol:1017`) is still titled as though the gain stays put. Its
assertions are correct — it never calls `sweepUnowned`, so the gain does stay
put — but the title and the prose around it describe a world without the sweep.
`docs/ROADMAP.md` has caught up. `ProveSettlement.sol:624` used to say the gain
goes "to the fee sink"; `20e62e4` fixed that line and left the correction in
place at `:624-629`.

### 6.3 A taxing token can never fill at full size on the authorization or permit2 rung

`_redeem` presents `i.amountIn` to the token — not `take`. The tax lands, and
`_redeem` credits the reservation with what actually arrived, measured as a
balance delta. `_armLeg` then re-runs `_evaluate` **deep**, the reservation is
short of `take`, and the leg reverts `EscrowShort`. `_pullPermit2` does the same
thing for the same reason: both rungs move the whole `amountIn` at fill time.

Tests: `test_TaxAuthWhole` (`TokenMatrix.t.sol:368`) and `test_TaxPermit2Whole`
(`:379`) refuse at full size. `test_TaxAuthFunded` (`:381`) and
`test_TaxPermit2Funded` (`:394`) are the controls and settle at 900 of 1,000.
`test_TaxEscrowWhole` (`:365`) and `test_TaxEscrowFunded` (`:369`) are the third
custodied column.

**What a refusal leaves behind differs by rung.** The escrow cell fails with 900
already sitting in the settlement, because the deposit was its own transaction.
The authorization and permit2 cells draw inside the fill's frame, so the refusal
unwinds the draw: the maker keeps their tokens and the single-use nonce is
unspent. `Arming.t.sol`'s `test_ABadPermit2SignatureLeavesNothingBehind` holds
the Permit2 half.

**Two rollback mechanisms, worth distinguishing.** A single fill reverts
wholesale, so the EIP-3009 nonce is unspent. Inside a batch the same work runs in
the external `armLeg` self-call under a `try`, so only that leg's frame reverts
and the nonce survives.

**Mitigation: fill below full size, or use another rung.**

**Why not fixed.** An EIP-3009 authorization is a fixed value under a single-use
nonce. `Intent.minFill` prices the problem; it cannot remove it. Its own NatSpec
says so: a one-wei fill of a partial gasless intent still moves the maker's whole
`amountIn` into escrow.

### 6.4 An unattributed token is booked for a burner we do not control

`ProveSettlement.sweepUnowned` is permissionless, so anybody may put any token
into the settlement and have it booked. It can only ever book the stray config, and the
stray config each chain is built with names PulseX's own buy-and-burn rather than a contract of
ours (`config/fee-configs.json`); `claim` then pays it there. Backlog #117: burning is a
specialism to rent rather than to build.

Three answers existed. The first is impossible, and the third stopped being
available when the contract behind it came out:

| Answer | Verdict |
|---|---|
| refuse | Impossible. An ERC-20 transfer asks nobody's permission |
| hold, in a burner of our own | Was chosen, and is gone. It cost one contract and ten owner-gated functions to hold tokens nobody could claim |
| forward to PulseX's own buy-and-burn | Chosen. It needs no contract of ours and adds no owner surface |

**What the forward costs, measured rather than argued.**
`contracts/test/ForkBuyAndBurn.t.sol` drives both facts against a pinned mainnet
fork at block 27,260,000 (`PIN`, `ForkBuyAndBurn.t.sol:61`):

| Cost | Measured |
|---|---|
| 14.29% of every PLSX a forwarded token produces goes to the buy-and-burn's own `devAddr` | `test_DonatedHexIsConvertedAndBurnedMinusTheDevCut` (`:152`). A further 0.10% is the caller's bounty |
| A token with no PulseX pool against WPLS is stranded there for good | `test_WrappedTokenIsStrandedInTheBuyAndBurn` (`:218`). `convertLps` reverts on a batch that names it, and converts nothing it is not named in |

**Until 2026-09-09 both tests ran only when a repository secret was set**, and
nothing in the repository could tell a reader whether it was. Read the acceptance
in that light: this document priced a real cost off a test whose execution nobody
outside the GitHub settings page could confirm. Both suites now take their
endpoint from the workflow file instead, both run in CI, and both pass. The two
figures above were re-measured from that run on 2026-09-09. Section 8 says what
changed, and why the suites could not run at all under the default profile.

**Both costs apply to strays only, and the fee book is what keeps it that way.**
A fee now rests in the settlement's own balance until `claim` moves it, so it is
inside the reach of the sweep's arithmetic rather than outside the contract
entirely. `sweepUnowned` subtracts `_totalPendingFees` and `_totalParked` as well as
`_totalReserved` (`:1275-1275`), so neither a booked fee nor a maker's parked
capital can ever be booked to the stray config.
Two invariants assert exactly that — `TheFeeReachesTheDestinationTheIntentNamed`
and `TheDestinationEarnsExactlyTheRateOnTheGross` — and both also assert that
fills book nothing to the stray destination.

**Three things an auditor should weigh, and we accept all three.** `devCut` is
one owner call from 50%, behind a UUPS proxy under a key we do not hold. That
proxy was hacked once and is being replaced. And a forward is one-way, where a
hold was not: once a stray reaches the burn, nothing brings it back. **The destination can no
longer be moved either**: `setDefaultProceeds` went with the owner, and the stray config is
immutable, so replacing the burner means a new settlement. Against that, the amounts are
whatever nobody could claim, and the alternative was a contract of our own with ten owner
levers on it.

### 6.5 F-5 — the maker's free option, open by design

A funded escrow intent is fillable and withdrawable at the same instant. The
maker holds a free option on their own intent: let it fill when the market moves
their way, withdraw in front of the fill when it does not. The solver pays gas
either way.

The economics review rated this MEDIUM. It is **not fixed**, and
`test_F5_TheMakersFreeOptionIsPermanentNowAndCostsTheSameInBothCustodyModes`
(`EconAudit.t.sol:573`) drives it to completion and asserts that it works.

**Why accepted.** The same option was always free in allowance custody — revoke
the approval and the fill dies. Removing it from escrow would not remove it from
the protocol. Measured cost of each grief on 2026-09-04: revoking about 6,700
gas, withdrawing about 34,000. Neither figure was re-measured at `d1dd385` and
the test asserts no absolute number, only `assertLt(allowanceGrief,
escrowGrief)` — treat both as **unverified at this scope**. The fee split adds
+67 gas to a `fill` and touches neither path.

**Note against the test file.** The review's claim that both griefs cost about
13,100 each does not reproduce. `withdraw` now writes `cancelledAt` as well.

**The app used to contradict this section, and no longer does.**
`landing.control.audit` in `app/src/i18n/en.ts:1483` told every visitor that
"every finding is fixed, and each one has a test that fails if it comes back".
That was true of the security review and false of the economics review, and the
second half was false twice over: F-5's own test asserts that the attack works,
and two of the security regressions left with `FeeSink` on 2026-09-03. Corrected
on 2026-09-09 in English and in all thirty-four translations. The page now says
one economics finding stays open by design, and names it as one of the eleven
limits this section lists. A claim about an audit is the last claim that should
outrun its evidence.

### 6.6 F-4 — withdrawn, not fixed

The escrow cooldown that F-4 reasoned about no longer exists. Commit `66c43fa`
removed `requestUnlock` and the effective-at field. Every shipped fill path
settles atomically, so an executor who commits capital in one transaction and
fills in another is not a shape this protocol has.

### 6.7 The off-chain token allowlist does not exist yet

Two limits name a token allowlist as their mitigation, and a third names a
destination allowlist. None of the three is built. (The sink registry of 2026-09-23 was an on-chain
destination allowlist; it went with the fee config change.)

- `ProveSettlement.sol:589` — do not `escrow` an asset whose balance can fall
  (limit 6.1).
- `ProveSettlement.sol:1493-1496` — `skipInvalid` steps over a `Reason` and nothing
  else. A token that reverts inside `transferFrom` takes the whole batch down,
  because a revert is not a reason. "An executor still needs a token allowlist."
- Limit 6.9 — a list of vetted fee destinations. The settlement accepts any `feeConfig`
  hash, so the vetting is off chain: the app shows the destinations and asks the maker to
  acknowledge any config its build does not ship, and `FeeDefaults` publishes the suggested one.

Treat the two token allowlists as open operational risks, not as closed items.
An executor running today carries them.

### 6.8 Other accepted limits, verified in the code

#### The settlement

| Limit | Where | Why accepted |
|---|---|---|
| **The only ceiling on `Intent.feeRate` is `WAD`, and arithmetic sets it** | `_termsOk`, `:2560` | Above 100% the fee exceeds the gross and `gross - fee` panics, which `skipInvalid` cannot step over. Below it nobody rules on the number: a rate nobody will pay is an offer nobody fills, and the maker is the one it costs. The filler's `maxFeeRate` is the other bound, and `_evaluate` checks it on every path that moves money. A clamp of `fee` to `gross` was refused as cheaper and dishonest — it pays the maker zero in silence |
| **No bound on the window, at either end** | `_termsOk`, `:2551-2581` | A stale wallet signature costs the maker who signed it and nobody else. The app warns and does not block. This replaces `MAX_WALLET_WINDOW`, deleted in `a7c5d7f` |
| **Two windows on the gasless rung, and nothing reconciles them** | `Authorization.validAfter` / `validBefore` against `startTime` / `endTime` | The token enforces one and `_evaluate` the other. A maker who signs a long intent against a short authorization has signed an offer that stops working long before it expires — and nothing on chain says so. The leg reads `EscrowShort`, the same answer a taxed token gives |
| **`skipInvalid` does not cover a reverting token** | `fillBatch` doc, `:1493-1496` | A revert is not a `Reason`. See 6.7 |
| **`dryRun` does not invoke the callback** | `dryRun` (`:2724`), `_walkLeg` (`:2447`) | It says the legs are fillable, not that the batch will succeed. It is also pessimistic in one direction: a maker funded by an earlier leg's delivery reads `EscrowShort` here and would fill under `fillBatch`. Pessimistic is the right way round for a number a solver prices against |
| **A recipient that is the caller cannot be settled** | `fillWithCallback`'s note; `_deliverTo` | The pull becomes a self-transfer, which moves no balance, and the fee-on-transfer guard reads that as a short delivery. `fill` and `fillBatch` behave the same way |

#### The executors and the sink

| Limit | Where | Why accepted |
|---|---|---|
| **Native currency is not supported anywhere** | No `receive` on `ProveExecutor`, `ProveBatchExecutor` or `RfqVenue` | A venue that refunds gas currency, or a route that unwraps to it, reverts. Wrapped tokens only |
| **A disposal failure is swallowed** | `settleRing`'s `try this.sellSurplus(...) catch { emit SurplusUnsold }` (`:518-521`) | The batch has already paid every maker. A pool that moved under the caller's own tidying up must not undo eight good fills. The token sweeps home unsold, and the event is the only signal |
| **Disposal sizing has no on-chain answer** | `Route.disposal` doc, `:282-289` | `amountIn` is fixed in the venue's own calldata, which this contract cannot read. Ask for less than the surplus and the remainder sweeps home; ask for more and `sellSurplus` reverts `OversizedDisposal` (`:802`) before the venue is called, and the `try` frame catches that. **This used to rest on the transfer to the sink finding the balance short**, which held only while the executor held nothing but what the ring earned — one donation broke it. `36701c9` replaced the argument with a check |
| **An `ANY_LEG` call fails closed when the leg that funded it went missing** | `Swap.leg` doc, `ProveBatchExecutor.sol:137-142` | `amountIn` is fixed, so the transfer to the sink finds the balance short and the batch reverts. "The only acceptable way for a plan to be wrong about the shape of its own bag" |
| **The calldata patch is bounds-checked against length only** | `_write` (`:842`) | The contract cannot know what the word it overwrites means, only that it is inside the caller's own calldata and about to be sent with the caller's own money |
| **A token forgotten by a route strands on the executor for ever** | `_tokensNamedBy`, `_sweepAbove` | The executor's mark makes it permanent: a later ring reads the balance before it runs and sweeps only the increase. A strand is indistinguishable from a donation, which the contract protects on purpose. Naming every token the route mentions is the mitigation |
| **A payout aimed at the sink TEMPLATE is refused by name** | `ProveExecutor.proveCallback`, `ProveBatchExecutor._oweEveryLine` | `sinkTemplate` is never called and sweeps nothing, so a venue that pays it strands the proceeds. Each executor checks that it holds what the settlement is about to pull, and reverts `ProceedsNotHere(token, held, owed)` before it writes the relayer's allowance. Every fill that already settled held that much at that point, so the check refuses nothing that used to work. The accessor was `sink()` until this change, and under that name it cost the 369 fork rehearsal a run. `sinkFor(caller)` publishes the clone that does sweep |
| **A token forgotten on the `sink` is recoverable, and that is different** | `ProveCallSink.sol:43-53` | It rests on the caller's own clone, which only they drive. Name it in a later call and it comes home — and it is spendable inside that transaction. Recovery still costs a second transaction, so name every token the route can pay in |
| **An `approve` the caller's own venue calldata writes outlives the transaction** | `ProveCallSink.run` | Unavoidable with an arbitrary call. It is a claim on the caller's own clone and nobody else's, which is what `21a4240` bought. The mitigation is the caller's `extra` list plus `_sweep` at the end of every `run` |
| **A caller that is itself a public contract shares one `sink` across its users** | `ProveCallSink.sol:55-58` | One of its users can arm a claim on what another strands there. That is a choice the contract's author makes, and it is still far better than one sink for everybody |
| **`ProveExecutor`'s `Intent` struct is a hand-kept copy the compiler does not check** | `IProveSettlementFill.Intent` | Drop a field and it still builds, still deploys, and reverts on every call. The mitigation is `test/Executor.t.sol`, which fills through this interface against the real settlement |
| **`ProveRelayer.pullWithPermit2` does not pre-check the Permit2 nonce** | `ProveRelayer.sol:118-145` | Measured and rejected on 2026-09-02. It saves 3,424 gas on a burnt-nonce leg and costs 1,064 on a leg that fills, so it pays only above a 31% burnt-nonce rate. Reject the leg off chain with `dryRun` instead |

#### The RFQ venue

| Limit | Where | Why accepted |
|---|---|---|
| **A `binding` is one-shot, even though the `settlement` supports partial fills** | `RfqVenue.sol:157`, `:163`; enforced at `:434` | A repeatable binding needs its own ledger beside `ProveSettlement.filled`, able to disagree with it — two books for one order. It would also hand the counterparty a free option over a dutch quote. One binding per slice |
| **One quote can no longer serve two counterparties at two exclusivity rates** | `:55-59` | The cost of the neutral-protocol change reaching the venue. The maker signs two quotes instead. Two counterparties at the **same** rate still take one quote and one `binding` each |
| **Nothing caps the exclusivity rate. `MAX_EXCLUSIVE_FEE_RATE` was removed with no successor** | `:48-52` | Same argument as `Intent.feeRate` |
| **There is no `skipInvalid`, and its absence is the answer** | `:286-291` | "A two-leg ring with a leg stepped over is not a ring" |
| **Nothing on chain bounds the quote's own `endTime`** | `:113-114`, and `ProveSettlement._termsOk` | The binding's `expiry` (`:354`) is the only deadline a firm RFQ price can rely on, and `_checkBinding` now refuses a mirror that outlives it (`:420`). Until this document landed, the comment at `:113` still claimed the intent's window was an hour at most. **The venue enforces its own `expiry`, so nothing in the code depended on that claim — only the comment did** |

#### Rejected outright

| Item | Where |
|---|---|
| Executor and maker hooks | `docs/specs/2026-08-12-hooks-design.md` |
| Share accounting for rebasing tokens | Section 6.1 |
| Seeding fee-route liquidity | The sell route for the buy-and-burn is its own holders' job |
| A rescue function on any contract | Section 4 |
| A `Permit2` nonce pre-check in the relayer | Measured; `ProveRelayer.sol:118-145` |

#### Not a limit of the contracts, but open

**E-3, ring griefing** (`sdk/src/solver/rings.ts:165`, and the removed `mitigation` at `:174`) has no on-chain `fix`, and
the mitigation an earlier review closed on was deliberately removed. It is a
solver-side risk, not a settlement bug, but an auditor reading the ring code
should know it is open.

**Twenty-three Yul lines sit outside the coverage gate, and no branch does.** See
section 8. `forge coverage --ir-minimum` counts no Yul statement anywhere; the
four constructor guards named here went inside the gate on 2026-09-15.

### 6.9 A fee destination that cannot be paid strands its own book

New with the fee book, and stated as an accepted outcome rather than a bug.
`claim` pays the destinations of the preimage it is handed. With one destination it is a plain
transfer, so a destination that reverts on receipt has a `claim` that always reverts, and its
money stays booked and unreachable for ever. No owner, maker or solver can move it, and
`sweepUnowned` cannot reach it either, because the subtraction in `sweepUnowned`
(`ProveSettlement.sol:1360-1360`) protects exactly that balance. With several destinations each
share is a transfer capped at 200,000 gas, and a share that fails is re-booked under that
destination's own one-destination config (`ShareDeferred`), so it blocks nobody else and ends
up in the one-destination case above. `InsufficientGas` stops a caller from faking a failure by
under-supplying gas.

**Why that is the better failure.** Compare it with what it replaces: the same
address used to revert inside `_payFee` and take the whole fill down with it, so
the maker got nothing and nothing told them they had signed something dead. Now
the fill settles, the maker is paid in full, and only the fee waits. Nobody but
the destination's own author can be hurt by it. **What the registry's removal changes.**
No owner vets a destination any more: any hash is accepted, so a bad destination is the
signer's mistake (or the mistake of whoever published the config), and it is permanent for the
intents that signed it. A hash nobody can reproduce strands its book the same way. The app
mitigates both off chain (6.7).

### 6.10 E-5 is partly reopened, on purpose, and this is the disclosure

**Read this before you find it yourself.** Audit finding E-5 — "the fee is
voluntary for anybody who can coordinate" — was accepted outside the contract,
and inside it the mitigation was the rounding direction. `_quote` used to
ceiling-divide the fee, so any delivery above zero owed at least one wei at any
rate above zero. **`d1dd385` reversed that.** The fee now floors, because the
fee comes out of the maker's own number and the dust of a split belongs to the
party that signed. So a fill small enough pays no fee at all.

**It is priced out rather than closed, and the price is the whole argument.** At
ten basis points a fill has to keep its gross under 1,000 wei to be charged
nothing. Avoiding one whole token of fee therefore costs about 1e15 fills at
roughly 100,000 gas each. A maker who cares can set `Intent.minFill`. The
protocol earns nothing from a fill either way, so the loss falls on a
destination the maker chose and the maker keeps every wei of it.

**What the floor is worth depends on the token's width, and we disclose it
rather than floor it.** The rule is the same at every width — at one thousandth,
a gross under 1,000 units books nothing — but 1,000 units is dust on an
eighteen-decimal token and a tenth of a cent on bridged USDC or USDT, so a real
payment can land under it and pay its destination nothing.
`test_ASixDecimalGrossUnderAThousandUnitsBooksNoFee`
(`contracts/test/Fork369RealTokens.t.sol:301`) measures both sides on the token
itself: 999 units charge zero and 1,000 charge one. A minimum fee in the
contract would spend gas on every fill to move that dust from the maker to a
destination the maker chose, and it would need its own tests, its own gas
figures and its own scope delta to defend a tenth of a cent. `docs/FEE-MODEL.md`
carries the same disclosure for a reader who starts there.

**Where it is recorded in the code.** `contracts/test/EconAudit.t.sol:734-749`
carries the reasoning above the fuzz property, and
`test_E5_ADustFillPaysNoFeeAndTheMakerKeepsTheWei` (`:788`) drives it: one wei of
token A grosses one wei of token B, ten basis points of that floors to nothing,
and the `maker` keeps the wei. That test used to be
`test_E5_ADustFillStillPaysTheFee` asserting the opposite.
`invariant_TheDestinationEarnsExactlyTheRateOnTheGross`
(`Invariants.t.sol:979`) carries the same reversal at six decimals.

**What is not reopened.** The rate still reaches the destination on every fill
the rate can reach, `_accrue` still keys on token and destination, and an intent
that names no destination still charges nothing. Only the sub-wei floor moved.

### 6.11 An unfunded escrow signature is no longer inert, and this is the disclosure

**Read this before you find it yourself.** Until the parked-capital work, an
intent carrying `FLAG_ESCROW` that its maker never funded could never fill.
`_evaluate` answered `EscrowShort` for ever, and only a transaction from the
maker could change that. "I signed it and I just will not deposit" was a real off
switch, and it was the one property the escrow rung had that no other rung had.

**It is gone.** `park` frees a dead offer's reservation into
`_parked[maker][tokenIn]`, and the escrow arm of `_armLeg` funds any other live
escrow signature of that maker's out of it — chosen by a solver, at a moment the
solver picks, with no action by the maker at all. Both calls are permissionless.

**Why we took it.** It is the same shape as a decision already taken and already
disclosed. Revoking an ERC-20 allowance leaves a wallet signature alive, and
re-approving that token revives every signature the maker ever wrote against it;
`a7c5d7f` accepted that when it deleted `MAX_WALLET_WINDOW`, and
`test_ARevivedAllowanceRevivesEverySignatureStillInsideItsWindow` pins it. This
is that hazard arriving at the rung that used to be exempt. Nothing else about
the guarantee moves: the maker is never over-filled, because `amountIn` in their
own signature bounds it; the capital is only ever theirs; and `_evaluate` still
reads `_reserved[h]` alone, so parked capital backs no offer until the arming
call moves it, inside the transaction that spends it.

**What a maker must do instead.** `cancel` and `invalidateBefore` are the off
switches, they always were, and they are now the only ones. A maker who calls one
offer off to move its capital must call off every other signature they do not
want funded with it. `ProveSettlement.FLAG_ESCROW` says so in its own NatSpec,
`test_AnUnfundedEscrowSignatureIsNoLongerInert` (`contracts/test/Parked.t.sol:279`)
drives it end to end, and the app has to say it wherever it says anything about
escrow.

**Backlog #131 made the second switch usable for this.** `invalidateBefore` was
one monotonic floor per maker, so calling off a group of signatures meant calling
off everything below them. A nonce is now read as a `uint192` lane and a `uint64`
position — OpenZeppelin's `NoncesKeyed` packing, applied to a high-water mark
rather than to a counter — and the floor is per lane, so one word retires one
group and spares every other. `park` reads the floor as well as `endTime` and
`cancelledAt`, so the capital behind a retired signature rolls forward instead of
waiting for its window to close. Nothing a wallet signs changed: `INTENT_TYPEHASH`
does not move, the struct does not move, the selector does not move, and every
nonce this repository produces sits in lane 0 — every archived intent on either
board, none at or above 2^64, by `app/scripts/check-nonce-lanes.ts`, which asks
again on demand. `contracts/test/Lanes.t.sol` holds the two
properties an auditor should read first — a nonce above 2^64 is in another lane
and the old floor misses it, and a strict floor can never retire the top position
of its own lane, which `cancel` reaches instead.

**The one place the exclusion argument was false.** A maker who sets
`Intent.authNonce` is posting one lot at two prices, and the token's single-use
nonce is what makes the siblings mutually exclusive. Parked capital spends no
nonce, so it would fund both — `invariant_TwoOffersSharingAnAuthorizationNeverBothFill`
found that inside one campaign. `_drawFromParked` refuses an intent whose
`authNonce` is set, and `test_AnOfferWeldedToASiblingCannotBeFundedFromParkedCapital`
(`contracts/test/Parked.t.sol:599`) is the regression.

---

## 7. Prior findings

Two reviews. Every finding has a regression test in `contracts/test`, and CI runs
both files under a bare `forge test -vv` with no path filter.

### The 2026-08-11 security audit — `test/Security.t.sol`

Eight findings: one critical, one high, six smaller. **All eight were fixed.**
Two of them, C-1 and L-1, were `FeeSink` findings and their regression tests came
out with the contract on 2026-09-03. Both are recorded below because a finding
does not stop having happened; **neither has a subject in this repository any
more**, and no contract here calls a router or sells anything.

| ID | Severity | Finding | Regression test | Fix |
|---|---|---|---|---|
| C-1 | critical | Anyone could call `buyback` with a route of their own choosing, point the sink's whole balance at a pool they controlled, and keep the proceeds | Gone with `FeeSink`, 2026-09-03 | Was fixed in `FeeSink`. **No subject remains** |
| H-1 | high | Escrow was pooled per maker, so a maker could sign a second self-dealing intent and spend funds already committed to the first | `test_H1_MakerCannotEmptyEscrowWithASelfDealingIntent` (`Security.t.sol:153`) | `_reserved` is keyed by intent hash. `_evaluate` checks `_reserved[h] < take` |
| M-1 | medium | `fillBatch(skipInvalid: true)` still reverted on an unfunded maker, and a rising dutch minimum underflowed in `minOutAt` | `test_M1_AnUnfundedIntentDoesNotKillTheBatch` (`Security.t.sol:220`), `test_M1_ARisingMinimumIsRejectedNotReverted` (`Security.t.sol:191`) | `_termsOk` refuses `minOutEnd > minOutStart` as a `Reason`, not a panic |
| M-2 | medium | A contract maker returning a dirty 32-byte word from `isValidSignature` reverted `abi.decode(ret, (bytes4))` and took the batch down | `test_M2_DirtyErc1271ReturnIsJustABadSignature` (`Security.t.sol:241`) | `_validSignature` staticcalls under a 60,000 gas cap, checks `ret.length >= 32`, and decodes a whole `bytes32` before narrowing |
| M-3 | medium | Only the callback path measured the maker's proceeds, so a taxing output token shorted the maker on the direct path | `test_M3_ATaxedOutputTokenCannotUnderpayTheMaker` (`Security.t.sol:294`) | `_deliverTo` brackets every payee transfer and reverts `Underpaid` |
| M-4 | medium | An EIP-3009 authorization was not bound to one intent, so one authorization armed every same-size intent the maker had signed | `test_M4_AnAuthorizationCannotFundADifferentIntent` (`Security.t.sol:328`) | `_redeemInto` requires `auth.nonce == (i.authNonce ? i.authNonce : h)`. The same rule now covers Permit2 in `_pullPermit2In` |
| L-1 | low | A token that lied about `underlying()` could redirect the sink's sale | Gone with `FeeSink`, 2026-09-03 | Was fixed in `FeeSink`. **No subject remains** |
| L-2 | low | An intent with the same token on both sides let one balance delta satisfy two checks | `test_L2_SameTokenBothSidesIsRejected` (`Security.t.sol:311`) | `_termsOk` refuses `tokenIn == tokenOut` |

### The economics review — `test/EconAudit.t.sol`

Six `F-` findings. **Three are fixed, one was withdrawn, one is open by design,
and one lost its subject.** The roadmap and the README both say each of the six
carries a regression test. That is true only in the loose sense: F-4's and F-5's
tests assert the current design rather than defending the finding, and F-2's test
came out with `FeeSink` on 2026-09-03. Do not read "six fixed" into either
document, or into the app's own audit paragraph — see 6.5.

| ID | Severity | Finding | Regression test | Status |
|---|---|---|---|---|
| F-1 | critical | `depositFor` keyed on a bare hash, so one wei front-run ahead of the maker's own deposit made the attacker the owner of the reservation. In the gasless case the slot bricked permanently | `test_F1a_FrontRunningDepositForStealsTheWholeEscrow` (`EconAudit.t.sol:144`), `test_F1b_OneWeiOfJunkBricksAGaslessIntentForever` (`EconAudit.t.sol:195`) | **Fixed.** `deposit` takes the whole `Intent` preimage, so `maker` and `tokenIn` come from the signed struct. `withdraw` refuses anybody but `i.maker` |
| F-2 | high | `buyback` compared the caller's `minPlsxOut` against `getAmountsOut` — the spot price of the pool the swap was about to hit, in the same transaction. Measured: the treasury took 3,901.96 PLSX where an honest sale paid 90,909.09 | Gone with `FeeSink`, 2026-09-03 | Was fixed three ways in `FeeSink`. **No subject remains**: nothing in `contracts/src` calls a router or sells a token |
| F-3 | high | `skipInvalid` catches a `Reason`, not a revert, and `_evaluate`'s deep branch made plain calls to `allowance`/`balanceOf` on a token the intent author chose. Four ways to kill a batch: a reverting token, a chameleon token, a return bomb, and an unbounded `minOutStart` that panicked in `_quote`. The probes run *before* the signature check, so 65 zero bytes were enough | `test_F3a_OneHostileTokenKillsTheWholeBatch` (`EconAudit.t.sol:252`), `test_F3b_SimulateThenSubmitDoesNotSurviveAChameleon` (`EconAudit.t.sol:302`), `test_F3c_AReturnBombBurnsTheExecutorsWholeGasBudget` (`EconAudit.t.sol:358`), `test_F3d_AnUnboundedPriceIsAPanicNotAReason` (`EconAudit.t.sol:421`), `test_F3e_ARateAboveOneIsAReasonNotAPanic` (`EconAudit.t.sol:680`) | **Fixed.** Both reads go through `_probe`: a Yul `staticcall` under `PROBE_GAS` that copies exactly one word. Any failure reads as `Reason.EscrowShort`. `_termsOk` bounds both operands at `uint128`. Measured before the fix: honest batch 149,294 gas, bombed batch 9,846,699 and reverting. **The fix covered token A only.** Token B was read three times without a cap — twice in `_deliverTo`, never by `_evaluate` — so a poisoned `tokenOut` read `Ok` to `dryRun` and `fillability` and took the batch down inside `_settleLeg`, past the skip decision. Closed in `1655e35`, 2026-09-05: all six reads go through `_probe`, `_evaluate` answers `Reason.TokenOutUnreadable` under `deep`, and `test/ReturnBomb.t.sol` — 6 tests, added by that commit — drives the three shapes. **A fifth F-3 shape closed in `d1dd385`**: a `feeRate` above `WAD` panicked inside `_quote`'s subtraction, past the skip decision, and `_termsOk` refuses it now |
| F-4 | — | `cancel` and `invalidateBefore` bit immediately while the escrow withdrawal carried a cooldown, so a cancellation outran the notice an executor had been promised | `test_F4_EveryWayOutIsImmediateNowAndAtomicityIsWhatProtectsTheExecutor` (`EconAudit.t.sol:487`), `test_F4b_InvalidateBeforeIsImmediateAndKeepsTheEscrowRecoverable` (`EconAudit.t.sol:517`) | **Withdrawn.** The design changed under it — commit `66c43fa` removed the cooldown. Both tests assert the replacement design. Neither would detect a reintroduction of the original exposure |
| F-5 | medium | A funded escrow intent is fillable and withdrawable at the same instant, so the maker holds a free option and the solver pays gas either way | `test_F5_TheMakersFreeOptionIsPermanentNowAndCostsTheSameInBothCustodyModes` (`EconAudit.t.sol:573`) | **Open by design.** See 6.5. The test asserts the attack works. Its only comparison is `assertLt(allowanceGrief, escrowGrief)` — an ordering of two gas costs, not a defence |
| F-6 | low/medium | `fill` read a fee floor out of storage at execution time, so the owner could raise it under a transaction an executor had already priced | `test_F6_AnIntentCannotChargeMoreThanTheExecutorPriced` (`EconAudit.t.sol:639`) | **Dissolved, then fixed anyway.** No owner fee dial exists in `ProveSettlement`. The rate is signed into the intent, and `maxFeeRate` is a caller argument on every fill path |

### The 2026-09-28 review — `test/ReturnBomb.t.sol`

One finding. **Fixed.** This L-1 is not the 2026-08-11 audit's L-1 above.

| ID | Severity | Finding | Regression test | Fix |
|---|---|---|---|---|
| L-1 (2026-09-28) | low | `_arm` called `try this.armLeg(...)` with no gas cap. An unsigned leg on a token that loops, with a Permit arming blob, took 63/64 of the batch's gas in `_grantAllowance`'s uncapped `allowance` read or in the `permit` call, and every `skipInvalid` batch that carried it ran out of gas | `test_AnArmedLegOnALoopingAllowanceIsSteppedOver`, `test_AnArmedLegOnALoopingPermitIsSteppedOverForTheArmCap` | `armLeg{gas: ARM_GAS}` with `ARM_GAS = 500,000`, more than three times the costliest honest arming the suite runs (an EIP-3009 redemption with its re-evaluation, 147,912 gas). `_grantAllowance` reads the allowance through `_probe` and refuses with `EscrowShort` when the read fails. Measured batch gas with the hostile leg: 314,280 (looping allowance) and 743,960 (looping permit), in a 3,000,000 budget that the unfixed code exhausted |

### One more finding lives in the same file

`EconAudit.t.sol:671-675` carries an **E-5** section — "the `fee` is voluntary for
anybody who can coordinate", accepted outside the contract — with three tests
(`testFuzz_E5_EveryFillPaysTheRateOnItsGross` at `EconAudit.t.sol:743`,
`test_E5_ADustFillPaysNoFeeAndTheMakerKeepsTheWei` at `EconAudit.t.sol:777`, and
`test_E5_TheFeeOffMeansTheFeeOff` at `EconAudit.t.sol:803`). **`d1dd385` renamed the first two
because it partly reopened the finding — read 6.10 before you read them.** The
new `test_F3e_ARateAboveOneIsAReasonNotAPanic` also lives in this section, at `EconAudit.t.sol:682`, although it belongs to the
F-3 series. E-5 belongs to a later `E-` series
review that is recorded in
`docs/specs/2026-08-14-checkpoint.md`. References to E-3, E-5, E-6,
E-8 and E-9 through E-12 are scattered across that checkpoint, the
scale-and-rationing spec and four SDK files. If your engagement covers all prior
reviews, ask us for that list. The trimmed register of findings that still
matter is `docs/ECON-AUDIT.md`: E-3 and E-5 remain open there, while the
FeeSink-only findings are retired.

### Where the regression cover is thinner than it looks

| Test | Weakness |
|---|---|
| `test_F5_...` | Asserts the finding works. One comment block records an assertion that was **removed** — it had asserted the grief was under 40,000 gas and failed under `forge coverage` at 41,111 while passing `forge test` at 12,237, because the coverage build compiles with the optimizer off. The reason is real; the effect is that the hole can widen without a test failing |
| `test_F4_...`, `test_F4b_...` | Assert the replacement design, not the original exposure |
| `test_F3c_...` | `assertLt(burned, 2 * honestGas)` — relative, for the same coverage-build reason. A regression to 1.9x an honest fill still passes |
| `test_F1b_...` | `vm.expectRevert()` with no selector. It would pass on an unrelated revert |
| `test_M2_...` | Asserts only `reason != Reason.Ok` |
| `test_ADisposalCannotOversellIntoAMark` | Asserts the event and the venue call count, not the `OversizedDisposal` selector, because `settleRing`'s bare `catch` swallows the revert |

---

## 8. Test and coverage posture

### Counts, from each runner's own summary line

**Read the number off the run, never off `--list`, and never by counting
`[FAIL` lines.** Both traps have bitten this repository. `forge test --list`
declares 790 against a run of 748, because forge collapses each invariant
campaign into one entry in the run total, so the 46 `invariant_` functions count
as 4. 790 − 42 = 748. And `forge test` prints every failure twice — inline under
its suite, and again in the `Failing tests:` trailer — so a `^\[FAIL` count is
exactly double.

| Suite | Tests | Note |
|---|---|---|
| Solidity | **748** | `forge test`: "Ran 53 test suites in 287.36s (1019.50s CPU time): 726 tests passed, 0 failed, 22 skipped (748 total tests)", across 47 `*.t.sol` files. 44 are fuzz properties and 46 are invariant properties in 4 campaigns |
| SDK (`sdk/`) | **1,104** | `npx vitest run`: 1,096 passed, 8 skipped, 1,104 total, 46 files passed and 2 skipped. Out of audit scope |
| App (`app/`) | **1,947** | `npx vitest run`: 1,943 passed, 3 expected fail (the three M5 `test.fails` in the internal backlog), 1 skipped, across 86 files. Out of audit scope |

All three rows were re-run on 2026-10-06 on `master`, after the Yul margin tests and the wire
store's move-to-back landed (the app row at `c128dfa`; nothing under `app/` changed since). Each
number is that runner's own summary line. The rows before them were from 2026-10-05: 739
Solidity (717 run), 1,075 SDK and 1,934 app, at `fa1c696`, the fee config merge, plus the
follow-up that stops `FeeClaim.t.sol`'s opcode scan at the CBOR metadata trailer.

**Twenty-two Solidity tests skip** in a plain `forge test`, and twenty-two
fork tests exist in all: `Fork.t.sol` holds 2, `ForkBuyAndBurn.t.sol` 2,
`Fork369Rehearsal.t.sol` 4, `Fork369RealTokens.t.sol` 11 and
`ForkMultiHop.t.sol` 3. `Live369.t.sol` (8) was deleted with the fee config change: it attached
to the old deployed instances, and a new one is written after the redeploy.
Each bails out through a `_boot()` helper that calls `vm.skip(true)` when
`PULSECHAIN_RPC` is unset (`Fork.t.sol:64`, `ForkBuyAndBurn.t.sol:92`,
`Fork369Rehearsal.t.sol:140`,
`Fork369RealTokens.t.sol:142`, `ForkMultiHop.t.sol:80`). So 726 run without it,
and every one of the 726 asserts something. `ForkMultiHop.t.sol` came from
`master` and took the fork count from twenty-seven to thirty.

**The previous edition recorded a defect here that is now fixed.**
`ForkBuyAndBurn.t.sol`'s pair used `if (!_boot()) return;` with no `vm.skip`, so
two of the green tests reported PASS while executing one line. They skip honestly
now, which is why the skip count went from 10 to 12 and the run count from 611 to
610 with no test added or removed.

**All five fork suites run in CI.** Four have run since 2026-09-09. The `Test` step
gates them on `secrets.PULSECHAIN_RPC`, so whether they ran at all depended on a
repository setting no reader of this tree can check, and the skip is silent
either way. The endpoint is not a secret — `README.md:212` and `Fork.t.sol:17`
both print it — so a step of its own now supplies it in the workflow file and
runs `FOUNDRY_PROFILE=fork forge test --match-path 'test/Fork*.t.sol'`. That
glob took the two 369 suites with it the day they landed, and `ForkMultiHop.t.sol` too.
`Live369.t.sol`, the sixth, stayed out on its own header's instruction and is now deleted. All twenty-two pass, re-run on 2026-09-23 with CI's own command and
pacing (`-j 1 --compute-units-per-second 165`, the public `vk_demo` key): "Ran 5
test suites in 267.32s (336.03s CPU time): 22 tests passed, 0 failed, 0 skipped
(22 total tests)". It read nineteen of nineteen on 2026-09-15.

**Why they needed a profile of their own, which is a finding about our settings
rather than about the code.** `evm_version = "paris"` has no `PUSH0`, so forge
reads `0x5f` as an undefined opcode: the frame consumes every remaining unit of
gas and reverts with no data. Measured on the x402PLSX wrapper at block
27,260,000 — `underlying()` burns 1,040,431,565 gas and reverts under paris, and
answers PLSX in 24,905 gas under shanghai. The same `eth_call` on the node
answers PLSX either way, so nothing about the chain is wrong and the mismatch is
entirely local. The paris pin stays on the default profile, because it constrains
the bytecode we deploy; `[profile.fork]` sets shanghai, because a fork test
executes somebody else's.

Removing `FeeSink` on 2026-09-03 took 88 tests out: 63 in the two files that only
ever drove that contract, and 25 more spread across seven fixtures that built
one. `36701c9` added `contracts/test/Adversarial.t.sol`, 28 tests, and put tests
behind the three guards it defended. The suite then went 543 at `36701c9`, 557 at
`1655e35` — `ReturnBomb.t.sol` and the deploy-guard tests — and 562 at `d1dd385`,
which added five: `testFuzz_TheSplitTotalsToTheGrossAtEveryRate` and
`testFuzz_TheFeeRoundsDownAtBothExtremes` in `Fuzz.t.sol`,
`testFuzz_EveryRateAboveOneIsRefusedOnEverySurface` in `Custody.t.sol`,
`test_F3e_ARateAboveOneIsAReasonNotAPanic` in `EconAudit.t.sol`, and
`test_ABatchWhoseLegsChargeDifferentRatesPaysEachMakerRight` in `FeeTo.t.sol`.
`78e0ef4` then added fifteen, the fourteen of `contracts/test/Curve.t.sol` plus
`test_TheTypehashStringIsTheOneEveryWalletWillHash` in `ProveSettlement.t.sol`,
which states the typehash string a second time by hand so the two must agree.
It stood at 579 after the two `Deploy.t.sol` tests that section 8 describes, which
put `script/Guards.sol` back to full coverage. It went to 606 with the parked-
capital work of backlog #120, which added the twenty-six of `contracts/test/Parked.t.sol`
and `test_TheParkingActionsReallyDoSomething` in `Invariants.t.sol`, which drives
the three new handler actions by hand so a green campaign cannot be a campaign
that never parked anything. It reached 621 when the keyed nonce floor of backlog
#131 added the ten of `contracts/test/Lanes.t.sol` and un-skipped
`test_ParkAcceptsAnIntentTheNonceFloorKilled`, and #130 added `FallbackGasTest` in
`Gas.t.sol` plus the two multi-fallback tests in `BatchExecutor.t.sol`. `4ae8c69`
added `test_GasEightLegsTogetherAndApart` to `Gas.t.sol` and took it to 622. It
stood at 645 on 2026-09-15: twenty-three landed after that edition —
the eleven of `Fork369RealTokens.t.sol`, the four of `Fork369Rehearsal.t.sol`,
five that gave `TokenMatrix.t.sol` an eight-decimal row, two sink-template
refusals and one TypeScript signature recovered on chain. It stood at 679,
measured on 2026-09-23. Thirty-five test functions landed since `4375aba`, and
none was removed: the twenty-two of `contracts/test/FeeSink.t.sol`, three in
`FeeTo.t.sol` and three in `Deploy.t.sol` for the sinks, three in `Arming.t.sol`
for B-2, the three of `ForkMultiHop.t.sol` from `master`, and one invariant. The
invariant joins a campaign rather than adding a run, so the run count moved by
34.
`git diff 7f74fd4..4375aba -- contracts/test` counts the 23, and
`git diff 4375aba..a0bb95e -- contracts/test` the 35, each with none removed. **It stands at
739**, measured on 2026-10-05 after the fee config merge: that change deleted `FeeSink.t.sol`,
`Defaults.t.sol`, `NoDefaultAtFill.t.sol` and `Live369.t.sol` (and the `Sinks.sol` helper), and
added `Ctor.t.sol`, `FeeClaim.t.sol`, `FeeConfig.t.sol`, `FeeConfigsJson.t.sol`,
`FeeDefaults.t.sol` and `ProveReader.t.sol`; one invariant left with `FeeSink`. Read the net
from `git diff c264231..fa1c696 --stat -- contracts/test`, not from this sentence. On 2026-10-06 it reads **748**: nine
`test_` functions joined, two in `Deploy.t.sol` (`_linkedLibraries`) and seven pinning the Yul
blocks' safety margins in `FeeClaim.t.sol`, `ProveReader.t.sol` and `BatchExecutor.t.sol`.

**`d1dd385` also renamed ten tests, and every rename inverts what the old name
claimed.** Read the new names, not a list you were sent earlier:

| Was | Is now | File |
|---|---|---|
| `test_FeeIsChargedOnTopOfTheDelivery` | `test_TheFeeIsCarvedOutOfTheDelivery` | `ProveSettlement.t.sol` |
| `testFuzz_MakerNeverReceivesLessThanTheSignedRate` | `testFuzz_TheGrossNeverFallsBelowTheSignedRate` | `ProveSettlement.t.sol` |
| `test_TheFeeNeverComesOutOfTheDelivery` | `test_TheFeeAlwaysComesOutOfTheDelivery` | `Adversarial.t.sol` |
| `testFuzz_TheDeliveryNeverShortsTheCurve` | `testFuzz_TheGrossNeverShortsTheCurve` | `Adversarial.t.sol` |
| `testFuzz_TheFeeRateNeverReachesTheMakersProceeds` | `testFuzz_TheFeeRateNeverReachesTheExecutorsOutlay` | `Custody.t.sol` |
| `test_TheMakerPaysNothingForNamingADestination` | `test_TheMakerPaysTheWholeFeeForNamingADestination` | `FeeTo.t.sol` |
| `test_E5_ADustFillStillPaysTheFee` | `test_E5_ADustFillPaysNoFeeAndTheMakerKeepsTheWei` | `EconAudit.t.sol` |
| `testFuzz_E5_EveryFillThatDeliversAnythingPaysTheFee` | `testFuzz_E5_EveryFillPaysTheRateOnItsGross` | `EconAudit.t.sol` |
| `invariant_TheDestinationEarnsOnEveryFill` | `invariant_TheDestinationEarnsExactlyTheRateOnTheGross` | `Invariants.t.sol` |
| `test_AQuoteWithNoSpreadCannotPayForItsExclusivity` | `test_AQuoteWithNoSpreadPaysForItsOwnExclusivity` | `RfqVenue.t.sol` |

### Fuzz and invariant parameters — `contracts/foundry.toml`

```
[fuzz]           runs = 512
[invariant]      runs = 128   depth = 256   fail_on_revert = false   call_override = false
[profile.soak.invariant]
                 runs = 32    depth = 1024  fail_on_revert = false   call_override = false
```

42 fuzz tests at 512 runs and 2 at 20,000 is 61,504 fuzz executions. 46 invariant
functions at 128 by 256 is the default budget; the soak spends the same total
call budget on chains four times longer, because depth is what finds an ordering
bug.

There are exactly two profiles: `default` and `soak.invariant`. There is no `ci`
profile, and CI sets no fuzz or invariant override. The only overrides in the
tree are the two `/// forge-config: default.fuzz.runs = 20000` lines in
`Curve.t.sol`.

### Compiler

`solc 0.8.30`, `optimizer = true`, `optimizer_runs = 1000`, `via_ir = true`,
`evm_version = "paris"`. Paris, not Shanghai, so no `PUSH0` and the bytecode runs
on any EVM chain the registry might add later.

### The nightly soak — `.github/workflows/soak.yml`

`cron: "0 4 * * *"` — 04:00 UTC daily, plus `workflow_dispatch`. **Four
independent jobs, not one.** A job here fails without failing anybody's pull
request, which is the trade: these are the checks too slow or too network-bound
to sit in front of a merge.

| Job | What it runs | What it catches |
|---|---|---|
| `invariants` | `FOUNDRY_PROFILE=soak forge test --match-path 'test/*Invariants*.t.sol'` | An ordering bug. 32 runs of 1,024 calls — the same call budget the pull-request profile spends, in chains four times longer |
| `yul` | `python3 tools/prove-yul-runs.py`, with `FOUNDRY_THREADS: 1` | A forgiven `assembly` block that no test notices being broken. It breaks each block on purpose and counts the failures. **This is the whole compensating control for the 23 Yul lines the coverage gate forgives**, and it was 22m49s of the pull-request job before it moved here |
| `deployed` | `node tools/verify-bytecode.mjs 943 --pin` | Anything on testnet 943 moving away from the verdict somebody pinned. `contracts/tools/bytecode-pin-943.json` names, per contract, the address, the verdict, the size on chain, a SHA-256 of the runtime code and a reason in prose; the job passes only while all seven still report it. A redeploy, an edited deployment record, and a contract that starts or stops matching this tree each fail it. It runs against 943 only: mainnet 369 is deliberately older until #35 |
| `opcodes` | `npm run check:opcodes` | A registered chain taking opcodes `foundry.toml` does not assume. It lives here rather than in `ci.yml` because it talks to a chain, and a network call in front of a merge reddens builds for reasons unrelated to the change |

**`deployed` is new on 2026-09-09, and it exists because the gap it closes was
real.** `verify-bytecode.mjs` was written, worked, and was wired into nothing. Run
by hand that day it found testnet 943 two commits behind `master`, with two
shipped features absent from the chain this document said carried them.

### The coverage gate — `contracts/tools/coverage-gate.py`

It measures a **fresh** report on every run. It deletes the previous file, runs
`forge coverage`, and parses LCOV. It reads three record types and nothing else:

- `DA:` line hits — a count of `0` fails
- `BRDA:` branch outcomes — an outcome of `0` or `-` fails
- `FNDA:` function hits — a count of `0` fails

There is **no percentage threshold**. Any uncovered item that is not on an
exclusion list fails the build with `sys.exit(1)`. Only files whose LCOV `SF:`
path starts with `src/` or `script/` are checked; `lib/` and `test/` are skipped.

The measurement command:

```
FOUNDRY_INVARIANT_RUNS=1 FOUNDRY_INVARIANT_DEPTH=24
forge coverage --ir-minimum --exclude-tests \
  --no-match-path "test/{Fork,Live369}.t.sol" \
  --report summary --report lcov
```

It deliberately ignores `forge coverage`'s exit code, because forge returns
non-zero on a successful run whose advisory mentions stack depth.

**Two exclusion mechanisms.**

**(a) Yul, derived from the source.** Not a glob and not a pragma. A
brace-counting scanner re-reads each `src/` and `script/` file and forgives every
line inside any `assembly { ... }` block. Eight such blocks exist since the fee config change;
the gate forgave 23 lines in them on 2026-10-05:

| Block | Lines forgiven | What it does |
|---|---|---|
| `ProveSettlement._probe` | 6 | A gas-capped `staticcall` that copies exactly one word of return data. Every balance and allowance read off an intent's token goes through it: `_evaluate`'s two on token A before the signature check and its one on token B after, `_held` for a redemption or a permit2 draw, and both sides of `_deliverTo`'s fee-on-transfer bracket |
| `ProveBatchExecutor._write` (`:840-843`) | 1 | One `mstore`, overwriting one word of the caller's own venue calldata at an offset the caller named, bounds-checked against `data.length` |
| `FeeClaimLib._tryTransfer` | 3 | The 200,000-gas capped `transfer` of one share of a multi-destination `claim`, reading at most one word back |
| `ProveReader._read`, `_decimals`, `_symbol` (five blocks, three of them in `_symbol`) | 13 | The reader's bounded calls into a settlement and a token: one word copied, a capped `decimals`, and a `symbol` read that handles both the string and the `bytes32` shapes |

**(b) A hard-coded branch list — empty since 2026-09-15.**

It held four constructor guards until a factory made forge count them. A test's
own `new C(...)` becomes the `deployCode` cheatcode, and a reverting
constructor's counters die at that boundary. A plain Solidity factory keeps the
CREATE ordinary — `ExecutorFactory` in `test/Executor.t.sol`,
`BatchExecutorFactory` in `test/BatchExecutor.t.sol` and `VenueFactory` in
`test/RfqVenue.t.sol` — and `ProveExecutor` went from 81.82% to 100%.
`RfqVenue`'s two guards were never outside this gate, though the gate's own note
said so: `BRDA:223` and `BRDA:226` were always there and hit, and cutting the
two tests that take them drops that file to 25 of 27. Measured 2026-09-16.

The list and its unused-entry check stay. Entries are keyed by `(path, exact
source text)`, so they survive a line move, and the gate fails on any entry that
went unused — `STALE EXCUSE`.

**Total forgiven items: 23** — 23 Yul lines, and no branches at all. The gate run of
2026-10-06 at this tree measured **1,583/1,606 lines, 327/327 branches and 213/213 functions**
across thirteen `src/` files and seven `script/` files, and named exactly the 23 items above.
Branches and functions are at 100%; the 23 uncovered lines are the Yul. The same run's summary
table reads **2,087 of 2,113 statements (98.77%)**, which no gate reads. A full gate run takes
about three and a half minutes on a laptop.

**Statements are not in that list, and the omission is the point.** The gate reads
`DA:`, `BRDA:` and `FNDA:` from the LCOV report and nothing else, so it gates
lines, branches and functions and never statements — LCOV has no statement record
to gate. `forge coverage`'s own summary table computes one, and it is below 100%.
Read "100% coverage" here as those three and not as a fourth;
`docs/AUDIT-READINESS.md` carries the statement figure from its own run.

This paragraph carried 934/941, 205/209 and 132/132 until 2026-09-09,
982/989, 214/218 and 139/139 until 2026-09-15, and 996/1003, 220/220 and 141/141
until 2026-09-23, when `FeeSink.sol` and `DeployFeeSink.s.sol` joined the report, and
1,056/1,063, 234/234 and 147/147 from then until the fee config change. Each set was the previous tree's,
and nothing compared them to a run — the gate proves completeness and never
publishes its totals, so a number copied out of it once stays put while the tree
moves underneath. Re-measured from the LCOV the gate wrote.

**The gate was red at this tree until this refresh, and the reason is worth
reading.** It reported 12 uncovered items with no excuse and exited 1, every one
of them in `contracts/script/Guards.sol`: eight lines across
`readConfiguredDeployers` and `readDeploymentRecord`, those two functions again
as never called, and one line plus its branch at `Guards.sol:197`, where
`_requireRecordedSettlement` refuses a record missing either address. Nothing
under `contracts/src` was ever uncovered.

The cause is `3a556e6`. Both external functions used to be reached by
`try this.…` from inside the guards that needed them. Forge refuses
`address(this)` in a script contract, so those guards had never once run, and the
rewrite made each guard read the file itself with `vm.exists` and
`vm.keyExistsJson`. The two functions stayed behind as a way to ask what a chain
expects from the command line, and nothing in the suite called them; the new key
check that reverts `NoDeploymentRecord` (`:194-197`) arrived with no test of its
own. So one commit fixed a guard that had never run and left its replacement
unproven — the same defect twice.

Two tests in `contracts/test/Deploy.t.sol` close it, and the gate exits zero
again. `test_TheAskHelpersReadTheSameFilesTheGuardsRead` calls both helpers
against the records in the repository.
`test_ARecordMissingEitherKeyIsRefused` writes a record that names no
settlement, then one that names a settlement and no relayer, and reads the
refusal for each. Delete the key check and it fails, which was measured rather
than assumed. That test needs a record file that exists and is incomplete, and
`deployments/` is read-only in `foundry.toml` on purpose — a deploy script must
never edit the record it is checked against. So the permission list names one
writable file, `deployments/424209.json`, on a chain id no network uses; the test
removes it, and `.gitignore` refuses it if a run dies first.

**`contracts/lcov.info` is not committed**, and it never was: `.gitignore:51`
ignores it. An earlier edition of this document described it as committed at
`a26a4ce`, quoted percentages from it, and warned that running the gate against
it reported spurious failures. All of that was wrong about a file git has never
tracked. It is a local artefact of whoever last ran the gate. Run the gate; it
measures fresh.

**The compensating control for the un-countable Yul is fixed, and it now runs in
CI.** `contracts/tools/prove-yul-runs.py` replaces a Yul line with `invalid()`
and counts failing tests, to prove the line actually runs. It used to name
`("src/ProveSettlement.sol", 1577, ...)` — a line that edits had turned into the
signature of a function with no assembly in it — and it had no target for
`ProveBatchExecutor._write` at all. Its `TARGETS` list (`contracts/tools/prove-yul-runs.py:133-145`) now names a
**file and a function** and it searches for the block, it builds in a throwaway
`git worktree` so your checkout is never written to, and it fails on any
`assembly` block that no target claims. **An earlier edition of this document
said the tool was broken and not in CI. Both halves are now false.**

**Every margin it published before 2026-09-04 was twice the real one.** It counted
failures by counting transcript lines that open with `[FAIL`, and `forge test`
prints every failure **twice** — once inline under its suite, once again in the
`Failing tests:` trailer, both at column zero. Measured against a throwaway
project: two failing tests, four matching lines. So the published margins of 148
for `_probe` and 2 for `_write` are **74 and 1**.

**The fix landed on 2026-09-04.** The tool reads forge's own summary line
instead of counting `[FAIL`, and says so rather than reporting zero when that
line is missing. Re-measured on the whole suite that day: **76 for `_probe` and
2 for `_write`**, then **287 for `_probe`** once `1655e35` routed every fill's
delivery through the block, and **291** once the fee split added four tests that
settle something. **Re-measured for this edition on 2026-09-08**, after the
parked-capital work of #120: **295 for `_probe` and 2 for `_write`**, both "run
by the suite". Running the tool costs a cold build and a full suite per block,
which is why it is not re-measured on every edit. Read `_probe`'s figure as a
margin that moves with the suite, not as a constant: the twenty-six tests of
`test/Parked.t.sol` all settle a fill, and four of them landed on it.

**This is a reporting defect, not a coverage gap** — the control still fails CI
when a block stops being run, because one failing test is still non-zero. It is
recorded because an auditor reading "2 tests fail" would take more comfort from
it than it is worth. **Two tests are what stand between a silently broken
calldata patch and a green suite**, and the tool's own note explains why:
`_write` has one caller, `sellSurplus`, which `settleRing` reaches through a bare
`catch` that swallows anything the disposal does wrong. A broken `_write` is
invisible to every test that only checks the batch settled. The margin was one
until `test_ADisposalRefusesAPriceBelowItsScaledBound` landed on 2026-09-04. Two
is still worth widening.

### The Yul blocks' safety margins — measured 2026-10-06

`prove-yul-runs.py` proves each block **runs**. This section says what each block **assumes**,
and how far the code is from breaking each assumption. Every block is in `contracts/src`, and
none was changed to write this; the margins are held by tests in `contracts/test`. `script/`
holds no Yul: `Deploy.s.sol`'s library walk was written in plain Solidity so that it needs no
target in `prove-yul-runs.py` and no forgiveness from the coverage gate.

**Memory.** Every block either writes only Solidity's scratch space (`0x00`–`0x3f`, which the
compiler never relies on across statements) or writes inside an array it allocated and bounds-
checked. None moves the free memory pointer, and none reads memory it did not just write.

| Block | What it assumes | Margin, measured | Held by |
|---|---|---|---|
| `ProveSettlement._probe` | The callee is hostile (an intent names the token). The `staticcall` returns into nothing, and exactly 32 bytes are copied to scratch, only when `returndatasize() ≥ 32`. | `PROBE_GAS` is 30,000. An honest leg costs 2,764 gas, so about 11× headroom. A return bomb costs 30,177 gas: the cap and one copied word, against 63,608 for a high-level call. | `test/ReturnBomb.t.sol` (`test_TheWorstBombASolverCanBeMadeToStepOver`, `test_WhatTheSkipProbesCostWhenEveryLegIsHonest`, `test_ATokenThatAnswersNothingIsSkippedAndTheBatchSettles`) |
| `ProveBatchExecutor._write` | `offset + 32 ≤ data.length`, checked in Solidity just before the block; `offset + 32` overflowing reverts under checked arithmetic. One `mstore` inside the caller's own calldata blob. Not tagged `memory-safe`, though it is: it writes only inside an allocated `bytes`. | Exact. The last word of the blob is written, and one byte further is refused with `PatchOutOfRange`. | `test_APatchOnTheLastWordIsWrittenAndOneBytePastItIsRefused` (new), `test_APatchOffThePlotIsRefused`. The new test also asserts the sale ran, so it widens `_write`'s `prove-yul-runs` margin, which reads five tests on 2026-10-06 (four on 2026-10-04, two on 2026-09-08). |
| `FeeClaimLib._tryTransfer` | The destination's token may be hostile. The `CALL` returns into scratch `0x00`–`0x20`, so at most one word is copied (return-bomb safe). Success means the call succeeded and returned nothing, or returned at least one word whose first word is exactly 1. The gas guard before each share (`TRANSFER_GAS + TRANSFER_GAS / 63 + 30_000` = 233,174) lets the call forward the full 200,000 under EIP-150's 63/64 rule, which needs 203,175 available at the `CALL`. | Swept from 200,000 to 500,000 gas in 250-gas steps: wherever a three-way claim completes, the destination sees **exactly** the gas it sees with no limit (199,499 at entry), and no share is ever deferred for want of gas. Below the guard, the whole claim reverts and the book is untouched. The lowest budget that pays a three-way claim is 360,750. An ordinary first-time transfer costs 51,463 gas measured from a test frame, under a third of the cap. Return shapes: `true` plus a spare word is paid; 31 bytes, or a word of 2, is deferred. | `test_AShareThatNeedsNearlyTheWholeCapIsNeverDeferredForWantOfGas`, `test_TheReturnWordIsReadExactly`, `test_AnOrdinaryTransferUsesASmallFractionOfTheCap` (all new); `test_AGasBurnerIsDeferredAndCostsAtMostTheCap`, `test_AReturnBombIsDeferred`, `test_AnUnderSuppliedClaimRevertsInsteadOfRecordingASpuriousDeferral` |
| `ProveReader._read` | The callee is the reader's own immutable settlement, so the `staticcall` forwards `gas()` with no cap. The output is one word to scratch, read only when `returndatasize() ≥ 32`, and zeroed otherwise by multiplication. A settlement with no code is answered before the call, because a bare `staticcall` to an empty account succeeds. | A settlement can waste at most its own gas, and can never make the reader copy more than 32 bytes. The reader is a view; nothing on chain calls it. | `test_ASettlementWithNoCodeReadsAsAFailureNotARevert` |
| `ProveReader._decimals` | The token is hostile. The selector goes to scratch, the output is one word to scratch, read only when it is a whole word, and only a value ≤ 255 counts. | `META_GAS` is 30,000. An ordinary `decimals()` costs 3,176 gas read cold, about 9× headroom. Shapes: 6 and 255 are read; 256, 31 bytes and nothing read as 0; a longer answer reads its first word. | `test_DecimalsShapesAreReadOnlyWhenTheyAreAWholeWordThatFits`, `test_OrdinaryMetadataIsWellInsideTheCap` (new) |
| `ProveReader._symbol` (three blocks) | The token is hostile. The `staticcall` returns into nothing, then `min(returndatasize(), 96)` bytes are copied into a 96-byte buffer it allocated. The first word is read only when at least 32 bytes came back, the length word only when at least 64, and the string is cut to what actually arrived. | Copy bounded at 96 bytes, whatever the token returns. An ordinary `symbol()` costs 3,900 gas cold, about 7.7× headroom. A token whose metadata burns all its gas costs the reader 40,547 gas more than an honest one: two capped calls and nothing else. | `test_SymbolShapesAreReadAndCappedWithoutEverReverting`, `test_MetadataThatBurnsGasCostsAtMostTwoCaps` (new) |

**What a margin here does not cover.** The figures are gas on this EVM (`paris`, solc 0.8.30,
`via_ir`). A repricing of `CALL`, cold account access or memory, like EIP-2929 was, would move
every one of them. The `_tryTransfer` sweep asserts the guard by behaviour rather than by
arithmetic, so a repricing that broke it would fail that test rather than pass silently.

### CI — `.github/workflows/ci.yml`

Push to `master`/`main`, and every pull request. Three parallel jobs.

**This table was wrong twice and it is worth saying which way.** It used to list
`prove-yul-runs.py` and `git diff --exit-code src/` as steps of this job. Neither
is: the first runs nightly in `soak.yml`, and the second was replaced by a
fingerprint compare. It also omitted five steps that do run. **A table that is
wrong about the controls is worse than no table**, because a reader trusts it
instead of the workflow. Read `.github/workflows/ci.yml` beside it.

Job `contracts`, in order — fifteen steps:

| Step | Fails on |
|---|---|
| `forge fmt --check` | unformatted Solidity. Unchecked until 2026-09-09, when 43 files had drifted |
| `PULSECHAIN_RPC=… FOUNDRY_PROFILE=fork forge test --match-path 'test/Fork*.t.sol' -vv` | a failing fork test, against real mainnet contracts at a pinned block. The endpoint is written into the workflow rather than taken from a secret, because it is not a secret and a missing one made the suite skip silently on every green build |
| `forge build --sizes` | a compile error, or a contract over the EIP-170 limit |
| `forge test -vv` | any failing test |
| `python3 tools/coverage-gate.py` | any uncovered line, branch or function outside the two exclusion lists, or a stale excuse. Green at this tree |
| `python3 tools/src-fingerprint.py` | nothing. It records the fingerprint the last step compares against |
| `python3 tools/check-citations.py` | a line-number citation in one of six documents that no longer points at what it claims, or a citation shape the tool cannot parse |
| `python3 tools/check-tree-pin.py` | a tree pin in `docs/AUDIT-SCOPE.md` or `docs/AUDIT-READINESS.md` that is not `contracts/src` at `HEAD`. At the repository root |
| `python3 tools/check-ci-parity.py` | `tools/run-ci.sh` and this workflow disagreeing about the step list. It is at the repository root, not under `contracts/` |
| `python3 tools/src-fingerprint.py --compare` | any step above reaching back into `contracts/src`. It compares a fingerprint rather than running `git diff --exit-code src/`, so a developer with uncommitted contract work can still go green |
| `forge test --match-path test/Gas.t.sol -vv` | a gas assertion moving |
| `node app/scripts/gen-gas.mjs --check` | a stale landing-page gas table |
| `python3 tools/check-gas-figures.py` | prose anywhere in the repository quoting a gas figure the table has retired |
| `bash abi/export.sh --check` | any of 7 exported ABI JSON files differing from the build. `FeeSink.json` is the seventh, new in `4d48379` |
| `git diff --exit-code app/src/lib/__fixtures__/` | the `forge test` above rewrote the EIP-712 fixture |

Jobs `sdk` and `app` run lint, typecheck, build and vitest. The SDK job also runs
`npm run check:abi`. The app job runs `npm run check:addresses`, added in
`1655e35`, which reads the operator unit files and `app/src/rfq/venue.ts` against
`contracts/deployments/*.json` and refuses an address that is live on the other
chain or that its parser cannot place. The app resolves the SDK over a `file:`
link, so the SDK builds first.

### Which gate guards what — the whole picture in one table

| Runs | Gates |
|---|---|
| **Every pull request and every push to `master`** | The fifteen steps above, plus the `sdk` and `app` jobs |
| **Nightly, 04:00 UTC** | The deep invariants, `prove-yul-runs.py`, Slither with `check-slither.py`, `verify-bytecode.mjs 943`, `check:opcodes`. Five jobs in `soak.yml`, and none of them stands in front of a merge |
| **Only by hand** | Every end-to-end fill under `app/scripts/e2e/`, `Live369.t.sol`, and **judging a Slither finding**. The run and the bookkeeping went nightly on 2026-09-09; deciding whether a finding is real did not, and cannot. `docs/slither-triage.md` also sits outside `check-citations.py`, so nothing catches a rotted line number in it |

**The Slither report under-counts this contract's external calls, and the reason
is structural.** `ProveSettlement._probe` makes its call in assembly, so Slither's
call graph does not carry it, and six reads go through it. Question 9.6 lists all
six with their lines. Read that before you take the static report's
`calls-loop` count as the settlement's external-call surface.

**Two more things a reader should not have to discover.** CI triggers on push and
pull request, so work committed and not pushed is gated only by
`.githooks/pre-push` and `tools/run-ci.sh` — the coverage gate once sat red on
`master` for four days behind 87 unpushed commits, with every gate working and
none asked. And there is no security tooling anywhere in either workflow: no
SAST, no dependency audit, no secret scanning. the internal risk assessment rates
both.

### The five generated artifacts

Each exists because a hand-written copy of it went wrong first.

| Artifact | Generator | CI check | What it prevents |
|---|---|---|---|
| `app/src/lib/__fixtures__/eip712.json` | `contracts/test/Fixture.t.sol` | `git diff --exit-code`, plus the **SDK** suite asserts against it | Solidity/TypeScript EIP-712 divergence. One drifted field makes every signature the app produces unspendable, with both suites green |
| `sdk/src/abi.ts` | `sdk/scripts/gen-abi.mjs` | `npm run check:abi` | A stale ABI name or signature that `tsc` accepts (the wallet client goes through `as never`) and that fails on every on-chain call. The check also compares every hand-written signature in `sdk/src` and `app/scripts` against the compiler's |
| `contracts/abi/` (7 JSON files) | `contracts/abi/export.sh` | `--check` | A second ABI copy that nothing in the repo reads, so nothing notices it rotting. It drifted once by four dead functions and three live ones |
| `app/src/landing/gas.ts` | `app/scripts/gen-gas.mjs` | `--check`, in the contracts job | A public price claim going stale. The page once advertised 33,403 gas for a warm allowance fill against a measured 105,238, in 35 languages |
| `app/src/i18n/reviewed/*.json` (34 locales) | `app/scripts/i18n/review.ts` | **No named CI step.** `app/scripts/i18n/stale.test.ts` runs inside the app job's vitest | A translation outliving the English it was reviewed from. Parity tests only check the key set, so editing four English words leaves 34 confident mistranslations green |

**Only the SDK suite asserts the fixture.** Three files import it —
`sdk/src/intent.test.ts:4`, `sdk/src/settlement.test.ts:3` and
`sdk/src/rfq.test.ts:16` — and nothing under `app/src` does, despite the file
living in `app/src/lib/__fixtures__/`. An earlier edition of this document, and
`docs/ROADMAP.md`, say both TypeScript suites assert it. They do not.

The fixture pins **eleven** things, not just the intent digest. The JSON has
twelve top-level keys and the twelfth is `_comment`, a provenance note that pins
nothing — count the keys, then subtract that one:

| Key | What it pins | Written by |
|---|---|---|
| `chainId` | 369 | `Fixture.t.sol:49` |
| `verifyingContract` | the settlement's address | `:50` |
| `typehash` | `INTENT_TYPEHASH` | `:51` |
| `domainSeparator` | the settlement's domain | `:52` |
| `digest` | `hashIntent(i)` | `:53` |
| `intent` | all 17 intent members, `curve` included | `_intentJson`, `:251` |
| `rfq` | the venue's `verifyingContract`, `EXCLUSIVE_TYPEHASH`, domain separator and binding digest, plus the five `Exclusive` fields | `_rfqJson`, `:218` |
| `flags` | the three custody flags, read off the contract | `_flagsJson`, `:157` |
| `reasons` | all 15 `Reason` members by compile-checked name, plus a count from `type(Reason).max`. `TokenOutUnreadable` was appended at 14 by `1655e35` | `_reasonsJson`, `:184` |
| `minOutAt` | ten instants on a `KIND_STRETCH` curve — both corners, either side of each, and the flats between. The fixture's own `flags` are `1 \| 2 \| 8`, and the kind bits are private to the settlement, so these ten samples are what pins them | `_curveJson`, `Fixture.t.sol:295` |
| `quoteAtStart` | a quote: take, delivered, fee, rate. `d1dd385` set the take to `33_333e18 + 1` so the gross times the rate leaves a remainder and a floor and a ceiling disagree; `Fixture.t.sol` asserts that before it writes | `_quoteJson`, `:328` |

An earlier edition said the fixture pinned twelve things and then listed fifteen.
One of those fifteen was `MAX_WALLET_WINDOW`, which went with `a7c5d7f` and
appears in neither `Fixture.t.sol` nor the fixture now. The field values are
adversarial on purpose — `feeTo` is non-zero because the SDK once wrote
`feeTo: ZERO` and every test on both sides passed against a zero fixture.

### The specification matrix

It carries its table in its own header, reproduced here so you can see the shape
of the coverage before you open the file.

There were two. The second was `contracts/test/FeeSinkMatrix.t.sol` — 14 token
behaviours crossed with four disposal paths — and it went with `FeeSink` on
2026-09-03. Nothing replaces it, because nothing in `contracts/src` disposes of a
token any more. What a stray reaches instead is section 6.4, and what that costs
is measured in `contracts/test/ForkBuyAndBurn.t.sol` rather than in a matrix.

#### `contracts/test/TokenMatrix.t.sol` — 51 tests, 9 behaviours by 5 rungs

`x2` and `/2` are rebases applied after the funding and before the fill.
`Blocked` is the token's own error, `InsufBalance` is `ERC20InsufficientBalance`,
and `EscrowShort` is the settlement's.

```
 token behaviour        approval      escrow            permit        authorization  permit2
 ---------------------  ------------  ----------------  ------------  -------------  ------------
 standard, 18 decimals  settles       settles           settles       settles        settles
 standard, 8 decimals   settles       settles           settles       settles        settles
 standard, 6 decimals   settles       settles           settles       settles        settles
 fee on transfer, 10%   settles (a)   EscrowShort (b)   settles (a)   EscrowShort    EscrowShort
 no return data         settles       settles           settles       settles        settles
 blocked executor       Blocked       Blocked           Blocked       Blocked        Blocked
 rebase up, x2          settles       settles (c)       settles       n/a, no 3009   settles
 rebase down, /2        InsufBalance  InsufBalance (d)  EscrowShort   n/a, no 3009   InsufBalance
 par wrapper            settles       settles           n/a, no 2612  n/a, no 3009   settles
```

**Three things about this matrix that an auditor should know before trusting it.**

1. **It now covers the permit2 rung, and that is new.** `Rung` is
   `{Approval, Escrow, Permit, Authorization, Permit2}` (`TokenMatrix.t.sol:135-141`), the
   settlement is built with a real `MockPermit2` (`TokenMatrix.t.sol:242`), and all nine token
   behaviours have a permit2 cell. An earlier edition of this document asked an
   auditor to review those cells because nothing tested them; the question is now
   answered by measurement rather than by inference. Two of the answers are worth
   reading. A rebase down on permit2 reports the token's `InsufBalance` rather
   than the permit column's `EscrowShort`, because `_evaluate` answers "is this
   maker funded?" from the reservation for every custodied rung and never probes
   a permit2 maker's wallet. And the par wrapper settles on permit2 while it can
   take neither of the older gasless rungs, because Permit2 asks the asset for no
   signature at all.
2. **The matrix's own comment is fixed.** `TokenMatrix.t.sol:135` says "The five ways an intent is
   backed. `ProveSettlement`'s header names them", and the header names five. An
   earlier edition recorded that comment as stale.
3. **Four `n/a` cells run no assertions at all.** `_run` logs and returns
   (`TokenMatrix.t.sol:447-450`). They are declarations, not measurements: rebase up and rebase
   down against authorization, and the par wrapper against permit and
   authorization. There were five, and permit2 took one of them over.
   `_assertSettled` also exempts the two rebasing rows from the custody invariant
   `balanceOf(settlement) == reserved(h)` (`TokenMatrix.t.sol:525-534`), and names them when it
   does.

Every settled cell asserts the fee book — `pendingFees(feeTo, tokenOut)` moved by
exactly the fee, and `balanceOf(feeTo)` did not move at all (`TokenMatrix.t.sol:589-590`) — and
since `d1dd385` it also asserts the split: the maker's balance grew by
`delivered` and the executor's fell by the gross, whatever the rate is
(`TokenMatrix.t.sol:572-579`).

---

## 9. Questions we want answered

These are ranked by how unsure we are, not by how bad the consequence would be.

**The fee config tree runs on no chain yet**, so 9.1 — the fee book as it now stands — has
never been deployed, and nothing below has ever run on mainnet. The rest of this section was
code on testnet 943 from the redeploy of 2026-09-09 until the fee config change, and the next
redeploy puts all of it back there. This section used to open "the first four
are all code that has never run on any chain", which was written on 2026-09-04
and was correct for exactly one day: the redeploy of 2026-09-05 put the fee book,
the disposal filter, the credit path and the sink clones on 943, and the redeploy
of 2026-09-09 put parked capital and the nonce lanes there too. The claim then
stood, false, for four days beside a section 3 that said the opposite. It is
recorded rather than deleted because the failure mode is the interesting part: a
sentence about a chain went stale while every gate in the repository stayed
green, and none of them could see a chain. `soak.yml`'s `deployed` job is the
answer to that, and it is one day old.

**Running on a testnet is not evidence of much.** The traffic is our own bots
against our own tokens. Read it as "the code has been deployed and has settled a
transaction", not as "the code has met an adversary".

**Read `contracts/test/Adversarial.t.sol` first.** It was written against an
earlier edition of this section and its four headed sections map onto it one for
one — `1. WHEN_ABSENT` (`Adversarial.t.sol:357`), `2. The credit path and the callback` (`:612`),
`3. Permit2 nonce ordering` (`:1341`), `4. Rounding` (`:1528`). It holds 28 tests
and it is where our own first pass at these questions lives. It is a starting
point, not an answer: `35185e7` added it with twenty-four tests and four findings
the rest of the suite did not have, and `36701c9` added four more after fixing
three defects it found.

### 9.1 The fee book — money that rests here

`_pendingFees` (`ProveSettlement.sol:664`), `_totalPendingFees` (`ProveSettlement.sol:680`),
`_book1` (`ProveSettlement.sol:2942`), `claim` (`ProveSettlement.sol:1405`), `FeeClaimLib.pay`,
and the subtraction in `sweepUnowned` (`ProveSettlement.sol:1360`). Added
2026-09-04 in `36701c9`, and keyed by the fee config hash since 2026-10-03.

The settlement used to be a place money passed through, and `sweepUnowned` was
the proof: whatever no reservation claimed belonged to nobody. That is now wrong
in one specific way, and everything downstream of it is what we want checked.

- Is the three-book subtraction exact on every path? `_reserved`/`_totalReserved`,
  `_pendingFees`/`_totalPendingFees` and `_parked`/`_totalParked` are each written in the
  same statement at every site. Confirm there is no site where one moves without the other,
  including the revert paths, and including the two writes `FeeClaimLib.pay` makes through
  the storage pointers it is handed.
- **The reserved-fee ledger.** P1, P2 and P3 are booked by `_reserve` before the solver's
  single strict pull, and `_settleLedger` reverts the whole call if anything owed did not
  arrive. Confirm no path books a fee whose tokens never arrive, and that `skipInvalid`
  cannot step over a shortfall.
- **The `DELEGATECALL` into `FeeClaimLib`.** Its address is fixed at link time; it has no
  `SELFDESTRUCT` and no `DELEGATECALL` (`FeeClaim.t.sol` checks the deployed bytes). Confirm
  the two mappings it is handed are the ones `sweepUnowned` reads, and that nothing in it
  can write any other slot.
- `claim` zeroes the cell before it transfers and holds `nonReentrant`. Confirm a
  destination or a token that calls back in finds nothing.
- `claim` is permissionless and pays the destinations of whatever preimage hashes to the
  cell's key. Is forcing a destination to receive its own money at a moment it did not choose
  a harm we have missed — a destination whose own accounting keys on receipt timing, say?
- **Re-booking under `singleHash`.** A failed share of a multi-destination claim moves to the
  destination's one-destination cell. Confirm `paid + deferred` is always the cell, that the
  total book is not decremented for a deferred share, and that the 200,000-gas cap with the
  `InsufficientGas` guard leaves a caller no way to force a deferral on a destination that
  would have accepted the transfer.
- **The `_termsOk` copy.** `IntentTerms.ok` duplicates `_termsOk` for `ProveReader.available`,
  pinned by a fuzz test. Any rule in one and not the other is a reader that lies about
  fillability.
- 6.9 accepts that a destination that cannot receive its token strands its book
  for ever. Is there a shape where that stranding hurts somebody other than the
  destination's own author?

### 9.2 `WHEN_ABSENT` and the disposal filter

`ProveBatchExecutor.WHEN_ABSENT` (`ProveBatchExecutor.sol:235`) and `_wanted` (`:775`), added
2026-09-02; the disposal filter (`_skipDisposal` at `:374`, `_disposalSkips` at
`:550`, `proveBatchCallback`'s write at `:686`), added 2026-09-04.

`36701c9` closed three defects here, and the fixes are themselves new code:

- `_wanted` now takes `legs` and reverts `LegOutOfRange` when `want >= legs`
  (`:780`); `settleRing` reverts `LegsExceedBatch` when
  `route.legs > reqs.length` (`:437`). Before that, a fallback fired for a leg
  the request never carried, on every ring, spending tokens the settlement was
  about to pull. Confirm the two bounds together are tight.
- A disposal now reads its own `Swap.leg`, through a storage word written in one
  frame and read in another. Confirm `_skipDisposal` is cleared on every path
  that writes it, including the one where `fillBatchWithCallback` reverts, and
  that no ring can read another ring's answer.
- `sellSurplus` reverts `OversizedDisposal` (`:802`) before the venue is called.
  The old argument — the transfer to the sink finds the balance short — held only
  while the executor held nothing but what the ring earned, and one donation
  broke it. Confirm the new check covers every disposal shape, including the
  `NO_PATCH` one that first exposed it.

Still open from the original design:

- The comment claims a normal call and its fallback are "mutually exclusive by
  construction: exactly one of a pair runs". Confirm that holds when the same
  `want` appears in more than two swaps, and when a route pairs `ANY_LEG` with a
  `WHEN_ABSENT` call.
- `ANY_LEG` is `type(uint256).max`, which has the `WHEN_ABSENT` bit set.
  `_wanted` checks `ANY_LEG` first (`:778`), before it masks the bit off at
  `:779`. Is that ordering load-bearing anywhere else?
- Coverage: unit tests only, no fuzz property, no invariant.

`MAX_BATCH_LEGS` still does not exist on chain. It is `sdk/src/solver/plan.ts:119`,
an off-chain constant equal to 8, and nothing in `ProveSettlement` bounds
`reqs.length`. `20e62e4` corrected the comment that used to credit it
(`ProveBatchExecutor.sol:227-231`), so the encoding now has to stand on its own
terms rather than on a cap that was never there.

### 9.3 The credit path in `ProveBatchExecutor` and its callback

`ProveSettlement.fillBatchWithCallback` releases every leg's token A, calls
`msg.sender` once, then pulls every payment. `ProveBatchExecutor.proveBatchCallback`
runs the buy-side swaps in the middle. This is where a maker's money is in a
stranger's contract, and it is the largest thing we would like a second pair of
eyes on.

- `owed.length > route.legs` reverts, but **fewer** lines than planned is
  accepted on purpose. That equality is what used to make a credit batch
  all-or-nothing, and `Payment.leg` is the whole reason the weaker check is
  claimed safe. Is it?
- `_requireSwept` refuses an `owed` token the sweep list does not name. Is that
  sufficient to make `settleRing`'s pre-ring marks cover every payment, given
  `_tokensNamedBy` also pulls in each swap's `tokenIn`, `tokenOut` and `extra`?
- `_oweEveryLine` uses `forceApprove` with a per-token total, because
  `forceApprove` writes an exact value and a second line would replace the first.
  `_earlierLineIn` is the pairwise scan that decides which line writes. Confirm
  the total is exactly what `_collect` takes, so no allowance survives the
  transaction.
- `_increaseAbove` returns the increase over the *first* matching mark. A token
  named twice in a route gets two marks. Which one wins, and does it matter?
- `_creditLeg` writes `filled[h] = booked + req.take` **before** the callback
  runs, and `owed[count].leg = k` is written by the caller's loop rather than by
  `_recordLeg`. Is the compaction of `lines` correct in every skip pattern?

### 9.4 The sink clones

`21a4240` made `ProveCallSink` one deterministic EIP-1167 clone per caller,
salted with the caller's address.

- `_sinkFor` predicts the address and clones only when the predicted address
  holds no code. `Clones.cloneDeterministic` reverts on an address that already
  holds code, so the check is claimed to be required rather than an optimisation.
  Confirm there is no way to occupy a caller's predicted address ahead of them,
  and no way to reach a clone that a different executor's template minted.
- The template is never driven and never holds anything. `run` refuses
  `target == template` (`ProveCallSink.sol:124-129`). Confirm the template cannot be made to hold
  a balance or to grant an allowance.
- The recovery story: a strand rests on the caller's own sink and is spendable
  inside the transaction that recovers it. Confirm that cannot be turned into a
  way to discharge a maker's payment out of somebody else's money.
- The caveat we accept: a caller that is itself a public contract shares one sink
  across its own users. Is there anything the sink could do about that which we
  have not considered?

### 9.5 The RFQ mirror checks

`55091bd` added `MirrorOutlivesTheBinding`, `MirrorIsNotFlat` and
`MirrorNotTakenWhole` (`RfqVenue.sol:423-425`). They have unit tests and **no
invariant** — the venue's five refusal shapes all predate them.

`Exclusive` commits to the quote by hash and to nothing about the mirror, because
the maker signs first. These three checks stand in for a commitment the signature
cannot carry. We want to know whether three is the right number:

- Is there a fourth property of the mirror that a counterparty's acceptance
  leaks? `mirror.flags`, `mirror.startTime`, `mirror.nonce` and
  `mirror.recipient` are checked against nothing in the binding.
  `mirror.executor` is checked against the venue (`RfqVenue.sol:378`), which is what stops
  the acceptance being an ordinary public order.
- `mirrorTake != mirror.amountIn` forces a whole take. Does that interact
  correctly with `Intent.minFill` and with a partial-flagged mirror?
- The three checks are `view` and run before the maker's signature is verified.
  Is there a griefing cost to that ordering, as there was for `_probe`?

### 9.6 Smaller things we are less sure about than we would like

- **`_skipDisposal` is the first storage word a caller directs in a periphery
  contract.** It lives for one transaction and is cleared by the frame that reads
  it. Confirm the clear is unconditional in practice, and that a route whose
  disposals all carry `ANY_LEG` really does read and write nothing.
- **`_probe` runs before the signature check.** A griefer needs no key to reach
  it — 65 zero bytes will do. The gas cap is 30,000 per read and the reads happen
  one at a time. F-3 is fixed, but is 30,000 the right number, and is one word of
  return data enough for every honest token?
- **`_probe` also hides six external calls from Slither, and you should count
  them yourself.** It makes its call in assembly, so Slither's call graph does not
  carry it. Six reads go through it — `_evaluate`'s allowance
  (`ProveSettlement.sol:2860`) and balance on token A
  (`ProveSettlement.sol:2584`) and its probe of token B
  (`ProveSettlement.sol:2710`), `_held` (`ProveSettlement.sol:2672`), and both
  sides of `_deliverTo`'s fee-on-transfer bracket (`ProveSettlement.sol:3006`,
  `ProveSettlement.sol:3012`). Every one is a call to an address a maker chose.
  The effect is measured, not feared:
  the `calls-loop` count on `_deliverTo` fell from three to one the moment
  `1655e35` routed those two reads through `_probe`, and nothing about the
  contract's behaviour changed. **So the static report under-states this
  contract's external-call surface by six**, and any block added to `_probe`'s
  callers later will be invisible the same way. `docs/slither-triage.md` records
  the same thing against the run it describes.
- **`dryRun` arms for real and always reverts.** Nothing survives, so there is no
  access control. Confirm that is true — in particular that `_walkLeg`'s
  `filled[h]` write and `_release` cannot escape the revert on any path,
  including a token that re-enters.
- **`_validSignature` staticcalls a maker's wallet under a 60,000 gas cap.** Is
  that enough for a real ERC-1271 account (a Safe, an ERC-4337 account) and
  little enough to stop a griefer?
- **Permit2 nonces are derived from the intent hash.** `_pullPermit2In` requires
  `p.nonce == uint256(i.authNonce ? i.authNonce : h)`. Permit2 nonces are an
  unordered bitmap: word `nonce >> 8`, bit `nonce & 0xff`. Does deriving one from
  an intent hash create a collision or ordering hazard, given the maker can also
  name `authNonce` and deliberately collide two intents? Confirm too that
  `_pullPermit2`'s promotion of the signature into a reservation
  (`ProveSettlement.sol:2144-2145`) is
  complete: a maker who signed `p.amount > i.amountIn` keeps the difference, and
  `withdraw` returns whatever the intent did not fill. And `sdk/src/solver`
  partitions candidates by `(maker, tokenIn)` "because permit nonces are ordered
  and a maker's balance is shared" — right for EIP-2612 and wrong for Permit2.
  Does any on-chain code depend on that reasoning?
- **Rounding directions in `_quote`, which `d1dd385` reversed.** The three lines
  are now `gross = ceilDiv(take * minOutAt, amountIn)`,
  `fee = (gross * _rateOf(i)) / WAD` and `delivered = gross - fee`. We believe
  `gross` rounds in the maker's favour, and that `fee` now floors, so the dust of
  the split stays with the maker rather than reaching the destination — which is
  the reopening 6.10 discloses. `minOutAt` truncates inside a subtraction, which
  biases the current minimum upward and so also favours the maker. Check the
  claims rather than the sentences: that the split of a fill never pays the maker
  less at any split of `amountIn`, that `delivered + fee` is the gross exactly at
  every rate, that `fee <= gross` holds for every input `_termsOk` admits so the
  subtraction cannot underflow, that `ts <= startTime` and `ts >= endTime` are
  the right clamps, and that `_ceilDiv` cannot overflow given `_termsOk`'s
  `uint128` caps.
  `_rateOf` folds `feeTo == 0` to a rate of zero and is shared by `_evaluate` and
  `_quote` so the declared and effective rates cannot disagree — confirm there is
  no third site that prices a fee.

---

## 10. Where a document and the code disagreed

We wrote this section so you do not have to rediscover any of it. In every case
below the code is right. Rows marked **fixed** were corrected before this edition
landed, and are kept because a reader should see that they were decided rather
than that they vanished.

| Claim | Where | Truth |
|---|---|---|
| "`MAX_WALLET_WINDOW`, one `hour`" | `docs/ROADMAP.md:41`, `README.md:81`, `docs/README.md:47`, `sdk/README.md:86` and `:124`, `RfqVenue.sol:113` | The constant and both `_termsOk` bounds were deleted in `a7c5d7f`. Nothing on chain `bounds` a window at either end. All six were corrected in the commit that carries this document. `docs/FEE-MODEL.md` had it right already, and at `:171` it states the general rule the mistake broke: every `quantity` is either signed or live, and mixing them is the bug |
| "`MAX_WALLET_WINDOW` bounds the exposure to one hour" | earlier editions of this document, as the mitigation for a maker revoking an allowance after a solver has priced the fill | **That risk now has no on-chain mitigation.** Section 4 says so |
| "every finding is fixed, and each one has a test that fails if it comes back" | `app/src/i18n/en.ts:1483`, `landing.control.audit` | True of the security review, false of the economics review: four of six, with F-5 open by design and its test asserting that the attack works. **Corrected on 2026-09-09**, in English and in all 34 translations. The page now names F-5 as open by design and as one of the eleven limits in section 6 |
| "A regression test for each" of six economics findings | `docs/ROADMAP.md:355-357`, `README.md:100-103`, design spec §12.1 | Four fixed, one withdrawn (F-4), one open by design (F-5). The roadmap now exempts the three `FeeSink` findings and still implies the other nine are defended. §12.1 also says "Every `F-` finding is fixed", which is false |
| "the EIP-712 fixture … the TypeScript suites assert against it" | `docs/ROADMAP.md`, and earlier editions of this document | Only the SDK suite. Three files in `sdk/src`; nothing in `app/src` |
| "The fixture pins twelve things" | earlier editions of this document | It pins **eleven**, counted off the JSON's own top-level keys, and the list printed beside the old number had fifteen entries. One of those fifteen was `MAX_WALLET_WINDOW`, which went with `a7c5d7f` |
| "The four custody `rungs`"; "8 token behaviours across 4 custody rungs" | `docs/ROADMAP.md:38`, and its test section | There are **five**. The permit2 rung landed in `7f4620c` and its matrix column in `21ecf08`; the roadmap's list never gained it, so the matrix line inherited the same miscount. **Fixed on 2026-09-15**, as a pair: `docs/ROADMAP.md:38` now lists five rungs and `:351` reads "9 token rows across 5 custody rungs, 51 tests". `TokenMatrix.t.sol`'s own header table holds nine rows against five columns, and `forge test --list` declares 51 tests in that file |
| "the committed `contracts/lcov.info` (2026-09-01, at commit `a26a4ce`)" | earlier editions of this document | It is **not committed and never was**. `.gitignore:51` ignores it. Run the gate; it measures fresh |
| "`prove-yul-runs.py` … would report a false negative … Not in CI" | earlier editions of this document | **Fixed.** It searches for each block by file and function, runs in a throwaway worktree, fails on an unclaimed `assembly` block, and is a CI step of its own |
| "148 tests fail" for `_probe`, "2 tests fail" for `_write` | `contracts/tools/prove-yul-runs.py`, its docstring | **Both doubled.** It counted `^\[FAIL` lines, and `forge test` prints each failure twice — inline, and again in the `Failing tests:` trailer. Measured on 2026-09-04: two failing tests, four matching lines. **Fixed** — the tool now reads forge's own summary line. Re-measured the same day on the whole suite: **76 for `_probe`, 2 for `_write`**, so the 148 stood for 74. `_probe` read **287** after `1655e35` put every fill's delivery through it, **291** after the fee split, and **295** re-measured on 2026-09-08 for this edition. `_write` was defended by a single test until `test_ADisposalRefusesAPriceBelowItsScaledBound` landed that morning. The control always worked — one failure is non-zero — but every margin it advertised was double |
| "The sink is protected by obscurity, and the header says so" | earlier editions of this document, citing `ProveExecutor.sol:76` | **Fixed in `21a4240`.** One deterministic clone per caller. `ProveExecutor.sol:75-79` now says the opposite: predicting the `address` is easy and worthless |
| "Whatever the caller forgets to name is theirs to lose" | earlier editions of this document | A strand on the **sink** rests on the caller's own clone and their next call sweeps it home. A strand on the **executor** is still permanent |
| "over-ask and the frame catches the revert" | earlier editions of this document | `sellSurplus` reverts `OversizedDisposal` before the venue is called (`ProveBatchExecutor.sol:802`). `36701c9` |
| "No storage any caller can direct" on the periphery contracts | earlier editions of this document | `ProveBatchExecutor._skipDisposal` (`:374`) is one, written from the caller's own route and cleared inside the same transaction |
| "The three sites that read `FLAGS_CUSTODIED` are `_evaluate`, `_release` and `_termsOk`" | earlier editions of this document | They are `fillWithPermit` (`:1838`), `_evaluate` (`:2705`) and `_release` (`:3034`). `_termsOk` stopped reading the composite constant when `a7c5d7f` deleted the window bounds |
| "the gain … `sweepUnowned` hands it to the fee sink" | `ProveSettlement.sol:624` | **Fixed in `20e62e4`**, which left the correction in place at `:624-629` |
| "This is the one place in `src/` that still uses assembly" | `ProveSettlement.sol`, in `_probe`'s NatSpec | **Fixed in `20e62e4`.** The text sits at `:2748-2750` and names both blocks |
| "the only owner-gated function on this contract" | earlier editions; removed code | **Fixed in `20e62e4`**, moved again by `4d48379` (three owner-gated functions), and gone on 2026-10-03: the settlement has no owner at all. `docs/ROADMAP.md:62` said "The one owner surface is `setDefaultProceeds`" until 2026-09-23, and now names all three |
| "`MAX_BATCH_LEGS` caps at eight" | `ProveBatchExecutor.sol:229` | **Fixed in `20e62e4`**, at `:227-231`. No such constant exists on chain. It is `sdk/src/solver/plan.ts:119` |
| "`_wanted` answers 'unconditional, or the leg settled' and there is no inverse" | `ProveBatchExecutor.sol`, `settleRing`'s `@param skipInvalid` block | **Fixed in `20e62e4`**, at `:411-414` |
| "`intentHash` … commits to every one of its fourteen terms" | `RfqVenue.sol:105` | **Fixed in `20e62e4`**, then stale again at sixteen when the curve landed. `INTENT_TYPEHASH` has seventeen fields and the comment says seventeen. `test_TheTypehashStringIsTheOneEveryWalletWillHash` now pins the string itself |
| "The four ways an intent is backed. `ProveSettlement`'s header names them" | `TokenMatrix.t.sol:135` | **Fixed.** `:135` now says five, and the matrix tests five |
| "542 contract tests — 528 that run"; "33 fuzz properties"; "the six Yul lines in `_probe`"; "`_settle` re-prices"; "the surplus rests reserved to nobody" | `docs/ROADMAP.md` | **All fixed in the roadmap itself.** It now records thirty-nine fuzz properties, two Yul blocks, and four constructor guards forge counts since 2026-09-15, the deep `_evaluate` inside `_armLeg`, and a sweep that pays `defaultProceeds` |
| "529 contract tests — 519 that run" | `docs/ROADMAP.md`, earlier editions | **621 total, 611 running.** The roadmap has caught up and now prints the same pair. Its own rule was always right — read the number off `forge test`'s summary line — and the number under it has moved eight times: 543 at `36701c9`, 557 at `1655e35`, 562 at `d1dd385`, 577 at `78e0ef4`, 579 after the deploy-guard tests, 608 before the nonce lanes, 621 at that edition, 645 on 2026-09-15 and 679 on 2026-09-23 |
| "Netting's payoff is avoided slippage, not avoided gas" | `docs/ROADMAP.md`, earlier editions | **The slippage is already avoided.** `test_ATwoLegRingSettlesFromAnAddressHoldingNothing` settles a two-leg coincidence with no venue, and `RfqVenue` does it again for a named counterparty. Netting's marginal payoff is gas and attack surface, about a sixth of a cent for a whole cross. Established in `docs/specs/2026-09-08-netting-a-coincidence-of-wants.md`, Part 5, and the roadmap now says so |
| "A fill costs about a cent of gas here" | `docs/ROADMAP.md`, earlier editions | **About four hundredths of a cent**, at 124,975 gas — `app/src/landing/gas.ts`, "fill, allowance, warm", written out of `Gas.t.sol` and compared by CI. The same warm figure read 33,175 before the curve, the booked fee and the parked source landed, so any claim quoting a ratio against an on-chain measurement is comparing two builds |
| "A rebase up strands the gain … reserved to nobody" | the comment above `test_ARebaseUpStrandsTheGainInsideTheContract` | `sweepUnowned` reaches the surplus and pays `defaultProceeds`. The test's assertions still hold because it never sweeps; the title and the prose around them do not |
| "Eight `campaigns` of sixty-four calls is the budget this file spends" | `ExecutorInvariants.t.sol:33` | Eight is right. Depth has been 256 since the `foundry.toml` change |
| "all fourteen fork tests reported green while asserting nothing" | `Fork.t.sol`, `Live369.t.sol` | Thirty fork tests exist now, in six suites, and every one of them skips honestly without an endpoint. `ForkBuyAndBurn.t.sol`'s two were the last pair that did not, and they have called `vm.skip` since 2026-09-09 |
| Design spec §12.1 line numbers into `EconAudit.t.sol` | `2026-08-10-prove-cash-design.md` | Every citation has rotted. It also names the fee bound `maxFeeBps`; the contract calls it `maxFeeRate`, a fraction of 1e18 |
| "The filler pays the fee on top of the maker's minimum"; "`minOut` is a net guarantee" | earlier editions of this document, `docs/ROADMAP.md`, `app/scripts/e2e/callback.ts`, `landing.control.where.fee` | **Inverted by `d1dd385`.** The maker signs a gross, `_quote` floors the fee out of it, and the filler's outlay is that gross at every rate. The maker's guarantee is `gross - fee`. Section 1 and 6.10 carry the whole of it |
| "There is no ceiling on `Intent.feeRate`" | earlier editions of this document, and `ProveSettlement.sol`'s own `feeRate` NatSpec before `d1dd385` | `_termsOk` refuses `feeRate > WAD` (`:2486`). Above 100% the split's subtraction panics, and a panic is not a `Reason` |
| "`_termsOk` now checks exactly five things", then "six" | earlier editions of this document | **Eight.** The rate ceiling made six, at `:2565`. `4d48379` added the registered sink and its floor, at `:2569-2573` |
| "`TheDestinationEarnsOnEveryFill`" | earlier editions of this document, section 5 and 6.4 | Renamed `TheDestinationEarnsExactlyTheRateOnTheGross` in `d1dd385`, because the destination no longer earns on every fill — a floored fee on a small enough gross is nothing |
| "the fee rate never reaches the maker's proceeds" | earlier editions of this document, describing `Custody.t.sol` | **Exactly backwards now.** The property is `testFuzz_TheFeeRateNeverReachesTheExecutorsOutlay`. The rate reaches the maker's proceeds by design; what it must never reach is the filler's outlay |
| "`test_E5_ADustFillStillPaysTheFee`" | earlier editions of this document | Renamed `test_E5_ADustFillPaysNoFeeAndTheMakerKeepsTheWei`, and it asserts the opposite. See 6.10 |
| "A quote with no spread cannot pay for its exclusivity" | `RfqVenue.t.sol`, before `d1dd385` | **Inverted.** The fee comes out of the quoting maker's own delivery, so a zero-spread ring closes. `test_AQuoteWithNoSpreadPaysForItsOwnExclusivity` (`:1004`) records it, and section 4 says why it was accepted |
| Ten test names across six files | earlier editions of this document, and any list sent before 2026-09-05 | `d1dd385` renamed them and every rename inverts the old claim. Section 8 tabulates all ten |
| "all 14 `Reason` members" | earlier editions of this document, the fixture table | **Fifteen.** `1655e35` appended `TokenOutUnreadable` at 14 |
| "30 fuzz properties", then "33" | earlier editions of this document | **39.** `d1dd385` added three and `78e0ef4` added six more, all of them in `Curve.t.sol` |
| "`--list` declares 589 against a run of 547", then "604 against 562", then "663 against 621", then "664 against 622", then "687 against 645" | earlier editions of this document | **722 against 679**, on 2026-09-23. The gap is 43 now, because the invariant count went from 46 to 47. Its cause is unchanged |
| "854/861 lines, 185/189 branches, 124/124 functions across six `src/` files and six `script/` files", then "917/924, 201/205, 131/131", then "934/941, 205/209, 132/132", then "982/989, 214/218, 139/139", then "996/1003, 220/220, 141/141" | earlier editions of this document | **1056/1063 lines, 234/234 branches, 147/147 functions, across seven `src/` and eight `script/` files**, measured by `tools/coverage-gate.py` at this tree on 2026-09-23. The gate's own docstring still says 220 branch records. Branches reached 220/220 on 2026-09-15, when a factory contract made forge count the four constructor guards it had forgiven. Functions read 130/132 mid-refresh, because `3a556e6` left two of them uncalled; two tests in `Deploy.t.sol` call them again — section 8 |
| "`contracts/script/` (6 files) 592 lines", then "832 lines", then "858", then "7 files, 853 lines" | earlier editions of this document | **8 files, 982 lines.** `Guards.sol` is the seventh, and `335f9d9` reformatted it to 221. `DeployFeeSink.s.sol` is the eighth, and `4d48379` also grew `Deploy.s.sol` |
| "The fixture pins eleven things … the only count that cannot drift" | earlier editions of this document, and this one | Eleven is right about what is pinned, but the JSON has **twelve** top-level keys. The twelfth is `_comment`. A reader who counts keys gets twelve |
| "`mirror.executor != address(this)` (:377)" | earlier editions of this document, sections 4 and 9.5 | `RfqVenue.sol:378`. 377 is the closing `*/` of the comment above it, and it has been off by one since `55091bd` |
| "`_wanted` checks `ANY_LEG` first (`:779`)" | earlier editions of this document | `:778`. `:779` is the line that masks `WHEN_ABSENT` off |
| Every line number into `ProveSettlement.sol` | earlier editions of this document | `1655e35` and `d1dd385` moved the file by 149 lines, `78e0ef4` by 193 more, and `8b7d92a` and `1844073` by 401 between them. Every citation past 400 went with them each time. All of them are re-anchored, and `tools/check-citations.py` fails CI if one drifts again |
| Two incompatible `F-` numbering schemes | `2026-08-14-checkpoint.md:146-148` vs `EconAudit.t.sol` | The checkpoint's F-2 is an `SDK` approval bug; the review's F-2 was the `FeeSink` floor. The checkpoint also claims F-3 to F-7 are all fixed, and there is no F-7 |
| "`master` differs from testnet 943 by nine behavioural changes"; then "they are one tree" | earlier editions of this document | Both were true when written and neither is now. 943 was redeployed from `78e0ef4` on 2026-09-05 and the two trees matched for three days. `8b7d92a` and `1844073` parted them again on 2026-09-08, and `master` is four commits ahead. Section 3 carries three rows now, not two |
| "`Intent` has sixteen members"; "the fixture pins three points on the decay curve" | earlier editions of this document | **Seventeen and ten.** `78e0ef4` added `curve`, and `Fixture.t.sol` samples a `KIND_STRETCH` curve at ten instants because the kind bits are private and nothing else can read them off the contract |
| "`sweepUnowned` subtracts `_totalPendingFees`" | earlier editions of this document, four places | The subtraction is in `sweepUnowned` (`ProveSettlement.sol:1360-1360`) and the two books are added in `_book1` (`:2937-2940`). Every one of the four cites the range |
| "A local gate run … exited zero"; "Every other line, branch and function in `src/` and `script/` is covered" | earlier editions of this document | Right again, but only since this refresh. `3a556e6` left twelve items uncovered in `contracts/script/Guards.sol` and the gate exited 1 for four days. Two tests in `Deploy.t.sol` close it — section 8. Nothing under `contracts/src` was ever uncovered |
| "13 actions" in `SettlementHandler`, "Eight actions" in `AwkwardHandler` | earlier editions of this document | **Fourteen and nine.** Both lists dropped `claimFees`, which `36701c9` added with the fee book |
| "thirteen known holders" | earlier editions of this document, `invariant_TokensAreConserved` | **Fourteen.** The count left the sink out |
| "33 fuzz tests at 512 runs is 16,896 fuzz executions" | earlier editions of this document | **58,944.** 37 run at 512 and two run at 20,000, which they ask for themselves with a `forge-config` line |
| "Six contracts, 4,780 lines"; "`ProveSettlement.sol` 2,722"; "36 `*.t.sol` files, 25,188"; "`Mocks.sol` 1,092"; handlers and tokens "4,117" | earlier editions of this document, section 2 | **5,387 across seven contracts; 3,210; 42 and 30,087; 1,087; 4,262.** Every one re-measured with `wc -l` at the tree this edition pins, not adjusted from the old number. The edition of 2026-09-16 read 5,271 across six; 3,130; 40 and 28,797; 1,087; 4,260. The pair "5,181; 3,123" was right at `02589045` and the total "5,272" at `432216ca`; `c28c5aa` then dropped one line from `ProveBatchExecutor.sol` and nobody re-ran the command. This edition's test pair was measured at `a0bb95e` |
| The pinned `contracts/src` tree, `b003eb80`, then `ee4bcd27`, then `90331506` | earlier editions of this document | Four commits moved the tree after `b003eb80` was written and `git rev-parse HEAD:contracts/src` stopped agreeing. `8efa7d2` then rewrote the opening to `ee4bcd27`, its own tree, beside a sentence still naming `7f74fd4` — whose tree is `02589045`, the hash the section 3 table kept. So the document disagreed with itself for five commits, and no gate read a hash then. Re-pinned to `90331506` on 2026-09-16, after five commits: `8efa7d2` (the Unlicense header), `4f67e4d` (`_payFee` books what arrived), `bf416e7` (gas figures in comments), `4ba9a66` (`sinkTemplate` and `ProceedsNotHere`) and `c28c5aa` (a dead return). Re-pinned to `682a2e74` on 2026-09-23 for the fee-sink work, and `tools/check-tree-pin.py` now fails CI on a stale pin. The mechanism worked exactly as it promised each time: the control said the document was out of date, and it was |
| "`.gitignore:37` ignores `lcov.info`" | earlier editions of this document, two places | `.gitignore:51`. The citation gate never caught it, because `.gitignore` carries no extension the gate's patterns recognise. Both are corrected here; the gate still cannot read that form |
| The whole 943 column of `docs/ADDRESSES.md` | that page, before 2026-09-09 | It named the 2026-09-01 set, of which `contracts/deployments/943.json` says "Point nothing at them". An operator following that page would have pointed a bot at a retired settlement. Corrected from the record and confirmed on chain |
| "`Intent` went fourteen fields to sixteen; `hashIntent` is `0xec38b9f7`" | `docs/ADDRESSES.md`, the bots section | **Seventeen, and `0x6820d6d4`.** `78e0ef4` added `curve` and the selector moved a third time |
| "Three invariant campaigns"; "73 Slither findings"; "seven can / ten cannot"; "nine accepted limits"; "a 24-row table"; "the word vulnerability appears zero times" | the internal risk assessment, before 2026-09-09 | Four; 81; ten can and seventeen cannot for the solver, nine and nine for the maker; eleven; 61 rows; and the word appears in that report, in this row, and in one design spec. That document is now under `tools/check-citations.py` too |
| "`ProveSettlement` has two owner-gated functions, not one"; "The two functions above are the whole owner surface" | earlier editions of this document, section 4 | **Three** since `4d48379`: `registerFeeSink` joined `transferOwnership` and `setDefaultProceeds`. It can add a fee sink and can never remove or change one |
| "`claim` is permissionless and always pays `feeTo`, which is the map key" | earlier editions of this document, sections 4 and 9.1 | `claim(sink, token)` pays `feeSinks[sink].destination` since `4d48379`, and reverts `BadParameter` for an address that is not a registered sink |
| "An offer that names no destination charges nothing" | earlier editions of this document, section 1 | A zero `feeConfig` charges nothing, and a rate above zero with `feeConfig = 0` is `BadTerms_` since 2026-10-03 (`_termsOk`) |
| "None of the three is built", of the two token allowlists and the destination `whitelist` | earlier editions of this document, 6.7 | The destination list is built, on chain, as the fee-sink registry. The two token allowlists are still not built |
| 32 line citations into `contracts/src` and `contracts/test` | earlier editions of this document, sections 1, 4, 5, 6, 7 and 8 | Each pointed near what it named, not at it: a test cited a few lines above its declaration, an invariant cited at a neighbour's line, and `claim` cited sixty-four lines above its declaration. `check-citations.py` passed all of them, because it pools the candidate words of a whole paragraph or table row. Re-aimed on 2026-09-23 to the declaration each one names |

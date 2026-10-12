# Audit readiness — prove.cash contracts

Read this before you scope the work. `docs/AUDIT-SCOPE.md` says what the
protocol does and how it is built. This document says what we can hand you, what
we cannot, and where we think your time is worth the most.

It is written to be checked. Every number below names the command that produced
it. **Update 2026-10-03: the fee config change.** The contract set, sizes, owner surface and fee model
changed on `feat/fee-config-hash`, merged to `master` at `fa1c696` on 2026-10-05. Section 1 (line
counts and sizes), the test counts and the coverage in section 2, and the Slither run were all
re-measured on 2026-10-05 at the pinned tree. The gas table did not move (a warm allowance fill
is 124,975 gas, a twenty-leg batch 64,227 per intent; `app/src/landing/gas.ts`). Slither 0.9.6
reports 125 findings across 17 detectors, none confirmed: 51 mitigated and 74 false positive,
each with a verdict in `docs/slither-triage.md`. On 2026-10-06 the coverage figures and the
`prove-yul-runs.py` margins in section 2 were re-run (351 / 5 / 13 / 25 / 24×4), and each Yul
block's assumptions and safety margins (memory, bounds, gas) were measured and written up in
`docs/AUDIT-SCOPE.md`, "The Yul blocks' safety margins".
`docs/FEE-MODEL.md` and
`docs/specs/2026-10-03-fee-config-hash.md` describe the new model, and the internal backlog
lists what is still to do before an audit.

The set was re-run on 2026-09-09 against `HEAD` at `7f74fd4`. The test
counts, the coverage, the line counts and the tree pin were re-run on 2026-09-23
against `a0bb95e` on `feat/fee-sink-fixed`, whose `contracts/test` tree is
`3d64ab7f`. That branch adds the fee sinks to `master`, and `master` still
carries the tree this document pinned before. Where this document and another
document disagree, run the command.

**The tree under audit** is `contracts/src`, git object id
`09c2233a7f1ab75ed02e6d37772559f7beaef050`. Confirm it in one command:

```
git rev-parse HEAD:contracts/src
```

---

## 1. What is in scope

Thirteen files, 6,790 lines, since the fee config change of 2026-10-03 (`feat/fee-config-hash`,
merged at `fa1c696`; re-measured 2026-10-05). Eight of them deploy on their own; `FeeClaimLib` deploys as a linked library;
the rest are inherited or called as internal code. Nothing in `contracts/src` is out.

```
wc -l contracts/src/*.sol
```

| Contract | Lines | What it holds |
|---|---|---|
| `ProveSettlement.sol` | 3,081 | Every escrowed balance, every parked balance and every booked fee, keyed by fee config hash. **No owner, no setter.** Runtime 23,427 B, 1,149 B under EIP-170 |
| `ProveReader.sol` | 695 | Nothing. The read views, including `available`, which left the settlement. 22,225 B |
| `ProveBatchExecutor.sol` | 966 | Nothing between transactions. One storage word for one transaction |
| `RfqVenue.sol` | 529 | Nothing. A `spent` bit per binding |
| `ProveExecutor.sol` | 348 | Nothing between transactions |
| `TakePoints.sol` | 227 | Nothing. Pure pricing of the three take points and the callback `Terms` |
| `FeeDefaults.sol` | 195 | Advisory fee defaults and their append-only history. **The one owned contract**; reaches no funds. The settlement never reads it |
| `ProveCallSink.sol` | 166 | Nothing. It sweeps itself empty before it returns |
| `ProveRelayer.sol` | 163 | Nothing. It holds every allowance and can only pull |
| `FeeConfig.sol` | 128 | Nothing. The config struct, its validity rule and its EIP-712 hash |
| `IntentTerms.sol` | 122 | Nothing. A **copy** of the settlement's `_termsOk` for the reader, pinned to it by a fuzz test |
| `FeeClaimLib.sol` | 116 | Nothing, no storage. `claim` and `announceFeeConfig`, reached by `DELEGATECALL` from the settlement |
| `FeeConfigView.sol` | 54 | Nothing. Pure config math shared by the defaults and the reader |

**New trust surface: the library.** `FeeClaimLib` runs in the settlement's storage context. Its
address is fixed in the settlement's bytecode at link time, it has no `SELFDESTRUCT` and no
`DELEGATECALL` (`FeeClaim.t.sol` checks the deployed bytes), and a wrong link is caught by
`Deploy.t.sol`, which sweeps and claims through the deployed settlement. **The link changes the
settlement's runtime bytecode, so every bytecode pin must be regenerated after the deploy.**

**That total read 6,764 in the first edition after the change, and 5,563 until 2026-10-03** (seven contracts, with `FeeSink.sol`, which is gone).
It read 5,387 until 2026-10-01 and 5,271 until 2026-09-23.

**The money is in one contract.** That is the shape of the design, and it is why
section 6 ranks the settlement first.

### Deliberately out

| Path | Lines | Why |
|---|---|---|
| `contracts/src/interfaces/` — 10 files | 462 | Type declarations. No `contract`, `library` or `abstract` in any of them, so nothing there is deployed |
| `contracts/script/` — 7 files | 968 | Deploy scripts. They run from a developer machine, never on chain. The coverage gate measures them anyway, and they are at 100% |
| `contracts/test/` — 47 `*.t.sol` files | 31,827 | Tests. Read them as evidence, not as code to review |
| `contracts/test/Mocks.sol`, `Fees.sol`, `handlers/`, `tokens/` | 1,057, 111 and 4,355 | Mocks, fee-config helpers, fuzz handlers and mock tokens |
| `contracts/lib/` | — | OpenZeppelin and forge-std, as git submodules |
| Permit2 | — | `0x000000000022D473030F116dDEE9F6B43aC78BA3`, Uniswap's canonical deployment. We deploy nothing there |
| `sdk/`, `app/` | — | TypeScript. Neither can move a token that a contract does not let it move |

---

## 2. What the tests prove, and what they do not

### The three numbers, and the commands that made them

```
cd contracts && forge test
cd contracts && python3 tools/coverage-gate.py
```

**748 tests, of which 726 run** (re-run 2026-10-06 on `master`). `forge test`'s own summary
line reads: "Ran 53 test suites in 287.36s (1019.50s CPU time): 726 tests passed, 0 failed, 22 skipped (748 total tests)". Read the number off that line and off nothing else.
`forge test --list` declares 790, because it counts each `invariant_` function
where the run counts each campaign. Counting `[FAIL` lines gives exactly double,
because forge prints every failure twice.

**The twenty-two that skip are the chain tests.** `Fork.t.sol` holds 2,
`ForkBuyAndBurn.t.sol` 2, `Fork369Rehearsal.t.sol` 4,
`Fork369RealTokens.t.sol` 11 and `ForkMultiHop.t.sol` 3. `Live369.t.sol` was deleted with the
fee config change and is rewritten after the redeploy. Each bails through a `_boot()` helper that calls
`vm.skip(true)` when `PULSECHAIN_RPC` is unset. So a run without an endpoint
proves nothing about a chain, and it says so rather than reporting a pass.
Section 3 is about that gap.

**100% of every line, branch and function `forge coverage` can instrument.** The
gate prints "OK" and lists what it forgave. Two precisions matter:

- **It forgives 23 items, and all 23 are Yul lines** (run of 2026-10-06: 1,583 of 1,606
  lines, 327 of 327 branches, 213 of 213 functions). Six are in `ProveSettlement._probe`,
  one in `ProveBatchExecutor._write`, three in `FeeClaimLib._tryTransfer` and thirteen in
  `ProveReader`'s three bounded-call blocks. It forgave seven before the fee config change,
  and eleven until 2026-09-15, when four constructor guards went because a factory
  contract deploys through an ordinary CREATE instead of the `deployCode`
  cheatcode. Every forgiven block is a `prove-yul-runs.py` target, the control that stands in
  for the counter.
- **Statements are not gated.** The gate reads three LCOV record types — `DA:`,
  `BRDA:` and `FNDA:` — and statements are none of them. The same run's summary
  table reads 98.77% of statements (2,087 of 2,113) on 2026-10-06. Nothing fails on that
  number.

**The Yul has a compensating control, and it runs nightly rather than on a pull
request.** `contracts/tools/prove-yul-runs.py` breaks each forgiven block on
purpose and counts the tests that then fail. Run on 2026-09-09, before the fee config change
added five blocks: **312 tests fail when `_probe`'s first statement is broken, and 2 when
`_write`'s is.** Re-run 2026-10-06 (eight targets, all run by the suite): **351 for `_probe`,
5 for `_write`, 13 for `FeeClaimLib._tryTransfer`, 25 for `ProveReader._read` and 24 for each
of the other four reader blocks.** The new margin tests widened every figure. What each block
assumes, and how much room it has, is in `docs/AUDIT-SCOPE.md`, "The Yul blocks' safety
margins". That is a
stronger statement than a coverage counter makes — a counter says a line ran,
this says the suite would catch it if it stopped working. It proves the block is
*entered*, not that every statement in it earns its place.

It is the `yul` job of `.github/workflows/soak.yml`, at 04:00 UTC. It is **not**
a step in `.github/workflows/ci.yml`; it was moved out because it cost 22m49s of
the pull-request job. Read the two figures as a margin: the suite fuzzes without
a fixed seed, and `_probe`'s number moves with the suite — 295 on 2026-09-08,
312 today. Two is thin and it is not noise; `_write` has one caller.

### The shape of the suite

```
grep -ho 'function testFuzz_[A-Za-z0-9_]*' contracts/test/*.t.sol | wc -l
grep -ho 'function invariant_[A-Za-z0-9_]*' contracts/test/*.t.sol | wc -l
```

39 fuzz properties and 47 invariant properties in 4 campaigns. Section 5 of
`docs/AUDIT-SCOPE.md` lists every invariant with its line and its claim.

### What the numbers do not prove

- **Coverage is a claim about lines, not about assertions.** A line that ran is
  not a line whose behaviour anybody checked.
- **`fail_on_revert = false` in both invariant profiles.** A handler call that
  reverts is discarded rather than failing the campaign, so a campaign can be
  green while an action reverted on every call. The four
  `invariant_CallSummary` receipts exist to make that visible. Read them.
- **No invariant drives a non-zero `curve`.** Every handler signs
  `curve: bytes32(0)`, so the four campaigns price the straight line and never
  the stretch. The field's whole cover is `contracts/test/Curve.t.sol`.
- **No invariant drives `WHEN_ABSENT`, the disposal filter or the three RFQ
  mirror checks.** All three have unit tests only.
- **Every token in the suite is a mock.** They model a lot — fee-on-transfer,
  silent returns, `false` returns, rebasing up and down, non-18 decimals,
  EIP-2612, EIP-3009, ERC-7598 and four shapes of ERC-1271 wallet. They do not
  model a pausable token, an upgradeable token, a governance token with delegate
  checkpoints, or USDT's approve race. And `MockPermit2` implements
  `SignatureTransfer` only, with no version string in its domain.

---

## 3. What has never been exercised against a chain

**The real-chain surface is thirty tests in six suites.** `Fork.t.sol`
runs two fills against real WPLS, real PLSX and the real PulseX v2 router at a
pinned mainnet block. `ForkBuyAndBurn.t.sol` runs two tests against PulseX's own
buy-and-burn, which each chain's stray config names; both of those suites
test somebody else's contract. `Fork369Rehearsal.t.sol` adds four that deploy
this source from `config/369.json` onto a fork of 369 and settle through it.
Since the fee config change that deploy also links `FeeClaimLib`, builds the settlement with
the chain's stray config and deploys `FeeDefaults`.
`ForkMultiHop.t.sol` adds three that sell through two- and three-hop PulseX
routes via `ProveExecutor`.
`Fork369RealTokens.t.sol` adds eleven that fill against real HEX at eight
decimals and real bridged USDC and USDT at six, on the real Permit2.
`Live369.t.sol` holds eight tests against the deployed mainnet bytecode and is
excluded from CI by name, because mainnet runs the 2026-08-22 set and `master`'s
`Intent` carries seventeen fields that deployment cannot decode.

**Testnet 943 was redeployed on 2026-09-09.** `node tools/verify-bytecode.mjs
943`, run on 2026-09-16, exits 1: three contracts differ in code, four are the
same program from a different build. Nothing was redeployed; `master` moved.
`docs/ADDRESSES.md` has the verdict per contract, and `docs/AUDIT-SCOPE.md`
section 3 the summary. Every feature below is deployed somewhere, which closes
less than it looks like. **A deployment is not a test, and a testnet is our
own bots trading our own tokens.** Two rings settled through the new set
within four minutes of cutover; nothing else has exercised it.

| Feature | On 943? | On 369? | Chain test? | What a unit test cannot reach |
|---|---|---|---|---|
| **Parked capital** — `park`, `withdrawParked`, `ARM_FROM_PARKED`, `_drawFromParked` | Since 2026-09-09 | No | None | A real `block.timestamp` deciding whether an intent is dead; the three-book subtraction in `sweepUnowned` against a token whose balance moves outside the contract; whether a real RPC's `getLogs` window returns the `Parked` events the app reads |
| **The keyed nonce floor** — `laneFloor`, `_retired`, per-lane `invalidateBefore` | Since 2026-09-09 | No | None | A nonce produced by a real wallet rather than by a test. Every archived intent this repository has ever produced sits in lane 0, so no real signer has driven a second lane |
| **The RFQ mirror checks** — `MirrorOutlivesTheBinding`, `MirrorIsNotFlat`, `MirrorNotTakenWhole` | Yes | No | None. No fork or live test fills through `RfqVenue` at all | A real counterparty signature, from an EOA and from a contract wallet; the two-leg release against real tokens at a real pool price |
| **The disposal filter and `WHEN_ABSENT`** — `settleRing`, `sellSurplus`, `_skipDisposal`, `_wanted` | Yes | No | None. The word `settleRing` appears in no fork or live test | A storage word written in one frame and read in another under real re-entrancy; a real venue's actual output against a planned disposal size; the real gas of the fallback path |
| **The per-caller sink clone** — `_sinkFor`, `Clones.cloneDeterministic` | Yes | No | None. `Fork.t.sol` never builds a `master` executor; it drives a mock. `Live369.t.sol` drives the old pre-clone singleton | Real CREATE2 address prediction, the first-mint cost, and whether the saving on the second entry holds |
| **Fee configs** — `feeConfig` hash, the three take points, `claim` through the linked `FeeClaimLib`, `FeeDefaults`, `ProveReader` | No | No | None yet. `Live369.t.sol` was removed because it attached to the old deployed instances; the fork suites build fresh contracts. Nothing has been deployed with the library linked | The real `DELEGATECALL` into a deployed library on 943 and 369 (the unit tests link it in the test EVM); a real buy-and-burn receiving a multi-destination `claim`; a destination that reverts or burns gas against a real token; a wallet rendering a 19-field typehash with a nested `FeeConfig`; `ProveReader.available` against a deployed settlement |
| **The price curve itself** — `FLAGS_CURVE_KIND`, `KIND_STRETCH`, `_stretchAt` | Yes | No | Partial. The seventeen-field typehash is fork-tested, because `Fork.t.sol` signs and the settlement verifies. The curve is not: both fork files set `curve: bytes32(0)` | A real wallet hashing seventeen fields and rendering them to a person; the curve read against a real clock rather than a `vm.warp` |

Two more, one step down from a feature:

- **The deep probe path.** `_probe` runs on every fill through `_deliverTo`, so
  the fork fills exercise it. The `deep` branch — the `tokenIn` allowance and
  balance reads and `Reason.TokenOutUnreadable` — runs only under a batch,
  `dryRun` or `fillability`, and no fork or live test calls any of the three.
  The 30,000-gas cap has never met a token whose `balanceOf` is genuinely
  expensive.
- **The permit2 rung against the canonical Permit2.** `Fork.t.sol` builds its
  settlement with a codeless `NO_PERMIT2`, and every permit2 test that runs
  offline uses a mock. Two fork tests now reach the real deployment —
  `test_TheRealPermit2CarriesASixDecimalReservation` and
  `test_TheRealPermit2FundsAFillOnTheFreshDeployment` — beside the hand-run
  script `app/scripts/e2e/permit2.ts`.

**Nothing automated runs an end-to-end fill against any chain.** Nine scenario
scripts under `app/scripts/e2e/` do exactly that on 943 — batch, callback,
escrow, gasless, partial, permit, permit2, probe and ring — beside
`app/scripts/e2e-testnet.ts`, and a person runs each one. No workflow, cron or
git hook invokes any of them, and none of them covers any feature in the table
above.

---

## 4. The known and accepted limits

Eleven, in `docs/AUDIT-SCOPE.md` sections 6.1 to 6.11. Each is measured rather
than predicted, and each carries a "why not fixed". **Accepted is not closed** —
6.5 is an open finding we chose to keep, and 6.10 is an audit finding this
repository partly reopened. Tell us if you disagree with the price we put on
either.

| # | The limit, in one line | Read |
|---|---|---|
| 6.1 | A token that rebases down leaves the reservations adding up to more than the contract holds. First to withdraw wins | `docs/AUDIT-SCOPE.md` 6.1 |
| 6.2 | A token that rebases up strands the gain, and `sweepUnowned` books it to the immutable stray config rather than to the maker whose tokens grew | 6.2 |
| 6.3 | A taxing token can never fill at full size on the authorization or permit2 rung, because both move the whole `amountIn` | 6.3 |
| 6.4 | `sweepUnowned` is permissionless, so an unattributed token is booked for a burner we do not control, and the stray config that names it cannot be changed | 6.4 |
| 6.5 | F-5, the maker's free option: a funded escrow intent is fillable and withdrawable at the same instant. Rated MEDIUM, not fixed, and a test asserts the attack works | 6.5 |
| 6.6 | F-4 is withdrawn rather than fixed. The escrow cooldown it reasoned about no longer exists | 6.6 |
| 6.7 | The off-chain token allowlist does not exist. Three limits name it as their mitigation | 6.7 |
| 6.8 | Twenty-two smaller limits in four groups — six on the settlement, eleven on the executors and the sink, five on the RFQ venue. The `WAD` fee ceiling, no window bound, two unreconciled gasless windows, `skipInvalid` not covering a revert, `dryRun` not invoking the callback, no native currency, a swallowed disposal failure, and the rest | 6.8 |
| 6.9 | A fee destination that reverts on receipt strands its own book for ever; in a multi-destination `claim` its share is re-booked under its own config. Nobody else can be hurt by it | 6.9 |
| 6.10 | E-5 is partly reopened on purpose: the fee now floors instead of ceiling-dividing, so a gross under 1,000 units pays nothing at every decimal width. That floor is dust on an eighteen-decimal token and a tenth of a cent on bridged USDC. Disclosed, not floored in the contract | 6.10 |
| 6.11 | An unfunded escrow signature is no longer inert. Parked capital lets a solver fund one at a moment the maker did not choose | 6.11 |

---

## 5. The controls, and their gaps

### On every pull request and every push to `master`

`.github/workflows/ci.yml`, three parallel jobs. The contracts job:

| Gate | Fails on |
|---|---|
| `forge fmt --check` | unformatted Solidity |
| `FOUNDRY_PROFILE=fork forge test --match-path 'test/Fork*.t.sol'` | a failing fork test, against real mainnet contracts |
| `forge build --sizes` | a compile error, or a contract over the EIP-170 limit |
| `forge test -vv` | any failing test |
| `contracts/tools/coverage-gate.py` | any uncovered line, branch or function outside the two exclusion lists, or a stale excuse |
| `contracts/tools/src-fingerprint.py`, then `--compare` | a step reaching back into `contracts/src` |
| `contracts/tools/check-citations.py` | a line-number citation in five of the six documents it names that no longer points at what it claims. This document is the sixth, and it is not checked: it makes no line-number claims at all, so the gate prints it as unchecked rather than as a pass |
| `tools/check-ci-parity.py` | the local runner and this workflow disagreeing about the step list |
| `forge test --match-path test/Gas.t.sol` | a gas assertion moving |
| `app/scripts/gen-gas.mjs --check` | a stale gas table on the landing page |
| `contracts/tools/check-gas-figures.py` | prose quoting a retired gas figure |
| `abi/export.sh --check` | any of six exported ABI files differing from the build |
| `git diff --exit-code app/src/lib/__fixtures__/` | the run rewriting the EIP-712 fixture |

The `app` and `sdk` jobs run lint, typecheck, build and vitest, plus
`npm run check:abi` and `npm run check:addresses`.

### Nightly, at 04:00 UTC

`.github/workflows/soak.yml`, plus `workflow_dispatch`. **Four independent jobs.**
A job here fails without failing anybody's pull request, which is the trade:
these are the checks too slow or too network-bound to sit in front of a merge.

| Job | What it does |
|---|---|
| `invariants` | `FOUNDRY_PROFILE=soak forge test --match-path 'test/*Invariants*.t.sol'`. The same call budget as the pull-request run, in chains four times longer. Depth is what finds an ordering bug |
| `yul` | `prove-yul-runs.py`. Breaks each forgiven `assembly` block and counts the tests that notice. The whole compensating control for the 23 lines the coverage gate forgives. It was 22m49s of the pull-request job before it moved here, and it needs `FOUNDRY_THREADS: 1` to run at all |
| `deployed` | `verify-bytecode.mjs 943 --pin`. Reads the deployed code off testnet 943 and holds every address against the verdict pinned in `contracts/tools/bytecode-pin-943.json`. It exists because the same tool, run by hand on 2026-09-09, found 943 two commits behind `master` with two shipped features absent from the chain the documents said carried them |
| `opcodes` | `npm run check:opcodes`. Every chain is where `foundry.toml` assumes. It lives here rather than in CI because it talks to a chain, and a network call in front of a merge reddens builds for unrelated reasons |

### By hand, and only by hand

| Gate | Why it matters |
|---|---|
| **Reading a Slither verdict** | The run and the bookkeeping moved into `soak.yml` on 2026-09-09. Judging a finding did not, and cannot: `docs/slither-triage.md` carries a reason per detector, written by a person. The gate proves a verdict exists and never that it is right |
| **`docs/slither-triage.md`'s own line numbers** | It sits outside `check-citations.py`, so nothing catches a citation that rots. `ProveSettlement.sol` grew 743 lines between the last two runs, and every number in the previous edition was wrong |
| **`Live369.t.sol`** | Eight tests, skipped everywhere, and they cannot pass until mainnet is redeployed |
| **Every end-to-end fill** | Nine scripts under `app/scripts/e2e/`, each run by a person |

### The gaps, stated plainly

1. **Slither is the only security tooling, and it is a night old in this
   workflow.** It ran by hand until 2026-09-09, which is how its count read 73,
   then 81, then 84 across six days while the triage lagged each one. It runs
   nightly now, pinned at 0.9.6, with a gate that fails when a finding has no
   verdict. Judge that control on its next few nights, not on its first.
2. **There is no other security tooling anywhere.** No dependency audit, no
   secret scanning, no CodeQL, no Semgrep, and nothing at all on the pull-request
   path — Slither's own run is nightly, so a merge never waits for it.
3. **CI triggers on push and on pull request.** Work that is committed and not
   pushed is gated only by `.githooks/pre-push` and `tools/run-ci.sh`. That
   pairing exists because the coverage gate once sat red on `master` for four
   days behind 87 unpushed commits. Every gate worked; none had been asked.
4. **`verify-bytecode.mjs` is pinned rather than tolerated.** The soak step runs
   `--pin` and passes only while every address on 943 reports the verdict
   `contracts/tools/bytecode-pin-943.json` records. Three contracts are pinned as
   different code today, each with the commit that explains it written beside it.
5. **The nightly soak is the only thing that checks a chain**, and it checks
   bytecode rather than behaviour. `eth_getCode`, nothing more.
6. **`app/src/i18n/reviewed/*.json`, 34 locales, has no named CI step.** A test
   inside the app job's vitest covers it.

---

## 6. Where we want you to look, in order

Ranked by where the money is and how subtle the code is. Not by how long it is.

**1. The fee book, and the three-term subtraction that protects it.**
`_pendingFees`, `_totalPendingFees`, `_reserve` / `_book1`, `_settleLedger`, `claim` through
`FeeClaimLib.pay`, and `sweepUnowned`'s
`held - _totalReserved - _totalPendingFees - _totalParked`. This is money that
rests in the settlement belonging to no intent and no reservation, and the
contract had no such money before 2026-09-04. Three pairs of books must move in
the same statement at every site, on every path including the reverting ones. If
one ever moves alone, the sweep either pays out a maker's escrow or refuses to
sweep at all. It is nine days old, and the newest of the three terms is one day
old.

**2. Parked capital, and the arming path that spends it.** `park`,
`_drawFromParked`, `withdrawParked`, `ARM_FROM_PARKED`. It is the newest code in
the tree, it has run on no chain, and it deliberately reversed a safety property:
an unfunded escrow signature used to be a real off switch and is not any more.
Both `park` and the arming call are permissionless, so a solver picks which of a
maker's signatures to fund and when. The one exclusion rule it needs —
`_drawFromParked` refusing an intent that carries `authNonce` — was found by an
invariant campaign, not by design. Look for the second rule nobody has found yet.

**3. The rounding in `_quote`, and everything downstream of it.**
`gross = ceilDiv(take * minOutAt, amountIn)`, `fee = gross * rate / WAD`,
`delivered = gross - fee`. Three roundings decide who keeps the dust of every
fill, and `d1dd385` reversed one of them four days ago, which partly reopened
audit finding E-5. This arithmetic runs on every fill on every path. The claims
to check are that no split of a fill ever pays the maker less than the whole,
that `delivered + fee` is the gross exactly at every rate, and that `fee <= gross`
holds for every input `_termsOk` admits — because if it does not, the subtraction
panics, and a panic is not a `Reason` that `skipInvalid` can step over.

**4. The credit path and the callback.** `fillBatchWithCallback`, `_creditLeg`,
`_collect`, `_recordLeg`, and `proveBatchCallback` on the executor side. This is
where the settlement releases token A before anybody has paid for it, and the
whole no-inventory design rests on that ordering being safe. It is also the one
surface where an arbitrary caller reaches the settlement with arbitrary calldata
of their own. `_requireSwept` and `_wanted` are what stop a ring settling around
a leg it did not close.

**5. The curve.** `minOutAt`, `_stretchAt`, `FLAGS_CURVE_KIND`. It sets the price
of every fill. It is four days old. No invariant campaign drives a non-zero
curve, and two fuzz properties at 20,000 runs each stand in for a `_termsOk` rule
that does not exist — nothing on chain refuses a malformed curve word, because
every word is meant to price inside the envelope. Check that claim rather than
the sentence.

**6. The RFQ mirror checks.** `RfqVenue._checkBinding`. Three checks stand in for
a commitment the maker's signature cannot carry, because the maker signs before
the counterparty's quote exists. We want to know whether three is the right
number: `mirror.flags`, `mirror.startTime`, `mirror.nonce` and
`mirror.recipient` are checked against nothing in the binding. Unit tests only,
no invariant, and no chain test.

**7. Two hand-chosen gas numbers.** `PROBE_GAS` at 30,000 bounds every bounded
token read, and the ERC-1271 staticcall is capped at 60,000. Both decide whether
an honest counterparty reads as hostile. Is 60,000 enough for a Safe or an
ERC-4337 account, and is 30,000 enough for every honest token? Both live in
assembly or beside it, and no coverage counter can see the first one.

---

## Errata — where a document disagreed with the code

A pass on 2026-09-09 found nine places where a document disagreed with the code.
They are listed rather than quietly corrected, because the pattern matters more
than any one of them: **every wrong sentence below was about a control or about a
chain**, and no gate in this repository could see either.

| Where | What it said | What is true | State |
|---|---|---|---|
| `AUDIT-SCOPE.md`, section 8's CI table | `prove-yul-runs.py` is a step in the contracts job | It is the `yul` job of `soak.yml`, nightly | **Fixed** |
| The same table | `git diff --exit-code src/` guards the sources | `ci.yml` runs `src-fingerprint.py --compare`, and says why in its own comment | **Fixed** |
| The same table | Ten steps in the contracts job | Fourteen. It omitted `forge fmt --check`, the fork tests, `src-fingerprint.py`, `check-ci-parity.py` and `check-gas-figures.py` | **Fixed** |
| `AUDIT-SCOPE.md`, section 9's opening | "The first four are all code that has never run on any chain" | Written 2026-09-04 and true for one day. It then stood, false, for four days beside a section 3 that said the opposite | **Fixed** |
| `AUDIT-SCOPE.md`, section 3 | Testnet 943 runs the tree at `78e0ef4`; `master` is deployed nowhere | 943 was redeployed on 2026-09-09 and ran the audited tree exactly, verified byte for byte. Five commits have parted them since, and section 3 says so | **Fixed, then overtaken** |
| `AUDIT-SCOPE.md`, its own tree pin | Re-pinned against `335f9d9` | The pinned hash was the tree at `7f74fd4`. `335f9d9`'s tree is `3789925b`. The section 3 table carried the second and the opening carried the first. It went stale a fourth time at `8efa7d2`, and both documents are re-pinned to `90331506` on 2026-09-16 | **Fixed twice** |
| `AUDIT-SCOPE.md`, section 9.1 and 9.6 | `claim` cited at a line inside `sweepUnowned`; a citation reading `42aee0a` | Both re-aimed. The first passed the gate through the blind spot that tool's own header describes; the second is not a citation shape at all, so nothing looked at it | **Fixed** |
| `app/scripts/executor.ts` | "943 has no executor deployment to fill through" | 943 has a `ProveExecutor` at `0x8B5bf5b0…5608`, 4,809 bytes on chain, wired to the new settlement | **Fixed** |
| `docs/ROADMAP.md` | "935 multi-leg fills in one 20,000-block window, `contracts/deployments/943.json`" | The number appeared nowhere in that file. The claim now rests on the two rings that settled through the 2026-09-09 set, each named by transaction hash and gas | **Fixed** |
| `app/src/i18n/en.ts`, `landing.control.audit` | "every finding is fixed, and each one has a test that fails if it comes back" | It was true of the security review and false of the economics review. The string now says so in its own words, in every language: one economics finding stays open by design and its own test asserts the attack still works | **Fixed** |

**All nine were closed on 2026-09-09, and five commits have since overtaken the
chain row.** Do not read that as a clean bill. Seven
of the nine were caught by a person reading two documents side by side, not by a
gate — the citation gate was green through every one of them, because a citation
that points at a real line can still sit in a sentence that is false. The
controls that did catch something are the two that compare a document to a
measurement: the tree pin, which said this document was out of date and was
right, and `verify-bytecode.mjs`, which said the chain was not what the roadmap
claimed and was right. Both of those are one day old.

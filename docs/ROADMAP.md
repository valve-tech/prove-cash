# What is built, and what is left

> **Update 2026-10-03.** `feat/fee-config-hash` (local, unmerged, undeployed) replaces the fee-sink
> registry: fees are keyed by a signed config hash with three take points, the settlement has no
> owner, and `FeeDefaults` and `ProveReader` are new. Backlog and "what is built" entries below
> that mention fee sinks are history. See `docs/FEE-MODEL.md` and the internal backlog.


Two lists. The first says what the code does today, and where to check each claim. The second is
the backlog, numbered, and the numbers are never reused.

`progress.txt` is the session-by-session narrative and is not tracked. This file is the
checkpoint. It changes when a feature lands or a backlog item moves, not when a session ends.

Three companions, all written 2026-09-03 and all pinned to code rather than to memory:
`docs/AUDIT-SCOPE.md` is what an external auditor reads first — scope, trust model, invariants,
accepted limits and where we are least sure. `docs/slither-triage.md` carries all 85 static
findings with a verdict and a reason each. the internal risk assessment rates the PROJECT rather
than the code, against Creed's six functions, and it is the least flattering document here.

Last checkpoint: **2026-09-03**, at `463d721`.

---

## Part 1 — Features

### On mainnet (chain 369) since 2026-08-22

Four contracts. `contracts/deployments/369.json` holds the addresses and the verification note.

| Contract | What it does | State |
|---|---|---|
| `ProveSettlement` | EIP-712 intents, five custody rungs, partial fills, dutch decay, direct / batch / callback fills, on-chain cancel, ERC-1271 makers, the `fillability` view, one-call escrow withdraw | Live |
| `ProveRelayer` | The one address makers and executors approve. The settlement holds no allowance | Live |
| `ProveExecutor` | Fills with no inventory. It releases the maker's token A, sells it at any venue the caller names, pays the maker, and keeps the rest | Live |
| `ProveCallSink` | Makes the executor's arbitrary call, so the executor never calls a stranger | Live |

**The five custody rungs**, weakest to strongest — `contracts/src/ProveSettlement.sol`:

1. `approval` — the tokens stay in the wallet under an allowance that can vanish. **Nothing on
   chain bounds the window.** `MAX_WALLET_WINDOW` and both `_termsOk` time bounds went in
   `a7c5d7f`: a stale wallet signature costs the maker who signed it and nobody else, so the
   choice was never the contract's. The app advises an hour and does not block.
2. `permit` — EIP-2612. The same wallet custody and the same absent cap, with one fewer
   transaction.
3. `escrow` — the tokens are reserved against one intent hash. The offer rests indefinitely.
4. `authorization` — EIP-3009. A single-use transfer that funds the reservation just in time. It
   has no time cap, because it funds escrow.
5. `permit2` — one short-lived Permit2 signature per intent. It asks the token for nothing.

Rungs 2, 4 and 5 are funded by a signature rather than by a transaction, and **a batch arms any of
them itself** — `FillRequest.arming` carries the permit, the authorization or the Permit2 transfer,
and the intent's own flags say which. Before that, only rungs 1 and 3 could join a batch.

**The fee model** — `contracts/src/ProveSettlement.sol`, `_quote`. The maker signs a rate and a
registered fee sink, and the sink names one destination for all time. The contract charges that
rate and books it to that sink. It cannot raise the rate, lower it, or take a share on the way, and
a zero rate charges nothing at all. prove.cash earns nothing from a fill. The fee comes out of the maker's
signed number rather than riding on top of it, so the maker signs a gross and receives the gross
less the fee. The executor's outlay is that gross whatever the rate is.

Three owner functions: `setDefaultProceeds` says where a token belonging to no intent goes, and
anybody may call `sweepUnowned` to push one there; `registerFeeSink`; and `transferOwnership`.

Two more followed on 2026-08-25, against that same settlement:

| Contract | What it does | State |
|---|---|---|
| `RfqVenue` | Exclusive quotes. A maker names a price for one counterparty, the counterparty accepts with a signature and no gas, and anybody may submit the pair and keep the spread | Live. The SDK path is complete (`sdk/src/rfq.ts`), and the app reaches it at `#/<chain>/rfq` — #53 |
| `ProveBatchExecutor` | Rings of up to three legs, settled in one transaction, filled on credit. It carries its own `ProveCallSink` | Live. `scripts/solver.ts` still points at testnet — #54 |

Both read `relayer()` from the settlement in their constructors, so they bind to the deployment
above. **Redeploying the settlement means redeploying both**, or a quote and a ring point at a
settlement nobody uses.

### On master since 2026-08-26, not yet deployed

The deployed settlement is older than the source. Everything below needs #35 before it is real.

| Change | What it does |
|---|---|
| The protocol went neutral — `84e8895` | Deleted `feeSink`, `feeFloorRate`, `protocolShare`, `feePolicy`, `setFees`, `setFeePolicy` and all three rate ceilings. A fill is 6,400 gas cheaper on a cold allowance; a batch of twenty is 27,775 cheaper |
| A batch can arm — `1daa379` | `FillRequest.arming`. Arming runs inside `try this.armLeg(...)`, so a leg that cannot be armed leaves the maker's nonce unspent and their tokens unmoved. Without that frame, one signature on a fee-on-transfer token would cost every solver a whole batch, for ever |
| The solver understands it — `a834867` | `EscrowShort` now means "needs arming" on an armable leg. Candidates are partitioned by `(maker, tokenIn)`, because permit nonces are ordered and a maker's balance is shared, so group fillability is not the conjunction of individual fillability. **It also fixed `fillabilityCall` passing four arguments to a five-argument function — every `loadBook` call was throwing** |
| `dryRun` — `67055b9` | Walks the real path, arms for real, records a `Reason` per leg, and always reverts with them. `eth_call` it. Nothing else can answer whether a permit lands or a redemption falls short, because both are post-transfer facts. It does not invoke the callback, so it says the legs are fillable, not that the batch will succeed |
| A fifth custody rung — `7f4620c` | **Permit2**, and the only rung a settlement redeploy cannot orphan. Every other rung that reaches a wallet rests on an ERC-20 allowance to `ProveRelayer`, which the settlement's own constructor creates — so a new settlement orphans all of them. A permit2 maker approves Permit2 instead, at an address that is the same on every chain, and signs one short-lived transfer per intent. It also asks nothing of the token, so it reaches makers whose assets can do neither EIP-2612 nor EIP-3009 |
| ERC-7598, `minFill`, one `_armLeg` — `0c1766e`, `3960d16` | Contract signatures on the gasless rung; a maker's floor on a partial intent; both single-intent arming functions reimplemented over the shared `_armLeg` the batch uses. `minFill` moved the EIP-712 type hash, so the wire codec is **VERSION 3 and every intent signed before it stopped verifying** |
| A ring that tolerates a lost leg — `7d038a9`, #109 | `WHEN_ABSENT` or'd into `Swap.leg`, so a venue call runs precisely when its leg did NOT settle. (This row used to name a `FLAG_TOLERANT` on a `FillRequest`; no such flag was ever built.) A solver who asks for it keeps the legs that still fill when a rival takes one, instead of losing the whole ring. It is not the default: a fallback costs 19,630 gas then 20,537 each carried on every ring, against 222,044 saved on the rings that lose one, so three of them pay only above about a 22% loss rate. All three figures are generated rows now — #130 |
| `FeeSink` came out — #117 | The buy-and-burn this repository deployed alongside the settlement is gone: one contract, ten owner-gated functions, two test files and 88 tests. Burning is a specialism to rent rather than to build. `defaultProceeds` now names PulseX's own buy-and-burn, read from `contracts/config/<chainid>.json` instead of deployed. What that costs is measured in `test/ForkBuyAndBurn.t.sol` and accepted in `docs/AUDIT-SCOPE.md` section 6.4 |
| Fee sinks with one fixed destination — `4d48379`, not yet on `master` | An intent with `feeRate > 0` must name a registered `FeeSink` and sign at least its `minRate`, or `_termsOk` refuses it. A `FeeSink` is an immutable record of one destination and one floor, with no owner, and it never holds a token: `claim(sink, token)` pays the destination. `registerFeeSink` is append only, so the owner can add a destination and never remove or redirect one. `Deploy.s.sol` deploys and registers the buy-and-burn sink from `config/<chainid>.json`. `64224af` also fixed B-2: an unreadable token B reverts `Underpaid` through the three arming doors. `docs/specs/2026-09-23-fee-sink-fixed-destination.md` |
| One call sink per caller — `21a4240` | `ProveCallSink` was shared, and a stranger could arm a standing approval out of it for one cheap transaction and then take what a later solver stranded there. Each caller now gets their own EIP-1167 clone at a `cloneDeterministic` address salted on `msg.sender`, minted once. The strand is recoverable again, and every entry after the first saves about 35,000 gas. Backlog #112 |
| `sink()` became `sinkTemplate()` — #153 | Both executors published their call sink TEMPLATE as `sink()`. The template is never called and holds nothing, so a router payout aimed at it is lost. The name read like a destination. The 369 fork rehearsal lost a run to it, and the revert came from inside the token — `ERC20: transfer amount exceeds balance` — frames below the route that named the wrong address. Three changes, for three readers. The accessor is `sinkTemplate()`, so the ABI carries the meaning. `sinkFor(caller)` publishes the clone that does sweep, so a solver reads the right address instead of deriving it. And each executor checks that it holds what the settlement is about to pull, reverting `ProceedsNotHere(token, held, owed)` before it approves the relayer — a necessary condition of every fill that already worked, so nothing that used to settle is refused. `contracts/test/Executor.t.sol` and `contracts/test/BatchExecutor.t.sol` pin the wrong target failing by name and both right targets working. `contracts/test/Live369.t.sol` keeps the old name behind a local interface, because the deployed bytecode answers `sink()` and reverts on `sinkTemplate()` |
| The nonce floor has lanes — #131 | `invalidateBefore` used to be one monotonic floor per maker, so a maker could retire everything below a point and nothing else. A nonce's high 192 bits are now a lane and its low 64 a position — OpenZeppelin's `NoncesKeyed` packing, applied to a high-water mark rather than to a counter — so one word retires one lane and spares every other. **Nothing a wallet signs changed**: `INTENT_TYPEHASH` does not move, the `Intent` struct does not move, `invalidateBefore` keeps its selector, and every nonce this repository builds sits in lane 0, where the floor means exactly what it always meant. The two signing surfaces use a millisecond epoch, about 1.8e12; `app/scripts/heartbeat.ts` scales that by a thousand and adds jitter, about 1.8e15; a lane holds 1.8e19. Measured over the whole msgboard archive on 2026-09-09 — 9,204 intents on chains 369 and 943, every one in lane 0. That total is a floor, not a fact about today: the archive grows, and it had moved within hours of being written, so `app/scripts/check-nonce-lanes.ts` is the answer and this number is only where it stood. The walker reads all four wire versions; three of them occur, because no v2 intent reached either board. `park` reads the floor too, so a bulk retirement now rolls its escrow forward instead of leaving it behind `withdraw`. It costs 154 gas on a warm allowance fill and 432 bytes of runtime. `contracts/test/Lanes.t.sol` and `app/src/lib/nonce-lane.test.ts` |
| The tolerant break-even is gated — #130 | `FALLBACK_FIRST_GAS` and `FALLBACK_MORE_GAS` in `sdk/src/solver/tolerant.ts` were the last inputs to `breakEvenLossRate` with no generated gate behind them: measured once in `BatchExecutor.t.sol`, which asserts ceilings, and then typed into the solver, where they drifted. `FallbackGasTest` in `contracts/test/Gas.t.sol` publishes all three as rows, so `app/src/landing/gas.ts` carries them and CI's `--check` compares them. It also adds a route with several fallbacks in `swapOrder`'s funding order, and the two-lost-leg case that reverts |
| Escrow that outlives its intent — #120 | A maker who re-prices used to withdraw and deposit again: two transactions, two transfers, to move capital that never left the contract. `park(intent)` frees a dead offer's reservation into `_parked[maker][tokenIn]`, and a solver arms the next leg out of it with one word of `FillRequest.arming` — no maker transaction, and no transfer at all. A third book, `_totalParked`, joins the sweep's subtraction. **It costs the maker one property**: an escrow signature they never funded is no longer inert, so `cancel` and `invalidateBefore` are the only off switches — #131 gave the second one lanes. `docs/AUDIT-SCOPE.md` section 6.11 is the disclosure |
| Parked capital reaches the maker — #132, #134 | The Mine tab draws a `Capital resting here` table, a withdraw, and the disclosure a maker is owed: an escrow signature they never funded is no longer inert, because a solver can fund it out of capital freed from another of their dead offers. Thirteen keys in thirty-five languages. `parkedRows` refuses to draw an unread row as an empty one, which would tell a maker their money left. #134 fixed what the tab could not see: the token set came from the newest hundred records THIS BROWSER holds, so a parked row in any other token was invisible. `readParkedTokens` reads the `Parked` log filtered on the maker instead, over a 50,000-block window. The endpoint's ceiling is exactly 100,000 blocks in a range: a span of 99,999 is accepted and 100,000 is refused with `getLogs request exceeded max allowed range`. The first measurement of that said the opposite, because it asked without an address filter and read a too-many-results refusal as a range refusal — a right decision from a wrong reading. At 10.2 s a block, 50,000 blocks is about 5.9 days. A failed log read adds nothing and never subtracts. `app/src/lib/parked.ts`, `app/src/lib/settlement.ts` |
| A bulk off switch — #133 | Fifty live offers used to cost fifty `cancel` transactions, because `cancel` needs each preimage. `invalidateBefore` had no caller in the app at all. `bulkRetire` in `app/src/lib/nonce-lane.ts` splits a maker's live offers into the ones one word ends and the ones it spares — another lane, or lane 0's top position, which a strict `<` can never reach — and returns a floor always strictly above the current one, so `BadParameter` is unreachable. The panel lists every offer the transaction ends before it is sent. The copy carries both costs: it ends every offer below the number including ones this device never saw, and it returns no money, but `park` reads the floor, so the deposit lands in the capital resting here |
| The solver budgets parked capital — #135 | `groups.ts` knew two shared quantities per `(maker, tokenIn)`: the wallet balance and the EIP-2612 permit queue. `_parked[maker][token]` is a third, and a leg armed `ARM_FROM_PARKED` draws nothing from the wallet, so two of them could ask for more than the row holds and nothing said no. `GroupLeg.parkedDraw` and `GroupLimits.parked` size it as its own budget, on the same stated convention: an unread limit constrains nothing, and `dryRun` catches the shortfall then. The 2^k per-partition enumeration is untouched — a budget changes what the search accepts, never what it tries |

**All of it is deployed on testnet 943, redeployed again on 2026-10-01** for the fee
fix (no fill reads the default sink) and a default `FeeSink` at 0.5%. The settlement is `0xdb3843eFa19C06cA77e16c082BF33f7D4Dd1b8FC`, and a testnet-only
admin, `0x6fa7d1016789A0C32fe74d5Bdd4393836C366Acc`, owns it, not the mainnet deployer. Two rings settled through the
2026-09-09 set, now retired — `0xfc9546334d…` at 369,155 gas and `0x7f821f72ab…` at 275,059.
`node tools/verify-bytecode.mjs 943` reports all eight contracts of the 2026-10-01 set identical to the build.
`contracts/deployments/943.json` is the record, and `docs/ADDRESSES.md` lists the retired sets.

**This row said the same thing for four days while it was false, and that is worth keeping.** The
2026-09-05 set was commit `78e0ef4`; #120 and #131 both change storage, so both needed a new
address and neither had one. `parked(address,address)`, `totalParked(address)` and
`laneFloor(address,uint192)` all reverted on that settlement while this document said they were
live. Nothing caught it because nothing looked: `verify-bytecode.mjs` was written, worked, and was
wired into no runner. It runs nightly now, in `soak.yml`. The evidence this row used to cite,
`4646b16`, was two deployments old — the citation gate checks file and line references and never a
commit hash, so a rotten commit reads as fresh.

`INTENT_TYPEHASH` did not move in the 2026-09-09 redeploy, so nothing about the signed type
changed; the domain separator did, because it carries the verifying contract, so the board refills
in one heartbeat round. Mainnet still runs the 2026-08-22 set, which is what #35 is for.

### The app — `app/`

Two surfaces in one bundle. `/` is the landing page, and it imports nothing from viem or the
chain registry. `/app` is the dapp, and it loads lazily. See `app/src/surface.ts`.

Working today:

- Sign an intent, encode it to about 175 bytes, grind the proof of work in a worker, and post it
  to the msgboard.
- Read the board, decode it, verify every signature locally, and show funding and the spread
  against PulseX.
- Keep every verified sighting in IndexedDB. The book survives a reload, and an intent that ages
  off the board stays visible with an off-board mark.
- Backfill the same book from the public msgboard archive, page by page.
- Keep your own intents alive as the board ages them off. Anyone else may do it too, because the
  payload carries the maker's signature.
- Pick the strongest custody rung the token supports, out of five. Each rung's cost in signatures
  and transactions is printed on the button.
- Point the board and the chain at two different RPCs, or lock them together.
- **Sign an offer that opens later** — an "opens" chip row above "expires", from now to 24 hours
  (`2cc3b96`). The chain always took a future `startTime`; the form hardcoded `Date.now()`. On the
  3009 rung a future `validAfter` funds the reservation just in time, so the maker schedules an
  offer without committing capital for the wait — nothing else here does that. Escrow cannot: its
  deposit is taken when the offer is signed. The form refuses a DEAD pairing (the authorization
  opens after the offer expires, which the chain accepts and every fill then answers `EscrowShort`)
  and warns in amber on a STRANDED one.
- Execute: direct, batch, authorization and callback fills. A clean `eth_call` arms each one, and
  each is disabled while the settlement address is zero.
- The Mine tab: every intent this wallet signed, the escrow behind it, and one withdraw button
  that returns the money and ends the offer.
- Thirty-five languages, with numbers formatted per locale, and the landing page is translated
  into all of them — not only the dapp. Right-to-left included.
- **The landing page is indexable in every language.** One URL per locale (`/`, `/de/`, `/ar/`),
  prerendered HTML at each, a complete mutual `hreflang` cluster and a sitemap — `7c831f5`,
  `ac64a6c`. A crawler arrives with `Accept-Language: en` and reports one tag in
  `navigator.languages`, so a runtime picker alone is invisible to it. A language picker in the
  header changes the URL as well as the language — `cc8d1f8`.
- Five landing sections: how it works, the custody ladder, the whole bill in measured gas, **who
  pays your gas and what it costs them** (`259f022`), and what nobody can do to you. Every gas
  figure on the page is generated from `contracts/test/Gas.t.sol` by `app/scripts/gen-gas.mjs`,
  and CI fails on a stale one.

**The app cannot see mainnet.** `sdk/src/config.ts` carries `settlement: ZERO_ADDRESS` for 369,
so the site goes on saying mainnet is not deployed. That is deliberate. Switching it turns escrow
on for every visitor. Backlog #52.

**Exclusive quotes have an app surface** — a fourth tab at `#/<chain>/rfq`, in `app/src/rfq/`.
Make a quote to one counterparty and it is posted sealed when they have announced a key and plain
when they have not; read the ones addressed to you and open them with a key derived on demand and
never stored; check them with `checkExclusiveQuote`, price them with `exclusiveQuoteCost`, and
settle the pair. No decay and no partial fill, on purpose — nobody races a price only one address
can take, and a binding releases `Exclusive.take` once. The shared parts came out of the sign form
rather than being copied: `app/src/lib/arm.ts` is the sign, authorize, approve and deposit order
for all five rungs, in one place.

**The venue address is hard-coded** in `app/src/rfq/venue.ts`, from `contracts/deployments/*.json`.
A solver reading a quote gets the venue from `Intent.executor`, but a maker writing one must name
it before a quote exists, and `RfqVenue` binds to the settlement in its constructor — so the next
settlement redeploy orphans this copy silently, and the quote reverts at settlement. It wants an
`rfqVenue` field on `NETWORKS` behind a resolver, like `settlement()`.

### The SDK — `sdk/`, `@prove.cash/sdk`

No React and no DOM. The app consumes it over a `file:` link. It is not published.

`config.ts` the chain registry · `intent.ts` the type, the EIP-712 domain and the wire codec ·
`board.ts` the msgboard client · `store/` IndexedDB or a plain Map · `archive.ts` older posts ·
`settlement.ts` fill paths, quotes, reservations and fee parameters · `custody.ts` EIP-3009
detection, Permit2 and the authorization typed data · `rfq.ts` exclusive quotes ·
`rfq-crypto.ts` a key a browser wallet can use · `solver/` ring matching ·
`solver/mempool.ts` what a rival has already sent.

**The solver** caps a ring at three legs, so there is no shortest-path problem to solve
(`sdk/src/solver/rings.ts:16`). It indexes by pair, prices each candidate against any registered
market — `xyk` is one kind, not the only one (`f753b65`) — checks the ring condition in exact
integers, sizes the fill, and produces a plan. `solver/trust.ts` bounds what one transaction may
lose to legs that fill nothing, and refuses to count a lost race as a maker's fault.

**`rfq-crypto.ts` is wired end to end.** An exclusive quote travels over a public board, so its
terms want encrypting to one counterparty — and the obvious design cannot be decrypted, because a
browser wallet will not do ECDH and `eth_decrypt` is deprecated and broken. The key is derived
instead: the counterparty signs one fixed string, that signature seeds an x25519 keypair, and the
secret half is re-derived rather than stored. Surveyed 2026-09-01: no production RFQ protocol
encrypts to a named counterparty; they all keep quotes private by not publishing them. The wire
format and key publication landed with #37, and the app reaches all of it — #53.

**The solver reads the pending pool before it sends** — `sdk/src/solver/mempool.ts`. It prefers
`eth_pendingTransactions` and falls back to `txpool_content`, because on the gateway the same
answer costs 14,930 bytes and 265 ms one way and 2,458,980 bytes and 741 ms the other: 165 times
larger, mostly 1,050 queued transactions nobody will mine soon. It matches by selector rather than
by `to`, so a rival calling a settlement we have never heard of still counts. A leg somebody else
is already taking is dropped from the ring rather than raced.

### The bots — `app/scripts/`, on their own host

Five units run on the bot host: heartbeat, executor, solver, mover and watchdog. The `-369`
copy of each is installed and stopped, waiting on #35.

- `heartbeat.ts` — makes a small book on a timer, and proves the whole path still works.
- `executor.ts` — prices the board against PulseX, fills what pays, and asserts after every fill
  that the maker got at least the rate they signed.
- `solver.ts` — finds the rings that pay for each other, and settles each one in a single
  `fillBatch`. `--batch` packs the independent plans into one tolerant transaction;
  `--max-grief-native N` bounds what one transaction may lose to legs that fill nothing, and
  switches on a per-maker ledger that persists across restarts.
- `market-mover.ts` — moves the lab pools, so a ring has something to close through.
- `watchdog.ts` — watches the board, the signatures, the archive and every `Filled` event. It
  recomputes what was owed from the signed terms rather than trusting the event.

They reach the contracts through a `SETTLEMENT` environment variable, not the registry. With no
address they degrade honestly: the executor says so and exits, and the watchdog keeps everything
except its fill checks.

### Tests and CI

679 contract tests — 649 that run and 30 that skip, and they say SKIP rather than PASS, which
they did not until `f8ee9b6`. The 4 of `Fork369Rehearsal.t.sol`, the 11 of
`Fork369RealTokens.t.sol` and the 3 of `ForkMultiHop.t.sol` are among the skips; all call `vm.skip`.
`ForkBuyAndBurn.t.sol`'s pair joined on 2026-09-09, where a bare return had reported PASS.
1,393 in the app, 694 in the SDK (688 run, 6 skip). 39 fuzz properties: 37 at the 512 runs
`foundry.toml` sets, and the curve's two envelope properties at 20,000, which they ask for
themselves with a `forge-config` line. Dropping `FeeSink` on 2026-09-03 took 88 tests with it.

The contract counts were measured 2026-09-23 on top of `a0bb95e`, and the app and SDK ones on
2026-09-09, each from the runner's own summary line: `forge test` in
`contracts/`, `npx vitest run` in `app/` and in `sdk/`. The fuzz count is
`grep -c 'function testFuzz' test/*.sol` summed, and the run counts come from the same `forge
test` output.

**The authority is `forge test`'s own summary line, and nothing else.** This file said 542 for a
while, carried forward from a session summary. The correction said 632, from `forge test --list`
piped through a grep — that listing yielded 641 lines and 628 unique names for a suite that ran
599, so it counts something a run does not. A proxy for the measurement is not the measurement,
and being wrong twice in one day about the same number is what bought this paragraph.
Four invariant campaigns carrying 47 properties — `grep -c 'function invariant_' test/*.t.sol` —
at 128 runs by 256 depth, plus a nightly soak at 32 by 1024 (`.github/workflows/soak.yml`). Count
them in the run output as unique names and you get 42, because five names repeat across suites and a
unique count keeps each name once. The declarations are the properties.

**CI runs on push, and for four days nobody pushed.** The coverage gate went red at `3a556e6`
and stayed red through 87 unpushed commits, because every gate this repository owns was working
and none of them had been asked. The gate was never the control. Running it is.

So `tools/run-ci.sh` runs the whole workflow here — all three jobs, in CI's order — and on a
clean tree it writes `.ci-local-pass` holding the commit it passed at. `.githooks/pre-push`
reads that file and refuses to push a commit the stamp does not cover, so "CI passed on this
tree" is a fact somebody can check rather than a thing somebody remembers. Turn it on once with
`git config core.hooksPath .githooks`; `git push --no-verify` is the way past it when you mean
to be.

That runner is a second copy of the workflow's step list, and every second copy in this
repository has gone stale at least once. `tools/check-ci-parity.py` compares the two and fails
the build when they disagree. It stops on a step form it does not recognise rather than skipping
it, for the same reason the citation gate does.

**Five artifacts are generated and CI fails on a stale one.** Each exists because a hand-written
copy of it went wrong first:

| Artifact | Written by | Checked by |
|---|---|---|
| `app/src/lib/__fixtures__/eip712.json` | `contracts/test/Fixture.t.sol` | `git diff --exit-code`, and the TypeScript suites assert against it |
| `sdk/src/abi.ts` | `sdk/scripts/gen-abi.mjs` | `--check`, which also compares every hand-written signature in `sdk/src` and `app/scripts` with the compiler's |
| `contracts/abi/` | `contracts/abi/export.sh` | `--check` |
| `app/src/landing/gas.ts` | `app/scripts/gen-gas.mjs` | `--check`, in the contracts job |
| `app/src/i18n/reviewed/*.json` | `app/scripts/i18n/review.ts` | `scripts/i18n/stale.test.ts`, which fails when a translation outlives the English it was checked against |

**Slither runs nightly now, and the shape of the fix is the one that keeps working here.**
It ran in no workflow until 2026-09-09, so its count read 73, then 81, then 84 across three runs
a person happened to make in six days, and `docs/slither-triage.md` lagged every one of them.
Worse, the report on disk was five days stale when the gate was written: Slither refuses to
overwrite an existing `--json` target and says so in one line nobody reads, so a run that looks
fine triages the previous week.

`contracts/tools/check-slither.py` closes it. **It counts by detector and never by line**, because
the triage's own header records that `ProveSettlement.sol` grew 743 lines between two runs and
moved every citation in it while changing no finding — a gate keyed on lines would fail on every
commit and teach people to ignore it. A detector the report names and the document does not is an
untriaged finding; a detector the document names and the report does not is a verdict about
something that stopped happening. Both fail, and each names the detector.

**It proves a verdict exists. It cannot prove one is right**, and that division is deliberate:
bookkeeping is the gate's, judgement is the reader's, which is why every row carries a reason
rather than a tick. Slither is pinned at 0.9.6 and the gate refuses a version the triage was not
written against, so a bump is a deliberate act with a re-read attached.

**`forge fmt --check` runs in CI now, and the reason it did not is worth recording.** Formatting
had drifted on 43 files, every one of them tracked, because a run of the formatter moves most
lines under `contracts/` and four documents cite those lines by number. The first sweep broke 87
of 500 citations. Re-anchoring them by hand is an afternoon and gets several wrong, so the gate
that was cheap to add was expensive to satisfy, and nobody paid. `contracts/tools/reanchor-citations.py`
is what makes it cheap: snapshot the sources, format, and it asks `check-citations.py` which
references broke and moves each one to where its tokens went. It fixed 84 of the 87 and named the
three it could not, which turned out to be citations that had pointed at a neighbouring line and
passed by luck. **Tokens rather than lines, and that is the whole trick** — the formatter's job is
moving text across line boundaries, so a rewrapped statement has no line to map to.

**A number that is not a row is a number no gate can retire — #136.** `check-gas-figures.py`
catches a figure equal to a value the table once held and no longer holds, so it only sees
quantities the table publishes. Three SDK files argued for batching on a pair of figures that had
never been rows: 1,013,848 gas for eight legs one at a time against 637,242 for one batch of
eight. The suite measures 1,190,037 and 695,959. Both are rows now, along with the per-leg pair
underneath them, so the gate covers every quotation of all four.

**Measuring the singles moved eight other rows, and the reason is worth knowing.** Taking the
eight one-at-a-time fills inside `test_GasReport` re-priced every row below it — the marginal fill
from 62,480 to 63,168, the three-leg ring from 196,507 to 196,692. A state snapshot did not fix
it, which is the clue: the cost was never state. Eight `FillRequest` arrays expand the test
frame's memory, memory is priced quadratically, and every later call in that frame pays for the
high-water mark the earlier one left. The pair is measured in a test of its own now, where the
two shapes are comparable to each other and disturb nothing.

The fixture pins more than the intent digest now: the RFQ venue's typehash and domain, the
`Reason` enum's ordinals by compile-checked name plus a count from `type(Reason).max`, and the
three custody flags — `b5f9b47`. Every one of those was a table copied from the contract that
nothing compared, and one of them had already gone stale.

Coverage is 100% of every line, branch and function that forge can instrument. The gate measures
a fresh report on every run and fails the build on any gap (`contracts/tools/coverage-gate.py`).
One kind of code is excluded, for one reason. **Yul**: the gate forces
`--ir-minimum`, which counts no assembly statement anywhere, and there are two blocks —
`ProveSettlement._probe` and `ProveBatchExecutor._write`. Four constructor guards were
excluded too, until a factory contract made forge count them on 2026-09-15.

**The Yul exemption has a working control** — `tools/prove-yul-runs.py` breaks each block on
purpose in a throwaway worktree and counts the tests that notice: 287 for `_probe`, 2 for
`_write`. `_probe` read 76 until the return-bomb work of 2026-09-04 routed the delivery through
it; it is on every fill now, so almost every test that settles anything notices. It finds each block by searching for the function that holds it, so an edit above it
cannot point it at the wrong code again, and it fails on an `assembly` block no target claims.
CI runs it beside the gate — #114.

One specification matrix carries its own table in its header:
`contracts/test/TokenMatrix.t.sol` — 9 token rows across 5 custody rungs, 51 tests. There were two.
`contracts/test/FeeSinkMatrix.t.sol` crossed 14 behaviours with 4 disposal paths, and it went
with `FeeSink` on 2026-09-03. Nothing in `contracts/src` disposes of a token any more.

A security audit on 2026-08-11 found one critical finding and one high one, plus six smaller
ones. An economics review added six more. `test/Security.t.sol` and `test/EconAudit.t.sol` hold a
regression test for each, except the three whose subject was `FeeSink` — C-1, L-1 and F-2. Those
are recorded in `docs/AUDIT-SCOPE.md` and have no code left to defend.

### Three limits the matrix measured

These bound which tokens the owner may list. None of them is a defect.

1. **A rebase down is a real insolvency.** The book says 1,000 and the contract holds 500. The
   first mover is paid in full, everybody behind gets nothing, and the maker's own `withdraw`
   reverts. The intended mitigation is an off-chain allowlist — **and no allowlist exists
   anywhere in this repo.** Nothing today stops an owner listing an elastic token, so this limit
   is unmitigated in practice, not merely accepted.
2. **A rebase up does not reach the maker who earned it.** Escrow pays the booked number, so the
   gain belongs to no intent. It is no longer stranded: `sweepUnowned` is permissionless and pays
   `defaultProceeds`. It still never reaches the maker whose tokens grew.
3. **A taxing token can never fill at full size on the authorization rung.** `_redeem` pulls the
   whole `amountIn`, the tax lands, the deep `_evaluate` inside `_armLeg` re-prices, and
   `EscrowShort` rolls the redeem back. (Named `_settle` here for weeks; `_settle` is not on that
   path.)

---

## Part 2 — Backlog

The numbers are permanent, and a done item is not repeated here. Closed since the last
checkpoint: #34, #36 to #50, #53, #55 to #77, #79 to #110, #112 to #136.

### Found by attacking our own contracts, 2026-09-03

`contracts/test/Adversarial.t.sol` holds 24 tests written against the four areas an external
auditor will hit hardest. Each finding is a PASSING test that demonstrates the behaviour, so a
fix has something to break. **All three findings are closed** — #112, #113 and #114, each below.
This section used to say #113 was open. It has been closed since `36701c9` on 2026-09-04, and
the sentence claiming otherwise was left behind.

**#113 is closed, and bounding the index alone would have been theatre.** A `WHEN_ABSENT`
fallback fired for a leg the request never held, because `_wanted` read "absent from the settled
set" as "absent from the batch". `route.legs` is a number the caller writes, so the index is
bound against `legs` and `legs` against the batch itself — `LegOutOfRange` is the revert. A
disposal reads its own `Swap.leg` now, carried back from the callback as one bit per disposal.
And a `NO_PATCH` disposal can no longer oversell into a mark: `have` was computed and then
ignored, so an oversized disposal spent into a donation, the venue call succeeded, the `try`
caught nothing, and `_sweepAbove` reverted the whole `settleRing` outside every frame — undoing a
batch that had already paid every maker. One donation armed that against every solver who came
after. The three fixes together cost 0.14% on a ring, worst case.

**#114 is closed, and the tool was worse than stale.** It named
`src/ProveSettlement.sol:1577`, which was the `staticcall` when `4ececf5` wrote it; by 2026-09-03
that line held the signature of `_grantAllowance`, a function with no assembly in it, so the
control was breaking ordinary Solidity and passing. A target names a file and a function now, the
tool searches for the block, and it fails on any `assembly` block in `src/` or `script/` that no
target claims. It works in a throwaway `git worktree` rather than your checkout. Measured:
`ProveSettlement._probe` 287 tests fail, `ProveBatchExecutor._write` 2. **The second number is a
fact about the tests, not the block** — `_write`'s only caller is reached through
`try this.sellSurplus(...) {}`, a bare catch, so a broken `_write` is invisible to every test that
only asserts the batch settled. CI runs the control now, and asserts the sources came back.
Its count was doubled until 2026-09-04 — it counted `[FAIL` lines, and `forge test` prints each
failure twice, inline and again in the `Failing tests:` trailer. It reads forge's own summary
line now, and the two figures above are the corrected ones.

**#112 is closed, and the cheap fix would not have worked.** The first cut minted a clone per
transaction; `21a4240` mints one per caller instead, at a `cloneDeterministic` address salted on
`msg.sender`, which keeps the security and gives back both the strand recovery and about 35,000
gas per entry after the first. The fix I nearly shipped — refuse a `target` matching a route
token — has a test proving it fails: name a worthless token on both sides of a zero-leg ring,
point `target` at the victim, and the approval still writes. The signature match was never the
control.

**What held is worth as much as what did not.** From inside the venue call — the one moment a
stranger's code runs while the executor holds every released token and has paid nobody — all six
re-entry doors are shut. The mark invariant survives partial settlement: a donation cannot be
sold, cannot pay a maker on a ring that lost a leg, and cannot be swept. Permit2 spends a nonce
before it verifies the intent, and `try this.armLeg` is the only thing that gives it back — a
genuine Permit2 signature on a forged intent leaves the nonce, the reservation and
`_totalReserved` clean. Rounding never shorts the maker at either extreme.

### Blocked on the owner

| # | Item | Note |
|---|---|---|

**#47 is closed by #117.** It asked what a fee token with no route should do. The contract that
held one is gone, so the question has no subject. What an unattributed token does now is forward
to PulseX's own buy-and-burn, and the two costs of that — 14.29% of the PLSX to a `devAddr` that
is not ours, and a wrapper stranded for good — are measured in `test/ForkBuyAndBurn.t.sol` and
accepted in `docs/AUDIT-SCOPE.md` section 6.4.

### Queued

| # | Item | Blocked by |
|---|---|---|
| 35 | Redeploy all contracts under the new key | — . #34 is done, so this is unblocked. Everything in "on master, not yet deployed" needs it |
| 52 | Turn the app's mainnet registry entry on | #35. A redeploy changes the address the app would carry |
| 54 | Point `scripts/solver.ts` at the mainnet `ProveBatchExecutor` | #35 |
| 78 | Restart the mainnet bots. The `-369` units are installed and stopped | #35 |

**Two solvers colliding is the accident worth knowing about**, and it is measured now. A leg a
rival took costs 15,982 gas inside a tolerant batch and the rest still fills — under a quarter of
one fill, and you still earn. The same collision on a 3-leg ring costs 222,044 and earns nothing,
three quarters of a win. Two evenly matched solvers racing on rings therefore each pay about 1.8x
the gas per ring they settle; on the tolerant path the same rate adds about 3%. That is what #108
is for — not to take atomicity away, but so that a solver asking for tolerance gets it. The
contract, the SDK primitive, the planner and the flag are all in. An
allowlisted solver set with an atomicity guarantee, CoW's model, may exist later as an option;
decentralised is the starting point.

**What #109 left open is a measurement, not code.** `--tolerant` is off and stays off until a
live board says the loss rate clears the break-even the solver prints at startup — about 21.1% on
a two-leg ring and 21.7% on a three-leg one, from the generated gas table. The bot is now the
instrument for that: with the flag on it logs, per ring, how many legs it could cover and why it
could not cover the rest. Expect "the market asks more than the leg frees" to be the common
answer — a market cheap enough to stand in for a maker usually makes a better ring, which the
search would have found instead — and that count is itself the thing worth watching.

### Designed, not booked

Netting asked for its argument on paper before a line of it existed. The argument is written now
— `docs/specs/2026-09-08-netting-a-coincidence-of-wants.md`, #129 — and it came back
against the feature. What follows is what that document establishes, replacing what this section
used to claim.

- **Netting a coincidence of wants.** Two makers who match each other swap ownership directly
  instead of routing through a solver. The solver claims the coincidence and the settlement
  verifies it, the way `_requireSwept` and the executor's `Route` already work.

  **The donation guarantee survives.** A netted transfer is still a directed pull: a named source,
  a named destination, an amount `_quote` decided, and no balance delta anywhere becomes evidence
  of payment. Six adversarial cases are worked in Part 2 and all six hold.

  **A second guarantee does not, and it is the case that decides the design.** A taxing token's cut
  on the release falls on the executor today, and `invariant_TheTaxIsPaidByTheExecutor` asserts it.
  Netting deletes the address absorbing that cut, so it lands on the counterparty maker, who then
  receives less than they were promised while every book still balances. It survives only if the
  netted release carries the bracket `_deliverTo` carries.

  **Two claims this section made are false, and the spec's Part 6 records both.** The payoff is not
  avoided slippage: the coincidence of wants already settles here with no pool and no slippage —
  `test_ATwoLegRingSettlesFromAnAddressHoldingNothing`, and `RfqVenue` does it again for a named
  counterparty. And a fill does not cost about a cent of gas; it costs about four hundredths of
  one, at 124,975 gas measured. What netting would actually buy is gas and attack surface, priced
  at about a sixth of a cent for a whole cross.

  **So it stays unbooked, now for a measured reason rather than an open question.** What would
  change the answer is a count nobody has taken: how often two-leg crosses actually occur on a live
  board.
- **Per-ring atomicity inside one transaction.** Today the granularity is one transaction, one
  all-or-nothing set, so a solver with three independent rings either pays the base cost three
  times or lets a bad leg in the third destroy the first two. `try this.settleGroup(...)` gives
  each ring its own frame, the same trick `armLeg` uses. The cost is a callback per group instead
  of per batch, and losing some of the one-transfer-per-token fee coalescing.

### Not planned, and why

- **A `multicall` on the settlement, and plural maker functions.** Both were argued and both were
  refused — `docs/specs/2026-09-08-delegation-and-bulk-maker-actions.md`, #133. The
  measurement is what decides it. Of five realistic maker situations the spec counts, the one a
  batch would fix costs eight transactions today, and the keyed nonce floor drops it to one
  without any batching at all. A batch makes eight cancels cheaper; the floor makes them
  unnecessary, and the floor needs no preimage, which is the constraint cheaper gas cannot touch.
  The capital half was already solved before either was proposed: `park` takes no authority, so a
  keeper folds any number of dead reservations into one transaction of their own. `parkMany` in
  particular would pay bytecode for something the outside world can already do. Four plural
  functions would also add a second unbounded array to the `MAX_BATCH_LEGS` finding the audit
  scope already carries, in a contract with 2,576 bytes of margin. This paragraph exists so the
  next person does not re-derive it.
- **Delegating a maker's rights to a contract.** Designed in Part 4 of the same spec, down to the
  destination problem, revocation and the ERC-1271 interaction. It ships only if somebody asks
  for it, and then only the cancel right, with an expiry, revocable in one `SSTORE` that never
  calls the delegate. Nobody has asked.
- **Share accounting for rebasing tokens.** It would spend the guarantee that a donation can
  never pay for a fill, and that guarantee is worth more than the tokens it would admit. An
  allowlist does the same job off chain.
- **Seeding fee-route liquidity.** The sell route for the buy-and-burn is its own holders' job.
- **Executor or maker hooks.** Decided against — `docs/specs/2026-08-12-hooks-design.md`.
- **x402 in the order-flow path.** The wrapper adds EIP-3009 to a token that already has permit.
  It is a token like any other, and it never enters the fill path.

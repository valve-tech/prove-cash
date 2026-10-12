# The solver, the pool graph and the bots

**Status: Proposed.** This is a normative spec. It states what each part MUST do, what it must
NEVER do, and why. It is not a code tour. When the code and this document disagree, the
disagreement is a finding, and Part 8 lists each one. Nobody changes the code to match this
document, or this document to match the code, without an owner decision.

Written on 2026-09-23 against commit `70bff5e`. That commit includes the pool graph and the
multi-hop executor (`dbe498f`, `1b02130`, `b99433e`, `6318d83`). Every code citation is a symbol
name, never a line number.

## Part 0: Scope, and what this supersedes

This document covers four things:

1. The solver engine: `sdk/src/solver/*`, except the three graph files.
2. The pool graph: `sdk/src/solver/graph.ts`, `graphsync.ts`, `subgraph.ts` and
   `app/scripts/poolcache.ts`.
3. The bots: `app/scripts/heartbeat.ts`, `watchdog.ts`, `market-mover.ts`, `executor.ts` and
   `solver.ts`, their units in the operator unit files, and the bot deploy script.
4. The operating rules that bind the bots and the scripts.

**It supersedes `2026-08-12-solver-design.md` as the statement of intent.** `docs/README.md`
marks that document **Live**, but it describes five files (`book.ts`, `rings.ts`, `size.ts`,
`price.ts`, `plan.ts`). The solver now has more than twenty. That document is still correct as
the derivation of the ring algebra and the sizing. These parts of it are no longer true:

| Claim in 2026-08-12 | What replaced it |
|---|---|
| The ring condition carries a fee term, Π r·(1+φ)ⁿ ≤ 1, and two makers "must concede at least 16 bps" | The rebate went in `d49dbf8`, the owner fee in `84e8895`, and the fee moved inside the maker's number in `d1dd385`. `ringCondition` is Π r ≤ 1 with no fee term |
| "The owner can change" the fee | The maker signs `feeRate`. The protocol has no owner fee (`2026-08-26-neutral-protocol.md`) |
| A solver holds inventory until `fillBatchWithCallback` exists | The credit path (`settleRingCall`, `--credit`) exists, and the solver bot uses it |
| A ring is atomic or it is nothing | Tolerant rings (`settleTolerantRingCall`) and independent batches (`settleBatchCall`) exist, both off by default |
| A ring has at most three legs | `MAX_RING_LEGS` is 8. The default stays 3 (`2e2aa0f`) |
| An AMM leg is priced by router calls | Any `Market` closes a ring, priced by a local exact curve. Valuation uses the spot reserve ratio (`loadPrices`) |

When this spec reaches **Live**, `docs/README.md` should mark 2026-08-12 as "Algebra live;
superseded as a spec by 2026-09-23". This document does not edit that index.

### Words

- **MUST**, **MUST NOT**, **SHOULD** and **MAY** have their RFC 2119 meanings.
- A **leg** is one intent fill or one market swap inside a plan.
- A **plan** is one transaction the solver or the executor may send.
- The **pre-send simulation** is the `simulateContract` or `eth_call` that runs on the exact
  calldata, immediately before the send.
- **Native** means WPLS on the chain in question.
- Every requirement has an ID (S-, G-, B-, O-). Part 9 maps each ID to its tests.

---

## Part 1: Recorded decisions this spec rests on

These are the owner's own words, or rules written down at the time. The spec quotes them, and
it does not extend them.

| # | Decision | Source |
|---|---|---|
| D1 | "use the subgraph for discovery, chain for truth" | Owner, 2026-09-23. Recorded in the `subgraph.ts` header as "The owner's rule" |
| D2 | "do the backfill on startup as well for sure" | Owner, 2026-09-23. **Recorded nowhere in the repo before this document** |
| D3 | "just accumulate it. it will be a memory leak for sure" (so the graph has a cap and eviction) | Owner, 2026-09-23. **Recorded nowhere in the repo before this document** |
| D4 | The route "`tWBTC -> tUSDC -> WPLS` exists, and nothing asked for it". A one-hop quoter left tWBTC and tWETH unpriced on 943 | `graph.ts` header; commit `1b02130` |
| D5 | "Tokens are keyed by address. Symbols are for logs only: chain 369 has two DAIs 450 times apart" | Commit `dbe498f` |
| D6 | "A subgraph rank never qualifies a pool." | Commit `1b02130` |
| D7 | "The on-chain simulation before send stays the last word." | Commit `b99433e` |
| D8 | Restart only the units that were running: "a deploy of testnet bot fixes put mainnet back on the air" | Commit `487813c`; the bot deploy script |
| D9 | "Starting them is a decision, not a side effect of a deploy." The `-369` units stay stopped until the mainnet redeploy | the operator redeploy runbook Step 6; `docs/ROADMAP.md` Queued #78 |
| D10 | "A key in a URL path reaches access logs and every upstream hop" | Commit `287b57f` |
| D11 | Keys are derived as `keccak256(deployerKey ‖ label)`, because "an account nobody can recompute is how 630,000 testnet PLS was stranded" | `heartbeat.ts` header; the internal risk assessment PR.AA-01 |
| D12 | "Do not reach past this into the faucet's wallet. Its payout account is a live service" | `app/scripts/faucet.ts` header |
| D13 | "The executor's mainnet inventory is $5 of each token, which the owner chose today. The float is the loss ceiling." | Commit `a2e5fb3` |
| D14 | "The mainnet inventory table is deliberately empty. Those amounts are real money and the owner names them, not this file." | Commit `e9d6d08` |
| D15 | The ring leg default "is three again … now a decision somebody makes on the command line rather than one the bot makes for them" | Commit `2e2aa0f` |
| D16 | The maker-trust ledger is "Off by default, and that is not timidity. A cold ledger has proven nobody" | Commit `cae76fb` |
| D17 | "`--tolerant` is off and stays off until a live board says the loss rate clears the break-even the solver prints at startup" | `docs/ROADMAP.md`, Queued |
| D18 | "The TypeScript solver is the browser." Owner's call, 2026-08-14 | `2026-08-14-scale-and-rationing.md` |
| D19 | "Falling back is worse than failing." | Commit `0241a6a` |
| D20 | "A monitoring lie is worse than a missing bot." | Commit `9f6078b` |
| D21 | The `SETTLEMENT` line stays in each `-369` unit, because the zero in `sdk/src/config.ts` "is what keeps the public site dark on mainnet" | Commit `339412f`; `prove-executor-369.service` |

The operating rules in Part 5 also come from the operator's standing notes: "never spend from a
service wallet", "fund only recoverable accounts" and "use the valve gateway, not a third-party
node". This document is the first place in the repo that states the first rule as a rule.

---

## Part 2: The solver

### 2.1 What the solver is for

The solver reads the board, finds sets of intents that pay for each other, and settles each set
in one transaction. A set can close through a market. The solver earns only the surplus that is
left after every maker gets at least their signed rate.

### 2.2 The engine

- **S-1.** The engine (`solve`, `findRings`, `sizeRing`, `planOf`) MUST be a pure function of a
  book, market state and a timestamp. It MUST NOT do I/O. *Why:* the hard cases (a ring that
  opens only after decay, or one that rounding kills) must be testable without a chain
  (2026-08-12, "Shape of the implementation").
- **S-2.** The engine MUST use chain time (`plan.at`, the block timestamp) and never
  `Date.now()`. *Why:* the wall clock runs seconds ahead of `block.timestamp`. That broke three
  things in one day.
- **S-3.** Every amount MUST be a `bigint`, and the rounding MUST match the contract wei for wei
  (`ceilDiv`, `legPay`). *Why:* a ring that clears in floating point and fails in integers is a
  revert that the solver pays for.
- **S-4.** A ring MUST satisfy `ringCondition`: the product of the leg rates is at most 1. There
  is no fee term (see Part 0).
- **S-5.** A sized ring MUST have a profit above zero after integer rounding. The minimum-fill
  rule is `take ≥ minFill` or `take = remaining`. The engine retries once, and then fails with
  `below-min-fill` (`52da1f7`: "One retry, not a search").
- **S-6.** A pinned leg (partial fills off) MUST fix the whole ring's size.
- **S-7.** A plan's net value MUST beat `minNetNative` after gas. The engine MUST keep a plan
  with an unpriced surplus, and it MUST NOT count that surplus as profit.
- **S-8.** The engine MUST NOT build a ring that holds the same market twice (`makeRing`), and
  MUST NOT revisit a token in one path.
- **S-9.** `maxLegs` defaults to 3 and MUST be clamped to [2, `MAX_RING_LEGS` = 8]. Raising it is
  an operator decision on the command line (D15). *Why:* longer rings widen the mempool race
  that ECON-AUDIT E-3 leaves "Open (mitigated, not closed)".
- **S-10.** The plan list is a menu, not a schedule. `selectDisjoint` MUST NOT send two plans
  that share an intent.
- **S-11.** `profitableFrom` finds the earliest time a Dutch ring opens. `ringDeadline` MUST be
  the earliest signature or intent expiry, minus one second.

### 2.3 Eligibility and the book

- **S-12.** Eligibility MUST come from the chain's `fillability` (through `fillabilityCall`,
  with all five arguments). The solver MUST NOT re-derive the contract's rules off chain. *Why:*
  "that is how a solver and a settlement contract drift apart" (2026-08-12).
- **S-13.** `buildBook` MUST drop an intent with nothing left to fill, and an intent whose
  `tokenIn` equals its `tokenOut`.
- **S-14.** A failed chain read MUST NOT look like a dead offer. Where a read fails, the solver
  errs toward trying (the Permit2 bitmap) or toward unreachable (the parked row), and never
  toward "refused". *Why:* "a rate limit must never look like a dead offer" (`arming.ts`).
- **OPEN QUESTION (owner) OQ-S1.** Today a failed `available` or `fillability` read drops the
  intent silently. It is in neither the book nor `rejected`. Options: (a) report it as
  `unread`, the way `onReadFailure` does in `price.ts`; (b) keep the silent drop and write it
  down.

### 2.4 Arming (legs the solver funds before it fills)

- **S-15.** `EscrowShort` on an armable leg means "arm it". Every other refusal MUST stay a
  refusal.
- **S-16.** A leg the chain already calls `Ok` MUST carry no arming bytes. *Why:* arming spends
  a 2612 or 3009 nonce for nothing.
- **S-17.** A welded intent (`authNonce ≠ 0`) MUST NOT be funded from parked capital. *Why:* the
  invariant suite found double funding, and the chain answers `BadTerms`.
- **S-18.** An authorization the maker attached MUST win over their parked capital.
- **S-19.** A leg is armable only inside its signature's window. EIP-3009 is exclusive at both
  ends. 2612 and Permit2 are inclusive. A parked leg answers only to the intent's own window.
  A leg outside its window MUST NOT be a ring candidate.
- **S-20.** Each maker has one nonce counter. Permit legs in a group MUST use consecutive nonces
  that start at the token nonce when the solver knows it. At most one unresolved permit leg is
  admitted per group.

### 2.5 Groups, ordering and rivals

- **S-21.** Legs interact only through (maker, tokenIn). The wallet balance and the parked row
  are two separate budgets. `bestSubset` is an exact search inside one partition. It MUST refuse
  (throw) above 20 legs rather than hang.
- **S-22.** `orderAtomicLegs` puts the least certain leg first. The score is ordinal, not a
  probability. A leg that a rival has claimed in the mempool MUST outrank every other signal.
  The reorder MUST NOT add fee transfers, MUST keep a 2612 permit queue in order, and MUST NOT
  touch the inventory (`fillBatch`) path.
- **S-23.** The mempool reader MUST match by selector and never by `to`. *Why:* 5 of the last 6
  rival transactions went to an executor the solver did not know. The reader MUST exclude the
  solver's own addresses, MUST NOT read the queued bucket, and MUST decode stranger calldata
  defensively. A `dryRun` is not a claim. When no method answers, it MUST throw, and the caller
  MUST redact the error.
- **S-24.** The engine MUST NOT build a ring around a leg a rival has claimed. *Why:* `mempool.ts`
  records that believing a lying mempool is the chosen error. A lie costs a missed ring, and
  ignoring a true claim costs a revert.

### 2.6 Sending

- **S-25.** A ring MUST send `skipInvalid = false`. The caller cannot choose it. A tolerant ring
  and an independent batch send `true`.
- **S-26.** The solver MUST simulate every plan before it sends it, with the same `skipInvalid`
  and the same leg order as the send. A failed simulation MUST throw without spending (ECON-AUDIT
  E-3). `skipPreflight` is opt-in and the bots never set it.
- **S-27.** A simulated ring MUST fill every leg (a tolerant ring: at least one). Any other
  count is a broken ring.
- **S-28.** The gas limit MUST be above the simulated figure (`gasBufferBps` = 2500). *Why:*
  "send at the node's own gas estimate and the ring reverts half-settled" (`bfdb277`).
- **S-29.** Fee fields reach a send only when the caller pins them. *Why:* a zero tip blocks the
  nonce lane on 943 (`a144b18`).
- **S-30.** The credit path MUST name its batch executor explicitly. It MUST NOT resolve one
  from the registry. A venue swap MUST pay the executor, never the solver and never
  `sinkTemplate()`. `maxFeeRate` MUST be the rate the plan was priced at.
- **S-31.** Approvals go to the relayer, never the settlement, and to the venue's spender.
- **S-32.** Every call shape MUST come from the generated ABI. *Why:* a hand-typed ABI "went
  stale in six entries" and still passed `tsc`.
- **S-33.** After a plan lands, `makersShortChanged` MUST check each landed leg's net `delivered`
  at the landing block's timestamp.

### 2.7 Tolerant rings, batches and trust (all off by default)

- **S-34.** A tolerant fallback MUST NOT spend more than the missing leg's `pay_k`. A market
  that asks more is refused, not clamped. `amountOutMin` MUST be the leg's `take`, never 0. A
  tolerant ring MUST never earn less than the atomic ring it replaces (`697b894`).
- **S-35.** `--tolerant` MUST stay off until a live board shows a loss rate under the printed
  break-even (D17).
- **S-36.** `packBatch` MUST admit only a plan with one fill and its own swap, MUST refuse
  `ANY_LEG`, MUST refuse a duplicate intent, MUST cap at 8 legs, and MUST NOT reorder. *Why:*
  swapless plans reverted for 81,900 gas in the lab.
- **S-37.** The trust ledger MUST count only a leg the chain still calls `Ok` after the block. A
  lost race MUST NEVER count against a maker. It is off by default (D16).

### 2.8 Prices and markets

- **S-38.** The xyk curve MUST equal UniswapV2 `getAmountOut` wei for wei. The venue that priced
  a leg MUST fill it: the router travels with the pool.
- **S-39.** No router is a default. *Why:* a default router gave a silent "no pool" on 943.
- **S-40.** A new venue MUST NOT need a change to any engine file (`Market`).
- **OPEN QUESTION (owner) OQ-S2.** `loadPrices` values tokens at the spot ratio of the deepest
  pool. A spot price can be moved inside one block. Options: (a) keep spot, since the pre-send
  simulation bounds the loss; (b) a TWAP; (c) cap how much value one token's price can carry.

### 2.9 Built, tested, and not wired into the bot

`bisect`, `confirm`, `chainDryRunner`, `brokenLegs`, `recoverPermitNonce`, the Permit2 bitmap
read and `MakerTrust` inside `confidence` all exist, and `app/scripts/solver.ts` uses none of
them.

- **OPEN QUESTION (owner) OQ-S3.** Should the bot confirm with `dryRun` and bisect before a send?
  Options: (a) yes, for credit rings; (b) no, the pre-send simulation is enough; (c) only after
  a `RingBrokenError`.
- **OPEN QUESTION (owner) OQ-S4.** Should the bot read the Permit2 bitmap and recover permit
  nonces? Without that, each permit group admits at most one permit leg. Options: (a) resolve
  the Permit2 target once at startup; (b) leave it off and accept the wasted arming attempts.
- **OPEN QUESTION (owner) OQ-S5.** Should the inventory path rotate each ring to the
  capital-minimal order? `0324f8b` says the current order is the maximum-capital one, and
  nobody decided it.
- **OPEN QUESTION (owner) OQ-S6.** Should a pending `cancel`, `withdraw` or `invalidateBefore`
  count as a rival claim (`30dc15f`)? It needs an index by maker and nonce.

---

## Part 3: The pool graph

### 3.1 What it is for

A one-hop quoter prices the direct pair and one hop through WPLS. On 943 that left tWBTC and
tWETH with no native value, because neither has a WPLS pool. The route
`tWBTC -> tUSDC -> WPLS` existed, and nothing asked for it (D4). The pool graph holds pools
and finds routes of up to three hops, so the executor can price and fill those intents.

### 3.2 Discovery and truth (D1)

- **G-1.** The subgraph MUST be used only to discover which pairs exist and in what order to
  read them. Nothing from the subgraph MUST set a reserve, a price, or a qualification (D1, D6).
  *Why:* "a subgraph field is a claim and a reserve is a fact", and anybody can create a pair.
- **G-2.** The subgraph's `trackedReservePLS` rank MUST only order discovery. It MUST NEVER
  qualify a pool.
- **G-3.** A listed pair MUST pass a chain read before the graph holds it: `token0`, `token1`,
  `factory` and `getReserves` (`checkPair`). A revert, another factory, or tokens that differ
  from the listing MUST reject the pair until the next discovery.
- **G-4.** Discovery MUST refuse a subgraph that is down, lags the head by more than 50 blocks,
  reports indexing errors, indexes another factory, or returns an error or a damaged row. A
  refusal MUST be a value with a reason, never a throw. *Why:* on 2026-09-23 the 369 subgraphs
  answered "database unavailable" and "chain was reorganized" in one run (`dbe498f`).
- **G-5.** Discovery MUST run in the background. It MUST NOT block a pass.
- **G-6.** Only a well-formed address MAY reach a subgraph query's text.

### 3.3 Identity (D5)

- **G-7.** A token MUST be keyed by its lowercase address, never by its symbol. Symbols are for
  logs only. *Why:* on 369 two tokens share each of these symbols: DAI (forked pDAI `0x6b17…`
  at about $0.0022, bridged `0xefd7…` at about $0.999), USDC, USDT, WETH, WBTC and HEX. A pool
  of one MUST NEVER price the other. This holds in the graph, the cache and the executor.

### 3.4 Qualification: the chain decides

- **G-8.** A pool qualifies only by chain reserves. Both of its tokens MUST have a native rate
  through a path from WPLS, and the pool's depth MUST be at or above the chain's `DEPTH_FLOOR`.
- **G-9.** A pool is only as deep as its cheaper side, and only sides the graph can already
  price count. A new token MUST NOT vouch for itself.
- **G-10.** With no native token, nothing qualifies.
- **OPEN QUESTION (owner) OQ-G1.** The floors are 10,000,000 WPLS on 369 (about $115 today) and
  1,000 WPLS on 943. An agent chose them; no owner decision records them. Options: (a) keep a
  fixed WPLS amount per chain; (b) set the floor in money and convert at the WPLS price.

### 3.5 Routes

- **G-11.** A route MUST have at most `maxHops` = 3 swaps. It MUST NOT mix venues. *Why:* the
  fill sells along the path in one router call, and a router walks only its own factory's pairs.
- **G-12.** The search MUST stay bounded (`topK` pools per token) and MUST always try the direct
  pool.
- **G-13.** A null graph quote means "the graph cannot price this". It MUST NOT mean "no route
  exists". The caller falls back to the router quote (`quoteAll`).
- **G-14.** The graph is not changed between a quote and its send. `prune` runs only inside a
  refresh, and the refresh finishes before the pass quotes. So eviction MUST NOT drop a pool
  from a route in flight.

### 3.6 The bound: cap and eviction (D3)

The owner expected accumulation to leak memory (D3). So the graph has a hard cap.

- **G-15.** The graph MUST NEVER hold more than `maxPools` pools (4,000 by default). The read
  queue MUST NEVER hold more than `maxPools × 2` pairs. The token index MUST shrink when pools
  leave: "A token index that only grows is the same leak as the pool map" (`graph.ts`).
- **G-16.** `prune` MUST evict in this order: pools not observed within `maxAgeBlocks`, however
  deep; pools that no longer qualify; a token's pools above `maxPerToken` (hubs exempt); then
  the shallowest pools above `maxPools`.
- **G-17.** The cap MUST NEVER keep a pool and drop the pool that prices its token. The cap
  ranks by the smaller of depth and the width of the pricing path.
- **G-18.** A pool's age MUST be measured against the gap-free coverage mark (`syncedTo`), not
  the chain head. "A block the graph has not observed cannot age anything."
- **OPEN QUESTION (owner) OQ-G2.** 4,000 comes from a heap measurement: 4,000 pools use 4.5 MB.
  Today's cold starts list 876 pairs on 369 and 374 on 943, so the cap does not bind. Is 4,000
  the owner's number? Options: (a) keep one default; (b) set it per chain; (c) tie it to a
  memory budget for the bot host.
- **OPEN QUESTION (owner) OQ-G3.** The read queue is sorted by subgraph rank and cut at
  `maxPools × 2`. In principle the rank can then decide whether a pair is ever read. That is
  close to G-2. Options: (a) allow it, since the cap does not bind today; (b) read the cut
  pairs in a later refresh.

### 3.7 Freshness

- **G-19.** Reserves come from `getReserves` and from `Sync` logs. An older `Sync` MUST NOT move
  reserves backwards. A `Sync` for a pair the graph does not hold MUST be ignored.
- **G-20.** A refused log range MUST stop coverage at that point. The graph is then not
  `usable`, and the next refresh reads the range again.
- **G-21.** After a gap longer than `maxCatchupBlocks` (1,000), the keeper MUST read every
  reserve again. A pool whose re-read fails is removed. If every read fails, nothing is removed
  and nothing is routed.
- **G-22.** The executor MUST quote from the graph only when `usable(head)` is true.
- **G-23.** The pre-send simulation MUST be the last word on freshness (D7). A graph price MUST
  NEVER reach a send without the simulation. The graph only decides which intents are worth a
  simulation.
- **OPEN QUESTION (owner) OQ-G4.** A single pool can be up to `maxAgeBlocks` (about 3 hours)
  old while the graph is `usable`. `GraphQuote.syncedAt` is reported and never checked. The
  simulation makes this safe for money, but it can waste simulations. Options: (a) refuse a
  path older than N blocks; (b) keep it as it is.
- **OPEN QUESTION (owner) OQ-G5.** A venue whose subgraph never recovers keeps its old listing,
  so its pools stay while `Sync` coverage has no gap. Is that the intent? Options: (a) yes,
  fall back to what the graph holds; (b) expire a listing after N failed discoveries.

### 3.8 Startup and the cache (D2)

The owner asked for a backfill at startup (D2).

- **G-24.** On a cold start the executor MUST run one bounded discovery and read (`warmUp`,
  at most 90 s) before its first pass.
- **G-25.** On a warm start the executor MUST NOT wait. Its first refresh catches up from `Sync`
  logs, or re-reads everything after a long gap, and starts discovery.
- **G-26.** A bad cache file MUST give a cold start, never a crash. A file from the other chain
  MUST load empty. A damaged row MUST be dropped. A `syncedTo` past the newest block MUST NOT
  be trusted. A loaded cache MUST still obey the cap. A cached pool whose venue or fee the
  registry no longer agrees with MUST be dropped (`reconcileWithVenues`).
- **G-27.** A cache write MUST be atomic (temporary file, then rename). Load and save MUST NOT
  throw.
- **G-28.** `--no-graph` MUST give back exactly the pre-graph behaviour.
- **OPEN QUESTION (owner) OQ-G6.** `warmUp` gets an empty token list, so the startup backfill
  covers only registry tokens. A board token waits about 30 blocks for an early discovery. Does
  D2 include board tokens? Options: (a) read the board before `warmUp`; (b) accept the delay.

---

## Part 4: The bots

### 4.1 Rules for every bot

- **B-1.** Each bot MUST import `./guard` first. An uncaught error MUST be redacted and MUST end
  the process with exit 1, so systemd restarts it.
- **B-2.** Each bot MUST check the node's chain id at startup (`assertChainId`) and refuse a
  node on another chain.
- **B-3.** A bot MUST refuse to start against a settlement that the deployment record did not
  make, or against the zero address. *Why:* a bot that runs green against a contract nobody
  deploys to is a monitoring lie (D20).
- **B-4.** Each bot key MUST be derived from its own chain's deployer, as
  `keccak256(deployerKey ‖ 'prove.cash/<role>')` (D11). Mainnet and testnet keys MUST differ.
  No deployer key MUST reach the bot host. *Why:* one key across both chains would put real money
  under a key that guards testnet play money on a small VPS (`339412f`).
- **B-5.** A key MUST come from an environment file with mode 600. It MUST NOT appear on a
  command line, where `ps` shows it.
- **B-6.** A bot that funds an account (`--fund`) MUST NOT send more than half of what the
  deployer holds (`e9d6d08`).
- **B-7.** Mainnet inventory amounts are the owner's to name. Code MUST NOT pick them (D13, D14).

### 4.2 Heartbeat

The heartbeat keeps signed intents on the board. It proves the whole path on every post: sign,
encode, grind, post, read back, verify.

- **B-8.** The heartbeat MUST refuse to start on the JavaScript proof-of-work grind unless
  `--allow-js-grind` is set. *Why:* the bundle once lost its wasm engine and ground about 4× slower
  for ten hours while it reported nothing wrong.
- **B-9.** On 369 it MUST refuse to start without `HEARTBEAT_KEY`. On 943 it MAY make a
  throwaway key.
- **B-10.** On 369 each intent MUST stay under the `MAX_IN` cap (about $1 each).
- **B-11.** The heartbeat MUST walk its sides round-robin, and the start point MUST move forward
  each round. *Why:* posting is bound by proof-of-work, so a fixed walk starves whatever was
  added last.
- **B-12.** After a restart it MUST adopt its own live intents from the board, and it MUST NOT
  grind duplicates.

### 4.3 Watchdog

- **B-13.** The watchdog holds no key and MUST NOT send transactions.
- **B-14.** It MUST check the board, the messages, the terms, the archive and every `Filled`
  event. A fill that paid a maker less than `gross − feeOn(gross)` is BROKEN, and the watchdog
  MUST exit with code 3.
- **OPEN QUESTION (owner) OQ-B1.** No unit sets `WEBHOOK`, so alerts reach only journald.
  the internal risk assessment calls the alert channel unconfigured. Options: (a) set a webhook;
  (b) accept journald only, and say so in the risk assessment.

### 4.4 Market mover

- **B-15.** The mover MUST run only on 943. It hard-codes `CHAIN = 943` and has no `--chain`.
  A mainnet mover unit MUST NOT exist until the script has a chain flag, a real pair and a size
  in money. *Why:* the script sizes trades as a fraction of the reserve, and on a mainnet pool
  that spends thousands of dollars a swap (the bot deploy script).
- **B-16.** Without `--send` the mover MUST NOT send.

### 4.5 Executor

The executor fills single intents the market pays for, and checks that each maker got the rate.

- **B-17.** The executor MUST fill only an intent that clears its gate: spread at or above
  `--min-spread` (default 50 bps; the units set 10), and value above the gas floor
  `gas × (baseFee + tip) × (1 + --gas-margin)` (default margin 2500 bps).
- **B-18.** On the zero-inventory path, `amountOutMin` MUST be `cost + margin`. The router then
  reverts a fill the pool no longer pays for.
- **B-19.** Every fill MUST be simulated before the send (G-23, D7).
- **B-20.** Every intent a pass does not fill MUST be counted under exactly one skip reason:
  `no-quote`, `below-cost`, `thin-spread`, `executor`, `unvalued`, `model-gas`, `refused`, `gas`
  or `dry-run`. Each pass MUST print one line with the counts. *Why:* a bot that sits still must
  say why.
- **B-21.** After each fill, the executor MUST compare the maker's `tokenOut` balance change with
  `quoteFill(...).delivered` at the landing block's timestamp. On a shortfall it MUST log
  `ALERT the maker was short-changed` and exit 2. *Why:* this is "the assertion this bot exists
  for". It checks `delivered`, not the gross, because the fee comes out of the maker's number.
  It prices at the landing block, because the pass-start price fired nine false alarms on
  2026-08-28 (`12d417e`).
- **B-22.** The executor MUST fill through the `ProveExecutor` in the deployment record. It MUST
  NOT take that address from a unit file.

### 4.6 Solver bot

- **B-23.** Without `--execute` the solver MUST NOT send.
- **B-24.** With `--credit <executor>` the solver MUST check at startup that the executor has
  code and that its `settlement()` equals the settlement in use. On a mismatch it MUST exit
  non-zero and MUST NOT fall back to another path (D19).
- **B-25.** `--batch` and `--tolerant` MUST refuse to start unless `--credit` and `--amm` are
  also set.
- **B-26.** The solver MUST stop sending while three or more of its own transactions are queued
  (`STUCK_LIMIT`).
- **B-27.** The solver MUST NOT send a plan whose net is under `--min-profit-native` (default 0
  on 943, 500 on 369). The unit passes no value, so the default stays in one place (`9f6078b`).
- **B-28.** `--max-grief-native` bounds what unproven legs may cost. It is off by default (D16).
- **B-29.** After a plan lands, the solver MUST run `makersShortChanged` over the landed legs.
  On a shortfall it MUST log `ALERT` and exit 2.
- **OPEN QUESTION (owner) OQ-B2.** 81725d6 ends with a decision for somebody else: "raise the
  float so the market posts real sizes, or keep mainnet as a liveness proof and stop expecting
  fills." Options: (a) raise the float; (b) liveness only.

### 4.7 Units and the deploy

- **B-30.** The units MUST live in the repo (the operator unit files). the bot deploy script MUST ship every
  unit, not a subset. *Why:* a unit that lived only on the box ran on defaults after a flag
  rename.
- **B-31.** Each `-369` unit MUST carry `Environment=SETTLEMENT=<address>` by hand. Nobody MUST
  move that address into `sdk/src/config.ts` or the registry (D21).
- **B-32.** the bot deploy script MUST build the SDK first, check every copied address against the
  deployment records, parse each bundle with `node --check` before any restart, and refuse to
  ship without the wasm engine.
- **B-33.** the bot deploy script MUST restart only the units that were active before the deploy. It
  MUST NOT start or enable a stopped unit. It MUST print "left stopped, not started by this
  deploy" for each stopped unit (D8). *Why:* on 2026-08-28 the script put the four mainnet
  units on the air for four minutes.
- **B-34.** the bot deploy script MUST NOT create or overwrite an env file. A person installs each
  one by hand.

---

## Part 5: Operating rules

These bind every bot and every script in the repo.

- **O-1. The gateway key goes in an `X-API-Key` header, never in a URL path.** *Why:* "A key in
  a URL path reaches access logs and every upstream hop" (D10). The one known exception is a
  `forge script` broadcast, which uses the public `vk_demo` key. **The bots do not follow O-1
  today.** See Part 8, C1.
- **O-2. A logged URL or error MUST be redacted.** `redact` and `describe` strip `/rpc/<key>/`,
  credentials in the userinfo, and the live key anywhere in the text. A key MUST be shown only
  as six characters and a length (`rpcLabel`). *Why:* one caught viem error printed the
  registry key 32 times (`6e11820`).
- **O-3. Use the valve gateway, never a third-party node.** *Why:* a third-party node dropped
  transactions in silence.
- **O-4. Never spend from a service wallet.** Before any script sends from an account, the
  operator MUST know what the account is. A faucet's payout account is a live service (D12).
  *Why:* spending from it once drained a live faucet and jammed its nonce.
- **O-5. Fund only recoverable accounts.** Every funded bot account MUST be derivable from a
  deployer key (D11). Funding MUST be sized to need. *Why:* 630,000 testnet PLS is gone because
  neither rule was followed.
- **O-6. The `-369` bots stay stopped until the mainnet redeploy (#35).** Starting them is a
  decision, not a side effect (D9). Only the runbook's Step 6 starts them.

- **OPEN QUESTION (owner) OQ-O1.** The runbook now broadcasts with
  `FOUNDRY_ETH_RPC_HEADERS='["X-API-Key: vk_demo"]'`, which is the header form. Is the forge
  broadcast exception to O-1 still needed? Options: (a) delete the exception; (b) keep it and
  record the case it covers in the runbook.

---

## Part 6: Open questions, in one list

| ID | Question | Options |
|---|---|---|
| OQ-S1 | Report an intent whose read failed, or drop it silently? | (a) report as `unread`; (b) keep the drop |
| OQ-S2 | Spot or resistant native valuation? | (a) spot; (b) TWAP; (c) cap per token |
| OQ-S3 | `dryRun` and bisect before send? | (a) credit rings; (b) no; (c) after `RingBrokenError` |
| OQ-S4 | Read the Permit2 bitmap, recover permit nonces? | (a) yes; (b) no |
| OQ-S5 | Capital-minimal rotation on the inventory path? | (a) yes; (b) no |
| OQ-S6 | Pending `cancel`/`withdraw`/`invalidateBefore` as rival claims? | (a) yes, with a maker-and-nonce index; (b) no |
| OQ-S7 | Is the `endTime` bound exclusive everywhere (C4)? | (a) `until = endTime − 1`; (b) keep inclusive, and `ringDeadline` alone is authoritative |
| OQ-S8 | Should `confidence` see parked legs (C5)? | (a) score as funded escrow; (b) a new weight; (c) keep the floor on purpose |
| OQ-S9 | Where is the risk of `maxLegs` above 3 accepted in writing? | (a) in ECON-AUDIT E-3; (b) the CLI flag is enough |
| OQ-S10 | When is `DEPTH_943` re-cut from the archive, and does 369 need a table? | open |
| OQ-G1 | Depth floor: fixed WPLS or money? | (a) WPLS; (b) money |
| OQ-G2 | Is 4,000 pools the owner's cap? | (a) one default; (b) per chain; (c) memory budget |
| OQ-G3 | May the subgraph rank decide which pairs are read at all? | (a) yes; (b) read the rest later |
| OQ-G4 | Refuse a stale path before simulation? | (a) yes, N blocks; (b) no |
| OQ-G5 | Keep a dead venue's listing forever? | (a) yes; (b) expire it |
| OQ-G6 | Does the startup backfill include board tokens? | (a) yes; (b) accept the delay |
| OQ-G7 | Where does the graph cache live in production (C3)? | (a) `StateDirectory=` plus `POOL_GRAPH_CACHE`; (b) accept a cold start on every restart |
| OQ-B1 | Watchdog alert channel? | (a) webhook; (b) journald only |
| OQ-B2 | Mainnet executor: raise the float, or liveness only? | (a) raise; (b) liveness |
| OQ-B3 | Mainnet units: disabled or enabled while stopped (C2)? | (a) disable, and Step 6 runs `enable --now`; (b) keep enabled, and record the reboot risk |
| OQ-B4 | Executor alarm on a reverted fill (C6)? | (a) check `receipt.status` first, log FAIL, do not exit; (b) keep exit 2 |
| OQ-B5 | Zero-inventory path on 943 (C9)? | (a) add 943 to `DEPLOYED`; (b) keep the float, fix the unit comment |
| OQ-B6 | Solver state on the box (C8)? | (a) `StateDirectory=` for the trust ledger; (b) accept the loss |
| OQ-O1 | Is the forge broadcast exception to O-1 still needed? | (a) delete it; (b) record it |
| OQ-O2 | Move the bots to the header (C1)? | (a) viem `fetchOptions` plus an SDK change for the board URL; (b) record the path form as an accepted exception |

---

## Part 7: Things this spec does not decide

The contract's fee arithmetic, the intent format and the settlement's checks belong to
`2026-08-10-prove-cash-design.md` and to the contract. This document cites them and does not
restate them. The browser solver (D18) runs the same engine and is bound by Part 2 only.

---

## Part 8: Contradictions between the code and recorded decisions

Each item is a finding. I checked C1, C4, C5 and C6 in the code myself. Nothing here is fixed.

- **C1. The bots put the gateway key in the URL path.** `rpcUrl` in `app/scripts/rpc.ts` builds
  `https://one.valve.city/rpc/<key>/evm/<chain>`. That breaks O-1 and D10. Commit `287b57f`
  moved only the fork tooling and CI to the header. The fallback in `sdk/src/config.ts` and the
  comments in `devnet.ts`, `solver-devnet.ts`, `lab/curve-onchain.ts` and `sdk/README.md` use the
  same path form. `redact` limits the damage in logs, but the key still reaches the gateway's
  access logs and every hop. (OQ-O2.)
- **C2. The four mainnet units are stopped, but still enabled.** the bot deploy script follows D8, but
  every unit has `WantedBy=multi-user.target`. `487813c` says they were left "Stopped again,
  still enabled", and `4e0f770` says "the mainnet copies are one reboot from running". A reboot
  of the bot host breaks O-6 and D9. The repo cannot show the box's state. (OQ-B3.)
- **C3. The graph cache never survives a restart in production.** `defaultCachePath` falls back
  to `tmpdir()`. Both executor units set `PrivateTmp=true` and no `POOL_GRAPH_CACHE`, and systemd
  deletes a private `/tmp` when the unit stops. So every restart is a cold start, and G-25
  never runs in production. An env file on the box could set the variable; the repo cannot show
  that. (OQ-G7.)
- **C4. `armableAt` accepts `at == endTime`, and the chain does not.** `armingWindow` sets
  `until = endTime` and `armableAt` tests `at <= until`. The contract returns `Expired` when
  `block.timestamp >= endTime`. `ringDeadline` subtracts one second, but the candidate filter in
  `findRings` does not. (OQ-S7.)
- **C5. A parked leg scores the lowest custody confidence.** `custodyPoints` calls
  `armingKind(fill.intent)` with no parked row, so a leg armed with `PARKED_ARMING` falls to the
  `default: return 0` floor. The leg funded inside the contract then sorts as the least certain.
  `446dc17` fixed the same class of bug in `armingWindow`. (OQ-S8.)
- **C6. The executor's short-change alarm fires on a reverted fill.** After the send, `tick`
  waits for the receipt and never reads `receipt.status`. A reverted fill moves the maker's
  balance by zero, which is less than owed. The bot logs `ALERT the maker was short-changed` and
  exits 2, and systemd restarts it. B-18 expects the router to revert when a pool moves, so this
  can happen in normal operation. The balance method can also count another transfer to the
  same recipient in the same block. (OQ-B4.)
- **C7. The skip tally misses two exits.** The `catch` in `inventoryFill` does not call
  `skip('refused')`, and `zeroInventoryFill` returns at `margin === null` without a skip. That
  breaks B-20 and the code's own comment ("Every exit from the fill loop … counts under exactly
  one of these"). The 943 unit runs the inventory path, so its refusals do not show.
- **C8. The trust ledger cannot be written on the box.** It goes to the relative path
  `.solver-trust.<chain>.json`. The units set `ProtectSystem=strict` and no `WorkingDirectory`.
  This matters only when `--max-grief-native` is on. (OQ-B6.)
- **C9. The 943 executor unit comment is stale.** It says a recorded executor makes "this unit
  pick up the zero-inventory path with no edit". `943.json` records a `ProveExecutor`, and
  `DEPLOYED` holds only 369 on purpose. (OQ-B5.)
- **C10. Stale text that states intent wrongly.**
  - `ROADMAP.md` says the solver "caps a ring at three legs" and "settles each one in a single
    `fillBatch`". The ceiling is 8, and the bot uses `settleRing` with `--credit`.
  - `SizedRing.capital` still describes the `Σ p − max p` formula that the 2026-08-12 spec
    retracted.
  - The `perFault` comment says two faults pull a proven maker below an unproven one. One
    fault does.
  - `DEPTH_943` says mainnet has no settlement yet.
  - Two 943 units say "Shared by all three bots". There are five.
- **C11. The SDK and the bot disagree on one default.** `DEFAULT_TRUST.maxUnprovenPerRing` is 1,
  and the bot defaults to no limit. `cae76fb` records why, so this is intended, but the SDK
  default then has no user.
- **C12. Two owner decisions were recorded nowhere.** D2 and D3 existed only in conversation
  before this document.
- **C13. A three-hop graph quote carries the label `route: 'wpls'`.** `bestQuote` gives that label
  to any path of more than two tokens, even one that does not pass through WPLS. Nothing reads
  the label for a graph quote today.

Smaller engine defects the solver research found, not verified by me: `fallbackSwaps` drops a
fallback whose market returns no call and still reports `complete: true`; `packBatch` leaves its
`spoken` key and swept tokens behind on a null market swap.

---

## Part 9: Traceability

Test files are relative to `sdk/src/solver/` unless the path says otherwise. `(anvil)` means the
test skips when anvil is missing. `(live)` means it runs only with `PROVE_LIVE=1`.

| MUST | Test(s) |
|---|---|
| S-1 | Whole engine suite in `solver.test.ts` runs with no chain (by construction) |
| S-2 | Indirect only: `execute` uses `plan.at`. **No direct test** |
| S-3 | `solver.test.ts` › "the chain balances…", "rounding kills a ring…" |
| S-4 | `solver.test.ts` › "the ring condition" (six tests), "the two makers together have to concede nothing at all" |
| S-5 | `solver.test.ts` › "a maker who will not sell in small pieces" (five), "rounding kills a ring…" |
| S-6 | `solver.test.ts` › "an all-or-nothing leg" (four) |
| S-7 | `solver.test.ts` › "a ring smaller than its own gas" (three) |
| S-8 | `solver.test.ts` › "every rotation is offered…". **Same-market rule untested** |
| S-9 | Three-leg tests only. **Clamp untested** |
| S-10 | `solver.test.ts` › "an intent in two candidate rings" (three) |
| S-11 | `solver.test.ts` › "a ring that only the Dutch decay opens" (eight); `ringDeadline` tests |
| S-12 | `book.test.ts` › "carries the fee bound the contract asks for"; arming block "a leg the chain refuses and the solver can arm" |
| S-13 | `solver.test.ts` › "an exhausted intent is not in the book at all". **Self-pair drop untested** |
| S-14 | `arming.test.ts` › "not knowing errs toward trying", "a word that never came back…", "a row that never came back…" |
| S-15 | `arming.test.ts` › "an escrow leg the solver can fund is reachable…", "every other refusal stays a refusal…" |
| S-16 | `arming.test.ts` › "a leg the chain already fills carries no arming at all"; `book.test.ts` › "…no nonce is spent on it" |
| S-17 | `arming.test.ts` › "an offer welded to a sibling is never funded this way…" |
| S-18 | `arming.test.ts` › "an authorization the maker attached wins over their parked capital" |
| S-19 | `window.test.ts` › "armingWindow" (six), "the search refuses a leg whose signature is not usable yet"; `arming.test.ts` › "a parked leg answers to the intent's own clock…" |
| S-20 | `groups.test.ts` › "one maker, two permits, one nonce counter" (seven) |
| S-21 | `groups.test.ts` › "one maker and one token is the whole of the key", "a wallet leg and a parked leg never spend each other's budget", "a partition too large to enumerate refuses rather than hanging" |
| S-22 | `confidence.test.ts` › "the custody ladder decides the order…", "two legs sharing a fee run stay adjacent…", "the reorder never pays for more fee transfers…"; `mempool.test.ts` › "a claimed leg outranks every other signal put together". **Inventory-path exclusion untested** |
| S-23 | `mempool.test.ts` › "a credit ring is read even though it is addressed to the rival own executor", "every fill entry point on all three contracts has a selector", "neither method answering is thrown…", and the own-address and queued-bucket tests |
| S-24 | `mempool.test.ts` › "a ring is not built around a leg somebody else has claimed" (four) |
| S-25 | `credit.test.ts` › "skipInvalid is false, whatever anybody wants"; `pack.test.ts` › "a batch is sent tolerantly and a ring is not"; `tolerant.test.ts` › "the atomic call sends skipInvalid false and the tolerant one sends true" |
| S-26 | `preflight.test.ts` › "a broken ring never reaches the wallet", "skipPreflight sends without asking, and is opt-in"; `tolerant.test.ts` › "a tolerant ring is simulated with skipInvalid true…" |
| S-27 | `preflight.test.ts` › "a count that is not every leg counts as broken"; `tolerant.test.ts` › "a short count is a refusal for a ring…" |
| S-28 | **Untested** |
| S-29 | `solver.test.ts` › "the fees a caller pins reach the batch", "…sends no fee fields at all" |
| S-30 | `credit.test.ts` › "it refuses to build a ring with no executor named", "the venue pays the executor and not the solver", "the fee bound the plan was priced at reaches the call"; `executor.test.ts` › "the venue pays the executor and not the bot" |
| S-31 | `solver.test.ts` › "an intent leg names the relayer, never the settlement", "the pool leg still names the router" |
| S-32 | `credit.test.ts` › "the encoder still produces the bytes the executor is tested against"; `executor.test.ts` › "every argument encodes against the compiler's own ABI…" |
| S-33 | `solver.test.ts` › "checking the fill after it lands" (three) |
| S-34 | `tolerant.test.ts` › "a market asking more than the missing leg frees is refused, not clamped", "the bound is what the missing leg was going to supply" |
| S-35 | `tolerant.test.ts` › "nothing turns this on by itself" |
| S-36 | `pack.test.ts` › "one fill with its own swap is independent…", "a plan with no swap of its own is refused…", "a ring is refused, and says why", "an intent already spoken for…", and the cap test |
| S-37 | `trust.test.ts` › "only a leg the chain still calls fillable…" plus the `test.each` over every other reason |
| S-38 | `solver.test.ts` › "the pool curve, against PulseX itself" (three) |
| S-39 | **Untested** |
| S-40 | `market.test.ts` › "a venue format the engine was never taught" (four) |
| G-1, G-2 | `graphsync.test.ts` › "the subgraph never sets a reserve: the chain read does"; `graph.test.ts` › "a pair a subgraph ranks first, with almost nothing on the priced side, is not routed", "a real pool behind a real, deep path qualifies, however the subgraph ranked it" |
| G-3 | `graphsync.test.ts` › "a pair another factory made is rejected", "a pair whose tokens the chain names differently…", "an address that is not a pair…", "an unreadable pair is kept in the queue…" |
| G-4 | `subgraph.test.ts` › "`${name}`: a failure with reason …, never a throw", "a hung subgraph is cut off at the timeout", "a source recorded for another factory is refused before any request" |
| G-5 | `graphsync.test.ts` › "a refresh returns while a discovery is still in flight" |
| G-6 | `subgraph.test.ts` › "only well-formed addresses reach the query text" |
| G-7 | `graph.test.ts` › "each DAI is priced from its own pools, 450 times apart", "a pool of one DAI never answers for the other", "the cache keeps them apart too"; `subgraph.test.ts` › "two tokens called DAI stay two tokens" |
| G-8, G-9 | `graph.test.ts` › "a token cannot vouch for itself…", "a pool pushed off the market price counts only as deep as its cheap side", "a token takes its price from the widest path…", "every one of the five pools qualifies at the 943 floor". **369 floor value untested** |
| G-10 | `graph.test.ts` › "no native token: nothing qualifies…" |
| G-11 | `graph.test.ts` › "a three-hop route is found", "maxHops is a hard stop", "a path never mixes venues…" |
| G-12 | `graph.test.ts` › "the direct pool is always tried…", "the search stays bounded with a hub of a thousand pools" |
| G-13 | **Untested** |
| G-14 | **Untested** (holds by construction) |
| G-15 | `graph.test.ts` › "whatever arrives, size never passes maxPools and the survivors are the deepest", "eviction unlinks the token index…", "4,000 pools fit in a few megabytes…"; `graphsync.test.ts` › "a subgraph listing 10,000 pairs leaves the queue and the graph inside their caps" |
| G-16 | `graph.test.ts` › "a pool nobody observed inside maxAgeBlocks is evicted, however deep", "a flood of fresh pairs of one unknown token cannot crowd out the rest", "the cap keeps the deepest by chain reserves, not the first read" |
| G-17 | `graph.test.ts` › "the cap never keeps a pool and drops the pool that prices its token", "evicting the pool that priced a token takes out the pools that needed it" |
| G-18 | `graph.test.ts` › "touch never moves a pool past the gap-free coverage mark"; `graphsync.test.ts` › "a warm start with the subgraph down keeps its cached pools past the staleness window", "a pool discovery stops listing, and nobody trades, ages out" |
| G-19 | `graph.test.ts` › "an older Sync never walks reserves backwards", "a Sync for a pair the graph does not hold is ignored…" |
| G-20 | `graphsync.test.ts` › "a refused log range stops coverage there…" |
| G-21 | `graphsync.test.ts` › "a gap longer than maxCatchupBlocks reads every reserve again…", "after a long gap, a pool whose re-read fails is removed…", "after a long gap with the endpoint down, nothing is removed and nothing is routed" |
| G-22 | **Untested** (`bestQuote`) |
| G-23 | `graph.test.ts` › "the stale quote overstates, and the bound built from it is what makes the fill revert" covers the idea. **Executor path untested** |
| G-24 | `graphsync.test.ts` › "discovers, reads every pair from the chain, and prices tWBTC and tWETH through tUSDC". **Executor startup wiring untested** |
| G-25 | **Untested** in the executor |
| G-26 | `graph.test.ts` › "the cache file" (seven cases), "a damaged row is dropped and the rest load", "a coverage mark past the newest block…", "a loaded cache is still subject to the bound"; `graphsync.test.ts` › "is dropped rather than priced at an old fee"; `app/scripts/poolcache.test.ts` (five) |
| G-27 | `app/scripts/poolcache.test.ts` (five) |
| G-28 | **Untested** |
| All routes | `graph.live.test.ts` (live) checks every multi-hop route against `getAmountsOut` in the same block |
| B-1 | **Untested** (`guard.ts`) |
| B-2 | `app/scripts/rpc.test.ts` › `assertChainId` (four), including "keeps the registry key out of the refusal it prints" |
| B-3 | `app/scripts/deployment.test.ts` › "the executor bot" › "refuses to start on a settlement the deploy did not make", `settlementFault` (three). **Heartbeat zero-settlement refusal untested** |
| B-4, B-5 | **Untested** |
| B-6 | **Untested** |
| B-7 | Not testable. It is a rule for people |
| B-8 | `app/scripts/pow.test.ts` › "stops a bot that would grind in JS…" |
| B-9, B-10, B-11, B-12 | **Untested** |
| B-13, B-14 | **Untested** |
| B-15, B-16 | **Untested** |
| B-17, B-18 | **Untested** (`clears`, `gasFloor`) |
| B-19 | **Untested** in the executor |
| B-20 | **Untested** |
| B-21 | **Untested** in the executor |
| B-22 | `app/scripts/deployment.test.ts` › "the executor bot" |
| B-23 | **Untested** |
| B-24 | `app/scripts/deployment.test.ts` › `creditFault` (four), `readCreditFault` (three); "the solver bot" › "refuses an executor bound to another settlement", "…with no code", "starts with an executor bound to this settlement" (anvil) |
| B-25 | `app/scripts/flags.test.ts` (all) |
| B-26, B-27, B-28 | **Untested** |
| B-29 | `solver.test.ts` › "checking the fill after it lands" covers `makersShortChanged`. **The bot's exit 2 is untested** |
| B-30 | **Untested** |
| B-31 | `app/scripts/check-addresses.test.ts` › "and every 369 unit carries the settlement line", "catches a unit whose name and ExecStart disagree about the chain", "is the address the mainnet units carry" |
| B-32 | Address check: `check-addresses.test.ts`, also run in CI. **The script's order untested** |
| B-33, B-34 | **Untested** |
| O-1 | **Untested**, and broken in the bots (C1) |
| O-2 | `app/scripts/rpc.test.ts` › `redact` (five), `describe` › "keeps no credential from a viem error"; CI gate `tools/check-redact.py` |
| O-3, O-4, O-5, O-6 | Not testable in code. They are rules for people and for scripts. O-6 depends on B-33 and on C2 |

### Untested MUSTs (findings)

The requirements below have no test. The ones marked **(money)** guard funds or a live alarm, and
they come first.

1. **B-21 (money).** The executor's short-change alarm and its exit. C6 shows it is also wrong on
   a revert.
2. **B-17, B-18 (money).** The executor's profit gate and its `amountOutMin` bound.
3. **G-23, B-19 (money).** No test shows that an executor graph price always passes the
   simulation before a send.
4. **B-29 (money).** The solver bot's exit on a short change. Only the SDK helper is tested.
5. **B-33 (money).** Restart only running units. This rule exists because it failed once.
6. **B-26, B-27, B-28 (money).** `STUCK_LIMIT`, the 369 `--min-profit-native` default and the
   grief bound.
7. **S-28 (money).** The 25% gas buffer.
8. **B-6 (money).** The half-balance cap on `--fund`.
9. **G-22, G-25, G-28, G-13, G-14.** The executor's graph wiring: `bestQuote`, the warm start,
   `--no-graph`, the null-quote fallback and the no-change-mid-pass rule.
10. **B-1, B-2 on all bots, B-3 for the heartbeat, B-9 to B-12, B-13 to B-16, B-20, B-23, B-30,
    B-32 order, B-34.**
11. **S-2, S-8 (same market), S-9 (the clamp), S-13 (self-pair), S-22 (inventory path), S-39.**
12. **G-8 at the 369 floor value.**
13. **O-1.** No test or CI gate stops a key in a URL path. `tools/check-redact.py` checks only that
    logged errors are redacted.

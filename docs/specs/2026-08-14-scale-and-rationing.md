# Scale, and who gets the storage
**Status: Built in part** (set 2026-09-23). §5's middle-leg fix is built (`sdk/src/solver/rings.ts`). §7's Rust indexer and Rust solver are not built: the repository has no Rust crate. §3's rationing rules are not checked here.
Two questions from the owner, 2026-08-14:

1. What is the minimum trade size prove.cash should support?
2. Should larger holders get better terms for the signatures they post — 1/10,000 of supply buys
   unlimited, 1/100,000 buys 256, and so on down — so that storage is constrained?

Then a third, which changes the answer to both:

3. Assume 10,000 tokens, ~15,000 live swap directions, and up to 1,000,000 intents to sift
   through. The solver and the app both have to handle it. Buttons do not scale.

Everything below that carries a number was measured on 2026-08-14, against mainnet 369 or the
live board, and the measurement is named. Nothing here is estimated from memory.

---

## 1. The minimum trade size

### What a fill costs

Mainnet 369, measured: gas price 376,140 gwei, and 1 PLS = $0.0000097 from the real WPLS/DAI
PulseX V2 pair (`0xe560…de0ae`, 44.7 billion WPLS of reserves). Gas per path is from
`contracts/test/Gas.t.sol`.

| path | gas | cost |
|---|---|---|
| `fill`, allowance, warm | 33,381 | $0.000122 |
| `fill`, allowance, first touch | 115,872 | $0.000423 |
| `fill`, escrow, warm | 32,356 | $0.000118 |
| `deposit`, first touch | 61,131 | $0.000223 |
| `fillWithCallback` | 80,866 | $0.000295 |
| `fillBatch` ×20, per intent | 43,901 | $0.000160 |
| `fillBatchWithCallback` ×20, per leg | 51,085 | $0.000186 |

**Gas is a hundredth of a cent.** It sets almost no floor. Take the worst case, $0.0004, and ask
that gas stay under a tenth of the executor's gross:

- at a 0.3% spread, the trade must clear **$1.30**
- at a 1% spread, **$0.40**

### The answer

**About one dollar, and it is the executor's economics that set it, not the chain's.**

State it without a currency, so it needs no oracle and no maintenance:

> An intent is worth carrying when its spread at the current mid exceeds ten times the gas to
> fill it.

The board already needs a `tokenOut` price to judge the price band (§3), so this costs nothing
extra, and it tracks gas and the token price on its own.

### Not in the contract

A minimum in `ProveSettlement` would have to be denominated in some token. That means either
per-token configuration or an oracle, and either one ends the property that anybody can settle
any signed intent without asking. The contract already refuses `take == 0`, which is the correct
contract-level floor. Everything above it is board and solver policy, where it is free to change.

---

## 2. What is actually scarce

### Signatures cost the chain nothing

`ProveSettlement` writes no storage for an intent until somebody fills it, cancels it, or funds
it — `filled[h]`, `cancelledAt[h]`, `_reserved[h]`, one slot each, and gas is paid for every one
of them by whoever does it. **On-chain storage is already fully priced.** Nothing here needs a
contract change, a redeploy, or an audit.

The scarce thing is the board's working set, and the solvers' and the app's index over it.

### Three limits already bite

- **A bare signature dies within the hour.** `MAX_WALLET_WINDOW` is one hour, so an address's
  unescrowed working set drains by itself.
- **An escrowed intent costs capital**, one deposit each. Self-limiting, and the deposit is an
  on-chain transaction the maker paid for.
- **The board charges proof of work per post.** Measured on the live board today:
  `workMultiplier` 10,000, `workDivisor` 1,000,000.

What is left unbounded is one address posting a fresh hour-long signature continuously. Proof of
work is the only brake on that.

### How big is the board, really

Measured on 2026-08-14 through `msgboard_status`:

| chain | live messages | size |
|---|---|---|
| 943 | 360 | 69,634 bytes |
| 369 | 31 | 2,065 bytes |

That is 193 bytes a message, which matches the packed intent (~175 bytes, or 234 with an
authorization).

The board keeps roughly the last 120 blocks. At the measured 10-second slots that is **a
20-minute window.** So for a million intents to be live *on the board at once*, somebody has to
post 833 a second, every second, each one carrying proof of work, and every full node running
the module has to hold 193 MB for twenty minutes.

**One million is not a live-board number.** It is an archive number, and the archive is a
read-only Hasura endpoint that keeps a year. A million over a year is 2,700 a day, which is
ordinary. The live set is bounded by arrival rate times a twenty-minute window for bare
signatures, and by locked capital for escrowed ones.

This matters because it splits the problem in two:

- **The live book** — thousands to tens of thousands. Fits in an index; does not fit in the 250
  rows the app renders today.
- **The archive** — a million and growing. A database question. It must never reach a browser
  tab whole.

---

## 3. Rationing, in the order the rules should run

The owner's ladder is sound but belongs at the bottom. Four cheaper rules do almost all the work,
and they sort the board by *usefulness* rather than by *who you are*.

### Rule 1 — dead is free to drop

Expired, cancelled, or below the maker's nonce floor. The chain says so, no policy is involved,
and no participant can complain.

### Rule 2 — outside the price band

The owner's 3× / 10× idea. A signature priced fifty times off the market is pure storage and will
never fill.

**This is the sharpest tool, and a count cap is the bluntest.** A count cap punishes a market
maker running fifty tight quotes — the most valuable participant on the board — and leaves
someone parking one piece of garbage untouched. The band does the opposite.

### Rule 3 — outside the top price levels in its direction

A ring in this protocol is at most three legs, so it only ever wants the best price in a
direction. The five-hundredth-best WPLS→PLSX intent is never part of a profitable ring unless the
ones above it are exhausted by size.

**Index price levels, not intents.** Two intents at the same rate are substitutes: a ring does not
care which maker supplies a leg until it comes to size it. So a direction's index holds K *levels*,
each carrying an aggregate depth and a list of member ids, and the eight-hundredth intent at a
price already on the book costs four bytes rather than a row.

**The key is the floor rate, and that is not an arbitrary choice.** `minOutAt` ramps linearly from
`minOutStart` down to `minOutEnd`, and `_termsOk` refuses `minOutEnd > minOutStart`, so **an
intent's rate never rises.** Index on the spot rate and every decaying intent drifts between
levels for its whole life. Index on `minOutEnd / amountIn` — the best price it will ever offer —
and the key never moves. It is also a valid lower bound on the rate at any moment, which is
exactly what the ring condition needs to *reject* a candidate: if the best floor rate in a
direction cannot close the ring, nothing in that direction can.

Reduce `(amountIn, minOutEnd)` by their gcd to get the canonical key. That merges sizes at the
same price for free — "200 for 6" lands in the same level as "100 for 3" — which is what a price
level should do.

Decay is the minority case. The app's Dutch toggle is off by default, and
`minOutEnd = minOutStart` whenever it is off, so for most of the book the floor rate *is* the spot
rate and the level is stable for ever.

**This is what retires the count cap.** An address posting a thousand identical intents gets one
level and bounded depth. An address posting a thousand distinct prices is quoting a curve, and
every one of those levels is information. The structure prices duplication at zero and information
at full value **without knowing who anybody is** — which a per-address cap can never do, and which
is the whole objection to count caps in rule 2.

Two things to get right:

- **Depth is not a plain sum.** An intent without `FLAG_PARTIAL` cannot supply part of a leg. A
  level's usable depth is the sum of `remaining` over its partial members, plus the discrete lumps
  of the all-or-nothing ones.
- **Queue position is advisory.** Which member of a level gets filled is the executor's choice;
  the chain has no opinion. Order by custody first, then by when the board first saw it, and do
  not let the UI imply the order is enforced.

**Unmeasured:** how often real intents collide on a level. The argument that they will is that
`amountIn`, `minOut` and `minOutEnd` are all typed by hand (`Compose.tsx:315-324`), and people
type round numbers. The live board is 360 messages of mostly e2e traffic, so it cannot answer
this. The archive can, and should, before K and the per-level depth are chosen.

### Rule 4 — custody outranks

Escrow and authorization beat a bare signature. Real capital stands behind them, they are
provably fillable, and verifying that is one storage read. They are also the intents that
accumulate, because they never expire — so they are most of any large book, and they are the part
of it worth keeping.

### Rule 5 — then the holdings ladder

Sized against the real numbers, measured today: PLSX total supply is 141.34 trillion at
$8.757e-6, so the whole float is about $1.24 billion.

| fraction of PLSX supply | PLSX | value | live signatures |
|---|---|---|---|
| ≥ 1/10,000 | 14.1bn | $124,000 | unlimited |
| ≥ 1/100,000 | 1.41bn | $12,400 | 256 |
| ≥ 1/1,000,000 | 141m | $1,240 | 16 |
| ≥ 1/10,000,000 | 14.1m | $124 | 1 |
| anything less, including nothing | — | — | 1 |

Three things to hold on to.

**Meter a token nobody can mint.** Metered against the traded token, anyone who deploys their own
token holds 100% of its supply and lands in the top tier. That is finding E-6 exactly — a
self-issued token makes any supply-relative measure free to fake. PLSX or PLS, never the token
being traded.

**Each tier must be more than ten times the next, or concentrating does not pay.** Split a
holding across ten addresses one tier down and you get ten times the lower cap. Unlimited → 256 →
16 → 1 clears that at every step. A gentler ladder — 256 → 25 — is exactly Sybil-neutral and buys
nothing.

**The bottom of any ladder is Sybil-unbounded.** Whatever the free tier is, an attacker can
always make more addresses. So **the ladder is not a storage bound. Proof of work is the bound;
the ladder is a priority order** — which is how the owner first described it: whose signatures
are kept for longer.

**Sample the holding over time, not at a moment.** An instantaneous balance is rentable. Use the
minimum observed over the retention window. Same reasoning as `FeeSink`'s time-weighted floor: a
number you can borrow for one block is not a number to price anything from.

---

## 4. Where the policy lives

Not in the contract, and this is load-bearing rather than incidental.

**The board decides what it carries. The chain decides what can settle.** A dropped intent is
still fillable by anyone holding a copy of the signature, which is why the on-chain window cap is
the real bound and board policy is only about cost. Two boards may run different policies over
the same protocol and neither is wrong.

One consequence, from reading `@msgboard/core`: `ContentFilter` is `{ category?, fromBlock?,
toBlock? }`. There is no limit, no offset, and no way to ask for one direction's book. **The board
protocol is a broadcast medium, not a database.** At any real size a client cannot query it
directly, so the rationing rules above run in an indexer between the board and the client — which
is also where the price band and the per-direction top-K naturally live.

`fromBlock` exists and nothing uses it. Delta polling against a block high-water mark is available
today and is the first thing to fix, whatever else happens.

---

## 5. What this means for the solver

The load-bearing point:

> **Ring search is over directions, not over intents.**

`findRings` already had that shape. One line inside it did not.

### Fixed, 2026-08-14: the middle leg was a search, not a lookup

`sdk/src/solver/rings.ts`. Both outer legs of a three-leg ring were found with
`pairs.get(pairKey(…))`, an ordinary map lookup. The middle leg walked **every direction in the
book** and kept the ones whose key started with the right token — inside two loops that already
run once per direction and once per entry. Quadratic in directions: at 15,000 of them, 1.8e9
iterations, each one allocating a fresh lowercased address and a template string.

An out-adjacency index, built once per call, replaces the walk. Mean out-degree at 10,000 tokens
over 15,000 directions is 1.5, so the inner loop goes from fifteen thousand to about two.

Measured A/B, both implementations compiled and run against the same book:

| directions | intents | before | after | |
|---|---|---|---|---|
| 200 | 800 | 44 ms | 11 ms | 4× |
| 800 | 3,200 | 651 ms | 23 ms | 29× |
| 3,200 | 12,800 | 3,914 ms | 70 ms | 56× |
| 8,000 | 32,000 | 69,768 ms | 788 ms | **89×** |
| 20,000 | 80,000 | *timed out at 10 min* | — | |

Enumeration output is identical at every size, and the 106 SDK tests pass — including the
three-leg ring cases at `solver.test.ts:264` and `:472`, which index `findRings(...)[0]` and would
throw on an empty result. On a separate book at the full target shape, 15,000 directions and
60,000 intents, `findRings` now runs in **239 ms**.

### Still to do, in order of how badly they break

- **The book is capped at 500 rows** (`book.ts:186`), walked in soonest-expiry order with no
  direction filter. At a million intents the solver sees 0.05% of the book, chosen by expiry —
  about 0.03 intents per direction, so almost nothing can close.
- **The cap is structural, not a default.** `loadBook` issues one `eth_call` per intent for
  `available` and one per survivor for `fillability` (`book.ts:132`, `:149`). At a million that is
  2e6 calls, ~1.4 GB of calldata and ~4e10 gas. A 50M `eth_call` cap allows about **1,250
  `fillability` probes per multicall**, which is the real ceiling. Ask the chain only about the
  legs of candidate rings — at most three per plan, at most 200 plans, so under 600 probes.
- **Every intent is verified, twice, every tick.** `store.ingest` verifies
  (`store/index.ts:155`) and `app/scripts/solver.ts:133` verifies again, uncached, in a serial
  `await` loop. Measured at 1.6 ms per `recoverTypedDataAddress`: a cold pass over a million is
  **53 minutes** against a 60-second tick. Delete the duplicate; verify on promotion into the hot
  tier, never the whole book.
- **The Map-backed store copies, filters and sorts the whole book on every query**
  (`store/memory.ts:17`). The IndexedDB backend honours the "no full-array filtering" contract;
  the Map backend the Node solver always lands on does not. Measured at a million records: 543 ms
  for a 500-row page, **2,322 ms to return the 67 rows of one direction**.
- **`best()` re-sorts every direction's full list twice per tick** (`rings.ts:155`) — measured
  870 ms per call at a million entries. It wants an O(n) top-8 selection, maintained on ingest.
- **`loadPrices` and `loadPools` re-read the whole token universe every tick**, uncached
  (`price.ts:227`, `:126`). At 10,000 tokens that is 10,000 `getPair` calls and up to 30,000 pair
  reads, plus another 15,000 and 45,000 with `--amm`. The factory→pair map is immutable and can be
  cached for ever; reserves need one block.
- **No price band, and `maxRings: 200` samples in map insertion order** (`rings.ts:177`) — which
  is the order rows came back from the store, so it is an arbitrary 200 rather than the best 200.
  The ring condition gives the band for free: once the first leg's rate is known, the middle leg
  only needs entries under `1/(r₁ · (1+φ)³ · r₃ᵐⁱⁿ)`, and the lists are already sorted by rate, so
  the loop can `break` instead of scanning.

### The index this ends at

Three tiers, about **700 MB** at a million intents, against a measured **4.6 GB** today
(2,368 B per store record, 1,704 B per book entry, 485 B per verify-cache entry, all held at once).

| tier | what | size |
|---|---|---|
| 0 | direction graph: token ids, `dirFrom`/`dirTo`, CSR out-adjacency | ~3 MB |
| 1 | hot: top-8 decoded entries per direction, 120,000 of them, incremental heap | ~204 MB |
| 2 | cold: the rest, columnar, no per-row JS object | ~490 MB |

Rows promote into tier 1 when their rate beats their direction's eighth-best, and that promotion
is also where the signature gets verified. Enumeration then costs 15,000 × 8 × 1.5 × 8 ≈ 1.44e6
candidates.

---

## 6. What this means for the app

Measured by survey, 2026-08-14. The three hard walls:

1. **`TokenPicker` reads every balance in one multicall.** At 10,000 tokens that is 4.5 MB of
   calldata and about 57M gas, over geth's 50M `rpc.gascap`, so it reverts and falls back to
   10,000 individual `eth_call`s.
2. **Every signature is verified on the main thread**, measured at 2.156 ms per
   `recoverTypedDataAddress`. A million is 36 minutes of blocked UI. The 12-second poll starts
   overlapping at about 15,000.
3. **`logoUrl` linear-scans the token list on every avatar render** — 0.169 ms at 10,000 tokens,
   which is 8.5% of a core burned permanently at the current 1 Hz whole-tree re-render.

The three structural fixes:

- **The direction becomes the primary axis, not a filter.** With 15,000 live directions, "show
  everything, then narrow" is neither a view a person can use nor a query an index can answer
  cheaply. The store's `byChainPairEnd` index already exists and is already the fast path.
- **A `Combobox` primitive beside `Menu` and `Toggle`.** `Menu` takes a materialised array and
  maps all of it to DOM; at 15,000 options that is 45,000 elements, and its arrow-key handler runs
  `querySelectorAll` over all of them per keypress. The new one takes a `search(q, offset, limit)`
  and renders a window of about twenty rows, with `aria-activedescendant` and `aria-setsize` so a
  screen reader is still told "3 of 10,000". `Menu` keeps its array API for the sort, scope and
  network cases, which are under fifty options and always will be.
- **A million records never enter the JS heap.** Measured at 1,508 bytes each, that is 1.51 GB.
  The page holds a window; IndexedDB holds the rest; every count on screen comes from a maintained
  aggregate rather than a `.filter()` over an in-memory array.

The standing UI rules survive all of it. A windowed table still runs the full viewport width, rows
still meet both edges square, box shadows still do the work borders would, `.addr` still breaks
the maker column, and nothing gains a native form control.

---

## 7. The indexer

**Decided by the owner, 2026-08-14: we provide one.** Compiled to WASM from Rust or Go, over
SQLite natively and IndexedDB in a browser.

### Rust, and the number that decides it

The measured bottleneck is signature recovery, so that is what to measure. All three figures are
recover-plus-derive-address, warmed, on this machine:

| | per signature | throughput |
|---|---|---|
| viem `recoverTypedDataAddress` (today) | 1,600 µs | 625/s |
| Rust `k256`, wasm32 under Node | **376 µs** | 2,661/s |
| Rust `k256`, native | **132 µs** | 7,562/s |

The whole wasm32 module — recovery, keccak, the lot — is **114 KB**.

What that does to the full-book problem:

| | one million signatures |
|---|---|
| viem, one thread (today) | 27 minutes |
| Rust WASM, one thread | 6.3 minutes |
| Rust WASM, 8 workers | 47 seconds |
| Rust native, 8 cores | **17 seconds** |

So a server can verify the whole archive in seconds, and a browser still cannot — **lazy
verification stays mandatory in the tab** whatever the language.

#### What lazy verification means

Verifying an intent means recovering the signer's address from its ECDSA signature and checking it
against the `maker` field. Today that happens the moment an intent arrives — `store.ingest` calls
`verifyOnce` (`store/index.ts:155`), and `app/scripts/solver.ts:133` does it again, uncached. That
is eager: you pay for every intent whether or not you ever use it.

**Verification is not a safety property here.** `_evaluate` checks the signature on chain, so a
forgery cannot settle no matter what any client believes. Failing to catch one locally costs a
wasted simulation, a wasted transaction, or a junk row on screen — never money. That is what makes
deferring it sound.

So verify at the last moment where the answer changes something:

| when | how many | why there |
|---|---|---|
| on arrival | none | nothing acts on it yet |
| on promotion into the hot tier | ~120,000 over the book's life | a solver may now build a plan from it |
| before display | ~20 per viewport | nobody should be shown a forged offer |
| before a fill | free | the chain does it anyway |

Cache the verdict by intent hash and no signature is ever recovered twice.

At today's rate that turns 1e6 recoveries **per tick** into about 120,000 **once**, plus twenty per
render. In Rust WASM that is 45 seconds spread over the book's life and 7.5 ms a viewport.

The obvious objection: an unverified forgery could occupy a top level and push a real intent out.
It cannot, because promotion into the hot tier is the moment verification happens — a forgery is
caught on the way in, not after. Rank unverified intents below verified ones at the same level and
the ordering is safe too. Proof of work already charges the forger per attempt. Go is the weaker choice on both
counts that matter here: plain Go ships a runtime and GC that start around 2 MB before any code of
ours, and TinyGo trims that at the cost of stdlib and reflection. Rust at 114 KB with no GC pause
is the pick.

### One SQLite, two hosts — not SQLite and IndexedDB

Take the brief's "SQLite, or IndexedDB in the browser" as one engine rather than two. SQLite
compiles to WASM and runs on OPFS through the `opfs-sahpool` VFS, which uses synchronous access
handles in a Worker and needs **no cross-origin isolation headers** — worth having, because
turning on COOP/COEP is a Cloudflare change that breaks other things. An IndexedDB VFS is the
fallback for browsers without OPFS.

The reason to insist: SQLite natively plus a hand-written IndexedDB indexer is **two
implementations of one query layer that have to agree**. This repository already has a trap entry
for that shape — `contracts/abi/*.json` drifted by seven entries because nothing compared the
second copy. One schema, one set of queries, one set of tests, two hosts.

**Unverified:** OPFS behaviour under this app's Cloudflare setup, whether the sahpool VFS supports
WAL, and the real size of the SQLite WASM build on top of our 114 KB. Measure all three before
committing.

### Memory — the actual reason to do this

The owner's constraint is that we must not run out of memory. **That is the main thing SQLite buys
here, more than query speed.**

Today the book lives in the JS heap and its size is the book's size. Measured: 2,368 B per store
record, 1,704 B per book entry, 485 B per verify-cache entry, all held at once — **4.6 GB at a
million intents**, and nothing bounds it but the tab dying.

With SQLite the rows are not in the heap at all. Resident memory becomes two things, both chosen
rather than suffered:

| | what sets it |
|---|---|
| page cache | `PRAGMA cache_size`, e.g. `-16000` for 16 MB |
| the result set | the `LIMIT` on the query — a viewport, or eight levels |

So the footprint is a configuration constant. A hot query returning eight levels for one direction
is kilobytes. A viewport of a hundred rows is a hundred kilobytes. Neither grows with the archive.

On disk, an `intent` row is about 330 bytes of columns — 32 hash, 65 signature, four 32-byte
amounts, the rest small — call it **~500 B with indexes, so ~500 MB for a million**.

That number decides the split, and the split needs no extra code:

- **The server holds the archive.** 500 MB on disk is nothing.
- **The browser holds a subset** — the directions the user is looking at, plus their own intents.
  Thousands of rows, single-digit megabytes. Same schema, same queries, different retention.

One caveat specific to WASM: **linear memory grows and never shrinks.** A 16 MB page cache is
16 MB held for the life of the tab, not borrowed. Bounded, but not returned — so pick the cache
size deliberately rather than generously.

### What it is for

The single biggest win is not speed. It is that **the indexer replaces `loadBook`'s per-intent
`eth_call`s with an event subscription.** `Filled`, `Cancelled`, `Deposited`, `Withdrawn` and
`NoncesInvalidated` are enough to maintain `filled`, `cancelled_at` and `reserved` for every
intent it holds. Two million calls a tick becomes one log subscription, and the 500-row book cap
goes with it.

### Schema

`uint256` does not fit an SQLite `INTEGER`, so store it as a **32-byte big-endian BLOB** — SQLite
compares BLOBs by memcmp, so big-endian sorts correctly with no custom collation. The `rate` REAL
is for ordering and indexing only; **money never comes from it**, it comes from `num`/`den`.

```sql
CREATE TABLE token (
  id INTEGER PRIMARY KEY, chain_id INTEGER NOT NULL,
  address BLOB NOT NULL, symbol TEXT, decimals INTEGER,
  UNIQUE (chain_id, address));

CREATE TABLE direction (                       -- ~15,000 rows
  id INTEGER PRIMARY KEY, chain_id INTEGER NOT NULL,
  token_in INTEGER NOT NULL REFERENCES token(id),
  token_out INTEGER NOT NULL REFERENCES token(id),
  UNIQUE (chain_id, token_in, token_out));

CREATE TABLE level (                           -- the price levels of §3, rule 3
  id INTEGER PRIMARY KEY,
  direction_id INTEGER NOT NULL REFERENCES direction(id),
  num BLOB NOT NULL,                           -- minOutEnd, reduced by gcd
  den BLOB NOT NULL,                           -- amountIn, reduced by gcd
  rate REAL NOT NULL,                          -- ordering only, never money
  depth BLOB NOT NULL,                         -- summed remaining, partial members only
  UNIQUE (direction_id, num, den));
CREATE INDEX level_by_price ON level (direction_id, rate);

CREATE TABLE intent (
  hash BLOB PRIMARY KEY,                       -- the EIP-712 digest
  level_id INTEGER NOT NULL REFERENCES level(id),
  maker BLOB NOT NULL, amount_in BLOB NOT NULL,
  min_out_start BLOB NOT NULL, min_out_end BLOB NOT NULL,
  start_time INTEGER NOT NULL, end_time INTEGER NOT NULL,
  flags INTEGER NOT NULL, nonce BLOB NOT NULL, signature BLOB NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,         -- set on promotion, not on ingest
  filled BLOB NOT NULL, cancelled_at INTEGER, reserved BLOB,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX intent_by_level ON intent (level_id, end_time);
CREATE INDEX intent_by_maker ON intent (maker);
```

The solver's hot query is then an index seek:

```sql
SELECT rate, num, den, depth FROM level
 WHERE direction_id = ? ORDER BY rate LIMIT 8;
```

Ring enumeration stays in Rust over the loaded levels. A recursive CTE would express three-cycles
and would be slower than the CSR walk that is already in `rings.ts`.

### The boundary, which must not move

**The indexer is advisory. The chain decides what can settle.** Its `filled`, `cancelled_at` and
`reserved` are cached views of chain state, and a stale row costs a wasted simulation, never
money — the pre-fill `eth_call` is the gate and stays the gate. A signature it marks verified is a
convenience, not a warrant.

That is what makes it safe to ship as a service: **anyone can run their own, or run it in their
own tab, and get the same answers.** Ours is a convenience and never a dependency. Since the same
WASM serves both, that is a real option rather than a claim.

### The codec is a second implementation, so pin it

The packed wire codec lives in `sdk/src/intent.ts`. A Rust port is a second implementation of a
format that both must agree on byte for byte. The repository already has the right precedent:
`Fixture.t.sol` writes an EIP-712 fixture that `sdk/src/intent.test.ts` asserts against, so
Solidity and TypeScript cannot drift. Do the same here — shared vectors, checked in CI, failing
loudly.

### Scope: what a client loads

**A ring spans three directions, so a solver cannot be scoped to one.** A 3-leg ring is A→B, B→C,
C→A. Scope to the focused direction and nothing can ever close; scope to the focused pair, A→B and
B→A, and only 2-cycles can.

The unit is **the focused pair plus its 1-hop neighbourhood** — directions leaving B, directions
returning to A. Levels are what make that cheap: load the top-K *levels* of each neighbouring
direction, not their intents. At 8 levels of ~100 B, a 2,000-direction neighbourhood is ~1.6 MB.
Intents are fetched only when a ring is sized — three per ring, a handful of rings.

Watch the hub. WPLS appears in most pairs, so "directions returning to WPLS" is thousands rather
than the mean out-degree of 1.5. Cap fan-out per token, top-M by depth, or the hub pulls the whole
graph back in.

That is the browser's config. A server sets no scope and holds everything.

### The config surface, and where it stops

What exists today:

| where | options |
|---|---|
| `FindRingsOptions` | `maxLegs`, `maxPerPair`, `maxRings`, `pools` |
| `LoadBookOptions` | `executor`, `client`, `chainId`, `settlementAddress`, `minRemaining` |
| `loadBookFromStore` | `store`, `limit` |
| `app/scripts/solver.ts` | `--execute`, `--amm`; env `RPC`, `BOARD_RPC`, `SETTLEMENT`, `SOLVER_KEY` |

What is missing:

- **No direction scope anywhere.** Nothing can say "these markets only", which is the whole of the
  browser configuration above.
- **No memory budget.** `limit` is a hard row count, not a footprint, and under SQLite the
  footprint is what a caller wants to bound.
- **`limit`, `maxPerPair` and `maxRings` are function parameters, not flags.** `solver.ts` takes
  the defaults, and nothing can be changed without editing code — so an off-browser solver cannot
  manage its own constraints today.

The shape is right; it stops at the library boundary.

### The solver moves to Rust too — for the boundary, not the speed

Decided by the owner, 2026-08-14. The reason matters, because it decides where to cut.

**Compute was never the problem.** At full target scale, after today's enumeration fix:

| | per tick |
|---|---|
| `findRings` | 239 ms |
| `sizeRing` × 200 rings | 5 ms |
| `profitableFrom` × 200 | 100 ms worst case |

About 350 ms against a sixty-second tick — a 0.6% duty cycle. Everything that broke at scale was
I/O: two million `eth_call`s, eager verification, and the store's full scans. The indexer fixes all
three in any language.

**The boundary is the problem.** With levels in Rust and SQLite and enumeration in TypeScript,
every tick marshals the levels across the WASM boundary — 120,000 for a server, ~16,000 for a
scoped browser — and allocates a JS object for each. That copy costs more than the work it feeds.
The solver belongs in Rust because it lives inside the indexer.

So cut at the plan, not at the query:

- **Rust:** codec, EIP-712, verification, SQLite, level maintenance, enumeration, sizing, ranking.
  It emits a ranked plan list — 200 plans, tens of kilobytes, crossing the boundary once.
- **TypeScript:** take a plan, build calldata, simulate, sign, send. Keeps viem, the wallet, and
  the retry handling in `app/scripts/e2e/common.ts` that already copes with an RPC that reports
  failure for work that succeeded. There is no reason to re-solve that in `alloy`.

**The TypeScript solver is the browser.** Owner's call, 2026-08-14, and it is the better shape:
Rust serves off-browser solvers and the indexer, TypeScript serves the tab. Nothing is kept alive
only for tests.

That works because a browser is scoped to a neighbourhood. The 4.6 GB figure is for holding a
million intents, and a tab never does — twenty thousand in scope is about 64 MB of heap, which is
tight rather than fatal. The index it needs already exists: `byChainPairEnd` on
`[chainId, pair, endTime]` (`store/indexeddb.ts:20`). **So the browser needs no SQLite, no WASM
download, and no new storage engine** — the existing store, the existing solver, and a scoped feed.

SQLite in WASM becomes optional rather than default: it ships only for someone who wants to run a
whole indexer in their own tab, which is the trust-minimising path and not the common one.

**Both solvers answer to the contract, not to each other.** An earlier draft of this section called
for differential-testing the two implementations. That is wrong. Solvers are competitors, not
replicas — two of them finding different rings is the normal state of a permissionless system, and
they will legitimately differ on scope, scan order and risk appetite. What must agree is only the
arithmetic that mirrors the chain: `minOutAt`, `quote`, the fee maths, the ring condition. Anchor
each implementation to the contract, which is the actual authority, and the anchor already exists
in `Fixture.t.sol` and the settlement's own `quote` and `minOutAt` views.

**Interim wart.** `store/memory.ts` is the backend Node falls back to, and it copies, filters and
sorts the whole book per query — 2,322 ms to return one direction's sixty-seven rows at a million
records. Anyone running the TypeScript solver headless pays that until the Rust solver replaces
`app/scripts/solver.ts`. A browser never touches it.

### Sequencing

Two of these are needed whatever happens to the indexer, and both unblock the current app now:

1. **Delta polling.** `ContentFilter.fromBlock` exists and nothing uses it; the board poll pulls
   the whole category every twelve seconds. Small, contained, needed by the indexer anyway.
2. **Event subscription instead of per-intent `eth_call`s.** This is what lifts the 500-row cap,
   and the indexer needs exactly the same subscription.
3. **Then the Rust indexer**, with the level schema above.

This is weeks of work, not days: a Rust core (codec, EIP-712, recovery, schema, enumeration), two
host builds, a thin TypeScript client to replace today's solver book layer, and shared vectors
against the existing implementations.

---

## Decisions still the owner's

- The tier thresholds in §3 are the owner's own ladder, sized. Confirm or move them.
- Whether the free tier is 1 live signature or 4. Zero closes the protocol to newcomers; more than
  a handful makes Sybil cheaper than it needs to be.
- Whether to start the indexer now, or land the two TypeScript fixes in §7 first and measure the
  book again with the cap lifted.

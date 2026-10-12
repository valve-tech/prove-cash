# Market visuals in the app's pages

**Status: Built in part** (corrected 2026-09-23; it said "proposed"). Build-order steps 1 to 3
are built in `app/src/components/charts/`, first in `fa890d4` and `1ddfb18`. `MarketPanel` is on
the board (`App.tsx`) and in the sign form (`Compose.tsx`), and `BatchWalk` is in `BatchTray.tsx`.
Step 4 (the Mine overview and row sparks) and step 5 (pair analytics) are not built:
`Portfolio.tsx` imports no chart. `MarketPanel` also mounts a `Capacity` chart, and the table
below says variant B, the capacity book, is "do not build". Whether `Capacity` is variant B is
not checked here.

This document decides which market visuals go on which page, and why.
It exists to be iterated on. The rendered candidates live in `app/mockups/market-graph.html`
(round one: variants A, B, C) and `app/mockups/market-graph-2.html` (round two: D, E, F).
Look at them before reading further — the mockups are the argument; this file is the placement.

## The principle

The table stays the decision surface. A chart answers "should I?"; it never replaces the
numbers. Every figure a chart shows must name its source. Synthetic data never appears without
a visible SYNTHETIC chip — a mockup was rejected once for invented data presented as real, and
the rule stands in product code too. Every view that can be empty ships a designed empty state:
chain 943's pair had zero swaps in its last 50,000 blocks when these mockups were drawn, so
"no history yet" is the launch condition, not an edge case.

## The decisions each page serves

### /board — the taker

One decision: **which rows do I fill, and in what batch?**

- Single row: is it profitable net of pool impact and fees? The edge column answers this
  (`app/src/components/IntentRow.tsx`, `edgeOf` in `sdk/src/market.ts`).
- Batch: does the set stay profitable? Each fill moves the pool, so row #2's edge changes
  after row #1 executes. Sequential and geometric — the table cannot show it. This is the
  board's biggest information gap.
- Timing: a decaying floor improves; a moving spot flips a red row green. `sort=expiry` hints
  at this; nothing draws it.

Placement:

1. **BatchTray batch walk** (`app/src/components/BatchTray.tsx`). When rows are selected,
   draw the batch walking the pool curve — cumulative size against execution rate, net edge
   after each fill, in fill order. Variant C's reserves-walk or variant A's curve, whichever
   reads better small. `simulateFills` already computes the fills; the curve needs reserves
   (see "data" below).

   The tray's arithmetic was wrong here, and the chart is the second half of the fix. It summed
   `edge.profit` per row, and each row's quote prices it against the *current* reserves as if it
   were the only trade in the world. Measured on live rows 1–3 (259.4, 71.51, 299.9 tPLSX at
   floors 10.0466, 2.8231, 11.6030 tUSDC) against 10,000 tPLSX / 400 tUSDC: the tray read
   **+0.0582 tUSDC**, unwinding as one trade gives **−0.8023**, and filling one at a time gives
   **−0.8035**. Three green rows, a losing batch, wrong by 0.86 and wrong in sign. Mixed
   directions break the other way — the batch pays itself and the pool never sees the offsetting
   volume, so the tray understates it. `walkBatch` in `app/src/lib/pool.ts` nets opposing rows
   first, then walks the remainder along the curve in fill order.
2. **Pair strip** above the table when a pair filter is active: variant E's future zone only —
   spot guideline, each open intent as a floor segment to expiry, decay as slope. Shows *when*
   rows become fillable.
3. Row hover: a mini variant-A — this row's dot against the pool curve.

### /sign — the maker

One decision: **what floor and size will actually fill, and what do I give up?**
`Compose.tsx` today shows no market context at all; the maker types a floor blind.

- Floor vs pool: below the pool's rate at my size = fills now but gives edge away; above =
  rests until the market or my decay reaches it.
- Size vs depth: the taker's edge is pool impact, so size changes fillability at the same
  rate. One number explains it: "your 250 tPLSX moves this pool 3.4%" (variant D's depth
  annotation, generalized).
- Dutch decay: where the slope crosses the pool rate is the expected fill moment (variant E's
  crossing ring, exactly).
- Duration: wallet custody clamps to 1h (`MAX_WALLET_WINDOW_S`); show the clamp on the same
  time axis.

Placement: a **live preview panel** beside the form. The pool pays/charges curve for the
chosen pair, a draft marker at (size, floor) that moves as the maker types, green/red, and one
sentence: "fills now, taker keeps +0.31%" or "rests 1.2% above the pool". Dutch on → add the
E future zone with the sloped segment and "crosses in ≈36m". Show the other resting floors as
ticks — queue context.

### /mine — the maker managing

Decision per row: **leave, cancel, or reprice?** Needs: my floor vs the current pool rate,
decay progress, time left, escrow held.

Placement: a one-glance variant-A overview — all my open intents as dots against the curve —
plus a per-row spark of the E segment ("fillable since 12:04"). Custody and escrow stay as
`CustodyLadder` and the existing `Portfolio` rows.

### /cleanup — the visitor

Decisions are binary (withdraw or not). No market visuals. The plain list is right.

## Where each mockup variant lands

| Variant | Home |
|---|---|
| E tape (future zone) | board pair strip, sign Dutch preview, mine row sparks |
| A price × size | sign draft preview, mine overview |
| C reserves walk | BatchTray batch simulation |
| F ladder | header of a pair-filtered board |
| D ribbon + histograms | pair analytics later; its depth number goes to sign now |
| B capacity book | superseded by F — do not build |

## Data

- Everything above **except trade history** computes from reserves plus the pair's own fee:
  `out = in·feeNum·reserveOut / (reserveIn·feeDen + in·feeNum)`. It all works with zero swaps.
  Take `feeNum` and `feeDen` off the `Pool`, never from a constant — the fee lives in the pair
  contract, so it belongs to the venue and not to the brand. Measured on chain 2026-08-17, all
  three live venues solve to 9971 over 10,000, and a chart that hard-codes that will be wrong
  the day one of them does not.
- **The reserves are already there.** `sdk/src/solver/price.ts` exports `loadPools` (one
  multicall for `getPair`, one for `getReserves`), `poolAmountOut`, `poolAmountIn` and
  `poolRate`. Reuse them: one `getReserves` read gives the whole curve as local integer
  arithmetic, and no chart should spend a router round trip per plotted point. An earlier draft
  of this section asked for a new `reservesOf` read and was wrong. `app/src/lib/pool.ts` is the
  app-side wrapper.
- **No router argument.** An earlier draft said to pass `{ router: await router() }`, because
  `loadPools` used to default to mainnet's address and read "no pool" for every pair on 943.
  It does not any more: it resolves the chain's venues from the registry itself. Call
  `loadPools(pairs)` and `loadPoolMap(pairs)` plain.
- **A pair has more than one pool.** Mainnet runs PulseX v1 and v2 behind two factories, so the
  same pair has two unrelated sets of reserves. `loadPools` keeps the deeper one and stamps
  `pool.venue` with its label, which a chart should show — a curve drawn from v1's reserves is
  not the curve a v2 trade walks. A caller that knows its size should take `loadVenuePools`
  and `pickPool` instead and get the pool that actually pays most for that trade.
- Three answers, not two: **no venue on this chain**, **no pool for this pair on any venue**,
  and **a pool holding nothing** are different facts, and each gets its own empty state.
- Trade history = `Swap` logs from the pair. Measured on chain 943: `eth_getLogs` accepts a
  ~100,000-block range on the default RPC; 10,000 blocks (~28.5 h) is one ~200 ms request.
  Historical layers (E's past, F's traded column, D's traded lane) light up when swaps exist
  and degrade to their designed empty states when they do not.

## Build order

1. Sign's live preview — turns the blind floor field into a sighted one.
2. BatchTray's batch walk.
3. The board's pair strip.
4. Mine overview + row sparks.
5. Pair analytics (D, F) once real swap history exists.

Responsive behavior of these visuals is its own document:
`2026-08-17-responsive-visuals.md`.

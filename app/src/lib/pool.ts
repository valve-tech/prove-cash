import type { Address } from 'viem'
import { liveVenues, type ChainId } from '@prove.cash/sdk'
import { readExhausted, readSucceeded } from './chainHealth'
import { loadPools, poolAmountIn, poolAmountOut, poolKey, type Pool } from '@prove.cash/sdk/solver'

/**
 * The pool, as the app's charts need it.
 *
 * One `getReserves` read gives the whole curve, so nothing here asks the router. The arithmetic
 * is the solver's — `poolAmountOut`, `poolAmountIn` and the fee constants come from
 * `sdk/src/solver/price.ts` and are not restated. A chart that plotted 60 points through
 * `getAmountsOut` would be 60 round trips for numbers one snapshot already contains.
 *
 * The other job of this file is the batch walk. A board row's quote prices that row as if it
 * were the only trade in the world. It is not: an executor unwinds the whole selection through
 * one pool, and every fill moves it. `walkBatch` prices the selection the way the pool will see
 * it — opposing rows netted against each other first, the remainder walked along the curve in
 * fill order.
 */

export type { Pool }
export { poolKey }

/**
 * Reserves for every pair given, keyed by `poolKey`. Pairs no venue lists are simply absent.
 *
 * No router argument any more. This file used to pass one because `loadPools` defaulted to
 * mainnet's address, which has no code on 943 — the factory read failed and every pair looked
 * like it did not exist. `loadPools` reads the chain's registry entry itself now, and reads
 * every venue on it, keeping the deepest pool for each pair.
 */
export async function loadPoolMap(
  pairs: readonly (readonly [Address, Address])[],
): Promise<Map<string, Pool>> {
  return loadPools(pairs)
}

/** What a pair's reserve read found. "No market" and "no pool" are different answers. */
export type PoolRead =
  | { state: 'pool'; pool: Pool }
  | { state: 'no-pool' }
  | { state: 'no-market' }
  /** The chain was asked and did not answer. Not the same as an empty answer. */
  | { state: 'unreadable' }

/**
 * Reserves for one pair, and which of the three answers the chain gave.
 *
 * "No market" is asked first and separately: a chain with no confirmed venue cannot say anything
 * about a pair, and reporting that as "no pool" would blame the pair for the chain's silence.
 */
/**
 * How long to wait before asking again, in milliseconds.
 *
 * The endpoint rate-limits per method per second, so the first retry is short — most throttles
 * have cleared by then and the reader never sees a flicker. The later ones back off because an
 * endpoint that is still refusing after a second is busy, and hammering it is how a client turns
 * its own rate limit into a longer one. Four attempts spend about five seconds in the worst case,
 * which is the point where a person decides the page is broken.
 */
const BACKOFF_MS = [350, 900, 3500]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One attempt. Separated so the retry loop above it stays readable. */
async function readPoolOnce(chainId: ChainId, a: Address, b: Address): Promise<PoolRead> {
  // The venue probe can fail to read as easily as the reserve read can, and an empty venue list
  // for that reason is not "this chain has no router" — it is "ask again". Reported separately so
  // the panel does not describe a rate limit as a fact about the chain.
  let venueUnreadable = false
  const venues = await liveVenues({ chainId, onReadFailure: () => (venueUnreadable = true) })
  if (venues.length === 0) return { state: venueUnreadable ? 'unreadable' : 'no-market' }
  // A dropped read and an absent pool both leave the map empty, so ask to be told which it was.
  // Reporting it as "no pool trades this pair" put a false claim about the market on the screen.
  let unreadable = false
  const pools = await loadPools([[a, b]], { chainId, venues, onReadFailure: () => (unreadable = true) })
  const pool = pools.get(poolKey(a, b))
  if (pool) return { state: 'pool', pool }
  return unreadable ? { state: 'unreadable' } : { state: 'no-pool' }
}

/**
 * Reserves for one pair, retried while the endpoint is the thing that is failing.
 *
 * Only `unreadable` is retried. The other three are answers — the chain has no router, the pair
 * has no pool, the pool is empty — and asking again cannot change any of them; it would just be
 * traffic. A throttled endpoint is the one case where the same question gets a different answer a
 * moment later, so it is the one case worth repeating.
 *
 * When every attempt fails, this chain's endpoint is marked degraded, which is what puts the
 * amber state on the header's endpoints button. Any success on it clears it, later pairs included.
 */
export async function loadPool(chainId: ChainId, a: Address, b: Address): Promise<PoolRead> {
  let last: PoolRead = { state: 'unreadable' }
  for (let attempt = 0; ; attempt++) {
    // A thrown error is the same fact as an unreadable result — we did not find out — so it is
    // retried on the same schedule rather than escaping to a caller who would have to invent a
    // meaning for it. The sign panel used to catch it and say "this chain has no router".
    last = await readPoolOnce(chainId, a, b).catch((): PoolRead => ({ state: 'unreadable' }))
    if (last.state !== 'unreadable') {
      readSucceeded(chainId)
      return last
    }
    if (attempt >= BACKOFF_MS.length) break
    await sleep(BACKOFF_MS[attempt]!)
  }
  readExhausted(chainId)
  return last
}

/** The pool's two reserves, oriented so `in` is the token being sold into it. */
function sides(pool: Pool, tokenIn: Address): { reserveIn: bigint; reserveOut: bigint } | null {
  const t = tokenIn.toLowerCase()
  if (t === pool.token0.toLowerCase()) return { reserveIn: pool.reserve0, reserveOut: pool.reserve1 }
  if (t === pool.token1.toLowerCase()) return { reserveIn: pool.reserve1, reserveOut: pool.reserve0 }
  return null
}

/** True when both of a pair's tokens are in this pool and it holds something of each. */
export function poolHolds(pool: Pool, tokenIn: Address, tokenOut: Address): boolean {
  const r = sides(pool, tokenIn)
  const back = sides(pool, tokenOut)
  return !!r && !!back && r.reserveIn > 0n && r.reserveOut > 0n
}

/** How much of one token the pool holds, raw. Null when the token is not in this pool. */
export function reserveOf(pool: Pool, token: Address): bigint | null {
  const t = token.toLowerCase()
  if (t === pool.token0.toLowerCase()) return pool.reserve0
  if (t === pool.token1.toLowerCase()) return pool.reserve1
  return null
}

/** A raw amount as a plain number, for plotting. Doubles are exact enough for a pixel. */
export const asNumber = (v: bigint, decimals: number): number => Number(v) / 10 ** decimals

/** What the pool pays for `amountIn` of `tokenIn`, in raw tokenOut units. */
export const poolPays = (pool: Pool, tokenIn: Address, amountIn: bigint): bigint | null =>
  poolAmountOut(pool, tokenIn, amountIn)

/** What the pool charges, in raw tokenIn units, to release `amountOut` of `tokenOut`. */
export const poolCharges = (pool: Pool, tokenOut: Address, amountOut: bigint): bigint | null =>
  poolAmountIn(pool, tokenOut, amountOut)

/**
 * The pool's marginal rate: tokenOut per tokenIn at zero size, before the fee. This is the line
 * a size is measured against, so it must not carry the fee — otherwise every trade, however
 * small, would read as moving the pool by 0.29%.
 */
export function spotRate(
  pool: Pool,
  tokenIn: Address,
  decimalsIn: number,
  decimalsOut: number,
): number | null {
  const r = sides(pool, tokenIn)
  if (!r || r.reserveIn <= 0n || r.reserveOut <= 0n) return null
  return asNumber(r.reserveOut, decimalsOut) / asNumber(r.reserveIn, decimalsIn)
}

/** The rate a sale of `amountIn` actually gets: proceeds over size, fee and impact included. */
export function payRate(
  pool: Pool,
  tokenIn: Address,
  amountIn: bigint,
  decimalsIn: number,
  decimalsOut: number,
): number | null {
  const out = poolAmountOut(pool, tokenIn, amountIn)
  if (out === null || amountIn <= 0n) return null
  return asNumber(out, decimalsOut) / asNumber(amountIn, decimalsIn)
}

/**
 * The rate a purchase pays: what the pool charges for `amountOut` of `tokenOut`, over the size
 * bought. The other edge of the fee band. `decimalsCost` scales the token being spent.
 */
export function chargeRate(
  pool: Pool,
  tokenOut: Address,
  amountOut: bigint,
  decimalsCost: number,
  decimalsOut: number,
): number | null {
  const cost = poolAmountIn(pool, tokenOut, amountOut)
  if (cost === null || amountOut <= 0n) return null
  return asNumber(cost, decimalsCost) / asNumber(amountOut, decimalsOut)
}

/**
 * How far under the pool's own rate this size executes, in percent. This is the depth reading —
 * "your 250 tPLSX moves this pool 3.4%" — and it includes the swap fee, because the maker's
 * question is what they get, not how the shortfall splits between fee and impact.
 */
export function movePct(
  pool: Pool,
  tokenIn: Address,
  amountIn: bigint,
  decimalsIn: number,
  decimalsOut: number,
): number | null {
  const spot = spotRate(pool, tokenIn, decimalsIn, decimalsOut)
  const got = payRate(pool, tokenIn, amountIn, decimalsIn, decimalsOut)
  if (spot === null || got === null || spot === 0) return null
  return ((spot - got) / spot) * 100
}

/** The same pool after a swap of `amountIn` for `amountOut`. Pure: the snapshot is not mutated. */
export function afterSwap(
  pool: Pool,
  tokenIn: Address,
  amountIn: bigint,
  amountOut: bigint,
): Pool {
  const zeroIn = tokenIn.toLowerCase() === pool.token0.toLowerCase()
  return {
    ...pool,
    reserve0: zeroIn ? pool.reserve0 + amountIn : pool.reserve0 - amountOut,
    reserve1: zeroIn ? pool.reserve1 - amountOut : pool.reserve1 + amountIn,
  }
}

// ── The batch walk ────────────────────────────────────────────────────────────

/** One selected row, reduced to what pricing a batch needs. Addresses are market addresses. */
export type WalkFill = {
  key: string
  tokenIn: Address
  tokenOut: Address
  symbolIn: string
  symbolOut: string
  decimalsIn: number
  decimalsOut: number
  /** What the executor receives from the maker. */
  amountIn: bigint
  /**
   * What the fill costs the executor in tokenOut, at `now` — the gross.
   *
   * It is the whole outlay and not the maker's receipt. The settlement splits it: the maker
   * takes `required - fee` and the intent's `feeTo` takes `fee`. So the fee is already inside
   * this number and the walk below must never subtract it a second time.
   */
  required: bigint
  /** The fee inside `required`, in tokenOut. Carried for display, not for the walk's arithmetic. */
  fee: bigint
  /**
   * What this row is worth priced alone, in tokenOut — the figure the table shows. Carried so
   * the tray can say how far the batch moves it, and so a row with no pool still has a number.
   */
  soloNet: bigint | null
}

/** Where one fill lands once the fills before it have already moved the pool. */
export type WalkStep = {
  fill: WalkFill
  /** The `poolKey` of the pool this step walked. Steps of one pair share a curve. */
  pair: string
  /** How much of `amountIn` reached the pool. The rest was paid straight to an opposing row. */
  sold: bigint
  /** What the pool paid for `sold`, at the reserves this fill found. */
  poolOut: bigint
  /** tokenOut an opposing row in the same batch supplied, at no cost to the pool. */
  netted: bigint
  /** `poolOut + netted - required`, in tokenOut. What this fill adds to the batch. */
  net: bigint
  /** Total tokenIn sold into this pool up to and including this fill. */
  cumulativeIn: bigint
  /**
   * Running total of `net` in this fill's own tokenOut, over the fills before it that pay the
   * same token. A batch that trades both ways nets in two tokens at two decimal scales, and
   * adding those together would be arithmetic on nothing.
   */
  cumulativeNet: bigint
  /** `poolOut / sold` in display units — the rate this fill executed at. Null when nothing sold. */
  rate: number | null
}

export type Walk = {
  steps: WalkStep[]
  /** Net per token symbol, after fees. The tray's headline. */
  net: Map<string, { amount: bigint; decimals: number }>
  /** What the same rows sum to when each is priced alone — the figure this walk corrects. */
  solo: Map<string, { amount: bigint; decimals: number }>
  /** Rows whose pair has no pool. They keep their solo figure and are named as such. */
  unpriced: WalkFill[]
  /** Volume that never reached the pool because the batch paid itself, per token symbol. */
  selfNetted: Map<string, { amount: bigint; decimals: number }>
}

const min = (a: bigint, b: bigint) => (a < b ? a : b)

function bump(
  totals: Map<string, { amount: bigint; decimals: number }>,
  symbol: string,
  amount: bigint,
  decimals: number,
) {
  const t = totals.get(symbol)
  if (t) t.amount += amount
  else totals.set(symbol, { amount, decimals })
}

/**
 * Price a selection the way the pool will see it.
 *
 * Two passes, and the order matters. First the batch pays itself: rows going opposite ways on a
 * pair hand each other tokens directly, and that volume never touches the curve — which is why
 * a mixed batch is worth *more* than the sum of its rows, not less. Then whatever is left over
 * walks the curve in fill order, each fill priced at the reserves the fills before it left
 * behind. Netting is matched off the front of the queue, so the impact falls on the rows that
 * actually reach the pool.
 *
 * Rows whose pair has no pool cannot be walked. They keep the figure they were quoted with and
 * come back in `unpriced` so the caller can say so out loud.
 */
export function walkBatch(fills: readonly WalkFill[], pools: ReadonlyMap<string, Pool>): Walk {
  const steps: WalkStep[] = []
  const net = new Map<string, { amount: bigint; decimals: number }>()
  const solo = new Map<string, { amount: bigint; decimals: number }>()
  const selfNetted = new Map<string, { amount: bigint; decimals: number }>()
  const unpriced: WalkFill[] = []

  for (const f of fills) {
    if (f.soloNet !== null) bump(solo, f.symbolOut, f.soloNet, f.decimalsOut)
  }

  // One walk per pair. A selection may span several, and each pool moves on its own.
  const groups = new Map<string, WalkFill[]>()
  for (const f of fills) {
    const key = poolKey(f.tokenIn, f.tokenOut)
    const g = groups.get(key)
    if (g) g.push(f)
    else groups.set(key, [f])
  }

  for (const [key, group] of groups) {
    const snapshot = pools.get(key)
    if (!snapshot || !poolHolds(snapshot, group[0].tokenIn, group[0].tokenOut)) {
      for (const f of group) {
        unpriced.push(f)
        if (f.soloNet !== null) bump(net, f.symbolOut, f.soloNet, f.decimalsOut)
      }
      continue
    }

    // Pass one: what the batch can settle inside itself. A token the rows receive covers, unit
    // for unit, the same token the rows owe.
    const received = new Map<string, bigint>()
    const owed = new Map<string, bigint>()
    for (const f of group) {
      const i = f.tokenIn.toLowerCase()
      const o = f.tokenOut.toLowerCase()
      received.set(i, (received.get(i) ?? 0n) + f.amountIn)
      owed.set(o, (owed.get(o) ?? 0n) + f.required)
    }
    /** Per token, how much of it the batch hands to itself rather than to the pool. */
    const matched = new Map<string, bigint>()
    for (const [t, r] of received) {
      const o = owed.get(t) ?? 0n
      matched.set(t, r < o ? r : o)
    }

    // Both sides of the match are consumed in fill order: the earliest receipts pay the earliest
    // obligations, and only the tail of the queue reaches the curve.
    const receiptsLeft = new Map(matched)
    const creditsLeft = new Map(matched)

    let pool = snapshot
    let cumulativeIn = 0n
    /** Running net per payout token, so two directions never land in one sum. */
    const running = new Map<string, bigint>()
    for (const f of group) {
      const inKey = f.tokenIn.toLowerCase()
      const outKey = f.tokenOut.toLowerCase()

      const holdBack = min(receiptsLeft.get(inKey) ?? 0n, f.amountIn)
      receiptsLeft.set(inKey, (receiptsLeft.get(inKey) ?? 0n) - holdBack)
      const sold = f.amountIn - holdBack

      const netted = min(creditsLeft.get(outKey) ?? 0n, f.required)
      creditsLeft.set(outKey, (creditsLeft.get(outKey) ?? 0n) - netted)

      const poolOut = sold > 0n ? (poolAmountOut(pool, f.tokenIn, sold) ?? 0n) : 0n
      if (sold > 0n) pool = afterSwap(pool, f.tokenIn, sold, poolOut)

      // No `- f.fee`. The fee comes out of `f.required` rather than riding on top of it, so
      // subtracting it here charged the executor for it twice and read every batch as worse
      // than it is.
      const value = poolOut + netted - f.required
      cumulativeIn += sold
      const cumulativeNet = (running.get(f.symbolOut) ?? 0n) + value
      running.set(f.symbolOut, cumulativeNet)
      bump(net, f.symbolOut, value, f.decimalsOut)
      if (holdBack > 0n) bump(selfNetted, f.symbolIn, holdBack, f.decimalsIn)

      steps.push({
        fill: f,
        pair: key,
        sold,
        poolOut,
        netted,
        net: value,
        cumulativeIn,
        cumulativeNet,
        rate:
          sold > 0n
            ? asNumber(poolOut, f.decimalsOut) / asNumber(sold, f.decimalsIn)
            : null,
      })
    }
  }

  return { steps, net, solo, unpriced, selfNetted }
}

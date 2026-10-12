import { formatUnits } from 'viem'
import { minOutAt, type Intent, type TokenInfo } from '@prove.cash/sdk'
import type { Pool } from '../../lib/pool'

/**
 * One book, from two sources of the same thing.
 *
 * The pool and the board were being drawn as separate layers that happened to share an axis — a
 * shaded curve for the pool, bars for the offers, a dashed line for spot. Nothing was ever added
 * to anything. But depth is depth: an executor who will trade at a price does not care whether
 * the other side is a constant-product curve or somebody's signature. Both answer the same
 * question, so both belong in one number.
 *
 * That is what this module computes. `depthAt(p)` is how much base can change hands at an average
 * price no worse than `p`, counting the curve and the board together, and it says which part came
 * from where so a drawing can still show the split.
 *
 * The payoff is a thing neither layer shows alone. The pool has no capacity inside its own fee
 * band, so between `spot/γ` and `γ·spot` the curve is flat zero — but the board can and does rest
 * offers in there. On chain 943 it rests them on the wrong side of spot entirely, and the
 * combined book is the only place that is visible as depth rather than as a coincidence.
 */

export type Side = 'bid' | 'ask'

/** A price level the board is holding, in quote per base, with its depth in base tokens. */
export type Level = {
  rate: number
  size: number
  side: Side
  count: number
}

/** Depth at one price, and which side of the market supplied it. */
export type Depth = {
  /** From the constant-product curve. */
  pool: number
  /** From resting signed offers. */
  board: number
  total: number
}

/** Of every unit sent in, this fraction reaches the curve. The pool carries its own fee. */
export const gammaOf = (pool: Pool): number => Number(pool.feeNum) / Number(pool.feeDen)

/**
 * Which way round the pool's reserves are for this pair, as plain numbers.
 *
 * Takes the addresses the **pool** is keyed by, not the tokens the user picked. A wrapper token
 * trades under the address it wraps, so `marketAddress(token)` and `token.address` are different
 * strings for the same asset. Matching on the second silently found nothing, and the depth chart
 * drew an empty book over a pool holding 3.8 billion WPLS.
 *
 * Returns base and quote reserves in whole tokens. Null when the pool does not hold the pair.
 */
export function reservesOf(
  pool: Pool,
  baseMarket: string,
  baseDecimals: number,
  quoteMarket: string,
  quoteDecimals: number,
): { x: number; y: number } | null {
  const t0 = pool.token0.toLowerCase()
  const t1 = pool.token1.toLowerCase()
  const b = baseMarket.toLowerCase()
  const q = quoteMarket.toLowerCase()
  if (t0 === b && t1 === q) {
    return {
      x: Number(formatUnits(pool.reserve0, baseDecimals)),
      y: Number(formatUnits(pool.reserve1, quoteDecimals)),
    }
  }
  if (t0 === q && t1 === b) {
    return {
      x: Number(formatUnits(pool.reserve1, baseDecimals)),
      y: Number(formatUnits(pool.reserve0, quoteDecimals)),
    }
  }
  return null
}

/**
 * How much base the pool will buy at an average price of `p` or better.
 *
 * Selling `d` base pays `γ·d·y/(x + γ·d)` quote, so the average price is `γy/(x + γd)`. Setting
 * that to `p` and solving gives `d = y/p − x/γ`, which reaches zero at `p = γ·spot`. Above that
 * the fee alone puts the pool out of the running, whatever the size.
 */
export const poolBidDepth = (x: number, y: number, gamma: number, p: number): number =>
  p <= 0 ? 0 : Math.max(0, y / p - x / gamma)

/**
 * How much base the pool will sell at an average price of `p` or better.
 *
 * Taking `d` base out costs `d·y/((x − d)·γ)` quote, so the average price is `y/((x − d)γ)`.
 * Solving for `p` gives `d = x − y/(pγ)`, zero at `p = spot/γ` and approaching the whole reserve
 * as the price runs away.
 */
export const poolAskDepth = (x: number, y: number, gamma: number, p: number): number =>
  p <= 0 ? 0 : Math.max(0, x - y / (p * gamma))

/** Board depth on one side at `p`: every offer that a trade at `p` would satisfy. */
export function boardDepth(levels: readonly Level[], side: Side, p: number): number {
  let sum = 0
  for (const l of levels) {
    if (l.side !== side) continue
    // A bid stands if it pays at least `p`; an ask stands if it asks no more than `p`.
    if (side === 'bid' ? l.rate >= p : l.rate <= p) sum += l.size
  }
  return sum
}

/**
 * The whole book at one price: curve plus signatures.
 *
 * `reserves` is null on a pair with no pool, and then the board is the entire market — which is
 * the honest answer, not a reason to draw nothing.
 */
export function depthAt(
  p: number,
  side: Side,
  levels: readonly Level[],
  reserves: { x: number; y: number } | null,
  gamma: number,
): Depth {
  const pool = reserves
    ? side === 'bid'
      ? poolBidDepth(reserves.x, reserves.y, gamma, p)
      : poolAskDepth(reserves.x, reserves.y, gamma, p)
    : 0
  const board = boardDepth(levels, side, p)
  return { pool, board, total: pool + board }
}

/**
 * Sort every resting offer onto one price axis, in quote per base.
 *
 * Two offers pointing opposite ways across a pair are a bid and an ask, so the board already is a
 * book. Both sides are counted in the base token: counting each in its own token would put two
 * units on one axis and the depths would not add.
 *
 * Every floor is read at `now`, because a decaying offer's price is a function of the clock.
 */
export function levelsOf(
  intents: readonly Intent[],
  base: TokenInfo,
  quote: TokenInfo,
  now: bigint,
): Level[] {
  const raw: Level[] = []
  for (const i of intents) {
    const sellsBase = i.tokenIn.toLowerCase() === base.address.toLowerCase()
    const buysBase = i.tokenIn.toLowerCase() === quote.address.toLowerCase()
    if (!sellsBase && !buysBase) continue

    const out = minOutAt(i, now)
    if (out <= 0n || i.amountIn <= 0n) continue

    if (sellsBase) {
      // Selling base for quote: the rate is what they demand per base, so it is an ask.
      const size = Number(formatUnits(i.amountIn, base.decimals))
      const rate = Number(formatUnits(out, quote.decimals)) / size
      if (size > 0 && isFinite(rate)) raw.push({ rate, size, side: 'ask', count: 1 })
    } else {
      // Selling quote for base: the rate is what they pay per base, so it is a bid.
      const size = Number(formatUnits(out, base.decimals))
      const rate = Number(formatUnits(i.amountIn, quote.decimals)) / size
      if (size > 0 && isFinite(rate)) raw.push({ rate, size, side: 'bid', count: 1 })
    }
  }

  // Merge exact ties only. Bucketing by a tolerance would invent levels nobody signed, and a
  // reader uses these to decide what rate to sign next.
  const merged = new Map<string, Level>()
  for (const l of raw) {
    const key = `${l.side}:${l.rate}`
    const at = merged.get(key)
    if (at) {
      at.size += l.size
      at.count += 1
    } else {
      merged.set(key, { ...l })
    }
  }
  // Sorted by price alone, dearest at the top. On an uncrossed book that puts the asks above the
  // bids with the spread between them, which is the shape a reader expects — but this board is
  // free to cross, and on chain 943 it currently does: every bid outbids every ask. Sorting by
  // side first would hide exactly that, and a crossed book is where a ring pays.
  return [...merged.values()].sort((a, b) => b.rate - a.rate)
}

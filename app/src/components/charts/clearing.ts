import type { Level } from './book'

/**
 * Where the board pushes the pool, once everyone who can trade has traded.
 *
 * This is what a reserve-space picture needs and the other charts cannot give. A resting offer has
 * no coordinate in reserve space — its axes are token quantities, not prices — so an offer cannot
 * be plotted the way the depth chart plots it. What an offer does have is a *destination*: take it,
 * unwind it through the pool, and the reserves end up somewhere else. The board's contribution to
 * this drawing is therefore a displacement, not a mark.
 *
 * Clearing happens in the order a real executor would take it:
 *
 * 1. **Crossed offers match each other.** A bid above an ask needs no pool at all — that is a
 *    coincidence of wants, and settling it moves no reserves. Sending it through the curve instead
 *    would pay the fee twice and report a displacement that nobody would ever cause.
 * 2. **What is left is walked through the pool**, one offer at a time, in the order that pays best,
 *    and only while it still pays. Every fill moves the price for the next one, which is the whole
 *    reason a batch is not the sum of its quotes.
 *
 * The result is a bound rather than a forecast: it says how far this board *could* move this pool,
 * at the reserves it was read at, if every profitable trade were taken at once.
 */

export type Reserves = { x: number; y: number }

export type Clearing = {
  /** Reserves after everything profitable has been taken. */
  after: Reserves
  /** Base tokens the pool takes in. Negative when the pool is a net seller of base. */
  netBase: number
  /** Base matched directly between a bid and an ask, never touching the pool. */
  matched: number
  /** How many resting offers took part, on either path. */
  taken: number
}

/** What the pool pays per base for selling `s` base into it, fee included. */
const sellRate = (r: Reserves, g: number, s: number): number => (g * r.y) / (r.x + g * s)

/** What the pool charges per base to take `s` base out of it, fee included. */
const buyRate = (r: Reserves, g: number, s: number): number =>
  s >= r.x ? Infinity : r.y / ((r.x - s) * g)

/** Reserves after selling `s` base in. */
const afterSell = (r: Reserves, g: number, s: number): Reserves => ({
  x: r.x + s,
  y: r.y - (g * s * r.y) / (r.x + g * s),
})

/** Reserves after buying `s` base out. */
const afterBuy = (r: Reserves, g: number, s: number): Reserves => ({
  x: r.x - s,
  y: r.y + (s * r.y) / ((r.x - s) * g),
})

export function clear(
  levels: readonly Level[],
  reserves: Reserves | null,
  gamma: number,
): Clearing | null {
  if (!reserves || reserves.x <= 0 || reserves.y <= 0) return null

  // Cheapest ask first and dearest bid first: that is the order the money is in.
  const asks = levels
    .filter((l) => l.side === 'ask' && l.size > 0)
    .map((l) => ({ ...l }))
    .sort((a, b) => a.rate - b.rate)
  const bids = levels
    .filter((l) => l.side === 'bid' && l.size > 0)
    .map((l) => ({ ...l }))
    .sort((a, b) => b.rate - a.rate)

  let matched = 0
  let taken = 0

  // 1. The crossed part. While the best bid pays at least what the best ask demands, they are
  //    each other's counterparty and the pool is not involved.
  let i = 0
  let j = 0
  while (i < asks.length && j < bids.length && bids[j]!.rate >= asks[i]!.rate) {
    const size = Math.min(asks[i]!.size, bids[j]!.size)
    matched += size
    asks[i]!.size -= size
    bids[j]!.size -= size
    if (asks[i]!.size <= 1e-12) {
      taken += 1
      i++
    }
    if (bids[j]!.size <= 1e-12) {
      taken += 1
      j++
    }
  }

  // 2. The remainder against the curve. Each fill moves the price, so the next offer is tested
  //    against the reserves the last one left behind, not against the ones we started with.
  let at: Reserves = { ...reserves }
  let netBase = 0
  for (; i < asks.length; i++) {
    const a = asks[i]!
    if (a.size <= 1e-12) continue
    if (sellRate(at, gamma, a.size) < a.rate) break // and every ask after it is dearer
    at = afterSell(at, gamma, a.size)
    netBase += a.size
    taken += 1
  }
  for (; j < bids.length; j++) {
    const b = bids[j]!
    if (b.size <= 1e-12) continue
    if (buyRate(at, gamma, b.size) > b.rate) break // and every bid after it pays less
    at = afterBuy(at, gamma, b.size)
    netBase -= b.size
    taken += 1
  }

  return { after: at, netBase, matched, taken }
}

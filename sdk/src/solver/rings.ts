import type { Address } from 'viem'
import { armableAt } from './arming.js'
import { minOutAt } from '../intent.js'
import { ratesOf } from '../settlement.js'
import { pairKey, type BookEntry, type OrderBook } from './book.js'
import { depthFor, type MaxPerPair } from './depth.js'
import type { Market } from './market.js'

/**
 * Where a ring search looks for a market that gives `receives` for `pays`.
 *
 * One direction per call, because a market is bound to a direction: the same pair the other way
 * round is a different market with a different rate.
 */
export type MarketLookup = (receives: Address, pays: Address) => Market | null

/**
 * Finding the cycles that pay for each other.
 *
 * A leg is written from the executor's side, because that is the side that has to balance:
 * every leg hands the executor some of one token and takes some of another. An intent leg
 * gives `intent.tokenIn` and takes `intent.tokenOut`. A market leg gives whatever comes out of
 * the swap and takes whatever goes in.
 *
 * The cap is three legs, so there is no shortest-path problem to solve. Index by pair, look up
 * the closing edge, and check the ring condition. Bellman-Ford over a graph this shallow would
 * cost more than the answer is worth.
 */

/** A leg settled by filling a signed intent. */
export type IntentLeg = {
  kind: 'intent'
  /** The token the executor receives. Always `entry.intent.tokenIn`. */
  receives: Address
  /** The token the executor pays. Always `entry.intent.tokenOut`. */
  pays: Address
  entry: BookEntry
}

/**
 * A leg settled at a market: the executor pays in and takes out.
 *
 * `market` and not `pool`. The engine asks it four questions and never learns what kind of market
 * it is — see `market.ts` for why that matters, and for the second venue this repository already
 * has and the solver still cannot see.
 */
export type MarketLeg = {
  kind: 'market'
  receives: Address
  pays: Address
  market: Market
}

/** One step around a cycle. */
export type Leg = IntentLeg | MarketLeg

/** A closed cycle of legs. `legs[k].pays` is always `legs[k+1].receives`, wrapping at the end. */
export type Ring = {
  legs: readonly Leg[]
  /** Stable within a rotation, so two rotations of one cycle are two rings. */
  id: string
}

/** The token a ring's surplus lands in: the one the first leg hands over. */
export const profitToken = (ring: Ring): Address => ring.legs[0].receives

/** Every token a ring touches, in ring order. */
export const ringTokens = (ring: Ring): Address[] => ring.legs.map((l) => l.receives)

/** True when any leg of this ring closes at a market rather than against an intent. */
export const usesMarket = (ring: Ring): boolean => ring.legs.some((l) => l.kind === 'market')

/** The book keys of the intents a ring consumes. Two rings that share one cannot both settle. */
export const ringIntentKeys = (ring: Ring): string[] =>
  ring.legs.flatMap((l) => (l.kind === 'intent' ? [l.entry.key] : []))

const legId = (l: Leg): string =>
  l.kind === 'intent' ? `i:${l.entry.key}` : `m:${l.market.id}`

/** Build a ring from legs already in cycle order. Null when the legs do not close. */
export function makeRing(legs: readonly Leg[]): Ring | null {
  if (legs.length < 2) return null
  for (let k = 0; k < legs.length; k++) {
    const next = legs[(k + 1) % legs.length]
    if (legs[k].pays.toLowerCase() !== next.receives.toLowerCase()) return null
  }
  const ids = legs.map(legId)
  if (new Set(ids).size !== ids.length) return null
  return { legs, id: ids.join('>') }
}

/** Every rotation of a cycle. Each one banks its surplus in a different token. */
export function rotations(ring: Ring): Ring[] {
  const out: Ring[] = []
  for (let k = 0; k < ring.legs.length; k++) {
    const legs = [...ring.legs.slice(k), ...ring.legs.slice(0, k)]
    const r = makeRing(legs)
    if (r) out.push(r)
  }
  return out
}

// ── The ring condition ────────────────────────────────────────────────────────

const WAD_RATE = 10n ** 18n

/** A leg's marginal rate: how much `pays` one unit of `receives` costs, as an exact fraction. */
export function legRate(leg: Leg, at: bigint): { num: bigint; den: bigint } | null {
  if (leg.kind === 'intent') {
    const i = leg.entry.intent
    if (i.amountIn <= 0n) return null
    // The two rates the solver bears. P2 is paid on top of the maker's number, so the outlay per
    // unit is dearer by (1 + r2); P1 comes out of the handover, so a unit yields (1 - r1) of it.
    // P3 comes out of the maker's own proceeds and moves nothing the solver pays or gets.
    const r = ratesOf(i)
    if (r.handover >= WAD_RATE) return null
    return {
      num: minOutAt(i, at) * (WAD_RATE + r.output),
      den: i.amountIn * (WAD_RATE - r.handover),
    }
  }
  return leg.market.rate()
}

/**
 * The ring condition, in exact integers: `Π r_k ≤ 1`, over every leg.
 *
 * **The fee enters through a leg's own rate, at the two points the solver bears.** P2 (the output
 * rate) is paid on top of the maker's number, so it makes the leg dearer by `(1 + r2)`; P1 (the
 * handover rate) comes out of what the leg hands the executor, so it yields `(1 - r1)` of the
 * take. P3 comes out of the maker's own proceeds and costs the executor nothing, so it never
 * moves the boundary. The default configuration charges P2 only.
 *
 * A market leg still carries its venue fee, because that one is real money leaving the ring. It
 * lives inside the leg's own rate, exactly as it always did.
 *
 * This is a necessary condition on the rates, not a promise of profit. Integer rounding runs
 * against the executor at every step, so a ring that clears here by a hair still has to survive
 * `sizeRing`.
 */
export function ringCondition(ring: Ring, at: bigint): boolean {
  let num = 1n
  let den = 1n
  for (const leg of ring.legs) {
    const r = legRate(leg, at)
    if (!r || r.den <= 0n) return false
    if (r.num <= 0n) return true // a leg that asks for nothing closes any ring
    num *= r.num
    den *= r.den
  }
  return num <= den
}

// ── Enumeration ───────────────────────────────────────────────────────────────

/** How wide to search. Every bound here trades candidates for time. */
export type FindRingsOptions = {
  /**
   * How many legs a ring may have, from 2 up to `MAX_RING_LEGS`. **Three by default, and three
   * is the number to keep.**
   *
   * This is a safety control before it is a search bound, and the safety is not theoretical. A
   * ring settles atomically and cannot skip a leg — a skipped leg leaves the executor holding an
   * unhedged position — so every maker in a ring can revert the whole batch by invalidating their
   * own intent, for roughly 13k gas. That is finding E-3, and it is open: no on-chain fix exists.
   *
   * What it costs the executor is now measured rather than estimated
   * (`app/scripts/lab/atomic-revert.ts`). An eight-leg ring that loses its LAST leg burns 553,246
   * gas and fills nothing, which is 90% of the 612,524 it would have cost to settle. Against a
   * 13k cancel that is roughly 42:1. At three legs it is nearer 15:1. Every leg added makes it
   * worse, because the executor's cost grows with the ring and the attacker's does not.
   *
   * **This used to be typed `2 | 3` so that no caller could widen it, and that type was the
   * mitigation E-3 was closed on.** It is a plain number now because the ceiling was raised to
   * eight deliberately, which means the cap has moved from the compiler into this comment and
   * into whatever each caller passes. Anything above three is a risk somebody has to accept on
   * purpose. The other half of the mitigation still holds: `executeRing` simulates at the moment
   * of sending, which shrinks the window without closing it.
   *
   * Longer cycles do find coincidences of wants that shorter ones cannot — four makers can close
   * a loop where no two of them pair off. That is the trade, and it is not a free one.
   */
  maxLegs?: number
  /**
   * Entries kept per directed pair, cheapest rate first. One number caps every direction; a
   * `PairDepth` table caps each direction by its own tokens. See `depth.ts`.
   */
  maxPerPair?: MaxPerPair
  /** Stop after this many rings pass the condition. */
  maxRings?: number
  /**
   * Where to find a market for one direction, or omit to search intents only.
   *
   * A lookup rather than a table, so the search knows nothing about how a market is discovered.
   * `xykMarkets` turns the pool map `loadPools` returns into one of these; a venue with a
   * different discovery story supplies its own without touching this file.
   */
  markets?: MarketLookup
}

/** The cheapest entries on a pair for the executor: the ones asking least per unit taken. */
function best(entries: readonly BookEntry[], at: bigint, limit: number): BookEntry[] {
  return [...entries]
    // A leg is only a candidate while the signature that funds it is usable. An intent's own
    // window and its authorization's are different windows and nothing on chain reconciles them,
    // so a 3009 leg whose `validAfter` has not passed reaches the chain as `EscrowShort` — the
    // same answer as a spent nonce or an empty wallet. Reading the window is what tells a leg
    // that will never fill from one that fills in forty seconds. See `armingWindow`.
    .filter((e) => armableAt(e.intent, at))
    .sort((a, b) => {
      // Compare minOut/amountIn across two intents without leaving integers.
      const l = minOutAt(a.intent, at) * b.intent.amountIn
      const r = minOutAt(b.intent, at) * a.intent.amountIn
      return l < r ? -1 : l > r ? 1 : 0
    })
    .slice(0, limit)
}

/**
 * The longest cycle the search will build.
 *
 * A ring's surplus is bounded by its thinnest leg, every extra leg costs roughly 130k gas — a
 * six-leg ring measured 1,112,837, about 185k a leg — and every extra maker is one more signature
 * that can invalidate the whole batch, because a ring is atomic and does not skip. So a long ring
 * has to earn its length, and the gas model plus `--min-profit-native` are what make it.
 *
 * Eight is the ceiling rather than the target: the default stays at three, and the search is
 * bounded by `maxRings` and by never revisiting a token. Raising it only widens what a solver may
 * find; it does not make anything longer get sent.
 */
export const MAX_RING_LEGS = 8

/**
 * Every cycle in the book, from two legs up to `maxLegs`, that passes the ring condition at time
 * `at` — each rotation counted separately, because each one banks its surplus in a different token.
 *
 * A market leg, when a lookup is supplied, always closes the cycle: the swap settles in its own
 * transaction after the batch, so it belongs at the end where the intents have already paid for
 * it.
 */
export function findRings(book: OrderBook, at: bigint, opts: FindRingsOptions = {}): Ring[] {
  // Clamped rather than trusted: a caller asking for twenty legs would get a search that never
  // returns, and one asking for one would get a "ring" that is a single intent.
  const maxLegs = Math.max(2, Math.min(opts.maxLegs ?? 3, MAX_RING_LEGS))
  const maxRings = opts.maxRings ?? 200
  const markets = opts.markets

  /**
   * One pass builds both indexes: the kept entries per direction, and the directions leaving each
   * token.
   *
   * `leaving` is what makes a three-leg middle leg a lookup. It used to be a walk over every
   * direction in the book, keeping the ones whose key started with the right token, inside two
   * loops that already run once per direction and once per entry. That was quadratic in
   * directions: at 15,000 of them, 1.8e9 iterations, each allocating a fresh lowercased token and
   * a template string. Measured at around three minutes for one call, against a sixty-second
   * tick. Both other legs were already `pairs.get(pairKey(...))`, an ordinary lookup, and this
   * gives the middle one the same thing. Mean out-degree at 10,000 tokens over 15,000 directions
   * is 1.5, so the inner walk goes from fifteen thousand to about two.
   *
   * The two indexes share a pass because both want the direction's own tokens, and the pair key
   * holds them lowercase already. Splitting the key here costs two slices per direction, once per
   * call, and saves a second walk over the whole book.
   */
  const pairs = new Map<string, BookEntry[]>()
  const leaving = new Map<string, string[]>()
  for (const [k, list] of book.byPair) {
    const cut = k.indexOf('>')
    const from = k.slice(0, cut)
    const depth = depthFor(opts.maxPerPair, from, k.slice(cut + 1))
    // Depth zero means the operator declined to index this direction. Drop it from both indexes,
    // so no loop below ever reaches an empty list.
    if (depth === 0) continue
    pairs.set(k, best(list, at, depth))
    const out = leaving.get(from)
    if (out) out.push(k)
    else leaving.set(from, [k])
  }

  const rings: Ring[] = []
  const seen = new Set<string>()
  const push = (legs: readonly Leg[]): boolean => {
    const ring = makeRing(legs)
    if (!ring || seen.has(ring.id)) return rings.length < maxRings
    seen.add(ring.id)
    if (ringCondition(ring, at)) rings.push(ring)
    return rings.length < maxRings
  }

  const intentLeg = (e: BookEntry): IntentLeg => ({
    kind: 'intent',
    receives: e.intent.tokenIn,
    pays: e.intent.tokenOut,
    entry: e,
  })

  const marketLeg = (receives: Address, pays: Address): MarketLeg | null => {
    const market = markets?.(receives, pays)
    return market ? { kind: 'market', receives, pays, market } : null
  }

  /**
   * Walk out from one opening leg, closing the cycle wherever it can.
   *
   * At every token the path reaches, the ring can close two ways: an intent that pays the token
   * the cycle started in, or a market that does. Both are tried before the walk goes deeper, which
   * is the order the hand-written two- and three-leg version used and worth keeping — when
   * `maxRings` truncates, the shortest rings are the ones already found, and a short ring is
   * cheaper gas for the same surplus.
   *
   * `visited` keeps a cycle simple. Without it a walk can leave a token and come back to it
   * mid-path, which is two rings pretending to be one and cannot be sized. It also bounds the
   * search: no path is longer than the number of distinct tokens it has passed through.
   *
   * Returns false when the caller should stop entirely, which is how `maxRings` gets out of a
   * walk several frames deep.
   */
  const walk = (path: readonly Leg[], cur: Address, visited: Set<string>): boolean => {
    // Close it: an intent that pays the opening token, then the market that does.
    for (const closing of pairs.get(pairKey(cur, path[0].receives)) ?? []) {
      if (!push([...path, intentLeg(closing)])) return false
    }
    const market = marketLeg(cur, path[0].receives)
    if (market && !push([...path, market])) return false

    // Go deeper only if a closing leg still fits inside the limit.
    if (path.length + 2 > maxLegs) return true

    const start = path[0].receives.toLowerCase()
    for (const key of leaving.get(cur.toLowerCase()) ?? []) {
      for (const next of pairs.get(key) as BookEntry[]) {
        const onward = next.intent.tokenOut
        const k = onward.toLowerCase()
        // Returning to the opening token is a close, and the lines above already made it.
        if (k === start || visited.has(k)) continue
        visited.add(k)
        const more = walk([...path, intentLeg(next)], onward, visited)
        visited.delete(k)
        if (!more) return false
      }
    }
    return true
  }

  for (const [, firstList] of pairs) {
    for (const first of firstList) {
      const a = first.intent.tokenIn
      const b = first.intent.tokenOut
      if (!walk([intentLeg(first)], b, new Set([a.toLowerCase(), b.toLowerCase()]))) return rings
    }
  }

  return rings
}

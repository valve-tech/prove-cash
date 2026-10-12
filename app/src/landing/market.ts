import { minOutAt, type Window } from './decay.ts'
import { num } from '../lib/i18n.ts'
import { PRICE_TOKENS, type PriceToken } from './prices.ts'

/**
 * The market the hero card draws, built from real prices.
 *
 * It used to be a seeded mulberry32 walk pulled towards the middle of a band. From across the
 * room it read as a market; up close it read as a generated curve, because a mean-reverting
 * random walk has none of the clustering, the flat stretches or the jumps a real tape has. Real
 * hourly prices cost nothing to ship — see `prices.ts` and `scripts/gen-prices.mjs` — and they
 * look like what they are.
 *
 * Three things are drawn at random for every scene: which two tokens, which way round, and which
 * two days of the week. The size and both floor amounts follow from those, so no two loops of the
 * hero show the same offer. The card asks a reader to believe this is a market, and a market does
 * not replay the same forty-eight hours — see `useReplay` for when the swap happens.
 *
 * The offer itself is still made up, and the card says so. The prices under it are not.
 */

/** Two days of hourly prices. Long enough to look like a tape, short enough to be one offer. */
export const HOURS = 48

/** Where in the window the offer should fill. Past the middle, so the wait is the story. */
const TARGET = 0.58

/** The offer opens above every price it has met so far, so it starts un-fillable. */
const OPEN_ABOVE = 1.012

/**
 * What the example offer is worth, in dollars — a range, not a number.
 *
 * It was pinned at 25,000, and for a stablecoin that pins the size too: $25,000 of USDC is 25,000
 * USDC, and every rounding shape agrees on it. Three loops in a row offered "25,000 USDC". Drawn
 * log-uniformly so a small offer is as likely as a large one rather than the range clustering at
 * the top.
 */
const NOTIONAL_LOW = 6_000
const NOTIONAL_HIGH = 60_000

const notionalFrom = (pick: () => number): number =>
  NOTIONAL_LOW * (NOTIONAL_HIGH / NOTIONAL_LOW) ** pick()

export type Scene = {
  from: PriceToken
  to: PriceToken
  /** How much of `from` the offer gives up. A round number, near `NOTIONAL` in dollars. */
  size: number
  /** What the market pays for that size, hour by hour, in `to`. Real prices. */
  market: readonly number[]
  /** The signed offer, in the contract's own fields, over `HOURS` hours. */
  offer: Window
  /** The hour at which the floor first reaches the market. The fill. */
  fill: number
  /** How many hourly samples the scene holds. */
  hours: number
}

/** A float as raw token units. Rounds through 8 decimals, which is finer than any pixel. */
export function units(v: number, decimals: number): bigint {
  const keep = Math.min(decimals, 8)
  return BigInt(Math.round(v * 10 ** keep)) * 10n ** BigInt(Math.max(0, decimals - keep))
}

/**
 * An amount, at a precision that shows it moving.
 *
 * Two decimals everywhere would freeze a decaying floor quoted in WBTC: 0.4217 and 0.4180 both
 * print as 0.42, and the number the card is animating would sit still.
 */
export function money(v: number): string {
  const dp = v >= 1000 ? 2 : v >= 1 ? 3 : 6
  return num(v, { minimumFractionDigits: dp, maximumFractionDigits: dp })
}

/**
 * An offer size, at the precision it was chosen with.
 *
 * `money` pads to a fixed number of decimals, which is right for a floor that has to be seen
 * moving and wrong for a size: it would print 12 as 12.000 and 0.4 as 0.400000, a measurement
 * rather than a number somebody typed. This keeps whatever `pickSize` chose — 12, 13.28, 0.417,
 * 2,750 — and pads nothing.
 */
export function amount(v: number): string {
  if (v >= 1000) return num(v, { maximumFractionDigits: 0 })
  if (v >= 1) {
    // Three significant figures never needs more than two decimals at this magnitude.
    return num(v, { minimumFractionDigits: 0, maximumFractionDigits: 2 })
  }
  // Below one, a fixed four places would print 0.00081 as 0.0008 — a different number from the
  // one the offer holds. Scale the places to the magnitude so three figures always survive.
  const places = v > 0 ? Math.min(20, Math.max(4, 2 - Math.floor(Math.log10(v)))) : 4
  return num(v, { minimumFractionDigits: 0, maximumFractionDigits: places })
}

/** The roundest number near the target: 12, 3,000, 0.4. */
export function niceSize(target: number): number {
  if (!isFinite(target) || target <= 0) return 1
  const mag = 10 ** Math.floor(Math.log10(target))
  const steps = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
  let best = mag
  for (const s of steps) {
    if (Math.abs(s * mag - target) < Math.abs(best - target)) best = s * mag
  }
  return best
}

/**
 * An offer size, in one of the shapes a person actually types.
 *
 * Every size used to come from `niceSize`, so every loop of the hero offered 12 or 3,000 or 0.4 —
 * always a catalogue number, which is a tell that a machine picked it. People do type round
 * numbers, and often; they also type 13.28 because that is what was in the wallet, or 2,750
 * because they worked backwards from a total.
 *
 * The shapes available depend on the magnitude, and that is not decoration — `amount` prints a
 * size above a thousand with no decimals, so a size of 7,606.23 up there would appear on the card
 * as "7,606" and the offer would not be the number the reader is looking at. Above a thousand,
 * whole units only. Below one, significant figures, because whole units would be zero.
 *
 * Whatever it returns, `amount` can print it exactly; the test holds that against every branch.
 */
export function pickSize(target: number, pick: () => number): number {
  if (!isFinite(target) || target <= 0) return 1
  const style = pick()

  // Round, and the plurality at every size: 12, 3,000, 0.4.
  if (style < 0.42) return niceSize(target)

  // Above a thousand units, cents are noise — nobody counts them at that scale, and the card
  // cannot show them. Whole numbers, either exact or trimmed to three figures.
  if (target >= 1000) return style < 0.7 ? Math.round(target) : Number(target.toPrecision(3))

  // Below one, whole units would round to zero. Significant figures are the only shape that fits.
  if (target < 1) return Number(target.toPrecision(style < 0.7 ? 3 : 2))

  // In between, all three read naturally: 13, 13.28, 13.3.
  if (style < 0.62) return Math.round(target)
  if (style < 0.84) return Number(target.toFixed(2))
  return Number(target.toPrecision(3))
}

/** Every ordered pair worth drawing. Two stablecoins plot a flat line, so they are not a pair. */
export function pairs(tokens: readonly PriceToken[] = PRICE_TOKENS): [PriceToken, PriceToken][] {
  const out: [PriceToken, PriceToken][] = []
  for (const from of tokens) {
    for (const to of tokens) {
      if (from === to || (from.stable && to.stable)) continue
      out.push([from, to])
    }
  }
  return out
}

/**
 * The hours at which a straight falling floor can actually first meet this market.
 *
 * Not every hour is one. A floor opening at `open` and falling at `slope` first crosses at the
 * earliest `i` where `slope >= (open - market[i]) / i`, so raising the slope walks that threshold
 * down and skips any hour whose threshold is not a new low. A bisection aimed at an hour that is
 * not on this list lands somewhere else entirely — one draw put the crossing at hour 13 of 48
 * while asking for 27.
 */
function crossings(market: readonly number[], open: number): number[] {
  const out: number[] = []
  let low = Infinity
  for (let i = 1; i < market.length; i++) {
    const need = (open - market[i]!) / i
    if (need < low) {
      low = need
      out.push(i)
    }
  }
  return out
}

/** The reachable crossing nearest the one we want. */
function nearestCrossing(market: readonly number[], open: number, target: number): number | null {
  const all = crossings(market, open)
  if (all.length === 0) return null
  return all.reduce((best, i) => (Math.abs(i - target) < Math.abs(best - target) ? i : best))
}

/**
 * The slope that puts the crossing on hour `k`.
 *
 * A hair steeper than the exact threshold, because the offer is stored in whole token units and
 * `minOutAt` reads it back from there. Rounding to the token's last decimal can lift the floor a
 * fraction above the market at the very hour they are supposed to meet, and then the drawn line
 * misses the crossing the card is animating.
 */
function slopeFor(market: readonly number[], open: number, k: number): number {
  return (open - market[k]! * (1 - 1e-6)) / k
}

/**
 * How well a two-day slice of the week suits the hero.
 *
 * The prices are real whichever slice you take; this only decides which real two days to show.
 * A dead-flat stretch animates nothing. A stretch that falls off a cliff before the crossing
 * forces a floor that decays by half — a true drawing of an offer nobody would sign. And a
 * stretch whose reachable crossings all sit near one end puts the fill in the wrong place.
 * Returns the slice's range as a fraction, or null when it fails any of the three.
 */
function score(market: readonly number[], target: number): number | null {
  const hi = Math.max(...market)
  const lo = Math.min(...market)
  if (!isFinite(hi) || hi <= 0) return null
  const range = (hi - lo) / hi
  // Under this the line is a ruler and there is nothing to watch.
  if (range < 0.004) return null
  const open = Math.max(...market.slice(0, target + 1)) * OPEN_ABOVE
  // The floor has to reach the market without collapsing to get there.
  if (market[target]! < open * 0.9) return null
  const k = nearestCrossing(market, open, target)
  if (k === null || Math.abs(k - target) > market.length * 0.15) return null
  return range
}

/** `to` per one `from`, hour by hour, over one slice of the week. */
function rates(from: PriceToken, to: PriceToken, start: number, hours: number): number[] {
  const out: number[] = []
  for (let i = 0; i < hours; i++) out.push(from.usd[start + i]! / to.usd[start + i]!)
  return out
}

/**
 * One market, one offer over it, and the hour they meet.
 *
 * `pick` returns a number in [0, 1). The default is `Math.random`, so every visitor gets a
 * different pair and a different two days; a test passes its own and gets the same scene twice.
 */
export function scene(pick: () => number = Math.random, hours = HOURS): Scene {
  const all = pairs()
  const [from, to] = all[Math.min(all.length - 1, Math.floor(pick() * all.length))]!

  const target = Math.round((hours - 1) * TARGET)
  const last = from.usd.length - hours
  const starts: number[] = []
  for (let s = 0; s <= last; s++) {
    if (score(rates(from, to, s, hours), target) !== null) starts.push(s)
  }
  // Nothing qualified: take the liveliest slice there is rather than drawing no chart at all.
  const start =
    starts.length > 0
      ? starts[Math.min(starts.length - 1, Math.floor(pick() * starts.length))]!
      : bestStart(from, to, hours)

  const rate = rates(from, to, start, hours)
  const size = pickSize(notionalFrom(pick) / from.usd[start]!, pick)
  const market = rate.map((r) => r * size)

  const open = Math.max(...market.slice(0, target + 1)) * OPEN_ABOVE
  const k = nearestCrossing(market, open, target) ?? hours - 1
  const slope = slopeFor(market, open, k)

  const offer: Window = {
    amountIn: units(size, from.decimals),
    minOutStart: units(open, to.decimals),
    minOutEnd: units(Math.max(open - slope * (hours - 1), open * 0.01), to.decimals),
    startTime: 0n,
    endTime: BigInt(hours - 1) * 3600n,
    // A straight line across the whole window, which is kind 0 and the zero word. The hero shows
    // one offer decaying against a real tape; a shape would be a second idea in the same picture.
    curve: `0x${'00'.repeat(32)}`,
    flags: 0,
  }

  // Read the crossing back off the offer as stored, not off the slope that built it. The card
  // draws `minOutAt`, so the hour it names has to be the hour the two lines meet on screen.
  const drawn = Array.from({ length: hours }, (_, i) => floorOf(offer, to.decimals, i, hours))
  const fill = firstCrossOf(drawn, market)

  return { from, to, size, market, offer, hours, fill }
}

/** The stored floor at hour `i`, in whole `to`. The one line the chart draws. */
function floorOf(offer: Window, decimals: number, i: number, hours: number): number {
  const span = offer.endTime - offer.startTime
  const at = (BigInt(Math.round(i * 1000)) * span) / BigInt((hours - 1) * 1000)
  return Number(minOutAt(offer, offer.startTime + at)) / 10 ** decimals
}

/** The first hour at which the drawn floor is at or under the drawn market. */
function firstCrossOf(floor: readonly number[], market: readonly number[]): number {
  for (let i = 0; i < floor.length; i++) if (floor[i]! <= market[i]!) return i
  return floor.length - 1
}

/** The slice with the widest range, for a pair where no slice passed both tests. */
function bestStart(from: PriceToken, to: PriceToken, hours: number): number {
  let best = 0
  let bestRange = -1
  for (let s = 0; s <= from.usd.length - hours; s++) {
    const m = rates(from, to, s, hours)
    const hi = Math.max(...m)
    const range = hi > 0 ? (hi - Math.min(...m)) / hi : 0
    if (range > bestRange) {
      bestRange = range
      best = s
    }
  }
  return best
}

/** The floor at hour `i`, from the formula the contract runs. */
export function floorAt(s: Scene, i: number): number {
  return floorOf(s.offer, s.to.decimals, i, s.hours)
}

/** A series read at a fractional index, with a straight line between samples. */
export function at(series: readonly number[], x: number): number {
  const c = Math.min(series.length - 1, Math.max(0, x))
  const i = Math.floor(c)
  const a = series[i] ?? 0
  const b = series[Math.min(i + 1, series.length - 1)] ?? a
  return a + (b - a) * (c - i)
}

/** A range with room above and below, and never a floor at or under zero on a positive series. */
export function frame(values: readonly number[], fraction = 0.1): [number, number] {
  const clean = values.filter((v) => isFinite(v))
  const lo = Math.min(...clean)
  const hi = Math.max(...clean)
  if (hi === lo) return [lo * 0.95, hi * 1.05]
  const pad = (hi - lo) * fraction
  const padded = lo - pad
  return [lo > 0 && padded <= 0 ? lo / 2 : padded, hi + pad]
}

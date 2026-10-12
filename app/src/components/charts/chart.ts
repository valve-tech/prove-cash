import { fixed, num, t } from '../../lib/i18n'
import type { Pool, PoolRead } from '../../lib/pool'
import { short } from '../../lib/address'
import { STEPS, windowAt, type Fall } from '../../lib/curve'

/**
 * The small shared parts of a chart: scales, the number formats the axes use, and the sentence
 * that names where a figure came from.
 *
 * Nothing here holds state or touches the DOM, so the formats are unit-testable and the same
 * `rateText` runs in the plot, the tooltip and the screen-reader line.
 */

/** A linear scale from a data range to a pixel range. */
export const lin =
  (d0: number, d1: number, r0: number, r1: number) =>
  (v: number): number =>
    d1 === d0 ? r0 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0)

/**
 * Six significant digits, no trailing zeros. Rates on these pairs run from 1e-6 to 1e5.
 *
 * `num` and not `toString`, for the same reason `sizeText` uses it above a thousand: a reader
 * whose language writes 0,5432 must not be shown 0.5432. This split a single axis — `sizeText`
 * was locale-aware over a thousand and dot-only under it, so a Czech chart could label one tick
 * `9,14 mld.` and the next `0.5432`, with the two separators meaning opposite things.
 *
 * The exponential branch still writes a dot. `Intl` can format scientific notation, but changing
 * it moves every tick's width, and a value below 1e-6 is rare enough to leave for a day when
 * somebody can look at the layout.
 */
export function rateText(rate: number): string {
  if (!isFinite(rate) || rate === 0) return '0'
  if (Math.abs(rate) < 1e-6 || Math.abs(rate) >= 1e9) return rate.toExponential(3)
  return num(rate, { maximumSignificantDigits: 6 })
}

/** An axis label: four significant digits, because a tick is a landmark, not a quote. */
export function tickText(rate: number): string {
  if (!isFinite(rate)) return ''
  if (rate !== 0 && (Math.abs(rate) < 1e-5 || Math.abs(rate) >= 1e7)) return rate.toExponential(1)
  return num(rate, { maximumSignificantDigits: 4 })
}

/** A signed percentage, always two decimals, so a column of them lines up. */
export const pctText = (v: number): string => `${v >= 0 ? '+' : '−'}${fixed(Math.abs(v), 2)}%`

/** A size, at the precision a reader can hold in their head. */
/**
 * A token quantity, for an axis label or a one-line detail.
 *
 * **Compact above a hundred thousand, and the axis is why.** A depth peak is a pool reserve, and
 * a reserve on a real pair runs to ten digits: `9,139,193,647` is 77 pixels of text against a
 * 46-pixel gutter, so it rendered 31 pixels outside the viewBox and the reader saw `,193,647`.
 * The digits past the third were never information — nobody reads a reserve to the unit — and
 * dropping them fixes the layout and the legibility with one change.
 *
 * A hundred thousand is the line because a trade size is usually under it and a reserve is
 * usually over it. Under the line the number is exact, which is what a size wants.
 *
 * `num` formats in the reader's locale, so the compact suffix is theirs too: `9.14B` in English,
 * `9,14 Mrd.` in German, `91.4亿` in Chinese — where the grouping is by ten thousands and a
 * hard-coded `B` would have been simply wrong.
 */
export function sizeText(v: number): string {
  if (!isFinite(v)) return '—'
  if (v === 0) return '0'
  if (Math.abs(v) >= 100_000) return num(v, { notation: 'compact', maximumFractionDigits: 2 })
  if (Math.abs(v) >= 1000) return num(Math.round(v))
  if (Math.abs(v) >= 1) return num(v, { maximumSignificantDigits: 4 })
  return num(v, { maximumSignificantDigits: 3 })
}

/** Minutes, spoken the way a countdown is read. `m` and `h` are units, so they do not translate. */
export function minutesText(minutes: number): string {
  if (!isFinite(minutes) || minutes < 0) return '—'
  if (minutes < 1) return t('chart.minutes.under')
  if (minutes < 60) return `${Math.round(minutes)}m`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}


/**
 * Where the curve came from, in one line under the plot. Every figure a chart draws is computed
 * from this snapshot, and a reader is entitled to know which pair it is and how old it is.
 */
export function poolSource(pool: Pool): string {
  const fee = fixed((Number(pool.feeDen - pool.feeNum) / Number(pool.feeDen)) * 100, 2)
  const pair = short(pool.address)
  // Two keys rather than one with an optional clause: a translator cannot place a fragment they
  // cannot see, and the block number is either part of the sentence or not in it at all.
  return pool.blockNumber > 0n
    ? t('chart.source.block', { pair, block: num(pool.blockNumber), fee })
    : t('chart.source', { pair, fee })
}

/**
 * What a panel says when it has no curve to draw.
 *
 * Four different facts, and the difference between them matters to a maker deciding a floor. "No
 * router on this chain" is about the chain. "No pool for this pair" is about the pair. "The pair
 * holds nothing" is about the pool. "The reserves did not come back" is about the endpoint, and
 * it is the one that keeps getting lost: a rate-limited RPC used to fall through to the empty-pool
 * sentence, so the panel stated something about market structure on the strength of a 429. It has
 * happened three times in three panels, so the decision lives here now and is tested once.
 */
export function noCurveText(state: PoolRead['state'], symIn: string, symOut: string): string {
  if (state === 'no-market') return t('chart.pool.noRouter')
  if (state === 'unreadable') return t('chart.pool.failed')
  if (state === 'no-pool') return t('chart.pool.noPool', { in: symIn, out: symOut })
  return t('chart.pool.empty', { in: symIn, out: symOut })
}

/**
 * Pad a value range so nothing sits on the frame, and never return a zero-height range — a flat
 * series would otherwise divide by zero and put every point on one pixel.
 *
 * A frame over positive values stays positive. This matters on a rate axis: a constant-product
 * pool's price is asymptotic to both axes, so it falls as far as you push it and never arrives at
 * zero. Padding alone can drop the floor below zero whenever the smallest plotted rate is small
 * against the spread, and then the chart draws a gridline at a price the pool cannot reach and a
 * negative one under it. Callers with a rate on this axis get a floor at half the smallest value
 * instead — still clear of the line, still a price.
 */
export function padRange(values: readonly number[], fraction = 0.08): [number, number] {
  const clean = values.filter((v) => isFinite(v))
  if (clean.length === 0) return [0, 1]
  let lo = Math.min(...clean)
  let hi = Math.max(...clean)
  if (hi === lo) {
    const step = Math.abs(hi) > 0 ? Math.abs(hi) * 0.05 : 1
    lo -= step
    hi += step
  }
  const pad = (hi - lo) * fraction
  const padded = lo - pad
  return [lo > 0 && padded <= 0 ? lo / 2 : padded, hi + pad]
}

/**
 * What the decay strip draws, as numbers. Minutes on the x axis, rates on the y.
 *
 * Pure, and separate from the drawing for the reason `signCurve` is. The whole of the schedule
 * lives in six lines of arithmetic between a form and a `viewBox`. None of it was reachable from
 * a test while it sat inside the render.
 */
export type DecayShape = {
  /** The right-hand edge of the plot, in minutes from now. */
  axis: number
  /** When the offer opens, in minutes from now. Zero is now. */
  open: number
  /** When anybody can first fill it, in minutes from now. Never earlier than `open`. */
  live: number
  /** When the price starts falling, in minutes from now. Never earlier than `open`. */
  fallFrom: number
  /** When it reaches the floor, in minutes from now. Never later than `axis`. */
  fallTo: number
  /** When the falling price meets the pool, in minutes from now, or null when it never does. */
  cross: number | null
  /** True when a fill can land inside the window at these reserves. */
  fillable: boolean
}

export function decayShape({
  startRate,
  endRate,
  poolRate,
  duration,
  startsIn,
  liveIn,
  fall,
}: {
  startRate: number
  endRate: number
  poolRate: number
  /** The offer's own window, in seconds. */
  duration: number
  /** Seconds from now until it opens. */
  startsIn: number
  /** Seconds from now until it can first fill. */
  liveIn: number
  /**
   * Where inside the window the price falls. Signed, like both rates — the maker fixed it when
   * they signed, and nothing this chart reads from the chain may move it.
   */
  fall: Fall
}): DecayShape {
  const open = startsIn / 60
  const live = Math.max(liveIn, startsIn) / 60
  const span = duration / 60
  const axis = open + span

  // The stretch, on the same clock as everything else in this shape.
  const fallFrom = open + (fall.from / STEPS) * span
  const fallTo = open + (fall.to / STEPS) * span

  /*
   * How far down its own curve the offer has to travel to reach the pool, as a fraction of the
   * fall. The price does not move before the offer opens, so this is measured along the sloped
   * part alone — an offer that opens in six hours has not decayed a wei in the meantime.
   */
  const drop = startRate - endRate
  const fraction = drop > 0 ? (startRate - poolRate) / drop : startRate <= poolRate ? 0 : 2

  /*
   * The first second a fill can actually land. Two things gate it and the later one wins: the
   * price has to reach the pool, and the funding signature's own window has to be open. A maker
   * whose authorization opens after their offer does waits for the authorization, however cheap
   * the price has already become.
   *
   * `windowAt` places the crossing inside the stretch rather than across the whole window. An
   * offer that rests flat for half its life and then falls meets the pool halfway down that
   * second half, not halfway down the window — and the difference is the whole point of the
   * shape. A fraction at or below zero is met the second the offer opens: the ceiling is already
   * at or under what the pool pays, so the flat run-in is fillable too.
   */
  const met = fraction <= 0 ? open : open + windowAt(fall, fraction) * span
  const cross = Math.max(met, live)
  const fillable = fraction <= 1 && cross <= axis
  return { axis, open, live, fallFrom, fallTo, cross: fillable ? cross : null, fillable }
}

/**
 * The maker's floor at a moment, as a rate: flat at the ceiling, then falling, then flat at the
 * floor.
 *
 * Signed arithmetic only. Both rates and the shape were fixed at signing; nothing live reaches
 * this. It is the polyline the strip draws, and the strip draws it by asking this at each
 * breakpoint — so a reader cannot be shown a corner the arithmetic does not have.
 */
export function decayRateAt(
  s: DecayShape,
  startRate: number,
  endRate: number,
  at: number,
): number {
  if (at <= s.fallFrom) return startRate
  if (at >= s.fallTo) return endRate
  return startRate + ((endRate - startRate) * (at - s.fallFrom)) / (s.fallTo - s.fallFrom)
}

/**
 * Every corner of that line, left to right, in minutes from now.
 *
 * Five points and not three. Two of them collapse onto their neighbours on today's line — the
 * offer opens at zero and falls the whole way — and a polyline is happy to draw a segment of no
 * length, so there is one list rather than a branch per shape.
 */
export const decayBreaks = (s: DecayShape): number[] => [
  0,
  s.open,
  s.fallFrom,
  s.fallTo,
  s.axis,
]

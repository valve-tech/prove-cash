/**
 * Dutch decay, in the few lines the contract uses.
 *
 * The landing page draws a live intent, so it needs the real formula and not a hand-drawn line.
 * It cannot import `@prove.cash/sdk` for it — that pulls viem into the entry bundle and undoes the
 * landing/dapp split (see routes.ts). So the formula is copied here, and `decay.test.ts` runs both
 * copies against the same inputs so this one cannot drift.
 *
 * The `curve` field and its kind bits are copied for the same reason. The page's own scenes are
 * all straight lines, but a copy that only handles the case the page uses is a copy that agrees
 * with the original until the day somebody widens the page — and the sweep in `decay.test.ts`
 * fuzzes both kinds so it cannot.
 */
import { num } from '../lib/i18n.ts'

/**
 * Which bits of `flags` name the curve kind, and what the two implemented kinds are.
 *
 * Written out rather than imported, like the formula below and for the same reason. Kinds 2 and 3
 * — knots and a cubic — are reserved in the format and implemented nowhere, so an intent wearing
 * one is not something this page can draw.
 */
const FLAG_CURVE_KIND = 24
const KIND_STRETCH = 8

/** One whole, in the units a stretch's two fractions are counted in. */
const KNOT_ONE = 65535n

/** The fields the floor depends on, plus the size the fill is quoted against. */
export type Window = {
  amountIn: bigint
  minOutStart: bigint
  minOutEnd: bigint
  startTime: bigint
  endTime: bigint
  /** The signed shape, as 32 bytes. All zeros is the straight line, and reads as nothing. */
  curve: `0x${string}`
  /** The signed flags. Bits 8 and 16 say how to read `curve`. */
  flags: number
}

/** The minimum token B owed for the whole `amountIn`, at time `now` (seconds). */
export function minOutAt(w: Window, now: bigint): bigint {
  if (now <= w.startTime) return w.minOutStart
  if (now >= w.endTime) return w.minOutEnd
  const span = w.endTime - w.startTime
  if (span === 0n) return w.minOutEnd
  const elapsed = now - w.startTime
  if ((w.flags & FLAG_CURVE_KIND) === KIND_STRETCH) {
    return stretchAt(w.minOutStart, w.minOutEnd, w.curve, elapsed, span)
  }
  return w.minOutStart - ((w.minOutStart - w.minOutEnd) * elapsed) / span
}

/**
 * Kind 1: flat at the ceiling, one fall, flat at the floor.
 *
 * `startF` is where the fall begins and `lenF` how long it lasts, both as a fraction of the window
 * in units of 1/65535. A `lenF` of zero means "to the end of the window", which is why the sign
 * form never signs one — a maker who dragged the two handles together would get the opposite of
 * the instant drop they drew.
 *
 * The subtrahend floors, so the maker's price rounds up. That is what the straight line above
 * does, and a stretch must not round the other way at the same instant.
 */
function stretchAt(
  hi: bigint,
  lo: bigint,
  curve: `0x${string}`,
  elapsed: bigint,
  span: bigint,
): bigint {
  const word = BigInt(curve)
  const startF = word >> 240n
  let lenF = (word >> 224n) & 0xffffn
  if (lenF === 0n) lenF = KNOT_ONE - startF
  const pos = elapsed * KNOT_ONE
  const begin = startF * span
  if (pos <= begin) return hi
  // Named around the `num` this module already imports from i18n, which a local `num` would
  // shadow for every reader who scrolls past this function.
  const denom = lenF * span
  const numer = pos - begin
  if (numer >= denom) return lo
  return hi - ((hi - lo) * numer) / denom
}

/**
 * Token B a fill of `take` token A costs the filler. Rounds up, so rounding favours the maker.
 *
 * **This is the gross, not the maker's receipt, and the two stopped being the same number.**
 * The settlement splits this figure: the maker receives `gross - fee` and the intent's `feeTo`
 * receives `fee`. The curve this page draws is the filler's outlay, because that is what the
 * decay is an auction over — a solver decides at the price they pay, not at the price the maker
 * banks. An intent charging no fee makes the two equal, which is every intent this page draws.
 */
export function grossOut(w: Window, take: bigint, now: bigint): bigint {
  const m = minOutAt(w, now)
  return (take * m + w.amountIn - 1n) / w.amountIn
}

/** A fixed-point amount as `12,345.67`. Truncates, and never rounds a floor up. */
export function fmt(v: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals)
  const whole = num(v / unit)
  const rest = ((v % unit) * 100n) / unit
  return `${whole}.${rest.toString().padStart(2, '0')}`
}

import { CURVE_LINEAR, KIND_LINEAR, KIND_STRETCH, stretchCurve } from '@prove.cash/sdk'
import type { Hex } from 'viem'

/**
 * The shape of an offer's decay, as the sign form holds it.
 *
 * The chain walks one straight line from `minOutStart` to `minOutEnd` across the whole window.
 * A stretch says *where inside the window* that line lives: flat at the ceiling before it, falling
 * across it, flat at the floor after it. Two numbers, both fractions of the window.
 *
 *     price(u) = lerp(minOutStart, minOutEnd, clamp01((u - start) / length))
 *
 * Four shapes come out of it, and they are the four anybody has asked for:
 *
 *   | shape                                    | from | to  |
 *   |------------------------------------------|------|-----|
 *   | today's line                             | 0    | 1   |
 *   | dutch over the first quarter, then flat  | 0    | ¼   |
 *   | flat for half, then dutch to the close   | ½    | 1   |
 *   | flat a quarter, dutch a quarter, flat    | ¼    | ½   |
 *
 * **Every number here is signed.** The shape is fixed the moment the maker puts their name to the
 * offer, and no live reading may reach it — not the pool price, not the base fee, not the clock.
 * The one live thing near it is the "where we are now" marker the chart draws, and that is drawn
 * on top rather than folded in. `docs/FEE-MODEL.md` Part 5 is the rule; mixing the two produced
 * three defects in one day.
 *
 * **The chart is a pixel finer than the wire, and that is the direction to know about.** The
 * format counts the window in 1/65,535ths, so `stretchCurve` rounds a quarter to 16,384 and the
 * chain then floors that back through the span: on a one-hour offer the fall begins at 14m59s
 * where this module says 15m00s. Under a second on every window this form offers, deterministic,
 * and far under a block — but it is the chain's number that gets paid, not this one.
 *
 * Nothing here fetches and nothing reads a clock.
 */

/**
 * How many steps a handle moves in, across the whole window.
 *
 * Twenty-four, because it lands exactly on every fraction a person names — halves, thirds,
 * quarters, sixths, eighths and twelfths — and the four shapes above need quarters to be exact.
 * It is also a usable step on every window this form offers: 37 seconds of a fifteen-minute
 * offer, an hour of a day-long one.
 */
export const STEPS = 24

/**
 * When the price starts falling and when it reaches the floor, in steps of the window.
 *
 * Integers and not fractions, so a quarter is a quarter. `6 / 24` is exact in binary and
 * `18 / 24 - 12 / 24` is not, and a shape that drifts by a float's last bit signs a different
 * word from the one the chart drew.
 */
export type Fall = { from: number; to: number }

/** The whole window, which is the line the chain has always walked. */
export const FULL_FALL: Fall = { from: 0, to: STEPS }

/** True when this is today's line: falling from the first second to the last. */
export const isFullFall = (f: Fall): boolean => f.from === 0 && f.to === STEPS

/**
 * The smallest fall this form will sign, in steps.
 *
 * **Not zero, and this is the one rule the encoding needs.** A zero length means "to the end of
 * the window" on the wire — the contract reads `lenF == 0` as `65535 - startF` — so a maker who
 * dragged the two handles together would sign the opposite of the instant drop they drew. One
 * step is the shortest fall that means what it looks like.
 */
const MIN_FALL = 1

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** Move the handle that starts the fall, keeping it a step clear of the other one. */
export const moveFrom = (f: Fall, step: number): Fall => ({
  from: clamp(Math.round(step), 0, f.to - MIN_FALL),
  to: f.to,
})

/** Move the handle that ends the fall, keeping it a step clear of the other one. */
export const moveTo = (f: Fall, step: number): Fall => ({
  from: f.from,
  to: clamp(Math.round(step), f.from + MIN_FALL, STEPS),
})

/**
 * How far the price has fallen at fraction `u` of the window: 0 at the ceiling, 1 at the floor.
 *
 * The same clamp the contract makes, in floating point, for drawing. It is never the source of a
 * signed number — `minOutAt` is — so the precision is a pixel's worth and that is enough.
 */
export function fallenAt(f: Fall, u: number): number {
  const from = f.from / STEPS
  const to = f.to / STEPS
  if (u <= from) return 0
  if (u >= to) return 1
  return (u - from) / (to - from)
}

/**
 * The inverse: at what fraction of the window has the price fallen `part` of the way?
 *
 * Outside the fall the question has no single answer — the price sits at the ceiling for a
 * stretch and at the floor for another — so this returns the *first* moment it is true, which is
 * the moment a filler acts on.
 */
export function windowAt(f: Fall, part: number): number {
  if (part <= 0) return 0
  const from = f.from / STEPS
  const to = f.to / STEPS
  if (part >= 1) return to
  return from + part * (to - from)
}

/**
 * The signed curve word this shape asks for, and the kind bits that say how to read it.
 *
 * **A default offer signs exactly what this form has always signed.** A flat offer has no fall to
 * shape, and a fall across the whole window is the straight line kind 0 already walks — so both
 * take `CURVE_LINEAR` and no kind bits. The stretch costs 480 gas a fill and 0.27% more proof of
 * work on the post, and a maker who never touched the control should pay neither.
 */
export function curveTerms(x: { dutch: boolean; fall: Fall }): { curve: Hex; kind: number } {
  if (!x.dutch || isFullFall(x.fall)) return { curve: CURVE_LINEAR, kind: KIND_LINEAR }
  return {
    curve: stretchCurve(x.fall.from / STEPS, (x.fall.to - x.fall.from) / STEPS),
    kind: KIND_STRETCH,
  }
}

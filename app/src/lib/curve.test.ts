import { describe, expect, test } from 'vitest'
import { CURVE_LINEAR, KIND_LINEAR, KIND_STRETCH, stretchCurve } from '@prove.cash/sdk'
import {
  curveTerms,
  fallenAt,
  FULL_FALL,
  isFullFall,
  moveFrom,
  moveTo,
  STEPS,
  windowAt,
  type Fall,
} from './curve'

/**
 * The four shapes the sign form has to make reachable, named the way the spec names them.
 *
 * They are the whole point of the field. Every one of them has to come out of two handles, and
 * every one has to survive the trip through `stretchCurve` unchanged.
 */
const SHAPES: Record<string, Fall> = {
  "today's line": FULL_FALL,
  'dutch over the first quarter, then flat': { from: 0, to: STEPS / 4 },
  'flat for half, then dutch to the close': { from: STEPS / 2, to: STEPS },
  'flat a quarter, dutch a quarter, flat a half': { from: STEPS / 4, to: STEPS / 2 },
}

describe('the four shapes are reachable, and they are exact', () => {
  test('every one lands on a whole number of steps', () => {
    for (const fall of Object.values(SHAPES)) {
      expect(Number.isInteger(fall.from)).toBe(true)
      expect(Number.isInteger(fall.to)).toBe(true)
    }
  })

  test('the quarters are exact fractions, not a float that nearly is', () => {
    expect(SHAPES['dutch over the first quarter, then flat']!.to / STEPS).toBe(0.25)
    expect(SHAPES['flat for half, then dutch to the close']!.from / STEPS).toBe(0.5)
    const sandwich = SHAPES['flat a quarter, dutch a quarter, flat a half']!
    expect(sandwich.from / STEPS).toBe(0.25)
    expect((sandwich.to - sandwich.from) / STEPS).toBe(0.25)
  })
})

describe('what gets signed', () => {
  test("today's line signs the zero word and no kind bits", () => {
    const { curve, kind } = curveTerms({ dutch: true, fall: FULL_FALL })
    expect(curve).toBe(CURVE_LINEAR)
    expect(kind).toBe(KIND_LINEAR)
  })

  test('a flat offer signs the zero word too, whatever the handles say', () => {
    for (const fall of Object.values(SHAPES)) {
      expect(curveTerms({ dutch: false, fall })).toEqual({
        curve: CURVE_LINEAR,
        kind: KIND_LINEAR,
      })
    }
  })

  test('every other shape signs a stretch, with the fractions the handles hold', () => {
    for (const [name, fall] of Object.entries(SHAPES)) {
      if (isFullFall(fall)) continue
      const { curve, kind } = curveTerms({ dutch: true, fall })
      expect(kind, name).toBe(KIND_STRETCH)
      expect(curve, name).toBe(stretchCurve(fall.from / STEPS, (fall.to - fall.from) / STEPS))
    }
  })
})

describe('the handles cannot be dragged into a shape nobody can sign', () => {
  /**
   * The one rule the encoding needs. A zero length reads as "to the end of the window" on the
   * wire, so two handles on the same step would sign the opposite of the instant drop they drew.
   */
  test('they never meet, so the fall is never zero long', () => {
    const fall = { from: 6, to: 7 }
    expect(moveFrom(fall, 7).from).toBe(6)
    expect(moveFrom(fall, 20).from).toBe(6)
    expect(moveTo({ from: 6, to: 12 }, 6).to).toBe(7)
    expect(moveTo({ from: 6, to: 12 }, 0).to).toBe(7)
  })

  test('and they stay inside the window', () => {
    expect(moveFrom(FULL_FALL, -5).from).toBe(0)
    expect(moveTo({ from: 0, to: 12 }, 999).to).toBe(STEPS)
  })

  test('the other handle never moves when one does', () => {
    expect(moveFrom({ from: 4, to: 18 }, 9)).toEqual({ from: 9, to: 18 })
    expect(moveTo({ from: 4, to: 18 }, 9)).toEqual({ from: 4, to: 9 })
  })
})

describe('where the price is, as a fraction of the fall', () => {
  const sandwich = SHAPES['flat a quarter, dutch a quarter, flat a half']!

  test('flat at the ceiling before the fall', () => {
    expect(fallenAt(sandwich, 0)).toBe(0)
    expect(fallenAt(sandwich, 0.1)).toBe(0)
    expect(fallenAt(sandwich, 0.25)).toBe(0)
  })

  test('falling across it, and halfway down at its middle', () => {
    expect(fallenAt(sandwich, 0.375)).toBeCloseTo(0.5, 12)
  })

  test('flat at the floor after it', () => {
    expect(fallenAt(sandwich, 0.5)).toBe(1)
    expect(fallenAt(sandwich, 0.75)).toBe(1)
    expect(fallenAt(sandwich, 1)).toBe(1)
  })

  test("today's line falls the whole way, evenly", () => {
    expect(fallenAt(FULL_FALL, 0)).toBe(0)
    expect(fallenAt(FULL_FALL, 0.5)).toBeCloseTo(0.5, 12)
    expect(fallenAt(FULL_FALL, 1)).toBe(1)
  })
})

describe('and the inverse, which is where a filler acts', () => {
  const sandwich = SHAPES['flat a quarter, dutch a quarter, flat a half']!

  test('a price at the ceiling is met the moment the offer opens', () => {
    expect(windowAt(sandwich, 0)).toBe(0)
    expect(windowAt(sandwich, -1)).toBe(0)
  })

  test('a price at the floor is met when the fall ends, not at the close', () => {
    expect(windowAt(sandwich, 1)).toBeCloseTo(0.5, 12)
    expect(windowAt(sandwich, 2)).toBeCloseTo(0.5, 12)
  })

  test('and it undoes `fallenAt` everywhere inside the fall', () => {
    for (const part of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(fallenAt(sandwich, windowAt(sandwich, part))).toBeCloseTo(part, 12)
    }
  })
})

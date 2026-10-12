import { describe, expect, it } from 'vitest'
import {
  decayBreaks,
  decayRateAt,
  decayShape,
  lin,
  minutesText,
  noCurveText,
  padRange,
  pctText,
  poolSource,
  rateText,
  sizeText,
  tickText,
} from './chart'
import { FULL_FALL, STEPS, type Fall } from '../../lib/curve'
import type { Pool } from '../../lib/pool'

describe('scales', () => {
  it('maps a data range onto a pixel range', () => {
    const x = lin(0, 100, 10, 110)
    expect(x(0)).toBe(10)
    expect(x(50)).toBe(60)
    expect(x(100)).toBe(110)
  })

  it('collapses a zero-width domain onto the range start rather than dividing by zero', () => {
    expect(lin(5, 5, 0, 200)(5)).toBe(0)
  })
})

describe('padRange', () => {
  it('leaves room above and below the data', () => {
    const [lo, hi] = padRange([10, 20])
    expect(lo).toBeLessThan(10)
    expect(hi).toBeGreaterThan(20)
  })

  it('opens a flat series so every point does not land on one pixel', () => {
    const [lo, hi] = padRange([0.04, 0.04])
    expect(hi).toBeGreaterThan(lo)
  })

  it('ignores values that are not finite', () => {
    expect(padRange([1, 2, NaN, Infinity])).toEqual(padRange([1, 2]))
  })

  it('never frames a positive series down to zero', () => {
    // A constant-product pool's price is asymptotic to both axes, so zero is not a price it can
    // reach. Padding under a small minimum used to put the floor at or below zero, and the chart
    // drew a gridline and a label there.
    const [lo] = padRange([0.002, 1], 0.12)
    expect(lo).toBeGreaterThan(0)
    expect(lo).toBeLessThan(0.002)
  })

  it('keeps the negative side of a series that straddles zero', () => {
    // Not every axis carries a price. A percentage move can be negative and has to stay so.
    const [lo] = padRange([-4, 6])
    expect(lo).toBeLessThan(-4)
  })
})

describe('number formats', () => {
  it('keeps six significant digits on a rate and four on a tick', () => {
    expect(rateText(0.03888591)).toBe('0.0388859')
    expect(tickText(0.03888591)).toBe('0.03889')
  })

  it('signs a percentage with a real minus', () => {
    expect(pctText(0.3812)).toBe('+0.38%')
    expect(pctText(-1.2)).toBe('−1.20%')
  })

  it('reads sizes at the precision a person can hold', () => {
    expect(sizeText(259.4)).toBe('259.4')
    expect(sizeText(10630.81)).toBe('10,631')
    expect(sizeText(0.004213)).toBe('0.00421')
  })

  /**
   * The case that put 31 pixels of text outside the viewBox: a pool reserve on a real pair, in a
   * 46-pixel gutter. Exact under a hundred thousand, because that is where trade sizes live.
   */
  it('goes compact at a reserve-sized number, and stays exact at a trade-sized one', () => {
    expect(sizeText(9_139_193_647)).toBe('9.14B')
    expect(sizeText(1_250_000)).toBe('1.25M')
    expect(sizeText(100_000)).toBe('100K')
    expect(sizeText(99_999)).toBe('99,999')
    expect(sizeText(-9_139_193_647)).toBe('-9.14B')
  })

  it('reads minutes as a countdown', () => {
    expect(minutesText(36)).toBe('36m')
    expect(minutesText(60)).toBe('1h')
    expect(minutesText(95)).toBe('1h 35m')
    expect(minutesText(0.4)).toBe('under a minute')
  })
})

describe('poolSource', () => {
  it('names the pair, the block and the pool cut, so no figure is unattributed', () => {
    const pool = {
      address: '0x0B196d5F756060e67416Bf45E3e04146a51eE84b',
      token0: '0x0',
      token1: '0x1',
      reserve0: 1n,
      reserve1: 1n,
      feeNum: 9971n,
      feeDen: 10_000n,
      blockNumber: 25_156_707n,
    } as unknown as Pool
    expect(poolSource(pool)).toBe(
      'computed from pair 0x0B19…E84b reserves · block 25,156,707 · pool cut 0.29%',
    )
  })
})

describe('noCurveText', () => {
  it('reports a read that did not come back as exactly that', () => {
    // Three panels have shipped this bug. A rate-limited endpoint is not evidence about a pool.
    const said = noCurveText('unreadable', 'tPLSX', 'tUSDC')
    expect(said).toContain('did not come back')
    expect(said).not.toContain('no liquidity')
    expect(said).not.toContain('No PulseX pool')
  })

  it('blames the chain when the chain has no router', () => {
    expect(noCurveText('no-market', 'tPLSX', 'tUSDC')).toContain('no constant-product router')
  })

  it('names the pair when the pair has no pool', () => {
    expect(noCurveText('no-pool', 'tPLSX', 'tUSDC')).toBe('No PulseX pool trades tPLSX for tUSDC.')
  })

  it('says empty only when the pool answered and is empty', () => {
    expect(noCurveText('pool', 'tPLSX', 'tUSDC')).toContain('holds no liquidity')
  })
})

/**
 * The decay strip against a scheduled start.
 *
 * An offer that opens in six hours is not decaying yet, and a strip that drew it as though it
 * were would show a maker a price nobody will ever be offered. Two clocks meet here: the offer's
 * own start, and the second its funding signature opens — and the later of the two is the first
 * moment a fill can land.
 */
describe('the decay strip’s schedule', () => {
  /** A pool sitting between the two ends of the curve, so the offer crosses it mid-window. */
  const crossing = { startRate: 1.1, endRate: 0.9, poolRate: 1.0 }

  it('runs from now to the end of the offer, not just the length of it', () => {
    const s = decayShape({ ...crossing, duration: 3600, startsIn: 21600, liveIn: 21600, fall: FULL_FALL })
    expect(s.open).toBe(360)
    expect(s.axis).toBe(420)
  })

  it('an offer that opens now behaves exactly as it always did', () => {
    const s = decayShape({ ...crossing, duration: 3600, startsIn: 0, liveIn: 0, fall: FULL_FALL })
    expect(s.open).toBe(0)
    expect(s.axis).toBe(60)
    expect(s.cross).toBeCloseTo(30)
  })

  it('does not decay while it waits, so the crossing slides with the start', () => {
    const now = decayShape({ ...crossing, duration: 3600, startsIn: 0, liveIn: 0, fall: FULL_FALL })
    const later = decayShape({ ...crossing, duration: 3600, startsIn: 21600, liveIn: 21600, fall: FULL_FALL })
    expect(later.cross).toBeCloseTo((now.cross ?? 0) + 360)
  })

  /** Already below the pool, and still not fillable: the offer has not opened. */
  it('cannot fill before it opens, however cheap the price already is', () => {
    const s = decayShape({
      startRate: 0.8,
      endRate: 0.7,
      poolRate: 1.0,
      duration: 3600,
      startsIn: 21600,
      liveIn: 21600,
      fall: FULL_FALL,
    })
    expect(s.fillable).toBe(true)
    expect(s.cross).toBe(360)
  })

  /**
   * The two windows apart. The offer is open and the price is falling, and the token will refuse
   * every redemption until its own window opens — so the fill waits for the authorization.
   */
  it('waits for the funding signature when that opens later than the offer', () => {
    const s = decayShape({
      startRate: 0.8,
      endRate: 0.7,
      poolRate: 1.0,
      duration: 21600,
      startsIn: 0,
      liveIn: 3600,
      fall: FULL_FALL,
    })
    expect(s.open).toBe(0)
    expect(s.live).toBe(60)
    expect(s.cross).toBe(60)
  })

  it('never reaches the pool when the whole curve stays above it', () => {
    const s = decayShape({
      startRate: 2,
      endRate: 1.5,
      poolRate: 1.0,
      duration: 3600,
      startsIn: 3600,
      liveIn: 3600,
      fall: FULL_FALL,
    })
    expect(s.fillable).toBe(false)
    expect(s.cross).toBeNull()
  })

  /** A crossing the offer would reach after it expires is no crossing at all. */
  it('and none when the funding opens after the offer is gone', () => {
    const s = decayShape({ ...crossing, duration: 900, startsIn: 0, liveIn: 3600, fall: FULL_FALL })
    expect(s.fillable).toBe(false)
    expect(s.cross).toBeNull()
  })

  /**
   * The boundary the sign form steps over on purpose. A first fillable second landing exactly on
   * the offer's last one is still a fill, so a dead schedule has to send one second past the end
   * or the strip would answer "fills the moment it opens" beside a drawer saying "never".
   */
  it('counts the offer’s very last second as fillable, and the one after it as not', () => {
    const last = decayShape({ ...crossing, duration: 3600, startsIn: 0, liveIn: 3600, fall: FULL_FALL })
    expect(last.fillable).toBe(true)
    const past = decayShape({ ...crossing, duration: 3600, startsIn: 0, liveIn: 3660, fall: FULL_FALL })
    expect(past.fillable).toBe(false)
  })
})

/**
 * The shape the strip draws, at its breakpoints and inside every region.
 *
 * This is the highest-consequence arithmetic in the app and it is invisible to a test that only
 * checks endpoints: a two-point fall and a four-point one agree at both ends of the window and
 * disagree everywhere a maker actually reads. The maker signs against what they see, so a strip
 * drawing the wrong shape is worse than one drawing none.
 *
 * Every number here is signed. The pool rate is the one live figure, and it only ever decides
 * where the two lines cross — never where the maker's own line goes.
 */
describe('the decay strip draws the shape that was signed', () => {
  const hi = 1.1
  const lo = 0.9
  /** A one-hour offer opening now, so a minute of the plot is a minute of the window. */
  const hour = { startRate: hi, endRate: lo, poolRate: 1.0, duration: 3600, startsIn: 0, liveIn: 0 }

  const SHAPES: Record<string, Fall> = {
    "today's line": FULL_FALL,
    'dutch over the first quarter, then flat': { from: 0, to: STEPS / 4 },
    'flat for half, then dutch to the close': { from: STEPS / 2, to: STEPS },
    'flat a quarter, dutch a quarter, flat a half': { from: STEPS / 4, to: STEPS / 2 },
  }

  it('puts the fall where the handles put it, in minutes', () => {
    expect(decayShape({ ...hour, fall: SHAPES["today's line"]! })).toMatchObject({
      fallFrom: 0,
      fallTo: 60,
    })
    expect(
      decayShape({ ...hour, fall: SHAPES['dutch over the first quarter, then flat']! }),
    ).toMatchObject({ fallFrom: 0, fallTo: 15 })
    expect(
      decayShape({ ...hour, fall: SHAPES['flat for half, then dutch to the close']! }),
    ).toMatchObject({ fallFrom: 30, fallTo: 60 })
    expect(
      decayShape({ ...hour, fall: SHAPES['flat a quarter, dutch a quarter, flat a half']! }),
    ).toMatchObject({ fallFrom: 15, fallTo: 30 })
  })

  /** A scheduled offer's stretch is a fraction of its own window, not of the plot. */
  it('measures the stretch from when the offer opens, not from now', () => {
    const s = decayShape({
      ...hour,
      startsIn: 3600,
      liveIn: 3600,
      fall: SHAPES['flat a quarter, dutch a quarter, flat a half']!,
    })
    expect(s.open).toBe(60)
    expect(s.axis).toBe(120)
    expect(s.fallFrom).toBe(75)
    expect(s.fallTo).toBe(90)
  })

  it('holds the ceiling before the fall, and the floor after it', () => {
    const s = decayShape({ ...hour, fall: SHAPES['flat a quarter, dutch a quarter, flat a half']! })
    for (const at of [0, 5, 14.9, 15]) expect(decayRateAt(s, hi, lo, at)).toBe(hi)
    for (const at of [30, 31, 45, 60]) expect(decayRateAt(s, hi, lo, at)).toBe(lo)
  })

  it('falls evenly across the stretch, and is halfway down at its middle', () => {
    const s = decayShape({ ...hour, fall: SHAPES['flat a quarter, dutch a quarter, flat a half']! })
    expect(decayRateAt(s, hi, lo, 22.5)).toBeCloseTo(1.0, 12)
    expect(decayRateAt(s, hi, lo, 18.75)).toBeCloseTo(1.05, 12)
    expect(decayRateAt(s, hi, lo, 26.25)).toBeCloseTo(0.95, 12)
  })

  /**
   * The line the strip actually renders. Five corners, and the polyline is only right if each one
   * carries the rate the arithmetic says — the picture and the number come from the same call.
   */
  it('draws five corners, in time order, at the rates the arithmetic gives', () => {
    for (const [name, fall] of Object.entries(SHAPES)) {
      const s = decayShape({ ...hour, startsIn: 900, liveIn: 900, fall })
      const breaks = decayBreaks(s)
      expect(breaks, name).toEqual([0, s.open, s.fallFrom, s.fallTo, s.axis])
      for (let i = 1; i < breaks.length; i++) {
        expect(breaks[i]!, name).toBeGreaterThanOrEqual(breaks[i - 1]!)
      }
      expect(decayRateAt(s, hi, lo, breaks[0]!), name).toBe(hi)
      expect(decayRateAt(s, hi, lo, breaks[1]!), name).toBe(hi)
      expect(decayRateAt(s, hi, lo, breaks[2]!), name).toBe(hi)
      expect(decayRateAt(s, hi, lo, breaks[3]!), name).toBe(lo)
      expect(decayRateAt(s, hi, lo, breaks[4]!), name).toBe(lo)
    }
  })

  it('never leaves the two ends the maker signed', () => {
    for (const [name, fall] of Object.entries(SHAPES)) {
      const s = decayShape({ ...hour, fall })
      for (let at = 0; at <= 60; at += 0.5) {
        const v = decayRateAt(s, hi, lo, at)
        expect(v, `${name} at ${at}`).toBeLessThanOrEqual(hi)
        expect(v, `${name} at ${at}`).toBeGreaterThanOrEqual(lo)
      }
    }
  })
})

/**
 * Where the falling price meets the pool, once the fall is not the whole window.
 *
 * This is the sentence under the strip — "crosses the pool in ≈14m" — and it is the figure a
 * maker uses to decide whether their offer works. A crossing computed against the window rather
 * than against the stretch names a minute nothing happens in.
 */
describe('the crossing follows the shape', () => {
  const hour = { startRate: 1.1, endRate: 0.9, poolRate: 1.0, duration: 3600, startsIn: 0, liveIn: 0 }

  it("crosses halfway down the window on today's line", () => {
    expect(decayShape({ ...hour, fall: FULL_FALL }).cross).toBeCloseTo(30)
  })

  it('crosses halfway down the stretch, not halfway down the window', () => {
    // Falling over the first quarter: the pool sits halfway between the ends, so the price
    // reaches it an eighth of the way in — and then rests under it for the other seven eighths.
    expect(decayShape({ ...hour, fall: { from: 0, to: STEPS / 4 } }).cross).toBeCloseTo(7.5)
    // Flat for half, then falling: nothing happens until minute 30, then the same eighth again.
    expect(decayShape({ ...hour, fall: { from: STEPS / 2, to: STEPS } }).cross).toBeCloseTo(45)
    // The sandwich: flat to minute 15, falling to minute 30, so the middle is minute 22.5.
    expect(decayShape({ ...hour, fall: { from: STEPS / 4, to: STEPS / 2 } }).cross).toBeCloseTo(22.5)
  })

  it('still fills the moment it opens when the ceiling is already under the pool', () => {
    const s = decayShape({
      ...hour,
      startRate: 0.8,
      endRate: 0.7,
      startsIn: 3600,
      liveIn: 3600,
      fall: { from: STEPS / 2, to: STEPS },
    })
    // The flat run-in is fillable too. Waiting for the fall to begin would name a minute the
    // offer was already cheap enough in.
    expect(s.cross).toBe(60)
  })

  it('and never reaches a pool the whole curve stays above, whatever the shape', () => {
    const s = decayShape({
      startRate: 2,
      endRate: 1.5,
      poolRate: 1.0,
      duration: 3600,
      startsIn: 0,
      liveIn: 0,
      fall: { from: STEPS / 4, to: STEPS / 2 },
    })
    expect(s.fillable).toBe(false)
    expect(s.cross).toBeNull()
  })
})

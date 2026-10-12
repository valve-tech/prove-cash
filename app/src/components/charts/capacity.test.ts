import { describe, expect, it } from 'vitest'
import { depthAt, poolAskDepth, poolBidDepth, type Level } from './book'
import { areaPath, capacityDomain, linePath } from './Capacity'

/**
 * The composite depth valley.
 *
 * Capacity draws bids left of mid and asks right of it, each climbing away from the spread, with
 * the pool nested inside the total so the board's contribution is the gap. That shape is the
 * whole reading — overlapping arms used to cross and erase it — so the domain, the clip, and the
 * fee-band floor are pinned here without rendering.
 */

const X = 1_000_000
const Y = 40_000
const G = 0.9971
const SPOT = Y / X // 0.04
const RES = { x: X, y: Y }

const LEVELS: Level[] = [
  { rate: 0.042, size: 100, side: 'bid', count: 1 },
  { rate: 0.041, size: 50, side: 'bid', count: 1 },
  { rate: 0.039, size: 70, side: 'ask', count: 1 },
  { rate: 0.038, size: 30, side: 'ask', count: 1 },
]

describe('the composite depth valley', () => {
  it('puts mid on the pool spot when there is a pool', () => {
    const d = capacityDomain(LEVELS, RES)
    expect(d).not.toBeNull()
    expect(d!.mid).toBeCloseTo(SPOT, 12)
    expect(d!.lo).toBeLessThan(d!.mid)
    expect(d!.hi).toBeGreaterThan(d!.mid)
  })

  it('clips the bid arm to the left of mid and the ask arm to the right', () => {
    // Sampling across the whole range made the arms cross. Each side of the valley is its own
    // half of the axis, and a point on the wrong side of mid does not belong on that arm.
    const d = capacityDomain(LEVELS, RES)!
    const bids = Array.from({ length: 40 }, (_, i) => d.lo + ((d.mid - d.lo) * i) / 39)
    const asks = Array.from({ length: 40 }, (_, i) => d.mid + ((d.hi - d.mid) * i) / 39)
    expect(Math.max(...bids)).toBeLessThanOrEqual(d.mid + 1e-12)
    expect(Math.min(...asks)).toBeGreaterThanOrEqual(d.mid - 1e-12)
  })

  it('the pool sits on the floor of the fee band at mid, so the valley is real', () => {
    // Inside γ·spot … spot/γ the curve has no capacity. Mid is spot, so both pool arms open at
    // zero and only the board can lift the composite line through the spread.
    expect(poolBidDepth(X, Y, G, SPOT)).toBe(0)
    expect(poolAskDepth(X, Y, G, SPOT)).toBe(0)
    const atMid = depthAt(SPOT, 'bid', LEVELS, RES, G)
    expect(atMid.pool).toBe(0)
    // Board bids that still stand at spot lift the composite off the floor — that lift is the
    // gap the fill is there to show.
    expect(atMid.board).toBeGreaterThan(0)
    expect(atMid.total).toBe(atMid.board)
  })

  it('each arm climbs as it walks away from mid', () => {
    const d = capacityDomain(LEVELS, RES)!
    const nearBid = depthAt((d.lo + d.mid) / 2, 'bid', LEVELS, RES, G).total
    const farBid = depthAt(d.lo, 'bid', LEVELS, RES, G).total
    expect(farBid).toBeGreaterThanOrEqual(nearBid)

    const nearAsk = depthAt((d.mid + d.hi) / 2, 'ask', LEVELS, RES, G).total
    const farAsk = depthAt(d.hi, 'ask', LEVELS, RES, G).total
    expect(farAsk).toBeGreaterThanOrEqual(nearAsk)
  })

  it('falls back to the board mid when there is no pool', () => {
    const d = capacityDomain(LEVELS, null)
    expect(d).not.toBeNull()
    // Best bid 0.042, best ask 0.038 — crossed on purpose; mid is their mean.
    expect(d!.mid).toBeCloseTo((0.042 + 0.038) / 2, 12)
  })
})

describe('synthetic stress on the valley domain', () => {
  it.each([
    ['one bid only', [{ rate: 0.04, size: 10, side: 'bid' as const, count: 1 }], null],
    ['one ask only', [{ rate: 0.04, size: 10, side: 'ask' as const, count: 1 }], null],
    ['pool only', [], RES],
    ['skewed pool', LEVELS, { x: 1e12, y: 1 }],
    ['dust pool', LEVELS, { x: 1e-6, y: 1e-6 }],
  ] as const)('%s still opens a finite window around mid', (_name, levels, reserves) => {
    const d = capacityDomain(levels, reserves)
    expect(d).not.toBeNull()
    expect(isFinite(d!.lo)).toBe(true)
    expect(isFinite(d!.hi)).toBe(true)
    expect(isFinite(d!.mid)).toBe(true)
    expect(d!.hi).toBeGreaterThan(d!.lo)
    expect(d!.mid).toBeGreaterThanOrEqual(d!.lo)
    expect(d!.mid).toBeLessThanOrEqual(d!.hi)
  })

  it('an empty book with no pool has nothing to draw', () => {
    expect(capacityDomain([], null)).toBeNull()
  })

  it('keeps mid on the axis even when spot is far from every resting offer', () => {
    // Spot ~1e-12, board around 0.04. Before the fix mid sat below lo and both arms clipped
    // against a line that was not on the plot — the valley left the screen.
    const d = capacityDomain(LEVELS, { x: 1e12, y: 1 })!
    expect(d.mid).toBeGreaterThanOrEqual(d.lo)
    expect(d.mid).toBeLessThanOrEqual(d.hi)
    expect(d.mid).toBeCloseTo(1e-12, 20)
  })
})

/** Every x and y an SVG path names, parsed the way a browser tokenises numbers. */
const coords = (d: string) => {
  const nums = d.match(/-?(?:\d+\.?\d*|\.\d+)/g)!.map(Number)
  return nums.filter((_, i) => i % 2 === 0)
}

describe('the fill paths', () => {
  const pts = [
    [54, 8],
    [55.1, 8.8],
    [120, 170],
  ] as const

  it('keeps every vertex of a fill inside the plot', () => {
    // The live chart drew "M54.0,170.054.0,8.0…": the first point parsed as x = 0.
    const xs = coords(areaPath(pts, 170))
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(54)
    expect(Math.max(...xs)).toBeLessThanOrEqual(120)
  })

  it('names every command letter it needs', () => {
    expect(areaPath(pts, 170)).toBe('M54.0,170.0L54.0,8.0L55.1,8.8L120.0,170.0L120.0,170.0Z')
    expect(linePath(pts)).toBe('M54.0,8.0L55.1,8.8L120.0,170.0')
  })

  it('draws nothing from no points', () => {
    expect(areaPath([], 170)).toBe('')
  })
})

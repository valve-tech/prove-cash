import { describe, expect, test } from 'vitest'
import { boardDepth, depthAt, poolAskDepth, poolBidDepth, reservesOf, type Level } from './book'

/**
 * The capacity arithmetic, checked against the swap it claims to describe.
 *
 * Restating the algebra in the test would only prove I can copy it twice. Instead each capacity
 * is fed back through the constant-product formula: sell exactly that much and the average price
 * must come out at the price asked for. That catches an inverted fee or a dropped gamma, which
 * reading the expression does not.
 */

const X = 1_000_000 // base reserve
const Y = 40_000 // quote reserve
const G = 0.9971
const SPOT = Y / X // 0.04

/** What the pool actually pays for `d` base, by the curve. */
const sellOut = (d: number) => (G * d * Y) / (X + G * d)
/** What the pool actually charges for `d` base out. */
const buyCost = (d: number) => (d * Y) / ((X - d) * G)

describe('pool capacity round-trips through the curve', () => {
  test.each([0.039, 0.035, 0.02, 0.001])('a bid at %s is exactly fillable', (p) => {
    const d = poolBidDepth(X, Y, G, p)
    expect(d).toBeGreaterThan(0)
    expect(sellOut(d) / d).toBeCloseTo(p, 9)
  })

  test.each([0.0402, 0.045, 0.08, 0.5])('an ask at %s is exactly fillable', (p) => {
    const d = poolAskDepth(X, Y, G, p)
    expect(d).toBeGreaterThan(0)
    expect(buyCost(d) / d).toBeCloseTo(p, 9)
  })

  test('the fee band is where the pool has nothing to offer', () => {
    // Above gamma*spot the fee alone beats any size the pool could quote.
    expect(poolBidDepth(X, Y, G, G * SPOT + 1e-9)).toBe(0)
    expect(poolBidDepth(X, Y, G, G * SPOT - 1e-6)).toBeGreaterThan(0)
    // Below spot/gamma the same, the other way round.
    expect(poolAskDepth(X, Y, G, SPOT / G - 1e-9)).toBe(0)
    expect(poolAskDepth(X, Y, G, SPOT / G + 1e-6)).toBeGreaterThan(0)
  })

  test('depth grows the further the price is from spot', () => {
    expect(poolBidDepth(X, Y, G, 0.02)).toBeGreaterThan(poolBidDepth(X, Y, G, 0.039))
    expect(poolAskDepth(X, Y, G, 0.08)).toBeGreaterThan(poolAskDepth(X, Y, G, 0.0402))
  })

  test('a zero or negative price asks nothing of the curve', () => {
    expect(poolBidDepth(X, Y, G, 0)).toBe(0)
    expect(poolAskDepth(X, Y, G, -1)).toBe(0)
  })
})

const LEVELS: Level[] = [
  { rate: 0.042, size: 100, side: 'bid', count: 1 },
  { rate: 0.041, size: 50, side: 'bid', count: 1 },
  { rate: 0.039, size: 70, side: 'ask', count: 1 },
  { rate: 0.038, size: 30, side: 'ask', count: 1 },
]

describe('board depth', () => {
  test('a bid stands while the price is at or under what it pays', () => {
    expect(boardDepth(LEVELS, 'bid', 0.043)).toBe(0)
    expect(boardDepth(LEVELS, 'bid', 0.042)).toBe(100)
    expect(boardDepth(LEVELS, 'bid', 0.0405)).toBe(150)
  })

  test('an ask stands while the price is at or over what it demands', () => {
    expect(boardDepth(LEVELS, 'ask', 0.037)).toBe(0)
    expect(boardDepth(LEVELS, 'ask', 0.038)).toBe(30)
    expect(boardDepth(LEVELS, 'ask', 0.04)).toBe(100)
  })
})

describe('the combined book', () => {
  test('adds the curve to the signatures and keeps the split', () => {
    const p = 0.0405
    const d = depthAt(p, 'bid', LEVELS, { x: X, y: Y }, G)
    expect(d.board).toBe(150)
    expect(d.pool).toBeCloseTo(poolBidDepth(X, Y, G, p), 12)
    expect(d.total).toBeCloseTo(d.pool + d.board, 12)
  })

  test('inside the fee band the board is the only liquidity there is', () => {
    // 0.0401 sits between spot/gamma and gamma*spot, where the curve offers nothing — but two
    // bids rest above it. Superimposed layers show a gap here; the combined book shows 150.
    const p = 0.0401
    expect(p).toBeGreaterThan(G * SPOT)
    expect(p).toBeLessThan(SPOT / G)
    const d = depthAt(p, 'bid', LEVELS, { x: X, y: Y }, G)
    expect(d.pool).toBe(0)
    expect(d.total).toBe(150)
  })

  test('with no pool the board is the whole market', () => {
    const d = depthAt(0.0405, 'bid', LEVELS, null, G)
    expect(d.pool).toBe(0)
    expect(d.total).toBe(150)
  })
})

describe('reservesOf keys on the pool, not on the picker', () => {
  const WPLS = '0x00000000000000000000000000000000000000aa'
  const PLSX = '0x00000000000000000000000000000000000000bb'
  const pool = {
    address: '0x0000000000000000000000000000000000000001',
    token0: WPLS,
    token1: PLSX,
    reserve0: 2_000_000_000_000_000_000_000n, // 2000
    reserve1: 1_000_000_000_000_000_000_000n, // 1000
    feeNum: 9971n,
    feeDen: 10_000n,
    venue: 'v2',
  } as unknown as Parameters<typeof reservesOf>[0]

  test('reads the pair either way round', () => {
    expect(reservesOf(pool, WPLS, 18, PLSX, 18)).toEqual({ x: 2000, y: 1000 })
    expect(reservesOf(pool, PLSX, 18, WPLS, 18)).toEqual({ x: 1000, y: 2000 })
  })

  test('a wrapper token finds its pool through the market address', () => {
    // The regression: a token whose own address differs from the one it trades under. Passing
    // the picker's address found nothing and the chart drew an empty book over a full pool.
    const wrapperOwnAddress = '0x00000000000000000000000000000000000000cc'
    expect(reservesOf(pool, wrapperOwnAddress, 18, PLSX, 18)).toBeNull()
    expect(reservesOf(pool, WPLS, 18, PLSX, 18)).not.toBeNull()
  })

  test('decimals come from the token, not the pool', () => {
    expect(reservesOf(pool, WPLS, 18, PLSX, 21)).toEqual({ x: 2000, y: 1 })
  })
})

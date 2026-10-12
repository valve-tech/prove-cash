import { describe, expect, test } from 'vitest'
import { clear, type Reserves } from './clearing'
import type { Level } from './book'

/**
 * Clearing decides where the reserves plane draws its destination, so an error here is a claim
 * about how far this board can move this pool. The invariant does most of the checking: a
 * constant-product trade must leave `k` no smaller than it was, because the fee stays behind.
 */

const R: Reserves = { x: 1_000_000, y: 40_000 } // spot 0.04
const G = 0.9971

const ask = (rate: number, size: number): Level => ({ rate, size, side: 'ask', count: 1 })
const bid = (rate: number, size: number): Level => ({ rate, size, side: 'bid', count: 1 })

describe('crossed offers match each other', () => {
  test('a bid over an ask settles between them and moves no reserves', () => {
    const c = clear([ask(0.039, 100), bid(0.041, 100)], R, G)!
    expect(c.matched).toBeCloseTo(100, 9)
    expect(c.netBase).toBe(0)
    expect(c.after).toEqual(R)
    expect(c.taken).toBe(2)
  })

  test('only the overlapping size matches; the rest meets the curve', () => {
    const c = clear([ask(0.039, 100), bid(0.041, 30)], R, G)!
    expect(c.matched).toBeCloseTo(30, 9)
    // 70 base of ask is left, and the pool pays about 0.0399 for it, so it sells in.
    expect(c.netBase).toBeCloseTo(70, 6)
    expect(c.after.x).toBeGreaterThan(R.x)
  })

  test('an uncrossed book matches nothing', () => {
    const c = clear([ask(0.041, 50), bid(0.039, 50)], R, G)!
    expect(c.matched).toBe(0)
  })
})

describe('the remainder walks the curve', () => {
  test('an ask the pool beats sells into it and pushes the price down', () => {
    const c = clear([ask(0.03, 500)], R, G)!
    expect(c.netBase).toBeCloseTo(500, 9)
    expect(c.after.x).toBeGreaterThan(R.x)
    expect(c.after.y).toBeLessThan(R.y)
    expect(c.after.y / c.after.x).toBeLessThan(R.y / R.x)
  })

  test('a bid over what the pool charges buys base out and pushes the price up', () => {
    const c = clear([bid(0.05, 500)], R, G)!
    expect(c.netBase).toBeCloseTo(-500, 9)
    expect(c.after.x).toBeLessThan(R.x)
    expect(c.after.y / c.after.x).toBeGreaterThan(R.y / R.x)
  })

  test('an offer the pool cannot beat is left alone', () => {
    // Asking 0.045 when the pool pays about 0.0399 for it: nobody takes this.
    const c = clear([ask(0.045, 100)], R, G)!
    expect(c.netBase).toBe(0)
    expect(c.taken).toBe(0)
    expect(c.after).toEqual(R)
  })

  test('the walk stops when the price it moved makes the next offer unprofitable', () => {
    // A big first ask drags the pool's bid down; a second, dearer ask then fails.
    const one = clear([ask(0.0398, 5_000)], R, G)!
    const two = clear([ask(0.0398, 5_000), ask(0.03975, 5_000)], R, G)!
    // The second is not simply added on: the first already moved the price against it.
    expect(two.netBase).toBeLessThan(one.netBase + 5_000)
  })

  test('every fill leaves k no smaller — the fee stays in the pool', () => {
    const before = R.x * R.y
    for (const book of [[ask(0.03, 800)], [bid(0.05, 800)], [ask(0.03, 400), bid(0.05, 100)]]) {
      const c = clear(book, R, G)!
      expect(c.after.x * c.after.y).toBeGreaterThanOrEqual(before - 1e-6)
    }
  })
})

describe('edges', () => {
  test('no pool means no clearing to compute', () => {
    expect(clear([ask(0.03, 10)], null, G)).toBeNull()
    expect(clear([ask(0.03, 10)], { x: 0, y: 10 }, G)).toBeNull()
  })

  test('an empty board leaves the pool exactly where it was', () => {
    const c = clear([], R, G)!
    expect(c.after).toEqual(R)
    expect(c.netBase).toBe(0)
    expect(c.taken).toBe(0)
  })

  test('an offer larger than the reserve cannot be bought out', () => {
    // Buying the whole base reserve is impossible on a constant-product curve, so it must not be
    // priced as if it were merely expensive.
    const c = clear([bid(1e9, R.x * 2)], R, G)!
    expect(c.netBase).toBe(0)
    expect(c.after).toEqual(R)
  })
})

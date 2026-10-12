import { describe, expect, test } from 'vitest'
import { parseUnits, type Address } from 'viem'
import { CURVE_LINEAR, ZERO_HASH, type Intent, type TokenInfo } from '@prove.cash/sdk'
import { levelsOf, poolAskDepth, poolBidDepth, type Level } from './book'
import { rungsOf } from './Ladder'

/**
 * The board half of the book's arithmetic. Two offers pointing opposite ways across one pair have to land on the
 * same price axis, and that conversion is the only place this component can be wrong in a way a
 * reader would trust.
 */

const A = '0x000000000000000000000000000000000000000a' as Address
const B = '0x000000000000000000000000000000000000000b' as Address

const base: TokenInfo = { address: A, symbol: 'A', decimals: 18 }
const quote: TokenInfo = { address: B, symbol: 'B', decimals: 6 }

const NOW = 1_800_000_000n

function intent(tokenIn: Address, amountIn: bigint, minOut: bigint): Intent {
  return {
    maker: A,
    recipient: A,
    tokenIn,
    tokenOut: tokenIn === A ? B : A,
    amountIn,
    minOutStart: minOut,
    minOutEnd: minOut,
    curve: CURVE_LINEAR,
    startTime: NOW - 10n,
    endTime: NOW + 1000n,
    executor: '0x0000000000000000000000000000000000000000' as Address,
    feeConfig: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    feeRate: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: 0,
    nonce: 1n,
  }
}

describe('levelsOf', () => {
  test('an offer selling the base is an ask, priced in quote per base', () => {
    // 100 A for at least 250 B → 2.5 B per A.
    const l = levelsOf([intent(A, parseUnits('100', 18), parseUnits('250', 6))], base, quote, NOW)
    expect(l).toHaveLength(1)
    expect(l[0]!.side).toBe('ask')
    expect(l[0]!.rate).toBeCloseTo(2.5, 12)
    expect(l[0]!.size).toBeCloseTo(100, 12)
  })

  test('an offer selling the quote is a bid, priced on the same axis', () => {
    // 240 B for at least 100 A → 2.4 B per A, and the depth is the 100 A they receive.
    const l = levelsOf([intent(B, parseUnits('240', 6), parseUnits('100', 18))], base, quote, NOW)
    expect(l).toHaveLength(1)
    expect(l[0]!.side).toBe('bid')
    expect(l[0]!.rate).toBeCloseTo(2.4, 12)
    expect(l[0]!.size).toBeCloseTo(100, 12)
  })

  test('both sides sort onto one axis with the spread in the middle', () => {
    const l = levelsOf(
      [
        intent(A, parseUnits('1', 18), parseUnits('2.5', 6)), // ask 2.5
        intent(B, parseUnits('2.4', 6), parseUnits('1', 18)), // bid 2.4
        intent(A, parseUnits('1', 18), parseUnits('2.6', 6)), // ask 2.6
      ],
      base,
      quote,
      NOW,
    )
    expect(l.map((x) => [x.side, Number(x.rate.toFixed(4))])).toEqual([
      ['ask', 2.6],
      ['ask', 2.5],
      ['bid', 2.4],
    ])
  })

  test('offers at one rate on one side merge, and keep their count', () => {
    const l = levelsOf(
      [
        intent(A, parseUnits('10', 18), parseUnits('25', 6)),
        intent(A, parseUnits('30', 18), parseUnits('75', 6)),
      ],
      base,
      quote,
      NOW,
    )
    expect(l).toHaveLength(1)
    expect(l[0]!.size).toBeCloseTo(40, 12)
    expect(l[0]!.count).toBe(2)
  })

  test('a bid and an ask at the same rate stay apart', () => {
    const l = levelsOf(
      [
        intent(A, parseUnits('1', 18), parseUnits('2', 6)),
        intent(B, parseUnits('2', 6), parseUnits('1', 18)),
      ],
      base,
      quote,
      NOW,
    )
    expect(l).toHaveLength(2)
    expect(new Set(l.map((x) => x.side))).toEqual(new Set(['bid', 'ask']))
  })

  test('an offer on another pair is not in this book', () => {
    const C = '0x000000000000000000000000000000000000000c' as Address
    expect(levelsOf([intent(C, 1n, 1n)], base, quote, NOW)).toEqual([])
  })

  test('a decaying offer is priced at the clock, not at its start', () => {
    const i: Intent = {
      ...intent(A, parseUnits('1', 18), 0n),
      minOutStart: parseUnits('3', 6),
      minOutEnd: parseUnits('1', 6),
      curve: CURVE_LINEAR,
      startTime: NOW - 50n,
      endTime: NOW + 50n,
    }
    // Halfway through the window the floor is halfway down: 2 B per A, not 3.
    expect(levelsOf([i], base, quote, NOW)[0]!.rate).toBeCloseTo(2, 6)
  })
})

describe('rungsOf', () => {
  // A pool at spot 0.04 with a fee, so each side has a band it cannot quote inside.
  const RES = { x: 1_000_000, y: 40_000 }
  const G = 0.9971

  test('each rung gets only the curve depth its own band adds', () => {
    const levels: Level[] = [
      { rate: 0.039, size: 10, side: 'bid', count: 1 },
      { rate: 0.038, size: 10, side: 'bid', count: 1 },
    ]
    const [near, far] = rungsOf(levels, RES, G)
    // The two slices must sum to the cumulative depth at the further price, or the same
    // liquidity is being counted on more than one rung.
    expect(near!.pool + far!.pool).toBeCloseTo(poolBidDepth(RES.x, RES.y, G, 0.038), 9)
    expect(near!.pool).toBeCloseTo(poolBidDepth(RES.x, RES.y, G, 0.039), 9)
  })

  test('a price the curve cannot reach adds nothing', () => {
    // Inside the fee band the pool has no bid at all, so the rung is board depth alone.
    const levels: Level[] = [{ rate: 0.04, size: 25, side: 'bid', count: 1 }]
    expect(rungsOf(levels, RES, G)[0]!.pool).toBe(0)
  })

  test('with no pool every rung is the board alone', () => {
    const levels: Level[] = [{ rate: 0.038, size: 10, side: 'bid', count: 1 }]
    expect(rungsOf(levels, null, G)[0]!.pool).toBe(0)
  })

  test('the two sides slice independently', () => {
    const levels: Level[] = [
      { rate: 0.045, size: 5, side: 'ask', count: 1 },
      { rate: 0.035, size: 5, side: 'bid', count: 1 },
    ]
    const r = rungsOf(levels, RES, G)
    const ask = r.find((x) => x.side === 'ask')!
    const bid = r.find((x) => x.side === 'bid')!
    expect(ask.pool).toBeCloseTo(poolAskDepth(RES.x, RES.y, G, 0.045), 9)
    expect(bid.pool).toBeCloseTo(poolBidDepth(RES.x, RES.y, G, 0.035), 9)
  })
})

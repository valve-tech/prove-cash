import { describe, expect, test } from 'vitest'
import { parseUnits, type Address } from 'viem'
import { CURVE_LINEAR, ZERO_HASH, type Intent, type TokenInfo } from '@prove.cash/sdk'
import { segmentsOf } from './Tape'

/**
 * The tape's claim is that a sloping segment means a decaying floor. A segment drawn flat when
 * the offer actually decays would mislead without ever looking wrong, so the endpoints are pinned.
 */

const A = '0x000000000000000000000000000000000000000a' as Address
const B = '0x000000000000000000000000000000000000000b' as Address
const base: TokenInfo = { address: A, symbol: 'A', decimals: 18 }
const quote: TokenInfo = { address: B, symbol: 'B', decimals: 6 }
const NOW = 1_800_000_000n

const intent = (over: Partial<Intent> = {}): Intent => ({
  maker: A,
  recipient: A,
  tokenIn: A,
  tokenOut: B,
  amountIn: parseUnits('100', 18),
  minOutStart: parseUnits('250', 6),
  minOutEnd: parseUnits('250', 6),
  curve: CURVE_LINEAR,
  startTime: NOW - 100n,
  endTime: NOW + 100n,
  executor: '0x0000000000000000000000000000000000000000' as Address,
  feeConfig: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  feeRate: 0n,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: 0,
  nonce: 1n,
  ...over,
})

describe('segmentsOf', () => {
  test('a fixed offer is a level segment', () => {
    const [s] = segmentsOf([intent()], base, quote, NOW)
    expect(s!.rateNow).toBeCloseTo(2.5, 12)
    expect(s!.rateEnd).toBeCloseTo(2.5, 12)
    expect(s!.life).toBe(100)
  })

  test('a decaying offer slopes to where it will end', () => {
    const [s] = segmentsOf(
      [intent({ minOutStart: parseUnits('300', 6), minOutEnd: parseUnits('200', 6) })],
      base,
      quote,
      NOW,
    )
    // Halfway through the window now, so the head is 2.5 and the tail is the floor: 2.0.
    expect(s!.rateNow).toBeCloseTo(2.5, 6)
    expect(s!.rateEnd).toBeCloseTo(2.0, 6)
  })

  test('an expired offer is not on the tape', () => {
    expect(segmentsOf([intent({ endTime: NOW })], base, quote, NOW)).toEqual([])
    expect(segmentsOf([intent({ endTime: NOW - 1n })], base, quote, NOW)).toEqual([])
  })

  test('an offer selling the quote is a bid and prices on the same axis', () => {
    const [s] = segmentsOf(
      [
        intent({
          tokenIn: B,
          tokenOut: A,
          amountIn: parseUnits('240', 6),
          minOutStart: parseUnits('100', 18),
          minOutEnd: parseUnits('100', 18),
          curve: CURVE_LINEAR,
        }),
      ],
      base,
      quote,
      NOW,
    )
    expect(s!.side).toBe('bid')
    expect(s!.rateNow).toBeCloseTo(2.4, 12)
  })

  test('another pair is not on this tape', () => {
    const C = '0x000000000000000000000000000000000000000c' as Address
    expect(segmentsOf([intent({ tokenIn: C, tokenOut: A })], base, quote, NOW)).toEqual([])
  })
})

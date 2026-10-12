import { describe, expect, it } from 'vitest'
import { decodeFunctionData, encodeErrorResult, type Hex } from 'viem'
import { SETTLEMENT_ABI } from './abi.js'
import { decodeDryRun, encodeDryRun } from './dryrun.js'
import { CURVE_LINEAR, ZERO, type SignedIntent, ZERO_HASH } from './intent.js'
import { FILL_REASONS } from './settlement.js'

/**
 * The codec for `dryRun`, against the compiled ABI.
 *
 * Both halves are pure, so this is the whole of what can go wrong: the wrong argument order on
 * the way out, and the wrong ordinal-to-name mapping on the way back. The reasons are a wire
 * format — the contract's enum, by position — so a list that slipped by one would rename every
 * refusal at once and nothing else would notice.
 */

const maker = '0x1111111111111111111111111111111111111111' as const
const token = '0x2222222222222222222222222222222222222222' as const

function intent(nonce: bigint): SignedIntent {
  return {
    maker,
    recipient: maker,
    tokenIn: token,
    tokenOut: '0x3333333333333333333333333333333333333333',
    amountIn: 100n,
    minOutStart: 100n,
    minOutEnd: 100n,
    minFill: 0n,
    authNonce: `0x${'00'.repeat(32)}` as const,
    startTime: 1n,
    endTime: 2n,
    executor: ZERO,
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    flags: 0,
    nonce,
    curve: CURVE_LINEAR,
    signature: `0x${'ab'.repeat(65)}` as Hex,
  }
}

describe('encodeDryRun', () => {
  it('encodes the legs in the order they were given', () => {
    const fills = [
      { intent: intent(1n), take: 40n },
      { intent: intent(2n), take: 60n, arming: '0xbeef' as Hex },
    ]

    const call = decodeFunctionData({ abi: SETTLEMENT_ABI, data: encodeDryRun(fills, 123n) })

    // Thrown rather than expected, because it is what narrows `args` for everything below.
    if (call.functionName !== 'dryRun') throw new Error(`encoded ${call.functionName}`)
    const [reqs, maxFeeRate] = call.args

    expect(maxFeeRate).toBe(123n)
    expect(reqs.map((r) => r.intent.nonce)).toEqual([1n, 2n])
    expect(reqs.map((r) => r.take)).toEqual([40n, 60n])
    // A leg nobody asked to arm sends no bytes, which is what the contract reads as "not asked".
    expect(reqs.map((r) => r.arming)).toEqual(['0x', '0xbeef'])
  })
})

describe('decodeDryRun', () => {
  it('reads one reason per leg, by the contract ordinals', () => {
    const data = encodeErrorResult({
      abi: SETTLEMENT_ABI,
      errorName: 'DryRun',
      // Ok, EscrowShort, FeeTooHigh — first, middle and last of the enum.
      args: [[0, 10, 12]],
    })

    expect(decodeDryRun(data)).toEqual(['Ok', 'EscrowShort', 'FeeTooHigh'])
  })

  it('names every ordinal the contract can send', () => {
    const data = encodeErrorResult({
      abi: SETTLEMENT_ABI,
      errorName: 'DryRun',
      args: [FILL_REASONS.map((_, k) => k)],
    })

    expect(decodeDryRun(data)).toEqual([...FILL_REASONS])
  })

  it('refuses any other revert rather than reporting a reason it did not get', () => {
    const data = encodeErrorResult({ abi: SETTLEMENT_ABI, errorName: 'Underpaid' })
    expect(() => decodeDryRun(data)).toThrow(/Underpaid/)
  })
})

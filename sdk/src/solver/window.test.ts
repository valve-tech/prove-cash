import { ZERO_HASH } from '../intent.js'
import { describe, expect, test } from 'vitest'
import { armableAt, armingWindow } from './arming.js'
import { buildBook } from './book.js'
import { findRings } from './rings.js'
import type { SignedIntent } from '../intent.js'

/**
 * A leg's real life is the intersection of two windows: the offer's, and that of the signature
 * funding it. Nothing on chain reconciles them, and every mismatch reaches a solver as
 * `EscrowShort` — the same answer a spent nonce and an empty wallet give. These tests pin the
 * boundaries, because the off-by-ones belong to three different specifications rather than to us.
 */

const T = 1_000_000n
const base = {
  maker: '0x1111111111111111111111111111111111111111',
  recipient: '0x1111111111111111111111111111111111111111',
  tokenIn: '0x2222222222222222222222222222222222222222',
  tokenOut: '0x3333333333333333333333333333333333333333',
  amountIn: 1000n,
  minOutStart: 900n,
  minOutEnd: 900n,
  startTime: T,
  endTime: T + 3600n,
  executor: '0x0000000000000000000000000000000000000000',
  feeConfig: ZERO_HASH,
  feeRate: 0n,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  minFill: 0n,
  authNonce: `0x${'00'.repeat(32)}`,
  flags: 1,
  nonce: 7n,
  signature: `0x${'11'.repeat(65)}`,
} as unknown as SignedIntent

describe('armingWindow', () => {
  test('a leg with no signature lives exactly as long as its offer', () => {
    // `until` is inclusive and `endTime` is not: the chain answers `Expired` at `endTime`.
    expect(armingWindow(base)).toEqual({ from: T, until: T + 3599n })
  })

  test('the offer’s own end is exclusive, as `_fillability` reads it', () => {
    // `ProveSettlement` returns `Expired` when `block.timestamp >= endTime`. The last second a
    // leg can fill is one before it, and a ring built at `endTime` itself cannot settle.
    expect(armableAt(base, T + 3599n)).toBe(true)
    expect(armableAt(base, T + 3600n)).toBe(false)
    // The start is inclusive: `NotStarted` only while `block.timestamp < startTime`.
    expect(armableAt(base, T)).toBe(true)
    expect(armableAt(base, T - 1n)).toBe(false)
  })

  test('EIP-3009 is exclusive at both ends, so the usable seconds sit inside its bounds', () => {
    const i = {
      ...base,
      flags: 3,
      auth: { validAfter: T + 100n, validBefore: T + 200n, signature: '0x22' },
    } as unknown as SignedIntent
    // The token demands validAfter < now < validBefore.
    expect(armingWindow(i)).toEqual({ from: T + 101n, until: T + 199n })
    expect(armableAt(i, T + 100n)).toBe(false)
    expect(armableAt(i, T + 101n)).toBe(true)
    expect(armableAt(i, T + 199n)).toBe(true)
    expect(armableAt(i, T + 200n)).toBe(false)
  })

  test('a permit deadline is inclusive, and shortens the offer when it lands first', () => {
    const i = {
      ...base,
      permit: { value: 1000n, deadline: T + 60n, signature: `0x${'33'.repeat(65)}` },
    } as unknown as SignedIntent
    expect(armingWindow(i)).toEqual({ from: T, until: T + 60n })
    expect(armableAt(i, T + 60n)).toBe(true)
    expect(armableAt(i, T + 61n)).toBe(false)
  })

  test('a Permit2 deadline does the same', () => {
    const i = {
      ...base,
      flags: 5,
      permit2: {
        token: base.tokenIn,
        amount: 1000n,
        deadline: T + 30n,
        signature: `0x${'44'.repeat(65)}`,
      },
    } as unknown as SignedIntent
    expect(armingWindow(i)).toEqual({ from: T, until: T + 30n })
    expect(armableAt(i, T + 31n)).toBe(false)
  })

  test('a signature that outlives the offer does not extend it', () => {
    const i = {
      ...base,
      permit: { value: 1000n, deadline: T + 99999n, signature: `0x${'33'.repeat(65)}` },
    } as unknown as SignedIntent
    expect(armingWindow(i).until).toBe(T + 3599n)
  })

  test('an authorization that opens after the offer closes leaves no usable second', () => {
    const i = {
      ...base,
      flags: 3,
      auth: { validAfter: T + 9000n, validBefore: T + 9999n, signature: '0x22' },
    } as unknown as SignedIntent
    const w = armingWindow(i)
    expect(w.from > w.until).toBe(true)
    expect(armableAt(i, T + 1n)).toBe(false)
    expect(armableAt(i, T + 9500n)).toBe(false)
  })
})

describe('the search refuses a leg whose signature is not usable yet', () => {
  const mirror = (over: Partial<SignedIntent>, tokenIn: string, tokenOut: string) =>
    ({ ...base, ...over, tokenIn, tokenOut }) as unknown as SignedIntent

  const A = '0x2222222222222222222222222222222222222222'
  const B = '0x3333333333333333333333333333333333333333'

  const bookOf = (second: SignedIntent) =>
    buildBook(
      [
        { key: 'a', intent: mirror({ nonce: 1n }, A, B), remaining: 1000n, partial: true },
        { key: 'b', intent: second, remaining: 1000n, partial: true },
      ],
      943,
    )

  // The cycle has to close before any of this means anything: leg one hands over 1000 A and
  // asks 900 B, leg two hands over 1000 B and asks 800 A, so the executor keeps 200 A and 100 B.
  const plain = mirror({ nonce: 2n, minOutStart: 800n, minOutEnd: 800n }, B, A)

  test('the ring is there when both legs are reachable', () => {
    expect(findRings(bookOf(plain), T + 10n, { maxPerPair: 3 }).length).toBeGreaterThan(0)
  })

  test('and gone at the second both offers end, where the chain answers `Expired`', () => {
    expect(findRings(bookOf(plain), T + 3599n, { maxPerPair: 3 }).length).toBeGreaterThan(0)
    expect(findRings(bookOf(plain), T + 3600n, { maxPerPair: 3 })).toHaveLength(0)
  })

  test('and gone when one leg’s authorization has not opened yet', () => {
    const later = {
      ...plain,
      flags: 3,
      auth: { validAfter: T + 3000n, validBefore: T + 3500n, signature: '0x22' },
    } as unknown as SignedIntent
    // The offer is live at T+10. The signature that funds it is not, and the chain would answer
    // `EscrowShort` for a reason no solver could distinguish from an empty wallet.
    expect(findRings(bookOf(later), T + 10n, { maxPerPair: 3 })).toHaveLength(0)
    // It comes back the moment the authorization opens.
    expect(findRings(bookOf(later), T + 3100n, { maxPerPair: 3 }).length).toBeGreaterThan(0)
  })

  test('and gone when one leg’s permit has already expired', () => {
    const expired = {
      ...plain,
      permit: { value: 1000n, deadline: T + 5n, signature: `0x${'33'.repeat(65)}` },
    } as unknown as SignedIntent
    expect(findRings(bookOf(expired), T + 10n, { maxPerPair: 3 })).toHaveLength(0)
    expect(findRings(bookOf(expired), T + 4n, { maxPerPair: 3 }).length).toBeGreaterThan(0)
  })
})

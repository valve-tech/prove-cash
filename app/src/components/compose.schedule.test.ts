import { describe, expect, test } from 'vitest'
import type { Hex } from 'viem'
import {
  CURVE_LINEAR,
  authWindowFor,
  decodeIntent,
  encodeIntent,
  FLAG_ESCROW,
  isDeadWindow,
  liveWindow,
  ZERO,
  ZERO_HASH,
  type SignedIntent,
} from '@prove.cash/sdk'
import { planOf } from '../lib/schedule'

/**
 * A future start, all the way to the wire.
 *
 * The form used to write `Date.now()` into every `startTime` it signed, so no offer this app
 * ever made opened later than the second it was posted. These tests follow one that does: the
 * maker's offset becomes a timestamp, the timestamp becomes an intent, the intent is packed for
 * the board, and the number that comes back off the board is the number the maker chose.
 *
 * The second half is the authorization, which carries a window of its own that nothing on chain
 * compares with the intent's. It has to survive the trip too, and it has to agree.
 */

const HOUR = 3600
const NOW = 1_800_000_000n
const SIG = ('0x' + '11'.repeat(65)) as Hex
const AUTH_SIG = ('0x' + '22'.repeat(65)) as Hex

/** The intent the form builds, from the same plan the drawer draws. */
function signedFrom(lead: number, duration: number, authLead: number | null): SignedIntent {
  const plan = planOf({ lead, duration, authLead })
  const startTime = NOW + BigInt(plan.opensIn)
  const endTime = NOW + BigInt(plan.endsIn)
  const intent: SignedIntent = {
    maker: '0x1111111111111111111111111111111111111111',
    recipient: '0x1111111111111111111111111111111111111111',
    tokenIn: '0x2222222222222222222222222222222222222222',
    tokenOut: '0x3333333333333333333333333333333333333333',
    amountIn: 1_000_000n,
    minOutStart: 420_000_000n,
    minOutEnd: 400_000_000n,
    curve: CURVE_LINEAR,
    startTime,
    endTime,
    executor: ZERO,
    feeConfig: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    feeRate: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: FLAG_ESCROW,
    nonce: 7n,
    signature: SIG,
  }
  if (plan.fundsIn !== null) {
    intent.auth = {
      ...authWindowFor(NOW + BigInt(plan.fundsIn), endTime),
      signature: AUTH_SIG,
    }
  }
  return intent
}

const roundTrip = (i: SignedIntent): SignedIntent => decodeIntent(encodeIntent(i))!

describe('a future start reaches the wire unchanged', () => {
  test('the offer opens exactly as far ahead as the maker asked', () => {
    const out = roundTrip(signedFrom(6 * HOUR, HOUR, null))
    expect(out.startTime).toBe(NOW + BigInt(6 * HOUR))
    expect(out.endTime).toBe(NOW + BigInt(7 * HOUR))
  })

  test('and its window is its own, measured from its own start', () => {
    const out = roundTrip(signedFrom(24 * HOUR, 15 * 60, null))
    expect(out.endTime - out.startTime).toBe(900n)
  })

  /** The default, and the whole of what an untouched form signs. Nothing about it changed. */
  test('an offer that opens now still opens now', () => {
    const out = roundTrip(signedFrom(0, HOUR, null))
    expect(out.startTime).toBe(NOW)
    expect(out.endTime).toBe(NOW + BigInt(HOUR))
  })
})

describe('the authorization carries its own window, and the two agree', () => {
  test('both bounds survive the board', () => {
    const signed = signedFrom(6 * HOUR, HOUR, 6 * HOUR)
    const out = roundTrip(signed)
    expect(out.auth?.validAfter).toBe(signed.auth?.validAfter)
    expect(out.auth?.validBefore).toBe(signed.auth?.validBefore)
    expect(out.auth?.signature).toBe(AUTH_SIG)
  })

  /**
   * `validAfter` was a hardcoded zero, which told the token to hand the maker's balance over the
   * moment anybody asked. A scheduled offer now names its own start instead, so the token itself
   * refuses a redemption before the offer opens.
   */
  test('and it no longer opens at the epoch', () => {
    const out = roundTrip(signedFrom(6 * HOUR, HOUR, 6 * HOUR))
    expect(out.auth?.validAfter).toBeGreaterThan(0n)
  })

  /**
   * The weld. EIP-3009 is exclusive at both ends, so the bounds sit one second outside the
   * seconds they mean and the token's usable window becomes exactly the intent's.
   */
  test('the seconds the token allows are exactly the seconds the offer runs', () => {
    const out = roundTrip(signedFrom(6 * HOUR, HOUR, 6 * HOUR))
    const window = liveWindow(out, out.auth)
    expect(window.from).toBe(out.startTime)
    expect(window.until).toBe(out.endTime)
    expect(isDeadWindow(window)).toBe(false)
  })

  /**
   * The offer the form refuses. Every term of the intent is legal — `_termsOk` never reads the
   * authorization — so it would reach the board looking healthy and fail every fill with the
   * reason a spent nonce gives.
   */
  test('an authorization that opens after the offer expires makes a dead offer', () => {
    const signed = signedFrom(0, 15 * 60, HOUR)
    expect(isDeadWindow(liveWindow(signed, signed.auth))).toBe(true)
    // And nothing about the intent alone says so.
    expect(signed.endTime).toBeGreaterThan(signed.startTime)
    expect(isDeadWindow(liveWindow(signed))).toBe(false)
  })
})

/**
 * The one wall clock in the form, pinned by its source.
 *
 * A default is only a default where it is read, and a start offset is only an offset while
 * something adds it to a clock read once. Two reads of `Date.now()` would let the offer's start
 * and its end come from different seconds.
 */
const SOURCE = Object.values(
  import.meta.glob('./Compose.tsx', { query: '?raw', import: 'default', eager: true }),
)[0] as string

describe('what the form actually signs', () => {
  test('it reads a wall clock exactly once', () => {
    expect(SOURCE.match(/Date\.now\(\) \/ 1000/g)).toHaveLength(1)
  })

  test('and both ends of the offer come off that one read', () => {
    expect(SOURCE).toContain('const startTime = now + BigInt(plan.opensIn)')
    expect(SOURCE).toContain('const endTime = now + BigInt(plan.endsIn)')
  })

  test('the start defaults to now, so an untouched drawer signs what it always did', () => {
    expect(SOURCE).toContain('const [lead, setLead] = useState(0)')
  })
})

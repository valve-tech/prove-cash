import { describe, expect, test } from 'vitest'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  KIND_STRETCH,
  ZERO,
  ZERO_HASH,
  minOutAt as sdkMinOutAt,
  grossOut as sdkGrossOut,
  stretchCurve,
  type Intent,
} from '@prove.cash/sdk'
import { grossOut, minOutAt, type Window } from './decay.ts'

/**
 * `decay.ts` is a deliberate copy of the SDK's decay math, kept because the landing page must not
 * import viem. A copy is only safe while it agrees with the original, so run both over the same
 * inputs — the boundaries first, then a deterministic sweep — and fail here if either moves.
 */

const A = '0x1111111111111111111111111111111111111111' as const
const B = '0x2222222222222222222222222222222222222222' as const

function intentFor(w: Window): Intent {
  return {
    maker: A,
    recipient: A,
    tokenIn: A,
    tokenOut: B,
    executor: ZERO,
    feeConfig: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    feeRate: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    nonce: 1n,
    ...w,
    // The window carries its own kind bits. `FLAG_PARTIAL` is orthogonal to them and rides along,
    // so a curved case is still a partial-fillable intent and the two never collide.
    flags: FLAG_PARTIAL | w.flags,
  }
}

/** The straight line: the zero word, no kind bits, and what every scene on the page signs. */
const LINE = { curve: CURVE_LINEAR, flags: 0 } as const

/** A stretch, in the two fractions the sign form's handles hold. */
const stretch = (start: number, length: number) => ({
  curve: stretchCurve(start, length),
  flags: KIND_STRETCH,
})

const CASES: Window[] = [
  // The card on the page: 25,000 DAI for at least 24,910 USDC, falling to 24,750 over 8 minutes.
  {
    amountIn: 25_000n * 10n ** 18n,
    minOutStart: 24_910n * 10n ** 6n,
    minOutEnd: 24_750n * 10n ** 6n,
    startTime: 0n,
    endTime: 480n,
    ...LINE,
  },
  // No decay at all: a flat floor.
  { amountIn: 1_000n, minOutStart: 900n, minOutEnd: 900n, startTime: 100n, endTime: 200n, ...LINE },
  // A zero-length window, where the span divisor would be zero.
  { amountIn: 1_000n, minOutStart: 900n, minOutEnd: 800n, startTime: 50n, endTime: 50n, ...LINE },
  // A steep fall over one second, where every rounding decision lands at once.
  { amountIn: 7n, minOutStart: 1_000_001n, minOutEnd: 1n, startTime: 0n, endTime: 1n, ...LINE },
  // The four shapes the sign form can draw, on the card's own window, so each of the copy's
  // branches is walked second by second against the original.
  {
    amountIn: 25_000n * 10n ** 18n,
    minOutStart: 24_910n * 10n ** 6n,
    minOutEnd: 24_750n * 10n ** 6n,
    startTime: 0n,
    endTime: 480n,
    ...stretch(0, 0.25),
  },
  {
    amountIn: 25_000n * 10n ** 18n,
    minOutStart: 24_910n * 10n ** 6n,
    minOutEnd: 24_750n * 10n ** 6n,
    startTime: 0n,
    endTime: 480n,
    ...stretch(0.5, 0.5),
  },
  {
    amountIn: 25_000n * 10n ** 18n,
    minOutStart: 24_910n * 10n ** 6n,
    minOutEnd: 24_750n * 10n ** 6n,
    startTime: 0n,
    endTime: 480n,
    ...stretch(0.25, 0.25),
  },
  // A stretch across the whole window, which the contract's own reading makes today's line — the
  // one case where the two kinds have to agree wei for wei.
  {
    amountIn: 25_000n * 10n ** 18n,
    minOutStart: 24_910n * 10n ** 6n,
    minOutEnd: 24_750n * 10n ** 6n,
    startTime: 0n,
    endTime: 480n,
    ...stretch(0, 1),
  },
]

describe('the landing page decays exactly like the SDK', () => {
  for (const [n, w] of CASES.entries()) {
    test(`case ${n}: the floor matches at every second of the window, and outside it`, () => {
      for (let t = Number(w.startTime) - 2; t <= Number(w.endTime) + 2; t++) {
        const now = BigInt(t)
        expect(minOutAt(w, now)).toBe(sdkMinOutAt(intentFor(w), now))
      }
    })

    test(`case ${n}: a partial fill is quoted the same, and rounds the same way`, () => {
      const takes = [1n, w.amountIn / 3n, w.amountIn / 2n, w.amountIn - 1n, w.amountIn]
      for (const take of takes) {
        if (take <= 0n) continue
        for (const now of [w.startTime, (w.startTime + w.endTime) / 2n, w.endTime]) {
          expect(grossOut(w, take, now)).toBe(sdkGrossOut(intentFor(w), take, now))
        }
      }
    })
  }

  /** A deterministic sweep, so a change to either copy has to survive more than four windows. */
  test('the two agree across a sweep of windows, sizes and times', () => {
    let seed = 0x5eed
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff
      return seed % n
    }
    for (let k = 0; k < 400; k++) {
      const start = BigInt(next(1_000))
      // Every third case is a stretch, so the copy's new branch gets a share of the sweep rather
      // than four hand-written windows. The fractions are drawn from the same seed, so a failure
      // reproduces.
      const shape =
        k % 3 === 0 ? LINE : stretch(next(1_000) / 1_000, Math.max(1, next(1_000)) / 1_000)
      const w: Window = {
        amountIn: BigInt(next(10 ** 6) + 1),
        minOutStart: BigInt(next(10 ** 6) + 1),
        minOutEnd: BigInt(next(10 ** 6)),
        startTime: start,
        endTime: start + BigInt(next(600)),
        ...shape,
      }
      const now = BigInt(next(2_000))
      const take = BigInt(next(Number(w.amountIn)) + 1)
      expect(minOutAt(w, now)).toBe(sdkMinOutAt(intentFor(w), now))
      expect(grossOut(w, take, now)).toBe(sdkGrossOut(intentFor(w), take, now))
    }
  })
})

import { describe, expect, test } from 'vitest'
import {
  CURVE_LINEAR,
  DECAY_PREMIUM as sdkDecayPremium,
  FLAG_PARTIAL,
  MAX_FEE_RATE as sdkMaxFeeRate,
  PERCENT as sdkPercent,
  PULSEX_FEE_DEN as sdkFeeDen,
  PULSEX_FEE_NUM as sdkFeeNum,
  SUGGESTED_WALLET_WINDOW_S as sdkWindow,
  ZERO,
  ZERO_HASH,
  grossForNet as sdkGrossForNet,
  presetTokens,
  quote as sdkQuote,
  suggestDecay as sdkSuggestDecay,
  type Intent,
} from '@prove.cash/sdk'
import { poolAmountOut as sdkPoolAmountOut, type Pool } from '@prove.cash/sdk/solver'
import type { Window } from '../decay.ts'
import {
  DECAY_PREMIUM,
  MAX_FEE_RATE,
  GWEI_HI,
  GWEI_LO,
  MAX_SLIDER_RATE,
  PERCENT,
  POOL_FEE_DEN,
  POOL_FEE_NUM,
  SUGGESTED_WALLET_WINDOW_S,
  TOKENS,
  WAD,
  SIZE_LO,
  build,
  feeOn,
  grossForNet,
  gweiForGasShare,
  marketPath,
  poolAmountOut,
  quote,
  rateForShare,
  sampleAt,
  suggestDecay,
  type Settings,
} from './model.ts'

/**
 * `model.ts` copies six pieces of the SDK, because the landing page must not import viem. A copy
 * is only safe while it agrees with the original, so every one of them runs against the SDK here
 * over a range of inputs and not at one point.
 *
 * The test imports the SDK freely. A test is never bundled; the runtime module is.
 */

const A = '0x1111111111111111111111111111111111111111' as const
const B = '0x2222222222222222222222222222222222222222' as const
/** The settlement's proceeds-point fee (P3), which is what the console's model mirrors. */
const sdkFeeOn = (gross: bigint, i: Intent): bigint => (gross * i.feeRateProceeds) / 10n ** 18n

/** A deterministic sweep, so a change to either copy has to survive more than four cases. */
function sweeper(seed: number) {
  let x = seed
  return (n: number) => {
    x = (x * 1_103_515_245 + 12_345) & 0x7fffffff
    return x % n
  }
}

/** The rates worth walking: zero, dust, the slider's ends, and past everything the app offers. */
const RATES = [
  0n,
  1n,
  10n ** 14n, // one basis point
  5n * 10n ** 14n,
  10n ** 16n, // one per cent
  2n * 10n ** 16n,
  20n * 10n ** 16n, // the sign form's own ceiling
  MAX_FEE_RATE - 1n,
]

const WINDOWS: Window[] = [
  // The console's own resting frame: a day-long offer on a thousand dollars of WPLS.
  {
    amountIn: 89_782_234n * 10n ** 18n,
    minOutStart: 1_010n * 10n ** 18n,
    minOutEnd: 955n * 10n ** 18n,
    startTime: 0n,
    endTime: 86_400n,
    curve: CURVE_LINEAR,
    flags: 0,
  },
  // Flat: a limit order at the maker's own number.
  {
    amountIn: 1_000n,
    minOutStart: 900n,
    minOutEnd: 900n,
    startTime: 100n,
    endTime: 200n,
    curve: CURVE_LINEAR,
    flags: 0,
  },
  // A steep fall over one second, where every rounding decision lands at once.
  {
    amountIn: 7n,
    minOutStart: 1_000_001n,
    minOutEnd: 1n,
    startTime: 0n,
    endTime: 1n,
    curve: CURVE_LINEAR,
    flags: 0,
  },
  // Six decimals, where a small gross at a small rate pays no fee at all.
  {
    amountIn: 25_000n * 10n ** 18n,
    minOutStart: 24_910n * 10n ** 6n,
    minOutEnd: 24_750n * 10n ** 6n,
    startTime: 0n,
    endTime: 480n,
    curve: CURVE_LINEAR,
    flags: 0,
  },
]

function intentFor(w: Window, rate: bigint): Intent {
  return {
    maker: A,
    recipient: A,
    tokenIn: A,
    tokenOut: B,
    executor: ZERO,
    // A rate with no destination is no rate, in the contract and in the mirror. The mirror takes
    // `rateOf` already applied, so the intent has to name somewhere for the two to agree.
    feeConfig: rate === 0n ? '0x0000000000000000000000000000000000000000000000000000000000000000' : '0x4444444444444444444444444444444444444444444444444444444444444444',
    feeRateIn: 0n,
    feeRateProceeds: rate,
    feeRate: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    nonce: 1n,
    ...w,
    flags: FLAG_PARTIAL | w.flags,
  }
}

const poolFor = (reserveIn: bigint, reserveOut: bigint): Pool =>
  ({
    address: '0x4444444444444444444444444444444444444444',
    token0: A,
    token1: B,
    reserve0: reserveIn,
    reserve1: reserveOut,
    feeNum: sdkFeeNum,
    feeDen: sdkFeeDen,
    venue: 'test',
    blockNumber: 1n,
  }) as unknown as Pool

describe('the console mirrors the SDK', () => {
  test('the constants are the SDK’s own', () => {
    expect(PERCENT).toBe(sdkPercent)
    expect(MAX_FEE_RATE).toBe(sdkMaxFeeRate)
    expect(WAD).toBe(sdkMaxFeeRate)
    expect(DECAY_PREMIUM).toBe(sdkDecayPremium)
    expect(POOL_FEE_NUM).toBe(sdkFeeNum)
    expect(POOL_FEE_DEN).toBe(sdkFeeDen)
    expect(SUGGESTED_WALLET_WINDOW_S).toBe(sdkWindow)
  })

  test('the pair menu is the SDK’s own mainnet presets, in order', () => {
    const sdkList = presetTokens(369)
    expect(TOKENS.map((t) => [t.address, t.symbol, t.decimals])).toEqual(
      sdkList.slice(0, TOKENS.length).map((t) => [t.address, t.symbol, t.decimals]),
    )
  })

  test('feeOn floors the same way, across rates and grosses', () => {
    const next = sweeper(0x11ee)
    for (const w of WINDOWS) {
      for (const rate of RATES) {
        const i = intentFor(w, rate)
        for (const gross of [0n, 1n, 1_999n, 2_000n, w.minOutEnd, w.minOutStart, 10n ** 24n]) {
          expect(feeOn(gross, rate)).toBe(sdkFeeOn(gross, i))
        }
      }
    }
    for (let k = 0; k < 400; k++) {
      const rate = BigInt(next(10 ** 6)) * 10n ** 12n
      const gross = BigInt(next(10 ** 9) + 1) * BigInt(next(10 ** 6) + 1)
      expect(feeOn(gross, rate)).toBe(sdkFeeOn(gross, intentFor(WINDOWS[0] as Window, rate)))
    }
  })

  test('the split matches at every rate, take and second of the window', () => {
    for (const w of WINDOWS) {
      for (const rate of RATES) {
        const i = intentFor(w, rate)
        const takes = [1n, w.amountIn / 3n, w.amountIn / 2n, w.amountIn - 1n, w.amountIn].filter(
          (x) => x > 0n,
        )
        // Every second of a short window; a stride through a long one, always including both
        // ends, the two seconds either side of them, and the exact midpoint.
        const span = Number(w.endTime) - Number(w.startTime)
        const stride = Math.max(1, Math.ceil(span / 64))
        const seconds = new Set<number>([
          Number(w.startTime) - 2,
          Number(w.startTime) - 1,
          Number(w.endTime) + 1,
          Number(w.endTime) + 2,
          Number(w.startTime) + Math.floor(span / 2),
        ])
        for (let t = Number(w.startTime); t <= Number(w.endTime); t += stride) seconds.add(t)
        seconds.add(Number(w.endTime))
        for (const take of takes) {
          for (const t of seconds) {
            const at = BigInt(t)
            const mine = quote(w, take, at, rate)
            const theirs = sdkQuote(i, take, at)
            expect(mine.gross).toBe(theirs.gross)
            expect(mine.fee).toBe(theirs.fee)
            expect(mine.delivered).toBe(theirs.delivered)
            // The identity the whole console rests on.
            expect(mine.delivered + mine.fee).toBe(mine.gross)
          }
        }
      }
    }
  })

  test('grossForNet agrees, and keeps the maker’s promise, over a sweep', () => {
    const next = sweeper(0x9e3d)
    const nets = [0n, 1n, 999n, 2_000n, 10n ** 6n, 25_000n * 10n ** 18n]
    for (const net of nets) {
      for (const rate of RATES.filter((r) => r < MAX_FEE_RATE)) {
        const mine = grossForNet(net, rate)
        expect(mine).toBe(sdkGrossForNet(net, rate))
        if (net > 0n) expect(mine - feeOn(mine, rate)).toBeGreaterThanOrEqual(net)
      }
    }
    for (let k = 0; k < 500; k++) {
      const net = BigInt(next(10 ** 9)) * BigInt(next(10 ** 6) + 1)
      const rate = BigInt(next(2 * 10 ** 6)) * 10n ** 11n
      const mine = grossForNet(net, rate)
      expect(mine).toBe(sdkGrossForNet(net, rate))
      if (net > 0n) expect(mine - feeOn(mine, rate)).toBeGreaterThanOrEqual(net)
    }
  })

  test('grossForNet refuses a rate the fee would swallow, exactly as the SDK does', () => {
    expect(() => grossForNet(10n, MAX_FEE_RATE)).toThrow(RangeError)
    expect(() => sdkGrossForNet(10n, MAX_FEE_RATE)).toThrow(RangeError)
    expect(() => grossForNet(10n, -1n)).toThrow(RangeError)
    expect(() => sdkGrossForNet(10n, -1n)).toThrow(RangeError)
  })

  test('the pool pays the same, from dust to a trade the size of the reserves', () => {
    const next = sweeper(0x0d00)
    const reserves: [bigint, bigint][] = [
      [40_916_996_419n * 10n ** 18n, 455_736n * 10n ** 18n],
      [10n ** 18n, 10n ** 18n],
      [1n, 1n],
    ]
    for (const [rIn, rOut] of reserves) {
      for (const amt of [0n, 1n, rIn / 1_000_000n, rIn / 100n, rIn, rIn * 10n]) {
        expect(poolAmountOut(rIn, rOut, amt)).toBe(sdkPoolAmountOut(poolFor(rIn, rOut), A, amt))
      }
    }
    for (let k = 0; k < 300; k++) {
      const rIn = BigInt(next(10 ** 9) + 1) * 10n ** 9n
      const rOut = BigInt(next(10 ** 9) + 1) * 10n ** 9n
      const amt = BigInt(next(10 ** 9)) * 10n ** 6n
      expect(poolAmountOut(rIn, rOut, amt)).toBe(sdkPoolAmountOut(poolFor(rIn, rOut), A, amt))
    }
    // An unmeasured pair, which is what every pair but one gets on this page.
    expect(poolAmountOut(0n, 1n, 1n)).toBeNull()
    expect(poolAmountOut(1n, 0n, 1n)).toBeNull()
  })

  test('the opening premium agrees, including the cases that give a flat order', () => {
    const next = sweeper(0x51a7)
    const cases: { floor: bigint; poolQuote: bigint | null; fillCost?: bigint }[] = [
      { floor: 955n * 10n ** 18n, poolQuote: 1_000n * 10n ** 18n, fillCost: 10n ** 16n },
      { floor: 955n * 10n ** 18n, poolQuote: 1_000n * 10n ** 18n },
      // A floor above the market: still an auction, of nothing.
      { floor: 1_200n * 10n ** 18n, poolQuote: 1_000n * 10n ** 18n, fillCost: 10n ** 16n },
      // No pool to open above.
      { floor: 955n * 10n ** 18n, poolQuote: null },
      { floor: 0n, poolQuote: 1_000n * 10n ** 18n },
      // A fill that costs more than the trade is worth.
      { floor: 10n, poolQuote: 12n, fillCost: 10_000n },
    ]
    for (const c of cases) expect(suggestDecay(c)).toEqual(sdkSuggestDecay(c))
    for (let k = 0; k < 400; k++) {
      const c = {
        floor: BigInt(next(10 ** 9)) * 10n ** 9n,
        poolQuote: BigInt(next(10 ** 9)) * 10n ** 9n,
        fillCost: BigInt(next(10 ** 6)) * 10n ** 9n,
      }
      expect(suggestDecay(c)).toEqual(sdkSuggestDecay(c))
    }
  })
})

/**
 * The rest is the console's own arithmetic, which nothing in the SDK computes: the market path
 * and the model that assembles the fill. `docs/FEE-MODEL.md` is the authority for every identity
 * asserted here.
 */

const BASE: Settings = {
  tokenIn: TOKENS[0] as (typeof TOKENS)[number],
  tokenOut: TOKENS[3] as (typeof TOKENS)[number],
  sizeUsd: 1_000,
  floorPct: 0.045,
  feeRate: PERCENT,
  dutch: true,
  opensSec: 0,
  expiresSec: 86_400,
  rung: 'allowance',
  cold: false,
  venue: 'v2',
  baseFeeGwei: 783_379,
  atSec: 43_200,
  step: 0,
}

describe('the market comes from a real week', () => {
  test('a path starts at one, is as long as the window, and stays inside the series', () => {
    for (const hours of [1, 6, 24, 168]) {
      for (const step of [0, 1, 7, 41, 100]) {
        const p = marketPath(step, hours)
        expect(p.series).toHaveLength(hours + 1)
        expect(p.series[0]).toBe(1)
        expect(p.startHour + hours).toBeLessThanOrEqual(168)
        for (const v of p.series) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })

  test('a step lands on a different stretch, not the same week nudged along', () => {
    const seen = new Set<string>()
    for (let step = 0; step < 12; step++) {
      const p = marketPath(step, 24)
      seen.add(`${p.from.symbol}/${p.to.symbol}@${p.startHour}`)
    }
    expect(seen.size).toBe(12)
  })

  test('the two stablecoins are never a pair, because their ratio is a flat line', () => {
    for (let step = 0; step < 60; step++) {
      const p = marketPath(step, 24)
      expect(p.from.stable && p.to.stable).toBe(false)
    }
  })

  test('a series is read between its samples, and clamped at both ends', () => {
    const s = [1, 2, 4]
    expect(sampleAt(s, 0)).toBe(1)
    expect(sampleAt(s, 0.5)).toBe(1.5)
    expect(sampleAt(s, 1.25)).toBe(2.5)
    expect(sampleAt(s, 2)).toBe(4)
    expect(sampleAt(s, -5)).toBe(1)
    expect(sampleAt(s, 99)).toBe(4)
  })
})

describe('the model splits one fill', () => {
  test('the filler pays the gross, and the gross is what the two halves add to', () => {
    for (const feeRate of [0n, PERCENT / 100n, PERCENT, 2n * PERCENT]) {
      const m = build({ ...BASE, feeRate })
      expect(m.delivered + m.fee).toBe(m.gross)
      expect(m.spread).toBe(m.proceeds - m.delivered)
      // The spread bar's three segments, and the reason they can be drawn as one bar.
      expect(m.fee + m.solver + m.gasB).toBe(m.spread)
    }
  })

  test('the rate is not in the solver’s condition: it moves money, not the fill', () => {
    // Two offers whose GROSS curve is the same. `docs/FEE-MODEL.md` Part 3: the filler pays the
    // gross whatever the rate says, so the solver's residual cannot know the rate.
    const free = build({ ...BASE, feeRate: 0n })
    const paid = build({ ...BASE, feeRate: PERCENT, floorPct: 0.045 })
    // The net floor is the same number in both, so the paid offer signs a LARGER gross...
    expect(paid.floorNet).toBe(free.floorNet)
    expect(paid.floorGross).toBeGreaterThan(free.floorGross)
    // ...and that, not the rate, is what costs the solver and moves the crossing.
    expect(paid.solver).toBeLessThan(free.solver)
    expect(paid.crossHeld).toBeGreaterThanOrEqual(free.crossHeld)
    expect(free.fee).toBe(0n)
  })

  test('the maker receives at least the net they typed, at every rate', () => {
    for (const feeRate of [0n, 1n, PERCENT / 1000n, PERCENT, 2n * PERCENT]) {
      const m = build({ ...BASE, feeRate, atSec: 86_400 })
      // At the close the curve is at its floor, which is the tightest the promise ever gets.
      expect(m.delivered).toBeGreaterThanOrEqual(m.floorNet)
    }
  })

  test('a live input never reaches a signed one', () => {
    // Part 5, direction one: the console shipped a defect where dragging the base fee moved the
    // maker's curve. Everything signed has to be identical across the base-fee range.
    const low = build({ ...BASE, baseFeeGwei: 100_000 })
    const high = build({ ...BASE, baseFeeGwei: 100_000_000 })
    expect(high.w).toEqual(low.w)
    expect(high.floorGross).toBe(low.floorGross)
    expect(high.floorNet).toBe(low.floorNet)
    // And the live side does move.
    expect(high.gasB).toBeGreaterThan(low.gasB)
    expect(high.solver).toBeLessThan(low.solver)
  })

  test('the market moves the solver’s side and never the maker’s', () => {
    const a = build({ ...BASE, step: 3 })
    const b = build({ ...BASE, step: 4 })
    expect(b.gross).toBe(a.gross)
    expect(b.delivered).toBe(a.delivered)
    expect(b.fee).toBe(a.fee)
  })

  test('the clock moves the maker’s side, and never below the floor', () => {
    const open = build({ ...BASE, atSec: 0 })
    const close = build({ ...BASE, atSec: 86_400 })
    expect(open.gross).toBeGreaterThan(close.gross)
    expect(close.gross).toBe(close.floorGross)
    for (const at of [0, 1, 3_600, 43_200, 86_399, 86_400]) {
      const m = build({ ...BASE, atSec: at })
      expect(m.gross).toBeGreaterThanOrEqual(m.floorGross)
      expect(m.gross).toBeLessThanOrEqual(m.w.minOutStart)
    }
  })

  test('a flat offer is a limit order at the maker’s own number', () => {
    const m = build({ ...BASE, dutch: false })
    expect(m.w.minOutStart).toBe(m.w.minOutEnd)
    expect(m.w.minOutEnd).toBe(m.floorGross)
  })

  test('the same token on both sides is not a trade', () => {
    const m = build({ ...BASE, tokenOut: TOKENS[0] as (typeof TOKENS)[number] })
    expect(m.ok).toBe(false)
    expect(m.fills).toBe(false)
    expect(m.breakEven).toBeNull()
  })

  test('the allowance rungs warn past an hour, and the escrow rung does not', () => {
    expect(build({ ...BASE, rung: 'allowance', expiresSec: 3_600 }).zombie).toBe(false)
    expect(build({ ...BASE, rung: 'allowance', expiresSec: 3_601 }).zombie).toBe(true)
    expect(build({ ...BASE, rung: 'escrow', expiresSec: 86_400 }).zombie).toBe(false)
    expect(build({ ...BASE, rung: 'allowance', opensSec: 7_200, expiresSec: 10_000 }).zombie).toBe(
      true,
    )
  })

  test('gas is a third asset: it does not scale with the trade', () => {
    const small = build({ ...BASE, sizeUsd: 10 })
    const large = build({ ...BASE, sizeUsd: 100_000 })
    expect(large.gasB).toBe(small.gasB)
    expect(large.gasPls).toBe(small.gasPls)
  })

  test('below the break-even size gas eats the margin, and above it a solver fills', () => {
    const m = build(BASE)
    if (m.breakEven === null) throw new Error('the resting frame must have a break-even size')
    const beUsd = (Number(m.breakEven) / 10 ** m.a.decimals) * m.a.usd
    // The console prints one number, so the two sides of it must actually disagree.
    expect(build({ ...BASE, sizeUsd: beUsd * 1.5 }).solver).toBeGreaterThan(0n)
    expect(build({ ...BASE, sizeUsd: beUsd * 0.5 }).solver).toBeLessThan(0n)
  })

  test('below the break-even gas price a solver fills, and above it gas eats the margin', () => {
    const m = build(BASE)
    if (m.breakEvenGwei === null) throw new Error('the resting frame must have a break-even gas price')
    // Same identity as the size test, for the other slider: gas scales with gwei and nothing else.
    expect(build({ ...BASE, baseFeeGwei: m.breakEvenGwei * 0.5 }).solver).toBeGreaterThan(0n)
    expect(build({ ...BASE, baseFeeGwei: m.breakEvenGwei * 1.5 }).solver).toBeLessThan(0n)
  })

  test('a fill with no margin before gas has no break-even gas price', () => {
    // At the open the offer sits above the market, so proceeds − gross is negative and free gas
    // would not help. The tick stays off the track rather than claiming a ceiling that is not there.
    const m = build({ ...BASE, atSec: 0, floorPct: 0.0001 })
    expect(m.proceeds - m.gross).toBeLessThanOrEqual(0n)
    expect(m.breakEvenGwei).toBeNull()
  })

  test('dragging the fee mark lands on a rate whose fee is that share of the spread', () => {
    // The bar's first mark is draggable, and the arithmetic runs the wrong way for algebra: the
    // fee is `gross × rate` and the gross itself rises with the rate. Bisection settles it, and
    // this is what says the answer is the one the reader dragged to.
    const m = build(BASE)
    for (const share of [0, 0.1, 0.25, 0.5]) {
      const r = rateForShare(BASE, m, share)
      const got = build({ ...BASE, feeRate: r })
      // Against the spread the reader could see when they started the drag, which is the one the
      // mark sits on. Within a basis point of rate, which is finer than the mark can be dragged.
      const landed = Number(got.fee) / Number(m.spread)
      expect(Math.abs(landed - share)).toBeLessThan(0.01)
      expect(r).toBeLessThanOrEqual(MAX_SLIDER_RATE)
      expect(r).toBeGreaterThanOrEqual(0n)
    }
    expect(rateForShare(BASE, m, 0)).toBe(0n)
  })

  test('no spread to divide means no rate to drag to', () => {
    // At the open the offer sits above the market by its premium, so there is nothing to split.
    const m = build({ ...BASE, atSec: 0, floorPct: 0.0001 })
    expect(m.spread).toBeLessThanOrEqual(0n)
    expect(rateForShare({ ...BASE, atSec: 0, floorPct: 0.0001 }, m, 0.5)).toBe(0n)
  })

  test('dragging the gas mark lands on a base fee whose gas is that share of the spread', () => {
    // The bar's second mark is draggable; only gas moves it. A small size makes gas a visible
    // slice of the spread so the share is not lost in rounding. Stay under GWEI_HI so the
    // clamp cannot pull the landed share off the mark the reader dragged to.
    const s = { ...BASE, sizeUsd: 10 }
    const m = build(s)
    expect(m.spread).toBeGreaterThan(0n)
    for (const share of [0.05, 0.1, 0.2, 0.4]) {
      const gwei = gweiForGasShare(s, m, share)
      expect(gwei).toBeGreaterThan(GWEI_LO)
      expect(gwei).toBeLessThan(GWEI_HI)
      const got = build({ ...s, baseFeeGwei: gwei })
      const landed = Number(got.gasB) / Number(m.spread)
      expect(Math.abs(landed - share)).toBeLessThan(0.03)
    }
    expect(gweiForGasShare(s, m, 0)).toBe(GWEI_LO)
  })

  test('no spread to divide means the gas mark keeps the current base fee', () => {
    const s = { ...BASE, atSec: 0, floorPct: 0.0001 }
    const m = build(s)
    expect(m.spread).toBeLessThanOrEqual(0n)
    expect(gweiForGasShare(s, m, 0.5)).toBe(s.baseFeeGwei)
  })

  test('the resting frame the page prerenders is profitable and has every figure', () => {
    const m = build(BASE)
    expect(m.ok).toBe(true)
    expect(m.fills).toBe(true)
    expect(m.measuredDepth).toBe(true)
    expect(m.gross).toBeGreaterThan(0n)
    expect(m.fee).toBeGreaterThan(0n)
    expect(m.solver).toBeGreaterThan(0n)
    expect(m.burn).toBeGreaterThan(0n)
    expect(m.poolImpact).toBeGreaterThan(0n)
    expect(Number.isFinite(m.crossHeld)).toBe(true)
  })

  test('jumping to crossHeld is profitable when the crossing exists', () => {
    // From the open: crossHeld is the first second the decay clears if the market holds
    // here — the same second the "go to the fill" chip jumps to. Mid-window the figure is
    // a counterfactual on today's proceeds, so jumping the clock alone would reprice the path.
    const open = build({ ...BASE, atSec: 0 })
    expect(open.fills).toBe(false)
    expect(Number.isFinite(open.crossHeld)).toBe(true)
    const atFill = build({ ...BASE, atSec: open.crossHeld })
    expect(atFill.fills).toBe(true)
    expect(atFill.solver).toBeGreaterThan(0n)
  })
})


describe('SIZE_LO allows a one-cent trade', () => {
  test('the floor is one cent, and build accepts it', () => {
    expect(SIZE_LO).toBe(0.01)
    const m = build({ ...BASE, sizeUsd: SIZE_LO })
    expect(m.ok).toBe(true)
    expect(m.amountIn).toBeGreaterThan(0n)
  })
})

describe('gas figures refresh when the pair flips', () => {
  test('gasB is priced in token B, so a swap changes the raw amount and the bar share', () => {
    const forward = build(BASE) // WPLS -> DAI
    const flipped = build({
      ...BASE,
      tokenIn: BASE.tokenOut,
      tokenOut: BASE.tokenIn,
      sizeUsd: 10,
    })
    // Same PLS gas, different B denomination.
    expect(flipped.gasPls).toBeCloseTo(forward.gasPls, 8)
    expect(flipped.gasUsd).toBeCloseTo(forward.gasUsd, 8)
    expect(flipped.b.symbol).not.toBe(forward.b.symbol)
    expect(flipped.gasB).not.toBe(forward.gasB)
    // Break-even gwei tracks the margin in B; a $10 DAI trade is not a $1000 WPLS trade.
    expect(flipped.breakEvenGwei).not.toBe(forward.breakEvenGwei)
  })
})

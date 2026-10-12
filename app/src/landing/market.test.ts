import { describe, expect, test } from 'vitest'
import { minOutAt } from './decay.ts'
import { amount, at, floorAt, frame, HOURS, money, pairs, pickSize, scene } from './market.ts'
import { PRICE_TOKENS } from './prices.ts'

/**
 * The hero has one job it must never fail: the offer opens above the market, and the market meets
 * it on screen. A scene that filled on the first hour or never filled at all would read as a
 * broken page rather than as a market — and the pair, the direction and the two days are all
 * chosen at random, so every one of those draws has to work.
 */

/** A `pick` that walks a fixed sequence, so a scene is reproducible. */
const picker = (values: number[]) => {
  let i = 0
  return () => values[i++ % values.length]!
}

/** Enough draws to reach every pair and a spread of slices within each. */
const DRAWS: [number, number][] = []
for (let a = 0; a < 42; a++) {
  for (const b of [0, 0.13, 0.37, 0.61, 0.84, 0.999]) DRAWS.push([a / 42 + 1e-6, b])
}

describe('the price table', () => {
  test('every series names the same hours, so a ratio is a real rate', () => {
    const n = PRICE_TOKENS[0]!.usd.length
    expect(n).toBeGreaterThan(HOURS)
    for (const t of PRICE_TOKENS) expect(t.usd, t.symbol).toHaveLength(n)
  })

  test('no price is zero or negative', () => {
    for (const t of PRICE_TOKENS) {
      for (const v of t.usd) expect(v, t.symbol).toBeGreaterThan(0)
    }
  })
})

describe('pairs', () => {
  test('never draws one stablecoin against another — that is a flat line', () => {
    for (const [from, to] of pairs()) expect(from.stable && to.stable).toBe(false)
  })

  test('never draws a token against itself', () => {
    for (const [from, to] of pairs()) expect(from.symbol).not.toBe(to.symbol)
  })

  test('offers both directions, so from and to are a real choice', () => {
    const both = pairs().filter(([f, t]) => f.symbol === 'WETH' && t.symbol === 'USDC').length
    const back = pairs().filter(([f, t]) => f.symbol === 'USDC' && t.symbol === 'WETH').length
    expect(both).toBe(1)
    expect(back).toBe(1)
  })
})

describe('scene', () => {
  test('the same draw is the same scene, so the card does not flicker', () => {
    const a = scene(picker([0.3, 0.7]))
    const b = scene(picker([0.3, 0.7]))
    expect(a.from.symbol).toBe(b.from.symbol)
    expect(a.market).toEqual(b.market)
    expect(a.fill).toBe(b.fill)
  })

  test('the offer is not fillable when it opens — on every draw', () => {
    for (const d of DRAWS) {
      const s = scene(picker(d))
      const label = `${s.from.symbol}/${s.to.symbol}`
      expect(floorAt(s, 0), label).toBeGreaterThan(s.market[0]!)
    }
  })

  test('the market meets the floor inside the window — on every draw', () => {
    for (const d of DRAWS) {
      const s = scene(picker(d))
      const label = `${s.from.symbol}/${s.to.symbol}`
      expect(s.fill, label).toBeGreaterThan(0)
      expect(s.fill, label).toBeLessThan(s.hours)
      expect(floorAt(s, s.fill), label).toBeLessThanOrEqual(s.market[s.fill]!)
    }
  })

  test('the hour before the fill is still resting, so the fill is the first', () => {
    for (const d of DRAWS) {
      const s = scene(picker(d))
      const before = s.fill - 1
      if (before < 0) continue
      const label = `${s.from.symbol}/${s.to.symbol} at ${before}`
      expect(floorAt(s, before), label).toBeGreaterThan(s.market[before]!)
    }
  })

  test('the fill lands in the second half, so the wait is on screen', () => {
    for (const d of DRAWS) {
      const s = scene(picker(d))
      expect(s.fill / s.hours, `${s.from.symbol}/${s.to.symbol}`).toBeGreaterThan(0.35)
    }
  })

  test('the floor never decays to nothing', () => {
    // A floor is a price, and a constant-product market has no zero price to decay to. It is also
    // an offer someone is meant to believe: one that gives away half its value in two days is not.
    for (const d of DRAWS) {
      const s = scene(picker(d))
      const label = `${s.from.symbol}/${s.to.symbol}`
      expect(s.offer.minOutEnd, label).toBeGreaterThan(0n)
      expect(Number(s.offer.minOutEnd) / Number(s.offer.minOutStart), label).toBeGreaterThan(0.55)
    }
  })

  test('the offer is quoted in the contract’s own fields', () => {
    const s = scene(picker([0.42, 0.5]))
    // The plotted floor is `minOutAt`, not a line drawn to look like it.
    expect(floorAt(s, 0)).toBeCloseTo(Number(s.offer.minOutStart) / 10 ** s.to.decimals, 9)
    expect(floorAt(s, s.hours - 1)).toBeCloseTo(
      Number(minOutAt(s.offer, s.offer.endTime)) / 10 ** s.to.decimals,
      9,
    )
  })

  test('the market actually moves — a ruler is not a tape', () => {
    for (const d of DRAWS) {
      const s = scene(picker(d))
      const hi = Math.max(...s.market)
      const lo = Math.min(...s.market)
      expect((hi - lo) / hi, `${s.from.symbol}/${s.to.symbol}`).toBeGreaterThan(0.002)
    }
  })

  test('the size is worth roughly what the example claims, whatever its shape', () => {
    for (const d of DRAWS) {
      const s = scene(picker(d))
      // Rounding moves it, but never far enough to make the offer a different size of offer.
      // The notional is drawn between 6k and 60k, and rounding moves it a little either way.
      const usd = s.size * s.from.usd[0]!
      expect(usd, `${s.from.symbol} ${s.size}`).toBeGreaterThan(3_000)
      expect(usd, `${s.from.symbol} ${s.size}`).toBeLessThan(90_000)
    }
  })

  test('sizes are a mix of whole numbers and fractions, not all catalogue numbers', () => {
    // Every size used to come from `niceSize`, so the hero offered 12 or 3,000 or 0.4 for ever.
    // Always-round is a tell that a machine chose it.
    const sizes = DRAWS.map((d) => scene(picker(d)).size)
    const whole = sizes.filter((v) => Number.isInteger(v))
    const fractional = sizes.filter((v) => !Number.isInteger(v))
    expect(whole.length, 'some whole').toBeGreaterThan(0)
    expect(fractional.length, 'some fractional').toBeGreaterThan(0)
    // And not merely two distinct values dressed up as variety.
    expect(new Set(sizes.map((v) => String(v))).size).toBeGreaterThan(8)
  })
})

describe('pickSize', () => {
  const styled = (style: number) => () => style

  test('a low draw gives the round number', () => {
    expect(pickSize(13.28, styled(0.1))).toBe(12)
    expect(pickSize(2083, styled(0.1))).toBe(2000)
  })

  test('a middle draw gives whole units', () => {
    expect(pickSize(13.28, styled(0.5))).toBe(13)
  })

  test('a higher draw gives it to the cent', () => {
    expect(pickSize(13.28, styled(0.75))).toBe(13.28)
  })

  test('a high draw gives three significant figures', () => {
    expect(pickSize(13.28, styled(0.95))).toBe(13.3)
  })

  test('a sub-1 size never asks for whole units — that would be zero', () => {
    for (const style of [0.5, 0.75, 0.95]) {
      const v = pickSize(0.4166, styled(style))
      expect(v, `style ${style}`).toBeGreaterThan(0)
      expect(v, `style ${style}`).toBeLessThan(1)
    }
  })

  test('a nonsense target does not produce a nonsense offer', () => {
    expect(pickSize(0, styled(0.5))).toBe(1)
    expect(pickSize(NaN, styled(0.5))).toBe(1)
    expect(pickSize(-4, styled(0.5))).toBe(1)
  })

  test('every shape it produces survives being printed', () => {
    // `amount` pads nothing and truncates above a thousand, so a size it cannot represent would
    // silently print as a different number than the offer holds. This missed that once: the
    // targets below had no fractional value over 1000, and 7,606.23 shipped printing as "7,606".
    const targets = [13.28, 2083, 0.4166, 1.005, 999.5, 7606.23, 2750.5, 1200.75, 0.00081, 45678.9]
    for (const target of targets) {
      for (let style = 0; style < 1; style += 0.05) {
        const v = pickSize(target, styled(style))
        expect(Number(amount(v).replace(/,/g, '')), `${target} @ ${style.toFixed(2)}`).toBeCloseTo(
          v,
          6,
        )
      }
    }
  })

  test('a size over a thousand is always a whole number of units', () => {
    for (let style = 0; style < 1; style += 0.05) {
      const v = pickSize(7606.23, styled(style))
      expect(Number.isInteger(v), `style ${style.toFixed(2)} gave ${v}`).toBe(true)
    }
  })
})

describe('money', () => {
  test('shows a small amount moving rather than freezing it at two decimals', () => {
    expect(money(0.4217)).not.toBe(money(0.418))
  })

  test('keeps a large amount readable', () => {
    expect(money(24_847)).toBe('24,847.00')
  })
})

describe('frame', () => {
  test('never puts the floor of a positive series at or under zero', () => {
    const [lo] = frame([0.001, 1])
    expect(lo).toBeGreaterThan(0)
  })

  test('opens a flat series rather than dividing by zero', () => {
    const [lo, hi] = frame([5, 5])
    expect(hi).toBeGreaterThan(lo)
  })
})

describe('at', () => {
  test('reads a whole index exactly and interpolates between two', () => {
    expect(at([10, 20, 30], 1)).toBe(20)
    expect(at([10, 20, 30], 1.5)).toBe(25)
  })

  test('clamps rather than running off either end', () => {
    expect(at([10, 20], -5)).toBe(10)
    expect(at([10, 20], 9)).toBe(20)
  })
})

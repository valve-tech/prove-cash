import { describe, expect, it } from 'vitest'
import { parseUnits } from 'viem'
import { DECAY_PREMIUM, suggestDecay } from './decay.js'
import { minOutAt, type Intent } from './intent.js'

/**
 * The two ends of the curve the app signs by default.
 *
 * Every offer this app made before today was flat — one price for the whole window, first valid
 * transaction wins — because the form defaulted the decay off. A flat price is a latency race and
 * the maker takes nothing from it, so the default is now a decay and this picks its start.
 *
 * The rules that matter are the ones a maker would be robbed by if they broke: the end is exactly
 * what they typed, the start is never below it, and no market means no invented one.
 */

const usdc = (v: string) => parseUnits(v, 6)

describe('suggestDecay', () => {
  it('opens above the pool and ends at the floor the maker typed', () => {
    const floor = usdc('400')
    const { minOutStart, minOutEnd } = suggestDecay({ floor, poolQuote: usdc('412') })

    expect(minOutEnd).toBe(floor)
    expect(minOutStart).toBeGreaterThan(usdc('412'))
    // The quote plus 1.03% of it, in whole units of the token.
    expect(minOutStart).toBe(usdc('412') + (usdc('412') * DECAY_PREMIUM) / 10n ** 18n)
  })

  it('returns a flat order when there is no pool to quote', () => {
    const floor = usdc('400')
    expect(suggestDecay({ floor })).toEqual({ minOutStart: floor, minOutEnd: floor })
    expect(suggestDecay({ floor, poolQuote: null })).toEqual({
      minOutStart: floor,
      minOutEnd: floor,
    })
    expect(suggestDecay({ floor, poolQuote: 0n })).toEqual({
      minOutStart: floor,
      minOutEnd: floor,
    })
  })

  /**
   * The case the contract would refuse. `_termsOk` enforces `minOutEnd <= minOutStart`, so a start
   * taken from a quote below the floor would make an intent nobody could fill and no wallet could
   * warn about.
   */
  it('never starts below the floor, however low the pool is', () => {
    const floor = usdc('400')
    for (const quote of ['0.000001', '1', '100', '380', '395']) {
      const d = suggestDecay({ floor, poolQuote: usdc(quote) })
      expect(d.minOutStart).toBeGreaterThanOrEqual(d.minOutEnd)
      expect(d).toEqual({ minOutStart: floor, minOutEnd: floor })
    }
  })

  it('is flat when the premium does not clear the floor either', () => {
    // A quote a whisker under the floor: the premium lifts the start over it, and that is a real
    // auction. A quote further down cannot be lifted that far, and stays flat.
    const floor = usdc('400')
    expect(suggestDecay({ floor, poolQuote: usdc('399') }).minOutStart).toBeGreaterThan(floor)
    expect(suggestDecay({ floor, poolQuote: usdc('390') })).toEqual({
      minOutStart: floor,
      minOutEnd: floor,
    })
  })

  it('takes a premium from the caller, and zero means "open at the market"', () => {
    const floor = usdc('400')
    const quote = usdc('500')
    expect(suggestDecay({ floor, poolQuote: quote, premium: 0n }).minOutStart).toBe(quote)
    expect(suggestDecay({ floor, poolQuote: quote, premium: 10n ** 17n }).minOutStart).toBe(
      quote + quote / 10n,
    )
  })

  /** An empty field, not a maker who will take nothing. A curve down to zero is not the answer. */
  it('will not build a curve down to a floor of zero', () => {
    expect(suggestDecay({ floor: 0n, poolQuote: usdc('412') })).toEqual({
      minOutStart: 0n,
      minOutEnd: 0n,
    })
  })

  /**
   * The point of the whole exercise, checked against the formula the chain runs: an early fill
   * pays the maker more than they asked for, and the last one pays exactly what they asked for.
   */
  it('pays an early fill more than the maker asked, and a late one exactly it', () => {
    const floor = usdc('400')
    const { minOutStart, minOutEnd } = suggestDecay({ floor, poolQuote: usdc('412') })
    const i = {
      minOutStart,
      minOutEnd,
      startTime: 1_000n,
      endTime: 4_600n,
    } as Intent

    expect(minOutAt(i, 1_000n)).toBeGreaterThan(floor)
    expect(minOutAt(i, 2_800n)).toBeGreaterThan(floor)
    expect(minOutAt(i, 4_600n)).toBe(floor)
  })
})

/**
 * The premium has to be a fraction of the trade, because a fill's cost is.
 *
 * A flat premium sized for the smallest ticket the protocol prices — a sixty-cent heartbeat
 * intent, where gas is one per cent — is a thousand times too large on a thousand-dollar trade.
 * Measured against a one-hour window decaying linearly to the maker's floor, a flat 1.03% leaves
 * an offer with a tight floor unfillable for 58 of its 60 minutes. These pin the shape that
 * fixes it.
 */
describe('the premium scales with the trade', () => {
  const ONE = 10n ** 18n
  /** A dollar of gas against a thousand-dollar trade, in the quote's own units. */
  const bigTrade = { floor: 990n * ONE, poolQuote: 1000n * ONE, fillCost: ONE / 100n }
  /** The same dollar of gas against a one-dollar trade. */
  const smallTrade = { floor: ONE / 2n, poolQuote: ONE, fillCost: ONE / 100n }

  const premiumOf = (d: { minOutStart: bigint }, quote: bigint) =>
    Number(((d.minOutStart - quote) * 1_000_000n) / quote) / 10_000

  it('opens a hair above market on a large trade', () => {
    const d = suggestDecay(bigTrade)
    expect(premiumOf(d, bigTrade.poolQuote)).toBeLessThan(0.01)
  })

  it('opens well above market on a small one, where a fill costs real money', () => {
    const d = suggestDecay(smallTrade)
    expect(premiumOf(d, smallTrade.poolQuote)).toBeGreaterThan(0.9)
  })

  /**
   * The premium is one fill's gas and nothing else.
   *
   * It carried the protocol fee too, and took a `feeRate` to do it, because the filler paid that
   * fee on top of the delivery. The settlement takes the fee out of the maker's own number now,
   * so the filler's cost of a fill is gas alone. Anything else added here would ask the market
   * for a concession no filler needs, and would delay every fill that asked for it.
   */
  it('opens by exactly one fill, with no fee added to it', () => {
    const d = suggestDecay(bigTrade)
    expect(d.minOutStart - bigTrade.poolQuote).toBe(bigTrade.fillCost)
  })

  /** Without a cost to divide, the small-ticket assumption is the safe one. */
  /** A concession wide enough that the cap does not bind, so the constant is what is left. */
  it('falls back to the constant when a fill cannot be priced', () => {
    const d = suggestDecay({ floor: 900n * ONE, poolQuote: 1000n * ONE })
    expect(premiumOf(d, 1000n * ONE)).toBeCloseTo(1.03, 2)
  })

  it('still never opens below the floor, however small the premium', () => {
    const d = suggestDecay({ floor: 1000n * ONE, poolQuote: 1000n * ONE, fillCost: 1n })
    expect(d.minOutStart).toBeGreaterThanOrEqual(d.minOutEnd)
  })
})

/**
 * Whatever the premium wants to be, the maker's own concession bounds it.
 *
 * A linear curve from `quote x (1 + p)` to a floor `c` under the quote reaches the market at
 * `p / (p + c)` of the window. Holding `p` at `c / 2` fixes that at a third for every trade,
 * which is the property the flat constant lacked.
 */
describe('the premium never outruns the room the maker gave', () => {
  const ONE = 10n ** 18n
  const quote = 1000n * ONE

  /** Where a linear decay from start to floor first reaches the quote, as a fraction of window. */
  const crossesAt = (d: { minOutStart: bigint; minOutEnd: bigint }) =>
    Number(((d.minOutStart - quote) * 10_000n) / (d.minOutStart - d.minOutEnd)) / 10_000

  it('crosses the market by a third of the way in, at every concession', () => {
    for (const bps of [10n, 50n, 100n, 200n, 500n]) {
      const floor = quote - (quote * bps) / 10_000n
      // A third is the cap's own answer. A wide concession lets the smaller constant bind
      // first and crosses sooner still, so the property is a bound and not an equality.
      expect(crossesAt(suggestDecay({ floor, poolQuote: quote }))).toBeLessThanOrEqual(0.34)
    }
  })

  /** The case that prompted the bound: a tenth of a per cent used to cost 58 minutes of 60. */
  it('a tight floor is fillable early, not at the death', () => {
    const floor = quote - quote / 1000n
    expect(crossesAt(suggestDecay({ floor, poolQuote: quote }))).toBeLessThan(0.4)
  })

  /**
   * A floor at the market is not a concession, so the cap has nothing to bound — and the offer
   * was never going to fill at t=0 anyway. Opening above it is upside the maker would otherwise
   * hand to whoever fills them the moment the market ticks up.
   */
  it('a floor at the market still opens above it, because that costs the maker nothing', () => {
    const d = suggestDecay({ floor: quote, poolQuote: quote })
    expect(d.minOutStart).toBeGreaterThan(d.minOutEnd)
    expect(d.minOutEnd).toBe(quote)
  })
})

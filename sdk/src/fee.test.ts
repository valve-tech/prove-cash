import { describe, expect, test } from 'vitest'
import {
  MAX_FEE_RATE,
  NO_FEE,
  assertFeeTerms,
  feeTermsFault,
  feeTermsMessage,
  pricedFeeRates,
  defaultFeeTerms,
  grossForNet,
  ratesAboveWarn,
  solverBorneRate,
} from './fee.js'
import { defaultFees } from './config.js'
import { hashFeeConfig, singleFeeConfig } from './feeconfig.js'
import { CURVE_LINEAR, grossOut, ZERO, ZERO_HASH, type Intent } from './intent.js'
import { maxFeeRateFor, quote } from './settlement.js'
import feeFixture from '../../app/src/lib/__fixtures__/fee.json' with { type: 'json' }

/**
 * The fee comes out of the maker's number, so the maker's number has to be derived.
 *
 * A maker types what they will receive. The form signs a gross, the settlement takes the fee out
 * of it, and the remainder must still meet the number the maker typed. `grossForNet` is the one
 * step between those two, and the whole promise rests on a single ceiling division agreeing with
 * a single floor division. One wei in the wrong direction is a broken promise, so these check it
 * over the whole range rather than at a handful of points.
 */

const MAKER = '0x1111111111111111111111111111111111111111' as const
const DESTINATION = '0x4444444444444444444444444444444444444444' as const

/** The fee the settlement takes out of `gross` at the proceeds point (P3), floored. */
const feeOn = (gross: bigint, i: Intent): bigint => (gross * i.feeRateProceeds) / 10n ** 18n

/**
 * An intent that asks `gross` for the whole of `amountIn`, with `rate` at P3 (the point that comes
 * out of the maker's number, which is what these tests were written about), to a real config.
 */
function offering(gross: bigint, rate: bigint, amountIn = 10n ** 18n): Intent {
  return {
    maker: MAKER,
    recipient: MAKER,
    tokenIn: MAKER,
    tokenOut: DESTINATION,
    amountIn,
    minOutStart: gross,
    minOutEnd: gross,
    startTime: 0n,
    endTime: 9_999_999_999n,
    executor: MAKER,
    feeConfig: hashFeeConfig(singleFeeConfig(DESTINATION)),
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: rate,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: 1,
    nonce: 1n,
    curve: CURVE_LINEAR,
  }
}

/**
 * A deterministic generator, because a test that fails on Tuesday and passes on Wednesday tells
 * nobody anything. This is xorshift64, seeded once, so every run walks the same numbers and a
 * failure names a case somebody can put in the file.
 */
function walker(seed: bigint): () => bigint {
  const MASK = (1n << 64n) - 1n
  let x = seed
  return () => {
    x = (x ^ (x << 13n)) & MASK
    x = x ^ (x >> 7n)
    x = (x ^ (x << 17n)) & MASK
    return x
  }
}

describe('the gross a maker signs to receive a net', () => {
  test('is the net itself when the intent charges nothing', () => {
    expect(grossForNet(1_000n, 0n)).toBe(1_000n)
    expect(grossForNet(0n, 0n)).toBe(0n)
  })

  test('is nothing when the maker asks for nothing', () => {
    expect(grossForNet(0n, MAX_FEE_RATE / 2n)).toBe(0n)
  })

  test('is the plain closed form at a round rate', () => {
    // One per cent. A maker who wants 99 signs 100, and the destination takes the one.
    const gross = grossForNet(99n * 10n ** 18n, 10n ** 16n)
    expect(gross).toBe(100n * 10n ** 18n)
    const q = quote(offering(gross, 10n ** 16n), 10n ** 18n, 0n)
    expect(q.delivered).toBe(99n * 10n ** 18n)
    expect(q.feeProceeds).toBe(10n ** 18n)
  })

  /**
   * The proof in `grossForNet`, run rather than read.
   *
   * `G = ceil(N·W / (W − r))` gives `G·(W − r) ≥ N·W`, and the settlement floors the fee, so
   * `G − fee ≥ G·(W − r)/W ≥ N`. Every step only ever loses value on the side that can afford
   * it, so the maker is met at every size and every rate. This walks 4,000 pairs of the two.
   *
   * **It normally beats the maker by one wei, and that is not slack in the proof.** The maker's
   * half is `G − floor(G·r/W)`, which is `ceil(G·(W − r)/W)`. The first ceiling already pushed
   * `G` above the exact ratio, so the second one lands a wei above `N` unless the ratio divides
   * exactly. One wei of token B, in the maker's favour, at any size.
   */
  test('meets the maker at every size and every rate the contract accepts', () => {
    const next = walker(0x9e3779b97f4a7c15n)
    for (let k = 0; k < 4_000; k++) {
      // Nets from one wei to a hundred million ether, so six-decimal tokens and eighteen-decimal
      // ones are both in the walk.
      const net = (next() % (10n ** 26n)) + 1n
      // Rates from nothing to one wei under the whole fill, which is the widest band `_termsOk`
      // lets an intent sign.
      const rate = next() % MAX_FEE_RATE

      const i = offering(grossForNet(net, rate), rate)
      const gross = grossOut(i, i.amountIn, 0n)
      const delivered = gross - feeOn(gross, i)

      expect(delivered).toBeGreaterThanOrEqual(net)
      expect(delivered - net).toBeLessThanOrEqual(1n)
    }
  })

  test("lands exactly on the maker's number when the rate divides it", () => {
    // A rate of nothing needs no gross above the net at all.
    const free = offering(grossForNet(1_000n, 0n), 0n)
    expect(quote(free, free.amountIn, 0n).delivered).toBe(1_000n)

    // And one per cent of a round hundred is a round one.
    const round = offering(grossForNet(99n * 10n ** 18n, 10n ** 16n), 10n ** 16n)
    expect(quote(round, round.amountIn, 0n).delivered).toBe(99n * 10n ** 18n)
  })

  test('refuses a rate that takes the whole fill, and every rate above it', () => {
    expect(() => grossForNet(1_000n, MAX_FEE_RATE)).toThrow(RangeError)
    expect(() => grossForNet(1_000n, MAX_FEE_RATE + 1n)).toThrow(RangeError)
    expect(() => grossForNet(1_000n, -1n)).toThrow(RangeError)
    // One wei under is legal, and it is an enormous number rather than an error.
    expect(grossForNet(1n, MAX_FEE_RATE - 1n)).toBe(MAX_FEE_RATE)
  })
})

describe('the ceiling the contract now enforces', () => {
  test('is one hundred per cent, in the unit a rate is counted in', () => {
    expect(MAX_FEE_RATE).toBe(10n ** 18n)
  })

  /**
   * The rule exists because of this subtraction and nothing else.
   *
   * At exactly one WAD the destination takes the whole fill and the maker receives zero — absurd
   * terms, but terms that compute. Above it the fee is larger than the gross, `gross - fee`
   * underflows, and on chain that is a panic `skipInvalid` cannot step over. `_termsOk` refuses
   * the intent instead, which is why nothing in this package has to clamp.
   */
  test("is where the maker's half reaches zero and would go under it", () => {
    const i = offering(1_000n, MAX_FEE_RATE)
    const q = quote(i, i.amountIn, 0n)
    expect(q.owedToMaker).toBe(1_000n)
    expect(q.feeProceeds).toBe(1_000n)
    expect(q.delivered).toBe(0n)

    // One WAD above, which the contract refuses: the mirror would answer a negative delivery.
    const refused = offering(1_000n, MAX_FEE_RATE * 2n)
    expect(feeOn(1_000n, refused)).toBeGreaterThan(1_000n)
  })
})

describe('the split itself', () => {
  const RATES = [0n, 1n, 10n ** 14n, 25n * 10n ** 14n, 10n ** 16n, MAX_FEE_RATE / 2n, MAX_FEE_RATE]

  test('adds back up to the gross, exactly, at every rate and every take', () => {
    const next = walker(0x243f6a8885a308d3n)
    for (let k = 0; k < 2_000; k++) {
      const amountIn = (next() % (10n ** 24n)) + 1n
      const gross = (next() % (10n ** 24n)) + 1n
      const rate = RATES[Number(next() % BigInt(RATES.length))]
      const take = (next() % amountIn) + 1n

      const i = offering(gross, rate, amountIn)
      const q = quote(i, take, 0n)
      expect(q.delivered + q.feeProceeds).toBe(q.owedToMaker)
      expect(q.owedToMaker).toBe(grossOut(i, take, 0n))
      expect(q.feeProceeds).toBeLessThanOrEqual(q.owedToMaker)
    }
  })

  /**
   * The claim the whole change rests on: the filler's outlay does not depend on the rate.
   *
   * The rate used to sit on top of the delivery, so a dearer intent cost the filler more and the
   * solver had to carry the rate through every inequality it evaluated. The same take against the
   * same curve now costs the same at every rate, and the rate only decides how that one number is
   * divided.
   */
  test('costs the filler the same at every rate', () => {
    const take = 7n * 10n ** 17n
    const grosses = RATES.map((r) => quote(offering(10n ** 18n, r), take, 0n).owed)
    for (const g of grosses) expect(g).toBe(grosses[0])
  })

  test('leaves the dust with the maker, and pays no fee at all on a small enough fill', () => {
    // Ten basis points of 999 wei is 0.999 of a wei. The maker keeps all 999.
    const i = offering(999n, 10n ** 15n, 999n)
    const q = quote(i, 999n, 0n)
    expect(q.feeProceeds).toBe(0n)
    expect(q.delivered).toBe(999n)
  })
})

describe('fee terms the chain would refuse', () => {
  const config = hashFeeConfig(singleFeeConfig(DESTINATION))
  const terms = (o: Partial<typeof NO_FEE> = {}) => ({ ...NO_FEE, ...o })

  test('no config at every rate zero passes: it pays no fee', () => {
    expect(feeTermsFault(NO_FEE)).toBeNull()
    expect(() => assertFeeTerms(NO_FEE)).not.toThrow()
  })

  test('no config with a rate at any point is refused: a signed rate is never silently dropped', () => {
    for (const o of [{ feeRateIn: 1n }, { feeRate: 1n }, { feeRateProceeds: 1n }]) {
      const fault = feeTermsFault(terms(o))
      expect(fault?.reason).toBe('rate-without-config')
      expect(() => assertFeeTerms(terms(o))).toThrow(/feeConfig = 0 charges no fee/)
    }
  })

  test('any config passes at any rate up to one WAD, zero included: the chain cannot know a hash', () => {
    expect(feeTermsFault(terms({ feeConfig: config }))).toBeNull()
    expect(feeTermsFault(terms({ feeConfig: config, feeRate: MAX_FEE_RATE }))).toBeNull()
    expect(
      feeTermsFault(
        terms({ feeConfig: config, feeRateIn: 1n, feeRate: 2n, feeRateProceeds: MAX_FEE_RATE }),
      ),
    ).toBeNull()
  })

  test('a rate above one WAD is refused at each of the three points', () => {
    const over = MAX_FEE_RATE + 1n
    expect(feeTermsFault(terms({ feeConfig: config, feeRateIn: over }))).toEqual({
      reason: 'rate-above-wad',
      point: 'handover',
      rate: over,
    })
    expect(feeTermsFault(terms({ feeConfig: config, feeRate: over }))).toMatchObject({ point: 'output' })
    expect(feeTermsFault(terms({ feeConfig: config, feeRateProceeds: over }))).toMatchObject({
      point: 'proceeds',
    })
    expect(feeTermsMessage(feeTermsFault(terms({ feeConfig: config, feeRate: over }))!)).toMatch(/output rate/)
  })

  test('a zero config prices at zero, a named one at its signed rates', () => {
    expect(pricedFeeRates(terms({ feeConfig: ZERO_HASH, feeRate: 5n }))).toEqual({
      handover: 0n,
      output: 0n,
      proceeds: 0n,
    })
    expect(pricedFeeRates(terms({ feeConfig: config, feeRateIn: 1n, feeRate: 2n, feeRateProceeds: 3n }))).toEqual({
      handover: 1n,
      output: 2n,
      proceeds: 3n,
    })
  })

  test('the rate the solver bears is P1 plus P2, and P3 does not enter it', () => {
    const t = terms({ feeConfig: config, feeRateIn: 1n, feeRate: 2n, feeRateProceeds: 1000n })
    expect(solverBorneRate(t)).toBe(3n)
    expect(maxFeeRateFor([t as unknown as Intent, offering(10n, 7n)])).toBe(3n)
    expect(maxFeeRateFor([offering(10n, 7n)])).toBe(0n)
  })

  test('the defaults are signed as their config’s hash at their rates', () => {
    const def = defaultFees(369)
    const t = defaultFeeTerms(def)
    expect(t.feeConfig).toBe(hashFeeConfig(def.config))
    expect([t.feeRateIn, t.feeRate, t.feeRateProceeds]).toEqual([
      def.rates.handover,
      def.rates.output,
      def.rates.proceeds,
    ])
    expect(feeTermsFault(t)).toBeNull()
  })

  test('a rate above the defaults’ warn rate is named by point', () => {
    const warn = { handover: 10n, output: 10n, proceeds: 10n }
    expect(ratesAboveWarn(terms({ feeConfig: config, feeRate: 11n, feeRateProceeds: 10n }), warn)).toEqual(['output'])
    expect(ratesAboveWarn(terms({ feeConfig: config }), warn)).toEqual([])
    // A zero config is no fee, so there is nothing to warn about whatever it signed.
    expect(ratesAboveWarn(terms({ feeRate: 99n }), warn)).toEqual([])
  })

  test('the registry carries a destination for each chain and it is a valid config', () => {
    for (const id of [369, 943] as const) {
      const d = defaultFees(id)
      expect(d.config.destinations.length).toBeGreaterThan(0)
      expect(ZERO).not.toBe(d.config.destinations[0])
    }
  })
})

/**
 * The settlement's own `quote`, at the three take points, for 52 cases written by
 * `contracts/test/FeeFixture.t.sol`. CI regenerates the fixture and fails on a diff, so a change
 * to the contract's fee math turns this red until the SDK matches it.
 */
describe('the split the settlement computes', () => {
  const rows = Object.values(feeFixture.cases)

  test('the fixture has rows to check', () => {
    expect(rows.length).toBeGreaterThanOrEqual(48)
  })

  test.each(rows)('amountIn $amountIn, minOut $minOut, take $take, rates $rateIn/$rate/$rateProceeds', (row) => {
    const i: Intent = {
      ...offering(BigInt(row.minOut), 0n, BigInt(row.amountIn)),
      feeRateIn: BigInt(row.rateIn),
      feeRate: BigInt(row.rate),
      feeRateProceeds: BigInt(row.rateProceeds),
    }
    const q = quote(i, BigInt(row.take), 0n)
    expect({
      owedToMaker: q.owedToMaker,
      feeIn: q.feeIn,
      feeOut: q.feeOut,
      feeProceeds: q.feeProceeds,
      usable: q.usable,
      delivered: q.delivered,
      owed: q.owed,
    }).toEqual({
      owedToMaker: BigInt(row.owedToMaker),
      feeIn: BigInt(row.feeIn),
      feeOut: BigInt(row.feeOut),
      feeProceeds: BigInt(row.feeProceeds),
      usable: BigInt(row.usable),
      delivered: BigInt(row.delivered),
      owed: BigInt(row.owed),
    })
  })
})

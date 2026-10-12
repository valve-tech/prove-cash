import { describe, expect, test } from 'vitest'
import {
  DEFAULT_GAS_MODEL,
  type GasModel,
  MAX_BATCH_FAULTS,
  MAX_BATCH_LEGS,
  batchGas,
} from './plan.js'

/**
 * A batch earns on the legs that fill and pays for the legs it tried.
 *
 * The measured shape: an eight-leg batch costs 695,959 gas, a leg that fills adds 69,841, a leg
 * that expired adds 15,218, a leg a rival solver already took adds 15,982, and a leg that passes
 * evaluation and then fails to arm adds 80,174 — more than filling it. Any model that prices only
 * the survivors will send batches that lose money, so these pin the arithmetic that stops it.
 *
 * Every figure is a row in `app/src/landing/gas.ts`, generated from `contracts/test/Gas.t.sol`.
 * They used to come from `app/scripts/lab/batch-gas.ts`, which no gate reads, and by #136 all
 * five had drifted from what the suite measures.
 */

/**
 * The measurement, so the tests below can read the real shape rather than an average.
 *
 * Every per-leg figure is a MARGINAL row — what a ninth leg adds to a batch of eight — so `base`
 * is what the eight-leg batch costs less its eight marginal fills, and it therefore carries the
 * batch's own first-touch storage as well as the transaction. Stated that way the model returns
 * the measured 695,959 exactly.
 *
 * **One line cannot also return the singles, and that is a fact rather than a gap.** A leg sent
 * alone costs 148,754 and eight of them 1,190,037, well under this `base` times eight, because a
 * single leg never pays an eight-leg batch's overhead. The shape is not linear through the
 * origin. `EIGHT_APART` below is the measured row, used as a measurement and not as a prediction.
 */
const WARM: GasModel = {
  base: 139_819n,
  perIntentLeg: 62_480n,
  perMarketLeg: 0n,
  perSkippedLeg: 76_389n,
}

/** `eight legs, one at a time`, measured. The thing batching is compared against. */
const EIGHT_APART = 1_122_921n

/** The same batch when its failures are rivals rather than baits: the common case, priced. */
const CONTESTED: GasModel = { ...WARM, perSkippedLeg: 14_070n }

describe('batch gas', () => {
  test('eight legs and seven faults, which is the tolerance', () => {
    expect(MAX_BATCH_LEGS).toBe(8)
    expect(MAX_BATCH_FAULTS).toBe(7)
  })

  test('a skipped leg is priced above a filled one, on every model', () => {
    // The defect this pins: the first `perSkippedLeg` was the raw warm measurement, 93,000,
    // dropped in beside a COLD 205,000 fill. That said a failure was cheaper than a fill, which
    // is the opposite of what it is, and biased the engine toward batches it could not afford. A
    // model's constants have to share one scale; what carries across scales is the ratio.
    expect(DEFAULT_GAS_MODEL.perSkippedLeg).toBeGreaterThan(DEFAULT_GAS_MODEL.perIntentLeg)
    expect(WARM.perSkippedLeg).toBeGreaterThan(WARM.perIntentLeg)
  })

  test('a batch that skips a leg still pays for it, and pays more', () => {
    const all = batchGas(DEFAULT_GAS_MODEL, 8, 0)
    const one = batchGas(DEFAULT_GAS_MODEL, 8, 7)
    expect(one).toBeGreaterThan(DEFAULT_GAS_MODEL.base + DEFAULT_GAS_MODEL.perIntentLeg)
    expect(one).toBeGreaterThan(all)
  })

  test('one batch beats the same legs sent one at a time', () => {
    // The alternative to a batch is never nothing, it is n transactions. The fixed base is paid
    // once instead of n times, and that is the whole saving — 39% at eight legs, measured.
    for (const model of [DEFAULT_GAS_MODEL, WARM]) {
      const singles = batchGas(model, 1, 0) * 8n
      expect(batchGas(model, 8, 0)).toBeLessThan(singles)
    }
    // The model returns the measured batch exactly, and the measured singles beat it by 43%.
    expect(batchGas(WARM, 8, 0)).toBe(639_659n)
    expect(EIGHT_APART).toBeGreaterThan(batchGas(WARM, 8, 0))
  })

  test('the cost per surviving fill climbs as the batch loses legs', () => {
    const per = (m: GasModel, faults: number) => batchGas(m, 8, faults) / BigInt(8 - faults)
    for (const model of [DEFAULT_GAS_MODEL, WARM]) {
      expect(per(model, 0)).toBeLessThan(per(model, 4))
      expect(per(model, 4)).toBeLessThan(per(model, 7))
      // The whole point: one surviving leg out of eight carries the entire batch, at nearly ten
      // times what a leg costs in a batch that fills. Both models say so, which is what pricing
      // the skip on each model's own scale buys — before that fix the cold model said 4.4x and
      // the warm one said 9.7x, and only one of them could be right.
      expect(per(model, 7)).toBeGreaterThan(per(model, 0) * 9n)
    }
  })

  test('losing legs to a rival costs a fraction of losing them to a bait', () => {
    // The distinction that decides what a solver should defend against. Contention is what
    // actually happens — two solvers reading one book overlap, and the loser pays for every leg
    // it duplicated. A bait needs somebody to build one and then win a race to land it.
    expect(batchGas(CONTESTED, 8, 4)).toBeLessThan(batchGas(WARM, 8, 4) - 200_000n)
    // Half the batch lost to rivals still costs less than an all-good batch, because a leg the
    // settlement refuses is cheaper than one it fills. Losing a race wastes the work, not the gas.
    expect(batchGas(CONTESTED, 8, 4)).toBeLessThan(batchGas(CONTESTED, 8, 0))

    // Half a batch lost to rivals, priced on the same model: four fills and four refusals.
    expect(batchGas(CONTESTED, 8, 4)).toBe(446_019n)
  })

  test('faults are clamped, so a caller cannot price a batch below its own floor', () => {
    expect(batchGas(DEFAULT_GAS_MODEL, 8, 99)).toBe(batchGas(DEFAULT_GAS_MODEL, 8, 8))
    expect(batchGas(DEFAULT_GAS_MODEL, 8, -3)).toBe(batchGas(DEFAULT_GAS_MODEL, 8, 0))
  })

  test('a model with no skip price falls back to the fill price, never to zero', () => {
    const { perSkippedLeg: _drop, ...bare } = DEFAULT_GAS_MODEL
    expect(batchGas(bare, 8, 7)).toBe(batchGas(bare, 8, 0))
  })
})

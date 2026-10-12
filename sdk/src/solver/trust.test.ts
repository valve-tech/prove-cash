import { describe, expect, test } from 'vitest'
import type { Address, Hex } from 'viem'
import { CURVE_LINEAR, FLAG_PARTIAL, ZERO, type SignedIntent, ZERO_HASH } from '../intent.js'
import { entryOf } from './book.js'
import { DEFAULT_GAS_MODEL } from './plan.js'
import { type Leg, makeRing, type Ring } from './rings.js'
import { FILL_REASONS } from '../settlement.js'
import { MakerTrust, admits, faultsMaker, unprovenBudget, unprovenLegs } from './trust.js'

const A = '0x00000000000000000000000000000000000000aa' as Address
const B = '0x00000000000000000000000000000000000000bb' as Address
const T0 = 1_800_000_000n
const ONE = 1_000_000_000_000_000_000n

const maker = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address

let seq = 0
function intentOf(who: Address, tokenIn: Address, tokenOut: Address): SignedIntent {
  seq++
  return {
    maker: who,
    recipient: who,
    tokenIn,
    tokenOut,
    amountIn: ONE,
    minOutStart: ONE,
    minOutEnd: ONE,
    minFill: 0n,
    authNonce: `0x${'00'.repeat(32)}` as Hex,
    startTime: T0,
    endTime: T0 + 1800n,
    executor: ZERO,
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    flags: FLAG_PARTIAL,
    nonce: BigInt(seq),
    curve: CURVE_LINEAR,
    signature: `0x${'11'.repeat(65)}` as Hex,
  }
}

/** A two-leg ring between two makers, which is the smallest thing `admits` can judge. */
function ringOf(one: Address, two: Address): Ring {
  const ab = intentOf(one, A, B)
  const ba = intentOf(two, B, A)
  const legs: Leg[] = [
    { kind: 'intent', receives: A, pays: B, entry: entryOf(ab, ONE, `${one}:${ab.nonce}`) },
    { kind: 'intent', receives: B, pays: A, entry: entryOf(ba, ONE, `${two}:${ba.nonce}`) },
  ]
  return makeRing(legs) as Ring
}

describe('who is at fault for a stepped-over leg', () => {
  /**
   * The whole judgement, and the only place it is made. A solver asks the chain again after the
   * block and hands the answer here.
   */
  test('only a leg the chain still calls fillable is the maker\u2019s fault', () => {
    expect(faultsMaker('Ok')).toBe(true)
  })

  test.each(FILL_REASONS.filter((r) => r !== 'Ok'))('%s is the book moving, not the maker', (r) => {
    // Named one by one on purpose. A reason added to the enum lands here as a new case and has to
    // be thought about, rather than falling into whichever side the default happened to be.
    expect(faultsMaker(r)).toBe(false)
  })

  test('a maker whose legs the chain still calls fillable is dropped after three', () => {
    // The composition the solver bot relies on: the reason decides, the ledger counts.
    const trust = new MakerTrust()
    for (const reason of ['Ok', 'Ok', 'NothingToFill', 'Ok'] as const) {
      if (faultsMaker(reason)) trust.couldNotArm(maker(9), T0)
    }
    expect(trust.faults(maker(9), T0)).toBe(3)
    expect(trust.dropped(maker(9), T0)).toBe(true)
  })

  test('a maker every one of whose legs lost a race is never dropped', () => {
    const trust = new MakerTrust()
    for (const reason of ['NothingToFill', 'TooMuch', 'NonceTooLow', 'Expired'] as const) {
      if (faultsMaker(reason)) trust.couldNotArm(maker(8), T0)
    }
    expect(trust.faults(maker(8), T0)).toBe(0)
    expect(trust.dropped(maker(8), T0)).toBe(false)
  })
})

describe('maker trust', () => {
  test('a maker is unproven until a leg of theirs settles', () => {
    const t = new MakerTrust()
    expect(t.proven(maker(1))).toBe(false)
    t.settled(maker(1))
    expect(t.proven(maker(1))).toBe(true)
  })

  test('addresses match whatever their case', () => {
    const t = new MakerTrust()
    t.settled('0x00000000000000000000000000000000000000AA')
    expect(t.proven('0x00000000000000000000000000000000000000aa')).toBe(true)
  })

  test('three arming failures drop a maker, and a fill clears them', () => {
    const t = new MakerTrust()
    for (let k = 0; k < 3; k++) t.couldNotArm(maker(2), T0)
    expect(t.dropped(maker(2), T0)).toBe(true)
    t.settled(maker(2))
    expect(t.dropped(maker(2), T0)).toBe(false)
    expect(t.faults(maker(2), T0)).toBe(0)
  })

  test('failures are forgotten after an hour of quiet', () => {
    const t = new MakerTrust()
    for (let k = 0; k < 3; k++) t.couldNotArm(maker(3), T0)
    expect(t.dropped(maker(3), T0 + 3_599n)).toBe(true)
    expect(t.dropped(maker(3), T0 + 3_601n)).toBe(false)
    // And the next failure starts the count again from one rather than from three.
    t.couldNotArm(maker(3), T0 + 3_601n)
    expect(t.faults(maker(3), T0 + 3_601n)).toBe(1)
  })

  test('contention leaves no mark, because losing a race is not a maker s fault', () => {
    // The defect this pins. A leg a rival settled first comes back refused, exactly as a bait
    // does, and the ledger cannot tell them apart from the outside. If the bot recorded both, it
    // would drop the makers a competitor also wanted — the best offers on the book — and the
    // tests would all still pass. So the only way in is `couldNotArm`, and the bot must call it
    // for that reason alone. A maker whose legs keep being taken stays exactly where they were.
    // Twenty lost races look like this: nothing is called, because there is nothing to record.
    const t = new MakerTrust()
    t.settled(maker(4))
    expect(t.proven(maker(4))).toBe(true)
    expect(t.dropped(maker(4), T0)).toBe(false)
    expect(t.record(maker(4)).failed).toBe(0)
  })

  test('the ledger survives a restart', () => {
    const t = new MakerTrust()
    t.settled(maker(5))
    t.couldNotArm(maker(6), T0)
    const back = MakerTrust.from(JSON.parse(JSON.stringify(t.toJSON())))
    expect(back.proven(maker(5))).toBe(true)
    expect(back.faults(maker(6), T0)).toBe(1)
    expect(back.record(maker(6)).lastFailAt).toBe(T0)
  })
})

describe('the unproven budget', () => {
  test('a named loss becomes a leg count', () => {
    // 260,000 gas a failure at 1 gwei is 0.00026 PLS. A tenth of a PLS buys many more than eight,
    // so the batch size caps it; a thousandth buys three.
    const gasPrice = 1_000_000_000n
    expect(unprovenBudget({ maxGriefNative: ONE / 10n, gasPrice })).toBe(8)
    expect(unprovenBudget({ maxGriefNative: ONE / 1_000n, gasPrice })).toBe(3)
    expect(unprovenBudget({ maxGriefNative: 0n, gasPrice })).toBe(0)
  })

  test('it falls as gas gets dearer, which is when it should', () => {
    const cheap = unprovenBudget({ maxGriefNative: ONE / 1_000n, gasPrice: 1_000_000_000n })
    const dear = unprovenBudget({ maxGriefNative: ONE / 1_000n, gasPrice: 4_000_000_000n })
    expect(dear).toBeLessThan(cheap)
  })

  test('free gas means the batch size is the only limit', () => {
    expect(unprovenBudget({ maxGriefNative: 0n, gasPrice: 0n })).toBe(8)
  })

  test('it prices with the model it is given', () => {
    const gasPrice = 1_000_000_000n
    const maxGriefNative = ONE / 1_000n
    const contested = { ...DEFAULT_GAS_MODEL, perSkippedLeg: 43_000n }
    // A cheap failure buys more room than a dear one, from the same loss.
    expect(unprovenBudget({ maxGriefNative, gasPrice, gasModel: contested })).toBeGreaterThan(
      unprovenBudget({ maxGriefNative, gasPrice }),
    )
  })
})

describe('admitting a ring', () => {
  test('an unproven maker is counted, a proven one is not', () => {
    const t = new MakerTrust()
    t.settled(maker(7))
    const ring = ringOf(maker(7), maker(8))
    expect(unprovenLegs(ring, t)).toEqual([maker(8)])
    expect(admits(ring, t, T0, 1)).toBe(true)
    expect(admits(ring, t, T0, 0)).toBe(false)
  })

  test('an atomic ring takes one unproven leg, not two', () => {
    const t = new MakerTrust()
    const limit = t.policy.maxUnprovenPerRing
    expect(limit).toBe(1)
    // One bad leg reverts the whole ring, so the limit here is not the batch budget. Two makers
    // this solver has never settled with is one too many.
    expect(admits(ringOf(maker(9), maker(10)), t, T0, limit)).toBe(false)
    // Prove either one and the ring is inside the limit.
    t.settled(maker(9))
    expect(admits(ringOf(maker(9), maker(10)), t, T0, limit)).toBe(true)
  })

  test('a dropped maker is refused however large the budget', () => {
    const t = new MakerTrust()
    t.settled(maker(11))
    t.settled(maker(12))
    for (let k = 0; k < 3; k++) t.couldNotArm(maker(12), T0)
    expect(admits(ringOf(maker(11), maker(12)), t, T0, 99)).toBe(false)
    // And is planned around again once the failures are forgotten.
    expect(admits(ringOf(maker(11), maker(12)), t, T0 + 3_601n, 99)).toBe(true)
  })

  test('a pool leg has no maker and is always admitted', () => {
    const t = new MakerTrust()
    const ring = ringOf(maker(13), maker(14))
    expect(unprovenLegs(ring, t)).toHaveLength(2)
    expect(admits(ring, t, T0, 2)).toBe(true)
  })
})

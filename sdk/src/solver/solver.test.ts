import { hashFeeConfig, singleFeeConfig } from '../feeconfig.js'
import { describe, expect, test } from 'vitest'
import { encodeAbiParameters, encodeEventTopics, type Address, type Hex, type Log } from 'viem'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  KIND_STRETCH,
  ZERO,
  ZERO_HASH,
  breakpointsOf,
  intentHashOf,
  stretchCurve,
  type SignedIntent,
} from '../intent.js'
import { quote } from '../settlement.js'
import { SOLVER_SETTLEMENT_ABI } from './abi.js'
import { buildBook, entryOf, pairKey, type BookEntry } from './book.js'
import { DEFAULT_MAX_PER_PAIR, DEPTH_943, depthFor, presetDepth, type PairDepth } from './depth.js'
import {
  ensureApprovals,
  executeRing,
  makersShortChanged,
  deliveredFromLogs,
  requiredApprovals,
  type ExecuteOptions,
} from './execute.js'
import {
  DEFAULT_GAS_MODEL,
  batchNetClears,
  netClears,
  planOf,
  profitableFrom,
  ringDeadline,
  selectDisjoint,
  solve,
  upcoming,
  type SolveParams,
} from './plan.js'
import {
  PULSEX_FEE_DEN,
  PULSEX_FEE_NUM,
  poolAmountIn,
  poolAmountOut,
  poolKey,
  type Pool,
  type PriceBook,
} from './price.js'
import { findRings, makeRing, ringCondition, type Leg, type Ring } from './rings.js'
import { sizeRing } from './size.js'
import { xykMarkets } from './market.js'

/**
 * The engine is a pure function, so every case that matters is a unit test. A ring that only
 * closes after ten minutes of Dutch decay, a ring that integer rounding kills, a ring with one
 * all-or-nothing leg: none of them need a chain, and none of them are reachable by waiting for
 * the right two strangers to post.
 */

// A router for the market fixtures. These tests never send, so it only has to be the address
// the swap names — a market carries the venue that priced it, so `xykMarkets` needs one.
const POOL_ROUTER = '0x00000000000000000000000000000000000000f0' as Address
const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN_B = '0x00000000000000000000000000000000000000bb' as Address
const TOKEN_C = '0x00000000000000000000000000000000000000cc' as Address
const WPLS = '0x000000000000000000000000000000000000w0ls'.replace('w0ls', '0f15') as Address
const EXECUTOR = '0x00000000000000000000000000000000000000e0' as Address

const T0 = 1_800_000_000n
const ONE = 1_000_000_000_000_000_000n

/**
 * The rate every fixture intent signs, and the destination it pays.
 *
 * Five basis points, which is what the deployed floor used to charge before the floor existed.
 * It is a property of these intents and not of any deployment: the settlement holds no rate, so
 * a solver test that read one off a constant would be testing the constant.
 */
const RATE = 500_000_000_000_000n
const FEE_TO = hashFeeConfig(singleFeeConfig('0x00000000000000000000000000000000000000fe'))

let seq = 0

/** A signed intent with a distinct maker, so the book keys them apart. */
function intentOf(o: {
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  minOutStart: bigint
  minOutEnd?: bigint
  start?: bigint
  end?: bigint
  partial?: boolean
  /** The rate this intent asks for. Every leg charges its own; there is no other source. */
  feeRate?: bigint
  /** A P2 (output) rate, charged on top of the maker's number. The solver bears it. */
  output?: bigint
  /** A P1 (handover) rate, kept out of what the maker hands the executor. The solver bears it. */
  handover?: bigint
  /** The floor under any fill that does not close the offer out. */
  minFill?: bigint
  /**
   * The shape of the decay. Naming one names `KIND_STRETCH` with it, because a word without the
   * kind bits is a word nothing reads.
   */
  curve?: Hex
}): SignedIntent {
  seq++
  const maker = `0x${seq.toString(16).padStart(40, '0')}` as Address
  return {
    maker,
    recipient: maker,
    tokenIn: o.tokenIn,
    tokenOut: o.tokenOut,
    amountIn: o.amountIn,
    minOutStart: o.minOutStart,
    minOutEnd: o.minOutEnd ?? o.minOutStart,
    startTime: o.start ?? T0,
    endTime: o.end ?? T0 + 3600n,
    executor: ZERO,
    // A destination, because a rate with none charges nothing and every ring here has to pay.
    feeConfig: FEE_TO,
    feeRateIn: o.handover ?? 0n,
    feeRateProceeds: o.feeRate ?? RATE,
    feeRate: o.output ?? 0n,
    minFill: o.minFill ?? 0n,
    authNonce: ZERO_HASH,
    flags: (o.partial === false ? 0 : FLAG_PARTIAL) | (o.curve ? KIND_STRETCH : 0),
    nonce: BigInt(seq),
    curve: o.curve ?? CURVE_LINEAR,
    signature: `0x${'11'.repeat(65)}` as Hex,
  }
}

/** An entry with the whole intent still available, unless a remaining amount is given. */
const entry = (i: SignedIntent, remaining = i.amountIn): BookEntry =>
  entryOf(i, remaining, `${i.maker}:${i.nonce}`)

const book = (entries: BookEntry[]) => buildBook(entries, 369)

/** Everything priced one to one against WPLS, so gas and surplus share a unit. */
const flatPrices = (tokens: readonly Address[]): PriceBook => ({
  wpls: WPLS,
  rates: new Map(tokens.map((t) => [t.toLowerCase(), { num: 1n, den: 1n }])),
})

const params = (o: Partial<SolveParams> = {}): SolveParams => ({
  at: T0,
  executor: EXECUTOR,
  gasPrice: 0n,
  ...o,
})

/**
 * The largest `minOut` on both legs of a symmetric two-ring that still satisfies the condition.
 *
 * Par, and the argument is one line: the condition is `Π r_k ≤ 1`, so on a symmetric ring
 * `m² ≤ amountIn²`. It used to be `amountIn · den / (den + num)` — five basis points under par
 * a leg — because the executor paid the fee on top of each delivery. The fee comes out of the
 * maker's own number now, so it is not in the executor's arithmetic and the boundary sits at par.
 */
function boundaryMinOut(amountIn: bigint): bigint {
  return amountIn
}

// ── The ring condition ────────────────────────────────────────────────────────

describe('the ring condition', () => {
  const twoRing = (
    m1: bigint,
    m2: bigint,
    amountIn = ONE,
    feeRate = RATE,
    free = false,
  ): Ring => {
    const mk = (tokenIn: Address, tokenOut: Address, minOutStart: bigint) => {
      const i = intentOf({ tokenIn, tokenOut, amountIn, minOutStart, feeRate })
      return entry(free ? { ...i, feeConfig: ZERO_HASH, feeRate: 0n } : i)
    }
    const legs: Leg[] = [
      { kind: 'intent', receives: TOKEN_A, pays: TOKEN_B, entry: mk(TOKEN_A, TOKEN_B, m1) },
      { kind: 'intent', receives: TOKEN_B, pays: TOKEN_A, entry: mk(TOKEN_B, TOKEN_A, m2) },
    ]
    return makeRing(legs)!
  }

  /**
   * The whole of Part 2, in one assertion.
   *
   * The condition used to carry a `(1 + φ)` factor for every intent leg, so the answer moved
   * with the rates the makers had signed. The executor pays the gross now and the settlement
   * splits it, so the rate is not in the executor's arithmetic at all. Every rate the contract
   * accepts — nothing, the fixture's five basis points, and the whole fill — has to give the
   * same answer on the same ring, at both sides of the boundary.
   */
  test('the answer does not move with the rate, at any rate the contract accepts', () => {
    const WAD = 10n ** 18n
    for (const rate of [0n, RATE, 5_000_000_000_000_000n, WAD / 2n, WAD]) {
      expect(ringCondition(twoRing(ONE, ONE, ONE, rate), T0)).toBe(true)
      expect(ringCondition(twoRing(ONE + 1n, ONE, ONE, rate), T0)).toBe(false)
    }
  })

  test('a two-ring closes exactly at par and misses it by one wei', () => {
    // The second maker asks exactly par, so the boundary falls on a single integer and one wei
    // either side of it is a real answer rather than a truncation.
    expect(ringCondition(twoRing(ONE, ONE), T0)).toBe(true)
    expect(ringCondition(twoRing(ONE + 1n, ONE), T0)).toBe(false)
  })

  test('the two makers together have to concede nothing at all', () => {
    const m = boundaryMinOut(ONE)
    expect(m).toBe(ONE)
    expect(ringCondition(twoRing(m, m), T0)).toBe(true)
    expect(ringCondition(twoRing(m + 1n, m + 1n), T0)).toBe(false)
  })

  /**
   * A dearer leg used to close the window on a ring the cheap legs would have cleared, because
   * the executor paid every leg's rate. It buys the destination more of the maker's money now,
   * and costs the executor nothing, so the window does not move.
   */
  test('a dearer leg does not close the window', () => {
    const m = boundaryMinOut(ONE)
    expect(ringCondition(twoRing(m, m), T0)).toBe(true)
    expect(ringCondition(twoRing(m, m, ONE, 5_000_000_000_000_000n), T0)).toBe(true)
  })

  test('a leg that names no destination does not widen it either', () => {
    const m = boundaryMinOut(ONE)
    expect(ringCondition(twoRing(m + 1n, m + 1n), T0)).toBe(false)
    expect(ringCondition(twoRing(m + 1n, m + 1n, ONE, RATE, true), T0)).toBe(false)
  })

  test('a ring that does not close is not a ring', () => {
    expect(ringCondition(twoRing(ONE + 1n, ONE + 1n), T0)).toBe(false)
  })
})

// ── Two-leg rings ─────────────────────────────────────────────────────────────

describe('a two-leg ring', () => {
  const spread = (bps: bigint) => (ONE * (10_000n - bps)) / 10_000n

  test('is found, sized and priced', () => {
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: spread(20n) })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: spread(20n) })
    const plans = solve(book([entry(a), entry(b)]), params())

    expect(plans.length).toBeGreaterThan(0)
    const plan = plans[0]
    expect(plan.fills).toHaveLength(2)
    expect(plan.atomic).toBe(true)
    expect(plan.profit).toBeGreaterThan(0n)
    // The fixture's rate is P3, which comes out of the makers' own proceeds: the solver bears none.
    expect(plan.maxFeeRate).toBe(0n)

    // Both makers are paid at least the rate they signed, at the size the plan takes.
    for (const leg of plan.sized.legs) {
      if (leg.leg.kind !== 'intent') continue
      const q = quote(leg.leg.entry.intent, leg.take, T0)
      expect(leg.delivered).toBe(q.delivered)
      expect(leg.pay).toBe(q.gross)
    }
  })

  test('every leg stays inside what is left of its intent', () => {
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: spread(30n) })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: spread(30n) })
    const plans = solve(book([entry(a), entry(b)]), params())
    for (const leg of plans[0].sized.legs) {
      if (leg.leg.kind !== 'intent') continue
      expect(leg.take).toBeLessThanOrEqual(leg.leg.entry.remaining)
    }
  })

  test('the chain balances: what one leg pays, the next leg hands back', () => {
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: spread(40n) })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: spread(40n) })
    const { sized } = solve(book([entry(a), entry(b)]), params())[0]
    for (let k = 0; k < sized.legs.length; k++) {
      const next = sized.legs[(k + 1) % sized.legs.length]
      if (k === sized.legs.length - 1) {
        // The last payment is what the first receipt has to cover.
        expect(sized.entryTake - sized.legs[k].pay).toBe(sized.profit)
      } else {
        expect(next.take).toBe(sized.legs[k].pay)
      }
    }
  })

  test('the working capital is every payment but the last', () => {
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: spread(40n) })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: spread(40n) })
    const { sized } = solve(book([entry(a), entry(b)]), params())[0]
    expect(sized.capital).toHaveLength(1)
    expect(sized.capital[0].token).toBe(TOKEN_B)
    expect(sized.capital[0].amount).toBe(sized.legs[0].pay)
  })

  test('rounding kills a ring that rational arithmetic says clears', () => {
    // Three wei through a ring that concedes ten basis points a leg, because only three wei are
    // left of the first offer. In fractions the ring clears by six thousandths of a wei; in
    // integers each leg's gross rounds 2.997 up to three, so the three that came in is the three
    // that goes out. The fee is not in this any more — it comes out of the maker's gross — so
    // what is left is `_ceilDiv` alone, and `_ceilDiv` alone is enough.
    const tiny = 10_000n
    const m = 9_990n
    const dust = 3n
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: tiny, minOutStart: m })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: tiny, minOutStart: m })
    const legs: Leg[] = [
      { kind: 'intent', receives: TOKEN_A, pays: TOKEN_B, entry: entry(a, dust) },
      { kind: 'intent', receives: TOKEN_B, pays: TOKEN_A, entry: entry(b) },
    ]
    const ring = makeRing(legs)!

    expect(ringCondition(ring, T0)).toBe(true)
    const sized = sizeRing(ring, T0)
    expect(sized.ok).toBe(false)
    if (!sized.ok) expect(sized.reason).toBe('unprofitable')
    expect(solve(book([entry(a, dust), entry(b)]), params())).toHaveLength(0)
  })

  test('the same ring at a size where the rounding no longer matters does clear', () => {
    const m = boundaryMinOut(ONE) - ONE / 100_000n
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: m })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: m })
    const plans = solve(book([entry(a), entry(b)]), params())
    expect(plans.length).toBeGreaterThan(0)
    expect(plans[0].profit).toBeGreaterThan(0n)
  })
})

// ── Three-leg rings ───────────────────────────────────────────────────────────

describe('a three-leg ring', () => {
  const leg30 = (tokenIn: Address, tokenOut: Address) =>
    intentOf({ tokenIn, tokenOut, amountIn: ONE, minOutStart: (ONE * 9_970n) / 10_000n })

  test('closes through three tokens none of which pair directly', () => {
    const ab = leg30(TOKEN_A, TOKEN_B)
    const bc = leg30(TOKEN_B, TOKEN_C)
    const ca = leg30(TOKEN_C, TOKEN_A)
    const plans = solve(book([entry(ab), entry(bc), entry(ca)]), params())

    expect(plans.length).toBeGreaterThan(0)
    const plan = plans[0]
    expect(plan.fills).toHaveLength(3)
    expect(plan.profit).toBeGreaterThan(0n)
    // Three tokens, each received once and paid once.
    const received = plan.sized.legs.map((l) => l.leg.receives)
    expect(new Set(received).size).toBe(3)
  })

  test('needs two payments of working capital, not three', () => {
    const plans = solve(
      book([entry(leg30(TOKEN_A, TOKEN_B)), entry(leg30(TOKEN_B, TOKEN_C)), entry(leg30(TOKEN_C, TOKEN_A))]),
      params(),
    )
    expect(plans[0].sized.capital).toHaveLength(2)
  })

  test('every rotation is offered, and each banks its surplus elsewhere', () => {
    const plans = solve(
      book([entry(leg30(TOKEN_A, TOKEN_B)), entry(leg30(TOKEN_B, TOKEN_C)), entry(leg30(TOKEN_C, TOKEN_A))]),
      params(),
    )
    expect(new Set(plans.map((p) => p.profitToken.toLowerCase())).size).toBe(3)
  })

  test('two legs alone are not a ring', () => {
    const plans = solve(book([entry(leg30(TOKEN_A, TOKEN_B)), entry(leg30(TOKEN_B, TOKEN_C))]), params())
    expect(plans).toHaveLength(0)
  })
})

// ── Per-token depth ───────────────────────────────────────────────────────────

describe('how deep a direction indexes', () => {
  const TOKEN_D = '0x00000000000000000000000000000000000000dd' as Address

  /** A rate every ring condition clears, so only the number of entries kept can change a count. */
  const leg = (tokenIn: Address, tokenOut: Address) =>
    entry(intentOf({ tokenIn, tokenOut, amountIn: ONE, minOutStart: (ONE * 9_900n) / 10_000n }))

  /**
   * Two pairs that never meet: A↔B and C↔D. Three competing offers one way on each pair, one
   * offer back. No three tokens pair up, so every ring here has two legs and the ring count on a
   * pair is twice the entries kept on its busy direction.
   */
  const twoPairs = () =>
    book([
      leg(TOKEN_A, TOKEN_B),
      leg(TOKEN_A, TOKEN_B),
      leg(TOKEN_A, TOKEN_B),
      leg(TOKEN_B, TOKEN_A),
      leg(TOKEN_C, TOKEN_D),
      leg(TOKEN_C, TOKEN_D),
      leg(TOKEN_D, TOKEN_C),
      leg(TOKEN_D, TOKEN_C),
      leg(TOKEN_D, TOKEN_C),
    ])

  const touching = (rings: readonly Ring[], token: Address) =>
    rings.filter((r) => r.legs.some((l) => l.receives.toLowerCase() === token.toLowerCase())).length

  const table = (byToken: Record<string, number>, fallback?: number): PairDepth => ({
    byToken: new Map(Object.entries(byToken).map(([t, d]) => [t.toLowerCase(), d])),
    default: fallback,
  })

  test('a token given a high limit keeps more entries than one given a low limit', () => {
    const b = twoPairs()
    const rings = findRings(b, T0, { maxPerPair: table({ [TOKEN_A]: 3 }, 1) })

    // A is the hub here, so A↔B indexes three deep and gives three rings each way.
    expect(touching(rings, TOKEN_A)).toBe(6)
    // C and D take the table's default of one, so their pair gives one ring each way.
    expect(touching(rings, TOKEN_C)).toBe(2)
  })

  test('the larger of a direction two tokens governs it', () => {
    // B asks for one entry and A asks for three. The direction indexes three deep either way.
    const rings = findRings(twoPairs(), T0, { maxPerPair: table({ [TOKEN_A]: 3, [TOKEN_B]: 1 }, 1) })
    expect(touching(rings, TOKEN_A)).toBe(6)
  })

  test('a depth of zero drops the direction and finds nothing there', () => {
    const rings = findRings(twoPairs(), T0, { maxPerPair: table({ [TOKEN_A]: 3 }, 0) })
    expect(touching(rings, TOKEN_A)).toBe(6)
    expect(touching(rings, TOKEN_C)).toBe(0)
  })

  test('one limit for every token enumerates exactly what a plain number does', () => {
    const b = twoPairs()
    const plain = findRings(b, T0, { maxPerPair: 3 }).map((r) => r.id)
    const byDefault = findRings(b, T0, { maxPerPair: { default: 3 } }).map((r) => r.id)
    const named = findRings(b, T0, {
      maxPerPair: table({ [TOKEN_A]: 3, [TOKEN_B]: 3, [TOKEN_C]: 3, [TOKEN_D]: 3 }, 3),
    }).map((r) => r.id)

    expect(plain.length).toBeGreaterThan(0)
    expect(byDefault).toEqual(plain)
    expect(named).toEqual(plain)
  })

  test('the fallback chain runs per token, then the table, then the global default', () => {
    const t = table({ [TOKEN_A]: 5 }, 2)
    // A is named, so its entry wins over the table's default.
    expect(depthFor(t, TOKEN_A, TOKEN_B)).toBe(5)
    // Neither is named, so the table's default wins over the global one.
    expect(depthFor(t, TOKEN_B, TOKEN_C)).toBe(2)
    expect(DEFAULT_MAX_PER_PAIR).not.toBe(2)
    // The table sets no default, so the global one answers.
    expect(depthFor(table({ [TOKEN_A]: 5 }), TOKEN_B, TOKEN_C)).toBe(DEFAULT_MAX_PER_PAIR)
    // No table at all.
    expect(depthFor(undefined, TOKEN_B, TOKEN_C)).toBe(DEFAULT_MAX_PER_PAIR)
    // A plain number answers for every direction.
    expect(depthFor(4, TOKEN_A, TOKEN_B)).toBe(4)
  })

  test('a token address in any case resolves to the same depth', () => {
    const t = table({ [TOKEN_A]: 5 }, 2)
    expect(depthFor(t, TOKEN_A.toUpperCase(), TOKEN_B)).toBe(5)
  })

  test('a negative limit keeps nothing, rather than dropping the last entry', () => {
    // `slice(0, -1)` would silently keep all but one, which is the opposite of what -1 asks for.
    expect(depthFor(-1, TOKEN_A, TOKEN_B)).toBe(0)
    expect(depthFor(table({ [TOKEN_A]: -1 }, -1), TOKEN_A, TOKEN_B)).toBe(0)
  })

  test('chain 943 names every preset token the table means to name', () => {
    // The table is built from preset symbols, so a rename would drop an entry in silence.
    expect(DEPTH_943.byToken?.size).toBe(7)
    expect(DEPTH_943.default).toBe(2)
    expect(presetDepth(943)).toBe(DEPTH_943)
    // Mainnet has no settlement contract, so it has no book to ration.
    expect(presetDepth(369)).toBeUndefined()
  })
})

// ── All-or-nothing legs ───────────────────────────────────────────────────────

describe('an all-or-nothing leg', () => {
  test('pins the ring to its own remaining amount', () => {
    const partial = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE * 10n,
      minOutStart: (ONE * 10n * 9_950n) / 10_000n,
    })
    const pinned = intentOf({
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: ONE,
      minOutStart: (ONE * 9_950n) / 10_000n,
      partial: false,
    })
    const plans = solve(book([entry(partial), entry(pinned)]), params())
    expect(plans.length).toBeGreaterThan(0)

    // Whichever rotation wins, the pinned leg takes exactly what is left of it and no less.
    for (const plan of plans) {
      const leg = plan.sized.legs.find(
        (l) => l.leg.kind === 'intent' && l.leg.entry.intent.maker === pinned.maker,
      )
      expect(leg?.take).toBe(ONE)
    }
  })

  test('a partly filled all-or-nothing leg pins to what is left, not to its size', () => {
    const partial = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE * 10n,
      minOutStart: (ONE * 10n * 9_950n) / 10_000n,
    })
    const pinned = intentOf({
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: ONE * 4n,
      minOutStart: (ONE * 4n * 9_950n) / 10_000n,
      partial: false,
    })
    const left = ONE * 3n
    const plans = solve(book([entry(partial), entry(pinned, left)]), params())
    expect(plans.length).toBeGreaterThan(0)
    for (const plan of plans) {
      const leg = plan.sized.legs.find(
        (l) => l.leg.kind === 'intent' && l.leg.entry.intent.maker === pinned.maker,
      )
      expect(leg?.take).toBe(left)
    }
  })

  test('two of them almost never agree', () => {
    const one = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE,
      minOutStart: (ONE * 9_950n) / 10_000n,
      partial: false,
    })
    const other = intentOf({
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: ONE * 7n,
      minOutStart: (ONE * 7n * 9_950n) / 10_000n,
      partial: false,
    })
    const legs: Leg[] = [
      { kind: 'intent', receives: TOKEN_A, pays: TOKEN_B, entry: entry(one) },
      { kind: 'intent', receives: TOKEN_B, pays: TOKEN_A, entry: entry(other) },
    ]
    const ring = makeRing(legs)!
    expect(ringCondition(ring, T0)).toBe(true)

    const sized = sizeRing(ring, T0)
    expect(sized.ok).toBe(false)
    if (!sized.ok) expect(sized.reason).toBe('pinned-conflict')
    expect(solve(book([entry(one), entry(other)]), params())).toHaveLength(0)
  })

  test('two of them that do agree still settle', () => {
    // Hand-built so the second leg's remaining amount is exactly what the first leg pays.
    const first = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE,
      minOutStart: (ONE * 9_900n) / 10_000n,
      partial: false,
    })
    const pay = quote(first, ONE, T0).gross
    const second = intentOf({
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: pay,
      minOutStart: (pay * 9_900n) / 10_000n,
      partial: false,
    })
    const plans = solve(book([entry(first), entry(second)]), params())
    expect(plans.length).toBeGreaterThan(0)
    expect(plans[0].sized.legs[0].take).toBe(ONE)
    expect(plans[0].sized.legs[1].take).toBe(pay)
  })
})

// ── Partly filled intents ─────────────────────────────────────────────────────

describe('sizing against partly filled intents', () => {
  test('the rate stays the whole intent’s rate, and the take respects the remainder', () => {
    const big = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE * 10n,
      minOutStart: (ONE * 10n * 9_960n) / 10_000n,
    })
    const small = intentOf({
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: ONE * 10n,
      minOutStart: (ONE * 10n * 9_960n) / 10_000n,
    })
    const left = ONE * 2n
    const plans = solve(book([entry(big, left), entry(small)]), params())
    expect(plans.length).toBeGreaterThan(0)

    const plan = plans.find((p) => p.sized.legs[0].leg.kind === 'intent' && p.sized.legs[0].leg.entry.intent.maker === big.maker)!
    expect(plan.sized.entryTake).toBeLessThanOrEqual(left)
    // The signed rate is per `amountIn`, so a partial take is quoted against the whole intent.
    expect(plan.sized.legs[0].delivered).toBe(quote(big, plan.sized.entryTake, T0).delivered)
  })

  test('an exhausted intent is not in the book at all', () => {
    const spent = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: ONE / 2n })
    const other = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: ONE / 2n })
    const b = book([entry(spent, 0n), entry(other)])
    expect(b.entries).toHaveLength(1)
    expect(b.byPair.get(pairKey(TOKEN_A, TOKEN_B))).toBeUndefined()
  })
})

// ── Time ──────────────────────────────────────────────────────────────────────

describe('a ring that only the Dutch decay opens', () => {
  /** One decaying intent against one static one, priced so the pair misses by a wide margin. */
  const decaying = () => {
    const falling = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE,
      minOutStart: ONE,
      minOutEnd: (ONE * 9_900n) / 10_000n,
      start: T0,
      end: T0 + 600n,
    })
    const flat = intentOf({
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: ONE,
      minOutStart: (ONE * 10_050n) / 10_000n,
      start: T0,
      end: T0 + 600n,
    })
    return { falling, flat, entries: [entry(falling), entry(flat)] }
  }

  test('is not there now', () => {
    expect(solve(book(decaying().entries), params())).toHaveLength(0)
  })

  test('the engine says the second it opens, and it is right', () => {
    const { entries } = decaying()
    const b = book(entries)
    const p = params()
    const ring = findRings(b, T0 + 599n, {})[0]
    expect(ring).toBeDefined()

    const predicted = profitableFrom(ring, p)
    expect(predicted).not.toBeNull()

    // The claim, checked the slow way: no earlier second pays, and this one does.
    let firstBySearch: bigint | null = null
    for (let t = T0; t <= T0 + 600n; t++) {
      const sized = sizeRing(ring, t)
      if (sized.ok && planOf(sized.sized, { ...p, at: t }) !== null) {
        firstBySearch = t
        break
      }
    }
    expect(predicted).toBe(firstBySearch)
    // 299 seconds in, and the arithmetic is one line. The static leg asks 1.005, so the falling
    // leg has to reach 1 / 1.005 = 0.995025 of par, and it falls one per cent over 600 seconds:
    // 1 - t / 60000 <= 0.995025 gives t >= 299. It used to be later, because the condition also
    // had to clear five basis points of fee on each of the two legs. The executor pays neither
    // now — the fee comes out of each maker's own gross — so the ring opens sooner.
    expect(predicted! - T0).toBe(299n)
    expect(predicted! - T0).toBeLessThan(600n)
  })

  test('solving at that second finds the ring, and one second earlier does not', () => {
    const { entries } = decaying()
    const b = book(entries)
    const at = profitableFrom(findRings(b, T0 + 599n, {})[0], params())!
    expect(solve(b, params({ at })).length).toBeGreaterThan(0)
    expect(solve(b, params({ at: at - 1n }))).toHaveLength(0)
  })

  test('the upcoming list carries it with the same timestamp', () => {
    const { entries } = decaying()
    const b = book(entries)
    // 599, not 600. `upcoming` looks for cycles at the end of its horizon, and both legs end at
    // T0 + 600, where the chain answers `Expired`. A horizon that ends on that second finds no leg.
    const soon = upcoming(b, params(), 599n)
    expect(soon.length).toBeGreaterThan(0)
    expect(soon[0].at).toBe(profitableFrom(soon[0].ring, params()))
  })

  test('a ring that expires before it opens is never offered', () => {
    const falling = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE,
      minOutStart: ONE,
      minOutEnd: (ONE * 9_999n) / 10_000n,
      start: T0,
      end: T0 + 600n,
    })
    const flat = intentOf({
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: ONE,
      minOutStart: (ONE * 10_500n) / 10_000n,
      start: T0,
      end: T0 + 600n,
    })
    const b = book([entry(falling), entry(flat)])
    expect(upcoming(b, params(), 600n)).toHaveLength(0)
  })

  /**
   * The same ring, with the fall packed into the second half of the window.
   *
   * A stretch is where the search stops being able to assume one shape. The predicate is flat,
   * then falling, then flat, and the seconds the search steps over are no longer all alike.
   */
  const stretched = (curve: Hex) => {
    const falling = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE,
      minOutStart: ONE,
      minOutEnd: (ONE * 9_900n) / 10_000n,
      start: T0,
      end: T0 + 600n,
      curve,
    })
    const flat = intentOf({
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: ONE,
      minOutStart: (ONE * 10_050n) / 10_000n,
      start: T0,
      end: T0 + 600n,
    })
    return { falling, flat, entries: [entry(falling), entry(flat)] }
  }

  /** The seconds a search priced, in the order it priced them. */
  const probesFor = (ring: Ring, p: SolveParams): bigint[] => {
    const seen: bigint[] = []
    profitableFrom(ring, p, { onProbe: (at) => seen.push(at) })
    return seen
  }

  /** The first second that pays, found by asking every second in turn. */
  const scanFrom = (ring: Ring, p: SolveParams, until: bigint): bigint | null => {
    for (let t = p.at; t <= until; t++) {
      const sized = sizeRing(ring, t)
      if (sized.ok && planOf(sized.sized, { ...p, at: t }) !== null) return t
    }
    return null
  }

  test('a fall in the second half opens the ring later, and the engine says when', () => {
    const { entries } = stretched(stretchCurve(0.5, 0.5))
    const ring = findRings(book(entries), T0 + 599n, {})[0]
    const p = params()
    const predicted = profitableFrom(ring, p)
    expect(predicted).toBe(scanFrom(ring, p, T0 + 599n))
    // Later than the 299 seconds the straight line takes, because the price rests at the ceiling
    // for the first half and then has to cover the whole range in the second.
    expect(predicted).not.toBeNull()
    expect(predicted! - T0).toBeGreaterThan(299n)
  })

  test('a fall in the first quarter opens it sooner, and the engine says that too', () => {
    const { entries } = stretched(stretchCurve(0, 0.25))
    const ring = findRings(book(entries), T0 + 599n, {})[0]
    const p = params()
    const predicted = profitableFrom(ring, p)
    expect(predicted).toBe(scanFrom(ring, p, T0 + 599n))
    expect(predicted).not.toBeNull()
    expect(predicted! - T0).toBeLessThan(299n)
  })

  /**
   * What the segment walk costs a solver that never meets a curve, and one that does.
   *
   * The claim in the spec is that kind 0 pays nothing and kind 1 pays nothing measurable. A
   * probe is one `sizeRing` and at most one `planOf`, so counting probes is counting the work.
   *
   * Kind 0 has no knots at all, so the walk is one segment and the probes are the ones the
   * bisection always made: the opening second, the deadline, ten halvings of a 599-second
   * window, and one walk-back that fails. Thirteen, and not one of them is new.
   *
   * Kind 1 pays one probe for its knot and takes one back on the bisection, which now runs over
   * the 299 seconds after the knot rather than the whole window. Twelve. A shorter segment can
   * pay for its own boundary, and that is why nine independent bisections would have been the
   * wrong design: they cost the boundary probes without ever shortening anything.
   */
  test('the segment walk costs kind 0 nothing, and kind 1 no more than kind 0', () => {
    const p = params()
    const line = findRings(book(decaying().entries), T0 + 599n, {})[0]
    const bent = findRings(book(stretched(stretchCurve(0.5, 0.5)).entries), T0 + 599n, {})[0]

    const lineProbes = probesFor(line, p)
    const bentProbes = probesFor(bent, p)

    // Kind 0: the opening second, the deadline, the bisection, and the walk-back. Exactly what
    // the search cost before curves existed, in the same order.
    expect(breakpointsOf(decaying().falling)).toEqual([])
    expect(lineProbes.length).toBe(13)
    expect(lineProbes[0]).toBe(T0)
    expect(lineProbes[1]).toBe(T0 + 599n)

    // Kind 1: the knot is probed second, before the deadline, because the search walks the
    // window in order and stops at the first segment that ends profitable.
    expect(breakpointsOf(stretched(stretchCurve(0.5, 0.5)).falling)).toEqual([T0 + 300n])
    expect(bentProbes.length).toBe(12)
    expect(bentProbes[0]).toBe(T0)
    expect(bentProbes[1]).toBe(T0 + 300n)
    expect(bentProbes.length).toBeLessThanOrEqual(lineProbes.length + 2)
  })

  test('the deadline is the soonest expiry in the ring, minus the last second', () => {
    const { falling, flat } = decaying()
    const legs: Leg[] = [
      { kind: 'intent', receives: TOKEN_A, pays: TOKEN_B, entry: entry(falling) },
      { kind: 'intent', receives: TOKEN_B, pays: TOKEN_A, entry: entry(flat) },
    ]
    expect(ringDeadline(makeRing(legs)!)).toBe(T0 + 599n)
  })
})

// ── Gas ───────────────────────────────────────────────────────────────────────

describe('netClears', () => {
  const plan = (netNative: bigint | null) => ({ netNative, profitToken: TOKEN_A })

  test('passes a priced net above the bar and refuses one at or below it', () => {
    expect(netClears(plan(11n), 10n)).toBe(true)
    expect(netClears(plan(10n), 10n)).toBe(false)
  })

  test('refuses a null net unless the profit token is allowed unpriced', () => {
    expect(netClears(plan(null), 0n)).toBe(false)
    expect(netClears(plan(null), 0n, [TOKEN_B])).toBe(false)
    expect(netClears(plan(null), 0n, [TOKEN_A.toUpperCase().replace('0X', '0x') as Address])).toBe(true)
  })

  test('refuses a batch when any leg is unpriced in a token nobody allowed', () => {
    const b = { netNative: null, profitToken: TOKEN_B }
    expect(batchNetClears([plan(100n), b], 0n)).toBe(false)
    expect(batchNetClears([plan(100n), b], 0n, [TOKEN_B])).toBe(true)
    expect(batchNetClears([plan(100n), plan(-50n)], 49n)).toBe(true)
    expect(batchNetClears([plan(100n), plan(-50n)], 50n)).toBe(false)
  })
})

describe('a ring smaller than its own gas', () => {
  /** A thin ring: the surplus is real but it is measured in millionths of a token. */
  const thin = () => {
    const m = boundaryMinOut(ONE) - ONE / 2_000_000n
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: m })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: m })
    return [entry(a), entry(b)]
  }

  test('is a ring at zero gas', () => {
    const plans = solve(book(thin()), params({ prices: flatPrices([TOKEN_A, TOKEN_B]) }))
    expect(plans.length).toBeGreaterThan(0)
    expect(plans[0].netNative).toBeGreaterThan(0n)
  })

  test('is not a ring once gas is priced', () => {
    const gas = DEFAULT_GAS_MODEL.base + DEFAULT_GAS_MODEL.perIntentLeg * 2n
    const surplus = solve(book(thin()), params({ prices: flatPrices([TOKEN_A, TOKEN_B]) }))[0].profit
    // A gas price that makes the transaction cost more than the ring earns.
    const gasPrice = surplus / gas + 1n
    const plans = solve(
      book(thin()),
      params({ prices: flatPrices([TOKEN_A, TOKEN_B]), gasPrice }),
    )
    expect(plans).toHaveLength(0)
  })

  test('an unpriced surplus is refused, because it cannot be weighed against gas', () => {
    // A null net used to pass both the gas gate and the min-profit gate. A ring whose profit
    // token nothing prices could then burn more gas than it earns, and nothing would say so.
    const plans = solve(book(thin()), params({ gasPrice: 1_000_000_000n }))
    expect(plans).toHaveLength(0)
  })

  test('an unpriced surplus in a token the operator allows is reported, not silently dropped', () => {
    const plans = solve(
      book(thin()),
      params({ gasPrice: 1_000_000_000n, unpricedOk: [TOKEN_A, TOKEN_B] }),
    )
    expect(plans.length).toBeGreaterThan(0)
    expect(plans[0].profitNative).toBeNull()
    expect(plans[0].netNative).toBeNull()
    expect(plans[0].gasSimulated).toBe(false)
  })
})

// ── One intent, two rings ─────────────────────────────────────────────────────

describe('an intent in two candidate rings', () => {
  const shared = () => {
    const x = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: (ONE * 9_950n) / 10_000n })
    const y1 = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: (ONE * 9_950n) / 10_000n })
    const y2 = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: (ONE * 9_900n) / 10_000n })
    return { x, y1, y2, entries: [entry(x), entry(y1), entry(y2)] }
  }

  test('appears in both, because the list is a menu', () => {
    const { x, entries } = shared()
    const plans = solve(book(entries), params())
    const withX = plans.filter((p) =>
      p.fills.some((f) => f.intent.maker === x.maker),
    )
    expect(withX.length).toBeGreaterThan(1)
  })

  test('is only promised once, because the schedule is not', () => {
    const { entries } = shared()
    const chosen = selectDisjoint(solve(book(entries), params()))
    const keys = chosen.flatMap((p) => p.fills.map((f) => f.intent.maker))
    expect(new Set(keys).size).toBe(keys.length)
  })

  test('the ranking keeps the better of the two first', () => {
    const { y2, entries } = shared()
    const chosen = selectDisjoint(solve(book(entries), params()))
    // y2 concedes a hundred basis points against y1's fifty, so it pays more.
    expect(chosen[0].fills.some((f) => f.intent.maker === y2.maker)).toBe(true)
  })
})

// ── The pool ──────────────────────────────────────────────────────────────────

describe('a leg that closes through the pool', () => {
  const pool: Pool = {
    address: '0x00000000000000000000000000000000000000f0' as Address,
    token0: TOKEN_A,
    token1: TOKEN_B,
    reserve0: ONE * 1_000_000n,
    reserve1: ONE * 2_000_000n,
    feeNum: PULSEX_FEE_NUM,
    feeDen: PULSEX_FEE_DEN,
    venue: 'v1',
    blockNumber: 1n,
  }
  const pools = new Map([[poolKey(TOKEN_A, TOKEN_B), pool]])

  test('the curve is UniswapV2, integer for integer', () => {
    const out = poolAmountOut(pool, TOKEN_A, ONE)!
    // amountIn · feeNum · reserveOut / (reserveIn · feeDen + amountIn · feeNum)
    const withFee = ONE * PULSEX_FEE_NUM
    expect(out).toBe((withFee * pool.reserve1) / (pool.reserve0 * PULSEX_FEE_DEN + withFee))
  })

  test('what it charges to release an amount always buys back that amount', () => {
    for (const want of [ONE, ONE * 100n, ONE * 12_345n]) {
      const cost = poolAmountIn(pool, TOKEN_B, want)!
      expect(poolAmountOut(pool, TOKEN_A, cost)!).toBeGreaterThanOrEqual(want)
      // And never more than a wei of slack: the router's `+ 1` and nothing else.
      expect(poolAmountOut(pool, TOKEN_A, cost - 1n)!).toBeLessThan(want)
    }
  })

  test('the pool cannot release more than it holds', () => {
    expect(poolAmountIn(pool, TOKEN_B, pool.reserve1)).toBeNull()
    expect(poolAmountOut(pool, TOKEN_C, ONE)).toBeNull()
  })

  test('one intent plus the pool is a ring, and it is not atomic', () => {
    // The maker sells A cheap; the pool pays more for A than the maker asks for B.
    const cheap = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE * 1_000n,
      minOutStart: ONE * 1_900n,
    })
    const plans = solve(book([entry(cheap)]), params({ markets: xykMarkets(pools, () => POOL_ROUTER) }))
    expect(plans.length).toBeGreaterThan(0)

    const plan = plans[0]
    expect(plan.fills).toHaveLength(1)
    expect(plan.swap).not.toBeNull()
    expect(plan.atomic).toBe(false)
    expect([plan.swap!.market.pays, plan.swap!.market.receives]).toEqual([TOKEN_A, TOKEN_B])
    // The swap has to buy back at least what the ring owes, or the position is open.
    expect(poolAmountOut(pool, TOKEN_A, plan.swap!.amountIn)!).toBeGreaterThanOrEqual(
      plan.swap!.amountOutMin,
    )
  })

  test('two intents plus the pool close a three-leg ring', () => {
    const ab = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_C,
      amountIn: ONE * 1_000n,
      minOutStart: ONE * 900n,
    })
    const cb = intentOf({
      tokenIn: TOKEN_C,
      tokenOut: TOKEN_B,
      amountIn: ONE * 1_000n,
      minOutStart: ONE * 1_900n,
    })
    const plans = solve(book([entry(ab), entry(cb)]), params({ markets: xykMarkets(pools, () => POOL_ROUTER) }))
    const three = plans.find((p) => p.ring.legs.length === 3)
    expect(three).toBeDefined()
    expect(three!.fills).toHaveLength(2)
    expect(three!.swap).not.toBeNull()
  })

  test('no pools means no pool legs', () => {
    const cheap = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE * 1_000n,
      minOutStart: ONE * 1_900n,
    })
    expect(solve(book([entry(cheap)]), params())).toHaveLength(0)
  })
})

describe('the pool curve, against PulseX itself', () => {
  /**
   * The real WPLS/PLSX pair at mainnet block 27,260,000, and the two answers the deployed
   * router gave for it. PulseX keeps 29 basis points, not Uniswap's 30, and getting that wrong
   * misprices every pool leg by a basis point — enough to turn a ring that clears into one that
   * does not. `app/scripts/solver-devnet.ts` checks this against the live router; this pins it
   * without a chain.
   */
  const live: Pool = {
    address: '0x149B2C629e652f2E89E11cd57e5d4D77ee166f9F' as Address,
    token0: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab' as Address, // PLSX
    token1: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27' as Address, // WPLS
    reserve0: 38_226_064_072_029_489_709_090_163_211n,
    reserve1: 34_337_351_816_330_033_729_910_706_930n,
    feeNum: PULSEX_FEE_NUM,
    feeDen: PULSEX_FEE_DEN,
    venue: 'v1',
    blockNumber: 27_260_000n,
  }

  test('getAmountsOut matches the router wei for wei', () => {
    expect(poolAmountOut(live, live.token1, ONE)).toBe(1_110_021_782_954_942_620n)
  })

  test('getAmountsIn matches the router wei for wei', () => {
    expect(poolAmountIn(live, live.token0, ONE)).toBe(900_883_221_710_355_616n)
  })

  test('the fee is 29 basis points, not 30', () => {
    expect(PULSEX_FEE_DEN - PULSEX_FEE_NUM).toBe(29n)
    // A Uniswap-fee pool would quote a different number, and the difference is the whole point.
    const uniswap = { ...live, feeNum: 997n, feeDen: 1_000n }
    expect(poolAmountOut(uniswap, live.token1, ONE)).not.toBe(poolAmountOut(live, live.token1, ONE))
  })
})

// ── The shape of the answer ───────────────────────────────────────────────────

describe('a plan', () => {
  test('never carries skipInvalid, because a ring is atomic or it is nothing', () => {
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: (ONE * 99n) / 100n })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: (ONE * 99n) / 100n })
    const plan = solve(book([entry(a), entry(b)]), params())[0]
    // The batch call builder decides it, and it decides false. Nothing in the plan can change it.
    expect('skipInvalid' in plan).toBe(false)
  })

  test('bounds the fee at exactly what it was priced with', () => {
    const rate = 2500000000000000n
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: (ONE * 98n) / 100n, output: rate })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: (ONE * 98n) / 100n, output: rate })
    const plan = solve(book([entry(a), entry(b)]), params())[0]
    expect(plan.maxFeeRate).toBe(rate)
    // And the sizing used that rate, not the fixture's.
    const qa = quote(a, plan.sized.entryTake, T0)
    expect(plan.sized.legs[0].fee).toBe(qa.feeOut + qa.feeProceeds)
  })

  test('the bound follows the dearest leg, not the cheapest', () => {
    // A bound set to the cheap leg is the mistake worth a test: the contract would step over the
    // leg that asks for more, and a ring missing a leg settles nothing.
    const a = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE,
      minOutStart: (ONE * 98n) / 100n,
      output: 4000000000000000n,
    })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: (ONE * 98n) / 100n })
    const plan = solve(book([entry(a), entry(b)]), params())[0]
    expect(plan.maxFeeRate).toBe(4000000000000000n)
    expect(plan.maxFeeRate).toBeGreaterThan(RATE)
  })

  test('is empty when the book is', () => {
    expect(solve(book([]), params())).toHaveLength(0)
  })
})

// ── Approvals ─────────────────────────────────────────────────────────────────

/**
 * What an executor approves, and to whom.
 *
 * The settlement holds no allowance. `ProveRelayer` holds every one of them, so a solver that
 * approves the settlement approves a contract that never calls `transferFrom`, and every batch it
 * sends reverts on allowance. No fill test catches that, because a plan simulates the same either
 * way, so pin the spender here.
 */
describe('what a solver approves', () => {
  const RELAYER = '0x00000000000000000000000000000000000000a1' as Address
  const ROUTER = '0x00000000000000000000000000000000000000a2' as Address

  let deployment = 0

  /** A settlement that answers `relayer()`, at a fresh address so no cache can hide the read. */
  function stub() {
    deployment++
    const settlementAddress = `0x${deployment.toString(16).padStart(38, '0')}d0` as Address
    const reads: { address: string; functionName: string }[] = []
    const client = {
      readContract: async (c: { address: string; functionName: string }) => {
        reads.push(c)
        if (c.functionName === 'relayer') return RELAYER
        throw new Error(`unexpected read: ${c.functionName}`)
      },
    } as unknown as NonNullable<ExecuteOptions['client']>
    return { settlementAddress, client, reads }
  }

  test('an intent leg names the relayer, never the settlement', async () => {
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: (ONE * 99n) / 100n })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: (ONE * 99n) / 100n })
    const plan = solve(book([entry(a), entry(b)]), params())[0]

    const { settlementAddress, client, reads } = stub()
    const need = await requiredApprovals(plan, {
      account: EXECUTOR,
      client,
      chainId: 369,
      settlementAddress,
    })

    expect(need).toHaveLength(2)
    for (const { spender } of need) {
      expect(spender).toBe(RELAYER)
      expect(spender).not.toBe(settlementAddress)
    }
    // And it asked the settlement the plan settles against, not a configured address.
    expect(reads[0]?.functionName).toBe('relayer')
    expect(reads[0]?.address).toBe(settlementAddress)
  })

  test('the pool leg still names the router', async () => {
    const pool: Pool = {
      address: '0x00000000000000000000000000000000000000f1' as Address,
      token0: TOKEN_A,
      token1: TOKEN_B,
      reserve0: ONE * 1_000_000n,
      reserve1: ONE * 2_000_000n,
      feeNum: PULSEX_FEE_NUM,
      feeDen: PULSEX_FEE_DEN,
      venue: 'v1',
      blockNumber: 1n,
    }
    const cheap = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE * 1_000n,
      minOutStart: ONE * 1_900n,
    })
    const pools = new Map([[poolKey(TOKEN_A, TOKEN_B), pool]])
    const plan = solve(book([entry(cheap)]), params({ markets: xykMarkets(pools, () => ROUTER) }))[0]
    expect(plan.swap).not.toBeNull()

    const { settlementAddress, client } = stub()
    const need = await requiredApprovals(plan, {
      account: EXECUTOR,
      client,
      chainId: 369,
      router: ROUTER,
      settlementAddress,
    })

    // The router takes the token the swap pays in, and it takes it itself.
    const swapLeg = need.find((n) => n.spender === ROUTER)
    expect(swapLeg?.token).toBe(plan.swap!.market.pays)
    // The intent leg beside it still goes to the relayer.
    expect(need.filter((n) => n.spender === RELAYER)).toHaveLength(1)
  })
})

describe('who signs what the solver sends', () => {
  const RELAYER = '0x00000000000000000000000000000000000000a1' as Address
  const SETTLEMENT = '0x00000000000000000000000000000000000000d0' as Address
  const LOCAL_KEY = { address: EXECUTOR, type: 'local' as const, signMessage: async () => '0x' as Hex }

  /** A ring of two intents that pay for each other, and the plan that settles it. */
  function ringPlan() {
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: (ONE * 99n) / 100n })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: (ONE * 99n) / 100n })
    return solve(book([entry(a), entry(b)]), params())[0]
  }

  /** Records every write in full, and answers the reads the approval path makes. */
  type Write = {
    account: unknown
    functionName: string
    maxFeePerGas?: bigint
    maxPriorityFeePerGas?: bigint
  }
  function spy(walletAccount: unknown) {
    const writes: Write[] = []
    const wallet = {
      account: walletAccount,
      writeContract: async (c: Write) => {
        writes.push(c)
        return '0xfeed' as Hex
      },
    }
    const client = {
      readContract: async (c: { functionName: string }) => {
        if (c.functionName === 'relayer') return RELAYER
        if (c.functionName === 'allowance') return 0n
        throw new Error(`unexpected read: ${c.functionName}`)
      },
    } as unknown as NonNullable<ExecuteOptions['client']>
    return { wallet, client, writes }
  }

  const opts = (client: NonNullable<ExecuteOptions['client']>): ExecuteOptions => ({
    account: EXECUTOR,
    client,
    chainId: 369,
    settlementAddress: SETTLEMENT,
  })

  test('a wallet holding a local key signs with that key, not with a bare address', async () => {
    const { wallet, client, writes } = spy(LOCAL_KEY)
    await ensureApprovals(wallet as never, ringPlan(), opts(client))

    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) {
      // The Account object, not the string. A bare address makes viem ask the node to sign, and
      // the node has never heard of a bot's key: `unknown account`.
      expect(w.account).toBe(LOCAL_KEY)
      expect(typeof w.account).not.toBe('string')
    }
  })

  test('a wallet with no account of its own still uses the address it was given', async () => {
    const { wallet, client, writes } = spy(undefined)
    await ensureApprovals(wallet as never, ringPlan(), opts(client))

    // A browser wallet is a JSON-RPC account: the address is right and the node does the signing.
    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) expect(w.account).toBe(EXECUTOR)
  })

  test('the batch itself signs the same way the approvals do', async () => {
    const { wallet, client, writes } = spy(LOCAL_KEY)
    await executeRing(wallet as never, ringPlan(), { ...opts(client), skipPreflight: true })

    const batch = writes.find((w) => w.functionName === 'fillBatch')
    expect(batch).toBeDefined()
    expect(batch?.account).toBe(LOCAL_KEY)
  })

  /**
   * What it costs to let the node choose.
   *
   * On 943 the node answered a solver's send with a zero tip twice. Those two transactions were
   * never going to be mined, and nonces are strictly ordered, so the seventy-four correctly
   * priced rings behind them expired in the mempool. The bot logged confirmation timeouts for
   * an hour and kept sending. A bot pins its fees; these hold every send to that.
   */
  const PINNED = { maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }

  test('the fees a caller pins reach the batch', async () => {
    const { wallet, client, writes } = spy(LOCAL_KEY)
    await executeRing(wallet as never, ringPlan(), {
      ...opts(client),
      ...PINNED,
      skipPreflight: true,
    })

    const batch = writes.find((w) => w.functionName === 'fillBatch')
    expect(batch?.maxFeePerGas).toBe(PINNED.maxFeePerGas)
    expect(batch?.maxPriorityFeePerGas).toBe(PINNED.maxPriorityFeePerGas)
  })

  /** An approval is a send too, and a zero-tip approval blocks the ring behind it just as well. */
  test('an approval carries them as well', async () => {
    const { wallet, client, writes } = spy(LOCAL_KEY)
    await ensureApprovals(wallet as never, ringPlan(), { ...opts(client), ...PINNED })

    expect(writes.length).toBeGreaterThan(0)
    for (const w of writes) {
      expect(w.maxPriorityFeePerGas).toBe(PINNED.maxPriorityFeePerGas)
    }
  })

  /**
   * Absent, not undefined. viem reads the key rather than checking for it, so a
   * `maxFeePerGas: undefined` sitting in the request is refused outright instead of estimated —
   * which would break every caller that does want the node's answer.
   */
  test('a caller that pins nothing sends no fee fields at all', async () => {
    const { wallet, client, writes } = spy(LOCAL_KEY)
    await executeRing(wallet as never, ringPlan(), { ...opts(client), skipPreflight: true })

    const batch = writes.find((w) => w.functionName === 'fillBatch')
    expect(batch).toBeDefined()
    expect('maxFeePerGas' in batch!).toBe(false)
    expect('maxPriorityFeePerGas' in batch!).toBe(false)
  })
})

describe('checking the fill after it lands', () => {
  const settlementAddress = '0x00000000000000000000000000000000000000d0' as Address

  /** A `Filled` log, as the contract would emit it: three indexed fields, five in the body. */
  const filledLog = (intent: SignedIntent, take: bigint, delivered: bigint) => {
    const topics = encodeEventTopics({
      abi: SOLVER_SETTLEMENT_ABI,
      eventName: 'Filled',
      args: { intentHash: intentHashOf(intent, 369), maker: intent.maker, executor: EXECUTOR },
    })
    const data = encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [intent.tokenIn, intent.tokenOut, take, delivered, 0n],
    )
    return { address: settlementAddress, data, topics } as unknown as Log
  }

  const ring = () => {
    const a = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE,
      minOutStart: ONE,
      minOutEnd: (ONE * 98n) / 100n,
      start: T0,
      end: T0 + 1000n,
    })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: (ONE * 97n) / 100n })
    return { a, b, plan: solve(book([entry(a), entry(b)]), params())[0] }
  }

  test('a fill that paid the quote is not short', () => {
    const { plan } = ring()
    const logs = plan.sized.legs.map((l) =>
      filledLog((l.leg as { entry: { intent: SignedIntent } }).entry.intent, l.take, l.delivered),
    )
    expect(makersShortChanged(plan, logs, T0, 369, settlementAddress)).toHaveLength(0)
  })

  test('a fill that paid a wei less is', () => {
    const { plan } = ring()
    const logs = plan.sized.legs.map((l) =>
      filledLog((l.leg as { entry: { intent: SignedIntent } }).entry.intent, l.take, l.delivered - 1n),
    )
    expect(makersShortChanged(plan, logs, T0, 369, settlementAddress)).toHaveLength(2)
  })

  test('a decaying intent that lands late is owed less, not the same', () => {
    // The plan was priced at T0. The block landed later, so the curve had moved on and the
    // amount the maker is owed had fallen. Checking against the plan's own quote would call
    // this a short payment; checking against the curve at the fill does not.
    const { plan } = ring()
    const late = T0 + 300n
    const logs = plan.sized.legs.map((l) => {
      const intent = (l.leg as { entry: { intent: SignedIntent } }).entry.intent
      return filledLog(intent, l.take, quote(intent, l.take, late).delivered)
    })
    expect(makersShortChanged(plan, logs, late, 369, settlementAddress)).toHaveLength(0)
    expect(makersShortChanged(plan, logs, T0, 369, settlementAddress).length).toBeGreaterThan(0)
  })

  test('a Filled log from another contract is ignored', () => {
    // Any contract can emit an event with the settlement's signature. Only the settlement's own
    // log is its record of a payment.
    const { plan } = ring()
    const leg = plan.sized.legs[0]!
    const intent = (leg.leg as { entry: { intent: SignedIntent } }).entry.intent
    const forged = { ...(filledLog(intent, leg.take, leg.delivered) as object), address: '0x00000000000000000000000000000000000000e1' } as unknown as Log
    expect(deliveredFromLogs([forged], settlementAddress).size).toBe(0)
    expect(deliveredFromLogs([filledLog(intent, leg.take, leg.delivered)], settlementAddress).size).toBe(1)
    const logs = plan.sized.legs.map((l) => ({
      ...(filledLog((l.leg as { entry: { intent: SignedIntent } }).entry.intent, l.take, l.delivered) as object),
      address: '0x00000000000000000000000000000000000000e1',
    })) as unknown as Log[]
    expect(makersShortChanged(plan, logs, T0, 369, settlementAddress)).toHaveLength(2)
  })

  test('the address match ignores checksum case', () => {
    const { plan } = ring()
    const leg = plan.sized.legs[0]!
    const intent = (leg.leg as { entry: { intent: SignedIntent } }).entry.intent
    const log = { ...(filledLog(intent, leg.take, leg.delivered) as object), address: settlementAddress.toUpperCase().replace('0X', '0x') } as unknown as Log
    expect(deliveredFromLogs([log], settlementAddress).size).toBe(1)
  })
})

/**
 * A maker's floor, which the engine could not see until now.
 *
 * `minFill` lived in the SDK only as a field in the generated ABI. `sizeRing` never read it, so
 * the engine would hand back a take the settlement then refused with `BelowMinFill` — a leg
 * stepped over in a batch, and a whole reverted transaction in a ring. The chain's rule is
 * `take < minFill && take != remaining`, so the carve-out matters as much as the floor: closing
 * an offer out is always legal, or a floor of thirty on a hundred strands the last ten from both
 * sides.
 */
describe('a maker who will not sell in small pieces', () => {
  const pair = (o: { aFloor?: bigint; bFloor?: bigint; aLeft?: bigint; bLeft?: bigint } = {}) => {
    const m = boundaryMinOut(ONE) - ONE / 100_000n
    const a = intentOf({
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: ONE,
      minOutStart: m,
      minFill: o.aFloor,
    })
    const b = intentOf({
      tokenIn: TOKEN_B,
      tokenOut: TOKEN_A,
      amountIn: ONE,
      minOutStart: m,
      minFill: o.bFloor,
    })
    const legs: Leg[] = [
      { kind: 'intent', receives: TOKEN_A, pays: TOKEN_B, entry: entry(a, o.aLeft ?? ONE) },
      { kind: 'intent', receives: TOKEN_B, pays: TOKEN_A, entry: entry(b, o.bLeft ?? ONE) },
    ]
    return { a, b, ring: makeRing(legs) as Ring }
  }

  test('a floor under the whole offer changes nothing, because the ring fills it whole', () => {
    const { ring } = pair({ aFloor: ONE / 2n })
    const sized = sizeRing(ring, T0)
    expect(sized.ok).toBe(true)
    if (sized.ok) expect(sized.sized.entryTake).toBe(ONE)
  })

  test('a leg with little left is sized to its remainder, floor or no floor', () => {
    // The carve-out. Ninety percent of the offer is gone, the floor is half, and what is left is
    // under it — so the only legal size is exactly what remains, and the ring takes it.
    const { ring } = pair({ aFloor: ONE / 2n, aLeft: ONE / 10n })
    const sized = sizeRing(ring, T0)
    expect(sized.ok).toBe(true)
    if (sized.ok) expect(sized.sized.legs[0].take).toBe(ONE / 10n)
  })

  test("a floor the other leg cannot reach refuses the ring, and says which rule refused it", () => {
    // Leg B can only supply a tenth, which drives leg A's take to about a tenth — under A's
    // floor, and not A's remainder either, so no size satisfies both. Before this the engine
    // returned that size happily and the chain refused it.
    const { ring } = pair({ aFloor: (ONE * 9n) / 10n, bLeft: ONE / 10n })
    const sized = sizeRing(ring, T0)
    expect(sized.ok).toBe(false)
    if (!sized.ok) expect(sized.reason).toBe('below-min-fill')
  })

  test('the engine does not offer a plan the chain would refuse', () => {
    const { a, b } = pair({ aFloor: (ONE * 9n) / 10n, bLeft: ONE / 10n })
    const plans = solve(book([entry(a), entry(b, ONE / 10n)]), params())
    expect(plans).toHaveLength(0)
  })

  test('every take an engine hands back is one the settlement would accept', () => {
    // The property, stated over the sizes rather than one case: no leg is ever handed a take
    // under its own floor unless that take closes the offer out. A loop over floors rather than
    // one fixture, because a fencepost in the carve-out shows at one ratio and not another.
    for (const floor of [ONE / 10n, ONE / 4n, ONE / 2n, (ONE * 3n) / 4n, ONE]) {
      const { ring } = pair({ aFloor: floor, bFloor: floor })
      const sized = sizeRing(ring, T0)
      if (!sized.ok) continue
      for (const leg of sized.sized.legs) {
        if (leg.leg.kind !== 'intent') continue
        const ok = leg.take >= leg.leg.entry.intent.minFill || leg.take === leg.leg.entry.remaining
        expect(ok).toBe(true)
      }
    }
  })
})

describe('the fee points the solver bears', () => {
  const ninetyEight = (ONE * 98n) / 100n

  test('an output fee (P2) is paid on top: the executor pays the maker number plus the fee', () => {
    const rate = 5000000000000000n
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: ninetyEight, output: rate })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: ninetyEight })
    const plan = solve(book([entry(a), entry(b)]), params())[0]
    expect(plan).toBeDefined()
    const leg = plan.sized.legs[0]
    const q = quote(a, leg.take, T0)
    expect(leg.pay).toBe(q.owed)
    expect(q.owed).toBe(q.owedToMaker + q.feeOut)
    expect(q.feeOut).toBeGreaterThan(0n)
    expect(plan.maxFeeRate).toBe(rate)
  })

  test('a handover fee (P1) is grossed up: the next leg delivers enough to cover it', () => {
    const rate = 10000000000000000n
    const a = intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: ONE, minOutStart: ninetyEight })
    const b = intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: ONE, minOutStart: ninetyEight, handover: rate })
    const plan = solve(book([entry(a), entry(b)]), params())[0]
    expect(plan).toBeDefined()
    // What leg b hands over, less its own fee, is at least what leg a pays for it.
    const [la, lb] = plan.sized.legs
    expect(quote(b, lb.take, T0).usable).toBeGreaterThanOrEqual(la.pay)
    expect(quote(b, lb.take, T0).feeIn).toBeGreaterThan(0n)
    expect(plan.maxFeeRate).toBe(rate)
  })
})

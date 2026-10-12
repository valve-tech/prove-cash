import { hashFeeConfig, singleFeeConfig } from '../feeconfig.js'
import { describe, expect, test } from 'vitest'
import type { Address, Hex } from 'viem'
import { CURVE_LINEAR, FLAG_ESCROW, FLAG_PARTIAL, FLAG_PERMIT2, ZERO, ZERO_HASH } from '../intent.js'
import type { SignedIntent } from '../intent.js'
import { ANY_LEG, WHEN_ABSENT, routerSwap } from './abi.js'
import type { RingFill, Route, RouteSwap } from './abi.js'
import {
  DEFAULT_CONFIDENCE,
  confidenceOf,
  feeTransfers,
  orderAtomicLegs,
  reindexRoute,
} from './confidence.js'
import { MakerTrust } from './trust.js'
import { PARKED_ARMING } from './arming.js'
import { executeCreditRing } from './execute.js'
import type { ExecuteOptions } from './execute.js'
import type { Plan } from './plan.js'

/**
 * Which leg goes first in an atomic batch, and what the reorder is not allowed to break.
 *
 * The measurement behind all of it is one row of `contracts/test/Gas.t.sol`: the same eight legs
 * losing the same maker cost 121,329 gas when it is the first leg and 554,731 when it is the
 * last. So the score only has to get the ORDER right, and these tests check orders rather than
 * numbers wherever they can.
 *
 * The safety half matters more than the scoring half. A route's `Swap.leg` indexes into the
 * request array, the fee run coalesces on adjacency, and two permit legs of one maker are
 * strictly ordered by nonce. Each of those has a test that fails if the reorder forgets it.
 */

const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN_B = '0x00000000000000000000000000000000000000bb' as Address
const TOKEN_C = '0x00000000000000000000000000000000000000cc' as Address
const ROUTER = '0x00000000000000000000000000000000000000f0' as Address
const BATCH_EXECUTOR = '0x00000000000000000000000000000000000000be' as Address
const SOLVER = '0x00000000000000000000000000000000000000e0' as Address
const FEE_TO = hashFeeConfig(singleFeeConfig('0x00000000000000000000000000000000000000fe'))
const OTHER_FEE_TO = hashFeeConfig(singleFeeConfig('0x00000000000000000000000000000000000000ef'))

const T0 = 1_800_000_000n
const ONE = 1_000_000_000_000_000_000n
const HOUR = 3_600n
const SIG = `0x${'11'.repeat(65)}` as Hex

let seq = 0

/** A maker address nothing else uses, so two fixtures never share a trust record by accident. */
const nextMaker = (): Address => {
  seq++
  return `0x${seq.toString(16).padStart(40, '0')}` as Address
}

type IntentOverrides = Partial<SignedIntent>

function intentOf(tokenIn: Address, tokenOut: Address, over: IntentOverrides = {}): SignedIntent {
  const maker = over.maker ?? nextMaker()
  return {
    maker,
    recipient: maker,
    tokenIn,
    tokenOut,
    amountIn: ONE,
    minOutStart: ONE,
    minOutEnd: ONE,
    startTime: T0,
    endTime: T0 + HOUR,
    executor: ZERO,
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: FLAG_PARTIAL,
    nonce: BigInt(++seq),
    curve: CURVE_LINEAR,
    signature: SIG,
    ...over,
  }
}

/** A leg the chain already calls fillable: no arming bytes, so nothing has to land first. */
const funded = (intent: SignedIntent): RingFill => ({ intent, take: intent.amountIn })

/** A leg the solver has to arm. The bytes are opaque here; only their presence is read. */
const armed = (intent: SignedIntent): RingFill => ({
  intent,
  take: intent.amountIn,
  arming: '0xdead' as Hex,
})

/** An escrowed intent with a redemption to send: the strongest rung, still needing arming. */
const escrowIntent = (over: IntentOverrides = {}) =>
  intentOf(TOKEN_A, TOKEN_B, {
    flags: FLAG_PARTIAL | FLAG_ESCROW,
    auth: { validAfter: T0 - 10n, validBefore: T0 + HOUR, signature: SIG },
    ...over,
  })

const permitIntent = (over: IntentOverrides = {}) =>
  intentOf(TOKEN_A, TOKEN_B, {
    permit: { value: ONE, deadline: T0 + HOUR, signature: SIG },
    ...over,
  })

const permit2Intent = (over: IntentOverrides = {}) =>
  intentOf(TOKEN_A, TOKEN_B, {
    flags: FLAG_PARTIAL | FLAG_PERMIT2,
    permit2: { token: TOKEN_A, amount: ONE, deadline: T0 + HOUR, signature: SIG },
    ...over,
  })

/** A route whose every swap names the leg it exists for, which is what a reorder must preserve. */
const routeNaming = (legs: number, named: readonly bigint[]): Route => ({
  legs: BigInt(legs),
  swaps: named.map((leg) => ({
    ...routerSwap(ROUTER, TOKEN_B, TOKEN_C, ONE, ONE / 2n, BATCH_EXECUTOR, T0),
    leg,
  })),
  sweep: [TOKEN_A, TOKEN_B, TOKEN_C],
  disposal: [],
})

const bare = (legs: number): Route => routeNaming(legs, [])

describe('what one leg is worth', () => {
  /**
   * The rung ladder, in one assertion, because only the order carries meaning.
   *
   * A funded escrow beats a standing allowance because the tokens are reserved against this
   * intent hash rather than resting in a wallet somebody can empty. Both beat every rung that
   * still needs a signature to land. Among those, a 2612 permit is last: its nonce is ordered,
   * so any other permit of that maker landing first kills it.
   */
  test('the custody ladder decides the order, escrow first and a bare permit last', () => {
    const at = T0
    const score = (fill: RingFill) => confidenceOf(fill, { at }).score

    const escrowed = score(funded(escrowIntent()))
    const allowance = score(funded(intentOf(TOKEN_A, TOKEN_B)))
    const authorization = score(armed(escrowIntent()))
    const permit2 = score(armed(permit2Intent()))
    const permit = score(armed(permitIntent()))

    expect(escrowed).toBeGreaterThan(allowance)
    expect(allowance).toBeGreaterThan(authorization)
    expect(authorization).toBeGreaterThan(permit2)
    expect(permit2).toBeGreaterThan(permit)
  })

  test('a leg armed from the parked row scores its own rung, not the floor for unknown bytes', () => {
    // C5 in the solver spec. `custodyPoints` asked `armingKind` without the maker's row, got
    // `none`, and scored a parked leg 0: the floor meant for arming bytes nobody can name.
    const at = T0
    const custody = (fill: RingFill) => confidenceOf(fill, { at }).custody
    const unwelded = intentOf(TOKEN_A, TOKEN_B, { flags: FLAG_PARTIAL | FLAG_ESCROW })
    const parked = custody({ intent: unwelded, take: ONE, arming: PARKED_ARMING })
    const unknown = custody({ intent: unwelded, take: ONE, arming: '0xdead' as Hex })

    expect(parked).toBe(DEFAULT_CONFIDENCE.armedParked)
    expect(parked).toBeGreaterThan(unknown)
    // The conservative choice for an open question: below every rung a signature backs. The row
    // is shared, and the book arms on any balance, not on one that covers the take.
    expect(parked).toBeLessThan(custody(armed(permitIntent())))
    // Case does not matter: the bytes are compared as a hex value, not as a string.
    const upper = `0x${PARKED_ARMING.slice(2).toUpperCase()}` as Hex
    expect(custody({ intent: unwelded, take: ONE, arming: upper })).toBe(parked)
  })

  test('a leg that needs arming carries the doubt in both halves of the score', () => {
    const at = T0
    const intent = escrowIntent()
    const before = confidenceOf(funded(intent), { at })
    const after = confidenceOf(armed(intent), { at })

    // The custody term falls because the money is not in reach yet, and the reason term falls
    // because the chain answered `EscrowShort` rather than `Ok`.
    expect(after.custody).toBeLessThan(before.custody)
    expect(after.reason).toBe(DEFAULT_CONFIDENCE.reasonArmable)
    expect(before.reason).toBe(DEFAULT_CONFIDENCE.reasonOk)
  })

  test('a fresh dry-run reason beats the one derived from the leg', () => {
    const at = T0
    const intent = escrowIntent()
    const fill = armed(intent)
    const derived = confidenceOf(fill, { at })

    // `dryRun` records its reason AFTER arming, so an `Ok` there answers the question the arming
    // bytes only claimed to.
    const reasons = new Map([[derived.key, 'Ok' as const]])
    expect(confidenceOf(fill, { at, reasons }).reason).toBe(DEFAULT_CONFIDENCE.reasonOk)

    // And a refusal no signature can fix scores at the floor rather than throwing.
    const dead = new Map([[derived.key, 'Cancelled' as const]])
    expect(confidenceOf(fill, { at, reasons: dead }).reason).toBe(0)
  })

  test('a maker who has settled outscores one who has not, and a fault outweighs both', () => {
    const at = T0
    const proven = intentOf(TOKEN_A, TOKEN_B)
    const stranger = intentOf(TOKEN_A, TOKEN_B)
    const faulty = intentOf(TOKEN_A, TOKEN_B)

    const trust = new MakerTrust()
    trust.settled(proven.maker)
    trust.couldNotArm(faulty.maker, at)

    const of = (i: SignedIntent) => confidenceOf(funded(i), { at, trust }).trust
    expect(of(proven)).toBeGreaterThan(of(stranger))
    expect(of(faulty)).toBeLessThan(of(stranger))
  })

  /**
   * The horizon is one hour, and it is the solver's own number.
   *
   * Above it, more time buys nothing this solver can measure. Below it the score falls with the
   * seconds left, and a leg whose window has already shut scores nothing at all. The settlement
   * bounds no window, so nothing on chain sets this — it is a planning horizon, not a rule.
   */
  test('time left is scored against the solver own one-hour horizon', () => {
    const at = T0
    // A whole horizon of seconds the chain accepts. `endTime` itself is `Expired`, so an intent
    // ending one hour out has 3,599 of them and scores just under full.
    const full = confidenceOf(
      funded(intentOf(TOKEN_A, TOKEN_B, { endTime: T0 + HOUR + 1n })),
      { at },
    ).time
    const soon = confidenceOf(
      funded(intentOf(TOKEN_A, TOKEN_B, { endTime: T0 + 30n })),
      { at },
    ).time
    const shut = confidenceOf(
      funded(intentOf(TOKEN_A, TOKEN_B, { endTime: T0 - 1n })),
      { at },
    ).time

    expect(full).toBe(DEFAULT_CONFIDENCE.timeFull)
    expect(soon).toBeLessThan(full)
    expect(shut).toBe(0)
  })

  test('the funding signature narrows the window, so a short authorization scores short', () => {
    const at = T0
    // The intent runs a full hour and the redemption that funds it expires in a minute. Nothing
    // on chain reconciles the two, so the leg is a one-minute leg.
    const brief = escrowIntent({
      auth: { validAfter: T0 - 10n, validBefore: T0 + 60n, signature: SIG },
    })
    const long = escrowIntent()
    expect(confidenceOf(armed(brief), { at }).time).toBeLessThan(
      confidenceOf(armed(long), { at }).time,
    )
  })
})

describe('the order an atomic batch goes out in', () => {
  test('the least confident leg leads a mixed set', () => {
    const at = T0
    const escrowed = funded(escrowIntent())
    const allowance = funded(intentOf(TOKEN_B, TOKEN_C))
    const permit = armed(permitIntent({ tokenIn: TOKEN_C, tokenOut: TOKEN_A }))

    const fills = [escrowed, allowance, permit]
    const out = orderAtomicLegs(fills, bare(3), { at })

    expect(out.order).toEqual([2, 1, 0])
    expect(out.fills[0]).toBe(permit)
    expect(out.fills[2]).toBe(escrowed)
  })

  test('legs that score alike keep the cycle order the sizing gave them', () => {
    const at = T0
    const fills = [
      funded(intentOf(TOKEN_A, TOKEN_B)),
      funded(intentOf(TOKEN_B, TOKEN_C)),
      funded(intentOf(TOKEN_C, TOKEN_A)),
    ]
    expect(orderAtomicLegs(fills, bare(3), { at }).order).toEqual([0, 1, 2])
  })

  /**
   * A tolerant batch is left exactly as it arrived.
   *
   * `skipInvalid` steps over a bad leg and fills the rest, so the loss is that leg's gas wherever
   * it sits — 15,982 measured, against a whole reverted ring. And `packBatch` builds its route on
   * the promise that a fill's position IS its leg index, so reordering one would cost a rebuild
   * and buy nothing.
   */
  test('a tolerant batch is not reordered, because the ordering buys nothing there', () => {
    const at = T0
    const fills = [funded(escrowIntent()), armed(permitIntent({ tokenIn: TOKEN_B }))]
    const route = routeNaming(2, [0n, 1n])
    const out = orderAtomicLegs(fills, route, { at, skipInvalid: true })

    expect(out.order).toEqual([0, 1])
    expect(out.fills).toBe(fills)
    expect(out.route).toBe(route)
    // The score is still computed, so a caller can log why it left the order alone.
    expect(out.scores).toHaveLength(2)
  })

  test('a batch of one is left alone, since there is nothing to put in front of it', () => {
    const fills = [armed(permitIntent())]
    const out = orderAtomicLegs(fills, bare(1), { at: T0 })
    expect(out.order).toEqual([0])
  })
})

describe('the route still names the same legs afterwards', () => {
  /**
   * The defect this exists to catch.
   *
   * `ProveBatchExecutor._wanted` compares `Swap.leg` against `Payment.leg`, and `Payment.leg` is
   * the index of the request the settlement filled. Permute the requests without rewriting the
   * route and every swap runs for somebody else's leg — a call the executor cannot fund, or one
   * it skips while the leg it was raising money for settles.
   */
  test('every swap follows its own leg to the new position', () => {
    const at = T0
    const escrowed = funded(escrowIntent())
    const allowance = funded(intentOf(TOKEN_B, TOKEN_C))
    const permit = armed(permitIntent({ tokenIn: TOKEN_C, tokenOut: TOKEN_A }))
    const fills = [escrowed, allowance, permit]

    const out = orderAtomicLegs(fills, routeNaming(3, [0n, 1n, 2n]), { at })

    // Swap k was built for old leg k. After the reorder it must name wherever that leg went.
    for (let old = 0; old < fills.length; old++) {
      const moved = out.route.swaps[old].leg
      expect(out.fills[Number(moved)]).toBe(fills[old])
    }
    expect(out.route.legs).toBe(3n)
  })

  test('a WHEN_ABSENT fallback keeps its flag and follows its leg', () => {
    const at = T0
    const escrowed = funded(escrowIntent())
    const permit = armed(permitIntent({ tokenIn: TOKEN_C, tokenOut: TOKEN_A }))
    const fills = [escrowed, permit]

    // The fallback stands in for leg 1 — the permit leg — and runs precisely when it is absent.
    //
    // Built from `routerSwap` and the bit, rather than through `fallbackSwap`, because what is
    // under test here is the reindex and nothing else: this file has no market to price one
    // against, and `tolerant.test.ts` is where the builder itself is pinned.
    const fallback: RouteSwap = {
      ...routerSwap(ROUTER, TOKEN_A, TOKEN_C, ONE * 2n, ONE, BATCH_EXECUTOR, T0),
      leg: 1n | WHEN_ABSENT,
    }
    const route: Route = { ...bare(2), swaps: [fallback] }
    const out = orderAtomicLegs(fills, route, { at })

    expect(out.order).toEqual([1, 0])
    const moved = out.route.swaps[0].leg
    expect(moved & WHEN_ABSENT).toBe(WHEN_ABSENT)
    expect(out.fills[Number(moved & ~WHEN_ABSENT)]).toBe(permit)
    // Nothing but the index changes: the trade the fallback makes is still the same trade.
    expect(out.route.swaps[0].data).toBe(fallback.data)
  })

  /**
   * `ANY_LEG` is `2^256 − 1` and means "run whatever settles".
   *
   * It is tested before the `WHEN_ABSENT` bit, in the same order the contract tests it: masking
   * the bit off leaves `2^255 − 1`, which names no leg of any batch a chain will carry. So this
   * pins the pass-through rather than a live hazard — a rule read the same way on both sides is
   * one fewer thing to get wrong.
   */
  test('ANY_LEG is left alone, bit pattern and all', () => {
    const route = routeNaming(3, [ANY_LEG, 1n])
    const out = reindexRoute(route, [2, 1, 0])
    expect(out.swaps[0].leg).toBe(ANY_LEG)
    expect(out.swaps[1].leg).toBe(1n)
  })

  test('a disposal carries a leg index too, and is rewritten with the rest', () => {
    const sell = routerSwap(ROUTER, TOKEN_B, TOKEN_C, ONE, 0n, BATCH_EXECUTOR, T0)
    const disposal = { ...sell, leg: 2n }
    const route: Route = { ...bare(3), disposal: [disposal] }
    expect(reindexRoute(route, [2, 0, 1]).disposal[0].leg).toBe(0n)
  })

  test('an index naming no leg is left as it is rather than moved somewhere plausible', () => {
    // A route pointing outside its own batch is already wrong. Guessing at it would hide that.
    expect(reindexRoute(routeNaming(2, [9n]), [1, 0]).swaps[0].leg).toBe(9n)
  })
})

describe('what the reorder must not break', () => {
  /**
   * `ProveSettlement._accrue` coalesces a fee into the OPEN run, on the token and the destination
   * together. Two legs paying one destination in one token pay one transfer beside each other and
   * two apart, so the reorder has to move them as one block.
   */
  test('two legs sharing a fee run stay adjacent, whatever their scores', () => {
    const at = T0
    const rate = 10n ** 15n
    // Both pay a fee to one destination in TOKEN_B, so they share a run. Their custody rungs are
    // as far apart as the ladder goes, which is what would separate them without the rule.
    const strong = funded(escrowIntent({ tokenOut: TOKEN_B, feeConfig: FEE_TO, feeRate: rate }))
    const weak = armed(permitIntent({ tokenOut: TOKEN_B, feeConfig: FEE_TO, feeRate: rate }))
    const middle = funded(intentOf(TOKEN_C, TOKEN_A))
    const fills = [strong, middle, weak]

    const out = orderAtomicLegs(fills, bare(3), { at })

    const at0 = out.fills.indexOf(strong)
    const at2 = out.fills.indexOf(weak)
    expect(Math.abs(at0 - at2)).toBe(1)
    expect(feeTransfers(out.fills, at)).toBe(feeTransfers(fills, at))
    expect(feeTransfers(out.fills, at)).toBe(1)
  })

  test('the reorder never pays for more fee transfers than the order it was given', () => {
    const at = T0
    const rate = 10n ** 15n
    // Two runs, interleaved, which is the order that pays the most: four transfers as given.
    const a1 = funded(intentOf(TOKEN_A, TOKEN_B, { feeConfig: FEE_TO, feeRate: rate }))
    const b1 = armed(permitIntent({ tokenOut: TOKEN_C, feeConfig: OTHER_FEE_TO, feeRate: rate }))
    const a2 = funded(intentOf(TOKEN_A, TOKEN_B, { feeConfig: FEE_TO, feeRate: rate }))
    const b2 = armed(permitIntent({ tokenOut: TOKEN_C, feeConfig: OTHER_FEE_TO, feeRate: rate }))
    const fills = [a1, b1, a2, b2]

    expect(feeTransfers(fills, at)).toBe(4)
    const out = orderAtomicLegs(fills, bare(4), { at })
    expect(feeTransfers(out.fills, at)).toBe(2)
  })

  test('a leg owing no fee is transparent and can sit anywhere', () => {
    const at = T0
    const rate = 10n ** 15n
    const paying = funded(intentOf(TOKEN_A, TOKEN_B, { feeConfig: FEE_TO, feeRate: rate }))
    const free = funded(intentOf(TOKEN_A, TOKEN_B))
    // `_accrue` returns early on a fee of zero, so the free leg never touches the run.
    expect(feeTransfers([paying, free, paying], at)).toBe(1)
  })

  /**
   * An EIP-2612 digest commits to `nonces[owner]`, and the token increments it on every permit it
   * honours. Two permit legs of one maker on one token are therefore strictly ordered: swap them
   * and the second signature matches no nonce the token will ever hold. See `groups.ts`.
   */
  test('two permit legs of one maker keep their relative order', () => {
    const at = T0
    const maker = nextMaker()
    // The leg that must go first scores BETTER, so a plain sort would swap the two and leave the
    // second signature matching a nonce the token never reaches.
    const first = armed(permitIntent({ maker }))
    const second = armed(
      permitIntent({ maker, permit: { value: ONE, deadline: T0 + 60n, signature: SIG } }),
    )
    const fills = [first, second]
    expect(confidenceOf(second, { at }).score).toBeLessThan(confidenceOf(first, { at }).score)

    const out = orderAtomicLegs(fills, bare(2), { at })
    expect(out.order).toEqual([0, 1])
  })

  test('permit legs of different makers are free to move past each other', () => {
    const at = T0
    const brief = armed(
      permitIntent({ permit: { value: ONE, deadline: T0 + 60n, signature: SIG } }),
    )
    const long = armed(permitIntent())
    const out = orderAtomicLegs([long, brief], bare(2), { at })
    expect(out.order).toEqual([1, 0])
  })

  test('a permit2 nonce is unordered, so two of them pin nothing', () => {
    const at = T0
    const maker = nextMaker()
    const transfer = { token: TOKEN_A, amount: ONE, deadline: T0 + 60n, signature: SIG }
    const brief = armed(permit2Intent({ maker, permit2: transfer }))
    const long = armed(permit2Intent({ maker }))
    expect(orderAtomicLegs([long, brief], bare(2), { at }).order).toEqual([1, 0])
  })
})

describe('the credit path sends what the ordering chose', () => {
  const plan = (fills: readonly RingFill[]): Plan =>
    ({
      fills,
      swap: null,
      maxFeeRate: 10n,
      gas: 0n,
      gasSimulated: false,
      at: T0,
    }) as unknown as Plan

  const opts = (extra: Partial<ExecuteOptions> = {}): ExecuteOptions => ({
    account: SOLVER,
    chainId: 369,
    batchExecutor: BATCH_EXECUTOR,
    skipPreflight: true,
    ...extra,
  })

  /** A wallet that signs nothing and remembers the arguments it was handed. */
  const recorder = () => {
    const sent: { args: readonly unknown[] }[] = []
    const wallet = {
      account: undefined,
      writeContract: async (c: { args: readonly unknown[] }) => {
        sent.push(c)
        return '0xfeed' as Hex
      },
    }
    return { wallet, sent }
  }

  /** The makers, in the order the calldata puts them. */
  const makersIn = (call: { args: readonly unknown[] }): string[] =>
    (call.args[0] as { intent: { maker: Address } }[]).map((r) => r.intent.maker.toLowerCase())

  test('an atomic ring goes out least confident first', async () => {
    const escrowed = funded(escrowIntent())
    const permit = armed(permitIntent({ tokenIn: TOKEN_C, tokenOut: TOKEN_A }))
    const { wallet, sent } = recorder()

    await executeCreditRing(wallet as never, plan([escrowed, permit]), opts(), T0)

    expect(makersIn(sent[0])).toEqual([
      permit.intent.maker.toLowerCase(),
      escrowed.intent.maker.toLowerCase(),
    ])
  })

  test('orderLegs false sends the cycle order, which is what this path did before', async () => {
    const escrowed = funded(escrowIntent())
    const permit = armed(permitIntent({ tokenIn: TOKEN_C, tokenOut: TOKEN_A }))
    const { wallet, sent } = recorder()

    await executeCreditRing(
      wallet as never,
      plan([escrowed, permit]),
      opts({ orderLegs: false }),
      T0,
    )

    expect(makersIn(sent[0])).toEqual([
      escrowed.intent.maker.toLowerCase(),
      permit.intent.maker.toLowerCase(),
    ])
  })

  test('the maker ledger reaches the ordering, so a faulty maker is sent first', async () => {
    const clean = funded(intentOf(TOKEN_A, TOKEN_B))
    const faulty = funded(intentOf(TOKEN_B, TOKEN_A))
    const trust = new MakerTrust()
    trust.couldNotArm(faulty.intent.maker, T0)
    const { wallet, sent } = recorder()

    await executeCreditRing(
      wallet as never,
      plan([clean, faulty]),
      opts({ confidence: { trust } }),
      T0,
    )

    expect(makersIn(sent[0])[0]).toBe(faulty.intent.maker.toLowerCase())
  })
})

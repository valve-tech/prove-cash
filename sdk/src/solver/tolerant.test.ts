/**
 * The planner that decides whether a ring can survive losing a leg, and what it sends if it can.
 *
 * Three claims, and the middle one is the whole feature.
 *
 *   it covers what it can    a market per intent leg, sized from live reserves
 *   it never overspends      a fallback spends exactly what the missing maker's payment frees,
 *                            so the ring ends at least as well off as if the maker had turned up
 *   it is never on by itself a route carries no fallback and a ring sends `skipInvalid` false
 *                            unless a caller built a `TolerantRing` and handed it over
 *
 * The markets below are linear and priced by hand. A curve would make every assertion a
 * calculation, and what is under test is which side of the budget a quote falls on — not the
 * quote. `market.test.ts` already proves the seam holds for a shape the engine never learned.
 */
import { describe, expect, test } from 'vitest'
import { decodeAbiParameters, decodeFunctionData, type Address, type Hex } from 'viem'
import { CURVE_LINEAR, FLAG_PARTIAL, ZERO, type SignedIntent, ZERO_HASH } from '../intent.js'
import {
  ANY_LEG,
  ROUTER_ABI,
  ROUTE_TUPLE,
  WHEN_ABSENT,
  encodeRoute,
  routerSwap,
  settleBatchCall,
  settleRingCall,
  settleTolerantRingCall,
  type Route,
} from './abi.js'
import { buildBook, type BookEntry } from './book.js'
import { routeFor, simulateCreditRing } from './execute.js'
import type { Market } from './market.js'
import { solve, type Plan } from './plan.js'
import type { MarketLookup } from './rings.js'
import {
  breakEvenLossRate,
  carriedFallbackGas,
  fallbackSwap,
  planTolerantRing,
  swapOrder,
  FALLBACK_FIRST_GAS,
  FALLBACK_MORE_GAS,
  type Fallback,
} from './tolerant.js'

const A = '0x00000000000000000000000000000000000000aa' as Address
const B = '0x00000000000000000000000000000000000000bb' as Address
const C = '0x00000000000000000000000000000000000000cc' as Address
const POOL = '0x000000000000000000000000000000000000c0de' as Address
const EXEC = '0x00000000000000000000000000000000000000be' as Address
const SOLVER = '0x0000000000000000000000000000000000005017' as Address

const T0 = 1_800_000_000n
const ONE = 10n ** 18n

const opts = { account: SOLVER, batchExecutor: EXEC, chainId: 943 as const }
const DEADLINE = T0 + 300n

let seq = 0

/**
 * One maker: hands over `tokenIn`, wants `numer/denom` of it back in `tokenOut`.
 *
 * `endsIn` is how long the offer has left. It is the one input that moves `confidence.ts`'s
 * score here — every leg below is an ordinary allowance with nothing said against it — so it is
 * what makes the ring reorder rather than pass through unchanged, and a reorder that does
 * nothing proves nothing about the route surviving one.
 */
function offer(
  tokenIn: Address,
  tokenOut: Address,
  numer: bigint,
  denom: bigint,
  endsIn = 1800n,
): BookEntry {
  seq++
  const maker = `0x${seq.toString(16).padStart(40, '0')}` as Address
  const intent: SignedIntent = {
    maker,
    recipient: maker,
    tokenIn,
    tokenOut,
    amountIn: ONE,
    minOutStart: (ONE * numer) / denom,
    minOutEnd: (ONE * numer) / denom,
    minFill: 0n,
    authNonce: `0x${'00'.repeat(32)}` as Hex,
    startTime: T0 - 60n,
    endTime: T0 + endsIn,
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
  return { key: `tolerant-${seq}`, intent, remaining: ONE, partial: true }
}

/**
 * A market that charges a flat rate, with no curve and no depth limit.
 *
 * `amountIn` rounds up, the way every venue in this repository does, so a market is never short
 * of what it promised and a test never passes on a wei the chain would not have.
 */
function priced(receives: Address, pays: Address, numer: bigint, denom: bigint): Market {
  return {
    kind: 'flat',
    id: `flat:${POOL.toLowerCase()}:${receives.toLowerCase()}`,
    receives,
    pays,
    cap: () => ONE * 1_000n,
    amountIn: (take) => (take * numer + denom - 1n) / denom,
    rate: () => ({ num: numer, den: denom }),
    swap: (amountIn, minOut, to, deadline) =>
      routerSwap(POOL, pays, receives, amountIn, minOut, to, deadline),
  }
}

/**
 * A three-leg ring of intents alone, and the market lookup that could stand in for each leg.
 *
 * `solve` is given no markets on purpose. A market that beats a maker makes a BETTER ring, and
 * the search would find that one instead — which is the real behaviour and is exactly what makes
 * an affordable fallback uncommon. Separating the two here keeps the ring under test fixed while
 * the markets move.
 */
function ringOfThree(): Plan {
  const book = buildBook(
    [
      // A for B, B for C, C for A. The product of the three rates is under one, so it closes.
      // Three different windows, so the confidence order is not the cycle order.
      offer(A, B, 99n, 100n, 1800n),
      offer(B, C, 105n, 100n, 600n),
      offer(C, A, 95n, 100n, 3600n),
    ],
    943,
  )
  const plans = solve(book, {
    at: T0,
    executor: SOLVER,
    gasPrice: 0n,
    minNetNative: 0n,
    maxLegs: 3,
  })
  const three = plans.find((p) => p.ring.legs.length === 3)
  expect(three, 'the search found the three-leg cycle').toBeDefined()
  return three as Plan
}

/** Every direction the ring walks, priced at `numer/denom` of what the maker asked. */
function marketsAt(plan: Plan, scale: (position: number) => [bigint, bigint]): MarketLookup {
  const table = new Map<string, Market>()
  plan.sized.legs.forEach((leg, position) => {
    const [numer, denom] = scale(position)
    // `pay/take` is what the maker charges. The market charges that, times the caller's scale.
    const market = priced(leg.leg.receives, leg.leg.pays, leg.pay * numer, leg.take * denom)
    table.set(`${leg.leg.receives.toLowerCase()}>${leg.leg.pays.toLowerCase()}`, market)
  })
  return (receives, pays) =>
    table.get(`${receives.toLowerCase()}>${pays.toLowerCase()}`) ?? null
}

/** Every leg's market at nine tenths of what its maker charges: every fallback is affordable. */
const cheap = (plan: Plan) => marketsAt(plan, () => [9n, 10n])

describe('choosing a market for every leg', () => {
  test('it covers each intent leg, sized to what that leg was going to move', () => {
    const plan = ringOfThree()
    const out = planTolerantRing(plan, { markets: cheap(plan) })

    expect(out.refused).toEqual([])
    expect(out.complete).toBe(true)
    expect(out.fallbacks).toHaveLength(plan.fills.length)
    expect(out.ringId).toBe(plan.ring.id)

    for (const f of out.fallbacks) {
      const leg = plan.sized.legs[f.position]
      // The bound is the leg's own supply, and never a zero: an unbounded fallback would let a
      // moved market close the ring at any price.
      expect(f.amountOutMin).toBe(leg.take)
      // And the spend is exactly what the missing maker's payment frees. Never more — that is
      // the whole reason a tolerant ring cannot end worse off than the atomic one.
      expect(f.amountIn).toBe(leg.pay)
      expect(f.market.receives).toBe(leg.leg.receives)
      expect(f.market.pays).toBe(leg.leg.pays)
    }
  })

  test('the fill index and the ring position are kept apart', () => {
    const plan = ringOfThree()
    const out = planTolerantRing(plan, { markets: cheap(plan) })
    // Every leg of this ring is an intent, so the two happen to agree. The claim is that the
    // executor reads `fill`, which indexes `plan.fills`, and that it names the right maker.
    for (const f of out.fallbacks) {
      const leg = plan.sized.legs[f.position].leg
      expect(leg.kind).toBe('intent')
      if (leg.kind !== 'intent') continue
      expect(plan.fills[f.fill].intent).toBe(leg.entry.intent)
    }
  })

  test('a market asking more than the missing leg frees is refused, not clamped', () => {
    const plan = ringOfThree()
    // Leg 1's market asks a tenth more than its maker does. There is nothing else in the ring to
    // pay the difference with: the executor holds exactly that leg's freed payment in that token
    // and every other token nets to zero.
    const out = planTolerantRing(plan, {
      markets: marketsAt(plan, (position) => (position === 1 ? [11n, 10n] : [9n, 10n])),
    })

    expect(out.complete).toBe(false)
    expect(out.fallbacks.map((f) => f.position)).toEqual([0, 2])
    expect(out.refused).toHaveLength(1)
    expect(out.refused[0].position).toBe(1)
    expect(out.refused[0].why).toContain('frees only')
  })

  test('a leg no market lists is refused, and says which problem it is', () => {
    const plan = ringOfThree()
    const all = cheap(plan)
    const out = planTolerantRing(plan, {
      markets: (receives, pays) =>
        receives.toLowerCase() === plan.sized.legs[0].leg.receives.toLowerCase()
          ? null
          : all(receives, pays),
    })
    expect(out.refused).toHaveLength(1)
    expect(out.refused[0].why).toBe('no market lists this direction')
    expect(out.complete).toBe(false)
  })

  test('headroom says how far the market may move before the fallback stops clearing', () => {
    const plan = ringOfThree()
    // Nine tenths of the maker's price leaves about a ninth of the quote in hand.
    const out = planTolerantRing(plan, { markets: cheap(plan) })
    for (const f of out.fallbacks) {
      expect(f.quoted).toBeLessThan(f.amountIn)
      expect(f.headroomBps).toBeGreaterThan(1_000)
      expect(f.headroomBps).toBeLessThan(1_200)
    }
    // A market sitting exactly at the budget has none, and any adverse tick reverts the ring.
    const tight = planTolerantRing(plan, { markets: marketsAt(plan, () => [1n, 1n]) })
    for (const f of tight.fallbacks) expect(f.headroomBps).toBe(0)
  })

  test('a market leg of the ring itself gets no fallback', () => {
    // A venue call is already there and a venue does not fail to show up. Only a signature can.
    const plan = ringOfThree()
    const out = planTolerantRing(plan, { markets: cheap(plan) })
    expect(out.fallbacks.every((f) => plan.sized.legs[f.position].leg.kind === 'intent')).toBe(true)
  })
})

describe('the route a tolerant ring sends', () => {
  test('each fallback carries the flag and the index of the leg it stands in for', () => {
    const plan = ringOfThree()
    const tolerant = planTolerantRing(plan, { markets: cheap(plan) })
    const route = routeFor(plan, { ...opts, tolerant }, DEADLINE)

    expect(route.swaps).toHaveLength(3)
    expect(route.legs).toBe(BigInt(plan.fills.length))
    for (const swap of route.swaps) {
      expect(swap.leg & WHEN_ABSENT).toBe(WHEN_ABSENT)
      const fill = swap.leg & ~WHEN_ABSENT
      expect(fill).toBeLessThan(route.legs)
      // `_wanted` answers ANY_LEG first, so a fallback must never collide with it.
      expect(swap.leg).not.toBe(ANY_LEG)
    }
  })

  test('every token a fallback trades is on the sweep list', () => {
    // The executor refuses a route with `OwedTokenNotSwept` for a token it pays out in and the
    // route never named, and a token left off the list strands here for good.
    const plan = ringOfThree()
    const tolerant = planTolerantRing(plan, { markets: cheap(plan) })
    const route = routeFor(plan, { ...opts, tolerant }, DEADLINE)
    const swept = new Set(route.sweep.map((t) => t.toLowerCase()))
    for (const swap of route.swaps) {
      expect(swept.has(swap.tokenIn.toLowerCase())).toBe(true)
      expect(swept.has(swap.tokenOut.toLowerCase())).toBe(true)
    }
  })

  test('a route built for another ring is refused rather than encoded', () => {
    // A tolerant plan names legs by index into ONE ring's fills. Pointed at another ring it
    // encodes cleanly and fires the wrong fallback for the wrong maker, which nothing downstream
    // can detect.
    const plan = ringOfThree()
    const other = ringOfThree()
    const tolerant = planTolerantRing(other, { markets: cheap(other) })
    expect(tolerant.ringId).not.toBe(plan.ring.id)
    expect(() => routeFor(plan, { ...opts, tolerant }, DEADLINE)).toThrow(/another ring/)
  })

  test('a route survives the round trip the executor decodes with', () => {
    const plan = ringOfThree()
    const tolerant = planTolerantRing(plan, { markets: cheap(plan) })
    const route = routeFor(plan, { ...opts, tolerant }, DEADLINE)
    const [back] = decodeAbiParameters([ROUTE_TUPLE], encodeRoute(route)) as unknown as [Route]
    expect(back.swaps).toHaveLength(3)
    expect(back.swaps[0].leg).toBe(route.swaps[0].leg)
  })
})

describe('the order the venue calls go out in', () => {
  test('the walk starts after the market leg and runs backwards round the cycle', () => {
    // Three legs with the market at the end: leg 0's fallback first, so it has raised the token
    // the market call spends before that call runs.
    expect(swapOrder(3, 2)).toEqual([0, 2, 1])
    // The market in the middle: the walk starts at 2 and the market is reached second.
    expect(swapOrder(3, 1)).toEqual([2, 1, 0])
    // No market leg at all is the same rule with `n − 1` standing in.
    expect(swapOrder(3, null)).toEqual([0, 2, 1])
    expect(swapOrder(2, null)).toEqual([0, 1])
  })

  test('a ring closed at a market puts its own swap between the two fallbacks it sits between', () => {
    const book = buildBook([offer(A, B, 99n, 100n), offer(B, C, 99n, 100n)], 943)
    const closing = priced(C, A, 90n, 100n)
    const plans = solve(book, {
      at: T0,
      executor: SOLVER,
      gasPrice: 0n,
      minNetNative: 0n,
      maxLegs: 3,
      markets: (receives, pays) =>
        receives.toLowerCase() === C.toLowerCase() && pays.toLowerCase() === A.toLowerCase()
          ? closing
          : null,
    })
    const plan = plans.find((p) => p.ring.legs.length === 3 && p.swap !== null)
    expect(plan, 'the search closed a three-leg cycle at the market').toBeDefined()

    const tolerant = planTolerantRing(plan as Plan, { markets: cheap(plan as Plan) })
    expect(tolerant.fallbacks).toHaveLength(2)
    const route = routeFor(plan as Plan, { ...opts, tolerant }, DEADLINE)

    // Leg 0's fallback, then the ring's own market swap, then leg 1's. That is a funding order:
    // the market call spends the token leg 0 hands over, and leg 1's fallback spends the token
    // the market call raises. Sent the other way round, losing leg 0 leaves the market call
    // short and the whole ring reverts — which is the failure this order exists to prevent.
    expect(route.swaps.map((s) => s.leg)).toEqual([0n | WHEN_ABSENT, ANY_LEG, 1n | WHEN_ABSENT])
  })
})

describe('nothing turns this on by itself', () => {
  test('a plan with no tolerant half builds exactly the route it always did', () => {
    const plan = ringOfThree()
    const route = routeFor(plan, opts, DEADLINE)
    expect(route.swaps).toEqual([])
    expect(route.legs).toBe(3n)
  })

  test('the atomic call sends skipInvalid false and the tolerant one sends true', () => {
    const plan = ringOfThree()
    const route = routeFor(plan, opts, DEADLINE)
    expect(settleRingCall(EXEC, plan.fills, 0n, route).args[1]).toBe(false)
    expect(settleTolerantRingCall(EXEC, plan.fills, 0n, route).args[1]).toBe(true)
    // The independent-plan call is the same shape and the same answer, for a different reason.
    expect(settleBatchCall(EXEC, plan.fills, 0n, route).args[1]).toBe(true)
  })
})

/**
 * A client that answers every simulation the same way and keeps what it was asked.
 *
 * The point is the arguments, not the answer: `skipInvalid` is the one field that decides whether
 * a lost leg costs a leg or costs the ring, and a simulation that used one value while the send
 * used the other is a transaction nobody checked.
 */
function recorder(filled: bigint) {
  const seen: unknown[][] = []
  const client = {
    simulateContract: (call: { args: unknown[] }) => {
      seen.push(call.args)
      return Promise.resolve({ result: filled })
    },
    estimateContractGas: () => Promise.resolve(300_000n),
  }
  return { seen, client: client as never }
}

describe('what the chain is actually asked', () => {
  test('a tolerant ring is simulated with skipInvalid true, and an ordinary one with false', async () => {
    const plan = ringOfThree()
    const tolerant = planTolerantRing(plan, { markets: cheap(plan) })

    const atomic = recorder(3n)
    await simulateCreditRing(plan, { ...opts, client: atomic.client }, DEADLINE)
    expect(atomic.seen[0][1]).toBe(false)

    const asked = recorder(3n)
    await simulateCreditRing(plan, { ...opts, tolerant, client: asked.client }, DEADLINE)
    expect(asked.seen[0][1]).toBe(true)

    /*
     * And the reorder did not undo the plan on the way to the wire.
     *
     * `ringCalldata` runs `orderAtomicLegs` over the fills and `reindexRoute` over the route, so
     * both the leg indices and the array order pass through code this file does not own. The
     * indices must be renumbered — each fallback still standing in for the same maker — and the
     * array order must NOT be, because that order is the funding order.
     */
    const fills = asked.seen[0][0] as { intent: { maker: string } }[]
    const route = asked.seen[0][3] as { swaps: { leg: bigint }[] }

    // A reorder that did nothing would prove nothing, so say out loud that one happened.
    expect(fills.map((f) => f.intent.maker)).not.toEqual(plan.fills.map((f) => f.intent.maker))

    // The array order is the funding order and not the ring's own leg order — the two differ,
    // which is why this reads `swapOrder` rather than walking `fallbacks`.
    const byPosition = new Map(tolerant.fallbacks.map((f) => [f.position, f]))
    const expected = swapOrder(plan.ring.legs.length, null)
      .map((position) => byPosition.get(position))
      .filter((f) => f !== undefined)
    expect(route.swaps).toHaveLength(expected.length)

    route.swaps.forEach((swap, k) => {
      expect(swap.leg & WHEN_ABSENT).toBe(WHEN_ABSENT)
      // Renumbered to wherever the reorder put that leg, still standing in for the same maker.
      const maker = plan.fills[expected[k].fill].intent.maker
      expect(fills[Number(swap.leg & ~WHEN_ABSENT)].intent.maker).toBe(maker)
    })
  })

  test('a short count is a refusal for a ring and the feature working for a tolerant one', async () => {
    const plan = ringOfThree()
    const tolerant = planTolerantRing(plan, { markets: cheap(plan) })

    // Two of three legs settled. A ring cannot survive that; a tolerant ring is built for it.
    const strict = await simulateCreditRing(plan, { ...opts, client: recorder(2n).client }, DEADLINE)
    expect(strict.ok).toBe(false)

    const loose = await simulateCreditRing(
      plan,
      { ...opts, tolerant, client: recorder(2n).client },
      DEADLINE,
    )
    expect(loose.ok).toBe(true)

    // Nothing settled is nothing to send, whatever the route promised.
    const empty = await simulateCreditRing(
      plan,
      { ...opts, tolerant, client: recorder(0n).client },
      DEADLINE,
    )
    expect(empty.ok).toBe(false)
  })
})

describe('what carrying a fallback costs', () => {
  test('the first is dearer than the ones after it, and none is free', () => {
    expect(carriedFallbackGas(0)).toBe(0n)
    expect(carriedFallbackGas(1)).toBe(FALLBACK_FIRST_GAS)
    expect(carriedFallbackGas(3)).toBe(FALLBACK_FIRST_GAS + 2n * FALLBACK_MORE_GAS)
  })

  test('the break-even loss rate is carried over carried plus lost', () => {
    // `atomic 3, one leg gone` in `app/src/landing/gas.ts`, which `gen-gas.mjs` writes from
    // `contracts/test/Gas.t.sol` and CI checks. Quoted here because the SDK cannot import the
    // app, and pinned here so the arithmetic below is what moves if it ever does.
    // It read 196_001 here against a table that did not agree with it, and both moved with #130.
    const lost = 196_507n
    const carried = carriedFallbackGas(3)
    expect(carried).toBe(54_326n)
    expect(breakEvenLossRate(3, lost)).toBeCloseTo(Number(carried) / Number(carried + lost), 12)
    // About 22% for a three-leg ring, on gas alone.
    expect(breakEvenLossRate(3, lost)).toBeGreaterThan(0.21)
    expect(breakEvenLossRate(3, lost)).toBeLessThan(0.22)
    // Carrying none pays for itself at any rate, because it costs nothing.
    expect(breakEvenLossRate(0, lost)).toBe(0)
  })
})

/**
 * The swap that stands in for a leg that did not settle.
 *
 * The contract half is proven in `contracts/test/BatchExecutor.t.sol` — a fallback fires when its
 * leg is gone and stays out of the way when it is not. These prove the calldata a solver would
 * send to reach that: the flag lands in `leg`, the trade is the reverse of the missing maker's,
 * and the whole thing still round-trips through the tuple the executor decodes with.
 */
describe('a fallback for a leg that may not settle', () => {
  const LEG = 2
  // The missing maker sells B and wants C. So the executor never received their B, and is
  // holding the C it was going to pay them.
  const fallback: Fallback = {
    fill: LEG,
    position: LEG,
    market: priced(B, C, 1n, 1n),
    amountOutMin: ONE,
    amountIn: ONE * 2n,
    quoted: ONE,
    headroomBps: 10_000,
  }
  const built = () => fallbackSwap(fallback, EXEC, T0) as NonNullable<ReturnType<typeof fallbackSwap>>

  test('it carries the flag and the index, and the two come back apart', () => {
    const s = built()
    expect(s.leg & WHEN_ABSENT).toBe(WHEN_ABSENT)
    expect(s.leg & ~WHEN_ABSENT).toBe(BigInt(LEG))
    expect(s.leg).not.toBe(ANY_LEG)
  })

  test('it sells what the executor is left holding and buys what it is short', () => {
    const s = built()
    expect(s.tokenIn).toBe(C)
    expect(s.tokenOut).toBe(B)
    expect(s.amountIn).toBe(ONE * 2n)
  })

  test('the bound is what the missing leg was going to supply', () => {
    // Not a zero. An unbounded fallback would let a moved pool settle the ring at any price, and
    // the whole reason a ring may revert is that a bound was not met.
    const { args } = decodeFunctionData({ abi: ROUTER_ABI, data: built().data })
    expect(args?.[1]).toBe(ONE)
  })

  test('a market that cannot build its own call yet gives no fallback', () => {
    // An aggregator whose route comes from its own API can settle but cannot be searched. The
    // caller then has a leg it cannot cover, which is a reason to leave it uncovered.
    const blind: Fallback = { ...fallback, market: { ...fallback.market, swap: () => null } }
    expect(fallbackSwap(blind, EXEC, T0)).toBeNull()
  })

  test('a route carrying one survives the round trip the executor decodes with', () => {
    const route: Route = { legs: 3n, swaps: [built()], sweep: [B, C], disposal: [] }
    const [back] = decodeAbiParameters([ROUTE_TUPLE], encodeRoute(route)) as unknown as [Route]
    expect(back.swaps[0].leg).toBe(BigInt(LEG) | WHEN_ABSENT)
    expect(back.swaps[0].tokenIn).toBe(C)
  })
})

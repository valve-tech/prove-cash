import { describe, expect, test } from 'vitest'
import type { Address, Hex } from 'viem'
import { CURVE_LINEAR, FLAG_PARTIAL, ZERO, type SignedIntent, ZERO_HASH } from '../intent.js'
import { ANY_LEG, settleBatchCall, settleRingCall } from './abi.js'
import { isIndependent, packBatch } from './pack.js'
import type { MarketSwap, Plan } from './plan.js'
import { xykMarket } from './market.js'

const A = '0x00000000000000000000000000000000000000aa' as Address
const B = '0x00000000000000000000000000000000000000bb' as Address
const C = '0x00000000000000000000000000000000000000cc' as Address
const ROUTER = '0x00000000000000000000000000000000000000f0' as Address
const EXEC = '0x00000000000000000000000000000000000000be' as Address
const T0 = 1_800_000_000n
const ONE = 1_000_000_000_000_000_000n

let seq = 0
function intentOf(tokenIn: Address, tokenOut: Address, maker?: Address): SignedIntent {
  seq++
  const who = maker ?? (`0x${seq.toString(16).padStart(40, '0')}` as Address)
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

const poolSwap = (tokenIn: Address, tokenOut: Address): MarketSwap => ({
  market: xykMarket(
    { address: ROUTER, token0: tokenIn, token1: tokenOut, reserve0: ONE * 100n, reserve1: ONE * 100n } as never,
    tokenOut,
    tokenIn,
    ROUTER,
  ),
  amountIn: ONE,
  amountOutMin: ONE / 2n,
})

/** A plan with `n` fills. One fill is independent; more is a ring. */
function planOf(n: number, swap: MarketSwap | null, maxFeeRate = 0n, maker?: Address): Plan {
  const fills = Array.from({ length: n }, () => ({
    intent: intentOf(A, B, maker),
    take: ONE,
  }))
  return { fills, swap, maxFeeRate } as unknown as Plan
}

const opts = {
  batchExecutor: EXEC,
  deadline: T0 + 300n,
}

describe('what may share a tolerant batch', () => {
  test('one fill with its own swap is independent; anything else is not', () => {
    expect(isIndependent(planOf(1, poolSwap(A, B)))).toBe(true)
    expect(isIndependent(planOf(2, poolSwap(A, B)))).toBe(false)
    expect(isIndependent(planOf(3, poolSwap(A, B)))).toBe(false)
    // One fill and no swap looks independent and is not. See the next test.
    expect(isIndependent(planOf(1, null))).toBe(false)
  })

  test('a plan with no swap of its own is refused, because another leg would be paying it', () => {
    // The lab found this one, and no unit test would have. `ProveBatchExecutor` holds nothing
    // between transactions: a leg hands it token A and leaves it owing token B, so a plan with
    // no swap is relying on some other leg's release to pay its maker. That is a cycle, and a
    // cycle cannot survive one of its legs being stepped over.
    //
    // Four swapless legs went to the lab chain looking perfectly independent and the batch
    // reverted for 81,900 gas having filled nothing — correctly, because nothing in it could pay
    // anybody. Two of them, A for B and B for A, would have been worse: they pay each other, so
    // they settle right up until one is taken and the other is left unfunded.
    const out = packBatch([planOf(1, null)], opts)
    expect(out.fills).toHaveLength(0)
    expect(out.refused[0].why).toContain('another leg would have to pay its maker')
  })

  test('a ring is refused, and says why', () => {
    // The safety rule, and it is structural rather than a judgement. `Swap.leg` names ONE leg, so
    // the executor can drop a call when that leg goes. It cannot say "drop this if any of my
    // three legs goes", which is what a cycle needs: a cycle missing a leg has a different shape,
    // not a smaller one. So a ring keeps its own atomic transaction.
    const ring = planOf(3, poolSwap(A, B))
    const out = packBatch([ring], opts)

    expect(out.fills).toHaveLength(0)
    expect(out.packed).toHaveLength(0)
    expect(out.refused[0].why).toContain('atomically')
  })

  test('a ring beside independent plans holds the others up not at all', () => {
    const one = planOf(1, poolSwap(A, B))
    const ring = planOf(2, poolSwap(B, C))
    const two = planOf(1, poolSwap(B, C))

    const out = packBatch([one, ring, two], opts)

    expect(out.packed).toEqual([one, two])
    expect(out.refused.map((r) => r.plan)).toEqual([ring])
  })
})

describe('the leg each swap names', () => {
  test('a swap names the position of its own fill, not its position in the list', () => {
    // The plan with no swap sits between two that have one, so a swap list indexed by its own
    // order would point the second swap at the wrong leg. This is the bug the whole file exists
    // to make impossible, and it would settle the wrong trade rather than revert.
    const out = packBatch(
      [planOf(1, poolSwap(A, B)), planOf(1, poolSwap(A, C)), planOf(1, poolSwap(B, C))],
      opts,
    )

    expect(out.fills).toHaveLength(3)
    expect(out.route.swaps).toHaveLength(3)
    expect(out.route.swaps.map((s) => s.leg)).toEqual([0n, 1n, 2n])
  })

  test('no swap is left unconditional, because one that is takes the batch down with it', () => {
    const out = packBatch([planOf(1, poolSwap(A, B)), planOf(1, poolSwap(B, C))], opts)
    for (const s of out.route.swaps) expect(s.leg).not.toBe(ANY_LEG)
  })

  test('the route expects exactly the legs that went in', () => {
    const out = packBatch([planOf(1, poolSwap(A, B)), planOf(1, poolSwap(B, C))], opts)
    expect(out.route.legs).toBe(2n)
    expect(out.route.legs).toBe(BigInt(out.fills.length))
  })
})

describe('what the batch carries home', () => {
  test('every token any leg or swap touches is on the sweep list, once', () => {
    // A token left off rests in the executor rather than reaching the solver, and the executor's
    // mark makes that permanent.
    const out = packBatch([planOf(1, poolSwap(B, C)), planOf(1, poolSwap(A, B))], opts)
    const sweep = out.route.sweep.map((t) => t.toLowerCase())

    expect(sweep).toContain(A.toLowerCase())
    expect(sweep).toContain(B.toLowerCase())
    expect(sweep).toContain(C.toLowerCase())
    expect(new Set(sweep).size).toBe(sweep.length)
  })

  test('the fee bound is the highest of the plans, never the lowest', () => {
    // The settlement reads each leg's own rate and steps over a leg whose rate exceeds the bound.
    // Packing to the smallest bound would silently drop the dearest leg from every batch — which
    // still "succeeds", just with less in it, and nothing would ever say so.
    const p = (fee: bigint) => planOf(1, poolSwap(A, B), fee)
    const out = packBatch([p(300n), p(900n), p(100n)], opts)
    expect(out.maxFeeRate).toBe(900n)
  })
})

describe('two plans that cannot both settle', () => {
  test('an intent already spoken for in this batch is refused', () => {
    // One maker's intent spends once. Two plans naming it would settle the first and step over
    // the second, and the second's swap would then run for a leg that filled nothing.
    const shared = intentOf(A, B)
    const mk = (): Plan =>
      ({
        fills: [{ intent: shared, take: ONE }],
        swap: poolSwap(A, B),
        maxFeeRate: 0n,
      }) as unknown as Plan

    const out = packBatch([mk(), mk()], opts)

    expect(out.fills).toHaveLength(1)
    expect(out.refused[0].why).toContain('already spends that intent')
  })
})

describe('the size cap', () => {
  test('it stops at the cap and names the plans it could not take', () => {
    const many = Array.from({ length: 5 }, () => planOf(1, poolSwap(A, B)))
    const out = packBatch(many, { ...opts, maxLegs: 3 })

    expect(out.fills).toHaveLength(3)
    expect(out.refused).toHaveLength(2)
    expect(out.refused[0].why).toContain('full at 3')
  })
})

describe('the call it produces', () => {
  const fills = [{ intent: intentOf(A, B), take: ONE }]
  const route = { legs: 1n, swaps: [], sweep: [A, B] , disposal: [] }

  test('a batch is sent tolerantly and a ring is not', () => {
    // The one bit that separates them, checked on the encoded argument rather than trusted.
    expect(settleBatchCall(EXEC, fills, 0n, route).args[1]).toBe(true)
    expect(settleRingCall(EXEC, fills, 0n, route).args[1]).toBe(false)
  })

  test('both go to the same function on the same contract', () => {
    for (const call of [settleBatchCall(EXEC, fills, 0n, route), settleRingCall(EXEC, fills, 0n, route)]) {
      expect(call.address).toBe(EXEC)
      expect(call.functionName).toBe('settleRing')
    }
  })
})

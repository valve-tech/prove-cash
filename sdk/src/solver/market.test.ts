/**
 * A venue the engine has never heard of, driven through the engine.
 *
 * This is the acceptance test for the `Market` interface and it is written from the outside. The
 * market below is not constant product: it prices on a constant sum, it charges a flat ten basis
 * points, it encodes its own calldata under a selector nothing in this repository defines, and it
 * holds allowances at an address that is not the one it is called at. Every one of those breaks
 * an assumption the solver used to carry.
 *
 * Nothing under `sdk/src/solver/` mentions it. That is the whole claim: **adding a venue format
 * touches no file in the engine.** If a future change makes the engine need to know what kind of
 * market it is holding, this file stops compiling or stops passing, and that is the alarm.
 *
 * Why a fake and not Uniswap V3. A real format brings tick math or a quoter round trip, and this
 * test is not about either — it is about whether the seam holds. A format small enough to read in
 * one screen proves the seam and nothing else, which is what a seam test should do.
 */
import { describe, expect, test } from 'vitest'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { CURVE_LINEAR, FLAG_PARTIAL, ZERO, type SignedIntent, ZERO_HASH } from '../intent.js'
import { ANY_LEG, NO_PATCH } from './abi.js'
import { routeFor } from './execute.js'
import type { Market } from './market.js'
import { packBatch } from './pack.js'
import { solve, type Plan } from './plan.js'
import { buildBook, type BookEntry } from './book.js'

const A = '0x00000000000000000000000000000000000000aa' as Address
const B = '0x00000000000000000000000000000000000000bb' as Address
/** Where the venue is called. */
const POOL = '0x000000000000000000000000000000000000c0de' as Address
/** Where the venue takes its allowance. A router and its vault, and they are not the same. */
const VAULT = '0x000000000000000000000000000000000000d00d' as Address
const EXEC = '0x00000000000000000000000000000000000000be' as Address
const SOLVER = '0x0000000000000000000000000000000000005017' as Address

const T0 = 1_800_000_000n
const ONE = 10n ** 18n

/** The venue's own ABI. Nothing in the engine knows this shape and nothing needs to. */
const EXCHANGE_ABI = parseAbi([
  'function exchange(address from, address to, uint256 amountIn, uint256 minOut, address receiver)',
])

/**
 * A constant-sum market with a flat fee: one unit in buys one unit out, less ten basis points.
 *
 * Deliberately not the xyk curve. `amountIn` is linear, so a bisection over the size finds the
 * same answer at every probe, and `cap` is a balance rather than half a reserve.
 */
function sumMarket(receives: Address, pays: Address, balance: bigint): Market {
  const FEE_NUM = 9990n
  const FEE_DEN = 10_000n
  return {
    kind: 'sum',
    id: `sum:${POOL.toLowerCase()}:${receives.toLowerCase()}`,
    receives,
    pays,
    cap: () => balance,
    // Round up, so the market is never short of what it promised.
    amountIn: (take) => (take > balance ? null : (take * FEE_DEN + FEE_NUM - 1n) / FEE_NUM),
    rate: () => ({ num: FEE_DEN, den: FEE_NUM }),
    swap: (amountIn, minOut, to) => ({
      spender: VAULT,
      target: POOL,
      data: encodeFunctionData({
        abi: EXCHANGE_ABI,
        functionName: 'exchange',
        args: [pays, receives, amountIn, minOut, to],
      }),
    }),
  }
}

/** One maker: hands over `A`, wants `B`, and will take a tenth less than par for it. */
function bookOfOne(): ReturnType<typeof buildBook> {
  const maker = '0x0000000000000000000000000000000000000a11' as Address
  const intent: SignedIntent = {
    maker,
    recipient: maker,
    tokenIn: A,
    tokenOut: B,
    amountIn: ONE,
    minOutStart: (ONE * 9n) / 10n,
    minOutEnd: (ONE * 9n) / 10n,
    minFill: 0n,
    authNonce: `0x${'00'.repeat(32)}` as Hex,
    startTime: T0 - 60n,
    endTime: T0 + 1800n,
    executor: ZERO,
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    flags: FLAG_PARTIAL,
    nonce: 1n,
    curve: CURVE_LINEAR,
    signature: `0x${'11'.repeat(65)}` as Hex,
  }
  const entry: BookEntry = { key: 'market-test-1', intent, remaining: ONE, partial: true }
  return buildBook([entry], 943)
}

/**
 * The lookup the solver is given. It answers in one direction only — the executor receives `B`
 * and pays `A` — which is the direction that closes the maker's leg into a cycle.
 */
const markets = (receives: Address, pays: Address): Market | null =>
  receives.toLowerCase() === B && pays.toLowerCase() === A ? sumMarket(B, A, ONE * 100n) : null

function planned(): Plan {
  const plans = solve(bookOfOne(), {
    at: T0,
    executor: SOLVER,
    gasPrice: 0n,
    minNetNative: 0n,
    maxLegs: 2,
    markets,
  })
  expect(plans.length, 'the search found a ring through a market it knows nothing about').toBe(1)
  return plans[0]
}

describe('a venue format the engine was never taught', () => {
  test('the ring search closes a leg at it', () => {
    const plan = planned()
    expect(plan.swap?.market.kind).toBe('sum')
    // Two legs: the maker's intent, and the market that pays the maker.
    expect(plan.fills).toHaveLength(1)
    // It priced on the constant sum and not on a curve. Buying 0.9 B costs 0.9 A plus the fee,
    // where an xyk pool of the same size would have charged slippage on top.
    const take = plan.swap?.amountOutMin ?? 0n
    expect(take).toBeGreaterThan(0n)
    expect(plan.swap?.amountIn).toBe((take * 10_000n + 9989n) / 9990n)
  })

  test('a ring route carries the venue own calldata, unread', () => {
    const plan = planned()
    const route = routeFor(plan, { account: SOLVER, batchExecutor: EXEC, chainId: 943 }, T0 + 300n)
    expect(route.swaps).toHaveLength(1)
    const swap = route.swaps[0]
    expect(swap.target).toBe(POOL)
    // The allowance goes to the vault, not to the contract the call lands at. A solver that
    // approved `target` here would watch every swap revert on an allowance it believed it gave.
    expect(swap.spender).toBe(VAULT)
    expect(swap.spender).not.toBe(swap.target)
    expect(swap.data).toBe(
      encodeFunctionData({
        abi: EXCHANGE_ABI,
        functionName: 'exchange',
        args: [A, B, plan.swap?.amountIn ?? 0n, plan.swap?.amountOutMin ?? 0n, EXEC],
      }),
    )
    // A ring settles as a whole, so its swap belongs to no one leg and is never patched.
    expect(swap.leg).toBe(ANY_LEG)
    expect(swap.amountOffset).toBe(NO_PATCH)
  })

  test('a tolerant batch packs it, and ties the call to the leg that needs it', () => {
    const plan = planned()
    const out = packBatch([plan], { batchExecutor: EXEC, deadline: T0 + 300n })
    expect(out.refused).toHaveLength(0)
    expect(out.packed).toHaveLength(1)
    const swap = out.route.swaps[0]
    expect(swap.target).toBe(POOL)
    expect(swap.spender).toBe(VAULT)
    // Leg zero, so the executor steps over the call when it steps over the fill.
    expect(swap.leg).toBe(0n)
    // Both of the market's tokens come home, whatever kind of market it was.
    expect(out.route.sweep.map((t) => t.toLowerCase())).toEqual(
      expect.arrayContaining([A.toLowerCase(), B.toLowerCase()]),
    )
  })

  test('a market that cannot quote yet is left out rather than guessed at', () => {
    // An aggregator whose route comes from its own API can settle but cannot be searched. The
    // interface says so by returning null, and every caller has to survive it.
    const blind: Market = { ...sumMarket(B, A, ONE * 100n), swap: () => null }
    const plan = planned()
    const dark = { ...plan, swap: { ...plan.swap, market: blind } } as Plan
    const out = packBatch([dark], { batchExecutor: EXEC, deadline: T0 + 300n })
    expect(out.packed).toHaveLength(0)
    expect(out.refused[0].why).toContain('cannot build a swap')
    expect(() =>
      routeFor(dark, { account: SOLVER, batchExecutor: EXEC, chainId: 943 }, T0 + 300n),
    ).toThrow(/cannot build its own swap/)
  })
})

import { describe, expect, test } from 'vitest'
import { decodeAbiParameters, decodeFunctionData, type Address, type Hex } from 'viem'
import { CURVE_LINEAR, FLAG_PARTIAL, ZERO, ZERO_HASH, type SignedIntent } from '../intent.js'
import { callFor } from '../settlement.js'
import {
  ROUTE_TUPLE,
  SOLVER_BATCH_EXECUTOR_ABI,
  creditFillPlan,
  encodeRoute,
  pureRoute,
  routerSwap,
  settleRingCall,
  type Route,
} from './abi.js'
import { executeCreditRing, routeFor, simulateCreditRing, type ExecuteOptions } from './execute.js'
import type { MarketSwap, Plan } from './plan.js'
import { xykMarket } from './market.js'
import type { Pool } from './price.js'

/**
 * Settling a ring on credit, through `ProveBatchExecutor`.
 *
 * The contract's own tests prove that a ring settles from an address holding nothing. These
 * prove the calldata that gets it there: the right function on the right address, a route the
 * executor can decode, a sweep list that names every token, and proceeds aimed at the executor
 * rather than at the solver.
 */

const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN_B = '0x00000000000000000000000000000000000000bb' as Address
const TOKEN_C = '0x00000000000000000000000000000000000000cc' as Address
const ROUTER = '0x00000000000000000000000000000000000000f0' as Address
const SETTLEMENT = '0x00000000000000000000000000000000000000d0' as Address
const BATCH_EXECUTOR = '0x00000000000000000000000000000000000000be' as Address
const SOLVER = '0x00000000000000000000000000000000000000e0' as Address

const T0 = 1_800_000_000n
const ONE = 1_000_000_000_000_000_000n

let seq = 0

/**
 * An address, comparable.
 *
 * viem's decoder answers in EIP-55 checksum case and these fixtures are written in lower case,
 * so a direct comparison fails on capitalisation and says nothing about the address.
 */
const same = (a: string) => a.toLowerCase()

function intentOf(tokenIn: Address, tokenOut: Address): SignedIntent {
  seq++
  const maker = `0x${seq.toString(16).padStart(40, '0')}` as Address
  return {
    maker,
    recipient: maker,
    tokenIn,
    tokenOut,
    amountIn: ONE,
    minOutStart: (ONE * 99n) / 100n,
    minOutEnd: (ONE * 99n) / 100n,
    startTime: T0,
    endTime: T0 + 3600n,
    executor: ZERO,
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: FLAG_PARTIAL,
    nonce: BigInt(seq),
    curve: CURVE_LINEAR,
    signature: `0x${'11'.repeat(65)}` as Hex,
  }
}

const pool: Pool = {
  // A real pair has one, and the market's identity is built from it: two legs of one ring must
  // not be the same market twice. This fixture went without until markets carried an id, because
  // nothing on the old path ever read it.
  address: '0x00000000000000000000000000000000000000d0',
  venue: 'pulsex-v2',
  token0: TOKEN_B,
  token1: TOKEN_C,
  reserve0: ONE * 1_000n,
  reserve1: ONE * 1_000n,
  feeNum: 997n,
  feeDen: 1_000n,
} as unknown as Pool

/**
 * A plan carrying only what the credit path reads off one.
 *
 * `routeFor` reads the fills and the pool leg, `settleRingCall` reads the fills, and the leg
 * ordering reads `at` — it scores every leg against the clock the plan was priced at. Building a
 * whole ranked plan through the engine would price a market these tests say nothing about.
 */
function planOf(fills: SignedIntent[], swap: MarketSwap | null = null): Plan {
  return {
    fills: fills.map((intent) => ({ intent, take: intent.amountIn })),
    swap,
    maxFeeRate: 10n,
    gas: 400_000n,
    gasSimulated: false,
    at: T0,
  } as unknown as Plan
}

const poolLeg: MarketSwap = {
  market: xykMarket(pool, TOKEN_C, TOKEN_B, ROUTER),
  amountIn: ONE,
  amountOutMin: (ONE * 98n) / 100n,
}

const opts = (extra: Partial<ExecuteOptions> = {}): ExecuteOptions => ({
  account: SOLVER,
  chainId: 369,
  settlementAddress: SETTLEMENT,
  batchExecutor: BATCH_EXECUTOR,
  router: ROUTER,
  ...extra,
})

/** The `Route` tuple, from the compiler, so a decode here cannot drift from the encoder. */
const ROUTE_ABI = [ROUTE_TUPLE] as const

describe('the route the executor decodes', () => {
  test('a pure ring encodes and reads back unchanged', () => {
    const route = pureRoute(2, [TOKEN_A, TOKEN_B])
    const [back] = decodeAbiParameters(ROUTE_ABI, encodeRoute(route))

    expect(back.legs).toBe(2n)
    expect(back.swaps).toEqual([])
    expect(back.sweep.map(same)).toEqual([TOKEN_A, TOKEN_B])
  })

  test('a venue call survives the round trip whole', () => {
    const swap = routerSwap(ROUTER, TOKEN_B, TOKEN_C, ONE, ONE / 2n, BATCH_EXECUTOR, T0)
    const route: Route = { legs: 3n, swaps: [swap], sweep: [TOKEN_A, TOKEN_B, TOKEN_C] , disposal: [] }
    const [back] = decodeAbiParameters(ROUTE_ABI, encodeRoute(route))

    expect(back.legs).toBe(3n)
    expect(back.swaps).toHaveLength(1)
    expect(same(back.swaps[0]!.target)).toBe(ROUTER)
    expect(same(back.swaps[0]!.spender)).toBe(ROUTER)
    expect(back.swaps[0]!.amountIn).toBe(ONE)
    expect(back.swaps[0]!.data).toBe(swap.data)
    expect(back.swaps[0]!.extra).toEqual([])
  })

  /**
   * The proceeds go to the executor, never to the solver.
   *
   * The settlement pulls every payment out of the executor as soon as the callback returns, so a
   * venue paying the solver's own wallet pays it after the debt is due — and the ring reverts
   * with the money one hop away from where it was needed. The inventory path does the opposite,
   * because there the swap is the solver's own second transaction.
   */
  test('the venue pays the executor and not the solver', () => {
    const route = routeFor(planOf([intentOf(TOKEN_A, TOKEN_B)], poolLeg), opts(), T0)
    const call = decodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'swapExactTokensForTokens',
          inputs: [
            { name: 'amountIn', type: 'uint256' },
            { name: 'amountOutMin', type: 'uint256' },
            { name: 'path', type: 'address[]' },
            { name: 'to', type: 'address' },
            { name: 'deadline', type: 'uint256' },
          ],
          outputs: [],
          stateMutability: 'nonpayable',
        },
      ] as const,
      data: route.swaps[0]!.data,
    })

    expect(same(call.args[3])).toBe(BATCH_EXECUTOR)
    expect(same(call.args[3])).not.toBe(SOLVER)
    expect(call.args[1]).toBe(poolLeg.amountOutMin)
  })
})

describe('the route a plan resolves to', () => {
  test('the leg count is the fill count, which is what the executor checks against', () => {
    const plan = planOf([intentOf(TOKEN_A, TOKEN_B), intentOf(TOKEN_B, TOKEN_A)])
    expect(routeFor(plan, opts(), T0).legs).toBe(2n)
  })

  /**
   * Every output token is on the list, because the executor refuses the route otherwise.
   *
   * `OwedTokenNotSwept`. An unmarked output token is one the settlement could pull a maker's
   * payment out of a donation for, so the contract insists the caller marks it first.
   */
  test('the sweep names every token the ring pays out in', () => {
    const fills = [intentOf(TOKEN_A, TOKEN_B), intentOf(TOKEN_B, TOKEN_C)]
    const sweep = routeFor(planOf(fills), opts(), T0).sweep.map(same)

    for (const f of fills) expect(sweep).toContain(same(f.tokenOut))
  })

  test('a pure ring carries no venue call at all', () => {
    const plan = planOf([intentOf(TOKEN_A, TOKEN_B), intentOf(TOKEN_B, TOKEN_A)])
    expect(routeFor(plan, opts(), T0).swaps).toHaveLength(0)
  })

  /**
   * Every token the plan touches is on the sweep list, once.
   *
   * A token left off rests in the executor and belongs to whoever names it next. The list is
   * built from the plan rather than taken from a caller for exactly that reason.
   */
  test('the sweep names every token in the ring and the pool leg, once each', () => {
    const plan = planOf([intentOf(TOKEN_A, TOKEN_B), intentOf(TOKEN_B, TOKEN_A)], poolLeg)
    const sweep = routeFor(plan, opts(), T0).sweep

    expect(new Set(sweep)).toEqual(new Set([TOKEN_A, TOKEN_B, TOKEN_C]))
    expect(sweep).toHaveLength(3)
  })
})

describe('the call a solver signs', () => {
  test('it goes to the executor, not to the settlement', () => {
    const plan = planOf([intentOf(TOKEN_A, TOKEN_B), intentOf(TOKEN_B, TOKEN_A)])
    const call = settleRingCall(BATCH_EXECUTOR, plan.fills, plan.maxFeeRate, pureRoute(2, [TOKEN_A]))

    expect(call.address).toBe(BATCH_EXECUTOR)
    expect(call.address).not.toBe(SETTLEMENT)
    expect(call.functionName).toBe('settleRing')
    expect(call.abi).toBe(SOLVER_BATCH_EXECUTOR_ABI)
  })

  /** A ring is atomic or it is nothing, and the argument is not the caller's to choose. */
  test('skipInvalid is false, whatever anybody wants', () => {
    const plan = planOf([intentOf(TOKEN_A, TOKEN_B)])
    const call = settleRingCall(BATCH_EXECUTOR, plan.fills, 10n, pureRoute(1, [TOKEN_A]))
    expect(call.args[1]).toBe(false)
  })

  test('the fee bound the plan was priced at reaches the call', () => {
    const plan = planOf([intentOf(TOKEN_A, TOKEN_B)])
    const call = settleRingCall(BATCH_EXECUTOR, plan.fills, 7n, pureRoute(1, [TOKEN_A]))
    expect(call.args[2]).toBe(7n)
  })

  /**
   * The credit path needs an address the registry does not carry, so it says so.
   *
   * `sdk/src/config.ts` holds the settlement and nothing else, because everything else in a
   * deployment is reachable from it. A batch executor is not, so an operator names the one they
   * trust — and forgetting to is a refusal rather than a send to the zero address.
   */
  test('it refuses to build a ring with no executor named', async () => {
    const plan = planOf([intentOf(TOKEN_A, TOKEN_B)])
    const bare = { account: SOLVER, chainId: 369 as const, settlementAddress: SETTLEMENT }

    await expect(simulateCreditRing(plan, bare, T0)).rejects.toThrow(/ProveBatchExecutor/)
    await expect(
      executeCreditRing({} as never, plan, { ...bare, skipPreflight: true }, T0),
    ).rejects.toThrow(/ProveBatchExecutor/)
  })

  test('the wallet is asked to send settleRing on the executor', async () => {
    const writes: { address: Address; functionName: string }[] = []
    const wallet = {
      account: undefined,
      writeContract: async (c: { address: Address; functionName: string }) => {
        writes.push(c)
        return '0xfeed' as Hex
      },
    }
    const plan = planOf([intentOf(TOKEN_A, TOKEN_B), intentOf(TOKEN_B, TOKEN_A)])

    await executeCreditRing(wallet as never, plan, opts({ skipPreflight: true }), T0)

    expect(writes).toHaveLength(1)
    expect(writes[0]!.address).toBe(BATCH_EXECUTOR)
    expect(writes[0]!.functionName).toBe('settleRing')
  })
})

/**
 * The one blob both sides are pinned to.
 *
 * `contracts/test/BatchExecutor.t.sol` carries the same bytes and decodes them with the real
 * `abi.decode(data, (Route))`. Without a shared fixture each side can agree with itself and
 * still disagree with the other, and a wrong encoding does not fail a test — it reverts on
 * chain, at the executor's expense. Change one copy and the other fails.
 */
const PINNED_ROUTE =
  '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000038000000000000000000000000000000000000000000000000000000000000003a00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000bb0000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000cc00000000000000000000000000000000000000000000000000000000000000f000000000000000000000000000000000000000000000000000000000000000f0000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000002a0ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010438ed17390000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000006f05b59d3b2000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000be000000000000000000000000000000000000000000000000000000006b49d200000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000bb00000000000000000000000000000000000000000000000000000000000000cc0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000300000000000000000000000000000000000000000000000000000000000000aa00000000000000000000000000000000000000000000000000000000000000bb00000000000000000000000000000000000000000000000000000000000000cc' as Hex

describe('the wire format both sides are pinned to', () => {
  test('the encoder still produces the bytes the executor is tested against', () => {
    const swap = routerSwap(ROUTER, TOKEN_B, TOKEN_C, ONE, ONE / 2n, BATCH_EXECUTOR, T0)
    const route: Route = { legs: 2n, swaps: [swap], sweep: [TOKEN_A, TOKEN_B, TOKEN_C] , disposal: [] }

    expect(encodeRoute(route)).toBe(PINNED_ROUTE)
  })
})

describe('the same ring as a FillPlan', () => {
  /**
   * One place builds the settlement's argument order, and it is `settlement.ts`. This only
   * supplies the blob, so a change to `fillBatchWithCallback` cannot need two edits.
   */
  test('credit mode carries the encoded route as its callback data', () => {
    const route = pureRoute(2, [TOKEN_A, TOKEN_B])
    const plan = planOf([intentOf(TOKEN_A, TOKEN_B), intentOf(TOKEN_B, TOKEN_A)])
    const call = callFor(creditFillPlan(plan.fills, 1000000000000000n, route), 369)

    expect(call.functionName).toBe('fillBatchWithCallback')
    expect(call.args[1]).toBe(false)
    expect(call.args[2]).toBe(encodeRoute(route))
    expect(call.args[3]).toBe(1000000000000000n)
  })
})

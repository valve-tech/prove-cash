import { describe, expect, test } from 'vitest'
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem'
import { CURVE_LINEAR, FLAG_PARTIAL, ZERO, ZERO_HASH, type SignedIntent } from '../intent.js'
import { ROUTER_ABI, SOLVER_EXECUTOR_ABI, executorFillCall, executorRouterSwap } from './abi.js'

/**
 * Filling one intent with no inventory, through `ProveExecutor`.
 *
 * `contracts/test/Executor.t.sol` proves that an address holding nothing fills an intent and
 * keeps the spread. These prove the calldata that gets it there: the right function on the right
 * address, an intent tuple the compiler's own ABI accepts, and a venue call aimed at the executor
 * rather than at the bot that sent it.
 *
 * The encoding is the part a type checker cannot reach. Every argument goes out through an `as
 * never`, because viem's inference gives up on an ABI this size, so a tuple with a field in the
 * wrong place still compiles and still deploys — and reverts on chain at the caller's expense.
 * Encoding against the generated ABI here is what catches it.
 */

const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN_B = '0x00000000000000000000000000000000000000bb' as Address
const WPLS = '0x00000000000000000000000000000000000000ff' as Address
const ROUTER = '0x00000000000000000000000000000000000000f0' as Address
const EXECUTOR = '0x00000000000000000000000000000000000000e1' as Address
const BOT = '0x00000000000000000000000000000000000000e0' as Address

const T0 = 1_800_000_000n
const ONE = 1_000_000_000_000_000_000n

/** viem answers in EIP-55 checksum case; these fixtures are lower case. */
const same = (a: string) => a.toLowerCase()

const intent: SignedIntent = {
  maker: TOKEN_A,
  recipient: TOKEN_A,
  tokenIn: TOKEN_A,
  tokenOut: TOKEN_B,
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
  nonce: 1n,
  curve: CURVE_LINEAR,
  signature: `0x${'11'.repeat(65)}` as Hex,
}

const swapOf = (path: readonly Address[], amountOutMin = ONE / 2n) =>
  executorRouterSwap(ROUTER, ONE, amountOutMin, path, EXECUTOR, T0)

describe('the venue call the executor hands to its sink', () => {
  test('the router is both the target and the spender', () => {
    const swap = swapOf([TOKEN_A, TOKEN_B])

    expect(same(swap.target)).toBe(ROUTER)
    expect(same(swap.spender)).toBe(ROUTER)
    expect(swap.extra).toEqual([])
  })

  /**
   * The proceeds go to the executor, never to the bot.
   *
   * The settlement pulls the maker's payment out of the executor the moment the callback
   * returns. A venue paying the bot's own wallet pays it after the debt is due, and the fill
   * reverts with the money one hop from where it was needed.
   */
  test('the venue pays the executor and not the bot', () => {
    const { args } = decodeFunctionData({ abi: ROUTER_ABI, data: swapOf([TOKEN_A, TOKEN_B]).data })

    expect(same(args[3] as string)).toBe(EXECUTOR)
    expect(same(args[3] as string)).not.toBe(BOT)
  })

  test('the hop through WPLS keeps all three tokens, in order', () => {
    const { args } = decodeFunctionData({
      abi: ROUTER_ABI,
      data: swapOf([TOKEN_A, WPLS, TOKEN_B]).data,
    })

    expect((args[2] as readonly string[]).map(same)).toEqual([TOKEN_A, WPLS, TOKEN_B])
  })

  /** The bound the fill is protected by. A pool that moves past it reverts at the router. */
  test('amountOutMin reaches the calldata unchanged', () => {
    const { args } = decodeFunctionData({
      abi: ROUTER_ABI,
      data: swapOf([TOKEN_A, TOKEN_B], 12_345n).data,
    })

    expect(args[0]).toBe(ONE)
    expect(args[1]).toBe(12_345n)
  })
})

describe('the fill the bot sends', () => {
  test('it calls fill on the executor, and not on the settlement', () => {
    const call = executorFillCall(EXECUTOR, intent, ONE, 10n, swapOf([TOKEN_A, TOKEN_B]))

    expect(call.address).toBe(EXECUTOR)
    expect(call.functionName).toBe('fill')
    expect(call.abi).toBe(SOLVER_EXECUTOR_ABI)
  })

  test('every argument encodes against the compiler’s own ABI and reads back whole', () => {
    const swap = swapOf([TOKEN_A, TOKEN_B])
    const call = executorFillCall(EXECUTOR, intent, ONE / 4n, 10n, swap)
    const decoded = decodeFunctionData({
      abi: SOLVER_EXECUTOR_ABI,
      data: encodeFunctionData({
        abi: SOLVER_EXECUTOR_ABI,
        functionName: 'fill',
        args: call.args as never,
      }),
    })

    // `decodeFunctionData` answers with the union of every function in the ABI, so the shape is
    // read back position by position rather than destructured into one tuple type.
    const args = decoded.args as readonly unknown[]
    const i = args[0] as Record<string, unknown>
    const wire = args[4] as { target: Address; data: Hex }

    expect(same(i.tokenIn as string)).toBe(TOKEN_A)
    expect(same(i.tokenOut as string)).toBe(TOKEN_B)
    expect(i.amountIn).toBe(ONE)
    expect(i.nonce).toBe(1n)
    expect(args[1]).toBe(intent.signature)
    expect(args[2]).toBe(ONE / 4n)
    expect(args[3]).toBe(10n)
    expect(wire.data).toBe(swap.data)
    expect(same(wire.target)).toBe(ROUTER)
  })
})

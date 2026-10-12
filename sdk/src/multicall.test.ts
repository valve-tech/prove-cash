import {
  createPublicClient,
  decodeFunctionData,
  defineChain,
  encodeErrorResult,
  encodeFunctionResult,
  http,
  multicall3Abi,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { beforeEach, describe, expect, test } from 'vitest'
import { batchRead, forgetMulticallProbes, MULTICALL3, MULTICALL_MAX_CALLDATA, type Call } from './multicall.js'

/**
 * Telling a reverted call from an unreachable endpoint.
 *
 * These two error chains are transcribed from real viem failures, not invented: a dead host and
 * an address with no code, both read through `readContract` on viem 2.55. They share an outer
 * `ContractFunctionExecutionError`, which is exactly why an earlier classifier matched that name
 * and called a dead socket an answer — the bug it existed to prevent.
 *
 * The distinction is load-bearing. A revert is cached and reported as market structure; an
 * unreadable result is retried and reported as an endpoint problem. Getting it backwards puts a
 * sentence like "this chain has no constant-product router" on screen because of a rate limit.
 */

/** An error chain, outermost first, as `{name, message}` pairs. */
function chainOf(levels: { name: string; message: string }[]): Error {
  let cause: unknown
  for (const level of [...levels].reverse()) {
    const e = new Error(level.message) as Error & { cause?: unknown }
    e.name = level.name
    e.cause = cause
    cause = e
  }
  return cause as Error
}

const DEAD_HOST = chainOf([
  { name: 'ContractFunctionExecutionError', message: 'HTTP request failed.' },
  { name: 'CallExecutionError', message: 'HTTP request failed.' },
  { name: 'HttpRequestError', message: 'HTTP request failed.' },
  { name: 'TypeError', message: 'fetch failed' },
  { name: 'Error', message: 'bad port' },
])

const NO_CODE = chainOf([
  { name: 'ContractFunctionExecutionError', message: 'The contract function "factory" returned no data ("0x").' },
  { name: 'ContractFunctionZeroDataError', message: 'The contract function "factory" returned no data ("0x").' },
  { name: 'AbiDecodingZeroDataError', message: 'Cannot decode zero data ("0x") with ABI parameters.' },
])

const RATE_LIMITED = chainOf([
  { name: 'ContractFunctionExecutionError', message: 'HTTP request failed.' },
  { name: 'HttpRequestError', message: 'HTTP request failed. Status: 429' },
])

const REVERT_WITH_REASON = chainOf([
  { name: 'ContractFunctionExecutionError', message: 'The contract function "factory" reverted.' },
  { name: 'ContractFunctionRevertedError', message: 'execution reverted: not a pair' },
])

/** A client whose single reads always throw the given error. Multicall is reported absent. */
function throwing(error: unknown) {
  return {
    chain: { id: 943 },
    getCode: async () => '0x',
    readContract: async () => {
      throw error
    },
  } as never
}

const ONE: Call = {
  address: '0x0000000000000000000000000000000000000001',
  abi: [] as never,
  functionName: 'factory',
}

describe('batchRead classifies why a call failed', () => {
  test('a dead host is unreadable', async () => {
    expect(await batchRead([ONE], throwing(DEAD_HOST))).toEqual([{ ok: false, reason: 'unreadable' }])
  })

  test('a rate limit is unreadable', async () => {
    expect(await batchRead([ONE], throwing(RATE_LIMITED))).toEqual([{ ok: false, reason: 'unreadable' }])
  })

  test('an address with no code is a revert — the node answered', async () => {
    expect(await batchRead([ONE], throwing(NO_CODE))).toEqual([{ ok: false, reason: 'reverted' }])
  })

  test('a revert with a reason is a revert', async () => {
    expect(await batchRead([ONE], throwing(REVERT_WITH_REASON))).toEqual([
      { ok: false, reason: 'reverted' },
    ])
  })

  test('an error shape nobody has seen before is unreadable, not an answer', async () => {
    // Fail towards the harmless mistake: an unnecessary retry, never an invented fact.
    expect(await batchRead([ONE], throwing(new Error('something new')))).toEqual([
      { ok: false, reason: 'unreadable' },
    ])
  })

  test('a multicall failure that carries a revert is a revert', async () => {
    // A chain id of its own: `supported()` caches its Multicall3 probe per chain for the life of
    // the process, and the tests above have already recorded 943 as having none.
    const client = {
      chain: { id: 1 },
      getCode: async () => '0x60806040',
      multicall: async () => [
        { status: 'failure' as const, error: REVERT_WITH_REASON },
        { status: 'success' as const, result: 7n },
      ],
    } as never
    expect(await batchRead([ONE, ONE], client)).toEqual([
      { ok: false, reason: 'reverted' },
      { ok: true, value: 7n },
    ])
  })

  test('a multicall failure with no error is unreadable, not a revert', async () => {
    // viem always attaches an error. Without one there is no evidence that the chain replied.
    const client = {
      chain: { id: 2 },
      getCode: async () => '0x60806040',
      multicall: async () => [{ status: 'failure' as const }],
    } as never
    expect(await batchRead([ONE], client)).toEqual([{ ok: false, reason: 'unreadable' }])
  })
})

/**
 * `batchRead` through viem's own `multicall`, with only `fetch` stubbed.
 *
 * The fakes above hand `batchRead` a result that somebody typed. These tests let viem 2.55 build
 * the result itself, so they fail if viem changes how it reports a failure. That matters because
 * the defect lived exactly there: with `allowFailure`, viem does not throw when an `eth_call` is
 * rejected. It marks every call in that chunk `failure`, and `batchRead` called each one a
 * revert. On the live board a 429 then read as "no route" on every row.
 */
describe("batchRead through viem's own multicall", () => {
  beforeEach(forgetMulticallProbes)

  const ROUTER = parseAbi([
    'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  ])
  const ERROR = parseAbi(['error Error(string)'])
  const TOKEN_A: Address = `0x${'aa'.repeat(20)}`
  const TOKEN_B: Address = `0x${'bb'.repeat(20)}`
  const leg = (router: number): Call => ({
    address: `0x${router.toString(16).padStart(40, '0')}`,
    abi: ROUTER,
    functionName: 'getAmountsOut',
    args: [10n ** 18n, [TOKEN_A, TOKEN_B]],
  })

  /** What the stub node does with one call inside an `aggregate3`. */
  type Reply = 'priced' | 'reverts with reason' | 'reverts bare' | 'no code'

  /**
   * A viem client over an `http` transport whose `fetch` plays a node. `reject(n)` turns the
   * n-th `eth_call` (from 0) into the given HTTP failure. Retries are off, as in `rpcClient`.
   */
  function node(reply: (target: Address) => Reply, reject: (n: number) => Response | null) {
    let ethCalls = 0
    /** Calldata bytes of every `eth_call` the node received. */
    const sizes: number[] = []
    const client = createPublicClient({
      chain: defineChain({
        id: 9_430,
        name: 'stub',
        nativeCurrency: { name: 'T', symbol: 'T', decimals: 18 },
        rpcUrls: { default: { http: ['http://rpc.test'] } },
      }),
      transport: http('http://rpc.test', {
        retryCount: 0,
        fetchFn: async (_url, init) => {
          const req = JSON.parse(String(init?.body)) as { id: number; method: string; params: [{ to: Address; data: Hex }] }
          const answer = (result: unknown) =>
            new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
          if (req.method === 'eth_getCode') return answer('0x60806040')
          sizes.push((req.params[0].data.length - 2) / 2)
          const failed = reject(ethCalls++)
          if (failed) return failed
          expect(req.params[0].to.toLowerCase()).toBe(MULTICALL3.toLowerCase())
          // `multicall3Abi` holds several functions, so the decoded arguments are a union.
          const [calls] = decodeFunctionData({ abi: multicall3Abi, data: req.params[0].data })
            .args as unknown as [readonly { target: Address }[]]
          const out = calls.map((c) => {
            switch (reply(c.target)) {
              case 'priced':
                return {
                  success: true,
                  returnData: encodeFunctionResult({ abi: ROUTER, functionName: 'getAmountsOut', result: [1n, 2n] }),
                }
              case 'reverts with reason':
                return {
                  success: false,
                  returnData: encodeErrorResult({ abi: ERROR, errorName: 'Error', args: ['PulseXLibrary: INSUFFICIENT_LIQUIDITY'] }),
                }
              case 'reverts bare':
                return { success: false, returnData: '0x' as Hex }
              case 'no code':
                // Multicall3 reports a call to an address with no code as a success with no bytes.
                return { success: true, returnData: '0x' as Hex }
            }
          })
          return answer(encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: out }))
        },
      }),
    })
    return { client, ethCalls: () => ethCalls, sizes }
  }

  /** The body the live endpoint sent. */
  const RATE_LIMIT_JSON = () =>
    new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'Rate limit exceeded (per method, per second)' } }),
      { status: 429 },
    )
  /** A proxy in front of the node that answers in plain text. */
  const RATE_LIMIT_TEXT = () => new Response('Too Many Requests', { status: 429 })

  test('a whole chunk rejected with a 429 is unreadable, not reverted', async () => {
    const { client } = node(() => 'priced', () => RATE_LIMIT_JSON())
    expect(await batchRead([leg(1), leg(2), leg(3)], client)).toEqual([
      { ok: false, reason: 'unreadable' },
      { ok: false, reason: 'unreadable' },
      { ok: false, reason: 'unreadable' },
    ])
  })

  test('a plain-text 429 from a proxy is unreadable too', async () => {
    const { client } = node(() => 'priced', () => RATE_LIMIT_TEXT())
    expect(await batchRead([leg(1)], client)).toEqual([{ ok: false, reason: 'unreadable' }])
  })

  test('a 500 from the endpoint is unreadable', async () => {
    const { client } = node(() => 'priced', () => new Response('upstream down', { status: 500 }))
    expect(await batchRead([leg(1)], client)).toEqual([{ ok: false, reason: 'unreadable' }])
  })

  test('a genuine revert inside a returned multicall stays reverted', async () => {
    const replies: Reply[] = ['priced', 'reverts with reason', 'reverts bare', 'no code']
    const { client } = node((target) => replies[Number(BigInt(target)) - 1]!, () => null)
    expect(await batchRead([leg(1), leg(2), leg(3), leg(4)], client)).toEqual([
      { ok: true, value: [1n, 2n] },
      { ok: false, reason: 'reverted' },
      { ok: false, reason: 'reverted' },
      { ok: false, reason: 'reverted' },
    ])
  })

  /** One quote call after `aggregate3` wraps it: 164 bytes of calldata, padded, plus 160. */
  const WRAPPED_LEG_BYTES = 352

  test('a board-sized batch goes out as one eth_call', async () => {
    // Measured on live 943: viem's 1 KB default split one board pass into 8 `eth_call`s, and the
    // endpoint's per-second limit refused the next pass whole. 84 legs is a 21-row board on two
    // venues with both paths each.
    const { client, ethCalls } = node(() => 'priced', () => null)
    const out = await batchRead(Array.from({ length: 84 }, (_, i) => leg(i + 1)), client)
    expect(out.every((r) => r.ok)).toBe(true)
    expect(ethCalls()).toBe(1)
  })

  /** Header of one `aggregate3` call: selector, array offset, array length. */
  const HEADER = 4 + 32 + 32

  test('no eth_call passes the size ceiling, however small the calls are', async () => {
    // A 4-byte getter grows 48 times inside `aggregate3`. Measured on 943: 900 small calls under a
    // fixed 32 KB inner limit made a 394 KB body, and the gateway refused it with HTTP 413.
    const getter: Call = { address: TOKEN_A, abi: parseAbi(['function token0() view returns (address)']), functionName: 'token0' }
    const { client, sizes } = node(() => 'no code', () => null)
    await batchRead(Array.from({ length: 2_000 }, () => getter), client)
    expect(sizes.length).toBeGreaterThan(1)
    for (const s of sizes) expect(s).toBeLessThanOrEqual(MULTICALL_MAX_CALLDATA + HEADER)
  })

  test('a mix of quote legs and small getters stays under the ceiling too', async () => {
    const getter: Call = { address: TOKEN_A, abi: parseAbi(['function token0() view returns (address)']), functionName: 'token0' }
    const calls = Array.from({ length: 1_500 }, (_, i) => (i % 3 === 0 ? leg(i + 1) : getter))
    const { client, sizes } = node(() => 'no code', () => null)
    const out = await batchRead(calls, client)
    expect(out).toHaveLength(calls.length)
    expect(sizes.length).toBeGreaterThan(1)
    for (const s of sizes) expect(s).toBeLessThanOrEqual(MULTICALL_MAX_CALLDATA + HEADER)
  })

  test('one chunk rejected and one answered: only the rejected calls are unreadable', async () => {
    // Enough calls to overflow one chunk, so viem sends two `eth_call`s. The node answers the
    // first and rate-limits the second.
    const { client, ethCalls } = node(
      () => 'reverts bare',
      (n) => (n === 1 ? RATE_LIMIT_JSON() : null),
    )
    const calls = Array.from({ length: Math.ceil(MULTICALL_MAX_CALLDATA / WRAPPED_LEG_BYTES) + 4 }, (_, i) => leg(i + 1))
    const out = await batchRead(calls, client)
    expect(ethCalls(), 'the batch really was split').toBe(2)
    const reasons = out.map((r) => (r.ok ? 'ok' : r.reason))
    const firstUnreadable = reasons.indexOf('unreadable')
    expect(firstUnreadable).toBeGreaterThan(0)
    expect(reasons.slice(0, firstUnreadable).every((r) => r === 'reverted')).toBe(true)
    expect(reasons.slice(firstUnreadable).every((r) => r === 'unreadable')).toBe(true)
  })
})

/**
 * The Multicall3 probe is asked once per chain and remembered. A failed probe is not an answer.
 *
 * Caching `false` on a dropped request demoted every batch read for the life of the tab — a board
 * poll that costs one round trip quietly costing forty, for ever, with nothing on screen to say
 * why. Same rule as `CallResult`: only a reply gets remembered.
 */
describe('the Multicall3 probe', () => {
  beforeEach(forgetMulticallProbes)

  /** A client that answers `getCode` from a script, one entry per call. */
  function chain(script: (string | Error)[]) {
    let i = 0
    const seen: number[] = []
    const client = {
      chain: { id: 943 },
      getCode: async () => {
        seen.push(++i)
        const v = script[Math.min(i - 1, script.length - 1)]!
        if (v instanceof Error) throw v
        return v
      },
      readContract: async () => 1n,
      multicall: async () => [{ status: 'success', result: 1n }],
    } as unknown as Parameters<typeof batchRead>[1]
    return { client, calls: () => seen.length }
  }

  const one = { address: `0x${'11'.repeat(20)}`, abi: [], functionName: 'x' } as never

  test('asks the chain once when it answers', async () => {
    const c = chain(['0x60006000'])
    await batchRead([one], c.client)
    await batchRead([one], c.client)
    expect(c.calls()).toBe(1)
  })

  test('a dropped probe is asked again, not remembered as absent', async () => {
    const c = chain([new Error('the endpoint dropped it'), '0x60006000'])
    await batchRead([one], c.client)
    await batchRead([one], c.client)
    expect(c.calls()).toBe(2)
  })

  test('a chain that truly has no Multicall3 is asked once', async () => {
    // Empty code is an answer, and answers are remembered.
    const c = chain(['0x'])
    await batchRead([one], c.client)
    await batchRead([one], c.client)
    expect(c.calls()).toBe(1)
  })
})

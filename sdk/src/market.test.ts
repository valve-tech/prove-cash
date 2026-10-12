import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import {
  createPublicClient,
  decodeFunctionData,
  defineChain,
  encodeFunctionResult,
  http,
  multicall3Abi,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { NETWORKS, xykVenues } from './config.js'
import { memoryKeyValueStore, setKeyValueStore } from './kv.js'
import { clearVenueProbes, confirmVenues, liveVenues, quoteAll } from './market.js'
import { MULTICALL3 } from './multicall.js'
import { PULSEX_FEE_DEN, poolAmountOut, type Pool } from './solver/price.js'

/**
 * The market layer against a chain it cannot surprise.
 *
 * Two things are being held here. One: a pair listed on two venues has two unrelated pools, and
 * the quote must be the better of them — mainnet PulseX v1 and v2 disagree by basis points in
 * every block, and picking the wrong one hands a maker the worse rate. Two: another venue must
 * cost entries in the multicall and never another round trip, which is why every test below
 * counts the batches the fake chain was asked for.
 */

/** One call as the fake chain sees it. The ABI is irrelevant to the answer. */
type Seen = { address: Address; functionName: string; args?: readonly unknown[] }

/**
 * The two failures viem 2.55 attaches to a call in a multicall, made by viem itself.
 *
 * `rejectedChunk` is what every call in an `eth_call` the endpoint refused carries: here, the
 * live endpoint's own 429 body. `reverted` is a router that ran and reverted. Typing these shapes
 * by hand would test the fake, not viem.
 */
const VIEM_ERRORS: { rejectedChunk: unknown; reverted: unknown } = { rejectedChunk: null, reverted: null }

beforeAll(async () => {
  const routerAbi = parseAbi(['function getAmountsOut(uint256, address[]) view returns (uint256[])'])
  let refuse = true
  const client = createPublicClient({
    chain: defineChain({
      id: 99_369,
      name: 'stub',
      nativeCurrency: { name: 'T', symbol: 'T', decimals: 18 },
      rpcUrls: { default: { http: ['http://rpc.test'] } },
    }),
    transport: http('http://rpc.test', {
      retryCount: 0,
      fetchFn: async (_url, init) => {
        const req = JSON.parse(String(init?.body)) as { id: number; params: [{ data: Hex }] }
        if (refuse) {
          const error = { code: -32005, message: 'Rate limit exceeded (per method, per second)' }
          return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error }), { status: 429 })
        }
        // `multicall3Abi` holds several functions, so the decoded arguments are a union.
        const [calls] = decodeFunctionData({ abi: multicall3Abi, data: req.params[0].data })
          .args as unknown as [readonly { target: Address }[]]
        const result = encodeFunctionResult({
          abi: multicall3Abi,
          functionName: 'aggregate3',
          result: calls.map(() => ({ success: false, returnData: '0x' as Hex })),
        })
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }))
      },
    }),
  })
  const call = { address: A, abi: routerAbi, functionName: 'getAmountsOut', args: [ONE, [A, B]] } as const
  const once = () => client.multicall({ contracts: [call], multicallAddress: MULTICALL3 })
  VIEM_ERRORS.rejectedChunk = (await once())[0].error
  refuse = false
  VIEM_ERRORS.reverted = (await once())[0].error
  // Guard the fixture: a null here would make every failure unreadable, and the tests would pass
  // without exercising the chunk path at all.
  // `toHaveProperty`, not an object literal: `gen-abi.mjs --check` reads every quoted function
  // name in an object as a call to one of our contracts, and these are fields of viem's errors.
  expect(VIEM_ERRORS.rejectedChunk).toMatchObject({ contractAddress: MULTICALL3 })
  expect(VIEM_ERRORS.rejectedChunk).toHaveProperty('functionName', 'aggregate3')
  expect(VIEM_ERRORS.reverted).toHaveProperty('functionName', 'getAmountsOut')
})

/** An `answer` for a call whose `eth_call` the endpoint refused. */
const UNREADABLE = Symbol('unreadable')

/**
 * A chain that answers from a table and records every batch. `undefined` from `answer` is a
 * reverted call, which is how a router reports a pair it does not list. `UNREADABLE` is a call
 * whose chunk the endpoint rate-limited. Each failure carries the error viem really attaches.
 */
function fakeChain(id: number, answer: (c: Seen) => unknown) {
  const batches: Seen[][] = []
  const client = {
    chain: { id },
    getCode: async () => '0x60806040',
    getBlockNumber: async () => 1_000n,
    multicall: async ({ contracts }: { contracts: Seen[] }) => {
      batches.push(contracts)
      return contracts.map((c) => {
        const v = answer(c)
        if (v === UNREADABLE) return { status: 'failure' as const, error: VIEM_ERRORS.rejectedChunk }
        return v === undefined
          ? { status: 'failure' as const, error: VIEM_ERRORS.reverted }
          : { status: 'success' as const, result: v }
      })
    },
  }
  return { client: client as never, batches }
}

const V2 = NETWORKS[369].xyk[0]
const V1 = NETWORKS[369].xyk[1]
const TESTNET = NETWORKS[943].xyk[0]

const A = '0x00000000000000000000000000000000000000aa' as Address
const B = '0x00000000000000000000000000000000000000bb' as Address

const ONE = 10n ** 18n

/** The registry's factory answer, so `confirmVenues` keeps every venue unless a test says not. */
const honestFactory = (c: Seen): unknown => {
  if (c.functionName !== 'factory') return undefined
  return [...xykVenues(369), ...xykVenues(943)].find(
    (v) => v.router.toLowerCase() === c.address.toLowerCase(),
  )?.factory
}

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  clearVenueProbes()
})

describe('confirming a venue against the chain', () => {
  test('keeps a router whose factory is the one the registry recorded', async () => {
    const { client, batches } = fakeChain(369, honestFactory)
    const live = await liveVenues({ client, chainId: 369 })
    expect(live.map((v) => v.label)).toEqual(['v2', 'v1'])
    // Both routers in one batch. Two venues is not two round trips.
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(2)
  })

  test('drops a router that answers a different factory', async () => {
    // A stale registry entry reads pairs out of the wrong factory and reports "no pool" for
    // pairs that plainly exist. Silence is the wrong answer, so the venue is dropped instead.
    const { client } = fakeChain(369, (c) =>
      c.address.toLowerCase() === V1.router.toLowerCase() ? A : honestFactory(c),
    )
    const live = await liveVenues({ client, chainId: 369 })
    expect(live.map((v) => v.label)).toEqual(['v2'])
  })

  test('drops a router with no code, which is what a reverted factory() looks like', async () => {
    const { client } = fakeChain(943, () => undefined)
    expect(await liveVenues({ client, chainId: 943 })).toEqual([])
  })

  test('a rate-limited probe is not cached as "no venue"', async () => {
    // The bug this pins: `.catch(() => false)` recorded an unreadable probe as an absent venue
    // and cached it for the life of the process. One 429 during the first chart render meant
    // every later chart said "this chain has no constant-product router" until a reload — a
    // permanent claim about a chain, from a transient failure.
    let failing = true
    const client = {
      chain: { id: 369 },
      getCode: async () => '0x60806040',
      getBlockNumber: async () => 1_000n,
      multicall: async ({ contracts }: { contracts: Seen[] }) => {
        if (failing) throw new Error('HTTP request failed: 429 Too Many Requests')
        return contracts.map((c: Seen) => {
          const v = honestFactory(c)
          return v === undefined
            ? { status: 'failure' as const, error: VIEM_ERRORS.reverted }
            : { status: 'success' as const, result: v }
        })
      },
      readContract: async () => {
        if (failing) throw new Error('HTTP request failed: 429 Too Many Requests')
        return undefined
      },
    } as never

    let told = 0
    expect(await liveVenues({ client, chainId: 369, onReadFailure: () => told++ })).toEqual([])
    expect(told, 'the caller is told it was a failed read, not an empty chain').toBeGreaterThan(0)

    // The endpoint recovers. Nothing was cached, so the venues come back without a reload.
    failing = false
    const live = await liveVenues({ client, chainId: 369 })
    expect(live.map((v) => v.label)).toEqual(['v2', 'v1'])
  })

  test('every caller sharing one probe hears that it failed, not just the first', async () => {
    // Two panels mount together and race for the same batch. The second finds the promise already
    // in the cache, so it never registers its own handler — and used to receive an empty venue
    // list with no reason attached, which it reported as "this chain has no router".
    const client = {
      chain: { id: 369 },
      getCode: async () => '0x60806040',
      getBlockNumber: async () => 1_000n,
      multicall: async () => {
        throw new Error('HTTP request failed. Status: 429')
      },
      readContract: async () => {
        throw new Error('HTTP request failed. Status: 429')
      },
    } as never

    let first = 0
    let second = 0
    const [a, b] = await Promise.all([
      liveVenues({ client, chainId: 369, onReadFailure: () => first++ }),
      liveVenues({ client, chainId: 369, onReadFailure: () => second++ }),
    ])
    expect(a).toEqual([])
    expect(b).toEqual([])
    expect(first, 'the caller that launched the batch').toBeGreaterThan(0)
    expect(second, 'the caller that joined it').toBeGreaterThan(0)
  })

  test('a reverted probe still counts as an answer, and stays cached', async () => {
    // The other half. A router with no code really is not a venue, and re-probing it on every
    // chart would undo the point of the cache.
    const { client, batches } = fakeChain(943, () => undefined)
    let told = 0
    expect(await liveVenues({ client, chainId: 943, onReadFailure: () => told++ })).toEqual([])
    expect(told, 'a revert is not a read failure').toBe(0)
    await liveVenues({ client, chainId: 943 })
    expect(batches, 'asked once, then remembered').toHaveLength(1)
  })

  test('asks each router once per process, however many callers ask', async () => {
    const { client, batches } = fakeChain(369, honestFactory)
    await Promise.all([
      confirmVenues(xykVenues(369), { client, chainId: 369 }),
      confirmVenues(xykVenues(369), { client, chainId: 369 }),
    ])
    await confirmVenues(xykVenues(369), { client, chainId: 369 })
    expect(batches).toHaveLength(1)
  })
})

/** A router that pays `pays` per unit on the direct path and nothing on any other. */
const directOnly = (rates: Record<string, bigint | undefined>) => (c: Seen) => {
  if (c.functionName === 'factory') return honestFactory(c)
  const [amountIn, path] = c.args as [bigint, Address[]]
  if (path.length !== 2) return undefined
  const rate = rates[c.address.toLowerCase()]
  return rate === undefined ? undefined : [amountIn, (amountIn * rate) / ONE]
}

describe('quoting every venue', () => {
  test('keeps the better of the two venues, whichever one it is', async () => {
    const richerV1 = fakeChain(
      369,
      directOnly({ [V1.router.toLowerCase()]: 3n * ONE, [V2.router.toLowerCase()]: 2n * ONE }),
    )
    const one = await quoteAll([{ key: 'k', tokenIn: A, tokenOut: B, amountIn: ONE }], {
      client: richerV1.client,
      chainId: 369,
    })
    expect(one.get('k')?.out).toBe(3n * ONE)
    expect(one.get('k')?.venue).toBe('v1')

    clearVenueProbes()
    const richerV2 = fakeChain(
      369,
      directOnly({ [V1.router.toLowerCase()]: 2n * ONE, [V2.router.toLowerCase()]: 3n * ONE }),
    )
    const two = await quoteAll([{ key: 'k', tokenIn: A, tokenOut: B, amountIn: ONE }], {
      client: richerV2.client,
      chainId: 369,
    })
    expect(two.get('k')?.out).toBe(3n * ONE)
    expect(two.get('k')?.venue).toBe('v2')
  })

  test('prices a pair only one venue lists, instead of calling it no pool', async () => {
    // This is the defect in its plainest form: v2 has never heard of the pair, v1 is deep in it,
    // and quoting v2 alone reports a market that does not exist to a maker who could have sold.
    const { client } = fakeChain(369, directOnly({ [V1.router.toLowerCase()]: 7n * ONE }))
    const q = await quoteAll([{ key: 'k', tokenIn: A, tokenOut: B, amountIn: ONE }], {
      client,
      chainId: 369,
    })
    expect(q.get('k')?.out).toBe(7n * ONE)
    expect(q.get('k')?.venue).toBe('v1')
  })

  test('says nothing when no venue lists the pair', async () => {
    const { client } = fakeChain(369, directOnly({}))
    const q = await quoteAll([{ key: 'k', tokenIn: A, tokenOut: B, amountIn: ONE }], {
      client,
      chainId: 369,
    })
    expect(q.get('k')).toBeNull()
  })

  test('takes the WPLS hop on one venue over the direct pair on the other', async () => {
    const { client } = fakeChain(369, (c) => {
      if (c.functionName === 'factory') return honestFactory(c)
      const [amountIn, path] = c.args as [bigint, Address[]]
      const isV1 = c.address.toLowerCase() === V1.router.toLowerCase()
      if (isV1 && path.length === 2) return [amountIn, 2n * ONE]
      if (!isV1 && path.length === 3) return [amountIn, 5n * ONE, 9n * ONE]
      return undefined
    })
    const q = await quoteAll([{ key: 'k', tokenIn: A, tokenOut: B, amountIn: ONE }], {
      client,
      chainId: 369,
    })
    expect(q.get('k')?.out).toBe(9n * ONE)
    expect(q.get('k')?.route).toBe('wpls')
    expect(q.get('k')?.venue).toBe('v2')
    // The hop's middle leg is what values the input in WPLS.
    expect(q.get('k')?.notionalNative).toBe(5n * ONE)
  })

  test('a chain with one venue quotes it, and asks for nothing it does not have', async () => {
    const { client, batches } = fakeChain(
      943,
      directOnly({ [TESTNET.router.toLowerCase()]: 5n * ONE }),
    )
    const q = await quoteAll([{ key: 'k', tokenIn: A, tokenOut: B, amountIn: ONE }], {
      client,
      chainId: 943,
    })
    expect(q.get('k')?.out).toBe(5n * ONE)
    expect(q.get('k')?.venue).toBe('v1')
    // One venue: the probe asks one router, and the quote batch holds the direct call and the hop.
    expect(batches.map((b) => b.length)).toEqual([1, 2])
    for (const c of batches[1]) expect(c.address).toBe(TESTNET.router)
  })

  test('another venue is a wider batch, not another round trip', async () => {
    const inputs = [
      { key: 'a', tokenIn: A, tokenOut: B, amountIn: ONE },
      { key: 'b', tokenIn: B, tokenOut: A, amountIn: ONE },
    ]
    const one = fakeChain(943, directOnly({ [TESTNET.router.toLowerCase()]: ONE }))
    await quoteAll(inputs, { client: one.client, chainId: 943 })
    clearVenueProbes()
    const two = fakeChain(369, directOnly({ [V1.router.toLowerCase()]: ONE }))
    await quoteAll(inputs, { client: two.client, chainId: 369 })

    // Two batches either way: one venue probe, then one quote. The quote batch doubles.
    expect(one.batches).toHaveLength(2)
    expect(two.batches).toHaveLength(2)
    expect(one.batches[1]).toHaveLength(4)
    expect(two.batches[1]).toHaveLength(8)
  })
})

/**
 * A quote the chain did not answer is unknown, not "no route".
 *
 * Measured on live prove.cash: on a slow network all 21 board rows said "no route" for 25
 * seconds, and eight of them had a real route once the reads got through. The endpoint was
 * rate-limiting, viem marked every call in each refused chunk `failure`, and `quoteAll` turned
 * that into `null`. The contract now: `null` only when every leg answered and none priced; an
 * absent key when a read failed and nothing priced.
 */
describe('a quote the chain did not answer', () => {
  const k = [{ key: 'k', tokenIn: A, tokenOut: B, amountIn: ONE }]
  const isV1 = (c: Seen) => c.address.toLowerCase() === V1.router.toLowerCase()

  test('a genuine revert on every leg is still no route', async () => {
    const { client } = fakeChain(369, directOnly({}))
    let told = 0
    const q = await quoteAll(k, { client, chainId: 369, onReadFailure: () => told++ })
    expect(q.has('k')).toBe(true)
    expect(q.get('k')).toBeNull()
    expect(told, 'a revert is an answer, not a read failure').toBe(0)
  })

  test('every leg unreadable is unknown: the key is absent, not null', async () => {
    const { client } = fakeChain(369, (c) => (c.functionName === 'factory' ? honestFactory(c) : UNREADABLE))
    let told = 0
    const q = await quoteAll(k, { client, chainId: 369, onReadFailure: () => told++ })
    expect(q.has('k'), 'no answer, so no claim about the market').toBe(false)
    expect(told, 'reported once per call').toBe(1)
  })

  test('one leg priced and the others unreadable is a price', async () => {
    const { client } = fakeChain(369, (c) => {
      if (c.functionName === 'factory') return honestFactory(c)
      const [amountIn, path] = c.args as [bigint, Address[]]
      return isV1(c) && path.length === 2 ? [amountIn, 7n * ONE] : UNREADABLE
    })
    let told = 0
    const q = await quoteAll(k, { client, chainId: 369, onReadFailure: () => told++ })
    expect(q.get('k')?.out).toBe(7n * ONE)
    expect(q.get('k')?.venue).toBe('v1')
    expect(told, 'the endpoint still failed, and its health must say so').toBe(1)
  })

  test('reverts on some legs and unreadable on the rest is unknown, not no route', async () => {
    // v2 answered "no pair". v1 never answered, and v1 is the venue that could list it.
    const { client } = fakeChain(369, (c) => {
      if (c.functionName === 'factory') return honestFactory(c)
      return isV1(c) ? UNREADABLE : undefined
    })
    const q = await quoteAll(k, { client, chainId: 369 })
    expect(q.has('k')).toBe(false)
  })

  test('keys are judged one by one: an unreadable key does not blank a priced one', async () => {
    const C = '0x00000000000000000000000000000000000000cc' as Address
    const { client } = fakeChain(369, (c) => {
      if (c.functionName === 'factory') return honestFactory(c)
      const [amountIn, path] = c.args as [bigint, Address[]]
      if (path.at(-1)!.toLowerCase() === B) return path.length === 2 ? [amountIn, 3n * ONE] : undefined
      if (path.at(-1)!.toLowerCase() === C) return undefined
      return UNREADABLE
    })
    const q = await quoteAll(
      [
        { key: 'priced', tokenIn: A, tokenOut: B, amountIn: ONE },
        { key: 'none', tokenIn: A, tokenOut: C, amountIn: ONE },
        { key: 'unknown', tokenIn: B, tokenOut: A, amountIn: ONE },
      ],
      { client, chainId: 369 },
    )
    expect(q.get('priced')?.out).toBe(3n * ONE)
    expect(q.get('none')).toBeNull()
    expect(q.has('unknown')).toBe(false)
  })

  test('a venue probe that could not be read leaves every key unknown', async () => {
    // Before this, an empty venue list set every key to null: "no route" on the whole board
    // because the first request of the page was rate-limited.
    const { client } = fakeChain(369, () => UNREADABLE)
    let told = 0
    const q = await quoteAll(k, { client, chainId: 369, onReadFailure: () => told++ })
    expect(q.size).toBe(0)
    expect(told).toBe(1)
  })

  test('one venue unconfirmed and the other reverting is unknown', async () => {
    // The unconfirmed venue is left out of the quote batch, so it was never asked about the pair.
    const { client } = fakeChain(369, (c) => {
      if (c.functionName === 'factory') return isV1(c) ? UNREADABLE : honestFactory(c)
      return undefined
    })
    const q = await quoteAll(k, { client, chainId: 369 })
    expect(q.has('k')).toBe(false)
  })
})

/**
 * Every venue's fee, solved from the chain's own answers.
 *
 * The reserves and the `getAmountsOut` result below were read at one pinned block per chain on
 * 2026-08-17 — mainnet 27,313,834 and testnet 25,158,344. The numerator is not asserted from the
 * docs; it is the only value between 9,000 and 10,000 that reproduces the router's answer, and
 * the test re-solves it every run. `market.live.test.ts` repeats the measurement against the
 * live chains; this one keeps the answer honest without a network.
 */
const MEASURED = [
  {
    chain: 369,
    venue: V2,
    pair: '0x149B2C629e652f2E89E11cd57e5d4D77ee166f9F',
    reserveIn: 34_111_764_327_689_591_651_643_173_938n,
    reserveOut: 38_081_007_563_589_113_086_545_485_411n,
    amountsOut: 1_113_122_507_407_888_677n,
  },
  {
    chain: 369,
    venue: V1,
    pair: '0x1b45b9148791d3a104184Cd5DFE5CE57193a3ee9',
    reserveIn: 109_865_237_953_409_190_824_913_142_798n,
    reserveOut: 122_636_046_216_216_911_696_162_007_486n,
    amountsOut: 1_113_003_566_541_546_504n,
  },
  {
    chain: 943,
    venue: TESTNET,
    pair: '0xFfd1fD891301D347ECaf4fC76866030387e97ED4',
    reserveIn: 77_288_029_538_493_453_035_299_324_876n,
    reserveOut: 389_346_611_968_820_916_724_135_088_082n,
    amountsOut: 5_022_996_563_727_251_241n,
  },
] as const

describe('the fee each venue actually charges', () => {
  for (const m of MEASURED) {
    const pool = (feeNum: bigint): Pool => ({
      address: m.pair as Address,
      token0: A,
      token1: B,
      reserve0: m.reserveIn,
      reserve1: m.reserveOut,
      feeNum,
      feeDen: PULSEX_FEE_DEN,
      venue: m.venue.label,
      blockNumber: 1n,
    })

    test(`chain ${m.chain} ${m.venue.label} solves to exactly one numerator, and the registry has it`, () => {
      const fits: bigint[] = []
      for (let n = 9_000n; n <= PULSEX_FEE_DEN; n++) {
        if (poolAmountOut(pool(n), A, ONE) === m.amountsOut) fits.push(n)
      }
      expect(fits).toEqual([9971n])
      expect(m.venue.feeNum).toBe(9971n)
      expect(m.venue.feeDen).toBe(10_000n)
    })

    test(`chain ${m.chain} ${m.venue.label} reproduces getAmountsOut from the registry fee`, () => {
      expect(poolAmountOut(pool(m.venue.feeNum), A, ONE)).toBe(m.amountsOut)
    })
  }
})

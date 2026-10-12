import { beforeEach, describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import { NETWORKS } from '../config.js'
import { memoryKeyValueStore, setKeyValueStore } from '../kv.js'
import { clearVenueProbes } from '../market.js'
import { loadPools, loadVenuePools, pickPool, poolAmountOut, poolKey, readVenues } from './price.js'

/**
 * Reading pools off a chain that lists the same pair twice.
 *
 * The registry used to carry one router per chain, so a snapshot saw one of mainnet's two pools
 * and never knew about the other. These tests hold the reader to both: every venue is asked, in
 * the same two multicalls it always used, and a pair only one venue lists still comes back.
 */

type Seen = { address: Address; functionName: string; args?: readonly unknown[] }

const V2 = NETWORKS[369].xyk[0]
const V1 = NETWORKS[369].xyk[1]
const TESTNET = NETWORKS[943].xyk[0]

const A = '0x00000000000000000000000000000000000000aa' as Address
const B = '0x00000000000000000000000000000000000000bb' as Address
const C = '0x00000000000000000000000000000000000000cc' as Address
const NONE = '0x0000000000000000000000000000000000000000' as Address

const ONE = 10n ** 18n

/** One venue's listing of one pair: where it is and what it holds, in `[A, B]` order. */
type Listing = { pair: Address; reserveA: bigint; reserveB: bigint }

/**
 * A chain built from a table of listings, keyed by factory then by the pair's `poolKey`. It
 * records every batch, because the count of those is half of what these tests are about.
 */
function fakeChain(id: number, listings: Record<string, Record<string, Listing>>) {
  const batches: Seen[][] = []
  const byPair = new Map<string, { a: Address; b: Address; l: Listing }>()
  for (const perFactory of Object.values(listings)) {
    for (const [key, l] of Object.entries(perFactory)) {
      const [a, b] = key.split('|') as [Address, Address]
      byPair.set(l.pair.toLowerCase(), { a, b, l })
    }
  }
  const answer = (c: Seen): unknown => {
    if (c.functionName === 'factory') {
      return [...NETWORKS[369].xyk, ...NETWORKS[943].xyk].find(
        (v) => v.router.toLowerCase() === c.address.toLowerCase(),
      )?.factory
    }
    if (c.functionName === 'getPair') {
      const [x, y] = c.args as [Address, Address]
      return listings[c.address.toLowerCase()]?.[poolKey(x, y)]?.pair ?? NONE
    }
    const found = byPair.get(c.address.toLowerCase())
    if (!found) return undefined
    // `poolKey` sorts, so token0 is whichever of the two addresses sorts first — the same rule a
    // real pair follows, and the reason the reader must read token0 rather than assume it.
    const zeroIsA = found.a.toLowerCase() < found.b.toLowerCase()
    if (c.functionName === 'token0') return zeroIsA ? found.a : found.b
    if (c.functionName === 'token1') return zeroIsA ? found.b : found.a
    if (c.functionName === 'getReserves') {
      const [r0, r1] = zeroIsA
        ? [found.l.reserveA, found.l.reserveB]
        : [found.l.reserveB, found.l.reserveA]
      return [r0, r1, 0]
    }
    return undefined
  }
  const client = {
    chain: { id },
    getCode: async () => '0x60806040',
    getBlockNumber: async () => 1_000n,
    multicall: async ({ contracts }: { contracts: Seen[] }) => {
      batches.push(contracts)
      return contracts.map((c) => {
        const v = answer(c)
        return v === undefined
          ? { status: 'failure' as const }
          : { status: 'success' as const, result: v }
      })
    },
  }
  return { client: client as never, batches }
}

const f = (v: { factory: Address }) => v.factory.toLowerCase()

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  clearVenueProbes()
})

describe('reading every venue', () => {
  test('brings back both pools for a pair both venues list', async () => {
    const { client } = fakeChain(369, {
      [f(V2)]: { [poolKey(A, B)]: { pair: '0x11' as Address, reserveA: 100n, reserveB: 200n } },
      [f(V1)]: { [poolKey(A, B)]: { pair: '0x22' as Address, reserveA: 900n, reserveB: 1_500n } },
    })
    const pools = await loadVenuePools([[A, B]], { client, chainId: 369 })
    expect(pools.get(poolKey(A, B))?.map((p) => p.venue)).toEqual(['v2', 'v1'])
    // Each pool carries its own venue's fee, because the fee lives in the pair, not the router.
    for (const p of pools.get(poolKey(A, B))!) expect(p.feeNum).toBe(9971n)
  })

  test('brings back a pair only one venue lists', async () => {
    const { client } = fakeChain(369, {
      [f(V2)]: {},
      [f(V1)]: { [poolKey(A, B)]: { pair: '0x22' as Address, reserveA: 900n, reserveB: 1_500n } },
    })
    const pools = await loadVenuePools([[A, B]], { client, chainId: 369 })
    expect(pools.get(poolKey(A, B))?.map((p) => p.venue)).toEqual(['v1'])
  })

  test('leaves out a pair no venue lists', async () => {
    const { client } = fakeChain(369, { [f(V2)]: {}, [f(V1)]: {} })
    expect(await loadVenuePools([[A, C]], { client, chainId: 369 })).toEqual(new Map())
  })

  test('a chain with one venue reads it, and reads nothing else', async () => {
    const { client, batches } = fakeChain(943, {
      [f(TESTNET)]: { [poolKey(A, B)]: { pair: '0x33' as Address, reserveA: 10n, reserveB: 40n } },
    })
    const pools = await loadVenuePools([[A, B]], { client, chainId: 943 })
    expect(pools.get(poolKey(A, B))?.map((p) => p.venue)).toEqual(['v1'])
    // Probe, getPair, reserves — three batches, the same three a single-venue read always took.
    expect(batches.map((b) => b.length)).toEqual([1, 1, 3])
  })

  test('another venue widens the same batches instead of adding one', async () => {
    const two = fakeChain(369, {
      [f(V2)]: { [poolKey(A, B)]: { pair: '0x11' as Address, reserveA: 100n, reserveB: 200n } },
      [f(V1)]: { [poolKey(A, B)]: { pair: '0x22' as Address, reserveA: 900n, reserveB: 1_500n } },
    })
    await loadVenuePools([[A, B]], { client: two.client, chainId: 369 })
    // One probe call per venue, one getPair per venue, one reserves triple per pool found.
    expect(two.batches.map((b) => b.length)).toEqual([2, 2, 6])
  })
})

describe('collapsing the venues to one pool per pair', () => {
  test('keeps the deeper pool', async () => {
    const { client } = fakeChain(369, {
      [f(V2)]: { [poolKey(A, B)]: { pair: '0x11' as Address, reserveA: 100n, reserveB: 200n } },
      [f(V1)]: { [poolKey(A, B)]: { pair: '0x22' as Address, reserveA: 900n, reserveB: 1_500n } },
    })
    const pools = await loadPools([[A, B]], { client, chainId: 369 })
    expect(pools.get(poolKey(A, B))?.venue).toBe('v1')
    expect(pools.get(poolKey(A, B))?.address).toBe('0x22')
  })

  test('takes the one venue that lists it when only one does', async () => {
    const { client } = fakeChain(369, {
      [f(V2)]: {},
      [f(V1)]: { [poolKey(A, B)]: { pair: '0x22' as Address, reserveA: 900n, reserveB: 1_500n } },
    })
    const pools = await loadPools([[A, B]], { client, chainId: 369 })
    expect(pools.get(poolKey(A, B))?.venue).toBe('v1')
  })
})

describe('picking a pool for a size', () => {
  test('a keener shallow pool wins a small trade and loses a large one', async () => {
    // This is why `loadPools` cannot be the whole answer, and why `pickPool` exists. Deep pool:
    // 1,000,000 A against 1,000,000 B. Shallow pool: 1,000 A against 1,100 B, a 10% better rate
    // and a thousandth of the depth.
    const { client } = fakeChain(369, {
      [f(V2)]: {
        [poolKey(A, B)]: { pair: '0x11' as Address, reserveA: 1_000n * ONE, reserveB: 1_100n * ONE },
      },
      [f(V1)]: {
        [poolKey(A, B)]: {
          pair: '0x22' as Address,
          reserveA: 1_000_000n * ONE,
          reserveB: 1_000_000n * ONE,
        },
      },
    })
    const list = (await loadVenuePools([[A, B]], { client, chainId: 369 })).get(poolKey(A, B))!
    expect(pickPool(list, A, ONE)?.venue).toBe('v2')
    expect(pickPool(list, A, 500n * ONE)?.venue).toBe('v1')
    // And the pick really is the better payout, not just a different one.
    const small = pickPool(list, A, ONE)!
    for (const p of list) {
      expect(poolAmountOut(small, A, ONE)!).toBeGreaterThanOrEqual(poolAmountOut(p, A, ONE)!)
    }
  })

  test('says nothing when the pair is in none of the pools', () => {
    expect(pickPool([], A, ONE)).toBeNull()
  })
})

describe('a read that fails is not an answer', () => {
  test('a failed getBlockNumber stamps no pool with block zero', async () => {
    // Block zero reads as the oldest snapshot there is. The graph keeps a held pool over one
    // stamped earlier, so a zero-stamped pool can never replace anything, nor be replaced by
    // the next good read on equal terms. No block, no snapshot.
    const { client } = fakeChain(943, {
      [f(TESTNET)]: { [poolKey(A, B)]: { pair: '0x33' as Address, reserveA: 10n, reserveB: 40n } },
    })
    ;(client as { getBlockNumber: () => Promise<bigint> }).getBlockNumber = async () => {
      throw new Error('rpc down')
    }
    let failures = 0
    const pools = await loadVenuePools([[A, B]], { client, chainId: 943, onReadFailure: () => failures++ })
    for (const list of pools.values()) for (const p of list) expect(p.blockNumber).not.toBe(0n)
    expect(pools.size).toBe(0)
    expect(failures).toBeGreaterThan(0)
  })

  test('a venue discovery that failed is asked again, not remembered for ever', async () => {
    const router = '0x00000000000000000000000000000000000000d1' as Address
    const factory = '0x00000000000000000000000000000000000000f1' as Address
    let up = false
    const client = {
      chain: { id: 943 },
      getCode: async () => '0x60806040',
      getBlockNumber: async () => 1_000n,
      multicall: async ({ contracts }: { contracts: Seen[] }) =>
        contracts.map(() => (up ? { status: 'success' as const, result: factory } : { status: 'failure' as const })),
    } as never
    expect(await readVenues({ client, chainId: 943, router })).toEqual([])
    up = true
    const venues = await readVenues({ client, chainId: 943, router })
    expect(venues.map((v) => v.factory)).toEqual([factory])
  })
})

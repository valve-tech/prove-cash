import { beforeEach, describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import { NETWORKS, PULSEX_FEE_DEN, type XykVenue } from '../config.js'
import { memoryKeyValueStore, setKeyValueStore } from '../kv.js'
import { forgetMulticallProbes } from '../multicall.js'
import { PoolGraph } from './graph.js'
import { GraphKeeper, graphOptionsFor, reconcileWithVenues } from './graphsync.js'

/**
 * The keeper against a chain and a subgraph that both answer from tables.
 *
 * What is under test is not arithmetic (`graph.test.ts` has that). It is the contract between
 * the two sources: the subgraph can only propose, the chain decides, and neither a slow nor a
 * broken subgraph can stop a pass or change a reserve.
 */

const V = NETWORKS[943].xyk[0] as XykVenue
const OTHER_FACTORY = '0x1715a3E4A142d8b698131108995174F37aEBA10D'
const T = {
  WPLS: '0x70499adebb11efd915e3b69e700c331778628707',
  tUSDC: '0x86390129a2079fb7f0fc889473160a3a449117ab',
  tWBTC: '0x70c421a8bac4adaa10285a20eff09997a5e09565',
  tWETH: '0xcb5c3ed9cd727f142d1b9efc60790550683aa655',
} as const
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address

type PairState = {
  token0: string
  token1: string
  factory: string
  reserve0: bigint
  reserve1: bigint
  /** 'revert' answers every call with a revert; 'unreadable' fails the call without an answer. */
  fault?: 'revert' | 'unreadable'
}

/** The three real 943 pools behind tWBTC and tWETH, at the 2026-09-23 reserves. */
function realPairs(): Map<string, PairState> {
  return new Map([
    [
      '0xc5cb61b1dbe241616b205804f89a778a5d4ff52d',
      { token0: T.WPLS, token1: T.tUSDC, factory: V.factory, reserve0: 2_777_717_985_410_719_758_201n, reserve1: 54_013_024n },
    ],
    [
      '0x0ef0bc420a40faada94c1390175f2e5bc931957c',
      { token0: T.tWBTC, token1: T.tUSDC, factory: V.factory, reserve0: 2_500_000n, reserve1: 250_000_000n },
    ],
    [
      '0xbf1ce46d402d3c6b50a2ecc2423ffd32e26494ee',
      { token0: T.tUSDC, token1: T.tWETH, factory: V.factory, reserve0: 250_000_000n, reserve1: 10n ** 18n },
    ],
  ])
}

type Log = { address: Address; blockNumber: bigint; args: { reserve0: bigint; reserve1: bigint } }

/** A chain that answers from `pairs`, with a head a test can move, and a count of its requests. */
function fakeChain(pairs: Map<string, PairState>, opts: { refuseLogs?: (a: bigint, b: bigint) => boolean } = {}) {
  const state = { head: 1_000n, logs: [] as Log[], inFlight: 0, peak: 0, multicalls: 0, getLogs: 0 }
  const enter = async () => {
    state.inFlight++
    state.peak = Math.max(state.peak, state.inFlight)
    await new Promise((r) => setTimeout(r, 0))
  }
  const client = {
    chain: { id: 943 },
    getCode: async () => '0x6080',
    getBlockNumber: async () => state.head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      await enter()
      state.getLogs++
      try {
        if (opts.refuseLogs?.(fromBlock, toBlock)) throw new Error('HTTP 429')
        return state.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock)
      } finally {
        state.inFlight--
      }
    },
    multicall: async ({ contracts }: { contracts: { address: string; functionName: string }[] }) => {
      await enter()
      state.multicalls++
      try {
        return contracts.map((c) => {
          const p = pairs.get(c.address.toLowerCase())
          if (!p || p.fault === 'revert') return { status: 'failure', error: new Error('execution reverted') }
          if (p.fault === 'unreadable') return { status: 'failure', error: new Error('HTTP 429') }
          const result =
            c.functionName === 'token0'
              ? p.token0
              : c.functionName === 'token1'
                ? p.token1
                : c.functionName === 'factory'
                  ? p.factory
                  : [p.reserve0, p.reserve1, 0]
          return { status: 'success', result }
        })
      } finally {
        state.inFlight--
      }
    },
  }
  return { client: client as never, state }
}

/** A subgraph that lists these pairs (with the tokens it claims), and can be broken or held. */
function fakeSubgraph(listing: { address: string; token0: string; token1: string }[]) {
  const s = { down: false, calls: 0, hold: null as Promise<void> | null, listing }
  const f = (async (_u: string, init: RequestInit) => {
    s.calls++
    if (s.hold) await s.hold
    if (s.down) throw new TypeError('fetch failed')
    const { query } = JSON.parse(String(init.body)) as { query: string }
    const row = (p: (typeof listing)[number]) => ({
      id: p.address,
      token0: { id: p.token0, symbol: 'X', decimals: '18' },
      token1: { id: p.token1, symbol: 'Y', decimals: '18' },
      trackedReservePLS: '1',
      reservePLS: '1',
    })
    const data: Record<string, unknown> = {
      _meta: { block: { number: 1_000_000 }, hasIndexingErrors: false },
      pulseXFactories: [{ id: V.factory }],
      backbone: s.listing.map(row),
    }
    for (const m of query.matchAll(/(\w+): pairs\(/g)) if (m[1] !== 'backbone') data[m[1]] = []
    return new Response(JSON.stringify({ data }))
  }) as typeof fetch
  return { fetch: f, s }
}

const listingOf = (pairs: Map<string, PairState>) =>
  [...pairs.entries()].map(([address, p]) => ({ address, token0: p.token0, token1: p.token1 }))

function keeper(pairs: Map<string, PairState>, over: { graph?: PoolGraph; chain?: ReturnType<typeof fakeChain>; listing?: ReturnType<typeof listingOf> } = {}) {
  const chain = over.chain ?? fakeChain(pairs)
  const sub = fakeSubgraph(over.listing ?? listingOf(pairs))
  const graph = over.graph ?? new PoolGraph(graphOptionsFor(943, { maxAgeBlocks: 1_000 }))
  const k = new GraphKeeper({
    chainId: 943,
    client: chain.client,
    graph,
    venues: [V],
    // The subgraph's _meta says 1,000,000; the fake head is 1,000. Lag is head minus meta, so a
    // subgraph ahead of the head is never stale.
    discovery: { fetch: sub.fetch },
    pairsPerRead: 2,
  })
  return { k, chain, sub, graph }
}

const tokens = [T.tWBTC, T.tWETH] as Address[]

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  forgetMulticallProbes()
})

describe('a cold start', () => {
  test('discovers, reads every pair from the chain, and prices tWBTC and tWETH through tUSDC', async () => {
    const { k, chain, graph } = keeper(realPairs())
    const r = await k.warmUp(chain.state.head, tokens)
    expect(r.added).toBe(3)
    expect(graph.qualifiedCount).toBe(3)
    expect(graph.quote(T.tWBTC as Address, T.WPLS as Address, 1_000_000n)!.out).toBe(1_578_287_280_390_663_014_197n)
    expect(graph.quote(T.tWETH as Address, T.WPLS as Address, 10n ** 17n)!.out).toBe(819_437_266_934_737_240_116n)
    expect(k.usable(chain.state.head)).toBe(true)
  })

  test('reads one batch at a time, never two in flight', async () => {
    const { k, chain } = keeper(realPairs())
    await k.warmUp(chain.state.head, tokens)
    // Three pairs at two per read is two reads, sequential.
    expect(chain.state.multicalls).toBe(2)
    expect(chain.state.peak).toBe(1)
  })

  test('with the subgraph down, the graph stays empty and nothing throws', async () => {
    const { k, chain, sub, graph } = keeper(realPairs())
    sub.s.down = true
    const r = await k.warmUp(chain.state.head, tokens)
    expect(r.discovery[0]).toMatchObject({ ok: false, reason: 'unreachable' })
    expect(graph.size).toBe(0)
    expect(k.usable(chain.state.head)).toBe(false)
  })

  test('a failed discovery is retried after retryBlocks, not every tick', async () => {
    const { k, chain, sub } = keeper(realPairs())
    sub.s.down = true
    await k.warmUp(chain.state.head, tokens)
    const calls = sub.s.calls
    chain.state.head += 5n
    await k.refresh(chain.state.head, tokens)
    expect(sub.s.calls).toBe(calls)
    chain.state.head += 30n
    sub.s.down = false
    await k.refresh(chain.state.head, tokens) // starts it
    await new Promise((r) => setTimeout(r, 10))
    const r = await k.refresh(chain.state.head, tokens) // takes it in
    expect(r.added).toBe(3)
  })
})

describe('the chain decides, not the subgraph', () => {
  test('a pair another factory made is rejected', async () => {
    const pairs = realPairs()
    pairs.set(addr(0xb1), { token0: T.WPLS, token1: T.tUSDC, factory: OTHER_FACTORY, reserve0: 10n ** 30n, reserve1: 10n ** 30n })
    const { k, chain, graph } = keeper(pairs)
    const r = await k.warmUp(chain.state.head, tokens)
    expect(r.rejected).toBe(1)
    expect(graph.has(addr(0xb1))).toBe(false)
  })

  test('a pair whose tokens the chain names differently is rejected', async () => {
    const pairs = realPairs()
    pairs.set(addr(0xb2), { token0: T.WPLS, token1: T.tWBTC, factory: V.factory, reserve0: 10n ** 24n, reserve1: 10n ** 12n })
    const listing = listingOf(pairs).map((p) => (p.address === addr(0xb2) ? { ...p, token1: T.tWETH } : p))
    const { k, chain, graph } = keeper(pairs, { listing })
    const r = await k.warmUp(chain.state.head, tokens)
    expect(r.rejected).toBe(1)
    expect(graph.has(addr(0xb2))).toBe(false)
  })

  test('an address that is not a pair (every call reverts) is rejected', async () => {
    const pairs = realPairs()
    pairs.set(addr(0xb3), { token0: T.WPLS, token1: T.tUSDC, factory: V.factory, reserve0: 1n, reserve1: 1n, fault: 'revert' })
    const { k, chain } = keeper(pairs)
    expect((await k.warmUp(chain.state.head, tokens)).rejected).toBe(1)
  })

  test('an unreadable pair is kept in the queue and read on a later tick', async () => {
    const pairs = realPairs()
    const wbtc = pairs.get('0x0ef0bc420a40faada94c1390175f2e5bc931957c')!
    wbtc.fault = 'unreadable'
    const { k, chain, graph } = keeper(pairs)
    const r = await k.warmUp(chain.state.head, tokens)
    expect(r.unreadable).toBeGreaterThan(0)
    expect(r.queued).toBe(1)
    expect(graph.has('0x0ef0bc420a40faada94c1390175f2e5bc931957c')).toBe(false)
    delete wbtc.fault
    chain.state.head += 1n
    const again = await k.refresh(chain.state.head, tokens)
    expect(again.added).toBe(1)
  })

  test('the subgraph never sets a reserve: the chain read does', async () => {
    const { k, chain, graph } = keeper(realPairs())
    await k.warmUp(chain.state.head, tokens)
    expect(graph.get('0xc5cb61b1dbe241616b205804f89a778a5d4ff52d')!.reserve0).toBe(2_777_717_985_410_719_758_201n)
  })
})

describe('freshness', () => {
  test('Sync logs since the last tick move reserves, and coverage follows', async () => {
    const pairs = realPairs()
    const { k, chain, graph } = keeper(pairs)
    await k.warmUp(chain.state.head, tokens)
    chain.state.logs.push({
      address: '0xc5cb61b1dbe241616b205804f89a778a5d4ff52d',
      blockNumber: 1_003n,
      args: { reserve0: 2_700n * 10n ** 18n, reserve1: 55_000_000n },
    })
    chain.state.head = 1_010n
    const r = await k.refresh(chain.state.head, tokens)
    expect(r.logs).toBe(1)
    expect(graph.get('0xc5cb61b1dbe241616b205804f89a778a5d4ff52d')!.reserve0).toBe(2_700n * 10n ** 18n)
    expect(graph.syncedTo).toBe(1_010n)
  })

  test('a refused log range stops coverage there, and the next tick reads it again', async () => {
    let refuse = true
    const pairs = realPairs()
    const chain = fakeChain(pairs, { refuseLogs: (a) => refuse && a > 1_000n })
    const { k, graph } = keeper(pairs, { chain })
    await k.warmUp(chain.state.head, tokens)
    chain.state.head = 1_050n
    const r = await k.refresh(chain.state.head, tokens)
    expect(r.logRefused).toBe(1)
    expect(graph.syncedTo).toBe(1_000n)
    expect(k.usable(chain.state.head)).toBe(false)
    refuse = false
    await k.refresh(chain.state.head, tokens)
    expect(graph.syncedTo).toBe(1_050n)
    expect(k.usable(chain.state.head)).toBe(true)
  })

  test('a gap longer than maxCatchupBlocks reads every reserve again instead of the logs', async () => {
    const pairs = realPairs()
    const { k, chain, graph } = keeper(pairs)
    await k.warmUp(chain.state.head, tokens)
    const logsBefore = chain.state.getLogs
    pairs.get('0xc5cb61b1dbe241616b205804f89a778a5d4ff52d')!.reserve0 = 1_234n * 10n ** 18n
    chain.state.head = 5_000n
    const r = await k.refresh(chain.state.head, tokens)
    expect(chain.state.getLogs).toBe(logsBefore)
    expect(r.reread).toBe(3)
    expect(graph.get('0xc5cb61b1dbe241616b205804f89a778a5d4ff52d')!.reserve0).toBe(1_234n * 10n ** 18n)
    expect(graph.syncedTo).toBe(5_000n)
  })

  test('after a long gap, a pool whose re-read fails is removed, not kept at old reserves', async () => {
    const pairs = realPairs()
    const { k, chain, graph } = keeper(pairs)
    await k.warmUp(chain.state.head, tokens)
    pairs.get('0xbf1ce46d402d3c6b50a2ecc2423ffd32e26494ee')!.fault = 'revert'
    chain.state.head = 5_000n
    await k.refresh(chain.state.head, tokens)
    expect(graph.has('0xbf1ce46d402d3c6b50a2ecc2423ffd32e26494ee')).toBe(false)
    expect(graph.size).toBe(2)
  })

  test('after a long gap with the endpoint down, nothing is removed and nothing is routed', async () => {
    const pairs = realPairs()
    const { k, chain, graph } = keeper(pairs)
    await k.warmUp(chain.state.head, tokens)
    for (const p of pairs.values()) p.fault = 'unreadable'
    chain.state.head = 5_000n
    await k.refresh(chain.state.head, tokens)
    expect(graph.size).toBe(3)
    expect(k.usable(chain.state.head)).toBe(false)
  })
})

describe('the subgraph never blocks a pass, and its failure keeps what the graph holds', () => {
  test('a refresh returns while a discovery is still in flight', async () => {
    const { k, chain, sub } = keeper(realPairs())
    let release!: () => void
    sub.s.hold = new Promise((r) => (release = r))
    const r = await k.refresh(chain.state.head, tokens)
    expect(r.discovering).toBe(true)
    expect(k.discovering).toBe(true)
    release()
  })

  test('a warm start with the subgraph down keeps its cached pools past the staleness window', async () => {
    const first = keeper(realPairs())
    await first.k.warmUp(first.chain.state.head, tokens)
    const text = first.graph.serialize(943)

    const pairs = realPairs()
    const chain = fakeChain(pairs)
    const graph = PoolGraph.parse(text, 943, graphOptionsFor(943, { maxAgeBlocks: 1_000 }))
    const { k, sub } = keeper(pairs, { chain, graph })
    sub.s.down = true
    // Walk three staleness windows forward, a tick at a time, with no Sync at all.
    for (let h = 1_000n; h <= 4_000n; h += 250n) {
      chain.state.head = h
      await k.refresh(h, tokens)
    }
    expect(graph.size).toBe(3)
    expect(graph.quote(T.tWBTC as Address, T.WPLS as Address, 1_000_000n)).not.toBeNull()
  })

  test('a pool discovery stops listing, and nobody trades, ages out', async () => {
    const { k, chain, sub, graph } = keeper(realPairs())
    await k.warmUp(chain.state.head, tokens)
    // Rediscovery lists only two of the three.
    sub.s.listing = sub.s.listing.filter((p) => p.address !== '0xbf1ce46d402d3c6b50a2ecc2423ffd32e26494ee')
    for (let h = 1_100n; h <= 2_600n; h += 100n) {
      chain.state.head = h
      await k.refresh(h, tokens)
      await new Promise((r) => setTimeout(r, 1))
    }
    expect(graph.has('0xbf1ce46d402d3c6b50a2ecc2423ffd32e26494ee')).toBe(false)
    expect(graph.size).toBe(2)
  })
})

describe('bounded under a flood', () => {
  test('a subgraph listing 10,000 pairs leaves the queue and the graph inside their caps', async () => {
    const pairs = realPairs()
    for (let i = 0; i < 10_000; i++) {
      pairs.set(addr(0x100000 + i), {
        token0: T.WPLS,
        token1: addr(0x200000 + i),
        factory: V.factory,
        reserve0: 10n ** 24n + BigInt(i),
        reserve1: 10n ** 24n,
      })
    }
    const chain = fakeChain(pairs)
    const graph = new PoolGraph(graphOptionsFor(943, { maxPools: 100 }))
    const k = new GraphKeeper({
      chainId: 943,
      client: chain.client,
      graph,
      venues: [V],
      discovery: { fetch: fakeSubgraph(listingOf(pairs)).fetch },
      pairsPerRead: 50,
      maxReadsPerRefresh: 5,
    })
    await k.warmUp(chain.state.head, tokens)
    expect(k.queued).toBe(0)
    expect(graph.size).toBeLessThanOrEqual(100)
    chain.state.head += 1n
    const r = await k.refresh(chain.state.head, tokens)
    expect(r.reads).toBeLessThanOrEqual(5)
  })
})

describe('a cached pool the registry no longer agrees with', () => {
  test('is dropped rather than priced at an old fee', () => {
    const graph = new PoolGraph(graphOptionsFor(943))
    graph.add({
      address: addr(0x1),
      token0: T.WPLS as Address,
      token1: T.tUSDC as Address,
      reserve0: 1n,
      reserve1: 1n,
      feeNum: 9_970n,
      feeDen: PULSEX_FEE_DEN,
      venue: 'v1',
      blockNumber: 1n,
    })
    graph.add({ ...graph.get(addr(0x1))!, address: addr(0x2), feeNum: V.feeNum })
    graph.add({ ...graph.get(addr(0x2))!, address: addr(0x3), venue: 'gone' })
    expect(reconcileWithVenues(graph, [V])).toBe(2)
    expect(graph.all().map((p) => p.address)).toEqual([addr(0x2)])
  })
})

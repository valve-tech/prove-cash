import { describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import { PULSEX_FEE_DEN, PULSEX_FEE_NUM } from '../config.js'
import { PoolGraph, type PoolGraphInit } from './graph.js'
import { poolAmountOut, type Pool } from './price.js'

/**
 * The pool graph, held to what it exists to get right.
 *
 * 1. It prices what the router prices. The fixtures below are real reserves and the router's own
 *    `getAmountsOut`, read in ONE multicall so every number describes the same block.
 * 2. It prices tWBTC and tWETH on 943, which have no WPLS pool, through tUSDC.
 * 3. It routes only through pools the chain says are deep, whatever a subgraph ranked.
 * 4. It keys every token by address. Two tokens called DAI never merge.
 * 5. It is bounded under a flood: the cap, the staleness window and the per-token limit.
 * 6. A cache file it cannot trust gives a cold start, never a crash.
 */

const FEE = { feeNum: PULSEX_FEE_NUM, feeDen: PULSEX_FEE_DEN }

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Chain 943, PulseX v1, block 25,461,939, 2026-09-23. One multicall: `Multicall3.getBlockNumber`,
 * then `getReserves`, `token0`, `token1` and `factory` on five pairs, then the router's
 * `getAmountsOut` at `0xDaE9…50f7` on each path below. Every pair's `factory()` answered the
 * registry's `0xFf05…c0f7`. The same call on `[tWBTC, WPLS]` and `[tWETH, WPLS]` reverted:
 * neither token has a WPLS pool.
 */
const T943 = {
  WPLS: '0x70499adebb11efd915e3b69e700c331778628707' as Address,
  tPLSX: '0xabef58363e0fc60250d16778848eaed831ea26f9' as Address,
  tUSDC: '0x86390129a2079fb7f0fc889473160a3a449117ab' as Address,
  tWBTC: '0x70c421a8bac4adaa10285a20eff09997a5e09565' as Address,
  tWETH: '0xcb5c3ed9cd727f142d1b9efc60790550683aa655' as Address,
}
const BLOCK_943 = 25_461_939n
const POOLS_943: Pool[] = [
  // tWBTC/tUSDC
  p('0x0ef0bc420a40faada94c1390175f2e5bc931957c', T943.tWBTC, T943.tUSDC, 2_500_000n, 250_000_000n),
  // tUSDC/tWETH
  p('0xbf1ce46d402d3c6b50a2ecc2423ffd32e26494ee', T943.tUSDC, T943.tWETH, 250_000_000n, 10n ** 18n),
  // tPLSX/tWETH
  p(
    '0xe25745bda47601e0bf86a2f1671c58bde7cceda3',
    T943.tPLSX,
    T943.tWETH,
    6_248_919_498_790_585_724_953n,
    10n ** 18n,
  ),
  // WPLS/tUSDC
  p(
    '0xc5cb61b1dbe241616b205804f89a778a5d4ff52d',
    T943.WPLS,
    T943.tUSDC,
    2_777_717_985_410_719_758_201n,
    54_013_024n,
  ),
  // tUSDC/tPLSX
  p(
    '0x0b196d5f756060e67416bf45e3e04146a51ee84b',
    T943.tUSDC,
    T943.tPLSX,
    412_994_009n,
    10_337_014_224_019_625_119_095n,
  ),
].map((x) => ({ ...x, blockNumber: BLOCK_943 }))

/** What the router answered at that block, element for element. */
const ROUTER_943 = [
  {
    path: [T943.tWBTC, T943.tUSDC, T943.WPLS],
    amounts: [1_000_000n, 71_280_489n, 1_578_287_280_390_663_014_197n],
  },
  {
    path: [T943.tWETH, T943.tUSDC, T943.WPLS],
    amounts: [10n ** 17n, 22_667_339n, 819_437_266_934_737_240_116n],
  },
  {
    path: [T943.tWETH, T943.tPLSX, T943.tUSDC, T943.WPLS],
    amounts: [10n ** 17n, 566_585_520_932_254_233_056n, 21_401_464n, 786_634_743_015_877_881_725n],
  },
]

/** Chain 369, PulseX v2, block 27,582,432. One million WPLS into the PLSX pool, direct. */
const F369 = {
  WPLS: '0xa1077a294dde1b09bb078844df40758a5d0f9a27' as Address,
  PLSX: '0x95b303987a60c71504d99aa1b13b4da07b0790ab' as Address,
  amounts: [10n ** 24n, 1_170_148_473_741_842_840_822_221n],
  pool: {
    address: '0x149b2c629e652f2e89e11cd57e5d4d77ee166f9f' as Address,
    reserve0: 49_678_483_571_295_960_936_770_326_241n, // PLSX
    reserve1: 42_330_738_641_653_792_296_603_449_009n, // WPLS
  },
}

/** A pool at the measured PulseX fee, so no test can invent its own rate. */
function p(
  address: string,
  token0: Address,
  token1: Address,
  reserve0: bigint,
  reserve1: bigint,
  venue = 'v1',
  blockNumber = 1_000n,
): Pool {
  return {
    address: address as Address,
    token0,
    token1,
    reserve0,
    reserve1,
    ...FEE,
    venue,
    blockNumber,
  }
}

/** A synthetic address, so a flood can mint as many as it likes. */
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address

const E18 = 10n ** 18n
const NATIVE = addr(0xeeee)

const graph943 = (over: Partial<PoolGraphInit> = {}) => {
  const g = new PoolGraph({
    native: T943.WPLS,
    depthFloor: 1_000n * E18,
    hubs: Object.values(T943),
    maxAgeBlocks: 10_000,
    ...over,
  })
  for (const x of POOLS_943) g.add(x)
  return g
}

/** Walk a path the way the router does, hop by hop, on the pools a quote named. */
function walk(pools: Pool[], path: Address[], amountIn: bigint): bigint[] {
  const amounts = [amountIn]
  for (let i = 0; i < pools.length; i++) amounts.push(poolAmountOut(pools[i], path[i], amounts[i])!)
  return amounts
}

// ── 1 and 2: the router's own numbers ─────────────────────────────────────────

describe('the graph prices what the router prices', () => {
  for (const { path, amounts } of ROUTER_943) {
    test(`943: ${path.length - 1} hops matches getAmountsOut at every step`, () => {
      const g = graph943()
      const pools = path.slice(1).map((to, i) => {
        const found = g
          .all()
          .find((x) =>
            [x.token0, x.token1].every((t) => t === path[i] || t === to),
          )!
        return found
      })
      expect(walk(pools, path, amounts[0])).toEqual(amounts)
    })
  }

  test('369: the direct WPLS/PLSX pool matches getAmountsOut', () => {
    const g = new PoolGraph({ native: F369.WPLS, depthFloor: 0n })
    g.add(p(F369.pool.address, F369.PLSX, F369.WPLS, F369.pool.reserve0, F369.pool.reserve1, 'v2'))
    expect(g.quote(F369.WPLS, F369.PLSX, F369.amounts[0])!.out).toBe(F369.amounts[1])
  })
})

describe('tWBTC and tWETH on 943, which no WPLS pool holds', () => {
  test('tWBTC is priced through tUSDC, at exactly the router figure', () => {
    const g = graph943()
    const q = g.quote(T943.tWBTC, T943.WPLS, 1_000_000n)!
    expect(q.path).toEqual([T943.tWBTC, T943.tUSDC, T943.WPLS])
    expect(q.out).toBe(ROUTER_943[0].amounts[2])
    expect(g.valueInNative(T943.tWBTC, 1_000_000n)).toBe(ROUTER_943[0].amounts[2])
  })

  test('tWETH is priced, and the search takes the better of its two tUSDC routes', () => {
    const g = graph943()
    const q = g.quote(T943.tWETH, T943.WPLS, 10n ** 17n)!
    // The two-hop route through tUSDC pays more than the three-hop one through tPLSX and tUSDC.
    // Both passed the router above; the search must pick the larger.
    expect(q.path).toEqual([T943.tWETH, T943.tUSDC, T943.WPLS])
    expect(q.out).toBe(ROUTER_943[1].amounts[2])
    expect(q.out).toBeGreaterThan(ROUTER_943[2].amounts[3])
  })

  test('with the direct tUSDC leg gone, the three-hop route is found, at the router figure', () => {
    const g = graph943()
    g.remove('0xbf1ce46d402d3c6b50a2ecc2423ffd32e26494ee')
    const q = g.quote(T943.tWETH, T943.WPLS, 10n ** 17n)!
    expect(q.path).toEqual(ROUTER_943[2].path)
    expect(q.out).toBe(ROUTER_943[2].amounts[3])
  })

  test('every one of the five pools qualifies at the 943 floor', () => {
    const g = graph943()
    expect(g.prune(BLOCK_943)).toEqual({ stale: 0, unqualified: 0, crowded: 0, capped: 0 })
    expect(g.qualifiedCount).toBe(5)
  })

  test('the old answer, reproduced: with no graph, nothing values tWBTC in WPLS', () => {
    const g = new PoolGraph({ native: T943.WPLS, depthFloor: 1_000n * E18 })
    g.add(POOLS_943[0])
    // tWBTC/tUSDC alone reaches no WPLS pool, so the filter passes nothing and nothing prices.
    expect(g.valueInNative(T943.tWBTC, 1_000_000n)).toBeNull()
  })
})

// ── 3: the sanity filter ──────────────────────────────────────────────────────

describe('the depth filter is grounded in chain reserves, not in a rank', () => {
  const HUB = addr(0x1)
  const SCAM = addr(0x2)
  const REAL = addr(0x3)
  /** A graph with one real hub: 1e9 native against 1e9 HUB, so one HUB is worth one native. */
  const base = () => {
    const g = new PoolGraph({ native: NATIVE, depthFloor: 1_000_000n * E18, hubs: [HUB] })
    g.add(p(addr(0x100).toString(), NATIVE, HUB, 10n ** 9n * E18, 10n ** 9n * E18))
    return g
  }

  test('a pair a subgraph ranks first, with almost nothing on the priced side, is not routed', () => {
    const g = base()
    // The gamed shape: a subgraph can rank this pair anywhere it likes. On chain it holds a
    // trillion SCAM against 10 HUB, and 10 HUB is 10 native, far under the floor.
    g.add(p(addr(0x200).toString(), SCAM, HUB, 10n ** 12n * E18, 10n * E18))
    expect(g.qualified(addr(0x200))).toBe(false)
    expect(g.valueInNative(SCAM, 10n ** 9n * E18)).toBeNull()
    expect(g.quote(SCAM, HUB, E18)).toBeNull()
    expect(g.prune().unqualified).toBe(1)
    expect(g.has(addr(0x200))).toBe(false)
  })

  test('a token cannot vouch for itself: a trillion units and no priced side is worth nothing', () => {
    const g = base()
    // SCAM/REAL: both sides unknown. No path to the native token, whatever the reserves say.
    g.add(p(addr(0x201).toString(), SCAM, REAL, 10n ** 30n, 10n ** 30n))
    expect(g.qualified(addr(0x201))).toBe(false)
    expect(g.depthNative(addr(0x201))).toBe(0n)
  })

  test('a pool pushed off the market price counts only as deep as its cheap side', () => {
    const g = base()
    // A deep, honest REAL pool sets REAL at one native.
    g.add(p(addr(0x202).toString(), HUB, REAL, 10n ** 8n * E18, 10n ** 8n * E18))
    // A second pool with 5e7 HUB but only 1,000 REAL: at the graph's own rates its REAL side is
    // worth 1,000 native, and the pool is only that deep.
    g.add(p(addr(0x203).toString(), HUB, REAL, 5n * 10n ** 7n * E18, 1_000n * E18))
    expect(g.qualified(addr(0x203))).toBe(false)
    expect(g.qualified(addr(0x202))).toBe(true)
    // With no floor at all, the same pool counts exactly its cheap side.
    const open = new PoolGraph({ native: NATIVE, depthFloor: 0n })
    for (const x of g.all()) open.add(x)
    expect(open.depthNative(addr(0x203))).toBe(1_000n * E18)
  })

  test('a real pool behind a real, deep path qualifies, however the subgraph ranked it', () => {
    const g = base()
    g.add(p(addr(0x204).toString(), HUB, REAL, 5n * 10n ** 6n * E18, 10n ** 6n * E18))
    expect(g.qualified(addr(0x204))).toBe(true)
    // Five million HUB is five million native; REAL takes its price from this pool.
    expect(g.depthNative(addr(0x204))).toBe(5n * 10n ** 6n * E18)
  })

  test('a token takes its price from the widest path, not from the first pool read', () => {
    const g = base()
    // First read: a thin pool that says one REAL is worth 100 native.
    g.add(p(addr(0x205).toString(), HUB, REAL, 2n * 10n ** 6n * E18, 2n * 10n ** 4n * E18))
    // Then a pool fifty times deeper that says one REAL is worth one native.
    g.add(p(addr(0x206).toString(), HUB, REAL, 10n ** 8n * E18, 10n ** 8n * E18))
    // The thin pool is now judged at the deep pool's price: its REAL side is 20,000 native.
    expect(g.depthNative(addr(0x206))).toBe(10n ** 8n * E18)
    expect(g.depthNative(addr(0x205))).toBe(0n)
  })

  test('no native token: nothing qualifies, and the graph quotes nothing', () => {
    const g = new PoolGraph({ native: null })
    g.add(p(addr(0x207).toString(), HUB, REAL, E18, E18))
    expect(g.quote(HUB, REAL, 1000n)).toBeNull()
  })
})

// ── 4: addresses, never symbols ───────────────────────────────────────────────

describe('two tokens called DAI never merge', () => {
  // Chain 369, measured 2026-09-23 in PulseX's own subgraphs. Both report symbol "DAI".
  const pDAI = '0x6b175474e89094c44da98b954eedeac495271d0f' as Address // forked copy, ~$0.0022
  const DAI = '0xefd766ccb38eaf1dfd701853bfce31359239f305' as Address // bridged, ~$1.00
  const ATROPA = '0xcc78a0acdf847a2c1714d2a925bb4477df5d48a6' as Address
  const WPLS = F369.WPLS

  test('each DAI is priced from its own pools, 450 times apart', () => {
    const g = new PoolGraph({ native: WPLS, depthFloor: 0n })
    // Round numbers in the measured ratio: bridged DAI at 86,580 WPLS, pDAI at 193.
    g.add(p(addr(0x301).toString(), WPLS, DAI, 86_580n * 10n ** 6n * E18, 10n ** 6n * E18))
    g.add(p(addr(0x302).toString(), WPLS, pDAI, 193n * 10n ** 9n * E18, 10n ** 9n * E18))
    g.add(p(addr(0x303).toString(), pDAI, ATROPA, 5_323n * 10n ** 6n * E18, 259n * 10n ** 6n * E18))
    const one = E18
    const bridged = g.valueInNative(DAI, one)!
    const forked = g.valueInNative(pDAI, one)!
    expect(bridged / forked).toBeGreaterThan(400n)
    // ATROPA reaches WPLS through pDAI, and never through the other DAI.
    const q = g.quote(ATROPA, WPLS, E18)!
    expect(q.path).toEqual([ATROPA, pDAI, WPLS])
    expect(q.path).not.toContain(DAI)
  })

  test('a pool of one DAI never answers for the other', () => {
    const g = new PoolGraph({ native: WPLS, depthFloor: 0n })
    g.add(p(addr(0x302).toString(), WPLS, pDAI, 193n * E18, E18))
    expect(g.valueInNative(pDAI, E18)).not.toBeNull()
    expect(g.valueInNative(DAI, E18)).toBeNull()
  })

  test('the cache keeps them apart too', () => {
    const g = new PoolGraph({ native: WPLS, depthFloor: 0n })
    g.add(p(addr(0x301).toString(), WPLS, DAI, 86_580n * E18, E18))
    g.add(p(addr(0x302).toString(), WPLS, pDAI, 193n * E18, E18))
    const back = PoolGraph.parse(g.serialize(369), 369, { native: WPLS, depthFloor: 0n })
    expect(back.valueInNative(DAI, E18)).toBe(g.valueInNative(DAI, E18))
    expect(back.valueInNative(pDAI, E18)).toBe(g.valueInNative(pDAI, E18))
  })
})

// ── Pathfinding ───────────────────────────────────────────────────────────────

describe('pathfinding', () => {
  const [A, B, C, D] = [addr(0xa), addr(0xb), addr(0xc), addr(0xd)]
  const chain4 = (native = A) => {
    const g = new PoolGraph({ native, depthFloor: 0n })
    g.add(p(addr(0x401).toString(), A, B, 10n ** 24n, 10n ** 24n))
    g.add(p(addr(0x402).toString(), B, C, 10n ** 24n, 10n ** 24n))
    g.add(p(addr(0x403).toString(), C, D, 10n ** 24n, 10n ** 24n))
    return g
  }

  test('a three-hop route is found', () => {
    expect(chain4().quote(A, D, E18)!.path).toEqual([A, B, C, D])
  })

  test('maxHops is a hard stop', () => {
    const g = chain4()
    g.add(p(addr(0x404).toString(), D, addr(0xe), 10n ** 24n, 10n ** 24n))
    expect(g.quote(A, addr(0xe), E18)).toBeNull()
  })

  test('a path never mixes venues, because the fill sells through one router', () => {
    const g = new PoolGraph({ native: A, depthFloor: 0n })
    g.add(p(addr(0x405).toString(), A, B, 10n ** 24n, 10n ** 24n, 'v1'))
    g.add(p(addr(0x406).toString(), B, C, 10n ** 24n, 10n ** 24n, 'v2'))
    expect(g.quote(A, C, E18)).toBeNull()
  })

  test('the direct pool is always tried, even when topK deeper pools crowd it out', () => {
    const g = new PoolGraph({ native: A, depthFloor: 0n, topK: 2 })
    // Five deep pools from A to elsewhere, and one shallower direct pool to the target.
    for (let i = 0; i < 5; i++) g.add(p(addr(0x500 + i).toString(), A, addr(0x600 + i), 10n ** 27n, 10n ** 27n))
    g.add(p(addr(0x510).toString(), A, B, 10n ** 22n, 10n ** 22n))
    expect(g.quote(A, B, E18)!.path).toEqual([A, B])
  })

  test('the search stays bounded with a hub of a thousand pools', () => {
    const g = new PoolGraph({ native: A, depthFloor: 0n, maxPools: 5_000 })
    for (let i = 0; i < 1_000; i++) {
      g.add(p(addr(0x10000 + i).toString(), A, addr(0x20000 + i), 10n ** 24n, 10n ** 24n))
      g.add(p(addr(0x30000 + i).toString(), addr(0x20000 + i), B, 10n ** 24n, 10n ** 24n))
    }
    const t = Date.now()
    expect(g.quote(A, B, E18)).not.toBeNull()
    expect(Date.now() - t).toBeLessThan(500)
  })

  test('an empty pool prices nothing rather than dividing by zero', () => {
    const g = new PoolGraph({ native: A, depthFloor: 0n })
    g.add(p(addr(0x407).toString(), A, B, 0n, 10n ** 24n))
    expect(g.quote(A, B, E18)).toBeNull()
  })
})

// ── 5: the bound ──────────────────────────────────────────────────────────────

/** A seeded generator, so a failing flood can be replayed. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0
    return s / 2 ** 32
  }
}

describe('the bound, as properties under a flood', () => {
  test('whatever arrives, size never passes maxPools and the survivors are the deepest', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = rng(seed)
      const maxPools = 50 + Math.floor(r() * 50)
      const g = new PoolGraph({ native: NATIVE, depthFloor: 0n, maxPools, maxPerToken: 10_000 })
      const n = 200 + Math.floor(r() * 400)
      for (let i = 0; i < n; i++) {
        const depth = BigInt(Math.floor(r() * 1e9) + 1) * E18
        g.add(p(addr(0x100000 + i).toString(), NATIVE, addr(0x200000 + i), depth, depth, 'v1', 5_000n))
      }
      const before = new Map(g.all().map((x) => [x.address.toLowerCase(), g.depthNative(x.address)]))
      g.prune(5_000n)
      expect(g.size).toBeLessThanOrEqual(maxPools)
      const kept = new Set(g.all().map((x) => x.address.toLowerCase()))
      const shallowestKept = [...kept].map((k) => before.get(k)!).reduce((a, b) => (a < b ? a : b))
      for (const [k, d] of before) if (!kept.has(k)) expect(d).toBeLessThanOrEqual(shallowestKept)
    }
  })

  test('the cap never keeps a pool and drops the pool that prices its token', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const r = rng(seed)
      const g = new PoolGraph({ native: NATIVE, depthFloor: E18, maxPools: 5 + Math.floor(r() * 30), maxPerToken: 1_000 })
      // A random tree hanging from the native token, with pools of random depth. A child pool is
      // often deeper than its parent, which is the shape that breaks a depth-only cap.
      const tokens: Address[] = [NATIVE]
      for (let i = 0; i < 80; i++) {
        const parent = tokens[Math.floor(r() * tokens.length)]
        const child = addr(0x300000 + i)
        const size = BigInt(Math.floor(r() * 1e6) + 2) * E18
        g.add(p(addr(0x400000 + i).toString(), parent, child, size, size, 'v1', 10n))
        tokens.push(child)
      }
      const cap = g.options.maxPools
      const result = g.prune(10n)
      expect(g.size).toBe(cap)
      expect(result.unqualified).toBe(0)
      for (const x of g.all()) expect(g.qualified(x.address)).toBe(true)
    }
  })

  test('the cap keeps the deepest by chain reserves, not the first read', () => {
    const g = new PoolGraph({ native: NATIVE, depthFloor: 0n, maxPools: 3, maxPerToken: 100 })
    // Read shallow first, deep last.
    for (let i = 1; i <= 6; i++) {
      g.add(p(addr(0x700 + i).toString(), NATIVE, addr(0x800 + i), BigInt(i) * E18, BigInt(i) * E18))
    }
    g.prune()
    expect(g.all().map((x) => x.address).sort()).toEqual([addr(0x704), addr(0x705), addr(0x706)])
  })

  test('a pool nobody observed inside maxAgeBlocks is evicted, however deep', () => {
    const g = new PoolGraph({ native: NATIVE, depthFloor: 0n, maxAgeBlocks: 100 })
    g.add(p(addr(0x901).toString(), NATIVE, addr(0x902), 10n ** 30n, 10n ** 30n, 'v1', 1_000n))
    g.add(p(addr(0x903).toString(), NATIVE, addr(0x904), E18, E18, 'v1', 1_150n))
    expect(g.prune(1_200n).stale).toBe(1)
    expect(g.has(addr(0x901))).toBe(false)
    expect(g.has(addr(0x903))).toBe(true)
  })

  test('a flood of fresh pairs of one unknown token cannot crowd out the rest', () => {
    const SPAM = addr(0xdead)
    const g = new PoolGraph({ native: NATIVE, depthFloor: 0n, maxPools: 100, maxPerToken: 8 })
    for (let i = 0; i < 20; i++) {
      g.add(p(addr(0xa00 + i).toString(), NATIVE, addr(0xb00 + i), 10n ** 20n, 10n ** 20n))
    }
    // 500 deep pools of one token, each paired with a real one.
    for (let i = 0; i < 500; i++) {
      g.add(p(addr(0xc000 + i).toString(), NATIVE, SPAM, 10n ** 24n, 10n ** 24n))
    }
    const r = g.prune()
    expect(g.all().filter((x) => [x.token0, x.token1].includes(SPAM))).toHaveLength(8)
    expect(r.crowded).toBe(492)
    // Every real pool survived.
    for (let i = 0; i < 20; i++) expect(g.has(addr(0xa00 + i))).toBe(true)
  })

  test('evicting the pool that priced a token takes out the pools that needed it', () => {
    const X = addr(0xf01)
    const g = new PoolGraph({ native: NATIVE, depthFloor: 10n * E18, maxAgeBlocks: 100 })
    g.add(p(addr(0xf02).toString(), NATIVE, X, 100n * E18, 100n * E18, 'v1', 1_000n))
    g.add(p(addr(0xf03).toString(), X, addr(0xf04), 100n * E18, 100n * E18, 'v1', 1_150n))
    const r = g.prune(1_200n)
    expect(r.stale).toBe(1)
    expect(r.unqualified).toBe(1)
    expect(g.size).toBe(0)
  })

  test('eviction unlinks the token index, so it does not leak', () => {
    const g = new PoolGraph({ native: NATIVE, depthFloor: 0n, maxAgeBlocks: 10 })
    for (let i = 0; i < 100; i++) g.add(p(addr(0xd00 + i).toString(), NATIVE, addr(0xe00 + i), E18, E18, 'v1', 1n))
    g.prune(1_000n)
    expect(g.size).toBe(0)
    // Nothing reachable: every adjacency entry went with its last pool.
    expect(g.venues()).toEqual([])
    expect((g as unknown as { adj: Map<string, unknown> }).adj.size).toBe(0)
  })

  test('4,000 pools fit in a few megabytes of heap, and the bound holds at that size', () => {
    const g = new PoolGraph({ native: NATIVE, depthFloor: 0n, maxPools: 4_000, maxPerToken: 10_000 })
    const gc = (globalThis as { gc?: () => void }).gc
    gc?.()
    const before = process.memoryUsage().heapUsed
    for (let i = 0; i < 6_000; i++) {
      g.add(p(addr(0x1000000 + i).toString(), NATIVE, addr(0x2000000 + i), 10n ** 25n + BigInt(i), 10n ** 25n))
    }
    g.prune()
    gc?.()
    const used = process.memoryUsage().heapUsed - before
    expect(g.size).toBe(4_000)
    // Loose, because a heap measurement without a forced collection includes garbage. The
    // bot host has 512 MB; the point is that this is three orders of magnitude under it.
    expect(used).toBeLessThan(40 * 1024 * 1024)
    expect(g.serialize(369).length).toBeLessThan(1_000_000)
  })
})

// ── Freshness ─────────────────────────────────────────────────────────────────

describe('freshness', () => {
  test('an older Sync never walks reserves backwards', () => {
    const g = new PoolGraph({ native: NATIVE, depthFloor: 0n })
    g.add(p(addr(0x1).toString(), NATIVE, addr(0x2), 10n, 10n, 'v1', 100n))
    g.observe(addr(0x1), 7n, 7n, 90n)
    expect(g.get(addr(0x1))!.reserve0).toBe(10n)
    g.observe(addr(0x1), 7n, 7n, 110n)
    expect(g.get(addr(0x1))!.reserve0).toBe(7n)
  })

  test('a Sync for a pair the graph does not hold is ignored, not guessed at', () => {
    const g = new PoolGraph({ native: NATIVE, depthFloor: 0n })
    expect(g.observe(addr(0x9), 1n, 1n, 5n)).toBe(false)
    expect(g.size).toBe(0)
  })

  test('touch never moves a pool past the gap-free coverage mark', () => {
    const g = new PoolGraph({ native: NATIVE, depthFloor: 0n })
    g.add(p(addr(0x1).toString(), NATIVE, addr(0x2), 10n, 10n, 'v1', 100n))
    g.touch([addr(0x1)], 500n)
    expect(g.get(addr(0x1))!.blockNumber).toBe(100n)
    g.coverTo(300n)
    g.touch([addr(0x1)], 500n)
    expect(g.get(addr(0x1))!.blockNumber).toBe(300n)
  })
})

describe('a reserve that moved between the quote and the send', () => {
  test('the stale quote overstates, and the bound built from it is what makes the fill revert', () => {
    const g = graph943()
    const q = g.quote(T943.tWBTC, T943.WPLS, 1_000_000n)!
    // The executor sends with amountOutMin at what it owes plus the gas; take the quote itself
    // as the tightest such bound.
    const amountOutMin = q.out
    // Someone sells tUSDC into WPLS/tUSDC in the next block: WPLS leaves the pool.
    g.observe(
      '0xc5cb61b1dbe241616b205804f89a778a5d4ff52d',
      2_700_000_000_000_000_000_000n,
      55_600_000n,
      BLOCK_943 + 1n,
    )
    const now = g.quote(T943.tWBTC, T943.WPLS, 1_000_000n)!
    expect(now.out).toBeLessThan(amountOutMin)
    // The router checks the output against amountOutMin, so this trade reverts on chain and
    // nothing moves. The graph's job is to say how stale the quote was.
    expect(q.syncedAt).toBe(BLOCK_943)
    expect(now.syncedAt).toBe(BLOCK_943)
  })
})

// ── 6: the cache file ─────────────────────────────────────────────────────────

describe('the cache file', () => {
  const opts = { native: T943.WPLS, depthFloor: 1_000n * E18, maxAgeBlocks: 10_000 }

  test('a round trip quotes the same as the graph that wrote it', () => {
    const g = graph943()
    g.coverTo(BLOCK_943)
    const back = PoolGraph.parse(g.serialize(943), 943, opts)
    expect(back.size).toBe(5)
    expect(back.syncedTo).toBe(BLOCK_943)
    expect(back.quote(T943.tWBTC, T943.WPLS, 1_000_000n)).toEqual(
      g.quote(T943.tWBTC, T943.WPLS, 1_000_000n),
    )
  })

  const corrupt: [string, (text: string) => string][] = [
    ['truncated mid-write', (t) => t.slice(0, Math.floor(t.length / 2))],
    ['empty', () => ''],
    ['not JSON', () => '\u0000\u0001garbage'],
    ['JSON but not an object', () => '[1,2,3]'],
    ['an older format', (t) => t.replace('"v":2', '"v":1')],
    ['the other chain', (t) => t.replace('"chainId":943', '"chainId":369')],
    ['pools not a list', (t) => t.replace(/"pools":\[.*\]/, '"pools":{}')],
  ]
  for (const [name, damage] of corrupt) {
    test(`${name}: an empty graph, never a throw`, () => {
      const g = graph943()
      const back = PoolGraph.parse(damage(g.serialize(943)), 943, opts)
      expect(back.size).toBe(0)
      expect(back.syncedTo).toBe(0n)
    })
  }

  test('a damaged row is dropped and the rest load', () => {
    const g = graph943()
    const file = JSON.parse(g.serialize(943))
    file.pools[0][3] = 'not a number'
    file.pools[1][0] = '0xnothex'
    file.pools[2][7] = '0' // fee denominator zero
    file.pools.push(['short'])
    const back = PoolGraph.parse(JSON.stringify(file), 943, opts)
    expect(back.size).toBe(2)
  })

  test('a coverage mark past the newest block in the file is not trusted', () => {
    const g = graph943()
    const file = JSON.parse(g.serialize(943))
    file.syncedTo = '999999999999'
    expect(PoolGraph.parse(JSON.stringify(file), 943, opts).syncedTo).toBe(0n)
  })

  test('a loaded cache is still subject to the bound', () => {
    const g = graph943()
    const back = PoolGraph.parse(g.serialize(943), 943, { ...opts, maxPools: 2 })
    back.prune()
    expect(back.size).toBe(2)
  })
})

import type { Address } from 'viem'
import { poolAmountOut, type Pool } from './price.js'

/**
 * A bounded pool graph, so a route can be up to three hops long.
 *
 * `market.ts` asks each router for two paths per pair: the direct pool, and one hop through WPLS.
 * That is why the executor skips every tWBTC and tWETH intent on chain 943. Neither token has a
 * WPLS pool. On 2026-09-23 the only pools that hold them are tWBTC/tUSDC, tWETH/tUSDC and
 * tWETH/tPLSX, so the via-WPLS leg reverts and nothing values the proceeds in WPLS. The route
 * `tWBTC -> tUSDC -> WPLS` exists, and nothing asked for it. This graph holds the pools and
 * searches them.
 *
 * **Where the numbers come from.** A subgraph says which pairs exist (`subgraph.ts`). The chain
 * gives every reserve, through `getReserves` and then `Sync` logs (`graphsync.ts`). This file
 * never reads either. It is pure, so the bound, the filter and the search are all unit tests.
 *
 * **What it is not.**
 *
 * It is not the authority on a price. A quote here comes from reserves that were true at a past
 * block, and a pool can move before the fill lands. The executor simulates every fill against
 * the chain before it sends one, and that simulation is the last word. This graph only decides
 * which intents are worth a simulation.
 *
 * It is not unbounded. `prune` evicts stale pools, pools that fail the depth filter, and then the
 * shallowest pools above `maxPools`. `graph.test.ts` holds that bound under a flood.
 *
 * **Every token is keyed by its address.** Never by its symbol. Chain 369 has two tokens called
 * DAI, 450 times apart in price: pDAI `0x6b17…1d0f`, forked from Ethereum at launch, and the
 * bridged `0xefd7…f305`. USDC, USDT, WETH, WBTC and HEX each have the same split. A symbol is
 * for a log line only.
 */

/** What a path search found: the proceeds, and the exact pools that pay them. */
export type GraphQuote = {
  /** Proceeds in `tokenOut`, from the snapshot reserves at each venue's own fee. */
  out: bigint
  /** The token path, `tokenIn` first and `tokenOut` last. One longer than `pools`. */
  path: Address[]
  /** The pools the path crosses, in order. */
  pools: Pool[]
  /**
   * The venue every pool on this path belongs to.
   *
   * A path never mixes venues. The executor sells along the path with one router call, and a
   * router walks only its own factory's pairs. A path with a hop at the other venue would sell
   * into pools nobody quoted, and `amountOutMin` would bound the wrong curve.
   */
  venue: string
  /** The oldest block any pool on this path was last observed at. How stale this quote can be. */
  syncedAt: bigint
}

/** How large the graph may grow, how far it searches, and what it measures depth in. */
export type PoolGraphOptions = {
  /**
   * The most pools held at once. Above this, `prune` evicts the shallowest.
   *
   * 4,000 fits the bot host (512 MB, one core) with room to spare. Measured on 2026-09-23 with
   * random 40-hex addresses: 4,000 pools held 4.5 MB of heap after a collection, wrote a 904 KB
   * cache file that parses in 12 ms, and a prune of a 6,050-pool flood took 119 ms.
   */
  maxPools: number
  /**
   * A pool that nobody observed for this many blocks is evicted, however deep it is.
   *
   * "Observed" means a `Sync` log, a `getReserves` read, or a discovery that listed the pool
   * again while the `Sync` poll had no gap (then no `Sync` means the reserves did not change).
   * So a quiet pool that discovery still lists stays. A pool that discovery stopped listing and
   * that nobody trades goes. 1,000 blocks is about three hours on either chain.
   */
  maxAgeBlocks: number
  /** Pools expanded per token at each step of a search. The search is at most `topK ** maxHops`. */
  topK: number
  /** The longest path, in swaps. */
  maxHops: number
  /**
   * The wrapped native token. Depth and `valueInNative` are both measured in it.
   *
   * Null means no pool can qualify (see `depthFloor`), so the graph quotes nothing. A caller
   * then falls back to `quoteAll`, which is what a chain with no WPLS gets today.
   */
  native: Address | null
  /**
   * The depth a pool needs to be routed through, in native-token wei.
   *
   * See `qualify` for the rule. The floor is per chain because WPLS is worth very different
   * amounts on each: `graphsync.ts` holds the chosen values and the reasons.
   */
  depthFloor: bigint
  /**
   * The most pools one token may hold in the graph, unless it is a hub.
   *
   * Without this, one token with many funded pairs could fill the cap and push out the pools
   * that real routes need. The deepest pools of that token are kept.
   */
  maxPerToken: number
  /** Tokens exempt from `maxPerToken`: the native token and the registry's own tokens. */
  hubs: readonly Address[]
}

/** The defaults, minus the values only a chain can supply. */
export const POOL_GRAPH_DEFAULTS: Omit<PoolGraphOptions, 'native' | 'depthFloor' | 'hubs'> = {
  maxPools: 4_000,
  maxAgeBlocks: 1_000,
  topK: 4,
  maxHops: 3,
  maxPerToken: 32,
}

/** The options a caller must give. Everything else has a default. */
export type PoolGraphInit = Partial<PoolGraphOptions> & Pick<PoolGraphOptions, 'native'>

/** What one `prune` removed, so a caller can log it and a test can assert on it. */
export type PruneResult = {
  /** Not observed inside `maxAgeBlocks`. */
  stale: number
  /** No path to the native token through pools that clear the depth floor. */
  unqualified: number
  /** Over `maxPerToken` for a non-hub token, shallowest first. */
  crowded: number
  /** Over `maxPools`, shallowest first. */
  capped: number
}

/** An exact rate: one unit of the token is worth `num / den` units of the native token. */
type Rate = { num: bigint; den: bigint }

/**
 * Keep a rate's two halves small enough to multiply cheaply.
 *
 * Each hop multiplies both halves by a reserve, and a reserve can be 1e28. Shifting both halves
 * by the same amount changes the ratio by less than one part in 2^96, far below anything a depth
 * comparison can see.
 */
const CEIL = 1n << 192n
function normalize(r: Rate): Rate {
  let { num, den } = r
  while (num > CEIL || den > CEIL) {
    num >>= 64n
    den >>= 64n
  }
  // A shift to zero would make the rate meaningless rather than imprecise.
  return den === 0n ? { num: 0n, den: 1n } : { num, den }
}

const lc = (a: string) => a.toLowerCase()
const ADDRESS = /^0x[0-9a-f]{40}$/

/** The token on the other side of a pool, or null when `token` is not in it. */
function other(pool: Pool, token: string): string | null {
  const t0 = lc(pool.token0)
  const t1 = lc(pool.token1)
  if (token === t0) return t1
  if (token === t1) return t0
  return null
}

/** The pool's reserve of one of its tokens, or null when it holds none. */
function reserveOf(pool: Pool, token: string): bigint | null {
  if (token === lc(pool.token0)) return pool.reserve0
  if (token === lc(pool.token1)) return pool.reserve1
  return null
}

/** A max-heap on `width`, for the widest-path search in `qualify`. */
type Reach = { token: string; width: bigint; rate: Rate; via: string | null }
class MaxHeap {
  private readonly items: Reach[] = []
  get size() {
    return this.items.length
  }
  push(x: Reach) {
    const a = this.items
    a.push(x)
    let i = a.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (a[p].width >= a[i].width) break
      ;[a[p], a[i]] = [a[i], a[p]]
      i = p
    }
  }
  pop(): Reach | undefined {
    const a = this.items
    if (a.length === 0) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = l + 1
        let m = i
        if (l < a.length && a[l].width > a[m].width) m = l
        if (r < a.length && a[r].width > a[m].width) m = r
        if (m === i) break
        ;[a[m], a[i]] = [a[i], a[m]]
        i = m
      }
    }
    return top
  }
}

/** The result of one qualification pass, cached until the graph changes. */
type Qualification = {
  version: number
  /** Lowercase token to its native rate. Only tokens reachable through qualified pools. */
  rates: Map<string, Rate>
  /** Lowercase pair to its depth in native wei. Only qualified pools are present. */
  depth: Map<string, bigint>
  /**
   * Lowercase pair to its rank for the cap: its depth, or the width of the path that prices its
   * tokens, whichever is smaller. See `prune`.
   */
  rank: Map<string, bigint>
  /** Lowercase pair to the order its later token was priced in. Closer to the native token first. */
  seq: Map<string, number>
  /** The pools that priced a token: the tree every other pool hangs from. */
  tree: Set<string>
}

export class PoolGraph {
  readonly options: PoolGraphOptions

  /** Every pool held, keyed by its lowercase pair address. */
  private readonly pools = new Map<string, Pool>()
  /** Lowercase token address to the pair addresses that hold it. Kept in step with `pools`. */
  private readonly adj = new Map<string, Set<string>>()
  private readonly hubs: Set<string>

  /** The highest block any observation has come from. Staleness is measured against it. */
  private highest = 0n
  /**
   * The block through which every `Sync` has been applied without a gap.
   *
   * The keeper sets it. While it holds, a pool with no `Sync` has not changed, so its reserves
   * are exact through this block. A gap breaks that, and the keeper then reads the reserves again.
   */
  private covered = 0n

  /** Bumped by every change, so the qualification cache knows when it is stale. */
  private version = 0
  private cache: Qualification | null = null

  constructor(options: PoolGraphInit) {
    this.options = {
      ...POOL_GRAPH_DEFAULTS,
      depthFloor: 0n,
      hubs: [],
      ...options,
    }
    this.hubs = new Set(this.options.hubs.map(lc))
    if (this.options.native) this.hubs.add(lc(this.options.native))
  }

  /** How many pools the graph holds, qualified or not. */
  get size(): number {
    return this.pools.size
  }

  /** The highest block the graph has heard about. */
  get head(): bigint {
    return this.highest
  }

  /** The block through which `Sync` coverage has no gap. Zero before the first poll. */
  get syncedTo(): bigint {
    return this.covered
  }

  /**
   * Record that every `Sync` through `block` has been applied. The keeper calls this, and only
   * after a poll with no gap or a full re-read of the reserves.
   */
  coverTo(block: bigint): void {
    this.covered = block
    this.advance(block)
  }

  /** Every pool held, in no particular order. */
  all(): Pool[] {
    return [...this.pools.values()]
  }

  /** One pool by its pair address, or undefined. */
  get(pair: Address): Pool | undefined {
    return this.pools.get(lc(pair))
  }

  /** True when the graph holds this pair. */
  has(pair: Address): boolean {
    return this.pools.has(lc(pair))
  }

  /** Tell the graph about a block, so staleness advances. */
  advance(blockNumber: bigint): void {
    if (blockNumber > this.highest) this.highest = blockNumber
  }

  /**
   * Add or replace a pool from a chain read. A newer snapshot of a pool already held wins; an
   * older one is ignored, so a late read cannot move reserves backwards.
   */
  add(pool: Pool): void {
    const key = lc(pool.address)
    const held = this.pools.get(key)
    if (held && held.blockNumber > pool.blockNumber) return
    if (held) this.unlink(key, held)
    this.pools.set(key, { ...pool })
    this.link(lc(pool.token0), key)
    this.link(lc(pool.token1), key)
    this.advance(pool.blockNumber)
    this.version++
  }

  /** Forget one pool. */
  remove(pair: Address): boolean {
    const key = lc(pair)
    const held = this.pools.get(key)
    if (!held) return false
    this.unlink(key, held)
    this.pools.delete(key)
    this.version++
    return true
  }

  /**
   * Apply a `Sync`. True when the pair is held. A `Sync` for a pair the graph does not hold is
   * ignored: discovery decides which pairs to hold, and a log names no tokens.
   */
  observe(pair: Address, reserve0: bigint, reserve1: bigint, blockNumber: bigint): boolean {
    this.advance(blockNumber)
    const held = this.pools.get(lc(pair))
    if (!held) return false
    // An older log must not overwrite a newer snapshot.
    if (blockNumber < held.blockNumber) return true
    held.reserve0 = reserve0
    held.reserve1 = reserve1
    held.blockNumber = blockNumber
    this.version++
    return true
  }

  /**
   * Mark pools as observed at `block` without a change of reserves.
   *
   * Only sound while `Sync` coverage has no gap: then a pool with no `Sync` did not change. So
   * the block is clamped to `syncedTo`, and nothing moves before the first gap-free poll.
   */
  touch(pairs: Iterable<string>, block: bigint): number {
    const at = block < this.covered ? block : this.covered
    let n = 0
    for (const pair of pairs) {
      const held = this.pools.get(lc(pair))
      if (held && held.blockNumber < at) {
        held.blockNumber = at
        n++
      }
    }
    // Reserves did not change, so the qualification cache is still right.
    return n
  }

  /**
   * The bound, in four passes.
   *
   * **Staleness.** A pool not observed inside `maxAgeBlocks` of `head` goes, whatever its
   * depth. The keeper passes `syncedTo` as `head`, not the chain head: a block the graph has not
   * observed cannot age anything, so an endpoint that stops answering does not empty the graph.
   *
   * **The depth filter.** A pool that `qualify` does not pass goes. It cannot be routed through,
   * and holding it only costs memory.
   *
   * **One token cannot crowd the rest.** A non-hub token keeps its `maxPerToken` deepest pools.
   *
   * **The cap.** Above `maxPools`, the shallowest go. Depth is in native wei from chain
   * reserves, so the cap keeps the deepest pools by chain truth. Never the first ones read, and
   * never the subgraph's rank.
   *
   * "Deepest" is ranked with the path in mind. A pool is only routable while the pools that price
   * its tokens stay, and those can be shallower than it: on 943, tUSDC/tPLSX holds eight times
   * the WPLS/tUSDC pool that prices tUSDC. Capping by depth alone would keep the deep pool and
   * drop its root, and then neither routes. So the rank is the smaller of the pool's depth and the
   * width of the paths to its tokens. A pool on the path to a token then never ranks below a pool
   * that needs that token. Ties go to the pool nearer the native token, then to a pool that priced
   * a token, then to the newer observation, then to the lower address.
   *
   * Eviction can remove the pool that priced a token, and then other pools lose their path to
   * the native token. So the filter runs again after the cap, until nothing changes. Each round
   * that changes anything removes at least one pool, so the loop ends; the round limit is a
   * guard, and the test under a flood checks the bound holds when it returns.
   */
  prune(head: bigint = this.highest): PruneResult {
    const { maxAgeBlocks, maxPools, maxPerToken } = this.options
    const floor = head > BigInt(maxAgeBlocks) ? head - BigInt(maxAgeBlocks) : 0n
    const result: PruneResult = { stale: 0, unqualified: 0, crowded: 0, capped: 0 }

    for (const [key, pool] of [...this.pools]) {
      if (pool.blockNumber < floor) {
        this.drop(key, pool)
        result.stale++
      }
    }

    for (let round = 0; round < 16; round++) {
      const { depth } = this.qualify()
      let changed = false
      for (const [key, pool] of [...this.pools]) {
        if (!depth.has(key)) {
          this.drop(key, pool)
          result.unqualified++
          changed = true
        }
      }
      if (changed) continue

      const { rank, seq, tree } = this.qualify()
      const ranked = [...this.pools.entries()]
        .map(([key, pool]) => ({ key, pool, rank: rank.get(key)!, seq: seq.get(key)!, tree: tree.has(key) }))
        .sort((a, b) => {
          if (a.rank !== b.rank) return a.rank > b.rank ? -1 : 1
          if (a.seq !== b.seq) return a.seq - b.seq
          if (a.tree !== b.tree) return a.tree ? -1 : 1
          if (a.pool.blockNumber !== b.pool.blockNumber) {
            return a.pool.blockNumber > b.pool.blockNumber ? -1 : 1
          }
          return a.key < b.key ? -1 : 1
        })
      const perToken = new Map<string, number>()
      let kept = 0
      for (const { key, pool } of ranked) {
        const tokens = [lc(pool.token0), lc(pool.token1)].filter((t) => !this.hubs.has(t))
        if (tokens.some((t) => (perToken.get(t) ?? 0) >= maxPerToken)) {
          this.drop(key, pool)
          result.crowded++
          changed = true
          continue
        }
        if (kept >= maxPools) {
          this.drop(key, pool)
          result.capped++
          changed = true
          continue
        }
        kept++
        for (const t of tokens) perToken.set(t, (perToken.get(t) ?? 0) + 1)
      }
      if (!changed) break
    }
    return result
  }

  /**
   * Which pools can be routed through, and what each token is worth in the native token.
   *
   * **The rule.** A pool qualifies when both of its tokens have a native rate, and the smaller
   * of its two sides, valued at those rates, clears `depthFloor`. A token gets its rate from the
   * native token outward: through a pool whose side of an already-priced token clears the floor.
   * Among several such pools, the widest path wins: the path whose shallowest pool is deepest.
   *
   * **Why this rule.** Every input is a chain reserve. The subgraph's `trackedReservePLS` orders
   * discovery and never enters here, because a subgraph field is a claim and a reserve is a fact.
   * And depth is counted only on sides the graph can already price. So a new token cannot vouch
   * for itself: a pool of it with a trillion units and no real counter-side is worth what its
   * counter-side is worth. A pool whose two sides disagree with the rest of the graph (one side
   * worth much less than the other at the graph's own rates) takes the smaller side, so a pool
   * pushed off the market price counts only as deep as its cheap side.
   *
   * The cost is honest: a pool reachable only through pools under the floor is not routed. That
   * is the point of a floor.
   *
   * The rates are marginal reserve ratios, not sized quotes. The question is how big a pool is,
   * and the answer must not depend on a trade size nobody named. `valueInNative` is the sized one.
   */
  qualify(): Qualification {
    if (this.cache && this.cache.version === this.version) return this.cache
    const rates = new Map<string, Rate>()
    const depth = new Map<string, bigint>()
    const rank = new Map<string, bigint>()
    const seq = new Map<string, number>()
    const tree = new Set<string>()
    const native = this.options.native
    if (!native) {
      this.cache = { version: this.version, rates, depth, rank, seq, tree }
      return this.cache
    }
    const floor = this.options.depthFloor

    // Widest path from the native token, one token at a time, deepest first.
    const done = new Set<string>()
    const best = new Map<string, bigint>()
    const heap = new MaxHeap()
    const root = lc(native)
    // Wider than any real pool: nothing outranks the root.
    const INF = 1n << 255n
    heap.push({ token: root, width: INF, rate: { num: 1n, den: 1n }, via: null })
    best.set(root, INF)
    const order = new Map<string, number>()
    while (heap.size > 0) {
      const at = heap.pop()!
      if (done.has(at.token)) continue
      done.add(at.token)
      order.set(at.token, order.size)
      rates.set(at.token, at.rate)
      if (at.via) tree.add(at.via)
      const keys = this.adj.get(at.token)
      if (!keys) continue
      for (const key of keys) {
        const pool = this.pools.get(key)!
        const to = other(pool, at.token)
        if (to === null || done.has(to)) continue
        const held = reserveOf(pool, at.token)!
        const far = reserveOf(pool, to)!
        if (held <= 0n || far <= 0n) continue
        const value = (held * at.rate.num) / at.rate.den
        if (value < floor || value <= 0n) continue
        const width = value < at.width ? value : at.width
        if (width <= (best.get(to) ?? -1n)) continue
        best.set(to, width)
        heap.push({
          token: to,
          width,
          rate: normalize({ num: held * at.rate.num, den: far * at.rate.den }),
          via: key,
        })
      }
    }

    for (const [key, pool] of this.pools) {
      const r0 = rates.get(lc(pool.token0))
      const r1 = rates.get(lc(pool.token1))
      if (!r0 || !r1 || pool.reserve0 <= 0n || pool.reserve1 <= 0n) continue
      const v0 = (pool.reserve0 * r0.num) / r0.den
      const v1 = (pool.reserve1 * r1.num) / r1.den
      const d = v0 < v1 ? v0 : v1
      if (d <= 0n || d < floor) continue
      depth.set(key, d)
      const t0 = lc(pool.token0)
      const t1 = lc(pool.token1)
      let r = d
      for (const t of [t0, t1]) {
        const w = best.get(t)!
        if (w < r) r = w
      }
      rank.set(key, r)
      seq.set(key, Math.max(order.get(t0)!, order.get(t1)!))
    }
    this.cache = { version: this.version, rates, depth, rank, seq, tree }
    return this.cache
  }

  /** True when this pool clears the depth filter now. */
  qualified(pair: Address): boolean {
    return this.qualify().depth.has(lc(pair))
  }

  /** How deep a held pool is, in native wei, or zero when it does not qualify. */
  depthNative(pair: Address): bigint {
    return this.qualify().depth.get(lc(pair)) ?? 0n
  }

  /** How many held pools qualify. */
  get qualifiedCount(): number {
    return this.qualify().depth.size
  }

  /**
   * What `amountIn` of `tokenIn` fetches in `tokenOut`, over at most `maxHops` swaps, through
   * qualified pools only.
   *
   * Every venue is searched on its own, and the best single-venue path wins. The search is
   * bounded: at each token it expands only the `topK` pools holding the most of the token it
   * sells. That compares amounts of one token, so it needs no prices, and it caps the work at
   * `topK ** maxHops` paths per venue, 64 at the defaults, whatever the graph's size.
   *
   * Null means this graph cannot price it. That is never the claim "no route exists". The graph
   * holds what discovery listed and the filter passed, so a caller must fall back, not conclude.
   */
  quote(tokenIn: Address, tokenOut: Address, amountIn: bigint): GraphQuote | null {
    const from = lc(tokenIn)
    const to = lc(tokenOut)
    if (from === to || amountIn <= 0n) return null
    const { depth } = this.qualify()
    let best: GraphQuote | null = null
    for (const venue of this.venues()) {
      const found = this.searchVenue(depth, venue, from, to, amountIn)
      if (found && (best === null || found.out > best.out)) best = found
    }
    return best
  }

  /**
   * What `amount` of `token` is worth in the native token, as a real sized sale along a real
   * path. So it already carries the slippage of selling that amount. Null when no qualified
   * path reaches the native token inside `maxHops`.
   */
  valueInNative(token: Address, amount: bigint): bigint | null {
    const native = this.options.native
    if (!native) return null
    if (lc(token) === lc(native)) return amount
    return this.quote(token, native, amount)?.out ?? null
  }

  /** The venue labels present in the graph, in first-seen order. */
  venues(): string[] {
    const seen: string[] = []
    for (const p of this.pools.values()) if (!seen.includes(p.venue)) seen.push(p.venue)
    return seen
  }

  // ── Persistence ─────────────────────────────────────────────────────────────

  /**
   * The graph as one line of JSON, with each pool as a row rather than an object.
   *
   * Rows, because the field names would be most of the file, and the parse time on one core
   * grows with the bytes.
   */
  serialize(chainId: number): string {
    const rows = [...this.pools.values()].map((p) => [
      lc(p.address),
      lc(p.token0),
      lc(p.token1),
      p.reserve0.toString(),
      p.reserve1.toString(),
      p.venue,
      p.feeNum.toString(),
      p.feeDen.toString(),
      p.blockNumber.toString(),
    ])
    return JSON.stringify({
      v: 2,
      chainId,
      head: this.highest.toString(),
      syncedTo: this.covered.toString(),
      pools: rows,
    })
  }

  /**
   * Load a serialized graph, and never throw, whatever the file holds.
   *
   * A process can be killed mid-write, and the next start has nothing else to begin from. So a
   * truncated file, a file from the other chain, a row with a missing field or a reserve that is
   * not a number all end in a working graph. A bad row is dropped and the rest load. A bad file
   * gives an empty graph. Both are a cold start, which the caller already handles.
   *
   * `chainId` is checked because a cache from the other chain is not corrupt, it is wrong. Every
   * address in it would quote against pools that do not exist here.
   *
   * The fee comes from the file, and the caller must hold it to the venue: see `graphsync.ts`,
   * which drops a cached pool whose venue or fee the registry no longer agrees with.
   */
  static parse(text: string, chainId: number, options: PoolGraphInit): PoolGraph {
    const graph = new PoolGraph(options)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return graph
    }
    if (!parsed || typeof parsed !== 'object') return graph
    const file = parsed as {
      v?: unknown
      chainId?: unknown
      head?: unknown
      syncedTo?: unknown
      pools?: unknown
    }
    if (file.v !== 2 || file.chainId !== chainId || !Array.isArray(file.pools)) return graph

    for (const row of file.pools) {
      if (!Array.isArray(row) || row.length !== 9) continue
      const [address, token0, token1, r0, r1, venue, feeNum, feeDen, block] = row as unknown[]
      if (typeof address !== 'string' || typeof token0 !== 'string' || typeof token1 !== 'string') {
        continue
      }
      if (!ADDRESS.test(address) || !ADDRESS.test(token0) || !ADDRESS.test(token1)) continue
      if (token0 === token1 || typeof venue !== 'string') continue
      if ([r0, r1, feeNum, feeDen, block].some((f) => typeof f !== 'string' || !/^\d+$/.test(f))) {
        continue
      }
      const pool: Pool = {
        address: address as Address,
        token0: token0 as Address,
        token1: token1 as Address,
        reserve0: BigInt(r0 as string),
        reserve1: BigInt(r1 as string),
        venue,
        feeNum: BigInt(feeNum as string),
        feeDen: BigInt(feeDen as string),
        blockNumber: BigInt(block as string),
      }
      // A zero denominator divides by zero in the curve, and a fee above one is not a fee. The
      // chain gives neither, so the row is damaged.
      if (pool.feeDen === 0n || pool.feeNum > pool.feeDen) continue
      graph.add(pool)
    }
    const block = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : 0n)
    graph.advance(block(file.head))
    // A coverage mark past the newest pool is impossible, so the file is not trusted for it.
    const covered = block(file.syncedTo)
    graph.covered = covered <= graph.highest ? covered : 0n
    return graph
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private drop(key: string, pool: Pool): void {
    this.unlink(key, pool)
    this.pools.delete(key)
    this.version++
  }

  private link(token: string, pair: string): void {
    const at = this.adj.get(token)
    if (at) at.add(pair)
    else this.adj.set(token, new Set([pair]))
  }

  private unlink(pair: string, pool: Pool): void {
    for (const token of [lc(pool.token0), lc(pool.token1)]) {
      const at = this.adj.get(token)
      if (!at) continue
      at.delete(pair)
      // Drop the empty set. A token index that only grows is the same leak as the pool map.
      if (at.size === 0) this.adj.delete(token)
    }
  }

  /**
   * The pools a search expands from `token` at one venue: the `topK` qualified pools holding the
   * most of it, plus every qualified pool that reaches `target` in one step.
   *
   * The second set is small (one pool per venue per pair) and it matters. Without it, a token
   * with many deep pools could rank its only pool to the target out of the top K, and the search
   * would miss a one-hop answer that `quoteAll` finds.
   */
  private neighbours(depth: Map<string, bigint>, venue: string, token: string, target: string): Pool[] {
    const keys = this.adj.get(token)
    if (!keys) return []
    const out: { pool: Pool; held: bigint }[] = []
    const direct: Pool[] = []
    for (const key of keys) {
      if (!depth.has(key)) continue
      const pool = this.pools.get(key)!
      if (pool.venue !== venue) continue
      const held = reserveOf(pool, token)
      if (held === null || held <= 0n) continue
      if (other(pool, token) === target) direct.push(pool)
      else out.push({ pool, held })
    }
    // Every candidate holds the same token, so this compares like with like.
    out.sort((a, b) => (a.held < b.held ? 1 : a.held > b.held ? -1 : 0))
    return [...direct, ...out.slice(0, this.options.topK).map((e) => e.pool)]
  }

  private searchVenue(
    depth: Map<string, bigint>,
    venue: string,
    from: string,
    to: string,
    amountIn: bigint,
  ): GraphQuote | null {
    let best: GraphQuote | null = null
    const path: string[] = [from]
    const used: Pool[] = []
    const visited = new Set<string>([from])

    const step = (token: string, amount: bigint) => {
      if (used.length >= this.options.maxHops) return
      for (const pool of this.neighbours(depth, venue, token, to)) {
        const next = other(pool, token)
        if (next === null || visited.has(next)) continue
        const out = poolAmountOut(pool, token as Address, amount)
        if (out === null || out <= 0n) continue
        path.push(next)
        used.push(pool)
        if (next === to) {
          if (best === null || out > best.out) {
            let syncedAt = used[0].blockNumber
            for (const p of used) if (p.blockNumber < syncedAt) syncedAt = p.blockNumber
            best = { out, path: path.map((t) => t as Address), pools: [...used], venue, syncedAt }
          }
        } else {
          visited.add(next)
          step(next, out)
          visited.delete(next)
        }
        path.pop()
        used.pop()
      }
    }

    step(from, amountIn)
    return best
  }
}

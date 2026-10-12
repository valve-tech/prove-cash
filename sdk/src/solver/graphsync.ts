import { parseAbi, parseAbiItem, type Address, type Chain, type HttpTransport, type PublicClient } from 'viem'
import {
  presetTokens,
  venueSubgraph,
  xykVenues,
  type ChainId,
  type VenueSubgraph,
  type XykVenue,
} from '../config.js'
import { batchRead, type Call, type CallResult } from '../multicall.js'
import type { PoolGraph, PoolGraphInit, PruneResult } from './graph.js'
import type { Pool } from './price.js'
import { discoverVenue, type DiscoveredPair, type DiscoveryOptions, type VenueDiscovery } from './subgraph.js'

/**
 * How the pool graph fills and stays true: the subgraph says which pairs exist, and the chain
 * says everything else.
 *
 *   1. **Discovery**, in the background. `subgraph.ts` asks each venue's subgraph for its deep
 *      pairs and the pairs of the tokens the executor needs. A pass never waits on it.
 *   2. **The first read.** Each new pair is read from the chain in one batched call:
 *      `token0`, `token1`, `factory` and `getReserves`. A pair whose chain answers disagree with
 *      the subgraph, or that another factory made, is dropped.
 *   3. **Freshness.** Every tick reads the `Sync` logs since the last one and applies them. A
 *      `Sync` carries both reserves, so a held pool never needs a second read while the poll has
 *      no gap. After a gap too long to read as logs, every held reserve is read again.
 *
 * **What the subgraph can and cannot do here.** It can add a candidate pair. It can never set a
 * reserve, never qualify a pool (`graph.ts` does that on chain reserves), and never block a
 * pass. When it is down, stale or erroring, the keeper keeps what it holds and the executor
 * keeps `quoteAll`.
 *
 * **Pacing.** The valve gateway limits each method per second, per account. viem's `multicall`
 * splits a large batch into chunks and sends every chunk at once, and on 2026-09-18 that lost
 * most of a 9,144-call batch to refusals. So every read here is one chunk, and the chunks go one
 * at a time. See `readPairs` for the sizes and the measured refusal count.
 */

/** `Sync(uint112 reserve0, uint112 reserve1)`: both reserves, on every change of a pair. */
export const SYNC_EVENT = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)')

const PAIR_READ_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
])

/**
 * The depth a pool needs, per chain, in WPLS wei. See `PoolGraph.qualify` for the rule.
 *
 * - **369: 10,000,000 WPLS**, about $115 at the 2026-09-23 price of $1.155e-5. A pool that
 *   shallow moves 1% on a $1.15 trade, and the median intent on the board is $0.60. Below it a
 *   pool is dust or bait, and the executor gains nothing by routing through it.
 * - **943: 1,000 WPLS.** Testnet WPLS is free, and the pools are small: WPLS/tUSDC, the only
 *   WPLS leg tWBTC and tWETH can reach, holds 2,777 WPLS. A floor above that would filter out
 *   the exact route this graph exists for.
 */
export const DEPTH_FLOOR: Record<ChainId, bigint> = {
  369: 10_000_000n * 10n ** 18n,
  943: 1_000n * 10n ** 18n,
}

/** A graph's options for one chain: its WPLS, its registry tokens as hubs, and its floor. */
export function graphOptionsFor(chainId: ChainId, overrides: Partial<PoolGraphInit> = {}): PoolGraphInit {
  const tokens = presetTokens(chainId)
  return {
    native: tokens.find((t) => t.symbol === 'WPLS')?.address ?? null,
    hubs: tokens.map((t) => t.address),
    depthFloor: DEPTH_FLOOR[chainId],
    ...overrides,
  }
}

/** Where the keeper reads, and how hard. */
export type KeeperOptions = {
  chainId: ChainId
  client: PublicClient<HttpTransport, Chain>
  graph: PoolGraph
  /** The venues to discover. Defaults to the registry's; pass the confirmed ones when known. */
  venues?: readonly XykVenue[]
  /** Which subgraph indexes a venue. Defaults to `venueSubgraph` in the registry. */
  subgraphFor?: (venue: XykVenue) => VenueSubgraph | null
  /** Passed to `discoverVenue`, minus `head` and `tokens`, which the keeper supplies. */
  discovery?: Omit<DiscoveryOptions, 'head' | 'tokens'>
  /** Blocks between two discoveries. 300 by default, about 50 minutes. */
  rediscoverBlocks?: number
  /** Blocks to wait after a failed discovery before the next try. 30 by default. */
  retryBlocks?: number
  /**
   * The longest gap the keeper reads as `Sync` logs. Longer, and it reads every held reserve
   * again instead. 1,000 by default. On 369 a 500-block range held 8,629 logs and answered in
   * 975 ms, so 1,000 blocks is two requests; a full re-read of 4,000 pools is twenty.
   */
  maxCatchupBlocks?: number
  /** Blocks per `eth_getLogs`. 500 by default. */
  logChunk?: number
  /** New pairs per read. Four calls each; see `readPairs`. 50 by default. */
  pairsPerRead?: number
  /** Held pairs per reserve re-read. One call each. 200 by default. */
  reservesPerRead?: number
  /**
   * The most first-read requests one `refresh` makes. 20 by default: about 1,000 new pairs and
   * about six seconds. A cold start on 369 lists more than that, and the rest are read on the
   * next ticks, so no single pass waits long.
   */
  maxReadsPerRefresh?: number
}

/** What one refresh did, in the units that decide whether the pacing is right. */
export type RefreshReport = {
  head: bigint
  /** `Sync` logs applied to held pools, of those read. */
  logs: number
  logRequests: number
  /** `eth_getLogs` ranges refused twice. The poll stops at the first, so coverage has no gap. */
  logRefused: number
  /** `eth_call` requests for first reads and re-reads. */
  reads: number
  /** Calls inside those reads that came back unreadable (a refused chunk, a timeout). */
  unreadable: number
  /** Pools added from a first read. */
  added: number
  /** Listed pairs the chain contradicted: another factory, other tokens, or a revert. */
  rejected: number
  /** Pools read again because the `Sync` gap was too long. */
  reread: number
  /** New pairs still waiting for a first read. */
  queued: number
  /** Per venue: what the discovery that landed this refresh said, if one landed. */
  discovery: VenueDiscovery[]
  /** True when a discovery started in the background this refresh. */
  discovering: boolean
  pruned: PruneResult
  ms: number
}

const lc = (a: string) => a.toLowerCase()
const ZERO = 0n

/**
 * Keeps one pool graph true against the chain, and fed from the subgraphs.
 *
 * One instance per bot. `refresh` is the only method a pass calls, and it never throws for a
 * subgraph failure. It throws only when the chain itself cannot be read, which the pass already
 * treats as a failed pass.
 */
export class GraphKeeper {
  readonly graph: PoolGraph
  private readonly opts: KeeperOptions
  /** The last successful listing, per venue label. A failed discovery keeps the old one. */
  private readonly listed = new Map<string, Set<string>>()
  /** Listed pairs not yet read, best rank first. Bounded by `maxPools` twice. */
  private queue: DiscoveredPair[] = []
  /** Pairs the chain contradicted, and the block it said so. Not re-read until rediscovered. */
  private readonly rejected = new Map<string, bigint>()
  private inFlight: Promise<VenueDiscovery[]> | null = null
  private landed: VenueDiscovery[] | null = null
  private lastDiscovery: bigint | null = null
  private lastFailed = false
  /** The tokens the last discovery asked about. A new one earns an early discovery. */
  private asked = new Set<string>()

  constructor(opts: KeeperOptions) {
    this.opts = opts
    this.graph = opts.graph
    // A cached pool is as listed as it was when it was written. Discovery replaces this.
    for (const p of this.graph.all()) this.listedFor(p.venue).add(lc(p.address))
  }

  /** True while a discovery runs in the background. */
  get discovering(): boolean {
    return this.inFlight !== null
  }

  /** New pairs waiting for their first chain read. */
  get queued(): number {
    return this.queue.length
  }

  /**
   * True when the graph's reserves are known exact at `head`, less `slack` blocks. A caller
   * should not route through a graph that has fallen behind: its reserves are not the chain's.
   */
  usable(head: bigint, slack = 20n): boolean {
    return this.graph.size > 0 && this.graph.syncedTo + slack >= head
  }

  /**
   * Discover, and wait for it. For a cold start, where the graph has nothing to offer a pass
   * yet. `budgetMs` bounds the wait; a discovery still running then carries on in the background.
   * 90 s by default, because a cold discovery on testnet measured 51 s.
   */
  async warmUp(head: bigint, tokens: readonly Address[], budgetMs = 90_000): Promise<RefreshReport> {
    this.startDiscovery(head, tokens)
    const flight = this.inFlight
    if (flight) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([
        flight,
        new Promise((r) => {
          timer = setTimeout(r, budgetMs)
        }),
      ])
      clearTimeout(timer)
    }
    // No read cap on the first refresh: a bot that has waited for discovery wants the result.
    return this.refresh(head, tokens, { maxReads: Infinity })
  }

  /** Catch up, take in any landed discovery, read new pairs, prune, and maybe start discovery. */
  async refresh(
    head: bigint,
    tokens: readonly Address[],
    limits: { maxReads?: number } = {},
  ): Promise<RefreshReport> {
    const started = Date.now()
    const report: RefreshReport = {
      head,
      logs: 0,
      logRequests: 0,
      logRefused: 0,
      reads: 0,
      unreadable: 0,
      added: 0,
      rejected: 0,
      reread: 0,
      queued: 0,
      discovery: [],
      discovering: false,
      pruned: { stale: 0, unqualified: 0, crowded: 0, capped: 0 },
      ms: 0,
    }

    await this.catchUp(head, report)

    if (this.landed) {
      report.discovery = this.landed
      this.take(this.landed)
      this.landed = null
    }

    await this.readQueue(head, report, limits.maxReads ?? this.opts.maxReadsPerRefresh ?? 20)

    // A listed pool with no `Sync` has not changed, while the poll has no gap. `touch` clamps to
    // `syncedTo`, so this is a no-op until the poll has caught up.
    for (const set of this.listed.values()) this.graph.touch(set, head)
    // Staleness runs on the observed clock. See `PoolGraph.prune`.
    report.pruned = this.graph.prune(this.graph.syncedTo)

    report.discovering = this.maybeDiscover(head, tokens)
    report.queued = this.queue.length
    report.ms = Date.now() - started
    return report
  }

  // ── Freshness ───────────────────────────────────────────────────────────────

  /**
   * Bring every held reserve to `head`: `Sync` logs for a short gap, a full re-read for a long
   * one. Coverage only moves over ranges that were read, so a refused range is read again next
   * tick rather than skipped.
   */
  private async catchUp(head: bigint, report: RefreshReport): Promise<void> {
    const graph = this.graph
    if (graph.size === 0) {
      // Nothing to keep fresh. Coverage starts here, so the first pools read have no gap.
      graph.coverTo(head)
      return
    }
    const from = graph.syncedTo + 1n
    if (from > head) return
    const maxGap = BigInt(this.opts.maxCatchupBlocks ?? 1_000)
    if (graph.syncedTo === ZERO || head - graph.syncedTo > maxGap) {
      await this.rereadAll(head, report)
      return
    }
    const span = BigInt(Math.max(1, this.opts.logChunk ?? 500))
    // Oldest first, so coverage can only grow without a hole.
    for (let lo = from; lo <= head; ) {
      const hi = lo + span - 1n < head ? lo + span - 1n : head
      const logs = await this.readRange(lo, hi, report)
      if (logs === null) {
        report.logRefused++
        return
      }
      for (const log of logs) {
        const args = log.args as { reserve0?: bigint; reserve1?: bigint }
        if (args.reserve0 === undefined || args.reserve1 === undefined || log.blockNumber === null) {
          continue
        }
        if (graph.observe(log.address, args.reserve0, args.reserve1, log.blockNumber)) report.logs++
      }
      graph.coverTo(hi)
      lo = hi + 1n
    }
  }

  /** One range, with a single retry split in two. Null when either half is refused. */
  private async readRange(
    lo: bigint,
    hi: bigint,
    report: RefreshReport,
  ): Promise<{ address: Address; blockNumber: bigint | null; args: unknown }[] | null> {
    const get = async (a: bigint, b: bigint) => {
      report.logRequests++
      return (await this.opts.client.getLogs({ event: SYNC_EVENT, fromBlock: a, toBlock: b })) as {
        address: Address
        blockNumber: bigint | null
        args: unknown
      }[]
    }
    try {
      return await get(lo, hi)
    } catch {
      if (hi === lo) return null
      // A refusal is as often the body size as the rate. The same range in two halves answers both.
      const mid = lo + (hi - lo) / 2n
      try {
        return [...(await get(lo, mid)), ...(await get(mid + 1n, hi))]
      } catch {
        return null
      }
    }
  }

  /**
   * Read every held reserve again, after a gap too long for logs.
   *
   * A pool whose read failed is removed rather than kept at reserves nobody can vouch for. If
   * every read failed, the endpoint is down: nothing is removed, coverage does not move, and
   * the next tick tries again. The executor stops routing through the graph meanwhile, because
   * `usable` says no.
   */
  private async rereadAll(head: bigint, report: RefreshReport): Promise<void> {
    const graph = this.graph
    const held = graph.all()
    const per = Math.max(1, this.opts.reservesPerRead ?? 200)
    const failed: Pool[] = []
    let answered = 0
    for (let i = 0; i < held.length; i += per) {
      const slice = held.slice(i, i + per)
      // The block before the read is a lower bound on the block it ran at. A `Sync` between the
      // two is applied again by the next poll, in order, so the lower bound is the safe one.
      const block = await this.opts.client.getBlockNumber()
      report.reads++
      const res = await batchRead(
        slice.map((p): Call => ({ address: p.address, abi: PAIR_READ_ABI, functionName: 'getReserves' })),
        this.opts.client,
      )
      slice.forEach((p, k) => {
        const r = res[k]
        if (!r.ok) {
          if (r.reason === 'unreadable') report.unreadable++
          failed.push(p)
          return
        }
        answered++
        const [reserve0, reserve1] = r.value as readonly [bigint, bigint, number]
        graph.add({ ...p, reserve0, reserve1, blockNumber: block })
        report.reread++
      })
    }
    if (answered === 0 && held.length > 0) return
    for (const p of failed) graph.remove(p.address)
    graph.coverTo(head)
  }

  // ── Discovery ───────────────────────────────────────────────────────────────

  private listedFor(venue: string): Set<string> {
    let set = this.listed.get(venue)
    if (!set) {
      set = new Set()
      this.listed.set(venue, set)
    }
    return set
  }

  private venues(): readonly XykVenue[] {
    return this.opts.venues ?? xykVenues(this.opts.chainId)
  }

  /** Start a background discovery when one is due. Never awaits it. True when one started. */
  private maybeDiscover(head: bigint, tokens: readonly Address[]): boolean {
    if (this.inFlight) return false
    const wanted = new Set(tokens.map(lc))
    const fresh = [...wanted].some((t) => !this.asked.has(t))
    const every = BigInt(this.opts.rediscoverBlocks ?? 300)
    const retry = BigInt(this.opts.retryBlocks ?? 30)
    const since = this.lastDiscovery === null ? null : head - this.lastDiscovery
    const due =
      since === null ||
      since >= every ||
      (this.lastFailed && since >= retry) ||
      // A token the board just showed. Not more often than the retry wait, so a board full of
      // new tokens cannot turn this into a request per tick.
      (fresh && since >= retry)
    if (!due) return false
    this.startDiscovery(head, tokens)
    return true
  }

  private startDiscovery(head: bigint, tokens: readonly Address[]): void {
    if (this.inFlight) return
    const all = [...new Set([...presetTokens(this.opts.chainId).map((t) => t.address), ...tokens].map(lc))]
    this.asked = new Set(all)
    this.lastDiscovery = head
    const subgraphFor = this.opts.subgraphFor ?? ((v: XykVenue) => venueSubgraph(v, this.opts.chainId))
    const run = async (): Promise<VenueDiscovery[]> => {
      const out: VenueDiscovery[] = []
      // One venue at a time. The subgraph host is shared, and the answers are not urgent.
      for (const venue of this.venues()) {
        const source = subgraphFor(venue)
        if (!source) continue
        out.push(
          await discoverVenue(venue, source, {
            ...this.opts.discovery,
            head,
            tokens: all as Address[],
          }),
        )
      }
      return out
    }
    this.inFlight = run()
      .catch((): VenueDiscovery[] => [])
      .then((result) => {
        this.landed = result
        this.lastFailed = result.length === 0 || result.some((r) => !r.ok)
        this.inFlight = null
        return result
      })
  }

  /** Take a landed discovery: replace each good venue's listing, and queue its new pairs. */
  private take(result: VenueDiscovery[]): void {
    const cap = this.graph.options.maxPools * 2
    const queued = new Map(this.queue.map((p) => [p.address, p]))
    for (const r of result) {
      // A failed venue keeps its old listing. That is "fall back to what it already holds".
      if (!r.ok) continue
      const set = new Set<string>()
      for (const p of r.pairs) {
        set.add(p.address)
        if (!this.graph.has(p.address) && !this.rejected.has(p.address)) queued.set(p.address, p)
      }
      this.listed.set(r.venue, set)
    }
    // A pair the chain contradicted gets one more chance per rediscovery, not per tick.
    this.rejected.clear()
    this.queue = [...queued.values()].sort((a, b) => b.rank - a.rank).slice(0, cap)
  }

  // ── First reads ─────────────────────────────────────────────────────────────

  private async readQueue(head: bigint, report: RefreshReport, maxReads: number): Promise<void> {
    const per = Math.max(1, this.opts.pairsPerRead ?? 50)
    const byLabel = new Map(this.venues().map((v) => [v.label, v]))
    let reads = 0
    while (this.queue.length > 0 && reads < maxReads) {
      const slice = this.queue.slice(0, per)
      const block = await this.opts.client.getBlockNumber()
      reads++
      report.reads++
      const res = await readPairs(slice, this.opts.client)
      const retry: DiscoveredPair[] = []
      slice.forEach((pair, k) => {
        const outcome = checkPair(pair, res.slice(k * 4, k * 4 + 4), byLabel.get(pair.venue))
        if (outcome === 'unreadable') {
          report.unreadable++
          retry.push(pair)
        } else if (outcome === 'rejected') {
          report.rejected++
          this.rejected.set(pair.address, head)
        } else {
          this.graph.add({ ...outcome, blockNumber: block })
          report.added++
        }
      })
      // An unreadable pair goes to the back, so one bad pair cannot hold up the queue.
      this.queue = [...this.queue.slice(per), ...retry]
      // A whole batch unreadable is the endpoint refusing. Stop and let the next tick continue.
      if (retry.length === slice.length) break
    }
  }
}

/**
 * The four calls that make a listed pair a pool, in one batched read.
 *
 * Four calls of four bytes each. `batchRead` sizes chunks on the wrapped calldata, which is 192
 * bytes per call here, so 50 pairs (200 calls, 38 KB) is one chunk under its 40,000-byte budget.
 * One chunk per request, one request at a time: that is the pacing the gateway accepts.
 *
 * Measured on 2026-09-23 through the public key: a cold start on 369 made 18 such reads for 876
 * listed pairs, and 943 made 8 for 374. Not one call came back unreadable on either chain.
 */
export function readPairs(
  pairs: readonly DiscoveredPair[],
  client: PublicClient<HttpTransport, Chain>,
): Promise<CallResult[]> {
  return batchRead(
    pairs.flatMap((p): Call[] => [
      { address: p.address, abi: PAIR_READ_ABI, functionName: 'token0' },
      { address: p.address, abi: PAIR_READ_ABI, functionName: 'token1' },
      { address: p.address, abi: PAIR_READ_ABI, functionName: 'factory' },
      { address: p.address, abi: PAIR_READ_ABI, functionName: 'getReserves' },
    ]),
    client,
  )
}

/**
 * Hold one listed pair to the chain's answers. The subgraph's claims survive only where the
 * chain repeats them.
 *
 * - A revert on any call: the address is not a pair. Rejected.
 * - An unreadable call: the chain said nothing. Kept for a retry.
 * - `factory()` not the venue's factory: another factory's pair, or an impostor. Rejected.
 * - `token0`/`token1` not the subgraph's: the listing is wrong about this pair. Rejected.
 *
 * Otherwise a pool, with the chain's tokens, the chain's reserves and the registry's fee.
 */
export function checkPair(
  pair: DiscoveredPair,
  res: readonly CallResult[],
  venue: XykVenue | undefined,
): Omit<Pool, 'blockNumber'> | 'rejected' | 'unreadable' {
  if (!venue || res.length !== 4) return 'rejected'
  if (res.some((r) => !r.ok && r.reason === 'unreadable')) return 'unreadable'
  const [t0, t1, f, reserves] = res
  if (!t0.ok || !t1.ok || !f.ok || !reserves.ok) return 'rejected'
  if (lc(f.value as string) !== lc(venue.factory)) return 'rejected'
  if (lc(t0.value as string) !== pair.token0.address || lc(t1.value as string) !== pair.token1.address) {
    return 'rejected'
  }
  const [reserve0, reserve1] = reserves.value as readonly [bigint, bigint, number]
  return {
    address: pair.address,
    token0: pair.token0.address,
    token1: pair.token1.address,
    reserve0,
    reserve1,
    feeNum: venue.feeNum,
    feeDen: venue.feeDen,
    venue: venue.label,
  }
}

/**
 * Drop cached pools the registry no longer agrees with: a venue that is gone, or a fee that
 * moved. A cache file is written by an older build, and the fee it carries is the fee that build
 * had. The registry is the authority on the fee, so a mismatch removes the pool rather than
 * pricing it at an old number.
 */
export function reconcileWithVenues(graph: PoolGraph, venues: readonly XykVenue[]): number {
  const byLabel = new Map(venues.map((v) => [v.label, v]))
  let dropped = 0
  for (const p of graph.all()) {
    const v = byLabel.get(p.venue)
    if (!v || v.feeNum !== p.feeNum || v.feeDen !== p.feeDen) {
      graph.remove(p.address)
      dropped++
    }
  }
  return dropped
}

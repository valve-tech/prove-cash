import type { Address, Chain, HttpTransport, PublicClient } from 'viem'
import { rpcClient } from '../client.js'
import {
  PULSEX_FEE_DEN,
  PULSEX_FEE_NUM,
  getChainId,
  presetTokens,
  xykVenues,
  type ChainId,
  type XykVenue,
} from '../config.js'
import { confirmVenues } from '../market.js'
import { batchRead, type Call } from '../multicall.js'
import { FACTORY_ABI, PAIR_ABI, ROUTER_ABI } from './abi.js'

/**
 * Pool prices, and the one conversion that decides whether a ring is worth sending: what its
 * surplus is worth against the gas it burns.
 *
 * A ring can close through PulseX as well as through intents, so the pool has to be priced on
 * the same curve the router walks — `getAmountsOut`, not a spot ratio. Rather than ask the
 * router once per candidate, the solver takes a reserve snapshot and reproduces the curve
 * locally with exact integers. That keeps the engine a pure function of its inputs, and the
 * snapshot is what a router quote is anyway: a bound that can move before inclusion.
 */

/**
 * PulseX keeps 29 basis points of every swap, on every venue measured so far.
 *
 * Not the authority — `XykVenue.feeNum` in the registry is, and a loaded pool carries the numbers
 * of the venue it came from. These two are the measured value, kept for tests and for callers
 * building a pool by hand. Re-exported rather than written again: `config.ts` builds every
 * registry entry's fee from the same pair, and the day a remeasurement moves the number, two
 * copies would move one at a time and every quote in between would be wrong by 29 basis points
 * with nothing failing.
 */
export { PULSEX_FEE_DEN, PULSEX_FEE_NUM } from '../config.js'

/** A constant-product pair, as the solver holds it. Token order is the pair's own. */
export type Pool = {
  address: Address
  token0: Address
  token1: Address
  reserve0: bigint
  reserve1: bigint
  /** Of every `feeDen` units sent in, the curve credits `feeNum`. Taken from the venue. */
  feeNum: bigint
  feeDen: bigint
  /** Which venue lists this pair. The same pair exists on several, with unrelated reserves. */
  venue: string
  /** The block the reserves were read at. A snapshot older than the head is a stale bound. */
  blockNumber: bigint
}

/** `${tokenA}|${tokenB}` with the two addresses lowercased and sorted. One key per pool. */
export function poolKey(a: Address, b: Address): string {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()].sort()
  return `${x}|${y}`
}

/** The reserves of `pool`, oriented so `in` is the token being sold into it. */
function oriented(pool: Pool, tokenIn: Address): { reserveIn: bigint; reserveOut: bigint } | null {
  const t = tokenIn.toLowerCase()
  if (t === pool.token0.toLowerCase()) return { reserveIn: pool.reserve0, reserveOut: pool.reserve1 }
  if (t === pool.token1.toLowerCase()) return { reserveIn: pool.reserve1, reserveOut: pool.reserve0 }
  return null
}

/**
 * What the pool pays for `amountIn` of `tokenIn` — UniswapV2's `getAmountOut`, integer for
 * integer. Null when the token is not in this pool or the pool is empty.
 */
export function poolAmountOut(pool: Pool, tokenIn: Address, amountIn: bigint): bigint | null {
  const r = oriented(pool, tokenIn)
  if (!r || amountIn <= 0n || r.reserveIn <= 0n || r.reserveOut <= 0n) return null
  const withFee = amountIn * pool.feeNum
  return (withFee * r.reserveOut) / (r.reserveIn * pool.feeDen + withFee)
}

/**
 * What the pool charges to release `amountOut` of `tokenOut` — UniswapV2's `getAmountIn`,
 * including the `+ 1` the router adds so rounding never favours the trader. Null when the pool
 * cannot cover the amount.
 */
export function poolAmountIn(pool: Pool, tokenOut: Address, amountOut: bigint): bigint | null {
  const t = tokenOut.toLowerCase()
  const isZero = t === pool.token0.toLowerCase()
  const isOne = t === pool.token1.toLowerCase()
  if (!isZero && !isOne) return null
  const reserveOut = isZero ? pool.reserve0 : pool.reserve1
  const reserveIn = isZero ? pool.reserve1 : pool.reserve0
  if (amountOut <= 0n || amountOut >= reserveOut || reserveIn <= 0n) return null
  return (reserveIn * amountOut * pool.feeDen) / ((reserveOut - amountOut) * pool.feeNum) + 1n
}

/**
 * The pool's marginal price as an exact fraction: how much `tokenIn` one unit of `tokenOut`
 * costs, with the swap fee folded in. The ring condition needs a rate, not a size.
 */
export function poolRate(
  pool: Pool,
  tokenIn: Address,
  tokenOut: Address,
): { num: bigint; den: bigint } | null {
  const r = oriented(pool, tokenIn)
  if (!r || r.reserveIn <= 0n || r.reserveOut <= 0n) return null
  if (tokenOut.toLowerCase() === tokenIn.toLowerCase()) return null
  return { num: r.reserveIn * pool.feeDen, den: r.reserveOut * pool.feeNum }
}

// ── Reading pools from the chain ──────────────────────────────────────────────

const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

/**
 * Where a solver read runs, and which chain's deployments it asks.
 *
 * There is no default router any more, and that is deliberate. The old one was mainnet v2's
 * address, which has no code on 943, so every caller that took the default read "no pool" for
 * every pair on testnet and got no error saying why — a default that is silently wrong on one of
 * two supported chains is worse than no default. Resolving from the registry rather than
 * demanding an argument, because the alternative pushes the same three-line lookup into every
 * call site and the app had already written it once.
 */
export type SolverReadOptions = {
  client?: PublicClient<HttpTransport, Chain>
  chainId?: ChainId
  /**
   * The venues to read. Defaults to every venue the registry has for this chain, which is what
   * "the market" means: a pair listed on two venues has two unrelated pools.
   */
  venues?: readonly XykVenue[]
  /**
   * Narrow the read to one router. Only for a caller holding an address the registry has never
   * heard of, such as a fork. A router the registry knows resolves to that venue and keeps its
   * measured fee; anything else is read at the default fee, which may not be its fee.
   */
  router?: Address
  /**
   * Called when a read the pool depends on came back not-ok.
   *
   * Both loops below skip a pool whose factory or reserves call failed, which is right — a pool
   * cannot be priced from a half answer. But skipping is indistinguishable from the pool not
   * existing, and callers were reporting a rate-limited endpoint to the user as "no pool trades
   * this pair". That is a claim about the market made on the strength of a request that never
   * arrived. This hook lets a caller tell the two apart; ignoring it keeps the old behaviour.
   */
  onReadFailure?: () => void
}

/** The venues a read should ask, before the chain has confirmed any of them. */
function candidateVenues(opts: SolverReadOptions): readonly XykVenue[] {
  if (opts.venues) return opts.venues
  const id = opts.chainId ?? getChainId()
  const known = xykVenues(id)
  if (!opts.router) return known
  const match = known.find((v) => v.router.toLowerCase() === opts.router!.toLowerCase())
  return [match ?? { label: 'custom', router: opts.router, factory: ZERO_ADDRESS, feeNum: PULSEX_FEE_NUM, feeDen: PULSEX_FEE_DEN }]
}

/**
 * The venues this read will actually use: the candidates, minus any the chain does not confirm.
 *
 * A venue the registry has never recorded a factory for — a fork passed in as a bare `router` —
 * cannot be confirmed against a recorded address, so its factory is asked of the router instead.
 */
export async function readVenues(opts: SolverReadOptions = {}): Promise<readonly XykVenue[]> {
  const candidates = candidateVenues(opts)
  const known = candidates.filter((v) => v.factory !== ZERO_ADDRESS)
  const unknown = candidates.filter((v) => v.factory === ZERO_ADDRESS)
  const [ok, discovered] = await Promise.all([
    confirmVenues(known, opts),
    Promise.all(unknown.map(discoverVenue(opts))),
  ])
  return [...ok, ...discovered.filter((v): v is XykVenue => v !== null)]
}

const discovered = new Map<string, Promise<XykVenue | null>>()

/**
 * Ask a router which factory it deploys from, once per router per process.
 *
 * Only an answer is remembered. A failed read used to be cached as null, so one dropped request
 * took that venue out of every later read for the life of the process.
 */
const discoverVenue = (opts: SolverReadOptions) => async (venue: XykVenue) => {
  const key = `${opts.chainId ?? getChainId()}:${venue.router.toLowerCase()}`
  let p = discovered.get(key)
  if (!p) {
    p = batchRead(
      [{ address: venue.router, abi: ROUTER_ABI, functionName: 'factory' }],
      opts.client,
    )
      .then(([r]) => (r.ok ? { ...venue, factory: r.value as Address } : null))
      .catch(() => null)
      .then((v) => {
        if (v === null) discovered.delete(key)
        return v
      })
    discovered.set(key, p)
  }
  return p
}

/**
 * The factory behind a router, or the leading venue's factory when no router is named.
 *
 * Kept for callers that want the one address. `readVenues` is the honest answer now: a chain has
 * as many factories as it has venues, and mainnet has two.
 */
export async function routerFactory(opts: SolverReadOptions = {}): Promise<Address | null> {
  const venues = await readVenues(opts)
  return venues[0]?.factory ?? null
}

/**
 * Snapshot every pool behind the given token pairs, on every venue, keyed by `poolKey`. A pair
 * listed on both mainnet venues comes back with both of its pools, in venue order.
 *
 * Still two multicalls whatever the venue count: one `getPair` per pair per venue goes into the
 * first batch, and one `getReserves`/`token0`/`token1` triple per pool found goes into the
 * second. Another venue is more entries in the same two batches, never another round trip.
 * Pairs no venue lists are simply absent.
 */
export async function loadVenuePools(
  pairs: readonly (readonly [Address, Address])[],
  opts: SolverReadOptions = {},
): Promise<Map<string, Pool[]>> {
  const pools = new Map<string, Pool[]>()
  if (pairs.length === 0) return pools
  const venues = await readVenues(opts)
  if (venues.length === 0) return pools

  const client = opts.client ?? rpcClient()
  const unique = new Map<string, readonly [Address, Address]>()
  for (const p of pairs) if (p[0].toLowerCase() !== p[1].toLowerCase()) unique.set(poolKey(p[0], p[1]), p)
  const keys = [...unique.keys()]
  if (keys.length === 0) return pools

  const found = await batchRead(
    venues.flatMap((venue) =>
      keys.map((k): Call => {
        const [a, b] = unique.get(k)!
        return { address: venue.factory, abi: FACTORY_ABI, functionName: 'getPair', args: [a, b] }
      }),
    ),
    client,
  )

  const live: { key: string; venue: XykVenue; address: Address }[] = []
  venues.forEach((venue, v) => {
    keys.forEach((key, k) => {
      const r = found[v * keys.length + k]
      if (!r.ok) {
        opts.onReadFailure?.()
        return
      }
      const address = r.value as Address
      if (address && address !== ZERO_ADDRESS) live.push({ key, venue, address })
    })
  })
  if (live.length === 0) return pools

  // No block, no snapshot. Stamped block zero, a pool read as the oldest there is: the graph
  // never let it replace a held pool, and it looked stale to every freshness check.
  const blockNumber = await client.getBlockNumber().catch(() => null)
  if (blockNumber === null) {
    opts.onReadFailure?.()
    return pools
  }
  const reads = await batchRead(
    live.flatMap((p): Call[] => [
      { address: p.address, abi: PAIR_ABI, functionName: 'getReserves' },
      { address: p.address, abi: PAIR_ABI, functionName: 'token0' },
      { address: p.address, abi: PAIR_ABI, functionName: 'token1' },
    ]),
    client,
  )

  for (let i = 0; i < live.length; i++) {
    const [res, t0, t1] = [reads[i * 3], reads[i * 3 + 1], reads[i * 3 + 2]]
    if (!res.ok || !t0.ok || !t1.ok) {
      opts.onReadFailure?.()
      continue
    }
    const [reserve0, reserve1] = res.value as readonly [bigint, bigint, number]
    const pool: Pool = {
      address: live[i].address,
      token0: t0.value as Address,
      token1: t1.value as Address,
      reserve0,
      reserve1,
      feeNum: live[i].venue.feeNum,
      feeDen: live[i].venue.feeDen,
      venue: live[i].venue.label,
      blockNumber,
    }
    const at = pools.get(live[i].key)
    if (at) at.push(pool)
    else pools.set(live[i].key, [pool])
  }
  return pools
}

/**
 * Of the pools listing a pair, the one that pays most for this exact trade.
 *
 * This is the only selection that is always right, because "the better pool" is a question about
 * a size: a shallow pool with a keener spot price wins a small trade and loses a large one.
 * Callers that know what they are selling should use this over `loadPools`.
 */
export function pickPool(
  pools: readonly Pool[],
  tokenIn: Address,
  amountIn: bigint,
): Pool | null {
  let best: Pool | null = null
  let bestOut: bigint | null = null
  for (const p of pools) {
    const out = poolAmountOut(p, tokenIn, amountIn)
    if (out === null) continue
    if (bestOut === null || out > bestOut) {
      best = p
      bestOut = out
    }
  }
  return best
}

/** The reserve product. Larger `k` is less slippage per unit sold, at the same price. */
const depth = (p: Pool) => p.reserve0 * p.reserve1

/**
 * Snapshot one pool per pair — the deepest one listing it. Pairs with no pool are absent.
 *
 * Collapsing the venues costs something, so it is worth saying what. Two venues quoting the same
 * pair are arbitraged against each other and sit within a few basis points, but they are not
 * identical: on 2026-08-17 mainnet v1 held 3.2x v2's WPLS/PLSX reserves and still quoted a hair
 * *worse* on one WPLS, because at that size the spot price is everything and depth is nothing.
 * Depth is the right default anyway — it wins every trade large enough to matter, and it is the
 * pool that is hardest to push around, which is what `loadPrices` below needs. A caller that
 * knows its size should take `loadVenuePools` and `pickPool` and get the exact answer.
 */
export async function loadPools(
  pairs: readonly (readonly [Address, Address])[],
  opts: SolverReadOptions = {},
): Promise<Map<string, Pool>> {
  const best = new Map<string, Pool>()
  for (const [key, list] of await loadVenuePools(pairs, opts)) {
    let pick = list[0]
    for (const p of list) if (depth(p) > depth(pick)) pick = p
    best.set(key, pick)
  }
  return best
}

// ── Valuing a surplus against gas ─────────────────────────────────────────────

/**
 * Every token the solver can price, in the wrapped native token. The chain pays gas in that
 * same unit, so one number values both a ring's surplus and the transaction that settles it.
 */
export type PriceBook = {
  /** The wrapped native token. Its own rate is always one to one. */
  wpls: Address | null
  /** Lowercase token address → `{ num, den }`: an amount times `num / den` is its native value. */
  rates: ReadonlyMap<string, { num: bigint; den: bigint }>
}

/** A price book that can value nothing. The engine still runs; it just cannot rank by value. */
export const EMPTY_PRICES: PriceBook = { wpls: null, rates: new Map() }

/** What `amount` of `token` is worth in the native token, or null when the book cannot say. */
export function valueInNative(prices: PriceBook, token: Address, amount: bigint): bigint | null {
  const r = prices.rates.get(token.toLowerCase())
  if (!r || r.den === 0n) return null
  return (amount * r.num) / r.den
}

/** What a transaction costs, in the native token. Gas shares that unit, so this is a product. */
export const gasCostNative = (gas: bigint, gasPrice: bigint): bigint => gas * gasPrice

/**
 * Price every token against WPLS from the pool that trades it. The marginal reserve ratio is
 * the right number here: a ring's surplus is small against a pool, and this only has to decide
 * whether it beats the gas.
 */
export async function loadPrices(
  tokens: readonly Address[],
  opts: SolverReadOptions = {},
): Promise<PriceBook> {
  const id = opts.chainId ?? getChainId()
  const wpls = presetTokens(id).find((t) => t.symbol === 'WPLS')?.address ?? null
  if (!wpls) return EMPTY_PRICES

  const rates = new Map<string, { num: bigint; den: bigint }>()
  rates.set(wpls.toLowerCase(), { num: 1n, den: 1n })

  const wanted = tokens.filter((t) => t.toLowerCase() !== wpls.toLowerCase())
  if (wanted.length === 0) return { wpls, rates }

  const pools = await loadPools(
    wanted.map((t) => [t, wpls] as const),
    opts,
  )
  for (const t of wanted) {
    const pool = pools.get(poolKey(t, wpls))
    if (!pool) continue
    const r = oriented(pool, t)
    if (!r || r.reserveIn <= 0n || r.reserveOut <= 0n) continue
    // Marginal, not `getAmountsOut`: the surplus being valued is a rounding error next to the
    // reserves, and a size-dependent quote would make the ranking depend on the ring's size.
    rates.set(t.toLowerCase(), { num: r.reserveOut, den: r.reserveIn })
  }
  return { wpls, rates }
}

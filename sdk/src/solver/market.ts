/**
 * What the engine needs from a market, and nothing about what kind of market it is.
 *
 * A ring leg that is not somebody's intent closes through a market, and until now "a market"
 * meant one thing: a constant-product pair. `PoolLeg` carried a `Pool` of `{token0, token1,
 * reserve0, reserve1}`, `legCap` was half a reserve, `legPay` walked the xyk curve, and discovery
 * was `getPair` on a factory. Venue kind was a property of the type rather than a modifier on the
 * swap, so a second kind could not be a leg at all.
 *
 * **The cost of that was already paid.** `sdk/src/rfq.ts` is a complete second venue — signed
 * exclusive quotes, their own EIP-712 domain, their own settlement path, their own contract — and
 * nothing under `sdk/src/solver/` references it. It could not be a leg, so it became a parallel
 * path outside the engine, and the ring search cannot see an exclusive quote to this day.
 *
 * The settlement never had this problem. `ProveBatchExecutor.Swap` is `{spender, target, data}`
 * and `ProveCallSink` approves then calls, so every approve-and-call venue already settles
 * against the deployed contract. The narrowness was the SDK's alone.
 *
 * **Four questions, none of them about reserves.** A market is bound to one direction when it is
 * built — it knows what it receives and what it pays — so nothing below takes a token.
 *
 *   cap        the most it can hand over
 *   amountIn   what a given take costs
 *   rate       its marginal rate, for the ring condition
 *   swap       the venue call that settles it
 *
 * That last one is `Swap` itself, which is why this fits: the engine hands the executor bytes it
 * never reads, and the executor hands them to a target it never knew.
 *
 * **`amountIn` and `rate` are synchronous, and that is a constraint rather than an oversight.**
 * `largestFeasible` bisects over the entry size, probing a candidate ring many times, so a quote
 * that costs a network round trip would turn each candidate into a burst of them. Constant
 * product is the only shape here that prices from a cheap local read; concentrated liquidity
 * wants tick math or a quoter call, a stableswap wants `get_dy`, an aggregator wants HTTP. Those
 * belong behind a snapshot this interface reads locally — the gas model's own words apply, "a
 * filter, not an estimate" — with exactness coming from the `simulateRing` that already runs
 * before anything is sent.
 *
 * A venue that cannot be priced locally at all can still supply `swap` and refuse the search. It
 * is then usable for a disposal and for a closing leg whose size the intents already fixed, which
 * are the two places the amount is known in advance and no search happens.
 */
import type { Address, Hex } from 'viem'
import { NO_PATCH, routerSwap, type RouteSwap } from './abi.js'
import { poolAmountIn, poolKey, poolRate, type Pool } from './price.js'
import type { MarketLookup } from './rings.js'

/** The venue call that settles one market leg: `ProveBatchExecutor.Swap`, minus the bookkeeping. */
export type MarketCall = {
  /** The address to approve. Usually `target`; some aggregators hold allowances apart. */
  spender: Address
  target: Address
  data: Hex
  /** Tokens the venue pays besides this leg's own two. Unnamed ones strand in the call sink. */
  extra?: readonly Address[]
}

/**
 * One market, in one direction, ready to be a leg.
 *
 * Bound rather than parameterised: a leg already knows what it receives and pays, and a market
 * that took the direction on every call would let a caller ask one question in one direction and
 * the next in the other.
 */
export type Market = {
  /** Which shape of market this is: `xyk`, and one day `v3`, `stable`, `rfq`. Diagnostics only. */
  readonly kind: string
  /**
   * A stable identity for this market, lowercased.
   *
   * Two legs of one ring must not be the same market twice — the second would price against
   * reserves the first already moved. `legId` in `rings.ts` tags a market leg with this id, and
   * `makeRing` rejects a ring whose leg ids repeat.
   */
  readonly id: string
  /** The token the executor receives from this leg. */
  readonly receives: Address
  /** The token the executor pays into it. */
  readonly pays: Address

  /** The most `receives` this market can hand over in one leg. */
  cap(): bigint
  /** What `take` of `receives` costs in `pays`, or null when it cannot carry that much. */
  amountIn(take: bigint): bigint | null
  /**
   * How much `pays` one unit of `receives` costs, as an exact fraction.
   *
   * A fraction and not a number because the ring condition multiplies these together and a
   * rounded rate there prices a viable ring out. Null when the market cannot say.
   */
  rate(): { num: bigint; den: bigint } | null
  /**
   * The call that sells `amountIn` of `pays` for at least `minOut` of `receives`.
   *
   * Null from a market that can settle but cannot be searched — an aggregator whose route comes
   * from its own API, say — until the caller has fetched one. The engine never calls this during
   * a search; only `execute` does, once the size is fixed.
   */
  swap(amountIn: bigint, minOut: bigint, to: Address, deadline: bigint): MarketCall | null
}

/**
 * A constant-product pair, as a market.
 *
 * Everything below already existed and is only being pointed at through the interface:
 * `poolAmountIn` is the curve, half a reserve is the cap that no ring worth sending approaches,
 * `poolRate` is the marginal rate, and `routerSwap` is the router calldata. The xyk shape has not
 * changed; it has stopped being the only shape the engine can hold.
 *
 * @param router where the swap goes. A pair exists on one venue and the same pair on another
 *        walks different reserves, so the router travels with the pool rather than being looked
 *        up when the swap is built — that lookup was `routerFor` in `execute.ts`, and it resolved
 *        against the plan rather than against the leg that priced it.
 */
export function xykMarket(pool: Pool, receives: Address, pays: Address, router: Address): Market {
  const isZero = receives.toLowerCase() === pool.token0.toLowerCase()
  return {
    kind: 'xyk',
    // The pair, plus the direction. One pair is two markets and a ring may hold both: A for B and
    // B for A price against the same reserves, and taking one moves the other.
    id: `xyk:${pool.address.toLowerCase()}:${receives.toLowerCase()}`,
    receives,
    pays,
    // A pool never runs dry, but its curve goes vertical long before it does. Half the reserve is
    // a bound no ring worth sending ever approaches.
    cap: () => (isZero ? pool.reserve0 : pool.reserve1) / 2n,
    amountIn: (take) => poolAmountIn(pool, receives, take),
    rate: () => poolRate(pool, pays, receives),
    swap: (amountIn, minOut, to, deadline) => {
      const s = routerSwap(router, pays, receives, amountIn, minOut, to, deadline)
      return { spender: s.spender, target: s.target, data: s.data, extra: s.extra }
    },
  }
}

/**
 * One market leg as the executor's `Swap`, ready to go in a `Route`.
 *
 * The mapping lives here and not at the two call sites that need it — `routeFor` for a ring and
 * `packBatch` for a tolerant batch — because it is the seam where a market becomes calldata, and
 * a seam written twice is a seam that drifts. Both used to build the router call themselves from
 * a `[tokenIn, tokenOut]` path, which is why both had to know it was a router.
 *
 * Null when the market cannot build its own call yet. A caller that gets null has a market it can
 * price but not route — fetch the route first, or leave the leg out.
 */
export function marketRouteSwap(
  market: Market,
  amountIn: bigint,
  minOut: bigint,
  to: Address,
  deadline: bigint,
  leg: bigint,
): RouteSwap | null {
  const call = market.swap(amountIn, minOut, to, deadline)
  if (!call) return null
  return {
    tokenIn: market.pays,
    amountIn,
    tokenOut: market.receives,
    spender: call.spender,
    target: call.target,
    data: call.data,
    extra: call.extra ?? [],
    leg,
    // Sent as built. A disposal that wants sizing on chain sets these; a buy-side swap may not.
    amountOffset: NO_PATCH,
    minOutOffset: NO_PATCH,
    minOutPerIn: 0n,
  }
}

/**
 * A market lookup over the pool map `loadPools` returns.
 *
 * The one line a caller changes to keep quoting constant-product venues after this. Discovery
 * stays xyk's own business — `getPair` on a factory, reserves off the pair — and only the answer
 * crosses into the engine.
 *
 * @param routerOf which venue's router fills a pool. A pair on one venue walks different reserves
 *        from the same pair on another, so the router has to travel with the pool it priced.
 */
export function xykMarkets(
  pools: ReadonlyMap<string, Pool>,
  routerOf: (pool: Pool) => Address,
): MarketLookup {
  return (receives, pays) => {
    const pool = pools.get(poolKey(receives, pays))
    return pool ? xykMarket(pool, receives, pays, routerOf(pool)) : null
  }
}

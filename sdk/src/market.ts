import { parseAbi, type Address, type Chain, type HttpTransport, type PublicClient } from 'viem'
import { getChainId, presetTokens, xykVenues, type ChainId, type XykVenue } from './config.js'
import { pricedFeeRates } from './fee.js'
import { minOutAt, type Intent } from './intent.js'
import { batchRead, type Call } from './multicall.js'

/**
 * Live market rates from the chain's constant-product venues, so an executor can see the spread
 * between what an intent pays and what the market pays.
 *
 * "xyk" rather than a brand. Any router with the UniswapV2 surface answers `getAmountsOut`, and
 * these chains carry more than one — PulseX v1 and v2 sit behind two different factories on
 * mainnet, so the same pair has two unrelated pools of liquidity. Every venue in the registry is
 * priced and the best answer wins. Pricing only one of them quietly hands a maker the worse of
 * two rates, and reports "no pool" for pairs that only the other venue lists.
 *
 * The addresses live in the registry, never here. One hard-coded mainnet address is what made
 * chain 943 report "no market" for months while its 5,760 pairs traded.
 */

/**
 * @deprecated Read `xykVenues(chainId)` from the registry, or `xykRouter(chainId)` when you must
 * name exactly one. This is mainnet v2's address and has no code on any other chain.
 */
export const PULSEX_V2_ROUTER: Address = '0x165C3410fC91EF562C50559f7d2289fEbed552d9'

const ROUTER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
])

/** Where a market read runs, and which chain's deployments it asks. */
export type VenueProbeOptions = {
  client?: PublicClient<HttpTransport, Chain>
  chainId?: ChainId
  /**
   * Called when a probe could not be read at all, as opposed to answering "not a venue".
   *
   * Without it the caller cannot tell an empty result that means "this chain has no router" from
   * one that means "the endpoint would not answer", and those are very different things to put
   * on a screen.
   */
  onReadFailure?: () => void
}

/**
 * What the chain said about one router.
 *
 * `unknown` is the reason this is not a boolean. A probe that could not be read is not a "no",
 * and it must not be remembered as one — but it also has to reach *every* caller waiting on the
 * same shared promise, not just the one whose batch happened to launch it. A boolean could only
 * be reported through the launching call's own `onReadFailure`, so a second caller arriving a
 * moment later saw an empty venue list with no idea why, and said "this chain has no router".
 */
type Probe = 'yes' | 'no' | 'unknown'

/** One answer per router, for the life of the process — except `unknown`, which is not kept. */
const confirmed = new Map<string, Promise<Probe>>()

const probeKey = (id: ChainId, v: XykVenue) => `${id}:${v.router.toLowerCase()}`

/**
 * Forget every venue probe. A process that moves to a fork mid-run, and the tests.
 */
export function clearVenueProbes() {
  confirmed.clear()
}

/**
 * The venues among `candidates` that the chain itself confirms, in the order given.
 *
 * The registry says where a venue should be and which factory it deploys from; this asks the
 * router. Both halves matter. A registry entry for a chain that never got a deployment would
 * otherwise send every quote to an address with no code, and a router that answers a *different*
 * factory means the recorded factory is stale — pairs read out of it come back as "no pool" for
 * pairs that plainly exist, which is a silent wrong answer rather than an error.
 *
 * One batched read covers every candidate, and the answers are cached per chain and router, so
 * adding a venue to the registry costs entries in a multicall and no extra round trips.
 */
export async function confirmVenues(
  candidates: readonly XykVenue[],
  opts: VenueProbeOptions = {},
): Promise<readonly XykVenue[]> {
  if (candidates.length === 0) return []
  const id = opts.chainId ?? getChainId()
  const pending = candidates.filter((v) => !confirmed.has(probeKey(id, v)))
  if (pending.length > 0) {
    const batch = batchRead(
      pending.map((v): Call => ({ address: v.router, abi: ROUTER_ABI, functionName: 'factory' })),
      opts.client,
    )
    // Register every answer before awaiting any of them, so two callers racing share one batch.
    pending.forEach((v, i) => {
      confirmed.set(
        probeKey(id, v),
        batch
          .then((res): Probe => {
            const r = res[i]
            if (!r) return 'unknown'
            // A revert is the chain answering: no code at the router, so no venue. An unreadable
            // read is not an answer at all.
            if (!r.ok) return r.reason === 'unreadable' ? 'unknown' : 'no'
            return (r.value as Address).toLowerCase() === v.factory.toLowerCase() ? 'yes' : 'no'
          })
          .catch((): Probe => 'unknown'),
      )
    })
  }

  const answers = await Promise.all(candidates.map((v) => confirmed.get(probeKey(id, v))!))

  // Forget every unknown, so the next caller asks again rather than inheriting a verdict that was
  // never reached. A `yes` and a `no` are both stable and both stay.
  candidates.forEach((v, i) => {
    if (answers[i] === 'unknown') confirmed.delete(probeKey(id, v))
  })
  // Reported per caller, off the shared answer, so everyone waiting on one batch hears about it.
  if (answers.some((a) => a === 'unknown')) opts.onReadFailure?.()

  return candidates.filter((_, i) => answers[i] === 'yes')
}

/** Every venue on a chain that the chain confirms. Empty when it has no market. */
export const liveVenues = (opts: VenueProbeOptions = {}): Promise<readonly XykVenue[]> =>
  confirmVenues(xykVenues(opts.chainId ?? getChainId()), opts)

/**
 * The leading live router on the current chain, or null when it has none.
 *
 * Kept for callers that need one address to point a swap or an allowance at. A caller that is
 * *reading* the market wants `liveVenues`: this one hides the other venue.
 */
export async function router(): Promise<Address | null> {
  const live = await liveVenues()
  return live[0]?.router ?? null
}

/** The wrapped native token on a chain — the hop every indirect route takes. */
export function wpls(id: ChainId = getChainId()): Address | null {
  return presetTokens(id).find((t) => t.symbol === 'WPLS')?.address ?? null
}

/** What the market pays for one intent's input, and how it would get there. */
export type Quote = {
  /** Market proceeds for selling `amountIn` of tokenIn into tokenOut, best of the probed paths. */
  out: bigint
  /** The path that won: the direct pair, or the hop through WPLS. */
  route: 'direct' | 'wpls'
  /** The venue label that paid `out`. Two venues quote the same pair and only one of them won. */
  venue: string
  /** `amountIn` valued in the native token, when a WPLS leg gave us that number. */
  notionalNative: bigint | null
  /** Express a tokenOut amount in WPLS: `x * wplsNum / wplsDen`. Zero num means unknown. */
  wplsNum: bigint
  wplsDen: bigint
}

/** One thing to price, tagged with a key the caller gets its answer back under. */
export type QuoteInput = { key: string; tokenIn: Address; tokenOut: Address; amountIn: bigint }

/**
 * Quote a batch of intents in one multicall. Every live venue is asked for both the direct pair
 * and the via-WPLS hop, and the best output of all of them wins.
 *
 * Each key comes back in one of three states, and the caller must keep them apart:
 *
 * - a `Quote`: at least one leg priced. Other legs can have failed, so the quote can be lower
 *   than the true best, but it is a real price.
 * - `null`: no route. Every venue probe and every leg answered, and none priced.
 * - absent from the map: unknown. No leg priced, and at least one venue probe or leg could not be
 *   read. That is a 429 or a timeout, not a fact about the market, so the caller keeps whatever it
 *   showed before. A `null` here once put "no route" on every board row during a rate limit.
 *
 * `opts.onReadFailure` fires once per call when any venue probe or leg could not be read, even if
 * every key still priced. It reports the health of the endpoint, not the state of each key.
 *
 * Adding a venue widens the batch and does not add a round trip: the whole cross product of
 * inputs, paths and venues goes into the one `batchRead` below. That is the point of building the
 * call list first and reading it once.
 */
export async function quoteAll(
  inputs: readonly QuoteInput[],
  opts: VenueProbeOptions = {},
): Promise<Map<string, Quote | null>> {
  const result = new Map<string, Quote | null>()
  if (inputs.length === 0) return result
  // A venue whose probe could not be read is neither live nor absent. If it was left out, a pair
  // that only it lists has no answer yet, so every unpriced key must stay unknown.
  let venueUnknown = false
  const venues = await liveVenues({ ...opts, onReadFailure: () => (venueUnknown = true) })
  const w = wpls(opts.chainId ?? getChainId())
  if (venues.length === 0 || !w) {
    if (venueUnknown) opts.onReadFailure?.()
    else for (const i of inputs) result.set(i.key, null)
    return result
  }
  const wl = w.toLowerCase()

  /** One venue's two attempts at one input, as indices into `calls`. */
  type Leg = { venue: XykVenue; direct: number; hop: number | null }
  type Plan = { input: QuoteInput; legs: Leg[] }
  const calls: Call[] = []
  const plans: Plan[] = []
  for (const input of inputs) {
    const inL = input.tokenIn.toLowerCase()
    const outL = input.tokenOut.toLowerCase()
    if (inL === outL || input.amountIn === 0n) {
      result.set(input.key, null)
      continue
    }
    const legs: Leg[] = []
    for (const venue of venues) {
      const direct = calls.length
      calls.push({
        address: venue.router,
        abi: ROUTER_ABI,
        functionName: 'getAmountsOut',
        args: [input.amountIn, [input.tokenIn, input.tokenOut]],
      })
      let hop: number | null = null
      if (inL !== wl && outL !== wl) {
        hop = calls.length
        calls.push({
          address: venue.router,
          abi: ROUTER_ABI,
          functionName: 'getAmountsOut',
          args: [input.amountIn, [input.tokenIn, w, input.tokenOut]],
        })
      }
      legs.push({ venue, direct, hop })
    }
    plans.push({ input, legs })
  }

  const res = await batchRead(calls, opts.client)
  const amounts = (i: number | null): readonly bigint[] | null => {
    if (i === null) return null
    const r2 = res[i]
    return r2.ok ? (r2.value as readonly bigint[]) : null
  }
  // Only a revert is the router saying "no". An unreadable leg says nothing about the pair.
  const unreadable = (i: number | null) => {
    if (i === null) return false
    const r2 = res[i]
    return !r2.ok && r2.reason === 'unreadable'
  }
  let anyUnreadable = venueUnknown
  const last = (a: readonly bigint[] | null): bigint | null => (a ? a[a.length - 1] : null)

  for (const { input, legs } of plans) {
    /** The best output seen so far, and where it came from. Ties keep the earlier venue. */
    let out: bigint | null = null
    let route: 'direct' | 'wpls' = 'direct'
    let venue = legs[0].venue.label
    /**
     * The hop that priced WPLS best, which need not be the hop that won. The WPLS valuation
     * below reads the middle leg of a hop, and the deepest WPLS leg is the soundest one to read
     * it from even when a direct pair beat it on the way out.
     */
    let bestHop: readonly bigint[] | null = null

    for (const leg of legs) {
      const d = last(amounts(leg.direct))
      const h = amounts(leg.hop)
      const hOut = last(h)
      if (d !== null && (out === null || d > out)) {
        out = d
        route = 'direct'
        venue = leg.venue.label
      }
      if (hOut !== null && (out === null || hOut > out)) {
        out = hOut
        route = 'wpls'
        venue = leg.venue.label
      }
      if (h && hOut !== null && (bestHop === null || hOut > last(bestHop)!)) bestHop = h
    }
    const legUnreadable = legs.some((leg) => unreadable(leg.direct) || unreadable(leg.hop))
    if (legUnreadable) anyUnreadable = true
    if (out === null) {
      // Leave the key out rather than write null: "no route" is a claim that every venue
      // answered, and this pass cannot make it.
      if (!legUnreadable && !venueUnknown) result.set(input.key, null)
      continue
    }

    const inIsW = input.tokenIn.toLowerCase() === wl
    const outIsW = input.tokenOut.toLowerCase() === wl

    let notionalNative: bigint | null = null
    if (inIsW) notionalNative = input.amountIn
    else if (outIsW) notionalNative = out
    else if (bestHop) notionalNative = bestHop[1]

    let wplsNum = 0n
    let wplsDen = 1n
    const hopOut = last(bestHop)
    if (outIsW) {
      wplsNum = 1n
      wplsDen = 1n
    } else if (bestHop && hopOut && hopOut > 0n) {
      wplsNum = bestHop[1]
      wplsDen = hopOut
    } else if (inIsW && out > 0n) {
      wplsNum = input.amountIn
      wplsDen = out
    }
    result.set(input.key, { out, route, venue, notionalNative, wplsNum, wplsDen })
  }
  if (anyUnreadable) opts.onReadFailure?.()
  return result
}

/** What filling an intent in full is worth against the market. */
export type Edge = {
  /** Token B owed for the full remaining amount, at `now`. */
  required: bigint
  /** Market proceeds minus required, in token B. Positive means money on the table. */
  profit: bigint
  /** profit / required, in percent. */
  spreadPct: number
  /** Profit valued in the native token, when the quote carried a WPLS leg. */
  profitNative: bigint | null
}

/** The executor's number: what filling this intent in full earns against the market. */
export function edgeOf(intent: Intent, quote: Quote | null | undefined, now: bigint): Edge | null {
  if (!quote) return null
  const base = minOutAt(intent, now)
  if (base === 0n) return null
  // What the filler really bears: the output fee (P2) is paid on top of the maker's number, and
  // the handover fee (P1) leaves less tokenIn to sell. P3 comes out of the maker's own proceeds.
  const WAD = 10n ** 18n
  const rates = pricedFeeRates(intent)
  const required = base + (base * rates.output) / WAD
  const out = quote.out - (quote.out * rates.handover) / WAD
  const profit = out - required
  const spreadPct = Number((profit * 10_000n) / required) / 100
  const profitNative = quote.wplsNum > 0n ? (profit * quote.wplsNum) / quote.wplsDen : null
  return { required, profit, spreadPct, profitNative }
}

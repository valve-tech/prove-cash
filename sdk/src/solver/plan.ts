import type { Address } from 'viem'
import { breakpointsOf } from '../intent.js'
import { maxFeeRateFor } from '../settlement.js'
import type { RingFill } from './abi.js'
import type { OrderBook } from './book.js'
import type { MaxPerPair } from './depth.js'
import { EMPTY_PRICES, gasCostNative, valueInNative, type PriceBook } from './price.js'
import type { Market } from './market.js'
import {
  findRings,
  ringIntentKeys,
  usesMarket,
  type Leg,
  type MarketLeg,
  type MarketLookup,
  type Ring,
} from './rings.js'
import { armingWindow } from './arming.js'
import { sizeRing, type SizedRing } from './size.js'

/**
 * The engine: a book and a timestamp in, a ranked list of executable plans out.
 *
 * It is a pure function and it has to stay one. Every number it needs from the chain — the fee
 * split, the market's own quote, the gas price, the native-token prices — arrives as an argument, so
 * cases worth testing become ordinary unit tests: a ring that only closes after ten minutes of
 * decay, a ring that integer rounding kills, a ring with one pinned leg.
 */

/** What the settlement of one plan is expected to cost in gas, before a simulation says. */
export type GasModel = {
  /** The transaction and the batch's own overhead. */
  base: bigint
  /** Each intent filled: two transfers, a hash, a storage write. */
  perIntentLeg: bigint
  /** The market swap, which settles in its own transaction. */
  perMarketLeg: bigint
  /**
   * A leg the batch stepped over — `skipInvalid` only, never a ring.
   *
   * A skipped leg is not free and it is not one price. Marginal cost on an eight-leg batch,
   * from `contracts/test/Gas.t.sol` through `app/src/landing/gas.ts`:
   *
   *   a leg that fills           69,841
   *   a leg that expired         15,218  — `_evaluate` refuses it before a token is touched
   *   a leg a rival already took 15,982  — the same, after one more storage read
   *   a leg that cannot be armed 80,174  — MORE than filling it, because the external call is
   *                                        made and reverted inside `armLeg`'s frame
   *
   * These used to be four figures from `app/scripts/lab/batch-gas.ts`, which is a lab script and
   * therefore a different instrument and no gate. They are generated rows now, so the same four
   * quantities have one number each across the repository instead of two.
   *
   * The pessimistic figure is the one to plan with. A batch is worth sending when the surplus on
   * the legs that FILL covers the gas of all of them, and pricing only the survivors is exactly
   * what makes a batch of eight look free.
   *
   * **None of this applies to a ring, and the right way to see the difference is per WIN.** A
   * ring sends `skipInvalid` false, so a leg a rival took does not cost one leg — it reverts the
   * whole transaction, which pays for everything it settled first and earns nothing. Measured in
   * `contracts/test/Gas.t.sol`:
   *
   *   tolerant   a lost leg costs 15,982 against 69,841 for the fill it would have made, and the
   *              rest of the batch still fills. Under a quarter of one fill, and you still earn
   *   ring       a lost 3-leg ring costs 222,044 against 283,087 to settle one. Three quarters of
   *              a win, and you earn nothing at all
   *
   * So two evenly matched solvers racing on rings each pay about 1.8x the gas per ring they
   * actually settle. On the tolerant path the same collision rate adds about 3%. That is the
   * gap — not a bigger bill for the same event, a different kind of event.
   *
   * Two levers follow, both about solvers colliding by accident rather than anybody attacking.
   * **Ring size is the exposure**: the loss is roughly the position of the missing leg times the
   * cost of a fill, so `--legs` is a contention setting as much as a search setting. And **the
   * order of the legs is worth as much as their number** — the same eight legs cost 121,329 or
   * 554,731 depending only on where the missing one sits.
   *
   * Size costs even when the failure is early, and before any of it executes. The settlement
   * really does give up at once on a missing first leg, but the same failure costs 59,727 on an
   * atomic 2 and 121,329 on an atomic 8 — about 8,800 a leg for calldata and decoding that never
   * ran. No contract change reaches that; it is the price of putting the bytes on chain.
   */
  perSkippedLeg?: bigint
}

/**
 * The most legs a batch may carry, and the most of them that may fail.
 *
 * These bound the non-ring path only. `fillBatch` with `skipInvalid` steps over a leg it cannot
 * settle and fills the rest, so eight can go in and seven can fail. A ring is the opposite and
 * always will be: `skipInvalid` is false there, because settling part of a cycle leaves the
 * solver holding an unhedged position.
 *
 * Eight is a policy, not a contract limit — neither the settlement nor the executor caps the
 * array, and gas is the real ceiling. It is here so the number has one home and a reason beside
 * it.
 *
 * The reason is the shape of the cost. Eight legs one at a time cost 1,190,037 gas, and one
 * batch of the same eight costs 695,959 — 43% less, which is 60,408 a leg, the transaction the
 * solver did not have to send. Both are rows in `app/src/landing/gas.ts`, so
 * `check-gas-figures.py` refuses this comment the day either one moves. They were not rows until
 * #136, and this paragraph carried a figure the suite had already stopped producing.
 *
 * A per-leg average hides two things, and both matter. Dividing a total by the legs that FILLED
 * charges every survivor a share of a base paid once, so the fewer legs survive the dearer each
 * survivor reads — true as a cost, but not what the leg cost. And the failures are not free.
 * Three of them, and they are not close together:
 *
 *   an expired offer           15,218   `_evaluate` refuses it before a token is touched
 *   a leg a rival took         15,982   the same, after one more storage read
 *   a leg that cannot be armed 80,174   MORE than filling it: the external call is made,
 *                                       the token refuses it, and the frame catches the revert
 *
 * The middle one is the case that actually happens — two solvers reading one book overlap, and
 * the loser pays for every leg it duplicated. The dear one needs somebody to build a bait and
 * then win a race to land it. So the break-even edge rises as roughly 1/filled, and a batch is
 * worth sending on the surplus of the legs expected to survive, never on its size.
 */
export const MAX_BATCH_LEGS = 8
export const MAX_BATCH_FAULTS = MAX_BATCH_LEGS - 1

/**
 * The gas an `n`-leg batch costs when `expectedFaults` of them are expected to be stepped over.
 *
 * Use it to answer the only question that matters before sending one: does the surplus on the
 * legs that fill cover the gas of every leg that was tried?
 */
export function batchGas(model: GasModel, legs: number, expectedFaults = 0): bigint {
  const faults = BigInt(Math.max(0, Math.min(expectedFaults, legs)))
  const filled = BigInt(legs) - faults
  return model.base + filled * model.perIntentLeg + faults * (model.perSkippedLeg ?? model.perIntentLeg)
}

/**
 * Measured against the deployed contract on a fork of PulseChain mainnet: a one-leg batch cost
 * 304k gas and a two-leg batch 509k, both in approval custody with every storage slot cold, and
 * the closing PulseX swap cost 212k.
 *
 * It is a filter, not an estimate. Nothing should be sent on these numbers — `simulateRing`
 * measures the real figure and `withSimulatedGas` re-prices the plan on it. The model only has
 * to be close enough to stop the engine ranking a ring it could never afford.
 */
export const DEFAULT_GAS_MODEL: GasModel = {
  base: 99_000n,
  perIntentLeg: 205_000n,
  perMarketLeg: 215_000n,
  // The pessimistic skip: a leg that passed evaluation and then failed to arm, which costs more
  // than filling it. An expired leg is a seventh of this, but a model that assumes the cheap
  // failure is a model that sends batches it cannot afford.
  //
  // It has to be stated on this model's own scale, and the first version of it was not. The
  // measurement is warm — 80,174 against 69,841 for a fill — and these constants are cold, so
  // dropping the raw figure in beside a 205,000 fill said a failure was CHEAPER than a fill and
  // inverted the sentence above it. What carries across scales is the ratio, about 1.22, and this
  // is `perIntentLeg` times that ratio with room over it.
  //
  // A caller who wants the common failure rather than the worst one should pass a model with
  // `perSkippedLeg` near a quarter of `perIntentLeg`: a leg a rival took costs 15,982 against a
  // 69,841 fill. This default takes the pessimistic reading because a model that assumes the
  // cheap failure is a model that sends batches it cannot afford.
  perSkippedLeg: 260_000n,
}

/** Everything the engine needs that it cannot derive from the book. */
export type SolveParams = {
  /** The timestamp to price at. The Dutch curve makes this the most important input here. */
  at: bigint
  /** The address that will send the batch. Only used to stamp the plan. */
  executor: Address
  /** Token values in the chain's native token, for comparing a surplus against gas. */
  prices?: PriceBook
  /** The gas price the plan will be sent at, in wei. */
  gasPrice: bigint
  gasModel?: GasModel
  /** Refuse plans whose net is below this, in the native token. Zero takes any positive net. */
  minNetNative?: bigint
  /**
   * Profit tokens a plan may earn in while nothing prices them. A plan in any other unpriced
   * token is refused, because its net cannot be weighed against its gas. Empty by default.
   */
  unpricedOk?: readonly Address[]
  /** Where to find a market for one direction. Omit to search intents only. */
  markets?: MarketLookup
  /** How many legs a ring may have, 2 up to `MAX_RING_LEGS`. Three by default. */
  maxLegs?: number
  /** One depth for every direction, or a per-token table. See `depth.ts`. */
  maxPerPair?: MaxPerPair
  maxRings?: number
  /** Cap on the plans returned, after ranking. */
  maxPlans?: number
  /**
   * Legs another solver already has a pending transaction over, by `intentKey`. `solve` builds no
   * ring that names one.
   *
   * `readRivalClaims` in `mempool.ts` reads them out of the pool and `claimedKeys` is the set.
   * Omit it and nothing is refused, which is the honest default: a solver that cannot see the
   * pool knows nothing about its rivals rather than knowing there are none.
   *
   * **Why the ring is dropped and not merely deprioritised.** A ring sends `skipInvalid` false,
   * so a leg a rival takes first does not cost one leg — it reverts the transaction after paying
   * for everything it settled before the gap. Measured in `contracts/test/Gas.t.sol`, a 3-leg
   * ring loses 222,044 gas and earns nothing, against 283,087 to settle one. There is no partial
   * credit to rank; the ring is worth its full value or it is worth less than nothing.
   *
   * **And why it is dropped on the tolerant path too, where the same collision costs 15,982.**
   * One rule is easier to reason about than two, and the tolerant loss is small enough that
   * refusing costs about as little as carrying. A caller who wants the other trade-off leaves
   * this out for their tolerant pass and passes it for their ring pass; the set is an argument
   * precisely so that choice stays the caller's.
   *
   * See `ConfidenceInputs.claimed` for the second, weaker use of the same set: once a ring exists,
   * the score can only move a doomed leg to the front, where a break is cheapest.
   */
  claimed?: ReadonlySet<string>
}

/**
 * The market swap that closes a ring, when a ring closes at one.
 *
 * `market` and not `pool`, and it carries its own router: a pair on one venue walks different
 * reserves from the same pair on another, so the venue that PRICED the leg has to be the venue
 * that fills it. `routerFor` used to re-derive that from the plan, one step removed from the leg
 * that knew the answer.
 */
export type MarketSwap = {
  market: Market
  amountIn: bigint
  /** What the ring needs back. Send the swap with this as `amountOutMin` and nothing less. */
  amountOutMin: bigint
}

/** One executable answer: what to fill, what it earns, and what it costs to find out. */
export type Plan = {
  ring: Ring
  sized: SizedRing
  /**
   * The intent fills, in the order `fillBatch` must take them. `skipInvalid` is false for all
   * of them: settling part of a cycle leaves the solver holding an unhedged position.
   *
   * A fill carries `arming` when its maker's funds are reached by a signature rather than by a
   * standing allowance or a funded escrow. The book puts the bytes there; nothing here builds
   * them, and a leg the chain already calls fillable carries none.
   */
  fills: readonly RingFill[]
  /**
   * The swap that closes the ring, or null when intents close it alone. It settles after the
   * batch, in its own transaction, so a plan carrying one is not atomic.
   */
  swap: MarketSwap | null
  /** True when the whole plan is one `fillBatch` and either lands or does not. */
  atomic: boolean
  /** The surplus, in `profitToken`. */
  profit: bigint
  profitToken: Address
  /** The surplus in the native token, or null when nothing could price the token. */
  profitNative: bigint | null
  /** Expected gas. From the model until a simulation replaces it. */
  gas: bigint
  /** True once a simulation, not the model, set `gas`. */
  gasSimulated: boolean
  /** `gas · gasPrice`, in the native token. */
  gasNative: bigint
  /** `profitNative − gasNative`, or null when the surplus could not be priced. */
  netNative: bigint | null
  /** What the executor must hold before the batch starts, by token. */
  capital: readonly { token: Address; amount: bigint }[]
  /** That capital in the native token, or null when a token could not be priced. */
  capitalNative: bigint | null
  /**
   * The fee bound to send with the batch: exactly the rate the plan was priced at.
   *
   * It bounds the TOTAL and not the owner's floor. Every leg charges its own `feeRate` when that
   * is higher, so a bound set to the floor makes the contract step over the dearest leg — and a
   * ring that loses a leg settles nothing.
   */
  maxFeeRate: bigint
  executor: Address
  /** The timestamp the plan was priced at. */
  at: bigint
}

/**
 * True when a plan's net clears `minNet`. A null net means nothing priced the profit token, and
 * it clears only when the operator allows that token unpriced. A null used to pass every gate,
 * so a ring that earned an unpriced token went out whatever its gas cost.
 */
export function netClears(
  plan: Pick<Plan, 'netNative' | 'profitToken'>,
  minNet: bigint,
  unpricedOk: readonly Address[] = [],
): boolean {
  if (plan.netNative !== null) return plan.netNative > minNet
  const token = plan.profitToken.toLowerCase()
  return unpricedOk.some((a) => a.toLowerCase() === token)
}

/**
 * `netClears` for one transaction that settles several plans. The priced nets add up and clear
 * `minNet` together. Every unpriced leg must earn in a token the operator allows unpriced.
 */
export function batchNetClears(
  plans: readonly Pick<Plan, 'netNative' | 'profitToken'>[],
  minNet: bigint,
  unpricedOk: readonly Address[] = [],
): boolean {
  let sum = 0n
  let priced = false
  for (const p of plans) {
    if (p.netNative === null) {
      if (!netClears(p, minNet, unpricedOk)) return false
      continue
    }
    priced = true
    sum += p.netNative
  }
  return !priced || sum > minNet
}

const gasFor = (ring: Ring, model: GasModel): bigint => {
  let gas = model.base
  for (const leg of ring.legs) {
    gas += leg.kind === 'intent' ? model.perIntentLeg : model.perMarketLeg
  }
  return gas
}

const marketLegOf = (ring: Ring): MarketLeg | null =>
  (ring.legs.find((l) => l.kind === 'market') as MarketLeg | undefined) ?? null

/** Turn a sized ring into a plan, pricing it against gas. Null when it never clears the bar. */
export function planOf(sized: SizedRing, params: SolveParams): Plan | null {
  const prices = params.prices ?? EMPTY_PRICES
  const model = params.gasModel ?? DEFAULT_GAS_MODEL
  const gas = gasFor(sized.ring, model)
  const gasNative = gasCostNative(gas, params.gasPrice)
  const profitNative = valueInNative(prices, sized.profitToken, sized.profit)
  const netNative = profitNative === null ? null : profitNative - gasNative
  const minNet = params.minNetNative ?? 0n
  // With no price book and no gas price there is nothing to weigh, so a null net stands.
  const weighs = params.prices !== undefined || params.gasPrice > 0n
  if (netNative !== null && netNative <= minNet) return null
  const unpriced = { netNative, profitToken: sized.profitToken }
  if (netNative === null && weighs && !netClears(unpriced, minNet, params.unpricedOk)) return null

  let capitalNative: bigint | null = 0n
  for (const c of sized.capital) {
    const v = valueInNative(prices, c.token, c.amount)
    if (v === null) {
      capitalNative = null
      break
    }
    capitalNative += v
  }

  const fills = sized.legs.flatMap((l): RingFill[] =>
    l.leg.kind === 'intent'
      ? [
          {
            intent: l.leg.entry.intent,
            take: l.take,
            ...(l.leg.entry.arming ? { arming: l.leg.entry.arming } : {}),
          },
        ]
      : [],
  )
  if (fills.length === 0) return null

  const marketLeg = marketLegOf(sized.ring)
  let swap: MarketSwap | null = null
  if (marketLeg) {
    const sizedMarket = sized.legs.find((l) => l.leg === (marketLeg as Leg))
    if (!sizedMarket) return null
    swap = {
      market: marketLeg.market,
      amountIn: sizedMarket.pay,
      amountOutMin: sizedMarket.take,
    }
  }

  return {
    ring: sized.ring,
    sized,
    fills,
    swap,
    atomic: swap === null,
    profit: sized.profit,
    profitToken: sized.profitToken,
    profitNative,
    gas,
    gasSimulated: false,
    gasNative,
    netNative,
    capital: sized.capital,
    capitalNative,
    maxFeeRate: maxFeeRateFor(fills.map((f) => f.intent)),
    executor: params.executor,
    at: params.at,
  }
}

/** Best first: net in the native token, then raw surplus, then the shorter ring. */
export function rankPlans(plans: readonly Plan[]): Plan[] {
  return [...plans].sort((a, b) => {
    const an = a.netNative
    const bn = b.netNative
    if (an !== null && bn !== null && an !== bn) return an > bn ? -1 : 1
    if (an !== null && bn === null) return -1
    if (an === null && bn !== null) return 1
    if (a.profit !== b.profit) return a.profit > b.profit ? -1 : 1
    return a.ring.legs.length - b.ring.legs.length
  })
}

/**
 * True when some other solver's pending transaction already names a leg of this ring.
 *
 * A ring is unusable the moment ONE of its legs is spoken for, which is the whole difference
 * between a cycle and a batch — `some`, not `every`, and not a count.
 */
export const ringIsClaimed = (ring: Ring, claimed?: ReadonlySet<string>): boolean =>
  claimed !== undefined && ringIntentKeys(ring).some((k) => claimed.has(k))

/**
 * The engine. Every 2- and 3-cycle in the book that passes the ring condition, sized in exact
 * integers, priced against gas, and ranked.
 *
 * One intent can appear in several plans — the same maker often sits on both sides of two
 * different cycles. The list is a menu, not a schedule; run `selectDisjoint` over it before
 * sending anything.
 *
 * A ring naming a leg in `params.claimed` never reaches the menu. The drop happens here, after
 * the search and before the sizing, for two reasons: `findRings` stays a pure question about the
 * book's shape, and the mempool — the one input here with a shelf life of a single block — stays
 * visible in the one function a caller passes it to.
 */
export function solve(book: OrderBook, params: SolveParams): Plan[] {
  const rings = findRings(book, params.at, {
    maxLegs: params.maxLegs,
    maxPerPair: params.maxPerPair,
    maxRings: params.maxRings,
    markets: params.markets,
  })

  const plans: Plan[] = []
  for (const ring of rings) {
    if (ringIsClaimed(ring, params.claimed)) continue
    const sized = sizeRing(ring, params.at)
    if (!sized.ok) continue
    const plan = planOf(sized.sized, params)
    if (plan) plans.push(plan)
  }
  const ranked = rankPlans(plans)
  return params.maxPlans === undefined ? ranked : ranked.slice(0, params.maxPlans)
}

/**
 * Pick plans that name no intent twice. Greedy over the ranking: a plan is kept unless an intent
 * it needs has already been promised to a better one.
 *
 * **This is necessary and it is not sufficient.** Two plans can name four different intents and
 * still be unable to settle together, because two of those intents belong to one maker and there
 * is one balance behind them — or because both are armed by a permit, and permit nonces are
 * ordered. `selectFeasible` in `groups.ts` is the rule that knows about that, and it is the one
 * to call. This stays because disjointness is worth naming on its own, and because a caller with
 * no group information still gets the old answer.
 */
export function selectDisjoint(plans: readonly Plan[]): Plan[] {
  const taken = new Set<string>()
  const kept: Plan[] = []
  for (const plan of plans) {
    const keys = ringIntentKeys(plan.ring)
    if (keys.some((k) => taken.has(k))) continue
    for (const k of keys) taken.add(k)
    kept.push(plan)
  }
  return kept
}

// ── When a ring becomes worth doing ───────────────────────────────────────────

/**
 * The last second at which every leg in a ring is still fillable.
 *
 * The intent's own `endTime` is not the whole answer. A leg funded by a signature dies when that
 * signature does, and a 3009 authorization or a permit deadline can fall well before the offer
 * it funds. Taking the intent's word for it schedules rings for a moment when one of their legs
 * can no longer be armed.
 */
export function ringDeadline(ring: Ring): bigint {
  let end: bigint | null = null
  for (const leg of ring.legs) {
    if (leg.kind !== 'intent') continue
    // `until` is already the last second the chain accepts: `armingWindow` takes `endTime` as
    // exclusive, the way `_fillability` does, and a signature's deadline can only shorten it.
    const e = armingWindow(leg.entry.intent).until
    if (end === null || e < end) end = e
  }
  return end ?? 0n
}

/** How far ahead to look, and how hard to look there. */
export type TimingOptions = {
  /** Stop looking at this timestamp. Defaults to the ring's own deadline. */
  until?: bigint
  /**
   * Seconds to step back from the boundary the search lands on.
   *
   * A ring's surplus grows with the decay, but only almost monotonically: integer rounding can
   * make one second worse than the next. The bisection assumes monotonicity and this walk-back
   * repairs the few seconds where that assumption is wrong.
   */
  backoff?: number
  /**
   * Called with every second the search prices, before it prices it.
   *
   * A trace hook, and the only way to see what the search costs from outside: each call is one
   * `sizeRing` and at most one `planOf`, which is the unit the timing claims are counted in.
   */
  onProbe?: (at: bigint) => void
}

/**
 * The instants inside `(from, until)` where a ring's price schedule turns, soonest first.
 *
 * One list for the whole ring, because the legs are priced together: a knot on any leg is a
 * knot in the ring's surplus. Market legs have no schedule of their own — they are priced from
 * a reserve snapshot the caller passes in — so they contribute nothing here.
 */
function ringBreakpoints(ring: Ring, from: bigint, until: bigint): bigint[] {
  const out: bigint[] = []
  for (const leg of ring.legs) {
    if (leg.kind !== 'intent') continue
    for (const t of breakpointsOf(leg.entry.intent)) {
      if (t > from && t < until && !out.includes(t)) out.push(t)
    }
  }
  return out.sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
}

/**
 * The first second inside `(lo, hi]` that pays, given that `lo` does not and `hi` does.
 *
 * The bisection is exact where the predicate is monotone, and the walk-back repairs the seconds
 * where integer rounding makes it not quite. It never steps below `floor`, which is the caller's
 * own starting second.
 */
function firstPayingIn(
  lo: bigint,
  hi: bigint,
  floor: bigint,
  pays: (t: bigint) => boolean,
  backoff: number,
): bigint {
  let bad = lo
  let good = hi
  while (good - bad > 1n) {
    const mid = (bad + good) / 2n
    if (pays(mid)) good = mid
    else bad = mid
  }

  // Walk back over the seconds the bisection had to assume were bad.
  const steps = BigInt(backoff)
  let best = good
  for (let step = 1n; step <= steps && best - 1n >= floor; step++) {
    if (!pays(best - 1n)) break
    best -= 1n
  }
  return best
}

/**
 * When this ring first pays for itself, or null when it never does before it expires.
 *
 * This is the solver's real edge. The Dutch curve only ever moves in the executor's favour, so a
 * ring that misses the boundary now is a ring to wait for, not a ring to discard — and knowing
 * the second it flips is worth more than knowing that it eventually will.
 *
 * Nothing here encodes the fee model, and nothing needs to. It bisects on `sizeRing` and
 * `planOf`, both of which price a leg through the settlement's own `quote`. The split moved the
 * boundary earlier in the window — the executor stopped paying the rate — and this found the new
 * second without a line changing.
 *
 * **A bisection needs the predicate to be monotone in time, and a curve does not have to be.**
 * A flat region does not break it. A rising segment breaks it outright: the window can open,
 * close and open again, and a bisection between an unprofitable start and a profitable deadline
 * then lands in the wrong basin, or reports nothing while a profitable interval sits in the
 * middle. So the search walks segment by segment instead — the knots come from `breakpointsOf`,
 * the segment that first ends profitable is the segment that holds the crossing, and the
 * bisection runs only inside it, where the predicate is monotone by construction.
 *
 * **It costs a solver that never meets a curve nothing.** Kind 0 has no knots, so the walk is
 * one segment, the two end probes and one bisection — the same probes, in the same order, as
 * before curves existed. Kind 1 has at most two knots, so it pays at most two more boundary
 * probes and takes some of them back on a bisection over a shorter segment. On the ring
 * `solver.test.ts` measures, kind 0 costs thirteen probes and kind 1 costs twelve. `onProbe`
 * counts them, and that test pins both numbers.
 */
export function profitableFrom(
  ring: Ring,
  params: SolveParams,
  opts: TimingOptions = {},
): bigint | null {
  const until = opts.until ?? ringDeadline(ring)
  if (until < params.at) return null

  const pays = (t: bigint): boolean => {
    opts.onProbe?.(t)
    const sized = sizeRing(ring, t)
    if (!sized.ok) return false
    return planOf(sized.sized, { ...params, at: t }) !== null
  }

  if (pays(params.at)) return params.at

  let lo = params.at // known bad, and it stays the left end until a segment ends profitable
  for (const hi of [...ringBreakpoints(ring, params.at, until), until]) {
    if (!pays(hi)) {
      lo = hi
      continue
    }
    return firstPayingIn(lo, hi, params.at, pays, opts.backoff ?? 8)
  }
  return null
}

/** A ring that does not pay yet, and the second it starts to. */
export type UpcomingRing = { ring: Ring; at: bigint; usesMarket: boolean }

/**
 * Rings the book already contains that are not worth sending yet, each with the timestamp it
 * becomes worth sending. Ordered soonest first, so a bot can sleep on the head of the list.
 *
 * **`params.claimed` is deliberately ignored here.** The mempool describes this block and this
 * list describes minutes from now, by which time the pending transaction has landed, been
 * replaced or been dropped. A ring hidden from the schedule on today's pool is a ring the solver
 * forgets to look at, and the whole point of the schedule is that a leg the chain refuses now may
 * be the best trade on the board in four minutes. Read the pool again when the moment arrives.
 */
export function upcoming(
  book: OrderBook,
  params: SolveParams,
  horizonSeconds: bigint,
): UpcomingRing[] {
  // Look for cycles at the end of the horizon: the ring condition is what a decayed rate
  // eventually satisfies, and a ring that fails it even then will never close.
  const at = params.at + horizonSeconds
  const rings = findRings(book, at, {
    maxLegs: params.maxLegs,
    maxPerPair: params.maxPerPair,
    maxRings: params.maxRings,
    markets: params.markets,
  })

  const out: UpcomingRing[] = []
  for (const ring of rings) {
    const until = ringDeadline(ring)
    const when = profitableFrom(ring, params, {
      until: until < at ? until : at,
    })
    if (when === null || when <= params.at) continue
    out.push({ ring, at: when, usesMarket: usesMarket(ring) })
  }
  return out.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1))
}

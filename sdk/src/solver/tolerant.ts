/**
 * A ring that survives losing a leg: one market fallback per intent leg, sized from live reserves.
 *
 * The contract half landed first (`ProveBatchExecutor.WHEN_ABSENT`) and the calldata half after
 * it. Both leave the same question open, and this file answers it: WHICH market stands in for
 * each maker, and HOW MUCH it may spend. Until that is answered a solver has a mechanism and no
 * plan for it.
 *
 * ── What a missing leg leaves behind ──────────────────────────────────────────
 *
 * Number the ring's legs 0..n−1. Leg k hands the executor `take_k` of the token it receives and
 * the executor hands leg k `pay_k` of the token it pays, and the cycle chains them:
 * `pay_k = take_{k+1}`. The settlement releases every leg's token A before it pulls any payment,
 * so by the time the route runs the executor is holding every surviving leg's release.
 *
 * Drop leg k and two entries of that ledger change, and only two.
 *
 *   short  `take_k` of the token leg k was going to supply. Leg k−1 is still owed it.
 *   long   `pay_k` of the token leg k was going to be paid in, because leg k+1 released it
 *          and the maker it was for is gone.
 *
 * So the fallback sells the second for the first — the missing maker's own trade, run at a venue
 * instead of against them. Every other token nets to zero, and the ring's surplus is untouched.
 *
 * ── The one rule that makes this worth doing ──────────────────────────────────
 *
 * **A fallback may never spend more than the missing leg frees.** `pay_k` is the exact budget,
 * it is money already committed to that maker, and it is unowed the moment they are gone. Spend
 * exactly it, demand `take_k` back, and the executor ends the transaction holding at least what
 * the intact ring would have left it — token for token, every leg.
 *
 * That is the whole argument for the feature: **a tolerant ring never earns less than the atomic
 * one it replaces, and the only extra cost is gas.** It rests on two lines below and nothing
 * else. `amountOutMin` is the leg's own `take`, never a zero, so a moved pool reverts rather than
 * settling the ring at a price nobody agreed to. And a market that asks MORE than `pay_k` is
 * refused rather than clamped: a fallback sized past its budget cannot clear its own bound, so
 * carrying it would buy a revert at full price.
 *
 * Sizing is therefore not a guess and takes no slack parameter. The amount is the budget; live
 * reserves decide whether to carry the fallback at all, and `headroomBps` says how far the pool
 * may move before the answer changes.
 *
 * **`pay_k` is a hard ceiling and not a policy, for every leg but one.** Work the balance sheet
 * through and the executor holds free funds in exactly two tokens: `pay_k` of the token leg k+1
 * released, and the ring's own surplus in the token leg 0 receives. Every other token nets to
 * zero, leg against leg. A swap sells one token, and the one this swap sells is the first of
 * those — so for every leg but the last, `pay_k` is all the money there is.
 *
 * The last leg is the exception, because the token it pays in IS the surplus token, and this
 * file deliberately does not reach for it. A ring that spends its whole surplus to avoid a
 * revert has traded a 222,044-gas loss for a zero-profit fill. That is better on gas and it is
 * still a judgement about what a solver is in business for, so it stays a thing somebody asks
 * for rather than a thing that happens.
 *
 * **Expect most legs to be refused, and expect the reason to be the budget.** A market cheap
 * enough to stand in for a maker usually makes a BETTER ring, and `findRings` would have found
 * that ring instead — it tries a market in the closing position of every rotation. So on a
 * top-ranked ring the makers are generally the cheap side by construction, and the fallback that
 * would replace one is generally unaffordable. That is not a defect to code around; it is the
 * measurement the roadmap asks for, and `refused` is how a solver sees it on its own board.
 *
 * ── What it costs, and why it is not the default ──────────────────────────────
 *
 * A fallback is carried on EVERY ring and paid for on every ring, to save the loss on the few
 * that lose a leg. `FALLBACK_FIRST_GAS` and `FALLBACK_MORE_GAS` are what carrying costs, and
 * `breakEvenLossRate` turns them into the rate above which it pays. For a three-leg ring on the
 * numbers in this file that rate is about 22%, on gas alone. Nobody has measured a live board's
 * rate, so nothing here turns itself on: a caller asks for a tolerant ring by building one.
 *
 * ── Where it stops ───────────────────────────────────────────────────────────
 *
 * One lost leg always closes, given a market for it. TWO lost legs close only when their
 * fallbacks happen to run in a funding order — `swapOrder` buys as much of that as a fixed order
 * can, and no fixed order can buy all of it, because the dependency runs round a cycle. What
 * happens otherwise is a revert: the second fallback finds the balance short and the transaction
 * unwinds having settled nothing. That fails closed, which is the only acceptable way for a plan
 * to be wrong about the shape of its own bag.
 */
import type { Address } from 'viem'
import { WHEN_ABSENT, type RouteSwap } from './abi.js'
import { marketRouteSwap, type Market } from './market.js'
import type { Plan } from './plan.js'
import type { MarketLookup } from './rings.js'

/**
 * What the first fallback on a route costs, carried whether or not it fires.
 *
 * Measured on a ring that did not need it, warm, in
 * `contracts/test/BatchExecutor.t.sol::test_WhatAFallbackCostsARingThatDoesNotNeedIt`. Dearer
 * than the ones after it by the sink lookup: a route naming no venue at all does not even predict
 * an address, and this one does.
 *
 * **It is gated now.** #130 moved the row into `contracts/test/Gas.t.sol`, so
 * `app/src/landing/gas.ts` carries it as `a fallback carried, the first` and CI's
 * `node scripts/gen-gas.mjs --check` compares it against a fresh `forge test` on every push. It
 * used to be a measurement quoted into code with only a 22,000 ceiling behind it, which is the
 * shape of mistake this repository has already made twice; it had drifted to 19,357 against a
 * measured 19,355 by the time the gate went in.
 *
 * The `Gas.t.sol` row and the ceiling test measure the same ring in the same fixture, on purpose.
 * Read `FallbackGasTest` before changing either: the same ring in a differently warmed fixture
 * reads 23,827, and a break-even built on the wrong fixture is wrong by a fifth.
 */
export const FALLBACK_FIRST_GAS = 19_354n

/** Each fallback after the first, same row, `a fallback carried, each after`. Ceiling 20,000. */
export const FALLBACK_MORE_GAS = 17_486n

/**
 * A solver's very first ring that names any venue, because it mints their call sink.
 *
 * One clone per CALLER, so this is an entry fee paid once in a solver's life and never again. It
 * does not belong in a break-even and is here so nobody puts it in one.
 *
 * Gated with the two above, as `a solver's first sink, once ever` in `app/src/landing/gas.ts`. It
 * read 52,116 here against a measured 54,688 when #130 put the row in.
 */
export const FIRST_SINK_GAS = 53_865n

/** What carrying `n` fallbacks costs a ring, in gas. Zero for a ring carrying none. */
export function carriedFallbackGas(n: number): bigint {
  if (n <= 0) return 0n
  return FALLBACK_FIRST_GAS + BigInt(n - 1) * FALLBACK_MORE_GAS
}

/**
 * The loss rate above which carrying `n` fallbacks pays for itself, on gas alone.
 *
 * Carrying costs on every ring; the loss is avoided only on the rings that lose a leg. So with
 * `p` the share of rings that lose one:
 *
 *     carried · (1 − p)  <  lost · p        ⟹        p  >  carried / (carried + lost)
 *
 * `lost` is what an atomic ring burns when it loses a leg and returns nothing — `atomic 3, one
 * leg gone` in `app/src/landing/gas.ts`, which is generated from `contracts/test/Gas.t.sol` and
 * checked in CI. Pass it rather than quoting it, so this arithmetic cannot go stale on its own.
 *
 * The answer is a floor and not a target. It counts gas and nothing else, so it ignores the
 * surplus a completed ring still earns — which only lowers the real rate, by whatever the ring's
 * own margin is. A number in 0..1, and NaN never: `carried` is positive for `n ≥ 1`.
 */
export function breakEvenLossRate(n: number, lostRingGas: bigint): number {
  const carried = carriedFallbackGas(n)
  if (carried <= 0n) return 0
  return Number(carried) / Number(carried + lostRingGas)
}

/** One market standing in for one maker, sized against the reserves it was planned on. */
export type Fallback = {
  /**
   * Which leg of the batch this stands in for, as an index into `plan.fills`.
   *
   * Not the same number as `position`: `fills` carries only the intent legs, so a ring with a
   * market leg in the middle of it numbers the two differently. The executor reads this one.
   */
  fill: number
  /**
   * Where that leg sits in the ring. What orders the swaps, and nothing the executor reads.
   *
   * The route's order is a funding order — see `swapOrder` — and funding runs round the cycle,
   * not down the fill array.
   */
  position: number
  /** The market that stands in. Bound to the direction the missing maker was going. */
  market: Market
  /** What the missing leg was going to supply: its `take`. The bound, and never a zero. */
  amountOutMin: bigint
  /** What this spends: exactly what the missing maker's payment frees, and never more. */
  amountIn: bigint
  /** What the market asked for `amountOutMin` at the reserves this was planned on. */
  quoted: bigint
  /**
   * How far the market may move against this fallback before it can no longer clear its bound,
   * in basis points of the quote.
   *
   * Zero means the market is exactly at the budget and any adverse tick reverts the ring. A
   * solver watching this over a few passes learns which of its rings are carrying a fallback
   * that will not fire.
   */
  headroomBps: number
}

/** A leg with no fallback, and why. A ring carrying one of these can still revert. */
export type RefusedFallback = { fill: number; position: number; why: string }

/**
 * A ring, plus the fallbacks that let it survive losing a leg.
 *
 * Built from a plan and never instead of one. The plan is still the ring, still priced at the
 * makers' own rates, and still worth exactly what it was — this only says what happens when one
 * of those makers is gone.
 */
export type TolerantRing = {
  /**
   * The ring this was planned for.
   *
   * A tolerant plan describes ONE ring's legs by index, and handing it to another ring points
   * every fallback at the wrong maker. `routeFor` refuses a mismatch rather than encoding it.
   */
  ringId: string
  fallbacks: readonly Fallback[]
  refused: readonly RefusedFallback[]
  /**
   * True when every intent leg has a fallback.
   *
   * Only then does no SINGLE lost leg revert the ring. A ring that is not complete is still
   * worth sending tolerantly — it survives the legs it covered — but it reverts on the ones it
   * did not, exactly as an atomic ring does.
   */
  complete: boolean
  /** What carrying these costs, in gas. `carriedFallbackGas` over the list. */
  carriedGas: bigint
}

/** Where to find a market for one direction. The same lookup the ring search used. */
export type TolerantOptions = { markets: MarketLookup }

/**
 * The order the route's venue calls go out in, as ring positions.
 *
 * Every call in a ring's route consumes one token and produces the one before it: the call at
 * position p spends the token position p+1 hands over and raises the token position p−1 needs.
 * So a call has to run after whatever funds it, and the dependency runs backwards round the
 * cycle.
 *
 * That is invisible while nothing is missing, because the settlement releases every leg before
 * the route runs and each call is funded by its own leg. It matters the moment a fallback has to
 * raise a token some other call then spends — which is exactly what the ring's own market leg
 * does, since that one runs unconditionally.
 *
 * So the walk starts at the position just after the market leg and goes backwards from there.
 * The market leg is then reached second: after the fallback that feeds it, and before the
 * fallback it feeds. Every other fallback follows in funding order. With no market leg the walk
 * starts at position 0, which is the same rule with `n−1` standing in — and with only one
 * fallback ever firing, the order does not matter at all.
 *
 * **No fixed order survives two lost legs in general**, and that is a property of the cycle
 * rather than a shortcoming here. The two legs either side of the walk's start depend on each
 * other in the direction the walk does not go. Losing both reverts, which is the right failure.
 *
 * @param n how many legs the ring has
 * @param market the position of the ring's own market leg, or null when every leg is an intent
 */
export function swapOrder(n: number, market: number | null): number[] {
  const start = ((market ?? n - 1) + 1) % n
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push((((start - i) % n) + n) % n)
  return out
}

/**
 * Choose a market for every intent leg of a ring and size it from live reserves.
 *
 * A market leg gets no fallback: it is a venue call already, and a venue does not fail to show
 * up. Everything else in the ring is somebody's signature, and every one of those can be spent,
 * cancelled or expired between this plan and the block that carries it.
 *
 * Two fallbacks can never name the same market, so nothing here checks for it: a market is bound
 * to a direction, and a simple cycle visits each token once, so no two legs run the same
 * direction on the same pair.
 *
 * A leg is refused with a reason rather than dropped. "No market lists this pair" and "the market
 * costs more than the leg frees" are different problems — the first is a discovery gap and the
 * second is the ring's own edge being real — and a solver that cannot tell them apart will keep
 * paying for the wrong fix.
 */
export function planTolerantRing(plan: Plan, opts: TolerantOptions): TolerantRing {
  const fallbacks: Fallback[] = []
  const refused: RefusedFallback[] = []
  let fill = 0

  for (let position = 0; position < plan.sized.legs.length; position++) {
    const sized = plan.sized.legs[position]
    if (sized.leg.kind !== 'intent') continue
    const here = fill
    fill++

    const market = opts.markets(sized.leg.receives, sized.leg.pays)
    if (!market) {
      refused.push({ fill: here, position, why: 'no market lists this direction' })
      continue
    }
    // What the market asks, at the reserves this plan was priced on. Null from a market that
    // cannot carry the amount at any size, and from one that cannot be priced locally at all.
    const quoted = market.amountIn(sized.take)
    if (quoted === null) {
      refused.push({ fill: here, position, why: `${market.id} cannot carry ${sized.take}` })
      continue
    }
    // The budget, and the reason the whole feature is safe: `pay` is what the missing maker was
    // going to be paid, so spending it costs the ring nothing it was not already spending. A
    // market asking more than that cannot clear the bound below, and a fallback that cannot
    // clear its bound reverts the ring at full price. Refuse it instead of clamping it.
    if (quoted > sized.pay) {
      refused.push({
        fill: here,
        position,
        why: `${market.id} asks ${quoted} and the leg frees only ${sized.pay}`,
      })
      continue
    }

    fallbacks.push({
      fill: here,
      position,
      market,
      // The leg's own supply. A zero here would let a moved pool close the ring at any price,
      // and the bound is the only reason a ring is ever allowed to revert.
      amountOutMin: sized.take,
      // The budget, in full. Spending less would leave the remainder to sweep home as dust in a
      // token nobody chose to hold, and spending it all is the largest margin a moved pool can
      // eat for free — the swap is exact-in, so more in can only mean more out.
      amountIn: sized.pay,
      quoted,
      // Guarded, because a market is an interface and not a curve: `poolAmountIn` never answers
      // zero, and the next venue behind this seam has not been written yet.
      headroomBps: quoted <= 0n ? 0 : Number(((sized.pay - quoted) * 10_000n) / quoted),
    })
  }

  return {
    ringId: plan.ring.id,
    fallbacks,
    refused,
    complete: refused.length === 0 && fallbacks.length === plan.fills.length,
    carriedGas: carriedFallbackGas(fallbacks.length),
  }
}

/**
 * One fallback as the executor's `Swap`: the reverse of the missing maker's trade, keyed to run
 * precisely when that maker is absent.
 *
 * Built through `marketRouteSwap` and not from a router address, because that is the one seam
 * where a market becomes calldata. A pair on one venue walks different reserves from the same
 * pair on another, so the venue that PRICED the fallback has to be the venue that fills it — and
 * re-deriving a router at the call site is the bug `routerFor` was.
 *
 * Null when the market can be priced but cannot build its own call yet. The caller then has a
 * fallback it cannot encode, which is a reason to leave the leg uncovered rather than to guess.
 */
export function fallbackSwap(
  fallback: Fallback,
  executorAddress: Address,
  deadline: bigint,
): RouteSwap | null {
  return marketRouteSwap(
    fallback.market,
    fallback.amountIn,
    fallback.amountOutMin,
    executorAddress,
    deadline,
    BigInt(fallback.fill) | WHEN_ABSENT,
  )
}

/**
 * Every fallback in a tolerant ring, in the order the route must carry them.
 *
 * `positionOfMarketSwap` is where the plan's own market leg sits, so the walk can put it between
 * the fallback that funds it and the fallback it funds. Pass null for a ring closed by intents
 * alone.
 *
 * The returned list is only the fallbacks; the caller splices its own market swap in at that
 * position. `routeFor` is the only caller and does exactly that.
 */
export function fallbackSwaps(
  tolerant: TolerantRing,
  legs: number,
  positionOfMarketSwap: number | null,
  executorAddress: Address,
  deadline: bigint,
): { swaps: RouteSwap[]; marketAt: number } {
  const byPosition = new Map(tolerant.fallbacks.map((f) => [f.position, f]))
  const swaps: RouteSwap[] = []
  let marketAt = 0
  for (const position of swapOrder(legs, positionOfMarketSwap)) {
    if (position === positionOfMarketSwap) {
      marketAt = swaps.length
      continue
    }
    const fallback = byPosition.get(position)
    if (!fallback) continue
    const swap = fallbackSwap(fallback, executorAddress, deadline)
    if (swap) swaps.push(swap)
  }
  return { swaps, marketAt }
}

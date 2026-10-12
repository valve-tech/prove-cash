/**
 * Several independent plans in one transaction, where losing one loses only that one.
 *
 * A ring is a cycle and stays atomic: a cycle minus a leg is not a cycle, so there is nothing to
 * settle and `skipInvalid` is false for it. That is not most of what a solver finds. The common
 * candidate is one maker's intent closed through a market — a single fill with a single swap that
 * stands entirely on its own — and today the bot sends each of those as its own transaction.
 *
 * Two things are wasted by that, and the second is the expensive one.
 *
 *   the base    A batched leg costs 86,994 gas and the same leg sent alone costs 148,754, so
 *               batching saves 60,408 a leg — the transaction the solver did not have to send.
 *               Eight singles cost 1,190,037 against 695,959 for one batch of the same eight,
 *               which is 76% more for the same fills.
 *
 *   the race    Two solvers reading one book overlap, and the loser pays for every leg it
 *               duplicated. On the tolerant path that is 15,982 a leg and the batch still fills
 *               the rest. Sent as singles, each lost race is a whole transaction that fills
 *               nothing.
 *
 * **What "independent" has to mean, and the lab had to say it twice.**
 *
 * One fill, first. `Swap.leg` names ONE leg, so the executor can drop a call when that leg goes.
 * It cannot express "drop this call if ANY of my three legs goes", which is what a multi-fill
 * plan would need: its swap is sized for the whole cycle, and a cycle missing a leg has a
 * different shape rather than a smaller one. So a plan with more than one fill is a ring and
 * keeps its own atomic transaction.
 *
 * And its own swap, second, which the first version of this file did not require and which the
 * lab refused within a minute. `ProveBatchExecutor` holds nothing between transactions. A leg
 * hands it token A and leaves it owing token B, so the only two ways that debt is ever paid are
 * a venue call or another leg's release. A plan with no swap is therefore relying on the other
 * legs — which is exactly what a cycle is, and exactly what cannot survive one of them being
 * stepped over.
 *
 * The trap is that a swapless plan looks independent by the first rule and is not. Two single-
 * fill plans, A for B and B for A, pay for each other perfectly; pack them, lose either one, and
 * the other is left unfunded. Netting is what an atomic ring is FOR, and asking for it here is
 * asking for the one thing this path cannot promise.
 *
 * So both rules together, and neither is a judgement about a plan — they are properties of it:
 * one fill, one swap of its own, one leg index. Every unit in the batch is then independent of
 * every other by construction, and there is nothing left for a dropped leg to break.
 */
import type { Address } from 'viem'
import type { Route, RouteSwap } from './abi.js'
import { marketRouteSwap } from './market.js'
import type { RingFill } from './abi.js'
import type { Plan } from './plan.js'

/** A batch of independent plans, ready for `settleBatchCall`. */
export type PackedBatch = {
  fills: readonly RingFill[]
  route: Route
  /** The highest of the packed plans' bounds, so no leg is stepped over for a fee it declared. */
  maxFeeRate: bigint
  /** The plans that went in, in the order their fills sit in `fills`. */
  packed: readonly Plan[]
  /** Plans handed in and left out, each with the reason. */
  refused: readonly { plan: Plan; why: string }[]
}

/**
 * True when this plan can share a tolerant transaction and be dropped on its own.
 *
 * One fill, so a single `Swap.leg` can speak for it, and its own swap, so nothing else in the
 * batch is paying its maker. See the header for why the second half is not optional.
 */
export function isIndependent(plan: Plan): boolean {
  return plan.fills.length === 1 && plan.swap !== null
}

export type PackOptions = {
  /** The `ProveBatchExecutor` the venue pays. Its own address, never the solver's wallet. */
  batchExecutor: Address
  deadline: bigint
  /** The most legs to pack. `MAX_BATCH_LEGS` is the policy; this lets a caller go smaller. */
  maxLegs?: number
  /**
   * Where the surplus goes once every maker is paid, or nothing to take it as it falls.
   *
   * Built by the caller rather than derived here, because only the caller knows which token it
   * wants to end the day holding, and because the amount is a guess this file cannot improve on:
   * the Dutch curve moves with the block and a leg may be stepped over, so the surplus is not
   * known until it exists. Ask for less than it and the remainder sweeps home; ask for more and
   * the frame catches it and everything sweeps home.
   */
  disposal?: readonly RouteSwap[]
}

/**
 * Pack independent plans into one tolerant batch.
 *
 * Order is the caller's ranking, best first, and it is kept: the leg index a swap names is the
 * position of its fill in the packed array, so nothing here may reorder.
 *
 * A plan is refused rather than dropped silently. A solver that cannot see why its best candidate
 * did not go out will send it as a single and never learn, and "it is a ring" and "an intent is
 * already spoken for" are different problems with different answers.
 */
export function packBatch(plans: readonly Plan[], opts: PackOptions): PackedBatch {
  const fills: RingFill[] = []
  const swaps: RouteSwap[] = []
  const sweep: Address[] = []
  const packed: Plan[] = []
  const refused: { plan: Plan; why: string }[] = []
  const cap = opts.maxLegs ?? 8

  // One maker's intent can appear in several plans, and two plans that both name it cannot both
  // settle: the first spends it and the second finds nothing left. `selectDisjoint` says the same
  // thing over a ranked list, and this repeats it because a caller can reach here without it.
  const spoken = new Set<string>()
  const seenToken = new Set<string>()
  const addToken = (t: Address) => {
    const k = t.toLowerCase()
    if (seenToken.has(k)) return
    seenToken.add(k)
    sweep.push(t)
  }

  for (const plan of plans) {
    if (plan.fills.length !== 1) {
      refused.push({ plan, why: 'a ring settles atomically and cannot share a tolerant batch' })
      continue
    }
    if (!plan.swap) {
      // Nothing here pays this maker. The executor holds nothing between transactions, so a leg
      // with no swap of its own is being paid by another leg's release — and a batch where legs
      // pay for each other is a cycle wearing the wrong clothes.
      refused.push({ plan, why: 'no swap of its own, so another leg would have to pay its maker' })
      continue
    }
    if (fills.length >= cap) {
      refused.push({ plan, why: `the batch is full at ${cap} legs` })
      continue
    }
    const fill = plan.fills[0]
    const key = `${fill.intent.maker}:${fill.intent.nonce}`.toLowerCase()
    if (spoken.has(key)) {
      refused.push({ plan, why: 'another plan in this batch already spends that intent' })
      continue
    }

    const leg = fills.length
    spoken.add(key)
    fills.push(fill)
    packed.push(plan)
    addToken(fill.intent.tokenIn)
    addToken(fill.intent.tokenOut)

    // Every packed plan has one, because a plan without one was refused above.
    // The point of the whole file is the leg index: this call exists because of this leg, so
    // when the leg is stepped over the executor steps over the call with it.
    const swap = marketRouteSwap(
      plan.swap.market,
      plan.swap.amountIn,
      plan.swap.amountOutMin,
      opts.batchExecutor,
      opts.deadline,
      BigInt(leg),
    )
    if (!swap) {
      refused.push({ plan, why: 'its market cannot build a swap yet, so nothing can pay its maker' })
      fills.pop()
      packed.pop()
      continue
    }
    swaps.push(swap)
    addToken(plan.swap.market.pays)
    addToken(plan.swap.market.receives)
  }

  return {
    fills,
    // `legs` is what the route expects, and the executor refuses a batch that settles MORE than
    // it. Fewer is the ordinary outcome here and the reason this exists.
    route: { legs: BigInt(fills.length), swaps, sweep, disposal: opts.disposal ?? [] },
    // The highest bound, not the lowest. The settlement reads each leg's own rate and steps over
    // a leg whose rate exceeds the bound, so packing to the smallest bound would silently drop
    // the dearest leg from every batch.
    maxFeeRate: packed.reduce((hi, p) => (p.maxFeeRate > hi ? p.maxFeeRate : hi), 0n),
    packed,
    refused,
  }
}

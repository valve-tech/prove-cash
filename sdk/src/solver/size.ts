import type { Address } from 'viem'
import { quote, ratesOf } from '../settlement.js'
import { legRate, type Leg, type Ring } from './rings.js'

/**
 * Sizing a ring, in exact integers.
 *
 * The contract rounds against the executor at every step: the gross rounds up, and a market
 * rounds its own input the same way — xyk's `getAmountIn` adds a wei on principle. A ring that
 * clears by a hair in rational arithmetic can therefore fail in integers, so the estimate and
 * the answer are two different computations. Rationals bound the free variable; the integer
 * chain decides; and the simulation, later, overrules them both.
 *
 * The protocol fee is not one of those steps any more. It comes out of the maker's gross rather
 * than riding on top of it, so it never enters what the executor pays and never moves a size.
 *
 * Every amount here is a bigint. Money never touches a float.
 */

/** Round up, exactly as the contract's `_ceilDiv` does. Zero over anything is zero. */
export const ceilDiv = (a: bigint, b: bigint): bigint => (a === 0n ? 0n : (a - 1n) / b + 1n)

/** One leg, sized. `take` is what the executor receives; `pay` is what it hands over. */
export type SizedLeg = {
  leg: Leg
  /** The amount of `leg.receives` the executor takes from this leg. */
  take: bigint
  /** For an intent leg, what the recipient receives once the fee is out. Zero for a market leg. */
  delivered: bigint
  /** For an intent leg, the part of `pay` that goes to the destination. Zero for a market leg. */
  fee: bigint
  /** The intent's gross, or the market's input amount: what the executor pays for `take`. */
  pay: bigint
}

/** A ring with every amount fixed, and the numbers an operator judges it by. */
export type SizedRing = {
  ring: Ring
  legs: readonly SizedLeg[]
  /** The amount the first leg hands the executor. Everything else follows from it. */
  entryTake: bigint
  /** `entryTake − pay` of the last leg, denominated in the first leg's `receives` token. */
  profit: bigint
  profitToken: Address
  /**
   * What the executor must already hold to get through the batch, by token.
   *
   * `fillBatch` settles in order and every leg pays before the next leg's receipt arrives, so
   * the executor fronts every payment but the last — that one is covered by the first leg's
   * receipt. Rotating the ring so the largest payment falls last is what makes this `Σ p − max p`.
   */
  capital: readonly { token: Address; amount: bigint }[]
}

/** Why a ring could not be sized. Useful in a log; never a reason to send anything. */
export type SizeFailure =
  | 'no-room' // some leg has nothing left to give
  | 'pinned-conflict' // two all-or-nothing legs disagree about the size
  | 'unprofitable' // the chain closes, but the last payment exceeds the first receipt
  | 'market-too-thin' // the market cannot cover the amount at any size
  | 'below-min-fill' // a maker's floor is above the size this ring can carry

/** Either a sized ring or the reason there is none. */
export type SizeResult = { ok: true; sized: SizedRing } | { ok: false; reason: SizeFailure }

/**
 * What the executor pays to take `take` from one leg.
 *
 * For an intent that is the gross alone, and the fee is not added to it. The settlement splits
 * the gross into the maker's half and the destination's half, so the two halves are already
 * inside this number — adding `fee` here would charge the executor for it twice.
 *
 * The intent branch is the contract's `_quote`, borrowed from the SDK rather than rewritten —
 * `contracts/test/Fixture.t.sol` pins that function to the Solidity implementation, and a second
 * copy here would only be a second thing to get wrong.
 */
export function legPay(leg: Leg, take: bigint, at: bigint): bigint | null {
  if (take <= 0n) return null
  if (leg.kind === 'intent') return quote(leg.entry.intent, take, at).owed
  return leg.market.amountIn(take)
}

/**
 * The take that leaves the executor holding at least `need` after the handover fee (P1).
 *
 * The next leg has to deliver what this one pays, and P1 keeps `feeIn` of whatever it takes, so
 * the take is grossed up: `ceil(need·W / (W − r1))`. The settlement floors the fee, so the usable
 * amount is `take − floor(take·r1/W) ≥ need`. Markets and zero-rate legs take `need` as is.
 */
function takeFor(leg: Leg, need: bigint): bigint {
  if (leg.kind !== 'intent') return need
  const r1 = ratesOf(leg.entry.intent).handover
  if (r1 <= 0n) return need
  const W = 10n ** 18n
  return r1 >= W ? 0n : ceilDiv(need * W, W - r1)
}

/** The most this leg can hand over. */
function legCap(leg: Leg): bigint {
  return leg.kind === 'intent' ? leg.entry.remaining : leg.market.cap()
}

/** The exact amount an all-or-nothing leg pins its take to, or null when the leg is free. */
function legPin(leg: Leg): bigint | null {
  return leg.kind === 'intent' && !leg.entry.partial ? leg.entry.remaining : null
}

/**
 * True when the settlement will accept this take against the leg's own floor.
 *
 * `_evaluate` refuses `take < minFill && take != remaining`. The second half is the carve-out
 * that keeps a floor from stranding the tail of an offer: closing it out is always legal, or a
 * floor of thirty on a hundred would leave the last ten unreachable from both sides — too small
 * for the floor, too large for nothing.
 *
 * Nothing here read `minFill` until now. It appeared in the SDK only in the generated ABI, so the
 * engine would happily size a take the chain then refused with `BelowMinFill` — a leg stepped
 * over in a batch, and a whole reverted transaction in a ring.
 */
function meetsFloor(leg: Leg, take: bigint): boolean {
  if (leg.kind !== 'intent') return true
  const floor = leg.entry.intent.minFill
  return floor <= 0n || take >= floor || take === leg.entry.remaining
}

/** The first leg whose take its maker's floor forbids, or -1 when every leg is content. */
function underFloor(ring: Ring, takes: readonly bigint[]): number {
  return ring.legs.findIndex((leg, k) => !meetsFloor(leg, takes[k]))
}

/** Walk the ring once at a given entry size. Null when a leg cannot carry the amount at all. */
function runChain(
  ring: Ring,
  entryTake: bigint,
  at: bigint,
): { takes: bigint[]; pays: bigint[] } | null {
  const takes: bigint[] = []
  const pays: bigint[] = []
  let take = entryTake
  for (const leg of ring.legs) {
    if (take <= 0n) return null
    const pay = legPay(leg, take, at)
    if (pay === null) return null
    takes.push(take)
    pays.push(pay)
    take = pay
    // The next leg's take is grossed up for its own handover fee, so what reaches the executor
    // is what this leg pays.
    const next = ring.legs[takes.length]
    if (next) take = takeFor(next, pay)
  }
  return { takes, pays }
}

/** True when every leg can carry the take the chain asks of it. */
function withinCaps(ring: Ring, takes: readonly bigint[]): boolean {
  for (let k = 0; k < ring.legs.length; k++) {
    if (takes[k] > legCap(ring.legs[k])) return false
    const pin = legPin(ring.legs[k])
    if (pin !== null && takes[k] !== pin) return false
  }
  return true
}

/**
 * A rational upper bound on the entry size.
 *
 * Walk the ring in fractions: `a_k ≈ a₁ · Π_{j<k} r_j`. Every integer step rounds up, so the
 * integer chain is never smaller than the rational one and this bound is never too low.
 *
 * **The walk carries no fee factor, because the executor pays none.** It used to multiply a
 * `(1 + φ_j)` in at every intent leg. The fee comes out of the maker's gross now, so the gross
 * is the whole payment and the rate cannot change the size of anything.
 */
function rationalCeiling(ring: Ring, at: bigint): bigint {
  let bound: bigint | null = null
  // The running factor from leg 1 to leg k, as num / den.
  let num = 1n
  let den = 1n

  for (let k = 0; k < ring.legs.length; k++) {
    const leg = ring.legs[k]
    if (num > 0n) {
      // a_k ≤ cap  ⟹  a₁ ≤ cap · den / num
      const limit = (legCap(leg) * den) / num
      if (bound === null || limit < bound) bound = limit
    }
    const rate = legRate(leg, at)
    if (!rate || rate.den <= 0n) return 0n
    num *= rate.num
    den *= rate.den
    // Keep the fraction from growing without bound over a three-leg walk.
    const g = gcd(num, den)
    if (g > 1n) {
      num /= g
      den /= g
    }
  }
  if (bound === null) return 0n
  // A handover fee (P1) is grossed up on the leg that charges it, and `legRate` books it on that
  // leg's own rate. The two differ by one position, so the walk above can come out a little low
  // when P1 is in the ring. The bound only has to be an upper bound — the search below bisects
  // down to the real boundary — so it is widened rather than made exact.
  const hasHandover = ring.legs.some((l) => l.kind === 'intent' && ratesOf(l.entry.intent).handover > 0n)
  return hasHandover ? bound * 2n + 1n : bound
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a
  let y = b < 0n ? -b : b
  while (y) [x, y] = [y, x % y]
  return x
}

/** The largest entry size in `[1, hi]` whose chain stays inside every cap. Zero when none does. */
function largestFeasible(ring: Ring, hi: bigint, at: bigint): bigint {
  const feasible = (a: bigint): boolean => {
    const chain = runChain(ring, a, at)
    return chain !== null && withinCaps(ring, chain.takes)
  }
  if (hi <= 0n) return 0n
  if (feasible(hi)) return hi
  let lo = 0n
  let high = hi
  // The chain is monotone in the entry size, so a bisection finds the boundary exactly.
  while (high - lo > 1n) {
    const mid = (lo + high) / 2n
    if (feasible(mid)) lo = mid
    else high = mid
  }
  return lo
}

/**
 * The largest entry size that drives leg `k` to exactly `target`, or zero when none does.
 *
 * An all-or-nothing leg pins its own take, and every other amount in the ring follows from it.
 * The chain is monotone but not strictly so — several entry sizes can land on the same take —
 * and the largest of them is the one to use, because the legs after `k` are already fixed and
 * the surplus is `a₁ − p_n`.
 */
function entryForPin(
  ring: Ring,
  k: number,
  target: bigint,
  hi: bigint,
  at: bigint,
): bigint {
  const takeAt = (a: bigint): bigint | null => {
    const chain = runChain(ring, a, at)
    return chain ? chain.takes[k] : null
  }
  if (hi <= 0n) return 0n
  // Bisect for the last entry size whose leg-k take is still at or below the target.
  let lo = 0n
  let high = hi + 1n
  while (high - lo > 1n) {
    const mid = (lo + high) / 2n
    const t = takeAt(mid)
    if (t !== null && t <= target) lo = mid
    else high = mid
  }
  return lo > 0n && takeAt(lo) === target ? lo : 0n
}

/**
 * Size a ring against what is left of every intent in it.
 *
 * The free variable is the first leg's take. Everything downstream is forced: each leg pays what
 * the contract says it must, and the next leg takes exactly that. The answer is the largest
 * entry size that keeps every leg inside its remaining amount — unless an all-or-nothing leg
 * pins it, in which case there is only one size to try and the other legs have to agree.
 */
export function sizeRing(ring: Ring, at: bigint): SizeResult {
  const ceiling = rationalCeiling(ring, at)
  if (ceiling <= 0n) return { ok: false, reason: 'no-room' }

  const pins: { k: number; target: bigint }[] = []
  for (let k = 0; k < ring.legs.length; k++) {
    const pin = legPin(ring.legs[k])
    if (pin !== null) pins.push({ k, target: pin })
  }

  let entryTake: bigint
  if (pins.length === 0) {
    entryTake = largestFeasible(ring, ceiling, at)
  } else {
    // One pin decides the whole ring. A second one has to land on the same number by accident,
    // which is why two all-or-nothing legs almost never match.
    entryTake = entryForPin(ring, pins[0].k, pins[0].target, ceiling, at)
    if (entryTake === 0n) return { ok: false, reason: pins[0].k === 0 ? 'no-room' : 'pinned-conflict' }
    const chain = runChain(ring, entryTake, at)
    if (!chain) return { ok: false, reason: 'no-room' }
    if (!withinCaps(ring, chain.takes)) {
      return { ok: false, reason: pins.length > 1 ? 'pinned-conflict' : 'no-room' }
    }
  }
  if (entryTake <= 0n) {
    const anyMarket = ring.legs.some((l) => l.kind === 'market')
    return { ok: false, reason: anyMarket ? 'market-too-thin' : 'no-room' }
  }

  let chain = runChain(ring, entryTake, at)
  if (!chain) return { ok: false, reason: 'no-room' }

  /*
   * A floor is a conditional pin, and it cannot go in `withinCaps`.
   *
   * `largestFeasible` bisects, and a bisection needs the predicate to be monotone: feasible at a
   * size means feasible at every smaller one. Caps have that shape. A floor is the opposite — it
   * makes SMALL takes infeasible while large ones are fine — so folding it into the same
   * predicate would leave the search returning a boundary that is not one.
   *
   * So the size is found on caps alone and the floors are read off the answer. A leg under its
   * floor has exactly one other size it can take, its own remainder, which is the carve-out
   * `meetsFloor` describes. That is the same shape as an all-or-nothing leg, so it takes the same
   * road: pin it and let the rest of the ring follow.
   *
   * One retry, not a search. Pinning one leg moves every other leg's take, which can put a second
   * leg under ITS floor, and chasing that is a fixed-point hunt for a case worth refusing: two
   * makers whose floors only agree at one size have almost certainly not made a trade.
   */
  const short = underFloor(ring, chain.takes)
  if (short >= 0) {
    const closeOut = ring.legs[short].kind === 'intent' ? legCap(ring.legs[short]) : 0n
    const retry = entryForPin(ring, short, closeOut, ceiling, at)
    const next = retry > 0n ? runChain(ring, retry, at) : null
    if (
      !next ||
      !withinCaps(ring, next.takes) ||
      underFloor(ring, next.takes) >= 0 ||
      pins.some((p) => next.takes[p.k] !== p.target)
    ) {
      return { ok: false, reason: 'below-min-fill' }
    }
    entryTake = retry
    chain = next
  }

  const legs: SizedLeg[] = ring.legs.map((leg, k) => {
    const take = chain.takes[k]
    if (leg.kind === 'intent') {
      const q = quote(leg.entry.intent, take, at)
      return { leg, take, delivered: q.delivered, fee: q.feeOut + q.feeProceeds, pay: q.owed }
    }
    return { leg, take, delivered: 0n, fee: 0n, pay: chain.pays[k] }
  })

  const closing = chain.pays[chain.pays.length - 1]
  // What the first leg hands the executor once its own handover fee is out.
  const first = ring.legs[0]
  const entryUsable = first.kind === 'intent' ? quote(first.entry.intent, entryTake, at).usable : entryTake
  const profit = entryUsable - closing
  if (profit <= 0n) return { ok: false, reason: 'unprofitable' }

  // Every payment but the last has to be in hand before the batch starts.
  const capital = new Map<string, { token: Address; amount: bigint }>()
  for (let k = 0; k < legs.length - 1; k++) {
    const token = legs[k].leg.pays
    const key = token.toLowerCase()
    const prev = capital.get(key)
    if (prev) prev.amount += legs[k].pay
    else capital.set(key, { token, amount: legs[k].pay })
  }

  return {
    ok: true,
    sized: {
      ring,
      legs,
      entryTake,
      profit,
      profitToken: ring.legs[0].receives,
      capital: [...capital.values()],
    },
  }
}

import type { Address } from 'viem'
import { PARKED_ARMING, spendsPermitNonce, walletDraw } from './arming.js'
import type { BookEntry } from './book.js'
import type { Plan } from './plan.js'

/**
 * Group fillability: why a set of legs is not the conjunction of its legs.
 *
 * The engine used to score legs one at a time and it cannot any more. Two things a maker owns
 * are shared across every intent they signed, and both of them are spent by the fill:
 *
 *   the balance   One maker with 100 tokens and two 100-token intents fills exactly one,
 *                 whichever the batch reaches first. Neither leg is unfillable; the pair is.
 *
 *   the permit    An EIP-2612 digest commits to `nonces[owner]`, and the token increments that
 *   nonce         on use. Two permit legs from one maker on one token are therefore strictly
 *                 ordered: drop the earlier one from a chosen subset and the later one's
 *                 signature no longer matches any nonce the token will ever hold. It is dead,
 *                 and it takes the ring holding it down with it.
 *
 *   the parked    `park` moves a dead offer's escrow into `_parked[maker][token]`, and that map
 *   pot           is one pool per maker per asset. Every leg armed with `ARM_FROM_PARKED` draws
 *                 on it, so two such legs of one maker on one token can together ask for more
 *                 than the row holds. `_drawFromParked` then moves nothing at all — it funds a
 *                 leg in full or not at all — and the fill that follows finds the reservation
 *                 short. A single fill reverts; a batch loses the leg and pays for the attempt.
 *
 * All three quantities are indexed by `(maker, tokenIn)` and nothing else. So two legs interact
 * if and only if they share that key, and legs in different partitions compose independently —
 * their individual results suffice.
 *
 * That is what makes the search affordable. See `bestSubset` for the arithmetic.
 */

/** The key two legs must share to interact at all: one maker's holding of one token. */
export const groupKey = (maker: Address | string, token: Address | string): string =>
  `${String(maker).toLowerCase()}:${String(token).toLowerCase()}`

/** One leg, reduced to what its group needs to know about it. */
export type GroupLeg = {
  /** The book's own key for the intent, so two legs of the same intent are one leg. */
  key: string
  maker: Address
  /** The maker's token, always `intent.tokenIn`. */
  token: Address
  /** What settling this leg takes out of the maker's shared balance. See `walletDraw`. */
  draw: bigint
  /**
   * What settling this leg takes out of the maker's parked row of the same token.
   *
   * A leg draws from one pool or the other and never from both, so this is zero on every leg
   * `draw` is not, and `draw` is zero on every leg this is not. Two budgets, summed apart.
   */
  parkedDraw: bigint
  /** True when settling it spends one of the maker's EIP-2612 nonces. */
  spendsPermit: boolean
  /**
   * The token nonce this leg's permit commits to, when a caller has resolved it.
   *
   * Undefined is not "no permit" — it is "the ordering is unknown", and the feasibility rule
   * treats it as such. `recoverPermitNonce` in `arming.ts` is what fills it in.
   */
  permitNonce?: bigint
}

/** The leg one book entry becomes, at the size a plan takes from it. */
export function legOf(entry: BookEntry, take: bigint): GroupLeg {
  const armed = !!entry.arming
  // The bytes say which escrow source this leg uses, and the two draw differently: a redemption
  // pulls `amountIn` out of the maker's wallet, the parked source moves money already inside the
  // settlement and touches the wallet not at all. One word is the whole difference.
  const fromParked = entry.arming === PARKED_ARMING
  return {
    key: entry.key,
    maker: entry.intent.maker,
    token: entry.intent.tokenIn,
    draw: walletDraw(entry.intent, take, armed, fromParked),
    // The take, because `_drawFromParked` moves `take - _reserved[h]` and the book cannot see
    // the reservation. The take is therefore the ceiling rather than the exact figure — and on
    // the leg this source exists for, an escrow signature its maker never funded, the
    // reservation is zero and the ceiling is the figure.
    parkedDraw: fromParked ? take : 0n,
    spendsPermit: spendsPermitNonce(entry.intent, armed),
    ...(entry.permitNonce === undefined ? {} : { permitNonce: entry.permitNonce }),
  }
}

/** The intent legs of a plan, at the sizes the plan takes. */
export function planLegs(plan: Plan): GroupLeg[] {
  const out: GroupLeg[] = []
  for (const sized of plan.sized.legs) {
    if (sized.leg.kind !== 'intent') continue
    out.push(legOf(sized.leg.entry, sized.take))
  }
  return out
}

/** Legs by `groupKey`. Legs in different partitions never constrain each other. */
export function partition(legs: readonly GroupLeg[]): Map<string, GroupLeg[]> {
  const out = new Map<string, GroupLeg[]>()
  for (const leg of legs) {
    const k = groupKey(leg.maker, leg.token)
    const list = out.get(k)
    if (list) list.push(leg)
    else out.set(k, [leg])
  }
  return out
}

/** What one maker's holding of one token can actually pay for. */
export type GroupLimits = {
  /**
   * The maker's spendable balance of the group's token. Undefined means nobody read it, and an
   * unread balance constrains nothing — `dryRun` is what catches the shortfall then.
   */
  balance?: bigint
  /**
   * The token's current `nonces(maker)`. Undefined means the run of permits only has to be
   * consecutive; known, it also has to start here.
   */
  permitNonce?: bigint
  /**
   * The maker's parked row of the group's token — `parked(maker, token)` on the settlement.
   * Undefined means nobody read it, and an unread row constrains nothing, exactly as the
   * balance above. `dryRun` is what catches the shortfall then.
   */
  parked?: bigint
}

/** Limits by `groupKey`. A key the map does not name is unconstrained. */
export type GroupBook = ReadonlyMap<string, GroupLimits>

/**
 * The limits a loaded book already knows: the shared balances and the parked rows `loadBook` read.
 *
 * The rows come off the entries rather than off a map of their own, because that is where
 * `loadBook` already put them — `readParked` asks the settlement once per `(maker, token)` and
 * hangs the answer on every entry of that group. So two entries of one group carry one number,
 * and an entry carrying nothing means nobody read the row.
 *
 * Nothing here invents a permit nonce. Recovering one costs a read of the token and a handful of
 * `ecrecover`s, so a bot that wants the permit queue ordered resolves the nonces itself with
 * `recoverPermitNonce` and adds them to the entries before it solves.
 */
export function groupsFromBook(book: {
  funds?: ReadonlyMap<string, bigint>
  entries?: readonly BookEntry[]
}): GroupBook {
  const out = new Map<string, GroupLimits>()
  for (const [key, balance] of book.funds ?? []) out.set(key, { balance })
  for (const entry of book.entries ?? []) {
    if (entry.parked === undefined) continue
    const key = groupKey(entry.intent.maker, entry.intent.tokenIn)
    const at = out.get(key)
    if (at) at.parked = entry.parked
    else out.set(key, { parked: entry.parked })
  }
  return out
}

/**
 * Whether these legs — all from one group — can settle together.
 *
 * Two rules, and both of them are about the maker rather than about any one intent:
 *
 * **The balance is a budget.** Every leg draws on it, and the sum has to fit. A leg that draws
 * nothing costs nothing, which is how a funded escrow leg sits beside a wallet leg without
 * competing for anything.
 *
 * **The parked row is a second budget, and the two never touch.** A leg armed from parked
 * capital calls no token, so it takes nothing out of the wallet; every other leg leaves the
 * parked row where it is. Summing them apart is what lets one maker fill a wallet leg and a
 * parked leg together on a balance that would not carry both.
 *
 * **The permits are a queue.** Sorted by the nonce each signature commits to, the chosen permit
 * legs must be consecutive integers, because the token increments by one on every `permit` it
 * honours and refuses a digest built for any other value. A gap is a signature nobody can
 * spend. When the token's own nonce is known the run must also start there — which is the rule
 * that refuses one leg on its own: a permit signed at nonce 8 is dead while the token sits at 7,
 * however fillable the intent behind it looks. Drop the leg holding nonce 7 from a chosen subset
 * and the leg holding 8 goes with it.
 *
 * When the token's own nonce is not known, a run starting anywhere is the best that can be said
 * and `dryRun` decides the rest.
 *
 * A permit leg whose nonce nobody resolved carries no ordering at all, so at most one of those
 * can be admitted: any second one is either the same nonce as the first or a different one, and
 * without the numbers there is no way to tell which.
 */
export function groupFeasible(legs: readonly GroupLeg[], limits: GroupLimits = {}): boolean {
  if (limits.balance !== undefined) {
    let drawn = 0n
    for (const leg of legs) drawn += leg.draw
    if (drawn > limits.balance) return false
  }

  if (limits.parked !== undefined) {
    let drawn = 0n
    for (const leg of legs) drawn += leg.parkedDraw
    if (drawn > limits.parked) return false
  }

  const permits = legs.filter((l) => l.spendsPermit)
  if (permits.length === 0) return true

  const known = permits.filter((l) => l.permitNonce !== undefined)
  if (known.length !== permits.length) return permits.length === 1

  const nonces = known.map((l) => l.permitNonce!).sort((a, b) => (a === b ? 0 : a < b ? -1 : 1))
  if (limits.permitNonce !== undefined && nonces[0] !== limits.permitNonce) return false
  for (let k = 1; k < nonces.length; k++) {
    if (nonces[k] !== nonces[k - 1] + 1n) return false
  }
  return true
}

/** Every group these legs touch is feasible against its own limits. */
export function legsFeasible(legs: readonly GroupLeg[], book: GroupBook = new Map()): boolean {
  for (const [key, group] of partition(legs)) {
    if (!groupFeasible(group, book.get(key) ?? {})) return false
  }
  return true
}

/**
 * The best-valued feasible subset of one partition's legs, by honest enumeration.
 *
 * **This is a 2^k search and it must stay one.** The instinct on reading that is to replace it
 * with something clever over the whole candidate set, and doing so would be a mistake worth
 * spelling out. Legs interact only through `(maker, tokenIn)`, so the search space is not 2^N
 * over the board — it is a sum of 2^k over the partitions, and k is the number of legs one maker
 * has on one token. In every book anybody has measured that is one, occasionally two, and a
 * maker who reaches five has posted an unusual day's worth of intents on a single token. A sum
 * of small powers is cheaper than any approximation, and unlike an approximation it is exact:
 * the permit queue, the shared balance and the parked row all have to be reasoned about jointly,
 * and a greedy walk over them drops rings that would have settled.
 *
 * A budget added to `groupFeasible` is a change to what this accepts and never to what it tries.
 * The parked row arrived that way, and the next shared quantity should too.
 *
 * Widening this to a global search would turn a handful of iterations into 2^N over the whole
 * board, for an answer that is already exact. Do not.
 *
 * `value` scores a leg. Ties go to the larger subset, so a group with nothing to choose between
 * keeps everything it can.
 */
export function bestSubset(
  legs: readonly GroupLeg[],
  value: (leg: GroupLeg) => bigint,
  limits: GroupLimits = {},
): GroupLeg[] {
  if (legs.length === 0) return []
  if (legs.length > 20) throw new Error(`A partition of ${legs.length} legs is not enumerable.`)

  let best: GroupLeg[] = []
  let bestScore = 0n
  for (let mask = 1; mask < 1 << legs.length; mask++) {
    const pick: GroupLeg[] = []
    let score = 0n
    for (let k = 0; k < legs.length; k++) {
      if (mask & (1 << k)) {
        pick.push(legs[k])
        score += value(legs[k])
      }
    }
    if (score < bestScore) continue
    if (score === bestScore && pick.length <= best.length) continue
    if (!groupFeasible(pick, limits)) continue
    best = pick
    bestScore = score
  }
  return best
}

// ── Choosing plans a group can actually pay for ───────────────────────────────

/** How hard to look when plans do contend for one maker's funds. */
export type SelectOptions = {
  /** Per-group limits, by `groupKey`. `loadBook` fills in the balances and the parked rows. */
  groups?: GroupBook
  /**
   * Plans in one contending component above this many fall back to the greedy walk.
   *
   * A component is the plans a contended partition ties together, and it is normally empty. The
   * cap is here so a pathological book — one maker holding half the board — cannot turn the
   * exact answer into an unbounded one.
   */
  maxEnumerate?: number
}

/** What a plan is worth to the selection, in one comparable unit. */
const scoreOf = (plan: Plan): bigint => plan.netNative ?? 0n

/**
 * Pick plans that can all settle.
 *
 * The old rule — a plan is kept unless an intent it needs is already promised — is still
 * necessary and is no longer sufficient. Two plans can name four different intents and still be
 * unable to settle together, because two of those intents are one maker's and there is only one
 * maker's balance behind them; or because both draw on one parked row that covers one of them;
 * or because both carry a permit and the ring that runs second signed its permit against a nonce
 * the first ring never advanced past.
 *
 * So: greedy over the ranking wherever nothing contends, which is almost everywhere, and an
 * exact enumeration over the plans a contended partition ties together. Those components are
 * tiny for the reason `bestSubset` gives.
 */
export function selectFeasible(plans: readonly Plan[], opts: SelectOptions = {}): Plan[] {
  const groups = opts.groups ?? new Map<string, GroupLimits>()
  const legsBy = plans.map(planLegs)

  // Which partitions hold legs from more than one plan. Only those can make a plan that is
  // individually fine unsettleable beside another, and normally there are none at all.
  const owners = new Map<string, Set<number>>()
  for (let p = 0; p < plans.length; p++) {
    for (const leg of legsBy[p]) {
      const k = groupKey(leg.maker, leg.token)
      const set = owners.get(k)
      if (set) set.add(p)
      else owners.set(k, new Set([p]))
    }
  }

  // Plans tied together by a contended partition, or by a shared intent, are one component.
  const parent = plans.map((_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (parent[root] !== root) root = parent[root]
    // Flatten the path behind us, so the next lookup over this component is one hop.
    let node = i
    while (parent[node] !== root) {
      const next = parent[node]
      parent[node] = root
      node = next
    }
    return root
  }
  const union = (a: number, b: number) => {
    const [x, y] = [find(a), find(b)]
    if (x !== y) parent[x] = y
  }
  for (const set of owners.values()) {
    if (set.size < 2) continue
    const members = [...set]
    for (let k = 1; k < members.length; k++) union(members[0], members[k])
  }
  const byIntent = new Map<string, number>()
  for (let p = 0; p < plans.length; p++) {
    for (const leg of legsBy[p]) {
      const first = byIntent.get(leg.key)
      if (first === undefined) byIntent.set(leg.key, p)
      else union(first, p)
    }
  }

  const components = new Map<number, number[]>()
  for (let p = 0; p < plans.length; p++) {
    const root = find(p)
    const list = components.get(root)
    if (list) list.push(p)
    else components.set(root, [p])
  }

  // A component of one is still asked. A plan whose only armed leg carries a permit signed
  // against a nonce the token has already moved past has nobody to contend with and still
  // cannot settle, and the group rules are where that is known.
  const kept: number[] = []
  for (const members of components.values()) {
    kept.push(...chooseComponent(members, legsBy, plans, groups, opts.maxEnumerate ?? 12))
  }
  return kept.sort((a, b) => a - b).map((i) => plans[i])
}

/** True when these plans name no intent twice and every group they touch stays feasible. */
function componentFeasible(
  members: readonly number[],
  legsBy: readonly GroupLeg[][],
  groups: GroupBook,
): boolean {
  const seen = new Set<string>()
  const legs: GroupLeg[] = []
  for (const p of members) {
    for (const leg of legsBy[p]) {
      if (seen.has(leg.key)) return false
      seen.add(leg.key)
      legs.push(leg)
    }
  }
  return legsFeasible(legs, groups)
}

/**
 * The best subset of one component, exactly when it is small enough and greedily when it is not.
 *
 * `plans` arrives ranked, so the greedy fallback is the old behaviour with the group test added,
 * and the enumeration's tie-break prefers the subset holding the earlier-ranked plan. Neither
 * path can return a set the group rules refuse.
 */
function chooseComponent(
  members: readonly number[],
  legsBy: readonly GroupLeg[][],
  plans: readonly Plan[],
  groups: GroupBook,
  maxEnumerate: number,
): number[] {
  if (members.length > maxEnumerate) {
    const kept: number[] = []
    for (const p of members) {
      if (componentFeasible([...kept, p], legsBy, groups)) kept.push(p)
    }
    return kept
  }

  let best: number[] = []
  let bestScore = 0n
  for (let mask = 1; mask < 1 << members.length; mask++) {
    const pick: number[] = []
    let score = 0n
    for (let k = 0; k < members.length; k++) {
      if (mask & (1 << k)) {
        pick.push(members[k])
        score += scoreOf(plans[members[k]])
      }
    }
    if (score < bestScore) continue
    // A tie goes to the larger set, then to the one holding the better-ranked plan.
    if (score === bestScore && best.length > 0) {
      if (pick.length < best.length) continue
      if (pick.length === best.length && pick[0] >= best[0]) continue
    }
    if (!componentFeasible(pick, legsBy, groups)) continue
    best = pick
    bestScore = score
  }
  return best
}

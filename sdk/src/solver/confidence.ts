/**
 * Which leg of an atomic batch is most likely to break it, and where that leg belongs.
 *
 * An atomic batch sends `skipInvalid = false`, because a cycle minus a leg is not a cycle. One
 * refused leg therefore reverts the transaction, and **what the revert costs depends only on
 * where that leg sits**. Measured in `contracts/test/Gas.t.sol`, the same eight legs losing the
 * same maker:
 *
 *     atomic 8, the FIRST leg gone      121,329 gas
 *     atomic 8, the LAST leg gone       554,731 gas
 *
 * 4.6x, for one difference. Everything before the failing leg is work the chain does and then
 * throws away. So a solver that puts its least certain leg first pays 121,329 for the break it
 * was going to pay 554,731 for, and the leg order costs nothing to choose.
 *
 * **The score is ordinal, not a probability.** Nothing here has measured how often a permit leg
 * fails against how often an allowance leg does, and a number dressed up as a probability would
 * claim it had. Every weight below is chosen so that one signal outranks another in the order
 * the evidence supports, and only the comparisons carry meaning. Each one says what it beats and
 * why.
 *
 * **The five signals, and where they come from.** Nothing here reads a chain.
 *
 *   custody    Where the maker's tokens are, and whether a signature must land before the fill
 *              can reach them. `FillRequest.arming` is the whole of the second half.
 *   reason     What the last `fillability` or `dryRun` read said about this leg.
 *   trust      `MakerTrust`, this solver's own record of who has wasted its gas.
 *   time       How long the leg has left, against this solver's own one-hour horizon.
 *   rival      Whether a pending transaction from somebody else already names this leg.
 *              `mempool.ts` reads it. The only signal here that is about another solver rather
 *              than about the maker, and the only one that can be a lie on purpose.
 *
 * ── Why the reorder is safe ───────────────────────────────────────────────────
 *
 * Four things in this system read a leg's position. Three of them constrain the reorder and one
 * of them forbids it outright.
 *
 * **The route's leg indices — rebuilt.** `Swap.leg` and `Payment.leg` are indices into the
 * request array, and `ProveBatchExecutor._wanted` matches one against the other to decide
 * whether a venue call still has a reason to run. Permuting the requests renumbers both. So
 * `reindexRoute` rewrites every `Swap.leg` to the new position of the same leg, `WHEN_ABSENT`
 * fallbacks included, and `orderAtomicLegs` never returns fills without the route that matches
 * them. `ANY_LEG` is checked before the `WHEN_ABSENT` bit, in the same order the contract checks
 * it.
 *
 * **The fee run — never broken.** `ProveSettlement._accrue` coalesces a fee into the open run
 * only while the token AND the destination both match, so two legs paying one destination in one
 * token pay one transfer when they are adjacent and two when they are not. A leg owing no fee
 * returns early and cannot break a run, which is most of a real board. `feeGroupOf` gives every
 * fee-paying leg a key, and legs sharing a key are moved as one block — so the reorder can only
 * reduce the number of transfers, never raise it.
 *
 * **The permit queue — kept in order.** An EIP-2612 digest commits to `nonces[owner]`, and the
 * token increments that on every permit it honours. Two permit legs from one maker on one token
 * are therefore strictly ordered, and swapping them leaves the second signature matching no
 * nonce the token will ever hold — see `groups.ts`. Such legs share a block too, and a block
 * keeps its own legs in the order they arrived.
 *
 * **The inventory path — not reordered at all, and this is the one that would have hurt.**
 * `fillBatch` releases and pays leg by leg, so a ring in cycle order fronts every payment but
 * the last, which is what `SizedRing.capital` counts. Permute those legs and the number changes:
 * reversing a cycle leaves exactly one payment to front rather than n − 1. A reorder there is
 * not free, it is a different capital requirement, so nothing here accepts a bare fill list.
 * `orderAtomicLegs` takes a `Route`, and only the credit path has one. On that path the
 * settlement releases every leg's token A before it pulls any payment — `fillBatchWithCallback`
 * runs `_creditLeg` over the whole array first — so no order fronts anything.
 *
 * **A tolerant batch is not reordered.** `skipInvalid = true` steps over a bad leg and fills the
 * rest, so the loss is one leg's gas wherever that leg sits and the ordering buys nothing.
 * `packBatch` also builds its route on the promise that a fill's position is its leg index.
 */
import { intentKey, isEscrow, isPermit2, type SignedIntent } from '../intent.js'
import { quote } from '../settlement.js'
import { ANY_LEG, WHEN_ABSENT, type FillReasonName, type RingFill, type Route } from './abi.js'
import { PARKED_ARMING, armingKind, armingWindow } from './arming.js'
import { groupKey } from './groups.js'
import type { MakerTrust } from './trust.js'

/**
 * What each signal is worth. The totals run 0 to 100 for a leg with no faults against it.
 *
 * Exported so an operator who has measured their own board can re-weight it, and so the tests
 * can move one weight at a time and see the order move with it.
 */
export type ConfidenceWeights = {
  /**
   * The tokens are reserved against this intent hash and nothing else can move them. The
   * reservation does not expire, so an escrowed offer rests indefinitely. The most certain thing
   * a solver can hold, and priced above every other signal's whole range.
   */
  fundedEscrow: number
  /**
   * The tokens sit in the maker's wallet under a standing allowance. Certain today and revocable
   * in the block before ours, and nothing on chain bounds how long such an intent may rest — so
   * an old one is exactly as trustworthy as the allowance behind it, which is to say unknowable
   * until the fill lands. Worth less than escrow by that gap and more than anything that still
   * needs a signature to land.
   */
  standingAllowance: number
  /**
   * An EIP-3009 authorization the solver must redeem first. The weakest of the funded rungs and
   * the strongest of the armable ones: a 3009 nonce is single-use, so only a sibling intent of
   * the same `amountIn` can burn it, and the redemption funds escrow rather than granting an
   * allowance somebody else can spend.
   */
  armedAuthorization: number
  /**
   * A Permit2 transfer the solver must spend first. Below an authorization because any solver
   * holding the same signature can spend the nonce, and above a permit because the nonce is
   * unordered and `loadBook` reads the bitmap when the caller names a Permit2.
   */
  armedPermit2: number
  /**
   * An EIP-2612 permit the solver must land first. The least certain rung there is, because the
   * nonce is ORDERED: any other permit of that maker on that token landing first kills this
   * signature, whoever sent it and whatever it was for.
   */
  armedPermit: number
  /**
   * A leg armed from the maker's parked row (`PARKED_ARMING`). The lowest named rung, and that
   * is the conservative reading of an open question (OQ-S8 in the solver spec), not a measured
   * one.
   *
   * No signature has to land, but three things make the row the least evidenced source here. The
   * book arms a leg when the row holds anything at all, not when it covers the take, because
   * `EscrowShort` never says by how much a reservation falls short. The row is shared by every
   * escrow offer that maker signed, so any solver can spend it on a sibling in the block before.
   * And the solver does not budget that contention yet (#135). So it scores below every rung a
   * signature backs, and above the zero that unnamed arming bytes get.
   */
  armedParked: number
  /** The chain says this leg fills today with no help from the solver. */
  reasonOk: number
  /**
   * The chain says `EscrowShort` and the solver believes its arming bytes answer that.
   *
   * The belief is the thing that goes wrong. `EscrowShort` is what an unfunded reservation, a
   * missing allowance, a taxed token and a spent nonce all look like, and only `dryRun` tells
   * them apart. Scored well below `Ok` for that reason.
   */
  reasonArmable: number
  /**
   * A leg of this maker's has settled for this solver. `trust.ts` argues the value: the proof is
   * free to earn honestly and costs real money to fake.
   */
  proven: number
  /** No fills and no faults. The ordinary state of a maker on a public board, and not a mark. */
  unproven: number
  /**
   * Taken off per unforgotten fault. Negative.
   *
   * Sized so two faults pull a proven maker below an unproven one and no further: `dropAfter` is
   * three, and `admits` has already refused the ring by then. It does not pull a funded leg
   * behind an armable one, which is deliberate — `trust.ts` forgives a fault because most of
   * them are lost races, and a lost race says nothing about whether a signature will redeem.
   */
  perFault: number
  /** A leg with a full horizon left. Nothing above the horizon scores more. */
  timeFull: number
  /**
   * The horizon a full time score is measured against, in seconds.
   *
   * An hour, and it is the solver's own number rather than a rule read off the chain. The
   * settlement bounds no window at all. Above an hour, more time buys nothing this solver can
   * measure — a leg that is good for a week and a leg good for an hour are equally safe to plan
   * around in the next block. Below it the score falls linearly, so a leg with thirty seconds
   * left scores almost nothing.
   */
  timeHorizon: bigint
  /**
   * Taken off a leg some other address has a pending transaction over. Negative, and dominant.
   *
   * **Sized to outrank every other signal put together, and the arithmetic is exact.** The best a
   * leg can score without this is 100 — a funded escrow (40), `Ok` (25), a proven maker (20) and
   * a full horizon (15). The worst it can score is −35: nothing for custody, nothing for the
   * reason, no time left, and a proven maker carrying the three faults `dropAfter` allows before
   * the ledger stops offering them at all (10 − 45). So a penalty below −135 puts the strongest
   * claimed leg under the weakest unclaimed one, always. This is −150, which leaves an operator
   * room to re-weight the other five without accidentally inverting the rule.
   *
   * Dominant because it is the only signal that predicts the expensive accident. The other four
   * say how likely a leg is to refuse the fill; this one says somebody else is about to take it,
   * and in an atomic batch that is 222,044 gas and no earnings. See `mempool.ts` for the
   * measurement, and for why believing a lying mempool is the cheap error.
   */
  rivalClaim: number
}

/** The weights the reasoning above derives. */
export const DEFAULT_CONFIDENCE: ConfidenceWeights = {
  fundedEscrow: 40,
  standingAllowance: 25,
  armedAuthorization: 12,
  armedPermit2: 10,
  armedPermit: 6,
  armedParked: 4,
  reasonOk: 25,
  reasonArmable: 8,
  proven: 20,
  unproven: 10,
  perFault: -15,
  timeFull: 15,
  timeHorizon: 3600n,
  rivalClaim: -150,
}

/** What the solver knows about a set of legs, beyond the legs themselves. */
export type ConfidenceInputs = {
  /**
   * The chain clock to score at, in seconds. Never `Date.now() / 1000`: the settlement reads
   * `block.timestamp`, and a wall clock running seconds ahead of it scores a live leg as dead.
   */
  at: bigint
  /** This solver's maker ledger. Omit it and every maker scores as unproven with no faults. */
  trust?: MakerTrust
  /**
   * A fill reason per leg, by `intentKey`. `dryRun` and `confirm` are where a fresh one comes
   * from, and a fresh one is worth having: it is recorded AFTER the leg is armed, so it answers
   * the question the arming bytes only claim to.
   *
   * Left out, the reason is derived from the leg itself — a leg carrying arming bytes is a leg
   * the book kept as `EscrowShort` and armable, and a leg carrying none is one the chain called
   * `Ok`. That derivation is exact for a leg `loadBook` built.
   */
  reasons?: ReadonlyMap<string, FillReasonName>
  /**
   * Legs another address already has a pending transaction over, by `intentKey`.
   *
   * `readRivalClaims` in `mempool.ts` builds it, and `claimedKeys` is the set. Omit it and no leg
   * carries the penalty — which is the honest default, because a solver that cannot see the pool
   * knows nothing about its rivals rather than knowing there are none.
   *
   * **This is where the reorder uses the signal, and it is not where the ring is refused.** By
   * the time a batch reaches `orderAtomicLegs` the ring is already built, so all this can do is
   * put the doomed leg first, where a break costs 121,329 instead of 554,731. Not building the
   * ring at all is worth far more, and that is `SolveParams.claimed` in `plan.ts`. Both take the
   * same set, and a caller that passes it to one should pass it to the other.
   */
  claimed?: ReadonlySet<string>
  weights?: Partial<ConfidenceWeights>
}

/** One leg's score, and the five numbers it is made of. */
export type Confidence = {
  /** The book's own key for the intent. */
  key: string
  /** The sum. Higher is more certain. */
  score: number
  custody: number
  reason: number
  trust: number
  time: number
  /** Zero, or `rivalClaim` when the mempool says somebody else is taking this leg. */
  rival: number
}

/**
 * Where this leg's money is, and what has to happen before the fill can reach it.
 *
 * The rung and the arming requirement are scored together and not apart, because they are one
 * fact read twice: `FillRequest.arming` is non-empty exactly when the rung has not delivered the
 * money yet. Scoring them as two signals would count the same evidence twice and let it outvote
 * everything else.
 */
function custodyPoints(fill: RingFill, w: ConfidenceWeights): number {
  if (!fill.arming) {
    // Nothing has to land first. Either the escrow is funded or the allowance is open.
    return isEscrow(fill.intent) || isPermit2(fill.intent) ? w.fundedEscrow : w.standingAllowance
  }
  // The parked word first, and read off the bytes. `armingKind` cannot see a parked leg without
  // the maker's row, and a `RingFill` does not carry the row. Asked without it, `armingKind`
  // answered `none`, and a parked leg fell to the floor below.
  if (fill.arming.toLowerCase() === PARKED_ARMING.toLowerCase()) return w.armedParked
  switch (armingKind(fill.intent)) {
    case 'authorization':
      return w.armedAuthorization
    case 'permit2':
      return w.armedPermit2
    case 'permit':
      return w.armedPermit
    default:
      // Arming bytes on an intent that carries no signature to build them from. Nothing here
      // can say what they are, so the leg scores at the floor and sorts first.
      return 0
  }
}

/** The reason this leg last came back with, from the caller's map or from the leg itself. */
export function reasonFor(
  fill: RingFill,
  reasons?: ReadonlyMap<string, FillReasonName>,
): FillReasonName {
  const fresh = reasons?.get(intentKey(fill.intent))
  if (fresh) return fresh
  return fill.arming ? 'EscrowShort' : 'Ok'
}

/** What that reason is worth. Every refusal but `EscrowShort` scores nothing at all. */
function reasonPoints(reason: FillReasonName, w: ConfidenceWeights): number {
  if (reason === 'Ok') return w.reasonOk
  if (reason === 'EscrowShort') return w.reasonArmable
  return 0
}

/** What this solver's ledger says about the maker. */
function trustPoints(
  intent: SignedIntent,
  at: bigint,
  w: ConfidenceWeights,
  trust?: MakerTrust,
): number {
  if (!trust) return w.unproven
  const base = trust.proven(intent.maker) ? w.proven : w.unproven
  return base + trust.faults(intent.maker, at) * w.perFault
}

/**
 * How much life the leg has left, scaled against the horizon.
 *
 * `armingWindow` is the number to use and not `endTime`, because an intent's window and its
 * funding signature's window are two windows and nothing on chain reconciles them. A leg whose
 * 3009 authorization expires in a minute is a one-minute leg however long the intent runs.
 *
 * A decaying intent needs no separate term. The price is a function of the clock alone and it
 * never rises, so a leg is never worth more later than it is now. Where the decay ends — the
 * close under kind 0, the end of the stretch under kind 1 — the price rests at the floor and the
 * deadline is the only thing still moving.
 */
function timePoints(intent: SignedIntent, at: bigint, w: ConfidenceWeights): number {
  const window = armingWindow(intent)
  // Not open yet, or already shut. Either way the leg cannot fill in this block.
  if (at < window.from || at > window.until) return 0
  const left = window.until - at
  if (left >= w.timeHorizon || w.timeHorizon <= 0n) return w.timeFull
  return Number((left * BigInt(w.timeFull)) / w.timeHorizon)
}

/** Score one leg. Pure, and it reads no chain. */
export function confidenceOf(fill: RingFill, opts: ConfidenceInputs): Confidence {
  const w = { ...DEFAULT_CONFIDENCE, ...opts.weights }
  const key = intentKey(fill.intent)
  const custody = custodyPoints(fill, w)
  const reason = reasonPoints(reasonFor(fill, opts.reasons), w)
  const trust = trustPoints(fill.intent, opts.at, w, opts.trust)
  const time = timePoints(fill.intent, opts.at, w)
  // The mempool's opinion, and the only term here that is about another solver. It may be wrong;
  // `mempool.ts` argues why a leg wrongly moved to the front costs less than one wrongly left at
  // the back.
  const rival = opts.claimed?.has(key) ? w.rivalClaim : 0
  return {
    key,
    score: custody + reason + trust + time + rival,
    custody,
    reason,
    trust,
    time,
    rival,
  }
}

// ── The two things that pin a leg to its neighbours ───────────────────────────

/**
 * The fee run this leg joins, or null when it owes no fee and cannot break one.
 *
 * `_accrue` keys on the token and the destination together, and returns early on a fee of zero.
 * So a leg that owes nothing is transparent: it can sit between two legs of one run without
 * costing a transfer. Only the fee-paying legs have to be kept together.
 */
export function feeGroupOf(fill: RingFill, at: bigint): string | null {
  // The contract's own `_quote`, so a rate that rounds to nothing on this take reads as nothing
  // here too. `ratesOf` already answers zero for an intent naming no fee config.
  if (quote(fill.intent, fill.take, at).fee === 0n) return null
  return `fee:${fill.intent.tokenOut.toLowerCase()}:${fill.intent.feeConfig.toLowerCase()}`
}

/**
 * The permit queue this leg joins, or null when settling it spends no EIP-2612 nonce.
 *
 * Only the 2612 rung, and only a leg the solver is actually arming. A permit2 nonce is
 * unordered, a 3009 nonce is single-use, and an allowance or a funded escrow spends no nonce at
 * all — none of those constrain the order. See `groups.ts` for the argument.
 */
export function permitGroupOf(fill: RingFill): string | null {
  if (!fill.arming) return null
  if (armingKind(fill.intent) !== 'permit') return null
  return `permit:${groupKey(fill.intent.maker, fill.intent.tokenIn)}`
}

/**
 * Legs tied to each other, as blocks that move together.
 *
 * A block is a maximal set of legs joined by a shared fee run or a shared permit queue. Its legs
 * stay adjacent and keep the order they arrived in, which is what preserves both rules at once:
 * adjacency is what the fee run needs, and the original order is what the permit queue needs.
 *
 * In an ordinary ring every block holds one leg, because a simple cycle pays each of its tokens
 * once and a maker rarely has two legs in one ring. Then the reorder is a plain sort.
 */
function blocksOf(fills: readonly RingFill[], at: bigint): number[][] {
  const owner = fills.map((_, i) => i)
  const find = (i: number): number => {
    let root = i
    while (owner[root] !== root) root = owner[root]
    let node = i
    while (owner[node] !== root) {
      const next = owner[node]
      owner[node] = root
      node = next
    }
    return root
  }
  const join = (a: number, b: number) => {
    const [x, y] = [find(a), find(b)]
    if (x !== y) owner[x] = y
  }

  const first = new Map<string, number>()
  for (let i = 0; i < fills.length; i++) {
    for (const key of [feeGroupOf(fills[i], at), permitGroupOf(fills[i])]) {
      if (key === null) continue
      const seen = first.get(key)
      if (seen === undefined) first.set(key, i)
      else join(seen, i)
    }
  }

  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < fills.length; i++) {
    const root = find(i)
    const list = byRoot.get(root)
    if (list) list.push(i)
    else byRoot.set(root, [i])
  }
  return [...byRoot.values()]
}

// ── The reorder ───────────────────────────────────────────────────────────────

/** An atomic batch, reordered, with the route that matches it. */
export type OrderedLegs = {
  fills: readonly RingFill[]
  route: Route
  /** `order[k]` is the position this leg held in the batch handed in. */
  order: readonly number[]
  /** Every leg's score, in the order they were handed in. */
  scores: readonly Confidence[]
}

/**
 * Rewrite a route's leg indices against a new leg order.
 *
 * `order[k]` says which old leg now sits at position k, so the map this needs is its inverse.
 * `ANY_LEG` is tested first and passed through, exactly as `ProveBatchExecutor._wanted` tests
 * it: masking `WHEN_ABSENT` off `ANY_LEG` leaves 2^255 − 1, an index naming no leg of any batch
 * a chain will ever carry. So the test is defensive rather than load-bearing, and it is here
 * because reading a rule the same way on both sides is one fewer thing to get wrong.
 *
 * An index naming no leg is left alone rather than guessed at. A route that points outside its
 * own batch is already wrong, and moving it somewhere plausible would hide that.
 */
export function reindexRoute(route: Route, order: readonly number[]): Route {
  const to = new Map<bigint, bigint>()
  for (let k = 0; k < order.length; k++) to.set(BigInt(order[k]), BigInt(k))

  const rewrite = (leg: bigint): bigint => {
    if (leg === ANY_LEG) return leg
    const absent = (leg & WHEN_ABSENT) !== 0n
    const moved = to.get(leg & ~WHEN_ABSENT)
    if (moved === undefined) return leg
    return absent ? moved | WHEN_ABSENT : moved
  }
  const swaps = route.swaps.map((s) => ({ ...s, leg: rewrite(s.leg) }))
  const disposal = route.disposal.map((s) => ({ ...s, leg: rewrite(s.leg) }))
  return { ...route, swaps, disposal }
}

/** How many fee transfers this order pays. One per unbroken run, exactly as `_accrue` counts. */
export function feeTransfers(fills: readonly RingFill[], at: bigint): number {
  let transfers = 0
  let open: string | null = null
  for (const fill of fills) {
    const group = feeGroupOf(fill, at)
    if (group === null) continue
    if (group !== open) transfers++
    open = group
  }
  return transfers
}

/** How an atomic batch is reordered, and whether it is reordered at all. */
export type OrderOptions = ConfidenceInputs & {
  /**
   * The `skipInvalid` this batch will be sent with. False is the only value that reorders.
   *
   * **A tolerant RING passes false here, and that is not a contradiction.** The question this
   * flag really asks is whether one refused leg can still revert the whole transaction. For a
   * set of independent plans it cannot, so the order buys nothing. For a ring carrying market
   * fallbacks it still can — on a leg that got no fallback, and on the second leg lost in one
   * block — so the cheap-break order is still worth what it costs, which is nothing.
   * `execute.ts` says so at the call site.
   *
   * A tolerant batch steps over a bad leg and fills the rest, so the loss is that leg's gas
   * wherever it sits and the ordering buys nothing. `packBatch` also builds its route on the
   * promise that a fill's position is its leg index, and says in its own header that nothing may
   * reorder it.
   */
  skipInvalid?: boolean
}

/**
 * Put the least certain leg of an atomic batch first, and rebuild the route to match.
 *
 * Blocks are sorted by their least certain member, so the block holding the weakest leg leads
 * whatever else it carries. A tie keeps the order the batch arrived in, which makes the answer
 * stable and keeps a ring in cycle order when nothing separates its legs.
 *
 * The route comes back rewritten against the new positions. Take both or neither: the fills and
 * the route are one argument in two halves, and a route built before the reorder names the wrong
 * legs.
 */
export function orderAtomicLegs(
  fills: readonly RingFill[],
  route: Route,
  opts: OrderOptions,
): OrderedLegs {
  const scores = fills.map((fill) => confidenceOf(fill, opts))
  const identity = fills.map((_, i) => i)
  if (opts.skipInvalid === true || fills.length < 2) {
    return { fills, route, order: identity, scores }
  }

  // Each block already holds its legs in the order they arrived, which is what the permit queue
  // needs — `blocksOf` walks the fills once, in order.
  const blocks = blocksOf(fills, opts.at)
  const weakest = (block: readonly number[]) =>
    block.reduce((low, i) => Math.min(low, scores[i].score), Number.POSITIVE_INFINITY)

  blocks.sort((a, b) => {
    const diff = weakest(a) - weakest(b)
    // A tie goes to the block that was already earlier, so the sort is stable and a ring whose
    // legs score alike keeps the cycle order `size.ts` gave it.
    return diff !== 0 ? diff : a[0] - b[0]
  })

  const order = blocks.flat()
  return {
    fills: order.map((i) => fills[i]),
    route: reindexRoute(route, order),
    order,
    scores,
  }
}

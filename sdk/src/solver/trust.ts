/**
 * Which makers this solver will risk its own gas on.
 *
 * A leg that passes `_evaluate` and then fails inside `armLeg` costs the solver 80,174 gas and
 * fills nothing — a generated row, `one more leg the maker unfunded`. The shape of it is the
 * whole reason this file exists: the waste is exactly linear in the number of such legs. One
 * wastes 80,174 gas over the batch that left it out and seven waste 534,723, and nothing about
 * carrying seven makes any one of them dearer.
 *
 * Linear damage means the only quantity that matters is how many bait legs get into a batch —
 * and without a rule, that number is chosen by the attacker. This picks it instead.
 *
 * **What a bait leg is.** An intent priced to be picked up, funded well enough to pass
 * evaluation, carrying an arming signature that will not redeem. It is not free to make: the
 * settlement reads a maker's funds before their signature, so the maker must hold real stock with
 * a real allowance open. And it does not survive the solver's simulation, so to land at all the
 * attacker has to let it simulate clean and then spend the nonce in a front-running transaction.
 * That costs them a transaction every time and burns the bait.
 *
 * **So why bother.** Because the attacker's transaction is spent once and the damage is not.
 * Every solver holding that leg in the same block loses their attempt to a single front-run, so
 * the leverage grows with the number of solvers competing — the competition itself pays for it.
 * A per-solver budget is what makes each solver's share of that bounded and known.
 *
 * **What this must never count.** A leg a rival solver settled first is not a failure and its
 * maker has done nothing wrong — they are, if anything, the most desirable maker on the book,
 * because a competitor wanted them too. Counting contention here would penalise exactly the
 * offers worth chasing, and it would do it quietly, because the ledger cannot see the difference
 * from the outside: both legs come back refused. That is why the only way in is `couldNotArm`,
 * named after the one thing it is allowed to mean. Losing a race costs 15,982 gas against 80,174
 * for a bait, and it is answered by better coordination, never by trusting a maker less.
 *
 * **Two rules, from one small ledger.**
 *
 *   the budget   How many legs from makers this solver has never settled with it will carry at
 *                once. Derived from a loss the operator names, divided by what a failure costs.
 *                A maker who has filled before does not count against it: that proof is free to
 *                earn honestly and costs real money to fake.
 *
 *   the drop     A maker whose legs keep failing, with no fill in between, stops being planned
 *                around at all. Then is forgiven, because one failure is usually a race — the
 *                state moved between the simulation and the block — and not an attack.
 *
 * **Rings are not batches, and the difference is large.** `fillBatch` with `skipInvalid` steps
 * over a bad leg and fills the rest, so one bait costs 80,174 and the batch still earns. A ring
 * is atomic — `skipInvalid` is false, because settling half a cycle leaves the solver holding an
 * unhedged position — so one bait costs the whole attempt. The budget below is for the tolerant
 * path. Give an atomic ring `maxUnprovenPerRing`, which is one.
 *
 * None of this is on chain and none of it needs to be. It is one solver's opinion about who has
 * wasted its gas, held locally, revocable in a config change, and wrong at worst about which
 * offers it declines to chase.
 */
import type { Address } from 'viem'
import type { FillReason } from '../settlement.js'
import { DEFAULT_GAS_MODEL, type GasModel, MAX_BATCH_LEGS } from './plan.js'
import type { Ring } from './rings.js'

/**
 * Is this maker at fault for a leg that was stepped over.
 *
 * A tolerant batch steps over a bad leg and fills the rest, and the receipt cannot say which kind
 * of bad it was: a leg a rival took first and a leg whose arming would never redeem produce the
 * same silence. Telling them apart wrongly is the one mistake this module must not make — a leg a
 * competitor wanted is the most desirable offer on the book, and counting it as a fault would
 * penalise exactly those, quietly.
 *
 * So the caller asks the chain again, after the block, and passes the answer here. `Ok` is the
 * only one that means the maker. The simulation said the leg was fillable before the block, the
 * block did not fill it, and the chain says it is fillable still — so nothing about this intent
 * moved, and the only thing left that can stop it filling is the arming.
 *
 * Every other reason is the book moving, and a maker owes nothing for any of it:
 *
 *   NothingToFill, TooMuch      somebody else took it, which makes them a good maker, not a bad one
 *   Cancelled, NonceTooLow      the maker withdrew, which is theirs to do and costs one skipped leg
 *   Expired, NotStarted         time passed between the simulation and the block
 *   EscrowShort                 the funds left. Careless, maybe; it is not the manufactured failure
 *                               this counter exists for, and `_armLeg` reads it as "not now"
 *   everything else             a refusal the solver caused — a fee bound, the wrong executor
 */
export const faultsMaker = (reason: FillReason): boolean => reason === 'Ok'

/** What one maker has done to this solver's gas. */
export type MakerRecord = {
  /** Legs of theirs that settled. One is enough to call a maker proven. */
  settled: number
  /** Legs of theirs that could not be armed, since their last fill. Never a lost race. */
  failed: number
  /** When the last of those was, in chain seconds. */
  lastFailAt: bigint
}

const EMPTY: MakerRecord = { settled: 0, failed: 0, lastFailAt: 0n }

export type TrustPolicy = {
  /** Seconds of quiet after which a maker's failures stop counting. */
  forgetAfter: bigint
  /** Unforgotten failures that drop a maker from planning entirely. */
  dropAfter: number
  /** Unproven legs one atomic ring may carry. One bad leg reverts the whole thing. */
  maxUnprovenPerRing: number
}

/**
 * Forgiving on purpose.
 *
 * An hour of quiet clears the slate, and it takes three failures to be dropped. A solver that
 * bans a maker for one failure bans most of the honest book: a leg can lose its race for reasons
 * nobody chose — the maker spent the balance elsewhere, another solver got there first, a permit
 * nonce moved. The budget is what bounds the loss meanwhile, so the drop rule does not have to be
 * quick to be safe.
 */
export const DEFAULT_TRUST: TrustPolicy = {
  forgetAfter: 3_600n,
  dropAfter: 3,
  maxUnprovenPerRing: 1,
}

const key = (maker: Address | string) => String(maker).toLowerCase()

/**
 * One solver's record of who has settled and who has wasted its gas.
 *
 * Mutable, because the thing it models is: a bot learns this over hours and has to keep it across
 * restarts. `toJSON` and `from` are that round trip.
 */
export class MakerTrust {
  readonly policy: TrustPolicy
  private readonly by = new Map<string, MakerRecord>()

  constructor(policy: Partial<TrustPolicy> = {}, records: Iterable<[string, MakerRecord]> = []) {
    this.policy = { ...DEFAULT_TRUST, ...policy }
    for (const [k, v] of records) this.by.set(key(k), v)
  }

  record(maker: Address | string): MakerRecord {
    return this.by.get(key(maker)) ?? EMPTY
  }

  /** A leg of theirs settled. This answers every doubt: the failure count goes back to zero. */
  settled(maker: Address | string, _at?: bigint): void {
    const r = this.record(maker)
    this.by.set(key(maker), { settled: r.settled + 1, failed: 0, lastFailAt: 0n })
  }

  /**
   * A leg of theirs passed evaluation and then could not be armed.
   *
   * **Only that.** Not a leg that expired, not one a rival took, not one whose maker had spent
   * the balance — those are the book moving, and the maker is not at fault for any of them. This
   * counter exists for the one failure a maker can manufacture: funds in reach, allowance open,
   * and an arming signature that will not redeem.
   *
   * Called both for a leg that reverted on chain and for one the simulation refused with that
   * reason. They do not cost the same — the second never reaches a block, so it wastes a call
   * and not a batch — but the planning conclusion is the same.
   */
  couldNotArm(maker: Address | string, at: bigint): void {
    const r = this.record(maker)
    const stale = r.lastFailAt !== 0n && at - r.lastFailAt > this.policy.forgetAfter
    this.by.set(key(maker), {
      settled: r.settled,
      failed: (stale ? 0 : r.failed) + 1,
      lastFailAt: at,
    })
  }

  /** Has any leg of theirs ever settled for this solver. */
  proven(maker: Address | string): boolean {
    return this.record(maker).settled > 0
  }

  /** Failures that still count. Quiet for `forgetAfter` and a maker starts again from zero. */
  faults(maker: Address | string, at: bigint): number {
    const r = this.record(maker)
    if (r.lastFailAt === 0n) return 0
    return at - r.lastFailAt > this.policy.forgetAfter ? 0 : r.failed
  }

  /** Too many recent failures. Plan nothing around this maker until they are forgotten. */
  dropped(maker: Address | string, at: bigint): boolean {
    return this.faults(maker, at) >= this.policy.dropAfter
  }

  /** Makers currently dropped, for a bot that wants to say so in a log line. */
  droppedNow(at: bigint): Address[] {
    return [...this.by.keys()].filter((k) => this.dropped(k, at)) as Address[]
  }

  toJSON(): Record<string, { settled: number; failed: number; lastFailAt: string }> {
    const out: Record<string, { settled: number; failed: number; lastFailAt: string }> = {}
    for (const [k, v] of this.by) {
      out[k] = { settled: v.settled, failed: v.failed, lastFailAt: v.lastFailAt.toString() }
    }
    return out
  }

  static from(json: unknown, policy: Partial<TrustPolicy> = {}): MakerTrust {
    const rows = (json ?? {}) as Record<
      string,
      { settled?: number; failed?: number; lastFailAt?: string | number }
    >
    const records: [string, MakerRecord][] = Object.entries(rows).map(([k, v]) => [
      k,
      {
        settled: Number(v.settled ?? 0),
        failed: Number(v.failed ?? 0),
        lastFailAt: BigInt(v.lastFailAt ?? 0),
      },
    ])
    return new MakerTrust(policy, records)
  }
}

/**
 * How many unproven legs a fault-tolerant batch may carry, given what the operator will lose.
 *
 * `maxGriefNative` is the answer to one question: what is the most this solver is willing to
 * spend, in one transaction, on legs that fill nothing? Divide it by what a failure costs and the
 * leg count falls out. That keeps the policy in the units an operator thinks in — a loss — rather
 * than a leg count somebody has to translate every time the gas price moves.
 *
 * A gas price of zero means failures are free, so the cap is the only limit.
 */
export function unprovenBudget(p: {
  maxGriefNative: bigint
  gasPrice: bigint
  gasModel?: GasModel
  /** The batch size to cap at. `MAX_BATCH_LEGS` by default. */
  legs?: number
}): number {
  const cap = p.legs ?? MAX_BATCH_LEGS
  const model = p.gasModel ?? DEFAULT_GAS_MODEL
  const perFault = model.perSkippedLeg ?? model.perIntentLeg
  if (p.gasPrice <= 0n || perFault <= 0n) return cap
  const affordable = p.maxGriefNative / (p.gasPrice * perFault)
  return Math.max(0, Math.min(cap, Number(affordable)))
}

/** The legs of a ring whose maker has never settled for this solver. Market legs have no maker. */
export function unprovenLegs(ring: Ring, trust: MakerTrust): Address[] {
  const out: Address[] = []
  for (const leg of ring.legs) {
    if (leg.kind !== 'intent') continue
    const maker = leg.entry.intent.maker
    if (!trust.proven(maker)) out.push(maker)
  }
  return out
}

/**
 * May this solver spend gas on this ring.
 *
 * Two ways to say no. A dropped maker is refused outright, however good the price looks — that is
 * the point of dropping one. And the unproven legs are counted against `limit`, which the caller
 * sets from the path it will send on: `unprovenBudget` for a tolerant batch, and
 * `maxUnprovenPerRing` for an atomic ring, where one bad leg costs the whole attempt rather than
 * one leg's worth of gas.
 *
 * Legs, not makers, because gas is charged per leg. Two legs from one unproven maker is two.
 */
export function admits(ring: Ring, trust: MakerTrust, at: bigint, limit: number): boolean {
  let unproven = 0
  for (const leg of ring.legs) {
    if (leg.kind !== 'intent') continue
    const maker = leg.entry.intent.maker
    if (trust.dropped(maker, at)) return false
    if (!trust.proven(maker)) unproven++
  }
  return unproven <= limit
}

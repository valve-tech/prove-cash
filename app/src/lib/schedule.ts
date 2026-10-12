import { SUGGESTED_WALLET_WINDOW_S, isDeadWindow, liveWindow } from '@prove.cash/sdk'

/**
 * When an offer opens, when its funding opens, and where the two agree.
 *
 * The chain has always taken a `startTime`. The form has never sent one: it wrote
 * `Date.now()` into every intent it signed, so every offer this app made opened the second it
 * was posted. This module is the arithmetic behind letting a maker move that.
 *
 * **Everything here counts seconds from now, not seconds since the epoch.** The browser's clock
 * runs ahead of `block.timestamp` and the contract already carries a second bound for exactly
 * that reason. An offset is the same number on both clocks, so nothing in this file can widen
 * that gap. The one place a wall clock is read stays where it was — the line in `Compose` that
 * turns the maker's offset into the `startTime` it signs.
 *
 * **The two windows are different windows.** The settlement enforces `startTime` and `endTime`.
 * The token enforces the authorization's `validAfter` and `validBefore`. Nothing on chain
 * compares them, `_termsOk` never reads the authorization, and every arming failure comes back
 * as `EscrowShort` — the same answer a spent nonce gives. So a maker can sign an offer that can
 * never fill and see nothing wrong with it. `planOf` is where that becomes visible.
 */

/** The lead times the form offers, as seconds from now. Zero is "now" and it is the default. */
export const LEADS = [0, 900, 3600, 21600, 86400] as const

/**
 * How far ahead this form lets an offer open before it argues.
 *
 * **Advice, and the maker may walk past it.** The settlement used to refuse a wallet window wider
 * than an hour, or one opening more than an hour ahead. It refuses neither now: a stale wallet
 * signature costs the maker who signed it and nobody else, so the choice was never the contract's
 * to make. What survives is the reason the rule existed, and this form is where a maker meets it.
 *
 * A wallet rung is armed by an ERC-20 allowance. Revoking that allowance makes the offer
 * unfillable and does not cancel it, so approving the same token again — months later, for
 * something else — brings every signature still inside its window back to life. `cancel` is the
 * only thing that truly ends one, and it costs gas per intent. Escrow, EIP-3009 and Permit2 each
 * carry a real off switch, so none of them needs the warning.
 */
export const suggestedLeadFor = (wallet: boolean): number =>
  wallet ? SUGGESTED_WALLET_WINDOW_S : Infinity

/** What the maker has chosen, in seconds from now. */
export type Draft = {
  /** When the offer opens. Zero is now. */
  lead: number
  /** How long it runs, from its own start. */
  duration: number
  /**
   * When the authorization opens, or null on a rung that signs none. Zero means the epoch, which
   * is what every offer this app signed before today carried.
   */
  authLead: number | null
}

/** The offer's schedule, resolved. Every field is seconds from now. */
export type Plan = {
  /** When the offer opens. */
  opensIn: number
  /** When it expires. */
  endsIn: number
  /** When the authorization opens, or null on a rung that signs none. */
  fundsIn: number | null
  /** The first second anybody can fill it — where the two windows agree. */
  liveIn: number
  /** How long it stays fillable. Zero means it never does. */
  liveFor: number
  /**
   * How long the offer decays before its funding opens.
   *
   * Not an error, and worth its own field. The offer is live, the price is falling, and no fill
   * can land — so the maker gives away the top of their own curve and gets nothing for it.
   */
  strandedFor: number
  /** True when the two windows never meet, so nothing can ever fill this offer. */
  dead: boolean
}

/**
 * Resolve a draft into the schedule it will actually have.
 *
 * `validBefore` is welded to `endTime` and this function assumes it. The weld is the answer to
 * the settlement's own note that "a maker who wants the two to agree has to make them agree": an
 * authorization that outlives the offer arms nothing, and one that dies first kills the offer
 * silently. Neither is a term worth offering, so only the opening end is the maker's to choose.
 *
 * The arithmetic is the SDK's `liveWindow`, fed offsets instead of timestamps. Interval maths
 * does not care where zero is, and reusing it means the sign form and the solver read the same
 * exclusive bound on a 3009 window rather than two copies that drift by a second.
 */
export function planOf({ lead, duration, authLead }: Draft): Plan {
  const opensIn = lead
  const endsIn = lead + duration
  const window = liveWindow(
    { startTime: BigInt(opensIn), endTime: BigInt(endsIn) },
    // The same weld `authWindowFor` makes at signing time: the bounds sit one second outside the
    // seconds they mean, because EIP-3009 is exclusive at both ends. Model it here or this plan
    // reports a two-second shave the maker will never experience.
    authLead === null
      ? undefined
      : { validAfter: BigInt(authLead) - 1n, validBefore: BigInt(endsIn) + 1n },
  )
  const dead = isDeadWindow(window)
  const liveIn = Number(window.from)
  return {
    opensIn,
    endsIn,
    fundsIn: authLead,
    liveIn,
    liveFor: dead ? 0 : Number(window.until) - liveIn,
    strandedFor: dead ? 0 : Math.max(0, liveIn - opensIn),
    dead,
  }
}

/**
 * Why this form refuses to sign, or null when it will.
 *
 *   `dead`   the authorization opens after the offer expires, so no second exists in both.
 *
 * One refusal, and it is the only one worth making. A `dead` offer cannot be caught anywhere
 * else: `_termsOk` never reads the authorization, so the chain accepts it, the board carries it,
 * and every fill attempt comes back with the reason a spent nonce gives. The sign form is the
 * last place it is visible, and the maker would otherwise wait out an offer that was never going
 * to fill.
 *
 * `ahead` used to live here, and it was a refusal only because the chain refused. It is advice
 * now — see `adviceOf`. A form that blocked a term the contract accepts would put back the rule
 * the contract just gave up.
 */
export type Fault = 'dead' | null

export function faultOf(plan: Plan): Fault {
  return plan.dead ? 'dead' : null
}

/**
 * What this form warns about but signs anyway, or null when it has nothing to say.
 *
 *   `zombie`  a wallet-rung offer reaching past the suggested window, in either direction.
 *
 * The maker is choosing to leave a signature standing that no allowance change can cancel. That
 * is theirs to choose and it is worth reading first, so this warns and the button stays live.
 * Never move their number to make the warning go away.
 */
export type Advice = 'zombie' | null

export function adviceOf(plan: Plan, wallet: boolean): Advice {
  if (!wallet) return null
  const suggested = suggestedLeadFor(wallet)
  return plan.opensIn > suggested || plan.endsIn - plan.opensIn > suggested ? 'zombie' : null
}

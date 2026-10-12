import { describe, expect, test } from 'vitest'
import { SUGGESTED_WALLET_WINDOW_S } from '@prove.cash/sdk'
import { adviceOf, faultOf, LEADS, planOf, suggestedLeadFor } from './schedule'

/**
 * The two clocks, and what the form is allowed to sign against them.
 *
 * The chain has always taken a `startTime`. The form always wrote "now" into it, so this file
 * covers something the app could not previously do at all: open an offer later than the moment
 * it is posted, and — on the gasless rung — fund it later still.
 *
 * The case worth the most is the last one. An authorization that opens after its offer expires
 * is an offer nobody can ever fill, `_termsOk` never reads the authorization so the chain takes
 * it, and every attempt comes back `EscrowShort` — which is also what a spent nonce says. The
 * settlement's own header calls the mismatch invisible from outside. These tests are the inside.
 */

const H = 3600
const M = 60

describe('the form as it opens', () => {
  test('the default is now, so nothing about an untouched form changed', () => {
    const plan = planOf({ lead: 0, duration: H, authLead: null })
    expect(plan.opensIn).toBe(0)
    expect(plan.endsIn).toBe(H)
    expect(plan.liveIn).toBe(0)
    expect(plan.dead).toBe(false)
    expect(plan.strandedFor).toBe(0)
  })

  test('and "now" is the first lead the chips offer', () => {
    expect(LEADS[0]).toBe(0)
  })
})

describe('a scheduled offer', () => {
  test('opens when it was asked to, and runs its own window from there', () => {
    const plan = planOf({ lead: 6 * H, duration: H, authLead: null })
    expect(plan.opensIn).toBe(6 * H)
    expect(plan.endsIn).toBe(7 * H)
    expect(plan.liveIn).toBe(6 * H)
    expect(plan.liveFor).toBe(H)
  })

  test('with no authorization, its own window is the whole of it', () => {
    const plan = planOf({ lead: 15 * M, duration: 24 * H, authLead: null })
    expect(plan.fundsIn).toBeNull()
    expect(plan.liveIn).toBe(plan.opensIn)
    expect(plan.liveFor).toBe(plan.endsIn - plan.opensIn)
  })
})

/**
 * The settlement bounds no window. It used to bound two — a wallet intent could run at most an
 * hour and open at most an hour ahead — and the rule went because the loss from a stale wallet
 * signature falls on the maker who signed it and on nobody else.
 *
 * So this is now the difference between a refusal and a warning, and the difference matters: a
 * form that blocked a term the chain accepts would put back the rule the chain just gave up.
 */
describe('what the form says about a long-resting wallet offer', () => {
  test('the suggestion on a wallet rung is an hour', () => {
    expect(suggestedLeadFor(true)).toBe(SUGGESTED_WALLET_WINDOW_S)
  })

  test('a custodied rung is not warned about at all', () => {
    expect(suggestedLeadFor(false)).toBe(Infinity)
  })

  test('every lead the form offers is signable, and only some are warned about', () => {
    const quiet = LEADS.filter((s) => s <= suggestedLeadFor(true))
    expect(quiet).toEqual([0, 900, 3600])
    expect(LEADS.length).toBeGreaterThan(quiet.length)
  })

  test('a start six hours out warns on a wallet rung and still signs', () => {
    const plan = planOf({ lead: 6 * H, duration: 900, authLead: null })
    expect(adviceOf(plan, true)).toBe('zombie')
    expect(faultOf(plan)).toBeNull()
  })

  test('the same start says nothing once a custodied rung carries it', () => {
    const plan = planOf({ lead: 6 * H, duration: 900, authLead: null })
    expect(adviceOf(plan, false)).toBeNull()
  })

  test('exactly an hour is quiet, and a second past it is not', () => {
    expect(adviceOf(planOf({ lead: SUGGESTED_WALLET_WINDOW_S, duration: 900, authLead: null }), true)).toBeNull()
    expect(adviceOf(planOf({ lead: SUGGESTED_WALLET_WINDOW_S + 1, duration: 900, authLead: null }), true)).toBe('zombie')
  })

  test('a long window warns as loudly as a distant start', () => {
    const plan = planOf({ lead: 0, duration: 3 * 24 * H, authLead: null })
    expect(adviceOf(plan, true)).toBe('zombie')
    expect(faultOf(plan)).toBeNull()
  })

  /**
   * The warning does not move the number, and nor did the refusal it replaced. A clamp hands the
   * maker a signature they did not read.
   */
  test('and warning leaves the maker’s own start where they put it', () => {
    const plan = planOf({ lead: 24 * H, duration: 900, authLead: null })
    expect(adviceOf(plan, true)).toBe('zombie')
    expect(plan.opensIn).toBe(24 * H)
  })
})

describe('the two windows, where they agree', () => {
  test('an authorization that opens with the offer costs nothing', () => {
    const plan = planOf({ lead: 6 * H, duration: H, authLead: 6 * H })
    expect(plan.strandedFor).toBe(0)
    expect(plan.dead).toBe(false)
    expect(faultOf(plan)).toBeNull()
  })

  /**
   * EIP-3009 is exclusive at both ends: the token requires `validAfter < now < validBefore`. A
   * bound set to the offer's own timestamp would cost it a second at each end, so `authWindowFor`
   * puts the bounds one second outside and this plan models the same weld. A maker never sees a
   * second they cannot account for.
   */
  test('and the exclusive bound costs the offer nothing', () => {
    const plain = planOf({ lead: 0, duration: H, authLead: null })
    const gasless = planOf({ lead: 0, duration: H, authLead: 0 })
    expect(gasless.liveIn).toBe(plain.liveIn)
    expect(gasless.liveFor).toBe(plain.liveFor)
  })

  test('an authorization that opens later strands the offer while it decays', () => {
    const plan = planOf({ lead: 0, duration: 6 * H, authLead: H })
    expect(plan.dead).toBe(false)
    expect(plan.strandedFor).toBe(H)
    expect(plan.liveIn).toBe(H)
    // Legal on chain, and the form still signs it. The maker loses the top of their own curve
    // and there is nothing to refuse — only something to say.
    expect(faultOf(plan)).toBeNull()
  })

  test('an authorization that opens after the offer expires can never fill', () => {
    const plan = planOf({ lead: 0, duration: 900, authLead: H })
    expect(plan.dead).toBe(true)
    expect(plan.liveFor).toBe(0)
    expect(faultOf(plan)).toBe('dead')
  })

  /**
   * The mismatch the settlement calls invisible. Nothing about the intent's own terms is wrong,
   * so a chain-side check of `startTime` and `endTime` passes every one of these.
   */
  test('and the intent’s own terms look perfectly healthy while it is dead', () => {
    const plan = planOf({ lead: 0, duration: 900, authLead: 24 * H })
    expect(plan.opensIn).toBeLessThan(plan.endsIn)
    expect(plan.endsIn - plan.opensIn).toBe(900)
    expect(plan.dead).toBe(true)
  })

  test('the same schedule without the gasless rung is a normal offer', () => {
    expect(planOf({ lead: 0, duration: 900, authLead: null }).dead).toBe(false)
  })

  /**
   * A dead window is a refusal and a long rest is a warning, and one does not mask the other.
   * They answer different questions: `dead` says nothing can ever fill this, `zombie` says this
   * will outlive the only off switch you were counting on.
   */
  test('a distant start on a wallet rung carries both, and each says its own thing', () => {
    const both = planOf({ lead: 24 * H, duration: 900, authLead: 25 * H })
    expect(faultOf(both)).toBe('dead')
    expect(adviceOf(both, true)).toBe('zombie')

    const wellFormed = planOf({ lead: 24 * H, duration: 900, authLead: 24 * H })
    expect(faultOf(wellFormed)).toBeNull()
    expect(adviceOf(wellFormed, true)).toBe('zombie')
  })
})

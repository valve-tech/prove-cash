import { describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import type { TokenInfo } from '@prove.cash/sdk'
import { parkedRows, parkedTokenSet, unfundedAndLive, type OfferState } from './parked.ts'

/**
 * What the Mine tab is allowed to tell a maker about money that belongs to no offer.
 *
 * Both halves of this file guard a sentence rather than a computation. One decides whether a
 * maker is shown capital the contract holds for them; the other decides whether they are offered
 * the only off switch an escrow offer has left. Getting either wrong is silent — the page renders
 * perfectly and says something untrue about somebody's money.
 */

const usdc: TokenInfo = {
  address: '0x1111111111111111111111111111111111111111',
  symbol: 'tUSDC',
  decimals: 6,
}
const wpls: TokenInfo = {
  address: '0x2222222222222222222222222222222222222222',
  symbol: 'WPLS',
  decimals: 18,
}

describe('which parked rows reach the screen', () => {
  test('a row with money in it is shown', () => {
    expect(parkedRows([usdc], [500_000n])).toEqual([{ token: usdc, amount: 500_000n }])
  })

  test('an empty row is not a line, because there is nothing to withdraw from it', () => {
    expect(parkedRows([usdc], [0n])).toEqual([])
  })

  test('a read that did not come back is not shown as empty', () => {
    // The one that matters. An endpoint having a bad minute must never render as "your money
    // left" on the page whose job is saying where a maker's money is.
    expect(parkedRows([usdc], [null])).toEqual([])
  })

  test('one bad read does not take the rows beside it down', () => {
    expect(parkedRows([usdc, wpls], [null, 7n])).toEqual([{ token: wpls, amount: 7n }])
  })

  test('the rows keep the order they were asked in', () => {
    // The amounts come back aligned with the tokens, so a shuffle here labels one maker's balance
    // with another token's symbol and decimals.
    expect(parkedRows([usdc, wpls], [1n, 2n]).map((r) => r.token.symbol)).toEqual([
      'tUSDC',
      'WPLS',
    ])
  })
})

describe('which tokens the tab asks the parked map about', () => {
  const a = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
  const b = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address
  const c = '0xcccccccccccccccccccccccccccccccccccccccc' as Address

  test('a token the chain names and this device does not is asked about', () => {
    // The whole of #134. The local half is the newest hundred records THIS browser holds, and a
    // maker's parked capital in any other token was money the page never drew.
    expect(parkedTokenSet([a], [b])).toEqual([a, b])
  })

  test('the local set alone still works when the logs name nothing', () => {
    expect(parkedTokenSet([a, b], [])).toEqual([a, b])
  })

  test('a failed log read adds nothing and takes nothing away', () => {
    // Null is "the query did not come back". Deleting a row on it would tell a maker their money
    // left, which is the rule `parkedRows` keeps one step later for the balance itself.
    expect(parkedTokenSet([a, b], null)).toEqual([a, b])
  })

  test('the same token spelled two ways is one token', () => {
    // A store writes an address in lower case; a decoded log topic comes back checksummed. A
    // naive union asks about it twice and draws the maker two rows for one balance.
    expect(parkedTokenSet([a], [a.toUpperCase() as Address])).toEqual([a])
  })

  test('the local spelling wins, because the offer rows are keyed on it', () => {
    const checksummed = ('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Address)
    expect(parkedTokenSet([a], [checksummed])).toEqual([a])
  })

  test('the local tokens come first, in the order they were given', () => {
    expect(parkedTokenSet([b, a], [c])).toEqual([b, a, c])
  })

  test('a token the logs name twice is asked about once', () => {
    // A maker parks the same token on three dead offers and the query returns three logs.
    expect(parkedTokenSet([], [c, c, c])).toEqual([c])
  })

  test('nothing anywhere is an empty list, not a crash', () => {
    expect(parkedTokenSet([], null)).toEqual([])
  })
})

describe('when an offer with nothing behind it still needs an off switch', () => {
  const offer = (over: Partial<OfferState> = {}): OfferState => ({
    custody: 'escrow',
    reservation: { amount: 0n },
    expired: false,
    cancelled: false,
    ...over,
  })

  test('a live escrow offer the maker never funded needs one', () => {
    // The property a maker lost. This used to be the safest row on the page — an escrow offer
    // nobody funded could never fill — and it is now an offer any solver can fund out of capital
    // freed from another of that maker's dead offers. See `AUDIT-SCOPE` 6.11.
    expect(unfundedAndLive(offer())).toBe(true)
  })

  test('so does an offer whose own 3009 signature would have funded it', () => {
    // `_redeemInto` takes the one word `ARM_FROM_PARKED` for an `auth` intent as readily as for a
    // bare escrow one. The contract draws no line here, so neither does the button.
    expect(unfundedAndLive(offer({ custody: 'auth' }))).toBe(true)
  })

  test('an expired offer does not, because nothing can fill it', () => {
    expect(unfundedAndLive(offer({ expired: true }))).toBe(false)
  })

  test('an offer the maker already called off does not', () => {
    // Otherwise the page offers a cancel that reverts, and charges a maker a rejected simulation
    // for reading their own screen.
    expect(unfundedAndLive(offer({ cancelled: true }))).toBe(false)
  })

  test('a funded offer does not, because withdraw is its way out and it returns the money', () => {
    expect(unfundedAndLive(offer({ reservation: { amount: 1n } }))).toBe(false)
  })

  test('an unread reservation is not an unfunded one', () => {
    // Null is "the chain did not answer", not "the chain said zero". Cancelling on a guess ends
    // an offer whose money is still inside it — recoverable, and the wrong button.
    expect(unfundedAndLive(offer({ reservation: null }))).toBe(false)
  })

  test('a wallet offer is never this case', () => {
    // Nothing is ever deposited against one, so "unfunded" says nothing about it. Its off switch
    // is a cancel and the page has always offered one.
    expect(unfundedAndLive(offer({ custody: 'wallet' }))).toBe(false)
  })
})

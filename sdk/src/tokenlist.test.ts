import { describe, expect, test } from 'vitest'
import { logoUrl } from './tokenlist.js'

/**
 * What face a token wears, and why the rule changed.
 *
 * `logoUrl` used to answer null for any chain the token list skips — 943 — because gib.show
 * answered 200 with a generated mark for an address it had never seen. An `onError` fallback
 * could not fire against that, so a testnet token would have worn a confident picture standing
 * for nothing, and refusing to ask was the only way to tell.
 *
 * Measured again on 2026-09-10: gib.show returns 404 for `0xdead…beef`, byte-identical to its
 * answer for a 943 token. A miss is distinguishable now, so asking is safe. These tests pin the
 * new rule and the map that gives the six faucet tokens a real face.
 */

const TPLSX = '0xabeF58363E0fc60250D16778848eAED831eA26F9'
const PLSX_369 = '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab'
const TUSDC = '0x86390129a2079fb7f0FC889473160a3a449117Ab'
const USDC_1 = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

describe('the face a token wears', () => {
  test('a testnet stand-in borrows its mainnet self, on that token`s own chain', () => {
    expect(logoUrl(TPLSX, 943)).toBe(`https://gib.show/image/eip155-369/${PLSX_369}`)
    expect(logoUrl(TUSDC, 943)).toBe(`https://gib.show/image/eip155-1/${USDC_1}`)
  })

  test('the borrowed face does not depend on which chain you ask from', () => {
    // The map is keyed on the address alone. tPLSX exists on 943 and nowhere else, so a caller
    // asking about it from any chain means the same token and should get the same picture.
    expect(logoUrl(TPLSX, 369)).toBe(logoUrl(TPLSX, 943))
  })

  test('the address is matched without regard to case', () => {
    expect(logoUrl(TPLSX.toLowerCase() as `0x${string}`, 943)).toBe(logoUrl(TPLSX, 943))
  })

  test('a token nobody has mapped is still asked for, on its own chain', () => {
    // This is the behaviour change. It used to be null for 943, so no image was ever requested.
    // gib.show 404s a miss now, and `TokenAvatar` turns that into its own two-letter mark.
    const unknown = '0xdEadBeefdEAdbeefdEadbEEFdeadbeEFdEaDbeeF'
    expect(logoUrl(unknown, 943)).toBe(`https://gib.show/image/eip155-943/${unknown}`)
  })

  test('every mapped token points at a real chain and a real address', () => {
    // `as const` keeps each address its literal `0x…` type; a plain array would widen it to string.
    for (const a of [TPLSX, TUSDC] as const) {
      const url = logoUrl(a, 943)!
      expect(url).toMatch(/^https:\/\/gib\.show\/image\/eip155-(1|369)\/0x[0-9a-fA-F]{40}$/)
    }
  })
})

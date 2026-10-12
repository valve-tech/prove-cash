import { describe, expect, test } from 'vitest'
import { DEFAULT_CHAIN } from '@prove.cash/sdk'
import type { Address } from 'viem'
import { defaultRoute, formatRoute, parseRoute, routeLink, type Route } from './routes.ts'

/**
 * The fragment is the only copy of the view, so the parser is the thing that decides whether a
 * shared link still works. Every case below is one somebody will paste: a link from the app, a
 * link with a filter hand-edited, a link to a chain this build does not carry.
 */

const ADDR = '0x1111111111111111111111111111111111111111' as Address
const IN = '0xa1077a294dde1b09bb078844df40758a5d0f9a27'
const OUT = '0x95b303987a60c71504d99aa1b13b4da07b0790ab'

const route = (patch: Partial<Route> = {}): Route => ({ ...defaultRoute(DEFAULT_CHAIN), ...patch })

describe('the fragment grammar', () => {
  test.each([
    ['the plain board', route()],
    ['every filter at once', route({ scope: 'all', sort: 'size', token: IN as Address, dir: 'into', profitableOnly: true })],
    ['a token on either side', route({ token: OUT as Address })],
    ['a token, out of', route({ token: IN as Address, dir: 'out' })],
    ['one filter', route({ sort: 'expiry' })],
    ['the sign view', route({ view: 'sign' })],
    ['the mine view', route({ view: 'mine' })],
    ['a cleanup link', route({ view: 'cleanup', address: ADDR })],
  ])('%s survives the round trip', (_name, r) => {
    expect(parseRoute(formatRoute(r))).toEqual(r)
  })

  test('a default is left out of the fragment', () => {
    expect(formatRoute(route())).toBe(`#/${DEFAULT_CHAIN}/board`)
    expect(formatRoute(route({ view: 'sign' }))).toBe(`#/${DEFAULT_CHAIN}/sign`)
  })

  test('only the filters that moved appear', () => {
    expect(formatRoute(route({ scope: 'all', profitableOnly: true }))).toBe(
      `#/${DEFAULT_CHAIN}/board?scope=all&profitable=1`,
    )
  })

  test('the token sits beside the sort, and either side is the default and is left out', () => {
    expect(formatRoute(route({ sort: 'size', token: IN as Address, dir: 'into' }))).toBe(
      `#/${DEFAULT_CHAIN}/board?sort=size&token=${IN}&dir=into`,
    )
    expect(formatRoute(route({ token: IN as Address, dir: 'either' }))).toBe(
      `#/${DEFAULT_CHAIN}/board?token=${IN}`,
    )
  })

  test('a direction with no token is not written, because it filters nothing', () => {
    expect(formatRoute(route({ dir: 'into' }))).toBe(`#/${DEFAULT_CHAIN}/board`)
  })

  test('the link carries the origin and the dapp path', () => {
    expect(routeLink('https://prove.cash', route({ view: 'cleanup', address: ADDR }))).toBe(
      `https://prove.cash/app#/${DEFAULT_CHAIN}/cleanup/${ADDR}`,
    )
  })

  test('a checksummed address lands as one link, not two', () => {
    const mixed = '0xAbC1111111111111111111111111111111111111' as Address
    const lower = mixed.toLowerCase() as Address
    expect(formatRoute(route({ view: 'cleanup', address: mixed }))).toBe(
      formatRoute(route({ view: 'cleanup', address: lower })),
    )
    expect(parseRoute(`#/${DEFAULT_CHAIN}/cleanup/${mixed}`)?.address).toBe(lower)
  })

  test('a trailing slash still names the view', () => {
    expect(parseRoute(`#/${DEFAULT_CHAIN}/board/`)).toEqual(route())
  })

  test('a cleanup route with no subject reads as the board', () => {
    expect(formatRoute(route({ view: 'cleanup' }))).toBe(`#/${DEFAULT_CHAIN}/board`)
  })

  test.each([
    ['nothing', ''],
    ['a bare hash', '#'],
    ['a hash and a slash', '#/'],
    ['a plain page anchor', '#main'],
    ['no leading slash', `#${DEFAULT_CHAIN}/board`],
    ['a chain and no view', `#/${DEFAULT_CHAIN}`],
    ['an unregistered chain', '#/1/board'],
    ['a chain that is not a number', '#/0x3af/board'],
    ['a view nobody built', `#/${DEFAULT_CHAIN}/trade`],
    ['a deeper view', `#/${DEFAULT_CHAIN}/board/extra`],
    ['cleanup with no address', `#/${DEFAULT_CHAIN}/cleanup`],
    ['an address one character short', `#/${DEFAULT_CHAIN}/cleanup/0x111111111111111111111111111111111111111`],
    ['an address with no 0x', `#/${DEFAULT_CHAIN}/cleanup/1111111111111111111111111111111111111111`],
    ['a name instead of an address', `#/${DEFAULT_CHAIN}/cleanup/maker.eth`],
    ['a deeper cleanup path', `#/${DEFAULT_CHAIN}/cleanup/${ADDR}/withdraw`],
  ])('rejects %s', (_name, hash) => {
    expect(parseRoute(hash)).toBeNull()
  })

  /**
   * A bad filter is not a bad link. The view still exists, so the reader keeps it and the knob
   * takes its default — rejecting the whole fragment would throw away the chain and the view too.
   */
  test.each([
    ['a sort nobody built', `#/${DEFAULT_CHAIN}/board?sort=cheapest`, route()],
    ['a scope nobody built', `#/${DEFAULT_CHAIN}/board?scope=everything`, route()],
    ['an old pair link, from before the token filter', `#/${DEFAULT_CHAIN}/board?pair=${IN}_${OUT}`, route()],
    ['a symbol instead of an address', `#/${DEFAULT_CHAIN}/board?token=tPLSX&dir=into`, route()],
    ['an address one character short', `#/${DEFAULT_CHAIN}/board?token=${IN.slice(0, -1)}`, route()],
    ['an address with no 0x', `#/${DEFAULT_CHAIN}/board?token=${IN.slice(2)}`, route()],
    ['a direction nobody built', `#/${DEFAULT_CHAIN}/board?token=${IN}&dir=buy`, route({ token: IN as Address })],
    ['a direction with no token', `#/${DEFAULT_CHAIN}/board?dir=into`, route()],
    ['the toggle spelled another way', `#/${DEFAULT_CHAIN}/board?profitable=true`, route()],
    ['one bad filter beside a good one', `#/${DEFAULT_CHAIN}/board?sort=cheapest&scope=all`, route({ scope: 'all' })],
  ])('falls back on %s', (_name, hash, expected) => {
    expect(parseRoute(hash)).toEqual(expected)
  })

  test('a valid token link names the token and its side', () => {
    expect(parseRoute(`#/${DEFAULT_CHAIN}/board?sort=size&token=${IN}&dir=into`)).toEqual(
      route({ sort: 'size', token: IN as Address, dir: 'into' }),
    )
  })

  test('an upper case token matches the store, which is lower case', () => {
    const shouted = `0x${IN.slice(2).toUpperCase()}`
    expect(parseRoute(`#/${DEFAULT_CHAIN}/board?token=${shouted}`)?.token).toBe(IN)
  })

  /**
   * The parser cannot know which tokens exist, so a well-formed address nobody has heard of
   * survives the parse. `keepToken` drops it once the board has answered; see its tests.
   */
  test('an unknown but well-formed address survives the parse', () => {
    const nobody = '0x000000000000000000000000000000000000dead'
    expect(parseRoute(`#/${DEFAULT_CHAIN}/board?token=${nobody}`)?.token).toBe(nobody)
  })

  test('filters off the board are dropped, not obeyed', () => {
    expect(parseRoute(`#/${DEFAULT_CHAIN}/sign?sort=size&profitable=1`)).toEqual(route({ view: 'sign' }))
  })

  /**
   * The one parameter Sign takes. The landing page reads a visitor's history off the appearance
   * index and links them straight into the form holding a token they have actually used, so this
   * link is the whole of that hand-off — if it drops the token, the visitor lands on the blank
   * form the hint existed to skip.
   */
  describe('the token Sign opens with', () => {
    test('survives a round trip', () => {
      const signed = route({ view: 'sign', give: IN as Address })
      expect(parseRoute(formatRoute(signed))).toEqual(signed)
    })

    test('is spelled lower case, so one token is one link', () => {
      const shouted = `0x${IN.slice(2).toUpperCase()}`
      expect(parseRoute(`#/${DEFAULT_CHAIN}/sign?give=${shouted}`)?.give).toBe(IN)
    })

    test('is left out of the fragment when the form takes its own default', () => {
      expect(formatRoute(route({ view: 'sign' }))).toBe(`#/${DEFAULT_CHAIN}/sign`)
    })

    test('a token that is not an address leaves the view standing', () => {
      expect(parseRoute(`#/${DEFAULT_CHAIN}/sign?give=wpls`)).toEqual(route({ view: 'sign' }))
    })

    test('the board does not answer to it, and Sign does not answer to the board', () => {
      expect(parseRoute(`#/${DEFAULT_CHAIN}/board?give=${IN}`)?.give).toBeNull()
      expect(formatRoute(route({ view: 'board', give: IN as Address }))).toBe(
        `#/${DEFAULT_CHAIN}/board`,
      )
    })
  })
})

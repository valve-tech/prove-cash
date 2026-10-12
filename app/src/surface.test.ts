import { describe, expect, test } from 'vitest'
import { isApp, legacyCleanupRedirect, localeHref } from './surface.ts'

/**
 * Old cleanup links are already in chat windows, so the rewrite is the only thing standing
 * between a reader and a board they did not ask for. Every path below is one somebody will
 * paste, mangled the way a chat window mangles them.
 */

const ADDR = '0x1111111111111111111111111111111111111111'

describe('the two surfaces', () => {
  test.each([
    ['/app', true],
    ['/app/cleanup/943/x', true],
    ['/', false],
    ['/apple', false],
  ])('%s mounts the dapp: %s', (path, mounted) => {
    expect(isApp(path)).toBe(mounted)
  })
})

describe('the old cleanup path', () => {
  test('an old link lands on the same view it always named', () => {
    expect(legacyCleanupRedirect(`/app/cleanup/943/${ADDR}`)).toBe(`/app#/943/cleanup/${ADDR}`)
  })

  test('a trailing slash still names the maker', () => {
    expect(legacyCleanupRedirect(`/app/cleanup/943/${ADDR}/`)).toBe(`/app#/943/cleanup/${ADDR}`)
  })

  test('a checksummed address lands lower case, so one wallet is one link', () => {
    const mixed = '0xAbC1111111111111111111111111111111111111'
    expect(legacyCleanupRedirect(`/app/cleanup/943/${mixed}`)).toBe(
      `/app#/943/cleanup/${mixed.toLowerCase()}`,
    )
  })

  /**
   * The rewrite checks the shape, never the registry. An old link to a chain this build dropped
   * still becomes a fragment, and `parseRoute` is what turns it back into the default board.
   */
  test('a chain this build does not carry is still rewritten', () => {
    expect(legacyCleanupRedirect(`/app/cleanup/1/${ADDR}`)).toBe(`/app#/1/cleanup/${ADDR}`)
  })

  test.each([
    ['the app itself', '/app'],
    ['the landing page', '/'],
    ['a fragment link', '/app'],
    ['no address', '/app/cleanup/943'],
    ['a chain that is not a number', `/app/cleanup/0x3af/${ADDR}`],
    ['an address one character short', '/app/cleanup/943/0x111111111111111111111111111111111111111'],
    ['an address with no 0x', '/app/cleanup/943/1111111111111111111111111111111111111111'],
    ['a name instead of an address', '/app/cleanup/943/maker.eth'],
    ['a deeper path', `/app/cleanup/943/${ADDR}/withdraw`],
  ])('leaves %s alone', (_name, path) => {
    expect(legacyCleanupRedirect(path)).toBeNull()
  })
})

/**
 * Where the language picker sends a reader.
 *
 * The landing page has a URL per language and the dapp has one URL for all of them, so the
 * picker is navigation on one surface and a setting on the other. Getting this backwards is
 * quiet in both directions: a push inside the app would drop the reader out of it, and no push
 * on the landing page would leave somebody reading Japanese at an address that says English.
 */
describe('the language picker\'s destination', () => {
  test('the landing page moves to the language it was given', () => {
    expect(localeHref('/', '', 'ja')).toBe('/ja/')
    expect(localeHref('/ja/', '', 'de')).toBe('/de/')
    // Back to English is back to the root. English has no prefix of its own.
    expect(localeHref('/ja/', '', 'en')).toBe('/')
  })

  test('the fragment rides along, because it is where the reader is', () => {
    expect(localeHref('/', '#costs', 'ja')).toBe('/ja/#costs')
    expect(localeHref('/ja/', '#how', 'en')).toBe('/#how')
  })

  test('the language already on screen is not a move', () => {
    expect(localeHref('/ja/', '', 'ja')).toBeNull()
    expect(localeHref('/', '', 'en')).toBeNull()
    expect(localeHref('/ja/', '#costs', 'ja')).toBeNull()
  })

  test('inside the app it is a setting and nothing else', () => {
    // One URL, no locale in it. A push here would take the reader out of the surface they are on.
    expect(localeHref('/app', '', 'ja')).toBeNull()
    expect(localeHref('/app', '#/943/board', 'ar')).toBeNull()
    expect(localeHref('/app/cleanup/943/0x0', '', 'de')).toBeNull()
  })
})

/**
 * Which drawing each screen offers, and which one it opens on.
 *
 * This registry decides what a reader can see, and nothing rendered it in a test. That is how
 * "there is no ladder graph on sign" happened: the menu is built from `variantsFor`, so a wrong
 * `contexts` list removes a whole chart from a page and every other test still passes. The
 * charts themselves are drawings of data; this is the part that decides whether anybody reaches
 * one.
 *
 * `readVariant` is the other half. It reads what the reader last chose, and it has to survive
 * three things that all really happen: no storage at all, storage that throws, and a saved id
 * that names a variant this screen does not offer.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { en } from '../../i18n/en.ts'
import {
  DEFAULT_VARIANT,
  VARIANTS,
  readVariant,
  variantsFor,
  writeVariant,
  type ChartContext,
  type VariantId,
} from './variants.ts'

const CONTEXTS: ChartContext[] = ['sign', 'board']

/** A `localStorage` that behaves, so the round trip can be asserted. */
function workingStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  } as unknown as Storage
}

/** A `localStorage` that throws on everything, which is what private mode does. */
const hostileStorage = () =>
  ({
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
  }) as unknown as Storage

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the registry itself', () => {
  test('every variant is offered on at least one screen', () => {
    // A variant in the list and on no screen is a drawing nobody can reach, which is the same
    // as not having built it and harder to notice.
    for (const v of VARIANTS) expect(v.contexts.length, v.id).toBeGreaterThan(0)
  })

  test('every label is a key English actually holds', () => {
    // The menu renders `t(v.label)`, and `t` falls back to the key itself — so a typo here shows
    // a reader `chart.v.ladder` in a dropdown and nothing else complains.
    for (const v of VARIANTS) expect(en, v.id).toHaveProperty(v.label)
  })

  test('no two variants share an id', () => {
    expect(new Set(VARIANTS.map((v) => v.id)).size).toBe(VARIANTS.length)
  })

  test.each(CONTEXTS)('%s opens on a variant it actually offers', (ctx) => {
    // A default outside the context's own list renders nothing at all: `MarketPanel` matches
    // `active` against the options and falls through every branch.
    expect(variantsFor(ctx).map((v) => v.id)).toContain(DEFAULT_VARIANT[ctx])
  })

  test('the sign page offers the ladder', () => {
    // The regression this file exists for. It was missing, and the registry was the only place
    // that said so.
    expect(variantsFor('sign').map((v) => v.id)).toContain('ladder')
  })

  test('the board does not offer the curve, because there is no draft to place', () => {
    expect(variantsFor('board').map((v) => v.id)).not.toContain('curve')
    expect(variantsFor('sign').map((v) => v.id)).toContain('curve')
  })

  test.each(CONTEXTS)('%s offers more than one, so the menu is worth drawing', (ctx) => {
    // `MarketPanel` hides the menu below two options. A context that fell to one would lose the
    // switcher silently.
    expect(variantsFor(ctx).length).toBeGreaterThan(1)
  })
})

describe('what the reader last chose', () => {
  test.each(CONTEXTS)('%s falls back to its default with nothing saved', (ctx) => {
    vi.stubGlobal('localStorage', workingStorage())
    expect(readVariant(ctx)).toBe(DEFAULT_VARIANT[ctx])
  })

  test('a saved choice is honoured', () => {
    vi.stubGlobal('localStorage', workingStorage())
    writeVariant('sign', 'tape')
    expect(readVariant('sign')).toBe('tape')
  })

  test('the two screens remember separately', () => {
    // One reader moving between pages, and the pages ask different questions. A shared key would
    // make choosing on one silently change the other.
    vi.stubGlobal('localStorage', workingStorage())
    writeVariant('sign', 'tape')
    writeVariant('board', 'capacity')
    expect(readVariant('sign')).toBe('tape')
    expect(readVariant('board')).toBe('capacity')
  })

  test('a saved id this screen does not offer falls back rather than drawing nothing', () => {
    // `curve` is sign-only. A reader who picked it there and then opened the board would
    // otherwise land on a variant with no branch to render.
    vi.stubGlobal('localStorage', workingStorage({ 'prove.chart.board': 'curve' }))
    expect(readVariant('board')).toBe(DEFAULT_VARIANT.board)
  })

  test('a saved id that names nothing at all falls back', () => {
    // A rename, or a drawing withdrawn. The stored string outlives both.
    vi.stubGlobal('localStorage', workingStorage({ 'prove.chart.sign': 'candlesticks' }))
    expect(readVariant('sign')).toBe(DEFAULT_VARIANT.sign)
  })

  test('storage that throws is not a reason to render nothing', () => {
    // Private mode and blocked site data both throw on read AND on write.
    vi.stubGlobal('localStorage', hostileStorage())
    expect(readVariant('sign')).toBe(DEFAULT_VARIANT.sign)
    expect(() => writeVariant('sign', 'tape')).not.toThrow()
  })

  test('no storage object at all is survivable', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(readVariant('board')).toBe(DEFAULT_VARIANT.board)
    expect(() => writeVariant('board', 'tape')).not.toThrow()
  })

  test('every variant round-trips on the screen that offers it', () => {
    vi.stubGlobal('localStorage', workingStorage())
    for (const ctx of CONTEXTS) {
      for (const v of variantsFor(ctx)) {
        writeVariant(ctx, v.id as VariantId)
        expect(readVariant(ctx), `${ctx}/${v.id}`).toBe(v.id)
      }
    }
  })
})

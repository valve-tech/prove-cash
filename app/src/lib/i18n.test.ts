import { afterEach, describe, expect, test, vi } from 'vitest'
import { en, type Key } from '../i18n/en.ts'
import type { LocaleCode } from './i18n.ts'
import {
  filterLocales,
  fold,
  getLocale,
  LOCALES,
  resolveLocale,
  fixed,
  num,
  setLocale,
  t,
  tSplit,
} from './i18n.ts'

/**
 * The three things a reader notices when this is wrong: the app opens in a language they do not
 * read, a string comes out as `wallet.none.short`, or their own language cannot be found in a list
 * of thirty-five. Everything below is one of those three.
 */

afterEach(async () => {
  vi.unstubAllGlobals()
  await setLocale('en')
})

describe('what the browser asks for', () => {
  test.each([
    // The plain cases: a tag that is a registry code, and a tag that is not.
    [['de'], 'de'],
    [['ja-JP'], 'ja'],
    [['de-AT'], 'de'],
    // The first tag the registry can answer wins, not the first tag.
    [['gl', 'ca-ES', 'es'], 'ca'],
    [['cy', 'gd'], 'en'],
    [[], 'en'],
    // Chinese folds by script, not by region.
    [['zh-CN'], 'zh-Hans'],
    [['zh-TW'], 'zh-Hant'],
    [['zh-HK'], 'zh-Hant'],
    [['zh-Hant-HK'], 'zh-Hant'],
    [['zh'], 'zh-Hans'],
    // Spanish and Portuguese each carry two dictionaries, and the region picks.
    [['es-MX'], 'es-419'],
    [['es-US'], 'es-419'],
    [['es-ES'], 'es'],
    [['es'], 'es'],
    [['pt-BR'], 'pt-BR'],
    [['pt'], 'pt-PT'],
    // Norwegian has three tags and one dictionary.
    [['nn-NO'], 'nb'],
    [['no'], 'nb'],
    // The codes older runtimes still emit.
    [['iw'], 'he'],
    [['in-ID'], 'id'],
  ])('%j resolves to %s', (languages, expected) => {
    expect(resolveLocale(languages)).toBe(expected)
  })

  test('a tag the registry cannot answer folds to nothing, so the next tag gets its turn', () => {
    expect(fold('cy-GB')).toBeNull()
    expect(fold('fr-CA')).toBe('fr')
  })
})

describe('every registry row', () => {
  test('there are thirty-five, each named twice and each unique', () => {
    expect(LOCALES).toHaveLength(35)
    expect(new Set(LOCALES.map((l) => l.code)).size).toBe(35)
    for (const l of LOCALES) {
      expect(l.endonym.length).toBeGreaterThan(0)
      expect(l.exonym.length).toBeGreaterThan(0)
    }
  })

  test('Arabic and Hebrew read right to left, and nothing else does', () => {
    expect(LOCALES.filter((l) => l.rtl).map((l) => l.code)).toEqual(['ar', 'he'])
  })
})

describe('a string in the reader’s language', () => {
  test('English is there before anything loads', () => {
    expect(getLocale()).toBe('en')
    expect(t('wallet.none.short')).toBe('No wallet')
  })

  test('a dictionary arrives and the strings change', async () => {
    await setLocale('fr')
    expect(getLocale()).toBe('fr')
    expect(t('wallet.none.short')).not.toBe('No wallet')
  })

  test('a key the translation misses falls back to English, never to the key', async () => {
    const fr = (await import('../i18n/fr.ts')).default
    const held = fr['wallet.none.short']
    Reflect.deleteProperty(fr, 'wallet.none.short')
    try {
      await setLocale('fr')
      expect(t('wallet.none.short')).toBe('No wallet')
    } finally {
      fr['wallet.none.short'] = held as string
    }
  })

  /**
   * Every registry row, every key. This is the test that catches a language added to the registry
   * with no file behind it: a dictionary that fails to load leaves every string English, and no
   * translation of eighty-three strings matches English on all of them.
   */
  test.each(LOCALES.map((l) => l.code))(
    '%s has a dictionary, and no key comes out as the key itself',
    async (code) => {
      const keys = Object.keys(en) as Key[]
      await setLocale(code)
      let translated = 0
      for (const key of keys) {
        const value = t(key)
        expect(value, `${code} ${key}`).toBeTruthy()
        expect(value, `${code} ${key}`).not.toBe(key)
        if (value !== en[key]) translated++
      }
      if (code !== 'en') {
        expect(translated, `${code} translated nothing`).toBeGreaterThan(keys.length / 2)
      }
    },
  )
})

describe('interpolation', () => {
  test('a variable is filled in wherever the sentence puts it', () => {
    expect(t('view.board.tip', { count: 7 })).toBe('Board · 7 open')
    expect(t('stat.profitable.value', { count: 2, total: 9 })).toBe('2 of 9')
  })

  test('a variable nobody passed is left standing, so the gap is visible', () => {
    expect(t('stat.profitable.value', { count: 2 })).toBe('2 of {total}')
  })

  test('a string with no variables is returned as it stands', () => {
    expect(t('empty.board', {})).toBe('The board is quiet.')
  })

  test('a sentence splits at its placeholder, for the words either side of a link', () => {
    const [before, after] = tSplit('rpc.board.hint', 'prefix')
    expect(before).toBe('')
    expect(after).toBe(' module')
  })
})

describe('finding a language in a list of thirty-five', () => {
  const codes = (query: string) => filterLocales(query).map((l) => l.code)

  test('an empty box shows every language', () => {
    expect(filterLocales('   ')).toHaveLength(35)
  })

  test('the English name finds it', () => {
    expect(codes('spanish')).toEqual(['es', 'es-419'])
  })

  test('the language’s own name finds it', () => {
    expect(codes('Português')).toEqual(['pt-BR', 'pt-PT'])
  })

  test('the code finds it', () => {
    expect(codes('nb')).toEqual(['nb'])
  })

  test('accents are optional, because the keyboard in front of the reader may not carry them', () => {
    expect(codes('espanol')).toEqual(['es', 'es-419'])
    expect(codes('turkce')).toEqual(['tr'])
    expect(codes('portugues')).toEqual(['pt-BR', 'pt-PT'])
    expect(codes('cestina')).toEqual(['cs'])
  })

  test('case is optional too', () => {
    expect(codes('DEUTSCH')).toEqual(['de'])
  })

  test('a query nothing answers returns nothing, and the picker says so', () => {
    expect(codes('klingon')).toEqual([])
  })
})

describe('what the change leaves behind', () => {
  test('the choice is written down, so a reload keeps it', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    await setLocale('ja')
    expect(store.get('prove.locale')).toBe('ja')
  })

  test('storage a browser refuses to give is not a reason to fail', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    await expect(setLocale('ja')).resolves.toBeUndefined()
    expect(getLocale()).toBe('ja')
  })

  test('the document says which language it is in, and which way it runs', async () => {
    const documentElement = { lang: '', dir: '', dataset: {} as Record<string, string> }
    vi.stubGlobal('document', { documentElement })
    await setLocale('ar')
    expect(documentElement.lang).toBe('ar')
    expect(documentElement.dir).toBe('rtl')
    await setLocale('ja')
    expect(documentElement.dir).toBe('ltr')
  })
})

/**
 * Letter-spacing is a Latin habit. Twenty-seven labels carry `tracking-wider`, and on a cursive or
 * conjunct-forming script a track is not a style choice — it cuts the joins and the word comes
 * apart. `applyDocument` reads the script off the locale and lets `index.css` zero the token.
 *
 * These assert the classification, not the pixels: the script drives it, so a locale nobody has
 * added yet is already decided.
 */
describe('tracking follows the script, not a list of locales', () => {
  const trackingFor = async (code: LocaleCode): Promise<string | undefined> => {
    const documentElement = { lang: '', dir: '', dataset: {} as Record<string, string> }
    vi.stubGlobal('document', { documentElement })
    await setLocale(code)
    return documentElement.dataset.tracking
  }

  test('an alphabet that does not join keeps its track', async () => {
    for (const code of ['en', 'de', 'ru', 'el', 'he'] as const) {
      expect(await trackingFor(code)).toBe('on')
    }
  })

  test('a square script keeps its track too', async () => {
    for (const code of ['ja', 'ko', 'zh-Hans', 'zh-Hant'] as const) {
      expect(await trackingFor(code)).toBe('on')
    }
  })

  test('a cursive or conjunct script loses it', async () => {
    for (const code of ['ar', 'hi', 'th'] as const) {
      expect(await trackingFor(code)).toBe('off')
    }
  })

  test('a script subtag the code omits still resolves — `hi` means `hi-Deva`', async () => {
    expect(new Intl.Locale('hi').maximize().script).toBe('Deva')
    expect(new Intl.Locale('ar').maximize().script).toBe('Arab')
  })

  test('every shipped locale is classified, and none is left undecided', async () => {
    for (const locale of LOCALES) {
      expect(await trackingFor(locale.code)).toMatch(/^(on|off)$/)
    }
  })
})

/**
 * A fourth thing a reader notices: the digits are punctuated for somebody else. Every figure on a
 * translated screen used to be formatted `en-US`, so a German reader read a block number of
 * `23.456.789` as `23,456,789` and a fee of `0,30%` as `0.30%`. No locale file can reach these —
 * the digits arrive at run time.
 */
describe('numbers follow the reader, not the author', () => {
  test('a thousands separator is the reader\'s, not a comma for everyone', async () => {
    await setLocale('en')
    expect(num(23_456_789)).toBe('23,456,789')
    await setLocale('de')
    expect(num(23_456_789)).toBe('23.456.789')
    await setLocale('fr')
    // French uses a narrow no-break space, so compare the separator rather than the exact glyph.
    expect(num(23_456_789)).not.toContain(',')
  })

  test('a decimal mark is the reader\'s, which is what `toFixed` could never do', async () => {
    await setLocale('en')
    expect(fixed(0.3, 2)).toBe('0.30')
    await setLocale('de')
    expect(fixed(0.3, 2)).toBe('0,30')
    await setLocale('sv')
    expect(fixed(0.3, 2)).toBe('0,30')
  })

  test('a bigint block number formats too, because that is where this was found', async () => {
    await setLocale('de')
    expect(num(23_456_789n)).toBe('23.456.789')
  })

  test('every shipped locale formats without throwing', async () => {
    for (const locale of LOCALES) {
      await setLocale(locale.code)
      expect(() => num(1234.5)).not.toThrow()
      expect(fixed(1234.5, 2)).toMatch(/\d/)
    }
  })
})

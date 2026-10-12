import { afterAll, describe, expect, test } from 'vitest'
// The file itself, through Vite, so this reads exactly what the build reads.
import INDEX from '../../index.html?raw'
import { LOCALES, localeFromPath, pathForLocale, setLocale, t } from './i18n.ts'
import { alternates, esc, head, htmlTag, sitemap, urlFor, ORIGIN } from './seo.ts'

/**
 * The translations, as a search engine sees them.
 *
 * Thirty-four languages sat in this app for a day being invisible to every crawler on the
 * internet, because the only thing that chose between them was `navigator.languages` and
 * Googlebot reports English there. The fix is three claims, and these are the tests that hold
 * them: every language has a URL, that URL's HTML carries that language, and all thirty-five
 * pages name each other.
 *
 * The one that will actually fire one day is the `index.html` comparison. It is the only place
 * where a hand-edited file and generated output have to agree, and the failure it prevents is
 * silent — a page whose head says one thing in development and another in production.
 */

// Locale is module state. Every test here sets it, so put it back for anything that runs after.
afterAll(async () => {
  await setLocale('en', { remember: false })
})

describe('a language a crawler can find', () => {
  test('index.html holds exactly what head() generates for English', () => {
    const open = INDEX.indexOf('<!--seo-->') + '<!--seo-->'.length
    const close = INDEX.indexOf('    <!--/seo-->')
    expect(open).toBeGreaterThan(0)
    expect(close).toBeGreaterThan(open)
    expect(INDEX.slice(open, close)).toBe('\n' + head('en') + '\n')
  })

  test('the three strings the prerender cuts on are in index.html, once each', () => {
    // scripts/prerender.ts replaces each of these. A second copy would make `replace` take the
    // wrong one; none at all would ship thirty-five English pages claiming to be translations.
    for (const marker of ['<html lang="en">', '<div id="root"></div>', '<!--seo-->']) {
      expect(INDEX.split(marker).length - 1, marker).toBe(1)
    }
  })

  test('every locale has its own lower-case URL', () => {
    const paths = LOCALES.map((l) => pathForLocale(l.code))
    expect(new Set(paths).size).toBe(LOCALES.length)
    expect(pathForLocale('en')).toBe('/')
    for (const path of paths) expect(path).toBe(path.toLowerCase())
    // The registry's own casing stays out of the path and stays in the hreflang tag.
    expect(pathForLocale('zh-Hans')).toBe('/zh-hans/')
    expect(pathForLocale('pt-BR')).toBe('/pt-br/')
  })

  test('a path round-trips to the locale it names', () => {
    // English is the exception, and deliberately: its page is `/`, which names nothing.
    for (const l of LOCALES) {
      if (l.code === 'en') continue
      expect(localeFromPath(pathForLocale(l.code))).toBe(l.code)
    }
    // Case is not part of the claim, so an old link with the registry spelling still lands.
    expect(localeFromPath('/zh-Hans/')).toBe('zh-Hans')
    expect(localeFromPath('/ja/how')).toBe('ja')
  })

  test('a path that names no language names no language', () => {
    // `/` is English by pathForLocale, but nothing in the first segment says so — the bootstrap
    // has to fall through to the stored choice and then to the browser.
    expect(localeFromPath('/')).toBeNull()
    expect(localeFromPath('/app')).toBeNull()
    expect(localeFromPath('/app/cleanup/369/0x0')).toBeNull()
    // No folding here. A path is a claim about which page this is, not a hint about the reader.
    expect(localeFromPath('/de-at/')).toBeNull()
    // `/en/` is a code the registry holds and a page nothing publishes — it is in no sitemap and
    // no hreflang, and the SPA fallback answers it with the English shell. Reading it as English
    // costs nothing and is what somebody typing it meant.
    expect(localeFromPath('/en/')).toBe('en')
  })

  test('the alternates name all thirty-five and x-default, and nothing twice', () => {
    const rows = alternates().trim().split('\n')
    expect(rows).toHaveLength(LOCALES.length + 1)
    const tags = rows.map((r) => /hreflang="([^"]+)"/.exec(r)?.[1])
    expect(tags).toEqual(['x-default', ...LOCALES.map((l) => l.code)])
    const hrefs = rows.map((r) => /href="([^"]+)"/.exec(r)?.[1])
    // x-default and English are the same page on purpose. Everything else is its own.
    expect(new Set(hrefs).size).toBe(LOCALES.length)
    expect(hrefs[0]).toBe(`${ORIGIN}/`)
  })

  test('the sitemap lists every page and gives each the whole cluster', () => {
    const xml = sitemap()
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    expect(locs).toEqual(LOCALES.map((l) => urlFor(l.code)))
    // Every page carries the same alternates, which is the condition Google drops a cluster for.
    const blocks = xml.split('<url>').slice(1)
    for (const block of blocks) {
      expect(block.match(/xhtml:link/g) ?? []).toHaveLength(LOCALES.length + 1)
    }
  })

  test('the html tag carries the language, and the direction where there is one', () => {
    expect(htmlTag('en')).toBe('<html lang="en">')
    expect(htmlTag('ar')).toBe('<html lang="ar" dir="rtl">')
    expect(htmlTag('he')).toBe('<html lang="he" dir="rtl">')
    expect(htmlTag('zh-Hans')).toBe('<html lang="zh-Hans">')
  })

  test('a quote in a string cannot end the attribute it sits in', () => {
    expect(esc('a "b" & <c>')).toBe('a &quot;b&quot; &amp; &lt;c&gt;')
  })

  test.each(LOCALES.map((l) => l.code))('%s has its own title and description', async (code) => {
    await setLocale(code, { remember: false })
    const title = t('seo.title')
    const description = t('seo.description')

    // Not English, unless it is English. A locale that falls through here is one whose head says
    // it is Japanese and whose snippet is in English, which is worse than no page at all.
    if (code !== 'en') {
      expect(title).not.toBe('prove.cash — sign a swap offer, send no transaction')
      expect(description.startsWith('Signing an offer')).toBe(false)
    }

    // A search result truncates on pixels, near sixty characters of title and 160 of
    // description. Past that the claim is cut off mid-sentence in the one place it has to land.
    expect(title.length, title).toBeLessThanOrEqual(64)
    expect(description.length, description).toBeLessThanOrEqual(160)

    // The name is the word somebody types, and it is not translated. See en.ts.
    expect(title).toContain('prove.cash')

    // The head has to survive being written into HTML attributes.
    const written = head(code)
    expect(written).toContain(`<link rel="canonical" href="${urlFor(code)}" />`)
    expect(written).toContain(esc(title))
    expect(written).not.toMatch(/content="[^"]*"[^">/]*"/)
  })
})

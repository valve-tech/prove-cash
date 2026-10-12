import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, test } from 'vitest'
import Landing from './Landing.tsx'
import { LOCALES, setLocale, t } from '../lib/i18n.ts'
import { en, type Key } from '../i18n/en.ts'

/**
 * The landing page, rendered the way the build renders it.
 *
 * `scripts/prerender.ts` calls `renderToString` on this exact tree, once per language, and writes
 * the result to `dist`. So this file is two tests at once: it says the page carries a way to
 * change language, and it says the page can be rendered without a browser at all. The second one
 * is the one that will catch something — a component that reaches for `window` at render time
 * breaks the build rather than the app, and a failing build step reads as a broken toolchain
 * until somebody works out which component moved.
 */

// Locale is module state, and every locale here sets it. Put it back for whatever runs next.
afterAll(async () => {
  await setLocale('en', { remember: false })
})

describe('the landing page', () => {
  test('renders with no DOM, which is what the prerender needs', () => {
    const html = renderToStaticMarkup(<Landing />)
    expect(html).toContain('Name your rate')
    expect(html).toContain('id="main"')
  })

  test('carries the language picker', () => {
    // Thirty-four translations reach a reader who never opens the app. Before this the only way
    // to see one was to arrive with the right browser language.
    const html = renderToStaticMarkup(<Landing />)
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain(`aria-label="${t('language.label', { language: 'English' })}"`)
  })

  test('the picker is the last control in the header', () => {
    // Load-bearing, not a preference. The popover hangs from the trigger's trailing edge
    // (`end-0` in LanguagePicker), so it is only certain to fit when that edge is the header's
    // own. With the picker before the crossing button, a 375px screen put 43px of the list past
    // the left edge in English and 15px past the right in Arabic — over rows nobody could reach.
    const html = renderToStaticMarkup(<Landing />)
    const open = html.indexOf(t('landing.open'))
    const globe = html.indexOf('aria-haspopup="listbox"')
    expect(open).toBeGreaterThan(0)
    expect(globe).toBeGreaterThan(open)
  })

  test.each(LOCALES.map((l) => l.code))('%s renders in its own language', async (code) => {
    await setLocale(code, { remember: false })
    const html = renderToStaticMarkup(<Landing />)

    // The hero's first line and the button that crosses into the app: one is prose and one is a
    // control, and between them they cover both halves of the page's copy.
    expect(html).toContain(t('landing.hero.line1'))
    expect(html).toContain(t('landing.open'))

    // The picker names the language it is set to, in that language.
    const endonym = LOCALES.find((l) => l.code === code)?.endonym
    expect(html).toContain(t('language.label', { language: endonym ?? '' }))
  })
})

/**
 * No i18n key may reach the reader.
 *
 * `landing.costs.mode.warm.hint` rendered as itself on the live page, in every language, because
 * `Costs.tsx` put a `Key` straight into JSX instead of through `t`. The app's own views and chrome
 * have carried this guard for a while; this page never had one, so the defect sat in prerendered
 * HTML for thirty-five locales and nothing failed.
 *
 * One `find` per locale rather than an assertion per key. The chrome guard once ran 403,200
 * `expect` calls and sat three per cent under its timeout until twenty new keys tipped it over —
 * see `chrome.i18n.test.tsx`. The same shape here costs almost nothing.
 */
describe('the landing page never shows a key', () => {
  const KEYS = Object.keys(en) as Key[]

  test.each(LOCALES.map((l) => l.code))('%s', async (code) => {
    await setLocale(code, { remember: false })
    const said = renderToStaticMarkup(<Landing />)
    const leaked = KEYS.find((key) => said.includes(key))
    expect(leaked, `${code} rendered the key ${leaked} instead of its translation`).toBeUndefined()
  })
})

import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test } from 'vitest'
import ar from '../i18n/ar.ts'
import { en, type Key } from '../i18n/en.ts'
import ja from '../i18n/ja.ts'
import { LOCALES, setLocale, t } from '../lib/i18n.ts'
import { EndpointsButton } from './EndpointsButton'
import { RpcSettings } from './RpcSettings'
import { VIEW_LABEL, VIEW_TIP } from './ViewIcon'

/**
 * The chrome in the reader's language.
 *
 * `i18n.test.ts` proves the dictionaries answer. This file proves the components ask: a key that
 * nothing calls is a translated string nobody ever sees, which is the failure the wiring pass
 * exists to prevent. So every assertion here goes through rendered markup or through the two maps
 * the header calls, never through `t` alone.
 */

const KEYS = Object.keys(en) as Key[]

const button = () =>
  renderToStaticMarkup(
    <EndpointsButton health="live" custom={false} host="one.valve.city" onClick={() => {}} />,
  )

const dialog = () =>
  renderToStaticMarkup(<RpcSettings chainId={943} onSaved={() => {}} onClose={() => {}} />)

afterEach(async () => {
  await setLocale('en')
})

describe('a language change reaches the chrome', () => {
  test('the header button speaks Japanese, host and all', async () => {
    const english = button()
    await setLocale('ja')
    const japanese = button()

    expect(japanese).not.toBe(english)
    // The tip takes {health} and {hosts}, so the raw dictionary string must never reach the DOM —
    // asserting on it was what let a placeholder-free tip through and lost the host from the
    // tooltip. Check the translated noun arrived and that nothing was left unsubstituted.
    // A dictionary is `Partial<typeof en>`, so the key is optional to the type system. Assert it
    // is really there before leaning on it, or a deleted key would pass as an empty match.
    const tip = ja['header.endpoints.tip'] ?? ''
    expect(tip).toContain('—')
    expect(japanese).toContain(tip.slice(0, tip.indexOf('—')).trim())
    expect(japanese).not.toMatch(/\{\w+\}/)
    expect(japanese).toContain(ja['board.live'])
    // The host is not copy. It has to survive the change or the reader loses the node's name.
    expect(japanese).toContain('one.valve.city')
  })

  test('the view icons carry the count into the translated sentence', async () => {
    await setLocale('ja')
    expect(VIEW_TIP.board({ count: 3, reposts: 0 })).toBe('ボード · 有効 3 件')
    expect(VIEW_LABEL.mine({ count: 2, reposts: 1 })).toBe(
      ja['view.mine.spoken.reposts']!.replace('{count}', '2').replace('{reposts}', '1'),
    )
  })

  test('the endpoints dialog changes with it', async () => {
    await setLocale('ar')
    const html = dialog()
    expect(html).toContain(ar['rpc.title'])
    expect(html).toContain(ar['rpc.save'])
    expect(html).toContain(ar['rpc.board.field'])
  })

  test('English comes back when the reader goes back', async () => {
    const english = button()
    await setLocale('de')
    expect(button()).not.toBe(english)
    await setLocale('en')
    expect(button()).toBe(english)
  })
})

/**
 * The one thing a missing translation must never do is show the reader the key. `t` cannot return
 * one from typed code, but a component can still hand it a key that spells a variable wrong or
 * name a key the dictionary dropped, and both arrive on screen as dotted lowercase.
 */
describe('no rendered string is a raw key', () => {
  test('not in the header button, and not in the dialog, in any of the thirty-five', async () => {
    for (const locale of LOCALES) {
      await setLocale(locale.code)
      const markup = `${button()} ${dialog()}`
      // One assertion, not one per key. `expect` is not free and `KEYS` is the whole dictionary,
      // so asserting inside the loop cost 640 of them per string and put this file's sibling test
      // 3% under its timeout — where adding twenty keys tipped it over and the suite began
      // failing about half the time. Find the leak in plain JavaScript and assert on the answer.
      const leaked = KEYS.find((key) => markup.includes(key))
      expect(leaked, `${locale.code} leaked ${leaked}`).toBeUndefined()
    }
  })

  test('nor in the three view icons, tip or spoken, empty or counting', async () => {
    const counts = [
      { count: 0, reposts: 0 },
      { count: 3, reposts: 0 },
      { count: 3, reposts: 2 },
    ]
    for (const locale of LOCALES) {
      await setLocale(locale.code)
      for (const map of [VIEW_TIP, VIEW_LABEL]) {
        for (const view of ['board', 'sign', 'mine'] as const) {
          for (const c of counts) {
            const said = map[view](c)
            expect(said, `${locale.code} ${view}`).toBeTruthy()
            // See the note above: one assertion per string, not one per key. This loop runs 630
            // times, so the difference here was 403,200 `expect` calls against 630.
            const leaked = KEYS.find((key) => said.includes(key))
            expect(leaked, `${locale.code} ${view} leaked ${leaked}`).toBeUndefined()
            // A placeholder left standing is the other way a template reaches a reader raw.
            expect(said, `${locale.code} ${view}`).not.toMatch(/\{\w+\}/)
          }
        }
      }
    }
  })

  test('a variable the caller forgot would show, so the check can fail', () => {
    // The guard above is only worth having if it catches something. This is the shape it catches.
    expect(t('view.board.tip')).toMatch(/\{count\}/)
  })
})

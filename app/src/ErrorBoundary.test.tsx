import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test } from 'vitest'
import { CrashNotice, ErrorBoundary } from './ErrorBoundary.tsx'
import { en } from './i18n/en.ts'
import ja from './i18n/ja.ts'
import { setLocale } from './lib/i18n.ts'

/**
 * The floor under a crash.
 *
 * React unmounts the whole tree when a render, an effect or a lifecycle throws and nothing
 * catches it, and an unmounted tree is a blank tab. Production showed one: a wallet extension's
 * Proxy threw on a property read inside a mount effect.
 *
 * `renderToStaticMarkup` does not run error boundaries — it has no commit phase to fail in — so
 * the two halves are checked separately: the pass-through, and what the fallback says.
 */

afterEach(async () => {
  await setLocale('en')
})

const notice = (detail: string) => renderToStaticMarkup(<CrashNotice detail={detail} />)

describe('when nothing throws', () => {
  test('the children render untouched', () => {
    const markup = renderToStaticMarkup(
      <ErrorBoundary>
        <p>the app</p>
      </ErrorBoundary>,
    )
    expect(markup).toBe('<p>the app</p>')
  })
})

describe('what a person reads instead of a blank tab', () => {
  test('a sentence they can act on', () => {
    expect(notice('')).toContain(en['crash.lead'])
  })

  test('marked up as an alert, so a screen reader is told without being asked', () => {
    expect(notice('')).toContain('role="alert"')
  })

  test('in their own language', async () => {
    await setLocale('ja')
    const sentence = ja['crash.lead'] ?? ''
    expect(sentence).not.toBe('')
    expect(notice('')).toContain(sentence)
  })

  test('and the first line of what broke, which is the only part they can quote to us', () => {
    expect(notice('the wallet refused')).toContain('the wallet refused')
  })
})

describe('the redaction', () => {
  /**
   * The defect this inherits from `lib/errors.ts`. viem builds a whole report — the message, the
   * URL, then the entire request body — and an endpoint with a key in its path is a credential.
   * A crash screen is the worst place to print one, because it is the screen somebody photographs
   * and sends us.
   */
  test('only the first line of the error reaches the screen', () => {
    const viemish = [
      'HTTP request failed.',
      'URL: https://one.valve.city/rpc/vk_secret_key_do_not_print',
      'Request body: {"method":"eth_call"}',
    ].join('\n')
    const state = ErrorBoundary.getDerivedStateFromError(new Error(viemish))
    expect(state.message).toBe('HTTP request failed.')
    expect(notice(state.message ?? '')).not.toContain('vk_secret')
  })

  test('something thrown that is not an Error still says something', () => {
    expect(ErrorBoundary.getDerivedStateFromError('a bare string').message).toBe('a bare string')
  })

  test('and null is a message, not a crash inside the crash screen', () => {
    expect(() => ErrorBoundary.getDerivedStateFromError(null)).not.toThrow()
  })
})

describe('the layout rules this screen still owes', () => {
  /**
   * It can reach a viewport edge, so it is square and outlined by an outset shadow. `ring-1`
   * compiles to one; a CSS border would take a pixel of layout width and read as a screen
   * artifact at the edge.
   */
  test('no CSS border and no radius on a panel that meets the edge', () => {
    const markup = notice('x')
    expect(markup).toContain('ring-1')
    expect(markup).not.toMatch(/class="[^"]*\bborder\b/)
    expect(markup).not.toMatch(/class="[^"]*\brounded/)
  })

  test('one layer of padding, and the detail wraps rather than clipping', () => {
    const markup = notice('0x'.padEnd(200, 'a'))
    expect(markup).toContain('p-2')
    expect(markup).toContain('sm:p-4')
    expect(markup).toContain('break-words')
    expect(markup).not.toContain('truncate')
  })
})

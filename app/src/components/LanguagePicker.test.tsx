import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { GlobeIcon, LanguagePicker } from './LanguagePicker'

/**
 * What can be checked without a DOM.
 *
 * The app's test run has no browser environment, so there is nothing here to click and no arrow
 * key to press. Rendering the closed control still answers the questions that matter most: an
 * icon-only button has to name itself, and a popover has to stay shut until it is asked for. The
 * search that the arrows move through is pure, and `lib/i18n.test.ts` tests it directly.
 */

describe('the closed control', () => {
  const html = renderToStaticMarkup(<LanguagePicker />)

  test('an icon button says what it is and what it is set to', () => {
    expect(html).toContain('aria-label="Language: English"')
    expect(html).toContain('title="Language: English"')
  })

  test('it announces itself as the thing that opens a list', () => {
    expect(html).toContain('aria-haspopup="listbox"')
    expect(html).toContain('aria-expanded="false"')
  })

  test('the list is not in the page until it is opened', () => {
    expect(html).not.toContain('role="listbox"')
    expect(html).not.toContain('role="option"')
  })
})

describe('the globe', () => {
  const html = renderToStaticMarkup(<GlobeIcon />)

  test('it is drawn to the same 16px stroke as the view icons', () => {
    expect(html).toContain('viewBox="0 0 16 16"')
    expect(html).toContain('stroke="currentColor"')
    expect(html).toContain('stroke-width="1.5"')
    expect(html).toContain('fill="none"')
  })

  test('it is decoration, because the button around it carries the word', () => {
    expect(html).toContain('aria-hidden="true"')
  })
})

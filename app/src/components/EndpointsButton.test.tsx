import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { EndpointsButton } from './EndpointsButton'

/**
 * The host string left the header, so the tooltip and the `aria-label` are the only places it
 * still exists. Both must carry it, and for different readers: the label is the whole sentence a
 * screen reader hears, the tooltip is what a mouse finds. Drop it from the tooltip and a sighted
 * reader has no way at all to see which node they are on — worse than before the host left the
 * header, which is the trap this file exists to catch.
 *
 * `header.endpoints.tip` briefly held a fixed sentence with no slots, which did exactly that. It
 * takes `{health}` and `{hosts}` now, in all 35 dictionaries.
 */

const render = (props: Parameters<typeof EndpointsButton>[0]) =>
  renderToStaticMarkup(<EndpointsButton {...props} />)

const LIVE = { health: 'live', custom: false, host: 'one.valve.city', onClick: () => {} } as const

describe('the header button', () => {
  test('an icon-only button says what it is and where it points', () => {
    expect(render(LIVE)).toContain(
      'aria-label="Endpoints: board live — one.valve.city. Bring your own node."',
    )
  })

  test('the tooltip carries the health and the host, for the reader with a mouse', () => {
    expect(render(LIVE)).toContain('Endpoints — board live · one.valve.city')
  })

  test('the host renders twice and only twice: the tooltip and the label', () => {
    // Two, and no more. A third would be visible text back in a header that dropped it.
    expect(render(LIVE).split('one.valve.city').length - 1).toBe(2)
  })

  test('two hosts arrive as one string, so a split pair still reads', () => {
    const html = render({ ...LIVE, host: 'one.valve.city · rpc.example' })
    expect(html).toContain(
      'aria-label="Endpoints: board live — one.valve.city · rpc.example. Bring your own node."',
    )
  })

  test('a custom endpoint is said in words, not in a second badge', () => {
    const html = render({ ...LIVE, custom: true })
    expect(html).toContain('one.valve.city, custom. Bring your own node.')
  })
})

/**
 * The dot changes shape as well as hue. Colour alone fails a colourblind reader; the spoken health
 * word is what carries it to a screen reader. Both halves are checked per state.
 */
describe('the health dot', () => {
  test.each([
    ['live', 'rounded-full bg-(--color-proven)', 'board live'],
    ['waiting', 'rounded-full border border-(--color-unproven)', 'board not accepting posts'],
    ['broken', 'rounded-[1px] bg-(--color-danger)', 'board unreachable'],
  ] as const)('%s draws its own shape and says its own word', (health, shape, word) => {
    const html = render({ ...LIVE, health })
    expect(html).toContain(shape)
    expect(html).toContain(word)
  })

  test('the dot is hidden from a screen reader, which hears the word instead', () => {
    expect(render(LIVE)).toMatch(/live-dot/)
    expect(render(LIVE)).toContain('aria-hidden="true"')
  })
})

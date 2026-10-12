import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { RpcSettings, savedUrls, toggleLink } from './RpcSettings.tsx'

/**
 * The link between the two endpoint fields moved from a pill in the title row to an icon on the
 * chain field. The picture changed; none of the behaviour below may. Each test names the thing a
 * reader would lose if the rewrite dropped it.
 *
 * The toggle is tested as a pure function because the app's test run has no browser, so there is
 * nothing here to click. The markup tests below cover the half a first-time reader sees.
 */

const BOARD = 'https://one.valve.city/rpc'
const TYPED = 'https://my-node.example/rpc'

describe('the link toggle', () => {
  test('unlinking seeds the chain field with the board URL', () => {
    // The reader was looking at the board URL in that box a second ago. An empty field would
    // throw away the text they are most likely about to edit.
    expect(toggleLink(true, BOARD, '').chainUrl).toBe(BOARD)
  })

  test('linking again leaves the typed URL alone, so a mistaken click costs nothing', () => {
    expect(toggleLink(false, BOARD, TYPED).chainUrl).toBe(TYPED)
  })

  test('either direction retires the chain check', () => {
    // The URL the check judged is no longer the URL in the box, so the old verdict is a lie.
    expect(toggleLink(true, BOARD, '').chainCheck).toEqual({ state: 'idle' })
    expect(toggleLink(false, BOARD, TYPED).chainCheck).toEqual({ state: 'idle' })
  })

  test('the toggle flips the link', () => {
    expect(toggleLink(true, BOARD, TYPED).linked).toBe(false)
    expect(toggleLink(false, BOARD, TYPED).linked).toBe(true)
  })

  test('two toggles return the field to a copy of the board URL', () => {
    const once = toggleLink(true, BOARD, '')
    const twice = toggleLink(once.linked, BOARD, once.chainUrl)
    expect(twice.linked).toBe(true)
    expect(twice.chainUrl).toBe(BOARD)
  })
})

describe('what save writes', () => {
  test('a linked pair stores an empty chain URL', () => {
    // Empty is how storage spells "follow the board". A stored copy would go stale the next time
    // the board URL changed, and the two would drift apart in silence.
    expect(savedUrls(true, BOARD, TYPED).chain).toBe('')
  })

  test('an unlinked pair stores the typed chain URL', () => {
    expect(savedUrls(false, BOARD, TYPED).chain).toBe(TYPED)
  })

  test('both URLs are trimmed, because a pasted URL brings whitespace', () => {
    expect(savedUrls(false, `  ${BOARD} `, ` ${TYPED}  `)).toEqual({ board: BOARD, chain: TYPED })
  })

  test('the board URL is stored whether the pair is linked or not', () => {
    expect(savedUrls(true, BOARD, TYPED).board).toBe(BOARD)
    expect(savedUrls(false, BOARD, TYPED).board).toBe(BOARD)
  })
})

/**
 * A reader who opens the dialog and touches nothing has to be able to tell that the chain field
 * follows the board field. Three things say it together, and the acceptance list in
 * `2026-08-17-rpc-controls.md` names all three, so all three are checked here.
 */
describe('the dialog as a first-time reader meets it', () => {
  const html = renderToStaticMarkup(
    <RpcSettings chainId={943} onSaved={() => {}} onClose={() => {}} />,
  )

  test('the chain input is disabled', () => {
    expect(html).toMatch(/id="rpc-chain"[^>]*disabled/)
  })

  test('the chain input mirrors the board URL', () => {
    const value = (id: string) => html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`))?.[1]
    expect(value('rpc-chain')).toBe(value('rpc-board'))
    expect(value('rpc-chain')).toBeTruthy()
  })

  test('the link is lit, and says so to a screen reader', () => {
    // The name holds still and `aria-pressed` carries the state — a toggle, not two controls
    // swapping names. The tooltip is where the state spells itself out.
    expect(html).toContain('aria-pressed="true"')
    expect(html).toContain('aria-label="Use one URL for both endpoints"')
    expect(html).toContain('One URL drives both. Unlock for two.')
  })

  test('the old pill is gone from the title row', () => {
    expect(html).not.toContain('locked · one URL')
    expect(html).not.toContain('unlocked · two URLs')
  })

  test('the panel has no width floor, so a 320px screen never scrolls sideways', () => {
    expect(html).not.toContain('min-w-80')
    expect(html).toContain('w-full max-w-lg')
  })
})

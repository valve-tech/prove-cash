import { describe, expect, test } from 'vitest'
import { boardPresence } from './useBoard'

/**
 * Whether an offer is on the live board. The whole defect was reading an unfilled set as an
 * answer: before the first board read `live` is empty, and every row claimed to be off the board.
 */
describe('whether an offer is on the live board', () => {
  const live = new Set(['a', 'b'])

  test('before the board answers, presence is unknown — not off', () => {
    // The case that shipped wrong. An empty set, and a board that has not replied: no claim.
    expect(boardPresence(false, new Set(), 'a')).toBeNull()
    // Even a stale set from a previous scope says nothing until this scope has an answer.
    expect(boardPresence(false, live, 'a')).toBeNull()
  })

  test('once the board answers, an offer it carries is on it', () => {
    expect(boardPresence(true, live, 'a')).toBe(true)
  })

  test('once the board answers, an offer it does not carry is off it', () => {
    expect(boardPresence(true, live, 'z')).toBe(false)
  })

  test('an answered board that carries nothing makes every offer off it', () => {
    // This is a real answer, unlike the unanswered empty set above. An empty board is news.
    expect(boardPresence(true, new Set(), 'a')).toBe(false)
  })
})

import { describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import { bookOf, countTokens, keepToken, matchesToken, pairMatches } from './tokenFilter'

/**
 * A row reads `A → B`: the maker gives A and wants B. "into X" is X after the arrow, "out of X"
 * is X before it. Every case below is one row and one question about it.
 */

const X = '0x1111111111111111111111111111111111111111' as Address
const Y = '0x2222222222222222222222222222222222222222'
const Z = '0x3333333333333333333333333333333333333333'

describe('which rows a token filter keeps', () => {
  test('into X keeps rows where the maker wants X, and only those', () => {
    expect(matchesToken(Y, X, { token: X, dir: 'into' })).toBe(true)
    expect(matchesToken(X, Y, { token: X, dir: 'into' })).toBe(false)
  })

  test('out of X keeps rows where the maker gives X, and only those', () => {
    expect(matchesToken(X, Y, { token: X, dir: 'out' })).toBe(true)
    expect(matchesToken(Y, X, { token: X, dir: 'out' })).toBe(false)
  })

  test('either keeps X on both sides', () => {
    expect(matchesToken(X, Y, { token: X, dir: 'either' })).toBe(true)
    expect(matchesToken(Y, X, { token: X, dir: 'either' })).toBe(true)
  })

  test('a row with X on both sides passes every direction', () => {
    for (const dir of ['into', 'out', 'either'] as const) {
      expect(matchesToken(X, X, { token: X, dir })).toBe(true)
    }
  })

  test('a token that appears nowhere keeps nothing, in every direction', () => {
    for (const dir of ['into', 'out', 'either'] as const) {
      expect(matchesToken(Y, Z, { token: X, dir })).toBe(false)
    }
  })

  test('no filter keeps every row', () => {
    expect(matchesToken(Y, Z, null)).toBe(true)
  })

  test('case does not matter: a checksummed token matches the store, which is lower case', () => {
    const shouted = `0x${'A'.repeat(40)}` as Address
    expect(matchesToken(`0x${'a'.repeat(40)}`, Y, { token: shouted, dir: 'out' })).toBe(true)
  })

  test('a store pair key answers the same way as a row', () => {
    expect(pairMatches(`${Y}>${X}`, { token: X, dir: 'into' })).toBe(true)
    expect(pairMatches(`${Y}>${X}`, { token: X, dir: 'out' })).toBe(false)
    expect(pairMatches('not a pair', { token: X, dir: 'either' })).toBe(false)
  })
})

describe('the tokens the menu offers', () => {
  test('only tokens with rows, busiest first, and a row counts once per token', () => {
    const rows = [
      { tokenIn: X, tokenOut: Y, endTime: 200 },
      { tokenIn: Y, tokenOut: X, endTime: 200 },
      { tokenIn: Y, tokenOut: Z, endTime: 50 },
      { tokenIn: X, tokenOut: X, endTime: 200 },
    ]
    expect(countTokens(rows, 100)).toEqual([
      { address: X, open: 3, rows: 3 },
      { address: Y, open: 2, rows: 3 },
      { address: Z, open: 0, rows: 1 },
    ])
  })

  test('an empty board offers no tokens', () => {
    expect(countTokens([], 100)).toEqual([])
  })
})

describe('a link whose token nobody knows', () => {
  const known = (a: string) => a === X.toLowerCase()
  const nobody = '0x000000000000000000000000000000000000dead' as Address

  test('before the board answers, the link stands, because nothing is known yet', () => {
    expect(keepToken(nobody, false, known)).toBe(nobody)
  })

  test('after the board answers, a known token stands', () => {
    expect(keepToken(X, true, known)).toBe(X)
  })

  test('after the board answers, an unknown token falls back to no filter', () => {
    expect(keepToken(nobody, true, known)).toBeNull()
  })

  test('no token stays no token', () => {
    expect(keepToken(null, true, known)).toBeNull()
  })
})

describe('the book the market panel draws', () => {
  test('one pair under "into X" reads Y → X, so Y is the base', () => {
    expect(bookOf([{ tokenIn: Y, tokenOut: X }], { token: X, dir: 'into' })).toEqual([Y, X])
  })

  test('both directions of one pair are still one book', () => {
    const rows = [
      { tokenIn: X, tokenOut: Y },
      { tokenIn: Y, tokenOut: X },
    ]
    expect(bookOf(rows, { token: X, dir: 'either' })).toEqual([X, Y])
  })

  test('two pairs are two books, so there is no panel', () => {
    const rows = [
      { tokenIn: X, tokenOut: Y },
      { tokenIn: X, tokenOut: Z },
    ]
    expect(bookOf(rows, { token: X, dir: 'out' })).toBeNull()
  })

  test('no rows and no filter draw no panel', () => {
    expect(bookOf([], { token: X, dir: 'out' })).toBeNull()
    expect(bookOf([{ tokenIn: X, tokenOut: Y }], null)).toBeNull()
  })
})

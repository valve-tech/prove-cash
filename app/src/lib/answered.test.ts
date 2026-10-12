import { describe, expect, test } from 'vitest'
import { accountAnswered, archiveAnswered, awaitingBook, quotesAnswered } from './answered'

describe('the archive has answered', () => {
  test('not before its first page', () => {
    expect(archiveAnswered({ state: 'loading', loaded: 0 })).toBe(false)
  })
  test('an empty archive is an answer', () => {
    expect(archiveAnswered({ state: 'ok', loaded: 0 })).toBe(true)
  })
  test('a failed archive is an answer', () => {
    expect(archiveAnswered({ state: 'error', loaded: 0 })).toBe(true)
  })
  test('a later page loading does not undo the first answer', () => {
    expect(archiveAnswered({ state: 'loading', loaded: 50 })).toBe(true)
  })
})

describe('the quotes have answered', () => {
  test('no rows owe no quotes', () => {
    expect(quotesAnswered([])).toBe(true)
  })
  test('an unknown quote is not an answer', () => {
    expect(quotesAnswered([{ quote: undefined }])).toBe(false)
    expect(quotesAnswered([{ quote: { out: 1n } }, { quote: undefined }])).toBe(false)
  })
  test('"no route" is an answer', () => {
    expect(quotesAnswered([{ quote: null }, { quote: { out: 1n } }])).toBe(true)
  })
})

describe('the wallet has answered', () => {
  test('undefined is "not asked yet"', () => {
    expect(accountAnswered(undefined)).toBe(false)
  })
  test('null is "no account", which is an answer', () => {
    expect(accountAnswered(null)).toBe(true)
  })
  test('an address is an answer', () => {
    expect(accountAnswered('0x0000000000000000000000000000000000000001')).toBe(true)
  })
})

describe('the book still owes an answer', () => {
  test('while the board has not answered', () => {
    expect(awaitingBook({ board: false, archive: true, error: false })).toBe(true)
  })
  test('while the archive has not answered', () => {
    // On 369 the page said "The board is quiet." at 1.18 s, and the archive filled it at 2.18 s.
    expect(awaitingBook({ board: true, archive: false, error: false })).toBe(true)
  })
  test('not once both have answered', () => {
    expect(awaitingBook({ board: true, archive: true, error: false })).toBe(false)
  })
  test('not once the board has failed, because the error is the thing to draw', () => {
    expect(awaitingBook({ board: false, archive: false, error: true })).toBe(false)
  })
})

import { describe, expect, test } from 'vitest'
import { markLetters } from './markLetters.ts'

describe('markLetters', () => {
  test('keeps the lowercase t on faucet stand-ins', () => {
    expect(markLetters('tUSDC')).toBe('tU')
    expect(markLetters('tWETH')).toBe('tW')
    expect(markLetters('tPLSX')).toBe('tP')
    expect(markLetters('tHEX')).toBe('tH')
  })

  test('uppercases ordinary tickers', () => {
    expect(markLetters('WPLS')).toBe('WP')
    expect(markLetters('DAI')).toBe('DA')
    expect(markLetters('HEX')).toBe('HE')
  })
})

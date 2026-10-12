import { afterEach, describe, expect, test } from 'vitest'
import { fmt, fmtCompact, parse } from '@prove.cash/sdk'
import { amountError, normalizeAmount, units, unitsCompact } from './amount'
import { setLocale } from './i18n'

/**
 * What a typed amount means, for the five fields that take one.
 *
 * This is the only thing standing between a person's keystrokes and `parseUnits`, and the two
 * disagree in a way that costs money rather than showing an error. `parseUnits` does not refuse
 * an amount with more decimal places than the token holds — it rounds. So "0.0000001" of a
 * six-decimal token is not a refusal downstream, it is zero, and an offer signed on it sells
 * nothing. Every decimals case below is that boundary.
 *
 * The messages are asserted as the English a screen reader reads out, because `amountError`
 * returns a sentence rather than a code, and the sentence is the whole of what it does.
 */

/** The decimals the registry actually carries, so these cases are the tokens people trade. */
const USDC = 6
const HEX = 8
const PLS = 18

const DIGITS = 'Enter digits and at most one decimal separator.'
const ZERO = 'Enter an amount above zero.'
const places = (count: number) => `This token holds ${count} decimal places. Shorten the amount.`

describe('the separator a person typed', () => {
  test('a comma becomes a full stop, because most of the world writes 1,5', () => {
    // The field used to validate a full stop and nothing else, so a maker in Berlin, Paris,
    // Amsterdam, Copenhagen or Oslo typed the separator their language uses and was told it was
    // not a number.
    expect(normalizeAmount('1,5')).toBe('1.5')
  })

  test('a full stop is left alone', () => {
    expect(normalizeAmount('1.5')).toBe('1.5')
  })

  test('an empty field stays empty', () => {
    expect(normalizeAmount('')).toBe('')
  })

  test('every comma is replaced, not only the first', () => {
    expect(normalizeAmount('1,000,5')).toBe('1.000.5')
  })

  test('a thousands separator is still refused, by the validator rather than here', () => {
    // "1,000.5" becomes "1.000.5", which is two separators and not a number. The normaliser does
    // not judge; it hands the validator something with one kind of separator in it.
    const typed = normalizeAmount('1,000.5')
    expect(typed).toBe('1.000.5')
    expect(amountError(typed, PLS)).toBe(DIGITS)
  })
})

describe('an amount that is not a number', () => {
  test('an untouched field is not a mistake', () => {
    expect(amountError('', PLS)).toBeNull()
  })

  test('nor is one holding only spaces', () => {
    expect(amountError('   ', PLS)).toBeNull()
  })

  test('a lone separator is not an amount', () => {
    expect(amountError('.', PLS)).toBe(DIGITS)
  })

  test('letters, signs and exponents are refused', () => {
    for (const typed of ['abc', '1e18', '-1', '+1', '1 2', '0x10', '1..5', '1.2.3']) {
      expect(amountError(typed, PLS), typed).toBe(DIGITS)
    }
  })

  test('a leading or trailing separator is accepted, the way a field being typed into looks', () => {
    // A person typing "0.5" passes through ".5" and "0." on the way. Refusing those paints the
    // field red while they are still typing it.
    expect(amountError('.5', PLS)).toBeNull()
    expect(amountError('1.', PLS)).toBeNull()
  })

  test('the amount is trimmed before it is read', () => {
    expect(amountError('  1.5  ', PLS)).toBeNull()
  })
})

describe('an amount of nothing', () => {
  test('zero is refused, however it is written', () => {
    for (const typed of ['0', '0.0', '0.000', '.0', '00']) {
      expect(amountError(typed, PLS), typed).toBe(ZERO)
    }
  })

  test('the smallest unit of the token is not zero', () => {
    expect(amountError('0.000001', USDC)).toBeNull()
    expect(parse('0.000001', USDC)).toBe(1n)
  })
})

describe('the decimal places a token holds', () => {
  test('a token of six accepts six and refuses seven', () => {
    expect(amountError('1.123456', USDC)).toBeNull()
    expect(amountError('1.1234567', USDC)).toBe(places(USDC))
  })

  test('HEX holds eight, and eight is the limit', () => {
    expect(amountError('1.12345678', HEX)).toBeNull()
    expect(amountError('1.123456789', HEX)).toBe(places(HEX))
  })

  test('a token of eighteen accepts eighteen and refuses nineteen', () => {
    expect(amountError(`1.${'1'.repeat(18)}`, PLS)).toBeNull()
    expect(amountError(`1.${'1'.repeat(19)}`, PLS)).toBe(places(PLS))
  })

  test('the message names the token’s own number, not a fixed one', () => {
    expect(amountError('1.1234567', USDC)).toContain('6')
    expect(amountError('1.123456789', HEX)).toContain('8')
  })

  test('a field with no token yet accepts any length, because nothing knows better', () => {
    // The decimals arrive with the token, and a person can type before they pick one.
    expect(amountError(`1.${'1'.repeat(30)}`)).toBeNull()
  })

  test('trailing zeros count, because they are decimal places', () => {
    // `parseUnits` reads them the same way. A rule that ignored them here would accept a string
    // the parser then rounds.
    expect(amountError('1.0000000', USDC)).toBe(places(USDC))
  })

  test('the integer side is not limited', () => {
    expect(amountError('123456789012345678901234567890', USDC)).toBeNull()
  })
})

/**
 * The reason the decimals rule exists at all.
 *
 * `parseUnits` does not refuse an over-long amount, it rounds it — so an amount this validator
 * lets through must survive the parse, and one it refuses is precisely one the parse would
 * quietly change. Without the rule a person sells zero and the form shows no error.
 */
describe('what the validator accepts is what the parser can represent', () => {
  test('an amount one place too long rounds to nothing rather than failing', () => {
    expect(parse('0.0000001', USDC)).toBe(0n)
    expect(amountError('0.0000001', USDC)).toBe(places(USDC))
  })

  test('an amount one place too long is rounded, inventing a unit nobody typed', () => {
    // It rounds rather than truncating, so the silent change goes both ways: this one gains a
    // unit it was not given, and "0.0000001" above loses everything it had. Neither is the
    // amount the person wrote, which is why the validator refuses both rather than either.
    expect(parse('1.1234567', USDC)).toBe(1_123_457n)
    expect(amountError('1.1234567', USDC)).toBe(places(USDC))
  })

  test('every accepted amount parses to exactly what it says', () => {
    const cases: [string, number, bigint][] = [
      ['1', USDC, 1_000_000n],
      ['0.000001', USDC, 1n],
      ['1.123456', USDC, 1_123_456n],
      ['1.12345678', HEX, 112_345_678n],
      ['.5', PLS, 500_000_000_000_000_000n],
      ['1.', PLS, 1_000_000_000_000_000_000n],
      ['1000000', PLS, 10n ** 24n],
    ]
    for (const [typed, decimals, wei] of cases) {
      expect(amountError(typed, decimals), typed).toBeNull()
      expect(parse(typed, decimals), typed).toBe(wei)
    }
  })
})

/**
 * Board amounts in the reader's own digits.
 *
 * `fmt` and `fmtCompact` in the SDK write en-US separators for every reader. The board rows and
 * the stats bar format through these two instead, which keep the SDK's precision rules and take
 * the separators from the reader's locale.
 */
describe('board amounts follow the locale', () => {
  afterEach(async () => {
    await setLocale('en')
  })

  test('English matches the SDK', async () => {
    await setLocale('en')
    expect(units(1234567_890000n, 6)).toBe(fmt(1234567_890000n, 6))
    expect(units(1_500000n, 6, 4)).toBe(fmt(1_500000n, 6, 4))
    expect(units(12n, 6)).toBe(fmt(12n, 6))
    expect(unitsCompact(2_500_000n * 10n ** 18n, 18)).toBe(fmtCompact(2_500_000n * 10n ** 18n, 18))
    expect(unitsCompact(15n * 10n ** 17n, 18)).toBe(fmtCompact(15n * 10n ** 17n, 18))
  })

  test('German writes a decimal comma and dot groups', async () => {
    await setLocale('de')
    expect(units(1234567_890000n, 6)).toBe('1.234.567,89')
    expect(units(1_500000n, 6)).toBe('1,5')
    expect(units(12n, 6)).toBe('0,000012')
    expect(unitsCompact(15n * 10n ** 17n, 18)).toBe('1,5')
    expect(unitsCompact(2_500_000n * 10n ** 18n, 18)).toBe(
      new Intl.NumberFormat('de', { notation: 'compact', maximumFractionDigits: 2 }).format(2_500_000),
    )
  })

  test('a whole number past the float range keeps every digit', async () => {
    await setLocale('en')
    expect(units(123456789012345678901234n, 0)).toBe('123,456,789,012,345,678,901,234')
  })
})

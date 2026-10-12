/**
 * The count noun, in the form the reader's language actually asks for.
 *
 * The app had two plural systems and only one was right. `src/i18n/speech/` went through
 * `Intl.PluralRules` and `speech/ar.ts` supplied all six CLDR categories including the dual, while
 * the UI dictionary had none — three call sites hand-rolled an `n === 1` test that `speech/shape.ts`
 * explicitly forbids. So one screen spoke a correct Arabic dual to a screen reader and wrote a
 * broken one beside it.
 *
 * The old split was `one` and `many`, where `many` meant "not one". That is not a CLDR category
 * and it put 2 and 200 in one bucket, which is wrong at exactly the counts that happen: the fill
 * button's ordinary arguments are 2, 3 and 4, and that is the band Czech and Arabic each name
 * separately. Czech read `Splnit 2 intentů` where it needed `2 intenty`.
 *
 * These tests are about the SELECTION. Whether a given Arabic form is well written is a
 * translator's judgement and no test can hold it; whether count 2 reaches the dual is arithmetic,
 * and that is what broke.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { en } from '../i18n/en.ts'
import ar from '../i18n/ar.ts'
import he from '../i18n/he.ts'
import cs from '../i18n/cs.ts'
import { setLocale, tCount } from './i18n.ts'

afterEach(async () => {
  await setLocale('en')
})

describe('English, which has two forms', () => {
  test('one is the singular and everything else is the floor', () => {
    expect(tCount('batch.fill', 1)).toBe(en['batch.fill.one'])
    expect(tCount('batch.fill', 2)).toBe('Fill 2 intents')
    expect(tCount('batch.fill', 200)).toBe('Fill 200 intents')
  })

  test('the count fills its own slot without being passed', () => {
    // Every old call site passed `{ count }` by hand beside the ternary that chose the key. One
    // of the two is redundant and it is the one an author forgets.
    expect(tCount('batch.alone', 4)).toContain('4')
  })

  test('other variables still come from the caller', () => {
    expect(tCount('chart.walk.rest', 3, { symbol: 'tUSDC' })).toBe('3 more pay tUSDC')
    // And the singular is a different sentence, which is why it exists: `1 more pay` is not English.
    expect(tCount('chart.walk.rest', 1, { symbol: 'tUSDC' })).toBe('1 more pays tUSDC')
  })
})

describe('a language with more forms than English', () => {
  test('Arabic reaches its dual at two and its own plural at three', async () => {
    await setLocale('ar')
    // The four bands CLDR gives Arabic, each a different string in ar.ts.
    expect(tCount('batch.selected', 0)).toBe(ar['batch.selected.zero'])
    expect(tCount('batch.selected', 1)).toBe(ar['batch.selected.one'])
    expect(tCount('batch.selected', 2)).toBe(ar['batch.selected.two'])
    // The digits come from `Intl.NumberFormat`, and which shape it picks for `ar` depends on the
    // ICU build. That is a formatting question and this test is about the SELECTION, so the
    // expectation is derived the same way the code derives it.
    const digits = (n: number) => new Intl.NumberFormat('ar').format(n)
    expect(tCount('batch.selected', 5)).toBe(
      ar['batch.selected.few']?.replace('{count}', digits(5)),
    )
    // 11 to 99 is a different form again, and this is the one the old `.many` was written for.
    expect(tCount('batch.selected', 11)).toBe(
      ar['batch.selected.many']?.replace('{count}', digits(11)),
    )
  })

  test('Hebrew reaches its dual at two', async () => {
    await setLocale('he')
    expect(tCount('batch.fill', 2)).toBe(he['batch.fill.two'])
    expect(tCount('batch.fill', 1)).toBe(he['batch.fill.one'])
  })

  test('a form English does not declare is still found', async () => {
    // The whole point. `batch.selected.two` is in no English dictionary and cannot be, because
    // English has no dual. A locale declares it and `tCount` selects it.
    expect('batch.selected.two' in en).toBe(false)
    await setLocale('ar')
    expect(tCount('batch.selected', 2)).toBe(ar['batch.selected.two'])
  })
})

describe('a language with fewer forms than English', () => {
  test('Czech takes the floor at two, because its floor is written for it', async () => {
    await setLocale('cs')
    // Czech declares no `few`, and does not need one: `.other` puts the count last, behind a
    // genitive plural the numeral cannot govern, so it reads at 2, 3, 4 and at 5 and up. That was
    // the Slavic audit's own recommendation. The mechanism does not force a form on a language
    // that has rephrased its way out of needing one.
    const digits = (n: number) => new Intl.NumberFormat('cs').format(n)
    expect(tCount('batch.fill', 2)).toBe(cs['batch.fill.other']?.replace('{count}', digits(2)))
    expect(tCount('batch.fill', 7)).toBe(cs['batch.fill.other']?.replace('{count}', digits(7)))
  })
})

describe('what happens when a form is missing', () => {
  test('an untranslated form falls to English, and then to the floor', () => {
    // Never to a key. A reader who sees `batch.fill.two` has been shown the machinery.
    for (const n of [0, 1, 2, 3, 5, 11, 100]) {
      expect(tCount('batch.fill', n)).not.toContain('batch.fill')
    }
  })

  test('a base nothing declares returns the base rather than throwing', () => {
    // A wrong base is an author's bug and should be visible, not fatal, in a render path.
    expect(tCount('no.such.thing', 2)).toBe('no.such.thing')
  })
})

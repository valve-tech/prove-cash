/**
 * One charge, one word.
 *
 * This page carries three different charges, and English happily called all three a "fee":
 *
 *   the maker's fee    the rate a maker names in the offer they sign, taken out of the gross.
 *                      `i.feeConfig` and its rates. The maker chooses it and the maker pays it.
 *   the pool's cut     PulseX's 0.29% on a swap. The maker does not sign it, does not pay it and
 *                      cannot change it; the solver meets it when it sells.
 *   the gas price      what one unit of gas costs, in gwei. The solver pays all of it.
 *
 * A translator saw "fee" three times and could not tell which one they were in. What came back
 * was measurable: **every one of the eight Romance locales had used its maker's-fee word for the
 * pool's cut**, in the same four keys, and two had not translated the gas label at all — Italian
 * shipped the English "Base fee" and French shipped "Base". The Slavic six had the same collision
 * in the same places. That is not a translation defect. It is an English defect that thirty-four
 * translators faithfully carried.
 *
 * So the English picks a distinct word per charge — fee, pool cut, gas price — and this holds the
 * line.
 *
 * **What it can check, and what it cannot.** English is checkable: a word is a word, and the table
 * below says which charge each key names. Thirty-four other languages are not, because this file
 * cannot know that `retenció` is Catalan for a cut rather than a fee. What it does check across
 * every locale is the collision that actually happened — the two console labels that sit in the
 * same column, one above the other, rendering as the same text.
 */
import { describe, expect, test } from 'vitest'
import { DICTS } from '../i18n/dicts.ts'
import { en } from '../i18n/en.ts'

/** A placeholder is a name, not prose. `{fee}` is a slot; "fee" is a word. */
const prose = (text: string) => text.replace(/\{\w+\}/g, ' ')

const saysFee = (text: string) => /\bfees?\b/i.test(prose(text))

/**
 * Every key whose English says "fee", and every one of them means the maker's own.
 *
 * This is the whole list, so adding the word anywhere forces somebody to come here and say which
 * charge they meant. That is the decision this file exists to make somebody make.
 */
const SAYS_FEE = [
  'batch.bound',
  'batch.bound.spoken',
  'batch.bound.tip',
  'batch.fee',
  'landing.console.fee',
  'landing.console.tip.feeLeg',
  'landing.control.pause.body',
  'landing.console.spread.row.fee',
  'landing.console.who.fee',
  'landing.console.fee.sub',
  'landing.console.legend.fee',
  'landing.console.tip.curve',
  // Under the label "Fee rate". It used to dodge the word with "a rate"; now it says fee, and the
  // fee it means is the maker's.
  'landing.console.tip.fee',
  'landing.console.tip.floor',
  // Both said "your rate", which translators read as the exchange rate in one key and the fee
  // rate in the other. Here it is the maker's fee, so they now say so.
  'landing.console.tip.maker',
  'landing.console.tip.spread',
  'landing.console.who.pays',
  'landing.control.fee.body',
  'landing.control.fee.title',
  'landing.control.rate.body',
  'landing.control.where.rate',
  'landing.fact.rate.body',
  'landing.solver.earn.body',
  'rfq.make.more.label',
  'rfq.make.rate.note',
  'rfq.quote.fee',
  'sign.fee',
  'sign.fee.changed',
  'sign.fee.default',
  'sign.fee.group',
  'sign.fee.label',
  'sign.fee.note',
  'sign.fee.unread',
  'sign.fee.warn',
  'sign.need.fee',
  'sign.rate.refused',
  'tour.work.body',
].sort()

/** Keys that name what the pool keeps. None of them may call it a fee. */
const POOL = [
  'batch.alone.tip',
  'chart.charges',
  'chart.move.tip',
  'chart.pays',
  'chart.pool.noPool',
  'chart.source',
  'chart.source.block',
  'landing.console.tip.pool',
  'landing.console.tip.poolKeeps',
  'landing.console.who.pool',
  'landing.console.who.poolKeeps',
]

/** Keys that name what gas costs. None of them may call it a fee either. */
const GAS = [
  'landing.console.gas.line',
  'landing.console.gwei',
  'landing.console.gwei.band',
  'landing.console.gwei.range',
  'landing.console.legend.gas',
  'landing.console.spread.aftergas',
  'landing.console.spread.row.gas',
  'landing.console.tip.clears',
  'landing.console.tip.clears.no',
  'landing.console.tip.clears.none',
  'landing.console.tip.clears.yes',
  'landing.console.tip.gas',
  'landing.console.tip.gwei',
  'landing.console.who.gas',
]

describe('the English says which charge it means', () => {
  test('every key that says "fee" is declared, and means the maker’s', () => {
    const actual = Object.entries(en)
      .filter(([, v]) => typeof v === 'string' && saysFee(v))
      .map(([k]) => k)
      .sort()
    expect(
      actual,
      'a new "fee" in the dictionary. Say which of the three charges it is: if it is the maker’s, ' +
        'add the key to SAYS_FEE; if it is the pool’s or the gas, use "cut" or "price" instead',
    ).toEqual(SAYS_FEE)
  })

  test('no pool string and no gas string calls its charge a fee', () => {
    const wrong = [...POOL, ...GAS].filter((k) => {
      const v = en[k as keyof typeof en]
      return typeof v === 'string' && saysFee(v)
    })
    expect(wrong, 'the pool takes a cut and gas has a price; only the maker has a fee').toEqual([])
  })

  test('the three declared groups do not overlap, and every key in them exists', () => {
    const all = [...SAYS_FEE, ...POOL, ...GAS]
    expect(new Set(all).size, 'a key is in two groups').toBe(all.length)
    const missing = all.filter((k) => typeof en[k as keyof typeof en] !== 'string')
    expect(missing, 'these keys are declared here and are not in the dictionary').toEqual([])
  })
})

describe('what every language can be held to', () => {
  // `landing.console.fee` ("Fee rate") and `landing.console.gwei` ("Gas price") are two labels in
  // one 168px column, one directly above the other. If a locale reaches for the same word twice,
  // it renders as the same control twice, and that is visible without knowing the language.
  test('the fee control and the gas control never read the same', () => {
    const same: string[] = []
    for (const [code, dict] of Object.entries(DICTS)) {
      const d = dict as Record<string, string | undefined>
      const fee = d['landing.console.fee']
      const gas = d['landing.console.gwei']
      if (!fee || !gas) continue // untranslated falls through to English, which differs
      const a = fee.trim().toLocaleLowerCase()
      const b = gas.trim().toLocaleLowerCase()
      if (a === b || a.includes(b) || b.includes(a)) same.push(`${code}: ${fee} / ${gas}`)
    }
    expect(same, 'two stacked controls, one word between them').toEqual([])
  })

  // Italian shipped the English "Base fee" here and French shipped "Base". Neither is a
  // translation, and the parity test cannot see it: the key is present and holds a string.
  test('no locale left the gas control in English', () => {
    const untranslated = Object.entries(DICTS)
      .filter(([, dict]) => {
        const v = (dict as Record<string, string | undefined>)['landing.console.gwei']
        return v !== undefined && /^(base fee|base|gas price)$/i.test(v.trim())
      })
      .map(([code]) => code)
    expect(untranslated, 'the English label, or the English word it was cut down to').toEqual([])
  })
})

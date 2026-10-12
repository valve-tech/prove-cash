import { afterEach, describe, expect, test } from 'vitest'
import type {
  DurationUnit,
  PluralOverride,
  SpeechModule,
  UnitForms,
} from '../i18n/speech/shape.ts'
import { LOCALES, setLocale, type LocaleCode } from './i18n.ts'
import {
  type DurationSlot,
  loadSpeech,
  spokenAddress,
  spokenAmount,
  spokenCompact,
  spokenDuration,
  spokenRate,
} from './speech.ts'

/**
 * What a screen reader hears.
 *
 * Two jobs. The first block is characterization: every English sentence this module produced
 * before the languages arrived, pinned literally, because a refactor of the plumbing is not
 * allowed to change a single word an English reader hears. The strings below were captured from
 * the old concatenating implementation and pasted in.
 *
 * The rest prove the other thirty-four languages are not English with different nouns. A count
 * picks its noun through `Intl.PluralRules`, so the tests that matter are the ones where a naive
 * `n === 1` gets it wrong: Russian at 21, Polish at 21, Czech at 5, Arabic at 2.
 */

/** Turn the language back to English, or the next test hears the last one's. */
afterEach(async () => {
  await setLocale('en')
})

/** Load a language's sentences and select it, the way the picker would. */
async function speaking(code: LocaleCode): Promise<void> {
  await setLocale(code)
  await loadSpeech(code)
}

/** A count as the language writes it, so an expectation never hard-codes a digit shape. */
const num = (locale: string, n: number) =>
  new Intl.NumberFormat(locale, { useGrouping: false }).format(n)

describe('the English sentences did not change', () => {
  test.each([
    // [raw, decimals, symbol, spokenAmount, spokenCompact]
    [0n, 18, 'WPLS', '0 WPLS', 'approximately 0 WPLS'],
    [1n, 18, 'WPLS', 'approximately 0.00000000 WPLS', 'approximately 0.00000000 WPLS'],
    [1000000000000000000n, 18, 'WPLS', '1 WPLS', 'approximately 1 WPLS'],
    [
      1234567890123456789n,
      18,
      'WPLS',
      'approximately 1.23456789 WPLS',
      'approximately 1.23456789 WPLS',
    ],
    [
      -1234567890123456789n,
      18,
      'WPLS',
      'approximately minus 1.23456789 WPLS',
      'approximately minus 1.23456789 WPLS',
    ],
    [1234567000000000000000000n, 18, 'WPLS', '1,234,567 WPLS', 'approximately 1,234,567 WPLS'],
    [1n, 18, undefined, 'approximately 0.00000000', 'approximately 0.00000000'],
    [123456789n, 6, 'USDC', '123.456789 USDC', 'approximately 123.456789 USDC'],
    [-1n, 6, 'USDC', 'minus 0.000001 USDC', 'approximately minus 0.000001 USDC'],
    [500000n, 6, 'USDC', '0.5 USDC', 'approximately 0.5 USDC'],
    [1n, 0, 'NFT', '1 NFT', 'approximately 1 NFT'],
    [
      10n ** 30n,
      18,
      'BIG',
      '1,000,000,000,000 BIG',
      'approximately 1,000,000,000,000 BIG',
    ],
    [
      123456789012345678901234567890n,
      18,
      'BIG',
      'approximately 123,456,789,012.34567890 BIG',
      'approximately 123,456,789,012.34567890 BIG',
    ],
    [
      999999999999999999n,
      18,
      'WPLS',
      'approximately 0.99999999 WPLS',
      'approximately 0.99999999 WPLS',
    ],
    [
      -999999999999999999n,
      18,
      undefined,
      'approximately minus 0.99999999',
      'approximately minus 0.99999999',
    ],
  ])('%s at %i decimals', (raw, decimals, symbol, amount, compact) => {
    expect(spokenAmount(raw, decimals, symbol)).toBe(amount)
    expect(spokenCompact(raw, decimals, symbol)).toBe(compact)
  })

  test.each([
    [0n, 'no time left'],
    [-5n, 'no time left'],
    [1n, '1 second'],
    [2n, '2 seconds'],
    [5n, '5 seconds'],
    [21n, '21 seconds'],
    [59n, '59 seconds'],
    [60n, '1 minute'],
    [61n, '1 minute 1 second'],
    [90n, '1 minute 30 seconds'],
    [120n, '2 minutes'],
    [3599n, '59 minutes 59 seconds'],
    [3600n, '1 hour'],
    [3601n, '1 hour'],
    [3660n, '1 hour 1 minute'],
    [7200n, '2 hours'],
    [7325n, '2 hours 2 minutes'],
    [86399n, '23 hours 59 minutes'],
    [86400n, '1 day'],
    [86401n, '1 day'],
    [90000n, '1 day 1 hour'],
    [172800n, '2 days'],
    [200000n, '2 days 7 hours'],
    [1000000n, '11 days 13 hours'],
  ])('%i seconds', (seconds, expected) => {
    expect(spokenDuration(seconds)).toBe(expected)
  })

  test.each([
    [0.9912, 'WPLS', 'DAI', '0.9912 DAI per WPLS'],
    [1, 'A', 'B', '1 B per A'],
    [0, 'A', 'B', 'no rate for A to B'],
    [Number.NaN, 'A', 'B', 'no rate for A to B'],
    [Number.POSITIVE_INFINITY, 'A', 'B', 'no rate for A to B'],
    [1234567.891, 'A', 'B', '1,234,570 B per A'],
    [0.000012345678, 'A', 'B', '0.0000123457 B per A'],
    [1e21, 'A', 'B', '1,000,000,000,000,000,000,000 B per A'],
  ])('a rate of %s', (rate, symbolIn, symbolOut, expected) => {
    expect(spokenRate(rate, symbolIn, symbolOut)).toBe(expected)
  })

  test('an address is handed over untouched, in every language', async () => {
    const address = '0x7a3f00000000000000000000000000000000c19d'
    expect(spokenAddress(address)).toBe(address)
    await speaking('ar')
    expect(spokenAddress(address)).toBe(address)
  })

  /**
   * The one place the English changed, on purpose.
   *
   * The old code put the whole part through `Number`, which stops counting past 2^53 and rounded
   * a balance in the sentence whose only job is to carry the unrounded one. `Intl.NumberFormat`
   * takes the digits as a string and keeps them all. Nothing below 9,007,199,254,740,992 whole
   * units moves; everything above it gets its last digits back.
   */
  test('a balance past 2^53 whole units keeps its digits now, where it used to round', () => {
    expect(spokenAmount(9007199254740993n * 10n ** 18n, 18, 'X')).toBe('9,007,199,254,740,993 X')
  })
})

describe('a language that has not loaded yet still says the right thing', () => {
  test('English words, and the reader hears no gap', async () => {
    await setLocale('ru')
    expect(spokenDuration(5n)).toBe('5 seconds')
    await loadSpeech('ru')
    expect(spokenDuration(5n)).toBe('5 секунд')
  })
})

describe('numbers follow the language, not the words', () => {
  test('German groups with dots and points with a comma', async () => {
    await speaking('de')
    expect(spokenAmount(1234567500000000000000000n, 18, 'WPLS')).toBe('1.234.567,5 WPLS')
  })

  test('Hindi groups by lakh', async () => {
    await speaking('hi')
    expect(spokenAmount(1234567n * 10n ** 18n, 18)).toBe('12,34,567')
  })

  test('a token symbol is a name and never a word', async () => {
    await speaking('ja')
    expect(spokenAmount(10n ** 18n, 18, 'WPLS')).toContain('WPLS')
  })
})

/**
 * The counts that break a hand-rolled plural.
 *
 * 1, 2, 5 and 21 land in four different categories across these languages, and no two languages
 * agree on the map. Russian brings 21 back to `one`; Polish sends it to `many`; Czech sends 5 to
 * `other` while 2 stays in `few`; Arabic gives 2 a dual that speaks no numeral at all.
 */
describe('plural forms come from the language, not from n === 1', () => {
  test.each([
    ['ru' as const, 1, '1 секунда'],
    ['ru' as const, 2, '2 секунды'],
    ['ru' as const, 5, '5 секунд'],
    ['ru' as const, 21, '21 секунда'],
    ['pl' as const, 1, '1 sekunda'],
    ['pl' as const, 2, '2 sekundy'],
    ['pl' as const, 5, '5 sekund'],
    ['pl' as const, 21, '21 sekund'],
    ['cs' as const, 1, '1 sekunda'],
    ['cs' as const, 2, '2 sekundy'],
    ['cs' as const, 5, '5 sekund'],
    ['cs' as const, 21, '21 sekund'],
    ['uk' as const, 1, '1 секунда'],
    ['uk' as const, 2, '2 секунди'],
    ['uk' as const, 5, '5 секунд'],
    ['uk' as const, 21, '21 секунда'],
    ['hr' as const, 1, '1 sekunda'],
    ['hr' as const, 2, '2 sekunde'],
    ['hr' as const, 5, '5 sekundi'],
    ['hr' as const, 21, '21 sekunda'],
    ['ro' as const, 1, '1 secundă'],
    ['ro' as const, 2, '2 secunde'],
    ['ro' as const, 5, '5 secunde'],
    ['ro' as const, 21, '21 de secunde'],
  ])('%s says %i seconds as "%s"', async (code, count, expected) => {
    await speaking(code)
    expect(spokenDuration(BigInt(count))).toBe(expected.replace(String(count), num(code, count)))
  })

  test.each([
    [1, 'ثانية واحدة'],
    [2, 'ثانيتان'],
    [5, '{n} ثوانٍ'],
    [21, '{n} ثانية'],
  ])('Arabic says %i seconds as "%s"', async (count, pattern) => {
    await speaking('ar')
    expect(spokenDuration(BigInt(count))).toBe(pattern.replace('{n}', num('ar', count)))
  })

  test('Hebrew drops the numeral for two, and keeps it for the rest', async () => {
    await speaking('he')
    expect(spokenDuration(7200n)).toBe('שעתיים')
    expect(spokenDuration(3600n)).toBe('שעה אחת')
    expect(spokenDuration(5n * 3600n)).toBe(`${num('he', 5)} שעות`)
  })

  test('Turkish leaves a noun singular after any numeral', async () => {
    await speaking('tr')
    expect(spokenDuration(1n)).toBe('1 saniye')
    expect(spokenDuration(5n)).toBe('5 saniye')
  })
})

/**
 * The sentences whose shape differs, not just their words.
 *
 * A module that only swapped nouns would still read as English underneath. These are the four
 * places where the order of the parts moves, and a regression here means somebody flattened a
 * pattern back into concatenation.
 */
describe('word order belongs to the language', () => {
  test('Turkish names the denominator of a rate first', async () => {
    await speaking('tr')
    expect(spokenRate(0.9912, 'WPLS', 'DAI')).toBe('WPLS başına 0,9912 DAI')
  })

  test('Japanese names the denominator first and writes no space before a counter', async () => {
    await speaking('ja')
    expect(spokenRate(0.9912, 'WPLS', 'DAI')).toBe('1 WPLS あたり 0.9912 DAI')
    expect(spokenDuration(7325n)).toBe('2時間2分')
  })

  test('Hindi leads with "प्रति"', async () => {
    await speaking('hi')
    expect(spokenRate(1, 'WPLS', 'DAI')).toBe('प्रति WPLS 1 DAI')
  })

  test('Arabic puts "approximately" after the figure', async () => {
    await speaking('ar')
    const said = spokenAmount(1n, 18, 'WPLS')
    expect(said.endsWith('تقريبًا')).toBe(true)
    expect(said.startsWith('تقريبًا')).toBe(false)
  })

  test('Spanish joins two units of a countdown with "y"', async () => {
    await speaking('es')
    expect(spokenDuration(90n)).toBe('1 minuto y 30 segundos')
  })

  test('Chinese writes the count against the unit with no space', async () => {
    await speaking('zh-Hans')
    expect(spokenDuration(90n)).toBe('1分钟30秒')
  })
})

describe('every language in the registry has sentences behind it', () => {
  test.each(LOCALES.map((l) => l.code))('%s speaks', async (code) => {
    await speaking(code)
    // No pattern hole left standing, and nothing falls back to the English nouns by accident.
    for (const seconds of [1n, 2n, 5n, 21n, 90n, 7325n, 200000n]) {
      const said = spokenDuration(seconds)
      expect(said).not.toContain('{')
      expect(said.length).toBeGreaterThan(0)
    }
    expect(spokenAmount(-1234567890123456789n, 18, 'WPLS')).toContain('WPLS')
    expect(spokenRate(0.9912, 'WPLS', 'DAI')).toContain('DAI')
    expect(spokenRate(0, 'WPLS', 'DAI')).not.toContain('{')
    expect(spokenDuration(0n)).not.toContain('{')
  })

  test('only English says the English words', async () => {
    const english = LOCALES.filter((l) => l.code !== 'en')
    const same: string[] = []
    for (const locale of english) {
      await speaking(locale.code)
      if (spokenDuration(90n) === '1 minute 30 seconds') same.push(locale.code)
    }
    expect(same).toEqual([])
  })
})

/**
 * The form a duration takes in each slot of a sentence, and the counts where the slots part.
 *
 * A duration inside "in two minutes" is not the phrase a dictionary prints, and it is not the
 * phrase inside "two minutes ago" either. The defect that started this lived at exactly one count,
 * in two of four units, in six of thirty-five languages: `1 minuta po otevření` where Czech says
 * `1 minutu po otevření`. From two up the two coincide, so a test that reads "2 minutes" in
 * English sees nothing.
 *
 * Five slots, because no smaller cut holds. German needs `within` apart from `measure`: `in
 * 2 Tagen` but `2 Tage nach dem Öffnen`. Czech needs `elapsed` apart from `within`: `před
 * 1 minutou` but `za 1 minutu`. Hungarian needs `span` apart from `measure`: `5 percig` but
 * `5 perc múlva`.
 *
 * So the sweep walks every language, every unit, eight counts and all five slots. A locale that
 * shifts in a slot has that shift written out below, one entry per unit, complete in every CLDR
 * category it moves. Every cell the table does not name must say the citation phrase — which is
 * what makes a table nobody expected fail here as loudly as a table somebody deleted.
 */

/** Where a slot parts from the citation form. Locale, slot, unit, the phrase per category. */
const SHIFTS: [LocaleCode, Exclude<DurationSlot, 'citation'>, DurationUnit, PluralOverride][] = [
  // ── Czech and Slovak: accusative everywhere but *ago*, instrumental there ──────────────────
  ['cs', 'measure', 'second', { one: '{n} sekundu' }],
  ['cs', 'measure', 'minute', { one: '{n} minutu' }],
  ['cs', 'measure', 'hour', { one: '{n} hodinu' }],
  ['cs', 'span', 'second', { one: '{n} sekundu' }],
  ['cs', 'span', 'minute', { one: '{n} minutu' }],
  ['cs', 'span', 'hour', { one: '{n} hodinu' }],
  ['cs', 'within', 'second', { one: '{n} sekundu' }],
  ['cs', 'within', 'minute', { one: '{n} minutu' }],
  ['cs', 'within', 'hour', { one: '{n} hodinu' }],
  ['cs', 'elapsed', 'second', { one: '{n} sekundou', few: '{n} sekundami', other: '{n} sekundami' }],
  ['cs', 'elapsed', 'minute', { one: '{n} minutou', few: '{n} minutami', other: '{n} minutami' }],
  ['cs', 'elapsed', 'hour', { one: '{n} hodinou', few: '{n} hodinami', other: '{n} hodinami' }],
  ['cs', 'elapsed', 'day', { one: '{n} dnem', few: '{n} dny', other: '{n} dny' }],
  ['sk', 'measure', 'second', { one: '{n} sekundu' }],
  ['sk', 'measure', 'minute', { one: '{n} minútu' }],
  ['sk', 'measure', 'hour', { one: '{n} hodinu' }],
  ['sk', 'span', 'second', { one: '{n} sekundu' }],
  ['sk', 'span', 'minute', { one: '{n} minútu' }],
  ['sk', 'span', 'hour', { one: '{n} hodinu' }],
  ['sk', 'within', 'second', { one: '{n} sekundu' }],
  ['sk', 'within', 'minute', { one: '{n} minútu' }],
  ['sk', 'within', 'hour', { one: '{n} hodinu' }],
  ['sk', 'elapsed', 'second', { one: '{n} sekundou', few: '{n} sekundami', other: '{n} sekundami' }],
  ['sk', 'elapsed', 'minute', { one: '{n} minútou', few: '{n} minútami', other: '{n} minútami' }],
  ['sk', 'elapsed', 'hour', { one: '{n} hodinou', few: '{n} hodinami', other: '{n} hodinami' }],
  ['sk', 'elapsed', 'day', { one: '{n} dňom', few: '{n} dňami', other: '{n} dňami' }],
  // ── Croatian: accusative, and the genitive after `prije`. `one` covers 21 and 101 too. ─────
  ['hr', 'measure', 'second', { one: '{n} sekundu' }],
  ['hr', 'measure', 'minute', { one: '{n} minutu' }],
  ['hr', 'span', 'second', { one: '{n} sekundu' }],
  ['hr', 'span', 'minute', { one: '{n} minutu' }],
  ['hr', 'within', 'second', { one: '{n} sekundu' }],
  ['hr', 'within', 'minute', { one: '{n} minutu' }],
  ['hr', 'elapsed', 'second', { one: '{n} sekunde' }],
  ['hr', 'elapsed', 'minute', { one: '{n} minute' }],
  ['hr', 'elapsed', 'hour', { one: '{n} sata' }],
  ['hr', 'elapsed', 'day', { one: '{n} dana' }],
  // ── Polish, Russian, Ukrainian: one accusative, named by all four slots ────────────────────
  ...(['measure', 'span', 'within', 'elapsed'] as const).flatMap(
    (slot): [LocaleCode, Exclude<DurationSlot, 'citation'>, DurationUnit, PluralOverride][] => [
      ['pl', slot, 'second', { one: '{n} sekundę' }],
      ['pl', slot, 'minute', { one: '{n} minutę' }],
      ['pl', slot, 'hour', { one: '{n} godzinę' }],
      ['ru', slot, 'second', { one: '{n} секунду' }],
      ['ru', slot, 'minute', { one: '{n} минуту' }],
      ['uk', slot, 'second', { one: '{n} секунду' }],
      ['uk', slot, 'minute', { one: '{n} хвилину' }],
      ['uk', slot, 'hour', { one: '{n} годину' }],
      // Arabic writes the difference only in the dual: ـان as a subject, ـين after a preposition.
      ['ar', slot, 'second', { two: 'ثانيتين' }],
      ['ar', slot, 'minute', { two: 'دقيقتين' }],
      ['ar', slot, 'hour', { two: 'ساعتين' }],
      ['ar', slot, 'day', { two: 'يومين' }],
      // Hindi reaches every one of these through a postposition, so every slot is oblique.
      ['hi', slot, 'hour', { one: '{n} घंटे' }],
    ],
  ),
  // ── German: the dative plural of Tag, and only where a preposition governs it ──────────────
  ['de', 'within', 'day', { one: '{n} Tag', other: '{n} Tagen' }],
  ['de', 'elapsed', 'day', { one: '{n} Tag', other: '{n} Tagen' }],
  // ── Finnish: the duration accusative at one, and the genitive `kuluttua` wants at every count ─
  ['fi', 'measure', 'second', { one: '{n} sekunnin' }],
  ['fi', 'measure', 'minute', { one: '{n} minuutin' }],
  ['fi', 'measure', 'hour', { one: '{n} tunnin' }],
  ['fi', 'measure', 'day', { one: '{n} päivän' }],
  ['fi', 'span', 'second', { one: '{n} sekunnin' }],
  ['fi', 'span', 'minute', { one: '{n} minuutin' }],
  ['fi', 'span', 'hour', { one: '{n} tunnin' }],
  ['fi', 'span', 'day', { one: '{n} päivän' }],
  ['fi', 'within', 'second', { one: '{n} sekunnin', other: '{n} sekunnin' }],
  ['fi', 'within', 'minute', { one: '{n} minuutin', other: '{n} minuutin' }],
  ['fi', 'within', 'hour', { one: '{n} tunnin', other: '{n} tunnin' }],
  ['fi', 'within', 'day', { one: '{n} päivän', other: '{n} päivän' }],
  // ── Hungarian: the terminative, and nothing else moves ────────────────────────────────────
  ['hu', 'span', 'second', { one: '{n} másodpercig', other: '{n} másodpercig' }],
  ['hu', 'span', 'minute', { one: '{n} percig', other: '{n} percig' }],
  ['hu', 'span', 'hour', { one: '{n} óráig', other: '{n} óráig' }],
  ['hu', 'span', 'day', { one: '{n} napig', other: '{n} napig' }],
  ['hu', 'elapsed', 'second', { one: '{n} másodperccel', other: '{n} másodperccel' }],
  ['hu', 'elapsed', 'minute', { one: '{n} perccel', other: '{n} perccel' }],
  ['hu', 'elapsed', 'hour', { one: '{n} órával', other: '{n} órával' }],
  ['hu', 'elapsed', 'day', { one: '{n} nappal', other: '{n} nappal' }],
]

const SLOTS = ['measure', 'span', 'within', 'elapsed'] as const
const UNITS: DurationUnit[] = ['second', 'minute', 'hour', 'day']
const PER_UNIT: Record<DurationUnit, number> = { second: 1, minute: 60, hour: 3600, day: 86400 }
const COUNTS = [1, 2, 3, 4, 5, 11, 21, 101]

/**
 * Whether `spokenDuration` can be made to say this count of this unit on its own.
 *
 * It carries two units at most and rolls over at the next one up, so 101 seconds is spoken as
 * "1 minute 41 seconds" and no argument reaches a bare 101 of anything but days. The counts that
 * flip a plural category — 1, 2 to 4, 5, 11, 21 — all fit inside a single unit, and 101 still runs
 * against days, where Russian and Croatian bring it back to `one`.
 */
const reachable = (unit: DurationUnit, count: number): boolean =>
  unit === 'day' || count < (unit === 'hour' ? 24 : 60)

/** Every speech module as data, so a test can read a table rather than only its output. */
const MODULES = import.meta.glob<{ default: SpeechModule }>('../i18n/speech/*.ts', { eager: true })

const TABLE_OF: Record<(typeof SLOTS)[number], (m: SpeechModule) => UnitForms | undefined> = {
  measure: (m) => m.unitsMeasure,
  span: (m) => m.unitsSpan,
  within: (m) => m.unitsWithin,
  elapsed: (m) => m.unitsElapsed,
}

/**
 * The CLDR categories this language reaches from a count this app can speak.
 *
 * Whole numbers only, and never zero — `spokenDuration` answers `noTimeLeft` at zero and never
 * hands a fraction to `Intl.PluralRules`. So Czech `many`, which is the decimal category, is not
 * a category any table here has to fill.
 */
function categoriesOf(code: LocaleCode): Intl.LDMLPluralRule[] {
  const rules = new Intl.PluralRules(code)
  const seen = new Set<Intl.LDMLPluralRule>()
  for (let n = 1; n <= 400; n++) seen.add(rules.select(n))
  for (const n of [1000, 1001, 1011, 1021, 10000]) seen.add(rules.select(n))
  return [...seen]
}

describe('a duration takes the form of the slot it lands in', () => {
  test.each(LOCALES.map((l) => l.code))('%s', async (code) => {
    await speaking(code)
    const rules = new Intl.PluralRules(code)
    for (const unit of UNITS) {
      for (const count of COUNTS) {
        if (!reachable(unit, count)) continue
        const seconds = BigInt(count * PER_UNIT[unit])
        const citation = spokenDuration(seconds)
        const category = rules.select(count)
        for (const slot of SLOTS) {
          const shift = SHIFTS.find(([l, s, u]) => l === code && s === slot && u === unit)?.[3]
          const pattern = shift?.[category]
          const want = pattern ? pattern.replace('{n}', num(code, count)) : citation
          expect(spokenDuration(seconds, slot), `${code} · ${slot} · ${count} ${unit}`).toBe(want)
        }
      }
    }
  })

  test('every entry in the table is reachable, and every one of them earns its place', async () => {
    for (const [code, slot, unit, forms] of SHIFTS) {
      await speaking(code)
      const rules = new Intl.PluralRules(code)
      const reached = COUNTS.filter(
        (c) => reachable(unit, c) && forms[rules.select(c)] !== undefined,
      )
      expect(reached, `${code} · ${slot} · ${unit} names no count the sweep walks`).not.toEqual([])
      // At least one of those counts must actually sound different. A single category may coincide
      // with the citation form by accident — the Czech instrumental plural of `den` is `dny`, and
      // so is the nominative plural — but a whole entry that changes nothing is dead weight.
      const moved = reached.filter((count) => {
        const seconds = BigInt(count * PER_UNIT[unit])
        return spokenDuration(seconds) !== spokenDuration(seconds, slot)
      })
      expect(
        moved,
        `${code} · ${slot} · ${unit} says the citation phrase at every count`,
      ).not.toEqual([])
    }
  })

  /**
   * A table that moves its floor must name every category the language reaches.
   *
   * The lookup runs `slot[category] ?? citation[category] ?? slot.other ?? citation.other`, so a
   * table holding only `other` loses at one: `citation.one` exists and wins before the slot floor
   * is ever consulted. Hungarian is the language that shows it — `1 perccel ezelőtt` would come
   * back as `1 perc ezelőtt` from a table that named only the plural.
   *
   * The rule is narrow on purpose. A table that names `one` or `two` alone is the "moves at one
   * count" shape and stays exempt; a table that names `other` is inflecting the noun across the
   * board, and then silence about `one` is indistinguishable from forgetting. German is the one
   * language here whose floor moves while its singular does not, and this makes it say so.
   *
   * What the guard cannot do: tell a category that is correctly unchanged from one nobody thought
   * about. Nothing can, from the outside — the rendered strings are identical either way. This is
   * the honest weaker version: it catches the shape that hides the difference.
   */
  test('a slot table that moves its floor names every category the language reaches', () => {
    for (const locale of LOCALES) {
      const speech = MODULES[`../i18n/speech/${locale.code}.ts`]?.default
      expect(speech, `no speech module for ${locale.code}`).toBeDefined()
      if (!speech) continue
      const reachable = categoriesOf(locale.code)
      for (const slot of SLOTS) {
        const table = TABLE_OF[slot](speech)
        if (!table) continue
        for (const [unit, forms] of Object.entries(table)) {
          if (forms?.other === undefined) continue
          for (const category of reachable) {
            expect(
              forms[category],
              `${locale.code} · ${slot} · ${unit} moves its floor but says nothing about ` +
                `\`${category}\`, which this language reaches`,
            ).toBeDefined()
          }
        }
      }
    }
  })

  test('the citation slot is what a caller that names no slot gets', async () => {
    await speaking('cs')
    expect(spokenDuration(60n)).toBe(spokenDuration(60n, 'citation'))
    expect(spokenDuration(60n)).toBe('1 minuta')
    expect(spokenDuration(60n, 'measure')).toBe('1 minutu')
    expect(spokenDuration(60n, 'elapsed')).toBe('1 minutou')
  })
})

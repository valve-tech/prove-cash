import { formatUnits } from 'viem'
import enSpeech from '../i18n/speech/en.ts'
import type {
  DurationUnit,
  Plural,
  PluralOverride,
  SpeechModule,
  UnitForms,
} from '../i18n/speech/shape.ts'
import { getLocale, setLocale, type LocaleCode } from './i18n.ts'

/**
 * What the numbers on this page sound like.
 *
 * The screen is allowed to truncate: `0x7a3f…c19d` and `≈1.2M WPLS` are readable at a glance and
 * they save room. Spoken, both are useless — one is not an address and the other is not an
 * amount. So every shortened figure carries a full one beside it, in `sr-only` text or an
 * `aria-label`, and this module is the single place that writes those.
 *
 * The rule the whole file follows: never let a spoken number be quieter than the printed one.
 * Where precision is dropped, the word "approximately" says so.
 *
 * These sentences used to be built by glueing English words to numbers, which is a thing only
 * English survives. Turkish names the denominator of a rate before the numerator; Japanese writes
 * no space before a counter; Russian picks one of three nouns from the last two digits of a count.
 * So the words are gone from this file. Each language owns whole patterns in `src/i18n/speech/`,
 * this module fills the holes, and `Intl.PluralRules` — never a hand-rolled `n === 1` — decides
 * which form of a noun a count asks for.
 *
 * Every figure goes through `Intl.NumberFormat` in the active language on its way into a pattern,
 * so a German reader hears `1.234,5`. Token symbols and addresses go through untouched: they are
 * names, not words.
 *
 * The functions stay synchronous because they are called from render. A language whose module has
 * not arrived yet speaks English and starts the download; when it lands, `announce` nudges the
 * store so the tree draws again with the real sentences.
 */

/** Cap on spoken fraction digits. Past this a number stops being listenable. */
const MAX_FRACTION = 8

/**
 * Every speech module but English, behind an import Vite can see.
 *
 * Written out rather than built from the registry, for the same reason `i18n.ts` writes its
 * dictionary table out: a literal path is what makes each of these its own chunk, and a table the
 * compiler checks is what stops a new registry row from shipping a language with no file behind it.
 */
const LOADERS: Record<Exclude<LocaleCode, 'en'>, () => Promise<{ default: SpeechModule }>> = {
  'zh-Hans': () => import('../i18n/speech/zh-Hans.ts'),
  'zh-Hant': () => import('../i18n/speech/zh-Hant.ts'),
  ja: () => import('../i18n/speech/ja.ts'),
  ko: () => import('../i18n/speech/ko.ts'),
  fr: () => import('../i18n/speech/fr.ts'),
  de: () => import('../i18n/speech/de.ts'),
  es: () => import('../i18n/speech/es.ts'),
  'es-419': () => import('../i18n/speech/es-419.ts'),
  it: () => import('../i18n/speech/it.ts'),
  'pt-BR': () => import('../i18n/speech/pt-BR.ts'),
  'pt-PT': () => import('../i18n/speech/pt-PT.ts'),
  nl: () => import('../i18n/speech/nl.ts'),
  sv: () => import('../i18n/speech/sv.ts'),
  da: () => import('../i18n/speech/da.ts'),
  nb: () => import('../i18n/speech/nb.ts'),
  fi: () => import('../i18n/speech/fi.ts'),
  ru: () => import('../i18n/speech/ru.ts'),
  pl: () => import('../i18n/speech/pl.ts'),
  tr: () => import('../i18n/speech/tr.ts'),
  ar: () => import('../i18n/speech/ar.ts'),
  he: () => import('../i18n/speech/he.ts'),
  th: () => import('../i18n/speech/th.ts'),
  vi: () => import('../i18n/speech/vi.ts'),
  id: () => import('../i18n/speech/id.ts'),
  ms: () => import('../i18n/speech/ms.ts'),
  hi: () => import('../i18n/speech/hi.ts'),
  el: () => import('../i18n/speech/el.ts'),
  cs: () => import('../i18n/speech/cs.ts'),
  sk: () => import('../i18n/speech/sk.ts'),
  hu: () => import('../i18n/speech/hu.ts'),
  ro: () => import('../i18n/speech/ro.ts'),
  uk: () => import('../i18n/speech/uk.ts'),
  hr: () => import('../i18n/speech/hr.ts'),
  ca: () => import('../i18n/speech/ca.ts'),
}

const loaded = new Map<LocaleCode, SpeechModule>([['en', enSpeech]])
const inFlight = new Map<LocaleCode, Promise<void>>()
// A download that failed is not retried. `speech()` runs on every render, and a reader offline in
// Warsaw does not need one request per frame to find that out again.
const failed = new Set<LocaleCode>()

/**
 * Tell the tree the sentences changed.
 *
 * `setLocale` with the language already selected does nothing but emit, and emitting is the whole
 * point: the components re-render, call back in here, and this time find the module. It is the one
 * door `i18n.ts` leaves open to a module that is not a component, and a second call is cheap
 * because the dictionary is already in that module's cache by now.
 */
function announce(code: LocaleCode): void {
  if (getLocale() === code) void setLocale(code)
}

/**
 * Fetch one language's sentences.
 *
 * Fire and forget from render; awaited from tests and from anything that wants to warm the cache
 * before a reader hears English by accident. A failed download is not an error a reader can act
 * on — they keep the English sentences, which say the right thing in the wrong language.
 */
export function loadSpeech(code: LocaleCode): Promise<void> {
  if (loaded.has(code) || failed.has(code)) return Promise.resolve()
  const already = inFlight.get(code)
  if (already) return already
  const pending = LOADERS[code as Exclude<LocaleCode, 'en'>]()
    .then((mod) => {
      loaded.set(code, mod.default)
      announce(code)
    })
    .catch(() => {
      failed.add(code)
    })
    .finally(() => inFlight.delete(code))
  inFlight.set(code, pending)
  return pending
}

/** The active language's sentences, or English while its module is still on the wire. */
function speech(): { locale: LocaleCode; words: SpeechModule } {
  const locale = getLocale()
  const words = loaded.get(locale)
  if (words) return { locale, words }
  void loadSpeech(locale)
  // English words, but the active locale still formats the numbers: half-right beats half-wrong.
  return { locale, words: enSpeech }
}

/** `{name}` filled in. A hole with no value is left standing, so a broken pattern reads as a gap. */
function fill(pattern: string, vars: Record<string, string>): string {
  return pattern.replace(/\{(\w+)\}/g, (whole, name: string) => vars[name] ?? whole)
}

const pluralRules = new Map<LocaleCode, Intl.PluralRules>()

/**
 * The form of a noun this count asks for, in this language. CLDR decides, not a comparison.
 *
 * `over` is the same noun in the form one slot needs, and it wins wherever it speaks. It is sparse
 * on purpose, so the search runs through four places: this category in the slot's table, this
 * category in the citation table, the slot's floor, the citation floor. A language that overrides
 * `minute.one` and nothing else lands on the citation form for every other cell.
 */
function pluralOf(locale: LocaleCode, forms: Plural, count: number, over?: PluralOverride): string {
  let rules = pluralRules.get(locale)
  if (!rules) {
    rules = new Intl.PluralRules(locale)
    pluralRules.set(locale, rules)
  }
  const category = rules.select(count)
  return over?.[category] ?? forms[category] ?? over?.other ?? forms.other
}

const decimalFormats = new Map<string, Intl.NumberFormat>()

/**
 * A whole part and a fraction part, grouped and pointed the way this language does it.
 *
 * The two halves arrive as digit strings and go into `format` as one, because a token amount can
 * carry more significant digits than a `number` holds and rounding a balance is the one thing this
 * module exists to prevent.
 */
function formatDecimal(locale: LocaleCode, whole: string, fraction: string): string {
  const key = `${locale}:${fraction.length}`
  let format = decimalFormats.get(key)
  if (!format) {
    format = new Intl.NumberFormat(locale, {
      minimumFractionDigits: fraction.length,
      maximumFractionDigits: fraction.length,
    })
    decimalFormats.set(key, format)
  }
  const text = fraction ? `${whole}.${fraction}` : whole
  // `format` takes a decimal string as well as a number, and only that overload keeps every digit.
  // The cast is the assertion that `formatUnits` handed us digits, which it always does.
  return format.format(text as Intl.StringNumericLiteral)
}

const countFormats = new Map<LocaleCode, Intl.NumberFormat>()

/** A count of seconds or days. Ungrouped, because a countdown is spoken, not tabulated. */
function formatCount(locale: LocaleCode, count: number): string {
  let format = countFormats.get(locale)
  if (!format) {
    format = new Intl.NumberFormat(locale, { useGrouping: false })
    countFormats.set(locale, format)
  }
  return format.format(count)
}

const rateFormats = new Map<LocaleCode, Intl.NumberFormat>()

/** A rate, at the six significant digits the screen shows. */
function formatRate(locale: LocaleCode, rate: number): string {
  let format = rateFormats.get(locale)
  if (!format) {
    format = new Intl.NumberFormat(locale, { maximumSignificantDigits: 6 })
    rateFormats.set(locale, format)
  }
  return format.format(Number(rate.toPrecision(6)))
}

/**
 * The amount sentence both public amount functions build.
 *
 * The three wrappers nest rather than concatenate, so a language decides where each one goes:
 * Arabic puts "تقريبًا" after the figure and English puts "approximately" in front of it, and
 * neither has to know what the other does.
 */
function amountSentence(
  raw: bigint,
  decimals: number,
  symbol: string | undefined,
  alwaysApproximate: boolean,
): string {
  const { locale, words } = speech()
  const text = formatUnits(raw, decimals)
  const negative = text.startsWith('-')
  const [whole, frac = ''] = (negative ? text.slice(1) : text).split('.')
  const trimmed = frac.replace(/0+$/, '')
  const kept = trimmed.slice(0, MAX_FRACTION)

  let sentence = formatDecimal(locale, whole ?? '0', kept)
  if (symbol) sentence = fill(words.amount, { value: sentence, symbol })
  if (negative) sentence = fill(words.minus, { value: sentence })
  if (alwaysApproximate || kept.length < trimmed.length) {
    sentence = fill(words.approximately, { value: sentence })
  }
  return sentence
}

/** A base-unit amount as a full grouped decimal. Marked approximate only if digits are dropped. */
export function spokenAmount(raw: bigint, decimals: number, symbol?: string): string {
  return amountSentence(raw, decimals, symbol, false)
}

/** The same, for a figure the screen already prints compacted. Always says "approximately". */
export function spokenCompact(raw: bigint, decimals: number, symbol?: string): string {
  return amountSentence(raw, decimals, symbol, true)
}

/** A truncated address, restored. A reader's own AT decides how to spell it out. */
export function spokenAddress(address: string): string {
  return address
}

/**
 * Which slot of which sentence the phrase is going into.
 *
 * Five, because a two-way split is too coarse and German proves it: a bare German measure is a
 * nominative — `2 Tage nach dem Öffnen` — while `in`, `nach` and `vor` govern the dative, so
 * `in 2 Tagen`. One language, two requirements, and both are adverbs. Czech shows the other edge:
 * `za` takes the accusative and `před` takes the instrumental. Hungarian forces the fifth: it
 * marks "for a period" on the noun with `-ig` and leaves a bare measure alone, so `5 percig` and
 * `5 perc múlva` cannot share a slot either.
 *
 * So the slot names the shape of the host sentence, never a case. A locale author answers "what
 * does my language do after a preposition meaning *ago*", which they can decide; they are never
 * asked to know that the answer is called an instrumental.
 *
 * Nothing beyond these five has turned up in thirty-five languages, and each of the four beyond
 * `citation` is forced by at least one of them.
 *
 * - `citation` — a bare figure with no host. A chip's own name.
 * - `measure` — a bare adverbial measure of distance: `{duration} after it opens`.
 * - `span` — the period something lasts or holds: `firm for {duration}`.
 * - `within` — after a preposition meaning in or after: `expires in {duration}`.
 * - `elapsed` — after a preposition meaning ago: `{duration} ago`.
 *
 * The slot is a fact about the English sentence. A translator whose language reaches that sentence
 * through a preposition of its own answers for the construction they actually wrote: Hindi renders
 * every one of these with a postposition, so all three of its non-citation slots take the oblique.
 */
export type DurationSlot = 'citation' | 'measure' | 'span' | 'within' | 'elapsed'

/** The table this slot reads, or nothing if the language says the citation form here. */
function formsFor(words: SpeechModule, slot: DurationSlot): UnitForms | undefined {
  if (slot === 'measure') return words.unitsMeasure
  if (slot === 'span') return words.unitsSpan
  if (slot === 'within') return words.unitsWithin
  if (slot === 'elapsed') return words.unitsElapsed
  return undefined
}

/**
 * Seconds as words, two units deep. Countdowns and cooldowns both use it.
 *
 * The default is the citation slot, because a phrase with no sentence around it is the safe read:
 * a language that supplies no table gets the same words in every slot anyway.
 */
export function spokenDuration(seconds: bigint, slot: DurationSlot = 'citation'): string {
  const { locale, words } = speech()
  if (seconds <= 0n) return words.noTimeLeft

  const total = Number(seconds)
  const over = formsFor(words, slot)
  const said = (count: number, unit: DurationUnit) =>
    fill(pluralOf(locale, words.units[unit], count, over?.[unit]), {
      n: formatCount(locale, count),
    })
  const both = (first: string, second: string) => fill(words.joinDuration, { first, second })

  if (total < 60) return said(total, 'second')
  if (total < 3600) {
    const minutes = Math.floor(total / 60)
    const rest = total % 60
    return rest ? both(said(minutes, 'minute'), said(rest, 'second')) : said(minutes, 'minute')
  }
  if (total < 86400) {
    const hours = Math.floor(total / 3600)
    const rest = Math.floor((total % 3600) / 60)
    return rest ? both(said(hours, 'hour'), said(rest, 'minute')) : said(hours, 'hour')
  }
  const days = Math.floor(total / 86400)
  const rest = Math.floor((total % 86400) / 3600)
  return rest ? both(said(days, 'day'), said(rest, 'hour')) : said(days, 'day')
}

/** An exchange rate with both units named, so "0.9912" cannot be heard bare. */
export function spokenRate(rate: number, symbolIn: string, symbolOut: string): string {
  const { locale, words } = speech()
  if (!isFinite(rate) || rate === 0) return fill(words.noRate, { in: symbolIn, out: symbolOut })
  return fill(words.rate, {
    value: formatRate(locale, rate),
    in: symbolIn,
    out: symbolOut,
  })
}

import { useSyncExternalStore } from 'react'
import { en, type Key, type LocaleDict } from '../i18n/en.ts'

/**
 * The app in the reader's language.
 *
 * One selection, held in this module, written to `localStorage` and applied to the document. There
 * is no provider and no context: a language is a property of the browser, not of a subtree, and a
 * context would make every component that reads a string take a dependency on a parent that
 * wraps it. `useLocale()` subscribes a component to the change instead.
 *
 * English is the only dictionary that loads with the app. Every other one is a dynamic import, so
 * the reader who never opens the picker pays nothing for the other thirty-four. A dictionary is a
 * `Partial<Dict>`: an untranslated key falls through to English rather than showing a reader the
 * key itself, which is the one thing a missing translation must never do.
 *
 * The registry is Apple's system-language list, folded by script where a regional variant says
 * nothing this app says differently. The fold rules live in `fold()` below, because "we support
 * the languages Apple supports" is only honest if the folding is written down.
 */

export type LocaleCode =
  | 'en'
  | 'zh-Hans'
  | 'zh-Hant'
  | 'ja'
  | 'ko'
  | 'fr'
  | 'de'
  | 'es'
  | 'es-419'
  | 'it'
  | 'pt-BR'
  | 'pt-PT'
  | 'nl'
  | 'sv'
  | 'da'
  | 'nb'
  | 'fi'
  | 'ru'
  | 'pl'
  | 'tr'
  | 'ar'
  | 'he'
  | 'th'
  | 'vi'
  | 'id'
  | 'ms'
  | 'hi'
  | 'el'
  | 'cs'
  | 'sk'
  | 'hu'
  | 'ro'
  | 'uk'
  | 'hr'
  | 'ca'

export type Locale = {
  code: LocaleCode
  /** The language's name in itself. This is the primary label, because it is the one a speaker reads. */
  endonym: string
  /** The English name, so a reader who cannot yet read the endonym can still search for it. */
  exonym: string
  /** Right to left. Arabic and Hebrew; nothing else on the list. */
  rtl?: true
}

/**
 * Every language the picker offers, in the order it draws them: English first, then the rest by
 * script family the way Apple groups them. Adding a language is one row here and one file in
 * `src/i18n/`.
 */
export const LOCALES: readonly Locale[] = [
  { code: 'en', endonym: 'English', exonym: 'English' },
  { code: 'zh-Hans', endonym: '简体中文', exonym: 'Chinese (Simplified)' },
  { code: 'zh-Hant', endonym: '繁體中文', exonym: 'Chinese (Traditional)' },
  { code: 'ja', endonym: '日本語', exonym: 'Japanese' },
  { code: 'ko', endonym: '한국어', exonym: 'Korean' },
  { code: 'fr', endonym: 'Français', exonym: 'French' },
  { code: 'de', endonym: 'Deutsch', exonym: 'German' },
  { code: 'es', endonym: 'Español', exonym: 'Spanish' },
  { code: 'es-419', endonym: 'Español (Latinoamérica)', exonym: 'Spanish (Latin America)' },
  { code: 'it', endonym: 'Italiano', exonym: 'Italian' },
  { code: 'pt-BR', endonym: 'Português (Brasil)', exonym: 'Portuguese (Brazil)' },
  { code: 'pt-PT', endonym: 'Português (Portugal)', exonym: 'Portuguese (Portugal)' },
  { code: 'nl', endonym: 'Nederlands', exonym: 'Dutch' },
  { code: 'sv', endonym: 'Svenska', exonym: 'Swedish' },
  { code: 'da', endonym: 'Dansk', exonym: 'Danish' },
  { code: 'nb', endonym: 'Norsk bokmål', exonym: 'Norwegian Bokmål' },
  { code: 'fi', endonym: 'Suomi', exonym: 'Finnish' },
  { code: 'ru', endonym: 'Русский', exonym: 'Russian' },
  { code: 'pl', endonym: 'Polski', exonym: 'Polish' },
  { code: 'tr', endonym: 'Türkçe', exonym: 'Turkish' },
  { code: 'ar', endonym: 'العربية', exonym: 'Arabic', rtl: true },
  { code: 'he', endonym: 'עברית', exonym: 'Hebrew', rtl: true },
  { code: 'th', endonym: 'ไทย', exonym: 'Thai' },
  { code: 'vi', endonym: 'Tiếng Việt', exonym: 'Vietnamese' },
  { code: 'id', endonym: 'Bahasa Indonesia', exonym: 'Indonesian' },
  { code: 'ms', endonym: 'Bahasa Melayu', exonym: 'Malay' },
  { code: 'hi', endonym: 'हिन्दी', exonym: 'Hindi' },
  { code: 'el', endonym: 'Ελληνικά', exonym: 'Greek' },
  { code: 'cs', endonym: 'Čeština', exonym: 'Czech' },
  { code: 'sk', endonym: 'Slovenčina', exonym: 'Slovak' },
  { code: 'hu', endonym: 'Magyar', exonym: 'Hungarian' },
  { code: 'ro', endonym: 'Română', exonym: 'Romanian' },
  { code: 'uk', endonym: 'Українська', exonym: 'Ukrainian' },
  { code: 'hr', endonym: 'Hrvatski', exonym: 'Croatian' },
  { code: 'ca', endonym: 'Català', exonym: 'Catalan' },
]

const BY_CODE = new Map(LOCALES.map((l) => [l.code.toLowerCase(), l]))

/**
 * The URL a language lives at.
 *
 * English is `/`, and every other locale is `/<code>/` in lower case — `/ja/`, `/pt-br/`,
 * `/zh-hans/`. Lower case because a URL is compared byte for byte by every crawler and half the
 * link-sharing software in the world, and `/zh-Hans/` and `/zh-hans/` would be two pages with one
 * body. The registry keeps the canonical spelling for the `hreflang` attribute, which is a BCP-47
 * tag rather than a path and wants its script subtag capitalised.
 *
 * A language needs its own URL before a search engine can hold an opinion about it. The run-time
 * picker is invisible to a crawler: Googlebot fetches with `Accept-Language: en` and reports one
 * language in `navigator.languages`, so a page that reads the browser answers English every time
 * and thirty-four translations index as nothing at all. `scripts/prerender.ts` writes one HTML
 * file per path from these strings.
 */
export function pathForLocale(code: LocaleCode): string {
  return code === 'en' ? '/' : `/${code.toLowerCase()}/`
}

/**
 * The locale a path names, or null when it names none.
 *
 * Only the first segment, and only an exact registry code — no folding. A path is a claim about
 * which page this is, not a hint about the reader, so `/de-at/` is a 404-shaped miss rather than
 * a quiet redirect to German. Folding belongs to `fold()`, which reads what a browser offers.
 */
export function localeFromPath(pathname: string): LocaleCode | null {
  const first = pathname.split('/')[1] ?? ''
  if (!first) return null
  return BY_CODE.get(first.toLowerCase())?.code ?? null
}

/** The one whose dictionary is loaded, or English if the code names nothing. */
export function localeOf(code: string): Locale {
  return BY_CODE.get(code.toLowerCase()) ?? LOCALES[0]
}

export function isLocale(code: unknown): code is LocaleCode {
  return typeof code === 'string' && BY_CODE.has(code.toLowerCase())
}

/**
 * Every dictionary but English, behind an import Vite can see.
 *
 * Written out rather than built from the registry with a template literal. A literal path is what
 * makes each of these its own chunk in the build, and a table the compiler checks is what stops a
 * new registry row from shipping a locale with no file behind it.
 */
const LOADERS: Record<Exclude<LocaleCode, 'en'>, () => Promise<{ default: LocaleDict }>> = {
  'zh-Hans': () => import('../i18n/zh-Hans.ts'),
  'zh-Hant': () => import('../i18n/zh-Hant.ts'),
  ja: () => import('../i18n/ja.ts'),
  ko: () => import('../i18n/ko.ts'),
  fr: () => import('../i18n/fr.ts'),
  de: () => import('../i18n/de.ts'),
  es: () => import('../i18n/es.ts'),
  'es-419': () => import('../i18n/es-419.ts'),
  it: () => import('../i18n/it.ts'),
  'pt-BR': () => import('../i18n/pt-BR.ts'),
  'pt-PT': () => import('../i18n/pt-PT.ts'),
  nl: () => import('../i18n/nl.ts'),
  sv: () => import('../i18n/sv.ts'),
  da: () => import('../i18n/da.ts'),
  nb: () => import('../i18n/nb.ts'),
  fi: () => import('../i18n/fi.ts'),
  ru: () => import('../i18n/ru.ts'),
  pl: () => import('../i18n/pl.ts'),
  tr: () => import('../i18n/tr.ts'),
  ar: () => import('../i18n/ar.ts'),
  he: () => import('../i18n/he.ts'),
  th: () => import('../i18n/th.ts'),
  vi: () => import('../i18n/vi.ts'),
  id: () => import('../i18n/id.ts'),
  ms: () => import('../i18n/ms.ts'),
  hi: () => import('../i18n/hi.ts'),
  el: () => import('../i18n/el.ts'),
  cs: () => import('../i18n/cs.ts'),
  sk: () => import('../i18n/sk.ts'),
  hu: () => import('../i18n/hu.ts'),
  ro: () => import('../i18n/ro.ts'),
  uk: () => import('../i18n/uk.ts'),
  hr: () => import('../i18n/hr.ts'),
  ca: () => import('../i18n/ca.ts'),
}

// Latin America takes its own Spanish. Spain's Spanish is the plain `es` row, so only the regions
// on this list fold the other way.
const LATIN_AMERICA = new Set([
  'ar', 'bo', 'cl', 'co', 'cr', 'cu', 'do', 'ec', 'gt', 'hn', 'mx', 'ni', 'pa', 'pe', 'pr', 'py',
  'sv', 'us', 'uy', 've',
])

// Where traditional characters are read. Everywhere else that writes Chinese gets simplified.
const TRADITIONAL = new Set(['tw', 'hk', 'mo'])

/**
 * The registry entry a BCP-47 tag asks for, or null when the registry has nothing for it.
 *
 * Three passes, narrowest first: the exact code, then the folds a script or a region decides, then
 * the plain base language. `es-MX` folds to Latin American Spanish because the region says so;
 * `de-AT` falls to German because nothing on this screen is different in Austria.
 */
export function fold(tag: string): LocaleCode | null {
  const lower = tag.toLowerCase()
  const exact = BY_CODE.get(lower)
  if (exact) return exact.code

  const parts = lower.split('-')
  const base = parts[0]
  const region = parts.length > 1 ? parts[parts.length - 1] : ''

  if (base === 'zh') {
    return parts.includes('hant') || TRADITIONAL.has(region) ? 'zh-Hant' : 'zh-Hans'
  }
  if (base === 'es') return LATIN_AMERICA.has(region) ? 'es-419' : 'es'
  if (base === 'pt') return region === 'br' ? 'pt-BR' : 'pt-PT'
  // Norwegian has three tags and one dictionary. Nynorsk readers read bokmål.
  if (base === 'no' || base === 'nn' || base === 'nb') return 'nb'
  // The codes Java and older browsers still emit for Hebrew and Indonesian.
  if (base === 'iw') return 'he'
  if (base === 'in') return 'id'

  return LOCALES.find((l) => l.code.split('-')[0] === base)?.code ?? null
}

/** The first tag the browser offers that the registry can answer. English when none of them are. */
export function resolveLocale(languages: readonly string[]): LocaleCode {
  for (const tag of languages) {
    const hit = fold(tag)
    if (hit) return hit
  }
  return 'en'
}

const STORAGE_KEY = 'prove.locale'

// Safari in private mode throws on `localStorage`, and so does a browser with storage blocked.
// Neither is a reason to fail to draw the app in English.
function stored(): LocaleCode | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return isLocale(raw) ? raw : null
  } catch {
    return null
  }
}

function remember(code: LocaleCode): void {
  try {
    localStorage.setItem(STORAGE_KEY, code)
  } catch {
    // A reader who cannot be remembered still gets the language they picked, until they reload.
  }
}

let current: LocaleCode = 'en'
let active: LocaleDict = en
const loaded = new Map<LocaleCode, LocaleDict>([['en', en]])

// The snapshot is a counter rather than the code, because a dictionary arriving is a change the
// tree has to see and the code has not moved by then.
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version++
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The language the app is drawing in. */
export function getLocale(): LocaleCode {
  return current
}

/**
 * Keep the language the reader is reading in.
 *
 * The bootstrap does not store a language it read off the URL, so a shared `/ja/` link does not
 * make somebody's browser Japanese for good. Crossing from the landing page into the app is the
 * moment that changes: the reader is not glancing at a link any more, and the app has no locale
 * in its own URL to fall back on. Called from the button that crosses.
 */
export function keepLocale(): void {
  remember(current)
}

/**
 * The scripts that survive letter-spacing.
 *
 * Everything here draws one standalone glyph per character, so a track between them is a style
 * choice. The alphabets do not join, and the CJK and Hangul blocks are already square.
 *
 * The list is an allowlist, and that is the whole point. A denylist has to grow every time a
 * locale arrives, and the day it does not grow is the day a reader gets broken words. An
 * unrecognised script gets no tracking, which is at worst a flatter label.
 */
const TRACKABLE = new Set([
  'Latn',
  'Cyrl',
  'Grek',
  'Hebr',
  'Armn',
  'Geor',
  'Hani',
  'Hans',
  'Hant',
  'Jpan',
  'Hira',
  'Kana',
  // `ko` maximizes to `Kore`, not `Hang` — Korean's script code covers Hangul with Hanja. `Hang`
  // stays for an explicit `ko-Hang`. A test caught this, which is the argument for having one.
  'Kore',
  'Hang',
])

/**
 * Does this locale's script tolerate letter-spacing?
 *
 * Twenty-seven labels carry `tracking-wider`. That is a good look for an English eyebrow and a
 * rendering fault elsewhere. Arabic is cursive, so a track cuts the joins and a word comes apart
 * into unconnected shapes. Devanagari builds conjuncts from stacked consonants, and a track pulls
 * them into letters that spell something else. Thai writes without word spaces, so a track reads
 * as a break that is not there.
 *
 * The script comes from the locale rather than from a list of locale codes, so `fa`, `ur`, `bn`
 * and `ta` are already handled on the day somebody adds them. `maximize` is what fills the script
 * in: `hi` alone carries no script subtag, and `hi-Deva` is what it means.
 */
function tracks(code: LocaleCode): boolean {
  try {
    const script = new Intl.Locale(code).maximize().script
    return script !== undefined && TRACKABLE.has(script)
  } catch {
    // No `Intl.Locale` here. Flat labels are the safe half of this choice.
    return false
  }
}

function applyDocument(code: LocaleCode): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = code
  document.documentElement.dir = localeOf(code).rtl ? 'rtl' : 'ltr'
  // Tailwind compiles `tracking-wider` to `letter-spacing: var(--tracking-wider)`, so one
  // attribute here reaches all twenty-seven of them through `index.css`.
  document.documentElement.dataset.tracking = tracks(code) ? 'on' : 'off'
  // The tab, the bookmark and the entry in the browser's history. The served HTML carries this
  // title in the language of the URL, and a reader who changes language without leaving the page
  // would otherwise keep the old one — right in the two places they cannot see it to fix. Only
  // the title: the description and the canonical are read by crawlers, and a crawler gets the
  // page `scripts/prerender.ts` wrote rather than anything this function does.
  //
  // Called twice per change, because the dictionary arrives after `lang` and `dir` do.
  document.title = t('seo.title')
}

/**
 * Change language.
 *
 * The code, the document and the stored choice change at once; the dictionary follows over the
 * network. Between the two the reader sees English in a page already marked with the new language,
 * which is a few hundred milliseconds and the honest state of things. A second call while the
 * first is in flight wins — the stale one drops its dictionary on arrival.
 */
export async function setLocale(code: LocaleCode, opts?: { remember?: boolean }): Promise<void> {
  current = code
  // Reading a language off the URL is not the reader choosing one. See the bootstrap below.
  if (opts?.remember !== false) remember(code)
  applyDocument(code)

  const cached = loaded.get(code)
  if (cached) {
    active = cached
    applyDocument(code)
    emit()
    return
  }

  active = en
  emit()

  const dict = await LOADERS[code as Exclude<LocaleCode, 'en'>]()
    .then((mod) => mod.default)
    .catch(() => null)
  // A language the reader has already moved on from must not overwrite the one they are reading.
  if (current !== code) return
  if (!dict) return
  loaded.set(code, dict)
  active = dict
  // Again, now that there is a dictionary to read the title out of.
  applyDocument(code)
  emit()
}

/**
 * A string in the active language, with `{name}` filled in.
 *
 * Three answers, in order: the active dictionary, English, and the key. The last one cannot happen
 * from TypeScript — `Key` is `keyof Dict` — and exists so a call from untyped code shows something
 * rather than nothing. A placeholder with no matching variable is left as it stands, so a broken
 * translation reads as a gap rather than as `undefined`.
 */
/**
 * A number, written the way this reader writes numbers.
 *
 * Every figure on a translated screen used to go through `toLocaleString('en-US')` or `toFixed`,
 * and both put a dot on the decimal and a comma on the thousands. Two thirds of the locales here
 * do the opposite. A German reader met a block number of `23,456,789` and a fee of `0.30%`, so the
 * comma read as a decimal point and the number said nothing true. No translation can fix that,
 * because the digits arrive at run time and never pass through a locale file.
 *
 * **Only for a number a person reads.** A number a parser reads — SVG path data, `parseUnits`,
 * anything that must carry a dot — keeps `toFixed`. Those are not text, and a comma breaks them.
 *
 * An unknown tag makes `Intl` throw, so this falls back to English rather than blanking a screen.
 */
export function num(v: number | bigint, opts?: Intl.NumberFormatOptions): string {
  // `Intl.NumberFormat` rather than `toLocaleString`: the latter has one overload for a number and
  // another for a bigint, and a `number | bigint` argument satisfies neither.
  try {
    return new Intl.NumberFormat(current, opts).format(v)
  } catch {
    return new Intl.NumberFormat('en', opts).format(v)
  }
}

/** A number with exactly this many decimals, in the reader's locale. Replaces `toFixed` in copy. */
export function fixed(v: number, places: number): string {
  return num(v, { minimumFractionDigits: places, maximumFractionDigits: places })
}

/**
 * A fee rate, as a percentage the reader's locale writes correctly.
 *
 * The rate is a fraction of one ether, so 5e14 is 0.05%. The unit belongs here rather than in a
 * translated sentence, and that is the point: `batch.bound` used to read "{bps} bps" and its
 * spoken twin "{bps} basis points", which pasted a number in front of a fixed noun. Nine
 * languages inflect a noun after a numeral and none of them could be right at every value —
 * Arabic was wrong at the shipped default. A percent sign inflects in no language, so the whole
 * class of defect goes with the word.
 *
 * Trailing zeros are dropped, so an ordinary rate reads "0.05%" and a fine one keeps the digits
 * it needs. Six decimals is a millionth of a per cent, well past anything a person reads.
 */
export function rate(v: bigint): string {
  const pct = Number(v) / 1e16
  return num(pct, { maximumFractionDigits: 6 }) + '%'
}

export function t(key: Key, vars?: Record<string, string | number>): string {
  const raw = active[key] ?? en[key] ?? String(key)
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}

/**
 * Two bidi isolates, for the places an element cannot carry the job.
 *
 * `<bdi>` and `unicode-bidi: isolate` are the right tools and the app already uses them. These
 * are for the two cases where there is no element to hang them on: a string handed to `t()` as a
 * placeholder value, and text inside an SVG `<text>`, which has no `<bdi>`.
 *
 * The characters are invisible in an editor, so here they are by name. U+2066 LEFT-TO-RIGHT
 * ISOLATE, U+2068 FIRST STRONG ISOLATE, U+2069 POP DIRECTIONAL ISOLATE.
 */
const PDI = '\u2069'

/**
 * Force one run left-to-right, whatever paragraph it lands in.
 *
 * For a technical token or a written expression — a `msgboard_` prefix, `\u22641`, `A\u2192B`. Two things
 * go wrong without it. A neutral character at either end takes the paragraph direction and moves
 * to the far side of the run, so a Hebrew reader sees `_msgboard` for a prefix they have to type.
 * And a mirrorable character resolved to an odd level is DRAWN mirrored: `\u22641` inside Hebrew text
 * renders as `\u22651`, which is the opposite claim.
 */
export const ltr = (s: string) => `\u2066${s}${PDI}`

/**
 * Let one run pick its own direction from its own first strong character.
 *
 * For a translated clause sitting inside a frame that is held to one direction — a caption in an
 * SVG, where `.chart` pins `direction: ltr` so the axes never mirror. Without it the clause is
 * laid out in the frame’s direction and its own leading punctuation drifts to the wrong end.
 */
export const isolate = (s: string) => `\u2068${s}${PDI}`

const pluralRules = new Map<LocaleCode, Intl.PluralRules>()

/**
 * One count noun, in the form this language's rules ask for at this count.
 *
 * `n === 1` is an English rule, and the app had it hand-rolled at three call sites while
 * `src/i18n/speech/` was already doing this properly for the screen reader — so the same screen
 * spoke a correct Arabic dual and wrote a broken one beside it.
 *
 * The keys are `<base>.<category>`, where a category is a CLDR plural class chosen by
 * `Intl.PluralRules`. `en.ts` declares the forms English has; a language that needs more adds them
 * in its own file, and only there — Czech has a class for 2 to 4, Arabic has six including a dual,
 * and neither is a fact English can be asked to carry. `.other` is the floor and every language
 * has it, so a missing form degrades to a sentence rather than to a key.
 *
 * Why this matters at the counts that actually happen: `.many` used to mean "not one", which put
 * 2 and 200 in one bucket. `batch.fill` is the fill button and its ordinary arguments are 2, 3 and
 * 4 — the exact band a Slavic language names separately. Czech read `Splnit 2 intentů` where it
 * needed `2 intenty`.
 *
 * @param base the key without its category, e.g. `batch.fill`.
 * @param count the number the noun agrees with. Also passed as `{count}` unless `vars` names it.
 */
export function tCount(
  base: string,
  count: number,
  vars?: Record<string, string | number>,
): string {
  let rules = pluralRules.get(current)
  if (!rules) {
    rules = new Intl.PluralRules(current)
    pluralRules.set(current, rules)
  }
  const category = rules.select(count)
  // The active language first, then English, then the floor in either. A locale that translated
  // only `.other` still reads; a locale that translated a form English lacks still wins.
  const dict = active as Record<string, string | undefined>
  const fallback = en as Record<string, string | undefined>
  const raw =
    dict[`${base}.${category}`] ??
    fallback[`${base}.${category}`] ??
    dict[`${base}.other`] ??
    fallback[`${base}.other`] ??
    base
  return raw.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
    if (vars && name in vars) return String(vars[name])
    return name === 'count' ? num(count) : whole
  })
}

/**
 * A sentence cut at one placeholder, for the rare string that wraps a link.
 *
 * `t` returns a string and a link is an element, so the footer needs the words on either side of
 * it. Splitting the translated sentence keeps the word order the translator chose, which glueing
 * two half-sentences together would not. A translation that drops the placeholder puts everything
 * in the first half, which still reads.
 */
export function tSplit(
  key: Key,
  name: string,
  vars?: Record<string, string | number>,
): [string, string] {
  const [before, after] = t(key, vars).split(`{${name}}`)
  return [before ?? '', after ?? '']
}

/**
 * Subscribe a component to the language.
 *
 * `App` calls this at the root, which is enough for the whole tree: `t` reads module state, so a
 * re-render of the root re-runs every `t` below it.
 */
export function useLocale(): LocaleCode {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => 0,
  )
  return current
}

// Combining marks, which is what NFD splits an accent into. Stripping them is what makes "espanol"
// find "Español" and "turkce" find "Türkçe" — a reader searching for their own language should not
// have to produce a character their current keyboard may not carry.
const MARKS = /[\u0300-\u036f]/g

function flatten(text: string): string {
  return text.normalize('NFD').replace(MARKS, '').toLowerCase()
}

/**
 * The registry rows a search box matches: by endonym, by English name, or by code.
 *
 * All three, because all three are things people type. A Spanish speaker types "esp", an English
 * speaker types "spanish", and somebody who knows what they are doing types "es".
 */
export function filterLocales(query: string): readonly Locale[] {
  const q = flatten(query.trim())
  if (!q) return LOCALES
  return LOCALES.filter(
    (l) =>
      flatten(l.endonym).includes(q) ||
      flatten(l.exonym).includes(q) ||
      flatten(l.code).includes(q),
  )
}

// First load. The URL wins, then the stored choice, then the browser.
//
// The URL leads because a localised path is somebody arriving at THIS page — a search result, a
// shared link, the picker — and answering it in a different language would make the link a lie
// and the prerendered HTML disagree with what the reader ends up seeing. Nothing is stored from
// the path either: a visit to `/ja/` does not make Japanese this browser's language everywhere.
//
// Below that it is unchanged. The stored choice is the one the reader made, and the browser is
// asked only when there is nothing else to go on.
//
// Guarded, so importing this module under a test runner touches nothing.
if (typeof window !== 'undefined') {
  const fromPath = localeFromPath(window.location.pathname)
  const first = fromPath ?? stored() ?? resolveLocale(navigator.languages ?? [navigator.language])
  if (first === 'en') applyDocument('en')
  else void setLocale(first, { remember: fromPath === null })
}

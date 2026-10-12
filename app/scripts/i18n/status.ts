/**
 * What state every translation is actually in.
 *
 *   npx tsx scripts/i18n/status.ts            # the summary
 *   npx tsx scripts/i18n/status.ts --locale de --list stale
 *   npx tsx scripts/i18n/status.ts --json     # for a gate or a diff
 *
 * The problem this exists for: 405 keys times 35 locales is 14,175 strings, and nothing recorded
 * which of them anybody had checked, or which English sentence they were checked against. Change
 * one word in `en.ts` and 35 translations quietly become answers to a question nobody asked any
 * more. The parity test cannot see it — the key is still there, the string is still a string.
 *
 * So each locale keeps a record in `src/i18n/reviewed/<locale>.json`, mapping a key to a short
 * hash of the ENGLISH it was reviewed against. That gives three states worth telling apart:
 *
 *   reviewed    a record exists and still matches the English. Nothing to do.
 *   stale       a record exists and the English has changed since. The translation may now be
 *               wrong, and this is the state worth failing a build over, because it is a
 *               regression rather than an absence.
 *   unreviewed  no record. Not a regression — most of the corpus starts here — but it is the
 *               list a reviewer works through.
 *
 * `echoed` is reported alongside: the translation is byte-identical to the English. Sometimes
 * that is correct (`permit2` is `permit2` in every language) and sometimes it means nobody
 * translated it. The record is what settles which, and that is the point of keeping one.
 */
import { createHash } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { en, type Key } from '../../src/i18n/en.ts'
import { LOCALES } from '../../src/lib/i18n.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const I18N = join(HERE, '../../src/i18n')
const REVIEWED = join(I18N, 'reviewed')

/** Eight hex characters of the English string. Enough to notice a change, short enough to read. */
export const stamp = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8)

/**
 * The English a record is a promise about.
 *
 * Usually the key's own sentence. For a plural form a locale declares and English does not —
 * Arabic's dual `batch.selected.two`, Czech's `few` — it is the floor `<base>.other`, because that
 * is the English the translator read. Which matters for the reason the whole record exists: change
 * the floor and every form of it goes stale together, in every language, including the forms
 * English has no word for.
 */
export function sourceOf(key: string): string | undefined {
  const own = (en as Record<string, string | undefined>)[key]
  if (own !== undefined) return own
  const cut = key.lastIndexOf('.')
  if (cut < 0) return undefined
  const category = key.slice(cut + 1)
  if (!CATEGORIES.has(category)) return undefined
  return (en as Record<string, string | undefined>)[`${key.slice(0, cut)}.other`]
}

/** The CLDR plural categories. `other` is the floor English always declares. */
const CATEGORIES = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])

export type Status = 'reviewed' | 'stale' | 'unreviewed'
export type LocaleReport = {
  locale: string
  missing: Key[]
  counts: Record<Status, number>
  echoed: Key[]
  byStatus: Record<Status, Key[]>
}

const arg = (name: string, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function records(locale: string): Record<string, string> {
  const path = join(REVIEWED, `${locale}.json`)
  if (!existsSync(path)) return {}
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
}

async function dictOf(locale: string): Promise<Record<string, string>> {
  if (locale === 'en') return en as unknown as Record<string, string>
  const mod = (await import(join(I18N, `${locale}.ts`))) as { default: Record<string, string> }
  return mod.default
}

export async function report(locale: string): Promise<LocaleReport> {
  const dict = await dictOf(locale)
  const seen = records(locale)
  const keys = Object.keys(en) as Key[]

  const byStatus: Record<Status, Key[]> = { reviewed: [], stale: [], unreviewed: [] }
  const missing: Key[] = []
  const echoed: Key[] = []

  for (const key of keys) {
    const source = en[key] as string
    const mine = dict[key]
    if (mine === undefined) missing.push(key)
    // An English fallback covers a missing string at runtime, so a missing key is a gap in the
    // work rather than a broken screen. It still counts as unreviewed.
    else if (mine === source && locale !== 'en') echoed.push(key)

    const at = seen[key]
    if (!at) byStatus.unreviewed.push(key)
    else if (at !== stamp(source)) byStatus.stale.push(key)
    else byStatus.reviewed.push(key)
  }

  // A plural form this locale declares and English does not. It is reviewed against the English
  // floor, so it counts here the same way — and goes stale with the floor, which is the point.
  for (const key of Object.keys(seen)) {
    if (key in en) continue
    const source = sourceOf(key)
    if (source === undefined) continue
    if (seen[key] === stamp(source)) byStatus.reviewed.push(key as Key)
    else byStatus.stale.push(key as Key)
  }

  return {
    locale,
    missing,
    echoed,
    byStatus,
    counts: {
      reviewed: byStatus.reviewed.length,
      stale: byStatus.stale.length,
      unreviewed: byStatus.unreviewed.length,
    },
  }
}

export const allLocales = () => LOCALES.map((l) => l.code).filter((c) => c !== 'en')

async function main() {
  const only = arg('locale')
  const codes = only ? [only] : allLocales()
  const reports: LocaleReport[] = []
  for (const code of codes) reports.push(await report(code))

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(reports, null, 2))
    return
  }

  const list = arg('list') as Status | 'echoed' | ''
  if (only && list) {
    const r = reports[0]
    const keys = list === 'echoed' ? r.echoed : r.byStatus[list]
    console.log(`${r.locale}: ${keys.length} ${list}`)
    for (const k of keys) console.log(`  ${k}`)
    return
  }

  const total = Object.keys(en).length
  console.log(`${total} keys · ${reports.length} locales · ${total * reports.length} strings\n`)
  console.log('locale      reviewed   stale  unreviewed  echoed  missing')
  for (const r of reports) {
    console.log(
      `${r.locale.padEnd(10)} ${String(r.counts.reviewed).padStart(8)} ${String(r.counts.stale).padStart(7)} ` +
        `${String(r.counts.unreviewed).padStart(11)} ${String(r.echoed.length).padStart(7)} ` +
        `${String(r.missing.length).padStart(8)}`,
    )
  }
  const sum = (f: (r: LocaleReport) => number) => reports.reduce((a, r) => a + f(r), 0)
  console.log(
    `\ntotal      ${String(sum((r) => r.counts.reviewed)).padStart(8)} ` +
      `${String(sum((r) => r.counts.stale)).padStart(7)} ` +
      `${String(sum((r) => r.counts.unreviewed)).padStart(11)} ` +
      `${String(sum((r) => r.echoed.length)).padStart(7)} ` +
      `${String(sum((r) => r.missing.length)).padStart(8)}`,
  )
  if (sum((r) => r.counts.stale) > 0) {
    console.log('\nStale strings are translations of an English sentence that has since changed.')
    console.log('They are the ones worth fixing first: an absence falls back to English, a stale')
    console.log('translation confidently says the wrong thing.')
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()

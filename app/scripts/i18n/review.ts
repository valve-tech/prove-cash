/**
 * Record that a translation has been checked against the English it renders.
 *
 *   npx tsx scripts/i18n/review.ts --locale nl --key view.board --key stat.open
 *   npx tsx scripts/i18n/review.ts --locale nl --all          # everything currently in the file
 *
 * A record is a promise about one string: somebody read this translation beside that English
 * sentence and it says the same thing. It stores a hash of the English rather than the English
 * itself, so the file stays small, and so a later edit to `en.ts` invalidates the promise
 * automatically instead of leaving it quietly true-looking.
 *
 * **There is deliberately no bulk "these are fine" flag.** There was one, for a day. It marked
 * every string whose English is a route word — `Board`, `Mine`, `board` — on the reading that
 * `en.ts` calls those protocol and forbids translating them. That reading was wrong: the header
 * means the URL routes, not the words on screen. Every locale translates the nav label, and it
 * should — Spanish `Libro`, French `Carnet`, Romanian `Panou`, Japanese ボード, Russian Доска. The
 * flag stamped two Dutch strings as reviewed that nobody had read, which is the one thing a
 * record like this must never do. A promise nobody made is worse than no promise: an unreviewed
 * string gets looked at, a falsely reviewed one never does.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { en, type Key } from '../../src/i18n/en.ts'
import { sourceOf, stamp } from './status.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const I18N = join(HERE, '../../src/i18n')
const REVIEWED = join(I18N, 'reviewed')

const argsFor = (name: string): string[] => {
  const out: string[] = []
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1])
  })
  return out
}

const locale = argsFor('locale')[0]
if (!locale) throw new Error('--locale is required')

const path = join(REVIEWED, `${locale}.json`)
const current: Record<string, string> = existsSync(path)
  ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>)
  : {}

let keys: Key[] = argsFor('key') as Key[]
if (process.argv.includes('--all')) keys = Object.keys(en) as Key[]
if (keys.length === 0) throw new Error('nothing named: pass --key or --all')

let added = 0
for (const k of keys) {
  // `sourceOf` accepts a plural form English has no word for — Arabic's dual, Czech's 2-to-4 —
  // and hands back the English floor it is a translation of. Anything else is a typo.
  const source = sourceOf(k)
  if (source === undefined) throw new Error(`${k} is not a key in en.ts`)
  const at = stamp(source)
  if (current[k] !== at) added++
  current[k] = at
}

mkdirSync(REVIEWED, { recursive: true })
// Sorted, so a review of one string is a one-line diff rather than a reshuffle.
const sorted = Object.fromEntries(Object.entries(current).sort(([a], [b]) => (a < b ? -1 : 1)))
writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`)
console.log(`${locale}: recorded ${added} (${Object.keys(sorted).length} total) in ${path}`)

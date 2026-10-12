import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { sourceOf } from './status.ts'

/**
 * A translation may not outlive the English it was written from.
 *
 * It lives beside the tooling rather than in `src/i18n/` because it reads the filesystem, and
 * `src/` is typechecked as browser code: `tsc -b` has `lib: ES2023, DOM` and no node types there,
 * so `node:fs` is not a module that exists. It passed locally under a different tsconfig and
 * failed in CI, which is the argument for running `npx tsc -b` rather than `tsc --noEmit`.
 *
 * `parity.test.ts` already proves every locale carries every key. This proves something the key
 * set cannot show: that the sentence behind the key has not changed since somebody checked the
 * translation of it. Edit four words in `en.ts` and the parity test stays green while 34
 * translations quietly become answers to a question nobody asked any more.
 *
 * **It fails on stale, and says nothing about unreviewed.** The two are not the same problem. An
 * unreviewed string is an absence, and the app falls back to English for one — most of the corpus
 * starts there and a gate that fails on it is a gate somebody deletes. A stale string is a
 * regression: it renders confidently, in the reader's own language, and says what the product no
 * longer means.
 *
 * When this fails, either re-check the translation and record it —
 * `npx tsx scripts/i18n/review.ts --locale <code> --key <key>` — or fix the translation first and
 * then record it. Do not record without reading; the record is the only thing standing between a
 * changed English sentence and 34 confident mistranslations of it.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REVIEWED = join(HERE, '../../src/i18n/reviewed')
const stamp = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8)

const locales = existsSync(REVIEWED)
  ? readdirSync(REVIEWED)
      .filter((f: string) => f.endsWith('.json'))
      .map((f: string) => f.replace(/\.json$/, ''))
  : []

describe('no translation is stale', () => {
  if (locales.length === 0) {
    test('there is nothing recorded yet, which is a starting point and not a failure', () => {
      expect(locales).toHaveLength(0)
    })
  }

  for (const locale of locales) {
    test(`${locale} was reviewed against the English that is there now`, () => {
      const seen = JSON.parse(readFileSync(join(REVIEWED, `${locale}.json`), 'utf8')) as Record<
        string,
        string
      >
      const stale: string[] = []
      const gone: string[] = []
      for (const [key, at] of Object.entries(seen)) {
        // `sourceOf` resolves a plural form this locale declares and English does not — Arabic's
        // dual — to the English floor it was reviewed against, so those go stale with the floor
        // rather than reading as litter.
        const source = sourceOf(key)
        // A record for a key that no longer exists is litter, and hides a rename.
        if (source === undefined) gone.push(key)
        else if (stamp(source) !== at) stale.push(key)
      }
      expect(
        { stale, gone },
        `${locale}: ${stale.length} translation(s) of English that has since changed, ` +
          `${gone.length} record(s) for keys that no longer exist`,
      ).toEqual({ stale: [], gone: [] })
    })
  }
})

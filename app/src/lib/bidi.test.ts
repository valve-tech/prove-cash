/**
 * The three right-to-left defects, pinned so they cannot come back.
 *
 * All three lived in the FRAMING rather than in a translation, which is why no locale file could
 * repair them and no translator could report them: the app was laying out correct Arabic and
 * Hebrew strings in a paragraph that reversed part of them. The audits found them by reading, and
 * that is not a thing to depend on twice.
 *
 * Two of the checks read the corpus and one reads the source, because that is where each defect
 * can reappear. A future translator can put the token back into `rpc.board.hint`; a future author
 * can drop a bare `≤` into a sentence.
 */
import { describe, expect, test } from 'vitest'
import { en } from '../i18n/en.ts'
import { LOCALES as REGISTRY, isolate, ltr } from './i18n.ts'

const SOURCES = import.meta.glob('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const I18N_FILES = import.meta.glob('../i18n/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * The dictionaries, named from the registry rather than filtered out of a directory.
 *
 * This used to take every `../i18n/*.ts` and drop the one file it knew was not a dictionary. That
 * is a blocklist, and a blocklist is wrong the first time somebody adds a file: `i18n/dicts.ts`
 * arrived and this suite reported that a module with no strings in it had failed to define
 * `rpc.board.hint`. Asking the registry instead cannot drift — `parity.test.ts` already proves the
 * registry and the dictionary table name the same thirty-five.
 */
const dicts = REGISTRY.filter((l) => l.code !== 'en').map(
  (l) => [`../i18n/${l.code}.ts`, I18N_FILES[`../i18n/${l.code}.ts`]] as const,
)

describe('the isolates themselves', () => {
  test('ltr wraps in U+2066 and U+2069', () => {
    expect(ltr('≤1')).toBe('⁦≤1⁩')
  })

  test('isolate wraps in U+2068, so the run picks its own direction', () => {
    expect(isolate('שלום')).toBe('⁨שלום⁩')
  })

  test('neither leaves a stray isolate for the next run to inherit', () => {
    // An unclosed isolate runs to the end of the paragraph and takes everything after it with it.
    for (const s of [ltr('x'), isolate('x')]) {
      expect([...s].filter((c) => c === '⁩')).toHaveLength(1)
    }
  })
})

describe('a technical token a person has to type', () => {
  test('the board hint carries the prefix as a placeholder, not as literal text', () => {
    // The component puts the token in a `<bdi dir="ltr">`. It can only do that if the string
    // leaves a hole for it: `msgboard_` written into the sentence has no element to isolate it,
    // and its trailing underscore is bidi-neutral, so a Hebrew reader is shown `_msgboard` — a
    // prefix that is not the prefix.
    expect(en['rpc.board.hint']).toContain('{prefix}')
    expect(en['rpc.board.hint']).not.toContain('msgboard_')
  })

  test.each(dicts)('%s does not write the token into the hint', (file, src) => {
    expect(src, `the registry names ${file} and the directory has no such file`).toBeDefined()
    const line = src.split('\n').find((l) => l.includes("'rpc.board.hint'"))
    expect(line, 'every locale defines rpc.board.hint').toBeDefined()
    expect(line).toContain('{prefix}')
    expect(line).not.toContain('msgboard_')
  })
})

describe('a separator between two clauses', () => {
  // `.chart` pins `direction: ltr` on the svg so the axes never mirror. A caption in that frame
  // is laid out in an LTR paragraph, so a separator at the edge of a translated clause is a
  // neutral between two runs and lands between the two FIGURES instead of the two clauses.
  const EDGE = /^[·—–|,;:-]|[·—–|]$/

  test.each(Object.entries(en).filter(([k]) => k.startsWith('chart.')))(
    '%s does not open or close on a bare separator',
    (_key, value) => {
      expect(typeof value === 'string' && EDGE.test(value.trim())).toBe(false)
    },
  )

  test('the walk caption and its tail are joined by code, not by either string', () => {
    const walk = SOURCES['../components/charts/BatchWalk.tsx']
    expect(walk, 'BatchWalk is where the two captions meet').toBeDefined()
    expect(walk).toContain('isolate(')
    // The separator is the join's own, sitting in the frame's direction between two isolates.
    expect(walk).toContain('` · ${isolate(')
  })
})

describe('a mirrorable character beside a numeral', () => {
  // `≤` is in the bidi mirroring table. Resolved to an odd level it is DRAWN as `≥`, so a bare
  // one inside an RTL sentence tells the reader the opposite of what it says.
  const MIRRORED = /[≤≥<>(){}[\]]/

  test('nothing hands t() a bare mirrorable character', () => {
    const offenders: string[] = []
    for (const [file, src] of Object.entries(SOURCES)) {
      if (file.includes('.test.') || file.includes('/i18n/')) continue
      // `t('key', { name: '…' })` — only the literal values, which are the ones an author writes.
      for (const m of src.matchAll(/\bt\(\s*['"][\w.-]+['"]\s*,\s*\{([^{}]*)\}/g)) {
        for (const v of (m[1] ?? '').matchAll(/:\s*(['"])(.*?)\1/g)) {
          const value = v[2] ?? ''
          if (MIRRORED.test(value) && !value.startsWith('⁦')) {
            offenders.push(`${file}: ${value}`)
          }
        }
      }
    }
    expect(offenders, 'wrap it in ltr() from lib/i18n').toEqual([])
  })
})

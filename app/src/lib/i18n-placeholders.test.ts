import { describe, expect, test } from 'vitest'
import { en } from '../i18n/en.ts'

/**
 * The two ways a `t()` call and its key can disagree, both silent, both shipped once.
 *
 * `header.endpoints.tip` was written for a button that printed its host in the header. When the
 * host moved into the tooltip the call started passing `{health, hosts}`, but the key was still a
 * fixed sentence with nowhere to put them. Nothing failed. The tooltip simply stopped naming the
 * node, which left a sighted reader no way to see it at all — worse than before the host moved.
 * The mirror case is a key that has slots and a call that passes nothing: then `{count}` reaches
 * the screen as four literal characters.
 *
 * Neither is a type error, because `t()` takes an open record and a string comes back either way.
 * So this reads the call sites instead. It is a lint rather than a unit test, and it globs the
 * source rather than importing it, so a component written tomorrow is covered without being
 * registered anywhere.
 *
 * `?raw` through `import.meta.glob` rather than `node:fs`: the app's tsconfig carries no node
 * types, and a test that forces them on the whole project to read a file is a poor trade.
 */

const SOURCES = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

type Call = { file: string; key: string; vars: string[] }

/**
 * Find `t('key')` and `t('key', { a, b: x })`.
 *
 * A dynamic key — `t(HEALTH[health])` — is skipped rather than guessed at. Those exist and are
 * legitimate; what this catches is the literal case, which is nearly all of them.
 */
function callsIn(file: string, src: string): Call[] {
  const out: Call[] = []
  // `tSplit` fills its slots with markup, so its variables never arrive as an object. It is
  // exempt by accident: the pattern below matches `t(` and not `tSplit(`.
  // `t(` preceded by a non-word character, so `split(` and `format(` do not match.
  const re = /\bt\(\s*(['"])([\w.-]+)\1\s*(,\s*\{([^{}]*)\})?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const key = m[2] ?? ''
    out.push({ file, key, vars: propertiesOf(m[4] ?? '') })
  }
  return out
}

/**
 * The property names in an object literal's body, splitting on commas that separate properties
 * and not on the ones inside a value.
 *
 * A naive `split(',')` was the first thing I wrote and it immediately misread
 * `{ amount: spokenCompact(stats.profit, wplsDecimals, 'WPLS') }` as three properties, then
 * reported a bug that was not there. A guard that cries wolf gets deleted, so it walks depth.
 */
function propertiesOf(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quote) {
      if (ch === quote && body[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts
    .map((part) => part.split(':')[0]?.trim() ?? '')
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
}

const slotsOf = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '')
const textOf = (key: string) => en[key as keyof typeof en] as string

const CALLS = Object.entries(SOURCES)
  // The dictionaries hold the strings; they do not call `t`. Tests are allowed to be wrong on
  // purpose, so a fixture asserting a bad call must not fail this.
  .filter(([path]) => !path.includes('/i18n/') && !/\.test\.tsx?$/.test(path))
  .flatMap(([path, src]) => callsIn(path.replace('../', ''), src))
  .filter((c) => c.key in en)

/**
 * The detector, checked against the bug it exists for.
 *
 * A guard that has only ever passed proves nothing. These run the same matcher over fabricated
 * source, so they neither depend on the real dictionary nor break when it changes — and the first
 * case is the endpoints tooltip exactly as it shipped.
 */
describe('the detector catches what it is for', () => {
  const varsFor = (src: string) => callsIn('fixture.tsx', src)[0]?.vars ?? []

  test('the endpoints tooltip, as it shipped: two variables, nowhere to put them', () => {
    const vars = varsFor("<TipUnder tip={t('header.endpoints.tip', { health: state, hosts })}>")
    const slots = slotsOf('Endpoints — board and chain, bring your own node')
    expect(vars).toEqual(['health', 'hosts'])
    expect(vars.filter((v) => !slots.includes(v))).toEqual(['health', 'hosts'])
  })

  test('and passes once the key has the slots', () => {
    const vars = varsFor("t('header.endpoints.tip', { health: state, hosts })")
    const slots = slotsOf('Endpoints — {health} · {hosts}')
    expect(vars.filter((v) => !slots.includes(v))).toEqual([])
  })

  test('the mirror case: a slot nobody fills would print as literal text', () => {
    const vars = varsFor("t('view.board.tip')")
    const slots = slotsOf('Board · {count} open')
    expect(slots.filter((s) => !vars.includes(s))).toEqual(['count'])
  })

  test('a comma inside a value is not a second property', () => {
    expect(varsFor("t('stat.profit.spoken', { amount: spokenCompact(p, d, 'WPLS') })")).toEqual([
      'amount',
    ])
  })

  test('a nested object and a template literal do not confuse the split', () => {
    expect(varsFor("t('k', { a: fn([1, 2]), b: `x, y`, c })")).toEqual(['a', 'b', 'c'])
  })
})

/**
 * `tCount(base, n, vars)` — the same check, against the plural floor.
 *
 * A count noun's forms are keyed `<base>.<category>` and `.other` is the one English always
 * declares, so the floor is what a call site's variables have to agree with. `{count}` is not a
 * caller's job here: `tCount` fills it from the number it was given, which is the redundancy that
 * caused the bug — every old call site chose the key with an `n === 1` ternary and then passed
 * `{ count }` beside it, and one of the two was always the one an author forgot.
 */
const COUNT_CALLS = Object.entries(SOURCES)
  .filter(([path]) => !path.includes('/i18n/') && !/\.test\.tsx?$/.test(path))
  .flatMap(([path, src]) => {
    const out: Call[] = []
    const re = /\btCount\(\s*(['"])([\w.-]+)\1\s*,[^,{}]*(,\s*\{([^{}]*)\})?/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      out.push({
        file: path.replace('../', ''),
        key: `${m[2] ?? ''}.other`,
        vars: propertiesOf(m[4] ?? ''),
      })
    }
    return out
  })

describe('every tCount() call and its plural floor agree about variables', () => {
  test('there are calls to check', () => {
    expect(COUNT_CALLS.length).toBeGreaterThan(3)
  })

  test('every base names a plural set English actually declares', () => {
    expect(COUNT_CALLS.filter((c) => !(c.key in en)).map((c) => `${c.file}: ${c.key}`)).toEqual([])
  })

  test('a variable passed to tCount() has somewhere to go', () => {
    const wrong = COUNT_CALLS.filter((c) => c.key in en).flatMap((c) => {
      const slots = slotsOf(textOf(c.key))
      return c.vars
        .filter((v) => !slots.includes(v))
        .map((v) => `${c.file}: tCount('${c.key}', …, { ${v} }) — "${textOf(c.key)}" has no {${v}}`)
    })
    expect(wrong).toEqual([])
  })

  test('every slot but the count is filled by the caller', () => {
    const wrong = COUNT_CALLS.filter((c) => c.key in en).flatMap((c) => {
      const slots = slotsOf(textOf(c.key)).filter((s) => s !== 'count')
      return slots
        .filter((s) => !c.vars.includes(s))
        .map((s) => `${c.file}: tCount('${c.key}') passes no ${s}`)
    })
    expect(wrong).toEqual([])
  })
})

describe('every t() call and its key agree about variables', () => {
  test('there are calls to check, so a broken matcher cannot pass silently', () => {
    expect(CALLS.length).toBeGreaterThan(20)
  })

  test('a variable passed to t() has somewhere to go', () => {
    const wrong = CALLS.flatMap((c) => {
      const slots = slotsOf(textOf(c.key))
      return c.vars
        .filter((v) => !slots.includes(v))
        .map((v) => `${c.file}: t('${c.key}', { ${v} }) — "${textOf(c.key)}" has no {${v}}`)
    })
    expect(wrong).toEqual([])
  })

  test('a slot in a key is filled by every call that uses it', () => {
    const wrong = CALLS.flatMap((c) => {
      const slots = slotsOf(textOf(c.key))
      return slots
        .filter((s) => !c.vars.includes(s))
        .map((s) => `${c.file}: t('${c.key}') passes no ${s} — "${textOf(c.key)}" would print {${s}}`)
    })
    expect(wrong).toEqual([])
  })
})

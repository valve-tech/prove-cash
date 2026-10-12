import { describe, expect, test } from 'vitest'
import { LOCALES } from '../lib/i18n.ts'
import { en, type Key } from './en.ts'
import { DICTS } from './dicts.ts'

/**
 * Every dictionary answers to the same shape.
 *
 * TypeScript checks that a locale file holds no key English does not; it cannot check the other
 * direction, because a dictionary is a `Partial<Dict>` on purpose — a missing key falls through to
 * English rather than showing a reader the key itself. That fallback is what makes a gap silent,
 * and silent is exactly what a gap must not be to us. So the shape is checked here instead: the
 * same keys, and the same `{placeholders}` inside each one.
 *
 * The placeholder check is the one that has already cost us something. A translated string with
 * the placeholder dropped drops the variable with it — `t` interpolates by name, so a sentence
 * with no slot for `{hosts}` renders without the host and reads perfectly well while saying less
 * than it should. Nothing on screen looks broken. Compare the sets, per key, in every language.
 *
 * **One key a locale may hold that English does not: a plural form.** How many forms a count noun
 * has is a fact about the language, not about the dictionary's shape. English has two, Czech has
 * a third for 2 to 4, Arabic has six. A locale may add any CLDR category to a base whose `.other`
 * English declares, and `tCount` picks between them with `Intl.PluralRules`. Everything else
 * about such a form is checked the same way: it must hold, it must say something, and its
 * placeholders must be a subset of the floor's — a form is allowed to DROP the count, the way
 * Hebrew says `שעתיים` for two hours without speaking the numeral, and never to invent a slot.
 */


const KEYS = Object.keys(en) as Key[]

/** The `{name}` slots in a string, sorted, so two orderings of the same set still match. */
const slots = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()

describe('every language answers to English', () => {
  test('the registry and the dictionary table name the same thirty-five', () => {
    const registry = LOCALES.map((l) => l.code)
      .filter((c) => c !== 'en')
      .sort()
    expect(Object.keys(DICTS).sort()).toEqual(registry)
  })

  /** The bases English gives a `.other`, which are the ones a locale may add a form to. */
  const PLURAL_BASES = new Set(
    KEYS.filter((k) => k.endsWith('.other')).map((k) => k.slice(0, -'.other'.length)),
  )

  const CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other']

  /** `<base>.<category>` for a base English declares a floor for. Null for anything else. */
  const pluralOf = (key: string): string | null => {
    const cut = key.lastIndexOf('.')
    if (cut < 0) return null
    const base = key.slice(0, cut)
    const category = key.slice(cut + 1)
    return CATEGORIES.includes(category) && PLURAL_BASES.has(base) ? base : null
  }

  test.each(Object.keys(DICTS))('%s holds every key English holds', (code) => {
    const dict = DICTS[code] as Record<string, string>
    const missing = [...KEYS].filter((k) => !(k in dict))
    expect(missing.sort()).toEqual([])
  })

  test.each(Object.keys(DICTS))('%s adds nothing but a plural form of its own', (code) => {
    const dict = DICTS[code] as Record<string, string>
    const extra = Object.keys(dict).filter((k) => !KEYS.includes(k as Key))
    expect(extra.filter((k) => pluralOf(k) === null).sort()).toEqual([])
  })

  test.each(Object.keys(DICTS))('%s keeps every placeholder', (code) => {
    const dict = DICTS[code] as Record<string, string>
    for (const key of KEYS) {
      expect(slots(dict[key]), `${code} ${key}`).toEqual(slots(en[key]))
    }
    // An extra plural form may drop the count and may not invent a slot, so its placeholders are
    // a subset of the floor English declares.
    for (const key of Object.keys(dict)) {
      const base = KEYS.includes(key as Key) ? null : pluralOf(key)
      if (base === null) continue
      const floor = slots(en[`${base}.other` as Key])
      expect(slots(dict[key]).filter((s) => !floor.includes(s)), `${code} ${key}`).toEqual([])
    }
  })

  test.each(Object.keys(DICTS))('%s says something for every key it holds', (code) => {
    const dict = DICTS[code] as Record<string, string>
    for (const key of Object.keys(dict)) {
      expect(dict[key]?.trim(), `${code} ${key}`).toBeTruthy()
    }
  })
})

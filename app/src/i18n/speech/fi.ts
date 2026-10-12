import type { SpeechModule, UnitForms } from './shape.ts'

/**
 * The duration accusative, which Finnish writes with the -n of the genitive.
 *
 * A span of exactly one unit takes it and everything above one stays partitive: `Sitova
 * 1 minuutin`, `Sitova 5 minuuttia`. So all four nouns move, and only at `one` — which is why
 * this does not look like the Slavic pattern, where only the feminines move.
 */
const duration: UnitForms = {
  second: { one: '{n} sekunnin' },
  minute: { one: '{n} minuutin' },
  hour: { one: '{n} tunnin' },
  day: { one: '{n} päivän' },
}

/**
 * The genitive, which the postposition `kuluttua` governs at every count: `1 minuutin kuluttua`,
 * `5 minuutin kuluttua`. The singular is the same word the duration accusative uses; the plural
 * is where the two part, because `kuluttua` never takes the partitive `5 minuuttia`.
 *
 * `jälkeen` and `sitten` govern nothing, so the measure and elapsed slots keep the partitive and
 * the citation form respectively.
 */
const genitive: UnitForms = {
  second: { one: '{n} sekunnin', other: '{n} sekunnin' },
  minute: { one: '{n} minuutin', other: '{n} minuutin' },
  hour: { one: '{n} tunnin', other: '{n} tunnin' },
  day: { one: '{n} päivän', other: '{n} päivän' },
}

/**
 * Finnish. A count above one takes the partitive, not a plural, and the rate uses the
 * postposition "kohden" so a token symbol never has to be inflected.
 */
const fi: SpeechModule = {
  approximately: 'noin {value}',
  minus: 'miinus {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'aika loppui',
  units: {
    second: { one: '{n} sekunti', other: '{n} sekuntia' },
    minute: { one: '{n} minuutti', other: '{n} minuuttia' },
    hour: { one: '{n} tunti', other: '{n} tuntia' },
    day: { one: '{n} päivä', other: '{n} päivää' },
  },
  unitsMeasure: duration,
  unitsSpan: duration,
  unitsWithin: genitive,
  joinDuration: '{first} {second}',
  rate: '{value} {out} yhtä {in} kohden',
  noRate: 'ei kurssia parille {in} {out}',
}

export default fi

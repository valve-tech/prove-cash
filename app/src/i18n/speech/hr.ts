import type { SpeechModule, UnitForms } from './shape.ts'

/**
 * The accusative: `Ističe za 1 minutu`. `one` covers 21 and 101 here as well as 1, so the form
 * moves at every one of them. `sat` and `dan` are masculine and never move.
 */
const accusative: UnitForms = {
  second: { one: '{n} sekundu' },
  minute: { one: '{n} minutu' },
}

/**
 * The genitive, which `prije` governs. Only `one` moves: after 2 to 4 Croatian already uses the
 * genitive singular and above 5 the genitive plural, so `few` and `other` are genitives already.
 */
const genitive: UnitForms = {
  second: { one: '{n} sekunde' },
  minute: { one: '{n} minute' },
  hour: { one: '{n} sata' },
  day: { one: '{n} dana' },
}

/** Croatian. Three forms, and 21 comes back to `one` — 21 sat, not 21 sati. */
const hr: SpeechModule = {
  approximately: 'otprilike {value}',
  minus: 'minus {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'vrijeme je isteklo',
  units: {
    second: { one: '{n} sekunda', few: '{n} sekunde', other: '{n} sekundi' },
    minute: { one: '{n} minuta', few: '{n} minute', other: '{n} minuta' },
    hour: { one: '{n} sat', few: '{n} sata', other: '{n} sati' },
    day: { one: '{n} dan', few: '{n} dana', other: '{n} dana' },
  },
  unitsMeasure: accusative,
  unitsSpan: accusative,
  unitsWithin: accusative,
  unitsElapsed: genitive,
  joinDuration: '{first} i {second}',
  rate: '{value} {out} za 1 {in}',
  noRate: 'nema tečaja {in} u {out}',
}

export default hr

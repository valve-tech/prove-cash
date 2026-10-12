import type { SpeechModule, UnitForms } from './shape.ts'

/**
 * The accusative, which a feminine noun in -a marks with -ę: `Wygasa za 1 minutę`. Every slot but
 * the citation one takes it, `temu` included, so the table is named four times. Polish reaches
 * `one` at 1 alone, and `dzień` is masculine.
 */
const accusative: UnitForms = {
  second: { one: '{n} sekundę' },
  minute: { one: '{n} minutę' },
  hour: { one: '{n} godzinę' },
}

/**
 * Polish. Three forms like Russian, but 21 takes `many` rather than `one` — the rule keys on
 * the last two digits differently.
 */
const pl: SpeechModule = {
  approximately: 'około {value}',
  minus: 'minus {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'czas minął',
  units: {
    second: { one: '{n} sekunda', few: '{n} sekundy', many: '{n} sekund', other: '{n} sekundy' },
    minute: { one: '{n} minuta', few: '{n} minuty', many: '{n} minut', other: '{n} minuty' },
    hour: { one: '{n} godzina', few: '{n} godziny', many: '{n} godzin', other: '{n} godziny' },
    day: { one: '{n} dzień', few: '{n} dni', many: '{n} dni', other: '{n} dnia' },
  },
  unitsMeasure: accusative,
  unitsSpan: accusative,
  unitsWithin: accusative,
  unitsElapsed: accusative,
  joinDuration: '{first} {second}',
  rate: '{value} {out} za 1 {in}',
  noRate: 'brak kursu {in} do {out}',
}

export default pl

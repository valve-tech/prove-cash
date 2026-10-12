import type { SpeechModule, UnitForms } from './shape.ts'

/**
 * The dative, which `in`, `nach` and `vor` all govern.
 *
 * German writes it on one noun in one place: the dative plural of `Tag` is `Tagen`, so `in
 * 2 Tagen` and `vor 2 Tagen`, where the app used to say `in 2 Tage`. Minute, Sekunde and Stunde
 * already end in -n in the plural and do not move.
 *
 * The singular is written out even though it is the same word the citation table holds. Modern
 * German drops the old dative `-e`, so `in 1 Tag` is right — a fact, not an omission, and a table
 * that named only the plural would leave a reader unable to tell which.
 *
 * A bare German measure stays nominative — `2 Tage nach dem Öffnen`, `verbindlich für 2 Tage` —
 * so the measure and span slots take no table at all. That split is why one adverbial slot could
 * not serve this language.
 */
const dative: UnitForms = {
  day: { one: '{n} Tag', other: '{n} Tagen' },
}

/** German. */
const de: SpeechModule = {
  approximately: 'ungefähr {value}',
  minus: 'minus {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'keine Zeit mehr',
  units: {
    second: { one: '{n} Sekunde', other: '{n} Sekunden' },
    minute: { one: '{n} Minute', other: '{n} Minuten' },
    hour: { one: '{n} Stunde', other: '{n} Stunden' },
    day: { one: '{n} Tag', other: '{n} Tage' },
  },
  unitsWithin: dative,
  unitsElapsed: dative,
  joinDuration: '{first} {second}',
  rate: '{value} {out} pro {in}',
  noRate: 'kein Kurs für {in} zu {out}',
}

export default de

import type { SpeechModule, UnitForms } from './shape.ts'

/**
 * The accusative, which every slot but *ago* asks for: `1 minutu po otevření`, `Expiruje za
 * 1 minutu`, `Závazná 1 minutu`. A feminine noun in -a parts from its nominative at one and
 * nowhere else, because `2 minuty` and `5 minut` already read as accusatives. `den` is masculine
 * inanimate and never moves at all.
 */
const accusative: UnitForms = {
  second: { one: '{n} sekundu' },
  minute: { one: '{n} minutu' },
  hour: { one: '{n} hodinu' },
}

/**
 * The instrumental, which is what `před` governs and what *ago* therefore needs. This one moves
 * at every count and in every unit, so it fills each category rather than overriding one.
 */
const instrumental: UnitForms = {
  second: {
    one: '{n} sekundou',
    few: '{n} sekundami',
    many: '{n} sekundami',
    other: '{n} sekundami',
  },
  minute: {
    one: '{n} minutou',
    few: '{n} minutami',
    many: '{n} minutami',
    other: '{n} minutami',
  },
  hour: {
    one: '{n} hodinou',
    few: '{n} hodinami',
    many: '{n} hodinami',
    other: '{n} hodinami',
  },
  day: {
    one: '{n} dnem',
    few: '{n} dny',
    many: '{n} dny',
    other: '{n} dny',
  },
}

/**
 * Czech. `few` covers 2 to 4 and `other` takes over from 5, so 5 and 21 share a form that 2
 * does not. `many` is the decimal form and a count never reaches it.
 */
const cs: SpeechModule = {
  approximately: 'přibližně {value}',
  minus: 'mínus {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'čas vypršel',
  units: {
    second: { one: '{n} sekunda', few: '{n} sekundy', many: '{n} sekundy', other: '{n} sekund' },
    minute: { one: '{n} minuta', few: '{n} minuty', many: '{n} minuty', other: '{n} minut' },
    hour: { one: '{n} hodina', few: '{n} hodiny', many: '{n} hodiny', other: '{n} hodin' },
    day: { one: '{n} den', few: '{n} dny', many: '{n} dne', other: '{n} dní' },
  },
  unitsMeasure: accusative,
  unitsSpan: accusative,
  unitsWithin: accusative,
  unitsElapsed: instrumental,
  joinDuration: '{first} {second}',
  rate: '{value} {out} za 1 {in}',
  noRate: 'žádný kurz {in} k {out}',
}

export default cs

import type { SpeechModule, UnitForms } from './shape.ts'

/** The accusative, for the same reason Czech needs one. Only the feminine nouns move, at one. */
const accusative: UnitForms = {
  second: { one: '{n} sekundu' },
  minute: { one: '{n} minútu' },
  hour: { one: '{n} hodinu' },
}

/** The instrumental, which `pred` governs. It moves at every count, so it fills every category. */
const instrumental: UnitForms = {
  second: {
    one: '{n} sekundou',
    few: '{n} sekundami',
    many: '{n} sekundami',
    other: '{n} sekundami',
  },
  minute: {
    one: '{n} minútou',
    few: '{n} minútami',
    many: '{n} minútami',
    other: '{n} minútami',
  },
  hour: {
    one: '{n} hodinou',
    few: '{n} hodinami',
    many: '{n} hodinami',
    other: '{n} hodinami',
  },
  day: {
    one: '{n} dňom',
    few: '{n} dňami',
    many: '{n} dňami',
    other: '{n} dňami',
  },
}

/** Slovak. The same three-way split as Czech, different words. */
const sk: SpeechModule = {
  approximately: 'približne {value}',
  minus: 'mínus {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'čas vypršal',
  units: {
    second: { one: '{n} sekunda', few: '{n} sekundy', many: '{n} sekundy', other: '{n} sekúnd' },
    minute: { one: '{n} minúta', few: '{n} minúty', many: '{n} minúty', other: '{n} minút' },
    hour: { one: '{n} hodina', few: '{n} hodiny', many: '{n} hodiny', other: '{n} hodín' },
    day: { one: '{n} deň', few: '{n} dni', many: '{n} dňa', other: '{n} dní' },
  },
  unitsMeasure: accusative,
  unitsSpan: accusative,
  unitsWithin: accusative,
  unitsElapsed: instrumental,
  joinDuration: '{first} {second}',
  rate: '{value} {out} za 1 {in}',
  noRate: 'žiadny kurz {in} k {out}',
}

export default sk

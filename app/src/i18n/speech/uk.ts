import type { SpeechModule, UnitForms } from './shape.ts'

/**
 * The accusative: `через 1 годину`, `1 годину тому`. Every slot but the citation one takes it.
 * `one` covers 21, 31 and 101 too, and `день` is masculine inanimate.
 */
const accusative: UnitForms = {
  second: { one: '{n} секунду' },
  minute: { one: '{n} хвилину' },
  hour: { one: '{n} годину' },
}

/** Ukrainian. Three forms, keyed the way Russian keys them. */
const uk: SpeechModule = {
  approximately: 'приблизно {value}',
  minus: 'мінус {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'час вичерпано',
  units: {
    second: { one: '{n} секунда', few: '{n} секунди', many: '{n} секунд', other: '{n} секунди' },
    minute: { one: '{n} хвилина', few: '{n} хвилини', many: '{n} хвилин', other: '{n} хвилини' },
    hour: { one: '{n} година', few: '{n} години', many: '{n} годин', other: '{n} години' },
    day: { one: '{n} день', few: '{n} дні', many: '{n} днів', other: '{n} дня' },
  },
  unitsMeasure: accusative,
  unitsSpan: accusative,
  unitsWithin: accusative,
  unitsElapsed: accusative,
  joinDuration: '{first} {second}',
  rate: '{value} {out} за 1 {in}',
  noRate: 'немає курсу {in} до {out}',
}

export default uk

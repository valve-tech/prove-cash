import type { SpeechModule, UnitForms } from './shape.ts'

/**
 * The accusative: `через 1 минуту`, `1 минуту назад`. Every slot but the citation one takes it,
 * `назад` included. `one` covers 21, 31 and 101 as well as 1, so each of those moves. `час` and
 * `день` are masculine inanimate and never move.
 */
const accusative: UnitForms = {
  second: { one: '{n} секунду' },
  minute: { one: '{n} минуту' },
}

/**
 * Russian. Three noun forms, chosen by the last two digits: 1 and 21 take `one`, 2 to 4 take
 * `few`, 5 to 20 take `many`. `Intl.PluralRules` does the choosing.
 */
const ru: SpeechModule = {
  approximately: 'примерно {value}',
  minus: 'минус {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'время истекло',
  units: {
    second: { one: '{n} секунда', few: '{n} секунды', many: '{n} секунд', other: '{n} секунды' },
    minute: { one: '{n} минута', few: '{n} минуты', many: '{n} минут', other: '{n} минуты' },
    hour: { one: '{n} час', few: '{n} часа', many: '{n} часов', other: '{n} часа' },
    day: { one: '{n} день', few: '{n} дня', many: '{n} дней', other: '{n} дня' },
  },
  unitsMeasure: accusative,
  unitsSpan: accusative,
  unitsWithin: accusative,
  unitsElapsed: accusative,
  joinDuration: '{first} {second}',
  rate: '{value} {out} за 1 {in}',
  noRate: 'нет курса {in} к {out}',
}

export default ru

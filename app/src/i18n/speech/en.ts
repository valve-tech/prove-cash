import type { SpeechModule } from './shape.ts'

/**
 * English. This one is the reference and the fallback: every other module answers the
 * same questions in its own word order.
 */
const en: SpeechModule = {
  approximately: 'approximately {value}',
  minus: 'minus {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'no time left',
  units: {
    second: { one: '{n} second', other: '{n} seconds' },
    minute: { one: '{n} minute', other: '{n} minutes' },
    hour: { one: '{n} hour', other: '{n} hours' },
    day: { one: '{n} day', other: '{n} days' },
  },
  joinDuration: '{first} {second}',
  rate: '{value} {out} per {in}',
  noRate: 'no rate for {in} to {out}',
}

export default en

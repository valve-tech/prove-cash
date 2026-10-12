import type { SpeechModule } from './shape.ts'

/** Norwegian Bokmål. */
const nb: SpeechModule = {
  approximately: 'omtrent {value}',
  minus: 'minus {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'ingen tid igjen',
  units: {
    second: { one: '{n} sekund', other: '{n} sekunder' },
    minute: { one: '{n} minutt', other: '{n} minutter' },
    hour: { one: '{n} time', other: '{n} timer' },
    day: { one: '{n} dag', other: '{n} dager' },
  },
  joinDuration: '{first} og {second}',
  rate: '{value} {out} per {in}',
  noRate: 'ingen kurs for {in} til {out}',
}

export default nb

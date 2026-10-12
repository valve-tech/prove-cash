import type { SpeechModule } from './shape.ts'

/** Danish. */
const da: SpeechModule = {
  approximately: 'cirka {value}',
  minus: 'minus {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'ingen tid tilbage',
  units: {
    second: { one: '{n} sekund', other: '{n} sekunder' },
    minute: { one: '{n} minut', other: '{n} minutter' },
    hour: { one: '{n} time', other: '{n} timer' },
    day: { one: '{n} dag', other: '{n} dage' },
  },
  joinDuration: '{first} og {second}',
  rate: '{value} {out} per {in}',
  noRate: 'ingen kurs for {in} til {out}',
}

export default da

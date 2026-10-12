import type { SpeechModule } from './shape.ts'

/** Swedish. */
const sv: SpeechModule = {
  approximately: 'ungefär {value}',
  minus: 'minus {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'ingen tid kvar',
  units: {
    second: { one: '{n} sekund', other: '{n} sekunder' },
    minute: { one: '{n} minut', other: '{n} minuter' },
    hour: { one: '{n} timme', other: '{n} timmar' },
    day: { one: '{n} dag', other: '{n} dagar' },
  },
  joinDuration: '{first} och {second}',
  rate: '{value} {out} per {in}',
  noRate: 'ingen kurs för {in} till {out}',
}

export default sv

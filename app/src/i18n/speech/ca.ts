import type { SpeechModule } from './shape.ts'

/** Catalan. */
const ca: SpeechModule = {
  approximately: 'aproximadament {value}',
  minus: 'menys {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'sense temps',
  units: {
    second: { one: '{n} segon', other: '{n} segons' },
    minute: { one: '{n} minut', other: '{n} minuts' },
    hour: { one: '{n} hora', other: '{n} hores' },
    day: { one: '{n} dia', other: '{n} dies' },
  },
  joinDuration: '{first} i {second}',
  rate: '{value} {out} per {in}',
  noRate: 'sense tipus de canvi de {in} a {out}',
}

export default ca

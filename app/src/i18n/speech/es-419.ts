import type { SpeechModule } from './shape.ts'

/**
 * Latin American Spanish. The words match Spain; the numbers do not, and `Intl.NumberFormat`
 * handles that on its own.
 */
const es419: SpeechModule = {
  approximately: 'aproximadamente {value}',
  minus: 'menos {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'sin tiempo restante',
  units: {
    second: { one: '{n} segundo', other: '{n} segundos' },
    minute: { one: '{n} minuto', other: '{n} minutos' },
    hour: { one: '{n} hora', other: '{n} horas' },
    day: { one: '{n} día', other: '{n} días' },
  },
  joinDuration: '{first} y {second}',
  rate: '{value} {out} por {in}',
  noRate: 'sin tasa de {in} a {out}',
}

export default es419

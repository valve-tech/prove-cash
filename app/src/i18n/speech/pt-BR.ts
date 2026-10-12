import type { SpeechModule } from './shape.ts'

/** Brazilian Portuguese. Zero takes the singular here, which European Portuguese does not. */
const ptBR: SpeechModule = {
  approximately: 'aproximadamente {value}',
  minus: 'menos {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'sem tempo restante',
  units: {
    second: { one: '{n} segundo', other: '{n} segundos' },
    minute: { one: '{n} minuto', other: '{n} minutos' },
    hour: { one: '{n} hora', other: '{n} horas' },
    day: { one: '{n} dia', other: '{n} dias' },
  },
  joinDuration: '{first} e {second}',
  rate: '{value} {out} por {in}',
  noRate: 'sem taxa de {in} para {out}',
}

export default ptBR

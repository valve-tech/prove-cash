import type { SpeechModule } from './shape.ts'

/** Italian. */
const it: SpeechModule = {
  approximately: 'circa {value}',
  minus: 'meno {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'tempo scaduto',
  units: {
    second: { one: '{n} secondo', other: '{n} secondi' },
    minute: { one: '{n} minuto', other: '{n} minuti' },
    hour: { one: '{n} ora', other: '{n} ore' },
    day: { one: '{n} giorno', other: '{n} giorni' },
  },
  joinDuration: '{first} e {second}',
  rate: '{value} {out} per {in}',
  noRate: 'nessun tasso da {in} a {out}',
}

export default it

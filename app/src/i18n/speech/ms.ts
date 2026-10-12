import type { SpeechModule } from './shape.ts'

/** Malay. No plurals. The words differ from Indonesian where the two languages differ. */
const ms: SpeechModule = {
  approximately: 'kira-kira {value}',
  minus: 'negatif {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'masa tamat',
  units: {
    second: { other: '{n} saat' },
    minute: { other: '{n} minit' },
    hour: { other: '{n} jam' },
    day: { other: '{n} hari' },
  },
  joinDuration: '{first} {second}',
  rate: '{value} {out} setiap {in}',
  noRate: 'tiada kadar {in} ke {out}',
}

export default ms

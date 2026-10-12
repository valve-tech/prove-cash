import type { SpeechModule } from './shape.ts'

/** Indonesian. No plurals. */
const id: SpeechModule = {
  approximately: 'sekitar {value}',
  minus: 'negatif {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'waktu habis',
  units: {
    second: { other: '{n} detik' },
    minute: { other: '{n} menit' },
    hour: { other: '{n} jam' },
    day: { other: '{n} hari' },
  },
  joinDuration: '{first} {second}',
  rate: '{value} {out} per {in}',
  noRate: 'tidak ada kurs {in} ke {out}',
}

export default id

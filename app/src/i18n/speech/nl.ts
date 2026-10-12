import type { SpeechModule } from './shape.ts'

/** Dutch. "uur" does not change after a numeral; the others do. */
const nl: SpeechModule = {
  approximately: 'ongeveer {value}',
  minus: 'min {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'geen tijd meer',
  units: {
    second: { one: '{n} seconde', other: '{n} seconden' },
    minute: { one: '{n} minuut', other: '{n} minuten' },
    hour: { one: '{n} uur', other: '{n} uur' },
    day: { one: '{n} dag', other: '{n} dagen' },
  },
  joinDuration: '{first} en {second}',
  rate: '{value} {out} per {in}',
  noRate: 'geen koers voor {in} naar {out}',
}

export default nl

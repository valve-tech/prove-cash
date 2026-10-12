import type { SpeechModule } from './shape.ts'

/**
 * Romanian. From 20 up the noun needs "de" in front of it — 19 ore, 20 de ore — which is the
 * `other` form here.
 */
const ro: SpeechModule = {
  approximately: 'aproximativ {value}',
  minus: 'minus {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'timpul a expirat',
  units: {
    second: { one: '{n} secundă', few: '{n} secunde', other: '{n} de secunde' },
    minute: { one: '{n} minut', few: '{n} minute', other: '{n} de minute' },
    hour: { one: '{n} oră', few: '{n} ore', other: '{n} de ore' },
    day: { one: '{n} zi', few: '{n} zile', other: '{n} de zile' },
  },
  joinDuration: '{first} și {second}',
  rate: '{value} {out} pentru 1 {in}',
  noRate: 'niciun curs de la {in} la {out}',
}

export default ro

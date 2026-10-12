import type { SpeechModule } from './shape.ts'

/** French. Zero takes the singular, which is why `one` and not a count test decides the noun. */
const fr: SpeechModule = {
  approximately: 'environ {value}',
  minus: 'moins {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'plus de temps',
  units: {
    second: { one: '{n} seconde', other: '{n} secondes' },
    minute: { one: '{n} minute', other: '{n} minutes' },
    hour: { one: '{n} heure', other: '{n} heures' },
    day: { one: '{n} jour', other: '{n} jours' },
  },
  joinDuration: '{first} {second}',
  rate: '{value} {out} par {in}',
  noRate: 'aucun taux pour {in} vers {out}',
}

export default fr

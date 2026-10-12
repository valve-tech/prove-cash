import type { SpeechModule } from './shape.ts'

/** Greek. */
const el: SpeechModule = {
  approximately: 'περίπου {value}',
  minus: 'μείον {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'δεν απομένει χρόνος',
  units: {
    second: { one: '{n} δευτερόλεπτο', other: '{n} δευτερόλεπτα' },
    minute: { one: '{n} λεπτό', other: '{n} λεπτά' },
    hour: { one: '{n} ώρα', other: '{n} ώρες' },
    day: { one: '{n} ημέρα', other: '{n} ημέρες' },
  },
  joinDuration: '{first} και {second}',
  rate: '{value} {out} ανά {in}',
  noRate: 'δεν υπάρχει ισοτιμία {in} προς {out}',
}

export default el

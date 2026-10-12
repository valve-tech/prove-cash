import type { SpeechModule } from './shape.ts'

/**
 * Turkish. A noun after a numeral stays singular, and the rate puts the denominator first:
 * "WPLS başına".
 */
const tr: SpeechModule = {
  approximately: 'yaklaşık {value}',
  minus: 'eksi {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'süre doldu',
  units: {
    second: { one: '{n} saniye', other: '{n} saniye' },
    minute: { one: '{n} dakika', other: '{n} dakika' },
    hour: { one: '{n} saat', other: '{n} saat' },
    day: { one: '{n} gün', other: '{n} gün' },
  },
  joinDuration: '{first} {second}',
  rate: '{in} başına {value} {out}',
  noRate: '{in} için {out} kuru yok',
}

export default tr

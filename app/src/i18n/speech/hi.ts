import type { SpeechModule, UnitForms } from './shape.ts'

/**
 * The oblique, which a postposition forces.
 *
 * Hindi reaches every one of these sentences through a postposition — बाद، पहले، में، तक — so all
 * four slots want the oblique and only the citation slot keeps the direct case. घंटा is the one
 * noun that shows it: `1 घंटे बाद`, not `1 घंटा बाद`. सेकंड, मिनट and दिन do not change, and the
 * plural घंटे is already the form the oblique wants.
 */
const oblique: UnitForms = {
  hour: { one: '{n} घंटे' },
}

/** Hindi. "प्रति" leads the denominator, so the rate names the input token first. */
const hi: SpeechModule = {
  approximately: 'लगभग {value}',
  minus: 'ऋण {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'समय समाप्त',
  units: {
    second: { one: '{n} सेकंड', other: '{n} सेकंड' },
    minute: { one: '{n} मिनट', other: '{n} मिनट' },
    hour: { one: '{n} घंटा', other: '{n} घंटे' },
    day: { one: '{n} दिन', other: '{n} दिन' },
  },
  unitsMeasure: oblique,
  unitsSpan: oblique,
  unitsWithin: oblique,
  unitsElapsed: oblique,
  joinDuration: '{first} {second}',
  rate: 'प्रति {in} {value} {out}',
  noRate: '{in} से {out} के लिए कोई दर नहीं',
}

export default hi

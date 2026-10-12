import type { SpeechModule, UnitForms } from './shape.ts'

/**
 * The dual as anything but a subject writes it.
 *
 * Every sentence here reaches the duration through a preposition — بعد، قبل، خلال، لمدة — and a
 * preposition governs the genitive. The dual is the only form that writes that down: the
 * nominative ends in ـان and everything else in ـين, so `بعد ثانيتين` is right and `بعد ثانيتان`
 * is not. The accusative of a bare measure ends the same way, so all four slots share this table.
 * The singular and the counted forms keep their spelling, because their case shows only in
 * diacritics this module does not write.
 */
const oblique: UnitForms = {
  second: { two: 'ثانيتين' },
  minute: { two: 'دقيقتين' },
  hour: { two: 'ساعتين' },
  day: { two: 'يومين' },
}

/**
 * Arabic. Six forms: one, a dual that drops the numeral, a paucal for 3 to 10, and the
 * accusative singular from 11 up. "تقريبًا" follows the figure rather than leading it.
 */
const ar: SpeechModule = {
  approximately: '{value} تقريبًا',
  minus: 'سالب {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'انتهى الوقت',
  units: {
    second: {
      zero: '{n} ثانية',
      one: 'ثانية واحدة',
      two: 'ثانيتان',
      few: '{n} ثوانٍ',
      many: '{n} ثانية',
      other: '{n} ثانية',
    },
    minute: {
      zero: '{n} دقيقة',
      one: 'دقيقة واحدة',
      two: 'دقيقتان',
      few: '{n} دقائق',
      many: '{n} دقيقة',
      other: '{n} دقيقة',
    },
    hour: {
      zero: '{n} ساعة',
      one: 'ساعة واحدة',
      two: 'ساعتان',
      few: '{n} ساعات',
      many: '{n} ساعة',
      other: '{n} ساعة',
    },
    day: {
      zero: '{n} يوم',
      one: 'يوم واحد',
      two: 'يومان',
      few: '{n} أيام',
      many: '{n} يومًا',
      other: '{n} يوم',
    },
  },
  unitsMeasure: oblique,
  unitsSpan: oblique,
  unitsWithin: oblique,
  unitsElapsed: oblique,
  joinDuration: '{first} و{second}',
  rate: '{value} {out} لكل {in}',
  noRate: 'لا يوجد سعر لتحويل {in} إلى {out}',
}

export default ar

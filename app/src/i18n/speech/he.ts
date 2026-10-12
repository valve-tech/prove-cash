import type { SpeechModule } from './shape.ts'

/** Hebrew. A dual form that speaks no numeral at all: two hours is "שעתיים", never "2 שעות". */
const he: SpeechModule = {
  approximately: 'בערך {value}',
  minus: 'מינוס {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'הזמן נגמר',
  units: {
    second: { one: 'שנייה אחת', two: 'שתי שניות', other: '{n} שניות' },
    minute: { one: 'דקה אחת', two: 'שתי דקות', other: '{n} דקות' },
    hour: { one: 'שעה אחת', two: 'שעתיים', other: '{n} שעות' },
    day: { one: 'יום אחד', two: 'יומיים', other: '{n} ימים' },
  },
  joinDuration: '{first} ו-{second}',
  rate: '{value} {out} לכל {in}',
  noRate: 'אין שער מ-{in} ל-{out}',
}

export default he

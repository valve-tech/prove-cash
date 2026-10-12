import type { SpeechModule } from './shape.ts'

/** Thai. No plurals, and a classifier is not needed for these four units. */
const th: SpeechModule = {
  approximately: 'ประมาณ {value}',
  minus: 'ลบ {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'หมดเวลา',
  units: {
    second: { other: '{n} วินาที' },
    minute: { other: '{n} นาที' },
    hour: { other: '{n} ชั่วโมง' },
    day: { other: '{n} วัน' },
  },
  joinDuration: '{first} {second}',
  rate: '{value} {out} ต่อ {in}',
  noRate: 'ไม่มีอัตราแลกเปลี่ยน {in} เป็น {out}',
}

export default th

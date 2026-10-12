import type { SpeechModule } from './shape.ts'

/** Vietnamese. No plurals. */
const vi: SpeechModule = {
  approximately: 'khoảng {value}',
  minus: 'âm {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'hết thời gian',
  units: {
    second: { other: '{n} giây' },
    minute: { other: '{n} phút' },
    hour: { other: '{n} giờ' },
    day: { other: '{n} ngày' },
  },
  joinDuration: '{first} {second}',
  rate: '{value} {out} trên mỗi {in}',
  noRate: 'không có tỷ giá {in} sang {out}',
}

export default vi

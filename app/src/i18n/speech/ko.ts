import type { SpeechModule } from './shape.ts'

/** Korean. Counters attach to the numeral; the rate names the denominator first. */
const ko: SpeechModule = {
  approximately: '약 {value}',
  minus: '마이너스 {value}',
  amount: '{value} {symbol}',
  noTimeLeft: '남은 시간 없음',
  units: {
    second: { other: '{n}초' },
    minute: { other: '{n}분' },
    hour: { other: '{n}시간' },
    day: { other: '{n}일' },
  },
  joinDuration: '{first} {second}',
  rate: '{in} 1개당 {value} {out}',
  noRate: '{in}에서 {out}로의 환율 없음',
}

export default ko

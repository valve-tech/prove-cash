import type { SpeechModule } from './shape.ts'

/** Traditional Chinese. Same structure as the simplified module, different characters. */
const zhHant: SpeechModule = {
  approximately: '約{value}',
  minus: '負{value}',
  amount: '{value} {symbol}',
  noTimeLeft: '已無剩餘時間',
  units: {
    second: { other: '{n}秒' },
    minute: { other: '{n}分鐘' },
    hour: { other: '{n}小時' },
    day: { other: '{n}天' },
  },
  joinDuration: '{first}{second}',
  rate: '1 {in} 兌 {value} {out}',
  noRate: '沒有 {in} 兌 {out} 的匯率',
}

export default zhHant

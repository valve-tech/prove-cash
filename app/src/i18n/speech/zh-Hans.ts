import type { SpeechModule } from './shape.ts'

/**
 * Simplified Chinese. No space before a counter, and a rate reads forward: one unit in,
 * so much out.
 */
const zhHans: SpeechModule = {
  approximately: '约{value}',
  minus: '负{value}',
  amount: '{value} {symbol}',
  noTimeLeft: '已无剩余时间',
  units: {
    second: { other: '{n}秒' },
    minute: { other: '{n}分钟' },
    hour: { other: '{n}小时' },
    day: { other: '{n}天' },
  },
  joinDuration: '{first}{second}',
  rate: '1 {in} 兑 {value} {out}',
  noRate: '没有 {in} 兑 {out} 的汇率',
}

export default zhHans

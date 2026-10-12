import type { SpeechModule } from './shape.ts'

/**
 * Japanese. Counters take no space and no plural, and the rate names the denominator first:
 * "1 WPLS あたり".
 */
const ja: SpeechModule = {
  approximately: '約{value}',
  minus: 'マイナス{value}',
  amount: '{value} {symbol}',
  noTimeLeft: '残り時間なし',
  units: {
    second: { other: '{n}秒' },
    minute: { other: '{n}分' },
    hour: { other: '{n}時間' },
    day: { other: '{n}日' },
  },
  joinDuration: '{first}{second}',
  rate: '1 {in} あたり {value} {out}',
  noRate: '{in} から {out} のレートはありません',
}

export default ja

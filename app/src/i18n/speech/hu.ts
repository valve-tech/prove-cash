import type { SpeechModule, UnitForms } from './shape.ts'

/**
 * The terminative, which is how Hungarian says "for a period".
 *
 * The `-ig` goes on the noun and stays there at every count: `1 percig`, `5 percig`. `óra` takes
 * the linking lengthening as well, so `óráig`. A bare Hungarian measure keeps the plain noun —
 * `5 perc múlva` — so this slot cannot share one with it, and that is why the span slot exists.
 */
const terminative: UnitForms = {
  second: { one: '{n} másodpercig', other: '{n} másodpercig' },
  minute: { one: '{n} percig', other: '{n} percig' },
  hour: { one: '{n} óráig', other: '{n} óráig' },
  day: { one: '{n} napig', other: '{n} napig' },
}

/**
 * The instrumental, which `ezelőtt` governs: `5 perccel ezelőtt`, not `5 perc ezelőtt`.
 *
 * Both categories carry the same word, because Hungarian does not inflect a noun for number after
 * a numeral — and both must be written down anyway. A table that declared only `other` would lose
 * at one: the lookup reaches `units.one` before it ever reaches this table's floor.
 */
const instrumental: UnitForms = {
  second: { one: '{n} másodperccel', other: '{n} másodperccel' },
  minute: { one: '{n} perccel', other: '{n} perccel' },
  hour: { one: '{n} órával', other: '{n} órával' },
  day: { one: '{n} nappal', other: '{n} nappal' },
}

/**
 * Hungarian. A noun after a numeral stays singular, and the rate names the denominator first
 * with "egységenként".
 */
const hu: SpeechModule = {
  approximately: 'körülbelül {value}',
  minus: 'mínusz {value}',
  amount: '{value} {symbol}',
  noTimeLeft: 'lejárt az idő',
  units: {
    second: { one: '{n} másodperc', other: '{n} másodperc' },
    minute: { one: '{n} perc', other: '{n} perc' },
    hour: { one: '{n} óra', other: '{n} óra' },
    day: { one: '{n} nap', other: '{n} nap' },
  },
  unitsSpan: terminative,
  unitsElapsed: instrumental,
  joinDuration: '{first} {second}',
  rate: '{in} egységenként {value} {out}',
  noRate: 'nincs {in}–{out} árfolyam',
}

export default hu

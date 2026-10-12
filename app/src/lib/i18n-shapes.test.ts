/**
 * One placeholder name, one shape — declared here, once, for the whole dictionary.
 *
 * A translator sees `{tx}` and has to guess what will land in it. That is not a rhetorical
 * worry: `{tx}` really was a bare figure in `custody.cost.signature` (`1`, `2`, `1–2`, `≤1`) and
 * a whole noun phrase in `custody.spoken.escrow` (`one transaction`). No single translation of
 * either frame can be right for both, and nothing said so — the parity test compares placeholder
 * SETS, so two keys agreeing on the name agree as far as it can see.
 *
 * Four audits raised the same class of thing. `{duration}` arrives already formatted AND already
 * inflected — Greek gets `1 ημέρα` — so the sentence around it cannot govern it; a translator
 * who does not know that writes a preposition their language will not accept there. `en.ts`
 * warns about exactly this in its own header and then does it.
 *
 * So the shape is written down. The test is that every placeholder in the dictionary appears in
 * the table below, which forces a decision when somebody adds one, and puts the answer where a
 * translator's question can be answered from.
 */
import { describe, expect, test } from 'vitest'
import { en } from '../i18n/en.ts'

/**
 * What lands in each placeholder.
 *
 *   figure    a number already formatted for the reader's locale, and nothing else. It may carry
 *             a comparison — `≤1` — but never a unit and never a noun.
 *   phrase    a whole noun phrase, already agreed with its own count. Place it; do not put an
 *             article or a numeral in front of it.
 *   name      a token symbol, a chain, a language, a host. Never translated, never inflected.
 *   opaque    a hash, an address, a URL, a revert string. Not language at all.
 *   word      a SINGLE word this app substitutes into a frame the translator wrote — "the
 *             {kind} endpoint". Milder than a phrase and still a hazard: the word has to agree
 *             with a noun beside it, and a translator cannot inflect what they cannot see. The
 *             three sites are pinned below so the set cannot grow quietly.
 */
type Shape = 'figure' | 'phrase' | 'word' | 'name' | 'opaque'

const SHAPE: Record<string, Shape> = {
  // Figures. `count` is the big one: `tCount` fills it from the number it was given.
  count: 'figure',
  total: 'figure',
  amount: 'figure',
  loaded: 'figure',
  rate: 'figure',
  pct: 'figure',
  signed: 'figure',
  market: 'figure',
  least: 'figure',
  size: 'figure',
  moved: 'figure',
  levels: 'figure',
  fills: 'figure',
  net: 'figure',
  reposts: 'figure',
  from: 'figure',
  to: 'figure',
  n: 'figure',
  block: 'figure',
  fee: 'figure',
  max: 'figure',
  // The sign form has two rate ceilings and they are different numbers: `cap` is the form's own
  // limit, `max` is the one the settlement enforces. Both render in the same field.
  cap: 'figure',
  floor: 'figure',
  // The defaults' own "high" line, already formatted as a percentage. `sign.fee.warn`.
  warn: 'figure',
  price: 'figure',
  gas: 'figure',
  fill: 'figure',
  hour: 'figure',
  hours: 'figure',
  value: 'figure',
  // A countdown, in whole seconds. The unit letter is inside the sentence, so a translator may
  // move it or replace it.
  seconds: 'figure',

  // Phrases this app built out of the reader's own language, already agreed with their counts.
  duration: 'phrase',
  transactions: 'phrase',
  time: 'phrase',
  date: 'phrase',
  cost: 'phrase',
  where: 'phrase',
  mode: 'phrase',
  partial: 'phrase',
  decay: 'phrase',
  verdict: 'phrase',
  health: 'phrase',
  title: 'phrase',
  label: 'phrase',
  note: 'phrase',
  reason: 'phrase',
  name: 'phrase',

  // Single words dropped into a frame. See `word` above for why these are their own class.
  side: 'word',
  kind: 'word',
  sort: 'word',
  language: 'word',

  // A list of token symbols, joined the way the reader's language joins a list. Built with
  // `Intl.ListFormat`, so it arrives complete.
  tokens: 'phrase',

  // Names, which every language leaves alone.
  symbol: 'name',
  base: 'name',
  quote: 'name',
  in: 'name',
  out: 'name',
  pair: 'name',
  netSymbol: 'name',
  network: 'name',
  board: 'name',
  hosts: 'name',
  prefix: 'name',
  id: 'name',
  expected: 'name',

  // ── The fill console ──────────────────────────────────────────────────────────────────────
  //
  // Its amounts arrive with their token symbol already attached — `9.85 DAI`, `90.5 PLS` — the
  // way `amount` above already does. The symbol never translates and never inflects, so a
  // sentence around one of these places it and nothing more.
  above: 'figure',
  burn: 'figure',
  gross: 'figure',
  offer: 'figure',
  open: 'figure',
  pls: 'figure',
  proceeds: 'figure',
  spot: 'figure',
  target: 'figure',
  usd: 'figure',
  // Plain counts, with the unit written into the sentence rather than into the value.
  blocks: 'figure',
  gwei: 'figure',
  now: 'figure',
  median: 'figure',
  units: 'figure',
  impact: 'figure',
  // Durations from the console's own `elapsed` formatter — `21m 44s`, `24h 0m`, `0s`. NOT the
  // speech layer's `spokenDuration`, and the difference matters to a translator: the unit letters
  // are Latin and fixed, so the value carries no ending in any language and a preposition in front
  // of one governs nothing. That is the opposite of `duration` above, which arrives inflected and
  // cannot be governed. A translator who reads this row as "another `duration`" will go looking
  // for a speech table that does not apply here.
  later: 'phrase',
  opens: 'phrase',
  expires: 'phrase',
  span: 'phrase',
  // Clauses this app assembled in the reader's own language and hands over whole.
  depth: 'phrase',
  // `share` is a figure nearly always — `7/29`, the burn's cut of the pool fee — and a phrase only
  // on the branch where `burn.all` fills it. Declared as the wider of the two, because a sentence
  // that can hold a phrase can hold a figure and not the other way round.
  share: 'phrase',
  state: 'phrase',

  // Not language at all.
  address: 'opaque',
  hash: 'opaque',
  error: 'opaque',
  text: 'opaque',
  // Expressions, as opposed to figures: `124,975 gas × 783,379 gwei = 90.7 PLS ≈ $0.00101`,
  // `1,001.99 DAI − 975.06 DAI = 26.93 DAI`, `627,841 – 1,308,703`. Each is arithmetic rather
  // than a sentence, the console builds the whole of it, and each arrives already forced to run
  // left to right — see `ltr` in `lib/i18n`. Place one; never break one apart.
  line: 'opaque',
  sum: 'opaque',
  range: 'opaque',
}

/** Every `{name}` the dictionary uses, and which keys use it. */
const used = new Map<string, string[]>()
for (const [key, value] of Object.entries(en)) {
  if (typeof value !== 'string') continue
  for (const m of value.matchAll(/\{(\w+)\}/g)) {
    const name = m[1] ?? ''
    if (!used.has(name)) used.set(name, [])
    used.get(name)!.push(key)
  }
}

describe('every placeholder declares what lands in it', () => {
  test('there are placeholders to check', () => {
    expect(used.size).toBeGreaterThan(20)
  })

  test('none is undeclared', () => {
    // Adding a placeholder is a decision about what a translator will be handed. This is where
    // that decision gets made, rather than at the call site where nobody reading a locale file
    // can see it.
    const missing = [...used.keys()].filter((n) => !(n in SHAPE)).sort()
    expect(missing, 'add these to SHAPE, with what actually arrives in them').toEqual([])
  })

  test('none is declared and unused', () => {
    // Litter, and worse than litter: it makes the table look like it covers something it does
    // not, and hides a rename.
    const stale = Object.keys(SHAPE).filter((n) => !used.has(n)).sort()
    expect(stale, 'these are in SHAPE and in no string').toEqual([])
  })
})

describe('the defect this exists for', () => {
  test('no key carries a bare `tx` as a figure any more', () => {
    // The compact rows say `{count} tx` and the spoken ones say `{transactions}`. One name, one
    // shape: a translator reading either knows what is coming.
    expect(en['custody.cost.signature']).toContain('{count}')
    expect(en['custody.cost.signatures.tx']).toContain('{count}')
    expect(en['custody.spoken.escrow']).toContain('{transactions}')
    expect(en['custody.spoken.approval']).toContain('{transactions}')
  })

  test('a figure placeholder is never the only thing in its own sentence', () => {
    // A key that is nothing but `{amount}` is not a translation, it is a variable with a key
    // name — and it hides the fact that the app assembled the sentence somewhere else.
    const bare = Object.entries(en)
      .filter(([, v]) => typeof v === 'string' && /^\{\w+\}$/.test(v))
      .map(([k]) => k)
    expect(bare).toEqual([])
  })
})

/** Every key that puts an English article in front of a substituted `shape`. */
function articled(shape: Shape): string[] {
  const names = Object.entries(SHAPE)
    .filter(([, s]) => s === shape)
    .map(([n]) => n)
  const out: string[] = []
  for (const [key, value] of Object.entries(en)) {
    if (typeof value !== 'string') continue
    for (const n of names) {
      if (new RegExp(`\\b(a|an|the|one|two)\\s+\\{${n}\\}`, 'i').test(value)) out.push(key)
    }
  }
  return out.sort()
}

describe('what a phrase placeholder promises', () => {
  test('no sentence puts an English article in front of one', () => {
    // `{duration}` arrives as "1 day" and `{transactions}` as "one transaction", each already
    // agreed with its own count in the reader's language. "a {duration}" cannot be translated:
    // the article would have to agree with a noun the translator cannot see.
    expect(articled('phrase')).toEqual([])
  })

  test('the three frames that inflect a substituted word are exactly these', () => {
    // Not fixed, and pinned rather than hidden. "Check the {kind} endpoint" reads fine in
    // English and asks a French translator to write an article and an adjective that agree with
    // a word arriving at run time. Fixing it means one whole key per value — `rpc.check.board`
    // and `rpc.check.chain` — which is four more strings across thirty-five files for two
    // sentences nobody has complained about.
    //
    // The test is that the set does not GROW. A fourth one is a new decision, and this is where
    // it gets made.
    expect(articled('word')).toEqual([
      'rpc.check.label',
      'rpc.reset.label',
      'sign.token.choose',
    ])
  })
})

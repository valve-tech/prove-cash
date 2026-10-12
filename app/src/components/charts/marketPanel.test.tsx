/**
 * Which drawing the panel actually renders, per variant and per screen.
 *
 * `variants.test.ts` proves the registry offers the right things. This proves the panel draws
 * them: the two are a matched pair and neither catches the other's failure. A variant offered in
 * the menu with no branch here renders an empty panel — no error, no fallback, nothing at all —
 * because every branch is a `&&` on `active` and falling through them all is silent.
 *
 * Only `Reserves` had ever been rendered in a test. Ladder, Capacity, Impact, Tape and the sign
 * curve had not, on any screen.
 *
 * Each chart is identified by its own `figure` caption, which is the sentence a screen reader
 * gets — so this asserts on the thing a reader would actually receive rather than on a class name.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Address } from 'viem'
import { CURVE_LINEAR, type TokenInfo } from '@prove.cash/sdk'
import type { Level } from './book'

const base: TokenInfo = {
  address: '0x000000000000000000000000000000000000000a' as Address,
  symbol: 'tPLSX',
  decimals: 18,
}
const quote: TokenInfo = {
  address: '0x000000000000000000000000000000000000000b' as Address,
  symbol: 'tUSDC',
  decimals: 6,
}

const levels: Level[] = [
  { rate: 0.0395, size: 1_000, side: 'bid', count: 2 },
  { rate: 0.0405, size: 1_200, side: 'ask', count: 3 },
]

/**
 * `useBook` reads the chain, so it is replaced wholesale.
 *
 * The panel's job is routing, not fetching: which component gets the data. Mocking the hook is
 * what leaves that visible — a real read here would make this a test of the endpoint.
 */
/** One live offer, because `Tape` draws offers over time and has nothing to draw without one. */
const intent = {
  maker: '0x000000000000000000000000000000000000dead' as Address,
  recipient: '0x000000000000000000000000000000000000dead' as Address,
  tokenIn: base.address,
  tokenOut: quote.address,
  amountIn: 10n ** 20n,
  minOutStart: 4_000_000n,
  minOutEnd: 3_900_000n,
  curve: CURVE_LINEAR,
  minFill: 0n,
  authNonce: `0x${'00'.repeat(32)}`,
  startTime: 1_799_999_400n,
  endTime: 1_800_003_000n,
  executor: '0x0000000000000000000000000000000000000000' as Address,
  feeConfig: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  feeRate: 0n,
  flags: 1,
  nonce: 1n,
}

const book = {
  levels,
  intents: [intent],
  now: 1_800_000_000n,
  reserves: { x: 10_000, y: 400 },
  gamma: 0.9971,
  poolState: 'pool' as const,
  loading: false,
}
vi.mock('./useBook', () => ({ useBook: () => book }))

/**
 * The width the browser would have given the box.
 *
 * Every chart here draws from a measured width and renders NOTHING until it has one — zero means
 * "not measured yet", and there is no layout in a static render. So without this the panel comes
 * back as a heading over an empty div for every variant, and a test asserting on that proves
 * only that React ran.
 *
 * A knob rather than a constant, because the compact breakpoint is a thing worth asserting.
 */
let width = 900
vi.mock('./useMeasuredWidth', () => ({
  useMeasuredWidth: () => [() => {}, width] as const,
}))

const { MarketPanel } = await import('./MarketPanel')
const { DEFAULT_VARIANT, variantsFor } = await import('./variants')
const { en } = await import('../../i18n/en.ts')

/**
 * A fragment of each chart's own caption, which is how one is told from another.
 *
 * Taken from AFTER the placeholders, deliberately. The first cut of this split each caption at
 * its first `{` — and two of the five begin with one, so their markers were the empty string and
 * `toContain('')` passed against any markup at all. Two of these assertions proved nothing until
 * a `not.toContain` failed and said so.
 */
const MARKER: Record<string, string> = {
  ladder: 'price levels.',
  capacity: 'how much fills at each price.',
  impact: 'with the resting offers on it.',
  tape: 'across its remaining life:',
  reserves: 'in reserve space:',
}

for (const [id, marker] of Object.entries(MARKER)) {
  if (marker.length === 0) throw new Error(`${id} has an empty marker, which matches everything`)
}

function stored(map: Record<string, string>) {
  const s = new Map(Object.entries(map))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => s.get(k) ?? null,
    setItem: (k: string, v: string) => void s.set(k, v),
  } as unknown as Storage)
}

const draw = (props: Parameters<typeof MarketPanel>[0]) => renderToStaticMarkup(<MarketPanel {...props} />)

beforeEach(() => {
  stored({})
  width = 900
})
afterEach(() => vi.unstubAllGlobals())

describe('every variant the menu offers has a branch that draws it', () => {
  for (const ctx of ['sign', 'board'] as const) {
    for (const v of variantsFor(ctx)) {
      // `curve` needs a draft to place, and without one the panel deliberately draws nothing —
      // that is the sign form's own empty state, covered below rather than here.
      if (v.id === 'curve') continue
      test(`${ctx}: ${v.id}`, () => {
        stored({ [`prove.chart.${ctx}`]: v.id })
        const html = draw({ context: ctx, base, quote })
        expect(html).toContain(MARKER[v.id]!)
      })
    }
  }
})

describe('what each screen opens on', () => {
  test('the board opens on the ladder', () => {
    expect(DEFAULT_VARIANT.board).toBe('ladder')
    expect(draw({ context: 'board', base, quote })).toContain(MARKER.ladder!)
  })

  test('sign opens on the curve, and draws it only with a draft to place', () => {
    expect(DEFAULT_VARIANT.sign).toBe('curve')
    // No draft: the panel is empty rather than showing a different chart under the curve's name.
    const bare = draw({ context: 'sign', base, quote })
    for (const marker of Object.values(MARKER)) expect(bare).not.toContain(marker)

    const withDraft = draw({
      context: 'sign',
      base,
      quote,
      draft: { amountIn: '100', minOut: '3.9', minOutEnd: '3.9', dutch: false, duration: 600 },
      pool: null,
    } as never)
    expect(withDraft.length).toBeGreaterThan(bare.length)
  })
})

describe('what the panel does when it cannot draw', () => {
  test('no pair named: it says so rather than drawing an empty axis', () => {
    const html = draw({ context: 'board', base: null, quote: null })
    expect(html).toContain(en['chart.pool.pick'])
  })

  test('the same token both sides is not a pair', () => {
    const html = draw({ context: 'board', base, quote: base })
    expect(html).toContain(en['chart.pool.pick'])
  })

  test('a saved variant this screen does not offer falls back, and draws something', () => {
    // `curve` is sign-only. On the board it has no branch at all, so without the fallback in
    // `MarketPanel` the panel would render its heading and nothing else.
    stored({ 'prove.chart.board': 'curve' })
    const html = draw({ context: 'board', base, quote })
    expect(html).toContain(MARKER[variantsFor('board')[0]!.id]!)
  })
})

describe('the switcher', () => {
  test('the menu names the drawing that is on', () => {
    // It renders closed, so only the active label is in the markup. That is the one that has to
    // be right: a menu whose button disagrees with the chart under it is worse than no menu.
    stored({ 'prove.chart.board': 'tape' })
    const html = draw({ context: 'board', base, quote })
    expect(html).toContain(en['chart.v.tape'])
    expect(html).toContain(MARKER.tape!)
  })

  test('the menu carries its own label, because a bare caret says nothing', () => {
    expect(draw({ context: 'board', base, quote })).toContain(en['chart.pick'])
  })

  test('the panel is named for a screen reader even though the heading is hidden', () => {
    const html = draw({ context: 'board', base, quote })
    expect(html).toContain(en['chart.pool.label'])
  })
})

describe('at a phone width', () => {
  test('the charts still draw, and say the same thing', () => {
    // 375px is the narrowest real device. A chart that renders nothing there is a blank panel on
    // most of the traffic, and the caption is what a screen reader gets either way.
    width = 375
    for (const v of variantsFor('board')) {
      stored({ 'prove.chart.board': v.id })
      expect(draw({ context: 'board', base, quote }), v.id).toContain(MARKER[v.id]!)
    }
  })

  test('an unmeasured box draws no chart at all, rather than one at zero width', () => {
    // Zero is "not measured yet". Drawing at it would put a degenerate axis on screen for a
    // frame, and divide by it in the scales.
    width = 0
    const html = draw({ context: 'board', base, quote })
    for (const marker of Object.values(MARKER)) expect(html).not.toContain(marker)
    // The frame is still there, so nothing jumps when the measurement arrives.
    expect(html).toContain(en['chart.pool.label'])
  })
})

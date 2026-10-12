import { describe, expect, test } from 'vitest'
import { en } from '../../i18n/en.ts'
import {
  DEFAULT_CHART_H,
  DEFAULT_CHART_W,
  KEY_GUTTER,
  barFrame,
  chartFrame,
  flowFrame,
  flowHeight,
  DEFAULT_FLOW_H,
  lin,
  pt,
  ribbon,
} from './geometry.ts'
import { PERCENT, TOKENS, amountOf, build, type Settings } from './model.ts'

/**
 * The shape the console draws, at its breakpoints and inside every region.
 *
 * A polyline that draws the wrong shape is invisible to a test that only checks its endpoints: a
 * curve at one per cent and a curve at two agree at both ends of the window and disagree
 * everywhere a reader actually looks. `charts/chart.test.ts` is the pattern this follows.
 */

const BASE: Settings = {
  tokenIn: TOKENS[0] as (typeof TOKENS)[number],
  tokenOut: TOKENS[3] as (typeof TOKENS)[number],
  sizeUsd: 1_000,
  floorPct: 0.045,
  feeRate: PERCENT,
  dutch: true,
  opensSec: 0,
  expiresSec: 86_400,
  rung: 'allowance',
  cold: false,
  venue: 'v2',
  baseFeeGwei: 783_379,
  atSec: 43_200,
  step: 0,
}

const RATES = [0n, PERCENT, 2n * PERCENT]
const frameFor = (s: Settings, w = DEFAULT_CHART_W, h = DEFAULT_CHART_H) =>
  chartFrame(s, build(s), RATES, w, h)

describe('scales', () => {
  test('maps a data range onto a pixel range', () => {
    const x = lin(0, 100, 10, 110)
    expect(x(0)).toBe(10)
    expect(x(50)).toBe(60)
    expect(x(100)).toBe(110)
  })

  test('collapses a zero-width domain onto the range start rather than dividing by zero', () => {
    expect(lin(5, 5, 0, 200)(5)).toBe(0)
  })

  test('a point is rounded to a tenth of a pixel, so the markup is stable', () => {
    expect(pt(1.23456, 9.87654)).toBe('1.2,9.9')
  })
})

describe('the price chart', () => {
  test('the plot fits inside the box it was given, at every width', () => {
    for (const [w, h] of [
      [320, 180],
      [DEFAULT_CHART_W, DEFAULT_CHART_H],
      [1400, 520],
    ] as const) {
      const f = frameFor(BASE, w, h)
      expect(f.left).toBeGreaterThanOrEqual(0)
      expect(f.right).toBeLessThanOrEqual(w)
      expect(f.top).toBeGreaterThanOrEqual(0)
      expect(f.bottom).toBeLessThanOrEqual(h)
      for (const c of f.curves) {
        for (const [px, py] of c.points) {
          expect(px).toBeGreaterThanOrEqual(f.left - 0.001)
          expect(px).toBeLessThanOrEqual(f.right + 0.001)
          expect(py).toBeGreaterThanOrEqual(f.top - 0.001)
          expect(py).toBeLessThanOrEqual(f.bottom + 0.001)
        }
      }
    }
  })

  test('time runs left to right, and the gridlines are the quarters of the window', () => {
    const f = frameFor(BASE)
    expect(f.ticks.map(([sec]) => sec)).toEqual([0, 21_600, 43_200, 64_800, 86_400])
    expect(f.ticks[0]?.[1]).toBe(f.left)
    expect(f.ticks[4]?.[1]).toBe(f.right)
    for (let i = 1; i < f.ticks.length; i++) {
      expect(f.ticks[i]?.[1]).toBeGreaterThan(f.ticks[i - 1]?.[1] as number)
    }
  })

  /**
   * The one that a two-point test cannot see. A decaying offer falls from its open to its floor,
   * so on screen it descends monotonically and reaches the floor line exactly at the close.
   */
  test('a dutch curve falls the whole way down, not just at its ends', () => {
    const f = frameFor(BASE)
    const c = f.curves.find((k) => k.selected)
    if (!c) throw new Error('the selected curve must be drawn')
    expect(c.points).toHaveLength(61)
    for (let i = 1; i < c.points.length; i++) {
      // y grows downward, so a falling price is a rising y.
      expect(c.points[i]?.[1]).toBeGreaterThanOrEqual(c.points[i - 1]?.[1] as number)
    }
    // Strictly lower halfway down than at the open, and lower again at the close.
    expect(c.points[30]?.[1]).toBeGreaterThan(c.points[0]?.[1] as number)
    expect(c.points[60]?.[1]).toBeGreaterThan(c.points[30]?.[1] as number)
    expect(c.points[60]?.[1]).toBeCloseTo(f.floorY, 6)
  })

  test('a flat offer draws one level line at the maker’s own number', () => {
    const f = frameFor({ ...BASE, dutch: false })
    const c = f.curves.find((k) => k.selected)
    if (!c) throw new Error('the selected curve must be drawn')
    for (const [, py] of c.points) expect(py).toBeCloseTo(f.floorY, 6)
  })

  /**
   * The fan, and the whole reason it is drawn this way round.
   *
   * The rate is not in the solver's condition, so it does not move the break-even line. What it
   * moves is the offer: a maker who typed a net signs a larger gross at a larger rate. So a
   * higher rate is a HIGHER curve everywhere, and it crosses later.
   */
  test('a higher rate lifts the curve, ends it higher, and crosses later', () => {
    const f = frameFor(BASE)
    const [free, one, two] = f.curves
    if (!free || !one || !two) throw new Error('three curves')
    expect(free.rate).toBe(0n)
    expect(two.rate).toBe(2n * PERCENT)

    // The three open at the same place, within a hair, and that is the point: the opening
    // premium is the market plus a concession, and it has never heard of the rate. What the rate
    // moves is the far end — a maker who typed one net signs a bigger gross at a bigger rate.
    expect(one.points[0]?.[1]).toBeCloseTo(free.points[0]?.[1] as number, 0)

    const last = free.points.length - 1
    expect(one.points[last]?.[1]).toBeLessThan(free.points[last]?.[1] as number)
    expect(two.points[last]?.[1]).toBeLessThan(one.points[last]?.[1] as number)

    // And it is above it all the way down, not only at the close. Sample past the open, where
    // the three have separated, and check every point rather than the two ends.
    for (let i = 5; i <= last; i++) {
      expect(one.points[i]?.[1]).toBeLessThan(free.points[i]?.[1] as number)
      expect(two.points[i]?.[1]).toBeLessThan(one.points[i]?.[1] as number)
    }

    expect(free.crossSec).not.toBeNull()
    expect(one.crossSec).not.toBeNull()
    expect(one.crossSec as number).toBeGreaterThan(free.crossSec as number)
    if (two.crossSec !== null) {
      expect(two.crossSec).toBeGreaterThan(one.crossSec as number)
    }
  })

  test('every curve delivers the maker the same net, whatever it charges', () => {
    // Three offers, one typed number. The fan is a picture of what the rate costs in time, and
    // it would be a lie if the three ends were not the same money to the maker.
    const nets = [0n, PERCENT, 2n * PERCENT].map((feeRate) => build({ ...BASE, feeRate }).floorNet)
    expect(new Set(nets.map(String)).size).toBe(1)
  })

  test('the crossing is where the curve actually meets the break-even line', () => {
    const f = frameFor(BASE)
    for (const c of f.curves) {
      if (c.crossSec === null) continue
      const i = c.points.findIndex(([px]) => Math.abs(px - f.x(c.crossSec as number)) < 0.01)
      expect(i).toBeGreaterThanOrEqual(0)
      // At the crossing the curve is at or under the break-even line; one sample earlier it is
      // above it. A crossing named anywhere else is a minute nothing happens in.
      expect(c.points[i]?.[1]).toBeGreaterThanOrEqual((f.breakEven[i]?.[1] as number) - 0.001)
      if (i > 0) {
        expect(c.points[i - 1]?.[1]).toBeLessThan(f.breakEven[i - 1]?.[1] as number)
      }
      expect(c.crossAt?.[0]).toBeCloseTo(f.x(c.crossSec), 6)
    }
  })

  test('the break-even line sits exactly one gas below the market', () => {
    const s = { ...BASE, baseFeeGwei: 5_000_000 }
    const m = build(s)
    const f = chartFrame(s, m, RATES, DEFAULT_CHART_W, DEFAULT_CHART_H)
    const gas = amountOf(m.gasB, m.b.decimals)
    // One gas, in pixels: the scale is linear, so the gap is the same all the way across.
    const gasPx = (gas * (f.bottom - f.top)) / (f.hi - f.lo)
    expect(gasPx).toBeGreaterThan(0)
    // `known` repeats the marker as its last point, so walk the samples the two share.
    for (let i = 0; i < f.known.length - 1; i++) {
      const market = f.known[i] as readonly [number, number]
      expect((f.breakEven[i]?.[1] as number) - market[1]).toBeCloseTo(gasPx, 6)
    }
    // And it scales with the base fee: ten times the gas is ten times the gap.
    const cheap = build({ ...s, baseFeeGwei: 500_000 })
    expect(Number(m.gasB)).toBeCloseTo(Number(cheap.gasB) * 10, -6)
  })

  test('the market is cut at the marker: what happened, then one sample of what might', () => {
    for (const atSec of [0, 21_600, 43_200, 86_400]) {
      const s = { ...BASE, atSec }
      const f = frameFor(s)
      const cut = f.x(atSec)
      for (const [px] of f.known) expect(px).toBeLessThanOrEqual(cut + 0.001)
      for (const [px] of f.future) expect(px).toBeGreaterThanOrEqual(cut - 0.001)
      // The two halves meet, so the line has no gap in it.
      expect(f.known[f.known.length - 1]?.[0]).toBeCloseTo(cut, 6)
      expect(f.future[0]?.[0]).toBeCloseTo(cut, 6)
      expect(f.known[f.known.length - 1]?.[1]).toBeCloseTo(f.future[0]?.[1] as number, 6)
    }
  })

  test('the marker sits on the selected curve, wherever the reader puts it', () => {
    for (const atSec of [0, 1, 30_000, 86_400]) {
      const s = { ...BASE, atSec }
      const f = frameFor(s)
      const c = f.curves.find((k) => k.selected)
      if (!c) throw new Error('the selected curve must be drawn')
      expect(f.markX).toBeCloseTo(f.x(atSec), 6)
      // Within a sample's worth of the drawn line, which is what "on it" means at 60 points.
      const nearest = c.points.reduce((best, p) =>
        Math.abs(p[0] - f.markX) < Math.abs(best[0] - f.markX) ? p : best,
      )
      expect(Math.abs(nearest[1] - f.markY)).toBeLessThan((f.bottom - f.top) / 30)
    }
  })

  test('the fee is the gap between the gross floor and the net the maker keeps', () => {
    const free = frameFor({ ...BASE, feeRate: 0n })
    expect(free.netFloorY).toBeCloseTo(free.floorY, 6)
    const paid = frameFor({ ...BASE, feeRate: 2n * PERCENT })
    // The net floor is the lower number, so it is the larger y.
    expect(paid.netFloorY).toBeGreaterThan(paid.floorY)
  })

  test('the frame holds still under a small floor move, so the market line does not slide', () => {
    // Both inside the same half-per-cent bucket. Across a bucket the frame does move, on purpose:
    // it has to, or a floor dragged far enough would leave the plot.
    const a = frameFor({ ...BASE, floorPct: 0.0451 })
    const b = frameFor({ ...BASE, floorPct: 0.0499 })
    expect(b.lo).toBeCloseTo(a.lo, 12)
    expect(b.hi).toBeCloseTo(a.hi, 12)
  })

  test('no two keys overlap, and every one stays inside the plot’s own height', () => {
    for (const feeRate of [0n, PERCENT / 4n, PERCENT, 2n * PERCENT]) {
      const f = frameFor({ ...BASE, feeRate })
      const ys = f.curves.map((c) => c.labelY).sort((p, q) => p - q)
      for (const yv of ys) {
        expect(yv).toBeGreaterThanOrEqual(f.top + 8 - 0.001)
        expect(yv).toBeLessThanOrEqual(f.bottom - 4 + 0.001)
      }
      for (let i = 1; i < ys.length; i++) {
        expect((ys[i] as number) - (ys[i - 1] as number)).toBeGreaterThanOrEqual(11 - 0.001)
      }
    }
  })
})

/**
 * How wide the labels really get, in the languages this file otherwise never meets.
 *
 * The test above is true and was never enough. It asserts a property of positions, and the thing
 * that went wrong was a property of *strings* — the label was as wide as whatever a translator
 * wrote, and a suite that only ever renders English cannot see that. Three labels anchored at the
 * plot's right edge covered about a third of the curves in Vietnamese where they covered a
 * quarter in English, in the one place the curves are furthest apart and most worth reading.
 * Nothing clipped, so nothing failed. What was spent was plot.
 *
 * **Measured, not counted.** Headless Chromium, 2026-09-07, at the real 10px in the `.num` stack
 * with its `letter-spacing: -0.01em`, through `getComputedTextLength()`, over the strings the
 * live dictionaries actually produce. A character count cannot stand in for this for two
 * independent reasons:
 *
 *   1. None of `ui-monospace`, `SF Mono`, `JetBrains Mono` or `Menlo` carries Arabic or Hebrew,
 *      so the browser substitutes a proportional face for the word while the digits keep their
 *      `tabular-nums` advance. One string, two metrics.
 *   2. A translator may replace the separator with a word, and `ar` and `he` both did — `·`
 *      became `تقاطع:` and `מפגש:`.
 *
 * And the worst case is not a right-to-left one at all. Vietnamese is the widest, in plain Latin.
 *
 * Refresh these by rendering each string into an off-screen SVG `text.num` at 10px and reading
 * `getComputedTextLength()`. A locale added or a string rewritten wants a new measurement, and
 * until it has one this fixture is what the budgets are checked against.
 */
const MEASURED_PX = {
  /**
   * `{rate} · {time}`, and its "never" form, at their widest per language. This is the label that
   * used to sit on the plot and now sits under it.
   */
  label: [
    ['vi', '0% · không bao giờ', 106.6],
    ['ar', '0.5% تقاطع: 1h 53m', 106.5],
    ['id', '0% · tidak pernah', 100.7],
    ['ms', '0% · tidak pernah', 100.7],
    ['he', '0% מפגש: לעולם לא', 100.6],
    ['fi', '0% · ei koskaan', 88.8],
    ['en', '0.5% · 1h 53m', 77.0],
  ],
  /**
   * The rate on its own, which is what the plot carries now.
   *
   * The interesting column is the third one: it is the same number in every language, to the
   * tenth of a pixel. `lib/i18n`'s `rate` builds a Western-digit number and an ASCII `%`, so
   * there is no translatable word in it and no glyph any locale substitutes — the widest is the
   * same 53.3px in all thirty-five. That is the whole reason this is the part left on the plot,
   * and a change to `rate` that introduced a localised numbering system would break it.
   */
  rate: [
    ['en', '1.234567%', 53.3],
    ['fr', '1,234567%', 53.3],
    ['ar', '1.234567%', 53.3],
    ['he', '1.234567%', 53.3],
    ['th', '1.234567%', 53.3],
    ['hi', '1.234567%', 53.3],
    ['en', '0%', 11.8],
    ['ar', '0%', 11.8],
  ],
} as const

/**
 * The narrowest the chart is ever drawn.
 *
 * A 375px viewport, less the page gutter either side, less the panel's own padding either side:
 * 375 − 16 − 16 = 343px of SVG, which is what the browser reports for `.fc-chart` there.
 */
const NARROWEST_SVG = 343

describe('a label fits the room it is given, in every language', () => {
  test('the widest rate fits the gutter the plot gives up for it', () => {
    const widest = Math.max(...MEASURED_PX.rate.map(([, , px]) => px))
    expect(widest).toBeLessThanOrEqual(KEY_GUTTER - 4)
  })

  test('the rate is the same width in every language, which is why it may sit on the plot', () => {
    // Group by the string rather than by a suffix: the property is that one string measures one
    // width whoever is reading. If a locale ever renders a DIFFERENT string — localised digits, a
    // different percent sign, a non-breaking space before it — its width is its own and the two
    // assertions below catch it either way. The key stopped being language-independent, and it
    // does not belong over the curves any more.
    const byText = new Map<string, number[]>()
    for (const [, text, px] of MEASURED_PX.rate) {
      byText.set(text, [...(byText.get(text) ?? []), px])
    }
    const shared = [...byText.entries()].filter(([, px]) => px.length > 1)
    expect(shared.length).toBeGreaterThanOrEqual(2)
    for (const [text, px] of shared) expect(new Set(px).size, text).toBe(1)
    // And every language measured produces the same set of strings as English does.
    const perLocale = new Map<string, string[]>()
    for (const [code, text] of MEASURED_PX.rate) {
      perLocale.set(code, [...(perLocale.get(code) ?? []), text].sort())
    }
    const english = perLocale.get('en')
    for (const [code, texts] of perLocale) {
      if (code === 'en' || texts.length !== english?.length) continue
      expect(texts, `${code} formats a rate English does not`).toEqual(english)
    }
  })

  test('no whole label is drawn on the plot any more, in any language', () => {
    // The regression this all exists for. Were the full label back at the right edge, the widest
    // would take this much of the narrowest plot — a third of it, and the third that matters.
    const f = frameFor(BASE, NARROWEST_SVG, DEFAULT_CHART_H)
    const plot = f.right - f.left
    const widestLabel = Math.max(...MEASURED_PX.label.map(([, , px]) => px))
    expect(widestLabel / plot).toBeGreaterThan(0.3)
    // What is actually drawn there is the rate, and it is outside the plot regardless.
    expect(f.keyX).toBeGreaterThanOrEqual(f.right)
  })

  test('the plot gives up the gutter and not one pixel more', () => {
    // So nobody widens the column quietly. The plot is the drawing; the gutter is the price.
    for (const w of [NARROWEST_SVG, DEFAULT_CHART_W, 1200]) {
      const f = frameFor(BASE, w, DEFAULT_CHART_H)
      expect(w - f.right).toBe(6 + KEY_GUTTER)
      expect(f.keyX + KEY_GUTTER - 4).toBeLessThanOrEqual(w)
    }
  })

  test('the widest label still fits one line of the row beneath the chart', () => {
    // It may wrap between items — that is what the row is for — but a single item that could not
    // fit on a line of its own would overflow the panel instead of wrapping.
    const widest = Math.max(...MEASURED_PX.label.map(([, , px]) => px))
    expect(widest).toBeLessThanOrEqual(NARROWEST_SVG)
  })

  test('the fixture measures the strings the dictionaries actually hold', () => {
    // A fixture nobody checks is a fixture that rots. English is the one language this suite can
    // read, so at least pin its two shapes to the live dictionary.
    expect(en['landing.console.curve.fan']).toBe('{rate} · {time}')
    const never = en['landing.console.curve.never']
    expect(MEASURED_PX.label.some(([code, text]) => code === 'en' && text.includes('·'))).toBe(true)
    expect(never.length).toBeGreaterThan(0)
  })
})

describe('the ribbon diagram', () => {
  test('every ribbon is inside the box, and the columns run left to right', () => {
    for (const w of [300, 470, 900]) {
      const h = flowHeight(w)
      const f = flowFrame(build(BASE), w, h)
      expect(f.xTake).toBeLessThan(f.xPool)
      expect(f.xPool).toBeLessThan(f.xHold)
      expect(f.xHold + f.nodeW).toBeLessThanOrEqual(w)
      for (const holder of f.holders) {
        expect(holder.y).toBeGreaterThanOrEqual(0)
        expect(holder.y + holder.h).toBeLessThanOrEqual(h + 0.001)
        expect(holder.sy).toBeGreaterThanOrEqual(f.yPool - 0.001)
        expect(holder.sy + holder.h).toBeLessThanOrEqual(f.yPool + f.sumH + 0.001)
      }
    }
  })

  test('the five parties are stacked in order, and their heights sum to the column', () => {
    const f = flowFrame(build(BASE))
    expect(f.holders.map((h) => h.key)).toEqual(['poolKeeps', 'maker', 'fee', 'solver', 'gas'])
    const total = f.holders.reduce((acc, h) => acc + h.h, 0)
    expect(total).toBeCloseTo(f.sumH, 6)
    for (let i = 1; i < f.holders.length; i++) {
      expect(f.holders[i]?.sy).toBeCloseTo(
        (f.holders[i - 1]?.sy as number) + (f.holders[i - 1]?.h as number),
        6,
      )
      // The right-hand column is spread out, so every holder starts below the last.
      expect(f.holders[i]?.y).toBeGreaterThan(f.holders[i - 1]?.y as number)
    }
  })

  test('a ribbon is as tall as its number, in proportion to its neighbours', () => {
    const f = flowFrame(build(BASE))
    // Every pair that both clear the minimum height keeps the ratio of the money exactly. That
    // is what makes the picture an argument rather than a decoration.
    const drawn = f.holders.filter((h) => h.h > 2 && h.value > 0n)
    expect(drawn.length).toBeGreaterThanOrEqual(2)
    for (const p of drawn) {
      for (const q of drawn) {
        expect(p.h / q.h).toBeCloseTo(Number(p.value) / Number(q.value), 4)
      }
    }
  })

  test('a ribbon too thin to see is drawn at the minimum, and nowhere near it', () => {
    const f = flowFrame(build(BASE))
    const m = build(BASE)
    const maker = f.holders.find((h) => h.key === 'maker')
    const pool = f.holders.find((h) => h.key === 'poolKeeps')
    if (!maker || !pool) throw new Error('both ribbons are drawn')
    // The pool keeps half a per cent of the trade. At the true ratio it would be under a pixel,
    // so it is floored — and the floor is a stated exception, not a silent distortion.
    expect((Number(m.poolKeeps) / Number(m.delivered)) * maker.h).toBeLessThan(2)
    expect(pool.h).toBe(2)
  })

  test('gas is drawn at its true height, however thin that is', () => {
    const f = flowFrame(build(BASE))
    const gas = f.holders.find((h) => h.key === 'gas')
    // 90 PLS against a thousand dollars is a fraction of a pixel, and the label carries the
    // figure. A stub of two pixels would claim a share of the money that gas does not take.
    expect(gas?.h).toBeLessThan(1)
    expect(gas?.h).toBeGreaterThanOrEqual(0)
  })

  test('a solver that is behind gets a mark, not a ribbon of nothing', () => {
    // A ten-dollar trade with a one-per-cent floor, at the close, at the dearest base fee the
    // slider reaches: the spread is real and gas is wider than it.
    const f = flowFrame(
      build({
        ...BASE,
        sizeUsd: 10,
        floorPct: 0.01,
        feeRate: 0n,
        atSec: 86_400,
        baseFeeGwei: 100_000_000,
      }),
    )
    const solver = f.holders.find((h) => h.key === 'solver')
    expect(solver?.bad).toBe(true)
    expect(solver?.h).toBeGreaterThanOrEqual(2)
  })

  test('the picture holds still when the market moves the solver’s slice', () => {
    const a = flowFrame(build({ ...BASE, atSec: 0 }))
    const b = flowFrame(build({ ...BASE, atSec: 86_400 }))
    // The divisor is anchored to the signing quote, so the scale does not rescale under a move.
    expect(b.holders[0]?.y).toBe(a.holders[0]?.y)
    expect(b.holders[1]?.y).toBe(a.holders[1]?.y)
  })

  test('the two labels above the diagram get a column each, and never share one', () => {
    // At 375px the sell label and the pool label sat on top of each other, because both carry an
    // amount and both hang from a left-hand column. Each is held to its own column instead, so a
    // long amount wraps rather than running into its neighbour.
    for (const w of [300, 375, 470, 900]) {
      const f = flowFrame(build(BASE), w, 340)
      expect(f.takeTopW).toBeLessThanOrEqual(f.xPool)
      expect(f.xPool + f.poolTopW).toBeLessThanOrEqual(w)
      expect(f.takeTopW).toBeGreaterThan(0)
      expect(f.poolTopW).toBeGreaterThan(0)
    }
  })

  test('a narrow diagram leaves room above for a label that has wrapped', () => {
    // A top label hangs upward from its column, so a two-line one needs headroom or it is drawn
    // off the top of the panel.
    const narrow = flowFrame(build(BASE), 320, 340)
    const wide = flowFrame(build(BASE), 900, 340)
    expect(narrow.wide).toBe(false)
    expect(wide.wide).toBe(true)
    expect(narrow.holders[0]?.y).toBeGreaterThan(wide.holders[0]?.y as number)
  })

  test('a ribbon path opens and closes on the two columns it joins', () => {
    const d = ribbon(10, 20, 40, 100, 60, 90)
    expect(d.startsWith('M10,20.0')).toBe(true)
    expect(d).toContain('100,60.0')
    expect(d).toContain('L100,90.0')
    expect(d.endsWith('10,40.0 Z')).toBe(true)
  })
})

describe('the spread bar', () => {
  test('the three segments are the three numbers, and they fill the bar', () => {
    const b = barFrame(build(BASE))
    if (b.kind !== 'split') throw new Error('the resting frame splits three ways')
    expect(b.feeFrac + b.solverFrac + b.gasFrac).toBeCloseTo(1, 9)
    const m = build(BASE)
    expect(b.feeFrac).toBeCloseTo(Number(m.fee) / Number(m.spread), 9)
    expect(b.solverFrac).toBeCloseTo(Number(m.solver) / Number(m.spread), 9)
  })

  test('only the rate moves the first boundary', () => {
    const low = barFrame(build({ ...BASE, feeRate: 0n }))
    const high = barFrame(build({ ...BASE, feeRate: 2n * PERCENT }))
    if (low.kind !== 'split' || high.kind !== 'split') throw new Error('both split')
    expect(low.feeFrac).toBe(0)
    expect(high.feeFrac).toBeGreaterThan(low.feeFrac)
  })

  test('only gas moves the second', () => {
    const cheap = barFrame(build({ ...BASE, baseFeeGwei: 200_000 }))
    const dear = barFrame(build({ ...BASE, baseFeeGwei: 20_000_000 }))
    if (cheap.kind !== 'split' || dear.kind !== 'split') throw new Error('both split')
    expect(dear.gasFrac).toBeGreaterThan(cheap.gasFrac)
    expect(dear.feeFrac).toBeCloseTo(cheap.feeFrac, 6)
  })

  test('gas wider than what is left leaves no green, and hatches the deficit', () => {
    const b = barFrame(
      build({
        ...BASE,
        sizeUsd: 10,
        floorPct: 0.01,
        feeRate: 0n,
        atSec: 86_400,
        baseFeeGwei: 100_000_000,
      }),
    )
    expect(b.kind).toBe('short')
  })

  test('no spread at all is no bar', () => {
    // At the open the offer sits above the market by its premium, so nothing crosses.
    const b = barFrame(build({ ...BASE, atSec: 0, floorPct: 0.0001 }))
    expect(b.kind).toBe('none')
  })
})


describe('flowHeight tracks the label budget', () => {
  test('a phone-wide diagram is taller than the desktop default', () => {
    expect(flowHeight(320)).toBeGreaterThan(DEFAULT_FLOW_H)
    expect(flowHeight(520)).toBe(DEFAULT_FLOW_H)
  })

  test('every holder sits inside the box at 320px', () => {
    const h = flowHeight(320)
    const f = flowFrame(build(BASE), 320, h)
    for (const holder of f.holders) {
      expect(holder.y).toBeGreaterThanOrEqual(0)
      expect(holder.y + holder.h).toBeLessThanOrEqual(h)
    }
  })
})

describe('one fee, one destination', () => {
  /*
   * The fixed-destination sinks: a fee goes to one registered sink, and the sink pays one
   * destination. The diagram draws one fee ribbon and never divides it. A split ribbon was drawn
   * here for a day, for a design the owner rejected.
   */
  test('the fee is one ribbon carrying the whole fee', () => {
    const m = build(BASE)
    expect(m.fee).toBeGreaterThan(0n)
    const fees = flowFrame(m).holders.filter((h) => h.key === 'fee')
    expect(fees).toHaveLength(1)
    expect(fees[0]!.value).toBe(m.fee)
  })

  test('five parties, and no more', () => {
    expect(flowFrame(build(BASE)).holders.map((h) => h.key)).toEqual([
      'poolKeeps',
      'maker',
      'fee',
      'solver',
      'gas',
    ])
  })
})

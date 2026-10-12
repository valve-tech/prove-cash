import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import { Console } from './Console.tsx'
import { num } from '../../lib/i18n.ts'
import { PERCENT, TOKENS, amountOf, build, type Settings } from './model.ts'

/**
 * What the console looks like before a single line of JavaScript runs.
 *
 * `scripts/prerender.ts` writes this tree to `dist` once for each of thirty-five languages, and
 * a crawler and a slow phone both read that file rather than the bundle. So the resting HTML has
 * to carry the default figures, at a default width, with every drawing already drawn. Nothing may
 * sit at `opacity: 0` waiting for an observer, and nothing may be sized to the viewport.
 *
 * The shapes themselves are checked in `geometry.test.ts` and the arithmetic in `model.test.ts`.
 * This file only asks whether the markup arrives complete.
 */

const RESTING: Settings = {
  tokenIn: TOKENS[0] as (typeof TOKENS)[number],
  tokenOut: TOKENS[3] as (typeof TOKENS)[number],
  sizeUsd: 1_000,
  floorPct: 0.045,
  feeRate: PERCENT,
  dutch: true,
  opensSec: 0,
  expiresSec: 24 * 3600,
  rung: 'escrow',
  cold: false,
  venue: 'v2',
  baseFeeGwei: 783_379,
  atSec: 12 * 3600,
  step: 0,
}

const html = () => renderToStaticMarkup(<Console />)

describe('the console renders with no JavaScript', () => {
  test('it renders at all, with no DOM to measure', () => {
    // A component that reaches for `window` at render time breaks the build, not the app, and a
    // failing build step reads as a broken toolchain until somebody finds which file moved.
    const said = html()
    expect(said).toContain('id="console"')
    expect(said.length).toBeGreaterThan(4_000)
  })

  test('the resting frame carries its own figures, not empty boxes', () => {
    const said = html()
    const m = build(RESTING)
    // What you sell, grouped the way the reader's locale groups it, and both token symbols.
    expect(said).toContain(num(Math.round(amountOf(m.amountIn, m.a.decimals))))
    expect(said).toContain('WPLS')
    expect(said).toContain('DAI')
    // The gas count is measured, so the sum in the tip has to hold a real number of units.
    expect(said).toContain(String(m.gasUnits).slice(0, 3))
  })

  test('both drawings arrive drawn, at the default width', () => {
    const said = html()
    // Four polylines at least: the break-even line, the market before and after the marker, and
    // one curve. Each is a real list of points rather than an empty attribute.
    const polylines = said.match(/<polyline[^>]*points="([^"]+)"/g) ?? []
    expect(polylines.length).toBeGreaterThanOrEqual(4)
    for (const line of polylines) expect(line).toMatch(/points="[\d.]+,[\d.]+ /)
    // The ribbons: one in, five out, and the three column nodes.
    expect((said.match(/<path[^>]*d="M/g) ?? []).length).toBeGreaterThanOrEqual(6)
    expect(said).toContain('viewBox="0 0 520')
    expect(said).toContain('viewBox="0 0 470')
  })

  test('nothing waits at zero opacity for an observer', () => {
    const said = html()
    expect(said).not.toContain('opacity:0')
    expect(said).not.toContain('opacity: 0;')
    expect(said).not.toContain('opacity="0"')
  })

  test('no drawing is sized to the viewport', () => {
    // A hero at `100vh` pushes everything under it off a phone. The console's heights are all
    // fixed pixels or grid minimums.
    expect(html()).not.toMatch(/\d+vh/)
  })

  test('no native form control, anywhere', () => {
    // The owner's rule, and the reason the pair menu is a listbox by hand. A range input is not
    // on that list, and every part of it is named in the section's own stylesheet.
    const said = html()
    expect(said).not.toContain('<select')
    expect(said).not.toContain('<option')
    expect(said).not.toContain('type="checkbox"')
    expect(said).not.toContain('type="radio"')
    expect(said).not.toContain('<progress')
  })

  test('the controls a keyboard needs are all reachable', () => {
    const said = html()
    // Two token menus, four sliders, and the chart, which is its own slider.
    expect((said.match(/aria-haspopup="listbox"/g) ?? []).length).toBe(2)
    expect((said.match(/type="range"/g) ?? []).length).toBe(4)
    expect(said).toContain('role="slider"')
    expect(said).toContain('tabindex="0"')
  })

  test('no CSS border and no rounded panel reaches the edge', () => {
    // Rule 5 and rule 6: an outset shadow costs no layout width, and a curve flush against a
    // phone's edge shows the page through its corners.
    const said = html()
    expect(said).not.toMatch(/class="[^"]*\brounded-(lg|xl|2xl|3xl)\b/)
    expect(said).not.toMatch(/class="[^"]*\bborder\b/)
    expect(said).not.toMatch(/class="[^"]*\bdivide-y\b/)
    expect(said).not.toMatch(/class="[^"]*\bring-inset\b/)
  })

  test('every figure a reader compares is set in the tabular face', () => {
    const said = html()
    // `.num` is the mono, tabular, bidi-isolated face. A column of amounts in the sans stack
    // does not line up and cannot be scanned.
    expect((said.match(/class="[^"]*\bnum\b/g) ?? []).length).toBeGreaterThan(15)
  })

  test('the spread fee handle is a visible thumb, not a hairline', () => {
    const said = html()
    // Mounted in the resting split bar.
    expect(said).toContain('class="fc-handle lp-focus"')
    // The stylesheet ships a square thumb (::before), not only a 2px line.
    expect(said).toContain('.fc-handle::before')
    expect(said).toMatch(/\.fc-handle::before[^}]*width: 12px/)
  })

  test('a shortfall bar still mounts the fee handle', async () => {
    // The short branch used to draw fee + hatch with no slider. Import the source as text so a
    // future prune cannot drop it without this file noticing — Console has no settings prop.
    const src = (await import('./Console.tsx?raw')).default as string
    const start = src.indexOf("{bar.kind === 'short' && (")
    const end = src.indexOf("{bar.kind === 'split' && (", start)
    const short = src.slice(start, end)
    expect(short).toContain('fc-handle')
    expect(short).toContain('role="slider"')
  })

  test('gas profitability is a tip beside Fee rate and a tick on the spread bar', () => {
    const said = html()
    const m = build(RESTING)
    if (m.breakEvenGwei === null) throw new Error('the resting frame must clear gas')
    // Tip beside Fee rate (no third rail control), and a draggable tick on the fee-distribution
    // bar at the gas | solver edge — not on the gwei track.
    expect(said).toContain('The highest gas price at which this fill still pays for itself')
    expect(said).toContain('class="fc-handle fc-tick lp-focus"')
    expect(said).toContain('.fc-handle.fc-tick')
    // Standalone gwei-track tick is gone; the mark is a handle on the spread bar.
    expect(said).not.toMatch(/class="fc-tick"/)
    // Allowance long-window warning is tip-only: the short off-line stays in the footer, and the
    // long warning only lives behind the allowance chip's tip (still in the DOM, not as a shout).
    expect(said).toContain('Withdrawing your escrow ends it')
    expect(said).toContain('role="tooltip"')
    expect(said).not.toContain('fc-warn')
  })

  test('a shortfall bar still mounts the gas tick', async () => {
    const src = (await import('./Console.tsx?raw')).default as string
    const start = src.indexOf("{bar.kind === 'short' && (")
    const end = src.indexOf("{bar.kind === 'split' && (", start)
    const short = src.slice(start, end)
    expect(short).toContain('fc-tick')
    expect(short).toContain('dragGas')
  })


  test('size.range starts at one cent', () => {
    expect(html()).toContain('$0.01')
  })

  test('the market tip opens under its label so the board cannot clip it', async () => {
    const src = (await import('./Console.tsx?raw')).default as string
    const i = src.indexOf('landing.console.tip.market')
    expect(src.slice(Math.max(0, i - 160), i)).toContain('under')
  })

  test('gas tick and clears tip remount when the pair changes', async () => {
    const src = (await import('./Console.tsx?raw')).default as string
    // Pair only — including gasMarkFrac remounts mid-drag and drops pointer capture.
    expect(src).toContain('key={`gas-${m.a.symbol}-${m.b.symbol}`}')
    expect(src).not.toContain('key={`gas-${m.a.symbol}-${m.b.symbol}-${gasMarkFrac}`}')
    expect(src).toContain("key={`clears-${m.a.symbol}-${m.b.symbol}-${m.breakEvenGwei ?? 'x'}`}")
  })

  test('a go-to-the-fill chip sits beside go-to-the-open', async () => {
    const src = (await import('./Console.tsx?raw')).default as string
    expect(src).toContain("landing.console.curve.fill")
    expect(src).toContain('m.crossHeld')
    expect(html()).toContain('go to the fill')
  })
})

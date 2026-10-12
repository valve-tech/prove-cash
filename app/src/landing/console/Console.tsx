import { useCallback, useEffect, useRef, useState } from 'react'
import { markLetters } from '../../lib/markLetters.ts'
import { fixed, ltr, num, rate as ratePct, t } from '../../lib/i18n.ts'
import type { Key } from '../../i18n/en.ts'
import { Menu, type MenuOption } from '../../components/Menu.tsx'
import { InfoTip, Tip, TipUnder } from '../../components/Tip.tsx'
import { Eyebrow } from '../bits.tsx'
import {
  GWEI_HI,
  GWEI_LO,
  MAX_SLIDER_RATE,
  PERCENT,
  REF_GWEI,
  RUNGS,
  RUNG_ORDER,
  SIZE_HI,
  SIZE_LO,
  SNAPSHOT,
  TOKENS,
  VENUES,
  amountOf,
  build,
  type ConsoleToken,
  type Settings,
  type Venue,
  gweiForGasShare,
  rateForShare,
} from './model.ts'
import {
  DEFAULT_CHART_H,
  DEFAULT_CHART_W,
  DEFAULT_FLOW_H,
  DEFAULT_FLOW_W,
  barFrame,
  chartFrame,
  flowFrame,
  flowHeight,
  pt,
  ribbon,
  type HolderKey,
} from './geometry.ts'

/**
 * The fill console: one signed offer, and where every unit of one fill's money goes.
 *
 * It is the only place on this page that answers "who takes what, and what decides it" with a
 * number you can move. `docs/FEE-MODEL.md` is the authority for every figure, and Part 5 is why
 * each one says whether it is **signed** — fixed when the maker put their name to it — or
 * **live**, true only now. Two figures side by side must share a context or say plainly that they
 * do not, and three defects in one day came from ignoring that.
 *
 * **It renders correctly with no JavaScript at all.** The page is prerendered for 35 locales, so
 * the resting HTML carries the default figures and the drawings are laid out at a default width.
 * Nothing waits at `opacity: 0` for an observer, and nothing is sized to the viewport. A measured
 * width replaces the default the moment one arrives.
 *
 * **The arithmetic is not here.** `model.ts` mirrors the SDK and `model.test.ts` pins it;
 * `geometry.ts` turns the model into points and `geometry.test.ts` checks the shape. This file
 * holds state and draws.
 */

// ── The scoped stylesheet ─────────────────────────────────────────────────────────────────────

/**
 * Scoped to this section, the way `Landing.tsx` scopes its own.
 *
 * It is here rather than in `index.css` because the app never draws a console, and a range input
 * has no house component to inherit from — the browser owns its appearance until every part is
 * named. Nothing here is rounded except a control, nothing carries a CSS border, and every
 * outline is an outset shadow: a console cell reaches the edge of a 375px screen.
 */
const CSS = `
.fc { --fc-pad: 8px; background: var(--color-ink); }
@media (width >= 40rem) { .fc { --fc-pad: 16px; } }
.fc-head { display: flex; align-items: center; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; padding: 8px var(--fc-pad); box-shadow: 0 1px 0 0 var(--color-line); }
.fc-main { display: grid; grid-template-columns: minmax(0, 1fr); min-height: 0; }
@media (width >= 64rem) {
  .fc-main { grid-template-columns: 320px minmax(0, 1fr); height: 760px; }
  .fc-expand { display: inline-flex; }
  .fc.fc-full { position: fixed; inset: 0; z-index: 50; display: grid; grid-template-rows: auto minmax(0, 1fr); }
  .fc.fc-full .fc-main { height: auto; min-height: 0; }
  /* overflow-y, not overflow. index.css keeps the page's horizontal axis on clip on purpose:
     hidden would make the body a scroll container and take the sticky header with it. Only the
     vertical axis needs stopping while the overlay is up. */
  body:has(.fc.fc-full) { overflow-y: hidden; }
}
.fc-expand { display: none; align-items: center; gap: 6px; padding: 4px 10px; font-size: 11px; font-weight: 600; color: var(--color-body); background: var(--color-panel-2); box-shadow: 0 0 0 1px var(--color-line-bright); border-radius: 3px; }
.fc-expand:hover { color: var(--color-bright); }

.fc-rail { display: grid; grid-auto-rows: auto; background: var(--color-panel); box-shadow: 1px 0 0 0 var(--color-line); min-width: 0; }
@media (width >= 64rem) { .fc-rail { overflow-y: auto; grid-template-rows: auto repeat(5, minmax(auto, 1fr)); } }
.fc-rail > * { min-width: 0; box-shadow: 0 1px 0 0 var(--color-line); padding: 8px var(--fc-pad); }
.fc-rail > :last-child { box-shadow: none; }

.fc-cell { display: grid; row-gap: 4px; align-content: start; min-width: 0; }
.fc-cell-head { display: grid; grid-template-columns: 118px minmax(0, 1fr); align-items: center; column-gap: 4px; }
.fc-cell-head .fc-lbl { line-height: 1.2; }
/* Wraps rather than squeezing. The base-fee cell carries two long figures and a 320px rail is
   not wide enough for both on one line; as a grid it gave the second one the room and folded the
   first into four lines. */
.fc-cell-foot { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: baseline; gap: 2px 8px; font-size: 10px; color: var(--color-dim); min-height: 20px; }
.fc-cell-foot > * { min-width: 0; overflow-wrap: anywhere; }
.fc-cell-foot > :last-child { text-align: end; }
.fc-lbl { display: inline-block; font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-dim); }

.fc-field { position: relative; display: block; width: 100%; min-width: 0; }
.fc-field input { width: 100%; height: 26px; margin: 0; padding: 0 34px 0 2px; font: 600 15px var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: -0.01em; color: var(--color-bright); background: transparent; border: 0; border-radius: 3px; text-align: end; box-shadow: 0 0 0 1px transparent; transition: box-shadow 120ms ease, background 120ms ease; }
.fc-field input:hover { box-shadow: 0 0 0 1px var(--color-line-bright); }
.fc-field input:focus { background: var(--color-panel-2); box-shadow: 0 0 0 1px var(--color-line-bright); }
.fc-field .fc-unit { position: absolute; inset-inline-end: 6px; top: 50%; transform: translateY(-50%); font-size: 10px; color: var(--color-dim); pointer-events: none; letter-spacing: 0; }
.fc-times { display: grid; grid-template-columns: auto minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; column-gap: 6px; }
.fc-times .fc-field input { height: 22px; font-size: 13px; padding-inline-end: 26px; }

.fc input[type=range] { -webkit-appearance: none; appearance: none; width: 100%; height: 22px; margin: 0; background: transparent; cursor: pointer; --fc-p: 50%; --fc-fill: var(--color-proven); }
.fc input[type=range]::-webkit-slider-runnable-track { height: 2px; background: linear-gradient(to right, var(--fc-fill) 0 var(--fc-p), var(--color-line-bright) var(--fc-p) 100%); }
.fc input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -6px; background: var(--color-bright); border-radius: 2px; box-shadow: 0 0 0 2px var(--color-ink); }
.fc input[type=range]::-moz-range-track { height: 2px; background: linear-gradient(to right, var(--fc-fill) 0 var(--fc-p), var(--color-line-bright) var(--fc-p) 100%); }
.fc input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border: 0; background: var(--color-bright); border-radius: 2px; box-shadow: 0 0 0 2px var(--color-ink); }
.fc input[type=range].fc-amber { --fc-fill: var(--color-unproven); }
.fc input[type=range].fc-grey { --fc-fill: var(--color-body); }
.fc-track { position: relative; display: block; min-width: 0; }
.fc-band { position: absolute; top: calc(50% + 6px); height: 2px; background: var(--color-dim); pointer-events: none; }
.fc-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
.fc-chip { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; font-size: 11px; font-weight: 500; line-height: 1; color: var(--color-dim); background: var(--color-panel); box-shadow: 0 0 0 1px var(--color-line-bright); border-radius: 3px; white-space: nowrap; }
.fc-chip[aria-pressed="true"] { color: var(--color-ink); background: var(--color-proven); box-shadow: none; font-weight: 600; }
.fc-chip[aria-disabled="true"] { opacity: 0.4; cursor: not-allowed; }
.fc-board { display: grid; gap: var(--fc-pad); padding: var(--fc-pad); grid-template-columns: minmax(0, 1fr); align-content: start; min-width: 0; }
@media (width >= 64rem) {
  .fc-board { grid-template-columns: minmax(0, 11fr) minmax(0, 9fr); grid-template-rows: minmax(230px, 1fr) auto auto; overflow: auto; }
  .fc-board > .fc-flow-wrap { grid-column: 1; grid-row: 1; }
  .fc-board > .fc-curve { grid-column: 2; grid-row: 1; }
  .fc-board > .fc-verdict, .fc-board > .fc-spread { grid-column: 1 / -1; }
}
.fc-panel { background: color-mix(in oklab, var(--color-panel) 88%, transparent); box-shadow: 0 0 0 1px var(--color-line); min-width: 0; }
.fc-phead { display: flex; justify-content: space-between; align-items: center; gap: 6px 12px; flex-wrap: wrap; position: relative; z-index: 4; }

.fc-flow-wrap { padding: var(--fc-pad); display: grid; grid-template-rows: auto auto auto; gap: 6px; min-height: 0; }
.fc-flow { position: relative; flex-shrink: 0; overflow: visible; }
.fc-flow svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.fc-nl { position: absolute; display: grid; gap: 0; line-height: 1.15; }
.fc-nl.fc-top { transform: translateY(-100%); padding-bottom: 6px; }
.fc-nl .fc-who { font-size: 11px; color: var(--color-body); white-space: normal; line-height: 1.1; }
.fc-nl .fc-who b { font-weight: 600; color: var(--color-bright); }
.fc-step { display: inline-grid; place-items: center; width: 14px; height: 14px; margin-inline-end: 5px; font-family: var(--font-mono); font-size: 9px; font-weight: 600; color: var(--color-ink); background: var(--color-body); border-radius: 2px; vertical-align: 1px; }
.fc-amt { font-size: 14px; color: var(--color-bright); overflow-wrap: anywhere; }
.fc-amt.fc-bad { color: var(--color-danger); }
.fc-legend { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 10px; color: var(--color-dim); }
.fc-legend span::before { content: ''; display: inline-block; width: 8px; height: 8px; margin-inline-end: 5px; vertical-align: -1px; background: var(--fc-sw, transparent); }

.fc-curve { padding: var(--fc-pad); display: grid; grid-template-rows: auto minmax(0, 1fr) auto; gap: 6px; overflow: visible; }
/* Wraps. A long crossing time takes a second line rather than a slice of the drawing. */
.fc-keys { display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 10px; color: var(--color-dim); }
.fc-key { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.fc-key.fc-on { color: var(--color-bright); font-weight: 600; }
.fc-swatch { flex: 0 0 auto; width: 12px; height: 2px; background: repeating-linear-gradient(to right, var(--color-body) 0 2px, transparent 2px 6px); opacity: 0.6; }
.fc-key.fc-on .fc-swatch { background: var(--color-bright); opacity: 1; }
.fc-chart { position: relative; height: 220px; cursor: crosshair; touch-action: none; user-select: none; }
@media (width >= 64rem) { .fc-chart { height: auto; min-height: 200px; } }
.fc.fc-full .fc-chart { min-height: 320px; }
.fc-chart svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; display: block; }
.fc-chart text { font-size: 10px; fill: var(--color-dim); }
.fc-chart text.num { fill: var(--color-body); }
.fc-ml { position: absolute; display: grid; padding: 3px 6px; background: var(--color-panel-2); box-shadow: 0 0 0 1px var(--color-line-bright); font-size: 10px; color: var(--color-dim); white-space: nowrap; line-height: 1.2; pointer-events: none; }
.fc-ml .num { font-size: 12px; color: var(--color-bright); }

.fc-verdict { display: grid; gap: 2px 20px; grid-template-columns: 1fr; align-items: center; padding: 10px var(--fc-pad); min-height: 48px; }
@media (width >= 48rem) { .fc-verdict { grid-template-columns: 1fr auto; } }
.fc-verdict.fc-ok { background: color-mix(in oklab, var(--color-proven) 12%, var(--color-panel)); }
.fc-verdict.fc-no { background: color-mix(in oklab, var(--color-danger) 14%, var(--color-panel)); }
.fc-verdict.fc-wait { background: color-mix(in oklab, var(--color-unproven) 12%, var(--color-panel)); }
.fc-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; font-size: clamp(15px, 1.6vw, 19px); font-weight: 800; letter-spacing: -0.02em; line-height: 1.15; color: var(--color-bright); min-width: 0; }
.fc-state { flex: 0 0 auto; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; padding: 3px 8px; border-radius: 3px; background: var(--color-panel-2); box-shadow: 0 0 0 1px var(--color-line-bright); color: var(--color-bright); }
.fc-verdict.fc-ok .fc-state { background: var(--color-proven); color: var(--color-ink); box-shadow: none; }
.fc-verdict.fc-no .fc-state { background: var(--color-danger); color: var(--color-ink); box-shadow: none; }
.fc-verdict.fc-wait .fc-state { background: var(--color-unproven); color: var(--color-ink); box-shadow: none; }
.fc-reason { display: block; font-weight: 500; font-size: 12px; letter-spacing: 0; color: var(--color-body); overflow-wrap: anywhere; }
.fc-be { display: grid; grid-auto-flow: column; gap: 0 20px; justify-items: start; }
@media (width >= 48rem) { .fc-be { justify-items: end; text-align: end; } }
.fc-be .num { font-size: clamp(18px, 2vw, 24px); color: var(--color-bright); line-height: 1.05; overflow-wrap: anywhere; }

.fc-spread { padding: var(--fc-pad); display: grid; gap: 6px; }
.fc-krow { display: grid; grid-template-columns: minmax(0, 1fr) auto; column-gap: 12px; align-items: baseline; font-size: 11px; color: var(--color-dim); min-height: 16px; }
@media (width >= 40rem) { .fc-krow { grid-template-columns: 168px 130px minmax(0, 1fr); } }
.fc-krow .fc-f { text-align: end; color: var(--color-bright); font-size: 12px; overflow-wrap: anywhere; }
@media (width >= 40rem) { .fc-krow .fc-f { text-align: end; } .fc-krow .fc-x { text-align: start; } }
.fc-bar { position: relative; height: 14px; background: var(--color-panel-2); box-shadow: 0 0 0 1px var(--color-line); touch-action: none; }
.fc-handle { position: absolute; top: -10px; bottom: -10px; width: 20px; margin-inline-start: -10px; cursor: ew-resize; z-index: 2; border: 0; padding: 0; background: transparent; }
/* A real thumb, not a 2px hairline — the fee boundary was invisible on the live bar. */
.fc-handle::before { content: ''; position: absolute; inset-inline-start: 50%; top: 0; width: 12px; height: 12px; margin-inline-start: -6px; background: var(--color-bright); border-radius: 2px; box-shadow: 0 0 0 2px var(--color-ink); }
.fc-handle::after { content: ''; position: absolute; inset-inline-start: 50%; top: 10px; bottom: 0; width: 3px; margin-inline-start: -1.5px; background: var(--color-bright); border-radius: 1px; box-shadow: 0 0 0 1px var(--color-ink); }
.fc-handle:hover::before, .fc-handle:focus-visible::before, .fc-handle:hover::after, .fc-handle:focus-visible::after { background: var(--color-proven); }
/* Second mark: gas vs solver residual. Break-even colour — the profitability edge on the bar. */
.fc-handle.fc-tick { z-index: 3; }
.fc-handle.fc-tick::before, .fc-handle.fc-tick::after { background: var(--color-unproven); }
.fc-handle.fc-tick:hover::before, .fc-handle.fc-tick:focus-visible::before,
.fc-handle.fc-tick:hover::after, .fc-handle.fc-tick:focus-visible::after { background: var(--color-bright); }
.fc-seg { position: absolute; top: 0; bottom: 0; }
.fc-seg.fc-fee { background: var(--color-unproven); }
.fc-seg.fc-gas { background: var(--color-dim); }
.fc-seg.fc-win { background: var(--color-proven); }
.fc-seg.fc-short { background: repeating-linear-gradient(135deg, var(--color-danger) 0 3px, transparent 3px 7px); box-shadow: 0 0 0 1px var(--color-danger); }
.fc-nofill { position: absolute; inset-inline-end: 4px; top: -1px; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-danger); }

@media (prefers-reduced-motion: reduce) {
  .fc *, .fc *::before, .fc *::after { transition-duration: 0.01ms !important; }
}
`

// ── Formatting ────────────────────────────────────────────────────────────────────────────────
//
// Every number a person reads goes through `num` or `fixed`, so a Czech reader sees 1 000,50.
// Units — PLS, gwei, h, m, s — are units and do not translate; `charts/chart.ts` says the same.

const money = (usd: number): string =>
  usd === 0
    ? '$0'
    : Math.abs(usd) >= 1000
      ? `$${num(Math.round(usd))}`
      : Math.abs(usd) >= 1
        ? `$${fixed(usd, 2)}`
        : `$${num(usd, { maximumSignificantDigits: 3 })}`

const tokens = (raw: bigint, tok: ConsoleToken): string => {
  const v = amountOf(raw, tok.decimals)
  const digits = Math.abs(v) >= 1e6 ? 0 : Math.abs(v) >= 1 ? 2 : 6
  return `${num(v, { maximumFractionDigits: digits, minimumFractionDigits: Math.min(2, digits) })} ${tok.symbol}`
}

const pls = (v: number): string => `${v >= 100 ? num(Math.round(v)) : fixed(v, 1)} PLS`

/** `1h 53m`, `12m 30s`. The letters are units. */
const elapsed = (sec: number): string => {
  if (!Number.isFinite(sec)) return '—'
  const s = Math.max(0, Math.round(sec))
  if (s >= 3600) return `${num(Math.floor(s / 3600))}h ${num(Math.floor((s % 3600) / 60))}m`
  if (s >= 60) return `${num(Math.floor(s / 60))}m ${num(s % 60)}s`
  return `${num(s)}s`
}

const pctOf = (v: number, places = 2): string => `${fixed(v * 100, places)}%`

const logMap = (v: number, lo: number, hi: number, max: number): number =>
  lo * (hi / lo) ** (v / max)
const logPos = (v: number, lo: number, hi: number, max: number): number =>
  Math.round((max * Math.log10(Math.max(lo, Math.min(hi, v)) / lo)) / Math.log10(hi / lo))

// ── Small parts ───────────────────────────────────────────────────────────────────────────────

function Slider({
  value,
  min,
  max,
  onChange,
  label,
  tone = '',
}: {
  value: number
  min: number
  max: number
  onChange: (v: number) => void
  label: string
  tone?: string
}) {
  const p = `${((value - min) / (max - min)) * 100}%`
  return (
    <input
      type="range"
      className={tone}
      min={min}
      max={max}
      step={1}
      value={value}
      aria-label={label}
      style={{ ['--fc-p' as string]: p }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

/**
 * A figure you can type, with its unit as a suffix inside the box.
 *
 * The width lives on the wrapper and never on the input, and the suffix uses a logical inset —
 * both the rules `Compose.tsx` records. It commits on Enter and on blur, Escape puts back what
 * was there, and anything that is not a number reverts: a floor of zero from a typo is a gift.
 */
function Field({
  value,
  unit,
  label,
  onCommit,
  small = false,
}: {
  value: string
  unit: string
  label: string
  onCommit: (v: number) => void
  small?: boolean
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const before = useRef('')
  return (
    <span className="fc-field">
      <input
        className="num"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        style={small ? { height: 22, fontSize: 13 } : undefined}
        value={draft ?? value}
        onFocus={(e) => {
          before.current = value
          setDraft(value)
          e.currentTarget.select()
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setDraft(before.current)
            e.currentTarget.blur()
          }
        }}
        onBlur={() => {
          const cleaned = (draft ?? '').replace(/[^0-9.eE+-]/g, '')
          const v = cleaned === '' ? Number.NaN : Number(cleaned)
          if (Number.isFinite(v)) onCommit(v)
          setDraft(null)
        }}
      />
      <span className="fc-unit" aria-hidden="true">
        {unit}
      </span>
    </span>
  )
}

function Chip({
  on,
  onClick,
  children,
  label,
  disabled = false,
}: {
  on: boolean
  onClick: () => void
  children: React.ReactNode
  label?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="fc-chip lp-focus"
      aria-pressed={on}
      aria-label={label}
      aria-disabled={disabled || undefined}
      onClick={() => {
        if (disabled) return
        onClick()
      }}>
      {children}
    </button>
  )
}

/** A token's face at a fixed size: the repo's own deterministic mark, from the address. */
function Mark({ tok }: { tok: ConsoleToken }) {
  const hue = Number.parseInt(tok.address.slice(2, 8), 16) % 360
  return (
    <span
      aria-hidden="true"
      className="avatar num"
      style={{
        width: 16,
        height: 16,
        fontSize: 7,
        background: `hsl(${hue} 40% 22%)`,
        color: `hsl(${hue} 55% 78%)`,
      }}>
      {markLetters(tok.symbol)}
    </span>
  )
}

/**
 * The box the browser gave an element, falling back to a default so a page with no JavaScript
 * still draws something correct.
 *
 * `charts/useMeasuredWidth` returns zero until it has measured, and its callers draw nothing
 * until then. That is right for a panel that waits on a chain read and wrong here: this section
 * is prerendered, and a reader with a slow connection has to meet a finished picture.
 *
 * Both numbers, not just the width. The drawing's `viewBox` has to be the box the CSS actually
 * gave it — a chart laid out for 220 units inside a 200px box is letterboxed by
 * `preserveAspectRatio`, and every label in it shrinks.
 */
type Box = { w: number; h: number }
/** The same box, to within half a pixel, so React can drop the render. */
const same = (prev: Box, w: number, h: number): Box =>
  Math.abs(prev.w - w) < 0.5 && Math.abs(prev.h - h) < 0.5 ? prev : { w, h }

function useBox(fallbackW: number, fallbackH: number) {
  const [box, setBox] = useState<Box>({ w: 0, h: 0 })
  const ref = useCallback((node: HTMLElement | null) => {
    if (!node) return
    const r = node.getBoundingClientRect()
    // Same guard as the observer's, and it is load-bearing rather than an optimisation: a ref
    // callback runs on attach, and an unconditional `setState` there renders, re-attaches and
    // runs again. React calls that "maximum update depth exceeded".
    setBox((prev) => same(prev, r.width, r.height))
    if (typeof ResizeObserver === 'undefined') return
    const o = new ResizeObserver((entries) => {
      for (const e of entries) {
        const { width, height } = e.contentRect
        setBox((prev) => same(prev, width, height))
      }
    })
    o.observe(node)
    return () => o.disconnect()
  }, [])
  return [ref, box.w > 0 ? box.w : fallbackW, box.h > 0 ? box.h : fallbackH] as const
}

// ── The section ───────────────────────────────────────────────────────────────────────────────

/** About as wide as the marker's own label gets. It decides which side of the marker it sits. */
const MARKER_BOX = 150

const DEFAULTS: Settings = {
  tokenIn: TOKENS[0] as ConsoleToken,
  tokenOut: TOKENS[3] as ConsoleToken,
  sizeUsd: 1_000,
  floorPct: 0.045,
  feeRate: PERCENT,
  dutch: true,
  opensSec: 0,
  expiresSec: 24 * 3600,
  // Escrow, not an allowance, and the window is why. A day-long offer on an allowance rung is a
  // real zombie risk — the warning lives in a tip on that chip — but printing it before the
  // reader has touched anything makes the resting frame read as an error. Escrow carries an off
  // switch that works, so it is the honest clean default.
  rung: 'escrow',
  cold: false,
  venue: 'v2',
  baseFeeGwei: REF_GWEI,
  atSec: 12 * 3600,
  step: 0,
}

const HOLDER_NAME: Record<HolderKey, Key> = {
  poolKeeps: 'landing.console.who.poolKeeps',
  maker: 'landing.console.who.maker',
  fee: 'landing.console.who.fee',
  solver: 'landing.console.who.solver',
  gas: 'landing.console.who.gas',
}

const HOLDER_TIP: Record<HolderKey, Key> = {
  poolKeeps: 'landing.console.tip.poolKeeps',
  maker: 'landing.console.tip.maker',
  fee: 'landing.console.tip.feeLeg',
  solver: 'landing.console.tip.solver',
  gas: 'landing.console.tip.gas',
}

const HOLDER_COLOUR: Record<HolderKey, string> = {
  poolKeeps: 'var(--color-unproven)',
  maker: 'var(--color-proven)',
  fee: 'var(--color-unproven)',
  solver: 'var(--color-bright)',
  gas: 'var(--color-dim)',
}

export function Console() {
  const [s, setS] = useState<Settings>(DEFAULTS)
  const [denom, setDenom] = useState<'tok' | 'usd'>('tok')
  const [full, setFull] = useState(false)
  const set = (patch: Partial<Settings>) => setS((prev) => ({ ...prev, ...patch }))

  const m = build(s)
  const [flowRef, flowW] = useBox(DEFAULT_FLOW_W, DEFAULT_FLOW_H)
  const [chartRef, chartW, chartH] = useBox(DEFAULT_CHART_W, DEFAULT_CHART_H)
  const chartBox = useRef<HTMLDivElement | null>(null)
  const barBox = useRef<HTMLDivElement | null>(null)
  // One stable callback for the chart, which needs both a measurement and a node to read pointer
  // coordinates against. An inline arrow here is a new function every render, and React treats
  // that as a ref that has changed: it detaches, re-attaches, and measures again for ever.
  const holdChart = useCallback(
    (node: HTMLDivElement | null) => {
      chartBox.current = node
      chartRef(node)
    },
    [chartRef],
  )

  // Escape leaves the overlay. Nothing else about it is a dialog: it is the same DOM, the same
  // state, and the drawings re-fit themselves.
  useEffect(() => {
    if (!full) return
    const off = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false)
    }
    window.addEventListener('keydown', off)
    return () => window.removeEventListener('keydown', off)
  }, [full])

  const flowH = flowHeight(flowW, full)
  const flow = flowFrame(m, flowW, flowH)
  const rates = [0n, ...(s.feeRate === 0n || s.feeRate === MAX_SLIDER_RATE ? [] : [s.feeRate]), MAX_SLIDER_RATE]
  const chart = chartFrame(s, m, rates, chartW, chartH)
  const bar = barFrame(m)

  /** A token-B amount in the reader's chosen denomination, and its dim twin. */
  const usdOf = (raw: bigint) => amountOf(raw, m.b.decimals) * m.b.usd
  const pri = (raw: bigint) => (denom === 'usd' ? money(usdOf(raw)) : tokens(raw, m.b))
  const sec2 = (raw: bigint) => (denom === 'usd' ? tokens(raw, m.b) : money(usdOf(raw)))

  const tokenOptions = (): MenuOption<string>[] =>
    TOKENS.map((tok) => ({ value: tok.symbol, label: tok.symbol, icon: <Mark tok={tok} /> }))
  const bySymbol = (sym: string) => TOKENS.find((tok) => tok.symbol === sym) as ConsoleToken

  // Hoisted, every one of them, and not for tidiness. `lib/i18n-placeholders.test.ts` reads this
  // file's source to check that a key's slots are all filled, and its matcher stops at the first
  // nested brace — so a template literal or an options object written inside a `t()` call reads
  // to the guard as a call that passes nothing at all.
  const exchangeRate = m.a.usd / m.b.usd
  const rateText = num(exchangeRate, { maximumSignificantDigits: 6 })
  const pairName = `${m.a.symbol}/${m.b.symbol}`
  const marketPair = `${m.path.from.symbol}/${m.path.to.symbol}`
  const marketHours = num(m.path.series.length - 1)
  const depthText = t(
    m.measuredDepth ? 'landing.console.depth.measured' : 'landing.console.depth.none',
  )
  const burnShare = s.venue === 'v2' ? '7/29' : t('landing.console.burn.all')
  const impactPct = pctOf(
    m.spotSign > 0n
      ? Math.max(0, amountOf(m.poolImpact, m.b.decimals)) / amountOf(m.spotSign, m.b.decimals)
      : 0,
    3,
  )
  const spreadPct = pctOf(
    m.spotSign > 0n ? amountOf(m.spread, m.b.decimals) / amountOf(m.spotSign, m.b.decimals) : 0,
  )
  const scrub = (clientX: number) => {
    const box = chartBox.current?.getBoundingClientRect()
    if (!box) return
    const frac = (clientX - box.left - 6) / Math.max(1, box.width - 12)
    set({ atSec: Math.max(0, Math.min(1, frac)) * m.windowSec })
  }
  /** The spread bar's first mark: a fraction of the spread, back-solved to a rate. */
  const dragFee = (clientX: number) => {
    const box = barBox.current?.getBoundingClientRect()
    if (!box) return
    set({ feeRate: rateForShare(s, m, (clientX - box.left) / Math.max(1, box.width)) })
  }

  /**
   * The spread bar's second mark: how much of the spread gas takes. Clamped so it cannot cross
   * left of the fee mark — that boundary is the fee handle's.
   */
  const dragGas = (clientX: number) => {
    const box = barBox.current?.getBoundingClientRect()
    if (!box || !(m.spread > 0n)) return
    const feeFloor = bar.kind === 'none' ? 0 : bar.feeFrac
    const x = Math.max(feeFloor, Math.min(1, (clientX - box.left) / Math.max(1, box.width)))
    set({ baseFeeGwei: gweiForGasShare(s, m, 1 - x) })
  }

  const clearsTip =
    m.breakEvenGwei === null
      ? t('landing.console.tip.clears.none')
      : t('landing.console.tip.clears', {
          gwei: num(Math.round(m.breakEvenGwei)),
          now: num(Math.round(s.baseFeeGwei)),
          state: t(
            s.baseFeeGwei <= m.breakEvenGwei
              ? 'landing.console.tip.clears.yes'
              : 'landing.console.tip.clears.no',
          ),
        })

  /**
   * Left edge of the gas segment, or the fee edge when gas has already eaten the residual.
   * The tick's React key must NOT include this value: dragGas updates it every move, and a
   * remount drops setPointerCapture — vertical leave then ends the drag because the pointer
   * is no longer over the new node. Key only on the pair so a token swap still remounts.
   */
  const gasMarkFrac =
    bar.kind === 'split'
      ? bar.feeFrac + bar.solverFrac
      : bar.kind === 'short'
        ? bar.feeFrac
        : null

  /*
    Every one of these is an EXPRESSION rather than a figure, and index.css says why they cannot
    be handed over bare: `.num` isolates a value so its neighbours cannot reorder it, but a whole
    sum is one sentence in symbols, and the bidi algorithm cuts the leading term off the front of
    it and parks it at the far end. An Arabic reader would be shown the arithmetic backwards. So
    each is assembled here and wrapped in an isolate that forces the run left to right.
  */
  const gasLine = ltr(
    t('landing.console.gas.line', {
      units: num(m.gasUnits),
      gwei: num(Math.round(s.baseFeeGwei)),
      pls: pls(m.gasPls),
      usd: money(m.gasUsd),
    }),
  )
  const spreadSum = ltr(
    `${tokens(m.proceeds, m.b)} − ${tokens(m.delivered, m.b)} = ${tokens(m.spread, m.b)}`,
  )
  const gweiRange = ltr(`${num(SNAPSHOT.gwei.min)} – ${num(SNAPSHOT.gwei.max)}`)

  // The verdict, as a state, a time and a short reason. The same three slots in every state, so
  // nothing below it moves when the answer changes.
  // Net against net. The gross gap and the delivered figure are both correct and belong to
  // different halves of the split, and printing one beside the other is the Part 5 defect.
  const gap = m.delivered - m.floorNet
  const clock =
    gap > 0n
      ? t('landing.console.verdict.clock', {
          time: elapsed(m.at),
          amount: pri(m.delivered),
          above: pri(gap),
        })
      : t('landing.console.verdict.atfloor', { time: elapsed(m.at), amount: pri(m.delivered) })
  const waiting = m.ok && !m.fills && Number.isFinite(m.crossHeld)
  const verdict = !m.ok
    ? {
        tone: 'fc-no',
        state: t('landing.console.verdict.notrade'),
        reason: t('landing.console.verdict.samepair', { symbol: m.a.symbol }),
        clock: '',
      }
    : m.fills
      ? {
          tone: 'fc-ok',
          state: t('landing.console.verdict.profitable'),
          reason: t('landing.console.verdict.solver', {
            amount: pri(m.solver),
            gas: denom === 'usd' ? money(m.gasUsd) : pls(m.gasPls),
          }),
          clock,
        }
      : waiting
        ? {
            tone: 'fc-wait',
            state: t('landing.console.verdict.notyet'),
            reason: t('landing.console.verdict.wait', {
              offer: pri(m.gross),
              market: pri(m.proceeds),
              time: elapsed(m.crossHeld),
            }),
            clock,
          }
        : {
            tone: 'fc-no',
            state: t('landing.console.verdict.never'),
            reason: t('landing.console.verdict.behind', { amount: pri(-m.solver) }),
            clock,
          }

  return (
    <section
      id="console"
      aria-label={t('landing.nav.console')}
      className={`fc rule-t scroll-mt-[3.25rem]${full ? ' fc-full' : ''}`}>
      <style>{CSS}</style>

      <div className="fc-head">
        <div className="min-w-0">
          <Eyebrow>{t('landing.nav.console')}</Eyebrow>
          <h2 className="text-[16px] font-extrabold tracking-tight text-(--color-bright)">
            {t('landing.console.title')}
          </h2>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="fc-chips" role="group" aria-label={t('landing.console.denom')}>
            <Chip on={denom === 'tok'} onClick={() => setDenom('tok')}>
              {t('landing.console.denom.tokens')}
            </Chip>
            <Chip on={denom === 'usd'} onClick={() => setDenom('usd')}>
              {t('landing.console.denom.usd')}
            </Chip>
          </div>
          <button
            type="button"
            className="fc-expand lp-focus"
            aria-expanded={full}
            aria-controls="console"
            onClick={() => setFull(!full)}>
            {t(full ? 'landing.console.close' : 'landing.console.expand')}
          </button>
        </div>
      </div>

      <div className="fc-main">
        {/* ── the rail ──────────────────────────────────────────────────────────────────── */}
        <aside className="fc-rail" aria-label={t('landing.console.controls')}>
          {/* the pair */}
          <div className="fc-cell relative">
            <div className="flex items-center gap-1.5">
              <Menu
                value={m.a.symbol}
                options={tokenOptions()}
                onChange={(v) => set({ tokenIn: bySymbol(v) })}
                label={t('landing.console.pair.in')}
              />
              <button
                type="button"
                className="fc-chip lp-focus"
                style={{ padding: '0 6px' }}
                aria-label={t('landing.console.pair.swap')}
                onClick={() => set({ tokenIn: m.b, tokenOut: m.a })}>
                <span aria-hidden="true">⇄</span>
              </button>
              <Menu
                value={m.b.symbol}
                options={tokenOptions()}
                onChange={(v) => set({ tokenOut: bySymbol(v) })}
                label={t('landing.console.pair.out')}
              />
            </div>
            <div className="num ltr text-end text-[12px] text-(--color-body)">
              {m.ok
                ? t('landing.console.pair.rate', {
                    from: m.a.symbol,
                    to: m.b.symbol,
                    rate: rateText,
                  })
                : '—'}
            </div>
            <div className="text-end">
              <Tip
                tip={t('landing.console.tip.pair', {
                  date: SNAPSHOT.asOf,
                  pair: pairName,
                  depth: depthText,
                })}
                label={
                  <span className="num text-[10px] text-(--color-dim)">
                    {m.ok
                      ? t('landing.console.pair.asOf', { date: SNAPSHOT.asOf })
                      : t('landing.console.pair.same')}
                  </span>
                }
              />
            </div>
            <div className="fc-chips" role="group" aria-label={t('landing.console.venue')}>
              {(Object.keys(VENUES) as Venue[]).map((v) => (
                <Chip key={v} on={s.venue === v} onClick={() => set({ venue: v })}>
                  {v === 'v2' ? 'PulseX v2' : 'PulseX v1'}
                </Chip>
              ))}
            </div>
          </div>

          {/* trade size */}
          <div className="fc-cell relative">
            <div className="fc-cell-head">
              <Tip
                tip={t('landing.console.tip.size', {
                  amount: tokens(m.amountIn, m.a),
                  usd: money(s.sizeUsd),
                })}
                label={<span className="fc-lbl">{t('landing.console.size')}</span>}
              />
              <Field
                value={
                  denom === 'usd'
                    ? num(s.sizeUsd, {
                        maximumFractionDigits: s.sizeUsd < 1 ? 2 : s.sizeUsd < 100 ? 2 : 0,
                      })
                    : num(amountOf(m.amountIn, m.a.decimals), {
                        maximumFractionDigits: amountOf(m.amountIn, m.a.decimals) < 1 ? 6 : 0,
                      })
                }
                unit={denom === 'usd' ? '$' : m.a.symbol}
                label={t('landing.console.size')}
                onCommit={(v) =>
                  set({
                    sizeUsd: Math.max(
                      SIZE_LO,
                      Math.min(SIZE_HI, denom === 'usd' ? v : v * m.a.usd),
                    ),
                  })
                }
              />
            </div>
            <Slider
              value={logPos(s.sizeUsd, SIZE_LO, SIZE_HI, 1000)}
              min={0}
              max={1000}
              label={t('landing.console.size')}
              onChange={(v) => set({ sizeUsd: logMap(v, SIZE_LO, SIZE_HI, 1000) })}
            />
            <div className="fc-cell-foot">
              <span className="num ltr">{t('landing.console.size.range')}</span>
              <span className="num">
                {denom === 'usd' ? tokens(m.amountIn, m.a) : money(s.sizeUsd)}
              </span>
            </div>
          </div>

          {/* the floor */}
          <div className="fc-cell relative">
            <div className="fc-cell-head">
              <Tip
                tip={t('landing.console.tip.floor', {
                  net: tokens(m.floorNet, m.b),
                  gross: tokens(m.floorGross, m.b),
                  rate: ratePct(s.feeRate),
                })}
                label={<span className="fc-lbl">{t('landing.console.floor')}</span>}
              />
              <Field
                value={fixed(s.floorPct * 100, 2)}
                unit="%"
                label={t('landing.console.floor')}
                onCommit={(v) => set({ floorPct: Math.max(0, Math.min(10, v)) / 100 })}
              />
            </div>
            <Slider
              value={Math.round(s.floorPct * 10000)}
              min={0}
              max={1000}
              label={t('landing.console.floor')}
              onChange={(v) => set({ floorPct: v / 10000 })}
            />
            <div className="fc-cell-foot">
              <span>{t('landing.console.floor.sub')}</span>
              <span className="fc-chips" role="group" aria-label={t('landing.console.shape')}>
                <Chip on={!s.dutch} onClick={() => set({ dutch: false })}>
                  {t('landing.console.shape.flat')}
                </Chip>
                <Chip on={s.dutch} onClick={() => set({ dutch: true })}>
                  {t('landing.console.shape.dutch')}
                </Chip>
              </span>
            </div>
          </div>

          {/* the window and the rung */}
          <div className="fc-cell relative">
            <div className="fc-cell-head">
              <Tip
                tip={t('landing.console.tip.window', {
                  opens: elapsed(s.opensSec),
                  expires: elapsed(s.expiresSec),
                  span: elapsed(m.windowSec),
                })}
                label={<span className="fc-lbl">{t('landing.console.window')}</span>}
              />
              <span className="num text-end text-[17px] font-semibold text-(--color-bright)">
                {elapsed(m.windowSec)}
              </span>
            </div>
            <div className="fc-times">
              <span className="fc-lbl">{t('landing.console.window.opens')}</span>
              <Field
                small
                value={num(s.opensSec / 3600, { maximumFractionDigits: 1 })}
                unit="h"
                label={t('landing.console.window.opens')}
                onCommit={(v) => {
                  const opens = Math.max(0, Math.round(v * 3600))
                  set({ opensSec: opens, expiresSec: Math.max(opens + 3600, s.expiresSec) })
                }}
              />
              <span className="fc-lbl">{t('landing.console.window.expires')}</span>
              <Field
                small
                value={num(s.expiresSec / 3600, { maximumFractionDigits: 1 })}
                unit="h"
                label={t('landing.console.window.expires')}
                onCommit={(v) =>
                  set({ expiresSec: Math.max(s.opensSec + 3600, Math.round(v * 3600)) })
                }
              />
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <div className="fc-chips" role="group" aria-label={t('landing.console.rung')}>
                {RUNG_ORDER.map((r) => {
                  const chip = (
                    <Chip on={s.rung === r} onClick={() => set({ rung: r })}>
                      {t(`landing.console.rung.${r}` as Key)}
                    </Chip>
                  )
                  // Long-window allowance risk lives in the tip only — the short off-line below
                  // stays put so the rail does not reflow when the reader picks the chip.
                  if (RUNGS[r].allowance && m.windowSec > 3600) {
                    return (
                      <TipUnder key={r} tip={t('landing.console.rung.zombie')}>
                        {chip}
                      </TipUnder>
                    )
                  }
                  return <span key={r}>{chip}</span>
                })}
              </div>
              {/* Its own group: a first touch is a property of the balance, not a rung. */}
              <div className="fc-chips" role="group" aria-label={t('landing.console.rung.touch')}>
                <Chip on={s.cold} onClick={() => set({ cold: !s.cold })}>
                  {t('landing.console.rung.cold')}
                </Chip>
              </div>
            </div>
            <div className="text-[10px] leading-tight text-(--color-dim)">
              {t(`landing.console.rung.off.${s.rung}` as Key)}
            </div>
          </div>

          {/* the fee */}
          <div className="fc-cell relative">
            <div className="fc-cell-head">
              <span className="inline-flex items-center gap-1 min-w-0">
                <Tip
                  tip={t('landing.console.tip.fee', {
                    gross: tokens(m.gross, m.b),
                    rate: ratePct(s.feeRate),
                    fee: tokens(m.fee, m.b),
                    later: elapsed(Math.max(0, m.crossHeld - m.crossHeldFree)),
                  })}
                  label={<span className="fc-lbl">{t('landing.console.fee')}</span>}
                />
                <InfoTip key={`clears-${m.a.symbol}-${m.b.symbol}-${m.breakEvenGwei ?? 'x'}`} tip={clearsTip} />
              </span>
              <Field
                value={fixed(Number(s.feeRate) / Number(PERCENT), 2)}
                unit="%"
                label={t('landing.console.fee')}
                onCommit={(v) =>
                  set({
                    feeRate: BigInt(
                      Math.round(Math.max(0, Math.min(2, v)) * Number(PERCENT)),
                    ),
                  })
                }
              />
            </div>
            <Slider
              tone="fc-amber"
              value={Number(s.feeRate / 10n ** 14n)}
              min={0}
              max={200}
              label={t('landing.console.fee')}
              onChange={(v) => set({ feeRate: BigInt(v) * 10n ** 14n })}
            />
            <div className="fc-cell-foot">
              <span />
              <span>{t('landing.console.fee.sub')}</span>
            </div>
          </div>

          {/* the base fee */}
          <div className="fc-cell relative">
            <div className="fc-cell-head">
              <Tip
                tip={t('landing.console.tip.gwei', {
                  median: num(SNAPSHOT.gwei.median),
                  blocks: num(SNAPSHOT.gwei.blocks),
                  date: SNAPSHOT.asOf,
                  line: gasLine,
                })}
                label={<span className="fc-lbl">{t('landing.console.gwei')}</span>}
              />
              <Field
                value={num(Math.round(s.baseFeeGwei))}
                unit="gwei"
                label={t('landing.console.gwei')}
                onCommit={(v) =>
                  set({ baseFeeGwei: Math.max(GWEI_LO, Math.min(GWEI_HI, Math.round(v))) })
                }
              />
            </div>
            <span className="fc-track">
              <Slider
                tone="fc-grey"
                value={logPos(s.baseFeeGwei, GWEI_LO, GWEI_HI, 1000)}
                min={0}
                max={1000}
                label={t('landing.console.gwei')}
                onChange={(v) => set({ baseFeeGwei: Math.round(logMap(v, GWEI_LO, GWEI_HI, 1000)) })}
              />
              <span
                className="fc-band"
                aria-hidden="true"
                style={{
                  insetInlineStart: `${logPos(SNAPSHOT.gwei.min, GWEI_LO, GWEI_HI, 1000) / 10}%`,
                  width: `${(logPos(SNAPSHOT.gwei.max, GWEI_LO, GWEI_HI, 1000) - logPos(SNAPSHOT.gwei.min, GWEI_LO, GWEI_HI, 1000)) / 10}%`,
                }}
              />
            </span>
            <div className="fc-cell-foot">
              <span className="num ltr">{t('landing.console.gwei.range')}</span>
              <span className="num">
                {t('landing.console.gwei.band', { range: gweiRange, date: SNAPSHOT.asOf })}
              </span>
            </div>
          </div>
        </aside>

        {/* ── the board ─────────────────────────────────────────────────────────────────── */}
        <div className="fc-board" aria-label={t('landing.console.outputs')}>
          {/* the ribbon diagram */}
          <div className="fc-panel fc-flow-wrap">
            <div className="fc-phead">
              <h3 className="fc-lbl" style={{ fontWeight: 600 }}>
                {t('landing.console.flow.title')}
              </h3>
              <span className="text-[11px] text-(--color-dim)">
                {t('landing.console.flow.hint')}
              </span>
            </div>
            {/* The height is the geometry's, not the stylesheet's, so the box and the drawing
                inside it can never disagree about how tall the diagram is. */}
            {/*
              `chart` is index.css's rule that a picture of a physical layout never mirrors. The
              ribbons run left to right because the money does, and an Arabic page that flipped
              the labels and not the ribbons would put every name beside the wrong one. The words
              inside a label are still laid out by the bidi algorithm; only the frame holds still.
            */}
            <div className="fc-flow chart" ref={flowRef} style={{ height: flowH }}>
              <svg viewBox={`0 0 ${flow.width} ${flowH}`} aria-hidden="true">
                <path
                  d={ribbon(
                    flow.xTake + flow.nodeW,
                    flow.yPool,
                    flow.yPool + flow.sumH,
                    flow.xPool,
                    flow.yPool,
                    flow.yPool + flow.sumH,
                  )}
                  fill="var(--color-proven)"
                  opacity="0.28"
                />
                {flow.holders.map((h) => (
                  <path
                    key={h.key}
                    d={ribbon(
                      flow.xPool + flow.nodeW,
                      h.sy,
                      h.sy + h.h,
                      flow.xHold,
                      h.y,
                      h.y + h.h,
                    )}
                    fill={h.bad ? 'var(--color-danger)' : HOLDER_COLOUR[h.key]}
                    opacity={h.bad ? 0.9 : 0.42}
                  />
                ))}
                <rect
                  x={flow.xTake}
                  y={flow.yPool}
                  width={flow.nodeW}
                  height={Math.max(1, flow.sumH)}
                  fill="var(--color-proven)"
                />
                <rect
                  x={flow.xPool}
                  y={flow.yPool}
                  width={flow.nodeW}
                  height={Math.max(1, flow.sumH)}
                  fill="var(--color-bright)"
                  opacity="0.9"
                />
                {flow.holders.map((h) => (
                  <rect
                    key={h.key}
                    x={flow.xHold}
                    y={h.y}
                    width={flow.nodeW}
                    height={Math.max(1, h.h)}
                    fill={h.bad ? 'var(--color-danger)' : HOLDER_COLOUR[h.key]}
                  />
                ))}
              </svg>

              <div
                className="fc-nl fc-top"
                style={{ insetInlineStart: 0, top: flow.yPool - 2, maxWidth: flow.takeTopW }}>
                <Tip
                  tip={t('landing.console.tip.take', {
                    amount: tokens(m.amountIn, m.a),
                    usd: money(s.sizeUsd),
                  })}
                  label={
                    <span className="grid">
                      <span className="fc-who">
                        <span className="fc-step">1</span>
                        <b>{t('landing.console.who.take')}</b>
                      </span>
                      <span className="num fc-amt">
                        {denom === 'usd' ? money(s.sizeUsd) : tokens(m.amountIn, m.a)}
                      </span>
                    </span>
                  }
                />
              </div>
              <div
                className="fc-nl fc-top"
                style={{
                  insetInlineStart: flow.xPool,
                  top: flow.yPool - 2,
                  maxWidth: flow.poolTopW,
                }}>
                <Tip
                  tip={t('landing.console.tip.pool', {
                    spot: tokens(m.spotNow, m.b),
                    proceeds: tokens(m.proceeds, m.b),
                    impact: impactPct,
                  })}
                  label={
                    <span className="grid">
                      <span className="fc-who">
                        <span className="fc-step">2</span>
                        <b>{t('landing.console.who.pool')}</b>
                      </span>
                      {/* The column's own height, so the picture and the figure agree. What the
                          pool pays out is what is left of it after the next ribbon. */}
                      <span className="num fc-amt">{pri(m.spotNow)}</span>
                    </span>
                  }
                />
              </div>
              {flow.holders.map((h, i) => (
                <div
                  key={h.key}
                  className="fc-nl"
                  style={{
                    insetInlineStart: flow.labelX,
                    top: h.y + h.h / 2 - 14,
                    maxWidth: flow.labelW,
                  }}>
                  <Tip
                    tip={t(HOLDER_TIP[h.key], {
                      amount:
                        h.key === 'gas'
                          ? pls(m.gasPls)
                          : tokens(h.key === 'solver' && h.bad ? -m.solver : h.value, m.b),
                      line: gasLine,
                      gross: tokens(m.gross, m.b),
                      rate: ratePct(s.feeRate),
                      burn: tokens(m.burn, m.b),
                      share: burnShare,
                    })}
                    label={
                      <span className="grid">
                        <span className="fc-who">
                          <span className="fc-step">{i + 2}</span>
                          <b>{t(HOLDER_NAME[h.key])}</b>
                        </span>
                        <span className={`num fc-amt${h.bad ? ' fc-bad' : ''}`}>
                          {h.key === 'gas'
                            ? denom === 'usd'
                              ? money(m.gasUsd)
                              : pls(m.gasPls)
                            : h.bad
                              ? t('landing.console.who.behind', { amount: pri(-m.solver) })
                              : pri(h.value)}
                        </span>
                      </span>
                    }
                  />
                </div>
              ))}
            </div>
            <div className="fc-legend">
              <span style={{ ['--fc-sw' as string]: 'var(--color-proven)' }}>
                {t('landing.console.legend.person')}
              </span>
              <span style={{ ['--fc-sw' as string]: 'var(--color-unproven)' }}>
                {t('landing.console.legend.fee')}
              </span>
              <span style={{ ['--fc-sw' as string]: 'var(--color-dim)' }}>
                {t('landing.console.legend.gas')}
              </span>
              <span style={{ ['--fc-sw' as string]: 'var(--color-danger)' }}>
                {t('landing.console.legend.short')}
              </span>
            </div>
          </div>

          {/* the price chart */}
          <div className="fc-panel fc-curve">
            <div className="fc-phead relative">
              <Tip
                tip={t('landing.console.tip.curve', {
                  open: tokens(m.w.minOutStart, m.b),
                  floor: tokens(m.floorGross, m.b),
                  span: elapsed(m.windowSec),
                })}
                label={<h3 className="fc-lbl">{t('landing.console.curve.title')}</h3>}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Tip
                  under
                  tip={t('landing.console.tip.market', {
                    pair: marketPair,
                    hours: marketHours,
                    hour: num(m.path.startHour),
                  })}
                  label={
                    <span className="num text-[11px] text-(--color-unproven)">
                      {t('landing.console.curve.market', {
                        pair: marketPair,
                        hours: marketHours,
                      })}
                    </span>
                  }
                />
                <Chip on={false} onClick={() => set({ step: s.step + 1 })}>
                  {t('landing.console.curve.reshuffle')}
                </Chip>
                <Chip on={s.atSec === 0} onClick={() => set({ atSec: 0 })}>
                  {t('landing.console.curve.now')}
                </Chip>
                <Chip
                  on={
                    Number.isFinite(m.crossHeld) &&
                    Math.round(s.atSec) === Math.round(m.crossHeld)
                  }
                  disabled={!Number.isFinite(m.crossHeld)}
                  onClick={() => {
                    if (!Number.isFinite(m.crossHeld)) return
                    set({ atSec: Math.max(0, Math.min(m.windowSec, m.crossHeld)) })
                  }}>
                  {t('landing.console.curve.fill')}
                </Chip>
              </div>
            </div>
            <div
              className="fc-chart chart"
              ref={holdChart}
              tabIndex={0}
              role="slider"
              aria-label={t('landing.console.curve.aria')}
              aria-valuemin={0}
              aria-valuemax={Math.round(m.windowSec)}
              aria-valuenow={Math.round(m.at)}
              aria-valuetext={t('landing.console.curve.at', {
                amount: tokens(m.gross, m.b),
                time: elapsed(m.at),
              })}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId)
                scrub(e.clientX)
              }}
              onPointerMove={(e) => {
                if (e.buttons !== 0) scrub(e.clientX)
              }}
              onKeyDown={(e) => {
                const step = (e.shiftKey ? 0.1 : 0.01) * m.windowSec
                if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                  set({ atSec: Math.min(m.windowSec, m.at + step) })
                } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                  set({ atSec: Math.max(0, m.at - step) })
                } else if (e.key === 'Home') set({ atSec: 0 })
                else if (e.key === 'End') set({ atSec: m.windowSec })
                else return
                e.preventDefault()
              }}>
              <svg viewBox={`0 0 ${chart.width} ${chartH}`} aria-hidden="true">
                {chart.ticks.map(([sec, px]) => (
                  <g key={sec}>
                    <line
                      x1={px}
                      y1={chart.top}
                      x2={px}
                      y2={chart.bottom}
                      stroke="var(--color-line)"
                    />
                    <text
                      className="num"
                      x={px}
                      y={chartH - 4}
                      textAnchor={sec === 0 ? 'start' : sec === m.windowSec ? 'end' : 'middle'}>
                      {sec === 0 ? '0' : elapsed(sec).replace(/ 0m$/, '')}
                    </text>
                  </g>
                ))}
                {/* right of the marker is one sample of what might happen, not what did */}
                <rect
                  x={chart.markX}
                  y={chart.top}
                  width={Math.max(0, chart.right - chart.markX)}
                  height={chart.bottom - chart.top}
                  fill="var(--color-ink)"
                  opacity="0.35"
                />
                <polyline
                  points={chart.breakEven.map(([px, py]) => pt(px, py)).join(' ')}
                  fill="none"
                  stroke="var(--color-unproven)"
                  strokeWidth="1"
                  strokeDasharray="4 3"
                />
                <polyline
                  points={chart.known.map(([px, py]) => pt(px, py)).join(' ')}
                  fill="none"
                  stroke="var(--color-proven)"
                  strokeWidth="1.25"
                />
                <polyline
                  points={chart.future.map(([px, py]) => pt(px, py)).join(' ')}
                  fill="none"
                  stroke="var(--color-proven)"
                  strokeWidth="1.25"
                  strokeDasharray="3 3"
                  opacity="0.45"
                />
                {chart.curves.map((c) => (
                  <g key={String(c.rate)}>
                    <polyline
                      points={c.points.map(([px, py]) => pt(px, py)).join(' ')}
                      fill="none"
                      stroke={c.selected ? 'var(--color-bright)' : 'var(--color-body)'}
                      strokeWidth={c.selected ? 2 : 1}
                      strokeDasharray={c.selected ? undefined : '2 4'}
                      opacity={c.selected ? 1 : 0.5}
                    />
                    {c.crossAt && (
                      <circle
                        cx={c.crossAt[0]}
                        cy={c.crossAt[1]}
                        r={c.selected ? 3.5 : 2.5}
                        fill="var(--color-unproven)"
                      />
                    )}
                    {/*
                      The rate alone, in the gutter, at this curve's own closing height. The
                      crossing time it used to carry is under the chart — see the row below and
                      the note on KEY_GUTTER for what a translated one costs on the plot.
                    */}
                    <text
                      className="num"
                      x={chart.keyX}
                      y={c.labelY + 3}
                      textAnchor="start"
                      fill={c.selected ? 'var(--color-bright)' : 'var(--color-dim)'}
                      fontWeight={c.selected ? 600 : undefined}>
                      {ratePct(c.rate)}
                    </text>
                  </g>
                ))}
                <line
                  x1={chart.left}
                  y1={chart.floorY}
                  x2={chart.right}
                  y2={chart.floorY}
                  stroke="var(--color-dim)"
                  strokeDasharray="3 4"
                />
                {m.fee > 0n && (
                  <line
                    x1={chart.left}
                    y1={chart.netFloorY}
                    x2={chart.right}
                    y2={chart.netFloorY}
                    stroke="var(--color-proven)"
                    strokeDasharray="2 3"
                  />
                )}
                <text className="num" x={chart.left + 4} y={chart.netFloorY + 12}>
                  {t('landing.console.curve.net', { amount: tokens(m.floorNet, m.b) })}
                </text>
                <rect
                  x={chart.markX - 5}
                  y={chart.markY - 5}
                  width="10"
                  height="10"
                  fill={m.fills ? 'var(--color-bright)' : 'var(--color-danger)'}
                  stroke="var(--color-ink)"
                  strokeWidth="2"
                />
              </svg>
              <div
                className="fc-ml"
                style={
                  // Flip to the left of the marker when a box on its right would not fit before
                  // the plot ends. MARKER_BOX is an estimate of this box's width — being a few
                  // pixels out moves it, and nothing else.
                  chart.markX + MARKER_BOX > chart.right
                    ? { insetInlineEnd: chart.width - chart.markX + 10, top: chart.markY + 14 }
                    : { insetInlineStart: chart.markX + 10, top: chart.markY + 14 }
                }>
                <span className="num">{pri(m.gross)}</span>
                <span>
                  {t('landing.console.curve.at', {
                    amount: sec2(m.gross),
                    time: elapsed(m.at),
                  })}
                </span>
              </div>
            </div>
            {/*
              When each offer clears, one item per curve, reading across rather than scattered up
              the right-hand edge at three different heights. It is a comparison — what a rate
              costs in time — and a comparison wants its terms adjacent.

              It is here rather than on the plot because a translated one is half as wide again
              as the English: 106.6px in Vietnamese against 77.0px, measured. Down here a long
              one wraps onto a second line and costs nothing but 13 pixels of panel. It also
              reaches a screen reader, which the drawing above never did.
            */}
            <div className="fc-keys">
              {chart.curves.map((c) => (
                <span key={String(c.rate)} className={c.selected ? 'fc-key fc-on' : 'fc-key'}>
                  <span aria-hidden="true" className="fc-swatch" />
                  <span className="num">
                    {t('landing.console.curve.fan', {
                      rate: ratePct(c.rate),
                      time:
                        c.crossSec === null
                          ? t('landing.console.curve.never')
                          : elapsed(c.crossSec),
                    })}
                  </span>
                </span>
              ))}
            </div>
          </div>

          {/* the verdict */}
          <div className={`fc-panel fc-verdict ${verdict.tone}`}>
            <div className="min-w-0">
              <div className="fc-line">
                <span className="fc-state">{verdict.state}</span>
                <span className="num">{elapsed(m.at)}</span>
              </div>
              <span className="fc-reason">{verdict.reason}</span>
              {verdict.clock && <span className="fc-reason">{verdict.clock}</span>}
            </div>
            <div className="fc-be relative">
              {s.dutch && (
                <div className="grid">
                  <Tip
                    tip={t('landing.console.tip.first', {
                      market: tokens(m.proceeds, m.b),
                      target: tokens(m.proceeds - m.gasB, m.b),
                    })}
                    label={<span className="fc-lbl">{t('landing.console.first')}</span>}
                  />
                  <span className="num">
                    {!Number.isFinite(m.crossHeld)
                      ? t('landing.console.first.never')
                      : m.crossHeld <= m.at
                        ? t('landing.console.first.now')
                        : elapsed(m.crossHeld)}
                  </span>
                </div>
              )}
              <div className="grid">
                <Tip
                  tip={t('landing.console.tip.be', { gas: pls(m.gasPls) })}
                  label={<span className="fc-lbl">{t('landing.console.be')}</span>}
                />
                <span className="num">
                  {m.breakEven === null
                    ? t('landing.console.be.none')
                    : denom === 'usd'
                      ? money(amountOf(m.breakEven, m.a.decimals) * m.a.usd)
                      : tokens(m.breakEven, m.a)}
                </span>
              </div>
            </div>
          </div>

          {/* the spread */}
          <div className="fc-panel fc-spread">
            <div className="fc-krow relative">
              <Tip
                tip={t('landing.console.tip.spread', { sum: spreadSum })}
                label={<span className="fc-lbl">{t('landing.console.spread')}</span>}
              />
              <span className="num fc-f">{m.spread > 0n ? pri(m.spread) : '—'}</span>
              <span className="num fc-x">
                {m.spread > 0n
                  ? t('landing.console.spread.pct', { pct: spreadPct })
                  : t('landing.console.spread.none')}
              </span>
            </div>
            <div className="fc-bar" ref={barBox}>
              {bar.kind === 'none' && (
                <>
                  <span className="fc-seg fc-short" style={{ insetInlineStart: 0, width: '100%' }} />
                  <span className="fc-nofill">{t('landing.console.spread.none')}</span>
                </>
              )}
              {bar.kind === 'short' && (
                <>
                  <span
                    className="fc-seg fc-fee"
                    style={{ insetInlineStart: 0, width: `${bar.feeFrac * 100}%` }}
                  />
                  <span
                    className="fc-seg fc-short"
                    style={{
                      insetInlineStart: `${bar.feeFrac * 100}%`,
                      width: `${(1 - bar.feeFrac) * 100}%`,
                    }}
                  />
                  <span className="fc-nofill">{t('landing.console.spread.nofill')}</span>
                  <button
                    type="button"
                    className="fc-handle lp-focus"
                    role="slider"
                    aria-label={t('landing.console.fee')}
                    aria-valuemin={0}
                    aria-valuemax={2}
                    aria-valuenow={Number(fixed(Number(s.feeRate) / Number(PERCENT), 2))}
                    aria-valuetext={ratePct(s.feeRate)}
                    style={{ insetInlineStart: `${bar.feeFrac * 100}%` }}
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId)
                      dragFee(e.clientX)
                    }}
                    onPointerMove={(e) => {
                      if (e.buttons !== 0) dragFee(e.clientX)
                    }}
                    onKeyDown={(e) => {
                      const d = e.shiftKey ? 10n : 1n
                      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                        set({
                          feeRate:
                            s.feeRate + d * 10n ** 14n > MAX_SLIDER_RATE
                              ? MAX_SLIDER_RATE
                              : s.feeRate + d * 10n ** 14n,
                        })
                      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                        set({
                          feeRate: s.feeRate < d * 10n ** 14n ? 0n : s.feeRate - d * 10n ** 14n,
                        })
                      } else return
                      e.preventDefault()
                    }}
                  />

                  {gasMarkFrac !== null && (
                    <button
                      type="button"
                      className="fc-handle fc-tick lp-focus"
                      key={`gas-${m.a.symbol}-${m.b.symbol}`}
                      role="slider"
                      aria-label={t('landing.console.gwei')}
                      aria-valuemin={GWEI_LO}
                      aria-valuemax={GWEI_HI}
                      aria-valuenow={Math.round(s.baseFeeGwei)}
                      aria-valuetext={`${num(Math.round(s.baseFeeGwei))} gwei`}
                      title={clearsTip}
                      style={{ insetInlineStart: `${gasMarkFrac * 100}%` }}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId)
                        dragGas(e.clientX)
                      }}
                      onPointerMove={(e) => {
                        if (e.buttons !== 0) dragGas(e.clientX)
                      }}
                      onKeyDown={(e) => {
                        const factor = e.shiftKey ? 2 : 1.1
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                          set({
                            baseFeeGwei: Math.min(
                              GWEI_HI,
                              Math.max(GWEI_LO, Math.round(s.baseFeeGwei * factor)),
                            ),
                          })
                        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                          set({
                            baseFeeGwei: Math.min(
                              GWEI_HI,
                              Math.max(GWEI_LO, Math.round(s.baseFeeGwei / factor)),
                            ),
                          })
                        } else return
                        e.preventDefault()
                      }}
                    />
                  )}
                </>
              )}
              {bar.kind === 'split' && (
                <>
                  <span
                    className="fc-seg fc-fee"
                    style={{ insetInlineStart: 0, width: `${bar.feeFrac * 100}%` }}
                  />
                  <span
                    className="fc-seg fc-win"
                    style={{
                      insetInlineStart: `${bar.feeFrac * 100}%`,
                      width: `${bar.solverFrac * 100}%`,
                    }}
                  />
                  <span
                    className="fc-seg fc-gas"
                    style={{
                      insetInlineStart: `${(bar.feeFrac + bar.solverFrac) * 100}%`,
                      width: `${bar.gasFrac * 100}%`,
                    }}
                  />
                  <button
                    type="button"
                    className="fc-handle lp-focus"
                    role="slider"
                    aria-label={t('landing.console.fee')}
                    aria-valuemin={0}
                    aria-valuemax={2}
                    aria-valuenow={Number(fixed(Number(s.feeRate) / Number(PERCENT), 2))}
                    aria-valuetext={ratePct(s.feeRate)}
                    style={{ insetInlineStart: `${bar.feeFrac * 100}%` }}
                    onPointerDown={(e) => {
                      e.currentTarget.setPointerCapture(e.pointerId)
                      dragFee(e.clientX)
                    }}
                    onPointerMove={(e) => {
                      if (e.buttons !== 0) dragFee(e.clientX)
                    }}
                    onKeyDown={(e) => {
                      const d = e.shiftKey ? 10n : 1n
                      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                        set({
                          feeRate:
                            s.feeRate + d * 10n ** 14n > MAX_SLIDER_RATE
                              ? MAX_SLIDER_RATE
                              : s.feeRate + d * 10n ** 14n,
                        })
                      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                        set({
                          feeRate: s.feeRate < d * 10n ** 14n ? 0n : s.feeRate - d * 10n ** 14n,
                        })
                      } else return
                      e.preventDefault()
                    }}
                  />

                  {gasMarkFrac !== null && (
                    <button
                      type="button"
                      className="fc-handle fc-tick lp-focus"
                      key={`gas-${m.a.symbol}-${m.b.symbol}`}
                      role="slider"
                      aria-label={t('landing.console.gwei')}
                      aria-valuemin={GWEI_LO}
                      aria-valuemax={GWEI_HI}
                      aria-valuenow={Math.round(s.baseFeeGwei)}
                      aria-valuetext={`${num(Math.round(s.baseFeeGwei))} gwei`}
                      title={clearsTip}
                      style={{ insetInlineStart: `${gasMarkFrac * 100}%` }}
                      onPointerDown={(e) => {
                        e.currentTarget.setPointerCapture(e.pointerId)
                        dragGas(e.clientX)
                      }}
                      onPointerMove={(e) => {
                        if (e.buttons !== 0) dragGas(e.clientX)
                      }}
                      onKeyDown={(e) => {
                        const factor = e.shiftKey ? 2 : 1.1
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                          set({
                            baseFeeGwei: Math.min(
                              GWEI_HI,
                              Math.max(GWEI_LO, Math.round(s.baseFeeGwei * factor)),
                            ),
                          })
                        } else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                          set({
                            baseFeeGwei: Math.min(
                              GWEI_HI,
                              Math.max(GWEI_LO, Math.round(s.baseFeeGwei / factor)),
                            ),
                          })
                        } else return
                        e.preventDefault()
                      }}
                    />
                  )}
                </>
              )}
            </div>
            {(
              [
                ['fee', m.fee, 'var(--color-unproven)'],
                ['solver', m.solver > 0n ? m.solver : 0n, 'var(--color-proven)'],
                ['gas', m.gasB, 'var(--color-dim)'],
              ] as const
            ).map(([key, value, colour]) => (
              <div key={key} className="fc-krow">
                <span
                  className="fc-lbl"
                  style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
                  <span
                    aria-hidden="true"
                    className="me-1.5 inline-block size-2 align-[-1px]"
                    style={{ background: colour }}
                  />
                  {t(`landing.console.spread.row.${key}` as Key)}
                </span>
                <span className="num fc-f">
                  {key === 'gas' ? (denom === 'usd' ? money(m.gasUsd) : pls(m.gasPls)) : pri(value)}
                </span>
                <span className="num fc-x">
                  {key === 'solver'
                    ? m.solver > 0n
                      ? t('landing.console.spread.aftergas')
                      : t('landing.console.spread.behind', { amount: pri(-m.solver) })
                    : key === 'gas'
                      ? pri(m.gasB)
                      : ''}
                </span>
              </div>
            ))}
            <p className="text-[11px] text-(--color-body)">{t('landing.console.who.pays')}</p>
          </div>
        </div>
      </div>
    </section>
  )
}

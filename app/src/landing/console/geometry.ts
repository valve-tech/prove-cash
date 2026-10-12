import { grossOut } from '../decay.ts'
import { amountOf, type Model, type Settings, signedWindow } from './model.ts'

/**
 * The console's three drawings, as numbers.
 *
 * Pure and separate from the rendering, for the reason `charts/chart.ts` gives: the whole of a
 * plot lives in a few lines of arithmetic between a model and a `viewBox`, and none of it is
 * reachable from a test while it sits inside a render. A polyline that draws the wrong shape is
 * invisible to a suite that only checks its endpoints.
 *
 * Nothing here reads the DOM, so every frame is drawn at a width the caller supplies — a real
 * measured one in the browser, a default one when the page is prerendered with no JavaScript at
 * all.
 */

/** A linear scale from a data range to a pixel range. */
export const lin =
  (d0: number, d1: number, r0: number, r1: number) =>
  (v: number): number =>
    d1 === d0 ? r0 : r0 + ((v - d0) / (d1 - d0)) * (r1 - r0)

/** The width the prerendered frame is drawn at, before any observer has measured anything. */
export const DEFAULT_CHART_W = 520
export const DEFAULT_CHART_H = 220
export const DEFAULT_FLOW_W = 470
export const DEFAULT_FLOW_H = 340

/** A point, rounded to a tenth of a pixel so the markup is stable between renders. */
export const pt = (x: number, y: number): string => `${x.toFixed(1)},${y.toFixed(1)}`

// ── The price chart ───────────────────────────────────────────────────────────────────────────

export type CurveLine = {
  /** The rate this curve was signed at, as a fraction of one WAD. */
  rate: bigint
  /** True for the one the reader's slider is on. */
  selected: boolean
  points: readonly (readonly [number, number])[]
  /** Where it first falls under the break-even line, in seconds, or null when it never does. */
  crossSec: number | null
  /** That crossing as a point, when there is one. */
  crossAt: readonly [number, number] | null
  /** Where the label sits, after the collision pass. */
  labelY: number
}

export type ChartFrame = {
  width: number
  height: number
  /** The plotted value range, after padding. */
  lo: number
  hi: number
  x: (sec: number) => number
  y: (value: number) => number
  /** The x of the left and right edges of the plot, and the y of its floor. */
  left: number
  right: number
  top: number
  bottom: number
  /** Where each curve's rate is written: the start of the gutter, clear of the plot. */
  keyX: number
  /** Five gridlines, evenly spaced across the window, as [second, x]. */
  ticks: readonly (readonly [number, number])[]
  /** What the pool pays, split at the marker: what happened, then one sample of what might. */
  known: readonly (readonly [number, number])[]
  future: readonly (readonly [number, number])[]
  /** What the offer must fall below for a solver to be ahead: the market less gas. */
  breakEven: readonly (readonly [number, number])[]
  /** One line per rate: no fee, the reader's, and the slider's ceiling. */
  curves: readonly CurveLine[]
  /** The selected curve's floor — the gross it ends at — and the net the maker keeps of it. */
  floorY: number
  netFloorY: number
  /** The marker: the gross at the reader's second. */
  markX: number
  markY: number
}

/** How many points a curve or a market line is drawn with. Enough to read, cheap to build. */
const SAMPLES = 60

/** Room for the axis labels along the bottom, and for a curve that opens near the top. */
const PAD = { left: 6, right: 6, top: 14, bottom: 18 }

/**
 * A column down the right-hand side that holds nothing but each curve's rate.
 *
 * **The key is on the plot, so its width has to be a fact rather than a hope.** The whole label
 * used to sit here — the rate and the crossing time together — anchored at the right edge, over
 * the curves, in the one place the curves are furthest apart and most worth reading. In English
 * that label measures 77.0px against a 331px plot. Measured in headless Chromium on 2026-09-07
 * at the real 10px in the `.num` stack through `getComputedTextLength()`, the same label is
 * 106.6px in Vietnamese, 106.5px in Arabic and 100.7px in Indonesian, so three of them covered
 * about a third of the drawing instead of a quarter. Nothing clipped. What was lost was plot.
 *
 * A rate on its own cannot do that, and the reason is worth writing down: `lib/i18n`'s `rate`
 * builds a Western-digit number and an ASCII `%`, so there is no translatable word in it and no
 * glyph any locale substitutes. It measured **53.3px in all thirty-five languages, to the tenth
 * of a pixel**. So the rate stays on the plot in a column sized for that, and the crossing time —
 * the part that varies with the language — moves under the chart where a long one can wrap.
 *
 * Sized to that 53.3px, plus the 4px the key is inset from the plot, plus about a tenth for a
 * machine whose font stack resolves differently: `ui-monospace` is whatever the box has, and the
 * measurement was taken on one box. `geometry.test.ts` holds the measurements and fails if
 * either budget is spent — it caught this constant four pixels short the first time it ran.
 */
export const KEY_GUTTER = 64

/** Two keys closer than this collide, so the later one is pushed down the gutter. */
const LABEL_GAP = 11

/**
 * Everything the price chart draws.
 *
 * **The scale is fixed by things the reader cannot move without meaning to.** It follows the
 * market path and the maker's floor, and takes the floor's own bound rather than its value in
 * half-per-cent steps, so nudging the floor slider does not slide the market line across the
 * screen underneath it.
 */
export function chartFrame(
  s: Settings,
  m: Model,
  rates: readonly bigint[],
  width = DEFAULT_CHART_W,
  height = DEFAULT_CHART_H,
): ChartFrame {
  const win = m.windowSec
  const dec = m.b.decimals
  const left = PAD.left
  // The plot stops short of the gutter, so a key is never drawn over a curve in any language.
  const right = Math.max(left + 1, width - PAD.right - KEY_GUTTER)
  const top = PAD.top
  const bottom = Math.max(top + 1, height - PAD.bottom)

  const proceeds = (sec: number) => amountOf(m.proceedsAt(sec), dec)
  const gas = amountOf(m.gasB, dec)
  const secs: number[] = []
  for (let i = 0; i <= SAMPLES; i++) secs.push((win * i) / SAMPLES)

  const market = secs.map(proceeds)
  // The offer's own bound rather than its value: the floor slider steps by half a per cent, so
  // the frame holds still under a small move and the curve still fills the chart.
  const stepped = Math.max(0.005, Math.ceil(s.floorPct * 200) / 200)
  const spot = amountOf(m.spotSign, dec)
  const floorBound = spot * (1 - stepped)
  const openBound = amountOf(m.w.minOutStart, dec)
  const lo0 = Math.min(floorBound, ...market, amountOf(m.floorNet, dec))
  const hi0 = Math.max(openBound, ...market)
  const pad = Math.max((hi0 - lo0) * 0.08, spot * 0.0008, 1e-12)
  const lo = lo0 - pad
  const hi = hi0 + pad

  const x = lin(0, win, left, right)
  const y = lin(lo, hi, bottom, top)

  const ticks: [number, number][] = []
  for (let i = 0; i <= 4; i++) {
    const sec = (win * i) / 4
    ticks.push([sec, x(sec)])
  }

  const at = Math.max(0, Math.min(win, m.at))
  const nowPoint: [number, number] = [x(at), y(proceeds(at))]
  const known: [number, number][] = secs
    .filter((sec) => sec <= at)
    .map((sec) => [x(sec), y(proceeds(sec))])
  known.push(nowPoint)
  const future: [number, number][] = [nowPoint]
  for (const sec of secs) if (sec > at) future.push([x(sec), y(proceeds(sec))])

  const beValue = (sec: number) => proceeds(sec) - gas
  const breakEven: [number, number][] = secs.map((sec) => [x(sec), y(beValue(sec))])

  const curves: CurveLine[] = rates.map((rate) => {
    const w = rate === m.rate ? m.w : signedWindow(s, rate)
    const gross = (sec: number) =>
      amountOf(grossOut(w, w.amountIn, BigInt(s.opensSec + Math.round(sec))), dec)
    const points: [number, number][] = secs.map((sec) => [x(sec), y(gross(sec))])
    // Where this offer first falls under the break-even line, on the path as drawn. Hindsight,
    // and labelled as such: it reads the future of one real stretch, which nobody has.
    let crossSec: number | null = null
    for (const sec of secs) {
      if (gross(sec) <= beValue(sec)) {
        crossSec = sec
        break
      }
    }
    return {
      rate,
      selected: rate === m.rate,
      points,
      crossSec,
      crossAt: crossSec === null ? null : [x(crossSec), y(gross(crossSec))],
      labelY: y(gross(win)),
    }
  })

  // The keys sit in the gutter at each curve's own closing height, so a reader matches a line to
  // a rate by looking straight across. Keep every one inside the box even when its line has left
  // it, and push apart any pair that would overlap. None of this touches the plot.
  const order = curves.map((_, i) => i).sort((i, j) => (curves[i]?.labelY ?? 0) - (curves[j]?.labelY ?? 0))
  for (const i of order) {
    const c = curves[i]
    if (c) c.labelY = Math.min(bottom - 4, Math.max(top + 8, c.labelY))
  }
  for (let k = 1; k < order.length; k++) {
    const prev = curves[order[k - 1] as number]
    const cur = curves[order[k] as number]
    if (prev && cur && cur.labelY - prev.labelY < LABEL_GAP) cur.labelY = prev.labelY + LABEL_GAP
  }
  for (let k = order.length - 2; k >= 0; k--) {
    const next = curves[order[k + 1] as number]
    const cur = curves[order[k] as number]
    if (next && cur && next.labelY > bottom - 4 && next.labelY - cur.labelY < LABEL_GAP) {
      cur.labelY = next.labelY - LABEL_GAP
    }
  }

  return {
    width,
    height,
    lo,
    hi,
    x,
    y,
    left,
    right,
    top,
    bottom,
    keyX: right + 4,
    ticks,
    known,
    future,
    breakEven,
    curves,
    floorY: y(amountOf(m.floorGross, dec)),
    netFloorY: y(amountOf(m.floorNet, dec)),
    markX: x(at),
    markY: y(amountOf(m.gross, dec)),
  }
}

// ── The ribbon diagram ────────────────────────────────────────────────────────────────────────

/** One of the five parties the pool's payout splits between. */
export type HolderKey = 'poolKeeps' | 'maker' | 'fee' | 'solver' | 'gas'

export type Holder = {
  key: HolderKey
  /** What this party gets, in raw token B. Gas is priced in B here and shown in PLS. */
  value: bigint
  /** The ribbon's height in pixels, and where it starts on each side. */
  h: number
  /** The y at the pool's node, stacked. */
  sy: number
  /** The y at the holder's node, spread out. */
  y: number
  /** True when the solver is behind: the ribbon is a red mark of minimum height. */
  bad: boolean
}

export type FlowFrame = {
  width: number
  height: number
  /** The x of the three columns and the node width. */
  xTake: number
  xPool: number
  xHold: number
  nodeW: number
  /** Where the single incoming ribbon starts and how tall it is. */
  yPool: number
  sumH: number
  holders: readonly Holder[]
  /** Where the right-hand labels sit, and how wide they may be. */
  labelX: number
  labelW: number
  /**
   * How wide each of the two labels above the diagram may be.
   *
   * They sit at the two left-hand columns and both carry an amount, so on a phone they run into
   * each other unless each is held to its own column. Capping them is what lets them wrap instead
   * — and the top padding grows to match, because a label hangs upward from its column.
   */
  takeTopW: number
  poolTopW: number
  /** True at a width where a label has room for a token amount as well as a name. */
  wide: boolean
}

/** The tallest a ribbon of nothing is still drawn, so it carries its colour to the legend. */
const MIN_RIBBON = 2

/**
 * How tall the diagram has to be at a given width.
 *
 * A narrow column wraps every holder's name onto two lines, and the ribbons still need somewhere
 * to be. Rather than squeezing five ribbons into what is left, the panel grows — a landing page
 * scrolls, and a picture nobody can read is worth less than the pixels it saves.
 */
export const flowHeight = (width: number, expanded = false): number => {
  if (expanded) return 380
  // Match flowFrame's top/gap so holder labels stay inside the box at every width the
  // board can take — including a 320px phone column where two-line names need the gap.
  const wide = width >= 440
  const top = wide ? 36 : width >= 360 ? 56 : 64
  const gap = wide ? 34 : width >= 360 ? 52 : 58
  const bottomPad = 6
  const holders = 5
  const ribbonFloor = wide ? DEFAULT_FLOW_H - 36 - 6 - 4 * 34 : width >= 360 ? 200 : 220
  return top + bottomPad + (holders - 1) * gap + ribbonFloor
}

/**
 * The ribbon diagram: one column in, one pool, five parties out.
 *
 * Heights are the numbers themselves, scaled by a divisor fixed to the signing quote rather than
 * to the current total. A market move then grows or shrinks the solver's slice and leaves the
 * maker's ribbon where the clock put it — the picture stops jumping every time the reader drags
 * the marker.
 */
export function flowFrame(
  m: Model,
  width = DEFAULT_FLOW_W,
  height = DEFAULT_FLOW_H,
): FlowFrame {
  // A console cell is narrower than a page, so amounts come in from 440px, not 640.
  const wide = width >= 440
  const labelW = wide ? 210 : width >= 360 ? 140 : 120
  const nodeW = 6
  const xTake = 0
  const xHold = Math.max(nodeW * 2, width - labelW - nodeW)
  const xPool = Math.round(xHold / 2)
  // Keep top/gap in lockstep with flowHeight so a label never sits outside the box.
  const top = wide ? 36 : width >= 360 ? 56 : 64
  const bottomPad = 6
  // The gap between two holders is what a label sits in. In a 210px column a name is one line;
  // in a 140px one it is two, and at 34px apart "the address you named" printed over the solver's
  // figure. The caller gives a narrow diagram more height to pay for it — see `flowHeight`.
  const gap = wide ? 34 : width >= 360 ? 52 : 58

  const behind = m.solver < 0n
  const raw: { key: HolderKey; value: bigint; bad: boolean }[] = [
    { key: 'poolKeeps', value: m.poolKeeps, bad: false },
    { key: 'maker', value: m.delivered, bad: false },
    { key: 'fee', value: m.fee, bad: false },
    { key: 'solver', value: behind ? 0n : m.solver, bad: behind },
    { key: 'gas', value: m.gasB, bad: false },
  ]

  const total = (() => {
    const sum = raw.reduce((acc, h) => acc + h.value, 0n)
    const anchor = (m.quoteSign * 105n) / 100n
    return Number(sum > anchor ? sum : anchor) || 1
  })()
  const avail = Math.max(24, height - top - bottomPad - (raw.length - 1) * gap)

  const holders: Holder[] = raw.map((h) => ({
    ...h,
    // Gas at its true height: at 90 PLS on a thousand-dollar trade that is a fraction of a pixel,
    // and the label carries the number rather than a stub pretending to a width it lacks.
    h: Math.max(h.key === 'gas' ? 0 : MIN_RIBBON, (Number(h.value) / total) * avail),
    sy: 0,
    y: 0,
  }))

  let sumH = holders.reduce((acc, h) => acc + h.h, 0)
  if (sumH > avail) {
    const big = holders.reduce((acc, h) => (h.h > acc.h ? h : acc), holders[0] as Holder)
    big.h -= sumH - avail
    sumH = holders.reduce((acc, h) => acc + h.h, 0)
  }

  let yy = top
  for (const h of holders) {
    h.y = yy
    yy += h.h + gap
  }
  const span = yy - gap - top
  const yPool = top + (span - sumH) / 2
  let sy = yPool
  for (const h of holders) {
    h.sy = sy
    sy += h.h
  }

  return {
    width,
    height,
    xTake,
    xPool,
    xHold,
    nodeW,
    yPool,
    sumH,
    holders,
    labelX: xHold + nodeW + 10,
    labelW: labelW - 12,
    takeTopW: Math.max(72, xPool - 8),
    poolTopW: Math.max(72, width - xPool - 4),
    wide,
  }
}

/** A ribbon between two columns, as one closed path. */
export function ribbon(
  x0: number,
  a0: number,
  b0: number,
  x1: number,
  a1: number,
  b1: number,
): string {
  const xm = (x0 + x1) / 2
  return (
    `M${x0},${a0.toFixed(1)} C${xm},${a0.toFixed(1)} ${xm},${a1.toFixed(1)} ${x1},${a1.toFixed(1)}` +
    ` L${x1},${b1.toFixed(1)} C${xm},${b1.toFixed(1)} ${xm},${b0.toFixed(1)} ${x0},${b0.toFixed(1)} Z`
  )
}

// ── The spread bar ────────────────────────────────────────────────────────────────────────────

export type BarFrame =
  | { kind: 'none' }
  | { kind: 'short'; feeFrac: number }
  | { kind: 'split'; feeFrac: number; solverFrac: number; gasFrac: number }

/**
 * The spread, as three segments whose widths are their own numbers.
 *
 * `fee + solver + gas === spread` exactly, so the bar is the identity and not an illustration of
 * it. Only the rate moves the first boundary and only gas moves the second. When gas is wider
 * than what is left, there is no green and the deficit is hatched.
 */
export function barFrame(m: Model): BarFrame {
  if (!(m.spread > 0n)) return { kind: 'none' }
  const spread = Number(m.spread)
  const feeFrac = Math.min(1, Number(m.fee) / spread)
  if (m.solver <= 0n) return { kind: 'short', feeFrac }
  const solverFrac = Number(m.solver) / spread
  return {
    kind: 'split',
    feeFrac,
    solverFrac,
    gasFrac: Math.max(0, 1 - feeFrac - solverFrac),
  }
}

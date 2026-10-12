import { useState } from 'react'
import type { TokenInfo } from '@prove.cash/sdk'
import { t } from '../../lib/i18n'
import { lin, sizeText, tickText } from './chart'
import { depthAt, type Level } from './book'
import type { PoolState } from './useBook'
import { useMeasuredWidth } from './useMeasuredWidth'

/**
 * The book as depth against price: how much changes hands at each rate, curve and board together.
 *
 * This is the drawing the integration was for. The mockup shaded the pool's capacity and then
 * scattered the offers over it as bars, so a reader could see both and add neither. Here one
 * curve per side answers a single question — at this price, how much base can actually move —
 * and the shaded part underneath says how much of that the pool alone would carry.
 *
 * The gap between the shading and the line is the board's contribution, and it is the whole
 * point: inside the pool's fee band the shading is flat on the floor while the line can be well
 * above it, because signatures rest at prices the curve refuses to quote.
 *
 * Shaped like every other depth chart: bids to the left of mid, asks to the right, each rising as
 * it walks away from the spread, and a valley between them. The first attempt ran both arms
 * across the whole range so they overlapped and crossed, which is not a shape anyone reads.
 *
 * Clipping the arms costs nothing in truth. A crossed board does put bids above mid and asks
 * below it, but a bid above mid is still a bid at mid — `depthAt` counts every offer a trade at
 * that price would satisfy — so the crossed depth is already inside each arm's value where the
 * two meet. What the clipping removes is the double drawing of it, not the liquidity.
 */

const C = {
  dim: 'var(--color-dim)',
  line: 'var(--color-line)',
  bright: 'var(--color-bright)',
  pool: 'var(--color-body)',
  bid: 'var(--color-proven)',
  ask: 'var(--color-unproven)',
}

const COMPACT_AT = 380
/** Enough to keep the staircase's risers vertical without drawing a point per pixel. */
const SAMPLES = 220

type Mode = 'both' | 'pool'

/**
 * The price range worth drawing: everything the board touches, and the curve either side of it.
 *
 * Pure so the valley shape — bids left of mid, asks right, both climbing away from the spread —
 * can be checked without rendering. Mid is where the two arms meet and the depth should sit on
 * the floor of the fee band when only the pool is counted.
 */
export function capacityDomain(levels: readonly Level[], reserves: { x: number; y: number } | null) {
  const rates = levels.map((l) => l.rate).filter((r) => isFinite(r) && r > 0)
  const spot = reserves && reserves.x > 0 ? reserves.y / reserves.x : null
  const all = [...rates, ...(spot ? [spot] : [])]
  if (all.length === 0) return null
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  // A book with one price still needs an axis, so open a window around it.
  const pad = hi > lo ? (hi - lo) * 0.35 : hi * 0.08
  // Mid is the pool's rate where there is a pool, because that is the price the curve will
  // actually trade at. With no pool, the middle of the best bid and the best ask stands in.
  const bestBid = Math.max(...levels.filter((l) => l.side === 'bid').map((l) => l.rate), -Infinity)
  const bestAsk = Math.min(...levels.filter((l) => l.side === 'ask').map((l) => l.rate), Infinity)
  const fallback =
    isFinite(bestBid) && isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : isFinite(bestBid) ? bestBid : bestAsk
  const mid = spot ?? (isFinite(fallback) ? fallback : (lo + hi) / 2)
  // Mid is where the valley meets. A spot far from every resting offer (a skewed pool under a
  // board priced in a different neighbourhood) still has to sit on the axis — otherwise both
  // arms clip against a line that is not on the plot and the valley disappears off-screen.
  let loBound = Math.max(lo - pad, hi * 0.02)
  let hiBound = hi + pad
  loBound = Math.min(loBound, mid)
  hiBound = Math.max(hiBound, mid)
  if (hiBound <= loBound) {
    const span = Math.max(Math.abs(mid) * 0.08, 1e-12)
    loBound = mid - span
    hiBound = mid + span
  }
  return { lo: loBound, hi: hiBound, mid }
}

/** An SVG polyline through the points: one M, then an L for each point after it. */
export function linePath(pts: readonly (readonly [number, number])[]): string {
  return pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)},${py.toFixed(1)}`).join('')
}

/**
 * The same polyline closed down to the baseline, for a fill. Each point after the first corner
 * needs its own L. The first version glued the line's first point onto the corner with no command
 * letter, so "170.0" and "54.0" ran together as "170.054.0". A parser reads that as 170.054, then
 * .0, and the fill's first point moved to x = 0, over the axis labels.
 */
export function areaPath(pts: readonly (readonly [number, number])[], baseY: number): string {
  if (pts.length === 0) return ''
  const first = pts[0]!
  const last = pts[pts.length - 1]!
  const b = baseY.toFixed(1)
  return `M${first[0].toFixed(1)},${b}L${linePath(pts).slice(1)}L${last[0].toFixed(1)},${b}Z`
}

export function Capacity({
  base,
  quote,
  levels,
  reserves,
  gamma,
  poolState,
}: {
  base: TokenInfo
  quote: TokenInfo
  levels: readonly Level[]
  reserves: { x: number; y: number } | null
  gamma: number
  poolState: PoolState
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>()
  const [mode, setMode] = useState<Mode>('both')

  // A pool is a market on its own: the curve is drawable with nothing resting on the board at
  // all. Only when there is neither a pool nor an offer is there nothing to say, and then the
  // missing thing is the pool, not the offers.
  const domain = capacityDomain(levels, reserves)
  if (!domain) {
    // Say which of the three it is. "No pool" is a claim about the market and it must not be made
    // on the strength of a request that never came back.
    const why =
      poolState === 'reading'
        ? t('chart.pool.reading')
        : poolState === 'failed'
          ? t('chart.pool.failed')
          : t('chart.pool.noPool', { in: base.symbol, out: quote.symbol })
    return (
      <div ref={ref} className="py-6 text-[13px] text-(--color-dim)">
        {why}
      </div>
    )
  }

  const compact = width > 0 && width < COMPACT_AT
  const padL = compact ? 4 : 54
  const padR = 6
  const padB = compact ? 16 : 30
  const height = 200
  const plotW = Math.max(width - padL - padR, 40)
  const plotH = height - padB - 8

  const at = (p: number, side: 'bid' | 'ask') => depthAt(p, side, levels, reserves, gamma)

  /** Sample one arm across its own half of the axis only. */
  const arm = (side: 'bid' | 'ask', from: number, to: number) =>
    Array.from({ length: SAMPLES }, (_, i) => {
      const p = from + ((to - from) * i) / (SAMPLES - 1)
      return { p, d: at(p, side) }
    })

  const bids = arm('bid', domain.lo, domain.mid)
  const asks = arm('ask', domain.mid, domain.hi)

  const shown = (d: { pool: number; total: number }) => (mode === 'pool' ? d.pool : d.total)
  // Always scaled to the combined peak, in both modes. Scaling to whatever is on screen made the
  // curve fill the plot either way, so switching to "pool only" appeared to change nothing —
  // exactly hiding the thing the switch exists to show. Held against one axis, dropping the board
  // visibly drops the line.
  const peak = Math.max(...[...bids, ...asks].map((s) => s.d.total), 1)

  const x = lin(domain.lo, domain.hi, padL, padL + plotW)
  const y = lin(0, peak, 8 + plotH, 8)

  type Sample = { p: number; d: { pool: number; total: number } }
  const xy = (pts: Sample[], pick: (s: Sample) => number) =>
    pts.map((s) => [x(s.p), y(pick(s))] as const)
  const path = (pts: Sample[], pick: (s: Sample) => number) => linePath(xy(pts, pick))
  const area = (pts: Sample[], pick: (s: Sample) => number) => areaPath(xy(pts, pick), y(0))

  const ARMS = [
    { side: 'bid', tone: C.bid, pts: bids },
    { side: 'ask', tone: C.ask, pts: asks },
  ] as const

  return (
    <div ref={ref} className="grid min-w-0 gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <div
          role="radiogroup"
          aria-label={t('chart.cap.what')}
          className="inline-flex gap-px bg-(--color-line)">
          {(['both', 'pool'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={`num px-2 py-1 text-[10px] tracking-[0.16em] uppercase ${
                mode === m
                  ? 'bg-(--color-proven) text-(--color-ink)'
                  : 'bg-(--color-panel) text-(--color-dim) hover:text-(--color-bright)'
              }`}>
              {m === 'both' ? t('chart.cap.both') : t('chart.cap.pool')}
            </button>
          ))}
        </div>
      </div>

      {width > 0 && (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t('chart.cap.figure', { base: base.symbol, quote: quote.symbol })}>
          <line
            x1={padL}
            x2={padL + plotW}
            y1={y(0)}
            y2={y(0)}
            stroke={C.line}
            strokeWidth="1"
          />

          {ARMS.map(({ side, tone, pts }) => (
            <g key={side}>
              {/*
                The composite valley body. Each arm is filled down to zero so the gap at mid reads
                as a valley rather than as two bare lines that happen to meet. Bid and ask keep
                their own tones; the floor between them is the fee band where the pool alone has
                nothing and only signatures can lift the line.
              */}
              <path d={area(pts, (s) => shown(s.d))} fill={tone} opacity={0.14} />
              {/* The curve's own carry, nested inside the composite fill. What rises above it is
                  signed depth — the gap that is the whole point of counting both sources. */}
              {mode === 'both' && (
                <>
                  <path d={area(pts, (s) => s.d.pool)} fill={C.pool} opacity={0.18} />
                  {/*
                    The curve's own edge, drawn. Without it the only line on the chart was the
                    total, whose smooth stretches are the pool and whose risers are the board —
                    one line doing two jobs, which read as diagonals wandering for no reason.
                    With the pool's boundary visible the division explains itself: what is smooth
                    belongs to the curve, and every step above it is somebody's signature.
                  */}
                  <path
                    d={path(pts, (s) => s.d.pool)}
                    fill="none"
                    stroke={C.pool}
                    strokeWidth="1"
                    opacity={0.45}
                  />
                </>
              )}
              <path
                d={path(pts, (s) => shown(s.d))}
                fill="none"
                stroke={tone}
                strokeWidth="2"
                opacity={0.9}
              />
            </g>
          ))}

          {/* The spread sits here. Both arms start from it and climb away. */}
          <line
            x1={x(domain.mid)}
            x2={x(domain.mid)}
            y1={8}
            y2={y(0)}
            stroke={C.dim}
            strokeWidth="1"
            strokeDasharray="2 4"
          />

          {!compact && (
            <>
              <text x={padL - 8} y={y(peak) + 4} textAnchor="end" fontSize="10" className="num" fill={C.dim}>
                {sizeText(peak)}
              </text>
              <text x={padL - 8} y={y(0) + 4} textAnchor="end" fontSize="10" className="num" fill={C.dim}>
                0
              </text>
              <text x={padL} y={height - 4} fontSize="10" className="num" fill={C.dim}>
                {tickText(domain.lo)}
              </text>
              <text
                x={padL + plotW}
                y={height - 4}
                textAnchor="end"
                fontSize="10"
                className="num"
                fill={C.dim}>
                {tickText(domain.hi)}
              </text>
            </>
          )}
        </svg>
      )}
    </div>
  )
}

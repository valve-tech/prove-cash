import type { TokenInfo } from '@prove.cash/sdk'
import { t } from '../../lib/i18n'
import { lin, padRange, sizeText, tickText } from './chart'
import type { Level } from './book'
import { useMeasuredWidth } from './useMeasuredWidth'

/**
 * What a trade of each size actually gets, and where the board's offers sit against it.
 *
 * The pool's average rate decays with size — that is the impact. Drawn alone it is a single
 * falling line and says nothing about whether a rate is good. So the board goes on the same axes:
 * every resting offer is a point at its own (size, rate), and its position against the line is
 * the whole reading. Above the line the offer beats the pool at that size; below it the pool
 * does. Two pictures would have made the reader hold a ruler up to the screen.
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
const SAMPLES = 90

/** The average rate the pool pays for selling `d` base, fee included. */
export const sellRate = (x: number, y: number, gamma: number, d: number): number =>
  d <= 0 ? (y / x) * gamma : (gamma * y) / (x + gamma * d)

export function Impact({
  base,
  quote,
  levels,
  reserves,
  gamma,
}: {
  base: TokenInfo
  quote: TokenInfo
  levels: readonly Level[]
  reserves: { x: number; y: number } | null
  gamma: number
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>()

  // Sized by what people are actually offering, so the plot frames the decisions being made
  // rather than the pool's whole reserve.
  const sizes = levels.map((l) => l.size).filter((s) => s > 0)
  const maxSize = sizes.length ? Math.max(...sizes) * 1.4 : reserves ? reserves.x * 0.02 : 0
  if (!reserves || maxSize <= 0) {
    return (
      <div ref={ref} className="py-6 text-[13px] text-(--color-dim)">
        {t('chart.pool.noPool', { in: base.symbol, out: quote.symbol })}
      </div>
    )
  }

  const compact = width > 0 && width < COMPACT_AT
  const padL = compact ? 4 : 62
  const padR = 8
  const padB = compact ? 16 : 28
  const height = 190
  const plotW = Math.max(width - padL - padR, 40)
  const plotH = height - padB - 10

  const curve = Array.from({ length: SAMPLES }, (_, i) => {
    const d = (maxSize * i) / (SAMPLES - 1)
    return { d, rate: sellRate(reserves.x, reserves.y, gamma, d) }
  })

  const rates = [...curve.map((c) => c.rate), ...levels.map((l) => l.rate)]
  // `padRange`, not a local pad, because this axis carries a rate. A big enough trade drives the
  // pool's rate close to zero, and a padded floor under the smallest rate then lands below zero —
  // a price no constant-product pool reaches. `padRange` keeps a positive frame positive.
  const [rLo, rHi] = padRange(rates, 0.12)

  const x = lin(0, maxSize, padL, padL + plotW)
  const y = lin(rLo, rHi, 10 + plotH, 10)

  const d = curve.map((c, i) => `${i ? 'L' : 'M'}${x(c.d).toFixed(1)},${y(c.rate).toFixed(1)}`).join('')

  return (
    <div ref={ref} className="min-w-0">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t('chart.impact.figure', { base: base.symbol, quote: quote.symbol })}>
          <line x1={padL} x2={padL + plotW} y1={10 + plotH} y2={10 + plotH} stroke={C.line} />

          {/* The pool's own rate against size. Everything else is read against this. */}
          <path d={d} fill="none" stroke={C.pool} strokeWidth="2" opacity={0.75} />

          {levels.map((l) => {
            const cx = x(Math.min(l.size, maxSize))
            const cy = y(l.rate)
            const beatsPool = l.rate > sellRate(reserves.x, reserves.y, gamma, l.size)
            return (
              <circle
                key={`${l.side}-${l.rate}`}
                cx={cx}
                cy={cy}
                r={l.count > 1 ? 4 : 3}
                fill={l.side === 'bid' ? C.bid : C.ask}
                opacity={beatsPool ? 0.95 : 0.4}
              />
            )
          })}

          {!compact && (
            <>
              <text x={padL - 8} y={y(rHi) + 4} textAnchor="end" fontSize="10" className="num" fill={C.dim}>
                {tickText(rHi)}
              </text>
              <text x={padL - 8} y={y(rLo) + 4} textAnchor="end" fontSize="10" className="num" fill={C.dim}>
                {tickText(rLo)}
              </text>
              <text x={padL} y={height - 4} fontSize="10" className="num" fill={C.dim}>
                0
              </text>
              <text
                x={padL + plotW}
                y={height - 4}
                textAnchor="end"
                fontSize="10"
                className="num"
                fill={C.dim}>
                {sizeText(maxSize)}
              </text>
            </>
          )}
        </svg>
      )}
    </div>
  )
}

import type { TokenInfo } from '@prove.cash/sdk'
import { t } from '../../lib/i18n'
import { lin, sizeText, tickText } from './chart'
import type { Level } from './book'
import { clear, type Reserves as R } from './clearing'
import type { PoolState } from './useBook'
import { useMeasuredWidth } from './useMeasuredWidth'

/**
 * The pool in reserve space, and how far the board can push it.
 *
 * The only drawing here whose axes are not price. Both are token balances, and the pool is a point
 * on the hyperbola `x·y = k` — which is the thing this view exists to show: liquidity is a curve,
 * not a number, and a large trade costs more because it slides you along it. No amount of price
 * charting makes that visible, because price is the *slope* of the ray from the origin, and a
 * slope is exactly what a price axis hides.
 *
 * A resting offer has no coordinate here, which is why this was the hard one to integrate. What it
 * has is a destination: take it, unwind it through the pool, and the reserves end up somewhere
 * else. So the board is drawn as displacement — a second point where the reserves land once
 * everything profitable has been taken, and a second ray showing the price that leaves behind.
 * See `clearing.ts` for the order that happens in; crossed offers match each other and never touch
 * the curve.
 *
 * The gap between the two rays is the answer to "how far can this board move this pool", which is
 * a question none of the other four can be asked.
 */

const C = {
  dim: 'var(--color-dim)',
  line: 'var(--color-line)',
  bright: 'var(--color-bright)',
  pool: 'var(--color-body)',
  up: 'var(--color-proven)',
  down: 'var(--color-unproven)',
}

const COMPACT_AT = 380
const SAMPLES = 80
/** How much of the curve either side of the action to show. */
const WINDOW = 0.4

export function Reserves({
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
  reserves: R | null
  gamma: number
  poolState: PoolState
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>()

  if (!reserves) {
    // Which of the three it is. This drawing is nothing without a pool, but "there is no pool"
    // is a claim about the market and a throttled read is not evidence for it. The depth chart
    // learned this the hard way; there is no reason to learn it twice.
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

  const cleared = clear(levels, reserves, gamma)
  const after = cleared?.after ?? reserves
  const k = reserves.x * reserves.y

  // Framed on the curve around the pool, not on the displacement. A deep pool barely moves — this
  // board shifts 3 tPLSX of a 10,000 reserve — and zooming until that was visible would flatten
  // the hyperbola into a straight line and lose the one thing this view exists to show.
  const lo = Math.min(reserves.x, after.x)
  const hi = Math.max(reserves.x, after.x)
  const pad = Math.max((hi - lo) * 1.5, reserves.x * WINDOW)
  const x0 = Math.max(lo - pad, reserves.x * 0.05)
  const x1 = hi + pad

  const compact = width > 0 && width < COMPACT_AT
  const padL = compact ? 4 : 58
  const padR = 8
  const padB = compact ? 16 : 28
  const height = 200
  const plotW = Math.max(width - padL - padR, 40)
  const plotH = height - padB - 12

  // Framed on the curve's own range over the window. It used to run to zero so that a ray from
  // the origin fitted, which spent half the plot on emptiness and left the hyperbola looking like
  // a gentle slope. The rays are gone; the price is printed instead, which is what a reader was
  // going to read off them anyway.
  const yAt = (x: number) => k / x
  const span = yAt(x0) - yAt(x1)
  const yLo = yAt(x1) - span * 0.12
  const yHi = yAt(x0) + span * 0.12

  const X = lin(x0, x1, padL, padL + plotW)
  const Y = lin(yLo, yHi, 12 + plotH, 12)

  const curve = Array.from({ length: SAMPLES }, (_, i) => {
    const x = x0 + ((x1 - x0) * i) / (SAMPLES - 1)
    return `${i ? 'L' : 'M'}${X(x).toFixed(1)},${Y(yAt(x)).toFixed(1)}`
  }).join('')

  const moved = cleared ? Math.abs(cleared.netBase) > reserves.x * 1e-9 : false
  // Base flowing in means the pool is buying base, so its price in quote falls.
  const tone = !moved ? C.pool : cleared!.netBase > 0 ? C.down : C.up

  // Whether the move is worth drawing. Below about three pixels an arrow is a smudge on top of
  // the dot it starts from, and drawing one would suggest a displacement the reader cannot see
  // and cannot check. The prose carries the number in that case, and says it is too small to draw.
  const shift = Math.abs(X(after.x) - X(reserves.x))
  const drawable = moved && shift >= 3

  return (
    <div ref={ref} className="grid min-w-0 gap-2">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t('chart.res.figure', {
            base: base.symbol,
            quote: quote.symbol,
            moved: sizeText(Math.abs(cleared?.netBase ?? 0)),
          })}>
          {/* x·y = k. Everything the pool can ever be, at this depth of liquidity. */}
          <path d={curve} stroke={C.pool} strokeWidth="1.5" fill="none" opacity={0.8} />

          {/* Where the board takes it. Drawn before the current point so that one stays on top. */}
          {drawable && (
            <>
              <path
                d={`M${X(reserves.x).toFixed(1)},${Y(reserves.y).toFixed(1)}L${X(after.x).toFixed(1)},${Y(after.y).toFixed(1)}`}
                stroke={tone}
                strokeWidth="1.5"
                opacity={0.9}
              />
              <circle cx={X(after.x)} cy={Y(after.y)} r={4} fill={tone} />
            </>
          )}

          <circle
            cx={X(reserves.x)}
            cy={Y(reserves.y)}
            r={4}
            fill="var(--color-ink)"
            stroke={C.bright}
            strokeWidth="1.5"
          />

          {!compact && (
            <>
              <text x={padL - 8} y={Y(reserves.y) + 4} textAnchor="end" fontSize="10"
                className="num" fill={C.dim}>
                {sizeText(reserves.y)}
              </text>
              <text x={X(reserves.x)} y={height - 4} textAnchor="middle" fontSize="10"
                className="num" fill={C.dim}>
                {sizeText(reserves.x)}
              </text>
            </>
          )}
        </svg>
      )}

      <p className="text-[12px] leading-relaxed text-(--color-dim)">
        {moved
          ? t(drawable ? 'chart.res.moves' : 'chart.res.tiny', {
              base: base.symbol,
              amount: sizeText(Math.abs(cleared!.netBase)),
              from: tickText(reserves.y / reserves.x),
              to: tickText(after.y / after.x),
            })
          : t('chart.res.still', { in: base.symbol, out: quote.symbol })}
        {cleared && cleared.matched > 0 && (
          <>
            {' '}
            {t('chart.res.matched', { amount: sizeText(cleared.matched), base: base.symbol })}
          </>
        )}
      </p>
    </div>
  )
}

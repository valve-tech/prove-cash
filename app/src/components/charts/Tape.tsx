import { formatUnits } from 'viem'
import { minOutAt, type Intent, type TokenInfo } from '@prove.cash/sdk'
import { t } from '../../lib/i18n'
import { lin, minutesText, tickText } from './chart'
import { useMeasuredWidth } from './useMeasuredWidth'

/**
 * Every resting offer across time and price: when it dies, and where its floor is going.
 *
 * This is the one reading the other drawings cannot give. A ladder and a depth curve are both
 * photographs of one instant, so a decaying offer and a fixed one look identical in them, and an
 * offer with nine seconds left looks like an offer with an hour. Here each offer is a segment
 * from now to its expiry, sloping if its floor decays, and the slope is the offer telling you
 * what it will accept later.
 *
 * The pool's rate is the horizontal line. Where a segment crosses it, that offer becomes
 * fillable against the curve without anybody else showing up.
 */

const C = {
  dim: 'var(--color-dim)',
  line: 'var(--color-line)',
  bright: 'var(--color-bright)',
  bid: 'var(--color-proven)',
  ask: 'var(--color-unproven)',
}

const COMPACT_AT = 380

type Segment = {
  key: string
  side: 'bid' | 'ask'
  /** Seconds from now until it expires. */
  life: number
  rateNow: number
  rateEnd: number
}

/**
 * Each live offer as a segment. Exported for the test: the decay endpoints are the claim, and a
 * segment drawn flat when the offer actually decays would misinform without looking wrong.
 */
export function segmentsOf(
  intents: readonly Intent[],
  base: TokenInfo,
  quote: TokenInfo,
  now: bigint,
): Segment[] {
  const out: Segment[] = []
  for (const i of intents) {
    const sellsBase = i.tokenIn.toLowerCase() === base.address.toLowerCase()
    const buysBase = i.tokenIn.toLowerCase() === quote.address.toLowerCase()
    if (!sellsBase && !buysBase) continue
    if (i.endTime <= now || i.amountIn <= 0n) continue

    const outNow = minOutAt(i, now)
    const outEnd = minOutAt(i, i.endTime)
    if (outNow <= 0n) continue

    const rate = (o: bigint) =>
      sellsBase
        ? Number(formatUnits(o, quote.decimals)) / Number(formatUnits(i.amountIn, base.decimals))
        : Number(formatUnits(i.amountIn, quote.decimals)) / Number(formatUnits(o, base.decimals))

    const rateNow = rate(outNow)
    const rateEnd = outEnd > 0n ? rate(outEnd) : rateNow
    if (!isFinite(rateNow) || !isFinite(rateEnd)) continue

    out.push({
      key: `${i.maker}-${i.nonce}`,
      side: sellsBase ? 'ask' : 'bid',
      life: Number(i.endTime - now),
      rateNow,
      rateEnd,
    })
  }
  return out
}

export function Tape({
  base,
  quote,
  intents,
  spot,
  now,
}: {
  base: TokenInfo
  quote: TokenInfo
  intents: readonly Intent[]
  spot: number | null
  now: bigint
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>()
  const segs = segmentsOf(intents, base, quote, now)

  if (segs.length === 0) {
    return (
      <div ref={ref} className="py-6 text-[13px] text-(--color-dim)">
        {t('chart.ladder.empty')}
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

  const maxLife = Math.max(...segs.map((s) => s.life), 60)
  const rates = [...segs.flatMap((s) => [s.rateNow, s.rateEnd]), ...(spot ? [spot] : [])]
  const rLo = Math.min(...rates)
  const rHi = Math.max(...rates)
  const pad = rHi > rLo ? (rHi - rLo) * 0.12 : rHi * 0.02

  const x = lin(0, maxLife, padL, padL + plotW)
  const y = lin(rLo - pad, rHi + pad, 10 + plotH, 10)

  return (
    <div ref={ref} className="min-w-0">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t('chart.tape.figure', {
            base: base.symbol,
            quote: quote.symbol,
            count: String(segs.length),
          })}>
          <line x1={padL} x2={padL + plotW} y1={10 + plotH} y2={10 + plotH} stroke={C.line} />

          {spot != null && isFinite(spot) && (
            <line
              x1={padL}
              x2={padL + plotW}
              y1={y(spot)}
              y2={y(spot)}
              stroke={C.bright}
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity={0.6}
            />
          )}

          {segs.map((s) => {
            const tone = s.side === 'bid' ? C.bid : C.ask
            return (
              <g key={s.key}>
                <line
                  x1={x(0)}
                  x2={x(s.life)}
                  y1={y(s.rateNow)}
                  y2={y(s.rateEnd)}
                  stroke={tone}
                  strokeWidth="1.5"
                  opacity={0.65}
                />
                {/* The head is now: what the offer costs a taker at this moment. */}
                <circle cx={x(0)} cy={y(s.rateNow)} r={2.5} fill={tone} />
              </g>
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
                {t('chart.tape.now')}
              </text>
              <text
                x={padL + plotW}
                y={height - 4}
                textAnchor="end"
                fontSize="10"
                className="num"
                fill={C.dim}>
                {minutesText(Math.round(maxLife / 60))}
              </text>
            </>
          )}
        </svg>
      )}
    </div>
  )
}

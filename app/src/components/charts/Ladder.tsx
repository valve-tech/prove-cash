import type { TokenInfo } from '@prove.cash/sdk'
import { t } from '../../lib/i18n'
import { lin, sizeText, tickText } from './chart'
import { poolAskDepth, poolBidDepth, type Level } from './book'
import { useMeasuredWidth } from './useMeasuredWidth'

/**
 * The book as a ladder, with the curve counted in.
 *
 * The first version drew the board's offers as bars and the pool as a dashed line across them.
 * That is two pictures sharing an axis, not one book: the line said where spot was and the bars
 * said what was signed, and nothing ever added up. The pool is liquidity at a price like any
 * offer, so it belongs in the bars.
 *
 * Each row therefore carries what the board holds at that price plus what the curve adds between
 * this price and the last one nearer spot. Slicing it that way makes the rows sum to the
 * cumulative depth at any level, so the ladder is a discretisation of the continuous book rather
 * than a separate view of it.
 */

const C = {
  dim: 'var(--color-dim)',
  bright: 'var(--color-bright)',
  bid: 'var(--color-proven)',
  ask: 'var(--color-unproven)',
  pool: 'var(--color-body)',
}

/** Under this there is no room for a rate gutter and a bar side by side. */
const COMPACT_AT = 380

const ROW = 18
const GAP = 2

type Rung = Level & {
  /** What the curve adds in the band between this price and the last one nearer spot. */
  pool: number
}

/**
 * Give every level the slice of curve depth that belongs to its price band.
 *
 * Pool depth is cumulative and monotone away from spot, so the slice for a row is the difference
 * between the depth at its price and the depth at the previous price on the same side. Taking the
 * cumulative figure for every row instead would count the same liquidity once per level.
 */
export function rungsOf(
  levels: readonly Level[],
  reserves: { x: number; y: number } | null,
  gamma: number,
): Rung[] {
  const depth = (side: Level['side'], p: number) =>
    !reserves
      ? 0
      : side === 'bid'
        ? poolBidDepth(reserves.x, reserves.y, gamma, p)
        : poolAskDepth(reserves.x, reserves.y, gamma, p)

  // Bids deepen as the price falls, asks as it rises, so each side walks away from spot in its
  // own direction and the previous rung is the one nearer spot.
  const bids = levels.filter((l) => l.side === 'bid').sort((a, b) => b.rate - a.rate)
  const asks = levels.filter((l) => l.side === 'ask').sort((a, b) => a.rate - b.rate)

  const out = new Map<Level, number>()
  for (const run of [bids, asks]) {
    let prev = 0
    for (const l of run) {
      const here = depth(l.side, l.rate)
      out.set(l, Math.max(0, here - prev))
      prev = here
    }
  }
  return levels.map((l) => ({ ...l, pool: out.get(l) ?? 0 }))
}

export function Ladder({
  base,
  quote,
  levels,
  reserves,
  gamma,
}: {
  base: TokenInfo
  quote: TokenInfo
  levels: readonly Level[]
  /** Pool reserves in whole tokens, or null on a pair the chain has no pool for. */
  reserves: { x: number; y: number } | null
  gamma: number
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>()

  if (levels.length === 0) {
    return (
      <div ref={ref} className="py-6 text-[13px] text-(--color-dim)">
        {t('chart.ladder.empty')}
      </div>
    )
  }

  const rungs = rungsOf(levels, reserves, gamma)
  const compact = width > 0 && width < COMPACT_AT
  const rateW = compact ? 0 : 78
  const sizeW = compact ? 0 : 66
  const height = rungs.length * (ROW + GAP)
  const plotW = Math.max(width - rateW - sizeW, 40)
  const max = Math.max(...rungs.map((r) => r.size + r.pool), 1)
  const x = lin(0, max, 0, plotW)

  const bestAsk = Math.min(...rungs.filter((l) => l.side === 'ask').map((l) => l.rate), Infinity)
  const bestBid = Math.max(...rungs.filter((l) => l.side === 'bid').map((l) => l.rate), -Infinity)

  return (
    <div ref={ref} className="min-w-0">
      {width > 0 && (
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={t('chart.ladder.figure', {
            base: base.symbol,
            quote: quote.symbol,
            levels: String(rungs.length),
          })}>
          {rungs.map((r, i) => {
            const y = i * (ROW + GAP)
            const tone = r.side === 'bid' ? C.bid : C.ask
            const best = r.rate === bestAsk || r.rate === bestBid
            const wBoard = x(r.size)
            const wPool = x(r.pool)
            return (
              <g key={`${r.side}-${r.rate}`}>
                {/* Signed depth first, then the curve's slice riding on top of it. */}
                <rect
                  x={rateW}
                  y={y}
                  width={Math.max(wBoard, 1)}
                  height={ROW}
                  fill={tone}
                  opacity={best ? 0.5 : 0.24}
                />
                {wPool > 0.5 && (
                  <rect
                    x={rateW + wBoard}
                    y={y}
                    width={wPool}
                    height={ROW}
                    fill={C.pool}
                    opacity={0.2}
                  />
                )}
                {!compact && (
                  <>
                    <text
                      x={rateW - 8}
                      y={y + ROW / 2}
                      textAnchor="end"
                      dominantBaseline="middle"
                      fontSize="11"
                      className="num"
                      fill={best ? C.bright : tone}>
                      {tickText(r.rate)}
                    </text>
                    <text
                      x={width - 6}
                      y={y + ROW / 2}
                      textAnchor="end"
                      dominantBaseline="middle"
                      fontSize="11"
                      className="num"
                      fill={C.dim}>
                      {sizeText(r.size + r.pool)}
                    </text>
                  </>
                )}
              </g>
            )
          })}
        </svg>
      )}
    </div>
  )
}

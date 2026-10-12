import { useEffect, useState, type ReactNode } from 'react'
import { parseUnits, type Address } from 'viem'
import {
  displaySymbol,
  getChainId,
  marketAddress,
  queryIntents,
  type TokenInfo,
} from '@prove.cash/sdk'
import { fixed, t, tCount } from '../../lib/i18n'
import { InfoTip } from '../Tip'
import { PairAvatars } from '../TokenAvatar'
import {
  asNumber,
  chargeRate,
  movePct,
  payRate,
  poolHolds,
  poolPays,
  reserveOf,
  spotRate,
  type Pool,
  type PoolRead,
} from '../../lib/pool'
import { usePoolRead } from '../../hooks/usePool'
import { FULL_FALL, type Fall } from '../../lib/curve'
import {
  decayBreaks,
  decayRateAt,
  decayShape,
  lin,
  minutesText,
  noCurveText,
  padRange,
  pctText,
  poolSource,
  sizeText,
  tickText,
} from './chart'
import { useMeasuredWidth } from './useMeasuredWidth'

/**
 * What the pool would do with the offer being typed.
 *
 * The sign page used to show no market at all: the maker picked a floor with nothing to pick it
 * against. This panel draws the pool's own curve for the pair, puts the draft on it at (size,
 * floor), and says in one sentence whether that offer fills now or rests. Everything comes from
 * one reserve snapshot — no quote per keystroke, and no router round trip per plotted point.
 *
 * The panel never claims a fill. A curve drawn from a snapshot is a bound that can move before
 * anybody executes, so the wording is "at these reserves" throughout.
 */

const C = {
  pool: 'var(--color-body)',
  dim: 'var(--color-dim)',
  line: 'var(--color-line)',
  edge: 'var(--color-line-bright)',
  bright: 'var(--color-bright)',
  good: 'var(--color-proven)',
  bad: 'var(--color-danger)',
  warn: 'var(--color-unproven)',
  ink: 'var(--color-ink)',
}

/**
 * Below this the plot has no room for an axis, so it drops to the essentials: the pool line, the
 * draft marker, and the sentence. Measured, not guessed — the axis needs 76px of padding, and
 * under 380 the plot itself gets less than the labels beside it.
 */
const COMPACT_AT = 380

/** A typed amount as raw units, or null while the field is not a number yet. */
function safeParse(text: string, decimals: number | undefined): bigint | null {
  if (decimals === undefined) return null
  const t = text.trim()
  if (t === '' || !/^\d*\.?\d*$/.test(t) || t === '.') return null
  try {
    const v = parseUnits(t, decimals)
    return v > 0n ? v : null
  } catch {
    return null
  }
}

/** A plotted size back into raw units. Eight decimals is finer than any pixel. */
const toWei = (x: number, decimals: number): bigint =>
  parseUnits(x.toFixed(Math.min(decimals, 8)), decimals)

export type Floor = { key: string; rate: number }

/**
 * How far above spot the charge curve may push the top of the frame, as a multiple of how far
 * the pay curve falls below it.
 *
 * The charge curve has an asymptote. `poolAmountIn` divides by `reserveOut − amountOut`, so a
 * sample near the pool's own reserve costs an unbounded amount, and one such sample used to set
 * the whole y axis. On the 10,000 tPLSX / 400 tUSDC pool a typed size of 4,000 put the top of
 * the frame at 96 times spot: the pay curve, the spot line, the queue ticks and the draft marker
 * all landed in the bottom one per cent of the plot, which is the information the panel exists
 * to show.
 *
 * The band is anchored at spot — the pay curve leaves it going down, the charge curve leaves it
 * going up, and at a small size the two are one fee apart in either direction. So the charge side
 * gets the room the pay side uses, and half again. That is wide enough to draw both curves whole
 * at any size a person types against a real pool, and bounded enough that the asymptote cannot
 * flatten the picture. Past it the charge curve runs off the top of the plot and says so.
 */
const CHARGE_HEADROOM = 1.5

/** One plotted size, with what the pool pays and what it charges at that size. */
export type CurvePoint = { x: number; pay: number | null; charge: number | null }

export type CurveFrame = {
  /** The widest size plotted, in display units of the token being sold. */
  xMax: number
  points: CurvePoint[]
  /** The pool's marginal rate. Null only when the pool holds nothing of one side. */
  spot: number | null
  /** The resting floors close enough to the pool to belong on the same axis. */
  nearby: Floor[]
  /** The y domain, padded. */
  yLo: number
  yHi: number
  /** True when a charge sample sits above `yHi`, so the plot has to show the line leaving. */
  clipped: boolean
}

/**
 * Everything the plot reads off one reserve snapshot: the x window, the two sampled curves, the
 * floors near enough to matter, and a y domain the asymptote cannot set.
 *
 * Pure on purpose. The whole defect lived in three lines of arithmetic between a reserve read and
 * a `viewBox`, and none of it was reachable from a test while it sat inside the render.
 */
export function signCurve({
  pool,
  tokenIn,
  decimalsIn,
  decimalsOut,
  sizeNum,
  samples,
  floors,
  floorRate,
  withCharge,
}: {
  pool: Pool
  /** The token the maker is selling. The curve is oriented into the pool from this side. */
  tokenIn: Address
  decimalsIn: number
  decimalsOut: number
  /** The typed size in display units, or 0 while the amount field is empty. */
  sizeNum: number
  /** How many points to sample across the window. */
  samples: number
  /** Every live floor on the pair. Only the ones near the pool reach the axis. */
  floors: readonly Floor[]
  /** The draft's own floor rate, or null while it is not a number yet. */
  floorRate: number | null
  /** The compact plot draws no charge curve, so it must not frame one either. */
  withCharge: boolean
}): CurveFrame {
  const spot = spotRate(pool, tokenIn, decimalsIn, decimalsOut)
  const reserveIn = reserveOf(pool, tokenIn)
  const depth = reserveIn ? asNumber(reserveIn, decimalsIn) : 0

  // The x window: wide enough to show the draft sitting on a curve, never wider than the pool.
  //
  // Two and a half times the typed size puts the marker at 40% of the plot. A floor of 5% of the
  // reserve keeps that rule from collapsing to a dust window the moment the first digit is typed
  // — the empty field already opens at that floor, and a valley between "nothing typed" and "one
  // wei typed" used to zoom the chart twenty-five times in a single keystroke. The ceiling is
  // three times the reserve: past it the charge curve is asymptotic and the picture says nothing.
  const xMax = Math.max(1e-9, Math.min(depth * 3, Math.max(sizeNum * 2.5, depth * 0.05)))
  const points: CurvePoint[] = []
  for (let i = 1; i <= samples; i++) {
    const x = (xMax * i) / samples
    const w = toWei(x, decimalsIn)
    points.push({
      x,
      pay: payRate(pool, tokenIn, w, decimalsIn, decimalsOut),
      charge: withCharge ? chargeRate(pool, tokenIn, w, decimalsOut, decimalsIn) : null,
    })
  }

  // Other floors only stretch the y axis when they are in the same neighbourhood as the pool.
  const nearby = spot ? floors.filter((f) => f.rate > spot * 0.5 && f.rate < spot * 1.6) : []

  // What the frame is for. Every one of these has to be legible at every size, so each one sets
  // the domain outright. The charge curve is the only series that gets a ceiling instead.
  const anchors = [
    ...points.map((p) => p.pay),
    spot,
    floorRate,
    ...nearby.map((f) => f.rate),
  ].filter((v): v is number => v !== null && isFinite(v))
  const lo = anchors.length > 0 ? Math.min(...anchors) : 0
  const hi = anchors.length > 0 ? Math.max(...anchors) : 1
  const pivot = spot ?? hi
  const ceiling = Math.max(hi, pivot + Math.max(pivot - lo, 0) * CHARGE_HEADROOM)

  const charges = points
    .map((p) => p.charge)
    .filter((v): v is number => v !== null && isFinite(v))
  const framed =
    charges.length > 0 ? [...anchors, Math.min(Math.max(...charges), ceiling)] : anchors
  const [yLo, yHi] = padRange(framed)
  return { xMax, points, spot, nearby, yLo, yHi, clipped: charges.some((v) => v > yHi) }
}

export function SignPreview({
  tokenIn,
  tokenOut,
  amountIn,
  minOut,
  minOutEnd,
  dutch,
  duration,
  fall = FULL_FALL,
  startsIn = 0,
  liveIn = 0,
  read: given,
  bare = false,
}: {
  tokenIn: TokenInfo | null
  tokenOut: TokenInfo | null
  amountIn: string
  minOut: string
  minOutEnd: string
  dutch: boolean
  /** The offer's window, in seconds. The decay strip's whole x axis. */
  duration: number
  /**
   * Where inside that window the price falls. Signed at the same moment as both rates, so the
   * strip draws the offer rather than a straight line the maker did not choose.
   */
  fall?: Fall
  /** Seconds from now until the offer opens. Zero is now, and now is the default. */
  startsIn?: number
  /**
   * Seconds from now until anybody can fill it: where the intent's window and the funding
   * signature's overlap. Never earlier than `startsIn`, and later whenever a 3009 authorization
   * opens after the offer does.
   */
  liveIn?: number
  /**
   * The pool read the page above already made, or absent to make one here.
   *
   * The sign form picks the price its offer opens at from the same snapshot this panel draws, so
   * it reads once and hands the result down. Null is a read still in flight, which is why absent
   * and null cannot mean the same thing here.
   */
  read?: PoolRead | null
  /** Drop the panel and its heading: a caller is drawing them, with the variant menu inside. */
  bare?: boolean
}) {
  const [floors, setFloors] = useState<Floor[]>([])
  const [box, width] = useMeasuredWidth<HTMLDivElement>()

  const inAddr = tokenIn ? marketAddress(tokenIn) : null
  const outAddr = tokenOut ? marketAddress(tokenOut) : null
  const twoTokens = !!inAddr && !!outAddr && inAddr.toLowerCase() !== outAddr.toLowerCase()

  // One read per pair, and only when nobody has already made it. The curve is local arithmetic
  // on what it returns.
  const own = usePoolRead(getChainId(), given === undefined ? tokenIn : null, given === undefined ? tokenOut : null)
  const read = given === undefined ? own : given

  // The queue this offer joins: every other floor resting on the same pair, same direction.
  const pairIn = tokenIn?.address.toLowerCase()
  const pairOut = tokenOut?.address.toLowerCase()
  useEffect(() => {
    setFloors([])
    if (!pairIn || !pairOut || pairIn === pairOut) return
    let stale = false
    queryIntents({
      chainId: getChainId(),
      pair: `${pairIn}>${pairOut}`,
      liveAt: Math.floor(Date.now() / 1000),
      limit: 40,
    })
      .then(({ rows }) => {
        if (!stale) setFloors(rows.filter((r) => r.rate > 0).map((r) => ({ key: r.key, rate: r.rate })))
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [pairIn, pairOut])

  const symIn = tokenIn ? displaySymbol(tokenIn) : ''
  const symOut = tokenOut ? displaySymbol(tokenOut) : ''
  const size = tokenIn ? safeParse(amountIn, tokenIn.decimals) : null
  const floorAmount = tokenOut ? safeParse(minOut, tokenOut.decimals) : null
  const endAmount = tokenOut ? safeParse(minOutEnd, tokenOut.decimals) : null

  // The pair, with its marks, at the start of the row — the same header `MarketPanel` draws when
  // it owns the chrome. Only the standalone panel uses this; on the sign page `bare` is set.
  const head = (
    <div className="flex min-w-0 items-center gap-2">
      <h3 className="sr-only">{t('chart.pool.label')}</h3>
      {twoTokens && tokenIn && tokenOut && (
        <>
          <PairAvatars tokenIn={tokenIn} tokenOut={tokenOut} size={18} />
          <span className="num truncate text-[12.5px] text-(--color-bright)">
            {symIn}/{symOut}
          </span>
        </>
      )}
    </div>
  )

  /** Every state this panel can be in wears the same box, so the form never jumps. */
  const shell = (children: ReactNode) =>
    bare ? (
      <div className="grid content-start gap-2">{children}</div>
    ) : (
      <aside
        className="panel-ink p-2 sm:p-4 grid gap-2 content-start"
        aria-label={t('chart.pool.label')}>
        {head}
        {children}
      </aside>
    )

  if (!twoTokens) {
    return shell(<p className="text-xs text-(--color-dim)">{t('chart.pool.pick')}</p>)
  }
  if (read === null) {
    return shell(<p className="text-xs text-(--color-dim)">{t('chart.pool.reading')}</p>)
  }
  const pool = read.state === 'pool' ? read.pool : null
  if (!pool || !tokenIn || !tokenOut || !inAddr || !outAddr || !poolHolds(pool, inAddr, outAddr)) {
    // A pair with no pool is the launch condition on a young chain, not a fault. Say which of the
    // four things is true rather than showing an empty frame — "no router here", "no pool for this
    // pair" and "the endpoint would not answer" are different facts, and none of them is "your
    // offer is bad".
    //
    // The `unreadable` branch is not decoration. Without it a rate-limited endpoint fell through
    // to "holds no liquidity", and the panel reported a fact about market structure that it had
    // no evidence for — a 429 dressed up as an empty pool.
    return shell(
      <>
        <p className="text-xs text-(--color-body)">{noCurveText(read.state, symIn, symOut)}</p>
        <p className="text-[11px] leading-relaxed text-(--color-dim)">{t('chart.pool.rest')}</p>
      </>,
    )
  }

  const decIn = tokenIn.decimals
  const decOut = tokenOut.decimals
  const sizeNum = size ? asNumber(size, decIn) : 0
  const pays = size ? poolPays(pool, inAddr, size) : null
  const floorRate =
    size && floorAmount ? asNumber(floorAmount, decOut) / asNumber(size, decIn) : null
  const fillsNow = pays !== null && floorAmount !== null && pays >= floorAmount
  const keptPct =
    pays !== null && floorAmount !== null && floorAmount > 0n
      ? (Number(pays - floorAmount) / Number(floorAmount)) * 100
      : null
  const abovePct =
    pays !== null && pays > 0n && floorAmount !== null
      ? (Number(floorAmount - pays) / Number(pays)) * 100
      : null
  const move = size ? movePct(pool, inAddr, size, decIn, decOut) : null

  const compact = width > 0 && width < COMPACT_AT
  const height = compact ? 132 : 188
  // The left pad holds a rate label, which on these pairs runs to seven characters.
  const pad = { l: compact ? 6 : 62, r: compact ? 6 : 14, t: 14, b: compact ? 12 : 22 }
  const plotW = Math.max(0, width - pad.l - pad.r)
  const plotH = height - pad.t - pad.b

  const samples = Math.max(12, Math.min(96, Math.round(plotW / 6)))
  const { xMax, points: curve, spot, nearby, yLo, yHi, clipped } = signCurve({
    pool,
    tokenIn: inAddr,
    decimalsIn: decIn,
    decimalsOut: decOut,
    sizeNum,
    samples,
    floors,
    floorRate,
    withCharge: !compact,
  })
  const X = lin(0, xMax, pad.l, pad.l + plotW)
  const Y = lin(yLo, yHi, pad.t + plotH, pad.t)

  /**
   * A curve as an SVG path.
   *
   * A point above the frame is drawn off the top of the picture, not flattened onto its edge.
   * Only the charge curve can get there, and a dashed line that ran along the top would read as a
   * rate the pool actually charges. Leaving through the top edge reads as what it is.
   */
  const OFF_TOP = -8
  const path = (key: 'pay' | 'charge') =>
    curve
      .filter((p) => p[key] !== null)
      .map(
        (p, i) =>
          `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Math.max(Y(p[key]!), OFF_TOP).toFixed(1)}`,
      )
      .join('')

  /**
   * The band between what the pool charges and what it pays — the round-trip cost at each size.
   *
   * A thin band is a deep pool; a wide one is impact. Filling it is what makes that reading
   * immediate: two bare lines leave the reader to invent the area, and the area is the depth.
   * Only samples that have both edges join the polygon, so a clipped charge that has left the
   * frame does not drag the fill off the top of the picture.
   */
  const ribbon = (() => {
    const both = curve.filter(
      (p): p is CurvePoint & { pay: number; charge: number } =>
        p.pay !== null && p.charge !== null && p.charge <= yHi,
    )
    if (both.length < 2) return null
    const top = both
      .map(
        (p, i) =>
          `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.charge).toFixed(1)}`,
      )
      .join('')
    const bottom = [...both]
      .reverse()
      .map((p) => `L${X(p.x).toFixed(1)},${Y(p.pay).toFixed(1)}`)
      .join('')
    return `${top}${bottom}Z`
  })()

  const last = curve[curve.length - 1]
  // Where to write the charge curve's name. Once the line leaves the frame, the right edge is
  // empty space, so the label follows the line to the last size where it was still visible.
  const chargeLabel = clipped
    ? [...curve].reverse().find((p) => p.charge !== null && p.charge <= yHi)
    : last
  const payAtSize = size ? payRate(pool, inAddr, size, decIn, decOut) : null
  const markerY = floorRate === null ? null : Math.min(Math.max(Y(floorRate), pad.t), pad.t + plotH)
  const markerX = sizeNum > 0 ? X(Math.min(sizeNum, xMax)) : null
  const grid = compact ? [yLo + (yHi - yLo) / 2] : [0.2, 0.5, 0.8].map((f) => yLo + (yHi - yLo) * f)

  const verdict =
    pays === null || floorAmount === null
      ? t('chart.verdict.none')
      : fillsNow
        ? t('chart.verdict.fills', { pct: pctText(keptPct ?? 0) })
        : t('chart.verdict.rests', {
            pct: fixed(abovePct ?? 0, abovePct !== null && abovePct < 10 ? 1 : 0),
          })

  /**
   * The detail, joined into one paragraph behind the info icon.
   *
   * Order is by how often it changes what you would do: your own impact first, then the queue you
   * are joining, then where the numbers came from. The pair and block always appear — a curve
   * drawn from a snapshot is only as good as the snapshot, and that has to stay checkable.
   */
  const detail = [
    move !== null && sizeNum > 0
      ? `${t('chart.move', {
          size: sizeText(sizeNum),
          symbol: symIn,
          pct: fixed(move, move < 10 ? 1 : 0),
        })} — ${t('chart.move.tip')}`
      : null,
    // Only when the ticks are drawn. The sentence names them, so it is wrong without them.
    nearby.length > 0 && !compact
      ? tCount('chart.floors', nearby.length)
      : null,
    poolSource(pool),
  ]
    .filter((line): line is string => line !== null)
    .join(' · ')

  return shell(
    <>
      {/*
        `min-w-0`: this is a grid item, and a grid item's automatic minimum size is its content's
        min-content width. Without it the SVG from the last wide layout holds the column open and
        the observer never sees a smaller box to report.
      */}
      <div ref={box} className="w-full min-w-0 overflow-hidden">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="chart"
            role="img"
            aria-label={t('chart.pool.figure', { in: symIn, out: symOut, verdict })}>
            {grid.map((v) => (
              <g key={v}>
                <line
                  x1={pad.l}
                  x2={pad.l + plotW}
                  y1={Y(v)}
                  y2={Y(v)}
                  style={{ stroke: C.line }}
                />
                {/*
                  A tick label is dropped when the spot label is sitting on the same line. The two
                  are set at opposite ends of the axis — tick in the gutter, spot just inside the
                  plot — so on a pair whose spot lands near a gridline they ran together and read
                  as one number — `5.051 spot 5.038`. The gridline stays; only its label goes, and
                  it was telling the reader nothing that the spot label a quarter of a percent away
                  was not already saying. The threshold tracks the spot readout's clearance above
                  its own dashed line (see below).
                */}
                {!compact && !(spot !== null && Math.abs(Y(v) - Y(spot)) < 16) && (
                  <text
                    x={pad.l - 6}
                    y={Y(v) + 3}
                    textAnchor="end"
                    fontSize={10}
                    className="num"
                    style={{ fill: C.dim }}>
                    {tickText(v)}
                  </text>
                )}
              </g>
            ))}

            {spot !== null && spot > yLo && spot < yHi && (
              <line
                x1={pad.l}
                x2={pad.l + plotW}
                y1={Y(spot)}
                y2={Y(spot)}
                strokeDasharray="2 5"
                style={{ stroke: C.dim }}
              />
            )}

            {/* Depth as a band: everything between the two pool rates at each size. */}
            {!compact && ribbon && (
              <path d={ribbon} style={{ fill: C.pool, opacity: 0.1 }} />
            )}
            {!compact && (
              <path d={path('charge')} fill="none" strokeDasharray="6 4" style={{ stroke: C.pool, strokeWidth: 1.5, opacity: 0.6 }} />
            )}
            <path d={path('pay')} fill="none" style={{ stroke: C.pool, strokeWidth: 2 }} />

            {/*
              Spot readout sits above its dashed line and is painted after the curves.

              Both pool lines meet at zero size on the spot rate, so they used to draw straight
              through `spot 5.064` when the label was emitted before the paths. Seven pixels of
              clearance was also not enough: the dashed line skimmed the descenders and read as
              one mark. Twelve pixels lifts the baseline clear, and an ink stroke behind the
              glyphs (same knockout the draft marker uses) keeps any residual dash or curve from
              showing through the letters. The label stays off the compact plot — there the line
              alone is the readout.
            */}
            {!compact && spot !== null && spot > yLo && spot < yHi && (
              <text
                x={pad.l + 6}
                y={Y(spot) - 12}
                fontSize={10}
                style={{
                  fill: C.dim,
                  stroke: C.ink,
                  strokeWidth: 4,
                  paintOrder: 'stroke',
                }}>
                {t('chart.spot', { rate: tickText(spot) })}
              </text>
            )}

            {/* Which line is which. The two curves meet at zero size, so the names go on the
                right, where the fee and the impact have pulled them apart. */}
            {!compact && last?.pay != null && (
              <text
                x={pad.l + plotW}
                y={Y(last.pay) + 12}
                textAnchor="end"
                fontSize={10}
                style={{ fill: C.dim }}>
                {t('chart.pays')}
              </text>
            )}
            {!compact && chargeLabel?.charge != null && (
              <text
                x={Math.min(X(chargeLabel.x), pad.l + plotW)}
                y={Y(chargeLabel.charge) - 5}
                textAnchor="end"
                fontSize={10}
                style={{ fill: C.dim }}>
                {t('chart.charges')}
              </text>
            )}

            {/* The queue: every other live floor on this pair, as a tick against the same axis. */}
            {!compact &&
              nearby.map((f) => (
                <line
                  key={f.key}
                  x1={pad.l + plotW - 12}
                  x2={pad.l + plotW}
                  y1={Y(f.rate)}
                  y2={Y(f.rate)}
                  style={{ stroke: C.dim, strokeWidth: 1.5, opacity: 0.8 }}
                />
              ))}

            {markerX !== null && markerY !== null && (
              <>
                {payAtSize !== null && (
                  <line
                    x1={markerX}
                    x2={markerX}
                    y1={markerY}
                    y2={Y(payAtSize)}
                    strokeDasharray="2 3"
                    style={{ stroke: fillsNow ? C.good : C.bad, strokeWidth: 1.5 }}
                  />
                )}
                <circle cx={markerX} cy={markerY} r={6.5} style={{ fill: C.ink }} />
                <circle
                  cx={markerX}
                  cy={markerY}
                  r={4.5}
                  style={{
                    fill: fillsNow ? C.good : 'transparent',
                    stroke: fillsNow ? C.good : C.bad,
                    strokeWidth: 1.6,
                  }}
                />
                {!compact && keptPct !== null && (
                  <text
                    x={Math.min(markerX + 10, pad.l + plotW - 4)}
                    y={markerY - 8}
                    fontSize={10}
                    className="num"
                    textAnchor={markerX > pad.l + plotW - 60 ? 'end' : 'start'}
                    style={{ fill: fillsNow ? C.good : C.bad }}>
                    {pctText(keptPct)}
                  </text>
                )}
              </>
            )}

            {!compact && (
              <>
                <text x={pad.l} y={height - 4} fontSize={10} className="num" style={{ fill: C.dim }}>
                  0
                </text>
                <text
                  x={pad.l + plotW}
                  y={height - 4}
                  fontSize={10}
                  textAnchor="end"
                  className="num"
                  style={{ fill: C.dim }}>
                  {sizeText(xMax)} {symIn}
                </text>
              </>
            )}
          </svg>
        )}
      </div>

      {/*
        The verdict, and everything else behind an icon.

        Three more paragraphs used to sit here: how far the draft moves the pool, how many other
        floors rest on the pair, and which pair contract and block the curve was computed from.
        All three are worth having and none is worth reading on every keystroke, under a chart
        that is already the answer. `relative` is load-bearing — the tip body spans its nearest
        positioned ancestor, which keeps it on screen at 375px.
      */}
      <div className="relative flex items-start justify-between gap-2">
        <p
          className={`text-xs ${
            pays === null || floorAmount === null
              ? 'text-(--color-dim)'
              : fillsNow
                ? 'text-(--color-proven)'
                : 'text-(--color-unproven)'
          }`}>
          {verdict}
        </p>
        <InfoTip tip={detail} />
      </div>

      {dutch && (
        <DecayStrip
          startRate={floorRate}
          endRate={
            size && endAmount ? asNumber(endAmount, decOut) / asNumber(size, decIn) : null
          }
          poolRate={payAtSize}
          duration={duration}
          fall={fall}
          startsIn={startsIn}
          liveIn={Math.max(liveIn, startsIn)}
        />
      )}

    </>,
  )
}

/**
 * The decaying floor against the clock. The pool's rate for this size is flat here on purpose:
 * this draws the maker's own schedule, not a forecast of the market. Where the two meet is the
 * first moment the offer becomes fillable if nothing else changes.
 *
 * A scheduled offer draws a flat run-in before the fall. It is not decaying while it waits, and
 * drawing it as though it were would show a maker a price nobody will ever be offered.
 */
function DecayStrip({
  startRate,
  endRate,
  poolRate,
  duration,
  fall,
  startsIn,
  liveIn,
}: {
  startRate: number | null
  endRate: number | null
  poolRate: number | null
  duration: number
  /**
   * The signed shape. It is not the same kind of number as `poolRate`, which is live, and the two
   * sit in the same picture — the dashed line is what the maker signed, the solid one is what the
   * pool pays right now. Keep them apart in the head as well as on the screen.
   */
  fall: Fall
  startsIn: number
  liveIn: number
}) {
  const [box, width] = useMeasuredWidth<HTMLDivElement>()

  if (startRate === null || endRate === null || poolRate === null) {
    return (
      <p className="text-[11px] text-(--color-dim)">{t('chart.decay.none')}</p>
    )
  }

  const shape = decayShape({ startRate, endRate, poolRate, duration, fall, startsIn, liveIn })
  const height = 78
  const pad = { l: 6, r: 6, t: 10, b: 16 }
  const plotW = Math.max(0, width - pad.l - pad.r)
  const plotH = height - pad.t - pad.b
  const [yLo, yHi] = padRange([startRate, endRate, poolRate], 0.12)
  const X = lin(0, shape.axis, pad.l, pad.l + plotW)
  const Y = lin(yLo, yHi, pad.t + plotH, pad.t)

  /*
   * What the strip says, and the order matters.
   *
   * "Fillable from the start" is a claim about now, so an offer that opens in three hours must
   * not make it. The three scheduled answers come first: never, opens-and-fills-at-once, and
   * crosses-at-a-time — and the last of those is the existing sentence, reused, because the time
   * it names is measured from now either way.
   */
  const note = !shape.fillable
    ? t('chart.decay.never')
    : shape.live > 0 && (shape.cross ?? 0) <= shape.live
      ? t('chart.decay.opens', { time: minutesText(shape.live) })
      : (shape.cross ?? 0) <= 0
        ? t('chart.decay.now')
        : t('chart.decay.crosses', { time: minutesText(shape.cross ?? 0) })

  const fillsNow = shape.fillable && (shape.cross ?? 0) <= 0

  return (
    <>
      {/*
        `min-w-0`: this is a grid item, and a grid item's automatic minimum size is its content's
        min-content width. Without it the SVG from the last wide layout holds the column open and
        the observer never sees a smaller box to report.
      */}
      <div ref={box} className="w-full min-w-0 overflow-hidden">
        {width > 0 && (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className="chart"
            role="img"
            aria-label={t('chart.decay.figure', { time: minutesText(shape.axis), note })}>
            {/*
              The dead lead-in: every minute before the first fill can land. Drawn as ground
              rather than as a line, because it is a region and not an event.
            */}
            {shape.live > 0 && (
              <rect
                x={pad.l}
                y={pad.t}
                // Clamped to the plot. A schedule whose first fillable second falls past the
                // offer's end is drawn as ground across the whole strip, not as a rectangle
                // running out of the frame.
                width={Math.min(plotW, Math.max(0, X(shape.live) - pad.l))}
                height={plotH}
                style={{ fill: C.dim, opacity: 0.1 }}
              />
            )}
            <line
              x1={pad.l}
              x2={pad.l + plotW}
              y1={Y(poolRate)}
              y2={Y(poolRate)}
              style={{ stroke: C.pool, strokeWidth: 1.5 }}
            />
            {/*
              The maker's own schedule: flat until the offer opens, flat again until the fall
              begins, falling across the stretch, then flat at the floor to the close.

              Every corner comes from `decayRateAt`, so the picture cannot say one thing while the
              arithmetic says another. A stretch needs three points and the strip used to draw two,
              which would have shown a maker a fall they did not sign — the worst bug available
              here, because they put their name to what they see.
            */}
            <polyline
              points={decayBreaks(shape)
                .map((at) => `${X(at)},${Y(decayRateAt(shape, startRate, endRate, at))}`)
                .join(' ')}
              fill="none"
              strokeDasharray="5 3"
              style={{ stroke: C.warn, strokeWidth: 2 }}
            />
            {shape.open > 0 && (
              <line
                x1={X(shape.open)}
                x2={X(shape.open)}
                y1={pad.t}
                y2={pad.t + plotH}
                style={{ stroke: C.edge, strokeWidth: 1 }}
              />
            )}
            {shape.cross !== null && shape.cross > 0 && (
              <circle
                cx={X(shape.cross)}
                cy={Y(poolRate)}
                r={4}
                style={{ fill: C.ink, stroke: C.warn, strokeWidth: 1.8 }}
              />
            )}
            <text x={pad.l} y={height - 4} fontSize={10} className="num" style={{ fill: C.dim }}>
              {t('chart.now')}
            </text>
            {shape.open > 0 && (
              <text
                x={X(shape.open)}
                y={height - 4}
                fontSize={10}
                textAnchor="middle"
                className="num"
                style={{ fill: C.dim }}>
                {t('chart.decay.open')}
              </text>
            )}
            <text
              x={pad.l + plotW}
              y={height - 4}
              fontSize={10}
              textAnchor="end"
              className="num"
              style={{ fill: C.dim }}>
              +{minutesText(shape.axis)}
            </text>
          </svg>
        )}
      </div>
      <p className={`text-[11px] ${fillsNow ? 'text-(--color-proven)' : 'text-(--color-unproven)'}`}>
        {note}
      </p>
    </>
  )
}

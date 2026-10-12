import { parseUnits } from 'viem'
import { isolate, t, tCount } from '../../lib/i18n'
import { asNumber, payRate, type Pool, type Walk, type WalkStep } from '../../lib/pool'
import { lin, padRange, poolSource, rateText, sizeText } from './chart'
import { useMeasuredWidth } from './useMeasuredWidth'

/**
 * The batch walking the pool.
 *
 * A board row's edge is quoted as if that row were the only trade in the world. Filling several
 * moves the pool under each one, so the second row never gets the rate the table promised it.
 * This draws that: cumulative size along the curve, the rate each fill actually executed at, and
 * the running net underneath. Where the dots fall away from the curve is the cost of filling one
 * at a time rather than as a single unwind.
 *
 * The tray is a fixed overlay, so the plot is capped in height and scrolls sideways inside its
 * own container. The page body never scrolls with it.
 */

const C = {
  pool: 'var(--color-body)',
  dim: 'var(--color-dim)',
  line: 'var(--color-line)',
  edge: 'var(--color-line-bright)',
  bright: 'var(--color-bright)',
  good: 'var(--color-proven)',
  bad: 'var(--color-danger)',
  ink: 'var(--color-ink)',
}

const HEIGHT = 138
/** Every step needs this much x to stay readable; past that the plot scrolls. */
const MIN_PER_STEP = 46

/** The group with the most fills, and the token most of its volume is denominated in. */
function dominant(walk: Walk): { pair: string; steps: WalkStep[] } | null {
  const groups = new Map<string, WalkStep[]>()
  for (const s of walk.steps) {
    const g = groups.get(s.pair)
    if (g) g.push(s)
    else groups.set(s.pair, [s])
  }
  let best: { pair: string; steps: WalkStep[] } | null = null
  for (const [pair, steps] of groups) {
    if (!best || steps.length > best.steps.length) best = { pair, steps }
  }
  return best
}

export function BatchWalk({ walk, pools }: { walk: Walk; pools: ReadonlyMap<string, Pool> }) {
  const [box, width] = useMeasuredWidth<HTMLDivElement>()
  const group = dominant(walk)
  const pool = group ? pools.get(group.pair) : undefined
  if (!group || !pool) return null

  // The walk's own axis is the token the batch actually sells into this pool.
  const sold = new Map<string, bigint>()
  for (const s of group.steps) {
    if (s.sold > 0n) sold.set(s.fill.symbolIn, (sold.get(s.fill.symbolIn) ?? 0n) + s.sold)
  }
  let walkSymbol: string | null = null
  for (const [symbol, amount] of sold) {
    if (!walkSymbol || amount > (sold.get(walkSymbol) ?? 0n)) walkSymbol = symbol
  }
  const onCurve = group.steps.filter((s) => s.sold > 0n && s.fill.symbolIn === walkSymbol && s.rate !== null)
  if (onCurve.length === 0 || !walkSymbol) return null

  const first = onCurve[0].fill
  const decIn = first.decimalsIn
  const decOut = first.decimalsOut
  const totalIn = onCurve.reduce((sum, s) => sum + s.sold, 0n)
  const totalNum = asNumber(totalIn, decIn)

  const inner = Math.max(width, MIN_PER_STEP * group.steps.length + 140)
  const pad = { l: 54, r: 12, t: 12, b: 16 }
  const netBand = 34
  const plotW = Math.max(0, inner - pad.l - pad.r)
  const plotH = HEIGHT - pad.t - pad.b - netBand - 8

  // The reference curve: what one trade of that cumulative size would have averaged. The dots
  // sit under it because each fill pays the fee on its own leg.
  const xMax = totalNum * 1.12
  const samples = Math.max(10, Math.min(80, Math.round(plotW / 8)))
  const curve: { x: number; rate: number }[] = []
  for (let i = 1; i <= samples; i++) {
    const x = (xMax * i) / samples
    const rate = payRate(pool, first.tokenIn, parseUnits(x.toFixed(Math.min(decIn, 8)), decIn), decIn, decOut)
    if (rate !== null) curve.push({ x, rate })
  }

  const rates = [...curve.map((p) => p.rate), ...onCurve.map((s) => s.rate!)]
  const [yLo, yHi] = padRange(rates, 0.1)
  const X = lin(0, xMax, pad.l, pad.l + plotW)
  const Y = lin(yLo, yHi, pad.t + plotH, pad.t)

  // The net band carries one unit. A batch that trades both ways nets in two tokens, and the
  // band follows the one the walk's own proceeds land in; the tray states both totals in text.
  const netSymbol = first.symbolOut
  const netSteps = group.steps.filter((s) => s.fill.symbolOut === netSymbol)
  const otherWay = group.steps.length - netSteps.length
  const netTop = pad.t + plotH + 8
  const nets = netSteps.map((s) => asNumber(s.cumulativeNet, s.fill.decimalsOut))
  /** How many earlier fills share this fill's cumulative size, so its bar can step aside. */
  const shift = netSteps.map((s, i) =>
    netSteps.slice(0, i).filter((e) => e.cumulativeIn === s.cumulativeIn).length,
  )
  const netHi = Math.max(0, ...nets)
  const netLo = Math.min(0, ...nets)
  const N = lin(netLo, netHi, netTop + netBand, netTop)
  const zero = netHi === netLo ? netTop + netBand : N(0)

  const curvePath = curve.map((p, i) => `${i ? 'L' : 'M'}${X(p.x).toFixed(1)},${Y(p.rate).toFixed(1)}`).join('')
  const finalNet = nets[nets.length - 1] ?? 0
  // A minus sign, not a hyphen, and the sign is part of the figure rather than of the sentence.
  const netText = `${finalNet >= 0 ? '+' : '−'}${Math.abs(finalNet).toFixed(4)}`

  return (
    <div className="basis-full grid gap-1">
      <div ref={box} className="scroll-x">
        <svg
          width={inner}
          height={HEIGHT}
          viewBox={`0 0 ${inner} ${HEIGHT}`}
          className="chart"
          role="img"
          aria-label={t('chart.walk.figure', {
            symbol: walkSymbol,
            fills: group.steps.length,
            size: sizeText(totalNum),
            net: finalNet.toFixed(4),
            netSymbol,
          })}>
          {[yLo + (yHi - yLo) * 0.25, yLo + (yHi - yLo) * 0.75].map((v) => (
            <g key={v}>
              <line x1={pad.l} x2={pad.l + plotW} y1={Y(v)} y2={Y(v)} style={{ stroke: C.line }} />
              <text x={pad.l - 6} y={Y(v) + 3} fontSize={10} textAnchor="end" className="num" style={{ fill: C.dim }}>
                {rateText(v)}
              </text>
            </g>
          ))}
          <path d={curvePath} fill="none" style={{ stroke: C.pool, strokeWidth: 1.8, opacity: 0.75 }} />

          {/* Each fill, at the size the batch had reached and the rate it actually got. */}
          {onCurve.map((s, i) => {
            const cx = X(asNumber(s.cumulativeIn, decIn))
            const cy = Y(s.rate!)
            const good = s.net > 0n
            return (
              <g key={s.fill.key}>
                <line x1={cx} x2={cx} y1={pad.t} y2={pad.t + plotH} style={{ stroke: C.line }} />
                <circle cx={cx} cy={cy} r={5.5} style={{ fill: C.ink }} />
                <circle
                  cx={cx}
                  cy={cy}
                  r={3.8}
                  style={{ fill: good ? C.good : 'transparent', stroke: good ? C.good : C.bad, strokeWidth: 1.6 }}
                />
                <text x={cx} y={pad.t - 2} fontSize={10} textAnchor="middle" className="num" style={{ fill: C.dim }}>
                  {i + 1}
                </text>
              </g>
            )
          })}

          {/* The running net, on its own baseline. Below the line is a batch that costs money. */}
          <line x1={pad.l} x2={pad.l + plotW} y1={zero} y2={zero} style={{ stroke: C.edge }} />
          <text x={pad.l - 6} y={zero + 3} fontSize={10} textAnchor="end" className="num" style={{ fill: C.dim }}>
            0
          </text>
          {netSteps.map((s, i) => {
            // A fill the batch settled against an opposing row moves no size, so its bar would
            // land on the one before it. Nudging keeps every fill visible without pretending it
            // touched the pool.
            const cx = X(asNumber(s.cumulativeIn, decIn)) + 11 * shift[i]
            const v = nets[i]
            const y = N(v)
            return (
              <rect
                key={`net-${s.fill.key}`}
                x={cx - 5}
                y={Math.min(y, zero)}
                width={10}
                height={Math.max(1.5, Math.abs(y - zero))}
                style={{ fill: v >= 0 ? C.good : C.bad, opacity: 0.75 }}
              />
            )
          })}
          <text
            x={pad.l + plotW}
            y={netTop + netBand + 12}
            fontSize={10}
            textAnchor="end"
            className="num"
            style={{ fill: finalNet >= 0 ? C.good : C.bad }}>
            {t('chart.walk.net', { amount: netText, symbol: netSymbol })}
          </text>
          {/* Two captions on one baseline collide under about 480px, and the net is the one that
              has to survive. */}
          {inner >= 480 && (
            <text x={pad.l} y={netTop + netBand + 12} fontSize={10} className="num" style={{ fill: C.dim }}>
              {/*
                Each clause picks its own direction, and the separator between them belongs to
                neither. `.chart` pins `direction: ltr` on the svg so the axes never mirror, which
                also lays an Arabic caption out in an LTR paragraph — and the `·` that used to
                open `chart.walk.other` then landed between the two FIGURES rather than between
                the two clauses. There is no `<bdi>` inside an SVG `<text>`, so the isolate
                travels in the string.
              */}
              {isolate(t('chart.walk.caption', { size: sizeText(totalNum), symbol: walkSymbol }))}
              {otherWay > 0 &&
                ` · ${isolate(
                  tCount('chart.walk.rest', otherWay, {
                    symbol: group.steps.find((s) => s.fill.symbolOut !== netSymbol)!.fill
                      .symbolOut,
                  }),
                )}`}
            </text>
          )}
        </svg>
      </div>
      <p className="num text-[10px] text-(--color-dim) break-words">{poolSource(pool)}</p>
    </div>
  )
}

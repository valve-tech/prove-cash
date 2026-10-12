import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { TokenUnit } from '../components/TokenAvatar.tsx'
import { t } from '../lib/i18n.ts'
import { Cost, Tip } from './bits.tsx'
import { amount, at, floorAt, frame, money, scene, type Scene } from './market.ts'
import { SAMPLED, type PriceToken } from './prices.ts'

/**
 * One signed intent, drawn against a real market, and the moment the two meet.
 *
 * The chart draws itself left to right, an hour at a time, because that is the only honest way to
 * show a price: nobody knows tomorrow's. What you watch is a floor resting above a market that
 * has not reached it yet.
 *
 * The two lines swap colour at the crossing, and that swap is the whole idea. Green is what you
 * hold. Before the fill you hold the offered token at a rate you fixed, so green is the straight
 * line and the market wanders past it in grey. At the crossing an executor takes the offer, and
 * from that hour on you hold the other token — so green picks up the market and the rate you
 * signed carries on as a flat grey line, settled and going nowhere.
 *
 * The prices are real. The offer over them is not, and the card says so.
 */

/**
 * The chain the card's faces are asked for.
 *
 * Not the reader's selected chain, and that is the point: `prices.ts` holds real Ethereum
 * mainnet tokens, so WETH's face lives on chain 1 whatever network the visitor is browsing.
 */
const MAINNET = 1

/** Drawn once per load: which pair, which way round, which two days. See `market.ts`. */
const SWEEP_MS = 11_000
const HOLD_MS = 2_600

// The plot. Hours run left to right across the full width; the value runs between these two.
// Tall enough for the real hourly texture to survive: at 44px of plot the walk flattened into a
// smudge and the whole point of using real prices was lost.
const W = 320
const H = 88
const TOP = 10
const BOT = 78

/**
 * The replay: a scene, and how far through drawing it we are.
 *
 * A new scene every loop — a different pair, a different direction, a different two days of real
 * prices, and the amounts that follow from them. One scene on repeat is a video, and after the
 * second pass a reader can see it is a video; the whole claim of the card is that this is a
 * market, and a market does not play the same forty-eight hours again.
 *
 * The swap happens at the cycle boundary, never mid-sweep. At that instant the reveal is back to
 * zero and the plot is empty, so nothing on screen changes under the reader's eye — the next pair
 * simply draws itself in from the left, the way the last one did.
 *
 * Reduced motion gets one scene, fully drawn, and keeps it. The line is the information, and a
 * still frame half-drawn would be a chart of nothing.
 */
function useReplay(): { s: Scene; p: number } {
  const [s, setS] = useState(scene)
  const [p, setP] = useState(1)
  const frameRef = useRef(0)

  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const t0 = performance.now()
    const period = SWEEP_MS + HOLD_MS
    let drawn = 0
    const tick = () => {
      const elapsed = performance.now() - t0
      const cycle = Math.floor(elapsed / period)
      if (cycle !== drawn) {
        drawn = cycle
        setS(scene())
      }
      setP(Math.min(1, (elapsed % period) / SWEEP_MS))
      frameRef.current = requestAnimationFrame(tick)
    }
    frameRef.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameRef.current)
  }, [])

  return { s, p }
}

function Row({
  label,
  qualifier,
  value,
  token,
  accent,
}: {
  label: string
  qualifier?: string
  value: string
  /** The token the figure counts, drawn as its face and its symbol. Absent on rows naming none. */
  token?: PriceToken
  accent?: boolean
}) {
  return (
    <div className="col-span-2 grid grid-cols-subgrid items-baseline py-1.5">
      <dt className="num text-[11px] tracking-wider text-(--color-dim) uppercase">{label}</dt>
      <dd className="flex min-w-0 items-baseline justify-between gap-2">
        <span
          className={`num text-[11px] tracking-wider ${
            accent ? 'text-(--color-proven)' : 'text-(--color-dim)'
          }`}>
          {qualifier}
        </span>
        <span className="num flex min-w-0 items-center gap-1.5 text-sm text-(--color-bright)">
          <span className="truncate">{value}</span>
          {token && (
            <TokenUnit token={token} chainId={MAINNET} className="shrink-0 text-(--color-dim)" />
          )}
        </span>
      </dd>
    </div>
  )
}

/** A short rule in a line's own colour, so the legend names the line rather than describing it. */
function Key({ colour, dim, children }: { colour: string; dim?: boolean; children: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="block h-px w-3.5 shrink-0"
        style={{ background: colour, opacity: dim ? 0.55 : 1 }}
      />
      <span className={dim ? 'text-(--color-dim)' : 'text-(--color-body)'}>{children}</span>
    </span>
  )
}

/** Everything about the scene that does not change as the chart draws. */
function geometry(s: Scene) {
  const last = s.hours - 1
  const floor = Array.from({ length: s.hours }, (_, i) => floorAt(s, i))
  const [lo, hi] = frame([...s.market, ...floor])
  const x = (i: number) => (i / last) * W
  const y = (v: number) => BOT - ((v - lo) / (hi - lo)) * (BOT - TOP)

  const line = (vs: readonly number[], from: number, to: number) => {
    const pts: string[] = []
    for (let i = from; i <= to; i++) pts.push(`${x(i).toFixed(1)} ${y(vs[i]!).toFixed(2)}`)
    return `M ${pts.join(' L ')}`
  }

  const settled = floor[s.fill]!
  return {
    x,
    y,
    floor,
    // Before the crossing: your floor is the straight line, the market wanders.
    floorPre: line(floor, 0, s.fill),
    marketPre: line(s.market, 0, s.fill),
    // After it: you hold the other token, so the market is yours and the rate you signed is done.
    marketPost: line(s.market, s.fill, last),
    settledPath: `M ${x(s.fill).toFixed(1)} ${y(settled).toFixed(2)} L ${W} ${y(settled).toFixed(2)}`,
    settled,
    fillX: x(s.fill),
    fillY: y(settled),
  }
}

function Chart({ s, p }: { s: Scene; p: number }) {
  const clip = useId().replace(/:/g, '')
  const g = useMemo(() => geometry(s), [s])

  const last = s.hours - 1
  const hour = p * last
  const filled = hour >= s.fill
  // The marker rides the green line: your floor until the fill, what you hold after it.
  const markerY = filled ? g.y(at(s.market, hour)) : g.y(floorAt(s, hour))
  const markerX = g.x(hour)

  const rate = at(s.market, hour) / s.size
  const shown = filled ? g.settled : floorAt(s, hour)

  return (
    <figure className="mt-4 grid gap-1.5">
      <div className="relative flex items-baseline justify-between gap-3 text-[11px]">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5">
          <Key colour="var(--color-proven)">
            {t(filled ? 'landing.card.hold' : 'landing.card.floor')}
          </Key>
          <Key colour="var(--color-body)" dim>
            {t(filled ? 'landing.card.settled' : 'landing.card.market')}
          </Key>
        </div>
        {/*
          An expression, not a figure and its unit. Under `dir=rtl` the bidi algorithm moves the
          leading `48` to the far end and prints `H · REAL 48`, so `.ltr` holds it in order.
        */}
        <span className="num shrink-0 tracking-wider text-(--color-dim) uppercase">
          <Tip
            label={<span className="ltr">{`${s.hours} h · real`}</span>}
            tip={`Real hourly ${s.from.symbol}/${s.to.symbol} prices from the week of ${SAMPLED}, drawn as they came in. The offer over them is an example.`}
          />
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={t('landing.card.chart', {
          floor: money(floorAt(s, 0)),
          from: s.from.symbol,
          to: s.to.symbol,
          hours: s.hours,
          hour: s.fill,
          price: money(g.settled),
        })}>
        <defs>
          {/* The reveal. Everything is drawn once and this rect uncovers it hour by hour, which
              costs one attribute a frame rather than four rebuilt path strings. */}
          <clipPath id={clip}>
            <rect x="0" y="0" width={(p * W).toFixed(1)} height={H} />
          </clipPath>
        </defs>

        <g clipPath={`url(#${clip})`}>
          <path d={g.marketPre} stroke="var(--color-body)" strokeWidth="1" fill="none" opacity={0.5} />
          <path d={g.settledPath} stroke="var(--color-body)" strokeWidth="1" fill="none" opacity={0.5} strokeDasharray="2 3" />
          <path d={g.floorPre} stroke="var(--color-proven)" strokeWidth="1.5" fill="none" />
          <path d={g.marketPost} stroke="var(--color-proven)" strokeWidth="1.5" fill="none" />

          {/* The handover, marked on the axis it happened on. */}
          <line
            x1={g.fillX.toFixed(1)}
            x2={g.fillX.toFixed(1)}
            y1={TOP - 4}
            y2={BOT + 4}
            stroke="var(--color-line-bright)"
            strokeWidth="1"
            strokeDasharray="1 3"
          />
        </g>

        {filled && (
          <circle
            cx={g.fillX.toFixed(1)}
            cy={g.fillY.toFixed(2)}
            r={5}
            fill="none"
            stroke="var(--color-proven)"
            strokeWidth="1.5"
            className="lp-fill"
          />
        )}

        <circle
          cx={markerX.toFixed(1)}
          cy={markerY.toFixed(2)}
          r="3.5"
          fill="var(--color-ink)"
          stroke="var(--color-proven)"
          strokeWidth="1.5"
        />
      </svg>

      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span
          className={`num text-[11px] tracking-wider uppercase ${
            filled ? 'text-(--color-proven)' : 'text-(--color-dim)'
          }`}>
          {filled
            ? t('landing.card.filledAtHour', { hour: s.fill, price: money(g.settled) })
            : t('landing.card.resting', { floor: money(shown) })}
        </span>
        {/*
          The rate, written the way the board writes one: the figure in `.num`, the unit as a face
          beside its symbol. The leading one is a figure too, so it goes through `amount` — a Latin
          `1` against Arabic-Indic decimals is two numbering systems in one expression.

          The whole of it is one `.ltr` run, because `1 WETH = 3.21 USDC` read the other way round
          is a different price. It is `aria-hidden`, and the sentence beside it is what a screen
          reader hears: a face reads aloud as nothing at all.
        */}
        <span className="num text-[11px] text-(--color-body)">
          <span aria-hidden="true" className="ltr inline-flex flex-wrap items-center gap-x-1">
            <span>{amount(1)}</span>
            <TokenUnit token={s.from} chainId={MAINNET} className="text-(--color-dim)" />
            <span className="text-(--color-dim)">=</span>
            <span>{money(rate)}</span>
            <TokenUnit token={s.to} chainId={MAINNET} className="text-(--color-dim)" />
          </span>
          <span className="sr-only">
            {t('landing.card.rate', { from: s.from.symbol, rate: money(rate), to: s.to.symbol })}
          </span>
        </span>
      </div>

      <figcaption className="mt-1 text-[13px] leading-relaxed text-(--color-dim)">
        {filled
          ? t('landing.card.caption.filled', { symbol: s.to.symbol })
          : t('landing.card.caption.resting')}
      </figcaption>
    </figure>
  )
}

export function IntentCard() {
  const { s, p } = useReplay()

  const filled = p * (s.hours - 1) >= s.fill
  const floorNow = filled ? floorAt(s, s.fill) : floorAt(s, p * (s.hours - 1))

  return (
    <div className="panel p-2 sm:p-4">
      <h2 className="sr-only">
        {t('landing.card.heading', { from: s.from.symbol, to: s.to.symbol })}
      </h2>
      <div className="rule-b flex items-baseline justify-between gap-3 pb-3">
        <span className="num text-[11px] tracking-[0.22em] text-(--color-body) uppercase">
          {t('landing.card.eyebrow')}
        </span>
        <span className="num text-[11px] tracking-wider text-(--color-dim) uppercase">
          {t('landing.card.example')}
        </span>
      </div>

      {/* The rules between rows are outset shadows, so they take no layout height. */}
      <dl className="grid grid-cols-[minmax(4.25rem,max-content)_minmax(0,1fr)] gap-x-3 py-1 [&>*+*]:shadow-[0_-1px_0_0_var(--color-line)]">
        <Row label={t('landing.card.maker')} value="0x7a3f…c19d" />
        <Row
          label={t('landing.card.give')}
          qualifier={t('landing.card.upTo')}
          value={amount(s.size)}
          token={s.from}
        />
        <Row
          label={t('landing.card.receive')}
          qualifier={t(filled ? 'landing.card.filledAt' : 'landing.card.atLeast')}
          value={money(floorNow)}
          token={s.to}
          accent
        />
        <Row label={t('landing.card.executor')} value={t('landing.card.anyone')} />
      </dl>

      <Chart s={s} p={p} />

      <div className="rule-t mt-5 flex flex-wrap items-center justify-between gap-3 pt-4">
        <span className="text-[13px] text-(--color-body)">{t('landing.card.note')}</span>
        <Cost
          parts={[
            ['1', 'signature'],
            ['0', 'tx'],
          ]}
          tone="good"
        />
      </div>
    </div>
  )
}

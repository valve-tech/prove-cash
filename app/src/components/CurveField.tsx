import { useRef } from 'react'
import { t } from '../lib/i18n'
import { spokenDuration } from '../lib/speech'
import { minutesText } from './charts/chart'
import { useMeasuredWidth } from './charts/useMeasuredWidth'
import { STEPS, moveFrom, moveTo, type Fall } from '../lib/curve'
import { ChevronIcon } from './ChevronIcon'

/**
 * Where inside its window the offer's price falls, as two handles on the shape itself.
 *
 * **The control is the picture.** A maker drags the corner where the fall begins and the corner
 * where it reaches their floor, and the line between them is the line the chain will walk. Every
 * shape anybody has asked for is two drags away — dutch then flat, flat then dutch,
 * flat-dutch-flat — and none of them needs a sentence to explain.
 *
 * The strip in the market panel draws the same shape at a readable size against the pool, so what
 * a maker signs is on screen twice: once where they set it and once where they read it.
 *
 * **Everything this control touches is signed.** The shape is fixed the moment the offer is
 * signed. Nothing live reaches it — this component takes no pool, no clock and no block. The one
 * live figure near the shape is the marker for where we are now, and that belongs to the chart.
 */

/** The plot, in pixels. Measured rather than scaled, so the dashes match the strip's. */
const H = 44
const TOP = 10
const BOTTOM = H - 10

/**
 * How far in from each edge the line and the handles start.
 *
 * A handle at the very start of the window would sit half outside the panel, and at 375px the
 * panel is the screen. Inset the plot by a disc's own radius instead: the line and the handles
 * move together, so the picture still says what it says and nothing reaches an edge. The 24px hit
 * area still overhangs by a few pixels, which is invisible and is where a thumb wants it.
 */
const INSET = 8

/** How far a Page key moves a handle: a quarter of the window, so it lands on the named shapes. */
const PAGE = STEPS / 4

/** A handle's position as a face: the two ends get a word, everything between gets a time. */
function fallFace(step: number, duration: number): string {
  if (step === 0) return t('sign.fall.open')
  if (step === STEPS) return t('sign.fall.close')
  return minutesText((duration * step) / STEPS / 60)
}

/** The same instant, as a phrase a screen reader can read out. */
function fallSpoken(step: number, duration: number): string {
  if (step === 0) return t('sign.fall.atOpen')
  if (step === STEPS) return t('sign.fall.atClose')
  // `measure`: a bare distance to an event, with no preposition over it — `2 minutes after it
  // opens`. Czech wants an accusative and says `1 minutu po otevření`, not `1 minuta po otevření`.
  return t('sign.fall.after', {
    duration: spokenDuration(BigInt(Math.round((duration * step) / STEPS)), 'measure'),
  })
}

export function CurveField({
  fall,
  onFall,
  duration,
}: {
  fall: Fall
  onFall: (next: Fall) => void
  /** The offer's window, in seconds. It turns a step into the time a handle's face shows. */
  duration: number
}) {
  const [measure, width] = useMeasuredWidth<HTMLDivElement>()
  // A second reference to the same node. `useMeasuredWidth` hands back a callback ref, and a
  // pointer needs the box's own left edge, not only its width.
  const box = useRef<HTMLDivElement | null>(null)

  /** Where a step sits, in pixels across the measured track. */
  const x = (step: number): number => INSET + (step / STEPS) * Math.max(0, width - 2 * INSET)

  /** Where a pointer sits, as a step. Physical `left`, because the track is forced LTR below. */
  function stepAt(clientX: number): number {
    const rect = box.current?.getBoundingClientRect()
    const span = (rect?.width ?? 0) - 2 * INSET
    if (!rect || span <= 0) return 0
    return Math.round(((clientX - rect.left - INSET) / span) * STEPS)
  }

  const handle = (
    end: 'from' | 'to',
    step: number,
    move: (f: Fall, step: number) => Fall,
    y: number,
  ) => (
    <button
      type="button"
      role="slider"
      aria-label={t(end === 'from' ? 'sign.fall.from' : 'sign.fall.to')}
      aria-valuemin={0}
      aria-valuemax={STEPS}
      aria-valuenow={step}
      aria-valuetext={fallSpoken(step, duration)}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
      }}
      onPointerMove={(e) => {
        // Only while this handle holds the pointer. A move with no button down is a hover.
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        onFall(move(fall, stepAt(e.clientX)))
      }}
      onKeyDown={(e) => {
        const by =
          e.key === 'ArrowLeft' || e.key === 'ArrowDown'
            ? -1
            : e.key === 'ArrowRight' || e.key === 'ArrowUp'
              ? 1
              : e.key === 'PageDown'
                ? -PAGE
                : e.key === 'PageUp'
                  ? PAGE
                  : 0
        if (by !== 0) {
          e.preventDefault()
          onFall(move(fall, step + by))
          return
        }
        if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault()
          onFall(move(fall, e.key === 'Home' ? 0 : STEPS))
        }
      }}
      // The hit area, and only that. The mark a person sees is drawn in the SVG below, in the
      // same circle the strip puts on its crossing — so the control and the chart wear one
      // language, and neither depends on a utility class rendering a ring.
      //
      // `touch-none`, so a drag along the track does not scroll the page out from under it. 24px
      // is what a thumb needs; the mark inside it is 11px, which is what an eye needs.
      className="absolute size-6 -translate-x-1/2 -translate-y-1/2 touch-none rounded-full"
      style={{ left: x(step), top: y }}
    />
  )

  return (
    <div className="grid gap-1">
      {/*
        The label and the two instants on one line — the same shape every other row in this
        drawer wears. The faces are the whole read-out, so the control needs no sentence.
      */}
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[11px] uppercase tracking-wider text-(--color-dim)"
          aria-hidden="true">
          {t('sign.fall')}
        </span>
        <span className="num text-[11px] text-(--color-body)" aria-hidden="true">
          {/* An expression, so it holds its own direction. See `.ltr` in index.css. */}
          <span className="ltr">
            {fallFace(fall.from, duration)} → {fallFace(fall.to, duration)}
          </span>
        </span>
      </div>
      {/*
        `chart`, so time runs left to right in every script — the same rule the strip follows,
        and the reason the handles below are placed with a physical `left`.
      */}
      <div
        ref={(node) => {
          box.current = node
          measure(node)
        }}
        className="chart relative w-full"
        style={{ height: H }}>
        {width > 0 && (
          <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} aria-hidden="true">
            {/* The ceiling and the floor, so the two flat runs read as prices and not as gaps. */}
            <line
              x1={INSET}
              x2={width - INSET}
              y1={TOP}
              y2={TOP}
              style={{ stroke: 'var(--color-line)' }}
            />
            <line
              x1={INSET}
              x2={width - INSET}
              y1={BOTTOM}
              y2={BOTTOM}
              style={{ stroke: 'var(--color-line)' }}
            />
            {/*
              The shape, in the strip's own line, so a maker reads the control and the chart as
              one object: flat at the ceiling, falling, flat at the floor.
            */}
            <polyline
              points={[
                `${x(0)},${TOP}`,
                `${x(fall.from)},${TOP}`,
                `${x(fall.to)},${BOTTOM}`,
                `${x(STEPS)},${BOTTOM}`,
              ].join(' ')}
              fill="none"
              strokeDasharray="5 3"
              style={{ stroke: 'var(--color-unproven)', strokeWidth: 2 }}
            />
            {/* The two corners a person grabs. Drawn last, so the line runs behind them. */}
            {[
              [x(fall.from), TOP],
              [x(fall.to), BOTTOM],
            ].map(([cx, cy]) => (
              <circle
                key={`${cx},${cy}`}
                cx={cx}
                cy={cy}
                r={5.5}
                style={{
                  fill: 'var(--color-ink)',
                  stroke: 'var(--color-unproven)',
                  strokeWidth: 2,
                }}
              />
            ))}
          </svg>
        )}
        {handle('from', fall.from, moveFrom, TOP)}
        {handle('to', fall.to, moveTo, BOTTOM)}
      </div>
    </div>
  )
}

/**
 * The shape, on the collapsed form: the same two faces, and a way back to the control.
 *
 * It lives here rather than in `Compose` so the drawer and the summary read one source. A signed
 * term that has left its default has to stay readable after the drawer closes — the same rule the
 * fee destination follows — and a term still at its default is noise, so the caller only renders
 * this once the shape is not the straight line.
 */
export function FallSummary({
  fall,
  duration,
  open,
  onToggle,
}: {
  fall: Fall
  duration: number
  /** Whether the drawer this points at is showing. */
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className="gutter flex items-center justify-between gap-2 text-[11px] text-(--color-dim) -mt-1">
      <span className="uppercase tracking-wider" aria-hidden="true">
        {t('sign.fall')}
      </span>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="offer-advanced"
        aria-label={t('sign.fall.label', {
          from: fallSpoken(fall.from, duration),
          to: fallSpoken(fall.to, duration),
        })}
        className="num hover:text-(--color-body) transition-colors">
        <span aria-hidden="true">
          {/* An expression, so it holds its own direction. See `.ltr` in index.css. */}
          <span className="ltr">
            {fallFace(fall.from, duration)} → {fallFace(fall.to, duration)}
          </span>{' '}
          <span><ChevronIcon up={open} /></span>
        </span>
      </button>
    </div>
  )
}

import { Badge, Cost, Section, Tip } from './bits.tsx'
import { t } from '../lib/i18n.ts'
import type { Key } from '../i18n/en.ts'

/**
 * The custody ladder, drawn rather than described. Every rung gets the same frame — your wallet,
 * the contract, and the path the tokens take to back a fill — so the shape carries the
 * difference and the words that remain are labels. The caveats live behind the labels, on hover.
 *
 * Strongest rung first, same as the old prose: the reader meets the hero claim — two signatures,
 * nothing sent — before the rung that can fail them.
 */

/**
 * Where the tokens are, in the same words the app's board rows use. Green is the committed end of
 * the ladder, amber the spendable end; the CSS tokens keep their older `proven` names.
 */
/**
 * Where the tokens sit, as a value rather than as a word.
 *
 * It used to be the English string itself — `w === 'in wallet'` decided the colour — so
 * translating the label would have silently repainted the diagram. The key travels now and the
 * word is looked up at the edge.
 */
type Where = 'escrow' | 'fill' | 'wallet'
const toneOf = (w: Where): 'good' | 'warn' => (w === 'wallet' ? 'warn' : 'good')
const colourOf = (w: Where) => (w === 'wallet' ? 'var(--color-unproven)' : 'var(--color-proven)')
const WHERE_LABEL: Record<Where, Key> = {
  escrow: 'landing.ladder.where.escrow',
  fill: 'landing.ladder.where.fill',
  wallet: 'landing.ladder.where.wallet',
}

type Rung = {
  id: string
  name: Key
  where: Where
  /** Which box holds the tokens while the offer is live. */
  held: 'wallet' | 'contract'
  /** The label under the connector. */
  path: Key
  spend: [string, string][]
  off: Key
  offTip: Key
  /** How much of the lifetime meter is lit. An open meter fades out instead of stopping. */
  life: number
  open?: boolean
  /** The diagram, spoken. */
  sr: Key
}

const RUNGS: Rung[] = [
  {
    id: 'auth',
    name: 'landing.ladder.rung.auth',
    where: 'fill',
    held: 'wallet',
    path: 'landing.ladder.path.auth',
    spend: [
      ['2', 'signatures'],
      ['0', 'tx'],
    ],
    off: 'landing.ladder.off.auth',
    offTip: 'landing.ladder.offTip.auth',
    life: 0.8,
    sr: 'landing.ladder.sr.auth',
  },
  {
    id: 'escrow',
    name: 'landing.ladder.rung.escrow',
    where: 'escrow',
    held: 'contract',
    path: 'landing.ladder.path.escrow',
    spend: [
      ['1', 'signature'],
      ['1–2', 'tx'],
    ],
    off: 'landing.ladder.off.escrow',
    offTip: 'landing.ladder.offTip.escrow',
    life: 1,
    open: true,
    sr: 'landing.ladder.sr.escrow',
  },
  {
    id: 'permit2',
    name: 'landing.ladder.rung.permit2',
    // `fill`, not `wallet`, and the difference is real rather than flattering. A Permit2 transfer
    // is single-use and carries its own deadline, so nothing rests on a standing allowance to us
    // and the tokens leave the maker at the moment of the fill. `app/src/lib/custody.ts` places
    // this rung the same way, and it is one of the three whose off switch is real: a maker who
    // burns the Permit2 nonce ends the offer, where revoking an allowance never does.
    where: 'fill',
    held: 'wallet',
    path: 'landing.ladder.path.permit2',
    // `≤` mirrors in a right-to-left line and is drawn as `≥` — the opposite claim about how many
    // transactions a maker signs. `Cost` isolates every value it paints, so the raw string is
    // what belongs here: `spokenCost` reads the same tuple and has to see a bare `≤` to strip it.
    spend: [
      ['2', 'signatures'],
      ['≤1', 'tx'],
    ],
    off: 'landing.ladder.off.permit2',
    offTip: 'landing.ladder.offTip.permit2',
    // Bounded by the deadline signed into the transfer, not by the one-hour wallet cap. That is
    // the intent's own window, so it sits with the authorization rung rather than below it.
    life: 0.8,
    sr: 'landing.ladder.sr.permit2',
  },
  {
    id: 'permit',
    name: 'landing.ladder.rung.permit',
    where: 'wallet',
    held: 'wallet',
    path: 'landing.ladder.path.permit',
    spend: [
      ['2', 'signatures'],
      ['0', 'tx'],
    ],
    off: 'landing.ladder.off.permit',
    offTip: 'landing.ladder.offTip.permit',
    // Open, like escrow. These two read 0.22 while `MAX_WALLET_WINDOW` capped them at an hour;
    // `a7c5d7f` deleted that, so an offer on either rung rests exactly as long as the maker
    // signed for. What is weaker here is the OFF SWITCH, and that is the `off` column's job.
    life: 1,
    sr: 'landing.ladder.sr.permit',
  },
  {
    id: 'approval',
    name: 'landing.ladder.rung.approval',
    where: 'wallet',
    held: 'wallet',
    path: 'landing.ladder.path.approval',
    spend: [
      ['1', 'signature'],
      ['≤1', 'tx'],
    ],
    off: 'landing.ladder.off.approval',
    offTip: 'landing.ladder.offTip.approval',
    life: 1,
    sr: 'landing.ladder.sr.approval',
  },
]

/** A stack of three token discs. Ghosts mark where the tokens arrive at fill time. */
function Coins({ color, ghost = false }: { color: string; ghost?: boolean }) {
  return (
    <span className="flex -space-x-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-2.5 rounded-full"
          style={
            ghost
              ? { boxShadow: `0 0 0 1px ${color}`, opacity: 0.3 }
              : { background: color, boxShadow: '0 0 0 1.5px var(--color-ink)' }
          }
        />
      ))}
    </span>
  )
}

/**
 * One rung, drawn: where the tokens sit, and how they reach the contract.
 *
 * The three captions used to sit one under each column, and the middle one under a connector that
 * is only ~90px wide in the four-across layout. "allowance · at fill" broke across three lines
 * there and ran into its neighbours. It gets the whole width now, on a row of its own, so nothing
 * in this diagram wraps at any card width.
 */
const CAP = 'num text-[10px] leading-tight tracking-wider text-(--color-dim) uppercase'

function Diagram({ r }: { r: Rung }) {
  const c = colourOf(r.where)
  const dashed = r.held === 'wallet'
  return (
    <div
      aria-hidden="true"
      className="mt-5 grid grid-cols-[3.5rem_minmax(0,1fr)_3.5rem] items-center gap-x-2">
      <div className="flex h-10 items-center justify-center bg-(--color-ink) shadow-[0_0_0_1px_var(--color-line)]">
        {r.held === 'wallet' && <Coins color={c} />}
      </div>
      <div className="flex min-w-0 items-center">
        <div
          className="h-px min-w-0 flex-1"
          style={
            dashed
              ? { backgroundImage: `repeating-linear-gradient(90deg, ${c} 0 4px, transparent 4px 9px)` }
              : { background: c }
          }
        />
        <svg width="7" height="8" viewBox="0 0 7 8" className="shrink-0">
          <path d="M0 0L7 4L0 8Z" fill={c} />
        </svg>
      </div>
      <div className="flex h-10 items-center justify-center bg-(--color-ink) shadow-[0_0_0_1px_var(--color-line)]">
        <Coins color={c} ghost={r.held !== 'contract'} />
      </div>

      {/* One word under each box. Two words did not fit 3.5rem, and the heading above already
          says whose wallet it is. */}
      <div className={`${CAP} mt-1.5 text-center`}>{t('landing.ladder.wallet')}</div>
      <div />
      <div className={`${CAP} mt-1.5 text-center`}>{t('landing.ladder.contract')}</div>

      <div className={`${CAP} col-span-3 mt-2.5 text-center`}>{t(r.path)}</div>
    </div>
  )
}

/** How long the rung may rest, as a bar: a hard stop dies on its own, a fade never does. */
function Life({ r }: { r: Rung }) {
  const c = colourOf(r.where)
  return (
    <span aria-hidden="true" className="block h-1 w-full max-w-[6.5rem] shrink bg-(--color-line)">
      <span
        className="block h-full"
        style={{
          width: `${r.life * 100}%`,
          background: r.open ? `linear-gradient(90deg, ${c} 55%, transparent)` : c,
        }}
      />
    </span>
  )
}

export function Ladder() {
  return (
    <Section id="custody" label={t('landing.nav.custody')}>
      <h2 className="max-w-[24ch] text-[clamp(1.6rem,4.5vw,2.4rem)] leading-[1.05] font-semibold tracking-[-0.03em] text-(--color-bright)">
        {t('landing.ladder.title')}
      </h2>
      <p className="mt-5 max-w-[62ch] text-[15px] leading-relaxed text-(--color-body)">
        {t('landing.ladder.sub')}
      </p>

      {/*
        Three then five, never two or four. Five rungs is a prime number of cards, so a column
        count that used to divide the list now leaves one card alone on a row of its own — which
        reads as a rung that did not fit rather than as the fifth of five. Both counts divide it:
        3 + 2 on a tablet, 5 across on a desktop.
      */}
      <ul className="bleed mt-9 grid gap-px bg-(--color-line) sm:grid-cols-3 lg:grid-cols-5">
        {RUNGS.map((r) => (
          <li key={r.id} className="bg-(--color-panel) p-2 sm:p-4">
            {/*
              Wrapping, not truncating. "authorization" beside "funds at fill" is the widest pair
              here, and at four cards across it does not always fit one line. It drops to a second
              line when it must and stays on one when it fits.
            */}
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <h3 className="num text-[15px] text-(--color-bright)">{t(r.name)}</h3>
              <Badge label={t(WHERE_LABEL[r.where])} tone={toneOf(r.where)} />
            </div>
            <p className="sr-only">{t(r.sr)}</p>
            <Diagram r={r} />
            <dl className="mt-5 grid gap-2.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <dt className="num w-[5rem] shrink-0 text-[11px] tracking-wider text-(--color-dim) uppercase">
                  {t('landing.ladder.spend')}
                </dt>
                <dd className="min-w-0">
                  <Cost parts={r.spend} tone={toneOf(r.where)} />
                </dd>
              </div>
              <div className="relative flex flex-wrap items-center gap-x-2 gap-y-1.5">
                <dt className="num w-[5rem] shrink-0 text-[11px] tracking-wider text-(--color-dim) uppercase">
                  {t('landing.ladder.off')}
                </dt>
                <dd className="flex min-w-0 flex-1 items-center gap-2.5">
                  <Life r={r} />
                  <span className="num text-[11px] whitespace-nowrap text-(--color-body)">
                    <Tip label={t(r.off)} tip={t(r.offTip)} />
                  </span>
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <div className="num relative mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 text-[11px] tracking-wider uppercase">
        {/* The legend defines the three badges a board row can wear, in the app's own words. */}
        {(['escrow', 'fill', 'wallet'] as const).map((w) => (
          <span key={w}>
            <span className={w === 'wallet' ? 'text-(--color-unproven)' : 'text-(--color-proven)'}>
              {t(WHERE_LABEL[w])}
            </span>
            <span className="text-(--color-dim)"> · {t(`landing.ladder.legend.${w}`)}</span>
          </span>
        ))}
        <span className="text-(--color-dim)">
          <Tip label={t('landing.ladder.cancel')} tip={t('landing.ladder.cancel.tip')} />
        </span>
      </div>
    </Section>
  )
}

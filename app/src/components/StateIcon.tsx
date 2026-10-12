import type { CustodyMode } from '@prove.cash/sdk'
import { t } from '../lib/i18n'
import { TipGlyph } from './Tip'

/**
 * The offer's states, as glyphs.
 *
 * Every row used to wear its states as words — `in escrow`, `partial`, `decaying`, `unfunded` —
 * and a board is read as a column, so the words hid the figures. Each glyph here replaces one of
 * those words. The word does not go away: it is the glyph's accessible name, and it shows on
 * hover and on keyboard focus, so a reader who does not know the shape can still get the word
 * without a mouse.
 *
 * Three families, drawn so that the eye can tell them apart:
 *
 *   WHERE   Where the money is. One frame — a coin and the contract's box — and the coin moves
 *           across it: outside a dashed box (in wallet), outside a solid box with its place
 *           marked (funded at fill), inside the box (in escrow). A spectrum of custody, not three
 *           pictures.
 *   RUNG    How the tokens are authorised to move. A nib is a signature, an open ring is a
 *           standing allowance, a tray with an arrow is a deposit, a ticket is a single-use slip.
 *   FLAG    Everything else an offer can be: expired, off the board, partial, decaying, funded,
 *           unfunded, an escrow not yet read, an escrow found empty.
 *
 * Colour is never the only signal. Good and bad states differ in shape as well as in hue: a
 * check against a triangle, a solid box against a struck one.
 *
 * Every glyph is a 16-unit square drawn in the current colour. The caller fixes the rendered size
 * so a row never reflows, and the `shrink-0` lives on the wrapper for the same reason.
 *
 * This file imports React, the dictionary and the tip. Nothing from viem, so the landing page
 * may use it once its copy lands.
 */

/** Where the tokens sit while the offer is live. The same three ids `lib/custody` uses. */
export type Where = 'escrow' | 'fill' | 'wallet'

export type Flag =
  | 'expired'
  | 'offBoard'
  | 'decaying'
  | 'funded'
  | 'unfunded'
  | 'escrowUnread'
  | 'escrowEmpty'

const S = {
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

/** The contract's box: the right half of the frame the three WHERE glyphs share. */
function Box({ dashed = false }: { dashed?: boolean }) {
  return (
    <rect
      x="8.75"
      y="2.75"
      width="6.5"
      height="10.5"
      strokeDasharray={dashed ? '2 1.7' : undefined}
    />
  )
}

/** The maker's coin. */
function Coin({ cx, cy, r = 2 }: { cx: number; cy: number; r?: number }) {
  return <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
}

export function WhereGlyph({ where, size }: { where: Where; size: number }) {
  if (where === 'wallet') {
    // The coin is still the maker's. The box is drawn dashed: the contract never holds it.
    return (
      <svg {...S} width={size} height={size} aria-hidden="true">
        <Coin cx={3.75} cy={8} />
        <Box dashed />
      </svg>
    )
  }
  if (where === 'fill') {
    // Nothing has moved. The coin is outside, and the box already has its place marked: one
    // signature carries it in at the moment of the fill.
    return (
      <svg {...S} width={size} height={size} aria-hidden="true">
        <Coin cx={3.75} cy={8} />
        <Box />
        <circle cx="12" cy="8" r="1.9" strokeWidth="1.2" />
      </svg>
    )
  }
  // The contract holds it.
  return (
    <svg {...S} width={size} height={size} aria-hidden="true">
      <Box />
      <Coin cx={12} cy={8} r={2.1} />
    </svg>
  )
}

/** A signature. The stroke starts on the thing it signs. */
function Nib({ from }: { from: [number, number] }) {
  return (
    <>
      <path d={`M${from[0]} ${from[1]} L14 2`} />
      <circle cx={from[0]} cy={from[1]} r="1.1" fill="currentColor" stroke="none" />
    </>
  )
}

/** A standing allowance: a ring left open at the top right, where the nib enters. */
function Ring() {
  return <path d="M11.4 4.1 A5.25 5.25 0 1 0 13.25 8" />
}

export function RungGlyph({ mode, size }: { mode: CustodyMode; size: number }) {
  if (mode === 'authorization') {
    // Signed on the token itself. The token honours the signature; nothing stands between.
    return (
      <svg {...S} width={size} height={size} aria-hidden="true">
        <circle cx="6.5" cy="9.5" r="4.25" />
        <Nib from={[6.5, 9.5]} />
      </svg>
    )
  }
  if (mode === 'escrow') {
    // A deposit: the coin goes down into the contract's tray.
    return (
      <svg {...S} width={size} height={size} aria-hidden="true">
        <path d="M3.25 8v5.25h9.5V8" />
        <path d="M8 2.25v7.25M5.5 7.25 8 9.75l2.5-2.5" />
      </svg>
    )
  }
  if (mode === 'permit2') {
    // A single-use slip: a ticket with its perforation. Nothing stands after the fill.
    return (
      <svg {...S} width={size} height={size} aria-hidden="true">
        <path d="M2.25 4.25h11.5v2.4a1.4 1.4 0 0 0 0 2.7v2.4H2.25v-2.4a1.4 1.4 0 0 0 0-2.7z" />
        <path d="M10 4.25v7.5" strokeDasharray="1.2 1.4" strokeWidth="1.2" />
      </svg>
    )
  }
  if (mode === 'permit') {
    // The allowance, signed into place rather than sent.
    return (
      <svg {...S} width={size} height={size} aria-hidden="true">
        <Ring />
        <Nib from={[8, 8]} />
      </svg>
    )
  }
  // approval: the allowance alone, left standing.
  return (
    <svg {...S} width={size} height={size} aria-hidden="true">
      <Ring />
      <Coin cx={8} cy={8} r={1.1} />
    </svg>
  )
}

export function FlagGlyph({ flag, size }: { flag: Flag; size: number }) {
  switch (flag) {
    case 'expired':
      // An hourglass with the sand at the bottom.
      return (
        <svg {...S} width={size} height={size} aria-hidden="true">
          <path d="M4.25 2.5h7.5M4.25 13.5h7.5" />
          <path d="M5.25 2.5v1.6c0 2.2 5.5 2.6 5.5 3.9s-5.5 1.7-5.5 3.9v1.6" />
          <path d="M10.75 2.5v1.6c0 2.2-5.5 2.6-5.5 3.9s5.5 1.7 5.5 3.9v1.6" />
          <path d="M6.4 12.6 8 10.7l1.6 1.9z" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'offBoard':
      // Signed, and not broadcasting: the beacon, struck through.
      return (
        <svg {...S} width={size} height={size} aria-hidden="true">
          <circle cx="8" cy="11.25" r="1.25" fill="currentColor" stroke="none" />
          <path d="M5.2 8.4a4 4 0 0 1 5.6 0M2.9 6a7.2 7.2 0 0 1 10.2 0" />
          <path d="M2.75 13.25 13.25 2.75" />
        </svg>
      )
    case 'decaying':
      // The floor falls along the curve and lands. The dot is where it stops.
      return (
        <svg {...S} width={size} height={size} aria-hidden="true">
          <path d="M2.5 2.75c.5 4.6 2.5 8.2 7 8.75h3.5" />
          <circle cx="13.5" cy="11.5" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'funded':
      return (
        <svg {...S} width={size} height={size} aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M5.2 8.3 7.2 10.3l3.8-4.3" />
        </svg>
      )
    case 'unfunded':
      // A triangle, not a circle: the shape says danger before the colour does.
      return (
        <svg {...S} width={size} height={size} aria-hidden="true">
          <path d="M8 2.5 14.5 13.25H1.5z" />
          <path d="M8 6.4v3.1" />
          <circle cx="8" cy="11.5" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'escrowUnread':
      // The contract's box, not yet asked.
      return (
        <svg {...S} width={size} height={size} aria-hidden="true">
          <rect x="2.75" y="3.25" width="10.5" height="9.5" />
          <circle cx="5.5" cy="8" r="0.85" fill="currentColor" stroke="none" />
          <circle cx="8" cy="8" r="0.85" fill="currentColor" stroke="none" />
          <circle cx="10.5" cy="8" r="0.85" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'escrowEmpty':
      // The box, struck out: asked, and found empty.
      return (
        <svg {...S} width={size} height={size} aria-hidden="true">
          <rect x="2.75" y="3.25" width="10.5" height="9.5" />
          <path d="M5.25 10.75 10.75 5.25" />
        </svg>
      )
  }
}

/**
 * A partial fill as a pie, filled to the fraction already taken.
 *
 * The wedge is a circle drawn with a stroke as wide as its radius, so `stroke-dasharray` cuts
 * the sector and nothing computes an arc. The outer ring is the whole offer; the wedge is what
 * has gone. `fraction` is clamped and rounded to the pixel, so 0.999 still shows a sliver of
 * ring and 0 shows an empty one.
 */
export function PieGlyph({ fraction, size }: { fraction: number; size: number }) {
  const f = Math.min(1, Math.max(0, fraction))
  // Radius 3.25, stroke 6.5: a solid disc of radius 6.5 when full.
  const c = 2 * Math.PI * 3.25
  return (
    <svg {...S} width={size} height={size} aria-hidden="true">
      <circle cx="8" cy="8" r="6.5" strokeWidth="1.25" opacity="0.55" />
      {f > 0 && (
        <circle
          cx="8"
          cy="8"
          r="3.25"
          strokeWidth="6.5"
          strokeLinecap="butt"
          strokeDasharray={`${(f * c).toFixed(3)} ${c.toFixed(3)}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  )
}

/**
 * An offer that fills in one go or not at all: a solid square.
 *
 * Not a circle. The pie is a circle at every fraction — an empty ring at none, a solid disc when
 * full — so any round shape here would read as the pie at some point along it. A square cannot.
 */
export function WholeGlyph({ size }: { size: number }) {
  return (
    <svg {...S} width={size} height={size} aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" fill="currentColor" stroke="none" />
    </svg>
  )
}

const WHERE_KEY = {
  escrow: 'custody.where.escrow',
  fill: 'custody.where.fill',
  wallet: 'custody.where.wallet',
} as const

const FLAG_KEY = {
  expired: 'row.expired',
  offBoard: 'row.offBoard',
  decaying: 'row.decaying',
  funded: 'row.funded',
  unfunded: 'row.unfunded',
  escrowUnread: 'row.escrow.unread',
  escrowEmpty: 'row.escrow.empty',
} as const

/**
 * What each glyph means, said in full. The tooltip is the glyph's only caption, so a reader who
 * does not recognise the shape must get the meaning from here, not just its name.
 */
const WHERE_DETAIL = {
  escrow: 'custody.where.escrow.spoken',
  fill: 'custody.where.fill.spoken',
  wallet: 'custody.where.wallet.spoken',
} as const

const FLAG_DETAIL = {
  expired: 'row.expired.spoken',
  offBoard: 'row.offBoard.tip',
  decaying: 'row.decaying.tip',
  funded: 'row.funded.tip',
  unfunded: 'row.unfunded.tip',
  escrowUnread: 'row.escrow.unread.tip',
  escrowEmpty: 'row.escrow.empty.tip',
} as const

const FLAG_TONE: Record<Flag, string> = {
  expired: 'text-(--color-dim)',
  offBoard: 'text-(--color-unproven)',
  decaying: 'text-(--color-dim)',
  funded: 'text-(--color-dim)',
  unfunded: 'text-(--color-danger)',
  escrowUnread: 'text-(--color-dim)',
  escrowEmpty: 'text-(--color-danger)',
}

/** Green is the committed end of the custody ladder, amber the spendable end. */
export const whereTone = (w: Where) =>
  w === 'wallet' ? 'text-(--color-unproven)' : 'text-(--color-proven)'

/** The word a WHERE glyph replaces. */
export const whereWord = (w: Where): string => t(WHERE_KEY[w])

/** The word a FLAG glyph replaces. */
export const flagWord = (f: Flag): string => t(FLAG_KEY[f])

/**
 * Where the tokens are, as a badge: the glyph, the word as its name, the word on hover.
 *
 * `detail`, when given, follows the word in the tip and in the spoken name. The Mine tab uses it
 * to add its longer sentence — `in escrow — the contract holds them`.
 */
export function WhereBadge({
  where,
  size = 14,
  detail,
}: {
  where: Where
  size?: number
  detail?: string
}) {
  const word = whereWord(where)
  // Always the explanation, not the bare name. `detail` overrides it where a surface says it better.
  const text = `${word} — ${detail ?? t(WHERE_DETAIL[where])}`
  return (
    <TipGlyph label={text} tip={text} className={whereTone(where)}>
      <WhereGlyph where={where} size={size} />
    </TipGlyph>
  )
}

/** One offer flag as a badge. `detail` is the longer tip, where a flag has one. */
export function FlagBadge({
  flag,
  size = 14,
  detail,
}: {
  flag: Flag
  size?: number
  detail?: string
}) {
  const text = `${flagWord(flag)} — ${detail ?? t(FLAG_DETAIL[flag])}`
  return (
    <TipGlyph label={text} tip={text} className={FLAG_TONE[flag]}>
      <FlagGlyph flag={flag} size={size} />
    </TipGlyph>
  )
}

/** An offer that fills in one go or not at all. The other half of the fills-in-parts term. */
export function WholeBadge({ size = 14 }: { size?: number }) {
  const text = `${t('sign.partial.none')} — ${t('row.whole.tip')}`
  return (
    <TipGlyph label={text} tip={text} className="text-(--color-body)">
      <WholeGlyph size={size} />
    </TipGlyph>
  )
}

/**
 * An offer that fills in parts, with how much of it is gone.
 *
 * The name carries the number: a screen reader hears the proportion, not the bare word. The
 * percent is the reader's own — `fixed` writes the locale's digits and separator. `filled` is
 * null until the chain answers, and then the badge says `partial` alone rather than `0%`, which
 * would be a claim.
 */
export function PartialBadge({
  filled,
  total,
  size = 14,
  pct,
}: {
  filled: bigint | null
  total: bigint
  size?: number
  /** `fixed(value, places)` from the dictionary's locale, passed in so this file stays thin. */
  pct: (fraction: number) => string
}) {
  const word = t('row.partial')
  const fraction = filled === null || total === 0n ? null : Number((filled * 10_000n) / total) / 10_000
  // Four sentences, because one would lie at either end: "0% filled so far" reports nothing, and
  // "100% filled so far. The rest stays open." claims a rest that does not exist. Caught on the
  // live board on 2026-09-10, where one fills-in-parts offer read exactly that.
  const said =
    fraction === null
      ? t('row.partial.tip')
      : fraction <= 0
        ? t('row.partial.none')
        : fraction >= 1
          ? t('row.partial.done')
          : t('row.partial.filled', { pct: pct(fraction) })
  const text = `${word} — ${said}`
  return (
    <TipGlyph label={text} tip={text} className="text-(--color-body)">
      <PieGlyph fraction={fraction ?? 0} size={size} />
    </TipGlyph>
  )
}

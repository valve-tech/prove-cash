import { t } from '../lib/i18n.ts'
import type { Tab } from '../routes.ts'

/**
 * The four views, as glyphs for the header.
 *
 * An icon alone names nothing, so every one of these ships with the word it replaces — in the
 * tooltip a mouse finds and in the `aria-label` a screen reader reads. Neither is decoration.
 *
 * "Mine" is the one that needed care. This app grinds proof of work to post, so a pickaxe or a
 * gem would read as mining rather than as your own offers. A person does not.
 */

const S = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

export function ViewIcon({ view }: { view: Tab }) {
  if (view === 'board') {
    // A book of offers: rows, longest first, the way the board itself is drawn.
    return (
      <svg {...S} aria-hidden="true">
        <path d="M2.75 4h10.5M2.75 8h7.5M2.75 12h9" />
      </svg>
    )
  }
  if (view === 'rfq') {
    // Two arrows crossing: one price out to one address, one signature back. The exclusive quote
    // is the only place on this site where two parties sign the two halves of one trade.
    return (
      <svg {...S} aria-hidden="true">
        <path d="M2.75 5.5h8.5l-2.2-2.2M13.25 10.5h-8.5l2.2 2.2" />
      </svg>
    )
  }
  if (view === 'sign') {
    // A nib. You sign here; nothing is sent.
    return (
      <svg {...S} aria-hidden="true">
        <path d="M11.4 2.6a1.6 1.6 0 0 1 2.3 2.3L6 12.5l-3 .7.7-3 7.7-7.6z" />
        <path d="M10.2 3.8l2 2" />
      </svg>
    )
  }
  return (
    <svg {...S} aria-hidden="true">
      <circle cx="8" cy="5.6" r="2.6" />
      <path d="M3.2 13.4c0-2.4 2.1-3.9 4.8-3.9s4.8 1.5 4.8 3.9" />
    </svg>
  )
}

type Counts = { count: number; reposts: number }

/**
 * The tooltip: the word the icon replaced, plus whatever the count is actually counting.
 *
 * Each branch is a whole string from the dictionary rather than a count glued to a noun. The join
 * — a middot here, a comma in the spoken label — belongs to the sentence, so the translator owns
 * it. Both maps stay functions of the counts, and both call `t` when they are called: a language
 * change re-renders the header, which re-runs these.
 */
export const VIEW_TIP: Record<Tab, (c: Counts) => string> = {
  board: ({ count }) => (count > 0 ? t('view.board.tip', { count }) : t('view.board')),
  sign: () => t('view.sign'),
  rfq: ({ count }) => (count > 0 ? t('view.rfq.tip', { count }) : t('view.rfq')),
  mine: ({ count, reposts }) => {
    if (count === 0) return t('view.mine')
    if (reposts > 0) return t('view.mine.tip.reposts', { count, reposts })
    return t('view.mine.tip', { count })
  },
}

/**
 * The spoken label. It says the same thing in whole words: a screen reader gets no glyph and no
 * hover, so the count has to be a sentence rather than a numeral hanging off an icon.
 */
export const VIEW_LABEL: Record<Tab, (c: Counts) => string> = {
  board: ({ count }) => (count > 0 ? t('view.board.spoken', { count }) : t('view.board')),
  sign: () => t('view.sign'),
  rfq: ({ count }) => (count > 0 ? t('view.rfq.spoken', { count }) : t('view.rfq')),
  mine: ({ count, reposts }) => {
    if (count === 0) return t('view.mine')
    if (reposts > 0) return t('view.mine.spoken.reposts', { count, reposts })
    return t('view.mine.spoken', { count })
  },
}

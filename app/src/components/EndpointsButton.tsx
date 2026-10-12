import type { Key } from '../i18n/en.ts'
import { t } from '../lib/i18n.ts'
import { TipUnder } from './Tip'

/**
 * The endpoints control in the header: a route mark, a health dot, and no words.
 *
 * The host used to print in the nav as raw text — `one.valve.city`, or two domains joined with a
 * middot the moment board and chain differed. Nobody asked to read a domain, and the two-domain
 * form was the widest thing in the header. The host now lives in the `aria-label`, which is where
 * a reader goes when they want it; the tooltip says what the control is and leaves the state to
 * the dot and the label.
 */

/**
 * Three states, because the dot draws three shapes. `waiting` is a node that answers but does not
 * take posts; `broken` is a node that does not answer at all.
 *
 * A caller passes null before the first answer. Silence is not a refusal and not a failure, so
 * the dot goes dim and the words say we are still checking, rather than guessing.
 */
export type EndpointHealth = 'live' | 'waiting' | 'broken'

/**
 * The words the dot's shape stands for. A screen reader gets no shape, so it gets these.
 *
 * Keys rather than words, looked up when the button draws. The map is module state and the reader
 * can change language after it is built, so holding the English here would freeze it.
 */
const HEALTH: Record<EndpointHealth, Key> = {
  live: 'board.live',
  waiting: 'board.closed',
  broken: 'board.unreachable',
}

/**
 * The route mark: a hub with three spokes out to three more nodes. It is our own glyph and it says
 * "this is where your reads go" without a word of English in it — a globe belongs to the language
 * picker and a plug reads as power.
 *
 * Drawn from the 1024 source — hub (512,512) r72, nodes (512,300), (330,700) and (694,700) r52 —
 * scaled 1.75x about the figure's own centre, which is what puts it on the same optical footing as
 * the view icons.
 *
 * The radii are tuned rather than divided. At 1/64 the source hub lands at r1.1 and the nodes at
 * r0.8, which is under a pixel each: stroked they smudge, and the whole mark collapses into a
 * grey Y. Filled discs at r1.5 and r1.25, against a 1.1 spoke, is the ratio at which four nodes
 * still read as four nodes. The spokes stop short of every disc for the same reason — a spoke that
 * runs into a node welds the two into one blob.
 */
function RouteIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <path d="M8 6.55V4.06M6.76 9.61L4.09 12.37M9.24 9.61L11.91 12.37" />
      <circle cx="8" cy="8.33" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="8" cy="2.53" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="3.02" cy="13.47" r="1.25" fill="currentColor" stroke="none" />
      <circle cx="12.98" cy="13.47" r="1.25" fill="currentColor" stroke="none" />
    </svg>
  )
}

/**
 * The header's endpoints button. It owns its own words and nothing else: the caller passes the
 * board's health, the host it is talking to, and what to do when the button is pressed.
 */
export function EndpointsButton({
  health,
  custom,
  host,
  throttled = false,
  onClick,
}: {
  health: EndpointHealth | null
  /** True when either endpoint differs from the default. It changes the words, not the glyphs. */
  custom: boolean
  /** One host, or two joined with a middot when board and chain differ. Rendered nowhere else. */
  host: string
  /**
   * The chain endpoint stopped answering reads, through a whole retry schedule.
   *
   * Separate from `health`, which is the board's. The two fail independently — a board can be
   * live while `eth_` reads are being throttled — so they get separate marks: the dot is the
   * board, the route glyph is the chain. One control, two facts, neither pretending to be
   * the other.
   */
  throttled?: boolean
  onClick: () => void
}) {
  const said = health === null ? t('board.checking') : t(HEALTH[health])
  const state = throttled ? `${said} · ${t('header.endpoints.throttled')}` : said
  // The host and the custom marker ride in `{hosts}`. The sentence has one slot for them, and a
  // marker appended after the full stop would fall outside whatever word order a language chose.
  const hosts = custom ? `${host}, ${t('header.endpoints.custom')}` : host
  return (
    <TipUnder tip={t('header.endpoints.tip', { health: state, hosts })}>
      <button
        className="hdr-btn"
        onClick={onClick}
        aria-label={t('header.endpoints', { health: state, hosts })}>
        <span className={throttled ? 'text-(--color-unproven)' : undefined}>
          <RouteIcon />
        </span>
        {/*
          The dot changes shape as well as hue: a filled disc is live, a hollow ring is waiting, a
          square is broken. Colour alone would say nothing to half the people reading it. It sits
          beside the mark rather than on it — at 6px an overlay hides the shape, which is the half
          of the signal that survives colour blindness.
        */}
        <span
          aria-hidden="true"
          className={`live-dot inline-block w-1.5 h-1.5 ${
            health === null
              ? 'rounded-full bg-(--color-line-bright) opacity-60'
              : health === 'live'
              ? 'rounded-full bg-(--color-proven)'
              : health === 'broken'
                ? 'rounded-[1px] bg-(--color-danger)'
                : 'rounded-full border border-(--color-unproven)'
          }`}
        />
      </button>
    </TipUnder>
  )
}

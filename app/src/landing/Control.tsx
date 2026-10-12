import { Section, Tip } from './bits.tsx'
import { t } from '../lib/i18n.ts'
import type { Key } from '../i18n/en.ts'

/**
 * The last question a maker has, and the one the page had left unanswered.
 *
 * Hero says what this is, Mechanism says how it works, Ladder says where the tokens sit and
 * Costs says what the gas comes to. A reader who believes all four still has one worry: *what
 * can the other side do to me once I sign?* This section answers that, and nothing else.
 *
 * It replaced a seven-card section that answered a different question — how carefully the thing
 * was built. Coverage figures, invariant campaigns and the token matrix are how we know it
 * works; they are not what a maker gets, and a landing page that recites them is talking about
 * itself. Two rules came out of that, and they are the ones to hold this section to:
 *
 *  1. **Every claim is a consequence for the reader, not a fact about our process.** If it would
 *     read the same on a page about any competent codebase, it does not belong here.
 *  2. **A limitation is not a selling point.** Which tokens break the escrow accounting is a
 *     real and measured thing, and the place to say it is the app, where a maker is choosing a
 *     token, and `test/TokenMatrix.t.sol`, where the detail lives. Advertising it to a stranger
 *     reads as a warning about us rather than as candour.
 *
 * Both rules leave the audit line in, because "somebody adversarial read this" is a consequence.
 * It sits under the cards rather than in one, because it supports the three claims rather than
 * standing beside them.
 *
 * No address is printed. The set is in `contracts/deployments/369.json`, which stays right
 * through a redeploy while a number typed into this component would not.
 */

type Claim = {
  id: string
  title: Key
  body: Key
  /** The file, constant or function a reader checks it against. */
  where: Key
}

/*
 * Ordered by what a maker stands to lose: first their payout, then their fee, then their exit.
 */
const CLAIMS: Claim[] = [
  {
    id: 'rate',
    title: 'landing.control.rate.title',
    body: 'landing.control.rate.body',
    where: 'landing.control.where.rate',
  },
  {
    id: 'fee',
    title: 'landing.control.fee.title',
    body: 'landing.control.fee.body',
    where: 'landing.control.where.fee',
  },
  {
    id: 'pause',
    title: 'landing.control.pause.title',
    body: 'landing.control.pause.body',
    where: 'landing.control.where.pause',
  },
]

export function Control() {
  return (
    <Section id="control" label={t('landing.nav.control')}>
      <h2 className="text-[15px] font-medium text-(--color-bright)">
        {t('landing.control.title')}
      </h2>
      <p className="mt-2 max-w-[62ch] text-[14px] leading-relaxed text-(--color-body)">
        {t('landing.control.body')}
      </p>

      {/* The 1px grid gap lets the line colour behind show through, so no cell owns a border. */}
      <ul className="bleed mt-6 grid gap-px bg-(--color-line) sm:grid-cols-3">
        {CLAIMS.map((c) => (
          <li key={c.id} className="relative bg-(--color-panel) p-2 sm:p-4">
            <h3 className="text-[14px] font-medium text-(--color-bright)">{t(c.title)}</h3>
            <p className="mt-2 text-[13.5px] leading-relaxed text-(--color-body)">{t(c.body)}</p>
            {/*
              The citation is what makes the claim more than an assurance, and it is also the
              least readable thing in the cell. It sits behind the tip, so the claim keeps the
              line and the evidence is one hover away.
            */}
            <Tip
              tip={t(c.where)}
              label={
                <span className="num mt-3 inline-block text-[11px] tracking-[0.18em] text-(--color-dim) uppercase">
                  {t('landing.control.where')}
                </span>
              }
            />
          </li>
        ))}
      </ul>

      <p className="mt-6 max-w-[70ch] text-[13px] leading-relaxed text-(--color-dim)">
        {t('landing.control.audit')}
      </p>
    </Section>
  )
}

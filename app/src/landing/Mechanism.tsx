import { Section } from './bits.tsx'
import { t } from '../lib/i18n.ts'
import type { Key } from '../i18n/en.ts'

/**
 * Three steps, labelled by who acts rather than by number. Who acts is the surprising part: the
 * maker never touches the chain, and the party who does is a stranger.
 *
 * The settlement paths land here too. The hero sells the order book; this is where a reader who
 * wants the mechanism finds out that what they sign depends on what their token can do.
 */

const STEPS: { id: string; actor: Key; title: Key; body: Key }[] = [
  {
    id: 'sign',
    actor: 'landing.step.sign.actor',
    title: 'landing.step.sign.title',
    body: 'landing.step.sign.body',
  },
  {
    id: 'carry',
    actor: 'landing.step.carry.actor',
    title: 'landing.step.carry.title',
    body: 'landing.step.carry.body',
  },
  {
    id: 'execute',
    actor: 'landing.step.execute.actor',
    title: 'landing.step.execute.title',
    body: 'landing.step.execute.body',
  },
]

/**
 * What the maker signs, cheapest path first. The app reads the token and picks; this table is
 * here so a reader can see there is no path that needs them to send a transaction to trade.
 */
const PATHS: { id: string; name: Key; cost: Key; body: Key }[] = [
  {
    id: 'auth',
    name: 'landing.rung.auth.name',
    cost: 'landing.rung.auth.cost',
    body: 'landing.rung.auth.body',
  },
  {
    id: 'permit',
    name: 'landing.rung.permit.name',
    cost: 'landing.rung.permit.cost',
    body: 'landing.rung.permit.body',
  },
  {
    id: 'permit2',
    name: 'landing.rung.permit2.name',
    cost: 'landing.rung.permit2.cost',
    body: 'landing.rung.permit2.body',
  },
  {
    id: 'allowance',
    name: 'landing.rung.allowance.name',
    cost: 'landing.rung.allowance.cost',
    body: 'landing.rung.allowance.body',
  },
  {
    id: 'escrow',
    name: 'landing.rung.escrow.name',
    cost: 'landing.rung.escrow.cost',
    body: 'landing.rung.escrow.body',
  },
]

export function Mechanism() {
  return (
    <Section id="how" label={t('landing.nav.how')}>
      {/* This section leads with its cards, so the heading the outline needs is invisible. */}
      <h2 className="sr-only">{t('landing.how.title')}</h2>
      {/* The 1px grid gap lets the line colour behind show through, so no cell owns a border. */}
      <ul className="bleed grid gap-px bg-(--color-line) sm:grid-cols-3">
        {STEPS.map((s) => (
          <li key={s.id} className="bg-(--color-panel) p-2 sm:p-4">
            <div className="num text-[11px] tracking-[0.22em] text-(--color-proven) uppercase">
              {t(s.actor)}
            </div>
            <h3 className="mt-4 text-base font-medium text-(--color-bright)">{t(s.title)}</h3>
            <p className="mt-2 text-[14px] leading-relaxed text-(--color-body)">{t(s.body)}</p>
          </li>
        ))}
      </ul>

      <h3 className="mt-12 text-[15px] font-medium text-(--color-bright)">
        {t('landing.how.tokens.title')}
      </h3>
      <p className="mt-2 max-w-[62ch] text-[14px] leading-relaxed text-(--color-body)">
        {t('landing.how.tokens.body')}
      </p>
      {/* One row per path. The grid gap shows the line colour through, so no cell owns a border. */}
      <ul className="mt-4 grid gap-px bg-(--color-line)">
        {PATHS.map((p) => (
          <li
            key={p.id}
            className="grid gap-x-4 gap-y-1 bg-(--color-panel) p-2 sm:grid-cols-[10rem_7rem_minmax(0,1fr)] sm:p-4">
            <span className="num text-[12.5px] text-(--color-bright)">{t(p.name)}</span>
            <span className="num text-[12.5px] text-(--color-proven)">{t(p.cost)}</span>
            <span className="text-[13.5px] leading-relaxed text-(--color-body)">{t(p.body)}</span>
          </li>
        ))}
      </ul>
    </Section>
  )
}

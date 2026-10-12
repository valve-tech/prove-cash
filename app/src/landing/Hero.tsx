import { navigate } from '../surface.ts'
import { t } from '../lib/i18n.ts'
import type { Key } from '../i18n/en.ts'
import { Eyebrow } from './bits.tsx'
import { IntentCard } from './IntentCard.tsx'

/**
 * The value proposition first: this is a limit order book, so you name a rate and wait instead of
 * taking whatever the pool quotes right now. That is the thing a reader can already price against
 * what they know.
 *
 * The settlement paths — 3009, permit, allowance, escrow — are the second question, not the first.
 * They live in "how it works". Leading with "no transaction, ever" sold the mechanism to someone
 * who had not yet been told what the thing does.
 */

const FACTS: { head: Key; body: Key }[] = [
  { head: 'landing.fact.rate.head', body: 'landing.fact.rate.body' },
  { head: 'landing.fact.anyone.head', body: 'landing.fact.anyone.body' },
  { head: 'landing.fact.free.head', body: 'landing.fact.free.body' },
]

export function Hero() {
  return (
    <>
      <div className="gutter mx-auto grid max-w-6xl items-center gap-12 pt-14 pb-16 sm:pt-20 lg:grid-cols-[minmax(0,1fr)_25rem] lg:gap-14 lg:pt-24 lg:pb-24">
        <div className="lp-stagger min-w-0">
          <Eyebrow>{t('landing.hero.eyebrow')}</Eyebrow>

          <h1 className="mt-6 text-[clamp(2.05rem,8.6vw,4.25rem)] leading-[0.95] font-semibold tracking-[-0.035em] text-(--color-bright)">
            <span className="block">{t('landing.hero.line1')}</span>
            <span className="block">{t('landing.hero.line2')}</span>
            <span className="block text-(--color-proven)">{t('landing.hero.line3')}</span>
          </h1>

          <p className="mt-7 max-w-[54ch] text-[15px] leading-relaxed text-(--color-body)">
            {t('landing.hero.lede')}
          </p>
          <p className="mt-3 max-w-[54ch] text-[15px] leading-relaxed text-(--color-dim)">
            {t('landing.hero.sub')}
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <button
              className="btn btn-primary lp-focus"
              type="button"
              onClick={() => navigate('/app')}>
              {t('landing.open')}
            </button>
            <a className="btn btn-ghost lp-focus" href="#how">
              {t('header.tour')}
            </a>
          </div>
        </div>

        {/* The card carries its own padding, so it cancels the page gutter rather than sit inside it. */}
        <div className="lp-rise lp-card bleed min-w-0">
          <IntentCard />
        </div>
      </div>

      <div className="rule-y">
        {/* Each fact rules itself with an outset shadow: under it when stacked, beside it when not. */}
        <ul className="mx-auto grid max-w-6xl sm:grid-cols-3">
          {FACTS.map((f) => (
            <li
              key={f.head}
              className="gutter py-7 shadow-[0_1px_0_0_var(--color-line)] last:shadow-none sm:shadow-[1px_0_0_0_var(--color-line)] sm:last:shadow-none">
              <h2 className="text-[15px] font-medium text-(--color-bright)">{t(f.head)}</h2>
              <p className="mt-2 text-[13.5px] leading-relaxed text-(--color-body)">{t(f.body)}</p>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

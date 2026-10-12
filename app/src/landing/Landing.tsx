import { navigate } from '../surface.ts'
import { keepLocale, t, useLocale } from '../lib/i18n.ts'
import { Wordmark } from './bits.tsx'
import { LanguagePicker } from '../components/LanguagePicker.tsx'
import { SectionNav } from './SectionNav.tsx'
import { Costs } from './Costs.tsx'
import { Hero } from './Hero.tsx'
import { Ladder } from './Ladder.tsx'
import { Mechanism } from './Mechanism.tsx'
import { Console } from './console/Console.tsx'
import { Control } from './Control.tsx'
import { Solvers } from './Solvers.tsx'
import { StartHere } from './StartHere.tsx'
import { SiteFooter } from '../components/SiteFooter'

/**
 * The landing page. One job: a maker who has never heard of this learns that they sign an offer
 * instead of sending a transaction, and that the rate they sign is the rate they get. The custody
 * ladder is the second screen, because it is the thing that makes the promise credible.
 *
 * It imports the router and nothing else. Anything here that reaches for the SDK, viem or the
 * board undoes the only reason the two surfaces are split — see surface.ts.
 */

/*
 * Scoped to this page: one entrance and one focus ring, both switched off for reduced motion.
 * The tooltip used to live here too. It is in `index.css` now, because the app draws the same
 * one and this tag never mounts on the app route.
 */
const CSS = `
@keyframes lp-rise {
  from { opacity: 0; transform: translateY(12px); }
  to { opacity: 1; transform: none; }
}
.lp-rise, .lp-stagger > * {
  animation: lp-rise 0.7s cubic-bezier(0.22, 0.68, 0.24, 1) both;
}
.lp-stagger > *:nth-child(2) { animation-delay: 70ms; }
.lp-stagger > *:nth-child(3) { animation-delay: 140ms; }
.lp-stagger > *:nth-child(4) { animation-delay: 190ms; }
.lp-stagger > *:nth-child(5) { animation-delay: 240ms; }
.lp-card { animation-delay: 300ms; }
/*
  A token this address has already moved.

  It cannot be a Tailwind utility. .btn-ghost sets its own colour and border from an unlayered
  rule in index.css, and an unlayered rule beats a layered utility whatever the specificity — so
  the text-(--color-proven) class on the element did nothing at all. This rule is unlayered too
  and simply comes later, because the page injects this sheet after that one. The hover pair is
  there because .btn-ghost:hover would otherwise take the border straight back.
*/
.lp-held,
.lp-held:hover:not(:disabled) {
  border-color: var(--color-proven);
  color: var(--color-proven);
}
.lp-focus:focus-visible {
  outline: 2px solid var(--color-proven);
  outline-offset: 3px;
  border-radius: 10px;
}
/*
  The fill. One ring expanding out of the crossing, once per loop — the moment the floor drops
  under the market and the offer becomes takeable. It draws on a copy of the marker rather than on
  the marker itself so the line underneath stays put.
*/
@keyframes lp-fill {
  0% { r: 3; opacity: 0.9; stroke-width: 2; }
  70% { r: 11; opacity: 0; stroke-width: 0.5; }
  100% { r: 11; opacity: 0; stroke-width: 0.5; }
}
.lp-fill { animation: lp-fill 1.6s ease-out infinite; transform-box: fill-box; }
@media (prefers-reduced-motion: reduce) {
  .lp-rise, .lp-stagger > * { animation: none; }
  /* Held on the last frame, not hidden: the ring is the information. */
  .lp-fill { animation: none; }
}
`

export default function Landing() {
  // Subscribe to the language, the same way the app's root does. Without it a reader switching
  // locale would see the app change and this page stay where it was.
  useLocale()

  /*
    No `lang` or `dir` here any more.

    This used to be `lang="en" dir="ltr"`, because not one word on the page went through `t()` and
    an Arabic reader got English prose flushed to the right margin with the diagrams running
    backwards — a page mirrored around content that never moved. Now the words move too, so the
    document's own `lang` and `dir`, which `lib/i18n` sets from the reader's choice, are correct
    for this subtree as well.
  */
  return (
    <div className="min-h-full">
      <style>{CSS}</style>

      <a className="skip-link" href="#main">
        {t('header.skip')}
      </a>

      {/*
        The same shape as the app's header — wordmark, nav, controls at the end — set at the same
        height and in the same faces. The two used to differ in every one of those, and a reader
        crossing from here into the app met what looked like a second product.
      */}
      <header className="rule-b sticky top-0 z-20 bg-(--color-ink)/85 backdrop-blur-md">
        <div className="gutter mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-3 py-3.5">
          <Wordmark className="text-lg" />
          <SectionNav />
          <button
            className="btn btn-ghost lp-focus ms-auto px-3 py-1.5 text-xs"
            type="button"
            onClick={() => {
              // The app has no locale in its URL. A reader who arrived at `/ja/` takes Japanese
              // across with them, and it survives the reload they do there. See `keepLocale`.
              keepLocale()
              navigate('/app')
            }}>
            {t('landing.open')}
          </button>
          {/*
            Last, and that is load-bearing rather than a preference. The popover hangs from this
            control's trailing edge — `end-0` in LanguagePicker — so the only place it is certain
            to fit is where that edge is the header's own. With the picker before the button
            instead, a 375px screen put 43px of the list past the left edge in English and 15px
            past the right in Arabic, in both cases over rows nobody could reach.

            This page is where the picker matters most. Thirty-four translations reach a reader
            who never opens the app, and until now the only way to see one was to arrive with the
            right browser language. Here it changes the URL too — see `localeHref`.
          */}
          <LanguagePicker />
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <Hero />
        <Mechanism />
        <Ladder />
        <Costs />
        {/*
          After the bill, before the guarantees. The reader has just seen what a fill costs and
          that they are not the one paying it; "who is, then" is the question in front of them,
          and it has to be answered before "what nobody can do to you" can land.
        */}
        <Solvers />
        {/*
          After the solver, before the guarantees, and for the same reason `Solvers` sits where it
          does. Costs says what a fill costs, Solvers says who pays it and why — and the question
          that follows is *so where does MY money go*. Nothing above this point puts the five
          parties on one screen, and the reader now knows every one of them by name: the pool from
          Mechanism, the rung from Ladder, gas from Costs, the solver from Solvers. Put it after
          Control and it answers a question the reader has already stopped asking.
        */}
        <Console />
        <Control />

        <StartHere />
      </main>

      {/* The app's footer, word for word and pixel for pixel. It is the same site. */}
      <SiteFooter
        how={{ kind: 'link', href: '#how' }}
        contentClassName="gutter mx-auto flex max-w-6xl flex-wrap gap-x-5 gap-y-1 py-3 text-[11px] text-(--color-dim)"
      />
    </div>
  )
}

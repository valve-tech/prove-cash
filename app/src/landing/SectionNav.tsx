import { useEffect, useState } from 'react'
import { t } from '../lib/i18n.ts'
import type { Key } from '../i18n/en.ts'

/**
 * Where you are in the page, in the header.
 *
 * This is what replaced the reserved label column. That column told you the name of the section
 * you were already reading, which is the one thing the heading beside it also told you, and it
 * cost 9rem of every section to do it. Moving the same three words into the header turns them
 * into wayfinding: you can see the whole page at once and jump.
 *
 * It also lands the landing page's header on the app's shape — wordmark, nav, controls — so the
 * two surfaces read as one product rather than two.
 */

/** The id is the anchor and never translates; the label is copy and always does. */
const SECTIONS: readonly { id: string; label: Key }[] = [
  { id: 'how', label: 'landing.nav.how' },
  { id: 'custody', label: 'landing.nav.custody' },
  { id: 'costs', label: 'landing.nav.costs' },
  { id: 'solvers', label: 'landing.nav.solvers' },
  { id: 'console', label: 'landing.nav.console' },
  { id: 'control', label: 'landing.nav.control' },
]

/**
 * The section under the header, or null while the hero is on screen.
 *
 * The observer's root is inset to a band just under the header, so the active section is the one
 * the reader has actually arrived at rather than the one whose last pixel is still in view. The
 * last visible entry wins, which is what makes scrolling back up light the earlier section again.
 */
function useActiveSection(): string | null {
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    const nodes = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (n): n is HTMLElement => n !== null,
    )
    if (nodes.length === 0) return

    const seen = new Map<string, boolean>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting)
        // Document order, so the topmost section in the band is the one named.
        const hit = SECTIONS.find((s) => seen.get(s.id))
        setActive(hit ? hit.id : null)
      },
      // A band from just under the header down to a third of the way up the viewport. A section
      // is "current" from the moment its top reaches that band.
      { rootMargin: '-56px 0px -67% 0px' },
    )
    for (const n of nodes) io.observe(n)
    return () => io.disconnect()
  }, [])

  return active
}

export function SectionNav() {
  const active = useActiveSection()

  return (
    /*
      `md`, not `sm`. Five labels, a wordmark, a button and the language picker do not fit beside
      each other at 640px: English measures 264px against about 294px of room, and Turkish
      measures 323. A nav that overflows squeezes the button it sits next to, so it waits for the
      width it needs. Nothing is lost below it — every section is on this one page and carries its
      own heading.

      The console added a sixth, which is why `landing.nav.console` is one short word and why the
      comment above it in `en.ts` says so. The row wraps rather than clipping, so a language that
      needs the space takes a second line instead of losing a label.
    */
    <nav aria-label={t('landing.nav.label')} className="hidden flex-wrap items-center gap-0.5 md:flex">
      {SECTIONS.map((s) => (
        <a
          key={s.id}
          href={`#${s.id}`}
          aria-current={active === s.id ? 'true' : undefined}
          className={`num lp-focus rounded-lg px-2 py-1.5 text-[11px] tracking-[0.18em] uppercase transition-colors ${
            active === s.id
              ? 'bg-(--color-panel-2) text-(--color-bright)'
              : 'text-(--color-dim) hover:text-(--color-body)'
          }`}>
          {t(s.label)}
        </a>
      ))}
    </nav>
  )
}

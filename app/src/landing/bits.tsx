import type { ReactNode } from 'react'
import { ltr, t, tCount } from '../lib/i18n.ts'

/**
 * The small parts the landing page repeats. The important one is `Cost`.
 *
 * Every promise on this page is priced in signatures and transactions, in the same notation the
 * app uses on the custody ladder. The good prices and the bad ones are set in the same face, at
 * the same size, so nothing hides.
 */

export type Tone = 'good' | 'warn' | 'bad' | 'mute'

const VALUE: Record<Tone, string> = {
  good: 'text-(--color-proven)',
  warn: 'text-(--color-unproven)',
  bad: 'text-(--color-danger)',
  mute: 'text-(--color-bright)',
}

/**
 * The printed price is shorthand — `≤1`, `1–2`, `tx`. None of it survives being read aloud, so
 * every pair carries a spoken twin.
 *
 * It used to be built by gluing English: `≤` became the literal `'at most '`, a range became
 * `' to '`, and the noun took an `s` unless the value ended in `1`. Every one of those is an
 * English rule. `tCount` picks the noun's form through `Intl.PluralRules`, and the comparison
 * and the range are sentences a translator owns.
 *
 * `lib/i18n` is React and the dictionary and nothing else, so importing it here costs the
 * landing bundle no viem — which is the only thing the landing/dapp split asks of this file.
 */
const UNIT_BASE: Record<string, string> = {
  tx: 'landing.cost.unit.tx',
  signature: 'landing.cost.unit.signature',
  signatures: 'landing.cost.unit.signature',
  min: 'landing.cost.unit.min',
}

function spokenCost(value: string, unit: string): string {
  const base = UNIT_BASE[unit]
  // A unit with no spoken form is said as it is printed. Better than inventing one.
  if (!base) return `${value} ${unit}`

  const range = value.split('–')
  if (range.length === 2) {
    // A range is always plural, whatever its ends are.
    const n = Number(range[1])
    return `${t('landing.cost.range', { from: range[0] ?? '', to: range[1] ?? '' })} ${tCount(base, Number.isFinite(n) ? n : 2)}`
  }

  const bare = value.replace(/^[≤≥]/, '')
  const n = Number(bare)
  const count = Number.isFinite(n) ? n : 2
  const said = value.startsWith('≤')
    ? t('landing.cost.atMost', { value: bare })
    : value.startsWith('≥')
      ? t('landing.cost.atLeast', { value: bare })
      : bare
  return `${said} ${tCount(base, count)}`
}

/** A price in signatures, transactions and waiting. `parts` is a list of value/unit pairs. */
export function Cost({ parts, tone = 'mute' }: { parts: [string, string][]; tone?: Tone }) {
  return (
    <span className="num inline-flex shrink-0 items-center rounded-full border hair px-2.5 py-1 text-[11px] whitespace-nowrap">
      <span className="sr-only">{t('landing.cost.label')} </span>
      {parts.map(([value, unit], i) => (
        <span key={unit} className="inline-flex items-center gap-1">
          {i > 0 && (
            <>
              <span className="px-1.5 text-(--color-dim)" aria-hidden="true">
                ·
              </span>
              <span className="sr-only"> {t('landing.cost.and')} </span>
            </>
          )}
          {/*
            Isolated, because `≤` and `–` mirror. Dropped bare into a Hebrew or Arabic line, `≤1`
            resolves to an odd bidi level and is drawn as `≥1` — the opposite claim about what a
            rung costs. Only the painted half is wrapped: `spokenCost` reads the raw `value` and
            strips a leading `≤` to say "at most one", which an isolate character would hide.
          */}
          <span className={VALUE[tone]} aria-hidden="true">
            {ltr(value)}
          </span>
          <span className="text-(--color-dim)" aria-hidden="true">
            {unit}
          </span>
          <span className="sr-only">{spokenCost(value, unit)}</span>
        </span>
      ))}
    </span>
  )
}

/**
 * The badge a board row wears for this custody mode. It names where the tokens are, which is the
 * only question an executor has. It is a warning, not an ornament.
 *
 * The colour tokens are still called `--color-proven` and `--color-unproven`. The words are not:
 * "proven" collided with the proof of work the board charges, and it claimed more than the
 * authorization rung delivers.
 */
export function Badge({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span className={`num text-[11px] uppercase tracking-[0.18em] ${VALUE[tone]}`}>{label}</span>
  )
}

/**
 * The tip moved to `components/Tip.tsx` when the app started drawing the same one. Re-exported
 * here so this page keeps one import for its small parts. It pulls in React and nothing else,
 * which is the only thing the landing/dapp split asks of it.
 */
export { Tip } from '../components/Tip.tsx'

export function Eyebrow({ children, className = '' }: { children: string; className?: string }) {
  return (
    <div className={`num text-[11px] uppercase tracking-[0.22em] text-(--color-dim) ${className}`}>
      {children}
    </div>
  )
}

/**
 * A section: its label, then its content, across the whole measure.
 *
 * The label used to sit in a reserved 9rem column down the left margin. On a phone that column
 * collapsed and the label sat above the content anyway, so the layout only existed on desktop —
 * where it spent 9rem of every section on one uppercase word and squeezed the four custody cards
 * into 200px each. The label reads the same above the heading, and the content gets the width
 * back. Where you are in the page is the header's job now; see `SectionNav`.
 */
export function Section({
  id,
  label,
  children,
}: {
  id?: string
  label: string
  children: ReactNode
}) {
  return (
    <section id={id} aria-label={label} className="rule-t scroll-mt-[3.25rem]">
      <div className="gutter mx-auto max-w-6xl py-14 md:py-20">
        <Eyebrow>{label}</Eyebrow>
        <div className="mt-5 min-w-0">{children}</div>
      </div>
    </section>
  )
}

/**
 * The name, set once for the whole site.
 *
 * It was mono here and semibold sans in the app's header, which is the loudest way two pages can
 * announce that they are different products. Sans wins: the mono version read as a code sample
 * rather than as a name.
 */
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-semibold tracking-tight text-(--color-bright) ${className}`}>
      prove<span className="text-(--color-proven)">.cash</span>
    </span>
  )
}

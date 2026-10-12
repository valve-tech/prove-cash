import type { ReactNode } from 'react'
import { t } from '../lib/i18n.ts'
import { SECURITY_CONTACT } from '../lib/security'

/**
 * The site footer, shared by the landing page and the app.
 *
 * Three short labels with glyphs — a target for the board the intents live on, a wrench for the
 * tour, a bug for the report line. The spoken name of each control keeps the longer sentence the
 * label used to be; the visible word is only the part a scan needs.
 */

const S = {
  width: 12,
  height: 12,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
}

/** Concentric rings: the board intents are aimed at. */
function TargetIcon() {
  return (
    <svg {...S}>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="3" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** A wrench: open the mechanics. */
function WrenchIcon() {
  return (
    <svg {...S}>
      <path d="M10.2 2.6a2.8 2.8 0 0 1 3.2 3.2l-5.1 5.1-2.3-.5-.5-2.3 4.7-5.5z" />
      <path d="M7.2 9.3L3.2 13.3" />
    </svg>
  )
}

/** A bug: report one. */
function BugIcon() {
  return (
    <svg {...S}>
      <path d="M5.2 6.2a2.8 2.8 0 0 1 5.6 0v3.2a2.8 2.8 0 0 1-5.6 0V6.2z" />
      <path d="M8 3.5V2.4M5.5 4.2L4.4 3.1M10.5 4.2l1.1-1.1" />
      <path d="M3.4 7.2h1.8M10.8 7.2h1.8M3.4 10h1.8M10.8 10h1.8" />
      <path d="M8 9.4v2.8" />
    </svg>
  )
}

const linkClass =
  'inline-flex items-center gap-1 text-(--color-body) hover:text-(--color-bright)'

type HowAction =
  | { kind: 'button'; onClick: () => void }
  | { kind: 'link'; href: string }

/**
 * @param how opens the tour in the app, or jumps to `#how` on the landing page.
 * @param extra the settlement-missing note the app alone shows, or nothing.
 * @param contentClassName landing wraps to `max-w-6xl`; the app does not.
 */
export function SiteFooter({
  how,
  extra,
  contentClassName = 'gutter flex flex-wrap gap-x-5 gap-y-1 py-3 text-[11px] text-(--color-dim)',
}: {
  how: HowAction
  extra?: ReactNode
  contentClassName?: string
}) {
  const sharedLabel = t('footer.shared', { board: 'msgboard' })
  const howLabel = t('footer.how')
  const reportLabel = t('footer.report')

  return (
    <footer aria-label={t('footer.about')} className="rule-t">
      <div className={contentClassName}>
        <a
          className={linkClass}
          href="https://msgboard.xyz/"
          target="_blank"
          rel="noreferrer"
          aria-label={t('footer.shared.aria', { board: 'msgboard' })}>
          <TargetIcon />
          {sharedLabel}
        </a>
        {how.kind === 'button' ? (
          <button type="button" className={linkClass} onClick={how.onClick} aria-label={t('footer.how.aria')}>
            <WrenchIcon />
            {howLabel}
          </button>
        ) : (
          <a className={linkClass} href={how.href} aria-label={t('footer.how.aria')}>
            <WrenchIcon />
            {howLabel}
          </a>
        )}
        <a
          className={linkClass}
          href={SECURITY_CONTACT}
          target="_blank"
          rel="noreferrer"
          aria-label={t('footer.report.aria')}>
          <BugIcon />
          {reportLabel}
        </a>
        {extra}
      </div>
    </footer>
  )
}


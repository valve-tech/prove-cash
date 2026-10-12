import type { ReactNode } from 'react'

/**
 * A caveat behind a hover, shared by the landing page and the app.
 *
 * It lived in `landing/bits.tsx` behind CSS the landing page injected in a `<style>` tag, so the
 * app could not use it — the rules are not mounted on the app route. The rules now sit in
 * `index.css`, which both surfaces load, and this is the one component that draws them.
 *
 * It imports React and nothing else. The landing page must stay clear of the SDK and viem, so
 * anything shared with it has to be that thin.
 *
 * The body anchors to the nearest positioned ancestor and spans its width, which is what keeps it
 * on screen at 375px — a tip centred on its own label runs past the viewport. So the hosting row
 * carries `relative`.
 */
export function Tip({
  label,
  tip,
  under = false,
}: {
  label: ReactNode
  tip: string
  /** Open below the label. Use inside an `overflow: auto` panel where an upward tip is clipped. */
  under?: boolean
}) {
  return (
    <span className="tip relative" tabIndex={0}>
      <span className="tip-label">{label}</span>
      <span role="tooltip" className={under ? 'tip-body tip-under' : 'tip-body'}>
        {tip}
      </span>
    </span>
  )
}

/**
 * The same tip wrapped around a control that already reads as one — an icon button — so there is
 * no dotted label of its own and the body hangs below the trigger instead of above it.
 *
 * The wrapper takes no `tabIndex`: the control inside is already focusable, and `:focus-within`
 * on the wrapper is what shows the tip to a keyboard. A second tab stop would make every icon
 * cost two.
 *
 * `tip-under` also sizes the body to its own text. A nav icon's positioned ancestor is this
 * wrapper, but the plain `tip-body` stretches to it, which for an icon is 32px wide.
 */
export function TipUnder({ children, tip }: { children: ReactNode; tip: string }) {
  return (
    <span className="tip relative inline-flex">
      {children}
      <span role="tooltip" className="tip-body tip-under">
        {tip}
      </span>
    </span>
  )
}

/**
 * A glyph that stands for a word, with the word one hover or one Tab away.
 *
 * The wrapper is the tab stop and carries the word as its name, so a screen reader gets the word
 * and never the picture. The tip hangs beside the glyph rather than above or below it: the rows
 * that wear these sit inside a sideways scroller, and a body that leaves the row's box would give
 * that scroller a vertical scrollbar. Beside stays inside the row.
 *
 * `shrink-0` and an explicit size on the glyph are what keep a row from reflowing.
 */
export function TipGlyph({
  children,
  label,
  tip,
  className = '',
}: {
  children: ReactNode
  label: string
  tip: string
  className?: string
}) {
  return (
    <span
      className={`tip relative inline-flex shrink-0 align-middle ${className}`}
      tabIndex={0}
      role="img"
      aria-label={label}>
      {children}
      <span role="tooltip" className="tip-body tip-beside">
        {tip}
      </span>
    </span>
  )
}

/**
 * A circled "i" that reveals a paragraph on hover or focus.
 *
 * For the detail a panel used to print underneath itself. The sign page's chart carried three
 * lines of it — how far the draft moves the pool, how many other floors rest on the pair, which
 * pair contract and block the curve came from — under a chart that is already the point of the
 * panel. All three are worth having and none is worth reading every time.
 *
 * The body anchors to the nearest positioned ancestor and spans it, so the caller's row needs
 * `relative`. The icon carries no label of its own: the text is the label, which is also what a
 * screen reader gets, so there is nothing to translate for the trigger.
 */
export function InfoTip({ tip }: { tip: string }) {
  return (
    <span className="tip shrink-0 text-(--color-dim) hover:text-(--color-body)" tabIndex={0} role="note" aria-label={tip}>
      <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" className="block">
        <circle cx="8" cy="8" r="6.8" fill="none" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="8" cy="4.9" r="0.9" fill="currentColor" />
        <path d="M8 7.3v4.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
      <span role="tooltip" className="tip-body">
        {tip}
      </span>
    </span>
  )
}

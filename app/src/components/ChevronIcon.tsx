/**
 * A disclosure chevron. Replaces the text carets (`▾` / `▴`) that used to sit on menus and
 * "more" toggles — drawn at the same 12px optical size as the footer glyphs.
 */
export function ChevronIcon({ up = false }: { up?: boolean }) {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={up ? 'rotate-180' : undefined}>
      <path d="M4 6.2l4 4 4-4" />
    </svg>
  )
}

import { useEffect, useRef } from 'react'
import { useEscape } from './useEscape'

/**
 * What a modal owes a keyboard: focus moves in when it opens, Tab cannot leave it, and focus
 * returns to whatever opened it when it closes. Escape still closes it, through `useEscape`.
 *
 * Attach the returned ref to the dialog box and give that box `tabIndex={-1}`, `role="dialog"`,
 * `aria-modal="true"` and a label.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

export function useDialog<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null)
  useEscape(onClose)

  useEffect(() => {
    const box = ref.current
    if (!box) return
    const opener = document.activeElement as HTMLElement | null

    const stops = () =>
      [...box.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetWidth > 0 || el.offsetHeight > 0,
      )

    // Focus the first control, or the box itself when the dialog has none yet.
    ;(stops()[0] ?? box).focus()

    function trap(e: KeyboardEvent) {
      if (e.key !== 'Tab' || !box) return
      const items = stops()
      if (items.length === 0) {
        e.preventDefault()
        box.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      const outside = !box.contains(active)
      if (e.shiftKey && (active === first || active === box || outside)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', trap, true)
    return () => {
      document.removeEventListener('keydown', trap, true)
      // Give the page back the caret it lent us. A dialog that opened by itself, like the
      // first-run tour, borrowed it from `body`, so it goes to the main landmark instead.
      const back =
        opener && opener !== document.body && document.contains(opener)
          ? opener
          : document.getElementById('main')
      back?.focus()
    }
  }, [])

  return ref
}

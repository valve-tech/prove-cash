import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { useEscape } from './useEscape'
import { ChevronIcon } from './ChevronIcon'

/**
 * A menu, never a `<select>`.
 *
 * A native select renders as an OS widget. It ignores the page's type, colour and radius, it looks
 * different on every platform, and on iOS it takes over the bottom half of the screen. Nothing
 * about it can be styled to match. This is a button and a list of buttons, so it is ours.
 *
 * What it owes a keyboard, and what a native select gives for free: Enter, Space, ArrowDown or
 * ArrowUp open it; the arrows move through options; Home and End jump to the ends; Enter picks;
 * Escape closes and returns focus to the button. Typing a letter is not implemented, which is the
 * one thing a native select does that this does not.
 */

export type MenuOption<T extends string> = {
  value: T
  label: string
  hint?: string
  /** Drawn before the label, in the button when selected and in every row of the list. */
  icon?: React.ReactNode
}

export function Menu<T extends string>({
  value,
  options,
  onChange,
  label,
  className = '',
  disabled = false,
}: {
  value: T
  options: readonly MenuOption<T>[]
  onChange: (next: T) => void
  /** Names the control for a screen reader. Not shown. */
  label: string
  className?: string
  /** Holds the current value: the button does not open while this is true. */
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  // True when the list opens from the button's end edge rather than its start.
  const [flip, setFlip] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()

  const current = options.find((o) => o.value === value) ?? options[0]

  useEscape(() => {
    if (!open) return
    setOpen(false)
    box.current?.querySelector('button')?.focus()
  })

  // A click anywhere else closes it. `pointerdown`, not `click`, so it closes before the thing
  // underneath reacts.
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', away)
    return () => window.removeEventListener('pointerdown', away)
  }, [open])

  // The list opens from the button's start edge, which is right for a button at the start of a
  // row. A button near the end of a row, like the board's token menu on a 375px phone, would push
  // a list wider than itself off the screen, and the hints at its end were cut off. So the list is
  // measured before paint, and it opens from the other edge when it would cross the viewport.
  useLayoutEffect(() => {
    if (!open) return setFlip(false)
    const el = list.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const rtl = getComputedStyle(el).direction === 'rtl'
    setFlip(rtl ? r.left < 0 : r.right > document.documentElement.clientWidth)
  }, [open])

  // Focus follows the active option, so the reader is told what is highlighted.
  useEffect(() => {
    if (!open) return
    const items = list.current?.querySelectorAll<HTMLElement>('[role="option"]')
    items?.[active]?.focus()
  }, [open, active])

  function openAt(index: number) {
    setActive(index)
    setOpen(true)
  }

  function pick(next: T) {
    onChange(next)
    setOpen(false)
    box.current?.querySelector('button')?.focus()
  }

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((k) => (k + 1) % options.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((k) => (k - 1 + options.length) % options.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(options.length - 1)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div ref={box} className={`relative ${className}`}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        className="menu-btn"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openAt(Math.max(0, options.indexOf(current))))}
        onKeyDown={(e) => {
          if (disabled) return
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            openAt(Math.max(0, options.indexOf(current)))
          }
        }}>
        {current?.icon}
        <span className="truncate">{current?.label}</span>
        <span aria-hidden="true" className="inline-flex text-(--color-dim)">
          <ChevronIcon />
        </span>
      </button>

      {open && (
        <div
          ref={list}
          role="listbox"
          id={id}
          aria-label={label}
          tabIndex={-1}
          onKeyDown={onListKey}
          className={`menu-list ${flip ? 'menu-list-end' : ''}`}>
          {options.map((o, k) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              tabIndex={-1}
              className={`menu-item ${o.value === value ? 'menu-item-on' : ''}`}
              onClick={() => pick(o.value)}
              onMouseEnter={() => setActive(k)}>
              <span className="menu-lead truncate">
                {o.icon}
                {o.label}
              </span>
              {o.hint && <span className="num ps-3 text-[11px] text-(--color-dim)">{o.hint}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * A toggle, never a checkbox.
 *
 * Same reason as the menu: `input[type=checkbox]` draws an OS control that `accent-color` can
 * tint and nothing else can touch. This is a button carrying `role="switch"`, so a screen reader
 * still calls it a switch and still says on or off.
 */
export function Toggle({
  checked,
  onChange,
  children,
  className = '',
}: {
  checked: boolean
  onChange: (next: boolean) => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`toggle ${className}`}>
      <span aria-hidden="true" className={`toggle-box ${checked ? 'toggle-box-on' : ''}`}>
        {checked && (
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" strokeWidth="2.2">
            <path d="M2.5 6.3 L4.8 8.6 L9.5 3.6" stroke="currentColor" strokeLinecap="square" />
          </svg>
        )}
      </span>
      {children}
    </button>
  )
}

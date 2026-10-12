import { useEffect, useId, useRef, useState } from 'react'
import { filterLocales, localeOf, setLocale, t, useLocale, type LocaleCode } from '../lib/i18n.ts'
import { useEscape } from './useEscape'
import { localeHref, navigate } from '../surface.ts'

/**
 * A globe, for the header.
 *
 * Same 16px box and the same stroke as the view icons, so it sits on the same optical line as the
 * three next to it. Three strokes: the disc, the equator, and one meridian bowed the way a sphere
 * bows it. A second meridian is what most globe glyphs add and what turns this into mud at 16px.
 */
export function GlobeIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M2.5 8h11" />
      <path d="M8 2.5c1.7 1.5 2.6 3.4 2.6 5.5S9.7 12 8 13.5C6.3 12 5.4 10.1 5.4 8S6.3 4 8 2.5Z" />
    </svg>
  )
}

/**
 * The language picker: a globe, a search box and a list.
 *
 * Not the house `Menu`. `Menu` documents typeahead as the one thing it does not do, and
 * thirty-five languages are unusable without it. A text input is allowed here — the rule the
 * project keeps is against `<select>`, checkboxes and radios, which draw OS widgets no CSS
 * reaches. This draws itself.
 *
 * The input keeps focus the whole time it is open and `aria-activedescendant` names the row the
 * arrows have reached, because moving real focus to a row would take the keyboard away from the
 * box the reader is still typing in. Everything else matches `Menu`: pointer-down anywhere else
 * closes it, Escape closes it and gives the trigger its focus back, Enter picks.
 *
 * It does not reuse `.menu-list`. That class scrolls its whole body, which would carry the search
 * box off the top of the popover; here the panel holds still and only the list under it scrolls.
 * The shadow and the surface are copied from it so the two read as the same object.
 */
export function LanguagePicker({ className = '' }: { className?: string }) {
  const code = useLocale()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  // Viewport y of the popover's top edge, for the narrow layout. See the panel below.
  const [anchorTop, setAnchorTop] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const id = useId()

  const current = localeOf(code)
  const matches = filterLocales(query)
  const label = t('language.label', { language: current.endonym })

  function close() {
    setOpen(false)
    trigger.current?.focus()
  }

  useEscape(() => {
    if (open) close()
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

  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])

  // The narrow layout hangs the popover from a viewport coordinate, so a resize that rewraps the
  // header moves the trigger out from under it. Scrolling does not: both headers are sticky.
  useEffect(() => {
    if (!open) return
    const place = () => {
      const box = trigger.current?.getBoundingClientRect()
      if (box) setAnchorTop(Math.round(box.bottom + 4))
    }
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  // The active row has no focus to scroll to it, so it is scrolled to by hand.
  useEffect(() => {
    if (!open) return
    const rows = list.current?.querySelectorAll<HTMLElement>('[role="option"]')
    rows?.[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  function pick(next: LocaleCode) {
    void setLocale(next)
    // On the landing page a language is also a URL, so choosing one moves there — the reader
    // ends up with an address they can copy in the language they are reading, and the page's
    // `hreflang` alternates get a human way in. Inside the app there is nowhere to move to.
    //
    // Same page, so the scroll holds and the history entry is replaced rather than added. See
    // `navigate` for why a push would leave Back showing German at an English URL.
    const to = localeHref(window.location.pathname, window.location.hash, next)
    if (to) navigate(to, { keepScroll: true, replace: true })
    close()
  }

  function onKey(e: React.KeyboardEvent) {
    if (matches.length === 0 && e.key !== 'Tab') return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((k) => (k + 1) % matches.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((k) => (k - 1 + matches.length) % matches.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(matches.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = matches[active]
      if (hit) pick(hit.code)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  return (
    <div ref={box} className={`relative ${className}`}>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className="hdr-btn"
        onClick={() => {
          if (open) return setOpen(false)
          setQuery('')
          setActive(Math.max(0, filterLocales('').findIndex((l) => l.code === code)))
          // Read here rather than in a layout effect: this runs before the popover paints, so it
          // never appears at the top of the screen for a frame. A layout effect would also warn
          // under `renderToStaticMarkup`, which the prerender and three test files use.
          const box = trigger.current?.getBoundingClientRect()
          setAnchorTop(box ? Math.round(box.bottom + 4) : 0)
          setOpen(true)
        }}>
        <GlobeIcon />
      </button>

      {open && (
        /*
          Two layouts, because thirty-five rows are wider than a phone.

          From `sm:` up it is 16rem hung from the trigger's trailing edge. `end-0`, not `right-0`:
          the list grows back towards the middle of the header, so it mirrors correctly in Arabic
          instead of running off the opposite side.

          Below that it spans the viewport instead, and that is the fix rather than a nicety. The
          trailing edge only has 16rem behind it when the trigger is the last thing in the header.
          It is on the landing page and it is not in the app, where two more buttons and the
          wallet follow it — measured at 375px, the app put x=-76 of the panel off the left edge,
          taking the search box and eight rows with it. Anchoring to the viewport does not care
          where the trigger sits.

          Which leaves the vertical, and there is no CSS for `fixed` horizontally and `absolute`
          vertically. So the trigger's own bottom edge comes in as `--picker-top`, read at the
          moment of opening.
        */
        <div
          style={{ '--picker-top': `${anchorTop}px` } as React.CSSProperties}
          className="fixed z-40 inset-x-2 top-(--picker-top) p-1 bg-(--color-panel-2) shadow-[0_0_0_1px_var(--color-line),0_12px_32px_-8px_rgb(0_0_0/0.7)] sm:absolute sm:inset-x-auto sm:end-0 sm:top-[calc(100%+4px)] sm:w-64">
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-activedescendant={matches[active] ? `${id}-${matches[active].code}` : undefined}
            aria-label={t('language.search')}
            aria-autocomplete="list"
            placeholder={t('language.search')}
            className="field text-xs"
            value={query}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setQuery(e.target.value)
              setActive(0)
            }}
            onKeyDown={onKey}
          />

          <div
            ref={list}
            id={`${id}-list`}
            role="listbox"
            aria-label={t('language.list')}
            className="mt-1 max-h-64 overflow-y-auto">
            {matches.map((l, k) => (
              <div
                key={l.code}
                id={`${id}-${l.code}`}
                role="option"
                aria-selected={l.code === code}
                // The endonym is written in its own language, so it carries its own `lang` and its
                // own direction. Without them a browser hyphenates Arabic as if it were English
                // and reads 한국어 in an English voice.
                lang={l.code}
                dir={l.rtl ? 'rtl' : 'ltr'}
                className={`menu-item ${l.code === code ? 'menu-item-on' : ''} ${
                  k === active ? 'bg-(--color-line) text-(--color-bright)' : ''
                }`}
                // The input must not lose focus to a row, or the reader's next keystroke goes
                // nowhere. The click still lands; only the focus change is cancelled.
                onPointerDown={(e) => e.preventDefault()}
                onClick={() => pick(l.code)}
                onMouseEnter={() => setActive(k)}>
                <span className="menu-lead truncate">{l.endonym}</span>
                {/*
                  The gap belongs to the row, the direction belongs to the word. `ps-3` on this
                  span resolves against the row's own `dir`, so the padding always lands between
                  the two names; the `bdi` inside isolates the English exonym so it reads left to
                  right even on the Arabic and Hebrew rows. Putting `dir="ltr"` on the padded span
                  instead flipped the padding to the outer edge and the two names touched.
                */}
                <span className="ps-3 text-[11px] text-(--color-dim) truncate">
                  <bdi>{l.exonym}</bdi>
                </span>
              </div>
            ))}
            {matches.length === 0 && (
              <p role="status" className="px-2 py-2 text-xs text-(--color-dim)">
                {t('language.none')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

import { type CustodyMode } from '@prove.cash/sdk'
import { type Ctx, LADDER, RUNGS, WHERE, whereSpoken, whereText, whereTone } from '../lib/custody'
import { t } from '../lib/i18n'
import { RungGlyph, WhereGlyph } from './StateIcon'

/**
 * The custody chooser, strongest rung first.
 *
 * The app already picks the strongest rung the token supports, so this is an override, not a
 * question. It lives inside the compose form's advanced panel; the collapsed form states the
 * choice in one line. Each rung prices itself in signatures and transactions, in and out, and
 * names where the tokens sit. A rung that cannot be climbed says why in two words and stays
 * unclickable — that reason is why the maker got the rung they got.
 *
 * The rungs and their order come from `lib/custody`, so the form and the chooser cannot disagree
 * about which rung is available or which one is strongest.
 */
export function CustodyLadder({
  ctx,
  mode,
  onMode,
}: {
  ctx: Ctx
  mode: CustodyMode
  onMode: (m: CustodyMode) => void
}) {
  return (
    <div role="group" aria-label={t('custody.group')}>
      {LADDER.map((m) => {
        const r = RUNGS[m](ctx)
        const where = WHERE[m]
        const locked = r.lock !== undefined
        const selected = !locked && mode === m
        return (
          /*
            The tip wraps the whole button, because a tab stop inside a button is not allowed and
            the button is where the keyboard lands. `:focus-within` shows the word when the rung
            has focus; hover shows it anywhere on the row. The body sits at the trailing edge,
            over the glyph it names.
          */
          <span key={m} className="tip relative block">
            <button
              type="button"
              disabled={locked}
              aria-pressed={locked ? undefined : selected}
              aria-label={
                locked
                  ? t('custody.locked', { name: r.name, reason: r.lock ?? '' })
                  : t('custody.rung.label', {
                      name: r.name,
                      where: whereSpoken(where),
                      cost: r.spoken,
                    })
              }
              onClick={() => onMode(m)}
              // The row takes the panel's padding back so the hover and the selection bar reach
              // both edges, and hands it straight back with `gutter` so the text still lines up.
              // The width is spelled out: `w-full` with negative margins over-constrains the box
              // and only the leading margin lands, and a bare button shrinks to its content.
              className={`bleed w-[calc(100%+1rem)] sm:w-[calc(100%+2rem)] gutter flex flex-wrap items-center gap-x-2.5 gap-y-1 py-2 text-start transition-colors ${
                locked ? 'opacity-45 cursor-not-allowed' : 'hover:bg-(--color-panel-2)'
              } ${selected ? 'row-selected' : ''}`}>
              {/*
                Selection is said four ways, because the badge column alone said nothing: a filled
                disc, a painted bar down the leading edge, a brighter name, and the only where-glyph
                at full strength. Two rungs share `in wallet`, so the glyph cannot carry selection
                on its own. The unselected glyphs keep their hue, so the ladder still reads as an
                ordering, but they recede.
              */}
              <span
                aria-hidden="true"
                className={`inline-block w-2 h-2 rounded-full border ${
                  selected
                    ? 'bg-(--color-proven) border-(--color-proven)'
                    : 'border-(--color-line-bright)'
                }`}
              />
              {/* The rung's mark, beside its name. The name stays: it is the choice. */}
              <span
                aria-hidden="true"
                className={`inline-flex shrink-0 ${selected ? 'text-(--color-bright)' : 'text-(--color-dim)'}`}>
                <RungGlyph mode={m} size={14} />
              </span>
              <span
                className={`text-sm ${selected ? 'text-(--color-bright) font-medium' : 'text-(--color-body)'}`}>
                {r.name}
              </span>
              <span className="num text-[11px] text-(--color-dim) whitespace-nowrap">{r.cost}</span>
              <span className="num text-[11px] text-(--color-dim) whitespace-nowrap">{r.exit}</span>
              {locked ? (
                <span className="ms-auto text-[11px] uppercase tracking-wider whitespace-nowrap text-(--color-dim)">
                  {r.lock}
                </span>
              ) : (
                <span
                  aria-hidden="true"
                  className={`ms-auto inline-flex shrink-0 ${whereTone(where)} ${selected ? '' : 'opacity-50'}`}>
                  <WhereGlyph where={where} size={14} />
                </span>
              )}
            </button>
            {!locked && (
              <span role="tooltip" className="tip-body tip-end">
                {whereText(where)} — {whereSpoken(where)}
              </span>
            )}
          </span>
        )
      })}
    </div>
  )
}

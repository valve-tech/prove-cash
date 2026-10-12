import { useRef } from 'react'
import { displaySymbol, type TokenInfo } from '@prove.cash/sdk'
import { units } from '../lib/amount'
import { t } from '../lib/i18n'
import { spokenAmount } from '../lib/speech'
import { TokenAvatar } from './TokenAvatar'
import { WrapChip } from './TokenPicker'
import { ChevronIcon } from './ChevronIcon'

/**
 * The three controls every form on this site is built out of: a chip, a token button, and the
 * amount card that holds both.
 *
 * They were private to `Compose.tsx` while the sign form was the only place a person typed a
 * number. The exclusive-quote surfaces type four more, and a second copy of the amount card is a
 * second set of answers about decimals, balances, focus rings and what a screen reader hears. So
 * they live here and both surfaces import them.
 *
 * Nothing here is rounded except the chip and the token button, and both always sit inside
 * somebody else's padding. The amount card can reach the edge of a 375px screen, so it stays
 * square and takes its outline from an outset shadow — see `.field-card` in `index.css`.
 */

/**
 * One pill in a row of choices. Never a radio: the browser owns a radio's appearance and it
 * always reads as foreign chrome.
 *
 * `mono` is on by default because most of these carry a figure — `15m`, `1h`, `0.05%` — and a
 * proportional face makes a row of them jump about as the selection moves. A chip holding a word
 * turns it off.
 */
export function Chip({
  selected,
  onClick,
  children,
  disabled = false,
  warn = false,
  label,
  title,
  mono = true,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
  disabled?: boolean
  /**
   * A choice that works and carries a cost worth reading first.
   *
   * Distinct from `disabled` on purpose. A disabled chip says the system will not do this; a
   * warned one says it will, and here is what you are taking on. Reaching for `disabled` to
   * discourage a legal choice is how a form ends up enforcing a rule nothing else enforces.
   */
  warn?: boolean
  /** What a screen reader hears. Leave it out when the face is already the whole word. */
  label?: string
  title?: string
  mono?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={disabled ? undefined : selected}
      aria-label={label}
      title={title}
      className={`${mono ? 'num ' : ''}text-xs px-2.5 py-1 rounded-full border transition-colors ${
        disabled
          ? 'hair text-(--color-dim) opacity-40 cursor-not-allowed'
          : selected
            ? warn
              ? 'border-(--color-unproven)/50 text-(--color-unproven) bg-(--color-unproven)/8'
              : 'border-(--color-proven)/50 text-(--color-proven) bg-(--color-proven)/8'
            : warn
              ? 'hair text-(--color-unproven) hover:border-(--color-unproven)/50'
              : 'hair text-(--color-body) hover:border-(--color-line-bright)'
      }`}>
      {children}
    </button>
  )
}

/** The token on one side of a trade, and the button that changes it. */
export function TokenButton({
  token,
  onClick,
  side,
}: {
  token: TokenInfo | null
  onClick: () => void
  side: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        token
          ? t('sign.token.change', { side, symbol: displaySymbol(token) })
          : t('sign.token.choose', { side })
      }
      className="flex items-center gap-1.5 shrink-0 px-3 py-2 rounded-xl bg-(--color-panel-2) border hair hover:border-(--color-line-bright) transition-colors">
      {token && <TokenAvatar token={token} size={20} />}
      <span className="text-sm font-semibold text-(--color-bright)">
        {token ? displaySymbol(token) : t('sign.token.select')}
      </span>
      {token?.wraps && <WrapChip />}
      <span className="inline-flex text-(--color-dim) text-xs" aria-hidden="true">
        <ChevronIcon />
      </span>
    </button>
  )
}

/** One side of a trade: a label, a balance, a big number, and the token it is denominated in. */
export function AmountRow({
  id,
  label,
  side,
  amount,
  onAmount,
  token,
  onPickToken,
  balance,
  onMax,
  error,
}: {
  id: string
  label: string
  side: string
  amount: string
  onAmount: (v: string) => void
  token: TokenInfo | null
  onPickToken: () => void
  balance: bigint | null
  onMax?: () => void
  error?: string | null
}) {
  const errorId = `${id}-error`
  const balanceId = `${id}-balance`
  const amountRef = useRef<HTMLInputElement>(null)
  return (
    <div
      className="field-card panel-ink p-2 sm:p-4 grid gap-1.5"
      /*
        The whole card is the field, so clicking anywhere in it puts the caret in the amount —
        the way clicking the padding of a native input does. Only the amount: the token button
        and the max button inside are their own controls and keep their own behaviour.

        `mousedown`, not `click`, so focus lands before the browser decides what was selected,
        and `preventDefault` so a click on the card's whitespace does not start a text selection.
      */
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('button, input, a')) return
        e.preventDefault()
        amountRef.current?.focus()
      }}>
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-[11px] uppercase tracking-wider text-(--color-dim)">
          {label}
        </label>
        {token && balance !== null && (
          <span className="num text-[11px] text-(--color-dim)">
            <span id={balanceId}>
              <span aria-hidden="true">
                {t('sign.balance.short', { amount: units(balance, token.decimals) })}
              </span>
              <span className="sr-only">
                {t('sign.balance', {
                  amount: spokenAmount(balance, token.decimals, displaySymbol(token)),
                })}
              </span>
            </span>
            {onMax && (
              <button
                type="button"
                onClick={onMax}
                aria-label={t('sign.max.label')}
                className="ms-1.5 text-(--color-proven) hover:underline">
                {t('sign.max')}
              </button>
            )}
          </span>
        )}
      </div>
      {/* `min-w-0`: a grid item is floored at its min-content width, and the input's is 297px. */}
      <div className="flex items-center gap-2 min-w-0">
        <input
          id={id}
          ref={amountRef}
          className="field-amount num flex-1 min-w-0 bg-transparent text-2xl text-(--color-bright) placeholder:text-(--color-dim)/70"
          inputMode="decimal"
          placeholder="0"
          value={amount}
          // The visible label opens the name, so a voice user can still say it. The unit is
          // appended because "you want at least" is not a question anyone can answer blind.
          aria-label={token ? t('sign.amount.in', { label, symbol: displaySymbol(token) }) : label}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [error ? errorId : null, token && balance !== null ? balanceId : null]
              .filter(Boolean)
              .join(' ') || undefined
          }
          onChange={(e) => onAmount(e.target.value)}
        />
        <TokenButton token={token} onClick={onPickToken} side={side} />
      </div>
      {error && (
        <p id={errorId} role="alert" className="text-[11px] text-(--color-danger)">
          {error}
        </p>
      )}
    </div>
  )
}

import { formatUnits } from 'viem'
import { num, t } from './i18n'

/**
 * What a typed amount means, for every form that takes one.
 *
 * This lived inside `Compose.tsx` while the sign form was the only surface that asked a person
 * for a number. The exclusive-quote surfaces ask for four more — the size a maker quotes, the
 * price they name, and the two sides of an acceptance — and a second copy of the rules below is
 * how one form starts accepting a separator, or a decimal place, that another refuses.
 */

/**
 * A typed amount with the reader's decimal separator accepted.
 *
 * Most of the world writes 1,5 rather than 1.5, and their keyboard puts the comma where a
 * numeric keypad expects it. This field validated `/^\d*\.?\d*$/` — a full stop and nothing
 * else — so a maker in Berlin, Paris, Amsterdam, Copenhagen or Oslo typed the separator their
 * language uses and the field told them it was not a number.
 *
 * Five locales had translated `sign.amount.digits` faithfully into "Komma", "virgule", "komma",
 * "decimaltegn" and "desimaltegn", pointing the reader at exactly the character the field
 * rejected. The translations were right about the language and the field was wrong about the
 * world, so the field changes.
 *
 * A comma becomes a full stop and everything downstream — `Number`, `parseUnits`, the validator —
 * keeps seeing one separator. Thousands separators are still refused: "1,000.5" becomes
 * "1.000.5", which fails validation exactly as it did before.
 */
export const normalizeAmount = (text: string) => text.replace(/,/g, '.')

/**
 * What is wrong with a typed amount, in a sentence a screen reader can read out. Returns null
 * while the field is empty, because an untouched field is not a mistake.
 */
export function amountError(text: string, decimals?: number): string | null {
  const typed = text.trim()
  if (typed === '') return null
  if (!/^\d*\.?\d*$/.test(typed) || typed === '.') return t('sign.amount.digits')
  if (Number(typed) === 0) return t('sign.amount.zero')
  const frac = typed.split('.')[1] ?? ''
  if (decimals !== undefined && frac.length > decimals) {
    return t('sign.amount.decimals', { count: decimals })
  }
  return null
}

/** The reader's decimal separator. */
function decimalMark(): string {
  return num(1.5).replace(/\d/g, '') || '.'
}

/**
 * A token amount for display, in the reader's locale.
 *
 * The precision rule is the SDK's `fmt`: at most four decimals above one, and `max + 4` below
 * it, trailing zeros cut. Only the separators change. The whole part goes through `num` as a
 * bigint, so it keeps every digit.
 */
export function units(amount: bigint, decimals: number, max = 6): string {
  const s = formatUnits(amount, decimals)
  const negative = s.startsWith('-')
  const [whole, frac = ''] = (negative ? s.slice(1) : s).split('.')
  const big = BigInt(whole) !== 0n
  const trimmed = frac.slice(0, big ? Math.min(max, 4) : max + 4).replace(/0+$/, '')
  const head = (negative ? '-' : '') + num(BigInt(whole))
  return trimmed ? `${head}${decimalMark()}${trimmed}` : head
}

/** Stats-bar numbers in the reader's locale: compact from a thousand up, `units` below. */
export function unitsCompact(amount: bigint, decimals: number): string {
  const n = Number(formatUnits(amount, decimals))
  if (!isFinite(n)) return '—'
  if (Math.abs(n) >= 1000) return num(n, { notation: 'compact', maximumFractionDigits: 2 })
  return units(amount, decimals, 4)
}

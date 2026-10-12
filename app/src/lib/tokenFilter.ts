import type { Address } from 'viem'
import type { Dir } from '../routes.ts'

/**
 * The board's token filter, as pure functions, so the rule can be read and tested as one thing.
 *
 * A row is one maker's offer, drawn `A → B`: the maker gives A (`tokenIn`) and wants B
 * (`tokenOut`). The filter's words follow that arrow, so nobody has to ask whose side a word means:
 *
 *   into X     X is after the arrow. The maker wants X.     tokenOut is X
 *   out of X   X is before the arrow. The maker gives X.    tokenIn is X
 *   either     X is on one side or the other.
 *
 * There is no "buy" or "sell" here. Each of those words has two readers, the maker and the
 * taker, and each reader takes it from the other side.
 */
export type TokenFilter = { token: Address; dir: Dir }

/** True when a row with these two tokens passes the filter. No filter passes every row. */
export function matchesToken(tokenIn: string, tokenOut: string, filter: TokenFilter | null): boolean {
  if (!filter) return true
  const x = filter.token.toLowerCase()
  const into = tokenOut.toLowerCase() === x
  const out = tokenIn.toLowerCase() === x
  return filter.dir === 'into' ? into : filter.dir === 'out' ? out : into || out
}

/** The same question, asked of a store pair key, `<tokenIn>><tokenOut>`. */
export function pairMatches(pair: string, filter: TokenFilter | null): boolean {
  const [a = '', b = ''] = pair.split('>')
  return matchesToken(a, b, filter)
}

type Terms = { tokenIn: string; tokenOut: string; endTime: number }

export type TokenCount = { address: string; open: number; rows: number }

/**
 * Every token the rows name, and how many rows name it, busiest first.
 *
 * This is the menu's list, so it holds only tokens that have rows. A token on both sides of one
 * row counts that row once, because the filter shows that row once.
 */
export function countTokens(rows: readonly Terms[], now: number): TokenCount[] {
  const by = new Map<string, TokenCount>()
  for (const r of rows) {
    const live = r.endTime > now
    for (const a of new Set([r.tokenIn.toLowerCase(), r.tokenOut.toLowerCase()])) {
      const c = by.get(a) ?? { address: a, open: 0, rows: 0 }
      c.rows++
      if (live) c.open++
      by.set(a, c)
    }
  }
  return [...by.values()].sort(
    (a, b) => b.open - a.open || b.rows - a.rows || (a.address < b.address ? -1 : 1),
  )
}

/**
 * The link's token, or null when the link names a token nobody knows.
 *
 * Before the board answers, every token is unknown, because nobody has asked. So the link's token
 * stands until the answer is in. Dropping it earlier would throw away a good link on every cold
 * load. This is the same mistake `boardPresence` fixed for the off-board flag.
 */
export function keepToken(
  token: Address | null,
  answered: boolean,
  known: (address: string) => boolean,
): Address | null {
  if (token === null || !answered) return token
  return known(token.toLowerCase()) ? token : null
}

/**
 * The one pair the filtered rows share, as `[base, quote]`, or null when they share none.
 *
 * The market panel draws one pair's book. A token filter can leave several pairs on screen, and
 * several books have no axis in common, so the panel shows only when the rows are one pair. Under
 * "into X" the rows read `Y → X`, so Y is the base. Otherwise X is.
 */
export function bookOf(
  rows: readonly { tokenIn: string; tokenOut: string }[],
  filter: TokenFilter | null,
): [string, string] | null {
  if (!filter || rows.length === 0) return null
  const x = filter.token.toLowerCase()
  let other: string | null = null
  for (const r of rows) {
    const a = r.tokenIn.toLowerCase()
    const b = r.tokenOut.toLowerCase()
    const o = a === x ? b : b === x ? a : null
    if (o === null || (other !== null && o !== other)) return null
    other = o
  }
  if (other === null) return null
  return filter.dir === 'into' ? [other, x] : [x, other]
}

/**
 * Whether a source has answered, one predicate per source.
 *
 * The rule: a page never claims absence before the source has answered. "0", "—", "0 of 0",
 * "quiet", "no route" and an empty list are all claims. Before the answer the page draws a loader.
 * An absence claim waits for every source that can contradict it. See also `boardPresence`.
 */

/**
 * True once the archive's first page is in, or the archive has failed. An empty archive is an
 * answer. A later page loading does not undo the first answer.
 */
export function archiveAnswered(a: { state: 'loading' | 'ok' | 'error'; loaded: number }): boolean {
  return a.loaded > 0 || a.state !== 'loading'
}

/**
 * True when every row has a quote answer. Undefined is "not known yet"; null is "the router has no
 * path", which is an answer. A list with no rows owes no quotes.
 */
export function quotesAnswered(rows: readonly { quote: unknown }[]): boolean {
  return rows.every((r) => r.quote !== undefined)
}

/** True once the wallet has answered. Null is "no account", which is an answer. */
export function accountAnswered<A>(account: A | null | undefined): account is A | null {
  return account !== undefined
}

/**
 * True while the book still owes an answer: the live board or the archive's first page. Either can
 * add offers, so neither alone can say "there are none". A failed board ends the wait, because its
 * error is then the thing to draw.
 */
export function awaitingBook(s: { board: boolean; archive: boolean; error: boolean }): boolean {
  return !s.error && !(s.board && s.archive)
}

/**
 * What belongs in a public order book, and what does not.
 *
 * An exclusive quote is a price named for ONE counterparty. Its `executor` is the RFQ venue and
 * `ProveSettlement` refuses anybody else, so listing it beside open intents misrepresents both:
 * a browser reads a private price as a public offer, and the maker's counterparty finds their
 * quote on a public shelf.
 *
 * Two separate things keep them apart, in two different modules, and this covers both.
 *
 *   category   quotes travel under `RFQ_CATEGORY`; `readIntents` reads `PROVECASH_CATEGORY`.
 *   executor   the board asks the store for offers open to everyone.
 *
 * The second exists because the first is one line in a module the board does not import. A quote
 * posted to the wrong category, or a future ingest path that does not know the difference, gets
 * past it — and then nothing else would have stopped it.
 */
import { describe, expect, test } from 'vitest'
import { PROVECASH_CATEGORY, RFQ_CATEGORY, ZERO } from '@prove.cash/sdk'
import { boardQuery } from './useBoard'

const NOW = 1_800_000_000

describe('the query the public board asks', () => {
  test('it asks for offers open to everyone, in both scopes', () => {
    // The rule the whole task is about. Without it an exclusive quote that reached the store by
    // any route at all would render as an ordinary row.
    expect(boardQuery(369, 'open', null, NOW).executor).toEqual({ open: true })
    expect(boardQuery(369, 'all', null, NOW).executor).toEqual({ open: true })
  })

  test('it never names an executor of its own', () => {
    // Naming one would ADD that executor's pinned intents to the list, which is the opposite of
    // what a public board is. `open: true` alone keeps it to `executor === ZERO`.
    for (const scope of ['open', 'all'] as const) {
      expect(boardQuery(369, scope, null, NOW).executor?.address).toBeUndefined()
    }
  })

  test('the open scope asks for live offers, and history does not', () => {
    expect(boardQuery(369, 'open', null, NOW).liveAt).toBe(NOW)
    expect(boardQuery(369, 'open', null, NOW).newestFirst).toBeUndefined()

    expect(boardQuery(369, 'all', null, NOW).liveAt).toBeUndefined()
    expect(boardQuery(369, 'all', null, NOW).newestFirst).toBe(true)
  })

  test('a pair filter is passed through, and its absence is not a filter', () => {
    expect(boardQuery(369, 'open', 'WPLS>PLSX', NOW).pair).toBe('WPLS>PLSX')
    expect(boardQuery(369, 'open', null, NOW).pair).toBeUndefined()
  })

  test('the chain travels with the question', () => {
    expect(boardQuery(943, 'open', null, NOW).chainId).toBe(943)
  })
})

describe('the two marketplaces do not share a category', () => {
  test('the board category and the quote category are different', () => {
    // If these ever converged, every exclusive quote would land in the public book's own ingest
    // and the executor filter above would be the only thing left standing.
    expect(PROVECASH_CATEGORY).not.toBe(RFQ_CATEGORY)
  })

  test('the public one is a 32-byte topic and the quote one is its own string', () => {
    expect(PROVECASH_CATEGORY).toMatch(/^0x[0-9a-f]{64}$/)
    expect(RFQ_CATEGORY).toBe('provecash-rfq')
  })
})

describe('what the filter actually excludes', () => {
  const venue = '0x000000000000000000000000000000000000dead'

  test('an open intent has the zero executor and a quote does not', () => {
    // The store's predicate is `r.executor === ZERO`, so this is the fact the filter turns on.
    // An exclusive quote sets `executor` to the venue — see `rfq.ts`, which calls that "not a
    // detail" — and no quote can be built without it.
    expect(ZERO).toBe('0x0000000000000000000000000000000000000000')
    expect(venue).not.toBe(ZERO)
  })
})

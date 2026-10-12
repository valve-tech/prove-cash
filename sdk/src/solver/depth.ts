import { presetTokens, type ChainId } from '../config.js'

/**
 * How deep to index each direction.
 *
 * A solver keeps the best few entries per direction and enumerates rings over those. One number
 * for every direction is the wrong shape at scale. A hub token carries most of the routes, so it
 * earns a deep index; a token nobody trades earns one or two entries. At 10,000 tokens and 15,000
 * directions the difference is the whole memory budget.
 *
 * The table is a `Map` keyed by the lowercase address, because that is what the book's pair keys
 * already hold — resolving a direction's depth is then two map reads and no parsing. A tiers
 * object would read well in a config file and would cost a second lookup on the hot path, so the
 * tiers live in the comments beside the numbers instead.
 */

/** Entries kept per direction when no table names either of its tokens. */
export const DEFAULT_MAX_PER_PAIR = 8

/** A per-token depth table, with the depth a token it does not name gets. */
export type PairDepth = {
  /** Depth by token address, lowercase. */
  byToken?: ReadonlyMap<string, number>
  /** Depth for a token `byToken` does not name. Falls back to `DEFAULT_MAX_PER_PAIR`. */
  default?: number
}

/** One depth for the whole book, or a table. A plain number keeps the old caller working. */
export type MaxPerPair = number | PairDepth

/**
 * The depth of one direction: the larger of what its two tokens ask for.
 *
 * The argument for the larger one is that the cap only binds when the entries exist. A direction
 * holds the offers somebody actually signed, so a generous cap on WPLS→OBSCURE costs nothing
 * while the obscure token stays obscure, and it keeps every offer on the day it stops being
 * obscure. Take the smaller one and the thinnest token in a pair decides: almost every hub
 * direction pairs the hub with something thin, so the hub's deep index would apply to hub-to-hub
 * directions only — a handful — and the deep indexing would buy nothing.
 *
 * The cost of the larger one is the honest one to state: a token set to 64 raises every direction
 * it touches to 64, so a hub's depth multiplies by its degree. That is the intent. Size a hub by
 * what its whole fan-out may hold, not by one direction.
 *
 * `from` and `to` may arrive in any case. The book's pair keys are lowercase already, so the
 * normalisation costs nothing on the hot path.
 */
export function depthFor(limit: MaxPerPair | undefined, from: string, to: string): number {
  if (limit === undefined) return DEFAULT_MAX_PER_PAIR
  if (typeof limit === 'number') return limit > 0 ? limit : 0
  const fallback = limit.default ?? DEFAULT_MAX_PER_PAIR
  const a = limit.byToken?.get(from.toLowerCase()) ?? fallback
  const b = limit.byToken?.get(to.toLowerCase()) ?? fallback
  const d = a > b ? a : b
  // A negative depth would reach `slice(0, -1)` and quietly drop the last entry instead of
  // keeping none, so clamp here rather than at the call site.
  return d > 0 ? d : 0
}

/**
 * Build a table from preset symbols, so a redeployed test token cannot stale an address here.
 *
 * A symbol the registry does not carry is dropped. `solver.test.ts` counts the entries, which is
 * what catches a rename.
 */
function bySymbol(chainId: ChainId, depths: Readonly<Record<string, number>>): Map<string, number> {
  const out = new Map<string, number>()
  for (const t of presetTokens(chainId)) {
    const d = depths[t.symbol]
    if (d !== undefined) out.set(t.address.toLowerCase(), d)
  }
  return out
}

/**
 * Chain 943, sized by role rather than by measurement.
 *
 * These numbers are a starting point and nothing more. Nobody has measured how the testnet book
 * spreads over its directions, and the live board is 360 messages of mostly end-to-end traffic,
 * so it cannot answer the question yet. Re-cut the table from the archive before trusting it.
 *
 *   hubs    tPLSX, WPLS — most rings route through one of them
 *   quotes  tUSDC, tUSDT — the pair a price is usually quoted against
 *   thin    tWBTC, tWETH, tHEX — real tokens, few offers
 *   rest    the default, 2, because an unnamed token in a 10,000-token universe is obscure
 *
 * PLSX and HEX on 943 carry their mainnet addresses and no testnet liquidity, so they take the
 * default with everything else.
 */
export const DEPTH_943: PairDepth = {
  byToken: bySymbol(943, {
    tPLSX: 64,
    WPLS: 64,
    tUSDC: 32,
    tUSDT: 32,
    tWBTC: 8,
    tWETH: 8,
    tHEX: 8,
  }),
  default: 2,
}

/**
 * The table a chain starts from, or undefined where nobody has cut one.
 *
 * Mainnet 369 has no settlement contract yet, so it has no book to ration and no table.
 */
export const presetDepth = (chainId: ChainId): PairDepth | undefined =>
  chainId === 943 ? DEPTH_943 : undefined

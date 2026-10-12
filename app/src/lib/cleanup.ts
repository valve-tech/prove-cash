import type { ChainId } from '@prove.cash/sdk'
import type { Address } from 'viem'
import { defaultRoute, routeLink, type Route } from '../routes.ts'

/**
 * The cleanup link, `#/<chainId>/cleanup/<address>`.
 *
 * A maker who escrows an intent and walks away leaves money in the settlement contract. Nothing
 * expires it, so somebody has to reach the maker: a solver, a support channel, the maker's other
 * device. This is the URL they send.
 *
 * The address in the link is the subject, not the reader. Anybody may open the link, and only the
 * named wallet can send the transactions the page offers.
 *
 * The chain rides along because a signature means one thing on one chain, and a link that leaves
 * it to the reader's last selection points at the wrong book.
 *
 * The link used to live in the path. `legacyCleanupRedirect` in `surface.ts` still reads that
 * shape and rewrites it to this one.
 */

/** The route for one address on one chain. */
export function cleanupRoute(chainId: ChainId, address: Address): Route {
  // Lower case, so the same wallet never produces two links. The parser matches either.
  return { ...defaultRoute(chainId), view: 'cleanup', address: address.toLowerCase() as Address }
}

/** The whole URL, for the clipboard. */
export function cleanupLink(origin: string, chainId: ChainId, address: Address): string {
  return routeLink(origin, cleanupRoute(chainId, address))
}

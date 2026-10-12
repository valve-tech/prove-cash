import type { Address } from 'viem'
import { getChainId, kv, settlementLive, type ChainId } from '@prove.cash/sdk'

/**
 * Where `RfqVenue` is, per chain.
 *
 * **This table should not be here, and it is the one thing in these surfaces that belongs in the
 * SDK.** Every other address the app needs comes from `NETWORKS` — the settlement, the fee
 * destination, the routers — and the venue does not, on purpose: `contracts/deployments/369.json`
 * argues that a quote names the venue in `Intent.executor`, so nothing has to look it up. That is
 * true of a solver reading a quote off the board. It is not true of the maker writing one, who
 * has to put an address in that field before there is a quote to read it out of.
 *
 * So the app carries a copy of two addresses out of `contracts/deployments/*.json`, and a copy is
 * a thing that goes stale. `RfqVenue` binds to the settlement in its constructor, so the next
 * settlement redeploy moves it — the same coupling the 943 entry in `sdk/src/config.ts` records
 * for `ProveRelayer`.
 *
 * **A stale entry is silent through five steps.** The maker signs; the board takes the post; the
 * counterparty's card reports zero faults; the submitter's preview renders a margin; and only
 * `settleExclusive` reverts. Nothing before the chain has anything to compare against.
 *
 * The revert is `BindingIsForAnotherIntent`, not `QuoteNotExclusiveToThisVenue`, and the
 * difference says where the mismatch really is. `_checkBinding` asks first whether the quote
 * names this venue, and it does — the table is stale in one direction, so the maker and the
 * submitter reach the same old contract and agree with each other. What they do not agree with is
 * the chain: `Exclusive.intentHash` is built here under `settlement(chainId)`, the registry's
 * current settlement, while the old venue asks ITS settlement to hash the quote. Two domains, two
 * hashes, and the binding-identity check is the first thing to notice.
 *
 * A reader is told none of that. `errorLine` keeps viem's first line, which is the generic
 * "reverted" wrapper; the custom error name lives further down the report and never reaches the
 * screen. So the whole of this failure, on screen, is a transaction that did not go through.
 *
 * **A `rfqVenue` field on `NETWORKS` would not fix it.** It moves the copy into the SDK and
 * leaves it a copy — stale in exactly the same way, on the same day, with the same silence. The
 * durable answer is to ask the chain: read `venue.settlement()` once and refuse the quote unless
 * it equals `settlement(chainId)`. That is one `eth_call`, it needs no registry field, and it
 * turns this from silent-until-settlement into loud on the first quote. `check-addresses.ts`
 * holds the table to the deployment record meanwhile. That catches the table drifting from the
 * record. It cannot catch the record itself being the stale one.
 *
 * `provecash.rfqVenue.<chainId>` in `localStorage` is the escape hatch, and it exists for exactly
 * one reader: the local anvil lab, whose venue is at neither address below.
 */
// `check-addresses.ts` parses these entries out of this file and compares each one with
// `contracts/deployments/<chain>.json`. It reads the source rather than importing the value, so
// keep the shape — one `<chainId>: '0x…',` per line. An address the parser cannot place fails
// the gate rather than being skipped.
const DEPLOYED: Partial<Record<ChainId, Address>> = {
  // contracts/deployments/943.json, redeployed whole 2026-10-01 with the settlement.
  943: '0x48ebDd0770934799288ab826C439aa029B482896',
  // contracts/deployments/369.json, deployed 2026-08-25. Unreachable from this app today: the
  // registry carries no settlement for 369, so `settlementLive` is false and `rfqVenue` below
  // answers null. It is written down because the deployment exists, not because it is usable.
  369: '0x6E94A88973f7D1cDcd59A5B0ef21C84eBdA09F04',
}

const HEX40 = /^0x[0-9a-fA-F]{40}$/

/** The override key for one chain. */
export const venueKey = (id: ChainId) => `provecash.rfqVenue.${id}`

/**
 * The venue on this chain, or null when exclusive quotes cannot work here.
 *
 * Null for two different reasons and the surface says so with one sentence, because a reader can
 * do nothing different about either: no venue address, or no settlement. The settlement matters
 * as much as the venue does — `intentHashOf` hashes under a domain whose `verifyingContract` is
 * the settlement, so on a chain the registry gives no settlement the binding would commit to a
 * hash nobody on chain agrees with.
 */
export function rfqVenue(id: ChainId = getChainId()): Address | null {
  if (!settlementLive(id)) return null
  const stored = kv().getItem(venueKey(id))
  if (stored && HEX40.test(stored.trim())) return stored.trim() as Address
  return DEPLOYED[id] ?? null
}

/**
 * @prove.cash/sdk — the whole protocol, without a browser.
 *
 * prove.cash settles swaps from signed intents. A maker signs terms; the signature travels over
 * msgboard, which charges proof of work instead of gas; anybody who reads it can verify it and
 * fill it against ProveSettlement. This package is every piece of that except the user
 * interface: the intent type and its EIP-712 domain, the packed wire codec, the board and
 * archive clients, the settlement reads and writes, and an indexed store for the book.
 *
 * Import the root for everything, or a subpath for one concern:
 *
 *   import { encodeIntent } from '@prove.cash/sdk'
 *   import { encodeIntent } from '@prove.cash/sdk/intent'
 *
 * Nothing here touches `window`, React, or the DOM. Grinding runs headless by default and
 * storage is pluggable, so the same code drives a tab, a solver, and a market maker.
 */

export * from './archive.js'
export * from './board.js'
export * from './client.js'
export * from './config.js'
export * from './custody.js'
export * from './decay.js'
export * from './deployed.js'
export * from './claim.js'
export * from './dryrun.js'
export * from './fee.js'
export * from './feeconfig.js'
export * from './intent.js'
export * from './keepalive.js'
export * from './kv.js'
export * from './market.js'
export * from './multicall.js'
export * from './revert.js'
export * from './rfq-crypto.js'
export * from './rfq.js'
export * from './settlement.js'
export * from './store/index.js'
export * from './submit.js'
export * from './tokenlist.js'
export * from './tokens.js'

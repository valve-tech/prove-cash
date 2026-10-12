import type { Hex } from 'viem'
import type { ChainId } from '../config.js'
import type { SignedIntent } from '../intent.js'

/**
 * The order book's memory. Every verified intent a client has ever seen, indexed so callers ask
 * questions instead of filtering arrays. Three rules keep it honest: a signature verifies
 * locally before it is stored, never after; ingest is idempotent and the freshest sighting
 * wins; and only the chain decides fillability — this store only remembers.
 *
 * Records keep the raw payload hex, so any record can go back on the board without a new
 * signature. Amounts stay as decimal strings (authoritative); a derived float `rate` exists
 * only so range queries never decode bigints.
 */

/** Where a sighting came from. A better source upgrades a record, never the other way. */
export type IntentSource = 'live' | 'archive' | 'mine'

/** One intent as the store holds it: flat, indexable, and re-broadcastable. */
export type StoredIntent = {
  key: string
  chainId: number
  maker: string
  recipient: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  minOutStart: string
  minOutEnd: string
  startTime: number
  endTime: number
  executor: string
  /**
   * Where this intent's fee goes, lowercased. The zero address means the protocol's own sink.
   *
   * The hash of the intent's fee config, 0x-prefixed. Stored because the signature covers it. A
   * record that dropped this field would rebuild every intent with no fee config, and each one
   * would then fail to verify against the digest the maker actually signed. A record written
   * before the field existed reads back as undefined, which `recordToIntent` resolves to zero.
   */
  feeConfig?: string
  /**
   * The rate this intent charges, as a decimal string: a fraction of one ether, so `"5e14"` is
   * five basis points. A string for the reason `amountIn` is one — a record goes through
   * `structuredClone` and through JSON, and only one of those carries a bigint.
   *
   * Stored because the signature covers it. A record written before the field existed reads back
   * as undefined, which `recordToIntent` resolves to zero. Those records were written when the
   * rate was an int16 counted in basis points and their payloads no longer decode, so nothing
   * that survives the version bump carries a number here.
   */
  feeRate?: string
  /** P1, the handover rate, as a decimal string. Absent means zero. Signed, so stored. */
  feeRateIn?: string
  /** P3, the proceeds rate, as a decimal string. Absent means zero. Signed, so stored. */
  feeRateProceeds?: string
  /**
   * The smallest partial fill the intent accepts, as a decimal string. Absent means no floor,
   * which is what every record written before the field existed carries.
   *
   * Stored because the signature covers it, exactly as `feeRate` is. Those older records were
   * written under version 2 of the wire codec and their payloads no longer decode, so nothing
   * that survives the bump can disagree with this.
   */
  minFill?: string
  /**
   * The 3009 nonce this intent's authorization must carry. Absent means the intent's own hash,
   * which is what every record written before the field existed carries.
   *
   * Stored because the signature covers it, exactly as `minFill` is.
   */
  authNonce?: string
  /**
   * The shape of the intent's decay, as the thirty-two byte word the maker signed. Absent means
   * the straight line, which is what every record written before the field existed carries.
   *
   * Stored because the signature covers it, exactly as `authNonce` is. Those older records were
   * written under version 3 of the wire codec and their payloads no longer decode, so nothing
   * that survives the bump can disagree with this.
   */
  curve?: string
  flags: number
  nonce: string
  signature: string
  /** The original board payload. Re-broadcastable as-is. */
  data: string
  firstSeenAt: number
  lastSeenBlock: number
  msgHash: string
  source: IntentSource
  /** minOutStart per amountIn, decimal-adjusted. Derived; the strings above settle. */
  rate: number
  /** `${tokenIn}>${tokenOut}`, lowercase. */
  pair: string
}

/** One sighting of an intent, with everything the store needs to index it. */
export type IngestInput = {
  intent: SignedIntent
  data: Hex
  msgHash: Hex
  blockNumber: bigint
  firstSeenAt: number
  source: IntentSource
  decimalsIn: number
  decimalsOut: number
}

/** Every question the store answers. Absent fields do not filter. */
export type IntentQuery = {
  chainId: ChainId
  /** Restrict to one pair, as `${tokenIn}>${tokenOut}` (any case). */
  pair?: string
  /** Keep only intents whose endTime is after this timestamp (seconds). */
  liveAt?: number
  /** Keep only intents whose startTime is at or before this timestamp. */
  startedBy?: number
  /** Limit rate (tokenOut per tokenIn, decimal-adjusted). */
  rate?: { min?: number; max?: number }
  /** 'escrow' keeps FLAG_ESCROW intents, 'wallet' the rest. */
  custody?: 'escrow' | 'wallet'
  partialOnly?: boolean
  /** Keep intents whose pinned executor is this address, or open to anyone when `open` is set. */
  executor?: { address?: string; open?: boolean }
  maker?: string
  source?: IntentSource
  limit?: number
  /** Walk endTime descending — the history view's order. Ascending (soonest expiry) otherwise. */
  newestFirst?: boolean
  /** Continue after this position from a previous page's `cursor`. */
  after?: Cursor
}

/** Where a scan stopped. Hand it back as `after` to continue. */
export type Cursor = { indexKey: unknown; primaryKey: string }

/** A page of rows, and the cursor to continue from when the page filled up. */
export type QueryResult = { rows: StoredIntent[]; cursor: Cursor | null }

/** Open and total intent counts for one pair. */
export type PairDepth = { pair: string; open: number; total: number }

/**
 * The storage seam. Three verbs and a sweep, so the query layer above never knows whether it
 * runs on IndexedDB in a tab or on a Map in a solver.
 */
export type IntentStorage = {
  get(key: string): Promise<StoredIntent | undefined>
  put(record: StoredIntent): Promise<void>
  /** Scan matching `chainId` (and `pair` when given) with endTime >= `fromEnd`, ordered by endTime. */
  scan(
    chainId: number,
    pair: string | undefined,
    fromEnd: number,
    after: Cursor | undefined,
    visit: (record: StoredIntent, position: Cursor) => boolean,
    desc?: boolean,
  ): Promise<void>
  sweep(beforeEnd: number): Promise<void>
}

/** Expired intents stay readable this long, then the sweep removes them. */
export const RETAIN_AFTER_EXPIRY_S = 30 * 86_400

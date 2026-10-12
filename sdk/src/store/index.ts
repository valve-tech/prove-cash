import { formatUnits, type Hex } from 'viem'
import { settlementLive, type ChainId } from '../config.js'
import {
  CURVE_LINEAR,
  ZERO,
  ZERO_HASH,
  intentKey,
  learnWireFeeConfig,
  verifyIntent,
  type SignedIntent,
} from '../intent.js'
import { indexedDbStorage } from './indexeddb.js'
import { memoryStorage } from './memory.js'
import {
  RETAIN_AFTER_EXPIRY_S,
  type Cursor,
  type IngestInput,
  type IntentQuery,
  type IntentSource,
  type IntentStorage,
  type PairDepth,
  type QueryResult,
  type StoredIntent,
} from './types.js'

export { memoryStorage } from './memory.js'
export { indexedDbStorage } from './indexeddb.js'
export {
  RETAIN_AFTER_EXPIRY_S,
  type Cursor,
  type IngestInput,
  type IntentQuery,
  type IntentSource,
  type IntentStorage,
  type PairDepth,
  type QueryResult,
  type StoredIntent,
} from './types.js'

const SOURCE_RANK: Record<IntentSource, number> = { archive: 0, live: 1, mine: 2 }

/**
 * IndexedDB where the browser grants it, a Map where it does not. A solver in Node lands on
 * the Map without asking, and a tab in private mode degrades to it instead of failing.
 */
export async function autoStorage(): Promise<IntentStorage> {
  try {
    const storage = await indexedDbStorage()
    void storage.sweep(Math.floor(Date.now() / 1000) - RETAIN_AFTER_EXPIRY_S)
    return storage
  } catch {
    return memoryStorage()
  }
}

// ── Ingest ────────────────────────────────────────────────────────────────────

const pairOf = (tokenIn: string, tokenOut: string) =>
  `${tokenIn.toLowerCase()}>${tokenOut.toLowerCase()}`

function toRecord(chainId: number, input: IngestInput): StoredIntent {
  const { intent } = input
  const amountIn = Number(formatUnits(intent.amountIn, input.decimalsIn))
  const minOut = Number(formatUnits(intent.minOutStart, input.decimalsOut))
  return {
    key: intentKey(intent),
    chainId,
    maker: intent.maker.toLowerCase(),
    recipient: intent.recipient.toLowerCase(),
    tokenIn: intent.tokenIn.toLowerCase(),
    tokenOut: intent.tokenOut.toLowerCase(),
    amountIn: intent.amountIn.toString(),
    minOutStart: intent.minOutStart.toString(),
    minOutEnd: intent.minOutEnd.toString(),
    startTime: Number(intent.startTime),
    endTime: Number(intent.endTime),
    executor: intent.executor.toLowerCase(),
    feeConfig: intent.feeConfig.toLowerCase(),
    feeRate: intent.feeRate.toString(),
    feeRateIn: intent.feeRateIn.toString(),
    feeRateProceeds: intent.feeRateProceeds.toString(),
    minFill: intent.minFill.toString(),
    authNonce: intent.authNonce,
    curve: intent.curve,
    flags: intent.flags,
    nonce: intent.nonce.toString(),
    signature: intent.signature,
    data: input.data,
    firstSeenAt: input.firstSeenAt,
    lastSeenBlock: Number(input.blockNumber),
    msgHash: input.msgHash,
    source: input.source,
    rate: amountIn > 0 ? minOut / amountIn : 0,
    pair: pairOf(intent.tokenIn, intent.tokenOut),
  }
}

/** Signature checks survive the session — a recovered signer never changes. */
const verified = new Map<string, boolean>()

/** Verify a signature once per intent per chain, then remember the answer. */
export async function verifyOnce(intent: SignedIntent, chainId: ChainId): Promise<boolean> {
  const ck = `${chainId}:${intentKey(intent)}`
  let ok = verified.get(ck)
  if (ok === undefined) {
    ok = await verifyIntent(intent, chainId)
    verified.set(ck, ok)
  }
  return ok
}

// ── The store ─────────────────────────────────────────────────────────────────

/** One book, over one storage backend. */
export type IntentStore = {
  /**
   * Store one sighting of an intent. Refuses a chain that settles nowhere, then verifies the
   * signature and refuses the record when that fails. Idempotent: a repeat sighting only ever
   * raises `lastSeenBlock`, widens `firstSeenAt` downward, and upgrades `source`
   * (archive < live < mine).
   */
  ingest(chainId: ChainId, input: IngestInput): Promise<boolean>
  /**
   * The one question surface. Index work: chain + pair + expiry. Everything else is a residual
   * predicate applied inside the cursor walk, which stops at `limit` — no full-array filtering.
   */
  query(q: IntentQuery): Promise<QueryResult>
  /** Depth by pair on one chain: open count and total kept, from a single index walk. */
  pairDepth(chainId: ChainId, now: number): Promise<PairDepth[]>
  /** The backend in use, once it has opened. */
  storage(): Promise<IntentStorage>
}

/** Build a store over any backend. Both backends this package ships satisfy the interface. */
export function createIntentStore(
  storage: IntentStorage | Promise<IntentStorage>,
): IntentStore {
  const opened = Promise.resolve(storage)
  // Ingests run one at a time: the get-merge-put below is not atomic across transactions.
  let chain: Promise<unknown> = Promise.resolve()

  async function writeMerged(record: StoredIntent): Promise<boolean> {
    try {
      const b = await opened
      const prev = await b.get(record.key)
      if (prev) {
        // A repeat sighting that adds nothing skips the write.
        if (
          prev.lastSeenBlock >= record.lastSeenBlock &&
          prev.firstSeenAt <= record.firstSeenAt &&
          SOURCE_RANK[prev.source] >= SOURCE_RANK[record.source]
        ) {
          return true
        }
        record.firstSeenAt = Math.min(prev.firstSeenAt, record.firstSeenAt)
        if (prev.lastSeenBlock > record.lastSeenBlock) {
          record.lastSeenBlock = prev.lastSeenBlock
          record.msgHash = prev.msgHash
        }
        if (SOURCE_RANK[prev.source] > SOURCE_RANK[record.source]) record.source = prev.source
      }
      await b.put(record)
      return true
    } catch {
      return false
    }
  }

  return {
    async ingest(chainId, input) {
      /*
       * A chain that settles nowhere signs everything under a `verifyingContract` of
       * `0x0000…0000`, and this refuses the lot.
       *
       * **`verifyOnce` cannot catch this and would call it valid.** Verification recovers the
       * signer from the digest the maker signed, and that digest is perfectly well formed under a
       * zero domain — the recovered address matches, so the signature IS the maker's. What it is
       * not is spendable: no contract can ever settle it, and no later deploy can rescue one,
       * because the address the signature names is not the address that ships. Seven such offers
       * reached the public mainnet archive.
       *
       * So the guard sits in front of the check rather than inside it, and it sits here rather
       * than in a caller: the browser's board, the archive backfill and a solver's own reader all
       * arrive through this one function, and a rule enforced in three places is a rule two of
       * them will eventually stop enforcing.
       *
       * `settlementLive` reads the resolver, so an override pointing at a local Anvil is a live
       * settlement and its intents store normally.
       */
      if (!settlementLive(chainId)) return false
      if (!(await verifyOnce(input.intent, chainId))) return false
      // Verified, so its preimage may be kept for reading and paying (`readIntent`'s rule).
      if (input.intent.feeConfigPreimage) learnWireFeeConfig(input.intent.feeConfigPreimage)
      const record = toRecord(chainId, input)
      const run = () => writeMerged(record)
      const p = chain.then(run, run)
      chain = p
      return p
    },

    async query(q) {
      const limit = q.limit ?? 200
      const rows: StoredIntent[] = []
      let cursor: Cursor | null = null
      const pair = q.pair?.toLowerCase()
      const maker = q.maker?.toLowerCase()
      const executor = q.executor?.address?.toLowerCase()
      const keep = (r: StoredIntent): boolean => {
        if (q.startedBy !== undefined && r.startTime > q.startedBy) return false
        if (q.rate?.min !== undefined && r.rate < q.rate.min) return false
        if (q.rate?.max !== undefined && r.rate > q.rate.max) return false
        if (q.custody === 'escrow' && (r.flags & 2) === 0) return false
        if (q.custody === 'wallet' && (r.flags & 2) !== 0) return false
        if (q.partialOnly && (r.flags & 1) === 0) return false
        if (q.executor) {
          const openToAll = r.executor === ZERO
          const pinnedToMe = executor !== undefined && r.executor === executor
          if (!((q.executor.open && openToAll) || pinnedToMe)) return false
        }
        if (maker !== undefined && r.maker !== maker) return false
        if (q.source !== undefined && r.source !== q.source) return false
        return true
      }
      try {
        const b = await opened
        await b.scan(
          q.chainId,
          pair,
          q.liveAt !== undefined ? q.liveAt + 1 : 0,
          q.after,
          (r, pos) => {
            if (keep(r)) {
              rows.push(r)
              cursor = pos
            }
            return rows.length < limit
          },
          q.newestFirst ?? false,
        )
        return { rows, cursor: rows.length < limit ? null : cursor }
      } catch {
        return { rows: [], cursor: null }
      }
    },

    async pairDepth(chainId, now) {
      const depth = new Map<string, PairDepth>()
      try {
        const b = await opened
        await b.scan(chainId, undefined, 0, undefined, (r) => {
          let d = depth.get(r.pair)
          if (!d) {
            d = { pair: r.pair, open: 0, total: 0 }
            depth.set(r.pair, d)
          }
          d.total++
          if (r.endTime > now) d.open++
          return true
        })
      } catch {
        /* an empty depth list breaks nothing */
      }
      return [...depth.values()].sort((a, b) => b.open - a.open || b.total - a.total)
    },

    storage: () => opened,
  }
}

let shared: IntentStore | null = null

/** The store the module-level helpers below use. Opens `autoStorage()` on first touch. */
export function defaultStore(): IntentStore {
  shared ??= createIntentStore(autoStorage())
  return shared
}

/** Replace the shared store, or pass null to go back to `autoStorage()`. */
export function setDefaultStore(store: IntentStore | null): void {
  shared = store
}

/** Store one sighting in the shared store. */
export const ingestIntent = (chainId: ChainId, input: IngestInput): Promise<boolean> =>
  defaultStore().ingest(chainId, input)

/** Query the shared store. */
export const queryIntents = (q: IntentQuery): Promise<QueryResult> => defaultStore().query(q)

/** Pair depth from the shared store. */
export const pairDepth = (chainId: ChainId, now: number): Promise<PairDepth[]> =>
  defaultStore().pairDepth(chainId, now)

/** Rebuild the bigint intent a record stands for. The strings are authoritative. */
export function recordToIntent(r: StoredIntent): SignedIntent {
  return {
    maker: r.maker as SignedIntent['maker'],
    recipient: r.recipient as SignedIntent['recipient'],
    tokenIn: r.tokenIn as SignedIntent['tokenIn'],
    tokenOut: r.tokenOut as SignedIntent['tokenOut'],
    amountIn: BigInt(r.amountIn),
    minOutStart: BigInt(r.minOutStart),
    minOutEnd: BigInt(r.minOutEnd),
    startTime: BigInt(r.startTime),
    endTime: BigInt(r.endTime),
    executor: r.executor as SignedIntent['executor'],
    // A record from before these fields existed carries none of them; those intents named no fee
    // config and charged nothing of their own.
    feeConfig: (r.feeConfig ?? ZERO_HASH) as SignedIntent['feeConfig'],
    feeRate: BigInt(r.feeRate ?? 0),
    feeRateIn: BigInt(r.feeRateIn ?? 0),
    feeRateProceeds: BigInt(r.feeRateProceeds ?? 0),
    minFill: BigInt(r.minFill ?? 0),
    authNonce: (r.authNonce ?? ZERO_HASH) as SignedIntent['authNonce'],
    curve: (r.curve ?? CURVE_LINEAR) as SignedIntent['curve'],
    flags: r.flags,
    nonce: BigInt(r.nonce),
    signature: r.signature as SignedIntent['signature'],
  }
}

/** The raw board payload a record was built from, ready to post again. */
export const recordPayload = (r: StoredIntent): Hex => r.data as Hex

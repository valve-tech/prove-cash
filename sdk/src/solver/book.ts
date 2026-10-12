import {
  erc20Abi,
  type Address,
  type Chain,
  type Hex,
  type HttpTransport,
  type PublicClient,
} from 'viem'
import { rpcClient } from '../client.js'
import { getChainId, readerAddress, settlement, settlementLive, type ChainId } from '../config.js'
import { intentKey, isPartial, type SignedIntent } from '../intent.js'
import { batchRead, type Call } from '../multicall.js'
import { defaultStore, recordToIntent, type IntentStore } from '../store/index.js'
import {
  availableCall,
  fillReason,
  fillabilityCall,
  NO_FEE_BOUND,
  type FillReasonName,
} from './abi.js'
import { encodeArming, permit2SpentNonces, reachabilityOf, readParked } from './arming.js'
import { groupKey } from './groups.js'

/**
 * The order book a ring is found in: live signed intents, indexed by the pair they trade.
 *
 * Eligibility is the chain's answer, not ours. `fillability` folds expiry, cancellation, the
 * nonce floor, the executor restriction, the amount already filled, partial-fill permission and
 * the maker's live balance and allowance into one reason code, and a multicall asks it of every
 * candidate at once. Re-deriving those rules here is how a solver and a settlement contract
 * drift apart.
 *
 * One answer is not a verdict, though. `EscrowShort` means the maker's funds are out of reach,
 * and a solver holding their EIP-3009 authorization or their EIP-2612 permit can reach them —
 * `FillRequest.arming` is exactly that. So the book keeps such a leg, with the bytes that arm
 * it, instead of throwing away every gasless maker on the board. See `arming.ts`.
 *
 * **A fourth source needs no signature at all.** An escrow maker's parked capital is their own
 * money already inside the settlement, and any solver may draw a leg out of it. So an escrow
 * signature its maker never funded is in this book too, where it used to be rejected for ever.
 * That is a real change to what a maker's inaction buys them, disclosed at `AUDIT-SCOPE` 6.11.
 */

/** One intent in the book, with what the chain says is left of it. */
export type BookEntry = {
  /** The store's stable id for this intent. */
  key: string
  intent: SignedIntent
  /** `amountIn` minus the amount already filled. */
  remaining: bigint
  /**
   * False when the maker forbids a partial fill. Such a leg is pinned: a ring either takes
   * exactly `remaining` from it or leaves it alone.
   */
  partial: boolean
  /**
   * Empty, or the signature that reaches this maker's funds, ready for `FillRequest.arming`.
   *
   * Present only on a leg the chain refuses today and the solver can rescue — `reachabilityOf`
   * decides which. A leg the chain already calls fillable carries nothing, because arming it
   * would spend an EIP-2612 nonce to grant an allowance the maker already granted, and that
   * nonce orders every other permit they signed.
   */
  arming?: Hex
  /**
   * The token nonce this leg's permit commits to, when a caller resolved it.
   *
   * Nothing here fills it in: the wire format carries the value, the deadline and the signature
   * and not the nonce, so recovering it costs a read of the token and a handful of `ecrecover`s.
   * `recoverPermitNonce` in `arming.ts` does it. Left undefined, `groups.ts` admits at most one
   * of a maker's permit legs per token, which is the honest answer when the order is unknown.
   */
  permitNonce?: bigint
  /**
   * What this maker had resting in the settlement in `tokenIn` when the book was read.
   *
   * Present on any escrow leg `readParked` was asked about, whether or not the row turned out to
   * hold anything — nothing here means nobody read it, and zero means the row is empty. The
   * entry carries it because a row is shared: it is one pot behind every escrow offer the maker
   * has open in that asset, and `arming` alone cannot say how many of them it can pay for.
   */
  parked?: bigint
}

/** Live intents, indexed the way a ring finder reads them. Build it, then never mutate it. */
export type OrderBook = {
  chainId: ChainId
  entries: readonly BookEntry[]
  /** `${tokenIn}>${tokenOut}`, lowercase, to the entries offering that direction. */
  byPair: ReadonlyMap<string, readonly BookEntry[]>
  /** Every token the book touches, lowercase, deduplicated. */
  tokens: readonly Address[]
  /**
   * What one maker's holding of one token can pay for, by `groupKey`, where it was read.
   *
   * A maker's balance is shared across every intent they signed against that token, so two legs
   * of theirs can each be fillable and still not fill together. Only the keys that hold more
   * than one leg are worth a read, and in a normal book there are none — see `loadBook`.
   */
  funds?: ReadonlyMap<string, bigint>
}

/** The directed pair an intent trades: the token the executor receives, then the one it pays. */
export const pairKey = (tokenIn: Address | string, tokenOut: Address | string): string =>
  `${String(tokenIn).toLowerCase()}>${String(tokenOut).toLowerCase()}`

/**
 * Index a set of entries. Pure, so a test builds a book from intents it made up and the engine
 * cannot tell it from one the chain answered.
 */
export function buildBook(
  entries: readonly BookEntry[],
  chainId: ChainId = getChainId(),
  funds?: ReadonlyMap<string, bigint>,
): OrderBook {
  const byPair = new Map<string, BookEntry[]>()
  const tokens = new Map<string, Address>()
  const kept: BookEntry[] = []

  for (const e of entries) {
    if (e.remaining <= 0n) continue
    if (e.intent.tokenIn.toLowerCase() === e.intent.tokenOut.toLowerCase()) continue
    kept.push(e)
    const k = pairKey(e.intent.tokenIn, e.intent.tokenOut)
    const list = byPair.get(k)
    if (list) list.push(e)
    else byPair.set(k, [e])
    tokens.set(e.intent.tokenIn.toLowerCase(), e.intent.tokenIn)
    tokens.set(e.intent.tokenOut.toLowerCase(), e.intent.tokenOut)
  }

  return {
    chainId,
    entries: kept,
    byPair,
    tokens: [...tokens.values()],
    ...(funds ? { funds } : {}),
  }
}

/** An entry from an intent and the amount left of it. The flags decide whether the leg pins. */
export const entryOf = (
  intent: SignedIntent,
  remaining: bigint,
  key: string,
  arming?: Hex,
  parked?: bigint,
): BookEntry => ({
  key,
  intent,
  remaining,
  partial: isPartial(intent),
  ...(arming ? { arming } : {}),
  ...(parked === undefined ? {} : { parked }),
})

// ── Reading the book from the chain ───────────────────────────────────────────

/** Where the book is read from, and who is asking. */
export type LoadBookOptions = {
  /** The address the solver will fill from. `fillability` answers for this executor. */
  executor: Address
  client?: PublicClient<HttpTransport, Chain>
  chainId?: ChainId
  /** Override the settlement address, for a fork. Defaults to the registry's resolver. */
  settlementAddress?: Address
  /** The `ProveReader` that answers `available`. Defaults to the chain's registry entry. */
  readerAddress?: Address
  /** Reject intents whose remaining amount is below this. Dust is not worth a leg. */
  minRemaining?: bigint
  /**
   * The highest rate this solver will pay on any leg. Unbounded by default.
   *
   * A ring pays whatever its dearest leg asks and `planOf` sets that bound per plan, so a book
   * load usually has no ceiling in mind. An operator who does have one names it here and the
   * intents above it never enter the book.
   */
  maxFeeRate?: bigint
  /**
   * Read the shared balance behind a maker who has more than one live intent on one token.
   * On by default, and it costs nothing in a book where no maker does.
   */
  funds?: boolean
  /**
   * The Permit2 this deployment uses. Naming it turns on the nonce-bitmap read.
   *
   * Off unless named, because resolving the address costs two reads of its own — `permit2Target`
   * asks the settlement for its relayer and the relayer for its Permit2 — and a book of wallet
   * and escrow legs pays them for an answer no leg uses. A solver that fills permit2 legs passes
   * `await permit2Target({ client, chainId })` once and holds it; the address outlives every
   * redeploy of the settlement, so it is worth holding.
   *
   * Without it every `EscrowShort` permit2 leg still looks armable, which is what this file did
   * before the bitmap could be read: the solver plans the fill, sends arming bytes Permit2 will
   * refuse, and pays for the attempt.
   */
  permit2?: Address
  /**
   * Read each escrow maker's parked row, so a leg they never funded can still be armed.
   *
   * On by default, and unlike `permit2` it needs no address of its own — the settlement is
   * already resolved here — so it costs nothing in a book with no unfunded escrow legs in it.
   * That is the same bargain `funds` strikes one field down.
   *
   * **Turning it off narrows the board rather than making it safer.** Without the read an
   * escrow signature its maker never funded reads unreachable, which is what this file said
   * before #120 and is no longer true of the chain. An operator who does not want to fill out of
   * makers' parked capital is the caller this exists for.
   */
  parked?: boolean
}

/** One intent the chain refused, and the reason it gave. Worth logging, never worth filling. */
export type RejectedEntry = { key: string; intent: SignedIntent; reason: FillReasonName }

/** What a book load found, and what it threw away. */
export type BookLoad = { book: OrderBook; rejected: readonly RejectedEntry[] }

/**
 * Ask the chain which of these intents are genuinely fillable, and index the survivors.
 *
 * Two rounds of multicall: `available` for the amount left, then `fillability` at that amount
 * for the reason code. Asking at the full remaining amount is enough for a partial intent too —
 * every take-dependent refusal the contract has gets stricter as the take grows, so an intent
 * that clears at its remaining amount clears at anything smaller.
 *
 * Two further rounds run only when they can change an answer. Permit2's nonce bitmap, when the
 * caller names a `permit2` address, separates an `EscrowShort` leg still worth arming from one
 * whose nonce a rival already spent — the fill reason cannot, because it says `EscrowShort` to
 * both. Then the shared balance behind a maker who has two or more live intents on the same
 * token, which is the pair `groups.ts` has to size a budget for. In a book where no maker holds
 * two such intents, and none is on the permit2 rung, neither round issues a call at all.
 */
export async function loadBook(
  intents: readonly SignedIntent[],
  opts: LoadBookOptions,
): Promise<BookLoad> {
  const chainId = opts.chainId ?? getChainId()
  const address = opts.settlementAddress ?? settlement(chainId)
  const client = opts.client ?? rpcClient()
  const empty = buildBook([], chainId)
  if (!opts.settlementAddress && !settlementLive(chainId)) return { book: empty, rejected: [] }
  if (intents.length === 0) return { book: empty, rejected: [] }

  const reader = opts.readerAddress ?? readerAddress(chainId)
  if (!reader) throw new Error(`No ProveReader is deployed on chain ${chainId}, so \`available\` cannot be read.`)
  const availability = await batchRead(
    intents.map((i): Call => availableCall(reader, i) as Call),
    client,
  )

  const minRemaining = opts.minRemaining ?? 1n
  const live: { intent: SignedIntent; remaining: bigint }[] = []
  const rejected: RejectedEntry[] = []
  for (let i = 0; i < intents.length; i++) {
    const r = availability[i]
    if (!r.ok) continue
    const [remaining, isLive] = r.value as readonly [bigint, boolean]
    if (!isLive || remaining < minRemaining) continue
    live.push({ intent: intents[i], remaining })
  }
  if (live.length === 0) return { book: empty, rejected }

  const bound = opts.maxFeeRate ?? NO_FEE_BOUND
  const reasons = await batchRead(
    live.map(
      (l): Call => fillabilityCall(address, l.intent, l.remaining, opts.executor, bound) as Call,
    ),
    client,
  )

  type Verdict = { intent: SignedIntent; remaining: bigint; key: string; reason: FillReasonName }
  const verdicts: Verdict[] = []
  for (let i = 0; i < live.length; i++) {
    const r = reasons[i]
    if (!r.ok) continue
    const intent = live[i].intent
    verdicts.push({
      intent,
      remaining: live[i].remaining,
      key: intentIdOf(intent),
      reason: fillReason(Number(r.value)),
    })
  }

  // Only an `EscrowShort` permit2 leg can have its verdict changed by a spent nonce, so the
  // bitmap is asked about those alone. An `Ok` leg is deliberately not asked: it reads `Ok`
  // BECAUSE another solver spent the nonce and promoted the signature into a reservation, and
  // a word bought there would answer `true` about a leg that is now the most fillable on the
  // board. `reachabilityOf` ignores `spent` on `Ok` for that reason; not paying for it is the
  // same decision, one layer up.
  const short = verdicts.filter((v) => v.reason === 'EscrowShort')
  const spent = opts.permit2
    ? await permit2SpentNonces(
        short.map((v) => v.intent),
        { permit2: opts.permit2, client, chainId },
      )
    : undefined

  // The mirror of the bitmap, and asked of the same set for the same reason. `EscrowShort` is
  // what an unfunded escrow reservation looks like AND what a maker's parked capital looks like
  // from `_evaluate`, which reads `_reserved[h]` and no other map. Only this read tells them
  // apart, so without it every escrow signature its maker never funded stays out of the book —
  // and that population is exactly what `park` exists to put back in.
  const parked = (opts.parked ?? true)
    ? await readParked(short.map((v) => v.intent), {
        settlementAddress: address,
        client,
        chainId,
      })
    : undefined

  const entries: BookEntry[] = []
  for (const { intent, remaining, key, reason } of verdicts) {
    const row = parked?.get(key)
    const reach = reachabilityOf(reason, intent, spent?.get(key), row)
    if (reach === 'unreachable') {
      rejected.push({ key, intent, reason })
      continue
    }
    // `EscrowShort` on a leg the solver can arm is a leg to arm, not a leg to drop. The bytes
    // are built once here rather than at every plan that reaches for this entry.
    const arming = reach === 'armable' ? encodeArming(intent, chainId, row) : null
    if (reach === 'armable' && !arming) {
      rejected.push({ key, intent, reason })
      continue
    }
    entries.push(entryOf(intent, remaining, key, arming ?? undefined, row))
  }

  const funds = (opts.funds ?? true) ? await loadFunds(entries, client) : undefined
  return { book: buildBook(entries, chainId, funds), rejected }
}

/**
 * The shared balance behind every maker who has two or more of these entries on one token.
 *
 * One read per contended key and none at all otherwise, because a maker with a single live
 * intent on a token has nobody to share the balance with — `fillability` already answered for
 * that leg on its own, and the answer cannot change.
 *
 * A read that does not come back is left out rather than guessed at. An unknown budget
 * constrains nothing, and `dryRun` is what catches a shortfall the solver could not see.
 */
async function loadFunds(
  entries: readonly BookEntry[],
  client: PublicClient<HttpTransport, Chain>,
): Promise<ReadonlyMap<string, bigint> | undefined> {
  const seen = new Map<string, { maker: Address; token: Address; count: number }>()
  for (const e of entries) {
    const k = groupKey(e.intent.maker, e.intent.tokenIn)
    const at = seen.get(k)
    if (at) at.count++
    else seen.set(k, { maker: e.intent.maker, token: e.intent.tokenIn, count: 1 })
  }
  const contended = [...seen.entries()].filter(([, v]) => v.count > 1)
  if (contended.length === 0) return undefined

  const balances = await batchRead(
    contended.map(
      ([, v]): Call => ({
        address: v.token,
        abi: erc20Abi as never,
        functionName: 'balanceOf',
        args: [v.maker],
      }),
    ),
    client,
  )

  const out = new Map<string, bigint>()
  for (let i = 0; i < contended.length; i++) {
    const r = balances[i]
    if (r.ok) out.set(contended[i][0], r.value as bigint)
  }
  return out.size === 0 ? undefined : out
}

/**
 * The book from the SDK's own store, so a Node solver and the web app ask the same question of
 * the same index. Only live, already-started intents come out; the chain decides the rest.
 */
export async function loadBookFromStore(
  now: number,
  opts: LoadBookOptions & { store?: IntentStore; limit?: number },
): Promise<BookLoad> {
  const chainId = opts.chainId ?? getChainId()
  const store = opts.store ?? defaultStore()
  const { rows } = await store.query({
    chainId,
    liveAt: now,
    startedBy: now,
    executor: { address: opts.executor, open: true },
    limit: opts.limit ?? 500,
  })
  return loadBook(rows.map(recordToIntent), opts)
}

/** The book keys an intent by the same id the store does, so the two never disagree. */
export const intentIdOf = intentKey

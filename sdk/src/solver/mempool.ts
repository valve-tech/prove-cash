import { decodeFunctionData, toFunctionSelector, type Abi, type Address, type Hex } from 'viem'
import { intentKey, type Intent, type SignedIntent } from '../intent.js'
import {
  SOLVER_BATCH_EXECUTOR_ABI,
  SOLVER_EXECUTOR_ABI,
  SOLVER_SETTLEMENT_ABI,
} from './abi.js'

/**
 * What a rival solver is about to fill, read out of the mempool before this one sends.
 *
 * ── Why it is worth a round trip ──────────────────────────────────────────────
 *
 * Two solvers reading one public board overlap by accident. Neither did anything wrong and the
 * slower one pays, and what it pays depends entirely on which path it was on. Measured in
 * `contracts/test/Gas.t.sol`:
 *
 *   tolerant batch   a leg a rival already took costs 15,982 gas against 69,841 for the fill it
 *                    would have made, and every other leg still fills. Under a quarter of one
 *                    fill, and you still earn
 *   3-leg ring       222,044 gas, and you earn nothing. Three quarters of a win, spent settling
 *                    legs the revert then throws away
 *
 * Two evenly matched solvers racing on rings therefore each pay about 1.8x the gas per ring they
 * settle. The ring is the accident worth avoiding, and the pending transaction that causes it is
 * visible for a block before it lands.
 *
 * ── What it reads ─────────────────────────────────────────────────────────────
 *
 * `eth_pendingTransactions` first, `txpool_content` second. Both answer on the valve gateway;
 * measured against `one.valve.city/evm/943` on 2026-09-03:
 *
 *   eth_pendingTransactions   19 transactions,    14,930 bytes, 265 ms
 *   txpool_content            19 pending and
 *                             1,050 queued,    2,458,980 bytes, 741 ms
 *   txpool_status             the two counts,        69 bytes, ~200 ms
 *   txpool_inspect            no calldata,       96,845 bytes, 275 ms — useless here
 *   parity_pendingTransactions                   ErrUpstreamsExhausted
 *
 * 165 times the payload for the same 19 transactions, because `txpool_content` also returns the
 * queued bucket and one stuck account was sitting on 1,036 transactions behind a nonce gap. So
 * the cheap call is also the correct one: **a queued transaction cannot land in the next block**,
 * and a leg skipped because of one is a leg skipped for as long as that account stays stuck.
 * `txpool_content` is the fallback for a node that does not serve the first, and it reads only
 * the pending bucket for the same reason.
 *
 * `txpool_inspect` is cheaper still and carries no calldata, so it cannot answer the only
 * question here. It is listed so nobody measures it twice.
 *
 * ── What it decodes, and why not by address ───────────────────────────────────
 *
 * By selector, over every pending transaction, whatever it is addressed to.
 *
 * Filtering on `to` was the obvious design and it is wrong. A rival settling on credit sends to
 * **their own** `ProveBatchExecutor`, an address this solver has never heard of, and the
 * settlement call happens inside that transaction where no `to` field shows it. Only the
 * calldata gives them away. So the selector table below is the filter: four bytes compared
 * against a handful of entry points, and an ABI decode only for the transactions that match.
 *
 * The last six transactions to touch the 943 settlement, read on 2026-09-03, say how much that
 * matters. One was a `fill` addressed to the settlement itself. The other five were `settleRing`
 * addressed to `0x8e76f3ea…`, a batch executor the registry does not carry and never will —
 * `solver.ts` says why. **A `to` filter would have seen one collision in six.**
 *
 * The decode then yields the whole `Intent` tuple and its signature, which is exactly what
 * `intentKey` is built from — so a rival's claim lands in the same key space the book indexes by,
 * and matching it against a ring's legs is a set lookup.
 *
 * That shared key space is load-bearing and it is a convention, not a type. `BookEntry.key` is
 * whatever the store put there, `ringIntentKeys` hands those keys on, and both agree with this
 * file only because `store/index.ts` keys by `intentKey` and `book.ts` says so out loud with
 * `intentIdOf`. Nothing in the compiler catches a store that decides to key by something else, so
 * `mempool.test.ts` pins it: a claim decoded out of calldata must equal `intentIdOf` of the same
 * intent.
 *
 * `dryRun` is deliberately not in the table. It is non-view and so a solver could send it, but it
 * fills nothing, and counting a rival's probe as a claim would skip legs nobody is taking.
 *
 * ── This is evidence, not truth ───────────────────────────────────────────────
 *
 * A pending transaction may never land. It can be replaced by a same-nonce transaction paying a
 * higher tip, dropped when its sender's balance falls short, evicted when the pool fills, left
 * behind a nonce that never arrives, or reverted on arrival by the very race it describes. It can
 * also be a feint: nothing stops a solver broadcasting a doomed fill over the legs it wants, to
 * make everyone else stand back for a block.
 *
 * **The asymmetry is the whole justification.** Believe a lie and the cost is one ring not built
 * this block — an opportunity, and the Dutch curve only ever moves in the solver's favour, so the
 * ring is usually still there next block worth slightly more. Disbelieve the truth and the cost
 * is 222,044 gas for nothing. Roughly three quarters of a win against a fraction of one, so the
 * cheap error is the one to make, and this errs towards believing the pool.
 *
 * That bounds the feint too. A leg comes back the instant the transaction leaves the pool, so
 * holding one leg away from one rival costs the feinter a broadcast every block, on a chain where
 * their own doomed transaction may land and cost them a revert. It is a real griefing vector and
 * it is a metered one; there is no version of this that is both useful and immune.
 *
 * Nothing here is a defence against a solver who is faster. It closes an accident, not a race.
 */

/** The entry points that carry signed intents, by name. Everything else is not a claim. */
const CLAIM_FUNCTIONS: readonly { abi: Abi; names: readonly string[]; target: EntryTarget }[] = [
  {
    target: 'settlement',
    abi: SOLVER_SETTLEMENT_ABI as unknown as Abi,
    names: [
      'fill',
      'fillBatch',
      'fillBatchWithCallback',
      'fillWithAuthorization',
      'fillWithCallback',
      'fillWithPermit',
      'fillWithPermit2',
    ],
  },
  // A rival's own executor, at an address this solver does not know. Named by selector so the
  // calldata is read wherever it is sent.
  { target: 'executor', abi: SOLVER_BATCH_EXECUTOR_ABI as unknown as Abi, names: ['settleRing'] },
  { target: 'executor', abi: SOLVER_EXECUTOR_ABI as unknown as Abi, names: ['fill'] },
]

/**
 * Where a call on an entry point must be sent to fill anything. A settlement entry point fills
 * only when sent to the settlement. An executor entry point goes to the rival's own executor, at
 * an address this solver cannot know.
 */
type EntryTarget = 'settlement' | 'executor'

/** One entry point, ready to decode: its own single-item ABI and the shape of its arguments. */
type EntryPoint = {
  /** The name to report. `fill` exists on two contracts, so the selector is the identity. */
  label: string
  abi: Abi
  /**
   * `batch` when the first argument is `FillRequest[]`, `single` when it is one intent tuple
   * followed by its signature and take.
   *
   * Read off the ABI rather than written down, because the compiler is the only honest author of
   * an argument order. `fillBatch` takes `(reqs, skipInvalid, maxFeeRate)` and
   * `fillBatchWithCallback` takes `(reqs, skipInvalid, data, maxFeeRate)` — the same first two,
   * and a hand-kept table would be one place to get the third wrong.
   */
  shape: 'batch' | 'single'
  target: EntryTarget
}

/**
 * Selector to entry point.
 *
 * Built from the generated ABIs at module load, so a renamed argument or a new fill entry point
 * arrives here with the regeneration rather than the next time somebody remembers. A name in
 * `CLAIM_FUNCTIONS` that the compiler no longer emits throws at load, which is the loud failure:
 * the alternative is a solver that quietly stops seeing one kind of rival.
 */
export const CLAIM_ENTRY_POINTS: ReadonlyMap<Hex, EntryPoint> = (() => {
  const out = new Map<Hex, EntryPoint>()
  for (const { abi, names, target } of CLAIM_FUNCTIONS) {
    for (const name of names) {
      const items = abi.filter((e) => e.type === 'function' && e.name === name)
      if (items.length === 0) throw new Error(`No ABI entry for a fill entry point named ${name}.`)
      for (const item of items) {
        if (item.type !== 'function') continue
        const first = item.inputs[0]
        out.set(toFunctionSelector(item), {
          label: name,
          abi: [item],
          shape: first?.type === 'tuple[]' ? 'batch' : 'single',
          target,
        })
      }
    }
  }
  return out
})()

/** One leg a pending transaction names, before anything is known about who sent it. */
export type ClaimedLeg = {
  /** The intent, rebuilt from the rival's own calldata. */
  intent: SignedIntent
  /** How much of it they are taking. */
  take: bigint
  /** Which entry point they used. */
  call: string
  /** Where that entry point must be sent to fill anything. */
  target: EntryTarget
  /**
   * The `skipInvalid` they sent.
   *
   * True and the rival is on the tolerant path, so their transaction survives losing this leg and
   * they are likely to take it. False and one bad leg reverts everything, so their claim is
   * all-or-nothing — still evidence, and no weaker, because a ring that reverts has still spent
   * the block trying.
   */
  skipInvalid: boolean
}

/** A leg some other address is about to fill, and the transaction that says so. */
export type RivalClaim = ClaimedLeg & {
  /** `intentKey`, the same key the book and `ringIntentKeys` use. */
  key: string
  /** The pending transaction. */
  hash: Hex
  from: Address
  to: Address | null
}

/** The minimum a pending transaction has to carry for any of this to work. */
export type PendingTx = {
  hash: Hex
  from: Address
  to: Address | null
  /** The calldata. `input` on every client that answers these methods; `data` on a few. */
  input: Hex
  /** The tip it offers, when the node says. EIP-1559 transactions carry this. */
  maxPriorityFeePerGas?: bigint
  /** The whole price a legacy transaction offers, when the node says. */
  gasPrice?: bigint
}

/**
 * The longest signature a claim may carry, in bytes. An ECDSA signature is 65. An ERC-1271
 * signature can be longer, but a kilobyte is far past any real one.
 */
const MAX_SIGNATURE_BYTES = 1_024

const isHex = (v: unknown): v is Hex => typeof v === 'string' && v.startsWith('0x')

/**
 * The `SignedIntent` a decoded `FillRequest` describes, or null when the bytes are not one.
 *
 * Every field is checked rather than trusted. The calldata comes from a stranger, and a
 * transaction carrying one of these selectors over deliberate garbage is a cheap thing to send:
 * a decode that half succeeds must produce nothing rather than an intent with holes in it.
 */
function intentFrom(tuple: unknown, signature: unknown): SignedIntent | null {
  if (typeof tuple !== 'object' || tuple === null) return null
  if (!isHex(signature)) return null
  // Empty, odd-length or absurdly long: nothing a real fill would carry.
  const bytes = (signature.length - 2) / 2
  if (bytes < 1 || !Number.isInteger(bytes) || bytes > MAX_SIGNATURE_BYTES) return null
  const i = tuple as Partial<Intent>
  if (!isHex(i.maker) || typeof i.nonce !== 'bigint') return null
  if (!isHex(i.tokenIn) || !isHex(i.tokenOut) || typeof i.amountIn !== 'bigint') return null
  return { ...(tuple as Intent), signature }
}

/**
 * Every leg one transaction's calldata names. Empty for calldata that is not a fill at all,
 * which is almost all of it.
 *
 * Pure, and it is the half worth testing: a rival's transaction is built by the same encoders in
 * `abi.ts` that this solver sends with, so a round trip through those is a faithful fixture.
 */
export function claimedLegs(input: Hex): ClaimedLeg[] {
  // Four bytes and a lookup before anything expensive. A pending pool is mostly transfers.
  if (input.length < 10) return []
  const entry = CLAIM_ENTRY_POINTS.get(input.slice(0, 10) as Hex)
  if (!entry) return []

  let args: readonly unknown[]
  try {
    args = decodeFunctionData({ abi: entry.abi, data: input }).args ?? []
  } catch {
    // The selector matched and the rest did not. A truncated broadcast, or somebody probing.
    return []
  }

  if (entry.shape === 'single') {
    const intent = intentFrom(args[0], args[1])
    // A take of zero fills nothing, so it claims nothing.
    if (!intent || typeof args[2] !== 'bigint' || args[2] === 0n) return []
    // One intent, so there is nothing to skip over: the transaction fills it or reverts.
    return [{ intent, take: args[2], call: entry.label, target: entry.target, skipInvalid: false }]
  }

  const reqs = args[0]
  if (!Array.isArray(reqs)) return []
  const skipInvalid = args[1] === true
  const legs: ClaimedLeg[] = []
  for (const req of reqs) {
    if (typeof req !== 'object' || req === null) continue
    const r = req as { intent?: unknown; signature?: unknown; take?: unknown }
    const intent = intentFrom(r.intent, r.signature)
    if (!intent || typeof r.take !== 'bigint' || r.take === 0n) continue
    legs.push({ intent, take: r.take, call: entry.label, target: entry.target, skipInvalid })
  }
  return legs
}

/** How to read the pool: whose transactions to ignore. */
export type ClaimOptions = {
  /**
   * Addresses whose pending transactions are not a rival's.
   *
   * This solver's own account at least. An operator running several bots off one board names all
   * of them, or every bot stands back from every other bot's legs and the fleet settles nothing.
   */
  mine?: readonly Address[]
  /**
   * The settlement. When named, a call on a settlement entry point counts only when it is sent
   * here: sent anywhere else it fills nothing, and it is a feint or a mistake.
   */
  settlement?: Address
  /**
   * The smallest tip, in wei, a claim must offer. A transaction that pays less may never land,
   * and on 943 a 7 wei tip sat unmined for three minutes. Omit to take any tip.
   */
  minPriorityFee?: bigint
}

/** The tip a transaction offers: its EIP-1559 tip, or a legacy transaction's whole price. */
const tipOf = (tx: PendingTx): bigint => tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n

/** The claims in a set of pending transactions, with our own filtered out. */
export function rivalClaims(
  txs: readonly PendingTx[],
  opts: ClaimOptions = {},
): RivalClaim[] {
  const mine = new Set((opts.mine ?? []).map((a) => a.toLowerCase()))
  const settlement = opts.settlement?.toLowerCase()
  const out: RivalClaim[] = []
  for (const tx of txs) {
    if (typeof tx.from === 'string' && mine.has(tx.from.toLowerCase())) continue
    if (opts.minPriorityFee !== undefined && tipOf(tx) < opts.minPriorityFee) continue
    for (const leg of claimedLegs(tx.input)) {
      if (settlement && leg.target === 'settlement' && tx.to?.toLowerCase() !== settlement) continue
      out.push({ ...leg, key: intentKey(leg.intent), hash: tx.hash, from: tx.from, to: tx.to })
    }
  }
  return out
}

/**
 * How long each pending transaction has been claiming, so a stuck one stops counting.
 *
 * A real claim lands within a block or two. One still pending after `maxAge` blocks is stuck
 * behind a nonce, underpriced, or a feint re-broadcast to hold legs back, and it no longer tells
 * this solver anything. A hash that leaves the pool is forgotten, so if it comes back it starts
 * again at zero.
 */
export class ClaimAges {
  private seen = new Map<string, bigint>()
  private readonly maxAge: number

  constructor(maxAge: number) {
    this.maxAge = maxAge
  }

  /** The claims first seen no more than `maxAge` blocks before `block`. */
  fresh(claims: readonly RivalClaim[], block: bigint): RivalClaim[] {
    const live = new Set(claims.map((c) => c.hash.toLowerCase()))
    for (const h of this.seen.keys()) if (!live.has(h)) this.seen.delete(h)
    return claims.filter((c) => {
      const h = c.hash.toLowerCase()
      const first = this.seen.get(h) ?? block
      this.seen.set(h, first)
      return block - first <= BigInt(this.maxAge)
    })
  }
}

/** The keys, for `SolveParams.claimed` and `ConfidenceInputs.claimed`. */
export const claimedKeys = (claims: readonly RivalClaim[]): Set<string> =>
  new Set(claims.map((c) => c.key))

// ── Reading the pool ──────────────────────────────────────────────────────────

/**
 * Whatever can make a raw JSON-RPC request. A viem `PublicClient` is one, and a test double is
 * three lines.
 *
 * **The parameter is `never[]` on purpose.** viem types its own `request` against a closed
 * `PublicRpcSchema` that names neither mempool method, so a parameter this file could actually
 * call with — `{ method: string }` — makes a real client fail to assign, as a property under
 * `strictFunctionTypes` and as a method too. `never[]` is assignable from every signature, which
 * moves the whole problem into one place: `ask` below holds the single cast that pays for it,
 * and no caller casts anything.
 */
export type PoolClient = { request: (...args: never[]) => Promise<unknown> }

/**
 * Ask for a method the client's own types do not list. The one cast in this file.
 *
 * It is honest rather than convenient: `eth_pendingTransactions` and `txpool_content` are real
 * methods that real nodes answer, and viem's schema simply does not enumerate them. The return
 * is `unknown` and every field is checked before it is believed — see `pendingTxFrom`.
 */
const ask = (client: PoolClient, method: string): Promise<unknown> =>
  (client.request as (a: { method: string; params: unknown[] }) => Promise<unknown>)({
    method,
    params: [],
  })

/** Which method answered. Worth logging once, because the two cost very different amounts. */
export type PoolSource = 'eth_pendingTransactions' | 'txpool_content'

/** What one read of the pool returned. */
export type PoolRead = {
  txs: PendingTx[]
  source: PoolSource
}

/** One transaction out of a JSON-RPC answer, or null when it is not shaped like one. */
function pendingTxFrom(raw: unknown): PendingTx | null {
  if (typeof raw !== 'object' || raw === null) return null
  const t = raw as {
    hash?: unknown
    from?: unknown
    to?: unknown
    input?: unknown
    data?: unknown
    maxPriorityFeePerGas?: unknown
    gasPrice?: unknown
  }
  const input = isHex(t.input) ? t.input : isHex(t.data) ? t.data : null
  if (!isHex(t.hash) || !isHex(t.from) || input === null) return null
  const tx: PendingTx = { hash: t.hash, from: t.from as Address, to: isHex(t.to) ? (t.to as Address) : null, input }
  if (isHex(t.maxPriorityFeePerGas)) tx.maxPriorityFeePerGas = BigInt(t.maxPriorityFeePerGas)
  if (isHex(t.gasPrice)) tx.gasPrice = BigInt(t.gasPrice)
  return tx
}

/**
 * The pending transactions this node can see.
 *
 * `eth_pendingTransactions` when the node serves it, because it returns the executable set alone
 * and nothing else — 14,930 bytes against 2,458,980 for the same 19 transactions on 943. The
 * fallback reads `txpool_content` and takes only its `pending` bucket, for the reason in the
 * header: a queued transaction sits behind a nonce gap and cannot land in the next block, so
 * treating one as a claim would hold a leg back for as long as its sender stays stuck.
 *
 * It throws when neither method answers. **The caller redacts.** A viem error carries the whole
 * request URL in its `metaMessages`, registry key and all, so the error from here must reach a
 * log through `redact` or `describe` and never through `String(e)`.
 */
export async function readPendingTransactions(client: PoolClient): Promise<PoolRead> {
  try {
    const raw = await ask(client, 'eth_pendingTransactions')
    if (Array.isArray(raw)) {
      const txs = raw.map(pendingTxFrom).filter((t): t is PendingTx => t !== null)
      return { txs, source: 'eth_pendingTransactions' }
    }
  } catch {
    // Fall through. The second method is 165 times the payload and it is better than nothing.
  }

  const raw = await ask(client, 'txpool_content')
  const pending = (raw as { pending?: unknown } | null)?.pending
  const txs: PendingTx[] = []
  if (typeof pending === 'object' && pending !== null) {
    // `{ address: { nonce: tx } }`, two levels deep, and both keys are strings.
    for (const byNonce of Object.values(pending as Record<string, unknown>)) {
      if (typeof byNonce !== 'object' || byNonce === null) continue
      for (const tx of Object.values(byNonce as Record<string, unknown>)) {
        const parsed = pendingTxFrom(tx)
        if (parsed) txs.push(parsed)
      }
    }
  }
  return { txs, source: 'txpool_content' }
}

/** What a whole pass of the mempool watch found. */
export type PoolClaims = PoolRead & {
  claims: RivalClaim[]
  /** The keys, ready to hand to `solve`. */
  claimed: Set<string>
}

/**
 * Read the pool and decode it. One round trip, and it belongs inside whatever loop already runs
 * per block — this adds no clock of its own.
 */
export async function readRivalClaims(
  client: PoolClient,
  opts: ClaimOptions = {},
): Promise<PoolClaims> {
  const read = await readPendingTransactions(client)
  const claims = rivalClaims(read.txs, opts)
  return { ...read, claims, claimed: claimedKeys(claims) }
}

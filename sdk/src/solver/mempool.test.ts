import { hashFeeConfig, singleFeeConfig } from '../feeconfig.js'
import { describe, expect, test } from 'vitest'
import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import { CURVE_LINEAR, FLAG_PARTIAL, ZERO, ZERO_HASH, intentKey, type SignedIntent } from '../intent.js'
import {
  SOLVER_SETTLEMENT_ABI,
  fillBatchCall,
  intentTuple,
  pureRoute,
  settleBatchCall,
  settleRingCall,
  type RingFill,
} from './abi.js'
import { buildBook, entryOf, intentIdOf, type BookEntry } from './book.js'
import { DEFAULT_CONFIDENCE, confidenceOf, orderAtomicLegs } from './confidence.js'
import {
  CLAIM_ENTRY_POINTS,
  ClaimAges,
  claimedKeys,
  claimedLegs,
  readPendingTransactions,
  readRivalClaims,
  rivalClaims,
  type PendingTx,
} from './mempool.js'
import { solve, upcoming, type SolveParams } from './plan.js'

/**
 * Seeing a rival's transaction before sending one of our own.
 *
 * The measurement these tests exist for: a leg a rival already took costs 15,982 gas inside a
 * tolerant batch and the rest still fills, and the same collision on a 3-leg ring costs 222,044
 * gas and earns nothing. So the tests that matter are about the ring path — that a claimed leg
 * keeps a ring from being built at all, and that the claim is read out of calldata correctly
 * enough to trust with that decision.
 *
 * Every fixture transaction is built by the encoders in `abi.ts` — the same ones this solver
 * sends with. That is the point: a rival running this software produces exactly these bytes, and
 * a decoder tested against hand-written calldata would only be tested against itself.
 */

const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN_B = '0x00000000000000000000000000000000000000bb' as Address
const SETTLEMENT = '0x00000000000000000000000000000000000000e1' as Address
const OUR_EXECUTOR = '0x00000000000000000000000000000000000000e0' as Address
/** A rival's own `ProveBatchExecutor`. This solver has never heard of this address. */
const RIVAL_EXECUTOR = '0x00000000000000000000000000000000000000d0' as Address
const US = '0x00000000000000000000000000000000000000c1' as Address
const RIVAL = '0x00000000000000000000000000000000000000c2' as Address
const FEE_TO = hashFeeConfig(singleFeeConfig('0x00000000000000000000000000000000000000fe'))

const T0 = 1_800_000_000n
const ONE = 1_000_000_000_000_000_000n
const RATE = 500_000_000_000_000n

let seq = 0

function intentOf(tokenIn: Address, tokenOut: Address, minOutStart = ONE): SignedIntent {
  seq++
  const maker = `0x${seq.toString(16).padStart(40, '0')}` as Address
  return {
    maker,
    recipient: maker,
    tokenIn,
    tokenOut,
    amountIn: ONE,
    minOutStart,
    minOutEnd: minOutStart,
    startTime: T0,
    endTime: T0 + 3600n,
    executor: ZERO,
    feeConfig: FEE_TO,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    feeRate: RATE,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: FLAG_PARTIAL,
    nonce: BigInt(seq),
    curve: CURVE_LINEAR,
    signature: `0x${seq.toString(16).padStart(2, '0').repeat(65)}` as Hex,
  }
}

const fillOf = (intent: SignedIntent, take = ONE): RingFill => ({ intent, take })

/** A pending transaction carrying an already-built call. */
const txOf = (
  from: Address,
  to: Address,
  input: Hex,
  hash = `0x${'ab'.repeat(32)}` as Hex,
): PendingTx => ({ hash, from, to, input })

const callInput = (c: { abi: readonly unknown[]; functionName: string; args: readonly unknown[] }) =>
  encodeFunctionData({
    abi: c.abi as never,
    functionName: c.functionName,
    args: c.args as never,
  } as never)

// ── The selector table ────────────────────────────────────────────────────────

describe('the entry points a claim can arrive on', () => {
  test('every fill entry point on all three contracts has a selector', () => {
    const labels = [...CLAIM_ENTRY_POINTS.values()].map((e) => e.label).sort()
    expect(labels).toEqual([
      // `fill` twice: the settlement's four-argument one and the executor's five-argument one
      // are different functions with different selectors, and a rival may use either.
      'fill',
      'fill',
      'fillBatch',
      'fillBatchWithCallback',
      'fillWithAuthorization',
      'fillWithCallback',
      'fillWithPermit',
      'fillWithPermit2',
      'settleRing',
    ])
  })

  test('the batch shapes are read off the ABI, not written down', () => {
    const byLabel = (l: string) => [...CLAIM_ENTRY_POINTS.values()].filter((e) => e.label === l)
    expect(byLabel('fillBatch')[0].shape).toBe('batch')
    expect(byLabel('fillBatchWithCallback')[0].shape).toBe('batch')
    expect(byLabel('settleRing')[0].shape).toBe('batch')
    expect(byLabel('fillWithPermit')[0].shape).toBe('single')
    expect(byLabel('fill').every((e) => e.shape === 'single')).toBe(true)
  })

  test('`dryRun` is not a claim, because it fills nothing', () => {
    // It is non-view, so a rival could send it. Counting a probe as a claim would stand this
    // solver down over legs nobody is taking.
    const probe = callInput({
      abi: SOLVER_SETTLEMENT_ABI,
      functionName: 'dryRun',
      args: [[{ intent: intentTuple(intentOf(TOKEN_A, TOKEN_B)), signature: '0x', take: ONE, arming: '0x' }], 0n],
    })
    expect(claimedLegs(probe)).toEqual([])
  })
})

// ── Decoding ──────────────────────────────────────────────────────────────────

describe('what a pending transaction gives away', () => {
  test('a `fillBatch` names every intent in it, in the key space the book uses', () => {
    const a = intentOf(TOKEN_A, TOKEN_B)
    const b = intentOf(TOKEN_B, TOKEN_A)
    const legs = claimedLegs(callInput(fillBatchCall(SETTLEMENT, [fillOf(a), fillOf(b)], RATE)))

    expect(legs.map((l) => intentKey(l.intent))).toEqual([intentKey(a), intentKey(b)])
    // The convention the whole feature rests on: a claim decoded out of a stranger's calldata
    // has to land on the same string the store keys the book by. Nothing in the compiler
    // enforces it, so it is enforced here.
    expect(legs.map((l) => intentKey(l.intent))).toEqual([intentIdOf(a), intentIdOf(b)])
    expect(legs.map((l) => l.take)).toEqual([ONE, ONE])
    expect(legs.every((l) => l.call === 'fillBatch')).toBe(true)
  })

  test('the whole intent survives the round trip, in checksummed form', () => {
    // viem checksums every address it decodes, so a claim's `maker` is cased and the fixture's
    // is not. It changes no answer here — `intentKey` lowercases the maker — but a caller that
    // compares a claim's address to one of its own must lowercase both, so the difference is
    // written down rather than left to be rediscovered.
    const a = intentOf(TOKEN_A, TOKEN_B, ONE - 7n)
    const [leg] = claimedLegs(callInput(fillBatchCall(SETTLEMENT, [fillOf(a, ONE / 3n)], RATE)))
    expect(leg.take).toBe(ONE / 3n)
    expect(leg.intent.tokenIn).toBe(getAddress(TOKEN_A))
    expect(leg.intent.tokenIn).not.toBe(a.tokenIn)
    const lower = (i: SignedIntent) => ({
      ...i,
      maker: i.maker.toLowerCase(),
      recipient: i.recipient.toLowerCase(),
      tokenIn: i.tokenIn.toLowerCase(),
      tokenOut: i.tokenOut.toLowerCase(),
      executor: i.executor.toLowerCase(),
      feeConfig: i.feeConfig.toLowerCase(),
    })
    expect(lower(leg.intent)).toEqual(lower(a))
  })

  test('a credit ring is read even though it is addressed to the rival own executor', () => {
    // The reason the decoder does not filter on `to`. A rival settling on credit sends to their
    // own `ProveBatchExecutor`, and the settlement call happens inside that transaction.
    const a = intentOf(TOKEN_A, TOKEN_B)
    const call = settleRingCall(RIVAL_EXECUTOR, [fillOf(a)], RATE, pureRoute(1, [TOKEN_A]))
    const claims = rivalClaims([txOf(RIVAL, RIVAL_EXECUTOR, callInput(call))], { mine: [US] })
    expect(claims.map((c) => c.key)).toEqual([intentKey(a)])
    expect(claims[0].to).toBe(RIVAL_EXECUTOR)
    expect(claims[0].call).toBe('settleRing')
  })

  test('`skipInvalid` comes back, so the caller can see how the rival is exposed', () => {
    const a = intentOf(TOKEN_A, TOKEN_B)
    const route = pureRoute(1, [TOKEN_A])
    const atomic = claimedLegs(callInput(settleRingCall(RIVAL_EXECUTOR, [fillOf(a)], RATE, route)))
    const tolerant = claimedLegs(
      callInput(settleBatchCall(RIVAL_EXECUTOR, [fillOf(a)], RATE, route)),
    )
    expect(atomic[0].skipInvalid).toBe(false)
    expect(tolerant[0].skipInvalid).toBe(true)
  })

  test('a single-intent fill is a claim, and is never tolerant', () => {
    const a = intentOf(TOKEN_A, TOKEN_B)
    const input = callInput({
      abi: SOLVER_SETTLEMENT_ABI,
      functionName: 'fill',
      args: [intentTuple(a), a.signature, ONE, RATE],
    })
    const [leg] = claimedLegs(input)
    expect(leg.call).toBe('fill')
    expect(intentKey(leg.intent)).toBe(intentKey(a))
    // One intent: the transaction fills it or it reverts. There is nothing to step over.
    expect(leg.skipInvalid).toBe(false)
  })

  test('ordinary traffic is not a claim', () => {
    // An ERC-20 transfer, a plain send, and calldata too short to hold a selector.
    const transfer = `0xa9059cbb${'00'.repeat(64)}` as Hex
    expect(claimedLegs(transfer)).toEqual([])
    expect(claimedLegs('0x')).toEqual([])
    expect(claimedLegs('0xa905')).toEqual([])
  })

  test('a matching selector over garbage yields nothing rather than throwing', () => {
    // Cheap to send and it must not take the solver down, nor invent an intent with holes in it.
    const selector = [...CLAIM_ENTRY_POINTS.keys()][0]
    expect(claimedLegs(`${selector}${'ff'.repeat(96)}` as Hex)).toEqual([])
    expect(claimedLegs(selector)).toEqual([])
  })
})

// ── Whose transaction it is ───────────────────────────────────────────────────

describe('telling a rival from ourselves', () => {
  const a = intentOf(TOKEN_A, TOKEN_B)
  const input = callInput(fillBatchCall(SETTLEMENT, [fillOf(a)], RATE))

  test('our own pending transaction is not a rival claim', () => {
    expect(rivalClaims([txOf(US, SETTLEMENT, input)], { mine: [US] })).toEqual([])
  })

  test('the match on `from` ignores case, because a node may answer either', () => {
    const shouted = US.toUpperCase().replace('0X', '0x') as Address
    expect(rivalClaims([txOf(shouted, SETTLEMENT, input)], { mine: [US] })).toEqual([])
  })

  test('a fleet names all of its own bots, or it stands down from itself', () => {
    const sibling = '0x00000000000000000000000000000000000000c3' as Address
    expect(rivalClaims([txOf(sibling, SETTLEMENT, input)], { mine: [US] })).toHaveLength(1)
    expect(rivalClaims([txOf(sibling, SETTLEMENT, input)], { mine: [US, sibling] })).toEqual([])
  })

  test('with nobody named, every pending fill is a rival', () => {
    expect(rivalClaims([txOf(US, SETTLEMENT, input)])).toHaveLength(1)
  })
})

// ── Reading the pool ──────────────────────────────────────────────────────────

describe('which method answers, and what it leaves out', () => {
  const a = intentOf(TOKEN_A, TOKEN_B)
  const input = callInput(fillBatchCall(SETTLEMENT, [fillOf(a)], RATE))
  const raw = { hash: `0x${'ab'.repeat(32)}`, from: RIVAL, to: SETTLEMENT, input }

  // Typed on its own terms rather than annotated as a `PoolClient`. That type takes `never[]` so
  // a real viem client can assign to it, and annotating the double would type its own argument
  // as `never` too. Structural assignment does the rest.
  const clientOf = (answers: Record<string, unknown>) => {
    const asked: string[] = []
    const request = async ({ method }: { method: string }): Promise<unknown> => {
      asked.push(method)
      if (!(method in answers)) throw new Error(`${method} is not supported`)
      return answers[method]
    }
    return { asked, request }
  }

  test('`eth_pendingTransactions` is preferred, and `txpool_content` is never asked', async () => {
    // 14,930 bytes against 2,458,980 for the same 19 transactions, measured on 943.
    const client = clientOf({ eth_pendingTransactions: [raw] })
    const read = await readPendingTransactions(client)
    expect(read.source).toBe('eth_pendingTransactions')
    expect(read.txs).toHaveLength(1)
    expect(client.asked).toEqual(['eth_pendingTransactions'])
  })

  test('a node that will not serve it falls back to `txpool_content`', async () => {
    const client = clientOf({ txpool_content: { pending: { [RIVAL]: { '7': raw } }, queued: {} } })
    const read = await readPendingTransactions(client)
    expect(read.source).toBe('txpool_content')
    expect(read.txs.map((t) => t.from)).toEqual([RIVAL])
    expect(client.asked).toEqual(['eth_pendingTransactions', 'txpool_content'])
  })

  test('the queued bucket is ignored, because a queued transaction cannot land next block', async () => {
    // On 943 the queued bucket held 1,050 transactions and 1,036 of them belonged to one account
    // stuck behind a nonce gap. Treating those as claims would hold legs back for as long as that
    // account stays stuck — the opportunity cost this feature is supposed to avoid paying.
    const client = clientOf({
      txpool_content: { pending: {}, queued: { [RIVAL]: { '9000': raw } } },
    })
    expect((await readPendingTransactions(client)).txs).toEqual([])
  })

  test('a transaction missing the fields this needs is dropped, not guessed at', async () => {
    const client = clientOf({
      eth_pendingTransactions: [raw, { hash: raw.hash, from: RIVAL }, null, 'nonsense'],
    })
    expect((await readPendingTransactions(client)).txs).toHaveLength(1)
  })

  test('a contract creation has no `to` and is still decoded', async () => {
    const client = clientOf({ eth_pendingTransactions: [{ ...raw, to: null }] })
    const read = await readPendingTransactions(client)
    expect(read.txs[0].to).toBeNull()
  })

  test('neither method answering is thrown, so the caller can redact and log it', async () => {
    // The error a viem client raises here carries the whole request URL, registry key and all.
    // It has to reach a log through `redact`, which is why this module formats no message.
    await expect(readPendingTransactions(clientOf({}))).rejects.toThrow()
  })

  test('a whole read hands back the key set the planner wants', async () => {
    const client = clientOf({ eth_pendingTransactions: [raw] })
    const out = await readRivalClaims(client, { mine: [US] })
    expect(out.claimed).toEqual(new Set([intentKey(a)]))
    expect(claimedKeys(out.claims)).toEqual(out.claimed)
  })
})

// ── Where the signal lands ────────────────────────────────────────────────────

/**
 * A two-ring the engine will always find and always price as worth doing.
 *
 * Both makers concede a tenth, which is far inside the boundary. A ring sized exactly at the
 * boundary prices as `unprofitable` and would make every test below pass for the wrong reason.
 */
function twoRing(): { entries: BookEntry[]; intents: SignedIntent[] } {
  const m = (ONE * 9n) / 10n
  const a = intentOf(TOKEN_A, TOKEN_B, m)
  const b = intentOf(TOKEN_B, TOKEN_A, m)
  // The book key is `intentKey`, exactly as `loadBookFromStore` sets it. A fixture that keyed
  // entries any other way would pass while production missed every claim.
  return { entries: [entryOf(a, ONE, intentIdOf(a)), entryOf(b, ONE, intentIdOf(b))], intents: [a, b] }
}

const solveParams = (o: Partial<SolveParams> = {}): SolveParams => ({
  at: T0,
  executor: OUR_EXECUTOR,
  gasPrice: 0n,
  ...o,
})

describe('a ring is not built around a leg somebody else has claimed', () => {
  test('the ring exists until one of its legs is claimed, and then it does not', () => {
    const { entries, intents } = twoRing()
    const book = buildBook(entries, 369)
    expect(solve(book, solveParams()).length).toBeGreaterThan(0)

    // One leg of two. A cycle minus a leg is not a cycle, so one is enough.
    const claimed = new Set([intentKey(intents[0])])
    expect(solve(book, solveParams({ claimed }))).toEqual([])
  })

  test('an empty claim set changes nothing', () => {
    const { entries } = twoRing()
    const book = buildBook(entries, 369)
    const before = solve(book, solveParams())
    const after = solve(book, solveParams({ claimed: new Set() }))
    expect(after.map((p) => p.ring.id)).toEqual(before.map((p) => p.ring.id))
  })

  test('a claim on somebody else entirely leaves the ring alone', () => {
    const { entries } = twoRing()
    const stranger = intentOf(TOKEN_A, TOKEN_B)
    const claimed = new Set([intentKey(stranger)])
    expect(solve(buildBook(entries, 369), solveParams({ claimed })).length).toBeGreaterThan(0)
  })

  test('the schedule ignores the pool, because the pool describes this block only', () => {
    // A ring that pays in four minutes is not a ring a rival is filling now. Hiding it from
    // `upcoming` would make the solver forget to look when the moment came.
    const m = (ONE * 9n) / 10n
    const a = intentOf(TOKEN_A, TOKEN_B, m)
    // A leg that only becomes affordable as its Dutch curve decays.
    const b = { ...intentOf(TOKEN_B, TOKEN_A, ONE * 2n), minOutEnd: m }
    const entries = [entryOf(a, ONE, intentIdOf(a)), entryOf(b, ONE, intentIdOf(b))]
    const book = buildBook(entries, 369)
    const claimed = new Set([intentKey(a), intentKey(b)])

    const params = solveParams({ claimed })
    expect(solve(book, params)).toEqual([])
    // 3,599, not 3,600: both legs end at T0 + 3600, where the chain answers `Expired`.
    expect(upcoming(book, params, 3599n).length).toBeGreaterThan(0)
  })
})

describe('the score, once a ring exists anyway', () => {
  test('a claimed leg outranks every other signal put together', () => {
    // The arithmetic the weight is sized on: the best a leg scores without a claim is 100 and
    // the worst it scores is −35, so a penalty below −135 always separates the two sets.
    const w = DEFAULT_CONFIDENCE
    const best = w.fundedEscrow + w.reasonOk + w.proven + w.timeFull
    const worst = 0 + 0 + (w.unproven + 3 * w.perFault) + 0
    expect(best).toBe(100)
    expect(worst).toBe(-35)
    expect(best + w.rivalClaim).toBeLessThan(worst)
  })

  test('the penalty is applied once, and only to the leg that is named', () => {
    const a = intentOf(TOKEN_A, TOKEN_B)
    const b = intentOf(TOKEN_B, TOKEN_A)
    const claimed = new Set([intentKey(a)])
    const scored = confidenceOf(fillOf(a), { at: T0, claimed })
    const clean = confidenceOf(fillOf(b), { at: T0, claimed })
    expect(scored.rival).toBe(DEFAULT_CONFIDENCE.rivalClaim)
    expect(clean.rival).toBe(0)
    expect(scored.score).toBe(scored.custody + scored.reason + scored.trust + scored.time + scored.rival)
  })

  test('a claimed leg goes first in an atomic batch, where a break is cheapest', () => {
    // 121,329 gas when the first leg is the one that breaks, 554,731 when it is the last.
    const a = intentOf(TOKEN_A, TOKEN_B)
    const b = intentOf(TOKEN_B, TOKEN_A)
    const fills = [fillOf(a), fillOf(b)]
    const claimed = new Set([intentKey(b)])
    const ordered = orderAtomicLegs(fills, pureRoute(2, [TOKEN_A, TOKEN_B]), { at: T0, claimed })
    expect(ordered.order).toEqual([1, 0])
    expect(ordered.fills.map((f) => intentKey(f.intent))).toEqual([intentKey(b), intentKey(a)])
  })

  test('a tolerant batch is still not reordered, claim or no claim', () => {
    // `packBatch` builds its route on the promise that a fill position is its leg index.
    const a = intentOf(TOKEN_A, TOKEN_B)
    const b = intentOf(TOKEN_B, TOKEN_A)
    const fills = [fillOf(a), fillOf(b)]
    const claimed = new Set([intentKey(b)])
    const ordered = orderAtomicLegs(fills, pureRoute(2, [TOKEN_A, TOKEN_B]), {
      at: T0,
      claimed,
      skipInvalid: true,
    })
    expect(ordered.order).toEqual([0, 1])
    // The scores still carry the signal, so a caller can read it even when nothing moves.
    expect(ordered.scores[1].rival).toBe(DEFAULT_CONFIDENCE.rivalClaim)
  })
})

// ── What counts as a claim at all ─────────────────────────────────────────────

/**
 * A claim holds a leg back from our own rings, so a cheap fake claim is a cheap way to grief.
 * These rules make a claim cost what a real fill costs: it goes to the settlement, it takes
 * something, it carries a plausible signature, it pays a tip that can land, and it lands soon.
 */
describe('a claim has to look like a fill that can land', () => {
  const a = intentOf(TOKEN_A, TOKEN_B)
  const batch = callInput(fillBatchCall(SETTLEMENT, [fillOf(a)], RATE))

  test('a settlement entry point sent anywhere but the settlement is not a claim', () => {
    const elsewhere = txOf(RIVAL, RIVAL_EXECUTOR, batch)
    expect(rivalClaims([elsewhere], { settlement: SETTLEMENT })).toEqual([])
    expect(rivalClaims([txOf(RIVAL, SETTLEMENT, batch)], { settlement: SETTLEMENT })).toHaveLength(1)
  })

  test('an executor entry point may still go to an executor this solver never heard of', () => {
    const call = settleRingCall(RIVAL_EXECUTOR, [fillOf(a)], RATE, pureRoute(1, [TOKEN_A]))
    const claims = rivalClaims([txOf(RIVAL, RIVAL_EXECUTOR, callInput(call))], { settlement: SETTLEMENT })
    expect(claims).toHaveLength(1)
  })

  test('a leg that takes nothing is not a claim', () => {
    expect(claimedLegs(callInput(fillBatchCall(SETTLEMENT, [fillOf(a, 0n)], RATE)))).toEqual([])
  })

  test('a signature that is empty or absurdly long is not a claim', () => {
    const empty = { ...a, signature: '0x' as Hex }
    const huge = { ...a, signature: `0x${'11'.repeat(5_000)}` as Hex }
    expect(claimedLegs(callInput(fillBatchCall(SETTLEMENT, [fillOf(empty)], RATE)))).toEqual([])
    expect(claimedLegs(callInput(fillBatchCall(SETTLEMENT, [fillOf(huge)], RATE)))).toEqual([])
  })

  test('a transaction that pays under the tip floor is not a claim', () => {
    const cheap = { ...txOf(RIVAL, SETTLEMENT, batch), maxPriorityFeePerGas: 1n }
    const fair = { ...txOf(RIVAL, SETTLEMENT, batch), maxPriorityFeePerGas: 1_000_000_000n }
    expect(rivalClaims([cheap], { minPriorityFee: 1_000_000_000n })).toEqual([])
    expect(rivalClaims([fair], { minPriorityFee: 1_000_000_000n })).toHaveLength(1)
  })

  test('the tip is read off a node answer, from either fee field', async () => {
    const client = {
      request: async () => [
        { hash: `0x${'01'.repeat(32)}`, from: RIVAL, to: SETTLEMENT, input: batch, maxPriorityFeePerGas: '0x3b9aca00' },
        { hash: `0x${'02'.repeat(32)}`, from: RIVAL, to: SETTLEMENT, input: batch, gasPrice: '0x07' },
      ],
    }
    const read = await readRivalClaims(client, { minPriorityFee: 1_000_000_000n })
    expect(read.claims.map((c) => c.hash)).toEqual([`0x${'01'.repeat(32)}`])
  })

  test('a claim that has not landed after N blocks stops counting', () => {
    const ages = new ClaimAges(3)
    const claims = rivalClaims([txOf(RIVAL, SETTLEMENT, batch)])
    expect(ages.fresh(claims, 100n)).toHaveLength(1)
    expect(ages.fresh(claims, 103n)).toHaveLength(1)
    expect(ages.fresh(claims, 104n)).toEqual([])
  })

  test('a transaction that leaves the pool is forgotten, so it cannot pin a stale age', () => {
    const ages = new ClaimAges(3)
    const claims = rivalClaims([txOf(RIVAL, SETTLEMENT, batch)])
    ages.fresh(claims, 100n)
    ages.fresh([], 101n)
    expect(ages.fresh(claims, 110n)).toHaveLength(1)
  })
})

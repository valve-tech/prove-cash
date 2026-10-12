import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { parseUnits, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  CURVE_LINEAR,
  FLAG_ESCROW,
  FLAG_PARTIAL,
  KIND_STRETCH,
  ZERO,
  ZERO_HASH,
  domain,
  encodeIntent,
  forgetWireFeeConfigs,
  intentKey,
  stretchCurve,
  verifyIntent,
  signIntent,
  wireFeeConfig,
} from '../intent.js'
import { hashFeeConfig, singleFeeConfig } from '../feeconfig.js'
import type { Intent, SignedIntent } from '../intent.js'
import { setSettlementOverride } from '../config.js'
import { createIntentStore, memoryStorage, recordToIntent } from './index.js'
import type { IngestInput, IntentSource } from './index.js'

/**
 * The store on the Map backend, which is the one a solver runs. Everything the browser gets
 * from IndexedDB has to hold here too: a bad signature never lands, a repeat sighting never
 * duplicates, and the predicates answer the three questions a filler asks — is it live, is the
 * rate in range, and does it match my configuration.
 */

const WPLS: Address = '0xA1077a294dDE1B09bB078844df40758a5D0f9a27'
const PLSX: Address = '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab'
const NOW = 1_700_000_000

const maker = privateKeyToAccount(generatePrivateKey())
const other = privateKeyToAccount(generatePrivateKey())

/**
 * A settlement for 369, because the store now refuses a chain that has none.
 *
 * Every test below signs and ingests on 369, and the registry carries a deliberate zero there —
 * so until this override existed the whole file was, without meaning to be, a demonstration that
 * the store accepts intents bound to `0x0000…0000`. The address is arbitrary; that there is one
 * is the point. `refuses a chain that settles nowhere` takes it away again on purpose.
 */
const SETTLEMENT: Address = '0x00000000000000000000000000000000000f0f0f'

beforeAll(() => setSettlementOverride(369, SETTLEMENT))
afterAll(() => setSettlementOverride(369, null))

function terms(over: Partial<Intent> = {}): Intent {
  return {
    maker: maker.address,
    recipient: maker.address,
    tokenIn: WPLS,
    tokenOut: PLSX,
    amountIn: parseUnits('1000', 18),
    minOutStart: parseUnits('500', 18),
    minOutEnd: parseUnits('500', 18),
    startTime: BigInt(NOW - 60),
    endTime: BigInt(NOW + 3600),
    executor: ZERO,
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: FLAG_PARTIAL,
    nonce: BigInt(over.nonce ?? 1n),
    curve: CURVE_LINEAR,
    ...over,
  }
}

async function sign(i: Intent, by = maker): Promise<SignedIntent> {
  const signature = await signIntent(by, i, { domain: domain(369) })
  return { ...i, signature }
}

function sighting(s: SignedIntent, over: Partial<IngestInput> = {}): IngestInput {
  return {
    intent: s,
    data: encodeIntent(s),
    msgHash: ('0x' + '01'.repeat(32)) as Hex,
    blockNumber: 100n,
    firstSeenAt: NOW,
    source: 'live' as IntentSource,
    decimalsIn: 18,
    decimalsOut: 18,
    ...over,
  }
}

describe('the in-memory store', () => {
  test('keeps a verified intent and gives it back', async () => {
    const store = createIntentStore(memoryStorage())
    const signed = await sign(terms())
    expect(await store.ingest(369, sighting(signed))).toBe(true)

    const { rows } = await store.query({ chainId: 369 })
    expect(rows).toHaveLength(1)
    expect(rows[0].key).toBe(intentKey(signed))
    expect(rows[0].amountIn).toBe(signed.amountIn.toString())
    expect(rows[0].rate).toBeCloseTo(0.5)
  })

  /**
   * The curve is a signed field, so a record that dropped it would rebuild an intent that no
   * longer verifies — and every reader of that record would decide the maker's own signature was
   * forged. A record written before the field existed reads back as the straight line, which is
   * what those intents carried.
   */
  test('a record carries the curve back, and an old record reads as the line', async () => {
    const store = createIntentStore(memoryStorage())
    const signed = await sign(terms({ flags: FLAG_PARTIAL | KIND_STRETCH, curve: stretchCurve(0.25, 0.5) }))
    expect(await store.ingest(369, sighting(signed))).toBe(true)

    const { rows } = await store.query({ chainId: 369 })
    expect(rows[0].curve).toBe(stretchCurve(0.25, 0.5))
    const back = recordToIntent(rows[0])
    expect(back.curve).toBe(signed.curve)
    expect(await verifyIntent(back, 369)).toBe(true)

    // The same record with the field taken away, which is every record written before today.
    const older = recordToIntent({ ...rows[0], curve: undefined })
    expect(older.curve).toBe(CURVE_LINEAR)
  })

  test('refuses an intent whose signature is not the maker’s', async () => {
    const store = createIntentStore(memoryStorage())
    const i = terms({ nonce: 2n })
    // Signed by a stranger, claimed by the maker.
    const forged: SignedIntent = { ...i, signature: (await sign(i, other)).signature }
    expect(await store.ingest(369, sighting(forged))).toBe(false)
    expect((await store.query({ chainId: 369 })).rows).toHaveLength(0)
  })

  /**
   * The store keeps a post's fee config preimage for reading only once the signature verifies,
   * which is `readIntent`'s rule: a forged post must not evict a preimage a keeper needs.
   */
  test('keeps a preimage from a verified sighting, and none from a forged one', async () => {
    forgetWireFeeConfigs()
    const store = createIntentStore(memoryStorage())
    const cfg = singleFeeConfig('0x000000000000000000000000000000000000C0Fe')
    const i = terms({ nonce: 21n, feeConfig: hashFeeConfig(cfg), feeRate: 10n ** 15n })
    const forged: SignedIntent = {
      ...i,
      signature: await signIntent(other, i, { preimage: cfg, domain: domain(369) }),
      feeConfigPreimage: cfg,
    }
    expect(await store.ingest(369, sighting(forged))).toBe(false)
    expect(wireFeeConfig(hashFeeConfig(cfg))).toBeNull()
    const signed: SignedIntent = {
      ...i,
      signature: await signIntent(maker, i, { preimage: cfg, domain: domain(369) }),
      feeConfigPreimage: cfg,
    }
    expect(await store.ingest(369, sighting(signed))).toBe(true)
    expect(wireFeeConfig(hashFeeConfig(cfg))).toEqual(cfg)
  })

  test('a repeat sighting merges instead of duplicating', async () => {
    const store = createIntentStore(memoryStorage())
    const signed = await sign(terms({ nonce: 3n }))
    await store.ingest(369, sighting(signed, { blockNumber: 100n, firstSeenAt: NOW, source: 'archive' }))
    await store.ingest(369, sighting(signed, { blockNumber: 140n, firstSeenAt: NOW + 10, source: 'mine' }))

    const { rows } = await store.query({ chainId: 369 })
    expect(rows).toHaveLength(1)
    expect(rows[0].lastSeenBlock).toBe(140)
    // The earliest sighting wins the date, and the better source wins the label.
    expect(rows[0].firstSeenAt).toBe(NOW)
    expect(rows[0].source).toBe('mine')
  })

  test('an older sighting cannot walk a record backwards', async () => {
    const store = createIntentStore(memoryStorage())
    const signed = await sign(terms({ nonce: 4n }))
    await store.ingest(369, sighting(signed, { blockNumber: 140n, source: 'mine' }))
    await store.ingest(369, sighting(signed, { blockNumber: 100n, source: 'archive' }))
    const { rows } = await store.query({ chainId: 369 })
    expect(rows[0].lastSeenBlock).toBe(140)
    expect(rows[0].source).toBe('mine')
  })
})

describe('the query predicates', () => {
  async function stocked() {
    const store = createIntentStore(memoryStorage())
    const rows = [
      await sign(terms({ nonce: 10n })), // open, partial, wallet custody, cheap
      await sign(terms({ nonce: 11n, endTime: BigInt(NOW - 1) })), // expired
      await sign(terms({ nonce: 12n, flags: FLAG_ESCROW })), // escrow, all-or-nothing
      await sign(terms({ nonce: 13n, minOutStart: parseUnits('2000', 18), minOutEnd: parseUnits('2000', 18) })), // expensive
      await sign(terms({ nonce: 14n, executor: other.address })), // pinned
      await sign(terms({ nonce: 15n, tokenIn: PLSX, tokenOut: WPLS })), // the other side of the pair
    ]
    for (const r of rows) await store.ingest(369, sighting(r))
    return { store, rows }
  }

  test('liveAt drops what has already expired', async () => {
    const { store } = await stocked()
    expect((await store.query({ chainId: 369 })).rows).toHaveLength(6)
    const open = await store.query({ chainId: 369, liveAt: NOW })
    expect(open.rows).toHaveLength(5)
    expect(open.rows.every((r) => r.endTime > NOW)).toBe(true)
  })

  test('a rate range keeps only what pays inside it', async () => {
    const { store } = await stocked()
    const cheap = await store.query({ chainId: 369, rate: { max: 1 } })
    expect(cheap.rows.every((r) => r.rate <= 1)).toBe(true)
    expect(cheap.rows.some((r) => r.nonce === '13')).toBe(false)

    const dear = await store.query({ chainId: 369, rate: { min: 1.5 } })
    expect(dear.rows.map((r) => r.nonce)).toEqual(['13'])
  })

  test('custody, partial and executor answer an executor’s configuration', async () => {
    const { store } = await stocked()
    expect((await store.query({ chainId: 369, custody: 'escrow' })).rows.map((r) => r.nonce)).toEqual(['12'])
    expect((await store.query({ chainId: 369, partialOnly: true })).rows.every((r) => (r.flags & 1) !== 0)).toBe(true)

    const openToAnyone = await store.query({ chainId: 369, executor: { open: true } })
    expect(openToAnyone.rows.some((r) => r.nonce === '14')).toBe(false)

    const mine = await store.query({ chainId: 369, executor: { address: other.address, open: true } })
    expect(mine.rows.some((r) => r.nonce === '14')).toBe(true)
  })

  test('a pair filter walks one side only', async () => {
    const { store } = await stocked()
    const oneWay = await store.query({ chainId: 369, pair: `${WPLS}>${PLSX}` })
    expect(oneWay.rows).toHaveLength(5)
    const back = await store.query({ chainId: 369, pair: `${PLSX}>${WPLS}` })
    expect(back.rows.map((r) => r.nonce)).toEqual(['15'])
  })

  test('a limit pages, and the cursor carries on where it stopped', async () => {
    const { store } = await stocked()
    const first = await store.query({ chainId: 369, limit: 2 })
    expect(first.rows).toHaveLength(2)
    expect(first.cursor).not.toBeNull()
    const second = await store.query({ chainId: 369, limit: 10, after: first.cursor! })
    expect(second.rows).toHaveLength(4)
    const seen = new Set([...first.rows, ...second.rows].map((r) => r.key))
    expect(seen.size).toBe(6)
  })

  test('depth counts open and total per pair', async () => {
    const { store } = await stocked()
    const depth = await store.pairDepth(369, NOW)
    const forward = depth.find((d) => d.pair === `${WPLS}>${PLSX}`.toLowerCase())!
    expect(forward.total).toBe(5)
    expect(forward.open).toBe(4)
  })

  test('another chain sees nothing', async () => {
    const { store } = await stocked()
    expect((await store.query({ chainId: 943 })).rows).toHaveLength(0)
  })
})

/**
 * The public order book and the exclusive-quote marketplace share a store, and must not share a
 * list.
 *
 * An exclusive quote is an ordinary signed intent with one thing different: `executor` names the
 * RFQ venue, and `ProveSettlement` refuses anybody else. So it ingests exactly like an open offer
 * and there is nothing in the record that says "private" — only the executor, which is the fact
 * the board's own query turns on.
 *
 * Category separates the two marketplaces on the wire and this is the other line: a quote that
 * reached the store by ANY route — the wrong category, a future ingest path, a maker pasting one
 * in — still never reaches a public list.
 */
describe('an exclusive quote never reaches the public book', () => {
  const venue: Address = '0x000000000000000000000000000000000000dEaD'

  test('the board asks for open offers and gets only those', async () => {
    const store = createIntentStore(memoryStorage())
    const open = await sign(terms({ nonce: 900n }))
    const quote = await sign(terms({ nonce: 901n, executor: venue }))
    for (const i of [open, quote]) {
      await store.ingest(369, sighting(i))
    }

    // Both are in the store. That is the point: the filter is what separates them, not the ingest.
    const everything = await store.query({ chainId: 369 })
    expect(everything.rows).toHaveLength(2)

    const publicBook = await store.query({ chainId: 369, executor: { open: true } })
    expect(publicBook.rows.map((r) => r.nonce)).toEqual(['900'])
  })

  test('a quote pinned to one venue does not show up for a different executor', async () => {
    const store = createIntentStore(memoryStorage())
    const quote = await sign(terms({ nonce: 902n, executor: venue }))
    await store.ingest(369, sighting(quote))

    // A solver asks with its own address AND `open: true`. It is entitled to what is open and to
    // what is pinned to it, and to nothing pinned to anybody else.
    const stranger = await store.query({
      chainId: 369,
      executor: { address: other.address, open: true },
    })
    expect(stranger.rows).toHaveLength(0)

    // The venue itself does see it, which is what makes the quote takeable at all.
    const itsOwn = await store.query({ chainId: 369, executor: { address: venue, open: true } })
    expect(itsOwn.rows.map((r) => r.nonce)).toEqual(['902'])
  })
})

/**
 * An intent bound to no contract never reaches the book.
 *
 * On a chain with no settlement the EIP-712 domain carries a `verifyingContract` of
 * `0x0000…0000`. A maker can sign under it, the board will carry the post, and the signature is
 * genuinely theirs — seven such offers reached the public mainnet archive. What none of them can
 * ever be is filled: no contract settles that domain, and no later deploy rescues one, because
 * the address the signature names is not the address that ships.
 *
 * **The signature check cannot see this and calls it valid**, which is the whole reason the guard
 * is separate. `verifyIntent` recovers the maker from a well-formed digest and answers true. The
 * test below asserts exactly that first, so a reader can see the store is refusing something its
 * own verifier was happy with.
 */
describe('an intent bound to no contract', () => {
  test('a chain that settles nowhere has its intents refused', async () => {
    const store = createIntentStore(memoryStorage())
    // 369 settling nowhere, by override: after #52 the registry names a settlement.
    setSettlementOverride(369, '0x0000000000000000000000000000000000000000')
    try {
      const zeroBound = await sign(terms({ nonce: 700n }))
      // The signature IS the maker's, under the zero domain it was made in.
      expect(await verifyIntent(zeroBound, 369)).toBe(true)
      // And the store refuses it anyway.
      expect(await store.ingest(369, sighting(zeroBound))).toBe(false)
      expect((await store.query({ chainId: 369 })).rows).toHaveLength(0)
    } finally {
      setSettlementOverride(369, SETTLEMENT)
    }
  })

  test('and the same store takes one on a chain that settles', async () => {
    // The other direction, so the refusal cannot be a store that rejects everything.
    const store = createIntentStore(memoryStorage())
    const bound = await sign(terms({ nonce: 701n }))
    expect(await store.ingest(369, sighting(bound))).toBe(true)
    expect((await store.query({ chainId: 369 })).rows).toHaveLength(1)
  })
})

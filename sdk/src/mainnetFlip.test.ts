import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { Address, Chain, Hex, HttpTransport, PublicClient } from 'viem'
import {
  CHAIN_IDS,
  DEFAULT_CHAIN,
  NETWORKS,
  defaultRpc,
  feeTarget,
  feeTargetName,
  getChainRpc,
  getRpc,
  isSupportedChain,
  presetTokens,
  setChainId,
  setSettlementOverride,
  settlement,
  settlementLive,
  xykLive,
  xykRouter,
  xykVenue,
  xykVenues,
  type ChainId,
} from './config.js'
import {
  CURVE_LINEAR,
  ZERO,
  ZERO_HASH,
  domain,
  encodeIntent,
  intentHashOf,
  signingDomain,
  verifyIntent,
  type Intent,
  type SignedIntent,
  signIntent,
} from './intent.js'
import { myIntents, remember } from './keepalive.js'
import { kv, memoryKeyValueStore, setKeyValueStore } from './kv.js'
import { clearVenueProbes, confirmVenues } from './market.js'
import { forgetMulticallProbes } from './multicall.js'
import { approvalTarget } from './settlement.js'
import { createIntentStore, memoryStorage } from './store/index.js'
import { cachedToken } from './tokens.js'

/**
 * Turning mainnet on must change nothing for testnet.
 *
 * #35 redeploys chain 369 and gives the registry a real settlement address where it carries a
 * deliberate zero today. Every reader in this package resolves through `settlement()`, so that
 * one address decides a great deal: whether a chain can sign, whether its board trades, which
 * contract a read goes to, and which venue an exclusive quote may name. Nobody had tested that
 * the flip stops at 369.
 *
 * **The flip is an override here, not an edit to the registry.** `settlement()` reads an
 * in-process override, then a stored one, then the registry, and a mainnet deploy only changes
 * the third. The override reaches every reader by the same path the registry does, so it is a
 * faithful rehearsal — and unlike an assertion about the registry's zero, this file still means
 * what it means the morning 369 ships.
 *
 * Every test takes the 943 answer before the flip and compares it after. A comparison alone
 * proves nothing, though: a flip that silently failed would pass every one of them. So each
 * section also asserts that 369 moved.
 */

/** What #35 puts in the registry, standing in for an address nobody has deployed yet. */
const MAINNET: Address = '0x000000000000000000000000000000000000369a'

/** The chain the flip turns on. */
const FLIPPED: ChainId = 369
/** The chain that must not notice. */
const TESTNET: ChainId = 943

/** Turn mainnet on, exactly as the registry entry will. */
const flipOn = () => setSettlementOverride(FLIPPED, MAINNET)

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  // Off by override, not by the registry's zero: after #52 the registry names a settlement.
  setSettlementOverride(FLIPPED, ZERO)
  setSettlementOverride(TESTNET, null)
  setChainId(TESTNET)
  clearVenueProbes()
  forgetMulticallProbes()
})

afterEach(() => {
  setSettlementOverride(FLIPPED, null)
  setSettlementOverride(TESTNET, null)
  setChainId(DEFAULT_CHAIN)
  clearVenueProbes()
  forgetMulticallProbes()
})

// ── The flip itself ───────────────────────────────────────────────────────────

describe('the flip', () => {
  test('mainnet settles nowhere before it, and somewhere after', () => {
    // The control every other test in this file rests on. Without it a flip that did nothing
    // would make each comparison below pass for the wrong reason.
    expect(settlementLive(FLIPPED)).toBe(false)
    flipOn()
    expect(settlementLive(FLIPPED)).toBe(true)
    expect(settlement(FLIPPED)).toBe(MAINNET)
  })

  test('it does not move a fresh install to mainnet', () => {
    // Opening a new visitor on 369 is a decision somebody makes on purpose. Deploying there is
    // not that decision, and `DEFAULT_CHAIN` is the line between the two.
    flipOn()
    expect(DEFAULT_CHAIN).toBe(TESTNET)
    expect(settlementLive(DEFAULT_CHAIN)).toBe(true)
  })

  test('it registers no chain and de-registers none', () => {
    const before = [...CHAIN_IDS]
    flipOn()
    expect([...CHAIN_IDS]).toEqual(before)
    expect(isSupportedChain(TESTNET)).toBe(true)
    expect(isSupportedChain(1)).toBe(false)
  })
})

// ── The addresses 943 answers with ────────────────────────────────────────────

describe('every address testnet answers with', () => {
  test('its settlement does not move', () => {
    const before = settlement(TESTNET)
    flipOn()
    expect(settlement(TESTNET)).toBe(before)
    expect(settlement(TESTNET)).toBe(NETWORKS[TESTNET].settlement)
    expect(settlementLive(TESTNET)).toBe(true)
    // And the two chains do not converge on one contract.
    expect(settlement(TESTNET)).not.toBe(settlement(FLIPPED))
  })

  test('its fee destination does not move', () => {
    const address = feeTarget(TESTNET)
    const name = feeTargetName(TESTNET)
    flipOn()
    expect(feeTarget(TESTNET)).toBe(address)
    expect(feeTargetName(TESTNET)).toBe(name)
    // The registry carries a different destination per chain, and the mainnet one has no code
    // on 943. A flip that merged them would send a testnet fee to an address that cannot take it.
    expect(feeTarget(TESTNET)).not.toBe(feeTarget(FLIPPED))
  })

  test('its venues do not move, and no mainnet router joins them', () => {
    const before = xykVenues(TESTNET)
    flipOn()
    expect(xykVenues(TESTNET)).toBe(before)
    expect(xykRouter(TESTNET)).toBe(before[0].router)
    expect(xykVenue('v1', TESTNET)).toEqual(before[0])
    expect(xykLive(TESTNET)).toBe(true)

    // Neither mainnet router has any code on 943. The registry note says so and this holds the
    // two lists apart: one shared address here is one quote sent to a contract that is not there.
    const mainnet = new Set(xykVenues(FLIPPED).map((v) => v.router.toLowerCase()))
    for (const v of xykVenues(TESTNET)) expect(mainnet.has(v.router.toLowerCase())).toBe(false)
  })

  test('its preset tokens do not move', () => {
    const before = presetTokens(TESTNET)
    flipOn()
    expect(presetTokens(TESTNET)).toBe(before)
    expect(presetTokens(TESTNET)).toBe(NETWORKS[TESTNET].tokens)
  })

  test('its endpoints do not move', () => {
    const board = getRpc(TESTNET)
    const chain = getChainRpc(TESTNET)
    flipOn()
    expect(getRpc(TESTNET)).toBe(board)
    expect(getChainRpc(TESTNET)).toBe(chain)
    expect(getRpc(TESTNET)).toBe(defaultRpc(TESTNET))
    // The default endpoint carries the chain id in its path, so the two chains never share one.
    expect(defaultRpc(TESTNET)).not.toBe(defaultRpc(FLIPPED))
  })
})

// ── What a 943 maker signs ────────────────────────────────────────────────────

const maker = privateKeyToAccount(generatePrivateKey())

function terms(over: Partial<Intent> = {}): Intent {
  return {
    maker: maker.address,
    recipient: maker.address,
    tokenIn: NETWORKS[TESTNET].tokens[0].address,
    tokenOut: NETWORKS[TESTNET].tokens[1].address,
    amountIn: 1_000n,
    minOutStart: 900n,
    minOutEnd: 900n,
    // A real window, because the wire codec packs `endTime - startTime` into four bytes and a
    // span of more than 136 years does not fit. It ends far enough ahead that `myIntents`, which
    // reads the wall clock, still counts it as live.
    startTime: 1_700_000_000n,
    endTime: 4_000_000_000n,
    executor: ZERO,
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: 0,
    nonce: 1n,
    curve: CURVE_LINEAR,
    ...over,
  }
}

async function signOn(chainId: ChainId, i: Intent): Promise<SignedIntent> {
  const signature = await signIntent(maker, i, { domain: domain(chainId) })
  return { ...i, signature }
}

describe('what a testnet maker signs', () => {
  test('the domain keeps its own chain and its own contract', () => {
    const before = domain(TESTNET)
    flipOn()
    expect(domain(TESTNET)).toEqual(before)
    expect(domain(TESTNET).chainId).toBe(TESTNET)
    expect(domain(TESTNET).verifyingContract).toBe(NETWORKS[TESTNET].settlement)
    // Signing goes through the guarded resolver, so hold that one too.
    expect(signingDomain(TESTNET)).toEqual(before)

    // And mainnet's domain did move, so this comparison is worth making.
    expect(domain(FLIPPED).verifyingContract).toBe(MAINNET)
  })

  test('an offer signed before the flip still verifies after it', async () => {
    // The whole point. A testnet maker's signature is bound to `chainId` 943 and to 943's
    // settlement, and neither changes, so an offer resting on the board survives the deploy.
    const signed = await signOn(TESTNET, terms())
    expect(await verifyIntent(signed, TESTNET)).toBe(true)
    flipOn()
    expect(await verifyIntent(signed, TESTNET)).toBe(true)
  })

  test('and it means nothing on mainnet, before the flip or after', async () => {
    const signed = await signOn(TESTNET, terms())
    expect(await verifyIntent(signed, FLIPPED)).toBe(false)
    flipOn()
    expect(await verifyIntent(signed, FLIPPED)).toBe(false)
  })

  test('the digest an escrow and a 3009 nonce key on does not move', () => {
    // `intentHashOf` is the value a deposit is filed under and the nonce an authorization must
    // carry. If the flip moved it, every armed testnet offer would be orphaned.
    const i = terms()
    const before = intentHashOf(i, TESTNET)
    flipOn()
    expect(intentHashOf(i, TESTNET)).toBe(before)
    // The same terms hash differently on mainnet, because the domain carries the contract.
    expect(intentHashOf(i, FLIPPED)).not.toBe(before)
  })
})

// ── Where a 943 read actually goes ────────────────────────────────────────────

/** One contract read, as the recorder saw it. */
type Read = { address: Address; functionName: string }

/**
 * A client that answers the reads under test and remembers every address it was asked about.
 *
 * `getCode` answers `0x`, so `batchRead` finds no Multicall3 and falls back to single reads.
 * That matters: a batched read would name Multicall3 as its address and hide the venue
 * addresses this is here to check.
 */
function recorder(answer: (call: Read) => unknown) {
  const reads: Read[] = []
  const client = {
    getCode: async () => '0x' as Hex,
    readContract: async (call: Read) => {
      reads.push({ address: call.address, functionName: call.functionName })
      return answer(call)
    },
  } as unknown as PublicClient<HttpTransport, Chain>
  return { client, reads }
}

describe('where a testnet read goes', () => {
  test('a venue probe asks testnet routers and no mainnet one', async () => {
    flipOn()
    const venues = xykVenues(TESTNET)
    const factories = new Map(venues.map((v) => [v.router.toLowerCase(), v.factory]))
    const { client, reads } = recorder((call) => factories.get(call.address.toLowerCase()))

    const live = await confirmVenues(venues, { chainId: TESTNET, client })
    expect(live).toEqual(venues)

    // Every address the probe touched belongs to 943.
    const asked = reads.map((r) => r.address.toLowerCase())
    const mine = new Set(venues.map((v) => v.router.toLowerCase()))
    expect(asked.length).toBeGreaterThan(0)
    for (const a of asked) expect(mine.has(a)).toBe(true)

    // Said the other way, because a set membership test can pass on an empty set.
    const mainnet = new Set(xykVenues(FLIPPED).map((v) => v.router.toLowerCase()))
    for (const a of asked) expect(mainnet.has(a)).toBe(false)
  })

  test('the relayer read asks the testnet settlement', async () => {
    // `approvalTarget` is the address a maker approves, read off the settlement rather than
    // carried in configuration. An approval sent to mainnet's relayer would do nothing on 943,
    // and the maker would find out when a fill reverted.
    flipOn()
    const relayer: Address = '0x0000000000000000000000000000000000005e1a'
    const { client, reads } = recorder(() => relayer)

    expect(await approvalTarget({ chainId: TESTNET, client })).toBe(relayer)
    expect(reads).toHaveLength(1)
    expect(reads[0].functionName).toBe('relayer')
    expect(reads[0].address).toBe(settlement(TESTNET))
    expect(reads[0].address).not.toBe(MAINNET)
  })
})

// ── The book ──────────────────────────────────────────────────────────────────

function sighting(s: SignedIntent) {
  return {
    intent: s,
    data: encodeIntent(s),
    msgHash: ('0x' + '01'.repeat(32)) as Hex,
    blockNumber: 100n,
    firstSeenAt: 1_700_000_000,
    source: 'live' as const,
    decimalsIn: 18,
    decimalsOut: 18,
  }
}

describe('the book', () => {
  test('a mainnet offer never appears in a testnet query', async () => {
    flipOn()
    const store = createIntentStore(memoryStorage())
    const onTestnet = await signOn(TESTNET, terms({ nonce: 1n }))
    const onMainnet = await signOn(FLIPPED, terms({ nonce: 2n }))

    expect(await store.ingest(TESTNET, sighting(onTestnet))).toBe(true)
    expect(await store.ingest(FLIPPED, sighting(onMainnet))).toBe(true)

    const testnet = await store.query({ chainId: TESTNET })
    expect(testnet.rows).toHaveLength(1)
    expect(testnet.rows[0].nonce).toBe('1')

    const mainnet = await store.query({ chainId: FLIPPED })
    expect(mainnet.rows).toHaveLength(1)
    expect(mainnet.rows[0].nonce).toBe('2')
  })

  test('pair depth counts one chain at a time', async () => {
    flipOn()
    const store = createIntentStore(memoryStorage())
    await store.ingest(TESTNET, sighting(await signOn(TESTNET, terms({ nonce: 3n }))))
    await store.ingest(FLIPPED, sighting(await signOn(FLIPPED, terms({ nonce: 4n }))))

    const depth = await store.pairDepth(TESTNET, 1_700_000_000)
    expect(depth.reduce((n, d) => n + d.total, 0)).toBe(1)
  })

  test('the ingest guard opens for mainnet and leaves testnet as it was', async () => {
    // `store/index.ts` refuses a chain that settles nowhere. Before the flip a mainnet sighting
    // is turned away at that guard; after it, a mainnet sighting stores. Testnet is accepted
    // either side, which is the half that matters here.
    const store = createIntentStore(memoryStorage())
    const before = await signOn(FLIPPED, terms({ nonce: 5n }))
    expect(await store.ingest(FLIPPED, sighting(before))).toBe(false)
    expect(await store.ingest(TESTNET, sighting(await signOn(TESTNET, terms({ nonce: 6n }))))).toBe(
      true,
    )

    flipOn()
    // Signed after the flip, and that is not a detail. An offer signed while 369 settled nowhere
    // named a `verifyingContract` of `0x0000…0000`, and the deploy does not rescue it: the
    // domain it committed to is not the domain that shipped.
    expect(await store.ingest(FLIPPED, sighting(await signOn(FLIPPED, terms({ nonce: 7n }))))).toBe(
      true,
    )
    expect(await store.ingest(FLIPPED, sighting(before))).toBe(false)

    // Testnet still holds exactly its own one row.
    expect((await store.query({ chainId: TESTNET })).rows).toHaveLength(1)
  })
})

// ── State a flip makes a chain question ───────────────────────────────────────

/**
 * Two things this package remembers were filed under no chain at all, and a flip is exactly the
 * event that makes an un-keyed store matter. The keepalive list is keyed by chain now, and the
 * first test holds it there. The token cache is still keyed by address alone, and the second says
 * what keeps that safe. Both are recorded here rather than left to be rediscovered: a test that
 * only reads the registry would never see either.
 */
describe('state a flip makes a chain question', () => {
  /**
   * **The keepalive list answers for one chain, and the flip is what made that matter.**
   *
   * `remember` files a payload under `provecash.mine.<chainId>` and `myIntents` reads one chain's
   * key. It used to be a single array under one un-keyed key: every caller got both chains' rows,
   * and `App.tsx` hands that list to `keepAlive`, which re-posts every entry the CURRENT board
   * does not carry.
   *
   * Nothing on 369 could reach the list while mainnet settled nowhere, because `signingDomain`
   * throws there and a maker could not make the signature `remember` files. The flip removes that
   * guard, which is why this runs with 369 turned on: a maker who signs on mainnet and then
   * switches to testnet must not get a tab that grinds proof of work to post mainnet payloads to
   * the testnet board.
   *
   * The chain is in the storage key rather than in a field on each row, so a caller that forgets
   * to filter still cannot read another chain's payload. `intentKey` is unchanged: it identifies
   * a signature, and a signature verifies on one chain only.
   */
  test('the keepalive list answers for one chain at a time', async () => {
    flipOn()
    const onTestnet = encodeIntent(await signOn(TESTNET, terms({ nonce: 7n })))
    const onMainnet = encodeIntent(await signOn(FLIPPED, terms({ nonce: 8n })))
    remember(TESTNET, onTestnet)
    remember(FLIPPED, onMainnet)

    // Each chain keeps its own payload, and neither list can see the other's.
    expect(myIntents(TESTNET).map((k) => k.data)).toEqual([onTestnet])
    expect(myIntents(FLIPPED).map((k) => k.data)).toEqual([onMainnet])

    // Two keys, so the separation holds in storage and not only in a filter.
    expect(kv().getItem(`provecash.mine.${TESTNET}`)).toContain(onTestnet)
    expect(kv().getItem(`provecash.mine.${TESTNET}`)).not.toContain(onMainnet)
    expect(kv().getItem(`provecash.mine.${FLIPPED}`)).toContain(onMainnet)
    expect(kv().getItem('provecash.mine')).toBeNull()
  })

  /**
   * **The token cache is keyed by chain and address, and each chain is seeded from its own
   * registry entry.** HEX sits at the same address on 369 and on 943. Those two entries used to
   * meet in one cache slot keyed by address alone, which was safe only while they agreed about
   * the token and nothing held them to it.
   *
   * The flip is what makes the slot reachable twice in one session: it gives a reader a network
   * to switch to, and what they would carry across is `decimals`. `tokens.ts` says what a wrong
   * decimal place does to an offer.
   *
   * The answer now follows the argument rather than the selection, which is the whole change —
   * `setChainId` moves what the app is looking at and moves nothing about what the cache says.
   */
  test('one address is one entry per chain, and the selection does not decide it', () => {
    const shared = NETWORKS[FLIPPED].tokens.filter((t) =>
      NETWORKS[TESTNET].tokens.some((u) => u.address.toLowerCase() === t.address.toLowerCase()),
    )
    expect(shared.length).toBeGreaterThan(0)

    for (const t of shared) {
      // Each chain answers with its own registry entry for the shared address, not with one
      // seeded blob that happens to hold whichever chain was read first.
      const mine = NETWORKS[TESTNET].tokens.find(
        (u) => u.address.toLowerCase() === t.address.toLowerCase(),
      )!
      expect(cachedToken(TESTNET, t.address)).toEqual(mine)
      expect(cachedToken(FLIPPED, t.address)).toEqual(t)
    }

    // A token only testnet ships with is unknown on mainnet, before the flip and after.
    const onlyTestnet = NETWORKS[TESTNET].tokens.find(
      (t) => !NETWORKS[FLIPPED].tokens.some((u) => u.address.toLowerCase() === t.address.toLowerCase()),
    )!
    expect(cachedToken(FLIPPED, onlyTestnet.address)).toBeUndefined()

    // And the selection is not what the cache reads. It answered by chain before this line.
    setChainId(TESTNET)
    const asked = cachedToken(FLIPPED, shared[0].address)
    flipOn()
    setChainId(FLIPPED)
    expect(cachedToken(FLIPPED, shared[0].address)).toEqual(asked)
    expect(cachedToken(TESTNET, onlyTestnet.address)).toEqual(onlyTestnet)
  })
})

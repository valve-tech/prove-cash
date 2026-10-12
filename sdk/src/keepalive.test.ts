import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Address, Hex } from 'viem'
import { DEFAULT_CHAIN, setChainId, type ChainId } from './config.js'
import { CURVE_LINEAR, ZERO, ZERO_HASH, encodeIntent, intentKey, type SignedIntent } from './intent.js'
import { forget, keepAlive, myIntents, remember, type Kept } from './keepalive.js'
import { kv, memoryKeyValueStore, setKeyValueStore } from './kv.js'

/**
 * The list a tab re-posts from, and the one thing it has to get right: which chain a payload
 * belongs to.
 *
 * A signature is bound to one domain, so a mainnet payload posted at the testnet board is a
 * grind spent on a row that board will never accept. `mainnetFlip.test.ts` states why the
 * mainnet flip is what makes this reachable; this file holds the storage itself, including the
 * rows an older build left behind under a key that named no chain.
 */

const TESTNET: ChainId = 943
const MAINNET: ChainId = 369

/** Where the whole list lived before it was keyed by chain. */
const LEGACY_STORE = 'provecash.mine'
const storeKey = (chainId: ChainId) => `provecash.mine.${chainId}`

const maker: Address = '0x00000000000000000000000000000000000000a1'
const token: Address = '0x00000000000000000000000000000000000000b2'

/**
 * A payload, without signing one.
 *
 * `remember` decodes the payload and files it; it never verifies the signature, and neither does
 * anything else here. So the signature only has to be distinct per intent, because `intentKey`
 * reads its first bytes.
 */
function payload(n: number, endTime = 4_000_000_000n): { data: Hex; key: string } {
  const intent: SignedIntent = {
    maker,
    recipient: maker,
    tokenIn: token,
    tokenOut: token,
    amountIn: 1_000n,
    minOutStart: 900n,
    minOutEnd: 900n,
    startTime: 1_700_000_000n,
    endTime,
    executor: ZERO,
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: 0,
    nonce: BigInt(n),
    curve: CURVE_LINEAR,
    signature: `0x${n.toString(16).padStart(2, '0').repeat(65)}` as Hex,
  }
  return { data: encodeIntent(intent), key: intentKey(intent) }
}

/** The rows under one chain's key, as they are stored rather than as `myIntents` filters them. */
function stored(chainId: ChainId): Kept[] {
  return JSON.parse(kv().getItem(storeKey(chainId)) || '[]') as Kept[]
}

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  setChainId(TESTNET)
})

afterEach(() => {
  setChainId(DEFAULT_CHAIN)
  setKeyValueStore(null)
})

describe('one list per chain', () => {
  test('a payload remembered on one chain is invisible on the other', () => {
    const testnet = payload(1)
    const mainnet = payload(2)
    remember(TESTNET, testnet.data)
    remember(MAINNET, mainnet.data)

    expect(myIntents(TESTNET).map((k) => k.key)).toEqual([testnet.key])
    expect(myIntents(MAINNET).map((k) => k.key)).toEqual([mainnet.key])
  })

  test('the chain is in the storage key, not in a field on the row', () => {
    const testnet = payload(3)
    remember(TESTNET, testnet.data)

    // Separated by where they are stored, so a caller that forgets to filter cannot mix them.
    expect(kv().getItem(storeKey(TESTNET))).toContain(testnet.data)
    expect(kv().getItem(storeKey(MAINNET))).toBeNull()
    // The row itself is unchanged: `intentKey` still identifies a signature and nothing more.
    expect(Object.keys(stored(TESTNET)[0]).sort()).toEqual(['data', 'endTime', 'key'])
  })

  test('re-remembering one payload replaces its row rather than adding a second', () => {
    const one = payload(4)
    remember(TESTNET, one.data)
    remember(TESTNET, one.data)
    expect(myIntents(TESTNET)).toHaveLength(1)
  })

  test('an expired payload is not handed back', () => {
    const live = payload(5)
    const dead = payload(6, 1_700_000_100n)
    remember(TESTNET, live.data)
    remember(TESTNET, dead.data)
    expect(myIntents(TESTNET).map((k) => k.key)).toEqual([live.key])
  })

  test('forget drops one row from one chain and leaves the other chain alone', () => {
    const testnet = payload(7)
    const mainnet = payload(8)
    remember(TESTNET, testnet.data)
    remember(MAINNET, mainnet.data)

    forget(TESTNET, testnet.key)
    expect(myIntents(TESTNET)).toHaveLength(0)
    expect(myIntents(MAINNET).map((k) => k.key)).toEqual([mainnet.key])
  })

  test('a corrupt list on one chain costs that chain only', () => {
    const mainnet = payload(9)
    remember(MAINNET, mainnet.data)
    kv().setItem(storeKey(TESTNET), 'not json')

    expect(myIntents(TESTNET)).toEqual([])
    expect(myIntents(MAINNET).map((k) => k.key)).toEqual([mainnet.key])
  })
})

/**
 * Rows already in a real person's browser carry no chain, because the build that wrote them kept
 * one un-keyed list. They are moved to `DEFAULT_CHAIN` on the first read after the upgrade.
 *
 * That is a derivation, not a guess: every build that wrote this key refused to sign anywhere but
 * 943, because mainnet settled nowhere and `signingDomain` throws there. Dropping the rows was
 * the alternative, and it is the worst one — they are a maker's live offers, and forgetting them
 * silently takes those offers off the board within about 120 blocks with nothing said.
 */
describe('rows an older build left behind', () => {
  test('they move to the default chain and the old key goes', () => {
    const one = payload(10)
    const two = payload(11)
    kv().setItem(LEGACY_STORE, JSON.stringify([one, two].map(({ data, key }) => ({ data, endTime: '4000000000', key }))))

    expect(myIntents(DEFAULT_CHAIN).map((k) => k.key)).toEqual([one.key, two.key])
    expect(kv().getItem(LEGACY_STORE)).toBeNull()
    expect(stored(DEFAULT_CHAIN)).toHaveLength(2)
  })

  test('no other chain inherits them', () => {
    const one = payload(12)
    kv().setItem(LEGACY_STORE, JSON.stringify([{ data: one.data, endTime: '4000000000', key: one.key }]))

    // Read for mainnet first, so the migration runs on a call that is not the destination's.
    expect(myIntents(MAINNET)).toEqual([])
    expect(myIntents(DEFAULT_CHAIN).map((k) => k.key)).toEqual([one.key])
  })

  test('they merge with rows this build already wrote, and a repeat key stays one row', () => {
    const fresh = payload(13)
    const old = payload(14)
    remember(DEFAULT_CHAIN, fresh.data)
    kv().setItem(
      LEGACY_STORE,
      JSON.stringify(
        [fresh, old].map(({ data, key }) => ({ data, endTime: '4000000000', key })),
      ),
    )

    expect(myIntents(DEFAULT_CHAIN).map((k) => k.key)).toEqual([fresh.key, old.key])
  })

  test('the move happens once', () => {
    const one = payload(15)
    kv().setItem(LEGACY_STORE, JSON.stringify([{ data: one.data, endTime: '4000000000', key: one.key }]))

    expect(myIntents(DEFAULT_CHAIN)).toHaveLength(1)
    // A second read finds no old key, so it cannot file the same row again.
    expect(myIntents(DEFAULT_CHAIN)).toHaveLength(1)
    forget(DEFAULT_CHAIN, one.key)
    expect(myIntents(DEFAULT_CHAIN)).toHaveLength(0)
  })

  test('a corrupt old list is read once and dropped', () => {
    kv().setItem(LEGACY_STORE, '{ not json')
    expect(myIntents(DEFAULT_CHAIN)).toEqual([])
    expect(kv().getItem(LEGACY_STORE)).toBeNull()
  })

  test('a row without a key is not carried over', () => {
    kv().setItem(LEGACY_STORE, JSON.stringify([{ data: '0x00', endTime: '4000000000' }]))
    expect(myIntents(DEFAULT_CHAIN)).toEqual([])
  })
})

describe('the re-posting pass', () => {
  test('it posts the payloads of one chain and of no other', async () => {
    const testnet = payload(16)
    const mainnet = payload(17)
    remember(TESTNET, testnet.data)
    remember(MAINNET, mainnet.data)

    const posted: Hex[] = []
    await keepAlive(TESTNET, new Set(), async (data) => void posted.push(data))
    expect(posted).toEqual([testnet.data])
  })

  test('it leaves alone what the board already carries', async () => {
    const onBoard = payload(18)
    const rolledOff = payload(19)
    remember(TESTNET, onBoard.data)
    remember(TESTNET, rolledOff.data)

    const posted: Hex[] = []
    await keepAlive(TESTNET, new Set([onBoard.key]), async (data) => void posted.push(data))
    expect(posted).toEqual([rolledOff.data])
  })

  test('it stops when the process moves to another chain mid-pass', async () => {
    remember(TESTNET, payload(20).data)
    remember(TESTNET, payload(21).data)

    // A grind takes seconds, and `post` sends to whichever chain the process points at now. A
    // reader who switches network during a pass must not have the rest of this chain's payloads
    // posted at the other chain's board.
    const posted: Hex[] = []
    await keepAlive(TESTNET, new Set(), async (data) => {
      posted.push(data)
      setChainId(MAINNET)
    })
    expect(posted).toHaveLength(1)
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import {
  DEFAULT_CHAIN,
  NETWORKS,
  memoryKeyValueStore,
  setChainId,
  setKeyValueStore,
  setSettlementOverride,
  settlement,
  type ChainId,
  type ReadOptions,
} from '@prove.cash/sdk'
import { boardOff, boardQuery, settlementPresence } from './hooks/useBoard'
import { rfqVenue } from './rfq/venue'
import { readParkedTokens } from './lib/settlement'
import { chainHealth, readExhausted, resetChainHealth } from './lib/chainHealth'

/**
 * Turning mainnet on must change nothing a testnet reader sees.
 *
 * `sdk/src/mainnetFlip.test.ts` holds the registry, the domain and the book. This is the app's
 * half: the board, the exclusive-quote venue and the reads a tab makes about a maker's own
 * money. Each of these resolves through `settlement()`, so each of them is a place the flip
 * could reach if it were not kept to one chain.
 *
 * The flip is an override, for `boardOff.test.ts`'s reason: a test that reads the registry stops
 * testing anything the morning mainnet deploys.
 */

/** What #35 puts in the registry for 369. */
const MAINNET: Address = '0x000000000000000000000000000000000000369a'

/** The chain the flip turns on. */
const FLIPPED: ChainId = 369
/** The chain that must not notice. */
const TESTNET: ChainId = 943

const MAKER: Address = '0x1111111111111111111111111111111111111111'
const TOKEN: Address = '0x2222222222222222222222222222222222222222'

/** Turn mainnet on, exactly as the registry entry will. */
const flipOn = () => setSettlementOverride(FLIPPED, MAINNET)
/** Turn it off by override, not by the registry's zero: after #52 the registry names one. */
const flipOff = () => setSettlementOverride(FLIPPED, '0x0000000000000000000000000000000000000000')

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  flipOff()
  setSettlementOverride(TESTNET, null)
  setChainId(TESTNET)
  resetChainHealth()
})

afterEach(() => {
  setSettlementOverride(FLIPPED, null)
  setSettlementOverride(TESTNET, null)
  setChainId(DEFAULT_CHAIN)
  resetChainHealth()
})

describe('the flip', () => {
  test('mainnet goes from closed to open', () => {
    // The control the rest of this file rests on. A flip that did nothing would make every
    // comparison below pass for the wrong reason.
    expect(boardOff(FLIPPED)).toBe(true)
    expect(settlementPresence(FLIPPED)).toBeNull()
    flipOn()
    expect(boardOff(FLIPPED)).toBe(false)
    expect(settlementPresence(FLIPPED)).toBe(MAINNET)
  })
})

describe('the testnet board', () => {
  test('it keeps its settlement, and keeps trading', () => {
    const before = settlementPresence(TESTNET)
    expect(boardOff(TESTNET)).toBe(false)
    flipOn()
    expect(settlementPresence(TESTNET)).toBe(before)
    expect(settlementPresence(TESTNET)).toBe(NETWORKS[TESTNET].settlement)
    expect(boardOff(TESTNET)).toBe(false)
    // The two chains do not converge on one contract.
    expect(settlementPresence(TESTNET)).not.toBe(MAINNET)
  })

  test('the question it asks the store still names its own chain', () => {
    const now = 1_800_000_000
    for (const scope of ['open', 'all'] as const) {
      const before = boardQuery(TESTNET, scope, null, now)
      flipOn()
      const after = boardQuery(TESTNET, scope, null, now)
      expect(after).toEqual(before)
      expect(after.chainId).toBe(TESTNET)
      flipOff()
    }
  })
})

/**
 * The exclusive-quote venue is the app's own table, and it is the one surface the flip changes
 * on purpose.
 *
 * `app/src/rfq/venue.ts` already carries a 369 address out of `contracts/deployments/369.json`.
 * `rfqVenue` answers null there today only because `settlementLive(369)` is false, so the flip
 * makes that address reachable for the first time. That is intended — and it is exactly the
 * shape of change that could carry into the other chain, so it is asserted in both directions.
 */
describe('the exclusive-quote venue', () => {
  test('testnet keeps its own venue', () => {
    const before = rfqVenue(TESTNET)
    expect(before).toMatch(/^0x[0-9a-fA-F]{40}$/)
    flipOn()
    expect(rfqVenue(TESTNET)).toBe(before)
  })

  test('mainnet gains its own, and it is not the testnet one', () => {
    expect(rfqVenue(FLIPPED)).toBeNull()
    flipOn()
    const mainnet = rfqVenue(FLIPPED)
    expect(mainnet).toMatch(/^0x[0-9a-fA-F]{40}$/)
    // A quote binds to the venue's settlement. One address serving both chains would hash a
    // testnet quote under a mainnet contract and revert with `BindingIsForAnotherIntent`.
    expect(mainnet).not.toBe(rfqVenue(TESTNET))
  })
})

/** A client that answers `readParkedTokens` and remembers which contract it was asked about. */
function fakeClient(tokens: readonly Address[]) {
  const addresses: Address[] = []
  const client = {
    getBlockNumber: async () => 1_000_000n,
    getLogs: async (query: { address: Address }) => {
      addresses.push(query.address)
      return tokens.map((token) => ({ args: { token } }))
    },
  } as unknown as ReadOptions['client']
  return { client, addresses }
}

describe('what a testnet tab reads about a maker', () => {
  test('the parked-token log query asks the testnet settlement', async () => {
    // The Mine tab draws a maker's resting capital from this. Pointed at the wrong contract it
    // would report the wrong money, and the maker has no way to tell.
    flipOn()
    const { client, addresses } = fakeClient([TOKEN])
    expect(await readParkedTokens(MAKER, { chainId: TESTNET, client })).toEqual([TOKEN])
    expect(addresses).toEqual([settlement(TESTNET)])
    expect(addresses[0]).not.toBe(MAINNET)
  })

  test('the same read on mainnet goes to the mainnet settlement', async () => {
    // Before the flip this chain is not asked at all; after it, it is asked at its own address.
    const { client, addresses } = fakeClient([TOKEN])
    expect(await readParkedTokens(MAKER, { chainId: FLIPPED, client })).toBeNull()
    expect(addresses).toEqual([])

    flipOn()
    expect(await readParkedTokens(MAKER, { chainId: FLIPPED, client })).toEqual([TOKEN])
    expect(addresses).toEqual([MAINNET])
  })
})

/**
 * **Endpoint health is one flag per chain.**
 *
 * `lib/chainHealth.ts` kept a single module-level `state`. The board's reads write to it on every
 * poll and the header draws amber from it, so a throttled endpoint on one network reported a
 * degraded endpoint on the other — a claim about a node nobody had asked anything.
 *
 * The flip did not create that and did not make it worse: the app reads one chain at a time. It
 * was recorded because a screen showing two chains at once would inherit it with nothing said,
 * and the flip is what makes such a screen worth building. The verdict now names its chain, so
 * the reading no longer depends on only ever looking at one.
 */
describe('endpoint health is kept per chain', () => {
  test('a failed read on one chain is not a verdict on the other', () => {
    flipOn()
    readExhausted(TESTNET)
    expect(chainHealth(TESTNET)).toBe('degraded')
    expect(chainHealth(FLIPPED)).toBe('ok')

    // Nor does the selection decide it. A verdict is about an endpoint, not about what is on
    // screen, so switching the app over reports the chain switched to.
    setChainId(FLIPPED)
    expect(chainHealth(FLIPPED)).toBe('ok')
    expect(chainHealth(TESTNET)).toBe('degraded')
  })
})

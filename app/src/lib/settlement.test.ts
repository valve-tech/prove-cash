import { afterEach, describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import { getChainId, setChainId, setSettlementOverride, type ReadOptions } from '@prove.cash/sdk'
import { readFloor, readParkedTokens } from './settlement.ts'

/**
 * The two reads the Mine tab makes about a maker rather than about one offer.
 *
 * Everything else in `lib/settlement.ts` opens a browser wallet, so it is a wrapper and nothing
 * more. These two are not: one asks the chain's logs which tokens a maker ever parked, and the
 * other reads the floor a bulk off switch has to clear. Both decide what a maker is shown about
 * their own money, and both have a failure answer that must not read as an empty answer.
 *
 * The client is injected, so no test here touches the network.
 */

const MAKER = '0x3333333333333333333333333333333333333333' as Address
const USDC = '0x1111111111111111111111111111111111111111' as Address
const WPLS = '0x2222222222222222222222222222222222222222' as Address

/** A live chain, and the chain each test switches off by override. */
const LIVE = 943
const DEAD = 369

type LogCall = { fromBlock: bigint; toBlock: bigint; args: { maker: Address } }

/** A public client that answers the two calls `readParkedTokens` makes, and records the query. */
function fakeClient(head: bigint, tokens: readonly Address[]) {
  const calls: LogCall[] = []
  const client = {
    getBlockNumber: async () => head,
    getLogs: async (query: LogCall) => {
      calls.push(query)
      return tokens.map((token) => ({ args: { token } }))
    },
  } as unknown as ReadOptions['client']
  return { client, calls }
}

const started = getChainId()
afterEach(() => setChainId(started))

describe('which tokens the chain says parked for this maker', () => {
  test('every token a Parked log names comes back', async () => {
    const { client } = fakeClient(1_000_000n, [USDC, WPLS])
    expect(await readParkedTokens(MAKER, { chainId: LIVE, client })).toEqual([USDC, WPLS])
  })

  test('the query asks for this maker and nobody else', async () => {
    // `Parked` indexes the maker, which is the whole reason this read needs no record store.
    const { client, calls } = fakeClient(1_000_000n, [])
    await readParkedTokens(MAKER, { chainId: LIVE, client })
    expect(calls[0]?.args).toEqual({ maker: MAKER })
  })

  test('the window is fifty thousand blocks back from the head', async () => {
    // Measured against the app's default endpoint: it refuses 99,999 blocks and answers 75,000.
    const { client, calls } = fakeClient(1_000_000n, [])
    await readParkedTokens(MAKER, { chainId: LIVE, client })
    expect(calls[0]?.fromBlock).toBe(950_000n)
    expect(calls[0]?.toBlock).toBe(1_000_000n)
  })

  test('a chain younger than the window is read from its first block', async () => {
    // A fresh devnet. `fromBlock` below zero is not a block, and viem sends the number it is
    // given, so the clamp is here rather than at the endpoint's error message.
    const { client, calls } = fakeClient(12n, [])
    await readParkedTokens(MAKER, { chainId: LIVE, client })
    expect(calls[0]?.fromBlock).toBe(0n)
  })

  test('no parked log is an empty answer, which is a real answer', async () => {
    const { client } = fakeClient(1_000_000n, [])
    expect(await readParkedTokens(MAKER, { chainId: LIVE, client })).toEqual([])
  })

  test('a read that throws answers null, so no row the maker can see is deleted', async () => {
    // The rule the whole parked surface keeps: a bad minute on an endpoint must never render as
    // "your money left". Null adds nothing to the token set and subtracts nothing from it.
    const client = {
      getBlockNumber: async () => {
        throw new Error('endpoint refused the range')
      },
    } as unknown as ReadOptions['client']
    expect(await readParkedTokens(MAKER, { chainId: LIVE, client })).toBeNull()
  })

  test('a chain with no settlement is asked nothing at all', async () => {
    const { client, calls } = fakeClient(1_000_000n, [USDC])
    // Off by override, not by the registry's zero: after #52 the registry names a settlement.
    setSettlementOverride(DEAD, '0x0000000000000000000000000000000000000000')
    try {
      expect(await readParkedTokens(MAKER, { chainId: DEAD, client })).toBeNull()
      expect(calls).toEqual([])
    } finally {
      setSettlementOverride(DEAD, null)
    }
  })
})

describe('the floor a bulk off switch has to clear', () => {
  test('a chain with no settlement answers null, not zero', async () => {
    // Zero is a real floor and means "this maker has never retired anything". A button built on
    // a number nobody read would send a floor the contract refuses.
    // Off by override, as above: the registry names a settlement on both chains since #52.
    setChainId(DEAD)
    setSettlementOverride(DEAD, '0x0000000000000000000000000000000000000000')
    try {
      expect(await readFloor(MAKER)).toBeNull()
    } finally {
      setSettlementOverride(DEAD, null)
    }
  })
})

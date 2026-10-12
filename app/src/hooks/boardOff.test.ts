import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import {
  DEFAULT_CHAIN,
  memoryKeyValueStore,
  setChainId,
  setKeyValueStore,
  setSettlementOverride,
  type ChainId,
} from '@prove.cash/sdk'
import { boardOff, settlementPresence } from './useBoard'

/**
 * The board refuses to trade on a chain that settles nowhere.
 *
 * The sign form has refused since #119: `signingDomain` throws, the custody ladder locks every
 * rung, and `signGate.test.ts` holds all three. The board did not. It listed the archive of a
 * chain with no settlement like any other book — rows a reader could select, a tray they could
 * batch, and a fill behind it — and every one of those offers is bound to a `verifyingContract`
 * of `0x0000…0000`. Refusing to SIGN one and then offering it to somebody else to TAKE is the
 * same defect from the other end.
 *
 * An override rather than the registry's own zero for 369, for `signGate.test.ts`'s reason: a
 * test that reads the registry stops testing anything the morning mainnet deploys.
 */

const NONE: Address = '0x0000000000000000000000000000000000000000'
const FORK: Address = '0x00000000000000000000000000000000000f0f0f'

/** A registered chain, held to "no settlement" by an override. */
const DEAD: ChainId = 369
/** The other registered chain, which the registry does give a settlement. */
const LIVE: ChainId = 943

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  setSettlementOverride(DEAD, NONE)
})

afterEach(() => {
  setSettlementOverride(DEAD, null)
  setSettlementOverride(LIVE, null)
  setChainId(DEFAULT_CHAIN)
})

describe('where a chain settles', () => {
  test('a chain with no settlement answers null, which is an answer', () => {
    expect(settlementPresence(DEAD)).toBeNull()
  })

  test('a chain with one answers the address', () => {
    expect(settlementPresence(LIVE)).not.toBeNull()
  })

  test('it reads the resolver, so an override decides', () => {
    // The whole reason this goes through `settlement()` and not `NETWORKS[id].settlement`: a
    // client pointed at a local Anvil settles fine, and a board closed against it would be wrong.
    setSettlementOverride(DEAD, FORK)
    expect(settlementPresence(DEAD)).toBe(FORK)

    // And the other direction, so the answer cannot be a constant that happens to read correctly.
    setSettlementOverride(LIVE, NONE)
    expect(settlementPresence(LIVE)).toBeNull()
  })
})

describe('whether the board trades', () => {
  test('it is off where nothing can settle', () => {
    expect(boardOff(DEAD)).toBe(true)
  })

  test('it is on where something can', () => {
    expect(boardOff(LIVE)).toBe(false)
  })

  test('a deployed settlement opens it again', () => {
    setSettlementOverride(DEAD, FORK)
    expect(boardOff(DEAD)).toBe(false)
  })

  test('and an override to zero closes the chain that has one', () => {
    setSettlementOverride(LIVE, NONE)
    expect(boardOff(LIVE)).toBe(true)
  })
})

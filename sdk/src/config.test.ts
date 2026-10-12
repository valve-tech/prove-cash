import { beforeEach, describe, expect, test } from 'vitest'
import { getAddress, type Address } from 'viem'
import {
  DEFAULT_CHAIN,
  NETWORKS,
  defaultRpc,
  getChainRpc,
  getRpc,
  isSupportedChain,
  setRpc,
  setRpcLinked,
  CHAIN_IDS,
  feeTarget,
  feeTargetName,
  readerAddress,
  setReaderOverride,
  setSettlementOverride,
  setXykVenuesOverride,
  settlement,
  settlementLive,
  xykLive,
  xykRouter,
  xykVenue,
  xykVenues,
  type XykVenue,
} from './config.js'
import { domain } from './intent.js'
import { kv, memoryKeyValueStore, setKeyValueStore } from './kv.js'

/**
 * The settlement override is load-bearing: it is how a devnet run points signing, verifying and
 * filling at a contract the registry has never heard of. A helper that reads the registry
 * instead of `settlement()` signs against one address and checks against another, and nothing
 * else would notice. These tests hold every reader to the resolver.
 */

/** A settlement address the registry never holds, so an override is visible whatever it holds. */
const FORK: Address = '0x00000000000000000000000000000000000f0f0f'

/**
 * Not deployed, as an override rather than as a registry accident.
 *
 * These tests are about the resolver, not about which chains have shipped a contract. Overriding
 * a chain to zero gives a "no settlement" fixture that survives mainnet's deploy; asserting that
 * 369 reads zero from the registry does not.
 */
const NONE: Address = '0x0000000000000000000000000000000000000000'

/**
 * A market the registry has never heard of, which is what a lab chain is.
 *
 * `app/scripts/lab/up.sh` deploys a factory, a router and three pairs on an anvil, and the
 * registry's 943 entry names PulseX's testnet addresses — neither of which has any code there.
 * Every quote went to an address with no code and came back as "no pool".
 */
const LAB: XykVenue = {
  label: 'lab',
  router: '0x0000000000000000000000000000000000000ab0',
  factory: '0x000000000000000000000000000000000000fac7',
  // These pairs take no swap fee, and the venue has to be registered at the fee it charges.
  feeNum: 10_000n,
  feeDen: 10_000n,
}

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  setSettlementOverride(369, null)
  setXykVenuesOverride(943, null)
  setReaderOverride(943, null)
})

describe('the settlement resolver', () => {
  test('answers the registry when nothing is overridden', () => {
    expect(settlement(369)).toBe(NETWORKS[369].settlement)
    expect(settlement(943)).toBe(NETWORKS[943].settlement)
  })

  test('an override moves every reader, not just the direct one', () => {
    setSettlementOverride(369, FORK)
    expect(settlement(369)).toBe(FORK)
    // The two readers that would otherwise reach past the resolver.
    expect(settlementLive(369)).toBe(true)
    expect(domain(369).verifyingContract).toBe(FORK)

    // And the other way. An override of zero is the only way to hold `settlementLive` to the
    // resolver: a reader that consults the registry keeps saying true here once 369 deploys.
    setSettlementOverride(369, NONE)
    expect(settlement(369)).toBe(NONE)
    expect(settlementLive(369)).toBe(false)
    expect(domain(369).verifyingContract).toBe(NONE)
  })

  test('clearing an override gives the registry back', () => {
    setSettlementOverride(369, FORK)
    setSettlementOverride(369, null)
    expect(settlement(369)).toBe(NETWORKS[369].settlement)
    // The derived reader comes back too, not only the direct one.
    expect(domain(369).verifyingContract).toBe(NETWORKS[369].settlement)
  })

  test('an override on one chain leaves the other alone', () => {
    setSettlementOverride(369, FORK)
    expect(settlement(943)).toBe(NETWORKS[943].settlement)
  })
})

describe('the reader resolver', () => {
  test('answers the registry, and null where the registry names no reader', () => {
    const want = NETWORKS[943].reader
    expect(readerAddress(943)).toBe(want === NONE ? null : want)
  })

  test('an override wins, stays on its chain, and clears back to the registry', () => {
    // A lab deploys its own reader beside its own settlement; `loadBook` reads `available` there.
    setReaderOverride(943, FORK)
    expect(readerAddress(943)).toBe(FORK)
    expect(readerAddress(369)).toBe(NETWORKS[369].reader === NONE ? null : NETWORKS[369].reader)
    setReaderOverride(943, null)
    expect(readerAddress(943)).toBe(NETWORKS[943].reader === NONE ? null : NETWORKS[943].reader)
  })

  test('an override of zero is no override', () => {
    setReaderOverride(943, NONE)
    expect(readerAddress(943)).toBe(NETWORKS[943].reader === NONE ? null : NETWORKS[943].reader)
  })
})

/**
 * The venue override is load-bearing for the same reason the settlement one is: it is how a lab
 * run points quoting, pool discovery and routing at a market the registry has never heard of.
 * A helper that reads `NETWORKS[id].xyk` instead of `xykVenues()` sends every read to an address
 * with no code and reports "this chain has no market", which is a claim about the world made on
 * the strength of a lookup. These tests hold every reader to the resolver.
 */
describe('the venue resolver', () => {
  test('answers the registry when nothing is overridden', () => {
    expect(xykVenues(943)).toBe(NETWORKS[943].xyk)
    expect(xykRouter(943)).toBe(NETWORKS[943].xyk[0].router)
  })

  test('an override moves every reader, not just the direct one', () => {
    setXykVenuesOverride(943, [LAB])
    expect(xykVenues(943)).toEqual([LAB])
    // The three readers that would otherwise reach past the resolver.
    expect(xykRouter(943)).toBe(LAB.router)
    expect(xykVenue('lab', 943)).toEqual(LAB)
    expect(xykLive(943)).toBe(true)
    // And the registry's own venue is gone, rather than the lab being appended to it.
    expect(xykVenue('v1', 943)).toBeUndefined()
  })

  /**
   * An empty list is an override and not a clear, because a fork can genuinely have no market.
   * `xykLive` is the reader that only tells the two apart if it goes through the resolver.
   */
  test('a chain can be overridden to no market at all', () => {
    setXykVenuesOverride(943, [])
    expect(xykVenues(943)).toEqual([])
    expect(xykLive(943)).toBe(false)
    expect(xykRouter(943)).toBe(NONE)
  })

  test('clearing an override gives the registry back', () => {
    setXykVenuesOverride(943, [LAB])
    setXykVenuesOverride(943, null)
    expect(xykVenues(943)).toBe(NETWORKS[943].xyk)
    expect(xykLive(943)).toBe(true)
  })

  test('an override on one chain leaves the other alone', () => {
    setXykVenuesOverride(943, [LAB])
    expect(xykVenues(369)).toBe(NETWORKS[369].xyk)
  })

  /**
   * A browser sets the key and reloads, so the stored form has to survive a round trip on its
   * own — the in-process map is empty in that process. The fee is a pair of bigints and
   * `JSON.stringify` throws on one rather than dropping it, so this is the check that the
   * serializer is doing its job.
   */
  test('a stored override is read back with its fee intact', () => {
    // What the previous process wrote, and nothing in this one's memory. `setXykVenuesOverride`
    // writes exactly these bytes; asserting against the literal is what makes the round trip a
    // check rather than the serializer agreeing with itself.
    kv().setItem('provecash.xyk.943', JSON.stringify([{ ...LAB, feeNum: '10000', feeDen: '10000' }]))
    expect(xykVenues(943)).toEqual([LAB])
    expect(typeof xykVenues(943)[0].feeNum).toBe('bigint')
  })

  test('and what the setter writes is what the reader expects', () => {
    setXykVenuesOverride(943, [LAB])
    const written = kv().getItem('provecash.xyk.943')
    setXykVenuesOverride(943, null)
    kv().setItem('provecash.xyk.943', written!)
    expect(xykVenues(943)).toEqual([LAB])
  })

  /** A stored value nobody can parse is not a market. The registry is the only safe reading. */
  test('an unreadable stored override falls back to the registry', () => {
    kv().setItem('provecash.xyk.943', 'not json')
    expect(xykVenues(943)).toBe(NETWORKS[943].xyk)
  })
})

describe('the registry', () => {
  test('knows its own chains and nothing else', () => {
    expect(isSupportedChain(369)).toBe(true)
    expect(isSupportedChain(943)).toBe(true)
    expect(isSupportedChain(1)).toBe(false)
    expect(isSupportedChain(DEFAULT_CHAIN)).toBe(true)
  })

  /**
   * A fresh visitor must not open on a chain with no settlement contract. When that was mainnet,
   * seven signed offers went to the public archive against the zero address, and nothing could
   * ever fill them. Deploying on 369 does not lift this — moving the default there is a decision,
   * so make it fail here first.
   */
  test('a fresh install starts on a chain that can settle', () => {
    expect(settlementLive(DEFAULT_CHAIN)).toBe(true)
    expect(NETWORKS[DEFAULT_CHAIN].settlement).not.toBe(NONE)
  })

  /**
   * The fee destination is offered to a maker as a named choice, so the name has to be there and
   * has to be a name. `market.live.test.ts` holds the address itself to the factory's own
   * `feeTo()`; this holds the pair together, which is the part a form depends on.
   */
  test.each(CHAIN_IDS)('chain %i names a fee destination, and names it in words', (id) => {
    expect(feeTarget(id)).toBe(NETWORKS[id].feeTo)
    expect(feeTarget(id)).toMatch(/^0x[0-9a-fA-F]{40}$/)
    expect(feeTargetName(id).trim()).toBeTruthy()
    expect(feeTargetName(id)).not.toMatch(/^0x/)
  })
})

describe('endpoint resolution', () => {
  test('both endpoints default to the registry URL', () => {
    expect(getRpc(943)).toBe(defaultRpc(943))
    expect(getChainRpc(943)).toBe(defaultRpc(943))
  })

  test('the chain endpoint follows the board endpoint while they are locked', () => {
    setRpc('https://board.example/943', 943, 'board')
    expect(getChainRpc(943)).toBe('https://board.example/943')
  })

  test('unlocked, each endpoint keeps its own URL', () => {
    setRpcLinked(false, 943)
    setRpc('https://board.example/943', 943, 'board')
    setRpc('https://chain.example/943', 943, 'chain')
    expect(getRpc(943)).toBe('https://board.example/943')
    expect(getChainRpc(943)).toBe('https://chain.example/943')
  })

  test('setting an endpoint back to the default clears the override', () => {
    setRpc('https://board.example/943', 943, 'board')
    setRpc(defaultRpc(943), 943, 'board')
    expect(getRpc(943)).toBe(defaultRpc(943))
  })
})

/**
 * Every address in the registry is EIP-55 checksummed.
 *
 * Not cosmetic. `app/scripts/e2e/common.ts` splices the settlement address straight into the
 * source of a Solidity helper it compiles on the fly, and solc refuses a literal that fails the
 * checksum — error 9429, reported as a Buffer dump from a child process, which names nothing.
 * The 943 entry was lowercase for two deployments running and the e2e callback and ring
 * exercises could not have passed in that time.
 */
describe('the registry', () => {
  test('every address is checksummed', () => {
    for (const n of Object.values(NETWORKS)) {
      expect(getAddress(n.settlement)).toBe(n.settlement)
      for (const v of n.xyk) {
        expect(getAddress(v.router)).toBe(v.router)
        expect(getAddress(v.factory)).toBe(v.factory)
      }
      for (const t of n.tokens) expect(getAddress(t.address)).toBe(t.address)
    }
  })
})

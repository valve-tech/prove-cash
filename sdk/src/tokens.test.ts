import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { Address } from 'viem'
import { NETWORKS, presetTokens, type ChainId } from './config.js'
import { kv, memoryKeyValueStore, setKeyValueStore } from './kv.js'
import {
  cachedToken,
  cleanSymbol,
  displaySymbol,
  forgetToken,
  isListedToken,
  marketAddress,
  registerToken,
  tokenInfo,
} from './tokens.js'

/**
 * `decimals` is the one number in this package that must never be guessed.
 *
 * It used to fall back to 18 whenever the read failed, and the guess was cached and written to
 * local storage, so one dropped request poisoned that token for every later session. Everything
 * downstream multiplies by it: `parse('100', 18)` on a six-decimal token signs an intent for a
 * million million times what the maker typed, against a `minOut` computed correctly. Partial
 * fills are on by default, so an executor could take the maker's whole balance and owe rounding
 * dust for it.
 *
 * That is the same fault as every other one this codebase has removed — a dropped read reported
 * as a fact — at the worst consequence it has. These tests are the guard.
 *
 * Reading the right chain's answer is the same guard one step out, and the second half of this
 * file holds it: a cached decimal place from the wrong chain is a guess with a cache entry to
 * vouch for it.
 */

/** The chain the read tests ask. Named rather than defaulted, exactly as the functions are. */
const CHAIN: ChainId = 943
/** The other registered chain. Nothing written under `CHAIN` may ever appear here. */
const OTHER: ChainId = 369

/**
 * Deliberately not a preset. The cache is seeded from `presetTokens(chainId)`, so a listed token
 * is answered before the chain is ever asked — and the chain read is the whole subject here. A
 * pasted address in the token picker takes exactly this path.
 */
const TOKEN = '0x7f3d1a9c04e2b8156f0ad4c3e9b27510d8a6f412' as Address

/** A client that answers these two reads however the test says. An Error value is thrown. */
const endpoint = (answers: { symbol?: unknown; decimals?: unknown }) =>
  ({
    readContract: async ({ functionName }: { functionName: string }) => {
      const v = answers[functionName as 'symbol' | 'decimals']
      if (v instanceof Error) throw v
      if (v === undefined) throw new Error(`the test gave no answer for ${functionName}`)
      return v
    },
  }) as unknown as Parameters<typeof tokenInfo>[2]

// A store of this process, so nothing here reaches a real browser's localStorage and nothing
// carried in from another file's run can answer for a chain.
beforeAll(() => setKeyValueStore(memoryKeyValueStore()))

afterEach(() => {
  forgetToken(CHAIN, TOKEN)
  forgetToken(OTHER, TOKEN)
})

describe('tokenInfo', () => {
  test('reads a token the chain answers for', async () => {
    const got = await tokenInfo(CHAIN, TOKEN, endpoint({ symbol: 'tUSDC', decimals: 6 }))
    expect(got).toEqual({ address: TOKEN, symbol: 'tUSDC', decimals: 6, unlisted: true })
  })

  test('a dropped decimals read is not eighteen decimals', async () => {
    const got = await tokenInfo(CHAIN, TOKEN, endpoint({ symbol: 'tUSDC', decimals: new Error('gone') }))
    expect(got).toBeNull()
  })

  test('and it is not remembered, so the next read can still succeed', async () => {
    // The old code cached the guess and persisted it, so the mistake outlived the outage.
    await tokenInfo(CHAIN, TOKEN, endpoint({ symbol: 'tUSDC', decimals: new Error('gone') }))
    const second = await tokenInfo(CHAIN, TOKEN, endpoint({ symbol: 'tUSDC', decimals: 6 }))
    expect(second?.decimals).toBe(6)
  })

  test('a symbol nobody can read is only a missing name', async () => {
    // Cosmetic, and honest about it. Decimals is the number that moves money; a symbol is not.
    const got = await tokenInfo(CHAIN, TOKEN, endpoint({ symbol: new Error('gone'), decimals: 6 }))
    expect(got).toEqual({ address: TOKEN, symbol: '???', decimals: 6, unlisted: true })
  })

  test('zero decimals is a real answer, not a missing one', async () => {
    const got = await tokenInfo(CHAIN, TOKEN, endpoint({ symbol: 'NFTish', decimals: 0 }))
    expect(got?.decimals).toBe(0)
  })

  test('a nonsense decimals answer is refused rather than trusted', async () => {
    for (const bad of [-1, 1.5, 999, Number.NaN]) {
      expect(await tokenInfo(CHAIN, TOKEN, endpoint({ symbol: 'X', decimals: bad })), `${bad}`).toBeNull()
      forgetToken(CHAIN, TOKEN)
    }
  })
})

/**
 * The cache is keyed by chain and address, not by address alone.
 *
 * One address is one contract on one chain and a different contract on the next. The cache used
 * to hold a single map keyed by address, seeded from every chain's presets at once, so the two
 * registry entries for HEX — the same address on 369 and on 943 — already shared one slot. That
 * was safe only while the entries agreed, and nothing held them to it.
 */
describe('the cache is per chain', () => {
  test('the same address can be two different tokens, one per chain', async () => {
    await tokenInfo(CHAIN, TOKEN, endpoint({ symbol: 'tUSDC', decimals: 6 }))
    // Nothing has been read on the other chain, so it knows nothing about this address.
    expect(cachedToken(OTHER, TOKEN)).toBeUndefined()

    await tokenInfo(OTHER, TOKEN, endpoint({ symbol: 'WHATEVER', decimals: 18 }))
    // Both answers stand, each under its own chain. One slot could hold only the first.
    expect(cachedToken(CHAIN, TOKEN)?.decimals).toBe(6)
    expect(cachedToken(OTHER, TOKEN)?.decimals).toBe(18)
  })

  test('a token adopted on one chain is not adopted on the other', () => {
    registerToken(CHAIN, { address: TOKEN, symbol: 'tUSDC', decimals: 6 })
    expect(cachedToken(CHAIN, TOKEN)?.symbol).toBe('tUSDC')
    expect(cachedToken(OTHER, TOKEN)).toBeUndefined()
  })

  test('each chain is seeded from its own registry entry, not from every chain at once', () => {
    // A token only 943 ships with must not be answerable on 369, whatever 943 has read.
    const onlyTestnet = presetTokens(CHAIN).find(
      (t) => !presetTokens(OTHER).some((u) => u.address.toLowerCase() === t.address.toLowerCase()),
    )!
    expect(cachedToken(CHAIN, onlyTestnet.address)).toBeDefined()
    expect(cachedToken(OTHER, onlyTestnet.address)).toBeUndefined()
  })

  test('a shared address gets one entry per chain, from that chain', () => {
    // HEX sits at one address on both chains. This is the slot the two entries used to share.
    const shared = NETWORKS[OTHER].tokens.find((t) =>
      NETWORKS[CHAIN].tokens.some((u) => u.address.toLowerCase() === t.address.toLowerCase()),
    )!
    expect(cachedToken(CHAIN, shared.address)).toEqual(
      NETWORKS[CHAIN].tokens.find((t) => t.address.toLowerCase() === shared.address.toLowerCase()),
    )
    expect(cachedToken(OTHER, shared.address)).toEqual(shared)
  })

  test('each chain persists under a key of its own', async () => {
    await tokenInfo(CHAIN, TOKEN, endpoint({ symbol: 'tUSDC', decimals: 6 }))
    const stored = JSON.parse(kv().getItem(`provecash.tokens.${CHAIN}`) || '{}')
    expect(stored[TOKEN.toLowerCase()]?.decimals).toBe(6)
    // The un-keyed key is never written again, whatever this build reads.
    expect(kv().getItem('provecash.tokens')).toBeNull()
  })
})

/**
 * What happens to the cache an older build left under the un-keyed key.
 *
 * It is dropped, and `tokens.ts` carries the reasoning: nothing in the blob says which chain read
 * a row, so filing it under one would put that chain's name on another chain's decimals. Unlike a
 * kept intent, every row in it is a cached answer to a public read that costs one round trip to
 * ask again — and the rows that matter on the first frame come from the registry, not from here.
 *
 * The module seeds itself at import, so this runs against a fresh copy of the module graph with
 * the old-shape blob already in the store. That is the only way to see the first read of it.
 */
describe('the un-keyed cache an older build left', () => {
  /** A blob in the old shape: one flat address-to-token map, with no chain anywhere in it. */
  const LEGACY = {
    [TOKEN.toLowerCase()]: { address: TOKEN, symbol: 'GHOST', decimals: 2 },
  }

  async function freshModules() {
    vi.resetModules()
    const kvMod = await import('./kv.js')
    const store = kvMod.memoryKeyValueStore()
    kvMod.setKeyValueStore(store)
    store.setItem('provecash.tokens', JSON.stringify(LEGACY))
    return { store, tokens: await import('./tokens.js') }
  }

  test('is not served under any chain, because no chain can claim it', async () => {
    const { tokens } = await freshModules()
    expect(tokens.cachedToken(CHAIN, TOKEN)).toBeUndefined()
    expect(tokens.cachedToken(OTHER, TOKEN)).toBeUndefined()
  })

  test('is removed, so a browser carries it no further', async () => {
    const { store, tokens } = await freshModules()
    // The first cache built in the process clears it. Reading one chain is enough.
    tokens.cachedToken(CHAIN, TOKEN)
    expect(store.getItem('provecash.tokens')).toBeNull()
  })

  test('does not take the presets this build ships with', async () => {
    const { tokens } = await freshModules()
    const preset = presetTokens(CHAIN)[0]
    expect(tokens.cachedToken(CHAIN, preset.address)).toEqual(preset)
  })
})

/**
 * A token nobody listed never wears a listed token's name, face or market.
 *
 * `underlying()` is a function the token itself answers. A fake named `x402USDC` answered with
 * real USDC's address, and `displaySymbol`, `marketAddress` and the app's avatar then showed the
 * fake as USDC, with USDC's logo and USDC's pool. The Uniswap interface and the token-list
 * standard draw the same line: a token off every list is "unknown", keeps its own address in
 * view, and borrows nothing from a listed one.
 */
describe('an unlisted token', () => {
  const USDC = '0x33D3BBF903D3E85973aF93d55CDeA7C1523e607B' as Address
  /** A client that also answers `underlying()`, the way a fake wrapper would. */
  const wrapper = (symbol: string, underlying: Address) =>
    ({
      readContract: async ({ functionName, address }: { functionName: string; address: Address }) => {
        if (functionName === 'underlying') return underlying
        if (address.toLowerCase() === underlying.toLowerCase()) {
          return functionName === 'symbol' ? 'USDC' : 6
        }
        return functionName === 'symbol' ? symbol : 6
      },
    }) as unknown as Parameters<typeof tokenInfo>[2]

  test('does not take a wrapper identity from its own underlying() answer', async () => {
    const got = await tokenInfo(CHAIN, TOKEN, wrapper('x402USDC', USDC))
    expect(got?.wraps).toBeUndefined()
    expect(got?.wrapsSymbol).toBeUndefined()
    expect(marketAddress(got!)).toBe(TOKEN)
  })

  test('shows its own address beside its symbol, and never a listed name alone', async () => {
    const got = await tokenInfo(CHAIN, TOKEN, wrapper('x402USDC', USDC))
    const shown = displaySymbol(got!)
    expect(shown).not.toBe('USDC')
    expect(shown).toContain('x402USDC')
    expect(shown).toContain(TOKEN.slice(0, 6))
    expect(isListedToken(got!)).toBe(false)
  })

  test('is marked unlisted even when an older build stored it with a wrapper identity', async () => {
    vi.resetModules()
    const kvMod = await import('./kv.js')
    const store = kvMod.memoryKeyValueStore()
    kvMod.setKeyValueStore(store)
    store.setItem(
      `provecash.tokens.${CHAIN}`,
      JSON.stringify({
        [TOKEN.toLowerCase()]: { address: TOKEN, symbol: 'x402USDC', decimals: 6, wraps: USDC, wrapsSymbol: 'USDC' },
      }),
    )
    const fresh = await import('./tokens.js')
    const row = fresh.cachedToken(CHAIN, TOKEN)!
    expect(fresh.marketAddress(row)).toBe(TOKEN)
    expect(fresh.displaySymbol(row)).not.toBe('USDC')
    setKeyValueStore(memoryKeyValueStore())
  })

  test('a listed x402 wrapper still shows its underlying', async () => {
    const preset = presetTokens(CHAIN).find((t) => t.symbol === 'x402USDC')!
    expect(displaySymbol({ ...preset, wraps: USDC, wrapsSymbol: 'tUSDC' })).toBe('tUSDC')
    expect(marketAddress({ ...preset, wraps: USDC })).toBe(USDC)
  })
})

describe('cleanSymbol', () => {
  test('strips bidi overrides and control characters', () => {
    // U+202E turns "CDSU" into what reads as "USDC" on screen.
    expect(cleanSymbol('‮CDSU')).toBe('CDSU')
    expect(cleanSymbol('US\u0000DC​⁦')).toBe('USDC')
  })

  test('caps the length, as the token-list schema does', () => {
    expect(cleanSymbol('A'.repeat(200)).length).toBeLessThanOrEqual(20)
  })

  test('names an empty symbol as unknown', () => {
    expect(cleanSymbol('‮\u0007')).toBe('???')
  })

  test('applies to a listed token too', () => {
    expect(displaySymbol({ address: TOKEN, symbol: 'tUSDC‮', decimals: 6 })).toBe('tUSDC')
  })
})

import { describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import {
  heldOf,
  movedTokens,
  ranked,
  START_CHAIN,
  START_TOKENS,
  tokensMoved,
  verdict,
  type Look,
} from './holdings.ts'

/**
 * The hint is only worth showing if it is true. A token this address never held, offered as
 * "start here", sends somebody to a form they cannot fill — and an index that did not answer
 * must never read as "you have never used this chain".
 *
 * The rows below are the shape `chifra export --logs` really returns, transcribed from a live
 * call against `pulsechain-v4`.
 */

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'

const ME = '0xC3C6C6Cd76B018550EbF4F7Cb856Fd921dE2Ae21' as Address
const OTHER = '0x79cdd2425f46061b3b750e83a4b0201618e92ca8'
const TUSDC = '0x86390129a2079fb7f0fc889473160a3a449117ab' as Address
const TPLSX = '0xabef58363e0fc60250d16778848eaed831ea26f9' as Address
const TWETH = '0xcb5c3ed9cd727f142d1b9efc60790550683aa655' as Address

/** A 20-byte address as a 32-byte topic. */
const asTopic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`

const transfer = (token: string, from: string, to: string) => ({
  address: token,
  topics: [TRANSFER, asTopic(from), asTopic(to)],
})

describe('tokensMoved', () => {
  test('keeps a token this address received', () => {
    expect(tokensMoved([transfer(TUSDC, OTHER, ME)], ME)).toEqual([TUSDC])
  })

  test('keeps a token this address sent', () => {
    expect(tokensMoved([transfer(TPLSX, ME, OTHER)], ME)).toEqual([TPLSX])
  })

  test('drops a transfer between two strangers', () => {
    // An address appears in a transaction it merely paid for, and in every hop of a route it
    // took. A pool's own token is not a token the visitor holds.
    expect(tokensMoved([transfer(TUSDC, OTHER, OTHER)], ME)).toEqual([])
  })

  test('drops an Approval, which moves nothing', () => {
    const approval = { address: TUSDC, topics: [APPROVAL, asTopic(ME), asTopic(OTHER)] }
    expect(tokensMoved([approval], ME)).toEqual([])
  })

  test('names each token once, in the order it last appeared', () => {
    const rows = [
      transfer(TUSDC, ME, OTHER),
      transfer(TPLSX, OTHER, ME),
      transfer(TUSDC, OTHER, ME),
    ]
    expect(tokensMoved(rows, ME)).toEqual([TUSDC, TPLSX])
  })

  test('survives a row with no topics at all', () => {
    expect(tokensMoved([{ address: TUSDC }, transfer(TUSDC, ME, OTHER)], ME)).toEqual([TUSDC])
  })

  test('is not fooled by an address that only shares a suffix', () => {
    const lookalike = `0x1111${ME.slice(6)}`
    expect(tokensMoved([transfer(TUSDC, lookalike, OTHER)], ME)).toEqual([])
  })
})

describe('movedTokens', () => {
  const ok = (rows: unknown[]) =>
    (async () =>
      ({ ok: true, json: async () => ({ data: rows }) }) as unknown as Response) as typeof fetch

  test('asks the index for this chain by the slug it knows', async () => {
    let asked = ''
    const spy = (async (url: unknown) => {
      asked = String(url)
      return { ok: true, json: async () => ({ data: [] }) } as unknown as Response
    }) as typeof fetch

    await movedTokens(ME, 943, spy)
    expect(asked).toContain('chain=pulsechain-v4')
    await movedTokens(ME, 369, spy)
    expect(asked).toContain('chain=pulsechain')
  })

  test('reads the tokens out of a real answer', async () => {
    const got = await movedTokens(ME, 943, ok([transfer(TUSDC, OTHER, ME)]))
    expect(got).toEqual({ ok: true, chainId: 943, tokens: [TUSDC], truncated: false })
  })

  test('an address with no history is an answer, and says so', async () => {
    expect(await movedTokens(ME, 943, ok([]))).toEqual({
      ok: true,
      chainId: 943,
      tokens: [],
      truncated: false,
    })
  })

  test('an index that refuses is not an empty wallet', async () => {
    const refused = (async () => ({ ok: false }) as unknown as Response) as typeof fetch
    expect(await movedTokens(ME, 943, refused)).toEqual({ ok: false, reason: 'unreachable' })
  })

  test('an index that never answers is not an empty wallet either', async () => {
    const dead = (async () => {
      throw new Error('timed out')
    }) as typeof fetch
    expect(await movedTokens(ME, 943, dead)).toEqual({ ok: false, reason: 'unreachable' })
  })

  test('a body without a data array is not an empty wallet either', async () => {
    // The daemon answers 200 with `{ errors: [...] }` for a query it does not like. Reading the
    // missing `data` as zero tokens would tell a visitor their wallet is empty because we sent a
    // bad request.
    const odd = (async () =>
      ({ ok: true, json: async () => ({ errors: ['Invalid key'] }) }) as unknown as Response) as typeof fetch
    expect(await movedTokens(ME, 943, odd)).toEqual({ ok: false, reason: 'unreachable' })
  })
})

/**
 * The landing page carries its own copy of the token list, because importing the SDK's would
 * pull viem and the chain registry into the entry bundle and undo the split between the two
 * surfaces. A copy drifts unless something compares it, so this is that something.
 *
 * The test may import the SDK freely — it is never bundled.
 */
describe('the starting tokens match the app', () => {
  test('same chain, same tokens, same order', async () => {
    const { DEFAULT_CHAIN, presetTokens } = await import('@prove.cash/sdk')
    expect(START_CHAIN).toBe(DEFAULT_CHAIN)
    expect(START_TOKENS.map((t) => [t.address, t.symbol])).toEqual(
      presetTokens(DEFAULT_CHAIN).map((t) => [t.address, t.symbol]),
    )
  })
})

describe('ranked', () => {
  const held = (moved: Address[]) => heldOf(ranked(moved)).map((t) => t.symbol)

  test('brings the tokens this address moved to the front', () => {
    // tWETH is last in the list and must lead once the address has held it.
    const order = ranked([TWETH]).map((r) => r.token.symbol)
    expect(order[0]).toBe('tWETH')
  })

  test('keeps every chip, so there is always somewhere to start', () => {
    expect(ranked([]).length).toBe(START_TOKENS.length)
    expect(ranked([TUSDC]).length).toBe(START_TOKENS.length)
  })

  test('marks only what the address actually moved', () => {
    expect(held([TUSDC, TPLSX])).toEqual(['tUSDC', 'tPLSX'])
  })

  test('ranks by the order the index answered in, latest first', () => {
    expect(held([TUSDC, TPLSX])).toEqual(['tUSDC', 'tPLSX'])
    expect(held([TPLSX, TUSDC])).toEqual(['tPLSX', 'tUSDC'])
  })

  test('a token the app does not list marks nothing and drops no chip', () => {
    const stranger = '0x0b196d5f756060e67416bf45e3e04146a51ee84b' as Address
    expect(held([stranger])).toEqual([])
    expect(ranked([stranger]).map((r) => r.token.symbol)).toEqual(
      START_TOKENS.map((t) => t.symbol),
    )
  })

  test('matches whatever case the index answers in', () => {
    expect(held([TUSDC.toUpperCase().replace('0X', '0x') as Address])).toEqual(['tUSDC'])
  })
})

describe('what the lookup says it found', () => {
  const done = (patch: Partial<Extract<Look, { phase: 'done' }>>): Look => ({
    phase: 'done',
    moved: [],
    held: [],
    truncated: false,
    ...patch,
  })

  test('a match names the tokens, so the reader can check it', () => {
    const said = verdict(done({ moved: [TUSDC], held: [START_TOKENS[5]!] }))
    expect(said).toContain('tUSDC')
    expect(said).toMatch(/moved/i)
  })

  test('it also says how many it saw that are not listed, and counts them in English', () => {
    const stranger = '0x0b196d5f756060e67416bf45e3e04146a51ee84b' as Address
    const one = verdict(done({ moved: [TUSDC, stranger], held: [START_TOKENS[5]!] }))
    expect(one).toContain('1 other token is not listed')

    const two = verdict(done({ moved: [TUSDC, stranger, TWETH], held: [START_TOKENS[5]!] }))
    expect(two).toContain('2 other tokens are not listed')
  })

  test('a history we cannot trade is reported, not reported as nothing', () => {
    // The bug this replaced: the request went out, real data came back, and the only thing that
    // changed on screen was one line that said the same as before.
    const said = verdict(done({ moved: ['0x1' as Address, '0x2' as Address] }))
    expect(said).toContain('None of the 2 tokens you have moved here are listed yet')
    expect(said).not.toMatch(/new to the testnet/i)

    expect(verdict(done({ moved: ['0x1' as Address] }))).toContain('The one token you have moved')
  })

  test('a truncated read does not pass its slice off as the whole history', () => {
    const cut = verdict(done({ moved: ['0x1' as Address], truncated: true }))
    const all = verdict(done({ moved: ['0x1' as Address], truncated: false }))
    expect(cut).toContain('recently')
    expect(all).toContain('here')
    expect(cut).not.toBe(all)
  })

  test('an address with no history says exactly that', () => {
    expect(verdict(done({}))).toMatch(/new to the testnet/i)
  })

  test('a dead index says so, and claims nothing about the wallet', () => {
    const down = verdict({ phase: 'unreachable' })
    expect(down).toMatch(/did not answer/i)
    expect(down).not.toMatch(/you have|new to/i)
  })
})

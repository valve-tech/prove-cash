import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createWalletClient,
  custom,
  decodeFunctionData,
  erc20Abi,
  numberToHex,
  pad,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { pulsechainV4 } from 'viem/chains'
import { memoryKeyValueStore, setKeyValueStore } from './kv.js'
import { setSettlementOverride, type ChainId } from './config.js'
import { approvePermit2, approveRelayer, approveToken } from './settlement.js'

/**
 * The three approvals, and the two ways each of them used to cost a maker money for nothing.
 *
 * A USDT-shaped token refuses a non-zero approval while a non-zero allowance stands, so a maker
 * holding a partial standing allowance could not raise it — the transaction reverted after they
 * had paid for it. And on a chain with no settlement the relayer was read off the zero address,
 * which either fails confusingly or, on an endpoint that answers a codeless address with zeros,
 * grants an approval to nobody.
 *
 * Nothing here reaches a chain and no key is used. The reads go through a stubbed `fetch`, so the
 * real SDK does its real encoding and decoding against answers this file gives; the writes go
 * through a real viem wallet client over a transport that records them. So a spender asserted
 * below is the address the code resolved, not one a mock was told to return.
 */

const LIVE: ChainId = 943
/** Mainnet. The registry gives it the zero address, which is what "no settlement" looks like. */
const DEAD: ChainId = 369

const MAKER: Address = '0x1111111111111111111111111111111111111111'
const TOKEN: Address = '0x2222222222222222222222222222222222222222'
/** Overridden rather than read from the registry, which moves on every redeploy. */
const SETTLEMENT: Address = '0x00000000000000000000000000000000000f0f0f'
/** Read off the settlement. `ProveRelayer` holds every maker allowance. */
const RELAYER: Address = '0x000000000000000000000000000000000000aaaa'
/** Read off the relayer. The one grant that outlives a redeploy. */
const PERMIT2: Address = '0x000000000000000000000000000000000000bbbb'

/** A distinct hash per transaction, so a test can say which one it got back. */
const hashOf = (n: number): Hex => `0x${String(n).repeat(64)}` as Hex

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

/** How the approval behaves when the chain is asked whether it would go through. */
type Approve = 'ok' | 'usdt' | 'down'

/**
 * The chain, as far as the SDK's reads are concerned. Routed by the address being called.
 *
 * `usdt` is the mock that matters, and its rule is USDT's own: refuse a non-zero approval while a
 * non-zero allowance stands. A mock is the right tool because no real USDT sits on a local chain,
 * and the rule is small enough to state exactly.
 */
function fakeChain({ allowance = 0n, approve = 'ok' }: { allowance?: bigint; approve?: Approve }) {
  const calls: { to: Address; from?: Address; name: string; args: readonly unknown[] }[] = []
  const fetchStub = async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }
    if (body.method !== 'eth_call') throw new Error(`the chain was asked for ${body.method}`)
    const call = body.params[0] as { to: Address; from?: Address; data: Hex }
    const to = call.to.toLowerCase()
    if (to === SETTLEMENT.toLowerCase()) {
      calls.push({ to: call.to, from: call.from, name: 'relayer', args: [] })
      return json({ jsonrpc: '2.0', id: body.id, result: pad(RELAYER, { size: 32 }) })
    }
    if (to === RELAYER.toLowerCase()) {
      calls.push({ to: call.to, from: call.from, name: 'permit2', args: [] })
      return json({ jsonrpc: '2.0', id: body.id, result: pad(PERMIT2, { size: 32 }) })
    }
    if (to === TOKEN.toLowerCase()) {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: call.data })
      calls.push({ to: call.to, from: call.from, name: functionName, args: args ?? [] })
      if (functionName === 'allowance') {
        return json({ jsonrpc: '2.0', id: body.id, result: toHex(allowance, { size: 32 }) })
      }
      if (functionName === 'approve') {
        // The endpoint is down. It says nothing about the token, and must not be read as a no.
        if (approve === 'down') throw new TypeError('fetch failed')
        if (approve === 'usdt' && allowance > 0n && (args?.[1] as bigint) > 0n) {
          // What a node sends back for a reverted call. Code 3 carries the revert data.
          const error = { code: 3, message: 'execution reverted', data: '0x' }
          return json({ jsonrpc: '2.0', id: body.id, error })
        }
        return json({ jsonrpc: '2.0', id: body.id, result: toHex(1n, { size: 32 }) })
      }
    }
    throw new Error(`the chain was asked about ${call.to}, which nothing here should call`)
  }
  vi.stubGlobal('fetch', fetchStub)
  return { calls, probes: () => calls.filter((c) => c.name === 'approve') }
}

/** A real wallet client over a transport that records what it was asked to send. */
function fakeWallet() {
  const sent: { to: Address; data: Hex }[] = []
  const client = createWalletClient({
    chain: pulsechainV4,
    transport: custom({
      request: async ({ method, params }: { method: string; params?: unknown }) => {
        switch (method) {
          case 'eth_chainId':
            return numberToHex(LIVE)
          case 'eth_accounts':
            return [MAKER]
          case 'eth_sendTransaction': {
            sent.push((params as [{ to: Address; data: Hex }])[0])
            return hashOf(sent.length)
          }
        }
        throw new Error(`the wallet was asked for ${method}`)
      },
    }),
  })
  /** Every transaction sent, taken apart with the ERC-20 ABI rather than read off a mock. */
  const approvals = () =>
    sent.map((tx) => {
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data })
      return {
        token: tx.to.toLowerCase(),
        name: functionName,
        spender: String(args?.[0]).toLowerCase(),
        amount: args?.[1] as bigint,
      }
    })
  return { client, sent, approvals }
}

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  setSettlementOverride(LIVE, SETTLEMENT)
  // Off by override, not by the registry's zero: after #52 the registry names a settlement.
  setSettlementOverride(DEAD, '0x0000000000000000000000000000000000000000')
})

afterEach(() => {
  setSettlementOverride(LIVE, null)
  setSettlementOverride(DEAD, null)
  setKeyValueStore(null)
  vi.unstubAllGlobals()
})

describe('raising an allowance a token will not let you raise', () => {
  test('a token that accepts the raise gets one transaction, and it is the raise', async () => {
    // The ordinary ERC-20. A zero approval here would be a transaction that changed nothing.
    const chain = fakeChain({ allowance: 400n, approve: 'ok' })
    const wallet = fakeWallet()

    await approveToken(wallet.client, MAKER, TOKEN, 1_000n, LIVE)

    expect(wallet.approvals()).toEqual([
      { token: TOKEN.toLowerCase(), name: 'approve', spender: RELAYER.toLowerCase(), amount: 1_000n },
    ])
    // It still asked. Skipping the question would be guessing which token this is.
    expect(chain.probes()).toHaveLength(1)
  })

  test('a token that refuses the raise is zeroed first, then raised', async () => {
    // The USDT shape. Without the zero approval the raise reverts and the maker has paid for it.
    fakeChain({ allowance: 400n, approve: 'usdt' })
    const wallet = fakeWallet()

    await approveToken(wallet.client, MAKER, TOKEN, 1_000n, LIVE)

    expect(wallet.approvals()).toEqual([
      { token: TOKEN.toLowerCase(), name: 'approve', spender: RELAYER.toLowerCase(), amount: 0n },
      { token: TOKEN.toLowerCase(), name: 'approve', spender: RELAYER.toLowerCase(), amount: 1_000n },
    ])
  })

  test('the hash handed back is the raise, not the zeroing', async () => {
    // A caller waits on what this returns. The zeroing hash would confirm a grant of nothing.
    fakeChain({ allowance: 400n, approve: 'usdt' })
    const wallet = fakeWallet()

    expect(await approveToken(wallet.client, MAKER, TOKEN, 1_000n, LIVE)).toBe(hashOf(2))
  })

  test('a USDT-shaped token with no standing allowance is raised in one transaction', async () => {
    // Nothing to zero. The token only refuses while an allowance stands.
    fakeChain({ allowance: 0n, approve: 'usdt' })
    const wallet = fakeWallet()

    await approveToken(wallet.client, MAKER, TOKEN, 1_000n, LIVE)

    expect(wallet.approvals()).toHaveLength(1)
    expect(wallet.approvals()[0]?.amount).toBe(1_000n)
  })

  test('a revoke is never zeroed first, and never asks', async () => {
    // Every token accepts a fall to zero, so the question has one answer and costs a round trip.
    const chain = fakeChain({ allowance: 400n, approve: 'usdt' })
    const wallet = fakeWallet()

    await approveToken(wallet.client, MAKER, TOKEN, 0n, LIVE)

    expect(wallet.approvals()).toHaveLength(1)
    expect(wallet.approvals()[0]?.amount).toBe(0n)
    expect(chain.probes()).toEqual([])
  })

  test('the question is asked as the maker, about the spender being raised', async () => {
    // The answer depends on the allowance this maker holds. Asking as anybody else asks about a
    // different allowance, and the answer would be about nothing.
    const chain = fakeChain({ allowance: 400n, approve: 'ok' })
    const wallet = fakeWallet()

    await approveToken(wallet.client, MAKER, TOKEN, 1_000n, LIVE)

    const probe = chain.probes()[0]
    expect(probe?.from?.toLowerCase()).toBe(MAKER.toLowerCase())
    expect(String(probe?.args[0]).toLowerCase()).toBe(RELAYER.toLowerCase())
    expect(probe?.args[1]).toBe(1_000n)
  })

  test('an endpoint that is down buys no zero approval', async () => {
    // A failed request says nothing about the token. Zeroing on a guess costs a second prompt,
    // and a maker who refuses it holds less allowance than they started with.
    fakeChain({ allowance: 400n, approve: 'down' })
    const wallet = fakeWallet()

    await approveToken(wallet.client, MAKER, TOKEN, 1_000n, LIVE)

    expect(wallet.approvals()).toHaveLength(1)
    expect(wallet.approvals()[0]?.amount).toBe(1_000n)
  })

  test('the permit2 grant is zeroed first too, and for its own spender', async () => {
    fakeChain({ allowance: 400n, approve: 'usdt' })
    const wallet = fakeWallet()

    await approvePermit2(wallet.client, MAKER, TOKEN, 1_000n, LIVE)

    expect(wallet.approvals().map((a) => a.amount)).toEqual([0n, 1_000n])
    expect(wallet.approvals().map((a) => a.spender)).toEqual([
      PERMIT2.toLowerCase(),
      PERMIT2.toLowerCase(),
    ])
  })

  test('a maker raising a partial standing allowance can now do it', async () => {
    // The whole case, end to end: 400 approved, 1,000 needed, on a token that refuses the raise.
    fakeChain({ allowance: 400n, approve: 'usdt' })
    const wallet = fakeWallet()

    expect(await approveRelayer(wallet.client, MAKER, TOKEN, 1_000n, LIVE)).toBe(hashOf(2))
    expect(wallet.approvals().map((a) => a.amount)).toEqual([0n, 1_000n])
  })

  test('an allowance that already covers the amount still sends nothing', async () => {
    // The short-circuit that was there before. Nothing above may cost a maker a transaction here.
    fakeChain({ allowance: 10_000n, approve: 'usdt' })
    const wallet = fakeWallet()

    expect(await approveRelayer(wallet.client, MAKER, TOKEN, 1_000n, LIVE)).toBeNull()
    expect(wallet.sent).toEqual([])
  })
})

describe('a chain with no settlement is refused', () => {
  test('approveRelayer refuses, and asks the chain nothing', async () => {
    // It used to read the relayer off the zero address and send an approval that grants nothing
    // a fill can use. The allowance read is not this check: it answers zero here either way.
    const chain = fakeChain({ allowance: 0n })
    const wallet = fakeWallet()

    await expect(approveRelayer(wallet.client, MAKER, TOKEN, 1_000n, DEAD)).rejects.toThrow(
      /not deployed/,
    )
    expect(wallet.sent).toEqual([])
    expect(chain.calls).toEqual([])
  })

  test('approveToken refuses, the way every other write in that file refuses', async () => {
    const chain = fakeChain({ allowance: 0n })
    const wallet = fakeWallet()

    await expect(approveToken(wallet.client, MAKER, TOKEN, 1_000n, DEAD)).rejects.toThrow(
      /not deployed/,
    )
    expect(wallet.sent).toEqual([])
    expect(chain.calls).toEqual([])
  })

  test('approvePermit2 refuses, because its address comes off the relayer', async () => {
    const chain = fakeChain({ allowance: 0n })
    const wallet = fakeWallet()

    await expect(approvePermit2(wallet.client, MAKER, TOKEN, 1_000n, DEAD)).rejects.toThrow(
      /not deployed/,
    )
    expect(wallet.sent).toEqual([])
    expect(chain.calls).toEqual([])
  })
})

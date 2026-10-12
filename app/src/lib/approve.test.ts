import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { decodeFunctionData, erc20Abi, numberToHex, pad, toHex, type Address, type Hex } from 'viem'
import {
  DEFAULT_CHAIN,
  memoryKeyValueStore,
  setChainId,
  setKeyValueStore,
  setSettlementOverride,
  type ChainId,
} from '@prove.cash/sdk'
import { approveRelayer } from './settlement'
import { approvePermit2 } from './custody'

/**
 * The two approvals, and the allowance each one reads before it sends anything.
 *
 * These are the only two functions in the app that hand another contract the right to move a
 * person's tokens, and both are guarded by the same shape: read the standing allowance, send
 * nothing when it is already enough. Both halves of that have to be true. An approval that sends
 * when it need not costs a transaction; one that skips when it must not arms an offer that
 * cannot be filled, and the maker finds out when somebody's fill reverts.
 *
 * Nothing here reaches a chain. The reads go through a stubbed `fetch`, so the real SDK does its
 * real decoding against answers this file gives; the writes go through the same fake EIP-1193
 * wallet the `wallet.ts` tests use. So the addresses below are what the code actually resolved,
 * not what a mock was told to return.
 */

const LIVE: ChainId = 943
const DEAD: ChainId = 369

const MAKER: Address = '0x1111111111111111111111111111111111111111'
const TOKEN: Address = '0x2222222222222222222222222222222222222222'
/** Overridden rather than read from the registry, which moves on every redeploy. */
const SETTLEMENT: Address = '0x00000000000000000000000000000000000f0f0f'
const NONE: Address = '0x0000000000000000000000000000000000000000'
/** Read off the settlement. `ProveRelayer` holds every maker allowance, not the settlement. */
const RELAYER: Address = '0x000000000000000000000000000000000000aaaa'
/** Read off the relayer. The one grant that outlives a redeploy. */
const PERMIT2: Address = '0x000000000000000000000000000000000000bbbb'

const TX: Hex = `0x${'cd'.repeat(32)}`

/** A refusal in the shape a browser wallet uses. 4001 is the person saying no. */
const rejection = (message: string) => Object.assign(new Error(message), { code: 4001 })

/**
 * The chain, as far as the SDK's reads are concerned.
 *
 * Routed by the address being called, because that is the fact each test is about: the relayer
 * comes off the settlement, Permit2 comes off the relayer, and the allowance comes off the token
 * for whichever spender is asked about. A call to anything else is a mistake worth failing on.
 */
function fakeChain(allowances: Partial<Record<Address, bigint>> = {}) {
  const reads: { to: Address; data: Hex }[] = []
  const fetchStub = async (_url: unknown, init: { body?: string }) => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] }
    if (body.method !== 'eth_call') throw new Error(`the chain was asked for ${body.method}`)
    const call = body.params[0] as { to: Address; data: Hex }
    reads.push(call)
    const to = call.to.toLowerCase() as Address
    const result = (() => {
      if (to === SETTLEMENT.toLowerCase()) return pad(RELAYER, { size: 32 })
      if (to === RELAYER.toLowerCase()) return pad(PERMIT2, { size: 32 })
      if (to === TOKEN.toLowerCase()) {
        // The spender is the second argument of `allowance(owner, spender)`, the last 20 bytes
        // of the second word. Reading it is what lets a test say which grant was asked about.
        const spender = `0x${call.data.slice(-40)}`.toLowerCase() as Address
        return toHex(allowances[spender] ?? 0n, { size: 32 })
      }
      throw new Error(`the chain was asked about ${call.to}, which nothing here should call`)
    })()
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  vi.stubGlobal('fetch', fetchStub)
  return { reads, spendersAsked: () => reads.map((r) => `0x${r.data.slice(-40)}`.toLowerCase()) }
}

/** The browser wallet, which answers the chain id and sends the one transaction. */
function fakeWallet(opts: { rejects?: boolean } = {}) {
  const sent: { to: Address; data: Hex }[] = []
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      switch (method) {
        case 'eth_chainId':
          return numberToHex(LIVE)
        case 'eth_sendTransaction': {
          if (opts.rejects) throw rejection('User rejected the request.')
          const tx = (params as [{ to: Address; data: Hex }])[0]
          sent.push(tx)
          return TX
        }
      }
      throw new Error(`the wallet was asked for ${method}`)
    },
  }
  vi.stubGlobal('window', { ethereum: provider })
  return {
    sent,
    /** The one approval that was sent, taken apart with the ERC-20 ABI. */
    approval: () => {
      const tx = sent[0]
      const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data: tx.data })
      return { token: tx.to, functionName, spender: args?.[0] as Address, amount: args?.[1] }
    },
  }
}

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  setChainId(LIVE)
  setSettlementOverride(LIVE, SETTLEMENT)
  setSettlementOverride(DEAD, NONE)
})

afterEach(() => {
  setSettlementOverride(LIVE, null)
  setSettlementOverride(DEAD, null)
  setChainId(DEFAULT_CHAIN)
  vi.unstubAllGlobals()
})

describe('approving the relayer', () => {
  test('sends nothing when the standing allowance already covers the amount', async () => {
    const chain = fakeChain({ [RELAYER.toLowerCase()]: 10_000n })
    const wallet = fakeWallet()
    expect(await approveRelayer(MAKER, TOKEN, 1_000n)).toBeNull()
    expect(wallet.sent).toEqual([])
    // It still asked. A short-circuit that skipped the read would be guessing.
    expect(chain.spendersAsked()).toContain(RELAYER.toLowerCase())
  })

  test('sends nothing when the allowance is exactly the amount', async () => {
    // The boundary the comparison turns on. One unit either side of it is a different answer.
    fakeChain({ [RELAYER.toLowerCase()]: 1_000n })
    const wallet = fakeWallet()
    expect(await approveRelayer(MAKER, TOKEN, 1_000n)).toBeNull()
    expect(wallet.sent).toEqual([])
  })

  test('sends when the allowance is one unit short', async () => {
    fakeChain({ [RELAYER.toLowerCase()]: 999n })
    const wallet = fakeWallet()
    expect(await approveRelayer(MAKER, TOKEN, 1_000n)).toBe(TX)
    expect(wallet.sent).toHaveLength(1)
  })

  test('sends when there is no allowance at all', async () => {
    fakeChain()
    const wallet = fakeWallet()
    expect(await approveRelayer(MAKER, TOKEN, 1_000n)).toBe(TX)
    expect(wallet.sent).toHaveLength(1)
  })

  test('sends when the allowance covers part of the amount', async () => {
    // The case that reads as "approved" on a block explorer and still cannot fill. A partial
    // allowance is not an allowance for this offer.
    fakeChain({ [RELAYER.toLowerCase()]: 400n })
    const wallet = fakeWallet()
    expect(await approveRelayer(MAKER, TOKEN, 1_000n)).toBe(TX)
    expect(wallet.sent).toHaveLength(1)
  })

  test('approves the relayer, and not the settlement', async () => {
    // The settlement calls out to addresses a caller chose, so it holds no allowance. An approval
    // to the wrong address costs a transaction and does nothing, and the maker only finds out
    // when a fill reverts.
    fakeChain()
    const wallet = fakeWallet()
    await approveRelayer(MAKER, TOKEN, 1_000n)
    const approval = wallet.approval()
    expect(approval.functionName).toBe('approve')
    expect(approval.token).toBe(TOKEN)
    expect(approval.spender.toLowerCase()).toBe(RELAYER.toLowerCase())
    expect(approval.spender.toLowerCase()).not.toBe(SETTLEMENT.toLowerCase())
  })

  test('approves the amount it was asked for, and no more', async () => {
    // Not an unlimited approval. The offer is for this much, so the grant is for this much.
    fakeChain()
    const wallet = fakeWallet()
    await approveRelayer(MAKER, TOKEN, 1_000n)
    expect(wallet.approval().amount).toBe(1_000n)
  })

  test('a refused approval is passed on, and no hash is invented for it', async () => {
    fakeChain()
    fakeWallet({ rejects: true })
    await expect(approveRelayer(MAKER, TOKEN, 1_000n)).rejects.toThrow(/rejected/i)
  })

  test('a chain with no settlement is refused, the way every other write here is', async () => {
    // Its siblings in this file all refuse before they open a wallet. This one reads an allowance
    // instead, and on a chain with no settlement that read answers zero — which is not "no
    // allowance", it is "no contract to approve".
    setChainId(DEAD)
    fakeChain()
    const wallet = fakeWallet()
    await expect(approveRelayer(MAKER, TOKEN, 1_000n)).rejects.toThrow(/not deployed/)
    expect(wallet.sent).toEqual([])
  })
})

describe('approving Permit2', () => {
  test('sends nothing when the standing grant already covers the amount', async () => {
    // A maker pays this once and never again: Permit2's address does not move when we redeploy,
    // so the grant outlives every settlement. Re-approving it would be a transaction for nothing.
    const chain = fakeChain({ [PERMIT2.toLowerCase()]: 10_000n })
    const wallet = fakeWallet()
    expect(await approvePermit2(MAKER, TOKEN, 1_000n)).toBeNull()
    expect(wallet.sent).toEqual([])
    expect(chain.spendersAsked()).toContain(PERMIT2.toLowerCase())
  })

  test('sends nothing when the grant is exactly the amount', async () => {
    fakeChain({ [PERMIT2.toLowerCase()]: 1_000n })
    const wallet = fakeWallet()
    expect(await approvePermit2(MAKER, TOKEN, 1_000n)).toBeNull()
    expect(wallet.sent).toEqual([])
  })

  test('sends when the grant is one unit short', async () => {
    fakeChain({ [PERMIT2.toLowerCase()]: 999n })
    const wallet = fakeWallet()
    expect(await approvePermit2(MAKER, TOKEN, 1_000n)).toBe(TX)
    expect(wallet.sent).toHaveLength(1)
  })

  test('sends when there is no grant at all', async () => {
    fakeChain()
    const wallet = fakeWallet()
    expect(await approvePermit2(MAKER, TOKEN, 1_000n)).toBe(TX)
    expect(wallet.sent).toHaveLength(1)
  })

  test('approves Permit2, which is read off the relayer rather than assumed', async () => {
    // "Canonical" is not "what this deployment was wired to". A settlement built against another
    // Permit2 would take every maker's approval to an address it will never call.
    fakeChain()
    const wallet = fakeWallet()
    await approvePermit2(MAKER, TOKEN, 1_000n)
    const approval = wallet.approval()
    expect(approval.functionName).toBe('approve')
    expect(approval.token).toBe(TOKEN)
    expect(approval.spender.toLowerCase()).toBe(PERMIT2.toLowerCase())
  })

  test('and not the relayer, which is the other rung’s address', async () => {
    // The two grants sit on the same token and mean different things. Confusing them approves
    // the wrong spender and leaves the rung unarmed.
    fakeChain()
    const wallet = fakeWallet()
    await approvePermit2(MAKER, TOKEN, 1_000n)
    expect(wallet.approval().spender.toLowerCase()).not.toBe(RELAYER.toLowerCase())
  })

  test('approves the amount it was asked for', async () => {
    fakeChain()
    const wallet = fakeWallet()
    await approvePermit2(MAKER, TOKEN, 1_000n)
    expect(wallet.approval().amount).toBe(1_000n)
  })

  test('a refused approval is passed on', async () => {
    fakeChain()
    fakeWallet({ rejects: true })
    await expect(approvePermit2(MAKER, TOKEN, 1_000n)).rejects.toThrow(/rejected/i)
  })
})

describe('the two grants are separate', () => {
  test('a full Permit2 grant does not satisfy the relayer, or the other way about', async () => {
    // Each rung reads its own spender. A maker who approved Permit2 last year still owes the
    // relayer an approval on the escrow rung, and nothing may read one grant as the other.
    fakeChain({ [PERMIT2.toLowerCase()]: 10_000n })
    const wallet = fakeWallet()
    expect(await approvePermit2(MAKER, TOKEN, 1_000n)).toBeNull()
    expect(await approveRelayer(MAKER, TOKEN, 1_000n)).toBe(TX)
    expect(wallet.approval().spender.toLowerCase()).toBe(RELAYER.toLowerCase())
  })
})

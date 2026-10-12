import { afterEach, describe, expect, test, vi } from 'vitest'
import { getChainRpc, setChainId } from './config.js'
import { memoryKeyValueStore, setKeyValueStore } from './kv.js'
import { waitForTx } from './settlement.js'

/**
 * A receipt is read from the chain the transaction was sent on, not from the global chain.
 *
 * The app sends on 943, the person switches the global chain to 369, and the wait must still
 * poll 943's endpoint.
 */

const HASH = `0x${'ab'.repeat(32)}` as const

afterEach(() => {
  vi.unstubAllGlobals()
  setChainId(943)
})

describe('waitForTx', () => {
  test("polls the named chain's RPC while the global chain is another", async () => {
    setKeyValueStore(memoryKeyValueStore())
    const want = getChainRpc(943)
    const other = getChainRpc(369)
    expect(want).not.toBe(other)
    setChainId(369)

    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      const body = JSON.parse(String(init?.body))
      const one = (req: { id: number; method: string }) => ({
        jsonrpc: '2.0',
        id: req.id,
        result:
          req.method === 'eth_getTransactionReceipt'
            ? {
                status: '0x1',
                blockNumber: '0x10',
                blockHash: `0x${'cd'.repeat(32)}`,
                transactionHash: HASH,
                transactionIndex: '0x0',
                from: `0x${'11'.repeat(20)}`,
                to: `0x${'22'.repeat(20)}`,
                cumulativeGasUsed: '0x1',
                gasUsed: '0x1',
                effectiveGasPrice: '0x1',
                logs: [],
                logsBloom: `0x${'00'.repeat(256)}`,
                type: '0x2',
                contractAddress: null,
              }
            : req.method === 'eth_blockNumber'
              ? '0x10'
              : req.method === 'eth_chainId'
                ? '0x3af'
                : null,
      })
      const out = Array.isArray(body) ? body.map(one) : one(body)
      return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } })
    })

    await waitForTx(HASH, { chainId: 943 })
    expect(urls.length).toBeGreaterThan(0)
    expect(urls.every((u) => u.startsWith(want))).toBe(true)
  })
})

import { afterEach, describe, expect, test, vi } from 'vitest'
import { rpcClient } from './client.js'
import { rpcHeadersFor, setRpcHeaders } from './config.js'

/**
 * The gateway key travels in a header, never in the URL path (C1 in the solver spec). A bot
 * registers the header for the keyless URL, and every client this package builds on that URL
 * must send it. A client on any other URL must not.
 */

const GATEWAY = 'https://one.valve.city/rpc/evm/943'
const OTHER = 'https://my-node.example/rpc'

/** A fetch that answers `eth_chainId` and remembers what it was sent. */
function stubFetch() {
  const sent: { url: string; headers: Headers }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      sent.push({ url: String(url), headers: new Headers(init?.headers) })
      const { id } = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x3af' }), {
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
  setRpcHeaders(GATEWAY, null)
})

describe('rpcClient', () => {
  test('sends the header a bot registered for its URL', async () => {
    const sent = stubFetch()
    setRpcHeaders(GATEWAY, { 'X-API-Key': 'vk_test_key' })
    await rpcClient(GATEWAY, 943).getChainId()
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe(GATEWAY)
    expect(sent[0].headers.get('x-api-key')).toBe('vk_test_key')
  })

  test('never sends it to another URL', async () => {
    const sent = stubFetch()
    setRpcHeaders(GATEWAY, { 'X-API-Key': 'vk_test_key' })
    await rpcClient(OTHER, 943).getChainId()
    expect(sent[0].headers.get('x-api-key')).toBeNull()
  })

  test('sends nothing extra when nothing is registered, which is the browser', async () => {
    const sent = stubFetch()
    await rpcClient(GATEWAY, 943).getChainId()
    expect(sent[0].headers.get('x-api-key')).toBeNull()
  })
})

describe('setRpcHeaders', () => {
  test('null or an empty object clears the registration', () => {
    setRpcHeaders(GATEWAY, { 'X-API-Key': 'k' })
    setRpcHeaders(GATEWAY, {})
    expect(rpcHeadersFor(GATEWAY)).toBeUndefined()
    setRpcHeaders(GATEWAY, { 'X-API-Key': 'k' })
    setRpcHeaders(GATEWAY, null)
    expect(rpcHeadersFor(GATEWAY)).toBeUndefined()
  })

  test('keeps its own copy, so a caller cannot change it afterwards', () => {
    const h = { 'X-API-Key': 'k' }
    setRpcHeaders(GATEWAY, h)
    h['X-API-Key'] = 'changed'
    expect(rpcHeadersFor(GATEWAY)).toEqual({ 'X-API-Key': 'k' })
  })
})

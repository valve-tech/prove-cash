import { describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import { NETWORKS, venueSubgraph, type XykVenue } from '../config.js'
import { discoverVenue } from './subgraph.js'

/**
 * Discovery against a subgraph that answers from a table, and fails on demand.
 *
 * The rule under test is that a subgraph is never trusted further than it proves itself. Every
 * failure below must come back as a value with a reason. None may throw, and none may return a
 * partial list as if it were whole.
 */

const V943 = NETWORKS[943].xyk[0] as XykVenue
const SOURCE = venueSubgraph(V943, 943)!
const HEAD = 25_461_939n

const tok = (id: string, symbol: string, decimals = 18) => ({ id, symbol, decimals: String(decimals) })
const WPLS = tok('0x70499adebb11efd915e3b69e700c331778628707', 'WPLS')
const tUSDC = tok('0x86390129a2079fb7f0fc889473160a3a449117ab', 'tUSDC', 6)
const tWBTC = tok('0x70c421a8bac4adaa10285a20eff09997a5e09565', 'tWBTC', 8)
type Tok = ReturnType<typeof tok>
const pair = (id: string, t0: Tok, t1: Tok, tracked = '0', pls = '0') => ({
  id,
  token0: t0,
  token1: t1,
  trackedReservePLS: tracked,
  reservePLS: pls,
})
const WPLS_USDC = pair('0xc5cb61b1dbe241616b205804f89a778a5d4ff52d', WPLS, tUSDC, '5555', '5773')
const WBTC_USDC = pair('0x0ef0bc420a40faada94c1390175f2e5bc931957c', tWBTC, tUSDC, '0', '15000')

/** A subgraph that answers every query with this data, or with what `respond` makes of it. */
function stub(
  data: Record<string, unknown> = {},
  over: { meta?: object; factory?: string; respond?: (query: string) => Response | Promise<Response> } = {},
) {
  const queries: string[] = []
  const f = (async (_url: string, init: RequestInit) => {
    const { query } = JSON.parse(String(init.body)) as { query: string }
    queries.push(query)
    if (over.respond) return over.respond(query)
    const out: Record<string, unknown> = {
      _meta: over.meta ?? { block: { number: Number(HEAD) }, hasIndexingErrors: false },
      pulseXFactories: [{ id: over.factory ?? V943.factory }],
      backbone: [WPLS_USDC],
    }
    // Every aliased per-token list the query asked for gets the matching pairs.
    for (const m of query.matchAll(/(\w+): pairs\(first: \d+, where: \{ token(\d): "(0x[0-9a-f]+)" \}/g)) {
      const [, alias, side, token] = m
      out[alias] = [WPLS_USDC, WBTC_USDC].filter(
        (p) => (side === '0' ? p.token0.id : p.token1.id) === token,
      )
    }
    return new Response(JSON.stringify({ data: { ...out, ...data } }), { status: 200 })
  }) as typeof fetch
  return { fetch: f, queries }
}

const opts = (f: typeof fetch, tokens: string[] = [tWBTC.id]) => ({
  head: HEAD,
  tokens: tokens as Address[],
  fetch: f,
})

describe('a subgraph that answers well', () => {
  test('lists the backbone and the pairs of each token of interest, keyed by address', async () => {
    const s = stub()
    const r = await discoverVenue(V943, SOURCE, opts(s.fetch))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.pairs.map((p) => p.address).sort()).toEqual([WBTC_USDC.id, WPLS_USDC.id].sort())
    const wbtc = r.pairs.find((p) => p.address === WBTC_USDC.id)!
    expect(wbtc.token0).toEqual({ address: tWBTC.id, symbol: 'tWBTC', decimals: 8 })
    expect(wbtc.venue).toBe('v1')
    // The rank orders reads. The venue label came from the registry, not from the subgraph.
    expect(r.pairs[0].rank).toBeGreaterThanOrEqual(r.pairs[1].rank)
  })

  test('asks about the counterparts too, so a third hop can reach WPLS', async () => {
    const s = stub()
    // tUSDC is not in the backbone here, so tWBTC's counterpart earns a second request.
    const noSpine = stub({ backbone: [] })
    await discoverVenue(V943, SOURCE, opts(noSpine.fetch))
    expect(noSpine.queries).toHaveLength(2)
    expect(noSpine.queries[1]).toContain(tUSDC.id)
    // With tUSDC already in the backbone, one request is enough.
    await discoverVenue(V943, SOURCE, opts(s.fetch))
    expect(s.queries).toHaveLength(1)
  })

  test('two tokens called DAI stay two tokens', async () => {
    const pDAI = tok('0x6b175474e89094c44da98b954eedeac495271d0f', 'DAI')
    const DAI = tok('0xefd766ccb38eaf1dfd701853bfce31359239f305', 'DAI')
    const s = stub({
      backbone: [
        pair('0x0000000000000000000000000000000000000a01', WPLS, pDAI, '2', '2'),
        pair('0x0000000000000000000000000000000000000a02', WPLS, DAI, '1', '1'),
      ],
    })
    const r = await discoverVenue(V943, SOURCE, opts(s.fetch, []))
    if (!r.ok) throw new Error(r.detail)
    const daiSides = r.pairs.map((p) => p.token1.address)
    expect(new Set(daiSides)).toEqual(new Set([pDAI.id, DAI.id]))
  })

  test('only well-formed addresses reach the query text', async () => {
    const s = stub()
    await discoverVenue(V943, SOURCE, opts(s.fetch, [tWBTC.id, '0x1"}) { id } evil: pairs(first: 1000', 'WPLS']))
    expect(s.queries[0]).not.toContain('evil')
    expect(s.queries[0]).not.toContain('WPLS"')
  })
})

describe('a subgraph that cannot be trusted is not used', () => {
  const cases: [string, ReturnType<typeof stub>, string][] = [
    ['down', stub({}, { respond: () => Promise.reject(new TypeError('fetch failed')) }), 'unreachable'],
    ['HTTP 502', stub({}, { respond: () => new Response('bad gateway', { status: 502 }) }), 'unreachable'],
    ['not JSON', stub({}, { respond: () => new Response('<html>', { status: 200 }) }), 'malformed'],
    [
      'an error beside the data',
      stub({}, {
        respond: () =>
          new Response(
            JSON.stringify({ data: { backbone: [] }, errors: [{ message: 'statement timeout\nselect …' }] }),
          ),
      }),
      'malformed',
    ],
    ['indexing errors', stub({}, { meta: { block: { number: Number(HEAD) }, hasIndexingErrors: true } }), 'indexing-errors'],
    ['stale: far behind the head', stub({}, { meta: { block: { number: Number(HEAD) - 500 }, hasIndexingErrors: false } }), 'stale'],
    ['indexing another factory', stub({}, { factory: '0x1715a3E4A142d8b698131108995174F37aEBA10D' }), 'wrong-factory'],
    ['a damaged pair row', stub({ backbone: [{ id: 'nope' }] }), 'malformed'],
    ['a pair of one token', stub({ backbone: [pair('0x0000000000000000000000000000000000000a03', WPLS, WPLS)] }), 'malformed'],
    ['no _meta', stub({ _meta: null }), 'malformed'],
  ]
  for (const [name, s, reason] of cases) {
    test(`${name}: a failure with reason ${reason}, never a throw`, async () => {
      const r = await discoverVenue(V943, SOURCE, opts(s.fetch))
      expect(r.ok).toBe(false)
      if (r.ok) return
      expect(r.reason).toBe(reason)
      expect(r.detail.length).toBeLessThanOrEqual(200)
    })
  }

  test('a hung subgraph is cut off at the timeout', async () => {
    const hang = (async (_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('timed out', 'TimeoutError'))))) as typeof fetch
    const r = await discoverVenue(V943, SOURCE, { ...opts(hang), timeoutMs: 50 })
    expect(r).toMatchObject({ ok: false, reason: 'unreachable', detail: 'TimeoutError' })
  })

  test('a source recorded for another factory is refused before any request', async () => {
    const s = stub()
    const r = await discoverVenue(V943, { ...SOURCE, factory: '0x0000000000000000000000000000000000000001' }, opts(s.fetch))
    expect(r).toMatchObject({ ok: false, reason: 'wrong-factory', requests: 0 })
    expect(s.queries).toHaveLength(0)
  })
})

describe('the registry names a subgraph for every venue it has', () => {
  test('each venue on each chain, by factory', () => {
    for (const id of [369, 943] as const) {
      for (const v of NETWORKS[id].xyk) {
        expect(venueSubgraph(v, id)?.factory.toLowerCase()).toBe(v.factory.toLowerCase())
      }
    }
  })

  test('a venue override with an unknown factory has none, and is priced the old way', () => {
    expect(venueSubgraph({ ...V943, factory: '0x000000000000000000000000000000000000beef' }, 943)).toBeNull()
  })
})

import { describe, expect, test } from 'vitest'
import { createPublicClient, http, parseAbi, type Address } from 'viem'
import { CHAIN_IDS, network, presetTokens, xykVenue } from '../config.js'
import { MULTICALL3 } from '../multicall.js'
import { PoolGraph } from './graph.js'
import { GraphKeeper, graphOptionsFor } from './graphsync.js'
import { poolAmountOut, type Pool } from './price.js'

/**
 * The pool graph against the chains it runs on: real subgraphs, real reserves, real routers.
 *
 * `graph.test.ts` holds the arithmetic to a recorded fixture. This one asks the live chain: fill
 * a graph the way the bot does, let it find routes by searching, and hold every route to what
 * the router's own `getAmountsOut` says about that exact path. No route is typed in; that is the
 * point. A fixture proves the arithmetic. This proves the arithmetic runs on the pools that are
 * really there.
 *
 * Off by default, because it needs the network:
 *
 *   PROVE_LIVE=1 npx vitest run src/solver/graph.live.test.ts
 *
 * **Same block, or it proves nothing.** The reserves and the router's answer for each route come
 * from ONE `eth_call` to Multicall3, so a swap between two reads cannot make a right answer look
 * wrong, or a wrong one look right.
 *
 * The gateway key goes in a header. `vk_demo` is the public demo key.
 */

const LIVE = !!process.env.PROVE_LIVE

const ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
])
const MC_ABI = parseAbi(['function getBlockNumber() view returns (uint256)'])

describe.skipIf(!LIVE)('the pool graph against the live chains', () => {
  for (const id of CHAIN_IDS) {
    const client = createPublicClient({
      chain: network(id).chain,
      transport: http(`https://one.valve.city/rpc/evm/${id}`, {
        retryCount: 0,
        fetchOptions: { headers: { 'X-API-Key': 'vk_demo' } },
      }),
    })

    test(
      `chain ${id}: every multi-hop route the graph finds is the route the router prices`,
      { timeout: 300_000 },
      async () => {
        const tokens = presetTokens(id)
        const wpls = tokens.find((t) => t.symbol === 'WPLS')!.address as Address
        const graph = new PoolGraph(graphOptionsFor(id))
        const keeper = new GraphKeeper({ chainId: id, client, graph })
        const head = await client.getBlockNumber()
        const report = await keeper.warmUp(head, tokens.map((t) => t.address))
        expect(report.discovery.every((d) => d.ok), JSON.stringify(report.discovery.map((d) => d.ok ? d.venue : d))).toBe(true)
        expect(graph.qualifiedCount).toBeGreaterThan(0)

        // Every registry token into WPLS and out of it, at a size of one whole token.
        const routes: { path: Address[]; pools: Pool[]; venue: string; amountIn: bigint }[] = []
        for (const t of tokens) {
          if (t.address === wpls) continue
          const one = 10n ** BigInt(t.decimals)
          for (const [a, b, amt] of [
            [t.address, wpls, one],
            [wpls, t.address, 10n ** 21n],
          ] as [Address, Address, bigint][]) {
            const q = graph.quote(a, b, amt)
            if (q) routes.push({ path: q.path, pools: q.pools, venue: q.venue, amountIn: amt })
          }
        }
        const multi = routes.filter((r) => r.path.length > 2)
        expect(multi.length, 'the search found at least one multi-hop route').toBeGreaterThan(0)

        if (id === 943) {
          for (const sym of ['tWBTC', 'tWETH']) {
            const t = tokens.find((x) => x.symbol === sym)!.address.toLowerCase()
            const r = routes.find((x) => x.path[0].toLowerCase() === t)
            expect(r, `${sym} reaches WPLS`).toBeDefined()
            expect(r!.path.length, `${sym} has no WPLS pool, so its route is multi-hop`).toBeGreaterThan(2)
          }
        }

        for (const r of routes) {
          const router = xykVenue(r.venue, id)!.router
          // Three ABIs in one call; viem cannot type a mixed list, so the results are read by shape.
          const contracts = [
            { address: MULTICALL3, abi: MC_ABI, functionName: 'getBlockNumber' },
            ...r.pools.map((p) => ({ address: p.address, abi: PAIR_ABI, functionName: 'getReserves' })),
            { address: router, abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [r.amountIn, r.path] },
          ]
          const res = (await client.multicall({
            multicallAddress: MULTICALL3,
            allowFailure: false,
            contracts: contracts as never,
          })) as unknown[]
          const reserves = res.slice(1, 1 + r.pools.length) as unknown as [bigint, bigint, number][]
          const routerAmounts = res[res.length - 1] as unknown as readonly bigint[]
          // Walk the same path on the same block's reserves, locally.
          const amounts = [r.amountIn]
          r.pools.forEach((p, i) => {
            const at: Pool = { ...p, reserve0: reserves[i][0], reserve1: reserves[i][1] }
            amounts.push(poolAmountOut(at, r.path[i], amounts[i])!)
          })
          expect(amounts, `${r.path.join(' > ')} on ${r.venue} at block ${res[0]}`).toEqual([...routerAmounts])
        }
        console.log(
          `chain ${id}: ${graph.size} pools, ${graph.qualifiedCount} qualified; ${routes.length} routes ` +
            `held to getAmountsOut, ${multi.length} of them multi-hop (longest ${Math.max(...routes.map((r) => r.path.length - 1))} hops)`,
        )
      },
    )
  }
})

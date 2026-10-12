import { describe, expect, test } from 'vitest'
import { createPublicClient, http, parseAbi, type Address } from 'viem'
import { CHAIN_IDS, defaultRpc, feeTarget, network, presetTokens, xykVenues } from './config.js'

/**
 * The registry, checked against the chains it claims to describe.
 *
 * Every other test in this package runs offline against a fake chain, which is right: a market
 * layer that only works when the internet does is untestable. But the registry is a set of claims
 * about deployments that exist — this router has code, it deploys from that factory, its pairs
 * keep 29 basis points — and a claim about the chain can only be checked against the chain. The
 * fee especially: it lives in the pair contract, not the router, so two routers of the same brand
 * could charge differently and nothing local would ever notice.
 *
 * Off by default, because it needs the network:
 *
 *   PROVE_LIVE=1 npm test
 *
 * The endpoint rate-limits per method per second, so every read below is serialized on purpose.
 * Do not turn these into a `Promise.all` — the node answers -32005 and the test reads as a
 * registry failure when it is really a traffic failure.
 */

const LIVE = !!process.env.PROVE_LIVE

const ROUTER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
])
const FACTORY_ABI = parseAbi([
  'function getPair(address a, address b) view returns (address)',
  'function feeTo() view returns (address)',
])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
])

const pause = () => new Promise((r) => setTimeout(r, 400))

/** The whole fee denominator range that could possibly reproduce a router's answer. */
function solveFeeNum(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  out: bigint,
  feeDen: bigint,
): bigint[] {
  const fits: bigint[] = []
  for (let n = feeDen - feeDen / 10n; n <= feeDen; n++) {
    const withFee = amountIn * n
    if ((withFee * reserveOut) / (reserveIn * feeDen + withFee) === out) fits.push(n)
  }
  return fits
}

describe.skipIf(!LIVE)('the registry against the live chains', () => {
  for (const id of CHAIN_IDS) {
    const client = createPublicClient({
      chain: network(id).chain,
      transport: http(defaultRpc(id), { retryCount: 0 }),
    })
    const token = (symbol: string) =>
      presetTokens(id).find((t) => t.symbol === symbol)!.address as Address

    for (const venue of xykVenues(id)) {
      test(
        `chain ${id} ${venue.label}: router has code, factory agrees, fee solves to ${venue.feeNum}`,
        { timeout: 120_000 },
        async () => {
          // One block for every read, so the reserves and the router's quote describe the same
          // market. Two reads a block apart can disagree by a swap and the fee looks wrong.
          const blockNumber = await client.getBlockNumber()
          await pause()

          const code = await client.getCode({ address: venue.router, blockNumber })
          expect(code, `${venue.router} has no code on ${id}`).toBeTruthy()
          expect(code).not.toBe('0x')
          await pause()

          const factory = await client.readContract({
            address: venue.router,
            abi: ROUTER_ABI,
            functionName: 'factory',
            blockNumber,
          })
          expect(factory.toLowerCase()).toBe(venue.factory.toLowerCase())
          await pause()

          const [a, b] = [token('WPLS'), token('PLSX')]
          const pair = await client.readContract({
            address: venue.factory,
            abi: FACTORY_ABI,
            functionName: 'getPair',
            args: [a, b],
            blockNumber,
          })
          expect(pair, `${venue.label} lists no WPLS/PLSX pair`).not.toBe(
            '0x0000000000000000000000000000000000000000',
          )
          await pause()

          const token0 = await client.readContract({
            address: pair,
            abi: PAIR_ABI,
            functionName: 'token0',
            blockNumber,
          })
          await pause()
          const [reserve0, reserve1] = await client.readContract({
            address: pair,
            abi: PAIR_ABI,
            functionName: 'getReserves',
            blockNumber,
          })
          await pause()

          const amountIn = 10n ** 18n
          const amounts = await client.readContract({
            address: venue.router,
            abi: ROUTER_ABI,
            functionName: 'getAmountsOut',
            args: [amountIn, [a, b]],
            blockNumber,
          })
          const out = amounts[amounts.length - 1]
          expect(out, 'the pair holds nothing to quote against').toBeGreaterThan(0n)

          const aIsZero = token0.toLowerCase() === a.toLowerCase()
          const [reserveIn, reserveOut] = aIsZero ? [reserve0, reserve1] : [reserve1, reserve0]
          const fits = solveFeeNum(amountIn, reserveIn, reserveOut, out, venue.feeDen)
          // One numerator, and it is the one the registry records. A second fit would mean the
          // reserves are too small to pin the fee down; none means the registry is wrong.
          expect(fits).toEqual([venue.feeNum])
        },
      )
    }
  }

  test('the mainnet routers really are absent from testnet', { timeout: 60_000 }, async () => {
    // The whole reason the registry is per chain. A default router that quietly has no code is
    // what made 943 report "no market" while its pairs traded.
    const client = createPublicClient({
      chain: network(943).chain,
      transport: http(defaultRpc(943), { retryCount: 0 }),
    })
    for (const venue of xykVenues(369)) {
      const code = await client.getCode({ address: venue.router })
      expect(code ?? '0x', `mainnet ${venue.label} unexpectedly has code on 943`).toBe('0x')
      await pause()
    }
  })
})

/**
 * The registry's fee destination, against the factory that owns it.
 *
 * `feeTo` is where this app sends its interface fee, and it is PulseX's own buy-and-burn rather
 * than an address of ours. That makes it somebody else's to move: the factory's `feeToSetter` can
 * repoint it whenever it likes, and nothing local would notice. An intent signed against a stale
 * address pays a contract that no longer collects, and the signature cannot be amended after the
 * fact — so this is the check that has to run against the chain.
 */
describe.skipIf(!LIVE)('the fee destination, against the factory', () => {
  for (const id of CHAIN_IDS) {
    test(`chain ${id} still names the factory's own feeTo`, async () => {
      const venues = xykVenues(id)
      if (venues.length === 0) return
      const client = createPublicClient({
        chain: network(id).chain,
        transport: http(defaultRpc(id)),
      })
      // The first venue is the one a write path picks, and the one the registry comment names.
      const onChain = (await client.readContract({
        address: venues[0].factory,
        abi: FACTORY_ABI,
        functionName: 'feeTo',
      })) as Address

      expect(feeTarget(id).toLowerCase()).toBe(onChain.toLowerCase())
      await pause()
    })
  }
})

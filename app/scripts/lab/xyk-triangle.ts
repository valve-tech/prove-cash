/**
 * A constant-product market the solver can find, price, and build a pool leg out of.
 *
 *   eval "$(app/scripts/lab/up.sh --quiet)" && npx tsx scripts/lab/xyk-triangle.ts
 *
 * The lab had a venue before this and no market. `DeployLabVenue` deploys `MockRouter`, which
 * pays a fixed rate out of its own float: it lets a batch PAY, which is what the fault tolerance
 * and disposal work needed, and it has no factory, no pair and no reserves. `loadPools` finds a
 * pool by asking a factory for a pair and reading `getReserves` off it, so the solver could not
 * see that venue at all. Every plan that needed a priced pool leg was refused, and no ring with a
 * pool in it could exist here.
 *
 * `DeployLabXyk` deploys the other half — a factory, a router and a triangle of tPLSX/tUSDC,
 * tUSDC/tWETH and tWETH/tPLSX — and `up.sh` hands its addresses to the SDK through
 * `setXykVenuesOverride`. This script is the proof that the handover worked, in four steps that
 * each fail differently:
 *
 *   the venue    `confirmVenues` asks the router which factory it deploys from and drops any
 *                answer that is not the recorded one. A wrong factory is not an error, it is
 *                every pair reading as "no pool".
 *   the pools    all three pairs come back through `loadPools`, with reserves.
 *   the price    the curve the SDK reproduces locally is the curve this router walks, to the
 *                wei — checked against `getAmountsOut`, and then against a real swap.
 *   the ring     `solve` builds a three-leg cycle whose closing leg is the pool.
 *
 * The last step is the engine's answer and not a settlement. A plan carrying a pool swap is not
 * atomic — the swap goes in its own transaction after the batch — and who gets paid when a leg
 * goes missing is what `packed-batch.ts` and `three-leg.ts` are for.
 */
import { encodeFunctionData, erc20Abi, formatUnits, parseEther, parseAbi } from 'viem'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  ZERO,
  ZERO_HASH,
  signingDomain,
  type Intent,
  type SignedIntent,
  signIntent,
} from '@prove.cash/sdk'
import {
  buildBook,
  loadPools,
  poolAmountOut,
  poolKey,
  readVenues,
  makeRing,
  solve,
  type BookEntry,
  type Pool,
  xykMarket,
  xykMarkets,
  type MarketLeg,
} from '@prove.cash/sdk/solver'
import {
  CHAIN,
  FEE_RATE,
  FEE_CONFIG,
  XYK,
  derive,
  failureCount,
  head,
  log,
  must,
  pub,
  send,
  token,
  topUpGas,
  topUpToken,
  units,
  walletFor,
  UNPRICED_OK,
} from '../e2e/common.js'

const BATCH_EXECUTOR = (process.env.PROVE_BATCH_EXECUTOR ?? '') as `0x${string}`
if (!BATCH_EXECUTOR) throw new Error('PROVE_BATCH_EXECUTOR is required')
if (!XYK) throw new Error('PROVE_XYK_ROUTER and PROVE_XYK_FACTORY are required: run lab/up.sh')
// Narrowed once, here. `XYK` is an imported binding, so the throw above does not narrow it
// inside the functions below — a local const does, and it is the address every market needs.
const XYK_ROUTER = XYK.router

const A = token('tPLSX')
const B = token('tUSDC')
const C = token('tWETH')
/** The triangle, in the order it closes. */
const SIDES = [
  [A, B],
  [B, C],
  [C, A],
] as const

const ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
])

const chainNow = async () => (await pub.getBlock({ blockTag: 'latest' })).timestamp

// ── The venue ─────────────────────────────────────────────────────────────────

head('the venue the chain confirms')
log(`router  ${XYK.router}`)
log(`factory ${XYK.factory}`)
log(`fee     ${XYK.feeNum}/${XYK.feeDen}`)
const venues = await readVenues({ client: pub as never, chainId: CHAIN })
must(venues.length === 1, `the chain confirms ${venues.length} venue(s)`)
must(
  venues[0]?.router.toLowerCase() === XYK.router.toLowerCase(),
  'and it is the lab market, not the registry entry PulseX has on 943',
)

// ── The pools ─────────────────────────────────────────────────────────────────

head('what loadPools finds')
const pools = await loadPools(
  SIDES.map(([x, y]) => [x.address, y.address] as const),
  { client: pub as never, chainId: CHAIN },
)
must(pools.size === 3, `three pairs, one per side of the triangle — found ${pools.size}`)

const side = (x: typeof A, y: typeof A): Pool => {
  const p = pools.get(poolKey(x.address, y.address))
  if (!p) throw new Error(`no pool for ${x.symbol}/${y.symbol}`)
  return p
}

for (const [x, y] of SIDES) {
  const pool = side(x, y)
  const first = pool.token0.toLowerCase() === x.address.toLowerCase()
  const [rx, ry] = first ? [pool.reserve0, pool.reserve1] : [pool.reserve1, pool.reserve0]
  log(`${x.symbol}/${y.symbol}  ${formatUnits(rx, x.decimals)} ${x.symbol} · ${formatUnits(ry, y.decimals)} ${y.symbol}`)
  must(rx > 0n && ry > 0n, `${x.symbol}/${y.symbol} is priced, not an empty pair`)
  must(pool.venue === 'lab', `and it came from the lab venue, not from the registry's`)
}

// ── The price ─────────────────────────────────────────────────────────────────

/**
 * The solver never asks the router for a quote. It takes a reserve snapshot and reproduces the
 * curve locally in exact integers, so the whole engine stays a pure function of its inputs. That
 * only holds if the local curve IS this router's curve — and the fee is the part that can differ
 * silently, because it lives in the pair and the SDK reads it off the registry entry.
 */
head('the SDK reproduces this router, to the wei')
for (const [x, y] of SIDES) {
  const pool = side(x, y)
  const amountIn = units(x, '1000')
  const mine = poolAmountOut(pool, x.address, amountIn)
  const [, theirs] = await pub.readContract({
    address: XYK.router,
    abi: ROUTER_ABI,
    functionName: 'getAmountsOut',
    args: [amountIn, [x.address, y.address]],
  })
  log(`1000 ${x.symbol} → ${formatUnits(theirs, y.decimals)} ${y.symbol}`)
  must(mine === theirs, `${x.symbol}→${y.symbol}: the curve agrees exactly (${mine} = ${theirs})`)
}

head('and the router fills at that price')
const trader = derive('prove.cash/lab/xyk-trader')
await topUpGas(trader.address, parseEther('1'), 'trader')
const SELL = units(A, '1000')
await topUpToken(A, trader.address, SELL, 'trader')
await send(
  walletFor(trader),
  {
    to: A.address,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [XYK.router, SELL],
    }),
  },
  'trader approved the router',
)
const quoted = poolAmountOut(side(A, B), A.address, SELL)!
const heldBefore = await pub.readContract({
  address: B.address,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [trader.address],
})
await send(
  walletFor(trader),
  {
    to: XYK.router,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      // `amountOutMin` is the SDK's own number. A router that pays a wei less reverts here rather
      // than settling quietly at a price the plan was not built on.
      args: [SELL, quoted, [A.address, B.address], trader.address, (await chainNow()) + 300n],
    }),
  },
  'trader sold 1000 tPLSX',
)
const gained =
  (await pub.readContract({
    address: B.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [trader.address],
  })) - heldBefore
log(`the trader received ${formatUnits(gained, B.decimals)} ${B.symbol}`)
must(gained === quoted, 'the swap paid exactly what the solver priced it at')

// ── The triangle ──────────────────────────────────────────────────────────────

head('the triangle closes, and offers no arbitrage of its own')
// Re-read: the swap above moved the tPLSX/tUSDC pool, and a snapshot from before it is a stale
// bound. Which is the honest reading of any pool snapshot — it is what a router quote is too.
const after = await loadPools(
  SIDES.map(([x, y]) => [x.address, y.address] as const),
  { client: pub as never, chainId: CHAIN },
)

/**
 * The three sides as pool legs, in an order that closes.
 *
 * A leg receives what comes out of the swap and pays what goes in, and `makeRing` wants each
 * leg's `pays` to be the next leg's `receives`. Taking the sides as written — sell tPLSX for
 * tUSDC, then tUSDC for tWETH — chains them the wrong way round and `makeRing` returns null. So
 * the lap runs against the sides: sell tUSDC for tPLSX, tWETH for tUSDC, tPLSX for tWETH.
 */
const ringLegs = (snapshot: ReadonlyMap<string, Pool>): MarketLeg[] =>
  SIDES.map(([x, y]) => ({
    kind: 'market',
    receives: x.address,
    pays: y.address,
    market: xykMarket(
      snapshot.get(poolKey(x.address, y.address))!,
      x.address,
      y.address,
      XYK_ROUTER,
    ),
  }))

must(makeRing(ringLegs(after)) !== null, 'three pool legs close a cycle')

/**
 * What a lap costs, as an exact fraction. `poolRate` gives how much of the input one unit of the
 * output costs, so the ring pays when the three multiply to less than one. Cross-multiplied
 * rather than divided three times, because three divisions throw three remainders away.
 */
const lap = (snapshot: ReadonlyMap<string, Pool>) => {
  const rates = ringLegs(snapshot).map((l) => l.market.rate()!)
  return {
    num: rates.reduce((n, r) => n * r.num, 1n),
    den: rates.reduce((d, r) => d * r.den, 1n),
  }
}

const fresh = lap(pools)
const moved = lap(after)
// On a chain straight out of `up.sh` this reads "exactly", because `DeployLabXyk` sets one price
// all the way round: a lab whose own pools paid for a lap would make every ring the solver found
// the lab's mistake rather than a maker's concession. It is asserted where it belongs, in
// `contracts/test/DeployLabXyk.t.sol`, so a second run against a chain this script has already
// traded on reports the truth here instead of failing.
log(`a lap started this run ${fresh.num === fresh.den ? 'exactly balanced' : 'already out of line'}`)
// The swap above bought tUSDC with tPLSX, so tPLSX is now cheap on that one side and a lap the
// other way pays better than it did. That is what an arbitrage is, and the lab now has real ones
// in it. Cross-multiplied, so two fractions are compared without either being divided out.
must(
  moved.num * fresh.den < fresh.num * moved.den,
  'and the swap left an arbitrage behind: a lap pays better than it did before it',
)

// ── The ring ──────────────────────────────────────────────────────────────────

/**
 * Two makers and a pool. Each maker concedes — Alice sells 1,000 tPLSX for 80 tUSDC where the
 * pool says 100, Bob sells 80 tUSDC for 0.015 tWETH where the pool says 0.02 — and the pool
 * closes the cycle by buying the tWETH Bob is owed with some of Alice's tPLSX. What is left of
 * Alice's tPLSX is the surplus.
 *
 * This is the engine's answer, not a settlement: a plan carrying a pool swap is not atomic, and
 * the swap goes in its own transaction after the batch. `solve` is a pure function, so nothing
 * here is funded or approved — `three-leg.ts` and `packed-batch.ts` are the scripts that settle.
 */
head('a three-leg ring whose closing leg is the pool')
const alice = derive('prove.cash/lab/xyk-alice')
const bob = derive('prove.cash/lab/xyk-bob')

async function offer(
  maker: ReturnType<typeof derive>,
  tokenIn: typeof A,
  tokenOut: typeof A,
  amountIn: bigint,
  minOut: bigint,
): Promise<SignedIntent> {
  const now = await chainNow()
  const intent: Intent = {
    maker: maker.address,
    recipient: maker.address,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn,
    minOutStart: minOut,
    minOutEnd: minOut,
    // A straight line across the whole window: kind 0, and the word it reads none of.
    curve: CURVE_LINEAR,
    startTime: now - 30n,
    endTime: now - 30n + 3600n,
    executor: ZERO,
    feeConfig: FEE_CONFIG,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    feeRate: FEE_RATE,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: FLAG_PARTIAL,
    nonce: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e6)),
  }
  const signature = await signIntent(maker, intent, { domain: signingDomain(CHAIN) })
  return { ...intent, signature }
}

const offers = [
  await offer(alice, A, B, units(A, '1000'), units(B, '80')),
  await offer(bob, B, C, units(B, '80'), units(C, '0.015')),
]
log('alice 1000 tPLSX → ≥ 80 tUSDC       (the pool says 100)')
log('bob      80 tUSDC → ≥ 0.015 tWETH   (the pool says 0.02)')

const entries: BookEntry[] = offers.map((intent, k) => ({
  key: `xyk-${k}`,
  intent,
  remaining: intent.amountIn,
  partial: true,
}))
const plans = solve(buildBook(entries, CHAIN), {
  at: await chainNow(),
  executor: BATCH_EXECUTOR,
  gasPrice: 1_000_000_007n,
  minNetNative: 0n,
  unpricedOk: UNPRICED_OK,
  maxLegs: 3,
  markets: xykMarkets(after, () => XYK_ROUTER),
})

must(plans.length > 0, `the solver found ${plans.length} plan(s)`)
const withPool = plans.find((p) => p.swap !== null)
must(withPool !== undefined, 'and at least one of them closes through the pool')
if (withPool?.swap) {
  const { pays: tokenIn, receives: tokenOut } = withPool.swap.market
  const inT = [A, B, C].find((t) => t.address.toLowerCase() === tokenIn.toLowerCase())!
  const outT = [A, B, C].find((t) => t.address.toLowerCase() === tokenOut.toLowerCase())!
  log(`ring of ${withPool.ring.legs.length} legs, closing through ${inT.symbol}→${outT.symbol}`)
  log(`  sell ${formatUnits(withPool.swap.amountIn, inT.decimals)} ${inT.symbol}`)
  log(`  for at least ${formatUnits(withPool.swap.amountOutMin, outT.decimals)} ${outT.symbol}`)
  must(withPool.ring.legs.length === 3, 'the ring really has three legs')
  must(
    withPool.ring.legs.filter((l) => l.kind === 'market').length === 1,
    'two of them intents, one of them the pool',
  )
  const earned = [A, B, C].find(
    (t) => t.address.toLowerCase() === withPool.profitToken.toLowerCase(),
  )!
  must(
    withPool.profit > 0n,
    `and it earns ${formatUnits(withPool.profit, earned.decimals)} ${earned.symbol}`,
  )
  must(
    withPool.swap.amountOutMin > 0n,
    'with a bound on the swap, so a pool that moves reverts rather than settling at a loss',
  )
}

console.log(failureCount() === 0 ? '\nthe lab has a market.\n' : `\n${failureCount()} failure(s)\n`)
process.exit(failureCount() === 0 ? 0 : 1)

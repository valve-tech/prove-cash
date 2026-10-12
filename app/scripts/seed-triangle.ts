/**
 * Give chain 943 a triangle, so a three-leg ring can exist at all.
 *
 *   DEPLOYER_PK=… npx tsx scripts/seed-triangle.ts          # dry run, sends nothing
 *   DEPLOYER_PK=… npx tsx scripts/seed-triangle.ts --send
 *
 * **What was actually wrong.** The heartbeat is configured with three markets on 943 —
 * tPLSX/tUSDC, tWETH/tUSDC, tWBTC/tUSDC — and only the first one has a pool. A pair the bot
 * cannot price is a pair it quotes nothing on, and nothing says so out loud: measured on
 * 2026-08-31 the live board carried six offers and every one of them was tPLSX against tUSDC.
 * So two thirds of the configured book was dead, and the graph was one edge and its reverse.
 *
 * A three-leg ring needs a directed CYCLE of three tokens. A star centred on tUSDC has none, at
 * any depth. Two pools fix both problems at once: tWETH/tUSDC revives a configured market, and
 * tWETH/tPLSX closes tPLSX → tUSDC → tWETH → tPLSX. tWBTC/tUSDC revives the third.
 *
 * **The ratios are derived, not chosen.** A triangle whose rates do not multiply to one is a
 * standing arbitrage, and seeding one would mean the solver's first finding on this chain is a
 * bug we planted. So the tWETH price against tUSDC is picked, and the tWETH price against tPLSX
 * is COMPUTED from it and the live tPLSX/tUSDC reserves. The product then closes to rounding.
 *
 * Everything is claimed from the tokens' own faucets, which are permissionless behind a cooldown.
 * Nothing here spends from anything but the testnet deployer.
 *
 * Idempotent: a pair that already has reserves is left alone, and a claim on cooldown is skipped.
 */
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { defaultRpc, network, presetTokens, setChainId, setRpc, xykRouter } from '@prove.cash/sdk'
import { fees, assertChainId } from './rpc.ts'

const SEND = process.argv.includes('--send')
const CHAIN = 943
const RPC = process.env.RPC ?? defaultRpc(CHAIN)

setChainId(CHAIN)
setRpc(RPC, CHAIN)

const raw = process.env.DEPLOYER_PK
if (!raw) throw new Error('DEPLOYER_PK is required')
const deployer = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex)

const chain = network(CHAIN).chain
const pub = createPublicClient({ chain, transport: http(RPC) })

// The node has to be on this chain. `RPC` replaces the whole URL while the chain id beside it
// stays put, so the two can silently disagree and every read comes back about somewhere else.
await assertChainId(pub, CHAIN)

const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) })
const ROUTER = xykRouter(CHAIN)

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
])
const FAUCET = parseAbi([
  'function claim() returns (uint256)',
  'function claimAmount() view returns (uint256)',
  'function nextClaimAt(address) view returns (uint64)',
])
const ROUTER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
])
const FACTORY_ABI = parseAbi(['function getPair(address, address) view returns (address)'])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
])

const log = (m: string) => console.log(`  ${m}`)
const head = (m: string) => console.log(`\n${m}`)

const txFees = await fees(pub)
const factory = await pub.readContract({
  address: ROUTER,
  abi: ROUTER_ABI,
  functionName: 'factory',
})

const tok = (symbol: string) => {
  const t = presetTokens(CHAIN).find((p) => p.symbol === symbol)
  if (!t) throw new Error(`no preset token ${symbol} on chain ${CHAIN}`)
  return t
}
const PLSX = tok('tPLSX')
const USDC = tok('tUSDC')
const WETH = tok('tWETH')
const WBTC = tok('tWBTC')

async function send(request: Parameters<typeof wallet.writeContract>[0], what: string) {
  if (!SEND) {
    log(`would ${what}`)
    return
  }
  const hash = await wallet.writeContract({ ...request, ...txFees } as never)
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  log(`${what} · gas ${r.gasUsed} · ${hash}`)
  if (r.status !== 'success') throw new Error(`${what} reverted`)
}

/** The pool for a pair, and its reserves in the order asked for. Zero when there is no pool. */
async function reservesOf(a: Address, b: Address): Promise<[bigint, bigint, Address]> {
  const pair = await pub.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'getPair',
    args: [a, b],
  })
  if (pair === '0x0000000000000000000000000000000000000000') return [0n, 0n, pair]
  const [r0, r1] = await pub.readContract({
    address: pair,
    abi: PAIR_ABI,
    functionName: 'getReserves',
  })
  const t0 = await pub.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' })
  return t0.toLowerCase() === a.toLowerCase() ? [r0, r1, pair] : [r1, r0, pair]
}

// ── The rate every other rate is derived from ────────────────────────────────

head('the pool that already exists')
const [plsxRes, usdcRes] = await reservesOf(PLSX.address, USDC.address)
if (plsxRes === 0n) throw new Error('no tPLSX/tUSDC pool: there is nothing to derive a rate from')
log(`tPLSX/tUSDC  ${formatUnits(plsxRes, PLSX.decimals)} / ${formatUnits(usdcRes, USDC.decimals)}`)

/**
 * How much tPLSX one tUSDC buys, as an exact fraction of the live reserves.
 *
 * A fraction and not a float, because it is about to size a pool: rounding here is a standing
 * arbitrage somebody will take, and the difference between "closes to rounding" and "closes to a
 * tenth of a percent" is the difference between a lab and a bug we planted.
 */
const PLSX_PER_USDC = { num: plsxRes, den: usdcRes }
log(
  `mid  1 tUSDC = ${(Number(plsxRes) / 10 ** PLSX.decimals / (Number(usdcRes) / 10 ** USDC.decimals)).toFixed(6)} tPLSX`,
)

// ── What to seed ─────────────────────────────────────────────────────────────

/**
 * One tWETH is 250 tUSDC here. The number is arbitrary — these are testnet tokens with no
 * outside price — and it only has to be the same number everywhere it appears, which is why
 * every other amount below is derived from it rather than typed again.
 */
const WETH_IN_USDC = 250n
/** And one tWBTC is 10,000 tUSDC. It closes no triangle; it revives a configured market. */
const WBTC_IN_USDC = 10_000n

/** A side of the pool, in whole tWETH. Small: the existing pool is ~405 tUSDC deep. */
const WETH_SIDE = parseUnits('1', WETH.decimals)
const WBTC_SIDE = parseUnits('0.025', WBTC.decimals)

const usdcFor = (weth: bigint, decimals: number, price: bigint) =>
  (weth * price * 10n ** BigInt(USDC.decimals)) / 10n ** BigInt(decimals)

/** The tUSDC each side is worth, and then the tPLSX that same value buys at the live mid. */
const WETH_USDC = usdcFor(WETH_SIDE, WETH.decimals, WETH_IN_USDC)
const WBTC_USDC = usdcFor(WBTC_SIDE, WBTC.decimals, WBTC_IN_USDC)
const WETH_PLSX = (WETH_USDC * PLSX_PER_USDC.num) / PLSX_PER_USDC.den

type Seed = {
  name: string
  a: (typeof PLSX)
  b: (typeof PLSX)
  amountA: bigint
  amountB: bigint
}
const SEEDS: Seed[] = [
  { name: 'tWETH/tUSDC', a: WETH, b: USDC, amountA: WETH_SIDE, amountB: WETH_USDC },
  { name: 'tWETH/tPLSX', a: WETH, b: PLSX, amountA: WETH_SIDE, amountB: WETH_PLSX },
  { name: 'tWBTC/tUSDC', a: WBTC, b: USDC, amountA: WBTC_SIDE, amountB: WBTC_USDC },
]

head('what to seed')
const todo: Seed[] = []
for (const s of SEEDS) {
  const [ra] = await reservesOf(s.a.address, s.b.address)
  if (ra > 0n) {
    log(`${s.name} already has reserves — leaving it alone`)
    continue
  }
  todo.push(s)
  log(
    `${s.name}  ${formatUnits(s.amountA, s.a.decimals)} ${s.a.symbol} / ` +
      `${formatUnits(s.amountB, s.b.decimals)} ${s.b.symbol}`,
  )
}
if (todo.length === 0) {
  head('nothing to do')
  process.exit(0)
}

// ── Claim what is short ──────────────────────────────────────────────────────

head('funding')
const need = new Map<string, bigint>()
for (const s of todo) {
  need.set(s.a.symbol, (need.get(s.a.symbol) ?? 0n) + s.amountA)
  need.set(s.b.symbol, (need.get(s.b.symbol) ?? 0n) + s.amountB)
}

const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
for (const [symbol, want] of need) {
  const t = tok(symbol)
  let held = await pub.readContract({
    address: t.address,
    abi: ERC20,
    functionName: 'balanceOf',
    args: [deployer.address],
  })
  if (held >= want) {
    log(`${symbol}: ${formatUnits(held, t.decimals)} held, ${formatUnits(want, t.decimals)} needed`)
    continue
  }
  const [amount, readyAt] = await Promise.all([
    pub.readContract({ address: t.address, abi: FAUCET, functionName: 'claimAmount' }),
    pub.readContract({
      address: t.address,
      abi: FAUCET,
      functionName: 'nextClaimAt',
      args: [deployer.address],
    }),
  ])
  if (readyAt > now) throw new Error(`${symbol} claim is on cooldown for ${readyAt - now}s`)
  if (held + amount < want) {
    throw new Error(
      `${symbol}: one claim of ${formatUnits(amount, t.decimals)} still leaves us short of ` +
        `${formatUnits(want, t.decimals)} — the cooldown is the limit, so wait or seed smaller`,
    )
  }
  await send(
    { address: t.address, abi: FAUCET, functionName: 'claim', account: deployer, chain },
    `claim ${formatUnits(amount, t.decimals)} ${symbol}`,
  )
  held += amount
}

// ── Approve and add ──────────────────────────────────────────────────────────

head('seeding')
const approved = new Set<string>()
for (const s of todo) {
  for (const [t, amount] of [
    [s.a, s.amountA],
    [s.b, s.amountB],
  ] as const) {
    if (approved.has(t.symbol)) continue
    approved.add(t.symbol)
    const allowance = await pub.readContract({
      address: t.address,
      abi: ERC20,
      functionName: 'allowance',
      args: [deployer.address, ROUTER],
    })
    if (allowance >= amount) continue
    await send(
      {
        address: t.address,
        abi: ERC20,
        functionName: 'approve',
        args: [ROUTER, 2n ** 255n],
        account: deployer,
        chain,
      },
      `approve the router for ${t.symbol}`,
    )
  }

  await send(
    {
      address: ROUTER,
      abi: ROUTER_ABI,
      functionName: 'addLiquidity',
      args: [
        s.a.address,
        s.b.address,
        s.amountA,
        s.amountB,
        // A new pool sets its own price, so both sides land in full and a bound below them only
        // makes the call fail on a rounding wei.
        (s.amountA * 99n) / 100n,
        (s.amountB * 99n) / 100n,
        deployer.address,
        now + 900n,
      ],
      account: deployer,
      chain,
    },
    `seed ${s.name}`,
  )
}

// ── Say whether the triangle closes ──────────────────────────────────────────

head('the triangle')
if (!SEND) {
  log('dry run — re-run with --send, then this reports the product of the three rates')
  process.exit(0)
}
const legs: [string, bigint, bigint][] = []
for (const [x, y] of [
  [PLSX, USDC],
  [USDC, WETH],
  [WETH, PLSX],
] as const) {
  const [rx, ry] = await reservesOf(x.address, y.address)
  legs.push([`${x.symbol}→${y.symbol}`, rx, ry])
  log(`${x.symbol}/${y.symbol}  ${formatUnits(rx, x.decimals)} / ${formatUnits(ry, y.decimals)}`)
}
// The product of the three mid rates. One means a lap round the triangle buys back exactly what
// it sold, which is what "no arbitrage was invented" means as a number.
//
// Raw reserves, not whole units, and the decimals need no correction: the lap returns to the
// token it started from, so every scale factor appears once in a numerator and once in a
// denominator. Converting each leg to whole units first would be three more roundings for the
// same answer.
let product = 1
for (const [, rx, ry] of legs) product *= Number(ry) / Number(rx)
log(`product of the three mid rates: ${product.toFixed(9)} (1.000000000 is arbitrage-free)`)

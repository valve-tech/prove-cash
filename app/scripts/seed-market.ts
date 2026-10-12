/**
 * Give chain 943 a market our own bots can move, and fund the maker that quotes against it.
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK \
 *     npx tsx scripts/seed-market.ts            # dry run, prints the plan and sends nothing
 *
 *   DEPLOYER_PK=… npx tsx scripts/seed-market.ts --send
 *
 * **Why a pool of our own.** The chain has a real xyk market — 5,760 pairs — but the deep ones
 * are useless to us: the WPLS/PLSX pool holds 77 billion WPLS, so a test trade moves the price by
 * nothing at all and there is no market movement to watch. A shallow pool in our own test tokens
 * does move, which is the whole point of putting one there.
 *
 * **Everything here is tiny on purpose.** These are throwaway tokens on a testnet, and the gas is
 * paid from an account nobody is topping up. The pool is small enough that a one-percent trade
 * shows on a chart.
 *
 * **What this is not.** It seeds one demo pair on a testnet so our own charts and bots have
 * something to move. It is not market-making for the fee route. The interface fee lands in the
 * PulseX buy-and-burn as a plain ERC-20, and selling it needs a pool that pair's own holders
 * provide — not us. So do not extend this to seed `<token>/WPLS` pairs, on either chain, however
 * tempting the symmetry looks. A fee that sits unconverted is that contract's problem, and
 * `convertLps` is permissionless for whoever wants to solve it.
 *
 * Idempotent: it checks before every step and skips what is already done, so re-running it after
 * a failure costs one round of reads.
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
import { defaultRpc, network, presetTokens, setChainId, setRpc, settlement, xykRouter } from '@prove.cash/sdk'
import { SETTLEMENT_ABI } from '@prove.cash/sdk/settlement'
import { fees, assertChainId } from './rpc.ts'

const SEND = process.argv.includes('--send')
const CHAIN = 943
// The registry's own endpoint. Never a stranger's public node — this hammers it with reads.
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

/**
 * A 1 gwei tip, and a cap built from the base fee this run sees.
 *
 * Measured on 2026-08-15: the base fee is 7 wei and flat, `eth_gasPrice` answers 500 gwei, and the
 * cheapest tip actually included over twenty blocks is 1 gwei. A 7 wei tip was not mined in three
 * minutes. So the node's suggestion is 500x the real floor, and anything that reads the price from
 * the node overpays by that much. Under EIP-1559 `maxFeePerGas` is a cap and not a payment, so the
 * headroom `feesAt` leaves above the base fee is free.
 *
 * One read: this script seeds a pool, funds a maker and exits, all inside a few blocks.
 */
const txFees = await fees(pub)

const ROUTER = xykRouter(CHAIN)
const SETTLEMENT = settlement(CHAIN)

const token = (symbol: string) => {
  const t = presetTokens(CHAIN).find((p) => p.symbol === symbol)
  if (!t) throw new Error(`no preset token ${symbol} on chain ${CHAIN}`)
  return t
}

const BASE = token('tPLSX')
const QUOTE = token('tUSDC')

/** The pool, and the price it implies: 1 tPLSX = 0.04 tUSDC. */
const POOL_BASE = parseUnits('10000', BASE.decimals)
const POOL_QUOTE = parseUnits('400', QUOTE.decimals)

/** What the market-making maker gets to quote with. */
const MAKER_BASE = parseUnits('4000', BASE.decimals)
const MAKER_QUOTE = parseUnits('160', QUOTE.decimals)
/** Gas for the maker. At a 1 gwei tip an approval is ~0.00005 PLS, so this is thousands of them. */
const MAKER_GAS = parseUnits('20', 18)

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
])
const ROUTER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
])
const FACTORY_ABI = parseAbi([
  'function getPair(address, address) view returns (address)',
])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
])

const log = (m: string) => console.log(`  ${m}`)
const head = (m: string) => console.log(`\n${m}`)
const show = (t: { decimals: number; symbol: string }, v: bigint) =>
  `${Number(formatUnits(v, t.decimals)).toLocaleString('en-US')} ${t.symbol}`

/** Send, and wait. Never trust the transport: this gateway reports failure for work that lands. */
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

// ── Look first ────────────────────────────────────────────────────────────────

head('where things stand')
const factory = await pub.readContract({ address: ROUTER, abi: ROUTER_ABI, functionName: 'factory' })
log(`router  ${ROUTER}`)
log(`factory ${factory}`)
log(`settlement ${SETTLEMENT}`)

const relayer = await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'relayer',
})
log(`relayer ${relayer}  ← the address a maker approves, never the settlement`)

const makerAddress = process.env.HEARTBEAT_ADDRESS as Address | undefined
if (!makerAddress) throw new Error('HEARTBEAT_ADDRESS is required (the heartbeat maker)')
log(`maker   ${makerAddress}`)

const held = async (t: { address: Address }, who: Address) =>
  pub.readContract({ address: t.address, abi: ERC20, functionName: 'balanceOf', args: [who] })

head('balances')
for (const [who, label] of [
  [deployer.address, 'deployer'],
  [makerAddress, 'maker   '],
] as const) {
  const b = await held(BASE, who)
  const q = await held(QUOTE, who)
  const pls = await pub.getBalance({ address: who })
  log(`${label} ${show(BASE, b)} · ${show(QUOTE, q)} · ${formatUnits(pls, 18)} PLS`)
}

// ── The pool ──────────────────────────────────────────────────────────────────

head(`the ${BASE.symbol}/${QUOTE.symbol} pool`)
const existing = await pub.readContract({
  address: factory,
  abi: FACTORY_ABI,
  functionName: 'getPair',
  args: [BASE.address, QUOTE.address],
})

if (existing !== '0x0000000000000000000000000000000000000000') {
  const [r0, r1] = await pub.readContract({ address: existing, abi: PAIR_ABI, functionName: 'getReserves' })
  const t0 = await pub.readContract({ address: existing, abi: PAIR_ABI, functionName: 'token0' })
  const baseFirst = t0.toLowerCase() === BASE.address.toLowerCase()
  log(`already exists at ${existing}`)
  log(`reserves ${show(BASE, baseFirst ? r0 : r1)} · ${show(QUOTE, baseFirst ? r1 : r0)}`)
} else {
  log('none — creating one')
  for (const [t, amount] of [
    [BASE, POOL_BASE],
    [QUOTE, POOL_QUOTE],
  ] as const) {
    const have = await held(t, deployer.address)
    if (have < amount) throw new Error(`deployer holds ${show(t, have)}, needs ${show(t, amount)}`)
    const allowed = await pub.readContract({
      address: t.address, abi: ERC20, functionName: 'allowance', args: [deployer.address, ROUTER],
    })
    if (allowed < amount) {
      await send(
        { address: t.address, abi: ERC20, functionName: 'approve', args: [ROUTER, amount * 4n], account: deployer, chain },
        `approve the router for ${t.symbol}`,
      )
    }
  }
  await send(
    {
      address: ROUTER,
      abi: ROUTER_ABI,
      functionName: 'addLiquidity',
      args: [
        BASE.address, QUOTE.address, POOL_BASE, POOL_QUOTE,
        (POOL_BASE * 99n) / 100n, (POOL_QUOTE * 99n) / 100n,
        deployer.address, BigInt(Math.floor(Date.now() / 1000) + 1800),
      ],
      account: deployer,
      chain,
    },
    `seed the pool with ${show(BASE, POOL_BASE)} and ${show(QUOTE, POOL_QUOTE)}`,
  )
}

// ── Fund the maker ────────────────────────────────────────────────────────────

head('funding the maker')
const gas = await pub.getBalance({ address: makerAddress })
if (gas < MAKER_GAS / 2n) {
  if (!SEND) log(`would send ${formatUnits(MAKER_GAS, 18)} PLS for gas`)
  else {
    const hash = await wallet.sendTransaction({ to: makerAddress, value: MAKER_GAS, ...txFees })
    await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
    log(`sent ${formatUnits(MAKER_GAS, 18)} PLS for gas · ${hash}`)
  }
} else log(`already holds ${formatUnits(gas, 18)} PLS`)

for (const [t, amount] of [
  [BASE, MAKER_BASE],
  [QUOTE, MAKER_QUOTE],
] as const) {
  const have = await held(t, makerAddress)
  if (have >= amount / 2n) {
    log(`already holds ${show(t, have)}`)
    continue
  }
  await send(
    { address: t.address, abi: ERC20, functionName: 'transfer', args: [makerAddress, amount], account: deployer, chain },
    `send ${show(t, amount)} to the maker`,
  )
}

head('what the maker still has to do itself')
log('approve the relayer for each token it sells — it holds the key, so this script cannot.')
log(`  relayer ${relayer}`)
log('run: npx tsx scripts/approve-relayer.ts --send')

if (!SEND) {
  head('dry run — nothing was sent. Re-run with --send.')
}

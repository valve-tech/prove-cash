/**
 * Market mover. Trades the tPLSX/tUSDC pool on chain 943 in tiny amounts so the market has a
 * history — a price that moves, and `Swap` logs for the app's charts to read.
 *
 *   MOVER_KEY=0x… npx tsx scripts/market-mover.ts                  # dry run, sends nothing
 *   MOVER_KEY=0x… npx tsx scripts/market-mover.ts --send --interval 180
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK \
 *     npx tsx scripts/market-mover.ts --fund --send                 # one-time setup
 *
 * **Why this exists.** The pair had zero swaps in its last 50,000 blocks — about six days — when
 * this was written. Every historical layer in the app therefore drew an empty panel: no tape, no
 * traded-size histogram, no traded column. The board had offers and the pool had a price, and
 * nothing had ever happened between them. A market with no trades is not a market to look at.
 *
 * **It mean-reverts rather than walks.** A pure random walk drifts, and a drifting walk either
 * drains one side of the pool or runs the mover out of inventory — in both cases the chart stops
 * a week later for a reason nobody remembers. This one leans against the anchor price: above it,
 * sell; below it, buy; with enough jitter that the result wanders instead of oscillating on a
 * metronome. Inventory falls out of the same rule, because the trade that corrects the price is
 * also the trade that replenishes the side it is short of.
 *
 * **The amounts are deliberately tiny.** A trade is sized to move the price a few tenths of a
 * percent, which on this pool is ten to thirty tPLSX out of ten thousand. Enough to draw a line,
 * far too little to matter.
 *
 * **Gas.** A 1 gwei tip, not the 7 wei base fee. Measured 2026-08-15 and recorded in
 * `seed-market.ts`: the base fee is 7 wei and flat, `eth_gasPrice` answers 500 gwei, and a 7 wei
 * *tip* was not mined in three minutes while 1 gwei lands every block. At 1 gwei a swap costs
 * 0.00012 PLS, so one every three minutes for a year is 21 PLS. The tip is not the cost here.
 *
 * **The bot host never holds the deployer key.** `--fund` runs once from a workstation and moves
 * gas, inventory and approvals to the mover. After that the bot needs `MOVER_KEY` and nothing
 * else, and that key controls a few hundred test tokens.
 *
 * The key is derived, never generated:
 *
 *   keccak256(concat([deployerKey, stringToHex('prove.cash/mover')]))
 *
 * Same scheme as the heartbeat and the e2e roles, and for the same reason: an account nobody can
 * recompute is how 630,000 testnet PLS was stranded.
 */
import './guard'
import {
  concat,
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  keccak256,
  parseAbi,
  parseEther,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { network, presetTokens, setChainId, setRpc, xykRouter } from '@prove.cash/sdk'
import { rpcEndpoint, rpcTransport, registerEndpoint, onSharedKey, fees, describe, assertChainId } from './rpc.ts'

// ── Options ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const opt = (name: string, fallback: number) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback
}

const SEND = flag('send')
const FUND = flag('fund')
const ONCE = flag('once')
const INTERVAL_S = opt('interval', 180)
const CHAIN = 943
const ENDPOINT = registerEndpoint(rpcEndpoint(CHAIN)) // the key rides in a header, not the path
const RPC = ENDPOINT.url

setChainId(CHAIN)
setRpc(RPC, CHAIN)

/**
 * The fee fields a caller hands to one send.
 *
 * See the header. A cap far above the tip costs nothing — it is a ceiling, not a payment. It is a
 * parameter rather than a constant because this bot runs for weeks: `feesAt` builds the cap from
 * the base fee of the moment, and on chain 369 that base fee moves. A cap this process computed
 * on Monday can sit under Friday's base fee, and the node then refuses the send outright.
 */
type Fees = Awaited<ReturnType<typeof fees>>

/**
 * How far one trade moves the price, as a fraction. Selling Δ into a reserve R moves the spot by
 * 1/(1+Δ/R)², so Δ ≈ R·f/2 for a small target f. At f = 0.004 on a 10,000 tPLSX pool that is
 * twenty tPLSX.
 */
const MOVE_MIN = 0.0012
const MOVE_MAX = 0.006

/** Slippage floor on our own trade. We set the size, so anything worse means the pool changed. */
const SLIPPAGE_BPS = 300n

// ── Wiring ────────────────────────────────────────────────────────────────────

const chain = network(CHAIN).chain
const pub = createPublicClient({ chain, transport: rpcTransport(ENDPOINT, { retryCount: 0 }) })

/*
 * Ask the node what chain it is on, before anything reads from it.
 *
 * `RPC` replaces the whole URL and the chain id beside it stays a literal, so the two can point
 * this run at another chain's node. Every read then comes back well-formed and about somewhere
 * else. One round trip settles it, and `assertChainId` says why at length.
 */
await assertChainId(pub, CHAIN)

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
])
const ROUTER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
])
const FACTORY_ABI = parseAbi(['function getPair(address, address) view returns (address)'])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function token0() view returns (address)',
])

const ROUTER = xykRouter(CHAIN)
const token = (symbol: string) => {
  const t = presetTokens(CHAIN).find((p) => p.symbol === symbol)
  if (!t) throw new Error(`no preset token ${symbol} on chain ${CHAIN}`)
  return t
}
const BASE = token('tPLSX')
const QUOTE = token('tUSDC')

/** What the pool was seeded at. The mover leans toward this rather than wherever it drifted. */
const ANCHOR = 0.04

const log = (m: string) => console.log(`${new Date().toISOString()}  ${m}`)
const show = (t: { decimals: number; symbol: string }, v: bigint) =>
  `${Number(formatUnits(v, t.decimals)).toFixed(4)} ${t.symbol}`

/**
 * One read at a time.
 *
 * The registry endpoint rate-limits per method per second, and it counts a `Promise.all` of three
 * `eth_call`s as three in one second. Measured: a parallel fan-out of three `balanceOf` reads gets
 * a -32005 back. Nothing here is hot enough to need the concurrency.
 */
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function serial<T>(reads: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = []
  for (const read of reads) {
    out.push(await read())
    await nap(250)
  }
  return out
}

// ── Accounts ──────────────────────────────────────────────────────────────────

function deriveMover(deployerKey: Hex) {
  return keccak256(concat([deployerKey, stringToHex('prove.cash/mover')]))
}

const deployerRaw = process.env.DEPLOYER_PK
const deployerKey = deployerRaw
  ? ((deployerRaw.startsWith('0x') ? deployerRaw : `0x${deployerRaw}`) as Hex)
  : null
const moverKey = (process.env.MOVER_KEY as Hex | undefined) ??
  (deployerKey ? deriveMover(deployerKey) : null)
if (!moverKey) throw new Error('MOVER_KEY, or DEPLOYER_PK to derive it, is required')

const mover = privateKeyToAccount(moverKey)
const moverWallet = createWalletClient({ account: mover, chain, transport: rpcTransport(ENDPOINT) })

// ── Sending ───────────────────────────────────────────────────────────────────

/**
 * Send, and believe the chain rather than the transport.
 *
 * This gateway reports failure for work that landed, so a thrown error is not evidence of
 * anything. Ask the node whether it has the transaction before deciding.
 */
async function send(
  wallet: typeof moverWallet,
  request: Parameters<typeof moverWallet.writeContract>[0],
  what: string,
  txFees: Fees,
): Promise<boolean> {
  // `what` is a noun phrase, never a verb, because this line prints in two tenses and one string
  // cannot be both. "would send X" and "sent X" needed a conjugation; "would: X" and "X · gas"
  // need none.
  if (!SEND) {
    log(`would: ${what}`)
    return true
  }
  let hash: Hex
  try {
    hash = await wallet.writeContract({ ...request, ...txFees } as never)
  } catch (e) {
    log(`${what} — send failed: ${describe(e)}`)
    return false
  }
  const receipt = await pub
    .waitForTransactionReceipt({ hash, timeout: 120_000 })
    .catch(() => null)
  if (!receipt) {
    log(`${what} — no receipt in 120s · ${hash}`)
    return false
  }
  if (receipt.status !== 'success') {
    log(`${what} — reverted · ${hash}`)
    return false
  }
  log(`${what} · gas ${receipt.gasUsed} · ${hash}`)
  return true
}

// ── The pool ──────────────────────────────────────────────────────────────────

type Pool = { pair: Address; base: bigint; quote: bigint; price: number }

async function readPool(): Promise<Pool | null> {
  const factory = await pub.readContract({
    address: ROUTER,
    abi: ROUTER_ABI,
    functionName: 'factory',
  })
  await nap(250)
  const pair = await pub.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'getPair',
    args: [BASE.address, QUOTE.address],
  })
  if (pair === '0x0000000000000000000000000000000000000000') return null
  await nap(250)
  const reserves = await pub.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves' })
  await nap(250)
  const token0 = await pub.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' })
  const baseIsZero = token0.toLowerCase() === BASE.address.toLowerCase()
  const base = baseIsZero ? reserves[0] : reserves[1]
  const quote = baseIsZero ? reserves[1] : reserves[0]
  const price =
    Number(formatUnits(quote, QUOTE.decimals)) / Number(formatUnits(base, BASE.decimals))
  return { pair, base, quote, price }
}

// ── Choosing a trade ──────────────────────────────────────────────────────────

type Trade = { sellBase: boolean; amountIn: bigint; why: string }

/**
 * Which way to lean, and how hard.
 *
 * Price decides first: above the anchor the mover sells base to push down, below it buys. The
 * jitter is what keeps this from being a metronome — a fifth of the time it takes the other side,
 * so the tape has the small reversals a real one has.
 *
 * Inventory then overrides. Being out of one token is the only hard constraint here, and the trade
 * that fixes it is always available: selling base earns quote, and buying base spends it. So a
 * short side never deadlocks, it just stops being a choice.
 */
function chooseTrade(pool: Pool, heldBase: bigint, heldQuote: bigint): Trade | null {
  const drift = (pool.price - ANCHOR) / ANCHOR
  let sellBase = drift > 0
  let why = drift > 0 ? `${(drift * 100).toFixed(2)}% above anchor` : `${(drift * 100).toFixed(2)}% below anchor`

  // A fifth of the time, lean the other way. Reversals are what make a tape look like a tape.
  if (Math.random() < 0.2) {
    sellBase = !sellBase
    why += ', reversed'
  }

  const move = MOVE_MIN + Math.random() * (MOVE_MAX - MOVE_MIN)
  const half = move / 2

  // Δ ≈ R · f/2. The reserve on the side we are selling into sets the size.
  const wantBase = BigInt(Math.floor(Number(pool.base) * half))
  const wantQuote = BigInt(Math.floor(Number(pool.quote) * half))

  if (sellBase && heldBase < wantBase) {
    sellBase = false
    why = `short ${BASE.symbol}, buying instead`
  } else if (!sellBase && heldQuote < wantQuote) {
    sellBase = true
    why = `short ${QUOTE.symbol}, selling instead`
  }

  const amountIn = sellBase ? wantBase : wantQuote
  const have = sellBase ? heldBase : heldQuote
  if (amountIn === 0n || have < amountIn) return null
  return { sellBase, amountIn, why: `${why} · targeting ${(move * 100).toFixed(2)}%` }
}

// ── One tick ──────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  // One header read per tick. Per transaction would cost a round trip this tick does not need,
  // and once at startup would pin the cap to a base fee that is days old by Friday.
  const txFees = await fees(pub)

  const pool = await readPool()
  if (!pool) {
    log(`no ${BASE.symbol}/${QUOTE.symbol} pair on chain ${CHAIN} — run seed-market.ts first`)
    return
  }

  const [heldBase, heldQuote] = await serial([
    () => pub.readContract({ address: BASE.address, abi: ERC20, functionName: 'balanceOf', args: [mover.address] }),
    () => pub.readContract({ address: QUOTE.address, abi: ERC20, functionName: 'balanceOf', args: [mover.address] }),
  ])

  log(
    `pool ${show(BASE, pool.base)} / ${show(QUOTE, pool.quote)} · price ${pool.price.toFixed(6)} · ` +
      `holding ${show(BASE, heldBase)} ${show(QUOTE, heldQuote)}`,
  )

  const trade = chooseTrade(pool, heldBase, heldQuote)
  if (!trade) {
    log('no trade this tick — out of inventory on both sides')
    return
  }

  const path = trade.sellBase
    ? [BASE.address, QUOTE.address]
    : [QUOTE.address, BASE.address]
  const inToken = trade.sellBase ? BASE : QUOTE
  const outToken = trade.sellBase ? QUOTE : BASE

  const amounts = await pub.readContract({
    address: ROUTER,
    abi: ROUTER_ABI,
    functionName: 'getAmountsOut',
    args: [trade.amountIn, path],
  })
  const expected = amounts[amounts.length - 1]
  const floor = (expected * (10_000n - SLIPPAGE_BPS)) / 10_000n

  log(
    `${trade.sellBase ? 'sell' : 'buy '} ${show(inToken, trade.amountIn)} → ` +
      `${show(outToken, expected)} · ${trade.why}`,
  )

  await send(
    moverWallet,
    {
      address: ROUTER,
      abi: ROUTER_ABI,
      functionName: 'swapExactTokensForTokens',
      args: [
        trade.amountIn,
        floor,
        path,
        mover.address,
        BigInt(Math.floor(Date.now() / 1000) + 600),
      ],
      chain,
      account: mover,
    },
    `${show(inToken, trade.amountIn)} → ${outToken.symbol}`,
    txFees,
  )
}

// ── One-time funding ──────────────────────────────────────────────────────────

/** Gas for thousands of swaps, and inventory for a few hundred trades in one direction. */
const FUND_GAS = parseEther('50')
const FUND_BASE = parseUnits('600', BASE.decimals)
const FUND_QUOTE = parseUnits('24', QUOTE.decimals)

async function fund(): Promise<void> {
  if (!deployerKey) throw new Error('--fund needs DEPLOYER_PK')
  const deployer = privateKeyToAccount(deployerKey)
  const deployerWallet = createWalletClient({ account: deployer, chain, transport: rpcTransport(ENDPOINT) })
  log(`funding ${mover.address} from ${deployer.address}`)

  // `--fund` runs once from a workstation and exits, so one read covers every send below.
  const txFees = await fees(pub)

  const pls = await pub.getBalance({ address: mover.address })
  await nap(250)
  if (pls < FUND_GAS / 2n) {
    if (SEND) {
      const hash = await deployerWallet.sendTransaction({
        to: mover.address,
        value: FUND_GAS - pls,
        ...txFees,
        chain,
        account: deployer,
      })
      await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
      log(`${formatEther(FUND_GAS - pls)} PLS → mover · ${hash}`)
    } else log(`would: ${formatEther(FUND_GAS - pls)} PLS → mover`)
  } else log(`gas already there: ${formatEther(pls)} PLS`)

  for (const [t, need] of [
    [BASE, FUND_BASE],
    [QUOTE, FUND_QUOTE],
  ] as const) {
    await nap(250)
    const have = await pub.readContract({
      address: t.address, abi: ERC20, functionName: 'balanceOf', args: [mover.address],
    })
    if (have >= need) {
      log(`${t.symbol} already there: ${show(t, have)}`)
      continue
    }
    await send(
      deployerWallet,
      {
        address: t.address, abi: ERC20, functionName: 'transfer',
        args: [mover.address, need - have], chain, account: deployer,
      },
      `${show(t, need - have)} → mover`,
      txFees,
    )
  }

  // The mover approves the router, from its own key. Nothing else may spend these.
  for (const t of [BASE, QUOTE]) {
    await nap(250)
    const allowance = await pub.readContract({
      address: t.address, abi: ERC20, functionName: 'allowance', args: [mover.address, ROUTER],
    })
    if (allowance > parseUnits('1000000', t.decimals)) {
      log(`${t.symbol} already approved to the router`)
      continue
    }
    await send(
      moverWallet,
      {
        address: t.address, abi: ERC20, functionName: 'approve',
        args: [ROUTER, 2n ** 255n], chain, account: mover,
      },
      `router approval for ${t.symbol}`,
      txFees,
    )
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

log(`market mover · chain ${CHAIN} · ${SEND ? 'SENDING' : 'dry run, --send to trade'}`)
if (onSharedKey()) log('rpc: on the shared vk_demo key — set VALVE_RPC_KEY, this competes with the website')
log(`mover  ${mover.address}`)
log(`router ${ROUTER}`)

if (FUND) {
  await fund()
} else if (ONCE) {
  await tick()
} else {
  for (;;) {
    await tick().catch((e) => log(`tick failed: ${describe(e)}`))
    // Jitter the wait so the trades do not land on a visible cadence.
    const wait = INTERVAL_S * (0.7 + Math.random() * 0.6)
    await nap(wait * 1000)
  }
}

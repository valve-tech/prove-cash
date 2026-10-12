/**
 * Heartbeat bot. Makes a market on a few pairs and keeps it live on the board, so a visitor lands
 * on a book with depth rather than an empty page. It also proves the whole path on every post:
 * sign → encode → grind → post → read back → verify.
 *
 *   npx tsx scripts/heartbeat.ts --chain 943 --per-side 6 --interval 180
 *   npx tsx scripts/heartbeat.ts --chain 369 --dry-run        # what would it post?
 *
 * Flags:
 *   --allow-js-grind  run without the wasm proof-of-work engine. For a test, and nothing else.
 *                     The JS grind is 7.6x slower on the bot host, which puts the median post past
 *                     the block window the board roots it to. See `pow.ts`.
 *
 * Env:
 *   HEARTBEAT_KEY  a 0x private key. One is generated and printed if you omit it, which means a
 *                  new maker on every restart. Derive a stable one instead, so the identity is
 *                  reproducible and there is no extra secret to keep:
 *
 *                    keccak256(concat([deployerKey, stringToHex('prove.cash/heartbeat')]))
 *
 *                  with `deployerKey` read from `TESTNET_DEPLOYER_PK`.
 *                  That is the same scheme `e2e/common.ts` uses for its throwaway roles, and it
 *                  is why no account here comes from `generatePrivateKey` — an account nobody can
 *                  recompute is how 630,000 testnet PLS was stranded.
 *   RPC            override the board RPC.
 *   POW_WASM       where `pow_grinder_bg.wasm` is, when it is not beside this bundle.
 *   SETTLEMENT     the settlement address, when the registry does not carry it. This bot
 *                  never calls the contract, and the address is still inside every
 *                  signature it makes: EIP-712 puts it in the domain as `verifyingContract`.
 *
 * **A few markets, both sides, real depth.** It used to pick two tokens at random from nine, which
 * spread a handful of intents across seventy-two directions and left every one of them a lone row
 * nobody could trade against. A book needs both sides of the same pair to be worth looking at, and
 * a ring needs them to close at all.
 *
 * **Not everything is fillable, on purpose.** A book where every row pays is not a book, it is a
 * bug somebody is about to harvest. Most of these ask more than the reference price — they rest
 * above the line and wait for the market to come to them. The rest sit through it, and a good
 * share of the resting ones decay across it during their life, which is the one thing this
 * protocol does that an order book cannot.
 *
 * **The maker must hold the tokens and have approved the relayer**, or every one of these is a
 * signature backed by nothing and `fillability` refuses it on the allowance probe. Two scripts do
 * that once: `seed-market.ts` puts a pool on the chain and funds the maker, and
 * `approve-relayer.ts` sets the approval from the maker's own key.
 */
import './guard'
import {
  createPublicClient,
  formatUnits,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  PROVECASH_CATEGORY,
  ZERO,
  ZERO_HASH,
  board,
  decodeIntent,
  readIntent,
  signingDomain,
  encodeIntent,
  grindAndSubmit,
  intentKey,
  isSupportedChain,
  network,
  defaultFees,
  feeDefaultsAddress,
  isBundledFeeConfig,
  withWirePreimage,
  type FeeConfig,
  readFeeDefaults,
  type FeeTerms,
  suggestFeeRate,
  BASIS_POINT,
  presetTokens,
  setChainId,
  setRpc,
  setSettlementOverride,
  settlement,
  verifyIntent,
  xykRouter,
  type ChainId,
  type Intent,
  type PresetToken,
  signIntent,
} from '@prove.cash/sdk'
import { rpcEndpoint, rpcTransport, registerEndpoint, rpcLabel, onSharedKey, describe, assertChainId } from './rpc.ts'
import { assertSettlement } from './deployment.ts'
import { assertFastGrind, grinderLabel, loadStamper } from './pow.ts'
import { botFeeTerms } from './bot-fee.ts'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const chainId = Number(arg('chain', '943')) as ChainId
if (!isSupportedChain(chainId)) throw new Error(`unknown chain ${chainId}`)
/** Intents to keep live on each side of each market. Six a side over three markets is 36 rows. */
const perSide = Number(arg('per-side', '6'))
const intervalMs = Number(arg('interval', '180')) * 1000
/**
 * Sign and verify, and stop before the board.
 *
 * A posted intent is a real signed offer that a stranger may fill, so there has to be a way to
 * see what this bot would put up before it puts it up. One tick with this flag prints the whole
 * book it intends to make, priced against the live pool, and posts none of it.
 */
const dryRun = process.argv.includes('--dry-run')
const endpoint = registerEndpoint(rpcEndpoint(chainId)) // the key rides in a header, not the path

// The SDK resolves the EIP-712 domain and the board endpoint from its own registry.
setChainId(chainId)
setRpc(endpoint.url, chainId)
// This bot never calls the settlement, and it still needs its address. The address sits inside
// the EIP-712 domain as `verifyingContract`, so it is part of every signature this bot makes.
if (process.env.SETTLEMENT) setSettlementOverride(chainId, process.env.SETTLEMENT as Address)

/*
 * Refuse to sign against the zero address.
 *
 * A domain whose `verifyingContract` is zero produces a signature the settlement can never
 * accept: the contract builds its own domain from its own address, recovers a different signer,
 * and reverts. The intents still decode, still verify against the same zero domain that made
 * them, and still look correct on a board — which is exactly what makes this worth a hard stop.
 *
 * It happened. Twelve intents went onto the mainnet board on 2026-08-23 signed this way, because
 * 369 carries a deliberate zero in the registry and this bot did not take the override. Nobody
 * could have filled one of them.
 */
if (settlement(chainId) === ZERO) {
  throw new Error(
    `settlement is the zero address on chain ${chainId}, so every intent signed here would name ` +
      'a contract that does not exist and no executor could ever fill it. Set SETTLEMENT, or add ' +
      'the address to the registry.',
  )
}

// A generated key is fine on a chain whose tokens are free, and never on one whose tokens are
// not. Funding an account nobody can recompute is how 630,000 testnet PLS was stranded, and on
// 369 the same mistake spends real money. Mainnet must be handed a derived key.
if (!process.env.HEARTBEAT_KEY && chainId === 369) {
  throw new Error(
    'HEARTBEAT_KEY is required on mainnet. Derive it: ' +
      "keccak256(concat([deployerKey, stringToHex('prove.cash/heartbeat')])). " +
      'A generated key would be funded and then lost with the process.',
  )
}
const key = (process.env.HEARTBEAT_KEY as Hex) ?? generatePrivateKey()
if (!process.env.HEARTBEAT_KEY) {
  // The key itself never goes to the journal. It used to, on the reasoning that a throwaway is
  // not a secret — but `EnvironmentFile=` fails closed only when the file is ABSENT, so an empty
  // file or a mistyped variable starts the unit and prints a live private key to a log that
  // survives reboots. Six characters and a length identify it to a person and to nobody else.
  console.log(`# no HEARTBEAT_KEY set, using a throwaway key for this run: ${key.slice(0, 8)}… (${key.length} chars)`)
  console.log('# it will not survive a restart, and every intent signed under it is orphaned')
}
const account = privateKeyToAccount(key)

/**
 * The board client grinds with an engine this bot picks, not with the one @msgboard/sdk finds for
 * itself. The SDK's loader resolves the wasm through `node_modules`, which a deployed bundle does
 * not have, and it swallows the failure — so the bot host ground every post in JS for a week and
 * said nothing. See `pow.ts` for the measurements.
 */
const grinder = await loadStamper()
assertFastGrind(grinder, process.argv.includes('--allow-js-grind'))
const msgboard = board(endpoint.url, grinder.stamper)

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (msg: string) => console.log(`${stamp()}  ${msg}`)

// ── The markets ───────────────────────────────────────────────────────────────

/**
 * The pairs this bot quotes, per chain. Both sides of each, so the book has two halves and a ring
 * can close.
 *
 * The symbols differ by chain because the tokens do. 943 quotes the `t` tokens we deployed, since
 * testnet has almost no liquid ERC-20s. 369 quotes what PulseX actually has depth in: WPLS is the
 * base of the exchange, and PLSX and DAI are the two it pairs deepest with. HEX is left out on
 * purpose — its v2 DAI pool holds $317 a side, which is too thin to price against honestly.
 *
 * **Every pair here needs a pool, and a list is not a book.** These three used to be a star
 * centred on tUSDC, and two of the three had no pool at all — so the bot quoted nothing on them
 * and nothing said so. Measured on 2026-08-31 the live 943 board held six offers and every one
 * was tPLSX against tUSDC. `scripts/lab/probe-book.ts` is what says this out loud now.
 *
 * **tWETH/tPLSX is the closing edge, and it is why the list is four.** A three-leg ring needs a
 * directed CYCLE, and a star has none at any depth: every path through tUSDC comes straight back.
 * With this edge the board carries tPLSX → tUSDC → tWETH → tPLSX. `scripts/seed-triangle.ts`
 * seeded the two pools it needed, at rates derived from the tPLSX/tUSDC pool rather than chosen,
 * so the lap multiplies to one and the solver's first finding here is not a bug we planted.
 */
const MARKETS: Record<ChainId, readonly (readonly [string, string])[]> = {
  943: [
    ['tPLSX', 'tUSDC'],
    ['tWETH', 'tUSDC'],
    ['tWBTC', 'tUSDC'],
    ['tWETH', 'tPLSX'],
  ],
  369: [
    ['WPLS', 'PLSX'],
    ['WPLS', 'DAI'],
    ['PLSX', 'DAI'],
  ],
}

/**
 * The most of one token a single intent may offer, in whole units. A chain with no row is
 * uncapped, which is what 943 wants.
 *
 * Without a cap the size is a share of the pool reserve, and on mainnet that share is a fortune.
 * Measured on 2026-08-23: half a percent of the WPLS side of WPLS/PLSX is $2,233, and three
 * percent of it is $10,695. The whole mainnet deployer holds $687. A rule written for a testnet
 * pool somebody seeded with 10,000 tokens does not survive contact with real depth.
 *
 * These are deliberately small. The board exists to prove the path and to give a visitor
 * something real to look at, not to make a market. `--max-in WPLS=150000,DAI=2` overrides them.
 */
const MAX_IN: Record<ChainId, Record<string, string>> = {
  943: {},
  // About $1 an intent at the mid prices of 2026-08-23: WPLS $0.00001368, PLSX $0.00001237,
  // DAI $1. Sized to the float behind it, which is $5 of each token. `sizeFor` spreads sizes over
  // a quarter to all of the cap, so four rows a token average $2.50 and the maker can honour every
  // one of them at once. A cap the float cannot cover puts rows on the board that no executor can
  // fill, and an offer nobody can take is worse than no offer.
  369: { WPLS: '73000', PLSX: '81000', DAI: '1' },
}

const tokens = new Map(presetTokens(chainId).map((t) => [t.symbol, t]))
const configured = (MARKETS[chainId] ?? []).map(([a, b]) => [tokens.get(a), tokens.get(b)] as const).filter(
  (m): m is readonly [PresetToken, PresetToken] => Boolean(m[0] && m[1]),
)
if (configured.length === 0) {
  throw new Error(
    `no markets for chain ${chainId}. Add a row to MARKETS whose symbols exist in the registry.`,
  )
}

/**
 * The per-intent ceiling, in the token's own smallest unit. `--max-in SYM=whole,SYM=whole` wins
 * over the table, so an operator can shrink the book without a deploy.
 */
const maxIn = new Map<string, bigint>()
for (const [sym, whole] of Object.entries(MAX_IN[chainId] ?? {})) {
  const t = tokens.get(sym)
  if (t) maxIn.set(sym, parseUnits(whole, t.decimals))
}
for (const part of arg('max-in', '').split(',').filter(Boolean)) {
  const [sym, whole] = part.split('=')
  const t = tokens.get(sym)
  if (!t) throw new Error(`--max-in names ${sym}, which chain ${chainId} does not have`)
  maxIn.set(sym, parseUnits(whole, t.decimals))
}

const chainClient = createPublicClient({ chain: network(chainId).chain, transport: rpcTransport(endpoint) })

/*
 * Ask the node what chain it is on, before anything reads from it.
 *
 * `RPC` replaces the whole URL and the chain id beside it stays a literal, so the two can point
 * this run at another chain's node. Every read then comes back well-formed and about somewhere
 * else. One round trip settles it, and `assertChainId` says why at length.
 */
await assertChainId(chainClient, chainId)

// Refuse a settlement that hashes intents differently from this SDK. `assertSettlement` says why.
await assertSettlement(chainClient, chainId, settlement(chainId), Boolean(process.env.SETTLEMENT))

const ROUTER = xykRouter(chainId)
const ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
])
const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 r0, uint112 r1, uint32 ts)',
  'function token0() view returns (address)',
])
const FACTORY_ABI = parseAbi(['function getPair(address, address) view returns (address)'])

/**
 * Price against the pool, not against a table.
 *
 * An earlier version carried a hand-written price for every token, because the mainnet router
 * address has no code on 943 and it looked as though testnet had no market. It has one — a
 * different address, 5,760 pairs — so the honest reference is what the pool actually pays for the
 * size being offered, slippage included. A table would also drift the moment the trader bot moved
 * the price, which is the whole thing we want to watch.
 */
/** The router's factory never changes, so it is read once for the whole process. */
let factoryOnce: Promise<Address> | null = null
const routerFactory = () => {
  factoryOnce ??= chainClient.readContract({
    address: ROUTER,
    abi: parseAbi(['function factory() view returns (address)']),
    functionName: 'factory',
  })
  return factoryOnce
}

async function poolFor(a: PresetToken, b: PresetToken): Promise<Address | null> {
  if (ROUTER === ZERO) return null
  const factory = await routerFactory()
  const pair = await chainClient.readContract({
    address: factory,
    abi: FACTORY_ABI,
    functionName: 'getPair',
    args: [a.address, b.address],
  })
  return /^0x0+$/.test(pair) ? null : pair
}

/** What the pool pays for `amountIn`, or null when it cannot answer. */
async function poolPays(tokenIn: PresetToken, tokenOut: PresetToken, amountIn: bigint) {
  try {
    const amounts = (await chainClient.readContract({
      address: ROUTER,
      abi: ROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [amountIn, [tokenIn.address, tokenOut.address]],
    })) as readonly bigint[]
    return amounts[amounts.length - 1]
  } catch {
    return null
  }
}

/**
 * The side's own reserve, so a trade can be sized as a share of the depth that backs it.
 *
 * `token0` is fixed for the life of a pair — a V2 pair sorts its two tokens at creation and never
 * moves them — so it is asked once. Reading it per intent doubled this function's traffic to say
 * the same thing every time.
 */
const token0Cache = new Map<Address, Promise<Address>>()
const token0Of = (pair: Address) => {
  let p = token0Cache.get(pair)
  if (!p) {
    p = chainClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' })
    token0Cache.set(pair, p)
  }
  return p
}

async function reserveOf(pair: Address, token: PresetToken): Promise<bigint> {
  const [[r0, r1], t0] = await Promise.all([
    chainClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves' }),
    token0Of(pair),
  ])
  return t0.toLowerCase() === token.address.toLowerCase() ? r0 : r1
}

/** Only markets with a pool behind them. Without one there is no price to quote against. */
const markets: { a: PresetToken; b: PresetToken; pair: Address }[] = []
for (const [a, b] of configured) {
  const pair = await poolFor(a, b)
  if (pair) markets.push({ a, b, pair })
  else log(`no pool for ${a.symbol}/${b.symbol} — skipping, nothing to price against`)
}
if (markets.length === 0) throw new Error(`no market on chain ${chainId} has a pool`)

/** Directions, both ways round, because a market with one side is a list and not a market. */
const sides = markets.flatMap(({ a, b, pair }) => [
  { tokenIn: a, tokenOut: b, pair },
  { tokenIn: b, tokenOut: a, pair },
])

/**
 * Where the next round starts. It moves, and that is the whole point.
 *
 * **A round is not guaranteed to finish, so the order it stops in decides what exists.** Each
 * post costs a proof of work, and on the bot host that is 25 to 140 seconds — measured
 * 2026-09-01, against a tick every 240. Eight directions at five a side is forty posts, so a
 * round takes about forty minutes and the tick fires ten times inside it. Walking a fixed list
 * from the front means the tail is never reached at all.
 *
 * That is not a slow book, it is an empty one. The fourth market on 943 — tWETH/tPLSX, the edge
 * that closes the only triangle — was appended last and posted zero offers in half an hour while
 * the first three carried thirty. A three-leg ring was impossible for a reason no log mentioned.
 *
 * So the walk starts one direction further along each round. Every side reaches the front within
 * `sides.length` rounds however long the work takes, which turns starvation into latency.
 */
let cursor = 0
const roundRobin = <T>(xs: readonly T[]): readonly T[] => [
  ...xs.slice(cursor % xs.length),
  ...xs.slice(0, cursor % xs.length),
]

// ── Pricing ───────────────────────────────────────────────────────────────────

const rnd = (lo: number, hi: number) => lo + Math.random() * (hi - lo)

/**
 * Where this intent sits against the reference, in basis points, and where it ends up.
 *
 * Positive is above the line: the maker asks more than the reference says the input is worth, so
 * nobody fills it until the market moves or the price decays. Negative is through the line and
 * pays an executor immediately.
 *
 * The mix is deliberate. A third sit through the line so there is always something to fill; the
 * rest rest above it. Of those, most decay, and roughly half of the decaying ones cross the line
 * before they expire — a resting order that becomes fillable on its own, which is the behaviour
 * nothing else on a board has.
 */
function priceBand(): { startBps: number; endBps: number } {
  const roll = Math.random()
  if (roll < 0.33) {
    // Through the line already. Shallow, so the spread an executor keeps is plausible.
    const bps = -rnd(5, 60)
    return { startBps: bps, endBps: bps }
  }
  const startBps = rnd(20, 400)
  if (Math.random() < 0.3) return { startBps, endBps: startBps } // resting, fixed price
  // Decaying. Half of these land through the line by the end; the rest only get closer.
  const endBps = Math.random() < 0.5 ? -rnd(5, 40) : rnd(0, startBps * 0.6)
  return { startBps, endBps }
}

/**
 * A trade sized as a share of the depth behind it.
 *
 * A fraction of the reserve rather than a fixed amount, so every market gets trades that matter
 * to it without any market getting one that empties it. Half a percent to three percent moves the
 * price enough to be worth an executor's attention and little enough that the pool survives.
 */
async function sizeFor(pair: Address, tokenIn: PresetToken): Promise<bigint> {
  const reserve = await reserveOf(pair, tokenIn)
  const share = rnd(0.005, 0.03)
  const byShare = (reserve * BigInt(Math.floor(share * 1e6))) / 1_000_000n
  const cap = maxIn.get(tokenIn.symbol)
  if (cap === undefined || byShare <= cap) return byShare
  // The cap binds, which on mainnet it always does. Spread the sizes across the top of it anyway:
  // a book whose every row shows the same number reads as a bot and prices nothing.
  return (cap * BigInt(Math.floor(rnd(0.25, 1) * 1e6))) / 1_000_000n
}

// ── The rate these intents ask for ────────────────────────────────────────────

/**
 * What this bot asks for when the chain costs what it usually costs.
 *
 * Ten rather than zero, because every intent below names the buy-and-burn as its `feeTo`. On a
 * registered sink with no floor, zero charges nothing, so a rate is how our own volume pays for
 * the burn. With no sink registered the bot signs the default sink and its rate as its terms.
 */
const FEE_TARGET = 10n * BASIS_POINT

/**
 * The widest rate this bot will ever sign. A fifth of the delivery, and its own number.
 *
 * The settlement caps nothing: a rate nobody will pay is an offer nobody fills, and prove.cash
 * earns nothing from a fill either way. So the bound is here, in the client that picks the rate,
 * and it exists to stop a base-fee spike carrying an absurd number into a signature the bot
 * cannot take back.
 */
const FEE_CEILING = 200_000_000_000_000_000n

/**
 * What a block on this chain normally costs, in wei. The rate is a ratio against it.
 *
 * 369 is 843,373 gwei — the figure `fee.ts` measured and reasons from, not a second measurement.
 * 943 runs at a base fee of zero, and `suggestFeeRate` returns the target untouched when the base
 * fee is zero, so the entry there says only that no number applies.
 */
const REFERENCE_BASE_FEE: Record<ChainId, bigint> = {
  369: 843_373n * 1_000_000_000n,
  943: 0n,
}

/**
 * The base fee of the block this tick was priced against. Zero until the first tick reads one,
 * and zero on a chain whose header carries none.
 */
let baseFeePerGas = 0n

/**
 * The timestamp of the block this tick read, the clock every intent is signed against. The
 * settlement compares `startTime` and `endTime` with `block.timestamp`, and the bot host's clock
 * runs up to eight seconds ahead of it.
 */
let chainNow = 0n

/**
 * The rate to sign into the next intent.
 *
 * **The reason `gas-relief` was chosen is gone, and the policy is left alone on purpose.** It
 * used to hold that the executor paid the fee on top of what the maker was owed, so a dearer
 * intent was a slower one to fill and a fee destination earned nothing from a fill that never
 * happened. The fee now comes out of the maker's own number. A solver fills when
 * `proceeds - gross - gas > 0`, and the rate is not in that inequality at all, so the rate no
 * longer moves the fill by one second.
 *
 * What is left is how much of this bot's own trade goes to the burn, and a block's base fee has
 * nothing to say about that. `flat` is the honest reading of it. Choosing between them is the
 * owner's call rather than a consequence of the split, so the default stands and the reason it
 * stood is recorded here as dead.
 *
 * The ceiling is this bot's own. The floor is the named sink's `minRate`, because the settlement
 * refuses a rate under it (`_termsOk`), and the band is widened to reach it if it must.
 */
const feeRateNow = (floor: bigint): bigint =>
  suggestFeeRate({
    target: FEE_TARGET,
    baseFeePerGas,
    referenceBaseFeePerGas: REFERENCE_BASE_FEE[chainId] ?? 0n,
    min: floor,
    max: FEE_CEILING > floor ? FEE_CEILING : floor,
  })

/**
 * The fee terms this tick signs: the chain's fee defaults (`FeeDefaults.current()`, or the
 * registry copy where none is deployed yet), plus this bot's own cut out of its number at the
 * rate it priced against the block (P3, like the app's rate field).
 *
 * The defaults are resolved at signing: no fill reads them. A null — a deployed `FeeDefaults`
 * that answers nothing — skips the tick rather than sign a fee it cannot state.
 */
async function feeTermsNow(): Promise<{ terms: FeeTerms; preimage: FeeConfig } | null> {
  const read = await readFeeDefaults({ client: chainClient as never, chainId }).catch(() => null)
  const def = read ?? (feeDefaultsAddress(chainId) === null ? defaultFees(chainId) : null)
  if (def === null) {
    console.warn('fee: FeeDefaults is deployed but unread; not signing this tick')
    return null
  }
  // With the preimage: `signIntent` cannot sign a non-zero fee config without it (`bot-fee.ts`).
  return botFeeTerms(def, feeRateNow(0n))
}

// ── Signing ───────────────────────────────────────────────────────────────────

/** Payloads we have posted and still consider live, so we can re-post them. */
const mine = new Map<string, { data: Hex; endTime: bigint; dir: string }>()
let consecutiveFailures = 0

/** Scale a pool quote by a distance in basis points, in integers. */
const atBps = (pays: bigint, bps: number): bigint =>
  (pays * BigInt(Math.round((1 + bps / 10_000) * 1e6))) / 1_000_000n

/** A direction, keyed the way the board's own intents key it. */
const dirOf = (a: Address, b: Address) => `${a.toLowerCase()}>${b.toLowerCase()}`

async function signOne(
  tokenIn: PresetToken,
  tokenOut: PresetToken,
  pair: Address,
): Promise<{ data: Hex; label: string } | null> {
  const now = chainNow
  const amountIn = await sizeFor(pair, tokenIn)
  if (amountIn === 0n) return null

  // What the pool pays for exactly this size, slippage included. Everything is priced off that,
  // so the book tracks the market rather than a table somebody has to remember to update.
  const pays = await poolPays(tokenIn, tokenOut, amountIn)
  if (pays === null || pays === 0n) return null

  const fee = await feeTermsNow()
  if (fee === null) return null

  const { startBps, endBps } = priceBand()
  const minOutStart = atBps(pays, startBps)
  const minOutEnd = atBps(pays, Math.min(endBps, startBps))
  if (minOutStart === 0n) return null

  const intent: Intent = {
    maker: account.address,
    recipient: account.address,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn,
    minOutStart,
    // The contract refuses a rising minimum, so never let rounding push the end above the start.
    minOutEnd: minOutEnd > minOutStart ? minOutStart : minOutEnd,
    // A straight line across the whole window: kind 0, and the word it reads none of.
    curve: CURVE_LINEAR,
    startTime: now,
    /*
     * Thirty to sixty minutes. These are bare signatures with no escrow behind them. The
     * settlement stopped bounding that in 2026-09, so the ceiling is this bot's own: a heartbeat
     * proves the path works and has no reason to leave a signature standing past the next tick.
     *
     * The floor is thirty rather than ten because of what a grind costs on the box that runs
     * this: a single vCPU takes thirty to fifty seconds a post, against a 180-second tick. Short
     * windows mean more expiries to replace each tick, and the bot falls behind its own book.
     * Longer windows cost nothing — the maker is not going anywhere.
     */
    endTime: now + BigInt(1800 + Math.floor(Math.random() * 1800)),
    executor: ZERO,
    // The buy-and-burn, through the sink the app names by default, so the board's own liquidity
    // feeds it exactly as a visitor's order would. The rate is read from the block this tick
    // priced against, signed here, and never moves again. See `feeTermsNow`.
    ...fee.terms,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: Math.random() < 0.8 ? FLAG_PARTIAL : 0,
    nonce: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)),
  }

  const signature = await signIntent(account, intent, {
    domain: signingDomain(chainId),
    preimage: fee.preimage,
  })
  // The wire carries the preimage only for a config this build does not ship, as the app's posts do.
  const data = encodeIntent(
    withWirePreimage({ ...intent, signature, feeConfigPreimage: fee.preimage }, (h) =>
      isBundledFeeConfig(h, chainId),
    ),
  )

  const decoded = decodeIntent(data)
  if (!decoded) throw new Error('codec: decode returned null')
  if (!(await verifyIntent(decoded, chainId))) throw new Error('codec: signature did not verify')

  mine.set(intentKey(decoded), {
    data,
    endTime: intent.endTime,
    dir: dirOf(tokenIn.address, tokenOut.address),
  })

  const moves = minOutEnd < minOutStart ? ` \u2192 ${endBps.toFixed(0)}bp` : ''
  const label =
    `${tokenIn.symbol}\u2192${tokenOut.symbol} ` +
    `${Number(formatUnits(amountIn, tokenIn.decimals)).toPrecision(4)} @ ` +
    `${startBps > 0 ? '+' : ''}${startBps.toFixed(0)}bp${moves}`
  return { data, label }
}

async function post(data: Hex, label: string) {
  if (dryRun) {
    log(`would post ${label} \u00b7 ${(data.length - 2) / 2}B`)
    return
  }
  const started = Date.now()
  const { hash, stats, recovered } = await grindAndSubmit(msgboard, PROVECASH_CATEGORY, data)
  log(
    `${label} ${hash.slice(0, 10)}… · ${(data.length - 2) / 2}B · ` +
      `${stats.iterations} iters · ${Date.now() - started}ms` +
      (recovered ? ' · rpc lied, the board has it' : ''),
  )
}

/**
 * Adopt what the board already holds for us, rather than posting over it.
 *
 * The board is the truth about what is live, and this process's memory is not. A restart used to
 * find `mine` empty and grind a whole fresh set — proof of work, board space and traffic spent to
 * duplicate intents that were already standing, and on a single vCPU that is thirty to fifty
 * seconds of CPU per post. The payload is right there in the message, so an intent read back is
 * an intent this bot can keep alive.
 */
async function adoptFromBoard(now: bigint): Promise<{ live: Set<string>; total: number; others: number }> {
  const content = await msgboard.content({ category: PROVECASH_CATEGORY })
  const messages = content[PROVECASH_CATEGORY] ?? []
  const seen = new Set<string>()
  let others = 0
  for (const m of messages) {
    const decoded = await readIntent(m.data, chainId) // decoded, and the signature verified
    if (!decoded) continue
    if (decoded.maker.toLowerCase() !== account.address.toLowerCase()) {
      others++
      continue
    }
    // The board holds an expired message for a while yet. Adopting it would undo the prune in
    // `tick`, and the re-post loop would send an offer nobody can fill.
    if (decoded.endTime <= now) continue
    const k = intentKey(decoded)
    seen.add(k)
    if (!mine.has(k)) {
      mine.set(k, {
        data: m.data,
        endTime: decoded.endTime,
        dir: `${decoded.tokenIn.toLowerCase()}>${decoded.tokenOut.toLowerCase()}`,
      })
    }
  }
  // Anything we remember that the board no longer shows has aged off. It stays in `mine` so the
  // re-post below can put it back; only expiry removes it.
  return { live: seen, total: messages.length, others }
}

async function tick() {
  // Once a tick, not once an intent: thirty-six intents would otherwise cost thirty-six block
  // reads to learn a number that barely moves between them. The same block sets the clock.
  const head = await chainClient.getBlock({ blockTag: 'latest' })
  baseFeePerGas = head.baseFeePerGas ?? 0n
  chainNow = head.timestamp
  const now = chainNow
  for (const [k, v] of mine) if (v.endTime <= now) mine.delete(k)

  const status = await msgboard.status()
  if (!status.enabled) throw new Error('board reports disabled')

  const seen = await adoptFromBoard(now)
  log(
    `board ok · ${seen.total} msgs · ours ${seen.live.size} live · ` +
      `${seen.others} not ours · board holds ${BigInt(status.count)}`,
  )

  // Anything we hold that the board no longer shows has aged off, so it goes back up. The
  // payload is already ground, so this costs a post and no work.
  for (const [k, v] of mine) if (!seen.live.has(k)) await post(v.data, 're-post')

  // Then top each side back up. Counted per side, because a global count would let one direction
  // take every slot and leave the other half of the book empty — and counted from `mine`, which
  // the board has just filled in, so a restart adopts what is standing instead of grinding a
  // duplicate set.
  for (const { tokenIn, tokenOut, pair } of roundRobin(sides)) {
    const dir = dirOf(tokenIn.address, tokenOut.address)
    const held = [...mine.values()].filter((v) => v.dir === dir).length
    for (let n = held; n < perSide; n++) {
      const made = await signOne(tokenIn, tokenOut, pair)
      // A pool that cannot quote this size is a reason to move on, not to fail the tick.
      if (!made) break
      await post(made.data, `post ${made.label} \u00b7`)
    }
  }
  // Advance by one, not by a whole market, so the two halves of a pair do not stay welded to
  // each other's place in the queue.
  cursor = (cursor + 1) % Math.max(sides.length, 1)
}

log(`heartbeat starting · chain ${chainId} (${network(chainId).label}) · maker ${account.address}`)
log(grinderLabel(grinder))
log(
  `rpc ${rpcLabel(chainId)} · ${markets.map((m) => `${m.a.symbol}/${m.b.symbol}`).join(' ')} · ` +
    `${perSide} a side · every ${intervalMs / 1000}s`,
)
// A box left on the shared key says so on every start, rather than quietly taking rate limit
// away from the website and showing up later as a submit that "lied".
if (dryRun) log('dry run: it signs and verifies every intent, and posts none of them')
if (onSharedKey()) log('rpc: on the shared vk_demo key — set VALVE_RPC_KEY, this competes with the website')

for (;;) {
  try {
    await tick()
    consecutiveFailures = 0
  } catch (e) {
    consecutiveFailures++
    log(`FAIL (${consecutiveFailures}) ${describe(e)}`)
    // Loudly, so a supervisor restarts us instead of a silent zombie loop.
    if (consecutiveFailures >= 5) {
      log('five failures in a row — exiting for the supervisor to restart')
      process.exit(1)
    }
  }
  await new Promise((r) => setTimeout(r, intervalMs))
}

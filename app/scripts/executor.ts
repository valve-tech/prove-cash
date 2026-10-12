/**
 * Executor bot. Reads the board, prices every intent against PulseX, and fills the ones that pay.
 * Then it checks the maker actually received the signed rate — that assertion is the point. A
 * unit test proves the code is right; this proves the deployed system is right, continuously.
 *
 *   npx tsx scripts/executor.ts --chain 369 --dry-run --as 0xYourAddress
 *   npx tsx scripts/executor.ts --chain 369 --interval 60
 *   npx tsx scripts/executor.ts --chain 943 --inventory --fund      # one-time setup
 *   npx tsx scripts/executor.ts --chain 943 --inventory --interval 60
 *
 * Env:
 *   EXECUTOR_KEY  a 0x private key with some gas in it. `--inventory` also needs tokens.
 *   DEPLOYER_PK   only for `--fund`, and only from a workstation. It derives EXECUTOR_KEY.
 *   RPC           override the chain RPC.
 *   BOARD_RPC     override the msgboard RPC (defaults to RPC, then to the valve demo endpoint).
 *   SETTLEMENT    override the settlement address, for a fork.
 *   EXECUTOR_CONTRACT  the ProveExecutor to fill through, if not passed as `--executor`.
 *
 * **Two paths, and the default one needs no capital.**
 *
 * `ProveExecutor.fill` releases the maker's token A to the contract, sells it at a venue this bot
 * names, lets the settlement pull the maker's token B back out, and sweeps what is left over to
 * this wallet. Nothing is fronted. If the swap does not cover what the maker signed for, the pull
 * fails and the whole transaction reverts, so a bad trade costs gas and nothing else. This wallet
 * holds no float, grants no allowance, and ends every fill holding only the spread.
 *
 * `--inventory` selects the old path: `ProveSettlement.fill` straight from this wallet, paying
 * token B out of a stock somebody bought first. It is kept because it is a third of the gas. It
 * never sells what it takes in, so a board that leans one way turns the float into a directional
 * position — on mainnet it drifted 365,000 WPLS into 634,249 while PLSX went the other way.
 * Prefer the default.
 *
 * **This comment used to say 943 had no executor to fill through, and that has been false since
 * at least the 2026-09-05 deploy.** `contracts/deployments/943.json` records a `ProveExecutor`,
 * and the 2026-10-01 redeploy put a fresh one at
 * `0x697B30A4e85098943f7DE901DE8475444FD573c0` — 5,209 bytes of code on chain, answering
 * `settlement()` with `0xdb3843eFa19C06cA77e16c082BF33f7D4Dd1b8FC`, which is that record's
 * settlement. The default path works on 943. Nothing had to change here to make it work, which
 * is exactly why nobody noticed the sentence was wrong: no test reads a comment.
 *
 * **The executor address is never in the SDK registry, and never will be.** `sdk/src/config.ts`
 * carries the settlement, because the relayer and everything else is reachable from it. The
 * executor is reachable from nothing, so an operator names the one they trust. The flag defaults
 * to whatever `contracts/deployments/<chain>.json` recorded, which is the deploy's own account of
 * what it put on chain rather than an address anybody typed here.
 *
 * **Gas.** The tip stays at 1 gwei, set here and never estimated. `eth_gasPrice` on 943 answers
 * 500 gwei against a base fee of 7 wei, so an estimate overpays by seventy thousand times. The cap
 * tracks the live base fee: the 20 gwei literal that once stood here rejected every mainnet send,
 * because 369 charges around 710,000 gwei of base fee.
 *
 * **A fill that does not clear its own gas is not sent.** See `GAS_MODEL` and `clears`: the bot
 * prices the spread in the token it pays gas in, and refuses anything that does not beat what the
 * chain will charge to land it. A bot that fills at a loss is worse than one that fills nothing.
 *
 * It refuses to run until it can name a settlement contract for that chain — the registry, or
 * `SETTLEMENT` for an address that is deployed but not yet registered. It never sends a
 * transaction that has not simulated clean. Every piece of protocol logic here — the codec, the
 * quote, the market probe, the call shapes — comes from @prove.cash/sdk, so this bot and the web
 * app can never disagree about what an intent is worth.
 */
import './guard'
import {
  concat,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  keccak256,
  maxUint256,
  parseEther,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  PROVECASH_CATEGORY,
  SETTLEMENT_ABI,
  board,
  readIntent,
  maxFeeRateFor,
  intentKey,
  isSupportedChain,
  quote as quoteFill,
  network,
  quoteAll,
  readAvailable,
  readQuote,
  setChainId,
  setRpc,
  setRpcLinked,
  setSettlementOverride,
  settlement,
  presetTokens,
  tokenInfo,
  wpls,
  xykRouter,
  xykVenue,
  xykVenues,
  type ChainId,
  type Quote,
  type SignedIntent,
} from '@prove.cash/sdk'
import {
  GraphKeeper,
  SOLVER_EXECUTOR_ABI,
  executorFillCall,
  executorRouterSwap,
  graphOptionsFor,
  reconcileWithVenues,
} from '@prove.cash/sdk/solver'
import { loadGraph, saveGraph } from './poolcache.ts'
import {
  SKIPS,
  checkFill,
  inventoryTrusts,
  landedOrThrow,
  revertReason,
  routeLabel,
  trustedInventory,
  type Skip,
} from './fills.ts'
import deployment369 from '../../contracts/deployments/369.json' with { type: 'json' }
import deployment943 from '../../contracts/deployments/943.json' with { type: 'json' }
import { PRIORITY_FEE, feesAt, describe, assertChainId, boardEndpoint, rpcEndpoint, rpcTransport, registerEndpoint } from './rpc.ts'
import { assertSettlement, settlementFault, type Deployment } from './deployment.ts'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const ZERO: Address = '0x0000000000000000000000000000000000000000'

const chainId = Number(arg('chain', '943')) as ChainId
if (!isSupportedChain(chainId)) throw new Error(`unknown chain ${chainId}`)

const intervalMs = Number(arg('interval', '60')) * 1000
/** Only fill when the market pays this much more than the maker asked. */
/** The spread of an offer that asks for nothing. Nothing beats it, so nothing needs to. */
const MAX_SPREAD_BPS = 1_000_000n
const minSpreadBps = BigInt(arg('min-spread', '50'))
/** How far above the measured gas a fill has to pay before it is worth sending. */
const gasMarginBps = BigInt(arg('gas-margin', '2500'))
const dryRun = process.argv.includes('--dry-run')

/**
 * What each chain's deploy put on chain, as the deploy itself recorded it.
 *
 * One entry per record, and no address is typed out here: `contracts/deployments/<chain>.json` is
 * written by the deploy and read by this import, so moving a contract moves the bot with it.
 *
 * Both records are read, and only 369's supplies a default below. That asymmetry is about which
 * fill strategy a running bot uses, not about which record is trustworthy: on 943 the bot has
 * always paid out of its own stock unless somebody named an executor, and inheriting one here
 * would change what a bot on the bot host does the next time it restarts. Both records are still
 * read, because both are needed by the pairing check further down.
 */
const RECORDS: Partial<Record<ChainId, Deployment>> = {
  369: deployment369,
  943: deployment943,
}

/** The record a chain inherits an executor from, where it inherits one at all. */
const DEPLOYED: Partial<Record<ChainId, typeof deployment369>> = { 369: deployment369 }

const address = (where: string, text: string): Address => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new Error(`${where}: ${text} is not an address`)
  return text as Address
}

/**
 * The `ProveExecutor` this bot fills through, or null to pay out of its own stock.
 *
 * An address and not a switch. The contract is unowned and permissionless, and it is also the
 * address that holds the maker's tokens for the length of the transaction, so an operator names
 * the deployment they trust rather than inheriting one.
 */
const EXECUTOR = ((): Address | null => {
  if (process.argv.includes('--inventory')) return null
  const named = arg(
    'executor',
    process.env.EXECUTOR_CONTRACT ?? DEPLOYED[chainId]?.contracts.ProveExecutor ?? '',
  )
  return named ? address('--executor', named) : null
})()

/** Where the executor above came from, for the pairing check to say something useful. */
const EXECUTOR_SOURCE =
  process.argv.includes('--executor')
    ? '--executor'
    : process.env.EXECUTOR_CONTRACT
      ? 'EXECUTOR_CONTRACT'
      : `contracts/deployments/${chainId}.json`

// The SDK resolves endpoints and the settlement address from its own registry, so point that
// registry at this run's chain and endpoints before anything reads from it.
setChainId(chainId)
const chainRpc = rpcEndpoint(chainId)
const boardRpc = boardEndpoint(chainRpc)
setRpcLinked(false, chainId)
setRpc(boardRpc.url, chainId, 'board')
setRpc(chainRpc.url, chainId, 'chain')
for (const e of [boardRpc, chainRpc]) registerEndpoint(e) // the key rides in a header, not the path
if (process.env.SETTLEMENT) setSettlementOverride(chainId, process.env.SETTLEMENT as Address)

const SETTLEMENT = settlement(chainId)
if (SETTLEMENT === ZERO) {
  console.log(`settlement is not deployed on chain ${chainId}. Nothing to execute.`)
  console.log('Add the address to sdk/src/config.ts and run again.')
  process.exit(0)
}

/*
 * The two addresses this bot talks to have to come from the same deploy, and until now they came
 * from two independent places: the settlement from the unit's hand-edited `Environment=`, the
 * executor from a JSON record compiled into this bundle at build time. `settlementFault` holds
 * the rule and says what a mismatch costs.
 */
const RECORD = RECORDS[chainId]
const pairing = RECORD
  ? settlementFault(
      chainId,
      RECORD,
      SETTLEMENT,
      process.env.SETTLEMENT ? "the unit's SETTLEMENT" : 'the registry',
    )
  : null
if (pairing) throw new Error(pairing)

// An executor from somewhere other than the record is an operator's own choice — the contract is
// unowned and permissionless, and holding the maker's tokens for a transaction is exactly the
// thing to name deliberately. It is still an unverified pairing, so say so on every start rather
// than let a silent revert be the first news of it.
if (RECORD && EXECUTOR && EXECUTOR !== RECORD.contracts.ProveExecutor) {
  console.warn(
    `executor ${EXECUTOR} came from ${EXECUTOR_SOURCE}, and the deploy recorded ` +
      `${RECORD.contracts.ProveExecutor}. Nothing here can check that it answers this ` +
      "settlement's callback; a mismatch reverts with no data.",
  )
}

// A key is read or derived, never generated. A previous script in this repo made throwaway keys
// at module scope and stranded 630,000 testnet PLS in addresses nobody can reach.
const deriveExecutor = (deployerKey: Hex) =>
  keccak256(concat([deployerKey, stringToHex('prove.cash/executor')]))

const deployerRaw = process.env.DEPLOYER_PK
const deployerKey = deployerRaw
  ? ((deployerRaw.startsWith('0x') ? deployerRaw : `0x${deployerRaw}`) as Hex)
  : null
const key =
  (process.env.EXECUTOR_KEY as Hex | undefined) ??
  (deployerKey ? deriveExecutor(deployerKey) : undefined)
if (!key && !dryRun) throw new Error('EXECUTOR_KEY, or DEPLOYER_PK to derive it, is required')
const account = key ? privateKeyToAccount(key) : null

/**
 * The address a fill comes from, and the one every simulation runs as.
 *
 * A dry run signs nothing, so it needs an address rather than a key. The zero-inventory path asks
 * nothing of this address — it holds no tokens and grants no allowance, and only receives the
 * spread — so any account that can be paid an ERC-20 answers the question the simulation asks.
 * That is why `--as` exists, and why it is refused on a run that sends.
 */
const simulateAs = arg('as', '')
if (!account && !simulateAs) {
  throw new Error('a keyless dry run needs --as <address>, the account to simulate the fill from')
}
const CALLER: Address = account ? account.address : address('--as', simulateAs)

const chain = network(chainId).chain
const client = createPublicClient({ chain, transport: rpcTransport(chainRpc) })
const wallet = account ? createWalletClient({ account, chain, transport: rpcTransport(chainRpc) }) : null

/**
 * The tokenIns the inventory path may take: this chain's listed tokens, and any named with
 * `--trust-token 0xA,0xB`. See `trustedInventory` for why a fake tokenIn drains the float.
 */
const TRUSTED_IN = trustedInventory(
  presetTokens(chainId),
  arg('trust-token', '')
    .split(',')
    .filter(Boolean)
    .map((a) => address('--trust-token', a)),
)

/**
 * How many unmined transactions of our own it takes before this bot stops sending. One fill is
 * one send, so a second one queued means the first is stuck. See `solver.ts` `STUCK_LIMIT`.
 */
const STUCK_LIMIT = 2

/** This wallet's queued transactions the chain has not mined yet. See `solver.ts` `nonceGap`. */
async function nonceGap(): Promise<number> {
  const [mined, queued] = await Promise.all([
    client.getTransactionCount({ address: CALLER, blockTag: 'latest' }),
    client.getTransactionCount({ address: CALLER, blockTag: 'pending' }),
  ])
  return queued - mined
}

/*
 * Ask the node what chain it is on, before anything reads from it.
 *
 * `RPC` replaces the whole URL and the chain id beside it stays a literal, so the two can point
 * this run at another chain's node. Every read then comes back well-formed and about somewhere
 * else. One round trip settles it, and `assertChainId` says why at length.
 */
await assertChainId(client, chainId)

// Refuse a settlement that hashes intents differently from this SDK. `assertSettlement` says why.
await assertSettlement(client, chainId, SETTLEMENT, Boolean(process.env.SETTLEMENT))

const msgboard = board(boardRpc.url)

/**
 * The base fee of the latest block, and the fee fields every send carries.
 *
 * Read once a pass, not once a transaction: one block header covers every send in the pass, and
 * the cap already leaves four base fees of room for what the fee does while the pass runs. Both
 * numbers are kept, because they answer different questions. The cap is a ceiling nobody charges;
 * the base fee plus the tip is what a fill really pays, and that is what the profit gate compares
 * a spread against.
 */
let baseFee = 0n
let FEES = feesAt(baseFee)
async function refreshFees(): Promise<bigint> {
  const block = await client.getBlock({ blockTag: 'latest' })
  baseFee = block.baseFeePerGas ?? 0n
  FEES = feesAt(baseFee)
  return block.number
}

/**
 * The address every approval names. Read off the settlement, because it is in no config file:
 * the settlement deployed it and holds it as an immutable, so this cannot go stale.
 */
const RELAYER = await client.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'relayer',
})

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (m: string) => console.log(`${stamp()}  ${m}`)

/**
 * A token's decimal place for the log line, or null when the chain will not say.
 *
 * Eighteen was hard-coded here, so the first live fill reported a 5.163524 tUSDC payout as
 * `0.000000000005163524` — the fill was correct and the record of it was not. A log that
 * misstates an amount by a million is worse than one that admits it does not know the unit.
 */
const decimals = new Map<string, number>()
async function decimalsOf(token: Address): Promise<number | null> {
  const k = token.toLowerCase()
  const known = decimals.get(k)
  if (known !== undefined) return known
  const info = await tokenInfo(chainId, token)
  if (!info) return null
  decimals.set(k, info.decimals)
  return info.decimals
}

/** An amount in whole units, or the raw integer plus its token when the unit is unknown. */
const amount = (v: bigint, d: number | null) => (d === null ? `${v} raw` : formatUnits(v, d))

/** A native-token amount, for the gas arithmetic. */
const pls = (v: bigint) => `${formatEther(v)} ${chain.nativeCurrency.symbol}`

// ── The pool graph ────────────────────────────────────────────────────────────

/**
 * A pool graph this bot keeps, so a route may be up to three hops long.
 *
 * It exists for one measured failure. On chain 943 neither tWBTC nor tWETH sits in a pool with
 * WPLS, and `quoteAll` asks each router for two paths only: the direct pair, and one hop through
 * WPLS. So `Quote.wplsNum` came back zero, `spreadInNative` returned null, and this bot logged
 * "nothing prices … against WPLS" and skipped every tWBTC and tWETH intent. The route
 * `tWBTC -> tUSDC -> WPLS` was on chain the whole time.
 *
 * The subgraph says which pairs exist; the chain gives every reserve. See
 * `sdk/src/solver/graphsync.ts`. The graph is a second quoter beside `quoteAll`, never a
 * replacement: the larger answer wins the candidacy, the graph values the spread when the router
 * quote cannot, and `measure` simulates the chosen fill against the chain before anything is
 * sent. That simulation is the last word on freshness. A pool that moved since the graph read it
 * fails there, at no cost but a read.
 *
 * `--no-graph` turns it off and gives back exactly the old behaviour.
 */
const graphOff = process.argv.includes('--no-graph')
const graphOptions = graphOptionsFor(chainId, {
  maxPools: Number(arg('graph-pools', '4000')),
  maxAgeBlocks: Number(arg('graph-age', '1000')),
})
const { graph, from: graphFrom } = loadGraph(chainId, graphOptions)
// A cache written by an older build carries that build's fee. The registry is the authority.
const graphStale = reconcileWithVenues(graph, xykVenues(chainId))
const keeper = new GraphKeeper({ chainId, client, graph, venues: xykVenues(chainId) })
/** The tokens on the board this pass. Discovery asks about them beside the registry's. */
let boardTokens: Address[] = []

/**
 * Bring the graph to `head` and save it. Never throws: a graph that cannot refresh is a graph
 * the pass does not route through, because `keeper.usable` then says no.
 */
async function refreshGraph(head: bigint) {
  if (graphOff) return
  try {
    const r = await keeper.refresh(head, boardTokens)
    for (const d of r.discovery) {
      log(
        d.ok
          ? `pool graph · ${d.venue} subgraph listed ${d.pairs.length} pairs in ${d.ms} ms`
          : `pool graph · ${d.venue} subgraph not used: ${d.reason}, ${d.detail}`,
      )
    }
    if (r.added || r.rejected || r.reread || r.logRefused || r.unreadable) {
      log(
        `pool graph · +${r.added} pools, ${r.rejected} rejected by the chain, ${r.reread} re-read, ` +
          `${r.unreadable} unreadable, ${r.logRefused} log ranges refused, ${r.queued} queued`,
      )
    }
    saveGraph(graph, chainId)
  } catch (e) {
    log(`pool graph refresh failed, quoting without it this pass: ${describe(e)}`)
  }
}

/**
 * A quote and the exact path it was priced on.
 *
 * The path travels with the quote rather than being rebuilt from `route`, because a graph path
 * can be three hops long and no label describes it. Selling along a path other than the one that
 * was priced would bound `amountOutMin` against a curve nobody quoted. `route` is a label for
 * logs, and nothing reads it for a graph quote.
 */
type Priced = Omit<Quote, 'route'> & {
  route: ReturnType<typeof routeLabel>
  path: Address[]
  by: 'router' | 'graph'
}

/** The router quote as a `Priced`: the direct pair, or the hop through WPLS. */
function routerPriced(intent: SignedIntent, quote: Quote): Priced | null {
  if (quote.route === 'direct') return { ...quote, path: [intent.tokenIn, intent.tokenOut], by: 'router' }
  const hop = wpls(chainId)
  return hop ? { ...quote, path: [intent.tokenIn, hop, intent.tokenOut], by: 'router' } : null
}

/**
 * The better of the two quoters for one intent, with its proceeds valued in WPLS.
 *
 * The router quote is the contract a fill runs through, so it stands unless the graph finds more.
 * The graph searches routes the router was never asked about. When the winner carries no WPLS
 * valuation (the tWBTC case), the graph values it: the rate is a real sale of the surplus along
 * a real path, so it already carries its own slippage, and it undervalues rather than overvalues.
 */
function bestQuote(
  intent: SignedIntent,
  take: bigint,
  cost: bigint,
  market: Quote | null,
  head: bigint,
): Priced | null {
  let best = market ? routerPriced(intent, market) : null
  const live = !graphOff && keeper.usable(head)
  if (live) {
    const found = graph.quote(intent.tokenIn, intent.tokenOut, take)
    if (found && (!best || found.out > best.out)) {
      best = {
        out: found.out,
        // Not `wpls` for every longer path: a three-hop graph route may never touch WPLS.
        route: routeLabel(found.path, wpls(chainId)),
        venue: found.venue,
        notionalNative: graph.valueInNative(intent.tokenIn, take),
        wplsNum: 0n,
        wplsDen: 1n,
        path: found.path,
        by: 'graph',
      }
    }
  }
  if (best && best.wplsNum === 0n && live && best.out > cost) {
    const surplus = best.out - cost
    const inNative = graph.valueInNative(intent.tokenOut, surplus)
    if (inNative !== null && inNative > 0n) best = { ...best, wplsNum: inNative, wplsDen: surplus }
  }
  return best
}

const approved = new Set<string>()
let consecutiveFailures = 0
/** Every fill this process has made, since it started. Not a per-pass figure. */
let fills = 0
let checks = 0
/**
 * Why each open intent did not fill this pass, one count per reason. The reasons are `SKIPS` in
 * `fills.ts`.
 *
 * The pass line used to print "N priced above cost" and one gas count, and nothing else. An
 * intent skipped for want of a WPLS valuation, a market below the maker's price, or a chain
 * refusal all vanished from it, so a pass that filled nothing gave no reason. Every exit from
 * the fill loop below now counts under exactly one of these.
 *
 * The two fill paths do not count for themselves. They return the reason, and the loop counts
 * it in one place, so a path cannot leave without one: the type has no `null` to return.
 */
const skipped = new Map<Skip, number>()
const skip = (why: Skip) => skipped.set(why, (skipped.get(why) ?? 0) + 1)

// ── What a fill costs, and what it has to pay ─────────────────────────────────

/**
 * The cheapest a fill on each path has ever been. A filter, and nothing more.
 *
 * Every fill is measured against the chain before it is sent, so this number only decides which
 * intents are worth a round trip. It is therefore deliberately optimistic: too low costs a
 * simulation that comes to nothing, too high refuses a fill the chain would have priced cheaper
 * than the model guessed.
 *
 * The inventory figure is the median of fourteen fills this bot really sent on 369 — 138,560 to
 * 333,212 gas, median 271,176. Nothing in `Gas.t.sol` predicts it: that bench says 33,410 for a
 * warm allowance fill, measured against mocks with every slot already touched. The cold path is
 * the difference — 2,100 a cold SLOAD, 2,600 a cold account, 20,000 wherever a token balance
 * leaves zero.
 *
 * The zero-inventory figure comes from `eth_estimateGas` on live 369, against intents that were
 * really on the board on 2026-08-24: 532,819 gas for WPLS→DAI, 880,650 for PLSX→WPLS, and
 * 1,092,228 for DAI→PLSX. Twice the gas for the same code, and the difference is the token rather
 * than the path — PLSX writes a governance checkpoint on every transfer and this path moves it
 * four times. No single constant serves that range, which is why `zeroInventoryFill` measures
 * each intent and prices it on its own number. This one is the cheapest of them, rounded down.
 *
 * `contracts/test/Live369.t.sol` explains where the premium goes: the same intent costs 76,713
 * gas through `ProveSettlement.fill` and 277,453 through `ProveExecutor.fill` against live PulseX
 * liquidity. The 200,740 difference buys the executor hop, the PulseX swap, one allowance write,
 * and the sweeps that carry the spread home.
 */
const GAS_MODEL = { inventory: 271_176n, credit: 500_000n }

/** The cheapest this pass could hope a fill would be, before the chain has measured one. */
const modelGas = () => (EXECUTOR ? GAS_MODEL.credit : GAS_MODEL.inventory)

/**
 * What a fill must earn, in the native token, to be worth sending at `gas`.
 *
 * The margin is the whole reason this is not a plain comparison. The base fee on 369 can rise by
 * half between the simulation and the block, and a fill priced at exactly its gas is a fill that
 * loses money whenever it waits.
 */
const gasFloor = (gas: bigint) =>
  (gas * (baseFee + PRIORITY_FEE) * (10_000n + gasMarginBps)) / 10_000n

/**
 * The same amount, in an intent's token B, so it can go into an `amountOutMin`.
 *
 * `quote.wplsNum` is zero when nothing on the board could price this token against WPLS. That is
 * not a small spread, it is no answer at all, and a bot that cannot value its own profit in the
 * token it pays gas in has no business filling.
 */
const inTokenOut = (native: bigint, q: Pick<Quote, 'wplsNum' | 'wplsDen'>): bigint | null =>
  q.wplsNum === 0n ? null : (native * q.wplsDen) / q.wplsNum

/** The spread this fill would earn, valued in the native token. Null when nothing can value it. */
const spreadInNative = (surplus: bigint, q: Pick<Quote, 'wplsNum' | 'wplsDen'>): bigint | null =>
  q.wplsNum === 0n ? null : (surplus * q.wplsNum) / q.wplsDen

/**
 * Whether a fill that burns `gas` is worth sending for `earns`, and a line saying so when it is
 * not. It does not count the skip: its caller returns `gas`, and `tick` counts it once, so no
 * exit from a fill path can count twice or not at all.
 *
 * This is the whole profitability gate, and it is in the native token rather than in basis
 * points on purpose. A basis-point floor prices a spread against the trade; gas is charged
 * against the chain, so the two only agree at one notional, and only until the base fee moves.
 *
 * The arithmetic, measured on 369 on 2026-08-24 at 826,000 gwei of base fee. A zero-inventory
 * fill costs 440 PLS selling WPLS for DAI and 902 PLS selling DAI for PLSX, which at $0.00001368
 * a PLS is $0.0060 and $0.0123. Fifty basis points earns that back only above $1.20 and $2.47 of
 * notional, and the median intent on this board is $0.60 — where the same fill has to pay 100 to
 * 206 basis points before it breaks even. So the 50bps default, and the 10bps the mainnet unit
 * passes, are both far under water on this path. Neither can be corrected once and left alone:
 * the answer moves with the base fee, with the token, and with the size of the intent. Only the
 * comparison below survives that.
 */
function clears(earns: bigint, gas: bigint): boolean {
  const need = gasFloor(gas)
  if (earns >= need) return true
  log(`  skipped · ${gas} gas eats it: earns ${pls(earns)}, needs ${pls(need)}`)
  return false
}

/**
 * The relayer, not the settlement.
 *
 * `ProveSettlement` holds no allowance from anyone. It calls out to addresses it did not choose,
 * so it is never a spender; `ProveRelayer` pulls on its behalf and can do nothing else. Approving
 * the settlement here would cost a transaction and leave every fill reverting.
 *
 * The zero-inventory path never calls this. The executor contract holds the released tokens and
 * approves the relayer itself, for the exact amount, inside the fill.
 */
async function ensureApproval(token: Address) {
  const k = token.toLowerCase()
  if (approved.has(k)) return
  if (!wallet) throw new Error('an approval needs a key')
  const allowance = await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [CALLER, RELAYER],
  })
  if (allowance < maxUint256 / 2n) {
    const hash = await wallet.writeContract({
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [RELAYER, maxUint256],
      ...FEES,
    })
    landedOrThrow(await client.waitForTransactionReceipt({ hash }), `approving ${token}`, hash)
    log(`approved the relayer for ${token}`)
  }
  approved.add(k)
}

/** The router behind the venue that won the quote. Never "the chain's router": it has two. */
const routerOf = (quote: Pick<Quote, 'venue'>): Address =>
  xykVenue(quote.venue, chainId)?.router ?? xykRouter(chainId)

const balanceAt = (token: Address, holder: Address, blockNumber: bigint): Promise<bigint> =>
  client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder], blockNumber })

/**
 * Price the debt at the timestamp of the block the fill LANDED in, not at the start of the pass.
 * The settlement reads `block.timestamp`, and on a Dutch intent the rate falls, so the pass-start
 * figure asks for more than the maker is actually owed. Computed the old way this alarm fired on
 * a correct fill, and because it exits, systemd restarted the bot into the same fill: nine
 * restarts on 2026-08-28 UTC, from a shortfall of 0.2 bps that was really decay.
 *
 * `delivered`, not the gross. The fee comes out of the signed number, so a maker who was paid
 * exactly what the contract owes them holds LESS than the offer asked for. Alarming on the gross
 * would fire on every correct fill of every fee-charging intent.
 */
async function owedAt(intent: SignedIntent, take: bigint, blockNumber: bigint): Promise<bigint> {
  return quoteFill(intent, take, (await client.getBlock({ blockNumber })).timestamp).delivered
}

async function tick() {
  const head = await refreshFees()

  const content = await msgboard.content({ category: PROVECASH_CATEGORY })
  const messages = content[PROVECASH_CATEGORY] ?? []
  const seen = new Map<string, SignedIntent>()

  for (const m of messages) {
    // Null for a payload that does not decode or a signature that is not the maker's.
    const decoded = await readIntent(m.data, chainId)
    if (!decoded) continue
    seen.set(intentKey(decoded), decoded)
  }

  // The board's tokens, so discovery asks about a token the moment an intent names it.
  boardTokens = [...new Set([...seen.values()].flatMap((i) => [i.tokenIn, i.tokenOut]))]
  await refreshGraph(head)

  // The chain's clock, never this machine's. The settlement prices at `block.timestamp`, and the
  // bot host runs up to eight seconds ahead of it.
  const now = (await client.getBlock({ blockTag: 'latest' })).timestamp
  let candidates = 0
  skipped.clear()
  const filledBefore = fills

  /**
   * What is left of each intent, before anything is priced.
   *
   * Availability first, and the quote second, because an intent is worth what the market pays
   * for what is left of it. Quoting the whole `amountIn` overstates the proceeds of every intent
   * somebody has already taken a bite out of, and the gate below is only as good as its inputs.
   */
  const open: { key: string; intent: SignedIntent; take: bigint }[] = []
  for (const [key, intent] of seen) {
    checks++
    const { remaining, live } = await readAvailable(intent, { client, chainId })
    if (!live || remaining === 0n) continue
    open.push({ key, intent, take: remaining })
  }

  // One multicall prices the whole board, direct pair and the hop through WPLS alike.
  const market = await quoteAll(
    open.map(({ key, intent, take }) => ({
      key,
      tokenIn: intent.tokenIn,
      tokenOut: intent.tokenOut,
      amountIn: take,
    })),
  )

  for (const { key, intent, take } of open) {
    // `gross` is this bot's whole outlay in tokenOut. The chain splits it — `delivered` to the
    // maker, `fee` to the destination the intent named — and the split costs the filler nothing
    // either way, which is why the rate no longer enters the sizing below.
    const { gross } = await readQuote(intent, take, now, { client, chainId })

    const cost = gross
    // Two quoters, and `bestQuote` holds the rule between them. Neither is a promise: `measure`
    // simulates the chosen fill against the chain before a transaction leaves.
    const quote = bestQuote(intent, take, cost, market.get(key) ?? null, head)
    if (!quote) {
      skip('no-quote')
      continue
    }

    if (quote.out <= cost) {
      skip('below-cost')
      continue
    }
    const surplus = quote.out - cost
    // `_termsOk` never requires `minOutStart > 0`, so a legal intent can owe nothing and `cost`
    // is zero. Dividing by it threw, the throw escaped `tick()`, five passes exited the process,
    // and `Restart=always` walked straight back into the same intent — a permanent outage from
    // one board post, by an attacker holding no tokens. An offer that asks for nothing is the
    // best spread there is, not an error.
    const spreadBps = cost === 0n ? MAX_SPREAD_BPS : (surplus * 10_000n) / cost
    candidates++
    if (spreadBps < minSpreadBps) {
      skip('thin-spread')
      continue
    }

    /*
     * An intent may name the one address allowed to fill it, and on this path that address is
     * the contract. `fillWithCallback` passes its own `msg.sender` to the fillability check, and
     * that is `ProveExecutor` rather than this wallet, so an intent written for this bot's EOA is
     * one the contract can never fill. Skipping it here saves a simulation that would only come
     * back `WrongExecutor`.
     */
    const filler = EXECUTOR ?? CALLER
    if (intent.executor !== ZERO && intent.executor.toLowerCase() !== filler.toLowerCase()) {
      skip('executor')
      continue
    }

    // The inventory path keeps tokenIn and never sells it, so it takes only a token somebody
    // listed. The zero-inventory path sells tokenIn in the same transaction and needs no list.
    if (!EXECUTOR && !inventoryTrusts(intent.tokenIn, TRUSTED_IN)) {
      skip('untrusted')
      continue
    }

    // The bar this fill has to clear, in the token gas is paid in.
    const earns = spreadInNative(surplus, quote)
    if (earns === null) {
      skip('unvalued')
      log(`skipping ${key.slice(0, 10)}… · nothing prices ${intent.tokenOut} against WPLS`)
      continue
    }
    const hoped = gasFloor(modelGas())
    if (earns < hoped) {
      skip('model-gas')
      log(
        `under gas ${intent.tokenIn.slice(0, 8)}→${intent.tokenOut.slice(0, 8)} ` +
          `spread=${spreadBps}bps earns=${pls(earns)}, the cheapest fill needs ${pls(hoped)}`,
      )
      continue
    }

    log(
      `fillable ${intent.tokenIn.slice(0, 8)}→${intent.tokenOut.slice(0, 8)} ` +
        `take=${take} owed=${cost} market=${quote.out} spread=${spreadBps}bps ` +
        `earns=${pls(earns)} · ${quote.path.length - 1} hop${quote.path.length > 2 ? 's' : ''} at ${quote.venue} ` +
        `by ${quote.by}`,
    )
    // A dry run cannot rehearse the inventory path. That one grants an allowance before the
    // chain will simulate a fill, and granting one is a transaction. The zero-inventory path
    // asks this wallet for nothing, so it rehearses all the way down to the calldata.
    if (dryRun && !EXECUTOR) {
      skip('dry-run')
      continue
    }

    // Name the rate we agreed to. This intent signs its own `feeRate` and nothing on chain can
    // raise it, so the bound comes out of the intent and costs no read at all.
    const maxFeeRate = maxFeeRateFor([intent])

    // Each path measures itself against the chain and refuses what the gas eats. A string is
    // the reason it did not send, and it has already logged the detail. Counted here, once.
    const attempt = EXECUTOR
      ? await zeroInventoryFill(intent, take, cost, earns, maxFeeRate, quote, now)
      : await inventoryFill(intent, take, earns, maxFeeRate)
    if (typeof attempt === 'string') {
      skip(attempt)
      continue
    }
    if (dryRun) {
      skip('dry-run')
      log(`  would send · ${attempt.gas} gas, costing ${pls(attempt.gas * (baseFee + PRIORITY_FEE))}`)
      continue
    }

    // A queue behind a stuck nonce never drains, and every send only adds to it. Stop here and
    // say so, as the solver does. `unjam.ts` replaces the blocker.
    const stuck = await nonceGap()
    if (stuck >= STUCK_LIMIT) {
      log(`STUCK ${stuck} transactions are queued behind one the chain will not take. Not sending.`)
      return
    }

    // The relayer pulls the delivery from the filler, so the filler is the `from` of this fill's
    // Transfers. `checkFill` counts no other.
    const paid = { token: intent.tokenOut, recipient: intent.recipient, payer: filler }
    const hash = await attempt.send()
    const receipt = await client.waitForTransactionReceipt({ hash })
    // The assertion this bot exists for: status first (C6), then this receipt's own Transfers.
    const result = await checkFill(receipt, paid, {
      balanceAt: (blockNumber) => balanceAt(intent.tokenOut, intent.recipient, blockNumber),
      owedAt: (blockNumber) => owedAt(intent, take, blockNumber),
    })
    if (result.kind === 'short-changed') {
      log(`ALERT the maker was short-changed: received ${result.received} (by ${result.method}), owed ${result.owed}, tx ${hash}`)
      process.exit(2)
    }
    if (result.kind === 'reverted') {
      // Gas spent and no token moved: the maker keeps theirs and so does this wallet. A pool
      // that moved past `amountOutMin` does this by design, so it is a skip and not an alarm.
      skip('reverted')
      const why = await revertReason(client, hash, result.blockNumber, [
        SETTLEMENT_ABI,
        SOLVER_EXECUTOR_ABI,
      ] as never)
      log(`  FAIL the fill reverted · tx ${hash} · gas=${result.gasUsed} · ${why}`)
      continue
    }

    fills++
    const d = await decimalsOf(intent.tokenOut)
    log(
      `filled ${hash.slice(0, 12)}… gas=${result.gasUsed} ` +
        `maker received ${amount(result.received, d)} (owed ${amount(result.owed, d)}, by ${result.method})`,
    )
  }

  // Say the pass and the total apart. Printed as one number beside two per-pass counts, the
  // running total read as a per-pass rate: `5 filled` every 90 seconds looked like a busy market
  // while nothing had filled for two days. Every skip has a reason column, in a fixed order, so
  // two pass lines compare by eye and a grep for one reason finds every pass it happened in.
  const reasons = SKIPS.map((why) => `${why}=${skipped.get(why) ?? 0}`).join(' ')
  const pool = graphOff
    ? 'graph off'
    : `graph ${graph.qualifiedCount} pools${keeper.usable(head) ? '' : ' (behind, not routed)'}`
  log(
    `pass · ${seen.size} verified · ${open.length} open · ${candidates} above cost · ` +
      `skipped ${reasons} · ${fills - filledBefore} filled · ${fills} since start · ${pool}`,
  )
}

/** A fill the chain has already agreed to, and the gas it measured for it. */
type Attempt = { gas: bigint; send: () => Promise<Hex> }

/** Read a contract call, and give back the reason instead of throwing when it will not run. */
async function measure(shape: Record<string, unknown>): Promise<bigint | 'refused'> {
  try {
    // Both, and in this order. The simulation is what names a revert — `NotStarted`, `TooMuch`,
    // the router's own `INSUFFICIENT_OUTPUT_AMOUNT` — and the estimate is what prices the fill.
    await client.simulateContract({ ...shape, account: CALLER } as never)
    return await client.estimateContractGas({ ...shape, account: CALLER } as never)
  } catch (e) {
    log(`  skipped · the chain refuses it: ${describe(e)}`)
    return 'refused'
  }
}

/**
 * Fill with no inventory, through `ProveExecutor`.
 *
 * Measured twice, and the two measurements do different jobs.
 *
 * The first runs against the loosest bound that still pays the maker in full — `amountOutMin` at
 * exactly what the settlement will pull. That call cannot fail for want of profit, so what it
 * measures is the gas of this intent at this pool, on this token. It has to be measured per
 * intent: on 369 the same code costs 532,819 gas selling WPLS for DAI and 1,092,228 selling DAI
 * for PLSX, because PLSX writes a governance checkpoint on every transfer and this path moves it
 * four times.
 *
 * The second runs against the bound that number implies: what the fill owes, plus the gas it
 * burns. That is the bound the transaction goes out with, so a pool that moves between here and
 * the block reverts at the router rather than settling a trade that costs more than it pays. No
 * token moves when it does — the maker keeps theirs and this wallet keeps its balance — but the
 * gas is spent all the same, which is why the first check is a check and not a hope.
 *
 * Returns the skip reason when the chain refuses the fill or the gas eats it, having spent
 * nothing either way.
 */
async function zeroInventoryFill(
  intent: SignedIntent,
  take: bigint,
  cost: bigint,
  earns: bigint,
  maxFeeRate: bigint,
  quote: Priced,
  now: bigint,
): Promise<Attempt | Skip> {
  // The caller only comes here with an executor. Reaching here without one is a bug in this
  // file, not an intent to skip, so it fails the pass instead of hiding in a count.
  if (!EXECUTOR) throw new Error('zeroInventoryFill needs an executor')
  const executor = EXECUTOR
  // The path that was priced, whole. A graph path can be three hops, and the router walks it
  // in one `swapExactTokensForTokens`: the intermediate tokens move pair to pair inside the
  // router and never rest in the executor or its sink.
  const path = quote.path

  // Five minutes, as the solver's own venue calls use. The deadline only has to outlive the
  // mempool; a longer one lets a stale fill land in a pool that has moved past the bound.
  const deadline = now + 300n
  const router = routerOf(quote)
  const callAt = (amountOutMin: bigint) => {
    const swap = executorRouterSwap(router, take, amountOutMin, path, executor, deadline)
    const call = executorFillCall(executor, intent, take, maxFeeRate, swap)
    return { address: call.address, abi: call.abi, functionName: call.functionName, args: call.args }
  }

  const gas = await measure(callAt(cost))
  if (gas === 'refused') return gas
  if (!clears(earns, gas)) return 'gas'

  // Null only when nothing values tokenOut in WPLS. `tick` has already skipped that case as
  // `unvalued` before it gets here, so this line should never run, and it counts if it does.
  const margin = inTokenOut(gasFloor(gas), quote)
  if (margin === null) return 'unvalued'
  const shape = callAt(cost + margin)
  // A tighter bound cannot make the fill cost more, so this only asks whether the venue still
  // clears it. The first measurement is the one the gate was decided on.
  if ((await measure(shape)) === 'refused') return 'refused'

  return {
    gas,
    send: () => {
      if (!wallet) throw new Error('a fill needs a key')
      // A margin over the measured gas, for the reason the SDK keeps one: an estimate is the
      // smallest limit that worked, and one warm slot different at inclusion time turns a fill
      // into an out-of-gas revert. Unburnt gas is never charged.
      return wallet.writeContract({
        ...shape,
        account: wallet.account,
        gas: (gas * 12_500n) / 10_000n,
        ...FEES,
      } as never) as Promise<Hex>
    },
  }
}

/**
 * Fill out of this wallet's own stock, through `ProveSettlement`.
 *
 * The old path, kept for 943 and for anyone who would rather pay a third of the gas and hold the
 * float. It takes in token A and never sells it, so whoever runs it owns the position that
 * follows.
 *
 * The approval has to come first, because a fill with no allowance does not simulate. That is
 * also why a dry run never reaches this function: the only way to rehearse this path is to grant
 * the allowance for real.
 */
async function inventoryFill(
  intent: SignedIntent,
  take: bigint,
  earns: bigint,
  maxFeeRate: bigint,
): Promise<Attempt | Skip> {
  const shape = {
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'fill',
    args: [intent, intent.signature, take, maxFeeRate],
  } as const
  try {
    // Inside the `try`, so an approval the block reverted is a counted refusal for this intent,
    // and not a failed pass. Five failed passes exit, and the restart would send it again.
    await ensureApproval(intent.tokenOut)
    // Simulate as the caller, which is what names a revert. The send is built separately below
    // rather than from this request, and that is the whole point: a request viem built for an
    // address carries a JSON-RPC account, so `writeContract` asks the node to sign and the node
    // answers `unknown account`. The zero-inventory path above always did it this way; this one
    // reused the request and only ever failed once a fill got far enough to be sent.
    await client.simulateContract({ ...shape, account: CALLER, ...FEES })
    const gas = await client.estimateContractGas({ ...shape, account: CALLER })
    if (!clears(earns, gas)) return 'gas'
    return {
      gas,
      send: () => {
        if (!wallet) throw new Error('a fill needs a key')
        return wallet.writeContract({
          ...shape,
          account: wallet.account,
          gas: (gas * 12_500n) / 10_000n,
          ...FEES,
        } as never) as Promise<Hex>
      },
    }
  } catch (e) {
    // Counted as `refused`, like `measure`. This exit used to count nothing, so the 943 unit,
    // which runs this path, printed no reason for a refusal.
    log(`  skipped · the chain refuses it: ${describe(e)}`)
    return 'refused'
  }
}

// ── One-time funding ──────────────────────────────────────────────────────────

/**
 * Gas to fill with, and — on the inventory path only — tokens to pay makers with.
 *
 * Both numbers depend on the chain, because a fill costs a millionth of a PLS on 943 and 150 to
 * 500 PLS on 369.
 */
const FUND_GAS: Record<ChainId, bigint> = {
  // 943 charges 7 wei of base fee, so 50 PLS buys about a million and a half fills.
  943: parseEther('50'),
  // Measured on chain, not taken from Gas.t.sol. 5,000 PLS bought fourteen fills and then the
  // bot stopped with `insufficient funds`.
  //
  // The benchmark is the wrong number to budget from, whatever it currently reads. It is
  // measured warm, against mocks, with the storage and the accounts already touched. A real fill
  // on 369 costs 138,560 to 333,212 gas, median 271,176. The difference is the cold path: 2,100
  // a cold SLOAD, 2,600 a cold account, 20,000 wherever a token balance goes from zero.
  //
  // **The old form of this comment gave the gap as a multiple, and a multiple cannot be carried
  // here.** It said the benchmark was 33,175 gas and a real fill five to ten times that. The
  // benchmark reads 124,975 today — `app/src/landing/gas.ts`, "fill, allowance, warm", written
  // out of `Gas.t.sol` — because the curve, the booked fee and the parked source all landed
  // since. The chain figures above were measured against the older contract, so dividing one by
  // the other now compares two different builds and answers 2.4x, which is an artefact rather
  // than a measurement. Re-measure both together or quote neither as a ratio.
  //
  // The funding stands on the direct observation instead: 5,000 PLS bought fourteen fills, which
  // is about 357 PLS each, and a zero-inventory fill is the dearest path.
  //
  // The balance check is stricter still. viem needs `gas * maxFeePerGas`, and `feesAt` caps at
  // four times the base fee, so a 500,000-gas fill reserves about 1,400 PLS to spend 355. The
  // cap is never charged, and the pre-flight refusal is real.
  //
  // 500,000 PLS is $6.90 and about a thousand fills on the zero-inventory path. Gas is the only
  // thing this bot needs now, so it is the last thing to economise on.
  369: parseEther('500000'),
}

/**
 * Whole units per token, before decimals. Only `--inventory` spends this.
 *
 * The 943 row is sized against a 400 tUSDC / 10,000 tPLSX pool: more than a ring solver needs,
 * because this path ratchets. A ring ends holding the token it started with, so a solver's float
 * only grows; an executor paying out of stock receives token A and pays token B, so a board that
 * leans one way drains one side of it. Roughly ten fills per side before it depends on the
 * traffic turning around, which the heartbeat's two directions and the mover's price walk do.
 *
 * The 369 row is what the owner chose on 2026-08-23 against a mainnet balance of $687, at that
 * day's mid prices — WPLS $0.00001368, PLSX $0.00001237, DAI $1. The default path needs none of
 * it. It is here for a `--fund --inventory` run and for the record of what the drift came from.
 */
const FUND_UNITS: Record<ChainId, Record<string, string>> = {
  943: { tUSDC: '100', tPLSX: '1500' },
  369: { WPLS: '365000', PLSX: '404000', DAI: '5' },
}

async function fund(): Promise<void> {
  if (!deployerKey) throw new Error('--fund needs DEPLOYER_PK')
  if (!account) throw new Error('--fund needs EXECUTOR_KEY, or DEPLOYER_PK to derive it')
  const deployer = privateKeyToAccount(deployerKey)
  const deployerWallet = createWalletClient({ account: deployer, chain, transport: rpcTransport(chainRpc) })
  log(`funding ${account.address} from ${deployer.address}`)

  // `fund()` runs before the first tick, so it reads the base fee itself. On 369 the 20 gwei floor
  // sits far under the base fee, and the node rejects the transfer instead of mining it.
  await refreshFees()

  const gasTarget = FUND_GAS[chainId]

  const deployerBefore = await client.getBalance({ address: deployer.address })
  log(`deployer holds ${formatEther(deployerBefore)} PLS`)

  const pls = await client.getBalance({ address: account.address })
  if (pls < gasTarget / 2n) {
    const value = gasTarget - pls
    // Send at most half of what the deployer holds. A funding run that empties the deployer leaves
    // nobody able to fund the next bot, or to pay the gas that recovers this one's tokens.
    if (deployerBefore - value < value) {
      throw new Error(
        `deployer holds ${formatEther(deployerBefore)} PLS and this sends ${formatEther(value)}. ` +
          `Top the deployer up, or lower FUND_GAS for chain ${chainId}.`,
      )
    }
    const hash = await deployerWallet.sendTransaction({ to: account.address, value, ...FEES })
    landedOrThrow(await client.waitForTransactionReceipt({ hash, timeout: 120_000 }), 'gas', hash)
    log(`${formatEther(value)} PLS → executor · ${hash}`)
  } else {
    log(`gas already there: ${formatEther(pls)} PLS`)
  }

  // Gas is the whole ask on the default path, so say so and stop rather than moving a float the
  // bot will never spend.
  if (EXECUTOR) {
    log(`funded, gas only. Fills go through ${EXECUTOR} and need no inventory.`)
    return
  }

  const units = FUND_UNITS[chainId]
  // Gas without inventory is a bot that watches the board and fills almost nothing. Say so, rather
  // than letting the loop find no matching symbol and print a clean finish.
  if (Object.keys(units).length === 0) {
    log(
      `WARN no inventory table for chain ${chainId}. Gas is funded and no tokens moved, so the ` +
        'executor can only fill intents whose tokenOut it already holds.',
    )
  }

  for (const t of presetTokens(chainId)) {
    const whole = units[t.symbol]
    if (!whole) continue
    const need = parseUnits(whole, t.decimals)
    const have = await client.readContract({
      address: t.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    })
    if (have >= need) {
      log(`${t.symbol} already there: ${formatUnits(have, t.decimals)}`)
      continue
    }
    const hash = await deployerWallet.writeContract({
      address: t.address,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [account.address, need - have],
      ...FEES,
    })
    landedOrThrow(
      await client.waitForTransactionReceipt({ hash, timeout: 120_000 }),
      `${t.symbol} transfer`,
      hash,
    )
    log(`${formatUnits(need - have, t.decimals)} ${t.symbol} → executor · ${hash}`)

    // Approve from the executor's own key, so nothing but the relayer can move these.
    await ensureApproval(t.address)
  }
  const deployerAfter = await client.getBalance({ address: deployer.address })
  log(`deployer now holds ${formatEther(deployerAfter)} PLS, from ${formatEther(deployerBefore)}`)
  log('funded. The bot host needs EXECUTOR_KEY and nothing else.')
}

if (process.argv.includes('--fund')) {
  await fund()
  process.exit(0)
}

log(`executor starting · chain ${chainId} (${network(chainId).label}) · ${CALLER}`)
log(`settlement ${SETTLEMENT} · relayer ${RELAYER}`)
log(
  EXECUTOR
    ? `zero inventory · fills through ${EXECUTOR} · this wallet needs only gas`
    : 'inventory · fills out of this wallet, which needs a float in every tokenOut',
)
log(
  `min spread ${minSpreadBps}bps · gas margin ${gasMarginBps}bps · ` +
    `model ${modelGas()} gas${dryRun ? ' · dry run' : ''}`,
)

if (!graphOff) {
  log(
    `pool graph · ${graphFrom === 'cache' ? `${graph.size} pools from cache, synced to ${graph.syncedTo}` : 'cold'}` +
      `${graphStale ? ` · ${graphStale} cached pools dropped, venue or fee changed` : ''} · ` +
      `cap ${graph.options.maxPools} · floor ${formatEther(graph.options.depthFloor)} WPLS`,
  )
  // A cold start waits for one discovery, bounded, so the first pass can price what needs a
  // multi-hop route. A warm start does not: its cache already can, and the first pass catches
  // the reserves up from `Sync` logs. Either way a subgraph failure only costs the wait.
  if (graphFrom === 'cold') {
    try {
      const r = await keeper.warmUp(await client.getBlockNumber(), [])
      log(
        `pool graph warmed · ${graph.qualifiedCount} pools · ${r.reads} reads, ${r.unreadable} unreadable, ` +
          `${r.rejected} rejected · ${r.discovery.map((d) => `${d.venue} ${d.ok ? 'ok' : d.reason}`).join(', ')} · ${r.ms} ms`,
      )
      saveGraph(graph, chainId)
    } catch (e) {
      log(`pool graph warm-up failed, starting without it: ${describe(e)}`)
    }
  }
}

for (;;) {
  try {
    await tick()
    consecutiveFailures = 0
  } catch (e) {
    consecutiveFailures++
    log(`FAIL (${consecutiveFailures}) ${describe(e)}`)
    if (consecutiveFailures >= 5) {
      log('five failures in a row — exiting for the supervisor to restart')
      process.exit(1)
    }
  }
  await new Promise((r) => setTimeout(r, intervalMs))
}

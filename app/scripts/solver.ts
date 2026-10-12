/**
 * Solver bot. Reads the board, finds the cycles of intents that pay for each other, ranks them,
 * simulates them, and settles them in one `fillBatch`.
 *
 *   npx tsx scripts/solver.ts --fund --chain 943                 # one-time setup
 *   npx tsx scripts/solver.ts --chain 943
 *
 * The solver wakes on every new block. `--block-poll N` sets how often it asks the chain for
 * its head (default 1s), and `--interval N` is the fallback heartbeat for when no block
 * arrives at all (default 60s).
 *   npx tsx scripts/solver.ts --chain 943 --execute --min-profit-native 100
 *   npx tsx scripts/solver.ts --chain 943 --depth tPLSX=128,tHEX=1 --book-limit 5000
 *   npx tsx scripts/solver.ts --chain 943 --execute --credit 0xBatchExecutor --amm
 *   npx tsx scripts/solver.ts --chain 943 --execute --credit 0xBatchExecutor --amm --batch
 *   npx tsx scripts/solver.ts --chain 943 --execute --credit 0xBatchExecutor --amm --tolerant
 *   npx tsx scripts/solver.ts --chain 943 --execute --max-grief-native 2000   # bound the grief
 *
 * Env:
 *   SOLVER_KEY  a 0x private key holding the tokens the ring pays out in, and some gas.
 *               `--credit` needs no inventory in it, only gas.
 *   DEPLOYER_PK only for `--fund`, and only from a workstation. It derives SOLVER_KEY.
 *   RPC         override the chain RPC.
 *   BOARD_RPC   override the msgboard RPC (defaults to RPC).
 *   VALVE_RPC_KEY  the gateway key. It goes in an `X-API-Key` header, never in the URL path.
 *   SETTLEMENT  override the settlement address, for a fork.
 *   CREDIT_EXECUTOR  the ProveBatchExecutor address, if not passed as `--credit`.
 *
 * It is a dry run unless `--execute` is passed. It never generates a key: an operator's key
 * comes from the environment or the bot does not start.
 *
 * Where the executor bot prices one intent against PulseX, this one prices intents against each
 * other. Two makers going opposite ways on the same pair need not agree on a price — between
 * them they only have to concede more than the protocol charges, which today is sixteen basis
 * points for a two-leg ring. `--amm` also lets a ring close through the pool, which settles in a
 * second transaction and is therefore not atomic; it is off by default for that reason.
 *
 * **`--credit <address>` settles through `ProveBatchExecutor` instead.** The contract takes every
 * leg's token A before any maker is paid, so the ring funds itself and this bot needs no
 * inventory and no allowance — only gas. It also carries the pool leg: with `--amm` the closing
 * swap runs inside the same transaction rather than as a second one from this wallet, which is
 * the difference between an atomic ring and a position held across a block boundary. The old
 * path is unchanged and is still the default, because credit costs about 130,000 more gas.
 *
 * The executor address is not in the SDK registry and never will be. The registry carries the
 * settlement, because everything else in a deployment is reachable from it; a batch executor is
 * reachable from nothing, so an operator names the one they trust.
 *
 * **`--batch` packs the independent plans into one tolerant transaction.** A ring is a cycle and
 * is untouched by it: a cycle minus a leg is not a cycle, so a ring keeps its own atomic send.
 * Everything else this bot finds is one maker's intent closed through a pool, and those do not
 * depend on each other. See `packBatch` for what "independent" has to mean and why. Off by
 * default, and it needs `--credit` and `--amm` with it — `sendBatch` says why.
 *
 * **Losing a race to another solver is the expensive accident, and a ring is where it bites.**
 * Two solvers reading one public board will overlap. Neither did anything wrong, and the slower
 * one pays. What matters is not the size of the bill but what it buys: nothing.
 *
 *   on the tolerant path   a lost leg costs 15,982 gas, against 69,841 for the fill it would have
 *                          made, and every other leg in the batch still fills. You still earn
 *   on a ring              a lost 3-leg ring costs 222,044, against 283,087 to settle one. The
 *                          whole transaction reverts, so you earn nothing
 *
 * Two evenly matched solvers racing on rings therefore each pay about 1.8x the gas per ring they
 * actually settle. The same collision rate on the tolerant path adds about 3%.
 *
 * Every figure in that table comes from `src/landing/gas.ts`, which `scripts/gen-gas.mjs`
 * generates from `contracts/test/Gas.t.sol` and CI checks. They are quoted here for a reader and
 * computed from the table wherever the bot acts on them.
 *
 * A ring sends `skipInvalid` false by default, because half a cycle leaves this wallet holding an
 * unhedged position. So it reverts having paid for everything it settled first, which is why the
 * loss grows with where the gap sits — the same eight legs cost 121,329 or 554,731. `--legs`
 * prices contention as well as search breadth, and three is the default for both reasons.
 *
 * **`--tolerant` buys the ring out of that, at a price.** It carries a market fallback beside
 * every intent leg, so a leg a rival takes is bought at a venue instead of reverting the
 * transaction — the cycle closes with a market leg where the intent leg was, which is a leg this
 * system already has. It is off by default and it must stay off until somebody measures a real
 * board: a fallback is carried on every ring whether or not it fires, and the startup log prints
 * the loss rate this bot would have to be running at before that trade pays. See `flags.ts` for
 * the guard and `sdk/src/solver/tolerant.ts` for the sizing rule that makes a covered ring worth
 * no less than the atomic one.
 *
 * **The bot watches the mempool for that collision before it builds a ring.** Every pass reads
 * the pending transactions, decodes the ones carrying a fill entry point — by selector, so a
 * rival settling through their own executor is seen too — and refuses any ring naming a leg
 * somebody else is already sending for. `--no-watch-pool` turns it off. It is evidence and not
 * truth: a pending transaction may be replaced, dropped, or broadcast as a feint. Believing a lie
 * costs one ring not built this block; disbelieving the truth costs 222,044 gas for nothing, so
 * the bot errs towards believing the pool. `sdk/src/solver/mempool.ts` argues it in full.
 *
 * That closes an accident, not a race. Nothing here coordinates with another solver, and a solver
 * who is simply faster still wins. The simulation immediately before sending is the rest of the
 * defence, and it narrows the window to one block rather than closing it.
 *
 * **`--max-grief-native N` bounds what one transaction may lose to legs that fill nothing.** A
 * leg that passes evaluation and then fails to arm costs about 80,174 gas and fills none, and the
 * waste is linear in how many of them a batch carries. This names the loss and `unprovenBudget`
 * turns it into a leg count at the tick's gas price. It also switches on the ledger that learns
 * which makers have settled and which keep failing to arm — see `blameFor` for how the two are
 * told apart, which is the only hard part. Off by default: a fresh ledger has proven nobody, so
 * this is a decision an operator makes rather than one that arrives with a deploy.
 *
 * Every piece of protocol logic here comes from @prove.cash/sdk/solver, so this bot and the web
 * app can never disagree about what a ring is worth.
 *
 * **The bot host never holds the deployer key.** `--fund` runs once from a workstation and moves
 * gas and inventory across. After that the bot needs `SOLVER_KEY` and nothing else. The key is
 * derived, never generated:
 *
 *   keccak256(concat([deployerKey, stringToHex('prove.cash/solver')]))
 *
 * **Gas.** A 1 gwei tip, set here rather than estimated, and `--gas-price` for what a ring is
 * costed against. `eth_gasPrice` on 943 answers 500 gwei against a 7 wei base fee, so believing
 * the node makes every ring look like a loss and the bot settles nothing. See `gasPriceWei`.
 */
import './guard'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import {
  concat,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  keccak256,
  parseEther,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  readIntentsSince,
  createIntentStore,
  readIntent,
  explainRevert,
  intentHashOf,
  isSupportedChain,
  memoryStorage,
  network,
  presetTokens,
  readFillability,
  setChainId,
  setRpc,
  setRpcLinked,
  setSettlementOverride,
  setXykVenuesOverride,
  settlement,
  tokenInfo,
  xykRouter,
  xykVenue,
  PULSEX_FEE_DEN,
  PULSEX_FEE_NUM,
  type ChainId,
  type FillReason,
  type SignedIntent,
} from '@prove.cash/sdk'
import {
  DEFAULT_GAS_MODEL,
  DEFAULT_MAX_PER_PAIR,
  MAX_RING_LEGS,
  ROUTER_ABI,
  SOLVER_BATCH_EXECUTOR_ABI,
  SOLVER_SETTLEMENT_ABI,
  deliveredFromLogs,
  ensureApprovals,
  executeCreditRing,
  executeRing,
  executeSwap,
  loadBookFromStore,
  loadPools,
  xykMarkets,
  loadPrices,
  makersShortChanged,
  packBatch,
  planTolerantRing,
  breakEvenLossRate,
  carriedFallbackGas,
  presetDepth,
  readRivalClaims,
  ClaimAges,
  claimedKeys,
  groupsFromBook,
  selectFeasible,
  settleBatchCall,
  simulateCreditRing,
  simulateRing,
  solve,
  upcoming,
  withSimulatedGas,
  netClears,
  batchNetClears,
  DEFAULT_TRUST,
  MakerTrust,
  admits,
  faultsMaker,
  unprovenBudget,
  unprovenLegs,
  type GasModel,
  type PackedBatch,
  type PairDepth,
  type Plan,
  type PriceBook,
} from '@prove.cash/sdk/solver'
import { VerdictCache } from './verdicts.ts'
import { PRIORITY_FEE, fees, redact, describe as why, assertChainId, boardEndpoint, rpcEndpoint, rpcTransport, registerEndpoint } from './rpc.ts'
import { batchExecutorFlag, tolerantRingsFlag } from './flags.ts'
import { trustFilePath } from './state.ts'
import { assertSettlement, readCreditFault } from './deployment.ts'
// Generated from `contracts/test/Gas.t.sol` by `scripts/gen-gas.mjs` and checked in CI. The
// break-even below is arithmetic over a measured number rather than a number somebody typed —
// which is how the last three figures in this file went stale.
import { GAS } from '../src/landing/gas.ts'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const chainId = Number(arg('chain', '943')) as ChainId
if (!isSupportedChain(chainId)) throw new Error(`unknown chain ${chainId}`)

/**
 * The fallback heartbeat, in milliseconds. It is no longer the clock — see the loop at the foot of
 * this file — so a longer one costs responsiveness only when the block watch is already broken.
 */
const intervalMs = Number(arg('interval', '60')) * 1000

/**
 * How often to ask the chain for its head. A tenth of a block time, so a new block is noticed
 * within a second of arriving rather than up to a whole block late.
 *
 * PulseChain targets ten seconds, so one second is the default. It is one `eth_blockNumber` per
 * poll and nothing else: the pass itself only runs when the number actually advances.
 */
const blockPollMs = Number(arg('block-poll', '1')) * 1000
const execute = process.argv.includes('--execute')
const useAmm = process.argv.includes('--amm')

/**
 * Look in the mempool for a rival's pending fill before building a ring. On by default.
 *
 * One extra read per pass, inside the pass that already runs — see `readRivalClaims`, which
 * prefers `eth_pendingTransactions` (14,930 bytes and 265 ms on 943) over `txpool_content`
 * (2,458,980 bytes and 741 ms for the same 19 transactions). `--no-watch-pool` turns it off for a
 * node that serves neither, though it turns itself off in that case anyway.
 */
const watchPool = !process.argv.includes('--no-watch-pool')

/**
 * Settle through `ProveBatchExecutor` rather than out of this wallet's own stock.
 *
 * An address, not a switch: the contract is unowned and permissionless, but it is also the
 * address that holds every leg's released tokens for the length of the transaction, so an
 * operator names the deployment they trust rather than inheriting one from a registry.
 */
const creditExecutor = ((): Address | null => {
  const named = arg('credit', process.env.CREDIT_EXECUTOR ?? '')
  if (!named) return null
  if (!/^0x[0-9a-fA-F]{40}$/.test(named)) throw new Error(`--credit: ${named} is not an address`)
  return named as Address
})()

/**
 * `--batch`: the executor to pack independent plans through, or null to send each on its own.
 *
 * Off by default. It changes what the bot spends money on, so it is a decision somebody makes on
 * the command line rather than one that arrives with a deploy. `scripts/flags.ts` holds the guard
 * and the argument for it, and `flags.test.ts` attacks both.
 */
const batchExecutor = batchExecutorFlag(process.argv, { credit: creditExecutor, amm: useAmm })

/**
 * `--tolerant`: carry a market fallback per leg, so a ring that loses one settles anyway.
 *
 * **Off by default and it stays off until somebody measures a board.** A fallback is carried on
 * every ring and paid for on every ring; the loss it avoids happens only on the rings that lose a
 * leg. The break-even is printed at startup from the generated gas table, so an operator can see
 * the rate they would have to be losing at before this is worth turning on.
 *
 * What it does when it is on: `planTolerantRing` picks a market for every intent leg of a ring
 * and sizes it to exactly what that leg's payment frees, and the ring goes out with
 * `skipInvalid` true. A leg a rival takes then costs the market's price instead of the whole
 * transaction — and because the fallback never spends more than the missing maker would have
 * been paid, the ring cannot end up worth less than the atomic one it replaced.
 *
 * It covers what it can and says what it cannot. A leg whose market asks more than that leg
 * frees gets no fallback, and the ring reverts on that leg exactly as it does today. That is
 * common rather than rare: a market cheap enough to stand in for a maker usually makes a better
 * ring, which the search would have found instead. The per-tick log is the instrument for
 * measuring how often that is true on a real board.
 */
const tolerantRings = tolerantRingsFlag(process.argv, { credit: creditExecutor, amm: useAmm })

/**
 * `--max-grief-native N`: bound what one transaction may lose to legs that fill nothing.
 *
 * A leg that passes evaluation and then fails to arm costs about 80,174 gas and fills nothing.
 * The waste is linear in how many such legs a batch carries, and without a rule that number is
 * chosen by whoever posted them. This names it: the most this solver will spend, in one
 * transaction, on legs from makers who have never settled for it. `unprovenBudget` divides that
 * by what one failure costs at the tick's gas price and hands back a leg count.
 *
 * **Off unless it is passed, and that is deliberate.** A cold ledger has proven nobody, so a
 * budget of zero admits nothing and a bot that has never settled would never start. Two things
 * follow. The budget wants a real number, not a floor. And `--max-unproven-per-ring` stays at
 * whatever the operator sets, because the SDK's default of one refuses every two-leg ring on a
 * fresh ledger — a maker can only prove themselves by settling, and the cheap way to let them is
 * the tolerant `--batch` path, where one bad leg costs one leg.
 *
 * The drop rule needs no budget and runs whenever the ledger is on: three arming failures with no
 * fill between them, forgotten after an hour of quiet.
 */
const maxGriefNative = ((): bigint | null => {
  const named = arg('max-grief-native', '')
  if (!named) return null
  const n = Number(named)
  if (!Number.isFinite(n) || n < 0) throw new Error(`--max-grief-native: ${named} is not an amount`)
  return BigInt(Math.floor(n * 1e18))
})()

/** Unproven legs one atomic ring may carry. A ring is all-or-nothing, so one bait costs it all. */
const maxUnprovenPerRing = count(
  '--max-unproven-per-ring',
  arg('max-unproven-per-ring', String(MAX_RING_LEGS)),
)

/**
 * Where the ledger lives between restarts.
 *
 * A solver learns who wastes its gas over hours, and a bot that forgets on every deploy learns
 * nothing. The file is this solver's own opinion and nobody else's — it is not consensus, it is
 * not shared, and deleting it costs one hour of relearning. Under systemd it is in the unit's
 * `StateDirectory`, because the units leave nowhere else writable (`state.ts`).
 */
const trustFile = arg('trust-file', trustFilePath(chainId))

/**
 * The least a ring must clear, in the chain's native token, after the gas it burns.
 *
 * This is a margin and not a cost. `planOf` has already subtracted the gas, so a ring at zero
 * pays for itself exactly. The margin covers what moves between the simulation and the block:
 * the base fee mostly, which on 369 can double inside a few blocks and turn a thin ring negative
 * while it waits.
 *
 * 943 stays at zero, where a fill costs a millionth of a PLS and any positive net is real. 369
 * asks for 500 PLS, which is under a cent and roughly the gas of the ring itself — a fill there
 * runs 138,560 to 333,212 gas, so a two-leg ring is 300-odd PLS of gas before it earns anything.
 */
const DEFAULT_MIN_PROFIT: Record<ChainId, string> = { 943: '0', 369: '500' }

// `--min-profit-pls` still works. It named the token rather than the role, which is wrong on any
// chain whose native token is not PLS, but a deployed unit file still passes it and a rename that
// silently reverts a bot to its default floor is not worth the tidiness.
const minProfitNative = arg(
  'min-profit-native',
  arg('min-profit-pls', DEFAULT_MIN_PROFIT[chainId]),
)
const horizonS = BigInt(arg('horizon', '900'))
/**
 * Profit tokens a plan may earn in while nothing prices them, as `--unpriced-ok 0xA,0xB`. Any
 * other unpriced plan is refused: its net cannot be weighed against its gas. Empty by default.
 */
const unpricedOk = arg('unpriced-ok', '')
  .split(',')
  .filter(Boolean)
  .map((a): Address => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`--unpriced-ok: ${a} is not an address`)
    return a as Address
  })

/**
 * What a credit ring costs on top of an inventory one, so the engine does not rank one it cannot
 * afford.
 *
 * Measured in `contracts/test/BatchExecutor.t.sol`: the same two-leg ring costs 224,617 gas
 * through `fillBatch` and 354,435 through `ProveBatchExecutor.settleRing`. The difference buys
 * the executor hop, one allowance write per token, and one transfer per token to carry the
 * spread back to this wallet. A pool leg adds 100,687 inside the callback against the 215,000
 * the old path pays for a second transaction, so closing through the pool is the half of this
 * that gets cheaper.
 *
 * It is a filter and not an estimate, exactly as `DEFAULT_GAS_MODEL` is. `simulateCreditRing`
 * measures the real figure and `withSimulatedGas` re-prices the plan on it before anything is
 * sent.
 */
const CREDIT_GAS_MODEL: GasModel = {
  base: DEFAULT_GAS_MODEL.base + 130_000n,
  perIntentLeg: DEFAULT_GAS_MODEL.perIntentLeg,
  perMarketLeg: 100_000n,
}

/**
 * How wide this run searches. Every one of these trades candidates for time and memory, and until
 * now none of them could be changed without editing the SDK.
 *
 *   --book-limit N        rows the store hands over per tick
 *   --max-rings N         rings kept once the condition passes
 *   --seed FILE           read the offers from a JSON file instead of the board. The file
 *                         is a list of `{ data, hash }`, which is what the board serves.
 *   --legs N              how many legs a ring may have, 2 to 8. THREE by default, and see
 *                         `FindRingsOptions.maxLegs` before raising it: a ring cannot skip a
 *                         leg, so every extra leg widens finding E-3. It is also a CONTENTION
 *                         setting — see the note on losing a race below.
 *   --max-per-pair N      entries kept per direction, for a token the depth table does not name
 *   --depth SYM=N,…       entries kept per direction, per token; a preset symbol or a 0x address
 *   --no-depth-preset     start from an empty table instead of the chain's
 */
/** A whole number of things. A typo must stop the bot, not quietly index nothing. */
function count(where: string, text: string): number {
  const n = Number(text)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${where}: ${text} is not a count`)
  return n
}

const bookLimit = count('--book-limit', arg('book-limit', '500'))
const maxRings = count('--max-rings', arg('max-rings', '200'))

/**
 * How many legs a ring may have.
 *
 * A longer cycle finds coincidences of wants a shorter one cannot — six makers can close a loop
 * where no two of them pair off — and the search stays cheap, because it never revisits a token
 * and `--max-rings` bounds what it keeps. Searching wide is not the risk. Settling wide is.
 *
 * Three, not `MAX_RING_LEGS`. The ceiling is eight and the default is three, and they are
 * different numbers on purpose. A ring is atomic, so any maker in it can revert the whole attempt
 * by cancelling their own intent for about 13k gas — finding E-3, which is open and has no
 * on-chain fix. Measured in `app/scripts/lab/atomic-revert.ts`, an eight-leg ring that loses its
 * last leg costs this bot 553,246 gas and fills nothing: roughly 42:1 against the attacker,
 * against about 15:1 at three legs. Every leg added makes it worse, because the executor's cost
 * grows with the ring and the attacker's does not.
 *
 * This defaulted to `MAX_RING_LEGS` for a day, which pointed the live bot at the worst end of
 * that trade without anybody choosing it. Raising it is a decision, so it belongs on the command
 * line where somebody makes it.
 *
 * The gas model prices the length and `--min-profit-native` refuses a ring that does not clear
 * it, so a long ring still has to earn its length. That is a profit filter, not a safety one: it
 * says nothing about what the ring costs when a maker breaks it.
 */
const maxLegs = count('--legs', arg('legs', '3'))
// `findRings` clamps silently, so `--legs 20` would run an eight-leg search and never say so.
// A number somebody typed deserves an answer, especially this one.
if (maxLegs > MAX_RING_LEGS || maxLegs < 2) {
  throw new Error(`--legs must be between 2 and ${MAX_RING_LEGS}, and three is the safe default`)
}
const preset = process.argv.includes('--no-depth-preset') ? undefined : presetDepth(chainId)

/** `tPLSX=64,0xabe…=1`. A symbol resolves through the chain's preset tokens. */
function parseDepth(spec: string): Map<string, number> {
  const out = new Map(preset?.byToken ?? [])
  for (const part of spec.split(',')) {
    if (!part) continue
    const [name, n] = part.split('=')
    const token = name.startsWith('0x')
      ? name
      : presetTokens(chainId).find((t) => t.symbol === name)?.address
    if (!token) throw new Error(`--depth: chain ${chainId} has no token called ${name}`)
    out.set(token.toLowerCase(), count(`--depth ${part}`, n))
  }
  return out
}

const depth: PairDepth = {
  byToken: parseDepth(arg('depth', '')),
  default: count('--max-per-pair', arg('max-per-pair', String(preset?.default ?? DEFAULT_MAX_PER_PAIR))),
}

// The SDK resolves endpoints and the settlement address from its own registry, so point that
// registry at this run's chain and endpoints before anything reads from it.
setChainId(chainId)
const chainRpc = rpcEndpoint(chainId)
const boardRpc = boardEndpoint(chainRpc)
setRpcLinked(false, chainId)
setRpc(boardRpc.url, chainId, 'board')
setRpc(chainRpc.url, chainId, 'chain')
for (const e of [boardRpc, chainRpc]) registerEndpoint(e) // the key rides in a header, not the path
/*
 * Which settlement this run talks to.
 *
 * Both names, and `PROVE_SETTLEMENT` first, because that is the one the rest of the repository
 * uses: `scripts/e2e/common.ts` reads it, every lab script inherits it, and `lab/up.sh` exports
 * it. This file read `SETTLEMENT` alone, so pointing the bot at the lab chain did nothing at all
 * — it took the RPC and the executor from the environment, resolved the settlement out of the
 * registry, and ran happily against the live testnet's address on the lab's node. The banner said
 * so and I read past it twice.
 *
 * That is why nothing had ever run this loop against a chain somebody controls.
 */
const settlementOverride = process.env.PROVE_SETTLEMENT ?? process.env.SETTLEMENT
if (settlementOverride) setSettlementOverride(chainId, settlementOverride.trim() as Address)

/*
 * And which market it quotes against, on the same terms.
 *
 * The registry's 943 venue is PulseX's testnet deployment, which has no code on a fresh anvil, so
 * every `getPair` goes to an empty address and this bot reads the whole lab as a chain with no
 * market — no pool legs, no packable plans, and a `--batch` that reports nothing to pack while
 * looking perfectly healthy. It said "4 fillable · 0 rings" for two passes before anybody asked
 * why.
 *
 * `scripts/e2e/common.ts` reads the same four variables and this does not import it: that module
 * funds wallets and claims from faucets, which is not something a bot should carry. The SDK
 * cannot own the resolution either, because it runs in a browser and has no environment to read.
 * So the rule is written twice, and the half worth repeating is BOTH OR NEITHER — a router
 * without its recorded factory is not half an override, it is a venue `confirmVenues` drops on
 * sight, and the run then reports "no pool" for every pair.
 */
const xykRouterEnv = process.env.PROVE_XYK_ROUTER?.trim()
const xykFactoryEnv = process.env.PROVE_XYK_FACTORY?.trim()
if (!xykRouterEnv !== !xykFactoryEnv) {
  throw new Error('PROVE_XYK_ROUTER and PROVE_XYK_FACTORY go together; set both or neither')
}
if (xykRouterEnv && xykFactoryEnv) {
  setXykVenuesOverride(chainId, [
    {
      label: 'lab',
      router: xykRouterEnv as Address,
      factory: xykFactoryEnv as Address,
      // A venue has to be registered at the fee it actually charges, or every quote this bot
      // computes disagrees with the router that will fill it, silently and in one direction.
      feeNum: BigInt(process.env.PROVE_XYK_FEE_NUM ?? PULSEX_FEE_NUM),
      feeDen: BigInt(process.env.PROVE_XYK_FEE_DEN ?? PULSEX_FEE_DEN),
    },
  ])
}

const SETTLEMENT = settlement(chainId)
if (SETTLEMENT === '0x0000000000000000000000000000000000000000') {
  console.log(`settlement is not deployed on chain ${chainId}. Nothing to solve.`)
  process.exit(0)
}

// A key is read, never made. A previous script in this repo generated throwaway keys at module
// scope and stranded 630,000 testnet PLS in addresses nobody can reach.
const deriveSolver = (deployerKey: Hex) =>
  keccak256(concat([deployerKey, stringToHex('prove.cash/solver')]))

const deployerRaw = process.env.DEPLOYER_PK
const deployerKey = deployerRaw
  ? ((deployerRaw.startsWith('0x') ? deployerRaw : `0x${deployerRaw}`) as Hex)
  : null
const key =
  (process.env.SOLVER_KEY as Hex | undefined) ??
  (deployerKey ? deriveSolver(deployerKey) : undefined)
if (!key) throw new Error('SOLVER_KEY, or DEPLOYER_PK to derive it, is required')
const account = privateKeyToAccount(key)

/**
 * How many unmined transactions of our own it takes before this bot stops sending.
 *
 * Two, not zero: a ring and its closing pool swap are two sends, and the second goes out before
 * the first is mined. Anything past that is a queue, and a queue behind a stuck nonce never
 * drains on its own.
 */
const STUCK_LIMIT = 3

const chain = network(chainId).chain
const client = createPublicClient({ chain, transport: rpcTransport(chainRpc) })
const wallet = createWalletClient({ account, chain, transport: rpcTransport(chainRpc) })

/*
 * Ask the node what chain it is on, before anything reads from it.
 *
 * `RPC` replaces the whole URL and the chain id beside it stays a literal, so the two can point
 * this run at another chain's node. Every read then comes back well-formed and about somewhere
 * else. One round trip settles it, and `assertChainId` says why at length.
 */
await assertChainId(client, chainId)

// Refuse a settlement that hashes intents differently from this SDK. `assertSettlement` says why.
await assertSettlement(client, chainId, SETTLEMENT, Boolean(settlementOverride))

// The `--credit` executor serves one settlement for ever. Refuse one from another deploy before
// the first pass. `creditFault` says why.
if (creditExecutor) {
  const source = process.env.PROVE_SETTLEMENT
    ? 'PROVE_SETTLEMENT'
    : process.env.SETTLEMENT
      ? 'SETTLEMENT'
      : 'the registry'
  const fault = await readCreditFault(client, chainId, creditExecutor, SETTLEMENT, source)
  if (fault) throw new Error(fault)
}

const store = createIntentStore(memoryStorage())

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (m: string) => console.log(`${stamp()}  ${m}`)
const pls = (wei: bigint) => `${formatUnits(wei, 18)} PLS`

/**
 * A token's decimal place, or null when the chain would not say.
 *
 * Null is not 18. A six-decimal token read as eighteen sizes every leg of a ring 10^12 wrong, so
 * an intent whose decimals are unknown is skipped rather than guessed at. Only an answer is
 * cached: a dropped read gets asked again next tick.
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

/**
 * What a unit of gas will actually cost this bot.
 *
 * The base fee comes off the block, which is a recorded field rather than an estimate, and the
 * tip is the one we set. Their sum is what we pay, so it is what a ring must clear.
 *
 * Not `eth_gasPrice`. On 943 that answers 500 gwei against a 7 wei base fee — seventy million
 * times the real number — and costing rings against it makes every one of them look like a loss.
 * The bot then logs "gas eats it" for ever and settles nothing, which reads as no opportunity
 * rather than as a broken price. `--gas-price <wei>` forces a number when a chain needs one.
 *
 * Not the cap either. `feesAt` leaves four times the base fee of headroom, which a transaction
 * needs and a cost estimate must not borrow: on 369 that prices every ring at four times its real
 * gas bill and the bot goes quiet for the same wrong reason.
 */
const gasPriceOverride = process.argv.includes('--gas-price')
  ? BigInt(arg('gas-price', '0'))
  : null

async function gasPriceWei(): Promise<bigint> {
  if (gasPriceOverride !== null) return gasPriceOverride
  const block = await client.getBlock()
  return (block.baseFeePerGas ?? 0n) + PRIORITY_FEE
}

// ── Watching for a rival ──────────────────────────────────────────────────────

/**
 * How many passes to sit out before asking the pool again, after a read that failed.
 *
 * **Latching off for good was the first version of this and it was wrong.** A node that refuses
 * both methods should cost almost nothing, and a node that blipped for one pass should not blind
 * the solver until somebody restarts it — that is the failure that looks healthy from outside,
 * because the process is up and the passes keep logging. So the wait doubles from one pass to
 * sixty-four, about eleven minutes on a ten-second chain, and any answer at all clears it.
 *
 * Measured while testing the refusal: a node that TIMES OUT rather than refusing costs a whole
 * pass of latency before the watch gives up on it. Once, then once more eleven minutes later, is
 * a price worth paying to keep recovering.
 */
const POOL_BACKOFF_MAX = 64
let poolSkips = 0
let poolWait = 0
/** Which method answered, logged whenever it changes, so an operator can see what it costs. */
let poolSource = ''

/**
 * Which legs a rival's pending transaction already names, as `intentKey`s.
 *
 * Empty when the watch is off, when the node will not answer, or when nobody else is trading.
 * Empty is also what a failure returns: a solver that stops settling because it could not read
 * the mempool has turned a cheap blindness into an expensive outage.
 *
 * **The addresses this solver calls its own.** The sending account, and the batch executor when
 * one is named. The executor matters because our own credit ring is addressed to it and sent
 * from this account — `mine` matches on `from`, so the account alone is enough today, and naming
 * the executor as well costs nothing and survives somebody relaying for us later.
 */
/** A claim still pending this many blocks after it was first seen is stuck, and stops counting. */
const claimAges = new ClaimAges(5)

async function claimedLegKeys(): Promise<ReadonlySet<string>> {
  if (!watchPool) return new Set()
  if (poolSkips > 0) {
    poolSkips--
    return new Set()
  }
  try {
    const mine = [account.address, ...(creditExecutor ? [creditExecutor] : [])]
    // A claim must go to the settlement (or an executor), and pay a tip that can land. The
    // floor is a tenth of ours: on 943 a 7 wei tip sat unmined and 1 gwei lands.
    const [pool, block] = await Promise.all([
      readRivalClaims(client, { mine, settlement: SETTLEMENT, minPriorityFee: PRIORITY_FEE / 10n }),
      client.getBlockNumber(),
    ])
    pool.claims = claimAges.fresh(pool.claims, block)
    pool.claimed = claimedKeys(pool.claims)
    if (poolWait > 0) log('the mempool is readable again')
    poolWait = 0
    if (pool.source !== poolSource) {
      poolSource = pool.source
      log(`watching the mempool through ${pool.source}`)
    }
    for (const c of pool.claims) {
      // The maker and the sender, so an operator can tell a rival solver from their own second
      // bot. Never the calldata and never a URL — see `redact`.
      log(
        `  claimed ${c.intent.maker.slice(0, 10)}… by ${c.from.slice(0, 10)}… ` +
          `in ${c.call}${c.skipInvalid ? ' (tolerant)' : ''} · tx ${c.hash.slice(0, 12)}…`,
      )
    }
    return pool.claimed
  } catch (e) {
    // `why` redacts. A raw viem error carries the whole request URL, registry key and all.
    poolWait = poolWait === 0 ? 1 : Math.min(poolWait * 2, POOL_BACKOFF_MAX)
    poolSkips = poolWait
    log(
      `the mempool is not readable, so rings are built blind to rivals · ` +
        `retrying in ${poolWait} ${poolWait === 1 ? 'pass' : 'passes'} · ${why(e)}`,
    )
    return new Set()
  }
}

let settled = 0
/** Legs that filled inside a packed batch. Counted apart from rings, because they are not rings. */
let batchLegs = 0
let consecutiveFailures = 0

/**
 * The ledger, read back from the last run. A missing or unreadable file is a fresh ledger and not
 * a reason to refuse to start — the worst it costs is an hour of relearning.
 */
const trust = ((): MakerTrust => {
  const policy = { maxUnprovenPerRing }
  if (maxGriefNative === null || !existsSync(trustFile)) return new MakerTrust(policy)
  try {
    return MakerTrust.from(JSON.parse(readFileSync(trustFile, 'utf8')), policy)
  } catch {
    log(`trust ledger at ${trustFile} could not be read — starting from an empty one`)
    return new MakerTrust(policy)
  }
})()

/** Written after any tick that changed it, so a restart keeps what the last hours taught. */
let trustDirty = false
function saveTrust(): void {
  if (!trustDirty || maxGriefNative === null) return
  trustDirty = false
  try {
    writeFileSync(trustFile, `${JSON.stringify(trust.toJSON(), null, 2)}\n`)
  } catch (e) {
    // A ledger that cannot be written is a bot that relearns on restart. That is a worse bot, not
    // a broken one, so say it once a tick and keep settling.
    log(`could not write ${trustFile}: ${why(e)}`)
  }
}

/** A leg of this maker's filled. Every doubt about them is answered. */
function creditMaker(maker: Address): void {
  if (maxGriefNative === null) return
  if (!trust.proven(maker)) log(`  maker ${maker.slice(0, 10)}\u2026 has now settled for this solver`)
  trust.settled(maker)
  trustDirty = true
}

/**
 * Where this run's offers come from.
 *
 * The board is the transport and the store is the order book; this is the seam between them, and
 * `--seed` is the same seam fed from a file instead of a node. That is not a convenience: without
 * it there is no way to put an offer in front of this bot except by posting it to a real board,
 * so the whole loop below — ranking, packing, refusing — could only ever be exercised against
 * whatever the world happened to be offering. The lab chain has no board at all, which is how a
 * flag as consequential as `--batch` reached this file with nothing but its own guards tested.
 *
 * A seeded message takes the identical path a posted one does: same decode, same signature check,
 * same `store.ingest`. A second ingest path would be a second set of rules, and the one that
 * never runs in production is the one that drifts.
 */
const seedFile = arg('seed', '')

/**
 * Where the last delta read stopped. `0n` asks for the whole board, which is what the first read
 * of the process wants and every read after it does not.
 */
let boardFrom = 0n

/**
 * What a message turned out to be, keyed by its hash, so the second sighting is free.
 *
 * A delta read overlaps four blocks on purpose, and a maker's keep-alive re-posts an offer the
 * board has already shown us, so the same bytes arrive again and again. Decoding them is cheap.
 * Recovering an ECDSA signature is not, and `decimalsOf` reaches the chain for a token it has not
 * seen. Neither answer can change for a given hash — the payload carries the signature, so the
 * bytes decide the verdict — which is exactly what makes it cacheable.
 *
 * `null` is a verdict too: a message that failed to decode or failed to verify is refused once
 * and never re-examined. A token whose decimals the chain would not give up is not a verdict. The
 * read may have failed, so `VerdictCache` asks again on later passes and gives up after five.
 *
 * **It caches the CHECK and not the ingest.** `store.ingest` still runs for every sighting, every
 * pass, because that is what records the offer as still live. Skipping it for a hash we had seen
 * before would age out an intent the maker is actively keeping alive.
 */
type Checked = { intent: SignedIntent; decimalsIn: number; decimalsOut: number }

/**
 * A bound on the cache, because the board ages messages off and this process does not.
 *
 * Eviction is oldest-first and a Map iterates in insertion order, so the front of it is the least
 * recently learned. Evicting one that is still live costs a single re-verification and nothing
 * else, which is why a crude bound is the right one here.
 */
const verdicts = new VerdictCache<Checked>(20_000)

/** Pull the board — or the seed file — into the store. */
async function ingestBoard(): Promise<{ kept: number; read: number }> {
  /*
   * A delta, not the whole board.
   *
   * This asked for the entire category on every pass, then re-decoded and re-verified every
   * message it had already seen. `readIntentsSince` exists in the SDK for exactly this and
   * nothing called it — its own comment says "the only way to stop re-reading the board every
   * poll is to move `fromBlock` forward, and that is this". At a ninety-second tick the waste was
   * affordable. It is what made a per-block tick unaffordable, so it goes first.
   *
   * A seed file is the same seam fed from disk and has no block to start from, so it is read
   * whole every time. It is a lab fixture and small.
   */
  let messages: readonly { data: Hex; hash: string }[]
  if (seedFile) {
    messages = JSON.parse(readFileSync(seedFile, 'utf8')) as { data: Hex; hash: string }[]
  } else {
    const delta = await readIntentsSince(boardFrom, boardRpc.url)
    messages = delta.messages
    boardFrom = delta.nextFrom
  }

  const blockNumber = await client.getBlockNumber()
  const seenAt = Math.floor(Date.now() / 1000)
  let kept = 0

  for (const { hash, data, verdict } of await verdicts.resolve(messages, check)) {
    const ok = await store.ingest(chainId, {
      intent: verdict.intent,
      data,
      msgHash: hash as Hex,
      blockNumber,
      firstSeenAt: seenAt,
      source: 'live',
      decimalsIn: verdict.decimalsIn,
      decimalsOut: verdict.decimalsOut,
    })
    if (ok) kept++
  }
  return { kept, read: messages.length }
}

/** Decode one message, verify its signature, and price its two decimal places. */
async function check(data: Hex): Promise<Checked | null | 'unknown'> {
  const intent = await readIntent(data, chainId) // null unless it decodes and verifies
  if (!intent) return null
  const [decimalsIn, decimalsOut] = await Promise.all([
    decimalsOf(intent.tokenIn),
    decimalsOf(intent.tokenOut),
  ])
  // Both sides, or neither. Sizing a leg against a guessed decimal place is how a solver takes
  // a maker's whole balance for what it thinks is rounding dust. Unknown, not refused: the read
  // may only have failed, and the board offers this message once.
  if (decimalsIn === null || decimalsOut === null) return 'unknown'
  return { intent, decimalsIn, decimalsOut }
}

/** The token path of a plan, for a log line that only has to name which plan it means. */
const pathOf = (plan: Plan) => plan.sized.legs.map((l) => l.leg.receives.slice(0, 6)).join('→')

/** What a plan looks like in one line of a log. */
function describe(plan: Plan): string {
  const path = pathOf(plan)
  const kinds = plan.sized.legs.map((l) => (l.leg.kind === 'intent' ? 'i' : 'p')).join('')
  const net = plan.netNative === null ? 'unpriced' : pls(plan.netNative)
  return (
    `${path}→ (${kinds}) take=${plan.sized.entryTake} profit=${plan.profit} ` +
    `${plan.profitToken.slice(0, 8)} gas=${plan.gas} net=${net}`
  )
}

/**
 * The plan's own ledger, per token: what the ring hands the executor against what it owes.
 *
 * A credit ring settles through `fillBatchWithCallback`, which releases every leg before it
 * collects anything, so a ring that closes needs no capital at all. When the chain answers
 * `ERC20InsufficientBalance` naming the batch executor, one of two things is true, and the log
 * could not tell them apart: either the plan never balanced, or it balanced when it was planned
 * and no longer did when it ran.
 *
 * So print the arithmetic the plan was built on. A negative line here means the plan itself is
 * short and the bug is in sizing; all-zero-or-positive lines mean the plan was sound and
 * something moved between planning and execution.
 *
 * `pay` is the leg's gross, and the fee comes out of it rather than riding on top, so the fee is
 * already in these numbers — worth stating, because "the sizing forgot the fee" is the first
 * guess and it is wrong.
 */
function ledger(plan: Plan): string {
  const net = new Map<string, bigint>()
  for (const l of plan.sized.legs) {
    // The executor receives `take` of the token this leg hands over, and pays `pay` of the next.
    net.set(l.leg.receives, (net.get(l.leg.receives) ?? 0n) + l.take)
    net.set(l.leg.pays, (net.get(l.leg.pays) ?? 0n) - l.pay)
  }
  return [...net]
    .map(([t, v]) => `${t.slice(0, 8)} ${v >= 0n ? '+' : ''}${v}`)
    .join(' · ')
}

/**
 * The plan's numbers against the settlement's own, leg by leg.
 *
 * The ledger above only ever compares the plan with itself, which is why it kept reporting a
 * balanced ring beside a chain that refused it. `quote` is the authority: it is what the
 * settlement will actually charge for `take` at that timestamp, fee included. If a line here
 * differs, the plan and the chain disagree about the price of a leg and that is the whole bug.
 * If every line matches, the disagreement is about something other than the amounts.
 */
async function planVsChain(plan: Plan): Promise<string[]> {
  const at = (await client.getBlock({ blockTag: 'latest' })).timestamp
  const out: string[] = []
  for (let k = 0; k < plan.fills.length; k++) {
    const f = plan.fills[k]
    const sized = plan.sized.legs.find(
      (l) => l.leg.kind === 'intent' && l.leg.entry.intent.nonce === f.intent.nonce,
    )
    try {
      const q5 = (await client.readContract({
        address: SETTLEMENT,
        abi: SOLVER_SETTLEMENT_ABI,
        functionName: 'quote',
        args: [f.intent as never, f.take, at],
      })) as unknown as { delivered: bigint; feeOut: bigint; feeProceeds: bigint }
const [delivered, fee] = [q5.delivered, q5.feeOut + q5.feeProceeds]
      // The two halves of the split add back up to the executor's outlay: the maker takes
      // `delivered`, the destination takes `fee`, and whoever sends the transaction parts with
      // both. That identity survived the change, which is why this line did not.
      const chain = delivered + fee
      const planned = sized?.pay ?? 0n
      out.push(
        `    leg ${k} take=${f.take} plan pays ${planned}, chain charges ${chain}` +
          (planned === chain ? ' — agree' : ` — DIFFER by ${chain - planned}`),
      )
    } catch (e) {
      out.push(`    leg ${k} quote failed: ${why(e)}`)
    }
  }
  return out
}

/**
 * How many of this account's transactions the chain has taken, and how many it is still holding.
 *
 * A gap is not a queue that will drain. Nonces are strictly ordered, so one transaction the
 * validators will not take stops every later one from this account, however well priced. On 943
 * that is exactly what happened: two rings went out at a zero tip, and the seventy-four behind
 * them sat in the mempool until they expired while the bot logged confirmation timeouts and
 * cheerfully sent more.
 */
async function nonceGap(): Promise<number> {
  const [mined, queued] = await Promise.all([
    client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    client.getTransactionCount({ address: account.address, blockTag: 'pending' }),
  ])
  return queued - mined
}

// ── The packed batch ──────────────────────────────────────────────────────────

/**
 * The router a plan's closing swap must go to.
 *
 * Not "the chain's router" — the chain lists two. A plan is priced against one venue's pool, and
 * the other venue's router walks a different curve over different reserves, so the `amountOutMin`
 * the plan computed would be a bound on the wrong pool. `execute.ts` keeps its own copy of this
 * for the ring path; `packBatch` asks the caller instead of guessing, so this is the answer.
 */
/**
 * Why a batch simulation refused, named rather than numbered.
 *
 * `settleRing` can revert three contracts deep — in the executor, in the settlement, in a token,
 * or in the venue the route swaps through — and viem only knows the ABI of the contract it
 * called. Hand `explainRevert` every ABI on the path and the same failure prints its name.
 *
 * Redacted on the way out: a viem error that never reached a contract carries the whole URL.
 */
const batchReason = (e: unknown): string =>
  redact(
    explainRevert(e, [
      SOLVER_SETTLEMENT_ABI,
      SOLVER_BATCH_EXECUTOR_ABI,
      ROUTER_ABI,
    ] as never),
  )

/**
 * Simulate a packed batch, price it on the gas that measured, and send it.
 *
 * The simulation is the ground truth here for the reason it is on the ring path, and for one
 * more. `skipInvalid` is true, so a batch that settles nothing at all still succeeds and still
 * pays for every leg it tried; the arithmetic cannot tell you that and only the dry run can.
 */
/**
 * Why a leg the chain said was fillable produced no `Filled` event, and whether the maker owes
 * this solver for it.
 *
 * The receipt alone cannot say. A stepped-over leg looks identical whether a rival took it or
 * whether its arming signature was never going to redeem, and getting that wrong is the one
 * mistake `trust.ts` is emphatic about: a leg a competitor wanted is the most desirable offer on
 * the book, and counting it as a fault would quietly penalise exactly those.
 *
 * So ask the chain again, after the block, and let `faultsMaker` judge the answer. That call is
 * the whole decision and it lives in the SDK beside the ledger it feeds, named reason by reason,
 * because it is the part that has to be right.
 *
 * One read, and only on the exception path. A batch where every leg fills asks nothing.
 */
async function blameFor(plan: Plan, at: bigint): Promise<string> {
  const fill = plan.fills[0]
  const maker = fill.intent.maker
  if (maxGriefNative === null) return 'somebody else got there first'
  let reason: FillReason
  try {
    reason = await readFillability(fill.intent, fill.take, account.address, { chainId })
  } catch (e) {
    // A read that failed says nothing about the maker, so it must not count against them.
    return `could not tell why: ${why(e)}`
  }
  if (!faultsMaker(reason)) return `${reason} · the book moved under it`
  trust.couldNotArm(maker, at)
  trustDirty = true
  const faults = trust.faults(maker, at)
  return trust.dropped(maker, at)
    ? `still fillable · could not be armed · ${faults} failures — dropped from planning`
    : `still fillable · could not be armed · ${faults} of ${DEFAULT_TRUST.dropAfter}`
}

async function sendBatch(
  executor: Address,
  packed: PackedBatch,
  txFees: Awaited<ReturnType<typeof fees>>,
  prices: PriceBook,
  gasPrice: bigint,
  minNetNative: bigint,
): Promise<void> {
  const call = settleBatchCall(executor, packed.fills, packed.maxFeeRate, packed.route)
  const legs = packed.packed.length

  let gas: bigint
  try {
    const sim = (await client.simulateContract({
      account: account.address,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)) as unknown as { result: bigint }
    // How many legs the chain says will settle. A short count is not the tolerance working — it
    // is the batch already being stale, before a block has even passed. The count alone does not
    // say WHICH leg died, so there is no honest way to re-price the rest, and a batch priced on
    // legs that will not fill is one nobody checked the arithmetic of. Drop it: the next tick
    // reloads the book, the dead intent fails its fillability read, and the rest re-pack.
    if (sim.result !== BigInt(legs)) {
      log(`  batch skipped · the chain would settle ${sim.result} of ${legs} · re-planning`)
      return
    }
    gas = await client.estimateContractGas({
      account: account.address,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)
  } catch (e) {
    log(`  batch skipped · the chain refuses it: ${batchReason(e)}`)
    return
  }

  // One measured figure for the whole transaction, shared out so each plan can be re-priced on
  // it. The remainder rides on the first leg rather than being dropped, so the shares add back
  // up to the gas the chain will actually charge.
  const n = BigInt(legs)
  const priced = packed.packed.map((p, i) =>
    withSimulatedGas(p, gas / n + (i === 0 ? gas % n : 0n), prices, gasPrice),
  )
  const net = priced.reduce<bigint | null>(
    (sum, p) => (sum === null || p.netNative === null ? null : sum + p.netNative),
    0n,
  )
  const clears = batchNetClears(priced, minNetNative, unpricedOk)

  // One transaction, one margin. `--min-profit-native` covers what moves between the simulation
  // and the block — the base fee, mostly — and that is a property of the transaction, not of a
  // leg. Charging it per leg would refuse a batch of eight thin legs that between them clear it
  // eight times over, which is the case batching exists to catch. A null net means a token could
  // not be priced, and it passes only in a token `--unpriced-ok` names.
  if (!clears) {
    log(`  batch skipped · ${gas} gas over ${legs} legs eats it: net ${net === null ? 'unpriced' : pls(net)}`)
    return
  }

  // A margin over the measured figure, the same 25% `ExecuteOptions.gasBufferBps` defaults to.
  // An estimate is the smallest limit that works, so sending at exactly the estimate is sending
  // at the edge: one warm slot different at inclusion and the batch runs out of gas with legs
  // half settled. Gas unburnt is not charged, so the margin costs nothing.
  const hash = await wallet.writeContract({
    account,
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    gas: (gas * 12_500n) / 10_000n,
    ...txFees,
  } as never)
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    log(`  FAIL the batch reverted: ${hash}`)
    return
  }

  // Which legs the block actually took. `Filled` is the settlement's own record, and it is the
  // only thing that can answer this: a tolerant batch succeeds whether it fills eight legs or one.
  const settledAt = (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp
  const paid = deliveredFromLogs(receipt.logs, SETTLEMENT)
  let filled = 0
  for (const plan of priced) {
    const intent = plan.fills[0].intent
    if (!paid.has(intentHashOf(intent, chainId).toLowerCase())) {
      // The tolerant path doing its job: a rival took this leg, or its maker cancelled, in the
      // window between the simulation and the block. It cost about 15,982 gas and the rest filled.
      //
      // This branch has to come first. `makersShortChanged` reads a leg with no `Filled` event as
      // paid zero, and zero is short of anything a maker is owed — so running it over a stepped-
      // over leg raises the one alert this bot exits on, for the exact case `--batch` exists to
      // allow.
      log(`  leg ${intent.maker.slice(0, 10)}… stepped over · ${await blameFor(plan, settledAt)}`)
      continue
    }
    filled++
    creditMaker(intent.maker)
    // The assertion this bot exists for, per leg. The block's own timestamp decides what the
    // maker was owed: a Dutch intent that lands a second late is owed a shade less, not the same.
    const short = makersShortChanged(plan, receipt.logs, settledAt, chainId, SETTLEMENT)
    for (const s of short) log(`ALERT ${s.maker} signed for ${s.owed} and received ${s.got}`)
    if (short.length > 0) process.exit(2)
  }

  batchLegs += filled
  log(
    `  batch settled ${hash.slice(0, 12)}… ${filled} of ${legs} legs · gas ${receipt.gasUsed} · ` +
      `${batchLegs} legs batched so far`,
  )
}

async function tick() {
  // Before anything else. A blocked account cannot settle, and sending into the block only
  // burns nonces — the pass costs reads either way, so stop at the top and say so.
  const stuck = await nonceGap()
  if (stuck >= STUCK_LIMIT) {
    log(
      `STUCK ${stuck} transactions are queued behind one the chain will not take. ` +
        `Nothing can settle until they are replaced. Not sending.`,
    )
    return
  }

  const { kept, read } = await ingestBoard()

  // Price against the chain's clock, never this machine's.
  //
  // A decaying offer costs less as its window runs, so the timestamp a ring is priced at decides
  // what every leg costs. The settlement uses `block.timestamp`. This used `Date.now()`, which on
  // the bot host runs 0 to 8 seconds ahead of the latest block — one block time on a 10-second
  // chain. So the solver priced each leg a few seconds into the future, where it is cheaper,
  // sized the ring to close exactly at those prices, and the settlement then charged the higher
  // price for its own earlier timestamp. The batch executor came up short by the difference and
  // the whole ring reverted.
  //
  // Measured on 2026-08-28: two legs of one ring, plan against `quote`, differing by 27 and 16
  // parts per million — about a second of drift each. Tiny against a leg, and fatal to a cycle
  // sized to close with nothing to spare.
  //
  // The block's timestamp is also the safe end of the error. It is behind the block this will
  // actually land in, and a later block means less is owed, so a ring priced here closes with a
  // margin rather than without one.
  const at = (await client.getBlock({ blockTag: 'latest' })).timestamp
  const now = Number(at)

  const { book, rejected } = await loadBookFromStore(now, {
    executor: account.address,
    client,
    chainId,
    settlementAddress: SETTLEMENT,
    store,
    limit: bookLimit,
    // One `balanceOf` per contended `(maker, token)`, and none at all in a book where no maker
    // has two live intents on one token. `selectFeasible` needs it to know that two offers from
    // one maker can share a balance that only covers one of them.
    funds: true,
  })

  if (book.entries.length === 0) {
    log(`pass · ${read} read, ${kept} taken · nothing the chain will fill · ${rejected.length} refused`)
    return
  }

  // Pools for every pair the book touches, so a ring can close through PulseX as well.
  const pairs: [Address, Address][] = []
  if (useAmm) {
    for (const k of book.byPair.keys()) {
      const [a, b] = k.split('>') as [Address, Address]
      pairs.push([a, b])
    }
  }
  // Pools become markets before the engine sees them. Discovery stays xyk's own business —
  // `getPair` on a factory, reserves off the pair — and only the answer crosses into the search,
  // which knows a market by four questions and never learns what kind it is.
  const pools = useAmm ? await loadPools(pairs, { client, chainId }) : undefined
  const markets = pools
    ? xykMarkets(pools, (pool) => xykVenue(pool.venue, chainId)?.router ?? xykRouter(chainId))
    : undefined
  const prices = await loadPrices(book.tokens, { client, chainId })
  const gasPrice = await gasPriceWei()

  /**
   * The legs a rival is already sending for, read as late as possible before the search.
   *
   * Here and not at the top of the tick, for two reasons. A mempool answer is stale the moment a
   * block lands, so the fewer reads between this and `solve` the better. And a pass over an empty
   * book returns above without ever getting here, so an idle solver pays nothing for the watch.
   *
   * It rides the block-driven pass and adds no clock of its own.
   */
  const claimed = await claimedLegKeys()
  // The cap every send this pass carries, read once here rather than per transaction. A solver
  // stays up for weeks, and a cap built at startup sits below a base fee that has since moved —
  // on 369 that base fee is around 710,000 gwei, so the node refuses the send and nothing lands.
  const txFees = await fees(client)
  const minNetNative = BigInt(Math.floor(Number(minProfitNative) * 1e18))

  const params = {
    at,
    executor: account.address,
    prices,
    gasPrice,
    markets,
    minNetNative,
    unpricedOk,
    maxPerPair: depth,
    maxRings,
    maxLegs,
    // No ring is built around a leg somebody else has a pending transaction over. A ring sends
    // `skipInvalid` false by default, so losing that race costs 222,044 gas and earns nothing,
    // against an opportunity forgone that the Dutch curve usually hands back next block worth
    // slightly more. See `mempool.ts` for the asymmetry that makes believing the pool the cheap
    // error. It stays true under `--tolerant`: one rule is easier to reason about than two, and
    // `SolveParams.claimed` argues the trade.
    claimed,
    ...(creditExecutor ? { gasModel: CREDIT_GAS_MODEL } : {}),
  }

  // `selectDisjoint` is necessary and not sufficient. It knows two plans must not share an
  // intent, and nothing about the three ways a maker's own offers collide: an EIP-2612 nonce
  // orders their permits, so dropping the earlier one kills the later one's signature; one
  // balance can only fund one of two offers against it; and one parked row is a pool two legs
  // armed from parked capital draw on together.
  const ranked = selectFeasible(solve(book, params), { groups: groupsFromBook(book) })

  /**
   * How many unproven legs this pass will carry, from the loss the operator named.
   *
   * Recomputed every tick, because the answer depends on the gas price and that is the whole
   * point of expressing the policy as a loss rather than as a leg count: the same cap buys fewer
   * chances when gas is dear.
   */
  const budget =
    maxGriefNative === null
      ? Number.POSITIVE_INFINITY
      : unprovenBudget({ maxGriefNative, gasPrice, gasModel: params.gasModel })

  // Refuse before ranking is spent on them. A dropped maker is out on every path; the count of
  // unproven legs is checked per plan here and again across the packed batch below, because the
  // budget is a bound on one transaction and a batch is one transaction.
  const plans =
    maxGriefNative === null
      ? ranked
      : ranked.filter((p) => {
          if (admits(p.ring, trust, at, budget)) return true
          const unproven = unprovenLegs(p.ring, trust).length
          log(`  declined ${pathOf(p)} · ${unproven} unproven legs, budget ${budget}`)
          return false
        })
  const later = upcoming(book, params, horizonS)

  log(
    `pass · ${book.entries.length} fillable · ${rejected.length} refused · ` +
      `${plans.length} rings now · ${later.length} within ${horizonS}s · gas ${gasPrice} wei` +
      (claimed.size === 0 ? '' : ` · ${claimed.size} legs claimed by a rival`) +
      (maxGriefNative === null ? '' : ` · ${budget} unproven legs affordable`),
  )
  for (const { at: when, usesMarket: pooled } of later.slice(0, 3)) {
    log(`  waiting ${when - at}s for a ${pooled ? 'pool-closed' : 'pure'} ring to open`)
  }

  // One options object for every send this pass makes. It carries the fees, and it has to:
  // a send that lets the node pick can go out with a zero tip, and one of those blocks every
  // later nonce from this account until it is replaced. See `ExecuteOptions.maxFeePerGas`.
  const opts = {
    account: account.address,
    client,
    chainId,
    settlementAddress: SETTLEMENT,
    ...(creditExecutor ? { batchExecutor: creditExecutor } : {}),
    ...txFees,
    // The same set again, one layer down. `solve` refused every ring that named a claimed leg,
    // so this should never fire — it is the belt to that pair of braces. If a claimed leg reaches
    // an atomic batch by some path nobody thought of, `orderAtomicLegs` puts it first, where the
    // break costs 121,329 gas instead of 554,731.
    confidence: { claimed },
  }

  // The deadline the venue call inside a credit route carries, and the one the old path's
  // second transaction uses. One number, so the two paths cannot drift apart on it.
  const deadline = at + 300n

  // Split the ranking: what can share a tolerant transaction, and what cannot.
  //
  // `packBatch` is the authority on which is which, and it refuses rather than dropping — a ring,
  // a plan with no swap of its own, an intent another packed plan already spends, and everything
  // past the leg cap. Its refusals go down the per-plan path below exactly as they always have,
  // so nothing about a ring changes: it still simulates and settles atomically, on its own.
  //
  // The reasons are logged and not counted. "It is a ring" and "an intent is already spoken for"
  // are different problems with different answers, and a solver that cannot see why its best
  // candidate did not go out will never learn.
  //
  // No `disposal`, so each leg's surplus sweeps home in whatever token it fell out in. Naming one
  // is a decision about which token this bot wants to end the day holding, and nobody has made it.
  /**
   * The budget is a bound on one transaction, and a packed batch is one transaction.
   *
   * Every plan here is individually inside it, which says nothing about eight of them together.
   * Trim before packing rather than after: `packBatch` decides the leg order and the route, and
   * a batch pulled apart afterwards is one nobody checked the arithmetic of. What falls out here
   * goes down the single path below, where it meets the tighter atomic limit on its own.
   */
  const packable = ((): Plan[] => {
    if (maxGriefNative === null) return plans
    const kept: Plan[] = []
    let unproven = 0
    for (const p of plans) {
      const cost = unprovenLegs(p.ring, trust).length
      if (unproven + cost > budget) continue
      unproven += cost
      kept.push(p)
    }
    if (kept.length < plans.length) {
      log(`  ${plans.length - kept.length} plans held back · the batch is at its ${budget}-leg budget`)
    }
    return kept
  })()

  const packed = batchExecutor
    ? packBatch(packable, { batchExecutor, deadline })
    : null
  const singles = packed
    ? [...packed.refused.map((r) => r.plan), ...plans.filter((p) => !packable.includes(p))]
    : plans

  if (packed) {
    for (const p of packed.packed) log(`  packed ${describe(p)}`)
    for (const r of packed.refused) log(`  not packed ${pathOf(r.plan)} · ${r.why}`)
    // Nothing is sent on a dry run, but the packing itself is the thing worth watching: it is how
    // an operator finds out what `--batch` would have done before letting it spend anything.
    if (execute && batchExecutor && packed.packed.length > 0) {
      await sendBatch(batchExecutor, packed, txFees, prices, gasPrice, minNetNative)
    }
  }

  for (const plan of singles) {
    log(`  ring ${describe(plan)} capital=${plan.capitalNative === null ? '?' : pls(plan.capitalNative)}`)
    if (!execute) continue
    if (plan.swap && !useAmm) continue

    // A ring is atomic, so one leg that will not arm costs the whole attempt rather than one
    // leg's worth of gas. That is a different limit from the batch budget and it is set apart:
    // `--max-unproven-per-ring`, which defaults to no limit because a fresh ledger has proven
    // nobody and the SDK's own default of one would refuse every two-leg ring forever.
    if (maxGriefNative !== null && !admits(plan.ring, trust, at, maxUnprovenPerRing)) {
      const unproven = unprovenLegs(plan.ring, trust).length
      log(`  skipped · atomic, and ${unproven} legs are unproven (limit ${maxUnprovenPerRing})`)
      continue
    }

    // On credit the executor holds the released tokens and approves the relayer itself, so this
    // wallet grants nothing. On the old path it has to approve before it can pay a maker.
    if (!creditExecutor) await ensureApprovals(wallet, plan, opts)

    /*
     * A market for every leg this ring could lose, when the operator asked for one.
     *
     * `markets` is the same lookup the search used, so a fallback prices against the reserves
     * this pass already read. A leg the planner cannot cover is logged with its reason and not
     * quietly dropped: "no market lists this direction" is a discovery gap, and "the market asks
     * more than the leg frees" is this ring's own edge being real — the second is common, and it
     * is what an operator needs to see before believing tolerance would have helped them.
     *
     * Per plan, spread into the pass's options, because a tolerant plan describes one ring's legs
     * by index and `routeFor` refuses one built for another.
     */
    const tolerant =
      tolerantRings && markets ? planTolerantRing(plan, { markets }) : undefined
    if (tolerant) {
      log(
        `  tolerant · ${tolerant.fallbacks.length} of ${plan.fills.length} legs covered · ` +
          `${tolerant.carriedGas} gas carried` +
          (tolerant.complete ? '' : ' · this ring still reverts on the rest'),
      )
      for (const r of tolerant.refused) log(`    leg ${r.fill} uncovered · ${r.why}`)
    }
    const ringOpts = tolerant ? { ...opts, tolerant } : opts

    // The simulation is the ground truth, not the arithmetic.
    const sim = creditExecutor
      ? await simulateCreditRing(plan, ringOpts, deadline)
      : await simulateRing(plan, opts)
    if (!sim.ok) {
      log(`  skipped · the chain refuses it: ${sim.reason}`)
      // A short balance is the one refusal the reason alone cannot explain, so show the plan's
      // own books beside it. See `ledger`.
      if (sim.reason.includes('InsufficientBalance')) {
        log(`    plan ledger · ${ledger(plan)}`)
        for (const line of await planVsChain(plan)) log(line)
      }
      continue
    }

    const priced = withSimulatedGas(plan, sim.gas, prices, gasPrice)
    if (!netClears(priced, minNetNative, unpricedOk)) {
      log(`  skipped · ${sim.gas} gas eats it: net ${priced.netNative === null ? 'unpriced' : pls(priced.netNative)}`)
      continue
    }

    const hash = creditExecutor
      ? await executeCreditRing(wallet, priced, ringOpts, deadline)
      : await executeRing(wallet, priced, opts)
    const receipt = await client.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') {
      log(`  FAIL the batch reverted: ${hash}`)
      continue
    }
    settled++
    log(`  settled ${hash.slice(0, 12)}… gas ${receipt.gasUsed} · ${settled} rings so far`)

    /*
     * Which legs the block actually took, and why a tolerant ring cannot be counted the old way.
     *
     * An atomic ring settling means every leg of it settled, so every maker is proven and every
     * maker must have been paid. A tolerant ring settles whichever legs armed, and a market stood
     * in for the rest. Crediting a maker who never filled would teach the ledger the opposite of
     * what happened, and `makersShortChanged` reads a leg with no `Filled` event as paid zero —
     * which is short of anything, and raises the one alert this bot exits on for the exact case
     * `--tolerant` exists to allow.
     *
     * `deliveredFromLogs` is the settlement's own record and the only thing that can answer it.
     * The atomic path asks too, rather than trusting the shape: it costs one pass over logs that
     * are already in hand, and a ring that settled without paying somebody is the fault this
     * whole check exists to catch.
     */
    const settledAt = (await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp
    const paid = deliveredFromLogs(receipt.logs, SETTLEMENT)
    const landed = priced.fills.filter((f) =>
      paid.has(intentHashOf(f.intent, chainId).toLowerCase()),
    )
    for (const fill of landed) creditMaker(fill.intent.maker)
    const stepped = priced.fills.length - landed.length
    if (stepped > 0) {
      // An atomic ring reaching here short is not tolerance, it is the plan and the chain
      // disagreeing about what a settled ring is. Say which one this was.
      log(
        tolerant
          ? `  ${stepped} leg(s) went to a market instead · the fallback did its job`
          : `  WARN an atomic ring settled ${landed.length} of ${priced.fills.length} legs`,
      )
    }

    // The assertion this bot exists for. A unit test proves the code is right; this proves the
    // deployed system is right, continuously. The block's own timestamp decides what each maker
    // was owed: a Dutch intent that lands a second late is owed a shade less, not the same.
    //
    // Over the legs that landed, never over the plan. A stepped-over leg is not an underpaid
    // maker, and calling it one would exit the bot on a success.
    const short = makersShortChanged({ ...priced, fills: landed }, receipt.logs, settledAt, chainId, SETTLEMENT)
    if (short.length > 0) {
      for (const s of short) log(`ALERT ${s.maker} signed for ${s.owed} and received ${s.got}`)
      process.exit(2)
    }

    if (priced.swap && !creditExecutor) {
      // The pool leg is a second transaction. `amountOutMin` is what the ring owes, so a pool
      // that moved under us reverts here rather than settling the position at a loss.
      //
      // On credit it is not a second transaction at all: the swap ran inside the callback and
      // settled or reverted with the ring. That is the whole reason to prefer that path with
      // `--amm` on.
      const swapHash = await executeSwap(wallet, priced, opts, deadline)
      const swapReceipt = await client.waitForTransactionReceipt({ hash: swapHash })
      log(
        `  closed through the pool ${swapHash.slice(0, 12)}… ` +
          `gas ${swapReceipt.gasUsed} · ${swapReceipt.status}`,
      )
    }
  }

  // One write per tick, and only when something moved. The ledger is the hours this bot has spent
  // learning who wastes its gas; a restart that forgets it starts that clock again.
  saveTrust()
}

// ── One-time funding ──────────────────────────────────────────────────────────

/**
 * Gas for the batches this bot settles. Per chain, because the two chains are not comparable.
 *
 * 943 charges 7 wei of base fee, so 50 PLS buys more batches than this bot will ever send.
 *
 * 369 charges about 710,000 gwei. A single fill there costs 138,560 to 333,212 gas, measured over
 * fourteen real fills, and a two-leg ring settles both legs in one `fillBatch`. Call it 500,000
 * gas, which is 355 PLS to spend — and viem refuses to send unless the account holds
 * `gas * maxFeePerGas`, so with `feesAt` capping at four times the base fee it reserves about
 * 1,420 PLS per batch. The cap is never charged and the pre-flight refusal is real, which is how
 * the executor stopped at `insufficient funds: have 876 want 1,136`.
 *
 * 500,000 PLS is $6.90 and roughly 350 batches. That matches what the executor holds, and gas is
 * not the thing to economise on when the float behind the bot is worth $15.
 */
const FUND_GAS: Record<ChainId, bigint> = {
  943: parseEther('50'),
  369: parseEther('500000'),
}

/**
 * The float a ring is entered with, per chain and in whole units.
 *
 * The solver fronts the payout leg, so it needs the tokens the ring pays out in. On 943 that is
 * sized against a 400 tUSDC / 10,000 tPLSX pool.
 *
 * The 369 row is $5 of each token at the mid prices of 2026-08-23 — WPLS $0.00001368, PLSX
 * $0.00001237, DAI $1 — which is the size the owner chose for the executor on the same day. Three
 * tokens, because the heartbeat quotes WPLS/PLSX, WPLS/DAI and PLSX/DAI, and a ring can pay out in
 * any of them. The whole float is the loss ceiling: a ring the solver cannot cover is a ring it
 * does not settle.
 *
 * **This table was `{ tUSDC, tPLSX }` with no chain key.** `presetTokens(369)` returns none of
 * those, so every symbol missed, the loop skipped every token, and `--fund --chain 369` printed
 * "funded" after moving no inventory at all. The warning below exists so that cannot happen
 * quietly again.
 */
const FUND_UNITS: Record<ChainId, Record<string, string>> = {
  943: { tUSDC: '30', tPLSX: '600' },
  369: { WPLS: '365000', PLSX: '404000', DAI: '5' },
}

async function fund(): Promise<void> {
  if (!deployerKey) throw new Error('--fund needs DEPLOYER_PK')
  const deployer = privateKeyToAccount(deployerKey)
  const deployerWallet = createWalletClient({ account: deployer, chain, transport: rpcTransport(chainRpc) })
  log(`funding ${account.address} from ${deployer.address}`)

  // `--fund` sends a handful of transfers and exits, so one header read covers all of them.
  const txFees = await fees(client)

  const gasTarget = FUND_GAS[chainId]
  const units = FUND_UNITS[chainId]
  const deployerBefore = await client.getBalance({ address: deployer.address })
  log(`deployer holds ${formatEther(deployerBefore)} PLS`)

  // Check the whole shopping list before sending anything.
  //
  // Gas goes first and the tokens follow, so a deployer that is short of one token used to send
  // 500,000 PLS and then revert on the transfer. That leaves the run half done: the bot has gas it
  // cannot use, and the operator has to read the log to find out how far it got. The deployer on
  // 369 is short today — it holds 20,000 WPLS against a table that asks for 365,000 — so this is
  // the normal case and not the edge one.
  const short: string[] = []
  for (const t of presetTokens(chainId)) {
    const whole = units?.[t.symbol]
    if (!whole) continue
    const need = parseUnits(whole, t.decimals)
    const [mine, theirs] = await Promise.all([
      client.readContract({
        address: t.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
      }),
      client.readContract({
        address: t.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [deployer.address],
      }),
    ])
    if (mine >= need) continue
    const gap = need - mine
    if (theirs < gap) {
      short.push(
        `${t.symbol}: needs ${formatUnits(gap, t.decimals)}, deployer holds ${formatUnits(theirs, t.decimals)}`,
      )
    }
  }
  if (short.length > 0) {
    throw new Error(
      `the deployer cannot cover the float, and nothing has been sent. ${short.join('; ')}. ` +
        'Buy the tokens on PulseX from the deployer, or lower FUND_UNITS for chain ' +
        `${chainId} to what it holds.`,
    )
  }

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
    const hash = await deployerWallet.sendTransaction({ to: account.address, value, ...txFees })
    // Mined is not landed. A reverted transfer that logs as sent leaves a solver with no gas.
    const sent = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (sent.status !== 'success') throw new Error(`the gas transfer reverted: ${hash}`)
    log(`${formatEther(value)} PLS → solver · ${hash}`)
  } else {
    log(`gas already there: ${formatEther(pls)} PLS`)
  }

  if (!units) {
    log(
      `WARN no inventory table for chain ${chainId}. Gas is funded and no tokens moved, so the ` +
        'solver can pay for a batch and has nothing to settle it with.',
    )
  }

  for (const t of presetTokens(chainId)) {
    const whole = units?.[t.symbol]
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
      ...txFees,
    })
    const sent = await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
    if (sent.status !== 'success') throw new Error(`the ${t.symbol} transfer reverted: ${hash}`)
    log(`${formatUnits(need - have, t.decimals)} ${t.symbol} → solver · ${hash}`)
  }
  // The relayer approvals are `ensureApprovals`' job, per ring and from the solver's own key.
  log('funded. The bot host needs SOLVER_KEY and nothing else.')
}

if (process.argv.includes('--fund')) {
  await fund()
  process.exit(0)
}

log(`solver starting · chain ${chainId} (${network(chainId).label}) · ${account.address}`)
log(
  `settlement ${SETTLEMENT} · ${execute ? 'live' : 'dry run'}` +
    `${useAmm ? ' · pool legs on' : ''}` +
    `${creditExecutor ? ` · credit through ${creditExecutor}` : ' · inventory path'}` +
    `${batchExecutor ? ' · packing independent plans' : ' · one plan per transaction'}` +
    ` · min profit ${minProfitNative} ` +
    network(chainId).chain.nativeCurrency.symbol,
)
log(
  `book limit ${bookLimit} · max rings ${maxRings} · up to ${maxLegs} legs · ` +
    `depth ${depth.default} by default, ` +
    `${depth.byToken?.size ?? 0} tokens named`,
)
/**
 * What tolerance would cost this bot, printed whichever way the flag went.
 *
 * On, so an operator sees the bill they signed up for. Off, so they see the number they would
 * have to beat before turning it on — which is the decision the roadmap asks somebody to make
 * with real data, and it cannot be made from a flag nobody knows the price of.
 *
 * Both figures come from `app/src/landing/gas.ts`, which `scripts/gen-gas.mjs` generates from
 * `contracts/test/Gas.t.sol` and CI checks. The carry cost is the one number here that is quoted
 * rather than generated — `contracts/test/BatchExecutor.t.sol` measures it and asserts a ceiling
 * over it, which bounds the drift without pinning it.
 */
{
  const rate = (legs: number, row: 'atomic 2, one leg gone' | 'atomic 3, one leg gone') =>
    `${(breakEvenLossRate(legs, BigInt(GAS[row].total)) * 100).toFixed(1)}% on a ${legs}-leg ring`
  log(
    `${tolerantRings ? 'tolerant rings ON' : 'tolerant rings off'} · covering up to ` +
      `${maxLegs} legs costs ${carriedFallbackGas(maxLegs)} gas on every ring · it pays above ` +
      `${rate(2, 'atomic 2, one leg gone')} and ${rate(3, 'atomic 3, one leg gone')}` +
      `${tolerantRings ? '' : ' · --tolerant turns it on'}`,
  )
}

log(
  maxGriefNative === null
    ? 'maker trust off · every maker is planned around equally. --max-grief-native turns it on'
    : `maker trust on · at most ${formatEther(maxGriefNative)} ` +
      `${network(chainId).chain.nativeCurrency.symbol} of one transaction may go to unproven ` +
      `legs · ${maxUnprovenPerRing} of them in an atomic ring · ledger ${trustFile}`,
)

/*
 * What wakes the solver.
 *
 * It used to be a timer and nothing else: run a pass, sleep ninety seconds, run another. On a
 * ten-second chain that is nine blocks blind per cycle, and every one of those blocks can move a
 * pool, land a rival's fill, or age a decaying offer into the money. A rival looking every block
 * sees an opportunity up to eighty seconds before we do, and losing a three-leg ring costs 222,044
 * gas and earns nothing — so a slow solver does not merely miss profit, it pays to lose.
 *
 * So a new block is the signal now, and the timer is demoted to a fallback.
 *
 * **The fallback is not decoration.** A block watch that dies quietly would leave the solver
 * awake and blind, which is the failure that looks healthy from outside — the process is up, the
 * logs are silent, and nothing is being settled. The heartbeat runs regardless and says so when it
 * is the only thing firing, so a dead watch shows up in the log rather than in a week of missed
 * rings.
 *
 * `watchBlockNumber` polls `eth_blockNumber` over the HTTP transport, which is one small call per
 * poll and the reason wiring the delta read came first: a pass that re-read the whole board would
 * have made this cadence expensive rather than cheap. A WebSocket subscription would be cheaper
 * still and the gateway does not serve one yet — `wss://one.valve.city/rpc/<key>/evm/943` accepts
 * the socket and then never answers `eth_subscribe`, and the same call over HTTP comes back
 * `ErrUpstreamsExhausted` from the upstream. When that is fixed, viem picks it up by being given a
 * WebSocket transport and nothing here changes.
 */
let running = false
let again = false

async function pass(why_: string): Promise<void> {
  // One pass at a time. A block that lands mid-pass sets a flag instead of starting a second one,
  // and the loop below picks it up the moment the first finishes — so the newest state is always
  // acted on, and two passes never race each other into the same ring.
  if (running) {
    again = true
    return
  }
  running = true
  try {
    do {
      again = false
      await tick()
      consecutiveFailures = 0
    } while (again)
  } catch (e) {
    consecutiveFailures++
    log(`FAIL (${consecutiveFailures}) on ${why_} · ${why(e)}`)
    if (consecutiveFailures >= 5) {
      log('five failures in a row — exiting for the supervisor to restart')
      process.exit(1)
    }
  } finally {
    running = false
  }
}

let lastBlock = 0n
let blocksSeen = 0

client.watchBlockNumber({
  emitOnBegin: true,
  poll: true,
  pollingInterval: blockPollMs,
  onBlockNumber: (n) => {
    // `watchBlockNumber` can repeat a number across polls. Only an advance is news.
    if (n <= lastBlock) return
    lastBlock = n
    blocksSeen++
    void pass(`block ${n}`)
  },
  onError: (e) => log(`block watch failed · falling back to the heartbeat · ${why(e)}`),
})

setInterval(() => {
  if (blocksSeen === 0) log('heartbeat · no block has arrived yet, so this is the only clock')
  blocksSeen = 0
  void pass('heartbeat')
}, intervalMs)

log(
  `awake on every new block · polling for one every ${blockPollMs / 1000}s · ` +
    `heartbeat every ${intervalMs / 1000}s as a fallback`,
)

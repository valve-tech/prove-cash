import {
  decodeEventLog,
  erc20Abi,
  maxUint256,
  type Address,
  type Chain,
  type Hex,
  type HttpTransport,
  type Log,
  type PublicClient,
} from 'viem'
import { rpcClient, type ProveWalletClient } from '../client.js'
import { getChainId, settlement, xykRouter, type ChainId } from '../config.js'
import { intentHashOf } from '../intent.js'
import { explainRevert } from '../revert.js'
import { approvalTarget, quote } from '../settlement.js'
import {
  ROUTER_ABI,
  SOLVER_BATCH_EXECUTOR_ABI,
  SOLVER_EXECUTOR_ABI,
  SOLVER_SETTLEMENT_ABI,
  fillBatchCall,
  settleRingCall,
  settleTolerantRingCall,
  swapCall,
  type RingFill,
  type Route,
} from './abi.js'
import { ANY_LEG } from './abi.js'
import { orderAtomicLegs, type OrderOptions } from './confidence.js'
import { marketRouteSwap } from './market.js'
import type { Plan } from './plan.js'
import { fallbackSwaps, type TolerantRing } from './tolerant.js'
import { gasCostNative, valueInNative, type PriceBook } from './price.js'

/**
 * Sending a plan.
 *
 * Nothing here decides anything. The engine ranks, this layer asks the chain whether the top of
 * the ranking is real, and only a caller holding a key sends it. Every call shape comes from
 * `abi.ts`, so a change to the contract's signatures never reaches this file.
 */

/** Where a plan is sent, and by whom. */
export type ExecuteOptions = {
  client?: PublicClient<HttpTransport, Chain>
  chainId?: ChainId
  /** Override the settlement address, for a fork. */
  settlementAddress?: Address
  /**
   * Override the router the closing swap goes to, for a fork. Left off, the router is the one
   * belonging to the venue whose pool the plan was priced against.
   */
  router?: Address
  /**
   * `ProveBatchExecutor`, for the credit path. Required by it and ignored by everything else.
   *
   * Not read from the registry, and deliberately. `sdk/src/config.ts` carries the settlement
   * address and nothing more, because everything else in the deployment is reachable from it —
   * the relayer off `settlement.relayer()`, the sink template off the executor. A batch executor is
   * reachable from neither, so an operator names the one they trust rather than inheriting one.
   */
  batchExecutor?: Address
  /** The account that sends. Simulations run from it too. */
  account: Address
  /** An explicit gas limit. Overrides the buffer below. */
  gas?: bigint
  /**
   * Send without the last-moment simulation. Off by default, and it should stay off.
   *
   * A ring settles atomically, so any maker in it can revert the whole batch by invalidating
   * their own intent — about 13k gas to break a batch that costs the executor an order of
   * magnitude more (finding E-3). Nothing on chain fixes it: a ring cannot skip a bad leg,
   * because a skipped leg leaves the executor holding an unhedged position.
   *
   * What is left is to make the window small. Simulating at the moment of sending does not
   * close it — a maker watching the mempool can still get a cancel in front — but it removes
   * every second between planning and broadcast, which is where the cheap breaks live.
   */
  skipPreflight?: boolean
  /**
   * How far above a measured gas figure to set the limit, in basis points. Default 2500.
   *
   * An estimate is a binary search for the smallest limit that works, so sending at exactly the
   * estimate is sending at the edge: one warm slot different at inclusion time and the batch
   * runs out of gas with every leg already half settled. The executor only pays for gas it
   * burns, so the margin costs nothing and buys the difference between a fill and a revert.
   */
  gasBufferBps?: number
  /**
   * What to pay for inclusion, in wei. Both or neither.
   *
   * Left off, viem asks the node, and on a quiet chain the node can answer with a tip of zero.
   * A transaction with no tip is not a slow transaction — it is one no validator will ever take,
   * and every later nonce from that account queues behind it. Two of them stopped the 943 solver
   * dead: nonces 25 and 26 went out at 16 wei with a zero tip, and the seventy-four correctly
   * priced rings behind them expired in the mempool while the bot logged confirmation timeouts.
   *
   * So a bot pins these. `eth_gasPrice` is not the number to pin them to — on 943 it answers
   * 500 gwei against a 7 wei base fee — and the chain's own floor is a 1 gwei tip.
   */
  maxFeePerGas?: bigint
  maxPriorityFeePerGas?: bigint
  /**
   * Send an atomic ring with its least certain leg first. On by default, on the credit path.
   *
   * A ring reverts whole, and the revert costs what the legs before the failing one cost. The
   * same eight legs losing the same maker cost 121,329 gas when it is the first leg and 554,731
   * when it is the last — `contracts/test/Gas.t.sol`. Reordering buys the difference and costs
   * nothing: `confidence.ts` keeps a fee run unbroken and a permit queue in order, and the route
   * is rebuilt against the new leg indices.
   *
   * Set it false to send the legs in cycle order, which is what this path did before.
   */
  orderLegs?: boolean
  /**
   * What the ordering knows beyond the legs themselves: this solver's maker ledger, any fresh
   * dry-run reasons, and a weighting of its own. All optional.
   */
  confidence?: Omit<OrderOptions, 'at' | 'skipInvalid'>
  /**
   * Send this ring so that a leg it loses is covered by a market instead of reverting it.
   *
   * **Left off is the default and stays the default.** A fallback is carried on every ring and
   * paid for on every ring, and `tolerant.ts` prices the rate above which that pays. Nobody has
   * measured a live board's rate, so nothing here derives this from anything — a caller builds a
   * `TolerantRing` with `planTolerantRing` and hands it over, or the ring is atomic exactly as it
   * was.
   *
   * It is per plan and this bag is per pass, so spread it in at the call site:
   * `simulateCreditRing(plan, { ...opts, tolerant }, deadline)`. `routeFor` refuses a tolerant
   * plan built for a different ring rather than encoding fallbacks that point at the wrong maker.
   */
  tolerant?: TolerantRing
}

/**
 * The fee fields to spread into a send, and nothing when the caller named none.
 *
 * Spread rather than assigned, because an `undefined` on either field is not the same as its
 * absence: viem reads the key, sees no value, and refuses the transaction instead of estimating.
 */
const feesFor = (opts: ExecuteOptions) =>
  opts.maxFeePerGas === undefined && opts.maxPriorityFeePerGas === undefined
    ? {}
    : { maxFeePerGas: opts.maxFeePerGas, maxPriorityFeePerGas: opts.maxPriorityFeePerGas }

/** The limit to send a plan at: explicit, else a margin over what the simulation measured. */
function gasLimitFor(plan: Plan, opts: ExecuteOptions): bigint | undefined {
  if (opts.gas !== undefined) return opts.gas
  if (!plan.gasSimulated) return undefined
  return (plan.gas * (10_000n + BigInt(opts.gasBufferBps ?? 2_500))) / 10_000n
}

/** What a simulation learned: the gas the batch really burns, or why it would revert. */
export type SimOutcome =
  | { ok: true; gas: bigint; filled: bigint }
  | { ok: false; reason: string }

/**
 * Why a simulation refused, named rather than numbered.
 *
 * A ring enters `settleRing` and can revert three contracts deep: in the batch executor, in the
 * settlement, in a token, or in the venue the route swaps through. viem only knows the ABI of the
 * contract it called, so anything raised below that came back as a bare selector and the solver
 * logged `reverted with the following signature:` and nothing readable. Hand `explainRevert`
 * every ABI on the path and the same failure prints its name and its arguments.
 */
const reasonOf = (e: unknown): string =>
  explainRevert(e, [SOLVER_SETTLEMENT_ABI, SOLVER_BATCH_EXECUTOR_ABI, SOLVER_EXECUTOR_ABI, ROUTER_ABI] as never)

const settlementFor = (opts: ExecuteOptions): Address =>
  opts.settlementAddress ?? settlement(opts.chainId ?? getChainId())

/**
 * Who signs a write: the wallet's own account when it has one, and the caller's address otherwise.
 *
 * `opts.account` is an `Address`, and handing viem a bare address makes it a JSON-RPC account —
 * the send goes out as `eth_sendTransaction` for the node to sign. A browser wallet is exactly
 * that, so the app has always worked. A bot holding a local key is not: the node has never heard
 * of the address and answers `unknown account`, which surfaces two causes up as "Invalid
 * parameters were provided to the RPC method".
 *
 * The solver bot could not settle a single ring until this existed. Simulations are unaffected —
 * there `account` is only the `from` of a call nobody signs.
 */
const signer = (wallet: ProveWalletClient, opts: ExecuteOptions) => wallet.account ?? opts.account

/**
 * Dry-run the batch and measure it.
 *
 * The count `fillBatch` returns has to equal the number of legs. It cannot be anything else —
 * `skipInvalid` is false — but checking it costs nothing and a surprise here means the plan and
 * the contract disagree about what is fillable.
 */
export async function simulateRing(plan: Plan, opts: ExecuteOptions): Promise<SimOutcome> {
  const client = opts.client ?? rpcClient()
  const call = fillBatchCall(settlementFor(opts), plan.fills, plan.maxFeeRate)
  try {
    const sim = (await client.simulateContract({
      account: opts.account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)) as unknown as { result: bigint }
    const gas = await client.estimateContractGas({
      account: opts.account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)
    const filled = sim.result
    if (filled !== BigInt(plan.fills.length)) {
      return { ok: false, reason: `batch filled ${filled} of ${plan.fills.length}` }
    }
    return { ok: true, gas, filled }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}

/**
 * Re-price a plan on the gas a simulation measured, rather than on the model's guess.
 *
 * A plan that no longer clears its own gas comes back with a negative net, not as an error: an
 * operator wants to see the ring it nearly had.
 */
export function withSimulatedGas(plan: Plan, gas: bigint, prices: PriceBook, gasPrice: bigint): Plan {
  const gasNative = gasCostNative(gas, gasPrice)
  const profitNative = valueInNative(prices, plan.profitToken, plan.profit)
  return {
    ...plan,
    gas,
    gasSimulated: true,
    gasNative,
    profitNative,
    netNative: profitNative === null ? null : profitNative - gasNative,
  }
}

/**
 * Thrown when the ring no longer settles at the moment of sending.
 *
 * Carries the revert reason so an operator can tell a broken leg from a moved price, and so a
 * solver can decide whether to re-plan or to stop trying this maker.
 */
export class RingBrokenError extends Error {
  /**
   * The revert reason, verbatim. Declared and assigned rather than taken as a parameter
   * property: this package compiles under `erasableSyntaxOnly`, which bans the shorthand
   * because it emits code instead of erasing.
   */
  readonly reason: string

  constructor(reason: string) {
    super(`The ring no longer settles: ${reason}`)
    this.name = 'RingBrokenError'
    this.reason = reason
  }
}

/**
 * Send the batch, simulating at the last moment.
 *
 * This function used to promise the simulation in its comment and not do it. Every caller was
 * simulating earlier in its own pipeline, which left a window between the check and the send —
 * and that window is exactly what finding E-3 is about. A maker who invalidates their intent
 * inside it reverts the whole ring for about 13k gas.
 *
 * The simulation cannot be optional in practice, so it is on unless a caller says otherwise, and
 * a failure throws rather than spending. An executor should never learn about a stale intent by
 * paying for the revert.
 */
export async function executeRing(
  wallet: ProveWalletClient,
  plan: Plan,
  opts: ExecuteOptions,
): Promise<Hex> {
  if (!opts.skipPreflight) {
    const sim = await simulateRing(plan, opts)
    if (!sim.ok) throw new RingBrokenError(sim.reason)
  }
  const call = fillBatchCall(settlementFor(opts), plan.fills, plan.maxFeeRate)
  return wallet.writeContract({
    account: signer(wallet, opts),
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    gas: gasLimitFor(plan, opts),
    ...feesFor(opts),
  } as never)
}

// ── The credit path ───────────────────────────────────────────────────────────

/**
 * Settling a ring on credit, through `ProveBatchExecutor`.
 *
 * The solver's wallet holds no inventory and grants no allowance. `fillBatchWithCallback`
 * releases every leg's token A to the executor before any payment is due, so the token one maker
 * sells pays the next maker, and the executor approves the relayer for what is left over.
 *
 * The market leg comes with it. On the inventory path the closing swap is a second transaction
 * from the solver's own wallet, and a pool that moves between the two leaves the solver holding
 * the position at whatever price it moved to. Inside the callback it is the same transaction.
 */

/** Every token a plan touches, once each, in the order the plan names them. */
function tokensOf(plan: Plan): Address[] {
  const seen = new Set<string>()
  const out: Address[] = []
  const add = (t: Address) => {
    const k = t.toLowerCase()
    if (seen.has(k)) return
    seen.add(k)
    out.push(t)
  }
  for (const f of plan.fills) {
    add(f.intent.tokenIn)
    add(f.intent.tokenOut)
  }
  if (plan.swap) {
    add(plan.swap.market.pays)
    add(plan.swap.market.receives)
  }
  return out
}

/**
 * The route that closes this plan: what to sell, and every token to bring home.
 *
 * The sweep list is the plan's own tokens. A token left off rests in the executor rather than
 * reaching the solver, so the list is built from the plan rather than taken from a caller.
 */
export function routeFor(plan: Plan, opts: ExecuteOptions, deadline: bigint): Route {
  const executorAddress = batchExecutorFor(opts)
  // The market builds its own call. A ring closes as a whole, so the swap is tied to no one leg.
  const swap = plan.swap
    ? marketRouteSwap(
        plan.swap.market,
        plan.swap.amountIn,
        plan.swap.amountOutMin,
        executorAddress,
        deadline,
        ANY_LEG,
      )
    : null
  if (plan.swap && !swap) throw new Error('This market cannot build its own swap yet.')
  const swaps = swap ? [swap] : []
  if (opts.tolerant) {
    // A tolerant plan names legs by index into ONE ring's fills. Handed another ring, every
    // fallback points at the wrong maker and the route encodes cleanly — which is the worst kind
    // of wrong, because nothing downstream can tell. The plan carries the ring it was built for
    // precisely so this line can exist.
    if (opts.tolerant.ringId !== plan.ring.id) {
      throw new Error('This tolerant plan was built for another ring.')
    }
    // Order is a funding order and not a list order: a fallback has to run before whatever spends
    // what it raises. `swapOrder` argues it. The ring's own market swap keeps `ANY_LEG` and is
    // spliced in at the position the walk left for it.
    const built = fallbackSwaps(
      opts.tolerant,
      plan.ring.legs.length,
      marketPositionOf(plan),
      executorAddress,
      deadline,
    )
    built.swaps.splice(built.marketAt, 0, ...swaps)
    return {
      legs: BigInt(plan.fills.length),
      swaps: built.swaps,
      sweep: tokensOf(plan),
      disposal: [],
    }
  }
  // No disposal: a ring banks its surplus in `profitToken` by construction, so there is
  // nothing to convert. `packBatch` is where a caller names one.
  return { legs: BigInt(plan.fills.length), swaps, sweep: tokensOf(plan), disposal: [] }
}

/**
 * Where the ring's own market leg sits, as a ring position, or null when intents close it alone.
 *
 * The position and not the fill index. `plan.fills` carries the intent legs only, so the two
 * numberings differ the moment a market leg is anywhere but the end — and the route's order is
 * about which token funds which call, which is a fact about the cycle.
 */
const marketPositionOf = (plan: Plan): number | null => {
  if (!plan.swap) return null
  const at = plan.ring.legs.findIndex((l) => l.kind === 'market')
  return at < 0 ? null : at
}

/**
 * The two halves of a credit ring's calldata: the fills, and the route that names their indices.
 *
 * They are built together and must be sent together. `Swap.leg` indexes into the fills array, so
 * a route built before the reorder points at the wrong legs — see `confidence.ts`. Both the
 * simulation and the send go through here, so the two can never disagree about the order.
 */
function ringCalldata(
  plan: Plan,
  opts: ExecuteOptions,
  deadline: bigint,
): { fills: readonly RingFill[]; route: Route } {
  const route = routeFor(plan, opts, deadline)
  if (opts.orderLegs === false) return { fills: plan.fills, route }
  // `plan.at` and not a wall clock: the plan was priced against the chain's own timestamp, and
  // the deadlines this scores against are the ones the settlement reads.
  //
  // False even for a tolerant ring, and the flag is asking the right question either way: can
  // one refused leg still revert this whole transaction? For a tolerant ring it can — on a leg
  // that got no fallback, and on the second leg lost in one block — so the cheap-break ordering
  // is still worth what it costs, which is nothing. `reindexRoute` renumbers a `WHEN_ABSENT`
  // fallback to its leg's new position, and it leaves the swap ARRAY in the order this file put
  // it, so the funding order survives the reorder untouched.
  return orderAtomicLegs(plan.fills, route, {
    ...opts.confidence,
    at: plan.at,
    skipInvalid: false,
  })
}

/** The executor the credit path settles through, or a refusal naming what is missing. */
function batchExecutorFor(opts: ExecuteOptions): Address {
  if (!opts.batchExecutor) {
    throw new Error('The credit path needs a ProveBatchExecutor address. Pass `batchExecutor`.')
  }
  return opts.batchExecutor
}

/**
 * Dry-run a credit ring and measure it.
 *
 * `settleRing` returns the settlement's own count of legs that settled. For an atomic ring it
 * cannot be short — `skipInvalid` is false — but checking costs nothing and a surprise means the
 * plan and the contract disagree about what is fillable. For a tolerant ring short is ordinary,
 * and the check below says so.
 */
export async function simulateCreditRing(
  plan: Plan,
  opts: ExecuteOptions,
  deadline: bigint,
): Promise<SimOutcome> {
  const client = opts.client ?? rpcClient()
  const sent = ringCalldata(plan, opts, deadline)
  const call = ringCallFor(plan, opts, sent)
  try {
    const sim = (await client.simulateContract({
      account: opts.account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)) as unknown as { result: bigint }
    const gas = await client.estimateContractGas({
      account: opts.account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)
    const filled = sim.result
    // An atomic ring cannot come back short — `skipInvalid` is false and the route's leg count
    // refuses a long list besides — so a surprise means the plan and the contract disagree about
    // what is fillable.
    //
    // A tolerant ring is allowed to. Coming back short is the feature working: a maker went and
    // the market took their place, and the sizing rule in `tolerant.ts` is what makes that at
    // least as good as the ring planned for. Zero is still nothing to send.
    const wanted = BigInt(plan.fills.length)
    const short = opts.tolerant ? filled < 1n : filled !== wanted
    if (short) return { ok: false, reason: `ring settled ${filled} of ${wanted}` }
    return { ok: true, gas, filled }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}

/**
 * The call that settles this ring: atomic, or tolerant when the caller planned fallbacks.
 *
 * One function, so the simulation and the send can never disagree about which `skipInvalid` they
 * used. They did not disagree before because there was only one choice; now there are two, and a
 * simulation of the atomic call followed by a tolerant send is a transaction nobody checked.
 */
const ringCallFor = (
  plan: Plan,
  opts: ExecuteOptions,
  sent: { fills: readonly RingFill[]; route: Route },
) =>
  (opts.tolerant ? settleTolerantRingCall : settleRingCall)(
    batchExecutorFor(opts),
    sent.fills,
    plan.maxFeeRate,
    sent.route,
  )

/**
 * Send a credit ring, simulating at the last moment.
 *
 * The window between the check and the send is what finding E-3 is about, and it is the same
 * window here: a maker who invalidates their own intent inside it reverts the whole ring for
 * about 13k gas. Simulating at the moment of sending does not close it, but it removes every
 * second between planning and broadcast.
 */
export async function executeCreditRing(
  wallet: ProveWalletClient,
  plan: Plan,
  opts: ExecuteOptions,
  deadline: bigint,
): Promise<Hex> {
  if (!opts.skipPreflight) {
    const sim = await simulateCreditRing(plan, opts, deadline)
    if (!sim.ok) throw new RingBrokenError(sim.reason)
  }
  const sent = ringCalldata(plan, opts, deadline)
  const call = ringCallFor(plan, opts, sent)
  return wallet.writeContract({
    account: signer(wallet, opts),
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    gas: gasLimitFor(plan, opts),
    ...feesFor(opts),
  } as never)
}

/**
 * Which leg of a broken ring is the one that will not settle.
 *
 * `fillBatch` reverts as a unit, so the revert reason says the ring failed and not who failed it.
 * Each leg is therefore simulated on its own. This costs one call per leg and only runs after a
 * ring has already broken, which is the moment a solver most wants the answer: the maker named
 * here is the one to stop planning around.
 *
 * Returns every index that fails on its own. An empty list means each leg is individually fine
 * and the ring broke for a reason that only exists in combination — a moved pool, or the fee.
 */
export async function brokenLegs(plan: Plan, opts: ExecuteOptions): Promise<number[]> {
  const client = opts.client ?? rpcClient()
  const address = settlementFor(opts)
  const bad: number[] = []
  for (let i = 0; i < plan.fills.length; i++) {
    const call = fillBatchCall(address, [plan.fills[i]!], plan.maxFeeRate)
    try {
      await client.simulateContract({
        account: opts.account,
        address: call.address,
        abi: call.abi,
        functionName: call.functionName,
        args: call.args,
      } as never)
    } catch {
      bad.push(i)
    }
  }
  return bad
}

/**
 * Where a plan's closing swap goes, and who it has to be approved to.
 *
 * Not "the chain's router" — the chain has two. A plan is priced against one venue's pool, and
 * the other venue's router walks a different curve over different reserves, so the
 * `amountOutMin` the plan computed would be a bound on the wrong pool. An explicit override
 * still wins, for a fork, and names one address for both roles.
 *
 * Two addresses and not one because a venue may hold allowances apart from the contract it is
 * called at. Approving the target of such a venue leaves the swap reverting on an allowance the
 * solver believes it granted.
 */
function venueCall(plan: Plan, opts: ExecuteOptions): { target: Address; spender: Address } {
  if (opts.router) return { target: opts.router, spender: opts.router }
  // The market names its own addresses now, so the venue that priced the leg is the venue that
  // fills it. This used to re-derive the router from the plan's venue label, one step removed
  // from the leg that already knew — and a label that no longer matched any registry entry fell
  // back to the chain's default router, quoting one pool and filling at another.
  const call = plan.swap?.market.swap(1n, 0n, opts.account, 0n)
  const fallback = xykRouter(opts.chainId ?? getChainId())
  return { target: call?.target ?? fallback, spender: call?.spender ?? fallback }
}

/**
 * The closing swap as its own transaction, for the path that does not settle on credit.
 *
 * Still typed against an xyk router, and that is the one place the venue kind has not left. The
 * credit path hands the executor opaque bytes and never reads a return value; this one decodes
 * `swapExactTokensForTokens`'s amounts so `simulateSwap` can say what the swap would pay. A
 * market that cannot describe its return cannot use this path — which is no loss, because a
 * market the engine could not price is not one it would have planned a ring around either.
 *
 * Everything it needs comes off the market rather than off the plan: the router is the market's
 * own target, and the path is the direction the market was built in.
 */
const swapFor = (plan: Plan, opts: ExecuteOptions, deadline: bigint) => {
  if (!plan.swap) throw new Error('This plan has no market leg.')
  return swapCall(
    venueCall(plan, opts).target,
    plan.swap.amountIn,
    plan.swap.amountOutMin,
    [plan.swap.market.pays, plan.swap.market.receives],
    opts.account,
    deadline,
  )
}

/** What the closing swap would return, and what it would cost. */
export type SwapOutcome = { ok: true; gas: bigint; amountOut: bigint } | { ok: false; reason: string }

/**
 * Dry-run the swap that closes a ring. The router quote the plan was built on is a bound, not a
 * promise, so ask again with the real call before spending anything on it.
 */
export async function simulateSwap(
  plan: Plan,
  opts: ExecuteOptions,
  deadline: bigint,
): Promise<SwapOutcome> {
  const client = opts.client ?? rpcClient()
  const call = swapFor(plan, opts, deadline)
  try {
    const sim = (await client.simulateContract({
      account: opts.account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)) as unknown as { result: readonly bigint[] }
    const gas = await client.estimateContractGas({
      account: opts.account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)
    const amounts = sim.result
    return { ok: true, gas, amountOut: amounts[amounts.length - 1] }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}

/**
 * Send the market swap that closes a ring.
 *
 * This is a second transaction, and between the two the pool can move. `amountOutMin` is the
 * amount the ring needs back, so a swap that no longer covers the position reverts instead of
 * settling at a loss — but the intents are already filled by then, and the solver is holding
 * the position either way. That is the price of an AMM leg without a batch callback.
 */
export async function executeSwap(
  wallet: ProveWalletClient,
  plan: Plan,
  opts: ExecuteOptions,
  deadline: bigint,
): Promise<Hex> {
  const client = opts.client ?? rpcClient()
  const call = swapFor(plan, opts, deadline)
  const measured =
    opts.gas ??
    (await client.estimateContractGas({
      account: opts.account,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never))
  return wallet.writeContract({
    account: signer(wallet, opts),
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    gas: (measured * (10_000n + BigInt(opts.gasBufferBps ?? 2_500))) / 10_000n,
    ...feesFor(opts),
  } as never)
}

/**
 * What each intent's recipient was really paid, read out of a receipt's `Filled` events.
 *
 * The event's `delivered` is the maker's half and not the executor's outlay. The other half is
 * `fee`, and the two add back up to the gross. A caller that wants what the fill cost has to add
 * them; a caller checking the maker, like `makersShortChanged`, wants this number alone.
 *
 * Balances cannot answer this: a recipient can be paid by somebody else in the same block, and
 * a maker who is also the executor sees both sides move. The event is the contract's own record.
 */
export function deliveredFromLogs(logs: readonly Log[], settlementAddress: Address): Map<string, bigint> {
  const paid = new Map<string, bigint>()
  const from = settlementAddress.toLowerCase()
  for (const entry of logs) {
    // Any contract can emit a log with the Filled signature. Only the settlement's is its record.
    if (entry.address?.toLowerCase() !== from) continue
    let ev: { eventName: string; args: Record<string, unknown> }
    try {
      ev = decodeEventLog({
        abi: SOLVER_SETTLEMENT_ABI,
        data: entry.data,
        topics: entry.topics,
      }) as unknown as typeof ev
    } catch {
      continue // a log from another contract in the same transaction
    }
    if (ev.eventName !== 'Filled') continue
    const hash = String(ev.args.intentHash).toLowerCase()
    paid.set(hash, (paid.get(hash) ?? 0n) + (ev.args.delivered as bigint))
  }
  return paid
}

/**
 * The assertion a solver exists to keep: every maker in the ring received their half of the rate
 * they signed. Returns the legs that came up short, which should always be none.
 *
 * **The floor is the net, not the gross.** `Filled.delivered` is what reached the recipient, and
 * the settlement now pays the destination out of the maker's own number. So the amount to check
 * against is `quote(...).delivered` — the curve's value less the fee. Checking the gross here
 * would report every fee-charging fill as a short payment.
 *
 * `at` is the timestamp of the block the batch landed in, not the one the plan was priced at.
 * On a Dutch intent those differ, and the maker is owed the curve's value at the fill, so
 * checking against the plan's own quote would call a correct fill a short payment.
 */
export function makersShortChanged(
  plan: Plan,
  logs: readonly Log[],
  at: bigint,
  chainId: ChainId = getChainId(),
  settlementAddress: Address = settlement(chainId),
): { maker: Address; owed: bigint; got: bigint }[] {
  const paid = deliveredFromLogs(logs, settlementAddress)
  const short: { maker: Address; owed: bigint; got: bigint }[] = []
  for (const leg of plan.sized.legs) {
    if (leg.leg.kind !== 'intent') continue
    const intent = leg.leg.entry.intent
    const owed = quote(intent, leg.take, at).delivered
    const got = paid.get(intentHashOf(intent, chainId).toLowerCase()) ?? 0n
    if (got < owed) short.push({ maker: intent.maker, owed, got })
  }
  return short
}

/**
 * The address that takes an executor's tokens: the relayer, not the settlement.
 *
 * `ProveSettlement` holds no allowance at all. It pulls every transfer through `ProveRelayer`, so
 * an executor who approves the settlement approves a contract that never calls `transferFrom`,
 * and every `fillBatch` it sends reverts on allowance. The settlement hands its own relayer back,
 * so ask the deployment this plan settles against. A fork override is a different deployment with
 * a different relayer, which is why that case cannot go through `approvalTarget`.
 */
const forkRelayers = new Map<Address, Address>()

async function relayerFor(opts: ExecuteOptions): Promise<Address> {
  const at = opts.settlementAddress
  if (!at) return approvalTarget({ client: opts.client, chainId: opts.chainId })

  const known = forkRelayers.get(at)
  if (known) return known
  const found = await (opts.client ?? rpcClient()).readContract({
    address: at,
    abi: SOLVER_SETTLEMENT_ABI,
    functionName: 'relayer',
  })
  forkRelayers.set(at, found)
  return found
}

/** Every token a plan spends, and the contract that has to be allowed to take it. */
export async function requiredApprovals(
  plan: Plan,
  opts: ExecuteOptions,
): Promise<{ token: Address; spender: Address }[]> {
  const out = new Map<string, { token: Address; spender: Address }>()
  const intents = plan.sized.legs.filter((l) => l.leg.kind === 'intent')
  // Only ask the chain for the relayer when a leg pays through it. A pool-only plan spends
  // nothing the settlement touches, and a read that buys nothing still costs a round trip.
  if (intents.length > 0) {
    const spender = await relayerFor(opts)
    for (const l of intents) {
      out.set(`${l.leg.pays.toLowerCase()}:${spender.toLowerCase()}`, { token: l.leg.pays, spender })
    }
  }
  if (plan.swap) {
    // The spender, not the target. They are the same address on a router and are not on every
    // venue, and this is the one that has to hold the allowance.
    const { spender } = venueCall(plan, opts)
    out.set(`${plan.swap.market.pays.toLowerCase()}:${spender.toLowerCase()}`, {
      token: plan.swap.market.pays,
      spender,
    })
  }
  return [...out.values()]
}

/** Raise an allowance to the maximum when it falls short. Returns the hashes it sent. */
export async function ensureApprovals(
  wallet: ProveWalletClient,
  plan: Plan,
  opts: ExecuteOptions,
  need: bigint = maxUint256 / 2n,
): Promise<Hex[]> {
  const client = opts.client ?? rpcClient()
  const sent: Hex[] = []
  for (const { token, spender } of await requiredApprovals(plan, opts)) {
    const allowance = await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [opts.account, spender],
    })
    if (allowance >= need) continue
    sent.push(
      await wallet.writeContract({
        account: signer(wallet, opts),
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, maxUint256],
        ...feesFor(opts),
      } as never),
    )
  }
  return sent
}

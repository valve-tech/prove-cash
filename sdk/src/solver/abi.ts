import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { BATCH_EXECUTOR_ABI, EXECUTOR_ABI, READER_ABI, SETTLEMENT_ABI } from '../abi.js'
import type { Intent, SignedIntent } from '../intent.js'
import type { FillPlan } from '../settlement.js'

/**
 * Every call shape the solver puts on the wire, in one file.
 *
 * The engine above never names a contract function or an argument order, so a change to the fill
 * entry points — `maxFeeRate` was the last one — touches this file and nothing else.
 *
 * The ABI itself is not written here. `src/abi.ts` is generated from the compiler's own output
 * and CI fails on a diff, so a hand-kept copy in this file would be a second thing to get wrong.
 * That is not hypothetical: the last hand-written ABI in this package went stale in six entries
 * and every fill would have reverted on chain while `tsc` and CI both passed.
 */

/** ProveSettlement, from the compiler. Re-exported so a solver needs one import. */
export const SOLVER_SETTLEMENT_ABI = SETTLEMENT_ABI

/** ProveReader, from the compiler. Where `available` lives now. */
export const SOLVER_READER_ABI = READER_ABI

/** ProveBatchExecutor, from the compiler. The contract that settles a ring on credit. */
export const SOLVER_BATCH_EXECUTOR_ABI = BATCH_EXECUTOR_ABI

/** ProveExecutor, from the compiler. The contract that fills one intent on credit. */
export const SOLVER_EXECUTOR_ABI = EXECUTOR_ABI

/** PulseX V2, as much of the router as a ring needs. */
export const ROUTER_ABI = parseAbi([
  'function factory() view returns (address)',
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
])

/** The factory, for finding the pair behind an xyk market. */
export const FACTORY_ABI = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
])

/** A constant-product pair: the two reserves and which token is which. */
export const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
])

/** The intent as the contract's calldata tuple. */
export function intentTuple(i: Intent) {
  return {
    maker: i.maker,
    recipient: i.recipient,
    tokenIn: i.tokenIn,
    tokenOut: i.tokenOut,
    amountIn: i.amountIn,
    minOutStart: i.minOutStart,
    minOutEnd: i.minOutEnd,
    startTime: i.startTime,
    endTime: i.endTime,
    executor: i.executor,
    feeConfig: i.feeConfig,
    feeRate: i.feeRate,
    minFill: i.minFill,
    authNonce: i.authNonce,
    flags: i.flags,
    nonce: i.nonce,
    curve: i.curve,
    feeRateIn: i.feeRateIn,
    feeRateProceeds: i.feeRateProceeds,
  }
}

/** One intent and how much of it this transaction takes. */
export type RingFill = {
  intent: SignedIntent
  take: bigint
  /**
   * Empty, or the signature that reaches this maker's funds: an EIP-3009 authorization when the
   * intent carries the escrow flag, an EIP-2612 permit when it does not.
   *
   * The solver supplies this, not the maker, so the solver decides which legs are worth an
   * arming call. Leave it out for a maker who already granted an allowance or funded an escrow.
   */
  arming?: `0x${string}`
}

/** A contract call, ready for `simulateContract`, `estimateContractGas` or `writeContract`. */
export type EncodedCall = {
  address: Address
  abi: readonly unknown[]
  functionName: string
  args: readonly unknown[]
}

/**
 * The `fillBatch` call that settles a ring.
 *
 * `skipInvalid` is hard-wired to false. Skipping one leg of a cycle settles the others and
 * leaves the solver holding an unhedged position, so a ring is atomic or it is nothing — the
 * argument is not the caller's to choose.
 *
 * `maxFeeRate` bounds the fee the owner can charge under a pending transaction. Pass the fee the
 * ring was priced with; anything higher silently eats the surplus the plan was built on.
 */
export function fillBatchCall(
  settlementAddress: Address,
  fills: readonly RingFill[],
  maxFeeRate: bigint,
): EncodedCall {
  return {
    address: settlementAddress,
    abi: SOLVER_SETTLEMENT_ABI,
    functionName: 'fillBatch',
    args: [
      fills.map((f) => ({
        intent: intentTuple(f.intent),
        signature: f.intent.signature,
        take: f.take,
        arming: f.arming ?? '0x',
      })),
      false,
      maxFeeRate,
    ],
  }
}

/**
 * One venue call inside a credit ring: what to sell, where, and the calldata that sells it.
 *
 * `ProveBatchExecutor.Swap`. The executor hands this to `ProveCallSink`, which is the address
 * that makes the call — so `target` is a venue and never the executor, and `spender` is whoever
 * that venue expects to hold the allowance.
 */
export type RouteSwap = {
  tokenIn: Address
  amountIn: bigint
  tokenOut: Address
  spender: Address
  target: Address
  data: Hex
  /** Tokens the venue pays besides `tokenIn` and `tokenOut`. Unnamed ones strand in the sink. */
  extra: readonly Address[]
  /**
   * Which leg of the batch this call exists for, or `ANY_LEG` to run whatever settles.
   *
   * A batch is not a ring. If six of eight legs arm, the caller owes those six, and a call that
   * only makes sense because of one particular leg has to go when that leg does. Naming the leg
   * is what lets the executor drop it — before this field existed the callback could see that
   * something had been skipped but not WHICH, so it refused the whole batch.
   */
  leg: bigint
  /**
   * Where the input amount sits in `data`, so the executor can write the measured one there —
   * or `NO_PATCH` to send the calldata exactly as built.
   *
   * A venue's calldata is opaque on chain: the executor cannot read a price out of it or rebuild
   * it. It can overwrite one word at an offset the caller names, and the caller always knows
   * where its own amount is. For `swapExactTokensForTokens` it is byte 4, straight after the
   * selector — `AMOUNT_AT` below.
   *
   * That is the difference between naming a definite number and asking for "whatever I turn out
   * to have". A disposal could only ever guess before this, because the surplus is not known
   * until it exists: the Dutch curve moves with the block and a leg may be stepped over.
   *
   * Disposal only. The executor refuses a buy-side swap that sets it, because that phase spends
   * tokens that are owed to makers.
   */
  amountOffset: bigint
  /**
   * Where the minimum-output bound sits, patched alongside the amount. `MIN_OUT_AT` for the
   * router calldata this file builds.
   *
   * Not optional when `amountOffset` is set. The bound is a fixed number and the amount is about
   * to change, so patching one and not the other agrees to sell more for the same floor — a
   * worse price, quietly, in exactly the case the feature exists for.
   */
  minOutOffset: bigint
  /** The bound as output per input, scaled by 1e18. The executor writes `amount * this / 1e18`. */
  minOutPerIn: bigint
}

/** `RouteSwap.amountOffset` for calldata to send exactly as built. */
export const NO_PATCH = (1n << 256n) - 1n

/**
 * Where the two numbers sit in `swapExactTokensForTokens(uint,uint,address[],address,uint)`.
 *
 * Four bytes of selector, then the head: `amountIn`, then `amountOutMin`. Both are value types,
 * so both are in the head rather than behind an offset, and neither moves when the path length
 * changes. Named here so a caller building this exact call does not count bytes.
 */
export const AMOUNT_AT = 4n
export const MIN_OUT_AT = 36n

/**
 * `RouteSwap.leg` for a call tied to no single leg, which therefore always runs.
 *
 * Right for a route sent atomically, where nothing can go missing. In a batch sent with
 * `skipInvalid` it is safe rather than clever: `amountIn` is fixed, so if the leg that would have
 * funded the call is the one that went, the transfer finds the balance short and the batch
 * reverts. Failing closed is the only acceptable way for a plan to be wrong about its own bag.
 */
export const ANY_LEG = (1n << 256n) - 1n

/**
 * Or this into `RouteSwap.leg` to invert it: run the call precisely WHEN that leg is absent.
 *
 * `leg` on its own means "run only if that leg settled", so the one swap that could buy what a
 * missing maker would have supplied is skipped along with the maker. That is why a ring sent
 * `skipInvalid` false — not because the executor insists on atomicity, but because true failed
 * obscurely: short the token, short the pull, unwind.
 *
 * A fallback and the call it stands in for are mutually exclusive by construction, so exactly one
 * of a pair runs whatever the batch did. See `fallbackSwap`.
 *
 * **This is a second thing a solver may ask for, not a different thing it gets.** A ring is
 * unbroken by definition, and a solver that requires one still passes `skipInvalid` false.
 */
export const WHEN_ABSENT = 1n << 255n

/**
 * How a credit ring closes: `ProveBatchExecutor.Route`.
 *
 * `legs` is the number of lines the route was priced for. The executor refuses a batch that
 * settles MORE lines than that, because then the route is describing some other batch. Fewer is
 * ordinary now: it is what `skipInvalid` looks like from inside the callback, and each swap says
 * through `RouteSwap.leg` whether it still has a reason to run.
 *
 * `sweep` is every token to bring home. The executor measures each one before the ring and hands
 * over only the increase, so a token nobody names rests in the executor rather than reaching the
 * next caller. It has to name every token the ring pays out in — the executor refuses the route
 * with `OwedTokenNotSwept` otherwise, because an unmarked output token is one a maker could be
 * paid out of somebody else's donation with. Name everything the route touches.
 */
export type Route = {
  legs: bigint
  swaps: readonly RouteSwap[]
  sweep: readonly Address[]
  /**
   * Where the surplus goes, once every maker has been paid.
   *
   * `swaps` runs before the settlement pulls its payments, because its job is to raise the
   * tokens those payments are made in — it spends money that is owed. This runs after, when the
   * only thing the executor still holds above its marks is the solver's own take.
   *
   * A solver holds a bag of tokens for the length of one transaction and could only ever say how
   * to BUY the far side of each trade. The surplus fell out in whatever token it landed in: a
   * dozen legs, a dozen dusts, each its own transaction to clear later. Naming a disposal turns
   * that into one token the solver wants, inside the transaction that earned it.
   *
   * Best effort. Each runs in its own frame and a failure is swallowed — the token then sweeps
   * home unsold. A batch that has paid every maker must not unwind because a pool moved under
   * the solver's own tidying up.
   */
  disposal: readonly RouteSwap[]
}

/**
 * `Route` as the `data` blob the settlement carries back to the callback.
 *
 * The tuple shape is taken from the compiler's own ABI rather than typed out, for the reason the
 * header gives: a hand-kept copy is a second thing to get wrong, and a wrong one still compiles.
 *
 * Exported because the tests decode with it too. They had their own hand-written copy, which is
 * the same mistake one level down — it was missing `Swap.leg` and then `Route.disposal`, and a
 * decode against the wrong shape does not fail, it reads the wrong fields and returns them
 * confidently. One tuple, from the compiler, for both directions.
 */
export const ROUTE_TUPLE = (() => {
  const fn = BATCH_EXECUTOR_ABI.find((e) => e.type === 'function' && e.name === 'settleRing')
  const arg = fn && 'inputs' in fn ? fn.inputs.find((i) => i.name === 'route') : undefined
  if (!arg) throw new Error('ProveBatchExecutor.settleRing has no `route` argument.')
  return arg
})()

/** The route, ABI-encoded exactly as `abi.decode(data, (Route))` expects to read it. */
export const encodeRoute = (route: Route): Hex => encodeAbiParameters([ROUTE_TUPLE], [route])

/** A pure ring: no venue, nothing to sell, every leg paid out of another leg's release. */
export const pureRoute = (legs: number, sweep: readonly Address[]): Route => ({
  legs: BigInt(legs),
  swaps: [],
  sweep,
  disposal: [],
})

/**
 * The venue call that closes a ring through an XYK pool, aimed back at the executor.
 *
 * `to` is the executor and not the solver. The settlement pulls every payment out of the
 * executor, so proceeds paid anywhere else arrive after the debt is due and the ring reverts.
 *
 * `executor.sinkTemplate()` is the wrong answer in particular: it is the template every sink
 * clone is made from, nothing sweeps it, and a ring that pays it reverts with `ProceedsNotHere`.
 * `executor.sinkFor(solver)` is the clone that does sweep.
 */
export function routerSwap(
  routerAddress: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  amountOutMin: bigint,
  executorAddress: Address,
  deadline: bigint,
): RouteSwap {
  return {
    tokenIn,
    amountIn,
    tokenOut,
    spender: routerAddress,
    target: routerAddress,
    data: routerSwapData(amountIn, amountOutMin, [tokenIn, tokenOut], executorAddress, deadline),
    extra: [],
    // A ring closes as a whole, so its swap is not one leg's. A caller building a tolerant batch
    // sets this to the leg the call covers.
    leg: ANY_LEG,
    // Sent as built. A disposal that wants to be sized on chain sets these to `AMOUNT_AT` and
    // `MIN_OUT_AT` with a rate; a buy-side swap may not.
    amountOffset: NO_PATCH,
    minOutOffset: NO_PATCH,
    minOutPerIn: 0n,
  }
}

/**
 * How a fallback is built, and where it went.
 *
 * `fallbackSwap` used to live here and took a router address. It takes a `Market` now and lives
 * in `tolerant.ts`, beside the planner that sizes one — the reason is `market.ts`'s: a pair on
 * one venue walks different reserves from the same pair on another, so the venue that PRICED a
 * fallback has to be the venue that fills it, and a router re-derived at the call site is the bug
 * `routerFor` was. `marketRouteSwap` is the single seam where a market becomes calldata, and a
 * fallback goes through it like every other venue call.
 *
 * What stays here is `WHEN_ABSENT` above, which is the wire format and belongs with the rest of
 * it.
 */

/**
 * A disposal that sells whatever the batch actually earned in `tokenIn`, at no worse than a rate.
 *
 * The same router call as `routerSwap`, with the two offsets set so the executor writes the
 * measured surplus into it. `amountIn` and `amountOutMin` here are only placeholders — they are
 * overwritten before the call — but they are built from `minOutPerIn` anyway so that a route that
 * somehow reaches a venue unpatched still carries a bound rather than a zero.
 *
 * @param minOutPerIn what one unit of `tokenIn` must return, scaled by 1e18.
 */
export function disposalSwap(
  routerAddress: Address,
  tokenIn: Address,
  tokenOut: Address,
  minOutPerIn: bigint,
  executorAddress: Address,
  deadline: bigint,
  expected = 0n,
): RouteSwap {
  const amountOutMin = (expected * minOutPerIn) / 10n ** 18n
  return {
    ...routerSwap(
      routerAddress,
      tokenIn,
      tokenOut,
      expected,
      amountOutMin,
      executorAddress,
      deadline,
    ),
    amountOffset: AMOUNT_AT,
    minOutOffset: MIN_OUT_AT,
    minOutPerIn,
  }
}

/**
 * The router calldata itself, in one encoder.
 *
 * Both executors take the venue call as an opaque blob, and both build the same bytes. Two
 * copies of this is how the ring path and the single-intent path drift apart on an argument.
 */
const routerSwapData = (
  amountIn: bigint,
  amountOutMin: bigint,
  path: readonly Address[],
  to: Address,
  deadline: bigint,
): Hex =>
  encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'swapExactTokensForTokens',
    args: [amountIn, amountOutMin, path, to, deadline],
  })

/**
 * One venue call inside a zero-inventory fill: `ProveExecutor.Swap`.
 *
 * Four fields where `RouteSwap` has seven, and the missing three are the point. A ring's route
 * states what each leg sells, because the executor sizes the legs; `ProveExecutor` sells exactly
 * what the settlement released to it and nothing else, so the amount is not the caller's to say.
 */
export type ExecutorSwap = {
  spender: Address
  target: Address
  data: Hex
  /** Tokens the venue pays besides the intent's own two. Unnamed ones strand in the call sink. */
  extra: readonly Address[]
}

/**
 * Sell the maker's token A at an XYK router, on the way to paying the maker in token B.
 *
 * `to` is the executor, and not the bot that sends the fill. The settlement pulls the maker's
 * payment out of the executor the moment the callback returns, so proceeds paid anywhere else
 * arrive after the debt is due and the whole fill reverts.
 *
 * The executor, rather than its call sink, for a second reason: the sink would only hand the
 * same tokens on, and it charges 50,142 gas to do it. Both figures come from
 * `test_WhatEachFillPathCosts`, measured against live PulseX liquidity.
 *
 * **Never pay `executor.sinkTemplate()`.** That accessor answers the template every sink clone is
 * made from. Nothing calls it and nothing sweeps it, so a payout sent there is stranded and the
 * fill reverts with `ProceedsNotHere`. It was called `sink()` until 2026-09-15, and under that
 * name it cost the 369 fork rehearsal a run. The clone that does sweep is
 * `executor.sinkFor(caller)`; paying the executor, as this function does, is simpler than either.
 *
 * `amountOutMin` is the caller's only defence against a pool that moved. Set it to what the fill
 * owes plus the gas it burns, and a trade that no longer pays for itself reverts at the router
 * instead of settling at a loss.
 */
export function executorRouterSwap(
  routerAddress: Address,
  amountIn: bigint,
  amountOutMin: bigint,
  path: readonly Address[],
  executorAddress: Address,
  deadline: bigint,
): ExecutorSwap {
  return {
    spender: routerAddress,
    target: routerAddress,
    data: routerSwapData(amountIn, amountOutMin, path, executorAddress, deadline),
    extra: [],
  }
}

/**
 * The `fill` call that settles one intent with no inventory.
 *
 * It goes to `ProveExecutor`, not to the settlement: `fillWithCallback` calls its own caller
 * back, so the caller has to be code. The wallet that sends this needs no token balance and
 * grants no allowance — the executor holds the released tokens for the length of the
 * transaction, approves the relayer itself, and sweeps the spread to whoever sent the call.
 *
 * `maxFeeRate` bounds the fee the owner can charge under a pending transaction, exactly as in
 * `fillBatchCall`. Pass the fee the trade was priced with.
 */
export function executorFillCall(
  executorAddress: Address,
  intent: SignedIntent,
  take: bigint,
  maxFeeRate: bigint,
  swap: ExecutorSwap,
): EncodedCall {
  return {
    address: executorAddress,
    abi: SOLVER_EXECUTOR_ABI,
    functionName: 'fill',
    args: [intentTuple(intent), intent.signature, take, maxFeeRate, swap],
  }
}

/**
 * The `settleRing` call that settles a ring on credit.
 *
 * It goes to `ProveBatchExecutor`, not to the settlement: `fillBatchWithCallback` calls its own
 * caller back, so the caller has to be code. The solver's own wallet needs no inventory and no
 * allowance for this — the executor holds the released tokens for the length of the transaction
 * and approves the relayer itself.
 *
 * `skipInvalid` is false here, and it is the right default rather than a policy: a cycle minus a
 * leg is not a cycle, so unless the route carries a stand-in for the leg that went there is
 * nothing left to settle and true only spends more gas before the same revert.
 *
 * Two other shapes send true. `settleTolerantRingCall` is this ring with a market fallback per
 * leg. `settleBatchCall` is a set of independent plans, where losing one loses only that one.
 */
export function settleRingCall(
  batchExecutorAddress: Address,
  fills: readonly RingFill[],
  maxFeeRate: bigint,
  route: Route,
): EncodedCall {
  return ringCall(batchExecutorAddress, fills, false, maxFeeRate, route)
}

/**
 * The same ring, sent so that a leg it loses is covered by a market instead of reverting it.
 *
 * `skipInvalid` is true, and for a ring that is only safe because the route carries a fallback
 * for the leg that went — a `WHEN_ABSENT` swap that buys what the missing maker was going to
 * supply. Send true with no such swap and the callback ends holding too little, the settlement's
 * own pull reverts, and the ring has paid more gas for the same failure.
 *
 * `planTolerantRing` builds the fallbacks and `routeFor` puts them in the route. Neither happens
 * unless a caller asks: a fallback is carried on every ring and paid for on every ring, and on
 * the numbers in `tolerant.ts` it pays only above about a 22% loss rate for a three-leg ring.
 * Nobody has measured a live board's rate, so this is the second thing a solver may ask for and
 * not the thing it gets by default.
 */
export function settleTolerantRingCall(
  batchExecutorAddress: Address,
  fills: readonly RingFill[],
  maxFeeRate: bigint,
  route: Route,
): EncodedCall {
  return ringCall(batchExecutorAddress, fills, true, maxFeeRate, route)
}

/**
 * A set of independent plans, sent tolerantly: whatever arms settles, and the rest is somebody
 * else's business.
 *
 * `settleRingCall` is for a cycle and is all or nothing. This is for a set of plans that do not
 * depend on each other — `packBatch` builds one — where a leg that expired, was cancelled, or was
 * taken by a rival solver in the block before this landed should cost its own leg and no more.
 *
 * Two things have to be true of the route or this is worse than the atomic call, and `packBatch`
 * is what makes them true:
 *
 *   every swap names its leg   A swap left on `ANY_LEG` runs whatever settles. If the leg that
 *                              would have funded it is the one that went, the transfer finds the
 *                              balance short and the whole batch reverts — safe, but it throws
 *                              away the legs that were fine.
 *   no leg needs another       A cycle's legs pay for each other, so settling some of them
 *                              leaves the solver holding one side of a trade they never made.
 *
 * Prefer this wherever both hold. Eight legs one at a time cost 1,190,037 gas and one batch of
 * eight costs 695,959, and a leg lost to a rival costs 15,982 here against a whole reverted
 * transaction there. All three are generated rows, so a gate reads them.
 */
export function settleBatchCall(
  batchExecutorAddress: Address,
  fills: readonly RingFill[],
  maxFeeRate: bigint,
  route: Route,
): EncodedCall {
  return ringCall(batchExecutorAddress, fills, true, maxFeeRate, route)
}

/**
 * The one body all three share: `settleRing`, with the caller's own `skipInvalid`.
 *
 * Written once because the argument order is the thing that has to be right, and three copies of
 * it are three places for a field to drift. The three exported names stay separate because
 * `skipInvalid` is not a parameter a call site should be choosing inline — it is a decision about
 * whether the transaction is a cycle, and each name states which decision was made.
 */
function ringCall(
  batchExecutorAddress: Address,
  fills: readonly RingFill[],
  skipInvalid: boolean,
  maxFeeRate: bigint,
  route: Route,
): EncodedCall {
  return {
    address: batchExecutorAddress,
    abi: SOLVER_BATCH_EXECUTOR_ABI,
    functionName: 'settleRing',
    args: [
      fills.map((f) => ({
        intent: intentTuple(f.intent),
        signature: f.intent.signature,
        take: f.take,
        arming: f.arming ?? '0x',
      })),
      skipInvalid,
      maxFeeRate,
      route,
    ],
  }
}

/**
 * The same ring as a `FillPlan`, for everything that already speaks that language.
 *
 * `settlement.ts` builds `fillBatchWithCallback` for `mode: 'credit'` and carries the blob in
 * `callbackData`, so the argument order lives in one place and this only supplies the blob.
 * `simulateFills` reads a plan, and so does the app. Use `settleRingCall` to send: a plan
 * describes the settlement's call, and the transaction a solver signs is the executor's.
 */
export const creditFillPlan = (
  fills: readonly RingFill[],
  maxFeeRate: bigint,
  route: Route,
): FillPlan => ({
  mode: 'credit',
  fills: fills.map((f) => ({ intent: f.intent, take: f.take })),
  maxFeeRate,
  callbackData: encodeRoute(route),
  skipInvalid: false,
})

/** No bound at all: the value `maxFeeRate` takes when the caller has no ceiling in mind. */
export const NO_FEE_BOUND = (1n << 256n) - 1n

/**
 * The `fillability` read for one intent at one size.
 *
 * `maxFeeRate` is part of the question, not a detail of the answer, and it is not optional on
 * the wire either: the contract takes five arguments and a call built with four encodes nothing
 * viem will send. An intent asking more than the caller will pay is one a batch steps over, so a
 * probe with no bound reports `Ok` for a leg the fill is going to skip. A ring pays whatever its
 * dearest leg asks — `maxFeeRateFor` builds that number — so a book load usually asks without a
 * bound and lets the plan set one.
 */
export function fillabilityCall(
  settlementAddress: Address,
  intent: SignedIntent,
  take: bigint,
  executor: Address,
  maxFeeRate: bigint = NO_FEE_BOUND,
): EncodedCall {
  return {
    address: settlementAddress,
    abi: SOLVER_SETTLEMENT_ABI,
    functionName: 'fillability',
    args: [intentTuple(intent), intent.signature, take, executor, maxFeeRate],
  }
}

/**
 * The `available` read: how much of an intent is unfilled, and whether it is live at all. It is
 * answered by `ProveReader` now, not the settlement (which gave the bytes up), so the address is
 * the reader's.
 */
export function availableCall(readerAddress: Address, intent: Intent): EncodedCall {
  return {
    address: readerAddress,
    abi: SOLVER_READER_ABI,
    functionName: 'available',
    args: [intentTuple(intent)],
  }
}

/** The router swap that closes a ring through the pool. */
export function swapCall(
  routerAddress: Address,
  amountIn: bigint,
  amountOutMin: bigint,
  path: readonly Address[],
  to: Address,
  deadline: bigint,
): EncodedCall {
  return {
    address: routerAddress,
    abi: ROUTER_ABI,
    functionName: 'swapExactTokensForTokens',
    args: [amountIn, amountOutMin, path, to, deadline],
  }
}

/**
 * The contract's `Reason` enum, under the solver's older names for it.
 *
 * There is one mirror of that enum in this package and it lives in `settlement.ts`. There were
 * two, identical, and the contract's own note on `Reason` says why that could not stay: the
 * ordinals are a wire format, appended to and never inserted into, so a mirror that misses an
 * append does not fail — it silently renames every reason after the gap. Two mirrors is one
 * more than can be kept honest.
 */
export {
  FILL_REASONS as FILL_REASON_NAMES,
  fillReason,
  type FillReason as FillReasonName,
} from '../settlement.js'

/** A signature, as the board carries it. Re-exported so callers need one import for a fill. */
export type { Hex }

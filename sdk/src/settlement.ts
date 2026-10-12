import {
  BaseError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  ExecutionRevertedError,
  parseAbiParameters,
  type Address,
  type Chain,
  type Hex,
  type HttpTransport,
  type PublicClient,
} from 'viem'
import { rpcClient, type ProveWalletClient } from './client.js'
import {
  getChainId,
  getChainRpc,
  network,
  readerAddress,
  settlement,
  settlementLive,
  type ChainId,
} from './config.js'
import {
  authNonceOf,
  grossOut,
  intentHashOf,
  isEscrow,
  isPermit2,
  splitPermit,
  type Intent,
  type SignedIntent,
} from './intent.js'
import { READER_ABI, RELAYER_ABI, SETTLEMENT_ABI } from './abi.js'
import { feeOf } from './feeconfig.js'
import { pricedFeeRates, solverBorneRate, type PointRates } from './fee.js'
import { batchRead } from './multicall.js'

/**
 * The on-chain side of ProveSettlement: four fill paths, the per-intent escrow, and the fee
 * math. A chain without a deployment answers zero from `settlement()`, so `settlementLive()`
 * gates every write and every simulation here. Reads that need the contract return honest
 * "unknown" values instead.
 *
 * Every write takes a wallet client as its first argument. This package never builds one — a
 * tab's wallet and a bot's private key are the caller's to hold.
 */



/**
 * ProveSettlement's ABI, re-exported for consumers.
 *
 * It used to be a hand-written subset of the compiled artifact, and it drifted: six entries went
 * stale and every write would have reverted on chain while `tsc` and CI both stayed green. The
 * compiler writes it now — see `scripts/gen-abi.mjs`, and `npm run check:abi`, which CI runs.
 */
export { SETTLEMENT_ABI }

/**
 * How long a form should let a wallet-custody offer run before it argues, in seconds.
 *
 * **This is advice, not a rule.** The settlement used to refuse a wallet window wider than an
 * hour and no longer does: the loss from a stale wallet signature falls on the maker who signed
 * it and on nobody else, so refusing a term they signed was the contract overriding a choice that
 * was theirs to make.
 *
 * The hazard it used to guard is real, and a form should say so. A wallet order is armed by an
 * ERC-20 approval this protocol cannot see revoked, and revoking never cancels the intent — so
 * re-approving that token later revives every signature the maker ever wrote against it, and
 * `cancel` is the only thing that truly ends one. Escrow, EIP-3009 and Permit2 each carry a real
 * off switch and need no warning at all.
 *
 * So: warn past this, let them through, and never silently move a number they typed.
 */
export const SUGGESTED_WALLET_WINDOW_S = 60 * 60

/** One intent and how much of it to take. */
export type Fill = {
  intent: SignedIntent
  take: bigint
  /**
   * Empty, or the signature that reaches this maker's funds: an EIP-3009 authorization when the
   * intent carries the escrow flag, an EIP-2612 permit when it does not.
   *
   * The filler supplies this, not the maker, so the filler decides which legs are worth an
   * arming call. Leave it out for a maker who already granted an allowance or funded an escrow.
   *
   * A leg that cannot be armed leaves nothing behind — the maker's nonce is unspent and their
   * tokens have not moved — so it is skipped or the batch reverts, and the same signature works
   * next time.
   *
   * **`EscrowShort` on a leg you asked to arm means "not armable now", not "not armable ever".**
   * The leg comes back with the reason it had before the arming was tried, so it says nothing
   * about why the arming failed: an authorization whose `validAfter` has not arrived reads
   * exactly like a taxed token or a spent nonce. You hold the bytes, so decode the window and
   * tell the difference yourself — a filler that treats every `EscrowShort` as final drops legs
   * that would arm a minute later.
   */
  arming?: `0x${string}`
}

/**
 * Which contract function a fill goes through.
 *   direct        `fill` — the executor pays token B from their wallet
 *   batch         `fillBatch` — several intents, invalid ones stepped over
 *   callback      `fillWithCallback` — token A goes to the caller, the caller is called back,
 *                 and the contract then pulls token B out of it
 *   credit        `fillBatchWithCallback` — every leg's token A goes to the caller, the caller is
 *                 called back once, and then every payment is pulled. A ring of intents that pay
 *                 for each other settles with no inventory, which no other mode can do.
 *   authorization `fillWithAuthorization` — the maker's 3009 signature funds the escrow first
 *   permit        `fillWithPermit` — the maker's 2612 signature grants the relayer's allowance
 *                 first. The weaker gasless rung, for the tokens that cannot do 3009.
 *
 * **A gasless leg can also ride in a batch.** `FillRequest.arming` carries the same signature the
 * last two modes pass as an argument, and `armingFor` builds it — so several gasless legs settle
 * in one transaction, which those two cannot do. Prefer them for a single leg all the same: a
 * batch of one pays for an array, a loop and a fee run that one leg cannot use.
 */
export type FillMode =
  | 'direct'
  | 'batch'
  | 'callback'
  | 'credit'
  | 'authorization'
  | 'permit'
  | 'permit2'

/** What to fill and how. One plan resolves to exactly one contract call. */
export type FillPlan = {
  mode: FillMode
  fills: readonly Fill[]
  /**
   * The highest rate this caller will pay, on any leg, in basis points of the delivery.
   *
   * It bounds the TOTAL, not the protocol's floor. An intent names its own `feeRate` and the fill
   * charges whichever is higher, so a plan that passed only the floor would be surprised by any
   * intent that asks for more. `maxFeeRateFor(intents)` is the number to pass: the rate the
   * plan was priced with, not a ceiling.
   *
   * The contract reads its floor and its policy at execution time, so an unbounded fill can be
   * repriced under a pending transaction.
   */
  maxFeeRate: bigint
  /**
   * Extra bytes handed back to the caller's `proveCallback` or `proveBatchCallback`, for modes
   * 'callback' and 'credit'. The callback target is the caller itself, so there is no address to
   * name: an EOA cannot use either mode.
   */
  callbackData?: Hex
  skipInvalid?: boolean
}

/** The intent as the contract's calldata tuple. */
export function toStruct(i: Intent) {
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

/** `ProveSettlement.Authorization`: the window, the intent hash, and an unstructured signature. */
const AUTHORIZATION = parseAbiParameters(
  '(uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)',
)

/** `ProveSettlement.Permit`: the allowance the maker signed, and the 65-byte triple. */
const PERMIT = parseAbiParameters(
  '(uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
)

/** `ProveSettlement.Permit2Transfer`: one Permit2 SignatureTransfer, signature and all. */
const PERMIT2 = parseAbiParameters(
  '(address token, uint256 amount, uint256 nonce, uint256 deadline, bytes signature)',
)

/**
 * The `arming` bytes for one leg, or undefined when the leg needs none.
 *
 * The intent's custody flags decide which struct the settlement reads out of these bytes, so this
 * reads the same flags and encodes the matching one, in the same order `_armLeg` reads them. A
 * leg carrying no signature for its rung is already reachable — through a standing allowance, or
 * tokens sitting in escrow — and gets nothing.
 *
 * Sending it costs calldata and nothing else. A leg that cannot be armed leaves nothing behind:
 * the arming runs in a frame of its own, so the maker's nonce is unspent and their tokens have
 * not moved, and the same signature works next time.
 */
export function armingFor(i: SignedIntent, chainId: ChainId = getChainId()): Hex | undefined {
  if (isPermit2(i)) {
    if (!i.permit2) return undefined
    return encodeAbiParameters(PERMIT2, [
      {
        token: i.permit2.token,
        amount: i.permit2.amount,
        // The intent says which Permit2 nonce funds it and the contract refuses any other, so
        // the nonce never travels on the wire — the same rule the 3009 branch runs below, and
        // `authNonceOf` is the same fold the settlement runs.
        nonce: BigInt(authNonceOf(i, chainId)),
        deadline: i.permit2.deadline,
        signature: i.permit2.signature,
      },
    ])
  }
  if (isEscrow(i)) {
    if (!i.auth) return undefined
    return encodeAbiParameters(AUTHORIZATION, [
      {
        validAfter: i.auth.validAfter,
        validBefore: i.auth.validBefore,
        // The intent says which 3009 nonce funds it, and the contract enforces that, so the
        // nonce never travels on the wire. `authNonceOf` runs the same fold the settlement runs.
        nonce: authNonceOf(i, chainId),
        signature: i.auth.signature,
      },
    ])
  }
  if (!i.permit) return undefined
  return encodeAbiParameters(PERMIT, [splitPermit(i.permit)])
}

/** The function and arguments a plan resolves to. */
export type FillCall = { functionName: string; args: readonly unknown[] }

/** The wire-level call a plan resolves to. One place, so execute and simulate cannot drift. */
export function callFor(plan: FillPlan, chainId: ChainId = getChainId()): FillCall {
  const { mode, fills } = plan
  if (fills.length === 0) throw new Error('Nothing selected.')
  if (mode === 'callback') {
    const f = fills[0]
    return {
      functionName: 'fillWithCallback',
      args: [toStruct(f.intent), f.intent.signature, f.take, plan.callbackData ?? '0x', plan.maxFeeRate],
    }
  }
  if (mode === 'authorization') {
    const f = fills[0]
    if (!f.intent.auth) throw new Error('The intent carries no authorization.')
    return {
      functionName: 'fillWithAuthorization',
      args: [
        toStruct(f.intent),
        f.intent.signature,
        f.take,
        {
          validAfter: f.intent.auth.validAfter,
          validBefore: f.intent.auth.validBefore,
          // The intent says which 3009 nonce funds it, and the contract enforces that, so the
          // nonce never travels on the wire. `authNonceOf` runs the same fold the settlement runs.
          nonce: authNonceOf(f.intent, chainId),
          // One blob, any length, which is ERC-7598. It was a `v, r, s` triple, and that made
          // this rung refuse contract wallets: a smart account could sign the intent and not the
          // authorization that funds it.
          signature: f.intent.auth.signature,
        },
        plan.maxFeeRate,
      ],
    }
  }
  if (mode === 'permit') {
    const f = fills[0]
    if (!f.intent.permit) throw new Error('The intent carries no permit.')
    return {
      functionName: 'fillWithPermit',
      args: [
        toStruct(f.intent),
        f.intent.signature,
        f.take,
        splitPermit(f.intent.permit),
        plan.maxFeeRate,
      ],
    }
  }
  if (mode === 'permit2') {
    const f = fills[0]
    if (!f.intent.permit2) throw new Error('The intent carries no Permit2 transfer.')
    return {
      functionName: 'fillWithPermit2',
      args: [
        toStruct(f.intent),
        f.intent.signature,
        f.take,
        {
          token: f.intent.permit2.token,
          amount: f.intent.permit2.amount,
          // The intent says which Permit2 nonce funds it and the contract refuses any other, so
          // the nonce never travels on the wire — the same rule the authorization branch runs,
          // and `authNonceOf` is the same fold the settlement runs.
          nonce: BigInt(authNonceOf(f.intent, chainId)),
          deadline: f.intent.permit2.deadline,
          signature: f.intent.permit2.signature,
        },
        plan.maxFeeRate,
      ],
    }
  }
  if (mode === 'credit') {
    return {
      functionName: 'fillBatchWithCallback',
      args: [
        fills.map((f) => ({
          intent: toStruct(f.intent),
          signature: f.intent.signature,
          take: f.take,
          arming: f.arming ?? armingFor(f.intent, chainId) ?? '0x',
        })),
        // A ring is atomic or it is nothing. Skipping a leg would settle the others and leave
        // the solver holding an unhedged position, so this defaults the other way from `batch`.
        plan.skipInvalid ?? false,
        plan.callbackData ?? '0x',
        plan.maxFeeRate,
      ],
    }
  }
  if (fills.length === 1 && mode === 'direct') {
    const f = fills[0]
    return {
      functionName: 'fill',
      args: [toStruct(f.intent), f.intent.signature, f.take, plan.maxFeeRate],
    }
  }
  return {
    functionName: 'fillBatch',
    args: [
      fills.map((f) => ({
        intent: toStruct(f.intent),
        signature: f.intent.signature,
        take: f.take,
        // The caller's own bytes when they set them, and otherwise whatever the intent carries.
        // A maker who posted a gasless offer signed the arming with it, so a filler who leaves
        // this out is asking for a leg they cannot reach.
        arming: f.arming ?? armingFor(f.intent, chainId) ?? '0x',
      })),
      plan.skipInvalid ?? true,
      plan.maxFeeRate,
    ],
  }
}

/** Send the plan through a wallet. Throws while no settlement contract is deployed. */
export async function executeFills(
  wallet: ProveWalletClient,
  account: Address,
  plan: FillPlan,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  const call = callFor(plan, chainId)
  return wallet.writeContract({
    account,
    address: settlement(chainId),
    abi: SETTLEMENT_ABI,
    functionName: call.functionName,
    args: call.args,
  } as never)
}

// ── Simulation ────────────────────────────────────────────────────────────────

/** Whether a plan would go through, and why not when it would not. */
export type SimResult = { ok: true; note?: string } | { ok: false; reason: string }

/**
 * Contract reasons, in words an executor acts on.
 *
 * Every key must be an error the settlement can actually raise. Nothing enforced that, and one
 * key outlived its error: `StillLocked` came off the contract with the escrow cooldown at
 * `66c43fa` and sat here for months, so a revert that never happens had a nice sentence and every
 * revert that does happen fell through to its bare name. `settlement.test.ts` checks the keys
 * against `SETTLEMENT_ABI` now, which is why this is exported.
 */
export const REASON_TEXT: Record<string, string> = {
  BadSignature: 'signature rejected on chain',
  NotStarted: 'not started yet',
  Expired: 'expired',
  IsCancelled: 'cancelled by the maker',
  NonceTooLow: 'maker invalidated it',
  WrongExecutor: 'pinned to another executor',
  NothingToFill: 'nothing left to fill',
  TooMuch: 'take exceeds what remains',
  PartialNotAllowed: 'all or nothing',
  // "Not in place", not "never will be". On a leg that carried arming bytes this can simply mean
  // the authorization's own window has not opened yet.
  EscrowShort: 'maker funds not in place',
  Underpaid: 'payment came up short — check tokenOut balance and allowance',
  BadTerms: 'terms invalid',
  FeeTooHigh: 'the fee moved above your bound',
  BelowMinFill: 'under the maker\u2019s minimum fill',
  BadParameter: 'bad parameter',
}

function revertReason(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((err) => err instanceof ContractFunctionRevertedError)
    if (r instanceof ContractFunctionRevertedError) {
      const name = r.data?.errorName ?? r.signature ?? ''
      return REASON_TEXT[name] ?? (name || 'reverted')
    }
    return e.shortMessage
  }
  return (e as Error)?.message ?? 'simulation failed'
}

/** Where a read runs: which client, and which chain's deployment it asks. */
export type ReadOptions = {
  client?: PublicClient<HttpTransport, Chain>
  chainId?: ChainId
}

/**
 * Dry-run the plan with `eth_call` from the executor's address. An executor must never learn
 * about a stale intent by paying for a revert, so no caller should offer a fill that does not
 * pass here.
 */
export async function simulateFills(
  account: Address,
  plan: FillPlan,
  opts: ReadOptions = {},
): Promise<SimResult> {
  const chainId = opts.chainId ?? getChainId()
  if (!settlementLive(chainId)) return { ok: false, reason: 'settlement not deployed' }
  try {
    const call = callFor(plan, chainId)
    const client = opts.client ?? rpcClient()
    const sim = (await client.simulateContract({
      account,
      address: settlement(chainId),
      abi: SETTLEMENT_ABI,
      functionName: call.functionName,
      args: call.args,
    } as never)) as unknown as { result: unknown }
    if (call.functionName === 'fillBatch') {
      const count = sim.result as bigint
      if (count === 0n) return { ok: false, reason: 'nothing fillable' }
      if (count < BigInt(plan.fills.length)) {
        return { ok: true, note: `${count} of ${plan.fills.length} fill — the rest skip` }
      }
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: revertReason(e) }
  }
}

// ── Fees and the quote ────────────────────────────────────────────────────────

/**
 * The three rates one intent charges, by take point. All zero when it names no fee config, which
 * is what the settlement's `_ratesOf` does: a zero config charges nothing whatever it signed
 * (and `_termsOk` refuses the pair, so such an intent never fills).
 */
export function ratesOf(i: Intent): PointRates {
  return pricedFeeRates(i)
}

/**
 * The rate a plan must pass as `maxFeeRate`: the highest P1 + P2 any of its legs charges.
 *
 * `maxFeeRate` bounds the two rates the SOLVER bears, the handover (P1) and the output (P2). It
 * does not bound P3, which comes out of the maker's proceeds and costs the solver nothing, so an
 * intent with a large P3 and no P1 or P2 passes a bound of zero. A bound below a leg's own P1 + P2
 * makes the contract step over that leg, so a caller filling from a list computes this rather
 * than guessing.
 *
 * The settlement's ceiling per rate is `MAX_FEE_RATE` in `fee.ts`, and it is arithmetic rather
 * than policy: above one ether a fee exceeds the amount it is taken from.
 */
export function maxFeeRateFor(intents: readonly Intent[]): bigint {
  let out = 0n
  for (const i of intents) {
    const r = solverBorneRate(i)
    if (r > out) out = r
  }
  return out
}

/**
 * What a `take` fill moves, mirroring `TakePoints.price` and the `quote` the settlement exposes.
 * `Fixture.t.sol` and `ProveReader.t.sol` pin it to the Solidity.
 *
 *   owedToMaker  = ceilDiv(take x minOutAt, amountIn)          the curve
 *   feeIn        = floor(take x feeRateIn / WAD)               P1, tokenIn, solver bears it
 *   feeOut       = floor(owedToMaker x feeRate / WAD)          P2, tokenOut, ON TOP, solver bears it
 *   feeProceeds  = floor(owedToMaker x feeRateProceeds / WAD)  P3, tokenOut, OUT of it, maker bears it
 *   usable       = take - feeIn                                what the solver receives
 *   delivered    = owedToMaker - feeProceeds                   what the recipient receives
 *   owed         = owedToMaker + feeOut                        what the solver pays in tokenOut
 *
 * Every fee floors, so the dust stays with whoever bears it.
 */
export type QuoteResult = {
  take: bigint
  owedToMaker: bigint
  feeIn: bigint
  feeOut: bigint
  feeProceeds: bigint
  usable: bigint
  delivered: bigint
  owed: bigint
  /**
   * The filler's outlay in tokenOut: `owed`. It was the whole of the old model's outlay, which is
   * why the name stays; `delivered + fee === gross` still holds.
   */
  gross: bigint
  /** What the fee destinations are booked in tokenOut: P2 + P3. (P1 is in tokenIn: `feeIn`.) */
  fee: bigint
}

const toQuote = (q: Omit<QuoteResult, 'gross' | 'fee'>): QuoteResult => ({
  ...q,
  gross: q.owed,
  fee: q.feeOut + q.feeProceeds,
})

/** The contract's `quote`, computed here. */
export function quote(i: Intent, take: bigint, at: bigint): QuoteResult {
  const owedToMaker = grossOut(i, take, at)
  const r = ratesOf(i)
  const feeIn = feeOf(take, r.handover)
  const feeOut = feeOf(owedToMaker, r.output)
  const feeProceeds = feeOf(owedToMaker, r.proceeds)
  return toQuote({
    take,
    owedToMaker,
    feeIn,
    feeOut,
    feeProceeds,
    usable: take - feeIn,
    delivered: owedToMaker - feeProceeds,
    owed: owedToMaker + feeOut,
  })
}

/** The contract's own answer to `quote`, for when only the chain will do. */
export async function readQuote(
  i: Intent,
  take: bigint,
  at: bigint,
  opts: ReadOptions = {},
): Promise<QuoteResult> {
  const q = (await (opts.client ?? rpcClient()).readContract({
    address: settlement(opts.chainId ?? getChainId()),
    abi: SETTLEMENT_ABI,
    functionName: 'quote',
    args: [toStruct(i), take, at],
  })) as Omit<QuoteResult, 'gross' | 'fee'>
  return toQuote(q)
}

/**
 * How much of an intent is unfilled, and whether the chain would accept a fill at all.
 *
 * `ProveSettlement.available` moved to `ProveReader` to give the settlement bytes, so this asks
 * the reader. A chain with no reader answers by throwing: there is nothing to ask.
 */
export async function readAvailable(
  i: Intent,
  opts: ReadOptions = {},
): Promise<{ remaining: bigint; live: boolean }> {
  const chainId = opts.chainId ?? getChainId()
  const reader = readerAddress(chainId)
  if (!reader) throw new Error(`No ProveReader is deployed on chain ${chainId}.`)
  const [remaining, live] = (await (opts.client ?? rpcClient()).readContract({
    address: reader,
    abi: READER_ABI,
    functionName: 'available',
    args: [toStruct(i)],
  })) as readonly [bigint, boolean]
  return { remaining, live }
}

/**
 * The contract's `Reason` enum, in its declared order. `fillability` returns the ordinal, so
 * this list must stay aligned with `ProveSettlement.Reason`.
 */
export const FILL_REASONS = [
  'Ok',
  'BadTerms',
  'NotStarted',
  'Expired',
  'Cancelled',
  'NonceTooLow',
  'WrongExecutor',
  'NothingToFill',
  'TooMuch',
  'PartialNotAllowed',
  'EscrowShort',
  'BadSignature',
  /**
   * The intent asks for a higher rate than this caller passed as `maxFeeRate`.
   *
   * A bound on the destination rather than on the cost. The filler pays the gross at any rate, so
   * what this refuses is engaging with the address the maker named, not the price.
   */
  'FeeTooHigh',
  /**
   * The take is under the intent's `minFill` and does not close the intent out.
   *
   * A take that closes it out is always allowed, whatever the floor says, or every floored intent
   * would end in dust nobody could reach.
   */
  'BelowMinFill',
  /**
   * `tokenOut` would not answer a balance read inside the settlement's gas cap.
   *
   * Not the maker's fault and not yours: the intent names a token that answers with more bytes
   * than a caller can afford to copy, which the settlement refuses rather than pays for. It is
   * asked only on the deep paths — `fillability`, `dryRun` and a batch that may skip. A `fill`
   * meets the same token in the delivery and reverts `Underpaid`.
   *
   * A token can answer this way to a transaction and honestly to an `eth_call`, so a leg that
   * simulated clean can still come back with this. Step over it; do not retry it.
   */
  'TokenOutUnreadable',
] as const

/** Why a fill would be refused, or 'Ok' when it would not. */
export type FillReason = (typeof FILL_REASONS)[number]

/**
 * Ask the contract what it would do with this fill, without spending anything.
 *
 * `maxFeeRate` is part of the question, not a detail of the answer. An intent whose rate is above
 * the caller's bound is one a batch steps over, so a probe with an unbounded ceiling reports `Ok`
 * for a leg the fill is going to skip. Pass the same bound the fill will pass — `maxFeeRateFor`
 * builds it. The default asks the question without a bound.
 */
export async function readFillability(
  i: SignedIntent,
  take: bigint,
  executor: Address,
  opts: ReadOptions & { maxFeeRate?: bigint } = {},
): Promise<FillReason> {
  const ordinal = (await (opts.client ?? rpcClient()).readContract({
    address: settlement(opts.chainId ?? getChainId()),
    abi: SETTLEMENT_ABI,
    functionName: 'fillability',
    args: [toStruct(i), i.signature, take, executor, opts.maxFeeRate ?? MAX_UINT256],
  })) as number
  return fillReason(ordinal)
}

/** Turn the ordinal the chain returns into a name. Anything unknown reads as bad terms. */
export const fillReason = (ordinal: number): FillReason => FILL_REASONS[ordinal] ?? 'BadTerms'

/** No bound at all. The value `maxFeeRate` takes when a caller has no ceiling in mind. */
const MAX_UINT256 = (1n << 256n) - 1n

/**
 * A refusal in words an executor acts on.
 *
 * Two reasons have no error of their own name and are spelled out here. `Cancelled` is raised as
 * `IsCancelled`. `TokenOutUnreadable` is raised by no error at all: only the deep paths ask the
 * question, and a `fill` that meets the same token reverts `Underpaid` from the delivery instead.
 */
export const reasonText = (r: FillReason): string =>
  r === 'Ok'
    ? 'fillable'
    : r === 'TokenOutUnreadable'
      ? 'the intent\u2019s tokenOut would not answer a balance read'
      : (REASON_TEXT[r === 'Cancelled' ? 'IsCancelled' : r] ?? r)

// ── Escrow ────────────────────────────────────────────────────────────────────

/**
 * What the contract holds against one intent hash.
 *
 * One field. It carried a maker and a token once, then an amount and an unlock time, and every
 * shape it has had some reader has decoded wrong — the four-field destructure outlived the cut to
 * two and made `amount` undefined for a day. There is no field order left to get wrong.
 */
export type ReservationState = {
  amount: bigint
}

/** Reservation per hash, aligned with the input. Null where the read failed or nothing is live. */
export async function readReservations(
  hashes: readonly Hex[],
  opts: ReadOptions = {},
): Promise<(ReservationState | null)[]> {
  const id = opts.chainId ?? getChainId()
  if (!settlementLive(id) || hashes.length === 0) return hashes.map(() => null)
  const address = settlement(id)
  const results = await batchRead(
    hashes.map((h) => ({
      address,
      abi: SETTLEMENT_ABI,
      functionName: 'reserved',
      args: [h],
    })),
    opts.client,
  )
  // One value, so there is nothing to destructure and nothing to mis-order.
  return results.map((r) => (r.ok ? { amount: r.value as bigint } : null))
}

/**
 * What this maker has resting in the settlement, per token, aligned with the input.
 *
 * Named for the maker rather than for the solver, and that is the difference from `readParked`
 * in `solver/arming.ts`: that one takes intents and answers per leg, because a solver asks
 * "which of these can I arm". A maker asks "where is my money", which is a question about
 * tokens, and one of their tokens may have no live intent naming it at all — the offer that
 * funded the row is the dead one.
 *
 * **A client that knows `withdraw` and not this one shows a maker a balance that has gone
 * somewhere.** `park` empties `_reserved[h]` into `_parked[maker][tokenIn]` and anybody may call
 * it the moment an offer dies, so the money leaves the row the Mine tab was reading through no
 * act of the maker's. `ProveSettlement.park` says exactly that in its own NatSpec.
 *
 * Null where the read failed, as `readReservations` does, so an endpoint having a bad minute
 * never renders as a row that emptied itself.
 */
export async function readParkedBalances(
  maker: Address,
  tokens: readonly Address[],
  opts: ReadOptions = {},
): Promise<(bigint | null)[]> {
  const id = opts.chainId ?? getChainId()
  if (!settlementLive(id) || tokens.length === 0) return tokens.map(() => null)
  const address = settlement(id)
  const results = await batchRead(
    tokens.map((token) => ({
      address,
      abi: SETTLEMENT_ABI,
      functionName: 'parked',
      args: [maker, token],
    })),
    opts.client,
  )
  return results.map((r) => (r.ok ? (r.value as bigint) : null))
}

/**
 * Take one token's parked capital home. The maker's route back, once `park` has moved it.
 *
 * `withdraw` is for money a live intent still holds; this is for money that belongs to no intent
 * any more. One call per token, because the contract keeps one row per token and a maker who
 * parked three assets is owed three transfers whatever the shape of the call.
 *
 * There is no maker argument. The contract reads `msg.sender`, empties that row and pays that
 * address, so `account` here only says which of the wallet's addresses signs. It reverts on an
 * empty row rather than paying zero, which is deliberate: a silent success would tell a maker
 * their balance was fine when their token argument was wrong.
 */
export async function withdrawParked(
  wallet: ProveWalletClient,
  account: Address,
  token: Address,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  return wallet.writeContract({
    account,
    address: settlement(chainId),
    abi: SETTLEMENT_ABI,
    functionName: 'withdrawParked',
    args: [token],
  } as never)
}

/**
 * The address a maker approves. Not the settlement contract.
 *
 * `ProveRelayer` holds every maker allowance so that the contract which calls out to addresses a
 * caller chose holds none. Read it from the settlement rather than carrying it in configuration:
 * an approval to the wrong address costs a transaction and does nothing, and the maker only finds
 * out when a fill reverts. Cached per settlement address, so an override invalidates it for free.
 */
const relayers = new Map<Address, Address>()

export async function approvalTarget(opts: ReadOptions = {}): Promise<Address> {
  const id = opts.chainId ?? getChainId()
  const at = settlement(id)
  const known = relayers.get(at)
  if (known) return known

  const found = await (opts.client ?? rpcClient()).readContract({
    address: at,
    abi: SETTLEMENT_ABI,
    functionName: 'relayer',
  })
  relayers.set(at, found)
  return found
}

/**
 * The Permit2 this deployment uses — the address a maker on the permit2 rung approves.
 *
 * Read off the relayer, which holds it as an immutable, rather than carried in configuration.
 * Permit2 is at one canonical address on every chain that has it, and "canonical" is not
 * "what this deployment was actually wired to": a settlement built against a different one would
 * take every maker's approval to an address it will never call, and the maker would find out when
 * a fill reverted. So it is read, and cached per relayer for the same reason `approvalTarget` is.
 *
 * **This is the only grant on this rung that outlives anything.** The relayer moves whenever the
 * settlement is redeployed; this does not.
 */
const permit2s = new Map<Address, Address>()

export async function permit2Target(opts: ReadOptions = {}): Promise<Address> {
  const relayer = await approvalTarget(opts)
  const known = permit2s.get(relayer)
  if (known) return known

  const found = await (opts.client ?? rpcClient()).readContract({
    address: relayer,
    abi: RELAYER_ABI,
    functionName: 'permit2',
  })
  permit2s.set(relayer, found)
  return found
}

/** An account's allowance to the relayer for `token`. Maker or executor, same address. */
export async function relayerAllowance(
  owner: Address,
  token: Address,
  opts: ReadOptions = {},
): Promise<bigint> {
  const id = opts.chainId ?? getChainId()
  if (!settlementLive(id)) return 0n
  return (opts.client ?? rpcClient()).readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, await approvalTarget(opts)],
  })
}

/**
 * Wait for a transaction and throw when it reverted.
 *
 * `opts.chainId` names the chain the transaction was sent on. Without it the wait used the
 * global chain, so a network switch after the send polled the wrong chain for the receipt.
 */
export async function waitForTx(hash: Hex, opts: ReadOptions = {}): Promise<void> {
  const id = opts.chainId ?? getChainId()
  const client = opts.client ?? rpcClient(getChainRpc(id), id)
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error('The transaction reverted.')
}

/**
 * True when the chain says this approval would revert as things stand. No gas, one `eth_call`.
 *
 * Only a revert counts as a yes. viem wraps a reverted call in an `ExecutionRevertedError` and a
 * dead or slow endpoint in an `HttpRequestError`, and the two never cross — measured against both
 * revert codes a node sends, 3 and -32000, and against a refused connection and a 502.
 *
 * The call carries the maker's own address, because the answer depends on the allowance that
 * maker holds. Asking as anybody else would ask about a different allowance.
 */
async function raiseReverts(
  account: Address,
  token: Address,
  spender: Address,
  amount: bigint,
  chainId: ChainId,
): Promise<boolean> {
  try {
    await rpcClient(getChainRpc(chainId), chainId).call({
      account,
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
    })
    return false
  } catch (e) {
    return e instanceof BaseError && e.walk((x) => x instanceof ExecutionRevertedError) !== null
  }
}

/**
 * Set one spender's allowance for `token` to `amount`, zeroing it first when the token demands it.
 *
 * USDT and the tokens shaped like it refuse a non-zero approval while a non-zero allowance
 * already stands. So a maker holding a partial standing allowance cannot raise it: the approval
 * reverts and they have paid for it. `tUSDT` is in the 943 registry, so a maker meets this on
 * testnet today, and on mainnet as soon as we deploy there.
 *
 * **The rule: ask the chain, and zero first only when the chain says the raise would revert.**
 * One `eth_call` costs no gas and either comes back clean — and the raise goes out on its own —
 * or it reverts, and a zero approval goes ahead of it. A well-behaved token therefore never pays
 * for a zero approval it did not need, and no list of USDT-shaped addresses has to be kept
 * current. This is OpenZeppelin's `forceApprove` moved off chain: it turns on what the token
 * does, not on what we believe the token to be.
 *
 * **A probe that fails any other way is not an answer.** An endpoint that is down says nothing
 * about the token, so the approval goes out as it does today. Zeroing on a guess is not free: the
 * second approval is a second prompt, and a maker who refuses it holds less allowance than they
 * started with.
 *
 * A revoke never probes. Every token accepts a fall to zero, so an `amount` of zero goes straight
 * out.
 */
async function setAllowance(
  wallet: ProveWalletClient,
  account: Address,
  token: Address,
  spender: Address,
  amount: bigint,
  chainId: ChainId,
): Promise<Hex> {
  const approve = (value: bigint): Promise<Hex> =>
    wallet.writeContract({
      account,
      address: token,
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, value],
    } as never)
  if (amount > 0n && (await raiseReverts(account, token, spender, amount, chainId))) {
    await approve(0n)
  }
  // The raise is the transaction a caller waits on. Handing back the zeroing hash would confirm a
  // transaction that granted nothing.
  return approve(amount)
}

/**
 * Set the relayer's allowance for `token` to `amount`, whatever it is now.
 *
 * Refuses on a chain with no settlement, as every other write in this file does. `approvalTarget`
 * would otherwise read the relayer off the zero address, and that read is not reliably an error:
 * an endpoint that answers a codeless address with zeros hands back the zero address, and the
 * maker pays for an approval that grants nothing to anybody.
 */
export async function approveToken(
  wallet: ProveWalletClient,
  account: Address,
  token: Address,
  amount: bigint,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  return setAllowance(wallet, account, token, await approvalTarget({ chainId }), amount, chainId)
}

/**
 * Approve Permit2 for `amount`. The one transaction a maker on the permit2 rung ever sends.
 *
 * Grant it once, for as much as you will ever sell, and it survives every settlement redeploy —
 * which is the whole of the rung. Every signature after this one is short-lived and single-use,
 * so a wide approval here is not a standing allowance to us: Permit2 will only move tokens on a
 * signature naming a spender, and a signature is worth nothing until somebody presents it.
 *
 * Permit2's address is read off the relayer, which is read off the settlement. So this refuses a
 * chain with no settlement for `approveToken`'s reason, and it zeroes a standing grant first for
 * `setAllowance`'s: a maker raising a partial grant on a USDT-shaped token is the same case here.
 */
export async function approvePermit2(
  wallet: ProveWalletClient,
  account: Address,
  token: Address,
  amount: bigint,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  return setAllowance(wallet, account, token, await permit2Target({ chainId }), amount, chainId)
}

/**
 * Approve the relayer for `amount` when the allowance falls short, else nothing.
 *
 * It refuses a chain with no settlement before it reads anything, as its siblings here do. The
 * allowance read below is not that check and cannot stand in for it: `relayerAllowance` answers
 * zero wherever there is no deployment, and zero does not mean "grant something" — it means there
 * is no relayer to grant it to. Without this line the call went on to read the relayer off the
 * zero address, opened the caller's wallet, and asked a maker to pay for an approval that grants
 * nothing a fill can use.
 */
export async function approveRelayer(
  wallet: ProveWalletClient,
  account: Address,
  token: Address,
  amount: bigint,
  chainId: ChainId = getChainId(),
): Promise<Hex | null> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  const current = await relayerAllowance(account, token, { chainId })
  if (current >= amount) return null
  return approveToken(wallet, account, token, amount, chainId)
}

/** Commit token A to one intent, so an executor can see the funds cannot be moved. */
/**
 * Commit tokens to one intent.
 *
 * This takes the whole intent, not its hash, and that is the security property rather than a
 * convenience. The board publishes an intent's hash before any reservation exists, so a function
 * keyed on the bare hash let the first caller claim the slot: poison it with the right token and
 * the maker's own deposit funded the attacker. The hash already commits to the maker and the
 * token, so passing the preimage makes the attack impossible to express.
 */
export async function deposit(
  wallet: ProveWalletClient,
  account: Address,
  intent: Intent,
  amount: bigint,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  return wallet.writeContract({
    account,
    address: settlement(chainId),
    abi: SETTLEMENT_ABI,
    functionName: 'deposit',
    args: [intent, amount],
  } as never)
}

/**
 * Take your escrow back. One transaction, whenever you like, and only the maker can.
 *
 * There was a cooldown here, and a `requestUnlock` to start it, and a window that shut again if
 * you missed it. It protected an executor who buys the other leg in a separate transaction; every
 * fill path settles in one, so it was charging every maker for a risk an executor can decline.
 *
 * This ends the offer as well. An intent with an empty reservation cannot be filled, so a maker
 * who wants out does not need to `cancel` too.
 */
export async function withdrawReservation(
  wallet: ProveWalletClient,
  account: Address,
  intent: Intent,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  return wallet.writeContract({
    account,
    address: settlement(chainId),
    abi: SETTLEMENT_ABI,
    functionName: 'withdraw',
    args: [intent],
  } as never)
}

// ── Cancelling ────────────────────────────────────────────────────────────────

/**
 * Call off one intent. It bites on the block it lands in, in every custody mode.
 *
 * A maker in wallet custody has no other off switch. Revoking the token approval makes the
 * signature unfillable today, and re-approving that token later — an ordinary thing to do —
 * arms every intent the maker ever signed against it. The contract writes a cancellation
 * timestamp instead, and that one is permanent.
 *
 * Prefer `retract`: it costs the same gas and hands the money back when the intent is escrowed.
 */
export async function cancel(
  wallet: ProveWalletClient,
  account: Address,
  intent: Intent,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  return wallet.writeContract({
    account,
    address: settlement(chainId),
    abi: SETTLEMENT_ABI,
    functionName: 'cancel',
    args: [toStruct(intent)],
  } as never)
}

/**
 * Kill every intent this maker signed below `floor`, in one transaction.
 *
 * Intents are numbered with `Date.now()`, so `BigInt(Date.now())` retires everything signed up
 * to this moment. Escrowed money is not touched: the signatures stop being spendable and the
 * deposits are still the maker's to `withdrawReservation`.
 *
 * The contract refuses a floor at or below the one it already holds, so read `readNonceFloor`
 * first whenever the number does not come from a clock.
 */
export async function invalidateBefore(
  wallet: ProveWalletClient,
  account: Address,
  floor: bigint,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  return wallet.writeContract({
    account,
    address: settlement(chainId),
    abi: SETTLEMENT_ABI,
    functionName: 'invalidateBefore',
    args: [floor],
  } as never)
}

/**
 * Take one intent off the market by the route that actually ends it.
 *
 * A funded escrow intent goes out through `withdraw`, which returns the money and stamps the
 * cancellation in the same transaction — paying for `cancel` as well buys nothing. Everything
 * else goes through `cancel`: wallet custody, and an escrow intent nobody funded, which
 * `withdraw` refuses.
 *
 * Costs one read before the write — pass a `client` to spend it on your own endpoint. Call
 * `cancel` or `withdrawReservation` directly when the caller already knows which applies. When that read fails this cancels, which is the safe way
 * to be wrong: `withdraw` still works on a cancelled intent, so the money stays recoverable.
 */
export async function retract(
  wallet: ProveWalletClient,
  account: Address,
  intent: Intent,
  chainId: ChainId = getChainId(),
  client?: ReadOptions['client'],
): Promise<Hex> {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  if (isEscrow(intent)) {
    const [held] = await readReservations([intentHashOf(intent, chainId)], { chainId, client })
    if (held && held.amount > 0n) return withdrawReservation(wallet, account, intent, chainId)
  }
  return cancel(wallet, account, intent, chainId)
}

/**
 * When each intent's cancellation takes effect, aligned with the input.
 *
 * Zero means the maker never called it off. Null means the read failed, which is not the same
 * answer and must not be drawn as one.
 */
export async function readCancelledAt(
  hashes: readonly Hex[],
  opts: ReadOptions = {},
): Promise<(bigint | null)[]> {
  const id = opts.chainId ?? getChainId()
  if (!settlementLive(id) || hashes.length === 0) return hashes.map(() => null)
  const address = settlement(id)
  const results = await batchRead(
    hashes.map((h) => ({ address, abi: SETTLEMENT_ABI, functionName: 'cancelledAt', args: [h] })),
    opts.client,
  )
  return results.map((r) => (r.ok ? (r.value as bigint) : null))
}

/** The lowest nonce this maker still honours. Zero until they invalidate something. */
export async function readNonceFloor(maker: Address, opts: ReadOptions = {}): Promise<bigint> {
  const id = opts.chainId ?? getChainId()
  if (!settlementLive(id)) return 0n
  return (opts.client ?? rpcClient()).readContract({
    address: settlement(id),
    abi: SETTLEMENT_ABI,
    functionName: 'nonceFloor',
    args: [maker],
  })
}

/** The chain a write goes to, for callers that build their own wallet client. */
export const settlementChain = (id: ChainId = getChainId()) => network(id).chain

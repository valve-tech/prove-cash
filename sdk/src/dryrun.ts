import { decodeErrorResult, encodeFunctionData, type Hex } from 'viem'
import { SETTLEMENT_ABI } from './abi.js'
import { FILL_REASONS, toStruct, type Fill, type FillReason } from './settlement.js'

/**
 * `ProveSettlement.dryRun`, encoded and decoded. Two pure functions and no client.
 *
 * `fillability` asks storage whether one leg would fill, and a leg that carries `arming` has
 * moved past what storage can answer. Whether a permit lands, and whether a redemption comes up
 * short, are facts about a transfer that has already happened — a token that keeps a cut of
 * everything it moves credits the escrow with less than the intent asks for, so the reservation
 * is still short after a redemption that worked perfectly.
 *
 * So `dryRun` makes the calls, writes down what each leg came to, and reverts, which throws all
 * of it away. It never returns: the answer is the revert. `eth_call` it and hand the revert data
 * to `decodeDryRun`.
 *
 *   const data = await client.call({ account, to: settlement(chainId), data: encodeDryRun(...) })
 *
 * Callers differ too much for a wrapper to be worth having. A viem `call` that reverts throws,
 * an `eth_call` over a raw transport returns the data, and a solver batching several of these
 * through multicall holds the bytes itself. All three want the codec and none of them wants a
 * client this module chose.
 */

/**
 * The calldata for a dry run of these legs.
 *
 * @param maxFeeRate the highest rate this caller will pay, as a fraction of one ether. It is
 *        part of the question rather than a detail of the answer: a leg that asks for more is a
 *        leg the batch steps over, and a run without the bound calls that leg fillable.
 *
 * The legs go in the order the batch will fill them, because that is the order the contract
 * walks. A leg is booked and its token A released before the next one is evaluated, so two legs
 * of one intent, or two legs against one maker's allowance, see what the leg before them took.
 */
export function encodeDryRun(fills: readonly Fill[], maxFeeRate: bigint): Hex {
  return encodeFunctionData({
    abi: SETTLEMENT_ABI,
    functionName: 'dryRun',
    args: [
      fills.map((f) => ({
        intent: toStruct(f.intent),
        signature: f.intent.signature,
        take: f.take,
        arming: f.arming ?? '0x',
      })),
      maxFeeRate,
    ],
  })
}

/**
 * The reasons out of a `DryRun` revert, one per leg, in the order they were passed.
 *
 * Throws when the data is any other revert. That is not a dry run coming back negative — every
 * negative answer is a `Reason` inside a `DryRun` — it is the walk itself failing, which a token
 * that reverts on transfer will do to the real batch as well. Read the error and treat the batch
 * as unpriced.
 */
export function decodeDryRun(data: Hex): FillReason[] {
  const { errorName, args } = decodeErrorResult({ abi: SETTLEMENT_ABI, data })
  if (errorName !== 'DryRun') throw new Error(`Not a dry run: the call reverted with ${errorName}.`)
  // Ordinals on the wire. An ordinal this build has no name for is a contract newer than this
  // package, and `readFillability` reads an unknown one the same way.
  const ordinals = (args as readonly [readonly number[]])[0]
  return ordinals.map((o) => FILL_REASONS[o] ?? 'BadTerms')
}

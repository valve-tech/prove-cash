import type { Address } from 'viem'
import {
  authNonceOf,
  authWindowFor,
  getChainId,
  waitForTx,
  type ChainId,
  type CustodyMode,
  type Intent,
  type SignedIntent,
} from '@prove.cash/sdk'
import { approvePermit2, signAuthorization, signPermit, signPermit2 } from './custody'
import { approveRelayer, deposit } from './settlement'
import { signIntent } from './wallet'

/**
 * Sign an intent and arm it on whichever rung it was built for.
 *
 * The sign form did this inline, and it was the one block worth taking out of it. Every surface
 * that signs an intent has to arm it the same way, and the five rungs differ in what they cost, in
 * what they sign, and in what order — an exclusive quote signed with the escrow deposit sent
 * *after* the post would put a quote on the wire that no fill can pay for. The order is the
 * knowledge; a second copy of it is a second chance to get it wrong.
 *
 * The phases are reported rather than owned, because each caller draws its own button.
 */
export type ArmPhase = 'signing' | 'authorizing' | 'approving' | 'depositing'

export async function signAndArm(x: {
  account: Address
  intent: Intent
  mode: CustodyMode
  /** Whether the settlement is deployed on this chain. Only the two allowance rungs care. */
  live: boolean
  /** From `useCustody`. Null is unanswered, so approve: `approveRelayer` reads it again. */
  needsApproval: boolean | null
  /**
   * When the EIP-3009 authorization opens, in seconds. Only the 3009 rung signs one.
   *
   * It is the caller's, not the intent's: the sign form lets a maker move the funding window
   * away from the offer's own start, which is the whole argument for that rung. A caller with no
   * opinion passes the intent's `startTime`.
   */
  fundsFrom: bigint
  onPhase: (p: ArmPhase) => void
  /**
   * The chain the intent was built for. Read once, by the caller or here, and passed to every
   * step: a person can change network while a wallet prompt is open, and each later step would
   * otherwise address the new chain with an intent built for the old one.
   */
  chainId?: ChainId
}): Promise<SignedIntent> {
  const { account, intent, mode, live, needsApproval, fundsFrom, onPhase } = x
  const chainId = x.chainId ?? getChainId()

  onPhase('signing')
  const signature = await signIntent(intent, chainId)
  const signed: SignedIntent = { ...intent, signature }

  if (mode === 'authorization') {
    /*
     * The second signature, and the second window.
     *
     * Its 3009 nonce is whichever one the intent asks for — the hash of the intent itself,
     * unless the terms name another, which is what makes two offers mutually exclusive.
     * `authNonceOf` runs the same fold the settlement runs.
     *
     * `validAfter` used to be zero and the maker never saw it. Zero means the token will hand
     * the maker's tokens over the moment anybody asks, and only the settlement's own `_evaluate`
     * stands between a scheduled offer and an early redemption. Setting it to the offer's own
     * start puts a second lock on the same door, and the token holds that one. `validBefore`
     * stays welded to `endTime`: an authorization that dies before the offer kills it silently,
     * and one that outlives it arms nothing.
     */
    onPhase('authorizing')
    signed.auth = await signAuthorization(
      account,
      intent.tokenIn,
      intent.amountIn,
      authNonceOf(intent),
      authWindowFor(fundsFrom, intent.endTime),
      chainId,
    )
  }

  if (mode === 'permit') {
    // The second signature. It grants the relayer an allowance for exactly this amount, and
    // expires with the offer — a permit that outlived the intent would leave an allowance
    // standing for something nobody can fill.
    onPhase('authorizing')
    signed.permit = await signPermit(
      account,
      intent.tokenIn,
      intent.amountIn,
      intent.endTime,
      chainId,
    )
  }

  if (mode === 'permit2') {
    // One transaction, once ever: the approval to Permit2. It survives every settlement we
    // redeploy, which is the whole reason this rung exists — `approveRelayer` does not.
    onPhase('approving')
    const approveTx = await approvePermit2(account, intent.tokenIn, intent.amountIn, chainId)
    if (approveTx) await waitForTx(approveTx, { chainId })

    // The second signature. Single-use, expiring with the offer, and naming the relayer as its
    // spender — Permit2 hashes the caller in, so no other address can present it. The nonce is
    // whichever one the intent asks for, the same fold the settlement runs.
    onPhase('authorizing')
    signed.permit2 = await signPermit2(
      account,
      intent.tokenIn,
      intent.amountIn,
      BigInt(authNonceOf(intent)),
      intent.endTime,
      chainId,
    )
  }

  if (mode === 'escrow') {
    // Funds first, board second: the row must not read "in escrow" before the deposit lands.
    onPhase('approving')
    const approveTx = await approveRelayer(account, intent.tokenIn, intent.amountIn, chainId)
    if (approveTx) await waitForTx(approveTx, { chainId })
    onPhase('depositing')
    const depositTx = await deposit(account, intent, intent.amountIn, chainId)
    await waitForTx(depositTx, { chainId })
  } else if (mode === 'approval' && live && needsApproval !== false) {
    onPhase('approving')
    const approveTx = await approveRelayer(account, intent.tokenIn, intent.amountIn, chainId)
    if (approveTx) await waitForTx(approveTx, { chainId })
  }

  return signed
}

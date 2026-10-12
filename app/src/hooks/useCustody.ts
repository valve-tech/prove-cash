import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import {
  relayerAllowance,
  settlementLive,
  supports3009,
  supportsPermit,
  type CustodyMode,
  type TokenInfo,
} from '@prove.cash/sdk'
import { RUNGS, strongestRung, type Ctx } from '../lib/custody'

/**
 * Which custody rung a form is on, and everything the ladder needs to draw itself.
 *
 * Three facts decide it and all three are asynchronous: whether the token can do EIP-3009,
 * whether it can do EIP-2612, and whether the maker's standing allowance already covers the
 * amount. The sign form has read those three since the ladder existed. The exclusive-quote
 * surfaces need the same three — a quote is an ordinary intent and its maker pays for it the same
 * way — so the reads live here rather than being written a second time beside a second ladder.
 *
 * @param token the token this side SELLS. Custody is about the tokens leaving the signer.
 * @param amountWei how much of it. The allowance is short or it is not, relative to this.
 */
export function useCustody(account: Address | null, token: TokenInfo | null, amountWei: bigint) {
  const [custody, setCustody] = useState<CustodyMode | null>(null)
  const [can3009, setCan3009] = useState<boolean | 'probing'>(false)
  const [canPermit, setCanPermit] = useState<boolean | 'probing'>(false)
  const [allowance, setAllowance] = useState<bigint | null>(null)
  const live = settlementLive()

  // Which rungs this token can climb: EIP-3009 for authorization, EIP-2612 for permit.
  useEffect(() => {
    if (!token) return
    let stale = false
    setCan3009('probing')
    setCanPermit('probing')
    supports3009(token.address)
      .then((ok) => !stale && setCan3009(ok))
      .catch(() => !stale && setCan3009(false))
    supportsPermit(token.address)
      .then((ok) => !stale && setCanPermit(ok))
      .catch(() => !stale && setCanPermit(false))
    return () => {
      stale = true
    }
  }, [token])

  // The allowance decides whether escrow and approval cost an extra transaction.
  useEffect(() => {
    setAllowance(null)
    if (!account || !token || !live) return
    let stale = false
    relayerAllowance(account, token.address)
      .then((a) => !stale && setAllowance(a))
      .catch((e) => console.warn('allowance read failed; signAndArm reads it again', e))
    return () => {
      stale = true
    }
  }, [account, token, live])

  // Is the standing allowance short of the amount? This is a fact about the token, not about the
  // rung, so the ladder can price every rung with it before a rung is chosen.
  const allowanceShort = allowance === null ? null : allowance < amountWei

  const ctx: Ctx = { live, can3009, canPermit, needsApproval: live ? allowanceShort : null }

  // The app takes the strongest rung the token supports. A click on a lower rung overrides, and
  // the override falls away when the token changes and the rung stops being available.
  const mode: CustodyMode =
    custody && RUNGS[custody](ctx).lock === undefined ? custody : strongestRung(ctx)

  // Only escrow and approval pay for an allowance with a transaction. Authorization, permit and
  // permit2 all buy one with a signature.
  const needsApproval = live && (mode === 'escrow' || mode === 'approval') ? allowanceShort : false

  return { ctx, mode, setCustody, needsApproval, live }
}

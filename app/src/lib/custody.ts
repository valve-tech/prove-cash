import type { Address, Hex } from 'viem'
import {
  approvePermit2 as approvePermit2Sdk,
  getChainId,
  permit2Allowance,
  signAuthorization as sign,
  signPermit as signPermitSdk,
  signPermit2 as signPermit2Sdk,
  type Auth3009,
  type AuthWindow,
  type ChainId,
  type CustodyMode,
  type Permit2612,
  type Permit2Transfer,
} from '@prove.cash/sdk'
import { ltr, t } from './i18n'
import { browserWallet } from './wallet'

/**
 * Where the tokens are while the offer is live. This is what a board row says, and it replaces
 * "proven": that word collided with the proof of work the board charges, and it was never true of
 * the authorization rung, which pays out of the maker's balance at fill time.
 *
 * The CSS tokens are still named `--color-proven` and `--color-unproven`. Green is the committed
 * end of the ladder, amber the spendable end; only the words changed.
 *
 * `Where` is an identifier, not the label. It used to be the English words themselves, which read
 * beautifully until a second language arrived: `whereTone` compared against `'in wallet'` and the
 * tone would have followed the reader's language rather than the custody. The three ids are the
 * app's own; `whereText` turns one into whatever the reader reads.
 */
export type Where = 'escrow' | 'fill' | 'wallet'

/** The one place a rung is tied to a label. A new `CustodyMode` will not compile without one. */
export const WHERE: Record<CustodyMode, Where> = {
  authorization: 'fill',
  escrow: 'escrow',
  // `fill`, not `wallet`, and the difference is real rather than flattering. A permit2 signature
  // is single-use and carries its own deadline, so nothing rests on an allowance to us and the
  // tokens leave the maker at the moment of the fill — which is what the authorization rung does,
  // and why neither leaves a signature a later re-approval can revive.
  permit2: 'fill',
  permit: 'wallet',
  approval: 'wallet',
}

const WHERE_LABEL = {
  escrow: 'custody.where.escrow',
  fill: 'custody.where.fill',
  wallet: 'custody.where.wallet',
} as const

const WHERE_SPOKEN = {
  escrow: 'custody.where.escrow.spoken',
  fill: 'custody.where.fill.spoken',
  wallet: 'custody.where.wallet.spoken',
} as const

/** The badge a row wears: two or three words for where the maker's tokens are. */
export const whereText = (w: Where): string => t(WHERE_LABEL[w])

export const whereTone = (w: Where) =>
  w === 'wallet' ? 'text-(--color-unproven)' : 'text-(--color-proven)'

/** The label, said out loud. `funds at fill` is a heading, not a sentence. */
export const whereSpoken = (w: Where): string => t(WHERE_SPOKEN[w])

/** True when the offer is armed by an allowance rather than by anything the contract holds. */
export const walletCustody = (m: CustodyMode) => WHERE[m] === 'wallet'

/** What the ladder has to know to price and to lock a rung. */
export type Ctx = {
  live: boolean
  /** 'probing' while the token capability check runs. */
  can3009: boolean | 'probing'
  canPermit: boolean | 'probing'
  /** True when the current allowance cannot cover the amount. Null while unknown. */
  needsApproval: boolean | null
}

export type Rung = {
  name: string
  /** What the maker spends to arm the offer. */
  cost: string
  /** What it costs to get the tokens back out again. */
  exit: string
  /** The same two prices in words. `·`, `tx` and `2m` do not survive being read aloud. */
  spoken: string
  /** Set when the rung cannot be picked: the two-word reason shown in the label slot. */
  lock?: string
}

/**
 * Every rung, strongest first. This is the whole list — add a `CustodyMode` to the SDK and
 * TypeScript demands an entry here. Nothing counts the rungs, and nothing else fixes the order.
 */
export const RUNGS: Record<CustodyMode, (c: Ctx) => Rung> = {
  authorization: ({ live, can3009 }) => ({
    name: t('custody.mode.authorization'),
    cost: t('custody.cost.signatures'),
    exit: t('custody.exit.none'),
    spoken: t('custody.spoken.authorization'),
    lock: !live
      ? t('custody.lock.deploy')
      : can3009 === 'probing'
        ? '…'
        : can3009
          ? undefined
          : t('custody.lock.no3009'),
  }),
  escrow: ({ live, needsApproval }) => {
    const tx = !live || needsApproval === null ? '1–2' : needsApproval ? '2' : '1'
    const said =
      tx === '1–2'
        ? t('custody.tx.oneOrTwo')
        : tx === '2'
          ? t('custody.tx.two')
          : t('custody.tx.one')
    return {
      name: t('custody.mode.escrow'),
      cost: t('custody.cost.signature', { count: tx }),
      exit: t('custody.exit.one'),
      spoken: t('custody.spoken.escrow', { transactions: said }),
      lock: live ? undefined : t('custody.lock.deploy'),
    }
  },
  permit2: ({ live }) => ({
    name: t('custody.mode.permit2'),
    // Two signatures, and at most one transaction — the approval to Permit2, which a maker makes
    // once and never again. Every settlement we deploy after it reuses the same grant.
    // Isolated, because `≤` mirrors. Dropped bare into a Hebrew or Arabic sentence it resolves
    // to an odd bidi level and is drawn as `≥` — the opposite claim, about how many transactions
    // a maker signs. A translator cannot fix that from inside a locale file.
    cost: t('custody.cost.signatures.tx', { count: ltr('≤1') }),
    exit: t('custody.exit.none'),
    spoken: t('custody.spoken.permit2'),
    // No token capability to probe. Permit2 asks nothing of the token, which is why this rung
    // reaches makers holding assets that can do neither EIP-2612 nor EIP-3009.
    lock: live ? undefined : t('custody.lock.deploy'),
  }),
  permit: ({ live, canPermit }) => ({
    name: t('custody.mode.permit'),
    cost: t('custody.cost.signatures'),
    exit: t('custody.exit.none'),
    spoken: t('custody.spoken.permit'),
    lock: !live
      ? t('custody.lock.deploy')
      : canPermit === 'probing'
        ? '…'
        : canPermit
          ? undefined
          : t('custody.lock.no2612'),
  }),
  approval: ({ live, needsApproval }) => {
    const tx = needsApproval === null ? '≤1' : needsApproval ? '1' : '0'
    const said =
      tx === '≤1' ? t('custody.tx.upto') : tx === '1' ? t('custody.tx.one') : t('custody.tx.none')
    return {
      name: t('custody.mode.approval'),
      cost: t('custody.cost.signature', { count: tx }),
      exit: t('custody.exit.none'),
      spoken: t('custody.spoken.approval', { transactions: said }),
      // The last rung to be locked, and the one the whole ladder leaned on. It used to stay open
      // on a chain with no settlement and advertise "one signature, no transaction" — which read
      // as an offer a maker could arm now and approve later. It was not. The intent's EIP-712
      // domain names the settlement, so an undeployed chain signs `verifyingContract` of
      // `0x0000…0000`: bound to no contract, spendable by nobody, and not repaired by the
      // deploy that follows. Seven offers reached the public mainnet archive through this rung.
      //
      // So the settlement gates every rung, because it is the same fact for all five. What
      // differs per rung — 3009, 2612, an allowance — is checked after it.
      lock: live ? undefined : t('custody.lock.deploy'),
    }
  },
}

/** The ladder, strongest rung first. `RUNGS` fixes the order; nothing repeats it. */
export const LADDER = Object.keys(RUNGS) as CustodyMode[]

/**
 * The rung the app takes on its own, and the reason for the order.
 *
 * Security leads and gas breaks ties. Escrow is the only rung that commits anything, so it
 * outranks permit even though permit costs no transaction: the app cannot know the maker's gas
 * budget, but it does know that a rung whose tokens can vanish makes a weaker offer, caps the
 * window at an hour, and wastes an executor's fill. Permit's job is to replace approval — same
 * custody, one signature instead of a transaction — for a maker who steps down on purpose.
 *
 * `permit2` sits between them for the same reason and against the same test. It is the better
 * wallet rung — single-use signatures, nothing standing for a redeploy to orphan, and it asks
 * nothing of the token — but it still commits nothing, so escrow outranks it.
 *
 * A consequence worth naming: escrow is available whenever the settlement contract is live, so
 * neither permit2 nor permit is ever auto-selected. Both are overrides, and that is the point.
 *
 * **The fallback is a rung to draw, not permission to use one.** Every rung locks when the
 * settlement is not live, and this still answers `approval` then, because a chooser has to
 * highlight something. A caller that reads the answer and skips the lock gets a rung it must not
 * arm — which is how a maker came to sign against a `verifyingContract` of zero. Ask
 * `RUNGS[mode](ctx).lock` before you act on the answer.
 */
export function strongestRung(c: Ctx): CustodyMode {
  return LADDER.find((m) => RUNGS[m](c).lock === undefined) ?? 'approval'
}

/**
 * Sign a `receiveWithAuthorization` with the browser wallet. The SDK builds the typed data and
 * resolves the token's own EIP-712 domain; only the signature needs a wallet, so only that is
 * here. Everything else about the custody ladder — `supports3009`, `CustodyMode` — comes
 * straight from the SDK.
 *
 * It returns the whole `Auth3009`, so the window on the board is the window that was signed.
 */
export async function signAuthorization(
  account: Address,
  token: Address,
  value: bigint,
  authNonce: Hex,
  authWindow: AuthWindow,
  chainId: ChainId = getChainId(),
): Promise<Auth3009> {
  return sign(await browserWallet(chainId), account, token, value, authNonce, authWindow, chainId)
}

/**
 * Approve Permit2 for `amount`, or nothing when the maker's standing grant already covers it.
 *
 * The only transaction the permit2 rung ever costs, and a maker pays it once: Permit2's address
 * is the same on every chain and no redeploy of ours moves it, so this grant outlives every
 * settlement we deploy. Compare that with `approveRelayer`, which every redeploy orphans.
 */
export async function approvePermit2(
  account: Address,
  token: Address,
  amount: bigint,
  chainId: ChainId = getChainId(),
): Promise<Hex | null> {
  if ((await permit2Allowance(account, token, chainId)) >= amount) return null
  return approvePermit2Sdk(await browserWallet(chainId), account, token, amount, chainId)
}

/**
 * Sign one Permit2 transfer with the browser wallet.
 *
 * The SDK reads Permit2's address off the relayer and names the relayer as the spender, so a
 * caller cannot sign for the wrong one — and Permit2 hashes the caller in as the spender, so a
 * signature made for our relayer is unusable by any other address.
 */
export async function signPermit2(
  account: Address,
  token: Address,
  amount: bigint,
  nonce: bigint,
  deadline: bigint,
  chainId: ChainId = getChainId(),
): Promise<Permit2Transfer> {
  return signPermit2Sdk(
    await browserWallet(chainId),
    account,
    token,
    amount,
    nonce,
    deadline,
    chainId,
  )
}

/**
 * Sign an EIP-2612 permit with the browser wallet, for the relayer to spend.
 *
 * The SDK reads the token's nonce and domain and resolves the spender off the settlement, so a
 * caller cannot permit the wrong address. Only the signature needs a wallet.
 */
export async function signPermit(
  account: Address,
  token: Address,
  value: bigint,
  deadline: bigint,
  chainId: ChainId = getChainId(),
): Promise<Permit2612> {
  return signPermitSdk(await browserWallet(chainId), account, token, value, deadline, chainId)
}

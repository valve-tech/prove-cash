import { parseAbi, type Address, type Hex, type TypedDataDomain } from 'viem'
import { rpcClient, type ProveWalletClient } from './client.js'
import { getChainId, settlement, type ChainId } from './config.js'
import type { Auth3009, Permit2612, Permit2Transfer } from './intent.js'
import { approvalTarget, permit2Target } from './settlement.js'
import { kv } from './kv.js'

/**
 * The custody ladder's capability layer. Approval is the floor and needs nothing. Escrow needs
 * only a live settlement contract. Authorization needs the token to speak EIP-3009, which the
 * facilitator's capability list answers first and an on-chain probe answers when the list is
 * unreachable or silent about the token.
 */

/**
 * How the maker's token A reaches the executor. Each rung needs more of the token.
 *
 * `permit` is the approval rung with the transaction removed, not a stronger custody: it grants a
 * reusable allowance from a signature, so the tokens stay spendable and revoking the allowance
 * never cancels the intent. It exists because almost nothing implements EIP-3009 and nearly
 * everything implements EIP-2612.
 *
 * **`permit2` is the rung that survives a settlement redeploy, and it is the only one that
 * does.** Every other rung that reaches a wallet rests on an ERC-20 allowance to `ProveRelayer`,
 * and the settlement's constructor creates the relayer — so a new settlement orphans every one of
 * those approvals and every maker has to grant them again. A permit2 maker approves Permit2
 * instead, at an address that is the same on every chain and moves for nobody, and signs one
 * short-lived transfer per intent. It also asks nothing of the token, so it reaches makers whose
 * assets can do neither EIP-2612 nor EIP-3009.
 */
export type CustodyMode = 'approval' | 'permit' | 'escrow' | 'authorization' | 'permit2'

const FACILITATOR_URL = 'https://facilitator.valve.city/supported'
const CACHE_KEY = 'provecash.eip3009'
const CACHE_TTL_MS = 3600_000

const PERMIT_ABI = parseAbi([
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
])

const AUTH_STATE_ABI = parseAbi([
  'function authorizationState(address authorizer, bytes32 nonce) view returns (bool)',
])

const ERC5267_ABI = parseAbi([
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
])

const NAME_ABI = parseAbi(['function name() view returns (string)'])

// ── EIP-3009 detection ────────────────────────────────────────────────────────

type CapCache = { fetchedAt: number; tokens: Record<string, boolean> }

function readCache(): CapCache | null {
  try {
    return JSON.parse(kv().getItem(CACHE_KEY) || 'null')
  } catch {
    return null
  }
}

function writeCache(c: CapCache) {
  kv().setItem(CACHE_KEY, JSON.stringify(c))
}

type FacToken = { address?: string; capabilities?: string[] }
type FacKind = { extra?: { tokens?: FacToken[] } }

let facPromise: Promise<Map<string, boolean> | null> | null = null

/** The facilitator's token capability map, or null when it cannot be fetched. */
function facilitatorTokens(): Promise<Map<string, boolean> | null> {
  facPromise ??= (async () => {
    try {
      const res = await fetch(FACILITATOR_URL, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) return null
      const json = (await res.json()) as { kinds?: FacKind[] }
      const map = new Map<string, boolean>()
      for (const kind of json.kinds ?? []) {
        for (const t of kind.extra?.tokens ?? []) {
          if (!t.address) continue
          const has = (t.capabilities ?? []).includes('eip3009')
          const key = t.address.toLowerCase()
          map.set(key, map.get(key) || has)
        }
      }
      return map
    } catch {
      return null
    }
  })()
  return facPromise
}

/** Ask the token itself: a contract with `authorizationState` speaks EIP-3009. */
async function probe3009(token: Address): Promise<boolean> {
  try {
    await rpcClient().readContract({
      address: token,
      abi: AUTH_STATE_ABI,
      functionName: 'authorizationState',
      args: [token, `0x${'0'.repeat(64)}` as Hex],
    })
    return true
  } catch {
    return false
  }
}

/**
 * True when `token` supports EIP-3009. Facilitator first (chain 369 only —
 * that is the chain it serves), on-chain probe otherwise. Results persist: the capability is a
 * property of the deployed code and never changes.
 */
export async function supports3009(token: Address): Promise<boolean> {
  const chainId = getChainId()
  const key = `${chainId}:${token.toLowerCase()}`
  const cache = readCache()
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS && key in cache.tokens) {
    return cache.tokens[key]
  }
  let answer: boolean | null = null
  if (chainId === 369) {
    const listed = await facilitatorTokens()
    if (listed?.has(token.toLowerCase())) answer = listed.get(token.toLowerCase())!
  }
  answer ??= await probe3009(token)
  const next = cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS ? cache : { fetchedAt: Date.now(), tokens: {} }
  next.tokens[key] = answer
  writeCache(next)
  return answer
}

// ── Authorization signing ─────────────────────────────────────────────────────

/**
 * The EIP-3009 struct the settlement redeems through.
 *
 * `Receive`, never `Transfer`. Both exist in the standard and they differ by one thing: the token
 * requires `to == msg.sender` for this one, so only the named recipient can submit it. That is
 * what stops a stranger relaying a maker's authorization straight to the token — which would put
 * the money in the settlement with no reservation credited, spend the nonce, and lose the
 * maker's tokens with no way back. Signing the other typehash reintroduces that.
 */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/** The token's own EIP-712 domain: ERC-5267 when it answers, `name()` + version "1" otherwise. */
export async function tokenDomain(token: Address, chainId: number): Promise<TypedDataDomain> {
  try {
    const d = await rpcClient().readContract({
      address: token,
      abi: ERC5267_ABI,
      functionName: 'eip712Domain',
    })
    return { name: d[1], version: d[2], chainId: Number(d[3]), verifyingContract: d[4] }
  } catch {
    const name = await rpcClient()
      .readContract({ address: token, abi: NAME_ABI, functionName: 'name' })
      .catch(() => '')
    return { name, version: '1', chainId, verifyingContract: token }
  }
}

/** Everything `signTypedData` needs for one `receiveWithAuthorization`. */
export type AuthorizationRequest = {
  domain: TypedDataDomain
  types: typeof RECEIVE_WITH_AUTHORIZATION_TYPES
  primaryType: 'ReceiveWithAuthorization'
  message: {
    from: Address
    to: Address
    value: bigint
    validAfter: bigint
    validBefore: bigint
    nonce: Hex
  }
}

/**
 * The two bounds a `receiveWithAuthorization` carries, as the caller chooses them.
 *
 * A window and not a bare `validBefore`, because this used to be one argument and a hardcoded
 * zero. The zero was minted here, inside the signed message, while every caller wrote its own
 * copy of it into the `Auth3009` that travels on the wire. Nothing tied the two together, so a
 * caller that moved one and not the other produced a signature no token would recover. Both
 * bounds now arrive as one value and leave as one value.
 */
export type AuthWindow = Pick<Auth3009, 'validAfter' | 'validBefore'>

/**
 * The authorization's own window, from the two seconds the maker means it to cover.
 *
 * A window and not two loose arguments, because these two numbers used to travel separately. The
 * SDK baked a zero `validAfter` into the message it signed, and the caller wrote its own zero
 * onto the wire. Nothing compared them. Move one and not the other and the token cannot recover
 * the signature, so the fill fails with a reason that names something else.
 *
 * **The bounds sit one second outside the seconds they mean, and that is the standard's doing.**
 * EIP-3009 is exclusive at both ends: the token requires `validAfter < now < validBefore`. So a
 * `validAfter` set to the offer's own `startTime` costs the offer its first second, and a
 * `validBefore` set to its `endTime` costs the last. One second of an hour is nothing to a
 * maker. A second the form does not mention is a gap between what it shows and what the chain
 * does, and a client that hides one second will hide a larger one next. So take `usableFrom` and `usableUntil`
 * as the offer's own two ends, and the token's window becomes exactly the intent's.
 */
export const authWindowFor = (usableFrom: bigint, usableUntil: bigint): AuthWindow => ({
  validAfter: usableFrom - 1n,
  validBefore: usableUntil + 1n,
})

/**
 * Build the typed data for a `receiveWithAuthorization` of `value` to the settlement contract.
 * Sign it with whatever wallet you hold.
 *
 * The nonce is the one the intent asks for, and the contract refuses any other — pass
 * `authNonceOf(intent)` rather than a hash of your own. It is the intent's hash by default, which
 * welds one authorization to one intent; an intent that names its own makes siblings sharing that
 * nonce mutually exclusive, because a token spends a 3009 nonce once.
 *
 * **`authWindow` is not the intent's window and the chain never compares them.** The token enforces
 * this one; the settlement enforces `startTime` and `endTime`. `liveWindow` says where the two
 * overlap, and a caller that does not check it can sign an offer nobody can ever fill.
 */
export async function authorizationRequest(
  account: Address,
  token: Address,
  value: bigint,
  authNonce: Hex,
  authWindow: AuthWindow,
  chainId: ChainId = getChainId(),
): Promise<AuthorizationRequest> {
  return {
    domain: await tokenDomain(token, chainId),
    types: RECEIVE_WITH_AUTHORIZATION_TYPES,
    primaryType: 'ReceiveWithAuthorization',
    message: {
      from: account,
      to: settlement(chainId),
      value,
      validAfter: authWindow.validAfter,
      validBefore: authWindow.validBefore,
      nonce: authNonce,
    },
  }
}

/**
 * Sign the authorization above with a wallet the caller owns.
 *
 * The signature is whatever the wallet returns. A key gives 65 bytes; a smart account gives its
 * own ERC-1271 answer, of any length, and the settlement reaches the token's ERC-7598 overload
 * for it. Nothing here has to know which — the length decides at the call, not at the signing.
 *
 * It returns the whole `Auth3009`, not the bare signature. The bounds that go on the wire are
 * then the bounds that were signed, because they are one object and no caller retypes them. A
 * caller that retyped them could put a window on the board that the signature does not carry,
 * and the token would reject a fill nobody could explain.
 */
export async function signAuthorization(
  wallet: ProveWalletClient,
  account: Address,
  token: Address,
  value: bigint,
  authNonce: Hex,
  authWindow: AuthWindow,
  chainId: ChainId = getChainId(),
): Promise<Auth3009> {
  const request = await authorizationRequest(account, token, value, authNonce, authWindow, chainId)
  const signature = await wallet.signTypedData({ account, ...request })
  return { validAfter: request.message.validAfter, validBefore: request.message.validBefore, signature }
}


// ── EIP-2612 ──────────────────────────────────────────────────────────────────

const PERMIT_CACHE_KEY = 'provecash.eip2612'

/**
 * Does this token take a permit?
 *
 * Probed rather than listed. There is no facilitator for EIP-2612 and no registry worth trusting,
 * but the two reads a permit needs — `nonces` and `DOMAIN_SEPARATOR` — are the same two the
 * signature is built from, so a token that answers both can be signed for and a token that does
 * not cannot. Answering them is not proof the token honours a permit, and nothing here treats it
 * as proof: the fill attempts the permit, ignores the outcome, and lets the transfer decide.
 */
export async function supportsPermit(token: Address): Promise<boolean> {
  const chainId = getChainId()
  const key = `${chainId}:${token.toLowerCase()}`
  const cache = readPermitCache()
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS && key in cache.tokens) {
    return cache.tokens[key]
  }
  let answer = false
  try {
    const client = rpcClient()
    await Promise.all([
      client.readContract({ address: token, abi: PERMIT_ABI, functionName: 'nonces', args: [token] }),
      client.readContract({ address: token, abi: PERMIT_ABI, functionName: 'DOMAIN_SEPARATOR' }),
    ])
    answer = true
  } catch {
    answer = false
  }
  const next =
    cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS ? cache : { fetchedAt: Date.now(), tokens: {} }
  next.tokens[key] = answer
  writePermitCache(next)
  return answer
}

type PermitCache = { fetchedAt: number; tokens: Record<string, boolean> }

function readPermitCache(): PermitCache | null {
  try {
    const raw = kv().getItem(PERMIT_CACHE_KEY)
    return raw ? (JSON.parse(raw) as PermitCache) : null
  } catch {
    return null
  }
}

function writePermitCache(c: PermitCache) {
  try {
    kv().setItem(PERMIT_CACHE_KEY, JSON.stringify(c))
  } catch {
    /* a full or absent store is not worth failing a signature over */
  }
}

/** The EIP-2612 struct, exactly as the standard names it. */
export const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

/** Everything `signTypedData` needs for one permit. */
export type PermitRequest = {
  domain: TypedDataDomain
  types: typeof PERMIT_TYPES
  primaryType: 'Permit'
  message: {
    owner: Address
    spender: Address
    value: bigint
    nonce: bigint
    deadline: bigint
  }
}

/**
 * Build the typed data for a permit that lets the relayer move `value`.
 *
 * **The spender is the relayer, never the settlement.** The settlement holds no allowance of any
 * kind — every `transferFrom` goes through `ProveRelayer.pull` — so permitting the settlement
 * grants an allowance nothing will ever spend and leaves the fill reverting.
 *
 * The nonce is read from the token at build time. It is also the reason a permit is worth nothing
 * as a promise: anybody who sees the signature can submit it, which moves the nonce and sets the
 * allowance just the same. The protocol expects that and does not treat it as a failure.
 */
export async function permitRequest(
  account: Address,
  token: Address,
  value: bigint,
  deadline: bigint,
  chainId: ChainId = getChainId(),
): Promise<PermitRequest> {
  const [domain, nonce, spender] = await Promise.all([
    tokenDomain(token, chainId),
    rpcClient().readContract({
      address: token,
      abi: PERMIT_ABI,
      functionName: 'nonces',
      args: [account],
    }),
    approvalTarget({ chainId }),
  ])
  return {
    domain,
    types: PERMIT_TYPES,
    primaryType: 'Permit',
    message: { owner: account, spender, value, nonce: nonce as bigint, deadline },
  }
}

// ── Permit2 ───────────────────────────────────────────────────────────────────

/**
 * Permit2's own EIP-712 types for one SignatureTransfer.
 *
 * `spender` is a field of the *signed struct* and not of the permit the caller sends: Permit2
 * hashes `msg.sender` into the digest and reads no such field, so what a signature commits to is
 * whoever will present it. Ours is the relayer, and no other address can spend this.
 */
export const PERMIT2_TRANSFER_TYPES = {
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

/**
 * Permit2's EIP-712 domain, which is **not** shaped like any other domain in this package.
 *
 * There is no version string. Adding one, or letting a helper default one in, changes the domain
 * separator and every signature built from it recovers to the wrong address — silently, because
 * the failure lands inside Permit2 as a bad signer and reaches the solver as `EscrowShort`.
 */
export async function permit2Domain(chainId: ChainId = getChainId()): Promise<TypedDataDomain> {
  return { name: 'Permit2', chainId, verifyingContract: await permit2Target({ chainId }) }
}

/** Everything `signTypedData` needs for one Permit2 transfer. */
export type Permit2Request = {
  domain: TypedDataDomain
  types: typeof PERMIT2_TRANSFER_TYPES
  primaryType: 'PermitTransferFrom'
  message: {
    permitted: { token: Address; amount: bigint }
    spender: Address
    nonce: bigint
    deadline: bigint
  }
}

/**
 * Build the typed data for one Permit2 transfer of `amount` of `token`.
 *
 * @param nonce the intent's `authNonce`, or its hash when that field is zero. `_pullPermit2In`
 *        refuses anything else, which is what welds one signature to one offer — and what makes
 *        two offers naming one nonce mutually exclusive, since Permit2 spends it once.
 *
 * **The spender is the relayer, never the settlement.** Rule 3 in `ProveSettlement`'s header has
 * no exception: every `transferFrom` this protocol makes goes through `ProveRelayer`, so a
 * signature naming the settlement names an address that will never present it.
 *
 * **The maker must have approved Permit2 for `token` first.** That approval is the one durable
 * thing on this rung and the only transaction the maker ever sends; `permit2Allowance` reads it.
 */
export async function permit2Request(
  token: Address,
  amount: bigint,
  nonce: bigint,
  deadline: bigint,
  chainId: ChainId = getChainId(),
): Promise<Permit2Request> {
  const [domain, spender] = await Promise.all([
    permit2Domain(chainId),
    approvalTarget({ chainId }),
  ])
  return {
    domain,
    types: PERMIT2_TRANSFER_TYPES,
    primaryType: 'PermitTransferFrom',
    message: { permitted: { token, amount }, spender, nonce, deadline },
  }
}

/**
 * Sign the transfer above. Returns the form the wire codec carries and `encodeArming` sends.
 *
 * The nonce is not in the result, for the reason `Permit2Transfer` gives: it is derivable from
 * the intent, and a second copy could disagree with the first.
 */
export async function signPermit2(
  wallet: ProveWalletClient,
  account: Address,
  token: Address,
  amount: bigint,
  nonce: bigint,
  deadline: bigint,
  chainId: ChainId = getChainId(),
): Promise<Permit2Transfer> {
  const request = await permit2Request(token, amount, nonce, deadline, chainId)
  const signature = await wallet.signTypedData({ account, ...request })
  return { token, amount, deadline, signature }
}

/**
 * What this account has approved Permit2 to move of `token`.
 *
 * The whole of a permit2 maker's on-chain footprint. It is an ordinary ERC-20 allowance, so it is
 * read the ordinary way — and unlike the allowance the other wallet rungs need, it survives every
 * settlement we deploy, because Permit2's address is not ours to move.
 */
export async function permit2Allowance(
  owner: Address,
  token: Address,
  chainId: ChainId = getChainId(),
): Promise<bigint> {
  return rpcClient().readContract({
    address: token,
    abi: ALLOWANCE_ABI,
    functionName: 'allowance',
    args: [owner, await permit2Target({ chainId })],
  })
}

const ALLOWANCE_ABI = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
])

/**
 * Sign the permit above. Returns the packed form the wire codec carries, the same shape a 3009
 * authorization travels in — `splitPermit` takes it apart again at the contract call.
 */
export async function signPermit(
  wallet: ProveWalletClient,
  account: Address,
  token: Address,
  value: bigint,
  deadline: bigint,
  chainId: ChainId = getChainId(),
): Promise<Permit2612> {
  const request = await permitRequest(account, token, value, deadline, chainId)
  const signature = await wallet.signTypedData({ account, ...request })
  return { value, deadline, signature }
}


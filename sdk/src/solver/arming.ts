import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverAddress,
  stringToHex,
  type Address,
  type Chain,
  type Hex,
  type HttpTransport,
  type PublicClient,
  type TypedDataDomain,
} from 'viem'
import { SETTLEMENT_ABI } from '../abi.js'
import { getChainId, settlement, settlementLive, type ChainId } from '../config.js'
import { PERMIT_TYPES } from '../custody.js'
import {
  authNonceOf,
  authUsableWindow,
  intentHashOf,
  intentKey,
  isEscrow,
  isPermit2,
  splitPermit,
  ZERO_HASH,
  type Intent,
  type Permit2612,
  type SignedIntent,
  type TimeWindow,
} from '../intent.js'
import { batchRead, type Call } from '../multicall.js'
import type { FillReasonName } from './abi.js'

/**
 * Which legs the solver can reach, and the bytes that reach them.
 *
 * `FillRequest.arming` is empty, or one of four shapes: a Permit2 SignatureTransfer when the
 * intent carries the permit2 flag, an EIP-3009 authorization or the one word `ARM_FROM_PARKED`
 * when it carries the escrow flag, an EIP-2612 permit when it carries neither. The solver
 * supplies it, so the solver decides which legs are worth an arming call — and that is why this
 * file exists on the solver side rather than the maker's.
 *
 * The consequence runs through the whole engine. `_evaluate` answers `EscrowShort` for an
 * escrow that holds too little AND for an allowance the maker never granted, and on a leg the
 * solver can arm both of those mean "needs arming", not "dead". A solver that reads that reason
 * as a rejection skips every gasless maker on the board, which is the population this work
 * exists to reach.
 *
 * **The fourth shape carries no signature, and that is the whole of it.** Parked capital is the
 * maker's own money already inside the settlement, freed out of a dead offer by `park`. The
 * intent's own preimage says whose money and which token, so the bytes have no parameter to
 * carry and no party to name — they only ask. What that costs the maker is stated at
 * `FLAG_ESCROW` in `ProveSettlement` and at 6.11 of `AUDIT-SCOPE`, and the app has to say it.
 */

/**
 * How a leg's arming bytes are built, or `none` when nothing the solver holds reaches this leg.
 *
 * `parked` is the odd one: it is not a signature the intent carries, it is a row on the chain,
 * so it is the one kind that cannot be read off the intent alone.
 */
export type ArmingKind = 'authorization' | 'parked' | 'permit' | 'permit2' | 'none'

/**
 * Which of the four shapes reaches this intent's funds, and whether anything supplies it.
 *
 * The custody flags decide the rung, exactly as `_armLeg` does: Permit2 for a permit2 intent, a
 * redemption or the parked source for an escrow one, a permit for a wallet one. An intent
 * carrying the wrong kind is carrying nothing — a permit cannot fund an escrow, an authorization
 * cannot grant an allowance, and neither is a Permit2 signature.
 *
 * Permit2 is asked first because the settlement asks it first. The two flags are exclusive on
 * chain — `_termsOk` refuses an intent wearing both — so the order decides nothing, and reading
 * it in the same order as the contract is how it stays that way.
 *
 * **The authorization wins over the parked source when the intent carries both**, and the
 * reason is that it is additive rather than better: an intent that carried a 3009 signature has
 * always answered `authorization` here, so a maker's parked capital never quietly redirects a
 * leg that was already funded another way. Parked fills the hole where the answer used to be
 * `none` and nowhere else.
 *
 * @param parked what `readParked` found in this maker's row for `tokenIn`. Omit it and the
 *        parked source is invisible, which is the answer this function gave before #120: a
 *        caller that never reads the row never sends the word.
 */
export function armingKind(i: SignedIntent, parked?: bigint): ArmingKind {
  if (isPermit2(i)) return i.permit2 ? 'permit2' : 'none'
  if (isEscrow(i)) {
    if (i.auth) return 'authorization'
    return drawsFromParked(i, parked) ? 'parked' : 'none'
  }
  return i.permit ? 'permit' : 'none'
}

/**
 * Whether the parked source can fund this leg at all: escrow, unwelded, and a row with something
 * in it.
 *
 * **The weld check is `_drawFromParked`'s first line and it is not optional.** A maker who sets
 * `Intent.authNonce` is posting one lot at two prices, and the token's single-use 3009 nonce is
 * what makes the siblings mutually exclusive. The parked source spends no nonce, so it would
 * fund both — `invariant_TwoOffersSharingAnAuthorizationNeverBothFill` found that inside one
 * campaign, and the contract answers `BadTerms`. A solver that sends the word anyway reverts its
 * own single fill and loses the leg out of a batch, so the refusal belongs here too.
 *
 * **A row with anything in it counts, not a row that covers the leg.** The chain draws
 * `take - reserved[h]` and refuses in full or not at all, and the shortfall is a number the book
 * cannot compute — `EscrowShort` says the reservation is under the take and says nothing about
 * by how much. An over-optimistic arming is a no-op inside a revertable frame, which is what
 * `EscrowShort` on an armable leg has always meant: not now, rather than not ever. Being wrong
 * the other way drops the offers this source exists to fund.
 */
const drawsFromParked = (i: SignedIntent, parked?: bigint): boolean =>
  isEscrow(i) && i.authNonce === ZERO_HASH && (parked ?? 0n) > 0n

/** Whether a leg is fillable now, fillable once the solver arms it, or out of reach. */
export type Reach = 'fillable' | 'armable' | 'unreachable'

/**
 * What one `fillability` answer means to a solver that can arm.
 *
 * This is the whole of task #71 in one function, and every read of a fill reason in this package
 * goes through it. `EscrowShort` is the only reason arming changes: it is what an unfunded
 * reservation looks like and what a missing allowance looks like, and both are what an arming
 * call is for. Every other refusal is about the intent itself — expired, cancelled, below the
 * nonce floor, signed wrong — and no signature the solver holds can rescue one.
 *
 * `Ok` needs no arming. Sending bytes anyway would still work, because `_fillOne` arms an `Ok`
 * leg too, but `_grantAllowance` would then spend one of the maker's EIP-2612 nonces to grant an
 * allowance they already granted — and that nonce is the ordering every other permit signature
 * of theirs depends on. So a leg the chain already calls fillable is sent with no arming at all.
 *
 * **A permit2 leg used to be neither `Ok` before arming nor armable after, and half of that is no
 * longer true.** Its reservation used to be empty until this solver's own arming filled it. Since
 * the first fill promotes the signature into a reservation covering the whole intent, a leg
 * another solver already armed comes back `Ok` — and `Ok` is right: the money is in escrow, ours
 * to draw, and no signature is needed to reach it. That is the case worth getting right, because
 * it is the ordinary end of a race. Several solvers hold the same permit, one lands, and the
 * others must still be able to fill from what the winner promoted rather than failing beside it.
 *
 * `spent` is the other half, and it is the only thing a fill reason cannot tell you. Permit2
 * marks a nonce used on the first transfer, so a leg reading `EscrowShort` with a spent nonce is
 * not armable by anyone: the reservation is short AND the door is shut. Without this the solver
 * plans the fill, sends arming bytes that cannot redeem, and pays for the attempt.
 *
 * **A spent nonce is not on its own a dead leg**, and reading it that way would be worse than not
 * reading it at all — it would drop every leg a rival had already funded, which is exactly the
 * set a solver most wants. Both conditions, or neither.
 *
 * **`parked` is the mirror image of `spent`, and it moves the answer the other way.** A spent
 * nonce turns an armable leg unreachable; a maker's parked row turns an unreachable escrow leg
 * armable, because the money is already in the settlement and the intent's own preimage says it
 * is theirs. An escrow signature its maker never funded used to be inert for ever, and this is
 * the line where that stopped being true.
 *
 * @param spent whether Permit2 has already marked this leg's nonce used. Omit it and the answer
 *        is the old one, which errs toward trying: a wasted arming costs gas, a wrongly dropped
 *        leg costs the fill.
 * @param parked what this maker has resting in the settlement in `tokenIn`, from `readParked`.
 *        Omit it and the parked source is invisible, which is also the old answer.
 */
export function reachabilityOf(
  reason: FillReasonName,
  i: SignedIntent,
  spent?: boolean,
  parked?: bigint,
): Reach {
  if (reason === 'Ok') return 'fillable'
  if (reason !== 'EscrowShort') return 'unreachable'
  const kind = armingKind(i, parked)
  if (kind === 'none') return 'unreachable'
  // Short reservation and a spent signature. Nothing left to reach with.
  if (spent === true && kind === 'permit2') return 'unreachable'
  return 'armable'
}

/**
 * Where a Permit2 nonce lives in its owner's bitmap.
 *
 * Permit2's `SignatureTransfer` nonces are unordered: the low byte picks a bit and everything
 * above it picks the word. `nonceBitmap(owner, wordPos)` is a public read, which is what makes
 * spentness knowable off chain at all.
 */
export const permit2NonceSlot = (nonce: bigint) => ({
  wordPos: nonce >> 8n,
  bitPos: nonce & 0xffn,
})

/** True when `word` — the value at `nonceBitmap(owner, wordPos)` — has this nonce's bit set. */
export const permit2NonceSpent = (word: bigint, nonce: bigint): boolean =>
  ((word >> (nonce & 0xffn)) & 1n) === 1n

/** The `nonceBitmap` read, for a caller that wants to ask without an ABI of its own. */
export const PERMIT2_NONCE_BITMAP_ABI = [
  {
    type: 'function',
    name: 'nonceBitmap',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

/** True when the chain refuses this leg today and the solver can still reach the maker's funds. */
export const isArmable = (
  reason: FillReasonName,
  i: SignedIntent,
  spent?: boolean,
  parked?: bigint,
): boolean => reachabilityOf(reason, i, spent, parked) === 'armable'

/** Where a bitmap read is asked, and who asks it. */
export type SpentNonceOptions = {
  /**
   * The Permit2 this deployment uses. `permit2Target` in `settlement.ts` reads it off the
   * relayer, which holds it as an immutable.
   *
   * It is an argument and not a constant here. Permit2 sits at one canonical address on every
   * chain that has it, and a settlement wired to a different one would send this read to a
   * contract holding somebody else's bitmap — which answers, and answers wrong. A wrong `false`
   * costs a wasted arming; a wrong `true` drops a live leg for good.
   */
  permit2: Address
  client?: PublicClient<HttpTransport, Chain>
  chainId?: ChainId
}

/**
 * Which of these legs Permit2 has already seen a transfer for, by `intentKey`.
 *
 * This is the read `reachabilityOf`'s `spent` argument wants, and nothing else can answer it: a
 * fill reason folds a spent nonce and an unfunded reservation into the same `EscrowShort`, so the
 * solver cannot tell a leg it can still arm from one whose door another solver already shut.
 *
 * **One read per `(owner, wordPos)` pair, not one per leg.** Permit2's unordered nonces put 256
 * of them in one word, so a maker with a dozen live permit2 offers usually answers all of them
 * from a single slot — and a maker who names their own `authNonce` sequentially always does. The
 * naive version issues a read per intent and asks the same question a dozen times, which on a
 * board poll is the difference between one round trip and a rate limit.
 *
 * Only permit2 legs are asked about. A 2612 permit spends an ordered nonce on the token and a
 * 3009 authorization has no bitmap here at all, so a read against this contract would answer
 * about a slot neither rung uses.
 *
 * A leg whose word did not come back is left out of the map rather than guessed at. `undefined`
 * reaches `reachabilityOf` as "nobody read it", which errs toward trying — the right way to be
 * wrong, because a rate limit must never look like a dead offer.
 */
export async function permit2SpentNonces(
  intents: readonly SignedIntent[],
  o: SpentNonceOptions,
): Promise<ReadonlyMap<string, boolean>> {
  const chainId = o.chainId ?? getChainId()
  const words = new Map<string, { owner: Address; wordPos: bigint }>()
  const legs: { key: string; nonce: bigint; word: string }[] = []

  for (const i of intents) {
    if (armingKind(i) !== 'permit2') continue
    // The nonce is derived, never carried: `encodeArming` presents `authNonceOf` and
    // `_pullPermit2In` refuses anything else, so this is the bit the fill will actually spend.
    const nonce = BigInt(authNonceOf(i, chainId))
    const { wordPos } = permit2NonceSlot(nonce)
    const word = `${i.maker.toLowerCase()}:${wordPos}`
    if (!words.has(word)) words.set(word, { owner: i.maker, wordPos })
    legs.push({ key: intentKey(i), nonce, word })
  }
  if (legs.length === 0) return new Map()

  const order = [...words.values()]
  const results = await batchRead(
    order.map(
      (w): Call => ({
        address: o.permit2,
        abi: PERMIT2_NONCE_BITMAP_ABI as never,
        functionName: 'nonceBitmap',
        args: [w.owner, w.wordPos],
      }),
    ),
    o.client,
  )

  const read = new Map<string, bigint>()
  for (let k = 0; k < order.length; k++) {
    const r = results[k]
    if (r.ok) read.set(`${order[k].owner.toLowerCase()}:${order[k].wordPos}`, r.value as bigint)
  }

  const out = new Map<string, boolean>()
  for (const l of legs) {
    const word = read.get(l.word)
    if (word !== undefined) out.set(l.key, permit2NonceSpent(word, l.nonce))
  }
  return out
}

/** Where a parked row is read, and on which deployment. */
export type ParkedOptions = {
  /** Override the settlement address, for a fork. Defaults to the registry's resolver. */
  settlementAddress?: Address
  client?: PublicClient<HttpTransport, Chain>
  chainId?: ChainId
}

/**
 * What each of these makers has resting in the settlement, by `intentKey`.
 *
 * This is the read `reachabilityOf`'s `parked` argument wants, and like the bitmap read it
 * answers something a fill reason cannot: `_evaluate` asks `_reserved[h]` and only that map, so
 * an offer with a hundred parked behind it and nothing reserved answers `EscrowShort` exactly as
 * one with nothing anywhere does. The chain is not being coy — parked capital genuinely backs no
 * offer until an arming call moves it, inside the transaction that spends it.
 *
 * **One read per `(maker, token)` pair, not one per leg**, for `permit2SpentNonces`' reason one
 * rung up. `_parked` is keyed by maker and token, so every escrow offer a maker has open in one
 * asset answers from a single slot, and a maker who parked one dead offer and signed six new
 * ones is the case this exists for. Asking per leg turns a board poll into a rate limit.
 *
 * Only a leg the parked source could actually fund is asked about, which `drawsFromParked`
 * decides without the amount: the escrow rung, no authorization already attached, and no
 * `authNonce` welding it to a sibling. A permit2 leg reaches `_pullPermit2In` and gains nothing
 * here, a wallet leg is reached by an allowance, and a welded intent is `BadTerms` on chain
 * however full the row is. On a board with none of these the function issues no call at all.
 *
 * A row that did not come back is left out rather than guessed at, as everywhere else in this
 * file. `undefined` reaches `armingKind` as "nobody read it", which reads the leg the way it
 * read before #120 — unreachable, and left for another poll. That is the safe direction here and
 * not the usual one: a guessed row sends the word into a fill that cannot draw, and the leg is
 * `EscrowShort` again at the far end having spent the batch's gas.
 */
export async function readParked(
  intents: readonly SignedIntent[],
  o: ParkedOptions = {},
): Promise<ReadonlyMap<string, bigint>> {
  const chainId = o.chainId ?? getChainId()
  // No contract, no rows. `settlement()` answers the zero address on a chain that has none, and
  // a read sent there comes back `unreadable` — the same empty answer for a round trip.
  if (!o.settlementAddress && !settlementLive(chainId)) return new Map()
  const address = o.settlementAddress ?? settlement(chainId)
  const rows = new Map<string, { maker: Address; token: Address }>()
  const legs: { key: string; row: string }[] = []

  for (const i of intents) {
    // The set is "whom would the answer change", asked of the one function that decides it. One
    // notional wei stands in for the row nobody has read yet: any leg that would not answer
    // `parked` on a full row will not answer it on the real one either, and a second copy of
    // that rule here is a second copy to get wrong.
    if (armingKind(i, 1n) !== 'parked') continue
    const row = `${i.maker.toLowerCase()}:${i.tokenIn.toLowerCase()}`
    if (!rows.has(row)) rows.set(row, { maker: i.maker, token: i.tokenIn })
    legs.push({ key: intentKey(i), row })
  }
  if (legs.length === 0) return new Map()

  const order = [...rows.entries()]
  const results = await batchRead(
    order.map(
      ([, r]): Call => ({
        address,
        abi: SETTLEMENT_ABI as never,
        functionName: 'parked',
        args: [r.maker, r.token],
      }),
    ),
    o.client,
  )

  const read = new Map<string, bigint>()
  for (let k = 0; k < order.length; k++) {
    const r = results[k]
    if (r.ok) read.set(order[k][0], r.value as bigint)
  }

  const out = new Map<string, bigint>()
  for (const l of legs) {
    const row = read.get(l.row)
    if (row !== undefined) out.set(l.key, row)
  }
  return out
}

// ── The bytes ─────────────────────────────────────────────────────────────────

/**
 * The two structs `armLeg` decodes out of `arming`, taken from the compiler's own ABI.
 *
 * Typed out by hand they would be a second thing to get wrong, and a wrong one still compiles:
 * `abi.decode` reads whatever it is given, so a field in the wrong order arms the wrong amount
 * rather than failing. `abi.ts` makes the same argument about `Route` and for the same reason.
 */
const tupleOf = (fn: string, arg: string) => {
  const entry = SETTLEMENT_ABI.find((e) => e.type === 'function' && e.name === fn)
  const found = entry && 'inputs' in entry ? entry.inputs.find((i) => i.name === arg) : undefined
  if (!found) throw new Error(`ProveSettlement.${fn} has no \`${arg}\` argument.`)
  return found
}

const AUTHORIZATION_TUPLE = tupleOf('fillWithAuthorization', 'auth')
const PERMIT_TUPLE = tupleOf('fillWithPermit', 'p')
const PERMIT2_TUPLE = tupleOf('fillWithPermit2', 'p')

/**
 * The one word that asks for the maker's parked capital, derived rather than copied.
 *
 * `ProveSettlement` says why a client must not carry its own hash: every solver has to write
 * this into calldata, and a copy is a copy that can go stale. So the preimage is what lives
 * here, and `keccak256` does the rest — the only way this can drift is if the string itself
 * changes, and then the constant below stops existing under this name.
 *
 * Which is the other half. The generated ABI is checked for the constant at import, so a rename
 * or a removal on chain is an error a developer reads once rather than a `BadTerms` a solver
 * reads on every fill. It costs one array scan at module load and buys the staleness this file's
 * own header warns about.
 */
if (!SETTLEMENT_ABI.some((e) => e.type === 'function' && e.name === 'ARM_FROM_PARKED')) {
  throw new Error('ProveSettlement no longer declares `ARM_FROM_PARKED`.')
}

/** The bytes32 the settlement compares against. `ARM_FROM_PARKED` on chain. */
export const ARM_FROM_PARKED: Hex = keccak256(stringToHex('prove.settlement.armFromParked'))

/**
 * The whole of the parked source's arming bytes: that word, ABI-encoded, and nothing else.
 *
 * Exactly 32 bytes, which is how `_redeemInto` tells it from an authorization before it decodes
 * anything — an `Authorization` holds a signature, so `abi.encode` of one is at least 192 bytes
 * and can never be this length.
 */
export const PARKED_ARMING: Hex = encodeAbiParameters([{ type: 'bytes32' }], [ARM_FROM_PARKED])

/**
 * The arming bytes for one leg, or null when the intent carries no signature for its rung.
 *
 * The 3009 nonce is the intent's own `authNonce`, falling back to the intent hash when that is
 * zero — the same rule `_redeemInto` runs. The hash is the default because one authorization
 * funding one intent means cancelling that intent revokes it. A maker who names a nonce instead
 * is choosing the other dynamic: two intents sharing one are mutually exclusive, and exactly one
 * of them can ever be armed.
 *
 * When the hash is the nonce, the chain id has to be right — it is an EIP-712 digest over the
 * settlement's domain, and a hash built for the wrong chain arms nothing.
 */
/** The nonce an authorization must carry for this intent: the maker's, or the intent hash. */
function authNonceOrHash(i: SignedIntent, chainId: ChainId): Hex {
  const named = i.authNonce
  return named && /[1-9a-f]/i.test(named.slice(2)) ? named : intentHashOf(i, chainId)
}

export function encodeArming(
  i: SignedIntent,
  chainId: ChainId = getChainId(),
  parked?: bigint,
): Hex | null {
  const kind = armingKind(i, parked)
  // No signature to build and no argument to get wrong. `armingKind` already refused a welded
  // intent and an empty row, so reaching here means the chain will take the word.
  if (kind === 'parked') return PARKED_ARMING
  if (kind === 'authorization') {
    const auth = i.auth!
    return encodeAbiParameters(
      [AUTHORIZATION_TUPLE],
      [
        {
          validAfter: auth.validAfter,
          validBefore: auth.validBefore,
          nonce: authNonceOrHash(i, chainId),
          // Whole, not split. The contract takes an unstructured signature and picks the token's
          // overload by its length, so splitting it here would throw away the one fact that
          // decides which call it makes — and a contract wallet's answer is not 65 bytes.
          signature: auth.signature,
        },
      ],
    )
  }
  if (kind === 'permit') return encodeAbiParameters([PERMIT_TUPLE], [splitPermit(i.permit!)])
  if (kind === 'permit2') {
    const p = i.permit2!
    return encodeAbiParameters(
      [PERMIT2_TUPLE],
      [
        {
          token: p.token,
          amount: p.amount,
          // The nonce is derived, never carried: it is the intent's `authNonce`, or the intent
          // hash when that is zero, and `_pullPermit2In` refuses anything else. The same rule the
          // 3009 arm runs one branch up, which is why one helper answers both.
          nonce: BigInt(authNonceOrHash(i, chainId)),
          deadline: p.deadline,
          signature: p.signature,
        },
      ],
    )
  }
  return null
}

// ── What a leg draws, and what it spends ──────────────────────────────────────

/**
 * What settling this leg takes out of the maker's wallet balance of `tokenIn`.
 *
 * Three different answers, and the difference is the whole reason group fillability is not the
 * conjunction of individual fillability:
 *
 *   wallet, armed or not   `take`, pulled by the relayer at the moment of the fill
 *   escrow, already funded  nothing — `_reserved[h]` is per intent hash, so it is this leg's own
 *                           money and no other leg of the maker's can spend it
 *   escrow, being armed     the whole `amountIn`, because `_redeem` pulls `amountIn` and not the
 *                           take, whatever the leg is filling
 *   escrow, armed from      nothing. The money is already inside the settlement — `park` put it
 *   parked capital          there and no token is called at all
 *   permit2, being armed    the whole `amountIn` as well, and for the same reason one rung up
 *
 * **The parked line is the one that had to be added rather than inherited, and getting it wrong
 * costs exactly the fills this source exists to enable.** Without it a parked leg reads as an
 * escrow leg being armed, so it claims `amountIn` of a wallet balance it never touches — and the
 * maker most likely to be armed from parked capital is the one who moved their stock into the
 * settlement and holds nothing in the wallet at all. `feasible` would then refuse every such leg
 * on a budget of zero.
 *
 * This last line used to say `take`, and called it the one thing permit2 did better than
 * EIP-3009: Permit2 allows a request under the permitted amount, so the rung drew what it filled
 * and stranded nothing. The saving was never real. A non-partial intent takes what is left on its
 * only fill, which IS `amountIn`, so the two were the same number. They differed for a partial
 * intent alone — and there the small draw shut the door on the rest of a live offer, because a
 * Permit2 nonce is spent on the first transfer however little it asks for. `_pullPermit2` draws
 * the whole intent now, so the first fill leaves a reservation the later ones settle from.
 *
 * The middle cases are the ones worth stating out loud. A maker with two funded escrow intents on
 * one token cannot starve either of them, because the deposits are already made and already
 * apportioned. Only the legs that still have to reach into the wallet compete — and a permit2 leg
 * is now one of those exactly once, on the fill that arms it.
 */
export function walletDraw(
  i: Intent,
  take: bigint,
  armed: boolean,
  fromParked = false,
): bigint {
  if (isPermit2(i)) return armed ? i.amountIn : 0n
  if (!isEscrow(i)) return take
  if (fromParked) return 0n
  return armed ? i.amountIn : 0n
}

/**
 * True when settling this leg spends one of the maker's EIP-2612 nonces.
 *
 * Only an armed wallet leg does. `_grantAllowance` calls `permit` only when the standing
 * allowance is short, so a leg the chain already calls fillable spends nothing — which is why
 * `reachabilityOf` refuses to arm an `Ok` leg.
 *
 * A permit2 leg spends a Permit2 nonce instead, and that one is unordered: Permit2 keeps a
 * bitmap, so spending it takes nothing else of the maker's with it. That is the whole reason
 * this function names EIP-2612 rather than "a nonce".
 */
export const spendsPermitNonce = (i: SignedIntent, armed: boolean): boolean =>
  armed && armingKind(i) === 'permit'

/**
 * The token nonce a permit signature commits to, found by trying the ones it could be.
 *
 * An EIP-2612 digest commits to `nonces[owner]` at signing time, and the wire format the board
 * carries holds the value, the deadline and the signature — not the nonce. So the solver cannot
 * read the ordering off a permit; it has to recover it. Try each candidate from the token's
 * current nonce upward, rebuild the digest, and see which one recovers to the maker.
 *
 * `window` bounds the search. A maker with more than a handful of unspent permits on one token
 * is not a case worth paying for, and the ones past the window simply stay unordered — which
 * `groups.ts` handles by admitting at most one of them.
 *
 * Null means no candidate in the window matched: a permit for another spender, another value, a
 * stale nonce already spent, or a signature that was never the maker's.
 */
export async function recoverPermitNonce(
  permit: Permit2612,
  o: {
    owner: Address
    spender: Address
    /** The token's own EIP-712 domain. `tokenDomain` in `custody.ts` reads it. */
    domain: TypedDataDomain
    /** The token's current `nonces(owner)`. */
    from: bigint
    window?: number
  },
): Promise<bigint | null> {
  const window = o.window ?? 8
  for (let k = 0; k < window; k++) {
    const nonce = o.from + BigInt(k)
    const digest = hashTypedData({
      domain: o.domain,
      types: PERMIT_TYPES,
      primaryType: 'Permit',
      message: {
        owner: o.owner,
        spender: o.spender,
        value: permit.value,
        nonce,
        deadline: permit.deadline,
      },
    })
    const signer = await recoverAddress({ hash: digest, signature: permit.signature }).catch(
      () => null,
    )
    if (signer && signer.toLowerCase() === o.owner.toLowerCase()) return nonce
  }
  return null
}

/**
 * The window a leg can actually be armed in, in seconds. Empty when `from > until`.
 *
 * An alias, not a second declaration. `liveWindow` computes the same interval for a client that
 * is about to sign one, and two identical shapes with two names drift the moment one of them
 * grows a field.
 */
export type ArmingWindow = TimeWindow

/**
 * When a leg can be armed, taking the funding signature's own window into account.
 *
 * An intent has a window. So does the signature that funds it, and they are not the same window —
 * nothing on chain reconciles them, so a leg's real life is the intersection. `ProveSettlement`
 * says as much where `Authorization` is declared: the reason the arming bytes travel with the
 * intent at all is so a solver can read the window instead of guessing.
 *
 * Guessing is expensive here. Every arming failure reaches the solver as `EscrowShort`, which is
 * also what a spent nonce, a taxed token and an empty wallet look like. A leg whose 3009 window
 * opens in forty seconds is indistinguishable from a leg that will never fill, so a solver that
 * cannot tell them apart either wastes a simulation on it now or drops an offer that was about to
 * become fillable — and in a ring it takes every other leg down with it.
 *
 * The three rungs bound it differently, and the off-by-ones are the specifications', not ours:
 *
 *   - EIP-3009 is exclusive at both ends. The token requires `validAfter < now < validBefore`,
 *     so the first usable second is `validAfter + 1` and the last is `validBefore - 1`.
 *   - EIP-2612 is inclusive: `now <= deadline`.
 *   - Permit2 is inclusive too: it reverts `SignatureExpired` when `now > deadline`.
 *
 * A leg with no arming bytes is reached by an allowance or by escrow, neither of which expires,
 * so its window is the intent's own. **So is a leg armed from parked capital**, and that is not
 * an omission: the parked source is not a signature, it is a row, so there is no second window
 * to intersect. The maker's own `startTime` and `endTime` are the only clock it answers to.
 *
 * **The intent's own window is half-open.** `_fillability` answers `Expired` when
 * `block.timestamp >= endTime`, so the last second a leg can fill is `endTime - 1`. `until` is
 * inclusive, so it starts there. It started at `endTime` once, and `findRings` then built rings
 * around a leg at the one second the chain refuses it.
 */
export function armingWindow(i: SignedIntent, parked?: bigint): ArmingWindow {
  let from = i.startTime
  let until = i.endTime - 1n
  const narrow = (f: bigint, u: bigint) => {
    if (f > from) from = f
    if (u < until) until = u
  }
  switch (armingKind(i, parked)) {
    case 'authorization': {
      // `authUsableWindow` owns the exclusive off-by-one, so the sign form and the solver read
      // the same rule. Two copies of it would drift by a second and nobody would see which.
      const w = authUsableWindow(i.auth!)
      narrow(w.from, w.until)
      break
    }
    case 'permit':
      narrow(from, i.permit!.deadline)
      break
    case 'permit2':
      narrow(from, i.permit2!.deadline)
      break
    case 'parked':
      // Written out rather than left to the default, because "nothing narrows it" is a claim
      // about this source and not the absence of one. The parked row is not a signature and
      // carries no clock of its own, so the intent's own window is the whole answer.
      break
    default:
      break
  }
  return { from, until }
}

/** True when this leg's funding signature is usable at `at`. */
export const armableAt = (i: SignedIntent, at: bigint, parked?: bigint): boolean => {
  const w = armingWindow(i, parked)
  return at >= w.from && at <= w.until
}

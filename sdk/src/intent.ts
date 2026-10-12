import {
  concat,
  encodeAbiParameters,
  getAddress,
  hashDomain,
  hexToBytes,
  bytesToHex,
  keccak256,
  parseSignature,
  recoverAddress,
  toHex,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem'
import { getChainId, settlement, settlementLive, type ChainId } from './config.js'
import { feeConfigFault, hashFeeConfig, MAX_DESTINATIONS, WAD, type FeeConfig } from './feeconfig.js'

/** The maker allows a fill smaller than `amountIn`. Without it, a fill is all or nothing. */
export const FLAG_PARTIAL = 1
/** Token A comes from the contract's per-intent escrow, not from the maker's wallet. */
export const FLAG_ESCROW = 2
/**
 * Token A is reached by a Permit2 SignatureTransfer.
 *
 * A free bit of a field that was already signed, which is why this rung cost no type-hash change
 * and no codec version: `flags` has always been inside `INTENT_TYPEHASH`, so a maker who sets
 * this bit signs the same fields as everybody else.
 *
 * It is exclusive with `FLAG_ESCROW` — `_termsOk` refuses an intent wearing both — because the
 * two name different signatures, and an intent should not leave a solver guessing which of a
 * maker's it will spend.
 */
export const FLAG_PERMIT2 = 4

/**
 * The two bits of `flags` that say how to read `curve`: bits 8 and 16, and nothing else.
 *
 * A kind is a branch in `minOutAt`, not a field. `flags` has always been inside
 * `INTENT_TYPEHASH`, so a maker who names a kind signs the same struct as everybody else, and
 * the two bits cost no wire byte and no gas. `curve` is the expensive half, and it is one word
 * for every kind there will ever be.
 *
 * **A kind reads only the bytes it names.** Kind 0 reads none and kind 1 reads four. An intent
 * whose kind ignores a byte prices identically whatever that byte holds, and pays the board for
 * it — the maker's own waste, exactly as a `feeRate` with no `feeConfig` is today.
 */
export const FLAG_CURVE_KIND = 24
/** One straight line from `minOutStart` to `minOutEnd`. Nothing reads `curve` at all. */
export const KIND_LINEAR = 0
/**
 * The price falls across one stretch of the window and rests flat either side of it.
 * `stretchCurve` packs the two numbers it reads.
 */
export const KIND_STRETCH = 8
/**
 * Reserved: eight knots and nine linear segments. Nothing implements it.
 *
 * The bits are documented so a later settlement can add the branch without touching the wire
 * format or the typehash. Until one does, this SDK and the contract both price it as the line —
 * see `minOutAt`.
 */
export const KIND_KNOTS = 16
/** Reserved: a cubic Bernstein blend. Nothing implements it, exactly as `KIND_KNOTS`. */
export const KIND_CUBIC = 24

/**
 * The unit a curve fraction counts in. A whole window is 65,535 of them.
 *
 * It is `uint16` full scale rather than a power of ten because the stretch packs two of them
 * into four bytes, and because the contract divides by it: `floor(a·k / b·k) = floor(a / b)`, so
 * a full-scale length reduces to the shipped straight line exactly.
 */
export const CURVE_ONE = 65535

/**
 * The curve that is today's line: thirty-two zero bytes.
 *
 * The same word as `ZERO_HASH`, under the name that says what it means in this field. **Under
 * kind 0 and kind 1 this word is the shipped straight line**, character for character, so a
 * maker who names the stretch and leaves the word alone signs the offer they would have signed
 * yesterday. A later kind is free to define its own zero word; the cubic's would be a curve.
 */
export const CURVE_LINEAR: Hex = `0x${'00'.repeat(32)}`

/** The terms a maker signs. Every field is part of the EIP-712 digest. */
export type Intent = {
  maker: Address
  recipient: Address
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  minOutStart: bigint
  minOutEnd: bigint
  startTime: bigint
  endTime: bigint
  executor: Address
  /**
   * The hash of the fee config this intent's fees are booked under: `hashFeeConfig` of a
   * destinations-and-weights list. `ZERO_HASH` charges no fee at all, and then every rate below
   * must be zero (`_termsOk` refuses the pair otherwise).
   *
   * A signed term, and the whole of the answer: the settlement holds no destination of its own and
   * keeps no registry. A destination is paid because a maker named it. `claim(config, token)`
   * pays a booked cell out to the destinations the config lists, and anyone may call it.
   *
   * **A wallet cannot sign `ZERO_HASH`.** The EIP-712 type nests a `FeeConfig` struct, and no
   * struct hashes to zero, so `eth_signTypedData_v4` needs a real config. A fee-free offer from a
   * wallet names a config and signs rate zero at every point; only a raw-digest signer (`signIntent`
   * with a local key) can sign the zero hash.
   */
  feeConfig: Hex
  /**
   * P2, the output fee: a fraction of one ether of what the maker is owed, charged in `tokenOut`
   * ON TOP of it. The solver brings `owed + fee`; the maker still receives the whole curve.
   * `maxFeeRate` bounds P1 + P2, the two rates the solver bears.
   *
   * The intent names it and the fill charges it. Nothing raises it and nothing lowers it. Zero
   * charges nothing, and so does a zero `feeConfig` (which refuses a rate rather than ignore it).
   * **There is one ceiling, and it is arithmetic rather than policy.** `_termsOk` refuses a rate
   * above `MAX_FEE_RATE` at any of the three points. `suggestFeeRate` in `fee.ts` picks one.
   */
  feeRate: bigint
  /**
   * P1, the handover fee: a fraction of one ether of `take`, charged in `tokenIn` out of what the
   * solver receives. The solver bears it (it reaches the callback as `Terms.feeIn`). Zero by
   * default.
   */
  feeRateIn: bigint
  /**
   * P3, the proceeds fee: a fraction of one ether of what the maker is owed, taken OUT of it in
   * `tokenOut`. The maker bears it, so a maker who wants to receive `net` signs
   * `grossForNet(net, feeRateProceeds)`. Zero by default.
   */
  feeRateProceeds: bigint
  /**
   * The smallest partial fill this intent accepts. Zero means no floor at all.
   *
   * A partial fill has to satisfy `take >= minFill || take == remaining`. The second clause is
   * not a courtesy: without it a floor of 30 on an amount of 100 leaves a final 10 that no fill
   * can ever close, and every floored intent ends in dust.
   *
   * **What it buys.** A gasless intent's escrow is funded by redeeming the maker's whole
   * `amountIn`, whatever the take, so a solver could take one wei and move the maker's entire
   * balance into escrow until they withdraw it or the intent expires. A floor raises the price of
   * that from one wei to a real commitment.
   *
   * **What it does not buy.** It does not stop the balance moving. An EIP-3009 authorization is a
   * fixed value under a single-use nonce and cannot be redeemed in pieces, so the first fill of
   * any legal size still moves the lot. That is the token standard's constraint.
   */
  minFill: bigint
  /**
   * The EIP-3009 nonce this intent's authorization must carry. `ZERO_HASH` means the intent's own
   * hash, which is what every intent used to be given.
   *
   * A 3009 nonce is a value the signer picks and the token spends once, so two intents naming the
   * same one are **mutually exclusive**: whichever is armed first spends the nonce and the other
   * can never be funded. That lets a maker post the same inventory at two prices and know only
   * one can arm. `authNonceOf` resolves the field to the nonce a fill will present.
   *
   * Three things about it that are not obvious. Exclusion only holds between siblings of the same
   * `amountIn`, because the maker's 3009 signature commits to the value and the token refuses a
   * mismatch. It is one-shot: arming either sibling spends the nonce for good, even if that
   * intent never fills, and the maker has to sign again to try a second time. And a maker cannot
   * name their own hash, because naming it would change it — `ZERO_HASH` is how they ask for it.
   */
  authNonce: Hex
  flags: number
  nonce: bigint
  /**
   * The shape of this intent's decay: one signed word, read the way `flags` says to read it.
   *
   * **`CURVE_LINEAR` is today's offer and it is not a default.** The field is required, exactly
   * as `minFill` is, because it changes the digest — a caller who forgets it signs terms they
   * did not mean, and only the compiler is in a position to say so.
   *
   * The kind bits pick the reader. `KIND_LINEAR` reads none of it. `KIND_STRETCH` reads the
   * first four bytes as two `uint16` — where the fall begins and how long it takes, each a
   * fraction of the window in units of 1/65,535 — and rests flat either side. `stretchCurve`
   * packs them, `minOutAt` reads them, and `breakpointsOf` names the two instants they turn at.
   *
   * **Twenty-eight bytes are reserved and they are not waste.** A `bytes32` and a `uint16` cost
   * the same 128 gas of calldata on every fill, because every static member of the struct gets
   * its own word; and the board codec writes only the bytes a curve actually uses, so a stretch
   * pays for four. The wide field is free at the margin and it buys kinds 2 and 3 a home.
   */
  curve: Hex
}

/**
 * An EIP-3009 `receiveWithAuthorization` signature that funds the intent's escrow at fill
 * time. Its 3009 nonce is the intent hash — the contract enforces that — so it is derivable
 * from the intent and never travels on the wire.
 *
 * `signature` is any length, which is ERC-7598. A key produces 65 bytes and a contract wallet
 * produces whatever its ERC-1271 check accepts; the settlement picks the token's overload by the
 * length and falls back rather than assuming. Under EIP-3009 alone this was a fixed `v, r, s`
 * triple, so a smart account could sign the intent and not the authorization that funds it.
 *
 * **`validAfter` and `validBefore` are a second window, and nothing reconciles it with the
 * intent's.** The token enforces this one; the settlement enforces `startTime` and `endTime`. A
 * gasless intent is only alive where the two overlap, and `validBefore` is the de facto expiry of
 * the rung that funds it. Nothing bounds the intent's own window, so an offer may rest for as
 * long as it likes and stop working long before it expires. Nothing on chain will say so. Sign
 * the two to agree, or know that they do not.
 */
export type Auth3009 = { validAfter: bigint; validBefore: bigint; signature: Hex }

/**
 * An EIP-2612 permit that grants the relayer's allowance at fill time, so the maker sends no
 * transaction. Unlike a 3009 authorization it is not bound to the intent: it names a spender and
 * an amount, nothing more, and anybody may submit it. That is why it backs the wallet rung and
 * not escrow.
 *
 * `signature` is the 65-byte `r ‖ s ‖ v`, split into the contract's struct at the call site.
 */
export type Permit2612 = { value: bigint; deadline: bigint; signature: Hex }

/**
 * A Permit2 SignatureTransfer: one transfer, one nonce, one deadline, and nothing that outlives
 * the intent.
 *
 * **This is the rung that survives a settlement redeploy, and it is the only one that does.**
 * Every other way of reaching a wallet rests on an ERC-20 allowance to `ProveRelayer`, which the
 * settlement's constructor creates — so a new settlement means a new relayer and every maker has
 * to approve again. Here the maker's one durable act is `approve(Permit2, max)` on the token, at
 * an address that is the same on every chain and moves for nobody.
 *
 * The counterpart is that this signature is worth nothing on its own and cannot be reused.
 * Permit2 spends the nonce once, enforces the deadline, and hashes the caller in as the spender —
 * so a signature made for one relayer cannot be presented by any other address.
 *
 * **There is no nonce field, for the reason `Auth3009` has none.** The nonce is the intent's
 * `authNonce`, or the intent's own hash when that is zero, and both are already here. Carrying it
 * as well would put a second copy on the wire that could disagree with the first, and the
 * settlement would refuse the leg. `encodeArming` derives it where the chain id is known.
 */
export type Permit2Transfer = {
  token: Address
  amount: bigint
  deadline: bigint
  signature: Hex
}

/** Terms plus the maker's signature: what a board message carries and a fill needs. */
export type SignedIntent = Intent & {
  signature: Hex
  auth?: Auth3009
  permit?: Permit2612
  permit2?: Permit2Transfer
  /**
   * The preimage of `feeConfig`, when the post carries it (the wire's optional preimage block).
   *
   * Not a signed term and not part of any hash: the signature covers `feeConfig`, and this is
   * only the list that hash was made of, so a reader that has never met the hash can display the
   * destinations and pay the book (`claim` needs the preimage) without a chain read. `decodeIntent`
   * returns it only when it hashes to `feeConfig` exactly and is canonical; anything else drops
   * the whole post. Present does not mean vouched for: see `wireFeeConfig`.
   */
  feeConfigPreimage?: FeeConfig
}

/** The zero address: an open executor, or a token that is not set. */
export const ZERO: Address = '0x0000000000000000000000000000000000000000'

/** Thirty-two zero bytes. In `authNonce` it means "use this intent's own hash". */
export const ZERO_HASH: Hex = `0x${'00'.repeat(32)}`

/** The chain id sits in the domain, so a testnet signature is meaningless on mainnet. */
export const domain = (chainId: ChainId = getChainId()): TypedDataDomain => ({
  name: 'prove.cash',
  version: '1',
  chainId,
  verifyingContract: settlement(chainId),
})

/**
 * The same domain, for a caller about to make a signature, and it refuses on a chain with no
 * settlement.
 *
 * `domain()` stays permissive because reading is not signing. A board archive holds intents
 * signed against a contract that has since moved, and `verifyIntent` and `intentHashOf` still
 * have to reproduce their digests to say so. Refusing there would turn a stale offer into an
 * error the reader cannot act on.
 *
 * Signing is the other direction, and there the zero address is never a domain a maker means.
 * A `verifyingContract` of `0x0000…0000` binds the signature to nothing: no contract can ever
 * spend it, no later deploy can rescue it, and the board takes it anyway. Seven offers reached
 * the public mainnet archive that way — see `DEFAULT_CHAIN` in `config.ts` — so the guard sits
 * under every signature rather than in front of one form.
 *
 * The wording matches the rest of the package's refusals, in `settlement.ts`, because a caller
 * catching one of them is catching the same fact.
 */
export function signingDomain(chainId: ChainId = getChainId()): TypedDataDomain {
  if (!settlementLive(chainId)) throw new Error('The settlement contract is not deployed.')
  return domain(chainId)
}

/**
 * The EIP-712 struct. The field order is the contract's `INTENT_TYPEHASH` order — change one
 * line here and every signature this package produces becomes unspendable.
 */
export const TYPES = {
  Intent: [
    { name: 'maker', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minOutStart', type: 'uint256' },
    { name: 'minOutEnd', type: 'uint256' },
    { name: 'startTime', type: 'uint64' },
    { name: 'endTime', type: 'uint64' },
    { name: 'executor', type: 'address' },
    // A nested struct for a wallet to show; the contract signs its hash (`Intent.feeConfig`).
    { name: 'feeConfig', type: 'FeeConfig' },
    { name: 'feeRate', type: 'uint64' },
    { name: 'minFill', type: 'uint256' },
    { name: 'authNonce', type: 'bytes32' },
    { name: 'flags', type: 'uint8' },
    { name: 'nonce', type: 'uint256' },
    // At the tail, where every downstream reader already expects the end of the struct. The
    // domain separator does not move with it: `name` and `version` name the contract, not this.
    { name: 'curve', type: 'bytes32' },
    // The other two take points, appended after `curve` so nothing before it moved.
    { name: 'feeRateIn', type: 'uint64' },
    { name: 'feeRateProceeds', type: 'uint64' },
  ],
  FeeConfig: [
    { name: 'destinations', type: 'address[]' },
    { name: 'weights', type: 'uint256[]' },
  ],
} as const

/** `keccak256` of the contract's `INTENT_TYPE` string, which `deployment.ts` checks against it. */
export const INTENT_TYPE =
  'Intent(address maker,address recipient,address tokenIn,address tokenOut,uint256 amountIn,uint256 minOutStart,uint256 minOutEnd,uint64 startTime,uint64 endTime,address executor,FeeConfig feeConfig,uint64 feeRate,uint256 minFill,bytes32 authNonce,uint8 flags,uint256 nonce,bytes32 curve,uint64 feeRateIn,uint64 feeRateProceeds)FeeConfig(address[] destinations,uint256[] weights)'
export const INTENT_TYPEHASH: Hex = keccak256(toHex(INTENT_TYPE))

/**
 * A fee config the process has seen the preimage of, by hash. `signIntent` and `typedDataFor`
 * look a hash up here when no preimage is passed.
 */
const KNOWN_CONFIGS = new Map<string, FeeConfig>()
/** Remember a config's preimage, so an intent that names its hash can be signed. Returns the hash. */
export function rememberFeeConfig(c: FeeConfig): Hex {
  const h = hashFeeConfig(c)
  KNOWN_CONFIGS.set(h.toLowerCase(), c)
  return h
}
/** The preimage this process has seen for a hash, or null. */
export const knownFeeConfig = (h: Hex): FeeConfig | null => KNOWN_CONFIGS.get(h.toLowerCase()) ?? null

/**
 * Preimages read off the board wire, by hash. **A separate store from `KNOWN_CONFIGS`, on
 * purpose.** `KNOWN_CONFIGS` is what a wallet may be asked to sign: the app puts a config there
 * only when the build ships it or the maker has acknowledged its destinations, and its signing
 * guard reads it. A stranger chooses what a board post carries, so a preimage learned from the
 * wire must never reach that guard — a post naming the chain's new, unshipped default with its
 * preimage would otherwise skip the acknowledgement for every maker who loaded the board.
 *
 * What this store CAN say is exact: the decoder admits a preimage only when it hashes to the
 * post's `feeConfig`, so an entry cannot be wrong for its key (the argument `ProveReader.remember`
 * makes on chain). It is for reading and paying, never for deciding what to sign.
 *
 * Bounded, least recently seen first out, because anybody can post a thousand configs: a
 * preimage seen again moves to the back of the queue, so one the board keeps carrying outlives a
 * flood of one-off configs.
 */
const WIRE_CONFIGS = new Map<string, FeeConfig>()
/** How many wire preimages one process keeps. A claim keeper needs a few; a flood gets this many. */
export const WIRE_CONFIG_CAP = 1_024

/** Keep a preimage the wire carried. Returns its hash. Checked here too, so no caller can skip it. */
export function learnWireFeeConfig(c: FeeConfig): Hex | null {
  if (feeConfigFault(c) !== 'None') return null
  const h = hashFeeConfig(c)
  const k = h.toLowerCase()
  // Seen again: taken out first, so the `set` below puts it at the back of the queue.
  const seen = WIRE_CONFIGS.delete(k)
  if (!seen && WIRE_CONFIGS.size >= WIRE_CONFIG_CAP) {
    const oldest = WIRE_CONFIGS.keys().next().value
    if (oldest !== undefined) WIRE_CONFIGS.delete(oldest)
  }
  WIRE_CONFIGS.set(k, { destinations: [...c.destinations], weights: [...c.weights] })
  return h
}

/** The preimage the board wire carried for this hash, or null. Never consulted when signing. */
export const wireFeeConfig = (h: Hex): FeeConfig | null => WIRE_CONFIGS.get(h.toLowerCase()) ?? null

/** Forget every wire preimage. For tests, and for a long-running reader that wants to. */
export function forgetWireFeeConfigs(): void {
  WIRE_CONFIGS.clear()
}

/**
 * The preimage of a fee config for reading or paying: one this process vouches for
 * (`knownFeeConfig`), else one the wire carried (`wireFeeConfig`), else null. Do not use it to
 * decide what a wallet signs.
 */
export const feeConfigPreimageOf = (h: Hex): FeeConfig | null => knownFeeConfig(h) ?? wireFeeConfig(h)

/**
 * What a wallet signs for this intent: `domain`, `types`, `primaryType` and `message`, with the
 * fee config's preimage in place of its hash so the wallet can show who gets paid.
 *
 * @throws when the intent's `feeConfig` is zero (no wallet can sign it, see `Intent.feeConfig`) or
 * when the preimage is neither passed nor remembered, or does not hash to `intent.feeConfig`.
 */
export function typedDataFor(
  i: Intent,
  preimage?: FeeConfig,
  chainId?: ChainId,
  domainOverride?: TypedDataDomain,
) {
  const config = preimage ?? knownFeeConfig(i.feeConfig)
  if (i.feeConfig === ZERO_HASH) {
    throw new Error('A wallet cannot sign feeConfig = 0. Name a config at rate 0, or sign the digest.')
  }
  if (!config) throw new Error(`No preimage for fee config ${i.feeConfig}.`)
  if (hashFeeConfig(config).toLowerCase() !== i.feeConfig.toLowerCase()) {
    throw new Error('The fee config given does not hash to the intent’s feeConfig.')
  }
  const { feeConfig: _hash, ...rest } = i
  return {
    domain: domainOverride ?? domain(chainId),
    types: TYPES,
    primaryType: 'Intent' as const,
    message: {
      ...rest,
      feeConfig: { destinations: [...config.destinations], weights: [...config.weights] },
    },
  }
}

/** Anything with viem's `signTypedData`, and optionally a raw-digest `sign` (a local account). */
export type IntentSigner = {
  signTypedData: (args: never) => Promise<Hex>
  sign?: (args: { hash: Hex }) => Promise<Hex>
  address?: Address
}

/**
 * Sign an intent. With a fee config's preimage (passed, or remembered) it asks the signer for
 * typed data, so a wallet shows the destinations. Without one, and only when `feeConfig` is zero,
 * it signs the digest itself, which needs a signer with `sign` (a local key).
 */
export async function signIntent(
  signer: IntentSigner,
  i: Intent,
  opts: {
    preimage?: FeeConfig
    chainId?: ChainId
    /** Sign against this domain instead of the registry's (a fork, a local node). */
    domain?: TypedDataDomain
    account?: Address | { address: Address }
  } = {},
): Promise<Hex> {
  const config = opts.preimage ?? knownFeeConfig(i.feeConfig)
  if (config && i.feeConfig !== ZERO_HASH) {
    const td = typedDataFor(i, config, opts.chainId, opts.domain)
    const args = opts.account ? { account: opts.account, ...td } : td
    return signer.signTypedData(args as never)
  }
  if (i.feeConfig === ZERO_HASH && signer.sign) {
    return signer.sign({ hash: intentDigest(i, opts.domain ?? domain(opts.chainId)) })
  }
  throw new Error('This intent cannot be signed here: it needs its fee config’s preimage, or a local key.')
}

/** True when the maker allows a fill smaller than the whole amount. */
export const isPartial = (i: Intent) => (i.flags & FLAG_PARTIAL) !== 0
/** True when token A sits in the contract's escrow rather than the maker's wallet. */
export const isEscrow = (i: Intent) => (i.flags & FLAG_ESCROW) !== 0
/** True when token A is reached by a Permit2 signature rather than by an allowance to us. */
export const isPermit2 = (i: Intent) => (i.flags & FLAG_PERMIT2) !== 0
/**
 * The seconds a window covers, inclusive at both ends. Empty when `from > until`.
 *
 * `TimeWindow` and not `Window`, because this is a package root export and `Window` is the DOM's.
 * A consumer who writes the bare name in a browser file would get whichever one their imports
 * happened to resolve, and the two are nothing alike.
 */
export type TimeWindow = { from: bigint; until: bigint }

/**
 * The seconds an EIP-3009 authorization is usable in, from the two bounds the maker signed.
 *
 * Exclusive at both ends, and the off-by-one is the standard's rather than ours: the token
 * requires `validAfter < now < validBefore`, so the first usable second is one past `validAfter`
 * and the last is one before `validBefore`. Everything that reasons about a 3009 window reads it
 * from here, so one place holds the rule.
 */
export const authUsableWindow = (a: Pick<Auth3009, 'validAfter' | 'validBefore'>): TimeWindow => ({
  from: a.validAfter + 1n,
  until: a.validBefore - 1n,
})

/**
 * The seconds a leg can actually settle in: where the intent's own window and its funding
 * signature's overlap.
 *
 * **The two windows are separate and nothing on chain reconciles them.** The settlement enforces
 * `startTime` and `endTime`; the token enforces `validAfter` and `validBefore`. So a maker may
 * sign an authorization that opens after their offer expires, and the offer still reaches the
 * board looking healthy. `_termsOk` never reads the authorization, and every arming failure comes
 * back as `EscrowShort` — which is what a spent nonce and a taxed token look like too.
 *
 * An empty result means nobody can ever fill this leg. A client that signs one has produced a
 * dead offer, and this function is the only thing that will say so.
 *
 * An intent with no authorization is bounded by its own window alone. Escrow and a standing
 * allowance do not expire.
 */
export function liveWindow(
  i: Pick<Intent, 'startTime' | 'endTime'>,
  auth?: Pick<Auth3009, 'validAfter' | 'validBefore'>,
): TimeWindow {
  if (!auth) return { from: i.startTime, until: i.endTime }
  const a = authUsableWindow(auth)
  return {
    from: a.from > i.startTime ? a.from : i.startTime,
    until: a.until < i.endTime ? a.until : i.endTime,
  }
}

/** True when a window holds no second at all, so nothing can ever fill inside it. */
export const isDeadWindow = (w: TimeWindow): boolean => w.from > w.until

/** True when the asking rate falls over the intent's life. */
export const isDutch = (i: Intent) => i.minOutEnd < i.minOutStart

/** Which reader this intent's `curve` gets: one of the four `KIND_*` values. */
export const curveKindOf = (i: Intent): number => i.flags & FLAG_CURVE_KIND

/** `CURVE_ONE`, in the width the arithmetic below works in. */
const CURVE_ONE_B = BigInt(CURVE_ONE)

/**
 * Pack a stretch, for `KIND_STRETCH`. Both arguments are fractions of the window in 0..1.
 *
 * `start` is where the fall begins and `length` is how long it takes. The price holds the
 * ceiling before the start, falls in a straight line across the stretch, and rests on the floor
 * after it. Every shape anybody has asked for is one of those three regions or two of them:
 *
 *   stretchCurve(0, 0.25)     dutch over the first quarter, then flat at the floor
 *   stretchCurve(0.5, 0)      flat for half the window, then dutch to the close
 *   stretchCurve(0.25, 0.25)  flat a quarter, dutch a quarter, flat a half
 *   stretchCurve(0, 1)        the shipped straight line, and so is `CURVE_LINEAR`
 *
 * **A length of zero means "to the end of the window".** That is the wire format's own rule and
 * not a convenience here: it is what makes the zero word reduce to the line.
 *
 * Both fractions are quantised to 1/65,535 of the window and clamped into it. A clamp rather
 * than a refusal, because a start past the end of the window is a shape the format can express —
 * the price never falls — and a slider that overshoots by a rounding error meant the end of it.
 */
export function stretchCurve(start: number, length: number): Hex {
  return `0x${curveFraction(start)}${curveFraction(length)}${'00'.repeat(28)}`
}

/** One `uint16` of a curve, as four hex characters, from a fraction of the window. */
function curveFraction(fraction: number): string {
  if (!Number.isFinite(fraction)) throw new Error('a curve fraction must be a finite number')
  const n = Math.round(fraction * CURVE_ONE)
  const clamped = n < 0 ? 0 : n > CURVE_ONE ? CURVE_ONE : n
  return clamped.toString(16).padStart(4, '0')
}

/**
 * The instants this intent's price turns at, as absolute timestamps, for a solver.
 *
 * Only the interior knots: never `startTime`, never `endTime`, and never a repeat. A kind with
 * no knots gets an empty list, which is kind 0 and — until a settlement implements them —
 * kinds 2 and 3 as well.
 *
 * **This exists because a bisection needs a monotone predicate.** `profitableFrom` searches for
 * the first second a ring pays, and a curve that rises anywhere can open, close and open again:
 * a bisection between an unprofitable start and a profitable deadline then lands in the wrong
 * basin, or reports nothing while a profitable interval sits in the middle. Probing each knot
 * and bisecting only inside a segment repairs that, and every kind here is piecewise linear, so
 * the knots are all there is to probe. The stretch has no rising segment; it has two flat ones,
 * and the same walk serves both.
 *
 * A knot lands on the second the format puts it on, which is the last second of the region
 * before it: the fall over `[start, start + length]` begins at the second after the first knot.
 */
export function breakpointsOf(i: Intent): bigint[] {
  if (curveKindOf(i) !== KIND_STRETCH) return []
  const span = i.endTime - i.startTime
  if (span <= 0n) return []
  const { startF, lenF } = stretchOf(i.curve)
  const out: bigint[] = []
  for (const f of [startF, startF + lenF]) {
    const t = i.startTime + (f * span) / CURVE_ONE_B
    if (t > i.startTime && t < i.endTime && !out.includes(t)) out.push(t)
  }
  return out
}

/** The two `uint16` a stretch packs into its first four bytes. */
function stretchOf(curve: Hex): { startF: bigint; lenF: bigint } {
  const c = BigInt(curve)
  const startF = c >> 240n
  const lenF = (c >> 224n) & 0xffffn
  // Zero means "to the end of the window", and it is what makes the zero word the shipped line.
  return { startF, lenF: lenF === 0n ? CURVE_ONE_B - startF : lenF }
}

/**
 * The minimum token B owed for the whole `amountIn`, at time `now` (seconds).
 *
 * The ends are the maker's own two numbers whatever the curve says: `minOutStart` is the ceiling
 * and `minOutEnd` is the floor, and the curve only says where between them the price sits at
 * each moment. That is what keeps `hi - lo` from underflowing without a branch, and it is what
 * lets a chart draw its axes before it knows the shape.
 *
 * **A kind this reader does not know prices as the line.** The contract does the same: it
 * branches on `KIND_STRETCH` alone, and kinds 2 and 3 are two documented bits with no arithmetic
 * behind them yet. The two readers agree deliberately, and they change together on the day a
 * settlement implements one.
 *
 * **Keep the curve long enough that a proposer cannot price it.** The chain reads `now` from
 * `block.timestamp`, and a proposer chooses that within one slot by skipping their turn. Sampled
 * on 2026-08-14: PulseChain 943 and 369 both run 10-second slots, strictly increasing, 20 seconds
 * when a slot goes begging. So one skip moves the price by 10 seconds of decay, and the proposer
 * pays a block reward for it. Over an hour that is 0.3% of the range; over a minute it is a sixth.
 * The app's shortest window is 15 minutes, where a skip is worth about 1%. A stretch concentrates
 * the same range into less time, so a short stretch is worth more to a proposer than a long one.
 */
export function minOutAt(i: Intent, now: bigint): bigint {
  // The three guards are the envelope and they hold whatever the kind: the ceiling at or before
  // the open, the floor at or after the close, and one price throughout for an intent whose two
  // ends agree. `RfqVenue`'s mirror check rests on the third, so it sits above the branch here
  // exactly as it does in the contract.
  if (now <= i.startTime || i.minOutEnd === i.minOutStart) return i.minOutStart
  if (now >= i.endTime) return i.minOutEnd
  const span = i.endTime - i.startTime
  if (span === 0n) return i.minOutEnd
  const elapsed = now - i.startTime
  if (curveKindOf(i) === KIND_STRETCH) {
    return stretchAt(i.minOutStart, i.minOutEnd, i.curve, elapsed, span)
  }
  return i.minOutStart - ((i.minOutStart - i.minOutEnd) * elapsed) / span
}

/**
 * `_stretchAt`, mirrored. The comparisons run in the contract's order and for its reasons.
 *
 * **The zero word is the shipped line, character for character.** With `startF = 0` and
 * `lenF = 0 -> 65535` the return is `hi - (range · elapsed · 65535) / (65535 · span)`, and
 * `floor(a·k / b·k) = floor(a / b)`. The subtrahend floors, so the maker's price rounds up,
 * exactly as it does today.
 *
 * **No word divides by zero.** `den` is zero only when `startF` is 65,535 and the length is
 * zero, and then `begin = 65535 · span` is past every `pos` this function is reached with, so
 * the flat return above fires first.
 */
function stretchAt(hi: bigint, lo: bigint, curve: Hex, elapsed: bigint, span: bigint): bigint {
  const { startF, lenF } = stretchOf(curve)
  const pos = elapsed * CURVE_ONE_B
  const begin = startF * span
  if (pos <= begin) return hi
  const den = lenF * span
  const num = pos - begin
  if (num >= den) return lo
  return hi - ((hi - lo) * num) / den
}

/**
 * The gross token B a fill of `take` token A is measured against, at time `now`.
 *
 * **This is the filler's whole outlay, and it is not what the maker receives.** The settlement
 * splits it: `feeOn` takes the fee out of this number and the maker gets the remainder. So the
 * name says gross, and the net is `quote(...).delivered`. It used to be called `requiredOut`,
 * back when the fee rode on top and this really was what the recipient required.
 *
 * It rounds up, exactly as `_ceilDiv` does, so the rounding favours the maker.
 */
export function grossOut(i: Intent, take: bigint, now: bigint): bigint {
  const m = minOutAt(i, now)
  return (take * m + i.amountIn - 1n) / i.amountIn
}

/**
 * The permit as `ProveSettlement.Permit` wants it: `v`, `r` and `s` apart.
 *
 * `v` is optional on viem's parsed signature because a compact one carries the parity inside `s`.
 * A wallet that returns compact form would otherwise hand the contract `v = 0` and every
 * `ecrecover` inside the token would fail, so it is derived rather than defaulted.
 */
export function splitPermit(p: Permit2612): {
  value: bigint
  deadline: bigint
  v: number
  r: Hex
  s: Hex
} {
  const { r, s, v, yParity } = parseSignature(p.signature)
  return { value: p.value, deadline: p.deadline, v: Number(v ?? BigInt(yParity) + 27n), r, s }
}

// ── Wire codec ────────────────────────────────────────────────────────────────
// Proof of work charges per byte, so the board payload is packed binary, not JSON.
// Presence bits are codec-only: the decoder rebuilds the full struct before it hashes.

/**
 * Version 4: `Intent` grew `curve`, so the typehash moved again.
 *
 * **A new `KIND_*` will not do, and the distinction is the whole design.** Kinds exist so that an
 * unknown *tail* costs one dropped post: a reader that has never heard of Permit2 skips the
 * message and reads every other one. `curve` sits in the head that every reader parses, behind a
 * presence bit in a byte they all read, so a version 3 reader that guessed at it would misalign
 * every byte after it. The version byte is how it is told not to guess.
 *
 * Version 3 was three changes at once: `minFill` arrived as a signed field, and both signatures
 * became length-prefixed so an ERC-1271 wallet's answer of any width could ride.
 *
 * The decoder refuses a version it does not know rather than reading one layout as another —
 * every byte after the first difference would be misaligned, and a misread intent is worse than
 * a dropped one. The archive still holds version 1 to 4 posts and they decode to null, which
 * is what `decodeIntent` already means by "not a well-formed intent". None of them could be
 * filled anyway: each carries a signature over a typehash the settlement no longer verifies.
 */
const VERSION = 5
const KIND_INTENT = 1
/** An intent plus the maker's EIP-3009 authorization — the gasless custody mode. */
const KIND_INTENT_AUTH = 2
/**
 * An intent plus the maker's EIP-2612 permit — the other gasless mode, for the tokens that cannot
 * do 3009. The two are alternatives and never both: one funds an escrow, the other grants an
 * allowance, and an intent is backed one way.
 */
const KIND_INTENT_PERMIT = 3
/**
 * An intent plus the maker's Permit2 SignatureTransfer — the gasless mode that survives a
 * settlement redeploy.
 *
 * A new kind rather than a new version, for the reason `P_FEE_TO` gives about presence bits: a
 * reader that has never heard of this one refuses the message and drops one post, where a version
 * bump would make every reader refuse every post. Nothing already on the board changes shape.
 *
 * The token is on the wire because a Permit2 permit carries its own, and the settlement checks it
 * against `tokenIn` before Permit2 hears about it. The nonce is not, because it is derivable —
 * see `Permit2Transfer`.
 */
const KIND_INTENT_PERMIT2 = 4
const P_RECIPIENT = 1
const P_EXECUTOR = 2
/**
 * The intent names a fee destination. Absent means `ZERO`, which the contract reads as "charge
 * nothing".
 *
 * A presence bit rather than a version bump, so a message written before this field existed still
 * decodes — its bit is clear, and clear has always meant zero. The 20 bytes are only spent by an
 * intent that actually names somewhere, and proof of work charges by the byte.
 */
const P_FEE_TO = 4
/**
 * The intent names its own fee rate. Absent means zero, which charges nothing.
 *
 * A presence bit rather than a version bump, for the reason `P_FEE_TO` gives: a message written
 * before this field existed still decodes, because clear has always meant zero. Two bytes, and
 * only for an intent that actually names a rate.
 */
const P_FEE_RATE = 8
/**
 * The intent names a minimum fill. Absent means zero, which is no floor.
 *
 * A presence bit rather than an unconditional varint, for the reason `P_FEE_TO` gives: proof of
 * work charges by the byte and most intents name no floor. Only one that does pays for it.
 */
const P_MIN_FILL = 16
/**
 * The intent names the 3009 nonce its authorization must carry. Absent means its own hash.
 *
 * A presence bit rather than an unconditional field, because thirty-two bytes is the most
 * expensive thing on this wire and almost no intent names one. Proof of work charges by the byte.
 */
const P_AUTH_NONCE = 32
/**
 * The intent draws its own decay. Absent means `CURVE_LINEAR`, the straight line.
 *
 * **A varint is wrong for this field.** A varint strips *leading* zeros and a curve's zeros are
 * at the *trailing* end, so `varint(uint256(curve))` would spend thirty-three bytes on a
 * four-byte stretch. This writes a length byte in 1..32 and then that many bytes, and the
 * decoder pads the rest with zeros. A stretch costs five bytes, which is 0.27% more proof of
 * work on a typical intent.
 */
const P_CURVE = 64
/**
 * The intent names P1 or P3 (`feeRateIn`, `feeRateProceeds`). Bit 128, the last free one; when
 * set, one more byte follows the presence byte's fields' first slot: bit 0 says `feeRateIn` is
 * present, bit 1 says `feeRateProceeds` is, each eight bytes. Absent means zero.
 *
 * `P_FEE_TO` (bit 4) changed meaning with `feeConfig`: 32 bytes of hash where there were 20 of
 * address. That is why `VERSION` moved to 5: a version-4 reader would take the first 20 bytes of
 * a hash for an address.
 */
const P_FEE_EXT = 128
const FEE_EXT_IN = 1
const FEE_EXT_PROCEEDS = 2
/**
 * The post carries the preimage of `feeConfig`: bit 2 of the `P_FEE_EXT` byte, and the block
 * follows the two rates. Optional, and absent on most posts (a config the reading build ships, or
 * `feeConfig = 0`).
 *
 * **A bit in the extension byte rather than `VERSION` 6, and that is the whole compatibility
 * story.** A version bump makes every reader built before it refuse every post, with or without
 * a block. This bit changes nothing about a post that does not set it: those stay byte-identical
 * and every version 5 reader keeps reading them. A reader built before the bit refuses a post
 * that sets it (its extension check drops unknown bits), so the cost of the block lands only on
 * the posts that carry one, and only until that reader upgrades.
 *
 * The block: one byte `n` (1..`MAX_DESTINATIONS`), `n` destinations of 20 bytes, then `n - 1`
 * weights of 8 bytes each, big-endian. The last weight is not sent: a canonical config's weights
 * sum to `WAD`, so it is `WAD` less the others. A weight fits eight bytes because none exceeds
 * `WAD` (1e18 < 2^64). One destination costs 21 bytes, two 49, eight 217.
 *
 * The decoder rebuilds the config and drops the post unless it is canonical
 * (`feeConfigFault === 'None'`) and hashes to the post's `feeConfig` exactly. A bit set on a post
 * with `feeConfig = 0` is dropped too: there is nothing for a preimage to be the preimage of.
 */
const FEE_EXT_PREIMAGE = 4
const FEE_EXT_KNOWN = FEE_EXT_IN | FEE_EXT_PROCEEDS | FEE_EXT_PREIMAGE

/** The wire's preimage block, or a throw: the encoder never writes a post every reader drops. */
function preimageField(feeConfig: Hex, c: FeeConfig): Uint8Array {
  if (feeConfig === ZERO_HASH) throw new Error('A preimage block needs a non-zero feeConfig.')
  const fault = feeConfigFault(c)
  if (fault !== 'None') throw new Error(`The fee config preimage is not canonical (${fault}).`)
  if (hashFeeConfig(c).toLowerCase() !== feeConfig.toLowerCase()) {
    throw new Error('The fee config preimage does not hash to the intent’s feeConfig.')
  }
  const n = c.destinations.length
  const out: Uint8Array[] = [new Uint8Array([n])]
  for (const d of c.destinations) out.push(hexToBytes(d))
  for (let k = 0; k + 1 < n; k++) out.push(fixed(c.weights[k], 8))
  let len = 0
  for (const p of out) len += p.length
  const field = new Uint8Array(len)
  let o = 0
  for (const p of out) {
    field.set(p, o)
    o += p.length
  }
  return field
}

function varint(v: bigint): Uint8Array {
  if (v < 0n) throw new Error('negative')
  let hex = v.toString(16)
  if (hex === '0') return new Uint8Array([0])
  if (hex.length % 2) hex = '0' + hex
  const body = hexToBytes(`0x${hex}` as Hex)
  if (body.length > 32) throw new Error('value exceeds uint256')
  return new Uint8Array([body.length, ...body])
}

/**
 * A signature on the wire: two bytes of length, then the bytes.
 *
 * Both signatures were a bare 65 bytes until version 3. An ERC-1271 wallet's answer is whatever
 * its own check accepts — 64 for a compact one, hundreds for a multisig — so a fixed width made
 * the board a rung a contract wallet could not reach. Two bytes rather than one, because a
 * multisig's answer passes 255 with three signers in it.
 */
function blob(sig: Hex): Uint8Array {
  const body = hexToBytes(sig)
  if (body.length > 0xffff) throw new Error('signature too long')
  return new Uint8Array([body.length >> 8, body.length & 0xff, ...body])
}

function uint(bytes: Uint8Array): bigint {
  return bytes.length ? BigInt(bytesToHex(bytes)) : 0n
}

function fixed(v: bigint, size: number): Uint8Array {
  const out = new Uint8Array(size)
  let x = v
  for (let k = size - 1; k >= 0; k--) {
    out[k] = Number(x & 0xffn)
    x >>= 8n
  }
  if (x !== 0n) throw new Error('value overflows field')
  return out
}

/**
 * The curve as the wire carries it: a length byte, then that many bytes from the front of the
 * word. Empty for the straight line, which the presence bit says by staying clear.
 */
function curveField(curve: Hex): Uint8Array {
  const body = hexToBytes(curve)
  if (body.length !== 32) throw new Error('a curve is thirty-two bytes')
  let n = 32
  while (n > 0 && body[n - 1] === 0) n--
  return n === 0 ? new Uint8Array(0) : new Uint8Array([n, ...body.subarray(0, n)])
}

/** Pack a signed intent into the board payload. The smallest form the terms allow. */
export function encodeIntent(s: SignedIntent): Hex {
  const curve = curveField(s.curve)
  const presence =
    (s.recipient.toLowerCase() === s.maker.toLowerCase() ? 0 : P_RECIPIENT) |
    (s.executor === ZERO ? 0 : P_EXECUTOR) |
    (s.feeConfig === ZERO_HASH ? 0 : P_FEE_TO) |
    (s.feeRate === 0n ? 0 : P_FEE_RATE) |
    (s.minFill === 0n ? 0 : P_MIN_FILL) |
    (s.authNonce === ZERO_HASH ? 0 : P_AUTH_NONCE) |
    (curve.length === 0 ? 0 : P_CURVE) |
    (s.feeRateIn === 0n && s.feeRateProceeds === 0n && !s.feeConfigPreimage ? 0 : P_FEE_EXT)
  // Built before anything is written, so a preimage that does not belong to this intent throws
  // rather than producing a post every reader drops.
  const preimage = s.feeConfigPreimage ? preimageField(s.feeConfig, s.feeConfigPreimage) : null

  const parts: Uint8Array[] = [
    new Uint8Array([
      VERSION,
      s.auth
        ? KIND_INTENT_AUTH
        : s.permit
          ? KIND_INTENT_PERMIT
          : s.permit2
            ? KIND_INTENT_PERMIT2
            : KIND_INTENT,
      s.flags & 0xff,
      presence,
    ]),
    hexToBytes(s.maker),
    hexToBytes(s.tokenIn),
    hexToBytes(s.tokenOut),
  ]
  if (presence & P_RECIPIENT) parts.push(hexToBytes(s.recipient))
  if (presence & P_EXECUTOR) parts.push(hexToBytes(s.executor))
  if (presence & P_FEE_TO) parts.push(hexToBytes(s.feeConfig))
  // Eight bytes, big-endian, unsigned. It was two bytes of two's complement when the rate was
  // an int16 counted in basis points; a rate is a fraction of one ether now, so it needs the
  // width and no longer needs the sign. Only an intent that names a fee pays the eight bytes.
  if (presence & P_FEE_RATE) parts.push(fixed(s.feeRate, 8))
  if (presence & P_FEE_EXT) {
    const ext =
      (s.feeRateIn === 0n ? 0 : FEE_EXT_IN) |
      (s.feeRateProceeds === 0n ? 0 : FEE_EXT_PROCEEDS) |
      (preimage ? FEE_EXT_PREIMAGE : 0)
    parts.push(new Uint8Array([ext]))
    if (ext & FEE_EXT_IN) parts.push(fixed(s.feeRateIn, 8))
    if (ext & FEE_EXT_PROCEEDS) parts.push(fixed(s.feeRateProceeds, 8))
    if (preimage) parts.push(preimage)
  }
  parts.push(varint(s.amountIn), varint(s.minOutStart), varint(s.minOutEnd))
  if (presence & P_MIN_FILL) parts.push(varint(s.minFill))
  if (presence & P_AUTH_NONCE) parts.push(hexToBytes(s.authNonce))
  parts.push(fixed(s.startTime, 5), fixed(s.endTime - s.startTime, 4))
  // Behind the window, because a curve is read as a fraction of it and means nothing alone.
  if (presence & P_CURVE) parts.push(curve)
  parts.push(varint(s.nonce), blob(s.signature))
  if (s.auth) {
    parts.push(varint(s.auth.validAfter), varint(s.auth.validBefore), blob(s.auth.signature))
  } else if (s.permit) {
    // The permit stays a fixed 65 bytes. EIP-2612 takes `v`, `r` and `s` as three arguments and
    // has no unstructured form to widen to, so there is nothing here a contract wallet could
    // send that a token would accept.
    parts.push(varint(s.permit.value), varint(s.permit.deadline), hexToBytes(s.permit.signature))
  } else if (s.permit2) {
    // Length-prefixed like the maker's own signature, and unlike the EIP-2612 one: Permit2 reads
    // an ERC-1271 answer as readily as a key's, so a contract wallet can back an offer here too.
    parts.push(
      hexToBytes(s.permit2.token),
      varint(s.permit2.amount),
      varint(s.permit2.deadline),
      blob(s.permit2.signature),
    )
  }

  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return bytesToHex(out)
}

/** Unpack a board payload. Null for anything that is not a well-formed intent. */
export function decodeIntent(data: Hex): SignedIntent | null {
  try {
    const b = hexToBytes(data)
    if (b.length < 70 || b[0] !== VERSION) return null
    if (
      b[1] !== KIND_INTENT &&
      b[1] !== KIND_INTENT_AUTH &&
      b[1] !== KIND_INTENT_PERMIT &&
      b[1] !== KIND_INTENT_PERMIT2
    ) {
      return null
    }
    const flags = b[2]
    const presence = b[3]
    let o = 4
    const addr = () => {
      const a = bytesToHex(b.slice(o, o + 20)) as Address
      o += 20
      return a
    }
    const maker = addr()
    const tokenIn = addr()
    const tokenOut = addr()
    const recipient = presence & P_RECIPIENT ? addr() : maker
    const executor = presence & P_EXECUTOR ? addr() : ZERO
    let feeConfig: Hex = ZERO_HASH
    if (presence & P_FEE_TO) {
      feeConfig = bytesToHex(b.slice(o, o + 32))
      o += 32
    }
    let feeRate = 0n
    if (presence & P_FEE_RATE) {
      feeRate = uint(b.slice(o, o + 8))
      o += 8
    }
    let feeRateIn = 0n
    let feeRateProceeds = 0n
    let feeConfigPreimage: FeeConfig | undefined
    if (presence & P_FEE_EXT) {
      const ext = b[o++]
      if (ext & ~FEE_EXT_KNOWN || ext === 0) return null
      if (ext & FEE_EXT_IN) {
        feeRateIn = uint(b.slice(o, o + 8))
        o += 8
      }
      if (ext & FEE_EXT_PROCEEDS) {
        feeRateProceeds = uint(b.slice(o, o + 8))
        o += 8
      }
      if (ext & FEE_EXT_PREIMAGE) {
        // A preimage of nothing: `feeConfig = 0` has no config to be the preimage of.
        if (!(presence & P_FEE_TO)) return null
        const n = b[o++]
        if (n === undefined || n === 0 || n > MAX_DESTINATIONS) return null
        // Read the whole block or nothing. The exact-consume check below would catch a short
        // block too; this one says which field ran out.
        if (o + 20 * n + 8 * (n - 1) > b.length) return null
        const destinations: Address[] = []
        for (let k = 0; k < n; k++) destinations.push(getAddress(addr()))
        const weights: bigint[] = []
        let sum = 0n
        for (let k = 0; k + 1 < n; k++) {
          const w = uint(b.slice(o, o + 8))
          o += 8
          weights.push(w)
          sum += w
        }
        // The last weight is implied. At or past `WAD` already, it would be zero or negative.
        if (sum >= WAD) return null
        weights.push(WAD - sum)
        const config: FeeConfig = { destinations, weights }
        // Canonical, and exactly the preimage of the hash the maker signed. A mismatch is not a
        // config this post may carry, and a reader cannot tell which half is wrong, so the post
        // goes.
        if (feeConfigFault(config) !== 'None') return null
        if (hashFeeConfig(config).toLowerCase() !== feeConfig.toLowerCase()) return null
        feeConfigPreimage = config
      }
    }
    const next = () => {
      const len = b[o++]
      const v = uint(b.slice(o, o + len))
      o += len
      return v
    }
    // Two bytes of length, then the bytes. A prefix that runs past the end leaves `o` beyond
    // `b.length`, and the exact-consume check below turns that into null.
    const sigAt = () => {
      const len = (b[o] << 8) | b[o + 1]
      o += 2
      const hex = bytesToHex(b.slice(o, o + len))
      o += len
      return { hex, len }
    }
    const amountIn = next()
    const minOutStart = next()
    const minOutEnd = next()
    const minFill = presence & P_MIN_FILL ? next() : 0n
    let authNonce = ZERO_HASH
    if (presence & P_AUTH_NONCE) {
      authNonce = bytesToHex(b.slice(o, o + 32))
      o += 32
    }
    const startTime = uint(b.slice(o, o + 5))
    o += 5
    const endTime = startTime + uint(b.slice(o, o + 4))
    o += 4
    let curve = CURVE_LINEAR
    if (presence & P_CURVE) {
      const len = b[o++]
      // Zero is the straight line, which a clear presence bit already says, and a writer who
      // spends a byte to say it again is a writer this reader does not know. Above thirty-two is
      // not a word at all. Either way the post is dropped rather than half-read.
      if (len === 0 || len > 32) return null
      // A tail that runs past the end. The exact-consume check below would catch it too; this
      // one says which field ran out.
      if (o + len > b.length) return null
      const word = new Uint8Array(32)
      word.set(b.slice(o, o + len))
      o += len
      curve = bytesToHex(word)
    }
    const nonce = next()
    const own = sigAt()
    if (own.len === 0) return null
    const signature = own.hex
    let auth: Auth3009 | undefined
    let permit: Permit2612 | undefined
    let permit2: Permit2Transfer | undefined
    if (b[1] === KIND_INTENT_AUTH) {
      const validAfter = next()
      const validBefore = next()
      const authSig = sigAt()
      if (authSig.len === 0) return null
      auth = { validAfter, validBefore, signature: authSig.hex }
    } else if (b[1] === KIND_INTENT_PERMIT) {
      const value = next()
      const deadline = next()
      const permitSignature = bytesToHex(b.slice(o, o + 65))
      o += 65
      permit = { value, deadline, signature: permitSignature }
    } else if (b[1] === KIND_INTENT_PERMIT2) {
      const token = addr()
      const amount = next()
      const deadline = next()
      const sig = sigAt()
      if (sig.len === 0) return null
      permit2 = { token, amount, deadline, signature: sig.hex }
    }
    if (b.length !== o) return null
    if (amountIn === 0n) return null
    return {
      maker,
      recipient,
      tokenIn,
      tokenOut,
      amountIn,
      minOutStart,
      minOutEnd,
      startTime,
      endTime,
      executor,
      feeConfig,
      feeRate,
      feeRateIn,
      feeRateProceeds,
      minFill,
      authNonce,
      flags,
      nonce,
      curve,
      signature,
      ...(auth ? { auth } : {}),
      ...(permit ? { permit } : {}),
      ...(permit2 ? { permit2 } : {}),
      ...(feeConfigPreimage ? { feeConfigPreimage } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Unpack a board payload, check the maker's signature (`verifyIntent`), and only then keep any
 * fee config preimage it carries (`learnWireFeeConfig`), so a solver, a keeper or an indexer that
 * meets the hash again can display and pay it without a chain read. Null for a payload that does
 * not decode or a signature that is not the maker's. The read path every reader of the board
 * should use; `decodeIntent` stays pure. Learning only from a verified post keeps a flood of
 * unsigned posts from cycling the bounded store: an unsigned post costs proof of work and nothing
 * else, a signed one costs a key and a signature per post.
 */
export async function readIntent(data: Hex, chainId?: ChainId): Promise<SignedIntent | null> {
  const s = decodeIntent(data)
  if (!s || !(await verifyIntent(s, chainId))) return null
  if (s.feeConfigPreimage) learnWireFeeConfig(s.feeConfigPreimage)
  return s
}

/**
 * The intent ready for the wire: with its fee config's preimage attached when a reader may not
 * know it, and without it when every reader does.
 *
 * Attached when `feeConfig` is non-zero, the preimage is to hand (passed on the intent, or one
 * this process vouches for) and `ships(feeConfig)` is false — `ships` says whether the readers'
 * builds carry the config already, which for prove.cash is "one of the chain's bundled defaults"
 * (`isBundledFeeConfig`). Omitted otherwise, because every byte costs proof of work. An intent
 * whose preimage is nowhere to hand goes out without a block: a reader can still fill it, since
 * the settlement takes the hash alone.
 */
export function withWirePreimage(s: SignedIntent, ships: (feeConfig: Hex) => boolean): SignedIntent {
  const { feeConfigPreimage: given, ...rest } = s
  if (s.feeConfig === ZERO_HASH || ships(s.feeConfig)) return rest
  const preimage = given ?? knownFeeConfig(s.feeConfig)
  if (!preimage || hashFeeConfig(preimage).toLowerCase() !== s.feeConfig.toLowerCase()) return rest
  return { ...rest, feeConfigPreimage: preimage }
}

/** True when the signature really is the maker's. Every reader checks this itself. */
export async function verifyIntent(s: SignedIntent, chainId?: ChainId): Promise<boolean> {
  try {
    const { signature } = s
    const signer = await recoverAddress({ hash: intentHashOf(s, chainId), signature })
    return signer.toLowerCase() === s.maker.toLowerCase()
  } catch {
    return false
  }
}

/**
 * The intent's EIP-712 digest — the exact value `hashIntent` returns on chain. Escrow deposits
 * key on it, and a 3009 authorization must carry it as its nonce.
 */
export function intentHashOf(i: Intent, chainId?: ChainId): Hex {
  return intentDigest(i, domain(chainId))
}

/** The digest of an intent under an explicit domain: what `intentHashOf` is for the registry's. */
export function intentDigest(i: Intent, dom: TypedDataDomain): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint64' },
        { type: 'uint64' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'uint64' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint8' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint64' },
        { type: 'uint64' },
      ],
      [
        INTENT_TYPEHASH,
        i.maker,
        i.recipient,
        i.tokenIn,
        i.tokenOut,
        i.amountIn,
        i.minOutStart,
        i.minOutEnd,
        i.startTime,
        i.endTime,
        i.executor,
        // The nested struct enters the digest as its own hash, which is what the intent carries.
        i.feeConfig,
        i.feeRate,
        i.minFill,
        i.authNonce,
        i.flags,
        i.nonce,
        i.curve,
        i.feeRateIn,
        i.feeRateProceeds,
      ],
    ),
  )
  return keccak256(concat(['0x1901', hashDomain({ domain: dom as never, types: { EIP712Domain: EIP712_DOMAIN } }), structHash]))
}

const EIP712_DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const

/**
 * The 3009 nonce a fill will present for this intent: the one it names, or its own hash.
 *
 * One place, because two readers that disagree here produce an authorization the settlement
 * refuses. `_redeemInto` runs the same fold on chain.
 */
export function authNonceOf(i: Intent, chainId?: ChainId): Hex {
  return i.authNonce === ZERO_HASH ? intentHashOf(i, chainId) : i.authNonce
}

/** A stable id for an intent. Two board posts of the same intent share it. */
export function intentKey(s: SignedIntent): string {
  return `${s.maker.toLowerCase()}:${s.nonce}:${s.signature.slice(0, 18)}`
}

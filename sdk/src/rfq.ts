import {
  bytesToHex,
  hashTypedData,
  hexToBytes,
  recoverMessageAddress,
  recoverTypedDataAddress,
  stringToBytes,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem'
import type { MsgBoardClient, Content, RPCMessage } from '@msgboard/sdk'
import { board } from './board.js'
import { getChainId, RFQ_CATEGORY, type ChainId } from './config.js'
import {
  CURVE_LINEAR,
  decodeIntent,
  encodeIntent,
  intentHashOf,
  isPartial,
  verifyIntent,
  ZERO_HASH,
  type Intent,
  type SignedIntent,
} from './intent.js'
import {
  NONCE_BYTES,
  open,
  PUBLIC_KEY_BYTES,
  seal,
  TAG_BYTES,
  type Sealed,
} from './rfq-crypto.js'
import { quote, toStruct } from './settlement.js'
import { solverBorneRate } from './fee.js'
import { grindAndSubmit } from './submit.js'
import { RFQ_VENUE_ABI } from './abi.js'

/**
 * Exclusive quotes: a price named for one address, taken by that address alone.
 *
 * A maker quotes better than they will quote in public and reserves the price for one named
 * counterparty. The counterparty accepts by signing an ordinary intent — the mirror side — and
 * sends no transaction. Anybody may submit the pair to `RfqVenue`, pay the gas and keep the
 * spread.
 *
 * **This is a separate marketplace and it must stay separate.** Exclusive quotes travel under
 * `RFQ_CATEGORY`, never under the category the app's order book reads. See `RFQ_CATEGORY` in
 * `config.ts` for why.
 *
 * **The exclusivity is two signatures, not a convention.**
 *
 *  1. The quote's `Intent.executor` names the venue contract. `ProveSettlement` then refuses a
 *     fill from every other address on the chain, so the quote is unreachable in public.
 *  2. The maker signs an `Exclusive` binding under the venue's own EIP-712 domain: this intent
 *     hash, this counterparty, this size, until this moment.
 *
 * A counterparty checks both before they sign anything — `checkExclusiveQuote` is that check —
 * and can then prove for themselves that the price is theirs and what it costs. Nothing here is
 * a promise from the desk; it is all verifiable off chain and enforced on chain.
 *
 * **The exclusivity fee is an ordinary `Intent.feeRate`, and the venue no longer charges one.**
 * The binding carried its own rate once. Then the settlement grew a signed per-intent rate, and
 * an exclusive quote became a quote that charges more — the same object, priced higher. So the
 * maker sets `feeRate` and `feeTo` on the quote itself and `exclusiveQuoteCost` reads the whole
 * price. The only ceiling is arithmetic — `_termsOk` refuses a rate above one WAD, because above
 * it the fee is larger than the number it comes out of. Below that a rate nobody will pay is an
 * offer nobody fills, and the submitter's own `maxFeeRate` is what steps over one. The
 * counterparty's guarantee
 * grew rather than shrank — `ex.intentHash` commits to every term of the quote, the rate
 * included, so a rate the counterparty did not read is a binding that does not verify.
 *
 * The venue address is an argument everywhere in this module. It is not in the registry, for the
 * same reason `ProveBatchExecutor` is not: everything in a deployment is reachable from the
 * settlement, and a venue is reachable from nothing. The quote itself names it.
 */

/** `RfqVenue`'s ABI, re-exported for consumers. The compiler writes it — see `scripts/gen-abi.mjs`. */
export { RFQ_VENUE_ABI }

/**
 * The maker's promise that one price belongs to one address. `RfqVenue.Exclusive`.
 *
 * Signed apart from the intent so that `ProveSettlement.Intent` and its typehash are untouched
 * and no chain needs an upgrade to carry one of these.
 */
export type Exclusive = {
  /** The quote's EIP-712 digest, under the *settlement's* domain. `intentHashOf` builds it. */
  intentHash: Hex
  /** The only maker whose intent may take the other side. */
  counterparty: Address
  /** Exactly how much of the quote this binding releases. A binding is one-shot. */
  take: bigint
  /** When the quote stops being firm, in seconds. */
  expiry: bigint
  /** Makes two otherwise identical bindings distinct, so a maker can allow two takes. */
  nonce: bigint
}

/** A quote and everything a counterparty needs to check it: the terms, the binding, both signatures. */
export type ExclusiveQuote = {
  intent: SignedIntent
  exclusive: Exclusive
  /** The maker's signature over `exclusive`, under the venue's domain. */
  bindingSignature: Hex
}

/**
 * The category exclusive quotes travel under, ascii right-padded to 32 bytes — the same
 * convention `PROVECASH_CATEGORY` uses, so the traffic reads as `provecash-rfq` on the board view.
 */
export const PROVECASH_RFQ_CATEGORY = bytesToHex(stringToBytes(RFQ_CATEGORY), { size: 32 }) as Hex

/**
 * The venue's own EIP-712 domain. Not the settlement's.
 *
 * The chain id and the venue's address are both in here, so a binding signed for testnet, or for
 * a second venue, verifies nowhere else. That is the whole of the cross-chain replay defence and
 * it costs nothing.
 */
export const rfqDomain = (venue: Address, chainId: ChainId = getChainId()): TypedDataDomain => ({
  name: 'prove.cash rfq',
  version: '1',
  chainId,
  verifyingContract: venue,
})

/**
 * The EIP-712 struct. The field order is the contract's `EXCLUSIVE_TYPEHASH` order — change one
 * line here and every binding this package produces becomes unspendable.
 */
export const EXCLUSIVE_TYPES = {
  Exclusive: [
    { name: 'intentHash', type: 'bytes32' },
    { name: 'counterparty', type: 'address' },
    { name: 'take', type: 'uint256' },
    { name: 'expiry', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

/** The digest the maker signs — the exact value `RfqVenue.hashExclusive` returns on chain. */
export function exclusiveHashOf(ex: Exclusive, venue: Address, chainId?: ChainId): Hex {
  return hashTypedData({
    domain: rfqDomain(venue, chainId),
    types: EXCLUSIVE_TYPES,
    primaryType: 'Exclusive',
    message: ex,
  })
}

/**
 * What a wallet signs to make a quote exclusive: pass this whole object to `signTypedData`.
 *
 * Signing is the caller's, not this package's — a tab's wallet and a desk's private key are
 * theirs to hold — so this hands back the request rather than a signature.
 */
export function exclusiveSigningRequest(ex: Exclusive, venue: Address, chainId?: ChainId) {
  return {
    domain: rfqDomain(venue, chainId),
    types: EXCLUSIVE_TYPES,
    primaryType: 'Exclusive' as const,
    message: ex,
  }
}

/**
 * What taking this quote costs the submitter, and where that money goes, at time `now`.
 *
 * The counterparty reads this before they sign, and it is the whole price. Four numbers, and the
 * first is the only one the submitter parts with:
 *
 *   - `gross` — the submitter's entire outlay in token B: the curve plus any P2 fee on top.
 *   - `delivered` — what the quote's maker banks, which is the curve less any P3 fee.
 *   - `fee` — the part of the outlay the settlement books for the quote's own `feeConfig`
 *     (P2 + P3, in token B; a P1 fee is in token A and is `quote().feeIn`).
 *   - `rate` — the rate the SOLVER bears, P1 + P2, which is what `maxFeeRate` bounds.
 *
 * **Which point a quote's fee uses decides who pays for the exclusivity.** A P3 fee comes out of
 * the maker's own number, so a quote with no spread can still pay for its exclusivity and the
 * submitter's cost is unchanged. A P2 fee is on top, so the submitter brings it.
 *
 * The three amounts are the settlement's own `quote`, under the same names, so a caller who has
 * one can read the other without translating.
 */
export function exclusiveQuoteCost(
  q: ExclusiveQuote,
  now: bigint,
): { gross: bigint; delivered: bigint; rate: bigint; fee: bigint } {
  const r = quote(q.intent, q.exclusive.take, now)
  return { gross: r.gross, delivered: r.delivered, rate: solverBorneRate(q.intent), fee: r.fee }
}

/** Why a quote is not takeable. Empty means it is. */
export type QuoteFault =
  | 'bad-intent-signature'
  | 'bad-binding-signature'
  | 'not-exclusive-to-this-venue'
  | 'binding-names-another-intent'
  | 'reserved-for-somebody-else'
  | 'expired'
  | 'take-exceeds-the-quote'
  | 'partial-not-allowed'

/**
 * Everything the counterparty must check before they sign their side, in one call.
 *
 * A signature is only consent when the signer could see the terms. This is that: it proves the
 * maker really signed the quote, that the quote can only settle at this venue, that the binding
 * names this intent and this address, and that the rate the quote charges is one the settlement
 * will accept. Sign nothing that this refuses.
 *
 * It reads the rate off the quote intent, because that is where the rate lives now. The binding
 * commits to the whole intent through `intentHash`, so this checks the number the maker signed
 * and never a number somebody attached in flight. Price the quote with `exclusiveQuoteCost`: a
 * legal rate is not the same as a rate worth paying.
 *
 * @param me the address that will sign the mirror. The binding must name it.
 * @param now seconds. The binding's own expiry, not the intent's.
 */
export async function checkExclusiveQuote(
  q: ExclusiveQuote,
  venue: Address,
  me: Address,
  now: bigint,
  chainId?: ChainId,
): Promise<QuoteFault[]> {
  const faults: QuoteFault[] = []
  const { intent, exclusive: ex } = q
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

  if (!(await verifyIntent(intent, chainId))) faults.push('bad-intent-signature')
  if (!same(intent.executor, venue)) faults.push('not-exclusive-to-this-venue')
  if (!same(ex.intentHash, intentHashOf(intent, chainId))) {
    faults.push('binding-names-another-intent')
  }
  if (!same(ex.counterparty, me)) faults.push('reserved-for-somebody-else')
  if (now >= ex.expiry) faults.push('expired')
  if (ex.take > intent.amountIn) faults.push('take-exceeds-the-quote')
  else if (!isPartial(intent) && ex.take !== intent.amountIn) faults.push('partial-not-allowed')

  try {
    const signer = await recoverTypedDataAddress({
      ...exclusiveSigningRequest(ex, venue, chainId),
      signature: q.bindingSignature,
    })
    if (!same(signer, intent.maker)) faults.push('bad-binding-signature')
  } catch {
    // A contract wallet's binding recovers to nothing here. The venue still accepts it through
    // ERC-1271, so this reports what it can rather than pretending the quote is forged.
    faults.push('bad-binding-signature')
  }

  return faults
}

/**
 * The mirror intent the counterparty should sign, filled in from the quote.
 *
 * **`executor` is the venue, and that is not a detail.** A mirror with an open executor is an
 * ordinary public order at the counterparty's rate: anybody could fill it on the settlement
 * without ever showing the maker's side, and the acceptance would leak as a standing offer at a
 * price meant for one trade. The venue refuses an open mirror for that reason, and this builder
 * exists so nobody has to remember why.
 *
 * **The flags are the counterparty's, not the quote's, and they default to nothing.** All or
 * nothing means the submitter must take the whole mirror, so `sells` is what the counterparty
 * sells and not a ceiling the submitter picks under. Wallet custody rather than escrow, because
 * escrow would key a deposit to the mirror's own hash and that is a second transaction the
 * counterparty was promised they would not have to send. Copying the quote's flags would have
 * carried both choices across from a party who has no business making them.
 *
 * **The expiry is the counterparty's too, and it is short.** It used to copy the quote's, which
 * handed the maker a free option for as long as the quote lived. A signed mirror is flat priced
 * and all or nothing, so the counterparty's side of the trade is fixed the moment they sign —
 * the only thing still moving is the market. Whoever may submit last therefore holds an option
 * worth the price drift over the window, and the counterparty pays for it.
 *
 * Binding the mirror to one quote does not fix that. The holder of the option does not need a
 * different quote; they only need to wait. Shortening the window is what reduces the cost, so
 * that is what this does: {@link MIRROR_TTL} seconds by default, never past the quote's own
 * expiry. A counterparty who wants longer must ask for it and knows what they are selling.
 *
 * **The acceptance charges no rate of its own, and the zero is a choice.** The exclusivity fee
 * rides on the quote leg, where the maker signed it. A rate here takes a second cut out of the
 * one spread that already pays the quote's fee and the submitter's gas, and it pays that cut to
 * the protocol's sink, because `feeTo` on a mirror is `ZERO` — so the counterparty would raise
 * their own cost and receive nothing back. It also raises the rate the ring must be submitted
 * under, so a submitter who priced the quote would find the fill refused. Zero means "no
 * opinion" to the settlement, which then charges the owner's floor, exactly as it does for any
 * ordinary order.
 *
 * @param wants the least token A the counterparty will accept for `sells` of token B. Price it
 *        against `exclusiveQuoteCost`. The quote's own fee no longer comes out of this spread —
 *        it comes out of the quote maker's number — so what the spread has to carry is the
 *        submitter's gas and this mirror's own rate, if it signs one.
 * @param flags the counterparty's own custody and partial-fill choice. Leave it out unless you
 *        mean it.
 * @param ttl how many seconds the acceptance stays good for. Longer is a bigger free option for
 *        whoever submits. Clamped to the quote's own expiry, because a mirror that outlives its
 *        quote can only ever be paired with a different one.
 */
/**
 * How long an acceptance stays good for, in seconds.
 *
 * Ninety seconds is several PulseChain blocks, which is room for a submitter to land the
 * transaction, and short enough that the free option it grants is worth little. A desk quoting
 * into a fast market should pass less.
 */
export const MIRROR_TTL = 90n

export function mirrorFor(
  q: ExclusiveQuote,
  venue: Address,
  me: Address,
  sells: bigint,
  wants: bigint,
  nonce: bigint,
  flags = 0,
  ttl = MIRROR_TTL,
): Intent {
  const { intent } = q
  const now = BigInt(Math.floor(Date.now() / 1000))
  const start = intent.startTime > now ? intent.startTime : now
  const mine = start + ttl
  return {
    maker: me,
    recipient: me,
    tokenIn: intent.tokenOut,
    tokenOut: intent.tokenIn,
    amountIn: sells,
    minOutStart: wants,
    minOutEnd: wants,
    startTime: intent.startTime,
    endTime: mine < intent.endTime ? mine : intent.endTime,
    executor: venue,
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    // No floor. The mirror is filled once, whole, against the quote it answers, so a minimum
    // could only ever refuse the one fill it exists for.
    minFill: 0n,
    // No named 3009 nonce either. A mirror is not an offer the maker is making twice.
    authNonce: ZERO_HASH,
    flags,
    nonce,
    // The mirror stays flat, and two separate things hold it there. Its two ends are the same
    // number, so every kind prices it at that number whatever the word says; and the word is the
    // straight line anyway. A caller who passes curve kind bits in `flags` therefore changes the
    // digest and nothing else — the shape of a quote is the quote's, not the mirror's.
    curve: CURVE_LINEAR,
  }
}

/** One leg as `RfqVenue` wants it. */
const leg = (i: SignedIntent, take: bigint, arming: `0x${string}` = '0x') => ({
  intent: toStruct(i),
  signature: i.signature,
  take,
  arming,
})

/**
 * The call that settles an exclusive quote: the two legs in order, the binding, its signature.
 *
 * Leg order is not a convenience. The venue reads the first leg as the quote — the binding names
 * that intent and bounds its `take` — and the second as the counterparty's mirror.
 *
 * @param maxFeeRate the highest rate the submitter will pay on either leg, the quote's own rate
 *        included. `maxFeeRateFor([quote, mirror])` is that number, and for an exclusive quote
 *        it is the quote's own `feeRate`.
 */
export function settleExclusiveCall(
  venue: Address,
  q: ExclusiveQuote,
  mirror: SignedIntent,
  mirrorTake: bigint,
  maxFeeRate: bigint,
) {
  return {
    address: venue,
    abi: RFQ_VENUE_ABI,
    functionName: 'settleExclusive' as const,
    args: [
      [leg(q.intent, q.exclusive.take), leg(mirror, mirrorTake)],
      q.exclusive,
      q.bindingSignature,
      maxFeeRate,
    ] as const,
  }
}

// ── Wire codec ────────────────────────────────────────────────────────────────

/**
 * A quote on the wire: one version byte, the packed intent, then a fixed 157-byte tail.
 *
 * The tail is fixed width rather than varint-packed, so the decoder splits it off the end and no
 * length prefix is needed. `decodeIntent` refuses a payload it does not consume exactly, so the
 * split is unambiguous. That costs about thirty bytes of proof of work over the packing
 * `encodeIntent` uses, and buys back a class of bug: a maker's `take` or `nonce` can be any
 * uint256 the contract accepts, and no valid signature is untransportable.
 *
 * `intentHash` is not on the wire. It is derivable from the intent and the chain, so carrying it
 * would spend 32 bytes on a value that could disagree with the terms beside it.
 *
 * The tail lost two bytes when the binding lost its rate, and the version byte stayed at 1. It
 * can: a tail of the other width leaves the intent slice two bytes out, and the exact-consume
 * rule above then decodes the message to null. A quote from the old codec reads as garbage
 * rather than as a binding with terms nobody signed.
 */
const RFQ_VERSION = 1
const TAIL = 157

/**
 * The first byte names the message, and every RFQ message shares one space for it.
 *
 * Version 1 is a quote with its terms in the clear. Version 2 is the same quote sealed to its
 * counterparty. Version 3 is an address announcing the key a quote can be sealed to it. One
 * category carries all three, so one byte has to tell them apart, and each decoder below refuses
 * a first byte it does not own. A sealed quote therefore never reads as a plain one, and a plain
 * one never reads as sealed — see the note above `RFQ_VERSION` for the bug that rule was written
 * after.
 *
 * A reader built before either of these existed already drops them: `decodeExclusiveQuote` has
 * refused an unknown first byte since it was written, so nothing on the board needs a new reader
 * to keep working.
 */
const RFQ_VERSION_SEALED = 2
const RFQ_KEY_VERSION = 3

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

const uint = (b: Uint8Array): bigint => (b.length ? BigInt(bytesToHex(b)) : 0n)

/** Pack an exclusive quote into a board payload. */
export function encodeExclusiveQuote(q: ExclusiveQuote): Hex {
  const { exclusive: ex } = q
  const intent = hexToBytes(encodeIntent(q.intent))
  const out = new Uint8Array(1 + intent.length + TAIL)
  out[0] = RFQ_VERSION
  out.set(intent, 1)

  let o = 1 + intent.length
  const put = (bytes: Uint8Array) => {
    out.set(bytes, o)
    o += bytes.length
  }
  put(hexToBytes(ex.counterparty))
  put(fixed(ex.take, 32))
  put(fixed(ex.expiry, 8))
  put(fixed(ex.nonce, 32))
  put(hexToBytes(q.bindingSignature))
  return bytesToHex(out)
}

/**
 * Unpack a board payload. Null for anything that is not a well-formed exclusive quote.
 *
 * The binding's `intentHash` is rebuilt from the decoded terms, so a message whose intent was
 * altered in flight produces a hash the maker never signed and the signature check fails. Check
 * it with `checkExclusiveQuote` before you act on it — this only says the bytes parse.
 */
export function decodeExclusiveQuote(data: Hex, chainId?: ChainId): ExclusiveQuote | null {
  try {
    const b = hexToBytes(data)
    if (b.length < 1 + TAIL || b[0] !== RFQ_VERSION) return null

    const cut = b.length - TAIL
    const intent = decodeIntent(bytesToHex(b.slice(1, cut)))
    if (!intent) return null

    let o = cut
    const take = (n: number) => {
      const slice = b.slice(o, o + n)
      o += n
      return slice
    }
    const counterparty = bytesToHex(take(20)) as Address
    const amount = uint(take(32))
    const expiry = uint(take(8))
    const nonce = uint(take(32))
    const bindingSignature = bytesToHex(take(65))

    return {
      intent,
      exclusive: {
        intentHash: intentHashOf(intent, chainId),
        counterparty,
        take: amount,
        expiry,
        nonce,
      },
      bindingSignature,
    }
  } catch {
    return null
  }
}

// ── The sealed wire format ────────────────────────────────────────────────────

/**
 * A quote whose terms only its counterparty can read.
 *
 *   0        version 2
 *   1..20    the counterparty this quote is for
 *   21..52   the sender's ephemeral x25519 public key
 *   53..76   the XChaCha20 nonce
 *   77..end  the ciphertext, with Poly1305's tag on the end
 *
 * The plaintext is a whole version 1 payload, its own version byte included. So this format knows
 * nothing about a quote's fields, and `decodeSealedQuote` hands `decodeExclusiveQuote` bytes it
 * already reads. A later plain version travels sealed without a line changing here.
 *
 * The ciphertext runs to the end of the payload rather than behind a length prefix, because
 * nothing follows it. Three things make that unambiguous: the head is fixed width, Poly1305
 * refuses a ciphertext a byte out, and `decodeExclusiveQuote` then refuses a plaintext it does
 * not consume exactly, the way `decodeIntent` does.
 *
 * **What this hides, and what it does not.** It hides the terms: the size, the price, the expiry,
 * the maker's address and both signatures. It hides nothing else. The board still shows that a
 * message went out under the RFQ category, how big it is, when it was posted, and which address
 * it is for. A desk that posts every quote from one place is not hard to follow, and traffic to
 * one counterparty is visible even when the terms are not.
 *
 * **The counterparty rides in the clear on purpose.** A reader needs it to know a message is
 * theirs, and a desk needs it to recognise its own post — a sealer keeps no secret for what it
 * sealed, only the board hash. Leaving it out would have hidden the addressee too, at the price of
 * every reader trying to open every sealed message with every address they hold. The address is
 * also the HKDF salt that binds the envelope, so a copy re-headed under another name derives a
 * different key and never opens.
 *
 * Those 20 bytes are spent twice, here and inside the sealed version 1 tail. The duplicate buys
 * the one check `decodeSealedQuote` makes after it opens: a head that names one address and a
 * binding that names another is not a quote anybody signed.
 */
const SEALED_COUNTERPARTY = 1
const SEALED_EPHEMERAL = SEALED_COUNTERPARTY + 20
const SEALED_NONCE = SEALED_EPHEMERAL + PUBLIC_KEY_BYTES
const SEALED_HEAD = SEALED_NONCE + NONCE_BYTES

/** A payload that could be a sealed quote: the right first byte, and long enough to hold a tag. */
const isSealed = (b: Uint8Array) =>
  b.length >= SEALED_HEAD + TAG_BYTES && b[0] === RFQ_VERSION_SEALED

/**
 * Seal a quote to the key its counterparty announced. Post it with `postSealedRfqQuote`.
 *
 * It seals to `q.exclusive.counterparty` and to no other address, because that is the one address
 * the binding lets take the quote. Passing a key that belongs to somebody else produces a message
 * nobody can open, and nothing here can detect that — pair the key with the address it was
 * announced under, which is what `readRfqKeys` returns.
 *
 * It throws on a key of the wrong width rather than sealing to it. A quote sealed to 8 bytes of
 * somebody's mistake costs real proof of work and is unreadable for ever, and the counterparty
 * would be the one to find out.
 */
export function encodeSealedQuote(q: ExclusiveQuote, recipientPublicKey: Uint8Array): Hex {
  if (recipientPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new Error('not an x25519 public key')
  }
  const counterparty = q.exclusive.counterparty
  const plain = hexToBytes(encodeExclusiveQuote(q))
  const sealed = seal(recipientPublicKey, counterparty, plain)

  const out = new Uint8Array(SEALED_HEAD + sealed.ciphertext.length)
  out[0] = RFQ_VERSION_SEALED
  out.set(hexToBytes(counterparty), SEALED_COUNTERPARTY)
  out.set(sealed.ephemeralPublicKey, SEALED_EPHEMERAL)
  out.set(sealed.nonce, SEALED_NONCE)
  out.set(sealed.ciphertext, SEALED_HEAD)
  return bytesToHex(out)
}

/**
 * Who a sealed quote is for, without opening it. Null for anything that is not a sealed quote.
 *
 * A reader walks a board of messages it cannot read and this is how it skips them: no key, no
 * curve operation, one slice. It says who the sender addressed, and nothing about whether the
 * quote inside is real.
 */
export function sealedQuoteCounterparty(data: Hex): Address | null {
  try {
    const b = hexToBytes(data)
    if (!isSealed(b)) return null
    return bytesToHex(b.slice(SEALED_COUNTERPARTY, SEALED_EPHEMERAL)) as Address
  } catch {
    return null
  }
}

/**
 * Why a payload did not come back as a quote.
 *
 * The first one is the board being a board. The other three are faults, and a reader who knows
 * the message was addressed to them should say so rather than skip it.
 */
export type SealedQuoteFault =
  /** Not a sealed quote at all: another version byte, another category's message, or too short. */
  | 'not-a-sealed-quote'
  /** The envelope refused this key. Wrong key, wrong address, or bytes that changed in flight. */
  | 'does-not-open'
  /** It opened, and what came out is not a quote this version reads. */
  | 'not-a-quote'
  /** It opened, and the quote inside reserves itself for an address the head does not name. */
  | 'binding-names-another-address'

/** What `decodeSealedQuote` answers. The SDK's usual `{ ok }` shape, as `simulateRing` has. */
export type SealedQuoteRead =
  | { ok: true; quote: ExclusiveQuote }
  | { ok: false; reason: SealedQuoteFault }

/**
 * Open a sealed quote with the counterparty's secret key, and say why if it will not open.
 *
 * **Two of these answers are ordinary and two are alarming, so the caller gets the reason.** A
 * reader walks a public board of messages meant for other people, and `not-a-sealed-quote` is
 * nearly all of them: skip it and read the next. But a reader who checked the head with
 * `sealedQuoteCounterparty` already knows the envelope names them, and for that reader
 * `does-not-open` means their key is not the key the desk sealed to, or the bytes changed on the
 * way. Both leave a quote they cannot see and can act on. Folding the two into one null told
 * them to unlock a key they had already unlocked.
 *
 * `does-not-open` is as far as the cipher goes. Poly1305 refuses a ciphertext without saying
 * whether the key or the bytes are wrong, so neither does this. See `open`.
 *
 * `secretKey` is the half `deriveRfqKeyPair` returns and nothing stores. A quote coming back
 * means the envelope opened and the bytes parse. It does not mean the maker signed anything —
 * `checkExclusiveQuote` is what proves that, and it is what proves the quote is reserved for you.
 */
export function decodeSealedQuote(
  data: Hex,
  secretKey: Uint8Array,
  chainId?: ChainId,
): SealedQuoteRead {
  let b: Uint8Array
  try {
    b = hexToBytes(data)
  } catch {
    return { ok: false, reason: 'not-a-sealed-quote' }
  }
  if (!isSealed(b)) return { ok: false, reason: 'not-a-sealed-quote' }

  const counterparty = bytesToHex(b.slice(SEALED_COUNTERPARTY, SEALED_EPHEMERAL)) as Address
  // Every width comes off the fixed head and `isSealed` has cleared the length, so `open` never
  // throws here. A `MalformedEnvelopeError` out of this call is a bug in the layout above, not a
  // message somebody posted, and it belongs in the open rather than under a catch.
  const envelope: Sealed = {
    ephemeralPublicKey: b.slice(SEALED_EPHEMERAL, SEALED_NONCE),
    nonce: b.slice(SEALED_NONCE, SEALED_HEAD),
    ciphertext: b.slice(SEALED_HEAD),
  }
  const plain = open(secretKey, counterparty, envelope)
  if (!plain) return { ok: false, reason: 'does-not-open' }

  const q = decodeExclusiveQuote(bytesToHex(plain), chainId)
  if (!q) return { ok: false, reason: 'not-a-quote' }
  // The head routed this envelope to one address and the binding reserves the quote for
  // another. Nobody signed that, and answering with either address would tell two readers two
  // different things about who the quote is for.
  if (q.exclusive.counterparty.toLowerCase() !== counterparty.toLowerCase()) {
    return { ok: false, reason: 'binding-names-another-address' }
  }
  return { ok: true, quote: q }
}

// ── The board ─────────────────────────────────────────────────────────────────

/** Grind an exclusive quote and post it, under the RFQ category and never the app's. */
export async function postRfqQuote(
  q: ExclusiveQuote,
  client: MsgBoardClient = board(),
): Promise<Hex> {
  const { hash } = await grindAndSubmit(client, PROVECASH_RFQ_CATEGORY, encodeExclusiveQuote(q))
  return hash
}

/**
 * Seal an exclusive quote to the counterparty's key, grind it and post it.
 *
 * The same category as a plain quote, so a reader keeps one subscription and the version byte
 * sorts the traffic. It costs 93 bytes of proof of work over the plain form: 72 for the envelope,
 * 20 for the head's copy of the counterparty, one for the version byte.
 */
export async function postSealedRfqQuote(
  q: ExclusiveQuote,
  recipientPublicKey: Uint8Array,
  client: MsgBoardClient = board(),
): Promise<Hex> {
  const payload = encodeSealedQuote(q, recipientPublicKey)
  const { hash } = await grindAndSubmit(client, PROVECASH_RFQ_CATEGORY, payload)
  return hash
}

/** Every message the board currently holds in the RFQ category. */
export async function readRfqQuotes(url?: string): Promise<RPCMessage[]> {
  const content: Content = await board(url).content({ category: PROVECASH_RFQ_CATEGORY })
  return content[PROVECASH_RFQ_CATEGORY] ?? []
}

// ── Key publication ───────────────────────────────────────────────────────────

/**
 * An address announcing the x25519 key a quote can be sealed to it.
 *
 * A maker can seal nothing until the counterparty publishes, so the counterparty posts one of
 * these to the same board the quotes travel on. Anybody may post anything there, which makes
 * forgery the whole question: an announcement binding *your* address to *my* key hands me every
 * quote meant for you, and neither of us finds out.
 *
 * **So an announcement never claims an address. It proves one.** The wire carries the key, a
 * timestamp and a signature over both, and `address` comes out of `recoverMessageAddress`. There
 * is no claimed field to check the signature against, which is stronger than checking one: an
 * attacker cannot mis-state an address they are never given the chance to state. Binding their own
 * key to your address means forging an ECDSA signature under your key. A garbage signature still
 * recovers to *some* address — recovery nearly always succeeds — but never to one the attacker
 * chooses, so it announces a key for an address nobody will ever look up.
 *
 * That also means a reader must never take an address off this wire. There is none to take, which
 * is why the field is absent rather than present and dangerous: reading a claim and forgetting to
 * verify it is the one way back to the forgery.
 *
 * **The signature has to be a 65-byte ECDSA one, and that shuts out contract wallets.** Checking
 * an ERC-1271 answer needs a chain read and this package verifies an announcement offline. No
 * contract wallet can use the feature at all in any case: `deriveRfqKeyPair` needs a wallet that
 * returns the same bytes every time it signs, and an ERC-1271 answer is whatever the wallet's own
 * check accepts.
 *
 * **No chain id, on purpose.** The key derives from `RFQ_KEY_MESSAGE`, which names no chain, so
 * one wallet has one key everywhere. An announcement replayed on another chain states the same
 * true fact, and a domain would only make the counterparty sign again for nothing.
 */
export type RfqKeyAnnouncement = {
  /** Recovered from the signature. Never read off the wire, because the wire does not carry it. */
  address: Address
  /** The 32-byte x25519 public key. Pass it to `encodeSealedQuote`. */
  publicKey: Uint8Array
  /** When the announcer says they made this, in seconds. What decides between two of them. */
  issuedAt: bigint
}

/**
 * What the announcer signs, and the only string a verifier hashes.
 *
 * One builder, used by the signer and by the verifier. Two copies of this text drift a character
 * sooner or later, and the result is a valid signature that recovers to an address nobody holds.
 *
 * It is readable rather than raw bytes because a wallet shows the user this text and they are
 * attesting to it. It looks nothing like `RFQ_KEY_MESSAGE`, and that matters: that string derives
 * the secret key, this one publishes the public half, and a signature over one must never serve as
 * the other.
 */
export function rfqKeyAnnouncementMessage(publicKey: Uint8Array, issuedAt: bigint): string {
  if (publicKey.length !== PUBLIC_KEY_BYTES) throw new Error('not an x25519 public key')
  return [
    'prove.cash rfq key announcement v1',
    `key: ${bytesToHex(publicKey)}`,
    `at: ${issuedAt}`,
  ].join('\n')
}

const KEY_PUBLIC = 1
const KEY_ISSUED_AT = KEY_PUBLIC + PUBLIC_KEY_BYTES
const KEY_SIGNATURE = KEY_ISSUED_AT + 8
/** Version, key, timestamp, signature. Always exactly this, so a decoder can insist on it. */
const KEY_ANNOUNCEMENT_BYTES = KEY_SIGNATURE + 65

/**
 * Pack an announcement.
 *
 *   0        version 3
 *   1..32    the x25519 public key
 *   33..40   issuedAt, seconds
 *   41..105  the signature
 *
 * Fixed width throughout, so the decoder insists on 106 bytes rather than trusting a length
 * nobody signed. `signature` is what a wallet returns for `rfqKeyAnnouncementMessage`.
 */
export function encodeRfqKeyAnnouncement(
  publicKey: Uint8Array,
  issuedAt: bigint,
  signature: Hex,
): Hex {
  if (publicKey.length !== PUBLIC_KEY_BYTES) throw new Error('not an x25519 public key')
  const sig = hexToBytes(signature)
  if (sig.length !== 65) throw new Error('an announcement needs a 65-byte ECDSA signature')

  const out = new Uint8Array(KEY_ANNOUNCEMENT_BYTES)
  out[0] = RFQ_KEY_VERSION
  out.set(publicKey, KEY_PUBLIC)
  out.set(fixed(issuedAt, 8), KEY_ISSUED_AT)
  out.set(sig, KEY_SIGNATURE)
  return bytesToHex(out)
}

/**
 * Unpack an announcement and recover who made it. Null for anything that is not one.
 *
 * The address it returns is the address that signed, so a caller may trust it without checking
 * anything else. A signature over another key, another timestamp or another message recovers to a
 * different address and speaks for that address alone.
 *
 * Async because recovery is: viem's `recoverMessageAddress` returns a promise.
 */
export async function decodeRfqKeyAnnouncement(data: Hex): Promise<RfqKeyAnnouncement | null> {
  try {
    const b = hexToBytes(data)
    if (b.length !== KEY_ANNOUNCEMENT_BYTES || b[0] !== RFQ_KEY_VERSION) return null
    const publicKey = b.slice(KEY_PUBLIC, KEY_ISSUED_AT)
    const issuedAt = uint(b.slice(KEY_ISSUED_AT, KEY_SIGNATURE))
    const address = await recoverMessageAddress({
      message: rfqKeyAnnouncementMessage(publicKey, issuedAt),
      signature: bytesToHex(b.slice(KEY_SIGNATURE)),
    })
    return { address, publicKey, issuedAt }
  } catch {
    // Recovery throws on a signature whose numbers are out of range. That is one more way of
    // saying "not an announcement", and the caller can do nothing different about it.
    return null
  }
}

/**
 * The newest key each address announced, from a batch of board messages.
 *
 * Keyed by the lower-case address, because recovery hands back a checksummed one and every
 * comparison in this package is case-insensitive. A caller looking a counterparty up must lower
 * the address it holds.
 *
 * Newest by the announcer's own `issuedAt`, never by block. The timestamp is inside the
 * signature and the block is not, so anybody could re-post a stale announcement today and
 * displace the announcer's current key with it. An announcer can only lie about their own row,
 * since the address comes out of their own signature, so a wrong clock strands nobody else.
 *
 * Most messages in this category are quotes and decode to null here. That is expected, not an
 * error: one category carries the whole feature.
 */
export async function latestRfqKeys(
  messages: readonly RPCMessage[],
): Promise<Map<Address, RfqKeyAnnouncement>> {
  const keys = new Map<Address, RfqKeyAnnouncement>()
  for (const m of messages) {
    const a = await decodeRfqKeyAnnouncement(m.data)
    if (!a) continue
    const at = a.address.toLowerCase() as Address
    const held = keys.get(at)
    if (!held || a.issuedAt > held.issuedAt) keys.set(at, a)
  }
  return keys
}

/** The keys the board holds right now: read the RFQ category, keep the newest per address. */
export async function readRfqKeys(url?: string): Promise<Map<Address, RfqKeyAnnouncement>> {
  return latestRfqKeys(await readRfqQuotes(url))
}

/** Grind a key announcement and post it, under the RFQ category and never the app's. */
export async function postRfqKey(
  publicKey: Uint8Array,
  issuedAt: bigint,
  signature: Hex,
  client: MsgBoardClient = board(),
): Promise<Hex> {
  const payload = encodeRfqKeyAnnouncement(publicKey, issuedAt, signature)
  const { hash } = await grindAndSubmit(client, PROVECASH_RFQ_CATEGORY, payload)
  return hash
}

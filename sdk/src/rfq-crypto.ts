import { hkdf } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha2'
import { x25519 } from '@noble/curves/ed25519.js'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hexToBytes, type Address, type Hex } from 'viem'

/**
 * An encryption key a browser wallet can actually use.
 *
 * An exclusive quote names one counterparty and travels over a public board, so anybody reading
 * the board sees terms meant for one desk's client. Encrypting them looks like a solved problem
 * and is not, for a reason that is easy to miss: **the obvious design cannot be decrypted.**
 *
 * The obvious design recovers the counterparty's secp256k1 public key from a signature they have
 * already made — an address is a hash of a key, but a signature gives the key back — and does
 * ECDH against it. Encrypting works. Decrypting needs their *private* key, and a browser wallet
 * will not hand that over and will not do ECDH on their behalf. `eth_decrypt` was the one route
 * and MetaMask deprecated it, hid it, and currently ships it broken. There is no replacement RPC.
 * So a quote encrypted that way is readable only by a counterparty who runs a bot with a raw key
 * in memory, and the counterparty this feature is for signs an intent in a browser.
 *
 * That is also why no production RFQ protocol does this. Surveyed 2026-09-01: CoW, UniswapX,
 * 1inch Fusion, 0x, Hashflow and the rest all keep quotes private by not publishing them, and
 * none encrypts to a named counterparty. We are the odd one out only because the board is our
 * transport and there is no private endpoint to fall back on.
 *
 * **So the key is derived, not recovered.** The counterparty signs one fixed string with the
 * wallet they already have; that signature seeds an x25519 keypair. The secret half never leaves
 * the browser and is never stored — it is re-derived by signing again. The public half goes on
 * the board, and anybody can encrypt to it.
 *
 * Two costs, both real:
 *
 *  - The counterparty must sign once before their first encrypted quote. That is onboarding
 *    friction, and it is exactly why the field routes around encryption. Tolerable for a narrow
 *    feature between parties who already know each other; not tolerable for strangers.
 *  - Determinism is convention, not specification. Ethereum wallets sign with RFC 6979
 *    deterministic nonces in practice, so the same wallet returns the same 65 bytes forever. A
 *    wallet that ever randomised would strand that user's key. XMTP shipped this pattern and
 *    later moved off it for that reason.
 *
 * A derived x25519 key also sidesteps the key-separation question entirely: this is a fresh key
 * for one purpose, not the signing key doing a second job.
 */

/**
 * The string the counterparty signs. Never change it — it IS the key.
 *
 * A new string is a new keypair, so every quote already sealed to the old one becomes
 * unreadable. Version it in the name and derive both if this ever has to move.
 */
export const RFQ_KEY_MESSAGE = 'prove.cash rfq key v1'

/** Domain separation for the two HKDF calls below, so neither can produce the other's bytes. */
const KEY_INFO = new TextEncoder().encode('prove.cash/rfq/x25519/v1')
const SEAL_INFO = new TextEncoder().encode('prove.cash/rfq/seal/v1')

/**
 * x25519 public keys are 32 bytes, XChaCha20 nonces 24, the Poly1305 tag 16.
 *
 * All three are exported because a wire codec has to lay an envelope out and split it again. Two
 * copies of the number 24 in two files is how a codec drifts a byte from the crypto it carries.
 */
export const PUBLIC_KEY_BYTES = 32
export const NONCE_BYTES = 24
/** The least a ciphertext can be: the tag, with nothing under it. */
export const TAG_BYTES = 16

export type RfqKeyPair = {
  /** Never persist this and never leave it in a log. Re-derive it from the signature instead. */
  secretKey: Uint8Array
  publicKey: Uint8Array
}

/**
 * The keypair a signature over `RFQ_KEY_MESSAGE` produces.
 *
 * The signature goes through HKDF rather than into the curve raw. A signature is not uniform —
 * it is `r ‖ s ‖ v` with structure in every part — and x25519 wants 32 bytes of key material,
 * not 65 bytes of encoded numbers.
 */
export function deriveRfqKeyPair(signature: Hex): RfqKeyPair {
  const secretKey = hkdf(sha256, hexToBytes(signature), undefined, KEY_INFO, 32)
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) }
}

/** What travels beside the ciphertext. 72 bytes in total. */
export type Sealed = {
  /** The sender's throwaway public key. A fresh one per quote, so two quotes share no secret. */
  ephemeralPublicKey: Uint8Array
  nonce: Uint8Array
  ciphertext: Uint8Array
}

/**
 * The shared secret, bound to the counterparty this quote is for.
 *
 * The address goes into the HKDF as salt, so a sealed envelope lifted from one quote and
 * replayed under another counterparty's name derives a different key and fails to open. It costs
 * nothing and it removes a whole class of cut-and-paste.
 */
function sharedKey(secretKey: Uint8Array, publicKey: Uint8Array, counterparty: Address): Uint8Array {
  const shared = x25519.getSharedSecret(secretKey, publicKey)
  return hkdf(sha256, shared, hexToBytes(counterparty), SEAL_INFO, 32)
}

/**
 * Encrypt `plaintext` so that only the holder of `recipientPublicKey` can read it.
 *
 * `randomBytes` comes from the curve library rather than from `crypto` directly, because this
 * module runs in a browser, in Node and in a Worker, and that is the one call that differs.
 */
export function seal(
  recipientPublicKey: Uint8Array,
  counterparty: Address,
  plaintext: Uint8Array,
): Sealed {
  const ephemeralSecret = x25519.utils.randomSecretKey()
  const key = sharedKey(ephemeralSecret, recipientPublicKey, counterparty)
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  return {
    ephemeralPublicKey: x25519.getPublicKey(ephemeralSecret),
    nonce,
    ciphertext: xchacha20poly1305(key, nonce).encrypt(plaintext),
  }
}

/**
 * Why an envelope is not an envelope.
 *
 * Each of these is a width the wire format fixes, so no message off the board reaches one:
 * `decodeSealedQuote` cuts its three fields at fixed offsets and refuses a payload too short to
 * hold them. A caller who builds a `Sealed` by hand is the only one who can, and that caller has
 * a bug rather than a bad message.
 */
export type EnvelopeFault = 'not-an-x25519-key' | 'not-a-nonce' | 'shorter-than-the-tag'

/**
 * Thrown by `open` for an envelope that no key could ever open.
 *
 * It names the field, so a caller reads which width is wrong instead of suspecting their key.
 */
export class MalformedEnvelopeError extends Error {
  /**
   * Which width is wrong. Declared and assigned rather than taken as a parameter property: this
   * package compiles under `erasableSyntaxOnly`, which bans the shorthand because it emits code
   * instead of erasing.
   */
  readonly reason: EnvelopeFault

  constructor(reason: EnvelopeFault) {
    super(`This is not a sealed envelope: ${reason}`)
    this.name = 'MalformedEnvelopeError'
    this.reason = reason
  }
}

/**
 * The plaintext, or null when the envelope does not open under this key.
 *
 * **Null means one thing: Poly1305 refused the ciphertext.** Three mistakes reach that one
 * answer — the wrong secret key, the wrong counterparty, or bytes that changed in flight — and
 * the tag cannot tell them apart. That is what an AEAD tag is. It says "these are not the bytes
 * this key authenticates" and says nothing else. Anything more would be a guess, and a guess
 * about why a decryption failed is a side channel.
 *
 * **A malformed envelope throws, because that one this function can tell apart.** An ephemeral
 * key that is not 32 bytes, a nonce that is not 24, a ciphertext with no room for the tag: no key
 * opens any of those, so null would point a reader at their key when the envelope is the problem.
 * `encodeSealedQuote` already throws on the matching mistake at the sealing end.
 *
 * A reader walking a public board still meets null constantly, and still skips. A reader who
 * knows the envelope is addressed to them reads the same null as a fault — see
 * `decodeSealedQuote`, which carries the reason up to them.
 */
export function open(secretKey: Uint8Array, counterparty: Address, sealed: Sealed): Uint8Array | null {
  if (sealed.ephemeralPublicKey.length !== PUBLIC_KEY_BYTES) {
    throw new MalformedEnvelopeError('not-an-x25519-key')
  }
  if (sealed.nonce.length !== NONCE_BYTES) throw new MalformedEnvelopeError('not-a-nonce')
  if (sealed.ciphertext.length < TAG_BYTES) {
    throw new MalformedEnvelopeError('shorter-than-the-tag')
  }
  try {
    // The curve call is inside the catch on purpose. A sender can post a 32-byte ephemeral key
    // that is not a usable point, and x25519 throws on the all-zero shared secret it derives.
    // That is a message a board really carries, so it answers null like any other envelope that
    // will not open.
    const key = sharedKey(secretKey, sealed.ephemeralPublicKey, counterparty)
    return xchacha20poly1305(key, sealed.nonce).decrypt(sealed.ciphertext)
  } catch {
    return null
  }
}

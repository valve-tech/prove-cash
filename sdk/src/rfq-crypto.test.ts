import { describe, expect, test } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { bytesToHex, hexToBytes, type Address } from 'viem'
import {
  deriveRfqKeyPair,
  MalformedEnvelopeError,
  NONCE_BYTES,
  open,
  PUBLIC_KEY_BYTES,
  RFQ_KEY_MESSAGE,
  seal,
  TAG_BYTES,
  type EnvelopeFault,
  type Sealed,
} from './rfq-crypto.js'

/**
 * The two properties this module has to hold, and one it must not accidentally break.
 *
 * It has to be **deterministic** — the counterparty re-derives the same key every time they sign,
 * because nothing stores the secret half. And it has to be **bound to the counterparty**, so an
 * envelope lifted off the board and republished under another name does not open.
 *
 * The one to be careful of is the first. If derivation ever stops being a pure function of the
 * signature, every quote already sealed to a published key becomes unreadable and nobody finds
 * out until a counterparty cannot read theirs.
 */

// Two throwaway accounts. Never a funded key — see the repo's rules on that.
const ALICE = privateKeyToAccount(`0x${'11'.repeat(32)}`)
const BOB = privateKeyToAccount(`0x${'22'.repeat(32)}`)

const sign = (account: typeof ALICE) => account.signMessage({ message: RFQ_KEY_MESSAGE })

const TERMS = new TextEncoder().encode(
  JSON.stringify({ take: '25000000000', minOut: '1042000000000000000', expiry: 1830297600 }),
)

describe('a key derived from a wallet signature', () => {
  test('the string the key derives from is this one, and it never changes', () => {
    // The string IS the key. Edit it and every quote already sealed to the old key is unreadable,
    // with nobody finding out until a counterparty cannot read theirs. Version the name and derive
    // both if it ever has to move; do not make this line pass by pasting the new string in.
    expect(RFQ_KEY_MESSAGE).toBe('prove.cash rfq key v1')
  })

  test('the same signature always gives the same key', async () => {
    const signature = await sign(ALICE)
    const first = deriveRfqKeyPair(signature)
    const second = deriveRfqKeyPair(signature)
    expect(second.publicKey).toEqual(first.publicKey)
    expect(second.secretKey).toEqual(first.secretKey)
  })

  test('signing the message twice gives the same signature, which is what makes this work', async () => {
    // RFC 6979. Not guaranteed by the spec, which is why it is asserted here rather than assumed:
    // a wallet that randomised its nonce would strand every key derived from it.
    expect(await sign(ALICE)).toBe(await sign(ALICE))
  })

  test('two counterparties get different keys', async () => {
    const a = deriveRfqKeyPair(await sign(ALICE))
    const b = deriveRfqKeyPair(await sign(BOB))
    expect(a.publicKey).not.toEqual(b.publicKey)
  })

  test('the public half is a 32-byte x25519 key', async () => {
    const { publicKey } = deriveRfqKeyPair(await sign(ALICE))
    expect(publicKey).toHaveLength(PUBLIC_KEY_BYTES)
  })
})

describe('sealing terms to one counterparty', () => {
  test('the counterparty reads what the desk wrote', async () => {
    const bob = deriveRfqKeyPair(await sign(BOB))
    const sealed = seal(bob.publicKey, BOB.address, TERMS)
    expect(open(bob.secretKey, BOB.address, sealed)).toEqual(TERMS)
  })

  test('nobody else does', async () => {
    const bob = deriveRfqKeyPair(await sign(BOB))
    const alice = deriveRfqKeyPair(await sign(ALICE))
    const sealed = seal(bob.publicKey, BOB.address, TERMS)
    expect(open(alice.secretKey, BOB.address, sealed)).toBeNull()
  })

  test('the envelope is bound to the address it names', async () => {
    // Lift a sealed quote off the board and republish it as though it were for somebody else.
    // The address is HKDF salt, so the derived key differs and the tag fails.
    const bob = deriveRfqKeyPair(await sign(BOB))
    const sealed = seal(bob.publicKey, BOB.address, TERMS)
    expect(open(bob.secretKey, ALICE.address, sealed)).toBeNull()
  })

  test('two seals of the same terms share nothing on the wire', async () => {
    const bob = deriveRfqKeyPair(await sign(BOB))
    const one = seal(bob.publicKey, BOB.address, TERMS)
    const two = seal(bob.publicKey, BOB.address, TERMS)
    // A fresh ephemeral key per quote, so a reader cannot even tell the terms repeat.
    expect(one.ephemeralPublicKey).not.toEqual(two.ephemeralPublicKey)
    expect(one.ciphertext).not.toEqual(two.ciphertext)
    expect(open(bob.secretKey, BOB.address, two)).toEqual(TERMS)
  })

  test('a flipped bit does not open', async () => {
    const bob = deriveRfqKeyPair(await sign(BOB))
    const sealed = seal(bob.publicKey, BOB.address, TERMS)
    sealed.ciphertext[0] ^= 1
    expect(open(bob.secretKey, BOB.address, sealed)).toBeNull()
  })

  test("a changed byte and somebody else's envelope give the same answer", async () => {
    // Both are null, and that is the design rather than an oversight. Poly1305 refuses a
    // ciphertext without saying whether the key or the bytes are wrong, so neither does `open`.
    // The distinction a reader needs — is this one addressed to me? — comes off the head that
    // `decodeSealedQuote` reads in the clear, never out of the cipher.
    const bob = deriveRfqKeyPair(await sign(BOB))
    const alice = deriveRfqKeyPair(await sign(ALICE))
    const forBob = seal(bob.publicKey, BOB.address, TERMS)
    const tampered = seal(bob.publicKey, BOB.address, TERMS)
    tampered.ciphertext[0] ^= 1
    expect(open(alice.secretKey, BOB.address, forBob)).toBeNull()
    expect(open(bob.secretKey, BOB.address, tampered)).toBeNull()
  })

  test('an envelope of the wrong widths throws, and names the width', async () => {
    // No key opens any of these, so null would send the reader to check their key while the
    // envelope is what is wrong. Nothing off the board reaches this: `decodeSealedQuote` cuts
    // three fixed fields out of a head it has already measured.
    const bob = deriveRfqKeyPair(await sign(BOB))
    const good = seal(bob.publicKey, BOB.address, TERMS)
    const faultOf = (s: Sealed): EnvelopeFault | null => {
      try {
        open(bob.secretKey, BOB.address, s)
        return null
      } catch (e) {
        expect(e).toBeInstanceOf(MalformedEnvelopeError)
        return (e as MalformedEnvelopeError).reason
      }
    }
    expect(faultOf({ ...good, ephemeralPublicKey: new Uint8Array(8) })).toBe('not-an-x25519-key')
    expect(faultOf({ ...good, nonce: new Uint8Array(8) })).toBe('not-a-nonce')
    expect(faultOf({ ...good, ciphertext: new Uint8Array(TAG_BYTES - 1) })).toBe(
      'shorter-than-the-tag',
    )
    expect(faultOf(good)).toBeNull()
  })

  test('a tag with nothing under it is a shape, and it still does not open', async () => {
    // The shortest legal envelope: right widths, a ciphertext that is all tag. It is not
    // malformed, so it answers null like any other envelope that will not open.
    const bob = deriveRfqKeyPair(await sign(BOB))
    const empty: Sealed = {
      ephemeralPublicKey: bob.publicKey,
      nonce: new Uint8Array(NONCE_BYTES),
      ciphertext: new Uint8Array(TAG_BYTES),
    }
    expect(open(bob.secretKey, BOB.address, empty)).toBeNull()
  })

  test('an ephemeral key that is not a point answers null, because a board carries those', async () => {
    // Thirty-two bytes, so the widths are right and nothing throws. x25519 refuses the all-zero
    // shared secret it derives, and that refusal is a message somebody posted rather than a
    // caller's bug — so it comes back as an envelope that will not open.
    const bob = deriveRfqKeyPair(await sign(BOB))
    const sealed = seal(bob.publicKey, BOB.address, TERMS)
    expect(
      open(bob.secretKey, BOB.address, {
        ...sealed,
        ephemeralPublicKey: new Uint8Array(PUBLIC_KEY_BYTES),
      }),
    ).toBeNull()
  })

  test('the whole envelope costs 72 bytes over the plaintext', async () => {
    const bob = deriveRfqKeyPair(await sign(BOB))
    const s = seal(bob.publicKey, BOB.address, TERMS)
    const overhead =
      s.ephemeralPublicKey.length + s.nonce.length + (s.ciphertext.length - TERMS.length)
    expect(overhead).toBe(72)
  })

  test('an address of a different case is the same address', async () => {
    // Board messages carry lower-case addresses; a caller may hold a checksummed one.
    const bob = deriveRfqKeyPair(await sign(BOB))
    const sealed = seal(bob.publicKey, BOB.address.toLowerCase() as Address, TERMS)
    expect(open(bob.secretKey, BOB.address.toLowerCase() as Address, sealed)).toEqual(TERMS)
  })
})

/**
 * A frozen envelope, and the key that opens it.
 *
 * Every other test above seals and opens in one process, against whichever library version is
 * installed. That shape cannot catch a change to the bytes on the wire: it encrypts and decrypts
 * with the same new code and agrees with itself, green either way. But a quote sealed last week
 * sits on a public board right now, and the counterparty has to be able to read it tomorrow.
 *
 * So these two vectors were captured from a real `seal()` on 2026-09-15, under @noble/ciphers
 * 1.3.0, and written down. They are the only thing here that fails when the construction moves —
 * the x25519 exchange, the HKDF, the XChaCha20-Poly1305 layout, or the counterparty binding.
 *
 * If a dependency bump turns these red, every envelope already published is unreadable. Do not
 * repair the test by pasting the new bytes in. Find out what moved, and decide whether the board
 * can survive it.
 */
describe('bytes sealed by an earlier release', () => {
  // The address is HKDF salt, so the vector is bound to this counterparty and no other.
  const SEALED_FOR_BOB: Sealed = {
    ephemeralPublicKey: hexToBytes(
      '0xf8966a8ce3b9ae526becd397fe0dc341edcaa382b7d1804b2fce8214fcad0d04',
    ),
    nonce: hexToBytes('0xa411b496e95b809e6044845982a05bc359edd8e41b0dfee5'),
    ciphertext: hexToBytes(
      '0xc842fcde6fbcedfb5582b8b74b11f585f6384b560ac3b80c1ed867e954ec76ab3526680265843deee817f510d72b0ecfc64bd7111f80f0ccc5d3d7f7e16d2f971a23731d44e564afc4f8cf89a593dcbff0fe9c22ccbe88c22b',
    ),
  }

  test("the counterparty's key still derives to the same 32 bytes", async () => {
    // Checked separately from the envelope so that a failure names which half moved. This one
    // covers the signature, the HKDF and x25519. The next covers the cipher.
    const bob = deriveRfqKeyPair(await sign(BOB))
    expect(bytesToHex(bob.publicKey)).toBe(
      '0x6d5c16124337e65f9dd2a0905f39d613e43b45b2c5f21ef598c2c0d1f387280a',
    )
  })

  test('an envelope sealed before the upgrade still opens', async () => {
    const bob = deriveRfqKeyPair(await sign(BOB))
    expect(open(bob.secretKey, BOB.address, SEALED_FOR_BOB)).toEqual(TERMS)
  })
})

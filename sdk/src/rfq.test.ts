import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  bytesToHex,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  parseAbiParameters,
  stringToBytes,
  stringToHex,
  concatHex,
  type Address,
  type Hex,
} from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import fixture from '../../app/src/lib/__fixtures__/eip712.json' with { type: 'json' }
import { setSettlementOverride } from './config.js'
import { PROVECASH_CATEGORY } from './board.js'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  ZERO,
  ZERO_HASH,
  intentHashOf,
  type Intent,
  type SignedIntent,
} from './intent.js'
import {
  EXCLUSIVE_TYPES,
  PROVECASH_RFQ_CATEGORY,
  checkExclusiveQuote,
  decodeExclusiveQuote,
  decodeRfqKeyAnnouncement,
  decodeSealedQuote,
  encodeExclusiveQuote,
  encodeRfqKeyAnnouncement,
  encodeSealedQuote,
  exclusiveHashOf,
  exclusiveQuoteCost,
  exclusiveSigningRequest,
  latestRfqKeys,
  MIRROR_TTL,
  mirrorFor,
  rfqDomain,
  rfqKeyAnnouncementMessage,
  sealedQuoteCounterparty,
  settleExclusiveCall,
  type Exclusive,
  type ExclusiveQuote,
  type SealedQuoteRead,
} from './rfq.js'
import {
  deriveRfqKeyPair,
  RFQ_KEY_MESSAGE,
  seal,
  type RfqKeyPair,
  type Sealed,
} from './rfq-crypto.js'
import { hashFeeConfig, singleFeeConfig } from './feeconfig.js'
import { signIntent as signIntentWith } from './intent.js'

/**
 * An exclusive quote is two signatures over two domains, and either one wrong makes the quote
 * unspendable while every type checker on both sides stays green. So these tests do three jobs:
 * they pin the venue's EIP-712 encoding to a hand-rolled hash that does not go through viem's
 * typed-data helper, they prove the wire codec is lossless, and they prove the counterparty's
 * pre-signature check names every way a quote can be wrong.
 */

const SETTLEMENT: Address = '0x1111111111111111111111111111111111111111'
const VENUE: Address = '0x2222222222222222222222222222222222222222'
const OTHER_VENUE: Address = '0x3333333333333333333333333333333333333333'
const TOKEN_A: Address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B: Address = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
/** Where a quote's fee goes. The intent names a config of it, and it is the only place a fee can reach. */
const QUOTE_FEE_TO: Address = '0xfee1fee1fee1fee1fee1fee1fee1fee1fee1fee1'
const QUOTE_CONFIG_PREIMAGE = singleFeeConfig(QUOTE_FEE_TO)
const QUOTE_CONFIG = hashFeeConfig(QUOTE_CONFIG_PREIMAGE)
/** The fee the quote's own take costs at P3, the point that comes out of the maker's number. */
const feeOn = (gross: bigint, i: Intent): bigint => (i.feeConfig === ZERO_HASH ? 0n : (gross * i.feeRateProceeds) / 10n ** 18n)

const CHAIN = 369
const NOW = 1_800_000_000n

const maker = privateKeyToAccount(generatePrivateKey())
const taker = privateKeyToAccount(generatePrivateKey())
const stranger = privateKeyToAccount(generatePrivateKey())

beforeAll(() => setSettlementOverride(CHAIN, SETTLEMENT))
afterAll(() => setSettlementOverride(CHAIN, null))

/**
 * The rfq keypairs, derived the way a browser derives one: sign the fixed string, keep nothing.
 *
 * Derivation is a signature away, so these could be built inside each test. They are hoisted
 * because every sealed test needs the same one, and a keypair that differed between two tests
 * would make a failure look like a crypto bug rather than a fixture.
 */
let takerKey!: RfqKeyPair
let strangerKey!: RfqKeyPair
beforeAll(async () => {
  takerKey = deriveRfqKeyPair(await taker.signMessage({ message: RFQ_KEY_MESSAGE }))
  strangerKey = deriveRfqKeyPair(await stranger.signMessage({ message: RFQ_KEY_MESSAGE }))
})

function quoteTerms(over: Partial<Intent> = {}): Intent {
  return {
    maker: maker.address,
    recipient: maker.address,
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
    amountIn: 1_000n * 10n ** 18n,
    minOutStart: 100n * 10n ** 18n,
    minOutEnd: 100n * 10n ** 18n,
    startTime: NOW,
    endTime: NOW + 600n,
    executor: VENUE,
    // The exclusivity fee lives here now, not on the binding: the destination the maker names,
    // and fifty basis points of the delivery to send there.
    feeConfig: QUOTE_CONFIG,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 5000000000000000n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: FLAG_PARTIAL,
    nonce: 1n,
    curve: CURVE_LINEAR,
    ...over,
  }
}

async function signIntent(i: Intent): Promise<SignedIntent> {
  const signature = await signIntentWith(maker, i, {
    preimage: i.feeConfig === QUOTE_CONFIG ? QUOTE_CONFIG_PREIMAGE : undefined,
    domain: { name: 'prove.cash', version: '1', chainId: CHAIN, verifyingContract: SETTLEMENT },
    account: maker,
  })
  return { ...i, signature }
}

function binding(intent: Intent, over: Partial<Exclusive> = {}): Exclusive {
  return {
    intentHash: intentHashOf(intent, CHAIN),
    counterparty: taker.address,
    take: intent.amountIn,
    expiry: NOW + 30n,
    nonce: 1n,
    ...over,
  }
}

async function makeQuote(
  intentOver: Partial<Intent> = {},
  bindingOver: Partial<Exclusive> = {},
  signer = maker,
  venue: Address = VENUE,
): Promise<ExclusiveQuote> {
  const terms = quoteTerms(intentOver)
  const intent = await signIntent(terms)
  const exclusive = binding(terms, bindingOver)
  const bindingSignature = await signer.signTypedData(
    exclusiveSigningRequest(exclusive, venue, CHAIN),
  )
  return { intent, exclusive, bindingSignature }
}

/**
 * What `contracts/test/Fixture.t.sol` wrote from the venue itself.
 *
 * The hand-rolled test below hashes a string this file types out, and `rfq.ts` hashes a field
 * list it types out. Two copies of one mistake agree with each other, so between them they
 * pinned nothing to the contract: rename a member of `Exclusive` in Solidity and both stay green
 * while the chain rejects every binding this package signs. These four values come off the
 * deployed venue.
 */
const F = fixture as unknown as {
  chainId: 369
  digest: Hex
  rfq: {
    verifyingContract: Address
    typehash: Hex
    domainSeparator: Hex
    digest: Hex
    intentHash: Hex
    counterparty: Address
    take: string
    expiry: string
    nonce: string
  }
}

describe('the binding, against the Solidity fixture', () => {
  const fixtureExclusive: Exclusive = {
    intentHash: F.rfq.intentHash,
    counterparty: F.rfq.counterparty,
    take: BigInt(F.rfq.take),
    expiry: BigInt(F.rfq.expiry),
    nonce: BigInt(F.rfq.nonce),
  }

  test('the typehash matches, so no field was renamed, reordered or rewidened', () => {
    // Built from the shipped `EXCLUSIVE_TYPES`, not typed out again. A third hand-written copy
    // of the string would agree with the other two and say nothing.
    const encodeType = `Exclusive(${EXCLUSIVE_TYPES.Exclusive.map((f) => `${f.type} ${f.name}`).join(',')})`
    expect(keccak256(stringToHex(encodeType))).toBe(F.rfq.typehash)
  })

  test('the domain separator matches, so a binding verifies at the venue it names', () => {
    // Assembled from what `rfqDomain` returns. The name is the part that drifts: the venue's is
    // `prove.cash rfq` and the settlement's is `prove.cash`, and a binding signed under the wrong
    // one is a valid signature over the wrong message.
    const d = rfqDomain(F.rfq.verifyingContract, F.chainId)
    const separator = keccak256(
      encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'), [
        keccak256(
          stringToHex(
            'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
          ),
        ),
        keccak256(stringToHex(String(d.name))),
        keccak256(stringToHex(String(d.version))),
        BigInt(F.chainId),
        F.rfq.verifyingContract,
      ]),
    )
    expect(separator).toBe(F.rfq.domainSeparator)
  })

  test('exclusiveHashOf reproduces the digest the venue returned', () => {
    // The one that matters. It folds in the typehash, the domain and every field's encoding, and
    // it goes through the function the app calls rather than a hash assembled here.
    expect(exclusiveHashOf(fixtureExclusive, F.rfq.verifyingContract, F.chainId)).toBe(F.rfq.digest)
  })

  test('the binding names the fixture intent, so the two domains are pinned to each other', () => {
    // `intent.test.ts` pins `F.digest` to `intentHashOf`. A client that hashes an intent wrongly
    // therefore cannot reach this binding's digest either, which is the whole failure an
    // exclusive quote has: two signatures, two domains, and either one wrong makes it unspendable.
    expect(F.rfq.intentHash).toBe(F.digest)
  })
})

describe('the venue domain', () => {
  test('is not the settlement domain', () => {
    expect(rfqDomain(VENUE, CHAIN)).toEqual({
      name: 'prove.cash rfq',
      version: '1',
      chainId: CHAIN,
      verifyingContract: VENUE,
    })
  })

  /**
   * The digest, built without `hashTypedData`.
   *
   * `EXCLUSIVE_TYPES` is an array of field names and viem turns it into a typehash. Spelling
   * the string out here and hashing it by hand catches a reordered field, a renamed one and a
   * changed width — without forge, so it fails in the SDK suite where the change was made. The
   * fixture block above is what binds either of them to the contract.
   */
  test('hashes exactly what the contract hashes', () => {
    const typehash = keccak256(
      stringToHex(
        'Exclusive(bytes32 intentHash,address counterparty,uint256 take,uint64 expiry,uint256 nonce)',
      ),
    )
    const domainTypehash = keccak256(
      stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
    )
    const domainSeparator = keccak256(
      encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'), [
        domainTypehash,
        keccak256(stringToHex('prove.cash rfq')),
        keccak256(stringToHex('1')),
        BigInt(CHAIN),
        VENUE,
      ]),
    )

    const ex: Exclusive = {
      intentHash: `0x${'11'.repeat(32)}` as Hex,
      counterparty: taker.address,
      take: 123_456n,
      expiry: 1_800_000_030n,
      nonce: 7n,
    }
    const structHash = keccak256(
      encodeAbiParameters(
        parseAbiParameters('bytes32, bytes32, address, uint256, uint64, uint256'),
        [typehash, ex.intentHash, ex.counterparty, ex.take, ex.expiry, ex.nonce],
      ),
    )
    const byHand = keccak256(concatHex(['0x1901', domainSeparator, structHash]))

    expect(exclusiveHashOf(ex, VENUE, CHAIN)).toBe(byHand)
  })

  test('every field is in the typed data, in the contract order', () => {
    expect(EXCLUSIVE_TYPES.Exclusive.map((f) => f.name)).toEqual([
      'intentHash',
      'counterparty',
      'take',
      'expiry',
      'nonce',
    ])
  })

  test('a binding signed for one venue hashes to nothing at another', () => {
    const ex = binding(quoteTerms())
    expect(exclusiveHashOf(ex, VENUE, CHAIN)).not.toBe(exclusiveHashOf(ex, OTHER_VENUE, CHAIN))
  })
})

describe('the category', () => {
  /**
   * The app renders whatever it finds under `PROVECASH_CATEGORY`. An exclusive quote is not part
   * of the public book, so it must never land there — a quote nobody but its counterparty can
   * take would show in the order book as an offer that always fails.
   */
  test('is not the one the app reads', () => {
    expect(PROVECASH_RFQ_CATEGORY).not.toBe(PROVECASH_CATEGORY)
  })

  test('is ascii, right-padded, so the board view reads it', () => {
    const bytes = stringToBytes('provecash-rfq')
    expect(PROVECASH_RFQ_CATEGORY.startsWith(`0x${Buffer.from(bytes).toString('hex')}`)).toBe(true)
    expect(PROVECASH_RFQ_CATEGORY).toHaveLength(66)
  })
})

describe('the price of the exclusivity', () => {
  /**
   * The venue charged this fee once and the binding named the rate. The rate is a term of the
   * quote now, so the same arithmetic runs on `Intent.feeRate` through the settlement's own
   * `feeOn`, and the fee comes out of the quote rather than riding on top of it.
   */
  test('rounds down, so the dust stays with the maker', () => {
    const q = quoteTerms({ feeRateProceeds: 5000000000000000n })
    expect(feeOn(0n, q)).toBe(0n)
    expect(feeOn(100n * 10n ** 18n, q)).toBe(5n * 10n ** 17n)
    // 1 wei at 50bps is 0.005 wei. The destination used to take the whole wei, because the
    // submitter brought it. It comes out of the maker's own number now, so the maker keeps it.
    expect(feeOn(1n, q)).toBe(0n)
    // A fee appears the moment the product reaches a whole wei, and never a wei before. At ten
    // basis points that is a thousand wei exactly, and 999 pays nothing.
    expect(feeOn(999n, quoteTerms({ feeRateProceeds: 1000000000000000n }))).toBe(0n)
    expect(feeOn(1_000n, quoteTerms({ feeRateProceeds: 1000000000000000n }))).toBe(1n)
  })

  /**
   * A quote that names no destination charges nothing, whatever rate it signed. There is nowhere
   * for the fee to go: the settlement holds no address of its own and earns nothing from a fill.
   */
  test('a quote that names nowhere costs nothing', async () => {
    const free = quoteTerms({ feeRateProceeds: 5000000000000000n, feeConfig: ZERO_HASH })
    expect(feeOn(100n * 10n ** 18n, free)).toBe(0n)

    const q = await makeQuote({ feeRateProceeds: 5000000000000000n, feeConfig: ZERO_HASH })
    expect(exclusiveQuoteCost(q, NOW).rate).toBe(0n)
    expect(exclusiveQuoteCost(q, NOW).fee).toBe(0n)
  })

  test('is visible before anybody signs, and the fee is inside the price', async () => {
    const q = await makeQuote()
    const { gross, delivered, rate, fee } = exclusiveQuoteCost(q, NOW)
    // The submitter's outlay, unchanged by the split: it is the quote's own signed number.
    expect(gross).toBe(100n * 10n ** 18n)
    // P3 comes out of the quote's own number, so the submitter bears no rate at all.
    expect(rate).toBe(0n)
    expect(fee).toBe(5n * 10n ** 17n)
    // And the maker banks the rest of it, rather than all of it.
    expect(delivered).toBe(gross - fee)
    expect(delivered).toBeLessThan(gross)
  })

  /**
   * The economics of the venue, changed by the split and worth an assertion of its own.
   *
   * The fee used to come out of the counterparty's spread, so a quote priced at par could not pay
   * for its own exclusivity — `RfqVenue` had nothing to take the fee from. It comes out of the
   * maker's number now, so the same quote pays for it and the submitter's outlay does not move.
   */
  test('a quote with no spread at all can now pay for its own exclusivity', async () => {
    const free = exclusiveQuoteCost(await makeQuote({ feeRate: 0n }), NOW)
    const charged = exclusiveQuoteCost(await makeQuote(), NOW)
    expect(charged.gross).toBe(free.gross)
    expect(charged.fee).toBeGreaterThan(0n)
    expect(charged.delivered).toBe(charged.gross - charged.fee)
  })

  /**
   * The counterparty's guarantee, now that the rate rides on the quote. `intentHash` covers
   * every term of the intent, so a maker who reprices the exclusivity signs a quote that the
   * binding does not name — and the maker's own intent signature stops verifying as well. The
   * rate a counterparty read is the rate that settles, or nothing settles.
   */
  test('a repriced quote is a quote the binding does not name', async () => {
    const q = await makeQuote()
    const repriced: ExclusiveQuote = { ...q, intent: { ...q.intent, feeRate: 9000000000000000n } }
    const faults = await checkExclusiveQuote(repriced, VENUE, taker.address, NOW, CHAIN)

    expect(faults).toContain('binding-names-another-intent')
    expect(faults).toContain('bad-intent-signature')
  })
})

describe('the counterparty check', () => {
  test('passes a good quote', async () => {
    const q = await makeQuote()
    expect(await checkExclusiveQuote(q, VENUE, taker.address, NOW, CHAIN)).toEqual([])
  })

  test('refuses a quote reserved for somebody else', async () => {
    const q = await makeQuote()
    const faults = await checkExclusiveQuote(q, VENUE, stranger.address, NOW, CHAIN)
    expect(faults).toContain('reserved-for-somebody-else')
  })

  /**
   * The check that carries the whole design. A quote whose `executor` is open is an ordinary
   * public order: anybody can fill it on the settlement, and the binding guards nothing.
   */
  test('refuses a quote that is not addressed to the venue', async () => {
    const q = await makeQuote({ executor: ZERO })
    const faults = await checkExclusiveQuote(q, VENUE, taker.address, NOW, CHAIN)
    expect(faults).toContain('not-exclusive-to-this-venue')
  })

  test('refuses a binding somebody else signed', async () => {
    const q = await makeQuote({}, {}, stranger)
    const faults = await checkExclusiveQuote(q, VENUE, taker.address, NOW, CHAIN)
    expect(faults).toContain('bad-binding-signature')
  })

  test('refuses a binding signed for another venue', async () => {
    const q = await makeQuote({}, {}, maker, OTHER_VENUE)
    const faults = await checkExclusiveQuote(q, VENUE, taker.address, NOW, CHAIN)
    expect(faults).toContain('bad-binding-signature')
  })

  test('refuses a binding that names another intent', async () => {
    const q = await makeQuote({}, { intentHash: `0x${'22'.repeat(32)}` as Hex })
    const faults = await checkExclusiveQuote(q, VENUE, taker.address, NOW, CHAIN)
    expect(faults).toContain('binding-names-another-intent')
    // The hash is signed, so changing it also breaks nothing else. It is one fault, not two.
    expect(faults).not.toContain('bad-intent-signature')
  })

  test('refuses an expired binding', async () => {
    const q = await makeQuote()
    const faults = await checkExclusiveQuote(q, VENUE, taker.address, q.exclusive.expiry, CHAIN)
    expect(faults).toContain('expired')
  })

  test('refuses a take larger than the quote', async () => {
    const q = await makeQuote({}, { take: 2_000n * 10n ** 18n })
    const faults = await checkExclusiveQuote(q, VENUE, taker.address, NOW, CHAIN)
    expect(faults).toContain('take-exceeds-the-quote')
  })

  test('refuses a part take of an all-or-nothing quote', async () => {
    const q = await makeQuote({ flags: 0 }, { take: 500n * 10n ** 18n })
    const faults = await checkExclusiveQuote(q, VENUE, taker.address, NOW, CHAIN)
    expect(faults).toContain('partial-not-allowed')
  })

  /**
   * No rate is a fault. The settlement caps none, so a check that refused one here would refuse
   * a quote the chain would settle — and the submitter's own `maxFeeRate` is what declines a rate
   * they will not pay.
   */
  test('passes a quote at any rate its type can hold', async () => {
    const q = await makeQuote({ feeRate: (1n << 64n) - 1n })
    expect(await checkExclusiveQuote(q, VENUE, taker.address, NOW, CHAIN)).toEqual([])
  })

  test('refuses a tampered intent', async () => {
    const q = await makeQuote()
    const tampered: ExclusiveQuote = {
      ...q,
      intent: { ...q.intent, minOutStart: 1n, minOutEnd: 1n },
    }
    const faults = await checkExclusiveQuote(tampered, VENUE, taker.address, NOW, CHAIN)
    expect(faults).toContain('bad-intent-signature')
  })
})

describe('the mirror', () => {
  /**
   * The mirror is flat priced and all or nothing, so the counterparty's side of the trade is
   * fixed the moment they sign. Everything still moving is the market, and whoever submits last
   * holds an option worth the price drift over the window. This builder used to copy the quote's
   * expiry, which sold that option for nothing and for as long as the quote lived.
   *
   * Binding the mirror to one quote does not fix it. The holder of the option does not need a
   * different quote; they only need to wait.
   */
  test('gives the acceptance its own short expiry, not the quote\'s', async () => {
    const q = await makeQuote()
    const m = mirrorFor(q, VENUE, taker.address, 110n * 10n ** 18n, 900n * 10n ** 18n, 2n)

    expect(m.endTime).toBeLessThan(q.intent.endTime)
    expect(m.endTime - m.startTime).toBeLessThanOrEqual(MIRROR_TTL)
  })

  test('never lets the acceptance outlive its quote', async () => {
    const q = await makeQuote()
    // A mirror that outlives its quote can only ever be paired with a different one.
    const brief = { ...q, intent: { ...q.intent, endTime: q.intent.startTime + 5n } }
    const m = mirrorFor(brief, VENUE, taker.address, 110n * 10n ** 18n, 900n * 10n ** 18n, 2n)

    expect(m.endTime).toBe(brief.intent.endTime)
  })

  test('lets a counterparty ask for longer, knowing what it sells', async () => {
    const q = await makeQuote()
    const m = mirrorFor(q, VENUE, taker.address, 110n * 10n ** 18n, 900n * 10n ** 18n, 2n, 0, 5n)

    expect(m.endTime - m.startTime).toBe(5n)
  })

  /**
   * A mirror with an open executor is a public order at the counterparty's rate. This builder
   * exists so nobody has to remember that: it always names the venue.
   */
  test('names the venue and crosses the tokens', async () => {
    const q = await makeQuote()
    const m = mirrorFor(q, VENUE, taker.address, 110n * 10n ** 18n, 900n * 10n ** 18n, 2n)

    expect(m.executor).toBe(VENUE)
    expect(m.maker).toBe(taker.address)
    expect(m.tokenIn).toBe(q.intent.tokenOut)
    expect(m.tokenOut).toBe(q.intent.tokenIn)
    expect(m.amountIn).toBe(110n * 10n ** 18n)
    expect(m.minOutStart).toBe(900n * 10n ** 18n)
    expect(m.minOutEnd).toBe(900n * 10n ** 18n)
  })

  /**
   * The exclusivity fee rides on the quote leg. A rate on the acceptance takes a second cut out
   * of the same spread, pays it to the protocol sink, and raises the rate the ring must be
   * submitted under. Zero tells the settlement to charge the owner's floor and nothing more.
   */
  test('charges no rate of its own', async () => {
    const q = await makeQuote({ feeRateProceeds: 9000000000000000n })
    const m = mirrorFor(q, VENUE, taker.address, 110n * 10n ** 18n, 900n * 10n ** 18n, 2n)

    expect(m.feeRate).toBe(0n)
    expect(m.feeConfig).toBe(ZERO_HASH)
  })

  /**
   * The counterparty's custody and size are their own choice, so the builder does not copy the
   * quote's. All or nothing means the submitter takes the whole mirror and cannot pick a smaller
   * slice under it; wallet custody means the counterparty still sends no transaction.
   */
  test('does not inherit the quote flags', async () => {
    const q = await makeQuote({ flags: FLAG_PARTIAL })
    const m = mirrorFor(q, VENUE, taker.address, 110n * 10n ** 18n, 900n * 10n ** 18n, 2n)
    expect(m.flags).toBe(0)

    const partial = mirrorFor(
      q,
      VENUE,
      taker.address,
      110n * 10n ** 18n,
      900n * 10n ** 18n,
      2n,
      FLAG_PARTIAL,
    )
    expect(partial.flags).toBe(FLAG_PARTIAL)
  })
})

describe('the call', () => {
  test('puts the quote first and the mirror second', async () => {
    const q = await makeQuote()
    const mirrorTerms = mirrorFor(q, VENUE, taker.address, 110n * 10n ** 18n, 900n * 10n ** 18n, 2n)
    const mirror: SignedIntent = { ...mirrorTerms, signature: `0x${'ab'.repeat(65)}` as Hex }

    const call = settleExclusiveCall(VENUE, q, mirror, 110n * 10n ** 18n, 10n)

    expect(call.address).toBe(VENUE)
    expect(call.functionName).toBe('settleExclusive')
    const [legs, ex, sig, maxFeeRate] = call.args
    expect(legs).toHaveLength(2)
    expect(legs[0].intent.maker).toBe(maker.address)
    expect(legs[0].take).toBe(q.exclusive.take)
    expect(legs[1].intent.maker).toBe(taker.address)
    expect(legs[1].intent.executor).toBe(VENUE)
    expect(ex).toEqual(q.exclusive)
    expect(sig).toBe(q.bindingSignature)
    expect(maxFeeRate).toBe(10n)
  })
})

describe('the wire codec', () => {
  /**
   * Addresses come off the wire as twenty raw bytes, so they arrive lowercase rather than
   * checksummed. That is the codec working: EIP-55 casing is a display convention and the chain
   * does not carry it. Every comparison in this package is already case-insensitive.
   */
  const lower = <T extends Record<string, unknown>>(o: T): T =>
    Object.fromEntries(
      Object.entries(o).map(([k, v]) => [
        k,
        typeof v === 'string' && v.startsWith('0x') ? v.toLowerCase() : v,
      ]),
    ) as T

  test('round-trips a quote', async () => {
    const q = await makeQuote()
    const back = decodeExclusiveQuote(encodeExclusiveQuote(q), CHAIN)

    expect(back).not.toBeNull()
    expect(back!.intent).toEqual(lower(q.intent))
    expect(back!.exclusive).toEqual(lower(q.exclusive))
    expect(back!.bindingSignature).toBe(q.bindingSignature.toLowerCase())
  })

  test('round-trips the widest values a maker can sign', async () => {
    const big = (1n << 255n) + 7n
    const q = await makeQuote({}, { take: 1n, nonce: big })
    const back = decodeExclusiveQuote(encodeExclusiveQuote(q), CHAIN)
    expect(back!.exclusive.nonce).toBe(big)
  })

  test('a decoded quote still passes the counterparty check', async () => {
    const q = await makeQuote()
    const back = decodeExclusiveQuote(encodeExclusiveQuote(q), CHAIN)!
    expect(await checkExclusiveQuote(back, VENUE, taker.address, NOW, CHAIN)).toEqual([])
  })

  test('refuses anything that is not one', () => {
    expect(decodeExclusiveQuote('0x', CHAIN)).toBeNull()
    expect(decodeExclusiveQuote(`0x${'00'.repeat(400)}`, CHAIN)).toBeNull()
  })

  /**
   * The tail lost the binding's two rate bytes and the version byte stayed at 1. It can: the
   * intent slice then comes out two bytes wrong, `decodeIntent` refuses a payload it does not
   * consume exactly, and the message decodes to null. A quote from the old codec must read as
   * garbage rather than as a binding with terms nobody signed.
   */
  test('refuses a payload with the old wider tail', async () => {
    const q = await makeQuote()
    const wire = encodeExclusiveQuote(q)
    // Put the two rate bytes back where they used to sit, between `take` and `expiry`.
    const cut = wire.length - (8 + 32 + 65) * 2
    const old = concatHex([wire.slice(0, cut) as Hex, '0x0032', `0x${wire.slice(cut)}` as Hex])

    expect(old.length).toBe(wire.length + 4)
    expect(decodeExclusiveQuote(old, CHAIN)).toBeNull()
  })

  test('refuses a truncated payload', async () => {
    const q = await makeQuote()
    const full = encodeExclusiveQuote(q)
    expect(decodeExclusiveQuote(full.slice(0, full.length - 4) as Hex, CHAIN)).toBeNull()
  })
})

describe('version 1 on the wire, frozen', () => {
  /**
   * The bytes the shipped codec produces for one quote, pinned.
   *
   * The board already holds version 1 posts and readers already parse them, so a change to this
   * packing changes what a reader recovers from a message somebody signed weeks ago. Making this
   * test pass by pasting in the new bytes is the mistake it exists to catch: give the new packing
   * the next version byte instead, and leave 1 meaning what it has always meant.
   *
   * **The intent inside moved, and the envelope did not.** The exclusive quote is still version 1
   * and still packs the same fields in the same order. The intent it carries is a version 5 post
   * now (a 32-byte fee config hash and the P1/P3 extension), and a reader that knows only an
   * older intent version drops the whole quote rather than misreading it — which is the
   * behaviour the version byte exists for.
   *
   * Split at the field boundaries so a failure names the field that moved.
   */
  const PINNED_V1 = concatHex([
    '0x01', // the exclusive quote's version byte
    '0x05', // the intent codec's own version
    '0x01', // KIND_INTENT: no authorization, no permit
    '0x01', // flags: FLAG_PARTIAL
    '0x86', // presence: executor, feeConfig, curve-less, P1/P3 extension
    '0x00000000000000000000000000000000000000a1', // maker
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', // tokenIn
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', // tokenOut
    '0x2222222222222222222222222222222222222222', // executor: the venue
    '0xe735cb6ce63f5f4f1a6011900268f3ed18cd81d75050c713080d01f890f5eab7', // feeConfig: the hash of one destination
    '0x02', // the fee extension: only P3 follows
    '0x0011c37937e08000', // feeRateProceeds (P3), eight bytes
    '0x093635c9adc5dea00000', // amountIn, a varint
    '0x09056bc75e2d63100000', // minOutStart
    '0x0904e1003b28d9280000', // minOutEnd
    '0x006b49d200', // startTime, five bytes
    '0x00000258', // endTime less startTime, four bytes
    '0x0107', // nonce, a varint
    '0x0041', // the maker's signature is 65 bytes long
    `0x${'ab'.repeat(65)}`,
    '0x00000000000000000000000000000000000000b2', // the binding's counterparty
    '0x00000000000000000000000000000000000000000000000d8d726b7177a80000', // take
    '0x000000006b49d21e', // expiry
    '0x0000000000000000000000000000000000000000000000000000000000000003', // the binding's nonce
    `0x${'cd'.repeat(65)}`,
  ])

  const PINNED_MAKER: Address = '0x00000000000000000000000000000000000000a1'
  const PINNED_TAKER: Address = '0x00000000000000000000000000000000000000b2'

  /** Fixed terms and hand-written signatures, so the bytes do not move between runs. */
  const pinnedQuote = (): ExclusiveQuote => {
    const intent: SignedIntent = {
      maker: PINNED_MAKER,
      recipient: PINNED_MAKER,
      tokenIn: TOKEN_A,
      tokenOut: TOKEN_B,
      amountIn: 1_000n * 10n ** 18n,
      minOutStart: 100n * 10n ** 18n,
      minOutEnd: 90n * 10n ** 18n,
      startTime: NOW,
      endTime: NOW + 600n,
      executor: VENUE,
      feeConfig: QUOTE_CONFIG,
      feeRate: 0n,
      feeRateIn: 0n,
      feeRateProceeds: 5_000_000_000_000_000n,
      minFill: 0n,
      authNonce: ZERO_HASH,
      flags: FLAG_PARTIAL,
      nonce: 7n,
      curve: CURVE_LINEAR,
      signature: `0x${'ab'.repeat(65)}`,
    }
    return {
      intent,
      exclusive: {
        intentHash: intentHashOf(intent, CHAIN),
        counterparty: PINNED_TAKER,
        take: 250n * 10n ** 18n,
        expiry: NOW + 30n,
        nonce: 3n,
      },
      bindingSignature: `0x${'cd'.repeat(65)}`,
    }
  }


  test('packs to the bytes it has always packed to', () => {
    expect(encodeExclusiveQuote(pinnedQuote())).toBe(PINNED_V1)
  })

  test('reads the frozen bytes back as the quote that made them', () => {
    const q = pinnedQuote()
    const back = decodeExclusiveQuote(PINNED_V1, CHAIN)
    expect(back).not.toBeNull()
    expect(back!.intent).toEqual(q.intent)
    expect(back!.exclusive).toEqual(q.exclusive)
    expect(back!.bindingSignature).toBe(q.bindingSignature)
  })

  test('is 391 bytes, and the tail is the last 157 of them', () => {
    // The width is the whole of the sealed and plain forms telling each other apart, and the
    // decoder splits the intent off by counting back 157 from the end.
    expect((PINNED_V1.length - 2) / 2).toBe(391)
  })
})

/**
 * The quote out of a read that worked, and a failure that names its reason.
 *
 * The tests below that expect a refusal spell the whole `{ ok: false, reason }` out, because the
 * reason is the thing under test. This is for the ones that expect a quote.
 */
const opened = (read: SealedQuoteRead): ExclusiveQuote => {
  if (!read.ok) throw new Error(`the sealed quote did not open: ${read.reason}`)
  return read.quote
}

describe('the sealed wire format', () => {
  /** The layout `encodeSealedQuote` writes, typed out so a test can build a bad one by hand. */
  const sealedPayload = (head: Address, s: Sealed): Hex =>
    concatHex([
      '0x02',
      head,
      bytesToHex(s.ephemeralPublicKey),
      bytesToHex(s.nonce),
      bytesToHex(s.ciphertext),
    ])

  test('the counterparty reads the quote the desk sealed for them', async () => {
    const q = await makeQuote()
    const wire = encodeSealedQuote(q, takerKey.publicKey)
    expect(decodeSealedQuote(wire, takerKey.secretKey, CHAIN)).toEqual({
      ok: true,
      quote: decodeExclusiveQuote(encodeExclusiveQuote(q), CHAIN),
    })
  })

  test('a decoded sealed quote still passes the counterparty check', async () => {
    const q = await makeQuote()
    const wire = encodeSealedQuote(q, takerKey.publicKey)
    const back = opened(decodeSealedQuote(wire, takerKey.secretKey, CHAIN))
    expect(await checkExclusiveQuote(back, VENUE, taker.address, NOW, CHAIN)).toEqual([])
  })

  test('none of the terms is on the wire', async () => {
    // The point of the whole feature. The maker's address and both signatures are the parts a
    // reader could act on, and none of them survives into the payload.
    const q = await makeQuote()
    const wire = encodeSealedQuote(q, takerKey.publicKey).toLowerCase()
    expect(wire).not.toContain(maker.address.slice(2).toLowerCase())
    expect(wire).not.toContain(q.intent.signature.slice(2).toLowerCase())
    expect(wire).not.toContain(q.bindingSignature.slice(2).toLowerCase())
  })

  test('the counterparty is on the wire, and a reader needs no key to see it', async () => {
    const q = await makeQuote()
    expect(sealedQuoteCounterparty(encodeSealedQuote(q, takerKey.publicKey))).toBe(
      taker.address.toLowerCase(),
    )
  })

  test('sealing costs 93 bytes over the plain quote', async () => {
    // 20 for the head's copy of the counterparty, 72 for the envelope, one for the version byte.
    const q = await makeQuote()
    const plain = encodeExclusiveQuote(q).length
    expect((encodeSealedQuote(q, takerKey.publicKey).length - plain) / 2).toBe(93)
  })

  test('nobody else opens it', async () => {
    const q = await makeQuote()
    const wire = encodeSealedQuote(q, takerKey.publicKey)
    expect(decodeSealedQuote(wire, strangerKey.secretKey, CHAIN)).toEqual({
      ok: false,
      reason: 'does-not-open',
    })
  })

  test('a tampered ciphertext does not open, and says so the same way', async () => {
    // The same reason the stranger's key gets, and that is the honest answer. Poly1305 refuses
    // both without saying which is which, so this says no more than the cipher knows. What tells
    // a reader the message was meant for them is the head, which `sealedQuoteCounterparty` reads
    // with no key at all.
    const q = await makeQuote()
    const b = hexToBytes(encodeSealedQuote(q, takerKey.publicKey))
    b[b.length - 1] ^= 1
    expect(decodeSealedQuote(bytesToHex(b), takerKey.secretKey, CHAIN)).toEqual({
      ok: false,
      reason: 'does-not-open',
    })
    expect(sealedQuoteCounterparty(bytesToHex(b))).toBe(taker.address.toLowerCase())
  })

  test('an envelope re-headed to another address does not open', async () => {
    // Lift a sealed quote off the board and republish it as though it were for somebody else.
    // The head is the HKDF salt, so the rewrite derives a different key and the tag fails.
    const q = await makeQuote()
    const b = hexToBytes(encodeSealedQuote(q, takerKey.publicKey))
    b.set(hexToBytes(stranger.address), 1)
    expect(decodeSealedQuote(bytesToHex(b), takerKey.secretKey, CHAIN)).toEqual({
      ok: false,
      reason: 'does-not-open',
    })
  })

  test('a head and a binding that name different addresses is null', async () => {
    // A desk sealing one client's quote to another client. The envelope opens — it was sealed to
    // this key under this address — and the binding inside reserves the quote for somebody else.
    // Handing it back would tell the reader to sign a mirror the venue will refuse.
    const forStranger = await makeQuote({}, { counterparty: stranger.address })
    const envelope = seal(
      takerKey.publicKey,
      taker.address,
      hexToBytes(encodeExclusiveQuote(forStranger)),
    )
    expect(
      decodeSealedQuote(sealedPayload(taker.address, envelope), takerKey.secretKey, CHAIN),
    ).toEqual({ ok: false, reason: 'binding-names-another-address' })
  })

  test('a sealed payload that is not a quote says that, and not that the key is wrong', async () => {
    // The envelope opens: this key and this head are the ones the desk sealed to. What comes out
    // is not a quote. The reader learns the desk sent nonsense, rather than going away to check
    // a key that turns out to be right.
    const envelope = seal(takerKey.publicKey, taker.address, stringToBytes('not a quote'))
    expect(
      decodeSealedQuote(sealedPayload(taker.address, envelope), takerKey.secretKey, CHAIN),
    ).toEqual({ ok: false, reason: 'not-a-quote' })
  })

  test('a sealed quote is not a version 1 quote, and a version 1 quote is not sealed', async () => {
    // The version byte, doing its one job. Either decoder reading the other's payload would
    // produce terms nobody signed out of bytes that happen to be the right length.
    const q = await makeQuote()
    const sealedWire = encodeSealedQuote(q, takerKey.publicKey)
    const plainWire = encodeExclusiveQuote(q)
    expect(decodeExclusiveQuote(sealedWire, CHAIN)).toBeNull()
    expect(decodeSealedQuote(plainWire, takerKey.secretKey, CHAIN)).toEqual({
      ok: false,
      reason: 'not-a-sealed-quote',
    })
    expect(sealedQuoteCounterparty(plainWire)).toBeNull()
  })

  test('refuses anything too short to be an envelope', async () => {
    // Neither of these is a sealed quote at all, and that is the ordinary answer on a public
    // board: skip it and read the next message.
    const short = { ok: false, reason: 'not-a-sealed-quote' }
    expect(decodeSealedQuote('0x', takerKey.secretKey, CHAIN)).toEqual(short)
    expect(decodeSealedQuote(`0x${'02'.repeat(80)}`, takerKey.secretKey, CHAIN)).toEqual(short)
  })

  test('an envelope with its last bytes cut off is a fault, not one more stranger message', async () => {
    // Two bytes short of what the desk posted. It is still long enough to be an envelope, so the
    // read gets as far as the tag and the tag refuses. The two answers differ, and they have to:
    // the message above was never for this reader, and this one was.
    const q = await makeQuote()
    const wire = encodeSealedQuote(q, takerKey.publicKey)
    expect(
      decodeSealedQuote(wire.slice(0, wire.length - 4) as Hex, takerKey.secretKey, CHAIN),
    ).toEqual({ ok: false, reason: 'does-not-open' })
  })

  test('refuses to seal to something that is not an x25519 key', async () => {
    // A quote sealed to eight bytes of somebody's mistake costs real proof of work and can never
    // be read. Throwing puts the failure on the desk that has the key wrong.
    const q = await makeQuote()
    expect(() => encodeSealedQuote(q, new Uint8Array(8))).toThrow()
  })
})

describe('the key announcement', () => {
  const AT = 1_800_000_100n

  const announce = async (account: typeof taker, key: RfqKeyPair, at = AT): Promise<Hex> => {
    const signature = await account.signMessage({
      message: rfqKeyAnnouncementMessage(key.publicKey, at),
    })
    return encodeRfqKeyAnnouncement(key.publicKey, at, signature)
  }

  const message = (data: Hex) => ({ data }) as RPCMessage

  test('recovers the address that signed it, and the key they published', async () => {
    const a = (await decodeRfqKeyAnnouncement(await announce(taker, takerKey)))!
    expect(a.address.toLowerCase()).toBe(taker.address.toLowerCase())
    expect(a.publicKey).toEqual(takerKey.publicKey)
    expect(a.issuedAt).toBe(AT)
  })

  test('is always 106 bytes', async () => {
    const wire = await announce(taker, takerKey)
    expect((wire.length - 2) / 2).toBe(106)
  })

  test('a swapped key no longer speaks for the signer', async () => {
    // The forgery this format exists to stop: bind my key to your address and every quote meant
    // for you comes to me. The signature covers the key, so the swap does not fail — it moves the
    // whole announcement to an address the attacker cannot choose, which is stronger. It stays a
    // well-formed announcement, for a stranger.
    const b = hexToBytes(await announce(taker, takerKey))
    b.set(strangerKey.publicKey, 1)
    const a = await decodeRfqKeyAnnouncement(bytesToHex(b))
    expect(a).not.toBeNull()
    expect(a!.address.toLowerCase()).not.toBe(taker.address.toLowerCase())
  })

  test('a swapped timestamp no longer speaks for the signer', async () => {
    // Without this the newest-wins rule would be forgeable: re-date somebody's announcement and
    // it outranks their own.
    const b = hexToBytes(await announce(taker, takerKey))
    b.set(hexToBytes('0x00000000ffffffff'), 33)
    const a = await decodeRfqKeyAnnouncement(bytesToHex(b))
    expect(a).not.toBeNull()
    expect(a!.address.toLowerCase()).not.toBe(taker.address.toLowerCase())
  })

  test('a signature the announcer made over something else announces nothing for them', async () => {
    // A signature is public. Lifting one the counterparty made for another purpose must not
    // publish a key in their name.
    const elsewhere = await taker.signMessage({ message: 'gm' })
    const a = await decodeRfqKeyAnnouncement(
      encodeRfqKeyAnnouncement(strangerKey.publicKey, AT, elsewhere),
    )
    expect(a).not.toBeNull()
    expect(a!.address.toLowerCase()).not.toBe(taker.address.toLowerCase())
  })

  test('invented signature bytes name an address nobody will ever look up', async () => {
    // Recovery succeeds on almost any numbers in range, so this is what a made-up announcement
    // does: it credits a key to an address chosen by arithmetic, not by the attacker.
    const a = await decodeRfqKeyAnnouncement(
      encodeRfqKeyAnnouncement(strangerKey.publicKey, AT, `0x${'7b'.repeat(64)}1b`),
    )
    expect(a).not.toBeNull()
    expect(a!.address.toLowerCase()).not.toBe(taker.address.toLowerCase())
    expect(a!.address.toLowerCase()).not.toBe(stranger.address.toLowerCase())
  })

  test('an unsigned announcement is null', async () => {
    // Sixty-five zero bytes is the other outcome: `r` and `s` are out of range, recovery throws,
    // and the announcement decodes to null rather than to anybody.
    const wire = encodeRfqKeyAnnouncement(takerKey.publicKey, AT, `0x${'00'.repeat(65)}`)
    expect(await decodeRfqKeyAnnouncement(wire)).toBeNull()
  })

  test('refuses a payload that is not exactly 106 bytes', async () => {
    const wire = await announce(taker, takerKey)
    expect(await decodeRfqKeyAnnouncement(wire.slice(0, wire.length - 2) as Hex)).toBeNull()
    expect(await decodeRfqKeyAnnouncement(concatHex([wire, '0x00']))).toBeNull()
  })

  test('refuses a first byte that belongs to another message', async () => {
    const b = hexToBytes(await announce(taker, takerKey))
    b[0] = 1
    expect(await decodeRfqKeyAnnouncement(bytesToHex(b))).toBeNull()
  })

  test('a quote is not an announcement, and an announcement is not a quote', async () => {
    const q = await makeQuote()
    const wire = await announce(taker, takerKey)
    expect(await decodeRfqKeyAnnouncement(encodeExclusiveQuote(q))).toBeNull()
    expect(await decodeRfqKeyAnnouncement(encodeSealedQuote(q, takerKey.publicKey))).toBeNull()
    expect(decodeExclusiveQuote(wire, CHAIN)).toBeNull()
    expect(decodeSealedQuote(wire, takerKey.secretKey, CHAIN)).toEqual({
      ok: false,
      reason: 'not-a-sealed-quote',
    })
  })

  test('refuses to pack a signature a wallet contract would return', async () => {
    // An ERC-1271 answer is any length and needs a chain read to check. This package verifies an
    // announcement offline, so it refuses one it could never verify rather than posting it.
    expect(() =>
      encodeRfqKeyAnnouncement(takerKey.publicKey, AT, `0x${'ab'.repeat(200)}`),
    ).toThrow()
  })

  test('the board keeps the newest key an address announced', async () => {
    const older = await announce(taker, strangerKey, AT - 60n)
    const newer = await announce(taker, takerKey, AT)
    // The stale one read last, which is what a replay looks like: the timestamp is signed and the
    // block is not, so re-posting an old announcement must not displace the current key.
    const keys = await latestRfqKeys([message(newer), message(older)])
    expect(keys.get(taker.address.toLowerCase() as Address)?.publicKey).toEqual(takerKey.publicKey)
  })

  test('a forged announcement cannot displace a real one', async () => {
    // The attacker takes the counterparty's announcement, swaps their own key in, and re-posts it
    // later. It recovers to some other address, so the counterparty's row never moves.
    const real = await announce(taker, takerKey)
    const forged = hexToBytes(real)
    forged.set(strangerKey.publicKey, 1)

    const keys = await latestRfqKeys([message(real), message(bytesToHex(forged))])
    expect(keys.get(taker.address.toLowerCase() as Address)?.publicKey).toEqual(takerKey.publicKey)
  })

  test('quotes in the same category are skipped, not counted', async () => {
    const q = await makeQuote()
    const keys = await latestRfqKeys([
      message(encodeExclusiveQuote(q)),
      message(encodeSealedQuote(q, takerKey.publicKey)),
      message(await announce(taker, takerKey)),
    ])
    expect(keys.size).toBe(1)
  })

  test('a maker seals to the key the board published, and only that counterparty opens it', async () => {
    // The whole path: the counterparty announces, the maker reads the board, seals to what they
    // read, and the counterparty gets terms nobody else on the board can price.
    const keys = await latestRfqKeys([message(await announce(taker, takerKey))])
    const published = keys.get(taker.address.toLowerCase() as Address)!

    const q = await makeQuote()
    const wire = encodeSealedQuote(q, published.publicKey)

    const back = opened(decodeSealedQuote(wire, takerKey.secretKey, CHAIN))
    expect(back.exclusive.take).toBe(q.exclusive.take)
    expect(decodeSealedQuote(wire, strangerKey.secretKey, CHAIN)).toEqual({
      ok: false,
      reason: 'does-not-open',
    })
  })
})

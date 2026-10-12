import { beforeEach, describe, expect, test, vi } from 'vitest'
import { bytesToHex, hexToBytes, type Address, type Hex } from 'viem'
import type { RPCMessage } from '@msgboard/sdk'
import {
  CURVE_LINEAR,
  DEFAULT_CHAIN,
  FLAG_PARTIAL,
  ZERO,
  ZERO_HASH,
  decodeExclusiveQuote,
  defaultFees,
  deriveRfqKeyPair,
  encodeExclusiveQuote,
  encodeIntent,
  forgetWireFeeConfigs,
  hashFeeConfig,
  singleFeeConfig,
  wireFeeConfig,
  encodeSealedQuote,
  intentHashOf,
  latestRfqKeys,
  readRfqQuotes,
  setSettlementOverride,
  type Exclusive,
  type ExclusiveQuote,
  type QuoteFault,
  type SignedIntent,
} from '@prove.cash/sdk'
import { quotesFor, quotesFrom, readRfqBoard, type ReadQuote } from './board'

/**
 * The board itself is the SDK's and stays the SDK's. Only the two reads that fetch are replaced,
 * so the walk below runs the real codecs, the real cipher and the real key derivation over
 * messages this file wrote.
 */
vi.mock('@prove.cash/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@prove.cash/sdk')>()),
  readRfqQuotes: vi.fn(),
  latestRfqKeys: vi.fn(),
}))
import { forTheBoard } from '../lib/fee'
import { FAULT_KEY, RFQ_WINDOWS } from './quote'
import { decodeTicket, encodeTicket } from './ticket'
import { rfqVenue } from './venue'

/**
 * The three things in these surfaces that are logic rather than markup.
 *
 * Everything else an exclusive quote does is the SDK's — the codecs, the check, the mirror, the
 * settlement call. What the app added is a venue address the registry does not carry, a clipboard
 * envelope for a signed pair, and the fold from a board read to "quotes named for me". Those are
 * what can be wrong here, so those are what is tested.
 */

const MAKER = '0x1111111111111111111111111111111111111111' as Address
const TAKER = '0x2222222222222222222222222222222222222222' as Address
const TOKEN_A = '0x3333333333333333333333333333333333333333' as Address
const TOKEN_B = '0x4444444444444444444444444444444444444444' as Address
const VENUE = '0x5555555555555555555555555555555555555555' as Address

function intent(over: Partial<SignedIntent> = {}): SignedIntent {
  return {
    maker: MAKER,
    recipient: MAKER,
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
    amountIn: 1_000_000n,
    minOutStart: 2_000_000_000_000_000_000n,
    minOutEnd: 2_000_000_000_000_000_000n,
    curve: CURVE_LINEAR,
    startTime: 1_800_000_000n,
    endTime: 1_800_000_600n,
    executor: VENUE,
    feeConfig: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    feeRate: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: 0,
    nonce: 7n,
    signature: `0x${'ab'.repeat(65)}` as Hex,
    ...over,
  }
}

function quote(over: Partial<SignedIntent> = {}, ex: Partial<Exclusive> = {}): ExclusiveQuote {
  const i = intent(over)
  const exclusive: Exclusive = {
    intentHash: intentHashOf(i),
    counterparty: TAKER,
    take: i.amountIn,
    expiry: i.endTime,
    nonce: 9n,
    ...ex,
  }
  return { intent: i, exclusive, bindingSignature: `0x${'cd'.repeat(65)}` as Hex }
}

const read = (q: ExclusiveQuote, msgHash = `0x${'ef'.repeat(32)}` as Hex): ReadQuote => ({
  msgHash,
  blockNumber: 1n,
  quote: q,
  sealed: false,
})

describe('the clipboard envelope a signed pair travels in', () => {
  const mirror = intent({
    maker: TAKER,
    recipient: TAKER,
    tokenIn: TOKEN_B,
    tokenOut: TOKEN_A,
    amountIn: 2_000_000_000_000_000_000n,
    minOutStart: 990_000n,
    minOutEnd: 990_000n,
    curve: CURVE_LINEAR,
    nonce: 11n,
  })

  test('a pair survives the round trip whole', () => {
    const ticket = { quote: quote(), mirror, take: mirror.amountIn }
    const back = decodeTicket(encodeTicket(ticket, DEFAULT_CHAIN))
    expect(back).not.toBeNull()
    expect(back?.take).toBe(ticket.take)
    expect(back?.mirror).toEqual(mirror)
    expect(back?.quote.intent).toEqual(ticket.quote.intent)
    expect(back?.quote.exclusive).toEqual(ticket.quote.exclusive)
    expect(back?.quote.bindingSignature).toBe(ticket.quote.bindingSignature)
  })

  /**
   * The take is on the wire rather than derived, so it has to survive being something other than
   * the mirror's whole size. A partial mirror does not exist today and the field is what stops
   * that from becoming a silent assumption if one ever does.
   */
  test('a take that is not the whole mirror comes back as itself', () => {
    const ticket = { quote: quote({ flags: FLAG_PARTIAL }), mirror, take: 1n }
    expect(decodeTicket(encodeTicket(ticket, DEFAULT_CHAIN))?.take).toBe(1n)
  })

  test.each([
    ['nothing', ''],
    ['prose', 'here is the pair'],
    ['an empty object', '{}'],
    ['the wrong version', '{"v":2,"quote":"0x01","mirror":"0x03","take":"1"}'],
    ['a take that is not a number', '{"v":1,"quote":"0x01","mirror":"0x03","take":"lots"}'],
    ['a negative take', '{"v":1,"quote":"0x01","mirror":"0x03","take":"-1"}'],
    ['halves that do not decode', '{"v":1,"quote":"0xdead","mirror":"0xbeef","take":"1"}'],
  ])('refuses %s', (_name, text) => {
    expect(decodeTicket(text)).toBeNull()
  })

  test('whitespace around a pasted pair is not a refusal', () => {
    const text = encodeTicket({ quote: quote(), mirror, take: mirror.amountIn }, DEFAULT_CHAIN)
    expect(decodeTicket(`\n  ${text}\n`)).not.toBeNull()
  })

  /**
   * The mirror goes out under the sign form's rule (`forTheBoard`): its fee config's preimage
   * rides along only when the config is not one of the chain's bundled defaults.
   */
  describe('the fee config preimage on the mirror', () => {
    const wireMirror = (text: string) => JSON.parse(text).mirror as Hex
    const unbundled = singleFeeConfig('0x00000000000000000000000000000000000C0FFE')

    test('an unbundled config travels with its preimage, and comes back on the mirror', () => {
      const signed = { ...mirror, feeConfig: hashFeeConfig(unbundled), feeConfigPreimage: unbundled }
      const text = encodeTicket({ quote: quote(), mirror: signed, take: signed.amountIn }, 943)
      expect(wireMirror(text)).toBe(encodeIntent(signed))
      expect(decodeTicket(text)?.mirror).toEqual(signed)
    })

    test('a bundled default goes without it, so the pair is no longer than it was', () => {
      const cfg = defaultFees(943).config
      const bare = { ...mirror, feeConfig: hashFeeConfig(cfg) }
      const text = encodeTicket({ quote: quote(), mirror: { ...bare, feeConfigPreimage: cfg }, take: 1n }, 943)
      expect(wireMirror(text)).toBe(encodeIntent(bare))
      expect(decodeTicket(text)?.mirror.feeConfigPreimage).toBeUndefined()
    })

    test('a mirror with no fee config carries no block', () => {
      const text = encodeTicket({ quote: quote(), mirror, take: 1n }, 943)
      expect(wireMirror(text)).toBe(encodeIntent(mirror))
    })

    /**
     * `mirrorFor` signs the mirror with no fee config, so today the block never rides on a
     * mirror; the maker's quote is the half that names one. `MakeQuote` posts it under the same
     * rule, and the quote codec carries the block inside its intent slice.
     */
    test('a quote posted under the rule carries the block through the quote codec and the pair', () => {
      const withBlock = quote({ feeConfig: hashFeeConfig(unbundled), feeRate: 10n ** 15n })
      const posted = { ...withBlock, intent: forTheBoard({ ...withBlock.intent, feeConfigPreimage: unbundled }, 943) }
      expect(decodeExclusiveQuote(encodeExclusiveQuote(posted))?.intent.feeConfigPreimage).toEqual(unbundled)
      const text = encodeTicket({ quote: posted, mirror, take: 1n }, 943)
      expect(decodeTicket(text)?.quote.intent.feeConfigPreimage).toEqual(unbundled)

      const cfg = defaultFees(943).config
      const bundled = quote({ feeConfig: hashFeeConfig(cfg), feeRate: 10n ** 15n })
      const bare = forTheBoard({ ...bundled.intent, feeConfigPreimage: cfg }, 943)
      expect(decodeExclusiveQuote(encodeExclusiveQuote({ ...bundled, intent: bare }))?.intent.feeConfigPreimage).toBeUndefined()
    })

    /** The pair is unverified when pasted, so its preimage is handed back and not kept. */
    test('reading a pair keeps nothing in the wire store', () => {
      forgetWireFeeConfigs()
      const signed = { ...mirror, feeConfig: hashFeeConfig(unbundled), feeConfigPreimage: unbundled }
      decodeTicket(encodeTicket({ quote: quote(), mirror: signed, take: 1n }, 943))
      expect(wireFeeConfig(hashFeeConfig(unbundled))).toBeNull()
    })
  })
})

describe('which quotes are mine', () => {
  const toMe = read(quote(), `0x${'11'.repeat(32)}` as Hex)
  const toSomebodyElse = read(
    quote({}, { counterparty: '0x9999999999999999999999999999999999999999' as Address }),
    `0x${'22'.repeat(32)}` as Hex,
  )

  test('a quote reserved for me is mine and a stranger’s is not', () => {
    const all = [toMe, toSomebodyElse]
    expect(quotesFor(all, TAKER).map((q) => q.msgHash)).toEqual([toMe.msgHash])
  })

  /**
   * Case-insensitively, because `RfqVenue` compares addresses and a checksummed one is the same
   * address as a lower-case one. A reader whose wallet hands back mixed case must not find an
   * empty inbox.
   */
  test('the comparison ignores case, the way the binding does', () => {
    expect(quotesFor([toMe], TAKER.toUpperCase() as Address)).toHaveLength(1)
  })

  test('nobody connected means nothing is mine', () => {
    expect(quotesFor([toMe], null)).toEqual([])
    expect(quotesFrom([toMe], null)).toEqual([])
  })

  test('a maker sees their own desk rather than their inbox', () => {
    expect(quotesFrom([toMe, toSomebodyElse], MAKER)).toHaveLength(2)
    expect(quotesFrom([toMe], TAKER)).toEqual([])
  })
})

describe('where the venue is', () => {
  test('the chain the app ships against has one', () => {
    expect(rfqVenue(DEFAULT_CHAIN)).toMatch(/^0x[0-9a-fA-F]{40}$/)
  })

  /**
   * The domain an intent hashes under carries the settlement's address, so a chain with no
   * settlement in the registry can produce a binding that commits to a hash nothing on chain
   * agrees with. Answering null is what keeps the surface off that chain entirely.
   */
  test('no settlement means no venue, whatever address is written down', () => {
    setSettlementOverride(DEFAULT_CHAIN, ZERO)
    try {
      expect(rfqVenue(DEFAULT_CHAIN)).toBeNull()
    } finally {
      setSettlementOverride(DEFAULT_CHAIN, null)
    }
  })
})

describe('the fault vocabulary is the SDK’s', () => {
  /**
   * Every reason `checkExclusiveQuote` can give has a sentence, and the sentences are distinct.
   *
   * The `Record<QuoteFault, Key>` type already refuses to compile without an entry, so this is
   * about the other half: two faults sharing a sentence would tell a reader the same thing about
   * two different problems, and one of them would be wrong.
   */
  const FAULTS = Object.keys(FAULT_KEY) as QuoteFault[]

  test('there are eight of them, and no two say the same thing', () => {
    expect(FAULTS).toHaveLength(8)
    expect(new Set(Object.values(FAULT_KEY)).size).toBe(FAULTS.length)
  })

  test('every key is one this app owns', () => {
    expect(Object.values(FAULT_KEY).filter((k) => !k.startsWith('rfq.fault.'))).toEqual([])
  })
})

describe('how long a quote stays firm', () => {
  /**
   * `Exclusive.expiry` is the deadline for submitting as well as for accepting — `RfqVenue`
   * reverts with `BindingExpired` at or after it. An hour is also the settlement's own cap on a
   * wallet-custody window, so a longer chip would offer a quote the chain refuses to sign off on.
   */
  test('nothing is offered past the wallet-custody cap', () => {
    expect(RFQ_WINDOWS.every((w) => w.seconds <= 3600)).toBe(true)
    expect(RFQ_WINDOWS.every((w) => w.seconds > 0)).toBe(true)
  })

  test('the windows are in order, so the chips read as a scale', () => {
    const seconds = RFQ_WINDOWS.map((w) => w.seconds)
    expect([...seconds].sort((a, b) => a - b)).toEqual(seconds)
  })
})

/**
 * What the walk does with a sealed quote that names this reader and will not open.
 *
 * Two messages, both addressed to the same reader. One opens. The other is that same message
 * with a byte changed — which is what a truncation, a bad relay or a hostile edit looks like from
 * here. The walk used to count both as "locked", and the surface turned that into a line asking
 * the reader to unlock a key they had already unlocked.
 */
describe('a sealed quote that names this reader and does not open', () => {
  // Any 65 bytes derive a keypair: the signature is HKDF input, not a signature to check here.
  const KEY = deriveRfqKeyPair(`0x${'11'.repeat(65)}` as Hex)
  const WIRE = encodeSealedQuote(quote(), KEY.publicKey)
  const DAMAGED: Hex = (() => {
    const b = hexToBytes(WIRE)
    b[b.length - 1] ^= 1
    return bytesToHex(b)
  })()

  const message = (data: Hex, hash: Hex) =>
    ({ data, hash, blockNumber: '1' }) as unknown as RPCMessage

  beforeEach(() => {
    vi.mocked(latestRfqKeys).mockResolvedValue(new Map())
    vi.mocked(readRfqQuotes).mockResolvedValue([
      message(WIRE, `0x${'a1'.repeat(32)}` as Hex),
      message(DAMAGED, `0x${'a2'.repeat(32)}` as Hex),
    ])
  })

  test('the reader gets the quote that opened, and is told about the one that did not', async () => {
    const board = await readRfqBoard(TAKER, KEY.secretKey)
    expect(board.quotes.map((q) => q.sealed)).toEqual([true])
    expect(board.unreadableForMe).toBe(1)
    // Not locked. The key is unlocked, so "unlock it" would be advice that does nothing.
    expect(board.lockedForMe).toBe(0)
  })

  test('with no key unlocked, both are locked and neither is a fault', async () => {
    const board = await readRfqBoard(TAKER, null)
    expect(board.quotes).toEqual([])
    expect(board.lockedForMe).toBe(2)
    expect(board.unreadableForMe).toBe(0)
  })

  test('a message for somebody else is neither, and costs no curve operation', async () => {
    // The head names the taker, this reader is the maker, and the walk skips on one slice. A
    // board is public: most of what it holds was never this reader's to open.
    const board = await readRfqBoard(MAKER, KEY.secretKey)
    expect(board.quotes).toEqual([])
    expect(board.lockedForMe).toBe(0)
    expect(board.unreadableForMe).toBe(0)
  })
})

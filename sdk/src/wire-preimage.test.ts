import { describe, expect, test, beforeEach } from 'vitest'
import { getAddress, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  CURVE_LINEAR,
  WIRE_CONFIG_CAP,
  ZERO,
  ZERO_HASH,
  decodeIntent,
  encodeIntent,
  feeConfigPreimageOf,
  forgetWireFeeConfigs,
  intentHashOf,
  knownFeeConfig,
  learnWireFeeConfig,
  readIntent,
  rememberFeeConfig,
  signIntent,
  verifyIntent,
  wireFeeConfig,
  withWirePreimage,
  type Intent,
  type SignedIntent,
} from './intent.js'
import { WAD, hashFeeConfig, singleFeeConfig, type FeeConfig } from './feeconfig.js'

/**
 * The wire's optional fee config preimage block (independent review finding 3): a post may carry
 * the destinations and weights its `feeConfig` hashes, so a reader that has never met the hash can
 * display and pay it without a chain read. The block is bit 2 of the `P_FEE_EXT` byte, not a new
 * codec version, and these tests hold the decoder to the one rule that makes it safe: a block that
 * is not exactly the canonical preimage of the signed hash drops the whole post.
 */

const CHAIN = 943
const sig = ('0x' + '11'.repeat(65)) as Hex

const dest = (byte: string) => getAddress(`0x${byte.repeat(20)}`) as Address

const ONE: FeeConfig = singleFeeConfig(dest('55'))
const TWO: FeeConfig = { destinations: [dest('55'), dest('66')], weights: [WAD / 2n, WAD / 2n] }
/** The widest config there is: eight destinations, uneven weights. */
const EIGHT: FeeConfig = (() => {
  const destinations = ['11', '22', '33', '44', '55', '66', '77', '88'].map(dest)
  const weights = [1n, 2n, 3n, 4n, 5n, 6n, 7n].map((k) => (WAD * k) / 100n)
  weights.push(WAD - weights.reduce((a, b) => a + b, 0n))
  return { destinations, weights }
})()

function intentFor(cfg: FeeConfig | null, extra: Partial<Intent> = {}): Intent {
  const maker = dest('ab')
  return {
    maker,
    recipient: maker,
    tokenIn: dest('a1'),
    tokenOut: dest('b2'),
    amountIn: 10n ** 21n,
    minOutStart: 2n * 10n ** 21n,
    minOutEnd: 10n ** 21n,
    startTime: 1_800_000_000n,
    endTime: 1_800_003_600n,
    executor: ZERO,
    feeConfig: cfg ? hashFeeConfig(cfg) : ZERO_HASH,
    feeRate: cfg ? 5n * 10n ** 15n : 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: 1,
    nonce: 42n,
    curve: CURVE_LINEAR,
    ...extra,
  }
}

const bytes = (h: Hex) => (h.length - 2) / 2
/** Replace one exact substring of a payload, which must occur once. */
function patch(data: Hex, from: string, to: string): Hex {
  const body = data.slice(2)
  const at = body.indexOf(from.toLowerCase())
  expect(at).toBeGreaterThanOrEqual(0)
  expect(body.indexOf(from.toLowerCase(), at + 1)).toBe(-1)
  return `0x${body.slice(0, at)}${to.toLowerCase()}${body.slice(at + from.length)}` as Hex
}
/** The block's count byte sits just before its first destination. */
const countByteBefore = (data: Hex, first: Address) => {
  const at = data.slice(2).indexOf(first.slice(2).toLowerCase())
  return at - 2
}
function setByte(data: Hex, hexOffset: number, value: number): Hex {
  const body = data.slice(2)
  return `0x${body.slice(0, hexOffset)}${value.toString(16).padStart(2, '0')}${body.slice(hexOffset + 2)}` as Hex
}

beforeEach(() => forgetWireFeeConfigs())

describe('the wire preimage block', () => {
  test('one destination rides in 21 bytes and comes back as the exact preimage', () => {
    const plain: SignedIntent = { ...intentFor(ONE), signature: sig }
    const carried: SignedIntent = { ...plain, feeConfigPreimage: ONE }
    // An ext byte (the intent names no P1/P3 rate, so it is new here) plus the 21-byte block.
    expect(bytes(encodeIntent(carried)) - bytes(encodeIntent(plain))).toBe(1 + 21)
    const out = decodeIntent(encodeIntent(carried))
    expect(out?.feeConfigPreimage).toEqual(ONE)
    expect(hashFeeConfig(out!.feeConfigPreimage!)).toBe(plain.feeConfig)
  })

  test('two destinations cost 49 bytes, eight cost 217, and both round-trip beside P1 and P3', () => {
    for (const [cfg, size] of [
      [TWO, 49],
      [EIGHT, 217],
    ] as const) {
      // P1 and P3 set, so the ext byte is there either way and the difference is the block alone.
      const base = intentFor(cfg, { feeRateIn: 10n ** 15n, feeRateProceeds: 2n * 10n ** 15n })
      const plain: SignedIntent = { ...base, signature: sig }
      const carried: SignedIntent = { ...plain, feeConfigPreimage: cfg }
      expect(bytes(encodeIntent(carried)) - bytes(encodeIntent(plain))).toBe(size)
      const out = decodeIntent(encodeIntent(carried))!
      expect(out.feeConfigPreimage).toEqual(cfg)
      expect(out.feeRateIn).toBe(base.feeRateIn)
      expect(out.feeRateProceeds).toBe(base.feeRateProceeds)
      expect(out.feeRate).toBe(base.feeRate)
    }
  })

  test('a post without the block is byte for byte what version 5 always wrote', () => {
    const s: SignedIntent = { ...intentFor(ONE), signature: sig }
    const explicit: SignedIntent = { ...s, feeConfigPreimage: undefined }
    expect(encodeIntent(explicit)).toBe(encodeIntent(s))
    expect(decodeIntent(encodeIntent(s))?.feeConfigPreimage).toBeUndefined()
    // The extension byte stays absent when nothing needs it.
    expect(parseInt(encodeIntent(s).slice(8, 10), 16) & 128).toBe(0)
  })

  test('the block is outside the signature: same digest, and a real signature still verifies', async () => {
    const key = privateKeyToAccount(generatePrivateKey())
    const i = intentFor(TWO, { maker: key.address, recipient: key.address })
    rememberFeeConfig(TWO)
    const signature = await signIntent(key as never, i, { chainId: CHAIN })
    const out = decodeIntent(encodeIntent({ ...i, signature, feeConfigPreimage: TWO }))!
    expect(intentHashOf(out, CHAIN)).toBe(intentHashOf(i, CHAIN))
    expect(await verifyIntent(out, CHAIN)).toBe(true)
  })

  test('the encoder refuses a block every reader would drop', () => {
    const s: SignedIntent = { ...intentFor(ONE), signature: sig }
    expect(() => encodeIntent({ ...s, feeConfigPreimage: TWO })).toThrow(/does not hash/)
    const reversed: FeeConfig = { destinations: [...TWO.destinations].reverse(), weights: TWO.weights }
    expect(() => encodeIntent({ ...intentFor(reversed), signature: sig, feeConfigPreimage: reversed })).toThrow(
      /not canonical/,
    )
    expect(() => encodeIntent({ ...intentFor(null), signature: sig, feeConfigPreimage: ONE })).toThrow(/non-zero/)
  })
})

describe('the decoder drops a post whose block is not the preimage', () => {
  const carried = (cfg: FeeConfig, extra: Partial<Intent> = {}) =>
    encodeIntent({ ...intentFor(cfg, extra), signature: sig, feeConfigPreimage: cfg })

  test('a destination swapped for another: the hash no longer matches', () => {
    const data = carried(TWO)
    expect(decodeIntent(data)).not.toBeNull()
    expect(decodeIntent(patch(data, dest('66').slice(2), dest('67').slice(2)))).toBeNull()
  })

  test('the block of another config, with the signed hash left alone', () => {
    // Same shape and length: two destinations. Only the hash check can catch it.
    const other: FeeConfig = { destinations: [dest('55'), dest('77')], weights: TWO.weights }
    const data = carried(TWO)
    expect(decodeIntent(patch(data, dest('66').slice(2), dest('77').slice(2)))).toBeNull()
    expect(hashFeeConfig(other)).not.toBe(hashFeeConfig(TWO))
  })

  test('a weight moved between destinations: same sum, different hash', () => {
    const data = carried(TWO)
    // 0.5e18 -> 0.4e18 for the first; the implied last becomes 0.6e18.
    const half = (WAD / 2n).toString(16).padStart(16, '0')
    const less = ((WAD * 4n) / 10n).toString(16).padStart(16, '0')
    expect(decodeIntent(patch(data, half, less))).toBeNull()
  })

  test('weights that leave nothing for the last destination', () => {
    const data = carried(TWO)
    const half = (WAD / 2n).toString(16).padStart(16, '0')
    expect(decodeIntent(patch(data, half, WAD.toString(16).padStart(16, '0')))).toBeNull()
  })

  test('a count of zero, nine, or one more than the block holds', () => {
    const data = carried(ONE)
    const at = countByteBefore(data, ONE.destinations[0])
    expect(parseInt(data.slice(2).slice(at, at + 2), 16)).toBe(1)
    expect(decodeIntent(setByte(data, at, 0))).toBeNull()
    expect(decodeIntent(setByte(data, at, 9))).toBeNull()
    expect(decodeIntent(setByte(data, at, 2))).toBeNull()
  })

  test('a block cut short', () => {
    const data = carried(EIGHT)
    const at = countByteBefore(data, EIGHT.destinations[0])
    // Keep the count byte and three destinations; drop everything after.
    expect(decodeIntent(`0x${data.slice(2, 2 + at + 2 + 3 * 40)}` as Hex)).toBeNull()
  })

  test('a block on a post with feeConfig = 0', () => {
    // A rate in P1 puts the extension byte on the wire; the intent names no recipient, executor,
    // config or P2 rate, so the byte sits right after the three addresses, at offset 64.
    const data = encodeIntent({ ...intentFor(null, { feeRateIn: 1n }), signature: sig })
    expect(decodeIntent(data)).not.toBeNull()
    expect(decodeIntent(setByte(data, 64 * 2, 1 | 4))).toBeNull()
  })

  test('an extension bit nobody has defined', () => {
    const data = carried(ONE)
    const at = countByteBefore(data, ONE.destinations[0])
    // The ext byte is the one before the block when the intent names no P1/P3 rate.
    expect(parseInt(data.slice(2).slice(at - 2, at), 16)).toBe(4)
    expect(decodeIntent(setByte(data, at - 2, 4 | 8))).toBeNull()
  })
})

describe('reading the wire remembers a preimage, and only for reading', () => {
  const key = privateKeyToAccount(generatePrivateKey())
  /** A post the key really signed, carrying `cfg`'s preimage. */
  async function signedPost(cfg: FeeConfig): Promise<Hex> {
    const i = intentFor(cfg, { maker: key.address, recipient: key.address })
    const signature = await signIntent(key, i, { preimage: cfg, chainId: CHAIN })
    return encodeIntent({ ...i, signature, feeConfigPreimage: cfg })
  }

  test('readIntent keeps it once the signature verifies; decodeIntent stays pure', async () => {
    const data = await signedPost(TWO)
    const h = hashFeeConfig(TWO)
    decodeIntent(data)
    expect(wireFeeConfig(h)).toBeNull()
    expect((await readIntent(data, CHAIN))?.feeConfigPreimage).toEqual(TWO)
    expect(wireFeeConfig(h)).toEqual(TWO)
    expect(feeConfigPreimageOf(h)).toEqual(TWO)
  })

  /**
   * The store is bounded, least recently seen out first, so a post that teaches it something
   * evicts something.
   * An unsigned post costs proof of work and nothing else; learning only after the signature
   * verifies makes every eviction cost a signature too.
   */
  test('a post whose signature is not the maker\'s reads as null and teaches nothing', async () => {
    const h = hashFeeConfig(TWO)
    const forged = encodeIntent({ ...intentFor(TWO), signature: sig, feeConfigPreimage: TWO })
    expect(decodeIntent(forged)?.feeConfigPreimage).toEqual(TWO)
    expect(await readIntent(forged, CHAIN)).toBeNull()
    expect(wireFeeConfig(h)).toBeNull()
    // Signed for another chain: the same refusal.
    expect(await readIntent(await signedPost(TWO), 369)).toBeNull()
    expect(wireFeeConfig(h)).toBeNull()
  })

  test('a payload that does not decode reads as null', async () => {
    expect(await readIntent('0xdead', CHAIN)).toBeNull()
  })

  test('a wire preimage never becomes one a wallet may sign', async () => {
    // The app's signing guard is `knownFeeConfig`. A stranger's post must not satisfy it, or a
    // post naming an unshipped default would skip the maker's acknowledgement.
    const cfg: FeeConfig = singleFeeConfig(dest('9a'))
    const h = hashFeeConfig(cfg)
    await readIntent(await signedPost(cfg), CHAIN)
    expect(wireFeeConfig(h)).toEqual(cfg)
    expect(knownFeeConfig(h)).toBeNull()
    await expect(signIntent({ signTypedData: key.signTypedData } as never, intentFor(cfg))).rejects.toThrow(
      /preimage/,
    )
  })

  test('a preimage seen again moves to the back of the queue and outlives a flood', () => {
    const cfgOf = (k: number) => singleFeeConfig(`0x${k.toString(16).padStart(40, '0')}` as Address)
    for (let k = 1; k <= WIRE_CONFIG_CAP; k++) learnWireFeeConfig(cfgOf(k))
    // The oldest, seen again: now the newest.
    expect(learnWireFeeConfig(cfgOf(1))).toBe(hashFeeConfig(cfgOf(1)))
    // One new config evicts the least recently seen, which is now #2, not #1.
    learnWireFeeConfig(cfgOf(WIRE_CONFIG_CAP + 1))
    expect(wireFeeConfig(hashFeeConfig(cfgOf(1)))).toEqual(cfgOf(1))
    expect(wireFeeConfig(hashFeeConfig(cfgOf(2)))).toBeNull()
    expect(wireFeeConfig(hashFeeConfig(cfgOf(3)))).not.toBeNull()
    // A full queue of fresh configs then pushes #1 out too: being seen once more buys one lap.
    for (let k = WIRE_CONFIG_CAP + 2; k <= 2 * WIRE_CONFIG_CAP + 1; k++) learnWireFeeConfig(cfgOf(k))
    expect(wireFeeConfig(hashFeeConfig(cfgOf(1)))).toBeNull()
  })

  test('seeing a preimage again neither grows the store nor evicts anything', () => {
    const cfgOf = (k: number) => singleFeeConfig(`0x${k.toString(16).padStart(40, '0')}` as Address)
    for (let k = 1; k <= WIRE_CONFIG_CAP; k++) learnWireFeeConfig(cfgOf(k))
    for (let k = 1; k <= WIRE_CONFIG_CAP; k++) learnWireFeeConfig(cfgOf(k))
    for (let k = 1; k <= WIRE_CONFIG_CAP; k++) expect(wireFeeConfig(hashFeeConfig(cfgOf(k)))).not.toBeNull()
  })

  test('the store refuses a non-canonical config and holds at most WIRE_CONFIG_CAP', () => {
    expect(learnWireFeeConfig({ destinations: [], weights: [] })).toBeNull()
    const first = hashFeeConfig(singleFeeConfig(`0x${(1).toString(16).padStart(40, '0')}` as Address))
    for (let k = 1; k <= WIRE_CONFIG_CAP + 1; k++) {
      learnWireFeeConfig(singleFeeConfig(`0x${k.toString(16).padStart(40, '0')}` as Address))
    }
    // Oldest out first.
    expect(wireFeeConfig(first)).toBeNull()
    const last = hashFeeConfig(
      singleFeeConfig(`0x${(WIRE_CONFIG_CAP + 1).toString(16).padStart(40, '0')}` as Address),
    )
    expect(wireFeeConfig(last)).not.toBeNull()
  })
})

describe('withWirePreimage: attach only what a reader may lack', () => {
  const s: SignedIntent = { ...intentFor(TWO), signature: sig }

  test('a config the readers ship goes without a block', () => {
    expect(withWirePreimage({ ...s, feeConfigPreimage: TWO }, () => true).feeConfigPreimage).toBeUndefined()
  })

  test('feeConfig = 0 goes without a block', () => {
    const zero: SignedIntent = { ...intentFor(null), signature: sig }
    expect(withWirePreimage(zero, () => false).feeConfigPreimage).toBeUndefined()
  })

  test('an unshipped config carries the preimage this process vouches for', () => {
    const cfg: FeeConfig = singleFeeConfig(dest('7b'))
    rememberFeeConfig(cfg)
    const out = withWirePreimage({ ...intentFor(cfg), signature: sig }, () => false)
    expect(out.feeConfigPreimage).toEqual(cfg)
    expect(decodeIntent(encodeIntent(out))?.feeConfigPreimage).toEqual(cfg)
  })

  test('a preimage passed on the intent is used, and a wrong one is dropped rather than posted', () => {
    expect(withWirePreimage({ ...s, feeConfigPreimage: TWO }, () => false).feeConfigPreimage).toEqual(TWO)
    expect(withWirePreimage({ ...s, feeConfigPreimage: ONE }, () => false).feeConfigPreimage).toBeUndefined()
  })
})

import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { bytesToHex, hashTypedData, hexToBytes, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import fixture from '../../app/src/lib/__fixtures__/eip712.json' with { type: 'json' }
import { setSettlementOverride } from './config.js'
import {
  CURVE_LINEAR,
  CURVE_ONE,
  FLAG_CURVE_KIND,
  FLAG_ESCROW,
  FLAG_PARTIAL,
  FLAG_PERMIT2,
  TYPES,
  ZERO,
  ZERO_HASH,
  KIND_CUBIC,
  KIND_KNOTS,
  KIND_LINEAR,
  KIND_STRETCH,
  authNonceOf,
  authUsableWindow,
  breakpointsOf,
  curveKindOf,
  decodeIntent,
  domain,
  encodeIntent,
  grossOut,
  intentHashOf,
  intentKey,
  isDeadWindow,
  liveWindow,
  minOutAt,
  signingDomain,
  stretchCurve,
  typedDataFor,
  INTENT_TYPE,
  INTENT_TYPEHASH,
  verifyIntent,
  type Intent,
  type SignedIntent,
  signIntent,
} from './intent.js'
import { quote, ratesOf } from './settlement.js'
import { FEE_CONFIG_TYPEHASH, singleFeeConfig } from './feeconfig.js'

/**
 * This package signs intents in TypeScript and the contract verifies them in Solidity. A single
 * field out of order in either place makes every signature it produces unspendable, and no other
 * test on either side would notice. `contracts/test/Fixture.t.sol` writes the fixture these
 * tests read, so the two implementations are pinned to each other. The fixture stays in the app
 * tree because CI checks it with `git diff --exit-code` against that exact path.
 */

/** One, in the unit a rate is counted in. The contract calls it `WAD`. */
const WAD = 10n ** 18n

const F = fixture as unknown as {
  chainId: number
  verifyingContract: Address
  typehash: Hex
  domainSeparator: Hex
  digest: Hex
  intent: Record<string, string | number>
  /**
   * The curve sampled segment by segment, not only at its ends. A stretch has three regions and
   * two corners, and the fixture writes one sample per region and one either side of each
   * corner — see `_curveJson` in `contracts/test/Fixture.t.sol` for the instants.
   */
  minOutAt: {
    start: string
    flatEarly: string
    corner1: string
    afterCorner1: string
    fallMid: string
    beforeCorner2: string
    corner2: string
    midpoint: string
    flatLate: string
    end: string
  }
  quoteAtStart: {
    take: string
    owedToMaker: string
    feeIn: string
    feeOut: string
    feeProceeds: string
    usable: string
    delivered: string
    owed: string
    rateIn: string
    rate: string
    rateProceeds: string
  }
}

const PREIMAGE = singleFeeConfig('0x4444444444444444444444444444444444444444')
const canonical: Intent = {
  maker: F.intent.maker as Address,
  recipient: F.intent.recipient as Address,
  tokenIn: F.intent.tokenIn as Address,
  tokenOut: F.intent.tokenOut as Address,
  amountIn: BigInt(F.intent.amountIn),
  minOutStart: BigInt(F.intent.minOutStart),
  minOutEnd: BigInt(F.intent.minOutEnd),
  startTime: BigInt(F.intent.startTime),
  endTime: BigInt(F.intent.endTime),
  executor: F.intent.executor as Address,
  feeConfig: F.intent.feeConfig as Hex,
  // The fixture writes a field only once it carries a rate, and absent has always meant zero.
  feeRate: BigInt(F.intent.feeRate ?? 0),
  feeRateIn: BigInt(F.intent.feeRateIn ?? 0),
  feeRateProceeds: BigInt(F.intent.feeRateProceeds ?? 0),
  minFill: BigInt(F.intent.minFill ?? 0),
  authNonce: (F.intent.authNonce ?? ZERO_HASH) as Hex,
  flags: Number(F.intent.flags),
  nonce: BigInt(F.intent.nonce),
  // The fixture's own intent draws a stretch: flat a quarter, dutch a quarter, flat a half. It
  // is the shape the mirror has to reproduce, so it is the shape the pin is taken on.
  curve: (F.intent.curve ?? CURVE_LINEAR) as Hex,
}

describe('EIP-712, against the Solidity fixture', () => {
  /** The preimage of the fixture's `feeConfig`: the single destination 0x4444…4444. */

  test('the digest matches what the contract computes, as a wallet would sign it', () => {
    // The wallet's view: the nested FeeConfig struct in place of its hash. EIP-712 hashes that
    // struct to the very `feeConfig` the contract carries, so both ways reach one digest.
    const digest = hashTypedData({
      domain: {
        name: 'prove.cash',
        version: '1',
        chainId: F.chainId,
        verifyingContract: F.verifyingContract,
      },
      types: TYPES,
      primaryType: 'Intent',
      message: {
        ...canonical,
        feeConfig: { destinations: [...PREIMAGE.destinations], weights: [...PREIMAGE.weights] },
      },
    })
    expect(digest).toBe(F.digest)
  })

  test('typedDataFor gives a wallet the same digest, and refuses what no wallet can sign', () => {
    setSettlementOverride(369, F.verifyingContract)
    try {
      const td = typedDataFor(canonical, PREIMAGE, 369)
      expect(hashTypedData(td as never)).toBe(F.digest)
      expect(() => typedDataFor({ ...canonical, feeConfig: ZERO_HASH }, undefined, 369)).toThrow(/cannot sign/)
      expect(() => typedDataFor(canonical, singleFeeConfig('0x5555555555555555555555555555555555555555'), 369)).toThrow(/does not hash/)
    } finally {
      setSettlementOverride(369, null)
    }
  })

  test('the contract’s type string and type hash are the ones TYPES describes', () => {
    expect(INTENT_TYPEHASH).toBe(F.typehash)
    const fields = TYPES.Intent.map((f) => `${f.type} ${f.name}`).join(',')
    const nested = TYPES.FeeConfig.map((f) => `${f.type} ${f.name}`).join(',')
    expect(INTENT_TYPE).toBe(`Intent(${fields})FeeConfig(${nested})`)
    expect(FEE_CONFIG_TYPEHASH).toBeDefined()
  })

  /**
   * The digest test above builds its own `hashTypedData` call, so it says nothing about the
   * function the app actually uses. That gap is not hypothetical: `intentHashOf` spells the
   * message out field by field, and while adding `feeTo` it was briefly written as a hard-coded
   * `ZERO` instead of `i.feeConfig`. Every test here still passed. This one would not have.
   */
  test('intentHashOf itself matches the fixture, field for field', () => {
    setSettlementOverride(369, F.verifyingContract)
    try {
      expect(intentHashOf(canonical, 369)).toBe(F.digest)
    } finally {
      setSettlementOverride(369, null)
    }
  })

  test('the field order in TYPES matches the contract typehash', () => {
    expect(TYPES.Intent.map((f) => f.name)).toEqual([
      'maker',
      'recipient',
      'tokenIn',
      'tokenOut',
      'amountIn',
      'minOutStart',
      'minOutEnd',
      'startTime',
      'endTime',
      'executor',
      'feeConfig',
      'feeRate',
      'minFill',
      'authNonce',
      'flags',
      'nonce',
      'curve',
      'feeRateIn',
      'feeRateProceeds',
    ])
  })
})

describe('the rate curve, against the Solidity fixture', () => {
  /**
   * Every instant the fixture samples, in the order the window walks through them.
   *
   * Endpoints alone cannot tell a stretch from the straight line: both agree at the open and at
   * the close, and a mirror that ignored `curve` would pass. These are the seconds where the two
   * disagree, and the two corners are sampled on both sides.
   */
  test('matches the contract in every region, and either side of both corners', () => {
    const t0 = canonical.startTime
    const samples: [bigint, string][] = [
      [t0, F.minOutAt.start],
      [t0 + 450n, F.minOutAt.flatEarly],
      [t0 + 900n, F.minOutAt.corner1],
      [t0 + 901n, F.minOutAt.afterCorner1],
      [t0 + 1_350n, F.minOutAt.fallMid],
      [t0 + 1_800n, F.minOutAt.beforeCorner2],
      [t0 + 1_801n, F.minOutAt.corner2],
      [t0 + 2_700n, F.minOutAt.midpoint],
      [t0 + 3_400n, F.minOutAt.flatLate],
      [canonical.endTime, F.minOutAt.end],
    ]
    for (const [at, expected] of samples) expect(minOutAt(canonical, at)).toBe(BigInt(expected))
  })

  /**
   * The shape, read back out of the numbers rather than out of the word.
   *
   * A mirror that read the corners at the wrong instants would still match a few samples. This
   * says what the samples mean: two flats at the two ends, a fall between them, and the corners
   * where `breakpointsOf` says they are.
   */
  test('the stretch rests, falls, and rests again', () => {
    const t0 = canonical.startTime
    expect(curveKindOf(canonical)).toBe(KIND_STRETCH)
    expect(breakpointsOf(canonical)).toEqual([t0 + 900n, t0 + 1_800n])
    // The opening flat holds the ceiling, to its last second.
    expect(minOutAt(canonical, t0 + 900n)).toBe(canonical.minOutStart)
    expect(minOutAt(canonical, t0 + 901n)).toBeLessThan(canonical.minOutStart)
    // The closing flat holds the floor, from its first second.
    expect(minOutAt(canonical, t0 + 1_800n)).toBeGreaterThan(canonical.minOutEnd)
    expect(minOutAt(canonical, t0 + 1_801n)).toBe(canonical.minOutEnd)
  })

  /**
   * The curve's requirement for the take is the fixture's `owedToMaker`: every fee is a share of
   * it, and the solver's outlay is that plus the P2 fee.
   */
  test('a partial take owes what the contract quotes', () => {
    const take = BigInt(F.quoteAtStart.take)
    expect(grossOut(canonical, take, canonical.startTime)).toBe(BigInt(F.quoteAtStart.owedToMaker))
  })

  test('all three take points and every amount match the contract at the same take', () => {
    const take = BigInt(F.quoteAtStart.take)
    const q = quote(canonical, take, canonical.startTime)
    const want = F.quoteAtStart
    expect(q.owedToMaker).toBe(BigInt(want.owedToMaker))
    expect(q.feeIn).toBe(BigInt(want.feeIn))
    expect(q.feeOut).toBe(BigInt(want.feeOut))
    expect(q.feeProceeds).toBe(BigInt(want.feeProceeds))
    expect(q.usable).toBe(BigInt(want.usable))
    expect(q.delivered).toBe(BigInt(want.delivered))
    expect(q.owed).toBe(BigInt(want.owed))
    // The legacy names keep their identity: the outlay is what the maker banks plus the fees.
    expect(q.gross).toBe(q.owed)
    expect(q.delivered + q.fee).toBe(q.gross)
  })

  /**
   * The rates, as well as the fees they produced.
   *
   * `ratesOf` folds a zero config down to nothing, and the fees alone would not catch a mirror
   * that forgot the fold: this fixture names a config, so both readings agree on it. The contract
   * writes the rates down beside the fees for exactly that reason.
   */
  test('the rates match the contract, config fold included', () => {
    expect(ratesOf(canonical)).toEqual({
      handover: BigInt(F.quoteAtStart.rateIn),
      output: BigInt(F.quoteAtStart.rate),
      proceeds: BigInt(F.quoteAtStart.rateProceeds),
    })
    const none = { ...canonical, feeConfig: ZERO_HASH }
    expect(ratesOf(none)).toEqual({ handover: 0n, output: 0n, proceeds: 0n })
    // A quote that charges nothing hands the maker the whole requirement, and no wei goes missing.
    const free = quote(none, BigInt(F.quoteAtStart.take), canonical.startTime)
    expect(free.fee).toBe(0n)
    expect(free.feeIn).toBe(0n)
    expect(free.delivered).toBe(free.gross)
    expect(free.usable).toBe(BigInt(F.quoteAtStart.take))
  })

  test('the price never rises and never leaves its bounds', () => {
    let previous = minOutAt(canonical, canonical.startTime)
    for (let t = canonical.startTime; t <= canonical.endTime; t += 137n) {
      const rate = minOutAt(canonical, t)
      expect(rate).toBeLessThanOrEqual(previous)
      expect(rate).toBeGreaterThanOrEqual(canonical.minOutEnd)
      previous = rate
    }
  })

  test('the gross rounds up on every split, so the rounding favours the maker', () => {
    for (const take of [1n, 3n, 7n, 999n, canonical.amountIn - 1n, canonical.amountIn]) {
      const gross = grossOut(canonical, take, canonical.startTime)
      expect(gross * canonical.amountIn).toBeGreaterThanOrEqual(take * canonical.minOutStart)
    }
  })

  /**
   * The floor, where the ceiling and the floor differ.
   *
   * The fixture's own take divides exactly, so it cannot tell the two roundings apart. These
   * takes cannot: at each one `gross · rate` leaves a remainder against a WAD, and a mirror that
   * kept the old ceiling would answer one wei more. The dust stays with the maker.
   */
  test('every fee rounds down, and the dust stays with whoever bears it', () => {
    let seen = 0
    for (const take of [1n, 3n, 7n, 11n, 999n, 100_001n]) {
      const owedToMaker = grossOut(canonical, take, canonical.startTime)
      const q = quote(canonical, take, canonical.startTime)
      for (const [fee, base, rate] of [
        [q.feeIn, take, canonical.feeRateIn],
        [q.feeOut, owedToMaker, canonical.feeRate],
        [q.feeProceeds, owedToMaker, canonical.feeRateProceeds],
      ] as const) {
        expect(fee).toBe((base * rate) / WAD)
        if ((base * rate) % WAD !== 0n) seen++
      }
      expect(q.delivered + q.feeProceeds).toBe(owedToMaker)
      expect(q.owed).toBe(owedToMaker + q.feeOut)
      expect(q.usable + q.feeIn).toBe(take)
    }
    expect(seen).toBeGreaterThan(0)
  })
})

/**
 * The curve field: the shape the maker draws, and the two bits that say how to read it.
 *
 * The fixture pins the arithmetic to the Solidity. These tests pin the parts the fixture cannot
 * reach — every word rather than one, every kind rather than the one the fixture signs, and the
 * property the whole design rests on: **the zero word is the shipped straight line**.
 */
describe('the curve', () => {
  /** xorshift64, seeded once, so a failure names a case somebody can paste into the file. */
  function walker(seed: bigint): () => bigint {
    const MASK = (1n << 64n) - 1n
    let x = seed
    return () => {
      x ^= (x << 13n) & MASK
      x ^= x >> 7n
      x ^= (x << 17n) & MASK
      return x
    }
  }

  /** A flat-line intent with a window a whole day wide, and whatever curve the case wants. */
  const shaped = (curve: Hex, kind = KIND_STRETCH): Intent => ({
    ...canonical,
    minOutStart: 3_000n * 10n ** 18n,
    minOutEnd: 1_000n * 10n ** 18n,
    startTime: 1_700_000_000n,
    endTime: 1_700_086_400n,
    flags: (canonical.flags & ~FLAG_CURVE_KIND) | kind,
    curve,
  })

  test('the kind lives in two bits of flags, and nothing else moves', () => {
    expect(curveKindOf(shaped(CURVE_LINEAR, KIND_LINEAR))).toBe(KIND_LINEAR)
    expect(curveKindOf(shaped(CURVE_LINEAR, KIND_STRETCH))).toBe(KIND_STRETCH)
    expect(curveKindOf(shaped(CURVE_LINEAR, KIND_KNOTS))).toBe(KIND_KNOTS)
    expect(curveKindOf(shaped(CURVE_LINEAR, KIND_CUBIC))).toBe(KIND_CUBIC)
    // The other three flags survive a kind, because they are different bits of the same byte.
    const both = shaped(CURVE_LINEAR, KIND_STRETCH)
    expect(both.flags & FLAG_PARTIAL).toBe(FLAG_PARTIAL)
    expect(both.flags & FLAG_ESCROW).toBe(FLAG_ESCROW)
  })

  test('stretchCurve packs the shapes the spec names', () => {
    const head = (h: Hex) => h.slice(0, 10)
    expect(head(stretchCurve(0, 1))).toBe('0x0000ffff')
    expect(head(stretchCurve(0, 0.25))).toBe('0x00004000')
    expect(head(stretchCurve(0.5, 0))).toBe('0x80000000')
    expect(head(stretchCurve(0.25, 0.25))).toBe('0x40004000')
    // Twenty-eight bytes of nothing, for the kinds that are documented and not built.
    expect(stretchCurve(0.25, 0.25).slice(10)).toBe('00'.repeat(28))
  })

  test('a fraction outside the window is clamped, and a number that is not one is refused', () => {
    expect(stretchCurve(-1, 2)).toBe(stretchCurve(0, 1))
    expect(() => stretchCurve(Number.NaN, 0)).toThrow(/finite/)
    expect(() => stretchCurve(0, Number.POSITIVE_INFINITY)).toThrow(/finite/)
  })

  /**
   * The property the field was designed around, and the reason kind 1 costs a maker nothing to
   * name: an intent that carries the zero word prices exactly as it did before `curve` existed.
   */
  test('the zero word is the shipped straight line, at every instant of a fuzzed window', () => {
    const next = walker(0x9e3779b97f4a7c15n)
    for (let run = 0; run < 256; run++) {
      const span = (next() % 100_000n) + 1n
      const start = 1_600_000_000n + (next() % 1_000_000n)
      const hi = (next() % (10n ** 24n)) + 1n
      const lo = next() % hi
      const line: Intent = {
        ...canonical,
        minOutStart: hi,
        minOutEnd: lo,
        startTime: start,
        endTime: start + span,
        flags: KIND_LINEAR,
        curve: CURVE_LINEAR,
      }
      const stretch: Intent = { ...line, flags: KIND_STRETCH }
      for (const at of [start, start + 1n, start + span / 3n, start + span - 1n, start + span]) {
        expect(minOutAt(stretch, at)).toBe(minOutAt(line, at))
      }
    }
  })

  /**
   * A reserved kind prices as the line, because the contract branches on `KIND_STRETCH` alone.
   *
   * The two agree deliberately. A maker who sets bits nothing implements has signed the straight
   * line and wasted the bytes, which is the maker's own waste and not a failure — and the day a
   * settlement implements one of these, both readers change together.
   */
  test('a reserved kind prices as the line, whatever the word holds', () => {
    const word = `0x${'a5'.repeat(32)}` as Hex
    const mid = 1_700_043_200n
    const line = minOutAt(shaped(CURVE_LINEAR, KIND_LINEAR), mid)
    expect(minOutAt(shaped(word, KIND_KNOTS), mid)).toBe(line)
    expect(minOutAt(shaped(word, KIND_CUBIC), mid)).toBe(line)
    // And the stretch does not, which is what makes the line above a claim rather than a tautology.
    expect(minOutAt(shaped(word, KIND_STRETCH), mid)).not.toBe(line)
  })

  test('a stretch rests at the ceiling, falls, and rests at the floor', () => {
    const i = shaped(stretchCurve(0.25, 0.25))
    const [corner1, corner2] = breakpointsOf(i)
    expect(corner1 - i.startTime).toBe(21_600n)
    expect(corner2 - i.startTime).toBe(43_200n)
    expect(minOutAt(i, corner1)).toBe(i.minOutStart)
    expect(minOutAt(i, corner1 + 1n)).toBeLessThan(i.minOutStart)
    expect(minOutAt(i, corner2 + 1n)).toBe(i.minOutEnd)
    // The fall is a straight line between the corners, so its middle is the middle of the range.
    // Not to the wei: a corner is a fraction of 65,535 of the window and the timestamps either
    // side of it are whole seconds, so the two roundings leave a hundredth of one per cent.
    const middle = minOutAt(i, (corner1 + corner2) / 2n)
    const half = (i.minOutStart + i.minOutEnd) / 2n
    const slack = (i.minOutStart - i.minOutEnd) / 10_000n
    expect(middle - half).toBeLessThan(slack)
    expect(half - middle).toBeLessThan(slack)
  })

  test('a length of zero runs the fall to the end of the window', () => {
    const i = shaped(stretchCurve(0.5, 0))
    // One corner, not two: the fall ends at the close, and the close is not a knot.
    expect(breakpointsOf(i)).toEqual([i.startTime + 43_200n])
    expect(minOutAt(i, i.startTime + 43_200n)).toBe(i.minOutStart)
    expect(minOutAt(i, i.endTime - 1n)).toBeGreaterThan(i.minOutEnd)
    expect(minOutAt(i, i.endTime)).toBe(i.minOutEnd)
  })

  test('a curve with no corner inside the window has no breakpoints', () => {
    // Kind 0 never has one. A stretch over the whole window has both of its corners on the two
    // ends, and an end is not a knot: the solver already probes both.
    expect(breakpointsOf(shaped(CURVE_LINEAR, KIND_LINEAR))).toEqual([])
    expect(breakpointsOf(shaped(CURVE_LINEAR, KIND_STRETCH))).toEqual([])
    expect(breakpointsOf(shaped(stretchCurve(0, 1)))).toEqual([])
    // Nor does a kind whose branch nothing has built, whatever the word says.
    expect(breakpointsOf(shaped(`0x${'ff'.repeat(32)}`, KIND_KNOTS))).toEqual([])
  })

  /**
   * The envelope, over the whole word.
   *
   * There is no validation rule under `curve` — no `_termsOk` clause, no length check, nothing —
   * so this property is the only thing standing between a hostile word and an answer outside the
   * two numbers the maker signed. The contract fuzzes the same claim in Solidity.
   */
  test('no word takes the price outside the two ends, or makes it rise', () => {
    const next = walker(0x2545f4914f6cdd1dn)
    for (let run = 0; run < 256; run++) {
      const word = `0x${(next() % (1n << 64n)).toString(16).padStart(16, '0')}${'00'.repeat(24)}` as Hex
      const i = shaped(word)
      let previous = minOutAt(i, i.startTime)
      for (let at = i.startTime; at <= i.endTime; at += 997n) {
        const price = minOutAt(i, at)
        expect(price).toBeLessThanOrEqual(previous)
        expect(price).toBeGreaterThanOrEqual(i.minOutEnd)
        expect(price).toBeLessThanOrEqual(i.minOutStart)
        previous = price
      }
    }
  })

  /**
   * The degenerate word, which is the one place the arithmetic could have divided by zero.
   *
   * A `startF` of 65,535 with a length of zero folds to a length of zero, and the denominator is
   * the length times the span. The guard above the division is what saves it: the fall begins
   * after the last second of the window, so the price never leaves the ceiling.
   */
  test('a fall that begins after the window ends never divides by zero', () => {
    const i = shaped(`0x${'ffff'}${'0000'}${'00'.repeat(28)}` as Hex)
    for (const at of [i.startTime, i.startTime + 1n, i.endTime - 1n]) {
      expect(minOutAt(i, at)).toBe(i.minOutStart)
    }
    expect(minOutAt(i, i.endTime)).toBe(i.minOutEnd)
  })

  /** A flat intent is flat under every kind, which is what `RfqVenue`'s mirror check rests on. */
  test('an intent whose two ends agree is flat whatever its curve says', () => {
    const flat = { ...shaped(`0x${'7c'.repeat(32)}`), minOutEnd: 3_000n * 10n ** 18n }
    for (const at of [flat.startTime, flat.startTime + 1n, flat.endTime - 1n, flat.endTime]) {
      expect(minOutAt(flat, at)).toBe(flat.minOutStart)
    }
  })
})

describe('the wire codec', () => {
  const sig = ('0x' + '11'.repeat(65)) as Hex

  const roundTrip = (s: SignedIntent) => {
    const decoded = decodeIntent(encodeIntent(s))
    expect(decoded).not.toBeNull()
    return decoded as SignedIntent
  }

  test('a plain intent survives the trip', () => {
    const out = roundTrip({ ...canonical, signature: sig })
    for (const k of Object.keys(canonical) as (keyof Intent)[]) {
      expect(String(out[k]).toLowerCase()).toBe(String(canonical[k]).toLowerCase())
    }
    expect(out.signature).toBe(sig)
  })

  test('a recipient equal to the maker is not written twice', () => {
    const same: SignedIntent = { ...canonical, recipient: canonical.maker, signature: sig }
    const other: SignedIntent = { ...canonical, signature: sig }
    expect(encodeIntent(same).length).toBeLessThan(encodeIntent(other).length)
    expect(roundTrip(same).recipient.toLowerCase()).toBe(canonical.maker.toLowerCase())
  })

  test('a permit rides along and comes back whole', () => {
    const permitSig = ('0x' + '22'.repeat(65)) as Hex
    const withPermit: SignedIntent = {
      ...canonical,
      signature: sig,
      permit: { value: 12345678901234567890n, deadline: 1_800_000_000n, signature: permitSig },
    }
    const out = roundTrip(withPermit)
    expect(out.permit).toEqual(withPermit.permit)
    expect(out.auth).toBeUndefined()
  })

  test('a permit and an authorization are different payloads', () => {
    // They share the shape — two varints and a 65-byte signature — so only the kind byte tells
    // them apart. Decoding one as the other would hand a fill the wrong struct entirely.
    const extra = ('0x' + '22'.repeat(65)) as Hex
    const withPermit: SignedIntent = {
      ...canonical,
      signature: sig,
      permit: { value: 7n, deadline: 8n, signature: extra },
    }
    const withAuth: SignedIntent = {
      ...canonical,
      signature: sig,
      auth: { validAfter: 7n, validBefore: 8n, signature: extra },
    }
    expect(encodeIntent(withPermit)).not.toBe(encodeIntent(withAuth))
    expect(roundTrip(withPermit).auth).toBeUndefined()
    expect(roundTrip(withAuth).permit).toBeUndefined()
  })

  test('a permit2 transfer rides along and comes back whole', () => {
    // A contract wallet's ERC-1271 answer is not 65 bytes, and Permit2 reads one — so this
    // signature is length-prefixed like the maker's own and unlike an EIP-2612 permit's.
    const walletSig = ('0x' + '44'.repeat(96)) as Hex
    const withPermit2: SignedIntent = {
      ...canonical,
      flags: canonical.flags | FLAG_PERMIT2,
      signature: sig,
      permit2: {
        token: canonical.tokenIn,
        amount: canonical.amountIn,
        deadline: 1_800_000_000n,
        signature: walletSig,
      },
    }
    const out = roundTrip(withPermit2)
    // The token comes back lowercased, like every other address the codec carries.
    expect(out.permit2).toEqual({
      ...withPermit2.permit2!,
      token: canonical.tokenIn.toLowerCase() as Address,
    })
    expect(out.permit).toBeUndefined()
    expect(out.auth).toBeUndefined()
    // The nonce is not on the wire at all: it is the intent's `authNonce`, or its hash, and
    // `encodeArming` derives it where the chain id is known.
    expect(Object.keys(out.permit2!).sort()).toEqual(
      ['amount', 'deadline', 'signature', 'token'],
    )
  })

  test('a permit costs bytes, so a plain intent never pays for one', () => {
    const bare = encodeIntent({ ...canonical, signature: sig })
    const withPermit = encodeIntent({
      ...canonical,
      signature: sig,
      permit: { value: 1n, deadline: 2n, signature: ('0x' + '22'.repeat(65)) as Hex },
    })
    expect(withPermit.length).toBeGreaterThan(bare.length)
  })

  test('an open intent carries no executor', () => {
    const open: SignedIntent = { ...canonical, executor: ZERO, signature: sig }
    expect(encodeIntent(open).length).toBeLessThan(encodeIntent({ ...canonical, signature: sig }).length)
    expect(roundTrip(open).executor).toBe(ZERO)
  })

  test('boundary values survive', () => {
    const edge: SignedIntent = {
      ...canonical,
      amountIn: 2n ** 255n,
      minOutStart: 0n,
      minOutEnd: 0n,
      nonce: 0n,
      flags: FLAG_PARTIAL | FLAG_ESCROW,
      signature: sig,
    }
    const out = roundTrip(edge)
    expect(out.amountIn).toBe(edge.amountIn)
    expect(out.minOutStart).toBe(0n)
    expect(out.nonce).toBe(0n)
    expect(out.flags).toBe(FLAG_PARTIAL | FLAG_ESCROW)
  })

  test('an intent with an authorization survives', () => {
    const withAuth: SignedIntent = {
      ...canonical,
      signature: sig,
      auth: {
        validAfter: 0n,
        validBefore: 1_800_000_000n,
        signature: ('0x' + '22'.repeat(65)) as Hex,
      },
    }
    const out = roundTrip(withAuth)
    expect(out.auth?.validBefore).toBe(1_800_000_000n)
    expect(out.auth?.signature).toBe(('0x' + '22'.repeat(65)) as Hex)
  })

  /**
   * A signature of any length survives, which is what version 3 bought.
   *
   * Both signatures were a fixed 65 bytes, so an ERC-1271 wallet's answer had nowhere to go: a
   * smart account could sign an intent it could not post, and could not authorize the gasless
   * transfer that funds one. A compact 64-byte answer and a long multisig one both ride now.
   */
  test('a contract wallet signature of any length rides on the wire', () => {
    for (const width of [1, 64, 65, 200, 600]) {
      const wide = ('0x' + '33'.repeat(width)) as Hex
      const out = roundTrip({
        ...canonical,
        signature: wide,
        auth: { validAfter: 0n, validBefore: 1_800_000_000n, signature: wide },
      })
      expect(out.signature).toBe(wide)
      expect(out.auth?.signature).toBe(wide)
    }
  })

  test('a named 3009 nonce survives the trip, and zero means the intent hash', () => {
    const named = ('0x' + 'ab'.repeat(32)) as Hex
    expect(roundTrip({ ...canonical, authNonce: named, signature: sig }).authNonce).toBe(named)
    const bare = roundTrip({ ...canonical, authNonce: ZERO_HASH, signature: sig })
    expect(bare.authNonce).toBe(ZERO_HASH)
    expect(authNonceOf(bare, 369)).toBe(intentHashOf(bare, 369))
    expect(authNonceOf({ ...bare, authNonce: named }, 369)).toBe(named)
  })

  test('a minimum fill survives the trip, and zero means no floor', () => {
    expect(roundTrip({ ...canonical, signature: sig }).minFill).toBe(canonical.minFill)
    expect(roundTrip({ ...canonical, minFill: 0n, signature: sig }).minFill).toBe(0n)
    expect(roundTrip({ ...canonical, minFill: 2n ** 255n, signature: sig }).minFill).toBe(
      2n ** 255n,
    )
  })

  test('a payload stays small enough for the board to be cheap', () => {
    // Proof of work is priced per byte, so the codec's job is to stay small. Three fields are
    // optional: a recipient that is not the maker and a pinned executor (20 bytes each), and a
    // named fee config (its 32-byte hash). A minimum fill is a fourth, and costs its own width. A curve
    // is a sixth, and it is the only one whose width the maker chooses.
    const bare = (o: Partial<Intent> = {}) =>
      (encodeIntent({
        ...canonical,
        recipient: canonical.maker,
        executor: ZERO,
        feeConfig: ZERO_HASH,
        feeRate: 0n,
        feeRateIn: 0n,
        feeRateProceeds: 0n,
        minFill: 0n,
        authNonce: ZERO_HASH,
        curve: CURVE_LINEAR,
        signature: sig,
        ...o,
      }).length -
        2) /
      2

    const smallest = bare()
    // What this app actually posts: the maker is the recipient, anyone may fill it, and the
    // frontend names where the fee goes. That last one is the only optional field we always pay
    // for, and 20 bytes is what it costs on every grind.
    const ours = bare({ feeConfig: canonical.feeConfig })
    const worst = bare({ recipient: canonical.recipient, executor: canonical.executor, feeConfig: canonical.feeConfig })

    expect(smallest).toBeLessThan(185)
    expect(ours).toBeLessThan(215)
    expect(worst).toBeLessThan(255)
    expect(ours - smallest).toBe(32)
    expect(worst - smallest).toBe(72) // the config hash and the two optional addresses
    // The extra take points cost nothing until they are named: P2 is eight bytes, and P1 and P3
    // share one extension byte and add eight apiece.
    expect(bare({ feeConfig: canonical.feeConfig, feeRate: 1n }) - ours).toBe(8)
    expect(bare({ feeConfig: canonical.feeConfig, feeRateIn: 1n }) - ours).toBe(1 + 8)
    expect(bare({ feeConfig: canonical.feeConfig, feeRateIn: 1n, feeRateProceeds: 1n }) - ours).toBe(1 + 16)

    // A floor is the fourth optional field, and an intent that names none pays nothing for it.
    // Its length prefix makes a small floor cheaper than a large one.
    expect(bare({ minFill: 1n }) - smallest).toBe(2)
    expect(bare({ minFill: canonical.minFill }) - smallest).toBeGreaterThan(2)

    // A named 3009 nonce is the fifth, and the dearest thing on this wire at 32 bytes. Almost no
    // intent names one, which is why it rides behind a presence bit like the rest.
    expect(bare({ authNonce: canonical.authNonce }) - smallest).toBe(32)

    // The curve is the sixth, and a length byte is what makes it cheap. A varint would strip
    // *leading* zeros and a curve's zeros are at the trailing end, so a four-byte stretch would
    // have cost thirty-three bytes rather than five.
    expect(bare({ curve: `0x${'ff'.repeat(32)}` }) - smallest).toBe(33)

    // A stretch is five bytes at worst and often four, because the codec drops trailing zeros
    // and a corner on a round fraction of the window ends in one. Both are the same curve to a
    // reader: the decoder pads the word back out.
    expect(bare({ curve: stretchCurve(0, 0.25) }) - smallest).toBe(4)
    expect(bare({ curve: stretchCurve(0, 16_385 / CURVE_ONE) }) - smallest).toBe(5)

    // Proof of work is linear in bytes, and this is the whole of what the field costs the grind.
    // The board's own formula, with the multiplier and the divisor cancelled out of the ratio:
    // five more bytes on a typical post is under a third of one per cent more work.
    const work = (bytes: number) => 2 ** 24 + bytes * 10_000
    expect((work(smallest + 25) / work(smallest + 20) - 1) * 100).toBeLessThan(0.3)
  })

  /**
   * Every width a curve can be, encoded and decoded back to the identical word.
   *
   * The codec writes a length byte and that many bytes from the front of the word, and the
   * decoder pads the rest with zeros. So a word that ends in zeros comes back whole and a word
   * that does not costs its full width. Both directions are checked here, at every width from
   * the zero word to a full thirty-two bytes.
   */
  test('a curve of any width survives the trip, byte for byte', () => {
    expect(roundTrip({ ...canonical, curve: CURVE_LINEAR, signature: sig }).curve).toBe(
      CURVE_LINEAR,
    )
    expect(roundTrip({ ...canonical, curve: stretchCurve(0.25, 0.25), signature: sig }).curve).toBe(
      stretchCurve(0.25, 0.25),
    )
    for (let width = 1; width <= 32; width++) {
      // A trailing non-zero byte, so the width is the width the codec has to carry.
      const word = `0x${'5a'.repeat(width)}${'00'.repeat(32 - width)}` as Hex
      const out = roundTrip({ ...canonical, curve: word, signature: sig })
      expect(out.curve).toBe(word)
      // And the bytes it cost: one for the length, then the significant ones.
      const bare = encodeIntent({ ...canonical, curve: CURVE_LINEAR, signature: sig })
      const full = encodeIntent({ ...canonical, curve: word, signature: sig })
      expect((full.length - bare.length) / 2).toBe(width + 1)
    }
  })

  test('a word of nothing but zeros costs no byte at all', () => {
    // The presence bit says it, so the field is not written. A maker who names kind 1 and leaves
    // the word alone pays the board exactly what they paid before curves existed.
    const line = encodeIntent({ ...canonical, curve: CURVE_LINEAR, signature: sig })
    const kinded = encodeIntent({
      ...canonical,
      flags: canonical.flags | KIND_STRETCH,
      curve: CURVE_LINEAR,
      signature: sig,
    })
    expect(kinded.length).toBe(line.length)
  })

  /**
   * The version byte, and what it is for.
   *
   * `curve` sits in the head every reader parses, so a reader that has never heard of it cannot
   * skip it the way it skips an unknown tail — every byte after the field would be misaligned.
   * The version byte is how such a reader is told to drop the post instead, and `decodeIntent`
   * has refused an unknown version since version 1. So the version 3 reader that shipped last
   * month refuses this post by the same line that refuses a version 3 post here.
   */
  test('a reader of another version drops this post rather than misreading it', () => {
    const wire = encodeIntent({ ...canonical, curve: stretchCurve(0.25, 0.25), signature: sig })
    expect(wire.slice(0, 4)).toBe('0x05')
    for (const other of ['01', '02', '03', '04', 'ff']) {
      const relabelled = `0x${other}${wire.slice(4)}` as Hex
      expect(decodeIntent(relabelled)).toBeNull()
    }
  })

  test('a curve length byte outside 1..32 is refused, and so is a truncated word', () => {
    const wire = encodeIntent({ ...canonical, curve: stretchCurve(0.25, 0.25), signature: sig })
    const bytes = hexToBytes(wire)
    // The field, found by the bytes it is: a length of three, then `40 00 40`. The encoder drops
    // the trailing zero of `0x40004000`, which is why the length is three and not four.
    const at = bytes.findIndex(
      (b, k) => b === 3 && bytes[k + 1] === 0x40 && bytes[k + 2] === 0x00 && bytes[k + 3] === 0x40,
    )
    const rewrite = (len: number): Hex => {
      const copy = Uint8Array.from(bytes)
      copy[at] = len
      return bytesToHex(copy)
    }
    expect(bytes[at]).toBe(3)
    // A length of zero says "the straight line", which a clear presence bit already said, and a
    // length above thirty-two is not a word. Both are a writer this reader does not know.
    expect(decodeIntent(rewrite(0))).toBeNull()
    expect(decodeIntent(rewrite(33))).toBeNull()
    expect(decodeIntent(rewrite(255))).toBeNull()
    // A tail that promises more bytes than the message holds runs off the end.
    expect(decodeIntent(rewrite(32))).toBeNull()
  })

  test('rubbish decodes to null rather than throwing', () => {
    for (const bad of ['0x', '0x00', '0x0101', '0x' + 'ff'.repeat(80), '0xzz'] as Hex[]) {
      expect(() => decodeIntent(bad)).not.toThrow()
    }
    // An older payload is refused rather than read as a version 4 one. The archive still holds
    // versions 1 to 3 and they decode to null, which is what "not a well-formed intent" means.
    expect(decodeIntent('0x0201' as Hex)).toBeNull()
    expect(decodeIntent('0x0301' as Hex)).toBeNull()
  })

  test('a truncated payload decodes to null', () => {
    const full = encodeIntent({ ...canonical, signature: sig })
    for (let cut = 4; cut < full.length - 2; cut += 37) {
      expect(decodeIntent(full.slice(0, full.length - cut) as Hex)).toBeNull()
    }
  })
})

describe('signature verification', () => {
  const account = privateKeyToAccount(generatePrivateKey())

  /**
   * A settlement address for this block, so the domain never depends on what the registry holds
   * for 369. Mainnet has no contract yet and gets one soon, and neither state should decide
   * whether signature recovery works. It is also what production signs against: a real address,
   * not the zero one.
   */
  const SETTLEMENT: Address = '0x00000000000000000000000000000000000dead1'

  beforeAll(() => setSettlementOverride(369, SETTLEMENT))
  afterAll(() => setSettlementOverride(369, null))

  /**
   * The domain comes from `domain(369)` and is never restated here.
   *
   * `verifyIntent` recovers against that same domain, so the two can only ever agree. Restating
   * the domain is what rots the negative tests below: once the two drift apart, every recovery
   * fails and those tests pass on the mismatch rather than on the tampering they name.
   */
  const sign = async (i: Intent) =>
    signIntent(account, i, { domain: domain(369), preimage: PREIMAGE })

  test('a real signature verifies', async () => {
    const i: Intent = { ...canonical, maker: account.address, recipient: account.address }
    const signed: SignedIntent = { ...i, signature: await sign(i) }
    expect(await verifyIntent(signed, 369)).toBe(true)
  })

  test('a tampered amount does not', async () => {
    const i: Intent = { ...canonical, maker: account.address, recipient: account.address }
    const signature = await sign(i)
    // The untouched terms verify first. Without that control a wrong domain fails both lines,
    // and the test below goes green while proving nothing about the amount.
    expect(await verifyIntent({ ...i, signature }, 369)).toBe(true)
    expect(await verifyIntent({ ...i, amountIn: i.amountIn + 1n, signature }, 369)).toBe(false)
  })

  test('another signer does not', async () => {
    const stranger = privateKeyToAccount(generatePrivateKey())
    const i: Intent = { ...canonical, maker: stranger.address, recipient: stranger.address }
    const signature = await sign(i) // signed by `account`, claimed by `stranger`
    // The control: the same helper and the same terms, with the real signer as the maker. It
    // verifies, so the failure below is the wrong maker and not a domain nothing can match.
    const mine: Intent = { ...i, maker: account.address }
    expect(await verifyIntent({ ...mine, signature: await sign(mine) }, 369)).toBe(true)
    expect(await verifyIntent({ ...i, signature }, 369)).toBe(false)
  })

  test('the key survives a round trip through the codec', async () => {
    const i: Intent = { ...canonical, maker: account.address, recipient: account.address }
    const signed: SignedIntent = { ...i, signature: await sign(i) }
    const decoded = decodeIntent(encodeIntent(signed)) as SignedIntent
    expect(intentKey(decoded)).toBe(intentKey(signed))
    expect(await verifyIntent(decoded, 369)).toBe(true)
  })
})

/**
 * The two windows a gasless intent lives inside, and the fact that nothing on chain compares
 * them.
 *
 * `_termsOk` reads `startTime` and `endTime`. The token reads `validAfter` and `validBefore`. So
 * a maker can sign an authorization that opens after their own offer expires, the settlement
 * accepts the intent, and every arming attempt reverts inside the token and comes back
 * `EscrowShort` — which is also what a spent nonce, a taxed token and an empty wallet look like.
 * The settlement's own header calls the mismatch invisible from outside. It is visible here.
 */
describe('where an intent and its authorization overlap', () => {
  const span = { startTime: 1_000n, endTime: 2_000n }

  test('EIP-3009 is exclusive at both ends, so a bound is not a usable second', () => {
    expect(authUsableWindow({ validAfter: 100n, validBefore: 200n })).toEqual({
      from: 101n,
      until: 199n,
    })
  })

  test('an intent with no authorization is bounded by its own window alone', () => {
    expect(liveWindow(span)).toEqual({ from: 1_000n, until: 2_000n })
  })

  test('a wider authorization takes nothing away', () => {
    const w = liveWindow(span, { validAfter: 0n, validBefore: 9_999n })
    expect(w).toEqual({ from: 1_000n, until: 2_000n })
    expect(isDeadWindow(w)).toBe(false)
  })

  test('a narrower one is the one that binds', () => {
    expect(liveWindow(span, { validAfter: 1_200n, validBefore: 1_800n })).toEqual({
      from: 1_201n,
      until: 1_799n,
    })
  })

  /** The offer that reaches the board healthy and can never fill. */
  test('an authorization that opens after the offer expires leaves no second at all', () => {
    const w = liveWindow(span, { validAfter: 5_000n, validBefore: 6_000n })
    expect(isDeadWindow(w)).toBe(true)
  })

  test('and so does one that expired before the offer opened', () => {
    expect(isDeadWindow(liveWindow(span, { validAfter: 0n, validBefore: 500n }))).toBe(true)
  })

  /** Nothing about the intent's own terms is wrong in either case. */
  test('while the intent alone looks perfectly healthy', () => {
    expect(isDeadWindow(liveWindow(span))).toBe(false)
  })

  /**
   * Bounds one second outside the seconds they mean make the token's window exactly the
   * intent's. This is the weld the sign form signs.
   */
  test('bounds set one second outside give the offer back its whole window', () => {
    expect(liveWindow(span, { validAfter: 999n, validBefore: 2_001n })).toEqual({
      from: 1_000n,
      until: 2_000n,
    })
  })
})

/**
 * The zero `verifyingContract` a chain with no settlement produces, and why signing under it is
 * refused while reading under it is not.
 *
 * A signature made under that domain is bound to no contract. Nothing can spend it, the deploy
 * that follows cannot rescue it — the address it names is not the one that ships — and the board
 * carries it looking exactly like an offer. Seven reached the public mainnet archive. So the
 * refusal sits under every signature rather than in front of one form.
 *
 * Reading is the other direction and stays open. An archive holds intents signed against a
 * contract that has since moved, and `verifyIntent` and `intentHashOf` have to reproduce their
 * digests to say so.
 */
describe('the signing domain', () => {
  /** Not deployed, as an override, so this keeps its meaning on the day mainnet ships. */
  const NONE: Address = '0x0000000000000000000000000000000000000000'
  const FORK: Address = '0x00000000000000000000000000000000000f0f0f'

  afterAll(() => setSettlementOverride(369, null))

  test('refuses a chain whose settlement is the zero address', () => {
    setSettlementOverride(369, NONE)
    expect(() => signingDomain(369)).toThrow(/not deployed/)
  })

  test('while reading the same chain still works', () => {
    setSettlementOverride(369, NONE)
    expect(domain(369).verifyingContract).toBe(NONE)
    expect(() => intentHashOf(canonical, 369)).not.toThrow()
  })

  test('and answers the resolver, not the registry, once one exists', () => {
    setSettlementOverride(369, FORK)
    expect(signingDomain(369)).toEqual(domain(369))
    expect(signingDomain(369).verifyingContract).toBe(FORK)
  })
})

/**
 * A signature this package produced, and the contract that has to accept it.
 *
 * The fixture block at the top of this file pins the two languages to the same **digest**, which
 * is most of the story and not all of it. A digest is a number both sides can agree on while
 * neither has ever produced a signature the other would take: `intentHashOf` can match perfectly
 * and this package could still sign under a domain the contract does not build, because until now
 * nothing took bytes out of one language and put them through the other's verifier.
 *
 * So the vector below is a real signature, made by viem over the fixture's canonical intent, under
 * the domain of the settlement `Fixture.t.sol` deploys. `test_ATypeScriptSignatureRecoversOnChain`
 * in that file takes these same bytes and asks the contract's own recovery to name the signer —
 * the operation `_validSignature` runs on every fill. This half asserts the bytes are what this
 * package makes today, so the two halves cannot drift apart silently: change the type hash or a
 * field and this fails here, in TypeScript, rather than on chain months later.
 *
 * Regenerate both halves together whenever `Intent` changes, the same moment the fixture is
 * regenerated.
 */
describe('a signature the chain accepts, against the Solidity fixture', () => {
  /**
   * Anvil's first published account. `app/scripts/lab/up.sh` signs the whole local lab with this
   * key and `docs/ADDRESSES.md` names it: it is published in every foundry document and holds
   * nothing on any real chain. It is here so anybody can reproduce the vector rather than trust it.
   */
  const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  const SIGNER: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
  const DIGEST: Hex = '0x3fbb49a4c76f436c99dc97664bec9a08d21b649fcd854f7f5274f27deadcb4a7'
  const SIGNATURE: Hex =
    '0xd4620e5aad5d46ea3f5428dcdc4fe4b140969b5fceae6b3cfb66fc384bc226ac51c12bc761e62ba2bb78e9c41e793f8eabd61fc63dc48a5e27a0ab8948370e401b'

  /**
   * The fixture's intent with one field moved. A signature can only be checked against the maker
   * it names, and the fixture's maker is a literal nobody holds the key to.
   */
  const signed = { ...canonical, maker: SIGNER }

  beforeAll(() => setSettlementOverride(369, F.verifyingContract))
  afterAll(() => setSettlementOverride(369, null))

  test('the digest is the one the contract computes', () => {
    // `Fixture.t.sol` asserts the same number against `settlement.hashIntent(i)`.
    expect(intentHashOf(signed, 369)).toBe(DIGEST)
  })

  test('the pinned signature is the one this package makes today', async () => {
    const account = privateKeyToAccount(KEY)
    expect(account.address).toBe(SIGNER)
    expect(
      await signIntent(account, signed, { domain: domain(369), preimage: PREIMAGE }),
    ).toBe(SIGNATURE)
  })

  test('and this package verifies it', async () => {
    expect(await verifyIntent({ ...signed, signature: SIGNATURE }, 369)).toBe(true)
  })

  test('while one tampered byte is refused', async () => {
    // Without this the test above passes for a verifier that answers true to everything.
    const tampered = (SIGNATURE.slice(0, 10) +
      (SIGNATURE[10] === 'a' ? 'b' : 'a') +
      SIGNATURE.slice(11)) as Hex
    expect(tampered).not.toBe(SIGNATURE)
    expect(await verifyIntent({ ...signed, signature: tampered }, 369)).toBe(false)
  })
})

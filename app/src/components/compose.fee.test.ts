import { describe, expect, test } from 'vitest'
import { getAddress } from 'viem'
import {
  BASIS_POINT,
  decodeIntent,
  defaultFees,
  encodeIntent,
  formatFeeRate,
  grossForNet,
  hashFeeConfig,
  knownFeeConfig,
  MAX_FEE_RATE,
  singleFeeConfig,
  PERCENT,
} from '@prove.cash/sdk'
import { asAddress } from './Compose'
import {
  acknowledgeDefault,
  chargedRate,
  feeFault,
  feeShares,
  needsAck,
  feeInside,
  feeTerms,
  feeWarning,
  feeWhereOf,
  forTheBoard,
  netOf,
  shownRate,
  type DefaultRead,
} from '../lib/fee'
import { t } from '../lib/i18n'

/**
 * An address a maker types: the RFQ counterparty, since the fee destination is the chain's defaults.
 *
 * It is a signed term, and nothing on chain will tell them they got it wrong. So the form has one
 * job here — take what a real maker pastes, and refuse what a typo produces.
 */
describe('a typed address', () => {
  const burn = '0xd6cA7ee047a6F45d20d2962E4394E070cF27724F'

  test('a checksummed address comes back as itself', () => {
    expect(asAddress(burn)).toBe(burn)
  })

  test('surrounding space is not a mistake', () => {
    expect(asAddress(`  ${burn}\n`)).toBe(burn)
  })

  /** What `cast`, a CSV and half the explorers hand you. It carries no checksum to check. */
  test('an all-lowercase address is taken as typed, and checksummed on the way through', () => {
    expect(asAddress(burn.toLowerCase())).toBe(getAddress(burn))
  })

  test('an all-uppercase body is taken the same way', () => {
    expect(asAddress(`0x${burn.slice(2).toUpperCase()}`)).toBe(getAddress(burn))
  })

  /**
   * The case that pays for the whole function. A maker pastes from an explorer, then edits one
   * character. The capitals no longer agree with the digits, and EIP-55 says so.
   */
  test('a mixed-case address whose checksum fails is refused', () => {
    const typo = `${burn.slice(0, -1)}0`
    expect(getAddress(typo.toLowerCase())).not.toBe(typo) // the capitals disagree
    expect(asAddress(typo)).toBeNull()
  })

  test.each([
    ['', 'nothing'],
    ['0x', 'a prefix'],
    ['d6cA7ee047a6F45d20d2962E4394E070cF27724F', 'no prefix'],
    ['0xd6cA7ee047a6F45d20d2962E4394E070cF27724', 'one digit short'],
    ['0xd6cA7ee047a6F45d20d2962E4394E070cF27724FF', 'one digit long'],
    ['0xd6cA7ee047a6F45d20d2962E4394E070cF27724G', 'not hex'],
    ['pulsex.eth', 'a name this app cannot resolve'],
  ])('%s is refused — %s', (text) => {
    expect(asAddress(text)).toBeNull()
  })

  /** The zero address is an answer the contract understands. */
  test('the zero address is an answer, not a mistake', () => {
    expect(asAddress('0x0000000000000000000000000000000000000000')).toBe(
      '0x0000000000000000000000000000000000000000',
    )
  })

})

/**
 * The fee terms a form signs: the chain's defaults, and the maker's own cut if they typed one.
 *
 * There is nothing to pick. The offer signs the defaults' config hash at the defaults' three
 * rates, and a typed rate replaces only the proceeds rate (P3), so it can add to the fee and never
 * lower the defaults'.
 */
describe('the fee terms a form signs', () => {
  const def = defaultFees(943)
  const hash = hashFeeConfig(def.config)
  const read: DefaultRead = { state: 'read', def, source: 'registry' }
  /** Three tenths of one per cent, as a fraction of one ether. */
  const rate = 3_000_000_000_000_000n

  test('an empty rate signs the defaults as they stand', () => {
    expect(feeTerms({ rate: 0n, read })).toEqual({
      feeConfig: hash,
      feeRateIn: def.rates.handover,
      feeRate: def.rates.output,
      feeRateProceeds: def.rates.proceeds,
    })
  })

  test('a typed rate is the maker’s own cut: it replaces P3 and leaves P1 and P2 alone', () => {
    const terms = feeTerms({ rate, read })
    expect(terms.feeRateProceeds).toBe(rate)
    expect(terms.feeRateIn).toBe(def.rates.handover)
    expect(terms.feeRate).toBe(def.rates.output)
    expect(terms.feeConfig).toBe(hash)
  })

  test('until the defaults are read there are none to sign: the zero config at rate zero', () => {
    for (const r of [{ state: 'reading' }, { state: 'unread' }] as const) {
      const terms = feeTerms({ rate, read: r })
      expect(terms.feeConfig).toBe(`0x${'00'.repeat(32)}`)
      expect(terms.feeRateProceeds).toBe(0n)
      expect(chargedRate(terms, r)).toBeNull()
    }
  })

  test('the rate that comes out of the maker is P3 only; the filler bears P1 and P2', () => {
    expect(chargedRate(feeTerms({ rate: 0n, read }), read)).toBe(def.rates.proceeds)
    expect(chargedRate(feeTerms({ rate, read }), read)).toBe(rate)
    expect(shownRate(feeTerms({ rate, read }))).toBe(def.rates.handover + def.rates.output + rate)
  })

  test('a failed read is a refusal in words, never a quiet zero', () => {
    expect(feeFault(feeTerms({ rate: 0n, read: { state: 'unread' } }), { state: 'unread' })).toBe(
      t('sign.fee.unread'),
    )
    expect(feeFault(feeTerms({ rate: 0n, read }), read)).toBeNull()
  })

  test('a rate above one hundred per cent is refused', () => {
    expect(feeFault(feeTerms({ rate: MAX_FEE_RATE + 1n, read }), read)).not.toBeNull()
  })

  test('the fee goes to the defaults’ label, or a short address when there is none', () => {
    expect(feeWhereOf({ state: 'read', def: { ...def, label: 'burn' }, source: 'chain' })).toBe('burn')
    const { config, rates, warn } = def
    const bare = { config, rates, warn }
    expect(feeWhereOf({ state: 'read', def: bare, source: 'chain' })).toMatch(/^0x/)
    expect(feeWhereOf({ state: 'unread' })).toBe('')
  })

  /** The warning is only a warning: it never refuses, and it names the point that is high. */
  test('a rate above the defaults’ warn line warns, and does not refuse', () => {
    const high = feeTerms({ rate: def.warn.proceeds + 1n, read })
    expect(feeWarning(high, read)).toBe(
      t('sign.fee.warn', {
        rate: formatFeeRate(def.warn.proceeds + 1n),
        warn: formatFeeRate(def.warn.proceeds),
      }),
    )
    expect(feeFault(high, read)).toBeNull()
  })

  test('the defaults themselves, and a rate at the warn line, do not warn', () => {
    expect(feeWarning(feeTerms({ rate: 0n, read }), read)).toBeNull()
    expect(feeWarning(feeTerms({ rate: def.warn.proceeds, read }), read)).toBeNull()
    expect(feeWarning(feeTerms({ rate: 0n, read }), { state: 'unread' })).toBeNull()
  })
})

/**
 * The maker's guarantee, which moved out of the contract and into this form.
 *
 * `minOut` stopped being a net promise the day the fee came out of the maker's number. The form
 * keeps the promise anyway: the maker types what they will receive, and the form derives the
 * gross it signs. Every one of these tests is that derivation, checked against the settlement's
 * own arithmetic rather than against a restatement of it.
 */
describe('the gross the form signs, from the net the maker typed', () => {
  /** Ten basis points, three tenths of one per cent, one per cent, five, and a fifth. */
  const RATES = [0n, BASIS_POINT * 10n, PERCENT * 3n / 10n, PERCENT, PERCENT * 5n, MAX_FEE_RATE / 5n]
  /** A wei, a six-decimal cent, a whole six-decimal token, and a large eighteen-decimal one. */
  const NETS = [1n, 10_000n, 1_000_000n, 25_000n * 10n ** 18n, 999_999_999_999_999_999n]

  test('the maker is met or beaten at every rate and every size', () => {
    for (const rate of RATES) {
      for (const net of NETS) {
        const gross = grossForNet(net, rate)
        expect(netOf(gross, rate)).toBeGreaterThanOrEqual(net)
      }
    }
  })

  test('the overshoot never exceeds one wei of the token the maker receives', () => {
    for (const rate of RATES) {
      for (const net of NETS) {
        const gross = grossForNet(net, rate)
        // One wei of gross is the whole slack the ceiling division can introduce, and the fee
        // floors on top of it. Anything more would mean the form is asking for more than the
        // maker's promise needs.
        expect(netOf(gross, rate) - net).toBeLessThanOrEqual(1n)
      }
    }
  })

  test('a rate of zero signs the number the maker typed, to the wei', () => {
    for (const net of NETS) {
      expect(grossForNet(net, 0n)).toBe(net)
      expect(netOf(net, 0n)).toBe(net)
    }
  })

  test('the fee the form shows is the fee the settlement will book', () => {
    // `feeInside` mirrors `_quote`: it floors, so the dust of the division stays with the maker.
    expect(feeInside(1_000_000n, PERCENT)).toBe(10_000n)
    expect(feeInside(99n, PERCENT)).toBe(0n)
    expect(feeInside(1_000_000n, 0n)).toBe(0n)
    expect(feeInside(1_000_000n, MAX_FEE_RATE)).toBe(1_000_000n)
  })

  /**
   * Why the form refuses a rate before it derives anything.
   *
   * At one hundred per cent no gross pays a positive net, and `grossForNet` says so by throwing.
   * A throw inside a render is a blank page, so the rate field has to stop first — which is what
   * `sign.rate.refused` is for.
   */
  test('the ceiling is a rate the form must catch, because deriving past it throws', () => {
    expect(() => grossForNet(1_000_000n, MAX_FEE_RATE)).toThrow(RangeError)
    expect(() => grossForNet(1_000_000n, MAX_FEE_RATE + 1n)).toThrow(RangeError)
    expect(grossForNet(1_000_000n, MAX_FEE_RATE - 1n)).toBeGreaterThan(0n)
  })
})

describe('a chain default the build does not ship', () => {
  const STRANGER = '0x00000000000000000000000000000000000000aa' as const
  const unshipped: DefaultRead = {
    state: 'read',
    source: 'chain',
    unpinned: true,
    def: {
      config: singleFeeConfig(STRANGER),
      rates: { handover: 0n, output: 5n * PERCENT, proceeds: 0n },
      warn: { handover: PERCENT, output: PERCENT * 10n, proceeds: PERCENT },
    },
  }
  const hash = hashFeeConfig(unshipped.def.config)

  test('it needs an acknowledgement, per hash, and a shipped default does not', () => {
    expect(needsAck(unshipped, null)).toBe(true)
    expect(needsAck(unshipped, '0x1234')).toBe(true)
    expect(needsAck(unshipped, hash)).toBe(false)
    expect(needsAck(unshipped, hash.toUpperCase().replace('0X', '0x'))).toBe(false)
    expect(needsAck({ state: 'read', source: 'chain', def: defaultFees(943) }, null)).toBe(false)
    expect(needsAck({ state: 'reading' }, null)).toBe(false)
  })

  test('the form refuses to sign until it is acknowledged, and only for the config', () => {
    const terms = feeTerms({ rate: 0n, read: unshipped })
    expect(feeFault(terms, unshipped, null)).toBe(t('sign.fee.changed'))
    expect(feeFault(terms, unshipped, hash)).toBeNull()
    // A rate is never refused on this ground: a high typed rate is still only a warning.
    const high = feeTerms({ rate: 40n * PERCENT, read: unshipped })
    expect(feeFault(high, unshipped, hash)).toBeNull()
  })

  test('the wallet can be asked to sign it only after the maker acknowledged it', () => {
    expect(knownFeeConfig(hash)).toBeNull()
    expect(acknowledgeDefault(unshipped)).toBe(hash)
    expect(knownFeeConfig(hash)).not.toBeNull()
  })

  test('every destination is shown in full, checksummed, with its own amount', () => {
    const two: DefaultRead = {
      ...unshipped,
      def: {
        ...unshipped.def,
        config: {
          destinations: [
            '0x7cd43983a963c62add34694e83e896c5afc3333f',
            '0xd6ca7ee047a6f45d20d2962e4394e070cf27724f',
          ],
          weights: [(3n * 10n ** 18n) / 4n, 10n ** 18n / 4n],
        },
      },
    }
    const shares = feeShares(two, 1001n)
    expect(shares.map((x) => x.address)).toEqual([
      getAddress('0x7cd43983a963c62add34694e83e896c5afc3333f'),
      getAddress('0xd6ca7ee047a6f45d20d2962e4394e070cf27724f'),
    ])
    expect(shares[0]!.address).toBe('0x7cD43983A963c62Add34694E83E896c5AfC3333f')
    expect(shares.map((x) => x.amount)).toEqual([750n, 251n])
    expect(shares.reduce((a, x) => a + x.amount, 0n)).toBe(1001n)
    expect(feeShares({ state: 'reading' }, 5n)).toEqual([])
  })
})

/**
 * The wire preimage block (review finding 3): an offer that signs a config this build does not
 * bundle carries the preimage on the board, so a reader on another build can show and pay it; an
 * offer on a bundled default does not, because every byte costs proof of work.
 */
describe('what goes on the board', () => {
  const base = {
    maker: '0x00000000000000000000000000000000000000ab',
    recipient: '0x00000000000000000000000000000000000000ab',
    tokenIn: '0x00000000000000000000000000000000000000a1',
    tokenOut: '0x00000000000000000000000000000000000000b2',
    amountIn: 10n ** 18n,
    minOutStart: 2n * 10n ** 18n,
    minOutEnd: 10n ** 18n,
    startTime: 1_800_000_000n,
    endTime: 1_800_003_600n,
    executor: '0x0000000000000000000000000000000000000000',
    feeRate: 5n * 10n ** 15n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    minFill: 0n,
    authNonce: `0x${'00'.repeat(32)}`,
    flags: 1,
    nonce: 1n,
    curve: `0x${'00'.repeat(32)}`,
    signature: `0x${'11'.repeat(65)}`,
  } as const

  test('a bundled default goes without its preimage', () => {
    const cfg = defaultFees(943).config
    const out = forTheBoard({ ...base, feeConfig: hashFeeConfig(cfg), feeConfigPreimage: cfg }, 943)
    expect(out.feeConfigPreimage).toBeUndefined()
  })

  test('an acknowledged, unbundled config carries the preimage it was signed with', () => {
    const cfg = singleFeeConfig(getAddress('0x00000000000000000000000000000000000c0ffe'))
    const read: DefaultRead = {
      state: 'read',
      def: { ...defaultFees(943), config: cfg },
      source: 'chain',
      unpinned: true,
    }
    acknowledgeDefault(read)
    const out = forTheBoard({ ...base, feeConfig: hashFeeConfig(cfg) }, 943)
    expect(out.feeConfigPreimage).toEqual(cfg)
    expect(decodeIntent(encodeIntent(out))?.feeConfigPreimage).toEqual(cfg)
  })
})

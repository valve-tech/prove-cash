import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverAddress, type TypedDataDomain } from 'viem'
import {
  decodeIntent,
  defaultFees,
  encodeIntent,
  hashFeeConfig,
  intentDigest,
  isBundledFeeConfig,
  signIntent,
  withWirePreimage,
  ZERO,
  ZERO_HASH,
  type Intent,
} from '@prove.cash/sdk'
import { botFeeTerms } from './bot-fee.ts'

const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')
const domain: TypedDataDomain = {
  name: 'ProveSettlement',
  version: '1',
  chainId: 943,
  verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
}

const intentWith = (fee: NonNullable<ReturnType<typeof botFeeTerms>>['terms']): Intent => ({
  maker: account.address,
  recipient: account.address,
  tokenIn: '0x1111111111111111111111111111111111111111',
  tokenOut: '0x2222222222222222222222222222222222222222',
  amountIn: 10n ** 18n,
  minOutStart: 2n * 10n ** 18n,
  minOutEnd: 10n ** 18n,
  startTime: 1n,
  endTime: 2_000_000_000n,
  executor: ZERO,
  ...fee,
  minFill: 0n,
  authNonce: ZERO_HASH,
  curve: ZERO_HASH,
  flags: 0,
  nonce: 1n,
})

describe('botFeeTerms', () => {
  it('is null when there are no defaults to sign', () => {
    expect(botFeeTerms(null, 0n)).toBeNull()
  })

  it('carries the defaults config hash and rates, with the bot cut as P3', () => {
    const def = defaultFees(943)
    const got = botFeeTerms(def, 7n)!
    expect(got.terms.feeConfig).toBe(hashFeeConfig(def.config))
    expect(got.terms.feeRate).toBe(def.rates.output)
    expect(got.terms.feeRateIn).toBe(def.rates.handover)
    expect(got.terms.feeRateProceeds).toBe(7n)
    expect(hashFeeConfig(got.preimage)).toBe(got.terms.feeConfig)
  })

  it('lets a local key sign the defaults, and the signature recovers to the maker on the chain digest', async () => {
    const { terms, preimage } = botFeeTerms(defaultFees(943), 0n)!
    const intent = intentWith(terms)
    const signature = await signIntent(account, intent, { domain, preimage })
    expect(await recoverAddress({ hash: intentDigest(intent, domain), signature })).toBe(account.address)
  })

  it('was the bug: without the preimage a fresh process cannot sign a non-zero fee config', async () => {
    const { terms } = botFeeTerms(defaultFees(943), 0n)!
    await expect(signIntent(account, intentWith(terms), { domain })).rejects.toThrow(/preimage/)
  })

  it('posts a bundled default without the wire block, and an unshipped one with it', async () => {
    const { terms, preimage } = botFeeTerms(defaultFees(943), 0n)!
    const intent = intentWith(terms)
    const signature = await signIntent(account, intent, { domain, preimage })
    const ships = (h: `0x${string}`) => isBundledFeeConfig(h, 943)
    const bundled = decodeIntent(encodeIntent(withWirePreimage({ ...intent, signature, feeConfigPreimage: preimage }, ships)))
    expect(bundled?.feeConfigPreimage).toBeUndefined()

    const other = { destinations: ['0x00000000000000000000000000000000000000aa' as const], weights: [10n ** 18n] }
    const unshipped = botFeeTerms({ ...defaultFees(943), config: other }, 0n)!
    const i2 = intentWith(unshipped.terms)
    const s2 = await signIntent(account, i2, { domain, preimage: unshipped.preimage })
    const posted = decodeIntent(encodeIntent(withWirePreimage({ ...i2, signature: s2, feeConfigPreimage: unshipped.preimage }, ships)))
    expect(posted?.feeConfigPreimage && hashFeeConfig(posted.feeConfigPreimage)).toBe(unshipped.terms.feeConfig)
  })
})

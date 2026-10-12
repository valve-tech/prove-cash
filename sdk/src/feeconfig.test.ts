import { describe, expect, test } from 'vitest'
import fixture from '../../app/src/lib/__fixtures__/fee-config.json' with { type: 'json' }
import {
  FEE_CONFIG_FAULTS,
  FEE_CONFIG_TYPEHASH,
  WAD,
  feeConfigFault,
  feeOf,
  grossForNetCut,
  hashFeeConfig,
  singleFeeConfigHash,
  splitByWeights,
  type FeeConfig,
} from './feeconfig.js'

type Row = {
  destinations: `0x${string}`[]
  weights: string[]
  hash: `0x${string}`
  singleHash: `0x${string}`
  fault: number
  split0: { amount: string; shares: string[] }
  split1: { amount: string; shares: string[] }
  split2: { amount: string; shares: string[] }
}
const F = fixture as unknown as { typehash: `0x${string}`; configs: Record<string, Row> }
const cfg = (r: Row): FeeConfig => ({ destinations: r.destinations, weights: r.weights.map(BigInt) })

describe('fee configs, against the Solidity fixture', () => {
  test('the type hash is the contract’s', () => {
    expect(FEE_CONFIG_TYPEHASH).toBe(F.typehash)
  })

  const rows = Object.entries(F.configs)
  test('the fixture has rows to check', () => expect(rows.length).toBeGreaterThanOrEqual(5))

  test.each(rows)('%s: hash, fault and every split agree', (_name, r) => {
    const c = cfg(r)
    expect(hashFeeConfig(c)).toBe(r.hash)
    expect(feeConfigFault(c)).toBe(FEE_CONFIG_FAULTS[r.fault])
    // An invalid config has no splits in the fixture.
    for (const s of [r.split0, r.split1, r.split2].filter(Boolean)) {
      const shares = splitByWeights(BigInt(s.amount), c.weights)
      expect(shares.map(String)).toEqual(s.shares)
      expect(shares.reduce((a, b) => a + b, 0n)).toBe(BigInt(s.amount))
    }
    // A single-destination config's `singleHash` is its own hash; others re-book under theirs.
    if (c.destinations.length === 1) expect(hashFeeConfig(c)).toBe(r.singleHash)
    expect(singleFeeConfigHash(c.destinations[0])).toBe(
      hashFeeConfig({ destinations: [c.destinations[0]], weights: [WAD] }),
    )
  })
})

describe('the faults', () => {
  const a = '0x1111111111111111111111111111111111111111'
  const b = '0x2222222222222222222222222222222222222222'
  const z = '0x0000000000000000000000000000000000000000'
  test.each([
    ['NoDestinations', { destinations: [], weights: [] }],
    ['TooMany', { destinations: Array(9).fill(a), weights: Array(9).fill(WAD / 9n) }],
    ['LengthMismatch', { destinations: [a, b], weights: [WAD] }],
    ['ZeroDestination', { destinations: [z], weights: [WAD] }],
    ['NotAscending', { destinations: [b, a], weights: [WAD / 2n, WAD / 2n] }],
    ['NotAscending', { destinations: [a, a], weights: [WAD / 2n, WAD / 2n] }],
    ['ZeroWeight', { destinations: [a, b], weights: [0n, WAD] }],
    ['WeightsDoNotSumToWad', { destinations: [a, b], weights: [WAD / 2n, WAD / 3n] }],
    ['WeightsDoNotSumToWad', { destinations: [a], weights: [WAD + 1n] }],
    ['None', { destinations: [a, b], weights: [WAD / 4n, (WAD * 3n) / 4n] }],
  ] as const)('%s', (fault, c) => {
    expect(feeConfigFault(c as unknown as FeeConfig)).toBe(fault)
  })
})

describe('fee arithmetic', () => {
  test('a fee floors, and a gross always leaves at least the net', () => {
    expect(feeOf(999n, WAD / 1000n)).toBe(0n)
    expect(feeOf(1000n, WAD / 1000n)).toBe(1n)
    for (let net = 1n; net < 300n; net += 7n) {
      for (const rate of [0n, 1n, WAD / 1000n, WAD / 3n, (WAD * 99n) / 100n]) {
        const gross = grossForNetCut(net, rate)
        expect(gross - feeOf(gross, rate)).toBeGreaterThanOrEqual(net)
      }
    }
  })
})

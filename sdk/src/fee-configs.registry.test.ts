import { describe, expect, test } from 'vitest'
import file from '../../contracts/config/fee-configs.json' with { type: 'json' }
import { NETWORKS, isBundledFeeConfig } from './config.js'
import { feeConfigFault, hashFeeConfig } from './feeconfig.js'

/**
 * `config.ts` carries a copy of the chain's fee configs so a client works before it has read a
 * chain. The authority is `contracts/config/fee-configs.json` (which the deploy reads) and then
 * `FeeDefaults` itself. This holds the SDK's copy to the file, so the two cannot drift.
 */
describe('the SDK registry matches contracts/config/fee-configs.json', () => {
  for (const id of [369, 943] as const) {
    const entry = file[String(id) as '369' | '943']
    const last = entry.history[entry.history.length - 1]!
    const fees = NETWORKS[id].fees

    test(`${id}: the stray config`, () => {
      expect(fees.strayConfig.destinations.map((a) => a.toLowerCase())).toEqual(
        entry.strayConfig.destinations.map((a) => a.toLowerCase()),
      )
      expect(fees.strayConfig.weights.map(String)).toEqual(entry.strayConfig.weights)
      expect(feeConfigFault(fees.strayConfig)).toBe('None')
    })

    test(`${id}: the defaults are the last history entry`, () => {
      expect(fees.defaults.id).toBe(last.id)
      expect(hashFeeConfig(fees.defaults.config)).toBe(
        hashFeeConfig({
          destinations: last.destinations as `0x${string}`[],
          weights: last.weights.map(BigInt),
        }),
      )
      expect(fees.defaults.rates).toEqual({
        handover: BigInt(last.rates.handover),
        output: BigInt(last.rates.output),
        proceeds: BigInt(last.rates.proceeds),
      })
      expect(fees.defaults.warn).toEqual({
        handover: BigInt(last.warn.handover),
        output: BigInt(last.warn.output),
        proceeds: BigInt(last.warn.proceeds),
      })
    })

    test(`${id}: the bundled history is the file's history, entry for entry`, () => {
      expect(fees.history.length).toBe(entry.history.length)
      entry.history.forEach((h, k) => {
        const mine = fees.history[k]!
        expect(mine.id).toBe(h.id)
        expect(mine.label).toBe(h.label)
        expect(hashFeeConfig(mine.config)).toBe(
          hashFeeConfig({ destinations: h.destinations as `0x${string}`[], weights: h.weights.map(BigInt) }),
        )
        expect(mine.rates).toEqual({
          handover: BigInt(h.rates.handover),
          output: BigInt(h.rates.output),
          proceeds: BigInt(h.rates.proceeds),
        })
        expect(mine.warn).toEqual({
          handover: BigInt(h.warn.handover),
          output: BigInt(h.warn.output),
          proceeds: BigInt(h.warn.proceeds),
        })
      })
    })

    test(`${id}: a bundled config is bundled, and a stranger is not`, () => {
      expect(isBundledFeeConfig(hashFeeConfig(fees.defaults.config), id)).toBe(true)
      expect(isBundledFeeConfig(hashFeeConfig({ destinations: ['0x00000000000000000000000000000000000000aa'], weights: [10n ** 18n] }), id)).toBe(false)
    })

    test(`${id}: every history entry is a valid config, and ids do not repeat`, () => {
      const ids = new Set<string>()
      for (const h of entry.history) {
        expect(feeConfigFault({ destinations: h.destinations as `0x${string}`[], weights: h.weights.map(BigInt) })).toBe(
          'None',
        )
        expect(ids.has(h.id)).toBe(false)
        ids.add(h.id)
      }
    })
  }
})

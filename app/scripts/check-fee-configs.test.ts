import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { selfFaults, type ChainEntry } from './check-fee-configs.ts'

const FILE = join(dirname(fileURLToPath(import.meta.url)), '../../contracts/config/fee-configs.json')
const file = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, ChainEntry>

describe('contracts/config/fee-configs.json', () => {
  test.each(['369', '943'])('chain %s is self-consistent', (chain) => {
    expect(selfFaults(chain, file[chain]!)).toEqual([])
  })

  test('a broken file is named, not passed', () => {
    const e = structuredClone(file['943']!)
    e.history[0]!.weights = ['1']
    e.history.push({ ...e.history[0]!, rates: { ...e.history[0]!.rates, output: String(2n * 10n ** 18n) } })
    const faults = selfFaults('943', e)
    expect(faults.some((f) => /invalid config/.test(f))).toBe(true)
    expect(faults.some((f) => /repeats an id/.test(f))).toBe(true)
    expect(faults.some((f) => /above one WAD/.test(f))).toBe(true)
  })
})

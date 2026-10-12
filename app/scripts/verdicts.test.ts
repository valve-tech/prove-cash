import type { Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import { VerdictCache } from './verdicts.ts'

const m = (n: number) => ({ hash: `0x${n.toString(16).padStart(64, '0')}`, data: `0x0${n}` as Hex })

describe('VerdictCache', () => {
  it('remembers a definite verdict, good or bad, and asks once', async () => {
    const cache = new VerdictCache<string>(100)
    let asked = 0
    const check = async (data: Hex) => {
      asked++
      return data === '0x01' ? 'ok' : null
    }
    await cache.resolve([m(1), m(2)], check)
    const again = await cache.resolve([m(1), m(2)], check)
    expect(asked).toBe(2)
    expect(again.map((r) => r.verdict)).toEqual(['ok'])
  })

  it('does not remember a failed read, and retries it next pass although the board moved on', async () => {
    // The solver reads the board as a delta, so a message is offered once. A failed decimals
    // read used to be cached as "not an intent", and a good intent was lost for the process.
    const cache = new VerdictCache<string>(100)
    let up = false
    const check = async () => (up ? 'ok' : 'unknown')
    expect(await cache.resolve([m(1)], check)).toEqual([])
    up = true
    const next = await cache.resolve([], check)
    expect(next.map((r) => r.verdict)).toEqual(['ok'])
  })

  it('gives up on a read that keeps failing, so a broken token costs a bounded number of reads', async () => {
    const cache = new VerdictCache<string>(100, 3)
    let asked = 0
    const check = async () => {
      asked++
      return 'unknown' as const
    }
    for (let i = 0; i < 10; i++) await cache.resolve(i === 0 ? [m(1)] : [], check)
    expect(asked).toBe(3)
  })

  it('stays within its bound', async () => {
    const cache = new VerdictCache<string>(2)
    await cache.resolve([m(1), m(2), m(3)], async () => 'ok')
    expect(cache.size).toBe(2)
  })
})

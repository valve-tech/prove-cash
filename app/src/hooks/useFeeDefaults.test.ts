import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { defaultFees, hashFeeConfig, knownFeeConfig, singleFeeConfig, type CurrentFeeDefaults } from '@prove.cash/sdk'
import { DEFAULT_EVERY_MS, followDefault, readDefault } from './useFeeDefaults'
import type { DefaultRead } from '../lib/fee'

/**
 * What `useFeeDefaults` hands the sign form.
 *
 * The hook is a thin effect around `followDefault`, which is tested here. The app's test run has
 * no DOM to mount a hook in, so the logic lives in functions a test can call.
 */

const DEST = '0x2222222222222222222222222222222222222222' as const
const RATES = { handover: 0n, output: 25n, proceeds: 0n }
const WARN = { handover: 100n, output: 100n, proceeds: 100n }
const chain = (output = 25n): CurrentFeeDefaults => ({
  feeConfig: '0x00',
  config: singleFeeConfig(DEST),
  rates: { ...RATES, output },
  warn: WARN,
  setAt: 1n,
  versions: 1n,
})
const DEF = chain()
/** The chain has a FeeDefaults deployed, so a read is the answer. */
const DEPLOYED = () => true

describe('one read of the fee defaults', () => {
  test('a default the build does not ship is read, marked unpinned, and its preimage is NOT remembered', async () => {
    await expect(readDefault(943, async () => DEF, DEPLOYED)).resolves.toEqual({
      state: 'read',
      def: DEF,
      source: 'chain',
      unpinned: true,
    })
    expect(knownFeeConfig(hashFeeConfig(DEF.config))).toBeNull()
  })

  test('a default the build ships is read pinned, and its preimage is remembered', async () => {
    const shipped = defaultFees(943)
    const def: CurrentFeeDefaults = {
      feeConfig: hashFeeConfig(shipped.config),
      config: shipped.config,
      rates: shipped.rates,
      warn: shipped.warn,
      setAt: 1n,
      versions: 1n,
    }
    const got = await readDefault(943, async () => def, DEPLOYED)
    expect(got).toEqual({ state: 'read', def, source: 'chain' })
    expect(knownFeeConfig(hashFeeConfig(shipped.config))).not.toBeNull()
  })

  test('with no FeeDefaults deployed, the registry copy is the answer, and says so', async () => {
    const read = vi.fn()
    const got = await readDefault(943, read, () => false)
    expect(got).toEqual({ state: 'read', def: defaultFees(943), source: 'registry' })
    expect(read).not.toHaveBeenCalled()
  })

  test('a null answer is unread, never a rate of zero', async () => {
    await expect(readDefault(943, async () => null, DEPLOYED)).resolves.toEqual({ state: 'unread' })
  })

  test('a read that throws is unread', async () => {
    const read = async () => {
      throw new Error('fetch failed')
    }
    await expect(readDefault(943, read, DEPLOYED)).resolves.toEqual({ state: 'unread' })
  })
})

describe('following the default sink', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  test('re-reads on an interval, so a DefaultsSet reaches an open form', async () => {
    let rate = 25n
    const read = vi.fn(async () => chain(rate))
    const seen: DefaultRead[] = []
    const stop = followDefault(943, (r) => seen.push(r), read, DEPLOYED)
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([{ state: 'read', def: chain(25n), source: 'chain', unpinned: true }])

    // The owner sets a new default.
    rate = 40n
    await vi.advanceTimersByTimeAsync(DEFAULT_EVERY_MS)
    expect(read).toHaveBeenCalledTimes(2)
    expect(seen.at(-1)).toEqual({ state: 'read', def: chain(40n), source: 'chain', unpinned: true })
    stop()
  })

  test('an unchanged answer is not reported again', async () => {
    const read = vi.fn(async () => DEF)
    const seen: DefaultRead[] = []
    const stop = followDefault(943, (r) => seen.push(r), read, DEPLOYED)
    await vi.advanceTimersByTimeAsync(DEFAULT_EVERY_MS * 3)
    expect(read).toHaveBeenCalledTimes(4)
    expect(seen).toHaveLength(1)
    stop()
  })

  test('a failed re-read keeps the last answer; a failed first read is unread', async () => {
    let fail = true
    const read = vi.fn(async () => {
      if (fail) throw new Error('429')
      return DEF
    })
    const seen: DefaultRead[] = []
    const stop = followDefault(943, (r) => seen.push(r), read, DEPLOYED)
    await vi.advanceTimersByTimeAsync(0)
    expect(seen).toEqual([{ state: 'unread' }])
    fail = false
    await vi.advanceTimersByTimeAsync(DEFAULT_EVERY_MS)
    expect(seen.at(-1)).toEqual({ state: 'read', def: DEF, source: 'chain', unpinned: true })
    fail = true
    await vi.advanceTimersByTimeAsync(DEFAULT_EVERY_MS)
    expect(seen.at(-1)).toEqual({ state: 'read', def: DEF, source: 'chain', unpinned: true })
    stop()
  })

  test('nothing is reported after stop', async () => {
    const read = vi.fn(async () => DEF)
    const seen: DefaultRead[] = []
    const stop = followDefault(943, (r) => seen.push(r), read, DEPLOYED)
    stop()
    await vi.advanceTimersByTimeAsync(DEFAULT_EVERY_MS * 2)
    expect(seen).toEqual([])
    expect(read).toHaveBeenCalledTimes(1)
  })
})

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import {
  announceFeeConfig,
  claimFees,
  claimFeesFor,
  hasReader,
  readFeeDefaults,
  readPendingFees,
} from './claim.js'
import { NETWORKS, setFeeDefaultsOverride, setSettlementOverride, strayFeeConfig } from './config.js'
import { hashFeeConfig, singleFeeConfig } from './feeconfig.js'
import { forgetWireFeeConfigs, learnWireFeeConfig } from './intent.js'

const SETTLEMENT: Address = '0x00000000000000000000000000000000000000b2'
const ME: Address = '0x00000000000000000000000000000000000000a1'
const TOKEN: Address = '0x00000000000000000000000000000000000000c1'
const FEES = { maxFeePerGas: 10n, maxPriorityFeePerGas: 1n }
const CONFIG = singleFeeConfig('0x4444444444444444444444444444444444444444')

beforeAll(() => setSettlementOverride(369, SETTLEMENT))
afterEach(() => vi.restoreAllMocks())

describe('claimFees', () => {
  test('writes claim(config, token) to the settlement with the pinned fees', async () => {
    const writeContract = vi.fn().mockResolvedValue('0xabc')
    await claimFees({ writeContract } as never, ME, CONFIG, TOKEN, FEES, 369)
    const call = writeContract.mock.calls[0]![0]
    expect(call.functionName).toBe('claim')
    expect(call.address).toBe(SETTLEMENT)
    expect(call.args[0]).toEqual({ destinations: [...CONFIG.destinations], weights: [...CONFIG.weights] })
    expect(call.args[1]).toBe(TOKEN)
    expect(call.maxFeePerGas).toBe(10n)
  })

  test('refuses without pinned fees, and for an invalid config, before any wallet call', async () => {
    const writeContract = vi.fn()
    await expect(claimFees({ writeContract } as never, ME, CONFIG, TOKEN, {} as never, 369)).rejects.toThrow(/Pin/)
    await expect(
      claimFees({ writeContract } as never, ME, { destinations: [], weights: [] }, TOKEN, FEES, 369),
    ).rejects.toThrow(/invalid/)
    expect(writeContract).not.toHaveBeenCalled()
  })
})

describe('announceFeeConfig', () => {
  test('writes announceFeeConfig(config)', async () => {
    const writeContract = vi.fn().mockResolvedValue('0xabc')
    await announceFeeConfig({ writeContract } as never, ME, CONFIG, FEES, 369)
    const call = writeContract.mock.calls[0]![0]
    expect(call.functionName).toBe('announceFeeConfig')
    expect(call.args).toHaveLength(1)
  })
})

describe('reads with nothing deployed', () => {
  test('readPendingFees is null per token when the settlement is not live', async () => {
    setSettlementOverride(369, null)
    expect(await readPendingFees(`0x${'11'.repeat(32)}`, [TOKEN], { chainId: 369 })).toEqual([null])
    setSettlementOverride(369, SETTLEMENT)
  })

  // Both chains name a FeeDefaults and a reader since 2026-10-06, so "the registry names none" is
  // staged by blanking that one field for the test and putting it back. The code reads the
  // registry exactly as it does in production.
  const blank = async (key: 'feeDefaults' | 'reader', fn: () => unknown) => {
    const entry = NETWORKS[369] as unknown as Record<string, unknown>
    const was = entry[key]
    entry[key] = '0x0000000000000000000000000000000000000000'
    try {
      await fn()
    } finally {
      entry[key] = was
    }
  }

  test('no FeeDefaults address means no answer, never a zero rate', () =>
    blank('feeDefaults', async () => {
      // A client that refuses outright: a null that came from a failed call would hide the ask.
      const readContract = vi.fn().mockRejectedValue(new Error('asked'))
      expect(await readFeeDefaults({ chainId: 369, client: { readContract } as never })).toBeNull()
      expect(readContract).not.toHaveBeenCalled()
    }))

  test('hasReader is false until the registry names one, and true once it does', async () => {
    await blank('reader', () => expect(hasReader(369)).toBe(false))
    expect(hasReader(369)).toBe(true)
  })
})

describe('readFeeDefaults against a deployed FeeDefaults', () => {
  const FEE_DEFAULTS: Address = '0x00000000000000000000000000000000000000d1'
  // `current()` answers (defaultsHash, record). The defaults hash covers the rates too, so it is
  // never the config's hash: a reader that compared the two refused every honest answer.
  const DEFAULTS_HASH: Hex = `0x${'d0'.repeat(32)}`
  const record = (feeConfig: Hex) => ({
    feeConfig,
    rates: { handover: 0n, output: 5n * 10n ** 15n, proceeds: 0n },
    warn: { handover: 10n ** 16n, output: 10n ** 16n, proceeds: 10n ** 16n },
    setAt: 7n,
    config: { destinations: [...CONFIG.destinations], weights: [...CONFIG.weights] },
  })
  const client = (feeConfig: Hex) => ({
    readContract: vi.fn(async ({ functionName }: { functionName: string }) =>
      functionName === 'current' ? [DEFAULTS_HASH, record(feeConfig)] : 3n,
    ),
  })

  beforeAll(() => setFeeDefaultsOverride(369, FEE_DEFAULTS))
  afterAll(() => setFeeDefaultsOverride(369, null))

  test('an honest answer reads: the config hash is the record’s, not the defaults hash', async () => {
    const got = await readFeeDefaults({ chainId: 369, client: client(hashFeeConfig(CONFIG)) as never })
    expect(got).not.toBeNull()
    expect(got!.feeConfig).toBe(hashFeeConfig(CONFIG))
    expect(got!.defaultsHash).toBe(DEFAULTS_HASH)
    expect(got!.rates.output).toBe(5n * 10n ** 15n)
    expect(got!.versions).toBe(3n)
  })

  test('a record whose preimage does not hash to its own feeConfig is no answer', async () => {
    expect(await readFeeDefaults({ chainId: 369, client: client(`0x${'ee'.repeat(32)}`) as never })).toBeNull()
  })
})

describe('claimFeesFor: pay a book by hash, with a preimage already to hand', () => {
  const CFG = singleFeeConfig('0x5555555555555555555555555555555555555555')

  test('a preimage a board post carried is enough', async () => {
    forgetWireFeeConfigs()
    const writeContract = vi.fn().mockResolvedValue('0xabc')
    const h = hashFeeConfig(CFG)
    await expect(claimFeesFor({ writeContract } as never, ME, h, TOKEN, FEES, 369)).rejects.toThrow(/No preimage/)
    expect(writeContract).not.toHaveBeenCalled()
    // What a verified board read keeps (`readIntent`, the store's `ingest`).
    learnWireFeeConfig(CFG)
    await claimFeesFor({ writeContract } as never, ME, h, TOKEN, FEES, 369)
    expect(writeContract.mock.calls[0]![0].args[0]).toEqual({
      destinations: [...CFG.destinations],
      weights: [...CFG.weights],
    })
  })

  test('the stray config is always to hand', async () => {
    const writeContract = vi.fn().mockResolvedValue('0xabc')
    await claimFeesFor({ writeContract } as never, ME, hashFeeConfig(strayFeeConfig(369)), TOKEN, FEES, 369)
    expect(writeContract).toHaveBeenCalledOnce()
  })
})

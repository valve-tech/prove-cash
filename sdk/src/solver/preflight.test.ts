import { describe, expect, test, vi } from 'vitest'
import type { Address } from 'viem'
import { RingBrokenError, brokenLegs, executeRing } from './execute.js'
import type { Plan } from './plan.js'

/**
 * Finding E-3: a maker can revert a whole ring by invalidating one intent, for a fraction of what
 * the executor spends. A ring cannot skip the bad leg, so the mitigation is to shrink the window
 * between checking and sending, and to name the maker afterwards.
 *
 * These tests are about the guard, not the chain. What matters is that a broken ring costs
 * nothing to discover — `writeContract` must never be reached — and that the failure says why.
 */

const ACCOUNT = '0x00000000000000000000000000000000000000a1' as Address
const SETTLEMENT = '0x00000000000000000000000000000000000000b2' as Address

const plan = (legs: number): Plan =>
  ({
    fills: Array.from({ length: legs }, (_, i) => ({
      intent: { signature: `0x0${i}` },
      take: 1n,
    })),
    maxFeeRate: 10n,
    gas: 200_000n,
    gasSimulated: true,
  }) as unknown as Plan

/** A client whose simulation outcome each call is scripted. */
function client(results: ('ok' | 'revert')[], gas = 150_000n) {
  let i = 0
  return {
    simulateContract: vi.fn(async () => {
      const r = results[Math.min(i++, results.length - 1)]
      if (r === 'revert') throw new Error('IntentCancelled()')
      return { result: 1n }
    }),
    estimateContractGas: vi.fn(async () => gas),
  }
}

type Fake = ReturnType<typeof client>

describe('executeRing preflight', () => {
  test('a broken ring never reaches the wallet', async () => {
    const wallet = { writeContract: vi.fn() }
    await expect(
      executeRing(wallet as never, plan(1), {
        account: ACCOUNT,
        settlementAddress: SETTLEMENT,
        client: client(['revert']) as never,
      }),
    ).rejects.toBeInstanceOf(RingBrokenError)
    // The whole point: discovering the break costs no gas.
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  test('the failure carries the reason, so a solver can tell why', async () => {
    const wallet = { writeContract: vi.fn() }
    const err = await executeRing(wallet as never, plan(1), {
      account: ACCOUNT,
      settlementAddress: SETTLEMENT,
      client: client(['revert']) as never,
    }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RingBrokenError)
    expect((err as RingBrokenError).reason).toContain('IntentCancelled')
  })

  test('a ring that still settles is sent', async () => {
    const wallet = { writeContract: vi.fn(async () => '0xdead') }
    const hash = await executeRing(wallet as never, plan(1), {
      account: ACCOUNT,
      settlementAddress: SETTLEMENT,
      client: client(['ok']) as never,
    })
    expect(hash).toBe('0xdead')
    expect(wallet.writeContract).toHaveBeenCalledTimes(1)
  })

  test('a count that is not every leg counts as broken', async () => {
    // `fillBatch` cannot return a short count with skipInvalid false, so a mismatch means the
    // plan and the contract disagree. Sending on that would be paying to find out.
    const wallet = { writeContract: vi.fn() }
    await expect(
      executeRing(wallet as never, plan(3), {
        account: ACCOUNT,
        settlementAddress: SETTLEMENT,
        client: client(['ok']) as never, // returns 1n against a three-leg plan
      }),
    ).rejects.toBeInstanceOf(RingBrokenError)
    expect(wallet.writeContract).not.toHaveBeenCalled()
  })

  test('skipPreflight sends without asking, and is opt-in', async () => {
    const wallet = { writeContract: vi.fn(async () => '0xbeef') }
    const c: Fake = client(['revert'])
    const hash = await executeRing(wallet as never, plan(1), {
      account: ACCOUNT,
      settlementAddress: SETTLEMENT,
      client: c as never,
      skipPreflight: true,
    })
    expect(hash).toBe('0xbeef')
    expect(c.simulateContract).not.toHaveBeenCalled()
  })
})

describe('brokenLegs', () => {
  test('names the leg that will not settle on its own', async () => {
    const legs = await brokenLegs(plan(3), {
      account: ACCOUNT,
      settlementAddress: SETTLEMENT,
      client: client(['ok', 'revert', 'ok']) as never,
    })
    expect(legs).toEqual([1])
  })

  test('an empty list means the legs are fine and the combination is not', async () => {
    // Every leg simulates alone, so the ring broke on something only the whole batch sees — a
    // moved pool, or the fee. That is a re-plan, not a maker to avoid.
    const legs = await brokenLegs(plan(2), {
      account: ACCOUNT,
      settlementAddress: SETTLEMENT,
      client: client(['ok', 'ok']) as never,
    })
    expect(legs).toEqual([])
  })

  test('it asks once per leg and no more', async () => {
    const c: Fake = client(['ok', 'ok', 'ok'])
    await brokenLegs(plan(3), {
      account: ACCOUNT,
      settlementAddress: SETTLEMENT,
      client: c as never,
    })
    expect(c.simulateContract.mock.calls).toHaveLength(3)
  })
})

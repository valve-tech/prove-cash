import { describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import { batchExecutorFlag, tolerantRingsFlag, type FlagWorld } from './flags.ts'

/**
 * The two flags that change what the solver spends money on.
 *
 * Half of these say the flag does what it says. The other half say it is OFF when nobody asked,
 * and that half is the one that matters — `--tolerant` costs gas on every ring to save the loss
 * on a few, and nobody has measured the rate that makes that trade pay. A default that drifted on
 * would be a bill an operator never agreed to, and it would look exactly like working.
 */

const EXEC = '0x00000000000000000000000000000000000000be' as Address

const world = (extra: Partial<FlagWorld> = {}): FlagWorld => ({
  credit: EXEC,
  amm: true,
  ...extra,
})

describe('--tolerant', () => {
  test('is off unless it is asked for', () => {
    expect(tolerantRingsFlag([], world())).toBe(false)
    expect(tolerantRingsFlag(['--chain', '943', '--execute', '--amm'], world())).toBe(false)
    // Not even when everything it depends on is present. Nothing implies it.
    expect(tolerantRingsFlag(['--credit', EXEC, '--amm', '--batch'], world())).toBe(false)
  })

  test('is on when it is asked for and both its dependencies are there', () => {
    expect(tolerantRingsFlag(['--tolerant'], world())).toBe(true)
  })

  test('refuses without --credit, and names the fix', () => {
    expect(() => tolerantRingsFlag(['--tolerant'], world({ credit: null }))).toThrow(/--credit/)
  })

  test('refuses without --amm, because it would cover no leg and never say so', () => {
    expect(() => tolerantRingsFlag(['--tolerant'], world({ amm: false }))).toThrow(/--amm/)
  })

  test('a missing dependency is a refusal and not a quiet false', () => {
    // The failure mode this guards is a bot that runs for a week doing none of what its command
    // line asked for. Returning false would be exactly that.
    expect(() => tolerantRingsFlag(['--tolerant'], world({ credit: null, amm: false }))).toThrow()
  })
})

describe('--batch', () => {
  test('is off unless it is asked for', () => {
    expect(batchExecutorFlag([], world())).toBeNull()
    expect(batchExecutorFlag(['--credit', EXEC, '--amm'], world())).toBeNull()
  })

  test('packs through the executor --credit already named', () => {
    expect(batchExecutorFlag(['--batch'], world())).toBe(EXEC)
  })

  test('refuses without --credit or without --amm', () => {
    expect(() => batchExecutorFlag(['--batch'], world({ credit: null }))).toThrow(/--credit/)
    expect(() => batchExecutorFlag(['--batch'], world({ amm: false }))).toThrow(/--amm/)
  })
})

describe('the two are independent', () => {
  test('asking for one does not turn on the other', () => {
    expect(batchExecutorFlag(['--tolerant'], world())).toBeNull()
    expect(tolerantRingsFlag(['--batch'], world())).toBe(false)
  })
})

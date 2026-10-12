import { describe, expect, test, vi } from 'vitest'
import { encodeErrorResult, type Address, type Hex } from 'viem'
import { CURVE_LINEAR, FLAG_PARTIAL, ZERO, type SignedIntent, ZERO_HASH } from '../intent.js'
import type { RingFill } from './abi.js'
import {
  bisect,
  chainDryRunner,
  confirm,
  decodeDryRun,
  dryRunData,
  type DryRunUnit,
  type DryRunner,
} from './dryrun.js'

/**
 * The one question only a chain answers.
 *
 * Whether a permit lands and whether a redemption credits what it pulled are both post-transfer
 * facts. `dryRun` walks the real path, arms for real, and reverts with one reason per leg. These
 * tests are about the decision on top of that answer, not about the chain: the runner is stubbed,
 * because the settlement carrying `dryRun` may not exist in this worktree at all.
 */

const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN_B = '0x00000000000000000000000000000000000000bb' as Address
const ACCOUNT = '0x00000000000000000000000000000000000000a1' as Address
const SETTLEMENT = '0x00000000000000000000000000000000000000b2' as Address
const T0 = 1_800_000_000n
const ONE = 1_000_000_000_000_000_000n

/** The revert shape, written out here so the decoder is pinned against a second opinion. */
const DRY_RUN_ERROR = [
  { type: 'error', name: 'DryRun', inputs: [{ name: 'reasons', type: 'uint8[]' }] },
] as const

const revertWith = (ordinals: readonly number[]): Hex =>
  encodeErrorResult({ abi: DRY_RUN_ERROR, errorName: 'DryRun', args: [ordinals] })

let seq = 0

function fill(arming?: Hex): RingFill {
  seq++
  const maker = `0x${seq.toString(16).padStart(40, '0')}` as Address
  const intent: SignedIntent = {
    maker,
    recipient: maker,
    tokenIn: TOKEN_A,
    tokenOut: TOKEN_B,
    amountIn: 100n * ONE,
    minOutStart: 90n * ONE,
    minOutEnd: 90n * ONE,
    minFill: 0n,
    authNonce: `0x${'00'.repeat(32)}` as `0x${string}`,
    startTime: T0,
    endTime: T0 + 1800n,
    executor: ZERO,
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    flags: FLAG_PARTIAL,
    nonce: BigInt(seq),
    curve: CURVE_LINEAR,
    signature: `0x${'11'.repeat(65)}` as Hex,
  }
  return { intent, take: 10n * ONE, ...(arming ? { arming } : {}) }
}

const unit = (legs = 1): DryRunUnit => ({ fills: Array.from({ length: legs }, () => fill()) })

/** A runner that refuses whichever legs a caller names, by the maker addresses it sees. */
function runner(refuse: (makers: readonly Address[]) => readonly boolean[]): DryRunner {
  return async (fills) => {
    const bad = refuse(fills.map((f) => f.intent.maker))
    return fills.map((_, k) => (bad[k] ? 'EscrowShort' : 'Ok'))
  }
}

describe('the revert the solver reads', () => {
  test('the reasons decode in request order', () => {
    // 0 is Ok and 10 is EscrowShort, in the contract's declared order.
    expect(decodeDryRun(revertWith([0, 10, 3]))).toEqual(['Ok', 'EscrowShort', 'Expired'])
  })

  test('some other revert is not an answer, and does not pretend to be one', () => {
    expect(decodeDryRun('0xdeadbeef')).toBeNull()
    expect(decodeDryRun('0x')).toBeNull()
  })

  test('the calldata carries every leg’s arming bytes, because that is what is under test', () => {
    const armed = fill(`0x${'ab'.repeat(32)}` as Hex)
    const data = dryRunData([armed, fill()], 0n)
    expect(data.slice(2)).toContain('ab'.repeat(32))
  })
})

describe('the chain runner', () => {
  const errorFrom = (data: Hex) => Object.assign(new Error('execution reverted'), { data })

  test('a revert carrying reasons is the answer, not a failure', async () => {
    const client = { call: vi.fn(async () => Promise.reject(errorFrom(revertWith([0, 10])))) }
    const run = chainDryRunner({ account: ACCOUNT, settlementAddress: SETTLEMENT, client: client as never })
    expect(await run([fill(), fill()], 0n)).toEqual(['Ok', 'EscrowShort'])
  })

  test('the payload is found however deep viem wrapped it', async () => {
    const wrapped = Object.assign(new Error('call failed'), {
      cause: Object.assign(new Error('inner'), { cause: errorFrom(revertWith([0])) }),
    })
    const client = { call: vi.fn(async () => Promise.reject(wrapped)) }
    const run = chainDryRunner({ account: ACCOUNT, settlementAddress: SETTLEMENT, client: client as never })
    expect(await run([fill()], 0n)).toEqual(['Ok'])
  })

  test('a revert that is not a DryRun is thrown, never read as a pass', async () => {
    const client = { call: vi.fn(async () => Promise.reject(errorFrom('0xdeadbeef'))) }
    const run = chainDryRunner({ account: ACCOUNT, settlementAddress: SETTLEMENT, client: client as never })
    await expect(run([fill()], 0n)).rejects.toThrow(/execution reverted/)
  })

  test('a call that returns is the wrong contract, and saying so beats guessing', async () => {
    // `dryRun` always reverts. A plain return means this address is not what the solver thinks.
    const client = { call: vi.fn(async () => ({ data: '0x' })) }
    const run = chainDryRunner({ account: ACCOUNT, settlementAddress: SETTLEMENT, client: client as never })
    await expect(run([fill()], 0n)).rejects.toThrow(/not ProveSettlement.dryRun/)
  })
})

describe('confirming a chosen set', () => {
  test('every leg Ok is a yes', async () => {
    const fills = [fill(), fill()]
    expect(await confirm(runner(() => [false, false]), fills, 0n)).toMatchObject({ ok: true })
  })

  test('a refusal names the legs, so the solver knows who to stop planning around', async () => {
    const fills = [fill(), fill(), fill()]
    const answer = await confirm(runner(() => [false, true, false]), fills, 0n)
    expect(answer).toMatchObject({ ok: false, bad: [1] })
  })

  test('an answer shorter than the request is not a pass', async () => {
    // One reason per leg is the contract's promise. A batch that answered for fewer legs than it
    // was given did not answer for the ones it left out.
    const short: DryRunner = async () => ['Ok']
    expect(await confirm(short, [fill(), fill()], 0n)).toMatchObject({ ok: false })
  })
})

describe('bisecting a set the chain refused', () => {
  test('a set that settles costs exactly one call', async () => {
    const units = [unit(), unit(), unit()]
    const out = await bisect(runner((m) => m.map(() => false)), units, 0n)
    expect(out).toEqual({ kept: [0, 1, 2], calls: 1 })
  })

  test('one broken unit is dropped and the rest still settle', async () => {
    const units = [unit(), unit(2), unit()]
    const doomed = units[1].fills[0].intent.maker
    const out = await bisect(
      runner((makers) => makers.map((m) => m === doomed)),
      units,
      0n,
    )
    expect(out.kept).toEqual([0, 2])
  })

  test('a ring is dropped whole, never trimmed to its good legs', async () => {
    // `skipInvalid` is false for a ring: a ring missing a leg is broken, not smaller. So the
    // surviving unit's own legs come back intact or the unit goes.
    const units = [unit(3), unit()]
    const doomed = units[0].fills[2].intent.maker
    const out = await bisect(
      runner((makers) => makers.map((m) => m === doomed)),
      units,
      0n,
    )
    expect(out.kept).toEqual([1])
  })

  test('two units that are each fine and cannot settle together leave one behind', async () => {
    // The interaction case, and the reason bisection beats re-enumerating: nothing about either
    // unit on its own says no. Only the pair does, and only the chain knows.
    const units = [unit(), unit()]
    const run: DryRunner = async (fills) =>
      fills.length > 1 ? fills.map(() => 'EscrowShort' as const) : ['Ok']
    const out = await bisect(run, units, 0n)
    expect(out.kept).toHaveLength(1)
  })

  test('a set where nothing settles keeps nothing, and stops asking', async () => {
    const units = [unit(), unit()]
    const out = await bisect(runner((m) => m.map(() => true)), units, 0n)
    expect(out.kept).toEqual([])
    expect(out.calls).toBeLessThanOrEqual(4)
  })

  test('the call budget bounds a pathological book rather than the answer being wrong', async () => {
    const units = Array.from({ length: 8 }, () => unit())
    const out = await bisect(runner((m) => m.map(() => true)), units, 0n, { maxCalls: 3 })
    expect(out.calls).toBeLessThanOrEqual(3)
    // Whatever comes back is a set the chain said yes to, and an empty set trivially is one.
    expect(out.kept).toEqual([])
  })
})

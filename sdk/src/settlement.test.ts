import { afterEach, describe, expect, test, vi } from 'vitest'
import { decodeFunctionResult, encodeAbiParameters, type Hex } from 'viem'
import fixture from '../../app/src/lib/__fixtures__/eip712.json' with { type: 'json' }
import { SETTLEMENT_ABI } from './abi.js'
import { BASIS_POINT, PERCENT, formatFeeRate, parseFeeRate } from './fee.js'
import {
  approvalTarget,
  approveToken,
  armingFor,
  callFor,
  cancel,
  invalidateBefore,
  readCancelledAt,
  readNonceFloor,
  readReservations,
  relayerAllowance,
  retract,
  FILL_REASONS,
  REASON_TEXT,
  type FillMode,
  type FillPlan,
  type ReadOptions,
} from './settlement.js'
import { NETWORKS } from './config.js'
import {
  CURVE_LINEAR,
  FLAG_ESCROW,
  FLAG_PARTIAL,
  FLAG_PERMIT2,
  ZERO,
  ZERO_HASH,
  intentHashOf,
  type SignedIntent,
} from './intent.js'

/**
 * Every call this package builds must match the compiled contract's arity.
 *
 * `callFor` once passed no `maxFeeRate` at all, to any of the fill functions, and every write
 * through the SDK would have reverted on chain. Both existing gates stayed green: `tsc` cannot
 * type an untyped `args` array, and `check:abi` compares function *names* and never counts
 * arguments. So count them here, against the ABI the compiler wrote.
 *
 * This is a shape test, not a behaviour test. It needs no chain and no wallet, which is the point
 * — the bug it guards against is invisible until a transaction reverts.
 */

const SETTLEMENT_943 = NETWORKS[943].settlement

const A = '0x1111111111111111111111111111111111111111' as const
const B = '0x2222222222222222222222222222222222222222' as const

const intent: SignedIntent = {
  maker: A,
  recipient: A,
  tokenIn: A,
  tokenOut: B,
  amountIn: 1_000n,
  minOutStart: 900n,
  minOutEnd: 900n,
  startTime: 0n,
  endTime: 9_999_999_999n,
  executor: ZERO,
  feeConfig: ZERO_HASH,
  feeRate: 0n,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: FLAG_PARTIAL,
  nonce: 1n,
  curve: CURVE_LINEAR,
  signature: `0x${'11'.repeat(65)}`,
}

/**
 * The same intent with the EIP-3009 authorization the gasless path needs.
 *
 * The escrow flag comes with it. That flag is what says the arming bytes hold an authorization
 * rather than a permit, so an intent carrying one without it is a shape no maker signs.
 */
const authorized: SignedIntent = {
  ...intent,
  flags: FLAG_PARTIAL | FLAG_ESCROW,
  auth: { validAfter: 0n, validBefore: 9_999_999_999n, signature: `0x${'22'.repeat(65)}` },
}

/**
 * A maker on the Permit2 rung. `FLAG_PERMIT2` is bit 2, and it is deliberately not the escrow
 * flag: nothing is committed until the fill pulls it.
 */
const permit2ed: SignedIntent = {
  ...intent,
  flags: FLAG_PARTIAL | 4,
  permit2: {
    token: intent.tokenIn,
    amount: intent.amountIn,
    deadline: 9_999_999_999n,
    signature: `0x${'33'.repeat(65)}`,
  },
}

/** How many arguments the compiled contract declares for a function. */
function arity(name: string): number {
  const entry = SETTLEMENT_ABI.find((e) => e.type === 'function' && e.name === name)
  if (!entry) throw new Error(`the ABI has no function ${name}`)
  return (entry as { inputs: readonly unknown[] }).inputs.length
}

const plans: ReadonlyArray<[FillMode, FillPlan]> = [
  ['direct', { mode: 'direct', fills: [{ intent, take: 500n }], maxFeeRate: 10n }],
  [
    'batch',
    {
      mode: 'batch',
      fills: [
        { intent, take: 500n },
        { intent, take: 100n },
      ],
      maxFeeRate: 10n,
      skipInvalid: false,
    },
  ],
  ['callback', { mode: 'callback', fills: [{ intent, take: 500n }], maxFeeRate: 10n, callbackData: '0xbeef' }],
  [
    'credit',
    {
      mode: 'credit',
      fills: [
        { intent, take: 500n },
        { intent, take: 100n },
      ],
      maxFeeRate: 10n,
      callbackData: '0xbeef',
    },
  ],
  ['authorization', { mode: 'authorization', fills: [{ intent: authorized, take: 500n }], maxFeeRate: 10n }],
  // The rung that survives a redeploy needs its own door too. It had none: the contract carried
  // `fillWithPermit2` and `callFor` could not build a call to it, so a permit2 maker was fillable
  // only inside a batch while permit and authorization each had a cheap single-leg path. Every
  // rung reaches every pattern, or the choice of custody quietly decides what a solver can do.
  ['permit2', { mode: 'permit2', fills: [{ intent: permit2ed, take: 500n }], maxFeeRate: 10n }],
  // The same rung inside a batch, which `FillRequest.arming` made possible. The mode above is
  // the cheaper door for one leg; this is the only one that settles several at a time.
  ['batch', { mode: 'batch', fills: [{ intent: authorized, take: 500n }], maxFeeRate: 10n }],
]

/**
 * Three tables in this package restate something the contract owns: the custody bits, the
 * `Reason` ordinals and the error names. Each one is a copy, and a copy is only as good as the
 * thing that compares it. Nothing did.
 *
 * `contracts/test/Fixture.t.sol` now writes the first two off the compiled contract, and the
 * third is checked against the generated ABI. All three are silent failures if they drift: a
 * shifted ordinal renames every reason the solver reads, a moved bit signs the wrong custody
 * rung, and a stale error name prints a selector where a sentence should be.
 */
describe('what this package copies from the contract', () => {
  const F = fixture as unknown as {
    flags: { partial: number; escrow: number; permit2: number }
    reasons: Record<string, number>
  }

  test('the custody bits are the contract\u2019s bits', () => {
    expect(FLAG_PARTIAL).toBe(F.flags.partial)
    expect(FLAG_ESCROW).toBe(F.flags.escrow)
    expect(FLAG_PERMIT2).toBe(F.flags.permit2)
  })

  test('FILL_REASONS has one entry per enum member, and no more', () => {
    // `type(Reason).max` wrote the count, so a member appended in Solidity and forgotten here
    // fails on this line rather than by silently answering with an index nobody indexed.
    expect(FILL_REASONS).toHaveLength(F.reasons.count)
  })

  test.each(
    Object.entries(fixture.reasons as Record<string, number>).filter(([k]) => k !== 'count'),
  )('%s is ordinal %i on both sides', (name, ordinal) => {
    // The enum spells three members with a trailing underscore, where a custom error of the same
    // name would otherwise clash. The wire value is the number; the underscore is Solidity's.
    expect(FILL_REASONS[ordinal]).toBe(name.replace(/_$/, ''))
  })

  test('every reason this package has words for is an error the contract raises', () => {
    const raised = new Set<string>(
      SETTLEMENT_ABI.filter((e) => e.type === 'error').map((e) => e.name),
    )
    expect(Object.keys(REASON_TEXT).filter((name) => !raised.has(name))).toEqual([])
  })
})

describe('every fill plan matches the contract it calls', () => {
  for (const [mode, plan] of plans) {
    test(`${mode} passes exactly the arguments the contract declares`, () => {
      const call = callFor(plan, 943)
      expect(call.args).toHaveLength(arity(call.functionName))
    })
  }

  test('the fee bound is the last argument of every fill function', () => {
    for (const [, plan] of plans) {
      const call = callFor(plan, 943)
      expect(call.args[call.args.length - 1]).toBe(plan.maxFeeRate)
    }
  })

  /**
   * A ring is atomic or it is nothing. Skipping a leg settles the others and leaves the solver
   * holding an unhedged position, so `credit` defaults the opposite way from `batch` — and that
   * difference is worth a test, because it is one word in a long argument list.
   */
  test('credit refuses to skip a leg unless the caller insists', () => {
    const ring: FillPlan = { mode: 'credit', fills: [{ intent, take: 1n }], maxFeeRate: 10n }
    expect(callFor(ring, 943).args[1]).toBe(false)
    expect(callFor({ ...ring, skipInvalid: true }, 943).args[1]).toBe(true)

    const batch: FillPlan = { mode: 'batch', fills: [{ intent, take: 1n }], maxFeeRate: 10n }
    expect(callFor(batch, 943).args[1]).toBe(true)
  })

  test('a batch of one still goes through fillBatch when the mode says batch', () => {
    const call = callFor({ mode: 'batch', fills: [{ intent, take: 1n }], maxFeeRate: 10n }, 943)
    expect(call.functionName).toBe('fillBatch')
  })

  test('the gasless door refuses an intent that carries no authorization', () => {
    expect(() =>
      callFor({ mode: 'authorization', fills: [{ intent, take: 1n }], maxFeeRate: 10n }, 943),
    ).toThrow(/authorization/i)
    expect(() =>
      callFor({ mode: 'permit', fills: [{ intent, take: 1n }], maxFeeRate: 10n }, 943),
    ).toThrow(/permit/i)
  })

  /**
   * A gasless leg carries its arming bytes, and a leg that needs none carries `0x`.
   *
   * `fillWithAuthorization` throws when handed an intent with no authorization, because there is
   * nothing else it could do with one. A batch leg has an answer for both: the bytes when the
   * intent has them, and empty when it does not — a maker with a standing allowance or a funded
   * escrow needs no arming, and refusing them would refuse two of the four custody rungs.
   */
  test('a leg carries its arming bytes, and an unarmed leg carries none', () => {
    const armed = callFor(
      { mode: 'batch', fills: [{ intent: authorized, take: 1n }], maxFeeRate: 10n },
      943,
    )
    const legs = armed.args[0] as readonly { arming: string }[]
    expect(legs[0].arming.length).toBeGreaterThan(2)
    expect(legs[0].arming).toBe(armingFor(authorized, 943))

    const bare = callFor({ mode: 'batch', fills: [{ intent, take: 1n }], maxFeeRate: 10n }, 943)
    expect((bare.args[0] as readonly { arming: string }[])[0].arming).toBe('0x')
    expect(armingFor(intent, 943)).toBeUndefined()
  })

  /**
   * The 3009 nonce is the intent hash, and the contract enforces that. It never travels on the
   * wire, so `armingFor` rebuilds it from the terms — and a rebuild that got the chain or a field
   * wrong would name an intent the maker never authorized, which the settlement refuses.
   */
  test('the arming bytes name the intent they fund', () => {
    const bytes = armingFor(authorized, 943) as string
    expect(bytes.toLowerCase()).toContain(intentHashOf(authorized, 943).slice(2).toLowerCase())
  })

  /**
   * A permit2 leg carries its bytes through the same door, and names the same intent.
   *
   * `armingFor` is the plan path's copy of this rule and `encodeArming` is the solver's. Both
   * derive the nonce from the intent rather than reading one off the wire, because the settlement
   * refuses any other — so a leg whose bytes carry the wrong nonce arms nothing at all.
   */
  test('a permit2 leg carries bytes that name the intent they fund', () => {
    const p2: SignedIntent = {
      ...intent,
      flags: intent.flags | FLAG_PERMIT2,
      permit2: {
        token: intent.tokenIn,
        amount: intent.amountIn,
        deadline: intent.endTime,
        signature: ('0x' + '55'.repeat(65)) as Hex,
      },
    }
    const bytes = armingFor(p2, 943) as string
    expect(bytes.length).toBeGreaterThan(2)
    expect(bytes.toLowerCase()).toContain(intentHashOf(p2, 943).slice(2).toLowerCase())

    // The rung's flag without the signature is a leg nothing can arm, not a leg armed with junk.
    const { permit2: _dropped, ...unsigned } = p2
    expect(armingFor(unsigned as SignedIntent, 943)).toBeUndefined()
  })

  test('nothing selected is an error, not an empty call', () => {
    expect(() => callFor({ mode: 'direct', fills: [], maxFeeRate: 10n }, 943)).toThrow()
  })
})

/**
 * The same gap, on the read side.
 *
 * `readReservations` destructured four fields — maker, unlockAt, token, amount — out of a tuple
 * the contract had already shortened to two. An `as` cast made it type-check, so `amount` came
 * back `undefined` and every escrow row on the board read as empty while `Portfolio` threw on
 * `formatUnits(undefined)`. Nothing caught it: `check:abi` compares names, and `tsc` believes a
 * cast.
 *
 * So pin the decode to the shape the compiler wrote. A struct that changes again fails here,
 * next to the writes, instead of on a user's screen.
 */
describe('every read this package decodes matches the contract it reads', () => {
  const outputsOf = (name: string) => {
    const entry = SETTLEMENT_ABI.find((e) => e.type === 'function' && e.name === name)
    if (!entry || entry.type !== 'function') throw new Error(`no such function: ${name}`)
    return entry.outputs.map((o) => [o.name, o.type] as const)
  }

  test('reserved returns one number, so there is no field order to get wrong', () => {
    expect(outputsOf('reserved')).toEqual([['', 'uint256']])
  })

  test('a reservation survives the decode with its amount intact', async () => {
    const entry = SETTLEMENT_ABI.find((e) => e.type === 'function' && e.name === 'reserved')
    if (!entry || entry.type !== 'function') throw new Error('no reserved in the ABI')

    const data = encodeAbiParameters(entry.outputs, [7_000n])
    const value = decodeFunctionResult({
      abi: SETTLEMENT_ABI,
      functionName: 'reserved',
      data,
    })

    // No multicall on this stub, so `batchRead` falls through to single reads.
    const client = {
      chain: { id: 943 },
      getCode: async () => '0x',
      readContract: async () => value,
      multicall: async () => [{ status: 'success', result: value }],
    } as unknown as NonNullable<Parameters<typeof readReservations>[1]>['client']

    const [r] = await readReservations([`0x${'ab'.repeat(32)}`], { chainId: 943, client })

    expect(r).not.toBeNull()
    expect(r?.amount).toBe(7_000n)
  })
})

/**
 * The approval target is not the settlement, and no client may assume it is.
 *
 * `ProveRelayer` holds every maker allowance so that the contract which calls out to addresses a
 * caller chose holds none. That only works if clients approve the relayer, and the relayer's
 * address exists nowhere in configuration — the settlement deploys it and hands it back. An
 * approval to the wrong address costs the maker a transaction and does nothing, and they find out
 * when a fill reverts, so pin both readers to the contract.
 */
describe('a maker approves the relayer, and the relayer comes off the chain', () => {
  const RELAYER = `0x${'11'.repeat(20)}` as const
  const TOKEN = `0x${'22'.repeat(20)}` as const
  const MAKER = `0x${'33'.repeat(20)}` as const

  /** A stub that answers `relayer()` once and records every read it is asked for. */
  function stub() {
    const reads: { address: string; functionName: string; args?: readonly unknown[] }[] = []
    const client = {
      chain: { id: 943 },
      getCode: async () => '0x',
      readContract: async (c: {
        address: string
        functionName: string
        args?: readonly unknown[]
      }) => {
        reads.push(c)
        if (c.functionName === 'relayer') return RELAYER
        if (c.functionName === 'allowance') return 42n
        throw new Error(`unexpected read: ${c.functionName}`)
      },
    } as unknown as NonNullable<Parameters<typeof relayerAllowance>[2]>['client']
    return { client, reads }
  }

  afterEach(() => vi.unstubAllGlobals())

  test('the relayer is read off the settlement contract', async () => {
    const { client, reads } = stub()
    const found = await approvalTarget({ chainId: 943, client })

    expect(found).toBe(RELAYER)
    expect(reads[0]?.functionName).toBe('relayer')
    expect(reads[0]?.address).toBe(SETTLEMENT_943)
  })

  test('the allowance is read against the relayer, never against the settlement', async () => {
    const { client, reads } = stub()
    const got = await relayerAllowance(MAKER, TOKEN, { chainId: 943, client })

    expect(got).toBe(42n)
    const allowance = reads.find((r) => r.functionName === 'allowance')
    expect(allowance?.args?.[1]).toBe(RELAYER)
    expect(allowance?.args?.[1]).not.toBe(SETTLEMENT_943)
  })

  test('approveToken names the relayer as the spender', async () => {
    const { client } = stub()
    await approvalTarget({ chainId: 943, client }) // prime the cache off the stub

    // Before it sends, the approval asks the chain whether the approval would go through, so that
    // a token which refuses a raise over a standing allowance is zeroed first. Answer that here:
    // this test is about the spender, and it must reach no network to say so. The two-step itself
    // is held by `approve.test.ts`.
    vi.stubGlobal('fetch', async (_url: unknown, init: { body?: string }) => {
      const { id } = JSON.parse(String(init.body)) as { id: number }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: `0x${'0'.repeat(64)}` }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })

    let spender: unknown
    const wallet = {
      writeContract: async (c: { args: readonly unknown[] }) => {
        spender = c.args[0]
        return `0x${'ee'.repeat(32)}`
      },
    } as unknown as Parameters<typeof approveToken>[0]

    await approveToken(wallet, MAKER, TOKEN, 1_000n, 943)
    expect(spender).toBe(RELAYER)
    expect(spender).not.toBe(SETTLEMENT_943)
  })
})

/**
 * The maker's off switch.
 *
 * A signature this package can write and cannot retract is the worst shape a wallet feature can
 * have: the maker asks to stop and there is nothing to call. The contract has had `cancel`,
 * `invalidateBefore` and `withdraw` all along; none of them were reachable from here.
 *
 * The routing is the part worth pinning. `withdraw` reverts on an empty reservation and `cancel`
 * leaves escrowed money where it is, so picking the wrong one either costs a failed transaction
 * or a second one. `retract` picks, and these tests hold it to the choice.
 */
describe('a maker can take an order back', () => {
  const MAKER = `0x${'33'.repeat(20)}` as const
  const TX = `0x${'ee'.repeat(32)}` as const

  const escrowed: SignedIntent = { ...intent, maker: MAKER, flags: FLAG_ESCROW }
  const inWallet: SignedIntent = { ...intent, maker: MAKER, flags: FLAG_PARTIAL }

  /** Records the one write it is asked for. */
  function pen() {
    const calls: { functionName: string; args: readonly unknown[] }[] = []
    const wallet = {
      writeContract: async (c: { functionName: string; args: readonly unknown[] }) => {
        calls.push(c)
        return TX
      },
    } as unknown as Parameters<typeof cancel>[0]
    return { wallet, calls }
  }

  /** A client that answers `reserved` with `amount`, or throws when it is null. */
  function escrowStub(amount: bigint | null) {
    return {
      chain: { id: 943 },
      getCode: async () => '0x',
      readContract: async () => {
        if (amount === null) throw new Error('the endpoint dropped it')
        return amount
      },
    } as unknown as ReadOptions['client']
  }

  test('cancel passes exactly the arguments the contract declares', async () => {
    const { wallet, calls } = pen()
    await cancel(wallet, MAKER, inWallet, 943)
    expect(calls[0]?.functionName).toBe('cancel')
    expect(calls[0]?.args).toHaveLength(arity('cancel'))
  })

  test('invalidateBefore passes the floor and nothing else', async () => {
    const { wallet, calls } = pen()
    await invalidateBefore(wallet, MAKER, 1_700_000_000_000n, 943)
    expect(calls[0]?.functionName).toBe('invalidateBefore')
    expect(calls[0]?.args).toEqual([1_700_000_000_000n])
    expect(calls[0]?.args).toHaveLength(arity('invalidateBefore'))
  })

  test('a wallet-custody order goes out through cancel, with no read first', async () => {
    const { wallet, calls } = pen()
    // No client, and none needed: nothing about wallet custody depends on the chain's answer.
    await retract(wallet, MAKER, inWallet, 943)
    expect(calls[0]?.functionName).toBe('cancel')
  })

  test('a funded escrow order goes out through withdraw, so the money comes back', async () => {
    const { wallet, calls } = pen()
    await retract(wallet, MAKER, escrowed, 943, escrowStub(5_000n))
    expect(calls[0]?.functionName).toBe('withdraw')
  })

  test('an escrow order nobody funded goes out through cancel — withdraw would revert', async () => {
    const { wallet, calls } = pen()
    await retract(wallet, MAKER, escrowed, 943, escrowStub(0n))
    expect(calls[0]?.functionName).toBe('cancel')
  })

  test('a dropped read cancels, because cancel never strands the deposit', async () => {
    // `withdraw` still works on a cancelled intent, so cancelling on an unknown is recoverable.
    // Guessing the other way spends gas on a call the contract refuses.
    const { wallet, calls } = pen()
    await retract(wallet, MAKER, escrowed, 943, escrowStub(null))
    expect(calls[0]?.functionName).toBe('cancel')
  })

  test('never cancelled reads as zero, and a dropped read reads as nothing', async () => {
    const never = {
      chain: { id: 943 },
      getCode: async () => '0x',
      readContract: async () => 0n,
    } as unknown as ReadOptions['client']

    const [zero] = await readCancelledAt([`0x${'ab'.repeat(32)}`], { chainId: 943, client: never })
    const [gone] = await readCancelledAt([`0x${'ab'.repeat(32)}`], {
      chainId: 943,
      client: escrowStub(null),
    })

    expect(zero).toBe(0n)
    expect(gone).toBeNull()
  })

  test('the nonce floor is read off the settlement contract', async () => {
    const reads: { address: string; functionName: string; args?: readonly unknown[] }[] = []
    const client = {
      chain: { id: 943 },
      getCode: async () => '0x',
      readContract: async (c: {
        address: string
        functionName: string
        args?: readonly unknown[]
      }) => {
        reads.push(c)
        return 42n
      },
    } as unknown as ReadOptions['client']

    expect(await readNonceFloor(MAKER, { chainId: 943, client })).toBe(42n)
    expect(reads[0]?.address).toBe(SETTLEMENT_943)
    expect(reads[0]?.functionName).toBe('nonceFloor')
    expect(reads[0]?.args).toEqual([MAKER])
  })
})

/**
 * The rate a person types, and the number it signs.
 *
 * This is the one place a human unit meets the wire unit, and it is a place a float would be
 * wrong quietly: `0.07 * 1e16` is `700000000000000.1` in IEEE 754 and `0.0003 * 1e16` is
 * `2999999999999.9995`, so the obvious multiplication lands a wei either side of what was typed
 * and which side depends on the digits. The cases below are chosen from that set.
 */
describe('a rate a person typed', () => {
  test('a percentage becomes a fraction of one ether', () => {
    expect(parseFeeRate('0.05')).toBe(5n * BASIS_POINT)
    expect(parseFeeRate('1')).toBe(PERCENT)
    expect(parseFeeRate('0')).toBe(0n)
    expect(parseFeeRate('100')).toBe(100n * PERCENT)
  })

  test('the digits a float would round, to the wei', () => {
    expect(parseFeeRate('0.07')).toBe(700_000_000_000_000n)
    expect(parseFeeRate('0.035')).toBe(350_000_000_000_000n)
    expect(parseFeeRate('0.0003')).toBe(3_000_000_000_000n)
  })

  test('a sign and surrounding space are the person, not the value', () => {
    expect(parseFeeRate(' 0.25 ')).toBe(parseFeeRate('0.25'))
    expect(parseFeeRate('0.5%')).toBe(parseFeeRate('0.5'))
  })

  /** Null and zero are different answers: an empty field is not a maker asking for nothing. */
  test('anything that is not a plain decimal is null, and null is not zero', () => {
    for (const bad of ['', '.', 'x', '-1', '1e3', '1,5', '0.05.1']) {
      expect(parseFeeRate(bad)).toBeNull()
    }
    expect(parseFeeRate('0')).toBe(0n)
  })

  /** Sixteen places is the whole unit. A seventeenth is refused rather than silently dropped. */
  test('finer than the unit carries is refused, not truncated', () => {
    expect(parseFeeRate('0.0000000000000001')).toBe(1n)
    expect(parseFeeRate('0.00000000000000001')).toBeNull()
  })

  test('formatting is the inverse, and drops nothing', () => {
    for (const p of ['0.05', '0.07', '5', '0', '0.0003', '12.345']) {
      expect(formatFeeRate(parseFeeRate(p)!)).toBe(p)
    }
  })

  /** The rate the old unit could not express at all: a tenth of a basis point. */
  test('a rate finer than one basis point survives the trip', () => {
    const tenth = parseFeeRate('0.001')!
    expect(tenth).toBe(BASIS_POINT / 10n)
    expect(tenth * 10n).toBe(BASIS_POINT)
    expect(formatFeeRate(tenth)).toBe('0.001')
  })
})

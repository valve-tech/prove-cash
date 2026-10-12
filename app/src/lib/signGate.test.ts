import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import {
  CURVE_LINEAR,
  DEFAULT_CHAIN,
  ZERO,
  ZERO_HASH,
  getChainId,
  memoryKeyValueStore,
  setChainId,
  setKeyValueStore,
  setSettlementOverride,
  settlementLive,
  signingDomain,
  type ChainId,
  type CustodyMode,
} from '@prove.cash/sdk'
import { LADDER, RUNGS, strongestRung, type Ctx } from './custody'
import { signAndArm } from './arm'

/**
 * A maker cannot sign an offer on a chain with no settlement, on any rung, by any route.
 *
 * The chain that was open: the registry carries a deliberate zero for 369, the network switcher
 * still offers 369, and the sign form's `ready` read the maker's numbers and never the chain. The
 * ladder locked four rungs when the settlement was missing and left `approval` open, so
 * `strongestRung` picked it, `arm.ts` skipped the approve transaction, and `signIntent` signed
 * against a `verifyingContract` of `0x0000…0000`. Seven such offers reached the public mainnet
 * archive. Only the default chain was fixed at the time; the route stayed open.
 *
 * Three guards close it, and this file holds all three, because a fix in one of them is worth
 * nothing if the other two are the ones a future change removes:
 *
 *   the ladder   every rung locks when the settlement is not live
 *   the form     `ready` reads `live`, so the button never enables
 *   the SDK      `signingDomain` throws, so a signature cannot be made whatever asks for one
 *
 * The last one is the only one a caller cannot get around, so most of what is below is about it.
 */

/** Not deployed, as an override rather than as a registry accident. */
const NONE: Address = '0x0000000000000000000000000000000000000000'

/**
 * The chain under test, overridden to hold no settlement.
 *
 * 369 and an override, not 369 and the registry: this file has to keep meaning what it means on
 * the day mainnet deploys, and an assertion that reads the registry's zero stops testing anything
 * that morning.
 */
const DEAD: ChainId = 369

const MAKER: Address = '0x1111111111111111111111111111111111111111'
const TOKEN_A: Address = '0x2222222222222222222222222222222222222222'
const TOKEN_B: Address = '0x3333333333333333333333333333333333333333'

const intent = () => ({
  maker: MAKER,
  recipient: MAKER,
  tokenIn: TOKEN_A,
  tokenOut: TOKEN_B,
  amountIn: 1_000n,
  minOutStart: 900n,
  minOutEnd: 900n,
  curve: CURVE_LINEAR,
  startTime: 0n,
  endTime: 1_000_000n,
  executor: ZERO,
  feeConfig: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  feeRate: 0n,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: 0,
  nonce: 1n,
})

/** Every context the ladder can be handed, other than `live`. */
const CONTEXTS: Omit<Ctx, 'live'>[] = []
for (const can3009 of [true, false, 'probing'] as const) {
  for (const canPermit of [true, false, 'probing'] as const) {
    for (const needsApproval of [true, false, null]) {
      CONTEXTS.push({ can3009, canPermit, needsApproval })
    }
  }
}

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  setChainId(DEAD)
  setSettlementOverride(DEAD, NONE)
})

afterEach(() => {
  setSettlementOverride(DEAD, null)
  setChainId(DEFAULT_CHAIN)
})

describe('the ladder on a chain with no settlement', () => {
  test('locks every rung, whatever the token can do', () => {
    expect(LADDER.length).toBeGreaterThan(0)
    for (const rest of CONTEXTS) {
      const ctx: Ctx = { live: false, ...rest }
      for (const mode of LADDER) {
        expect(RUNGS[mode](ctx).lock, `${mode} with ${JSON.stringify(rest)}`).toBeDefined()
      }
    }
  })

  test('still names a rung, and that rung is locked', () => {
    // The landmine, written down rather than fixed: a chooser has to highlight something, so the
    // fallback answers `approval` with every rung locked. Reading that answer as permission is
    // the bug this file exists for.
    const ctx: Ctx = { live: false, can3009: true, canPermit: true, needsApproval: false }
    const picked = strongestRung(ctx)
    expect(LADDER).toContain(picked)
    expect(RUNGS[picked](ctx).lock).toBeDefined()
  })

  test('unlocks again the moment a settlement exists', () => {
    // The other direction, so the lock cannot be a constant that happens to read correctly.
    const ctx: Ctx = { live: true, can3009: true, canPermit: true, needsApproval: false }
    expect(RUNGS.approval(ctx).lock).toBeUndefined()
    expect(strongestRung(ctx)).toBe('authorization')
  })
})

describe('the signing domain', () => {
  test('refuses a chain with no settlement', () => {
    expect(settlementLive(DEAD)).toBe(false)
    expect(() => signingDomain(DEAD)).toThrow(/not deployed/)
  })

  test('refuses the selected chain by default, with no argument to get wrong', () => {
    expect(getChainId()).toBe(DEAD)
    expect(() => signingDomain()).toThrow(/not deployed/)
  })

  test('names the settlement once one exists', () => {
    const FORK: Address = '0x00000000000000000000000000000000000f0f0f'
    setSettlementOverride(DEAD, FORK)
    expect(signingDomain(DEAD).verifyingContract).toBe(FORK)
    expect(signingDomain(DEAD).chainId).toBe(DEAD)
  })
})

describe('signAndArm', () => {
  /**
   * Every rung, by the one route all three sign forms take.
   *
   * `signAndArm` signs the terms before it arms anything, so the refusal lands on the first
   * signature and no rung reaches its second one. It never opens a wallet either, which is why
   * this runs with no provider in scope.
   */
  test.each(LADDER)('refuses on the %s rung', async (mode: CustodyMode) => {
    await expect(
      signAndArm({
        account: MAKER,
        intent: intent(),
        mode,
        // The caller's own claim, and it is a lie. The guard reads the chain instead, which is
        // the point: a form that computes `live` wrongly must not be able to talk its way past.
        live: true,
        needsApproval: false,
        fundsFrom: 0n,
        onPhase: () => {},
      }),
    ).rejects.toThrow(/not deployed/)
  })

  test('gets past the settlement check on a chain that has one', async () => {
    // Not a success — there is no browser wallet here, so this cannot sign. It proves the refusal
    // above is about the settlement rather than about everything in this environment failing.
    setSettlementOverride(DEAD, '0x00000000000000000000000000000000000f0f0f')
    const failure = await signAndArm({
      account: MAKER,
      intent: intent(),
      mode: 'approval',
      live: true,
      needsApproval: false,
      fundsFrom: 0n,
      onPhase: () => {},
    }).then(
      () => null,
      (e: unknown) => String(e),
    )
    expect(failure).not.toBeNull()
    expect(failure).not.toMatch(/not deployed/)
  })
})

import { describe, expect, test } from 'vitest'
import type { Address, Hex } from 'viem'
import { CURVE_LINEAR, FLAG_ESCROW, FLAG_PARTIAL, ZERO, type Permit2612, type SignedIntent, ZERO_HASH } from '../intent.js'
import { PARKED_ARMING } from './arming.js'
import { buildBook, entryOf, type BookEntry } from './book.js'
import {
  bestSubset,
  groupFeasible,
  groupKey,
  groupsFromBook,
  legOf,
  partition,
  planLegs,
  selectFeasible,
  type GroupLeg,
  type GroupLimits,
} from './groups.js'
import { selectDisjoint, solve, type Plan, type SolveParams } from './plan.js'
import type { PriceBook } from './price.js'

/**
 * Task #70: group fillability is not the conjunction of individual fillability.
 *
 * Three things a maker owns are shared across every intent they signed, and the fill spends all
 * three. The wallet balance is one, the EIP-2612 nonce queue is the second, and the parked row
 * `park` fills is the third. Each of the legs below passes `fillability` on its own; the pair
 * does not, and the engine has to see that before it sends.
 */

const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN_B = '0x00000000000000000000000000000000000000bb' as Address
const TOKEN_C = '0x00000000000000000000000000000000000000cc' as Address
const WPLS = '0x0000000000000000000000000000000000000f15' as Address
const EXECUTOR = '0x00000000000000000000000000000000000000e0' as Address
/** One maker on both sides of the board. Everything here turns on the legs being theirs. */
const MAKER = '0x00000000000000000000000000000000000000d1' as Address

const T0 = 1_800_000_000n
const ONE = 1_000_000_000_000_000_000n

const PERMIT: Permit2612 = {
  value: 100n * ONE,
  deadline: T0 + 86_400n,
  signature: `0x${'33'.repeat(64)}1c` as Hex,
}

let seq = 0

/** A signed intent. Every fixture here charges no fee, so a two-ring closes at one for one. */
function intentOf(o: {
  maker?: Address
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  minOut: bigint
  permit?: Permit2612
}): SignedIntent {
  seq++
  const maker = o.maker ?? (`0x${seq.toString(16).padStart(40, '0')}` as Address)
  return {
    maker,
    recipient: maker,
    tokenIn: o.tokenIn,
    tokenOut: o.tokenOut,
    amountIn: o.amountIn,
    minOutStart: o.minOut,
    minOutEnd: o.minOut,
    minFill: 0n,
    authNonce: `0x${'00'.repeat(32)}` as `0x${string}`,
    startTime: T0,
    endTime: T0 + 1800n,
    executor: ZERO,
    // Nowhere to send a fee is no fee at all, which keeps these rings exactly balanced.
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    flags: FLAG_PARTIAL,
    nonce: BigInt(seq),
    curve: CURVE_LINEAR,
    signature: `0x${'11'.repeat(65)}` as Hex,
    ...(o.permit ? { permit: o.permit } : {}),
  }
}

const entry = (i: SignedIntent, arming?: Hex, permitNonce?: bigint): BookEntry => ({
  ...entryOf(i, i.amountIn, `${i.maker}:${i.nonce}`, arming),
  ...(permitNonce === undefined ? {} : { permitNonce }),
})

const flatPrices = (tokens: readonly Address[]): PriceBook => ({
  wpls: WPLS,
  rates: new Map(tokens.map((t) => [t.toLowerCase(), { num: 1n, den: 1n }])),
})

const params = (o: Partial<SolveParams> = {}): SolveParams => ({
  at: T0,
  executor: EXECUTOR,
  gasPrice: 0n,
  prices: flatPrices([TOKEN_A, TOKEN_B, TOKEN_C, WPLS]),
  ...o,
})

/**
 * Two rings sharing one maker's token A, over two different pairs so nothing else pairs up.
 *
 * The maker sells token A twice: once for B, once for C. A counterparty closes each cycle. Every
 * leg is fillable on its own, which is the point — what they cannot do is both draw on the same
 * hundred tokens.
 */
function twoRings(o: { armed?: boolean; nonces?: [bigint, bigint] } = {}) {
  const arm = o.armed ? (`0x${'ab'.repeat(32)}` as Hex) : undefined
  const mine = [TOKEN_B, TOKEN_C].map((other) =>
    intentOf({
      maker: MAKER,
      tokenIn: TOKEN_A,
      tokenOut: other,
      amountIn: 100n * ONE,
      minOut: 90n * ONE,
      ...(o.armed ? { permit: PERMIT } : {}),
    }),
  )
  const theirs = [TOKEN_B, TOKEN_C].map((other) =>
    intentOf({ tokenIn: other, tokenOut: TOKEN_A, amountIn: 100n * ONE, minOut: 90n * ONE }),
  )
  const entries = [
    entry(mine[0], arm, o.nonces?.[0]),
    entry(mine[1], arm, o.nonces?.[1]),
    entry(theirs[0]),
    entry(theirs[1]),
  ]
  return { entries, mine, theirs }
}

/** The plans one rotation of each ring, so the two candidates are the two cycles and not four. */
const oneRotationEach = (plans: readonly Plan[]): Plan[] =>
  selectDisjoint(plans).filter((p) => p.fills.some((f) => f.intent.maker === MAKER))

// ── The partition rule ────────────────────────────────────────────────────────

describe('what makes two legs interact', () => {
  test('one maker and one token is the whole of the key', () => {
    expect(groupKey(MAKER, TOKEN_A)).toBe(groupKey(MAKER.toUpperCase(), TOKEN_A.toUpperCase()))
    expect(groupKey(MAKER, TOKEN_A)).not.toBe(groupKey(MAKER, TOKEN_B))
    expect(groupKey(EXECUTOR, TOKEN_A)).not.toBe(groupKey(MAKER, TOKEN_A))
  })

  test('legs of one maker on two tokens fall in two partitions and never constrain each other', () => {
    const legs: GroupLeg[] = [
      { key: 'a', maker: MAKER, token: TOKEN_A, draw: ONE, spendsPermit: false, parkedDraw: 0n },
      { key: 'b', maker: MAKER, token: TOKEN_B, draw: ONE, spendsPermit: false, parkedDraw: 0n },
    ]
    expect([...partition(legs).keys()]).toHaveLength(2)
  })

  test('a book entry becomes the leg its custody rung says it is', () => {
    const armed = entry(
      intentOf({
        maker: MAKER,
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_B,
        amountIn: 100n * ONE,
        minOut: 90n * ONE,
        permit: PERMIT,
      }),
      `0x${'ab'.repeat(32)}` as Hex,
      7n,
    )
    expect(legOf(armed, 40n * ONE)).toMatchObject({
      draw: 40n * ONE,
      spendsPermit: true,
      permitNonce: 7n,
    })
  })

  test('a leg armed out of parked capital competes for nothing in the maker’s wallet', () => {
    /*
      One word is the whole difference between the two escrow sources, and this is where it has to
      be read. A redemption pulls `amountIn` out of the wallet; the parked source moves money
      already inside the settlement and calls no token at all.

      Getting it wrong costs exactly the fills the source exists to enable. The maker most likely
      to be armed this way is the one whose stock is all in the contract, so `feasible` would size
      their budget from a wallet balance of zero and refuse every leg.
    */
    const escrow: SignedIntent = {
      ...intentOf({
        maker: MAKER,
        tokenIn: TOKEN_A,
        tokenOut: TOKEN_B,
        amountIn: 100n * ONE,
        minOut: 90n * ONE,
      }),
      flags: FLAG_PARTIAL | FLAG_ESCROW,
    }
    expect(legOf(entry(escrow, PARKED_ARMING), 40n * ONE).draw).toBe(0n)
    // It competes for the other pool instead, at the take: `_drawFromParked` moves
    // `take - _reserved[h]`, and the take is the most that can be.
    expect(legOf(entry(escrow, PARKED_ARMING), 40n * ONE).parkedDraw).toBe(40n * ONE)
    // The same intent, armed by a 3009 redemption instead: the whole amount, out of the wallet.
    const redeemed = legOf(entry(escrow, `0x${'cd'.repeat(96)}` as Hex), 40n * ONE)
    expect(redeemed.draw).toBe(escrow.amountIn)
    expect(redeemed.parkedDraw).toBe(0n)
  })
})

// ── The shared balance ────────────────────────────────────────────────────────

describe('one maker, one balance, two intents', () => {
  const { entries } = twoRings()
  const plans = oneRotationEach(solve(buildBook(entries, 369), params()))

  test('both rings are found, and each leg is fillable on its own', () => {
    expect(plans).toHaveLength(2)
  })

  test('disjointness alone would send both, because they name four different intents', () => {
    const keys = plans.flatMap((p) => p.fills.map((f) => `${f.intent.maker}:${f.intent.nonce}`))
    expect(new Set(keys).size).toBe(4)
    expect(selectDisjoint(plans)).toHaveLength(2)
  })

  test('a balance that covers one intent settles one ring, not two', () => {
    const draws = plans.map((p) => planLegs(p).find((l) => l.maker === MAKER)!.draw)
    // Enough for the larger of the two legs and not for both. Whichever ring runs first takes
    // the balance with it, and the other maker never gets paid.
    const budget = draws[0] > draws[1] ? draws[0] : draws[1]
    const groups = new Map([[groupKey(MAKER, TOKEN_A), { balance: budget }]])
    expect(selectFeasible(plans, { groups })).toHaveLength(1)
  })

  test('the budget a book load read is the budget the selection uses', () => {
    const draws = plans.map((p) => planLegs(p).find((l) => l.maker === MAKER)!.draw)
    const budget = draws[0] > draws[1] ? draws[0] : draws[1]
    const loaded = { funds: new Map([[groupKey(MAKER, TOKEN_A), budget]]) }
    expect(selectFeasible(plans, { groups: groupsFromBook(loaded) })).toHaveLength(1)
    expect(selectFeasible(plans, { groups: groupsFromBook({}) })).toHaveLength(2)
  })

  test('a balance that covers both settles both', () => {
    const draws = plans.map((p) => planLegs(p).find((l) => l.maker === MAKER)!.draw)
    const groups = new Map([[groupKey(MAKER, TOKEN_A), { balance: draws[0] + draws[1] }]])
    expect(selectFeasible(plans, { groups })).toHaveLength(2)
  })

  test('an unread balance constrains nothing, and says so rather than guessing', () => {
    // A budget nobody read is not a budget of zero. `dryRun` is what catches the shortfall then.
    expect(selectFeasible(plans)).toHaveLength(2)
  })

  test('the surviving ring is the better-valued one', () => {
    const draws = plans.map((p) => planLegs(p).find((l) => l.maker === MAKER)!.draw)
    const budget = draws[0] > draws[1] ? draws[0] : draws[1]
    const groups = new Map([[groupKey(MAKER, TOKEN_A), { balance: budget }]])
    const kept = selectFeasible(plans, { groups })
    const best = plans.reduce((a, b) => ((a.netNative ?? 0n) >= (b.netNative ?? 0n) ? a : b))
    expect(kept[0].ring.id).toBe(best.ring.id)
  })

  test('a funded escrow leg brings its own money and competes for nothing', () => {
    // `_reserved[h]` is keyed by the intent hash, so two funded escrow legs of one maker never
    // take the same wei twice. Their draw is zero and any budget holds them.
    const legs: GroupLeg[] = [
      { key: 'a', maker: MAKER, token: TOKEN_A, draw: 0n, spendsPermit: false, parkedDraw: 0n },
      { key: 'b', maker: MAKER, token: TOKEN_A, draw: 0n, spendsPermit: false, parkedDraw: 0n },
    ]
    expect(groupFeasible(legs, { balance: 0n })).toBe(true)
  })
})

// ── The parked row ────────────────────────────────────────────────────────────

/** An escrow offer of the shared maker, of the kind the parked source can fund. */
const escrowIntent = (other: Address): SignedIntent => ({
  ...intentOf({
    maker: MAKER,
    tokenIn: TOKEN_A,
    tokenOut: other,
    amountIn: 100n * ONE,
    minOut: 90n * ONE,
  }),
  flags: FLAG_PARTIAL | FLAG_ESCROW,
})

/** One entry armed from parked capital, carrying the row a book load read. */
const parkedEntry = (i: SignedIntent, row?: bigint): BookEntry =>
  entryOf(i, i.amountIn, `${i.maker}:${i.nonce}`, PARKED_ARMING, row)

/**
 * Two rings the same shape as `twoRings`, with the maker's legs armed from their parked row.
 *
 * Neither leg touches the wallet, so the balance says nothing about the pair. The row is what
 * both of them spend, and one row is what the maker has.
 */
function twoParkedRings(row?: bigint) {
  const mine = [TOKEN_B, TOKEN_C].map(escrowIntent)
  const theirs = [TOKEN_B, TOKEN_C].map((other) =>
    intentOf({ tokenIn: other, tokenOut: TOKEN_A, amountIn: 100n * ONE, minOut: 90n * ONE }),
  )
  return {
    entries: [
      parkedEntry(mine[0], row),
      parkedEntry(mine[1], row),
      entry(theirs[0]),
      entry(theirs[1]),
    ],
    mine,
    theirs,
  }
}

describe('one maker, one parked row, two escrow legs', () => {
  const { entries } = twoParkedRings()
  const plans = oneRotationEach(solve(buildBook(entries, 369), params()))
  /** What each ring asks of the row. `_drawFromParked` moves at most the take. */
  const draws = () => plans.map((p) => planLegs(p).find((l) => l.maker === MAKER)!.parkedDraw)
  const key = groupKey(MAKER, TOKEN_A)

  test('both rings are found, and neither maker leg touches the wallet', () => {
    expect(plans).toHaveLength(2)
    for (const p of plans) {
      const leg = planLegs(p).find((l) => l.maker === MAKER)!
      expect(leg.draw).toBe(0n)
      expect(leg.parkedDraw).toBeGreaterThan(0n)
    }
  })

  test('a row that covers one leg settles one ring, not two', () => {
    /*
      The defect this budget exists for. `_parked[maker][token]` is one pool behind every offer
      the maker has open in that asset, and both of these legs draw on it. Sized only against the
      wallet, the pair reads free — both legs draw zero there — and the solver sends a batch the
      row cannot pay for. `_drawFromParked` funds a leg in full or not at all, so the second leg
      moves nothing and the fill that follows finds the reservation short.
    */
    const [a, b] = draws()
    const budget = a > b ? a : b
    expect(selectFeasible(plans, { groups: new Map([[key, { parked: budget }]]) })).toHaveLength(1)
  })

  test('a row that covers both settles both', () => {
    const [a, b] = draws()
    expect(selectFeasible(plans, { groups: new Map([[key, { parked: a + b }]]) })).toHaveLength(2)
  })

  test('an unread row constrains nothing, and says so rather than guessing', () => {
    // The same convention the balance keeps: nobody read it, so it refuses nothing and `dryRun`
    // catches the shortfall.
    expect(selectFeasible(plans, { groups: new Map([[key, {}]]) })).toHaveLength(2)
  })

  test('the row a book load read is the row the selection uses', () => {
    const [a, b] = draws()
    const budget = a > b ? a : b
    // The rows ride on the entries, exactly as `loadBook` leaves them, and the counterparty
    // entries carry none at all.
    const withRow = entries.map((e) => (e.arming === PARKED_ARMING ? { ...e, parked: budget } : e))
    const groups = groupsFromBook(buildBook(withRow, 369))
    expect(groups.get(key)).toEqual({ parked: budget })
    expect(selectFeasible(plans, { groups })).toHaveLength(1)
  })

  test('a balance and a row are two budgets on one key, and a load reads both', () => {
    const withRow = entries.map((e) => (e.arming === PARKED_ARMING ? { ...e, parked: 5n } : e))
    const groups = groupsFromBook({ funds: new Map([[key, 9n]]), entries: withRow })
    expect(groups.get(key)).toEqual({ balance: 9n, parked: 5n })
  })

  test('a wallet leg and a parked leg never spend each other’s budget', () => {
    // Two pools, summed apart. The wallet leg is what the balance holds and the parked leg is
    // what the row holds, and neither number pays for the other.
    const legs: GroupLeg[] = [
      { key: 'w', maker: MAKER, token: TOKEN_A, draw: 10n * ONE, parkedDraw: 0n, spendsPermit: false },
      { key: 'p', maker: MAKER, token: TOKEN_A, draw: 0n, parkedDraw: 10n * ONE, spendsPermit: false },
    ]
    expect(groupFeasible(legs, { balance: 10n * ONE, parked: 10n * ONE })).toBe(true)
    expect(groupFeasible(legs, { balance: 10n * ONE, parked: 9n * ONE })).toBe(false)
    expect(groupFeasible(legs, { balance: 9n * ONE, parked: 10n * ONE })).toBe(false)
  })

  test('the enumeration picks the best-valued subset the row holds', () => {
    // The budget changed and the search did not. `bestSubset` still enumerates one partition and
    // asks `groupFeasible` about each subset, which is where the row is now sized.
    const parkedLeg = (k: string, take: bigint): GroupLeg => ({
      key: k,
      maker: MAKER,
      token: TOKEN_A,
      draw: 0n,
      parkedDraw: take,
      spendsPermit: false,
    })
    const legs = [parkedLeg('a', 10n * ONE), parkedLeg('b', 15n * ONE), parkedLeg('c', 20n * ONE)]
    const value = (l: GroupLeg) => (l.key === 'c' ? 3n : 2n)
    expect(
      bestSubset(legs, value, { parked: 25n * ONE })
        .map((l) => l.key)
        .sort(),
    ).toEqual(['a', 'b'])
  })
})

// ── The permit queue ──────────────────────────────────────────────────────────

describe('one maker, two permits, one nonce counter', () => {
  const nonces: [bigint, bigint] = [7n, 8n]
  const { entries } = twoRings({ armed: true, nonces })
  const plans = oneRotationEach(solve(buildBook(entries, 369), params()))
  /** The token has honoured seven permits, so the next digest it accepts commits to seven. */
  const groups = new Map([[groupKey(MAKER, TOKEN_A), { balance: 1_000n * ONE, permitNonce: 7n }]])

  test('both permits ride together, because seven then eight is the order the token counts in', () => {
    expect(plans).toHaveLength(2)
    expect(selectFeasible(plans, { groups })).toHaveLength(2)
  })

  test('dropping the earlier leg kills the later one, so the later one is not sent alone', () => {
    // This is the interaction the whole change exists for. The eight permit's digest commits to
    // nonce eight; the token is at seven and only a spent seven moves it. Leave the seven leg
    // out and the eight leg's signature is worth nothing — and the ring holding it reverts.
    const later = plans.filter((p) => permitNonceOf(p) === 8n)
    expect(later).toHaveLength(1)
    expect(selectFeasible(later, { groups })).toEqual([])
  })

  test('the earlier leg on its own is fine, because the token is already at its nonce', () => {
    const earlier = plans.filter((p) => permitNonceOf(p) === 7n)
    expect(selectFeasible(earlier, { groups })).toHaveLength(1)
  })

  test('a gap in the run is a signature nobody can spend', () => {
    const legs = [permitLeg('a', 7n), permitLeg('c', 9n)]
    expect(groupFeasible(legs, { permitNonce: 7n })).toBe(false)
    expect(groupFeasible([permitLeg('a', 7n), permitLeg('b', 8n)], { permitNonce: 7n })).toBe(true)
  })

  test('two permits at the same nonce are two claims on one slot', () => {
    expect(groupFeasible([permitLeg('a', 7n), permitLeg('b', 7n)], { permitNonce: 7n })).toBe(false)
  })

  test('without the token’s own nonce, a run starting anywhere is the best that can be said', () => {
    // The solver cannot tell a live run from a stale one here. It keeps the run and lets
    // `dryRun` refuse it, rather than dropping a pair that would have settled.
    expect(groupFeasible([permitLeg('a', 7n), permitLeg('b', 8n)])).toBe(true)
  })

  test('unresolved nonces carry no ordering, so at most one of them is admitted', () => {
    const unknown = [permitLeg('a'), permitLeg('b')]
    expect(groupFeasible(unknown)).toBe(false)
    expect(groupFeasible([permitLeg('a')])).toBe(true)
  })

  test('a leg that spends no nonce is not in the queue at all', () => {
    // An approval maker and a 3009 maker share the balance and nothing else: a 3009 nonce is the
    // intent hash, so it is per intent and orders nothing.
    const legs: GroupLeg[] = [
      { key: 'a', maker: MAKER, token: TOKEN_A, draw: ONE, spendsPermit: false, parkedDraw: 0n },
      { key: 'b', maker: MAKER, token: TOKEN_A, draw: ONE, spendsPermit: false, parkedDraw: 0n },
    ]
    expect(groupFeasible(legs, { permitNonce: 7n })).toBe(true)
  })
})

/** The nonce of the maker's permit leg in a plan. */
function permitNonceOf(plan: Plan): bigint | undefined {
  return planLegs(plan).find((l) => l.maker === MAKER)?.permitNonce
}

const permitLeg = (key: string, permitNonce?: bigint): GroupLeg => ({
  key,
  maker: MAKER,
  token: TOKEN_A,
  draw: 10n * ONE,
  parkedDraw: 0n,
  spendsPermit: true,
  ...(permitNonce === undefined ? {} : { permitNonce }),
})

// ── The enumeration ───────────────────────────────────────────────────────────

describe('enumerating inside a partition', () => {
  const limits: GroupLimits = { balance: 25n * ONE }
  const legs: GroupLeg[] = [
    { key: 'a', maker: MAKER, token: TOKEN_A, draw: 10n * ONE, spendsPermit: false, parkedDraw: 0n },
    { key: 'b', maker: MAKER, token: TOKEN_A, draw: 15n * ONE, spendsPermit: false, parkedDraw: 0n },
    { key: 'c', maker: MAKER, token: TOKEN_A, draw: 20n * ONE, spendsPermit: false, parkedDraw: 0n },
  ]

  test('the best-valued subset the budget holds, not the greediest one', () => {
    // Greedy on value takes `c` at 3 and stops, for 3. The pair `a`+`b` fits the same budget and
    // is worth 4. That gap is the reason this enumerates rather than walks.
    const value = (l: GroupLeg) => (l.key === 'c' ? 3n : 2n)
    expect(bestSubset(legs, value, limits).map((l) => l.key).sort()).toEqual(['a', 'b'])
  })

  test('a tie keeps the larger set, so nothing is dropped for no reason', () => {
    expect(bestSubset(legs.slice(0, 2), () => 0n, { balance: 100n * ONE })).toHaveLength(2)
  })

  test('a partition too large to enumerate refuses rather than hanging', () => {
    const many = Array.from({ length: 21 }, (_, k) => permitLeg(String(k)))
    expect(() => bestSubset(many, () => 1n)).toThrow(/not enumerable/)
  })
})

describe('what selection costs when nothing contends', () => {
  test('plans over separate makers are the old greedy answer, leg for leg', () => {
    const entries = [
      entry(intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountIn: 100n * ONE, minOut: 90n * ONE })),
      entry(intentOf({ tokenIn: TOKEN_B, tokenOut: TOKEN_A, amountIn: 100n * ONE, minOut: 90n * ONE })),
      entry(intentOf({ tokenIn: TOKEN_A, tokenOut: TOKEN_C, amountIn: 100n * ONE, minOut: 90n * ONE })),
      entry(intentOf({ tokenIn: TOKEN_C, tokenOut: TOKEN_A, amountIn: 100n * ONE, minOut: 90n * ONE })),
    ]
    const plans = solve(buildBook(entries, 369), params())
    expect(selectFeasible(plans).map((p) => p.ring.id)).toEqual(
      selectDisjoint(plans).map((p) => p.ring.id),
    )
  })

  test('an intent promised to a better plan is still only promised once', () => {
    const { entries } = twoRings()
    const plans = solve(buildBook(entries, 369), params())
    const kept = selectFeasible(plans)
    const keys = kept.flatMap((p) => p.fills.map((f) => `${f.intent.maker}:${f.intent.nonce}`))
    expect(new Set(keys).size).toBe(keys.length)
  })
})

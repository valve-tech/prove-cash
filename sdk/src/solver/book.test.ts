import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import { forgetMulticallProbes } from '../multicall.js'
import { CURVE_LINEAR, FLAG_ESCROW, FLAG_PARTIAL, FLAG_PERMIT2, ZERO, intentKey, type Auth3009, type Permit2612, type Permit2Transfer, type SignedIntent, ZERO_HASH } from '../intent.js'
import { loadBook } from './book.js'
import { groupKey } from './groups.js'

/**
 * What the chain's verdict does to the book, now that a solver can arm a leg.
 *
 * `loadBook` used to drop every `EscrowShort` intent, which is every maker who signed and sent
 * nothing — the whole gasless population. It keeps them now, with the bytes that reach their
 * funds, and drops only the ones no signature can rescue.
 */

const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN_B = '0x00000000000000000000000000000000000000bb' as Address
const TOKEN_C = '0x00000000000000000000000000000000000000cc' as Address
const EXECUTOR = '0x00000000000000000000000000000000000000e0' as Address
const SETTLEMENT = '0x00000000000000000000000000000000000000b2' as Address
const READER = '0x00000000000000000000000000000000000000c3' as Address
const MAKER = '0x00000000000000000000000000000000000000d1' as Address

const T0 = 1_800_000_000n
const ONE = 1_000_000_000_000_000_000n

const AUTH: Auth3009 = {
  validAfter: 0n,
  validBefore: T0 + 86_400n,
  signature: `0x${'22'.repeat(64)}1b` as Hex,
}
const PERMIT: Permit2612 = {
  value: 100n * ONE,
  deadline: T0 + 86_400n,
  signature: `0x${'33'.repeat(64)}1c` as Hex,
}
const PERMIT2: Permit2Transfer = {
  token: TOKEN_A,
  amount: 100n * ONE,
  deadline: T0 + 1800n,
  signature: `0x${'44'.repeat(64)}1b` as Hex,
}
/** Permit2's canonical address, passed in as an argument the way `loadBook` insists on. */
const PERMIT2_AT = '0x000000000022d473030f116ddee9f6b43ac78ba3' as Address

let seq = 0

function intentOf(o: {
  maker?: Address
  tokenIn?: Address
  escrow?: boolean
  auth?: Auth3009
  permit?: Permit2612
  permit2?: Permit2Transfer
  authNonce?: Hex
}): SignedIntent {
  seq++
  const maker = o.maker ?? (`0x${seq.toString(16).padStart(40, '0')}` as Address)
  return {
    maker,
    recipient: maker,
    tokenIn: o.tokenIn ?? TOKEN_A,
    tokenOut: TOKEN_B,
    amountIn: 100n * ONE,
    minOutStart: 90n * ONE,
    minOutEnd: 90n * ONE,
    minFill: 0n,
    authNonce: o.authNonce ?? (`0x${'00'.repeat(32)}` as Hex),
    startTime: T0,
    endTime: T0 + 1800n,
    executor: ZERO,
    feeConfig: ZERO_HASH,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    flags: FLAG_PARTIAL | (o.escrow ? FLAG_ESCROW : 0) | (o.permit2 ? FLAG_PERMIT2 : 0),
    nonce: BigInt(seq),
    curve: CURVE_LINEAR,
    signature: `0x${'11'.repeat(65)}` as Hex,
    ...(o.auth ? { auth: o.auth } : {}),
    ...(o.permit ? { permit: o.permit } : {}),
    ...(o.permit2 ? { permit2: o.permit2 } : {}),
  }
}

/** The reason ordinals, in the contract's declared order. */
const OK = 0
const ESCROW_SHORT = 10
const EXPIRED = 3

type Call = { functionName: string; args: readonly unknown[] }

/**
 * A chain that answers by function name. No Multicall3, so every read arrives here on its own
 * and the test can see the arguments each one carries.
 */
function chain(
  reasons: readonly number[],
  balances: Record<string, bigint> = {},
  words: Record<string, bigint> = {},
  parked: Record<string, bigint> = {},
) {
  const calls: Call[] = []
  let asked = 0
  return {
    calls,
    client: {
      getCode: vi.fn(async () => '0x'),
      readContract: vi.fn(async (c: Call & { args: readonly unknown[] }) => {
        calls.push({ functionName: c.functionName, args: c.args })
        if (c.functionName === 'available') return [100n * ONE, true]
        if (c.functionName === 'fillability') return reasons[asked++]
        if (c.functionName === 'balanceOf') return balances[String(c.args[0]).toLowerCase()] ?? 0n
        if (c.functionName === 'nonceBitmap')
          return words[`${String(c.args[0]).toLowerCase()}:${c.args[1]}`] ?? 0n
        if (c.functionName === 'parked')
          return (
            parked[`${String(c.args[0]).toLowerCase()}:${String(c.args[1]).toLowerCase()}`] ?? 0n
          )
        throw new Error(`unexpected read: ${c.functionName}`)
      }),
    },
  }
}

const load = (intents: readonly SignedIntent[], c: ReturnType<typeof chain>) =>
  loadBook(intents, {
    executor: EXECUTOR,
    settlementAddress: SETTLEMENT,
    readerAddress: READER,
    chainId: 369,
    client: c.client as never,
  })

beforeEach(() => {
  forgetMulticallProbes()
})

describe('the fillability question itself', () => {
  test('carries the fee bound the contract asks for', async () => {
    // Five arguments, not four. A call built without the bound encodes nothing viem will send,
    // so every book load threw before this — silently, because the whole batch fell over at once.
    const c = chain([OK])
    await load([intentOf({})], c)
    const probe = c.calls.find((x) => x.functionName === 'fillability')!
    expect(probe.args).toHaveLength(5)
    expect(probe.args[4]).toBe((1n << 256n) - 1n)
  })

  test('takes an operator’s own ceiling when one is named', async () => {
    const c = chain([OK])
    await loadBook([intentOf({})], {
      executor: EXECUTOR,
      settlementAddress: SETTLEMENT,
      readerAddress: READER,
      chainId: 369,
      client: c.client as never,
      maxFeeRate: 500n,
    })
    expect(c.calls.find((x) => x.functionName === 'fillability')!.args[4]).toBe(500n)
  })
})

describe('a leg the chain refuses and the solver can arm', () => {
  test('an escrow maker who signed an authorization stays in the book', async () => {
    const i = intentOf({ escrow: true, auth: AUTH })
    const { book, rejected } = await load([i], chain([ESCROW_SHORT]))
    expect(rejected).toEqual([])
    expect(book.entries).toHaveLength(1)
    expect(book.entries[0].arming).toMatch(/^0x[0-9a-f]+$/)
  })

  test('a wallet maker who signed a permit stays in the book', async () => {
    const i = intentOf({ permit: PERMIT })
    const { book } = await load([i], chain([ESCROW_SHORT]))
    expect(book.entries).toHaveLength(1)
    expect(book.entries[0].arming).toBeTruthy()
  })

  test('the same reason with nothing behind it is still a rejection', async () => {
    const { book, rejected } = await load([intentOf({})], chain([ESCROW_SHORT]))
    expect(book.entries).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe('EscrowShort')
  })

  test('a leg the chain already fills carries no arming, so no nonce is spent on it', async () => {
    const { book } = await load([intentOf({ permit: PERMIT })], chain([OK]))
    expect(book.entries).toHaveLength(1)
    expect(book.entries[0].arming).toBeUndefined()
  })

  test('every other refusal is still a refusal', async () => {
    const { book, rejected } = await load([intentOf({ permit: PERMIT })], chain([EXPIRED]))
    expect(book.entries).toEqual([])
    expect(rejected[0].reason).toBe('Expired')
  })
})

describe('reading the shared balance', () => {
  test('a maker with one intent on a token costs no extra read', async () => {
    const c = chain([OK, OK])
    const { book } = await load([intentOf({}), intentOf({})], c)
    expect(c.calls.filter((x) => x.functionName === 'balanceOf')).toEqual([])
    expect(book.funds).toBeUndefined()
  })

  test('a maker with two intents on one token is read exactly once', async () => {
    const c = chain([OK, OK], { [MAKER.toLowerCase()]: 40n * ONE })
    const { book } = await load([intentOf({ maker: MAKER }), intentOf({ maker: MAKER })], c)
    expect(c.calls.filter((x) => x.functionName === 'balanceOf')).toHaveLength(1)
    expect(book.funds?.get(groupKey(MAKER, TOKEN_A))).toBe(40n * ONE)
  })

  test('the same maker on two tokens is two separate holdings, and neither contends', async () => {
    const c = chain([OK, OK])
    const { book } = await load(
      [intentOf({ maker: MAKER }), intentOf({ maker: MAKER, tokenIn: TOKEN_B })],
      c,
    )
    expect(c.calls.filter((x) => x.functionName === 'balanceOf')).toEqual([])
    expect(book.funds).toBeUndefined()
  })

  test('a caller can decline the read', async () => {
    const c = chain([OK, OK])
    await loadBook([intentOf({ maker: MAKER }), intentOf({ maker: MAKER })], {
      executor: EXECUTOR,
      settlementAddress: SETTLEMENT,
      readerAddress: READER,
      chainId: 369,
      client: c.client as never,
      funds: false,
    })
    expect(c.calls.filter((x) => x.functionName === 'balanceOf')).toEqual([])
  })
})

describe('a permit2 nonce another solver already spent', () => {
  const MAKER_P2 = '0x00000000000000000000000000000000000000c1' as Address
  const nonceHex = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex
  const p2 = (nonce: bigint) =>
    intentOf({ maker: MAKER_P2, permit2: PERMIT2, authNonce: nonceHex(nonce) })

  const loadWithBitmap = (
    intents: readonly SignedIntent[],
    c: ReturnType<typeof chain>,
    permit2: Address | null = PERMIT2_AT,
  ) =>
    loadBook(intents, {
      executor: EXECUTOR,
      settlementAddress: SETTLEMENT,
      readerAddress: READER,
      chainId: 369,
      client: c.client as never,
      ...(permit2 ? { permit2 } : {}),
    })

  test('a short reservation and a spent nonce leaves the book', async () => {
    // The reason this read exists. `fillability` says `EscrowShort` to a leg nobody funded and to
    // a leg whose nonce a rival burned, and only the bitmap tells them apart. Keeping the second
    // one means planning a fill, sending arming bytes Permit2 refuses, and paying for it.
    const c = chain([ESCROW_SHORT], {}, { [`${MAKER_P2.toLowerCase()}:0`]: 1n << 5n })
    const { book, rejected } = await loadWithBitmap([p2(5n)], c)
    expect(book.entries).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe('EscrowShort')
  })

  test('a short reservation and an unspent nonce is still ours to arm', async () => {
    const c = chain([ESCROW_SHORT], {}, { [`${MAKER_P2.toLowerCase()}:0`]: 1n << 6n })
    const { book } = await loadWithBitmap([p2(5n)], c)
    expect(book.entries).toHaveLength(1)
    expect(book.entries[0].arming).toBeTruthy()
  })

  test('a spent nonce does NOT drop a leg the chain already calls fillable', async () => {
    // The failure this wiring had to avoid. An `Ok` permit2 leg reads `Ok` BECAUSE somebody spent
    // the nonce: their fill promoted the signature into a reservation covering the whole intent,
    // which is ours to draw with no signature at all. Dropping these would discard exactly the
    // legs a rival had just funded — the most fillable set on the board.
    const c = chain([OK], {}, { [`${MAKER_P2.toLowerCase()}:0`]: 1n << 5n })
    const { book } = await loadWithBitmap([p2(5n)], c)
    expect(book.entries).toHaveLength(1)
    expect(book.entries[0].arming).toBeUndefined()
    // And no word was bought for it: an `Ok` leg cannot have its verdict changed by the answer.
    expect(c.calls.filter((x) => x.functionName === 'nonceBitmap')).toEqual([])
  })

  test('a leg on another rung is unaffected, and costs no read', async () => {
    // A 2612 permit spends an ordered token nonce and a 3009 authorization has no slot here. A
    // bitmap word says nothing about either, so reading one against them would drop armable legs.
    const c = chain([ESCROW_SHORT, ESCROW_SHORT], {}, { [`${MAKER.toLowerCase()}:0`]: ~0n })
    const { book, rejected } = await loadWithBitmap(
      [
        intentOf({ maker: MAKER, permit: PERMIT }),
        intentOf({ maker: MAKER, escrow: true, auth: AUTH }),
      ],
      c,
    )
    expect(rejected).toEqual([])
    expect(book.entries).toHaveLength(2)
    expect(c.calls.filter((x) => x.functionName === 'nonceBitmap')).toEqual([])
  })

  test('two of a maker’s legs in one word cost one read', async () => {
    const burned = p2(5n)
    const live = p2(7n)
    const c = chain([ESCROW_SHORT, ESCROW_SHORT], {}, { [`${MAKER_P2.toLowerCase()}:0`]: 1n << 5n })
    const { book, rejected } = await loadWithBitmap([burned, live], c)
    const reads = c.calls.filter((x) => x.functionName === 'nonceBitmap')
    expect(reads).toHaveLength(1)
    expect(reads[0].args).toEqual([MAKER_P2, 0n])
    // One word, two answers, and they differ.
    expect(rejected.map((r) => r.key)).toEqual([intentKey(burned)])
    expect(book.entries.map((e) => e.key)).toEqual([intentKey(live)])
  })

  test('a caller who names no Permit2 gets the old answer and no read at all', async () => {
    // Resolving the address costs two reads of its own, and a book of wallet legs would pay them
    // for an answer nothing uses. Silence here has to mean "not asked", not "not spent".
    const c = chain([ESCROW_SHORT], {}, { [`${MAKER_P2.toLowerCase()}:0`]: 1n << 5n })
    const { book } = await loadWithBitmap([p2(5n)], c, null)
    expect(c.calls.filter((x) => x.functionName === 'nonceBitmap')).toEqual([])
    expect(book.entries).toHaveLength(1)
  })
})

/**
 * What the parked read puts back into the book, and what it costs a maker.
 *
 * `loadBook` used to drop an escrow signature its maker never funded, and so did the chain: only
 * a transaction from the maker could ever change that answer. `park` ended it. These are the
 * cases the app's copy has to be true about — `AUDIT-SCOPE` 6.11.
 */
describe('an escrow signature nobody funded', () => {
  const row = (maker: Address, token: Address = TOKEN_A) =>
    `${maker.toLowerCase()}:${token.toLowerCase()}`

  test('enters the book when its maker has capital parked in the same token', async () => {
    const i = intentOf({ escrow: true, maker: MAKER })
    const c = chain([ESCROW_SHORT], {}, {}, { [row(MAKER)]: 50n * ONE })
    const { book, rejected } = await load([i], c)
    expect(rejected).toEqual([])
    expect(book.entries).toHaveLength(1)
    // One word, and the word is the whole message.
    expect(book.entries[0].arming).toHaveLength(66)
    expect(book.entries[0].parked).toBe(50n * ONE)
  })

  test('stays out of it when the row is empty', async () => {
    // Which is every maker who has never had a dead offer parked. The read costs one call and
    // changes nothing for them.
    const i = intentOf({ escrow: true, maker: MAKER })
    const { book, rejected } = await load([i], chain([ESCROW_SHORT]))
    expect(book.entries).toEqual([])
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toBe('EscrowShort')
  })

  test('is asked about once for a maker with two offers in one token', async () => {
    // `_parked` is keyed by maker and token, so a maker's whole escrow book in one asset answers
    // from one slot.
    const c = chain([ESCROW_SHORT, ESCROW_SHORT], {}, {}, { [row(MAKER)]: 50n * ONE })
    const { book } = await load(
      [intentOf({ escrow: true, maker: MAKER }), intentOf({ escrow: true, maker: MAKER })],
      c,
    )
    expect(c.calls.filter((x) => x.functionName === 'parked')).toHaveLength(1)
    expect(book.entries).toHaveLength(2)
  })

  test('an operator who will not fill out of parked capital turns the read off', async () => {
    // And gets the board this file described before #120: no call, and the leg back out.
    const c = chain([ESCROW_SHORT], {}, {}, { [row(MAKER)]: 50n * ONE })
    const { book } = await loadBook([intentOf({ escrow: true, maker: MAKER })], {
      executor: EXECUTOR,
      settlementAddress: SETTLEMENT,
      readerAddress: READER,
      chainId: 369,
      client: c.client as never,
      parked: false,
    })
    expect(c.calls.filter((x) => x.functionName === 'parked')).toHaveLength(0)
    expect(book.entries).toEqual([])
  })

  test('a leg the chain already fills is never asked about', async () => {
    // `Ok` needs no arming, so the row cannot change the answer and a call for it is a call the
    // board pays for and never reads.
    const c = chain([OK], {}, {}, { [row(MAKER)]: 50n * ONE })
    const { book } = await load([intentOf({ escrow: true, maker: MAKER })], c)
    expect(c.calls.filter((x) => x.functionName === 'parked')).toHaveLength(0)
    expect(book.entries[0].arming).toBeUndefined()
  })

  test('a maker’s parked capital cannot arm a leg in a token they did not park', async () => {
    // `_drawFromParked` reads `_parked[i.maker][i.tokenIn]` and can read nothing else. The row is
    // per token, so a full row in A is nothing at all to an offer selling B.
    const c = chain([ESCROW_SHORT], {}, {}, { [row(MAKER)]: 50n * ONE })
    const { book, rejected } = await load(
      [intentOf({ escrow: true, maker: MAKER, tokenIn: TOKEN_C })],
      c,
    )
    expect(book.entries).toEqual([])
    expect(rejected).toHaveLength(1)
  })
})

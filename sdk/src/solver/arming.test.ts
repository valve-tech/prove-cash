import { beforeEach, describe, expect, test, vi } from 'vitest'
import {
  decodeAbiParameters,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type TypedDataDomain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { PERMIT_TYPES } from '../custody.js'
import { CURVE_LINEAR, FLAG_ESCROW, FLAG_PARTIAL, FLAG_PERMIT2, ZERO, intentHashOf, intentKey, type Auth3009, type Permit2612, type Permit2Transfer, type SignedIntent, ZERO_HASH } from '../intent.js'
import { forgetMulticallProbes } from '../multicall.js'
import {
  ARM_FROM_PARKED,
  PARKED_ARMING,
  armableAt,
  armingKind,
  armingWindow,
  encodeArming,
  permit2NonceSlot,
  permit2NonceSpent,
  permit2SpentNonces,
  reachabilityOf,
  readParked,
  recoverPermitNonce,
  spendsPermitNonce,
  walletDraw,
} from './arming.js'

/**
 * Task #71 in one file: `EscrowShort` is not a rejection any more.
 *
 * `_evaluate` answers it for an escrow holding too little and for an allowance the maker never
 * granted. On a leg the solver can arm, both mean "needs arming". A solver that reads it as a
 * refusal skips every gasless maker on the board — the population the arming work exists to
 * reach — so this file pins the classification rather than leaving it to a comment.
 */

const TOKEN_A = '0x00000000000000000000000000000000000000aa' as Address
const TOKEN_B = '0x00000000000000000000000000000000000000bb' as Address
const RELAYER = '0x00000000000000000000000000000000000000e1' as Address
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

let seq = 0

function intentOf(o: {
  escrow?: boolean
  permit2?: Permit2Transfer
  auth?: Auth3009
  permit?: Permit2612
  maker?: Address
  authNonce?: Hex
}): SignedIntent {
  seq++
  const maker = o.maker ?? (`0x${seq.toString(16).padStart(40, '0')}` as Address)
  return {
    maker,
    recipient: maker,
    tokenIn: TOKEN_A,
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

describe('what a fill reason means to a solver that can arm', () => {
  test('an escrow leg the solver can fund is reachable, not rejected', () => {
    const i = intentOf({ escrow: true, auth: AUTH })
    expect(reachabilityOf('EscrowShort', i)).toBe('armable')
    expect(armingKind(i)).toBe('authorization')
  })

  test('a wallet leg with no allowance and a permit is reachable, not rejected', () => {
    const i = intentOf({ permit: PERMIT })
    expect(reachabilityOf('EscrowShort', i)).toBe('armable')
    expect(armingKind(i)).toBe('permit')
  })

  test('the same reason with no signature behind it is still a rejection', () => {
    expect(reachabilityOf('EscrowShort', intentOf({}))).toBe('unreachable')
    expect(reachabilityOf('EscrowShort', intentOf({ escrow: true }))).toBe('unreachable')
  })

  test('a signature for the wrong rung arms nothing', () => {
    // A permit cannot fund an escrow and an authorization cannot grant an allowance. The escrow
    // flag decides which, exactly as `armLeg` does.
    expect(reachabilityOf('EscrowShort', intentOf({ escrow: true, permit: PERMIT }))).toBe(
      'unreachable',
    )
    expect(reachabilityOf('EscrowShort', intentOf({ auth: AUTH }))).toBe('unreachable')
  })

  test('every other refusal stays a refusal, whatever the solver holds', () => {
    const i = intentOf({ permit: PERMIT })
    for (const reason of ['Expired', 'Cancelled', 'NonceTooLow', 'BadSignature', 'FeeTooHigh']) {
      expect(reachabilityOf(reason as never, i)).toBe('unreachable')
    }
  })

  test('a leg the chain already fills carries no arming at all', () => {
    // Arming an `Ok` permit leg would spend one of the maker's EIP-2612 nonces to grant an
    // allowance they already granted — and that nonce orders every other permit they signed.
    const i = intentOf({ permit: PERMIT })
    expect(reachabilityOf('Ok', i)).toBe('fillable')
  })
})

describe('the bytes that reach a maker', () => {
  test('an authorization names the intent it funds, in its 3009 nonce', () => {
    const i = intentOf({ escrow: true, auth: AUTH })
    const bytes = encodeArming(i, 369)!
    const [auth] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
            { name: 'signature', type: 'bytes' },
          ],
        },
      ],
      bytes,
    )
    // Without this the same signature would arm every same-size intent the maker ever signs.
    expect(auth.nonce).toBe(intentHashOf(i, 369))
    expect(auth.validBefore).toBe(AUTH.validBefore)
    // Whole, not split into v/r/s. The contract picks the token's overload by the length, so a
    // signature that is not 65 bytes is how a contract wallet reaches the gasless rung at all.
    expect(auth.signature).toBe(AUTH.signature)
  })

  test('the hash follows the chain, so bytes built for one chain arm nothing on another', () => {
    const i = intentOf({ escrow: true, auth: AUTH })
    expect(encodeArming(i, 369)).not.toBe(encodeArming(i, 943))
  })

  test('a permit travels as value, deadline and a split signature', () => {
    const bytes = encodeArming(intentOf({ permit: PERMIT }), 369)!
    const [p] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'value', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
            { name: 'v', type: 'uint8' },
            { name: 'r', type: 'bytes32' },
            { name: 's', type: 'bytes32' },
          ],
        },
      ],
      bytes,
    )
    expect(p.value).toBe(PERMIT.value)
    expect(p.deadline).toBe(PERMIT.deadline)
    expect(p.v).toBe(28)
  })

  test('an intent with no signature for its rung encodes nothing', () => {
    expect(encodeArming(intentOf({}), 369)).toBeNull()
  })

  test('a permit2 transfer names the intent it funds, in its Permit2 nonce', () => {
    const i = intentOf({ permit2: PERMIT2 })
    const bytes = encodeArming(i, 369)!
    const [p] = decodeAbiParameters(
      [
        {
          type: 'tuple',
          components: [
            { name: 'token', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'nonce', type: 'uint256' },
            { name: 'deadline', type: 'uint256' },
            { name: 'signature', type: 'bytes' },
          ],
        },
      ],
      bytes,
    )
    // The nonce is derived here, never carried on the wire — and the settlement refuses any
    // other, which is what welds one Permit2 signature to one offer.
    expect(p.nonce).toBe(BigInt(intentHashOf(i, 369)))
    expect(p.token.toLowerCase()).toBe(PERMIT2.token)
    expect(p.amount).toBe(PERMIT2.amount)
    expect(p.deadline).toBe(PERMIT2.deadline)
    // Whole, like a 3009 authorization's and unlike an EIP-2612 permit's: Permit2 reads an
    // ERC-1271 answer, so a contract wallet's signature is not 65 bytes and must not be split.
    expect(p.signature).toBe(PERMIT2.signature)
  })

  test('a permit2 leg with no signature is unreachable rather than armable', () => {
    const i = intentOf({})
    i.flags |= FLAG_PERMIT2
    expect(armingKind(i)).toBe('none')
    expect(reachabilityOf('EscrowShort', i)).toBe('unreachable')
    expect(encodeArming(i, 369)).toBeNull()
  })

  test('a permit2 leg the solver holds a signature for is armable', () => {
    const i = intentOf({ permit2: PERMIT2 })
    expect(armingKind(i)).toBe('permit2')
    expect(reachabilityOf('EscrowShort', i)).toBe('armable')
    // A Permit2 nonce is unordered, so spending it takes no other signature of the maker's with
    // it. That is what `spendsPermitNonce` is asking about, and the answer here is no.
    expect(spendsPermitNonce(i, true)).toBe(false)
  })
})

describe('a permit2 nonce that another solver already spent', () => {
  const p2 = () => intentOf({ permit2: PERMIT2 })

  test('the bit is found where Permit2 keeps it', () => {
    // Unordered nonces: the low byte picks the bit, everything above it picks the word.
    expect(permit2NonceSlot(0n)).toEqual({ wordPos: 0n, bitPos: 0n })
    expect(permit2NonceSlot(255n)).toEqual({ wordPos: 0n, bitPos: 255n })
    expect(permit2NonceSlot(256n)).toEqual({ wordPos: 1n, bitPos: 0n })
    expect(permit2NonceSlot(513n)).toEqual({ wordPos: 2n, bitPos: 1n })
  })

  test('a word says which of its nonces are spent', () => {
    expect(permit2NonceSpent(0n, 5n)).toBe(false)
    expect(permit2NonceSpent(1n << 5n, 5n)).toBe(true)
    // Its neighbours are somebody else's business.
    expect(permit2NonceSpent(1n << 5n, 6n)).toBe(false)
    expect(permit2NonceSpent(1n << 5n, 4n)).toBe(false)
    // The word only covers the low byte, so 261 shares a bit with 5 in a DIFFERENT word. Asking
    // with the wrong word is the caller's mistake to make; asking with the right one is exact.
    expect(permit2NonceSpent((1n << 255n) | 1n, 255n)).toBe(true)
  })

  test('a short reservation and a spent nonce is a leg nobody can arm', () => {
    expect(reachabilityOf('EscrowShort', p2(), true)).toBe('unreachable')
  })

  test('a short reservation and an unspent nonce is still ours to arm', () => {
    expect(reachabilityOf('EscrowShort', p2(), false)).toBe('armable')
  })

  test('a spent nonce does NOT condemn a leg the chain already calls fillable', () => {
    // The whole point, and the way this check would have been worse than useless if it read a
    // spent nonce as a dead leg. Several solvers hold the same permit and one lands first. Its
    // fill promoted the signature into a reservation covering the whole intent — so the losers
    // read `Ok`, need no signature at all, and fill from what the winner put there.
    //
    // Dropping those legs would discard exactly the ones a rival had just funded, which is the
    // most fillable set on the book.
    expect(reachabilityOf('Ok', p2(), true)).toBe('fillable')
  })

  test('spentness is asked only of the rung it belongs to', () => {
    // A 2612 permit spends an ORDERED nonce on the token, not a Permit2 bitmap slot, and a
    // standing allowance survives it. Reading this flag against those rungs would drop legs that
    // are perfectly armable.
    expect(reachabilityOf('EscrowShort', intentOf({ permit: PERMIT }), true)).toBe('armable')
    expect(reachabilityOf('EscrowShort', intentOf({ escrow: true, auth: AUTH }), true)).toBe(
      'armable',
    )
  })

  test('not knowing errs toward trying', () => {
    // A wasted arming costs gas. A wrongly dropped leg costs the fill, and the solver never finds
    // out. So the default when nobody read the bitmap is the answer we gave before it existed.
    expect(reachabilityOf('EscrowShort', p2())).toBe('armable')
    expect(reachabilityOf('EscrowShort', p2(), undefined)).toBe('armable')
  })

  test('a reason arming cannot fix stays unreachable however the nonce reads', () => {
    for (const spent of [true, false, undefined]) {
      expect(reachabilityOf('Expired', p2(), spent)).toBe('unreachable')
      expect(reachabilityOf('Cancelled', p2(), spent)).toBe('unreachable')
    }
  })
})

describe('reading the bitmap', () => {
  const PERMIT2_AT = '0x000000000022d473030f116ddee9f6b43ac78ba3' as Address
  const MAKER_A = '0x00000000000000000000000000000000000000a1' as Address
  const MAKER_B = '0x00000000000000000000000000000000000000b1' as Address

  const nonceHex = (n: bigint) => `0x${n.toString(16).padStart(64, '0')}` as Hex
  const p2At = (maker: Address, nonce: bigint) =>
    intentOf({ permit2: PERMIT2, maker, authNonce: nonceHex(nonce) })

  type Read = { address: string; args: readonly unknown[] }

  /** A chain with no Multicall3, so every bitmap read arrives on its own and can be counted. */
  function chain(words: Record<string, bigint>, fail = false) {
    const reads: Read[] = []
    return {
      reads,
      client: {
        getCode: vi.fn(async () => '0x'),
        readContract: vi.fn(async (c: Read & { functionName: string }) => {
          reads.push({ address: c.address, args: c.args })
          if (c.functionName !== 'nonceBitmap') throw new Error(`unexpected: ${c.functionName}`)
          if (fail) throw new Error('fetch failed')
          return words[`${String(c.args[0]).toLowerCase()}:${c.args[1]}`] ?? 0n
        }),
      },
    }
  }

  const ask = (intents: readonly SignedIntent[], c: ReturnType<typeof chain>) =>
    permit2SpentNonces(intents, { permit2: PERMIT2_AT, chainId: 369, client: c.client as never })

  beforeEach(() => {
    forgetMulticallProbes()
  })

  test('two nonces in one word cost one read, not two', async () => {
    // The whole reason this helper takes a set rather than an intent. 256 unordered nonces share
    // a word, so a maker's live offers usually all answer from one slot. A read per leg asks the
    // same question over and over, and a board poll that should be one round trip becomes a rate
    // limit — which `batchRead` reports as `unreadable`, so the legs come back unknown and the
    // read bought nothing at all.
    const c = chain({ [`${MAKER_A.toLowerCase()}:0`]: 1n << 5n })
    const spent = await ask([p2At(MAKER_A, 5n), p2At(MAKER_A, 7n)], c)
    expect(c.reads).toHaveLength(1)
    expect(c.reads[0].address).toBe(PERMIT2_AT)
    expect(c.reads[0].args).toEqual([MAKER_A, 0n])
    // One word, two answers, and they differ.
    expect([...spent.values()]).toEqual([true, false])
  })

  test('a different owner or a different word is a different read', async () => {
    // Deduplication is on the pair, not on either half. Folding two makers into one read would
    // hand B the answer about A, and 300 lives in word 1 however many of A's nonces sit in 0.
    const c = chain({})
    await ask([p2At(MAKER_A, 5n), p2At(MAKER_B, 5n), p2At(MAKER_A, 300n)], c)
    expect(c.reads.map((r) => r.args)).toEqual([
      [MAKER_A, 0n],
      [MAKER_B, 0n],
      [MAKER_A, 1n],
    ])
  })

  test('a rung that is not permit2 is never asked about', async () => {
    // A 2612 permit spends an ordered nonce on the token and a 3009 authorization is the token's
    // own business. Neither has a slot in this bitmap, so a read here would answer about a word
    // that means nothing to them — and spend a round trip to do it.
    const c = chain({})
    const spent = await ask(
      [intentOf({ permit: PERMIT }), intentOf({ escrow: true, auth: AUTH }), intentOf({})],
      c,
    )
    expect(c.reads).toHaveLength(0)
    expect(spent.size).toBe(0)
  })

  test('a word that never came back leaves the leg unknown rather than spent', async () => {
    // A dropped request is not a fact about the chain. Omitting the leg sends `undefined` on to
    // `reachabilityOf`, which errs toward trying — a rate limit must never read as a dead offer.
    const c = chain({}, true)
    const spent = await ask([p2At(MAKER_A, 5n)], c)
    expect(c.reads).toHaveLength(1)
    expect(spent.size).toBe(0)
  })

  test('the answer is keyed the way the book keys its entries', async () => {
    const i = p2At(MAKER_A, 5n)
    const c = chain({ [`${MAKER_A.toLowerCase()}:0`]: 1n << 5n })
    const spent = await ask([i], c)
    expect(spent.get(intentKey(i))).toBe(true)
  })
})

describe('what a leg draws from the maker', () => {
  test('an armed permit2 leg draws the whole intent, not the take', () => {
    const i = intentOf({ permit2: PERMIT2 })
    // This asserted the take, on the reasoning that Permit2 allows a request under the permitted
    // amount and so strands nothing. The saving was never real: a non-partial intent takes what
    // is left, which IS `amountIn`. It differed only for a PARTIAL intent, and there the small
    // draw shut the door — a Permit2 nonce is spent on the first transfer however little it asks
    // for, so the rest of a live offer became unreachable. The first fill draws the whole intent
    // now and leaves a reservation the later fills settle from.
    expect(walletDraw(i, 30n * ONE, true)).toBe(i.amountIn)
    // And nothing at all before it is armed, which is unchanged: an unarmed permit2 leg has not
    // touched the wallet, so it cannot be competing with anything for it.
    expect(walletDraw(i, 30n * ONE, false)).toBe(0n)
  })

  test('an armed permit2 leg draws like an escrow one, because it now is one', () => {
    // The two rungs answered this question differently and no longer do. Worth its own line: the
    // draw is what `groups.ts` partitions on, so a rung that lies here plans batches that cannot
    // settle together.
    const p2 = intentOf({ permit2: PERMIT2 })
    const esc = intentOf({ escrow: true })
    expect(walletDraw(p2, 30n * ONE, true)).toBe(walletDraw(esc, 30n * ONE, true))
  })

  test('a wallet leg draws exactly what it takes', () => {
    const i = intentOf({ permit: PERMIT })
    expect(walletDraw(i, 40n * ONE, true)).toBe(40n * ONE)
    expect(walletDraw(i, 40n * ONE, false)).toBe(40n * ONE)
  })

  test('a funded escrow leg draws nothing, because its money is already apportioned', () => {
    // `_reserved[h]` is per intent hash, so no other intent of this maker's can spend it.
    expect(walletDraw(intentOf({ escrow: true }), 40n * ONE, false)).toBe(0n)
  })

  test('an escrow leg being armed draws the whole amountIn, not the take', () => {
    // `_redeem` pulls `i.amountIn` whatever the leg is filling.
    const i = intentOf({ escrow: true, auth: AUTH })
    expect(walletDraw(i, 40n * ONE, true)).toBe(i.amountIn)
  })

  test('only an armed permit leg spends a nonce', () => {
    expect(spendsPermitNonce(intentOf({ permit: PERMIT }), true)).toBe(true)
    expect(spendsPermitNonce(intentOf({ permit: PERMIT }), false)).toBe(false)
    expect(spendsPermitNonce(intentOf({ escrow: true, auth: AUTH }), true)).toBe(false)
  })
})

describe('recovering the nonce a permit committed to', () => {
  const account = privateKeyToAccount(`0x${'ab'.repeat(32)}`)
  const domain: TypedDataDomain = {
    name: 'Permit',
    version: '1',
    chainId: 369,
    verifyingContract: TOKEN_A,
  }

  const sign = async (nonce: bigint, spender: Address = RELAYER): Promise<Permit2612> => ({
    value: PERMIT.value,
    deadline: PERMIT.deadline,
    signature: await account.signTypedData({
      domain,
      types: PERMIT_TYPES,
      primaryType: 'Permit',
      message: {
        owner: account.address,
        spender,
        value: PERMIT.value,
        nonce,
        deadline: PERMIT.deadline,
      },
    }),
  })

  test('the wire carries no nonce, so it is recovered by trying the ones it could be', async () => {
    const permit = await sign(5n)
    const found = await recoverPermitNonce(permit, {
      owner: account.address,
      spender: RELAYER,
      domain,
      from: 3n,
    })
    expect(found).toBe(5n)
  })

  test('a nonce already past is not recovered, because the token will never take it again', async () => {
    const permit = await sign(2n)
    const found = await recoverPermitNonce(permit, {
      owner: account.address,
      spender: RELAYER,
      domain,
      from: 3n,
    })
    expect(found).toBeNull()
  })

  test('a permit for another spender is not this maker’s allowance', async () => {
    const permit = await sign(5n, TOKEN_B)
    const found = await recoverPermitNonce(permit, {
      owner: account.address,
      spender: RELAYER,
      domain,
      from: 3n,
    })
    expect(found).toBeNull()
  })

  test('the window bounds the search rather than widening it', async () => {
    const permit = await sign(20n)
    const found = await recoverPermitNonce(permit, {
      owner: account.address,
      spender: RELAYER,
      domain,
      from: 3n,
      window: 4,
    })
    expect(found).toBeNull()
  })
})

/**
 * The fourth source, and the property a maker lost to it.
 *
 * Until `park`, an escrow intent its maker never funded could never fill: `_evaluate` answered
 * `EscrowShort` for ever and only a transaction from the maker changed that. It was the one
 * property the escrow rung had that no other rung had, and it is gone. These tests are what says
 * so on this side of the wire — `AUDIT-SCOPE` 6.11 and `FLAG_ESCROW`'s own NatSpec are the rest.
 */
describe('arming a leg out of the maker’s parked capital', () => {
  const POT = 50n * ONE

  test('an escrow signature its maker never funded is armable once the row has money in it', () => {
    // The disclosure, as a test. This intent carries no authorization, its maker sent no
    // transaction for it, and before #120 that made it inert. A row somebody else's `park` call
    // filled is now enough.
    const i = intentOf({ escrow: true })
    expect(reachabilityOf('EscrowShort', i)).toBe('unreachable')
    expect(reachabilityOf('EscrowShort', i, undefined, POT)).toBe('armable')
    expect(armingKind(i, POT)).toBe('parked')
  })

  test('an empty row and an unread row are both still out of reach', () => {
    // Zero is a fact and `undefined` is the absence of one, and neither arms anything. They
    // differ only in what a caller should do next: read again, or stop asking.
    const i = intentOf({ escrow: true })
    expect(reachabilityOf('EscrowShort', i, undefined, 0n)).toBe('unreachable')
    expect(reachabilityOf('EscrowShort', i, undefined, undefined)).toBe('unreachable')
    expect(armingKind(i, 0n)).toBe('none')
  })

  test('an offer welded to a sibling is never funded this way, however full the row', () => {
    // `_drawFromParked` refuses an intent whose `authNonce` is set, and the invariant campaign is
    // what found that it had to. Two offers naming one nonce are mutually exclusive because the
    // token spends that nonce once; this source spends no nonce, so it would fund both.
    const welded = intentOf({ escrow: true, authNonce: `0x${'00'.repeat(31)}07` as Hex })
    expect(armingKind(welded, POT)).toBe('none')
    expect(reachabilityOf('EscrowShort', welded, undefined, POT)).toBe('unreachable')
    expect(encodeArming(welded, 369, POT)).toBeNull()
  })

  test('the bytes are one word, and the word is the settlement’s own constant', () => {
    // `_redeemInto` tells the two escrow shapes apart by length before it decodes either, and a
    // word that is the wrong word is `BadTerms`. 32 bytes is 66 characters with the `0x`.
    const bytes = encodeArming(intentOf({ escrow: true }), 369, POT)
    expect(bytes).toBe(PARKED_ARMING)
    expect(bytes).toHaveLength(66)
    expect(bytes).toBe(ARM_FROM_PARKED)
  })

  test('the constant is derived from its preimage, not copied from the contract', () => {
    // A client carrying its own copy of the hash is a client that can carry a stale one, which is
    // the argument `ARM_FROM_PARKED`'s NatSpec makes for being public in the first place.
    expect(ARM_FROM_PARKED).toBe(keccak256(stringToHex('prove.settlement.armFromParked')))
  })

  test('an authorization the maker attached wins over their parked capital', () => {
    // Additive, not better. An intent carrying a 3009 signature has always answered
    // `authorization` here, and a row of parked capital must not quietly redirect a leg that was
    // already funded another way.
    const i = intentOf({ escrow: true, auth: AUTH })
    expect(armingKind(i, POT)).toBe('authorization')
    expect(encodeArming(i, 369, POT)).not.toBe(PARKED_ARMING)
  })

  test('a permit2 leg and a wallet leg never reach the parked source', () => {
    // `_redeemInto` is the escrow arm alone. A permit2 maker signed once and sent nothing, so a
    // fresh Permit2 signature already arms them; a wallet leg is reached by an allowance.
    expect(armingKind(intentOf({ permit2: PERMIT2 }), POT)).toBe('permit2')
    expect(armingKind(intentOf({ permit: PERMIT }), POT)).toBe('permit')
    expect(armingKind(intentOf({}), POT)).toBe('none')
  })

  test('a leg armed from parked capital draws nothing out of the wallet', () => {
    // The line that decides whether these fills ever get planned. A redemption pulls `amountIn`
    // out of the maker's wallet; this moves money already inside the settlement and calls no
    // token at all — and the maker most likely to be armed this way is the one whose stock is
    // all in the contract and whose wallet holds nothing.
    const i = intentOf({ escrow: true })
    expect(walletDraw(i, 30n * ONE, true, true)).toBe(0n)
    // Same intent, armed by a redemption instead: the whole amount, unchanged.
    expect(walletDraw(i, 30n * ONE, true, false)).toBe(i.amountIn)
  })

  test('a parked leg answers to the intent’s own clock and no second window', () => {
    // There is no signature, so there is nothing to intersect. `armingWindow` must not narrow it.
    const i = intentOf({ escrow: true })
    // The row has to be passed, or `armingKind` answers `none` and the branch under test is
    // never reached — which is how this test first passed against a mutant that broke it.
    expect(armingKind(i, POT)).toBe('parked')
    // `until` is the last second the chain accepts, and `endTime` itself is `Expired`.
    expect(armingWindow(i, POT)).toEqual({ from: i.startTime, until: i.endTime - 1n })
    expect(armableAt(i, i.endTime - 1n, POT)).toBe(true)
    expect(armableAt(i, i.endTime, POT)).toBe(false)
  })
})

describe('reading the parked rows', () => {
  const SETTLEMENT = '0x00000000000000000000000000000000000000b2' as Address
  const MAKER_A = '0x00000000000000000000000000000000000000a1' as Address
  const MAKER_B = '0x00000000000000000000000000000000000000b1' as Address

  type Read = { address: string; functionName: string; args: readonly unknown[] }

  /** A chain with no Multicall3, so every `parked` read arrives on its own and can be counted. */
  function chain(rows: Record<string, bigint>, fail = false) {
    const reads: Read[] = []
    return {
      reads,
      client: {
        getCode: vi.fn(async () => '0x'),
        readContract: vi.fn(async (c: Read) => {
          reads.push({ address: c.address, functionName: c.functionName, args: c.args })
          if (c.functionName !== 'parked') throw new Error(`unexpected: ${c.functionName}`)
          if (fail) throw new Error('fetch failed')
          return rows[`${String(c.args[0]).toLowerCase()}:${String(c.args[1]).toLowerCase()}`] ?? 0n
        }),
      },
    }
  }

  const ask = (intents: readonly SignedIntent[], c: ReturnType<typeof chain>) =>
    readParked(intents, {
      settlementAddress: SETTLEMENT,
      chainId: 369,
      client: c.client as never,
    })

  const escrowOf = (maker: Address) => intentOf({ escrow: true, maker })

  beforeEach(() => {
    forgetMulticallProbes()
  })

  test('two offers of one maker in one token cost one read, not two', async () => {
    // `_parked` is keyed by maker and token, so every escrow offer a maker has open in one asset
    // answers from a single slot. A read per leg turns a board poll into a rate limit — and a
    // maker who parked one dead offer and signed six new ones is exactly the case this exists
    // for.
    const c = chain({ [`${MAKER_A.toLowerCase()}:${TOKEN_A.toLowerCase()}`]: 50n * ONE })
    const rows = await ask([escrowOf(MAKER_A), escrowOf(MAKER_A)], c)
    expect(c.reads).toHaveLength(1)
    expect(c.reads[0].address).toBe(SETTLEMENT)
    expect(c.reads[0].args).toEqual([MAKER_A, TOKEN_A])
    expect([...rows.values()]).toEqual([50n * ONE, 50n * ONE])
  })

  test('a different maker is a different row', async () => {
    // Folding two makers into one read would hand B the answer about A, and `_drawFromParked`
    // reads `_parked[i.maker][i.tokenIn]` and can read nothing else.
    const c = chain({})
    await ask([escrowOf(MAKER_A), escrowOf(MAKER_B)], c)
    expect(c.reads.map((r) => r.args)).toEqual([
      [MAKER_A, TOKEN_A],
      [MAKER_B, TOKEN_A],
    ])
  })

  test('a rung the parked source cannot fund is never asked about', async () => {
    // A permit2 leg reaches `_pullPermit2In`, a wallet leg is reached by an allowance, a leg that
    // already carries an authorization prefers it, and a welded intent is `BadTerms` on chain
    // however full the row is. None of them can spend a read here.
    const c = chain({})
    const rows = await ask(
      [
        intentOf({ permit2: PERMIT2, maker: MAKER_A }),
        intentOf({ permit: PERMIT, maker: MAKER_A }),
        intentOf({ escrow: true, auth: AUTH, maker: MAKER_A }),
        intentOf({ escrow: true, maker: MAKER_A, authNonce: `0x${'00'.repeat(31)}07` as Hex }),
        intentOf({ maker: MAKER_A }),
      ],
      c,
    )
    expect(c.reads).toHaveLength(0)
    expect(rows.size).toBe(0)
  })

  test('a row that never came back leaves the leg unknown rather than empty', async () => {
    // The safe direction here is the opposite of the bitmap's. A guessed row sends the word into
    // a fill that cannot draw, and the leg reads `EscrowShort` again at the far end having spent
    // the batch's gas. So a dropped request means "ask again", not "there is nothing there".
    const c = chain({}, true)
    const rows = await ask([escrowOf(MAKER_A)], c)
    expect(c.reads).toHaveLength(1)
    expect(rows.size).toBe(0)
  })

  test('an empty row comes back as zero, which is a fact and not an absence', async () => {
    const c = chain({})
    const i = escrowOf(MAKER_A)
    const rows = await ask([i], c)
    expect(rows.get(intentKey(i))).toBe(0n)
  })

  test('the answer is keyed the way the book keys its entries', async () => {
    const i = escrowOf(MAKER_A)
    const c = chain({ [`${MAKER_A.toLowerCase()}:${TOKEN_A.toLowerCase()}`]: 7n })
    const rows = await ask([i], c)
    expect(rows.get(intentKey(i))).toBe(7n)
  })
})

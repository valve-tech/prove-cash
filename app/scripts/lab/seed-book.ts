/**
 * Put offers in front of the solver on a chain that has no board.
 *
 *   RPC=… PROVE_SETTLEMENT=… npx tsx scripts/lab/seed-book.ts /tmp/lab-book.json
 *   …  same, but four independent offers:  … /tmp/lab-book.json --independent 4
 *   npx tsx scripts/solver.ts --chain 943 --seed /tmp/lab-book.json
 *
 * The order book is the store, and msgboard is only what fills it. The lab has a whole
 * deployment and no board, so until now there was no way to put an offer in front of the bot at
 * all — every lab script drove the settlement directly and the bot's own loop, which is where
 * ranking and packing and refusing live, was never run against anything.
 *
 * That is how `--batch` reached the tree with nothing tested but its startup guards. This writes
 * the file `--seed` reads: a list of `{ data, hash }`, which is the shape the board serves, so the
 * offers take the identical decode, verify and ingest path a posted one does.
 *
 * The offers are a two-leg cycle that pays for itself — maker A sells token A for token B, maker
 * B sells token B for token A, each at a rate that leaves the solver a spread. The solver should
 * find it as a ring, and `packBatch` should REFUSE it as a ring, which is the half of the
 * partition that needs no pool to demonstrate. A packable plan needs a swap of its own, and a
 * swap needs a pool the solver can price against, which the lab does not have yet.
 */
import { writeFileSync } from 'node:fs'
import { parseEther } from 'viem'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  ZERO,
  ZERO_HASH,
  signingDomain,
  encodeIntent,
  intentHashOf,
  type Intent,
  type SignedIntent,
  signIntent,
} from '@prove.cash/sdk'
import {
  CHAIN,
  FEE_RATE,
  FEE_CONFIG,
  RELAYER,
  derive,
  log,
  pub,
  send,
  token,
  topUpGas,
  topUpToken,
  units,
  walletFor,
} from '../e2e/common.js'
import type { Hex } from 'viem'

const A = token('tPLSX')
const B = token('tUSDC')
const AMOUNT_A = units(A, '10')
const AMOUNT_B = units(B, '2')

const approveData = (spender: `0x${string}`) =>
  `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${'f'.repeat(64)}` as Hex

const makerA = derive('prove.cash/lab/book-maker-a')
const makerB = derive('prove.cash/lab/book-maker-b')

/**
 * One offer, signed and funded.
 *
 * `minOut` is what the maker will accept for the whole `amountIn`, flat — no decay, because a
 * seeded book is read at an unknown time and a curve would make the test's outcome depend on how
 * long the solver took to start.
 */
async function offer(
  who: typeof makerA,
  tokenIn: { address: `0x${string}` },
  tokenOut: { address: `0x${string}` },
  amountIn: bigint,
  minOut: bigint,
): Promise<SignedIntent> {
  const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
  const intent: Intent = {
    maker: who.address,
    recipient: who.address,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn,
    minOutStart: minOut,
    minOutEnd: minOut,
    // A straight line across the whole window: kind 0, and the word it reads none of.
    curve: CURVE_LINEAR,
    startTime: now - 30n,
    endTime: now - 30n + 3600n,
    executor: ZERO,
    feeConfig: FEE_CONFIG,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    feeRate: FEE_RATE,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: FLAG_PARTIAL,
    nonce: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e6)),
  }
  const signature = await signIntent(who, intent, { domain: signingDomain(CHAIN) })
  return { ...intent, signature }
}

for (const [who, t, amount] of [
  [makerA, A, AMOUNT_A],
  [makerB, B, AMOUNT_B],
] as const) {
  await topUpGas(who.address, parseEther('0.5'), 'maker')
  await topUpToken(t, who.address, amount * 4n, 'maker')
  await send(walletFor(who), { to: t.address, data: approveData(RELAYER) }, 'maker approved')
}

/*
 * Two shapes, because the bot treats them differently and both need proving.
 *
 * By default a cycle that pays: maker A wants 1.8 token B for 10 token A, maker B wants 9 token A
 * for 2 token B. Round the loop and the solver is ahead on both legs. `packBatch` must REFUSE
 * that — a ring settles atomically and cannot share a tolerant batch.
 *
 * With `--independent N`, N offers in the same direction from N makers. Each closes through the
 * pool rather than through another maker, so each is a plan of one fill carrying its own swap,
 * which is exactly what `packBatch` accepts. Nothing could produce that shape until the lab had
 * a market to close through, which is why the packing half of `--batch` went untested.
 */
const independent = process.argv.includes('--independent')
  ? Number(process.argv[process.argv.indexOf('--independent') + 1] ?? 4)
  : 0

const legs: SignedIntent[] = []
if (independent > 0) {
  for (let k = 0; k < independent; k++) {
    const who = derive(`prove.cash/lab/book-solo-${k}`)
    await topUpGas(who.address, parseEther('0.5'), 'maker')
    await topUpToken(A, who.address, AMOUNT_A * 4n, 'maker')
    await send(walletFor(who), { to: A.address, data: approveData(RELAYER) }, 'maker approved')
    // Well under what the pool pays for the same amount, so the solver clears it there and keeps
    // the difference. The triangle quotes about one tUSDC for ten tPLSX, so asking half of that
    // leaves a spread the ring condition can actually clear — asking the pool's own price leaves
    // none, and the search reports no rings at all rather than an unprofitable one.
    legs.push(await offer(who, A, B, AMOUNT_A, AMOUNT_B / 4n))
  }
} else {
  legs.push(await offer(makerA, A, B, AMOUNT_A, (AMOUNT_B * 9n) / 10n))
  legs.push(await offer(makerB, B, A, AMOUNT_B, (AMOUNT_A * 9n) / 10n))
}

// `hash` is the board's message id and the store keeps it as `msgHash`. Nothing on this chain
// issued one, so the intent's own hash stands in: unique per offer, and stable if this is run
// twice over the same offers.
// Written, not printed. The funding helpers above log to stdout, so a redirect hands the solver
// a file with transaction receipts in front of the JSON — which is what the first run did.
const out = process.argv[2]
if (!out) throw new Error('name a file to write: npx tsx scripts/lab/seed-book.ts /tmp/book.json')
writeFileSync(
  out,
  `${JSON.stringify(
    legs.map((i) => ({ data: encodeIntent(i), hash: intentHashOf(i, CHAIN) })),
    null,
    2,
  )}\n`,
)
log(`wrote ${legs.length} offers to ${out}`)

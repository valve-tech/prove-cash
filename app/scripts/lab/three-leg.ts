/**
 * A three-leg ring that closes on wants alone — no pool, no liquidity, no inventory.
 *
 *   RPC=http://127.0.0.1:8547 PROVE_SETTLEMENT=… npx tsx scripts/lab/three-leg.ts
 *
 * A coincidence of wants does not have to be a pair. Three makers who each want what the next one
 * is selling close a cycle between them, and nobody has to provide capital or a market: the
 * settlement releases all three legs before it collects anything, so the ring funds itself.
 *
 * This is the case worth having in a lab rather than on a live board, because it will not happen
 * by accident. The heartbeat signs one pair, so the live solver only ever sees two-leg rings.
 * Three tokens and three makers is a shape the search has to actually find.
 *
 * The run also proves the negative that makes the positive worth anything: break one leg's price
 * so the cycle no longer closes, and the solver must decline to plan it at all.
 */
import { parseAbi, parseEther } from 'viem'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  ZERO,
  ZERO_HASH,
  signingDomain,
  type Intent,
  type SignedIntent,
  signIntent,
} from '@prove.cash/sdk'
import {
  buildBook,
  simulateCreditRing,
  solve,
  type BookEntry,
} from '@prove.cash/sdk/solver'
import {
  BATCH_EXECUTOR,
  CHAIN,
  FEE_RATE,
  FEE_CONFIG,
  RELAYER,
  SETTLEMENT,
  derive,
  failureCount,
  head,
  log,
  must,
  pub,
  send,
  token,
  topUpGas,
  topUpToken,
  units,
  walletFor,
  UNPRICED_OK,
} from '../e2e/common.js'


const A = token('tPLSX')
const B = token('tUSDC')
const C = token('tWETH')

const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
const approve = (spender: `0x${string}`) => ({
  abi: ERC20,
  data: `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${'f'.repeat(64)}` as const,
})

type Maker = ReturnType<typeof derive>

async function offer(
  maker: Maker,
  tokenIn: { address: `0x${string}` },
  tokenOut: { address: `0x${string}` },
  amountIn: bigint,
  minOut: bigint,
): Promise<SignedIntent> {
  const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
  const intent: Intent = {
    maker: maker.address,
    recipient: maker.address,
    tokenIn: tokenIn.address,
    tokenOut: tokenOut.address,
    amountIn,
    // Flat, not decaying. A three-leg cycle is hard enough to find without a moving price, and
    // the decay case is covered on its own in decay-ring.ts.
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
    nonce: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 100000)),
  }
  const signature = await signIntent(maker, intent, { domain: signingDomain(CHAIN) })
  return { ...intent, signature }
}

const alice = derive('prove.cash/lab/tri-alice')
const bob = derive('prove.cash/lab/tri-bob')
const carol = derive('prove.cash/lab/tri-carol')

head('three makers, three tokens, one cycle')
for (const [who, name] of [
  [alice, 'alice'],
  [bob, 'bob'],
  [carol, 'carol'],
] as const) {
  await topUpGas(who.address, parseEther('1'), name)
}

const A_IN = units(A, '100') // alice sells tPLSX
const B_IN = units(B, '3') // bob sells tUSDC
const C_IN = units(C, '0.001') // carol sells tWETH

await topUpToken(A, alice.address, A_IN, 'alice')
await topUpToken(B, bob.address, B_IN, 'bob')
await topUpToken(C, carol.address, C_IN, 'carol')

for (const [who, t] of [
  [alice, A],
  [bob, B],
  [carol, C],
] as const) {
  await send(walletFor(who), { to: t.address, data: approve(RELAYER).data }, `${t.symbol} approved`)
}

// Each maker asks for a little less than the next leg hands over, so the cycle closes with a
// surplus in every token rather than balancing exactly. That surplus is the solver's whole
// reason to send it.
const legs = [
  await offer(alice, A, B, A_IN, units(B, '2.9')), // 100 tPLSX  → wants ≥ 2.9 tUSDC
  await offer(bob, B, C, B_IN, units(C, '0.00095')), // 3 tUSDC    → wants ≥ 0.00095 tWETH
  await offer(carol, C, A, C_IN, units(A, '97')), // 0.001 tWETH → wants ≥ 97 tPLSX
]
log('alice 100 tPLSX → ≥ 2.9 tUSDC')
log('bob     3 tUSDC → ≥ 0.00095 tWETH')
log('carol 0.001 tWETH → ≥ 97 tPLSX')

const entries = (list: readonly SignedIntent[]): BookEntry[] =>
  list.map((i, k) => ({
    key: `tri-${k}`,
    intent: i,
    remaining: i.amountIn,
    partial: (i.flags & FLAG_PARTIAL) !== 0,
  }))

async function plans(list: readonly SignedIntent[], maxLegs: 2 | 3) {
  const at = (await pub.getBlock({ blockTag: 'latest' })).timestamp
  return solve(buildBook(entries(list), CHAIN), {
    at,
    executor: BATCH_EXECUTOR,
    gasPrice: 1_000_000_007n,
    minNetNative: 0n,
    unpricedOk: UNPRICED_OK,
    maxLegs,
  })
}

head('the search')
const twoOnly = await plans(legs, 2)
must(twoOnly.length === 0, 'no two-leg ring exists here — none of these three pair off')

const found = await plans(legs, 3)
must(found.length > 0, 'and the solver finds the three-leg cycle when it is allowed to look')

if (found.length > 0) {
  const plan = found[0]
  log(`ring of ${plan.sized.legs.length} legs, profit ${plan.profit} of ${plan.profitToken.slice(0, 8)}`)
  must(plan.sized.legs.length === 3, 'the plan really has three legs')
  must(plan.swap === null, 'and closes on wants alone, with no pool leg')

  const at = (await pub.getBlock({ blockTag: 'latest' })).timestamp
  const sim = await simulateCreditRing(
    plan,
    {
      account: BATCH_EXECUTOR,
      client: pub as never,
      chainId: CHAIN,
      settlementAddress: SETTLEMENT,
      batchExecutor: BATCH_EXECUTOR,
    },
    at + 300n,
  )
  must(sim.ok, `the chain settles it${sim.ok ? `, ${sim.gas} gas` : `: ${sim.reason}`}`)
}

head('and a cycle that does not close is refused')
// Carol now wants more tPLSX than alice is selling, so the cycle cannot pay for itself.
const greedy = [
  legs[0],
  legs[1],
  await offer(carol, C, A, C_IN, units(A, '150')),
]
const none = await plans(greedy, 3)
must(none.length === 0, 'the solver plans nothing when the cycle cannot close')

console.log(
  failureCount() === 0
    ? '\na three-leg coincidence of wants, settled with no capital and no market.\n'
    : `\n${failureCount()} failure(s)\n`,
)
process.exit(failureCount() === 0 ? 0 : 1)

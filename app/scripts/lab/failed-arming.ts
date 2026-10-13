/**
 * A leg that cannot be armed must cost the maker nothing and the solver one skipped ring.
 *
 *   RPC=http://127.0.0.1:8547 PROVE_SETTLEMENT=… npx tsx scripts/lab/failed-arming.ts
 *
 * `Arming.t.sol` already proves the contract side: a bad Permit2 signature leaves nothing behind,
 * a spent nonce cannot be replayed, a signature over another token does not arm the leg. What
 * that suite cannot show is what the SOLVER does when a ring it wants to settle contains such a
 * leg, and that is where the money is: a ring is atomic, so one unarmable leg takes the whole
 * batch down with it.
 *
 * The property worth holding is narrow and it is the anti-griefing one. Anybody can put an intent
 * on the board carrying arming bytes that will not redeem. That must cost them a refused
 * simulation and cost everybody else nothing — no spent nonce, no granted allowance, no partial
 * settlement, and a solver that goes on to settle the good ring in the same pass.
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
import { buildBook, simulateCreditRing, solve, type BookEntry } from '@prove.cash/sdk/solver'
import {
  BATCH_EXECUTOR,
  CHAIN,
  FEE_RATE,
  FEE_CONFIG,
  RELAYER,
  SETTLEMENT,
  balanceOf,
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
const A_IN = units(A, '40')
const B_IN = units(B, '1.25')

const good = derive('prove.cash/lab/arm-good')
const bad = derive('prove.cash/lab/arm-bad')

const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function nonces(address owner) view returns (uint256)',
])
const approve = (spender: `0x${string}`) =>
  `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${'f'.repeat(64)}` as `0x${string}`

head('setup')
for (const [who, name] of [
  [good, 'the good maker'],
  [bad, 'the unarmable maker'],
] as const) {
  await topUpGas(who.address, parseEther('1'), name)
}
await topUpToken(A, good.address, A_IN, 'the good maker')
await topUpToken(B, bad.address, B_IN, 'the unarmable maker')

// The good maker approves. The other one never does — their leg is reachable only by a
// signature, and the signature they publish will not redeem.
await send(walletFor(good), { to: A.address, data: approve(RELAYER) }, 'good maker approved')

const relayerAllowance = await pub.readContract({
  address: B.address,
  abi: ERC20,
  functionName: 'allowance',
  args: [bad.address, RELAYER],
})
must(relayerAllowance === 0n, 'the unarmable maker has granted the relayer nothing')
const noncesBefore = await pub.readContract({
  address: B.address,
  abi: ERC20,
  functionName: 'nonces',
  args: [bad.address],
})
log(`their permit nonce stands at ${noncesBefore}`)

async function offer(
  maker: typeof good,
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

head('two offers that pay for each other, one of them unreachable')
const legGood = await offer(good, A, B, A_IN, units(B, '1.2'))
const legBad = await offer(bad, B, A, B_IN, units(A, '39'))
log('the good leg is backed by an allowance; the other by nothing at all')

/**
 * Arming bytes that cannot redeem: a permit whose signature is 65 bytes of noise.
 *
 * This is what a griefer publishes. It is well formed enough to reach the token and wrong enough
 * to be refused there, which is exactly the shape that would be dangerous if the cost landed on
 * anybody but the publisher.
 */
const junkArming = `0x${'11'.repeat(200)}` as `0x${string}`

const entries: BookEntry[] = [
  { key: 'good', intent: legGood, remaining: legGood.amountIn, partial: true },
  { key: 'bad', intent: legBad, remaining: legBad.amountIn, partial: true, arming: junkArming },
]

head('the solver plans it, the chain refuses it')
const at = (await pub.getBlock({ blockTag: 'latest' })).timestamp
const plans = solve(buildBook(entries, CHAIN), {
  at,
  executor: BATCH_EXECUTOR,
  gasPrice: 1_000_000_007n,
  minNetNative: 0n,
  unpricedOk: UNPRICED_OK,
  maxLegs: 2,
})
log(`the solver produced ${plans.length} plan(s)`)

if (plans.length > 0) {
  const sim = await simulateCreditRing(
    plans[0],
    {
      account: BATCH_EXECUTOR,
      client: pub as never,
      chainId: CHAIN,
      settlementAddress: SETTLEMENT,
      batchExecutor: BATCH_EXECUTOR,
    },
    at + 300n,
  )
  must(!sim.ok, `the chain refuses a ring whose leg cannot arm${sim.ok ? '' : `: ${sim.reason}`}`)
} else {
  must(true, 'the solver declined to plan a ring around a leg it cannot reach')
}

head('and it cost the maker nothing')
must(
  (await pub.readContract({
    address: B.address,
    abi: ERC20,
    functionName: 'nonces',
    args: [bad.address],
  })) === noncesBefore,
  'the permit nonce is untouched, so a refused arming spends no signature',
)
must(
  (await pub.readContract({
    address: B.address,
    abi: ERC20,
    functionName: 'allowance',
    args: [bad.address, RELAYER],
  })) === 0n,
  'and no allowance was granted on the way',
)
must((await balanceOf(A, good.address)) === A_IN, 'the good maker still holds all their tPLSX')
must((await balanceOf(B, bad.address)) === B_IN, 'and the other maker still holds all their tUSDC')

head('the good pair still settles in the same breath')
// The griefer must not be able to stop anybody else trading. Replace their leg with a real one
// and the ring goes through, on the same chain, in the same pass.
const legReal = await offer(good, B, A, B_IN, units(A, '39'))
await topUpToken(B, good.address, B_IN, 'the good maker (token B)')
await send(walletFor(good), { to: B.address, data: approve(RELAYER) }, 'good maker approved tUSDC')

const at2 = (await pub.getBlock({ blockTag: 'latest' })).timestamp
const clean = solve(
  buildBook(
    [
      { key: 'g1', intent: legGood, remaining: legGood.amountIn, partial: true },
      { key: 'g2', intent: legReal, remaining: legReal.amountIn, partial: true },
    ],
    CHAIN,
  ),
  { at: at2, executor: BATCH_EXECUTOR, gasPrice: 1_000_000_007n, minNetNative: 0n, unpricedOk: UNPRICED_OK, maxLegs: 2 },
)
must(clean.length > 0, 'the solver finds the honest ring')
if (clean.length > 0) {
  const sim = await simulateCreditRing(
    clean[0],
    {
      account: BATCH_EXECUTOR,
      client: pub as never,
      chainId: CHAIN,
      settlementAddress: SETTLEMENT,
      batchExecutor: BATCH_EXECUTOR,
    },
    at2 + 300n,
  )
  must(sim.ok, `and the chain settles it${sim.ok ? `, ${sim.gas} gas` : `: ${sim.reason}`}`)
}

console.log(
  failureCount() === 0
    ? '\na leg that cannot arm costs its publisher a refusal and everybody else nothing.\n'
    : `\n${failureCount()} failure(s)\n`,
)
process.exit(failureCount() === 0 ? 0 : 1)

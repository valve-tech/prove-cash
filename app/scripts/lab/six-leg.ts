/**
 * A six-leg coincidence of wants: six makers, six tokens, one cycle, no market at all.
 *
 *   RPC=http://127.0.0.1:8547 PROVE_SETTLEMENT=… npx tsx scripts/lab/six-leg.ts
 *
 * Two makers who want opposite things is a trade. Six makers who each want what the next one is
 * selling is a trade too, and none of them could have found it alone — no two of them pair off,
 * so every shorter search returns nothing. This is the case for looking past three legs.
 *
 * It costs what it sounds like: the ring is bounded by its thinnest leg, every extra leg is
 * roughly 130k more gas, and every extra maker is one more signature that can invalidate the
 * whole batch. `MAX_RING_LEGS` is six for those reasons and the default stays at three.
 *
 * The run walks the limit up one leg at a time, so the output shows exactly where the cycle
 * becomes findable rather than just asserting that it eventually is.
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
  MAX_RING_LEGS,
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


/**
 * Six tokens the lab deploys, and how much of each its maker sells. The amounts are only
 * plausible relative sizes — the cycle closes because each maker asks a few per cent less than
 * the next leg hands over, not because these are real prices.
 */
const RING = [
  { t: token('tPLSX'), sells: '100', wants: '2.9' },
  { t: token('tUSDC'), sells: '3', wants: '0.00095' },
  { t: token('tWETH'), sells: '0.001', wants: '0.19' },
  { t: token('tHEX'), sells: '0.2', wants: '2.85' },
  { t: token('tUSDT'), sells: '3', wants: '0.000019' },
  { t: token('tWBTC'), sells: '0.00002', wants: '97' },
] as const

const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
const approveData = (spender: `0x${string}`) =>
  `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${'f'.repeat(64)}` as `0x${string}`

const makers = RING.map((_, k) => derive(`prove.cash/lab/six-${k}`))

head(`${RING.length} makers, ${RING.length} tokens, one cycle`)
for (let k = 0; k < RING.length; k++) {
  await topUpGas(makers[k].address, parseEther('1'), `maker ${k}`)
  await topUpToken(RING[k].t, makers[k].address, units(RING[k].t, RING[k].sells), `maker ${k}`)
  await send(
    walletFor(makers[k]),
    { to: RING[k].t.address, data: approveData(RELAYER) },
    `${RING[k].t.symbol} approved`,
  )
}

async function offer(k: number): Promise<SignedIntent> {
  const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
  const sell = RING[k]
  const buy = RING[(k + 1) % RING.length]
  const intent: Intent = {
    maker: makers[k].address,
    recipient: makers[k].address,
    tokenIn: sell.t.address,
    tokenOut: buy.t.address,
    amountIn: units(sell.t, sell.sells),
    minOutStart: units(buy.t, sell.wants),
    minOutEnd: units(buy.t, sell.wants),
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
    nonce: BigInt(Date.now()) + BigInt(k) + BigInt(Math.floor(Math.random() * 100000)),
  }
  const signature = await signIntent(makers[k], intent, { domain: signingDomain(CHAIN) })
  return { ...intent, signature }
}

const legs: SignedIntent[] = []
for (let k = 0; k < RING.length; k++) legs.push(await offer(k))
for (let k = 0; k < RING.length; k++) {
  const buy = RING[(k + 1) % RING.length]
  log(`maker ${k}: ${RING[k].sells} ${RING[k].t.symbol} → ≥ ${RING[k].wants} ${buy.t.symbol}`)
}

const entries: BookEntry[] = legs.map((i, k) => ({
  key: `six-${k}`,
  intent: i,
  remaining: i.amountIn,
  partial: true,
}))

head('how deep the search has to look')
const at = (await pub.getBlock({ blockTag: 'latest' })).timestamp
const book = buildBook(entries, CHAIN)
const found = (maxLegs: number) =>
  solve(book, {
    at,
    executor: BATCH_EXECUTOR,
    gasPrice: 1_000_000_007n,
    minNetNative: 0n,
    unpricedOk: UNPRICED_OK,
    maxLegs,
  })

for (let limit = 2; limit < RING.length; limit++) {
  must(found(limit).length === 0, `at ${limit} legs the solver finds nothing, and should not`)
}
const plans = found(RING.length)
must(plans.length > 0, `at ${RING.length} legs it finds the cycle`)
must(MAX_RING_LEGS >= RING.length, `and ${RING.length} is within MAX_RING_LEGS (${MAX_RING_LEGS})`)

head('the chain settles it')
if (plans.length > 0) {
  const plan = plans[0]
  must(plan.sized.legs.length === RING.length, `the plan really has ${RING.length} legs`)
  must(plan.swap === null, 'and closes on wants alone, with no pool leg')
  log(`profit ${plan.profit} of ${plan.profitToken.slice(0, 8)}`)

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
  must(sim.ok, `six legs settle in one batch${sim.ok ? `, ${sim.gas} gas` : `: ${sim.reason}`}`)
  if (sim.ok) log(`${Number(sim.gas) / RING.length | 0} gas a leg`)
}

console.log(
  failureCount() === 0
    ? '\nsix strangers, one cycle, no market. Nobody could have found it alone.\n'
    : `\n${failureCount()} failure(s)\n`,
)
process.exit(failureCount() === 0 ? 0 : 1)

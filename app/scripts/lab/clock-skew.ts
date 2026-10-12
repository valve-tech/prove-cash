/**
 * The clock a plan is priced at decides whether its ring closes.
 *
 *   RPC=http://127.0.0.1:8547 PROVE_SETTLEMENT=… npx tsx scripts/lab/clock-skew.ts
 *
 * A ring is sized so every leg pays for the next with nothing to spare. That makes it exactly as
 * accurate as the price it was sized at, and a decaying offer has a different price every second.
 *
 * The settlement charges `block.timestamp`. The solver used `Date.now()`, which on the bot host
 * runs 0 to 8 seconds ahead of the latest block. Those few seconds make every leg look cheaper
 * than the chain will charge, so the cycle closes on paper and comes up short in the batch
 * executor — which is what `ERC20InsufficientBalance` naming that contract has been saying since
 * the solver started.
 *
 * Two runs, one difference: the timestamp the plan is priced at. The chain settles the first and
 * refuses the second.
 */
import { formatUnits, parseAbi, parseEther } from 'viem'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  ZERO,
  ZERO_HASH,
  signingDomain,
  grossOut,
  type Intent,
  type SignedIntent,
  signIntent,
} from '@prove.cash/sdk'
import {
  buildBook,
  simulateCreditRing,
  solve,
  type BookEntry,
  type RingFill,
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
  show,
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

const one = derive('prove.cash/lab/decay-one')
const two = derive('prove.cash/lab/decay-two')
const solver = derive('prove.cash/lab/decay-solver')

const ERC20 = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

head('setup')
for (const [who, name] of [
  [one, 'maker one'],
  [two, 'maker two'],
  [solver, 'solver'],
] as const) {
  await topUpGas(who.address, parseEther('1'), name)
}
await topUpToken(A, one.address, A_IN, 'maker one')
await topUpToken(B, two.address, B_IN, 'maker two')
for (const [who, t] of [
  [one, A],
  [two, B],
] as const) {
  await send(
    walletFor(who),
    {
      to: t.address,
      data: `0x095ea7b3${RELAYER.slice(2).padStart(64, '0')}${'f'.repeat(64)}` as `0x${string}`,
    },
    `${t.symbol} approved to the relayer`,
  )
}

/**
 * A decaying offer. `minOutStart` is above `minOutEnd`, so the maker asks for less as the window
 * runs — the default the app signs, and what every intent on the live board carries.
 */
async function offer(
  maker: typeof one,
  tokenIn: { address: `0x${string}`; decimals: number },
  tokenOut: { address: `0x${string}`; decimals: number },
  amountIn: bigint,
  start: bigint,
  end: bigint,
  now: bigint,
): Promise<SignedIntent> {
  const intent: Intent = {
    maker: maker.address,
    recipient: maker.address,
    tokenIn: tokenIn.address as `0x${string}`,
    tokenOut: tokenOut.address as `0x${string}`,
    amountIn,
    minOutStart: start,
    minOutEnd: end,
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
    nonce: BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1000)),
  }
  const signature = await signIntent(maker, intent, { domain: signingDomain(CHAIN) })
  return { ...intent, signature }
}

const chainNow = async () => (await pub.getBlock({ blockTag: 'latest' })).timestamp

head('two offers that pay for each other')
let now = await chainNow()
// Leg one gives 40 tPLSX and wants tUSDC; leg two gives 1.25 tUSDC and wants tPLSX back.
// Both decay downward over the hour, which is what the app signs by default.
const legOne = await offer(one, A, B, A_IN, units(B, '1.24'), units(B, '1.15'), now)
const legTwo = await offer(two, B, A, B_IN, units(A, '39.5'), units(A, '37'), now)
log(`leg one · 40 tPLSX for ${show(B, units(B, '1.24'))} decaying to ${show(B, units(B, '1.15'))}`)
log(`leg two · 1.25 tUSDC for ${show(A, units(A, '39.5'))} decaying to ${show(A, units(A, '37'))}`)

const entries = (): BookEntry[] =>
  [legOne, legTwo].map((i, k) => ({
    key: `lab-${k}`,
    intent: i,
    remaining: i.amountIn,
    partial: (i.flags & FLAG_PARTIAL) !== 0,
  }))

async function planAndSimulate(label: string, plannedAt: bigint) {
  const book = buildBook(entries(), CHAIN)
  const plans = solve(book, {
    at: plannedAt,
    executor: BATCH_EXECUTOR,
    gasPrice: 1_000_000_007n,
    minNetNative: 0n,
    unpricedOk: UNPRICED_OK,
    maxLegs: 2,
  })
  if (plans.length === 0) {
    log(`${label}: the solver found no ring at all`)
    return null
  }
  const plan = plans[0]
  const at = await chainNow()
  // What each leg costs the solver, priced at the plan's timestamp and at the chain's. The gross
  // is the right number here: it is the whole tokenOut outlay, and the split between the maker
  // and the fee destination happens inside it without changing what the solver pays.
  const ledger = new Map<string, bigint>()
  for (const l of plan.sized.legs) {
    ledger.set(l.leg.receives, (ledger.get(l.leg.receives) ?? 0n) + l.take)
    ledger.set(l.leg.pays, (ledger.get(l.leg.pays) ?? 0n) - l.pay)
  }
  const owedThen = plan.fills.map((f: RingFill) => grossOut(f.intent, f.take, plannedAt))
  const owedNow = plan.fills.map((f: RingFill) => grossOut(f.intent, f.take, at))

  const sim = await simulateCreditRing(
    plan,
    {
      account: solver.address,
      client: pub as never,
      chainId: CHAIN,
      settlementAddress: SETTLEMENT,
      batchExecutor: BATCH_EXECUTOR,
    },
    at + 300n,
  )
  log(`${label}`)
  log(`  planned at ${plannedAt}, chain is at ${at}, ${at - plannedAt}s later`)
  log(
    `  plan ledger · ${[...ledger].map(([t, v]) => `${t.slice(0, 8)} ${v >= 0n ? '+' : ''}${v}`).join(' · ')}`,
  )
  for (let k = 0; k < owedThen.length; k++) {
    const drift = owedNow[k] - owedThen[k]
    log(`  leg ${k} owed ${owedThen[k]} when planned, ${owedNow[k]} now (${drift >= 0n ? '+' : ''}${drift})`)
  }
  log(`  chain: ${sim.ok ? `settles, ${sim.gas} gas` : sim.reason}`)
  return sim
}

head('priced at the chain\'s clock — the fix')
now = await chainNow()
const onChainClock = await planAndSimulate('planned at block.timestamp', now)
must(!!onChainClock?.ok, 'a ring priced at the block the chain is on settles')

head('priced a few seconds ahead — what a local clock does')
// The bot host's clock runs 0 to 8 seconds ahead of the latest block: one block time on a
// ten-second chain. A decaying offer is cheaper in the future, so pricing there sizes the ring
// to close at prices the settlement will not honour. Eight seconds is the drift I measured.
const ahead = (await chainNow()) + 8n
const skewed = await planAndSimulate('planned 8s in the future', ahead)
must(
  !skewed?.ok,
  'and the same ring priced 8 seconds ahead is refused — which is the live bug, reproduced',
)
if (skewed && !skewed.ok) log(`  the chain says: ${skewed.reason}`)

console.log(
  failureCount() === 0
    ? '\nthe clock the plan uses decides whether the ring closes. Chain time is the safe one.\n'
    : `\n${failureCount()} failure(s)\n`,
)
process.exit(failureCount() === 0 ? 0 : 1)

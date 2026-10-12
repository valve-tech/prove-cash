/**
 * Does a credit ring stop closing while it waits? A controlled answer, on a chain I can rewind.
 *
 *   RPC=http://127.0.0.1:8547 PROVE_SETTLEMENT=… PROVE_TOKENS=… DEPLOYER_PK=… \
 *     npx tsx scripts/lab/decay-ring.ts
 *
 * Live on 943 the solver plans a ring, the plan's own books balance, and the chain then refuses
 * it with `ERC20InsufficientBalance` naming the batch executor — short by 0.19%, then 0.68%, then
 * 10.5%. Three explanations died on inspection: the fee is already in the sizing, neither test
 * token taxes a transfer, and per-leg rounding cannot reach ten per cent.
 *
 * What is left is timing. A solver plans at one timestamp and the chain executes at a later one,
 * and every intent on that board carries a Dutch curve. So this builds a ring that closes now,
 * moves the clock, and asks the chain again — changing one thing and nothing else, which is the
 * whole point of doing it here rather than watching a live board.
 *
 * The prediction worth stating before the run, so the result can contradict it: these curves
 * decay DOWNWARD, so what a maker is owed falls with time and a ring should get EASIER to close,
 * not harder. If waiting breaks the ring, that prediction is wrong and the reason matters.
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

head('planned and settled in the same breath')
now = await chainNow()
const fresh = await planAndSimulate('no delay', now)
must(!!fresh?.ok, 'a ring planned at the current block settles')

head('the same ring, after the clock moves')
// 900 seconds: ten times the solver's 90-second pass, and a quarter of the offers' window.
await pub.request({ method: 'evm_increaseTime' as never, params: [900] as never })
await pub.request({ method: 'evm_mine' as never, params: [] as never })
const stale = await planAndSimulate('planned 900s ago, settled now', now)
must(
  !!stale?.ok,
  'and the same plan still settles after the offers have decayed for 900 seconds',
)

console.log(
  failureCount() === 0
    ? '\nwaiting does not break a ring. The live shortfall is something else.\n'
    : `\n${failureCount()} failure(s) — the numbers above say which way the drift ran.\n`,
)
process.exit(failureCount() === 0 ? 0 : 1)

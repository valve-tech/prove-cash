/**
 * What a ring costs when it loses one leg to another solver.
 *
 *   RPC=http://127.0.0.1:8547 PROVE_SETTLEMENT=… npx tsx scripts/lab/atomic-revert.ts
 *
 * `batch-gas.ts` prices the tolerant path: `fillBatch` with `skipInvalid`, which steps over a leg
 * a rival already took and fills the rest for 15,982 gas. A ring cannot do that. It sends
 * `skipInvalid` false on purpose, because settling part of a cycle leaves the solver holding an
 * unhedged position, so one missing leg reverts the whole transaction.
 *
 * A reverted transaction is not free. It pays for everything it did before it stopped, and it
 * fills nothing. So the cost of losing a race on a ring is not the 15,982 a batch pays — it is
 * however far the settlement got, and that depends on WHERE in the list the missing leg sits.
 * First position and the settlement gives up immediately. Last position and it has already
 * released seven makers' tokens, paid seven recipients, and written seven storage slots, all of
 * which is undone and none of which is refunded.
 *
 * That is the number the solver needs to decide whether a ring is worth attempting into
 * contention, and it is the number that says how much an assignment between solvers is worth.
 * Nothing else in the repo measures it.
 *
 * Both paths are measured over the same legs, so the difference is the fault tolerance and
 * nothing else.
 */
import { parseEther } from 'viem'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  SETTLEMENT_ABI,
  ZERO,
  ZERO_HASH,
  callFor,
  signingDomain,
  type Intent,
  type SignedIntent,
  signIntent,
} from '@prove.cash/sdk'
import {
  CHAIN,
  FEE_RATE,
  FEE_CONFIG,
  RELAYER,
  SETTLEMENT,
  boundFor,
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
} from '../e2e/common.js'
import { encodeFunctionData, type Hex } from 'viem'

const IN = token('tPLSX')
const OUT = token('tUSDC')
const AMOUNT_IN = units(IN, '10')
const MIN_OUT = units(OUT, '0.2')
const SIZE = 8
/** A float, so a fill never zeroes a maker and the numbers stay comparable across the run. */
const RUNS = 40n

const approveData = (spender: `0x${string}`) =>
  `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${'f'.repeat(64)}` as Hex

const encodeCall = (call: { functionName: string; args: readonly unknown[] }): Hex =>
  encodeFunctionData({
    abi: SETTLEMENT_ABI as never,
    functionName: call.functionName,
    args: call.args,
  } as never)

const executor = derive('prove.cash/lab/revert-executor')
const rival = derive('prove.cash/lab/revert-rival')
const makers = Array.from({ length: SIZE }, (_, k) => derive(`prove.cash/lab/revert-maker-${k}`))

head(`${SIZE} legs, one executor, and a rival who takes one of them`)
for (const [who, name] of [
  [executor, 'executor'],
  [rival, 'rival'],
] as const) {
  await topUpGas(who.address, parseEther('5'), name)
  await topUpToken(OUT, who.address, MIN_OUT * RUNS, name)
  await send(walletFor(who), { to: OUT.address, data: approveData(RELAYER) }, `${name} approved`)
}
for (let k = 0; k < SIZE; k++) {
  await topUpGas(makers[k].address, parseEther('0.5'), `maker ${k}`)
  await topUpToken(IN, makers[k].address, AMOUNT_IN * RUNS, `maker ${k}`)
  await send(walletFor(makers[k]), { to: IN.address, data: approveData(RELAYER) }, `maker ${k} ok`)
}

async function offer(k: number): Promise<SignedIntent> {
  const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
  const intent: Intent = {
    maker: makers[k].address,
    recipient: makers[k].address,
    tokenIn: IN.address,
    tokenOut: OUT.address,
    amountIn: AMOUNT_IN,
    minOutStart: MIN_OUT,
    minOutEnd: MIN_OUT,
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
    nonce: BigInt(Date.now()) + BigInt(k) + BigInt(Math.floor(Math.random() * 1e6)),
  }
  const signature = await signIntent(makers[k], intent, { domain: signingDomain(CHAIN) })
  return { ...intent, signature }
}

type Outcome = { gas: bigint; reverted: boolean }

/**
 * Send `legs` legs, after a rival has taken the one at `lost`, and say what it cost.
 *
 * `lost` of -1 means nobody took anything, which is the baseline every row is measured against.
 * The gas limit is fixed rather than estimated: a transaction that is going to revert cannot be
 * estimated, and `eth_estimateGas` would refuse the very case under test.
 */
async function attempt(legs: number, lost: number, atomic: boolean): Promise<Outcome> {
  for (let k = 0; k < legs; k++) {
    await topUpToken(IN, makers[k].address, AMOUNT_IN, `maker ${k}`)
  }
  await topUpToken(OUT, executor.address, MIN_OUT * BigInt(legs), 'executor')

  const fills: { intent: SignedIntent; take: bigint }[] = []
  for (let k = 0; k < legs; k++) fills.push({ intent: await offer(k), take: AMOUNT_IN })

  if (lost >= 0) {
    await topUpToken(OUT, rival.address, MIN_OUT * 2n, 'rival')
    const theirs = [fills[lost]]
    const race = callFor(
      {
        mode: 'batch',
        fills: theirs,
        maxFeeRate: boundFor(theirs.map((f) => f.intent)),
        skipInvalid: false,
      },
      CHAIN,
    )
    await send(
      walletFor(rival),
      { to: SETTLEMENT, data: encodeCall(race), gas: 12_000_000n },
      `a rival took leg ${lost}`,
    )
  }

  const call = callFor(
    {
      mode: 'batch',
      fills,
      maxFeeRate: boundFor(fills.map((f) => f.intent)),
      skipInvalid: !atomic,
    },
    CHAIN,
  )
  const hash = await walletFor(executor).sendTransaction({
    to: SETTLEMENT,
    data: encodeCall(call),
    gas: 12_000_000n,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  return { gas: receipt.gasUsed, reverted: receipt.status !== 'success' }
}

head('warming the slots, so the numbers below measure legs and not first touches')
const warm = await attempt(SIZE, -1, false)
log(`the first batch pays for cold storage: ${warm.gas} gas, and is not counted below`)

head(`an atomic batch of ${SIZE}, losing the leg at each position in turn`)
// This is what a ring sends: `skipInvalid` false, so any missing leg reverts everything.
const whole = await attempt(SIZE, -1, true)
log(`nobody takes anything · ${whole.gas} gas · ${whole.reverted ? 'reverted' : 'settled'}`)
must(!whole.reverted, 'an atomic batch with every leg present settles')

const atomic: bigint[] = []
for (let lost = 0; lost < SIZE; lost++) {
  const out = await attempt(SIZE, lost, true)
  atomic.push(out.gas)
  log(
    `leg ${lost} of ${SIZE} taken · ${out.gas} gas · ${out.reverted ? 'reverted, filled nothing' : 'SETTLED'}`,
  )
  must(out.reverted, `an atomic batch missing leg ${lost} reverts`)
}

head('the same legs, sent the tolerant way')
const tolerant: bigint[] = []
for (let lost = 0; lost < SIZE; lost++) {
  const out = await attempt(SIZE, lost, false)
  tolerant.push(out.gas)
  must(!out.reverted, `a tolerant batch missing leg ${lost} still settles`)
}
log(`losing leg 0 · ${tolerant[0]} gas, and it filled the other ${SIZE - 1}`)
log(`losing leg ${SIZE - 1} · ${tolerant[SIZE - 1]} gas, the same`)

head('what losing one leg costs, by where it sat')
const cell = (v: bigint | number | string, w: number) => String(v).padStart(w)
const row = (c: (bigint | number | string)[]) =>
  `${cell(c[0], 4)}  ${cell(c[1], 12)}  ${cell(c[2], 10)}  ${cell(c[3], 13)}  ${cell(c[4], 10)}`
log(row(['leg', 'atomic', 'filled', 'tolerant', 'filled']))
for (let lost = 0; lost < SIZE; lost++) {
  log(row([lost, atomic[lost], 0, tolerant[lost], SIZE - 1]))
}
log('')
log('The atomic column is a ring. It pays for every leg the settlement reached before the missing')
log('one and then throws all of it away, so the cost rises with the position and the return is')
log('always nothing. The tolerant column is `fillBatch` with `skipInvalid`: it steps over the')
log('missing leg, the position does not matter, and it still fills the rest.')

// The whole point, in one number: a ring that loses its last leg pays nearly what a ring that
// settles pays, and collects nothing.
const worst = atomic[SIZE - 1]
log('')
log(`a ring that settles       ${whole.gas} gas, and fills ${SIZE}`)
log(`a ring that loses leg ${SIZE - 1}  ${worst} gas, and fills 0`)
log(`the same legs, tolerant   ${tolerant[SIZE - 1]} gas, and fills ${SIZE - 1}`)
must(atomic[SIZE - 1] > atomic[0], 'a leg lost late costs more than a leg lost early')
must(worst > (whole.gas * 3n) / 4n, 'a ring that fails at the end pays most of what settling costs')

head('so what is an assignment worth')
// Contention is duplicated work. Two solvers that agree who takes which legs never pay any of
// this. The saving is not the gas of a skipped leg — it is the whole attempt, every time a ring
// loses a race, and there is no fault tolerance available to soften it.
// The tolerant path has to be measured against the batch the solver would have sent had it
// known — the same legs, one shorter — and NOT against the eight-leg batch. Comparing a batch
// that fills seven with one that fills eight prices the missing FILL, not the missing leg, and
// it comes out negative, which is how this line read at first: "losing a leg saves 31,066 gas".
const ideal = await attempt(SIZE - 1, -1, false)
const wasted = tolerant[0] - ideal.gas
log(`a tolerant batch of ${SIZE} missing one leg  ${tolerant[0]} gas, fills ${SIZE - 1}`)
log(`the ${SIZE - 1} legs it would have sent knowing  ${ideal.gas} gas, fills ${SIZE - 1}`)
log(`so losing a leg on the tolerant path wastes ${wasted} gas, and the batch still earns.`)
log(`losing one on a ring wastes up to ${worst} gas, and it earns nothing.`)
log(`That is ${worst / (wasted > 0n ? wasted : 1n)} times as much, for the same lost race.`)
must(wasted > 0n, 'losing a leg costs something even on the tolerant path')
must(worst > wasted * 10n, 'a lost race costs a ring an order of magnitude more than a batch')
log('')
log('That gap is the argument for solvers agreeing who takes what, rather than racing. It is')
log('also why the ring path wants the tighter admission rule: on the tolerant path a bad guess')
log('costs one leg, and on a ring it costs the transaction.')

console.log(failureCount() === 0 ? '\nmeasured.\n' : `\n${failureCount()} failure(s)\n`)
process.exit(failureCount() === 0 ? 0 : 1)

/**
 * What a skipped leg costs, and therefore when a batch of eight is worth sending.
 *
 *   RPC=http://127.0.0.1:8547 PROVE_SETTLEMENT=… npx tsx scripts/lab/batch-gas.ts
 *
 * `fillBatch` with `skipInvalid` steps over a leg it cannot settle and fills the rest. That is
 * the fault tolerance: eight legs go in, seven can fail, one still fills. What nothing priced
 * until now is the failure itself. A skipped leg is not free — the settlement validated it,
 * possibly tried to arm it, and charged for the attempt — and the gas model counts only fills, so
 * a batch that skips most of its legs looked cheaper than it is.
 *
 * That matters because the profitable size of a batch depends on it. A batch pays a fixed cost
 * once and a per-leg cost eight times whether or not the legs fill, so the question "is a batch
 * of eight worth sending when I expect three to fail" has a number behind it, and this measures
 * that number instead of guessing.
 *
 * Three kinds of failure, because they do not cost the same, and because the dear one is not the
 * one that happens:
 *
 *   cheap    the offer is over. `_evaluate` returns Expired before a token is touched.
 *   taken    a rival solver settled the same leg first, so there is nothing left to fill. This
 *            is the ordinary weather of a contested book, not an attack: two solvers reading one
 *            order book WILL overlap, and the loser pays for every leg it duplicated.
 *   armed    the leg passes `_evaluate` and then fails inside `armLeg`'s try/catch: a permit
 *            whose signature will not redeem. That frame is the anti-griefing defence and it is
 *            not free.
 *
 * The last is the one a bad actor picks and the middle is the one that happens every day.
 *
 * Everything runs against the lab chain, so the numbers are the deployed contract's own and the
 * run is repeatable.
 */
import { formatEther, parseEther } from 'viem'
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

const approveData = (spender: `0x${string}`) =>
  `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${'f'.repeat(64)}` as Hex

const encodeCall = (call: { functionName: string; args: readonly unknown[] }): Hex =>
  encodeFunctionData({
    abi: SETTLEMENT_ABI as never,
    functionName: call.functionName,
    args: call.args,
  } as never)

const executor = derive('prove.cash/lab/gas-executor')
// The other solver. Same book, same legs, one block earlier.
const rival = derive('prove.cash/lab/gas-rival')
const makers = Array.from({ length: SIZE }, (_, k) => derive(`prove.cash/lab/gas-maker-${k}`))

// Enough for every batch this run sends, funded once.
//
// An earlier version topped every maker up before each of the 36 batches, and `topUpToken` only
// sends when the holder is short — but a maker emptied by each batch was short every time, so it
// was 8 transfers a batch and the run took over ten minutes. Funding a float up front makes the
// same calls cheap reads. The float has to be generous: a maker that runs dry mid-series skips
// for want of stock rather than for the reason under test, which is the confound that made the
// first version of this script disagree with itself.
const RUNS = 60n

head(`${SIZE} independent offers, one executor, and a rival solver`)
await topUpGas(executor.address, parseEther('5'), 'executor')
await topUpToken(OUT, executor.address, MIN_OUT * RUNS, 'executor')
await send(
  walletFor(executor),
  { to: OUT.address, data: approveData(RELAYER) },
  'executor approved the relayer',
)
await topUpGas(rival.address, parseEther('5'), 'rival')
await topUpToken(OUT, rival.address, MIN_OUT * RUNS, 'rival')
await send(
  walletFor(rival),
  { to: OUT.address, data: approveData(RELAYER) },
  'the rival solver approved the relayer',
)
for (let k = 0; k < SIZE; k++) {
  await topUpGas(makers[k].address, parseEther('0.5'), `maker ${k}`)
  await topUpToken(IN, makers[k].address, AMOUNT_IN * RUNS, `maker ${k}`)
  await send(
    walletFor(makers[k]),
    { to: IN.address, data: approveData(RELAYER) },
    `maker ${k} approved`,
  )
}

// `taken` is not a failure anybody chose. It is what a competing solver leaves behind: the same
// intent, already filled, in the block between this solver's simulation and its inclusion. It is
// the ordinary steady state of a contested book, not an attack, and it happens far more often
// than a bait leg ever will.
type Kind = 'good' | 'cheap' | 'armed' | 'taken'

async function offer(k: number, kind: Kind): Promise<SignedIntent> {
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
    // A `cheap` leg is simply over. `_evaluate` returns Expired before anything is touched.
    startTime: kind === 'cheap' ? now - 7200n : now - 30n,
    endTime: kind === 'cheap' ? now - 3600n : now - 30n + 3600n,
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
  const signed: SignedIntent = { ...intent, signature }
  if (kind !== 'armed') return signed
  // Passes `_evaluate` — the maker has an allowance — but carries a permit whose signature is
  // noise, so `armLeg` reverts inside its own frame and the leg is stepped over.
  return {
    ...signed,
    // Syntactically a signature — `splitPermit` parses it, `v` is 27 — and cryptographically
    // nobody's, so the token refuses it inside `armLeg`'s frame. A `v` of 0x11 fails in the SDK
    // before it ever reaches the chain, which measures the client and not the contract.
    permit: {
      value: AMOUNT_IN,
      deadline: intent.endTime,
      signature: `0x${'aa'.repeat(64)}1b` as `0x${string}`,
    },
  }
}

/** Send one batch of exactly these legs and return the gas it burned. */
async function batch(kinds: Kind[]): Promise<bigint> {
  // Every maker holds exactly one fill's worth, so a batch empties them. Without a top-up here
  // the first run is the only honest one and every later batch skips for want of funds rather
  // than for the reason under test — which is exactly what the first version of this measured:
  // 8 filled cost 769,734 and "7 filled" cost 209,156, a third of it, because nothing filled.
  for (let k = 0; k < kinds.length; k++) {
    await topUpToken(IN, makers[k].address, AMOUNT_IN, `maker ${k}`)
  }
  // Silent while the float holds, which is the point.
  // And the executor, which pays out on every leg that fills. It was funded once for four
  // batches and this runs seventeen, so from the fifth onward it held nothing and every leg was
  // skipped for an empty wallet — measuring the wrong failure with great precision. The tell was
  // two identical configurations disagreeing: `all 8 fill` read 598,842 in one series and
  // 145,530 in the other.
  await topUpToken(OUT, executor.address, MIN_OUT * BigInt(SIZE), 'executor')
  const fills: { intent: SignedIntent; take: bigint }[] = []
  for (let k = 0; k < kinds.length; k++) {
    const intent = await offer(k, kinds[k])
    fills.push({ intent, take: AMOUNT_IN })
  }

  // The competitor's transaction. A `taken` leg is a perfectly good offer that somebody else
  // settles first, so it has to be filled here — in its own block, from a different wallet —
  // rather than simulated into a bad state. Its maker then has nothing left, which is exactly
  // the position a losing solver's batch finds them in.
  const taken = kinds.map((kind, k) => ({ kind, k })).filter((r) => r.kind === 'taken')
  if (taken.length > 0) {
    await topUpToken(OUT, rival.address, MIN_OUT * BigInt(taken.length), 'rival')
    const theirs = taken.map((r) => fills[r.k])
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
      `a rival solver took ${taken.length} of these legs first`,
    )
  }

  const call = callFor(
    { mode: 'batch', fills, maxFeeRate: boundFor(fills.map((f) => f.intent)), skipInvalid: true },
    CHAIN,
  )
  const hash = await walletFor(executor).sendTransaction({
    to: SETTLEMENT,
    data: encodeCall(call),
    gas: 12_000_000n,
  })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  return receipt.gasUsed
}

/** A batch of `SIZE` legs, `bad` of them failing the given way. */
const measure = (bad: number, kind: Exclude<Kind, 'good'>) =>
  batch(Array.from({ length: SIZE }, (_, k): Kind => (k < bad ? kind : 'good')))

// Warm every slot first, and discard the result.
//
// The first batch a chain ever sees pays a cold SSTORE for each maker's balance, each
// allowance and each recipient's balance. It cost 769,722 against 145,398 for the identical
// batch run second — five times, for the same eight fills. Measuring a declining series without
// warming first mixes "fewer legs filled" with "slots already touched", and the per-leg number
// that falls out of it is meaningless. A bot filling continuously runs warm, so warm is the
// case worth pricing.
head('warming the slots, so the numbers below measure legs and not first touches')
const cold = await measure(0, 'cheap')
log(`the first batch pays for cold storage: ${cold} gas, and is not counted below`)

head('one batch against the same legs sent one at a time')
// The decision a solver actually faces is never "batch or stay home" — it is "one batch of eight
// or eight transactions". So measure the alternative rather than assuming it.
//
// This also separates the two numbers that a per-leg average silently welds together. Sweeping
// the size with every leg good gives
//     gas(n) = base + n * fill
// so the SLOPE is what one more leg costs and the INTERCEPT is what the transaction costs before
// any leg runs. Dividing an eight-leg total by eight instead charges every survivor a share of a
// base that is paid once, which makes a batch look worse the more legs fail and is the reason a
// naive reading of this script says never send one.
const bySize: bigint[] = []
for (let n = 1; n <= SIZE; n++) {
  const gas = await batch(Array.from({ length: n }, (): Kind => 'good'))
  bySize.push(gas)
  log(`${String(n).padStart(2)} good legs · ${gas} gas`)
}
const fillMarginal = (bySize[SIZE - 1] - bySize[0]) / BigInt(SIZE - 1)
// One leg's total, less that leg's own marginal cost. Everything a transaction pays before the
// first leg does anything: the 21,000 intrinsic, the calldata, the signature domain, the fee run.
const base = bySize[0] - fillMarginal
const singles = bySize[0] * BigInt(SIZE)
log('')
log(`one more good leg costs ${fillMarginal} gas`)
log(`a transaction costs ${base} gas before any leg runs`)
log(`${SIZE} legs, one batch     ${bySize[SIZE - 1]} gas`)
log(`${SIZE} legs, one at a time ${singles} gas`)
log(`the batch saves ${singles - bySize[SIZE - 1]} gas, ${100n - (bySize[SIZE - 1] * 100n) / singles}%`)
must(bySize[SIZE - 1] < singles, 'a batch beats the same legs sent one at a time')
must(fillMarginal > 0n, 'another leg costs something')
must(base > 21_000n, 'the base covers at least the intrinsic gas of a transaction')

// Both sweeps run to `bad === SIZE`, the batch where nothing fills. It is not a hypothetical:
// it is what a solver pays when the block it lands in has moved under every leg it planned
// around, and it is the worst case the send rule has to survive.
head(`a batch of ${SIZE}, losing legs to an expired offer`)
const cheap: bigint[] = []
for (let bad = 0; bad <= SIZE; bad++) {
  const gas = await measure(bad, 'cheap')
  cheap.push(gas)
  log(`${SIZE - bad} filled, ${bad} skipped · ${gas} gas`)
}

head(`the same, losing them to a rival solver who got there first`)
// The case that actually happens. Two solvers read one book, build batches that overlap, and one
// lands first. The loser's legs are not bad — they are gone.
const contested: bigint[] = []
for (let bad = 0; bad <= SIZE; bad++) {
  const gas = await measure(bad, 'taken')
  contested.push(gas)
  log(`${SIZE - bad} filled, ${bad} skipped · ${gas} gas`)
}

head(`the same, losing them to a permit that will not redeem`)
const armed: bigint[] = []
for (let bad = 0; bad <= SIZE; bad++) {
  const gas = await measure(bad, 'armed')
  armed.push(gas)
  log(`${SIZE - bad} filled, ${bad} skipped · ${gas} gas`)
}

head('what a leg costs, warm')
// Every batch here has exactly SIZE legs, so the only thing changing is what each one does:
//   gas(bad) = base + (SIZE - bad) * fill + bad * skip
// Swapping one fill for one skip therefore moves the total by exactly (skip - fill), and the
// slope across the series is that difference. `base + SIZE * fill` is the all-good batch.
const swingCheap = (cheap[0] - cheap[SIZE]) / BigInt(SIZE)
const swingArmed = (armed[SIZE] - armed[0]) / BigInt(SIZE)
// The contested series has edge effects at both ends, so take its slope from the middle, where
// the only thing changing is the reason a leg fails.
const swingTaken = (contested[1] - contested[SIZE - 1]) / BigInt(SIZE - 2)
log(`a leg that fills           ${fillMarginal} gas`)
log(`a leg that expired         ${fillMarginal - swingCheap} gas`)
log(`a leg a rival already took ${fillMarginal - swingTaken} gas`)
log(`a leg that cannot be armed ${fillMarginal + swingArmed} gas`)
log('')
log('An expired leg is nearly free, and a leg a rival took is close behind it: `_evaluate`')
log('refuses both before a token is touched, the second after one more storage read. A leg that')
log('passes evaluation and then fails to arm costs MORE than filling it would have — the external')
log('call is made and reverted, and that frame is the anti-griefing defence, not waste.')
log('')
log('So the failure that happens constantly is the cheap one, and the dear one needs an attacker')
log('to build a bait and then win a race to land it. That is the right way round.')
must(swingTaken > 0n, 'a leg a rival took is cheaper than one that fills')
must(fillMarginal - swingTaken < fillMarginal + swingArmed, 'contention is cheaper than a bait')
must(cheap[0] > cheap[SIZE], 'a batch that fills more costs more than one that expires legs')
must(swingCheap > 0n, 'an expired leg is cheaper than a filled one')

// The measurement checks itself. `cheap[0]` and `armed[0]` are the same batch — eight legs, all
// good, no failures — so they must agree. When they did not, it was because something else had
// changed underneath: cold storage the first time, then an executor with nothing left to pay
// with. A series that cannot reproduce its own first point is not measuring what it claims.
const drift = cheap[0] > armed[0] ? cheap[0] - armed[0] : armed[0] - cheap[0]
must(
  (drift * 100n) / cheap[0] < 5n,
  `both all-good batches agree: ${cheap[0]} and ${armed[0]}, ${(drift * 100n) / cheap[0]}% apart`,
)

head(`every way a batch of ${SIZE} can go, and what each costs`)
// The right baseline is not "send nothing". The solver simulates before it sends, so the legs it
// expects to fail are the ones it already dropped. A leg only reaches the chain and fails when
// the state moved between the simulation and the block — a race, not a plan.
//
// So the honest price of a failure is the batch that carried it, less the batch the solver would
// have sent had it known: the same fills, one leg shorter. That difference is the whole griefing
// surface, and it is a per-leg number, not a per-batch one.
const GWEI = 1_000_000_007n

/** The batch the solver would have sent had it known which legs would fail: the survivors only. */
const ideal = (filled: number) => (filled === 0 ? 0n : bySize[filled - 1])

const cell = (v: bigint | number | string, w: number) => String(v).padStart(w)
// Every row is ONE batch of SIZE legs. The two gas columns are that same batch measured twice,
// and the only thing that differs between them is WHY the failing legs failed. The first header
// line said `expired` and `unarmable` on their own, which reads as two kinds of batch. They are
// not: they are two kinds of leg, inside the same batch.
/** One row, header or data, so the two can never drift out of alignment. */
const row = (c: (bigint | number | string)[]) =>
  `${cell(c[0], 4)}  ${cell(c[1], 4)}  ${cell(c[2], 13)}  ${cell(c[3], 16)}  ${cell(c[4], 17)}  ` +
  `${cell(c[5], 9)}  ${cell(c[6], 10)}`

log(`the same ${SIZE} legs each time. only the reason a failing leg fails changes.`)
log('')
log(
  row([
    'fail',
    'fill',
    'a stale offer',
    'taken by a rival',
    'a dead signature',
    'per fill',
    'wasted',
  ]),
)
for (let bad = 0; bad <= SIZE; bad++) {
  const filled = SIZE - bad
  const wasted = armed[bad] - ideal(filled)
  log(
    row([
      bad,
      filled,
      cheap[bad],
      contested[bad],
      armed[bad],
      filled === 0 ? '-' : armed[bad] / BigInt(filled),
      wasted,
    ]),
  )
}
log('')
log('A stale offer and a leg a rival already took are both cheap: `_evaluate` refuses them')
log('before a token is touched, and each costs LESS than the fill it replaced. A dead signature')
log('is the dear one — the offer is live and funded, so the settlement makes the external call,')
log('the token refuses it, and the frame catches the revert. That costs MORE than filling.')
log('')
log('The middle column is the one to plan against, because it is the one that happens without')
log('anybody attacking anything: two solvers reading one book will overlap, and the loser pays')
log('it every time. The third column needs somebody to build a bait and win a race to land it.')
log('')
log('`per fill` is the whole batch divided by the legs that settled: what one survivor has to')
log('earn back. `wasted` is what the failures cost over the batch the solver would have sent had')
log('it known which legs would fail — which is the whole griefing surface.')
log('')
log('Row 0 has no failures, so its `wasted` is the measurement reading its own noise: two')
log('all-good batches, twenty batches apart in one run. Treat that figure as the floor under')
log('every other number in the column, sign included.')
log('')
log('The last row is the one that does not fit the line, and it should not. Every other row')
log('compares against a shorter batch, which still pays the base. The row where nothing fills')
log('compares against sending nothing at all, so it wastes the base as well as the legs.')
log('')
log('A batch is worth sending when the surplus on the legs that FILL covers the gas of all')
log('eight. Pricing only the survivors is what makes a batch of eight look free.')

const wastedAt = (bad: number) => armed[bad] - ideal(SIZE - bad)
const near = (got: bigint, want: bigint) => {
  const off = got > want ? got - want : want - got
  return (off * 100n) / want < 5n
}

// The waste is linear in the failure count while at least one leg fills, and that is what makes
// the send rule safe to write down: each failure costs one `perSkippedLeg` and nothing compounds.
// A row off this line would mean a failure costs more in company, and no fixed per-leg model
// could then be honest.
//
// The first version of this check drew its slope from row 8 and failed all seven rows that were
// right. Row 8 is a different regime — see below — and a line fitted through two regimes
// describes neither.
const step = (wastedAt(SIZE - 1) - wastedAt(1)) / BigInt(SIZE - 2)
for (let bad = 1; bad < SIZE; bad++) {
  must(near(wastedAt(bad), step * BigInt(bad)), `${bad} failures waste ${wastedAt(bad)}, ${bad} x ${step}`)
}

// And the row where nothing fills sits exactly one base above that line, because the batch it is
// measured against is no batch at all. This is the worst case a send rule has to survive: the
// solver pays for eight legs and the transaction that carried them, and collects nothing.
must(
  near(wastedAt(SIZE), step * BigInt(SIZE) + base),
  `a batch that fills nothing wastes ${wastedAt(SIZE)}, which is ${SIZE} x ${step} plus the ${base} base`,
)

head('what it costs to grief one')
// The bait: an intent priced to be picked up, whose arming will not redeem. It has to pass
// `_evaluate` first, and `_evaluate` reads the maker's funds before their signature, so an empty
// wallet is refused on the cheap path. The attacker therefore has to hold the stock, keep the
// allowance open, and break only the signature.
//
// And it has to survive simulation, which it does not: an unredeemable permit fails the solver's
// `eth_call` exactly as it fails on chain. To land, the attacker must let the leg simulate clean
// and then spend the nonce before the batch is mined — which costs them a transaction of their
// own, in the same block, at a higher price than the batch they are trying to spoil.
const grief = armed[1] - ideal(SIZE - 1)
log(`one bait leg in a batch of ${SIZE} costs the solver ${grief} gas (${formatEther(grief * GWEI)} PLS)`)
log(`it costs the attacker a front-running transaction, every time, and the bait is spent`)
log('')
log('The frame is what bounds this. Without `try this.armLeg`, one bait reverts the whole batch,')
log('the nonce survives because the revert unwinds it, and the same intent works for ever. With')
log(`the frame the solver loses ${grief} gas once and stops planning around that maker.`)
must(grief < armed[1], 'a failed leg costs less than the batch that carried it')

console.log(failureCount() === 0 ? '\nmeasured.\n' : `\n${failureCount()} failure(s)\n`)
process.exit(failureCount() === 0 ? 0 : 1)

/**
 * What may share a tolerant batch, checked against a chain rather than against a fixture.
 *
 *   RPC=… PROVE_SETTLEMENT=… PROVE_BATCH_EXECUTOR=… npx tsx scripts/lab/packed-batch.ts
 *
 * `packBatch` decides which plans can ride in one `skipInvalid` transaction, where losing a leg
 * to another solver costs that leg and no more. Its first rule was "one fill", on the reasoning
 * that `Swap.leg` names one leg and so cannot speak for a cycle. Twelve unit tests agreed.
 *
 * The chain did not. Four single-fill plans with no swaps between them packed cleanly, went out,
 * and reverted for 81,900 gas having filled nothing — correctly, because `ProveBatchExecutor`
 * holds nothing between transactions. Each leg handed it token A and left it owing token B, and
 * with no venue call there was no way for any maker to be paid.
 *
 * So the rule has a second half: a packed plan must carry its own swap. A plan without one is
 * relying on another leg's release, which is a cycle, and a cycle cannot survive one of its legs
 * being stepped over. The dangerous version is not the four above — those fail loudly — but two
 * that happen to net, A for B and B for A. They pay each other perfectly and settle every time,
 * until the day a rival takes one and the other is left unfunded.
 *
 * This runs both halves against the deployed contract. First the refusals, then a batch that is
 * built properly — one swap per leg, each naming the leg it exists for — with a rival taking one
 * leg in the block before it lands. The rest settle, which under the old `LegCountMismatch` rule
 * was impossible.
 *
 * The venue is `MockRouter`, deployed by `DeployLabVenue.s.sol` and paying one for one out of its
 * own float. It answers the same `swapExactTokensForTokens` the SDK builds, so the calldata path
 * is real even though the price is not. Nothing here should be read as a measurement of a route:
 * it is a test of who gets paid when a leg goes missing.
 */
import { encodeFunctionData, formatUnits, parseEther, type Hex } from 'viem'
import { describe } from '../rpc.ts'
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
  NO_PATCH,
  disposalSwap,
  packBatch,
  settleBatchCall,
  type Plan,
  xykMarket,
  type MarketSwap,
} from '@prove.cash/sdk/solver'
import {
  boundFor,
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
} from '../e2e/common.js'

const IN = token('tPLSX')
const OUT = token('tUSDC')
const AMOUNT_IN = units(IN, '10')
const MIN_OUT = units(OUT, '0.2')
const SIZE = 4
/** Which leg the rival takes. Not the first or the last, so neither end hides a fencepost. */
const TAKEN = 1

const BATCH_EXECUTOR = (process.env.PROVE_BATCH_EXECUTOR ?? '') as `0x${string}`
if (!BATCH_EXECUTOR) throw new Error('PROVE_BATCH_EXECUTOR is required')
const VENUE = (process.env.LAB_VENUE ?? '') as `0x${string}`
if (!VENUE) throw new Error('LAB_VENUE is required: run app/scripts/lab/up.sh')

const approveData = (spender: `0x${string}`) =>
  `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, '0')}${'f'.repeat(64)}` as Hex

const solver = derive('prove.cash/lab/pack-solver')
const rival = derive('prove.cash/lab/pack-rival')
const makers = Array.from({ length: SIZE }, (_, k) => derive(`prove.cash/lab/pack-maker-${k}`))

head(`${SIZE} independent offers, one solver, one rival`)
for (const [who, name] of [
  [solver, 'solver'],
  [rival, 'rival'],
] as const) {
  await topUpGas(who.address, parseEther('5'), name)
  await topUpToken(OUT, who.address, MIN_OUT * 20n, name)
  await send(walletFor(who), { to: OUT.address, data: approveData(RELAYER) }, `${name} approved`)
}
for (let k = 0; k < SIZE; k++) {
  await topUpGas(makers[k].address, parseEther('0.5'), `maker ${k}`)
  await topUpToken(IN, makers[k].address, AMOUNT_IN * 4n, `maker ${k}`)
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

/**
 * A plan carrying `n` fills and no swap.
 *
 * `packBatch` reads three fields — `fills`, `swap`, `maxFeeRate` — so those three are real and
 * the rest of `Plan` is not built. A fuller fixture would only assert that this script can fill
 * in a type.
 */
const planOf = (
  fills: { intent: SignedIntent; take: bigint }[],
  maxFeeRate: bigint,
  swap: MarketSwap | null,
): Plan => ({ fills, swap, maxFeeRate }) as unknown as Plan

/**
 * The swap that closes one leg: sell some of the token A it released for the token B it owes.
 *
 * **Both amounts are `MIN_OUT`, and that is not a typo.** `MockRouter` pays `in * rate` in RAW
 * units and the rate here is one for one, so raw in equals raw out and the decimals never enter
 * the arithmetic. tPLSX has eighteen and tUSDC has six, so selling a whole `AMOUNT_IN` — ten
 * tPLSX, or 1e19 raw — asks the venue for 1e19 raw tUSDC, which is ten trillion tUSDC. It holds a
 * million. The batch got all the way through its swaps and reverted at 433,603 gas.
 *
 * Selling `MIN_OUT` raw tPLSX for `MIN_OUT` raw tUSDC buys exactly what the leg owes, and exactly
 * what the leg owes is not enough: the settlement pulls `amount + fee` per line, so a swap sized
 * to the delivery alone leaves the executor short by the fee and the batch dies on
 * `ERC20InsufficientBalance`. Twice over covers it with room to spare.
 *
 * A solver sizes this to the fee it was quoted. Doing that here would read as arithmetic against
 * the venue's price, and the venue has no price — it pays a fixed rate out of a float. Buying
 * plainly too much and sweeping the difference is the honest version for a mock.
 *
 * The rest of the released tPLSX is the surplus and sweeps home, which is what a real leg looks
 * like too: the profit is the part the solver never had to sell.
 *
 * Only `path`, `amountIn` and `amountOutMin` are read here. Everything else about a `PoolSwap`
 * belongs to pricing, which a fixed-rate mock cannot do honestly and should not pretend to.
 */
const poolSwap = (): MarketSwap => ({
  // The reserves are never read here: `packBatch` asks the market only for its calldata, and the
  // sizing was done by the intent leg. A market still has to be a market, though — that is the
  // point of the type — so this is a real one over a pair that happens to be the venue's.
  market: xykMarket(
    {
      address: VENUE,
      token0: IN.address,
      token1: OUT.address,
      reserve0: AMOUNT_IN * 1_000n,
      reserve1: MIN_OUT * 1_000n,
    } as never,
    OUT.address,
    IN.address,
    VENUE,
  ),
  amountIn: MIN_OUT * 2n,
  amountOutMin: MIN_OUT * 2n,
})

const now = async () => (await pub.getBlock({ blockTag: 'latest' })).timestamp

const packOpts = (at: bigint) => ({
  batchExecutor: BATCH_EXECUTOR,
  deadline: at + 300n,
})

const BALANCE_OF = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const

/**
 * Simulate, say what the chain said, then send.
 *
 * A lab script that only reports "reverted, 153,090 gas" sends the reader to `cast run`, and the
 * reason is one `eth_call` away. Both sends go through this, because the first version had it on
 * one of them and the second failure cost a round of guessing.
 */
async function sendCall(
  call: { address: `0x${string}`; abi: unknown; functionName: string; args: unknown },
  label: string,
) {
  const data = encodeFunctionData({
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
  } as never)
  try {
    await pub.simulateContract({
      account: solver.address,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)
  } catch (e) {
    for (const line of describe(e).split('\n').slice(0, 4)) log(`  ${line}`)
  }
  const hash = await walletFor(solver).sendTransaction({ to: call.address, data, gas: 12_000_000n })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  log(`${label}: ${receipt.status} · ${receipt.gasUsed} gas · ${hash}`)
  return receipt
}

const heldBy = (who: `0x${string}`) => heldOf(OUT, who)

const heldOf = (t: { address: `0x${string}` }, who: `0x${string}`) =>
  pub.readContract({ address: t.address, abi: BALANCE_OF, functionName: 'balanceOf', args: [who] })

/** One, in the unit `minOutPerIn` is counted in. */
const WAD = 10n ** 18n

head('what the packer refuses, and why')
// Two plans that cannot be packed, for the two different reasons, so the refusals are told apart
// rather than counted. Neither ever reaches a chain.
const ringLegs = [await offer(0), await offer(1)]
const refusals = packBatch(
  [
    planOf([{ intent: await offer(2), take: AMOUNT_IN }], FEE_RATE, null),
    planOf(
      ringLegs.map((intent) => ({ intent, take: AMOUNT_IN })),
      FEE_RATE,
      poolSwap(),
    ),
  ],
  packOpts(await now()),
)
for (const r of refusals.refused) log(`  refused: ${r.why}`)
must(refusals.fills.length === 0, 'neither plan was packed')
must(
  refusals.refused.some((r) => r.why.includes('another leg would have to pay its maker')),
  'the swapless plan was refused for having nothing to pay its maker with',
)
must(
  refusals.refused.some((r) => r.why.includes('atomically')),
  'and the ring for being a ring, which is a different problem',
)

head(`${SIZE} plans that do carry their own swap`)
const plans: Plan[] = []
for (let k = 0; k < SIZE; k++) {
  plans.push(planOf([{ intent: await offer(k), take: AMOUNT_IN }], FEE_RATE, poolSwap()))
}
const packed = packBatch(plans, packOpts(await now()))
log(`packed ${packed.fills.length} legs, ${packed.route.swaps.length} swaps, ${packed.refused.length} refused`)
must(packed.fills.length === SIZE, `all ${SIZE} went in`)
must(packed.route.swaps.length === SIZE, 'each with a swap of its own')
must(
  packed.route.swaps.every((sw, i) => sw.leg === BigInt(i)),
  'and each swap names its own leg',
)

head(`a rival settles leg ${TAKEN} first`)
const theirs = [packed.fills[TAKEN]]
await send(
  walletFor(rival),
  {
    to: SETTLEMENT,
    data: encodeFunctionData({
      abi: SETTLEMENT_ABI as never,
      ...callFor(
        {
          mode: 'batch',
          fills: theirs,
          maxFeeRate: boundFor([theirs[0].intent]),
          skipInvalid: false,
        },
        CHAIN,
      ),
    } as never),
    gas: 12_000_000n,
  },
  `the rival took leg ${TAKEN}`,
)
const takenMaker = packed.fills[TAKEN].intent.maker
const byRival = await heldBy(takenMaker)
must(byRival > 0n, `the rival paid maker ${TAKEN} ${formatUnits(byRival, OUT.decimals)}`)

head('and the batch settles the rest, minus that one')
const before: bigint[] = []
for (let k = 0; k < SIZE; k++) before.push(await heldBy(makers[k].address))

const call = settleBatchCall(BATCH_EXECUTOR, packed.fills, packed.maxFeeRate, packed.route)

// Simulate first, exactly as the solver does, and say what the chain said. A lab script that
// only reports "reverted, 721,981 gas" sends whoever is reading it back to `cast run`, and the
// reason is one `eth_call` away.
try {
  await pub.simulateContract({
    account: solver.address,
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
  } as never)
} catch (e) {
  for (const line of describe(e).split('\n').slice(0, 6)) log(`  ${line}`)
}

const hash = await walletFor(solver).sendTransaction({
  to: call.address,
  data: encodeFunctionData({
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
  } as never),
  gas: 12_000_000n,
})
const receipt = await pub.waitForTransactionReceipt({ hash })
log(`${receipt.status} · ${receipt.gasUsed} gas · ${hash.slice(0, 12)}…`)
must(receipt.status === 'success', 'the batch did not revert on the leg it lost')

let paidHere = 0
for (let k = 0; k < SIZE; k++) {
  const gained = (await heldBy(makers[k].address)) - before[k]
  if (gained > 0n) paidHere++
  log(`maker ${k} gained ${formatUnits(gained, OUT.decimals)} ${OUT.symbol}${k === TAKEN ? '  (the rival had already paid this one)' : ''}`)
}
must(paidHere === SIZE - 1, `${SIZE - 1} makers were paid by this batch`)
must(
  (await heldBy(makers[TAKEN].address)) === byRival,
  'and the leg the rival took was stepped over, not paid a second time',
)

head('and the surplus goes where the solver wants it, sized on chain')
// Every leg released AMOUNT_IN of tPLSX and only MIN_OUT * 2 of it was sold to pay the maker.
// The rest is surplus, and how much of it there is depends on how many legs settled — which is
// exactly the number no route can know when it is built. `disposalSwap` names the offsets instead
// of a figure, and the executor writes the increase above its own mark into the calldata.
//
// Into tWETH rather than tUSDC, and the reason is the venue's arithmetic rather than a
// preference. `MockRouter` pays `in * rate` in RAW units at one for one, so selling forty tPLSX
// — 4e19 raw — asks for 4e19 raw of whatever it buys. In tUSDC, with six decimals, that is forty
// trillion against a float of one million: the disposal fails, is swallowed, and the tPLSX sweeps
// home unsold. Which is the best-effort promise working exactly as written, and a poor way to
// show that the sizing does.
//
// tWETH has eighteen, so 4e19 raw is forty of them and the float covers it.
const WANT = token('tWETH')
const surplusBefore = await heldOf(IN, solver.address)
const wantBefore = await heldOf(WANT, solver.address)
const dis = disposalSwap(VENUE, IN.address, WANT.address, WAD / 2n, BATCH_EXECUTOR, await now())
must(dis.amountOffset !== NO_PATCH, 'the disposal asks to be sized on chain')

const plans2: Plan[] = []
for (let k = 0; k < SIZE; k++) {
  plans2.push(planOf([{ intent: await offer(k), take: AMOUNT_IN }], FEE_RATE, poolSwap()))
}
const withDisposal = packBatch(plans2, { ...packOpts(await now()), disposal: [dis] })
const call2 = settleBatchCall(
  BATCH_EXECUTOR,
  withDisposal.fills,
  withDisposal.maxFeeRate,
  withDisposal.route,
)
const r2 = await sendCall(call2, 'with a disposal')
must(r2.status === 'success', 'the batch settled with a disposal on it')

const gainedIn = (await heldOf(IN, solver.address)) - surplusBefore
const gainedWant = (await heldOf(WANT, solver.address)) - wantBefore
log(`the solver gained ${formatUnits(gainedIn, IN.decimals)} ${IN.symbol}`)
log(`and ${formatUnits(gainedWant, WANT.decimals)} ${WANT.symbol}`)
must(gainedWant > 0n, 'the surplus came home in the token the solver asked for')
must(
  gainedIn === 0n,
  'and none in the token it was earned in, because the disposal sold all of it',
)
// The size is the point. Nothing off chain named forty tokens — `disposalSwap` wrote a zero into
// the calldata and the executor overwrote it with the increase above its own mark. A route that
// had to guess would have sold whatever figure it guessed and swept the rest.
must(
  gainedWant >= AMOUNT_IN * BigInt(SIZE) / 2n,
  `it sold the whole surplus: ${formatUnits(gainedWant, WANT.decimals)} back from four legs`,
)

log('')
log(`Under the old rule this transaction reverted: the route said ${SIZE} legs, ${SIZE - 1} settled,`)
log('and the callback could see that one had gone but not which, so refusing was the only safe')
log(`answer it had. Measured on eight legs in atomic-revert.ts, that cost up to 553,246 gas to`)
log('fill nothing.')

console.log(failureCount() === 0 ? '\nsettled.\n' : `\n${failureCount()} failure(s)\n`)
process.exit(failureCount() === 0 ? 0 : 1)

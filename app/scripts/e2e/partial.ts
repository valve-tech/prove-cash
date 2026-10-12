/**
 * A partial fill, then a second fill of the remainder, on chain 943.
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK \
 *     npx tsx scripts/e2e/partial.ts
 *
 * One `FLAG_PARTIAL` intent for 100 tPLSX, taken 40 first and 60 second, by two different
 * executors so the run also proves the intent is not pinned to whoever got there first. After
 * each leg the maker must hold at least the rate they signed for the part that was taken, and
 * after the second leg the intent must be exhausted rather than merely unattractive.
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
  intentHashOf,
  quote,
  readAvailable,
  toStruct,
  type Intent,
  type SignedIntent,
  signIntent,
} from '@prove.cash/sdk'
import {
  boundFor,
  CHAIN,
  FEE_RATE,
  FEE_CONFIG,
  SETTLEMENT,
  balanceOf,
  derive,
  ensureAllowance,
  finish,
  head,
  log,
  must,
  pub,
  show,
  token,
  topUpGas,
  topUpToken,
  units,
  walletFor,
  write,
  redact,
} from './common.js'

const IN = token('tPLSX')
const OUT = token('tUSDC')

const maker = derive('prove.cash/e2e/partial-maker')
const first = derive('prove.cash/e2e/executor')
const second = derive('prove.cash/e2e/solver')
const makerWallet = walletFor(maker)

const AMOUNT_IN = units(IN, '100')
const RATE = units(OUT, '3')
const LEG_ONE = units(IN, '40')
const LEG_TWO = AMOUNT_IN - LEG_ONE

head('setup')
log(`maker      ${maker.address}`)
log(`executor 1 ${first.address}`)
log(`executor 2 ${second.address}`)
await topUpGas(maker.address, parseEther('0.1'), 'partial maker')
await topUpGas(first.address, parseEther('0.3'), 'executor 1')
await topUpGas(second.address, parseEther('0.2'), 'executor 2')
await topUpToken(IN, maker.address, AMOUNT_IN, 'partial maker')
await topUpToken(OUT, first.address, units(OUT, '10'), 'executor 1')
await topUpToken(OUT, second.address, units(OUT, '10'), 'executor 2')
await ensureAllowance(makerWallet, IN, AMOUNT_IN, 'maker')
await ensureAllowance(walletFor(first), OUT, units(OUT, '10'), 'executor 1')
await ensureAllowance(walletFor(second), OUT, units(OUT, '10'), 'executor 2')

head('one intent, open to partial fills')
const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
const intent: Intent = {
  maker: maker.address,
  recipient: maker.address,
  tokenIn: IN.address,
  tokenOut: OUT.address,
  amountIn: AMOUNT_IN,
  minOutStart: RATE,
  minOutEnd: RATE,
  // A straight line across the whole window: kind 0, and the word it reads none of.
  curve: CURVE_LINEAR,
  startTime: now - 60n,
  endTime: now - 60n + 3600n,
  executor: ZERO,
  feeConfig: FEE_CONFIG,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  feeRate: FEE_RATE,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: FLAG_PARTIAL,
  nonce: BigInt(Date.now()),
}
const signature = await signIntent(maker, intent, { domain: signingDomain(CHAIN) })
const signed: SignedIntent = { ...intent, signature }
const hash = intentHashOf(intent, CHAIN)
log(`${show(IN, AMOUNT_IN)} for at least ${show(OUT, RATE)} · ${hash}`)

/** What this executor will pay, over every leg it fills. The intent's own rate is inside it. */
const maxFeeRate = boundFor([intent])


const read = (fn: string, args: readonly unknown[]): Promise<unknown> =>
  pub.readContract({ address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: fn, args } as never)

async function leg(who: typeof first, take: bigint, label: string) {
  const makerIn = await balanceOf(IN, maker.address)
  const makerOut = await balanceOf(OUT, maker.address)

  const call = callFor({ mode: 'direct', fills: [{ intent: signed, take }], maxFeeRate }, CHAIN)
  const { receipt } = await write(
    walletFor(who),
    { address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: call.functionName, args: call.args },
    label,
  )
  const at = (await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp

  // The maker no longer receives what they signed for. The fee comes out of the signed number,
  // so the floor to check against is `delivered`, and `gross` is only the executor's outlay.
  const { gross, delivered: owed } = quote(intent, take, at)
  const got = (await balanceOf(OUT, maker.address)) - makerOut
  must(
    got >= owed,
    `${label}: the maker received ${show(OUT, got)}; the fill owed them ${show(OUT, owed)} out of a signed ${show(OUT, gross)}`,
  )
  must(
    makerIn - (await balanceOf(IN, maker.address)) === take,
    `${label}: exactly ${show(IN, take)} left the maker`,
  )
  must(
    (await balanceOf(IN, who.address)) > 0n,
    `${label}: the executor holds the token A it bought`,
  )
}

head(`first leg — ${show(IN, LEG_ONE)} of ${show(IN, AMOUNT_IN)}`)
await leg(first, LEG_ONE, 'leg one')
must(((await read('filled', [hash])) as bigint) === LEG_ONE, `the contract books ${show(IN, LEG_ONE)} filled`)
// `available` is `ProveReader`'s, not the settlement's.
const { remaining: remainingAfterOne, live: liveAfterOne } = await readAvailable(intent, { chainId: CHAIN, client: pub })
must(remainingAfterOne === LEG_TWO, `${show(IN, remainingAfterOne)} is still on offer`)
must(liveAfterOne, 'and the intent is still live')

// Taking more than remains has to be refused, or "partial" would mean "unbounded".
let refused = 'it went through'
try {
  await pub.simulateContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'fill',
    args: [toStruct(intent), signature, LEG_TWO + 1n, maxFeeRate],
    account: second,
  })
} catch (e) {
  refused = (e as Error).message.includes('TooMuch') ? 'TooMuch' : redact((e as Error).message)
}
must(refused === 'TooMuch', `taking more than remains is refused · ${refused.split('\n')[0]}`)

head(`second leg — the remaining ${show(IN, LEG_TWO)}, by a different executor`)
await leg(second, LEG_TWO, 'leg two')
must(((await read('filled', [hash])) as bigint) === AMOUNT_IN, `the contract books the whole ${show(IN, AMOUNT_IN)}`)
const { remaining: remainingAfterTwo, live: liveAfterTwo } = await readAvailable(intent, { chainId: CHAIN, client: pub })
must(remainingAfterTwo === 0n, 'nothing remains')
must(!liveAfterTwo, 'and the intent is no longer live')

head('the maker, over both legs')
const total = quote(intent, AMOUNT_IN, now)
log(
  `signed for at least ${show(OUT, total.gross)} across the whole ${show(IN, AMOUNT_IN)}, of which the maker keeps ${show(OUT, total.delivered)}`,
)
log(`holds ${show(OUT, await balanceOf(OUT, maker.address))} of ${OUT.symbol} now`)

finish('partial fill')

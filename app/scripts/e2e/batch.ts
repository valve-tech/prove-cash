/**
 * `fillBatch` with `skipInvalid`, on chain 943.
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK \
 *     npx tsx scripts/e2e/batch.ts
 *
 * Three intents from the same maker go into one batch: one fillable, one that expired an hour
 * ago, and one the maker cancelled on chain a moment before. The batch must settle the good one,
 * step over the other two, and not revert. That is the whole point of the flag — losing a race
 * for one intent should not cost an executor the rest of them.
 *
 * The run also checks the other side of the flag: with `skipInvalid` false, the same batch has to
 * revert. A batch that succeeds either way would not be skipping anything.
 */
import { parseEther, type Hex } from 'viem'
import {
  CURVE_LINEAR,
  SETTLEMENT_ABI,
  ZERO,
  ZERO_HASH,
  callFor,
  signingDomain,
  intentHashOf,
  quote,
  toStruct,
  type Intent,
  type SignedIntent,
  signIntent as signIntentWith,
} from '@prove.cash/sdk'
import {
  CHAIN,
  FEE_RATE,
  FEE_CONFIG,
  SETTLEMENT,
  balanceOf,
  boundFor,
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

const maker = derive('prove.cash/e2e/batch-maker')
const executor = derive('prove.cash/e2e/executor')
const makerWallet = walletFor(maker)
const executorWallet = walletFor(executor)

const AMOUNT_IN = units(IN, '50')
const RATE = units(OUT, '1.5')

head('setup')
log(`maker    ${maker.address}`)
log(`executor ${executor.address}`)
await topUpGas(maker.address, parseEther('0.1'), 'batch maker')
await topUpGas(executor.address, parseEther('0.3'), 'executor')
await topUpToken(IN, maker.address, AMOUNT_IN, 'batch maker')
await topUpToken(OUT, executor.address, units(OUT, '10'), 'executor')
await ensureAllowance(makerWallet, IN, AMOUNT_IN, 'maker')
await ensureAllowance(executorWallet, OUT, units(OUT, '10'), 'executor')

const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
const base: Omit<Intent, 'nonce' | 'startTime' | 'endTime'> = {
  maker: maker.address,
  recipient: maker.address,
  tokenIn: IN.address,
  tokenOut: OUT.address,
  amountIn: AMOUNT_IN,
  minOutStart: RATE,
  minOutEnd: RATE,
  // A straight line across the whole window: kind 0, and the word it reads none of.
  curve: CURVE_LINEAR,
  executor: ZERO,
  feeConfig: FEE_CONFIG,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  feeRate: FEE_RATE,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: 0,
}

async function signIntent(i: Intent): Promise<SignedIntent> {
  const signature = await signIntentWith(maker, i, { domain: signingDomain(CHAIN) })
  return { ...i, signature }
}

head('three intents: one good, one expired, one cancelled')
const good = await signIntent({
  ...base,
  startTime: now - 60n,
  endTime: now - 60n + 3600n,
  nonce: BigInt(Date.now()),
})
const expired = await signIntent({
  ...base,
  startTime: now - 7200n,
  endTime: now - 3600n,
  nonce: BigInt(Date.now()) + 1n,
})
const cancelled = await signIntent({
  ...base,
  startTime: now - 60n,
  endTime: now - 60n + 3600n,
  nonce: BigInt(Date.now()) + 2n,
})

const hashes = {
  good: intentHashOf(good, CHAIN),
  expired: intentHashOf(expired, CHAIN),
  cancelled: intentHashOf(cancelled, CHAIN),
}
log(`good      ${hashes.good}`)
log(`expired   ${hashes.expired} (ended ${now - (now - 3600n)}s ago)`)
log(`cancelled ${hashes.cancelled}`)

await write(
  makerWallet,
  {
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'cancel',
    args: [toStruct(cancelled)],
  },
  'the maker cancelled the third intent',
)

// Ask the contract what it thinks of each one before spending anything on the batch.
const REASONS = [
  'Ok',
  'BadTerms',
  'NotStarted',
  'Expired',
  'Cancelled',
  'NonceTooLow',
  'WrongExecutor',
  'NothingToFill',
  'TooMuch',
  'PartialNotAllowed',
  'EscrowShort',
  'BadSignature',
  'FeeTooHigh',
]
for (const [label, i] of [
  ['good', good],
  ['expired', expired],
  ['cancelled', cancelled],
] as const) {
  const r = (await pub.readContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'fillability',
    // Unbounded on the fee: this probe asks whether the intent is live, not whether it is
    // worth filling. A bound would fold `FeeTooHigh` into an answer about the clock.
    args: [toStruct(i), i.signature, AMOUNT_IN, executor.address, (1n << 256n) - 1n],
  })) as number
  const want = label === 'good' ? 'Ok' : label === 'expired' ? 'Expired' : 'Cancelled'
  must(REASONS[r] === want, `the contract reads the ${label} intent as ${REASONS[r]}`)
}

const fills = [good, expired, cancelled].map((intent) => ({ intent, take: AMOUNT_IN }))
// The bound covers every leg, so a dearer intent in the batch is not stepped over silently.
const maxFeeRate = boundFor(fills.map((f) => f.intent))

head('without skipInvalid the batch must die')
let died = 'it went through'
try {
  const strict = callFor({ mode: 'batch', fills, maxFeeRate, skipInvalid: false }, CHAIN)
  await pub.simulateContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: strict.functionName,
    args: strict.args,
    account: executor,
  } as never)
} catch (e) {
  died = (e as Error).message.includes('Expired') ? 'Expired' : redact((e as Error).message)
}
must(died === 'Expired', `strict batch reverts with ${died.split('\n')[0]}`)

head('with skipInvalid it settles the one that works')
const call = callFor({ mode: 'batch', fills, maxFeeRate, skipInvalid: true }, CHAIN)
must(call.functionName === 'fillBatch', `the SDK builds ${call.functionName}`)

const makerIn = await balanceOf(IN, maker.address)
const makerOut = await balanceOf(OUT, maker.address)

const { receipt, result } = await write(
  executorWallet,
  { address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: call.functionName, args: call.args },
  'batch filled',
)
must(result === 1n, `the batch reports ${result} of 3 legs settled`)
must(receipt.status === 'success', 'and it did not revert')

const at = (await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp
// The maker no longer receives what they signed for. The fee comes out of the signed number, so
// the floor to check against is `delivered`, and `gross` is only the executor's outlay.
const { gross, delivered: owed } = quote(good, AMOUNT_IN, at)
const got = (await balanceOf(OUT, maker.address)) - makerOut
must(
  got >= owed,
  `the maker received ${show(OUT, got)}; the fill owed them ${show(OUT, owed)} out of a signed ${show(OUT, gross)}`,
)
must(
  makerIn - (await balanceOf(IN, maker.address)) === AMOUNT_IN,
  `exactly one leg's ${show(IN, AMOUNT_IN)} left the maker`,
)

const booked = async (h: Hex) =>
  (await pub.readContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'filled',
    args: [h],
  })) as bigint
must((await booked(hashes.good)) === AMOUNT_IN, 'the good intent is booked as filled')
must((await booked(hashes.expired)) === 0n, 'the expired intent is untouched')
must((await booked(hashes.cancelled)) === 0n, 'the cancelled intent is untouched')

// One `Filled` event, not three: the skipped legs must leave no trace on chain either.
const filledTopic = receipt.logs.filter(
  (l) => l.address.toLowerCase() === SETTLEMENT.toLowerCase() && l.topics[1] === hashes.good,
)
must(filledTopic.length >= 1, 'the good intent emitted its Filled event')
must(
  !receipt.logs.some((l) => l.topics[1] === hashes.expired || l.topics[1] === hashes.cancelled),
  'the skipped legs emitted nothing'
)

finish('batch with skipInvalid')

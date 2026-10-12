/**
 * The rung a redeploy cannot orphan, on chain 943.
 *
 *   DEPLOYER_PK=<the testnet deployer key> npx tsx scripts/e2e/permit2.ts
 *
 * Every other wallet rung points a maker's approval at `ProveRelayer`, which the settlement's
 * constructor creates — so a settlement redeploy moves it and every standing approval on the
 * chain points at a dead contract. That happened on 943 on 2026-08-27 and again on 2026-08-28,
 * and both times every maker had to approve again.
 *
 * A permit2 maker approves Permit2 instead: one address, the same on every chain, that no
 * redeploy of ours moves. Then they sign one short-lived transfer per intent. This run proves
 * the whole of that on the live chain rather than against a mock:
 *
 *   - the maker's ONLY approval is to Permit2, and they have granted our relayer nothing;
 *   - the intent and the transfer both verify, and `fillWithPermit2` settles them together;
 *   - the transfer's nonce is welded to the intent, so the same signature cannot fund another;
 *   - a spent nonce cannot be replayed, which is what makes the rung single-use.
 *
 * The mock in `test/Mocks.sol` reimplements Permit2 faithfully — same type hashes, same
 * version-less domain, same nonce bitmap — but a reimplementation is not the authority. This is
 * the deployed contract at 0x000000000022D473030F116dDEE9F6B43aC78BA3 answering for itself.
 */
import { encodeFunctionData, maxUint256, parseAbi, parseEther, type Hex } from 'viem'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  FLAG_PERMIT2,
  SETTLEMENT_ABI,
  ZERO,
  ZERO_HASH,
  callFor,
  signingDomain,
  intentHashOf,
  permit2Allowance,
  permit2Domain,
  permit2Request,
  permit2Target,
  quote,
  verifyIntent,
  type Intent,
  type SignedIntent,
  signIntent,
} from '@prove.cash/sdk'
import {
  CHAIN,
  FEE_RATE,
  boundFor,
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
  show,
  token,
  topUpGas,
  topUpToken,
  units,
  walletFor,
} from './common.js'

/** The settlement's own ABI, so the call this run sends is the call the SDK built. */
const encodeCall = (call: { functionName: string; args: readonly unknown[] }): Hex =>
  encodeFunctionData({ abi: SETTLEMENT_ABI as never, functionName: call.functionName, args: call.args } as never)

const IN = token('tPLSX')
const OUT = token('tUSDC')
const AMOUNT_IN = units(IN, '40')
const MIN_OUT = units(OUT, '1')

const maker = derive('prove.cash/e2e/permit2-maker')
const executor = derive('prove.cash/e2e/executor')

const ERC20 = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const approve = (spender: `0x${string}`, amount: bigint) =>
  encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] })

head('Permit2 itself')
const PERMIT2 = await permit2Target({ chainId: CHAIN })
const code = await pub.getCode({ address: PERMIT2 })
must(!!code && code.length > 2, `Permit2 has code at ${PERMIT2}`)
must(
  PERMIT2.toLowerCase() === '0x000000000022d473030f116ddee9f6b43ac78ba3',
  'and it is the canonical deployment, read off the relayer rather than assumed',
)
const d = await permit2Domain(CHAIN)
must(!('version' in d), 'its domain carries no version string, which is what Permit2 does')

head('setup')
log(`maker    ${maker.address}`)
log(`executor ${executor.address}`)
await topUpGas(maker.address, parseEther('0.5'), 'permit2 maker')
await topUpGas(executor.address, parseEther('0.2'), 'permit2 executor')
await topUpToken(IN, maker.address, AMOUNT_IN, 'permit2 maker')
await topUpToken(OUT, executor.address, MIN_OUT * 3n, 'permit2 executor')

const makerWallet = walletFor(maker)
const execWallet = walletFor(executor)

// The one transaction a maker on this rung ever sends, and the only durable thing anywhere.
if ((await permit2Allowance(maker.address, IN.address, CHAIN)) < AMOUNT_IN) {
  await send(
    makerWallet,
    { to: IN.address, data: approve(PERMIT2, maxUint256) },
    'the maker approved Permit2 — once, for good',
  )
}
const execAllowance = await pub.readContract({
  address: OUT.address,
  abi: ERC20,
  functionName: 'allowance',
  args: [executor.address, RELAYER],
})
if (execAllowance < MIN_OUT * 3n) {
  await send(
    execWallet,
    { to: OUT.address, data: approve(RELAYER, MIN_OUT * 100n) },
    'executor approved the relayer for token B',
  )
}

const relayerAllowance = await pub.readContract({
  address: IN.address,
  abi: ERC20,
  functionName: 'allowance',
  args: [maker.address, RELAYER],
})
must(relayerAllowance === 0n, 'the maker has granted OUR relayer nothing at all')
must(
  (await permit2Allowance(maker.address, IN.address, CHAIN)) >= AMOUNT_IN,
  'their whole on-chain footprint is the Permit2 approval',
)

head('the maker signs twice and sends nothing more')
const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
const intent: Intent = {
  maker: maker.address,
  recipient: maker.address,
  tokenIn: IN.address,
  tokenOut: OUT.address,
  amountIn: AMOUNT_IN,
  minOutStart: MIN_OUT,
  minOutEnd: MIN_OUT,
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
  // Zero, so the transfer's nonce is the intent's own hash. That weld is what stops one
  // signature funding a different offer.
  authNonce: ZERO_HASH,
  flags: FLAG_PARTIAL | FLAG_PERMIT2,
  nonce: BigInt(Date.now()),
}
must((intent.flags & FLAG_PERMIT2) !== 0, 'the intent carries the permit2 flag')
must((intent.flags & 2) === 0, 'and no escrow flag: nothing is committed until the fill')

const signature = await signIntent(maker, intent, { domain: signingDomain(CHAIN) })
const hash = intentHashOf(intent, CHAIN)
const deadline = intent.endTime
const req = await permit2Request(IN.address, AMOUNT_IN, BigInt(hash), deadline, CHAIN)
must(
  String(req.message.spender).toLowerCase() === RELAYER.toLowerCase(),
  'the transfer names the relayer as spender, never the settlement',
)
must(req.message.nonce === BigInt(hash), "and its nonce is the intent's own hash")

// Signed by the local account, not through the wallet client.
//
// `signPermit2` takes an `Address`, which is right for a browser wallet: viem sees a bare address
// as a JSON-RPC account and asks the provider to sign. Against a plain HTTP transport that
// provider is the node, and a node does not implement `eth_signTypedData_v4` — the run died on
// "Method not found" after doing all its setup. So a script holding a key signs with the key,
// exactly as the permit exercise does.
const transfer = {
  token: IN.address,
  amount: AMOUNT_IN,
  deadline,
  signature: await maker.signTypedData(req),
}
const signed: SignedIntent = { ...intent, signature, permit2: transfer }
must(await verifyIntent(signed, CHAIN), "the maker's intent signature verifies")

head('an executor fills it')
const makerIn = await balanceOf(IN, maker.address)
const makerOut = await balanceOf(OUT, maker.address)
log(`maker holds ${show(IN, makerIn)} and ${show(OUT, makerOut)}`)

const reason = await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'fillability',
  args: [signed as never, signature, AMOUNT_IN, executor.address, maxUint256],
})
log(`unarmed, the chain reads reason ${reason} — a leg with nothing pulled yet is short`)

// Built by the SDK, not hand-rolled here, so this proves the path a real client takes. The
// permit2 rung had no mode of its own until now: the contract carried `fillWithPermit2` and
// `callFor` could not reach it, so the rung was only fillable inside a batch while permit and
// authorization each had their own door. That asymmetry is the thing this project keeps
// refusing, and a run that hand-encoded the call would have hidden it.
const call = callFor(
  { mode: 'permit2', fills: [{ intent: signed, take: AMOUNT_IN }], maxFeeRate: boundFor([intent]) },
  CHAIN,
)
must(call.functionName === 'fillWithPermit2', 'the SDK builds fillWithPermit2')
await send(
  execWallet,
  { to: SETTLEMENT, data: encodeCall(call) },
  'filled through fillWithPermit2',
)

head('what moved')
const makerInAfter = await balanceOf(IN, maker.address)
const makerOutAfter = await balanceOf(OUT, maker.address)
log(`maker paid     ${show(IN, makerIn - makerInAfter)}`)
log(`maker received ${show(OUT, makerOutAfter - makerOut)}`)
must(makerIn - makerInAfter === AMOUNT_IN, 'the maker paid exactly what they signed for')
/*
 * Not `MIN_OUT`. That is the gross the intent signs and the fee comes out of it, so the maker
 * receives less. The curve here is flat — `minOutStart` and `minOutEnd` are both `MIN_OUT` — so
 * the timestamp this is priced at cannot change the answer.
 */
const { delivered: makerFloor } = quote(intent, AMOUNT_IN, now)
must(
  makerOutAfter - makerOut >= makerFloor,
  `and received at least the ${show(OUT, makerFloor)} left of ${show(OUT, MIN_OUT)} after the fee`,
)
must(
  (await pub.readContract({
    address: IN.address,
    abi: ERC20,
    functionName: 'allowance',
    args: [maker.address, RELAYER],
  })) === 0n,
  'and STILL has no allowance to our relayer — nothing durable points at us',
)

head('the signature is spent, not reusable')
let replayed = false
try {
  await pub.call({ to: SETTLEMENT, data: encodeCall(call), account: executor.address })
  replayed = true
} catch {
  /* Permit2 spends the nonce once, which is the point */
}
must(!replayed, 'the same transfer cannot fund a second fill')

console.log(
  failureCount() === 0
    ? '\nthe permit2 rung works against the deployed Permit2, on chain 943.\n'
    : `\n${failureCount()} failure(s)\n`,
)
process.exit(failureCount() === 0 ? 0 : 1)

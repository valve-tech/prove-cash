/**
 * M4 of the 2026-09-30 app review, on the lab: the fill tray and a Permit2 offer.
 *
 *   eval "$(app/scripts/lab/up.sh --quiet)"; npx tsx scripts/lab/permit2-tray.ts
 *
 * The tray once sent a lone Permit2 leg through `direct`. A maker on this rung grants our relayer
 * nothing, so that call can only revert. This signs the offer the sign form signs, asks the chain
 * about `direct`, and then about `permit2`, which the tray now picks.
 */
import { encodeFunctionData, maxUint256, parseAbi, parseEther, type Hex } from 'viem'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  FLAG_PERMIT2,
  SETTLEMENT_ABI,
  ZERO_HASH,
  callFor,
  intentHashOf,
  permit2Request,
  permit2Target,
  signingDomain,
  type FillMode,
  type Intent,
  type SignedIntent,
  signIntent,
} from '@prove.cash/sdk'
import {
  CHAIN,
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
import { describe } from '../rpc.ts'

const encodeCall = (call: { functionName: string; args: readonly unknown[] }): Hex =>
  encodeFunctionData({ abi: SETTLEMENT_ABI as never, functionName: call.functionName, args: call.args } as never)

const IN = token('tPLSX')
const OUT = token('tUSDC')
const AMOUNT_IN = units(IN, '40')
const MIN_OUT = units(OUT, '1')
const maker = derive('prove.cash/lab/permit2-tray-maker')
const executor = derive('prove.cash/lab/permit2-tray-executor')
const ERC20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])
const approve = (spender: Hex, amount: bigint) =>
  encodeFunctionData({ abi: ERC20, functionName: 'approve', args: [spender, amount] })

head('setup')
const PERMIT2 = await permit2Target({ chainId: CHAIN })
await topUpGas(maker.address, parseEther('0.5'), 'maker')
await topUpGas(executor.address, parseEther('0.2'), 'executor')
await topUpToken(IN, maker.address, AMOUNT_IN, 'maker')
await topUpToken(OUT, executor.address, MIN_OUT * 3n, 'executor')
await send(walletFor(maker), { to: IN.address, data: approve(PERMIT2, maxUint256) }, 'maker approved Permit2 only')
await send(walletFor(executor), { to: OUT.address, data: approve(RELAYER, MIN_OUT * 100n) }, 'executor approved the relayer')

head('a Permit2 offer, signed as the sign form signs it')
const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
const intent: Intent = {
  maker: maker.address,
  recipient: maker.address,
  tokenIn: IN.address,
  tokenOut: OUT.address,
  amountIn: AMOUNT_IN,
  minOutStart: MIN_OUT,
  minOutEnd: MIN_OUT,
  curve: CURVE_LINEAR,
  startTime: now - 60n,
  endTime: now - 60n + 3600n,
  executor: '0x0000000000000000000000000000000000000000',
  // No fee: a fresh lab registers no fee sink, and an unregistered `feeTo` is BadTerms.
  feeConfig: ZERO_HASH,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  feeRate: 0n,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: FLAG_PARTIAL | FLAG_PERMIT2,
  nonce: BigInt(Date.now()),
}
const signature = await signIntent(maker, intent, { domain: signingDomain(CHAIN) })
const req = await permit2Request(IN.address, AMOUNT_IN, BigInt(intentHashOf(intent, CHAIN)), intent.endTime, CHAIN)
const signed: SignedIntent = {
  ...intent,
  signature,
  permit2: { token: IN.address, amount: AMOUNT_IN, deadline: intent.endTime, signature: await maker.signTypedData(req) },
}

const callIn = (mode: FillMode) =>
  callFor({ mode, fills: [{ intent: signed, take: AMOUNT_IN }], maxFeeRate: 10n ** 18n }, CHAIN)
const simulate = async (mode: FillMode) => {
  const call = callIn(mode)
  try {
    await pub.call({ to: SETTLEMENT, data: encodeCall(call), account: executor.address })
    log(`${mode} -> ${call.functionName}: simulates OK`)
    return true
  } catch (e) {
    log(`${mode} -> ${call.functionName}: reverts: ${describe(e)}`)
    return false
  }
}

const onChainHash = await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'hashIntent',
  args: [intent as never],
})
log(`intent hash: sdk ${intentHashOf(intent, CHAIN).slice(0, 10)}…, chain ${String(onChainHash).slice(0, 10)}…`)

head('what the chain says')
must(!(await simulate('direct')), 'direct, the old tray mode, cannot settle a Permit2 offer')
must(await simulate('permit2'), 'permit2 settles it')
await send(walletFor(executor), { to: SETTLEMENT, data: encodeCall(callIn('permit2')) }, 'filled through fillWithPermit2')

console.log(failureCount() === 0 ? '\npermit2-tray: OK\n' : `\n${failureCount()} failure(s)\n`)
process.exit(failureCount() === 0 ? 0 : 1)

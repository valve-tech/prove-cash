/**
 * The other gasless path, on chain 943: an EIP-2612 permit instead of an EIP-3009 authorization.
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK \
 *     npx tsx scripts/e2e/permit.ts
 *
 * The maker signs the intent, signs a permit letting the relayer move the tokens, and broadcasts
 * both over msgboard. An executor calls `fillWithPermit`, which sets the allowance from that
 * signature and fills in the same transaction. The maker sends nothing. A batch leg reaches the
 * same code by carrying the permit on its `arming` field.
 *
 * **This is the weaker rung and the run proves it rather than claiming it.** A permit grants a
 * reusable allowance, so the tokens stay in the maker's wallet and stay spendable — the run asserts
 * the intent carries no escrow flag and that nothing was reserved against it. EIP-3009 is stronger
 * and almost nothing implements it; EIP-2612 is what most tokens actually have.
 *
 * The claim worth testing is the front-run. `nonces` moves on every permit, so a stranger can
 * replay the maker's signed permit first and leave the executor's copy reverting on a stale nonce
 * — with the allowance already set. If that cost the fill, anybody could stop every gasless fill
 * on the board for the price of gas. So the run does exactly that, on purpose, before filling.
 * The settlement asks for a permit only when the allowance falls short, so the stranger's copy is
 * what carries the fill and the token is never called.
 */
import { encodeFunctionData, formatUnits, parseAbi, parseEther, type Hex } from 'viem'
import { MsgBoardClient, type Provider } from '@msgboard/sdk'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  PROVECASH_CATEGORY,
  SETTLEMENT_ABI,
  ZERO,
  ZERO_HASH,
  callFor,
  decodeIntent,
  signingDomain,
  encodeIntent,
  grindAndSubmit,
  intentHashOf,
  permitRequest,
  quote,
  splitPermit,
  supportsPermit,
  verifyIntent,
  type Intent,
  type SignedIntent,
  signIntent,
} from '@prove.cash/sdk'
import {
  boundFor,
  CHAIN,
  FEE_RATE,
  FEE_CONFIG,
  RELAYER,
  SETTLEMENT,
  balanceOf,
  derive,
  failureCount,
  gasBurned,
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

const IN = token('tPLSX')
const OUT = token('tUSDC')
const AMOUNT_IN = units(IN, '80')
const MIN_OUT = units(OUT, '2')

const maker = derive('prove.cash/e2e/permit-maker')
const executor = derive('prove.cash/e2e/executor')
const stranger = derive('prove.cash/e2e/permit-stranger')

const ERC20 = parseAbi([
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function nonces(address owner) view returns (uint256)',
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
])

head('the token')
must(await supportsPermit(IN.address), `${IN.symbol} answers nonces and DOMAIN_SEPARATOR`)

head('setup')
log(`maker    ${maker.address}`)
log(`executor ${executor.address}`)
await topUpGas(executor.address, parseEther('0.2'), 'permit executor')
await topUpToken(IN, maker.address, AMOUNT_IN, 'permit maker')
await topUpToken(OUT, executor.address, MIN_OUT * 2n, 'permit executor')

// The executor pays token B through the relayer, exactly as any other fill.
const execWallet = walletFor(executor)
const execAllowance = await pub.readContract({
  address: OUT.address, abi: ERC20, functionName: 'allowance', args: [executor.address, RELAYER],
})
if (execAllowance < MIN_OUT * 2n) {
  await send(
    execWallet,
    {
      to: OUT.address,
      data: encodeApprove(RELAYER, MIN_OUT * 100n),
    },
    'executor approved the relayer for token B',
  )
}

// The maker grants nothing. That is the point of the rung.
const before = {
  nonce: await pub.getTransactionCount({ address: maker.address }),
  pls: await pub.getBalance({ address: maker.address }),
  allowance: await pub.readContract({
    address: IN.address, abi: ERC20, functionName: 'allowance', args: [maker.address, RELAYER],
  }),
}
must(before.allowance === 0n, 'the maker has granted the relayer nothing')

head('the maker signs twice and sends nothing')
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
  authNonce: ZERO_HASH,
  // No FLAG_ESCROW. A permit is an allowance, and an allowance is the wallet rung.
  flags: FLAG_PARTIAL,
  nonce: BigInt(Date.now()),
}
must((intent.flags & 2) === 0, 'the intent carries no escrow flag')

const signature = await signIntent(maker, intent, { domain: signingDomain(CHAIN) })
const deadline = intent.endTime
const permitReq = await permitRequest(maker.address, IN.address, AMOUNT_IN, deadline, CHAIN)
must(
  String(permitReq.message.spender).toLowerCase() === RELAYER.toLowerCase(),
  'the permit names the relayer, never the settlement',
)
const permitSig = await maker.signTypedData(permitReq)
const signed: SignedIntent = {
  ...intent,
  signature,
  permit: { value: AMOUNT_IN, deadline, signature: permitSig },
}

head('both go over the board')
const data = encodeIntent(signed)
log(`packed · ${(data.length - 2) / 2} bytes, intent and permit together`)
const msgboard = new MsgBoardClient(pub as unknown as Provider, {})
const { hash: boardHash, recovered } = await grindAndSubmit(msgboard, PROVECASH_CATEGORY, data)
log(`broadcast · ${boardHash}${recovered ? ' (the RPC lied; the board had it)' : ''}`)
const readBack = decodeIntent(data)
must(!!readBack, 'it decodes')
must(!!readBack?.permit, 'and the permit survived the round trip')
must(await verifyIntent(readBack!, CHAIN), "the maker's signature verifies off the wire")

head('a stranger front-runs the permit, on purpose')
const nonceBefore = await pub.readContract({
  address: IN.address, abi: ERC20, functionName: 'nonces', args: [maker.address],
})
await topUpGas(stranger.address, parseEther('0.05'), 'permit stranger')
const p = splitPermit(signed.permit!)
await send(
  walletFor(stranger),
  { to: IN.address, data: encodePermit(maker.address, RELAYER, p) },
  'the stranger submitted the maker\'s permit',
)
const nonceAfter = await pub.readContract({
  address: IN.address, abi: ERC20, functionName: 'nonces', args: [maker.address],
})
must(nonceAfter > nonceBefore, 'the permit nonce moved, so the signature is now stale')
const allowanceNow = await pub.readContract({
  address: IN.address, abi: ERC20, functionName: 'allowance', args: [maker.address, RELAYER],
})
must(allowanceNow >= AMOUNT_IN, 'and the allowance is set all the same')

head('the executor fills anyway')
const call = callFor(
  // The bound was a flat 50 basis points, which is above anything the owner may set and above
  // anything this intent asks. It reads the chain now, so the script fails on a repricing rather
  // than paying it without noticing.
  { mode: 'permit', fills: [{ intent: signed, take: AMOUNT_IN }], maxFeeRate: boundFor([intent]) },
  CHAIN,
)
must(call.functionName === 'fillWithPermit', 'the SDK builds fillWithPermit')
const makerOutBefore = await balanceOf(OUT, maker.address)
await send(
  execWallet,
  { to: SETTLEMENT, data: encodeCall(call) },
  'filled with a permit the stranger already spent',
)

head('the assertions')
// The maker no longer receives what they signed for. The fee comes out of the signed number, so
// the floor to check against is `delivered`, and `gross` is only the executor's outlay.
const { gross, delivered: owed } = quote(intent, AMOUNT_IN, now)
const got = (await balanceOf(OUT, maker.address)) - makerOutBefore
must(
  got >= owed,
  `the maker received ${show(OUT, got)}; the fill owed them ${show(OUT, owed)} out of a signed ${show(OUT, gross)}`,
)
must((await balanceOf(IN, maker.address)) === 0n, `${show(IN, AMOUNT_IN)} left the maker`)
must(
  (await pub.getTransactionCount({ address: maker.address })) === before.nonce,
  `the maker's transaction count is unchanged: ${before.nonce} before, ${before.nonce} after`,
)
must(
  (await pub.getBalance({ address: maker.address })) === before.pls,
  'the maker\'s PLS balance is unchanged',
)
const reserved = await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'reserved',
  args: [intentHashOf(intent, CHAIN)],
})
must(reserved === 0n, 'nothing was ever escrowed — this is the wallet rung, and it says so')

log('')
log(`${formatUnits(gasBurned(), 18)} PLS of gas burned by this run`)
console.log(
  failureCount() === 0
    ? '\npermit fill: every assertion held, on chain 943.'
    : `\npermit fill: ${failureCount()} assertion(s) failed.`,
)
process.exit(failureCount() === 0 ? 0 : 1)

// ── Encoding helpers ──────────────────────────────────────────────────────────

function encodeApprove(spender: `0x${string}`, amount: bigint): Hex {
  return encodeFn(ERC20, 'approve', [spender, amount])
}

function encodePermit(
  owner: `0x${string}`,
  spender: `0x${string}`,
  p: { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex },
): Hex {
  return encodeFn(ERC20, 'permit', [owner, spender, p.value, p.deadline, p.v, p.r, p.s])
}

function encodeCall(call: { functionName: string; args: readonly unknown[] }): Hex {
  return encodeFn(SETTLEMENT_ABI, call.functionName, call.args)
}

function encodeFn(abi: unknown, functionName: string, args: readonly unknown[]): Hex {
  return encodeFunctionData({ abi: abi as never, functionName, args } as never)
}

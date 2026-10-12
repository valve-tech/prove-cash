/**
 * The whole system against a local fork of mainnet: real WPLS, real PLSX, the real PulseX
 * router, our contracts freshly deployed, and no faucet, no testnet, no stuck nonces.
 *
 *   anvil --fork-url https://one.valve.city/rpc/vk_demo/evm/369 \
 *         --fork-block-number 27260000 --port 8545 --silent &
 *   cd contracts && PROVE_OWNER=0xf39F…2266 \
 *     forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
 *     --private-key 0xac09…ff80
 *   cd app && SETTLEMENT=0x… npx tsx scripts/devnet.ts
 *
 * This exercises the parts a Solidity test cannot: the TypeScript codec, the EIP-712 domain the
 * app actually signs with, the quote maths the executor bot uses to decide, and the profitability
 * rule itself — priced against a real pool rather than a number I invented.
 *
 * The board is not part of a fork, so this covers chain-side behaviour only. `e2e-testnet.ts`
 * covers the board.
 */
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatUnits,
  http,
  maxUint256,
  parseAbi,
  parseEther,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { pulsechain } from 'viem/chains'
import {
  breakpointsOf,
  CURVE_LINEAR,
  KIND_STRETCH,
  stretchCurve,
  FLAG_PARTIAL,
  SETTLEMENT_ABI,
  ZERO,
  ZERO_HASH,
  decodeIntent,
  encodeIntent,
  maxFeeRateFor,
  minOutAt,
  quote as quoteFill,
  setSettlementOverride,
  verifyIntent,
  type Intent,
  type SignedIntent,
  signIntent,
  toStruct,
  intentDigest,
} from '@prove.cash/sdk'
import { assertChainId } from './rpc.ts'

const RPC = process.env.RPC ?? 'http://127.0.0.1:8545'
const SETTLEMENT = process.env.SETTLEMENT as Address | undefined
if (!SETTLEMENT) throw new Error('SETTLEMENT is required (from the forge script output)')

const WPLS: Address = '0xA1077a294dDE1B09bB078844df40758a5D0f9a27'
const PLSX: Address = '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab'
const ROUTER: Address = '0x165C3410fC91EF562C50559f7d2289fEbed552d9'

// Anvil's first two accounts.
const MAKER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const EXEC_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

const wplsAbi = parseAbi(['function deposit() payable'])
const routerAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
])

const pub = createPublicClient({ chain: pulsechain, transport: http(RPC) })

// The node has to be on this chain. `RPC` replaces the whole URL while the chain id beside it
// stays put, so the two can silently disagree and every read comes back about somewhere else.
await assertChainId(pub, pulsechain.id)

const maker = privateKeyToAccount(MAKER_PK)
const executor = privateKeyToAccount(EXEC_PK)
const makerWallet = createWalletClient({ account: maker, chain: pulsechain, transport: http(RPC) })
const execWallet = createWalletClient({ account: executor, chain: pulsechain, transport: http(RPC) })

const log = (m: string) => console.log(`  ${m}`)
const ok = (label: string, pass: boolean, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ' · ' + detail : ''}`)
  if (!pass) failures++
}
let failures = 0
const wait = (hash: Hex) => pub.waitForTransactionReceipt({ hash })

// Point the app's own registry at this fork, so `domain()` and `verifyIntent()` agree with what
// we deployed. Without this the app signs against one address and verifies against another.
setSettlementOverride(369, SETTLEMENT)

/** The app's EIP-712 domain, resolved through the registry we just overrode. */
const localDomain = {
  name: 'prove.cash',
  version: '1',
  chainId: 369,
  verifyingContract: SETTLEMENT,
} as const

const AMOUNT_IN = parseEther('1000000') // 1M WPLS

console.log('\nsetup, on a fork of mainnet')

// A devnet can simply say how much money exists. No faucet, no begging, no stuck nonce.
for (const who of [maker.address, executor.address]) {
  await pub.request({
    method: 'anvil_setBalance' as never,
    params: [who, '0x' + parseEther('20000000').toString(16)] as never,
  })
}
log('funded both accounts with 20,000,000 PLS')
await wait(
  await makerWallet.writeContract({ address: WPLS, abi: wplsAbi, functionName: 'deposit', value: AMOUNT_IN }),
)
log(`maker wrapped ${formatUnits(AMOUNT_IN, 18)} PLS`)

// The executor stocks up the way a real one would: buy the output token from the pool.
await wait(
  await execWallet.writeContract({ address: WPLS, abi: wplsAbi, functionName: 'deposit', value: parseEther('5000000') }),
)
await wait(
  await execWallet.writeContract({ address: WPLS, abi: erc20Abi, functionName: 'approve', args: [ROUTER, maxUint256] }),
)
await wait(
  await execWallet.writeContract({
    address: ROUTER,
    abi: routerAbi,
    functionName: 'swapExactTokensForTokens',
    args: [parseEther('5000000'), 0n, [WPLS, PLSX], executor.address, BigInt(Math.floor(Date.now() / 1000) + 600)],
  }),
)
const execPlsx = await pub.readContract({ address: PLSX, abi: erc20Abi, functionName: 'balanceOf', args: [executor.address] })
log(`executor bought ${formatUnits(execPlsx, 18)} PLSX from the real pool`)

await wait(await makerWallet.writeContract({ address: WPLS, abi: erc20Abi, functionName: 'approve', args: [SETTLEMENT, maxUint256] }))
await wait(await execWallet.writeContract({ address: PLSX, abi: erc20Abi, functionName: 'approve', args: [SETTLEMENT, maxUint256] }))

// ── The market decides the terms, not me ─────────────────────────────────────
const marketOut = (
  await pub.readContract({ address: ROUTER, abi: routerAbi, functionName: 'getAmountsOut', args: [AMOUNT_IN, [WPLS, PLSX]] })
)[1]
const EDGE_BPS = 300n
const minOut = (marketOut * (10_000n - EDGE_BPS)) / 10_000n

console.log('\nterms priced off the pool')
log(`market pays ${formatUnits(marketOut, 18)} PLSX for ${formatUnits(AMOUNT_IN, 18)} WPLS`)
log(`the maker asks ${formatUnits(minOut, 18)}, conceding ${EDGE_BPS} bps`)

const now = BigInt((await pub.getBlock()).timestamp)
const intent: Intent = {
  maker: maker.address,
  recipient: maker.address,
  tokenIn: WPLS,
  tokenOut: PLSX,
  amountIn: AMOUNT_IN,
  minOutStart: minOut,
  minOutEnd: minOut,
  // A straight line across the whole window: kind 0, and the word it reads none of.
  curve: CURVE_LINEAR,
  startTime: now,
  endTime: now + 3600n,
  executor: ZERO,
  feeConfig: ZERO_HASH,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  // Zero: no opinion, so the fill charges the owner's floor. This script exercises a fill
  // path and not a rate.
  feeRate: 0n,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: FLAG_PARTIAL,
  nonce: BigInt(Date.now()),
}
const signature = await signIntent(maker, intent, { domain: localDomain })
const signed: SignedIntent = { ...intent, signature }

// The executor names the rate it agreed to. The intent signs its own and nothing on chain can
// raise it, so the bound comes out of the intent rather than off the chain.
const FEE_CAP = maxFeeRateFor([intent])

console.log('\nchecks')

// 1. The codec round-trips and the signature survives it.
const decoded = decodeIntent(encodeIntent(signed))
ok('codec round-trips the intent', !!decoded)
ok('signature verifies after the round trip', !!decoded && (await verifyIntent(decoded, 369)))

// 2. The TypeScript hash equals the contract's.
const onChainHash = (await pub.readContract({
  address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: 'hashIntent', args: [toStruct(intent)],
})) as Hex
const offChainHash = intentDigest(intent, localDomain)
ok('typescript hash equals the contract hash', onChainHash.toLowerCase() === offChainHash.toLowerCase())

// 3. The app's quote maths equals the contract's, at several splits — both halves of it. One
//    number is no longer enough: the contract returns what the maker gets and what the fee
//    destination gets, and a copy that agreed on the first and not the second would ship.
for (const frac of [1n, 3n, 7n]) {
  const take = AMOUNT_IN / frac
  const q1 = (await pub.readContract({
    address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: 'quote', args: [toStruct(intent), take, now],
  })) as unknown as { delivered: bigint; feeOut: bigint; feeProceeds: bigint }
const [delivered, legFee] = [q1.delivered, q1.feeOut + q1.feeProceeds]
  const mine = quoteFill(intent, take, now)
  ok(`quote agrees at a ${frac === 1n ? 'full' : `1/${frac}`} fill`,
     mine.delivered === delivered && mine.fee === legFee,
     `${formatUnits(delivered, 18)} PLSX to the maker, ${formatUnits(legFee, 18)} to the destination`)
}
ok('rate curve agrees', minOutAt(intent, now) === (await pub.readContract({
  address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: 'minOutAt', args: [toStruct(intent), now],
}) as bigint))

/*
 * 3b. The shape, against the contract that walks it.
 *
 * The intent above is flat, so every kind returns the same wei at every instant and a check on it
 * proves nothing about the stretch. This one decays and rests a quarter either side of its fall,
 * which is where the two readings can differ — and it is sampled at both breakpoints and inside
 * all three regions rather than only at the ends, because a two-point copy of a four-point curve
 * agrees at the ends and nowhere a maker reads.
 *
 * A live chain and a signed field, and nothing here mixes them: the shape is fixed in the word,
 * and `at` is the only thing that moves.
 */
const bent: Intent = {
  ...intent,
  minOutStart: (minOut * 11_000n) / 10_000n,
  minOutEnd: minOut,
  curve: stretchCurve(0.25, 0.25),
  flags: intent.flags | KIND_STRETCH,
  nonce: intent.nonce + 1n,
}
const span = bent.endTime - bent.startTime
const breaks = breakpointsOf(bent)
/*
 * Within a second of a quarter and a half, and not exactly on them.
 *
 * The format counts the window in 1/65,535ths, so a quarter rounds to 16,384 and then floors back
 * through the span: on an hour that is 899 seconds, not 900. The quantisation is the field's, it
 * is deterministic, and it is under a second on any window this app offers — so the check has to
 * allow it rather than pretend the fraction is exact.
 */
const near = (a: bigint, b: bigint) => (a > b ? a - b : b - a) <= 1n
ok(
  'the stretch names its own two turns',
  breaks.length === 2 &&
    near(breaks[0]!, bent.startTime + span / 4n) &&
    near(breaks[1]!, bent.startTime + span / 2n),
  breaks.map((b) => `+${b - bent.startTime}s`).join(' '),
)
for (const at of [
  bent.startTime,
  bent.startTime + span / 8n,
  breaks[0]!,
  bent.startTime + (span * 3n) / 8n,
  breaks[1]!,
  bent.startTime + (span * 3n) / 4n,
  bent.endTime,
]) {
  const theirs = (await pub.readContract({
    address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: 'minOutAt', args: [bent, at],
  })) as bigint
  ok(
    `the stretch agrees at +${at - bent.startTime}s`,
    minOutAt(bent, at) === theirs,
    formatUnits(theirs, 18),
  )
}

// 4. The fill actually pays, and the executor actually profits.
const q2 = (await pub.readContract({
  address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: 'quote', args: [toStruct(intent), AMOUNT_IN, now],
})) as unknown as { delivered: bigint; feeOut: bigint; feeProceeds: bigint }
const [delivered, fee] = [q2.delivered, q2.feeOut + q2.feeProceeds]
const makerBefore = await pub.readContract({ address: PLSX, abi: erc20Abi, functionName: 'balanceOf', args: [maker.address] })
const execBefore = await pub.readContract({ address: PLSX, abi: erc20Abi, functionName: 'balanceOf', args: [executor.address] })

const { request } = await pub.simulateContract({
  address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: 'fill',
  args: [toStruct(intent), signature, AMOUNT_IN, FEE_CAP], account: executor,
})
const receipt = await wait(await execWallet.writeContract(request))

const makerGot = (await pub.readContract({ address: PLSX, abi: erc20Abi, functionName: 'balanceOf', args: [maker.address] })) - makerBefore
const execPaid = execBefore - (await pub.readContract({ address: PLSX, abi: erc20Abi, functionName: 'balanceOf', args: [executor.address] }))
const execGotWpls = await pub.readContract({ address: WPLS, abi: erc20Abi, functionName: 'balanceOf', args: [executor.address] })

ok('the maker received their whole share of the signed number', makerGot >= delivered, `${formatUnits(makerGot, 18)} PLSX`)
ok('the executor paid the whole signed number, and it split in two', execPaid === delivered + fee)
ok('the executor took the whole amount', execGotWpls >= AMOUNT_IN)
ok('the executor is in profit at market', marketOut > delivered + fee,
   `+${formatUnits(marketOut - delivered - fee, 18)} PLSX`)
log(`gas ${receipt.gasUsed}`)

// 5. The intent is spent, and a replay is refused.
const filled = (await pub.readContract({ address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: 'filled', args: [onChainHash] })) as bigint
ok('the fill is booked', filled === AMOUNT_IN)
let replayed = false
try {
  await pub.simulateContract({ address: SETTLEMENT, abi: SETTLEMENT_ABI, functionName: 'fill',
    args: [toStruct(intent), signature, AMOUNT_IN, FEE_CAP], account: executor })
  replayed = true
} catch { /* expected */ }
ok('a replay is refused', !replayed)

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)

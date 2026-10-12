/**
 * The solver against a local fork of mainnet: real WPLS, real PLSX, real HEX, the real PulseX
 * router, our contracts freshly deployed, and makers who genuinely coincide.
 *
 *   anvil --fork-url https://one.valve.city/rpc/vk_demo/evm/369 \
 *         --fork-block-number 27260000 --port 8545 --silent &
 *   cd contracts && PROVE_OWNER=0xf39F…2266 \
 *     forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
 *     --private-key 0xac09…ff80
 *   cd app && SETTLEMENT=0x… npx tsx scripts/solver-devnet.ts
 *
 * Nothing here tells the solver what to do. It is handed a pile of signed intents — two that
 * coincide, several that do not, one that has expired — and it has to find the ring on its own,
 * size it, prove it to the chain, and settle it. Then the two things that actually matter get
 * asserted: both makers received at least their share of the rate they signed — the fee comes
 * out of that number now — and the solver ended in profit.
 *
 * Seven checks, in the order they would break:
 *
 *   1. The AMM curve computed here equals the router's own quote, both directions.
 *   2. The book keeps only what the chain says is fillable.
 *   3. The solver finds the two-intent ring unaided, and ranks it first.
 *   4. The ring settles. Both makers are paid. The solver profits. Gas is measured, not guessed.
 *   5. A ring that does not close yet: the solver predicts the second it will, the chain is
 *      moved to that second, and it settles there and not one second earlier.
 *   6. One intent plus the pool settles as two transactions and still ends in profit.
 *   7. Three makers close a triangle no two of them could close between them. The solver is given
 *      the pile with a decoy in it, finds the three-leg ring, and is then held to the working
 *      capital it reported: it starts the batch with exactly that and nothing more.
 *
 * The anvil keys below are the published test keys every anvil prints on startup. Nothing here
 * generates a key, and nothing here should ever be pointed at a network with real money.
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
  CURVE_LINEAR,
  FLAG_PARTIAL,
  ZERO,
  ZERO_HASH,
  signingDomain,
  maxFeeRateFor,
  setChainId,
  setRpc,
  setRpcLinked,
  setSettlementOverride,
  type Intent,
  type SignedIntent,
  signIntent,
  rememberFeeConfig,
  singleFeeConfig,
} from '@prove.cash/sdk'
import {
  SOLVER_SETTLEMENT_ABI,
  ensureApprovals,
  xykMarkets,
  executeRing,
  fillBatchCall,
  executeSwap,
  loadBook,
  loadPools,
  loadPrices,
  makersShortChanged,
  pairKey,
  poolAmountIn,
  poolAmountOut,
  poolKey,
  profitableFrom,
  ringDeadline,
  ringTokens,
  selectDisjoint,
  simulateRing,
  solve,
  upcoming,
  valueInNative,
  withSimulatedGas,
  type Plan,
  type Pool,
} from '@prove.cash/sdk/solver'
import { redact, assertChainId } from './rpc.ts'


/** A rate, as a fraction of one ether, printed in basis points. The contracts count in WAD now. */
const bps = (rate: bigint) => (rate * 10_000n) / 10n ** 18n

const RPC = process.env.RPC ?? 'http://127.0.0.1:8545'
if (!process.env.SETTLEMENT) throw new Error('SETTLEMENT is required (from the forge script output)')
const SETTLEMENT = process.env.SETTLEMENT as Address

const WPLS: Address = '0xA1077a294dDE1B09bB078844df40758a5D0f9a27'
const PLSX: Address = '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab'
// The third token of the triangle in check 7. It has eight decimals, so the ring has to survive
// a change of scale as well as a change of token.
const HEX: Address = '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39'
const ROUTER: Address = '0x165C3410fC91EF562C50559f7d2289fEbed552d9'
/** Where check 7 parks the solver's spare tokens. Nothing in this file can spend from it. */
const PARK: Address = '0x000000000000000000000000000000000000dEaD'

// Anvil's published accounts. Every anvil on earth prints these on startup.
const MAKER_A_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const MAKER_B_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex
const MAKER_C_PK = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' as Hex
const SOLVER_PK = '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' as Hex
const DECOY_PK = '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' as Hex

const wplsAbi = parseAbi(['function deposit() payable'])
const routerAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])',
  'function getAmountsIn(uint256 amountOut, address[] path) view returns (uint256[])',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
])

const pub = createPublicClient({ chain: pulsechain, transport: http(RPC) })

// The node has to be on this chain. `RPC` replaces the whole URL while the chain id beside it
// stays put, so the two can silently disagree and every read comes back about somewhere else.
await assertChainId(pub, pulsechain.id)

const makerA = privateKeyToAccount(MAKER_A_PK)
const makerB = privateKeyToAccount(MAKER_B_PK)
const makerC = privateKeyToAccount(MAKER_C_PK)
const solverAccount = privateKeyToAccount(SOLVER_PK)
const decoy = privateKeyToAccount(DECOY_PK)
const walletFor = (account: typeof makerA) =>
  createWalletClient({ account, chain: pulsechain, transport: http(RPC) })
const makerAWallet = walletFor(makerA)
const makerBWallet = walletFor(makerB)
const makerCWallet = walletFor(makerC)
const solverWallet = walletFor(solverAccount)
const decoyWallet = walletFor(decoy)

let failures = 0
const log = (m: string) => console.log(`  ${m}`)
const ok = (label: string, pass: boolean, detail = '') => {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ' · ' + detail : ''}`)
  if (!pass) failures++
}
/**
 * Wait for a transaction, and refuse to carry on when it reverted.
 *
 * A receipt with a failed status is still a receipt. Letting setup continue past one turns a
 * clear "the swap reverted" into an unrelated failure six checks later, which is the worst way
 * to spend an hour.
 */
const wait = async (hash: Hex) => {
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted during setup`)
  return receipt
}

/** Replay a reverted batch at the block before it, so a failure says what the chain objected to. */
async function explain(plan: Plan, blockNumber: bigint) {
  const call = fillBatchCall(SETTLEMENT, plan.fills, plan.maxFeeRate)
  try {
    await pub.simulateContract({
      account: solverAccount.address,
      address: call.address,
      abi: SOLVER_SETTLEMENT_ABI,
      functionName: 'fillBatch',
      args: call.args as never,
      blockNumber: blockNumber - 1n,
    })
    log('replaying it at the previous block succeeds — the batch ran out of gas, not out of terms')
  } catch (e) {
    // Through `redact`, never raw. viem builds its message out of `metaMessages`, one of
    // which is the whole request URL with the registry key in its path — that is how 1,596
    // journal lines came to carry it. This was the last line in `scripts/` that skipped it.
    log(`the chain objected: ${redact((e as Error).message ?? '').split('\n').slice(0, 3).join(' / ')}`)
  }
}
const wpls = (x: bigint) => `${formatUnits(x, 18)} WPLS`
const plsx = (x: bigint) => `${formatUnits(x, 18)} PLSX`
const hex = (x: bigint) => `${formatUnits(x, 8)} HEX`
/** Whichever of the three the amount is in. Check 7 does not know until the solver has ranked. */
const amountOf = (token: Address, x: bigint) => {
  const t = token.toLowerCase()
  return t === WPLS.toLowerCase() ? wpls(x) : t === PLSX.toLowerCase() ? plsx(x) : hex(x)
}

// Point the SDK's registry at this fork, so the domain the makers sign with and the address the
// solver reads are the same one we deployed.
setChainId(369)
setRpcLinked(false, 369)
setRpc(RPC, 369, 'chain')
setSettlementOverride(369, SETTLEMENT)

const balance = (token: Address, who: Address) =>
  pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })

const now = async () => BigInt((await pub.getBlock()).timestamp)

let nonce = BigInt(Date.now())

/**
 * The fee terms these intents sign. Ten basis points to an address that is not the settlement's.
 *
 * They have to be real: an intent that names nowhere charges nothing, and a solver run where
 * every leg is free would clear the ring condition on arithmetic it never has to do.
 */
const FEE_TO = '0x00000000000000000000000000000000000feeee' as Address
const FEE_CONFIG = rememberFeeConfig(singleFeeConfig(FEE_TO))
const FEE_RATE = 1_000_000_000_000_000n

/** Sign an intent with the fork's own domain. */
async function sign(
  account: typeof makerA,
  o: Omit<
    Intent,
    | 'maker'
    | 'recipient'
    | 'executor'
    | 'feeConfig'
    | 'feeRate'
    | 'feeRateIn'
    | 'feeRateProceeds'
    | 'minFill'
    | 'authNonce'
    | 'flags'
    | 'nonce'
  > & {
    flags?: number
    executor?: Address
    feeConfig?: Hex
    feeRate?: bigint
    feeRateProceeds?: bigint
    minFill?: bigint
  },
): Promise<SignedIntent> {
  const intent: Intent = {
    maker: account.address,
    recipient: account.address,
    tokenIn: o.tokenIn,
    tokenOut: o.tokenOut,
    amountIn: o.amountIn,
    minOutStart: o.minOutStart,
    minOutEnd: o.minOutEnd,
    // A straight line across the whole window: kind 0, and the word it reads none of.
    curve: CURVE_LINEAR,
    startTime: o.startTime,
    endTime: o.endTime,
    executor: o.executor ?? ZERO,
    // A destination and a rate by default, because an intent that names nowhere charges nothing
    // and the ring condition would then have no fee to clear.
    feeConfig: o.feeConfig ?? FEE_CONFIG,
    feeRateIn: 0n,
    // The rate the old tests mean is the one that comes out of the maker's number, P3.
    feeRateProceeds: o.feeRateProceeds ?? o.feeRate ?? FEE_RATE,
    feeRate: 0n,
    // No floor by default. The ring tests split legs into small takes, and a floor would refuse
    // the very slices they are about.
    minFill: o.minFill ?? 0n,
    // No named 3009 nonce. These intents fund themselves through escrow or an allowance, so
    // there is nothing here for exclusion to be about.
    authNonce: ZERO_HASH,
    flags: o.flags ?? FLAG_PARTIAL,
    nonce: nonce++,
  }
  const signature = await signIntent(account, intent, { domain: signingDomain(369) })
  return { ...intent, signature }
}

// ── Setup ─────────────────────────────────────────────────────────────────────

console.log('\nsetup, on a fork of mainnet')

for (const who of [makerA.address, makerB.address, solverAccount.address, decoy.address]) {
  await pub.request({
    method: 'anvil_setBalance' as never,
    params: [who, '0x' + parseEther('40000000').toString(16)] as never,
  })
}
log('funded four accounts')

/**
 * A fixed limit for the setup swaps, rather than the node's own estimate.
 *
 * An estimate is a binary search for the smallest limit that works, and a PulseX swap sent at
 * exactly that limit dies inside the pair's reentrancy sentry. The account pays for the gas it
 * burns and not the limit it set, so the margin costs nothing and buys a swap that lands.
 */
const SWAP_GAS = 600_000n

/** Wrap PLS and buy PLSX from the real pool, the way any of these actors really would. */
async function stock(wallet: typeof makerAWallet, who: Address, wplsAmount: bigint, buyPlsx: bigint) {
  await wait(
    await wallet.writeContract({ address: WPLS, abi: wplsAbi, functionName: 'deposit', value: wplsAmount + buyPlsx }),
  )
  await wait(
    await wallet.writeContract({ address: WPLS, abi: erc20Abi, functionName: 'approve', args: [ROUTER, maxUint256] }),
  )
  if (buyPlsx > 0n) {
    await wait(
      await wallet.writeContract({
        address: ROUTER,
        abi: routerAbi,
        functionName: 'swapExactTokensForTokens',
        args: [buyPlsx, 0n, [WPLS, PLSX], who, (await now()) + 600n],
        gas: SWAP_GAS,
      }),
    )
  }
  for (const token of [WPLS, PLSX]) {
    await wait(
      await wallet.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'approve',
        args: [SETTLEMENT, maxUint256],
      }),
    )
  }
}

await stock(makerAWallet, makerA.address, parseEther('4000000'), 0n)
await stock(makerBWallet, makerB.address, 0n, parseEther('4000000'))
await stock(solverWallet, solverAccount.address, parseEther('3000000'), parseEther('3000000'))
await stock(decoyWallet, decoy.address, parseEther('1000000'), 0n)
log(`maker A holds ${wpls(await balance(WPLS, makerA.address))}`)
log(`maker B holds ${plsx(await balance(PLSX, makerB.address))}`)
log(
  `solver holds ${wpls(await balance(WPLS, solverAccount.address))} and ` +
    `${plsx(await balance(PLSX, solverAccount.address))}`,
)

// ── 1. The AMM curve ──────────────────────────────────────────────────────────

console.log('\n1. the pool curve this solver computes, against the router that runs it')

const pools = await loadPools([[WPLS, PLSX]], { client: pub, chainId: 369 })
const pool = pools.get(poolKey(WPLS, PLSX))
ok('the pair is found and snapshotted', !!pool, pool?.address)

if (pool) {
  for (const amount of [parseEther('1'), parseEther('1000'), parseEther('250000')]) {
    const mine = poolAmountOut(pool, WPLS, amount)!
    const theirs = (
      (await pub.readContract({
        address: ROUTER,
        abi: routerAbi,
        functionName: 'getAmountsOut',
        args: [amount, [WPLS, PLSX]],
      })) as readonly bigint[]
    )[1]
    ok(`getAmountsOut agrees at ${formatUnits(amount, 18)} WPLS`, mine === theirs, `${mine}`)
  }
  for (const want of [parseEther('1000'), parseEther('100000')]) {
    const mine = poolAmountIn(pool, PLSX, want)!
    const theirs = (
      (await pub.readContract({
        address: ROUTER,
        abi: routerAbi,
        functionName: 'getAmountsIn',
        args: [want, [WPLS, PLSX]],
      })) as readonly bigint[]
    )[0]
    ok(`getAmountsIn agrees for ${formatUnits(want, 18)} PLSX out`, mine === theirs, `${mine}`)
  }
}

// ── 2. The book ───────────────────────────────────────────────────────────────

console.log('\n2. the book keeps only what the chain will fill')

const t0 = await now()
const marketOut = (
  (await pub.readContract({
    address: ROUTER,
    abi: routerAbi,
    functionName: 'getAmountsOut',
    args: [parseEther('1000000'), [WPLS, PLSX]],
  })) as readonly bigint[]
)[1]
/** PLSX per WPLS, as the pool has it right now, scaled by 1e18. */
const price = (marketOut * 10n ** 18n) / parseEther('1000000')
log(`the pool pays ${formatUnits(price, 18)} PLSX for one WPLS`)

const AMOUNT_A = parseEther('1000000')
/** Each maker concedes 30 basis points. Between them that is 60, and the ring needs 16. */
const CONCEDE_BPS = 30n

// Maker A sells WPLS for PLSX, asking a shade under the pool price.
const intentA = await sign(makerA, {
  tokenIn: WPLS,
  tokenOut: PLSX,
  amountIn: AMOUNT_A,
  minOutStart: (((AMOUNT_A * price) / 10n ** 18n) * (10_000n - CONCEDE_BPS)) / 10_000n,
  minOutEnd: (((AMOUNT_A * price) / 10n ** 18n) * (10_000n - CONCEDE_BPS)) / 10_000n,
  curve: CURVE_LINEAR,
  startTime: t0,
  endTime: t0 + 3600n,
})

// Maker B goes the other way, and concedes the same.
const AMOUNT_B = (AMOUNT_A * price) / 10n ** 18n
const intentB = await sign(makerB, {
  tokenIn: PLSX,
  tokenOut: WPLS,
  amountIn: AMOUNT_B,
  minOutStart: (((AMOUNT_B * 10n ** 18n) / price) * (10_000n - CONCEDE_BPS)) / 10_000n,
  minOutEnd: (((AMOUNT_B * 10n ** 18n) / price) * (10_000n - CONCEDE_BPS)) / 10_000n,
  curve: CURVE_LINEAR,
  startTime: t0,
  endTime: t0 + 3600n,
})

// Three intents that must not survive the filter.
const expired = await sign(makerA, {
  tokenIn: WPLS,
  tokenOut: PLSX,
  amountIn: parseEther('1'),
  minOutStart: 1n,
  minOutEnd: 1n,
  curve: CURVE_LINEAR,
  startTime: t0 - 7200n,
  endTime: t0 - 3600n,
})
const notStarted = await sign(makerA, {
  tokenIn: WPLS,
  tokenOut: PLSX,
  amountIn: parseEther('1'),
  minOutStart: 1n,
  minOutEnd: 1n,
  curve: CURVE_LINEAR,
  startTime: t0 + 3600n,
  endTime: t0 + 7200n,
})
// The decoy owns no PLSX at all, so `fillability` refuses it on the deep balance probe.
const unfunded = await sign(decoy, {
  tokenIn: PLSX,
  tokenOut: WPLS,
  amountIn: parseEther('500000'),
  minOutStart: 1n,
  minOutEnd: 1n,
  curve: CURVE_LINEAR,
  startTime: t0,
  endTime: t0 + 3600n,
})

const all = [intentA, expired, intentB, notStarted, unfunded]
const { book, rejected } = await loadBook(all, {
  executor: solverAccount.address,
  client: pub,
  chainId: 369,
  settlementAddress: SETTLEMENT,
})

ok('the two live intents are in the book', book.entries.length === 2, `${book.entries.length} of ${all.length}`)
ok(
  'the unfunded intent is refused, with the chain’s reason',
  rejected.some((r) => r.intent.maker === decoy.address && r.reason === 'EscrowShort'),
  rejected.map((r) => r.reason).join(', ') || 'nothing refused',
)

// ── 3. Finding the ring ───────────────────────────────────────────────────────

console.log('\n3. the solver finds the ring unaided')

const prices = await loadPrices(book.tokens, { client: pub, chainId: 369 })
const gasPrice = await pub.getGasPrice()
const solveParams = {
  at: t0,
  executor: solverAccount.address,
  prices,
  gasPrice,
}

const plans = selectDisjoint(solve(book, solveParams))
ok('at least one ring is found', plans.length > 0, `${plans.length} disjoint plans`)

const ring = plans[0] as Plan | undefined
if (!ring) {
  console.log('\nno ring — nothing further to check\n')
  process.exit(1)
}

ok('it is a two-leg ring of two intents', ring.fills.length === 2 && ring.swap === null)
ok('it is atomic', ring.atomic)
ok(
  'the fee bound is the rate it was priced at, over every leg',
  ring.maxFeeRate === maxFeeRateFor(ring.fills.map((f) => f.intent)),
  `${bps(ring.maxFeeRate)}bps, the dearest leg's own signed rate`,
)
ok(
  'both makers are in it',
  new Set(ring.fills.map((f) => f.intent.maker)).size === 2,
  ring.fills.map((f) => `${f.intent.maker.slice(0, 8)} take ${formatUnits(f.take, 18)}`).join(' · '),
)
log(
  `predicted surplus ${formatUnits(ring.profit, 18)} of ${ring.profitToken === WPLS ? 'WPLS' : 'PLSX'}` +
    ` · working capital ${ring.capital.map((c) => formatUnits(c.amount, 18)).join(', ')}`,
)

// ── 4. Settling it ────────────────────────────────────────────────────────────

console.log('\n4. it settles, and everybody gets what they signed for')

await ensureApprovals(solverWallet, ring, {
  account: solverAccount.address,
  client: pub,
  chainId: 369,
  settlementAddress: SETTLEMENT,
})

const sim = await simulateRing(ring, {
  account: solverAccount.address,
  client: pub,
  chainId: 369,
  settlementAddress: SETTLEMENT,
})
ok('the chain accepts the batch in simulation', sim.ok, sim.ok ? `${sim.gas} gas` : sim.reason)
if (!sim.ok) {
  console.log(`\n${failures} FAILED\n`)
  process.exit(1)
}

const priced = withSimulatedGas(ring, sim.gas, prices, gasPrice)
ok(
  'it still clears its own gas once the gas is measured',
  priced.netNative !== null && priced.netNative > 0n,
  priced.netNative === null ? 'unpriced' : `${wpls(priced.netNative)} net at ${gasPrice} wei`,
)
log(`model said ${ring.gas} gas, the chain says ${sim.gas}`)

const before = {
  makerAPlsx: await balance(PLSX, makerA.address),
  makerBWpls: await balance(WPLS, makerB.address),
  solverWpls: await balance(WPLS, solverAccount.address),
  solverPlsx: await balance(PLSX, solverAccount.address),
}

const hash = await executeRing(solverWallet, priced, {
  account: solverAccount.address,
  client: pub,
  chainId: 369,
  settlementAddress: SETTLEMENT,
})
const receipt = await wait(hash)
ok('the batch lands', receipt.status === 'success', `gas ${receipt.gasUsed}`)
if (receipt.status !== 'success') await explain(priced, receipt.blockNumber)

const settledAt = (await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp
const short = makersShortChanged(priced, receipt.logs, settledAt, 369, SETTLEMENT)
ok('no maker was short-changed', short.length === 0, short.map((s) => `${s.maker} ${s.got}<${s.owed}`).join(', '))

const gotA = (await balance(PLSX, makerA.address)) - before.makerAPlsx
const gotB = (await balance(WPLS, makerB.address)) - before.makerBWpls
const owedA = priced.sized.legs.find((l) => l.leg.kind === 'intent' && l.leg.entry.intent.maker === makerA.address)!
const owedB = priced.sized.legs.find((l) => l.leg.kind === 'intent' && l.leg.entry.intent.maker === makerB.address)!
ok('maker A received at least their share of the signed rate', gotA >= owedA.delivered, `${plsx(gotA)} for ${wpls(owedA.take)}`)
ok('maker B received at least their share of the signed rate', gotB >= owedB.delivered, `${wpls(gotB)} for ${plsx(owedB.take)}`)

const dWpls = (await balance(WPLS, solverAccount.address)) - before.solverWpls
const dPlsx = (await balance(PLSX, solverAccount.address)) - before.solverPlsx
ok('the solver is not short in either token', dWpls >= 0n && dPlsx >= 0n, `${wpls(dWpls)}, ${plsx(dPlsx)}`)
ok(
  'the solver ended in profit',
  dWpls + dPlsx > 0n,
  `${priced.profitToken === WPLS ? wpls(dWpls) : plsx(dPlsx)} surplus`,
)
const banked = priced.profitToken === WPLS ? dWpls : dPlsx
ok('the surplus is exactly what the engine predicted', banked === priced.profit, `${banked} vs ${priced.profit}`)
const gasCost = receipt.gasUsed * receipt.effectiveGasPrice
ok('the surplus beats the gas it cost', (priced.profitNative ?? 0n) > gasCost, `gas ${wpls(gasCost)}`)
log(`gas ${receipt.gasUsed} at ${receipt.effectiveGasPrice} wei = ${wpls(gasCost)}`)

// ── 5. A ring that is not open yet ────────────────────────────────────────────

console.log('\n5. a ring the Dutch decay has not opened yet')

const t1 = await now()
const DECAY_S = 900n
// Maker A asks above the market and decays to well below it; maker B asks a flat premium. The
// pair cannot close now, and the only question is when.
const falling = await sign(makerA, {
  tokenIn: WPLS,
  tokenOut: PLSX,
  amountIn: parseEther('500000'),
  minOutStart: (parseEther('500000') * price * 10_100n) / (10n ** 18n * 10_000n),
  minOutEnd: (parseEther('500000') * price * 9_800n) / (10n ** 18n * 10_000n),
  curve: CURVE_LINEAR,
  startTime: t1,
  endTime: t1 + DECAY_S,
})
const fallingAmountOut = (parseEther('500000') * price) / 10n ** 18n
const premium = await sign(makerB, {
  tokenIn: PLSX,
  tokenOut: WPLS,
  amountIn: fallingAmountOut,
  minOutStart: (parseEther('500000') * 10_000n) / 10_000n,
  minOutEnd: (parseEther('500000') * 10_000n) / 10_000n,
  curve: CURVE_LINEAR,
  startTime: t1,
  endTime: t1 + DECAY_S,
})

const later = await loadBook([falling, premium], {
  executor: solverAccount.address,
  client: pub,
  chainId: 369,
  settlementAddress: SETTLEMENT,
})
ok('both intents are fillable', later.book.entries.length === 2)

const laterParams = { ...solveParams, at: t1 }
ok('the ring is not worth doing now', solve(later.book, laterParams).length === 0)

const pending = upcoming(later.book, laterParams, DECAY_S)
ok('the solver says it will be', pending.length > 0, pending.length ? `in ${pending[0].at - t1}s` : 'never')

if (pending.length > 0) {
  const when = pending[0].at
  ok('the prediction is inside the intents’ lifetime', when <= ringDeadline(pending[0].ring))
  ok(
    'the prediction agrees with the engine asked directly',
    profitableFrom(pending[0].ring, laterParams) === when,
  )

  // Move the chain to one second before, and check the solver is right that it is too early.
  await pub.request({ method: 'evm_setNextBlockTimestamp' as never, params: [Number(when - 1n)] as never })
  await pub.request({ method: 'evm_mine' as never, params: [] as never })
  const early = solve(later.book, { ...laterParams, at: when - 1n })
  ok('one second early, there is no ring', early.length === 0)

  await pub.request({ method: 'evm_setNextBlockTimestamp' as never, params: [Number(when)] as never })
  await pub.request({ method: 'evm_mine' as never, params: [] as never })
  const opened = selectDisjoint(solve(later.book, { ...laterParams, at: when }))
  ok('at the predicted second, there is', opened.length > 0)

  if (opened.length > 0) {
    const plan = opened[0]
    await ensureApprovals(solverWallet, plan, {
      account: solverAccount.address,
      client: pub,
      chainId: 369,
      settlementAddress: SETTLEMENT,
    })
    const sim2 = await simulateRing(plan, {
      account: solverAccount.address,
      client: pub,
      chainId: 369,
      settlementAddress: SETTLEMENT,
    })
    ok('the chain accepts it there', sim2.ok, sim2.ok ? `${sim2.gas} gas` : sim2.reason)
    if (sim2.ok) {
      const wplsBefore = await balance(WPLS, solverAccount.address)
      const plsxBefore = await balance(PLSX, solverAccount.address)
      const h2 = await executeRing(solverWallet, plan, {
        account: solverAccount.address,
        client: pub,
        chainId: 369,
        settlementAddress: SETTLEMENT,
      })
      const r2 = await wait(h2)
      const d2Wpls = (await balance(WPLS, solverAccount.address)) - wplsBefore
      const d2Plsx = (await balance(PLSX, solverAccount.address)) - plsxBefore
      ok('the decayed ring settles', r2.status === 'success', `gas ${r2.gasUsed}`)
      const at2 = (await pub.getBlock({ blockNumber: r2.blockNumber })).timestamp
      const short2 = makersShortChanged(plan, r2.logs, at2, 369, SETTLEMENT)
      ok(
        'no maker was short-changed',
        short2.length === 0,
        short2.map((s) => `${s.maker} ${s.got}<${s.owed}`).join(', ') || `settled at +${at2 - when}s`,
      )
      ok('the solver profits on it too', d2Wpls + d2Plsx > 0n, `${wpls(d2Wpls)}, ${plsx(d2Plsx)}`)
    }
  }
}

// ── 6. Closing through the pool ───────────────────────────────────────────────

console.log('\n6. one intent plus the pool')

const t2 = await now()
const freshPools = await loadPools([[WPLS, PLSX]], { client: pub, chainId: 369 })
const livePool = freshPools.get(poolKey(WPLS, PLSX))!
const marketNow = poolAmountOut(livePool, WPLS, parseEther('200000'))!

// A maker selling WPLS for less PLSX than the pool would pay. The pool closes the ring.
const cheap = await sign(makerA, {
  tokenIn: WPLS,
  tokenOut: PLSX,
  amountIn: parseEther('200000'),
  minOutStart: (marketNow * 9_800n) / 10_000n,
  minOutEnd: (marketNow * 9_800n) / 10_000n,
  curve: CURVE_LINEAR,
  startTime: t2,
  endTime: t2 + 3600n,
})

const poolBook = await loadBook([cheap], {
  executor: solverAccount.address,
  client: pub,
  chainId: 369,
  settlementAddress: SETTLEMENT,
})
const poolPlans = solve(poolBook.book, {
  ...solveParams,
  at: t2,
  markets: xykMarkets(freshPools, () => ROUTER),
})
ok('the solver closes it through PulseX', poolPlans.length > 0)

if (poolPlans.length > 0) {
  const plan = poolPlans[0]
  ok('the plan is one fill and one swap', plan.fills.length === 1 && plan.swap !== null)
  ok('and it says so: a pool leg is not atomic', plan.atomic === false)

  const wplsBefore = await balance(WPLS, solverAccount.address)
  const plsxBefore = await balance(PLSX, solverAccount.address)

  await ensureApprovals(solverWallet, plan, {
    account: solverAccount.address,
    client: pub,
    chainId: 369,
    settlementAddress: SETTLEMENT,
    router: ROUTER,
  })
  const sim3 = await simulateRing(plan, {
    account: solverAccount.address,
    client: pub,
    chainId: 369,
    settlementAddress: SETTLEMENT,
  })
  ok('the fill simulates', sim3.ok, sim3.ok ? `${sim3.gas} gas` : sim3.reason)

  if (sim3.ok) {
    const measured = withSimulatedGas(plan, sim3.gas, prices, gasPrice)
    const h3 = await executeRing(solverWallet, measured, {
      account: solverAccount.address,
      client: pub,
      chainId: 369,
      settlementAddress: SETTLEMENT,
    })
    const r3 = await wait(h3)
    if (r3.status !== 'success') await explain(measured, r3.blockNumber)
    const h4 = await executeSwap(
      solverWallet,
      measured,
      { account: solverAccount.address, client: pub, chainId: 369, settlementAddress: SETTLEMENT, router: ROUTER },
      (await now()) + 300n,
    )
    const r4 = await wait(h4)
    ok('both transactions land', r3.status === 'success' && r4.status === 'success', `gas ${r3.gasUsed} + ${r4.gasUsed}`)
    const at3 = (await pub.getBlock({ blockNumber: r3.blockNumber })).timestamp
    ok('no maker was short-changed', makersShortChanged(measured, r3.logs, at3, 369, SETTLEMENT).length === 0)

    const d3Wpls = (await balance(WPLS, solverAccount.address)) - wplsBefore
    const d3Plsx = (await balance(PLSX, solverAccount.address)) - plsxBefore
    ok('the PLSX position is closed', d3Plsx >= 0n, plsx(d3Plsx))
    ok('the solver ends in profit', d3Wpls > 0n, wpls(d3Wpls))
    ok('the surplus is at least what the engine predicted', d3Wpls >= plan.profit, `${d3Wpls} vs ${plan.profit}`)
  }
}

// ── 7. Three makers who close a triangle ──────────────────────────────────────

console.log('\n7. a three-leg ring: three tokens, and no two makers who trade with each other')

// Maker C is anvil's fifth published account. It holds the third token, and it is the only maker
// here who never trades with either of the other two: A sells WPLS for PLSX, B sells PLSX for
// HEX, C sells HEX for WPLS. No two of those close a cycle, so a two-leg search has nothing to
// find and the triangle is the only settlement that exists.
await pub.request({
  method: 'anvil_setBalance' as never,
  params: [makerC.address, '0x' + parseEther('40000000').toString(16)] as never,
})

/** Wrap PLS and buy HEX from the real pool, then let the settlement take it. */
async function stockHex(wallet: typeof makerAWallet, who: Address, spend: bigint) {
  await wait(await wallet.writeContract({ address: WPLS, abi: wplsAbi, functionName: 'deposit', value: spend }))
  await wait(
    await wallet.writeContract({ address: WPLS, abi: erc20Abi, functionName: 'approve', args: [ROUTER, maxUint256] }),
  )
  await wait(
    await wallet.writeContract({
      address: ROUTER,
      abi: routerAbi,
      functionName: 'swapExactTokensForTokens',
      args: [spend, 0n, [WPLS, HEX], who, (await now()) + 600n],
      gas: SWAP_GAS,
    }),
  )
  await wait(
    await wallet.writeContract({
      address: HEX,
      abi: erc20Abi,
      functionName: 'approve',
      args: [SETTLEMENT, maxUint256],
    }),
  )
}

const HEX_SPEND = parseEther('1100000')
await stockHex(makerCWallet, makerC.address, HEX_SPEND)
// The solver fronts two of the three payments and one of them is in HEX, so it has to hold some.
await stockHex(solverWallet, solverAccount.address, HEX_SPEND)
log(`maker C holds ${hex(await balance(HEX, makerC.address))}, the solver ${hex(await balance(HEX, solverAccount.address))}`)

// Read the three pools after those purchases, so the makers quote against the book as it stands.
const triPools = await loadPools(
  [
    [WPLS, PLSX],
    [PLSX, HEX],
    [HEX, WPLS],
  ],
  { client: pub, chainId: 369 },
)
const wplsPlsx = triPools.get(poolKey(WPLS, PLSX))
const plsxHex = triPools.get(poolKey(PLSX, HEX))
const hexWpls = triPools.get(poolKey(HEX, WPLS))
ok(
  'each of the three pairs has a real pool to price against',
  !!wplsPlsx && !!plsxHex && !!hexWpls,
  [wplsPlsx, plsxHex, hexWpls].map((p) => p?.address ?? 'none').join(' · '),
)
if (!wplsPlsx || !plsxHex || !hexWpls) {
  console.log(`\n${failures} FAILED\n`)
  process.exit(1)
}

/**
 * The pool's mid price as an exact fraction: `amount · num / den` is what it pays at the margin.
 *
 * The 29 basis points the pool charges is left out on purpose. That fee is what a maker's
 * concession competes with, so it belongs on the other side of the comparison, not inside the
 * number the maker quotes against.
 */
function midRate(pool: Pool, tokenIn: Address): { num: bigint; den: bigint } {
  const inIsZero = tokenIn.toLowerCase() === pool.token0.toLowerCase()
  return inIsZero ? { num: pool.reserve1, den: pool.reserve0 } : { num: pool.reserve0, den: pool.reserve1 }
}

const plsxPerWpls = midRate(wplsPlsx, WPLS)
const hexPerPlsx = midRate(plsxHex, PLSX)
const wplsPerHex = midRate(hexWpls, HEX)
const hexPerWpls = midRate(hexWpls, WPLS)

// The three mids ought to multiply to one and do not. The pools drift apart until a triangular
// arbitrage is worth the 87 basis points of swap fee it would cost to take, and at this block
// they sit 24 apart. The ring does not lean on that gap: three makers conceding 30 basis points
// each clear the 24 the fee asks for on their own.
const triNum = plsxPerWpls.num * hexPerPlsx.num * wplsPerHex.num
const triDen = plsxPerWpls.den * hexPerPlsx.den * wplsPerHex.den
log(`the three pool mids multiply to one within ${((triNum - triDen) * 10_000n) / triDen} basis points`)

const RING_IN = parseEther('1000000')
/** Two per cent of headroom on the later legs, so maker A's amount is the one that binds. */
const headroom = (x: bigint) => (x * 102n) / 100n
/** What a maker offers: the mid of the pool that trades their own pair, less the concession. */
const inside = (amountIn: bigint, r: { num: bigint; den: bigint }) =>
  (amountIn * r.num * (10_000n - CONCEDE_BPS)) / (r.den * 10_000n)

const t3 = await now()
const legAB = await sign(makerA, {
  tokenIn: WPLS,
  tokenOut: PLSX,
  amountIn: RING_IN,
  minOutStart: inside(RING_IN, plsxPerWpls),
  minOutEnd: inside(RING_IN, plsxPerWpls),
  curve: CURVE_LINEAR,
  startTime: t3,
  endTime: t3 + 3600n,
})
const plsxIn = headroom((RING_IN * plsxPerWpls.num) / plsxPerWpls.den)
const legBC = await sign(makerB, {
  tokenIn: PLSX,
  tokenOut: HEX,
  amountIn: plsxIn,
  minOutStart: inside(plsxIn, hexPerPlsx),
  minOutEnd: inside(plsxIn, hexPerPlsx),
  curve: CURVE_LINEAR,
  startTime: t3,
  endTime: t3 + 3600n,
})
const hexIn = headroom((RING_IN * hexPerWpls.num) / hexPerWpls.den)
const legCA = await sign(makerC, {
  tokenIn: HEX,
  tokenOut: WPLS,
  amountIn: hexIn,
  minOutStart: inside(hexIn, wplsPerHex),
  minOutEnd: inside(hexIn, wplsPerHex),
  curve: CURVE_LINEAR,
  startTime: t3,
  endTime: t3 + 3600n,
})
// A decoy on the same pair as maker A, asking one per cent above the mid instead of conceding.
// It closes a triangle of its own with B and C, and that triangle fails the ring condition, so
// the solver has to tell the two apart rather than take the first cycle it enumerates.
const PREMIUM_BPS = 100n
const premiumIn = parseEther('900000')
const dear = await sign(decoy, {
  tokenIn: WPLS,
  tokenOut: PLSX,
  amountIn: premiumIn,
  minOutStart: (premiumIn * plsxPerWpls.num * (10_000n + PREMIUM_BPS)) / (plsxPerWpls.den * 10_000n),
  minOutEnd: (premiumIn * plsxPerWpls.num * (10_000n + PREMIUM_BPS)) / (plsxPerWpls.den * 10_000n),
  curve: CURVE_LINEAR,
  startTime: t3,
  endTime: t3 + 3600n,
})

const triLoad = await loadBook([legAB, dear, legBC, legCA], {
  executor: solverAccount.address,
  client: pub,
  chainId: 369,
  settlementAddress: SETTLEMENT,
})
ok(
  'the three legs and the decoy are all fillable',
  triLoad.book.entries.length === 4,
  `${triLoad.book.entries.length} of 4 · ${triLoad.rejected.map((r) => r.reason).join(', ') || 'nothing refused'}`,
)
ok(
  'no two intents in the book trade against each other',
  !triLoad.book.entries.some((e) => triLoad.book.byPair.has(pairKey(e.intent.tokenOut, e.intent.tokenIn))),
  [...triLoad.book.byPair.keys()].length + ' directed pairs, none of them opposed',
)

const triPrices = await loadPrices(triLoad.book.tokens, { client: pub, chainId: 369 })
const triGasPrice = await pub.getGasPrice()
const triParams = {
  at: t3,
  executor: solverAccount.address,
  prices: triPrices,
  gasPrice: triGasPrice,
}

// The whole point of the section: cap the search at two legs and there is nothing to find.
ok('a two-leg search finds nothing here', solve(triLoad.book, { ...triParams, maxLegs: 2 as const }).length === 0)

const triPlans = selectDisjoint(solve(triLoad.book, triParams))
ok('the three-leg search finds the ring unaided', triPlans.length > 0, `${triPlans.length} disjoint plans`)

const tri = triPlans[0] as Plan | undefined
if (!tri) {
  console.log(`\n${failures} FAILED\n`)
  process.exit(1)
}

ok('it is three intents in one atomic batch', tri.fills.length === 3 && tri.swap === null && tri.atomic)
const triMakers = new Set(tri.fills.map((f) => f.intent.maker))
ok('three makers, one leg each', triMakers.size === 3, [...triMakers].map((m) => m.slice(0, 8)).join(' · '))
ok('three tokens, each received once and paid once', new Set(ringTokens(tri.ring)).size === 3)
ok('it takes the makers who conceded, not the one who asked a premium', !triMakers.has(decoy.address))
log(
  `predicted surplus ${amountOf(tri.profitToken, tri.profit)} · ` +
    tri.sized.legs.map((l) => `${amountOf(l.leg.receives, l.take)} → ${amountOf(l.leg.pays, l.pay)}`).join(' · '),
)

// The spec wrote the working capital as `Σ p_k − max p_k`. Running it corrects that twice. The
// payments are in three different tokens, so the report is a list and not a scalar; and the
// payment the first leg's receipt covers is always the last one in the rotation, which is the
// smallest of the three, because the value sheds a maker's concession at every step. There is no
// rotation that skips the largest payment.
const triLegs = tri.sized.legs
const lastPays = triLegs[triLegs.length - 1].leg.pays
const capitalOf = (token: Address) =>
  tri.capital.find((c) => c.token.toLowerCase() === token.toLowerCase())?.amount ?? 0n
ok('the capital report is one entry per token paid before the last leg', tri.capital.length === 2)
ok(
  'each entry is exactly that leg’s payment',
  triLegs.slice(0, -1).every((l) => capitalOf(l.leg.pays) === l.pay),
  tri.capital.map((c) => amountOf(c.token, c.amount)).join(' · '),
)
ok('the token the first receipt covers is not in the report', capitalOf(lastPays) === 0n, amountOf(lastPays, triLegs[triLegs.length - 1].pay))
const paidNative = triLegs.map((l) => valueInNative(triPrices, l.leg.pays, l.pay) ?? 0n)
const capitalNative = tri.capital.reduce((sum, c) => sum + (valueInNative(triPrices, c.token, c.amount) ?? 0n), 0n)
ok(
  'in WPLS the report is Σ p minus the payment the first receipt covers',
  capitalNative === paidNative.reduce((a, b) => a + b, 0n) - paidNative[paidNative.length - 1],
  `${wpls(capitalNative)} of capital, largest payment ${wpls(paidNative.reduce((a, b) => (a > b ? a : b), 0n))}`,
)

await ensureApprovals(solverWallet, tri, {
  account: solverAccount.address,
  client: pub,
  chainId: 369,
  settlementAddress: SETTLEMENT,
})

// Hold the solver to its own report: park everything above the capital it says it needs, so the
// batch runs on exactly that and nothing else. A number that is too small runs out of tokens
// half way through the batch, which is a failure only a chain can show.
for (const token of ringTokens(tri.ring)) {
  const bal = await balance(token, solverAccount.address)
  const need = capitalOf(token)
  if (bal > need) {
    await wait(
      await solverWallet.writeContract({
        address: token,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [PARK, bal - need],
      }),
    )
  }
}
const stake = await Promise.all(ringTokens(tri.ring).map((t) => balance(t, solverAccount.address)))
ok(
  'the solver starts the batch holding exactly the capital it reported',
  stake.every((bal, k) => bal === capitalOf(ringTokens(tri.ring)[k])),
  stake.map((bal, k) => amountOf(ringTokens(tri.ring)[k], bal)).join(' · '),
)

const triSim = await simulateRing(tri, {
  account: solverAccount.address,
  client: pub,
  chainId: 369,
  settlementAddress: SETTLEMENT,
})
ok('the chain accepts the three-leg batch on that stake', triSim.ok, triSim.ok ? `${triSim.gas} gas` : triSim.reason)
if (!triSim.ok) {
  console.log(`\n${failures} FAILED\n`)
  process.exit(1)
}

const triPriced = withSimulatedGas(tri, triSim.gas, triPrices, triGasPrice)
ok(
  'it clears its own gas once the gas is measured',
  triPriced.netNative !== null && triPriced.netNative > 0n,
  triPriced.netNative === null ? 'unpriced' : `${wpls(triPriced.netNative)} net at ${triGasPrice} wei`,
)
log(`model said ${tri.gas} gas for three legs, the chain says ${triSim.gas}`)

const owed = triLegs.map((l) => (l.leg.kind === 'intent' ? l.leg.entry.intent : null))
const recipientHeld = await Promise.all(
  triLegs.map((l) => balance(l.leg.pays, l.leg.kind === 'intent' ? l.leg.entry.intent.recipient : PARK)),
)

const triHash = await executeRing(solverWallet, triPriced, {
  account: solverAccount.address,
  client: pub,
  chainId: 369,
  settlementAddress: SETTLEMENT,
})
const triReceipt = await wait(triHash)
ok('the three-leg batch lands', triReceipt.status === 'success', `gas ${triReceipt.gasUsed}`)
if (triReceipt.status !== 'success') await explain(triPriced, triReceipt.blockNumber)

const triAt = (await pub.getBlock({ blockNumber: triReceipt.blockNumber })).timestamp
const triShort = makersShortChanged(triPriced, triReceipt.logs, triAt, 369, SETTLEMENT)
ok('no maker was short-changed', triShort.length === 0, triShort.map((s) => `${s.maker} ${s.got}<${s.owed}`).join(', '))

const label = new Map([
  [makerA.address, 'A'],
  [makerB.address, 'B'],
  [makerC.address, 'C'],
])
for (let k = 0; k < triLegs.length; k++) {
  const intent = owed[k]
  if (!intent) continue
  const got = (await balance(triLegs[k].leg.pays, intent.recipient)) - recipientHeld[k]
  ok(
    `maker ${label.get(intent.maker) ?? intent.maker.slice(0, 8)} received at least their share of the rate they signed`,
    got >= triLegs[k].delivered,
    `${amountOf(triLegs[k].leg.pays, got)} for ${amountOf(triLegs[k].leg.receives, triLegs[k].take)}`,
  )
}

const after = await Promise.all(ringTokens(tri.ring).map((t) => balance(t, solverAccount.address)))
const banked3 = after[ringTokens(tri.ring).findIndex((t) => t.toLowerCase() === triPriced.profitToken.toLowerCase())]
ok(
  'the solver ends holding its capital back, plus the surplus and nothing else',
  after.every((bal, k) => {
    const token = ringTokens(tri.ring)[k]
    const extra = token.toLowerCase() === triPriced.profitToken.toLowerCase() ? triPriced.profit : 0n
    return bal === capitalOf(token) + extra
  }),
  after.map((bal, k) => amountOf(ringTokens(tri.ring)[k], bal)).join(' · '),
)
ok(
  'the surplus is exactly what the engine predicted',
  banked3 - capitalOf(triPriced.profitToken) === triPriced.profit,
  `${banked3 - capitalOf(triPriced.profitToken)} vs ${triPriced.profit}`,
)
const triGasCost = triReceipt.gasUsed * triReceipt.effectiveGasPrice
ok('the surplus beats the gas it cost', (triPriced.profitNative ?? 0n) > triGasCost, `gas ${wpls(triGasCost)}`)
log(
  `gas ${triReceipt.gasUsed} at ${triReceipt.effectiveGasPrice} wei = ${wpls(triGasCost)}, ` +
    `surplus ${wpls(triPriced.profitNative ?? 0n)} of WPLS value`,
)

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)

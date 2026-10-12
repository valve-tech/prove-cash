/**
 * `fillBatchWithCallback` — a two-leg ring settled on credit, on chain 943.
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK \
 *     npx tsx scripts/e2e/ring.ts                # dry run only, sends nothing
 *
 *   DEPLOYER_PK=… npx tsx scripts/e2e/ring.ts --deploy
 *
 *   DEPLOYER_PK=… EXECUTOR=0x2d8bb68a866dee1bafbafd4731865263066f6038 \
 *     npx tsx scripts/e2e/ring.ts --deploy      # reuse the one already on 943
 *
 * This is the claim the function exists for, held to the standard that makes it mean something:
 * **the executor contract starts with none of either traded token, and is funded with exactly the
 * two protocol fees and nothing else.** Fees are the one thing a ring cannot generate. Everything
 * else each maker is paid has to come out of what the other maker just sold.
 *
 * Maker one sells tPLSX for tUSDC. Maker two sells tUSDC for tPLSX. Between them they concede
 * more than the round trip costs, so the ring closes and the solver keeps the difference.
 *
 * The same two intents through `fillBatch` cannot settle, and the run proves that too rather than
 * asserting it — `fillBatch` pays maker one before it releases maker two's tokens.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encodeDeployData,
  encodeFunctionData,
  erc20Abi,
  getContractAddress,
  pad,
  parseEther,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import {
  CURVE_LINEAR,
  SETTLEMENT_ABI,
  ZERO,
  ZERO_HASH,
  callFor,
  signingDomain,
  intentHashOf,
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
  RELAYER,
  balanceOf,
  derive,
  finish,
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
  inventoryExecutorSource,
  redact,
} from './common.js'

const DEPLOY = process.argv.includes('--deploy')

const PLSX = token('tPLSX')
const USDC = token('tUSDC')

const makerOne = derive('prove.cash/e2e/ring-maker-one')
const makerTwo = derive('prove.cash/e2e/ring-maker-two')
const executor = derive('prove.cash/e2e/executor')
const executorWallet = walletFor(executor)

/** Leg one: 40 tPLSX out, at least 1.20 tUSDC back. */
const ONE_IN = units(PLSX, '40')
const ONE_OUT = units(USDC, '1.20')
/** Leg two: 1.25 tUSDC out, at least 39 tPLSX back. The ring closes on the gap. */
const TWO_IN = units(USDC, '1.25')
const TWO_OUT = units(PLSX, '39')

// ── Compile ───────────────────────────────────────────────────────────────────

head('compiling InventoryExecutor')
// The two addresses are bound from the registry, so the source cannot name a stale deployment.
const source = inventoryExecutorSource()
must(source.includes(SETTLEMENT), `the contract targets ${SETTLEMENT}, from the SDK registry`)
must(source.includes(RELAYER), `and approves ${RELAYER}, the relayer the settlement names`)

function compile(): { abi: Abi; bytecode: Hex; runtime: Hex } {
  const root = mkdtempSync(join(tmpdir(), 'prove-ring-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'InventoryExecutor.sol'), source)
  writeFileSync(
    join(root, 'foundry.toml'),
    '[profile.default]\nsrc = "src"\nout = "out"\nsolc = "0.8.30"\noptimizer = true\noptimizer_runs = 1000\nvia_ir = true\nevm_version = "paris"\n',
  )
  execFileSync('forge', ['build', '--root', root], { stdio: 'pipe' })
  const artifact = JSON.parse(
    readFileSync(join(root, 'out', 'InventoryExecutor.sol', 'InventoryExecutor.json'), 'utf8'),
  )
  return {
    abi: artifact.abi as Abi,
    bytecode: artifact.bytecode.object as Hex,
    runtime: artifact.deployedBytecode.object as Hex,
  }
}

const { abi: EXEC_ABI, bytecode, runtime } = compile()
log(`compiled · ${(runtime.length - 2) / 2} bytes of runtime code`)

// ── The two intents ───────────────────────────────────────────────────────────

head('setup')
log(`maker one ${makerOne.address} · sells tPLSX`)
log(`maker two ${makerTwo.address} · sells tUSDC`)
log(`executor  ${executor.address} (owns the contract)`)

await topUpGas(makerOne.address, parseEther('0.1'), 'ring maker one')
await topUpGas(makerTwo.address, parseEther('0.1'), 'ring maker two')
await topUpGas(executor.address, parseEther('0.3'), 'ring executor')
await topUpToken(PLSX, makerOne.address, ONE_IN, 'ring maker one')
await topUpToken(USDC, makerTwo.address, TWO_IN, 'ring maker two')

for (const [who, t] of [
  [makerOne, PLSX],
  [makerTwo, USDC],
] as const) {
  const wallet = walletFor(who)
  const current = (await pub.readContract({
    address: t.address,
    abi: [
      {
        type: 'function',
        name: 'allowance',
        stateMutability: 'view',
        inputs: [
          { name: 'o', type: 'address' },
          { name: 's', type: 'address' },
        ],
        outputs: [{ type: 'uint256' }],
      },
    ] as const,
    functionName: 'allowance',
    args: [who.address, RELAYER],
  })) as bigint
  const need = t === PLSX ? ONE_IN : TWO_IN
  if (current < need) {
    await send(
      wallet,
      {
        to: t.address,
        data: encodeFunctionData({
          abi: [
            {
              type: 'function',
              name: 'approve',
              stateMutability: 'nonpayable',
              inputs: [
                { name: 's', type: 'address' },
                { name: 'v', type: 'uint256' },
              ],
              outputs: [{ type: 'bool' }],
            },
          ] as const,
          functionName: 'approve',
          args: [RELAYER, need * 4n],
        }),
      },
      `approved the relayer for ${t.symbol}`,
    )
  }
}

const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
const stamp = BigInt(Date.now())

function leg(
  who: typeof makerOne,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  minOut: bigint,
  nonce: bigint,
): Intent {
  return {
    maker: who.address,
    recipient: who.address,
    tokenIn,
    tokenOut,
    amountIn,
    minOutStart: minOut,
    minOutEnd: minOut,
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
    flags: 0,
    nonce,
  }
}

const one = leg(makerOne, PLSX.address, USDC.address, ONE_IN, ONE_OUT, stamp)
const two = leg(makerTwo, USDC.address, PLSX.address, TWO_IN, TWO_OUT, stamp + 1n)

const signed: SignedIntent[] = []
for (const [i, who] of [
  [one, makerOne],
  [two, makerTwo],
] as const) {
  signed.push({
    ...i,
    signature: await signIntent(who, i, { domain: signingDomain(CHAIN) }),
  })
}

log(`leg one ${intentHashOf(one, CHAIN)} · ${show(PLSX, ONE_IN)} for ≥ ${show(USDC, ONE_OUT)}`)
log(`leg two ${intentHashOf(two, CHAIN)} · ${show(USDC, TWO_IN)} for ≥ ${show(PLSX, TWO_OUT)}`)

// ── What the ring owes ────────────────────────────────────────────────────────

/** The bound the whole ring goes out with: the dearest rate either leg asks for. */
const maxFeeRate = boundFor([one, two])

async function quote(i: Intent, take: bigint) {
  const q = (await pub.readContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'quote',
    args: [toStruct(i), take, now],
  })) as unknown as { delivered: bigint; feeOut: bigint; feeProceeds: bigint }
  return [q.delivered, q.feeOut + q.feeProceeds] as const
}

const [deliveredOne, feeOne] = await quote(one, ONE_IN)
const [deliveredTwo, feeTwo] = await quote(two, TWO_IN)

head('the ring, on paper')
log(`leg one pays maker one ${show(USDC, deliveredOne)} + ${show(USDC, feeOne)} fee`)
log(`leg two pays maker two ${show(PLSX, deliveredTwo)} + ${show(PLSX, feeTwo)} fee`)
must(
  ONE_IN > deliveredTwo + feeTwo,
  `the tPLSX released (${show(PLSX, ONE_IN)}) covers what leg two owes (${show(PLSX, deliveredTwo + feeTwo)})`,
)
must(
  TWO_IN > deliveredOne + feeOne,
  `the tUSDC released (${show(USDC, TWO_IN)}) covers what leg one owes (${show(USDC, deliveredOne + feeOne)})`,
)
log(
  `so the ring closes: the solver keeps ${show(PLSX, ONE_IN - deliveredTwo - feeTwo)} and ${show(USDC, TWO_IN - deliveredOne - feeOne)}`,
)

// ── The call the SDK builds ───────────────────────────────────────────────────

const plan = callFor(
  {
    mode: 'credit',
    fills: [
      { intent: signed[0], take: ONE_IN },
      { intent: signed[1], take: TWO_IN },
    ],
    maxFeeRate,
  },
  CHAIN,
)
must(plan.functionName === 'fillBatchWithCallback', 'the SDK routes a ring to the credit path')
must(plan.args[1] === false, 'and refuses to skip a leg, because a ring is atomic or nothing')

// `arming` is empty on both legs: each maker granted the relayer an allowance above, so there is
// no signature left to spend. It is still written out, because the field is not optional on the
// wire and an absent one encodes as nothing rather than as empty bytes.
const reqs = [
  { intent: toStruct(one), signature: signed[0].signature, take: ONE_IN, arming: '0x' as Hex },
  { intent: toStruct(two), signature: signed[1].signature, take: TWO_IN, arming: '0x' as Hex },
]

// ── Dry run ───────────────────────────────────────────────────────────────────

const REUSE = process.env.EXECUTOR?.trim() as Address | undefined

head('dry run — the ring against live state, without deploying anything')

// An address with no code and no balance, so the override supplies everything and the run cannot
// be flattered by tokens the real executor happens to be holding.
const ghost = derive('prove.cash/e2e/ring-ghost').address
must(!(await pub.getCode({ address: ghost })), `${ghost} really has no code on chain`)

/**
 * Nothing at all. Not even the fees.
 *
 * The first draft stocked the ghost with the two protocol fees, on the reasoning that a ring
 * generates every other token but not those. That reasoning is wrong whenever the makers concede
 * more than the round trip costs, which is exactly when a solver would bother: the surplus pays
 * the fees out of the spread. So the honest override supplies no tokens, and the negative control
 * below is a ring that does not close rather than a solver that is short.
 */
const overrides = [
  {
    address: ghost,
    code: runtime,
    // Slot 0 is `owner`. The executor must own it to be allowed to call `fillRing`.
    stateDiff: [{ slot: pad('0x00', { size: 32 }), value: pad(executor.address, { size: 32 }) }],
  },
] as const

for (const t of [PLSX, USDC] as const) {
  const held = await pub.readContract({
    address: t.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [ghost],
    stateOverride: overrides as never,
  })
  must(held === 0n, `the ghost holds no ${t.symbol} whatsoever`)
}

let dryRun = 'it did not run'
try {
  await pub.simulateContract({
    address: ghost,
    abi: EXEC_ABI,
    functionName: 'fillRing',
    args: [reqs, false, maxFeeRate],
    account: executor,
    stateOverride: overrides as never,
  } as never)
  dryRun = 'ok'
} catch (e) {
  dryRun = redact((e as Error).message.split('\n').slice(0, 2).join(' / '))
}
must(dryRun === 'ok', `the whole ring settles as an eth_call · ${dryRun}`)

// A ring that does not close must fail, or the run above proves nothing. Leg two here asks for
// more tPLSX than leg one's whole release can cover once the fee is added, so the last pull finds
// an empty contract. Everything else about it is identical.
const greedyOut = units(PLSX, '39.98')
const greedy = leg(makerTwo, USDC.address, PLSX.address, TWO_IN, greedyOut, stamp + 2n)
const greedySig = await signIntent(makerTwo, greedy, { domain: signingDomain(CHAIN) })
const [greedyDelivered, greedyFee] = await quote(greedy, TWO_IN)
must(
  greedyDelivered + greedyFee > ONE_IN,
  `the greedy leg owes ${show(PLSX, greedyDelivered + greedyFee)}, past the ${show(PLSX, ONE_IN)} released`,
)

let short = 'it went through'
try {
  await pub.simulateContract({
    address: ghost,
    abi: EXEC_ABI,
    functionName: 'fillRing',
    args: [
      [reqs[0], { intent: toStruct(greedy), signature: greedySig, take: TWO_IN, arming: '0x' as Hex }],
      false,
      maxFeeRate,
    ],
    account: executor,
    stateOverride: overrides as never,
  } as never)
} catch {
  short = 'it failed'
}
must(short === 'it failed', 'and a ring that does not close fails, so the dry run has teeth')

// The same two intents through `fillBatch` cannot settle: it pays leg one before releasing
// leg two. This is the whole reason the credit path exists, so prove it rather than assert it.
let plain = 'it went through'
try {
  await pub.simulateContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'fillBatch',
    args: [reqs, false, maxFeeRate],
    account: ghost,
    stateOverride: overrides as never,
  } as never)
} catch {
  plain = 'it failed'
}
must(plain === 'it failed', 'and the same ring through fillBatch cannot settle, for want of inventory')

if (!DEPLOY) {
  head('stopping here')
  log('the real run needs a contract on chain. Re-run with --deploy once that is agreed.')
  finish('ring dry run')
}

// ── The real thing ────────────────────────────────────────────────────────────

let EXEC: Address
if (REUSE) {
  head(`reusing the executor at ${REUSE}`)
  EXEC = REUSE
} else {
  head('deploying InventoryExecutor')
  const nonce = await pub.getTransactionCount({ address: executor.address, blockTag: 'latest' })
  const predicted = getContractAddress({ from: executor.address, nonce: BigInt(nonce) })
  const receipt = await send(
    executorWallet,
    { data: encodeDeployData({ abi: EXEC_ABI, bytecode }) },
    `deployed the executor at ${predicted}`,
  )
  EXEC = receipt.contractAddress!
}
must(
  (await pub.getCode({ address: EXEC })) === runtime,
  'its runtime code is byte for byte the artifact the dry run used',
)

head('checking it holds nothing')
const stockPlsx = await balanceOf(PLSX, EXEC)
const stockUsdc = await balanceOf(USDC, EXEC)
must(
  stockPlsx < deliveredTwo + feeTwo,
  `it holds ${show(PLSX, stockPlsx)}, less than the ${show(PLSX, deliveredTwo + feeTwo)} leg two owes`,
)
must(
  stockUsdc < deliveredOne + feeOne,
  `it holds ${show(USDC, stockUsdc)}, less than the ${show(USDC, deliveredOne + feeOne)} leg one owes`,
)

head('the ring')
const oneBefore = await balanceOf(USDC, makerOne.address)
const twoBefore = await balanceOf(PLSX, makerTwo.address)

await send(
  executorWallet,
  {
    to: EXEC,
    data: encodeFunctionData({ abi: EXEC_ABI, functionName: 'fillRing', args: [reqs, false, maxFeeRate] }),
    gas: 900_000n,
  },
  'settled the ring through fillBatchWithCallback',
)

head('the assertions')
const oneAfter = await balanceOf(USDC, makerOne.address)
const twoAfter = await balanceOf(PLSX, makerTwo.address)

must(
  oneAfter - oneBefore >= ONE_OUT,
  `maker one received ${show(USDC, oneAfter - oneBefore)}, signed for ${show(USDC, ONE_OUT)}`,
)
must(
  twoAfter - twoBefore >= TWO_OUT,
  `maker two received ${show(PLSX, twoAfter - twoBefore)}, signed for ${show(PLSX, TWO_OUT)}`,
)
must(
  (await balanceOf(PLSX, EXEC)) > stockPlsx,
  'and the solver came out ahead in tPLSX, having started with nothing',
)

for (const [label, i] of [
  ['one', one],
  ['two', two],
] as const) {
  const done = (await pub.readContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'filled',
    args: [intentHashOf(i, CHAIN)],
  })) as bigint
  must(done === i.amountIn, `leg ${label} is booked as filled in full`)
}

head('sweeping the contract empty')
for (const t of [PLSX, USDC]) {
  const held = await balanceOf(t, EXEC)
  if (held === 0n) continue
  await send(
    executorWallet,
    {
      to: EXEC,
      data: encodeFunctionData({
        abi: EXEC_ABI,
        functionName: 'sweep',
        args: [t.address, executor.address],
      }),
    },
    `swept ${show(t, held)} back to the executor`,
  )
}
must((await balanceOf(PLSX, EXEC)) === 0n, 'nothing is left behind in the contract')
log(`the executor contract lives at ${EXEC} — reuse it rather than deploying another`)

finish('ring settlement')

/**
 * `fillWithCallback` — the no-inventory path — on chain 943.
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK \
 *     npx tsx scripts/e2e/callback.ts            # dry run only, sends nothing
 *
 *   DEPLOYER_PK=… npx tsx scripts/e2e/callback.ts --deploy
 *
 *   DEPLOYER_PK=… EXECUTOR=0xFAf08834e422f420D5F19292Bb1ECb75e9468687 \
 *     npx tsx scripts/e2e/callback.ts --deploy   # reuse the one already on 943
 *
 * That address is live on testnet 943 and swept empty. Reuse it: a deploy costs 871,342 gas and
 * a second copy buys nothing.
 *
 * **The address here dies with the settlement, so check it before you trust this line.** The one
 * it named until 2026-09-05 was `0xff20A1539A10cB20d255DEd5f5693a7e33331618`, and by then it
 * answered `SETTLEMENT()` with an address two deployments old and reverted on `RELAYER()`
 * outright — it predates the constant. The script's own `getCode === runtime` guard catches that,
 * so a stale line here costs a run rather than a wrong result. It is still a line to re-read
 * after every redeploy.
 *
 * The path needs a contract, because the settlement contract calls its caller back and an EOA
 * cannot answer. `InventoryExecutor.sol` beside this file is that contract: it takes token A,
 * swaps nothing, and repays out of token B it already holds.
 *
 * Two modes, and the default is the harmless one:
 *
 *   dry run   compile the contract, then run the whole fill as one `eth_call` with the compiled
 *             runtime code and a token balance overridden onto an address that has neither. The
 *             settlement contract, the maker's signature, the maker's allowance and the token are
 *             all the real ones on chain. Nothing is sent and nothing is deployed.
 *   --deploy  deploy the contract for real, stock it, fill, assert, and sweep it empty.
 *
 * The dry run is not a substitute for the real thing — an `eth_call` cannot prove a transaction
 * mines — but it does prove the calldata, the callback and the two pulls all line up against live
 * state, which is what usually breaks.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  concat,
  encodeDeployData,
  erc20Abi,
  getContractAddress,
  numberToHex,
  pad,
  parseEther,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from 'viem'
import {
  CURVE_LINEAR,
  SETTLEMENT_ABI,
  ZERO,
  ZERO_HASH,
  signingDomain,
  intentHashOf,
  quote as quoteFill,
  toStruct,
  type Intent,
  signIntent,
} from '@prove.cash/sdk'
import {
  boundFor,
  CHAIN,
  FEE_RATE,
  FEE_CONFIG,
  FEE_TO,
  SETTLEMENT,
  RELAYER,
  balanceOf,
  derive,
  ensureAllowance,
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
  write,
  inventoryExecutorSource,
  redact,
} from './common.js'

const DEPLOY = process.argv.includes('--deploy')

const IN = token('tPLSX')
const OUT = token('tUSDC')

const maker = derive('prove.cash/e2e/callback-maker')
const executor = derive('prove.cash/e2e/executor')
const makerWallet = walletFor(maker)
const executorWallet = walletFor(executor)

const AMOUNT_IN = units(IN, '40')
const RATE = units(OUT, '1.2')

// ── Compile ───────────────────────────────────────────────────────────────────

head('compiling InventoryExecutor')
// The two addresses are bound from the registry, so the source cannot name a stale deployment.
const source = inventoryExecutorSource()
must(source.includes(SETTLEMENT), `the contract targets ${SETTLEMENT}, from the SDK registry`)
must(source.includes(RELAYER), `and approves ${RELAYER}, the relayer the settlement names`)

/** Build the contract in a scratch project, so nothing is written under `contracts/`. */
function compile(): { abi: Abi; bytecode: Hex; runtime: Hex } {
  const root = mkdtempSync(join(tmpdir(), 'prove-callback-'))
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'InventoryExecutor.sol'), source)
  // The same settings as the repository: paris so the bytecode carries no PUSH0.
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
must(runtime.length > 2 && bytecode.length > 2, 'the artifact carries both creation and runtime code')

// ── The intent ────────────────────────────────────────────────────────────────

head('setup')
log(`maker    ${maker.address}`)
log(`executor ${executor.address} (deploys and owns the contract)`)
await topUpGas(maker.address, parseEther('0.1'), 'callback maker')
await topUpGas(executor.address, parseEther('0.3'), 'executor')
await topUpToken(IN, maker.address, AMOUNT_IN, 'callback maker')
await ensureAllowance(makerWallet, IN, AMOUNT_IN, 'maker')

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
  flags: 0,
  nonce: BigInt(Date.now()),
}
const signature = await signIntent(maker, intent, { domain: signingDomain(CHAIN) })
const hash = intentHashOf(intent, CHAIN)
log(`intent ${hash} · ${show(IN, AMOUNT_IN)} for at least ${show(OUT, RATE)}`)

/** What this executor will pay, over every leg it fills. The intent's own rate is inside it. */
const maxFeeRate = boundFor([intent])

const q4 = (await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'quote',
  args: [toStruct(intent), AMOUNT_IN, now],
})) as unknown as { delivered: bigint; feeOut: bigint; feeProceeds: bigint }
const [delivered, fee] = [q4.delivered, q4.feeOut + q4.feeProceeds]
const owed = delivered + fee
log(`the contract will pull ${show(OUT, delivered)} to the maker and ${show(OUT, fee)} to the fee destination`)

// ── The dry run ───────────────────────────────────────────────────────────────

head('dry run — the compiled contract, against live state, without deploying it')

/** Where OpenZeppelin's ERC-20 keeps `_balances[account]`. Slot 0, checked with `forge inspect`. */
const balanceSlot = (who: Address) => keccak256(concat([pad(who, { size: 32 }), pad('0x00', { size: 32 })]))

// An address with no code and no balance, so the override supplies everything.
const ghost = derive('prove.cash/e2e/callback-ghost').address
const overrides = [
  {
    address: ghost,
    code: runtime,
    // Slot 0 is `owner`. The executor has to own it to be allowed to call `fill`.
    stateDiff: [{ slot: pad('0x00', { size: 32 }), value: pad(executor.address, { size: 32 }) }],
  },
  {
    address: OUT.address,
    stateDiff: [{ slot: balanceSlot(ghost), value: pad(numberToHex(owed), { size: 32 }) }],
  },
] as const

// Prove the overrides land before trusting what the fill says.
const ghostCode = await pub.getCode({ address: ghost })
must(!ghostCode, `${ghost} really has no code on chain`)
const ghostBalance = await pub.readContract({
  address: OUT.address,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [ghost],
  stateOverride: overrides as never,
})
must(ghostBalance === owed, `under the override it holds exactly the ${show(OUT, owed)} it owes`)

let dryRun = 'it did not run'
try {
  await pub.simulateContract({
    address: ghost,
    abi: EXEC_ABI,
    functionName: 'fill',
    args: [toStruct(intent), signature, AMOUNT_IN, maxFeeRate],
    account: executor,
    stateOverride: overrides as never,
  } as never)
  dryRun = 'ok'
} catch (e) {
  dryRun = redact((e as Error).message.split('\n').slice(0, 3).join(' / '))
}
must(dryRun === 'ok', `the whole callback fill goes through as an eth_call · ${dryRun}`)

// The same call with the contract one wei short must fail, or the dry run proves nothing.
let short = 'it went through'
try {
  await pub.simulateContract({
    address: ghost,
    abi: EXEC_ABI,
    functionName: 'fill',
    args: [toStruct(intent), signature, AMOUNT_IN, maxFeeRate],
    account: executor,
    stateOverride: [
      overrides[0],
      {
        address: OUT.address,
        stateDiff: [{ slot: balanceSlot(ghost), value: pad(numberToHex(owed - 1n), { size: 32 }) }],
      },
    ] as never,
  } as never)
} catch {
  short = 'reverted'
}
must(short === 'reverted', 'and one wei short of the payment it fails, so the dry run has teeth')

if (!DEPLOY) {
  head('stopping here')
  log('the real run needs a contract on chain. Re-run with --deploy once that is agreed.')
  finish('callback dry run')
}

// ── The real thing ────────────────────────────────────────────────────────────

/**
 * Reuse before deploy. A deploy costs 476,437 gas and the contract is stateless between runs —
 * it is swept empty at the end of every one — so a second copy buys nothing. Pass the address
 * of a previous run's contract and this run skips straight to stocking it.
 *
 * The runtime-code check below is what makes reuse safe: an address carrying anything other than
 * this exact artifact fails there, so a stale or wrong `EXECUTOR` cannot quietly be filled through.
 */
const REUSE = process.env.EXECUTOR?.trim() as Address | undefined

let EXEC: Address
if (REUSE) {
  head(`reusing the executor at ${REUSE}`)
  EXEC = REUSE
} else {
  head('deploying InventoryExecutor')
  const nonce = await pub.getTransactionCount({ address: executor.address, blockTag: 'latest' })
  const predicted = getContractAddress({ from: executor.address, nonce: BigInt(nonce) })
  const deployReceipt = await send(
    executorWallet,
    { data: encodeDeployData({ abi: EXEC_ABI, bytecode }) },
    `deployed the executor at ${predicted}`,
  )
  EXEC = deployReceipt.contractAddress!
  must(EXEC.toLowerCase() === predicted.toLowerCase(), `it landed where CREATE said: ${EXEC}`)
}
must(
  (await pub.getCode({ address: EXEC })) === runtime,
  'and its runtime code is byte for byte the artifact the dry run used',
)

head('stocking it with token B, and nothing else')
await topUpToken(OUT, EXEC, owed, 'the executor contract')
must(
  (await pub.readContract({
    address: OUT.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [EXEC, SETTLEMENT],
  })) === 0n,
  'it has granted the settlement contract nothing yet',
)

head('the fill')
const makerInBefore = await balanceOf(IN, maker.address)
const outBefore = await balanceOf(OUT, maker.address)
// The address the intent named. A fill never pays it — it credits a book the destination claims
// from later — so both halves are read here: the balance that must not move, and the book that must.
const sinkBefore = await balanceOf(OUT, FEE_TO)
const bookedBefore = (await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'pendingFees',
  args: [FEE_CONFIG, OUT.address],
})) as bigint

const { receipt } = await write(
  executorWallet,
  {
    address: EXEC,
    abi: EXEC_ABI,
    functionName: 'fill',
    args: [toStruct(intent), signature, AMOUNT_IN, maxFeeRate],
  },
  'filled through the callback',
)
const at = (await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp

head('the assertions')
// The maker no longer receives what they signed for. `gross` is the executor's outlay and
// `makerFloor` is what is left of it after the fee, which is the only floor the maker gets.
const { gross, delivered: makerFloor } = quoteFill(intent, AMOUNT_IN, at)
const got = (await balanceOf(OUT, maker.address)) - outBefore
must(
  got >= makerFloor,
  `the maker received ${show(OUT, got)}; the fill owed them ${show(OUT, makerFloor)} out of a signed ${show(OUT, gross)}`,
)
must(
  makerInBefore - (await balanceOf(IN, maker.address)) === AMOUNT_IN,
  `${show(IN, AMOUNT_IN)} left the maker`,
)
must(
  (await balanceOf(IN, EXEC)) === AMOUNT_IN,
  'and it is sitting in the executor contract, which bought it with no inventory of token A',
)
// The fee is booked, not sent. `_payFee` pulls it to the settlement and credits
// `_pendingFees[feeConfig][token]`, so no fill ever calls a fee destination and a destination that
// cannot receive the token cannot kill the fill. `claim` is what moves it, and anybody may call
// that. So assert the book grew and the destination did not.
must(
  ((await pub.readContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'pendingFees',
    args: [FEE_CONFIG, OUT.address],
  })) as bigint) -
    bookedBefore ===
    fee,
  `the destination the intent named is owed ${show(OUT, fee)}, booked against the settlement`,
)
must(
  (await balanceOf(OUT, FEE_TO)) === sinkBefore,
  'and the fill sent the destination nothing at all',
)
must(
  (await balanceOf(OUT, EXEC)) === 0n,
  'the contract paid out everything it was stocked with',
)
must(
  (await pub.readContract({
    address: SETTLEMENT,
    abi: SETTLEMENT_ABI,
    functionName: 'filled',
    args: [hash],
  })) === AMOUNT_IN,
  'the intent is booked as filled',
)

head('sweeping the contract empty')
await write(
  executorWallet,
  { address: EXEC, abi: EXEC_ABI, functionName: 'sweep', args: [IN.address, executor.address] },
  `swept ${IN.symbol} back to the executor`,
)
must((await balanceOf(IN, EXEC)) === 0n, 'nothing is left behind in the contract')
log(`the executor contract lives at ${EXEC} — reuse it rather than deploying another`)

finish('callback fill')

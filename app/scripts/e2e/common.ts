/**
 * Shared plumbing for the live testnet exercises in this directory.
 *
 * Each script beside this one drives one settlement path against chain 943 and asserts the same
 * thing at the end: the maker received at least the rate they signed. This file holds only the
 * parts none of them should reinvent — the derived accounts, the gas price, a send that does not
 * believe the RPC, and the token top-ups.
 *
 * Three rules are baked in here on purpose, because breaking them has cost money before:
 *
 *   1. Every throwaway account comes from `derive`, never from `generatePrivateKey`. A run that
 *      dies halfway leaves funds the next run picks straight back up.
 *   2. The gas price is 2 gwei, set explicitly. The node's `eth_gasPrice` has answered 7 wei and
 *      155 gwei minutes apart, so no client here derives a price from it.
 *   3. A send is only failed when the chain says so — and only the chain says which kind of
 *      failure it was. The valve gateway fans one request out to several upstreams and surfaces
 *      the last error, so `eth_sendRawTransaction` reports failure for work that succeeded. But
 *      sometimes it reports failure for work that failed, and a client that ignores the transport
 *      entirely waits out its whole timeout for a receipt that can never come. So `send` asks the
 *      node whether it knows the transaction, and resends when it does not.
 */
import {
  createPublicClient,
  createWalletClient,
  concat,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  keccak256,
  parseAbi,
  parseGwei,
  parseUnits,
  stringToHex,
  type Abi,
  type Account,
  type Address,
  type Hex,
  type TransactionReceipt,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { pulsechainV4 } from 'viem/chains'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  maxFeeRateFor,
  presetTokens,
  settlement,
  setChainId,
  setReaderOverride,
  setSettlementOverride,
  setXykVenuesOverride,
  setRpc,
  PULSEX_FEE_DEN,
  PULSEX_FEE_NUM,
  ZERO,
  type Intent,
  type XykVenue,
  rememberFeeConfig,
  singleFeeConfig,
} from '@prove.cash/sdk'
import { SETTLEMENT_ABI } from '@prove.cash/sdk/settlement'
import { redact, rpcUrl, assertChainId } from '../rpc.ts'

export const CHAIN = 943 as const
export const RPC = rpcUrl(CHAIN)
export const GAS = parseGwei(process.env.GAS_GWEI ?? '2')

const raw = process.env.DEPLOYER_PK?.trim()
if (!raw) throw new Error('DEPLOYER_PK is required')
const funderKey = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex

// The SDK defaults to mainnet. Point every helper that reads `getChainId()` at the testnet
// before anything calls one — `tokenDomain` and `authorizationRequest` both do.
setChainId(CHAIN)
setRpc(RPC, CHAIN, 'board')
setRpc(RPC, CHAIN, 'chain')

/**
 * The settlement these exercises run against.
 *
 * The registry by default, and `PROVE_SETTLEMENT` when one is named — the same variable the
 * deploy scripts take, so a local chain is pointed at the same way a deploy is. With `RPC` this
 * is what lets the whole suite run against an anvil holding a fresh deployment: deterministic,
 * free, and answering in milliseconds instead of waiting on a gateway that is currently
 * returning 502s.
 */
// Told to the SDK, not just held here. `domain()` builds `verifyingContract` from
// `settlement(chainId)`, so overriding only this constant would have every maker sign for the
// registry's address while the exercise called a different one — every signature then fails
// verification and the chain answers `BadSignature`, which reads like a protocol bug and is not
// one. Set the override and the whole SDK agrees: the domain, the approval target, permit2.
const override = process.env.PROVE_SETTLEMENT?.trim()
if (override) setSettlementOverride(CHAIN, override as Address)

export const SETTLEMENT = settlement(CHAIN)
if (SETTLEMENT === ZERO) throw new Error('no settlement in the registry for 943')

// `available` lives on `ProveReader`, not the settlement, and the solver's `loadBook` reads it
// there. A lab deploys its own reader, which the registry cannot name, so it is told the same way
// the settlement is. `app/scripts/lab/up.sh` exports it from `Deploy.s.sol`'s own output.
const readerEnv = process.env.PROVE_READER?.trim()
if (readerEnv) setReaderOverride(CHAIN, readerEnv as Address)

/**
 * The constant-product market these exercises quote against.
 *
 * The registry by default, and `PROVE_XYK_ROUTER` plus `PROVE_XYK_FACTORY` when a run names one —
 * the same shape as `PROVE_SETTLEMENT` above, and for the same reason. The registry's 943 venue is
 * PulseX's testnet deployment, which has no code on a fresh anvil, so every `getPair` went to an
 * empty address and the solver read the whole lab as a chain with no market.
 *
 * Told to the SDK rather than kept here. `loadPools` resolves venues through `xykVenues()`, and so
 * do `xykRouter`, `market.quote` and the app — a constant held in this file would move none of
 * them. `app/scripts/lab/up.sh` exports all four variables from `DeployLabXyk`'s own output.
 */
const xykRouterEnv = process.env.PROVE_XYK_ROUTER?.trim()
const xykFactoryEnv = process.env.PROVE_XYK_FACTORY?.trim()
// Both or neither. A router without its factory is not half an override, it is a venue that
// `confirmVenues` drops on sight — it asks the router which factory it deploys from and refuses
// any answer that is not the recorded one. The run would then report "no pool" for every pair,
// which is the exact silent wrong answer this override exists to prevent.
if (!xykRouterEnv !== !xykFactoryEnv) {
  throw new Error('PROVE_XYK_ROUTER and PROVE_XYK_FACTORY go together; set both or neither')
}

/** The venue in force, once the environment has had its say. Undefined means the registry's. */
export const XYK: XykVenue | undefined =
  xykRouterEnv && xykFactoryEnv
    ? {
        label: 'lab',
        router: xykRouterEnv as Address,
        factory: xykFactoryEnv as Address,
        // The fee lives in the pair and the SDK reads it from here, so a venue has to be
        // registered at the fee it actually charges. The lab's pairs charge none and say so;
        // the default is PulseX's measured 29 basis points, which is what every other venue on
        // both chains takes. Register the lab at that and every quote the SDK computes disagrees
        // with the quote its router gives, in a direction nothing on chain would report.
        feeNum: BigInt(process.env.PROVE_XYK_FEE_NUM ?? PULSEX_FEE_NUM),
        feeDen: BigInt(process.env.PROVE_XYK_FEE_DEN ?? PULSEX_FEE_DEN),
      }
    : undefined
if (XYK) setXykVenuesOverride(CHAIN, [XYK])

/**
 * Nothing leaves this process with the registry key in it, including a crash.
 *
 * `redact` covers what the scripts choose to print. It does not cover what Node prints when
 * nothing catches a throw, and a viem error carries the whole request URL — key and all — in
 * three nested `cause` objects. On 2026-08-28 an unsupported RPC method threw here and printed
 * `/rpc/vk_…/evm/943` straight to the terminal, which is a transcript, which goes places we do
 * not control. That key was already on the rotate list from the last time this happened.
 *
 * So the guard is at the process edge, where every exercise inherits it, rather than at each
 * call site where the next script would forget it.
 */
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err: unknown) => {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
    console.error(redact(text))
    process.exit(1)
  })
}

export const pub = createPublicClient({ chain: pulsechainV4, transport: http(RPC) })

/*
 * Ask the node what chain it is on, before anything reads from it.
 *
 * `RPC` replaces the whole URL and the chain id beside it stays a literal, so the two can point
 * this run at another chain's node. Every read then comes back well-formed and about somewhere
 * else. One round trip settles it, and `assertChainId` says why at length.
 */
await assertChainId(pub, CHAIN)

/**
 * The address everyone approves. Read from the settlement, never from configuration.
 *
 * The settlement holds no allowance from anyone: every `transferFrom` it makes goes through
 * `ProveRelayer.pull`. So a maker approves this for `tokenIn` and an executor approves it for
 * `tokenOut`, and there is no second address to get wrong.
 */
export const RELAYER = await pub.readContract({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  functionName: 'relayer',
})

/**
 * The helper contract's source, with both of its addresses rewritten to this deployment's.
 *
 * `InventoryExecutor` names the settlement and the relayer as compile-time constants rather than
 * constructor arguments. It has to: the dry run installs its runtime code with a state override,
 * and a state override never runs a constructor, so an `immutable` would read as zero. Constants
 * cannot be passed in, so they are patched here.
 *
 * They used to be edited by hand, and every redeploy left them naming the deployment before it.
 * A check caught that, which is better than not catching it and worse than not needing it.
 */
export function inventoryExecutorSource(): string {
  const raw = readFileSync(new URL('./InventoryExecutor.sol', import.meta.url), 'utf8')
  assertIntentStructMatches(raw)
  const bind = (src: string, name: string, address: Address) => {
    const pattern = new RegExp(`(address public constant ${name} = )0x[0-9a-fA-F]{40}`)
    if (!pattern.test(src)) throw new Error(`InventoryExecutor.sol declares no ${name} constant`)
    return src.replace(pattern, `$1${address}`)
  }
  return bind(bind(raw, 'SETTLEMENT', SETTLEMENT), 'RELAYER', RELAYER)
}

/**
 * The helper's own `Intent` is a copy, and a copy of a struct has no compiler to tell it when the
 * original moves. It had `int16 feeBps` long after the rate became a `uint64` fraction of one
 * ether, and then missed `minFill` and `authNonce` on top — so `viem` encoded sixteen fields into
 * a fourteen-field tuple and threw `Cannot convert undefined to a BigInt`, which names nothing.
 *
 * This compares the copy against the settlement's own ABI, field by field, in order. It is the
 * cheapest possible check and it would have saved two deployments' worth of a silently broken
 * exercise.
 */
function assertIntentStructMatches(src: string): void {
  // Field names in order, from the settlement's own ABI. Names rather than types, because a
  // struct member reads as `Intent intent` in Solidity and `tuple` in an ABI — and a drift that
  // adds, removes or reorders a field always changes the names.
  const argOf = (fn: string, arg: number) => {
    const f = SETTLEMENT_ABI.find((e) => e.type === 'function' && e.name === fn)
    const input = f && 'inputs' in f ? f.inputs[arg] : undefined
    const c = input && 'components' in input ? input.components : []
    return (c as readonly { name: string }[]).map((x) => x.name)
  }

  for (const [name, want] of [
    ['Intent', argOf('fill', 0)],
    ['FillRequest', argOf('fillBatch', 0)],
  ] as const) {
    const body = src.match(new RegExp(`struct ${name} \\{([\\s\\S]*?)\\n    \\}`))
    if (!body) throw new Error(`InventoryExecutor.sol declares no ${name} struct`)
    const have = [
      ...body[1].matchAll(/^\s*[A-Za-z_][A-Za-z0-9_]*(?:\[\])?\s+([A-Za-z_][A-Za-z0-9_]*);/gm),
    ].map((m) => m[1])
    if (have.join(', ') !== want.join(', ')) {
      throw new Error(
        `InventoryExecutor.sol has drifted from ProveSettlement.${name}.\n` +
          `  it declares: ${have.join(', ')}\n` +
          `  the ABI says: ${want.join(', ')}`,
      )
    }
  }
}

export const funder = privateKeyToAccount(funderKey)
export const funderWallet = createWalletClient({
  account: funder,
  chain: pulsechainV4,
  transport: http(RPC),
})

/**
 * Derived from the funding key plus a role salt, never generated. These addresses are the same
 * on every run, so a crashed run leaves money the next run reuses instead of abandoning it.
 *
 * `stringToHex`, not `stringToBytes`. viem's `concat` dispatches on the first element: a hex
 * string sends the whole list to `concatHex`, which calls `.replace` on each member, and a
 * `Uint8Array` second member throws `x.replace is not a function`. `e2e-testnet.ts` line 79 has
 * that shape and cannot get past it under viem 2.55. The bytes here are what that line meant.
 */
export const derive = (role: string) =>
  privateKeyToAccount(keccak256(concat([funderKey, stringToHex(role)])))

export const walletFor = (account: Account) =>
  createWalletClient({ account, chain: pulsechainV4, transport: http(RPC) })

// ── Output ────────────────────────────────────────────────────────────────────

export const log = (m: string) => console.log(`  ${m}`)
export const head = (m: string) => console.log(`\n${m}`)

let failures = 0

/** Assert, and say so either way. A failed assertion does not stop the script — it is recorded
 *  and reported at the end, so one broken step still leaves the rest of the evidence behind. */
export function must(ok: boolean, message: string) {
  if (ok) console.log(`  [ok]   ${message}`)
  else {
    failures++
    console.log(`  [FAIL] ${message}`)
  }
}

export const failureCount = () => failures

// ── Tokens ────────────────────────────────────────────────────────────────────

const faucetAbi = parseAbi([
  'function claim() returns (uint256)',
  'function nextClaimAt(address) view returns (uint64)',
  'function claimAmount() view returns (uint256)',
])

export type Token = { address: Address; symbol: string; decimals: number }

/**
 * The batch executor for this chain, from the deployment record.
 *
 * Six lab scripts used to default this to a hard-coded `0x59b670e9…`, which appears in no
 * deployment record on any chain — 943 is `0x8E76F3eA…` and 369 is `0xA20EF4De…`. Anyone running
 * one of them without setting `PROVE_BATCH_EXECUTOR` called an address with no code, and a call
 * to an address with no code returns SUCCESS with empty data rather than reverting. So the run
 * failed somewhere further along, wearing a different error.
 *
 * The env var still wins, for pointing a script at a build that is not the recorded one. What is
 * gone is the silent fallback: with no record and no override this throws, here, before a send.
 */
export const BATCH_EXECUTOR: Address = (() => {
  const override = process.env.PROVE_BATCH_EXECUTOR?.trim()
  if (override) return override as Address
  const record = JSON.parse(readFileSync(`../contracts/deployments/${CHAIN}.json`, 'utf8'))
  const address = record?.contracts?.ProveBatchExecutor as string | undefined
  if (!address) {
    throw new Error(
      `no ProveBatchExecutor in contracts/deployments/${CHAIN}.json — deploy one, or set PROVE_BATCH_EXECUTOR`,
    )
  }
  return address as Address
})()

/** A preset token by symbol. Throws rather than guessing, so a typo fails before a send. */
/**
 * Token addresses from a deployment file, when one is named by `PROVE_TOKENS`.
 *
 * `DeployTestTokens` writes `config/deployed.<chainid>.json`, so a local run has its own six
 * tokens at its own addresses. The decimals still come from the registry, because the deployment
 * file records addresses only and the two lists carry the same symbols by construction.
 */
const deployed: Record<string, string> | null = (() => {
  const path = process.env.PROVE_TOKENS?.trim()
  if (!path) return null
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
})()

export function token(symbol: string): Token {
  const t = presetTokens(CHAIN).find((x) => x.symbol === symbol)
  if (!t) throw new Error(`no preset token ${symbol} on chain ${CHAIN}`)
  const address = (deployed?.[symbol] ?? t.address) as Address
  return { address, symbol: t.symbol, decimals: t.decimals }
}

/**
 * Every preset token at this run's address, for the solver's `unpricedOk`.
 *
 * Since `700fd3c` (2026-09-28) `planOf` drops a plan whose profit has no native price whenever a
 * gas price is set, unless the profit token is listed as allowed unpriced. A lab has no price
 * book, so every ring the lab scripts found was dropped and each reported "the solver found no
 * ring at all", which read like a ring-finding bug. These scripts test finding and settling
 * rings, not pricing them, so they list every lab token.
 */
export const UNPRICED_OK: readonly Address[] = presetTokens(CHAIN).map((t) => token(t.symbol).address)

export const units = (t: Token, whole: string) => parseUnits(whole, t.decimals)
export const show = (t: Token, v: bigint) => `${formatUnits(v, t.decimals)} ${t.symbol}`

export const balanceOf = (t: Token, who: Address) =>
  pub.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [who] })

// ── Spending ──────────────────────────────────────────────────────────────────

let burned = 0n
/** Every wei of gas this process has paid, across every account it drives. */
export const gasBurned = () => burned

/**
 * Sign here, send, and then ask the chain. The transport's answer is advisory; the receipt is
 * the fact. The nonce comes from `latest` rather than `pending` because every send waits for
 * its receipt, and a pending nonce that the gateway invented would jam the account.
 */
export async function send(
  wallet: ReturnType<typeof walletFor>,
  args: { to?: Address; data?: Hex; value?: bigint; gas?: bigint },
  label: string,
): Promise<TransactionReceipt> {
  const account = wallet.account!
  const nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'latest' })
  const gas =
    args.gas ??
    ((await pub.estimateGas({
      account: account.address,
      to: args.to,
      data: args.data,
      value: args.value,
    })) *
      13n) /
      10n

  const serialized = await wallet.signTransaction({
    to: args.to,
    data: args.data,
    value: args.value,
    gas,
    gasPrice: GAS,
    nonce,
    type: 'legacy',
  } as never)
  const hash = keccak256(serialized)

  /*
   * Send, then let the chain decide — but do not wait out the clock on one that never landed.
   *
   * The gateway fans a request out to several upstreams and surfaces the last error, so a
   * reported failure proves nothing and this used to ignore it and wait for a receipt. That is
   * right exactly half the time. When a send genuinely fails the transaction is in no mempool,
   * no receipt can ever arrive, and the wait burns its whole timeout before saying so — which is
   * how a ring run died after four minutes on a transaction the node had never heard of.
   *
   * So the node's own view is the arbiter. If it does not know the transaction after a few
   * blocks, send it again: same nonce, same bytes, same hash, so a duplicate is harmless and a
   * genuine loss is repaired.
   */
  let receipt: TransactionReceipt | null = null
  for (let attempt = 1; attempt <= 3 && !receipt; attempt++) {
    try {
      await pub.sendRawTransaction({ serializedTransaction: serialized })
    } catch {
      if (attempt === 1) log(`(the RPC reported a failure for ${label} — asking the chain instead)`)
    }
    receipt = await pub
      .waitForTransactionReceipt({ hash, timeout: 45_000, pollingInterval: 2_000 })
      .catch(() => null)
    if (receipt) break
    const known = await pub.getTransaction({ hash }).catch(() => null)
    if (known) {
      // It is in a mempool and simply slow. Wait it out rather than resending.
      receipt = await pub.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 2_000 })
      break
    }
    log(`(${label} reached no mempool — sending it again, attempt ${attempt + 1})`)
  }
  if (!receipt) throw new Error(`${label} never reached the chain · ${hash}`)

  burned += receipt.gasUsed * receipt.effectiveGasPrice
  if (receipt.status !== 'success') throw new Error(`${label} reverted on chain · ${hash}`)
  log(`${label} · gas ${receipt.gasUsed} · ${hash}`)
  return receipt
}

/** Simulate a contract call, then send exactly what was simulated. The simulation is what turns
 *  a bare revert into a named error, so nothing here ever pays for a revert it could have read. */
export async function write(
  wallet: ReturnType<typeof walletFor>,
  call: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
  label: string,
): Promise<{ receipt: TransactionReceipt; result: unknown }> {
  const sim = await pub.simulateContract({
    address: call.address,
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
    account: wallet.account!,
    gasPrice: GAS,
  } as never)
  const data = encodeFunctionData({
    abi: call.abi,
    functionName: call.functionName,
    args: call.args,
  } as never)
  const receipt = await send(wallet, { to: call.address, data }, label)
  return { receipt, result: (sim as { result: unknown }).result }
}

// ── Funding ───────────────────────────────────────────────────────────────────

/** Top an account up to `need` PLS from the funder, and only by the difference. */
export async function topUpGas(who: Address, need: bigint, role: string) {
  const held = await pub.getBalance({ address: who })
  if (held >= need) {
    log(`${role} ${who} holds ${formatUnits(held, 18)} PLS`)
    return
  }
  await send(funderWallet, { to: who, value: need - held }, `funded ${role} ${who}`)
}

/**
 * Make sure `who` holds `need` of `t`, drawing on the funder and, if the funder is short, on the
 * token's own faucet. The faucet is one drip per address per cooldown, so this can run out; it
 * says which token and how much rather than failing inside a transfer.
 */
export async function topUpToken(t: Token, who: Address, need: bigint, role: string) {
  let held = await balanceOf(t, who)
  if (held >= need) {
    log(`${role} holds ${show(t, held)}`)
    return
  }
  const short = need - held

  let funderHas = await balanceOf(t, funder.address)
  if (funderHas < short) {
    const readyAt = await pub.readContract({
      address: t.address,
      abi: faucetAbi,
      functionName: 'nextClaimAt',
      args: [funder.address],
    })
    if (BigInt(Math.floor(Date.now() / 1000)) >= readyAt) {
      await write(
        funderWallet,
        { address: t.address, abi: faucetAbi as unknown as Abi, functionName: 'claim', args: [] },
        `claimed the ${t.symbol} drip`,
      )
      funderHas = await balanceOf(t, funder.address)
    }
  }
  if (funderHas < short) {
    throw new Error(
      `the funder holds ${show(t, funderHas)} and needs ${show(t, short)}; the faucet is on cooldown`,
    )
  }

  await write(
    funderWallet,
    {
      address: t.address,
      abi: erc20Abi as unknown as Abi,
      functionName: 'transfer',
      args: [who, short],
    },
    `sent ${role} ${show(t, short)}`,
  )
  held = await balanceOf(t, who)
  log(`${role} holds ${show(t, held)}`)
}

/** Approve `spender` for `amount` when the allowance falls short, else nothing. */
export async function ensureAllowance(
  wallet: ReturnType<typeof walletFor>,
  t: Token,
  amount: bigint,
  role: string,
  spender: Address = RELAYER,
) {
  const owner = wallet.account!.address
  const current = await pub.readContract({
    address: t.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [owner, spender],
  })
  if (current >= amount) return
  await write(
    wallet,
    {
      address: t.address,
      abi: erc20Abi as unknown as Abi,
      functionName: 'approve',
      args: [spender, amount],
    },
    `${role} approved the relayer for ${t.symbol}`,
  )
}

// ── Resumable state ───────────────────────────────────────────────────────────

/**
 * A two-phase run needs its intent to survive between processes, and the file must not live in
 * the repository: a sibling agent's `git commit` takes the whole index, and this is not theirs
 * to carry.
 */
const STATE_DIR = join(homedir(), '.cache', 'prove.cash-e2e')

export function saveState(name: string, value: unknown) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(
    join(STATE_DIR, `${name}.json`),
    JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2),
  )
}

export function loadState<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(STATE_DIR, `${name}.json`), 'utf8'), (_k, v) =>
      typeof v === 'string' && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
    ) as T
  } catch {
    return null
  }
}

// ── Timing ────────────────────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** The chain's clock, not this machine's. Every deadline the contract checks reads from here. */
export async function chainNow(): Promise<bigint> {
  const block = await pub.getBlock({ blockTag: 'latest' })
  return block.timestamp
}

/** Close out a script: report the gas it burned and exit non-zero if anything failed. */
/**
 * Print the tally and stop. **This never returns**, on success or failure.
 *
 * It used to return on success, and `ring.ts` read as if it did not: its `--deploy` gate called
 * `finish('ring dry run')` and then fell straight through into deploying a contract and settling
 * a real ring. A function that ends a run on one path and not the other is a trap, so it now ends
 * it on both. Every call site is already the last statement of its script.
 */
export function finish(title: string): never {
  head(`${formatUnits(gasBurned(), 18)} PLS of gas burned by this run`)
  if (failures > 0) {
    console.log(`\n${title}: ${failures} assertion(s) FAILED\n`)
    process.exit(1)
  }
  console.log(`\n${title}: every assertion held, on chain ${CHAIN}.\n`)
  process.exit(0)
}

/** Re-exported so an e2e file can print an error without printing the registry key. */
export { redact }

/**
 * The `maxFeeRate` to send with a fill of these intents.
 *
 * It is the dearest rate any of them charges. An intent signs its own `feeRate` and nothing on
 * chain raises it, so a bound under the dearest leg makes `fillBatch` step over that leg and
 * `fill` revert `FeeTooHigh`. Computing it from the intents rather than writing a generous
 * constant is what makes these scripts notice a rate they did not expect instead of paying it.
 */
export const boundFor = (intents: readonly Intent[]): bigint => maxFeeRateFor(intents)

/**
 * The fee terms every e2e intent signs: a destination, and ten basis points to send there.
 *
 * They have to be real. A fee goes to the `feeTo` the intent named and nowhere else — the
 * settlement has no address of its own and earns nothing from a fill — so an intent naming
 * `ZERO` charges nothing at all, and a script asserting a fee was paid would assert zero equals
 * zero and pass on a broken contract.
 */
export const FEE_TO: Address = '0x00000000000000000000000000000000000feeee'
/**
 * The fee config the lab's intents name: one destination, all the weight. A hash, as an intent
 * carries it, and remembered rather than only hashed: `signIntent` signs typed data with the
 * config's preimage in it, and refuses a hash it has never seen the preimage of.
 */
export const FEE_CONFIG: Hex = rememberFeeConfig(singleFeeConfig(FEE_TO))
export const FEE_RATE = 1_000_000_000_000_000n

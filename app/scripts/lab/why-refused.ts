/**
 * Why the chain refuses the rings the solver is finding.
 *
 *   VALVE_RPC_KEY=… DEPLOYER_PK=… npx tsx scripts/lab/why-refused.ts
 *
 * The live 943 solver reports `the chain refuses it: The contract function "settleRing" reverted`
 * on every candidate, which is a revert with no data behind it and therefore no answer. The
 * settlement has one: `dryRun` reverts on purpose, carrying one reason per leg, so it separates
 * "this leg cannot fill" from "the executor's route does not work" — and those want different
 * fixes.
 *
 * Reads only. `eth_call` throughout; nothing is signed and nothing is sent.
 */
import type { Address, Hex } from 'viem'
import { readFileSync } from 'node:fs'
import { decodeIntent, readIntents, verifyIntent } from '@prove.cash/sdk'
import {
  chainDryRunner,
  confirm,
  loadBook,
  routeFor,
  settleRingCall,
  solve,
} from '@prove.cash/sdk/solver'
import { CHAIN, RPC, funder, log, head, pub } from '../e2e/common.ts'
import { SOLVER_BATCH_EXECUTOR_ABI } from '@prove.cash/sdk/solver'
import { SETTLEMENT_ABI } from '@prove.cash/sdk/settlement'
import { toFunctionSelector } from 'viem'

/** Every error either contract declares, by selector, so a revert can be named rather than shrugged at. */
const KNOWN = new Map<string, string>()
for (const abi of [SOLVER_BATCH_EXECUTOR_ABI, SETTLEMENT_ABI]) {
  for (const item of abi as readonly { type: string; name?: string }[]) {
    if (item.type !== 'error') continue
    KNOWN.set(toFunctionSelector(item as never), item.name ?? '?')
  }
}

const deployment = JSON.parse(readFileSync('../contracts/deployments/943.json', 'utf8'))
const BATCH_EXECUTOR = deployment.contracts.ProveBatchExecutor as Address

/** The revert bytes out of a viem error, wherever they are nested. */
function revertData(e: unknown): Hex | null {
  let cur: unknown = e
  for (let i = 0; i < 8 && cur; i++) {
    const c = cur as { data?: unknown; cause?: unknown }
    if (typeof c.data === 'string' && c.data.startsWith('0x')) return c.data as Hex
    if (c.data && typeof (c.data as { data?: unknown }).data === 'string') {
      return (c.data as { data: Hex }).data
    }
    cur = c.cause
  }
  return null
}

const deployed = JSON.parse(
  readFileSync('../contracts/config/deployed.943.json', 'utf8'),
) as Record<string, Address>
const symbolOf = new Map(Object.entries(deployed).map(([s, a]) => [a.toLowerCase(), s] as const))
const name = (a: Address) => symbolOf.get(a.toLowerCase()) ?? `${a.slice(0, 8)}…`

head('the board')
const raw = await readIntents(RPC)
const decoded = raw
  .map((m: { data: Hex }) => decodeIntent(m.data))
  .filter((i): i is NonNullable<typeof i> => i !== null)
const verified = []
for (const i of decoded) if (await verifyIntent(i, CHAIN)) verified.push(i)
log(`${raw.length} messages · ${decoded.length} decoded · ${verified.length} verified`)

const { book, rejected } = await loadBook(verified, { client: pub, chainId: CHAIN, executor: funder.address })
log(`${book.entries.length} live on chain · ${rejected.length} rejected`)
for (const r of rejected.slice(0, 5)) log(`  rejected: ${JSON.stringify(r).slice(0, 120)}`)

head('what the solver finds')
const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
const plans = solve(book, {
  at: now,
  executor: funder.address,
  gasPrice: 1_000_000_000n,
  minNetNative: 0n,
  maxLegs: 3,
})
log(`${plans.length} plan(s)`)

head('what the settlement says about each')
const run = chainDryRunner({ client: pub, chainId: CHAIN, account: funder.address })
for (const plan of plans.slice(0, 6)) {
  const shape = plan.fills
    .map((f) => `${name(f.intent.tokenIn)}→${name(f.intent.tokenOut)}`)
    .join(' · ')
  const c = await confirm(run, plan.fills, plan.maxFeeRate)
  log(`${shape}`)
  for (let k = 0; k < plan.fills.length; k++) {
    const f = plan.fills[k]
    log(
      `    leg ${k}  take ${f.take}  maker ${f.intent.maker.slice(0, 10)}…  ` +
        `→ ${c.reasons[k] ?? 'no answer'}`,
    )
  }
  log(`    ${c.ok ? 'every leg is fillable — the refusal is in the executor, not the legs' : 'the settlement itself refuses'}`)

  // The credit call itself, as raw calldata, so the revert's own bytes can be read. `reasonOf`
  // gives back "the contract function reverted" when there is nothing to decode, and the
  // difference between "no data" and "data this ABI does not know" is the whole diagnosis.
  if (!c.ok || !BATCH_EXECUTOR) continue
  const opts = {
    account: funder.address,
    chainId: CHAIN,
    client: pub,
    batchExecutor: BATCH_EXECUTOR,
  }
  const call = settleRingCall(
    BATCH_EXECUTOR,
    plan.fills,
    plan.maxFeeRate,
    routeFor(plan, opts, now + 600n),
  )
  try {
    await pub.simulateContract({
      account: funder.address,
      address: call.address,
      abi: call.abi,
      functionName: call.functionName,
      args: call.args,
    } as never)
    log('    the executor accepts it')
  } catch (e) {
    const data = revertData(e)
    log(`    executor reverts · data ${data ? `${data.slice(0, 74)} (${(data.length - 2) / 2} bytes)` : 'NONE'}`)
    if (data) {
      const known = KNOWN.get(data.slice(0, 10))
      log(`    selector ${data.slice(0, 10)} — ${known ?? 'not an error this ABI declares'}`)
    }
  }
}

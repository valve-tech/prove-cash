/**
 * Hold `contracts/config/fee-configs.json` to the chain it describes.
 *
 *   npx tsx scripts/check-fee-configs.ts     # or: npm run check:fee-configs
 *
 * The file is a CI MIRROR of `FeeDefaults`, not its authority: the chain is. It is append-only,
 * `Deploy.s.sol` reads the stray config and the last history entry from it, and the SDK registry
 * (`sdk/src/config.ts`) carries a copy that `sdk/src/fee-configs.registry.test.ts` holds to it.
 * This is the third leg: the file against the chain's own `DefaultsSet` logs.
 *
 * Two modes, by what the file says:
 *
 *   `feeDefaults: null`   nothing is deployed. The file is checked against itself: every config
 *                         valid (1 to 8 destinations, weights summing to one WAD, no zero or
 *                         duplicate destination), every rate within one WAD, every id unique.
 *   an address            the history is read from the chain's `DefaultsSet` logs and must equal
 *                         the file's, entry for entry and in order. A file that is behind the
 *                         chain, or ahead of it, or edited in the middle, fails.
 *
 * The RPC comes from `PROVECASH_RPC_<chainId>` (or the SDK's registry endpoint). A missing RPC is
 * a skip with a message for a chain that has an address, never a pass: a check that cannot ask
 * the chain says so.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, parseAbiItem, type Address } from 'viem'
import { feeConfigFault, hashFeeConfig } from '@prove.cash/sdk'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, '../../contracts/config/fee-configs.json')

const WAD = 10n ** 18n

type Rates = { handover: string; output: string; proceeds: string }
export type HistoryEntry = {
  id: string
  destinations: string[]
  weights: string[]
  rates: Rates
  warn: Rates
  label: string
  since: string
}
export type ChainEntry = {
  feeDefaults: string | null
  strayConfig: { destinations: string[]; weights: string[] }
  history: HistoryEntry[]
}

/** Every fault in the file's own content, as sentences. Empty means self-consistent. */
export function selfFaults(chain: string, e: ChainEntry): string[] {
  const out: string[] = []
  const cfg = (c: { destinations: string[]; weights: string[] }) => ({
    destinations: c.destinations as Address[],
    weights: c.weights.map(BigInt),
  })
  const stray = feeConfigFault(cfg(e.strayConfig))
  if (stray !== 'None') out.push(`${chain}: the stray config is invalid (${stray})`)
  const ids = new Set<string>()
  e.history.forEach((h, i) => {
    const where = `${chain}: history[${i}] (${h.id})`
    const fault = feeConfigFault(cfg(h))
    if (fault !== 'None') out.push(`${where} is an invalid config (${fault})`)
    if (ids.has(h.id)) out.push(`${where} repeats an id`)
    ids.add(h.id)
    for (const set of ['rates', 'warn'] as const) {
      for (const p of ['handover', 'output', 'proceeds'] as const) {
        if (BigInt(h[set][p]) > WAD) out.push(`${where}: ${set}.${p} is above one WAD`)
      }
    }
  })
  if (e.history.length === 0) out.push(`${chain}: no history, so the deploy has no initial defaults`)
  return out
}

const DEFAULTS_SET = parseAbiItem(
  'event DefaultsSet(uint256 indexed version, bytes32 indexed defaultsHash, bytes32 indexed feeConfig, (uint64 handover, uint64 output, uint64 proceeds) rates, (uint64 handover, uint64 output, uint64 proceeds) warn, address[] destinations, uint256[] weights)',
)

async function chainFaults(chain: string, e: ChainEntry, rpc: string): Promise<string[]> {
  const client = createPublicClient({ transport: http(rpc) })
  // Gateways cap eth_getLogs ranges (~100k). Prefer the deploy record's FeeDefaults block,
  // then PROVECASH_FEE_LOGS_FROM_<chain>, then 0.
  let fromBlock = 0n
  const envFrom = process.env[`PROVECASH_FEE_LOGS_FROM_${chain}`]
  if (envFrom) fromBlock = BigInt(envFrom)
  else {
    try {
      const rec = JSON.parse(
        readFileSync(join(HERE, `../../contracts/deployments/${chain}.json`), 'utf8'),
      ) as { blocks?: { FeeDefaults?: number } }
      if (rec.blocks?.FeeDefaults) fromBlock = BigInt(rec.blocks.FeeDefaults)
    } catch {
      /* no record */
    }
  }
  const logs = await client.getLogs({
    address: e.feeDefaults as Address,
    event: DEFAULTS_SET,
    fromBlock,
    toBlock: 'latest',
  })
  const out: string[] = []
  const onChain = logs
    .map((l) => l.args)
    .sort((a, b) => Number(a.version! - b.version!))
  if (onChain.length !== e.history.length) {
    out.push(`${chain}: the chain has ${onChain.length} versions and the file has ${e.history.length}`)
  }
  onChain.forEach((a, i) => {
    const h = e.history[i]
    if (!h) return
    const want = hashFeeConfig({ destinations: h.destinations as Address[], weights: h.weights.map(BigInt) })
    const same =
      a.feeConfig === want &&
      String(a.rates!.handover) === h.rates.handover &&
      String(a.rates!.output) === h.rates.output &&
      String(a.rates!.proceeds) === h.rates.proceeds &&
      String(a.warn!.handover) === h.warn.handover &&
      String(a.warn!.output) === h.warn.output &&
      String(a.warn!.proceeds) === h.warn.proceeds
    if (!same) out.push(`${chain}: version ${i} on chain differs from history[${i}] (${h.id})`)
  })
  return out
}

async function main(): Promise<number> {
  const file = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, ChainEntry | string>
  const faults: string[] = []
  const notes: string[] = []
  for (const [chain, v] of Object.entries(file)) {
    if (chain.startsWith('_')) continue
    const e = v as ChainEntry
    faults.push(...selfFaults(chain, e))
    if (e.feeDefaults === null) {
      notes.push(`${chain}: no FeeDefaults deployed; checked the file against itself`)
      continue
    }
    const rpc = process.env[`PROVECASH_RPC_${chain}`]
    if (!rpc) {
      notes.push(`${chain}: SKIPPED, FeeDefaults is at ${e.feeDefaults} but PROVECASH_RPC_${chain} is not set`)
      continue
    }
    faults.push(...(await chainFaults(chain, e, rpc)))
  }
  for (const n of notes) console.log(n)
  if (faults.length > 0) {
    for (const f of faults) console.error(`FAIL ${f}`)
    return 1
  }
  console.log('fee-configs.json is consistent')
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main())
}

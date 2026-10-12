/**
 * Watchdog. Reads what the other bots produce and says when the chain of custody breaks.
 *
 *   npx tsx scripts/watchdog.ts --chain 943 --interval 120
 *
 * Env:
 *   RPC        override the chain RPC.
 *   BOARD_RPC  override the msgboard RPC.
 *   SETTLEMENT override the settlement address, for a fork or for a chain whose address is
 *              deployed but not yet in the registry.
 *   WEBHOOK    POST every alert here as JSON, as well as printing it.
 *   OWN_MAKERS our bots' maker addresses, comma-separated (or `--own`). A bad signature or a
 *              `BadTerms` from one of them is BROKEN; from anybody else it is only a WARN.
 *
 * It checks five things, in the order they would break:
 *
 *   1. The board is enabled and answering.
 *   2. Every message in our category decodes and its signature verifies. A message that does
 *      not is a codec change, somebody probing, or ours signed for a retired settlement (WARN).
 *   3. The archive has kept up with the live board. Anything the board holds and the archive
 *      has not seen after a grace period is data we are about to lose.
 *   4. Once settlement is deployed: every Filled event paid the maker at least the signed rate.
 *      This is the one that matters. It recomputes the rate from the signed terms rather than
 *      asking the contract what it thinks it paid.
 *   5. The board still accepts work, proved by reading the difficulty rather than by posting.
 *
 * It exits non-zero on a broken invariant so a supervisor notices. A degraded dependency —
 * archive down, RPC flaky — is a warning, not an exit: the watchdog must not cry wolf. Nor is a
 * stranger's bad message: anybody can post to the board. The checks live in
 * `watchdog-checks.ts`, where a test drives each one. The last block checked goes to disk, so a
 * restart picks up where the last run stopped.
 */
import './guard'
import { join } from 'node:path'
import { createPublicClient, decodeEventLog, type Address, type Hex } from 'viem'
import {
  PROVECASH_CATEGORY,
  SETTLEMENT_ABI,
  board,
  decodeIntent,
  readFillability,
  isSupportedChain,
  network,
  setChainId,
  setRpc,
  setRpcLinked,
  setSettlementOverride,
  settlement,
  verifyIntent,
  type ChainId,
} from '@prove.cash/sdk'
import { onSharedKey, describe, assertChainId, boardEndpoint, rpcEndpoint, rpcTransport, registerEndpoint } from './rpc.ts'
import { assertSettlement } from './deployment.ts'
import { stateDir } from './state.ts'
import { createWatch, loadLastBlock, retiredBy, retiredSettlements, saveLastBlock, verifyForSettlement, type FilledLog } from './watchdog-checks.ts'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const chainId = Number(arg('chain', '943')) as ChainId
if (!isSupportedChain(chainId)) throw new Error(`unknown chain ${chainId}`)
const intervalMs = Number(arg('interval', '120')) * 1000
const archiveLagGrace = Number(arg('archive-grace', '600')) * 1000

const chainRpc = registerEndpoint(rpcEndpoint(chainId)) // the key rides in a header, not the path
const boardRpc = registerEndpoint(boardEndpoint(chainRpc))
const ARCHIVE = 'https://archive.msgboard.xyz/v1/graphql'

// The SDK resolves the settlement address and the endpoints from its own registry.
setChainId(chainId)
setRpcLinked(false, chainId)
setRpc(boardRpc.url, chainId, 'board')
setRpc(chainRpc.url, chainId, 'chain')
// Before the read, never after. A settlement can be live on a chain whose registry entry is
// still zero, and the watchdog is exactly the bot that should be watching it first.
if (process.env.SETTLEMENT) setSettlementOverride(chainId, process.env.SETTLEMENT as Address)
const SETTLEMENT = settlement(chainId)

const chain = network(chainId).chain
const client = createPublicClient({ chain, transport: rpcTransport(chainRpc) })

/*
 * Ask the node what chain it is on, before anything reads from it.
 *
 * `RPC` replaces the whole URL and the chain id beside it stays a literal, so the two can point
 * this run at another chain's node. Every read then comes back well-formed and about somewhere
 * else. One round trip settles it, and `assertChainId` says why at length.
 */
await assertChainId(client, chainId)

// Refuse a settlement that hashes intents differently from this SDK. `assertSettlement` says why.
await assertSettlement(client, chainId, SETTLEMENT, Boolean(process.env.SETTLEMENT))

const msgboard = board(boardRpc.url)

/** `fillability` answers for one executor. Any address does — no terms question depends on it. */
const PROBE_EXECUTOR = '0x0000000000000000000000000000000000000001' as const

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (m: string) => console.log(`${stamp()}  ${m}`)

let broken = false

async function alert(level: 'WARN' | 'BROKEN', what: string, detail: unknown = {}) {
  log(`${level} ${what} ${JSON.stringify(detail)}`)
  if (level === 'BROKEN') broken = true
  const hook = process.env.WEBHOOK
  if (!hook) return
  try {
    await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level, what, chainId, at: new Date().toISOString(), detail }),
    })
  } catch {
    log('WARN the webhook itself is unreachable')
  }
}

/** First seen in the archive, keyed by message hash. */
async function archiveHashes(): Promise<Set<string> | null> {
  try {
    const res = await fetch(ARCHIVE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query:
          'query($c:Int!){ message_archive(where:{category_text:{_eq:"provecash"}, chain_id:{_eq:$c}}, order_by:{first_seen_at:desc}, limit:500){ hash } }',
        variables: { c: chainId },
      }),
    })
    const json = (await res.json()) as { data?: { message_archive?: { hash: string }[] } }
    const rows = json.data?.message_archive
    if (!rows) return null
    return new Set(rows.map((r) => r.hash.toLowerCase()))
  } catch {
    return null
  }
}

/** The settlement's `Filled` events in a range. Anything else it logs is not a fill. */
async function fillLogs(fromBlock: bigint, toBlock: bigint): Promise<FilledLog[]> {
  const logs = await client.getLogs({ address: SETTLEMENT, fromBlock, toBlock })
  const out: FilledLog[] = []
  for (const entry of logs) {
    let ev: { eventName: string; args: Record<string, unknown> }
    try {
      ev = decodeEventLog({ abi: SETTLEMENT_ABI, ...entry }) as unknown as typeof ev
    } catch {
      continue
    }
    if (ev.eventName !== 'Filled') continue
    out.push({
      blockNumber: entry.blockNumber,
      transactionHash: entry.transactionHash,
      intentHash: ev.args.intentHash as Hex,
      take: ev.args.take as bigint,
      delivered: ev.args.delivered as bigint,
    })
  }
  return out
}

import record943 from '../../contracts/deployments/943.json' with { type: 'json' }
import record369 from '../../contracts/deployments/369.json' with { type: 'json' }

/**
 * The settlements this chain retired, from its deployment record, never typed here. After a
 * redeploy our makers' last intents stay on the board signed for the old domain until they end.
 */
const RECORD: { _superseded?: unknown; deployedAt?: unknown } =
  ({ 943: record943, 369: record369 } as Record<number, object>)[chainId] ?? {}
const RETIRED = retiredSettlements(RECORD)

const own = new Set(
  arg('own', process.env.OWN_MAKERS ?? '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a)),
)

const watch = createWatch({
  settlement: SETTLEMENT,
  own,
  alert,
  log,
  decode: decodeIntent,
  verify: (i) => verifyIntent(i, chainId),
  fillability: (i) => readFillability(i, 1n, PROBE_EXECUTOR, { client, chainId }),
  retired: RETIRED,
  verifyFor: (i, s) => verifyForSettlement(i, chainId, s),
  retiredBy: retiredBy(RECORD),
  chainNow: async () => (await client.getBlock({ blockTag: 'latest' })).timestamp,
  hashIntent: async (i) =>
    (await client.readContract({
      address: SETTLEMENT,
      abi: SETTLEMENT_ABI,
      functionName: 'hashIntent',
      args: [i],
    })) as Hex,
  status: () => msgboard.status(),
  archiveHashes,
  fillLogs,
  blockTime: async (blockNumber) => (await client.getBlock({ blockNumber })).timestamp,
  archiveGraceMs: archiveLagGrace,
  nowMs: () => Date.now(),
})

/**
 * Where the last checked block is kept: systemd's state directory, or the working directory.
 * Without it a restart began at the head and never checked the fills in between.
 */
const LAST_BLOCK_FILE = join(stateDir() ?? '.', `watchdog-${chainId}.json`)
/** The widest `getLogs` range asked for at once, so a long gap after a restart stays readable. */
const MAX_RANGE = 2_000n

let lastBlock: bigint | null = loadLastBlock(LAST_BLOCK_FILE)

async function tick() {
  broken = false
  const status = await watch.checkBoard()
  if (!status) return

  const content = await msgboard.content({ category: PROVECASH_CATEGORY })
  const messages = content[PROVECASH_CATEGORY] ?? []
  await watch.checkMessages(messages)
  await watch.checkTerms(messages)
  await watch.rememberIntents(messages)
  await watch.checkArchive(messages.map((m) => m.hash))

  const head = await client.getBlock({ blockTag: 'latest' })
  if (lastBlock !== null && head.number > lastBlock) {
    for (let from = lastBlock + 1n; from <= head.number; from += MAX_RANGE) {
      const to = from + MAX_RANGE - 1n < head.number ? from + MAX_RANGE - 1n : head.number
      await watch.checkFills(from, to)
      lastBlock = to
    }
  } else {
    lastBlock = head.number
  }
  try {
    saveLastBlock(LAST_BLOCK_FILE, lastBlock)
  } catch (e) {
    await alert('WARN', 'the last checked block could not be saved', { file: LAST_BLOCK_FILE, error: describe(e) })
  }
  watch.prune(head.timestamp, messages.map((m) => m.hash))

  log(
    `ok · board ${BigInt(status.count)} messages · ours ${messages.length} · ` +
      `known intents ${watch.knownIntents.size} · head ${head.number}`,
  )
  if (broken) {
    log('a broken invariant was reported this pass — exiting non-zero')
    process.exit(3)
  }
}

log(`watchdog starting · chain ${chainId} (${network(chainId).label})`)
if (onSharedKey()) log('rpc: on the shared vk_demo key — set VALVE_RPC_KEY, this competes with the website')
log(
  `settlement ${SETTLEMENT === '0x0000000000000000000000000000000000000000' ? 'not deployed — fill checks are off' : SETTLEMENT}`,
)
log(
  own.size > 0
    ? `own makers ${own.size} · their bad output is BROKEN, a stranger's is a WARN`
    : 'own makers none — set OWN_MAKERS; until then a bad signature or BadTerms is only a WARN',
)
log(`retired settlements on record ${RETIRED.length} · a leftover signed for one is a WARN until it ends`)
log(lastBlock === null ? 'no last block on record · starting at the head' : `resuming after block ${lastBlock}`)

for (;;) {
  try {
    await tick()
  } catch (e) {
    await alert('WARN', 'the watchdog pass itself failed', {
      error: describe(e),
    })
  }
  await new Promise((r) => setTimeout(r, intervalMs))
}

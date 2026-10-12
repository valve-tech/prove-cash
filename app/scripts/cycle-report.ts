/**
 * Does the whole thing cycle? One window of blocks, read end to end.
 *
 *   npx tsx scripts/cycle-report.ts --chain 943 --minutes 30
 *   npx tsx scripts/cycle-report.ts --chain 943 --blocks 500
 *   npx tsx scripts/cycle-report.ts --from 25199000 --to 25199400
 *
 * Env:
 *   RPC             a whole endpoint. A fork, a local node.
 *   VALVE_RPC_KEY   the registry key. Without it this runs on `vk_demo` and competes with the
 *                   website for its rate limit.
 *   DEPLOYER_PK     optional, and read only to derive the bots' addresses so the report can name
 *                   them. Nothing is signed and nothing is sent. Without it the bots still appear,
 *                   by address, because every `Filled` event names its own executor.
 *
 * **Why this exists.** Five bots run against 943 and each one logs that its own step worked. None
 * of them can say the loop is closed, because none of them sees the other end: the heartbeat does
 * not know whether anything filled, the executor does not know whether the maker was paid the
 * signed rate, and nothing at all watches where the interface fee lands. A green log from every
 * bot is four true statements that still permit a broken system.
 *
 * So this reads the chain instead of the bots. One `eth_getBlockReceipts` per block in the window
 * gives every receipt, every log, every sender and every revert, and the whole report is built
 * from that one pass:
 *
 *   posted    what the board is carrying, and how much of it is ours
 *   filled    every Filled event, by executor, with the volume each side moved
 *   fees      the fee each fill charged, and the address the token actually reached
 *   makers    what the signed terms owed, recomputed, against what the contract delivered
 *   spent     gas per actor, and how much of it went on transactions that reverted
 *   flow      net token movement per actor, so a capital-neutral bot can prove it is
 *
 * It exits 1 when an invariant is broken — a maker short-changed, a fee that went somewhere
 * nobody named — and 0 on a quiet window. A quiet window is not a pass: "nothing filled" is
 * printed as its own verdict, because a loop that is merely idle looks exactly like a loop that
 * is dead, and the difference is the whole question.
 */
import {
  concat,
  createPublicClient,
  decodeEventLog,
  formatEther,
  formatUnits,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  PROVECASH_CATEGORY,
  SETTLEMENT_ABI,
  board,
  decodeIntent,
  feeTarget,
  intentHashOf,
  isSupportedChain,
  minOutAt,
  network,
  presetTokens,
  setChainId,
  setRpc,
  setRpcLinked,
  settlement,
  tokenInfo,
  ZERO,
  type ChainId,
  type SignedIntent,
  type TokenInfo,
} from '@prove.cash/sdk'
import { rpcLabel, rpcUrl, assertChainId } from './rpc.ts'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const chainId = Number(arg('chain', '943')) as ChainId
if (!isSupportedChain(chainId)) throw new Error(`chain ${chainId} is not in the registry`)

const chainRpc = rpcUrl(chainId)
setChainId(chainId)
setRpcLinked(false, chainId)
setRpc(chainRpc, chainId, 'board')
setRpc(chainRpc, chainId, 'chain')

const SETTLEMENT = settlement(chainId)
if (SETTLEMENT === ZERO) {
  console.log(`settlement is not deployed on chain ${chainId}. Nothing to report.`)
  process.exit(0)
}

const chain = network(chainId).chain
const client = createPublicClient({ chain, transport: http(chainRpc) })

// The node has to be on this chain. `RPC` replaces the whole URL while the chain id beside it
// stays put, so the two can silently disagree and every read comes back about somewhere else.
await assertChainId(client, chainId)

const msgboard = board(chainRpc)

// ── Who is who ───────────────────────────────────────────────────────────────
// A label makes the difference between a report and a wall of hex. The bots' addresses come from
// the deployer key by the same derivation the bots themselves use, so this can never drift from
// the accounts actually running; without the key, an address is simply printed.

const SALTS = ['executor', 'solver', 'mover', 'heartbeat'] as const
const names = new Map<string, string>()
const note = (a: Address | string, label: string) => names.set(a.toLowerCase(), label)

const raw = process.env.DEPLOYER_PK?.trim()
if (raw) {
  const deployerKey = (raw.startsWith('0x') ? raw : `0x${raw}`) as Hex
  note(privateKeyToAccount(deployerKey).address, 'deployer')
  for (const salt of SALTS) {
    const key = keccak256(concat([deployerKey, stringToHex(`prove.cash/${salt}`)]))
    note(privateKeyToAccount(key).address, salt)
  }
}

const label = (a: Address | string) => {
  const known = names.get(a.toLowerCase())
  return known ? `${known} ${short(a)}` : short(a)
}
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`

// ── The window ───────────────────────────────────────────────────────────────
// Three ways to name it, because the three questions are different: "is it running right now"
// wants minutes, "what did that deploy do" wants an explicit range, and a block count is what a
// second run wants so it measures the same amount of chain as the first.

const head = await client.getBlockNumber()
const explicitFrom = process.argv.indexOf('--from')
let fromBlock: bigint
let toBlock = head

if (explicitFrom >= 0) {
  fromBlock = BigInt(arg('from', '0'))
  toBlock = BigInt(arg('to', head.toString()))
} else if (process.argv.includes('--blocks')) {
  fromBlock = head - BigInt(arg('blocks', '300')) + 1n
} else {
  // Blocks per minute, measured rather than assumed: 943's target and its actual rate differ,
  // and a window computed from the wrong constant reports on the wrong stretch of chain.
  const minutes = Number(arg('minutes', '30'))
  const sample = 200n
  const [now, then] = await Promise.all([
    client.getBlock({ blockNumber: head }),
    client.getBlock({ blockNumber: head - sample }),
  ])
  const secondsPerBlock = Number(now.timestamp - then.timestamp) / Number(sample)
  fromBlock = head - BigInt(Math.ceil((minutes * 60) / secondsPerBlock))
}
if (fromBlock < 0n) fromBlock = 0n

// ── One pass over the window ─────────────────────────────────────────────────
// `eth_getBlockReceipts` is the whole data source. A receipt carries the sender, the gas, the
// price, the status and every log, so one call per block answers what fills happened, who paid
// for them, what moved, and — the part `eth_getLogs` cannot answer at all — which transactions
// reverted. A reverted transaction emits nothing, so a report built from logs alone is a report
// that cannot see failure.

type Receipt = {
  from: Address
  to: Address | null
  status: Hex
  gasUsed: Hex
  effectiveGasPrice: Hex
  transactionHash: Hex
  blockNumber: Hex
  logs: { address: Address; topics: Hex[]; data: Hex }[]
}

/** Fetch in small waves. One endpoint, and a burst of six hundred calls is how you get throttled. */
async function blockReceipts(from: bigint, to: bigint): Promise<Receipt[]> {
  const out: Receipt[] = []
  const width = 8
  for (let n = from; n <= to; n += BigInt(width)) {
    const wave: Promise<Receipt[]>[] = []
    for (let i = 0; i < width && n + BigInt(i) <= to; i++) {
      const block = n + BigInt(i)
      wave.push(
        client
          .request({
            method: 'eth_getBlockReceipts' as never,
            params: [`0x${block.toString(16)}`] as never,
          })
          .then((r) => (r as Receipt[] | null) ?? []),
      )
    }
    for (const part of await Promise.all(wave)) out.push(...part)
  }
  return out
}

console.log(`prove.cash · chain ${chainId} (${network(chainId).label}) · ${rpcLabel(chainId)}`)
console.log(`settlement ${SETTLEMENT}`)
console.log(`reading blocks ${fromBlock}–${toBlock} …`)

const receipts = await blockReceipts(fromBlock, toBlock)
const [first, last] = await Promise.all([
  client.getBlock({ blockNumber: fromBlock }),
  client.getBlock({ blockNumber: toBlock }),
])
const spanS = Number(last.timestamp - first.timestamp)

// ── Tokens ───────────────────────────────────────────────────────────────────
// Amounts are printed in the token's own units or not at all. A tPLSX figure rendered at 18
// decimals next to a tUSDC figure rendered at 18 is two numbers that cannot be compared, and the
// executor's log did exactly that until it was fixed.

const tokens = new Map<string, TokenInfo>()
for (const t of presetTokens(chainId)) tokens.set(t.address.toLowerCase(), t)

async function metaFor(address: Address): Promise<TokenInfo | null> {
  const key = address.toLowerCase()
  const known = tokens.get(key)
  if (known) return known
  const fetched = await tokenInfo(chainId, address, client)
  if (fetched) tokens.set(key, fetched)
  return fetched
}

const amount = (wei: bigint, t: TokenInfo | null) =>
  t ? `${formatUnits(wei, t.decimals)} ${t.symbol}` : `${wei} (unknown token)`

// ── What the board is carrying ───────────────────────────────────────────────

const status = await msgboard.status()
const content = await msgboard.content({ category: PROVECASH_CATEGORY })
const messages = content[PROVECASH_CATEGORY] ?? []
const intents = new Map<string, SignedIntent>()
for (const m of messages) {
  const decoded = decodeIntent(m.data as Hex)
  if (decoded) intents.set(intentHashOf(decoded, chainId).toLowerCase(), decoded)
}

// ── Fills ────────────────────────────────────────────────────────────────────

type Fill = {
  tx: Hex
  block: bigint
  executor: Address
  maker: Address
  intentHash: Hex
  tokenIn: Address
  tokenOut: Address
  take: bigint
  delivered: bigint
  fee: bigint
}

const TRANSFER = keccak256(stringToHex('Transfer(address,address,uint256)'))
const fills: Fill[] = []
/** tx hash → the ERC-20 transfers it made, so a fee can be followed to the address it reached. */
const transfersByTx = new Map<string, { token: Address; from: string; to: string; value: bigint }[]>()

for (const r of receipts) {
  for (const l of r.logs) {
    if (l.address.toLowerCase() === SETTLEMENT.toLowerCase()) {
      let ev: { eventName: string; args: Record<string, unknown> }
      try {
        ev = decodeEventLog({ abi: SETTLEMENT_ABI, data: l.data, topics: l.topics as never }) as never
      } catch {
        continue
      }
      if (ev.eventName !== 'Filled') continue
      fills.push({
        tx: r.transactionHash,
        block: BigInt(r.blockNumber),
        executor: ev.args.executor as Address,
        maker: ev.args.maker as Address,
        intentHash: ev.args.intentHash as Hex,
        tokenIn: ev.args.tokenIn as Address,
        tokenOut: ev.args.tokenOut as Address,
        take: ev.args.take as bigint,
        delivered: ev.args.delivered as bigint,
        fee: ev.args.fee as bigint,
      })
    } else if (l.topics[0] === TRANSFER && l.topics.length === 3) {
      const list = transfersByTx.get(r.transactionHash) ?? []
      list.push({
        token: l.address,
        from: `0x${l.topics[1]!.slice(26)}`.toLowerCase(),
        to: `0x${l.topics[2]!.slice(26)}`.toLowerCase(),
        value: BigInt(l.data),
      })
      transfersByTx.set(r.transactionHash, list)
    }
  }
}

for (const f of fills) {
  await metaFor(f.tokenIn)
  await metaFor(f.tokenOut)
}

// ── Report ───────────────────────────────────────────────────────────────────

const rule = (title: string) => console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`)

console.log(
  `window ${toBlock - fromBlock + 1n} blocks · ${(spanS / 60).toFixed(1)} min · ` +
    `${receipts.length} transactions`,
)

rule('the board')
console.log(`  ${status.enabled ? 'accepting posts' : 'CLOSED to posts'}`)
console.log(`  ${messages.length} messages in our category · ${intents.size} decode as intents`)

rule('fills')
if (fills.length === 0) {
  console.log('  none in this window')
} else {
  const byExecutor = new Map<string, Fill[]>()
  for (const f of fills) {
    const k = f.executor.toLowerCase()
    byExecutor.set(k, [...(byExecutor.get(k) ?? []), f])
  }
  console.log(`  ${fills.length} fills · ${byExecutor.size} executors · ${intents.size} on the board`)
  for (const [addr, list] of byExecutor) {
    console.log(`  ${label(addr)}  ${list.length} fills`)
  }

  // Volume by token, both sides. `take` is what left the maker, `delivered` is what reached them.
  const moved = new Map<string, bigint>()
  for (const f of fills) {
    const a = f.tokenIn.toLowerCase()
    const b = f.tokenOut.toLowerCase()
    moved.set(a, (moved.get(a) ?? 0n) + f.take)
    moved.set(b, (moved.get(b) ?? 0n) + f.delivered)
  }
  console.log('  volume')
  for (const [addr, total] of moved) {
    console.log(`    ${amount(total, tokens.get(addr) ?? null)}`)
  }
}

rule('fees')
if (fills.length === 0) {
  console.log('  nothing charged')
} else {
  // Two readings of the same money, and they have to agree. The event says what the contract
  // charged; the ERC-20 transfer says which address actually received it. A fee that is charged
  // and lands nowhere we named is the failure this section exists to catch.
  const charged = new Map<string, bigint>()
  for (const f of fills) {
    if (f.fee === 0n) continue
    const k = f.tokenOut.toLowerCase()
    charged.set(k, (charged.get(k) ?? 0n) + f.fee)
  }

  const landed = new Map<string, bigint>() // `${destination}:${token}` → total
  for (const f of fills) {
    if (f.fee === 0n) continue
    for (const t of transfersByTx.get(f.tx) ?? []) {
      if (t.token.toLowerCase() !== f.tokenOut.toLowerCase()) continue
      if (t.value !== f.fee) continue
      const k = `${t.to}:${t.token.toLowerCase()}`
      landed.set(k, (landed.get(k) ?? 0n) + t.value)
    }
  }

  const expected = feeTarget(chainId).toLowerCase()
  note(expected, 'the fee destination')
  console.log(`  charged`)
  for (const [addr, total] of charged) console.log(`    ${amount(total, tokens.get(addr) ?? null)}`)
  console.log(`  landed`)
  if (landed.size === 0) console.log('    nothing matched a transfer')
  for (const [k, total] of landed) {
    const [to, token] = k.split(':') as [string, string]
    console.log(`    ${label(to)}  ${amount(total, tokens.get(token) ?? null)}`)
  }
}

rule('makers')
// The invariant the whole protocol rests on. Recomputed from the signed terms at the block's own
// timestamp — a decaying intent that lands a second late is owed a shade less, not the same — and
// checked against what the contract says it delivered.
let checked = 0
let short_changed = 0
for (const f of fills) {
  const intent = intents.get(f.intentHash.toLowerCase())
  if (!intent) continue
  checked++
  const block = await client.getBlock({ blockNumber: f.block })
  const rate = minOutAt(intent, block.timestamp)
  const owed = (f.take * rate + intent.amountIn - 1n) / intent.amountIn
  if (f.delivered < owed) {
    short_changed++
    console.log(`  SHORT ${label(f.maker)} owed ${owed}, received ${f.delivered} · ${f.tx}`)
  }
}
if (fills.length === 0) console.log('  no fills to check')
else if (checked === 0) console.log(`  terms known for 0 of ${fills.length} fills — the board has aged past them`)
else if (short_changed === 0) console.log(`  ${checked} of ${fills.length} fills checked against signed terms · all paid in full`)

rule('what the actors spent')
// Gas, and how much of it bought nothing. A bot that reverts half its transactions is running,
// and is not working — the distinction a per-bot log never makes, because a bot that reverts
// still writes a line saying it tried.
type Spend = { txs: number; reverted: number; gas: bigint; wei: bigint }
const spend = new Map<string, Spend>()
for (const r of receipts) {
  const k = r.from.toLowerCase()
  if (!names.has(k) && !fills.some((f) => f.executor.toLowerCase() === k)) continue
  const s = spend.get(k) ?? { txs: 0, reverted: 0, gas: 0n, wei: 0n }
  s.txs++
  if (r.status !== '0x1') s.reverted++
  s.gas += BigInt(r.gasUsed)
  s.wei += BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice)
  spend.set(k, s)
}
if (spend.size === 0) console.log('  none of our accounts sent anything')
for (const [addr, s] of spend) {
  const bad = s.reverted > 0 ? ` · ${s.reverted} REVERTED` : ''
  console.log(`  ${label(addr)}  ${s.txs} txs${bad} · ${s.gas} gas · ${formatEther(s.wei)} PLS`)
}

rule('token flow')
// Net movement per actor, from the transfers themselves. A ring solver is capital-neutral by
// design, so a balance that walks in one direction is the first sign it is not settling what it
// thinks it is. This needs no archive node: the window's own transfers are the whole answer.
const flow = new Map<string, Map<string, bigint>>()
const bump = (who: string, token: string, delta: bigint) => {
  if (!names.has(who)) return
  const m = flow.get(who) ?? new Map<string, bigint>()
  m.set(token, (m.get(token) ?? 0n) + delta)
  flow.set(who, m)
}
for (const list of transfersByTx.values()) {
  for (const t of list) {
    const token = t.token.toLowerCase()
    bump(t.from, token, -t.value)
    bump(t.to, token, t.value)
  }
}
if (flow.size === 0) console.log('  no token moved to or from an account we know')
for (const [who, m] of flow) {
  const parts: string[] = []
  for (const [token, delta] of m) {
    if (delta === 0n) continue
    const meta = tokens.get(token) ?? (await metaFor(token as Address))
    parts.push(`${delta > 0n ? '+' : ''}${amount(delta, meta)}`)
  }
  console.log(`  ${label(who)}  ${parts.length ? parts.join('  ') : 'flat'}`)
}

rule('verdict')
// A quiet window is not a pass. "Nothing filled" looks exactly like "nothing can fill", and the
// difference is the only question this report was written to answer, so it is never rolled into
// an ok.
const broken: string[] = []
if (short_changed > 0) broken.push(`${short_changed} fills paid a maker less than the signed rate`)
if (!status.enabled) broken.push('the board is not accepting posts')

if (broken.length > 0) {
  for (const b of broken) console.log(`  BROKEN · ${b}`)
  process.exit(1)
}
if (fills.length === 0) {
  console.log(`  QUIET · the board holds ${messages.length} messages and nothing filled in ${(spanS / 60).toFixed(0)} min.`)
  console.log('  That is a loop that is idle or a loop that is dead. Widen the window to tell them apart.')
} else {
  console.log(`  CYCLING · ${fills.length} fills, makers paid in full, fees accounted for.`)
}

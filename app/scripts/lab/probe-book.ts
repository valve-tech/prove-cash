/**
 * Which pairs the live board actually carries.
 *
 *   VALVE_RPC_KEY=… DEPLOYER_PK=… npx tsx scripts/lab/probe-book.ts
 *
 * The heartbeat is configured with three markets on 943 and the board is what came of that. Those
 * are different questions: a pair the bot cannot price is a pair it quotes nothing on, and nothing
 * says so out loud. A three-leg ring needs a CYCLE in this graph, so the shape of what is here is
 * the thing to measure before seeding anything.
 *
 * Reads only.
 */
import { decodeIntent, readIntents } from '@prove.cash/sdk'
import { CHAIN, log, RPC } from '../e2e/common.ts'
import { readFileSync } from 'node:fs'
import type { Address, Hex } from 'viem'

const deployed = JSON.parse(
  readFileSync('../contracts/config/deployed.943.json', 'utf8'),
) as Record<string, Address>
const symbolOf = new Map(
  Object.entries(deployed).map(([s, a]) => [a.toLowerCase(), s] as const),
)
const name = (a: Address) => symbolOf.get(a.toLowerCase()) ?? `${a.slice(0, 8)}…`

const messages = await readIntents(RPC)
const intents = messages
  .map((m: { data: Hex }) => decodeIntent(m.data))
  .filter((i): i is NonNullable<typeof i> => i !== null)
log(`chain ${CHAIN} · ${messages.length} message(s) · ${intents.length} decoded as intents`)
log('')

const edges = new Map<string, number>()
for (const i of intents) {
  const k = `${name(i.tokenIn)} → ${name(i.tokenOut)}`
  edges.set(k, (edges.get(k) ?? 0) + 1)
}
log('directed edges on the board:')
for (const [k, n] of [...edges].sort()) log(`  ${k}  ×${n}`)

log('')
log('what each offer says:')
for (const i of intents) {
  log(`  ${name(i.tokenIn)} → ${name(i.tokenOut)}  amountIn ${i.amountIn}`)
}

// A three-leg ring needs a directed cycle of length three. Say whether one exists.
const out = new Map<string, Set<string>>()
for (const i of intents) {
  const a = name(i.tokenIn)
  const b = name(i.tokenOut)
  if (!out.has(a)) out.set(a, new Set())
  out.get(a)!.add(b)
}
const cycles: string[] = []
for (const [a, bs] of out)
  for (const b of bs)
    for (const c of out.get(b) ?? [])
      if (c !== a && (out.get(c)?.has(a) ?? false)) cycles.push(`${a} → ${b} → ${c} → ${a}`)
log('')
log(cycles.length ? `three-leg cycles: ${[...new Set(cycles)].join(', ')}` : 'no three-leg cycle')

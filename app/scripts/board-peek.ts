/**
 * What the board holds right now. Read-only — it grinds nothing and writes nothing.
 *
 * Useful when a post is refused: if messages are landing, the node is taking somebody's work and
 * this client is the odd one out. An empty board says the opposite. Pair it with `pow-probe.ts`,
 * which tells you which end is behind.
 *
 * Run with `npx tsx scripts/board-peek.ts`, or `CHAIN=369 npx tsx scripts/board-peek.ts`.
 */
import { board as boardClient, boardContent, PROVECASH_CATEGORY } from '@prove.cash/sdk'
import { rpcLabel, rpcUrl } from './rpc.ts'

const CHAIN = Number(process.env.CHAIN ?? 943)
const board = boardClient(rpcUrl(CHAIN))

console.log('endpoint', rpcLabel(CHAIN))

const status = await board.status()
console.log('enabled ', status.enabled, ' messages', String(status.count))

const categories = await board.categories()
console.log('categories', categories.length)

const content = await boardContent(0n, rpcUrl(CHAIN))
const ours = content[PROVECASH_CATEGORY] ?? []
console.log('prove.cash', ours.length, 'messages')

for (const m of ours.slice(0, 10)) {
  const row = m as unknown as { blockNumber?: string; data?: string }
  console.log('  block', String(row.blockNumber ?? '?'), ' bytes', ((row.data ?? '').length - 2) / 2)
}

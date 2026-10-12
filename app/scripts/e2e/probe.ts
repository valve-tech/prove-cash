/**
 * What the exercise starts from, and what it leaves behind.
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK \
 *     npx tsx scripts/e2e/probe.ts
 *
 * Read-only. It sends nothing, so it is safe to run before, between and after the paths, and the
 * difference between two runs is the honest answer to "what did this cost".
 */
import { formatUnits } from 'viem'
import { CHAIN, SETTLEMENT, balanceOf, derive, funder, head, log, pub, token } from './common.js'

const ROLES = [
  'prove.cash/e2e/maker',
  'prove.cash/e2e/executor',
  'prove.cash/e2e/escrow-maker',
  'prove.cash/e2e/gasless-maker',
  'prove.cash/e2e/partial-maker',
  'prove.cash/e2e/batch-maker',
  'prove.cash/e2e/callback-maker',
  'prove.cash/e2e/solver',
] as const

const TOKENS = ['tPLSX', 'tUSDC', 'tUSDT', 'tWETH'].map(token)

head(`chain ${CHAIN} · settlement ${SETTLEMENT}`)
log(`block ${await pub.getBlockNumber()}`)

head('accounts')
const accounts = [
  ['funder', funder.address] as const,
  ...ROLES.map((r) => [r.replace('prove.cash/e2e/', ''), derive(r).address] as const),
]
for (const [role, address] of accounts) {
  const pls = await pub.getBalance({ address })
  const nonce = await pub.getTransactionCount({ address, blockTag: 'latest' })
  const held: string[] = []
  for (const t of TOKENS) {
    const b = await balanceOf(t, address)
    if (b > 0n) held.push(`${formatUnits(b, t.decimals)} ${t.symbol}`)
  }
  log(
    `${role.padEnd(16)} ${address} · ${formatUnits(pls, 18).padStart(14)} PLS · ${nonce} tx` +
      (held.length ? ` · ${held.join(', ')}` : ''),
  )
}
console.log()

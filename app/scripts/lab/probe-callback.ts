/**
 * Which `proveBatchCallback` the deployed settlement calls, and which the executor answers to.
 *
 *   VALVE_RPC_KEY=... DEPLOYER_PK=... npx tsx scripts/lab/probe-callback.ts [0xExecutor]
 *
 * `Payment` gained a leg index for the partial-settlement work, so the callback's selector moved
 * with it. The settlement calls the executor and the executor has no fallback, so a settlement
 * from before that change calls a function the new executor does not carry — and the whole ring
 * reverts with no data at all, which is what the live solver reports and what nothing else can
 * tell apart from an ordinary failure.
 *
 * Reads only.
 */
import type { Address, Hex } from 'viem'
import { readFileSync } from 'node:fs'
import { head, log, pub } from '../e2e/common.ts'

const OLD = '0x3b357c3e' // proveBatchCallback((address,address,uint256,uint256,address)[],bytes)
const NEW = '0xc988788e' // ...,uint256)[],bytes)  — Payment gained `leg`

const d = JSON.parse(readFileSync('../contracts/deployments/943.json', 'utf8'))
const SETTLEMENT = d.contracts.ProveSettlement as Address
const EXECUTOR = (process.argv[2] ?? d.contracts.ProveBatchExecutor) as Address

const has = (code: Hex, sel: string) => code.includes(sel.slice(2))

head('the settlement')
const s = await pub.getCode({ address: SETTLEMENT })
if (!s) throw new Error('no code at the settlement')
log(`${SETTLEMENT}  ${(s.length - 2) / 2} bytes`)
log(`  calls the OLD callback ${OLD}: ${has(s, OLD)}`)
log(`  calls the NEW callback ${NEW}: ${has(s, NEW)}`)

head('the executor')
const e = await pub.getCode({ address: EXECUTOR })
if (!e) throw new Error('no code at the executor')
log(`${EXECUTOR}  ${(e.length - 2) / 2} bytes`)
log(`  answers the OLD callback ${OLD}: ${has(e, OLD)}`)
log(`  answers the NEW callback ${NEW}: ${has(e, NEW)}`)

head('verdict')
if (has(s, NEW) === has(e, NEW)) log('they agree — the blank revert is something else')
else {
  log('THEY DISAGREE. The settlement calls one selector and the executor answers the other, so')
  log('every credit ring reverts with no data. Both halves have to move together.')
}

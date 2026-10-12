/**
 * What has actually settled against the deployed settlement.
 *
 *   VALVE_RPC_KEY=... DEPLOYER_PK=... npx tsx scripts/lab/probe-fills.ts [blocksBack]
 *
 * A solver log saying `settled` is the solver's claim. This is the chain's. It reads the
 * settlement's own `Filled` events, so a ring that reverted after the log line cannot appear and
 * one that landed cannot be missed.
 *
 * Reads only.
 */
import { formatUnits, type Address } from 'viem'
import { readFileSync } from 'node:fs'
import { SETTLEMENT_ABI } from '@prove.cash/sdk/settlement'
import { head, log, pub } from '../e2e/common.ts'

const d = JSON.parse(readFileSync('../contracts/deployments/943.json', 'utf8'))
const SETTLEMENT = d.contracts.ProveSettlement as Address
const back = BigInt(process.argv[2] ?? 2000)

const deployed = JSON.parse(
  readFileSync('../contracts/config/deployed.943.json', 'utf8'),
) as Record<string, Address>
const symbolOf = new Map(Object.entries(deployed).map(([s, a]) => [a.toLowerCase(), s] as const))
const decimalsOf: Record<string, number> = {
  tPLSX: 18, tUSDC: 6, tUSDT: 6, tHEX: 8, tWBTC: 8, tWETH: 18,
}
const name = (a: Address) => symbolOf.get(a.toLowerCase()) ?? `${a.slice(0, 8)}...`

const tip = await pub.getBlockNumber()
head(`fills against ${SETTLEMENT}`)
log(`blocks ${tip - back} to ${tip}`)

const logs = await pub.getContractEvents({
  address: SETTLEMENT,
  abi: SETTLEMENT_ABI,
  eventName: 'Filled',
  fromBlock: tip - back,
  toBlock: tip,
})

if (logs.length === 0) {
  log('none')
} else {
  const byTx = new Map<string, typeof logs>()
  for (const l of logs) {
    const k = l.transactionHash ?? ''
    if (!byTx.has(k)) byTx.set(k, [] as never)
    byTx.get(k)!.push(l as never)
  }
  log(`${logs.length} fill(s) in ${byTx.size} transaction(s)`)
  for (const [hash, group] of byTx) {
    const legs = group
      .map((l) => {
        const a = (l.args as { tokenIn?: Address; tokenOut?: Address }).tokenIn
        const b = (l.args as { tokenIn?: Address; tokenOut?: Address }).tokenOut
        return a && b ? `${name(a)}->${name(b)}` : '?'
      })
      .join(' . ')
    log(`  ${group.length === 1 ? '1 leg ' : `${group.length} legs`}  ${legs}  ${hash}`)
  }
}

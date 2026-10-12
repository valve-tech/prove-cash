/** Did this transaction land? A gateway that reports failure for work that mined is why. */
import type { Hex } from 'viem'
import { log, pub } from '../e2e/common.ts'

const hash = process.argv[2] as Hex | undefined
if (!hash) throw new Error('usage: probe-tx.ts 0xHash')
try {
  const r = await pub.getTransactionReceipt({ hash })
  log(`${r.status} · block ${r.blockNumber} · gas ${r.gasUsed} · contract ${r.contractAddress ?? '-'}`)
} catch {
  log('no receipt: the transaction is not on chain')
}

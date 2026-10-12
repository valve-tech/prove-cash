/**
 * Whether the deployed ProveBatchExecutor is the one this SDK is built against.
 *
 *   VALVE_RPC_KEY=… DEPLOYER_PK=… npx tsx scripts/lab/probe-executor.ts
 *
 * A contract with no fallback reverts with NO DATA when it is called on a selector it does not
 * have — which is exactly what the live solver reports: `settleRing reverted` and nothing behind
 * it. `Route` and `Swap` grew fields for the partial-settlement work, so the selector moved, and a
 * struct change is invisible to everything except this comparison.
 *
 * Reads only.
 */
import { toFunctionSelector, type Address, type Hex } from 'viem'
import { SOLVER_BATCH_EXECUTOR_ABI } from '@prove.cash/sdk/solver'
import { readFileSync } from 'node:fs'
import { head, log, pub } from '../e2e/common.ts'

const deployment = JSON.parse(readFileSync('../contracts/deployments/943.json', 'utf8'))
const EXECUTOR = (process.argv[2] ?? deployment.contracts.ProveBatchExecutor) as Address

head('deployed')
log(`ProveBatchExecutor ${EXECUTOR}`)
const code = await pub.getCode({ address: EXECUTOR })
if (!code) throw new Error('no code at that address')
log(`runtime ${(code.length - 2) / 2} bytes`)

head('selectors this SDK would call')
let missing = 0
for (const item of SOLVER_BATCH_EXECUTOR_ABI) {
  if (item.type !== 'function') continue
  const selector = toFunctionSelector(item as never) as Hex
  // A selector a contract carries appears in its runtime code, in the dispatch table. Absent
  // there, a call on it falls through to a fallback the executor does not have and reverts blank.
  const present = code.includes(selector.slice(2))
  if (!present) missing++
  log(`${present ? 'present' : 'ABSENT '}  ${selector}  ${item.name}`)
}

head(missing === 0 ? 'the deployment matches this SDK' : `${missing} selector(s) the deployment does not carry`)
if (missing > 0) {
  log('A blank revert is what a missing selector looks like from the outside. The contract on')
  log('943 predates the struct change, so the SDK is calling a function that is not there.')
}

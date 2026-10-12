/**
 * What a deploy recorded about itself, and the one rule everything holds a run to.
 *
 * `contracts/deployments/<chain>.json` is written by the deploy script. Two things read it and
 * they read it for the same reason: `check-units.ts` holds the systemd units to it before a
 * deploy, and `executor.ts` holds a running bot to it at startup. Both are asking whether the
 * addresses in front of them came from the deploy that is actually on chain.
 *
 * No `node:fs` here on purpose. The bots are bundled by esbuild and this file goes into the
 * bundle; reading the record is the caller's business, and the two callers read it differently —
 * one from disk at check time, one from a JSON import compiled in at build time.
 */

import { keccak256, stringToHex, type Address, type Hex, type PublicClient } from 'viem'
import { INTENT_TYPEHASH, SETTLEMENT_ABI, deployedOn, type ChainId } from '@prove.cash/sdk'
import { SOLVER_BATCH_EXECUTOR_ABI } from '@prove.cash/sdk/solver'

/**
 * The part of a record anything here reads.
 *
 * Three fields, and deliberately not the whole file, because the two records do not share a
 * shape: 369 keeps its receipts under `deployedIn` and 943 has none, the batch call sink is named
 * `ProveBatchCallSink` on one and `ProveBatchExecutorCallSink` on the other, and 943 carries a
 * `_superseded` block naming three addresses that are dead. Anything that matched loosely against
 * the whole file would pass on a contract that has been replaced.
 */
export type Deployment = {
  chainId: number
  contracts: Record<string, string>
  // `FeeClaimLib` is a contract of the set (the linked library `claim` delegatecalls) and is
  // recorded here beside the rest. There is no fee-sink registry and no default-proceeds address:
  // an intent signs a fee config hash, and where it pays is the config's, not a deployed contract's.
}

/**
 * Why this settlement address is not the one the deploy recorded, or null when it is.
 *
 * The pairing this defends: a bot takes its settlement from a hand-edited environment variable
 * and its executor from the record compiled into its bundle. Those are two independent sources
 * for two halves of one deployment, and the halves are not interchangeable — they share a
 * callback ABI.
 *
 * On 2026-09-01 `Payment` gained a leg index, so `proveBatchCallback` moved from 0x3b357c3e to
 * 0xc988788e. A settlement calling the old selector at an executor answering only the new one
 * made every credit ring revert with NO DATA: no reason string, no custom error, no event, and
 * nothing to tell it apart from an ordinary failed fill. The whole of chain 943 was redeployed to
 * be rid of it, and its record exists to remember that the two move together or neither does.
 *
 * @param source where the run's settlement address came from, for the operator reading this.
 */
export function settlementFault(
  chainId: number,
  record: Deployment,
  settlement: string,
  source: string,
): string | null {
  const recorded = record.contracts.ProveSettlement
  if (settlement === recorded) return null
  return (
    `the settlement and the executor come from different deploys on chain ${chainId}.\n` +
    `  settlement ${settlement} (${source})\n` +
    `  recorded   ${recorded} (contracts/deployments/${chainId}.json)\n` +
    'The executor address is read out of that same record, so the pair would call a callback ' +
    'selector the other half does not answer, and every credit fill would revert with no data — ' +
    'no reason, no event, nothing to tell it from an ordinary failure. Update the environment, ' +
    'or the record if the record is the stale one.'
  )
}

/**
 * Why this batch executor cannot serve this settlement, or null when it can.
 *
 * `ProveBatchExecutor` binds one settlement in its constructor, as an immutable. The solver takes
 * the executor from `--credit` (or `CREDIT_EXECUTOR`) and the settlement from the registry or the
 * environment. Those are two sources for two halves of one deployment, as in `settlementFault`.
 *
 * The mainnet rehearsal found the gap. A dry run with the new settlement and the old executor
 * started and printed nothing wrong. Every credit ring it sent would have gone to a settlement
 * nobody uses. So the solver asks the executor which settlement it serves before its first pass.
 *
 * The comparison ignores case. The chain answers in checksum case, and an environment variable
 * may not.
 *
 * @param answered what `settlement()` returned, or null when the address has no code.
 * @param source where the run's settlement address came from, for the operator reading this.
 */
export function creditFault(
  chainId: number,
  executor: string,
  answered: string | null,
  settlement: string,
  source: string,
): string | null {
  if (answered !== null && answered.toLowerCase() === settlement.toLowerCase()) return null
  const head = `--credit ${executor} cannot settle for this run on chain ${chainId}.\n`
  if (answered === null) return `${head}  It has no code on this chain. Check the address.`
  return (
    head +
    `  it serves  ${answered} (its settlement(), read on chain)\n` +
    `  this run   ${settlement} (${source})\n` +
    'A batch executor binds one settlement for ever, so this one is from another deploy. ' +
    'Pass the ProveBatchExecutor that contracts/deployments/<chain>.json records beside this ' +
    'settlement, or fix the settlement if it is the stale one.'
  )
}

/**
 * Read the executor's settlement on chain, then apply `creditFault`.
 *
 * Any other failed read throws. The solver must not start on an executor it could not check.
 */
export async function readCreditFault(
  client: Pick<PublicClient, 'getCode' | 'readContract'>,
  chainId: number,
  executor: Address,
  settlement: Address,
  source: string,
): Promise<string | null> {
  const code = await client.getCode({ address: executor })
  if (!code || code === '0x') return creditFault(chainId, executor, null, settlement, source)
  const answered = await client.readContract({
    address: executor,
    abi: SOLVER_BATCH_EXECUTOR_ABI,
    functionName: 'settlement',
  })
  return creditFault(chainId, executor, answered, settlement, source)
}

/** The SDK's INTENT_TYPEHASH: keccak256 of the EIP-712 type string, `FeeConfig` suffix included. */
export function intentTypehash(): Hex {
  return INTENT_TYPEHASH
}

/**
 * Why a bot must not start against this settlement, or null when it may.
 *
 * On 2026-09-27 the four 369 units named the 2026-08-22 mainnet build. Its INTENT_TYPEHASH is
 * 0x4b3e51b4…, the SDK signs with 0xd4b26f0a…, and it has no current `fill`, `fillBatch`,
 * `fillability` or `quote`. The override made `settlementLive(369)` true while
 * `deployedOn(369)` stayed null, so the deployed-ABI guard allowed every call.
 *
 * Two checks. An override on a chain with no recorded deploy is refused, because nothing in the
 * SDK describes that contract. Then the bot reads INTENT_TYPEHASH from the settlement it will use
 * and compares it with the SDK's. The second is the one that matters: it is measured on chain.
 *
 * @param overridden true when the address came from SETTLEMENT or PROVE_SETTLEMENT.
 */
export async function settlementRefusal(
  client: Pick<PublicClient, 'readContract'>,
  chainId: ChainId,
  settlement: Address,
  overridden: boolean,
): Promise<string | null> {
  if (/^0x0{40}$/i.test(settlement)) return null // no settlement: each bot has its own answer
  if (overridden && deployedOn(chainId) === null) {
    return (
      `SETTLEMENT names ${settlement} on chain ${chainId}, and the SDK records no deploy there ` +
      '(deployedOn is null). The deployed-ABI guard cannot describe that contract. Refusing to start.'
    )
  }
  const want = intentTypehash()
  let got: Hex
  try {
    got = (await client.readContract({
      address: settlement,
      abi: SETTLEMENT_ABI,
      functionName: 'INTENT_TYPEHASH',
    })) as Hex
  } catch {
    return (
      `could not read INTENT_TYPEHASH() from settlement ${settlement} on chain ${chainId}. ` +
      'A bot does not start against a contract it cannot identify.'
    )
  }
  if (got.toLowerCase() !== want.toLowerCase()) {
    return (
      `settlement ${settlement} on chain ${chainId} has INTENT_TYPEHASH ${got}, and the SDK signs ` +
      `with ${want}. Every signature would be unspendable. Point SETTLEMENT at the current build.`
    )
  }
  return null
}

/** Throw with the refusal, if there is one. Every bot calls this before its first tick. */
export async function assertSettlement(
  client: Pick<PublicClient, 'readContract'>,
  chainId: ChainId,
  settlement: Address,
  overridden: boolean,
): Promise<void> {
  const why = await settlementRefusal(client, chainId, settlement, overridden)
  if (why) throw new Error(why)
}

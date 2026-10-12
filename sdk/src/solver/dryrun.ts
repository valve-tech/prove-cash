import {
  type Address,
  type Chain,
  type Hex,
  type HttpTransport,
  type PublicClient,
} from 'viem'
import { decodeDryRun as reasonsOrThrow, encodeDryRun } from '../dryrun.js'
import { rpcClient } from '../client.js'
import { getChainId, settlement, type ChainId } from '../config.js'
import { type FillReasonName, type RingFill } from './abi.js'

/**
 * Asking the chain what a chosen set would really do.
 *
 * Two of the facts a solver most needs are post-transfer facts: whether a permit lands, and
 * whether a redemption credits the whole amount it asked for. Neither can be read. A token that
 * keeps a cut on transfer answers every view call honestly and still leaves the escrow short,
 * and a permit either matches the token's current nonce or it does not — and the token is the
 * only thing that knows.
 *
 * `dryRun` walks the real path, arms for real, records one `Reason` per leg in request order,
 * and always reverts. The solver `eth_call`s it and reads the revert data. Nothing is spent and
 * nothing is left behind, because the whole call unwinds.
 *
 *     error DryRun(Reason[] reasons);
 *     function dryRun(FillRequest[] calldata reqs, uint256 maxFeeRate) external;
 *
 * Everything below the `DryRunner` boundary is one `eth_call`. Everything above it is a pure
 * decision, so a test stubs the runner and never needs a chain — which matters here more than
 * usual, because the settlement holding `dryRun` may not exist in this worktree at all.
 */



/**
 * The calldata for one `dryRun` of these legs.
 *
 * The codec lives in `../dryrun.ts` and is the settlement's own generated ABI. This file had a
 * second copy, hand-assembled, because `dryRun` was being added to the contract while this was
 * being written and a generated ABI without it still had to work. It carries it now.
 */
export const dryRunData = (fills: readonly RingFill[], maxFeeRate: bigint): Hex =>
  encodeDryRun(fills, maxFeeRate)

/**
 * The reasons carried by a `DryRun` revert, or null when the bytes are some other failure.
 *
 * The shared decoder throws on any other revert, which is right for a caller pricing one batch:
 * that is the walk itself failing rather than a leg answering no. A solver bisecting a set wants
 * to carry on, so it reads the same failure as "no answer" instead.
 */
export function decodeDryRun(data: Hex): FillReasonName[] | null {
  try {
    return reasonsOrThrow(data)
  } catch {
    return null
  }
}

/** The revert payload buried in a viem error, or null when it carried none. */
function revertData(e: unknown): Hex | null {
  const seen = new Set<unknown>()
  let node: unknown = e
  while (node && typeof node === 'object' && !seen.has(node)) {
    seen.add(node)
    const raw = (node as { data?: unknown }).data
    if (typeof raw === 'string' && raw.startsWith('0x')) return raw as Hex
    if (raw && typeof raw === 'object') {
      const inner = (raw as { data?: unknown }).data
      if (typeof inner === 'string' && inner.startsWith('0x')) return inner as Hex
    }
    node = (node as { cause?: unknown }).cause
  }
  return null
}

/**
 * The one call this module makes. Stub it in a test.
 *
 * It answers one reason per leg, in request order. It throws only when the chain would not say —
 * a dead endpoint, a settlement without a `dryRun` — which is a different thing from a leg that
 * will not fill and must not be confused with one.
 */
export type DryRunner = (
  fills: readonly RingFill[],
  maxFeeRate: bigint,
) => Promise<readonly FillReasonName[]>

/** Where the dry run is asked, and who is asking. */
export type DryRunOptions = {
  client?: PublicClient<HttpTransport, Chain>
  chainId?: ChainId
  /** Override the settlement address, for a fork. */
  settlementAddress?: Address
  /** The address that would send the batch. `dryRun` answers for this caller. */
  account: Address
}

/**
 * A runner backed by `eth_call`.
 *
 * A call that comes back *without* reverting is a failure and not a success. `dryRun` always
 * reverts, so a plain return means the address is not the contract this solver thinks it is, and
 * carrying on would be planning against a stranger.
 */
export function chainDryRunner(opts: DryRunOptions): DryRunner {
  const client = opts.client ?? rpcClient()
  const to = opts.settlementAddress ?? settlement(opts.chainId ?? getChainId())
  return async (fills, maxFeeRate) => {
    const data = dryRunData(fills, maxFeeRate)
    try {
      await client.call({ account: opts.account, to, data } as never)
    } catch (e) {
      const raw = revertData(e)
      const reasons = raw ? decodeDryRun(raw) : null
      if (reasons) return reasons
      throw e
    }
    throw new Error('dryRun returned instead of reverting: this is not ProveSettlement.dryRun.')
  }
}

// ── Confirming a chosen set ───────────────────────────────────────────────────

/** What a dry run said about a set: it settles, or these legs are why it does not. */
export type Confirmation =
  | { ok: true; reasons: readonly FillReasonName[] }
  | { ok: false; reasons: readonly FillReasonName[]; bad: readonly number[] }

/** Dry-run this exact set and say whether every leg came back `Ok`. */
export async function confirm(
  run: DryRunner,
  fills: readonly RingFill[],
  maxFeeRate: bigint,
): Promise<Confirmation> {
  const reasons = await run(fills, maxFeeRate)
  const bad: number[] = []
  for (let k = 0; k < reasons.length; k++) {
    if (reasons[k] !== 'Ok') bad.push(k)
  }
  // A short answer is not a pass. One reason per leg is the contract's promise, and a batch that
  // answered for fewer legs than it was given did not answer for the ones it left out.
  if (reasons.length !== fills.length) {
    return { ok: false, reasons, bad: fills.map((_, k) => k) }
  }
  return bad.length === 0 ? { ok: true, reasons } : { ok: false, reasons, bad }
}

/**
 * One thing that settles whole or not at all.
 *
 * A ring passes `skipInvalid=false`, so a ring missing a leg is broken rather than smaller: the
 * surviving set must not diverge from the plan the route was built for. That is why bisection
 * here drops whole units and never individual legs.
 */
export type DryRunUnit = { fills: readonly RingFill[] }

/** Which units survived, and what the search cost. */
export type BisectResult = { kept: number[]; calls: number }

/**
 * The largest set of units this chain will settle, found by halving rather than re-enumerating.
 *
 * Re-enumerating after a failed confirmation is the wrong move twice over: the enumeration
 * already returned its best answer against everything it knew, and the thing that broke is by
 * definition something it could not know — a permit the token refused, a redemption that
 * credited less than it pulled. Asking the same question again gets the same answer.
 *
 * So the search runs over the chosen set itself. Confirm it; if it settles, keep it. If not,
 * split it in half and confirm each half against what is already known to work, so a unit is
 * only ever judged beside the units it will actually settle with. A single unit that will not
 * confirm is dropped. The cost is O(m log m) calls in the worst case and exactly one when
 * nothing is wrong, which is the case that runs on every tick.
 *
 * `maxCalls` bounds a pathological book. Reaching it returns what is confirmed so far, which is
 * always a set the chain has said yes to.
 */
export async function bisect(
  run: DryRunner,
  units: readonly DryRunUnit[],
  maxFeeRate: bigint,
  opts: { maxCalls?: number } = {},
): Promise<BisectResult> {
  const maxCalls = opts.maxCalls ?? 64
  let calls = 0

  const settles = async (chosen: readonly number[]): Promise<boolean> => {
    if (chosen.length === 0) return true
    calls++
    const fills = chosen.flatMap((u) => [...units[u].fills])
    const answer = await confirm(run, fills, maxFeeRate)
    return answer.ok
  }

  const keep = async (candidates: readonly number[], base: number[]): Promise<number[]> => {
    if (candidates.length === 0 || calls >= maxCalls) return base
    if (await settles([...base, ...candidates])) return [...base, ...candidates]
    if (candidates.length === 1) return base
    const mid = candidates.length >> 1
    const left = await keep(candidates.slice(0, mid), base)
    return keep(candidates.slice(mid), left)
  }

  const kept = await keep(
    units.map((_, i) => i),
    [],
  )
  return { kept, calls }
}

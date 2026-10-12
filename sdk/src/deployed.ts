import { deployedOn, type ChainId } from './config.js'

/**
 * What a chain's deployed build answers to, as against what this tree builds.
 *
 * A deployment is frozen the moment it lands and this tree keeps moving, so the two drift. Most
 * drift is harmless — a renamed local, a reworded comment — and the dangerous kind is a function
 * this tree calls by a name the deployed bytecode never carried. That call does not fail usefully.
 * The chain finds no such selector, falls into the fallback or runs out of function, and reverts
 * with no reason, no event and nothing to tell it from an ordinary failed read.
 *
 * Chain 943 was in exactly that state until 2026-09-26. Its 2026-09-09 build predated `4ba9a66`,
 * which renamed the executors' `sink()` accessor on 2026-09-15, so this tree called
 * `sinkTemplate()` and the chain published `sink()`. The 2026-09-26 redeploy carries every change
 * below. `docs/ADDRESSES.md` records the per-contract measurement of both builds.
 *
 * Nothing in this package called either accessor when this file was written. That was a fact about
 * the call sites of one afternoon, not a property anybody enforced, and the next caller to reach
 * for one would have got the bare revert. This file makes it a property: `batchRead` refuses such
 * a call before it reaches the wire, and says which change the chain predates and what it runs
 * instead.
 *
 * **No chain id appears below.** The rule is a date against a date, so a second chain deployed
 * before a change is caught by its own registry entry, with nobody remembering to list it here.
 */

/** One change to a contract's published surface, and the deployments that came before it. */
export type AbiChange = {
  /**
   * The day the change landed in this tree, as `YYYY-MM-DD`.
   *
   * Compared as a string, which is why the format is fixed: ISO dates sort lexicographically and
   * `2026-9-15` does not. `deployed.test.ts` holds every entry to the shape.
   */
  landed: string
  /** The commit that made the change, so a reader can go and look at it. */
  commit: string
  /** The function names only a deployment from after `landed` carries. */
  names: readonly string[]
  /** What the older deployments publish instead, in one sentence, for the person who is stuck. */
  reason: string
}

/**
 * Every published-surface change this package knows about, newest last.
 *
 * Add an entry when a deploy is skipped, not when the source changes. A change that reached every
 * live chain is drift nobody can hit, and an entry for it would refuse calls that work.
 */
export const ABI_CHANGES: readonly AbiChange[] = [
  {
    landed: '2026-09-15',
    commit: '4ba9a66',
    names: ['sinkTemplate', 'sinkFor'],
    reason:
      'the executors there publish sink(), they mint no per-caller sink clone a caller can ask ' +
      'for, and they carry no ProceedsNotHere check',
  },
  {
    // `claim` kept its name and changed its meaning, so it is listed with the two new names. On
    // the older settlement claim(feeTo, token) pays feeTo itself and refuses nothing. A caller
    // built on this tree expects it to pay the sink's destination and to revert for an address
    // that is not a registered sink. That caller must not reach the older build.
    landed: '2026-09-23',
    commit: '4d48379',
    names: ['feeSinks', 'registerFeeSink', 'claim'],
    reason:
      'the settlement there has no fee-sink registry: it publishes no feeSinks() and no ' +
      'registerFeeSink(), it charges a fee to any feeTo, and its claim(feeTo, token) pays feeTo ' +
      'itself rather than a registered sink’s destination',
  },
  {
    // The default-sink getter. A zero feeTo charges nothing on the older build. From ba6749e to
    // the 2026-10-01 change it paid the default at fill time; after that change it charges
    // nothing again, and the default is a sign-time pointer. `readDefaultFeeSink` reads the
    // older build's answer as a zero sink: no default, so no fee.
    landed: '2026-09-23',
    commit: 'ba6749e',
    names: ['defaultFeeSink'],
    reason:
      'the settlement there has no default fee sink to read: an intent that signs feeTo = 0 and ' +
      'feeRate = 0 pays no fee at all',
  },
  {
    // The fee-config model. `claim`, `pendingFees` and `quote` kept their names and changed their
    // shape (a config and a token; a config's hash; a struct), so they are listed with the new
    // names. A caller built on this tree must not reach the older build: the call would decode
    // the wrong thing or revert with no reason. `available` is the opposite change, a name this
    // tree no longer has on the settlement (it is `ProveReader.available`), so it is not listed:
    // that guard is for calls the chain cannot answer, and the SDK no longer makes this one.
    landed: '2026-10-03',
    commit: 'feat/fee-config-hash',
    names: ['announceFeeConfig', 'STRAY_CONFIG', 'totalPendingFees', 'claim', 'pendingFees', 'quote'],
    reason:
      'the settlement there books a fee under a fee sink and has no fee configs: claim(sink, ' +
      'token) pays a registered sink’s destination, pendingFees is keyed by the sink, and quote ' +
      'returns (delivered, fee)',
  },
]

/**
 * The change a build of this date predates that added this name, or null when it carries it.
 *
 * Takes the date rather than the chain so that the rule can be tested on dates the registry does
 * not hold. `missingFrom` is the same question asked about a registered chain.
 *
 * A build dated the same day as the change counts as predating it. A record carries a day and not
 * a time, so a deploy on the morning of the change and one on the evening read alike, and the two
 * mistakes are not equal: refusing a call that would have worked is one loud error a person fixes,
 * and allowing one that cannot work is the silent revert this file exists to prevent.
 */
export function changeMissingFrom(functionName: string, built: string | null): AbiChange | null {
  if (built === null) return null
  return ABI_CHANGES.find((c) => built <= c.landed && c.names.includes(functionName)) ?? null
}

/** The change this chain's deployment predates that added this name, or null when it has it. */
export const missingFrom = (functionName: string, id: ChainId): AbiChange | null =>
  changeMissingFrom(functionName, deployedOn(id))

/** True when this chain's deployed build answers to this function name. */
export const deployedAbiHas = (functionName: string, id: ChainId): boolean =>
  missingFrom(functionName, id) === null

/**
 * Why this chain cannot answer this call, in the words the caller needs, or null when it can.
 *
 * Separate from the throw so that a caller with somewhere better to put a sentence — a panel, a
 * log line, a bot's startup check — can read it without catching an error.
 */
export function abiRefusal(functionName: string, id: ChainId): string | null {
  const change = missingFrom(functionName, id)
  if (change === null) return null
  return (
    `${functionName}() is not on chain ${id}. ` +
    `That chain was deployed on ${deployedOn(id)} and predates ${change.commit} of ` +
    `${change.landed}, which added the name: ${change.reason}. ` +
    'The call would revert with no reason at all. ' +
    'docs/ADDRESSES.md records what each chain actually runs.'
  )
}

/**
 * Refuse a call the chain's own build cannot answer, naming the change it predates.
 *
 * Throws, because this is the caller's mistake and not the chain's condition. An endpoint that
 * fails is worth retrying and comes back as a `CallResult`; a name the deployed bytecode never
 * carried will fail the same way for ever, and no retry and no fallback improves it.
 */
export function assertDeployedAbi(functionName: string, id: ChainId): void {
  const why = abiRefusal(functionName, id)
  if (why !== null) throw new Error(why)
}

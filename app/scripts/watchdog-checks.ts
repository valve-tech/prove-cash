/**
 * The watchdog's checks, kept apart from the bot so a test can drive each one.
 *
 * `watchdog.ts` is a script with side effects at module scope: it reads the environment, asks the
 * chain for its id and loops for ever. Every read a check needs arrives here as a function, so a
 * test can feed a bad input and prove that the check fires. A check that cannot fail reads as
 * coverage and is worse than none.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { recoverAddress, type Address, type Hex } from 'viem'
import { ZERO, domain, intentDigest, quote, type ChainId, type SignedIntent } from '@prove.cash/sdk'

export type Level = 'WARN' | 'BROKEN'

/** One board message, as much of it as a check reads. */
export type Message = { hash: Hex; data: Hex }

/** One decoded `Filled` event from the settlement. */
export type FilledLog = {
  blockNumber: bigint
  transactionHash: Hex
  intentHash: Hex
  take: bigint
  delivered: bigint
}

/** What the board says about itself. */
export type BoardStatus = {
  enabled: boolean
  workMultiplier: string | bigint
  workDivisor: string | bigint
  count: string | bigint
}

/** Every read and every output a check uses. */
export type WatchDeps = {
  settlement: Address
  /**
   * The makers whose output we answer for, lower case: our own bots. A bad signature or a
   * `BadTerms` from one of them is BROKEN. From anybody else it is a WARN, because anybody can
   * post to the board, and a stranger's garbage must not stop the watchdog.
   */
  own: ReadonlySet<string>
  alert: (level: Level, what: string, detail?: unknown) => Promise<void>
  log: (m: string) => void
  decode: (data: Hex) => SignedIntent | null
  verify: (i: SignedIntent) => Promise<boolean>
  /** The settlement's `fillability` reason for this intent. Throws when the node does not answer. */
  fillability: (i: SignedIntent) => Promise<string>
  /**
   * The settlements this chain retired, from its deployment record. A redeploy leaves our own
   * makers' last intents on the board, signed for the old domain, until they expire.
   */
  retired: readonly Address[]
  /** Whether the signature verifies for the EIP-712 domain of this one settlement. */
  verifyFor: (i: SignedIntent, settlement: Address) => Promise<boolean>
  /** The last moment a signature for a retired settlement may start, or null when unknown. */
  retiredBy: bigint | null
  /** The latest block's timestamp. Intents are timed by the chain, never by `Date.now()`. */
  chainNow: () => Promise<bigint>
  hashIntent: (i: SignedIntent) => Promise<Hex>
  status: () => Promise<BoardStatus>
  /** The archive's message hashes in lower case, or null when the archive is unreachable. */
  archiveHashes: () => Promise<Set<string> | null>
  /** The `Filled` events the settlement emitted in a block range, both ends included. */
  fillLogs: (fromBlock: bigint, toBlock: bigint) => Promise<FilledLog[]>
  blockTime: (blockNumber: bigint) => Promise<bigint>
  archiveGraceMs: number
  nowMs: () => number
}

/** How long past its end an intent stays known, in seconds, so a late log still finds its terms. */
const KEEP_AFTER_END = 3_600n

/**
 * The longest window an intent of ours signed for a retired settlement may have. The heartbeat
 * signs thirty to sixty minutes (`heartbeat.ts`, `endTime`), so an hour covers every leftover.
 */
export const RETIRED_LIFETIME = 3_600n

/**
 * How long the board may still hold a row after its `endTime`. The board keeps about the last
 * 120 blocks (`keepalive.ts`), 1,200 seconds at 943's ten-second blocks, so a row reposted just
 * before its end stays that long. Measured on 2026-09-29: up to 886 seconds past `endTime`.
 */
export const BOARD_HOLDS_PAST_END = 1_200n

export function createWatch(d: WatchDeps) {
  /** Message hash → when we first saw it on the board, so the archive gets a fair grace period. */
  const firstSeen = new Map<string, number>()
  /** Intent hash → terms, built from everything we have decoded off the board. */
  const knownIntents = new Map<string, SignedIntent>()

  const isOwn = (maker: Address) => d.own.has(maker.toLowerCase())
  /** Message hashes that the last `checkMessages` found signed for a retired settlement. */
  let retiredRows = new Set<string>()

  /** The first retired settlement whose domain the signature verifies for, or null. */
  async function retiredDomainOf(i: SignedIntent): Promise<Address | null> {
    for (const s of d.retired) if (await d.verifyFor(i, s)) return s
    return null
  }

  async function checkBoard(): Promise<BoardStatus | null> {
    const status = await d.status()
    if (!status.enabled) {
      await d.alert('BROKEN', 'board reports disabled')
      return null
    }
    if (BigInt(status.workMultiplier) === 0n || BigInt(status.workDivisor) === 0n) {
      await d.alert('BROKEN', 'board difficulty factors are nonsense', status)
    }
    return status
  }

  /**
   * Every message decodes and its signature verifies. A bad signature from one of our own makers
   * is a codec change nobody announced, and BROKEN. From a stranger it is somebody probing, and a
   * WARN: the old BROKEN let anybody stop the watchdog with one post.
   */
  async function checkMessages(messages: readonly Message[]): Promise<void> {
    const now = d.nowMs()
    let bad = 0
    let chainNow: bigint | null = null
    retiredRows = new Set()
    for (const m of messages) {
      if (!firstSeen.has(m.hash)) firstSeen.set(m.hash, now)
      const decoded = d.decode(m.data)
      if (!decoded) {
        bad++
        continue
      }
      if (!(await d.verify(decoded))) {
        const old = isOwn(decoded.maker) ? await retiredDomainOf(decoded) : null
        if (old) {
          chainNow ??= await d.chainNow()
          const detail = { hash: m.hash, maker: decoded.maker, startTime: decoded.startTime, endTime: decoded.endTime }
          // A leftover ends within the heartbeat's lifetime and started before the redeploy.
          // Anything else means a bot of ours kept signing for the old contract.
          const leftover =
            chainNow <= decoded.endTime + BOARD_HOLDS_PAST_END &&
            decoded.endTime - decoded.startTime <= RETIRED_LIFETIME &&
            (d.retiredBy === null || decoded.startTime <= d.retiredBy)
          retiredRows.add(m.hash)
          await d.alert(
            leftover ? 'WARN' : 'BROKEN',
            leftover
              ? `a message from one of our makers is signed for retired settlement ${old}; it expires at ${decoded.endTime}`
              : `a message from one of our makers is signed for retired settlement ${old} and is past its lifetime`,
            { ...detail, chainNow, retiredBy: d.retiredBy, maxWindow: RETIRED_LIFETIME },
          )
          continue
        }
        await d.alert(
          isOwn(decoded.maker) ? 'BROKEN' : 'WARN',
          isOwn(decoded.maker)
            ? 'a message from one of our makers carries a bad signature'
            : 'a message from a stranger carries a bad signature',
          { hash: m.hash, maker: decoded.maker },
        )
      }
    }
    if (bad > 0) await d.alert('WARN', 'messages in our category did not decode', { count: bad })
  }

  /**
   * The chain agrees the terms are legal.
   *
   * A signature can decode and verify and still be worthless, because whether the *terms* are
   * allowed is the contract's opinion and not the codec's. On 2026-08-14 the settlement gained a
   * one-hour cap on wallet windows, the heartbeat kept signing longer ones, and every intent it
   * posted became `BadTerms` while every other check passed.
   *
   * `BadTerms` from our own maker is BROKEN: a client of ours and the settlement disagree about
   * what an intent may say. From a stranger it is a WARN. A read the node did not answer is
   * counted and warned about, so the alarm does not go quiet when the RPC does.
   */
  async function checkTerms(messages: readonly Message[]): Promise<void> {
    if (d.settlement === ZERO) return
    let ours = 0
    let theirs = 0
    let unread = 0
    let example: { hash: Hex; maker: Address; window: number; flags: number } | null = null

    for (const m of messages) {
      const i = d.decode(m.data)
      if (!i) continue
      let reason: string
      try {
        reason = await d.fillability(i)
      } catch {
        unread++
        continue
      }
      if (reason !== 'BadTerms') continue
      // `checkMessages` already judged a row signed for a retired settlement. The current one
      // refuses it for its domain, not for its terms.
      if (retiredRows.has(m.hash)) continue
      if (isOwn(i.maker)) ours++
      else theirs++
      if (!example || (isOwn(i.maker) && !isOwn(example.maker))) {
        example = { hash: m.hash, maker: i.maker, window: Number(i.endTime - i.startTime), flags: i.flags }
      }
    }

    if (ours > 0) {
      await d.alert('BROKEN', 'the chain refuses our own terms outright, so nothing can ever fill', {
        refused: ours,
        of: messages.length,
        example,
        hint: 'a client and the settlement disagree about what an intent may say',
      })
    }
    if (theirs > 0) {
      await d.alert('WARN', "the chain refuses a stranger's terms outright", { refused: theirs, example })
    }
    if (unread > 0) {
      await d.alert('WARN', 'the node did not answer for some messages, so their terms are unchecked', {
        unread,
        of: messages.length,
      })
    }
  }

  async function checkArchive(boardHashes: readonly string[]): Promise<void> {
    const archived = await d.archiveHashes()
    if (!archived) {
      await d.alert('WARN', 'the archive is unreachable')
      return
    }
    const now = d.nowMs()
    const missing = boardHashes.filter((h) => {
      const seenAt = firstSeen.get(h) ?? now
      return !archived.has(h.toLowerCase()) && now - seenAt > d.archiveGraceMs
    })
    if (missing.length > 0) {
      await d.alert('BROKEN', 'the archive has not kept up with the board', {
        missing: missing.length,
        example: missing[0],
        graceSeconds: d.archiveGraceMs / 1000,
      })
    }
  }

  /**
   * Every fill in the range paid the maker at least their share of the rate they signed.
   *
   * `checked` counts only the fills this verified. A fill of an intent never seen on the board
   * has no terms to check against, so it is counted apart as unknown and said so.
   */
  async function checkFills(fromBlock: bigint, toBlock: bigint): Promise<void> {
    if (d.settlement === ZERO) return
    const logs = await d.fillLogs(fromBlock, toBlock)
    let checked = 0
    let unknown = 0

    for (const entry of logs) {
      const intent = knownIntents.get(entry.intentHash.toLowerCase())
      if (!intent) {
        unknown++
        continue
      }
      const at = await d.blockTime(entry.blockNumber)
      // The maker's share of this take: the curve's value less the proceeds-point fee (P3). The
      // output fee (P2) is paid on top by the filler and never touches the maker's share, so
      // comparing `delivered` against the gross would alarm on every fee-charging fill.
      const owed = quote(intent, entry.take, at).delivered
      checked++
      if (entry.delivered < owed) {
        await d.alert('BROKEN', 'a fill paid the maker less than their share of the signed rate', {
          tx: entry.transactionHash,
          delivered: entry.delivered.toString(),
          owed: owed.toString(),
          owedToMaker: quote(intent, entry.take, at).owedToMaker.toString(),
        })
      }
    }
    if (checked > 0) d.log(`checked ${checked} fill${checked === 1 ? '' : 's'} in blocks ${fromBlock}–${toBlock}`)
    if (unknown > 0) {
      d.log(`${unknown} fills of intents never seen on the board in blocks ${fromBlock}–${toBlock}, not checked`)
    }
  }

  async function rememberIntents(messages: readonly Message[]): Promise<void> {
    if (d.settlement === ZERO) return
    for (const m of messages) {
      const decoded = d.decode(m.data)
      if (!decoded) continue
      knownIntents.set((await d.hashIntent(decoded)).toLowerCase(), decoded)
    }
  }

  /**
   * Forget what can no longer matter: intents an hour past their end at chain time `now`, and
   * first-seen times of messages the board no longer holds. Both maps grew for the life of the
   * process before.
   */
  function prune(now: bigint, boardHashes: readonly string[]): void {
    for (const [h, i] of knownIntents) if (i.endTime + KEEP_AFTER_END < now) knownIntents.delete(h)
    const live = new Set(boardHashes)
    for (const h of firstSeen.keys()) if (!live.has(h)) firstSeen.delete(h)
  }

  return {
    checkBoard,
    checkMessages,
    checkTerms,
    checkArchive,
    checkFills,
    rememberIntents,
    prune,
    knownIntents: knownIntents as ReadonlyMap<string, SignedIntent>,
    firstSeenSize: () => firstSeen.size,
  }
}

/**
 * The last block a previous run checked, or null when there is no readable record.
 *
 * The watchdog used to hold this only in memory, so a restart began at the head and never
 * checked the fills in between.
 */
export function loadLastBlock(path: string): bigint | null {
  try {
    const { lastBlock } = JSON.parse(readFileSync(path, 'utf8')) as { lastBlock?: unknown }
    if (typeof lastBlock !== 'string' || !/^\d+$/.test(lastBlock)) return null
    return BigInt(lastBlock)
  } catch {
    return null
  }
}

/** Record the last block checked. Written to a temporary file and renamed, so a crash cannot tear it. */
export function saveLastBlock(path: string, block: bigint): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify({ lastBlock: block.toString() }))
  renameSync(tmp, path)
}

/**
 * The settlements a chain retired, read from its deployment record's `_superseded` field. That
 * field is prose, and it names each retired set by "settlement 0x…".
 */
export function retiredSettlements(record: { _superseded?: unknown }): Address[] {
  if (typeof record._superseded !== 'string') return []
  return [...record._superseded.matchAll(/settlement (0x[0-9a-fA-F]{40})/g)].map((m) => m[1] as Address)
}

/**
 * The last moment, in unix seconds, a signature for a retired settlement could honestly start.
 * The record gives only the redeploy's date, so this is the end of that UTC day: never early, so
 * a leftover is never BROKEN, and a bot that kept signing is caught within a day.
 */
export function retiredBy(record: { deployedAt?: unknown }): bigint | null {
  if (typeof record.deployedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.deployedAt)) return null
  return BigInt(Date.parse(`${record.deployedAt}T00:00:00Z`) / 1000) + 86_400n
}

/**
 * Whether a signature verifies for the EIP-712 domain of one given settlement. `verifyIntent`
 * checks only the chain's current settlement; this is the same recovery with another address.
 */
export async function verifyForSettlement(s: SignedIntent, chainId: ChainId, settlement: Address): Promise<boolean> {
  try {
    const { signature, auth: _auth, permit: _permit, permit2: _permit2, ...intent } = s
    const signer = await recoverAddress({
      hash: intentDigest(intent, { ...domain(chainId), verifyingContract: settlement }),
      signature,
    })
    return signer.toLowerCase() === s.maker.toLowerCase()
  } catch {
    return false
  }
}

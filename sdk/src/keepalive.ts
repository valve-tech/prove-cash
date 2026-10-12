import type { Hex } from 'viem'
import { DEFAULT_CHAIN, getChainId, type ChainId } from './config.js'
import { decodeIntent, intentKey } from './intent.js'
import { kv } from './kv.js'

/**
 * The board keeps roughly the last 120 blocks, so a live intent has to be posted again as it
 * ages out. Re-posting costs a fresh grind and nothing else — the maker never signs twice, and
 * anyone can do it, which is why this is safe to run from a tab or from a bot.
 *
 * **One list per chain, and the chain is in the storage key.** A signature is bound to one
 * domain, so a payload signed on 369 means nothing at the 943 board. The list used to be a
 * single array under one key: every caller got every chain's rows back, and `keepAlive` re-posts
 * whatever the CURRENT board does not carry. While 369 settled nowhere `signingDomain` refused to
 * sign there, so no mainnet payload could enter the list and the fault could not fire. The
 * mainnet flip removes exactly that guard, and a maker who signs on mainnet and then switches to
 * testnet would have had a tab grinding proof of work to post mainnet payloads at the 943 board.
 * It costs work and board space rather than correctness — `ingestAll` verifies every sighting
 * against the reader's own domain — but the work is a maker's own laptop.
 *
 * The chain lives in the key rather than in a field on each row, for the reason the fault
 * teaches: a read of `provecash.mine.943` cannot see a 369 row even if a caller forgets to
 * filter. A tagged single list puts that back in a predicate every future reader has to
 * remember. It is also the shape `config.ts` already keeps per-install state in — `provecash.rpc.
 * <id>` and friends — and one bad JSON blob then costs one chain instead of both.
 *
 * `intentKey` is deliberately unchanged. It identifies a signature, and a signature verifies on
 * one chain only, so two chains cannot collide in it. Where a key needs a chain, the repository
 * already composes one at the point of use — `store/index.ts` keys its verification cache
 * `${chainId}:${intentKey(intent)}` — and widening `intentKey` itself would move the store's row
 * keys and the solver's claim keys to buy no collision that was reachable.
 */

/** One payload we keep alive, with the expiry that retires it. */
export type Kept = { data: Hex; endTime: string; key: string }

const STORE = (chainId: ChainId) => `provecash.mine.${chainId}`

/** Where the whole list lived before it was keyed by chain. */
const LEGACY_STORE = 'provecash.mine'

function read(chainId: ChainId): Kept[] {
  try {
    const all = JSON.parse(kv().getItem(STORE(chainId)) || '[]') as Kept[]
    return Array.isArray(all) ? all : []
  } catch {
    return []
  }
}

function write(chainId: ChainId, kept: Kept[]): void {
  kv().setItem(STORE(chainId), JSON.stringify(kept))
}

/**
 * Move the rows an older build left under the un-keyed key onto the chain that signed them.
 *
 * **They go to `DEFAULT_CHAIN`, and that is a derivation rather than a guess.** A row could only
 * be written by a build that had no per-chain key, and every such build refused to sign anywhere
 * but 943: mainnet carried a deliberate zero settlement, so `signingDomain` threw there and no
 * mainnet payload could ever reach this list. Testnet is the only chain those rows can be from,
 * and it is `DEFAULT_CHAIN`.
 *
 * **Dropping them was the alternative and it is the worst one.** These are a real maker's live
 * offers. Silently forgetting them stops the re-posting, the offers age off the board within
 * about 120 blocks, and the maker sees their own offers disappear with nothing said and nothing
 * to do about it. Signatures stay valid on chain, so keeping the rows costs one grind each at
 * worst and returns the offers to the board.
 *
 * One narrow window stays open: a stale tab still running the old bundle after the flip could
 * write a mainnet row here, and this would file it under 943. That row then costs one wasted
 * grind and no bad book row, which is the bounded cost this whole change is removing — for one
 * stale tab, until the row expires.
 *
 * The legacy key is removed before its contents are parsed, so a corrupt blob is read once and
 * never again. Existing rows win a key collision: they were written by this build, and the
 * legacy ones are older by construction.
 */
function migrate(): void {
  const legacy = kv().getItem(LEGACY_STORE)
  if (legacy === null) return
  kv().removeItem(LEGACY_STORE)
  let rows: unknown
  try {
    rows = JSON.parse(legacy)
  } catch {
    return
  }
  if (!Array.isArray(rows) || rows.length === 0) return
  const kept = read(DEFAULT_CHAIN)
  const keys = new Set(kept.map((k) => k.key))
  for (const row of rows as Kept[]) {
    if (!row || typeof row.key !== 'string' || keys.has(row.key)) continue
    keys.add(row.key)
    kept.push(row)
  }
  write(DEFAULT_CHAIN, kept)
}

/** The payloads we posted on one chain that have not expired yet. */
export function myIntents(chainId: ChainId): Kept[] {
  migrate()
  const now = Math.floor(Date.now() / 1000)
  return read(chainId).filter((k) => Number(k.endTime) > now)
}

/** Take responsibility for a payload on one chain: it will be re-posted until it expires. */
export function remember(chainId: ChainId, data: Hex) {
  const decoded = decodeIntent(data)
  if (!decoded) return
  const entry: Kept = {
    data,
    endTime: decoded.endTime.toString(),
    key: intentKey(decoded),
  }
  const kept = myIntents(chainId).filter((k) => k.key !== entry.key)
  kept.push(entry)
  write(chainId, kept)
}

/** Stop re-posting one intent on one chain. */
export function forget(chainId: ChainId, key: string) {
  write(
    chainId,
    myIntents(chainId).filter((k) => k.key !== key),
  )
}

let running = false

/**
 * Re-post any of one chain's live intents that its board no longer carries. `post` does the
 * grinding, so a tab can hand the work to a worker. Runs one grind at a time so a laptop stays
 * usable, and skips itself if the previous pass is still going.
 *
 * `chainId` names the board `onBoard` was read from and the list to re-post from. It is also
 * checked between grinds: a grind takes seconds, `post` sends to whichever chain the process
 * points at now, and a reader who switches network mid-pass must not have the rest of the old
 * chain's payloads posted at the new board.
 */
export async function keepAlive(
  chainId: ChainId,
  onBoard: Set<string>,
  post: (data: Hex) => Promise<unknown>,
  onRepost?: (key: string) => void,
) {
  if (running) return
  running = true
  try {
    for (const kept of myIntents(chainId)) {
      if (getChainId() !== chainId) return
      if (onBoard.has(kept.key)) continue
      try {
        await post(kept.data)
        onRepost?.(kept.key)
      } catch {
        /* the next pass tries again */
      }
    }
  } finally {
    running = false
  }
}

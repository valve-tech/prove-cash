import { bytesToHex, stringToBytes, type Hex } from 'viem'
import {
  MsgBoardClient,
  type Content,
  type Provider,
  type RPCMessage,
  type Stamper,
  type Status,
} from '@msgboard/sdk'
import { rpcClient } from './client.js'
import { CATEGORY, getRpc } from './config.js'
import { grindAndSubmit } from './submit.js'

/**
 * The msgboard client. Broadcast costs proof of work and nothing else — no account, no gas —
 * which is why an intent can travel before its maker has ever touched the chain.
 *
 * The grind runs headless by default: @msgboard/sdk picks the fastest engine it can load. A
 * browser should pass its own `stamper` so the work leaves the UI thread.
 */

/** How the board's difficulty and size limits stand right now. */
export type { Status } from '@msgboard/sdk'

/**
 * Ascii, right-padded to 32 bytes — the same convention the msgboard.xyz board view uses, so
 * prove.cash traffic reads as `provecash` there instead of an opaque keccak hash.
 */
export const PROVECASH_CATEGORY = bytesToHex(stringToBytes(CATEGORY), { size: 32 }) as Hex

/**
 * A board client on one endpoint. Omit `stamper` to grind in this process; pass one to send
 * the work somewhere else, such as a web worker.
 */
export function board(url = getRpc(), stamper?: Stamper | null): MsgBoardClient {
  return new MsgBoardClient(rpcClient(url) as unknown as Provider, { stamper })
}

/** The board's live status: whether it is enabled, and the factors that price the work. */
export async function boardStatus(url?: string): Promise<Status> {
  return board(url).status()
}

/** Every message the board currently holds in the prove.cash category. */
export async function readIntents(url?: string): Promise<RPCMessage[]> {
  const content = await board(url).content({ category: PROVECASH_CATEGORY })
  return content[PROVECASH_CATEGORY] ?? []
}

/** What a delta read found, and where the next one starts. */
export type IntentDelta = { messages: RPCMessage[]; nextFrom: bigint }

/**
 * How far back a delta re-reads. A message is rooted to a block by its proof of work, and it
 * becomes visible a moment after that block, so a read taken on the boundary can miss one that
 * was already rooted. Four blocks is forty seconds of slack against a twelve-second poll, and
 * costs only the messages in them — every one is deduplicated by intent key downstream.
 */
const DELTA_OVERLAP = 4n

/**
 * The prove.cash messages rooted at or after `from`.
 *
 * `readIntents` asks for the whole category every time, and the board has no limit, no offset and
 * no pair filter — `ContentFilter` is `{ category, fromBlock, toBlock }` and nothing else. So the
 * only way to stop re-reading the board every poll is to move `fromBlock` forward, and that is
 * this. Pass `0n` the first time and the caller's own `nextFrom` from then on.
 *
 * `nextFrom` comes from the messages themselves, never from the chain head: a message rooted to a
 * block the head has already passed would be skipped for ever otherwise. With nothing arriving
 * the watermark simply holds, and the next read asks for the same range again.
 */
export async function readIntentsSince(from: bigint, url?: string): Promise<IntentDelta> {
  const content = await boardContent(deltaFrom(from), url)
  const messages = content[PROVECASH_CATEGORY] ?? []
  return { messages, nextFrom: watermark(from, messages) }
}

/**
 * The prove.cash category from `fromBlock` on.
 *
 * It exists to hold one workaround in one place. The client types `ContentFilter.fromBlock` as a
 * bigint; the node parses it as a u64, and a bigint reaches the wire as the decimal string "0",
 * which the node refuses — `invalid type: string "0", expected u64`. Every delta read failed that
 * way and the board came back empty, which is indistinguishable on screen from a board with
 * nothing on it. Block numbers are nowhere near 2^53, so narrowing to a number is safe.
 *
 * Send a number here and nowhere else, so there is one line to delete when the client is fixed.
 */
export async function boardContent(fromBlock: bigint, url?: string): Promise<Content> {
  return board(url).content({
    category: PROVECASH_CATEGORY,
    fromBlock: Number(fromBlock) as unknown as bigint,
  })
}

/** Where a delta read actually starts: `from`, less the overlap, and never below zero. */
export const deltaFrom = (from: bigint): bigint =>
  from > DELTA_OVERLAP ? from - DELTA_OVERLAP : 0n

/** The newest block among these messages, or `from` when none of them is newer. */
export function watermark(from: bigint, messages: readonly RPCMessage[]): bigint {
  let next = from
  for (const m of messages) {
    const at = BigInt(m.blockNumber)
    if (at > next) next = at
  }
  return next
}

/** Grind a payload and post it. Returns the board hash of the accepted message. */
export async function postToBoard(data: Hex, client: MsgBoardClient = board()): Promise<Hex> {
  const { hash } = await grindAndSubmit(client, PROVECASH_CATEGORY, data)
  return hash
}

/** The work threshold for a payload of this size, under the board's live factors. */
export function difficultyFor(data: Hex, status: Status): bigint {
  const len = BigInt((data.length - 2) / 2)
  return (
    ((2n ** 24n + len * 10_000n) * BigInt(status.workMultiplier)) / BigInt(status.workDivisor)
  )
}

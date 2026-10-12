import type { Hex } from 'viem'
import type { MsgBoardClient, WorkStats } from '@msgboard/sdk'

/** What a successful post tells you: the board hash, the work it cost, and how it landed. */
export type Submission = {
  hash: Hex
  stats: WorkStats
  /** True when `addMessage` reported an error and the board turned out to hold the message anyway. */
  recovered: boolean
}

/**
 * Grind a payload and put it on the board, then believe the board rather than the transport.
 *
 * `msgboard_addMessage` reports failure while the message lands. Measured on chain 943 on
 * 2026-08-19, on every post rather than occasionally:
 *
 *   code    -32603  ErrUpstreamsExhausted, "all upstream attempts failed"
 *   details attempts 0 · retries 0 · hedges 0 · upstreams 1 · durationMs 0
 *
 * `attempts: 0` in `durationMs: 0` is the gateway saying it never tried an upstream, and the
 * message is on the board a moment later regardless. It is specific to this one method: a read
 * routes and answers, and an invented `msgboard_notARealMethod` comes back
 * `ErrFailsafeRetryExceeded` — routed, retried, failed. Only the write is turned away before any
 * attempt. That is gateway configuration, not this client, and it followed a msgboard update.
 *
 * An earlier version of this comment blamed a fan-out race — one upstream accepting and a second
 * rejecting the duplicate. The measurement above does not support that, and a wrong cause written
 * down confidently is worse than none: it is why the 100% rate went unexamined for a week.
 *
 * **There is no status code to branch on.** A first post and a deliberate duplicate return the
 * same error, byte for byte, so nothing in the response distinguishes "landed" from "rejected".
 * Asking the board is the only thing that can tell them apart, which is what this does:
 * `msgboard_getMessage` returns null when the message truly is not there, and only then is the
 * post a failure.
 */
export async function grindAndSubmit(
  client: MsgBoardClient,
  category: Hex,
  data: Hex,
): Promise<Submission> {
  const work = await client.grind(category, data)
  const expected = work.message.hash
  try {
    const hash = await client.addMessage(work.message)
    return { hash, stats: work.stats, recovered: false }
  } catch (error) {
    if (await onBoard(client, expected)) {
      return { hash: expected, stats: work.stats, recovered: true }
    }
    throw error
  }
}

/** True when the board really holds this message. Null from the node means it does not. */
export async function onBoard(client: MsgBoardClient, hash: Hex): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const message = await client.getMessage(hash)
      if (message?.hash === hash) return true
    } catch {
      /* a read failure is not an answer — try again */
    }
    await new Promise((r) => setTimeout(r, 700))
  }
  return false
}

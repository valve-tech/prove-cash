import type { Hex } from 'viem'
import {
  type ChainId,
  decodeExclusiveQuote,
  decodeIntent,
  encodeExclusiveQuote,
  encodeIntent,
  type ExclusiveQuote,
  type SignedIntent,
} from '@prove.cash/sdk'
import { forTheBoard } from '../lib/fee'

/**
 * A signed pair, on its way to whoever will pay the gas.
 *
 * **The SDK has no wire format for an acceptance, and this is the gap it leaves.** It builds the
 * mirror (`mirrorFor`), it settles the pair (`settleExclusiveCall`), and between those two the
 * counterparty holds a signed intent with nowhere to put it. A quote has a board codec, a version
 * byte and a category. An acceptance has none of the three.
 *
 * It cannot simply go on the board beside the quote either. `sdk/src/rfq.ts` reserves the first
 * byte of every RFQ payload — 1 is a plain quote, 2 a sealed one, 3 a key announcement — and
 * `encodeIntent` opens with its own version 3. Posting a bare encoded intent under the RFQ
 * category would collide in that space, so the app would be inventing protocol. It is not the
 * app's to invent.
 *
 * So this is a clipboard payload and nothing more: JSON, one version field, and the two halves in
 * the SDK's own codecs. The app decides how the text is wrapped and the SDK still decides what
 * every byte inside it means, which is the line worth keeping until `rfq.ts` grows an
 * `encodeAcceptance`.
 *
 * The take is on the wire because it is not derivable. The mirror is all or nothing, so it is
 * always `mirror.amountIn` today, and a partial mirror tomorrow would make that assumption wrong
 * in a way nothing would catch.
 */
export type Ticket = {
  quote: ExclusiveQuote
  mirror: SignedIntent
  /** How much of the mirror the submitter takes. */
  take: bigint
}

const TICKET_VERSION = 1

type Wire = { v: number; quote: Hex; mirror: Hex; take: string }

/**
 * The text a counterparty copies and a submitter pastes.
 *
 * The mirror carries its fee config's preimage under the sign form's rule (`forTheBoard`): only
 * when the config is not one of `chainId`'s bundled defaults, so a submitter on another build can
 * show who the mirror's fee pays without a chain read. `mirrorFor` signs a mirror with no fee
 * config today, so the block is absent until a mirror names one. The settlement takes the hash
 * alone, so a mirror without the block still settles. `decodeTicket` hands any block back on the
 * mirror and keeps nothing: the pair is unverified until `checkExclusiveQuote` says otherwise.
 */
export function encodeTicket(t: Ticket, chainId: ChainId): string {
  const wire: Wire = {
    v: TICKET_VERSION,
    quote: encodeExclusiveQuote(t.quote),
    mirror: encodeIntent(forTheBoard(t.mirror, chainId)),
    take: t.take.toString(),
  }
  return JSON.stringify(wire)
}

/**
 * A pasted ticket, or null.
 *
 * Null for everything: not JSON, the wrong version, a half that does not decode, a take that is
 * not a number. A submitter can do nothing different about any of them, and the surface says one
 * sentence. What comes back is only well-formed — `checkExclusiveQuote` is what says it is real.
 */
export function decodeTicket(text: string): Ticket | null {
  try {
    const wire = JSON.parse(text.trim()) as Partial<Wire>
    if (wire.v !== TICKET_VERSION) return null
    if (typeof wire.quote !== 'string' || typeof wire.mirror !== 'string') return null
    if (typeof wire.take !== 'string' || !/^\d+$/.test(wire.take)) return null
    const quote = decodeExclusiveQuote(wire.quote as Hex)
    const mirror = decodeIntent(wire.mirror as Hex)
    if (!quote || !mirror) return null
    return { quote, mirror, take: BigInt(wire.take) }
  } catch {
    return null
  }
}

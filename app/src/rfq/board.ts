import type { Address, Hex } from 'viem'
import {
  decodeExclusiveQuote,
  decodeSealedQuote,
  latestRfqKeys,
  readRfqQuotes,
  sealedQuoteCounterparty,
  type ExclusiveQuote,
  type RfqKeyAnnouncement,
} from '@prove.cash/sdk'

/**
 * What the RFQ category holds right now, sorted into the three things that travel on it.
 *
 * One category carries quotes in the clear, quotes sealed to one address, and the key
 * announcements that make sealing possible. The version byte tells them apart and every decoder
 * in the SDK refuses a first byte it does not own, so this is a walk with three attempts per
 * message and no guessing.
 *
 * Most messages fail every attempt, and that is not an error. A board is public and anybody may
 * post anything to it.
 */
export type RfqBoard = {
  /** Every quote this reader could actually read, newest block first. */
  quotes: ReadQuote[]
  /** The newest key each address has announced, keyed by the lower-case address. */
  keys: Map<Address, RfqKeyAnnouncement>
  /**
   * Sealed messages addressed to `me` that this tab holds no key for.
   *
   * A count, not a list. Without the secret key there is nothing to show but the fact that
   * somebody quoted you, and the surface turns that into one line asking the reader to unlock.
   */
  lockedForMe: number
  /**
   * Sealed to `me`, tried with the key this tab holds, and refused anyway.
   *
   * Counted apart from `lockedForMe` because the reader's answer is different. Unlocking reads a
   * locked quote; nothing the reader does reads this one. Either the desk sealed to a key this
   * wallet does not derive, or the bytes changed between the desk and the board.
   *
   * Both were folded into the locked count until now, which told a reader who had already
   * unlocked their key to go and unlock it.
   */
  unreadableForMe: number
}

/** A quote off the board, and how it arrived. */
export type ReadQuote = {
  /** The board hash. Unique per message, so it is the React key and the deduplication key. */
  msgHash: Hex
  blockNumber: bigint
  quote: ExclusiveQuote
  /** True when the terms travelled encrypted. Worth saying: it decides who else saw the price. */
  sealed: boolean
}

/**
 * Read the whole category and sort it.
 *
 * @param me the reader's address, lower-cased or not. Only used to count the sealed messages
 *        addressed to them that this reader cannot open.
 * @param secretKey the half `deriveRfqKeyPair` returns, when the reader has unlocked it. Never
 *        stored anywhere: it lives in one component's state and dies with the tab.
 */
export async function readRfqBoard(
  me: Address | null,
  secretKey: Uint8Array | null,
): Promise<RfqBoard> {
  const messages = await readRfqQuotes()
  const keys = await latestRfqKeys(messages)
  const quotes: ReadQuote[] = []
  let lockedForMe = 0
  let unreadableForMe = 0
  const mine = me?.toLowerCase() ?? null

  for (const m of messages) {
    const blockNumber = BigInt(m.blockNumber)
    const plain = decodeExclusiveQuote(m.data)
    if (plain) {
      quotes.push({ msgHash: m.hash, blockNumber, quote: plain, sealed: false })
      continue
    }
    // Who it is for, without a curve operation. A reader walking a board of messages it cannot
    // read skips them on one slice, and only tries to open the ones addressed to it.
    const to = sealedQuoteCounterparty(m.data)
    if (!to) continue
    if (mine === null || to.toLowerCase() !== mine) continue

    // From here the message names this reader, so a failure is theirs to hear about rather than
    // one more message on a public board that was never for them.
    if (!secretKey) {
      lockedForMe++
      continue
    }
    const read = decodeSealedQuote(m.data, secretKey)
    if (read.ok) quotes.push({ msgHash: m.hash, blockNumber, quote: read.quote, sealed: true })
    else unreadableForMe++
  }

  quotes.sort((a, b) => (b.blockNumber > a.blockNumber ? 1 : b.blockNumber < a.blockNumber ? -1 : 0))
  return { quotes, keys, lockedForMe, unreadableForMe }
}

/** The quotes reserved for one address. Case-insensitive, because a binding is checked that way. */
export function quotesFor(quotes: readonly ReadQuote[], me: Address | null): ReadQuote[] {
  if (!me) return []
  const mine = me.toLowerCase()
  return quotes.filter((q) => q.quote.exclusive.counterparty.toLowerCase() === mine)
}

/** The quotes one address made. What a maker sees of their own desk. */
export function quotesFrom(quotes: readonly ReadQuote[], me: Address | null): ReadQuote[] {
  if (!me) return []
  const mine = me.toLowerCase()
  return quotes.filter((q) => q.quote.intent.maker.toLowerCase() === mine)
}

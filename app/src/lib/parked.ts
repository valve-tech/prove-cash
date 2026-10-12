import type { Address } from 'viem'
import type { ReservationState, TokenInfo } from '@prove.cash/sdk'

/**
 * The two decisions the Mine tab makes about capital that belongs to no offer.
 *
 * Both are pure, and they live here rather than inside `Portfolio` because that component fills
 * its table from an effect. `renderToStaticMarkup` never runs one, so anything decided inside the
 * component is decided where no test can reach it — and these two decide whether a maker is shown
 * their money and whether they are offered the only way to turn an offer off.
 *
 * The chain calls this capital parked. `park` moves a dead offer's reservation out of
 * `_reserved[hash]` and into `_parked[maker][token]`, and it is permissionless, so it happens
 * without the maker sending anything. `ProveSettlement.park` says what that costs a client that
 * only reads the first map: "a client that knows one function and not the other will show them a
 * balance that has gone somewhere."
 */

/** One token of a maker's capital that belongs to no offer. */
export type ParkedRow = { token: TokenInfo; amount: bigint }

/**
 * Which rows of a `parked` read to put on screen, in the order they were asked for.
 *
 * Three answers come back and only one is a row. A positive amount is money to show. Zero is a
 * fact — the row is empty — and a maker with an empty row has nothing to withdraw, so a line
 * saying so is noise on a page that is already dense.
 *
 * **Null is neither, and it must not render as zero.** A read that did not come back is an
 * endpoint having a bad minute, and this page's whole job is telling a maker where their money
 * is. Showing an unread row as empty says the money left. The poll is fifteen seconds and a row
 * that comes back is better than a row that lies for one of them.
 */
export function parkedRows(
  tokens: readonly TokenInfo[],
  amounts: readonly (bigint | null)[],
): ParkedRow[] {
  const out: ParkedRow[] = []
  for (let i = 0; i < tokens.length; i++) {
    const amount = amounts[i]
    if (amount === null || amount === undefined || amount <= 0n) continue
    out.push({ token: tokens[i], amount })
  }
  return out
}

/**
 * Which tokens to ask the `parked` map about: the ones this device knows, plus the ones the
 * chain's own logs name.
 *
 * The local half comes from `queryIntents({ limit: 100 })`, which is the newest hundred records
 * THIS BROWSER holds. A maker whose parked row belongs to a token outside that set never saw the
 * row, and parked capital is money. `Parked(intentHash, maker, token, amount)` indexes the maker,
 * so one log query names every token that ever parked for them and no record store is involved.
 *
 * **A failed log read hands this null, and null adds nothing.** It never subtracts. The maker
 * keeps every row they could already see, which is the same rule `parkedRows` keeps one step
 * later for a balance that did not come back.
 *
 * Case is not identity here. A store writes an address in lower case and a decoded log topic
 * comes back checksummed, so the same token arrives spelled two ways and a naive union would ask
 * about it twice and draw the row twice. The local spelling wins, because the offer rows are
 * already keyed on it.
 */
export function parkedTokenSet(
  local: readonly Address[],
  fromLogs: readonly Address[] | null,
): Address[] {
  const out: Address[] = []
  const seen = new Set<string>()
  for (const address of [...local, ...(fromLogs ?? [])]) {
    const id = address.toLowerCase()
    if (seen.has(id)) continue
    seen.add(id)
    out.push(address)
  }
  return out
}

/** As much of a Mine row as this decision reads. */
export type OfferState = {
  custody: 'auth' | 'escrow' | 'wallet'
  /** What the contract holds against this one offer, or null when the read did not come back. */
  reservation: ReservationState | null
  expired: boolean
  cancelled: boolean
}

/**
 * Whether this offer is a live escrow signature with nothing behind it.
 *
 * **The case that changed, and the reason this file exists.** Until `_drawFromParked` such an
 * offer could never fill: `_evaluate` answered `EscrowShort` for ever and only a transaction from
 * the maker altered that. "I signed it and I just will not deposit" was a real off switch, and it
 * was the one property the escrow rung had that no other rung had. Any solver may now fund one
 * out of capital freed from another of that maker's dead offers, at a moment the solver picks. So
 * the offer is live, and the app owes it the same way out every other live offer gets.
 *
 * Both escrow flavours, because the contract draws no line between them. An `auth` offer carries
 * a 3009 signature the maker attached, and `_redeemInto` still accepts the one word
 * `ARM_FROM_PARKED` for it instead.
 *
 * **An unread reservation is not an unfunded one.** Null means the chain did not answer, and
 * offering `cancel` there would end an offer whose money is still inside it — recoverable by
 * `withdraw` afterwards, but the wrong button and the wrong sentence. The claim is only made when
 * the chain said zero.
 */
export const unfundedAndLive = (o: OfferState): boolean =>
  o.custody !== 'wallet' &&
  !o.expired &&
  !o.cancelled &&
  o.reservation !== null &&
  o.reservation.amount === 0n

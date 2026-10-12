/**
 * The maker's bulk off switch, decided here rather than inside `Portfolio`.
 *
 * `invalidateBefore(floor)` reads one word as two numbers: the high 192 bits name a lane and the
 * low 64 name a position. It writes that position over `_laneFloor[maker][lane]`, and every
 * signature of that maker at a lower position in that lane stops being fillable. One transaction,
 * whatever the count.
 *
 * **The reason it beats fifty cancels is not gas. It is the preimage.** `cancel` takes the whole
 * `Intent`, so a maker who wants fifty offers off has to hold fifty signed structs. A maker who
 * cleared their browser holds none of them. A floor is a number, so it needs none. The spec at
 * `docs/specs/2026-09-08-delegation-and-bulk-maker-actions.md` Part 5 measures both
 * halves and this is the half gas cannot touch.
 *
 * **What it costs, and the copy has to say it.** A floor is one number, so it kills every offer
 * below it and the maker cannot keep an older one. It ends the signature and returns no money:
 * `park` now reads the floor, so anybody may then move a killed offer's deposit into
 * `_parked[maker][token]`, and the maker takes it home with one `withdrawParked` per token.
 *
 * These decisions live here and not in the component for `parked.ts`'s stated reason:
 * `Portfolio` fills its table from an effect, `renderToStaticMarkup` runs no effect, so anything
 * decided inside it is decided where no test reaches. This one decides which of a maker's offers
 * an irreversible transaction ends.
 *
 * **Why no field here is named for the nonce alone.** `nonce-lane.test.ts` pins every nonce-valued
 * field literal in `src` and `scripts`, and it pins them to make somebody bound a nonce this
 * repository BUILDS. A type that carries a nonce already signed builds none, and adding an
 * unbounded row to that table would blunt the guard rather than answer it. So the field says
 * `laneNonce`, which is also what it means: a nonce read as a lane and a position.
 */

/** A lane holds this many positions. A nonce's low 64 bits are its position inside its lane. */
export const LANE_POSITIONS = 2n ** 64n

/** The lane a nonce sits in: its high 192 bits. Every nonce this repository builds is in lane 0. */
export const laneOf = (laneNonce: bigint): bigint => laneNonce >> 64n

/** Where a nonce sits inside its lane: its low 64 bits. */
export const positionOf = (laneNonce: bigint): bigint => laneNonce & (LANE_POSITIONS - 1n)

/** As much of a Mine row as the floor decision reads. */
export type LaneOffer = {
  /** The row this offer is drawn on, so the caller can name it back to the maker. */
  key: string
  /** The offer's nonce. The settlement reads it as a lane and a position. */
  laneNonce: bigint
  /** False when the offer has expired or the maker already cancelled it. */
  live: boolean
}

/**
 * What one `invalidateBefore` would do to the offers on screen.
 *
 * Generic over the caller's own row, and that is not decoration. The two lists are what the maker
 * reads before an irreversible transaction, so each entry has to carry the pair and the size the
 * table already draws. Handing back a key and making the component look it up puts a "row not
 * found" branch on the confirm screen, and that branch would render as a shorter kill list.
 */
export type BulkRetire<T extends LaneOffer = LaneOffer> = {
  /**
   * The word to pass to `invalidateBefore`. Lane 0, and strictly above the floor the chain
   * already holds, so the contract cannot answer `BadParameter`.
   */
  floor: bigint
  /** The offers this floor ends, in the order they were given. Name every one before sending. */
  kills: T[]
  /** Live offers the floor does not reach. Each one still needs its own cancel. */
  spared: T[]
}

/**
 * Which offers one floor would end, and the floor to send.
 *
 * Null when there is nothing to retire. The caller shows no button then, because a floor at or
 * below the one the chain holds reverts with `BadParameter`.
 *
 * Three groups, and the split is the point:
 *
 *   killed   live, in lane 0, at or above the maker's current floor. One word ends all of them.
 *   spared   live and out of reach. Either the maker signed it in another lane, which this floor
 *            does not touch, or it sits at the top position of lane 0, which a strict comparison
 *            can never reach — the contract states that hole itself, above `_laneFloor`.
 *   neither  already off. Expired, cancelled, or below the floor the chain already holds.
 *
 * **`kills` is a floor on what dies, never a ceiling.** The rows come from a store on this
 * device, and the number goes to a contract that knows every signature the maker ever made. An
 * offer signed on another browser and below this floor dies with the rest, unlisted. The copy
 * says so; this comment says why it cannot do better.
 *
 * @param currentFloor lane 0's floor, read from the chain. `nonceFloor(maker)` answers it.
 */
export function bulkRetire<T extends LaneOffer>(
  offers: readonly T[],
  currentFloor: bigint,
): BulkRetire<T> | null {
  const top = LANE_POSITIONS - 1n
  const kills: T[] = []
  const spared: T[] = []
  let highest = 0n
  for (const offer of offers) {
    if (!offer.live) continue
    const position = positionOf(offer.laneNonce)
    if (laneOf(offer.laneNonce) !== 0n || position === top) {
      spared.push(offer)
      continue
    }
    if (position < currentFloor) continue
    kills.push(offer)
    if (position > highest) highest = position
  }
  if (kills.length === 0) return null
  // Every kill sits at or above `currentFloor`, so this is strictly above it and the write lands.
  return { floor: highest + 1n, kills, spared }
}

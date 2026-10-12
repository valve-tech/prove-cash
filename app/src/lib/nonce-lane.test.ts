/**
 * Every nonce this repository builds stays in lane 0.
 *
 * The settlement reads `Intent.nonce` as two numbers: the high 192 bits are a lane and the low 64
 * are a position inside it, so `invalidateBefore` retires one lane and spares every other. That
 * reading is backward compatible with every signature ever made here for exactly one reason —
 * this repository has three nonce producers and all three stay well inside one lane, which holds
 * 1.8e19. `Compose.tsx` and `MakeQuote.tsx` sign a millisecond epoch, about 1.8e12. The heartbeat
 * bot, at `app/scripts/heartbeat.ts:565`, signs that epoch times a thousand plus jitter, about
 * 1.8e15 — a thousandfold above the other two and still seven thousand times inside the lane.
 * `app/scripts/check-nonce-lanes.ts` measured it against the archive: 9,125 intents over chains
 * 369 and 943, all four wire versions, highest nonce 1,788,959,897,310,104. Every one of them has
 * 192 zero high bits, so lane 0's floor is the single floor the contract used to have.
 * `contracts/test/Lanes.t.sol::test_LaneZeroIsExactlyTheFloorTheContractAlwaysHad` is the
 * other half of the claim; this is the half that watches the sources.
 *
 * **The day somebody writes a wider nonce, that stops being true silently.** A nonce past 2^64
 * lands in a lane of its own, where the floor the maker already set does not reach it. No test
 * on a value can see that coming, because the value is correct — it is the SHAPE of the
 * expression that decides, and the expression lives in source. So this test reads the source.
 *
 * It pins the set of distinct nonce expressions rather than the files that hold them. A new lab
 * script that reuses a shape already here changes nothing; a new SHAPE fails this test and asks
 * its author for a bound. That is the point: the set cannot grow quietly.
 */
import { describe, expect, test } from 'vitest'
import { bulkRetire, laneOf, positionOf, LANE_POSITIONS, type LaneOffer } from './nonce-lane.ts'

/** One lane is 2^64 positions wide. A nonce at or above this is in lane 1 or higher. */
const LANE = 2n ** 64n

/**
 * A clock far enough ahead that a bound computed from it outlives the contract. Every expression
 * below is bounded against this rather than against `Date.now()`, so the test says something
 * about the future and not only about the minute it ran in.
 */
const CLOCK = BigInt(Date.UTC(2500, 0, 1))

/**
 * Every `nonce:` value in the app's sources, and the largest number it can produce.
 *
 * `max` is a bound on an INTENT nonce. `null` means the expression is not an intent nonce at
 * all, and the reason says which counter it belongs to — an Ethereum account's transaction count
 * and the msgboard proof-of-work nonce are different numbers that share a field name.
 */
const PINNED: Record<string, { max: bigint | null; why: string }> = {
  // ── The three producers, named rather than hedged at ───────────────────────
  //
  // Two surfaces a real maker signs through, and one bot. They do not share a shape: the
  // heartbeat's is a thousandfold wider, and "most scripts" used to hide that. Each producer
  // gets its own row now.
  'BigInt(Date.now())': {
    max: CLOCK,
    why: 'Compose.tsx and MakeQuote.tsx, and the scripts that copy them: a millisecond epoch',
  },
  'BigInt(Date.now()) + 1n': { max: CLOCK + 1n, why: 'a second offer in the same breath' },
  'BigInt(Date.now()) + 2n': { max: CLOCK + 2n, why: 'a third' },

  // ── Scripts that post several intents at once and space them apart ─────────
  'BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))': {
    max: CLOCK * 1000n + 1000n,
    why:
      'the heartbeat bot at app/scripts/heartbeat.ts:565, which needs a thousand distinct nonces ' +
      'per millisecond. About 1.8e15 today, and the largest nonce the archive holds: ' +
      '1,788,959,897,310,104 over 9,125 intents. It is the third producer, not a variant of the ' +
      'first two',
  },
  'BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1000))': {
    max: CLOCK + 1000n,
    why: 'lab scripts, jittered so two runs in one millisecond do not collide',
  },
  'BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 100000))': {
    max: CLOCK + 100_000n,
    why: 'the same, with more room',
  },
  'BigInt(Date.now()) + BigInt(Math.floor(Math.random() * 1e6))': {
    max: CLOCK + 1_000_000n,
    why: 'the same again',
  },
  'BigInt(Date.now()) + BigInt(k) + BigInt(Math.floor(Math.random() * 100000))': {
    max: CLOCK + 100_000n + 1_000n,
    why: 'one per leg of a ring, k bounded by the ring size',
  },
  'BigInt(Date.now()) + BigInt(k) + BigInt(Math.floor(Math.random() * 1e6))': {
    max: CLOCK + 1_000_000n + 1_000n,
    why: 'the same, with more room',
  },
  'intent.nonce + 1n': { max: CLOCK + 1n, why: 'devnet, re-pricing the intent above it' },
  'nonce++': {
    max: CLOCK,
    why: 'a running counter: `BigInt(Date.now())` in solver-devnet, a transaction count elsewhere',
  },

  // ── Fixtures and test intents ──────────────────────────────────────────────
  '0n': { max: 0n, why: 'a fixture' },
  '1n': { max: 1n, why: 'a fixture' },
  '7n': { max: 7n, why: 'a fixture' },
  '9n': { max: 9n, why: 'a fixture' },
  '11n': { max: 11n, why: 'a fixture' },
  '99n': { max: 99n, why: 'hash-check, which must match the contract fixture exactly' },

  // ── Not an intent nonce ────────────────────────────────────────────────────
  bigint: { max: null, why: 'a TypeScript type, not a value. No variable may be named `bigint`' },
  'bigint; hash: Hex': { max: null, why: 'the same, in a returned type' },
  'BigInt(m.nonce)': { max: null, why: "board.ts: the msgboard worker's proof-of-work nonce" },
  'BigInt(nonce)': { max: null, why: "getContractAddress: an EVM account's transaction count" },
  'await pub.getTransactionCount({ address: maker.address': {
    max: null,
    why: "an EVM account's transaction count, for a transaction this script sends",
  },
  latest: { max: null, why: 'unjam.ts: the stuck transaction nonce it is replacing' },
}

const SOURCES = import.meta.glob('../../{src,scripts}/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

/**
 * Every `nonce:` value, read the crudest way that cannot be argued with: from the colon to the
 * first comma or closing brace. A cleverer parser would have opinions; this one has a rule, and
 * the pinned keys above are written in its output's shape.
 *
 * `authNonce` is excluded by the word boundary. It is the EIP-3009 authorization's nonce, a
 * `bytes32` the token spends, and it has nothing to do with the floor.
 */
function found(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const [path, src] of Object.entries(SOURCES)) {
    for (const m of src.matchAll(/(?<![A-Za-z])nonce:\s*([^,}]*)/g)) {
      const expr = m[1].trim()
      if (expr === '') continue
      if (!out.has(expr)) out.set(expr, new Set())
      out.get(expr)?.add(path.replace('../../', 'app/'))
    }
  }
  return out
}

describe('the nonce lane', () => {
  const sites = found()

  test('the sources hold nothing this file has not seen', () => {
    const unpinned = [...sites]
      .filter(([expr]) => !(expr in PINNED))
      .map(([expr, where]) => `${expr}   ${[...where].sort().join(', ')}`)
    expect(
      unpinned,
      'a new nonce shape. Work out its largest value and pin it above. If it can reach 2^64 it ' +
        'is in another lane, and the maker who signs it needs a floor in that lane too',
    ).toEqual([])
  })

  test('the pins have not outlived their expressions', () => {
    // An entry that names nothing forgives nothing, and the next reader trusts it anyway. Same
    // rule the gas checker keeps for its own excuse list.
    expect(Object.keys(PINNED).filter((expr) => !sites.has(expr))).toEqual([])
  })

  test.each(Object.entries(PINNED).filter(([, b]) => b.max !== null))(
    '`%s` cannot leave lane 0',
    (_expr, bound) => {
      expect(bound.max).toBeLessThan(LANE)
    },
  )

  test('a bound is a real bound: the arithmetic is checked, not asserted', () => {
    // The clock this repository actually uses, run through the widest expression pinned above.
    // If a shape ever multiplies the epoch by enough to matter, this is the line that says so.
    const widest = BigInt(Date.now()) * 1000n + 999n
    expect(widest).toBeLessThan(LANE)
    expect(BigInt(Date.now()) >> 64n).toBe(0n)
  })
})

/**
 * The bulk off switch, which is the other thing a lane decides.
 *
 * The test above watches the sources so no nonce leaves lane 0. This half watches what the app
 * does with that fact: one `invalidateBefore` ends many offers, the maker sees exactly which ones
 * before they send it, and nothing on screen claims to retire an offer the floor cannot reach.
 *
 * It is an irreversible transaction over somebody's resting book, so every branch is here.
 */
describe('what one floor turns off', () => {
  const offer = (over: Partial<LaneOffer> = {}): LaneOffer => ({
    key: 'k',
    laneNonce: 1_000n,
    live: true,
    ...over,
  })

  test('a nonce splits into a lane and a position', () => {
    expect(laneOf(0n)).toBe(0n)
    expect(positionOf(0n)).toBe(0n)
    expect(laneOf(LANE_POSITIONS * 3n + 7n)).toBe(3n)
    expect(positionOf(LANE_POSITIONS * 3n + 7n)).toBe(7n)
  })

  test('a millisecond epoch is lane 0, which is why this app has a bulk switch at all', () => {
    const now = BigInt(Date.now())
    expect(laneOf(now)).toBe(0n)
    expect(positionOf(now)).toBe(now)
  })

  test('the floor sent is one above the newest offer it ends', () => {
    // Strict comparison: `_retired` asks `position < floor`, so the newest kill needs the floor
    // one above it or it survives the transaction that was sent to end it.
    const out = bulkRetire([offer({ key: 'a', laneNonce: 5n }), offer({ key: 'b', laneNonce: 9n })], 0n)
    expect(out?.floor).toBe(10n)
    expect(out?.kills.map((k) => k.key)).toEqual(['a', 'b'])
  })

  test('the floor is strictly above the one the chain already holds', () => {
    // The contract answers `BadParameter` for a floor at or below the current one, so a button
    // built from a lower number costs the maker a rejected transaction and changes nothing.
    const out = bulkRetire([offer({ laneNonce: 400n })], 400n)
    expect(out?.floor).toBe(401n)
  })

  test('an offer already below the floor is neither killed nor spared: it is off', () => {
    const out = bulkRetire(
      [offer({ key: 'dead', laneNonce: 10n }), offer({ key: 'live', laneNonce: 30n })],
      20n,
    )
    expect(out?.kills.map((k) => k.key)).toEqual(['live'])
    expect(out?.spared).toEqual([])
    expect(out?.floor).toBe(31n)
  })

  test('nothing left to retire offers no button', () => {
    // Every live offer is already under the floor, so there is no floor above this one that ends
    // anything. Null, and the caller draws no button rather than a disabled one that lies.
    expect(bulkRetire([offer({ laneNonce: 10n })], 50n)).toBeNull()
  })

  test('no offers at all offers no button', () => {
    expect(bulkRetire([], 0n)).toBeNull()
  })

  test('an expired offer is not counted, because a floor changes nothing for it', () => {
    expect(bulkRetire([offer({ live: false })], 0n)).toBeNull()
  })

  test('an offer the maker already cancelled is not counted either', () => {
    const out = bulkRetire(
      [offer({ key: 'off', live: false, laneNonce: 90n }), offer({ key: 'on', laneNonce: 40n })],
      0n,
    )
    expect(out?.kills.map((k) => k.key)).toEqual(['on'])
    // The dead offer's position must not raise the floor. It would kill nothing extra here, but
    // it would send a number the maker was never shown.
    expect(out?.floor).toBe(41n)
  })

  test('an offer in another lane is named as spared, never as retired', () => {
    // Nothing here builds such a nonce. A hand-signed intent can carry one, and a floor written
    // in lane 0 does not touch it — so the page says so rather than claiming fifty and ending
    // forty-nine.
    const out = bulkRetire(
      [offer({ key: 'here', laneNonce: 7n }), offer({ key: 'elsewhere', laneNonce: LANE_POSITIONS + 7n })],
      0n,
    )
    expect(out?.kills.map((k) => k.key)).toEqual(['here'])
    expect(out?.spared.map((s) => s.key)).toEqual(['elsewhere'])
    expect(out?.floor).toBe(8n)
  })

  test('a lane of its own is not enough to offer the switch', () => {
    // Every live offer is out of reach, so one word ends none of them and no button appears.
    expect(bulkRetire([offer({ laneNonce: LANE_POSITIONS })], 0n)).toBeNull()
  })

  test('the top position of a lane is spared, because a strict floor cannot reach it', () => {
    // The contract states this hole itself, above `_laneFloor`: the comparison is `<`, so no
    // floor retires its lane's last position. `cancel` is that offer's only way out.
    const out = bulkRetire(
      [offer({ key: 'top', laneNonce: LANE_POSITIONS - 1n }), offer({ key: 'ok', laneNonce: 3n })],
      0n,
    )
    expect(out?.kills.map((k) => k.key)).toEqual(['ok'])
    expect(out?.spared.map((s) => s.key)).toEqual(['top'])
    // And the floor stays inside the lane, so `uint64(floor)` is the position it says it is.
    expect(out?.floor).toBeLessThan(LANE_POSITIONS)
  })

  test('the kill list keeps the order the rows were drawn in', () => {
    // The maker reads this list against the table above it. A reorder makes them check fifty
    // rows twice before an irreversible transaction.
    const out = bulkRetire(
      [offer({ key: 'c', laneNonce: 30n }), offer({ key: 'a', laneNonce: 10n }), offer({ key: 'b', laneNonce: 20n })],
      0n,
    )
    expect(out?.kills.map((k) => k.key)).toEqual(['c', 'a', 'b'])
    expect(out?.floor).toBe(31n)
  })
})

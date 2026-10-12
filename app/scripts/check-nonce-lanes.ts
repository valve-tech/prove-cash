/**
 * Every nonce the msgboard archive holds, and the lane each one sits in.
 *
 * `ProveSettlement` reads a nonce's high 192 bits as a lane and its low 64 as a position (#131).
 * Lane 0 is exactly the floor the contract always had, so the compatibility claim rests on one
 * fact: nothing anybody signed has ever carried a nonce at or above 2^64. This asks the archive
 * rather than assuming it, which is what `2026-09-08-delegation-and-bulk-maker-actions.md` says
 * to do before shipping the lane reading.
 *
 * **It reads all five wire versions, and that is the point.** The SDK's own `decodeIntent`
 * refuses anything that is not the current version, so it answers about version 5 alone. The
 * mainnet board carries versions 1 and 3, and a first run using `decodeIntent` decoded nothing
 * there and reported a clean sweep of an empty set. The walker below knows every layout up to
 * the nonce and parses each row to its last byte, so a row counts only when every byte is
 * consumed.
 *
 * It is manual, and it stays manual. It reads a third-party endpoint over the network and takes
 * about half a minute, so CI would gain a flake and lose nothing. Run it before any change to
 * how the contract reads a nonce.
 *
 *     npx tsx scripts/check-nonce-lanes.ts
 *
 * It exits 1 if any nonce reaches lane 1, which is the answer that would make the lane reading a
 * behaviour change rather than a reinterpretation.
 */
import { fetchArchivePage } from '@prove.cash/sdk'

/** The largest position lane 0 holds. A nonce above it lives in another lane. */
const LANE0_MAX = (1n << 64n) - 1n
const PAGE = 500
const CHAINS = [369, 943]

// Presence bits, each named by the version that introduced it.
const P_RECIPIENT = 1
const P_EXECUTOR = 2
const P_FEE_TO = 4
const P_FEE_RATE = 8
const P_MIN_FILL = 16
const P_AUTH_NONCE = 32

const KIND_AUTH = 2
const KIND_PERMIT = 3
const KIND_PERMIT2 = 4

/** A read that ran off the end. The row is not an intent, and the caller says so. */
class Short extends Error {}

type Parsed = { version: number; nonce: bigint }

/**
 * The nonce out of one board payload, on any wire version this repository has ever posted.
 *
 * Versions differ only in which optional fields exist: 1 has a recipient and an executor, 2 adds
 * the fee pair, 3 adds a minimum fill and a 3009 nonce and lengthens both signatures, 4 adds the
 * Permit2 kind. Everything before the nonce is fixed-width or length-prefixed, so one walker
 * covers all four.
 */
function parse(data: string): Parsed | null {
  const b = Buffer.from(data.slice(2), 'hex')
  if (b.length < 70) return null
  const version = b[0]
  const kind = b[1]
  const presence = b[3]
  if (version < 1 || version > 5) return null
  const maxKind = version === 1 ? KIND_AUTH : version >= 4 ? KIND_PERMIT2 : KIND_PERMIT
  if (kind < 1 || kind > maxKind) return null

  let o = 4
  const need = (n: number): void => {
    if (o + n > b.length) throw new Short()
  }
  const uint = (n: number): bigint => {
    need(n)
    let v = 0n
    for (let k = 0; k < n; k++) v = (v << 8n) | BigInt(b[o + k])
    o += n
    return v
  }
  const skip = (n: number): void => {
    need(n)
    o += n
  }
  const varint = (): bigint => {
    need(1)
    return uint(b[o++])
  }
  const blob = (): number => {
    need(2)
    const len = (b[o] << 8) | b[o + 1]
    o += 2
    need(len)
    o += len
    return len
  }

  try {
    skip(60) // maker, tokenIn, tokenOut
    if (presence & P_RECIPIENT) skip(20)
    if (presence & P_EXECUTOR) skip(20)
    if (version >= 2) {
      // Version 5 names a fee config by its 32-byte hash where version 2 to 4 named a 20-byte sink.
      if (presence & P_FEE_TO) skip(version >= 5 ? 32 : 20)
      if (presence & P_FEE_RATE) uint(8)
      // Version 5's extension: a flags byte, then eight bytes for each of P1 and P3 it names,
      // then (bit 2) the optional fee config preimage block: a count, that many 20-byte
      // destinations and one fewer 8-byte weights.
      if (version >= 5 && presence & 128) {
        const ext = uint(1)
        if (Number(ext) & 1) uint(8)
        if (Number(ext) & 2) uint(8)
        if (Number(ext) & 4) {
          const n = Number(uint(1))
          if (n < 1 || n > 8) throw new Short()
          skip(20 * n + 8 * (n - 1))
        }
      }
    }
    varint() // amountIn
    varint() // minOutStart
    varint() // minOutEnd
    if (version >= 3) {
      if (presence & P_MIN_FILL) varint()
      if (presence & P_AUTH_NONCE) skip(32)
    }
    uint(5) // startTime
    uint(4) // duration
    const nonce = varint()
    if (version >= 3) {
      if (blob() === 0) return null
    } else skip(65)
    if (kind === KIND_AUTH) {
      varint()
      varint()
      if (version >= 3) {
        if (blob() === 0) return null
      } else skip(65)
    } else if (kind === KIND_PERMIT) {
      varint()
      varint()
      skip(65)
    } else if (kind === KIND_PERMIT2) {
      skip(20)
      varint()
      varint()
      blob()
    }
    // The exact-consume check is what separates an intent from a quote that happens to start
    // with plausible bytes. Without it a walker reports nonces nobody ever signed.
    if (o !== b.length) return null
    return { version, nonce }
  } catch (e) {
    if (e instanceof Short) return null
    throw e
  }
}

let offenders = 0

for (const chainId of CHAINS) {
  let offset = 0
  let total: number | null = null
  let notAnIntent = 0
  let highest = 0n
  const byVersion = new Map<number, number>()
  const byLane = new Map<bigint, number>()

  for (;;) {
    const page = await fetchArchivePage(chainId, PAGE, offset)
    total ??= page.total
    if (page.rows.length === 0) break
    for (const row of page.rows) {
      const parsed = parse(row.data)
      if (!parsed) {
        notAnIntent++
        continue
      }
      byVersion.set(parsed.version, (byVersion.get(parsed.version) ?? 0) + 1)
      if (parsed.nonce > highest) highest = parsed.nonce
      const lane = parsed.nonce >> 64n
      byLane.set(lane, (byLane.get(lane) ?? 0) + 1)
      if (parsed.nonce > LANE0_MAX) {
        offenders++
        console.log(`  LANE ${lane} ${row.hash} nonce ${parsed.nonce} seen ${row.first_seen_at}`)
      }
    }
    offset += page.rows.length
    if (offset >= total) break
  }

  const versions = [...byVersion.entries()].sort((a, b) => a[0] - b[0])
  console.log(`chain ${chainId}`)
  console.log(`  archive rows         ${total}`)
  console.log(`  parsed as an intent  ${versions.map(([v, c]) => `v${v}:${c}`).join(' ') || 'none'}`)
  console.log(`  not an intent        ${notAnIntent}`)
  console.log(`  highest nonce        ${highest}`)
  console.log(`  lanes occupied       ${[...byLane].map(([l, c]) => `${l}:${c}`).join(' ')}`)
}

if (offenders > 0) {
  console.error(`\n${offenders} nonces reach lane 1 or above. The lane reading is a behaviour`)
  console.error('change for them, not a reinterpretation. Read Part 7 of the delegation spec.')
  process.exit(1)
}
console.log('\nOK: every nonce the archive holds sits in lane 0.')

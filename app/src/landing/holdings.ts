import type { Address } from 'viem'
import { getLocale, t, tCount } from '../lib/i18n.ts'

/**
 * Which tokens an address has actually moved, from the appearance index.
 *
 * The landing page asks a visitor to sign a swap, and the hardest part of that is the blank
 * form: pick a pair, from a list of tokens, on a chain you may never have used. An address
 * answers it. Somebody who has moved tUSDC on this chain should be shown tUSDC, not a
 * catalogue.
 *
 * The source is `chifra.valve.city`, the TrueBlocks daemon behind the Explore app. It reads
 * `export --logs`, which returns every log of every transaction the address appears in, and
 * keeps the ERC-20 `Transfer` rows where the address is one of the two parties. The token is
 * the log's own contract, so no name lookup and no balance read are needed to know which
 * tokens somebody has touched.
 *
 * Nothing here is a balance. A token moved out is still a token the visitor knows, and asking
 * the chain for nine balances to find that out would cost nine calls for a hint.
 */

const CHIFRA = 'https://chifra.valve.city'

/**
 * The chain the app trades on, and the tokens it lists there.
 *
 * Copied rather than imported. The landing page must not pull `@prove.cash/sdk` into the entry
 * bundle — that is the whole reason the two surfaces are split, and one import of `presetTokens`
 * would drag viem and the chain registry in behind it. `holdings.test.ts` compares this list to
 * the SDK's own, so a preset added on one side fails on the other instead of drifting.
 */
export const START_CHAIN = 943

export type StartToken = {
  address: Address
  symbol: string
  /** Spelled out, for the tooltip. A ticker is not a name to somebody new to the chain. */
  name: string
  /** The brand mark. See `MARK` below for why these are not the token's own address. */
  logo: string
}

/**
 * Where a mark comes from.
 *
 * gib.show has no image for a testnet token — `eip155-943/<tUSDC>` is a 404, measured 2026-09-10 — so each
 * entry borrows the mark of the real token it stands for. tUSDC wears USDC's circle because that
 * is what it is a test copy of, and a reader recognises the brand long before the address.
 *
 * The three live tokens name their PulseChain selves, which gib.show does carry.
 */
const MARK = (caip: string, address: string) => `https://gib.show/image/${caip}/${address}`
const ETH = 'eip155-1'
const PLS = 'eip155-369'

export const START_TOKENS: readonly StartToken[] = [
  {
    address: '0x70499adEBB11Efd915E3b69E700c331778628707',
    symbol: 'WPLS',
    name: 'Wrapped Pulse',
    logo: MARK(PLS, '0xA1077a294dDE1B09bB078844df40758a5D0f9a27'),
  },
  {
    address: '0x8a810ea8B121d08342E9e7696f4a9915cBE494B7',
    symbol: 'PLSX',
    name: 'PulseX',
    logo: MARK(PLS, '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab'),
  },
  {
    address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39',
    symbol: 'HEX',
    name: 'HEX',
    logo: MARK(PLS, '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39'),
  },
  {
    address: '0xabeF58363E0fc60250D16778848eAED831eA26F9',
    symbol: 'tPLSX',
    name: 'Test PulseX',
    logo: MARK(PLS, '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab'),
  },
  {
    address: '0xA54e1565AB28360B66809803306Ec5b1229808a0',
    symbol: 'tHEX',
    name: 'Test HEX',
    logo: MARK(PLS, '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39'),
  },
  {
    address: '0x86390129a2079fb7f0FC889473160a3a449117Ab',
    symbol: 'tUSDC',
    name: 'Test USD Coin',
    logo: MARK(ETH, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'),
  },
  {
    address: '0x7d32f9Ebb6C5813435f4bDF4e9beaF99C805D529',
    symbol: 'tUSDT',
    name: 'Test Tether USD',
    logo: MARK(ETH, '0xdAC17F958D2ee523a2206206994597C13D831ec7'),
  },
  {
    address: '0x70c421a8baC4aDAa10285A20EfF09997A5e09565',
    symbol: 'tWBTC',
    name: 'Test Wrapped Bitcoin',
    logo: MARK(ETH, '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'),
  },
  {
    address: '0xCb5C3ED9cD727f142d1b9eFc60790550683aA655',
    symbol: 'tWETH',
    name: 'Test Wrapped Ether',
    logo: MARK(ETH, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'),
  },
]

/**
 * Every startable token, with the ones this address has actually moved brought to the front.
 *
 * This used to return the intersection alone, and when the intersection was empty the section
 * printed the same nine chips it had printed before the lookup — a request went out, real data
 * came back, and the screen did not change. A reader watching that concluded the feature was
 * broken, and they were right to.
 *
 * So nothing is filtered away. A held token is marked and leads; the rest keep their order
 * behind it. Every answer now moves something on screen.
 */
export type Ranked = { token: StartToken; held: boolean }

export function ranked(moved: readonly Address[]): Ranked[] {
  const order = new Map(moved.map((a, i) => [a.toLowerCase(), i]))
  const rank = (t: StartToken) => order.get(t.address.toLowerCase()) ?? Infinity
  return START_TOKENS.map((token, i) => ({ token, held: rank(token) !== Infinity, i }))
    .sort((a, b) => rank(a.token) - rank(b.token) || a.i - b.i)
    .map(({ token, held }) => ({ token, held }))
}

/** Just the held ones, for the sentence above the chips. */
export const heldOf = (list: readonly Ranked[]): StartToken[] =>
  list.filter((r) => r.held).map((r) => r.token)


/** `Transfer(address,address,uint256)`. */
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/** The chains the index covers that this app also knows. Its slugs, not ours. */
export const CHIFRA_CHAIN = { 943: 'pulsechain-v4', 369: 'pulsechain' } as const

export type SearchChain = keyof typeof CHIFRA_CHAIN

/**
 * A dropped read is not an empty wallet.
 *
 * Every other reader in this app learned that the hard way: a failed call became "this pair has
 * no liquidity", "this chain has no router", "there is no market here". Here it would become
 * "you have never used this chain", which is worse, because the visitor cannot check it.
 */
export type Moved =
  | {
      ok: true
      chainId: SearchChain
      tokens: readonly Address[]
      /** The read hit its record cap, so there may be older tokens it never saw. */
      truncated: boolean
    }
  | { ok: false; reason: 'unreachable' }

/** One row of `export --logs`, in the fields this file reads. */
type LogRow = { address?: unknown; topics?: unknown }

/** A 32-byte topic holds a 20-byte address in its low bytes. */
const topicIs = (topic: unknown, owner: string): boolean =>
  typeof topic === 'string' && topic.length === 66 && topic.slice(26).toLowerCase() === owner

/**
 * The distinct tokens this owner sent or received, latest first.
 *
 * Split out from the fetch because this is the part that can be wrong: a log the owner merely
 * appears near — a swap routed through a pool they never held — is not a token they have. The
 * owner must be the sender or the recipient, which is topic 1 or topic 2 of a `Transfer`.
 */
export function tokensMoved(rows: readonly LogRow[], owner: Address): Address[] {
  const who = owner.slice(2).toLowerCase()
  const seen = new Set<string>()
  const out: Address[] = []
  for (const row of rows) {
    const topics = row.topics
    if (!Array.isArray(topics) || topics[0] !== TRANSFER) continue
    if (!topicIs(topics[1], who) && !topicIs(topics[2], who)) continue
    const token = typeof row.address === 'string' ? row.address.toLowerCase() : ''
    if (!/^0x[0-9a-f]{40}$/.test(token) || seen.has(token)) continue
    seen.add(token)
    out.push(token as Address)
  }
  return out
}

/**
 * How long to wait, and how far back to look.
 *
 * Measured against the live daemon, same query, over one afternoon: an unused address answers in
 * 1.4s, one with 145 log rows in 3.2s and then 12.3s an hour later, and a busy wallet does not
 * answer inside two minutes — the gateway in front of it eventually gives up, and it drops the
 * CORS header when it does, so the browser reports a policy error rather than a timeout.
 *
 * So the wait is generous enough for the variance and still bounded, because the page works
 * without the answer. 12s cut off the 12.3s case; 20s does not.
 *
 * The cap binds in practice — a real address filled all 250 rows — so a truncated read says so
 * rather than passing off the most recent slice as the whole history.
 */
const TIMEOUT_MS = 20_000
const MAX_RECORDS = 250

export async function movedTokens(
  owner: Address,
  chainId: SearchChain,
  fetchImpl: typeof fetch = fetch,
): Promise<Moved> {
  const query = new URLSearchParams({
    addrs: owner,
    chain: CHIFRA_CHAIN[chainId],
    logs: 'true',
    reversed: 'true',
    maxRecords: String(MAX_RECORDS),
  })
  try {
    const res = await fetchImpl(`${CHIFRA}/export?${query}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, reason: 'unreachable' }
    const body: unknown = await res.json()
    const rows = (body as { data?: unknown }).data
    if (!Array.isArray(rows)) return { ok: false, reason: 'unreachable' }
    return {
      ok: true,
      chainId,
      tokens: tokensMoved(rows as LogRow[], owner),
      truncated: rows.length >= MAX_RECORDS,
    }
  } catch {
    return { ok: false, reason: 'unreachable' }
  }
}

export type Look =
  | { phase: 'idle' }
  | { phase: 'looking' }
  | {
      phase: 'done'
      /** Every token the index saw this address move, listed here or not. */
      moved: readonly Address[]
      /** Those of them this app can open a form on. */
      held: readonly StartToken[]
      truncated: boolean
    }
  | { phase: 'unreachable' }

/**
 * What the section says it found.
 *
 * Four states that look alike from across the room and mean entirely different things. Two rules
 * hold them apart. An index that did not answer never reads as an empty wallet — that is the
 * fault this codebase spent a week pulling out of its chart, its board and its venue probe, and
 * here it would be worse, because a reader cannot check it. And an address with a history we
 * cannot trade is told what it has, not told it has nothing.
 */
export function verdict(look: Look): string {
  if (look.phase === 'unreachable') return t('landing.verdict.unreachable')
  if (look.phase !== 'done') return t('landing.verdict.idle')

  const others = look.moved.length - look.held.length
  if (look.held.length > 0) {
    const head = t('landing.verdict.held', { tokens: names(look.held) })
    // The tail counts tokens we know about and have not listed. `tCount` picks the form; the
    // English used to glue an `s` on and choose between "is" and "are" by hand, which is a rule
    // only English has.
    return others > 0 ? `${head} ${tCount('landing.verdict.others', others)}` : head
  }
  if (look.moved.length > 0) {
    // "recently" when the read hit its cap: we saw a slice of the history and must not describe
    // that slice as the whole of it. Two whole sentences rather than one with an adverb in a
    // hole, because a hole holding an adverb is a hole a translator cannot inflect.
    const base = look.truncated ? 'landing.verdict.moved.recently' : 'landing.verdict.moved.here'
    return tCount(base, look.moved.length)
  }
  return t('landing.verdict.new')
}

/** "1 token", "3 tokens" — and "1 other token", "3 other tokens". */

/** "tPLSX", "tPLSX and tUSDC", "tPLSX, tUSDC and WPLS". */
/**
 * Token symbols as a list the reader's language would write.
 *
 * `Intl.ListFormat` rather than `join(', ') + ' and '`. The separator and the final conjunction
 * are both language, and Japanese uses neither of the English ones. Symbols themselves never
 * translate, which is why they can be handed to it raw.
 */
function names(tokens: readonly StartToken[]): string {
  const s = tokens.map((x) => x.symbol)
  if (s.length <= 1) return s[0] ?? ''
  try {
    return new Intl.ListFormat(getLocale(), { style: 'long', type: 'conjunction' }).format(s)
  } catch {
    return s.join(', ')
  }
}

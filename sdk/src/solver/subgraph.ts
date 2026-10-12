import type { Address } from 'viem'
import type { VenueSubgraph, XykVenue } from '../config.js'

/**
 * Pool discovery from PulseX's own subgraphs: which pairs exist, and which to read first.
 *
 * **Discovery only, never truth.** The owner's rule is "use the subgraph for discovery, chain for
 * truth". So nothing this file returns is a price. It returns pair addresses, the tokens the
 * subgraph says they hold, and a rank that orders the reads. `graphsync.ts` then reads every pair
 * from the chain: `token0`, `token1`, `factory` and `getReserves`. A pair whose chain answers
 * disagree with this file is dropped. `graph.ts` qualifies pools on chain reserves alone.
 *
 * **The rank is gameable, and that is why it only orders.** On mainnet v1, `trackedReservePLS`
 * puts pDAI/ATROPA first, at ten times PLSX/WPLS. That pool is real (1.37 million transactions
 * since May 2023), but the field is only as honest as the tokens that feed it, and anybody can
 * create a pair. So the rank decides which pairs to read first, and nothing else.
 *
 * **When the subgraph cannot be trusted, it is not used.** Each answer carries `_meta`. A
 * subgraph that reports an indexing error, that lags the chain head by more than
 * `maxLagBlocks`, or that indexes a factory other than the venue's, is a failure. So is one that
 * does not answer, or answers something this file cannot parse. A failure is a value, never a
 * throw: the keeper keeps what it already holds, and the executor keeps `quoteAll`.
 *
 * Measured on 2026-09-23. Mainnet: 1,000 pairs by `trackedReservePLS` answered in 4.6 s (v1) and
 * 5.8 s (v2), and fourteen per-token lists in one request in 7.5 to 11.9 s. Testnet is slower:
 * 300 backbone pairs in 5.0 s, eighteen per-token lists in 18.2 s, and a whole cold discovery in
 * 51 s. A filter on `symbol` timed out on the server for eleven of twelve queries, which is one
 * more reason this file asks by address only.
 */

/** A token as the subgraph names it. The address is the key; the symbol is for logs. */
export type SubgraphToken = { address: Address; symbol: string; decimals: number }

/** One pair the subgraph listed, not yet checked against the chain. */
export type DiscoveredPair = {
  address: Address
  token0: SubgraphToken
  token1: SubgraphToken
  /** The venue label from the registry, never from the subgraph. */
  venue: string
  /** `trackedReservePLS`, or `reservePLS` for a per-token list. Orders reads. Never qualifies. */
  rank: number
}

/** Why a subgraph answer was not used. */
export type DiscoveryFailure =
  | 'unreachable'
  | 'malformed'
  | 'indexing-errors'
  | 'stale'
  | 'wrong-factory'

/** What one venue's discovery found, or why it found nothing. */
export type VenueDiscovery =
  | { venue: string; ok: true; block: bigint; pairs: DiscoveredPair[]; requests: number; ms: number }
  | {
      venue: string
      ok: false
      reason: DiscoveryFailure
      detail: string
      requests: number
      ms: number
    }

/** How wide a discovery reaches, and how long it waits. */
export type DiscoveryOptions = {
  /** The chain head the caller read. A subgraph behind it by more than `maxLagBlocks` is stale. */
  head: bigint
  /** Tokens the caller needs priced: the registry's, and the board's. By address. */
  tokens: readonly Address[]
  /**
   * The deepest pairs by `trackedReservePLS`, per venue. The hubs every route passes through.
   * 300 by default.
   */
  backbone?: number
  /** Pairs per side per token of interest, by `reservePLS`. 20 by default. */
  perToken?: number
  /**
   * How many counterpart tokens of the tokens of interest get their own pairs listed, in a
   * second request. 16 by default. This is what reaches a third hop: tWBTC's only pair is with
   * tUSDC, and tUSDC's pairs hold the WPLS leg.
   */
  neighbours?: number
  /** Pairs per side per counterpart token. 10 by default. */
  perNeighbour?: number
  /**
   * How far behind the chain head the subgraph may be, in blocks. 50 by default, about eight
   * minutes on either chain. Both were within two blocks when measured.
   */
  maxLagBlocks?: number
  /** Per request. 60 s by default: the slowest measured request took 23 s, on testnet. */
  timeoutMs?: number
  fetch?: typeof fetch
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** Raised inside this file only, and always caught by `discoverVenue`. */
class Refused extends Error {
  readonly reason: DiscoveryFailure
  constructor(reason: DiscoveryFailure, detail: string) {
    super(detail)
    this.reason = reason
  }
}

const PAIR_FIELDS =
  'id token0 { id symbol decimals } token1 { id symbol decimals } trackedReservePLS reservePLS'

/**
 * Ask one subgraph a GraphQL question. Throws `Refused` on anything but a clean answer.
 *
 * `errors` beside `data` is a refusal too: The Graph returns a partial answer with errors, and a
 * partial list read as a whole list would say "these are all the pairs" when it is not true.
 */
async function ask(
  url: string,
  query: string,
  opts: DiscoveryOptions,
): Promise<Record<string, unknown>> {
  const doFetch = opts.fetch ?? fetch
  let res: Response
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
    })
  } catch (e) {
    throw new Refused('unreachable', e instanceof Error ? e.name : 'fetch failed')
  }
  if (!res.ok) throw new Refused('unreachable', `HTTP ${res.status}`)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Refused('malformed', 'the body is not JSON')
  }
  if (!body || typeof body !== 'object') throw new Refused('malformed', 'the body is not an object')
  const { data, errors } = body as { data?: unknown; errors?: unknown }
  if (Array.isArray(errors) && errors.length > 0) {
    const first = errors[0] as { message?: unknown }
    // The server's message can be long SQL. The first line is enough to say what happened.
    const message = String(first?.message ?? 'error').split('\n')[0].slice(0, 160)
    throw new Refused('malformed', `the subgraph answered with an error: ${message}`)
  }
  if (!data || typeof data !== 'object') throw new Refused('malformed', 'no data')
  return data as Record<string, unknown>
}

/** A symbol for a log line: printable, and short. A token picks its own symbol. */
function cleanSymbol(v: unknown): string {
  const s = typeof v === 'string' ? v : '?'
  // oxlint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24) || '?'
}

function parseToken(v: unknown): SubgraphToken | null {
  if (!v || typeof v !== 'object') return null
  const t = v as { id?: unknown; symbol?: unknown; decimals?: unknown }
  if (typeof t.id !== 'string' || !ADDRESS.test(t.id)) return null
  const decimals = Number(t.decimals)
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return null
  return { address: t.id.toLowerCase() as Address, symbol: cleanSymbol(t.symbol), decimals }
}

/**
 * The pairs in one list field. A row that does not parse is a malformed answer, not a row to
 * skip: a subgraph that returns a damaged row may have returned other damage this check cannot
 * see.
 */
function parsePairs(v: unknown, venue: string, rankField: 'trackedReservePLS' | 'reservePLS') {
  if (!Array.isArray(v)) throw new Refused('malformed', 'a pair list is not a list')
  return v.map((row): DiscoveredPair => {
    const p = row as Record<string, unknown>
    const token0 = parseToken(p?.token0)
    const token1 = parseToken(p?.token1)
    if (typeof p?.id !== 'string' || !ADDRESS.test(p.id) || !token0 || !token1) {
      throw new Refused('malformed', 'a pair row does not parse')
    }
    if (token0.address === token1.address) throw new Refused('malformed', 'a pair of one token')
    const rank = Number(p[rankField])
    return {
      address: p.id.toLowerCase() as Address,
      token0,
      token1,
      venue,
      rank: Number.isFinite(rank) && rank > 0 ? rank : 0,
    }
  })
}

/** Aliased per-token pair lists, one for each side of each token. */
function perTokenQuery(tokens: readonly string[], first: number, prefix: string): string {
  return tokens
    .map((t, i) =>
      [0, 1]
        .map(
          (side) =>
            `${prefix}${i}_${side}: pairs(first: ${first}, where: { token${side}: "${t}" }, ` +
            `orderBy: reservePLS, orderDirection: desc) { ${PAIR_FIELDS} }`,
        )
        .join(' '),
    )
    .join(' ')
}

/**
 * Discover one venue's pairs: the backbone, the pairs of every token of interest, and the pairs
 * of their counterparts. Two requests at most, and never a throw.
 */
export async function discoverVenue(
  venue: XykVenue,
  source: VenueSubgraph,
  opts: DiscoveryOptions,
): Promise<VenueDiscovery> {
  const started = Date.now()
  let requests = 0
  const done = (): { requests: number; ms: number } => ({ requests, ms: Date.now() - started })
  try {
    if (source.factory.toLowerCase() !== venue.factory.toLowerCase()) {
      // A configuration error, caught before a request is spent on it.
      throw new Refused('wrong-factory', `the subgraph is recorded for ${source.factory}`)
    }
    // Only well-formed addresses reach the query text. A token address comes off the board, and
    // the board is written by strangers.
    const tokens = [...new Set(opts.tokens.map((t) => t.toLowerCase()))].filter((t) =>
      ADDRESS.test(t),
    )
    const backbone = opts.backbone ?? 300
    const perToken = opts.perToken ?? 20

    requests++
    const first = await ask(
      source.url,
      `{ _meta { block { number } hasIndexingErrors } pulseXFactories(first: 2) { id } ` +
        `backbone: pairs(first: ${backbone}, orderBy: trackedReservePLS, orderDirection: desc) ` +
        `{ ${PAIR_FIELDS} } ${perTokenQuery(tokens, perToken, 't')} }`,
      opts,
    )

    const meta = first._meta as { block?: { number?: unknown }; hasIndexingErrors?: unknown }
    const indexed = Number(meta?.block?.number)
    if (!Number.isInteger(indexed) || indexed < 0) throw new Refused('malformed', 'no _meta block')
    if (meta.hasIndexingErrors !== false) {
      throw new Refused('indexing-errors', `the subgraph reports indexing errors at ${indexed}`)
    }
    const lag = opts.head - BigInt(indexed)
    if (lag > BigInt(opts.maxLagBlocks ?? 50)) {
      throw new Refused('stale', `the subgraph is ${lag} blocks behind the chain head`)
    }
    const factories = first.pulseXFactories
    if (
      !Array.isArray(factories) ||
      factories.length !== 1 ||
      String((factories[0] as { id?: unknown })?.id ?? '').toLowerCase() !==
        venue.factory.toLowerCase()
    ) {
      throw new Refused('wrong-factory', `the subgraph does not index ${venue.factory}`)
    }

    const pairs = new Map<string, DiscoveredPair>()
    const put = (list: DiscoveredPair[]) => {
      for (const p of list) {
        const held = pairs.get(p.address)
        if (!held || p.rank > held.rank) pairs.set(p.address, p)
      }
    }
    const spine = parsePairs(first.backbone, venue.label, 'trackedReservePLS')
    put(spine)
    // A token already in the backbone has its deep pairs listed. Only the others need a second
    // look, and those are exactly the tokens a third hop has to pass through.
    const listed = new Set(spine.flatMap((p) => [p.token0.address, p.token1.address]))
    const interest = new Set(tokens)
    const counterparts = new Map<string, number>()
    for (let i = 0; i < tokens.length; i++) {
      for (const side of [0, 1]) {
        const list = parsePairs(first[`t${i}_${side}`], venue.label, 'reservePLS')
        put(list)
        for (const p of list) {
          for (const t of [p.token0.address, p.token1.address]) {
            if (interest.has(t) || listed.has(t)) continue
            counterparts.set(t, Math.max(counterparts.get(t) ?? 0, p.rank))
          }
        }
      }
    }

    // The second request: the pairs of the counterparts a token of interest trades against, so
    // a path can reach the native token in three hops rather than two.
    const reach = [...counterparts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.neighbours ?? 16)
      .map(([t]) => t)
    if (reach.length > 0) {
      requests++
      const second = await ask(
        source.url,
        `{ ${perTokenQuery(reach, opts.perNeighbour ?? 10, 'n')} }`,
        opts,
      )
      for (let i = 0; i < reach.length; i++) {
        for (const side of [0, 1]) put(parsePairs(second[`n${i}_${side}`], venue.label, 'reservePLS'))
      }
    }

    return {
      venue: venue.label,
      ok: true,
      block: BigInt(indexed),
      pairs: [...pairs.values()].sort((a, b) => b.rank - a.rank),
      ...done(),
    }
  } catch (e) {
    if (e instanceof Refused) {
      return { venue: venue.label, ok: false, reason: e.reason, detail: e.message, ...done() }
    }
    // Nothing above should throw anything else. If it does, it is still a failed discovery,
    // never a crashed bot.
    return {
      venue: venue.label,
      ok: false,
      reason: 'malformed',
      detail: e instanceof Error ? e.message.slice(0, 160) : 'unknown error',
      ...done(),
    }
  }
}

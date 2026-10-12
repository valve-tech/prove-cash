import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { erc20Abi, type Address, type Hex } from 'viem'
import type { Status } from '@msgboard/sdk'
import {
  batchRead,
  boardStatus,
  decodeIntent,
  fetchArchivePage,
  FLAG_PARTIAL,
  getChainId,
  ingestIntent,
  intentHashOf,
  intentKey,
  marketAddress,
  myIntents,
  pairDepth,
  queryIntents,
  quoteAll,
  readIntents,
  readReservations,
  recordToIntent,
  SETTLEMENT_ABI,
  settlement,
  settlementLive,
  tokenInfo,
  type ChainId,
  type IntentQuery,
  type IntentSource,
  type Quote,
  type ReservationState,
  type SignedIntent,
  type TokenInfo,
} from '@prove.cash/sdk'
import { readExhausted, readSucceeded } from '../lib/chainHealth'
import { boardPasses, serial } from '../lib/passes'
import { countTokens, matchesToken, pairMatches, type TokenFilter } from '../lib/tokenFilter'
import type { Dir } from '../routes.ts'

/**
 * The book, three layers deep. The live board is polled and every verified sighting lands in
 * the intent store; the archive backfills the same store a page at a time; the UI reads the
 * store through one indexed query. The store gives breadth — only the chain gives truth, so
 * balances and market quotes are re-read fresh for every open intent.
 */

export type BoardIntent = {
  /** The board message hash of the newest sighting. */
  msgHash: Hex
  blockNumber: bigint
  key: string
  intent: SignedIntent
  tokenIn: TokenInfo
  tokenOut: TokenInfo
  /** Maker's tokenIn balance. Null while unknown, and for expired history. */
  makerBalance: bigint | null
  /**
   * Market quote. Undefined while unknown: not read yet, or every read of it failed. Null when the
   * router answered and has no path.
   */
  quote: Quote | null | undefined
  /**
   * Escrow committed to this intent, read from the live contract. Undefined while unknown or
   * while no settlement is deployed; null when the read failed.
   */
  reservation: ReservationState | null | undefined
  /**
   * How much of a partial offer the contract has already filled, read from the live contract.
   * Null while unknown, for a whole-or-nothing offer, and while no settlement is deployed.
   */
  filled: bigint | null
  /** True when the live board carries this intent right now. */
  /**
   * Whether this offer is on the live board: true or false once the board has answered, null
   * before it has. Null is not "off". See `boardPresence`.
   */
  onBoard: boolean | null
  source: IntentSource
  firstSeenAt: number
}

export type BookScope = 'open' | 'all'

/** One token the board's rows name, for the token menu. Counts are before any token filter. */
export type BoardToken = { address: string; info: TokenInfo; open: number; rows: number }

export type ArchiveState = {
  state: 'loading' | 'ok' | 'error'
  total: number | null
  loaded: number
  /** Epoch seconds of the oldest archived row loaded so far. */
  oldest: number | null
}

const POLL_MS = 12_000
const ARCHIVE_PAGE = 50
const QUERY_LIMIT = 250

type Sighting = {
  intent: SignedIntent
  data: Hex
  msgHash: Hex
  blockNumber: bigint
  firstSeenAt: number
  source: IntentSource
}

/** Resolve token identities for a batch, then ingest each sighting. Returns accepted keys. */
async function ingestAll(sightings: Sighting[]): Promise<Set<string>> {
  const chainId = getChainId()
  const addresses = new Set<string>()
  for (const s of sightings) {
    addresses.add(s.intent.tokenIn.toLowerCase())
    addresses.add(s.intent.tokenOut.toLowerCase())
  }
  const infos = await resolveTokens(chainId, addresses)
  const accepted = new Set<string>()
  await Promise.all(
    sightings.map(async (s) => {
      // Both decimal places, or neither. They used to fall back to 18, which stored a size a
      // million million times off for a six-decimal token and put it on the board as a fact.
      // An intent we cannot price is left un-accepted, so the next poll tries it again.
      const inInfo = infos.get(s.intent.tokenIn.toLowerCase())
      const outInfo = infos.get(s.intent.tokenOut.toLowerCase())
      if (!inInfo || !outInfo) return
      const ok = await ingestIntent(chainId, {
        intent: s.intent,
        data: s.data,
        msgHash: s.msgHash,
        blockNumber: s.blockNumber,
        firstSeenAt: s.firstSeenAt,
        source: s.source,
        decimalsIn: inInfo.decimals,
        decimalsOut: outInfo.decimals,
      })
      if (ok) accepted.add(intentKey(s.intent))
    }),
  )
  return accepted
}

/**
 * What each of these tokens is, leaving out the ones the chain would not say.
 *
 * A missing entry is the signal, and every caller has to read it. `tokenInfo` used to answer 18
 * decimals for a token it could not read; a six-decimal token then priced a million million times
 * off, and the board showed that number as a fact about somebody's offer. There is no safe
 * default for this — a row we cannot price is a row we do not draw.
 */
async function resolveTokens(
  chainId: ChainId,
  addresses: Iterable<string>,
): Promise<Map<string, TokenInfo>> {
  const infos = new Map<string, TokenInfo>()
  await Promise.all(
    [...addresses].map(async (a) => {
      const info = await tokenInfo(chainId, a as Address)
      if (info) infos.set(a, info)
    }),
  )
  return infos
}

/**
 * The question the public board asks the store.
 *
 * Pulled out of the hook so it can be read and tested as one thing. The rule it carries is not
 * about React and it is the rule that matters: what belongs in a public order book.
 *
 * **`executor: { open: true }` — offers open to everyone, and only those.** An exclusive quote is
 * a price named for one counterparty: its `executor` is the RFQ venue, and `ProveSettlement`
 * refuses anybody else. Listing one beside open intents misrepresents both — a browser reads a
 * private price as a public offer, and the maker's counterparty finds their quote on a public
 * shelf.
 *
 * Category already separates the two marketplaces: quotes travel under `RFQ_CATEGORY` and
 * `readIntents` reads `PROVECASH_CATEGORY`. This is a SECOND line, in a different module, against
 * the same mistake — a quote posted to the wrong category, or a future ingest path that does not
 * know the difference. It costs one field and it relies on nobody upstream having been careful.
 *
 * It is not an RFQ filter. It is the definition of a public order book: an intent pinned to any
 * executor is spoken for, whoever pinned it and whatever category carried it. `#53` is where a
 * quote does appear.
 */
export function boardQuery(
  chainId: ChainId,
  scope: BookScope,
  pair: string | null,
  now: number,
): IntentQuery {
  const q: IntentQuery = { chainId, limit: QUERY_LIMIT, executor: { open: true } }
  if (scope === 'open') q.liveAt = now
  // History reads newest first when the store outgrows the limit.
  else q.newestFirst = true
  if (pair) q.pair = pair
  return q
}

type Page = Awaited<ReturnType<typeof queryIntents>>

/**
 * The rows a token filter keeps.
 *
 * When the whole view fits in one page, a filter over that page is exact. When it does not, a
 * filter over the page misses rows: the history view walks the newest 250 and stops, so an older
 * offer out of X would never reach the filter. So in that case the question goes back to the
 * store one pair at a time, through the pair index, and the pages merge in the view's own order.
 */
async function tokenRows(q: IntentQuery, page: Page, filter: TokenFilter, now: number) {
  if (page.cursor === null) return page.rows.filter((r) => matchesToken(r.tokenIn, r.tokenOut, filter))
  const pairs = (await pairDepth(q.chainId, now)).filter((d) => pairMatches(d.pair, filter))
  const pages = await Promise.all(pairs.map((d) => queryIntents({ ...q, pair: d.pair })))
  const rows = pages.flatMap((p) => p.rows)
  rows.sort((a, b) => (q.newestFirst ? b.endTime - a.endTime : a.endTime - b.endTime))
  return rows.slice(0, q.limit ?? QUERY_LIMIT)
}

/**
 * Whether an offer is on the live board, or null when the board has not answered yet.
 *
 * **The null is the fix.** This used to be `live.has(key)` alone, and `live` starts empty, so
 * until the first board read every offer reported itself off the board. Measured on 2026-09-10
 * on one page load: 22 of 22 rows flagged "off-board" for the first 10 to 15 seconds, then 6 of
 * 22 once the board answered. Sixteen of those flags were false. Absence from a set nobody has
 * filled yet is not evidence of anything.
 */
export function boardPresence(
  answered: boolean,
  live: ReadonlySet<string>,
  key: string,
): boolean | null {
  return answered ? live.has(key) : null
}

/**
 * Where this chain settles, or null when it settles nowhere.
 *
 * **Null is an answer here, and that is why it is null rather than undefined.** The tri-state in
 * `lib/answered.ts` exists for sources that reply over a network, and a page must not claim
 * absence before one of those has replied. This source has already replied: `settlement()` is the
 * one resolver — an in-process override, then a stored one, then the registry — and all three are
 * read synchronously. There is no moment at which this is unknown, so there is nothing to wait
 * for and nothing to draw a loader over.
 *
 * Read through `settlement()` rather than `NETWORKS[id].settlement`, or an override that points a
 * client at a local Anvil would report the registry's zero and close a board that settles fine.
 */
export function settlementPresence(chainId: ChainId): Address | null {
  return settlementLive(chainId) ? settlement(chainId) : null
}

/**
 * Whether the board must refuse to trade on this chain.
 *
 * The registry carries mainnet with a deliberate zero, and the network switcher still offers it.
 * Until now the board listed that chain's archive like any other: rows a reader could select, a
 * tray they could batch, and a fill button behind it. Every one of those offers names a
 * `verifyingContract` of `0x0000…0000`, so no contract can ever spend one — the board was
 * inviting people to take offers that cannot settle.
 *
 * This is the board's half of the same rule the sign form already keeps. `signingDomain` refuses
 * to make such a signature and the custody ladder locks every rung; this refuses to show and to
 * accept the ones that already exist. Reading stays open everywhere else, because an archive of
 * unspendable offers is still a true record of what was posted.
 */
export function boardOff(chainId: ChainId): boolean {
  return settlementPresence(chainId) === null
}

export function useBoard(scope: BookScope, token: Address | null, dir: Dir) {
  const [status, setStatus] = useState<Status | null>(null)
  const [intents, setIntents] = useState<BoardIntent[]>([])
  // The tokens and the open count of the whole view, before the token filter. The menu needs
  // every token, not only the ones the filter left, or picking one would hide all the others.
  const [tokens, setTokens] = useState<BoardToken[]>([])
  const [boardOpen, setBoardOpen] = useState(0)
  /**
   * True once the board's answer is in the rows, not only in `status`.
   *
   * `status` lands before the answer's intents are verified and stored, which can take seconds. In
   * that gap an empty list is the local store, not the board. An empty state drawn from it says
   * "no match" about a board nobody has read yet.
   */
  const [answered, setAnswered] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [archive, setArchive] = useState<ArchiveState>({
    state: 'loading',
    total: null,
    loaded: 0,
    oldest: null,
  })
  /**
   * Keys the live board carried on the last successful poll. The keepalive loop reads this,
   * never the (scope- and token-filtered) query result — a filtered view must not trigger
   * re-posts of intents that are still on the board.
   */
  const [onBoardKeys, setOnBoardKeys] = useState<Set<string>>(new Set())
  // Which pass may write. The board's polls and the store's view reads count separately. See
  // `boardPasses` for the 13 s the shared counter cost.
  const [passes] = useState(boardPasses)
  const liveKeys = useRef(new Set<string>())
  // True once the board has answered for the current scope. Until then `liveKeys` is empty
  // because nobody has asked, and an empty set must not be read as "none of these are live".
  const boardAnswered = useRef(false)
  const archiveOffset = useRef(0)
  const archiveBusy = useRef(false)
  const archiveResetQueued = useRef(false)
  const view = useRef<{ scope: BookScope; filter: TokenFilter | null }>({ scope, filter: null })
  view.current = { scope, filter: token ? { token, dir } : null }

  /** Read the store through the current view, then enrich open rows from the chain. */
  const readView = useCallback(async (t: number) => {
    const chainId = getChainId()
    const now = Math.floor(Date.now() / 1000)
    const { scope: viewScope, filter } = view.current
    const q = boardQuery(chainId, viewScope, null, now)
    const page = await queryIntents(q)
    const rows = filter ? await tokenRows(q, page, filter, now) : page.rows

    const addresses = new Set<string>()
    for (const r of [...page.rows, ...rows]) {
      addresses.add(r.tokenIn)
      addresses.add(r.tokenOut)
    }
    const infos = await resolveTokens(chainId, addresses)
    if (!passes.view.commit(t)) return

    // Only the rows we can price. An offer whose token decimals the chain would not give us has
    // no size we can state, and a row on this board is read as a size — so it waits for a poll
    // that can read them rather than appearing with a guessed one.
    const canPrice = (r: { tokenIn: string; tokenOut: string }) =>
      infos.has(r.tokenIn) && infos.has(r.tokenOut)
    const priced = rows.filter(canPrice)
    // The menu offers the tokens of rows the board would draw, so it never lists a token that
    // leads to no rows.
    const whole = page.rows.filter(canPrice)
    setTokens(
      countTokens(whole, now).flatMap((c) => {
        const info = infos.get(c.address)
        return info ? [{ ...c, info }] : []
      }),
    )
    setBoardOpen(whole.filter((r) => r.endTime > now).length)

    // First paint: terms are ready, balances and quotes carry over from the last pass. The raw
    // payload decodes first — it alone carries a 3009 authorization when one exists.
    setIntents((prev) => {
      const prevByKey = new Map(prev.map((p) => [p.key, p]))
      return priced.map((r) => {
        const old = prevByKey.get(r.key)
        const expired = r.endTime <= now
        return {
          msgHash: r.msgHash as Hex,
          blockNumber: BigInt(r.lastSeenBlock),
          key: r.key,
          intent: decodeIntent(r.data as Hex) ?? recordToIntent(r),
          tokenIn: infos.get(r.tokenIn)!,
          tokenOut: infos.get(r.tokenOut)!,
          makerBalance: old?.makerBalance ?? null,
          quote: expired ? (old?.quote ?? null) : old?.quote,
          reservation: old?.reservation,
          filled: old?.filled ?? null,
          onBoard: boardPresence(boardAnswered.current, liveKeys.current, r.key),
          source: r.source,
          firstSeenAt: r.firstSeenAt,
        }
      })
    })
    setLoading(false)

    // Enrichment, open intents only: maker balances and market quotes, one round trip each.
    const open = priced.filter((r) => r.endTime > now)
    if (open.length === 0) return
    const balanceCalls = open.map((r) => ({
      address: r.tokenIn as Address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [r.maker as Address],
    }))
    const quoteInputs = open.map((r) => ({
      key: r.key,
      tokenIn: marketAddress(infos.get(r.tokenIn)!),
      tokenOut: marketAddress(infos.get(r.tokenOut)!),
      amountIn: BigInt(r.amountIn),
    }))
    // Escrow rows also read their reservation, when a settlement contract is live to ask.
    const live = settlementLive(chainId)
    const escrowRows = live ? open.filter((r) => (r.flags & 2) !== 0) : []
    const escrowHashes = escrowRows.map((r) => intentHashOf(recordToIntent(r), chainId))
    // Partial rows read how much of them is gone, so the row can draw the fraction.
    const partialRows = live ? open.filter((r) => (r.flags & FLAG_PARTIAL) !== 0) : []
    const filledCalls = partialRows.map((r) => ({
      address: settlement(chainId),
      abi: SETTLEMENT_ABI,
      functionName: 'filled',
      args: [intentHashOf(recordToIntent(r), chainId)],
    }))
    let quoteReadFailed = false
    const [balances, quotes, reservations, filledResults] = await Promise.all([
      batchRead(balanceCalls),
      quoteAll(quoteInputs, { onReadFailure: () => (quoteReadFailed = true) }),
      readReservations(escrowHashes),
      batchRead(filledCalls),
    ])
    if (!passes.view.commit(t)) return
    // The board's reads feed the same endpoint health as the sign page's. Without this a dead
    // endpoint showed no amber on the board at all, and every row said "no route". A pass is one
    // attempt, and the next poll is the retry. So one quote read that failed, or a pass in which no
    // balance could be read, marks the endpoint degraded. `onReadFailure` fires on a partial
    // failure too, such as one rate-limited chunk, and that is a throttled endpoint.
    const readFailed =
      quoteReadFailed || balances.every((b) => !b.ok && b.reason === 'unreadable')
    if (readFailed) readExhausted(chainId)
    else readSucceeded(chainId)
    const filledByKey = new Map(
      partialRows.map((r, i) => {
        const f = filledResults[i]
        return [r.key, f?.ok ? (f.value as bigint) : null] as const
      }),
    )
    const balanceByKey = new Map(
      open.map((r, i) => {
        const b = balances[i]
        return [r.key, b.ok ? (b.value as bigint) : null] as const
      }),
    )
    const reservationByKey = new Map(escrowRows.map((r, i) => [r.key, reservations[i]] as const))
    setIntents((prev) =>
      prev.map((p) => {
        if (!balanceByKey.has(p.key)) return p
        return {
          ...p,
          makerBalance: balanceByKey.get(p.key) ?? p.makerBalance,
          // A quote the SDK could not read is left out of the result, so the row keeps what it last
          // knew: undefined draws "…", and null draws "no route". It used to fall back to null,
          // which put "no route", a claim about the market, on every row during a rate limit.
          quote: quotes.has(p.key) ? quotes.get(p.key) : p.quote,
          reservation: reservationByKey.has(p.key)
            ? (reservationByKey.get(p.key) ?? p.reservation ?? null)
            : p.reservation,
          filled: filledByKey.has(p.key) ? (filledByKey.get(p.key) ?? p.filled) : p.filled,
        }
      }),
    )
  }, [passes])

  /**
   * Read the store for the view on screen, one read at a time. The poll, the archive and a filter
   * change all ask for a read, and on a cold load two of them ask within the same second. Each read
   * sends a quote multicall, so two at once drew a 429 and left every row's quote unknown. A call
   * during a read now waits for one more read after it. See `serial`.
   *
   * A view change voids the read in flight, because its rows answer the old view. The read then
   * runs again for the new view. Without that, a poll that lands during a filter change would leave
   * its offers out until the next poll.
   */
  const requery = useMemo(
    () =>
      serial(async () => {
        const t = passes.view.start()
        await readView(t)
        return passes.view.voided(t)
      }),
    [passes, readView],
  )

  /** Pull one archive page into the store. The board never waits for this. */
  const loadArchive = useCallback(
    async (reset = false) => {
      if (archiveBusy.current) {
        if (reset) archiveResetQueued.current = true
        return
      }
      archiveBusy.current = true
      const chainId = getChainId()
      try {
        if (reset) {
          archiveOffset.current = 0
          setArchive({ state: 'loading', total: null, loaded: 0, oldest: null })
        } else {
          setArchive((a) => ({ ...a, state: 'loading' }))
        }
        const page = await fetchArchivePage(chainId, ARCHIVE_PAGE, archiveOffset.current)
        if (getChainId() !== chainId) return
        const mine = new Set(myIntents(chainId).map((k) => k.key))
        // One sighting per intent key: a kept-alive intent appears once per re-post, and the
        // freshest row must win the merge, so dedupe before ingest.
        const sightings = new Map<string, Sighting>()
        let oldest: number | null = null
        for (const row of page.rows) {
          const seenAt = Math.floor(Date.parse(row.first_seen_at) / 1000)
          if (Number.isFinite(seenAt)) oldest = oldest === null ? seenAt : Math.min(oldest, seenAt)
          const intent = decodeIntent(row.data)
          if (!intent) continue
          const key = intentKey(intent)
          const block = BigInt(row.block_number)
          const prev = sightings.get(key)
          if (prev && prev.blockNumber >= block) {
            prev.firstSeenAt = Math.min(prev.firstSeenAt, seenAt)
            continue
          }
          sightings.set(key, {
            intent,
            data: row.data,
            msgHash: row.hash,
            blockNumber: block,
            firstSeenAt: Math.min(seenAt, prev?.firstSeenAt ?? seenAt),
            source: mine.has(key) ? 'mine' : 'archive',
          })
        }
        await ingestAll([...sightings.values()])
        if (getChainId() !== chainId) return
        archiveOffset.current += page.rows.length
        // The rows first, then the count. The archive counts as answered once `state` leaves
        // `loading`, and an answered archive lets the board say it is empty. Set first, it left a
        // gap in which the rows were stored but not yet drawn.
        await requery()
        if (getChainId() !== chainId) return
        setArchive((prev) => ({
          state: 'ok',
          total: page.total,
          loaded: archiveOffset.current,
          oldest:
            oldest === null ? prev.oldest : prev.oldest === null ? oldest : Math.min(prev.oldest, oldest),
        }))
      } catch {
        if (getChainId() === chainId) setArchive((a) => ({ ...a, state: 'error' }))
      } finally {
        archiveBusy.current = false
        if (archiveResetQueued.current) {
          archiveResetQueued.current = false
          void loadArchiveRef.current?.(true)
        }
      }
    },
    [requery],
  )
  const loadArchiveRef = useRef<typeof loadArchive | null>(null)
  loadArchiveRef.current = loadArchive

  const refresh = useCallback(
    async (reset = false) => {
      if (reset) {
        // Another chain or another endpoint. Every pass in flight answers for the old one.
        passes.reset()
        setIntents([])
        setStatus(null)
        setError(null)
        setLoading(true)
        setTokens([])
        setBoardOpen(0)
        setAnswered(false)
        liveKeys.current = new Set()
        boardAnswered.current = false
        setOnBoardKeys(new Set())
        // Unanswered at once, even when a page for the old chain is in flight and the reset has to
        // queue behind it. Until then the old chain's archive would answer for this one.
        setArchive({ state: 'loading', total: null, loaded: 0, oldest: null })
        void loadArchive(true)
      }
      // A pass writes when it lands, unless a newer pass has already written. A newer pass that
      // only started does not void it: on a slow link one pass can outlast the 12 s interval.
      const { poll } = passes
      const t = poll.start()
      try {
        const [s, messages] = await Promise.all([boardStatus(), readIntents()])
        if (!poll.commit(t)) return
        setStatus(s)

        // Freshest post of each intent wins; older posts of the same signature are noise.
        const freshest = new Map<string, { data: Hex; hash: Hex; block: bigint; intent: SignedIntent }>()
        for (const m of messages) {
          const intent = decodeIntent(m.data)
          if (!intent) continue
          const key = intentKey(intent)
          const block = BigInt(m.blockNumber)
          const prev = freshest.get(key)
          if (prev && prev.block >= block) continue
          freshest.set(key, { data: m.data, hash: m.hash, block, intent })
        }
        const mine = new Set(myIntents(getChainId()).map((k) => k.key))
        const now = Math.floor(Date.now() / 1000)
        const accepted = await ingestAll(
          [...freshest.values()].map((f) => ({
            intent: f.intent,
            data: f.data,
            msgHash: f.hash,
            blockNumber: f.block,
            firstSeenAt: now,
            source: mine.has(intentKey(f.intent)) ? 'mine' : 'live',
          })),
        )
        if (!poll.commit(t)) return
        liveKeys.current = accepted
        boardAnswered.current = true
        setOnBoardKeys(accepted)
        setError(null)
        await requery()
        if (poll.current(t)) setAnswered(true)
      } catch (e) {
        // A failure writes its error without a commit. An older pass still in flight may land
        // after it, and that answer beats this error.
        if (poll.current(t)) setError((e as Error)?.message ?? 'board unreachable')
      } finally {
        if (poll.current(t)) setLoading(false)
      }
    },
    [loadArchive, requery, passes],
  )

  /*
    Poll while someone is looking, and not otherwise.

    A refresh costs about five calls to the chain endpoint, so a board left open ran at roughly
    26 requests a minute — over 1,500 an hour — for as long as the tab existed. A backgrounded tab
    did exactly the same, forever, for nobody. On the shared demo endpoint that is most of the
    traffic prove.cash generates, and it is the reason a burst of page loads could rate-limit the
    key while the bots on the bot host, polling every four minutes, never noticed a thing.

    Coming back refreshes at once rather than waiting out the interval, so a returning reader never
    reads a stale book.
  */
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined

    const start = () => {
      if (timer !== undefined) return
      timer = setInterval(() => refresh(), POLL_MS)
    }
    const stop = () => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    const onVisibility = () => {
      if (document.hidden) return stop()
      refresh()
      start()
    }

    refresh()
    void loadArchive(true)
    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh, loadArchive])

  // A scope or token change is a new question to the store, not a new fetch. It voids the store
  // reads in flight, so a read for the old view cannot overwrite the answer. It does not void the
  // board's poll. It used to: one counter served both, so on mount this effect discarded the
  // board's first answer, and the header said "checking the board" until the next poll.
  useEffect(() => {
    passes.changeView()
    void requery()
  }, [scope, token, dir, requery, passes])

  const loadMoreArchive = useCallback(() => void loadArchive(false), [loadArchive])

  return {
    status,
    intents,
    tokens,
    boardOpen,
    answered,
    onBoardKeys,
    error,
    loading,
    refresh,
    archive,
    loadMoreArchive,
  }
}

/** A ticking clock in seconds, so countdowns and dutch prices stay honest without a re-fetch. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)))
  useEffect(() => {
    const t = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

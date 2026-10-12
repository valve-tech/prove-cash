import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Address } from 'viem'
import { BatchTray } from './components/BatchTray'
import { ChainMark } from './components/ChainMark'
import { EndpointsButton, type EndpointHealth } from './components/EndpointsButton'
import { LanguagePicker } from './components/LanguagePicker'
import { Compose } from './components/Compose'
import { MarketPanel } from './components/charts/MarketPanel'
import { IntentRow } from './components/IntentRow'
import { Portfolio } from './components/Portfolio'
import { Rfq } from './rfq/Rfq'
import { RpcSettings } from './components/RpcSettings'
import { TipUnder } from './components/Tip'
import { TokenAvatar, TokenUnit } from './components/TokenAvatar'
import { Tour, tourSeen } from './components/Tour'
import { WalletPicker } from './components/WalletPicker'
import { SiteFooter } from './components/SiteFooter'
import { VIEW_LABEL, VIEW_TIP, ViewIcon } from './components/ViewIcon'
import { boardOff, useBoard, useNow, type BoardIntent } from './hooks/useBoard'
import { accountAnswered, archiveAnswered, awaitingBook, quotesAnswered } from './lib/answered'
import {
  cachedToken,
  CHAIN_IDS,
  displaySymbol,
  edgeOf,
  defaultRpc,
  getChainId,
  getChainRpc,
  getRpc,
  keepAlive,
  myIntents,
  NETWORKS,
  setChainId,
  settlementLive,
  wpls,
  type ChainId,
} from '@prove.cash/sdk'
import type { Key } from './i18n/en.ts'
import { postToBoard } from './lib/board'
import { unitsCompact } from './lib/amount'
import { useChainHealth } from './lib/chainHealth'
import { firstLine } from './lib/errors'
import { getLocale, t, tCount, useLocale } from './lib/i18n.ts'
import { spokenCompact } from './lib/speech'
import { announcedWallets, hasWallet, watchAccount } from './lib/wallet'
import { onSessionEnded, walletConnectOffered } from './lib/walletconnect'
import {
  defaultRoute,
  DIRS,
  go,
  SCOPES,
  SORTS,
  TABS,
  useRoute,
  type Dir,
  type Route,
  type Scope,
  type Sort,
} from './routes.ts'
import { navigate } from './surface.ts'
import { Menu, Toggle, type MenuOption } from './components/Menu'
import { short } from './lib/address'
import { bookOf, keepToken, type TokenFilter } from './lib/tokenFilter'


/**
 * The filter buttons' words, one key per route token.
 *
 * The tokens themselves — `open`, `all`, `spread` — are protocol: they are what the fragment
 * spells and what `routes.ts` parses. The button face is copy, so it comes from the dictionary and
 * the two are allowed to differ.
 */
const SCOPE_FACE: Record<Scope, Key> = { open: 'filter.scope.open', all: 'filter.scope.all' }
const SCOPE_LABEL: Record<Scope, Key> = {
  open: 'filter.scope.open.label',
  all: 'filter.scope.all.label',
}
const SCOPE_TIP: Record<Scope, Key> = { open: 'filter.scope.open.tip', all: 'filter.scope.all.tip' }
const SORT_FACE: Record<Sort, Key> = {
  spread: 'filter.sort.spread',
  expiry: 'filter.sort.expiry',
  size: 'filter.sort.size',
}
// The token filter's words, one set per side of the arrow. Every sentence that names the filter
// is a whole key, because "into X" and "out of X" take different grammar in most languages.
const DIR_FACE: Record<Dir, Key> = {
  into: 'filter.dir.into',
  out: 'filter.dir.out',
  either: 'filter.dir.either',
}
const DIR_TIP: Record<Dir, Key> = {
  into: 'filter.dir.into.tip',
  out: 'filter.dir.out.tip',
  either: 'filter.dir.either.tip',
}
const STAT_FOR: Record<Dir, Key> = {
  into: 'stat.for.into',
  out: 'stat.for.out',
  either: 'stat.for.either',
}
const EMPTY_TOKEN: Record<Dir, Key> = {
  into: 'empty.token.into',
  out: 'empty.token.out',
  either: 'empty.token.either',
}
const EMPTY_TOKEN_PROFITABLE: Record<Dir, Key> = {
  into: 'empty.token.profitable.into',
  out: 'empty.token.profitable.out',
  either: 'empty.token.profitable.either',
}

function rpcHost(): string {
  try {
    const board = new URL(getRpc()).host
    const chain = new URL(getChainRpc()).host
    return board === chain ? board : `${board} · ${chain}`
  } catch {
    return 'custom'
  }
}

/**
 * True when this install is not on the registry's endpoints. The button says so in words rather
 * than growing a second glyph — one marker in the header is enough, and the reader who cares is
 * already reading the tooltip for the host.
 */
function rpcCustom(): boolean {
  const dflt = defaultRpc(getChainId())
  return getRpc() !== dflt || getChainRpc() !== dflt
}

/**
 * One figure and its name. `spoken` carries the untruncated value, because `≈1.2M WPLS` is a
 * glance, not a number — read aloud it tells a maker nothing they can act on.
 */
function Stat({
  label,
  value,
  unit,
  spoken,
  accent,
  sentence,
  pending,
}: {
  label: string
  value: string
  /** The figure's unit, drawn beside it. `TokenUnit` for a token amount. */
  unit?: ReactNode
  spoken?: string
  accent?: boolean
  /** A translated sentence, not an expression. It takes the reader's direction. */
  sentence?: boolean
  /** True while a source the figure depends on has not answered. */
  pending?: boolean
}) {
  return (
    <div className="gutter bg-(--color-panel) py-2.5">
      <dt className="text-[11px] uppercase tracking-wider text-(--color-dim)">{label}</dt>
      {/*
        The figure is an expression, so it holds its own direction; the spoken twin is a sentence,
        so it takes the reader's. Without the isolate the neutral characters at a figure's ends —
        a leading `≈` or `+`, the space before a unit — join the Arabic run around them, and
        `≈1.2M WPLS` comes out with its `≈` at the far end.
      */}
      <dd className={`num text-lg mt-0.5 ${accent ? 'text-(--color-proven)' : 'text-(--color-bright)'}`}>
        {pending ? (
          // A bar one line high, so the band keeps its height when the figure lands. A "0" or a
          // "—" here would claim an absence that no source has reported.
          <>
            <span
              className="block h-[1lh] w-16 max-w-full bg-(--color-line-bright) animate-pulse opacity-40"
              aria-hidden="true"
            />
            <span className="sr-only">{t('board.news.loading')}</span>
          </>
        ) : spoken ? (
          <>
            {/*
              The figure and its unit sit in a flex line, the way a row draws them, so the face
              centres on the symbol. The figure keeps its own `.ltr`; the line takes the reader's
              direction, so in Arabic the unit sits on the figure's left.
            */}
            <span className="flex flex-wrap items-center gap-x-1" aria-hidden="true">
              <span className="ltr">{value}</span>
              {unit}
            </span>
            <span className="sr-only">{spoken}</span>
          </>
        ) : (
          // `.ltr` on a sentence breaks it: `5 من 18` is drawn as `5 18 من`, which reads "of 18 5".
          <span className={sentence ? undefined : 'ltr'}>{value}</span>
        )}
      </dd>
    </div>
  )
}

/** A token's symbol, or its short address when this build has not read the token yet. */
function symbolOf(chainId: ChainId, address: string): string {
  const info = cachedToken(chainId, address as Address)
  return info ? displaySymbol(info) : short(address)
}

// A date is read, so it is written the way the reader's language writes one. The month name comes
// from the browser's own data, which is why this is the active locale and not a dictionary key.
function shortDate(epochS: number): string {
  return new Date(epochS * 1000).toLocaleDateString(getLocale(), {
    month: 'short',
    day: 'numeric',
  })
}

export default function App() {
  // The whole tree's subscription to the language. `t` reads module state, so re-rendering the
  // root re-runs every string below it — no provider, and no per-component subscription.
  useLocale()

  // Undefined until the wallet has answered, null when it answered "no account". Null used to mean
  // both, so a connected wallet was told to connect until `currentAccount` came back. `Portfolio`
  // reads the undefined state. The other children get null, which is what they got before.
  const [account, setAccount] = useState<Address | null | undefined>(undefined)
  const [chainId, setChainIdState] = useState<ChainId>(getChainId())
  // True while Compose has a signature or a post in flight. The network menu holds still.
  const [posting, setPosting] = useState(false)
  const [showRpc, setShowRpc] = useState(false)
  const [showWallets, setShowWallets] = useState(false)
  const [showTour, setShowTour] = useState(() => !tourSeen())
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [reposts, setReposts] = useState(0)

  // The fragment holds the view. Nothing below keeps a second copy of it, so a reload, a shared
  // link and the Back button all rebuild the same screen from the same string.
  const link = useRoute()
  const route = link ?? defaultRoute(getChainId())
  const { view, sort, scope, token: linkToken, dir, profitableOnly } = route
  const subject = view === 'cleanup' ? route.address : null
  const setFilter = (patch: Partial<Route>) => go({ ...route, ...patch }, 'replace')

  const {
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
  } = useBoard(scope, linkToken, dir)
  // The archive's first page is an answer too. It can add offers, so absence claims wait for it.
  const archiveIn = archiveAnswered(archive)

  /**
   * Whether this chain settles at all. When it does not, the board says so and shows nothing.
   *
   * It waits for no source, which is what makes it the first branch in every condition below.
   * The registry answers it synchronously, so unlike `answered` and `archiveIn` there is no
   * moment where it is merely unknown — see `settlementPresence`. An offer here cannot be filled
   * by anybody, so the figures, the table and the tray are all withheld rather than drawn.
   */
  const off = boardOff(chainId)

  // The link's token, until the board and the archive have answered and nobody knows it. A token with rows is
  // known, and so is one this build has read or ships with: a link to an offer that has since
  // expired still gets an honest "no offers into X", not a board with the filter quietly gone.
  const known = useMemo(() => new Set(tokens.map((x) => x.address)), [tokens])
  const token = keepToken(
    linkToken,
    answered && archiveIn,
    (a) => known.has(a) || cachedToken(chainId, a as Address) !== undefined,
  )
  const filter: TokenFilter | null = useMemo(() => (token ? { token, dir } : null), [token, dir])
  const filterSymbol = token ? symbolOf(chainId, token) : ''

  // An unknown token falls back to no filter, and the address bar says so. Replace, not push: the
  // reader did not ask to go anywhere.
  useEffect(() => {
    if (linkToken !== null && token === null) go({ ...route, token: null, dir: 'either' }, 'replace')
  }, [linkToken, token, route])

  // The two tokens of the one pair the filtered rows share, for the market panel. Null when the
  // rows are several pairs, which have no single book to draw, and null for a token this build
  // has never heard of.
  const [pairBase, pairQuote] = useMemo(() => {
    const book = bookOf(
      intents.map((i) => ({ tokenIn: i.intent.tokenIn, tokenOut: i.intent.tokenOut })),
      filter,
    )
    if (!book) return [null, null] as const
    return [cachedToken(chainId, book[0] as Address), cachedToken(chainId, book[1] as Address)] as const
  }, [chainId, intents, filter])
  const now = useNow()

  useEffect(() => watchAccount(setAccount), [])

  // A WalletConnect session can end from the other side: the person hangs up in their wallet, or
  // the pairing expires. Nothing in `onAccountsChanged` hears that, so without this the header
  // keeps showing an address that can no longer sign anything.
  useEffect(() => onSessionEnded(() => setAccount(null)), [])

  // Make the address bar say what the screen shows.
  //
  // An empty fragment and an unreadable one get the same answer: the board, on the chain this
  // browser last chose. A reader who mistypes a hash sees a working app and a URL they can now
  // share, not a blank page. A fragment that parses is re-written in the form the app would have
  // produced, because `?sort=cheapest` reads as an ordering and delivers the default one. Both
  // replace: neither is a place the reader asked to go, so neither belongs in the Back button.
  useEffect(() => {
    go(link ?? defaultRoute(getChainId()), 'replace')
  }, [link])

  // The link names its chain, so the link decides. A reload, a shared URL and a switched network
  // all land on the book the sender was reading, whatever this browser last selected.
  useEffect(() => {
    if (route.chainId === chainId) return
    // An offer in flight holds the chain. The effect runs again when the post ends.
    if (posting) return
    setChainId(route.chainId)
    setChainIdState(route.chainId)
    // The other chain has other intents. A carried-over selection would name rows that are gone.
    setSelected(new Set())
    refresh(true)
  }, [route.chainId, chainId, refresh, posting])

  // Keep our own intents visible as the board rolls them off. Reads the poll's own key set,
  // never the filtered view — a filter must not trigger re-posts.
  useEffect(() => {
    if (loading) return
    keepAlive(
      chainId,
      onBoardKeys,
      (data) => postToBoard(data, undefined, undefined, chainId),
      () => setReposts((n) => n + 1),
    )
  }, [chainId, onBoardKeys, loading])

  /*
   * Connecting is now a choice, so the button opens the choice rather than making it.
   *
   * It used to call `connect()` straight out, and the wallet it reached was decided by a rule in
   * `lib/wallet.ts` — lowest reverse-DNS name wins — because nothing on screen ever asked. Two
   * extensions meant the same person got the same arbitrary one every time and had no say. A
   * phone wallet had no way in at all.
   *
   * Every caller already treats this as "ask, then come back": each one awaits it and returns,
   * and none reads an account off it. So opening the dialog is the same contract it always had.
   */
  const doConnect = async () => {
    setShowWallets(true)
  }

  /** Whether this browser can reach any wallet at all: an extension, or a phone over the relay. */
  const reachable = hasWallet() || walletConnectOffered()

  // The open rows under the token filter. The four figures count these, the way they always
  // counted the rows below them. The view icon and the screen-reader news use `boardOpen`, the
  // whole board: they speak about the board, and a filtered count there would say the board had
  // shrunk.
  const open = useMemo(() => intents.filter((i) => now < i.intent.endTime), [intents, now])

  const stats = useMemo(() => {
    let notional = 0n
    let profit = 0n
    let anyQuote = false
    let profitable = 0
    for (const item of open) {
      const edge = edgeOf(item.intent, item.quote, now)
      if (item.quote?.notionalNative != null) {
        notional += item.quote.notionalNative
        anyQuote = true
      }
      if (edge && edge.profit > 0n) {
        profitable++
        if (edge.profitNative !== null) profit += edge.profitNative
      }
    }
    return { notional, profit, anyQuote, profitable }
  }, [open, now])

  const shown = useMemo(() => {
    const edged = intents.map((item) => ({
      item,
      expired: now >= item.intent.endTime,
      edge: now >= item.intent.endTime ? null : edgeOf(item.intent, item.quote, now),
    }))
    const filtered = profitableOnly
      ? edged.filter((e) => e.edge !== null && e.edge.profit > 0n)
      : edged
    const list = [...filtered]
    list.sort((a, b) => {
      // Open offers first. Expired rows follow as history, newest expiry first.
      if (a.expired !== b.expired) return a.expired ? 1 : -1
      if (a.expired) return Number(b.item.intent.endTime - a.item.intent.endTime)
      if (sort === 'spread') {
        return (b.edge?.spreadPct ?? -Infinity) - (a.edge?.spreadPct ?? -Infinity)
      }
      if (sort === 'expiry') return Number(a.item.intent.endTime - b.item.intent.endTime)
      const an = a.item.quote?.notionalNative ?? -1n
      const bn = b.item.quote?.notionalNative ?? -1n
      return bn > an ? 1 : bn < an ? -1 : 0
    })
    return list.map((e) => e.item)
  }, [intents, now, sort, profitableOnly])

  const selectedItems = useMemo(() => open.filter((i) => selected.has(i.key)), [open, selected])

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const mine = myIntents(chainId).length
  const wplsDecimals = 18
  // The band's unit: the wrapped native token's face and symbol, as every other amount draws its
  // unit. Plain "WPLS" until this build has read the token.
  const wplsAddress = wpls(chainId)
  const wplsInfo = wplsAddress ? cachedToken(chainId, wplsAddress) : undefined
  const wplsUnit = wplsInfo ? (
    <TokenUnit token={wplsInfo} size={16} className="text-(--color-dim)" />
  ) : (
    <span className="text-(--color-dim)">WPLS</span>
  )

  // The board's own announcement. It carries the count and nothing that ticks, so a screen
  // reader hears it when the book changes and stays silent the rest of the time.
  // A state, not a sentence. `EndpointsButton` owns the words, so only one file spells them and
  // the tooltip and the `aria-label` cannot drift apart.
  //
  // Null until the first answer. It used to fall through to `waiting`, which means a board that
  // answered and refuses posts. Measured on 2026-09-10, the header said "checking the board" for
  // 13 s on a cold load. The network was not the cause: the board answered at 1.5 s, and the hook
  // discarded that answer, so the first answer it kept was the next poll's. See `boardPasses`.
  const health: EndpointHealth | null =
    status?.enabled ? 'live' : error ? 'broken' : status ? 'waiting' : null
  // The board's health and the chain endpoint's are different facts and the button shows both.
  const chainThrottled = useChainHealth(chainId)

  // True until every source that can add an offer has answered: the board's first answer is in
  // the rows, and so is the archive's first page. A failed board ends the wait, because its error
  // is then the thing to draw. `loading` is no guide: it clears when the local store has been read,
  // before the board answers. An empty store is not an empty board, and it is not "no match" for a
  // token filter either. `status` is no guide either: it lands before the answer's offers are
  // verified and stored.
  const bookPending = awaitingBook({ board: answered, archive: archiveIn, error: error !== null })
  // Quotes answer per row. Until each open row has one, a sum is partial and "0 of 21 profitable"
  // is an absence claim.
  const quotesIn = quotesAnswered(open)
  // The stats band and the table wait on the same thing: no rows to draw yet, and a source that
  // still owes an answer. Under "profitable only" the list also waits for the quotes that decide it.
  const statsPending = loading || (bookPending && open.length === 0)
  const listPending = bookPending || (!error && profitableOnly && !quotesIn)

  // The token menu. A symbol two tokens share gets the address beside it, because the menu is the
  // one place the reader chooses between them and the URL keeps only the address.
  const symbolCount = new Map<string, number>()
  for (const x of tokens) {
    const sym = displaySymbol(x.info)
    symbolCount.set(sym, (symbolCount.get(sym) ?? 0) + 1)
  }
  const tokenOptions: MenuOption<string>[] = [
    { value: '', label: t('filter.token.all') },
    ...tokens.map((x) => {
      const sym = displaySymbol(x.info)
      return {
        value: x.address,
        label: (symbolCount.get(sym) ?? 0) > 1 ? `${sym} ${short(x.address)}` : sym,
        hint: t('filter.token.open', { count: x.open }),
        icon: <TokenAvatar token={x.info} size={16} />,
      }
    }),
  ]
  // A link can name a known token with no rows in this view. It still needs a face, or the menu
  // would fall back to "every token" while the filter is on.
  if (token && !known.has(token)) {
    const info = cachedToken(chainId, token)
    tokenOptions.push({
      value: token,
      label: symbolOf(chainId, token),
      icon: info ? <TokenAvatar token={info} size={16} /> : undefined,
    })
  }


  // Not `loading`: that clears on the local store, and this line said "0 open offers on the board"
  // before the board had answered.
  const boardNews = error
    ? t('board.news.error', { error: firstLine(error) })
    : !answered || (boardOpen === 0 && !archiveIn)
      ? t('board.news.loading')
      : tCount('board.news.open', boardOpen)

  // The archive's one line, in the shape the figures it has allow. Four whole sentences rather
  // than one glued from clauses: a language that puts the date first has to be able to, and a
  // language that counts differently has to be able to say `of` its own way.
  const archiveLine =
    archive.total !== null
      ? archive.oldest !== null
        ? t('archive.count.total.since', {
            loaded: archive.loaded,
            total: archive.total,
            date: shortDate(archive.oldest),
          })
        : t('archive.count.total', { loaded: archive.loaded, total: archive.total })
      : archive.oldest !== null
        ? t('archive.count.since', { loaded: archive.loaded, date: shortDate(archive.oldest) })
        : t('archive.count', { loaded: archive.loaded })

  return (
    <div className="min-h-full flex flex-col">
      <a className="skip-link" href="#main">
        {t('header.skip')}
      </a>

      {/*
        The header, the stats band, the filter row and the footer span the page with the table.
        Capped at `max-w-6xl`, they sat 110px in from the board's first column at 1440px.
      */}
      <header className="rule-b">
        <div className="gutter py-3.5 flex flex-wrap items-center gap-x-5 gap-y-3">
          {/*
            The wordmark goes home. It keeps a real href so middle-click and "open in new tab"
            work, but a plain click routes on the client — a reload would re-download the dapp.
          */}
          <a
            href="/"
            aria-label={t('header.home')}
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return
              e.preventDefault()
              navigate('/')
            }}
            className="text-lg font-semibold tracking-tight text-(--color-bright) rounded-md hover:opacity-80 transition-opacity">
            prove<span className="text-(--color-proven)">.cash</span>
          </a>

          {/*
            Three views, not three tabs. A tablist would take two of the three out of the tab
            order and make them arrow-key-only; with three destinations that costs more than it
            earns. `aria-current` names the one you are on.

            They are icons in the header rather than words on a row of their own, which gives the
            board back its first 52px. An icon alone names nothing, so each one carries its word
            in a tooltip and in the label a screen reader reads. The counts stay visible: they are
            not the name, they are the news.
          */}
          <nav aria-label={t('header.views')} className="flex items-center gap-0.5">
            {TABS.map((t) => {
              const count = t === 'board' ? boardOpen : t === 'mine' ? mine : 0
              return (
                <TipUnder key={t} tip={VIEW_TIP[t]({ count, reposts })}>
                  <button
                    // A tab is a destination, so it pushes, and it leaves the cleanup link
                    // behind. It also arrives clean: the fragment spells out every filter the
                    // board is under, so a board reached from another tab must be the board that
                    // fragment describes. The filtered one the reader left is one Back away.
                    onClick={() => go({ ...defaultRoute(route.chainId), view: t }, 'push')}
                    aria-current={view === t ? 'true' : undefined}
                    aria-label={VIEW_LABEL[t]({ count, reposts })}
                    className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors ${
                      view === t
                        ? 'text-(--color-bright) bg-(--color-panel-2)'
                        : 'text-(--color-dim) hover:text-(--color-body)'
                    }`}>
                    <ViewIcon view={t} />
                    {count > 0 && (
                      <span className="num text-[11px]" aria-hidden="true">
                        {count}
                      </span>
                    )}
                  </button>
                </TipUnder>
              )
            })}
          </nav>

          {/*
            The trailing cluster wraps inside itself, and it has to: the header grew a language
            globe and an endpoints button, and five controls in a row need more width than a
            narrow phone has. Without `flex-wrap` the row simply ran past the viewport, and
            `overflow-x: clip` on `html` hid the evidence by cutting the wallet button in half
            rather than letting anything scroll. Measured at 250px: the cluster wanted 297.
          */}
          <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 ms-auto">
            {/*
              One control, not one button per chain. A segmented pair spends width on the network
              you are not using, and it only stays cheap while there are two — the registry decides
              how many there are, and it is a list.

              Another chain is another book, so picking one pushes. The view rides along — a
              cleanup link keeps its subject, because one wallet can hold escrow on both chains —
              and the token filter does not: that token address is this chain's. The effect
              above does the rest when the fragment lands.
            */}
            <Menu
              label={t('header.network')}
              value={String(chainId)}
              disabled={posting}
              onChange={(next) =>
                go({ ...route, chainId: Number(next) as ChainId, token: null, dir: 'either' }, 'push')
              }
              options={CHAIN_IDS.map((id) => ({
                value: String(id),
                label: NETWORKS[id].label,
                hint: String(id),
                // viem's own chain record answers whether this is play money. Nothing here
                // needs a list of which chain ids are real.
                icon: <ChainMark chainId={id} live={!NETWORKS[id].chain.testnet} />,
              }))}
            />

            {/*
              Language, endpoints and help are one object, not three.

              They are the same kind of thing — settings you reach for rarely — and as three
              separate pills they cost three outlines and broke apart at arbitrary points when the
              row wrapped. Grouped, the header has three items to place instead of five, and the
              group wraps whole.
            */}
            <div className="hdr-group" role="group" aria-label={t('header.settings')}>
              <LanguagePicker />

              <EndpointsButton
                health={health}
                custom={rpcCustom()}
                host={rpcHost()}
                throttled={chainThrottled === 'degraded'}
                onClick={() => setShowRpc(true)}
              />

              <button
                className="hdr-btn text-xs"
                aria-label={t('header.tour')}
                title={t('header.tour')}
                onClick={() => setShowTour(true)}>
                <span aria-hidden="true">?</span>
              </button>
            </div>

            {/*
              Before the wallet answers, the button keeps the size of "connect" and hides the word.
              "Connect" would claim that no account is connected, and the wallet has not said so.

              `reachable` is no longer the same question as `hasWallet()`. A browser with no
              extension can still reach a phone or a hardware wallet over WalletConnect, so
              "No wallet" there would be false and would hide a working path behind a dead
              button. It stays true only where both are absent: no extension, and no project id
              in this build.
            */}
            <button
              className={`btn btn-ghost text-xs py-1.5 ${accountAnswered(account) ? '' : 'animate-pulse opacity-40'}`}
              aria-busy={!accountAnswered(account)}
              aria-label={
                account
                  ? t('wallet.connected', { address: account })
                  : !accountAnswered(account)
                    ? t('rpc.checking')
                    : reachable
                      ? t('wallet.connect')
                      : t('wallet.none')
              }
              onClick={() => doConnect().catch(() => {})}>
              <span className={`addr ${accountAnswered(account) ? '' : 'invisible'}`} aria-hidden="true">
                {account
                  ? short(account)
                  : reachable
                    ? t('wallet.connect.short')
                    : t('wallet.none.short')}
              </span>
            </button>
          </div>
        </div>
      </header>

      {/*
        `main` sets no width and no gutter. A table has to run the whole viewport, so the content
        column is drawn around the blocks that want a measure and the tables sit outside it.
      */}
      <main id="main" tabIndex={-1} className="w-full py-5 flex-1">
        <h1 className="sr-only">
          {subject
            ? t('page.cleanup', { address: subject })
            : view === 'board'
              ? t('page.board')
              : view === 'sign'
                ? t('page.sign')
                : view === 'rfq'
                  ? t('page.rfq')
                  : t('page.mine')}
        </h1>
        <p role="status" className="sr-only">
          {view === 'board' ? boardNews : ''}
        </p>

        {subject ? (
          <Portfolio
            key={`${chainId}:${subject}`}
            account={account}
            subject={subject}
            onConnect={doConnect}
          />
        ) : view === 'board' ? (
          /*
            A chain that settles nowhere gets the notice and nothing else.

            Not an empty state underneath the usual board: the figures, the filters, the table and
            the selection tray are all withheld, because every one of them is a way of offering
            these rows to somebody. The archive here is usually not empty — those offers were
            really posted — and not one of them can ever be filled, so a band reading "0 open"
            over a table of rows would be two wrong claims stacked on each other.

            The maker's side of this has been shut since #119: `signingDomain` refuses to make a
            signature under a `verifyingContract` of `0x0000…0000`, and the custody ladder locks
            every rung. This is the taker's side of the same fact.
          */
          off ? (
            <div className="panel w-full p-8 text-center">
              <p className="text-(--color-bright) font-medium">
                {t('empty.board.off', { network: NETWORKS[chainId].label })}
              </p>
            </div>
          ) : (
          <>
            {/*
              The figures follow the token filter. They always counted the rows below them, and
              "3 of 12 profitable" over a list of three rows reads as a claim about those three.
              So a filtered band says so in a caption, and an unfiltered band has none: with no
              caption, the figures are the whole board.
            */}
            <div className="rule-y w-full mb-4">
              {filter && (
                <p id="stat-for" className="gutter bg-(--color-panel) pt-2 text-[11px] text-(--color-dim)">
                  {t(STAT_FOR[dir], { symbol: filterSymbol })}
                </p>
              )}
              <dl
                aria-describedby={filter ? 'stat-for' : undefined}
                className="grid grid-cols-2 gap-px bg-(--color-line) sm:grid-cols-4">
                <Stat label={t('stat.open')} value={String(open.length)} pending={statsPending} />
                <Stat
                  label={t('stat.notional')}
                  pending={statsPending || !quotesIn}
                  value={stats.anyQuote ? `≈${unitsCompact(stats.notional, wplsDecimals)}` : '—'}
                  unit={stats.anyQuote ? wplsUnit : undefined}
                  spoken={
                    stats.anyQuote
                      ? spokenCompact(stats.notional, wplsDecimals, 'WPLS')
                      : t('stat.unknown')
                  }
                />
                <Stat
                  label={t('stat.profit')}
                  pending={statsPending || !quotesIn}
                  value={stats.anyQuote ? `+${unitsCompact(stats.profit, wplsDecimals)}` : '—'}
                  unit={stats.anyQuote ? wplsUnit : undefined}
                  spoken={
                    stats.anyQuote
                      ? t('stat.profit.spoken', {
                          amount: spokenCompact(stats.profit, wplsDecimals, 'WPLS'),
                        })
                      : t('stat.unknown')
                  }
                  accent={stats.profit > 0n}
                />
                <Stat
                  label={t('stat.profitable')}
                  pending={statsPending || !quotesIn}
                  value={t('stat.profitable.value', { count: stats.profitable, total: open.length })}
                  sentence
                />
              </dl>
            </div>

            <div className="gutter w-full flex flex-wrap items-center gap-3 mb-3 text-xs">
              <div
                role="group"
                aria-label={t('filter.scope.group')}
                className="flex items-center gap-0.5 p-0.5 rounded-lg bg-(--color-panel-2)">
                {SCOPES.map((s) => (
                  <button
                    key={s}
                    onClick={() => setFilter({ scope: s })}
                    aria-pressed={scope === s}
                    aria-label={t(SCOPE_LABEL[s])}
                    title={t(SCOPE_TIP[s])}
                    className={`px-2 py-1 rounded-md transition-colors ${
                      scope === s
                        ? 'text-(--color-bright) bg-(--color-line)'
                        : 'text-(--color-dim) hover:text-(--color-body)'
                    }`}>
                    {t(SCOPE_FACE[s])}
                  </button>
                ))}
              </div>
              <div
                role="group"
                aria-label={t('filter.sort.group')}
                className="flex items-center gap-0.5 p-0.5 rounded-lg bg-(--color-panel-2)">
                {SORTS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setFilter({ sort: s })}
                    aria-pressed={sort === s}
                    aria-label={t('filter.sort.label', { sort: t(SORT_FACE[s]) })}
                    className={`px-2 py-1 rounded-md transition-colors ${
                      sort === s
                        ? 'text-(--color-bright) bg-(--color-line)'
                        : 'text-(--color-dim) hover:text-(--color-body)'
                    }`}>
                    {t(SORT_FACE[s])}
                  </button>
                ))}
              </div>
              {/*
                The token filter took the place of the pair menu rather than sitting beside it.
                A pair is one direction, `A → B`, which is "out of A" and "into B" at once, so two
                controls would each narrow the same rows and could contradict each other into an
                empty board. One token and one side of the arrow answer the question a reader
                brings — what is on the board for X — and the list grows by token, not by pair.

                The menu shows once there are two tokens to choose between, and stays while a
                filter is on, so the reader can always take it off.
              */}
              {(tokens.length > 1 || filter) && (
                <Menu
                  label={t('filter.token')}
                  value={token ?? ''}
                  onChange={(next) =>
                    setFilter(next ? { token: next as Address } : { token: null, dir: 'either' })
                  }
                  options={tokenOptions}
                />
              )}
              {/*
                The side of the arrow, only once a token is chosen: with no token it filters
                nothing. It sits after the menu, so choosing a token does not move the menu out
                from under the pointer.
              */}
              {filter && (
                <div
                  role="group"
                  aria-label={t('filter.dir.group', { symbol: filterSymbol })}
                  className="flex items-center gap-0.5 p-0.5 rounded-lg bg-(--color-panel-2)">
                  {DIRS.map((d) => (
                    <button
                      key={d}
                      onClick={() => setFilter({ dir: d })}
                      aria-pressed={dir === d}
                      title={t(DIR_TIP[d], { symbol: filterSymbol })}
                      className={`px-2 py-1 rounded-md transition-colors ${
                        dir === d
                          ? 'text-(--color-bright) bg-(--color-line)'
                          : 'text-(--color-dim) hover:text-(--color-body)'
                      }`}>
                      {t(DIR_FACE[d])}
                    </button>
                  ))}
                </div>
              )}
              <Toggle checked={profitableOnly} onChange={(on) => setFilter({ profitableOnly: on })}>
                {t('filter.profitable')}
              </Toggle>
              {/*
                The first line, redacted, in the text and the title. `break-all` because what
                survives the trim is still often a URL.
              */}
              {error && (
                <span role="alert" title={firstLine(error)} className="break-all text-(--color-danger)">
                  {firstLine(error)}
                </span>
              )}
              <span
                className="ms-auto flex items-center gap-2 text-[11px] text-(--color-dim)"
                title={t('archive.tip')}>
                {archive.state === 'error' ? (
                  <span className="text-(--color-unproven)">{t('archive.unreachable')}</span>
                ) : archive.loaded === 0 && archive.state === 'loading' ? (
                  <span>{t('archive.loading')}</span>
                ) : (
                  /*
                    The whole line keeps `num`, the way the endpoint check's line does. The figures
                    in it are the point, and the isolate is what stops the digits and the date from
                    swapping ends of the sentence under `dir=rtl`.
                  */
                  <span className="num">{archiveLine}</span>
                )}
                {archive.total !== null && archive.loaded < archive.total && (
                  <button
                    className="hover:text-(--color-body) transition-colors"
                    onClick={loadMoreArchive}
                    disabled={archive.state === 'loading'}>
                    {archive.state === 'loading' ? (
                      t('archive.more.loading')
                    ) : (
                      <>
                        {/*
                          One word on screen and a sentence in the ear. The arrow is decoration and
                          the two halves are separate strings, because "older" and "older archived
                          offers" are not the same words with something appended in every language.
                        */}
                        <span aria-hidden="true">{t('archive.more')} ↓</span>
                        <span className="sr-only">{t('archive.more.spoken')}</span>
                      </>
                    )}
                  </button>
                )}
              </span>
            </div>

            {/*
              The market for the pair being read. Only when the token filter leaves one pair:
              several pairs are several books, and there is no axis they share. The wrapper
              carries no padding of its own — the panel brings it.

              The panel deliberately shows more offers than the list below it. "into tUSDC" keeps
              one direction, `tPLSX → tUSDC`, while a book is a pair and needs the offers pointing
              both ways — one side alone is not a book. The two notations already say which is
              which: the row draws an arrow, the panel a slash.
            */}
            {pairBase && pairQuote && (
              <div className="mb-4 w-full">
                <MarketPanel context="board" base={pairBase} quote={pairQuote} />
              </div>
            )}

            {/* A centred empty state earns its p-8; nothing else on this page does. */}
            {!loading && !listPending && shown.length === 0 && (
              <div className="panel w-full p-8 text-center">
                {/*
                  Under a token filter the sentence names the filter. "The board is quiet." would
                  say the whole board is empty when only this token is. Rows that exist but that
                  "profitable only" hides get their own sentence, because "no offers" would be
                  false.
                */}
                <p className="text-(--color-bright) font-medium">
                  {error
                    ? t('empty.board.unreachable')
                    : filter
                      ? intents.length > 0
                        ? t(EMPTY_TOKEN_PROFITABLE[dir], { symbol: filterSymbol })
                        : t(EMPTY_TOKEN[dir], { symbol: filterSymbol })
                      : profitableOnly && open.length > 0
                        ? t('empty.profitable')
                        : t('empty.board')}
                </p>
                {!error && filter && (
                  <button
                    className="btn btn-ghost mt-4"
                    onClick={() => setFilter({ token: null, dir: 'either' })}>
                    {t('filter.token.clear')}
                  </button>
                )}
                {!error && !filter && !(profitableOnly && open.length > 0) && (
                  <button
                    className="btn btn-primary mt-4"
                    onClick={() => go({ ...defaultRoute(route.chainId), view: 'sign' }, 'push')}>
                    {t('empty.sign')}
                  </button>
                )}
              </div>
            )}

            {/* The skeleton stands in for the table, so it takes the table's width and shape. */}
            {(loading || (listPending && shown.length === 0)) && (
              <div className="grid gap-px bg-(--color-line)" aria-hidden="true">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="row h-16 animate-pulse opacity-40" />
                ))}
              </div>
            )}

            {/*
              This is a table of offers drawn with CSS grid, and a grid of divs is not a table to
              anything but an eye. Rather than rebuild it in <table> — which would cost the row as
              a single hit target — the same markup carries table roles, so every cell announces
              under its column heading. The one shared `board-grid` template keeps the heading row
              and the offer rows aligned.

              It runs the whole width of the viewport, outside the content column: every pixel
              taken off a table collapses a column or truncates a figure.
            */}
            {shown.length > 0 && (
              <div className="scroll-x pb-1">
                <div
                  role="table"
                  aria-label={t('board.table')}
                  aria-rowcount={shown.length + 1}>
                  <div role="rowgroup">
                    <div
                      role="row"
                      className="board-grid gutter pb-1.5 min-w-[800px] text-[11px] uppercase tracking-wider text-(--color-dim)">
                      <span role="columnheader">
                        <span className="sr-only">{t('board.col.select')}</span>
                      </span>
                      <span role="columnheader">{t('board.col.pair')}</span>
                      <span role="columnheader" className="text-end">
                        {t('board.col.size')}
                      </span>
                      <span role="columnheader" className="text-end">
                        {t('board.col.rate')}
                      </span>
                      <span role="columnheader" className="text-end">
                        {t('board.col.edge')}
                      </span>
                      <span role="columnheader" className="text-end">
                        {t('board.col.expires')}
                      </span>
                    </div>
                  </div>
                  {/*
                    The min-width lives on the row group, not on the rows. The group paints the
                    rules, so its box has to reach the far end of the scroll rather than stop at
                    the scrollport.
                  */}
                  <div role="rowgroup" className="grid gap-px bg-(--color-line) min-w-[800px]">
                    {shown.map((item: BoardIntent) => (
                      <IntentRow
                        key={item.key}
                        item={item}
                        now={now}
                        selected={selected.has(item.key)}
                        onToggle={() => toggle(item.key)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}

            <BatchTray
              items={selectedItems}
              now={now}
              account={account ?? null}
              onClear={() => setSelected(new Set())}
              onConnect={doConnect}
            />
          </>
          )
        ) : view === 'rfq' ? (
          <Rfq
            key={chainId}
            account={account ?? null}
            chainId={chainId}
            onConnect={doConnect}
            onBusy={setPosting}
          />
        ) : view === 'sign' ? (
          <Compose
            key={`${chainId}:${route.give ?? ''}`}
            account={account ?? null}
            give={route.give}
            status={status}
            onPosted={() => refresh()}
            onConnect={doConnect}
            onBusy={setPosting}
          />
        ) : (
          <Portfolio key={chainId} account={account} onConnect={doConnect} />
        )}
      </main>

      {/*
        The strap used to end "· work, not gas". How a post is priced is not a claim a maker
        asked for, so the door replaces the slogan and the mechanics live behind it. Same footer
        as the landing page — short labels, glyphs, fuller aria names.
      */}
      <SiteFooter
        how={{ kind: 'button', onClick: () => setShowTour(true) }}
        extra={
          !settlementLive(chainId) ? (
            <span className="text-(--color-unproven)">
              {t('footer.settlement.missing', { network: NETWORKS[chainId].label })}
            </span>
          ) : undefined
        }
      />

      {showRpc && (
        <RpcSettings chainId={chainId} onSaved={() => refresh(true)} onClose={() => setShowRpc(false)} />
      )}
      {showWallets && (
        <WalletPicker
          wallets={announcedWallets()}
          chainId={chainId}
          onConnected={setAccount}
          onClose={() => setShowWallets(false)}
        />
      )}
      {showTour && <Tour onClose={() => setShowTour(false)} />}
    </div>
  )
}

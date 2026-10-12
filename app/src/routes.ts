import { useMemo, useSyncExternalStore } from 'react'
import { isSupportedChain, type ChainId } from '@prove.cash/sdk'
import type { Address } from 'viem'
import { announce, subscribe } from './surface.ts'

/**
 * The dapp's view, in the fragment.
 *
 *   #/<chainId>/<view>[/<subject>][?filters]
 *
 * The views are `board`, `sign`, `mine`, `rfq` and `cleanup/<address>`. The board takes filters,
 * and every filter is omitted at its default, so the plain board is `#/943/board` and nothing
 * longer:
 *
 *   scope=all                 include expired history      (default: open)
 *   sort=expiry|size          order the rows               (default: spread)
 *   token=<address>           rows that name this token    (default: every token)
 *   dir=into|out              which side of the arrow      (default: either side)
 *   profitable=1              hide rows with no edge       (default: off)
 *
 * Sign takes one, and only one:
 *
 *   give=<token>              open with this token to give (default: the first preset)
 *
 * It is how the landing page hands a visitor a starting point. Somebody who has already moved a
 * token on this chain gets that token in the form rather than a list to choose from.
 *
 * The chain leads the path because it decides what every later segment means. An address holds
 * different escrow on each chain and a signature settles on one chain only, so a link that left
 * the chain to the reader's stored selection would point at the wrong book.
 *
 * The token is an address, never a symbol. Two tokens can share a symbol, so a link that said
 * `token=USDC` could put the reader on somebody else's USDC. `into` means the token is after the
 * row's arrow, the one the maker wants; `out` means it is before the arrow, the one the maker
 * gives. `dir` without a `token` says nothing, so it is dropped.
 *
 * An old link may still carry `pair=`. The board no longer has a pair filter, so the parser drops
 * it like any other unknown filter, and the reader gets the whole board rather than a broken one.
 *
 * The fragment, not the path: a fragment never reaches the server, so a shared view costs no
 * routing rule at the edge and cannot 404 on a cold host.
 *
 * What the fragment leaves out is the batch selection. It is a set of intent hashes, 66
 * characters each, and a dozen of them would bury the readable part of the URL. It would also
 * age badly: a selection names live offers, and the reader who opens the link a minute later
 * gets rows that have expired or rolled off the board. The selection stays in memory, where a
 * reload is the right moment to lose it.
 *
 * No router library. This and `surface.ts` are the whole of it.
 */

/** The four views a reader moves between. Cleanup is a link, not a tab. */
export type Tab = 'board' | 'sign' | 'mine' | 'rfq'
export type Sort = 'spread' | 'expiry' | 'size'
/** The board's two depths. Structurally the hook's `BookScope`, declared here to stay import-free. */
export type Scope = 'open' | 'all'
/** Which side of a row's arrow the filter token is on. See `lib/tokenFilter.ts`. */
export type Dir = 'into' | 'out' | 'either'

/** One list per control, so the buttons and the parser can never disagree. */
export const TABS: readonly Tab[] = ['board', 'sign', 'mine', 'rfq']
export const SORTS: readonly Sort[] = ['spread', 'expiry', 'size']
export const SCOPES: readonly Scope[] = ['open', 'all']
export const DIRS: readonly Dir[] = ['into', 'out', 'either']

/** Everything a link reproduces. */
export type Route = {
  chainId: ChainId
  view: Tab | 'cleanup'
  /** Cleanup only: the maker whose escrow the link names. Null on every other view. */
  address: Address | null
  sort: Sort
  scope: Scope
  /** The filter token, lower case, or null for every token. */
  token: Address | null
  /** Which side of the arrow `token` is on. Always `either` when there is no token. */
  dir: Dir
  profitableOnly: boolean
  /** Sign only: the token the form opens with. Null takes the preset. */
  give: Address | null
}

/**
 * `rfq` takes nothing at all, and it is the one view whose state is deliberately not in the URL.
 *
 * The three surfaces under it — make, inbox, settle — are steps in one job rather than
 * destinations, and the only thing worth linking to is the job. A signed pair on its way to a
 * submitter is a few hundred bytes and would bury the readable part of a URL, the way a batch
 * selection would; it travels on the clipboard instead. See `rfq/ticket.ts`.
 */

/** The board, unfiltered, on one chain. Every default lives here and nowhere else. */
export function defaultRoute(chainId: ChainId): Route {
  return {
    chainId,
    view: 'board',
    address: null,
    sort: 'spread',
    scope: 'open',
    token: null,
    dir: 'either',
    profitableOnly: false,
    give: null,
  }
}

const HEX40 = /^0x[0-9a-fA-F]{40}$/

/** A token address in the store's lower case, or null for anything that is not an address. */
function tokenFromParam(param: string | null): Address | null {
  return param !== null && HEX40.test(param) ? (param.toLowerCase() as Address) : null
}

function oneOf<T extends string>(value: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

/** The fragment for a route, defaults left out. */
export function formatRoute(route: Route): string {
  if (route.view === 'cleanup' && route.address) {
    return `#/${route.chainId}/cleanup/${route.address.toLowerCase()}`
  }
  // A cleanup route with no subject names nobody, so it reads as the board rather than as a
  // half-written link somebody could copy.
  const view = route.view === 'cleanup' ? 'board' : route.view
  const head = `#/${route.chainId}/${view}`
  if (view === 'sign') {
    return route.give ? `${head}?give=${route.give.toLowerCase()}` : head
  }
  if (view !== 'board') return head
  const q = new URLSearchParams()
  if (route.scope !== 'open') q.set('scope', route.scope)
  if (route.sort !== 'spread') q.set('sort', route.sort)
  const token = tokenFromParam(route.token)
  if (token) {
    q.set('token', token)
    if (route.dir !== 'either') q.set('dir', route.dir)
  }
  if (route.profitableOnly) q.set('profitable', '1')
  const query = q.toString()
  return query ? `${head}?${query}` : head
}

/**
 * What a fragment names, or null when it names no view at all.
 *
 * Strict about the view, forgiving about the filters. A wrong chain or an unknown view leaves
 * the reader nowhere, so the app has to choose a fallback and say so in the address bar. A wrong
 * sort still leaves them on a board, so it takes the default and the rest of the link survives.
 */
export function parseRoute(hash: string): Route | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  if (!raw.startsWith('/')) return null
  const [path, query] = raw.split('?')
  // Empty segments drop out, so a trailing slash survives a copy and paste.
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const [chain, view, subject] = parts
  if (!/^\d+$/.test(chain)) return null
  const chainId = Number(chain)
  if (!isSupportedChain(chainId)) return null

  if (view === 'cleanup') {
    if (parts.length !== 3 || !HEX40.test(subject)) return null
    return { ...defaultRoute(chainId), view, address: subject.toLowerCase() as Address }
  }
  if (parts.length !== 2 || !TABS.includes(view as Tab)) return null
  const route = { ...defaultRoute(chainId), view: view as Tab }
  // The board's filters belong to the board. `#/943/sign?sort=size` would promise an ordering
  // that view has no rows to apply it to, so every other tab drops them. Sign reads `give` and
  // nothing else; a token that is not an address is dropped rather than carried as a string the
  // form would fail to match.
  if (view === 'sign') {
    const give = new URLSearchParams(query ?? '').get('give') ?? ''
    return HEX40.test(give) ? { ...route, give: give.toLowerCase() as Address } : route
  }
  if (view !== 'board') return route
  const q = new URLSearchParams(query ?? '')
  const token = tokenFromParam(q.get('token'))
  return {
    ...route,
    sort: oneOf(q.get('sort'), SORTS, 'spread'),
    scope: oneOf(q.get('scope'), SCOPES, 'open'),
    token,
    dir: token ? oneOf(q.get('dir'), DIRS, 'either') : 'either',
    profitableOnly: q.get('profitable') === '1',
  }
}

/** The whole URL for a route, for the clipboard. */
export function routeLink(origin: string, route: Route): string {
  return `${origin}/app${formatRoute(route)}`
}

/**
 * The route the app is showing, or null when the fragment names none.
 *
 * Null is the honest answer for an empty fragment and for a hand-typed one that parses to
 * nothing. The caller decides what to fall back to, because only the caller knows which chain
 * this browser last chose.
 */
export function useRoute(): Route | null {
  const hash = useSyncExternalStore(
    subscribe,
    () => window.location.hash,
    () => '',
  )
  return useMemo(() => parseRoute(hash), [hash])
}

/**
 * Move to a route.
 *
 * `push` when the reader has gone somewhere — another tab, another chain. `replace` when they
 * have changed how the same place looks — a sort, a scope, a token, the profitable toggle. The
 * split is what makes Back useful: three sort clicks leave one entry to go back through, not
 * three, and Back from the Sign tab returns to the board the reader had filtered, filters and
 * all. It also means `#/943/board` never lies. The board carries the filters the fragment
 * spells out and no others, so leaving the board and returning gives a clean board, and the
 * filtered one is one Back away.
 */
export function go(route: Route, mode: 'push' | 'replace'): void {
  const hash = formatRoute(route)
  if (hash === window.location.hash) return
  const url = `${window.location.pathname}${hash}`
  if (mode === 'push') {
    window.history.pushState(null, '', url)
    window.scrollTo(0, 0)
  } else {
    window.history.replaceState(null, '', url)
  }
  announce()
}

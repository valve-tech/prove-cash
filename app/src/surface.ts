import { useSyncExternalStore } from 'react'
import { pathForLocale, type LocaleCode } from './lib/i18n.ts'

/**
 * Two surfaces, one bundle. `/` is the landing page and everything under `/app` is the dapp.
 *
 * The split earns its keep at load time, not in the URL bar: the landing page imports nothing
 * from viem, the board or the chain registry, so a first-time visitor downloads a page, not a
 * trading client. The dapp arrives lazily the moment the path says it should.
 *
 * That is also why this file is not `routes.ts`. The fragment grammar next door has to ask the
 * SDK which chains exist, and the landing page imports whatever these three helpers import — so
 * the plumbing every surface shares lives here, and the dapp's own routing lives there.
 *
 * No router library. The whole contract is one path string, one fragment, and one way to change
 * each.
 */

const NAVIGATE = 'provecash:navigate'

/** Wake a subscriber whenever the path or the fragment moves, whoever moved it. */
export function subscribe(onChange: () => void): () => void {
  // Three events, one snapshot. `popstate` catches back and forward, `hashchange` catches a
  // fragment typed into the address bar, and NAVIGATE catches our own pushState — which fires
  // neither of the other two. A duplicate wake-up costs nothing: the snapshot is a string, so
  // React drops the render when it has not changed.
  window.addEventListener('popstate', onChange)
  window.addEventListener('hashchange', onChange)
  window.addEventListener(NAVIGATE, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener('hashchange', onChange)
    window.removeEventListener(NAVIGATE, onChange)
  }
}

/** Tell every subscriber that this tab moved itself. */
export function announce(): void {
  window.dispatchEvent(new Event(NAVIGATE))
}

/** The current path, re-rendering the tree whenever it changes. */
export function usePath(): string {
  return useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    // Server snapshot: there is no prerender today, and '/' keeps the hook total if one lands.
    () => '/',
  )
}

/** True when the dapp should be mounted rather than the landing page. */
export function isApp(path: string): boolean {
  return path === '/app' || path.startsWith('/app/')
}

/**
 * Client-side navigation between the two surfaces. Anything that is not an in-app path falls
 * through to the browser, so external links and downloads keep working if this is ever wired to
 * a generic link handler.
 *
 * Two options, and changing language wants both.
 *
 * `keepScroll` is for a move that changes the URL without changing where the reader is. Throwing
 * somebody who was reading about costs back up to the hero would be a punishment for using the
 * picker.
 *
 * `replace` leaves no history entry. A push looks right and is not: Back would return the URL to
 * `/` and leave the page in German, because at `/` the reader's stored choice wins and they have
 * just made German that choice. The URL and the words on the page would disagree, which is the
 * one thing a language URL exists to prevent. A language is a rendering of this page rather than
 * a destination of its own, so it overwrites the entry it came from.
 */
export function navigate(to: string, opts?: { keepScroll?: boolean; replace?: boolean }): void {
  if (window.location.pathname + window.location.hash === to) return
  if (opts?.replace) window.history.replaceState(null, '', to)
  else window.history.pushState(null, '', to)
  announce()
  if (!opts?.keepScroll) window.scrollTo(0, 0)
}

/**
 * Where the language picker should send a reader who chooses `next`. Null to stay put.
 *
 * The landing page has a URL per language and the dapp does not — see `pathForLocale`. So on the
 * landing page the picker is navigation as well as a setting, and the reader ends up somewhere
 * they can copy, link and share in the language they are reading. Inside the app there is one
 * URL and nothing to move to, so the picker only sets the language.
 *
 * The fragment rides along. It names the section the reader is on, and dropping it would leave
 * the address bar pointing at the top of a page they are halfway down.
 */
export function localeHref(path: string, hash: string, next: LocaleCode): string | null {
  if (isApp(path)) return null
  const to = pathForLocale(next) + hash
  return to === path + hash ? null : to
}

// ── The one old link ──────────────────────────────────────────────────────────

const OLD_CLEANUP = '/app/cleanup/'

/**
 * Where an old cleanup URL should land today, or null when the path is not one.
 *
 * Cleanup links lived in the path, as `/app/cleanup/<chainId>/<address>`, before the view moved
 * into the fragment. Those links are in chat windows and support threads and nobody can recall
 * them, so the app still reads that shape. `lib/cleanup.ts` says what the link is for.
 *
 * A rewrite, not a parse: it checks the shape and leaves the meaning to `parseRoute`. That keeps
 * the chain registry — and the SDK behind it — out of the landing page's bundle. An old link
 * naming a chain this build dropped therefore rewrites to a fragment the app then falls back
 * from, which is the same board it would have shown anyway.
 */
export function legacyCleanupRedirect(path: string): string | null {
  if (!path.startsWith(OLD_CLEANUP)) return null
  // Empty segments drop out, so a trailing slash survives a copy and paste.
  const parts = path.slice(OLD_CLEANUP.length).split('/').filter(Boolean)
  if (parts.length !== 2) return null
  const [chain, address] = parts
  if (!/^\d+$/.test(chain)) return null
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null
  return `/app#/${chain}/cleanup/${address.toLowerCase()}`
}

/**
 * Rewrite an old cleanup URL before the app mounts.
 *
 * `replaceState`, not `pushState`: the reader asked for one page, so Back has to return to
 * wherever they came from rather than to a URL that redirects them straight here again.
 */
export function redirectLegacyPath(): void {
  const to = legacyCleanupRedirect(window.location.pathname)
  if (to) window.history.replaceState(null, '', to)
}

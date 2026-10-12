import { useCallback, useSyncExternalStore } from 'react'
import type { ChainId } from '@prove.cash/sdk'

/**
 * Whether a chain's endpoint is answering reads, as a fact the whole app can see.
 *
 * The board has its own health and the header already shows it. This is the other half: the
 * endpoint that serves `eth_` reads can be rate limiting while the board is perfectly fine, and
 * until now the only sign of that was a chart quietly saying it could not draw. A reader with a
 * blank panel could not tell a young chain from a throttled endpoint, and the one thing that
 * would fix it — pointing at their own node — lives behind a button they had no reason to press.
 *
 * `degraded` means a read failed and kept failing through its whole retry schedule. One dropped
 * request does not count; that is what the retry is for.
 *
 * **One verdict per chain, because a verdict is about an endpoint and each chain has its own.**
 * This was a single module-level flag. A throttled endpoint on one network therefore reported a
 * degraded endpoint on the other, which is a claim about a node nobody had asked anything. The
 * mainnet flip does not make it worse today — the app reads one chain at a time — but a screen
 * that shows two chains at once would inherit it with nothing said, and `App.tsx` would keep
 * drawing amber for a chain whose endpoint is fine.
 *
 * `chainId` is required on every function here, never defaulted to `getChainId()`: a default
 * lets a caller keep compiling while reporting one chain's outage under whatever network the tab
 * points at now. Callers that genuinely mean "the chain on screen" say so at their own boundary,
 * which is where the answer belongs.
 */

export type ChainHealth = 'ok' | 'degraded'

/** Only the chains something has reported on. An absent chain has had no failure, so it is fine. */
const state = new Map<ChainId, ChainHealth>()
const listeners = new Set<() => void>()

function announce() {
  for (const l of listeners) l()
}

function set(chainId: ChainId, next: ChainHealth) {
  if (chainHealth(chainId) === next) return
  state.set(chainId, next)
  announce()
}

/** A read came back on this chain. Whatever we thought, its endpoint is answering. */
export const readSucceeded = (chainId: ChainId) => set(chainId, 'ok')

/** A read on this chain failed every attempt it was given. */
export const readExhausted = (chainId: ChainId) => set(chainId, 'degraded')

/**
 * Forget every chain's verdict. For the tests.
 *
 * A chain switch no longer needs this. The old flag had to be cleared on one, because the verdict
 * it held was about the chain being left; a per-chain verdict stays true about its own chain and
 * is simply not read while another is on screen.
 */
export function resetChainHealth() {
  if (state.size === 0) return
  state.clear()
  announce()
}

export const chainHealth = (chainId: ChainId): ChainHealth => state.get(chainId) ?? 'ok'

/** Exported for `useSyncExternalStore` and for the tests; callers should prefer the hook. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** One chain's health, re-rendering the caller when it changes. */
export function useChainHealth(chainId: ChainId): ChainHealth {
  // The server snapshot is the same getter: this never renders on a server, and passing one keeps
  // `useSyncExternalStore` from warning if that ever changes. It is bound to the chain asked
  // about, so a caller that switches chain reads the new one's verdict on the next render.
  const read = useCallback(() => chainHealth(chainId), [chainId])
  return useSyncExternalStore(subscribe, read, read)
}

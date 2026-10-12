import { afterEach, describe, expect, test, vi } from 'vitest'
import type { Address } from 'viem'
import { adoptSession, preferWallet, watchAccount, type WalletProvider } from './wallet'

/**
 * Review 2026-09-30, M1: the account listener must follow the wallet the app talks to.
 *
 * `App.tsx` calls `watchAccount` once, from a mount effect. A later `adoptSession` or
 * `preferWallet` changes which provider every signer uses, so the listener has to move with it:
 * events from the new wallet reach the header, and events from the old one do not.
 */

const OLD = '0x1111111111111111111111111111111111111111' as Address
const NEW = '0x2222222222222222222222222222222222222222' as Address
const STRAY = '0x3333333333333333333333333333333333333333' as Address

/** A provider whose listeners the test can fire by hand. */
function emitter(account: Address) {
  const handlers = new Set<(v: unknown) => void>()
  return {
    request: async ({ method }: { method: string }) =>
      method === 'eth_accounts' ? [account] : null,
    on: (_e: string, h: (v: unknown) => void) => handlers.add(h),
    removeListener: (_e: string, h: (v: unknown) => void) => handlers.delete(h),
    emit: (a: Address) => handlers.forEach((h) => h([a])),
    get count() {
      return handlers.size
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  adoptSession(undefined)
  preferWallet(null)
  vi.unstubAllGlobals()
})

describe('M1: watchAccount follows the active wallet', () => {
  test('after adoptSession, the session wallet is heard and the old extension is not', async () => {
    const extension = emitter(OLD)
    vi.stubGlobal('window', { ethereum: extension })
    const seen: (Address | null)[] = []
    const stop = watchAccount((a) => seen.push(a))
    await settle()

    const session = emitter(NEW)
    adoptSession(session as unknown as WalletProvider)
    await settle()
    session.emit(NEW)
    extension.emit(STRAY)

    expect(seen).toContain(NEW)
    expect(seen).not.toContain(STRAY)
    expect(extension.count).toBe(0)
    stop()
  })

  test('after preferWallet, the chosen extension is heard and the session is not', async () => {
    const session = emitter(OLD)
    vi.stubGlobal('window', { ethereum: emitter(NEW) })
    adoptSession(session as unknown as WalletProvider)
    const seen: (Address | null)[] = []
    const stop = watchAccount((a) => seen.push(a))
    await settle()

    preferWallet(null)
    await settle()
    session.emit(STRAY)
    ;(window as unknown as { ethereum: ReturnType<typeof emitter> }).ethereum.emit(NEW)

    expect(seen).toContain(NEW)
    expect(seen).not.toContain(STRAY)
    stop()
  })
})

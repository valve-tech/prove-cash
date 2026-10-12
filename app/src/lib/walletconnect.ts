import type { Address } from 'viem'
import { CHAIN_IDS, getChainRpc, type ChainId } from '@prove.cash/sdk'
import { t } from './i18n.ts'
import { adoptSession, ensureChain, type WalletProvider } from './wallet.ts'

/**
 * WalletConnect, as a second way in. A phone or a hardware wallet instead of an extension.
 *
 * **Reown's own SDK, and none of Reown's UI.** The owner asked for WalletConnect without the
 * prebuilt components, so this module talks to `@walletconnect/universal-provider` — the
 * protocol client that Reown maintains and that `@reown/appkit` is itself built on. Nothing here
 * registers a custom element, injects a stylesheet or opens a modal. The app draws the wallet
 * list and draws the QR code, in the app's own style, out of the one string this module hands
 * back.
 *
 * Why not `@reown/appkit` or `@walletconnect/ethereum-provider`: both drag the whole AppKit UI
 * in. `@walletconnect/ethereum-provider@2.25.0` declares `@reown/appkit` as a hard dependency —
 * 41 MB unpacked, and a bundle of it splits into a `w3m-modal` chunk plus about sixty Phosphor
 * icon chunks. It loads that tree behind `await import()` and only when `showQrModal` is true, so
 * a careful build never DOWNLOADS it, but it is still in the dependency tree and still emitted.
 * `universal-provider` declares no AppKit at all. Measured, minified and gzipped, as one bundle:
 * ethereum-provider 583 KB, universal-provider 146 KB. See `docs/WALLETCONNECT.md`.
 *
 * What a session provider is, from this app's side: an object with `request`, `on` and
 * `removeListener`. That is the whole of what `lib/wallet.ts` reads off an extension, so handing
 * it one through `adoptSession` makes every signer, the chain switch and the account subscription
 * work with no second code path.
 */

/**
 * Every method this app ever sends a wallet. Asked for by name, because a session grants methods
 * the way it grants chains: what the wallet approved, and nothing else.
 */
const WALLET_METHODS = [
  'eth_sendTransaction',
  'personal_sign',
  'eth_signTypedData',
  'eth_signTypedData_v4',
  'eth_accounts',
  'eth_requestAccounts',
  'eth_chainId',
  'wallet_switchEthereumChain',
  'wallet_addEthereumChain',
]

/**
 * How long a relay may stay silent before we call it unreachable.
 *
 * Long enough for a cold socket over a slow connection, short enough that nobody stares at a
 * pulsing line wondering whether it is their phone or our server.
 */
const RELAY_SILENCE_MS = 12_000

/** The two a wallet must be able to push at us: a different account, and a different chain. */
const WALLET_EVENTS = ['accountsChanged', 'chainChanged']

/**
 * What this module needs a provider to be. A subset of `UniversalProvider`, written out rather
 * than imported, so a test can hand in a fake and so no type from the package reaches the app's
 * eager graph.
 */
export type SessionProvider = WalletProvider & {
  connect: (opts: {
    optionalNamespaces: Record<
      string,
      { chains: string[]; methods: string[]; events: string[]; rpcMap: Record<string, string> }
    >
  }) => Promise<unknown>
  disconnect: () => Promise<void>
  setDefaultChain: (chain: string, rpcUrl?: string) => void
  abortPairingAttempt?: () => void
}

/** How a provider gets built. Replaced in tests; see `setSessionLoader`. */
export type SessionLoader = (opts: {
  projectId: string
  metadata: { name: string; description: string; url: string; icons: string[] }
}) => Promise<SessionProvider>

/**
 * The real loader: one dynamic import, so the relay client is a chunk of its own.
 *
 * **The import must stay dynamic.** `universal-provider` and everything under it measure about
 * 146 KB gzipped, and the app's main chunk is already 277 KB. A static import would put that on
 * every first paint, including every reader who never connects anything and every reader on a
 * phone extension that needs none of it. Behind `await import()` it is fetched when somebody
 * presses "scan with a phone" and at no other moment.
 */
const realLoader: SessionLoader = async (opts) => {
  const { UniversalProvider } = await import('@walletconnect/universal-provider')
  return (await UniversalProvider.init(opts)) as unknown as SessionProvider
}

let loader: SessionLoader = realLoader

/** Build providers with this instead. Tests only; `null` puts the real loader back. */
export function setSessionLoader(f: SessionLoader | null) {
  loader = f ?? realLoader
}

/**
 * The Reown project id, or null when this build has none.
 *
 * **Public, and still from the environment.** The id identifies the dapp to the relay, it travels
 * inside every `wc:` URI a phone scans, and Reown's own docs call it safe to ship in a browser
 * bundle. It is not a secret and it must never be treated as one — but it is also not ours to
 * hard-code, because a fork, a preview deploy and a local checkout each want their own, and a
 * constant in a source file is a constant somebody has to edit out. `VITE_` is the prefix Vite
 * inlines at build time.
 *
 * Empty and whitespace count as absent. A `.env` line left as `VITE_REOWN_PROJECT_ID=` is the
 * common way to end up with an empty string, and an empty projectId does not fail at init — it
 * fails later, at the relay, with a 403 and no session. Absent here means the app never offers
 * the button at all, which is the honest thing to show.
 */
export function projectId(): string | null {
  const raw = import.meta.env?.VITE_REOWN_PROJECT_ID
  const id = typeof raw === 'string' ? raw.trim() : ''
  return id === '' ? null : id
}

/**
 * Whether this build offers WalletConnect at all.
 *
 * Read during render. When it is false the picker draws no "scan with a phone" row, so there is
 * no button that cannot work — the extension path is untouched and the app behaves exactly as it
 * did before this module existed.
 */
export const walletConnectOffered = () => projectId() !== null

/** The page's origin, or a placeholder where there is no page. Wallets show this to the person. */
function origin(): string {
  try {
    return typeof window === 'undefined' ? 'https://prove.cash' : window.location.origin
  } catch {
    return 'https://prove.cash'
  }
}

/**
 * What the wallet prints on the approval screen.
 *
 * Deliberately not translated. A wallet stores this with the session and shows it in its own list
 * of connected sites, for as long as the session lives; a person who switched the app to Japanese
 * this afternoon must not find a second, differently-named prove.cash in their wallet tomorrow.
 * The name and the URL are identity, the way a token symbol is, and the one sentence beside them
 * stays in one language for the same reason.
 *
 * The URL has to be this page's real origin. A wallet that finds the metadata URL and the pairing
 * origin disagree warns the person that the site may not be who it says it is.
 */
const metadata = () => ({
  name: 'prove.cash',
  description: 'Sign an offer. A solver fills it or nobody does.',
  url: origin(),
  icons: [`${origin()}/favicon.svg`],
})

/**
 * The chains to ask for, and where to read each of them.
 *
 * **Optional, never required.** A `requiredNamespaces` entry is a condition of the session: a
 * wallet that does not know chain 369 must refuse the whole connection, and most wallets do
 * exactly that. An `optionalNamespaces` entry is a request, so a wallet approves the chains it
 * has and ignores the rest, and a person whose wallet only knows 943 still gets a session. This
 * is the single decision that makes a non-mainstream chain workable over WalletConnect at all.
 *
 * Both key spellings go in `rpcMap` on purpose. The package looks the map up two different ways
 * in two different places — `rpcMap['eip155:943']` when it builds its HTTP providers from the
 * namespace chains, and `rpcMap['943']` when it falls back for a chain it meets later. Fill only
 * one and the other path silently reaches for `rpc.walletconnect.org`, which has never heard of
 * PulseChain, and every read through the session times out instead of failing.
 */
function namespaces() {
  const rpcMap: Record<string, string> = {}
  for (const id of CHAIN_IDS) {
    const url = getChainRpc(id)
    rpcMap[`${id}`] = url
    rpcMap[`eip155:${id}`] = url
  }
  return {
    eip155: {
      chains: CHAIN_IDS.map((id) => `eip155:${id}`),
      methods: WALLET_METHODS,
      events: WALLET_EVENTS,
      rpcMap,
    },
  }
}

/** The provider of the open session, while there is one. */
let live: SessionProvider | undefined

/** Everybody who asked to hear that the session ended. */
const enders = new Set<() => void>()

/**
 * Tell me when the session goes away — the person disconnected in their wallet, or the pairing
 * expired. Hands back the unsubscribe.
 *
 * The header needs this. Without it a wallet that hung up leaves the address on screen and every
 * later signature throws at a session that is gone.
 */
export function onSessionEnded(cb: () => void) {
  enders.add(cb)
  return () => {
    enders.delete(cb)
  }
}

/** Forget the session, here and in `lib/wallet.ts`, and tell everybody who asked. */
function ended() {
  live = undefined
  adoptSession(undefined)
  for (const cb of [...enders]) {
    try {
      cb()
    } catch {
      /* One subscriber's throw must not keep the others from hearing. */
    }
  }
}

/**
 * Open a WalletConnect session and hand back the account it carries.
 *
 * `onUri` fires once, with the `wc:` string. That string is the whole of what a QR code holds and
 * the whole of what a deep link carries, so it is the only thing the UI needs from the protocol.
 * It arrives before the promise settles and often a second or two before, which is the point:
 * the code goes on screen while this call is still waiting for somebody to scan it.
 *
 * Null when the session opens and carries no account for any chain we asked about. The header
 * reads null as "answered, nothing connected", the same as a locked extension.
 */
export async function connectWalletConnect(
  id: ChainId,
  onUri: (uri: string) => void,
): Promise<Address | null> {
  const pid = projectId()
  if (pid === null) throw new Error('No Reown project id in this build.')

  /*
   * A session that is already open is used again rather than replaced.
   *
   * The reader reaches this a second time after a chain that would not switch: the first attempt
   * paired, then refused, and they pressed the button again. Pairing afresh would ask them to
   * scan a second code for a wallet they have already connected, and would leave two live
   * sessions on the relay for one app.
   *
   * It is re-adopted rather than assumed: the reader may have picked an extension in between,
   * and `preferWallet` drops the session when they do. Coming back to the phone has to hand it
   * over again, or `ensureChain` below reaches for a wallet that is no longer there.
   */
  if (live) {
    adoptSession(live)
    return await settle(live, id)
  }

  const p = await loader({ projectId: pid, metadata: metadata() })
  live = p

  let arrived = false
  const uri = (v: unknown) => {
    if (typeof v !== 'string' || v === '') return
    arrived = true
    onUri(v)
  }
  p.on?.('display_uri', uri)
  p.on?.('session_delete', ended)
  p.on?.('disconnect', ended)

  /*
   * A relay that will not talk to us must say so, and it will not say so on its own.
   *
   * Measured, in a browser, against a project id the relay rejects: the socket is refused, the
   * client retries it forever, and NOTHING comes back. No throw, no event, no code. The dialog
   * sat at "opening the connection" for half a minute and would have sat there all day.
   *
   * This is not a rare case. It is what an unknown project id does (401), what an invalid one
   * does (403), and — the one that will actually happen to us — what a deploy from an origin
   * that is not on the Reown allowlist does (the socket closes with 3000, "origin not allowed").
   * That last one passes every test and every local run, and fails only in production.
   *
   * So the wait is bounded, and bounded on the right thing: the code arriving, not the person
   * scanning it. Once a `wc:` string is on screen the person may take as long as they like to
   * find their phone, and nothing here hurries them. Before it arrives, silence is a fault.
   */
  const timer = { id: undefined as ReturnType<typeof setTimeout> | undefined }
  const silence = new Promise<never>((_, reject) => {
    timer.id = setTimeout(() => {
      if (!arrived) reject(new Error(t('wallet.wc.unreachable')))
    }, RELAY_SILENCE_MS)
  })

  try {
    await Promise.race([p.connect({ optionalNamespaces: namespaces() }), silence])
  } catch (e) {
    // Nothing half-open survives. `live` must go, or the retry above would reuse a provider
    // whose relay never answered and would hang a second time without even pairing.
    live = undefined
    try {
      p.abortPairingAttempt?.()
    } catch {
      /* The retry loop stops on its own once nothing holds the pairing. */
    }
    throw e
  } finally {
    clearTimeout(timer.id)
    // The URI is dead the moment the pairing settles, either way. Holding the listener would
    // hand a second connection's code to the first connection's screen.
    p.removeListener?.('display_uri', uri)
  }

  /*
   * Point the session at the chain this app is showing, and give it our endpoint for it.
   *
   * Without this the session's default chain is whichever the wallet listed first, so a person
   * reading the 943 board would sign under 369's domain. The URL matters as much: a session reads
   * `eth_call` and `eth_chainId` over HTTP rather than through the wallet, and the package's own
   * fallback is `rpc.walletconnect.org`, which does not carry PulseChain.
   *
   * It is allowed to fail. A wallet that approved only the other chain has no provider for this
   * one, and `ensureChain` below is the ladder that asks the wallet to add it — the same ladder
   * an extension goes through.
   */
  try {
    p.setDefaultChain(`eip155:${id}`, getChainRpc(id))
  } catch {
    /* `ensureChain` is the real answer; see above. */
  }

  adoptSession(p)
  return await settle(p, id)
}

/**
 * Read the account off a live session, having first made sure the session is on the right chain.
 *
 * **The chain guard, and it is not optional.** A wallet approves the chains it knows and then
 * stays wherever it already was — usually Ethereum — because nothing in the handshake tells it
 * to move. Without this the session connects, the header shows an address, and every signature
 * after it is made under another chain's domain. A live PulseChain dapp shipped this exact fault
 * and had to add the same guard.
 *
 * `ensureChain` is the ladder the extension path already climbs: read the chain, ask for a
 * switch, fall back to an add, then read it again because neither request promises a move. It is
 * reached through `lib/wallet.ts`, which is talking to this session by now, so there is one
 * ladder and not two.
 */
async function settle(p: SessionProvider, id: ChainId): Promise<Address | null> {
  const accounts = (await p.request({ method: 'eth_requestAccounts' })) as Address[]
  await ensureChain(id)
  return accounts[0] ?? null
}

/**
 * Stop waiting for somebody to scan.
 *
 * The picker calls this when it closes. A pairing left open keeps a relay subscription and keeps
 * a `wc:` code alive that nobody is looking at any more, and the next attempt would then race
 * two pending pairings against one screen.
 */
export function cancelWalletConnect() {
  const p = live
  if (!p) return
  try {
    p.abortPairingAttempt?.()
  } catch {
    /* An abort that fails is not worth a message; the session simply expires. */
  }
}

/**
 * End the session, from our side.
 *
 * Tells the wallet first so the person's own list of connected sites loses the entry, then
 * forgets it here whatever the relay said. A disconnect that cannot reach the relay must still
 * disconnect the app — otherwise the button stops working and the address stays on screen.
 */
export async function disconnectWalletConnect() {
  const p = live
  ended()
  if (!p) return
  try {
    await p.disconnect()
  } catch {
    /* Already gone, or the relay is unreachable. Either way this app is disconnected. */
  }
}

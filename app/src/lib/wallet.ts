import {
  createWalletClient,
  custom,
  numberToHex,
  type Address,
  type EIP1193Provider,
  type Hex,
} from 'viem'
import {
  exclusiveSigningRequest,
  getChainId,
  network,
  signingDomain,
  assertFeeTerms,
  ZERO_HASH,
  type ChainId,
  type Exclusive,
  type Intent,
  signIntent as signIntentWith,
  CHAIN_IDS,
  NETWORKS,
  knownFeeConfig,
  rememberFeeConfig,
} from '@prove.cash/sdk'
import { t } from './i18n.ts'

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

/** An injected wallet: the one method EIP-1193 names, and the two listener methods it does not. */
type Injected = {
  request: EIP1193Provider['request']
  on?: (e: string, h: (v: unknown) => void) => void
  removeListener?: (e: string, h: (v: unknown) => void) => void
}

/**
 * The same shape, named for what it now covers.
 *
 * A WalletConnect session hands back an object with exactly these three methods and no page
 * injected it, so `Injected` reads as a lie at the call site in `lib/walletconnect.ts`. The type
 * is one type because every reader below cares about the three methods and about nothing else.
 */
export type WalletProvider = Injected

/** The part of `window` this file uses. A stub or a prerender has some of it and not the rest. */
type Page = {
  ethereum?: unknown
  addEventListener?: (type: string, h: (e: Event) => void) => void
  dispatchEvent?: (e: Event) => boolean
}

/** The page, or undefined where there is none. Reading the identifier itself can throw. */
function page(): Page | undefined {
  try {
    return typeof window === 'undefined' ? undefined : (window as unknown as Page)
  } catch {
    return undefined
  }
}

/**
 * Read one property off an injected object without letting it take the page down.
 *
 * **Every read here crosses into code this app did not write, and a plain property read can
 * throw.** A wallet extension may install `window.ethereum` as a Proxy, and a Proxy whose `get`
 * returns a fresh bound function where the target holds a non-writable, non-configurable one
 * breaks a language invariant. The ENGINE then refuses the read, before the wallet's code runs
 * and before ours does:
 *
 *   TypeError: 'get' on proxy: property 'on' is a read-only and non-configurable data property
 *   on the proxy target but the proxy did not return its actual value
 *
 * Production threw that at `p.on?.(…)` inside the mount effect in `App.tsx`. React unmounted the
 * tree and the tab went white — no message, no button, nothing to say the app was still there.
 * Brave is the known cause: it makes `request`, `isConnected`, `enable` and `sendAsync`
 * non-writable so another extension cannot overwrite them, and its own proxy handler then
 * re-wraps those same four. Two extensions on one page is what makes it bite.
 *
 * The fallback is the part that matters. `Object.getOwnPropertyDescriptor` does not go through the
 * `get` trap, so the frozen function is still reachable and the app keeps working rather than
 * merely failing politely. A plain read comes first because it is the only one that finds a
 * method on a prototype, which is where an ordinary provider keeps its own.
 */
function readFrom(obj: object, key: string): unknown {
  try {
    return (obj as Record<string, unknown>)[key]
  } catch {
    try {
      return Object.getOwnPropertyDescriptor(obj, key)?.value
    } catch {
      return undefined
    }
  }
}

/** What a wallet says about itself when it announces. `rdns` is its reverse-DNS name. */
export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string }

/** One announcement: the details a wallet names itself by, and its own provider object. */
type Announcement = { info: WalletInfo; provider: Injected }

/**
 * Every wallet that has announced itself under EIP-6963, keyed by reverse-DNS name.
 *
 * **The standard written for exactly our defect: several wallets on one page.** The app asks with
 * `eip6963:requestProvider`, each extension answers with `eip6963:announceProvider` carrying its
 * OWN provider object, and the app talks to that instead of the global they are all fighting
 * over. It is a fix and not a dodge: Brave announces `window.braveEthereum`, the raw object
 * behind the proxy that throws.
 *
 * Keyed by `rdns` because that is the field the standard makes stable between sessions — `uuid`
 * identifies one page's session of one wallet, and a wallet may announce several over a page's
 * life. wagmi and RainbowKit both key on `rdns` for the same reason.
 */
const announced = new Map<string, Announcement>()

/** The page discovery is running on, so a second call does not ask twice. */
let discoveredOn: Page | undefined | null = null

/** The wallet a person chose, by `rdns`. The picker sets this; see `preferWallet`. */
let preferred: string | null = null

/**
 * An open WalletConnect session, once there is one. Undefined the rest of the time.
 *
 * **This is the whole of the addition, on this side.** A session provider answers `request`, `on`
 * and `removeListener` the way an extension does, so every function below it — `connect`,
 * `ensureChain`, `browserWallet`, all three signers, `onAccountsChanged` — works unchanged the
 * moment this is set. Nothing in this file imports `lib/walletconnect.ts`; that module hands the
 * provider in and this one never learns where it came from.
 */
let session: WalletProvider | undefined

/**
 * Talk to this WalletConnect session from now on. Undefined goes back to the extensions.
 *
 * Not named `useSession`. A plain function whose name starts with `use` is a React hook to every
 * linter in the ecosystem, and this one is called from an event handler and from a module-level
 * callback — both of which the rules-of-hooks check fails, correctly, for a hook.
 *
 * Choosing a session clears any extension preference and choosing an extension clears the
 * session, because the two are one choice: a person connects one wallet, not two. Without that
 * the picker could leave a stale preference behind, and the next `preferWallet(null)` would
 * silently fall back to a session the person had already left.
 */
export function adoptSession(p: WalletProvider | undefined) {
  session = p
  if (p) preferred = null
  walletMoved()
}

/**
 * The account watchers, told each time the wallet this file talks to changes.
 *
 * `watchAccount` binds its listener to one provider. Without this, a session adopted or a wallet
 * preferred after mount left the header listening to the old wallet, and forms signed with an
 * account the active wallet never reported.
 */
const rebinders = new Set<() => void>()
function walletMoved() {
  for (const rebind of [...rebinders]) rebind()
}

/** Whether a WalletConnect session is the wallet this app is talking to. */
export const onSession = () => session !== undefined

/**
 * Ask the page's wallets to announce themselves. Once per page, and the listener stays on.
 *
 * The order is fixed by the standard: the listener goes on BEFORE the request goes out, or an
 * extension that answers synchronously answers into nothing. And the listener is never removed,
 * because a wallet may announce at any later moment — Brave injects a few milliseconds after
 * load — and because every extension re-announces each time any code on the page asks again.
 *
 * A page that cannot carry an event is not a failure. A prerender has no window at all, and a
 * test stub has one with no `addEventListener`. Both fall through to the global below.
 */
function discover() {
  const win = page()
  if (win === discoveredOn) return
  discoveredOn = win
  announced.clear()
  if (!win || typeof win.addEventListener !== 'function') return
  if (typeof win.dispatchEvent !== 'function') return
  try {
    win.addEventListener('eip6963:announceProvider', keep)
    // `eip6963:requestProvider` carries no detail, so it is a plain `Event`. Only the
    // announcement is a `CustomEvent`, and a wallet that checks the class must find the right one.
    win.dispatchEvent(new Event('eip6963:requestProvider'))
  } catch {
    /* A page that will not carry an event still has a global to fall back to. */
  }
}

/**
 * Record one announcement.
 *
 * Duck-typed, never `instanceof CustomEvent`: the check fails across realms, which is how
 * MetaMask's own dapp-side helper breaks in a test environment. Nothing here is required beyond
 * a reverse-DNS name and a provider — the standard says a dapp should ignore what it does not
 * recognise, and it must not reject a wallet over a missing icon.
 */
function keep(e: Event) {
  const detail = readFrom(e, 'detail')
  if (!detail || typeof detail !== 'object') return
  const info = readFrom(detail, 'info')
  const provider = readFrom(detail, 'provider')
  if (!info || typeof info !== 'object' || !provider || typeof provider !== 'object') return
  const rdns = readFrom(info, 'rdns')
  if (typeof rdns !== 'string' || rdns === '') return
  const text = (key: string) => {
    const v = readFrom(info, key)
    return typeof v === 'string' ? v : ''
  }
  announced.set(rdns, {
    info: { uuid: text('uuid'), name: text('name') || rdns, icon: text('icon'), rdns },
    provider: provider as Injected,
  })
}

/** Every announced wallet, sorted by reverse-DNS name. The order is the same on every load. */
const sorted = () => [...announced.values()].sort((a, b) => (a.info.rdns < b.info.rdns ? -1 : 1))

/**
 * Every wallet that has announced itself, in the order a picker would list them.
 *
 * **Nothing draws this yet, and this is the seam a picker goes in.** List these, let the person
 * choose, and pass the `rdns` they picked to `preferWallet`. Until something does, the choice is
 * made by the rule below and no screen asks.
 */
export function announcedWallets(): WalletInfo[] {
  discover()
  return sorted().map((a) => a.info)
}

/** Use this announced wallet from now on. Null goes back to the rule. A picker's one call. */
export function preferWallet(rdns: string | null) {
  preferred = rdns
  session = undefined
  walletMoved()
}

/**
 * Which wallet to talk to.
 *
 * An announced provider wins over the global, because the global is the object two extensions
 * fight over and an announced one is the extension's own. Several announcements are settled by
 * the lowest reverse-DNS name — arbitrary, and the point is that it is the SAME arbitrary answer
 * on every load. Announcement order would not be: the standard promises nothing about it, it does
 * not follow the person's default-wallet setting, and it can change between two loads of the same
 * page. A person must not get one wallet this morning and another this afternoon.
 *
 * An open WalletConnect session comes before all of it. That session exists because somebody
 * scanned a code a moment ago, which is the plainest statement of intent this file ever gets —
 * plainer than an extension the browser happens to carry, and plainer than a stored preference.
 */
function injected(): Injected | undefined {
  if (session) return session
  discover()
  const mine = preferred === null ? undefined : announced.get(preferred)
  const chosen = mine ?? sorted()[0]
  if (chosen) return chosen.provider
  const win = page()
  if (!win) return undefined
  const global = readFrom(win, 'ethereum')
  return global && typeof global === 'object' ? (global as Injected) : undefined
}

/** Whether this page can reach a wallet at all. Read during render, so it never throws. */
export const hasWallet = () => injected() !== undefined

/**
 * The page's wallet, or a sentence the person can act on.
 *
 * Two refusals, and they send a person to two different places. No wallet at all means install
 * one. A wallet whose `request` cannot even be read means two extensions are fighting over the
 * page, and the thing to do is turn one of them off — so that is what it says, rather than
 * repeating an engine message about a proxy invariant at somebody who cannot act on it.
 *
 * What comes back is a plain object, never the injected one. Everything downstream — viem's
 * `custom` transport included — reads `request` off it, and that read has to be one this file has
 * already made safely. viem's `custom` uses `request` and nothing else, so the listener methods
 * are not missed here; `onAccountsChanged` reaches for them itself.
 */
function provider(): EIP1193Provider {
  const p = injected()
  if (!p) throw new Error('No browser wallet found. Install MetaMask or Rabby.')
  const request = readFrom(p, 'request')
  if (typeof request !== 'function') throw new Error(t('wallet.conflict'))
  const send = request as (args: unknown) => Promise<unknown>
  return { request: (args: unknown) => send.call(p, args) } as unknown as EIP1193Provider
}

/**
 * Ask for an account, then put the wallet on the right chain before handing one back.
 *
 * Null when the wallet grants nothing, which is what a locked wallet does. Not undefined: the
 * header reads undefined as "the wallet has not answered yet" — `accountAnswered` in
 * `lib/answered.ts` is that rule, and it is the difference between a button that says "connect"
 * and one that pulses at "checking". A finished connection has answered, whatever it answered.
 * `currentAccount` has said null for the same wallet all along.
 */
export async function connect(id: ChainId = getChainId()): Promise<Address | null> {
  const p = provider()
  const accounts = (await p.request({ method: 'eth_requestAccounts' })) as Address[]
  await ensureChain(id)
  return accounts[0] ?? null
}

export async function currentAccount(): Promise<Address | null> {
  if (!hasWallet()) return null
  const accounts = (await provider().request({ method: 'eth_accounts' })) as Address[]
  return accounts[0] ?? null
}

/**
 * Read `eth_chainId` from a wallet that may not answer it in hex.
 *
 * EIP-695 says the answer is a hex string and every extension sends one. A WalletConnect session
 * does not: `@walletconnect/universal-provider` answers `eth_chainId` itself, out of the session
 * it already holds, and it returns `parseInt(defaultChain)` — the NUMBER 943, not `"0x3af"`. Read
 * that through `parseInt(x, 16)` and 943 comes back as 2371, so `ensureChain` would decide the
 * wallet was on the wrong chain, ask it to switch to the chain it is already on, and then throw
 * the "switch it and try again" sentence at somebody with nothing to switch.
 *
 * So both answers are accepted, and a number is taken at face value. Nothing else in the app
 * reads this method.
 */
function chainOf(answer: unknown): number {
  if (typeof answer === 'number') return answer
  return parseInt(answer as Hex, 16)
}

export async function ensureChain(id: ChainId = getChainId()) {
  const p = provider()
  const chainNow = async () => chainOf(await p.request({ method: 'eth_chainId' }))
  if ((await chainNow()) === id) return
  const { chain } = network(id)
  try {
    await p.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: numberToHex(id) }],
    })
  } catch {
    /*
     * The URL here is the chain's PUBLIC endpoint, and it has to stay that way.
     *
     * MetaMask checks an add against `chainid.network/chains.json`: it takes the FIRST URL in
     * this array, compares its origin to the canonical list for that chain id, and raises an
     * error-severity "invalid RPC URL" alert when they disagree. Our gateway is not on that
     * list, so sending it would put a red warning in front of somebody who is being asked to
     * trust a network they have never heard of. `chain.rpcUrls.default.http[0]` is
     * `https://rpc.pulsechain.com` on 369, which is the URL the list carries.
     *
     * The gateway is still what this app reads through. That is a separate setting, and the
     * wallet's own endpoint is none of our business.
     */
    await p.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: numberToHex(id),
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: [chain.rpcUrls.default.http[0]],
          blockExplorerUrls: [chain.blockExplorers?.default.url ?? ''],
        },
      ],
    })
  }
  /*
   * Ask the wallet again, because neither request promises a switch.
   *
   * `wallet_addEthereumChain` resolves for a chain the wallet already knows and does not have to
   * move to it — a person can approve the add and decline the switch, and some wallets never
   * offer the switch at all. Without this read the refusal lands nowhere: `browserWallet` builds
   * its client on the chain that was asked for, so the client would name a chain the wallet is
   * not on and every write under it would be addressed to another chain's deployment.
   */
  if ((await chainNow()) !== id) {
    throw new Error(t('wallet.chain.other', { network: chain.name }))
  }
}

/**
 * A wallet client over the browser's provider, already on the right chain. This is the one
 * thing the SDK cannot build for itself — every SDK write takes a client like this.
 */
export async function browserWallet(id: ChainId = getChainId()) {
  await ensureChain(id)
  return createWalletClient({ chain: network(id).chain, transport: custom(provider()) })
}

/**
 * Sign the terms. The one place this app turns an `Intent` into a maker's signature.
 *
 * `signingDomain` and not `domain`, and it is read before the wallet opens, the way every
 * wrapper in `lib/settlement.ts` refuses before it prompts. On a chain with no settlement the
 * domain's `verifyingContract` is the zero address, and a signature under it is bound to no
 * contract at all — unspendable the day it is made and unrescuable by any later deploy. The
 * board would carry it regardless, and seven such offers already reached the mainnet archive.
 *
 * The ladder locks every rung and the form disables its button, so nobody should ever reach
 * this. That is the argument for the throw rather than against it: those two are about what a
 * maker is offered, and this is about what can be signed.
 */
export async function signIntent(intent: Intent, id: ChainId = getChainId()): Promise<Hex> {
  const eip712 = signingDomain(id)
  // A fee the chain will refuse at every fill: a rate above one hundred per cent, or a rate with
  // no config to pay it to. Refused here too, before the wallet opens, whatever built the intent.
  assertFeeTerms(intent)
  // A wallet signs typed data, which carries the config's destinations, not its hash. Every
  // default this build ships is always known. A config the chain's FeeDefaults returned that the
  // build does NOT ship is remembered only once the maker has acknowledged its destinations
  // (`acknowledgeDefault`), so an unknown hash stops here however it got into an intent. A wallet cannot sign a zero config at all (no struct
  // hashes to zero), so an unknown config is refused here with the SDK's own message.
  for (const c of CHAIN_IDS) for (const h of NETWORKS[c].fees.history) rememberFeeConfig(h.config)
  if (intent.feeConfig !== ZERO_HASH && knownFeeConfig(intent.feeConfig) === null) {
    throw new Error(
      'That fee config is not one this app ships, and its destinations have not been acknowledged, so a wallet cannot show it.',
    )
  }
  const wallet = await browserWallet(id)
  return signIntentWith(wallet, intent, { domain: eip712, account: intent.maker, chainId: id })
}

/**
 * Sign the binding that makes a quote exclusive: this intent hash, this counterparty, this size,
 * until this moment.
 *
 * A second signature under a second domain — the venue's, not the settlement's — so the
 * settlement's `Intent` typehash never moves and no chain needs an upgrade to carry one. The SDK
 * builds the whole request; only the signature needs a wallet, which is why only that is here.
 */
export async function signExclusive(
  account: Address,
  ex: Exclusive,
  venue: Address,
  id: ChainId = getChainId(),
): Promise<Hex> {
  const wallet = await browserWallet(id)
  return wallet.signTypedData({ account, ...exclusiveSigningRequest(ex, venue, id) })
}

/**
 * Sign a plain string with the browser wallet — `personal_sign`, not typed data.
 *
 * Two RFQ messages need it and neither is a transaction. One derives the counterparty's
 * encryption key, so the same wallet must return the same 65 bytes every time; the other
 * announces the public half, and the address it speaks for is recovered from the signature
 * rather than claimed on the wire. Both strings are readable, because the wallet shows them to
 * the person who is attesting to them.
 */
export async function signMessage(
  account: Address,
  message: string,
  id: ChainId = getChainId(),
): Promise<Hex> {
  const wallet = await browserWallet(id)
  return wallet.signMessage({ account, message })
}

/**
 * Tell me when the person switches account. Hands back the unsubscribe.
 *
 * This is the line production died on. `App.tsx` calls it from a mount effect and returns the
 * unsubscribe as the cleanup, so a throw anywhere in here unmounts the whole tree — and `on` is
 * exactly the property a contested `window.ethereum` refuses to hand over. Nothing below is
 * allowed to throw, in either direction: not the subscribe, and not the unsubscribe React calls
 * on the way out.
 *
 * **A failure to subscribe still returns a working unsubscribe.** The caller has a cleanup to
 * run whatever happened here, and a missing one is a second crash at unmount.
 */
/**
 * The account now, then every change. Returns the unsubscribe.
 *
 * A failed first read reports null. A first read that settles after an `accountsChanged` event,
 * or after the unsubscribe, reports nothing: the newer answer stands.
 */
export function watchAccount(cb: (a: Address | null) => void): () => void {
  let stopped = false
  // Bumped by every event and every rebind, so a first read that lands late reports nothing.
  let turn = 0
  const bind = () =>
    onAccountsChanged((a) => {
      turn++
      if (!stopped) cb(a)
    })
  const read = () => {
    const mine = ++turn
    currentAccount()
      .catch(() => null)
      .then((a) => {
        if (mine === turn && !stopped) cb(a)
      })
  }
  let stop = bind()
  read()
  // A new wallet: drop the old listener, listen to the new one, and ask it who is connected.
  const rebind = () => {
    stop()
    stop = bind()
    read()
  }
  rebinders.add(rebind)
  return () => {
    stopped = true
    rebinders.delete(rebind)
    stop()
  }
}

export function onAccountsChanged(cb: (a: Address | null) => void) {
  const p = injected()
  if (!p) return () => {}
  const handler = (accounts: unknown) =>
    cb((((accounts as Address[] | undefined) ?? [])[0] ?? null) as Address | null)
  const on = readFrom(p, 'on')
  const off = readFrom(p, 'removeListener')
  if (typeof on !== 'function') return () => {}
  try {
    ;(on as (e: string, h: (v: unknown) => void) => void).call(p, 'accountsChanged', handler)
  } catch {
    return () => {}
  }
  return () => {
    if (typeof off !== 'function') return
    try {
      ;(off as (e: string, h: (v: unknown) => void) => void).call(p, 'accountsChanged', handler)
    } catch {
      /* A wallet that will not let go of a listener is not a reason to fail an unmount. */
    }
  }
}

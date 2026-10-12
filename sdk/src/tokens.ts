import { erc20Abi, formatUnits, parseAbi, parseUnits, type Address } from 'viem'
import { rpcClient } from './client.js'
import { getChainRpc, presetTokens, type ChainId } from './config.js'
import { kv } from './kv.js'
import { listToken } from './tokenlist.js'

/**
 * Token identity, resolved once and remembered. The presets answer first, then the token list,
 * then the chain itself. The formatters at the bottom exist so every surface prints an amount
 * the same way.
 *
 * **One cache per chain, and the chain is in the storage key.** An address means nothing on its
 * own: the same twenty bytes are a different contract on a different chain. HEX sits at
 * 0x2b591e…07B39 on both 369 and 943, so the registry's two entries used to meet in a single slot
 * keyed by address alone, in a map seeded from every chain's presets at once. That was safe only
 * while the two entries agreed about the token, and nothing held them to it.
 *
 * The mainnet flip is what makes it reachable. While 369 settles nowhere a tab reads one chain,
 * and no session asks two endpoints about one address. Turning it on gives a reader a network
 * switch, and the answer they carry across it carries `decimals` — `tokenInfo` below says what a
 * wrong decimal place does to an offer.
 *
 * So `chainId` is a required first argument here, never defaulted to `getChainId()`. A default
 * lets every existing call site keep compiling while still silently following whichever network
 * the process points at now, which is the fault rather than the fix. Each chain's rows live under
 * `provecash.tokens.<chainId>` and in a map of their own, so a read for one chain cannot reach
 * another chain's row even where a caller forgets to filter. `config.ts` already keeps
 * per-install state in that shape.
 */

/** What a client needs to know about a token to price and print it. */
export type TokenInfo = {
  address: Address
  symbol: string
  decimals: number
  /** Set when this token is a 1:1 wrapper (x402*): the underlying it wraps, same decimals. */
  wraps?: Address
  /**
   * The underlying's symbol, recorded when `wraps` was resolved on this token's own chain.
   *
   * It is stored rather than looked up so `displaySymbol` needs no cache and therefore no chain.
   * See that function for why the lookup had to go.
   */
  wrapsSymbol?: string
  /**
   * True when neither this chain's presets nor the token list carry the token, so its name came
   * from the token itself. An unlisted token borrows nothing from a listed one: no wrapper
   * identity, no market, no face. See `displaySymbol`.
   */
  unlisted?: true
}

/** True when a preset or the token list vouches for this token. */
export const isListedToken = (t: TokenInfo): boolean => !t.unlisted

/** True when this chain's presets or the token list carry `address`. */
function listedOn(chainId: ChainId, address: Address): boolean {
  const a = address.toLowerCase()
  return presetTokens(chainId).some((t) => t.address.toLowerCase() === a) || Boolean(listToken(address, chainId))
}

/**
 * A row as this build trusts it. A row nobody lists loses any wrapper identity it carries: an
 * older build took that from the token's own `underlying()` answer, and a fake could lie in it.
 */
function trusted(chainId: ChainId, row: TokenInfo): TokenInfo {
  if (listedOn(chainId, row.address)) return row
  return { address: row.address, symbol: row.symbol, decimals: row.decimals, unlisted: true }
}

/** One chain's answers. Its own maps, so no lookup here can reach into another chain's. */
type ChainCache = {
  tokens: Map<string, TokenInfo>
  /** Addresses already asked for an `underlying()`, so a plain token is probed once and no more. */
  probed: Set<string>
}

const STORE = (chainId: ChainId) => `provecash.tokens.${chainId}`

/** Where every chain's tokens sat together, before the cache was keyed by chain. */
const LEGACY_STORE = 'provecash.tokens'

const caches = new Map<ChainId, ChainCache>()

let legacyCleared = false

/**
 * Forget the un-keyed cache an older build left behind.
 *
 * **These rows are dropped rather than moved, which is the opposite of what `keepalive.ts` does
 * with its own legacy key, and the difference is what a row is.** A kept intent is a maker's
 * signed offer: nothing can rebuild it, and dropping it takes their live offers off the board
 * within about 120 blocks with nothing said. A token row is a cached answer to a public read. It
 * comes back from one `symbol` call and one `decimals` call, and the rows that matter on the
 * first frame — the presets — are seeded from the registry on every load and never came from
 * storage at all.
 *
 * **Nothing in the old blob says which chain read it, and guessing is the fault being fixed.** It
 * held one flat address-to-token map, written by whichever chain the browser was on at the time,
 * and a browser that switched chains wrote both into it. Filing those rows under one chain would
 * put that chain's name on another chain's decimals — the exact claim this change exists to stop
 * making.
 *
 * The rows that could be attributed are the rows we already have. A legacy row matching a preset
 * is re-seeded from the registry; a 369 row that came from the token list is answered again by
 * `listToken` with no chain read at all. What is left is a pasted address, and it costs one round
 * trip the next time somebody looks at it.
 *
 * The key is removed on the first cache built in this process, so a browser carries it no further.
 */
function clearLegacy(): void {
  if (legacyCleared) return
  legacyCleared = true
  kv().removeItem(LEGACY_STORE)
}

/** One chain's cache, built on first use from that chain's presets and that chain's stored rows. */
function cacheOf(chainId: ChainId): ChainCache {
  const known = caches.get(chainId)
  if (known) return known
  clearLegacy()
  const cache: ChainCache = { tokens: new Map(), probed: new Set() }
  // This chain's registry entry, and only this chain's. The old seed took every chain's.
  for (const t of presetTokens(chainId)) cache.tokens.set(t.address.toLowerCase(), t)
  try {
    const stored = JSON.parse(kv().getItem(STORE(chainId)) || '{}')
    for (const [k, v] of Object.entries(stored)) cache.tokens.set(k, trusted(chainId, v as TokenInfo))
  } catch {
    /* no cache is fine */
  }
  caches.set(chainId, cache)
  return cache
}

function persist(chainId: ChainId, cache: ChainCache) {
  kv().setItem(STORE(chainId), JSON.stringify(Object.fromEntries(cache.tokens)))
}

/** What we already know about a token on one chain, without asking anybody. */
export function cachedToken(chainId: ChainId, address: Address): TokenInfo | undefined {
  return cacheOf(chainId).tokens.get(address.toLowerCase())
}

/**
 * Forget what we learned about one token on one chain, so the next read asks that chain again.
 *
 * A preset goes straight back. The cache is seeded from `presetTokens(chainId)`, so a plain
 * delete would drop a token this build ships with and not recover it until a reload.
 */
export function forgetToken(chainId: ChainId, address: Address) {
  const cache = cacheOf(chainId)
  const key = address.toLowerCase()
  cache.tokens.delete(key)
  cache.probed.delete(key)
  const preset = presetTokens(chainId).find((t) => t.address.toLowerCase() === key)
  if (preset) cache.tokens.set(key, preset)
  persist(chainId, cache)
}

/** Adopt a token the caller already trusts (a token-list entry), skipping the chain read. */
export function registerToken(chainId: ChainId, info: TokenInfo) {
  const cache = cacheOf(chainId)
  const key = info.address.toLowerCase()
  if (!cache.tokens.has(key)) {
    cache.tokens.set(key, info)
    persist(chainId, cache)
  }
}

const UNDERLYING_ABI = parseAbi(['function underlying() view returns (address)'])

/**
 * A token's symbol and decimals on one chain. Cache, then token list, then the chain. Null when
 * the chain would not say.
 *
 * `decimals` used to fall back to 18 on a failed read, and the answer was cached and written to
 * local storage, so one dropped request poisoned that token for every later session. Everything
 * downstream multiplies by it. `parse('100', 18)` on a six-decimal token signs an intent for a
 * million million times what the maker typed, against a `minOut` computed correctly — and with
 * partial fills on by default, an executor may take the maker's whole balance and owe rounding
 * dust for it. A guessed decimal place is not a cosmetic default; it is the difference between
 * an offer and a gift.
 *
 * So a token this function cannot read is a token it does not know. Callers skip it. A symbol
 * that fails is still '???', because a name nobody can read costs nothing but a name.
 *
 * The same reasoning is why `chainId` is named rather than defaulted: a cached decimal place from
 * the wrong chain is a guessed decimal place with a cache entry to vouch for it.
 */
export async function tokenInfo(
  /** The chain this address is on. The token list, the endpoint and the cache all follow it. */
  chainId: ChainId,
  address: Address,
  /** The endpoint to ask. Defaults to this chain's; tests and multi-chain callers pass one. */
  client: Pick<ReturnType<typeof rpcClient>, 'readContract'> = rpcClient(
    getChainRpc(chainId),
    chainId,
  ),
): Promise<TokenInfo | null> {
  const cache = cacheOf(chainId)
  const key = address.toLowerCase()
  let info = cache.tokens.get(key)
  // The token list can arrive after a row was read off the chain. Its answer then wins.
  if (info?.unlisted && listToken(address, chainId)) info = undefined
  if (!info) {
    // The token list answers before the chain has to. Its entries are per chain, so ask with ours.
    const listed = listToken(address, chainId)
    if (listed) {
      info = { address, symbol: listed.symbol, decimals: listed.decimals }
      cache.tokens.set(key, info)
      persist(chainId, cache)
    }
  }
  if (!info) {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }).catch(() => '???'),
      // No fallback. The whole point of this function is this number.
      client
        .readContract({ address, abi: erc20Abi, functionName: 'decimals' })
        .then((d) => Number(d))
        .catch(() => null),
    ])
    if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
      return null
    }
    // Off every list, so the name is the token's own claim and nothing else.
    info = { address, symbol: String(symbol), decimals, unlisted: true }
    cache.tokens.set(key, info)
    persist(chainId, cache)
  }
  // x402* tokens wrap an underlying 1:1. Resolve it once, so a caller can show the real asset.
  // Only for a listed wrapper: `underlying()` is the token's own answer, and a fake can name USDC.
  if (!info.unlisted && info.symbol.startsWith('x402') && !info.wraps && !cache.probed.has(key)) {
    cache.probed.add(key)
    try {
      const underlying = await client.readContract({
        address,
        abi: UNDERLYING_ABI,
        functionName: 'underlying',
      })
      // Read the underlying before recording the wrapper, so the wrapper carries its symbol. The
      // read answers null rather than throwing, and a wrapper with no name is still a wrapper.
      const under = await tokenInfo(chainId, underlying, client)
      info = { ...info, wraps: underlying, wrapsSymbol: under?.symbol }
      cache.tokens.set(key, info)
      persist(chainId, cache)
    } catch {
      /* not a wrapper after all */
    }
  }
  return info
}

/** The underlying a wrapper stands in for, as far as this chain's cache has read it. */
export function underlyingOf(chainId: ChainId, t: TokenInfo): TokenInfo | undefined {
  return t.wraps && !t.unlisted ? cachedToken(chainId, t.wraps) : undefined
}

/**
 * The address that has a market: the underlying for a listed wrapper, the token itself otherwise.
 * An unlisted token never borrows a market, whatever its row says.
 */
export const marketAddress = (t: TokenInfo): Address => (t.unlisted ? t.address : (t.wraps ?? t.address))

/** The longest symbol shown, as the token-list schema allows. */
const MAX_SYMBOL = 20

/**
 * Bidi controls (U+061C, U+200E-U+200F, U+202A-U+202E, U+2066-U+2069), zero-width characters
 * (U+200B-U+200D, U+2060, U+FEFF) and C0/C1 controls. A right-to-left override turns "CDSU" into
 * what reads as "USDC", and none of these belongs in a ticker.
 */
// oxlint-disable-next-line no-control-regex -- control characters are what this strips
const HIDDEN = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g

/** A symbol safe to print: hidden characters out, trimmed, and capped at `MAX_SYMBOL`. */
export function cleanSymbol(symbol: string): string {
  const s = symbol.replace(HIDDEN, '').trim()
  if (!s) return '???'
  return s.length > MAX_SYMBOL ? `${s.slice(0, MAX_SYMBOL - 1)}…` : s
}

/** `0x1234…abcd`. */
const shortAddress = (a: Address): string => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * The name a human trades: the underlying's symbol for a wrapper.
 *
 * **It reads the symbol recorded on the token instead of looking the underlying up.** The lookup
 * needed a cache, the cache is now per chain, and about forty call sites hold a `TokenInfo` and
 * no chain — most of them presentational components. Giving each one a chain would have them
 * reach for `getChainId()`, which is this whole change's fault moved one layer out. `tokenInfo`
 * fills `wrapsSymbol` on the chain that resolved the wrapper, so the answer rides on the token
 * and no lookup can cross a chain.
 *
 * A row an older build stored carries `wraps` and no `wrapsSymbol`, and so does a wrapper whose
 * underlying has not been read yet. Both fall back to the prefix, which is what this function
 * already answered in exactly those cases.
 */
export function displaySymbol(t: TokenInfo): string {
  // An unlisted token keeps its own full symbol and shows its address, as the Uniswap interface
  // does for an unknown token. Any symbol can be claimed; only the address is the token.
  if (t.unlisted) return `${cleanSymbol(t.symbol)} (${shortAddress(t.address)})`
  return cleanSymbol(t.wrapsSymbol ?? t.symbol.replace(/^x402/, ''))
}

/** An account's balance of one token. */
export async function balanceOf(token: Address, owner: Address): Promise<bigint> {
  return rpcClient().readContract({
    address: token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  })
}

/** Show enough digits to read a price, never so many that the number stops being a number. */
export function fmt(amount: bigint, decimals: number, max = 6): string {
  const s = formatUnits(amount, decimals)
  if (!s.includes('.')) return Number(s).toLocaleString('en-US')
  const [whole, frac] = s.split('.')
  const big = BigInt(whole) !== 0n
  const keep = big ? Math.min(max, 4) : max + 4
  const trimmed = frac.slice(0, keep).replace(/0+$/, '')
  const head = Number(whole).toLocaleString('en-US')
  return trimmed ? `${head}.${trimmed}` : head
}

/** A typed decimal amount as base units. Empty input is zero. */
export const parse = (value: string, decimals: number) => parseUnits(value || '0', decimals)

/** Stats-bar numbers: compact above a thousand, plain below. */
export function fmtCompact(amount: bigint, decimals: number): string {
  const n = Number(formatUnits(amount, decimals))
  if (!isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1000) {
    return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 })
  }
  return fmt(amount, decimals, 4)
}

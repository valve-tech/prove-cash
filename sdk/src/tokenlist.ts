import type { Address } from 'viem'
import { kv } from './kv.js'

/**
 * The PulseX token list from gib.show, cached and refreshed daily. It fills the picker and the
 * logo lookup for chain 369. Chain 943 is not in the list, so everything here degrades to empty
 * and a caller falls back to the presets plus paste-an-address.
 */

const LIST_URL = 'https://gib.show/list/pulsex'
const STORE_KEY = 'provecash.tokenlist'
const MAX_AGE_MS = 24 * 3600 * 1000

/** One entry of the PulseX token list. */
export type ListToken = {
  chainId: number
  address: Address
  symbol: string
  name: string
  decimals: number
  logoURI?: string
}

type Stored = { fetchedAt: number; version: string; tokens: ListToken[] }

const ZERO = '0x0000000000000000000000000000000000000000'

let stored: Stored | null = null
try {
  stored = JSON.parse(kv().getItem(STORE_KEY) || 'null')
} catch {
  /* no cache is fine */
}

let fetching = false
const listeners = new Set<() => void>()

/** Called once when a fresh list arrives, so a mounted picker can re-render. */
export function onTokenList(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function ensureFresh() {
  if (fetching) return
  if (stored && Date.now() - stored.fetchedAt < MAX_AGE_MS) return
  fetching = true
  fetch(LIST_URL, { signal: AbortSignal.timeout(15_000) })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((json: { version: { major: number; minor: number; patch: number }; tokens: ListToken[] }) => {
      const v = json.version
      stored = {
        fetchedAt: Date.now(),
        version: `${v.major}.${v.minor}.${v.patch}`,
        tokens: (json.tokens ?? []).filter((t) => t.address && t.address !== ZERO),
      }
      kv().setItem(STORE_KEY, JSON.stringify(stored))
      for (const cb of listeners) cb()
    })
    .catch(() => {
      /* the presets carry the picker until the list is reachable */
    })
    .finally(() => {
      fetching = false
    })
}

/** Every listed token on one chain. Kicks a background refresh; returns what is cached now. */
export function listTokens(chainId: number): ListToken[] {
  ensureFresh()
  return stored?.tokens.filter((t) => t.chainId === chainId) ?? []
}

/** One listed token by address, or undefined when the list does not carry it. */
export function listToken(address: Address, chainId: number): ListToken | undefined {
  const a = address.toLowerCase()
  return stored?.tokens.find((t) => t.chainId === chainId && t.address.toLowerCase() === a)
}

/**
 * A testnet token that wears a mainnet token's face.
 *
 * gib.show has no image for a token that exists only on 943, and it should not — the token is
 * ours and it stands for nothing. But tPLSX is a stand-in for PLSX and tUSDC for USDC, so the
 * honest picture is the one the real token wears. Each entry names the chain and address whose
 * logo this one borrows, measured against gib.show rather than assumed:
 *
 *   tPLSX  PLSX on 369    tHEX   HEX  on 369    WPLS(943)  WPLS on 369
 *   tUSDC  USDC on 1      tUSDT  USDT on 1      PLSX(943)  PLSX on 369
 *   tWBTC  WBTC on 1      tWETH  WETH on 1      HEX(943)   the same address on 369
 *
 * The landing page has done this since it was written — `app/src/landing/holdings.ts` names the
 * live tokens' PulseChain selves for the same reason. This is that idea, moved somewhere every
 * surface can reach it.
 */
const WEARS: Record<string, { chain: number; address: string }> = {
  // 943 → the mainnet token it stands in for.
  '0xabef58363e0fc60250d16778848eaed831ea26f9': { chain: 369, address: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab' },
  '0xa54e1565ab28360b66809803306ec5b1229808a0': { chain: 369, address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39' },
  '0x86390129a2079fb7f0fc889473160a3a449117ab': { chain: 1, address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' },
  '0x7d32f9ebb6c5813435f4bdf4e9beaf99c805d529': { chain: 1, address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' },
  '0x70c421a8bac4adaa10285a20eff09997a5e09565': { chain: 1, address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  '0xcb5c3ed9cd727f142d1b9efc60790550683aa655': { chain: 1, address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' },
  '0x70499adebb11efd915e3b69e700c331778628707': { chain: 369, address: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27' },
  '0x8a810ea8b121d08342e9e7696f4a9915cbe494b7': { chain: 369, address: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab' },
}

/**
 * The logo URL for a token: the list's own URI, else the mainnet face it borrows, else
 * gib.show's by-address route for the chain it is on.
 *
 * **This used to refuse to ask on any chain the token list skips, and the reason has expired.**
 * The comment here said gib.show answers 200 with a generated mark for an address it has never
 * seen, so an `onError` fallback could never fire and a testnet token would wear a confident
 * little picture that stands for nothing. That was true when it was written. Measured again on
 * 2026-09-10: `0xdead…beef` on 369 returns **404** with a 30-byte JSON body, byte-identical to
 * the response for a 943 token. A miss is now distinguishable, so asking is safe and the caller's
 * `onError` does its job.
 *
 * Null only when there is nothing to ask about. A caller still handles it.
 */
export function logoUrl(address: Address, chainId: number): string | null {
  const own = listToken(address, chainId)?.logoURI
  if (own) return own
  const wears = WEARS[address.toLowerCase()]
  if (wears) return `https://gib.show/image/eip155-${wears.chain}/${wears.address}`
  return `https://gib.show/image/eip155-${chainId}/${address}`
}

/**
 * The chain's own mark, by CAIP-2 id. Needs no token list, so it works on a chain the list skips.
 *
 * One caveat the caller has to carry: 369 and 943 answer with the same bytes. gib.show has one
 * PulseChain mark and no separate testnet one, so the icon says which chain family you are on and
 * never which network. The label beside it is what tells them apart.
 */
export const chainLogoUrl = (chainId: number): string => `https://gib.show/image/eip155-${chainId}`

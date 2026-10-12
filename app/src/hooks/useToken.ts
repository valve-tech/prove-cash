import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { cachedToken, tokenInfo, type ChainId, type TokenInfo } from '@prove.cash/sdk'

/**
 * What a token address is, for a surface that was handed one rather than picking it.
 *
 * The sign form always has a `TokenInfo` — the picker produced it. A quote off the board carries
 * two bare addresses, and the decimals matter more here than almost anywhere: a size read at
 * eighteen places when the token holds six is a number a million million times too large.
 *
 * The cache answers first and synchronously, so a token this browser has seen renders on the
 * first frame with no flash. Null means the chain has not answered yet, or would not — and a
 * token the SDK cannot read is a token it refuses to guess about.
 *
 * `chainId` is named by the caller because an address is a different token on a different chain,
 * and the number this hook returns is the one that sizes an offer. A caller reading whatever
 * network the tab points at says so in its own file.
 */
export function useToken(chainId: ChainId, address: Address | null): TokenInfo | null {
  const [token, setToken] = useState<TokenInfo | null>(() =>
    address ? (cachedToken(chainId, address) ?? null) : null,
  )

  useEffect(() => {
    if (!address) {
      setToken(null)
      return
    }
    const known = cachedToken(chainId, address)
    if (known) {
      setToken(known)
      return
    }
    let stale = false
    setToken(null)
    tokenInfo(chainId, address)
      .then((t) => !stale && setToken(t))
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [chainId, address])

  return token
}

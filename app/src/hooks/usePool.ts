import { useEffect, useState } from 'react'
import { marketAddress, type ChainId, type TokenInfo } from '@prove.cash/sdk'
import { loadPool, type PoolRead } from '../lib/pool'

/**
 * One reserve read for a pair, shared by everything that needs it.
 *
 * The sign page has three readers of the same snapshot: the curve the chart draws, the book the
 * other drawings are built from, and — since the form started signing a decay — the price the
 * offer opens at. They must agree. A second read is not only a second round trip on an endpoint
 * that rate-limits per method per second; it is a second answer, and a form that opens its
 * auction against one snapshot while the chart draws another is lying to the maker about their
 * own offer.
 *
 * So the page above reads once, with this, and hands the result down. `SignPreview` and `useBook`
 * both take a read when they are given one and fall back to this hook when they are not, which is
 * what keeps the board page — where nothing above them has read anything — working unchanged.
 *
 * Null means the read has not finished. The three answers a finished read can carry — no market,
 * no pool, unreadable — are distinctions the callers make themselves, because "we could not ask"
 * is not a fact about the market and must never be drawn as one.
 *
 * `chainId` names the chain to read, and the verdict `loadPool` files about that endpoint's
 * health. It is part of the pair key below as well: a pool is a pair on one chain, and an answer
 * from the chain just left must never be drawn for the chain just arrived at.
 */
export function usePoolRead(
  chainId: ChainId,
  tokenIn: TokenInfo | null,
  tokenOut: TokenInfo | null,
): PoolRead | null {
  /*
   * The read carries the pair it answers, and a read for another pair is not returned at all.
   *
   * A `setRead(null)` in the effect is one commit too late: the render where the tokens change
   * still sees the old pair's reserves, and every reader downstream prices or draws that pair for
   * a frame. Keying the state instead makes the stale window unreachable rather than short.
   */
  const [answer, setAnswer] = useState<{ pair: string; read: PoolRead } | null>(null)

  // The market address, not the token address: a wrapper trades as the thing it wraps.
  const inAddr = tokenIn ? marketAddress(tokenIn) : null
  const outAddr = tokenOut ? marketAddress(tokenOut) : null
  const pair =
    inAddr && outAddr && inAddr.toLowerCase() !== outAddr.toLowerCase()
      ? `${chainId}|${inAddr.toLowerCase()}|${outAddr.toLowerCase()}`
      : null

  useEffect(() => {
    if (!inAddr || !outAddr || !pair) return
    let stale = false
    loadPool(chainId, inAddr, outAddr)
      .then((r) => !stale && setAnswer({ pair, read: r }))
      // Not `no-market`. An exception means the read did not finish, which says nothing about
      // whether the chain has a router — and that handler put that sentence on screen for years.
      .catch(() => !stale && setAnswer({ pair, read: { state: 'unreadable' } }))
    return () => {
      stale = true
    }
  }, [chainId, inAddr, outAddr, pair])

  return answer && answer.pair === pair ? answer.read : null
}

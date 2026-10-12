import { useEffect, useState } from 'react'
import {
  getChainId,
  marketAddress,
  queryIntents,
  recordToIntent,
  type TokenInfo,
} from '@prove.cash/sdk'
import type { Intent } from '@prove.cash/sdk'
import { usePoolRead } from '../../hooks/usePool'
import type { PoolRead } from '../../lib/pool'
import { gammaOf, levelsOf, reservesOf, type Level } from './book'

/**
 * One load of the market for a pair, shaped for any drawing of it.
 *
 * Every variant needs the same two things — what the board is holding and where the curve sits —
 * so they are fetched once here rather than once per chart. Switching drawing then costs nothing
 * and shows no flicker, which matters because switching is the whole point of the menu.
 *
 * Both directions of the pair are fetched, because a book needs the offers pointing each way and
 * the store indexes a pair one direction at a time.
 */
/**
 * What the chain said about the pool, kept apart from what it holds.
 *
 * "Absent" and "we could not ask" are different facts and a chart must not merge them. Collapsing
 * a failed read into `reserves: null` had the depth chart print "No PulseX pool trades WPLS for
 * PLSX" over a pool holding 3.8 billion WPLS, because the endpoint had rate-limited the request.
 * A rate limit is not a market structure.
 */
export type PoolState = 'reading' | 'pool' | 'none' | 'failed'

export type Book = {
  levels: Level[]
  /** The live offers behind `levels`. The tape needs each one's own clock, not the merged price. */
  intents: Intent[]
  /** The instant the floors were read at. A decaying offer is only priced against a moment. */
  now: bigint
  /** Pool reserves in whole tokens, base first. Null unless `poolState` is 'pool'. */
  reserves: { x: number; y: number } | null
  gamma: number
  poolState: PoolState
  loading: boolean
}

/** The fee a pool charges when there is no pool to ask. Only scales an absent curve. */
const NO_FEE = 1

/** What the drawings need, out of one reserve read. Pure, so the hook holds no pool state. */
type PoolFacts = { reserves: { x: number; y: number } | null; gamma: number; state: PoolState }

const NO_POOL: PoolFacts = { reserves: null, gamma: NO_FEE, state: 'none' }

/**
 * One reserve read, as the charts want it.
 *
 * The three answers stay apart. 'unreadable' means the chain never answered, so it becomes
 * 'failed'; only 'no-pool' and 'no-market' are statements about the market, and only those may be
 * drawn as one. Reserves that will not match the pair we asked for is a bug here, not an empty
 * market, so that is 'failed' as well.
 */
function poolFacts(
  read: PoolRead | null,
  base: TokenInfo | null,
  quote: TokenInfo | null,
): PoolFacts {
  const inAddr = base ? marketAddress(base) : null
  const outAddr = quote ? marketAddress(quote) : null
  if (!base || !quote || !inAddr || !outAddr || inAddr === outAddr) return NO_POOL
  if (read === null) return { reserves: null, gamma: NO_FEE, state: 'reading' }
  if (read.state !== 'pool') {
    return { reserves: null, gamma: NO_FEE, state: read.state === 'unreadable' ? 'failed' : 'none' }
  }
  const reserves = reservesOf(read.pool, inAddr, base.decimals, outAddr, quote.decimals)
  return { reserves, gamma: gammaOf(read.pool), state: reserves ? 'pool' : 'failed' }
}

export function useBook(
  base: TokenInfo | null,
  quote: TokenInfo | null,
  /**
   * The pool read the page above already made, or absent to make one here. The sign page reads
   * once for the whole screen — the form prices its own decay against the same snapshot the
   * charts draw — and the board page passes nothing, so this hook reads for itself.
   */
  read?: PoolRead | null,
): Book {
  const [levels, setLevels] = useState<Level[]>([])
  const [intents, setIntents] = useState<Intent[]>([])
  const [now, setNow] = useState<bigint>(() => BigInt(Math.floor(Date.now() / 1000)))
  const [loading, setLoading] = useState(false)

  const a = base?.address.toLowerCase()
  const b = quote?.address.toLowerCase()
  const pair = a && b && a !== b ? `${a}|${b}` : null

  useEffect(() => {
    if (!pair || !base || !quote) {
      setLevels([])
      setIntents([])
      return
    }
    const [x, y] = pair.split('|')
    let stale = false
    setLoading(true)
    const liveAt = Math.floor(Date.now() / 1000)
    Promise.all([
      queryIntents({ chainId: getChainId(), pair: `${x}>${y}`, liveAt, limit: 60 }),
      queryIntents({ chainId: getChainId(), pair: `${y}>${x}`, liveAt, limit: 60 }),
    ])
      .then(([one, two]) => {
        if (stale) return
        const live = [...one.rows, ...two.rows].map(recordToIntent)
        setIntents(live)
        setNow(BigInt(liveAt))
        setLevels(levelsOf(live, base, quote, BigInt(liveAt)))
      })
      .catch(() => {
        // A board that will not answer draws as an empty book. The page reports a failed board
        // read in one place already, and a chart is not that place.
        if (!stale) {
          setLevels([])
          setIntents([])
        }
      })
      .finally(() => {
        if (!stale) setLoading(false)
      })
    return () => {
      stale = true
    }
    // `base` and `quote` are keyed by `pair`; adding the objects would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair])

  const own = usePoolRead(getChainId(), read === undefined ? base : null, read === undefined ? quote : null)
  const pool = poolFacts(read === undefined ? own : read, base, quote)

  return {
    levels,
    intents,
    now,
    reserves: pool.reserves,
    gamma: pool.gamma,
    poolState: pool.state,
    loading,
  }
}

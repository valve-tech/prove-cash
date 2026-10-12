import { useCallback, useEffect, useState } from 'react'
import {
  defaultFees,
  feeDefaultsAddress,
  readFeeDefaults,
  type ChainId,
  hashFeeConfig,
  isBundledFeeConfig,
  type CurrentFeeDefaults,
  type DefaultFeeConfig,
} from '@prove.cash/sdk'
import { acknowledgeDefault, defaultHash, type DefaultRead } from '../lib/fee'

type Reader = (chainId: ChainId) => Promise<CurrentFeeDefaults | null>

const readLive: Reader = (chainId) => readFeeDefaults({ chainId })

/**
 * How often an open form asks again. The owner can call `FeeDefaults.setDefaults` at any time, and the
 * settlement emits `DefaultsSet`. A re-read on this interval shows the new default to a form
 * that is already open, so the form signs the current one. It reaches only offers signed after
 * it: a signed offer carries its own sink and rate.
 */
export const DEFAULT_EVERY_MS = 30_000

/**
 * One read. With a `FeeDefaults` deployed on the chain, its `current()` is the answer, and a null
 * answer or a throw is `unread`, never a rate of zero. With none deployed there is nothing to
 * read, and the answer is the registry copy of the defaults (`config.ts`, held to
 * `contracts/config/fee-configs.json` by a test), marked `registry`.
 */
export async function readDefault(
  chainId: ChainId,
  read: Reader = readLive,
  deployed: (id: ChainId) => boolean = (id) => feeDefaultsAddress(id) !== null,
): Promise<DefaultRead> {
  if (!deployed(chainId)) {
    return { state: 'read', def: defaultFees(chainId), source: 'registry' }
  }
  try {
    const def = await read(chainId)
    if (def === null) return { state: 'unread' }
    // A wallet signs the config's destinations, not its hash, so the preimage is kept for signing,
    // but ONLY for a config this build ships. Anything else is the owner's new default or a
    // wrong contract's answer: it is shown with its destinations and signed only after the maker
    // acknowledges it (`acknowledgeDefault`), never silently remembered.
    if (isBundledFeeConfig(hashFeeConfig(def.config), chainId)) {
      const read: DefaultRead = { state: 'read', def, source: 'chain' }
      acknowledgeDefault(read)
      return read
    }
    return { state: 'read', def, source: 'chain', unpinned: true }
  } catch {
    return { state: 'unread' }
  }
}

const sameDef = (a: DefaultFeeConfig, b: DefaultFeeConfig) =>
  hashFeeConfig(a.config) === hashFeeConfig(b.config) &&
  (['handover', 'output', 'proceeds'] as const).every(
    (p) => a.rates[p] === b.rates[p] && a.warn[p] === b.warn[p],
  )

const same = (a: DefaultRead | null, b: DefaultRead) =>
  a !== null &&
  a.state === b.state &&
  (a.state !== 'read' ||
    (b.state === 'read' &&
      b.source === (a as { source: string }).source &&
      sameDef(a.def, b.def)))

/**
 * Read now, then again every `DEFAULT_EVERY_MS`. Reports each answer that differs from the
 * last one. Returns the stop.
 *
 * A failed first read is `unread`. A failed re-read keeps the last answer: one refused request
 * must not shut the sign button for a whole interval. The form signs the default it last read,
 * and shows it before the maker signs.
 */
export function followDefault(
  chainId: ChainId,
  onRead: (read: DefaultRead) => void,
  read: Reader = readLive,
  deployed?: (id: ChainId) => boolean,
): () => void {
  let stopped = false
  let last: DefaultRead | null = null
  const once = async () => {
    const next = await readDefault(chainId, read, deployed)
    if (stopped) return
    if (next.state === 'unread' && last !== null && last.state === 'read') return
    if (same(last, next)) return
    last = next
    onRead(next)
  }
  void once()
  const timer = setInterval(() => void once(), DEFAULT_EVERY_MS)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/**
 * The chain's fee defaults, followed per chain.
 *
 * An offer that names no sink signs the default sink and its default rate as its own terms
 * (`feeTerms`). The form reads the default here and shows it before the maker signs. A failed
 * read is `unread`, never a rate of zero.
 */
export function useFeeDefaults(chainId: ChainId): DefaultRead {
  const [answer, setAnswer] = useState<{ chainId: ChainId; read: DefaultRead } | null>(null)

  useEffect(() => followDefault(chainId, (read) => setAnswer({ chainId, read })), [chainId])

  // An answer for the chain just left is not an answer for this one.
  return answer !== null && answer.chainId === chainId ? answer.read : { state: 'reading' }
}

/**
 * The acknowledgement of an unshipped default, for a form. Holds the hash the maker acknowledged,
 * so a new default asks again, and `ack` remembers that config's preimage for the wallet.
 */
export function useAcknowledgedDefault(read: DefaultRead): [string | null, () => void] {
  const [acked, setAcked] = useState<string | null>(null)
  const ack = useCallback(() => {
    const h = defaultHash(read)
    if (h === null) return
    acknowledgeDefault(read)
    setAcked(h)
  }, [read])
  return [acked, ack]
}

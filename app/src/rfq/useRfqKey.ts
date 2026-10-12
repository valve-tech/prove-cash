import { useCallback, useEffect, useState } from 'react'
import type { Address } from 'viem'
import {
  deriveRfqKeyPair,
  postRfqKey,
  RFQ_KEY_MESSAGE,
  rfqKeyAnnouncementMessage,
  type RfqKeyPair,
} from '@prove.cash/sdk'
import { boardClient } from '../lib/board'
import { errorLine } from '../lib/errors'
import { signMessage } from '../lib/wallet'

/**
 * The counterparty's encryption key: derived on demand, held in memory, never stored.
 *
 * A quote sealed to you can only be opened with the secret half, and a browser wallet will not
 * hand over a private key or do ECDH on your behalf — `eth_decrypt` was the one route and
 * MetaMask deprecated it. So the key is derived instead: sign one fixed string, run the signature
 * through HKDF, and out comes an x25519 pair. `sdk/src/rfq-crypto.ts` says why at length.
 *
 * **Nothing here persists it, and the omission is deliberate.** `localStorage` would turn a key
 * that can be re-derived in one signature into a key that can be stolen by any script that ever
 * runs on this origin. Re-deriving costs one wallet prompt per tab; that is the whole price, and
 * it is the right one.
 *
 * The pair is dropped when the account changes. A key derived from one wallet's signature opens
 * nothing addressed to another, and holding it would mean a reader silently trying the wrong key
 * against every sealed message on the board.
 */
export type RfqKeyState = {
  pair: RfqKeyPair | null
  /** True while a wallet prompt is open, for either signature. */
  busy: boolean
  /** The last failure, in the wallet's own words. Null once something succeeds. */
  error: string | null
  /** The board hash of the announcement this tab posted, if it posted one. */
  announced: string | null
  unlock: () => Promise<void>
  /** Derive if needed, then put the public half on the board so a maker can seal to it. */
  publish: () => Promise<void>
}

export function useRfqKey(account: Address | null): RfqKeyState {
  const [pair, setPair] = useState<RfqKeyPair | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [announced, setAnnounced] = useState<string | null>(null)

  // Another wallet is another key. Drop both halves rather than test them against messages they
  // were never meant to open.
  useEffect(() => {
    setPair(null)
    setAnnounced(null)
    setError(null)
  }, [account])

  const derive = useCallback(
    async (from: Address): Promise<RfqKeyPair> => {
      if (pair) return pair
      const signature = await signMessage(from, RFQ_KEY_MESSAGE)
      const next = deriveRfqKeyPair(signature)
      setPair(next)
      return next
    },
    [pair],
  )

  const unlock = useCallback(async () => {
    if (!account || busy) return
    setBusy(true)
    setError(null)
    try {
      await derive(account)
    } catch (e) {
      setError(errorLine(e))
    } finally {
      setBusy(false)
    }
  }, [account, busy, derive])

  const publish = useCallback(async () => {
    if (!account || busy) return
    setBusy(true)
    setError(null)
    try {
      const keys = await derive(account)
      /*
       * The announcement proves an address rather than claiming one.
       *
       * The wire carries the key, a timestamp and a signature over both, and no address field at
       * all — a reader recovers the signer. That is what makes forgery useless: binding somebody
       * else's address to your key would mean forging an ECDSA signature under their key.
       */
      const issuedAt = BigInt(Math.floor(Date.now() / 1000))
      const signature = await signMessage(
        account,
        rfqKeyAnnouncementMessage(keys.publicKey, issuedAt),
      )
      const hash = await postRfqKey(keys.publicKey, issuedAt, signature, boardClient())
      setAnnounced(hash)
    } catch (e) {
      setError(errorLine(e))
    } finally {
      setBusy(false)
    }
  }, [account, busy, derive])

  return { pair, busy, error, announced, unlock, publish }
}

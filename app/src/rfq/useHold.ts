import { createContext, useContext, useEffect, useId } from 'react'

/**
 * The RFQ surfaces' share of the app's network lock.
 *
 * `Compose` tells `App` it is busy through `onBusy`, and `App` disables the network menu while it
 * is. Every RFQ flow signs and sends in several steps too, and a chain switch between two of them
 * sends an intent built for one chain to another chain's contracts. So each RFQ surface reports
 * its own `working` here, and `Rfq` holds the menu while any of them is working.
 *
 * A set, not a flag: the inbox draws one card per quote, and an idle card that mounts must not
 * release the lock a working card holds.
 */
export type Hold = (id: string, busy: boolean) => void

export const HoldContext = createContext<Hold | null>(null)

/** Hold the network menu while `working` is true, and release it on unmount. */
export function useHold(working: boolean) {
  const hold = useContext(HoldContext)
  const id = useId()
  useEffect(() => {
    hold?.(id, working)
  }, [hold, id, working])
  useEffect(() => () => hold?.(id, false), [hold, id])
}

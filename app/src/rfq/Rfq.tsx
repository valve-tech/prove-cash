import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address } from 'viem'
import { NETWORKS, type ChainId } from '@prove.cash/sdk'
import { useNow } from '../hooks/useBoard'
import { errorLine } from '../lib/errors'
import { t } from '../lib/i18n'
import { MakeQuote } from './MakeQuote'
import { QuoteInbox } from './QuoteInbox'
import { SettleQuote } from './SettleQuote'
import { readRfqBoard, type RfqBoard } from './board'
import type { Ticket } from './ticket'
import { useRfqKey } from './useRfqKey'
import { HoldContext, type Hold } from './useHold'
import { rfqVenue } from './venue'

/**
 * Exclusive quotes, end to end: make one, accept one, settle one.
 *
 * Three surfaces and one board read, which is why they share a parent. All three live on the same
 * msgboard category — `PROVECASH_RFQ_CATEGORY`, never the one the order book reads, so a quote
 * cannot appear in the public book — and all three need the same two things off it: the quotes
 * themselves, and the encryption keys addresses have announced. Reading it three times would cost
 * three round trips and could give three answers.
 *
 * The secret key lives here too and goes no further than the read. It opens the sealed quotes,
 * `useRfqKey` never stores it, and the inbox gets the controls rather than the bytes.
 */

const SECTIONS = ['make', 'inbox', 'settle'] as const
type Section = (typeof SECTIONS)[number]

const SECTION_FACE: Record<Section, 'rfq.tab.make' | 'rfq.tab.inbox' | 'rfq.tab.settle'> = {
  make: 'rfq.tab.make',
  inbox: 'rfq.tab.inbox',
  settle: 'rfq.tab.settle',
}

const EMPTY: RfqBoard = { quotes: [], keys: new Map(), lockedForMe: 0, unreadableForMe: 0 }

export function Rfq({
  account,
  chainId,
  onConnect,
  onBusy,
}: {
  account: Address | null
  chainId: ChainId
  onConnect: () => Promise<void>
  /** True while any RFQ flow is mid-sign. `App` disables the network menu, as it does for Compose. */
  onBusy?: (busy: boolean) => void
}) {
  const working = useRef(new Set<string>())
  const hold = useCallback<Hold>(
    (id, busy) => {
      if (busy) working.current.add(id)
      else working.current.delete(id)
      onBusy?.(working.current.size > 0)
    },
    [onBusy],
  )
  const [section, setSection] = useState<Section>('inbox')
  const [board, setBoard] = useState<RfqBoard>(EMPTY)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [handover, setHandover] = useState<Ticket | null>(null)
  const rfqKey = useRfqKey(account)
  const now = useNow()
  const venue = rfqVenue(chainId)
  const secretKey = rfqKey.pair?.secretKey ?? null

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setBoard(await readRfqBoard(account, secretKey))
    } catch (e) {
      setError(errorLine(e))
    } finally {
      setLoading(false)
    }
  }, [account, secretKey])

  // One read on arrival, and again whenever the reader, the key or the chain changes. No poll: a
  // quote is firm for minutes, the refresh button is right there, and a category read is the
  // whole category every time.
  useEffect(() => {
    if (!venue) return
    void refresh()
  }, [refresh, venue, chainId])

  // A pair handed over from the inbox opens the surface that can send it.
  const settleThis = (ticket: Ticket) => {
    setHandover(ticket)
    setSection('settle')
  }

  if (!venue) {
    return (
      <div className="mx-auto w-full max-w-md lg:max-w-2xl">
        <p className="gutter text-xs text-(--color-unproven)">
          {t('rfq.venue.missing', { network: NETWORKS[chainId].label })}
        </p>
      </div>
    )
  }

  // A column of cards. They carry the padding, so the column carries none. The hold context
  // lets each RFQ surface lock the network menu while it signs; see `useHold`.
  return (
    <HoldContext.Provider value={hold}>
    <div className="mx-auto w-full max-w-md lg:max-w-2xl grid grid-cols-[minmax(0,1fr)] gap-2 min-w-0">
      <h2 className="sr-only">{t('rfq.title')}</h2>
      <p className="gutter text-[11px] leading-relaxed text-(--color-dim)">{t('rfq.intro')}</p>

      <div
        role="group"
        aria-label={t('rfq.tab.group')}
        className="gutter flex items-center gap-0.5 text-xs">
        <span className="flex items-center gap-0.5 p-0.5 rounded-lg bg-(--color-panel-2)">
          {SECTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSection(s)}
              aria-pressed={section === s}
              className={`px-2 py-1 rounded-md transition-colors ${
                section === s
                  ? 'text-(--color-bright) bg-(--color-line)'
                  : 'text-(--color-dim) hover:text-(--color-body)'
              }`}>
              {t(SECTION_FACE[s])}
            </button>
          ))}
        </span>
      </div>

      {error && (
        <p role="alert" className="gutter text-[11px] text-(--color-danger) break-all">
          {error}
        </p>
      )}

      {section === 'make' ? (
        <MakeQuote
          account={account}
          venue={venue}
          keys={board.keys}
          onPosted={() => void refresh()}
          onConnect={onConnect}
        />
      ) : section === 'inbox' ? (
        <QuoteInbox
          account={account}
          venue={venue}
          board={board}
          rfqKey={rfqKey}
          now={now}
          loading={loading}
          onRefresh={() => void refresh()}
          onConnect={onConnect}
          onSettle={settleThis}
        />
      ) : (
        <SettleQuote account={account} venue={venue} prefill={handover} onConnect={onConnect} />
      )}
    </div>
    </HoldContext.Provider>
  )
}

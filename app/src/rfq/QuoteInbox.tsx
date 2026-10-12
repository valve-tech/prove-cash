import type { Address } from 'viem'
import { Chip } from '../components/fields'
import { t, tCount } from '../lib/i18n'
import type { RfqBoard } from './board'
import { quotesFor } from './board'
import { QuoteCard } from './QuoteCard'
import type { Ticket } from './ticket'
import type { RfqKeyState } from './useRfqKey'

/**
 * Every quote named for you, and the key that lets a maker name one privately.
 *
 * Two things share this surface because they are one job. A quote in the clear is readable by
 * anybody watching the board — the size, the price, the maker and both signatures. A quote sealed
 * to your key is readable by you alone, and a maker cannot seal one until you have published a
 * key to seal to. So the control that publishes it sits above the list it fills.
 *
 * **The list is what the board holds, not a mailbox.** There is no server keeping your quotes and
 * no account to hold them under: this reads the RFQ category, keeps the messages whose binding
 * names your address, and drops the rest. A maker who quoted you an hour ago and a stranger's
 * quote to somebody else arrive by exactly the same route.
 */
export function QuoteInbox({
  account,
  venue,
  board,
  rfqKey: keyState,
  now,
  loading,
  onRefresh,
  onConnect,
  onSettle,
}: {
  account: Address | null
  venue: Address
  board: RfqBoard
  /** Derive, hold and announce the x25519 key. Not `key`: React reserves that prop name. */
  rfqKey: RfqKeyState
  now: bigint
  loading: boolean
  onRefresh: () => void
  onConnect: () => Promise<void>
  onSettle: (ticket: Ticket) => void
}) {
  const mine = quotesFor(board.quotes, account)
  const published = account ? board.keys.get(account.toLowerCase() as Address) : undefined

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2 min-w-0">
      <h3 className="sr-only">{t('rfq.inbox.title')}</h3>

      {/*
        The key panel. It says one of three things: publish so makers can seal to you, unlock so
        this tab can read what they sealed, or nothing more to do.
      */}
      <div className="panel p-2 sm:p-4 grid gap-2">
        <p className="text-[11px] leading-relaxed text-(--color-dim)">
          {keyState.pair
            ? t('rfq.key.unlocked')
            : published
              ? t('rfq.key.publishedElsewhere')
              : t('rfq.key.none')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {!account ? (
            <Chip mono={false} selected={false} onClick={() => void onConnect().catch(() => {})}>
              {t('wallet.connect')}
            </Chip>
          ) : (
            <>
              {!keyState.pair && (
                <Chip
                  mono={false}
                  selected={false}
                  disabled={keyState.busy}
                  onClick={() => void keyState.unlock()}>
                  {keyState.busy ? t('rfq.key.working') : t('rfq.key.unlock')}
                </Chip>
              )}
              <Chip
                mono={false}
                selected={!!keyState.announced}
                disabled={keyState.busy}
                onClick={() => void keyState.publish()}>
                {keyState.announced ? t('rfq.key.done') : t('rfq.key.publish')}
              </Chip>
            </>
          )}
          <Chip mono={false} selected={false} disabled={loading} onClick={onRefresh}>
            {loading ? t('rfq.inbox.loading') : t('rfq.inbox.refresh')}
          </Chip>
        </div>
        {keyState.error && (
          <p role="alert" className="text-[11px] text-(--color-danger) break-all">
            {keyState.error}
          </p>
        )}
        {board.lockedForMe > 0 && !keyState.pair && (
          <p className="num text-[11px] text-(--color-unproven)">
            {tCount('rfq.inbox.locked', board.lockedForMe)}
          </p>
        )}
        {/*
          Sealed to this reader, tried with the key this tab holds, and refused. Unlocking is not
          the answer — the reader has unlocked — so this line says what happened instead of
          repeating the one above it.
        */}
        {board.unreadableForMe > 0 && (
          <p className="num text-[11px] text-(--color-danger)">
            {tCount('rfq.inbox.unreadable', board.unreadableForMe)}
          </p>
        )}
      </div>

      {!account ? (
        <p className="gutter text-xs text-(--color-dim)">{t('rfq.inbox.connect')}</p>
      ) : mine.length === 0 ? (
        <p className="gutter text-xs text-(--color-dim)">
          {loading ? t('rfq.inbox.loading') : t('rfq.inbox.empty')}
        </p>
      ) : (
        mine.map((read) => (
          <QuoteCard
            key={read.msgHash}
            read={read}
            venue={venue}
            account={account}
            now={now}
            onSettle={onSettle}
          />
        ))
      )}
    </div>
  )
}

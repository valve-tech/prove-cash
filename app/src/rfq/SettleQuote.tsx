import { useEffect, useState } from 'react'
import type { Address, Hex } from 'viem'
import {
  displaySymbol,
  formatFeeRate,
  exclusiveQuoteCost,
  getChainId,
  maxFeeRateFor,
  RFQ_VENUE_ABI,
  settleExclusiveCall,
  waitForTx,
} from '@prove.cash/sdk'
import { units } from '../lib/amount'
import { Chip } from '../components/fields'
import { TokenUnit } from '../components/TokenAvatar'
import { useToken } from '../hooks/useToken'
import { errorLine } from '../lib/errors'
import { getLocale, t } from '../lib/i18n'
import { browserWallet } from '../lib/wallet'
import { decodeTicket, encodeTicket, type Ticket } from './ticket'
import { useHold } from './useHold'

/**
 * Submit a signed pair, pay the gas, keep the spread.
 *
 * Anybody may do this. The maker signed a price for one address and that address signed the
 * mirror; neither of them has sent a transaction, and the venue does not care who sends this one.
 * What is left over — the token A the counterparty did not ask for, and any token B beyond what
 * the quote requires — is swept to `msg.sender` by `RfqVenue._sweepAbove`. That is the whole of
 * the incentive, and it is why a pair with no spread will sit unsubmitted until its counterparty
 * submits it themselves.
 *
 * **`maxFeeRate` is the submitter's own bound and it is not optional.** The settlement steps over
 * a leg whose rate is above it, so a bound below the quote's own rate turns the ring into a
 * one-leg fill and the venue reverts with `LegCountMismatch`. `maxFeeRateFor` reads the highest
 * rate the two legs charge, which for an exclusive quote is the quote's own — the exclusivity fee
 * is an ordinary `Intent.feeRate` now, and the venue charges nothing on top of it.
 */
type Phase = 'idle' | 'sending' | 'mining' | 'done' | 'error'

export function SettleQuote({
  account,
  venue,
  prefill,
  onConnect,
}: {
  account: Address | null
  venue: Address
  /** A pair handed over from the accept surface. Null when the reader arrived with a clipboard. */
  prefill: Ticket | null
  onConnect: () => Promise<void>
}) {
  // Seeded from the hand-over rather than filled in by an effect, so a pair arriving from the
  // inbox is already in the box on the first frame and the preview never flashes empty.
  const [text, setText] = useState(() => (prefill ? encodeTicket(prefill, getChainId()) : ''))
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)

  // A pair handed over from the inbox lands in the box as text, so the reader sees exactly what a
  // stranger would paste and can copy it out again.
  useEffect(() => {
    if (prefill) setText(encodeTicket(prefill, getChainId()))
  }, [prefill])

  const ticket = text.trim() === '' ? null : decodeTicket(text)
  const unreadable = text.trim() !== '' && ticket === null

  const tokenA = useToken(getChainId(), ticket?.quote.intent.tokenIn ?? null)
  const tokenB = useToken(getChainId(), ticket?.quote.intent.tokenOut ?? null)

  const working = phase === 'sending' || phase === 'mining'
  useHold(working)

  async function submit() {
    if (!account) {
      setMessage(null)
      try {
        await onConnect()
      } catch (e) {
        setPhase('error')
        setMessage(errorLine(e) || t('wallet.failed'))
      }
      return
    }
    if (!ticket || working) return
    const chainId = getChainId()
    setMessage(null)
    try {
      setPhase('sending')
      const call = settleExclusiveCall(
        venue,
        ticket.quote,
        ticket.mirror,
        ticket.take,
        maxFeeRateFor([ticket.quote.intent, ticket.mirror]),
      )
      const wallet = await browserWallet(chainId)
      const hash = (await wallet.writeContract({
        account,
        address: call.address,
        abi: RFQ_VENUE_ABI,
        functionName: call.functionName,
        args: call.args,
      } as never)) as Hex
      setPhase('mining')
      await waitForTx(hash, { chainId })
      setPhase('done')
      setMessage(hash)
    } catch (e) {
      setPhase('error')
      setMessage(errorLine(e))
    }
  }

  const buttonLabel = !account
    ? t('wallet.connect')
    : phase === 'sending'
      ? t('rfq.settle.sending')
      : phase === 'mining'
        ? t('rfq.settle.mining')
        : !ticket
          ? t('rfq.settle.need')
          : t('rfq.settle.go')

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2 min-w-0">
      <h3 className="sr-only">{t('rfq.settle.title')}</h3>

      <div className="panel p-2 sm:p-4 grid gap-2">
        <label htmlFor="rfq-ticket" className="text-[11px] uppercase tracking-wider text-(--color-dim)">
          {t('rfq.settle.paste')}
        </label>
        <textarea
          id="rfq-ticket"
          className="field num text-[11px] break-all"
          rows={5}
          spellCheck={false}
          value={text}
          aria-invalid={unreadable ? true : undefined}
          aria-describedby={unreadable ? 'rfq-ticket-error' : undefined}
          onChange={(e) => setText(e.target.value)}
        />
        {unreadable && (
          <p id="rfq-ticket-error" role="alert" className="text-[11px] text-(--color-danger)">
            {t('rfq.settle.invalid')}
          </p>
        )}
        {/* A chip hugs its words. A grid child stretches, so the row is what holds it. */}
        {text.trim() !== '' && (
          <div className="flex flex-wrap items-center gap-2">
            <Chip mono={false} selected={false} onClick={() => setText('')}>
              {t('rfq.settle.clear')}
            </Chip>
          </div>
        )}
      </div>

      {ticket && <Preview ticket={ticket} tokenA={tokenA} tokenB={tokenB} />}

      {/* The row reaches both edges, so nothing in it carries a corner. See `.btn-block`. */}
      <div className="mt-1 flex items-center gap-px">
        <button
          className="btn btn-primary btn-block flex-1"
          disabled={(!!account && !ticket) || working}
          onClick={submit}>
          {buttonLabel}
        </button>
      </div>

      <p role="status" className="sr-only">
        {working ? buttonLabel : phase === 'done' ? t('rfq.settle.done.spoken') : ''}
      </p>
      {phase === 'done' && message && (
        <p className="gutter num text-xs text-(--color-proven) break-all text-center">
          {t('rfq.settle.done', { hash: message })}
        </p>
      )}
      {phase === 'error' && message && (
        <p role="alert" className="gutter text-xs text-(--color-danger) break-all text-center">
          {message}
        </p>
      )}
    </div>
  )
}

/** What the pair pays, and what is left over for whoever sends it. */
function Preview({
  ticket,
  tokenA,
  tokenB,
}: {
  ticket: Ticket
  tokenA: ReturnType<typeof useToken>
  tokenB: ReturnType<typeof useToken>
}) {
  const { quote, mirror } = ticket
  // Priced at the binding's own deadline rather than at this second. The quote is flat, so the
  // two agree; a decaying one would deliver less later, and the pessimistic end is the one a
  // submitter must be able to cover.
  //
  // `needsB` is the gross and the fee is inside it. It used to be `delivered + fee`, because the
  // fee rode on top of the maker's number; now it comes out of it, and adding the two would have
  // the submitter cover the fee twice and read the spread as smaller than it is.
  const cost = exclusiveQuoteCost(quote, quote.exclusive.expiry - 1n)
  const needsB = cost.gross
  // Floored at zero. A mirror asking for more than the quote holds is refused on chain, and a
  // negative figure here would read as the submitter owing money rather than as a dead pair.
  const keepsA = quote.exclusive.take > mirror.minOutEnd ? quote.exclusive.take - mirror.minOutEnd : 0n
  const keepsB = mirror.amountIn > needsB ? mirror.amountIn - needsB : 0n
  const symA = tokenA ? displaySymbol(tokenA) : t('rfq.token.unknown')
  const symB = tokenB ? displaySymbol(tokenB) : t('rfq.token.unknown')

  return (
    <dl className="panel p-2 sm:p-4 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
      <dt className="text-(--color-dim)">{t('rfq.settle.pair')}</dt>
      <dd className="num text-end text-(--color-bright) break-all">
        <span className="ltr" aria-hidden="true">
          {symA} → {symB}
        </span>
        <span className="sr-only">{t('rfq.quote.pair.spoken', { in: symA, out: symB })}</span>
      </dd>
      <dt className="text-(--color-dim)">{t('rfq.settle.size')}</dt>
      <dd className="num flex flex-wrap items-center justify-end gap-x-1 text-(--color-bright) break-all">
        <span>{tokenA ? units(quote.exclusive.take, tokenA.decimals) : '…'}</span>
        {tokenA ? <TokenUnit token={tokenA} /> : <span>{symA}</span>}
      </dd>
      <dt className="text-(--color-dim)">{t('rfq.settle.rate')}</dt>
      <dd className="num text-end text-(--color-body)">
        {formatFeeRate(maxFeeRateFor([quote.intent, mirror]))}%
      </dd>
      <dt className="text-(--color-dim)">{t('rfq.settle.keeps')}</dt>
      <dd className="num flex flex-wrap items-center justify-end gap-x-1 text-(--color-proven) break-all">
        <span>{tokenA ? units(keepsA, tokenA.decimals) : '…'}</span>
        {tokenA ? <TokenUnit token={tokenA} /> : <span>{symA}</span>}
        <span>·</span>
        <span>{tokenB ? units(keepsB, tokenB.decimals) : '…'}</span>
        {tokenB ? <TokenUnit token={tokenB} /> : <span>{symB}</span>}
      </dd>
      <dt className="text-(--color-dim)">{t('rfq.settle.deadline')}</dt>
      {/*
        A time is read, so it is written the way the reader's language writes one. The month and
        the clock come from the browser's own data, which is why this is the active locale rather
        than a dictionary key.
      */}
      <dd className="num text-end text-(--color-body)">
        {new Date(Number(quote.exclusive.expiry) * 1000).toLocaleTimeString(getLocale())}
      </dd>
    </dl>
  )
}

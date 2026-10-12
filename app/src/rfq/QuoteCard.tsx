import { useEffect, useState } from 'react'
import { formatUnits, type Address } from 'viem'
import {
  checkExclusiveQuote,
  displaySymbol,
  exclusiveQuoteCost,
  FLAG_ESCROW,
  FLAG_PERMIT2,
  formatFeeRate,
  getChainId,
  MIRROR_TTL,
  mirrorFor,
  parse,
  type QuoteFault,
  type SignedIntent,
} from '@prove.cash/sdk'
import { CustodyLadder } from '../components/CustodyLadder'
import { Chip } from '../components/fields'
import { TokenAvatar, TokenUnit } from '../components/TokenAvatar'
import { useCustody } from '../hooks/useCustody'
import { useToken } from '../hooks/useToken'
import { amountError, normalizeAmount, units } from '../lib/amount'
import { signAndArm } from '../lib/arm'
import { RUNGS, walletCustody } from '../lib/custody'
import { errorLine } from '../lib/errors'
import { num, t } from '../lib/i18n'
import type { ReadQuote } from './board'
import { FAULT_KEY } from './quote'
import { useHold } from './useHold'
import { encodeTicket, type Ticket } from './ticket'
import { ChevronIcon } from '../components/ChevronIcon'

/**
 * One quote addressed to you, checked, priced, and accepted with a signature.
 *
 * The order matters and it is the SDK's, not this component's. `checkExclusiveQuote` proves the
 * maker really signed the quote, that the quote can only settle at this venue, that the binding
 * names this intent and this address, and that the size is one the terms allow. Nothing here
 * signs until that comes back empty, and every reason it can come back with is
 * {@link FAULT_KEY} — this file invents no vocabulary of its own for what is wrong with a quote.
 *
 * **Accepting costs a signature and no transaction, on the right rung.** The mirror is an
 * ordinary intent, so the counterparty pays for it the same five ways a maker pays for an offer,
 * and the ladder below is the same ladder. On the two allowance rungs it is a signature plus at
 * most one approval; on the other three it is signatures only.
 */
type Phase = 'idle' | 'signing' | 'authorizing' | 'approving' | 'depositing' | 'done' | 'error'

export function QuoteCard({
  read,
  venue,
  account,
  now,
  onSettle,
}: {
  read: ReadQuote
  venue: Address
  account: Address
  /** Seconds, ticking. The expiry is a countdown and the price is read against this. */
  now: bigint
  /** Hand the signed pair to the settle surface, for a counterparty who submits their own. */
  onSettle: (ticket: Ticket) => void
}) {
  const q = read.quote
  const { intent, exclusive: ex } = q
  const tokenA = useToken(getChainId(), intent.tokenIn)
  const tokenB = useToken(getChainId(), intent.tokenOut)

  const [open, setOpen] = useState(false)
  const [faults, setFaults] = useState<QuoteFault[] | null>(null)
  const [wantsText, setWantsText] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [copied, setCopied] = useState(false)

  /*
   * What the quote costs, and how the settlement splits it, both at this second.
   *
   * `sells` is the least token B the ring can close on — the quote's gross. Paying more than
   * this is not generosity: `RfqVenue._sweepAbove` hands the surplus to whoever submits.
   *
   * **The fee is inside `sells`, not beside it.** It used to be `delivered + fee`, an outlay
   * with the exclusivity fee added on top and paid out of the counterparty's spread. Now the
   * fee comes out of the maker's own number, so the counterparty pays the gross and nothing
   * more, and the maker banks `cost.delivered`.
   */
  const cost = exclusiveQuoteCost(q, now)
  const sells = cost.gross

  // The most the counterparty can ask for, which is the whole size the binding releases. Anything
  // they leave under it is the spread that pays a submitter for the gas.
  const maxWants = ex.take

  const wantsError = amountError(wantsText, tokenA?.decimals)
  let wantsWei = 0n
  try {
    if (tokenA && !wantsError && Number(wantsText) > 0) wantsWei = parse(wantsText, tokenA.decimals)
  } catch {
    /* not a parseable amount yet */
  }
  const overAsking = wantsWei > maxWants
  const spread = overAsking ? 0n : maxWants - wantsWei

  const { ctx, mode, setCustody, needsApproval, live } = useCustody(account, tokenB, sells)

  // The check, re-run when the quote, the venue or the reader changes — never on the clock. A
  // second's tick cannot change a signature, and `expired` is drawn from `now` below instead.
  useEffect(() => {
    let stale = false
    setFaults(null)
    checkExclusiveQuote(q, venue, account, BigInt(Math.floor(Date.now() / 1000)))
      .then((f) => !stale && setFaults(f))
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [read.msgHash, venue, account, q])

  // The default ask is the whole size. A counterparty who wants somebody else to pay the gas
  // types a smaller number, and the line under the field says what that buys.
  useEffect(() => {
    // Only while the field is untouched. The token can resolve after the reader has typed, and
    // overwriting their number at that moment would be the worst possible time to do it.
    if (tokenA) setWantsText((typed) => (typed === '' ? formatUnits(maxWants, tokenA.decimals) : typed))
  }, [tokenA, maxWants])

  const expired = now >= ex.expiry
  const secondsLeft = expired ? 0n : ex.expiry - now
  const checking = faults === null
  const clean = faults !== null && faults.length === 0
  const working =
    phase === 'signing' || phase === 'authorizing' || phase === 'approving' || phase === 'depositing'
  useHold(working)
  // `live` for the reason the sign form carries it: accepting a quote signs the mirror intent, and
  // one signed on a chain with no settlement names `verifyingContract` of zero.
  const canSign =
    clean && live && !expired && !!tokenA && !!tokenB && wantsWei > 0n && !overAsking && !working

  const symA = tokenA ? displaySymbol(tokenA) : t('rfq.token.unknown')
  const symB = tokenB ? displaySymbol(tokenB) : t('rfq.token.unknown')

  async function accept() {
    if (!canSign || !tokenA || !tokenB) return
    const chainId = getChainId()
    setMessage(null)
    try {
      /*
       * The mirror, built by the SDK and not by this form.
       *
       * `mirrorFor` is what puts the venue in the mirror's `executor`, and that is not a detail:
       * a mirror with an open executor is an ordinary public order at the counterparty's rate,
       * fillable by anybody on the settlement without ever showing the maker's side. Its window
       * is short for the same reason a quote's is — whoever may submit last holds a free option
       * worth the price drift, and the counterparty pays for it.
       */
      const mirror = mirrorFor(
        q,
        venue,
        account,
        sells,
        wantsWei,
        BigInt(Date.now()),
        mode === 'permit2' ? FLAG_PERMIT2 : walletCustody(mode) ? 0 : FLAG_ESCROW,
        MIRROR_TTL,
      )
      const signed: SignedIntent = await signAndArm({
        account,
        intent: mirror,
        mode,
        live,
        needsApproval,
        fundsFrom: mirror.startTime,
        onPhase: setPhase,
        chainId,
      })
      setTicket({ quote: q, mirror: signed, take: mirror.amountIn })
      setPhase('done')
    } catch (e) {
      const text = errorLine(e)
      setPhase(text === 'cancelled' ? 'idle' : 'error')
      if (text !== 'cancelled') setMessage(text)
    }
  }

  const buttonLabel = working
    ? phase === 'signing'
      ? t('sign.phase.signing')
      : phase === 'authorizing'
        ? t('sign.phase.authorizing')
        : phase === 'approving'
          ? t('sign.phase.approving')
          : t('sign.phase.depositing')
    : t('rfq.accept.go')

  // Square, outlined by an outset shadow: this card reaches the edge of a 375px screen.
  return (
    <article className="panel p-2 sm:p-4 grid gap-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {tokenA && <TokenAvatar token={tokenA} size={18} />}
        <span className="text-sm font-medium text-(--color-bright)">
          {/* An expression, so it holds its own direction. See `.ltr` in index.css. */}
          <span className="ltr" aria-hidden="true">
            {symA} → {symB}
          </span>
          <span className="sr-only">{t('rfq.quote.pair.spoken', { in: symA, out: symB })}</span>
        </span>
        {read.sealed && (
          <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-(--color-panel-2) text-(--color-proven)">
            {t('rfq.quote.sealed')}
          </span>
        )}
        <span
          className={`num ms-auto text-[11px] ${expired ? 'text-(--color-danger)' : 'text-(--color-dim)'}`}>
          {expired
            ? t('rfq.quote.expired')
            : t('rfq.quote.firmFor', { seconds: num(secondsLeft) })}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <dt className="text-(--color-dim)">{t('rfq.quote.theyPay')}</dt>
        <dd className="num flex flex-wrap items-center justify-end gap-x-1 text-(--color-bright) break-all">
          <span>{tokenA ? units(ex.take, tokenA.decimals) : '…'}</span>
          {tokenA ? <TokenUnit token={tokenA} /> : <span>{symA}</span>}
        </dd>
        <dt className="text-(--color-dim)">{t('rfq.quote.youPay')}</dt>
        <dd className="num flex flex-wrap items-center justify-end gap-x-1 text-(--color-bright) break-all">
          <span>{tokenB ? units(sells, tokenB.decimals) : '…'}</span>
          {tokenB ? <TokenUnit token={tokenB} /> : <span>{symB}</span>}
        </dd>
        {/*
          What the maker walks away with, which is no longer the same as what you pay. It sits
          directly under "you give" so the subtraction reads in the order the money moves.
        */}
        <dt className="text-(--color-dim)">{t('rfq.quote.theyGet')}</dt>
        <dd className="num flex flex-wrap items-center justify-end gap-x-1 text-(--color-body) break-all">
          <span>{tokenB ? units(cost.delivered, tokenB.decimals) : '…'}</span>
          {tokenB ? <TokenUnit token={tokenB} /> : <span>{symB}</span>}
        </dd>
        <dt className="text-(--color-dim)">{t('rfq.quote.fee')}</dt>
        <dd className="num flex flex-wrap items-center justify-end gap-x-1 text-(--color-body) break-all">
          <span>{tokenB ? units(cost.fee, tokenB.decimals) : '…'}</span>
          {tokenB ? <TokenUnit token={tokenB} /> : <span>{symB}</span>}
          <span>· {formatFeeRate(cost.rate)}%</span>
        </dd>
        <dt className="text-(--color-dim)">{t('rfq.quote.maker')}</dt>
        <dd className="num addr text-end text-(--color-body) break-all">{intent.maker}</dd>
      </dl>

      {checking ? (
        <p className="text-[11px] text-(--color-dim)">{t('rfq.check.running')}</p>
      ) : clean ? (
        <p className="text-[11px] text-(--color-proven)">{t('rfq.check.clean')}</p>
      ) : (
        <div role="alert" className="grid gap-0.5">
          <p className="text-[11px] font-medium text-(--color-danger)">{t('rfq.check.faults')}</p>
          <ul className="grid gap-0.5">
            {faults.map((f) => (
              <li key={f} className="text-[11px] text-(--color-danger)">
                {t(FAULT_KEY[f])}
              </li>
            ))}
          </ul>
        </div>
      )}

      {clean && !expired && !ticket && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={`rfq-accept-${read.msgHash}`}
          className="text-[11px] text-(--color-body) hover:text-(--color-bright) text-start transition-colors">
          {t('rfq.accept.open')} <span aria-hidden="true"><ChevronIcon up={open} /></span>
        </button>
      )}

      {open && clean && !expired && !ticket && (
        // The card pads; a section inside it separates with a hairline instead of padding again.
        <div id={`rfq-accept-${read.msgHash}`} className="rule-t pt-3 grid gap-2">
          <label
            htmlFor={`rfq-wants-${read.msgHash}`}
            className="text-[11px] uppercase tracking-wider text-(--color-dim)">
            {t('rfq.accept.wants', { symbol: symA })}
          </label>
          <input
            id={`rfq-wants-${read.msgHash}`}
            className="field num text-sm"
            inputMode="decimal"
            spellCheck={false}
            autoComplete="off"
            value={wantsText}
            aria-invalid={wantsError || overAsking ? true : undefined}
            aria-describedby={`rfq-spread-${read.msgHash}`}
            onChange={(e) => setWantsText(normalizeAmount(e.target.value))}
          />
          <p id={`rfq-spread-${read.msgHash}`} className="text-[11px] leading-relaxed">
            {wantsError ? (
              <span className="text-(--color-danger)">{wantsError}</span>
            ) : overAsking ? (
              <span className="text-(--color-danger)">
                {t('rfq.accept.overAsking', {
                  max: tokenA ? units(maxWants, tokenA.decimals) : '…',
                  symbol: symA,
                })}
              </span>
            ) : spread === 0n ? (
              <span className="text-(--color-unproven)">{t('rfq.accept.spread.none')}</span>
            ) : (
              <span className="num text-(--color-dim)">
                {t('rfq.accept.spread', {
                  amount: tokenA ? units(spread, tokenA.decimals) : '…',
                  symbol: symA,
                })}
              </span>
            )}
          </p>

          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="text-[11px] uppercase tracking-wider text-(--color-dim) me-1"
              aria-hidden="true">
              {t('sign.custody')}
            </span>
            <span className="num text-[11px] text-(--color-body)">{RUNGS[mode](ctx).name}</span>
          </div>
          <CustodyLadder ctx={ctx} mode={mode} onMode={setCustody} />
          <p className="text-[11px] leading-relaxed text-(--color-dim)">{t('rfq.accept.note')}</p>

          <button
            className="btn btn-primary btn-block"
            disabled={!canSign}
            onClick={accept}>
            {buttonLabel}
          </button>
        </div>
      )}

      {ticket && <Handover ticket={ticket} onSettle={onSettle} copied={copied} onCopied={setCopied} />}

      <p role="status" className="sr-only">
        {working ? buttonLabel : ticket ? t('rfq.accept.done.spoken') : ''}
      </p>
      {phase === 'error' && message && (
        <p role="alert" className="text-[11px] text-(--color-danger) break-all">
          {message}
        </p>
      )}
    </article>
  )
}

/** The signed pair, and the two things a counterparty can do with it. */
function Handover({
  ticket,
  onSettle,
  copied,
  onCopied,
}: {
  ticket: Ticket
  onSettle: (t: Ticket) => void
  copied: boolean
  onCopied: (v: boolean) => void
}) {
  const text = encodeTicket(ticket, getChainId())
  return (
    <div className="rule-t pt-3 grid gap-2">
      <p className="text-[11px] leading-relaxed text-(--color-proven)">{t('rfq.accept.done')}</p>
      {/*
        A textarea rather than a download. A viewer's browser can block a script-driven save, and
        the pair is a few hundred bytes — small enough to read, to paste into a chat, and to check
        before somebody spends gas on it.
      */}
      <textarea
        className="field num text-[11px] break-all"
        readOnly
        rows={4}
        value={text}
        aria-label={t('rfq.accept.ticket')}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Chip
          mono={false}
          selected={copied}
          onClick={() => {
            navigator.clipboard
              ?.writeText(text)
              .then(() => onCopied(true))
              .catch(() => {})
          }}>
          {copied ? t('rfq.accept.copied') : t('rfq.accept.copy')}
        </Chip>
        <Chip mono={false} selected={false} onClick={() => onSettle(ticket)}>
          {t('rfq.accept.submitYourself')}
        </Chip>
      </div>
      <p className="text-[11px] leading-relaxed text-(--color-dim)">{t('rfq.accept.handover')}</p>
    </div>
  )
}

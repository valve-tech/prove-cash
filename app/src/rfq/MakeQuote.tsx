import { useState } from 'react'
import { formatUnits, type Address } from 'viem'
import {
  CURVE_LINEAR,
  displaySymbol,
  formatFeeRate,
  getChainId,
  grossForNet,
  intentHashOf,
  MAX_FEE_RATE,
  parse,
  parseFeeRate,
  postRfqQuote,
  postSealedRfqQuote,
  ZERO_HASH,
  type Exclusive,
  type ExclusiveQuote,
  type Intent,
  type RfqKeyAnnouncement,
  type TokenInfo,
} from '@prove.cash/sdk'
import { FLAG_ESCROW, FLAG_PERMIT2 } from '@prove.cash/sdk'
import { CustodyLadder } from '../components/CustodyLadder'
import { AmountRow, Chip } from '../components/fields'
import { FeeFault, FeeNotice } from '../components/FeeNotice'
import { asAddress, openingPair } from '../components/Compose'
import { TokenUnit } from '../components/TokenAvatar'
import { TokenPicker } from '../components/TokenPicker'
import { useCustody } from '../hooks/useCustody'
import { useAcknowledgedDefault, useFeeDefaults } from '../hooks/useFeeDefaults'
import { amountError, normalizeAmount } from '../lib/amount'
import { signAndArm } from '../lib/arm'
import { boardClient } from '../lib/board'
import { RUNGS, walletCustody } from '../lib/custody'
import { chargedRate, feeFault, feeInside, feeShares, feeTerms, forTheBoard } from '../lib/fee'
import { errorLine } from '../lib/errors'
import { num, t } from '../lib/i18n'
import { spokenDuration } from '../lib/speech'
import { signExclusive } from '../lib/wallet'
import { DEFAULT_RFQ_WINDOW, RFQ_WINDOWS } from './quote'
import { useHold } from './useHold'
import { ChevronIcon } from '../components/ChevronIcon'

/**
 * Name a price for one address.
 *
 * The quote is an ordinary intent with two things done to it. Its `executor` is the venue, so
 * `ProveSettlement` refuses a fill from every other address on the chain and the price is
 * unreachable in public. And the maker signs a second message under the venue's own domain — this
 * intent hash, this counterparty, this size, until this moment — which is what makes the
 * exclusivity cryptographic rather than a promise.
 *
 * **No decay, and the omission is the design.** The sign form's price falls over its window
 * because a flat public order is a race between bots on latency that the maker collects nothing
 * from winning. Nobody races an exclusive quote: one address may take it. A falling price here
 * would only mean the counterparty's `sells` — computed against `grossOut` at the moment they
 * accept — over-pays by the drift, and `RfqVenue._sweepAbove` hands that surplus to the
 * submitter. So a quote is one number, which is also what "a maker names a price" means.
 *
 * **No partial fills either.** A binding releases exactly `Exclusive.take`, once, and the venue
 * refuses a take that is not the bound one. One quote is one size.
 *
 * **And so no curve.** A shape says where inside a window a price moves, and this price does not
 * move: both ends are the same number, so every kind of curve returns it at every instant. The
 * quote signs `CURVE_LINEAR` and no kind bits — the cheapest word, and the only one that says
 * anything true about a flat price.
 */

type Phase =
  | 'idle'
  | 'signing'
  | 'authorizing'
  | 'approving'
  | 'depositing'
  | 'binding'
  | 'grinding'
  | 'done'
  | 'error'

/** The highest rate this form will let a maker type, mirroring the sign form. A fifth. */
const MAX_TYPED_RATE = MAX_FEE_RATE / 5n

export function MakeQuote({
  account,
  venue,
  keys,
  onPosted,
  onConnect,
}: {
  account: Address | null
  venue: Address
  /** The newest key each address has announced, so a quote can be sealed to one of them. */
  keys: Map<Address, RfqKeyAnnouncement>
  onPosted: () => void
  onConnect: () => Promise<void>
}) {
  const [opensWith, opensTo] = openingPair(null)
  const [tokenIn, setTokenIn] = useState<TokenInfo | null>(opensWith)
  const [tokenOut, setTokenOut] = useState<TokenInfo | null>(opensTo)
  const [toText, setToText] = useState('')
  const [sizeText, setSizeText] = useState('')
  const [priceText, setPriceText] = useState('')
  const [firmFor, setFirmFor] = useState<number>(DEFAULT_RFQ_WINDOW)
  const [rateText, setRateText] = useState('')
  const [more, setMore] = useState(false)
  const [picking, setPicking] = useState<'in' | 'out' | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [iterations, setIterations] = useState(0n)

  const sizeError = amountError(sizeText, tokenIn?.decimals)
  const priceError = amountError(priceText, tokenOut?.decimals)
  const amountsOk = Number(sizeText) > 0 && Number(priceText) > 0 && !sizeError && !priceError
  const tokensOk = !!tokenIn && !!tokenOut && tokenIn.address !== tokenOut.address

  // The one address that may take this price. A typo here does not lose money — the quote simply
  // reaches nobody — but it does spend proof of work, so the field refuses a bad checksum.
  const counterparty = asAddress(toText)
  const typedTo = toText.trim() !== ''
  const selfQuote =
    counterparty !== null && account !== null && counterparty.toLowerCase() === account.toLowerCase()
  const toError = typedTo && !counterparty ? t('rfq.make.to.invalid') : selfQuote ? t('rfq.make.to.self') : null

  // The same rule as the sign form, on `feeTerms`: the chain's defaults, plus the maker's own cut.
  const rateTyped = rateText.trim() === '' ? 0n : parseFeeRate(rateText)
  const defaultRead = useFeeDefaults(getChainId())
  const [ackedDefault, ackDefault] = useAcknowledgedDefault(defaultRead)
  const terms = feeTerms({ rate: rateTyped, read: defaultRead })
  const charged = chargedRate(terms, defaultRead)
  const chargedRateNow = charged ?? 0n
  // Two ceilings, as on the sign form. `MAX_FEE_RATE` is the chain's and it is arithmetic: above
  // it the maker's `gross - fee` underflows, `_termsOk` refuses the quote, and the counterparty
  // finds that out only when their fill reverts.
  const rateError =
    rateText.trim() === '' || rateTyped === null
      ? rateText.trim() === ''
        ? null
        : t('sign.rate.invalid', { max: formatFeeRate(MAX_TYPED_RATE) })
      : rateTyped >= MAX_FEE_RATE
        ? t('sign.rate.refused', { max: formatFeeRate(MAX_FEE_RATE), cap: formatFeeRate(MAX_TYPED_RATE) })
        : rateTyped > MAX_TYPED_RATE
          ? t('sign.rate.invalid', { max: formatFeeRate(MAX_TYPED_RATE) })
          : null
  // A rate with no registered sink, or under the sink's floor: `BadTerms_` at every fill, and
  // the counterparty would find out only when their fill reverts. Refused here instead.
  const feeError = rateError === null ? feeFault(terms, defaultRead, ackedDefault) : null

  let sizeWei = 0n
  try {
    if (tokenIn && amountsOk) sizeWei = parse(sizeText, tokenIn.decimals)
  } catch {
    /* not a parseable amount yet */
  }
  /*
   * The price the maker typed, and it is their NET — what they receive, not what the quote asks.
   *
   * The label says "exactly", and the exclusivity fee now comes out of the maker's payment
   * rather than out of the counterparty's spread. Signing this number would make the label a
   * lie by the size of the fee, so the quote signs `grossPrice` and the maker banks this.
   */
  let priceWei = 0n
  try {
    if (tokenOut && Number(priceText) > 0) priceWei = parse(priceText, tokenOut.decimals)
  } catch {
    /* not a parseable amount yet */
  }
  /*
   * What the quote asks the counterparty for. `grossForNet` rounds up, so `gross - fee >= net`
   * holds and the maker's stated figure is met or beaten. A refused rate derives nothing: the
   * divisor `MAX_FEE_RATE - rate` is zero or negative at and above the ceiling.
   */
  const grossPrice = rateError === null ? grossForNet(priceWei, chargedRateNow) : priceWei
  /** The slice of `grossPrice` that leaves for `feeTo`, by the settlement's own arithmetic. */
  const priceFee = feeInside(grossPrice, chargedRateNow)

  const { ctx, mode, setCustody, needsApproval, live } = useCustody(account, tokenIn, sizeWei)

  /*
   * The key the counterparty announced, if they have announced one.
   *
   * Sealing is only possible against a key its holder published, and it seals to the address the
   * binding names and to no other — a key paired with the wrong address produces a message
   * nobody can open and nothing can detect that. `latestRfqKeys` returns the pairing, so this
   * looks the key up BY the counterparty rather than letting anybody paste one in.
   */
  const theirKey = counterparty ? keys.get(counterparty.toLowerCase() as Address) : undefined

  // `!rateError` matters more here than on a public offer: the exclusivity fee is the whole
  // reason to write a quote instead of posting one, and a quote cannot be amended once accepted.
  //
  // `live` for the reason the sign form carries it: a quote is an ordinary intent, and one signed
  // on a chain with no settlement names `verifyingContract` of zero. `rfqVenue` already answers
  // null there, so this surface should be unreachable; a second reader of the same fact costs
  // nothing and does not depend on the first staying true.
  const ready =
    !!account &&
    live &&
    tokensOk &&
    amountsOk &&
    !rateError &&
    !!counterparty &&
    !selfQuote &&
    !feeError &&
    charged !== null &&
    sizeWei > 0n &&
    priceWei > 0n
  const working =
    phase === 'signing' ||
    phase === 'authorizing' ||
    phase === 'approving' ||
    phase === 'depositing' ||
    phase === 'binding' ||
    phase === 'grinding'
  useHold(working)

  const modeName = RUNGS[mode](ctx).name
  // The board hash, cut to what a line can hold, and the window as a sentence rather than a chip
  // face. `{duration}` is a phrase everywhere in this dictionary — already inflected, already
  // agreed with its own count — so `10m` is not what belongs in one.
  //
  // `span`: it lands in `firm for {duration}`, the period the quote holds for. Hungarian marks
  // that on the noun — `kötött 5 percig` — and marks nothing on a bare measure.
  const postedHash = message ? `${message.slice(0, 18)}…` : ''
  const spokenWindow = spokenDuration(BigInt(firmFor), 'span')

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
    if (!ready || !tokenIn || !tokenOut || !counterparty) return
    // One chain for the whole quote: the intent, its arming, its hash and the binding.
    const chainId = getChainId()
    setMessage(null)
    setIterations(0n)
    try {
      // One wall-clock read for the whole quote, so the intent's window and the binding's expiry
      // cannot land a second apart.
      const now = BigInt(Math.floor(Date.now() / 1000))
      const endTime = now + BigInt(firmFor)
      const intent: Intent = {
        maker: account,
        recipient: account,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: sizeWei,
        // Flat. See the note at the top of this file for why an exclusive quote does not decay.
        // Gross, because the fee comes out of it — the maker receives the number they typed.
        minOutStart: grossPrice,
        minOutEnd: grossPrice,
        // No shape on a price that does not move. Kind 0, and the zero word it reads none of.
        curve: CURVE_LINEAR,
        startTime: now,
        endTime,
        // The field the whole design rests on. Name the venue and the settlement refuses a fill
        // from every other address, so the quote is unreachable in public.
        executor: venue,
        feeConfig: terms.feeConfig,
        feeRateIn: terms.feeRateIn,
        feeRateProceeds: terms.feeRateProceeds,
        // The exclusivity fee, and it is an ordinary per-intent rate. The venue charges none of
        // its own any more, so this is the whole price and `exclusiveQuoteCost` reads it back.
        feeRate: terms.feeRate,
        minFill: 0n,
        authNonce: ZERO_HASH,
        // No `FLAG_PARTIAL`: a binding releases exactly `take`, once.
        flags: mode === 'permit2' ? FLAG_PERMIT2 : walletCustody(mode) ? 0 : FLAG_ESCROW,
        nonce: BigInt(Date.now()),
      }

      const signed = await signAndArm({
        account,
        intent,
        mode,
        live,
        needsApproval,
        fundsFrom: now,
        onPhase: setPhase,
        chainId,
      })

      /*
       * The binding, under the venue's domain rather than the settlement's.
       *
       * `intentHash` commits to every term above — the rate included — so a counterparty who
       * verifies the binding has verified the whole quote. `take` is the whole size, because
       * the intent allows no partial fill. The nonce makes two otherwise identical bindings
       * distinct, so a maker who means to allow two takes signs two of them.
       */
      setPhase('binding')
      const exclusive: Exclusive = {
        intentHash: intentHashOf(intent, chainId),
        counterparty,
        take: sizeWei,
        expiry: endTime,
        nonce: BigInt(Date.now()),
      }
      const bindingSignature = await signExclusive(account, exclusive, venue, chainId)
      // The intent carries its fee config's preimage under the sign form's rule (`forTheBoard`).
      const quote: ExclusiveQuote = { intent: forTheBoard(signed, chainId), exclusive, bindingSignature }

      setPhase('grinding')
      const client = boardClient((i) => setIterations(i))
      const hash = theirKey
        ? await postSealedRfqQuote(quote, theirKey.publicKey, client)
        : await postRfqQuote(quote, client)

      setPhase('done')
      setMessage(hash)
      onPosted()
    } catch (e) {
      const text = errorLine(e)
      setPhase(text === 'cancelled' ? 'idle' : 'error')
      if (text !== 'cancelled') setMessage(text)
    }
  }

  const buttonLabel = !account
    ? t('wallet.connect')
    : phase === 'signing'
      ? t('sign.phase.signing')
      : phase === 'authorizing'
        ? t('sign.phase.authorizing')
        : phase === 'approving'
          ? t('sign.phase.approving')
          : phase === 'depositing'
            ? t('sign.phase.depositing')
            : phase === 'binding'
              ? t('rfq.phase.binding')
              : phase === 'grinding'
                ? t('sign.phase.posting')
                : !tokensOk
                  ? t('sign.need.tokens')
                  : !counterparty || selfQuote
                    ? t('rfq.make.need.to')
                    : !amountsOk
                      ? t('sign.need.amounts')
                      : t('rfq.make.go')

  // The column of cards carries the padding, so the column itself carries none.
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2 min-w-0">
      <h3 className="sr-only">{t('rfq.make.title')}</h3>

      <div className="field-card panel-ink p-2 sm:p-4 grid gap-1.5">
        <label htmlFor="rfq-to" className="text-[11px] uppercase tracking-wider text-(--color-dim)">
          {t('rfq.make.to')}
        </label>
        <input
          id="rfq-to"
          className="field num text-sm break-all"
          spellCheck={false}
          autoComplete="off"
          placeholder="0x…"
          value={toText}
          aria-invalid={toError ? true : undefined}
          aria-describedby={toError ? 'rfq-to-error' : 'rfq-to-hint'}
          onChange={(e) => setToText(e.target.value)}
        />
        {toError ? (
          <p id="rfq-to-error" role="alert" className="text-[11px] text-(--color-danger)">
            {toError}
          </p>
        ) : (
          <p id="rfq-to-hint" className="text-[11px] leading-relaxed text-(--color-dim)">
            {counterparty
              ? theirKey
                ? t('rfq.make.seal.on')
                : t('rfq.make.seal.off')
              : t('rfq.make.to.hint')}
          </p>
        )}
      </div>

      <AmountRow
        id="rfq-size"
        label={t('rfq.make.size')}
        side={t('sign.side.give')}
        amount={sizeText}
        onAmount={(v: string) => setSizeText(normalizeAmount(v))}
        token={tokenIn}
        onPickToken={() => setPicking('in')}
        balance={null}
        error={sizeError}
      />

      <AmountRow
        id="rfq-price"
        label={t('rfq.make.price')}
        side={t('sign.side.receive')}
        amount={priceText}
        onAmount={(v: string) => setPriceText(normalizeAmount(v))}
        token={tokenOut}
        onPickToken={() => setPicking('out')}
        balance={null}
        error={priceError}
      />

      <div
        className="gutter flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label={t('rfq.make.firm.group')}>
        <span
          className="text-[11px] uppercase tracking-wider text-(--color-dim) me-1"
          aria-hidden="true">
          {t('rfq.make.firm')}
        </span>
        {RFQ_WINDOWS.map((w) => (
          <Chip
            key={w.seconds}
            selected={firmFor === w.seconds}
            onClick={() => setFirmFor(w.seconds)}
            // `span`: `Firm for {duration}` is the period the quote holds for.
            label={t('rfq.make.firm.label', {
              duration: spokenDuration(BigInt(w.seconds), 'span'),
            })}>
            {w.label}
          </Chip>
        ))}
      </div>
      <p className="gutter text-[11px] leading-relaxed text-(--color-dim) -mt-1">
        {t('rfq.make.firm.note')}
      </p>

      <div className="gutter flex items-center justify-between gap-2 text-[11px] text-(--color-dim)">
        <span className="uppercase tracking-wider" aria-hidden="true">
          {t('sign.custody')}
        </span>
        <button
          type="button"
          onClick={() => setMore((v) => !v)}
          aria-expanded={more}
          aria-controls="rfq-advanced"
          aria-label={t('rfq.make.more.label')}
          className="num hover:text-(--color-body) transition-colors">
          <span aria-hidden="true">
            {modeName}
            {chargedRateNow > 0n && (
              <span className={feeError ? 'text-(--color-danger)' : undefined}>
                {' '}
                · {formatFeeRate(chargedRateNow)}%
              </span>
            )}{' '}
            <span><ChevronIcon up={more} /></span>
          </span>
        </button>
      </div>

      {more && (
        <div id="rfq-advanced" className="panel-ink p-2 sm:p-4 grid gap-3">
          <div
            className="text-[11px] uppercase tracking-wider text-(--color-dim)"
            aria-hidden="true">
            {t('sign.fee')}
          </div>
          <FeeNotice
            terms={terms}
            read={defaultRead}
            refused={feeError !== null}
            acked={ackedDefault}
            onAck={ackDefault}
          />
          <div className="grid gap-1.5">
            <label
              className="flex items-center gap-2 text-[11px] text-(--color-dim)"
              htmlFor="rfq-fee-rate">
              {t('rfq.make.rate')}
              {/* The width lives on the wrapper: `.field` sets `width: 100%` from an unlayered rule. */}
              <span className="relative w-24 shrink-0">
                <input
                  id="rfq-fee-rate"
                  className="field num pe-6 text-sm"
                  inputMode="decimal"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="0.05"
                  value={rateText}
                  aria-invalid={rateError || feeError ? true : undefined}
                  aria-describedby={
                    rateError ? 'rfq-fee-rate-error' : feeError ? 'rfq-fee-terms-error' : undefined
                  }
                  onChange={(e) => setRateText(e.target.value)}
                />
                {/* Logical inset, so the sign follows the script rather than the screen. */}
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 end-2 flex items-center text-(--color-dim)">
                  %
                </span>
              </span>
            </label>
            {rateError && (
              <p id="rfq-fee-rate-error" role="alert" className="text-[11px] text-(--color-danger)">
                {rateError}
              </p>
            )}
            <FeeFault id="rfq-fee-terms-error" text={feeError} />
          </div>
          {/*
            The three numbers the rate produces. Same shape as the sign form, and shown only
            when a rate is set — at zero all three are one number.
          */}
          {chargedRateNow > 0n && tokenOut && priceWei > 0n && (
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              <dt className="text-(--color-dim)">{t('sign.split.receive')}</dt>
              <dd className="num flex flex-wrap items-center justify-end gap-x-1 text-(--color-bright) break-all">
                {num(Number(formatUnits(priceWei, tokenOut.decimals)), {
                  maximumSignificantDigits: 6,
                })}
                <TokenUnit token={tokenOut} />
              </dd>
              <dt className="text-(--color-dim)">{t('sign.split.signed')}</dt>
              <dd className="num flex flex-wrap items-center justify-end gap-x-1 text-(--color-body) break-all">
                {num(Number(formatUnits(grossPrice, tokenOut.decimals)), {
                  maximumSignificantDigits: 6,
                })}
                <TokenUnit token={tokenOut} />
              </dd>
              {feeShares(defaultRead, priceFee).flatMap((d) => [
                <dt key={`${d.address}-dt`} className="text-(--color-dim) break-all">
                  {t('sign.split.fee', { where: d.address })}
                </dt>,
                <dd
                  key={`${d.address}-dd`}
                  className="num flex flex-wrap items-center justify-end gap-x-1 text-(--color-body) break-all">
                  {num(Number(formatUnits(d.amount, tokenOut.decimals)), {
                    maximumSignificantDigits: 6,
                  })}
                  <TokenUnit token={tokenOut} />
                </dd>,
              ])}
            </dl>
          )}
          <p className="text-[11px] leading-relaxed text-(--color-dim)">{t('rfq.make.rate.note')}</p>

          <div className="rule-t pt-3">
            <div
              className="text-[11px] uppercase tracking-wider text-(--color-dim) mb-1"
              aria-hidden="true">
              {t('sign.custody')}
            </div>
            <CustodyLadder ctx={ctx} mode={mode} onMode={setCustody} />
          </div>
        </div>
      )}

      {/* The row reaches both edges, so nothing in it carries a corner. See `.btn-block`. */}
      <div className="mt-1 flex items-center gap-px">
        <button
          className="btn btn-primary btn-block flex-1"
          disabled={(!!account && !ready) || working}
          onClick={submit}>
          {buttonLabel}
        </button>
      </div>

      {phase === 'grinding' && (
        <p className="gutter num text-xs text-(--color-dim) text-center" aria-hidden="true">
          {t('sign.tries', { count: num(iterations) })}
        </p>
      )}
      <p role="status" className="sr-only">
        {working ? buttonLabel : phase === 'done' ? t('rfq.make.done.spoken') : ''}
      </p>
      {phase === 'done' && message && (
        <p className="gutter num text-xs text-(--color-proven) break-all text-center">
          {t('rfq.make.done', { hash: postedHash, duration: spokenWindow })}
        </p>
      )}
      {phase === 'error' && message && (
        <p role="alert" className="gutter text-xs text-(--color-danger) break-all text-center">
          {message}
        </p>
      )}

      {picking && (
        <TokenPicker
          value={picking === 'in' ? tokenIn : tokenOut}
          onChange={picking === 'in' ? setTokenIn : setTokenOut}
          account={account}
          onClose={() => setPicking(null)}
        />
      )}
      {/* The symbols are not copy, and a screen reader needs them beside the two amounts above. */}
      <p className="sr-only">
        {tokenIn && tokenOut
          ? t('rfq.make.pair.spoken', { in: displaySymbol(tokenIn), out: displaySymbol(tokenOut) })
          : ''}
      </p>
    </div>
  )
}

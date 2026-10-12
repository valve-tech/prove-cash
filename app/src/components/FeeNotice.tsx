import { formatFeeRate, pricedFeeRates, type FeeTerms } from '@prove.cash/sdk'
import { feeShares, feeWarning, feeWhereOf, needsAck, type DefaultRead } from '../lib/fee'
import { t } from '../lib/i18n'

/**
 * Where the fee goes and at what rate, and a warning when a rate is high.
 *
 * Shared by the sign form and the RFQ quote form, because both sign the same fee terms and a rule
 * that lives in two copies is a rule that drifts.
 *
 * **There is nothing to pick.** The offer signs the chain's fee defaults (a config hash and three
 * rates, read from `FeeDefaults` or, before one is deployed, the build's copy of it). This panel
 * says what that is before the maker signs. The rate field beside it is the maker's own cut out of
 * their number, and it can only add to the defaults.
 *
 * **The warning is only a warning.** A rate above the defaults' own "warn" line, at any take
 * point, shows a line saying so. The chain takes any rate up to one hundred per cent, so the form
 * never refuses it on this ground.
 */
export function FeeNotice({
  terms,
  read,
  refused = false,
  acked = null,
  onAck,
}: {
  terms: FeeTerms
  /** The chain's fee defaults, which an offer signs. */
  read: DefaultRead
  /** True while the refusal line under the rate says the same thing in red. Said once, not twice. */
  refused?: boolean
  /** The hash of the unshipped default the maker acknowledged, or null. */
  acked?: string | null
  /** The maker accepts the unshipped default's destinations. */
  onAck?: () => void
}) {
  const warning = feeWarning(terms, read)
  if (read.state !== 'read') {
    return refused ? null : (
      <p className="text-[11px] leading-relaxed text-(--color-dim)">{t('sign.fee.unread')}</p>
    )
  }
  const r = pricedFeeRates(terms)
  const shown = r.handover + r.output + r.proceeds
  return (
    <>
      <p className="text-[11px] leading-relaxed text-(--color-dim)">
        {t('sign.fee.default', { rate: formatFeeRate(shown), where: feeWhereOf(read) })}
      </p>
      {/*
        Every destination in full, checksummed, with its share. A short form hides which address
        is which, and the maker signs the destinations, not a name. Always shown, not only when
        the default changed: it is the thing being signed.
      */}
      <ul className="grid gap-0.5 text-[11px] text-(--color-dim)" aria-label={t('sign.fee.group')}>
        {feeShares(read, 0n).map((d) => (
          <li key={d.address} className="num break-all">
            {d.address} · {formatFeeRate(d.weight)}%
          </li>
        ))}
      </ul>
      {read.unpinned === true && (
        <div role="alert" className="grid gap-1 text-[11px] leading-relaxed text-(--color-danger)">
          <p>{t('sign.fee.changed')}</p>
          <label className="flex items-center gap-2 text-(--color-body)">
            <input
              type="checkbox"
              checked={!needsAck(read, acked)}
              disabled={!needsAck(read, acked)}
              onChange={() => onAck?.()}
            />
            {t('sign.fee.ack')}
          </label>
        </div>
      )}
      {warning && (
        <p role="status" className="text-[11px] leading-relaxed text-(--color-warn,var(--color-danger))">
          {warning}
        </p>
      )}
    </>
  )
}

/** The refusal line under the rate field: why the chain would refuse these fee terms. */
export function FeeFault({ id, text }: { id: string; text: string | null }) {
  if (!text) return null
  return (
    <p id={id} role="alert" className="text-[11px] text-(--color-danger)">
      {text}
    </p>
  )
}

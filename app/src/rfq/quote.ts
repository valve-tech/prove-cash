import type { QuoteFault } from '@prove.cash/sdk'
import type { Key } from '../i18n/en.ts'

/**
 * How long a quote stays firm.
 *
 * Shorter than the sign form's windows, and deliberately so. A public offer decays over an hour
 * and the market is what moves under it; an exclusive quote is a firm price held for one address,
 * so every second it stands is a free option the maker has written. `RfqVenue` refuses a
 * settlement at or after `Exclusive.expiry`, so this one number is the deadline for accepting AND
 * for submitting — the counterparty must sign with time left for a transaction to land.
 *
 * An hour is the ceiling because nobody should hold a firm price for one counterparty longer
 * than that. The settlement bounds no window, so this is the form's judgment and not a rule read
 * off the chain — a quote is an option written for free, and the longer it stands the more it is
 * worth to whoever holds it.
 */
export const RFQ_WINDOWS = [
  { label: '2m', seconds: 120 },
  { label: '10m', seconds: 600 },
  { label: '1h', seconds: 3600 },
] as const

/** The default. Long enough to read the terms, short enough that the option is worth little. */
export const DEFAULT_RFQ_WINDOW = 600

/**
 * One sentence per `QuoteFault`, and the vocabulary is the SDK's.
 *
 * `checkExclusiveQuote` already names every reason a quote is not takeable. Inventing a second
 * set of names here would mean the app and the package disagreeing about what went wrong with the
 * same quote — and the package is the one that decided. So this maps its words to the reader's
 * language and adds nothing.
 *
 * A `Record`, not a lookup with a fallback: a fault the SDK adds will not compile until it has a
 * sentence, which is the only way a new reason cannot reach a reader as a raw identifier.
 */
export const FAULT_KEY: Record<QuoteFault, Key> = {
  'bad-intent-signature': 'rfq.fault.badIntentSignature',
  'bad-binding-signature': 'rfq.fault.badBindingSignature',
  'not-exclusive-to-this-venue': 'rfq.fault.notExclusiveToThisVenue',
  'binding-names-another-intent': 'rfq.fault.bindingNamesAnotherIntent',
  'reserved-for-somebody-else': 'rfq.fault.reservedForSomebodyElse',
  expired: 'rfq.fault.expired',
  'take-exceeds-the-quote': 'rfq.fault.takeExceedsTheQuote',
  'partial-not-allowed': 'rfq.fault.partialNotAllowed',
}

import {
  defaultFeeTerms,
  feeTermsFault,
  formatFeeRate,
  hashFeeConfig,
  isBundledFeeConfig,
  knownFeeConfig,
  MAX_FEE_RATE,
  pricedFeeRates,
  ratesAboveWarn,
  rememberFeeConfig,
  splitByWeights,
  withWirePreimage,
  type ChainId,
  type DefaultFeeConfig,
  type FeeTerms,
  type SignedIntent,
} from '@prove.cash/sdk'
import { getAddress, type Address, type Hex } from 'viem'
import { short } from './address'
import { t } from './i18n'

/**
 * What the form knows of the chain's fee defaults (`FeeDefaults.current()`, or the registry copy
 * of it on a chain where none is deployed yet). Reading is not an answer, and neither is a failed
 * read: both leave the form with nothing to sign, so it cannot sign.
 *
 * `source` says where the answer came from, so a form can tell a maker the figure is the build's
 * own copy and not the chain's.
 */
export type DefaultRead =
  | { state: 'reading' }
  | { state: 'unread' }
  | {
      state: 'read'
      def: DefaultFeeConfig & { label?: string }
      source: 'chain' | 'registry'
      /**
       * Set when the chain's default is a config this build does not ship (it is not in the
       * bundled history of `fee-configs.json`). The maker is told, and signs it only after
       * acknowledging it. Absent means the build vouches for the config.
       */
      unpinned?: true
    }

/** The hash of the default a read carries, or null when there is none. */
export const defaultHash = (read: DefaultRead): Hex | null =>
  read.state === 'read' ? hashFeeConfig(read.def.config) : null

/**
 * Whether the maker still owes an acknowledgement: the default is one this build does not ship and
 * the hash they acknowledged is not this one. Per hash, so the owner publishing yet another
 * default asks again. Warns only about the DEFAULT config: no rate is ever refused on this ground.
 */
export function needsAck(read: DefaultRead, acked: string | null): boolean {
  if (read.state !== 'read' || read.unpinned !== true) return false
  const h = defaultHash(read)
  return h === null || acked === null || acked.toLowerCase() !== h.toLowerCase()
}

/**
 * The maker has read the destinations of an unshipped default and accepts them. Only now is the
 * config's preimage remembered, which is what lets a wallet be asked to sign it: until then the
 * signing guard (`wallet.signIntent`) refuses a hash it does not know the destinations of.
 */
export function acknowledgeDefault(read: DefaultRead): Hex | null {
  if (read.state !== 'read') return null
  return rememberFeeConfig(read.def.config)
}

/**
 * The signed offer as it goes on the board: carrying its fee config's preimage when the config is
 * not one of this chain's bundled defaults, so a solver or an indexer on another build can show
 * and pay it without a chain read, and without it otherwise (every reader of this build already
 * has a bundled default, and the block costs proof of work). The preimage is the one the wallet
 * signed, which the signing guard required this process to know.
 */
export const forTheBoard = (signed: SignedIntent, chainId: ChainId): SignedIntent =>
  withWirePreimage(signed, (h) => isBundledFeeConfig(h, chainId))

/** Whether a wallet could be asked to sign this config right now, for a test and the guard. */
export const isSignable = (read: DefaultRead): boolean =>
  read.state === 'read' && knownFeeConfig(hashFeeConfig(read.def.config)) !== null

/**
 * Every destination of the default in full, checksummed, with its weight and its share of a fee.
 * Rounding follows the settlement: every share floors but the last, which takes the remainder.
 */
export function feeShares(
  read: DefaultRead,
  total: bigint,
): { address: Address; weight: bigint; amount: bigint }[] {
  if (read.state !== 'read') return []
  const { destinations, weights } = read.def.config
  const parts = splitByWeights(total, weights)
  return destinations.map((d, k) => ({
    address: getAddress(d),
    weight: weights[k] ?? 0n,
    amount: parts[k] ?? 0n,
  }))
}

/**
 * The fee terms an offer carries, from the one control that touches them and the defaults.
 *
 * **The defaults are resolved here, at signing.** The offer signs the defaults' config hash at the
 * defaults' three rates as its own terms. No fill reads the defaults, so nothing the owner does
 * later changes what this offer pays. The app never signs a zero `feeConfig` for a wallet: no
 * EIP-712 struct hashes to zero, so a wallet cannot produce that signature, and a fee-free offer
 * from a wallet must name a config at rate zero.
 *
 * The typed rate, when there is one, is the maker's own cut OUT OF THEIR NUMBER: it replaces the
 * defaults' proceeds rate (P3) and leaves the other two points as the defaults have them, so
 * typing a rate can only add to the fee, never lower the defaults'. An empty field is the
 * defaults as they stand. Until the defaults are read there are none to sign: the terms are the
 * zero config at rate zero, and `chargedRate` and `feeFault` keep the button shut.
 */
export function feeTerms(x: {
  /** The typed rate, or null when it will not parse. An empty field is `0n`. */
  rate: bigint | null
  read?: DefaultRead
}): FeeTerms {
  const resolved = x.read?.state === 'read' ? defaultFeeTerms(x.read.def) : null
  if (resolved === null) {
    return { feeConfig: `0x${'00'.repeat(32)}`, feeRateIn: 0n, feeRate: 0n, feeRateProceeds: 0n }
  }
  const typed = x.rate ?? 0n
  return typed === 0n ? resolved : { ...resolved, feeRateProceeds: typed }
}

/** Why these fee terms cannot be signed, in the form's words, or null. */
export function feeFault(
  terms: FeeTerms,
  read: DefaultRead = { state: 'reading' },
  acked: string | null = null,
): string | null {
  if (read.state === 'unread') return t('sign.fee.unread')
  if (needsAck(read, acked)) return t('sign.fee.changed')
  if (feeTermsFault(terms) !== null) return t('sign.rate.invalid', { max: formatFeeRate(MAX_FEE_RATE) })
  return null
}

/**
 * The rate that comes out of the maker's own number (P3), or null while it is unknown. A null
 * blocks the signature. P1 and P2 are borne by whoever fills, so they never move the maker's net.
 */
export function chargedRate(terms: FeeTerms, read: DefaultRead): bigint | null {
  return read.state === 'read' ? pricedFeeRates(terms).proceeds : null
}

/** Where the fee lands, as a face: the defaults' label, else the first destination's short address. */
export function feeWhereOf(read: DefaultRead): string {
  if (read.state !== 'read') return ''
  if (read.def.label) return read.def.label
  const first = read.def.config.destinations[0]
  return first ? short(first) : ''
}

/** The rate to show beside the destination: the three points added, as a percentage figure. */
export function shownRate(terms: FeeTerms): bigint {
  const r = pricedFeeRates(terms)
  return r.handover + r.output + r.proceeds
}

/**
 * Whether a rate is above the defaults' own "warn" line at any take point. Only a warning: the
 * chain takes any rate up to one hundred per cent, and a maker may sign one. The sentence names
 * the highest figure so the maker sees what they are about to sign.
 */
export function feeWarning(terms: FeeTerms, read: DefaultRead): string | null {
  if (read.state !== 'read') return null
  const above = ratesAboveWarn(terms, read.def.warn)
  if (above.length === 0) return null
  const r = pricedFeeRates(terms)
  const worst = above.reduce((hi, p) => (r[p] > hi ? r[p] : hi), 0n)
  return t('sign.fee.warn', { rate: formatFeeRate(worst), warn: formatFeeRate(read.def.warn[above[0]!]) })
}

/**
 * The fee inside a gross, at a rate. The settlement's own arithmetic, in the browser.
 *
 * **It floors, and the direction matters.** The contract computes `fee = (gross * rate) / WAD`
 * and pays the maker the remainder, so the dust of the division stays with the maker and the
 * destination absorbs it. `MAX_FEE_RATE` is the denominator because it is one whole.
 */
export function feeInside(gross: bigint, rate: bigint): bigint {
  return (gross * rate) / MAX_FEE_RATE
}

/** What the maker actually receives out of a gross, at a rate. */
export function netOf(gross: bigint, rate: bigint): bigint {
  return gross - feeInside(gross, rate)
}

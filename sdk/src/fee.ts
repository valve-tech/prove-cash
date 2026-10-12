import type { Hex } from 'viem'
import { ZERO_HASH } from './intent.js'
import { hashFeeConfig, type FeeDefaultsEntry, type PointRates } from './feeconfig.js'

export type { PointRates }

/**
 * Choosing the rate an intent charges, and turning a maker's net into the gross they sign.
 *
 * `Intent.feeRate` is signed into the intent, so the client picks it once, at signing time, and
 * the chain never changes its mind about it. That is the whole reason it is a term and not a
 * lookup: an executor bounds what they will engage with through `maxFeeRate`, and a counterparty
 * on an RFQ quote verifies the price before they sign. A rate that moved between those two
 * moments would defeat both.
 *
 * **Three take points, three rates** (`Intent.feeRateIn`, `feeRate`, `feeRateProceeds`):
 *
 *   P1 handover   a fraction of the take, in tokenIn, out of what the solver receives. Solver bears it.
 *   P2 output     a fraction of what the maker is owed, in tokenOut, ON TOP of it. Solver bears it.
 *   P3 proceeds   a fraction of what the maker is owed, in tokenOut, OUT of it. Maker bears it.
 *
 * Only P3 touches the maker's number, so `minOut` is a gross floor for P3 and `grossForNet` is
 * what a sign form uses to keep the maker's promise anyway. `maxFeeRate` bounds P1 + P2.
 *
 * Everything here is pure. Nothing fetches, and nothing reads a clock. The caller passes the
 * numbers in and signs the number that comes out.
 */

/**
 * Which way the base fee should push the rate. There is no right answer and the two readings
 * point in opposite directions, so the caller says which one they mean.
 *
 * **Start from what the rate does now, because it is not what it did.** The fee comes out of the
 * maker's signed number. The filler pays the gross whatever the rate is, so the rate moves money
 * from the maker to the destination and moves nothing else: it does not enter the solver's
 * profitability condition, and it does not delay a fill.
 *
 * **One caveat, and it decides the default.** That holds for a maker who signs a fixed gross. A
 * maker who names a net instead — which is what a sign form does with `grossForNet` — signs a
 * gross that *rises* with the rate. Then the offer asks for more, and it clears later. So the
 * rate still costs a fill in time; the difference is that the maker now chooses whether to pay
 * in money or in time, and can see either one on the screen.
 *
 * **`'gas-relief'` — charge less when the chain is expensive.** A high base fee means a fill is
 * already marginal, and a form that derives its gross from a net asks for more at a higher rate.
 * Asking for more at that moment is asking at the worst one, and a fee destination earns nothing
 * from a fill that does not happen.
 *
 * **`'demand-capture'` — charge more when the chain is busy.** A high base fee means people are
 * competing for blocks, and a fee destination should take a share of that. This is the right
 * reading on a chain where gas is a rounding error against the trade, and the wrong one where
 * gas is most of the cost.
 *
 * **`'flat'`** ignores the base fee entirely and returns the target.
 *
 * **The default is `'gas-relief'`, and the numbers still say so.** Measured on PulseChain 369: a
 * base fee of 843,373 gwei, a fill costing 449 to 921 PLS — $0.0061 to $0.0126 — against
 * heartbeat intents worth about $0.62. At a ten basis point rate the whole fee on one of those
 * is $0.00062, roughly a twentieth of the gas. Fills there do not clear their own gas today, so
 * a gross raised even slightly at the worst moment is worth avoiding. On a chain where that
 * ratio inverts, pass `'demand-capture'` and mean it.
 */
export type FeeRatePolicy = 'gas-relief' | 'demand-capture' | 'flat'

/** What `suggestFeeRate` needs. Every value comes from the caller; nothing is read here. */
export type FeeRateInputs = {
  /** The rate to charge when the chain costs what it usually costs, as a fraction of one ether. */
  target: bigint
  /** The base fee of the block being signed against, in wei. */
  baseFeePerGas: bigint
  /** What this chain's base fee normally is, in wei. The scale is a ratio of the two. */
  referenceBaseFeePerGas: bigint
  /**
   * The band the caller will sign inside, both ends theirs to pick.
   *
   * The chain holds one ceiling, and it is arithmetic rather than policy: `_termsOk` refuses a
   * rate above `MAX_FEE_RATE`, because at more than one WAD the fee exceeds the gross and the
   * maker's half underflows. There is no floor: nobody registers a minimum. So these say what this
   * client is willing to charge.
   */
  min: bigint
  max: bigint
  /** Which reading of the base fee to apply. Defaults to `'gas-relief'`. */
  policy?: FeeRatePolicy
  /**
   * The widest the base fee may move the rate, as a multiple. Defaults to 4.
   *
   * A base fee spike of a hundred times is a congested minute, not a hundredfold change in what
   * a fill is worth. Without a band, one such block would either round the rate to nothing or
   * push it into the ceiling, and the intent would carry that number for its whole life.
   */
  band?: number
}

/** The precision the gas ratio is applied at. A billionth is far finer than gas is measured. */
const RATIO_SCALE = 1_000_000_000n

/**
 * A rate to sign into `Intent.feeRate`, chosen from what a block costs.
 *
 * The result is clamped to `[min, max]`, and both ends are the caller's own. The chain bounds a
 * rate only by `MAX_FEE_RATE`.
 *
 * **It no longer rounds.** This returned a whole number of basis points while the field was an
 * `int16`, so a ratio of 1.4 against a target of 10 gave 7 and a ratio of 1.5 gave 7 as well —
 * the unit, not the policy, was choosing the rate. A `uint64` against one ether has room for the
 * answer, so the scaling is done in integers and kept.
 *
 * @example
 *   const rate = suggestFeeRate({
 *     target: 1_000_000_000_000_000n, // ten basis points
 *     baseFeePerGas: await client.getGasPrice(),
 *     referenceBaseFeePerGas: 843_373_000_000_000n,
 *     min: 0n,
 *     max: 5_000_000_000_000_000n, // fifty basis points, this client's own ceiling
 *   })
 */
export function suggestFeeRate(x: FeeRateInputs): bigint {
  const policy = x.policy ?? 'gas-relief'
  const band = x.band ?? 4

  let rate = x.target
  if (policy !== 'flat' && x.referenceBaseFeePerGas > 0n && x.baseFeePerGas > 0n) {
    // The ratio is a measurement of gas, so it is taken in floating point once — but it is
    // *applied* in integers, because the rate it scales is a wei-precision number and a float
    // cannot carry one.
    const raw = Number(x.baseFeePerGas) / Number(x.referenceBaseFeePerGas)
    const bounded = Math.min(Math.max(raw, 1 / band), band)
    const scaled = BigInt(Math.round(bounded * Number(RATIO_SCALE)))
    if (scaled > 0n) {
      rate =
        policy === 'gas-relief'
          ? (x.target * RATIO_SCALE) / scaled
          : (x.target * scaled) / RATIO_SCALE
    }
  }

  if (rate > x.max) return x.max
  if (rate < x.min) return x.min
  return rate
}

/** One per cent, as a fraction of one ether. A rate of `PERCENT` is 1%. */
export const PERCENT = 10n ** 16n

/** One basis point, as a fraction of one ether. Here for the people who still think in them. */
export const BASIS_POINT = 10n ** 14n

/**
 * The highest rate an intent may sign: one hundred per cent, one WAD.
 *
 * This mirrors the rule `ProveSettlement._termsOk` enforces, and the reason is arithmetic rather
 * than policy. `feeRate` is a `uint64` against a WAD denominator, so the field reaches about
 * 1844%. Above one WAD the fee is larger than the gross and `gross - fee` underflows — a panic,
 * which `skipInvalid` cannot step over and which takes a whole batch down with it. So the
 * contract refuses the terms instead, and a client that checks here refuses them earlier.
 *
 * A rate of exactly `MAX_FEE_RATE` is legal and means the destination takes the whole fill. It
 * is an absurd offer, not an invalid one, and the contract is not in the business of saying
 * which offers are sensible.
 */
export const MAX_FEE_RATE = 10n ** 18n

/**
 * The gross to sign so the maker still receives `net` after the fee comes out.
 *
 * `minOut` stopped being a net guarantee the day the fee came out of the maker's number. This is
 * how a sign form keeps the maker's promise anyway: let them type what they will receive, derive
 * the gross, and show both. `G = ceilDiv(net * WAD, WAD - rate)`.
 *
 * **The inequality, proved, because one wei of slack in the wrong direction breaks the promise.**
 * Write `W` for one WAD and `r` for the rate, with `r < W`.
 *
 *   1. The ceiling gives `G ≥ net·W / (W − r)`, so `G·(W − r) ≥ net·W`.
 *   2. The settlement floors the fee: `fee = floor(G·r / W) ≤ G·r / W`.
 *   3. So `G − fee ≥ G − G·r/W = G·(W − r)/W ≥ net·W/W = net`.
 *
 * Every step holds in integers because each inequality only ever loses value on the side that
 * can afford to lose it. The maker is met or beaten, never missed. The overshoot is one wei of
 * token B whenever the ratio does not divide exactly, because the maker's half is
 * `ceil(G·(W − r)/W)` and `G` already sits above the exact ratio. `fee.test.ts` walks 4,000
 * pairs of a net and a rate and finds no case outside that.
 *
 * @throws RangeError when `rate` is at or above `MAX_FEE_RATE`. At one WAD the fee is the whole
 * gross and no finite number satisfies a positive net; above it the contract refuses the terms
 * outright. A caller that takes a rate from a person checks it before it gets here.
 */
export function grossForNet(net: bigint, rate: bigint): bigint {
  if (rate < 0n) throw new RangeError('a fee rate below zero is not a rate')
  if (rate >= MAX_FEE_RATE) {
    throw new RangeError(`no gross pays a net at a rate of ${rate}: the fee takes all of it`)
  }
  if (net <= 0n) return 0n
  const numerator = net * MAX_FEE_RATE
  const denominator = MAX_FEE_RATE - rate
  return (numerator - 1n) / denominator + 1n
}

/**
 * A percentage a person typed, as a rate.
 *
 * `'0.05'` is five hundredths of one per cent — five basis points — and comes back as `5e14`.
 * The unit on the screen is a percentage because that is the unit people quote fees in; the unit
 * on the wire is a fraction of one ether, and this is the only place the two meet.
 *
 * **The arithmetic is on the string, not on a float.** `0.0003 * 1e16` is `2999999999999.9995`
 * in IEEE 754 and `0.07 * 1e16` is `700000000000000.1`, so the obvious multiplication lands a wei
 * either side of what the maker typed — and which side depends on the digits they chose.
 * Splitting the digits and padding them cannot drift. (Not every value is wrong: `0.001 * 1e16`
 * happens to round to exactly `1e13`, which is what makes the bug the kind that ships.)
 *
 * Returns null for anything that is not a plain non-negative decimal, so a caller can tell "the
 * field is empty or wrong" from "the field says zero". More than 16 decimal places is finer than
 * the unit can carry, and is refused rather than truncated.
 */
export function parseFeeRate(percent: string): bigint | null {
  const text = percent.trim().replace(/%$/, '').trim()
  if (!/^\d*\.?\d*$/.test(text) || text === '' || text === '.') return null

  const [whole, fraction = ''] = text.split('.')
  if (fraction.length > 16) return null
  return BigInt(whole || '0') * PERCENT + BigInt((fraction + '0'.repeat(16)).slice(0, 16))
}

/**
 * A rate as a plain percentage string, with no trailing zeros and no unit.
 *
 * For logs, bot output and round-tripping a form field. A user interface should format the number
 * in the reader's locale instead — the app does that in `lib/i18n`, and a decimal point is not a
 * decimal point everywhere.
 */
export function formatFeeRate(rate: bigint): string {
  const whole = rate / PERCENT
  const fraction = (rate % PERCENT).toString().padStart(16, '0').replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole.toString()
}

/**
 * Why the chain would refuse these fee terms, or null when it would take them.
 *
 * The settlement's `_termsOk` fee rules, in the client:
 *
 *   feeConfig = 0, every rate 0     valid, and NO fee.
 *   feeConfig = 0, any rate > 0     refused: a signed rate is never silently dropped.
 *   any rate above one WAD          refused, at any of the three points.
 *   anything else                   valid. The contract cannot know what a hash names, so it
 *                                   accepts any `feeConfig`; whether the preimage is a valid
 *                                   config is `feeConfigFault`, and a claim of an invalid one
 *                                   reverts `InvalidConfig` while the fill books regardless.
 *
 * Every refusal comes back from `fillability` as `BadTerms_`, at every fill, for the life of the
 * intent. A signature the chain will always refuse costs the maker a signature, a board post and
 * its proof of work, and it tells them nothing. So every signer checks here first.
 */
export type FeeTermsFault =
  /** `feeConfig` is zero, which charges nothing, and the intent signed a rate anyway. */
  | { reason: 'rate-without-config'; feeRateIn: bigint; feeRate: bigint; feeRateProceeds: bigint }
  /** A rate above one WAD at one of the three points. */
  | { reason: 'rate-above-wad'; point: 'handover' | 'output' | 'proceeds'; rate: bigint }

/** The fee terms an intent carries. */
export type FeeTerms = {
  feeConfig: Hex
  /** P1, tokenIn. */
  feeRateIn: bigint
  /** P2, tokenOut, on top. */
  feeRate: bigint
  /** P3, tokenOut, out of the maker's proceeds. */
  feeRateProceeds: bigint
}

/** No fee at all: the zero config at every rate zero. */
export const NO_FEE: FeeTerms = { feeConfig: ZERO_HASH, feeRateIn: 0n, feeRate: 0n, feeRateProceeds: 0n }

/** The fault in these terms, or null. Pure; `_termsOk` for the fee fields. */
export function feeTermsFault(terms: FeeTerms): FeeTermsFault | null {
  if (terms.feeRateIn > MAX_FEE_RATE) {
    return { reason: 'rate-above-wad', point: 'handover', rate: terms.feeRateIn }
  }
  if (terms.feeRate > MAX_FEE_RATE) {
    return { reason: 'rate-above-wad', point: 'output', rate: terms.feeRate }
  }
  if (terms.feeRateProceeds > MAX_FEE_RATE) {
    return { reason: 'rate-above-wad', point: 'proceeds', rate: terms.feeRateProceeds }
  }
  if (
    terms.feeConfig === ZERO_HASH &&
    (terms.feeRateIn | terms.feeRate | terms.feeRateProceeds) !== 0n
  ) {
    return {
      reason: 'rate-without-config',
      feeRateIn: terms.feeRateIn,
      feeRate: terms.feeRate,
      feeRateProceeds: terms.feeRateProceeds,
    }
  }
  return null
}

/**
 * The rates a fill will charge on these terms, for pricing and display: all zero when the intent
 * names no config. It reads the terms alone, so it is a promise, not a snapshot.
 */
export function pricedFeeRates(terms: FeeTerms): PointRates {
  if (terms.feeConfig === ZERO_HASH) return { handover: 0n, output: 0n, proceeds: 0n }
  return { handover: terms.feeRateIn, output: terms.feeRate, proceeds: terms.feeRateProceeds }
}

/** The rate the solver bears at a fill, which `maxFeeRate` bounds: P1 + P2. */
export const solverBorneRate = (terms: FeeTerms): bigint =>
  pricedFeeRates(terms).handover + pricedFeeRates(terms).output

/** A defaults version, as `config.ts` and `FeeDefaults` carry it. */
export type DefaultFeeConfig = Pick<FeeDefaultsEntry, 'config' | 'rates' | 'warn'>

/** The terms to sign for "the defaults": their config's hash at their rates. */
export function defaultFeeTerms(def: DefaultFeeConfig): FeeTerms {
  return {
    feeConfig: hashFeeConfig(def.config),
    feeRateIn: def.rates.handover,
    feeRate: def.rates.output,
    feeRateProceeds: def.rates.proceeds,
  }
}

/** The take points whose signed rate is above the defaults' warn rate, for a warning in a form. */
export function ratesAboveWarn(terms: FeeTerms, warn: PointRates): ('handover' | 'output' | 'proceeds')[] {
  const r = pricedFeeRates(terms)
  const out: ('handover' | 'output' | 'proceeds')[] = []
  if (r.handover > warn.handover) out.push('handover')
  if (r.output > warn.output) out.push('output')
  if (r.proceeds > warn.proceeds) out.push('proceeds')
  return out
}

/** The fault, as a sentence for a log or a thrown error. A user interface words its own. */
export function feeTermsMessage(fault: FeeTermsFault): string {
  if (fault.reason === 'rate-without-config') {
    return (
      'feeConfig = 0 charges no fee, so the settlement refuses a signed rate with it. ' +
      'Name a fee config, or sign every rate at 0.'
    )
  }
  return (
    `The ${fault.point} rate ${formatFeeRate(fault.rate)}% is above 100%, and the settlement ` +
    'refuses the terms.'
  )
}

/**
 * Refuse fee terms the chain will refuse, before anything is signed.
 *
 * Throws, because a signer that reaches this with bad terms is a caller's mistake: the sign form
 * already refuses both cases and says why. This is the half that holds whatever asks.
 */
export function assertFeeTerms(terms: FeeTerms): void {
  const fault = feeTermsFault(terms)
  if (fault !== null) throw new Error(feeTermsMessage(fault))
}

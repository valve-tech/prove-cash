import { grossOut, type Window } from '../decay.ts'
import { GAS } from '../gas.ts'
import { PRICE_TOKENS, type PriceToken } from '../prices.ts'

/**
 * The Fill Console's arithmetic: one fill, and where every unit of it goes.
 *
 * The landing page must not import `@prove.cash/sdk`. That pulls viem into the entry bundle and
 * undoes the only reason the two surfaces are split — see `surface.ts`. So the settlement's
 * split, the pool's quote, the opening premium and the net-to-gross inverse are copied here, and
 * `model.test.ts` runs every copy against the SDK over a range of inputs so none of them can
 * drift. That is the same bargain `decay.ts` and `holdings.ts` already struck, and a mirror with
 * no pinning test is the defect this repo keeps finding.
 *
 * **Signed or live.** `docs/FEE-MODEL.md` Part 5 says every quantity is one or the other, and
 * mixing them produced three defects in one day. Each field below says which it is. The short
 * version: the curve, the rate, the window and the rung are signed; the market, the base fee,
 * the proceeds and the solver's residual are live. A live figure never reaches a signed one.
 *
 * **The money moves in raw token units**, as bigints, exactly as the contract counts it. Floats
 * appear only where pixels and printed text do.
 */

// ── The SDK, mirrored ─────────────────────────────────────────────────────────────────────────

/** One whole, in the units a fee rate is counted in. `sdk/src/settlement.ts` WAD. */
export const WAD = 10n ** 18n

/** One per cent of it. `sdk/src/fee.ts` PERCENT. */
export const PERCENT = 10n ** 16n

/** The arithmetic ceiling on a rate: at one WAD the fee is the whole gross. `sdk/src/fee.ts`. */
export const MAX_FEE_RATE = 10n ** 18n

/** How far above the pool's quote an offer opens when nothing prices a fill. `sdk/src/decay.ts`. */
export const DECAY_PREMIUM = 10_300_000_000_000_000n

/** PulseX keeps 0.29% of every swap. `sdk/src/config.ts` PULSEX_FEE_NUM / PULSEX_FEE_DEN. */
export const POOL_FEE_NUM = 9971n
export const POOL_FEE_DEN = 10_000n

/**
 * The window past which the app warns on a wallet signature. `sdk/src/settlement.ts`.
 *
 * Advice, not a rule: since `a7c5d7f` the settlement refuses no window on any rung, because a
 * stale signature costs the maker who signed it and nobody else.
 */
export const SUGGESTED_WALLET_WINDOW_S = 60 * 60

/**
 * The fee the settlement books, floored, so the dust of the split stays with the maker.
 *
 * Mirrors `feeOn` in `sdk/src/settlement.ts`. The rate here is already `rateOf`: a maker who
 * named no destination signs a rate of zero as far as this is concerned.
 */
export function feeOn(gross: bigint, rate: bigint): bigint {
  return (gross * rate) / WAD
}

/** What one fill splits into. `gross === delivered + fee`, always. */
export type Split = { gross: bigint; delivered: bigint; fee: bigint }

/**
 * The three numbers a fill produces, from the signed curve and the moment it lands.
 *
 * Mirrors `quote` in `sdk/src/settlement.ts`. The gross rounds up and the fee rounds down, so
 * rounding favours the maker twice; `delivered` is exact by subtraction.
 */
export function quote(w: Window, take: bigint, at: bigint, rate: bigint): Split {
  const gross = grossOut(w, take, at)
  const fee = feeOn(gross, rate)
  return { gross, delivered: gross - fee, fee }
}

/**
 * The gross to sign so the maker still receives `net` after the fee comes out.
 *
 * Mirrors `grossForNet` in `sdk/src/fee.ts`, and it is the whole reason a fee still costs the
 * maker time. `minOut` stopped being a net guarantee the day the fee came out of the maker's
 * number; a sign form keeps the promise by letting the maker type what they receive and deriving
 * the gross from it. `G = ceilDiv(net * WAD, WAD - rate)`, and `G - floor(G*r/WAD) >= net`.
 */
export function grossForNet(net: bigint, rate: bigint): bigint {
  if (rate < 0n) throw new RangeError('a fee rate below zero is not a rate')
  if (rate >= MAX_FEE_RATE) {
    throw new RangeError(`no gross pays a net at a rate of ${rate}: the fee takes all of it`)
  }
  if (net <= 0n) return 0n
  return (net * MAX_FEE_RATE - 1n) / (MAX_FEE_RATE - rate) + 1n
}

/**
 * What a constant-product pool pays for `amountIn`, fee and price impact included.
 *
 * Mirrors `poolAmountOut` in `sdk/src/solver/price.ts`, which is UniswapV2's `getAmountOut`
 * integer for integer. Null when the pool cannot answer, which is what a pair with no measured
 * depth gets.
 */
export function poolAmountOut(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
): bigint | null {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return null
  const withFee = amountIn * POOL_FEE_NUM
  return (withFee * reserveOut) / (reserveIn * POOL_FEE_DEN + withFee)
}

/** What `suggestDecay` needs. Mirrors `DecayInputs` in `sdk/src/decay.ts`. */
export type DecayInputs = {
  floor: bigint
  poolQuote?: bigint | null
  fillCost?: bigint
  premium?: bigint
}

/** The two ends of the curve, ready to sign. Mirrors `Decay` in `sdk/src/decay.ts`. */
export type Decay = { minOutStart: bigint; minOutEnd: bigint }

const minOf = (a: bigint, b: bigint): bigint => (a < b ? a : b)

/** Half of what the maker already gave up. Mirrors the private `headroom` in `sdk/src/decay.ts`. */
function headroom(floor: bigint, quote: bigint): bigint {
  if (floor >= quote) return 0n
  return ((quote - floor) * WAD) / quote / 2n
}

/**
 * How far above the quote to open. Mirrors the private `premiumFor` in `sdk/src/decay.ts`.
 *
 * **The rate is deliberately not in it.** It used to be, because the filler paid the fee on top
 * of the delivery. The settlement takes the fee out of the maker's number now, so a fill costs a
 * filler gas and nothing else, and a rate here would ask the market for a concession no filler
 * needs. The mockup this console was drawn from still added it; the SDK does not.
 */
function premiumFor(x: DecayInputs): bigint {
  if (x.premium !== undefined) return x.premium
  const q = x.poolQuote ?? 0n
  if (q <= 0n) return DECAY_PREMIUM
  const wanted = x.fillCost === undefined ? DECAY_PREMIUM : (x.fillCost * WAD) / q
  if (x.floor >= q) return wanted
  return minOf(wanted, headroom(x.floor, q))
}

/**
 * The two ends of a decay, from the maker's floor and what the pool pays today.
 *
 * Mirrors `suggestDecay` in `sdk/src/decay.ts`. No quote, or a floor at or above it, gives a flat
 * order at the maker's own number.
 */
export function suggestDecay(x: DecayInputs): Decay {
  const floor = x.floor
  const q = x.poolQuote ?? 0n
  const flat = { minOutStart: floor, minOutEnd: floor }
  if (floor <= 0n || q <= 0n) return flat
  const start = q + (q * premiumFor(x)) / WAD
  return start > floor ? { minOutStart: start, minOutEnd: floor } : flat
}

// ── The dated snapshot ────────────────────────────────────────────────────────────────────────

/**
 * PulseChain mainnet, chain 369, read through the valve gateway on 2026-09-03. A snapshot, never
 * live: a prerendered page cannot ask a node anything, and this one is read by a crawler as often
 * as by a person.
 *
 * Everything here is measured. Nothing is chosen, and the console says the date on screen.
 */
export const SNAPSHOT = {
  asOf: '2026-09-03',
  /** `eth_feeHistory` over 129 consecutive blocks, about 22 minutes. Base fee in gwei. */
  gwei: { min: 627_841, p25: 731_740, median: 783_379, p75: 867_639, max: 1_308_703, blocks: 129 },
  /** The PulseX v2 WPLS/DAI pair, and its reserves in whole tokens. */
  pair: '0xe56043671df55de5cdf8459710433c10324de0ae',
  reserves: { WPLS: 40_916_996_419, DAI: 455_736 },
} as const

/**
 * PLS in dollars, from the pool's own ratio: 455,736 / 40,916,996,419 = $0.000011138.
 *
 * Derived rather than typed, so the spot price and the price impact agree to the wei. Gas is the
 * only thing this prices, because gas is PLS and nothing else on the page is.
 */
export const PLS_USD = SNAPSHOT.reserves.DAI / SNAPSHOT.reserves.WPLS

/** The base fee the curve is shaped against at signing: the median, not an anecdote. */
export const REF_GWEI = SNAPSHOT.gwei.median

/** The base-fee slider's ends, six decades on a log track. */
export const GWEI_LO = 100_000
export const GWEI_HI = 100_000_000_000

/** The trade-size slider's ends, in dollars, on a log scale. */
export const SIZE_LO = 0.01
export const SIZE_HI = 100_000

/** The rate slider's ceiling. The sign form refuses a typed rate above 20%; this stops at 2%. */
export const MAX_SLIDER_RATE = 2n * PERCENT

// ── The pair ──────────────────────────────────────────────────────────────────────────────────

export type ConsoleToken = {
  address: `0x${string}`
  symbol: string
  decimals: number
  /** Indicative dollars, read on `SNAPSHOT.asOf`. WPLS is the pool's own ratio and is exact. */
  usd: number
}

/**
 * The four mainnet presets the console draws, copied from `sdk/src/config.ts`.
 *
 * Copied rather than imported, for the reason at the top of this file. `model.test.ts` compares
 * them to `presetTokens(369)`, so a preset that moves on one side fails on the other. The list
 * there is longer — it carries the x402 wrappers too — and these are its first four, which are
 * the ones anybody trades.
 */
export const TOKENS: readonly ConsoleToken[] = [
  {
    address: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27',
    symbol: 'WPLS',
    decimals: 18,
    usd: PLS_USD,
  },
  {
    address: '0x95B303987A60C71504D99Aa1b13B4DA07b0790ab',
    symbol: 'PLSX',
    decimals: 18,
    usd: 0.000012,
  },
  { address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39', symbol: 'HEX', decimals: 8, usd: 0.0035 },
  { address: '0xefD766cCb38EaF1dfd701853BFCe31359239F305', symbol: 'DAI', decimals: 18, usd: 1.0 },
]

/**
 * Which slice of PulseX's own fee reaches its buy-and-burn.
 *
 * The pool keeps 0.29% of every swap; that is the toll any AMM route pays, and it is the solver's
 * cost rather than a party this protocol pays. One slice is carved OUT of that 0.29% and never
 * added to it: `PulseXPair._mintFee` mints LP tokens to `factory.feeTo()` out of the fee growth
 * since the last mint or burn, and on mainnet both factories name the buy-and-burn, whose
 * `convertLps` destroys the PLSX it buys. A denominator of `rootK * phi + rootKLast` hands
 * `feeTo` `1 / (1 + phi)` of the growth — the Uniswap V2 derivation.
 *
 * Read from the verified pair source on scan.pulsechain.com, 2026-09-03. Neither share has been
 * checked against an observed mint on chain, and the console says so.
 */
export const VENUES = {
  v2: { burnNum: 7, burnDen: 29 },
  v1: { burnNum: 1, burnDen: 1 },
} as const

export type Venue = keyof typeof VENUES

// ── The custody rungs ─────────────────────────────────────────────────────────────────────────

/**
 * The two rungs `Gas.t.sol` prices as a whole single fill, and what each costs.
 *
 * The mockup carried five. Three of them — authorization, permit and permit2 — have no row in
 * `gas.ts` that is a whole call, and the nearest figures are marginal legs of a batch. Printing
 * a batch's marginal cost beside a whole call's is the "individually correct, nonsense beside its
 * neighbour" failure `docs/FEE-MODEL.md` opens with, so the console offers the two the test
 * measures. Adding the other three is a `Gas.t.sol` job, not an app one.
 *
 * `allowance` is the difference that matters here: it is armed by a standing ERC-20 allowance the
 * contract cannot see, so revoking it stops fills and cancels nothing — approving that token
 * again later brings the signature back, and only `cancel` ends one.
 */
export const RUNGS = {
  allowance: {
    warm: GAS['fill, allowance, warm'].total,
    cold: GAS['fill, allowance, first touch'].total,
    allowance: true,
  },
  escrow: {
    warm: GAS['fill, escrow, warm'].total,
    cold: GAS['fill, escrow, cold slots'].total,
    allowance: false,
  },
} as const

export type Rung = keyof typeof RUNGS
export const RUNG_ORDER: readonly Rung[] = ['allowance', 'escrow']

/** Gas per intent in a batch of `n`, from the two measured anchors. */
export const BATCH_MARGINAL = GAS['fillBatch marginal intent'].each
export const BATCH_FIXED = GAS['fillBatch x20, one token'].total - 20 * BATCH_MARGINAL
export const perIntentGas = (n: number): number => BATCH_MARGINAL + BATCH_FIXED / n

// ── The market: a real week, not a random walk ────────────────────────────────────────────────

/**
 * The market behind the offer, taken from `prices.ts`.
 *
 * It was a seeded random walk at an assumed volatility. A walk has none of the clustering, the
 * flat stretches or the jumps a real tape has, and an assumed sigma is a number somebody chose.
 * `prices.ts` ships 169 hours of real hourly prices on the same hours for seven tokens, so the
 * ratio of any two of them is a real exchange rate over a real week, and it costs the bundle
 * nothing. `market.ts` already draws the hero from it for the same reason.
 *
 * **The moves are real and the pair is not this one.** None of the PulseChain presets is in that
 * series, so a stretch is normalised to 1 at its first hour and applied as a multiplier on what
 * the pool pays. The console names the pair and the date it borrowed, on screen, in the panel
 * head and again in the tip. A borrowed real week beats an invented one; it does not beat a
 * measurement of this pair, and the page does not claim it does.
 *
 * This is also why the window is measured in hours. Hourly samples inside a sixty-minute window
 * draw one straight line, which would be an honest picture of nothing.
 */
export type MarketPath = {
  /** A multiplier on the signing quote, one per hour, `hours + 1` long and starting at 1. */
  series: readonly number[]
  from: PriceToken
  to: PriceToken
  /** Which hour of the sampled week it starts at. */
  startHour: number
}

/** The longest stretch `prices.ts` can supply. 169 samples is 168 whole hours. */
export const MAX_HOURS = 168

/** Every ordered pair whose ratio moves. Two stablecoins draw a flat line, so they are not one. */
const MARKET_PAIRS: readonly [PriceToken, PriceToken][] = PRICE_TOKENS.flatMap((from) =>
  PRICE_TOKENS.filter((to) => to !== from && !(from.stable && to.stable)).map(
    (to) => [from, to] as [PriceToken, PriceToken],
  ),
)

/**
 * One real stretch of the week, chosen by `step`.
 *
 * `step` is what the reshuffle control increments. The pair turns over first and the start hour
 * strides by a prime, so consecutive steps land on unrelated stretches rather than on the same
 * week shifted by an hour. Deterministic, so the prerendered frame and the live page agree.
 */
export function marketPath(step: number, hours: number): MarketPath {
  const span = Math.max(1, Math.min(MAX_HOURS, Math.round(hours)))
  const k = ((step % MARKET_PAIRS.length) + MARKET_PAIRS.length) % MARKET_PAIRS.length
  const pair = MARKET_PAIRS[k] as [PriceToken, PriceToken]
  const [from, to] = pair
  const room = Math.max(1, MAX_HOURS - span + 1)
  const startHour = (Math.abs(Math.trunc(step)) * 23) % room
  const ratio = (i: number): number => {
    const a = from.usd[startHour + i] ?? 1
    const b = to.usd[startHour + i] ?? 1
    return b === 0 ? 1 : a / b
  }
  const base = ratio(0)
  const series: number[] = []
  for (let i = 0; i <= span; i++) series.push(base === 0 ? 1 : ratio(i) / base)
  return { series, from, to, startHour }
}

/** A series read at a fractional index, with a straight line between samples. */
export function sampleAt(series: readonly number[], x: number): number {
  const c = Math.min(series.length - 1, Math.max(0, x))
  const i = Math.floor(c)
  const a = series[i] ?? 1
  const b = series[Math.min(i + 1, series.length - 1)] ?? a
  return a + (b - a) * (c - i)
}

// ── The console's own model ───────────────────────────────────────────────────────────────────

export type Settings = {
  /** Signed: the pair the maker names. */
  tokenIn: ConsoleToken
  tokenOut: ConsoleToken
  /** Signed: what the maker is selling, in dollars at the snapshot's prices. */
  sizeUsd: number
  /** Signed: how far below the pool's quote the maker's NET floor sits, as a fraction. */
  floorPct: number
  /** Signed: the fee rate, as a fraction of one WAD. */
  feeRate: bigint
  /** Signed: a decaying offer, or a flat limit order at the floor. */
  dutch: boolean
  /** Signed: seconds after signing that the offer opens and expires. */
  opensSec: number
  expiresSec: number
  /** Signed: which custody rung arms it. */
  rung: Rung
  /** Signed: a first fill into an empty balance, or the warm case. */
  cold: boolean
  /** Live: where the solver sells, which decides only the burn share. */
  venue: Venue
  /** Live: the base fee a solver pays now. */
  baseFeeGwei: number
  /** Live: the second inside the window the reader is standing at. */
  atSec: number
  /** Live: which real stretch of the sampled week the market is taken from. */
  step: number
}

export type Model = {
  /** False when both sides name the same token. The app refuses to sign it too. */
  ok: boolean
  /** True when an allowance rung carries a window the app warns about. */
  zombie: boolean
  a: ConsoleToken
  b: ConsoleToken

  // ── signed ──
  /** The maker's `amountIn`, in raw token A. */
  amountIn: bigint
  /** The signed curve, in the contract's own fields. */
  w: Window
  /** The net the maker typed, in raw token B. Their receipt is met or beaten, never missed. */
  floorNet: bigint
  /** The gross that net signs at this rate: `minOutEnd`. */
  floorGross: bigint
  /** What the pool paid for this size at signing. Zero when the pair has no measured depth. */
  quoteSign: bigint
  /** The spot value of the trade at signing, before the pool's fee and impact. */
  spotSign: bigint
  /** True when the pair has measured reserves, so the drawing carries price impact. */
  measuredDepth: boolean

  // ── live ──
  /** Gas units for this rung, and what they cost now. */
  gasUnits: number
  gasPls: number
  gasUsd: number
  gasB: bigint
  /** The market's multiplier on the signing quote, at `atSec`. */
  move: number
  /** What the pool pays now, in raw token B. */
  proceeds: bigint
  /** What the swap is worth now before the pool takes anything: the flow diagram's whole column. */
  spotNow: bigint
  /** The pool's own 0.29% and the impact the size pays, together and apart. */
  poolKeeps: bigint
  poolFeePart: bigint
  poolImpact: bigint
  /** The slice of the pool's fee minted to the buy-and-burn and destroyed as PLSX. */
  burn: bigint
  /** The split, at `atSec`. `gross === delivered + fee`. */
  gross: bigint
  delivered: bigint
  fee: bigint
  /** `proceeds − gross − gas`. The one definition of the solver's take on this page. */
  solver: bigint
  /** `proceeds − delivered`, which is exactly `fee + solver + gas`. */
  spread: bigint
  /** True when the solver is ahead here. */
  fills: boolean
  /** The market path, and the whole series, for the drawing. */
  path: MarketPath
  /** What the pool pays at a second inside the window, in raw token B. */
  proceedsAt: (sec: number) => bigint
  /** The signed curve's gross at a second inside the window, in raw token B. */
  grossAt: (sec: number) => bigint
  /**
   * The first second the offer clears, if the market holds exactly where it is now. Arithmetic,
   * not a term of the offer. `Infinity` when the floor plus gas is still above the market.
   */
  crossHeld: number
  /** The same, at a rate of zero: what naming a destination costs the maker in time. */
  crossHeldFree: number
  /** The first second on the drawn path where a solver is ahead. Hindsight, never the answer. */
  crossPath: number
  /** The smallest trade a solver still fills, in raw token A. `null` when no size works. */
  breakEven: bigint | null
  /**
   * The highest base fee at which this fill still pays for itself, in gwei. `null` when the
   * margin before gas is already zero or negative — free gas would not help.
   */
  breakEvenGwei: number | null
  /** The window's span in seconds, and the rate as a fraction, for the drawing. */
  windowSec: number
  rate: bigint
  /** Where inside the window the reader is standing, clamped to it. */
  at: number
}

/** A float amount as raw token units. */
export const units = (v: number, decimals: number): bigint =>
  BigInt(Math.max(0, Math.round(v * 10 ** decimals)))

/** Raw token units as a float. */
export const amountOf = (raw: bigint, decimals: number): number =>
  Number(raw) / 10 ** decimals

/** All zeros: the straight line, and what every offer this console draws signs. */
const CURVE_LINEAR = `0x${'00'.repeat(32)}` as const


/**
 * One fill, at one size and one moment: the whole chain from the maker's dollars to the solver's
 * residual, and nothing that needs a search.
 *
 * Separate from `build` because the break-even size is found by bisecting this, and a
 * linearisation is not good enough. The gross is not proportional to the size — the pool's
 * quote carries price impact, and the opening premium is capped at half the maker's concession —
 * so a straight line through the current point crosses zero somewhere the real function does not,
 * and the console would print a size beside a bar that disagreed with it.
 *
 * The order is the one `docs/FEE-MODEL.md` Part 5 asks for: signed first, from the snapshot
 * alone, and live after, never reaching back.
 */
type Leg = {
  amountIn: bigint
  spotSign: bigint
  quoteSign: bigint
  floorNet: bigint
  floorGross: bigint
  w: Window
  gasB: bigint
  move: number
  proceeds: bigint
  spotNow: bigint
  split: Split
  solver: bigint
}

type Frame = {
  a: ConsoleToken
  b: ConsoleToken
  ok: boolean
  measuredDepth: boolean
  reserveIn: number
  reserveOut: number
  windowSec: number
  gasUnits: number
  gasB: bigint
  path: MarketPath
  moveAt: (sec: number) => number
}

/** Everything that does not change with the trade size, worked out once. */
function frameOf(s: Settings): Frame {
  const a = s.tokenIn
  const b = s.tokenOut
  const ok = a.address !== b.address
  const windowSec = Math.max(1, s.expiresSec - s.opensSec)
  const reserves = SNAPSHOT.reserves as Record<string, number | undefined>
  const rIn = reserves[a.symbol]
  const rOut = reserves[b.symbol]
  const measuredDepth = ok && rIn !== undefined && rOut !== undefined

  const gasUnits = RUNGS[s.rung][s.cold ? 'cold' : 'warm']
  const gasB = units((gasUnits * s.baseFeeGwei * 1e-9 * PLS_USD) / b.usd, b.decimals)

  const path = marketPath(s.step, windowSec / 3600)
  const last = path.series.length - 1
  const moveAt = (sec: number): number =>
    sampleAt(path.series, (Math.max(0, Math.min(windowSec, sec)) / windowSec) * last)

  return {
    a,
    b,
    ok,
    measuredDepth,
    reserveIn: measuredDepth ? (rIn as number) : 0,
    reserveOut: measuredDepth ? (rOut as number) : 0,
    windowSec,
    gasUnits,
    gasB,
    path,
    moveAt,
  }
}

/** The curve a maker signs for `sizeUsd`, at `rate`. Signed only: no market, no live gas. */
function signedLeg(s: Settings, f: Frame, sizeUsd: number, rate: bigint) {
  const amountIn = units(sizeUsd / f.a.usd, f.a.decimals)
  const spotSign = f.ok ? units(sizeUsd / f.b.usd, f.b.decimals) : 0n
  const quoteSign = f.measuredDepth
    ? (poolAmountOut(
        units(f.reserveIn, f.a.decimals),
        units(f.reserveOut, f.b.decimals),
        amountIn,
      ) ?? 0n)
    : (spotSign * POOL_FEE_NUM) / POOL_FEE_DEN

  const floorNet = (spotSign * units(1 - s.floorPct, 9)) / 10n ** 9n
  const floorGross = grossForNet(floorNet, rate)

  // `Compose.tsx:144` signs `suggestDecay({ floor, poolQuote })` and passes no `fillCost`, so the
  // premium is `DECAY_PREMIUM` capped at half the maker's concession. The console signs what the
  // app signs.
  //
  // **No gas figure reaches this call, and that is deliberate.** `docs/FEE-MODEL.md` Part 5
  // records the defect: this console once passed live gas into the opening premium, so dragging
  // the base-fee slider moved the maker's own curve. A maker's signed terms cannot answer to what
  // gas does after they sign.
  const ends = s.dutch
    ? suggestDecay({ floor: floorGross, poolQuote: quoteSign })
    : { minOutStart: floorGross, minOutEnd: floorGross }

  const w: Window = {
    amountIn: amountIn > 0n ? amountIn : 1n,
    minOutStart: ends.minOutStart,
    minOutEnd: ends.minOutEnd,
    startTime: BigInt(s.opensSec),
    endTime: BigInt(s.expiresSec),
    curve: CURVE_LINEAR,
    flags: 0,
  }
  return { amountIn, spotSign, quoteSign, floorNet, floorGross, w }
}

function legAt(s: Settings, f: Frame, sizeUsd: number, atSec: number, rate: bigint): Leg {
  const signed = signedLeg(s, f, sizeUsd, rate)
  const at = Math.max(0, Math.min(f.windowSec, atSec))
  const move = f.moveAt(at)
  const scale = units(move, 9)
  const proceeds = (signed.quoteSign * scale) / 10n ** 9n
  const spotNow = (signed.spotSign * scale) / 10n ** 9n
  const split = quote(signed.w, signed.w.amountIn, BigInt(s.opensSec + Math.round(at)), rate)
  return {
    ...signed,
    gasB: f.gasB,
    move,
    proceeds,
    spotNow,
    split,
    solver: proceeds - split.gross - f.gasB,
  }
}

/**
 * Everything the console draws, from one settings object.
 *
 * Every figure here is either signed or live, and each field on `Model` says which. Dragging the
 * base fee moves the solver's residual and nothing the maker signed — which is a defect this
 * console has already shipped once, and `model.test.ts` now stands over it.
 */
export function build(s: Settings): Model {
  const f = frameOf(s)
  const rate = s.feeRate
  const at = Math.max(0, Math.min(f.windowSec, s.atSec))
  const leg = legAt(s, f, s.sizeUsd, at, rate)

  const proceedsAt = (sec: number): bigint =>
    (leg.quoteSign * units(f.moveAt(sec), 9)) / 10n ** 9n
  const grossAt = (sec: number): bigint =>
    grossOut(leg.w, leg.w.amountIn, BigInt(s.opensSec + Math.max(0, Math.round(sec))))

  // The pool's cut is the difference between what the swap was worth and what the pool paid.
  // The fee part is the 0.29%; whatever is left is the impact this size pushed the price by.
  const poolKeeps = leg.spotNow > leg.proceeds ? leg.spotNow - leg.proceeds : 0n
  const poolFeePart = (leg.spotNow * (POOL_FEE_DEN - POOL_FEE_NUM)) / POOL_FEE_DEN
  const poolImpact = poolKeeps > poolFeePart ? poolKeeps - poolFeePart : 0n
  const venue = VENUES[s.venue]
  const burn = (poolFeePart * BigInt(venue.burnNum)) / BigInt(venue.burnDen)

  // ── the crossings ───────────────────────────────────────────────────────────────────────────
  // A solver standing at `at` knows the current market, the current offer and its own costs, and
  // nothing else. So the answer here is binary, and the forward number is CONDITIONAL: if the
  // market stays exactly where it is, the decay alone says when the offer first clears gas. No
  // future sample of the path is consulted.
  //
  // `proceeds − gross − gas > 0`, and the rate is not in that condition. It reaches the crossing
  // only because a maker who typed a net signs a larger gross — see `docs/FEE-MODEL.md` Part 3.
  const crossHeldAt = (r: bigint): number => {
    const target = leg.proceeds - leg.gasB
    if (target <= 0n) return Infinity
    const wR = r === rate ? leg.w : signedLeg(s, f, s.sizeUsd, r).w
    if (wR.minOutEnd > target) return Infinity
    if (grossOut(wR, wR.amountIn, BigInt(s.opensSec)) <= target) return 0
    // The curve falls, so bisect to the second. `grossOut` rounds up: half a second is not a fill.
    let lo = 0
    let hi = f.windowSec
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2)
      if (grossOut(wR, wR.amountIn, BigInt(s.opensSec + mid)) <= target) hi = mid
      else lo = mid
    }
    return grossOut(wR, wR.amountIn, BigInt(s.opensSec + hi)) <= target ? hi : Infinity
  }
  const crossHeld = crossHeldAt(rate)
  const crossHeldFree = crossHeldAt(0n)

  // Hindsight only: what this one real stretch actually did. Shown dim, never as the answer.
  let crossPath = Infinity
  const steps = f.path.series.length - 1
  for (let i = 0; i <= steps; i++) {
    const sec = (i / steps) * f.windowSec
    if (proceedsAt(sec) - grossAt(sec) - leg.gasB > 0n) {
      crossPath = sec
      break
    }
  }

  // ── break-even size ─────────────────────────────────────────────────────────────────────────
  // At this moment and at this market: the same `at`, the same stretch and the same rate as the
  // spread bar, so the two agree by construction. Gas is fixed in PLS while the spread scales
  // with the size, so there is a smallest trade a solver still fills.
  //
  // Bisected on the real function rather than on a straight line through it. The gross is not
  // proportional to the size, so a linear solve lands on the wrong side of zero — measured at
  // 0.000066 DAI on the resting frame, which is small and is still the wrong answer.
  const solverAt = (usd: number): bigint => legAt(s, f, usd, at, rate).solver
  let breakEven: bigint | null = null
  if (f.ok) {
    let hi = 0
    for (const probe of [s.sizeUsd, SIZE_HI / 10, SIZE_HI, SIZE_HI * 10]) {
      if (solverAt(probe) > 0n) {
        hi = probe
        break
      }
    }
    if (hi > 0) {
      let lo = 0
      for (let i = 0; i < 60 && hi - lo > hi * 1e-9; i++) {
        const mid = (lo + hi) / 2
        if (solverAt(mid) > 0n) hi = mid
        else lo = mid
      }
      breakEven = units(hi / f.a.usd, f.a.decimals)
    }
  }

  // ── break-even gas price ────────────────────────────────────────────────────────────────────
  // The other side of the same coin as the break-even size: gas is fixed in PLS while the
  // spread scales with size, so there is also a highest base fee this fill still clears. Same
  // moment and market as the size figure and the spread bar. Linear in gwei, so no search.
  const margin = leg.proceeds - leg.split.gross
  let breakEvenGwei: number | null = null
  if (f.ok && margin > 0n && f.gasUnits > 0) {
    breakEvenGwei =
      (amountOf(margin, f.b.decimals) * f.b.usd) / (f.gasUnits * 1e-9 * PLS_USD)
  }

  return {
    ok: f.ok,
    zombie:
      RUNGS[s.rung].allowance &&
      (f.windowSec > SUGGESTED_WALLET_WINDOW_S || s.opensSec > SUGGESTED_WALLET_WINDOW_S),
    a: f.a,
    b: f.b,
    amountIn: leg.amountIn,
    w: leg.w,
    floorNet: leg.floorNet,
    floorGross: leg.floorGross,
    quoteSign: leg.quoteSign,
    spotSign: leg.spotSign,
    measuredDepth: f.measuredDepth,
    gasUnits: f.gasUnits,
    gasPls: f.gasUnits * s.baseFeeGwei * 1e-9,
    gasUsd: f.gasUnits * s.baseFeeGwei * 1e-9 * PLS_USD,
    gasB: leg.gasB,
    move: leg.move,
    proceeds: leg.proceeds,
    spotNow: leg.spotNow,
    poolKeeps,
    poolFeePart,
    poolImpact,
    burn,
    gross: leg.split.gross,
    delivered: leg.split.delivered,
    fee: leg.split.fee,
    solver: leg.solver,
    spread: leg.proceeds - leg.split.delivered,
    fills: f.ok && leg.solver > 0n,
    path: f.path,
    proceedsAt,
    grossAt,
    crossHeld,
    crossHeldFree,
    crossPath,
    breakEven,
    breakEvenGwei,
    windowSec: f.windowSec,
    rate,
    at,
  }
}

/**
 * The curve the same maker would sign at a different rate, and nothing else.
 *
 * The chart draws three of these — no fee, the reader's rate, and the slider's ceiling — because
 * the rate no longer appears in the solver's condition and so no longer moves the break-even
 * line. What it moves is the offer itself: a maker who typed a net signs a larger gross at a
 * larger rate, so the curve rises and the crossing slides right. The fan is the same picture the
 * mockup drew, the other way up.
 */
export function signedWindow(s: Settings, rate: bigint): Window {
  return signedLeg(s, frameOf(s), s.sizeUsd, rate).w
}

/**
 * The rate whose fee takes `share` of the spread, found by bisection.
 *
 * The spread bar's first mark is draggable, and the arithmetic runs the wrong way for algebra:
 * the fee is `gross × rate`, and the gross itself rises with the rate because the maker typed a
 * net. Twenty-four halvings settle it far finer than the mark can be dragged.
 */
export function rateForShare(s: Settings, m: Model, share: number): bigint {
  if (!(m.spread > 0n)) return 0n
  const target = Number(m.spread) * Math.max(0, Math.min(1, share))
  const f = frameOf(s)
  const at = BigInt(s.opensSec + Math.round(m.at))
  // The fee at a rate, and nothing else. Calling `build` here would run its break-even search
  // twenty-four times for every pixel the mark is dragged, and none of that search's answer is
  // wanted — only `gross × rate`.
  const feeAt = (r: bigint): number => {
    const w = signedLeg(s, f, s.sizeUsd, r).w
    return Number(feeOn(grossOut(w, w.amountIn, at), r))
  }
  let lo = 0n
  let hi = MAX_SLIDER_RATE
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2n
    if (feeAt(mid) < target) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * The base fee whose gas takes `gasShare` of the spread.
 *
 * The spread bar's second mark is draggable. Only gas moves it (`geometry.ts` `barFrame`), and
 * the conversion is linear in gwei once the spread and the gas units are fixed — no search.
 * Clamped to the same track the gas-price slider uses so a drag cannot invent a reading the
 * rest of the console refuses.
 */
export function gweiForGasShare(s: Settings, m: Model, gasShare: number): number {
  if (!(m.spread > 0n) || m.gasUnits <= 0) return s.baseFeeGwei
  const share = Math.max(0, Math.min(1, gasShare))
  if (share === 0) return GWEI_LO
  const gasB = Number(m.spread) * share
  const gasUsd = (gasB / 10 ** m.b.decimals) * m.b.usd
  const gwei = gasUsd / (m.gasUnits * 1e-9 * PLS_USD)
  if (!Number.isFinite(gwei)) return s.baseFeeGwei
  return Math.max(GWEI_LO, Math.min(GWEI_HI, Math.round(gwei)))
}

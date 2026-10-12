/**
 * Choosing the two ends of an intent's decay.
 *
 * `Intent.minOutStart` and `Intent.minOutEnd` are the price of an offer at the two ends of its
 * window, and `Intent.curve` says where between them the price sits at each moment. This module
 * picks the two ends and nothing else: the shape it assumes is the straight line, which is the
 * zero word and every kind's default.
 *
 * When the two ends are equal the offer is a flat limit order: one price for the whole window,
 * whatever the curve says, and the first valid transaction wins it. That is a latency race, and
 * the maker takes nothing from it.
 *
 * When the start sits above the end, the same offer is a descending auction. Every filler watches
 * the price fall towards their own cost, and the first one whose cost it reaches takes the fill —
 * so the maker is paid what the *best* filler can afford, not what the fastest one chooses to
 * offer. That is the whole reason the decay exists, and it is why the app now signs one by
 * default.
 *
 * The maker types one number, and it is the floor: the least they will accept, the end of the
 * curve, the guarantee. This module picks the other end.
 *
 * Everything here is pure. Nothing fetches, and nothing reads a clock. The caller passes the pool
 * quote in and signs the numbers that come out.
 */

/** One ether, the unit every rate in this protocol is a fraction of. */
const ONE = 10n ** 18n

/**
 * How far above the pool's own quote an offer opens, as a fraction of one ether.
 *
 * **What the premium buys.** The start is a ceiling on what the maker can be paid. Open at the
 * quote and the maker keeps nothing when the pool moves their way between signing and the first
 * block: the offer is already fillable, so the tick goes to whoever fills it. Open above the
 * quote and that move is the maker's, up to the premium. It is not paid for in price — the curve
 * still ends at the floor the maker typed — it is paid for in time, because a higher start
 * crosses a given filler's cost later in the window.
 *
 * **Why this size.** A move smaller than a fill's own cost cannot change anything: a filler who
 * is a hair better off still has to clear gas before they will send a transaction. So
 * one fill's cost is the smallest premium that buys the maker anything, and the arithmetic for it
 * is already in this repo.
 *
 *   - `fee.ts` measured a fill on PulseChain 369 at a base fee of 843,373 gwei: 449 to 921 PLS,
 *     which was $0.0061 to $0.0126.
 *   - The smallest ticket the protocol prices is a heartbeat intent, about $0.62.
 *   - The cheap end of that fill against that ticket is 0.0061 / 0.62 = 0.98%.
 *   - The protocol fee is not added to that. The settlement takes it out of the maker's own
 *     number, so the filler pays the gross whatever rate the intent signed. This number was
 *     1.08% while the fee rode on top; the 0.1% came out with the fee.
 *
 * The constant stays at 1.03% all the same. It is the fallback for a caller who cannot price a
 * fill, it sits above the 0.98% the measurement gives, and the minute-by-minute table below was
 * run at that number. An over-large premium delays the crossing and never lowers the price.
 *
 * The cheap end and not the dear one, because the cheapest filler is the one who wins a descending
 * auction, and the premium only has to be worth something to them.
 *
 * **Not the gas table.** `app/src/landing/gas.ts` says a warm allowance fill is 124,975 gas, which
 * at that base fee is 98 PLS — under a fifth of the 449 PLS a whole fill cost. The rest is the swap
 * the filler unwinds through and the transaction they carry it in. Sizing the premium from the
 * settlement's own gas would have been about five times too small.
 *
 * That ratio has moved and the conclusion has not. It read a sixteenth when the same row measured
 * 33,403, before the curve, the booked fee and the parked source landed; the settlement's share of
 * a real fill has grown from a sixteenth to a fifth and is still the minority of it. The 449 PLS is
 * a 2026 measurement on 369 and the ratio is only worth quoting against a fill measured beside it.
 *
 * It is a fraction, so on a ticket larger than a heartbeat the premium is more than a fill costs.
 * That is the safe direction: an over-large start delays the crossing, and never lowers the price,
 * because the curve ends at the maker's floor whatever the start was.
 */
export const DECAY_PREMIUM = 10_300_000_000_000_000n

/** What `suggestDecay` needs. Every value comes from the caller; nothing is read here. */
export type DecayInputs = {
  /**
   * The least the maker will accept for the whole `amountIn`, in raw token B units. This is the
   * number they typed, and it comes back untouched as `minOutEnd`.
   */
  floor: bigint
  /**
   * What the market pays for this size right now, in the same units — for the app, `poolPays` on
   * the reserve snapshot the chart is already drawn from. Null or absent when there is no pool to
   * ask, and then the answer is a flat order.
   */
  poolQuote?: bigint | null
  /**
   * What one fill costs the party filling, in the same units as `poolQuote` — gas, priced in
   * token B. Given this, the premium is that cost as a fraction of the trade, which is the
   * number the reasoning on `DECAY_PREMIUM` actually implies. Absent, the premium falls back to
   * that constant.
   */
  fillCost?: bigint
  /** Override the premium outright. Nothing in the app passes this; it is here for a caller who
   *  has priced the auction some other way. */
  premium?: bigint
}

/** The two ends of the curve, ready to sign. `minOutEnd <= minOutStart` always holds. */
export type Decay = { minOutStart: bigint; minOutEnd: bigint }

/**
 * The two ends of a decay, from the maker's floor and what the pool pays today.
 *
 * The start is the quote plus the premium, and never below the floor. Three things follow:
 *
 * **No quote, no auction.** Without a pool there is nothing to open above, and inventing a start
 * would be a guess at a market we cannot see. The answer is `minOutStart === minOutEnd` — a flat
 * limit order at the maker's own number, which is what every offer this app signed before today.
 *
 * **A quote under the floor is still an auction, of nothing.** A maker asking for more than the
 * pool pays gets `minOutStart === minOutEnd` as well: opening below the floor would ask the chain
 * for terms `_termsOk` refuses, and opening at the quote would ask for less than the maker said.
 * The offer rests at the floor until the market comes to it.
 *
 * **Otherwise the maker is paid at least what they asked, and possibly more.** The curve opens
 * above today's market and falls to the floor by expiry, so an early fill pays more than the
 * number in the form and a late one pays exactly it.
 *
 * @example
 *   const { minOutStart, minOutEnd } = suggestDecay({
 *     floor: parseUnits('400', 6),
 *     poolQuote: poolPays(pool, tokenIn, amountIn),
 *   })
 */
export function suggestDecay(x: DecayInputs): Decay {
  const floor = x.floor
  const quote = x.poolQuote ?? 0n
  const flat = { minOutStart: floor, minOutEnd: floor }

  // A floor of nothing is not an auction, it is a gift, and a curve from the market down to zero
  // is the most expensive way to make one. The caller has an empty field; say so by saying
  // nothing.
  if (floor <= 0n || quote <= 0n) return flat

  const start = quote + (quote * premiumFor(x)) / ONE
  return start > floor ? { minOutStart: start, minOutEnd: floor } : flat
}

/**
 * How far above the quote to open, as a fraction of one ether.
 *
 * **A fill's cost is a fraction of the trade, so the premium has to be one too.** The reasoning
 * on `DECAY_PREMIUM` is right and its number is not: one fill's cost is the smallest premium that
 * buys the maker anything, but that is 1% of a sixty-cent heartbeat intent and a thousandth of a
 * per cent of a thousand-dollar one. Freezing the small-ticket case and charging it to every
 * trade is what an hour of measurement says it costs:
 *
 *   premium 1.03%, one-hour window, linear decay to the maker's floor
 *     floor 0.1% under market -> fillable 58 minutes in, of sixty
 *     floor 0.5% under market -> 43 minutes
 *     floor 1.0% under market -> 32 minutes
 *
 * A maker who names a tight floor waits out the whole window and never trades. That is not the
 * safe direction; it is an offer that does not work.
 *
 * So the premium is computed from what a fill actually costs against what this trade is actually
 * worth, which is what the argument said all along. `fillCost` is that cost in the same units as
 * the quote — for the app, a gas estimate priced in token B.
 *
 * **The protocol fee is not part of it, and it used to be.** This added `feeRate` to the premium
 * because the filler paid the fee on top of the delivery. The settlement takes the fee out of
 * the maker's number now, so the filler's cost of a fill is gas and nothing else, and a rate
 * added here would ask the market for a concession no filler needs.
 *
 * `DECAY_PREMIUM` remains the answer when the caller cannot price a fill, and it remains the
 * right answer there: without a cost to divide, the small-ticket case is the safe assumption.
 */
function premiumFor(x: DecayInputs): bigint {
  if (x.premium !== undefined) return x.premium
  const quote = x.poolQuote ?? 0n
  if (quote <= 0n) return DECAY_PREMIUM

  const wanted = x.fillCost === undefined ? DECAY_PREMIUM : (x.fillCost * ONE) / quote

  // The cap only means anything when the maker left room under the market. A floor at or above
  // the quote is not a concession, it is a limit order waiting for the market to come up — and
  // then a start above it is pure upside, because the offer was not going to fill at t=0 either
  // way. Capping there would take that upside away to solve a problem that case does not have.
  if (x.floor >= quote) return wanted

  return min(wanted, headroom(x.floor, quote))
}

/**
 * The most the premium may be, whatever the arithmetic above wanted.
 *
 * **Half of what the maker already gave up.** A linear curve from `quote x (1 + p)` down to a
 * floor `c` below the quote reaches the market at `p / (p + c)` of the window. Hold `p` at half
 * of `c` and that is a third, for every trade, at every size, with no gas price to look up:
 *
 *   premium = concession / 2  ->  crosses the market a third of the way in, always
 *
 * That is the bound the flat constant did not have. `DECAY_PREMIUM` against a floor a tenth of a
 * per cent under market opened an offer that did not become fillable until 58 minutes of its 60
 * had gone — the maker had given an inch and been asked to wait out the window for it.
 *
 * A maker who concedes nothing gets no auction, which is right: there is no room between their
 * floor and the market to run one in, and a flat order at their number is what they asked for.
 */
function headroom(floor: bigint, quote: bigint): bigint {
  if (floor >= quote) return 0n
  return ((quote - floor) * ONE) / quote / 2n
}

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)

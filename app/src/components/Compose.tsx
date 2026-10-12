import { useEffect, useRef, useState } from 'react'
import { formatUnits, getAddress, type Address, type Hex } from 'viem'
import type { Status } from '@msgboard/sdk'
import { publish } from '../lib/board'
import {
  SUGGESTED_WALLET_WINDOW_S,
  balanceOf,
  displaySymbol,
  encodeIntent,
  FLAG_ESCROW,
  FLAG_PARTIAL,
  FLAG_PERMIT2,
  formatFeeRate,
  getChainId,
  grossForNet,
  marketAddress,
  MAX_FEE_RATE,
  NETWORKS,
  parse,
  parseFeeRate,
  presetTokens,
  suggestDecay,
  ZERO,
  ZERO_HASH,
  type Decay, type Intent, type TokenInfo,
} from '@prove.cash/sdk'
import {
  RUNGS,
  walletCustody,
  WHERE,
  whereSpoken,
  whereText,
  whereTone,
} from '../lib/custody'
import { amountError, normalizeAmount } from '../lib/amount'
import { signAndArm } from '../lib/arm'
import { errorLine } from '../lib/errors'
import { chargedRate, feeFault, feeInside, feeShares, feeTerms, feeWhereOf, forTheBoard, shownRate, netOf } from '../lib/fee'
import { adviceOf, faultOf, LEADS, planOf, suggestedLeadFor } from '../lib/schedule'
import { curveTerms, FULL_FALL, isFullFall, type Fall } from '../lib/curve'
import { useCustody } from '../hooks/useCustody'
import { useAcknowledgedDefault, useFeeDefaults } from '../hooks/useFeeDefaults'
import { usePoolRead } from '../hooks/usePool'
import { num, t } from '../lib/i18n'
import { poolHolds, poolPays } from '../lib/pool'
import { spokenDuration, spokenRate } from '../lib/speech'
import { MarketPanel } from './charts/MarketPanel'
import { CurveField, FallSummary } from './CurveField'
import { CustodyLadder } from './CustodyLadder'
import { RungGlyph, WhereGlyph } from './StateIcon'
import { AmountRow, Chip } from './fields'
import { FeeFault, FeeNotice } from './FeeNotice'
import { TokenUnit } from './TokenAvatar'
import { TokenPicker } from './TokenPicker'
import { Toggle } from './Menu'
import { ChevronIcon } from './ChevronIcon'

/** Mirrored from the contract by the SDK, and unchecked against it. See Tour.tsx. */

type Phase =
  | 'idle'
  | 'signing'
  | 'authorizing'
  | 'approving'
  | 'depositing'
  | 'grinding'
  | 'done'
  | 'error'

/** An address, cut to the two ends a person recognises. */

/**
 * The highest rate this form will let a maker type. A fifth of the offer.
 *
 * **There are two ceilings now, and only this one is a matter of taste.** The chain's own is
 * `MAX_FEE_RATE`, one hundred per cent, and it is arithmetic rather than policy: the fee comes
 * out of the maker's number, so above one hundred per cent `gross - fee` underflows. `_termsOk`
 * refuses such an intent, and it has to — an underflow is a panic, a panic is not a `Reason`,
 * and `skipInvalid` cannot step over one, so a single bad leg would take a whole batch down.
 *
 * This constant sits a long way under that, and it is a form catching a typo. A maker who means
 * half of one per cent and types 50 is signing an offer nobody will fill, and finding that out
 * from a red line beats finding it out from silence. It binds this form and nothing else — a
 * maker who hand-rolls an intent may sign anything the chain accepts.
 */
const MAX_TYPED_RATE = MAX_FEE_RATE / 5n

/**
 * A typed address (the RFQ counterparty), checksummed, or null when it is not an address.
 *
 * A mixed-case address carries EIP-55 in its capitals, so a typo in one breaks the checksum and
 * is refused here. An address that is all one case carries no checksum to check, and is taken as
 * typed — that is what a maker gets from `cast`, from a CSV, and from half the block explorers.
 */
export function asAddress(text: string): Address | null {
  const raw = text.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return null
  // The body decides, not the whole string: `0x` upper-cases to `0X`, so comparing the prefix
  // too makes every all-caps address look mixed and fails its checksum for no reason.
  const body = raw.slice(2)
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase()
  const checked = getAddress(raw.toLowerCase())
  return mixed && checked !== raw ? null : checked
}

/**
 * The decay is on unless the maker turns it off.
 *
 * It used to be off, and off made every offer this app ever signed a flat limit order: one price
 * for the whole window, and the first valid transaction takes it. That is a race between bots on
 * latency, and the maker collects nothing from winning it. A decaying price is the only term that
 * makes fillers compete in the maker's favour, so it is what the form signs by default.
 */
export const DECAY_ON_BY_DEFAULT = true

/**
 * The offer this form will sign, as the chain reads it: two ends, a curve word, and the kind
 * bits that say how to read the word.
 *
 * `floor` is the end of the curve — the least a filler may pay, in gross. With the decay on, the
 * start comes from the pool beside the form, so an early fill pays more than the floor and the
 * last possible fill pays exactly it. With the decay off, both ends are the floor and the offer
 * is flat.
 *
 * **The floor arrives here already grossed up.** The maker types what they will receive, and the
 * caller derives the gross with `grossForNet` before this sees it — so a rate never moves the
 * shape of the curve, only its height.
 *
 * **The shape and the height are decided apart, and they have to be.** `fall` says where in the
 * window the price moves; the two ends say between which prices. A maker who drags a handle
 * changes when a filler's cost is crossed and never changes what the maker is owed at the close.
 */
export type Offer = Decay & { curve: Hex; kind: number }

export function offerCurve(x: {
  dutch: boolean
  /** The typed floor, in raw token B units. */
  floor: bigint
  /** What the pool pays for this size now, in the same units, or null with no market to read. */
  quote: bigint | null
  /** Where inside the window the price falls. Ignored while the offer is flat. */
  fall: Fall
}): Offer {
  const ends = x.dutch
    ? suggestDecay({ floor: x.floor, poolQuote: x.quote })
    : { minOutStart: x.floor, minOutEnd: x.floor }
  return { ...ends, ...curveTerms({ dutch: x.dutch, fall: x.fall }) }
}

const DURATIONS = [
  { label: '15m', seconds: 900 },
  { label: '1h', seconds: 3600 },
  { label: '6h', seconds: 21600 },
  { label: '24h', seconds: 86400 },
]

/**
 * The face of one lead time. `LEADS` holds the numbers, this holds what a chip says.
 *
 * Zero gets a word rather than `0m`, because "now" is the default and a default should read like
 * an answer. The rest reuse the duration faces, so the two rows of chips line up under each other
 * and a maker reads one scale, not two.
 */
const leadLabel = (seconds: number): string =>
  seconds === 0
    ? t('sign.opens.now')
    : (DURATIONS.find((d) => d.seconds === seconds)?.label ?? `${seconds}s`)

/**
 * The pair the form opens with.
 *
 * `give` comes off the fragment, which the landing page writes after reading which tokens the
 * visitor has actually moved on this chain. A token this build does not carry is not an error —
 * the link outlives a preset list — so an unknown one falls back to the default pair rather than
 * opening the form on a token with no symbol and no decimals.
 *
 * The receive side is the first preset that is not the give side, because a pair of one token
 * is not a trade and the form would refuse to submit it.
 */
export function openingPair(give: Address | null): [TokenInfo | null, TokenInfo | null] {
  const presets = presetTokens()
  const wanted = give?.toLowerCase()
  const from = presets.find((p) => p.address.toLowerCase() === wanted) ?? presets[0] ?? null
  const to = presets.find((p) => p.address !== from?.address) ?? null
  return [from, to]
}

export function Compose({
  account,
  give = null,
  status,
  onPosted,
  onConnect,
  onBusy,
}: {
  account: Address | null
  /** The token to open with, from `#/<chain>/sign?give=<token>`. Null takes the preset. */
  give?: Address | null
  status: Status | null
  onPosted: () => void
  onConnect: () => Promise<void>
  /** Told true while a signature or a post is in flight, so the header can hold the network. */
  onBusy?: (busy: boolean) => void
}) {
  const [opensWith, opensTo] = openingPair(give)
  const [tokenIn, setTokenIn] = useState<TokenInfo | null>(opensWith)
  const [tokenOut, setTokenOut] = useState<TokenInfo | null>(opensTo)
  const [amountIn, setAmountIn] = useState('')
  const [minOut, setMinOut] = useState('')
  const [dutch, setDutch] = useState(DECAY_ON_BY_DEFAULT)
  /**
   * Where inside the window the price falls, as two handles on `CurveField`.
   *
   * The whole window by default, which is the straight line this form has always signed and the
   * only shape that costs no extra gas and no extra proof of work. A maker who never opens the
   * drawer signs `CURVE_LINEAR` and kind 0, exactly as before.
   */
  const [fall, setFall] = useState<Fall>(FULL_FALL)
  const [partial, setPartial] = useState(true)
  const [duration, setDuration] = useState(3600)
  /**
   * When the offer opens, as seconds from now. Zero is now, and now is the default — a maker who
   * never opens the drawer signs exactly what this form has always signed.
   */
  const [lead, setLead] = useState(0)
  /**
   * When the authorization opens, as seconds from now. Only the 3009 rung signs one.
   *
   * It follows `lead`, because the chips that set the start set this one too. That default is
   * the rung's whole argument: the token refuses a redemption before its own window, so a
   * scheduled offer commits nothing while it waits. A maker may then move it on its own. That is
   * how the two windows come apart, and the drawer says what it costs.
   */
  const [authLead, setAuthLead] = useState(0)
  /**
   * The maker's own cut of their number, as a percentage they type. Empty means none: the offer
   * signs the chain's fee defaults as they stand. A typed rate replaces the defaults' proceeds
   * rate (P3) and leaves the other two points alone, so it can only add to the fee.
   *
   * A string and not a number: the field is a fraction of one ether and a percentage typed into
   * it has sixteen decimal places to land in, which is more than a float carries. `parseFeeRate`
   * does the arithmetic on the digits.
   */
  const [rateText, setRateText] = useState('')
  const [more, setMore] = useState(false)
  const [picking, setPicking] = useState<'in' | 'out' | null>(null)
  const [balance, setBalance] = useState<bigint | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [message, setMessage] = useState<string | null>(null)
  const [iterations, setIterations] = useState(0n)
  const cancelSignal = useRef({ cancelled: false })

  const amountInError = amountError(amountIn, tokenIn?.decimals)
  const minOutError = amountError(minOut, tokenOut?.decimals)

  /*
   * Both amounts are numbers this token can actually hold.
   *
   * The two errors above used to be advice: a floor with more decimal places than the token
   * printed a red line and left the button live, and `parse` threw inside `submit` where the
   * catch reported it as a failed signature. Now that the floor is arithmetic the form does
   * before signing rather than a string it hands over, an unparseable one has to stop the
   * signature here — a floor that will not parse is a floor of zero, and an intent asking zero
   * is a gift to whoever fills it.
   */
  const amountsOk =
    Number(amountIn) > 0 && Number(minOut) > 0 && !amountInError && !minOutError
  const tokensOk = !!tokenIn && !!tokenOut && tokenIn.address !== tokenOut.address

  // The fee terms this offer signs: the chain's defaults, plus the maker's own cut if they typed
  // one (see `feeTerms`). `charged` is null until the defaults are read; null blocks signing.
  const rateTyped = rateText.trim() === '' ? 0n : parseFeeRate(rateText)
  const defaultRead = useFeeDefaults(getChainId())
  const [ackedDefault, ackDefault] = useAcknowledgedDefault(defaultRead)
  const terms = feeTerms({ rate: rateTyped, read: defaultRead })
  const charged = chargedRate(terms, defaultRead)
  const chargedRateNow = charged ?? 0n
  /*
   * Why the rate will not do, or null. Two ceilings, and they fail differently.
   *
   * Over `MAX_FEE_RATE` the chain refuses the terms outright, so the offer is dead the moment it
   * is signed — it costs the maker a signature, a board post and its proof of work, and every
   * solver steps over it. Nothing downstream can catch that, so this form is the only place it
   * can be stopped, and it says which ceiling was hit rather than one number for both.
   */
  /** Where the fee lands, as a face: the defaults' name, or a short address. */
  const feeWhere = feeWhereOf(defaultRead)
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
  /*
   * Why the chain would refuse the fee terms, or null: a rate above one hundred per cent, or no
   * defaults to sign yet. `BadTerms_` at every fill for the life of the offer, so the form refuses
   * before the signature. Judged only once the
   * rate parses; a rate that will not parse already has its own line.
   */
  const feeError = rateError === null ? feeFault(terms, defaultRead, ackedDefault) : null
  /** The three rates added, for the summary line beside the destination. */
  const shown = shownRate(terms)

  let amountInWei = 0n
  try {
    if (tokenIn && amountsOk) amountInWei = parse(amountIn, tokenIn.decimals)
  } catch {
    /* not a parseable amount yet */
  }
  /*
   * The number in the "you want at least" field, and it is the maker's NET.
   *
   * It used to be the number the offer signed, and the two came apart when the fee moved inside
   * the maker's payment. The maker types what they will receive; `grossFloor` below is what the
   * signature actually asks for.
   */
  let floorNet = 0n
  try {
    if (tokenOut && Number(minOut) > 0) floorNet = parse(minOut, tokenOut.decimals)
  } catch {
    /* not a parseable amount yet */
  }

  // The rung, and the three chain reads behind it. `useCustody` owns them, so the exclusive-quote
  // surfaces run the same probes and reach the same rung from the same facts.
  const { ctx, mode, setCustody, needsApproval, live } = useCustody(account, tokenIn, amountInWei)

  /*
   * The pool, read once for the whole page and handed to the panel below.
   *
   * The offer's opening price is taken from this snapshot, and the chart beside the form draws
   * the same one. A second read would be a second answer, and the form would be pricing an
   * auction the picture next to it does not show.
   */
  const poolRead = usePoolRead(getChainId(), tokenIn, tokenOut)

  useEffect(() => {
    setBalance(null)
    if (!account || !tokenIn) return
    let stale = false
    balanceOf(tokenIn.address, account)
      .then((b) => !stale && setBalance(b))
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [account, tokenIn])

  /*
   * What the pool pays for this size, at the snapshot the panel is drawing.
   *
   * Null covers three states that are one state to the form: the read is still in flight, the
   * pair has no pool, and the chain would not answer. None of them is a market we can price an
   * auction against, and `suggestDecay` answers all three with a flat order rather than a guess.
   */
  const inMarket = tokenIn ? marketAddress(tokenIn) : null
  const outMarket = tokenOut ? marketAddress(tokenOut) : null
  const pool = poolRead?.state === 'pool' ? poolRead.pool : null
  const quote =
    pool && inMarket && outMarket && amountInWei > 0n && poolHolds(pool, inMarket, outMarket)
      ? poolPays(pool, inMarket, amountInWei)
      : null

  /*
   * The floor the offer signs, derived from the floor the maker typed.
   *
   * **The maker's guarantee moved out of the contract, and this line is where it lives now.**
   * The settlement pays `gross - floor(gross * rate)`, so a maker who signed their own number
   * would receive less than it. `grossForNet` divides the other way and rounds up, which makes
   * `gross - fee >= net` hold for every rate and every amount — the maker's stated figure is met
   * or beaten, never missed.
   *
   * At a rate of zero the two are the same number. `feeTo = 0` is not a rate of zero: it is
   * priced at the default rate, so the maker still receives what they typed.
   *
   * **The guard is not decoration.** `grossForNet` divides by `MAX_FEE_RATE - rate` and throws a
   * `RangeError` at or above the ceiling, where no gross pays a positive net at all. A throw here
   * runs during render, and a throw during render is a blank page — so the rate field refuses
   * that number first, and this only derives once `rateError` says the number is signable.
   */
  const grossFloor = rateError === null ? grossForNet(floorNet, chargedRateNow) : floorNet

  // The two ends of the offer, as it will be signed. Everything below reads these — the panel,
  // the line in the advanced drawer, and the intent itself — so what is drawn is what is signed.
  // Both ends are gross figures: they are what a filler pays, which is what the auction is over.
  const curve = offerCurve({ dutch, floor: grossFloor, quote, fall })

  // The split, at the floor, in the three numbers the drawer states. `feeFloor` is the
  // settlement's own arithmetic, so what the panel shows is what the fill will book.
  const feeFloor = feeInside(curve.minOutEnd, chargedRateNow)
  /** What the maker receives if the offer runs all the way down and fills at the floor. */
  const netFloor = curve.minOutEnd - feeFloor

  // The two raw amounts are the last word, not the two typed strings. Nothing signs a zero.
  //
  // `!rateError` belongs here and was missing. The rate is the one field in this form that does
  // not run `normalizeAmount`, so a maker typing `0,5` sees the red line, presses the button, and
  // signs an offer charging nothing — `feeTerms` folds an unparseable rate to `0n`. Refuse and
  // say why; never quietly sign a different number from the one they read.
  //
  // `live` belongs here for the same reason: this form reads the chain from the network switcher,
  // and mainnet is in that switcher with no settlement behind it. Everything above is about the
  // maker's numbers, and none of it can tell that the contract the signature names does not
  // exist. `signIntent` refuses too, and the ladder locks every rung — this is the half that
  // stops the button rather than the signature.
  const ready =
    !!account &&
    live &&
    tokensOk &&
    amountsOk &&
    !rateError &&
    !feeError &&
    charged !== null &&
    amountInWei > 0n &&
    floorNet > 0n

  const wallet = walletCustody(mode)

  /*
   * The offer's schedule, in seconds from now, and everything the drawer says about it.
   *
   * The plan hears about the authorization on the 3009 rung and nowhere else, because no other
   * rung signs a second window. That is what makes the intersection appear and disappear with
   * the rung rather than being drawn as an empty fact about an offer that has none.
   */
  const plan = planOf({ lead, duration, authLead: mode === 'authorization' ? authLead : null })

  /*
   * Why the form will not sign this schedule, or null.
   *
   * The start does NOT clamp when the rung changes under it, and the duration above does. The
   * difference is deliberate: a clamp that moves a maker's number while they read it hands them a
   * signature they did not agree to, and this control is new enough to do the better thing. The
   * chips past the cap are disabled, so the only way into `ahead` is to change the rung after
   * choosing a start — and then the form says so and stops, rather than quietly halving it.
   */
  const fault = faultOf(plan)
  const advice = adviceOf(plan, wallet)

  /*
   * The signature this form will actually make.
   *
   * `ready` above is about the numbers. This adds the schedule, which cannot be judged until the
   * rung is known — and a dead schedule is the one mistake nothing downstream will catch. The
   * chain accepts an offer whose authorization opens after it expires, the board carries it, and
   * every fill comes back `EscrowShort`, which is also what a spent nonce says.
   */
  const canSign = ready && fault === null

  const rate =
    amountsOk && tokenIn && tokenOut ? Number(minOut) / Number(amountIn) : null

  // The three words the collapsed summary wears, and the same three inside its label. One source,
  // so the sentence a screen reader hears cannot drift from the line an eye reads.
  const durationLabel = DURATIONS.find((d) => d.seconds === duration)?.label ?? `${duration}s`
  // The rung's own name, from the ladder, so the collapsed line and the chooser cannot disagree.
  const modeName = RUNGS[mode](ctx).name
  // The board hash, cut to what a line can hold. The ear gets the whole thing below.
  const postedHash = message ? `${message.slice(0, 18)}…` : ''
  const partialWord = partial ? t('sign.partial.ok') : t('sign.partial.none')
  const decayWord = dutch ? t('sign.decay.on') : t('sign.decay.off')

  function flip() {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setAmountIn(minOut)
    setMinOut(amountIn)
  }

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
    if (!canSign || !tokenIn || !tokenOut) return
    // The chain this offer is for, read once. The wallet prompts and the grind below can take
    // minutes; the post and the local record use this value, never a later read.
    const chainId = getChainId()
    setMessage(null)
    setIterations(0n)
    cancelSignal.current = { cancelled: false }
    try {
      /*
       * The one wall clock this form reads, and it reads it once.
       *
       * Everything above counts seconds from now, so nothing else in the schedule depends on
       * which clock the browser keeps. Here an offset becomes a timestamp, and a browser running
       * fast writes a `startTime` slightly ahead of `block.timestamp` — which is the reason the
       * contract bounds how far ahead a wallet intent may open. A lead the maker chose lands on
       * top of that skew and does not widen it: the two add, they do not multiply.
       */
      const now = BigInt(Math.floor(Date.now() / 1000))
      const startTime = now + BigInt(plan.opensIn)
      const endTime = now + BigInt(plan.endsIn)
      // The funding window's own opening, off the same read. It comes from the state rather than
      // from `plan.fundsIn`, which is null on every rung but the 3009 one. A timestamp needs no
      // default for a case that cannot reach the branch below.
      const fundsFrom = now + BigInt(authLead)
      const intent: Intent = {
        maker: account,
        recipient: account,
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn: parse(amountIn, tokenIn.decimals),
        // The maker typed the floor they want to RECEIVE. `grossFloor` turned it into the
        // number the offer asks a filler for, and that is the end of the curve; the start sits
        // above it. Both come from `curve`, which the panel beside the form drew from the same
        // numbers.
        minOutStart: curve.minOutStart,
        minOutEnd: curve.minOutEnd,
        // The shape, as one signed word. Zero is the straight line from one end of the window to
        // the other, and the kind bits in `flags` below say how to read it. Signed like every
        // other term: the picture the maker approved is the picture the chain walks.
        curve: curve.curve,
        startTime,
        endTime,
        executor: ZERO,
        // The fee this offer directs, named at signing time. It is a signed term, so what the
        // form says right now is what this intent carries for its whole life — no later change,
        // to the registry or to the field below, reaches an offer already on the board.
        feeConfig: terms.feeConfig,
        feeRateIn: terms.feeRateIn,
        feeRateProceeds: terms.feeRateProceeds,
        // The rate the form names, or zero to charge nothing. It comes out of `minOutEnd`
        // rather than riding on top of it, and the field above was grossed up by exactly this
        // number so that the maker still receives what they typed. Signed like every other
        // term, so what the form says now is what this offer carries for its whole life.
        feeRate: terms.feeRate,
        // No floor on a partial fill. The form does not offer one, and zero is what every offer
        // signed before the field existed carried — so this changes nothing a maker sees.
        //
        // A floor is worth something on the gasless rung, where a one-wei take redeems the
        // maker's whole `amountIn` into escrow. It is worth nothing here until the form can
        // explain that trade to the person signing, so it stays a field the protocol carries and
        // the app does not yet ask about.
        minFill: 0n,
        // No named 3009 nonce, so the authorization is welded to this intent's own hash. Naming
        // one makes two offers mutually exclusive, which is a thing the form cannot yet explain
        // to the person signing.
        authNonce: ZERO_HASH,
        // Permit2 is its own custody flag and is exclusive with escrow — the settlement refuses
        // an intent wearing both — so it is asked first and the escrow branch never sees it.
        flags:
          (partial ? FLAG_PARTIAL : 0) |
          (mode === 'permit2' ? FLAG_PERMIT2 : walletCustody(mode) ? 0 : FLAG_ESCROW) |
          // Bits 8 and 16, and they are free: `flags` has always been inside `INTENT_TYPEHASH`,
          // so naming a kind costs no type-hash change and no codec version.
          curve.kind,
        nonce: BigInt(Date.now()),
      }

      // One helper signs the intent and arms whichever rung it was built for, in the order that
      // rung needs. `lib/arm.ts` owns that order, so the exclusive-quote surfaces cannot reach a
      // different one.
      const signed = await signAndArm({
        account,
        intent,
        mode,
        live,
        needsApproval,
        fundsFrom,
        onPhase: setPhase,
      })

      // With the fee config's preimage when it is not a bundled default (`forTheBoard`).
      const data: Hex = encodeIntent(forTheBoard(signed, chainId))

      setPhase('grinding')
      const hash = await publish(chainId, data, (i) => setIterations(i), cancelSignal.current)

      setPhase('done')
      setMessage(hash)
      onPosted()
    } catch (e) {
      // `errorLine`, not the raw message: viem's report carries the endpoint URL on its second
      // line, and this lands in a `role="alert"` that a screen reader will read out. An endpoint
      // with a key in its path is a credential.
      const text = errorLine(e)
      setPhase(text === 'cancelled' ? 'idle' : 'error')
      if (text !== 'cancelled') setMessage(text)
    }
  }

  const working =
    phase === 'signing' ||
    phase === 'authorizing' ||
    phase === 'approving' ||
    phase === 'depositing' ||
    phase === 'grinding'
  // The header's network menu stays shut while an offer is in flight.
  useEffect(() => {
    onBusy?.(working)
  }, [working, onBusy])
  useEffect(() => () => onBusy?.(false), [onBusy])
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
            : phase === 'grinding'
              ? t('sign.phase.posting')
              : !tokensOk
                ? t('sign.need.tokens')
                : !amountsOk
                  ? t('sign.need.amounts')
                  : rateError || feeError || charged === null
                    ? t('sign.need.fee')
                    : fault !== null
                      ? t('sign.need.schedule')
                      : mode === 'authorization' || mode === 'permit'
                        ? t('sign.go.twice')
                        : mode === 'escrow'
                          ? t('sign.go.escrow')
                          : t('sign.go')

  // The form is a column of cards. They carry the padding, so the column carries none.
  //
  // The single track is `minmax(0,1fr)`, not `1fr`. A grid item's automatic minimum size is its
  // min-content width, and the amount input's is 297px, so a plain track pushed the whole column
  // to 425px and ran the form off a 375px screen.
  //
  // From `lg` the preview sits beside the form; under it, the preview follows in source order and
  // stacks. Both tracks are `minmax(0,…)` for the same reason the single one was.
  return (
    <div className="mx-auto w-full max-w-md lg:max-w-5xl grid grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] gap-2 lg:gap-4 lg:items-start">
      <h2 className="sr-only">{t('sign.title')}</h2>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 min-w-0">
        <AmountRow
          id="amount-in"
          label={t('sign.give')}
          side={t('sign.side.give')}
          amount={amountIn}
          onAmount={(v: string) => setAmountIn(normalizeAmount(v))}
          token={tokenIn}
          onPickToken={() => setPicking('in')}
          balance={balance}
          error={amountInError}
          onMax={
            balance !== null && tokenIn
              ? () => setAmountIn(formatUnits(balance, tokenIn.decimals))
              : undefined
          }
        />

        {/*
          `left-1/2 -translate-x-1/2` stays physical. The pair centres the button on the seam
          between the two cards, and a centre is the same point in Arabic as in English.
        */}
        <div className="relative h-0 z-10">
          <button
            type="button"
            onClick={flip}
            aria-label={t('sign.flip.label')}
            title={t('sign.flip.tip')}
            className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-8 rounded-lg bg-(--color-panel-2) border hair hover:border-(--color-line-bright) text-(--color-body) transition-colors">
            <span aria-hidden="true">↓↑</span>
          </button>
        </div>

        <AmountRow
          id="min-out"
          label={t('sign.want')}
          side={t('sign.side.receive')}
          amount={minOut}
          onAmount={(v: string) => setMinOut(normalizeAmount(v))}
          token={tokenOut}
          onPickToken={() => setPicking('out')}
          balance={null}
          error={minOutError}
        />

        <div className="gutter flex items-center justify-between text-[11px] text-(--color-dim)">
          {rate && tokenIn && tokenOut ? (
            <span className="num">
              {/* An expression, so it holds its own direction. See `.ltr` in index.css. */}
              <span className="ltr inline-flex items-center gap-1" aria-hidden="true">
                <span>1</span>
                <TokenUnit token={tokenIn} />
                <span>≥ {num(rate, { maximumSignificantDigits: 6 })}</span>
                <TokenUnit token={tokenOut} />
              </span>
              <span className="sr-only">
                {t('sign.floor.spoken', {
                  rate: spokenRate(rate, displaySymbol(tokenIn), displaySymbol(tokenOut)),
                })}
              </span>
            </span>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => setMore((v) => !v)}
            aria-expanded={more}
            aria-controls="offer-advanced"
            aria-label={t('sign.terms.label', {
              duration: durationLabel,
              partial: partialWord,
              decay: decayWord,
            })}
            className="hover:text-(--color-body) transition-colors">
            {durationLabel} · {partialWord} · {decayWord}{' '}
            <span aria-hidden="true"><ChevronIcon up={more} /></span>
          </button>
        </div>

        {/*
          Custody is decided, not asked. The app takes the strongest rung the token supports, so the
          form states the outcome in one line — the mechanism, and where the tokens end up — and the
          chooser lives in the advanced panel with the rest of the overrides. Both summaries open the
          same panel, so either one is a way in.
        */}
        <div className="gutter flex items-center justify-between gap-2 text-[11px] text-(--color-dim) -mt-1">
          <span className="uppercase tracking-wider" aria-hidden="true">
            {t('sign.custody')}
          </span>
          {/*
            The where-word is a glyph, and the word is one hover or one Tab away: the tip wraps
            the button, so the button's own focus shows it. The mode keeps its name — it is the
            thing the reader may change.
          */}
          <span className="tip relative inline-flex">
            <button
              type="button"
              onClick={() => setMore((v) => !v)}
              aria-expanded={more}
              aria-controls="offer-advanced"
              aria-label={t('sign.custody.label', {
                mode: modeName,
                where: whereSpoken(WHERE[mode]),
              })}
              className="num flex items-center gap-1.5 hover:text-(--color-body) transition-colors">
              <span aria-hidden="true" className="inline-flex shrink-0">
                <RungGlyph mode={mode} size={13} />
              </span>
              <span aria-hidden="true">{modeName}</span>
              <span aria-hidden="true" className={`inline-flex shrink-0 ${whereTone(WHERE[mode])}`}>
                <WhereGlyph where={WHERE[mode]} size={13} />
              </span>
              <span aria-hidden="true"><ChevronIcon up={more} /></span>
            </button>
            <span role="tooltip" className="tip-body tip-end">
              {whereText(WHERE[mode])} — {whereSpoken(WHERE[mode])}
            </span>
          </span>
        </div>

        {/*
          The shape, once it stops being the straight line. Same rule as the fee row below: a
          signed term that has left its default has to stay readable after the drawer closes, and
          a term still at its default is noise.

          The offer has to be decaying for the shape to mean anything — a flat offer signs
          `CURVE_LINEAR` whatever the handles say.
        */}
        {dutch && !isFullFall(fall) && (
          <FallSummary
            fall={fall}
            duration={duration}
            open={more}
            onToggle={() => setMore((v) => !v)}
          />
        )}

        {/*
          The fee is a signed term, and this panel closes over it. A maker who sets a rate,
          collapses the form and signs an hour later must still be able to see where their fee
          goes — so the summary appears the moment the offer charges one, the default fee included,
          and stays out of the way while it charges nothing.

          A fee the chain would refuse shows here too, in red, so the refusal is visible with the
          drawer shut.
        */}
        {(shown > 0n || feeError) && (
          <div className="gutter flex items-center justify-between gap-2 text-[11px] text-(--color-dim) -mt-1">
            <span className="uppercase tracking-wider" aria-hidden="true">
              {t('sign.fee')}
            </span>
            <button
              type="button"
              onClick={() => setMore((v) => !v)}
              aria-expanded={more}
              aria-controls="offer-advanced"
              aria-label={t('sign.fee.label')}
              className="num hover:text-(--color-body) transition-colors">
              <span aria-hidden="true">
                <span className={feeError ? 'text-(--color-danger)' : undefined}>
                  {feeWhere || t('sign.need.fee')}
                </span>
                {/*
                  The rate, whenever it is not zero. A percent sign inflects in no language, so it
                  is written here rather than carried in thirty-five dictionaries — the same reason
                  the rate came out of the sentence when it stopped being basis points.
                */}
                {shown > 0n && <span> · {formatFeeRate(shown)}%</span>}{' '}
                <span><ChevronIcon up={more} /></span>
              </span>
            </button>
          </div>
        )}

        {more && (
          <div id="offer-advanced" className="panel-ink p-2 sm:p-4 grid gap-3">
            {/*
              When the offer opens. It sits above "expires" because a maker reads a schedule
              forwards, and it defaults to "now" so a maker who never touches it signs exactly
              what this form signed before the control existed.
            */}
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label={t('sign.opens.group')}>
              <span
                className="text-[11px] uppercase tracking-wider text-(--color-dim) me-1"
                aria-hidden="true">
                {t('sign.opens')}
              </span>
              {LEADS.map((seconds) => {
                // Past an hour on a wallet rung the chip marks itself, and still works. The
                // approval that arms such an offer is one this protocol cannot see revoked, so a
                // signature left standing here outlives any revoke — the maker's risk to take,
                // and the label is where they meet it. Escrow, authorization and Permit2 each
                // carry a real off switch and get no mark at all.
                const tooFar = seconds > suggestedLeadFor(wallet)
                return (
                  <Chip
                    key={seconds}
                    warn={tooFar}
                    selected={lead === seconds}
                    onClick={() => {
                      setLead(seconds)
                      // The authorization follows the offer, and that default is the rung's whole
                      // argument: the token itself refuses a redemption before this second. A
                      // maker who wants the two apart moves the row below afterwards.
                      setAuthLead(seconds)
                    }}
                    label={
                      tooFar
                        ? // `Opening in {duration}` places an instant, so `within`. `past {max}`
                          // is a threshold on a length rather than a period something holds for,
                          // so `measure` — Hungarian says `több mint 1 óra`, not `1 óráig`.
                          t('sign.opens.tooFar', {
                            duration: spokenDuration(BigInt(seconds), 'within'),
                            max: spokenDuration(BigInt(SUGGESTED_WALLET_WINDOW_S), 'measure'),
                          })
                        : seconds === 0
                          ? t('sign.opens.nowLabel')
                          : // `Opens in {duration}`.
                            t('sign.opens.label', {
                              duration: spokenDuration(BigInt(seconds), 'within'),
                            })
                    }
                    title={tooFar ? t('sign.opens.tooFar.tip') : undefined}>
                    {leadLabel(seconds)}
                  </Chip>
                )
              })}
            </div>
            {/*
              A warning the maker may walk past, and the button stays live behind it. The
              settlement bounds no window; what it cannot do is see an allowance revoked, so a
              wallet signature resting past the suggestion is a live option against whatever that
              maker approves next. Their call, said out loud once.
            */}
            {advice === 'zombie' && (
              <p className="text-[11px] leading-relaxed text-(--color-unproven) -mt-1.5">
                {/* `rests longer than {max}` compares against a length, so `measure`. */}
                {t('sign.opens.zombie', {
                  mode: modeName,
                  max: spokenDuration(BigInt(SUGGESTED_WALLET_WINDOW_S), 'measure'),
                })}
              </p>
            )}
            {lead > 0 && advice !== 'zombie' && (
              <p className="text-[11px] leading-relaxed text-(--color-dim) -mt-1.5">
                {t('sign.opens.note')}
              </p>
            )}
            <div
              className="flex items-center gap-1.5"
              role="group"
              aria-label={t('sign.expires.group')}>
              <span className="text-[11px] uppercase tracking-wider text-(--color-dim) me-1" aria-hidden="true">
                {t('sign.expires')}
              </span>
              {DURATIONS.map((d) => {
                // Marked, never disabled — same reasoning as the opens row above. The contract
                // takes any of these; the mark says which ones leave a signature no revoke can
                // kill.
                const tooLong = walletCustody(mode) && d.seconds > SUGGESTED_WALLET_WINDOW_S
                return (
                  <Chip
                    key={d.seconds}
                    warn={tooLong}
                    selected={duration === d.seconds}
                    onClick={() => setDuration(d.seconds)}
                    label={
                      tooLong
                        ? // `citation` for `{duration}`: it opens the sentence as the chip's own
                          // name, a bare figure with no verb over it. `{max}` is a threshold on a
                          // length, so `measure`.
                          t('sign.expires.tooLong', {
                            duration: spokenDuration(BigInt(d.seconds)),
                            max: spokenDuration(BigInt(SUGGESTED_WALLET_WINDOW_S), 'measure'),
                          })
                        : // `Expires after {duration}` — `within`. Czech says `Expiruje za
                          // 1 minutu`, Finnish `Erääntyy 1 minuutin kuluttua`.
                          t('sign.expires.label', {
                            duration: spokenDuration(BigInt(d.seconds), 'within'),
                          })
                    }
                    title={tooLong ? t('sign.expires.tooLong.tip') : undefined}>
                    {d.label}
                  </Chip>
                )
              })}
            </div>
            {/* The window is the commitment, so the control that sets it has to say so. */}
            <p className="text-[11px] leading-relaxed text-(--color-dim) -mt-1.5">
              {t('sign.window.note')}
            </p>
            {/*
              The second window, and only on the rung that signs one.

              An EIP-3009 authorization funds the reservation at fill time, so a scheduled offer
              on this rung commits nothing while it waits — the tokens stay in the maker's wallet
              and the token refuses a redemption before this second. Escrow schedules the same
              offer and takes the money at deposit. That difference is the reason to choose this
              rung, so the control that carries it says it out loud.
            */}
            {mode === 'authorization' && (
              <div className="rule-t pt-3 grid gap-2">
                <div
                  className="flex flex-wrap items-center gap-1.5"
                  role="group"
                  aria-label={t('sign.funds.group')}>
                  <span
                    className="text-[11px] uppercase tracking-wider text-(--color-dim) me-1"
                    aria-hidden="true">
                    {t('sign.funds')}
                  </span>
                  {LEADS.map((seconds) => (
                    <Chip
                      key={seconds}
                      selected={authLead === seconds}
                      onClick={() => setAuthLead(seconds)}
                      label={
                        seconds === 0
                          ? t('sign.funds.nowLabel')
                          : // `The authorization opens in {duration}` — `within`.
                            t('sign.funds.label', {
                              duration: spokenDuration(BigInt(seconds), 'within'),
                            })
                      }>
                      {leadLabel(seconds)}
                    </Chip>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed text-(--color-dim)">
                  {t('sign.funds.note')}
                </p>
                {/*
                  The dead offer. `_termsOk` never reads the authorization, so the chain takes
                  this intent, the board carries it, and every fill comes back `EscrowShort` —
                  the answer a spent nonce and a taxed token also give. Nothing downstream can
                  tell the maker, so this line and the disabled button are the whole defence.
                */}
                {fault === 'dead' && (
                  <p role="alert" className="text-[11px] leading-relaxed text-(--color-danger)">
                    {/* `The authorization opens in {duration}` — `within`. */}
                    {t('sign.funds.dead', {
                      duration: spokenDuration(BigInt(authLead), 'within'),
                    })}
                  </p>
                )}
                {/*
                  Legal, and still a loss. The offer is open, the price is falling, and no fill
                  can land until the token's window opens — so the maker gives away the top of
                  their own curve for nothing.
                */}
                {fault === null && plan.strandedFor > 0 && (
                  <p className="text-[11px] leading-relaxed text-(--color-unproven)">
                    {/*
                      `opens {duration} after the offer does` measures the gap between two events
                      with no preposition over it, so `measure` — the slot that started all this.
                    */}
                    {t('sign.funds.stranded', {
                      duration: spokenDuration(BigInt(plan.strandedFor), 'measure'),
                    })}
                  </p>
                )}
              </div>
            )}
            {/*
              The intersection, as one line. It appears only once something is scheduled, so an
              offer that opens now and expires on time reads exactly as it always has.
            */}
            {(fault === 'dead' ||
              (fault === null && (plan.opensIn > 0 || plan.strandedFor > 0))) && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 -mt-1">
                <span className="text-[11px] uppercase tracking-wider text-(--color-dim)">
                  {t('sign.live')}
                </span>
                <span
                  className={`num text-[11px] ${
                    fault === 'dead' ? 'text-(--color-danger)' : 'text-(--color-bright)'
                  }`}>
                  {fault === 'dead'
                    ? t('sign.live.never')
                    : plan.liveIn === 0
                      ? // `now, for {duration}` is the period it stays fillable, so `span`.
                        t('sign.live.now', {
                          duration: spokenDuration(BigInt(plan.liveFor), 'span'),
                        })
                      : // Two slots: `in {time}` places the start, and `for {duration}` is the
                        // period that follows it.
                        t('sign.live.in', {
                          time: spokenDuration(BigInt(plan.liveIn), 'within'),
                          duration: spokenDuration(BigInt(plan.liveFor), 'span'),
                        })}
                </span>
              </div>
            )}
            <Toggle checked={partial} onChange={setPartial} className="text-sm">
              <span>{t('sign.partial.toggle')}</span>
            </Toggle>
            <Toggle checked={dutch} onChange={setDutch} className="text-sm">
              <span>{t('sign.decay.toggle')}</span>
            </Toggle>
            {/*
              Where in the window the price falls, and only once there is a fall to place.

              Two handles and no words. The default is the whole window — the line this form has
              always signed — and dragging either corner reaches dutch-then-flat, flat-then-dutch
              and flat-dutch-flat without reading anything. The strip in the panel beside the form
              draws the same shape against the pool, so the maker signs what they are looking at.

              The shape survives a change of window, because it is a fraction of one rather than a
              time. A quarter of fifteen minutes and a quarter of a day are the same drag.
            */}
            {dutch && <CurveField fall={fall} onFall={setFall} duration={duration} />}
            {/*
              The other end of the curve, stated as a number.

              There used to be a second field here, and the maker filled it in with the price the
              offer would end at — which made the field above the start, and the offer decayed
              from what they asked down to something they had to invent. It is the other way
              round now: they type the floor, and this is where the offer opens, taken from the
              pool the panel beside the form is drawing. It is a signed term, so it is shown and
              not implied.
            */}
            {dutch && tokenOut && curve.minOutStart > 0n && (
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 -mt-1">
                <span className="text-[11px] text-(--color-dim)">{t('sign.want.start')}</span>
                <span className="num inline-flex items-center gap-x-1 text-sm text-(--color-bright)">
                  {/*
                    Net, like the field above it. Every "you want" figure in this form is what
                    the maker receives, so the two ends of the curve are quoted in one unit — a
                    gross here and a net there would put two different meanings under one label.
                  */}
                  {num(Number(formatUnits(netOf(curve.minOutStart, chargedRateNow), tokenOut.decimals)), {
                    maximumSignificantDigits: 6,
                  })}
                  <TokenUnit token={tokenOut} />
                </span>
              </div>
            )}

            <div className="rule-t pt-3 grid gap-2">
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
              {/*
                Outside the chips, and that is the point. The rate is a term of the offer and
                the defaults say where the money lands, and a maker's own cut adds to them
                without replacing them.
              */}
              <div className="grid gap-1.5">
                {/*
                  A percentage, because that is the unit people quote a fee in. The field on the
                  wire is a fraction of one ether and has room for sixteen decimal places, so
                  nothing here rounds to a whole basis point the way it used to.
                */}
                <label
                  className="flex items-center gap-2 text-[11px] text-(--color-dim)"
                  htmlFor="fee-rate">
                  {t('sign.rate')}
                  {/*
                    The width lives on the wrapper, not on the input. `.field` sets
                    `width: 100%` from an unlayered rule in `index.css`, and an unlayered rule
                    beats a layered utility whatever the specificity — so `w-24` on the input
                    itself did nothing at all and the field ran the whole row.
                  */}
                  <span className="relative w-24 shrink-0">
                    <input
                      id="fee-rate"
                      className="field num pe-6 text-sm"
                      inputMode="decimal"
                      spellCheck={false}
                      autoComplete="off"
                      placeholder="0.05"
                      value={rateText}
                      aria-invalid={rateError || feeError ? true : undefined}
                      aria-describedby={
                        rateError ? 'fee-rate-error' : feeError ? 'fee-terms-error' : undefined
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
                  <p
                    id="fee-rate-error"
                    role="alert"
                    className="text-[11px] text-(--color-danger)">
                    {rateError}
                  </p>
                )}
                <FeeFault id="fee-terms-error" text={feeError} />
              </div>
              {/*
                What the rate costs, in the three numbers that describe it: the maker's own
                figure, the number the signature carries, and the slice that leaves.

                It appears only when a rate is set, because at a rate of zero all three are the
                same number and a table of one figure repeated says nothing. It reads off
                `curve.minOutEnd` — the floor as signed — so it is the arithmetic of the worst
                fill this offer allows, which is the fill the maker's guarantee is about.
              */}
              {chargedRateNow > 0n && tokenOut && netFloor > 0n && (
                <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                  <dt className="text-(--color-dim)">{t('sign.split.receive')}</dt>
                  <dd className="num flex flex-wrap items-center justify-end gap-x-1 text-(--color-bright) break-all">
                    {num(Number(formatUnits(netFloor, tokenOut.decimals)), {
                      maximumSignificantDigits: 6,
                    })}
                    <TokenUnit token={tokenOut} />
                  </dd>
                  <dt className="text-(--color-dim)">{t('sign.split.signed')}</dt>
                  <dd className="num flex flex-wrap items-center justify-end gap-x-1 text-(--color-body) break-all">
                    {num(Number(formatUnits(curve.minOutEnd, tokenOut.decimals)), {
                      maximumSignificantDigits: 6,
                    })}
                    <TokenUnit token={tokenOut} />
                  </dd>
                  {/* One row per destination: the full checksummed address and what it takes. */}
                  {feeShares(defaultRead, feeFloor).flatMap((d) => [
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
              {/* The maker's own cut comes out of their number, and this says so. */}
              {rateTyped !== null && rateTyped > 0n && (
                <p className="text-[11px] leading-relaxed text-(--color-dim)">{t('sign.fee.note')}</p>
              )}
            </div>

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

        {/*
          Nothing here about cancelling. This page is setup, and Portfolio is teardown — it states
          both prices of changing your mind, on both rungs, above the buttons that charge them.
          Saying it here as well made the maker read the undo before they had made the thing.
        */}

        {/*
          No gutter on this row. The button is a control, not prose: it lines up with the edges of
          the cards above it, not with the text inside them. With the gutter it sat 32px narrower
          than every card in the column and read as a mistake.
        */}
        {/* The row reaches both edges, so nothing in it carries a corner. See `.btn-block`. */}
        <div className="mt-1 flex items-center gap-px">
          <button
            className="btn btn-primary btn-block flex-1"
            disabled={(!!account && !canSign) || working}
            onClick={submit}>
            {buttonLabel}
          </button>
          {working && (
            <button
              className="btn btn-ghost btn-block"
              onClick={() => {
                cancelSignal.current.cancelled = true
              }}>
              {t('sign.cancel')}
            </button>
          )}
        </div>

        {/*
          The button is off on a chain with no settlement, so the reason sits beside it. The
          footer says the same, but 700px further down.
        */}
        {!live && (
          <p className="gutter text-xs text-(--color-unproven) text-center">
            {t('sign.off.network', { network: NETWORKS[getChainId()].label })}
          </p>
        )}

        {/*
          A counter, not a lecture. How the board prices a post belongs behind "how it works"; while
          the post is actually being made, the count is the only sign the app is alive.

          It runs thousands of times a second, so it must never reach a live region — the visible
          counter is hidden from AT, and the region beside it names the phase only.
        */}
        {phase === 'grinding' && (
          <p className="gutter num text-xs text-(--color-dim) text-center" aria-hidden="true">
            {t('sign.tries', { count: num(iterations) })}
          </p>
        )}
        <p role="status" className="sr-only">
          {working ? buttonLabel : phase === 'done' ? t('sign.done.spoken') : ''}
        </p>
        {phase === 'done' && message && (
          <p className="gutter num text-xs text-(--color-proven) break-all text-center">
            <span aria-hidden="true">
              {t('sign.done.short', { hash: postedHash })}
            </span>
            <span className="sr-only">{t('sign.done.hash', { hash: message })}</span> —{' '}
            {t('sign.done.alive')}
          </p>
        )}
        {phase === 'error' && message && (
          <p role="alert" className="gutter text-xs text-(--color-danger) break-all text-center">
            {message}
          </p>
        )}
        {status && !status.enabled && (
          <p className="gutter text-xs text-(--color-unproven) text-center">
            {t('sign.board.closed')}
          </p>
        )}
      </div>

      {/*
        The market, beside the form. A floor typed against nothing is a guess; this is the pool
        the offer will be measured against, and it moves with every keystroke.
      */}
      <MarketPanel
        context="sign"
        base={tokenIn}
        quote={tokenOut}
        pool={poolRead}
        draft={{
          amountIn,
          // The panel's `minOut` is where the offer opens, which is no longer what the maker
          // typed. Both ends come off `curve`, so the picture is the signature — and both are
          // gross, because the pool this strip compares against prices the filler's outlay.
          minOut:
            tokenOut && curve.minOutStart > 0n
              ? formatUnits(curve.minOutStart, tokenOut.decimals)
              : minOut,
          minOutEnd:
            dutch && curve.minOutEnd > 0n && tokenOut
              ? formatUnits(curve.minOutEnd, tokenOut.decimals)
              : '',
          dutch,
          duration,
          // The signed shape, so the strip draws the offer rather than a straight line the maker
          // did not choose. A chart that draws the wrong shape is worse than one that draws none.
          fall,
          // An offer that opens in three hours is not decaying yet, so the strip must not draw
          // it as though it were. `liveIn` is the intersection rather than the intent's own
          // start: on the 3009 rung the token's window can open later, and until it does the
          // curve is falling for nobody.
          //
          // A dead schedule sends a second past the end, so the strip reaches the same verdict
          // the drawer does. Sending `endsIn` would put the first fillable second exactly on the
          // last one, and the strip would answer "fills the moment it opens" beside a line
          // saying the offer is never fillable at all.
          startsIn: plan.opensIn,
          liveIn: plan.dead ? plan.endsIn + 1 : plan.liveIn,
        }}
      />

      {picking && (
        <TokenPicker
          value={picking === 'in' ? tokenIn : tokenOut}
          onChange={picking === 'in' ? setTokenIn : setTokenOut}
          account={account}
          onClose={() => setPicking(null)}
        />
      )}
    </div>
  )
}

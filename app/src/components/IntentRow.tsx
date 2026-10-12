import { formatUnits } from 'viem'
import type { BoardIntent } from '../hooks/useBoard'
import {
  displaySymbol,
  edgeOf,
  isDutch,
  isEscrow,
  isPermit2,
  isPartial,
} from '@prove.cash/sdk'
import { fixed, num, t } from '../lib/i18n'
import { spokenAmount, spokenDuration, spokenRate } from '../lib/speech'
import { FlagBadge, PartialBadge, WhereBadge, WholeBadge } from './StateIcon'
import { PairAvatars, RateUnit, TokenUnit } from './TokenAvatar'
import { WrapChip } from './TokenPicker'
import { Toggle } from './Menu'
import { short } from '../lib/address'
import { units } from '../lib/amount'



/**
 * Six significant digits, no trailing zeros, scientific only when a reader would want it.
 *
 * `num` writes the reader's decimal separator. A row that says 0.5432 to somebody whose language
 * writes 0,5432 is not merely foreign-looking: in a column beside a grouped number it reads as a
 * thousands separator, and the value is then wrong by three orders of magnitude.
 */
function rateText(rate: number): string {
  if (!isFinite(rate) || rate === 0) return '0'
  if (rate < 1e-6 || rate >= 1e9) return rate.toExponential(3)
  return num(rate, { maximumSignificantDigits: 6 })
}

function countdown(seconds: bigint): string {
  if (seconds <= 0n) return t('row.expired')
  const s = Number(seconds)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
}

/**
 * How long ago, largest unit only. History rows read as flow, not as clocks.
 *
 * The unit letters stay as they are — `m` and `h` are units, not words — and only the frame around
 * them is translated, so the figure a reader compares down a column never changes shape.
 */
function ago(seconds: bigint): string {
  const s = Number(seconds)
  const time =
    s < 60
      ? `${s}s`
      : s < 3600
        ? `${Math.floor(s / 60)}m`
        : s < 86400
          ? `${Math.floor(s / 3600)}h`
          : `${Math.floor(s / 86400)}d`
  return t('row.ago', { time })
}

export function IntentRow({
  item,
  now,
  selected,
  onToggle,
}: {
  item: BoardIntent
  now: bigint
  selected: boolean
  onToggle: () => void
}) {
  const { intent: i, tokenIn, tokenOut, makerBalance, quote, reservation } = item
  const expired = now >= i.endTime
  const edge = expired ? null : edgeOf(i, quote, now)
  const inAmount = Number(formatUnits(i.amountIn, tokenIn.decimals))
  const required = edge?.required ?? i.minOutStart
  const signedRate = inAmount > 0 ? Number(formatUnits(required, tokenOut.decimals)) / inAmount : 0
  const marketRate =
    quote && inAmount > 0 ? Number(formatUnits(quote.out, tokenOut.decimals)) / inAmount : null
  const profitable = edge !== null && edge.profit > 0n
  const funded = makerBalance === null ? null : makerBalance >= i.amountIn
  const symIn = displaySymbol(tokenIn)
  const symOut = displaySymbol(tokenOut)

  // The badge says where the tokens are, because that is the executor's question. It does not
  // say "proven": the word collides with the proof of work the board charges, and it was never
  // true of the 3009 rung, which pays out of the maker's balance at fill time and reverts if the
  // maker spends first. The CSS tokens still carry the old names; the labels do not.
  //
  // With a live contract the reservation is read, so an escrow flag alone claims nothing — the
  // deposit earns "in escrow", the 3009 authorization earns "funds at fill", and an unread
  // reservation says so.
  //
  // Each is a glyph now. The word is the glyph's name and its tip; see `StateIcon`.
  const escrowed = reservation != null && reservation.amount >= i.amountIn
  const badge = isEscrow(i) ? (
    escrowed ? (
      <WhereBadge where="escrow" />
    ) : i.auth ? (
      <WhereBadge where="fill" />
    ) : reservation === undefined ? (
      <FlagBadge flag="escrowUnread" />
    ) : (
      <FlagBadge flag="escrowEmpty" />
    )
  ) : (
    <WhereBadge where={isPermit2(i) ? 'fill' : 'wallet'} />
  )

  // The checkbox names the offer, and names it with figures that hold still. A decaying floor
  // and a countdown both change every second, and a label that changes under a focused control
  // is a screen reader talking over itself.
  const selectLabel = t('row.select', {
    amount: spokenAmount(i.amountIn, tokenIn.decimals, symIn),
    symbol: symOut,
    address: i.maker,
  })

  /*
    Which way round the price is written.

    `signedRate` and `marketRate` both count tokenOut per tokenIn, because that is what the
    signature fixes: `minOut / amountIn`. Printed that way, a maker who gives tUSDC for tWETH shows
    `0.00390538` — six digits of zeros and noise before the number a trader recognises, which is
    `256` tUSDC per tWETH. Every quote screen turns a fraction like that over.

    The rule is the figure's own size: a rate under 1 is shown as its reciprocal, with the unit
    turned over to match. It is decided by the signed rate and the market rate follows, so `ask`
    and `mkt` in one row always share an orientation and compare at a glance. It also makes the
    two directions of one pair read the same way down the column — tUSDC→tPLSX rows count
    tPLSX per tUSDC, and tPLSX→tUSDC rows, turned over, count tPLSX per tUSDC as well — so a
    reader compares an offer with the offers facing it. The app keeps no list of which tokens are
    money, so a rule read off the number is the one that holds for every pair, stable against
    stable included.

    Nothing else moves. The edge is a difference of two on-chain amounts, `quote.out - required`,
    and its sign, its colour and the spread sort never look at either printed rate. What does
    move is which way "better" reads between the two lines: with the price as signed, a market
    above the ask is a profit; turned over, a market below it is. The edge column carries the
    verdict either way, and `ask` stays what it always was — the rate the signature asks — not a
    claim about which side of the book the maker is on.

    `mkt` never inverts on its own. A market rate of zero — a quote of nothing — stays a zero
    rather than becoming an infinity that `rateText` would print as `0` anyway.
  */
  const inverted = signedRate > 0 && signedRate < 1
  const flip = (rate: number) => (inverted && rate > 0 ? 1 / rate : rate)
  const ask = flip(signedRate)
  const mkt = marketRate === null ? null : flip(marketRate)
  /** The token the printed rate counts, and the token it counts per. */
  const over = inverted ? tokenIn : tokenOut
  const under = inverted ? tokenOut : tokenIn
  const symOver = inverted ? symIn : symOut
  const symUnder = inverted ? symOut : symIn

  // `spokenRate(rate, in, out)` says "{rate} {out} per {in}", so the token the figure counts
  // goes in the second slot. Spoken the way it is printed, whichever way that is.
  const askSpoken = spokenRate(ask, symUnder, symOver)
  const rateSpoken =
    mkt === null
      ? quote === undefined
        ? t('row.rate.spoken.loading', { signed: askSpoken })
        : t('row.rate.spoken.none', { signed: askSpoken })
      : t('row.rate.spoken', { signed: askSpoken, market: spokenRate(mkt, symUnder, symOver) })

  return (
    <div
      role="row"
      onClick={expired ? undefined : onToggle}
      className={`board-grid row gutter py-2.5 ${expired ? '' : 'row-pick'} ${
        selected ? 'row-selected' : ''
      } ${profitable ? '' : 'opacity-90'}`}>
      <span role="cell">
        {expired ? (
          <span className="sr-only">{t('row.expired.spoken')}</span>
        ) : (
          <span onClick={(e) => e.stopPropagation()}>
            <Toggle checked={selected} onChange={onToggle}>
              <span className="sr-only">{selectLabel}</span>
            </Toggle>
          </span>
        )}
      </span>

      <div role="cell" className="min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-medium text-(--color-bright)">
          <PairAvatars tokenIn={tokenIn} tokenOut={tokenOut} />
          <span>{symIn}</span>
          {tokenIn.wraps && <WrapChip />}
          {/*
            The arrow points the way the row reads. It is a picture of the trade's direction, and
            in Arabic and Hebrew the maker's token is the one on the right, so an arrow drawn to
            the right would point back at what it came from. `rtl:-scale-x-100` turns the glyph
            over; the sr-only word beside it never needed the help.
          */}
          <span className="inline-block text-(--color-dim) rtl:-scale-x-100" aria-hidden="true">
            →
          </span>
          <span className="sr-only">{t('row.to')}</span>
          <span>{symOut}</span>
          {tokenOut.wraps && <WrapChip />}
        </div>
        {/*
          The states are glyphs, and the row wraps between them, never inside the address.

          The address carries `whitespace-nowrap` and the row wraps instead. A break inside it is
          not a cosmetic loss: `0xfc9d…728f` split over four lines is not an address a reader can
          check. The row is a grid cell with `min-w-0`, so without the wrap the nowrap children
          run under the size column instead. Each glyph is a fixed 14px, so a badge that arrives
          late — the escrow read, the balance — never reflows the row.
        */}
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-1 text-[11px]">
          {badge}
          {item.onBoard === false && !expired && (
            <FlagBadge flag="offBoard" detail={t('row.offBoard.tip')} />
          )}
          {/* The fill term, always shown: a pie for fills-in-parts, a square for all-or-nothing. */}
          {isPartial(i) ? (
            <PartialBadge
              filled={item.filled}
              total={i.amountIn}
              pct={(f) => `${fixed(Math.floor(f * 100), 0)}%`}
            />
          ) : (
            <WholeBadge />
          )}
          {isDutch(i) && <FlagBadge flag="decaying" />}
          <span className="num addr whitespace-nowrap text-(--color-dim)">
            <span aria-hidden="true" title={i.maker}>
              {short(i.maker)}
            </span>
            <span className="sr-only">{t('row.maker', { address: i.maker })}</span>
          </span>
          {!isEscrow(i) && funded === false && <FlagBadge flag="unfunded" />}
          {!isEscrow(i) && funded === true && <FlagBadge flag="funded" />}
        </div>
      </div>

      {/*
        The figure columns align to the end of the row, and they mirror with it.

        `text-end`, not `text-right`, and that is a decision rather than a sweep. What the
        alignment buys here is a tidy trailing edge, not a decimal column: every one of these
        cells is a short phrase — `for 56.7 tUSDC`, `ask 1.234` — so the label already sits where
        the decimal point would have to line up, and `fmt` prints a variable number of places
        anyway. A tidy edge belongs at the end of the row, so it moves with the row. The digits
        themselves are untouched: bidi lays a Western numeral out left to right inside an Arabic
        line, and `.num` isolates the run from its neighbours. The isolate keeps the line's
        direction, though, so a sign inside it still lands at the far end: `0.50%+`. A signed
        figure is an expression, so it carries `.ltr` as well, and its unit stays outside it.

        Each line is a flex row, `justify-end`, so the token's face centres on its symbol. Flex
        lays its items out in the row's direction, so in Arabic the figure is still what the
        reader meets first and the unit follows it — the order bidi gave the text before there
        was a face beside it. The unit wraps as one piece when the column is too narrow for it.
      */}
      <div role="cell" className="num text-end">
        <div aria-hidden="true">
          <div className="flex flex-wrap items-center justify-end gap-x-1 text-sm text-(--color-bright)">
            <span>{units(i.amountIn, tokenIn.decimals)}</span>
            <TokenUnit token={tokenIn} className="text-(--color-dim)" />
          </div>
          <div className="flex flex-wrap items-center justify-end gap-x-1 text-xs text-(--color-body) mt-0.5">
            <span>
              {t('row.for')} {units(required, tokenOut.decimals)}
            </span>
            <TokenUnit token={tokenOut} className="text-(--color-dim)" />
          </div>
        </div>
        <span className="sr-only">
          {t('row.amounts.spoken', {
            amount: spokenAmount(i.amountIn, tokenIn.decimals, symIn),
            least: spokenAmount(required, tokenOut.decimals, symOut),
          })}
        </span>
      </div>

      {/*
        A rate and its unit are one expression — `256.06 tUSDC/tWETH` — so the figure and the
        fraction share a `.ltr` span, and the label sits outside it in the row's own direction.
      */}
      <div role="cell" className="num text-end text-xs">
        <div aria-hidden="true">
          <div className="flex flex-wrap items-center justify-end gap-x-1 text-(--color-body)">
            <span className="text-(--color-dim)">{t('row.ask')}</span>
            <span className="ltr inline-flex items-center gap-1">
              {rateText(ask)}
              <RateUnit over={over} under={under} title={askSpoken} />
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-x-1 mt-0.5">
            <span className="text-(--color-dim)">{t('row.mkt')}</span>
            {mkt === null ? (
              <span className="text-(--color-dim)">{quote === undefined ? '…' : '—'}</span>
            ) : (
              <span className="ltr inline-flex items-center gap-1 text-(--color-body)">
                {rateText(mkt)}
                <RateUnit over={over} under={under} title={spokenRate(mkt, symUnder, symOver)} />
              </span>
            )}
          </div>
        </div>
        <span className="sr-only">{rateSpoken}</span>
      </div>

      <div role="cell" className="num text-end">
        {edge ? (
          <>
            <div aria-hidden="true">
              <div
                className={`text-sm font-semibold ${
                  edge.profit > 0n
                    ? 'text-(--color-proven)'
                    : edge.profit < 0n
                      ? 'text-(--color-danger)'
                      : 'text-(--color-dim)'
                }`}>
                <span className="ltr">
                  {edge.spreadPct > 0 ? '+' : ''}
                  {fixed(edge.spreadPct, 2)}%
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-x-1 text-xs text-(--color-body) mt-0.5">
                <span className="ltr">
                  {edge.profit > 0n ? '+' : ''}
                  {units(edge.profit, tokenOut.decimals, 4)}
                </span>
                <TokenUnit token={tokenOut} className="text-(--color-dim)" />
              </div>
            </div>
            {/* The word carries what the colour carries. Green and red say nothing aloud. */}
            <span className="sr-only">
              {t('row.edge.spoken', {
                verdict:
                  edge.profit > 0n
                    ? t('row.profitable')
                    : edge.profit < 0n
                      ? t('row.loss')
                      : t('row.even'),
                pct: fixed(edge.spreadPct, 2),
                amount: spokenAmount(edge.profit, tokenOut.decimals, symOut),
              })}
            </span>
          </>
        ) : (
          <span className="text-xs text-(--color-dim)">
            <span aria-hidden="true">
              {expired ? '—' : quote === undefined ? '…' : t('row.noRoute')}
            </span>
            <span className="sr-only">
              {expired
                ? t('row.noEdge.expired')
                : quote === undefined
                  ? t('row.edge.loading')
                  : t('row.noRoute.spoken')}
            </span>
          </span>
        )}
      </div>

      <div role="cell" className="num text-end text-xs text-(--color-dim)">
        <span aria-hidden="true">{expired ? ago(now - i.endTime) : countdown(i.endTime - now)}</span>
        <span className="sr-only">
          {expired
            ? // Two different slots, and Czech is why: `před` governs the instrumental where `za`
              // governs the accusative, so `Vypršelo před 1 minutou` and `Vyprší za 1 minutu`.
              t('row.expired.ago', { duration: spokenDuration(now - i.endTime, 'elapsed') })
            : t('row.expires.in', { duration: spokenDuration(i.endTime - now, 'within') })}
        </span>
      </div>
    </div>
  )
}

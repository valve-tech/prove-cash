import { useState } from 'react'
import { displaySymbol, type TokenInfo } from '@prove.cash/sdk'
import { Menu, type MenuOption } from '../Menu'
import { PairAvatars } from '../TokenAvatar'
import { t } from '../../lib/i18n'
import type { PoolRead } from '../../lib/pool'
import { FULL_FALL, type Fall } from '../../lib/curve'
import { Capacity } from './Capacity'
import { Impact } from './Impact'
import { Ladder } from './Ladder'
import { Reserves } from './Reserves'
import { Tape } from './Tape'
import { SignPreview } from './SignPreview'
import { useBook } from './useBook'
import {
  readVariant,
  variantsFor,
  writeVariant,
  type ChartContext,
  type VariantId,
} from './variants'

/**
 * The market for a pair, in whichever drawing the reader prefers.
 *
 * The panel owns the chrome — the box, the heading, the pair, the menu — so each variant is only
 * a drawing. That is why `SignPreview` grew a `bare` mode: two components cannot both own the
 * heading, and the menu has to sit in it.
 *
 * The choice is remembered per screen. Someone who wants the book while signing and the depth
 * while reading the board gets both, and neither choice disturbs the other.
 */

/** The offer the sign page is drafting. Absent on the board, which has no draft to draw. */
export type Draft = {
  amountIn: string
  /**
   * Where the offer opens. With the decay on this is computed from the pool, not typed — the
   * maker types the floor, and it arrives here as `minOutEnd`.
   */
  minOut: string
  /** Where the offer ends: the floor the maker typed. Empty when the offer is flat. */
  minOutEnd: string
  dutch: boolean
  duration: number
  /**
   * Where inside the window the price falls. Signed, like both ends of the curve — it is fixed
   * when the maker signs, and the strip has to draw it rather than a straight line the maker did
   * not choose. Absent on a caller that has no shape control, and then it is the whole window.
   */
  fall?: Fall
  /**
   * Seconds from now until the offer opens. Zero is now, which is what every offer this app
   * signed before the sign form grew a start control.
   */
  startsIn?: number
  /**
   * Seconds from now until anybody can actually fill it: where the intent's window and the
   * authorization's overlap. It is not always the start — a 3009 window that opens later leaves
   * the offer decaying for nobody, and that gap is the thing this panel has to show.
   */
  liveIn?: number
}

export function MarketPanel({
  context = 'sign',
  base,
  quote,
  draft,
  pool,
}: {
  context?: ChartContext
  base: TokenInfo | null
  quote: TokenInfo | null
  draft?: Draft
  /**
   * The pool read the page above already made, or absent to make one here.
   *
   * The sign page reads the pair once and hands it down, because the offer it is about to sign
   * opens at a price taken from this same snapshot. Two reads would be two answers, and the form
   * would be pricing an auction the chart beside it does not draw.
   */
  pool?: PoolRead | null
}) {
  const [variant, setVariant] = useState<VariantId>(() => readVariant(context))
  // Loaded once for the pair, whichever drawing is on. Switching then costs no fetch.
  const book = useBook(base, quote, pool)

  const options: MenuOption<VariantId>[] = variantsFor(context).map((v) => ({
    value: v.id,
    label: t(v.label),
  }))

  const pair = Boolean(base && quote && base.address !== quote.address)
  const symIn = base ? displaySymbol(base) : ''
  const symOut = quote ? displaySymbol(quote) : ''

  // A saved choice can name a variant this screen does not offer — the same reader switching
  // between pages, or a variant withdrawn from one context. Fall back rather than draw nothing.
  const active = options.some((o) => o.value === variant) ? variant : (options[0]?.value ?? 'curve')

  return (
    <aside
      className="panel-ink grid min-w-0 content-start gap-2 p-2 sm:p-4"
      aria-label={t('chart.pool.label')}>
      {/*
        The pair names the panel; the menu says which drawing of it you are looking at.

        There used to be a third thing here — an uppercase "the pool" on the left, with the pair
        pushed over to the right beside the menu. It was the same word on every pair, in every
        drawing, above a chart whose axes already say what it is, and it left the one changing
        thing on the crowded end of the row. The heading survives for the document outline and for
        a screen reader, where a landmark does need a name.
      */}
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 className="sr-only">{t('chart.pool.label')}</h3>
        {pair && base && quote && (
          <span className="flex min-w-0 items-center gap-2">
            <PairAvatars tokenIn={base} tokenOut={quote} size={18} />
            <span className="num truncate text-[12.5px] text-(--color-bright)">
              {symIn}/{symOut}
            </span>
          </span>
        )}
        {options.length > 1 && (
          <Menu
            value={active}
            options={options}
            onChange={(next) => {
              setVariant(next)
              writeVariant(context, next)
            }}
            label={t('chart.pick')}
            className="ms-auto shrink-0"
          />
        )}
      </div>

      {!pair && <p className="py-6 text-[13px] text-(--color-dim)">{t('chart.pool.pick')}</p>}

      {pair && base && quote && active === 'ladder' && (
        <Ladder
          base={base}
          quote={quote}
          levels={book.levels}
          reserves={book.reserves}
          gamma={book.gamma}
        />
      )}

      {pair && base && quote && active === 'capacity' && (
        <Capacity
          base={base}
          quote={quote}
          levels={book.levels}
          reserves={book.reserves}
          gamma={book.gamma}
          poolState={book.poolState}
        />
      )}

      {pair && base && quote && active === 'impact' && (
        <Impact
          base={base}
          quote={quote}
          levels={book.levels}
          reserves={book.reserves}
          gamma={book.gamma}
        />
      )}

      {pair && base && quote && active === 'tape' && (
        <Tape
          base={base}
          quote={quote}
          intents={book.intents}
          spot={book.reserves ? book.reserves.y / book.reserves.x : null}
          now={book.now}
        />
      )}

      {pair && base && quote && active === 'reserves' && (
        <Reserves
          base={base}
          quote={quote}
          levels={book.levels}
          reserves={book.reserves}
          gamma={book.gamma}
          poolState={book.poolState}
        />
      )}

      {active === 'curve' && draft && (
        <SignPreview
          bare
          tokenIn={base}
          tokenOut={quote}
          amountIn={draft.amountIn}
          minOut={draft.minOut}
          minOutEnd={draft.minOutEnd}
          dutch={draft.dutch}
          duration={draft.duration}
          fall={draft.fall ?? FULL_FALL}
          startsIn={draft.startsIn ?? 0}
          liveIn={draft.liveIn ?? draft.startsIn ?? 0}
          read={pool}
        />
      )}
    </aside>
  )
}

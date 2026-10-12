import { Fragment, useEffect, useMemo, useState } from 'react'
import type { Address } from 'viem'
import type { BoardIntent } from '../hooks/useBoard'
import {
  armingFor,
  displaySymbol,
  edgeOf,
  quote as settlementQuote,
  isPermit2,
  marketAddress,
  maxFeeRateFor,
  settlementLive,
  simulateFills,
  type Fill,
  type FillMode,
  type FillPlan,
  type TokenInfo,
} from '@prove.cash/sdk'
import { units } from '../lib/amount'
import { errorLine } from '../lib/errors'
import { rate as fmtRate, t, tCount } from '../lib/i18n'
import { loadPoolMap, poolKey, walkBatch, type Pool, type WalkFill } from '../lib/pool'
import { executeFills } from '../lib/settlement'
import { spokenAmount } from '../lib/speech'
import { BatchWalk } from './charts/BatchWalk'
import { TokenUnit } from './TokenAvatar'

/**
 * The selection tray. Totals what a batch fill costs, returns, and nets, names
 * the contract function it will call and why, and refuses to enable a fill that does not pass
 * an `eth_call` first — an executor never pays to learn an intent went stale.
 *
 * The net is priced along the pool curve, not row by row. Each row's quote is taken against the
 * current reserves as though it were the only trade in the world, and summing those quotes was
 * wrong by 0.86 tUSDC — and wrong in sign — on three live rows: the executor unwinds the batch
 * through one pool, and every fill moves it for the next. `walkBatch` nets opposing rows against
 * each other first, then walks whatever is left along the curve in fill order.
 *
 * There is no callback mode here. `fillWithCallback` calls `msg.sender` back, so the executor
 * has to be a contract, and a tab is a wallet. A solver runs that path from its own bot.
 */

type Totals = Map<string, { amount: bigint; decimals: number }>

function add(totals: Totals, symbol: string, amount: bigint, decimals: number) {
  const running = totals.get(symbol)
  if (running) running.amount += amount
  else totals.set(symbol, { amount, decimals })
}

/**
 * The totals, one per symbol, each with its token's face.
 *
 * `tokens` maps a symbol back to its token, because the totals — and the walk's — are keyed by
 * symbol alone. A symbol the map does not know prints as text, the way it always did.
 */
function TotalList({
  totals,
  tokens,
  sign,
}: {
  totals: ReadonlyMap<string, { amount: bigint; decimals: number }>
  tokens: ReadonlyMap<string, TokenInfo>
  sign?: boolean
}) {
  const parts = [...totals.entries()]
  if (parts.length === 0) {
    return (
      <span className="text-(--color-dim)">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{t('batch.nothing')}</span>
      </span>
    )
  }
  return (
    <>
      {parts.map(([symbol, total], i) => {
        const spoken = spokenAmount(total.amount, total.decimals, symbol)
        const token = tokens.get(symbol)
        // The space between totals is the line's only place to break. Each total is one
        // unbreakable run, and two of them with nothing between are one longer run, which at
        // 375px carried the third total off the tray.
        return (
          <Fragment key={symbol}>
            {i > 0 && ' '}
            <span className="num whitespace-nowrap">
              {/* A signed figure is an expression, so it carries `.ltr`; see IntentRow. */}
              <span aria-hidden="true" className="inline-flex items-center gap-1">
                {i > 0 && <span>+</span>}
                <span className="ltr">
                  {sign && total.amount > 0n ? '+' : ''}
                  {units(total.amount, total.decimals, 4)}
                </span>
                {token ? <TokenUnit token={token} /> : <span>{symbol}</span>}
              </span>
              {/* Four decimal places on screen, the whole figure in the ear. */}
              <span className="sr-only">
                {i > 0 ? ` ${t('batch.and')} ` : ''}
                {sign && total.amount > 0n ? t('stat.profit.spoken', { amount: spoken }) : spoken}
              </span>
            </span>
          </Fragment>
        )
      })}
    </>
  )
}

type Sim =
  | { state: 'idle' | 'running' }
  | { state: 'ok'; note?: string }
  | { state: 'fail'; reason: string }

export function BatchTray({
  items,
  now,
  account,
  onClear,
  onConnect,
}: {
  items: BoardIntent[]
  now: bigint
  account: Address | null
  onClear: () => void
  onConnect: () => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [sim, setSim] = useState<Sim>({ state: 'idle' })
  const [pools, setPools] = useState<ReadonlyMap<string, Pool>>(new Map())
  const live = settlementLive()

  // One reserve snapshot per pair in the selection. Two multicalls, and the whole curve is local
  // arithmetic from there — the alternative is a router quote per row per keystroke.
  const pairs = useMemo(
    () => items.map((i) => [marketAddress(i.tokenIn), marketAddress(i.tokenOut)] as const),
    [items],
  )
  const pairsKey = useMemo(
    () => [...new Set(pairs.map(([a, b]) => poolKey(a, b)))].sort().join(','),
    [pairs],
  )
  useEffect(() => {
    if (pairs.length === 0) {
      setPools(new Map())
      return
    }
    let stale = false
    loadPoolMap(pairs)
      .then((p) => !stale && setPools(p))
      .catch(() => {})
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairsKey])

  // ── What the plan is ────────────────────────────────────────────────────────

  /** True when this intent's escrow must be funded by its 3009 authorization at fill time. */
  const needsAuth = (item: BoardIntent) =>
    (item.intent.flags & 2) !== 0 &&
    !!item.intent.auth &&
    (item.reservation?.amount ?? 0n) < item.intent.amountIn

  /**
   * True when this intent carries a permit the relayer's allowance may still need.
   *
   * Unlike an authorization there is nothing to read on chain that says whether it has been used:
   * a permit sets an allowance, and the allowance may have come from anywhere. So the permit is
   * carried whenever the intent has one, and the settlement decides — `_grantAllowance` skips a
   * maker who already has the allowance, and the pull is the arbiter for everyone else. Sending
   * it costs calldata and nothing else; leaving it out costs the fill.
   */
  const needsPermit = (item: BoardIntent) =>
    (item.intent.flags & 2) === 0 && !!item.intent.permit

  /** True when this intent is funded by a Permit2 transfer. It has no other way in. */
  const needsPermit2 = (item: BoardIntent) => isPermit2(item.intent) && !!item.intent.permit2

  /**
   * One leg, with the bytes that reach its maker's funds when it needs them.
   *
   * The single-leg doors read the signature off the intent themselves, so this only matters to a
   * batch. A leg that cannot be armed leaves nothing behind — the settlement arms inside a frame
   * of its own, so the maker's nonce is unspent and their tokens have not moved — and the batch
   * steps over it. The only cost of being wrong here is the calldata.
   */
  const fills: Fill[] = items.map((item) => {
    const arming =
      needsAuth(item) || needsPermit(item) || needsPermit2(item) ? armingFor(item.intent) : undefined
    return { intent: item.intent, take: item.intent.amountIn, ...(arming ? { arming } : {}) }
  })

  const single = items.length === 1
  const authMode = single && needsAuth(items[0])
  const permitMode = single && !authMode && needsPermit(items[0])
  const permit2Mode = single && needsPermit2(items[0])
  /**
   * One row goes through its own door; several go through the batch.
   *
   * `fillWithAuthorization` and `fillWithPermit` settle one leg for less gas than a batch of one,
   * which pays for an array, a loop and a fee run it cannot use. Both reach the same arming code
   * `fillBatch` reaches, so the choice costs nothing but gas — and above one row only the batch
   * can settle them together, which is what `arming` on each leg is for.
   */
  const mode: FillMode =
    items.length > 1
      ? 'batch'
      : authMode
        ? 'authorization'
        : permitMode
          ? 'permit'
          : permit2Mode
            ? 'permit2'
            : 'direct'
  // The rate the totals above were priced with, and nothing higher. It is the dearest leg's own
  // signed rate: a maker names their own, and a bound below it makes the contract step over that
  // row. Nothing on chain can raise it, so this is a number the page can compute for itself.
  const plan: FillPlan = {
    mode,
    fills,
    maxFeeRate: maxFeeRateFor(items.map((i) => i.intent)),
    skipInvalid: true,
  }

  // ── What the plan costs ─────────────────────────────────────────────────────

  const pay: Totals = new Map()
  const receive: Totals = new Map()
  const fee: Totals = new Map()
  const walkFills: WalkFill[] = []
  /** Symbol to token, so a total can wear its face. */
  const tokens = new Map<string, TokenInfo>()
  for (const item of items) {
    tokens.set(displaySymbol(item.tokenIn), item.tokenIn)
    tokens.set(displaySymbol(item.tokenOut), item.tokenOut)
    // The gross: the whole tokenOut outlay for this leg. The maker takes `owedToMaker`
    // less the P3 cut, and the intent's fee config takes `itemFee`; it is already inside the pay
    // total and nothing below may add it again.
    // `owed` is that outlay at the output fee (P2) too, and `usable` is what the handover fee (P1)
    // leaves of the maker's tokenIn. P3 comes out of the maker's share, inside `owedToMaker`.
    const q = settlementQuote(item.intent, item.intent.amountIn, now)
    const required = q.owed
    const itemFee = q.feeOut + q.feeProceeds
    add(pay, displaySymbol(item.tokenOut), required, item.tokenOut.decimals)
    add(receive, displaySymbol(item.tokenIn), q.usable, item.tokenIn.decimals)
    add(fee, displaySymbol(item.tokenOut), itemFee, item.tokenOut.decimals)
    const edge = edgeOf(item.intent, item.quote, now)
    walkFills.push({
      key: item.key,
      tokenIn: marketAddress(item.tokenIn),
      tokenOut: marketAddress(item.tokenOut),
      symbolIn: displaySymbol(item.tokenIn),
      symbolOut: displaySymbol(item.tokenOut),
      decimalsIn: item.tokenIn.decimals,
      decimalsOut: item.tokenOut.decimals,
      amountIn: item.intent.amountIn,
      required,
      fee: itemFee,
      // `edge.profit` is `quote.out - required`, and `required` is now the whole outlay, so the
      // fee is already in it. Subtracting `itemFee` here charged this row for the fee twice.
      soloNet: edge ? edge.profit : null,
    })
  }
  // The fills go in the plan's order, so the walk is the order the executor will actually fill.
  const walk = walkBatch(walkFills, pools)
  const net = walk.net
  /** Rows with no route at all: neither a router quote nor a pool to walk. */
  const unquoted = walk.unpriced.filter((f) => f.soloNet === null).length
  /** Rows whose pair has no pool, so they keep the figure they were quoted alone with. */
  const alone = walk.unpriced.length - unquoted
  const soloDiffers = [...walk.solo.entries()].some(
    ([symbol, total]) => (net.get(symbol)?.amount ?? 0n) !== total.amount,
  )

  // ── Simulation before the button ────────────────────────────────────────────

  const itemsKey = useMemo(() => items.map((i) => i.key).join(','), [items])

  useEffect(() => {
    setSim({ state: 'idle' })
    if (!live || !account || items.length === 0) return
    const timer = setTimeout(async () => {
      setSim({ state: 'running' })
      const res = await simulateFills(account, plan)
      setSim(res.ok ? { state: 'ok', note: res.note } : { state: 'fail', reason: res.reason })
    }, 400)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, account, itemsKey, mode, plan.maxFeeRate])

  async function execute() {
    setMessage(null)
    if (!account) {
      try {
        await onConnect()
      } catch (e) {
        setMessage(errorLine(e) || t('wallet.failed'))
      }
      return
    }
    setBusy(true)
    try {
      const hash = await executeFills(account, plan)
      const short = `${hash.slice(0, 18)}…`
      setMessage(t('batch.sent', { hash: short }))
      onClear()
    } catch (e) {
      setMessage(errorLine(e) || t('batch.failed'))
    } finally {
      setBusy(false)
    }
  }

  if (items.length === 0) return null

  // ── Why this mode ───────────────────────────────────────────────────────────

  const modeLine =
    mode === 'batch'
      ? t('batch.mode.batch', { count: items.length })
      : mode === 'authorization'
        ? t('batch.mode.auth')
        : t('batch.mode.direct', { symbol: displaySymbol(items[0].tokenOut) })

  const fillLabel =
    tCount('batch.fill', items.length)

  // The note rides inside the badge, separator and all, so the key holds one slot rather than an
  // optional clause a translator cannot place.
  const simNote = sim.state === 'ok' && sim.note ? ` · ${sim.note}` : ''

  const simSpoken =
    sim.state === 'fail'
      ? t('batch.sim.fail.spoken', { reason: sim.reason })
      : sim.state === 'ok'
        ? sim.note
          ? t('batch.sim.ok.spoken.note', { note: sim.note })
          : t('batch.sim.ok.spoken')
        : sim.state === 'running'
          ? t('batch.sim.running.spoken')
          : t('batch.sim.idle.spoken')

  return (
    <div
      className="sticky bottom-0 z-40 mt-4 mx-auto w-full max-w-6xl sm:bottom-4"
      role="region"
      aria-label={t('batch.region')}>
      <div className="panel-float gutter py-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <span className="text-sm font-medium text-(--color-bright) whitespace-nowrap">
          {tCount('batch.selected', items.length)}
        </span>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs">
          <span>
            <span className="text-(--color-dim) me-1.5">{t('batch.pay')}</span>
            <TotalList totals={pay} tokens={tokens} />
          </span>
          <span>
            <span className="text-(--color-dim) me-1.5">{t('batch.receive')}</span>
            <TotalList totals={receive} tokens={tokens} />
          </span>
          <span>
            <span className="text-(--color-dim) me-1.5">{t('batch.fee')}</span>
            <TotalList totals={fee} tokens={tokens} />
          </span>
          <span
            className={
              [...net.values()].some((total) => total.amount > 0n) ? 'text-(--color-proven)' : ''
            }>
            <span className="text-(--color-dim) me-1.5" title={t('batch.net.tip')}>
              {t('batch.net')}
            </span>
            <TotalList totals={net} tokens={tokens} sign />
            {unquoted > 0 && (
              <span className="text-(--color-dim) ms-1">
                {t('batch.unquoted', { count: unquoted })}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2 ms-auto">
          {live && account && (
            <span
              role="status"
              className={`num text-[11px] whitespace-nowrap ${
                sim.state === 'ok'
                  ? 'text-(--color-proven)'
                  : sim.state === 'fail'
                    ? 'text-(--color-danger)'
                    : 'text-(--color-dim)'
              }`}
              title={t('batch.sim.tip')}>
              {/* A tick and a cross are shapes, not words. The words go beside them. */}
              <span aria-hidden="true">
                {sim.state === 'fail'
                  ? t('batch.sim.fail', { reason: sim.reason })
                  : sim.state === 'ok'
                    ? t('batch.sim.ok', { note: simNote })
                    : sim.state === 'running'
                      ? t('batch.sim.running')
                      : t('batch.sim.idle')}
              </span>
              <span className="sr-only">{simSpoken}</span>
            </span>
          )}
          <button className="btn btn-ghost text-xs py-1.5" onClick={onClear}>
            {t('batch.clear')}
          </button>
          <button
            className="btn btn-primary text-xs py-1.5"
            disabled={!live || busy || (!!account && sim.state !== 'ok')}
            onClick={execute}>
            {!live
              ? t('batch.notDeployed')
              : busy
                ? t('batch.filling')
                : !account
                  ? t('wallet.connect')
                  : sim.state === 'running'
                    ? t('batch.simulating')
                    : fillLabel}
          </button>
        </div>

        <div className="basis-full flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-(--color-dim)">
          <span className="num">{modeLine}</span>
          {soloDiffers && (
            <span className="num" title={t('batch.solo.tip')}>
              <span className="me-1.5">{t('batch.solo')}</span>
              <TotalList totals={walk.solo} tokens={tokens} sign />
            </span>
          )}
          {alone > 0 && (
            <span className="num" title={t('batch.alone.tip')}>
              {tCount('batch.alone', alone)}
            </span>
          )}
          <span className="num" title={t('batch.bound.tip')}>
            <span aria-hidden="true">{t('batch.bound', { rate: fmtRate(plan.maxFeeRate) })}</span>
            <span className="sr-only">
              {t('batch.bound.spoken', { rate: fmtRate(plan.maxFeeRate) })}
            </span>
          </span>
        </div>

        {/*
          One row is its own walk, and the picture would say nothing the number does not. The
          chart earns its space from two fills up, where the second one lands somewhere the table
          never showed.
        */}
        {items.length > 1 && walk.steps.length > 1 && <BatchWalk walk={walk} pools={pools} />}

        {message && (
          <p role="status" className="basis-full text-xs text-(--color-body) break-all">
            {message}
          </p>
        )}
      </div>
    </div>
  )
}

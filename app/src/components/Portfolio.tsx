import { useCallback, useEffect, useRef, useState } from 'react'
import type { Address, Hex } from 'viem'
import {
  decodeIntent,
  displaySymbol,
  getChainId,
  intentHashOf,
  isPermit2,
  queryIntents,
  readReservations,
  recordToIntent,
  settlementLive,
  tokenInfo,
  waitForTx,
  type ReservationState,
  type SignedIntent,
  type StoredIntent,
  type TokenInfo,
} from '@prove.cash/sdk'
import { units } from '../lib/amount'
import {
  cancelIntent,
  invalidateBefore,
  readCancelled,
  readFloor,
  readParked,
  readParkedTokens,
  withdrawParked,
  withdrawReservation,
} from '../lib/settlement'
import { errorLine } from '../lib/errors'
import { cleanupLink } from '../lib/cleanup'
import { WHERE } from '../lib/custody'
import { bulkRetire, type BulkRetire } from '../lib/nonce-lane'
import { parkedRows, parkedTokenSet, unfundedAndLive, type ParkedRow } from '../lib/parked'
import { t, tSplit } from '../lib/i18n'
import { spokenAmount } from '../lib/speech'
import { FlagBadge, WhereBadge } from './StateIcon'
import { PairAvatars, TokenAvatar, TokenUnit } from './TokenAvatar'

/**
 * What a wallet has committed. Every signed intent from this maker, its custody mode, the escrow
 * behind it, and one button to undo it.
 *
 * Two views over one table. Without a subject it lists the connected wallet's own offers, all of
 * them. A cleanup link names an address and lists only the rows that still want something: money
 * the contract holds, or a signature the chain would still accept. Anybody may read a cleanup
 * link, so the buttons appear for the named wallet alone.
 *
 * One button per row, because there is nothing else to do. There was an unlock step and a
 * cooldown and a collection window that shut again if you missed it; all of it protected an
 * executor who buys the other side of a trade in a separate transaction, and every fill path
 * settles in one. `withdraw` now returns the money and ends the offer in the same call.
 *
 * **A second table sits above the first, and it exists because money can now leave a row here
 * without the maker doing anything.** `park` is permissionless: the moment one of their offers
 * dies, anybody may move its deposit out of `_reserved[hash]` and into `_parked[maker][token]`,
 * which is a row no intent owns. `ProveSettlement.park` names the hazard in its own NatSpec — "a
 * client that knows one function and not the other will show them a balance that has gone
 * somewhere" — so this page reads both maps or it lies.
 *
 * **And the same change cost the maker a property, which the copy states rather than hides.** An
 * escrow offer they signed and never funded used to be inert for ever. Any solver may now fund
 * one out of that resting capital, at a moment the solver picks. So a live offer with nothing
 * behind it gets a cancel button, where it used to get the words "nothing held" and no way out
 * at all. `AUDIT-SCOPE` 6.11 is the disclosure and `FLAG_ESCROW`'s NatSpec is the contract's own
 * account of it.
 */


type Row = {
  key: string
  intent: SignedIntent
  tokenIn: TokenInfo
  tokenOut: TokenInfo
  custody: 'auth' | 'escrow' | 'wallet'
  hash: Hex | null
  reservation: ReservationState | null
  expired: boolean
  cancelled: boolean
}

/** How much the contract still holds against this row. */
const held = (r: Row): bigint => r.reservation?.amount ?? 0n

/**
 * Whether a row still wants something from its maker.
 *
 * Money first: what the contract holds is the maker's whatever else is true of the intent, and a
 * cancel does not release it. Then the live signatures — an escrowed intent has no hour limit, so
 * one can rest for months with nothing but a cancel to stop a fill.
 *
 * An escrow read that failed counts as money. Hiding a row hides a deposit; keeping it costs a
 * line and the next poll settles it.
 */
function needsAction(r: Row): boolean {
  if (r.custody !== 'wallet' && r.reservation === null) return true
  return held(r) > 0n || (!r.expired && !r.cancelled)
}

// `unfundedAndLive` and `parkedRows` are in `lib/parked.ts`, not here. This component fills its
// table from an effect and `renderToStaticMarkup` never runs one, so a decision made inside it is
// a decision no test can reach — and these two decide whether a maker is shown their money and
// whether they are offered the only off switch an escrow offer has left.
//
// `bulkRetire` is in `lib/nonce-lane.ts` for the same reason and a sharper one: it decides which
// of a maker's offers an irreversible transaction ends.

/** A Mine row, in the shape the floor decision reads, carrying the row back for the confirm list. */
type LaneRow = { key: string; laneNonce: bigint; live: boolean; row: Row }

/** The busy key the bulk switch holds. No row can collide with it: a row key is a record key. */
const RETIRE_KEY = 'retire:all'


export function Portfolio({
  account,
  subject = null,
  onConnect,
}: {
  /** The connected wallet. Undefined until the wallet has answered, null when it has no account. */
  account: Address | null | undefined
  /** Whose offers to show. Null is the connected wallet. An address turns on the cleanup view. */
  subject?: Address | null
  onConnect: () => Promise<void>
}) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [parked, setParked] = useState<ParkedRow[]>([])
  /** Lane 0's floor, read from the chain. Null while it is unread, and after a read that failed. */
  const [floor, setFloor] = useState<bigint | null>(null)
  /** True once the maker has asked for the bulk switch and is reading what it kills. */
  const [confirming, setConfirming] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const live = settlementLive()
  const maker = subject ?? account
  const canAct = account != null && maker != null && account.toLowerCase() === maker.toLowerCase()

  /*
    Everything on this page belongs to one maker. `App.tsx` keys this component by chain only, so
    an account switch is a prop change on a live instance, and the old maker's rows, floor and
    open confirm panel would stay on screen with live buttons. The bulk switch would then send
    `invalidateBefore(newMaker, oldFloor)`. Drop all of it in the same render that sees the new
    maker, so no frame shows one maker's offers under another's account.
  */
  const [shownFor, setShownFor] = useState(maker)
  if (shownFor !== maker) {
    setShownFor(maker)
    setRows(null)
    setParked([])
    setFloor(null)
    setConfirming(false)
    setMessage(null)
  }

  /*
    Only the newest load may write. A slow read for the previous maker, or an earlier poll, can
    land after a newer one; it is dropped rather than written over the newer answer.
  */
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const current = () => seq === loadSeq.current
    if (!maker) {
      setRows(null)
      setParked([])
      setFloor(null)
      return
    }
    const chainId = getChainId()
    const { rows: records } = await queryIntents({
      chainId,
      maker,
      newestFirst: true,
      limit: 100,
    })
    const addresses = new Set<string>()
    for (const r of records) {
      addresses.add(r.tokenIn)
      addresses.add(r.tokenOut)
    }
    /*
      The token set, and the maker's floor, in one round of reads.

      `queryIntents` answers from a store on this device, so the tokens above are the ones this
      browser happens to remember. `readParkedTokens` asks the chain instead: `Parked` indexes the
      maker, so its logs name every token that ever parked for them, whatever this device knows.
      A read that fails answers null and the union simply keeps the local half — a bad minute on
      an endpoint must never delete a row the maker can already see.

      The floor rides along because both are reads about the same maker and neither blocks the
      other. `readFloor` answers null when it fails, which hides the bulk switch rather than
      offering one built on a number nobody read.
    */
    const [loggedTokens, chainFloor] = await Promise.all([
      readParkedTokens(maker),
      readFloor(maker),
    ])
    const wanted = parkedTokenSet([...addresses] as Address[], loggedTokens)
    // A token whose decimals the chain would not give us is left out. `tokenInfo` used to answer
    // 18 for those and cache it, which showed the maker a size a million million times off for a
    // six-decimal token — on the one page whose job is telling them what they have committed.
    const infos = new Map<string, TokenInfo>()
    await Promise.all(
      wanted.map(async (a) => {
        const info = await tokenInfo(chainId, a)
        if (info) infos.set(a, info)
      }),
    )
    const nowS = Math.floor(Date.now() / 1000)
    const base: Row[] = records
      .filter((r: StoredIntent) => infos.has(r.tokenIn) && infos.has(r.tokenOut))
      .map((r: StoredIntent) => {
        const intent = decodeIntent(r.data as Hex) ?? recordToIntent(r)
        const escrowFlag = (r.flags & 2) !== 0
        return {
          key: r.key,
          intent,
          tokenIn: infos.get(r.tokenIn)!,
          tokenOut: infos.get(r.tokenOut)!,
          custody: (intent.auth ? 'auth' : escrowFlag ? 'escrow' : 'wallet') as Row['custody'],
          // The hash is a local keccak, so every row carries one. Only escrow rows cost a read.
          hash: live ? intentHashOf(intent, chainId) : null,
          reservation: null,
          expired: r.endTime <= nowS,
          cancelled: false,
        }
      })
    const escrowed = base.filter((r) => r.custody !== 'wallet' && r.hash !== null)
    const reservations = await readReservations(escrowed.map((r) => r.hash!))
    escrowed.forEach((r, i) => {
      r.reservation = reservations[i]
    })
    /*
      Both views pay for this now, where only the cleanup view used to.

      Cleanup needed it to hide the rows that want nothing, because expiry alone cannot tell it
      which those are. The main view needs it for the opposite reason: a live escrow offer with
      nothing behind it gets a cancel button since `_drawFromParked`, and offering that cancel on
      an offer the maker already called off is a transaction that reverts. One batched read.

      A read that fails answers false, which shows the button. That is the safe way to be wrong —
      a cancel that reverts costs one rejected simulation, and a missing one leaves a signature a
      solver can still fund.
    */
    const hashed = base.filter((r) => r.hash !== null)
    const flags = await readCancelled(hashed.map((r) => r.hash!))
    hashed.forEach((r, i) => {
      r.cancelled = flags[i]
    })
    if (!current()) return
    setRows(subject ? base.filter(needsAction) : base)
    setFloor(chainFloor)

    /*
      Which tokens to ask about, and why it is wider than the offers on screen twice over.

      `_parked` is keyed by maker and token, so only a `tokenIn` can ever be credited. But a token
      is `tokenIn` on one offer and `tokenOut` on another, and the offer that funded the row may
      have scrolled past the hundred this query takes. Both halves cost one multicall together, so
      the wider set is free and it finds rows the narrow one misses.

      The second widening is the chain's own. Every token above still came out of a record this
      device holds, so a maker who signed on another browser saw nothing here at all. The `Parked`
      logs answer without a record store, and `readParkedTokens` says what its block window costs.
    */
    const held = wanted.map((a) => infos.get(a)).filter((info) => info !== undefined)
    const amounts = await readParked(
      maker,
      held.map((info) => info.address),
    )
    // A read that did not come back is left out rather than shown as empty, and an empty row is
    // not a line. `parkedRows` owns both rules and a test drives them.
    if (!current()) return
    setParked(parkedRows(held, amounts))
  }, [maker, subject, live])

  useEffect(() => {
    // A failed read keeps what this maker already sees, and the next poll tries again. The
    // action handlers await `load` inside their own `catch`, so only these two calls need one.
    const poll = () => void load().catch(() => {})
    poll()
    const t = setInterval(poll, 15_000)
    return () => clearInterval(t)
  }, [load])

  // Withdraw where the contract holds money, cancel where it holds only a signature. Both end
  // the offer, and the contract refuses either from anybody but the maker.
  async function act(row: Row) {
    if (!account || !canAct) return
    const withdrawing = held(row) > 0n
    setBusyKey(row.key)
    setMessage(null)
    try {
      await waitForTx(
        withdrawing
          ? await withdrawReservation(account, row.intent)
          : await cancelIntent(account, row.intent),
      )
      await load()
    } catch (e) {
      setMessage(
        errorLine(e) || (withdrawing ? t('mine.withdraw.failed') : t('mine.cancel.failed')),
      )
    } finally {
      setBusyKey(null)
    }
  }

  /*
    Take one token's resting capital home. One call per token, because the contract keeps one row
    per token — a maker holding three assets here is owed three transfers whatever shape the
    button takes.

    There is no recipient to get wrong. `withdrawParked` reads `msg.sender`, empties that row and
    pays that address, so the only thing this passes is which token.
  */
  async function takeParked(p: ParkedRow) {
    if (!account || !canAct) return
    const key = `parked:${p.token.address}`
    setBusyKey(key)
    setMessage(null)
    try {
      await waitForTx(await withdrawParked(account, p.token.address))
      await load()
    } catch (e) {
      setMessage(errorLine(e) || t('mine.parked.failed'))
    } finally {
      setBusyKey(null)
    }
  }

  /*
    Turn every offer off with one word.

    `invalidateBefore` writes a position over this maker's lane-0 floor and every signature below
    it stops being fillable. It carries no offer, which is the whole point: `cancel` takes the
    signed struct back, so fifty cancels need fifty of them and a maker who cleared their browser
    holds none.

    It returns no money. A killed offer's deposit stays in `_reserved` until somebody parks it —
    `park` reads the floor, so anybody may — and it lands in the table above, one withdrawal per
    token. The confirm panel says that before the maker sends anything.
  */
  async function retireAll(plan: BulkRetire<LaneRow>) {
    if (!account || !canAct) return
    setBusyKey(RETIRE_KEY)
    setMessage(null)
    try {
      await waitForTx(await invalidateBefore(account, plan.floor))
      setConfirming(false)
      await load()
    } catch (e) {
      setMessage(errorLine(e) || t('mine.retire.failed'))
    } finally {
      setBusyKey(null)
    }
  }

  async function copyLink() {
    if (!account) return
    try {
      await navigator.clipboard.writeText(cleanupLink(window.location.origin, getChainId(), account))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setMessage(t('mine.clipboard.failed'))
    }
  }


  // The rows' stand-in, the size of two rows.
  const skeleton = (
    <div className="grid gap-px bg-(--color-line)">
      {[0, 1].map((i) => (
        <div key={i} className="row h-14 animate-pulse opacity-40" />
      ))}
    </div>
  )

  // The wallet has not answered yet. "Your intents live behind your wallet" before then told a
  // connected wallet that it was not connected.
  if (maker === undefined) return skeleton

  // A centred empty state is the one place that earns a p-8.
  if (!maker) {
    return (
      <div className="w-full">
        <div className="panel p-8 text-center">
          <p className="text-(--color-bright) font-medium">{t('mine.locked')}</p>
          <button className="btn btn-primary mt-4" onClick={() => onConnect().catch(() => {})}>
            {t('wallet.connect')}
          </button>
        </div>
      </div>
    )
  }

  if (rows === null) return skeleton

  /*
    Capital resting here, one row per token, and it renders in every branch below.

    A cleanup view can say "nothing to clean up" about the offers and still be looking at a
    wallet with money in this map — `park` empties an offer's reservation, so the row that held
    it reads clean afterwards. Hiding this behind the offers table would tell that maker their
    money is gone.

    Three columns rather than the offer table's five, so there is no minimum width and nothing
    scrolls sideways at 375px.
  */
  const parkedGrid =
    'grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,7rem)] gap-x-4 items-center'
  const parkedSection = parked.length === 0 ? null : (
    <>
      <div className="gutter pb-2.5 grid justify-items-start gap-1 text-[11px] leading-relaxed text-(--color-dim)">
        <p>
          <span className="text-(--color-body)">{t('mine.parked.lead')}</span>{' '}
          {t('mine.parked.body')}
        </p>
      </div>
      <div
        role="table"
        aria-label={t('mine.parked.title')}
        aria-rowcount={parked.length + 1}
        className="pb-1">
        <div role="rowgroup">
          <div
            role="row"
            className={`${parkedGrid} gutter pb-1.5 text-[11px] uppercase tracking-wider text-(--color-dim)`}>
            <span role="columnheader">{t('mine.parked.col.token')}</span>
            <span role="columnheader" className="text-end">
              {t('mine.parked.col.amount')}
            </span>
            <span role="columnheader" className="text-end">
              {t('mine.col.action')}
            </span>
          </div>
        </div>
        <div role="rowgroup" className="grid gap-px bg-(--color-line)">
          {parked.map((p) => {
            const key = `parked:${p.token.address}`
            const symbol = displaySymbol(p.token)
            return (
              <div key={key} role="row" className={`${parkedGrid} row gutter py-2.5`}>
                <div
                  role="cell"
                  className="flex items-center gap-1.5 text-sm text-(--color-bright) min-w-0">
                  <TokenAvatar token={p.token} />
                  <span className="break-all sm:truncate">{symbol}</span>
                </div>
                <div role="cell" className="num text-end text-sm text-(--color-body)">
                  <span aria-hidden="true">{units(p.amount, p.token.decimals)}</span>
                  <span className="sr-only">
                    {t('mine.parked.spoken', {
                      amount: spokenAmount(p.amount, p.token.decimals, symbol),
                    })}
                  </span>
                </div>
                <div role="cell" className="flex items-center justify-end">
                  {canAct ? (
                    <button
                      className="btn btn-ghost text-[11px] py-1 px-2.5"
                      disabled={busyKey === key}
                      aria-label={t('mine.parked.withdraw.label', { symbol })}
                      title={t('mine.parked.withdraw.tip')}
                      onClick={() => takeParked(p)}>
                      {busyKey === key ? '…' : t('mine.withdraw')}
                    </button>
                  ) : (
                    // `withdrawParked` pays `msg.sender`, so a reader who is not the maker is
                    // told what is owed and given no button that could only revert.
                    <span className="text-[11px] text-(--color-dim)">{t('mine.withdraw')}</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )

  if (rows.length === 0) {
    return (
      <>
        {parkedSection}
        <div className="w-full">
          <div className="panel p-8 text-center">
            <p className="text-(--color-bright) font-medium">
              {subject ? t('mine.clean') : t('mine.none')}
            </p>
            {/* Name the address, or a reader takes the answer for their own wallet's. */}
            {subject && (
              <p className="addr mt-1.5 text-[11px] text-(--color-dim)">{subject}</p>
            )}
          </div>
        </div>
      </>
    )
  }

  const grid =
    'grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_7rem_minmax(0,1fr)_minmax(0,10rem)] gap-x-4 items-center'
  const cleanupNote = tSplit('mine.cleanup.note', 'address')

  /*
    The bulk off switch, and the two things that have to be true before it is drawn.

    The maker has to be the one acting, because the contract writes against `msg.sender` and a
    reader looking at somebody else's cleanup link can only be offered a transaction that reverts.
    And the floor has to have come back from the chain, because the position sent must be strictly
    above it or the contract answers `BadParameter` — a button built on an unread number costs a
    rejected transaction and changes nothing.

    `bulkRetire` decides the rest, and it answers null when one word ends nothing. Then there is
    no button rather than a disabled one, because a disabled control is a claim that the action
    exists and is unavailable, and here it does not exist.
  */
  const retire: BulkRetire<LaneRow> | null =
    live && canAct && floor !== null
      ? bulkRetire<LaneRow>(
          rows.map((r) => ({
            key: r.key,
            laneNonce: r.intent.nonce,
            live: !r.expired && !r.cancelled,
            row: r,
          })),
          floor,
        )
      : null

  /** One line of the confirm list: the pair, and the size the maker signed for it. */
  const retireLine = (r: Row) => (
    <li key={r.key} className="text-(--color-body)">
      {t('mine.pair', { in: displaySymbol(r.tokenIn), out: displaySymbol(r.tokenOut) })}{' '}
      <span className="num inline-flex items-center gap-x-1 text-(--color-dim)">
        {units(r.intent.amountIn, r.tokenIn.decimals)}
        <TokenUnit token={r.tokenIn} />
      </span>
    </li>
  )

  /*
    Two steps, because this cannot be undone.

    The first click opens the list; nothing is sent by it. The second sends the transaction. A
    single button here would end a maker's whole resting book on one mis-click, and no `withdraw`
    brings a signature back — only the money behind it, and only after somebody parks it.

    The trigger stays on screen while the panel is open, which is what makes this a disclosure a
    keyboard can use: a button that removes itself on click drops focus to the document body, and
    the reader who pressed it is left nowhere. `aria-expanded` says which state it is in.

    The panel `bleed`s and takes its own gutter, so its contents line up with the prose above it
    and it spends the inline padding once. See the gutter rule in `index.css`.
  */
  const retireSection = retire === null ? null : (
    <div className="gutter pb-2.5 grid gap-1 text-[11px] leading-relaxed text-(--color-dim)">
      <button
        className="btn btn-ghost justify-self-start text-[11px] py-1 px-2.5"
        aria-expanded={confirming}
        aria-label={t('mine.retire.label')}
        title={t('mine.retire.tip')}
        onClick={() => setConfirming(!confirming)}>
        {t('mine.retire')}
      </button>
      {confirming && (
        <div className="panel bleed gutter grid gap-1.5 py-2 sm:py-4">
          <p>
            <span className="text-(--color-body)">{t('mine.retire.lead')}</span>{' '}
            {t('mine.retire.body')}
          </p>
          <ul className="grid gap-0.5">{retire.kills.map((k) => retireLine(k.row))}</ul>
          {retire.spared.length > 0 && (
            /*
              Offers in another lane, or at the one position a strict floor can never reach.
              Nothing this app builds signs either, and a hand-signed intent can. Naming them is
              the difference between a switch that turns off what it says and one that quietly
              turns off less.
            */
            <>
              <p>{t('mine.retire.spared')}</p>
              <ul className="grid gap-0.5">{retire.spared.map((s) => retireLine(s.row))}</ul>
            </>
          )}
          <div className="flex flex-wrap gap-1.5 pt-0.5">
            <button
              className="btn btn-ghost text-[11px] py-1 px-2.5 text-(--color-danger)"
              disabled={busyKey === RETIRE_KEY}
              title={t('mine.retire.tip')}
              onClick={() => void retireAll(retire)}>
              {busyKey === RETIRE_KEY ? '…' : t('mine.retire.confirm')}
            </button>
            <button
              className="btn btn-ghost text-[11px] py-1 px-2.5"
              disabled={busyKey === RETIRE_KEY}
              onClick={() => setConfirming(false)}>
              {t('mine.retire.back')}
            </button>
          </div>
        </div>
      )}
    </div>
  )

  return (
    <>
      <h2 className="sr-only">
        {subject ? t('mine.cleanup.title', { address: subject }) : t('mine.title')}
      </h2>
      {/*
        Both prices a maker pays to change their mind, stated before either button. Nothing on
        this page cancels an intent by itself, and a maker should not read the absence as safety.
      */}
      <div className="gutter pb-2.5 grid justify-items-start gap-1 text-[11px] leading-relaxed text-(--color-dim)">
        {subject ? (
          /* The address is an element, not a word, so the sentence is cut at its placeholder and
             the translator keeps the word order they chose. */
          <p>
            {cleanupNote[0]}
            <span className="addr text-(--color-body)">{subject}</span>
            {cleanupNote[1]} {!canAct && t('mine.cleanup.readonly')}
          </p>
        ) : (
          <>
            <p>
              <span className="text-(--color-body)">{t('mine.escrow.lead')}</span>{' '}
              {t('mine.escrow.body')}
            </p>
            <p>
              <span className="text-(--color-body)">{t('mine.wallet.lead')}</span>{' '}
              {t('mine.wallet.body')}
            </p>
          </>
        )}
        {/*
          The property a maker lost, in both views and in the open.

          It sits here rather than behind an `InfoTip` on purpose. "I signed it and I just will
          not deposit" was a real off switch until `_drawFromParked`, and it was the only one the
          escrow rung had that no other rung had. A maker who does not read this will believe
          they still hold it. `AUDIT-SCOPE` 6.11 asks the app to say so wherever it says anything
          about escrow, and this page is where a maker comes to turn an offer off.
        */}
        <p>
          <span className="text-(--color-body)">{t('mine.parked.hazard.lead')}</span>{' '}
          {t('mine.parked.hazard.body')}
        </p>
        {!subject && (
          /* The link opens this list filtered to the rows that still need an action. */
          <button
            className="btn btn-ghost mt-0.5 text-[11px] py-1 px-2.5"
            aria-label={t('mine.copy.label')}
            title={t('mine.copy.tip')}
            onClick={() => void copyLink()}>
            {copied ? t('mine.copied') : t('mine.copy')}
          </button>
        )}
      </div>
      {retireSection}
      {parkedSection}
      {/* Table roles over the same CSS grid, and the same full-viewport width, as App.tsx. */}
      <div
        role="table"
        aria-label={subject ? t('mine.table.cleanup') : t('mine.title')}
        aria-rowcount={rows.length + 1}
        className="scroll-x pb-1">
        <div role="rowgroup">
          <div
            role="row"
            className={`${grid} gutter pb-1.5 min-w-[720px] text-[11px] uppercase tracking-wider text-(--color-dim)`}>
            {/* `text-end`, so a heading keeps sitting over the figures it names. See IntentRow. */}
            <span role="columnheader">{t('mine.col.pair')}</span>
            <span role="columnheader" className="text-end">
              {t('mine.col.size')}
            </span>
            <span role="columnheader">{t('mine.col.custody')}</span>
            <span role="columnheader" className="text-end">
              {t('mine.col.reserved')}
            </span>
            <span role="columnheader" className="text-end">
              {subject ? t('mine.col.action') : t('mine.col.escrow')}
            </span>
          </div>
        </div>
        {/*
          The min-width lives on the row group, not on the rows. The group paints the rules, so
          its box has to reach the far end of the scroll rather than stop at the scrollport.
        */}
        <div role="rowgroup" className="grid gap-px bg-(--color-line) min-w-[720px]">
          {rows.map((row) => {
            const i = row.intent
            const res = row.reservation
            // The same words the board row wears: where the tokens are, not a verdict.
            const where =
              row.custody === 'wallet'
                ? WHERE[isPermit2(i) ? 'permit2' : 'approval']
                : row.custody === 'auth'
                  ? WHERE.authorization
                  : WHERE.escrow
            const pairName = t('mine.pair', {
              in: displaySymbol(row.tokenIn),
              out: displaySymbol(row.tokenOut),
            })
            // Money in the contract comes back; a signature with nothing behind it is cancelled.
            const withdrawing = held(row) > 0n
            // A live escrow signature with nothing behind it. The cancel is the same call, and
            // the words around it are not: this is the row whose emptiness used to BE the
            // protection, and a maker has to be told that it is not any more.
            const unfunded = unfundedAndLive(row)
            const action = withdrawing ? t('mine.withdraw') : t('mine.cancel')
            const button = (
              <button
                className="btn btn-ghost text-[11px] py-1 px-2.5"
                disabled={busyKey === row.key}
                aria-label={
                  withdrawing
                    ? t('mine.withdraw.label', { pair: pairName })
                    : unfunded
                      ? t('mine.unfunded.label', { pair: pairName })
                      : t('mine.cancel.label', { pair: pairName })
                }
                title={
                  withdrawing
                    ? t('mine.withdraw.tip')
                    : unfunded
                      ? t('mine.unfunded.tip')
                      : t('mine.cancel.tip')
                }
                onClick={() => act(row)}>
                {busyKey === row.key ? '…' : action}
              </button>
            )
            return (
              <div
                key={row.key}
                role="row"
                className={`${grid} row gutter py-2.5 ${row.expired ? 'opacity-90' : ''}`}>
                <div
                  role="cell"
                  className="flex items-center gap-1.5 text-sm text-(--color-bright) min-w-0">
                  <PairAvatars tokenIn={row.tokenIn} tokenOut={row.tokenOut} />
                  <span className="truncate">
                    {displaySymbol(row.tokenIn)}
                    {/* Turned over in RTL, so it still points from the token you give. See IntentRow. */}
                    <span className="inline-block text-(--color-dim) rtl:-scale-x-100" aria-hidden="true">
                      →
                    </span>
                    <span className="sr-only"> {t('row.to')} </span>
                    {displaySymbol(row.tokenOut)}
                  </span>
                  {row.expired && <FlagBadge flag="expired" />}
                </div>
                <div role="cell" className="num text-end text-sm text-(--color-body)">
                  <span
                    aria-hidden="true"
                    className="flex flex-wrap items-center justify-end gap-x-1">
                    <span>{units(i.amountIn, row.tokenIn.decimals)}</span>
                    <TokenUnit token={row.tokenIn} className="text-(--color-dim)" />
                  </span>
                  <span className="sr-only">
                    {spokenAmount(i.amountIn, row.tokenIn.decimals, displaySymbol(row.tokenIn))}
                  </span>
                </div>
                {/*
                  The glyph the board row wears, with the Mine tab's longer sentence behind it:
                  `in escrow — the contract holds them`. The word is the name; the sentence is
                  what a maker wants to know.
                */}
                <span role="cell" className="flex items-center">
                  <WhereBadge
                    where={where}
                    detail={
                      row.custody === 'wallet'
                        ? t(isPermit2(i) ? 'mine.where.fill' : 'mine.where.wallet')
                        : row.custody === 'auth'
                          ? t('mine.where.fill')
                          : t('mine.where.escrow')
                    }
                  />
                </span>
                <div role="cell" className="num text-end text-xs text-(--color-body)">
                  {row.custody === 'wallet' || !live ? (
                    <span className="text-(--color-dim)">
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">{t('mine.reserved.none')}</span>
                    </span>
                  ) : res === null ? (
                    <span className="text-(--color-dim)">
                      <span aria-hidden="true">…</span>
                      <span className="sr-only">{t('mine.reserved.reading')}</span>
                    </span>
                  ) : (
                    <>
                      <span aria-hidden="true">
                        {units(res.amount, row.tokenIn.decimals)}
                        <span className="text-(--color-dim)">
                          {' '}
                          {t('mine.reserved.of', {
                            amount: units(i.amountIn, row.tokenIn.decimals),
                          })}
                        </span>
                      </span>
                      <span className="sr-only">
                        {t('mine.reserved.spoken', {
                          amount: spokenAmount(res.amount, row.tokenIn.decimals),
                          total: spokenAmount(
                            i.amountIn,
                            row.tokenIn.decimals,
                            displaySymbol(row.tokenIn),
                          ),
                        })}
                      </span>
                    </>
                  )}
                </div>
                {/*
                  Cleanup names the one action the row is waiting for, and only the maker gets it
                  as a button. A reader who is not the maker still sees which action is owed.
                */}
                <div role="cell" className="flex items-center justify-end gap-1.5">
                  {subject ? (
                    !live ? (
                      <span className="text-[11px] text-(--color-unproven)">
                        {t('mine.notDeployed')}
                      </span>
                    ) : row.custody !== 'wallet' && res === null ? (
                      // The escrow has not answered. Name no action until it does.
                      <span className="text-[11px] text-(--color-dim)">
                        <span aria-hidden="true">…</span>
                        <span className="sr-only">{t('mine.reserved.reading')}</span>
                      </span>
                    ) : canAct ? (
                      button
                    ) : (
                      <span className="text-[11px] text-(--color-dim)">{action}</span>
                    )
                  ) : row.custody === 'wallet' ? (
                    // Nothing is held and nothing can be: the offer's escrow column repeats its
                    // custody, as the glyph, so the column is never blank.
                    <WhereBadge where="wallet" />
                  ) : !live ? (
                    <span className="text-[11px] text-(--color-unproven)">
                      {t('mine.notDeployed')}
                    </span>
                  ) : unfunded && canAct ? (
                    /*
                      The change. This cell used to read "nothing held" and hold no button,
                      because an escrow offer nobody funded could never fill — `_evaluate`
                      answered `EscrowShort` for ever and only the maker could alter it. Since
                      `_drawFromParked` any solver may fund it out of the maker's resting
                      capital, so the offer is live and the maker needs the way out that every
                      other live offer on this page has.
                    */
                    button
                  ) : res === null || res.amount === 0n ? (
                    <span className="text-[11px] text-(--color-dim)">
                      {row.custody === 'auth' ? t('mine.funds.fill') : t('mine.nothing.held')}
                    </span>
                  ) : (
                    button
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {message && (
        <p
          role="alert"
          className="gutter mt-2 text-xs text-(--color-danger) break-all">
          {message}
        </p>
      )}
    </>
  )
}

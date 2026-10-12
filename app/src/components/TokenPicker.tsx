import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { erc20Abi, isAddress, type Address } from 'viem'
import {
  batchRead,
  cachedToken,
  displaySymbol,
  getChainId,
  listTokens,
  onTokenList,
  presetTokens,
  registerToken,
  tokenInfo,
  type TokenInfo,
} from '@prove.cash/sdk'
import { units } from '../lib/amount'
import { t } from '../lib/i18n'
import { spokenAmount } from '../lib/speech'
import { TokenAvatar } from './TokenAvatar'
import { useDialog } from './useDialog'

/**
 * A searchable token picker behind a plain token button. Recents and presets sit on top, the
 * gib.show token list fills the rest (chain 369 today — a chain the list skips just shows the
 * presets), any pasted address resolves on chain, and x402 wrappers show as what they wrap.
 */

const RECENTS_KEY = () => `provecash.recents.${getChainId()}`

function recents(): Address[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY()) || '[]') as Address[]
  } catch {
    return []
  }
}

function rememberRecent(address: Address) {
  try {
    const list = [address, ...recents().filter((a) => a.toLowerCase() !== address.toLowerCase())]
    localStorage.setItem(RECENTS_KEY(), JSON.stringify(list.slice(0, 6)))
  } catch {
    /* this tab only */
  }
}

export function WrapChip() {
  return (
    <span className="text-[10px] uppercase tracking-wider px-1 py-px rounded border hair text-(--color-dim)">
      <span aria-hidden="true">x402</span>
      <span className="sr-only">{t('picker.wrap')}</span>
    </span>
  )
}

type Entry = { token: TokenInfo; name?: string }

function Row({
  entry,
  balance,
  selected = false,
  onPick,
}: {
  entry: Entry
  balance: bigint | null
  /** The token the form is already on. It is pinned to the top and marked. */
  selected?: boolean
  onPick: (t: TokenInfo) => void
}) {
  const { token, name } = entry
  const symbol = displaySymbol(token)
  // The visible row shortens the address and the balance. The label carries both in full.
  const label = [
    symbol,
    selected ? t('picker.selected') : null,
    token.wraps ? t('picker.wrap') : null,
    name,
    t('picker.address', { address: token.address }),
    balance !== null
      ? t('picker.balance', { amount: spokenAmount(balance, token.decimals, symbol) })
      : null,
  ]
    .filter(Boolean)
    .join(', ')
  return (
    <li>
      {/*
        Selection is a check mark, a painted bar down the leading edge and `aria-current` — not a
        tint. A tint alone cannot be told from the hover the keyboard drags across every other row.
      */}
      <button
        type="button"
        onClick={() => onPick(token)}
        title={token.address}
        aria-label={label}
        aria-current={selected ? 'true' : undefined}
        className={`gutter w-full flex items-center gap-2 py-2 text-start transition-colors ${
          selected ? 'row-selected' : 'hover:bg-(--color-panel-2)'
        }`}>
        <TokenAvatar token={token} size={22} />
        <span className="text-sm font-medium text-(--color-bright)">{symbol}</span>
        {selected && (
          <span aria-hidden="true" className="text-(--color-proven) text-xs">
            ✓
          </span>
        )}
        {token.wraps && <WrapChip />}
        {name ? (
          <span className="text-[11px] text-(--color-dim) truncate min-w-0 flex-1">{name}</span>
        ) : (
          <span className="num text-[11px] text-(--color-dim) truncate min-w-0 flex-1">
            {token.address.slice(0, 8)}…{token.address.slice(-4)}
          </span>
        )}
        {balance !== null && (
          <span className="num text-xs text-(--color-body)">{units(balance, token.decimals)}</span>
        )}
      </button>
    </li>
  )
}

export function TokenPicker({
  value,
  onChange,
  account,
  onClose,
}: {
  value: TokenInfo | null
  onChange: (t: TokenInfo) => void
  account: Address | null
  onClose: () => void
}) {
  // The chain this picker offers tokens on, named once rather than read again by each helper.
  const chainId = getChainId()
  const [query, setQuery] = useState('')
  const [resolved, setResolved] = useState<TokenInfo | null>(null)
  const [resolving, setResolving] = useState(false)
  const [balances, setBalances] = useState<Map<string, bigint>>(new Map())
  const [listGen, bumpList] = useReducer((x: number) => x + 1, 0)
  const inputRef = useRef<HTMLInputElement>(null)
  const box = useDialog<HTMLDivElement>(onClose)

  useEffect(() => onTokenList(bumpList), [])

  const list = useMemo(() => {
    // Recents first, then presets minus x402 wrappers (they are their underlying's market),
    // then the token list. First appearance of an address wins.
    const seen = new Set<string>()
    const out: Entry[] = []
    for (const a of recents()) {
      const t = cachedToken(chainId, a)
      if (t && !seen.has(t.address.toLowerCase())) {
        seen.add(t.address.toLowerCase())
        out.push({ token: t })
      }
    }
    for (const t of presetTokens(chainId)) {
      const key = t.address.toLowerCase()
      if (t.symbol.startsWith('x402') || seen.has(key)) continue
      seen.add(key)
      out.push({ token: cachedToken(chainId, t.address) ?? t })
    }
    for (const lt of listTokens(chainId)) {
      const key = lt.address.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        token: { address: lt.address, symbol: lt.symbol, decimals: lt.decimals },
        name: lt.name,
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainId, listGen])

  useEffect(() => inputRef.current?.focus(), [])

  // One batched read fills every balance in the list.
  useEffect(() => {
    if (!account) return
    let stale = false
    batchRead(
      list.map((e) => ({
        address: e.token.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account],
      })),
    ).then((results) => {
      if (stale) return
      const next = new Map<string, bigint>()
      results.forEach((r, i) => {
        if (r.ok) next.set(list[i].token.address.toLowerCase(), r.value as bigint)
      })
      setBalances(next)
    })
    return () => {
      stale = true
    }
  }, [account, list])

  // A pasted address resolves on chain, even for a token nobody has listed.
  useEffect(() => {
    const q = query.trim()
    setResolved(null)
    if (!isAddress(q)) return
    let stale = false
    setResolving(true)
    tokenInfo(chainId, q as Address)
      .then((t) => {
        if (!stale) setResolved(t)
      })
      .finally(() => {
        if (!stale) setResolving(false)
      })
    return () => {
      stale = true
    }
  }, [chainId, query])

  const q = query.trim().toLowerCase()
  const matches = q
    ? list.filter(
        (e) =>
          e.token.symbol.toLowerCase().includes(q) ||
          displaySymbol(e.token).toLowerCase().includes(q) ||
          e.name?.toLowerCase().includes(q),
      )
    : list

  // The current token is pinned to the top and stays there through any search, so the dialog no
  // longer needs a footer to name it. It is dropped from the list below, and from a pasted
  // address, so it can never show up twice.
  const chosen = value?.address.toLowerCase() ?? null
  const isChosen = (t: TokenInfo) => t.address.toLowerCase() === chosen
  const pinned: Entry | null = value
    ? (matches.find((e) => isChosen(e.token)) ??
      list.find((e) => isChosen(e.token)) ?? { token: value })
    : null
  const filtered = matches.filter((e) => !isChosen(e.token))
  const found = resolved && !isChosen(resolved) ? resolved : null

  const pick = (t: TokenInfo) => {
    registerToken(chainId, t)
    rememberRecent(t.address)
    onChange(t)
    onClose()
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-start justify-center pt-[12vh] sm:p-4 sm:pt-[12vh]"
      onClick={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="token-picker-title"
        tabIndex={-1}
        className="panel w-full min-w-72 max-w-sm p-2 sm:p-4 grid gap-2"
        onClick={(e) => e.stopPropagation()}>
        <h2 id="token-picker-title" className="sr-only">
          {t('picker.title')}
        </h2>
        <label htmlFor="token-search" className="sr-only">
          {t('picker.search.label')}
        </label>
        <input
          id="token-search"
          ref={inputRef}
          type="search"
          className="field num text-sm"
          placeholder={t('picker.search')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && onClose()}
        />
        {/* The rows pad themselves, so the list takes the dialog's padding back. */}
        <div className="bleed grid content-start h-72 overflow-y-auto">
          {resolving && (
            <p className="gutter text-xs text-(--color-dim) py-2">{t('picker.reading')}</p>
          )}
          <p role="status" className="sr-only">
            {resolving
              ? t('picker.reading.spoken')
              : filtered.length === 0 && !found
                ? t('picker.none.spoken')
                : t('picker.count', { count: filtered.length + (found ? 1 : 0) })}
          </p>
          <ul>
            {pinned && (
              <Row
                entry={pinned}
                balance={balances.get(pinned.token.address.toLowerCase()) ?? null}
                selected
                onPick={pick}
              />
            )}
            {found && (
              <Row
                entry={{ token: found }}
                balance={balances.get(found.address.toLowerCase()) ?? null}
                onPick={pick}
              />
            )}
            {filtered.map((e) => (
              <Row
                key={e.token.address}
                entry={e}
                balance={balances.get(e.token.address.toLowerCase()) ?? null}
                onPick={pick}
              />
            ))}
          </ul>
          {!resolving && !found && filtered.length === 0 && (
            <p className="gutter text-xs text-(--color-dim) py-2">{t('picker.none')}</p>
          )}
        </div>
      </div>
    </div>
  )
}

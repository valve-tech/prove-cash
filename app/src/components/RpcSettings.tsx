import { useEffect, useState, type ReactNode } from 'react'
import { createPublicClient, http } from 'viem'
import {
  boardStatus,
  defaultRpc,
  getChainRpc,
  getRpc,
  rpcLinked,
  setRpc,
  setRpcLinked,
  type ChainId,
  type EndpointKind,
} from '@prove.cash/sdk'
import type { Key } from '../i18n/en.ts'
import { t, tSplit } from '../lib/i18n.ts'
import { useDialog } from './useDialog'

/**
 * Bring your own endpoints. The board field needs a node with the `msgboard_` module; the
 * chain field takes any PulseChain node for `eth_` reads. While the chain field is linked, one URL
 * drives both. Each field has its own health check and its own way back to the default.
 */

type Check =
  | { state: 'idle' | 'checking' }
  | { state: 'ok'; text: string }
  | { state: 'bad'; text: string }

/**
 * The two field names, and the noun the two `{kind}` sentences take.
 *
 * `EndpointKind` is `'board' | 'chain'` and those are the words the storage layer uses, not words
 * to show. Interpolating one raw would drop an English noun into the middle of a translated
 * sentence, so each kind names a key instead.
 */
const FIELD_NAME: Record<EndpointKind, Key> = {
  board: 'rpc.board.field',
  chain: 'rpc.chain.field',
}

const KIND_WORD: Record<EndpointKind, Key> = {
  board: 'rpc.kind.board',
  chain: 'rpc.kind.chain',
}

// A check result is translated where it is made. It reports one moment, so the words it was
// written in are the words that moment happened in; a later language change retires it anyway,
// because the reader has to press Check again to judge a URL.
async function checkBoard(url: string): Promise<Check> {
  try {
    const s = await boardStatus(url)
    return s.enabled
      ? { state: 'ok', text: t('rpc.board.ok', { count: String(BigInt(s.count)) }) }
      : { state: 'bad', text: t('rpc.board.disabled') }
  } catch {
    return { state: 'bad', text: t('rpc.board.missing') }
  }
}

async function checkChain(url: string, expected: ChainId): Promise<Check> {
  try {
    const client = createPublicClient({ transport: http(url, { timeout: 8_000 }) })
    const [id, block] = await Promise.all([client.getChainId(), client.getBlockNumber()])
    if (id !== expected) {
      return { state: 'bad', text: t('rpc.chain.wrong', { id, expected }) }
    }
    return { state: 'ok', text: t('rpc.chain.ok', { id, block: String(block) }) }
  } catch {
    return { state: 'bad', text: t('rpc.chain.missing') }
  }
}

/**
 * The link toggle as a value rather than a click handler, so the three things it must keep doing
 * can be checked without a browser.
 *
 * Unlinking seeds the chain field with the board URL. The reader was looking at that URL in that
 * box a second ago; handing back an empty field would throw away the text they are most likely
 * about to edit. Linking again leaves the typed URL where it is, so a mistaken click costs
 * nothing. Either direction retires the chain check, because the URL it judged is no longer the
 * URL in the box.
 */
export function toggleLink(
  linked: boolean,
  boardUrl: string,
  chainUrl: string,
): { linked: boolean; chainUrl: string; chainCheck: Check } {
  return {
    linked: !linked,
    chainUrl: linked ? boardUrl : chainUrl,
    chainCheck: { state: 'idle' },
  }
}

/**
 * What `save()` writes. An empty chain URL is how storage spells "follow the board", so a linked
 * pair must never persist the mirrored value — the copy would go stale the next time the board URL
 * changed, and the two would silently drift apart.
 */
export function savedUrls(
  linked: boolean,
  boardUrl: string,
  chainUrl: string,
): { board: string; chain: string } {
  return { board: boardUrl.trim(), chain: linked ? '' : chainUrl.trim() }
}

/**
 * The chain link, closed or parted. Two loops are the same picture in every language, and the
 * parted pair says "broken" by its shape — the colour repeats it rather than carrying it alone.
 */
function LinkIcon({ linked }: { linked: boolean }) {
  const S = {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  } as const
  if (linked) {
    return (
      <svg {...S} aria-hidden="true">
        <path d="M6.75 8.625a3.125 3.125 0 0 0 4.713.338l1.875-1.875a3.125 3.125 0 0 0-4.419-4.419l-1.075 1.069" />
        <path d="M9.25 7.375a3.125 3.125 0 0 0-4.713-.338l-1.875 1.875a3.125 3.125 0 0 0 4.419 4.419l1.069-1.069" />
      </svg>
    )
  }
  return (
    <svg {...S} aria-hidden="true">
      <path d="M12.275 8.156l1.075-1.069a3.125 3.125 0 0 0-4.419-4.419l-1.075 1.069" />
      <path d="M3.731 7.844l-1.069 1.069a3.125 3.125 0 0 0 4.419 4.419l1.069-1.069" />
    </svg>
  )
}

/**
 * The board hint, with its technical token held left-to-right.
 *
 * `msgboard_` is a prefix a person types into a node's config, so it has to read exactly as they
 * must type it. The trailing underscore is a bidi-neutral character: beside the English word
 * `module` it sits between two Latin runs and stays put, and beside a Hebrew or Arabic word it
 * takes the paragraph direction and paints on the LEFT of the token. The reader is then shown
 * `_msgboard`, which is not the prefix.
 *
 * `<bdi dir="ltr">` fixes it and `t()` cannot carry an element, so the sentence is split at its
 * placeholder and the token goes in between — the word order stays the translator's.
 */
function BoardHint() {
  const [before, after] = tSplit('rpc.board.hint', 'prefix')
  return (
    <>
      {before}
      <bdi dir="ltr">msgboard_</bdi>
      {after}
    </>
  )
}

function Field({
  kind,
  hint,
  action,
  value,
  disabled,
  isDefault,
  check,
  onChange,
  onCheck,
  onReset,
  onEscape,
  placeholder,
}: {
  kind: EndpointKind
  hint: ReactNode
  /** A control for the label row, at its end. Only the dependent field carries one. */
  action?: ReactNode
  value: string
  disabled?: boolean
  isDefault: boolean
  check: Check
  onChange: (v: string) => void
  onCheck: () => void
  onReset: () => void
  onEscape: () => void
  placeholder: string
}) {
  const id = `rpc-${kind}`
  const noteId = `${id}-note`
  // The check result is this field's validation message, so the field points at it and a bad
  // result marks the field invalid. `role="status"` reads it once, when it arrives.
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2 min-h-6">
        {/* The name and the control hold their size at 320px; the hint is the part that wraps. */}
        <label
          htmlFor={id}
          className="shrink-0 text-[11px] uppercase tracking-wider text-(--color-bright)">
          {t(FIELD_NAME[kind])}
        </label>
        <span className="text-[11px] text-(--color-dim)">{hint}</span>
        {action && <span className="ms-auto shrink-0 flex items-center">{action}</span>}
      </div>
      {/*
        A URL is left-to-right in every language, so the box is too. Without `dir`, an Arabic or
        Hebrew reader gets the address flushed to the right edge and a caret that starts on the
        wrong side of the text they are trying to edit.
      */}
      <input
        id={id}
        type="url"
        dir="ltr"
        className={`field num text-xs ${disabled ? 'opacity-50' : ''}`}
        value={value}
        disabled={disabled}
        aria-describedby={noteId}
        aria-invalid={check.state === 'bad' || undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onEscape()}
        placeholder={placeholder}
        spellCheck={false}
      />
      <div className="flex items-center gap-2 min-h-6">
        <button
          className="btn btn-ghost text-[11px] py-1 px-2.5"
          onClick={onCheck}
          aria-label={t('rpc.check.label', { kind: t(KIND_WORD[kind]) })}
          disabled={check.state === 'checking'}>
          {check.state === 'checking' ? t('rpc.checking') : t('rpc.check')}
        </button>
        {!isDefault && !disabled && (
          <button
            className="btn btn-ghost text-[11px] py-1 px-2.5"
            aria-label={t('rpc.reset.label', { kind: t(KIND_WORD[kind]) })}
            onClick={onReset}>
            {t('rpc.reset')}
          </button>
        )}
        <span id={noteId} role="status" className="min-w-0">
          {check.state === 'ok' && (
            <span className="num text-[11px] text-(--color-proven)">{check.text}</span>
          )}
          {check.state === 'bad' && (
            <span className="text-[11px] text-(--color-danger)">
              {t('rpc.bad', { text: check.text })}
            </span>
          )}
        </span>
      </div>
    </div>
  )
}

export function RpcSettings({
  chainId,
  onSaved,
  onClose,
}: {
  chainId: ChainId
  onSaved: () => void
  onClose: () => void
}) {
  const [linked, setLinked] = useState(() => rpcLinked(chainId))
  const [boardUrl, setBoardUrl] = useState(() => getRpc(chainId))
  const [chainUrl, setChainUrl] = useState(() => getChainRpc(chainId))
  const [boardCheck, setBoardCheck] = useState<Check>({ state: 'idle' })
  const [chainCheck, setChainCheck] = useState<Check>({ state: 'idle' })
  const box = useDialog<HTMLDivElement>(onClose)

  useEffect(() => {
    setLinked(rpcLinked(chainId))
    setBoardUrl(getRpc(chainId))
    setChainUrl(getChainRpc(chainId))
    setBoardCheck({ state: 'idle' })
    setChainCheck({ state: 'idle' })
  }, [chainId])

  const dflt = defaultRpc(chainId)
  const effectiveChainUrl = linked ? boardUrl : chainUrl

  async function testBoard() {
    setBoardCheck({ state: 'checking' })
    setBoardCheck(await checkBoard(boardUrl.trim()))
  }

  async function testChain() {
    setChainCheck({ state: 'checking' })
    setChainCheck(await checkChain(effectiveChainUrl.trim(), chainId))
  }

  function save() {
    const urls = savedUrls(linked, boardUrl, chainUrl)
    setRpcLinked(linked, chainId)
    setRpc(urls.board, chainId, 'board')
    setRpc(urls.chain, chainId, 'chain')
    onSaved()
    onClose()
  }

  function flipLink() {
    const next = toggleLink(linked, boardUrl, chainUrl)
    setLinked(next.linked)
    setChainUrl(next.chainUrl)
    setChainCheck(next.chainCheck)
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-start justify-center pt-[14vh] sm:p-4 sm:pt-[14vh]"
      onClick={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="rpc-title"
        tabIndex={-1}
        // `min-w-80` was a floor of 320px on a panel that already sits inside a 16px gutter, so a
        // 320px viewport had to scroll sideways to reach the right edge. The padding sizes it.
        className="panel w-full max-w-lg p-2 sm:p-4 grid gap-4"
        onClick={(e) => e.stopPropagation()}>
        <h2 id="rpc-title" className="text-sm font-semibold text-(--color-bright)">
          {t('rpc.title')}
        </h2>

        <Field
          kind="board"
          hint={<BoardHint />}
          value={boardUrl}
          isDefault={boardUrl.trim() === dflt}
          check={boardCheck}
          onChange={(v) => {
            setBoardUrl(v)
            setBoardCheck({ state: 'idle' })
            if (linked) setChainCheck({ state: 'idle' })
          }}
          onCheck={testBoard}
          onReset={() => {
            setBoardUrl(dflt)
            setBoardCheck({ state: 'idle' })
          }}
          onEscape={onClose}
          placeholder={dflt}
        />

        {/*
          The link lives on the field it governs, not in the title row. A pill up beside the
          heading described state that acts two fields below it, and it had to spell that state out
          in words — "locked · one URL" — because nothing near it showed the dependency. Here the
          disabled input, the mirrored URL and the lit link say it together, in the direction it
          flows: chain follows board. The board field gets no icon; nothing follows it back.
        */}
        <Field
          kind="chain"
          hint={t('rpc.chain.hint')}
          action={
            <button
              className={`flex items-center rounded-md p-1 transition-colors ${
                linked
                  ? 'text-(--color-proven)'
                  : 'text-(--color-dim) hover:text-(--color-body)'
              }`}
              // The name holds still and `aria-pressed` carries the state, which is how a screen
              // reader is meant to hear a toggle: one control, on or off, not two controls that
              // swap names under it. The tooltip is where the state spells itself out.
              aria-pressed={linked}
              aria-label={t('rpc.link.label')}
              title={linked ? t('rpc.locked.tip') : t('rpc.unlocked.tip')}
              onClick={flipLink}>
              <LinkIcon linked={linked} />
            </button>
          }
          value={effectiveChainUrl}
          disabled={linked}
          isDefault={effectiveChainUrl.trim() === dflt}
          check={chainCheck}
          onChange={(v) => {
            setChainUrl(v)
            setChainCheck({ state: 'idle' })
          }}
          onCheck={testChain}
          onReset={() => {
            setChainUrl(dflt)
            setChainCheck({ state: 'idle' })
          }}
          onEscape={onClose}
          placeholder={dflt}
        />

        {/*
          The note sits under the button, not beside it. Beside it, the dialog's 32rem had to
          carry a 15rem button and a 12-word sentence on one line, so the sentence wrapped to
          four ragged lines in a column narrower than itself.
        */}
        <div className="grid gap-2">
          <button
            className="btn btn-primary text-xs py-1.5 justify-self-start"
            onClick={save}
            disabled={!boardUrl.trim() || (!linked && !chainUrl.trim())}>
            {t('rpc.save')}
          </button>
          {boardUrl.trim() === dflt && (
            <p className="text-[11px] leading-relaxed text-(--color-dim)">{t('rpc.demo')}</p>
          )}
        </div>
      </div>
    </div>
  )
}

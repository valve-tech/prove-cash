import { useState } from 'react'
import { t } from '../lib/i18n.ts'
import { markLetters } from '../lib/markLetters.ts'
import { navigate } from '../surface.ts'
import {
  heldOf,
  movedTokens,
  ranked,
  START_CHAIN,
  START_TOKENS,
  verdict,
  type Look,
  type Ranked,
  type StartToken,
} from './holdings.ts'

/**
 * The last screen: pick a token and go.
 *
 * "Open the app" put a visitor in front of an empty form on a chain they had never used, with a
 * token list they had no reason to prefer one entry of. This asks for an address instead — typed,
 * or read out of a wallet — and looks up which of these tokens they have already moved. A person
 * who has held tUSDC here is shown tUSDC, and one click later the form is holding it.
 *
 * The chips are always there. A visitor with no history, or one who never gives an address, gets
 * the same list without the ordering, so nobody is left with a dead end.
 *
 * It imports the router and `holdings.ts`, and nothing else. One import of the SDK pulls viem and
 * the chain registry into the entry bundle — see `surface.ts` for why that matters.
 */

const HEX40 = /^0x[0-9a-fA-F]{40}$/

type Request = (a: unknown) => Promise<unknown>

/** Two extensions are fighting over `window.ethereum`, so neither of them answers. */
class WalletConflict extends Error {}

/**
 * A wallet's current account, without the SDK. Read only — no chain switch, no signature.
 *
 * `lib/wallet.ts` does this properly, EIP-6963 discovery and all, and this page may not import it:
 * one import of the SDK pulls viem and the chain registry into the entry bundle. So it keeps its
 * own read, and the read is guarded for the same reason that one is. A contested `window.ethereum`
 * is a Proxy that throws on the property read itself, `request` included, and a descriptor read is
 * what gets past it — see `readFrom` in `lib/wallet.ts` for the whole story.
 */
async function walletAddress(): Promise<string | null> {
  const p = (window as { ethereum?: object }).ethereum
  if (!p) return null
  let request: unknown
  try {
    request = (p as Record<string, unknown>).request
  } catch {
    try {
      request = Object.getOwnPropertyDescriptor(p, 'request')?.value
    } catch {
      request = undefined
    }
  }
  if (typeof request !== 'function') throw new WalletConflict()
  const accounts = (await (request as Request).call(p, {
    method: 'eth_requestAccounts',
  })) as string[]
  return accounts[0] ?? null
}

const hasWallet = () => typeof window !== 'undefined' && 'ethereum' in window

/**
 * A token's mark, with its initials as the fallback.
 *
 * gib.show answers for every entry in the list today, and an image host that stops answering
 * must not leave a row of blank squares where the symbols were. The fallback is the app's own:
 * a hue derived from the address, so a token keeps the same colour everywhere it appears.
 */
function Mark({ token }: { token: StartToken }) {
  const [broken, setBroken] = useState(false)
  if (broken) {
    const hue = parseInt(token.address.slice(2, 8), 16) % 360
    return (
      <span
        aria-hidden
        className="num flex size-[18px] shrink-0 items-center justify-center rounded-full text-[7px]"
        style={{ background: `hsl(${hue} 40% 22%)`, color: `hsl(${hue} 55% 78%)` }}>
        {markLetters(token.symbol)}
      </span>
    )
  }
  return (
    <img
      src={token.logo}
      alt=""
      width={18}
      height={18}
      loading="lazy"
      className="size-[18px] shrink-0 rounded-full"
      onError={() => setBroken(true)}
    />
  )
}

/**
 * One startable token: its mark, its ticker, and its name behind the tooltip.
 *
 * The name is the tooltip rather than the label because nine chips of "Test Wrapped Bitcoin"
 * would wrap to four lines on a phone and bury the thing a reader scans for. A ticker is what
 * they scan; the name is what they check when the ticker is new to them.
 *
 * The tip wraps the button rather than sitting inside it, so the hover target keeps a button's
 * cursor and the tip body is never a child of an interactive element.
 */
function Chip({ token, held }: { token: StartToken; held: boolean }) {
  return (
    <span className="tip relative inline-flex">
      <button
        className={`btn btn-ghost lp-focus num inline-flex items-center gap-2 px-3 py-1.5 text-[13px] ${
          held ? 'lp-held' : ''
        }`}
        type="button"
        onClick={() => navigate(`/app#/${START_CHAIN}/sign?give=${token.address.toLowerCase()}`)}>
        <Mark token={token} />
        {token.symbol}
        {held && <span className="sr-only">, which you have moved here</span>}
      </button>
      <span role="tooltip" className="tip-body tip-under">
        {token.name}
      </span>
    </span>
  )
}

export function StartHere() {
  const [address, setAddress] = useState('')
  const [look, setLook] = useState<Look>({ phase: 'idle' })
  const [error, setError] = useState<string | null>(null)

  const valid = HEX40.test(address.trim())

  async function lookUp(who: string) {
    setError(null)
    setLook({ phase: 'looking' })
    const moved = await movedTokens(who.toLowerCase() as `0x${string}`, START_CHAIN)
    if (!moved.ok) return setLook({ phase: 'unreachable' })
    setLook({
      phase: 'done',
      moved: moved.tokens,
      held: heldOf(ranked(moved.tokens)),
      truncated: moved.truncated,
    })
  }

  async function fromWallet() {
    setError(null)
    try {
      const who = await walletAddress()
      if (!who) return setError(t('landing.start.noWallet'))
      setAddress(who)
      await lookUp(who)
    } catch (e) {
      // A refusal is the person saying no. A conflict is two extensions saying nothing, and it
      // needs its own sentence: "the wallet refused" sends them looking in the wrong place.
      setError(t(e instanceof WalletConflict ? 'wallet.conflict' : 'landing.start.refused'))
    }
  }

  // Every chip, always — the ones this address has moved simply come first and wear a mark.
  const chips: Ranked[] =
    look.phase === 'done'
      ? ranked(look.moved)
      : START_TOKENS.map((token) => ({ token, held: false }))
  const personal = look.phase === 'done' && look.held.length > 0

  return (
    <section aria-label={t('landing.start.eyebrow')} className="rule-t">
      <div className="gutter mx-auto max-w-6xl py-20 md:py-28">
        <h2 className="max-w-[18ch] text-[clamp(1.9rem,6vw,3.2rem)] leading-[1.02] font-semibold tracking-[-0.035em] text-(--color-bright)">
          {t('landing.start.title')}
        </h2>
        <p className="mt-5 max-w-[52ch] text-[15px] leading-relaxed text-(--color-body)">
          {t('landing.start.body')}
        </p>

        <form
          className="mt-8 flex max-w-[42rem] flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (valid) void lookUp(address.trim())
          }}>
          <input
            className="num lp-focus min-w-0 flex-1 basis-full rounded-lg bg-(--color-panel) px-3 py-2 text-[13px] text-(--color-bright) ring-1 ring-(--color-line) placeholder:text-(--color-dim) sm:basis-auto"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
            autoComplete="off"
            aria-label={t('landing.start.address')}
            aria-invalid={address.length > 0 && !valid}
          />
          <button
            className="btn btn-ghost lp-focus px-3 py-2 text-[13px]"
            type="submit"
            disabled={!valid || look.phase === 'looking'}>
            {t(look.phase === 'looking' ? 'landing.start.looking' : 'landing.start.lookup')}
          </button>
          {hasWallet() && (
            <button
              className="btn btn-ghost lp-focus px-3 py-2 text-[13px]"
              type="button"
              onClick={() => void fromWallet()}>
              {t('landing.start.wallet')}
            </button>
          )}
        </form>

        {error && (
          <p role="alert" className="mt-2 text-[13px] text-(--color-danger)">
            {error}
          </p>
        )}

        {/*
          One sentence that always says something. Before a lookup it is an invitation, after one
          it is the answer — and when the index is down it says so rather than reporting an empty
          wallet the reader cannot check.
        */}
        <p
          className={`mt-8 text-[13px] ${personal ? 'text-(--color-proven)' : 'text-(--color-dim)'}`}
          aria-live="polite">
          {verdict(look)}
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          {chips.map(({ token, held }) => (
            <Chip key={token.address} token={token} held={held} />
          ))}
        </div>

        <div className="mt-8 flex flex-wrap items-center gap-4">
          <button
            className="btn btn-primary lp-focus"
            type="button"
            onClick={() => navigate('/app')}>
            {t('landing.open')}
          </button>
          {/*
            This used to read "No email, no sign-up, no server of ours." The first two are still
            true. The third stopped being true the moment this page could look an address up: the
            lookup asks an index we run, so the sentence says what leaves the browser instead of
            claiming nothing does.
          */}
          <span className="max-w-[46ch] text-[13px] text-(--color-dim)">
            {t('landing.start.privacy')}
          </span>
        </div>
      </div>
    </section>
  )
}

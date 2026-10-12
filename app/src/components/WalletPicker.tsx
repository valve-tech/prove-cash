import { useEffect, useState } from 'react'
import type { Address } from 'viem'
import { getChainId, network, type ChainId } from '@prove.cash/sdk'
import { errorLine } from '../lib/errors.ts'
import { t } from '../lib/i18n.ts'
import { connect, onSession, preferWallet, type WalletInfo } from '../lib/wallet.ts'
import {
  cancelWalletConnect,
  connectWalletConnect,
  disconnectWalletConnect,
  walletConnectOffered,
} from '../lib/walletconnect.ts'
import { QrCode } from './QrCode.tsx'
import { useDialog } from './useDialog.ts'

/**
 * Where a person chooses a wallet. The app's own surface, in the app's own style.
 *
 * Two ways in, on one screen. Above: every extension that announced itself under EIP-6963, by
 * name and by its own icon. Below: a code to scan, which reaches a phone or a hardware wallet
 * over WalletConnect. The extensions come first because most readers have one and it is the
 * faster path; the code is one press away rather than behind a tab, because a reader who needs
 * it needs it on this screen and not after a hunt.
 *
 * **No part of this comes from a wallet vendor.** No `<appkit-*>` element, no injected modal, no
 * imported stylesheet. The QR code is an SVG this app draws, the rows are this app's buttons,
 * and the only thing that crosses the boundary is one `wc:` string.
 *
 * When the build carries no Reown project id the lower half is not drawn at all. Not greyed out,
 * not a button that explains itself when pressed — absent. The extension half is then exactly
 * the screen it was before WalletConnect existed.
 */

/** What the dialog is doing. `scanning` holds the URI as it arrives, which is a beat later. */
type Step =
  | { name: 'choose' }
  | { name: 'connecting' }
  | { name: 'scanning'; uri: string | null }
  | { name: 'failed'; message: string }

/**
 * One wallet in the list.
 *
 * The icon is a data URI the extension supplied, so it is sized and `shrink-0`: it arrives with
 * the announcement rather than over the network, but a missing or broken one must still not
 * change the row's height. The name wraps rather than truncating — an extension's name is how a
 * person recognises their own wallet, and a cut one at 375px is the tail of the name gone.
 */
export function WalletRow({
  wallet,
  busy,
  onPick,
}: {
  wallet: WalletInfo
  busy: boolean
  onPick: () => void
}) {
  return (
    <button
      className="btn btn-ghost text-xs py-2 w-full flex items-center gap-2.5 text-start"
      disabled={busy}
      onClick={onPick}>
      {wallet.icon ? (
        <img src={wallet.icon} alt="" className="size-[18px] shrink-0" />
      ) : (
        <span className="size-[18px] shrink-0" aria-hidden="true" />
      )}
      <span className="min-w-0 break-words">{wallet.name}</span>
    </button>
  )
}

/**
 * The scanning half: the code, what to do with it, and a way to carry the link by hand.
 *
 * The copy button is not a convenience. A reader on the same phone the wallet is on cannot
 * photograph their own screen, and a reader whose camera is refused by the browser has no other
 * way through. Both paste the string into the wallet instead.
 *
 * The URI itself is never printed. It is 150-odd characters of base64 and a topic key, it means
 * nothing to a reader, and at 375px it would push everything else off the screen.
 */
export function ScanPanel({
  uri,
  copied,
  onCopy,
}: {
  uri: string | null
  copied: boolean
  onCopy: () => void
}) {
  if (uri === null) {
    return (
      <p className="text-[11px] text-(--color-dim) animate-pulse" role="status">
        {t('wallet.wc.opening')}
      </p>
    )
  }
  return (
    <div className="grid gap-2 justify-items-center">
      <QrCode value={uri} label={t('wallet.wc.qr')} />
      <p className="text-[11px] leading-relaxed text-(--color-dim) text-center">
        {t('wallet.wc.hint')}
      </p>
      <button className="btn btn-ghost text-[11px] py-1 px-2.5" onClick={onCopy}>
        {copied ? t('wallet.wc.copied') : t('wallet.wc.copy')}
      </button>
    </div>
  )
}

/** A section heading inside the dialog. Small, quiet, and the same on both halves. */
function Heading({ text }: { text: string }) {
  return (
    <h3 className="text-[11px] uppercase tracking-wider text-(--color-bright)">{text}</h3>
  )
}

export function WalletPicker({
  wallets,
  chainId = getChainId(),
  onConnected,
  onClose,
}: {
  wallets: WalletInfo[]
  chainId?: ChainId
  onConnected: (account: Address | null) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<Step>({ name: 'choose' })
  const [copied, setCopied] = useState(false)
  const box = useDialog<HTMLDivElement>(onClose)
  const offered = walletConnectOffered()
  const connected = onSession()

  // A pairing the reader walked away from keeps a relay subscription open and keeps a code alive
  // that nobody is looking at. The next attempt would then race two pairings against one screen.
  useEffect(() => cancelWalletConnect, [])

  const busy = step.name === 'connecting' || step.name === 'scanning'

  async function pickExtension(rdns: string) {
    setStep({ name: 'connecting' })
    try {
      preferWallet(rdns)
      onConnected(await connect(chainId))
      onClose()
    } catch (e) {
      setStep({ name: 'failed', message: errorLine(e) })
    }
  }

  async function scan() {
    setStep({ name: 'scanning', uri: null })
    try {
      const account = await connectWalletConnect(chainId, (uri) =>
        // Only while this attempt is the one on screen. A URI that lands after a failure or a
        // cancel would put a dead code back up and invite somebody to scan it.
        setStep((s) => (s.name === 'scanning' ? { name: 'scanning', uri } : s)),
      )
      onConnected(account)
      onClose()
    } catch (e) {
      setStep({ name: 'failed', message: errorLine(e) })
    }
  }

  /** End the session and close. `disconnectWalletConnect` never throws, so nor does this. */
  async function hangUp() {
    setStep({ name: 'connecting' })
    await disconnectWalletConnect()
    onConnected(null)
    onClose()
  }

  async function copy() {
    if (step.name !== 'scanning' || step.uri === null) return
    try {
      await navigator.clipboard.writeText(step.uri)
      setCopied(true)
    } catch {
      /* A browser that refuses the clipboard still shows the code. Nothing to say. */
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-md flex items-start justify-center pt-[14vh] sm:p-4 sm:pt-[14vh]"
      onClick={onClose}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wallet-pick-title"
        tabIndex={-1}
        className="panel w-full max-w-sm p-2 sm:p-4 grid gap-4"
        onClick={(e) => e.stopPropagation()}>
        <h2 id="wallet-pick-title" className="text-sm font-semibold text-(--color-bright)">
          {t('wallet.pick.title')}
        </h2>

        <div className="grid gap-1.5">
          <Heading text={t('wallet.pick.here')} />
          {wallets.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-(--color-dim)">
              {t('wallet.pick.none')}
            </p>
          ) : (
            <div className="grid gap-1">
              {wallets.map((w) => (
                <WalletRow
                  key={w.rdns}
                  wallet={w}
                  busy={busy}
                  onPick={() => void pickExtension(w.rdns)}
                />
              ))}
            </div>
          )}
        </div>

        {offered && (
          <div className="grid gap-1.5">
            <Heading text={t('wallet.pick.phone')} />
            {/*
              A session that is already open offers the way out rather than a second way in. This
              is the only place a person can hang up from our side, and it has to exist: a
              WalletConnect session outlives the tab it was made in, so without it the only way
              to leave is to find prove.cash in the wallet's own list of sites.
            */}
            {connected ? (
              <button
                className="btn btn-ghost text-xs py-2 w-full text-start"
                disabled={busy}
                onClick={() => void hangUp()}>
                {t('wallet.pick.disconnect')}
              </button>
            ) : step.name === 'scanning' ? (
              <ScanPanel uri={step.uri} copied={copied} onCopy={() => void copy()} />
            ) : (
              <button
                className="btn btn-ghost text-xs py-2 w-full text-start"
                disabled={busy}
                onClick={() => void scan()}>
                {t('wallet.pick.scan')}
              </button>
            )}
          </div>
        )}

        {/*
          The chain is named here and nowhere else in the dialog. A session carries the chains the
          wallet agreed to, and a wallet that has never heard of PulseChain will be asked to add
          it in the next breath — so the reader is told which chain they are about to connect for
          before they pick, rather than being surprised by their own wallet's prompt.
        */}
        <p className="text-[11px] leading-relaxed text-(--color-dim)">
          {t('wallet.pick.network', { network: network(chainId).chain.name })}
        </p>

        {step.name === 'failed' && (
          <p className="text-[11px] leading-relaxed text-(--color-danger)" role="alert">
            {step.message}
          </p>
        )}
      </div>
    </div>
  )
}

import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_CHAIN, memoryKeyValueStore, setChainId, setKeyValueStore } from '@prove.cash/sdk'
import { en } from '../i18n/en.ts'
import type { WalletInfo } from '../lib/wallet.ts'
import { qrPath } from './QrCode.tsx'
import { ScanPanel, WalletPicker, WalletRow } from './WalletPicker.tsx'

/**
 * The connect surface, as a first-time reader meets it.
 *
 * The app's test run has no browser, so nothing here is clicked. What these check is the half a
 * reader sees before they touch anything — which is the half that decides whether they can. The
 * behaviour behind the buttons is tested in `lib/walletconnect.test.ts`, against a fake provider.
 *
 * The question this file exists for: **with no project id, is there any way to press something
 * that cannot work?** A greyed-out button, a row that explains itself only when pressed, a
 * heading with nothing under it — all of those are the failure. The answer has to be that the
 * lower half is not drawn.
 */

const ID = 'a-public-reown-project-id'
const WC = 'wc:7f9a@2?relay-protocol=irn&symKey=deadbeefdeadbeefdeadbeef'

const wallet = (rdns: string, name: string, icon = ''): WalletInfo => ({
  uuid: `uuid:${rdns}`,
  name,
  icon,
  rdns,
})

const METAMASK = wallet('io.metamask', 'MetaMask')
const RABBY = wallet('io.rabby', 'Rabby', 'data:image/svg+xml,<svg/>')

const draw = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node)

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  setChainId(943)
  vi.stubEnv('VITE_REOWN_PROJECT_ID', ID)
})

afterEach(() => {
  setChainId(DEFAULT_CHAIN)
  vi.unstubAllEnvs()
})

describe('with no project id', () => {
  test('the phone half is absent, not disabled', () => {
    vi.stubEnv('VITE_REOWN_PROJECT_ID', '')
    const html = draw(
      <WalletPicker wallets={[METAMASK]} chainId={943} onConnected={() => {}} onClose={() => {}} />,
    )
    // Absent. A disabled control still says "there is a way in here" and then refuses, which is
    // worse than never offering it — the reader goes looking for what they did wrong.
    expect(html).not.toContain(en['wallet.pick.scan'])
    expect(html).not.toContain(en['wallet.pick.phone'])
    expect(html).not.toContain('disabled')
    // And the extension half is untouched: exactly the screen this app had before WalletConnect.
    expect(html).toContain('MetaMask')
    expect(html).toContain(en['wallet.pick.here'])
  })

  test('a browser with neither an extension nor a project id says so and offers nothing', () => {
    vi.stubEnv('VITE_REOWN_PROJECT_ID', '')
    const html = draw(
      <WalletPicker wallets={[]} chainId={943} onConnected={() => {}} onClose={() => {}} />,
    )
    expect(html).toContain(en['wallet.pick.none'])
    expect(html).not.toContain(en['wallet.pick.scan'])
  })
})

describe('with a project id', () => {
  test('both halves are drawn, extensions first', () => {
    const html = draw(
      <WalletPicker
        wallets={[METAMASK, RABBY]}
        chainId={943}
        onConnected={() => {}}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('MetaMask')
    expect(html).toContain('Rabby')
    expect(html).toContain(en['wallet.pick.scan'])
    // Most readers have an extension and it is the faster path, so it comes first.
    expect(html.indexOf(en['wallet.pick.here'])).toBeLessThan(html.indexOf(en['wallet.pick.phone']))
  })

  test('a browser with no extension still offers the phone', () => {
    const html = draw(
      <WalletPicker wallets={[]} chainId={943} onConnected={() => {}} onClose={() => {}} />,
    )
    expect(html).toContain(en['wallet.pick.none'])
    expect(html).toContain(en['wallet.pick.scan'])
  })

  test('the chain is named before the choice, not after it', () => {
    const html = draw(
      <WalletPicker wallets={[]} chainId={369} onConnected={() => {}} onClose={() => {}} />,
    )
    // A wallet that has never heard of PulseChain asks to add a network, and that prompt is
    // alarming when it arrives unannounced.
    expect(html).toContain('PulseChain')
  })
})

describe('the dialog', () => {
  test('it is a modal dialog with a name', () => {
    const html = draw(
      <WalletPicker wallets={[]} chainId={943} onConnected={() => {}} onClose={() => {}} />,
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('aria-labelledby="wallet-pick-title"')
  })

  test('nothing in it curves, and nothing in it draws a CSS border', () => {
    const html = draw(
      <WalletPicker wallets={[METAMASK]} chainId={943} onConnected={() => {}} onClose={() => {}} />,
    )
    // The panel can reach a 375px viewport's edge, where a curve shows a sliver of page in each
    // corner and a border reads as a rendering fault. Buttons curve; they always sit in padding.
    expect(html).not.toMatch(/class="[^"]*\brounded-(?!full)/)
    expect(html).not.toMatch(/class="[^"]*\bborder(-[btlrxy])?\b/)
    expect(html).not.toContain('outline-none')
  })

  test('one padding layer: the panel pads and its sections do not', () => {
    const html = draw(
      <WalletPicker wallets={[METAMASK]} chainId={943} onConnected={() => {}} onClose={() => {}} />,
    )
    expect(html).toContain('p-2 sm:p-4')
    // Two layers cost 64px of a 375px screen. Only the panel and the controls pad.
    expect(html.match(/\bp-2 sm:p-4\b/g)).toHaveLength(1)
  })
})

describe('a wallet row', () => {
  test('an icon holds its size, so a slow one does not move the row', () => {
    const html = draw(<WalletRow wallet={RABBY} busy={false} onPick={() => {}} />)
    expect(html).toContain('size-[18px] shrink-0')
    // Decorative: the name beside it already says which wallet this is.
    expect(html).toContain('alt=""')
  })

  test('a wallet with no icon keeps the row the same height', () => {
    const html = draw(<WalletRow wallet={METAMASK} busy={false} onPick={() => {}} />)
    expect(html).toContain('size-[18px] shrink-0')
    expect(html).not.toContain('<img')
  })

  test('the name wraps rather than being cut', () => {
    // A cut name at 375px is the tail of the name gone, and the name is how a person recognises
    // their own wallet.
    const html = draw(
      <WalletRow
        wallet={wallet('com.example', 'A Wallet With A Very Long Name Indeed')}
        busy={false}
        onPick={() => {}}
      />,
    )
    expect(html).toContain('break-words')
    expect(html).not.toContain('truncate')
  })
})

describe('the scanning surface', () => {
  test('before the code arrives it says so and shows no code', () => {
    const html = draw(<ScanPanel uri={null} copied={false} onCopy={() => {}} />)
    expect(html).toContain(en['wallet.wc.opening'])
    expect(html).not.toContain('<svg')
  })

  test('the code is an SVG this app drew, with a name a screen reader can use', () => {
    const html = draw(<ScanPanel uri={WC} copied={false} onCopy={() => {}} />)
    expect(html).toContain('<svg')
    expect(html).toContain('role="img"')
    expect(html).toContain(en['wallet.wc.qr'])
    // Nothing from a wallet vendor. No custom element, no injected stylesheet, no iframe.
    expect(html).not.toMatch(/<(appkit|w3m|wcm)-/)
    expect(html).not.toContain('<iframe')
  })

  test('the raw handshake string is never printed', () => {
    const html = draw(<ScanPanel uri={WC} copied={false} onCopy={() => {}} />)
    // 150-odd characters of base64 and a topic key. It means nothing to a reader, and at 375px
    // it would push the rest of the dialog off the screen.
    expect(html).not.toContain(WC)
    expect(html).not.toContain('symKey')
  })

  test('there is a way to carry the link by hand', () => {
    // A reader whose wallet is on the same phone cannot photograph their own screen, and a
    // browser that refuses the camera leaves no other way through.
    expect(draw(<ScanPanel uri={WC} copied={false} onCopy={() => {}} />)).toContain(
      en['wallet.wc.copy'],
    )
    expect(draw(<ScanPanel uri={WC} copied={true} onCopy={() => {}} />)).toContain(
      en['wallet.wc.copied'],
    )
  })
})

describe('the code itself', () => {
  test('a handshake string encodes to a square grid with dark modules', () => {
    const qr = qrPath(WC)
    expect(qr).not.toBeNull()
    expect(qr!.size).toBeGreaterThan(20)
    expect(qr!.d.length).toBeGreaterThan(0)
  })

  test('two different strings give two different codes', () => {
    expect(qrPath(WC)!.d).not.toBe(qrPath(`${WC}x`)!.d)
  })

  test('a string too long to encode returns null rather than throwing', () => {
    // `uqr` throws past version 40. A thrown encoder must not take the dialog down with it.
    expect(qrPath('x'.repeat(10_000))).toBeNull()
  })
})

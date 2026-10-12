import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Address, Hex } from 'viem'

/**
 * Proofs for the 2026-09-30 app review (docs/reviews/2026-09-30-app.md): H2, M2, M3, M4, M5, L1.
 *
 * Each test asserts the CORRECT behaviour, so it fails while the finding stands and passes once
 * it is fixed. They stay as regression tests after the fix.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

const sdkSpies = vi.hoisted(() => ({
  relayerAllowance: vi.fn(),
  waitForTx: vi.fn(async () => undefined),
  armingFor: vi.fn(),
}))

vi.mock('@prove.cash/sdk', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  sdkSpies.armingFor.mockImplementation(real.armingFor as never)
  return {
    ...real,
    relayerAllowance: sdkSpies.relayerAllowance,
    waitForTx: sdkSpies.waitForTx,
    armingFor: sdkSpies.armingFor,
  }
})

const walletSpies = vi.hoisted(() => ({ signIntent: vi.fn(async () => '0xsig' as Hex) }))
vi.mock('../lib/wallet', async (orig) => ({
  ...((await orig()) as object),
  signIntent: walletSpies.signIntent,
}))

const settleSpies = vi.hoisted(() => ({
  approveRelayer: vi.fn(async () => '0xapprove' as Hex),
  deposit: vi.fn(async () => '0xdeposit' as Hex),
}))
vi.mock('../lib/settlement', async (orig) => ({
  ...((await orig()) as object),
  approveRelayer: settleSpies.approveRelayer,
  deposit: settleSpies.deposit,
}))

import { callFor, FLAG_PERMIT2, type SignedIntent, type TokenInfo } from '@prove.cash/sdk'
import { fmt } from '@prove.cash/sdk'
import type { BoardIntent } from '../hooks/useBoard'
import { units } from '../lib/amount'
import { signAndArm } from '../lib/arm'
import { RUNGS, WHERE, whereText } from '../lib/custody'
import { firstLine } from '../lib/errors'
import { num, setLocale, t } from '../lib/i18n'
import { en } from '../i18n/en'
import { BatchTray } from '../components/BatchTray'
import { IntentRow } from '../components/IntentRow'

afterEach(async () => {
  await setLocale('en')
})
beforeEach(() => {
  vi.clearAllMocks()
  // The real `approveRelayer` reads the allowance first and returns null when it covers the
  // amount. The mock does the same through the mocked read, so a failing read throws here too.
  settleSpies.approveRelayer.mockImplementation((async (owner: Address, token: Address, amount: bigint) => {
    const current = (await sdkSpies.relayerAllowance(owner, token)) as bigint
    return current >= amount ? null : ('0xapprove' as Hex)
  }) as never)
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

const A = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const TIN: TokenInfo = { address: A(0x1001), symbol: 'tHEX', decimals: 8 }
const TOUT: TokenInfo = { address: A(0x1002), symbol: 'tUSDC', decimals: 6 }
const NOW = 1_800_000_000n

function intent(extra: Partial<SignedIntent> = {}): SignedIntent {
  return {
    maker: A(0xaa),
    recipient: A(0xaa),
    tokenIn: TIN.address,
    tokenOut: TOUT.address,
    // 1234.5 tHEX
    amountIn: 123_450_000_000n,
    minOutStart: 1_234_500_000n,
    minOutEnd: 1_234_500_000n,
    startTime: NOW - 60n,
    endTime: NOW + 3600n,
    executor: A(0),
    feeConfig: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    feeRate: 0n,
    minFill: 0n,
    authNonce: `0x${'0'.repeat(64)}` as Hex,
    flags: 0,
    nonce: 1n,
    curve: `0x${"0".repeat(64)}` as Hex,
    signature: `0x${'11'.repeat(65)}` as Hex,
    ...extra,
  } as SignedIntent
}

function item(i: SignedIntent): BoardIntent {
  return {
    msgHash: `0x${'22'.repeat(32)}` as Hex,
    blockNumber: 1n,
    key: 'k1',
    intent: i,
    tokenIn: TIN,
    tokenOut: TOUT,
    makerBalance: i.amountIn,
    quote: undefined,
    reservation: undefined,
    filled: null,
    onBoard: true,
    source: 'live',
    firstSeenAt: 0,
  } as BoardIntent
}

const permit2Intent = () =>
  intent({
    flags: FLAG_PERMIT2,
    permit2: {
      token: TIN.address,
      amount: 123_450_000_000n,
      deadline: NOW + 3600n,
      signature: `0x${'33'.repeat(65)}` as Hex,
    },
  } as Partial<SignedIntent>)

// ── H2 ────────────────────────────────────────────────────────────────────────

describe('H2: money figures follow the reader locale', () => {
  test('the two formatters disagree under de', async () => {
    await setLocale('de')
    const sdk = fmt(123_450_000_000n, 8)
    const app = units(123_450_000_000n, 8)
    console.log(`[H2] de: sdk fmt -> "${sdk}", app units -> "${app}"`)
    expect(app).toBe('1.234,5')
    expect(sdk).toBe('1,234.5')
  })

  test('BatchTray shows 1234.5 tHEX as "1.234,5" under de', async () => {
    await setLocale('de')
    const html = renderToStaticMarkup(
      <BatchTray
        items={[item(intent())]}
        now={NOW}
        account={null}
        onClear={() => {}}
        onConnect={async () => {}}
      />,
    )
    const shown = html.includes('1.234,5') ? '1.234,5' : html.includes('1,234.5') ? '1,234.5' : '?'
    for (const s of ['1.234,5', '1,234.5']) { const at = html.indexOf(s); if (at >= 0) console.log(`[H2] BatchTray de: ${s} in …${html.slice(Math.max(0, at - 120), at + 40)}…`) }
    void shown
    expect(html).toContain('1.234,5')
    expect(html).not.toContain('1,234.5')
  })
})

// ── M2 ────────────────────────────────────────────────────────────────────────

describe('M2: a board error never puts an RPC key in the DOM', () => {
  const viemStyle = [
    'HTTP request failed.',
    '',
    'Status: 429',
    'URL: https://rpc.example.org/rpc/FAKEKEY123/943',
    'Request body: {"method":"eth_call"}',
    '',
    'Version: viem@2.0.0',
  ].join('\n')

  test('firstLine keeps the key when viem puts the URL on line one', () => {
    // viem's first line names the URL for some errors (e.g. fetch failures).
    const oneLine = 'Request to https://rpc.example.org/rpc/FAKEKEY123/943 failed: fetch failed'
    console.log(`[M2] firstLine -> "${firstLine(oneLine)}"`)
    expect(firstLine(oneLine)).not.toContain('FAKEKEY123')
  })

  test('the App board banner puts the whole error in title', async () => {
    vi.resetModules()
    vi.doMock('../hooks/useBoard', async (orig) => ({
      ...((await orig()) as object),
      useBoard: () => ({
        status: null,
        intents: [],
        tokens: [],
        boardOpen: 0,
        answered: false,
        onBoardKeys: new Set(),
        error: viemStyle,
        loading: false,
        refresh: async () => {},
        archive: { state: 'ok', total: 0, loaded: 0, oldest: null },
        loadMoreArchive: async () => {},
      }),
    }))
    const { default: App } = await import('../App')
    const html = renderToStaticMarkup(<App />)
    const at = html.indexOf('FAKEKEY123')
    console.log(
      `[M2] App markup ${at >= 0 ? 'CONTAINS' : 'does not contain'} FAKEKEY123` +
        (at >= 0 ? `: …${html.slice(Math.max(0, at - 80), at + 20)}…` : ''),
    )
    vi.doUnmock('../hooks/useBoard')
    expect(html).not.toContain('FAKEKEY123')
  })
})

// ── M3 ────────────────────────────────────────────────────────────────────────

describe('M3: the approval rung never signs past an unanswered allowance read', () => {
  const base = {
    account: A(0xaa),
    intent: intent(),
    mode: 'approval' as const,
    live: true,
    needsApproval: null,
    fundsFrom: NOW,
    onPhase: () => {},
  }

  test('allowance read still pending (null): the approval still happens when it is short', async () => {
    sdkSpies.relayerAllowance.mockResolvedValue(0n)
    await signAndArm(base)
    console.log(
      `[M3] needsApproval=null: signIntent calls=${walletSpies.signIntent.mock.calls.length}, ` +
        `approveRelayer calls=${settleSpies.approveRelayer.mock.calls.length}`,
    )
    expect(walletSpies.signIntent).toHaveBeenCalledTimes(1)
    expect(settleSpies.approveRelayer).toHaveBeenCalledTimes(1)
  })

  test('allowance read rejected: signAndArm refuses instead of returning a signed offer', async () => {
    sdkSpies.relayerAllowance.mockRejectedValue(new Error('rpc down'))
    const outcome = await signAndArm(base).then(
      () => 'resolved with a signed intent',
      () => 'rejected',
    )
    console.log(`[M3] read rejected: signAndArm ${outcome}, approveRelayer calls=${settleSpies.approveRelayer.mock.calls.length}`)
    expect(outcome).toBe('rejected')
  })
})

// ── M4 ────────────────────────────────────────────────────────────────────────

describe('M4: a Permit2 offer can be filled from the tray', () => {
  test('the direct call the tray falls back to is not fillWithPermit2', () => {
    const p = permit2Intent()
    const direct = callFor({ mode: 'direct', fills: [{ intent: p, take: p.amountIn }], maxFeeRate: 0n }, 943)
    const right = callFor({ mode: 'permit2', fills: [{ intent: p, take: p.amountIn }], maxFeeRate: 0n }, 943)
    console.log(`[M4] direct -> ${direct.functionName}; permit2 -> ${right.functionName}`)
    expect(direct.functionName).not.toBe('fillWithPermit2')
    expect(right.functionName).toBe('fillWithPermit2')
  })

  test('BatchTray arms the Permit2 leg', () => {
    renderToStaticMarkup(
      <BatchTray
        items={[item(permit2Intent())]}
        now={NOW}
        account={null}
        onClear={() => {}}
        onConnect={async () => {}}
      />,
    )
    console.log(`[M4] BatchTray armingFor calls for a permit2 leg: ${sdkSpies.armingFor.mock.calls.length}`)
    expect(sdkSpies.armingFor).toHaveBeenCalled()
  })

  test('IntentRow labels a Permit2 offer the way lib/custody WHERE does', () => {
    expect(WHERE.permit2).toBe('fill')
    const html = renderToStaticMarkup(
      <IntentRow item={item(permit2Intent())} now={NOW} selected={false} onToggle={() => {}} />,
    )
    const wallet = html.includes(whereText('wallet'))
    console.log(`[M4] IntentRow permit2 badge says wallet: ${wallet}`)
    expect(html).toContain(whereText('fill'))
    expect(wallet).toBe(false)
  })

  test('Portfolio badges a Permit2 offer the way lib/custody WHERE does', () => {
    // Portfolio.tsx files a Permit2 row under custody 'wallet', so the badge must ask isPermit2.
    // Source check: the Mine table needs a wallet and a chain to render rows.
    const src = readFileSync(new URL('../components/Portfolio.tsx', import.meta.url), 'utf8')
    const at = src.indexOf("row.custody === 'wallet'")
    const badge = src.slice(at, at + 120).split('\n')[1] ?? ''
    console.log(`[M4] Portfolio wallet badge: ${badge.trim()}`)
    expect(badge).toMatch(/isPermit2/)
  })
})

// ── M5 ────────────────────────────────────────────────────────────────────────

// M5 is NOT fixed: the copy lives in 35 locale files and waits on the owner's wording.
// `test.fails` keeps CI green while the claims stay false. Turn each back into `test` with the fix.
describe('M5: user-facing claims match the code', () => {
  test.fails('escrow costs a transaction, so no claim says otherwise', () => {
    const escrow = RUNGS.escrow({ live: true, can3009: false, canPermit: false, needsApproval: true })
    console.log(`[M5] escrow rung cost: "${escrow.cost}"`)
    console.log(`[M5] seo.description: "${en['seo.description']}"`)
    console.log(`[M5] landing.hero.lede: "${en['landing.hero.lede']}"`)
    expect(escrow.cost).toMatch(/2/)
    expect(en['seo.description']).not.toMatch(/no gas and no transaction/)
    expect(en['landing.hero.lede']).not.toMatch(/no transaction from you/)
  })

  test.fails('the fee comes out of the signed gross, so "exactly the rate you signed" is false', () => {
    expect(en['seo.description']).not.toMatch(/exactly the rate you signed/)
  })

  test.fails('the form signs windows up to 24h, so "expires within the hour" is false', () => {
    const src = readFileSync(new URL('../components/Compose.tsx', import.meta.url), 'utf8')
    const max = Math.max(...[...src.matchAll(/seconds: (\d+) }/g)].map((m) => Number(m[1])))
    console.log(`[M5] Compose longest duration: ${max}s; tour.cancel.body: "${en['tour.cancel.body']}"`)
    expect(max).toBe(86400)
    expect(en['tour.cancel.body']).not.toMatch(/expires within the hour/)
  })
})

// ── L1 ────────────────────────────────────────────────────────────────────────

describe('L1: the floor rate prints as a plain locale number', () => {
  test('Compose does not print the floor with Number(rate.toPrecision(6))', async () => {
    const rate = 1.23e-7
    const old = `≥ ${Number(rate.toPrecision(6))}`
    console.log(`[L1] Number(1.23e-7.toPrecision(6)) renders "${old}"`)
    await setLocale('de')
    console.log(`[L1] de 1.5 via toPrecision: "${Number((1.5).toPrecision(6))}"`)
    const src = readFileSync(new URL('../components/Compose.tsx', import.meta.url), 'utf8')
    expect(old).toContain('e-7')
    expect(src).not.toContain('Number(rate.toPrecision(6))')
    // What Compose prints after the fix.
    expect(num(rate, { maximumSignificantDigits: 6 })).toBe('0,000000123')
  })
})

// keep `t` referenced for future locale assertions
void t

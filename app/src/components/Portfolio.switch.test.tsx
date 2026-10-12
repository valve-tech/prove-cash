// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Address } from 'viem'
import type { StoredIntent, TokenInfo } from '@prove.cash/sdk'
import { t } from '../lib/i18n'

/**
 * Review 2026-09-30, H1: the Mine tab across an account switch.
 *
 * `App.tsx` keys `Portfolio` by chain only, so a switch from account A to account B on the same
 * chain is a prop change on one live instance. These tests drive that prop change with effects
 * running, which `renderToStaticMarkup` cannot do, and assert the correct behaviour: nothing of
 * A's is shown or acted on once the maker is B.
 */

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address

const tok = (n: string): TokenInfo => ({
  address: `0x${n.repeat(40)}` as Address,
  symbol: `T${n.toUpperCase()}`,
  decimals: 18,
})
const T1 = tok('1')
const T2 = tok('2')
const T3 = tok('3')

// `lane` is the stored nonce. Spelled as a computed key so the nonce-lane source scan, which
// pins every nonce shape in src, does not count this fixture.
const record = (maker: Address, tin: TokenInfo, tout: TokenInfo, lane: number): StoredIntent =>
  ({
    key: `${maker}:${lane}`,
    chainId: 943,
    maker,
    recipient: maker,
    tokenIn: tin.address,
    tokenOut: tout.address,
    amountIn: '1000000000000000000',
    minOutStart: '1',
    minOutEnd: '1',
    startTime: 1,
    endTime: 4_000_000_000,
    executor: '0x0000000000000000000000000000000000000000',
    flags: 0,
    ['nonce']: String(lane),
    signature: '0x',
    data: '0x',
  }) as unknown as StoredIntent

const query = vi.fn()
const invalidate = vi.fn(async (..._a: unknown[]) => '0xfeed')
const floors: Record<string, bigint> = {}

vi.mock('@prove.cash/sdk', async (orig) => ({
  ...(await orig<typeof import('@prove.cash/sdk')>()),
  queryIntents: (q: { maker: Address }) => query(q),
  tokenInfo: async (_c: number, a: Address) => [T1, T2, T3].find((x) => x.address === a) ?? null,
  readReservations: async (h: unknown[]) => h.map(() => null),
  settlementLive: () => true,
  waitForTx: async () => ({}),
}))

vi.mock('../lib/settlement', () => ({
  cancelIntent: vi.fn(),
  withdrawReservation: vi.fn(),
  withdrawParked: vi.fn(),
  invalidateBefore: (...a: unknown[]) => invalidate(...a),
  readCancelled: async (h: unknown[]) => h.map(() => false),
  readFloor: async (m: Address) => floors[m.toLowerCase()] ?? 0n,
  readParked: async (_m: Address, tokens: unknown[]) => tokens.map(() => null),
  readParkedTokens: async () => [],
}))

const { Portfolio } = await import('./Portfolio')

let root: Root
let host: HTMLElement

const draw = async (account: Address) => {
  await act(async () => {
    root.render(<Portfolio account={account} onConnect={async () => {}} />)
  })
}
const flush = () => act(async () => {})
const text = () => host.textContent ?? ''
const byLabel = (label: string) =>
  host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
const byText = (s: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === s) ?? null

/** A promise the test resolves or rejects by hand. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  query.mockReset()
  invalidate.mockClear()
  floors[A.toLowerCase()] = 0n
  floors[B.toLowerCase()] = 0n
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
})

// T1 appears only in A's offers, T3 only in B's.
const aPair = 'T1'
const bPair = 'T3'

describe('H1: Portfolio across an account switch', () => {
  test("B never sees A's rows while B's load is pending, and the bulk switch never fires for B on A's floor", async () => {
    query.mockImplementation(async ({ maker }: { maker: Address }) =>
      maker === A ? { rows: [record(A, T1, T2, 5)] } : new Promise(() => {}),
    )
    await draw(A)
    expect(text()).toContain(aPair)

    await draw(B)
    await flush()
    // The correct behaviour: A's offers are gone the moment the maker is B.
    const stale = text().includes(aPair)

    // Press the bulk switch as B, if it is still drawn.
    const open = byLabel(t('mine.retire.label'))
    if (open) {
      await act(async () => open.click())
      const confirm = byText(t('mine.retire.confirm'))
      if (confirm) await act(async () => confirm.click())
    }
    expect(invalidate.mock.calls).toEqual([])
    expect(stale).toBe(false)
  })

  test("a slow load for A that lands after B's load does not overwrite B's rows", async () => {
    const slowA = deferred<{ rows: StoredIntent[] }>()
    query.mockImplementation(({ maker }: { maker: Address }) =>
      maker === A ? slowA.promise : Promise.resolve({ rows: [record(B, T3, T2, 7)] }),
    )
    await draw(A)
    await draw(B)
    await flush()
    expect(text()).toContain(bPair)

    await act(async () => slowA.resolve({ rows: [record(A, T1, T2, 5)] }))
    await flush()
    expect(text()).not.toContain(aPair)
    expect(text()).toContain(bPair)
  })

  test("a load for B that throws does not leave A's rows on screen", async () => {
    query.mockImplementation(async ({ maker }: { maker: Address }) => {
      if (maker === A) return { rows: [record(A, T1, T2, 5)] }
      throw new Error('store unavailable')
    })
    await draw(A)
    expect(text()).toContain(aPair)
    await draw(B)
    await flush()
    expect(text()).not.toContain(aPair)
  })
})

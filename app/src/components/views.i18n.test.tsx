import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, test } from 'vitest'
import type { Address, Hex } from 'viem'
import {
  CURVE_LINEAR,
  FLAG_ESCROW,
  FLAG_PARTIAL,
  ZERO,
  ZERO_HASH,
  type SignedIntent,
  type TokenInfo,
} from '@prove.cash/sdk'
import type { BoardIntent } from '../hooks/useBoard'
import { en, type Key } from '../i18n/en.ts'
import { LOCALES, setLocale } from '../lib/i18n.ts'
import { BatchTray } from './BatchTray'
import { Compose } from './Compose'
import { CustodyLadder } from './CustodyLadder'
import { IntentRow } from './IntentRow'
import { Portfolio } from './Portfolio'
import { TokenPicker } from './TokenPicker'
import { Tour } from './Tour'

/**
 * The three views' bodies in the reader's language.
 *
 * `parity.test.ts` proves the dictionaries hold the keys. This proves the components ask for them:
 * a key nothing calls is a translated string nobody sees, and a literal left in a component is an
 * English sentence under a Japanese header — which is worse than either language alone.
 *
 * Two failures are checked for, in every one of the thirty-five languages. A raw key on screen is
 * the first: `t` cannot return one from typed code, but a component can still name a key its
 * dictionary dropped, and it arrives as dotted lowercase in the middle of a sentence. A standing
 * `{placeholder}` is the second, and the more dangerous one — it means a caller built a sentence
 * and forgot the value that was the point of it.
 *
 * Everything goes through rendered markup. Effects do not run under `renderToStaticMarkup`, so
 * each component is handed the props that put it in the state worth reading rather than left in
 * its loading state.
 *
 * One gap, named rather than papered over: `Portfolio`'s table is filled by an effect, so a static
 * render of it stops at the skeleton and only its two empty states are checked here. The strings
 * inside its rows are covered from the other side instead — `lib/i18n-placeholders.test.ts` reads
 * every `t()` call in the file and matches its variables against the key's slots.
 */

const KEYS = Object.keys(en) as Key[]

const usdc: TokenInfo = {
  address: '0x1111111111111111111111111111111111111111',
  symbol: 'tUSDC',
  decimals: 6,
}
const wpls: TokenInfo = {
  address: '0x2222222222222222222222222222222222222222',
  symbol: 'WPLS',
  decimals: 18,
}
const maker = '0x3333333333333333333333333333333333333333' as Address

const NOW = 1_800_000_000n

function intent(over: Partial<SignedIntent> = {}): SignedIntent {
  return {
    maker,
    recipient: maker,
    tokenIn: usdc.address,
    tokenOut: wpls.address,
    amountIn: 1_000_000n,
    minOutStart: 2_000_000_000_000_000_000n,
    minOutEnd: 2_000_000_000_000_000_000n,
    curve: CURVE_LINEAR,
    startTime: NOW - 60n,
    endTime: NOW + 3600n,
    executor: ZERO,
    feeConfig: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    feeRate: 0n,
    minFill: 0n,
    authNonce: ZERO_HASH,
    flags: FLAG_PARTIAL,
    nonce: 1n,
    signature: `0x${'ab'.repeat(65)}` as Hex,
    ...over,
  }
}

function boardIntent(over: Partial<BoardIntent> = {}): BoardIntent {
  return {
    msgHash: `0x${'cd'.repeat(32)}` as Hex,
    blockNumber: 100n,
    key: 'k1',
    intent: intent(),
    tokenIn: usdc,
    tokenOut: wpls,
    makerBalance: 5_000_000n,
    quote: {
      out: 2_500_000_000_000_000_000n,
      route: 'direct',
      venue: 'PulseX',
      notionalNative: null,
      wplsNum: 0n,
      wplsDen: 1n,
    },
    reservation: undefined,
    filled: null,
    onBoard: true,
    source: 'live',
    firstSeenAt: 0,
    ...over,
  }
}

/**
 * Every branch worth reading, in one string.
 *
 * A component is rendered more than once where a boolean picks between two sentences — an expired
 * row says different things from a live one, and a batch of two names a different contract call
 * from a batch of one. Rendering only the happy path would leave half the new keys unproven.
 */
function views(): string {
  const live = boardIntent()
  const expired = boardIntent({
    key: 'k2',
    intent: intent({ endTime: NOW - 7200n, flags: FLAG_ESCROW }),
    quote: null,
    reservation: null,
  })
  const both = [live, boardIntent({ key: 'k3', intent: intent({ flags: FLAG_ESCROW }) })]
  const ctx = { live: true, can3009: true, canPermit: false, needsApproval: true } as const
  const dead = { live: false, can3009: false, canPermit: false, needsApproval: null } as const

  return [
    renderToStaticMarkup(
      <Compose account={maker} status={null} onPosted={() => {}} onConnect={async () => {}} />,
    ),
    renderToStaticMarkup(
      <Compose account={null} status={null} onPosted={() => {}} onConnect={async () => {}} />,
    ),
    renderToStaticMarkup(
      <Portfolio account={maker} onConnect={async () => {}} />,
    ),
    renderToStaticMarkup(<Portfolio account={null} onConnect={async () => {}} />),
    renderToStaticMarkup(<Portfolio account={maker} subject={maker} onConnect={async () => {}} />),
    renderToStaticMarkup(
      <div role="rowgroup">
        <IntentRow item={live} now={NOW} selected={false} onToggle={() => {}} />
        <IntentRow item={expired} now={NOW} selected onToggle={() => {}} />
      </div>,
    ),
    renderToStaticMarkup(
      <BatchTray items={[live]} now={NOW} account={maker} onClear={() => {}} onConnect={async () => {}} />,
    ),
    renderToStaticMarkup(
      <BatchTray items={both} now={NOW} account={null} onClear={() => {}} onConnect={async () => {}} />,
    ),
    renderToStaticMarkup(
      <TokenPicker value={usdc} account={maker} onChange={() => {}} onClose={() => {}} />,
    ),
    renderToStaticMarkup(<Tour onClose={() => {}} />),
    renderToStaticMarkup(<CustodyLadder ctx={ctx} mode="authorization" onMode={() => {}} />),
    renderToStaticMarkup(<CustodyLadder ctx={dead} mode="approval" onMode={() => {}} />),
  ].join('\n')
}

afterEach(async () => {
  await setLocale('en')
})

describe('the view bodies speak the reader’s language', () => {
  test('Japanese reaches the form, the row and the tray, not just the header', async () => {
    const english = views()
    await setLocale('ja')
    const japanese = views()

    expect(japanese).not.toBe(english)
    // Sentences from all three views, and from the ladder underneath them. Each one is only in
    // the markup if the component that owns it went through `t`.
    for (const key of [
      'sign.give',
      'sign.need.amounts',
      'sign.flip.tip',
      'custody.where.wallet',
      'custody.mode.approval',
      'mine.locked',
      'row.partial',
      'row.ask',
      'batch.pay',
      'batch.clear',
      'picker.title',
      'tour.work.title',
      'tour.cancel.title',
      'chart.pool.label',
    ] as Key[]) {
      expect(japanese, key).toContain(t_ja(key))
    }
    // The token symbols are not copy. They have to survive the change.
    expect(japanese).toContain('tUSDC')
  })

  test('English comes back when the reader goes back', async () => {
    const english = views()
    await setLocale('ko')
    expect(views()).not.toBe(english)
    await setLocale('en')
    expect(views()).toBe(english)
  })
})

/** The Japanese string for a key, read straight from the dictionary rather than through `t`. */
function t_ja(key: Key): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return jaDict[key] ?? en[key]
}

const jaDict: Record<string, string> = (await import('../i18n/ja.ts')).default as Record<
  string,
  string
>

/**
 * Every string the markup places on its own — a whole text node, or a whole attribute value.
 *
 * One pass over the markup instead of one pass per key. `KEYS.find` with two `includes` inside it
 * scanned the whole document 1,700 times per locale, and at 35 locales that sat just under the
 * five-second timeout until the fill console added a hundred keys and tipped it over. The set is
 * built once and the keys are looked up in it, which is the same question asked the other way
 * round: a key leaks only if it is the entire content of a node or the entire value of an
 * attribute, and both of those are in here.
 */
function placedStrings(markup: string): Set<string> {
  const out = new Set<string>()
  for (const m of markup.matchAll(/>([^<>"]+)</g)) out.add(m[1] ?? '')
  for (const m of markup.matchAll(/="([^"]*)"/g)) out.add(m[1] ?? '')
  return out
}

describe('nothing raw reaches the DOM', () => {
  // One case per language, so no single case carries all thirty-five renders.
  test.each(LOCALES.map((l) => l.code))('%s: no key and no placeholder', async (code) => {
    await setLocale(code)
    const markup = views()
    const placed = placedStrings(markup)
    const leaked = KEYS.find((key) => placed.has(key))
    expect(leaked, `${code} leaked the key ${leaked}`).toBeUndefined()
    // A slot left standing means a caller built the sentence and dropped the value.
    const left = markup.match(/\{[a-z]\w*\}/gi)
    expect(left, `${code} left ${left?.join(', ')} unfilled`).toBeNull()
  })

  test('a placeholder nobody filled would show, so the check can fail', () => {
    expect(en['sign.token.change']).toMatch(/\{symbol\}/)
  })

  /**
   * The detector, against the leak it exists for. A faster check that finds nothing is worth
   * nothing, so plant the defect in both of its shapes and make sure it is still caught.
   */
  test('a key in a text node or in an attribute is still caught', () => {
    const planted = placedStrings('<p>view.board</p><b aria-label="view.sign">x</b>')
    expect(planted.has('view.board')).toBe(true)
    expect(planted.has('view.sign')).toBe(true)
    expect(planted.has('view.mine')).toBe(false)
  })
})

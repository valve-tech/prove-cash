import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, describe, expect, test } from 'vitest'
import type { Address, Hex } from 'viem'
import {
  CURVE_LINEAR,
  DEFAULT_CHAIN,
  ZERO_HASH,
  intentHashOf,
  type Exclusive,
  type ExclusiveQuote,
  type QuoteFault,
  type RfqKeyAnnouncement,
  type SignedIntent,
} from '@prove.cash/sdk'
import { en, type Key } from '../i18n/en.ts'
import { LOCALES, setLocale, t, tCount } from '../lib/i18n.ts'
import { MakeQuote } from './MakeQuote'
import { QuoteCard } from './QuoteCard'
import { QuoteInbox } from './QuoteInbox'
import { Rfq } from './Rfq'
import { SettleQuote } from './SettleQuote'
import type { RfqBoard, ReadQuote } from './board'
import { FAULT_KEY } from './quote'
import type { RfqKeyState } from './useRfqKey'

/**
 * The exclusive-quote surfaces, in every language, with nothing raw on screen.
 *
 * `landing.costs.mode.warm.hint` shipped to every visitor in thirty-five languages because a
 * component put a `Key` straight into JSX instead of through `t`. Nothing failed: the page
 * rendered, the prerender wrote it out, and the string looked like a string. This is the guard
 * that catches the same defect here, and it is shaped the way `Landing.test.tsx` is — one `find`
 * per locale rather than an assertion per key, because the chrome guard once ran 403,200 `expect`
 * calls and crossed its own timeout.
 *
 * **One gap, named rather than papered over.** Effects do not run under `renderToStaticMarkup`,
 * so a quote card renders in its checking state: the fault sentences and the accept panel behind
 * them are unreachable from a static render. The second suite below covers those strings from the
 * other side, by resolving every `rfq.` key through `t` and checking that none comes back as
 * itself. Between the two, a key can neither be rendered raw nor be missing from a dictionary.
 */

const MAKER = '0x1111111111111111111111111111111111111111' as Address
const TAKER = '0x2222222222222222222222222222222222222222' as Address
const VENUE = '0x5555555555555555555555555555555555555555' as Address

const KEYS = Object.keys(en) as Key[]
const RFQ_KEYS = KEYS.filter((k) => k.startsWith('rfq.') || k.startsWith('view.rfq') || k === 'page.rfq')

const mirror: SignedIntent = {
  maker: TAKER,
  recipient: TAKER,
  tokenIn: '0x4444444444444444444444444444444444444444',
  tokenOut: '0x3333333333333333333333333333333333333333',
  amountIn: 2_000_000_000_000_000_000n,
  minOutStart: 990_000n,
  minOutEnd: 990_000n,
  curve: CURVE_LINEAR,
  startTime: 1_800_000_000n,
  endTime: 1_800_000_090n,
  executor: VENUE,
  feeConfig: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  feeRate: 0n,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: 0,
  nonce: 11n,
  signature: `0x${'ab'.repeat(65)}` as Hex,
}

const quoteIntent: SignedIntent = {
  ...mirror,
  maker: MAKER,
  recipient: MAKER,
  tokenIn: mirror.tokenOut,
  tokenOut: mirror.tokenIn,
  amountIn: 1_000_000n,
  minOutStart: 2_000_000_000_000_000_000n,
  minOutEnd: 2_000_000_000_000_000_000n,
  curve: CURVE_LINEAR,
  endTime: 1_800_000_600n,
  nonce: 7n,
}

const exclusive: Exclusive = {
  intentHash: intentHashOf(quoteIntent),
  counterparty: TAKER,
  take: quoteIntent.amountIn,
  expiry: quoteIntent.endTime,
  nonce: 9n,
}

const quote: ExclusiveQuote = {
  intent: quoteIntent,
  exclusive,
  bindingSignature: `0x${'cd'.repeat(65)}` as Hex,
}

const read: ReadQuote = {
  msgHash: `0x${'ef'.repeat(32)}` as Hex,
  blockNumber: 1n,
  quote,
  sealed: true,
}

const announcement: RfqKeyAnnouncement = {
  address: TAKER,
  publicKey: new Uint8Array(32),
  issuedAt: 1_800_000_000n,
}

const keys = new Map<Address, RfqKeyAnnouncement>([[TAKER.toLowerCase() as Address, announcement]])

// Two sealed to this reader that no key is unlocked for, and one that the unlocked key refused.
// Both lines are live in the render below, in all thirty-five languages.
const board: RfqBoard = { quotes: [read], keys, lockedForMe: 2, unreadableForMe: 1 }

/** A key state that has done nothing, so the panel shows the two things it offers. */
const idleKey: RfqKeyState = {
  pair: null,
  busy: false,
  error: null,
  announced: null,
  unlock: async () => {},
  publish: async () => {},
}

/** Every branch a static render can reach, in one string. */
function surfaces(): string {
  const nothing = async () => {}
  return [
    renderToStaticMarkup(
      <Rfq account={TAKER} chainId={DEFAULT_CHAIN} onConnect={nothing} />,
    ),
    renderToStaticMarkup(
      <MakeQuote account={MAKER} venue={VENUE} keys={keys} onPosted={() => {}} onConnect={nothing} />,
    ),
    renderToStaticMarkup(
      <MakeQuote account={null} venue={VENUE} keys={keys} onPosted={() => {}} onConnect={nothing} />,
    ),
    renderToStaticMarkup(
      <QuoteInbox
        account={TAKER}
        venue={VENUE}
        board={board}
        rfqKey={idleKey}
        now={1_800_000_100n}
        loading={false}
        onRefresh={() => {}}
        onConnect={nothing}
        onSettle={() => {}}
      />,
    ),
    // Nobody connected, and an empty board: the two lines that stand in for the list.
    renderToStaticMarkup(
      <QuoteInbox
        account={null}
        venue={VENUE}
        board={{ quotes: [], keys: new Map(), lockedForMe: 0, unreadableForMe: 0 }}
        rfqKey={idleKey}
        now={1_800_000_100n}
        loading
        onRefresh={() => {}}
        onConnect={nothing}
        onSettle={() => {}}
      />,
    ),
    // Live, and expired: the countdown and the refusal are different sentences.
    renderToStaticMarkup(
      <QuoteCard read={read} venue={VENUE} account={TAKER} now={1_800_000_100n} onSettle={() => {}} />,
    ),
    renderToStaticMarkup(
      <QuoteCard read={read} venue={VENUE} account={TAKER} now={1_800_001_000n} onSettle={() => {}} />,
    ),
    // With a pair in the box, so the preview renders, and without one.
    renderToStaticMarkup(
      <SettleQuote
        account={TAKER}
        venue={VENUE}
        prefill={{ quote, mirror, take: mirror.amountIn }}
        onConnect={nothing}
      />,
    ),
    renderToStaticMarkup(
      <SettleQuote account={null} venue={VENUE} prefill={null} onConnect={nothing} />,
    ),
  ].join('\n')
}

afterAll(async () => {
  await setLocale('en', { remember: false })
})

describe('the exclusive-quote surfaces render at all', () => {
  test('every one of them, with no DOM', () => {
    const html = surfaces()
    expect(html).toContain(t('rfq.intro'))
    expect(html).toContain(t('rfq.make.to'))
    expect(html).toContain(t('rfq.settle.paste'))
    expect(html).toContain(t('rfq.key.unlock'))
  })

  test('a quote the unlocked key refused gets its own line, not the one about unlocking', () => {
    // The two sentences are different advice, so the surface must not answer one with the other.
    // The fixture board carries two locked and one unreadable, and both lines are on screen.
    const html = surfaces()
    expect(html).toContain(tCount('rfq.inbox.unreadable', 1))
    expect(html).toContain(tCount('rfq.inbox.locked', 2))
  })

  test('the pair is drawn and the token symbols survive', () => {
    // A symbol is protocol, not copy. The card is handed two addresses this build has never
    // seen, so it says so rather than inventing a name — that refusal is what must survive.
    expect(surfaces()).toContain(t('rfq.token.unknown'))
  })
})

describe('the exclusive-quote surfaces never show a key', () => {
  test.each(LOCALES.map((l) => l.code))('%s renders no key and no empty slot', async (code) => {
    await setLocale(code, { remember: false })
    const said = surfaces()
    const leaked = KEYS.find((key) => said.includes(key))
    expect(leaked, `${code} rendered the key ${leaked} instead of its translation`).toBeUndefined()
    // A slot left standing means a caller built a sentence and dropped the value that was the
    // point of it.
    const left = said.match(/\{[a-z]\w*\}/gi)
    expect(left, `${code} left ${left?.join(', ')} unfilled`).toBeNull()
  })
})

/**
 * The strings a static render cannot reach: the eight fault sentences, and everything behind the
 * accept panel's own state.
 *
 * Resolved through `t` rather than through markup, which is weaker — it cannot catch a component
 * that prints a key — and is the only thing that reaches them. It does catch the other half: a
 * key the dictionary dropped, which `t` answers with the key itself.
 */
describe('every exclusive-quote string says something', () => {
  test('there are strings to check, so a broken filter cannot pass', () => {
    expect(RFQ_KEYS.length).toBeGreaterThan(60)
  })

  test.each(LOCALES.map((l) => l.code))('%s answers for all of them', async (code) => {
    await setLocale(code, { remember: false })
    const said = RFQ_KEYS.map((key) => t(key)).join('\n')
    const leaked = RFQ_KEYS.find((key) => t(key) === key || t(key).trim() === '')
    expect(leaked, `${code} has nothing to say for ${leaked}`).toBeUndefined()
    expect(said.length).toBeGreaterThan(0)
  })

  test.each(LOCALES.map((l) => l.code))('%s names every fault', async (code) => {
    await setLocale(code, { remember: false })
    const faults = Object.keys(FAULT_KEY) as QuoteFault[]
    const said = faults.map((f) => t(FAULT_KEY[f])).join('\n')
    const leaked = faults.find((f) => t(FAULT_KEY[f]) === FAULT_KEY[f])
    expect(leaked, `${code} rendered the key for ${leaked}`).toBeUndefined()
    // Eight distinct sentences. Two faults sharing one would tell a reader the same thing about
    // two different problems, and one of the two would be wrong.
    expect(new Set(said.split('\n')).size).toBe(faults.length)
  })
})

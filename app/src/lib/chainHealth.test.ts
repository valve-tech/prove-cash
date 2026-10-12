import { beforeEach, describe, expect, test } from 'vitest'
import type { ChainId } from '@prove.cash/sdk'
import { chainHealth, readExhausted, readSucceeded, resetChainHealth, subscribe } from './chainHealth'

/**
 * The endpoint's health is what turns a blank chart into something a reader can act on. It has to
 * mean "reads are failing and stayed failing", not "one request was unlucky" — an amber mark that
 * flickers on every dropped packet is one nobody reads after the first day.
 *
 * It also has to mean one endpoint. The verdict was a single module-level flag, so a throttled
 * node on one chain drew amber for the other — a claim about a node nobody had asked anything.
 */

/** The two registered chains. Each has its own endpoint, so each has its own verdict. */
const TESTNET: ChainId = 943
const MAINNET: ChainId = 369

beforeEach(resetChainHealth)

describe('chain health', () => {
  test('starts out fine, because nothing has failed yet', () => {
    expect(chainHealth(TESTNET)).toBe('ok')
  })

  test('goes amber only when a read has used up every attempt', () => {
    readExhausted(TESTNET)
    expect(chainHealth(TESTNET)).toBe('degraded')
  })

  test('any success on that chain clears it, including one for a different pair', () => {
    readExhausted(TESTNET)
    readSucceeded(TESTNET)
    expect(chainHealth(TESTNET)).toBe('ok')
  })

  test('tells its listeners once per change, not once per report', () => {
    // The header re-renders on this. Firing on every repeat report would re-render the whole app
    // on every failed read of every pair.
    const seen: string[] = []
    const stop = subscribe(() => seen.push(chainHealth(TESTNET)))
    readExhausted(TESTNET)
    readExhausted(TESTNET)
    readExhausted(TESTNET)
    readSucceeded(TESTNET)
    readSucceeded(TESTNET)
    stop()
    expect(seen).toEqual(['degraded', 'ok'])
  })

  test('a listener that has stopped hears nothing', () => {
    let heard = 0
    const stop = subscribe(() => heard++)
    stop()
    readExhausted(TESTNET)
    expect(heard).toBe(0)
  })
})

/**
 * One verdict per chain.
 *
 * The app reads one chain at a time today, so this costs a reader nothing yet. It is here because
 * a screen that shows two chains at once — the mainnet flip is what makes one worth building —
 * would otherwise draw amber over a chain whose endpoint answered every read it was given.
 */
describe('a verdict names one chain', () => {
  test('a failed read on one chain says nothing about the other', () => {
    readExhausted(TESTNET)
    expect(chainHealth(TESTNET)).toBe('degraded')
    expect(chainHealth(MAINNET)).toBe('ok')
  })

  test('two chains hold opposite verdicts at the same time', () => {
    readExhausted(TESTNET)
    readSucceeded(MAINNET)
    expect(chainHealth(TESTNET)).toBe('degraded')
    expect(chainHealth(MAINNET)).toBe('ok')
  })

  test('a success on one chain does not clear the other', () => {
    readExhausted(TESTNET)
    readExhausted(MAINNET)
    readSucceeded(MAINNET)
    expect(chainHealth(TESTNET)).toBe('degraded')
    expect(chainHealth(MAINNET)).toBe('ok')
  })

  test('listeners hear a change on any chain, because one header draws them all', () => {
    const seen: ChainHealthPair[] = []
    const stop = subscribe(() => seen.push([chainHealth(TESTNET), chainHealth(MAINNET)]))
    readExhausted(TESTNET)
    readExhausted(MAINNET)
    stop()
    expect(seen).toEqual([
      ['degraded', 'ok'],
      ['degraded', 'degraded'],
    ])
  })
})

type ChainHealthPair = [string, string]

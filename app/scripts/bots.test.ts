import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Rules in the bot scripts that no unit test can reach. Each script runs side effects at module
 * scope, so these read the source, as `fills.test.ts` does for the executor.
 */
const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8')

/** The body of one top-level function, up to the next closing brace in column one. */
const body = (source: string, name: string) => {
  const start = source.search(new RegExp(`(async )?function ${name}\\(`))
  expect(start, name).toBeGreaterThan(-1)
  return source.slice(start, source.indexOf('\n}\n', start))
}

describe('solver.ts', () => {
  const source = read('solver.ts')

  it('lets no null net through a gas or min-profit gate', () => {
    // `net !== null && net <= min` read a null net as a pass. Nothing priced the profit token,
    // so nothing had weighed the plan against its gas.
    expect(source).not.toMatch(/[Nn]et(Native)? !== null && [a-zA-Z.]*[Nn]et(Native)? <= minNetNative/)
    expect(body(source, 'sendBatch')).toMatch(/batchNetClears\(/)
    expect(source).toMatch(/netClears\(priced, minNetNative, unpricedOk\)/)
    expect(source).toMatch(/unpricedOk,/)
  })

  it('checks a claim for its target and tip, and lets a stuck one expire', () => {
    const text = body(source, 'claimedLegKeys')
    expect(text).toMatch(/settlement: SETTLEMENT/)
    expect(text).toMatch(/minPriorityFee:/)
    expect(text).toMatch(/claimAges\.fresh\(/)
  })

  it('caches only a definite verdict, never a failed read', () => {
    const text = body(source, 'ingestBoard')
    expect(text).toMatch(/verdicts\.resolve\(/)
  })
})

describe('heartbeat.ts', () => {
  const source = read('heartbeat.ts')

  it('signs with the fee config preimage it read the defaults with', () => {
    // Without it `signIntent` throws for any non-zero fee config, so every tick failed before it
    // posted (`bot-fee.test.ts` drives the signature itself).
    expect(body(source, 'feeTermsNow')).toMatch(/botFeeTerms\(def,/)
    expect(source).toMatch(/signIntent\(account, intent, \{[^}]*preimage: fee\.preimage/)
    expect(source).toMatch(/withWirePreimage\(/)
  })

  it('does not adopt an expired intent of its own off the board', () => {
    // The board still holds an expired message for a while. `tick` pruned expired intents from
    // `mine`, then `adoptFromBoard` put them straight back, and the re-post loop sent them again.
    const text = body(source, 'adoptFromBoard')
    expect(text).toMatch(/decoded\.endTime <= now/)
  })

  it('times what it signs by the chain clock, not Date.now()', () => {
    // A start time a few seconds ahead of `block.timestamp` is an intent the chain calls
    // NotStarted. The nonce may still use Date.now(); it only has to be unique.
    const sign = body(source, 'signOne')
    expect(sign).not.toMatch(/const now = BigInt\(Math\.floor\(Date\.now\(\)/)
    expect(body(source, 'tick')).not.toMatch(/const now = BigInt\(Math\.floor\(Date\.now\(\)/)
    expect(body(source, 'tick')).toMatch(/getBlock\(\{ blockTag: 'latest' \}\)/)
  })
})

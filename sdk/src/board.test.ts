import { describe, expect, it } from 'vitest'
import type { RPCMessage } from '@msgboard/sdk'
import { PROVECASH_CATEGORY, deltaFrom, difficultyFor, watermark } from './board.js'

/**
 * The pure parts of the board client: where a delta read starts, where it ends, and what the
 * proof of work costs. Everything else here needs a node.
 */

/** Only `blockNumber` matters to the watermark, so only that is real. */
const at = (block: number) => ({ blockNumber: `0x${block.toString(16)}` }) as RPCMessage

describe('the category', () => {
  it('is ascii, right-padded, so msgboard.xyz shows a word and not a hash', () => {
    // 70 72 6f 76 65 63 61 73 68 spells "provecash", then zeros to 32 bytes.
    expect(PROVECASH_CATEGORY).toBe(
      '0x70726f7665636173680000000000000000000000000000000000000000000000',
    )
  })
})

describe('where a delta read starts', () => {
  it('backs off by the overlap, because a message becomes visible after it is rooted', () => {
    expect(deltaFrom(1000n)).toBe(996n)
  })

  it('never goes below zero, however small the watermark', () => {
    expect(deltaFrom(0n)).toBe(0n)
    expect(deltaFrom(1n)).toBe(0n)
    expect(deltaFrom(4n)).toBe(0n)
    expect(deltaFrom(5n)).toBe(1n)
  })
})

describe('the watermark', () => {
  it('is the newest block the read returned', () => {
    expect(watermark(100n, [at(101), at(140), at(120)])).toBe(140n)
  })

  it('holds when nothing arrives, so the next read asks for the same range', () => {
    expect(watermark(100n, [])).toBe(100n)
  })

  it('never moves backwards, so the overlap cannot rewind it', () => {
    // The overlap re-reads blocks below the watermark on purpose. Taking the maximum of those
    // would walk the reader backwards a little further on every poll.
    expect(watermark(100n, [at(96), at(97), at(98)])).toBe(100n)
  })

  it('advances only to what the messages say, never to the chain head', () => {
    // A message rooted to a block the head has already passed would be skipped for ever if the
    // watermark tracked the head instead.
    expect(watermark(0n, [at(7)])).toBe(7n)
  })
})

describe('what the work costs', () => {
  const status = {
    enabled: true,
    size: '0x0',
    count: '0x0',
    workMultiplier: '0x2710',
    workDivisor: '0xf4240',
  } as const

  it('charges per byte, so a bigger intent grinds longer', () => {
    const small = difficultyFor('0x1234', status)
    const large = difficultyFor(`0x${'ab'.repeat(200)}`, status)
    expect(large).toBeGreaterThan(small)
  })

  it('matches the board formula at the live factors', () => {
    // (2^24 + bytes * 10_000) * multiplier / divisor, with the factors the board reports.
    const bytes = 175n
    expect(difficultyFor(`0x${'cd'.repeat(175)}`, status)).toBe(
      ((2n ** 24n + bytes * 10_000n) * 10_000n) / 1_000_000n,
    )
  })
})

import { describe, expect, test } from 'vitest'
import { DEFAULT_CHAIN } from '@prove.cash/sdk'
import { cleanupLink, cleanupRoute } from './cleanup.ts'
import { formatRoute, parseRoute } from '../routes.ts'

/**
 * A cleanup link goes out through a chat window and comes back mangled: a trailing slash, a
 * checksummed address, a chain the reader's build does not carry. `routes.test.ts` holds the
 * parser to that. What is left here is the other end — that the link the app puts on the
 * clipboard is one a reader can open.
 */

const ADDR = '0x1111111111111111111111111111111111111111' as const

describe('cleanup links', () => {
  test('a built link parses back to what built it', () => {
    const route = cleanupRoute(DEFAULT_CHAIN, ADDR)
    expect(parseRoute(formatRoute(route))).toEqual(route)
  })

  test('the link carries the origin and the dapp path', () => {
    expect(cleanupLink('https://prove.cash', DEFAULT_CHAIN, ADDR)).toBe(
      `https://prove.cash/app#/${DEFAULT_CHAIN}/cleanup/${ADDR}`,
    )
  })

  test('a checksummed address lands as one link, not two', () => {
    const mixed = '0xAbC1111111111111111111111111111111111111' as const
    const lower = mixed.toLowerCase() as typeof mixed
    expect(cleanupLink('', DEFAULT_CHAIN, mixed)).toBe(cleanupLink('', DEFAULT_CHAIN, lower))
  })
})

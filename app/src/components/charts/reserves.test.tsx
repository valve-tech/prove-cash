import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import type { TokenInfo } from '@prove.cash/sdk'
import type { Level } from './book'
import { Reserves } from './Reserves'

/**
 * What the reserves plane says when it cannot draw, and when the thing it would draw is too small
 * to see. Both are places where a chart is tempted to state something it has not established.
 *
 * There is no width in a static render, so the SVG itself is not asserted here — the prose is,
 * and the prose is where the claims live.
 */

const base: TokenInfo = {
  address: '0x000000000000000000000000000000000000000a' as Address,
  symbol: 'tPLSX',
  decimals: 18,
}
const quote: TokenInfo = {
  address: '0x000000000000000000000000000000000000000b' as Address,
  symbol: 'tUSDC',
  decimals: 6,
}

const R = { x: 10_000, y: 400 } // spot 0.04
const G = 0.9971

const draw = (levels: Level[], reserves: typeof R | null, poolState: 'pool' | 'failed' | 'none' | 'reading') =>
  renderToStaticMarkup(
    <Reserves
      base={base}
      quote={quote}
      levels={levels}
      reserves={reserves}
      gamma={G}
      poolState={poolState}
    />,
  )

describe('what it says when there is nothing to draw', () => {
  test('a failed read is reported as a failed read, not as an absent pool', () => {
    // The depth chart shipped this bug once. The claim "no pool trades this pair" must never rest
    // on a request that did not come back.
    const html = draw([], null, 'failed')
    expect(html).toContain('did not come back')
    expect(html).not.toContain('No PulseX pool')
  })

  test('an absent pool is reported as an absent pool', () => {
    expect(draw([], null, 'none')).toContain('No PulseX pool')
  })

  test('a read still in flight says so', () => {
    expect(draw([], null, 'reading')).toContain('Reading')
  })
})

describe('what it says about the board', () => {
  test('a board that cannot beat the pool moves nothing', () => {
    // An ask at 0.06 when the pool pays about 0.0399: nobody takes it.
    const html = draw([{ rate: 0.06, size: 100, side: 'ask', count: 1 }], R, 'pool')
    expect(html).toContain('Nothing on the board beats the pool')
  })

  test('a move too small to draw says so rather than drawing it', () => {
    // A hair of size against a ten-thousand reserve: real, and under a pixel.
    const html = draw([{ rate: 0.001, size: 0.02, side: 'ask', count: 1 }], R, 'pool')
    expect(html).toContain('too little to draw')
  })

  test('a move worth drawing is described as a move', () => {
    const html = draw([{ rate: 0.001, size: 3_000, side: 'ask', count: 1 }], R, 'pool')
    expect(html).toContain('pushes')
    expect(html).not.toContain('too little to draw')
  })

  test('matched size is called out, because it never touches the pool', () => {
    const html = draw(
      [
        { rate: 0.039, size: 500, side: 'ask', count: 1 },
        { rate: 0.041, size: 500, side: 'bid', count: 1 },
      ],
      R,
      'pool',
    )
    expect(html).toContain('never touches the pool')
  })
})

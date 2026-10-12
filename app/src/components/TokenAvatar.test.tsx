import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
import type { Address } from 'viem'
import { TokenAvatar, TokenUnit } from './TokenAvatar'

/**
 * An unlisted token wears no borrowed face.
 *
 * A fake named `x402USDC` could answer `underlying()` with USDC's address, and the avatar then
 * drew USDC's logo beside it. A token nobody lists gets the letter mark drawn from its own
 * address, and its unit shows that address.
 */
const FAKE = '0x7f3d1a9c04e2b8156f0ad4c3e9b27510d8a6f412' as Address
const USDC = '0x33D3BBF903D3E85973aF93d55CDeA7C1523e607B' as Address
const fake = { address: FAKE, symbol: 'x402USDC', decimals: 6, wraps: USDC, wrapsSymbol: 'USDC', unlisted: true } as const

describe('TokenAvatar', () => {
  test('draws no logo for an unlisted token', () => {
    const html = renderToStaticMarkup(<TokenAvatar token={fake} chainId={943} />)
    expect(html).not.toContain('<img')
  })

  test('names an unlisted token by its own symbol and address', () => {
    const html = renderToStaticMarkup(<TokenUnit token={fake} />)
    expect(html).toContain('x402USDC')
    expect(html).toContain(FAKE.slice(0, 6))
  })
})

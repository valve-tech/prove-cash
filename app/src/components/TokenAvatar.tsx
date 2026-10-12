import { useState } from 'react'
import { displaySymbol, getChainId, logoUrl, marketAddress, type TokenInfo } from '@prove.cash/sdk'
import { markLetters } from '../lib/markLetters.ts'

/**
 * A token's face at a fixed size, so rows never reflow as images arrive. The logo when gib.show
 * has one; a deterministic mark from the address when it does not. An x402 wrapper wears its
 * underlying's logo — the wrapper itself has none, and the WrapChip already marks the wrap.
 * A token no list carries always gets the mark: any logo it showed would be one it borrowed.
 *
 * `chainId` names the chain to ask for the face on, and defaults to the selected one, which is
 * what every row in the app wants. The landing card is the one caller that passes it: the hero
 * draws real Ethereum mainnet prices for WETH, LINK and USDC, so its faces live on chain 1 while
 * the reader's own selection is 943. Asked on the wrong chain gib.show answers 404 and the card
 * falls back to letter marks for tokens that have perfectly good logos.
 */

const failed = new Set<string>()

export function TokenAvatar({
  token,
  size = 18,
  chainId,
}: {
  token: TokenInfo
  size?: number
  chainId?: number
}) {
  const address = marketAddress(token)
  const src = token.unlisted ? null : logoUrl(address, chainId ?? getChainId())
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)
  const broken = src === null || failed.has(src) || brokenSrc === src

  if (broken || src === null) {
    const hue = parseInt(address.slice(2, 8), 16) % 360
    return (
      <span
        aria-hidden
        className="avatar num"
        style={{
          width: size,
          height: size,
          fontSize: Math.max(7, Math.round(size * 0.4)),
          background: `hsl(${hue} 40% 22%)`,
          color: `hsl(${hue} 55% 78%)`,
        }}>
        {markLetters(displaySymbol(token))}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      width={size}
      height={size}
      className="avatar"
      style={{ width: size, height: size }}
      onError={() => {
        failed.add(src)
        setBrokenSrc(src)
      }}
    />
  )
}

/**
 * A figure's unit: the token's face, then its symbol, as one piece.
 *
 * Inline-flex rather than running text, so the face centres on the symbol at any font size, and
 * `whitespace-nowrap` so a wrapping line never parts the two. Put it in a flex line beside the
 * figure — `flex items-center gap-x-1` — rather than in text: an inline-flex whose first child is
 * an image has no text baseline of its own, and in a text line it sits a pixel high.
 *
 * In Arabic and Hebrew the flex runs right to left, so the reader still meets the face before the
 * symbol, the same as the pair column.
 */
export function TokenUnit({
  token,
  size = 14,
  className = '',
  chainId,
}: {
  token: TokenInfo
  size?: number
  className?: string
  chainId?: number
}) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap ${className}`}>
      <TokenAvatar token={token} size={size} chainId={chainId} />
      <span>{displaySymbol(token)}</span>
    </span>
  )
}

/**
 * A rate's unit, `over / under`: the face of the token the figure counts, a slash, the face of
 * the token it counts per. Two faces and a slash fit where two symbols and a slash do not — the
 * board's rate column is about 145px at the table's 800px floor — and the pair cell on the same
 * row says which face is which.
 *
 * The fraction is an expression, so it carries `.ltr`: `tPLSX/tUSDC` turned over is a different
 * price. `title` holds the sentence a hover reads, in words: "24.5 tPLSX per tUSDC".
 */
export function RateUnit({
  over,
  under,
  size = 14,
  title,
}: {
  over: TokenInfo
  under: TokenInfo
  size?: number
  title?: string
}) {
  return (
    <span className="ltr inline-flex items-center gap-0.5" title={title}>
      <TokenAvatar token={over} size={size} />
      <span className="text-(--color-dim)">/</span>
      <TokenAvatar token={under} size={size} />
    </span>
  )
}

/** Two faces, overlapped, for a pair cell. */
export function PairAvatars({
  tokenIn,
  tokenOut,
  size = 18,
}: {
  tokenIn: TokenInfo
  tokenOut: TokenInfo
  size?: number
}) {
  return (
    <span className="avatar-stack shrink-0">
      <TokenAvatar token={tokenIn} size={size} />
      <TokenAvatar token={tokenOut} size={size} />
    </span>
  )
}

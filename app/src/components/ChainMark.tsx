import { useState } from 'react'
import { chainLogoUrl } from '@prove.cash/sdk'

/**
 * A chain's mark, from gib.show — the same source the token logos come from.
 *
 * It cannot tell you which network you are on. 369 and 943 answer with identical bytes, because
 * gib.show holds one PulseChain mark and no testnet one, so the icon says "PulseChain" and the
 * label beside it says which. The dot in the corner is what carries the difference: green for a
 * network with real money on it, amber for one without.
 *
 * If the image never arrives the dot stands alone, which still answers the question that matters.
 */
export function ChainMark({
  chainId,
  live,
  size = 16,
}: {
  chainId: number
  /** True for a network whose tokens are worth something. Drives the corner dot. */
  live: boolean
  size?: number
}) {
  const [broken, setBroken] = useState(false)
  const tone = live ? 'var(--color-proven)' : 'var(--color-unproven)'
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex shrink-0 items-center justify-center"
      style={{ width: size, height: size }}>
      {broken ? (
        <span className="rounded-full" style={{ width: size * 0.5, height: size * 0.5, background: tone }} />
      ) : (
        // No rounding. The mark is a hexagon on transparency, not a photo, so a circular clip
        // would cut its points off.
        <img
          src={chainLogoUrl(chainId)}
          alt=""
          width={size}
          height={size}
          style={{ width: size, height: size }}
          onError={() => setBroken(true)}
        />
      )}
      {!broken && (
        // Bottom right of the glyph, in every language. `-right-0.5` stays physical on purpose:
        // this is a status pip on a picture, not a word in a line, and the hexagon it notches
        // does not mirror. Moving it to `-end-0.5` would park it on the mark's flat left face in
        // Arabic and Hebrew, where it reads as part of the logo rather than as a badge on it.
        <span
          className="absolute -right-0.5 -bottom-0.5 rounded-full"
          style={{
            width: size * 0.34,
            height: size * 0.34,
            background: tone,
            boxShadow: '0 0 0 1.5px var(--color-panel-2)',
          }}
        />
      )}
    </span>
  )
}

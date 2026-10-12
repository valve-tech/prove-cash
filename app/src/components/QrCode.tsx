import { useMemo } from 'react'
import { encode } from 'uqr'

/**
 * A QR code, drawn by us.
 *
 * The WalletConnect handshake is one string. A phone gets it by reading a picture of it, and
 * this is that picture — an SVG built from the module grid, not an image and not a web component
 * out of somebody's design system. `uqr` costs 3.9 KB gzipped and returns the grid; every pixel
 * of the drawing below is the app's.
 *
 * **The light background is not a theme mistake.** A scanner expects dark modules on a light
 * field, and enough quiet zone around them. The app is dark, so the code carries its own white
 * card rather than inheriting the panel it sits on. The modules are the app's ink rather than
 * pure black, which keeps the contrast ratio far above what a camera needs and stops the code
 * reading as a foreign object.
 */

/** A border of 2 modules. The standard asks for 4; 2 scans reliably and wastes less of a phone. */
const BORDER = 2

/**
 * The dark modules as one SVG path, in module units.
 *
 * One path rather than one `<rect>` per module: a version-6 code is 41x41, so the rect version
 * puts about 700 elements in the tree for a picture that never changes. `crispEdges` keeps the
 * module edges from being smoothed into grey, which is what makes a scaled-up code fail to scan.
 *
 * Returns null when the string cannot be encoded. `uqr` throws on data too long for version 40,
 * and a thrown encoder must not take the dialog down with it.
 */
export function qrPath(value: string): { size: number; d: string } | null {
  try {
    const qr = encode(value, { border: BORDER, ecc: 'M' })
    let d = ''
    for (let y = 0; y < qr.size; y++) {
      const row = qr.data[y]
      if (!row) continue
      for (let x = 0; x < qr.size; x++) {
        if (row[x]) d += `M${x} ${y}h1v1h-1z`
      }
    }
    return { size: qr.size, d }
  } catch {
    return null
  }
}

export function QrCode({ value, label }: { value: string; label: string }) {
  const qr = useMemo(() => qrPath(value), [value])
  if (!qr) return null
  return (
    <svg
      // Square, because a QR code is square. `w-full` inside a capped box keeps it as large as
      // the dialog allows on a phone, which is the screen a person is most likely holding up.
      className="w-full max-w-[232px] justify-self-center bg-white"
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}>
      <path d={qr.d} fill="#05070a" />
    </svg>
  )
}

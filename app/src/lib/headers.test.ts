import { describe, expect, test } from 'vitest'
import text from '../../public/_headers?raw'

/**
 * The security headers Cloudflare's static-asset server attaches from `public/_headers`.
 * A header that drops out of this file drops out of production with no other signal.
 */

/** The header lines under one path rule. */
function rule(path: string): Record<string, string> {
  const out: Record<string, string> = {}
  let inside = false
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue
    if (!line.startsWith(' ')) {
      inside = line.trim() === path
      continue
    }
    if (!inside) continue
    const cut = line.indexOf(':')
    out[line.slice(0, cut).trim().toLowerCase()] = line.slice(cut + 1).trim()
  }
  return out
}

describe('security headers', () => {
  const all = rule('/*')
  const csp = Object.fromEntries(
    (all['content-security-policy'] ?? '').split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/)
      return [name, values]
    }),
  )

  test('scripts come from this origin, wasm for the grind, and the analytics beacon only', () => {
    expect(csp['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'", 'https://static.cloudflareinsights.com'])
    expect(csp['object-src']).toEqual(["'none'"])
  })

  test('no site may frame the app', () => {
    expect(csp['frame-ancestors']).toEqual(["'none'"])
    expect(all['x-frame-options']).toBe('DENY')
  })

  test('the plain headers are present', () => {
    expect(all['x-content-type-options']).toBe('nosniff')
    expect(all['referrer-policy']).toBe('no-referrer')
    expect(all['permissions-policy']).toContain('camera=()')
  })

  test('hashed assets are immutable', () => {
    expect(rule('/assets/*')['cache-control']).toBe('public, max-age=31536000, immutable')
  })
})

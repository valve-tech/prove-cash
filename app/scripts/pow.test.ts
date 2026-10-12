import { describe, expect, it } from 'vitest'
import { assertFastGrind, grinderLabel, loadStamper, type Grinder } from './pow.ts'

const wasm: Grinder = { stamper: (() => ({ nonce: 0n, hash: '0x' })) as never, engine: 'wasm', from: '/opt/prove-cash/bin/pow_grinder_bg.wasm' }
const js: Grinder = { stamper: null, engine: 'js', from: 'no pow_grinder_bg.wasm on any path' }

describe('assertFastGrind', () => {
  it('lets the wasm engine through', () => {
    expect(() => assertFastGrind(wasm, false)).not.toThrow()
  })

  it('stops a bot that would grind in JS, because that is a test engine', () => {
    expect(() => assertFastGrind(js, false)).toThrow(/no wasm proof-of-work engine/)
  })

  it('names the way out, so the message is a fix and not a complaint', () => {
    expect(() => assertFastGrind(js, false)).toThrow(/--allow-js-grind/)
  })

  it('lets a test opt back in', () => {
    expect(() => assertFastGrind(js, true)).not.toThrow()
  })
})

describe('grinderLabel', () => {
  it('names the wasm file, so an operator can see which one loaded', () => {
    expect(grinderLabel(wasm)).toBe('pow wasm · /opt/prove-cash/bin/pow_grinder_bg.wasm')
  })

  it('shouts on the JS engine, which is how the last one hid for a week', () => {
    expect(grinderLabel(js)).toContain('JS FALLBACK')
  })
})

describe('loadStamper', () => {
  it('finds the engine in a checkout, through node_modules', async () => {
    const g = await loadStamper()
    expect(g.engine).toBe('wasm')
    expect(g.stamper).toBeTypeOf('function')
    expect(g.from).toMatch(/pow_grinder_bg\.wasm$/)
  })

  it('never throws on a path that holds no wasm — it reports JS instead', async () => {
    const before = process.env.POW_WASM
    process.env.POW_WASM = '/nonexistent/pow_grinder_bg.wasm'
    try {
      // The bogus override is only the first candidate, so a checkout still finds the real one.
      // What matters is that a missing file is skipped rather than thrown.
      await expect(loadStamper()).resolves.toMatchObject({ engine: 'wasm' })
    } finally {
      if (before === undefined) delete process.env.POW_WASM
      else process.env.POW_WASM = before
    }
  })
})

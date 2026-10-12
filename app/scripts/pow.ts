/**
 * The proof-of-work engine a bot grinds with, and a straight answer about which one it got.
 *
 * Posting to the board costs work and nothing else — no gas, no account. @msgboard/pow-grinder
 * does that work in WebAssembly, and @msgboard/sdk falls back to a pure-JS grind in
 * @msgboard/core when it cannot load the engine.
 *
 * **The fallback is silent, and the deployed heartbeat has been taking it.** `loadDefaultStamper`
 * wraps both engine probes in `catch { return null }`, and a null means "grind in JS". On the
 * bot host the probe cannot succeed: the bot deploy script ships five esbuild bundles and no
 * `node_modules`, so the `require.resolve('@msgboard/pow-grinder/wasm')` inside the loader throws
 * and nothing says so. Every mainnet post since the box was built has run the slow grind.
 *
 * What that cost, measured over ten hours of chain-369 logs on 2026-08-23:
 *
 *   grind rate       413 iterations a second, median of 76 posts
 *   median post      109,551 iterations, so 265 seconds
 *   worst post       497,425 iterations, so 1,200 seconds
 *   duty cycle       6.8 of 9.9 hours spent grinding
 *   thrown away      3 posts refused as `msgboard: message block too old`
 *
 * The last line is the real damage. The mine outran the window the board roots a message to, so
 * the work finished and the message was already stale. The bot cannot keep twelve intents live on
 * a 900-second cycle when the median one takes 265 seconds to post, which is why the board sat
 * between zero and two messages all day.
 *
 * Both engines, measured on the bot host itself with one payload of 197 bytes: JS 319 iterations
 * a second, wasm 2,410. The live heartbeat runs at 413, which sits on the JS figure and nowhere
 * near the wasm one. So the engine is the fault, not the CPU.
 *
 * The CPU is slow too — the same JS grind does 2,493 a second on an M1, so the box is about eight
 * times slower. That is not the part we can fix. The engine is worth 7.6x on this hardware, which
 * takes the median post from 265 seconds to about 45.
 *
 * This module therefore does two things the SDK's loader does not. It looks for the wasm beside
 * the bundle, which is where a deploy can actually put it. And it reports which engine it found,
 * so a bot can say so out loud and this can never hide again.
 */
import { wrapEngineStamp, type Stamper } from '@msgboard/sdk'

/** Which grind a bot ended up with. `js` is the slow one and always worth logging. */
export type Engine = 'wasm' | 'js'

/** The engine, plus where it came from, so a startup line can name both. */
export type Grinder = { stamper: Stamper | null; engine: Engine; from: string }

/**
 * Where to look for `pow_grinder_bg.wasm`, most specific first.
 *
 *   POW_WASM        an explicit path, for a box that keeps it somewhere else.
 *   beside this file  what a bundle sees. `import.meta.url` is the bundle's own path, so the
 *                   sibling resolves under /opt/prove-cash/bin — and the bot deploy script puts it
 *                   there.
 *   the package     what a checkout sees, through node_modules.
 */
async function candidates(): Promise<URL[]> {
  const out: URL[] = []
  const explicit = process.env.POW_WASM?.trim()
  if (explicit) out.push(new URL(`file://${explicit}`))
  out.push(new URL('pow_grinder_bg.wasm', import.meta.url))
  try {
    const { createRequire } = await import('node:module')
    const glue = createRequire(import.meta.url).resolve('@msgboard/pow-grinder/wasm')
    out.push(new URL('pow_grinder_bg.wasm', `file://${glue}`))
  } catch {
    // No node_modules to resolve through. That is the deployed case, and the sibling covers it.
  }
  return out
}

/**
 * The fastest engine this process can reach, and the truth about which one that is.
 *
 * Never throws. A caller that gets `js` still works, about four times slower, which is enough to
 * put a post past the block window it was rooted to. So the caller must say which engine it got.
 */
export async function loadStamper(): Promise<Grinder> {
  const { readFileSync } = await import('node:fs')
  let wasm: { default: (a: { module_or_path: Uint8Array }) => Promise<unknown>; stamp?: unknown }
  try {
    wasm = await import('@msgboard/pow-grinder/wasm')
  } catch {
    return { stamper: null, engine: 'js', from: 'the wasm glue is not in this build' }
  }
  for (const url of await candidates()) {
    let bytes: Uint8Array
    try {
      bytes = readFileSync(url)
    } catch {
      continue
    }
    try {
      await wasm.default({ module_or_path: bytes })
      if (typeof wasm.stamp !== 'function') {
        return { stamper: null, engine: 'js', from: 'this grinder build has no stamp' }
      }
      return {
        stamper: wrapEngineStamp(wasm.stamp as Parameters<typeof wrapEngineStamp>[0]),
        engine: 'wasm',
        from: url.pathname,
      }
    } catch {
      continue
    }
  }
  return { stamper: null, engine: 'js', from: 'no pow_grinder_bg.wasm on any path' }
}

/**
 * One line for a startup banner. It shouts on the slow engine, because a bot that quietly grinds
 * in JS looks healthy and posts a fifth of what it should.
 */
export function grinderLabel(g: Grinder): string {
  if (g.engine === 'wasm') return `pow wasm · ${g.from}`
  return `pow JS FALLBACK — 7.6x slower on this box · ${g.from}`
}

/**
 * Refuse to run a production bot on the JS grind.
 *
 * The JS engine is for tests, and nothing else. In production it is not merely slow: at 319
 * iterations a second the median post takes 265 seconds, and the board rejects work that finishes
 * after the block it was rooted to has aged out. A bot in that state burns a whole vCPU and posts
 * almost nothing, and every health check calls it green.
 *
 * So it stops instead. `--allow-js-grind` opts back in for a test on a machine with no wasm.
 */
export function assertFastGrind(g: Grinder, allow: boolean): void {
  if (g.engine === 'wasm' || allow) return
  throw new Error(
    `no wasm proof-of-work engine — ${g.from}. The JS grind runs 7.6x slower, which puts the ` +
      'median post past the block window the board roots it to, so this would burn a core and ' +
      'post almost nothing. Ship pow_grinder_bg.wasm beside the bundle, set POW_WASM to its ' +
      'path, or pass --allow-js-grind if this is a test.',
  )
}

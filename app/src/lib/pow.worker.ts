/// <reference lib="webworker" />
// The proof-of-work grind runs here so it never touches the UI thread. The engine is the
// WASM build of @msgboard/pow-grinder, which the node verifier agrees with bit for bit.
//
// The v2 scheme, which msgboard 0.3.0 introduced: the scalar is SHA256(version ‖ blockHash ‖
// payloadHash ‖ M ‖ D ‖ nonce), and a work hash passes when it falls below 2^256 / D. 0.3.0
// exported it as `stamp_v2`; 0.4.0 renamed that export to `stamp` with the same request and the
// same output bit for bit (checked on 20 random requests against 0.3.0's `stamp_v2`). The old
// v1 scheme, g·(nonce·digest + blockHash) with hash % D, is gone from the WASM build entirely.
import init, { stamp } from '@msgboard/pow-grinder/wasm'

/**
 * The message version hashed into the scalar transcript. One, and the only one there has ever
 * been — but `stamp` refuses a request without the field rather than assuming it, so it is
 * spelled out here.
 */
const MESSAGE_VERSION = 1

type Job = {
  id: number
  type: 'grind'
  category: string
  data: string
  workMultiplier: string
  workDivisor: string
  blockHash: string
}
type Cancel = { id: number; type: 'cancel' }

const CHUNK = 250_000
const cancelled = new Set<number>()

const bytes = (hex: string) => {
  const h = hex.slice(2)
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16)
  return out
}
const hex = (b: Uint8Array) =>
  '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

let ready: Promise<unknown> | null = null

self.onmessage = async (e: MessageEvent<Job | Cancel>) => {
  const msg = e.data
  if (msg.type === 'cancel') {
    cancelled.add(msg.id)
    return
  }

  const { id } = msg
  try {
    ready ??= init()
    await ready

    const req = {
      category: bytes(msg.category),
      data: bytes(msg.data),
      workMultiplier: Number(msg.workMultiplier),
      workDivisor: Number(msg.workDivisor),
      blockHash: bytes(msg.blockHash),
      version: MESSAGE_VERSION,
      startNonce: 0,
      maxIters: CHUNK,
    }

    const started = Date.now()
    for (let start = 0; ; start += CHUNK) {
      if (cancelled.has(id)) {
        cancelled.delete(id)
        self.postMessage({ id, type: 'cancelled' })
        return
      }
      req.startNonce = start
      const found = stamp(req)
      if (found) {
        const nonce = hex(found.slice(0, 8))
        self.postMessage({
          id,
          type: 'done',
          nonce,
          hash: hex(found.slice(8)),
          iterations: start,
          duration: Date.now() - started,
        })
        return
      }
      self.postMessage({ id, type: 'progress', iterations: start + CHUNK })
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: (err as Error)?.message ?? String(err) })
  }
}

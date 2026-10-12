import type { Hex } from 'viem'
import { board, getRpc, postToBoard as post, remember, type ChainId } from '@prove.cash/sdk'

/**
 * The browser's half of the board client. The SDK grinds in whatever process calls it, which in
 * a tab would be the UI thread, so this wires its `stamper` seam to a worker instead.
 */

export type GrindProgress = { iterations: bigint; difficulty: bigint }

let workerRef: Worker | null = null
let jobId = 0

function worker(): Worker {
  workerRef ??= new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' })
  return workerRef
}

/**
 * The `stamper` seam of @msgboard/sdk, pointed at our worker. Resolving here keeps the WASM
 * asset visible to the bundler, which the SDK's own dynamic import cannot guarantee.
 */
function workerStamper(onProgress?: (i: bigint) => void, signal?: { cancelled: boolean }) {
  return (input: {
    category: Hex
    data: Hex
    workMultiplier: bigint
    workDivisor: bigint
    blockHash: Hex
  }) =>
    new Promise<{ nonce: bigint; hash: Hex }>((resolve, reject) => {
      const id = ++jobId
      const w = worker()
      const onMessage = (e: MessageEvent) => {
        const m = e.data
        if (m.id !== id) return
        if (m.type === 'progress') {
          if (signal?.cancelled) w.postMessage({ id, type: 'cancel' })
          onProgress?.(BigInt(m.iterations))
          return
        }
        w.removeEventListener('message', onMessage)
        if (m.type === 'done') resolve({ nonce: BigInt(m.nonce), hash: m.hash as Hex })
        else if (m.type === 'cancelled') reject(new Error('cancelled'))
        else reject(new Error(m.message ?? 'grind failed'))
      }
      w.addEventListener('message', onMessage)
      w.postMessage({
        id,
        type: 'grind',
        category: input.category,
        data: input.data,
        workMultiplier: input.workMultiplier.toString(),
        workDivisor: input.workDivisor.toString(),
        blockHash: input.blockHash,
      })
    })
}

/**
 * Grind a payload in the worker and post it. Returns the board hash of the accepted message.
 *
 * `chainId` names the board. Leave it out only where the current chain is the right answer
 * for the whole call; a caller that awaits a wallet first must pass the chain it started on.
 */
export function postToBoard(
  data: Hex,
  onProgress?: (i: bigint) => void,
  signal?: { cancelled: boolean },
  chainId?: ChainId,
): Promise<Hex> {
  return post(data, boardClient(onProgress, signal, chainId))
}

/**
 * Post a signed offer and keep it for re-posting, both on one chain.
 *
 * The form reads the chain once, before the wallet prompts. A network switch during the
 * signature or the grind then cannot send the offer to the other chain's board, and cannot
 * file it under the other chain's list.
 */
export async function publish(
  chainId: ChainId,
  data: Hex,
  onProgress?: (i: bigint) => void,
  signal?: { cancelled: boolean },
): Promise<Hex> {
  const hash = await postToBoard(data, onProgress, signal, chainId)
  remember(chainId, data)
  return hash
}

/**
 * A board client whose grind runs in the worker.
 *
 * `postToBoard` above posts under the app's own category. The exclusive-quote surfaces post under
 * `PROVECASH_RFQ_CATEGORY` instead, through the SDK's own `postRfqQuote` and friends — every one
 * of which takes a client. This is the client they take, so a quote costs the tab's UI thread
 * exactly as little as an ordinary offer does.
 */
export function boardClient(
  onProgress?: (i: bigint) => void,
  signal?: { cancelled: boolean },
  chainId?: ChainId,
) {
  return board(getRpc(chainId), workerStamper(onProgress, signal))
}

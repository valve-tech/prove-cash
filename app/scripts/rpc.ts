/**
 * The registry endpoint a script talks to.
 *
 * Three sources, most specific first:
 *
 *   RPC              a whole URL. A local anvil, a fork, a node that is not the registry.
 *   VALVE_RPC_KEY    a registry key. The URL is built around it, so the chain stays a parameter.
 *   vk_demo          the shared key, and the last resort.
 *
 * `vk_demo` is the right default for a browser: a visitor has no key and should not need one. It
 * is the wrong default for anything that runs unattended. It is shared with every visitor to
 * prove.cash and rate-limited to match, and the bots were quietly competing with the page for it —
 * every heartbeat post logged `rpc lied, the board has it`, which is a submit that came back an
 * error after the board had already taken the message.
 *
 * **This module is Node-only, and that is the point.** The key must never be inlined into a page
 * anyone can read, so it is resolved here rather than in `sdk/src/config.ts`, which the browser
 * bundle imports. Nothing under `src/` may import this file.
 *
 * **Two forms, and the bots use the header one.** The gateway takes its key in an `X-API-Key`
 * header, and a key in a URL path reaches access logs and every upstream hop (287b57f). The bots
 * that run unattended (heartbeat, watchdog, mover, executor, solver) use `rpcEndpoint`: the
 * keyless URL, the key in a header, and `registerEndpoint` so the SDK's own clients send it too.
 * `rpcUrl`, the path form, is left for the workstation scripts until they move as well. The
 * browser app does not use this file at all, and its RPC stays as it was.
 */
import { http, type HttpTransportConfig } from 'viem'
import { setRpcHeaders } from '@prove.cash/sdk'

/** The registry key in use, without the URL around it. Exported so a script can log which it is. */
export function rpcKeyId(): string {
  return process.env.VALVE_RPC_KEY?.trim() || 'vk_demo'
}

/** True when this process is on the shared key, so a long-running script can say so once. */
export const onSharedKey = (): boolean => !process.env.RPC && rpcKeyId() === 'vk_demo'

/**
 * The endpoint for a chain, in the path form: `/rpc/<key>/evm/<chain>`. Both the board and the
 * chain live behind this same URL — the board is an RPC module on the node — so a caller sets one
 * endpoint and gets both.
 *
 * **The bots do not use this.** The key is in the path, so it reaches the gateway's access logs
 * and every hop. The bots use `rpcEndpoint`. The workstation scripts still use this.
 */
export function rpcUrl(chainId: number): string {
  const explicit = process.env.RPC?.trim()
  if (explicit) return explicit
  return `https://one.valve.city/rpc/${rpcKeyId()}/evm/${chainId}`
}

/** The gateway, with no key in it. */
export const GATEWAY = 'https://one.valve.city/rpc'

/** A URL, and the headers every request to it carries. */
export type Endpoint = { url: string; headers: Readonly<Record<string, string>> }

/**
 * The endpoint a bot uses for a chain: the keyless gateway URL, and the key in `X-API-Key`.
 *
 * `RPC` still replaces the whole URL, and then no header goes with it. That URL names a node the
 * operator chose, a fork or a local anvil, and the registry key is not theirs to receive.
 */
export function rpcEndpoint(chainId: number): Endpoint {
  const explicit = process.env.RPC?.trim()
  if (explicit) return { url: explicit, headers: {} }
  return { url: `${GATEWAY}/evm/${chainId}`, headers: { 'X-API-Key': rpcKeyId() } }
}

/**
 * The board's endpoint: `BOARD_RPC` as a whole URL with no header, or else the chain's own.
 *
 * The same rule as `RPC`: an operator's URL gets no registry key.
 */
export function boardEndpoint(chain: Endpoint): Endpoint {
  const explicit = process.env.BOARD_RPC?.trim()
  return explicit ? { url: explicit, headers: {} } : chain
}

/** A viem transport on an endpoint, carrying its headers. */
export function rpcTransport(endpoint: Endpoint, config: HttpTransportConfig = {}) {
  return http(endpoint.url, {
    ...config,
    fetchOptions: { ...config.fetchOptions, headers: { ...endpoint.headers } },
  })
}

/**
 * Tell the SDK to send this endpoint's headers. Call it for every endpoint a bot hands the SDK.
 *
 * The SDK builds its own clients for the board, the quotes and the token reads, from the URL a
 * bot gave `setRpc`. Without this, those requests reach the keyless URL with no key, and the
 * gateway answers 401.
 */
export function registerEndpoint(endpoint: Endpoint): Endpoint {
  setRpcHeaders(endpoint.url, { ...endpoint.headers })
  return endpoint
}

/**
 * Refuse a node that is not on the chain the caller named.
 *
 * Nothing in this tree asked a node what chain it was on, and viem does not ask either. Its
 * `sendTransaction` calls `assertCurrentChain` only for a `json-rpc` account; every script here
 * uses `privateKeyToAccount`, so the chain id is taken from the `chain` object and the node is
 * never consulted. A read-only script had nothing at all.
 *
 * That matters because `rpcUrl` above answers `process.env.RPC` whole and drops the `chainId` it
 * was handed. So `RPC=<a 943 node> node solver.mjs --chain 369` builds a client whose chain
 * object says 369, points it at a node on 943, and every read comes back — from the wrong chain.
 * Balances, allowances, pool reserves, board messages: all well-formed, all about somewhere else.
 * A write signs for 369 and the node rejects it, which is the lucky half; the reads are the half
 * that goes quietly wrong, and a bot makes its decisions out of the reads.
 *
 * One round trip at startup settles it. Call this once, before the first pass, on the client the
 * script is going to keep using — not on a fresh one, because the point is to hold THIS transport
 * to the chain id its owner assumed.
 *
 * @param client anything with viem's `getChainId`, which is every public and wallet client here.
 * @param expected the chain id the script believes it is on.
 */
export async function assertChainId(
  client: { getChainId: () => Promise<number> },
  expected: number,
): Promise<void> {
  let answered: number
  try {
    answered = await client.getChainId()
  } catch (e) {
    // A node that will not say is not a node this script may guess about.
    throw new Error(`${rpcLabel(expected)} would not answer eth_chainId: ${describe(e)}`)
  }
  if (answered !== expected) {
    throw new Error(
      `${rpcLabel(expected)} is on chain ${answered}, and this run is for ${expected}. ` +
        'Every read would come back well-formed and about the wrong chain. ' +
        'Point RPC at a node for this chain, or pass --chain ' +
        `${answered}.`,
    )
  }
}

/**
 * The endpoint, safe to print.
 *
 * The heartbeat used to log its whole RPC URL at startup. That was harmless while the URL carried
 * `vk_demo`, which is public; the moment a real key went in, every restart wrote the secret into
 * the journal, where it survives reboots and goes wherever the logs go. A URL that contains a
 * credential is not a loggable string, so this is what gets logged instead.
 */
export function rpcLabel(chainId: number): string {
  const explicit = process.env.RPC?.trim()
  if (explicit) {
    // A whole URL from the operator can carry a credential too — in the path or in userinfo.
    try {
      const u = new URL(explicit)
      return `${u.host} (RPC override)`
    } catch {
      return 'RPC override'
    }
  }
  const key = rpcKeyId()
  const shown = key === 'vk_demo' ? 'vk_demo (shared)' : `${key.slice(0, 6)}… (${key.length} chars)`
  return `one.valve.city/rpc/evm/${chainId} · key ${shown}`
}

/**
 * The tip, on every chain we run on. One gwei, set here and never read from the node.
 *
 * `eth_gasPrice` on 943 answers 500 gwei against a base fee of 7 wei — it is not the price of
 * anything. Letting viem estimate would pay seventy thousand times the going rate on every fill.
 * A block header's `baseFeePerGas` is a different number and an honest one, which is what the cap
 * below is built from.
 */
export const PRIORITY_FEE = 1_000_000_000n

/**
 * The floor under the fee cap. Generous on a chain whose base fee is zero, and irrelevant on one
 * whose base fee is seven hundred thousand gwei.
 */
const CAP_FLOOR = 20_000_000_000n

/** How much room the cap leaves above the current base fee. Six blocks of 12.5% rises, and more. */
const CAP_HEADROOM = 4n

/**
 * The fee fields for one transaction, given the base fee of the block it will land near.
 *
 * Every bot used to carry `{ maxPriorityFeePerGas: 1 gwei, maxFeePerGas: 20 gwei }` as a literal.
 * That is right on 943, where the base fee is zero, and it rejects every transaction on 369,
 * where the base fee is around 710,000 gwei — thirty-five thousand times the cap. The node
 * refuses the send outright, so a mainnet bot on the old constant never gets as far as a revert.
 *
 * The cap is a ceiling and not a payment: under EIP-1559 the sender pays `base + tip` and the
 * rest is never charged. Leaving four times the base fee of room therefore costs nothing but the
 * balance viem reserves while the transaction is in flight.
 */
export const feesAt = (baseFeePerGas: bigint) => {
  const cap = baseFeePerGas * CAP_HEADROOM + PRIORITY_FEE
  return {
    maxPriorityFeePerGas: PRIORITY_FEE,
    maxFeePerGas: cap > CAP_FLOOR ? cap : CAP_FLOOR,
  } as const
}

/** The same, reading the base fee off the chain. Call it per tick, not per transaction. */
export async function fees(client: {
  getBlock: (a: { blockTag: 'latest' }) => Promise<{ baseFeePerGas: bigint | null }>
}) {
  const block = await client.getBlock({ blockTag: 'latest' })
  return feesAt(block.baseFeePerGas ?? 0n)
}

/**
 * The same text, with every credential taken out of it.
 *
 * `rpcLabel` keeps our own log lines clean, and that was not enough. viem builds its error message
 * out of `metaMessages`, and one of them is `URL: <the whole request URL>` — key in the path and
 * all. A bot that logs `error.message` therefore writes the registry key into the journal, where
 * it survives reboots and follows the logs wherever they go. The heartbeat did exactly that, 32
 * times, before anyone read a FAIL line closely.
 *
 * Four passes, because a credential reaches a string by more than one route:
 *
 *   1. The registry path form, `/rpc/<key>/`. This is the one that leaked.
 *   2. URL userinfo, `https://user:secret@host`. An operator's `RPC` override can carry one.
 *   3. A query parameter named for a credential: `apikey`, `api_key`, `key`, `token`,
 *      `access_token`, `auth`, `secret`, in any case. Many providers take the key there.
 *   4. The live key itself, anywhere at all. This is the backstop: it does not care what shape
 *      the surrounding text has, so it catches the next formatter nobody has read yet.
 *
 * `vk_demo` stays legible. It is the shared key the website publishes, so hiding it would only
 * make a log harder to read and protect nothing.
 */
export function redact(text: string): string {
  let out = text.replace(/\/rpc\/(?!vk_demo\b)[A-Za-z0-9_-]+\//g, '/rpc/REDACTED/')
  out = out.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//REDACTED@')
  out = out.replace(
    /([?&](?:api[_-]?key|key|token|access[_-]?token|auth|secret)=)[^&#\s"']+/gi,
    '$1REDACTED',
  )
  const key = rpcKeyId()
  if (key !== 'vk_demo' && key.length >= 8) out = out.split(key).join('REDACTED')
  return out
}

/**
 * An error in one line that still names the cause, and carries no credential.
 *
 * `message.split('\n')[0]` was here, and on a viem error that first line is the generic wrapper:
 * a live solver logged `Invalid parameters were provided to the RPC method` for four minutes
 * while the actual complaint sat two causes down. The outermost error describes the call; the
 * innermost describes what went wrong, so this walks the chain and keeps both.
 *
 * The executor and the solver each held their own copy of this, and the heartbeat held none — it
 * logged the whole multi-line message instead, which is how the key got out. One copy now, in the
 * module every bot already imports, so a fix here reaches all of them.
 */
export function describe(e: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let cur: unknown = e
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur)
    const o = cur as { shortMessage?: string; details?: string; message?: string; cause?: unknown }
    const line = (o.shortMessage ?? o.details ?? o.message ?? '').split('\n')[0].trim()
    if (line && !parts.includes(line)) parts.push(line)
    cur = o.cause
  }
  return redact(parts.join(' ← ') || String(e))
}

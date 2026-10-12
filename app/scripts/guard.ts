import { redact } from './rpc'

/**
 * The last thing between a crash and the gateway key in the journal.
 *
 * A client can be built on an RPC URL that carries an API key in its path (`rpcUrl`), and viem
 * puts the whole request — URL, `metaMessages` and all — into the error it throws. Inside a tick
 * that is handled: each loop catches, and `redact` scrubs the URL before anything is printed.
 *
 * **Outside a tick it was not handled at all.** `heartbeat.ts` awaits `poolFor` at module scope
 * and `executor.ts` reads the relayer the same way. A rejection there reaches Node's default
 * handler, which prints the error whole. With `Restart=always` and `RestartSec=15`, a ten-minute
 * gateway outage writes the key forty times to a journal that survives reboots. That is not
 * hypothetical: it happened once already, 32 times, which is why `redact` exists.
 *
 * So the guard goes at the process edge, where every bot inherits it, rather than at each call
 * site where the next script would forget it. `scripts/e2e/common.ts` has had this since the
 * exercises were written; the five units that run unattended did not.
 *
 * Import it first, before anything that can construct a client.
 */
for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(event, (err: unknown) => {
    const text = err instanceof Error ? (err.stack ?? err.message) : String(err)
    console.error(redact(text))
    process.exit(1)
  })
}

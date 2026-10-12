import { join } from 'node:path'

/**
 * Where a bot keeps a file that must outlive a restart, when systemd gave it a place.
 *
 * A unit with `StateDirectory=prove-cash` gets `/var/lib/prove-cash`, owned by the service,
 * writable under `ProtectSystem=strict`, and kept across restarts and reboots. systemd passes the
 * path as `STATE_DIRECTORY`, so the bot reads it from there and no unit has to spell it out.
 *
 * Without that variable there is no such place, and each caller keeps its own fallback: the pool
 * graph cache goes to the temporary directory, and the trust ledger to the working directory.
 * Under the units as they stood, both were lost: `PrivateTmp=true` deletes `/tmp` at every stop,
 * and `ProtectSystem=strict` made the working directory, `/`, read-only (C3 and C8 in the solver
 * spec).
 *
 * @returns the first directory systemd named, or null outside systemd.
 */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string | null {
  // systemd separates several directories with a colon. The units name one.
  const first = env.STATE_DIRECTORY?.split(':')[0]?.trim()
  return first ? first : null
}

/** The solver's trust ledger for one chain: the state directory, or the working directory. */
export function trustFilePath(chainId: number, env: NodeJS.ProcessEnv = process.env): string {
  const dir = stateDir(env)
  return dir ? join(dir, `solver-trust-${chainId}.json`) : `.solver-trust.${chainId}.json`
}

/// <reference types="vite/client" />

/**
 * The build-time variables this app reads.
 *
 * Vite inlines an `import.meta.env.VITE_*` read at build time, so whatever is here ends up in the
 * bundle in plain text. Nothing secret may ever be added to this interface. A Reown project id is
 * public by design — it identifies the dapp to the relay and it travels inside every `wc:` URI a
 * phone scans — but it still comes from the environment rather than from a source file, so a fork
 * runs under its own id and ours is not a constant anybody has to edit out.
 */
interface ImportMetaEnv {
  /** The Reown Cloud project id. Absent or empty means this build offers no WalletConnect. */
  readonly VITE_REOWN_PROJECT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

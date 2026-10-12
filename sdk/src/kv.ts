/**
 * The key-value seam. A browser gets `localStorage`; a bot process gets a plain Map. Every
 * per-install preference this package keeps — the selected chain, endpoint overrides, the token
 * cache, the intents a tab re-posts — goes through here, so no module reaches for a global.
 */

/** The three verbs this package needs from a store. `localStorage` already satisfies it. */
export type KeyValueStore = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** A store that lives as long as the process. The default outside a browser. */
export function memoryKeyValueStore(): KeyValueStore {
  const map = new Map<string, string>()
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

/**
 * `localStorage`, with every call guarded. A browser in private mode hands out a store that
 * throws on write, and a lost preference must never take the page down with it.
 */
function guarded(store: KeyValueStore): KeyValueStore {
  return {
    getItem(key) {
      try {
        return store.getItem(key)
      } catch {
        return null
      }
    },
    setItem(key, value) {
      try {
        store.setItem(key, value)
      } catch {
        /* this tab only */
      }
    },
    removeItem(key) {
      try {
        store.removeItem(key)
      } catch {
        /* nothing to clean up */
      }
    },
  }
}

function detect(): KeyValueStore {
  try {
    const ls = (globalThis as { localStorage?: KeyValueStore }).localStorage
    if (ls) return guarded(ls)
  } catch {
    /* touching the global can itself throw */
  }
  return memoryKeyValueStore()
}

let store: KeyValueStore | null = null

/** The store in force. Detects `localStorage` once, then keeps the answer. */
export function kv(): KeyValueStore {
  store ??= detect()
  return store
}

/**
 * Point the package at your own store, or pass null to go back to detection. A solver that
 * wants its preferences on disk supplies a file-backed store here and changes nothing else.
 */
export function setKeyValueStore(next: KeyValueStore | null): void {
  store = next
}

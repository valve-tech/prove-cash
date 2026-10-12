import type { IntentStorage, StoredIntent } from './types.js'

/**
 * The store in a Map. It is the whole storage layer a solver needs: no database, no browser,
 * and the same scan order IndexedDB gives, so the query layer above cannot tell them apart.
 */
export function memoryStorage(): IntentStorage {
  const map = new Map<string, StoredIntent>()
  return {
    async get(key) {
      return map.get(key)
    },
    async put(record) {
      map.set(record.key, record)
    },
    async scan(chainId, pair, fromEnd, after, visit, desc = false) {
      const rows = [...map.values()]
        .filter(
          (r) =>
            r.chainId === chainId && (pair === undefined || r.pair === pair) && r.endTime >= fromEnd,
        )
        .sort((a, b) => a.endTime - b.endTime || (a.key < b.key ? -1 : 1))
      if (desc) rows.reverse()
      let started = !after
      for (const r of rows) {
        if (!started) {
          if (r.key === after!.primaryKey) started = true
          continue
        }
        if (!visit(r, { indexKey: r.endTime, primaryKey: r.key })) return
      }
    },
    async sweep(beforeEnd) {
      for (const [k, r] of map) if (r.endTime < beforeEnd) map.delete(k)
    },
  }
}

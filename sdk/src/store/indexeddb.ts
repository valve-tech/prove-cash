import type { Cursor, IntentStorage, StoredIntent } from './types.js'

/**
 * The store in IndexedDB. Four indexes carry every question the query layer asks: chain plus
 * pair plus expiry for the book, chain plus expiry for the whole chain, expiry alone for the
 * sweep, and chain plus maker for a portfolio.
 */

const DB_NAME = 'provecash'
const DB_VERSION = 1
const INTENTS = 'intents'

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(INTENTS)) {
        const os = db.createObjectStore(INTENTS, { keyPath: 'key' })
        os.createIndex('byChainPairEnd', ['chainId', 'pair', 'endTime'])
        os.createIndex('byChainEnd', ['chainId', 'endTime'])
        os.createIndex('byEnd', 'endTime')
        os.createIndex('byMaker', ['chainId', 'maker'])
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'))
    req.onblocked = () => reject(new Error('indexeddb blocked'))
  })
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'))
  })
}

function wrap(db: IDBDatabase): IntentStorage {
  return {
    async get(key) {
      const tx = db.transaction(INTENTS, 'readonly')
      return (await idbRequest(tx.objectStore(INTENTS).get(key))) as StoredIntent | undefined
    },
    async put(record) {
      const tx = db.transaction(INTENTS, 'readwrite')
      await idbRequest(tx.objectStore(INTENTS).put(record))
    },
    scan(chainId, pair, fromEnd, after, visit, desc = false) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(INTENTS, 'readonly')
        const os = tx.objectStore(INTENTS)
        const index = pair ? os.index('byChainPairEnd') : os.index('byChainEnd')
        const lower = pair ? [chainId, pair, fromEnd] : [chainId, fromEnd]
        const upper = pair ? [chainId, pair, Infinity] : [chainId, Infinity]
        const range = IDBKeyRange.bound(lower, upper)
        const req = index.openCursor(range, desc ? 'prev' : 'next')
        // Ascending scans jump straight to the cursor token; descending ones (the API has no
        // reverse continuePrimaryKey) skip rows until they pass it.
        let jumped = !after || desc
        let skipping = !!after && desc
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return resolve()
          if (!jumped && after) {
            jumped = true
            try {
              cursor.continuePrimaryKey(after.indexKey as IDBValidKey, after.primaryKey)
              return
            } catch {
              /* bad cursor token: visit from the start of the range */
            }
          }
          const record = cursor.value as StoredIntent
          const position: Cursor = { indexKey: cursor.key, primaryKey: cursor.primaryKey as string }
          if (after && position.primaryKey === after.primaryKey) {
            skipping = false
            cursor.continue()
            return
          }
          if (skipping) {
            cursor.continue()
            return
          }
          if (visit(record, position)) cursor.continue()
          else resolve()
        }
        req.onerror = () => reject(req.error ?? new Error('scan failed'))
      })
    },
    sweep(beforeEnd) {
      return new Promise((resolve) => {
        const tx = db.transaction(INTENTS, 'readwrite')
        const req = tx
          .objectStore(INTENTS)
          .index('byEnd')
          .openCursor(IDBKeyRange.upperBound(beforeEnd, true))
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return resolve()
          cursor.delete()
          cursor.continue()
        }
        req.onerror = () => resolve()
      })
    },
  }
}

/** Open the browser database. Rejects where IndexedDB is missing or the browser refuses it. */
export async function indexedDbStorage(name = DB_NAME): Promise<IntentStorage> {
  return wrap(await openDb(name))
}

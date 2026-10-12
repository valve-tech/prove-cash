import type { Hex } from 'viem'
import { CATEGORY } from './config.js'

/**
 * The msgboard archive: a read-only Hasura endpoint that keeps up to a year of messages the
 * live board has long rolled off. It gives the book breadth; it proves nothing. Every row is
 * decoded and signature-checked locally before it enters the store, exactly like a live one.
 */

const ARCHIVE_URL = 'https://archive.msgboard.xyz/v1/graphql'

/** One archived board message. `data` is the same payload the live board carried. */
export type ArchiveRow = {
  block_number: number
  first_seen_at: string
  hash: Hex
  data: Hex
}

/** A page of rows, and how many rows the archive holds for this chain in total. */
export type ArchivePage = { rows: ArchiveRow[]; total: number }

const QUERY = `query($c:Int!,$l:Int!,$o:Int!){
  message_archive(
    where:{category_text:{_eq:"${CATEGORY}"},chain_id:{_eq:$c}},
    order_by:{first_seen_at:desc},limit:$l,offset:$o
  ){block_number first_seen_at hash data}
  message_archive_aggregate(where:{category_text:{_eq:"${CATEGORY}"},chain_id:{_eq:$c}}){
    aggregate{count}
  }
}`

/** One page, newest first. Throws on any failure; the caller keeps the board alive without it. */
export async function fetchArchivePage(
  chainId: number,
  limit: number,
  offset: number,
): Promise<ArchivePage> {
  const res = await fetch(ARCHIVE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: QUERY, variables: { c: chainId, l: limit, o: offset } }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`archive ${res.status}`)
  const json = (await res.json()) as {
    errors?: { message: string }[]
    data?: {
      message_archive: ArchiveRow[]
      message_archive_aggregate: { aggregate: { count: number } }
    }
  }
  if (json.errors?.length || !json.data) {
    throw new Error(json.errors?.[0]?.message ?? 'archive error')
  }
  return {
    rows: json.data.message_archive,
    total: json.data.message_archive_aggregate.aggregate.count,
  }
}

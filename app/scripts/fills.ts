/**
 * What the executor decides after a fill leaves, kept apart from the bot so a test can drive it.
 *
 * `executor.ts` is a script with side effects at module scope: it reads the environment, asks the
 * chain for its id and loops for ever. Nothing in it can be imported by a test. The pieces here
 * are the ones whose mistakes cost the most, so they live where a test can reach them.
 */
import type { Abi, Address, Hex } from 'viem'
import { explainRevert } from '@prove.cash/sdk'
import { redact } from './rpc.ts'

/**
 * Why an open intent did not fill this pass. Every intent a pass does not fill counts under
 * exactly one of these (B-20 in the solver spec).
 */
export const SKIPS = [
  'no-quote', // neither quoter priced the pair
  'below-cost', // the market pays no more than the maker is owed
  'thin-spread', // above cost, under --min-spread
  'executor', // the intent names another executor
  'unvalued', // nothing values the spread in WPLS
  'model-gas', // under the cheapest fill this path has ever cost
  'refused', // the chain would not simulate it
  'gas', // the measured gas eats the spread
  'reverted', // sent, and the block reverted it
  'dry-run', // would have been sent
  'untrusted', // the inventory path, and nobody listed the tokenIn
] as const
export type Skip = (typeof SKIPS)[number]

/** One log, as much of it as the check reads. */
export type ReceiptLog = { address: Address; topics: readonly Hex[]; data: Hex }

/** As much of a receipt as the check reads. */
export type Landed = {
  status: 'success' | 'reverted'
  blockNumber: bigint
  gasUsed: bigint
  logs: readonly ReceiptLog[]
}

/**
 * How `received` was measured. `transfer-logs` is the receipt's own `Transfer` events;
 * `balance` is the fallback for a token that emits none, and it can be moved by other
 * transactions in the same block.
 */
export type Measure = 'transfer-logs' | 'balance'

/** What one sent fill came to. */
export type FillResult =
  | { kind: 'reverted'; blockNumber: bigint; gasUsed: bigint }
  | { kind: 'short-changed'; received: bigint; owed: bigint; gasUsed: bigint; method: Measure }
  | { kind: 'paid'; received: bigint; owed: bigint; gasUsed: bigint; method: Measure }

/** `Transfer(address indexed from, address indexed to, uint256 value)`. */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

/**
 * What the receipt says `token` delivered to `recipient` from `payer`, or null when the receipt
 * holds no standard `Transfer` of that token at all.
 *
 * The sum of every `Transfer` of `token` in this receipt from `payer` to `recipient`. The
 * settlement's relayer pulls the delivery from the filler, so the filler is the `from` of every
 * Transfer this fill makes. A Transfer from anybody else is not this fill's delivery. Counted, a
 * second fill in the same transaction or a token that logs a fake event could cover a short pay.
 *
 * For a fee-on-transfer token the sum is the net that reached the recipient, not what the filler
 * sent: such a token logs the net to the recipient and the cut to its collector. A log that is
 * not the standard shape (three topics, one 32-byte word) does not count.
 */
export function deliveredByLogs(
  logs: readonly ReceiptLog[],
  token: Address,
  recipient: Address,
  payer: Address,
): bigint | null {
  const want = token.toLowerCase()
  const to = recipient.toLowerCase().slice(2)
  const from = payer.toLowerCase().slice(2)
  let seen = false
  let sum = 0n
  for (const log of logs) {
    if (log.address.toLowerCase() !== want) continue
    if (log.topics.length !== 3 || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue
    if (log.data.length !== 66) continue
    seen = true
    if (log.topics[1].toLowerCase().slice(26) !== from) continue
    if (log.topics[2].toLowerCase().slice(26) === to) sum += BigInt(log.data)
  }
  return seen ? sum : null
}

/**
 * Judge a fill from its receipt: what this transaction delivered to the recipient, against what
 * the chain owed at the landing block.
 *
 * **The status comes first.** A reverted fill moves no token, so the delivery is zero, and zero
 * is less than any debt. Read without the status, a revert looked exactly like a short-change:
 * the bot logged ALERT, exited 2, and systemd restarted it into the same fill (C6).
 *
 * **The receipt, not the balance at `latest`.** The old check read the recipient's balance
 * before the send and again at `latest`. Any other transfer to or from that address in between
 * moved the number. On testnet 943, 2026-09-23, it alarmed twice on fills whose receipts paid
 * the maker exactly what was owed (tx 0x26bae407…, 0xe0d31f9a…), and exited the bot each time.
 *
 * A token that emits no standard `Transfer` falls back to the recipient's balance at the end of
 * the landing block against the end of the block before it. That still counts other
 * transactions in the same block, so the result names the method it used.
 *
 * The recipient is the intent's `recipient`, as signed. The settlement pays `i.recipient` and
 * nothing else; it never swaps a zero recipient for the maker (`_payMaker`, `_recordLeg`).
 *
 * `payer` is the address the settlement pulls the delivery from: this wallet on the inventory
 * path, the `ProveExecutor` contract on the zero-inventory path.
 *
 * @param read `balanceAt` reads the recipient's `tokenOut` balance at the end of a block;
 *   `owedAt` prices the debt at the landing block.
 */
export async function checkFill(
  receipt: Landed,
  fill: { token: Address; recipient: Address; payer: Address },
  read: {
    balanceAt: (blockNumber: bigint) => Promise<bigint>
    owedAt: (blockNumber: bigint) => Promise<bigint>
  },
): Promise<FillResult> {
  if (receipt.status !== 'success') {
    return { kind: 'reverted', blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed }
  }
  let received = deliveredByLogs(receipt.logs, fill.token, fill.recipient, fill.payer)
  let method: Measure = 'transfer-logs'
  if (received === null) {
    method = 'balance'
    const [before, after] = await Promise.all([
      read.balanceAt(receipt.blockNumber - 1n),
      read.balanceAt(receipt.blockNumber),
    ])
    received = after - before
  }
  const owed = await read.owedAt(receipt.blockNumber)
  return received < owed
    ? { kind: 'short-changed', received, owed, gasUsed: receipt.gasUsed, method }
    : { kind: 'paid', received, owed, gasUsed: receipt.gasUsed, method }
}

/** The two reads a replay needs, as viem's public client has them. */
export type Replayer = {
  getTransaction: (a: { hash: Hex }) => Promise<{
    from: Address
    to: Address | null
    input: Hex
    value: bigint
    gas: bigint
  }>
  call: (a: {
    account: Address
    to: Address | null
    data: Hex
    value: bigint
    gas: bigint
    blockNumber: bigint
  }) => Promise<unknown>
}

/**
 * Why a sent transaction reverted, as well as the chain can still say.
 *
 * A receipt carries no reason. This replays the transaction against the state at the end of the
 * block it landed in, which holds whatever moved the pool first. That is close to the state the
 * fill met, and not the same: later transactions in the block are in it too. So the answer is a
 * best effort, and the line says it came from a replay.
 *
 * Never throws, and never returns a credential: a viem error can carry the whole request URL.
 */
export async function revertReason(
  client: Replayer,
  hash: Hex,
  blockNumber: bigint,
  abis: readonly Abi[] = [],
): Promise<string> {
  let tx: Awaited<ReturnType<Replayer['getTransaction']>>
  try {
    tx = await client.getTransaction({ hash })
  } catch (e) {
    return redact(`reason not decodable: ${explainRevert(e)}`)
  }
  try {
    await client.call({
      account: tx.from,
      to: tx.to,
      data: tx.input,
      value: tx.value,
      gas: tx.gas,
      blockNumber,
    })
    return `reason not decodable: a replay at the end of block ${blockNumber} ran clean`
  } catch (e) {
    return redact(`${explainRevert(e, abis)} (replayed at the end of block ${blockNumber})`)
  }
}

/**
 * An honest name for the path a quote was priced on.
 *
 * `Quote.route` has two values, because the router quoter asks for two paths: the direct pair,
 * and one hop through WPLS. A graph path can be three hops through any tokens, and calling every
 * path longer than two tokens `wpls` named a hop that the route may never take.
 */
export function routeLabel(
  path: readonly Address[],
  wpls: Address | null,
): 'direct' | 'wpls' | 'multi-hop' {
  if (path.length === 2) return 'direct'
  if (path.length === 3 && wpls && path[1].toLowerCase() === wpls.toLowerCase()) return 'wpls'
  return 'multi-hop'
}

/**
 * A receipt, or an error when the block reverted the transaction.
 *
 * For a send whose success the next step assumes: an approval, a funding transfer. Waiting for a
 * receipt proves the transaction was mined, not that it did anything. A reverted approval that
 * reads as done marks the token approved for the life of the process, and every fill in that
 * token then fails its simulation for a reason nobody logged.
 */
export function landedOrThrow<R extends { status: 'success' | 'reverted' }>(
  receipt: R,
  what: string,
  hash: Hex,
): R {
  if (receipt.status !== 'success') throw new Error(`${what} reverted: ${hash}`)
  return receipt
}

/**
 * The tokens the inventory path may take in: the chain's listed tokens and any the operator names.
 *
 * The inventory path pays tokenOut out of this wallet's float and keeps tokenIn. It never sells
 * tokenIn, so tokenIn must be worth what the market says. A maker can mint a worthless token,
 * pair it with real tUSDC, and post an intent at any rate. Every price check then passes, and the
 * fill hands the float to the maker. The zero-inventory path sells tokenIn inside the same
 * transaction, so a worthless one reverts there and costs only gas.
 *
 * This follows a token list, as the Uniswap interface does: a token nobody listed gets no trust.
 */
export function trustedInventory(
  listed: readonly { address: Address }[],
  extra: readonly Address[],
): ReadonlySet<string> {
  return new Set([...listed.map((t) => t.address), ...extra].map((a) => a.toLowerCase()))
}

/** True when the inventory path may take `tokenIn` in. */
export const inventoryTrusts = (tokenIn: Address, trusted: ReadonlySet<string>): boolean =>
  trusted.has(tokenIn.toLowerCase())

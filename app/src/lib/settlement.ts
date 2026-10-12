import type { Address, Hex } from 'viem'
import {
  getChainId,
  relayerAllowance,
  rpcClient,
  settlement as settlementAt,
  settlementLive,
  SETTLEMENT_ABI,
  type ChainId,
  type FillPlan,
  type Intent,
  type ReadOptions,
} from '@prove.cash/sdk'
import * as settlement from '@prove.cash/sdk/settlement'
import { browserWallet } from './wallet'

/**
 * The settlement writes, bound to the browser wallet. The SDK takes a wallet client because a
 * bot holds a private key and a tab holds MetaMask; this is the tab's half and nothing more.
 *
 * Each wrapper refuses before it opens a wallet. Prompting somebody to switch chains for a
 * transaction that cannot go through is worse than the error.
 *
 * Every call here goes through the SDK. The cancel path used to name the contract from this file
 * because the SDK had no wrapper for it, which meant a maker outside the browser could sign an
 * order through the package and had nothing to call to take it back.
 */

const notDeployed = () => new Error('The settlement contract is not deployed.')

/** Send a fill plan through the browser wallet. */
export async function executeFills(account: Address, plan: FillPlan): Promise<Hex> {
  const chainId = getChainId()
  if (!settlementLive(chainId)) throw notDeployed()
  return settlement.executeFills(await browserWallet(chainId), account, plan, chainId)
}

/**
 * Approve the relayer for `amount`, or nothing when the allowance already covers it.
 *
 * The settlement check is not made redundant by the allowance read below it. On a chain with no
 * settlement `relayerAllowance` answers zero, and zero here does not mean "approve something" —
 * it means there is no relayer to approve. Without this line the wrapper opened a wallet, asked
 * the person to switch chains, and sent an approval to whatever address a read of the zero
 * address returned. Every other write in this file refuses before it prompts; this one did not.
 */
export async function approveRelayer(
  account: Address,
  token: Address,
  amount: bigint,
  chainId: ChainId = getChainId(),
): Promise<Hex | null> {
  if (!settlementLive(chainId)) throw notDeployed()
  const current = await relayerAllowance(account, token, { chainId })
  if (current >= amount) return null
  return settlement.approveToken(await browserWallet(chainId), account, token, amount, chainId)
}

/**
 * Commit token A to one intent's escrow.
 *
 * These three take the whole intent rather than its hash. The board publishes the hash first, so
 * a function keyed on the bare hash let a stranger claim the reservation and walk off with the
 * maker's deposit. The hash commits to the maker and the token already; handing over the
 * preimage is what makes that unsayable.
 */
export async function deposit(
  account: Address,
  intent: Intent,
  amount: bigint,
  chainId: ChainId = getChainId(),
): Promise<Hex> {
  if (!settlementLive(chainId)) throw notDeployed()
  return settlement.deposit(await browserWallet(chainId), account, intent, amount, chainId)
}

/**
 * Take the escrow back. One transaction, no waiting, and it ends the offer.
 *
 * An intent is armed by its deposit, so undoing the deposit undoes the offer: the contract writes
 * the cancellation as it returns the money, and nobody can fund that intent again afterwards.
 */
export async function withdrawReservation(account: Address, intent: Intent): Promise<Hex> {
  const chainId = getChainId()
  if (!settlementLive(chainId)) throw notDeployed()
  return settlement.withdrawReservation(await browserWallet(chainId), account, intent, chainId)
}

/**
 * Stop this intent being filled. It bites on the block it lands, and only the maker can send it.
 *
 * A maker in escrow custody does not need this: `withdrawReservation` ends the offer as it hands
 * the money back. An authorization holds no deposit and may rest for ever, so a cancel is the
 * only way to revoke the signature behind it.
 */
export async function cancelIntent(account: Address, intent: Intent): Promise<Hex> {
  const chainId = getChainId()
  if (!settlementLive(chainId)) throw notDeployed()
  return settlement.cancel(await browserWallet(chainId), account, intent, chainId)
}

/**
 * Which of these intent hashes the chain has already cancelled, aligned with the input.
 *
 * An escrowed intent may rest indefinitely, so a clock cannot tell a live offer from a dead one.
 * A read that fails answers false: offering a cancel that reverts costs the maker one rejected
 * simulation, and hiding one that is still needed leaves the signature armed.
 */
export async function readCancelled(hashes: readonly Hex[]): Promise<boolean[]> {
  const chainId = getChainId()
  if (!settlementLive(chainId) || hashes.length === 0) return hashes.map(() => false)
  const at = await settlement.readCancelledAt(hashes, { chainId })
  return at.map((v) => v !== null && v !== 0n)
}

/**
 * What this wallet has resting in the settlement, per token, aligned with the input.
 *
 * Money that belongs to no intent any more. `park` is permissionless, so the moment one of this
 * maker's offers dies anybody may move its deposit here — the maker sends nothing and signs
 * nothing, and the reservation the Mine tab was showing them goes to zero. Without this read the
 * tab would tell them their money had left.
 *
 * A read that fails answers null rather than zero. Rendering a bad minute on an endpoint as an
 * empty row would say the money is gone.
 */
export async function readParked(
  account: Address,
  tokens: readonly Address[],
): Promise<(bigint | null)[]> {
  const chainId = getChainId()
  if (!settlementLive(chainId) || tokens.length === 0) return tokens.map(() => null)
  return settlement.readParkedBalances(account, tokens, { chainId })
}

/**
 * Take one token's parked capital back to the wallet.
 *
 * One call per token, because the contract keeps one row per token. It pays `msg.sender` and can
 * pay nobody else, so there is no recipient to get wrong.
 */
export async function withdrawParked(account: Address, token: Address): Promise<Hex> {
  const chainId = getChainId()
  if (!settlementLive(chainId)) throw notDeployed()
  return settlement.withdrawParked(await browserWallet(chainId), account, token, chainId)
}

/**
 * The lowest position this maker still honours in lane 0. Null when the read did not come back.
 *
 * Lane 0 is the lane every nonce this repository builds sits in, and `nonceFloor` answers for it.
 * Null rather than zero, for `readParked`'s reason: zero is a real answer meaning "this maker has
 * never retired anything", and a bulk off switch drawn from a failed read would send a floor the
 * contract refuses.
 */
export async function readFloor(maker: Address): Promise<bigint | null> {
  const chainId = getChainId()
  if (!settlementLive(chainId)) return null
  return settlement.readNonceFloor(maker, { chainId }).catch(() => null)
}

/**
 * Retire every offer this maker signed below `floor`, in `floor`'s own lane. One transaction.
 *
 * It ends signatures and returns no money. A killed offer's deposit stays in `_reserved` until
 * somebody parks it — `park` reads the floor, so anybody may — and the maker then takes it home
 * with one `withdrawParked` per token.
 */
export async function invalidateBefore(account: Address, floor: bigint): Promise<Hex> {
  const chainId = getChainId()
  if (!settlementLive(chainId)) throw notDeployed()
  return settlement.invalidateBefore(await browserWallet(chainId), account, floor, chainId)
}

/**
 * The `Parked` event, taken out of the generated ABI rather than written out here.
 *
 * `gen-abi.mjs` is the only author of that file and CI fails on a diff, so this argument list
 * cannot drift from the contract. A hand-typed copy in this repository once passed `tsc` and
 * would have failed every call on chain.
 */
const PARKED_EVENT = SETTLEMENT_ABI.find(
  (item) => item.type === 'event' && item.name === 'Parked',
) as Extract<(typeof SETTLEMENT_ABI)[number], { type: 'event'; name: 'Parked' }>

/**
 * How far back the log query looks, in blocks.
 *
 * **Measured against the app's own default endpoint on 2026-09-09**, `https://one.valve.city`
 * on chain 943: an `eth_getLogs` spanning 99,999 blocks is refused with
 * `ErrGetLogsExceededMaxAllowedRange`; 75,000 and 50,000 both answer. So the ceiling sits between
 * those two and 50,000 clears it with room. PulseChain's own public endpoint answered a
 * 1,000,000-block span, so this bound is the gateway's rather than the chain's.
 *
 * **What the window costs the maker.** Blocks 25,324,863 to 25,343,551 on chain 943 span 191,250
 * seconds, which is 10.2 seconds a block, so 50,000 blocks is about 5.9 days. A token whose last
 * `Parked` is older than that, and which no local record names either, keeps its row hidden. The
 * union is what makes that rare: a maker who signed the offer on this device already has the
 * token in the local half, whatever the log query reaches.
 */
const PARKED_WINDOW = 50_000n

/**
 * Every token that parked for this maker inside the window, from the chain's own logs.
 *
 * The Mine tab used to learn its token set from the newest hundred records this device holds, so
 * a parked row in any other token was invisible. `Parked` indexes the maker, so this needs no
 * record store at all.
 *
 * **`Unparked` is not queried, and that is a decision rather than an omission.** A token can only
 * unpark after it parked, so `Parked` already names a superset — and a row that unparked is empty
 * until it parks again, which emits `Parked` once more. A second round trip on a fifteen-second
 * poll would add no token.
 *
 * Null when the read fails, and the caller adds nothing rather than removing a row the maker can
 * already see.
 */
export async function readParkedTokens(
  maker: Address,
  opts: ReadOptions = {},
): Promise<Address[] | null> {
  const chainId = opts.chainId ?? getChainId()
  if (!settlementLive(chainId)) return null
  try {
    const client = opts.client ?? rpcClient()
    const head = await client.getBlockNumber()
    const logs = await client.getLogs({
      address: settlementAt(chainId),
      event: PARKED_EVENT,
      args: { maker },
      fromBlock: head > PARKED_WINDOW ? head - PARKED_WINDOW : 0n,
      toBlock: head,
    })
    // `token` is indexed, so a log that decoded at all carries one. The filter keeps the type
    // honest rather than asserting it away.
    return logs.map((log) => log.args.token).filter((token) => token !== undefined)
  } catch {
    return null
  }
}

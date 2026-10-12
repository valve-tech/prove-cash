/**
 * Why the board's fillable intents are not filling.
 *
 *   RPC=… npx tsx scripts/why-not.ts            # chain 943
 *   CHAIN=369 npx tsx scripts/why-not.ts
 *
 * The executor reports a bare selector when a fill reverts, because it hands viem the settlement
 * ABI and the revert often comes from the token. `ERC20InsufficientBalance(address,uint256,
 * uint256)` names the account and both amounts; printed as `0xe450d38c` it names nothing, and
 * three separate causes today wore that same disguise.
 *
 * So this asks two questions per intent and decodes both answers properly:
 *
 *   1. `fillability` — the settlement's own validator, as a reason rather than a revert.
 *   2. a simulated `fill` — against an ABI carrying the ERC-20 errors as well, so a token that
 *      refuses says which account was short and by how much.
 */
import { createPublicClient, http, type Address } from 'viem'
import { pulsechain, pulsechainV4 } from 'viem/chains'
import { SETTLEMENT_ABI, maxFeeRateFor, readAvailable } from '@prove.cash/sdk/settlement'
import { explainRevert } from '@prove.cash/sdk/revert'
import { verifyIntent } from '@prove.cash/sdk/intent'
import { settlement as settlementFor, setRpc } from '@prove.cash/sdk/config'
import { board, decodeIntent, PROVECASH_CATEGORY, type SignedIntent } from '@prove.cash/sdk'
import { rpcUrl, rpcLabel, assertChainId } from './rpc.js'

const CHAIN = Number(process.env.CHAIN ?? 943)
const chain = CHAIN === 369 ? pulsechain : pulsechainV4
const RPC = rpcUrl(CHAIN)
const SETTLEMENT = (process.env.SETTLEMENT as Address) ?? settlementFor(CHAIN as 369 | 943)
const WHO = (process.env.EXECUTOR ?? '0xF5eD57bb129A2c7210EA206cd04dDf87E2fB4e0A') as Address

const REASONS = [
  'Ok', 'BadTerms', 'NotStarted', 'Expired', 'Cancelled', 'NonceTooLow', 'WrongExecutor',
  'NothingToFill', 'TooMuch', 'PartialNotAllowed', 'EscrowShort', 'BadSignature', 'FeeTooHigh',
  'BelowMinFill', 'TokenOutUnreadable',
] as const

setRpc(RPC, CHAIN as never, 'board')
const client = createPublicClient({ chain, transport: http(RPC) })

// The node has to be on this chain. `RPC` replaces the whole URL while the chain id beside it
// stays put, so the two can silently disagree and every read comes back about somewhere else.
await assertChainId(client, CHAIN)

const msgboard = board(RPC)

console.log(`chain ${CHAIN} · ${rpcLabel(CHAIN)} · settlement ${SETTLEMENT}`)
console.log(`asking as ${WHO}\n`)

// The board the executor reads, the same way it reads it — not the SDK's default store, which
// is configured elsewhere and answers empty here.
const content = await msgboard.content({ category: PROVECASH_CATEGORY })
const messages = content[PROVECASH_CATEGORY] ?? []
const seen = new Map<string, SignedIntent>()
for (const m of messages) {
  const d = decodeIntent(m.data)
  if (!d) continue
  if (!(await verifyIntent(d, CHAIN as never))) continue
  seen.set(`${d.maker}:${d.nonce}`, d)
}
console.log(`${messages.length} message(s), ${seen.size} verified intent(s)\n`)

for (const i of seen.values()) {
  const { remaining, live } = await readAvailable(i, { client, chainId: CHAIN as never })
  if (!live || remaining === 0n) continue
  const take = remaining
  const cap = maxFeeRateFor([i])
  const label = `${i.tokenIn.slice(0, 8)}→${i.tokenOut.slice(0, 8)} take=${take}`

  let reason = '?'
  try {
    const r = await client.readContract({
      address: SETTLEMENT,
      abi: SETTLEMENT_ABI,
      functionName: 'fillability',
      args: [i as never, i.signature, take, WHO, cap],
    })
    reason = REASONS[Number(r)] ?? `reason ${r}`
  } catch (err) {
    reason = `fillability threw: ${explainRevert(err, [SETTLEMENT_ABI as never])}`
  }

  let sim = 'not attempted'
  if (reason === 'Ok') {
    try {
      await client.simulateContract({
        address: SETTLEMENT,
        abi: SETTLEMENT_ABI,
        functionName: 'fill',
        args: [i as never, i.signature, take, cap],
        account: WHO,
      })
      sim = 'would fill'
    } catch (err) {
      sim = explainRevert(err, [SETTLEMENT_ABI as never])
    }
  }

  console.log(`${label}\n  fillability: ${reason}\n  simulate:    ${sim}`)
}

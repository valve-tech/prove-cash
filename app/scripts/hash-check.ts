/**
 * Does the TypeScript hash agree with the deployed contract?
 *
 *   npx tsx scripts/hash-check.ts --chain 943
 *
 * Everything rests on this. The app signs what `intentHashOf` says the intent is; the contract
 * verifies what `hashIntent` says it is. One field out of order and every signature the app
 * produces is unspendable. The offline fixture pins the maths; this pins it to a real address.
 */
import { createPublicClient, http, parseUnits } from 'viem'
import {
  CURVE_LINEAR,
  FLAG_PARTIAL,
  SETTLEMENT_ABI,
  ZERO,
  ZERO_HASH,
  intentHashOf,
  isSupportedChain,
  network,
  presetTokens,
  settlement,
  type ChainId,
  type Intent,
} from '@prove.cash/sdk'
import { rpcUrl, assertChainId } from './rpc.ts'

const i = process.argv.indexOf('--chain')
const chainId = Number(i >= 0 ? process.argv[i + 1] : 943) as ChainId
if (!isSupportedChain(chainId)) throw new Error(`unknown chain ${chainId}`)

const address = settlement(chainId)
if (address === ZERO) throw new Error(`no settlement deployed on ${chainId}`)

const client = createPublicClient({
  chain: network(chainId).chain,
  transport: http(rpcUrl(chainId)),
})

// The node has to be on this chain. `RPC` replaces the whole URL while the chain id beside it
// stays put, so the two can silently disagree and every read comes back about somewhere else.
await assertChainId(client, chainId)

const tokens = presetTokens(chainId)
const now = BigInt(Math.floor(Date.now() / 1000))
const intent: Intent = {
  maker: '0x1111111111111111111111111111111111111111',
  recipient: '0x2222222222222222222222222222222222222222',
  tokenIn: tokens[0].address,
  tokenOut: tokens[1].address,
  amountIn: parseUnits('12345.6789', tokens[0].decimals),
  minOutStart: parseUnits('987.654321', tokens[1].decimals),
  minOutEnd: parseUnits('123.456', tokens[1].decimals),
  // A straight line across the whole window: kind 0, and the word it reads none of.
  curve: CURVE_LINEAR,
  startTime: now,
  endTime: now + 7200n,
  executor: '0x3333333333333333333333333333333333333333',
  feeConfig: ZERO_HASH,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  /**
   * An awkward number on purpose. `feeRate` is a `uint64` fraction of one ether, so a zero here
   * would agree across the two implementations even if one of them packed the field wrongly.
   * This value fills the high bytes, which is what proves viem and Solidity agree.
   *
   * It was `-3` while the field was an `int16` and a negative rate meant "no opinion". The field
   * is unsigned now and zero says that, so the sign is gone and the value has to earn its keep
   * some other way.
   */
  feeRate: 3_700_000_000_000_000n,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: FLAG_PARTIAL,
  nonce: 99n,
}

const offChain = intentHashOf(intent, chainId)
const onChain = (await client.readContract({
  address,
  abi: SETTLEMENT_ABI,
  functionName: 'hashIntent',
  args: [intent],
})) as `0x${string}`

console.log('settlement', address)
console.log('typescript ', offChain)
console.log('contract   ', onChain)
if (offChain.toLowerCase() !== onChain.toLowerCase()) {
  console.log('MISMATCH — every signature this app produces would be unspendable')
  process.exit(1)
}
console.log('they agree')

/**
 * End-to-end check against the real board: sign an intent, encode it, grind, post it, read it
 * back, decode it, verify the signature. Run with `npx tsx scripts/live-post.ts`.
 *
 * This is the one test that touches the live msgboard. It uses a throwaway key and moves no
 * funds — an intent is only a signature until a settlement contract exists.
 */
import { parseUnits } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import {
  CURVE_LINEAR,
  PROVECASH_CATEGORY,
  board as boardClient,
  signingDomain,
  FLAG_PARTIAL,
  ZERO,
  ZERO_HASH,
  decodeIntent,
  encodeIntent,
  intentKey,
  isSupportedChain,
  verifyIntent,
  type ChainId,
  type Intent,
  signIntent,
} from '@prove.cash/sdk'
import { rpcUrl } from './rpc.ts'

/**
 * The board this script posts to. Everything it signs must name the same chain.
 *
 * 943, because that is where the settlement contract is. Both chains take our messages — 369 was
 * behind on the proof-of-work verifier for a while and is not any more; `pow-probe.ts` is the
 * script that measures it, and it is the only thing worth believing on the question.
 */
const CHAIN = Number(process.env.CHAIN ?? 943)
if (!isSupportedChain(CHAIN)) throw new Error(`unknown chain ${CHAIN}`)
const chainId: ChainId = CHAIN
const RPC = rpcUrl(chainId)

const account = privateKeyToAccount(generatePrivateKey())
const board = boardClient(RPC)

const now = BigInt(Math.floor(Date.now() / 1000))
const intent: Intent = {
  maker: account.address,
  recipient: account.address,
  tokenIn: '0x86390129a2079fb7f0FC889473160a3a449117Ab', // tUSDC on 943
  tokenOut: '0xabeF58363E0fc60250D16778848eAED831eA26F9', // tPLSX on 943
  amountIn: parseUnits('100000', 6), // tUSDC is a six-decimal token, not eighteen.
  minOutStart: parseUnits('3000', 18),
  minOutEnd: parseUnits('3000', 18),
  // A straight line across the whole window: kind 0, and the word it reads none of.
  curve: CURVE_LINEAR,
  startTime: now,
  endTime: now + 3600n,
  executor: ZERO,
  feeConfig: ZERO_HASH,
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  // Zero: no opinion, so a fill charges the owner's floor. This script posts a message;
  // it never prices one.
  feeRate: 0n,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: FLAG_PARTIAL,
  nonce: BigInt(Date.now()),
}

const signature = await signIntent(account, intent, { domain: signingDomain(chainId) })
const signed = { ...intent, signature }
const data = encodeIntent(signed)

console.log('maker      ', account.address)
console.log('payload    ', (data.length - 2) / 2, 'bytes')

const roundTrip = decodeIntent(data)
if (!roundTrip) throw new Error('codec: decode returned null')
for (const k of Object.keys(signed) as (keyof typeof signed)[]) {
  const a = String(signed[k]).toLowerCase()
  const b = String(roundTrip[k]).toLowerCase()
  if (a !== b) throw new Error(`codec: ${k} drifted (${a} !== ${b})`)
}
// The chain, spelled out. `verifyIntent` falls back to the default chain, which is 943, so
// omitting it verified a 369 signature against a 943 domain and failed every run.
if (!(await verifyIntent(roundTrip, chainId))) {
  throw new Error('codec: signature did not verify')
}
console.log('round trip  ok')

const status = await board.status()
console.log('board       enabled=%s count=%s', status.enabled, BigInt(status.count))
console.log('difficulty ', board.getDifficulty(data))

const started = Date.now()
const work = await board.grind(PROVECASH_CATEGORY, data)
console.log('grind       %sms, %s iterations', Date.now() - started, work.stats.iterations)

const hash = await board.addMessage(work.message)
console.log('posted     ', hash)

const content = await board.content({ category: PROVECASH_CATEGORY })
const found = (content[PROVECASH_CATEGORY] ?? []).find((m) => m.hash === hash)
if (!found) throw new Error('board: posted message did not come back')
const readBack = decodeIntent(found.data)
if (!readBack || intentKey(readBack) !== intentKey(signed)) {
  throw new Error('board: read-back intent does not match')
}
if (!(await verifyIntent(readBack))) throw new Error('board: read-back signature failed')
console.log('read back   ok — signature verifies from the board')

/**
 * Let the relayer move a maker's tokens, so the intents it signs can actually fill.
 *
 *   HEARTBEAT_KEY=… npx tsx scripts/approve-relayer.ts            # dry run, chain 943
 *   HEARTBEAT_KEY=… npx tsx scripts/approve-relayer.ts --send
 *   HEARTBEAT_KEY=… SETTLEMENT=0x… npx tsx scripts/approve-relayer.ts --chain 369 --send
 *
 * **The relayer, never the settlement.** `ProveSettlement` holds no allowance of any kind — every
 * `transferFrom` it makes goes through `ProveRelayer.pull`. Approving the settlement is a wasted
 * transaction that leaves every intent unfillable, and the address is read off the settlement
 * rather than configured so nobody can get it wrong.
 *
 * Without this an intent is a signature backed by nothing: the maker holds the tokens, the
 * contract cannot move them, and `fillability` refuses on the allowance probe.
 */
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  parseAbi,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  defaultRpc,
  isSupportedChain,
  network,
  presetTokens,
  setChainId,
  setRpc,
  setSettlementOverride,
  settlement,
  type ChainId,
} from '@prove.cash/sdk'
import { SETTLEMENT_ABI } from '@prove.cash/sdk/settlement'
import { fees, assertChainId } from './rpc.ts'

const SEND = process.argv.includes('--send')

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

// 943 by default, because that is where this has always run. It takes a chain now because the
// mainnet maker needs the same approvals, and a hard-coded 943 quietly approved the wrong
// relayer on the wrong chain with the right-looking output.
const CHAIN = Number(arg('chain', '943')) as ChainId
if (!isSupportedChain(CHAIN)) throw new Error(`unknown chain ${CHAIN}`)
// The registry's own endpoint. Never a stranger's public node — this hammers it with reads.
const RPC = process.env.RPC ?? defaultRpc(CHAIN)

setChainId(CHAIN)
setRpc(RPC, CHAIN)
// Before the settlement is read. 369 is deployed but its registry entry is deliberately zero, so
// without this the relayer lookup below reverts against the zero address.
if (process.env.SETTLEMENT) setSettlementOverride(CHAIN, process.env.SETTLEMENT as Address)

const raw = process.env.HEARTBEAT_KEY
if (!raw) throw new Error('HEARTBEAT_KEY is required')
const maker = privateKeyToAccount((raw.startsWith('0x') ? raw : `0x${raw}`) as Hex)

const chain = network(CHAIN).chain
const pub = createPublicClient({ chain, transport: http(RPC) })

// The node has to be on this chain. `RPC` replaces the whole URL while the chain id beside it
// stays put, so the two can silently disagree and every read comes back about somewhere else.
await assertChainId(pub, CHAIN)

const wallet = createWalletClient({ account: maker, chain, transport: http(RPC) })

/**
 * The fee fields, read once. See `seed-market.ts` for the measurement behind the 1 gwei tip.
 *
 * This script approves a handful of tokens and exits, so one block header covers the whole run.
 * A bot that lives for days reads a fresh one every tick instead.
 */
const txFees = await fees(pub)

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const relayer = await pub.readContract({
  address: settlement(CHAIN),
  abi: SETTLEMENT_ABI,
  functionName: 'relayer',
})

console.log(`maker    ${maker.address}`)
console.log(`relayer  ${relayer}   (read off the settlement, not configured)`)
console.log(`gas      ${formatUnits(await pub.getBalance({ address: maker.address }), 18)} PLS\n`)

for (const t of presetTokens(CHAIN)) {
  const held = await pub.readContract({
    address: t.address, abi: ERC20, functionName: 'balanceOf', args: [maker.address],
  })
  if (held === 0n) continue // nothing to sell, nothing to approve

  const allowed = await pub.readContract({
    address: t.address, abi: ERC20, functionName: 'allowance', args: [maker.address, relayer],
  })
  // Approve well above the balance so a top-up does not need a second transaction, but never
  // unbounded: this key lives on a bot, and an infinite approval is a standing invitation.
  const want = held * 10n
  if (allowed >= held) {
    console.log(`  ${t.symbol.padEnd(6)} holds ${formatUnits(held, t.decimals).padEnd(12)} allowance already covers it`)
    continue
  }
  if (!SEND) {
    console.log(`  ${t.symbol.padEnd(6)} holds ${formatUnits(held, t.decimals).padEnd(12)} would approve ${formatUnits(want, t.decimals)}`)
    continue
  }
  const hash = await wallet.writeContract({
    address: t.address, abi: ERC20, functionName: 'approve', args: [relayer, want], ...txFees,
  })
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
  console.log(`  ${t.symbol.padEnd(6)} approved ${formatUnits(want, t.decimals).padEnd(12)} gas ${r.gasUsed} · ${hash}`)
}

if (!SEND) console.log('\ndry run — nothing was sent. Re-run with --send.')

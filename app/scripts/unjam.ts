/**
 * Clear a stuck nonce, then report what happens to everything queued behind it.
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK npx tsx scripts/unjam.ts
 *
 * A transaction the miners will not take blocks every later nonce from the same account, however
 * much those later ones pay. Replacing the one at the front is the only way out, and watching
 * what drains afterwards tells you whether the others were ever too cheap in the first place.
 */
import { createPublicClient, createWalletClient, formatGwei, http, parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { pulsechainV4 } from 'viem/chains'
import { rpcUrl, assertChainId } from './rpc.ts'

const raw = process.env.DEPLOYER_PK?.trim()
if (!raw) throw new Error('DEPLOYER_PK is required')
const pk = (raw.startsWith('0x') ? raw : `0x${raw}`) as `0x${string}`

const rpc = rpcUrl(943)
const account = privateKeyToAccount(pk)
const pub = createPublicClient({ chain: pulsechainV4, transport: http(rpc) })

// The node has to be on this chain. `RPC` replaces the whole URL while the chain id beside it
// stays put, so the two can silently disagree and every read comes back about somewhere else.
await assertChainId(pub, pulsechainV4.id)

const wallet = createWalletClient({ account, chain: pulsechainV4, transport: http(rpc) })

const latest = await pub.getTransactionCount({ address: account.address, blockTag: 'latest' })
const pending = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' })
console.log(`${account.address}`)
console.log(`  nonce latest ${latest} · pending ${pending} · ${pending - latest} queued`)
if (pending === latest) {
  console.log('  nothing is stuck')
  process.exit(0)
}

const gasPrice = parseGwei(process.env.GAS_GWEI ?? '2')
console.log(`  replacing nonce ${latest} at ${formatGwei(gasPrice)} gwei`)
const hash = await wallet.sendTransaction({
  to: account.address,
  value: 0n,
  gasPrice,
  nonce: latest,
  gas: 21_000n,
})
await pub.waitForTransactionReceipt({ hash, timeout: 180_000 })
console.log(`  replaced · ${hash}`)

// Now watch the rest. If they were only ever blocked by nonce order, they land on their own.
console.log('\n  watching the queue drain for ninety seconds...')
const deadline = Date.now() + 90_000
let seen = latest + 1
while (Date.now() < deadline) {
  const now = await pub.getTransactionCount({ address: account.address, blockTag: 'latest' })
  if (now > seen) {
    console.log(`  nonce ${seen}..${now - 1} confirmed`)
    seen = now
  }
  if (now >= pending) break
  await new Promise((r) => setTimeout(r, 5_000))
}

const finalLatest = await pub.getTransactionCount({ address: account.address, blockTag: 'latest' })
const finalPending = await pub.getTransactionCount({ address: account.address, blockTag: 'pending' })
console.log(`\n  nonce latest ${finalLatest} · pending ${finalPending}`)
console.log(
  finalLatest === finalPending
    ? '  the queue drained: the later transactions were blocked by order, not by price'
    : `  ${finalPending - finalLatest} still queued: those really are priced too low`,
)

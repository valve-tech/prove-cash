/**
 * What is the cheapest transaction chain 943 will actually mine?
 *
 *   DEPLOYER_PK=$TESTNET_DEPLOYER_PK npx tsx scripts/gas-probe.ts
 *
 * Sends the same tiny transfer at a ladder of gas prices, each from its own nonce, and waits to
 * see which ones land. Measuring beats guessing: a single mined block tells you what somebody
 * chose to pay, not what the node requires.
 */
import { createPublicClient, createWalletClient, formatGwei, http, parseEther, parseGwei } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { pulsechainV4 } from 'viem/chains'
import { rpcUrl, describe, assertChainId } from './rpc.ts'

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

const ladder = (process.env.LADDER ?? '0.000000016,0.001,0.01,0.1,1').split(',')
const to = account.address // to itself: this probe should cost only gas

const block = await pub.getBlock()
console.log(`baseFeePerGas reported by the node: ${block.baseFeePerGas ?? 0n} wei`)
console.log(`eth_gasPrice: ${await pub.getGasPrice()} wei\n`)

let nonce = await pub.getTransactionCount({ address: account.address, blockTag: 'latest' })
const sent: { gwei: string; hash: `0x${string}` }[] = []

for (const gwei of ladder) {
  const gasPrice = parseGwei(gwei)
  try {
    const hash = await wallet.sendTransaction({
      to,
      value: parseEther('0.001'),
      gasPrice,
      nonce: nonce++,
      gas: 21_000n,
    })
    sent.push({ gwei, hash })
    console.log(`sent at ${formatGwei(gasPrice)} gwei (${gasPrice} wei) · ${hash.slice(0, 14)}…`)
  } catch (e) {
    console.log(`rejected at ${gwei} gwei by the node: ${describe(e)}`)
    nonce--
  }
}

console.log('\nwaiting up to two minutes to see which land...\n')
const deadline = Date.now() + 120_000
const landed = new Set<string>()

while (Date.now() < deadline && landed.size < sent.length) {
  for (const s of sent) {
    if (landed.has(s.hash)) continue
    const receipt = await pub.getTransactionReceipt({ hash: s.hash }).catch(() => null)
    if (receipt) {
      landed.add(s.hash)
      console.log(`  mined at ${s.gwei} gwei · block ${receipt.blockNumber}`)
    }
  }
  if (landed.size < sent.length) await new Promise((r) => setTimeout(r, 5_000))
}

console.log('')
for (const s of sent) {
  if (!landed.has(s.hash)) console.log(`  still pending at ${s.gwei} gwei`)
}
console.log(`\n${landed.size} of ${sent.length} landed.`)

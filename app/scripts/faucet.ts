/**
 * Ask the public PulseChain testnet faucet for gas, the way everyone else does.
 *
 *   npx tsx scripts/faucet.ts 0xYourAddress
 *   npx tsx scripts/faucet.ts 0xYourAddress --claims 5
 *
 * The faucet pays 10 PLS a claim. That is gas money, not capital: at 2 gwei a fill costs about
 * 0.0004 PLS, so one claim covers thousands of transactions. Size the tests to fit it.
 *
 * Do not reach past this into the faucet's wallet. Its payout account is a live service, and
 * spending from it directly both drains it and jams its nonce while your transaction is pending.
 */
import { createPublicClient, formatEther, http, isAddress } from 'viem'
import { pulsechainV4 } from 'viem/chains'
import { rpcUrl, assertChainId } from './rpc.ts'

const FAUCET = process.env.FAUCET ?? 'https://faucet.v4.testnet.pulsechain.com'
const RPC = rpcUrl(943)

const address = process.argv[2]
if (!address || !isAddress(address)) throw new Error('usage: faucet.ts 0xAddress [--claims N]')

const ci = process.argv.indexOf('--claims')
const claims = ci >= 0 ? Number(process.argv[ci + 1]) : 1

const pub = createPublicClient({ chain: pulsechainV4, transport: http(RPC) })

// The node has to be on this chain. `RPC` replaces the whole URL while the chain id beside it
// stays put, so the two can silently disagree and every read comes back about somewhere else.
await assertChainId(pub, pulsechainV4.id)

const info = (await (await fetch(`${FAUCET}/api/info`)).json()) as {
  account: string
  network: string
  payout: string
}
console.log(`faucet ${info.account} on ${info.network} · pays ${formatEther(BigInt(info.payout))} PLS a claim`)

const before = await pub.getBalance({ address })
console.log(`${address} holds ${formatEther(before)} PLS`)

for (let n = 0; n < claims; n++) {
  const body = new FormData()
  body.append('address', address)
  const res = await fetch(`${FAUCET}/api/claim`, { method: 'POST', body })
  const text = (await res.text()).trim()
  console.log(`  claim ${n + 1}/${claims}: ${res.ok ? 'ok' : 'refused'} · ${text}`)
  if (!res.ok) break
  if (n + 1 < claims) await new Promise((r) => setTimeout(r, 2_000))
}

// The faucet answers before the transaction lands, so wait for the balance to move.
const deadline = Date.now() + 90_000
let after = before
while (Date.now() < deadline && after === before) {
  await new Promise((r) => setTimeout(r, 3_000))
  after = await pub.getBalance({ address })
}

console.log(
  after > before
    ? `received ${formatEther(after - before)} PLS · balance ${formatEther(after)}`
    : 'nothing arrived within ninety seconds',
)

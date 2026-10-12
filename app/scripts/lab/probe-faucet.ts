/**
 * What the 943 test tokens will hand out, and to whom.
 *
 *   VALVE_RPC_KEY=… DEPLOYER_PK=… npx tsx scripts/lab/probe-faucet.ts
 *
 * Seeding a pool needs tokens, and `FaucetToken` has two ways to produce them: `claim`, which is
 * permissionless behind a cooldown, and `mint`, which is owner-only. Which one is available
 * decides whether seeding a pair is a script or an owner errand, and the answer is per token.
 *
 * Reads only.
 */
import { formatUnits, type Address } from 'viem'
import { readFileSync } from 'node:fs'
import { CHAIN, funder, log, pub } from '../e2e/common.ts'

const FAUCET_ABI = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'claimAmount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'claimCooldown', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  {
    type: 'function',
    name: 'nextClaimAt',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint64' }],
  },
] as const

const deployed = JSON.parse(
  readFileSync('../contracts/config/deployed.943.json', 'utf8'),
) as Record<string, Address>

const now = (await pub.getBlock({ blockTag: 'latest' })).timestamp
log(`chain ${CHAIN} · deployer ${funder.address}`)
log('')
for (const [symbol, address] of Object.entries(deployed)) {
  const call = <T>(name: string, args: readonly unknown[] = []) =>
    pub.readContract({ address, abi: FAUCET_ABI, functionName: name as never, args: args as never }) as Promise<T>
  const [owner, amount, cooldown, dec, supply, readyAt] = await Promise.all([
    call<Address>('owner'),
    call<bigint>('claimAmount'),
    call<bigint>('claimCooldown'),
    call<number>('decimals'),
    call<bigint>('totalSupply'),
    call<bigint>('nextClaimAt', [funder.address]),
  ])
  const ours = owner.toLowerCase() === funder.address.toLowerCase()
  const wait = readyAt > now ? `${readyAt - now}s` : 'now'
  log(
    `${symbol.padEnd(6)} claim ${formatUnits(amount, dec)} every ${cooldown}s · ready ${wait} · ` +
      `supply ${formatUnits(supply, dec)} · owner ${ours ? 'US' : owner}`,
  )
}

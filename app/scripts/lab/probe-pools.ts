/**
 * What the xyk venue on this chain actually holds, and what the deployer has to seed it with.
 *
 *   VALVE_RPC_KEY=… DEPLOYER_PK=… npx tsx scripts/lab/probe-pools.ts
 *
 * A three-leg ring needs a triangle, and until now nothing said which edges of one exist. The
 * answer decides what #82 has to build, and it is the kind of question that must be measured
 * rather than assumed — `contracts/config/deployed.943.json` lists six tokens and says nothing
 * about which of them have pools.
 *
 * Reads only. Nothing here signs anything.
 */
import { erc20Abi, formatUnits, type Address } from 'viem'
import { readFileSync } from 'node:fs'
import { readVenues } from '@prove.cash/sdk/solver'
import { CHAIN, funder, log, pub } from '../e2e/common.ts'

const FACTORY_ABI = [
  {
    type: 'function',
    name: 'getPair',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'address' }],
  },
] as const

const PAIR_ABI = [
  {
    type: 'function',
    name: 'getReserves',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }],
  },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const

// The registry's own venues, confirmed against the chain — not the lab override in `common.ts`,
// which is set only when `PROVE_XYK_ROUTER` names one.
const venues = await readVenues({ client: pub, chainId: CHAIN })
if (venues.length === 0) throw new Error(`no xyk venue answers on chain ${CHAIN}`)

const deployed = JSON.parse(
  readFileSync('../contracts/config/deployed.943.json', 'utf8'),
) as Record<string, Address>

// WPLS is the bridge every test token was paired against in #80, so it belongs in the survey.
const WPLS = '0x70499adEBB11Efd915E3b69E700c331778628707' as Address
const symbols = [...Object.keys(deployed), 'WPLS']
const at: Record<string, Address> = { ...deployed, WPLS }

const decimals: Record<string, number> = {}
for (const s of symbols) {
  decimals[s] = await pub.readContract({
    address: at[s],
    abi: erc20Abi,
    functionName: 'decimals',
  })
}

log(`chain ${CHAIN} · ${venues.length} venue(s)`)
for (const v of venues) log(`  router ${v.router} · factory ${v.factory}`)
log('')
log('pairs that exist:')
let found = 0
for (let i = 0; i < symbols.length; i++) {
  for (let j = i + 1; j < symbols.length; j++) {
    const a = symbols[i]
    const b = symbols[j]
    let pair: Address = '0x0000000000000000000000000000000000000000'
    for (const v of venues) {
      pair = await pub.readContract({
        address: v.factory,
        abi: FACTORY_ABI,
        functionName: 'getPair',
        args: [at[a], at[b]],
      })
      if (pair !== '0x0000000000000000000000000000000000000000') break
    }
    if (pair === '0x0000000000000000000000000000000000000000') continue
    found++
    const [r0, r1] = await pub.readContract({
      address: pair,
      abi: PAIR_ABI,
      functionName: 'getReserves',
    })
    const t0 = await pub.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' })
    const [ra, rb] = t0.toLowerCase() === at[a].toLowerCase() ? [r0, r1] : [r1, r0]
    log(`  ${a}/${b}  ${formatUnits(ra, decimals[a])} ${a} · ${formatUnits(rb, decimals[b])} ${b}`)
  }
}
if (found === 0) log('  none')

log('')
log(`deployer ${funder.address}`)
log(`  PLS ${formatUnits(await pub.getBalance({ address: funder.address }), 18)}`)
for (const s of symbols) {
  const bal = await pub.readContract({
    address: at[s],
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [funder.address],
  })
  log(`  ${s} ${formatUnits(bal, decimals[s])}`)
}

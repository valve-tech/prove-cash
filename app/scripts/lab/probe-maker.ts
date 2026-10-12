/**
 * What the heartbeat's maker can actually honour.
 *
 *   VALVE_RPC_KEY=… DEPLOYER_PK=… npx tsx scripts/lab/probe-maker.ts 0xMaker
 *
 * The bot's own rule, from `MAX_IN`: "a cap the float cannot cover puts rows on the board that no
 * executor can fill, and an offer nobody can take is worse than no offer." Adding a market to the
 * bot's list does not add the tokens behind it, so this is the check that has to follow one.
 *
 * Reads only. It also reports the relayer allowance, because an offer on the approval rung is
 * unfillable without one however well funded the maker is.
 */
import { erc20Abi, formatUnits, type Address } from 'viem'
import { readFileSync } from 'node:fs'
import { CHAIN, RELAYER, log, pub } from '../e2e/common.ts'

const maker = process.argv[2] as Address | undefined
if (!maker) throw new Error('usage: probe-maker.ts 0xMakerAddress')

const deployed = JSON.parse(
  readFileSync('../contracts/config/deployed.943.json', 'utf8'),
) as Record<string, Address>

log(`chain ${CHAIN} · maker ${maker}`)
log(`  PLS ${formatUnits(await pub.getBalance({ address: maker }), 18)}`)
for (const [symbol, address] of Object.entries(deployed)) {
  const [bal, dec, allowance] = await Promise.all([
    pub.readContract({ address, abi: erc20Abi, functionName: 'balanceOf', args: [maker] }),
    pub.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    pub.readContract({
      address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [maker, RELAYER],
    }),
  ])
  const armed = allowance >= bal && bal > 0n ? 'approved' : allowance > 0n ? 'part-approved' : 'NOT approved'
  log(`  ${symbol.padEnd(6)} ${formatUnits(bal, dec).padStart(24)}  ${armed}`)
}

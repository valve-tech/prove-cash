/**
 * The SDK's stretch against a deployed `minOutAt`, at every corner and inside every region.
 *
 *   npx tsx scripts/lab/curve-onchain.ts
 *
 * The contracts fuzz `_stretchAt` and the SDK fuzzes its mirror, and both pass without ever
 * meeting. This is the one place the two implementations are compared against each other with a
 * real chain in between — the same question `Fixture.t.sol` answers for the digest, asked of the
 * curve. It reads only; it signs nothing and sends nothing.
 *
 * A stretch quantises to 1/65,535 of the window and the chain floors that through the span, so
 * the corners land up to a second before the fractions suggest. `breakpointsOf` is the authority
 * on where they are, and this script asks it rather than recomputing them.
 */
import { createPublicClient, http } from 'viem'
import {
  SETTLEMENT_ABI, ZERO, ZERO_HASH, CURVE_LINEAR, KIND_STRETCH,
  stretchCurve, breakpointsOf, minOutAt, toStruct, settlement as settlementOf,
  setChainId, type Intent,
} from '@prove.cash/sdk'

setChainId(943)
const RPC = 'https://one.valve.city/rpc/vk_demo/evm/943'
const pub = createPublicClient({ transport: http(RPC) })
const S = settlementOf(943)

const START = 1_800_000_000n
const SPAN = 3600n
const base = {
  maker: '0x0000000000000000000000000000000000000001',
  recipient: '0x0000000000000000000000000000000000000001',
  tokenIn: '0x0000000000000000000000000000000000000002',
  tokenOut: '0x0000000000000000000000000000000000000003',
  amountIn: 1_000_000000000000000000n,
  minOutStart: 500_000000000000000000n,
  minOutEnd: 400_000000000000000000n,
  startTime: START, endTime: START + SPAN,
  executor: ZERO, feeConfig: ZERO_HASH, feeRateIn: 0n, feeRate: 0n, feeRateProceeds: 0n, minFill: 0n,
  authNonce: ZERO_HASH, nonce: 1n,
} as const

// flat a quarter, dutch a quarter, flat a half
const curved: Intent = { ...base, flags: KIND_STRETCH, curve: stretchCurve(0.25, 0.25) }
const line: Intent = { ...base, flags: 0, curve: CURVE_LINEAR }

const onChain = (i: Intent, ts: bigint) =>
  pub.readContract({ address: S, abi: SETTLEMENT_ABI, functionName: 'minOutAt', args: [toStruct(i), ts] }) as Promise<bigint>

let bad = 0
const check = async (name: string, i: Intent, ts: bigint) => {
  const [chain, sdk] = [await onChain(i, ts), minOutAt(i, ts)]
  const ok = chain === sdk
  if (!ok) bad++
  console.log(`${ok ? '[ok]  ' : '[FAIL]'} ${name.padEnd(34)} chain ${chain}  sdk ${sdk}`)
}

async function main() {
  const knots = breakpointsOf(curved)
  console.log('breakpoints:', knots.map((k) => `${k - START}s`).join(', '), '\n')

  for (const [n, t] of [
    ['before the window', START - 1n], ['at the open', START],
    ['inside the top flat', START + 300n], ['at the first corner', knots[0]!],
    ['one second after the corner', knots[0]! + 1n], ['midway down the fall', START + 1350n],
    ['one second before the floor', knots[1]! - 1n], ['at the second corner', knots[1]!],
    ['inside the bottom flat', START + 2400n], ['at the close', START + SPAN],
    ['after the close', START + SPAN + 1n],
  ] as const) await check(n as string, curved, t as bigint)

  console.log('')
  for (const [n, t] of [['line at the open', START], ['line midway', START + 1800n], ['line at the close', START + SPAN]] as const)
    await check(n as string, line, t as bigint)

  console.log(bad === 0 ? '\nthe SDK and the chain agree at every point.' : `\n${bad} DISAGREEMENTS`)
  process.exit(bad === 0 ? 0 : 1)
}
main()

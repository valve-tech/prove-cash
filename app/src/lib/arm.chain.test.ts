import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Address, Hex } from 'viem'
import {
  CURVE_LINEAR,
  ZERO,
  ZERO_HASH,
  getChainId,
  memoryKeyValueStore,
  setChainId,
  setKeyValueStore,
  type Intent,
  defaultFees,
  hashFeeConfig,
} from '@prove.cash/sdk'

/**
 * Review 2026-09-30, H3: an RFQ flow must hold one chain from the first prompt to the last.
 *
 * The person switches network while the wallet's first prompt is open. Every later step of the
 * same submit must still go to the chain the intent was built for. `approveRelayer` and
 * `deposit` are replaced by recorders that note the chain they would address; `signIntent` is
 * the real one, over a fake EIP-1193 wallet that captures the typed-data domain.
 */

const MAKER = '0x1111111111111111111111111111111111111111' as Address
const HEX = '0x2b591e99afe9f32eaa6214f7b7629768c40eeb39' as Address

const chainAt: Record<string, number[]> = { approveRelayer: [], deposit: [] }
vi.mock('./settlement', () => ({
  // Each recorder takes its chain the way the real wrapper does: the argument, else the global.
  approveRelayer: async (_a: unknown, _t: unknown, _n: unknown, id: number = getChainId()) => {
    chainAt.approveRelayer.push(id)
    return '0xa1' as Hex
  },
  deposit: async (_a: unknown, _i: unknown, _n: unknown, id: number = getChainId()) => {
    chainAt.deposit.push(id)
    return '0xd1' as Hex
  },
}))
vi.mock('@prove.cash/sdk', async (orig) => ({
  ...(await orig<typeof import('@prove.cash/sdk')>()),
  waitForTx: async () => ({}),
}))

const { signAndArm } = await import('./arm')

/** The typed-data domains the wallet was asked to sign under, in order. */
let domains: { chainId: number; primaryType: string }[] = []
let walletChain = 943

/** A wallet that follows switch requests, and lets the app's network menu fire mid-prompt. */
function wallet(onSign: () => void) {
  return {
    request: async ({ method, params }: { method: string; params?: unknown[] }) => {
      if (method === 'eth_chainId') return `0x${walletChain.toString(16)}`
      if (method === 'wallet_switchEthereumChain') {
        walletChain = parseInt((params![0] as { chainId: string }).chainId, 16)
        return null
      }
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [MAKER]
      if (method === 'eth_signTypedData_v4') {
        const typed = JSON.parse(params![1] as string)
        domains.push({ chainId: Number(typed.domain.chainId), primaryType: typed.primaryType })
        onSign()
        return `0x${'11'.repeat(65)}`
      }
      throw new Error(`unexpected ${method}`)
    },
  }
}

const intent = (): Intent => ({
  maker: MAKER,
  recipient: MAKER,
  tokenIn: HEX,
  tokenOut: '0x3333333333333333333333333333333333333333',
  amountIn: 10n ** 8n,
  minOutStart: 1n,
  minOutEnd: 1n,
  curve: CURVE_LINEAR,
  startTime: 1_800_000_000n,
  endTime: 1_800_000_600n,
  executor: ZERO,
  // A wallet cannot sign a zero config, so the offer names the chain's default config at rate 0.
  feeConfig: hashFeeConfig(defaultFees(943).config),
  feeRateIn: 0n,
  feeRateProceeds: 0n,
  feeRate: 0n,
  minFill: 0n,
  authNonce: ZERO_HASH,
  flags: 2,
  nonce: 1n,
})

beforeEach(() => {
  setKeyValueStore(memoryKeyValueStore())
  setChainId(943)
  walletChain = 943
  domains = []
  chainAt.approveRelayer = []
  chainAt.deposit = []
})
afterEach(() => {
  vi.unstubAllGlobals()
  setChainId(943)
})

describe('H3: one chain per RFQ submit', () => {
  test('a network switch during the intent prompt does not move the approve or the deposit', async () => {
    // The person picks 369 in the network menu while the wallet shows the 943 intent.
    vi.stubGlobal('window', { ethereum: wallet(() => setChainId(369)) })
    await signAndArm({
      account: MAKER,
      intent: intent(),
      mode: 'escrow',
      live: true,
      needsApproval: true,
      fundsFrom: 1_800_000_000n,
      onPhase: () => {},
    })
    expect(domains).toEqual([{ chainId: 943, primaryType: 'Intent' }])
    // The intent was built and signed for 943, so its approval and deposit belong to 943.
    expect({ approve: chainAt.approveRelayer, deposit: chainAt.deposit }).toEqual({
      approve: [943],
      deposit: [943],
    })
  })

  test('App hands the RFQ surface the same onBusy lock that Compose holds', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const rfq = app.match(/<Rfq\b[^>]*\/>/s)?.[0] ?? ''
    expect(rfq).not.toBe('')
    expect(rfq).toMatch(/onBusy=/)
  })
})

import { keccak256, stringToHex } from 'viem'
import { describe, expect, test } from 'vitest'
import { NETWORKS } from '@prove.cash/sdk'
import { intentTypehash, settlementRefusal } from './deployment.ts'

/**
 * Both chains carry a deploy in the registry since mainnet went on (#52), so "the registry names
 * nothing" is staged by blanking one field for one test and putting it back. The code under test
 * reads the registry exactly as it does in production.
 */
async function withBlank369(key: 'deployedOn', value: unknown, fn: () => unknown): Promise<void> {
  const entry = NETWORKS[369] as unknown as Record<string, unknown>
  const was = entry[key]
  entry[key] = value
  try {
    await fn()
  } finally {
    entry[key] = was
  }
}

/**
 * A bot refuses to start against a settlement that hashes intents differently.
 *
 * The 369 units named the 2026-08-22 mainnet build, whose INTENT_TYPEHASH is 0x4b3e51b4…. The SDK
 * signs with 0xc1e92b74…. The override made settlementLive(369) true while deployedOn(369) stayed
 * null, so the deployed-ABI guard let every call through. The typehash is measured on chain, so
 * it is the check that matters.
 */

const OLD_369 = '0x595ec1C409F63b365ad9f21948E8B040EC5d60EE' as const
const OLD_TYPEHASH = '0x4b3e51b4' + '00'.repeat(28)

const answering = (value: string) => {
  const asked: unknown[] = []
  return {
    asked,
    client: {
      readContract: async (req: { functionName: string }) => {
        asked.push(req.functionName)
        return value
      },
    } as never,
  }
}

describe('intentTypehash', () => {
  test('is the one the current settlement carries', () => {
    expect(intentTypehash().slice(0, 10)).toBe('0xc1e92b74')
  })

  test('is the keccak of the canonical type string', () => {
    const s =
      'Intent(address maker,address recipient,address tokenIn,address tokenOut,uint256 amountIn,' +
      'uint256 minOutStart,uint256 minOutEnd,uint64 startTime,uint64 endTime,address executor,' +
      'FeeConfig feeConfig,uint64 feeRate,uint256 minFill,bytes32 authNonce,uint8 flags,uint256 nonce,' +
      'bytes32 curve,uint64 feeRateIn,uint64 feeRateProceeds)FeeConfig(address[] destinations,uint256[] weights)'
    expect(intentTypehash()).toBe(keccak256(stringToHex(s)))
  })
})

describe('settlementRefusal', () => {
  test('passes a settlement whose typehash matches, and it asked the chain', async () => {
    const { asked, client } = answering(intentTypehash())
    expect(await settlementRefusal(client, 943, OLD_369, false)).toBeNull()
    expect(asked).toEqual(['INTENT_TYPEHASH'])
  })

  test('refuses a settlement with another typehash, naming both values', async () => {
    const { client } = answering(OLD_TYPEHASH)
    const why = await settlementRefusal(client, 943, OLD_369, false)
    expect(why).toMatch(/INTENT_TYPEHASH/)
    expect(why).toContain(OLD_TYPEHASH)
    expect(why).toContain(intentTypehash())
  })

  test('refuses the typehash mismatch even with no override', async () => {
    const { client } = answering(OLD_TYPEHASH)
    expect(await settlementRefusal(client, 943, OLD_369, false)).not.toBeNull()
  })

  test('refuses when the typehash cannot be read at all', async () => {
    const client = {
      readContract: async () => {
        throw new Error('execution reverted')
      },
    } as never
    expect(await settlementRefusal(client, 943, OLD_369, false)).toMatch(/could not read/)
  })

  test('refuses an override on a chain the SDK records no deploy for', () =>
    withBlank369('deployedOn', null, async () => {
      const { client } = answering(intentTypehash())
      const why = await settlementRefusal(client, 369, OLD_369, true)
      expect(why).toMatch(/deployedOn/)
      expect(why).toMatch(/369/)
    }))

  test('lets the current 369 settlement start once the registry records the deploy', async () => {
    const { client } = answering(intentTypehash())
    expect(await settlementRefusal(client, 369, NETWORKS[369].settlement, true)).toBeNull()
  })

  test('the 369 units as they stand are refused on both counts', async () => {
    const { client } = answering(OLD_TYPEHASH)
    expect(await settlementRefusal(client, 369, OLD_369, true)).not.toBeNull()
  })

  test('leaves the zero address to each bot, and does not touch the chain', async () => {
    const { asked, client } = answering(OLD_TYPEHASH)
    expect(await settlementRefusal(client, 943, `0x${'0'.repeat(40)}`, false)).toBeNull()
    expect(asked).toEqual([])
  })
})

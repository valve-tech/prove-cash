import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Hex } from 'viem'

/**
 * A network switch while an offer grinds must not move the offer.
 *
 * The form reads the chain once, when the maker presses sign. The post and the local record
 * both use that chain, whatever the header says by the time the grind ends.
 */
vi.mock('@prove.cash/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@prove.cash/sdk')>()),
  board: vi.fn((url: string) => ({ url })),
  getRpc: vi.fn((id?: number) => `https://board-${id ?? 'current'}.test`),
  postToBoard: vi.fn(async () => '0xabc' as Hex),
  remember: vi.fn(),
}))

import * as sdk from '@prove.cash/sdk'
import { boardClient, publish, postToBoard } from './board'

const DATA = '0x01' as Hex

describe('board posts go to the chain the caller names', () => {
  beforeEach(() => vi.clearAllMocks())

  it('postToBoard reads the board endpoint of the named chain', async () => {
    await postToBoard(DATA, undefined, undefined, 943)
    expect(sdk.getRpc).toHaveBeenCalledWith(943)
    expect(sdk.postToBoard).toHaveBeenCalledWith(DATA, { url: 'https://board-943.test' })
  })

  it('boardClient reads the board endpoint of the named chain', () => {
    boardClient(undefined, undefined, 369)
    expect(sdk.getRpc).toHaveBeenCalledWith(369)
  })

  it('publish posts and remembers under the chain captured at the start', async () => {
    const hash = await publish(943, DATA)
    expect(hash).toBe('0xabc')
    expect(sdk.getRpc).toHaveBeenCalledWith(943)
    expect(sdk.remember).toHaveBeenCalledWith(943, DATA)
  })

  it('publish remembers nothing when the post fails', async () => {
    vi.mocked(sdk.postToBoard).mockRejectedValueOnce(new Error('refused'))
    await expect(publish(943, DATA)).rejects.toThrow('refused')
    expect(sdk.remember).not.toHaveBeenCalled()
  })
})

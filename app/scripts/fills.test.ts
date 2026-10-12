import { readFileSync } from 'node:fs'
import { encodeAbiParameters, type Address, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  checkFill,
  inventoryTrusts,
  landedOrThrow,
  revertReason,
  routeLabel,
  SKIPS,
  trustedInventory,
  type Replayer,
} from './fills.ts'

const HASH = `0x${'ab'.repeat(32)}` as Hex
const OWED = 1_000n

const TOKEN = '0x86390129000000000000000000000000000000a1' as Address
const OTHER_TOKEN = '0x00000000000000000000000000000000000000a2' as Address
const MAKER = '0xfc9d26dd5fec77fb057e32939456e53cf488728f' as Address
const FILLER = '0x00000000000000000000000000000000000000f1' as Address
const STRANGER = '0x00000000000000000000000000000000000000f2' as Address
const COLLECTOR = '0x00000000000000000000000000000000000000f3' as Address
const FILL = { token: TOKEN, recipient: MAKER, payer: FILLER }

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex
const topic = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, '0')}` as Hex
/** An ERC-20 `Transfer` log, as a receipt carries it. */
const transfer = (from: Address, to: Address, value: bigint, token: Address = TOKEN) => ({
  address: token,
  topics: [TRANSFER, topic(from), topic(to)] as [Hex, ...Hex[]],
  data: encodeAbiParameters([{ type: 'uint256' }], [value]),
})

/**
 * Reads that record what they were asked, so a test can say which method ran. `balances` maps a
 * block number to the maker's balance at the end of that block.
 */
const reads = (balances: Record<string, bigint> = {}) => {
  const asked = { balanceAt: [] as bigint[], owedAt: 0 }
  return {
    asked,
    read: {
      balanceAt: async (blockNumber: bigint) => {
        asked.balanceAt.push(blockNumber)
        const b = balances[String(blockNumber)]
        if (b === undefined) throw new Error(`no balance at block ${blockNumber}`)
        return b
      },
      owedAt: async () => {
        asked.owedAt++
        return OWED
      },
    },
  }
}

const landed = (logs: ReturnType<typeof transfer>[]) => ({
  status: 'success' as const,
  blockNumber: 9n,
  gasUsed: 1n,
  logs,
})

describe('checkFill', () => {
  it('reads a reverted fill as a revert, not as a maker short-changed by the whole debt', async () => {
    // C6. The balance did not move, because nothing moved. Without the status check this
    // compared 0 against 1,000, logged ALERT and exited 2, and systemd restarted the bot into
    // the same fill.
    const { asked, read } = reads({ 8: 500n, 9: 500n })
    const result = await checkFill(
      { status: 'reverted', blockNumber: 9n, gasUsed: 21_000n, logs: [] },
      FILL,
      read,
    )
    expect(result).toEqual({ kind: 'reverted', blockNumber: 9n, gasUsed: 21_000n })
    // And it never asked: a revert has no delivery to price.
    expect(asked).toEqual({ balanceAt: [], owedAt: 0 })
  })

  it('does not alarm when the maker also moved the token outside the fill (testnet, 2026-09-23)', async () => {
    // Tx 0x26bae407…: the receipt paid the maker exactly 10,272,716, and the old check read
    // 10,270,566 off the balance at `latest`, because the maker's balance also moved outside
    // the fill. Here the maker spends 5,000 and receives 300 in other transactions of the same
    // block. The receipt alone says what the fill delivered, and no balance is read.
    const { asked, read } = reads({ 8: 500n, 9: 500n + OWED - 5_000n + 300n })
    const result = await checkFill(landed([transfer(FILLER, MAKER, OWED)]), FILL, read)
    expect(result).toEqual({
      kind: 'paid',
      received: OWED,
      owed: OWED,
      gasUsed: 1n,
      method: 'transfer-logs',
    })
    expect(asked.balanceAt).toEqual([])
  })

  it('counts only this token, and only transfers to the recipient', async () => {
    // The same receipt moves the maker's own tokenOut out, pays a stranger, and moves another
    // token to the maker. None of those is a delivery of tokenOut to the maker.
    const { read } = reads()
    const result = await checkFill(
      landed([
        transfer(MAKER, STRANGER, 7_777n),
        transfer(FILLER, STRANGER, 9_999n),
        transfer(FILLER, MAKER, 50_000n, OTHER_TOKEN),
        transfer(FILLER, MAKER, OWED),
      ]),
      FILL,
      read,
    )
    expect(result).toMatchObject({ kind: 'paid', received: OWED, method: 'transfer-logs' })
  })

  it('still raises the alarm on a fill that landed and paid the maker less than owed', async () => {
    // The balance rose by far more than the debt, from elsewhere in the block. That must not
    // hide a real shortfall in the receipt.
    const { read } = reads({ 8: 500n, 9: 500n + 10n * OWED })
    const result = await checkFill(landed([transfer(FILLER, MAKER, OWED - 1n)]), FILL, read)
    expect(result).toEqual({
      kind: 'short-changed',
      received: OWED - 1n,
      owed: OWED,
      gasUsed: 1n,
      method: 'transfer-logs',
    })
  })

  it('passes a fill that landed and paid the maker exactly what the chain owed', async () => {
    const { read } = reads()
    const result = await checkFill(landed([transfer(FILLER, MAKER, OWED)]), FILL, read)
    expect(result.kind).toBe('paid')
  })

  it('adds up two deliveries of the same token to the same recipient', async () => {
    const { read } = reads()
    const result = await checkFill(
      landed([transfer(FILLER, MAKER, OWED / 2n), transfer(FILLER, MAKER, OWED / 2n)]),
      FILL,
      read,
    )
    expect(result).toMatchObject({ kind: 'paid', received: OWED })
  })

  it('reads a fee-on-transfer token as what reached the recipient, not what the filler sent', async () => {
    // A fee-on-transfer token splits one send into two `Transfer`s: the net to the recipient
    // and the cut to the token's collector. "Received" is the net. The filler sent OWED, the
    // maker got OWED less the cut, so this maker was short-changed.
    const cut = 20n
    const { read } = reads()
    const short = await checkFill(
      landed([transfer(FILLER, MAKER, OWED - cut), transfer(FILLER, COLLECTOR, cut)]),
      FILL,
      read,
    )
    expect(short).toMatchObject({ kind: 'short-changed', received: OWED - cut, owed: OWED })

    // A send grossed up so that the net covers the debt paid the maker in full.
    const paid = await checkFill(
      landed([transfer(FILLER, MAKER, OWED), transfer(FILLER, COLLECTOR, cut)]),
      FILL,
      read,
    )
    expect(paid).toMatchObject({ kind: 'paid', received: OWED })
  })

  it('falls back to balances pinned to the landing block when the token emits no Transfer', async () => {
    // A non-standard token: the fill landed and the receipt holds no `Transfer` of it. The
    // balance at the end of block 8 against the end of block 9, never `latest`.
    const { asked, read } = reads({ 8: 500n, 9: 500n + OWED })
    const result = await checkFill(landed([transfer(FILLER, MAKER, 50_000n, OTHER_TOKEN)]), FILL, read)
    expect(result).toEqual({ kind: 'paid', received: OWED, owed: OWED, gasUsed: 1n, method: 'balance' })
    expect([...asked.balanceAt].sort()).toEqual([8n, 9n])
  })

  it('still alarms on a real shortfall through the balance fallback', async () => {
    const { read } = reads({ 8: 500n, 9: 500n + OWED - 1n })
    const result = await checkFill(landed([]), FILL, read)
    expect(result).toMatchObject({ kind: 'short-changed', received: OWED - 1n, method: 'balance' })
  })

  it('counts only Transfers the filler sent, so a stranger cannot mask a short pay', async () => {
    // The fill pays the maker short. In the same receipt a second fill, or a token that emits a
    // fake event, logs a Transfer of the same token to the maker from somebody else. That is not
    // this fill's delivery, and it must not cover the shortfall.
    const { read } = reads()
    const result = await checkFill(
      landed([transfer(FILLER, MAKER, OWED - 1n), transfer(STRANGER, MAKER, 10n * OWED)]),
      FILL,
      read,
    )
    expect(result).toMatchObject({ kind: 'short-changed', received: OWED - 1n, method: 'transfer-logs' })
  })

  it('reads a receipt with Transfers of the token but none from the filler as nothing delivered', async () => {
    const { read } = reads({ 8: 0n, 9: 10n * OWED })
    const result = await checkFill(landed([transfer(STRANGER, MAKER, 10n * OWED)]), FILL, read)
    expect(result).toMatchObject({ kind: 'short-changed', received: 0n, method: 'transfer-logs' })
  })

  it('counts a reverted fill as a skip reason of its own', () => {
    expect(SKIPS).toContain('reverted')
  })
})

describe('inventory trust', () => {
  const LISTED = '0x00000000000000000000000000000000000000c1' as Address
  const FAKE = '0x00000000000000000000000000000000000000c2' as Address
  const EXTRA = '0x00000000000000000000000000000000000000C3' as Address

  it("trusts the chain's listed tokens, in any letter case", () => {
    const trusted = trustedInventory([{ address: LISTED }], [])
    expect(inventoryTrusts(LISTED.toUpperCase().replace('0X', '0x') as Address, trusted)).toBe(true)
  })

  it('refuses a token nobody listed, so a fake tokenIn cannot buy the float', () => {
    // A maker lists a worthless token they minted and asks for real tUSDC. The inventory path
    // pays tUSDC out of this wallet and takes the fake in. Nothing sells it, so it is a gift.
    const trusted = trustedInventory([{ address: LISTED }], [])
    expect(inventoryTrusts(FAKE, trusted)).toBe(false)
  })

  it('trusts a token the operator names on the command line', () => {
    const trusted = trustedInventory([{ address: LISTED }], [EXTRA])
    expect(inventoryTrusts(EXTRA.toLowerCase() as Address, trusted)).toBe(true)
  })

  it('counts an untrusted tokenIn as a skip reason of its own', () => {
    expect(SKIPS).toContain('untrusted')
  })
})

describe('revertReason', () => {
  const tx = {
    from: '0x00000000000000000000000000000000000000e0' as Address,
    to: '0x00000000000000000000000000000000000000ee' as Address,
    input: '0x1234' as Hex,
    value: 0n,
    gas: 500_000n,
  }
  /** `Error(string)`, as a router reverts with it. */
  const errorString = (text: string): Hex =>
    `0x08c379a0${encodeAbiParameters([{ type: 'string' }], [text]).slice(2)}` as Hex

  it('names the router revert that a moved pool causes', async () => {
    const client: Replayer = {
      getTransaction: async () => tx,
      call: async () => {
        throw Object.assign(new Error('execution reverted'), {
          data: errorString('PulseXRouter: INSUFFICIENT_OUTPUT_AMOUNT'),
        })
      },
    }
    const why = await revertReason(client, HASH, 42n)
    expect(why).toContain('INSUFFICIENT_OUTPUT_AMOUNT')
    expect(why).toContain('block 42')
  })

  it('replays against the block the fill landed in', async () => {
    let at: bigint | null = null
    const client: Replayer = {
      getTransaction: async () => tx,
      call: async (a) => {
        at = a.blockNumber
        return '0x'
      },
    }
    expect(await revertReason(client, HASH, 77n)).toMatch(/not decodable.*ran clean/)
    expect(at).toBe(77n)
  })

  it('never throws, and keeps a key in a URL out of the line', async () => {
    const client: Replayer = {
      getTransaction: async () => {
        throw new Error('HTTP request failed. URL: https://one.valve.city/rpc/sekritkey123/evm/943')
      },
      call: async () => '0x',
    }
    const why = await revertReason(client, HASH, 1n)
    expect(why).toMatch(/not decodable/)
    expect(why).not.toContain('sekritkey123')
  })
})

describe('routeLabel', () => {
  const A = '0x00000000000000000000000000000000000000aa' as Address
  const B = '0x00000000000000000000000000000000000000bb' as Address
  const C = '0x00000000000000000000000000000000000000cc' as Address
  const WPLS = '0x00000000000000000000000000000000000000ff' as Address

  it('calls a two-token path direct', () => {
    expect(routeLabel([A, B], WPLS)).toBe('direct')
  })

  it('calls a hop through WPLS wpls, in any letter case', () => {
    expect(routeLabel([A, WPLS.toUpperCase().replace('0X', '0x') as Address, B], WPLS)).toBe('wpls')
  })

  it('does not call a three-hop path wpls, even when WPLS is on it (C13)', () => {
    // `tWBTC -> tUSDC -> WPLS -> tDAI` is three swaps. The old label called it `wpls`.
    expect(routeLabel([A, C, WPLS, B], WPLS)).toBe('multi-hop')
  })

  it('does not call a one-hop path through another token wpls', () => {
    expect(routeLabel([A, C, B], WPLS)).toBe('multi-hop')
  })

  it('does not guess when the chain has no WPLS', () => {
    expect(routeLabel([A, C, B], null)).toBe('multi-hop')
  })
})

describe('landedOrThrow', () => {
  it('passes a receipt that landed, and throws on one the block reverted', () => {
    const ok = { status: 'success' as const }
    expect(landedOrThrow(ok, 'approval', HASH)).toBe(ok)
    expect(() => landedOrThrow({ status: 'reverted' as const }, 'approval', HASH)).toThrow(
      /approval reverted/,
    )
  })
})

/**
 * The executor is a script and cannot be imported, so these read its source.
 *
 * They hold the two rules that no unit above can reach: every exit from a fill path names a skip
 * reason, and every receipt the bot waits for is read for its status.
 */
describe('executor.ts', () => {
  const source = readFileSync(new URL('./executor.ts', import.meta.url), 'utf8')
  const body = (name: string) => {
    const start = source.indexOf(`async function ${name}(`)
    expect(start).toBeGreaterThan(-1)
    const next = source.indexOf('\n}\n', start)
    return source.slice(start, next)
  }

  it('leaves neither fill path without a skip reason (C7)', () => {
    for (const name of ['zeroInventoryFill', 'inventoryFill']) {
      const text = body(name)
      // A bare `return null` is an exit the pass line never counts.
      expect(text, name).not.toMatch(/return null\b/)
      expect(text, name).toMatch(/Promise<Attempt \| Skip>/)
    }
  })

  it('checks the tokenIn before the inventory path spends anything', () => {
    const text = body('tick')
    const gate = text.indexOf('inventoryTrusts(intent.tokenIn')
    const fill = text.indexOf('inventoryFill(intent')
    expect(gate).toBeGreaterThan(-1)
    expect(gate).toBeLessThan(fill)
  })

  it("names the payer, so checkFill counts only this fill's Transfers", () => {
    expect(source).toMatch(/const paid = \{[^}]*payer:/)
  })

  it('prices against the chain clock, not Date.now()', () => {
    expect(body('tick')).not.toMatch(/Date\.now\(\)/)
    expect(body('zeroInventoryFill')).not.toMatch(/Date\.now\(\)/)
  })

  it('stops sending behind a nonce gap, as the solver does', () => {
    const text = body('tick')
    const gap = text.indexOf('nonceGap()')
    expect(gap).toBeGreaterThan(-1)
    expect(gap).toBeLessThan(text.indexOf('attempt.send()'))
  })

  it('reads the status of every receipt it waits for (C6)', () => {
    const waits = source.split('waitForTransactionReceipt(').length - 1
    const checked =
      (source.match(/landedOrThrow\(\s*(await\s+)?client\.waitForTransactionReceipt\(/g) ?? []).length +
      (source.match(/checkFill\(receipt,/g) ?? []).length
    expect(waits).toBeGreaterThan(0)
    expect(checked).toBe(waits)
  })
})

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Address, Hex } from 'viem'
import { describe, expect, it } from 'vitest'
import type { SignedIntent } from '@prove.cash/sdk'
import {
  createWatch,
  loadLastBlock,
  retiredSettlements,
  retiredBy,
  saveLastBlock,
  type FilledLog,
  type WatchDeps,
} from './watchdog-checks.ts'
import record943 from '../../contracts/deployments/943.json' with { type: 'json' }

/**
 * Each watchdog check must be able to fail. A check that cannot fail reads as coverage and is
 * worse than none, so every test here feeds one bad input and expects a BROKEN alert.
 */

const SETTLEMENT = '0x00000000000000000000000000000000000000e1' as Address
const OWN = '0x00000000000000000000000000000000000000a1' as Address
const STRANGER = '0x00000000000000000000000000000000000000b2' as Address
const RETIRED = '0x00000000000000000000000000000000000000e0' as Address
const OLDER = '0x00000000000000000000000000000000000000df' as Address

const intentOf = (maker: Address, o: Partial<SignedIntent> = {}): SignedIntent =>
  ({
    maker,
    recipient: maker,
    tokenIn: '0x00000000000000000000000000000000000000c1',
    tokenOut: '0x00000000000000000000000000000000000000c2',
    amountIn: 1_000n,
    minOutStart: 1_000n,
    minOutEnd: 1_000n,
    startTime: 100n,
    endTime: 200n,
    nonce: 1n,
    flags: 0,
    feeRate: 0n,
    feeRateIn: 0n,
    feeRateProceeds: 0n,
    feeConfig: '0x0000000000000000000000000000000000000000000000000000000000000000',
    executor: '0x0000000000000000000000000000000000000000',
    signature: '0x',
    ...o,
  }) as unknown as SignedIntent

/** A message whose data is its own hash, so `decode` can look it up. */
const msg = (hash: string) => ({ hash: hash as Hex, data: hash as Hex })

function harness(o: Partial<WatchDeps> & { intents?: Record<string, SignedIntent | null> } = {}) {
  const alerts: { level: string; what: string; detail: unknown }[] = []
  const logs: string[] = []
  const intents = o.intents ?? {}
  const deps: WatchDeps = {
    settlement: SETTLEMENT,
    own: new Set([OWN.toLowerCase()]),
    alert: async (level, what, detail = {}) => {
      alerts.push({ level, what, detail })
    },
    log: (m) => logs.push(m),
    decode: (data) => intents[data] ?? null,
    verify: async () => true,
    fillability: async () => 'Fillable',
    retired: [OLDER, RETIRED],
    verifyFor: async () => false,
    retiredBy: 1_000n,
    chainNow: async () => 150n,
    hashIntent: async (i) => `0x${i.nonce.toString(16).padStart(64, '0')}` as Hex,
    status: async () => ({ enabled: true, workMultiplier: '1', workDivisor: '1', count: '0' }),
    archiveHashes: async () => new Set(),
    fillLogs: async () => [],
    blockTime: async () => 150n,
    archiveGraceMs: 1_000,
    nowMs: () => 0,
    ...o,
  }
  return { watch: createWatch(deps), alerts, logs, broken: () => alerts.some((a) => a.level === 'BROKEN') }
}

describe('checkBoard', () => {
  it('is BROKEN when the board reports disabled', async () => {
    const h = harness({ status: async () => ({ enabled: false, workMultiplier: '1', workDivisor: '1', count: '0' }) })
    expect(await h.watch.checkBoard()).toBeNull()
    expect(h.broken()).toBe(true)
  })

  it('is BROKEN when the difficulty factors are zero', async () => {
    const h = harness({ status: async () => ({ enabled: true, workMultiplier: '0', workDivisor: '1', count: '0' }) })
    await h.watch.checkBoard()
    expect(h.broken()).toBe(true)
  })
})

describe('checkMessages', () => {
  it('is BROKEN when one of our own makers carries a bad signature', async () => {
    const h = harness({ intents: { '0x01': intentOf(OWN) }, verify: async () => false })
    await h.watch.checkMessages([msg('0x01')])
    expect(h.broken()).toBe(true)
  })

  it('only warns for a stranger, so anybody posting garbage cannot stop the watchdog', async () => {
    const h = harness({ intents: { '0x01': intentOf(STRANGER) }, verify: async () => false })
    await h.watch.checkMessages([msg('0x01')])
    expect(h.broken()).toBe(false)
    expect(h.alerts.map((a) => a.level)).toContain('WARN')
  })
})

describe('checkTerms', () => {
  it('is BROKEN when the chain refuses our own terms outright', async () => {
    const h = harness({ intents: { '0x01': intentOf(OWN) }, fillability: async () => 'BadTerms' })
    await h.watch.checkTerms([msg('0x01')])
    expect(h.broken()).toBe(true)
  })

  it("only warns when the refused terms are a stranger's", async () => {
    const h = harness({ intents: { '0x01': intentOf(STRANGER) }, fillability: async () => 'BadTerms' })
    await h.watch.checkTerms([msg('0x01')])
    expect(h.broken()).toBe(false)
    expect(h.alerts.map((a) => a.level)).toContain('WARN')
  })

  it('warns when it could not ask the chain, rather than going quiet', async () => {
    const h = harness({
      intents: { '0x01': intentOf(OWN) },
      fillability: async () => {
        throw new Error('rpc down')
      },
    })
    await h.watch.checkTerms([msg('0x01')])
    expect(h.alerts.map((a) => a.level)).toEqual(['WARN'])
  })
})

/**
 * After a redeploy, our own makers' last intents stay on the board, signed for the settlement that
 * was just retired. On 2026-09-29 each one raised BROKEN, and the watchdog restarted 31 times in an
 * hour. A signature for a retired domain is a WARN while the intent could still be one of those
 * leftovers, and BROKEN when it could not be.
 */
describe('a signature for a retired settlement', () => {
  /** `verifyFor` that accepts only the one settlement given, and records every settlement it was asked about. */
  const signedFor = (addr: Address, asked: Address[] = []) => async (_i: SignedIntent, s: Address) => {
    asked.push(s)
    return s === addr
  }

  it('leaves a row signed for the current settlement alone, and still counts its refused terms', async () => {
    const h = harness({
      intents: { '0x01': intentOf(OWN, { startTime: 100n }), '0x02': intentOf(OWN, { startTime: 101n }) },
      verify: async (i) => i.startTime === 100n,
      verifyFor: signedFor(RETIRED),
      fillability: async () => 'BadTerms',
    })
    const board = [msg('0x01'), msg('0x02')]
    await h.watch.checkMessages(board)
    await h.watch.checkTerms(board)
    const refused = h.alerts.find((a) => a.level === 'BROKEN')
    expect(refused?.what).toMatch(/refuses our own terms/)
    expect((refused as { detail: { refused: number } }).detail.refused).toBe(1)
  })

  it('is a WARN naming the retired settlement and the expiry, and is not our terms refused', async () => {
    const h = harness({
      intents: { '0x01': intentOf(OWN, { startTime: 100n, endTime: 200n }) },
      verify: async () => false,
      verifyFor: signedFor(RETIRED),
      fillability: async () => 'BadTerms',
    })
    await h.watch.checkMessages([msg('0x01')])
    await h.watch.checkTerms([msg('0x01')])
    expect(h.broken()).toBe(false)
    const warn = h.alerts.find((a) => /retired settlement/.test(a.what))
    expect(warn?.level).toBe('WARN')
    expect(warn?.what).toContain(RETIRED)
    expect(warn?.what).toContain('200')
  })

  it('is BROKEN when the signature fits no known domain, after asking every retired settlement', async () => {
    const asked: Address[] = []
    const h = harness({
      intents: { '0x01': intentOf(OWN) },
      verify: async () => false,
      verifyFor: signedFor(STRANGER, asked),
    })
    await h.watch.checkMessages([msg('0x01')])
    expect(h.broken()).toBe(true)
    expect(asked).toEqual([OLDER, RETIRED])
  })

  it('stays a WARN while the board may still hold the row after its endTime', async () => {
    const h = harness({
      intents: { '0x01': intentOf(OWN, { startTime: 100n, endTime: 200n }) },
      verify: async () => false,
      verifyFor: signedFor(RETIRED),
      chainNow: async () => 200n + 1_200n,
    })
    await h.watch.checkMessages([msg('0x01')])
    expect(h.alerts.map((a) => a.level)).toEqual(['WARN'])
    expect(h.alerts[0].what).toMatch(/retired settlement/)
  })

  it('is BROKEN when the row is still on the board past its endTime and the board\'s hold', async () => {
    const h = harness({
      intents: { '0x01': intentOf(OWN, { startTime: 100n, endTime: 200n }) },
      verify: async () => false,
      verifyFor: signedFor(RETIRED),
      chainNow: async () => 200n + 1_201n,
    })
    await h.watch.checkMessages([msg('0x01')])
    expect(h.alerts.find((a) => a.level === 'BROKEN')?.what).toMatch(/retired settlement .* past its lifetime/)
  })

  it('is BROKEN when the window is longer than the heartbeat ever signs', async () => {
    const h = harness({
      intents: { '0x01': intentOf(OWN, { startTime: 100n, endTime: 100n + 3_601n }) },
      verify: async () => false,
      verifyFor: signedFor(RETIRED),
    })
    await h.watch.checkMessages([msg('0x01')])
    expect(h.alerts.find((a) => a.level === 'BROKEN')?.what).toMatch(/retired settlement .* past its lifetime/)
  })

  it('is BROKEN when it was signed after the redeploy, because a bot kept signing for the old contract', async () => {
    const h = harness({
      intents: { '0x01': intentOf(OWN, { startTime: 1_001n, endTime: 1_100n }) },
      verify: async () => false,
      verifyFor: signedFor(RETIRED),
      chainNow: async () => 1_050n,
    })
    await h.watch.checkMessages([msg('0x01')])
    expect(h.alerts.find((a) => a.level === 'BROKEN')?.what).toMatch(/retired settlement .* past its lifetime/)
  })
})

describe('the retired settlements on record', () => {
  it('reads every retired 943 settlement from the deployment record, and not the live one', () => {
    const got = retiredSettlements(record943)
    expect(got.map((a) => a.toLowerCase())).toEqual(
      [
        '0xdb3843eFa19C06cA77e16c082BF33f7D4Dd1b8FC',
        '0x5AF7aC9fD1C038247c7FE3979DFA4A632C359767',
        '0xc172e58B3A60D66d5D8E73a2d6f5b5D9EAE09Da9',
        '0xe5f4F27219d56A4C38A480Ff1915f435B6cF5Ca2',
        '0x79B09eDf293f9ee7E1bb6067a29625B3e2a4861C',
      ].map((a) => a.toLowerCase()),
    )
    expect(got.map((a) => a.toLowerCase())).not.toContain(record943.contracts.ProveSettlement.toLowerCase())
  })

  // The doc also lists the 2026-09-01 set, which `_superseded` does not name: its intents expired
  // weeks before the record started keeping the chain of sets.
  it('names only settlements the "Retired on 943" table in ADDRESSES.md names', () => {
    const doc = readFileSync(new URL('../../docs/ADDRESSES.md', import.meta.url), 'utf8')
    const section = doc.split('### Retired on 943')[1].split('\n## ')[0].split('\n### ')[0]
    const inDoc = [...section.matchAll(/\| `ProveSettlement` \| `(0x[0-9a-fA-F]{40})`/g)].map((m) => m[1].toLowerCase())
    expect(inDoc.length).toBeGreaterThan(0)
    for (const a of retiredSettlements(record943)) expect(inDoc).toContain(a.toLowerCase())
  })

  it('takes the end of the deploy day as the last moment a retired signature could start', () => {
    expect(retiredBy({ deployedAt: '2026-09-29' })).toBe(BigInt(Date.UTC(2026, 8, 30) / 1000))
    expect(retiredBy({})).toBeNull()
  })
})

describe('checkArchive', () => {
  it('is BROKEN when the archive misses a message past the grace period', async () => {
    let now = 0
    const h = harness({ nowMs: () => now, archiveHashes: async () => new Set() })
    await h.watch.checkMessages([msg('0x01')])
    now = 5_000
    await h.watch.checkArchive(['0x01'])
    expect(h.broken()).toBe(true)
  })

  it('warns, and does not break, when the archive is unreachable', async () => {
    const h = harness({ archiveHashes: async () => null })
    await h.watch.checkArchive(['0x01'])
    expect(h.alerts.map((a) => a.level)).toEqual(['WARN'])
  })
})

describe('checkFills', () => {
  const intent = intentOf(OWN, { nonce: 7n })
  const hash = `0x${(7).toString(16).padStart(64, '0')}` as Hex
  const filled = (h: Hex, delivered: bigint): FilledLog => ({
    blockNumber: 10n,
    transactionHash: '0xfeed',
    intentHash: h,
    take: 1_000n,
    delivered,
  })

  it('is BROKEN when a fill paid the maker less than the signed rate', async () => {
    const h = harness({ intents: { '0x01': intent }, fillLogs: async () => [filled(hash, 999n)] })
    await h.watch.rememberIntents([msg('0x01')])
    await h.watch.checkFills(1n, 10n)
    expect(h.broken()).toBe(true)
  })

  it('counts only the fills it verified, and names the unknown ones apart', async () => {
    const other = `0x${'99'.repeat(32)}` as Hex
    const h = harness({
      intents: { '0x01': intent },
      fillLogs: async () => [filled(hash, 1_000n), filled(other, 1n), filled(other, 1n)],
    })
    await h.watch.rememberIntents([msg('0x01')])
    await h.watch.checkFills(1n, 10n)
    expect(h.broken()).toBe(false)
    expect(h.logs.join('\n')).toMatch(/checked 1 fill/)
    expect(h.logs.join('\n')).toMatch(/2 fills of intents never seen on the board/)
  })
})

describe('prune', () => {
  it('forgets intents that expired, so the map does not grow for ever', async () => {
    const h = harness({ intents: { '0x01': intentOf(OWN, { nonce: 1n, endTime: 200n }), '0x02': intentOf(OWN, { nonce: 9n, endTime: 10_000n }) } })
    await h.watch.checkMessages([msg('0x01'), msg('0x02')])
    await h.watch.rememberIntents([msg('0x01'), msg('0x02')])
    expect(h.watch.knownIntents.size).toBe(2)
    expect(h.watch.firstSeenSize()).toBe(2)
    // At chain time 5,000 the first intent (end 200) is long over; the board holds only 0x02.
    h.watch.prune(5_000n, ['0x02'])
    expect(h.watch.knownIntents.size).toBe(1)
    expect(h.watch.firstSeenSize()).toBe(1)
  })
})

describe('lastBlock on disk', () => {
  it('survives a restart, so the next run does not skip the blocks in between', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'wd-')), 'watchdog-943.json')
    expect(loadLastBlock(path)).toBeNull()
    saveLastBlock(path, 12_345n)
    expect(loadLastBlock(path)).toBe(12_345n)
  })

  it('reads a damaged file as no record, not as block zero', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'wd-')), 'watchdog-943.json')
    writeFileSync(path, '{"lastBlock": "not a number"')
    expect(loadLastBlock(path)).toBeNull()
    expect(readFileSync(path, 'utf8')).toContain('not a number')
  })
})

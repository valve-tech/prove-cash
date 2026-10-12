import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256, stringToHex, type Address } from 'viem'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { NETWORKS } from '@prove.cash/sdk'
import {
  creditFault,
  intentTypehash,
  readCreditFault,
  settlementFault,
  type Deployment,
} from './deployment.ts'

/**
 * The settlement a bot talks to is the settlement the deploy recorded.
 *
 * `executor.ts` took its two addresses from two independent sources: the settlement from the
 * unit's hand-edited `Environment=SETTLEMENT=`, the `ProveExecutor` from
 * `contracts/deployments/369.json` compiled into the bundle at build time. Move one and not the
 * other and the settlement calls a callback selector the executor does not answer, which reverts
 * with no data at all — the failure that cost chain 943 a whole redeployment.
 *
 * The pure rule is tested first. Then the bot is run for real with a wrong address, because a
 * rule nothing calls is not a guard.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

const RECORD: Deployment = {
  chainId: 369,
  contracts: {
    ProveSettlement: '0x595ec1C409F63b365ad9f21948E8B040EC5d60EE',
    ProveExecutor: '0x9d31d91453C931e78392934301B6ABD97c468c0A',
  },
}

describe('settlementFault', () => {
  test('says nothing when the run and the record agree', () => {
    expect(settlementFault(369, RECORD, RECORD.contracts.ProveSettlement, 'SETTLEMENT')).toBeNull()
  })

  test('names both addresses, where each came from, and what a mismatch costs', () => {
    const stale = '0x00000000000000000000000000000000000dEaD1'
    const said = settlementFault(369, RECORD, stale, "the unit's SETTLEMENT")
    expect(said).toContain(stale)
    expect(said).toContain(RECORD.contracts.ProveSettlement)
    expect(said).toContain("the unit's SETTLEMENT")
    expect(said).toContain('contracts/deployments/369.json')
    expect(said).toMatch(/revert with no data/)
  })

  test('is exact, not case-insensitive', () => {
    // The record is checksummed and so is the unit file. Two spellings of one address means the
    // two files can no longer be compared by eye, which is the only way anybody checks them.
    const lower = RECORD.contracts.ProveSettlement.toLowerCase()
    expect(settlementFault(369, RECORD, lower, 'SETTLEMENT')).not.toBeNull()
  })
})

// The systemd units are operator-side and not part of the public tree. Where they exist (an
// operator checkout), every check below runs; where they do not, the block is skipped by name.
describe.skipIf(!existsSync(join(HERE, '../deploy')))('the record on disk', () => {
  test('is the address the mainnet units carry', () => {
    // The other half of the same pairing, from the other end: the units and the record. If this
    // ever disagrees, `check-units.ts` is the gate that will say which one moved.
    const record = JSON.parse(
      readFileSync(join(HERE, '../../contracts/deployments/369.json'), 'utf8'),
    ) as Deployment
    const unit = readFileSync(join(HERE, '../deploy/prove-executor-369.service'), 'utf8')
    expect(unit).toContain(`Environment=SETTLEMENT=${record.contracts.ProveSettlement}`)
  })
})

describe('the executor bot', () => {
  const tsx = join(HERE, '../node_modules/.bin/tsx')

  /**
   * The bot itself, run with a settlement the deploy never made.
   *
   * It refuses before it builds a client, so this needs no node and reaches no network. That
   * ordering is deliberate and this test is what holds it: a check that ran after the first RPC
   * call would be a check nobody sees when the RPC is the thing that is down.
   */
  test.skipIf(!existsSync(tsx))('refuses to start on a settlement the deploy did not make', () => {
    const stale = '0x00000000000000000000000000000000000dEaD1'
    let output = ''
    try {
      execFileSync(tsx, ['scripts/executor.ts', '--chain', '369'], {
        cwd: join(HERE, '..'),
        env: { ...process.env, SETTLEMENT: stale },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      })
      output = '(the bot started, which it must not have)'
    } catch (e) {
      const err = e as { status?: number | null; stderr?: string; stdout?: string }
      expect(err.status).not.toBe(0)
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    expect(output).toContain('different deploys on chain 369')
    expect(output).toContain(stale)
  }, 60_000)
})

/**
 * The solver's `--credit` executor serves the settlement the run uses.
 *
 * The mainnet rehearsal started the solver with the new settlement and the old batch executor. It
 * printed nothing wrong. These tests hold the rule, then run the solver for real against a local
 * anvil, so a rule nothing calls cannot pass for a guard.
 */
const RUN = '0x70d2DB260b93f7c609BDa764FA26eBA0b173AF91' as Address
const OLD = '0x595ec1C409F63b365ad9f21948E8B040EC5d60EE' as Address
const BATCH = '0xA20EF4De61d1304ba4510Eb6d881219ecdDc3B53' as Address

describe('creditFault', () => {
  test('says nothing when the executor serves this settlement', () => {
    expect(creditFault(369, BATCH, RUN, RUN, 'SETTLEMENT')).toBeNull()
  })

  test('ignores case, because the chain and the environment may spell it apart', () => {
    expect(creditFault(369, BATCH, RUN, RUN.toLowerCase(), 'SETTLEMENT')).toBeNull()
  })

  test('names the executor, both settlements and where the run got its own', () => {
    const said = creditFault(369, BATCH, OLD, RUN, 'SETTLEMENT')
    expect(said).toContain(BATCH)
    expect(said).toContain(OLD)
    expect(said).toContain(RUN)
    expect(said).toContain('(SETTLEMENT)')
    expect(said).toMatch(/another deploy/)
  })

  test('refuses an address with no code', () => {
    expect(creditFault(369, BATCH, null, RUN, 'the registry')).toMatch(/no code/)
  })
})

describe('readCreditFault', () => {
  /** A client that answers only the two calls the check makes. */
  const fake = (code: string | undefined, answered: Address) => {
    const calls: string[] = []
    const client = {
      getCode: async () => {
        calls.push('getCode')
        return code
      },
      readContract: async (args: { functionName: string }) => {
        calls.push(args.functionName)
        return answered
      },
    } as unknown as Parameters<typeof readCreditFault>[0]
    return { client, calls }
  }

  test('reads settlement() from the executor and accepts a match', async () => {
    const { client, calls } = fake('0x60', RUN)
    expect(await readCreditFault(client, 369, BATCH, RUN, 'SETTLEMENT')).toBeNull()
    expect(calls).toEqual(['getCode', 'settlement'])
  })

  test('refuses an executor bound to another settlement', async () => {
    const { client } = fake('0x60', OLD)
    expect(await readCreditFault(client, 369, BATCH, RUN, 'SETTLEMENT')).toContain(OLD)
  })

  test('refuses an empty address without calling it', async () => {
    const { client, calls } = fake('0x', RUN)
    expect(await readCreditFault(client, 369, BATCH, RUN, 'SETTLEMENT')).toMatch(/no code/)
    expect(calls).toEqual(['getCode'])
  })
})

describe('the solver bot', () => {
  const tsx = join(HERE, '../node_modules/.bin/tsx')
  const anvilBin = (() => {
    try {
      return execFileSync('which', ['anvil'], { encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  })()
  const ready = existsSync(tsx) && anvilBin !== ''

  // A skip is not a pass. The app job once lost Foundry, and these four tests, the INTENT_TYPEHASH
  // startup guard among them, skipped on every green build. In CI a missing anvil or tsx fails.
  test.runIf(!!process.env.CI)('CI has anvil and tsx, so the solver tests below run', () => {
    expect({ tsx: existsSync(tsx), anvil: anvilBin }).toEqual({ tsx: true, anvil: expect.stringMatching(/anvil$/) })
  })

  // A local anvil on chain id 943, so the solver's chain check passes and nothing leaves this
  // machine. The registry's 943 settlement is the run's settlement.
  const port = 20_000 + Math.floor(Math.random() * 20_000)
  const rpc = `http://127.0.0.1:${port}`
  const settlement = NETWORKS[943].settlement
  let anvil: ChildProcess | undefined

  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    return (await res.json()) as { result?: unknown }
  }

  /** Runtime code that answers every call with this address, as `settlement()` would. */
  const answering = (address: Address) =>
    `0x73${address.slice(2).toLowerCase()}60005260206000f3`

  /** Runtime code that answers every call with this word, as `INTENT_TYPEHASH()` would. */
  const typehashCode = (word: string) => `0x7f${word.slice(2).toLowerCase()}60005260206000f3`

  beforeAll(async () => {
    if (!ready) return
    anvil = spawn(anvilBin, ['--port', String(port), '--chain-id', '943', '--silent'], {
      stdio: 'ignore',
    })
    for (let i = 0; i < 100; i++) {
      try {
        if ((await call('eth_chainId', [])).result) {
          // The solver reads INTENT_TYPEHASH() from its settlement before anything else.
          await call('anvil_setCode', [settlement, typehashCode(intentTypehash())])
          return
        }
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('anvil did not start')
  }, 30_000)

  afterAll(() => {
    anvil?.kill()
  })

  /**
   * Run the solver dry, with `--credit`, until it refuses or prints its banner.
   *
   * The key is a throwaway derived from a fixed string. It holds nothing and signs nothing.
   */
  const runSolver = (credit: Address) =>
    new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn(tsx, ['scripts/solver.ts', '--chain', '943', '--credit', credit], {
        cwd: join(HERE, '..'),
        env: {
          ...process.env,
          RPC: rpc,
          BOARD_RPC: rpc,
          SOLVER_KEY: keccak256(stringToHex('prove.cash/test/solver-credit')),
          PROVE_SETTLEMENT: '',
          SETTLEMENT: '',
          CREDIT_EXECUTOR: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const timer = setTimeout(() => child.kill(), 50_000)
      const read = (chunk: Buffer) => {
        output += chunk.toString()
        if (output.includes('credit through')) child.kill()
      }
      child.stdout.on('data', read)
      child.stderr.on('data', read)
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve({ code, output })
      })
    })

  test.skipIf(!ready)('refuses an executor bound to another settlement', async () => {
    const stale = '0x00000000000000000000000000000000000c0de1' as Address
    await call('anvil_setCode', [stale, answering(OLD)])
    const { code, output } = await runSolver(stale)
    expect(code).toBe(1)
    expect(output).toContain(`--credit ${stale} cannot settle`)
    expect(output).toContain(OLD)
    expect(output).not.toContain('credit through')
  }, 60_000)

  test.skipIf(!ready)('refuses an executor address with no code', async () => {
    const empty = '0x00000000000000000000000000000000000dead2' as Address
    const { code, output } = await runSolver(empty)
    expect(code).toBe(1)
    expect(output).toMatch(/no code/)
  }, 60_000)

  test.skipIf(!ready)('starts with an executor bound to this settlement', async () => {
    const good = '0x00000000000000000000000000000000000c0de2' as Address
    await call('anvil_setCode', [good, answering(settlement)])
    const { output } = await runSolver(good)
    expect(output).toContain(`credit through ${good}`)
    expect(output).not.toContain('cannot settle')
  }, 60_000)

  test.skipIf(!ready)('refuses a settlement whose INTENT_TYPEHASH is not the SDK one', async () => {
    const good = '0x00000000000000000000000000000000000c0de3' as Address
    await call('anvil_setCode', [good, answering(settlement)])
    const old = `0x4b3e51b4${'00'.repeat(28)}`
    await call('anvil_setCode', [settlement, typehashCode(old)])
    try {
      const { code, output } = await runSolver(good)
      expect(code).toBe(1)
      expect(output).toContain(`INTENT_TYPEHASH ${old}`)
      expect(output).not.toContain('credit through')
    } finally {
      await call('anvil_setCode', [settlement, typehashCode(intentTypehash())])
    }
  }, 60_000)
})

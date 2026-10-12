import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import {
  BATCH_EXECUTOR_ABI,
  EXECUTOR_ABI,
  RELAYER_ABI,
  RFQ_VENUE_ABI,
  SETTLEMENT_ABI,
} from './abi.js'
import { CHAIN_IDS, NETWORKS, deployedOn } from './config.js'
import {
  ABI_CHANGES,
  abiRefusal,
  assertDeployedAbi,
  changeMissingFrom,
  deployedAbiHas,
} from './deployed.js'
import { batchRead, type Call } from './multicall.js'

/**
 * 943 ran a build from 2026-09-09 until the 2026-09-26 redeploy, and no registered chain runs an
 * older build now. The blocks that test a refusal pin 943's date back to that build, and only
 * while they run. Everything else in this file reads the real registry.
 */
const retired = vi.hoisted(() => ({ date: null as string | null }))
vi.mock('./config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./config.js')>()
  return {
    ...real,
    deployedOn: (id: Parameters<typeof real.deployedOn>[0]) =>
      id === 943 && retired.date ? retired.date : real.deployedOn(id),
  }
})
const onTheRetiredBuild = () => {
  beforeAll(() => {
    retired.date = '2026-09-09'
  })
  afterAll(() => {
    retired.date = null
  })
}

/**
 * The rule that keeps a client from calling a function its chain never deployed.
 *
 * Chain 943 was the live case until its 2026-09-26 redeploy. It was deployed on 2026-09-09; `4ba9a66` renamed the executors'
 * `sink()` accessor to `sinkTemplate()` on 2026-09-15 and was deliberately not deployed there,
 * because a redeploy mints a new relayer and costs every approval-rung maker a re-approval. So a
 * build of this tree asks 943 for a name it does not publish, and the chain answers with a bare
 * revert that reads like any other failed call.
 *
 * Three things have to hold, and each is a separate way for this to rot:
 *
 *   the date is true      the registry's `deployedOn` is a copy of the deployment record, so it
 *                         can go stale on a redeploy. The record is the authority.
 *   the names are real    an entry naming a function no contract has would refuse calls for ever
 *                         and nothing would ever say so.
 *   the refusal fires     and fires before the request reaches the wire, which is the whole
 *                         point: a call that went out and came back reverted taught nobody.
 */

const RECORDS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts', 'deployments')

/** The zero address. A registry entry holding it means the chain has no settlement yet. */
const ZERO = '0x0000000000000000000000000000000000000000'

/** Every function name the compiler put in an ABI this package ships. */
const OURS = new Set(
  [SETTLEMENT_ABI, RELAYER_ABI, BATCH_EXECUTOR_ABI, EXECUTOR_ABI, RFQ_VENUE_ABI]
    .flat()
    .filter((e) => e.type === 'function')
    .map((e) => e.name as string),
)

describe('the registry names the date the deployment record recorded', () => {
  /*
   * The copy against its authority, per chain.
   *
   * `check-addresses.ts` holds the app's hand-copied addresses to the same records for the same
   * reason: a copy on purpose is still a copy, and a copy goes stale. A redeploy that moves the
   * date and leaves this line alone would teach the SDK that an old build is a new one, and the
   * refusal below would stop firing on a chain that still needs it.
   */
  for (const id of CHAIN_IDS) {
    test(`chain ${id}`, () => {
      const date = deployedOn(id)

      // The registry, not `settlement()`. An override points a client at a fork built from this
      // tree, and a fork's date is not the deployment's.
      if (NETWORKS[id].settlement === ZERO) {
        expect(date, `chain ${id} settles nowhere, so it has no deployed build to date`).toBeNull()
        return
      }

      const record: { deployedAt?: unknown } = JSON.parse(
        readFileSync(join(RECORDS, `${id}.json`), 'utf8'),
      )
      expect(
        typeof record.deployedAt,
        `contracts/deployments/${id}.json must carry deployedAt as a date string, because the ` +
          'registry says this chain settles and a client has to know how old that build is',
      ).toBe('string')
      expect(date, `deployedOn in the registry must be ${String(record.deployedAt)}`).toBe(
        record.deployedAt,
      )
    })
  }
})

describe('every deployment record dates its build the same way', () => {
  /*
   * The test above reads `deployedAt` only for a chain the registry settles on. So a record could
   * hold any shape while its chain was off, and the day the registry turned the chain on, that test
   * failed. The mainnet rehearsal hit exactly this: 369.json held `deployedAt` as an object.
   *
   * This test holds every record to the shape now, whatever the registry says. Turning a chain on
   * then needs a new date, never a new shape.
   */
  for (const id of CHAIN_IDS) {
    test(`chain ${id}`, () => {
      const record: { deployedAt?: unknown } = JSON.parse(
        readFileSync(join(RECORDS, `${id}.json`), 'utf8'),
      )
      expect(
        record.deployedAt,
        `contracts/deployments/${id}.json: deployedAt must be a "YYYY-MM-DD" string. ` +
          'Put receipts (blocks, gas, cost) under deployedIn.',
      ).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })
  }
})

describe('every recorded change is a real one', () => {
  test('each name belongs to a function the compiler produced', () => {
    // A name that no longer exists refuses calls for ever and explains nothing. `abi.ts` is
    // generated from the compiler's own output, so this asks the compiler rather than a list.
    // Functions a later build removed. Their entries stay: the chains that predate the removal
    // still refuse (or answer differently to) a call that names them, and that is what an entry
    // is for. `sinkTemplate`/`sinkFor` went with the sinks themselves.
    const RETIRED = new Set(['feeSinks', 'registerFeeSink', 'defaultFeeSink', 'sinkTemplate', 'sinkFor'])
    for (const change of ABI_CHANGES) {
      for (const name of change.names) {
        if (RETIRED.has(name)) continue
        expect(OURS.has(name), `${change.commit} names ${name}, which no contract of ours has`).toBe(
          true,
        )
      }
    }
  })

  test('each date is an ISO day, because the comparison is a string one', () => {
    for (const change of ABI_CHANGES) {
      expect(change.landed).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('a build is judged by its date and nothing else', () => {
  test('a build from before the change does not carry the name', () => {
    expect(changeMissingFrom('sinkTemplate', '2026-09-09')?.commit).toBe('4ba9a66')
    expect(changeMissingFrom('sinkFor', '2026-09-09')?.commit).toBe('4ba9a66')
  })

  test('a build from after the change carries it', () => {
    expect(changeMissingFrom('sinkTemplate', '2026-09-16')).toBeNull()
    expect(changeMissingFrom('sinkFor', '2026-12-01')).toBeNull()
  })

  test('a build from the day the change landed counts as predating it', () => {
    // A record carries a day and not a time, so a deploy from that morning and one from that
    // evening read alike. Refusing a call that would have worked is a loud error somebody fixes;
    // allowing one that cannot work is the silent revert this file exists to prevent.
    expect(changeMissingFrom('sinkTemplate', '2026-09-15')?.commit).toBe('4ba9a66')
  })

  test('a chain with no settlement is judged not at all', () => {
    expect(changeMissingFrom('sinkTemplate', null)).toBeNull()
  })

  test('a function no change touched passes on any date', () => {
    expect(changeMissingFrom('fill', '2020-01-01')).toBeNull()
  })
})

describe('the refusal says which change the chain predates', () => {
  onTheRetiredBuild()

  test('943 is refused the renamed accessors', () => {
    expect(deployedAbiHas('sinkTemplate', 943)).toBe(false)
    expect(deployedAbiHas('sinkFor', 943)).toBe(false)
  })

  test('943 still answers everything the rename did not touch', () => {
    expect(deployedAbiHas('fill', 943)).toBe(true)
    expect(deployedAbiHas('settleRing', 943)).toBe(true)
  })

  test('the message names the date, the commit, and what the chain runs instead', () => {
    const why = abiRefusal('sinkTemplate', 943) ?? ''
    expect(why).toContain('sinkTemplate()')
    expect(why).toContain('2026-09-09')
    expect(why).toContain('4ba9a66')
    expect(why).toContain('sink()')
    expect(why).toContain('docs/ADDRESSES.md')
  })

  test('a chain that can answer gets no message at all', () => {
    expect(abiRefusal('fill', 943)).toBeNull()
    expect(() => assertDeployedAbi('fill', 943)).not.toThrow()
  })
})

describe('batchRead refuses before the call reaches the wire', () => {
  onTheRetiredBuild()

  /**
   * A client that fails the test if `batchRead` touches it.
   *
   * Reaching the chain is the failure this guards against, not an error on the way back. A call
   * that went out and came back `reverted` is indistinguishable from a pair that does not exist,
   * which is how this class of bug stayed invisible.
   */
  const untouchable = {
    chain: { id: 943 },
    getCode: async () => {
      throw new Error('batchRead reached the chain')
    },
    readContract: async () => {
      throw new Error('batchRead reached the chain')
    },
    multicall: async () => {
      throw new Error('batchRead reached the chain')
    },
  } as never

  const EXECUTOR = '0x8B5bf5b06B4D04632aFB3D602656D48426605608'

  const ask = (name: string): Call => ({
    address: EXECUTOR,
    abi: EXECUTOR_ABI as never,
    functionName: name,
    args: [],
  })

  test('a 943 read of the renamed accessor throws, and never asks the chain', async () => {
    await expect(batchRead([ask('sinkTemplate')], untouchable)).rejects.toThrow(/predates 4ba9a66/)
  })

  test('the clone accessor is refused the same way', async () => {
    await expect(batchRead([ask('sinkFor')], untouchable)).rejects.toThrow(/sinkFor\(\)/)
  })

  test('one bad call refuses the whole batch, rather than being dropped from it', async () => {
    // `batchRead` keeps the order and the caller reads results by index. Dropping a call would
    // shift every answer after it onto the wrong question.
    await expect(batchRead([ask('fill'), ask('sinkFor')], untouchable)).rejects.toThrow(
      /sinkFor\(\)/,
    )
  })

  test('a call the chain can answer goes through untouched', async () => {
    // The control. A guard that refuses everything passes every test above and breaks the app.
    const answering = {
      chain: { id: 943 },
      getCode: async () => '0x',
      readContract: async () => 7n,
    } as never
    expect(await batchRead([ask('fill')], answering)).toEqual([{ ok: true, value: 7n }])
  })
})

import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkUnits,
  checkVenueTable,
  readRecords,
  readUnits,
  type Deployment,
} from './check-addresses.ts'
import { NETWORKS } from '@prove.cash/sdk'

/**
 * Both chains carry a deploy in the registry since mainnet went on (#52), so "the registry names
 * nothing" is staged by blanking one field for one test and putting it back. The code under test
 * reads the registry exactly as it does in production.
 */
async function withBlank369(key: 'settlement', value: unknown, fn: () => unknown): Promise<void> {
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
 * Every hand-copied address says what the deploy record says.
 *
 * Two halves, and the second is the one that matters. The first runs the gate over the real tree
 * and expects silence, which is what CI enforces. On its own that proves nothing: a gate that
 * finds no fault and a gate that cannot find one look identical from the outside, and this
 * repository has already shipped one of each — a coverage exemption pointing at a line that had
 * moved, and a chain guard comparing a literal against itself. So the second half hands the gate
 * a stale address and fails unless the gate says so.
 *
 * It lives beside the script rather than in `src/` because it reads the filesystem, and `src/` is
 * typechecked as browser code where `node:fs` does not exist.
 */

const HERE = dirname(fileURLToPath(import.meta.url))

/** A record shaped like the real ones, small enough to read. */
const RECORD: Deployment = {
  chainId: 369,
  contracts: {
    ProveSettlement: '0x595ec1C409F63b365ad9f21948E8B040EC5d60EE',
    ProveExecutor: '0x9d31d91453C931e78392934301B6ABD97c468c0A',
    RfqVenue: '0x89C3d80b45C586d8Fa87F4762fa89D30847c9A84',
  },
}

/** A record for the chain the registry already carries a settlement for. */
const TESTNET: Deployment = {
  chainId: 943,
  contracts: {
    ProveSettlement: '0xB491398057080aC7ff627A1D053dB258b9F730Cf',
    RfqVenue: '0xd1b81C59D228b844733b7cd82993055926dAF763',
  },
}

const RECORDS = { 369: RECORD, 943: TESTNET }

const unit = (chain: number, extra: string) => `[Service]
${extra}
ExecStart=/usr/bin/node /opt/prove-cash/bin/executor.mjs --chain ${chain} --interval 90
`

// The systemd units are operator-side and not part of the public tree. Where they exist (an
// operator checkout), every check below runs; where they do not, the block is skipped by name.
const HAVE_UNITS = existsSync(new URL('../deploy', import.meta.url))

describe.skipIf(!HAVE_UNITS)('the units on disk', () => {
  test('name only contracts the deploy recorded', () => {
    const units = readUnits()
    expect(units.length).toBeGreaterThan(0)
    const faults = checkUnits(units, readRecords())
    expect(faults.map((f) => `${f.where}: ${f.message}`)).toEqual([])
  })

  test('and every 369 unit carries the settlement line', () => {
    // The registry holds zero for 369 on purpose, so the unit is the only thing naming a
    // settlement there. This is the fault that put twelve unspendable intents on mainnet.
    // The record on disk, not the fixture above: the fixture holds the 2026-08-22 settlement.
    const onDisk = readRecords()[369]!.contracts.ProveSettlement
    const units = readUnits().filter((u) => u.unit.endsWith('-369.service'))
    expect(units.length).toBe(4)
    for (const u of units) {
      expect(u.text, u.unit).toContain(`Environment=SETTLEMENT=${onDisk}`)
    }
  })
})

describe('the gate itself', () => {
  test('catches a settlement address the deploy did not make', () => {
    const stale = '0xd041c34e9f5D6b7BF2C0B2B9dCf8a1F4c3b25eB2'
    const faults = checkUnits(
      [{ unit: 'prove-executor-369.service', text: unit(369, `Environment=SETTLEMENT=${stale}`) }],
      RECORDS,
    )
    // Twice, and both readings are worth having: the address scan says the value is in no record
    // on this chain, and the settlement line says which value it should have been.
    const said = faults.map((f) => f.message).join('\n')
    expect(faults.length).toBeGreaterThan(0)
    expect(said).toContain(stale)
    expect(said).toContain(RECORD.contracts.ProveSettlement)
  })

  test('catches a unit with no settlement line where the registry names no settlement', () =>
    withBlank369('settlement', '0x0000000000000000000000000000000000000000', () => {
      const faults = checkUnits(
        [{ unit: 'prove-heartbeat-369.service', text: unit(369, 'Restart=always') }],
        RECORDS,
      )
      expect(faults).toHaveLength(1)
      expect(faults[0].message).toMatch(/no Environment=SETTLEMENT=/)
    }))

  test('and lets a unit omit the line where the registry names the settlement', () => {
    const faults = checkUnits(
      [{ unit: 'prove-heartbeat-369.service', text: unit(369, 'Restart=always') }],
      RECORDS,
    )
    expect(faults).toEqual([])
  })

  test('catches a stale address anywhere in the file, not only on the settlement line', () => {
    // `prove-solver.service` passes `--credit <ProveBatchExecutor>` on its ExecStart, and 943 was
    // redeployed whole once already. A gate that only read `Environment=` would miss it.
    const faults = checkUnits(
      [
        {
          unit: 'prove-solver.service',
          text: `[Service]
ExecStart=/usr/bin/node /opt/prove-cash/bin/solver.mjs --chain 943 --credit 0x0ba297dd05C1E9C9D0C1c0B7d3D5B4e6A7f8091A
`,
        },
      ],
      RECORDS,
    )
    expect(faults).toHaveLength(1)
    expect(faults[0].message).toContain('0x0ba297dd05C1E9C9D0C1c0B7d3D5B4e6A7f8091A')
  })

  test('catches the right address written in the wrong case', () => {
    const lower = RECORD.contracts.ProveSettlement.toLowerCase()
    const faults = checkUnits(
      [{ unit: 'prove-executor-369.service', text: unit(369, `Environment=SETTLEMENT=${lower}`) }],
      RECORDS,
    )
    // Twice over: the address scan sees the case, and the settlement line sees the difference.
    expect(faults.length).toBeGreaterThan(0)
    expect(faults.some((f) => /wrong case/.test(f.message))).toBe(true)
  })

  test('catches a unit whose name and ExecStart disagree about the chain', () => {
    const faults = checkUnits(
      [{ unit: 'prove-executor-369.service', text: unit(943, 'Restart=always') }],
      RECORDS,
    )
    expect(faults).toHaveLength(1)
    expect(faults[0].message).toMatch(/name says chain 369/)
  })

  test('says so when a chain has no deployment record to check against', () => {
    const faults = checkUnits(
      [{ unit: 'prove-executor-369.service', text: unit(369, 'Restart=always') }],
      { 943: TESTNET },
    )
    expect(faults).toHaveLength(1)
    expect(faults[0].message).toMatch(/no contracts\/deployments\/369\.json/)
  })

  test('leaves a clean unit alone', () => {
    const good = unit(369, `Environment=SETTLEMENT=${RECORD.contracts.ProveSettlement}`)
    expect(checkUnits([{ unit: 'prove-executor-369.service', text: good }], RECORDS)).toEqual([])
  })
})

/** The table's real shape, small enough to read and identical where it counts. */
const venueTable = (entries: [number, string][]) => `const DEPLOYED: Partial<Record<ChainId, Address>> = {
${entries.map(([id, a]) => `  // a note about the deploy\n  ${id}: '${a}',`).join('\n')}
}
`

describe('the venue table on disk', () => {
  test('names only venues the deploy recorded', () => {
    const text = readFileSync(join(HERE, '../src/rfq/venue.ts'), 'utf8')
    const faults = checkVenueTable(text, readRecords())
    expect(faults.map((f) => `${f.where}: ${f.message}`)).toEqual([])
  })
})

describe('the venue rule', () => {
  test('catches a venue the deploy replaced', () => {
    // The exact shape of the mainnet redeploy: `RfqVenue` binds to the settlement in its
    // constructor, so it moves whenever the settlement does, and the browser keeps the old one.
    const stale = '0x0000000000000000000000000000000000005741'
    const faults = checkVenueTable(venueTable([[369, stale]]), { 369: RECORD, 943: TESTNET })
    expect(faults).toHaveLength(1)
    expect(faults[0].message).toContain(stale)
    expect(faults[0].message).toContain(RECORD.contracts.RfqVenue)
  })

  test('checks each chain against its own record, not against any of them', () => {
    // 943's real venue, written under the 369 key. Both addresses are live; the pairing is not.
    const faults = checkVenueTable(
      venueTable([[369, TESTNET.contracts.RfqVenue]]),
      { 369: RECORD, 943: TESTNET },
    )
    expect(faults).toHaveLength(1)
    expect(faults[0].message).toContain('chain 369')
  })

  test('refuses to pass when the table has an address it could not parse', () => {
    // A gate that skips what it cannot read reports success over an unchecked file. Say so
    // instead, and say that the parser is what needs fixing.
    const text = venueTable([[369, RECORD.contracts.RfqVenue]]) +
      "\nconst SOMETHING_ELSE = '0x0000000000000000000000000000000000005741'\n"
    const faults = checkVenueTable(text, { 369: RECORD })
    expect(faults).toHaveLength(1)
    expect(faults[0].message).toMatch(/Nothing was checked/)
  })

  test('says so when a chain names a venue and has no record', () => {
    const faults = checkVenueTable(venueTable([[369, RECORD.contracts.RfqVenue]]), {})
    expect(faults).toHaveLength(1)
    expect(faults[0].message).toMatch(/no contracts\/deployments\/369\.json/)
  })

  test('leaves a table that agrees alone', () => {
    const good = venueTable([
      [943, TESTNET.contracts.RfqVenue],
      [369, RECORD.contracts.RfqVenue],
    ])
    expect(checkVenueTable(good, { 369: RECORD, 943: TESTNET })).toEqual([])
  })
})

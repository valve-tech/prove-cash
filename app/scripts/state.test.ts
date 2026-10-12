import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultCachePath } from './poolcache.ts'
import { stateDir, trustFilePath } from './state.ts'

/**
 * C3 and C8 in the solver spec: the pool graph cache and the trust ledger had nowhere to live on
 * the bot host. `PrivateTmp=true` deletes the cache's `/tmp` at every stop, and
 * `ProtectSystem=strict` leaves the ledger's working directory read-only.
 */

const UNDER_SYSTEMD = { STATE_DIRECTORY: '/var/lib/prove-cash' } as NodeJS.ProcessEnv

describe('stateDir', () => {
  it('is the directory systemd names, and null from a shell', () => {
    expect(stateDir(UNDER_SYSTEMD)).toBe('/var/lib/prove-cash')
    expect(stateDir({})).toBeNull()
    expect(stateDir({ STATE_DIRECTORY: '  ' })).toBeNull()
  })

  it('takes the first of several, which systemd separates with a colon', () => {
    expect(stateDir({ STATE_DIRECTORY: '/var/lib/a:/var/lib/b' })).toBe('/var/lib/a')
  })
})

describe('where the pool graph cache goes', () => {
  it('goes to the state directory under systemd, not to a /tmp that dies with the unit', () => {
    expect(defaultCachePath(943, UNDER_SYSTEMD)).toBe('/var/lib/prove-cash/prove-poolgraph-943.json')
  })

  it('keeps one file per chain, so the 943 and 369 units share the directory safely', () => {
    expect(defaultCachePath(369, UNDER_SYSTEMD)).not.toBe(defaultCachePath(943, UNDER_SYSTEMD))
  })

  it('still lets POOL_GRAPH_CACHE name the file outright', () => {
    const env = { ...UNDER_SYSTEMD, POOL_GRAPH_CACHE: '/srv/graph.json' }
    expect(defaultCachePath(943, env)).toBe('/srv/graph.json')
  })

  it('falls back to the temporary directory from a shell', () => {
    expect(defaultCachePath(943, {})).toBe(join(tmpdir(), 'prove-poolgraph-943.json'))
  })
})

describe('where the trust ledger goes', () => {
  it('goes to the state directory under systemd, not to a read-only working directory', () => {
    expect(trustFilePath(369, UNDER_SYSTEMD)).toBe('/var/lib/prove-cash/solver-trust-369.json')
  })

  it('keeps the old relative name from a shell', () => {
    expect(trustFilePath(943, {})).toBe('.solver-trust.943.json')
  })
})

// The systemd units are operator-side and not part of the public tree. Where they exist (an
// operator checkout), every check below runs; where they do not, the block is skipped by name.
const HAVE_UNITS = existsSync(new URL('../deploy', import.meta.url))

describe.skipIf(!HAVE_UNITS)('the units give the executor and the solver a state directory', () => {
  const units = [
    'prove-executor.service',
    'prove-executor-369.service',
    'prove-solver.service',
    'prove-solver-369.service',
  ]
  const read = (name: string) =>
    readFileSync(new URL(`../deploy/${name}`, import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('#'))

  for (const name of units) {
    it(`${name} sets StateDirectory=prove-cash`, () => {
      expect(read(name)).toContain('StateDirectory=prove-cash')
    })

    it(`${name} keeps its sandbox`, () => {
      const lines = read(name)
      // The state directory is the only writable path. Nothing may loosen the rest of the disk.
      expect(lines).toContain('ProtectSystem=strict')
      expect(lines).toContain('PrivateTmp=true')
      expect(lines.some((l) => /^(ReadWritePaths|ProtectSystem=(false|true|full)$)/.test(l))).toBe(
        false,
      )
    })
  }
})

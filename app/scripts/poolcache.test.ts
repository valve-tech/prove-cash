import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, test } from 'vitest'
import { PoolGraph, graphOptionsFor } from '@prove.cash/sdk/solver'
import { loadGraph, saveGraph } from './poolcache.ts'

/**
 * The cache file on a real disk. Every failure must end in a working graph, and a write must
 * never leave a half file behind.
 */

const dir = () => mkdtempSync(join(tmpdir(), 'poolcache-'))
const options = graphOptionsFor(943)

function oneGraph() {
  const g = new PoolGraph(options)
  g.add({
    address: '0xc5cb61b1dbe241616b205804f89a778a5d4ff52d',
    token0: '0x70499adebb11efd915e3b69e700c331778628707',
    token1: '0x86390129a2079fb7f0fc889473160a3a449117ab',
    reserve0: 2_777_717_985_410_719_758_201n,
    reserve1: 54_013_024n,
    feeNum: 9_971n,
    feeDen: 10_000n,
    venue: 'v1',
    blockNumber: 25_461_939n,
  })
  g.coverTo(25_461_939n)
  return g
}

describe('the pool graph cache file', () => {
  test('a missing file is a cold start', () => {
    expect(loadGraph(943, options, join(dir(), 'none.json')).from).toBe('cold')
  })

  test('a corrupt file is a cold start, never a throw', () => {
    const path = join(dir(), 'bad.json')
    writeFileSync(path, '{"v":2,"chainId":943,"pools":[["0xc5cb')
    const { graph, from } = loadGraph(943, options, path)
    expect(from).toBe('cold')
    expect(graph.size).toBe(0)
  })

  test('a written file loads back warm, with its coverage mark', () => {
    const path = join(dir(), 'g.json')
    expect(saveGraph(oneGraph(), 943, path)).toBe(true)
    const { graph, from } = loadGraph(943, options, path)
    expect(from).toBe('cache')
    expect(graph.size).toBe(1)
    expect(graph.syncedTo).toBe(25_461_939n)
  })

  test('the write is a rename, so no temporary file is left beside it', () => {
    const d = dir()
    saveGraph(oneGraph(), 943, join(d, 'g.json'))
    expect(readdirSync(d)).toEqual(['g.json'])
  })

  test('a write that cannot land says so and does not throw', () => {
    const d = dir()
    const blocker = join(d, 'file')
    writeFileSync(blocker, 'x')
    // A path under a regular file cannot be created.
    expect(saveGraph(oneGraph(), 943, join(blocker, 'g.json'))).toBe(false)
  })
})

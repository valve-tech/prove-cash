import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { PoolGraph, type PoolGraphInit } from '@prove.cash/sdk/solver'
import { stateDir } from './state.ts'

/**
 * The pool graph's cache file, so a restart does not start cold.
 *
 * The filesystem is the only reason this is not in the SDK: a `node:fs` import there would reach
 * the web app's bundle. `PoolGraph.serialize` and `PoolGraph.parse` hold the hard behaviour (a
 * truncated file, a file from the other chain, a damaged row), and they are pure and tested in
 * `sdk/src/solver/graph.test.ts`. What is left is reading and writing bytes.
 *
 * Measured on 2026-09-23: a cold start on 369 costs 22 RPC requests, 4 subgraph requests and
 * 26 s, and writes 141 KB. A warm start from that file parses in 3 ms and costs one
 * `eth_getLogs`. On 943: 11 requests and 55 s cold (the testnet subgraph is slow), 75 KB, and
 * one `eth_getLogs` warm.
 */

/**
 * Where a chain's cache lives when the operator names no path.
 *
 * `POOL_GRAPH_CACHE` first. Then the state directory systemd gives a unit, because the units set
 * `PrivateTmp=true` and systemd deletes that `/tmp` at every stop: a cache there made every
 * restart a cold start. The temporary directory is the last resort, for a run from a shell.
 */
export const defaultCachePath = (chainId: number, env: NodeJS.ProcessEnv = process.env): string => {
  const name = `prove-poolgraph-${chainId}.json`
  const state = stateDir(env)
  return env.POOL_GRAPH_CACHE ?? (state ? join(state, name) : join(tmpdir(), name))
}

/**
 * Load a graph from disk, or give back an empty one.
 *
 * Every failure ends in a working graph, because the alternative is a bot that will not start
 * over a cache file. A missing, unreadable or corrupt file is the same thing to the caller: a
 * cold start.
 */
export function loadGraph(
  chainId: number,
  options: PoolGraphInit,
  path = defaultCachePath(chainId),
): { graph: PoolGraph; from: 'cache' | 'cold' } {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return { graph: new PoolGraph(options), from: 'cold' }
  }
  const graph = PoolGraph.parse(text, chainId, options)
  return { graph, from: graph.size > 0 ? 'cache' : 'cold' }
}

/**
 * Write the graph atomically, and never throw.
 *
 * Atomically, because a process killed mid-write leaves a truncated file, and surviving one
 * means losing the whole cache. A write to a neighbouring name and a rename cannot leave that.
 *
 * Never throws, because a full disk must not stop a bot from filling. The cache saves time; the
 * chain is the source.
 */
export function saveGraph(graph: PoolGraph, chainId: number, path = defaultCachePath(chainId)): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, graph.serialize(chainId))
    renameSync(tmp, path)
    return true
  } catch {
    return false
  }
}

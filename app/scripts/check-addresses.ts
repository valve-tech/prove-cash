/**
 * Hold every hand-copied contract address to the deployment record it came from.
 *
 *   npx tsx scripts/check-addresses.ts     # or: npm run check:addresses
 *
 * Two files keep a second copy of an address the deploy already recorded, and both keep it on
 * purpose:
 *
 *   app/deploy/*.service   `Environment=SETTLEMENT=`. Operator-side files; this public tree
 *                          ships none, so the unit half runs only where they exist. A bot that inherited its settlement from a
 *                          registry could not be pointed at another one by the operator running
 *                          it, and each unit's own comment says so.
 *   app/src/rfq/venue.ts   the `RfqVenue` per chain. A maker WRITING an exclusive quote has to
 *                          put the venue in `Intent.executor` before there is a quote to read it
 *                          out of, so the browser needs the address before it needs the chain.
 *
 * A copy on purpose is still a copy, and a copy goes stale. Until this script nothing compared
 * either of them with `contracts/deployments/<chain>.json`.
 *
 * What a stale unit costs is written into the units themselves, in three different hands:
 *
 *   heartbeat  signs against the address, so a stale one puts unspendable intents on the public
 *              board. Twelve reached mainnet on 2026-08-23 when the line was simply missing.
 *   executor   prints "settlement is not deployed", exits 0, and systemd restarts that same
 *              no-op every thirty seconds. Green in `systemctl status`, doing nothing.
 *   watchdog   skips its fill checks when the address is zero, so the unit stays green while it
 *              checks nothing at all.
 *
 * What a stale venue costs is quieter still, because it is silent through five steps: the maker
 * signs, the board takes the post, the counterparty's card reports zero faults, the submitter's
 * preview renders a margin, and only `settleExclusive` reverts. `venue.ts` says the rest.
 *
 * A missing value produces the loud half. A WRONG value is the whole problem: everything starts,
 * connects, and talks to a contract that is not the one the deploy made. That is the
 * `gen-gas.mjs` failure exactly — a wrong number is still a valid number — which is why this
 * follows that script's shape and runs in CI beside it.
 *
 * It is also the check to run BEFORE deploying the bots, not only in CI. A redeploy is
 * when these drift, and CI runs after the commit rather than before the deploy.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CHAIN, NETWORKS, isSupportedChain } from '@prove.cash/sdk'
import type { Deployment } from './deployment.ts'

export type { Deployment }

const HERE = dirname(fileURLToPath(import.meta.url))
const DEPLOY = join(HERE, '../deploy')
const VENUE_TABLE = join(HERE, '../src/rfq/venue.ts')
const RECORDS = join(HERE, '../../contracts/deployments')

/** The zero address. A registry entry holding it means the chain has no settlement yet. */
const ZERO = '0x0000000000000000000000000000000000000000'

/** One thing wrong in one file, in the words the person fixing it needs. */
export type Fault = { where: string; message: string }

/** Every 20-byte hex address in a file, with the line it sits on. */
const addressesIn = (text: string): { address: string; line: string }[] =>
  text
    .split('\n')
    .flatMap((line) =>
      (line.match(/0x[0-9a-fA-F]{40}/g) ?? []).map((address) => ({ address, line: line.trim() })),
    )

/** `--chain 369` out of an `ExecStart=`, or null when the unit names none. */
function chainOf(text: string): number | null {
  const exec = text.split('\n').find((l) => l.startsWith('ExecStart='))
  const named = exec?.match(/--chain\s+(\d+)/)
  return named ? Number(named[1]) : null
}

/** The chain a file name claims, from a `-369` suffix, or null when it carries none. */
function suffixOf(unit: string): number | null {
  const m = unit.match(/-(\d+)\.service$/)
  return m ? Number(m[1]) : null
}

/** `Environment=SETTLEMENT=…`, or null when the unit carries no such line. */
function settlementLineOf(text: string): string | null {
  const line = text.split('\n').find((l) => l.startsWith('Environment=SETTLEMENT='))
  return line ? line.slice('Environment=SETTLEMENT='.length).trim() : null
}

/**
 * Everything wrong across every unit, as a list rather than a first failure.
 *
 * A redeploy moves several contracts at once and touches several units at once, so an operator
 * wants the whole list in one run. `contracts/abi/export.sh --check` reports every stale ABI for
 * the same reason.
 */
export function checkUnits(
  units: { unit: string; text: string }[],
  records: Partial<Record<number, Deployment>>,
): Fault[] {
  const faults: Fault[] = []
  const fail = (where: string, message: string) => faults.push({ where, message })

  for (const { unit, text } of units) {
    const named = chainOf(text)
    const suffix = suffixOf(unit)

    // A `-369` unit that runs `--chain 943` is a copy nobody finished editing. The two halves of
    // the name have to agree before anything below can trust either.
    if (suffix !== null && named !== suffix) {
      fail(unit, `the name says chain ${suffix} and ExecStart says ${named ?? 'nothing'}`)
      continue
    }

    // No `--chain` means the bot's own default, which is the registry's. `prove-mover.service` is
    // the one unit shaped that way, and it names no address at all.
    const chainId = named ?? DEFAULT_CHAIN
    if (!isSupportedChain(chainId)) {
      fail(unit, `chain ${chainId} is not in the registry`)
      continue
    }

    const record = records[chainId]
    if (!record) {
      fail(unit, `no contracts/deployments/${chainId}.json to check it against`)
      continue
    }

    /** Every address the deploy actually put on this chain, and what each one is called. */
    const deployed = new Map<string, string>()
    for (const [name, address] of Object.entries(record.contracts)) deployed.set(address, name)

    for (const { address, line } of addressesIn(text)) {
      const name = deployed.get(address)
      if (name) continue
      // Case is checked with the value. The records are checksummed, so a lowercased paste works
      // on chain and still means the two files can no longer be compared by eye.
      const sameBytes = [...deployed.keys()].find((d) => d.toLowerCase() === address.toLowerCase())
      if (sameBytes) {
        const what = deployed.get(sameBytes)
        fail(unit, `${address} is ${what} in the wrong case. The record has ${sameBytes}.`)
        continue
      }
      fail(
        unit,
        `${address} is in no contracts/deployments/${chainId}.json entry — ${line}\n` +
          `      the record holds: ${[...deployed].map(([a, n]) => `${n}=${a}`).join(', ')}`,
      )
    }

    /*
     * The settlement line itself, which is the whole reason these files carry an address.
     *
     * Required where the registry has no settlement of its own, because there the unit is the
     * only thing that names one and a bot without it runs against zero. Optional elsewhere — 943
     * is in the registry, so its units carry no line — and checked either way when present.
     */
    const line = settlementLineOf(text)
    const expected = record.contracts.ProveSettlement
    if (line === null) {
      if (NETWORKS[chainId].settlement === ZERO) {
        fail(
          unit,
          `no Environment=SETTLEMENT= line, and chain ${chainId} carries none in the registry, ` +
            `so this bot would run against the zero address. Add SETTLEMENT=${expected}.`,
        )
      }
    } else if (line !== expected) {
      fail(unit, `Environment=SETTLEMENT=${line}, but the deploy recorded ${expected}`)
    }
  }
  return faults
}

/**
 * The app's own copy of `RfqVenue`, one entry per chain, against the same records.
 *
 * The table is parsed out of the source rather than imported, so this reads the file a person
 * edits rather than a value the module happens to export. Every address in the file has to belong
 * to an entry: a stray one that the table's shape does not cover is a fault of its own, because a
 * gate that quietly skips what it cannot parse is a gate that stops finding anything. This repo
 * has already shipped a check pointing at a line that had moved.
 */
export function checkVenueTable(
  text: string,
  records: Partial<Record<number, Deployment>>,
  where = 'src/rfq/venue.ts',
): Fault[] {
  const faults: Fault[] = []
  const fail = (message: string) => faults.push({ where, message })

  const entries = [...text.matchAll(/^\s*(\d+):\s*'(0x[0-9a-fA-F]{40})'/gm)].map((m) => ({
    chainId: Number(m[1]),
    address: m[2],
  }))
  const found = addressesIn(text).length
  if (entries.length !== found) {
    fail(
      `the table's shape changed: ${found} addresses in the file, ${entries.length} of them in ` +
        'per-chain entries this can read. Nothing was checked. Fix the parser, not the table.',
    )
    return faults
  }

  for (const { chainId, address } of entries) {
    const record = records[chainId]
    if (!record) {
      fail(`chain ${chainId} names a venue and has no contracts/deployments/${chainId}.json`)
      continue
    }
    const recorded = record.contracts.RfqVenue
    if (!recorded) {
      fail(`chain ${chainId} names a venue and the deploy recorded no RfqVenue`)
      continue
    }
    if (address === recorded) continue
    fail(
      `chain ${chainId} names venue ${address}, and the deploy recorded ${recorded}. ` +
        'A quote built on the stale one signs, posts, checks clean and reverts at settlement.',
    )
  }
  return faults
}

/** The unit files on disk, in name order. */
export const readUnits = (dir = DEPLOY) =>
  (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith('.service'))
    .sort()
    .map((unit) => ({ unit, text: readFileSync(join(dir, unit), 'utf8') }))

/** Every deployment record on disk, keyed by chain id. */
export function readRecords(dir = RECORDS): Partial<Record<number, Deployment>> {
  const out: Partial<Record<number, Deployment>> = {}
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const record = JSON.parse(readFileSync(join(dir, file), 'utf8')) as Deployment
    out[record.chainId] = record
  }
  return out
}

function main() {
  const units = readUnits()
  const records = readRecords()
  const venue = readFileSync(VENUE_TABLE, 'utf8')
  const faults = [...checkUnits(units, records), ...checkVenueTable(venue, records)]
  if (faults.length === 0) {
    console.log(`${units.length} unit files and the venue table match the deployment records`)
    return
  }
  for (const f of faults) console.error(`  ${f.where}: ${f.message}`)
  console.error(
    `\n${faults.length} mismatch${faults.length === 1 ? '' : 'es'}. An address the deploy never ` +
      'made is not an error anywhere until far too late. Fix the copy, or the record if the ' +
      'record is the stale one.',
  )
  process.exit(1)
}

if (import.meta.url === `file://${process.argv[1]}`) main()

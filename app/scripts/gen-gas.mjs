/**
 * Write the measured gas table into TypeScript, from what `forge test` actually reports.
 *
 * The landing page used to carry these numbers by hand, and the hand-written table was never
 * right. It claimed 33,381 gas for a warm allowance fill. `Gas.t.sol` has reported about 99,000
 * for that row since the repository's first commit and 105,238 today — it has never, at any
 * commit, produced 33,381 or the 33,403 that replaced it. The figures came from a spec
 * (`docs/specs/2026-08-14-scale-and-rationing.md`) that says it took them from this
 * test and did not.
 *
 * So this file was born stale. It landed already carrying the spec's numbers, in a file headed
 * "generated, do not edit", and `--check` was written for CI and never wired into it. Both halves
 * had to fail: a wrong number is still a valid number, and a gate nobody runs is not a gate.
 *
 *   node scripts/gen-gas.mjs            write app/src/landing/gas.ts
 *   node scripts/gen-gas.mjs --check    exit 1 if it is out of date, for CI
 *
 * This shells out to forge, so `contracts/` must build.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const contracts = join(here, '..', '..', 'contracts')
const target = join(here, '..', 'src', 'landing', 'gas.ts')

/**
 * The test prints `: <label> <gas> <per intent>`. Labels carry spaces, so anchor on the leading
 * colon and take the last two integers — splitting on whitespace would cut every label apart.
 */
const ROW = /^\s*:\s*(.+?)\s+(\d+)\s+(\d+)\s*$/

function measure() {
  const out = execFileSync(
    'forge',
    ['test', '--match-path', 'test/Gas.t.sol', '-vv'],
    { cwd: contracts, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
  const rows = new Map()
  for (const line of out.split('\n')) {
    const m = ROW.exec(line)
    if (m) rows.set(m[1].trim(), { total: Number(m[2]), each: Number(m[3]) })
  }
  if (rows.size === 0) throw new Error('no gas rows parsed — did the report format change?')
  return rows
}

/** Every label the page draws. A missing one is a build failure, not a blank bar. */
const WANTED = [
  'fill, allowance, first touch',
  'fill, allowance, warm',
  'fill, escrow, cold slots',
  'fill, escrow, warm',
  'deposit, first touch',
  'fillWithCallback',
  'fillBatch x20, one token',
  'fillBatch marginal intent',
  'fillBatch x20, alternating',
  'fillBatchWithCallback x20',
  'the credit premium, per leg',
  // What batching is worth: eight legs in one call against the same eight one at a time. Three
  // SDK files quote this pair — `plan.ts`, `pack.ts` and `abi.ts` — and until they became rows
  // they quoted a figure the test had stopped producing, because a number that is not a row is a
  // number no gate can retire.
  'eight legs, one batch',
  'eight legs, one at a time',
  // What a leg that does not fill costs. The solver's whole risk, and the reason the surplus
  // they keep is not free money.
  'one more leg that fills',
  'one more leg, expired',
  'one more leg a rival took',
  'one more leg whose nonce was burnt',
  'one more leg with a bad signature',
  'one more permit2 leg that fills',
  'one more leg the maker unfunded',
  // What an ATOMIC batch pays when it loses a leg — a ring, in other words. Nothing on the page
  // draws these; they are here so they are generated and CI-checked rather than quoted into a
  // comment, which is how this file's numbers went wrong in the first place.
  'atomic 3, all fill',
  'atomic 2, the FIRST leg gone',
  'atomic 2, one leg gone',
  'atomic 3, one leg gone',
  'atomic 8, the FIRST leg gone',
  'atomic 8, the LAST leg gone',
  // What a fee destination pays to take its money out. A fee is booked at fill time rather than
  // transferred, so this is the other half of the cost of charging one — and it is here for the
  // same reason the atomic rows are: a number that will be quoted should be generated.
  'claim, a destination empties its book',
  // What a TOLERANT ring pays to carry fallbacks it never fires. The other side of the
  // break-even in `sdk/src/solver/tolerant.ts`, and until #130 the only side of it that was a
  // constant typed into a comment rather than a row a gate could compare. The third row is the
  // one-off entry fee, published beside them so nobody folds it into the arithmetic.
  'a fallback carried, the first',
  'a fallback carried, each after',
  "a solver's first sink, once ever",
]

function render(rows) {
  const missing = WANTED.filter((k) => !rows.has(k))
  if (missing.length) {
    console.error(`gas report is missing rows the page needs:\n  ${missing.join('\n  ')}`)
    process.exit(1)
  }
  const body = WANTED.map((k) => {
    const r = rows.get(k)
    return `  ${JSON.stringify(k)}: { total: ${r.total}, each: ${r.each} },`
  }).join('\n')
  return `/**
 * Measured gas, generated. Do not edit.
 *
 *   cd app && node scripts/gen-gas.mjs
 *
 * Source: contracts/test/Gas.t.sol. \`total\` is the whole call, \`each\` is per intent for the
 * batch rows and the same as \`total\` everywhere else.
 */
export const GAS = {
${body}
} as const satisfies Record<string, { total: number; each: number }>

export type GasKey = keyof typeof GAS
`
}

const next = render(measure())
if (process.argv.includes('--check')) {
  let current = ''
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    /* absent counts as stale */
  }
  if (current !== next) {
    console.error('src/landing/gas.ts is out of date — run `node scripts/gen-gas.mjs`')
    process.exit(1)
  }
  console.log('gas table is current')
} else {
  writeFileSync(target, next)
  console.log(`wrote ${target}`)
}

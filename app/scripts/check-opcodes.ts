/**
 * Ask each chain which EVM opcodes it actually takes, and say so when the answer changes.
 *
 *   npx tsx scripts/check-opcodes.ts     # or: npm run check:opcodes
 *
 * `contracts/foundry.toml` pins `evm_version = "paris"`. That is a deliberate choice and it costs
 * something real: no `PUSH0`, so slightly larger bytecode, and no `TSTORE`, so the settlement's
 * reentrancy guard pays a storage slot on every guarded call instead of a transient one. The
 * argument for paying it is that the bytecode then runs on any EVM chain the registry might add
 * later, without anybody checking which hard forks that chain took.
 *
 * **The cost is only worth paying while it is true.** PulseChain will ship Cancun eventually, and
 * the day it does, nothing in this repository would notice. Somebody would have to remember to
 * check. Nobody remembers, which is how this repository ended up with a coverage gate red for
 * four days and a citation pointing at a line that had moved.
 *
 * So the expectation is written down and this asks the chain. It exits 1 when reality and
 * `EXPECTED` disagree — in either direction — and says what to do about it.
 *
 * **How the probe works.** `eth_call` with no `to` executes its `data` as contract creation code.
 * So the probe is a few bytes of hand-written EVM: run the opcode, then return 1. A chain that
 * does not have the opcode rejects it and the call reverts. Every probe is paired with an
 * identical one built on `SSTORE`, which every chain has had since 2015: if the control fails the
 * probe proves nothing about the chain and everything about this file, and the run says so rather
 * than reporting an opcode as missing.
 *
 * Nothing here signs, sends or spends. `eth_call` is a simulation and the node discards it.
 */
import { CHAIN_IDS, NETWORKS, defaultRpc } from '@prove.cash/sdk'
import { describe } from './rpc.ts'

/**
 * A probe, as creation code.
 *
 * Each is `PUSH1 0x01, PUSH1 0x00, <opcode>` followed by `PUSH1 1, PUSH1 0, MSTORE, PUSH1 32,
 * PUSH1 0, RETURN` — do the thing, then return a 32-byte 1. The opcode is the only byte that
 * differs between a probe and its control.
 */
const TAIL = '600160005260206000f3'
const probe = (opcode: string) => `0x60016000${opcode}${TAIL}`

type Probe = {
  /** The opcode's name, as the yellow paper spells it. */
  name: string
  /** Creation code that executes it. */
  code: string
  /** The hard fork that introduced it. */
  since: string
  /** True when this repository expects the chain to have it today. */
  expected: boolean
  /** What changes here on the day the answer flips. */
  consequence: string
}

const PROBES: Probe[] = [
  {
    name: 'SSTORE',
    code: probe('55'),
    since: 'Frontier, 2015',
    expected: true,
    // Not a question about the chain. It is the control: a chain that fails this one is not
    // answering the question this file is asking, and every other row below it means nothing.
    consequence: 'the control. If this fails, distrust every other row and fix the probe.',
  },
  {
    name: 'TSTORE',
    code: probe('5d'),
    since: 'Cancun, EIP-1153',
    expected: false,
    consequence:
      'the reentrancy guard can move to OpenZeppelin ReentrancyGuardTransient, which is ' +
      'a transient slot rather than a stored one. Needs evm_version = "cancun" and a redeploy.',
  },
  {
    name: 'MCOPY',
    code: `0x60006000600060005e${TAIL.slice(0)}`,
    since: 'Cancun, EIP-5656',
    expected: false,
    consequence: 'solc emits cheaper memory copies. Same evm_version bump as TSTORE.',
  },
  {
    name: 'PUSH0',
    code: `0x5f50${TAIL}`,
    since: 'Shanghai, EIP-3855',
    // Measured true on both registered chains, 2026-09-08. This row is the one that showed the
    // paris pin is a choice rather than a requirement: both chains in the registry are Shanghai
    // and take PUSH0 today, so `evm_version = "paris"` is buying portability to chains nobody has
    // added, and paying for it in bytecode size on the two that exist.
    expected: true,
    consequence:
      'a chain in the registry lost PUSH0, which should be impossible — a fork does not go ' +
      'backwards. Distrust the endpoint before you distrust the chain.',
  },
]

type Result = { chain: number; probe: string; ok: boolean; detail: string }

async function ask(rpc: string, code: string): Promise<{ ok: boolean; detail: string }> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ data: code }, 'latest'],
  }
  const res = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` }
  const json = (await res.json()) as { result?: string; error?: { message?: string } }
  if (json.result !== undefined) {
    // The creation code returned; a 1 back means the opcode ran.
    return { ok: /0x0*1$/.test(json.result), detail: 'ran' }
  }
  // The node's own words. Never the URL — an endpoint can carry a key in its path.
  return { ok: false, detail: json.error?.message ?? 'no result and no error' }
}

async function main() {
  const results: Result[] = []
  for (const chain of CHAIN_IDS) {
    // The registry's endpoint. Never printed: `defaultRpc` can carry a key in its path.
    const rpc = defaultRpc(chain)
    for (const p of PROBES) {
      const { ok, detail } = await ask(rpc, p.code)
      results.push({ chain, probe: p.name, ok, detail })
    }
  }

  const byName = (n: string) => PROBES.find((p) => p.name === n)!
  let bad = 0
  let controlFailed = false

  for (const chain of CHAIN_IDS) {
    const name = NETWORKS[chain].label
    console.log(`\n${name} (chain ${chain})`)
    for (const r of results.filter((x) => x.chain === chain)) {
      const p = byName(r.probe)
      const agrees = r.ok === p.expected
      const mark = agrees ? 'ok  ' : 'MOVED'
      console.log(
        `  ${mark} ${r.probe.padEnd(7)} ${r.ok ? 'activated' : 'not activated'}` +
          `  (${p.since})${agrees ? '' : `  — ${r.detail}`}`,
      )
      if (!agrees) {
        bad++
        if (p.name === 'SSTORE') controlFailed = true
      }
    }
  }

  console.log()
  if (controlFailed) {
    console.log(
      'FAIL: the SSTORE control did not run, so this tells you nothing about the chain.\n' +
        '      Fix the probe or the endpoint before reading anything above.',
    )
    process.exit(1)
  }
  if (bad === 0) {
    console.log(`OK: every chain is where contracts/foundry.toml assumes. ${results.length} probes.`)
    return
  }

  console.log(`FAIL: ${bad} opcode(s) no longer match what this repository assumes.\n`)
  for (const p of PROBES) {
    const moved = results.filter((r) => r.probe === p.name && r.ok !== p.expected)
    if (moved.length === 0) continue
    console.log(`  ${p.name} on ${moved.map((m) => m.chain).join(', ')}: ${p.consequence}`)
  }
  console.log(
    '\n  Flipping any of these means new bytecode, and new bytecode means a new address,\n' +
      '  and a new address re-domains every EIP-712 signature. So it is a redeploy, and it\n' +
      '  belongs in the same redeploy as everything else waiting on one. Update EXPECTED here\n' +
      '  in the same commit that changes evm_version, or this says FAIL for ever.',
  )
  process.exit(1)
}

main().catch((e: unknown) => {
  console.error(`FAIL: ${describe(e)}`)
  process.exit(1)
})

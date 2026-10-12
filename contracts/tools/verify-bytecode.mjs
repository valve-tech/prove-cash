#!/usr/bin/env node
/**
 * Compare the code on chain against the code this repository builds.
 *
 *   node tools/verify-bytecode.mjs 369
 *   node tools/verify-bytecode.mjs 943 --rpc https://…
 *   node tools/verify-bytecode.mjs 369 --no-build      # trust out/ as it stands
 *   node tools/verify-bytecode.mjs 943 --pin           # hold the verdicts against the pin file
 *   PROVE_RPC_KEY=… node tools/verify-bytecode.mjs 943  # a gateway key other than vk_demo
 *
 * Both deployment records claim a nibble-by-nibble comparison was done, and neither said with
 * what. The comparison happened in a shell that is gone, so the claim could not be repeated and
 * the next deploy would have had to make it again from memory. This is the tool that repeats it.
 *
 * ── What it does ──────────────────────────────────────────────────────────────────────────────
 *
 * Reads `deployments/<chainid>.json`, fetches `eth_getCode` for every address it names, and holds
 * each one against the matching artifact in `out/`. It builds first, so the comparison is against
 * the tree you are standing in rather than whatever `out/` happened to hold.
 *
 * Immutables are the whole difficulty. `immutable` values are written INTO the runtime code at
 * construction, so the compiler's artifact carries zeros where the chain carries an address, and
 * a naive byte comparison differs on every contract here. The dishonest fix is to mask those
 * spans and stop looking. This tool does not mask them:
 *
 *   1. It reads the compiler's own `immutableReferences` — offset and length per immutable, from
 *      the build, not from a guess about where addresses live.
 *   2. It checks the artifact really does carry zeros there. A non-zero placeholder would mean
 *      the map does not say what this tool assumes it says.
 *   3. Every difference must fall inside one of those spans. One differing byte outside is a
 *      failure, and the tool prints its offset.
 *   4. It EXTRACTS each immutable's value from the chain and prints it. One immutable usually
 *      appears at many offsets, and all its copies must carry the same value — the compiler
 *      writes one value to every span, so copies that disagree are an anomaly, not a pass.
 *   5. Where a value is an address the record also names, it says which one. That is how
 *      `settlement.relayer()` and `executor.settlement()` get checked without an extra RPC call.
 *
 * ── Three verdicts, not two ───────────────────────────────────────────────────────────────────
 *
 *   ✓ IDENTICAL. Every byte matches outside the immutable spans, metadata trailer included.
 *     Exit 0.
 *
 *   ~ SAME PROGRAM, DIFFERENT BUILD. The only bytes differing outside the spans are inside the
 *     metadata trailer — the CBOR blob solc appends, which is a hash of the build inputs and is
 *     never executed. Every instruction matches. Exit 3.
 *
 *   ✗ DIFFERENT CODE. Bytes differ outside the spans and outside the trailer. Exit 1.
 *
 * The middle one is not a courtesy. Measured against chain 943 on 2026-09-04, from a worktree at
 * 9ff9265 — the commit whose record claims all seven match: every one of the eight contracts
 * matched instruction for instruction, and every one of the eight metadata hashes differed. Two
 * builds of this tree were then compared field by field, and `settings.remappings` was the only
 * field that moved. Solc hashes that field, and forge auto-detects it from two things nobody
 * thinks of as build inputs:
 *
 *   • whether `lib/openzeppelin-contracts` has its OWN submodules checked out. `git submodule
 *     update --init` gives one remapping set and `--init --recursive` gives another.
 *   • WHERE the repository is checked out. One remapping arrives context-prefixed with the
 *     absolute path of the checkout, so the same commit at a second path hashes differently.
 *
 * So a matching metadata trailer proves the sources, the compiler and the settings agree. A
 * differing one, with every instruction matching, means the build environment differed and says
 * nothing about the program. Collapsing the two into one verdict would either raise a false alarm
 * or hide a real one, so this tool refuses to collapse them.
 *
 * ── `--pin`: the verdict somebody wrote down ──────────────────────────────────────────────────
 *
 * The three exit codes answer "does the chain match the tree today". A nightly gate needs a
 * different question: "did anything move since a person last looked". Those two questions part
 * company the moment `master` legitimately runs ahead of a chain nobody wants to redeploy. On
 * 2026-09-16 three contracts on 943 differed in code for reasons written down and accepted, so the
 * plain exit code was 1 every night, for a reason nobody intended to fix. A gate that is red every
 * morning is a gate people stop reading.
 *
 * `--pin` reads `tools/bytecode-pin-<chainid>.json` and holds this run against it, contract by
 * contract. The pin names, per contract, the address, the verdict, the size on chain, a SHA-256 of
 * the whole runtime code, and a reason in prose. The run passes only when every contract still
 * reports what the pin says, and it fails on anything else — including a contract the record names
 * and the pin does not, and a pinned contract with an empty reason.
 *
 * It fails, therefore, on all of these:
 *
 *   • a redeploy, or any other change to the code at an address. The SHA-256 covers every runtime
 *     byte, immutables included, so it moves when the chain moves and at no other time.
 *   • a contract that stops matching. A relayer pinned as SAME PROGRAM turns red the day a commit
 *     changes its instructions.
 *   • a contract that starts matching. Drift that quietly heals is still news: it means the pin
 *     and the chain no longer describe the same world, and somebody has to re-read both.
 *   • an address added to or removed from the deployment record.
 *
 * It is silent about one thing on purpose: further drift in a contract the pin ALREADY calls
 * DIFFERENT CODE. That contract's own SHA-256 still guards the chain side, so the gate keeps its
 * grip on the deployment; what it stops doing is reddening every time ordinary work touches a
 * source file that was already known to run ahead of the chain.
 *
 * Re-pin by reading, not by pasting. Run with `--pin` and no pin file and this tool prints the
 * block it observed, reason fields left blank for a person to fill. A pin with no reason in it is
 * a pin nobody thought about, so the gate refuses one.
 *
 * ── Linked libraries ──────────────────────────────────────────────
 *
 * `ProveSettlement` delegatecalls the external library `FeeClaimLib`, so its runtime code carries
 * the library's ADDRESS at the offsets in the artifact's `linkReferences`. The record names the
 * library under `contracts.FeeClaimLib`. This tool writes that address into the artifact at every
 * link offset before comparing, reads what the chain actually embeds at the same offsets, and
 * fails if they differ: the settlement is wired to the library the record claims, and only that
 * one. The library is itself a contract in the record and is verified like the rest; its runtime
 * carries its own deploy address as an immutable, which must be the address the record names.
 * A record that names no address for a library the build links is NOT VERIFIABLE, not skipped.
 *
 * ── What ✓ proves ─────────────────────────────────────────────────────────────────────────────
 *
 *   • The runtime code at that address is byte-identical to what this tree compiles, everywhere
 *     except the spans the compiler itself declared immutable.
 *   • The metadata trailer matches, so the source files, the compiler version, the optimizer
 *     settings and the remappings are the same. Change a comment and this stops matching.
 *   • Each immutable holds one consistent value, and the named ones are the addresses the record
 *     says they are — so the contracts are wired to each other the way the record claims.
 *
 * ── What a green run does NOT prove ───────────────────────────────────────────────────────────
 *
 *   • Nothing about STORAGE. `owner`, `FeeDefaults` history, paused flags, balances: none of that is
 *     in the runtime code. Read those with `cast call`.
 *   • Nothing about the constructor. Its code is not part of the runtime, so an argument that
 *     went nowhere but storage leaves no trace here.
 *   • Nothing about an immutable this tool cannot name. It proves the value is CONSISTENT and
 *     prints it; whether an unnamed one is the right address is a question for a human.
 *   • Nothing about addresses the record does not list. It verifies what it was told about. A
 *     contract nobody wrote down is invisible to it.
 *   • Nothing about the chain. It asks one RPC endpoint and believes the answer.
 *   • Nothing about whether the source is GOOD. Identical to the build is not the same as right.
 *   • The trailer is data rather than instructions, and solc emits no jump into it. This tool
 *     does not prove that: it proves the instruction bytes are identical, and the jumps in
 *     identical instructions go to identical places.
 *
 * A red run means one of two things, and the tool cannot tell them apart: the address is running
 * different code, or the tree you are standing in is not the tree that was deployed. Check out
 * the commit the record names before concluding the first.
 */

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONTRACTS = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Where the pinned verdicts live, per chain.
 *
 * Deliberately NOT beside `deployments/<chainid>.json`. `app/scripts/check-addresses.ts` reads
 * every `*.json` in that directory and keys the result by the `chainId` each file declares, so a
 * second file naming chain 943 there would be parsed as a rival deployment record.
 */
const pinPathFor = (chainId) => join(CONTRACTS, 'tools', `bytecode-pin-${chainId}.json`)

/**
 * A record key that is not its own contract name.
 *
 * Both executors deploy a `ProveCallSink` template of their own. Both records name the second one
 * `ProveBatchExecutorCallSink` (T1-14, approved 2026-09-23; 369 used to say `ProveBatchCallSink`).
 * Naming the alias here beats guessing from the string: a key this map does not cover and `src/`
 * does not carry is reported as unverifiable rather than skipped.
 */
const ARTIFACT_ALIASES = {
  ProveBatchExecutorCallSink: 'ProveCallSink',
}

// ── Arguments ───────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { chainId: null, rpc: null, build: true, pin: false }
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]
    if (a === '--no-build') args.build = false
    else if (a === '--pin') args.pin = true
    else if (a === '--rpc') args.rpc = argv[++k]
    else if (a === '-h' || a === '--help') args.help = true
    else if (/^\d+$/.test(a)) args.chainId = a
    else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

/**
 * The endpoint, and never the whole of it on screen.
 *
 * The default gateway URL holds no key. An older URL, or one passed in, can carry its key in the
 * path, and printing it would put the key in a transcript. So the host and the last path segment
 * are all that is ever shown.
 */
function rpcFor(chainId, override) {
  const fromEnv =
    chainId === '369' ? process.env.PULSECHAIN_RPC : process.env.PULSECHAIN_TESTNET_RPC
  return override || fromEnv || `https://one.valve.city/rpc/evm/${chainId}`
}

/**
 * The gateway key goes in an `X-API-Key` header, never in the URL path: a path reaches access logs
 * and every upstream hop. The gateway answers 401 without the header. `PROVE_RPC_KEY` names the
 * key, and the public `vk_demo` is the default, so the nightly job runs with no arguments. The key
 * goes only to a valve host, so a third-party `--rpc` never receives it. It is never printed.
 */
function headersFor(url) {
  const headers = { 'content-type': 'application/json' }
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {}
  if (host === 'valve.city' || host.endsWith('.valve.city')) {
    headers['x-api-key'] = process.env.PROVE_RPC_KEY || 'vk_demo'
  }
  return headers
}

function redact(url) {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    const tail = parts.length ? `/…/${parts[parts.length - 1]}` : ''
    return `${u.host}${tail}`
  } catch {
    return '<unparseable endpoint>'
  }
}

// ── Chain ───────────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * One JSON-RPC call, with a wait for a rate limit.
 *
 * A whole deployment is seven or eight `eth_getCode` calls of twenty kilobytes each, back to
 * back, and the gateway answered 429 to the last of them on the first run of this tool. Giving up
 * there would have reported a contract as unverifiable when the only problem was the pace.
 */
async function rpc(url, method, params, attempt = 0) {
  const res = await fetch(url, {
    method: 'POST',
    headers: headersFor(url),
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (res.status === 429 && attempt < 5) {
    await sleep(1000 * 2 ** attempt)
    return rpc(url, method, params, attempt + 1)
  }
  if (!res.ok) throw new Error(`${redact(url)} answered HTTP ${res.status} to ${method}`)
  const body = await res.json()
  if (body.error) throw new Error(`${redact(url)} refused ${method}: ${body.error.message}`)
  return body.result
}

// ── Bytes ───────────────────────────────────────────────────────────────────────────────────

const strip = (hex) => (hex || '').replace(/^0x/, '').toLowerCase()

function toBytes(hex) {
  const s = strip(hex)
  const out = new Uint8Array(s.length / 2)
  for (let k = 0; k < out.length; k++) out[k] = parseInt(s.slice(k * 2, k * 2 + 2), 16)
  return out
}

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** Count differing hex characters, so a number here can be held against a record counting them. */
function nibblesDiffering(a, b) {
  const x = a.toString(16).padStart(2, '0')
  const y = b.toString(16).padStart(2, '0')
  return (x[0] !== y[0] ? 1 : 0) + (x[1] !== y[1] ? 1 : 0)
}

/**
 * The metadata trailer solc appends: a CBOR blob whose last two bytes are its own length.
 *
 * It hashes the sources and the compiler settings, so two builds that agree here agree on both.
 */
function metadataTrailer(bytes) {
  if (bytes.length < 2) return null
  const len = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1]
  if (len + 2 > bytes.length) return null
  return toHex(bytes.slice(bytes.length - len - 2))
}

// ── Artifacts ───────────────────────────────────────────────────────────────────────────────

function artifactFor(recordName) {
  const contract = ARTIFACT_ALIASES[recordName] || recordName
  const path = join(CONTRACTS, 'out', `${contract}.sol`, `${contract}.json`)
  if (!existsSync(path)) return null
  return { contract, path, json: JSON.parse(readFileSync(path, 'utf8')) }
}

/** Every byte offset the compiler declared immutable, and which immutable claims it. */
function immutableSpans(deployed) {
  const spans = []
  for (const [id, refs] of Object.entries(deployed.immutableReferences || {})) {
    for (const ref of refs) spans.push({ id, start: ref.start, length: ref.length })
  }
  return spans.sort((a, b) => a.start - b.start)
}

// ── The comparison ──────────────────────────────────────────────────────────────────────────

function compare(built, onChain, spans) {
  const result = {
    sizeBuilt: built.length,
    sizeOnChain: onChain.length,
    inside: 0,
    outside: 0,
    trailerBytes: 0,
    insideNibbles: 0,
    firstOutside: null,
    placeholdersNotZero: [],
    values: new Map(),
    inconsistent: [],
  }
  if (built.length !== onChain.length) return result

  const owner = new Array(built.length).fill(null)
  for (const span of spans) {
    const end = Math.min(span.start + span.length, owner.length)
    for (let k = span.start; k < end; k++) owner[k] = span.id
    // The artifact must carry zeros where an immutable goes. If it does not, this tool has
    // misread the map and every claim below it is worth less than it looks.
    for (let k = span.start; k < span.start + span.length && k < built.length; k++) {
      if (built[k] !== 0) {
        result.placeholdersNotZero.push({ id: span.id, offset: k })
        break
      }
    }
  }

  // Where the metadata trailer starts. Differences there are a different question from
  // differences in the instructions, and the two are counted apart.
  const trailer = metadataTrailer(built)
  const trailerFrom = trailer ? built.length - trailer.length / 2 : built.length

  for (let k = 0; k < built.length; k++) {
    if (built[k] === onChain[k]) continue
    if (owner[k] !== null) {
      result.inside++
      result.insideNibbles += nibblesDiffering(built[k], onChain[k])
    } else if (k >= trailerFrom) {
      result.trailerBytes++
    } else {
      result.outside++
      if (result.firstOutside === null) result.firstOutside = k
    }
  }

  // Read each immutable's value off the chain, and hold every copy of it against the first.
  for (const span of spans) {
    const value = toHex(onChain.slice(span.start, span.start + span.length))
    const seen = result.values.get(span.id)
    if (seen === undefined) result.values.set(span.id, value)
    else if (seen !== value) result.inconsistent.push({ id: span.id, at: span.start, value, seen })
  }
  return result
}

/**
 * Every place the build wants a linked library's address written into the runtime code.
 *
 * `linkReferences` is `{ file: { Library: [{ start, length: 20 }] } }`, in byte offsets into the
 * runtime code. The artifact carries a `__$…$__` placeholder at each, which is not hex, so it
 * cannot be compared until an address is put there.
 */
function linkSpans(deployed) {
  const spans = []
  for (const libs of Object.values(deployed.linkReferences || {})) {
    for (const [lib, refs] of Object.entries(libs)) {
      for (const ref of refs) spans.push({ lib, start: ref.start, length: ref.length })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

/**
 * The artifact's runtime hex with each library placeholder replaced by the address the record
 * names for that library. The substituted address is the RECORD's claim, so the comparison that
 * follows tests it: those 20 bytes sit outside every immutable span, and a chain that embeds any
 * other address differs there and is reported as different code.
 */
function linkedObject(deployed, record) {
  let hex = strip(deployed.object)
  for (const span of linkSpans(deployed)) {
    const address = strip(record.contracts?.[span.lib])
    if (!/^[0-9a-f]{40}$/.test(address)) return null
    hex =
      hex.slice(0, span.start * 2) + address + hex.slice((span.start + span.length) * 2)
  }
  return hex
}

/** A 32-byte immutable holding an address reads as twelve zero bytes and then twenty. */
function asAddress(value) {
  if (value.length !== 64) return null
  if (!/^0{24}/.test(value)) return null
  const addr = `0x${value.slice(24)}`
  return addr === '0x0000000000000000000000000000000000000000' ? null : addr
}

// ── The pin ─────────────────────────────────────────────────────────────────────────────────

/**
 * The whole runtime code as one number, immutables included.
 *
 * It moves when the code at an address moves, and at no other time. That is the one fact a gate
 * needs to say "the chain stood still", and it is independent of whatever this tree builds today.
 */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** The block a person fills in, printed when there is no pin file to read. */
function pinBlock(observed, chainId) {
  return {
    _comment:
      'What each address on this chain is expected to report, and why. Read the header of' +
      ' tools/verify-bytecode.mjs for what a verdict means and for what this pin does not prove.',
    chainId: Number(chainId),
    contracts: Object.fromEntries(
      observed.map((o) => [
        o.name,
        {
          address: o.address,
          verdict: o.verdict,
          onChainSize: o.onChainSize,
          onChainSha256: o.onChainSha256,
          why: '',
        },
      ]),
    ),
  }
}

/**
 * Hold this run against the verdicts somebody wrote down.
 *
 * Every field is compared, and each one catches a different event. The address catches an edit to
 * the deployment record. The SHA-256 catches a redeploy. The verdict catches a contract that stops
 * matching this tree, and equally one that starts matching it. The reason catches a pin nobody
 * thought about: an entry with an empty `why` is not a judgement, so it fails.
 *
 * Returns the faults as sentences. An empty array is a pass.
 */
function checkPin(observed, chainId) {
  const path = pinPathFor(chainId)
  const name = `tools/bytecode-pin-${chainId}.json`

  if (!existsSync(path)) {
    console.log(`There is no pin at ${name}. This run observed:`)
    console.log('')
    console.log(JSON.stringify(pinBlock(observed, chainId), null, 2))
    console.log('')
    console.log('Write a reason into every `why` before saving that as the pin. A reason is the')
    console.log('difference between a verdict somebody accepted and one nobody read.')
    return [`there is no pin at ${name}`]
  }

  const pin = JSON.parse(readFileSync(path, 'utf8'))
  const pinned = pin.contracts || {}
  const faults = []

  if (Number(pin.chainId) !== Number(chainId)) {
    faults.push(`the pin declares chain ${pin.chainId}, and this run asked chain ${chainId}`)
  }

  for (const o of observed) {
    const p = pinned[o.name]
    if (!p) {
      faults.push(`${o.name} is in the deployment record and in no pin. Nobody has judged it.`)
      continue
    }
    if (String(p.address).toLowerCase() !== o.address.toLowerCase()) {
      faults.push(`${o.name} is pinned at ${p.address}, and the record now names ${o.address}`)
    }
    if (p.verdict !== o.verdict) {
      faults.push(`${o.name} is pinned as ${p.verdict}, and reports ${o.verdict}`)
    }
    if (p.onChainSize !== o.onChainSize) {
      faults.push(
        `${o.name} is pinned at ${p.onChainSize} bytes on chain, and holds ${o.onChainSize}`,
      )
    }
    if (p.onChainSha256 !== o.onChainSha256) {
      faults.push(
        `${o.name} holds different code at ${o.address} than it did when somebody pinned it:\n` +
          `        pinned    ${p.onChainSha256}\n` +
          `        on chain  ${o.onChainSha256}`,
      )
    }
    if (!String(p.why || '').trim()) {
      faults.push(`${o.name} is pinned with no reason written next to it`)
    }
  }

  for (const key of Object.keys(pinned)) {
    if (!observed.some((o) => o.name === key)) {
      faults.push(`${key} is pinned, and the deployment record no longer names it`)
    }
  }
  return faults
}

// ── Report ──────────────────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.chainId) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
    process.exit(args.help ? 0 : 2)
  }

  const recordPath = join(CONTRACTS, 'deployments', `${args.chainId}.json`)
  if (!existsSync(recordPath)) {
    console.error(`No deployment record at deployments/${args.chainId}.json. Nothing to verify.`)
    process.exit(2)
  }
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  const url = rpcFor(args.chainId, args.rpc)

  if (args.build) {
    console.log('forge build …')
    execFileSync('forge', ['build'], { cwd: CONTRACTS, stdio: ['ignore', 'ignore', 'inherit'] })
  } else {
    console.log('out/ taken as it stands — pass no --no-build to rebuild first')
  }

  console.log(`chain      ${args.chainId}`)
  console.log(`record     deployments/${args.chainId}.json`)
  if (args.pin) console.log(`pin        tools/bytecode-pin-${args.chainId}.json`)
  console.log(`endpoint   ${redact(url)}`)
  console.log('')

  return run(record, url, args.chainId, args.pin)
}

async function run(record, url, chainId, pin) {
  const known = new Map()
  for (const [name, address] of Object.entries(record.contracts || {})) {
    known.set(address.toLowerCase(), name)
  }
  if (record.permit2) known.set(record.permit2.toLowerCase(), 'permit2')
  if (record.owner) known.set(record.owner.toLowerCase(), 'owner')

  const chainIdOnWire = await rpc(url, 'eth_chainId', [])
  if (parseInt(chainIdOnWire, 16) !== Number(chainId)) {
    console.error(`The endpoint answers chain ${parseInt(chainIdOnWire, 16)}, not ${chainId}.`)
    process.exit(2)
  }

  let failed = 0
  let unverifiable = 0
  let matched = 0
  let sameProgram = 0
  // One entry per address, in record order, whatever the outcome. `--pin` holds this against the
  // pin file; without `--pin` nothing reads it.
  const observed = []

  for (const [name, address] of Object.entries(record.contracts || {})) {
    const artifact = artifactFor(name)
    if (!artifact) {
      console.log(`\u2717 ${name}  ${address}`)
      console.log(`    NOT VERIFIABLE — no out/ artifact for it. This build does not carry the`)
      console.log(`    source, so nothing here can say what is at that address.`)
      console.log('')
      observed.push({
        name,
        address,
        verdict: 'not-verifiable',
        onChainSize: null,
        onChainSha256: null,
      })
      unverifiable++
      continue
    }

    const deployed = artifact.json.deployedBytecode
    const libSpans = linkSpans(deployed)
    const linkedHex = libSpans.length > 0 ? linkedObject(deployed, record) : null
    if (libSpans.length > 0 && linkedHex === null) {
      const missing = [...new Set(libSpans.map((l) => l.lib))].filter(
        (lib) => !/^0x[0-9a-fA-F]{40}$/.test(String(record.contracts?.[lib])),
      )
      console.log(`\u2717 ${name}  ${address}`)
      console.log(`    NOT VERIFIABLE — the build links ${missing.join(', ')}, and the record names`)
      console.log(`    no address for it under \`contracts\`. Record the library the deploy linked`)
      console.log(`    (it is in the broadcast file) and run this again.`)
      console.log('')
      observed.push({
        name,
        address,
        verdict: 'not-verifiable',
        onChainSize: null,
        onChainSha256: null,
      })
      unverifiable++
      continue
    }
    const built = toBytes(linkedHex ?? deployed.object)
    const onChain = toBytes(await rpc(url, 'eth_getCode', [address, 'latest']))
    await sleep(250)
    const onChainSha256 = sha256(onChain)
    const spans = immutableSpans(deployed)
    const r = compare(built, onChain, spans)

    const header = `${name}  ${address}`
    if (onChain.length === 0) {
      console.log(`\u2717 ${header}`)
      console.log('    NOTHING THERE — the address holds no code on this chain.')
      console.log('')
      observed.push({ name, address, verdict: 'no-code', onChainSize: 0, onChainSha256 })
      failed++
      continue
    }
    if (r.sizeBuilt !== r.sizeOnChain) {
      console.log(`\u2717 ${header}`)
      console.log(`    SIZE DIFFERS — built ${r.sizeBuilt} bytes, on chain ${r.sizeOnChain}.`)
      console.log('    Different code, or a tree that is not the one that was deployed.')
      console.log('')
      observed.push({
        name,
        address,
        verdict: 'different-code',
        onChainSize: r.sizeOnChain,
        onChainSha256,
      })
      failed++
      continue
    }

    // The library address the chain really embeds, read straight off the chain at every link
    // offset. Equal to the record's, or the code differs there and `r.outside` already says so;
    // this prints the fact and names a disagreement.
    const embedded = new Map()
    let libraryWrong = false
    for (const span of libSpans) {
      const value = `0x${toHex(onChain.slice(span.start, span.start + span.length))}`
      const list = embedded.get(span.lib) ?? []
      list.push(value)
      embedded.set(span.lib, list)
      if (value.toLowerCase() !== String(record.contracts[span.lib]).toLowerCase()) {
        libraryWrong = true
      }
    }

    const trailerBuilt = metadataTrailer(built)
    const trailerChain = metadataTrailer(onChain)
    // A library's own runtime carries its deploy address as an "immutable". It must be the
    // address the record names for it, or the record is describing some other contract.
    const selfWrong = (r.values.get('library_deploy_address') ?? null) !== null &&
      asAddress(r.values.get('library_deploy_address'))?.toLowerCase() !== address.toLowerCase()
    const sound =
      r.outside === 0 &&
      r.inconsistent.length === 0 &&
      r.placeholdersNotZero.length === 0 &&
      !libraryWrong &&
      !selfWrong
    const sameBuild = sound && trailerBuilt === trailerChain
    const mark = !sound ? '\u2717' : sameBuild ? '\u2713' : '~'
    const verdict = !sound ? 'different-code' : sameBuild ? 'identical' : 'same-program'
    observed.push({ name, address, verdict, onChainSize: r.sizeOnChain, onChainSha256 })

    console.log(`${mark} ${header}`)
    console.log(
      `    ${r.sizeOnChain} bytes, ${spans.length} immutable span(s) declared by the compiler`,
    )
    console.log(
      `    ${r.inside} byte(s) / ${r.insideNibbles} nibble(s) differ inside those spans`,
    )
    if (r.outside > 0) {
      console.log(
        `    DIFFERENT CODE: ${r.outside} instruction byte(s) differ,` +
          ` first at offset ${r.firstOutside}`,
      )
      console.log('    Different code, or a tree that is not the one that was deployed.')
    } else {
      console.log('    every instruction byte matches')
    }
    if (r.placeholdersNotZero.length > 0) {
      console.log(
        `    THE ARTIFACT DOES NOT CARRY ZEROS at immutable ${r.placeholdersNotZero[0].id}` +
          ` (offset ${r.placeholdersNotZero[0].offset}). Read this tool's header: the span map is`,
      )
      console.log('    not saying what the comparison assumes it says.')
    }
    for (const [lib, values] of embedded) {
      const ok = values.every((v) => v.toLowerCase() === String(record.contracts[lib]).toLowerCase())
      console.log(
        `    library ${lib} linked at ${values.length} offset(s): ${values[0]}` +
          (ok ? `  = the record's ${lib}` : '  DOES NOT EQUAL THE RECORD'),
      )
    }
    if (selfWrong) {
      console.log(`    LIBRARY ADDRESS IN ITS OWN CODE is not ${address}: the record names another.`)
    }
    for (const bad of r.inconsistent) {
      console.log(`    IMMUTABLE ${bad.id} DISAGREES WITH ITSELF at offset ${bad.at}:`)
      console.log(`      ${bad.seen}`)
      console.log(`      ${bad.value}`)
    }
    if (trailerBuilt === trailerChain) {
      console.log('    metadata trailer identical — same sources, compiler, settings, remappings')
    } else {
      console.log(
        `    metadata trailer differs in ${r.trailerBytes} byte(s) — a different BUILD of the` +
          ' same instructions.',
      )
      console.log('    Check nested submodules and the checkout path before the source; both')
      console.log('    feed the remappings that solc hashes. See this tool\'s header.')
    }
    for (const [id, value] of r.values) {
      const addr = asAddress(value)
      const named = addr ? known.get(addr.toLowerCase()) : undefined
      const label = named ? `  = ${named}` : ''
      console.log(`    immutable ${id.padEnd(6)} ${addr ?? `0x${value}`}${label}`)
    }
    console.log('')
    if (!sound) failed++
    else if (sameBuild) matched++
    else sameProgram++
  }

  console.log(
    `${matched} identical, ${sameProgram} same program from a different build,` +
      ` ${failed} different code, ${unverifiable} not verifiable.`,
  )
  console.log('')
  console.log('It proves the code, not the state. Storage — owner, FeeDefaults history, balances —')
  console.log('is not in the runtime and is not checked here. An unlabelled immutable is proved')
  console.log('consistent and printed, not proved correct. Read the header of this file for the')
  console.log('rest of what a green run does not say.')

  // With a pin the question changes. The exit codes below answer "does the chain match the tree
  // today", which a nightly gate cannot use once `master` legitimately runs ahead of a chain
  // nobody wants to redeploy. The pin answers "did anything move since a person last looked", and
  // that has two outcomes, not three.
  if (pin) {
    console.log('')
    const faults = checkPin(observed, chainId)
    if (faults.length === 0) {
      console.log(
        `Pinned: all ${observed.length} contract(s) report what` +
          ` tools/bytecode-pin-${chainId}.json says they should.`,
      )
      console.log('That is a judgement somebody made and dated, not a proof. Read the file.')
      process.exit(0)
    }
    console.log(`THE PIN NO LONGER DESCRIBES CHAIN ${chainId} — ${faults.length} fault(s):`)
    for (const f of faults) console.log(`    ${f}`)
    console.log('')
    console.log('Something moved. Read the run above, decide what it means, and only then edit')
    console.log(`tools/bytecode-pin-${chainId}.json. Re-pinning without reading defeats the gate.`)
    process.exit(1)
  }

  // Three outcomes, three exit codes. Folding the middle one into either neighbour would raise a
  // false alarm or hide a real one.
  if (failed > 0 || unverifiable > 0) process.exit(1)
  process.exit(sameProgram > 0 ? 3 : 0)
}

const started = main()
if (started instanceof Promise) {
  started.catch((e) => {
    // A caught error can carry a whole URL, and a gateway URL carries a key in its path.
    console.error(String(e.message || e).replace(/https?:\/\/\S+/g, '<endpoint redacted>'))
    process.exit(2)
  })
}

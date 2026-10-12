import { encodeFunctionData, type Abi, type Address, type Chain, type HttpTransport, type PublicClient } from 'viem'
import { rpcClient } from './client.js'
import { getChainId, isSupportedChain } from './config.js'
import { assertDeployedAbi } from './deployed.js'

/**
 * Batched chain reads. Multicall3 folds any number of view calls into one RPC round trip.
 * The contract is probed once per chain; a chain without it falls back to parallel single
 * reads, so callers never care which path ran.
 */

/** Multicall3, at the same address on every chain that has it. */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

const probes = new Map<number, Promise<boolean>>()

/**
 * Whether this chain has Multicall3, asked once and remembered.
 *
 * A failed probe is not an answer. It used to be cached as `false`, so one dropped request at
 * startup demoted every batch read for the life of the tab — a board poll that costs one round
 * trip quietly costing forty, for ever, with nothing on screen to say why. The same shape as
 * `CallResult`: only a reply gets remembered, and an unreachable endpoint gets asked again.
 *
 * Falling back to single reads while the answer is unknown is right — they work either way.
 */
function supported(client: PublicClient<HttpTransport, Chain>): Promise<boolean> {
  const id = client.chain?.id ?? getChainId()
  const known = probes.get(id)
  if (known) return known

  const p = client
    .getCode({ address: MULTICALL3 })
    .then((code) => !!code && code !== '0x')
    .catch(() => {
      // Forget it, so the next caller asks the chain rather than inheriting a dropped packet.
      probes.delete(id)
      return false
    })
  probes.set(id, p)
  return p
}

/** For tests, and for a chain switch, which makes an old probe meaningless. */
export const forgetMulticallProbes = () => probes.clear()

/**
 * One view call: the same shape viem's `readContract` takes.
 *
 * `functionName` is a plain `string` and that has already cost us something. Renaming three
 * getters on the settlement left two call sites asking for a name the contract did not have, and
 * nothing caught it: not the compiler, because any string satisfies this type, and not the tests,
 * because a failed read fell back to a constant whose values happened to equal the deployed
 * configuration exactly. It would have gone wrong the first time the owner moved a dial, and
 * looked like a chain problem when it did.
 *
 * Narrowing it to the ABI's own function names would make that a compile error, and it is worth
 * doing. It is not free: `Abi` here is the widened type, so the names would have to come from a
 * generic parameter threaded through `batchRead` and every caller, and `SETTLEMENT_ABI` is a
 * `const` array of 200-odd entries — inference over it is the kind of thing that makes a
 * type-check slow enough to notice. Nobody has done it, so no compiler check guards this field.
 *
 * One runtime guard covers part of the class. `batchRead` asks `assertDeployedAbi` about every
 * name before the call leaves, on any chain the registry knows. `deployed.ts` holds that guard,
 * and it reads a table of published-surface changes.
 *
 * So it catches only a name that table lists. Two other cases still reach the wire: a misspelt
 * name, and an old name called against a chain that already carries the rename. Both come back as
 * an ordinary `reverted`, because the chain finds no such selector and reverts with no reason. The
 * split below does not separate them from a real answer, and only the narrowing above would.
 */
export type Call = {
  address: Address
  abi: Abi
  functionName: string
  args?: readonly unknown[]
}

/**
 * A call either answered, or it did not — and *why* it did not is load-bearing.
 *
 * `reverted` is an answer: the chain ran the call and it failed. No code at the address, a pair
 * the factory does not list, a require that did not hold. Cache it, act on it, tell the user.
 *
 * `unreadable` is not an answer: the endpoint never said. A 429, a timeout, a dropped socket.
 * Nothing about the chain follows from it.
 *
 * These were one value for a long time and the difference kept leaking out as false statements
 * about market structure — "no pool trades this pair", "the pair holds no liquidity", "this chain
 * has no constant-product router" — each of them a rate limit wearing a fact's clothes, and the
 * last one cached for the life of the page. Three panels were patched one at a time before the
 * common cause turned out to be this type.
 */
export type CallResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'reverted' | 'unreadable' }

/**
 * The most calldata one `eth_call` to Multicall3 carries, in bytes, after `aggregate3` wraps
 * every call.
 *
 * viem's default chunk is 1,024 bytes of *inner* calldata, about six quote calls. Measured on
 * live 943 with 16 open offers: one board pass went out as 8 `eth_call`s at the same moment. The
 * endpoint limits each method per second, so 24 of 48 calls came back 429 over six back-to-back
 * passes, and half the quotes were lost.
 *
 * The ceiling is the gateway's request size. Measured on 943: it accepts a 100 KB JSON body and
 * refuses 104 KB with HTTP 413. The body is about twice the calldata, because the calldata is
 * hex. 40,000 bytes of calldata is about 80 KB of body, which leaves a 20% margin. Gas is not the
 * ceiling: a 60-leg quote chunk (22 KB of calldata) used 733,803 gas.
 */
export const MULTICALL_MAX_CALLDATA = 40_000

/** What `aggregate3` adds around each call: four 32-byte words, plus padding of the calldata. */
const CALL3_WORDS = 4 * 32 + 32

/**
 * The `batchSize` to give viem for these calls, so that no chunk passes `MULTICALL_MAX_CALLDATA`.
 *
 * viem counts only inner calldata, and the wrapping does not scale with it. A quote call of 164
 * bytes becomes 352 bytes, but a 4-byte `token0()` becomes 192 bytes, 48 times its size. One
 * fixed `batchSize` is therefore too small for quotes or too big for small getters. Measured:
 * 900 `balanceOf` calls fit a 32 KB inner limit and made a 394 KB body, which the gateway refused.
 *
 * So this uses the worst inner-to-wrapped ratio in the batch. A chunk that viem closes at
 * `batchSize` inner bytes then has at most `MULTICALL_MAX_CALLDATA` wrapped bytes, whatever mix
 * of calls it holds.
 */
function chunkBudget(calls: readonly Call[]): number {
  let ratio = 1
  for (const c of calls) {
    let inner: number
    try {
      inner = (encodeFunctionData(c as never).length - 2) / 2
    } catch {
      // viem sends a call it cannot encode as empty calldata and fails it. It adds no inner bytes.
      continue
    }
    ratio = Math.min(ratio, inner / (CALL3_WORDS + Math.ceil(inner / 32) * 32))
  }
  // Never 0: viem reads a `batchSize` of 0 as "no limit".
  return Math.max(1, Math.floor(MULTICALL_MAX_CALLDATA * ratio))
}

/**
 * Run every call, tolerate every failure, keep the order.
 *
 * One failure it does not tolerate, and cannot usefully report: a call the chain's own build has
 * no such function for. The chain answers that with a bare revert, which arrives here as an
 * ordinary `reverted` and reads on screen as market structure — the pair does not exist, the
 * contract said no. It is none of those things. It is this package calling a name the deployed
 * bytecode never carried, and it will fail the same way for ever.
 *
 * So `deployed.ts` is asked first, and a call it refuses throws with the reason instead of going
 * to the wire. See that file: chain 943 publishes the executors' `sink()` accessor under its old
 * name, and a build of this tree asks for `sinkTemplate()`.
 */
export async function batchRead(
  calls: readonly Call[],
  client: PublicClient<HttpTransport, Chain> = rpcClient(),
): Promise<CallResult[]> {
  if (calls.length === 0) return []
  // The client's own chain, exactly as `supported` reads it. A chain the registry never heard of
  // carries no deployment date, so there is nothing to hold it to.
  const id = client.chain?.id ?? getChainId()
  if (isSupportedChain(id)) for (const c of calls) assertDeployedAbi(c.functionName, id)
  if (await supported(client)) {
    try {
      const out = (await client.multicall({
        contracts: calls as never,
        allowFailure: true,
        multicallAddress: MULTICALL3,
        batchSize: chunkBudget(calls),
      })) as readonly { status: 'success' | 'failure'; result?: unknown; error?: unknown }[]
      // Do not read a returned multicall as proof that the transport worked. viem splits the
      // calls into chunks of about 1 KB and sends each chunk as its own `eth_call`. With
      // `allowFailure`, a rejected chunk does not throw: viem marks every call in it `failure`.
      // This line used to call each of those a revert, so a 429 became "no route" on the board.
      return out.map(
        (r): CallResult =>
          r.status === 'success'
            ? { ok: true, value: r.result }
            : { ok: false, reason: chunkRejected(r.error) ? 'unreadable' : failureKind(r.error) },
      )
    } catch {
      /* fall back to parallel single reads below */
    }
  }
  return Promise.all(
    calls.map((c) =>
      client
        .readContract(c as never)
        .then((value): CallResult => ({ ok: true, value }))
        .catch((e): CallResult => ({ ok: false, reason: failureKind(e) })),
    ),
  )
}

/**
 * Did viem reject the whole chunk that held this call?
 *
 * viem 2.55 gives every call in a rejected chunk the same error: the failed `readContract` of
 * Multicall3's `aggregate3`. Measured through viem's own `multicall` over a stubbed `fetch`:
 *
 *   429     ContractFunctionExecutionError, function name aggregate3, contract address MULTICALL3
 *             → CallExecutionError → LimitExceededRpcError → RpcRequestError
 *
 * A call that ran carries its own function name instead. A rejected chunk is never an answer
 * about the call, even when `aggregate3` itself reverts (for example, out of gas). So this test
 * comes before `failureKind`, which reads a revert anywhere in the chain as the chain answering.
 */
function chunkRejected(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { functionName?: unknown; contractAddress?: unknown }
  return (
    e.functionName === 'aggregate3' &&
    typeof e.contractAddress === 'string' &&
    e.contractAddress.toLowerCase() === MULTICALL3.toLowerCase()
  )
}

/**
 * Did the chain answer, or did the endpoint fail to ask it?
 *
 * The outermost error is no help: viem wraps both cases in `ContractFunctionExecutionError`, so
 * the name at the top describes the *call*, not what went wrong. Measured, both chains in full:
 *
 *   dead host   ContractFunctionExecutionError → CallExecutionError → HttpRequestError
 *                 → TypeError "fetch failed" → Error "bad port"
 *   no code     ContractFunctionExecutionError → ContractFunctionZeroDataError
 *                 → AbiDecodingZeroDataError
 *
 * An earlier version of this matched `ContractFunctionExecution` as a revert and so called a dead
 * socket an answer — which is the exact bug it was written to prevent.
 *
 * So it asks for positive evidence that bytes came back, and treats everything else as
 * unreadable. Those classes only exist because the node replied: zero data from an address with
 * no code, or a revert carrying a reason. Defaulting the other way is what prints a falsehood —
 * a revert mistaken for a rate limit costs one retry, a rate limit mistaken for a revert gets
 * cached and repeated as a fact.
 */
function failureKind(error: unknown): 'reverted' | 'unreadable' {
  const names: string[] = []
  const messages: string[] = []
  const seen = new Set<unknown>()
  let e: unknown = error
  while (e && typeof e === 'object' && !seen.has(e)) {
    seen.add(e)
    names.push(String((e as { name?: unknown }).name ?? ''))
    messages.push(String((e as { message?: unknown }).message ?? ''))
    e = (e as { cause?: unknown }).cause
  }
  const name = names.join(' ')
  const message = messages.join(' ')

  // A call inside a multicall that returned: viem reports a revert as
  // `ContractFunctionRevertedError → RawContractError`, and an address with no code as
  // `ContractFunctionZeroDataError → AbiDecodingZeroDataError`. The patterns below match both.
  // A failure with no error at all is not evidence of a reply, so it falls through to unreadable.
  if (/ContractFunctionReverted|ZeroData|AbiDecoding|RawContractError/.test(name)) return 'reverted'
  if (/execution reverted|returned no data/i.test(message)) return 'reverted'
  return 'unreadable'
}

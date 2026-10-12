# @prove.cash/sdk

The prove.cash protocol, without a browser.

prove.cash settles swaps from signed intents. A maker signs terms — sell this much of token A,
receive at least this much of token B, before this time. The signature travels over
[msgboard](https://msgboard.xyz), which charges proof of work instead of gas, so an intent can
reach the world before its maker has ever touched the chain. Anybody who reads it can verify it
and fill it against the `ProveSettlement` contract.

This package is every part of that except the user interface:

- the `Intent` type, its EIP-712 domain, and the packed binary wire codec
- the network registry, endpoint resolution, and the settlement-address resolver
- the msgboard client and the Hasura archive client
- settlement reads and writes — quote, fillability, fill, fillBatch — and the
  Multicall3 batching underneath them; `available` and the explain helpers live on `ProveReader`
- fee configs: `hashFeeConfig`, the three take points, `claimFees`, `readFeeDefaults`
- an indexed intent store with pluggable storage: IndexedDB in a tab, a Map in a solver

Nothing here touches `window`, React, or the DOM. The proof-of-work grind runs headless by
default. The web app at [prove.cash](https://prove.cash) is a consumer of this package like any
other; it adds only a wallet, a worker, and the screen.

## Install

```sh
npm install @prove.cash/sdk viem
```

`viem` is a peer dependency, so you keep one copy of it. The package is ESM only.

Import the root for everything, or a subpath for one concern:

```ts
import { encodeIntent } from '@prove.cash/sdk'
import { encodeIntent } from '@prove.cash/sdk/intent'
```

Subpaths: `intent`, `config`, `client`, `board`, `submit`, `archive`, `store`, `settlement`,
`solver`, `market`, `multicall`, `tokens`, `tokenlist`, `custody`, `keepalive`, `kv`.

## Which chain, which endpoints

Everything defaults to one selected chain and its endpoints, so you rarely pass them:

```ts
import { setChainId, setRpc, setRpcLinked, setSettlementOverride } from '@prove.cash/sdk'

setChainId(943)                                    // 369 mainnet, 943 testnet
setRpcLinked(false, 943)                           // let the two endpoints differ
setRpc('https://my-node/rpc', 943, 'board')        // needs the msgboard_ module
setRpc('https://my-node/rpc', 943, 'chain')        // any PulseChain node
setSettlementOverride(943, '0x…')                  // point at a fork, for a devnet run
```

`settlement(chainId)` is the only place an address comes from. `domain()`, `verifyIntent()`,
`intentHashOf()` and every write go through it, so an override moves all of them at once.

Preferences live behind a small key-value seam: `localStorage` in a browser, a Map in Node. Give
it your own store with `setKeyValueStore()` if you want them on disk.

## Example 1 — sign an intent

```ts
import { parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  CURVE_LINEAR, FLAG_PARTIAL, ZERO, ZERO_HASH, encodeIntent, intentHashOf, setChainId,
  signIntent, type Intent,
} from '@prove.cash/sdk'

setChainId(943)
const maker = privateKeyToAccount(process.env.MAKER_KEY as `0x${string}`)
const now = BigInt(Math.floor(Date.now() / 1000))

const intent: Intent = {
  maker: maker.address,
  recipient: maker.address,
  tokenIn: '0x70499adEBB11Efd915E3b69E700c331778628707',   // WPLS on 943
  tokenOut: '0x8a810ea8B121d08342E9e7696f4a9915cBE494B7',  // PLSX on 943
  amountIn: parseUnits('1000', 18),
  minOutStart: parseUnits('520', 18),   // the price falls from here…
  minOutEnd: parseUnits('480', 18),     // …to here, linearly, a dutch auction
  startTime: now,
  endTime: now + 3600n,                 // an hour is the app's advice, not a contract rule
  executor: ZERO,                       // anybody may fill it
  feeConfig: ZERO_HASH,                 // no config named: the offer charges nothing at any point
  feeRateIn: 0n,                        // P1, taken from the handover (tokenIn)
  feeRate: 0n,                          // P2, paid on top of the maker's number (tokenOut)
  feeRateProceeds: 0n,                  // P3, out of the maker's proceeds (tokenOut)
  minFill: 0n,                          // no floor under a partial fill
  authNonce: ZERO_HASH,                 // only the EIP-3009 rung reads this
  flags: FLAG_PARTIAL,                  // a smaller fill is allowed
  nonce: BigInt(Date.now()),
  curve: CURVE_LINEAR,                  // the straight line between the two prices
}

// A zero feeConfig can only be signed as a raw digest, which a local key can do. A wallet cannot:
// no EIP-712 struct hashes to zero, so a wallet-signed offer names a config (even at rate 0) and
// passes its preimage: signIntent(wallet, intent, { preimage: singleFeeConfig(destination) }).
const signature = await signIntent(maker, intent)

const payload = encodeIntent({ ...intent, signature })
console.log(intentHashOf(intent), payload)
```

`intentHashOf` is the value `hashIntent` returns on chain. An escrow deposit keys on it, and an
EIP-3009 authorization must carry it as its nonce.

**Fees.** An intent names a fee config by its hash (`feeConfig`) and three rates, one per take
point. `maxFeeRate` bounds P1 + P2, the two the filler bears. `claim(config, token)` pays what is
booked under a config to its destinations by weight, and needs the preimage
(`announceFeeConfig` logs one). `FeeDefaults` publishes the suggested config and rates; it is read
at signing and never at fill. The wire codec is version 5: older board posts do not decode.
A post may carry its config's preimage (an optional block flagged in the `P_FEE_EXT` byte, 21 bytes
for one destination). `decodeIntent` drops a post whose block does not hash to its `feeConfig`;
`readIntent(data, chainId)` (async; null unless it decodes and the signature verifies) only then
remembers the preimage in a bounded wire store, never in the signing guard, so
`feeConfigPreimageOf(hash)` and `claimFeesFor(...)` can pay a config without a chain read.
`withWirePreimage(signed, ships)` attaches the block for a config `ships` says a reader
cannot already know. See `docs/FEE-MODEL.md`, "The preimage block".

**Nothing on chain bounds the window.** `MAX_WALLET_WINDOW` and both of `_termsOk`'s time
bounds went in `a7c5d7f`, so the maker decides how long their own signature stands. A wallet
signature that outlives its author's attention is a real hazard — revoke an allowance, restore it
later, and every signature made against it wakes up — but the loss falls on the maker who signed,
so the contract does not refuse it. The app carries the advice instead:
`SUGGESTED_WALLET_WINDOW_S`, one hour, and `adviceOf` returns `zombie` for a signature past it.
An escrowed intent rests as long as it likes, because `withdraw` is a real off switch; an ERC-20
approval the maker revokes is not. An EIP-3009 authorization carries its own `validBefore`, and
the token enforces that.

The maker still has to make token A spendable. Approve the relayer (`approveRelayer`), commit the
funds to this intent (`deposit`, with `FLAG_ESCROW` set), or sign a `receiveWithAuthorization`
(`signAuthorization`) so the fill funds the escrow itself.

**Approve `ProveRelayer`, never `ProveSettlement`.** The settlement holds no allowance of any
kind, so an approval to it does nothing until a fill reverts. The settlement deploys the relayer
and hands it out as `relayer()`; `approvalTarget()` reads it from there, and every approval helper
in this package goes through that call. Never carry the address in configuration.

`deposit` takes the whole intent rather than its hash, and that is a security property. The board
publishes an intent's hash before any reservation exists, so a function keyed on the bare hash let
the first caller claim the slot.

`withdrawReservation` gives the escrow back in one transaction, whenever the maker likes. There is
no unlock step and no window that shuts. It also cancels the intent, so a maker who takes the
money out does not need to `cancel` as well — and nobody can fund that intent again.

## Example 2 — publish it to the board

```ts
import { board, difficultyFor, postToBoard, setRpc } from '@prove.cash/sdk'

setRpc('https://one.valve.city/rpc/vk_demo/evm/943', 943)

const client = board()
const status = await client.status()
console.log(`work threshold for this payload: ${difficultyFor(payload, status)}`)

const hash = await postToBoard(payload, client)
console.log(`on the board as ${hash}`)
```

The grind happens inside `postToBoard`, in this process. In a browser, hand `board()` a
`stamper` that posts to a web worker and the UI thread stays free.

The board keeps roughly the last 120 blocks, so a live intent needs posting again as it ages
out. Re-posting costs a fresh grind and nothing else — the maker never signs twice, and anybody
may do it:

```ts
import { keepAlive, remember } from '@prove.cash/sdk'

remember(payload)                                  // take responsibility for it
await keepAlive(keysOnTheBoardRightNow, (data) => postToBoard(data))
```

## Example 3 — find and fill intents as an executor

```ts
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  PROVECASH_CATEGORY, board, createIntentStore, decodeIntent, edgeOf, executeFills, intentKey,
  memoryStorage, network, quoteAll, readAvailable, setChainId, simulateFills, verifyIntent,
} from '@prove.cash/sdk'

setChainId(943)
const chainId = 943
const executor = privateKeyToAccount(process.env.EXECUTOR_KEY as `0x${string}`)
const wallet = createWalletClient({
  account: executor,
  chain: network(chainId).chain,
  transport: http(),
})

// 1. Read the board, verify every signature yourself, and remember what you saw.
const store = createIntentStore(memoryStorage())
const messages = (await board().content({ category: PROVECASH_CATEGORY }))[PROVECASH_CATEGORY] ?? []
const now = Math.floor(Date.now() / 1000)

for (const m of messages) {
  const intent = decodeIntent(m.data)
  if (!intent || !(await verifyIntent(intent, chainId))) continue
  await store.ingest(chainId, {
    intent,
    data: m.data,
    msgHash: m.hash,
    blockNumber: BigInt(m.blockNumber),
    firstSeenAt: now,
    source: 'live',
    decimalsIn: 18,
    decimalsOut: 18,
  })
}

// 2. Ask the store your question. Live, open to anyone, partial fills allowed.
const { rows } = await store.query({
  chainId,
  liveAt: now,
  executor: { open: true, address: executor.address },
  partialOnly: true,
  limit: 50,
})

// 3. Price them all in one multicall, and keep the ones the market pays for.
const quotes = await quoteAll(
  rows.map((r) => ({
    key: r.key,
    tokenIn: r.tokenIn as `0x${string}`,
    tokenOut: r.tokenOut as `0x${string}`,
    amountIn: BigInt(r.amountIn),
  })),
)

for (const row of rows) {
  const intent = decodeIntent(row.data as `0x${string}`)!
  const edge = edgeOf(intent, quotes.get(row.key), BigInt(now))
  if (!edge || edge.spreadPct < 0.5) continue

  // 4. Only the chain decides fillability. The store only remembers.
  const { remaining, live } = await readAvailable(intent, { chainId })
  if (!live || remaining === 0n) continue

  // 5. Simulate before you spend. An executor should never pay to learn an intent went stale.
  const plan = { mode: 'direct' as const, fills: [{ intent, take: remaining }] }
  const sim = await simulateFills(executor.address, plan, { chainId })
  if (!sim.ok) {
    console.log(`${intentKey(intent)} skipped — ${sim.reason}`)
    continue
  }

  const tx = await executeFills(wallet, executor.address, plan, chainId)
  console.log(`filled ${intentKey(intent)} in ${tx}`)
}
```

Set the plan's `mode` to `'batch'` and give it several fills to go through `fillBatch`, which
steps over anything that has gone stale rather than reverting the lot. `'callback'` hands token A
to a contract of yours mid-fill, `'credit'` does the same for a whole batch at once, and
`'authorization'` lets the maker's EIP-3009 signature fund the escrow at fill time.

Both callback modes call the caller, so an EOA cannot use them: there is no code to call back.
`ProveExecutor` is that code, deployed once for everyone — unowned, permissionless, holding
nothing. Hand it a venue and a calldata blob and it sells the maker's token A there, pays the
maker, and gives you the difference. This package does not bind it yet.

You need an allowance on token B before any of this: `approveRelayer(wallet, account, tokenOut,
amount)`. It goes to the relayer, like the maker's. One address, one approval, whichever side you
are on.

## The shape of the fall

`minOutStart` is the ceiling, `minOutEnd` is the floor, and `curve` says where between them the
price sits at each moment. `CURVE_LINEAR` — thirty-two zero bytes — is the straight line from one
to the other, which is what every intent signed before the field existed.

Two bits of `flags` pick the reader. `KIND_STRETCH` reads the first four bytes of the word as one
fall with a flat region either side of it, and `stretchCurve` packs them from two fractions of the
window:

```ts
import { KIND_STRETCH, stretchCurve } from '@prove.cash/sdk'

const dutchThenRest = { ...intent, flags: FLAG_PARTIAL | KIND_STRETCH, curve: stretchCurve(0, 0.25) }
const waitThenDutch = { ...intent, flags: FLAG_PARTIAL | KIND_STRETCH, curve: stretchCurve(0.5, 0) }
```

The first falls to the floor over the opening quarter of the window and rests there. The second
holds the ceiling for half the window and then falls to the close — a length of zero means "to the
end of the window". `breakpointsOf` names the instants a curve turns at, which is what a solver
needs to search a window it cannot assume one shape for.

`KIND_KNOTS` and `KIND_CUBIC` are reserved. Nothing implements them, and an intent that names one
prices as the straight line on chain and here.

## The quote is the contract's

`minOutAt`, `grossOut` and `quote` are the Solidity implementation, transcribed. They are
pinned to it by a fixture that `contracts/test/Fixture.t.sol` writes and CI refuses to let drift.
The fixture samples the curve in every region and either side of both corners, so a mirror that
agrees only at the ends fails it. `readQuote`, `readAvailable` and `readFillability` ask the chain
the same questions when only the chain will do.

## Storage

The intent store keeps the raw board payload, so any record can go back on the board without a
new signature. Amounts stay as decimal strings; the derived `rate` float exists only so range
queries never decode bigints.

```ts
import { createIntentStore, indexedDbStorage, memoryStorage, autoStorage } from '@prove.cash/sdk'

createIntentStore(memoryStorage())        // a solver, a test, a script
createIntentStore(indexedDbStorage())     // a browser tab
createIntentStore(autoStorage())          // IndexedDB where it works, a Map where it does not
```

`ingestIntent`, `queryIntents` and `pairDepth` are bound to a shared `autoStorage()` store.
Replace it with `setDefaultStore()`, or hold your own store and call its methods.

Write your own backend against the `IntentStorage` interface — four methods — and the whole query
layer runs on it unchanged.

## The solver

`@prove.cash/sdk/solver` finds the cycles of intents that pay for each other and settles them in
one `fillBatch`. Two makers going opposite ways on a pair need not agree on a price; between them
they only have to concede par, plus the executor's gas and a wei or two of rounding. The protocol
rate is not part of that sum: the settlement takes the fee out of each maker's own number, so the
executor pays the gross whatever rate an intent signed.

```ts
import {
  loadBook, loadPools, loadPrices, solve, selectFeasible, groupsFromBook,
  simulateRing, withSimulatedGas, executeRing, upcoming,
} from '@prove.cash/sdk/solver'

const { book } = await loadBook(intents, { executor })   // the chain decides what is fillable
const plans = selectFeasible(solve(book, {
  at: now, executor, gasPrice, prices: await loadPrices(book.tokens),
  pools: await loadPools(pairs),                          // optional: close through PulseX
}), { groups: groupsFromBook(book) })                     // one maker's balance is one budget

const sim = await simulateRing(plans[0], { account: executor })
if (sim.ok) await executeRing(wallet, withSimulatedGas(plans[0], sim.gas, prices, gasPrice), { account: executor })
```

### What a solver can reach, and what can settle together

A maker who signed and sent nothing is still a leg. `FillRequest.arming` carries their EIP-3009
authorization or their EIP-2612 permit, and the solver supplies it — so `EscrowShort` from
`fillability` means "needs arming" on a leg the solver holds a signature for, not "dead".
`loadBook` keeps those legs, with the bytes, and rejects only what no signature rescues.

Two legs are then not independent when they share `(maker, tokenIn)`. One maker's balance is
shared across every intent they signed against that token, and their EIP-2612 nonces are a queue:
drop the earlier permit leg from a chosen set and the later one's signature no longer matches any
nonce the token will hold. `selectFeasible` partitions on that key, enumerates inside a partition,
and leaves everything else to the greedy walk `selectDisjoint` always did.

`dryRun` is the last word. It walks the real path, arms for real, and reverts with one reason per
leg, which is the only way to learn whether a permit landed or a redemption fell short. `confirm`
asks it and `bisect` halves a refused set rather than re-enumerating.

`solve` is a pure function from a book and a timestamp to a ranked list of plans. Every number it
needs from the chain — the pool reserves, the gas price, the native prices — is an
argument, so the hard cases are ordinary unit tests.

The Dutch curve only ever moves in the executor's favour, so a ring that misses the boundary now
is a ring to wait for. `upcoming(book, params, horizon)` says which rings those are and the
second each one opens; `profitableFrom(ring, book, params)` answers for one.

Sizing is exact integer arithmetic against `remaining`, reproducing the contract's `ceilDiv` step
for step. Rounding runs against the executor at every leg, so a ring that clears by a wei in
rational arithmetic can still fail — the estimate bounds the size, the integer chain decides it,
and the simulation overrules them both. An intent without `FLAG_PARTIAL` pins its leg to exactly
its remaining amount; two pinned legs almost never agree, and the sizer says so.

`skipInvalid` is false and not configurable. Settling part of a cycle leaves the solver holding
an unhedged position, so a ring is atomic or it is nothing. A leg that closes through PulseX is
the exception and says so: `plan.atomic` is false, because the swap is a second transaction.

`app/scripts/solver.ts` is a runnable bot over this. `app/scripts/solver-devnet.ts` runs the whole
thing against a fork of mainnet, with real pools and freshly deployed contracts.

## Development

```sh
npm ci
npm run build        # tsc, ESM plus declarations, into dist/
npm test             # vitest, including the Solidity fixture test
npm run typecheck
npm run lint
```

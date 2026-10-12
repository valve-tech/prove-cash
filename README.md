# prove.cash

Sign a swap offer instead of sending a transaction.

The offer says: *take up to X of token A from me, and you must give me at least
Y of token B.* You sign it in the browser — no gas, nothing on-chain. The signed
offer travels over the `msgboard_` module that PulseChain nodes run, where
posting costs proof of work rather than a fee. Anyone who sees it can execute it
and keep the difference between your rate and the market rate.

The name is the feature. An offer is **proven** when the tokens are committed —
reserved against that one intent in escrow, or under a single-use transfer
authorization that names it. It is **unproven** when the tokens sit in the
maker's wallet under an allowance that can vanish. A maker takes escrowed money
back in one transaction, and that withdrawal ends the offer for good.

## Status

The contracts are live on testnet (943) and, since 2026-08-22, on mainnet (369).
`RfqVenue` and `ProveBatchExecutor` followed on 2026-08-25, so the deployment is eight
addresses now. `contracts/deployments/369.json` records all of them, and
`test/Live369.t.sol` checks every pointer between them against the chain itself.

The bots run on mainnet. A heartbeat makes a small book, an executor fills what
pays, and a watchdog checks every fill against the signed terms. They reach the
contracts through a `SETTLEMENT` environment variable, not the registry.

The app still does not. Its registry reads a zero settlement for 369, so the
site goes on saying mainnet is not deployed and no visitor can reach those
contracts. That is deliberate. Switching it turns escrow on for everyone, and it
is a decision rather than a step.

The float behind the mainnet book is deliberately small: $5 each of WPLS, PLSX
and DAI to the maker. The executor needs none of it any more — it fills through
`ProveExecutor`, which releases the maker's token A, sells it at PulseX inside
the same transaction, and pays the maker out of the proceeds. Gas is the whole
requirement. `--inventory` brings the old path back. Both accounts derive from
the mainnet deployer, which is a different key from the testnet one, so a
testnet bot key cannot move real money.

Working today:

- sign an intent (EIP-712), encode it to packed binary — around 175 bytes —
  grind the proof of work in a worker, post it to the board
- read the board, decode, verify every signature locally, show funding and the
  spread against PulseX
- keep every verified sighting in IndexedDB, so the book survives a reload and
  an intent that ages off the board stays visible with an off-board mark
- backfill the same book from the public msgboard archive, page by page
- keep your own intents alive as the board ages them off — and so may anyone
  else, because the payload carries the maker's signature
- pick the strongest custody mode the token supports, with each rung's cost in
  signatures and transactions on the button
- point the board and the chain at two different RPCs, or lock them together
- a heartbeat bot that runs the whole path on a timer
- the execution UI — direct, batch, authorization and callback fills, each armed
  only by a clean `eth_call`, each disabled while the settlement address is zero
- the Mine tab — every intent this wallet signed, the escrow behind it, and one
  withdraw button that returns the money and ends the offer
- `scripts/executor.ts` — prices the board against PulseX, fills what pays, and
  asserts after every fill that the maker received at least the rate they signed
- `scripts/solver.ts` — finds the rings of intents that pay for each other and
  settles each ring in one `fillBatch`
- `scripts/watchdog.ts` — watches the board, the signatures, the archive, and
  every `Filled` event, recomputing what was owed from the signed terms rather
  than trusting the event

The bots degrade honestly with no settlement address. The executor says so and
exits; the watchdog turns off its fill checks and keeps watching everything
else.

The contracts, written, tested and audited:

- `ProveSettlement` — EIP-712 intents, three custody modes (approval, escrow
  reserved against one intent hash, and an EIP-3009 authorization that funds
  that reservation just in time), partial fills, dutch decay, direct fills,
  batch fills, callback fills for executors with no inventory, on-chain cancel,
  ERC-1271 contract makers, and a `fillability` view that tells the UI why a row
  is not fillable. A maker withdraws escrow in one call, and the withdrawal
  cancels the intent. Nothing on chain bounds how long an intent runs:
  `MAX_WALLET_WINDOW` and both `_termsOk` time bounds went in `a7c5d7f`, so the
  maker decides how long their own signature stands. The app advises an hour for
  a wallet rung and does not block.
- `ProveRelayer` — **the address makers and executors approve.** The settlement
  holds no allowance of any kind and approving it does nothing. The settlement
  deploys the relayer in its own constructor and hands it out as `relayer()`, so
  read the address from there rather than carrying it in configuration.
- `ProveExecutor` — public, unowned and permissionless. It fills with no
  inventory: it sells the maker's token A at any venue the caller names, pays
  the maker, and gives the caller the difference.
- `ProveCallSink` — makes that arbitrary call, so `ProveExecutor` never does.
  The address that calls a stranger is then not an address anyone would approve.

- `FeeSink` — one fee destination and one minimum rate, fixed for all time. No
  owner, and it holds no token. The owner registers it once, and a fee-charging
  offer must name one; `claim` pays its destination. The old burner `FeeSink`
  came out on 2026-09-03: burning is rented from PulseX, not built here.

A security audit on 2026-08-11 found one critical and one high finding, plus six
smaller ones. All were fixed. Two of the eight were `FeeSink` findings and their
regression tests left with the contract; `docs/AUDIT-SCOPE.md` records both.
`contracts/test/Security.t.sol` holds a
regression test for each. An economics review followed with six more findings;
`contracts/test/EconAudit.t.sol` holds those the same way. The design spec
records what each attack was and why the fix looks the way it does.

## Layout

```
sdk/                  @prove.cash/sdk — the protocol, with no React and no DOM
  src/config.ts       the network registry, endpoints, the settlement resolver
  src/intent.ts       Intent type, EIP-712 domain, the wire codec
  src/board.ts        msgboard client, category, post and read
  src/store/          the intent store, over IndexedDB or a plain Map
  src/archive.ts      older posts from archive.msgboard.xyz
  src/settlement.ts   fill paths, quotes, reservations, fee parameters
  src/custody.ts      EIP-3009 detection and the authorization typed data
  src/solver/         ring matching over the book, and the plans it produces
app/                  React app — Vite, TypeScript, viem, Tailwind
  src/lib/board.ts    the proof-of-work worker behind the SDK's stamper seam
  src/lib/wallet.ts   the browser wallet, and the client every SDK write takes
  src/lib/settlement.ts  the SDK's writes, bound to that wallet
  scripts/live-post.ts  post one real intent and read it back
  scripts/heartbeat.ts  keep a board alive and prove the path still works
  scripts/executor.ts   fill what pays, then check the maker was paid
  scripts/solver.ts     settle rings of intents that pay for each other
  scripts/watchdog.ts   watch the board, the archive and every fill
contracts/            Foundry — Solidity 0.8.30, via-IR, evm_version paris
  src/ProveSettlement.sol  intents, custody, fill accounting
  src/ProveRelayer.sol     the address everyone approves, and its one function
  src/ProveExecutor.sol    fill from any venue, holding no inventory
  src/ProveCallSink.sol    the address that makes the executor's arbitrary call
  src/FeeSink.sol          one fee destination and its floor, immutable
  test/                    649 offline tests, and 30 that need a mainnet RPC
  test/Security.t.sol      a regression test per security-audit finding
  test/EconAudit.t.sol     the same for the economics review
  test/Fork.t.sol          the source, against real liquidity at a pinned block
  test/Live369.t.sol       the mainnet deployment itself, at the chain head
  test/Gas.t.sol           what each fill path costs
  script/Deploy.s.sol      deploys the settlement, the executor and the fee
                           sinks from config/<chainid>.json
  config/369.json          every address the contracts need, one file per chain
  deployments/369.json     and what came out of deploying with it
  lib/                     forge-std and openzeppelin-contracts, pinned
                           submodules
.github/workflows/ci.yml   build, test, coverage and gas on every push
docs/specs/    the design spec
```

`contracts/lib` holds two git submodules, so clone with them:

```sh
git clone --recurse-submodules <url>
```

No address is compiled into the contracts. The owner, `defaultProceeds` and
Permit2 are all constructor arguments, read from the per-chain config file, and
any of them can be overridden by an environment variable at deploy time. The
deploy stops rather than inventing a value for the last two.

## Run it

The app consumes `@prove.cash/sdk` over a `file:` link, so build the SDK first.

```sh
cd sdk && npm install && npm run build
cd ../app && npm install
npm run dev
```

Check the whole path against a real board:

```sh
npx tsx scripts/live-post.ts
```

Keep a testnet board populated:

```sh
npx tsx scripts/heartbeat.ts --chain 943 --keep 3 --interval 300
```

Watch the board, the archive and every fill. It runs without a deployed
contract and turns off only the fill checks:

```sh
npx tsx scripts/watchdog.ts --chain 943 --interval 120
```

Price the board and fill what pays, out of gas and nothing else. It needs a
deployed settlement address and exits saying so when there is none. A dry run
sends nothing and needs no key, only an address to simulate the fill from:

```sh
npx tsx scripts/executor.ts --chain 943 --dry-run --as 0xYourAddress
EXECUTOR_KEY=0x… npx tsx scripts/executor.ts --chain 943 --min-spread 50
```

## Test the contracts

```sh
cd contracts
forge test
```

679 tests. That runs 649 of them offline against mocks, including the fuzz
properties, the stateful invariants, and the audit regressions in
`test/Security.t.sol` and `test/EconAudit.t.sol`. The other 30 need a
PulseChain RPC, and they skip without one:

```sh
PULSECHAIN_RPC=https://one.valve.city/rpc/evm/369 \
  FOUNDRY_PROFILE=fork forge test --match-path "test/{Fork*,Live369}.t.sol" -vv
```

The URL holds no key. The gateway wants an `X-API-Key` header, and the `fork`
profile in `contracts/foundry.toml` sends the public demo key, `vk_demo`. To use
your own key, set `FOUNDRY_ETH_RPC_HEADERS='["X-API-Key: <key>"]'`. A key in a
URL path reaches access logs and every upstream hop, so it never goes there.

They answer two different questions. `Fork.t.sol` pins mainnet block 27,260,000
and builds fresh contracts, so it asks whether the source works against real
WPLS, PLSX and the real PulseX V2 router. The pin means a run today and a run
next month see the same liquidity.

`Live369.t.sol` asks the other question: whether the bytecode actually deployed
at the mainnet addresses works. It forks at the chain head and attaches to them,
so it never builds a copy. It fills, batches, settles a ring on credit, takes an
escrow deposit back out, and routes a named fee. Because it follows the head, the
pool prices move between runs; every price it uses is read from the pool inside
the test rather than written down.

A third fork file, `test/ForkBuyAndBurn.t.sol`, measures what happens to a token
that reaches PulseX's own buy-and-burn. That address is `defaultProceeds` after
the next redeploy, so what it costs — 14.29% of the PLSX to an address that is
not ours, and a token with no pool stranded for good — is a property of this
deployment and not a hypothetical.

## Rehearsing the mainnet deploy

A deploy is the one thing here that cannot be re-run. A wrong test is a red CI
job; a wrong deploy is an address on chain that somebody has already approved.
So the mainnet deploy is rehearsed on a fork of 369 first, in two halves.

`test/Fork369Rehearsal.t.sol` is the half that fits in forge. It forks 369 at
the head, runs `script/Deploy.s.sol` against `config/369.json` as the one key
that file allows to sign, and then asks whether the result is a deployment
anybody could use: every contract has code, every pointer reads back off the
chain, the real Permit2 at its canonical address funds a fill, and a fill
settles end to end through the executor it just deployed. The real Permit2 is
the point — a mock reproduces our side of that rung and cannot prove the bytes
actually on chain accept what we build.

The other half broadcasts, so it needs a process of its own:

```sh
contracts/tools/rehearse-369.sh
```

It forks 369 into a local anvil, derives a throwaway key, and drives all three
deploy scripts through their guards with `forge script --broadcast` — which a
test cannot do, because `PROVE_DEPLOYER`, `PROVE_SETTLEMENT` and
`PROVE_SETTLEMENT_OFF_RECORD` are process environment rather than EVM state and
forge runs test contracts in parallel.

**Nothing reaches a real chain.** Every broadcast goes to `127.0.0.1`, and the
script refuses to sign against anything else. No deployer key is read or needed:
`PROVE_DEPLOYER` narrows the allowed signer list to the throwaway address. The
gateway URL never reaches a command line either — it goes through the
`pulsechain` alias in `foundry.toml`, because `ps` shows argv to every process
on the machine, and every line the script prints has its key scrubbed first.

`.github/workflows/rehearse-369.yml` runs both halves. It is deliberately not in
`ci.yml`: it talks to a chain, and a pull-request gate that reddens for reasons
unrelated to the change is a gate people learn to ignore. `soak.yml` keeps its
own chain-touching jobs off that path for the same reason.

Coverage of `src/` and `script/` is 100% of every line, branch and function that
`forge coverage` can instrument here. `contracts/tools/coverage-gate.py` is the
gate: it measures a fresh report on every run and fails on any gap outside its one
declared exclusion list — seven Yul lines, each naming the control that stands in
for the counter. Do not read a percentage out of this file; run the gate.

```sh
forge coverage --no-match-coverage "(test|script)" \
  --no-match-path "test/(Fork|Fixture).t.sol" --ir-minimum --report summary
```

`--ir-minimum` is not optional. Coverage turns the optimizer and via-IR off,
these contracts need via-IR, and the run fails with "Stack too deep" without it.

**These numbers are the ceiling, and 100% is not reachable.** All thirteen unhit
lines execute under the suite. None is untested and none is unreachable. The
instrumenter misses them, and the lcov report carries the proof of each.

Nine sit inside an `assembly { }` block, which Solidity cannot mark as hit. The
other four are artifacts of `--ir-minimum`, which merges some adjacent statements
and drops some branch anchors when it rebuilds without the optimizer.

The lcov file contradicts itself on every one of the four. `ProveSettlement:578`
reads zero between two lines that each read 2,209, with no branch between them.
`_requireCallableTarget` has exactly two call sites, and both read zero while the
function itself records 2,751 entries — which is 23 plus 2,728, the entry counts
of the two functions that call it. `ProveCallSink:108` is the only exit from a
function that ran 522 times. The one uncovered branch, the approval arm at
`ProveSettlement:1231`, reads zero on the arm and 11,544 on the statement inside
it; 617 plus 11,544 is the 12,161 hits on the `if` above.

Function coverage of 100.00% says the same thing more briefly: every function
holding an unhit line runs.

Closing the nine would mean deleting the assembly, and each block is there to
stop a griefer. `_probe` runs before the signature check, 4,590 times in one
suite, and a high-level call would let a hostile token bill this contract for
copying a return buffer of its choosing. The other four cannot be closed by any
source change at all.

What each path costs, from `app/src/landing/gas.ts`, which `gen-gas.mjs` writes
out of `Gas.t.sol` and CI compares — a warm allowance fill is 124,975 gas, a warm
escrow fill 131,561, and a batch of twenty in one output token 64,227 per intent:

```sh
forge test --match-path test/Gas.t.sol -vv
```

## CI

`.github/workflows/ci.yml` runs on every push to `master` and on every pull
request. Three jobs:

- **contracts** — builds with `--sizes`, runs the whole Foundry suite, runs
  coverage over `src/`, prints the gas table, and fails if the EIP-712 fixture
  the Solidity suite writes no longer matches the committed one
- **sdk** — builds the contracts, checks the generated ABI against the
  compiler's own output, then lints, typechecks, builds and tests
- **app** — builds the SDK first, then lints, typechecks the app and the bots,
  tests, and builds

CI runs the fork tests in their own paced step, against the valve gateway. The
plain `forge test` step skips them, because `PULSECHAIN_RPC` is unset there.

The app has one unit test, over the landing page's decay maths. The bots
exercise the real path against a real board.

## Deploy

```sh
cd app
npm run build
npx wrangler deploy
```

## Adding a chain

One entry in `sdk/src/config.ts` — a viem chain, a label, the settlement
address, and the token presets. The EIP-712 domain, the RPC defaults, the
network switcher, the token cache and every bot read from that list.

The chain id is inside the EIP-712 domain, so a signature from one chain can
never mean anything on another.

## Where the board comes from

`msgboard` is an RPC module, not a contract:
`msgboard_status`, `msgboard_categories`, `msgboard_content`,
`msgboard_getMessage`, `msgboard_addMessage`. Any node running the module serves
them — see [msgboard.xyz](https://msgboard.xyz). prove.cash uses the
`provecash` category and the published [`@msgboard/sdk`](https://www.npmjs.com/package/@msgboard/sdk).

**If you run a board, or a bot that reads one: posts from before the fee config change do not
decode.** The intent codec is version 5 (`VERSION` in `sdk/src/intent.ts`): a 32-byte fee config
hash where version 4 carried a 20-byte `feeTo`, and a `P_FEE_EXT` byte for the two other rates.
The decoder refuses any version it does not know, so a version 4 post, live or in the archive,
reads as `null` and drops out of the book without an error. Nothing is lost by that: every one
was signed over the old `Intent` typehash, which the new settlement does not verify, so none of
them could fill. It cuts the other way too: a reader built before the change refuses every
version 5 post, so upgrade every bot and indexer with the redeploy. After it, expect an empty
book until makers sign again, and do not read the gap as a broken board.

A version 5 post can also carry its fee config's preimage in an optional block (bit 2 of the
`P_FEE_EXT` byte, up to 217 bytes). The version stays 5 and posts without the block are unchanged,
but a reader built before the block drops the posts that carry one. The app attaches it only for
a config its build does not ship. A board node treats the content as opaque; only a node that caps
message size below the largest intent plus 217 bytes would need to know.

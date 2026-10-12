# prove.cash — signed swap intents on PulseChain

Date: 2026-08-10 · Updated: 2026-08-12

> **Stale in part (2026-09-23).** The body is history and is not rewritten. These sections no longer describe the contracts: §5.1, the intent's fields (`Intent` has 17 now, not 12 — see `INTENT_TYPEHASH`); §5.3, cancel with `effectiveAt` and a cooldown; §6.2, escrow `requestUnlock` and its cooldown (both gone in `66c43fa`; `cancel` and `withdraw` act at once); §9, `feeBps`, `executorRebateBps` and the `FeeSink` buyback (gone across `3af12d3`, `d49dbf8`, `84e8895` and `cf61733`; the maker signs `feeRate` and `feeTo`).
> **Where the current truth lives:** `contracts/src/ProveSettlement.sol` first, then `docs/AUDIT-SCOPE.md` and `docs/FEE-MODEL.md`. The contracts specs indexed in `docs/README.md` take over these sections when they land.

Status: the contracts are written, tested, and revised after two audits — the 2026-08-11 security
audit and the 2026-08-12 economic audit (§12.1). The app is built out to the point of a fill and now
ships two surfaces, a landing page and the dapp (§11). The heartbeat fleet has its executor and its
watchdog (§13.3). The repository is under version control, and CI builds and tests it on every push
(§13.6).

This document is the master note. `docs/README.md` indexes it and the four sibling notes and records
the status of each. Where a decision here has been reversed, the reversal is written at the top of
the section that argued for it. Nothing is deleted.

Nothing is deployed to any chain. Both settlement addresses in the registry are still zero, so the
app broadcasts intents and shows execution as unavailable, and both settlement-dependent bots say so
and stand down. One deployment to testnet turns all of it on.

The paid-job design of §7 is rejected. That section now records what it was and why, so nobody
rebuilds it from the old text.

## 1. Summary

prove.cash lets a person sign a swap offer instead of sending a transaction.

The offer says: *take up to X of token A from me, and you must give me at least
Y of token B.* The person signs it in the browser. Nobody pays gas to publish
it. The signed offer travels over the `msgboard_` module that PulseChain nodes
already run. Anyone who sees the offer can execute it on-chain and keep the
difference between the signed rate and the market rate.

The name is the feature. An offer is **proven** when the tokens are committed —
either sitting in the prove.cash escrow behind a withdrawal cooldown, or covered
by a single-use transfer authorization the maker cannot take back. An offer is
**unproven** when the tokens sit in the maker's wallet under an allowance that
can vanish. The UI shows which is which, and executors decide what to trust.

A maker never needs PLS. Where the token supports EIP-3009, signing is the whole
job: two prompts, no transaction, no approval.

## 2. Decisions

| Question | Decision |
|---|---|
| Custody | Three modes, one contract. Approval is the floor. Escrow reserves the tokens against one intent hash, behind a withdrawal cooldown. An EIP-3009 authorization fills that same reservation with no maker transaction. The last two earn the "proven" badge. |
| Partial fills | The maker chooses per intent. It is one flag in the signed struct. |
| Price | The maker chooses a fixed minimum out, or a minimum that decays over time (dutch). One struct covers both. |
| Fee | The executor pays it, on top of what the maker signed. The executor's share is a discount taken at source, not a credit to claim later. The rest accrues in `FeeSink` and buys PLSX in batches. |
| Executor | Two kinds. An executor with inventory fills directly, one intent at a time or a batch in one transaction. An executor without inventory fills through a callback and routes the trade through PulseX in the same transaction. |
| Addresses | None are compiled in. The owner, the fee sink, PLSX, the router and the PLSX destination all arrive as constructor arguments, and deployment reads them from per-chain configuration. |
| Gas for the maker | Zero, wherever the token allows it. An EIP-3009 authorization funds the escrow just in time, so a maker with no PLS and no approval can still sign an intent. |
| Backend | None. No paid job service sits in the order path (§7). The maker's tab re-posts its own intents while it is open, and any solver may re-post anyone's, because the payload carries the maker's signature. An intent that nobody re-posts stops being visible, and that is the accepted trade. |

## 3. Why the transport shapes the design

The msgboard module is not storage. It is a gossip board with three properties
that drive every decision below.

**Proof of work prices bytes.** A message carries a category (32 bytes) and a
data blob. The grinder searches for a nonce where
`sha256(point(nonce·digest + blockHash) ‖ category ‖ data) ≡ 0 (mod difficulty)`,
and the difficulty rises with the length of the data. Each attempt costs an
elliptic curve point multiplication. So the intent payload must be tight binary,
not JSON, and the app must show a progress bar while it grinds.

**Messages are rooted to a block and they age out.** Every message carries
`blockHash` and `blockNumber`. The live board observed on 2026-08-11 held 32
messages across roughly 85 blocks. An intent that must stay visible for an hour
has to be posted more than once.

**Anyone can re-post.** The signature lives inside the data blob, and the proof
of work is not bound to the signer. So a maker signs once, and the maker's tab,
an executor, or a watcher can re-grind and re-post the same intent to keep it
alive. Re-posting never asks the maker to sign again.

The consequence: prove.cash treats the board as a broadcast channel, and treats
the settlement contract as the only source of truth for whether an intent is
still fillable.

## 4. Architecture

```
┌──────────────────────────────┐
│  React app (static, no API)  │
│  ──────────────────────────  │
│  compose → EIP-712 sign      │
│  encode → PoW → post         │──── msgboard_addMessage ───┐
│  read board → decode → verify│◄─── msgboard_content ──────┤
│  keep alive → store → book   │                            │
│  quote → simulate → fill     │                   ┌────────┴────────┐
└───┬──────────┬───────────────┘                   │ PulseChain node │
    │          │ eth_call / sendRawTx              │  + msgboard_    │
    │          ▼                                   └─────────────────┘
    │  ┌────────────────────┐
    │  │ ProveSettlement    │  signature, custody, fill accounting
    │  │  ├ approval path   │  pull token A by allowance
    │  │  ├ escrow path     │  spend the intent's own reservation
    │  │  ├ 3009 path       │  redeem an authorization into it
    │  │  ├ callback fill   │  hand out token A, require token B back
    │  │  └ batch fill      │  many intents, skipping the races it lost
    │  └─────────┬──────────┘
    │            │ fee in token B
    │            ▼
    │  ┌────────────────────┐
    │  │ FeeSink            │  accrue, batch-swap to PLSX
    │  └────────────────────┘
    │
    ├─ GET archive.msgboard.xyz          older posts, for the book's breadth
    └─ GET facilitator.valve.city        which tokens support EIP-3009
       /supported                        (a read of public data — see §7)
```

Two units, each testable on its own:

- **`contracts`** — `ProveSettlement` and `FeeSink`. Foundry. Knows nothing
  about msgboard. Both are written and tested, and neither is deployed.
  No address is compiled in. Every address the contracts need is a constructor
  argument, and `script/Deploy.s.sol` reads them from `config/<chainid>.json`,
  with environment variables overriding the file. Treat this as a standing
  constraint: adding a chain must cost one config file and nothing else.
- **`app`** — React, plus the bots in `app/scripts`. Reads the board, reads the
  contracts, renders.

The intent type, the EIP-712 hashing and the binary codec live in
`app/src/lib/intent.ts` today. They are the seam: the contract and the app agree
on one struct hash, and that file is the single place the app computes it. The
bots import the same file, so a codec change cannot reach the board without
reaching the bots too. Nothing is published as a package yet.

The app wraps `@msgboard/sdk` rather than reimplementing the board client. That
package ships the RPC methods and a proof-of-work grinder that the node verifier
agrees with bit for bit. `app/src/lib/board.ts` points the SDK's stamper at a
WASM worker, so the grind stays off the UI thread.

There is no third unit. An earlier draft planned a `jobs` deployable of paid
endpoints, and §7 records why it was dropped.

> **Superseded, 2026-08-12: there are three units.** The protocol client came
> out of the app and became `sdk/`, published as `@prove.cash/sdk` and consumed
> by the app through a `file:../sdk` dependency. It holds the intent type, the
> EIP-712 hashing, the wire codec, the board client, the store, the settlement
> calls, the market quotes and the ring solver. `sdk/src/abi.ts` is **generated**
> from the Foundry artifacts by `sdk/scripts/gen-abi.mjs`, and
> `npm run check:abi` fails CI if it drifts from the compiled contract. The
> paragraphs above are right about the seam and wrong about where it lives:
> `intent.ts` moved from `app/src/lib/` to `sdk/src/`, and the sentence "nothing
> is published as a package yet" no longer holds. The `jobs` unit is still not
> built, and §7 still says why. The rejection stands; only the count changed.

### 4.1 The chain we are on is Shanghai, and that decides several things

Measured 2026-08-12 by reading a live header on each network:
`eth_getBlockByNumber("latest")` against `https://rpc.pulsechain.com` at block
27,272,225 and `https://rpc.v4.testnet.pulsechain.com` at block 25,116,074.

| Header field | The fork it signals | 369 | 943 |
|---|---|---|---|
| `withdrawalsRoot` | Shanghai | present | present |
| `blobGasUsed`, `excessBlobGas`, `parentBeaconBlockRoot` | Cancun | absent | absent |
| `requestsHash` | Prague | absent | absent |

Both networks are on Shanghai. Cancun is not active, so Prague is not, so
**EIP-7702 does not exist on either network.** Three consequences follow, and
all three are already true of the code:

- **No account-abstraction feature may be promised.** No delegated EOA can
  exist here, so no design may depend on one. The claim list in
  `2026-08-12-surfaces-and-claims.md` forbids the marketing version of this.
  `_validSignature` still tries `ecrecover` before ERC-1271, which is the
  ordering a delegated EOA needs on the day a fork lands —
  `2026-08-12-hooks-design.md` §4 holds the argument and the tests.
- **No transient storage and no `MCOPY`.** `_entered` toggling 1↔2 in real
  storage is the correct pattern here, not a legacy one. Batch accounting stays
  in memory.
- **`contracts/foundry.toml` pins `evm_version = "paris"`.** Two reasons stack
  up behind one line. The comment in the file gives portability: Paris emits no
  `PUSH0`, so the bytecode runs on any chain the registry might add. The
  measurement above adds the local one: Cancun opcodes are not available to
  compile against in the first place.

Pectra is expected on PulseChain and has not shipped. Design forward-compatible
with it, and depend on nothing it would bring. Re-run the header read before
believing this section; it is a fact about a running chain, not about our code.

## 5. The intent

### 5.1 Signed struct (EIP-712)

```solidity
struct Intent {
    address maker;        // signer, and the account funds leave
    address recipient;    // where token B lands, usually maker
    address tokenIn;      // token A, leaving the maker
    address tokenOut;     // token B, arriving
    uint256 amountIn;     // maximum of token A this intent will ever release
    uint256 minOutStart;  // minimum token B per full amountIn, at startTime
    uint256 minOutEnd;    // minimum token B per full amountIn, at endTime
    uint64  startTime;    // not fillable before
    uint64  endTime;      // not fillable at or after; this is the expiry
    address executor;     // address(0) = anyone may fill
    uint8   flags;        // bit 0 partial fills, bit 1 escrow custody
    uint256 nonce;        // maker-chosen, used for cancellation
}
```

Domain: `name "prove.cash"`, `version "1"`, `chainId 369`,
`verifyingContract` = the settlement address. The maker signs with
`eth_signTypedData_v4`. Contract accounts sign through ERC-1271, and the
contract checks that path when the maker has code.

A fixed-price intent sets `minOutStart == minOutEnd`. A dutch intent sets
`minOutEnd < minOutStart`, and the required output falls linearly between the
two times. Nothing else changes.

### 5.2 Required output

For a fill of `take` units of token A:

```
elapsed   = clamp(now, startTime, endTime) - startTime
span      = endTime - startTime
minOutNow = minOutStart - (minOutStart - minOutEnd) * elapsed / span
required  = ceilDiv(take * minOutNow, amountIn)
gross     = ceilDiv(required * feeBps, 10_000)
fee       = gross - gross * executorRebateBps / 10_000
```

`required` rounds up, so rounding always favours the maker. The maker receives
`required`. The executor also transfers `fee`. The fee never comes out of the
maker's proceeds — the maker gets exactly the rate they signed, and the fee
comes out of the executor's spread.

`quote(intent, take, timestamp)` returns both numbers, and the `fee` it returns
is already net of the executor's rebate. §9 says why the rebate is a discount
rather than a credit. `minOutAt(intent, timestamp)` exposes the decay curve on
its own, and `available(intent)` reports how much is left and whether the
intent is still live.

Decimals never enter the math. The intent is a ratio between two raw amounts.

### 5.3 Cancelling

Three ways to end an intent, in rising cost:

1. **Let it expire.** `endTime` passes and the contract refuses the fill.
2. **Stop re-posting.** The intent leaves the board. It is still signed and
   still valid, so this is a soft cancel only. The UI says so plainly.
3. **Cancel on-chain.** `cancel(intent)` marks that one hash dead, or
   `invalidateBefore(nonce)` kills every intent below a nonce in one
   transaction. This is the only cancel an executor can rely on.

**Correction, 2026-08-12.** A cancel is not always immediate. The economic
audit's F-4 found that a maker could cancel a funded escrow intent inside the
window the executor had already been promised, killing the fill after the
executor bought token B. Both functions now emit an `effectiveAt`.
`cancel` adds `UNLOCK_COOLDOWN` when the intent carries the escrow flag and has
a live reservation — `ProveSettlement.cancel`, line 423. `invalidateBefore`
cannot tell a funded intent from any other, so it gives every escrow-flagged
intent the cooldown — line 438. An allowance intent still dies on the spot, and
revoking the ERC-20 allowance still works on the spot, so the maker's fastest
defence is unchanged.

## 6. Custody

### 6.1 Approval mode (default, "unproven")

Tokens stay in the maker's wallet. The maker approves `ProveSettlement` once per
token. A fill calls `transferFrom`. If the balance or the allowance moved, the
fill reverts and the executor loses nothing as long as they simulated first.

The app checks `balanceOf` and `allowance` for every intent it renders and
labels the unfundable ones. This is a display fact, not a guarantee: the maker
can empty the wallet one block later.

### 6.2 Escrow mode ("proven")

> **Superseded in part, 2026-08-12.** The three escrow entry points no longer
> take a hash, and `Reservation` no longer stores the maker or the token. The
> economic audit filed the hash-taking API as F-1. The prose below is corrected
> in place; the paragraphs on why escrow is keyed per intent, and on why the
> cooldown exists, still stand. One further change: the withdrawal window now
> shuts (F-5). See the two marked corrections in this section.

Escrow is reserved per intent. It is not pooled per maker.

```solidity
function deposit(Intent calldata i, uint256 amount) external;   // anyone may top up
function requestUnlock(Intent calldata i) external;             // maker only, starts the cooldown
function withdraw(Intent calldata i) external;                  // maker only, inside the window
function reserved(bytes32 intentHash) external view returns (uint256);
```

**Correction, 2026-08-12 (F-1): the three write paths take the whole `Intent`,
not its hash, and the slot holds two fields.**

```solidity
struct Reservation { uint192 amount; uint64 unlockAt; }
mapping(bytes32 => Reservation) public reservations;
```

`ProveSettlement.sol` lines 142 to 147. The maker and the token are gone from
the slot because the hash that keys the mapping already commits to both, so a
second copy would only add a weaker way to set them. The caller passes the
preimage and the contract hashes it: `deposit` line 352, `requestUnlock` line
369, `withdraw` line 388.

The old API took a bare `bytes32`, and that is the finding. Take the digest and
the *first caller* decides who owns the reservation and which token it holds —
one wei of any token, sent ahead of the maker's own deposit, would name the
sender as the owner and the maker's money would land inside it. Take the
preimage and there is nothing left to claim: `i.maker` and `i.tokenIn` are
fixed by the hash before anyone calls anything. The contract's own comment on
`deposit` says this, and `contracts/test/EconAudit.t.sol` line 129 runs the
attack.

`reserved` still reads by hash, because reading by hash is safe. It is only
writing by hash that lets a stranger claim a slot they do not own.

An escrow-backed intent spends its own reservation and nothing else. No
allowance, no `transferFrom`, no dependence on the wallet. Anyone may top an
intent up — `deposit` checks nothing about `msg.sender`. Only the maker named in
the intent can unlock or withdraw, and both functions test `msg.sender !=
i.maker` before anything else.

**Why the pooled balance had to go.** The old API was
`deposit(token, amount)` against a per-maker `escrowOf` balance, and any intent
of that maker could spend it. That model could not keep the promise the "proven"
badge makes. A maker who saw an executor's fill in the mempool could sign a
second escrow-backed intent that paid themselves a worthless token they had just
minted, front-run the executor with it, and walk the same funds out with no
cooldown at all. The executor's fill then reverted with `EscrowShort`. Keyed by
intent hash, the funds behind an intent can only leave through that intent or
through the cooldown. That is the difference between "proven" meaning something
and meaning nothing. The audit filed it as H-1 (§12.1), and
`test_H1_MakerCannotEmptyEscrowWithASelfDealingIntent` runs the attack on every
test pass.

The cooldown is what makes escrow worth the extra transaction. Without it the
maker front-runs the executor with a withdrawal and the guarantee is theatre.
With it, an executor can read `unlockAt` and know the funds cannot move before
then. Default cooldown: 15 minutes, a contract constant, not per-user.

A pending unlock does not freeze the reservation. The funds stay fillable until
the withdrawal actually lands, and `withdraw` returns whatever is left. That is
the point: the executor reads one timestamp and knows the whole window.

**Correction, 2026-08-12 (F-5): the window shuts.** An earlier `withdraw` only
tested the lower bound, so a matured cooldown never expired. The maker could
request an unlock on the second they deposited, wait fifteen minutes, and from
then on hold a reservation that was fillable and withdrawable at the same time,
for ever — a free option, exercised whichever way the market went, with the
executor paying the gas either way. `withdraw` now takes both bounds:
`at == 0 || block.timestamp < at || block.timestamp >= at + UNLOCK_COOLDOWN`
reverts with `StillLocked`, at line 393. The honest maker who misses the window
pays one more `requestUnlock`. A fill pays nothing, which is why the test lives
in `withdraw` and not in `fill`.

Getting out of escrow therefore costs three transactions and a wait: `deposit`,
`requestUnlock`, the cooldown, `withdraw`. That is the heaviest path in the
product, and the UI states the real cost.
`2026-08-12-escrow-exit.md` proposes a `withdrawExpired` that reduces it to one
transaction and no wait once `endTime` has passed. It is not implemented, and
§16 records it as the owner's call.

The UI turns this into one sentence: *"Proven — funds locked, earliest
withdrawal 14:32."* If an unlock is pending and it lands before the intent
expires, the badge downgrades and says why.

### 6.3 Authorization mode (gasless, also "proven")

Escrow is the strongest custody, and its cost is a transaction the maker has to
pay for in PLS. EIP-3009 removes that cost.

A maker whose token A supports `transferWithAuthorization` signs two things at
once, in two wallet prompts and zero transactions:

1. The intent.
2. An authorization moving `amountIn` of token A to `ProveSettlement`, whose
   3009 nonce is the hash of that intent.

Nothing happens on-chain until someone fills. The first executor submits the
authorization and the fill together:

```solidity
struct Authorization { uint256 validAfter; uint256 validBefore; bytes32 nonce;
                       uint8 v; bytes32 r; bytes32 s; }

function fillWithAuthorization(
    Intent calldata i, bytes calldata sig, uint256 take,
    Authorization calldata auth, uint256 maxFeeBps
) external;
```

`maxFeeBps` arrived with the economic audit's F-6 and it is on every fill path.
See §8.1.

**The authorization is bound to its intent.** `auth.nonce` must equal the intent
hash, and the contract rejects anything else with `BadTerms`. Before this check,
one authorization armed every same-size intent the maker had ever signed, and
cancelling the intent it was written for did not revoke it. The audit filed that
as M-4 (§12.1). The binding also costs nothing: EIP-3009 needs a unique nonce
anyway, and the intent hash is one.

The contract redeems the authorization into that intent's reservation, then runs
the ordinary escrow fill. Any unfilled remainder stays in the reservation, and
the maker recovers it through the normal cooldown. It cannot fund the next
intent, because the reservation belongs to this one — see the open item in §16.

The intent must set the escrow flag, and the contract redeems only when the
reservation cannot already cover the take. So the second of two partial fills
spends the deposit the first one created, instead of replaying an authorization
the token has already burned.

So an authorization is a just-in-time deposit into one reservation, and it costs
the maker no gas and no approval. From the executor's side, once the
authorization is attached the intent is as good as escrowed: the signature
cannot be revoked without an on-chain cancel, and the authorization nonce is
single-use. These intents carry the **proven** badge.

The limit is the token. `transferWithAuthorization` is fixed-value and
fixed-recipient, so it funds the whole `amountIn` at once. Partial fills still
work afterwards, because the funds are reserved by then.

### 6.4 The custody ladder

The app picks the best mode each token supports and never asks the maker for
more than the token requires.

| Token capability | Mode | Maker cost | Badge |
|---|---|---|---|
| `eip3009` | Authorization (§6.3) | 2 signatures, no gas | proven |
| Explicit deposit | Escrow (§6.2) | 1 transaction per intent | proven |
| `eip2612` | Gasless approve, then approval mode | 2 signatures, no gas | unproven |
| `permit2` | Permit2 SignatureTransfer | 2 signatures after a one-time approve | funds at fill |
| plain ERC-20 | Approval (§6.1) | 1 approve transaction | unproven |

The `permit2` row said "Permit2 allowance, then approval mode" when this was
written, and that was the wrong half of Permit2. An AllowanceTransfer permit grants
an allowance inside Permit2 to a named spender, and that spender is `ProveRelayer`,
which the settlement's constructor makes — so it is orphaned by a redeploy exactly
the way the ERC-20 allowance is, and the rung solves nothing. The cost was not
understood until a settlement redeploy on 943 made every maker approve again.
SignatureTransfer authorizes one transfer per signature, so nothing outlives an
intent and the only durable thing is `approve(Permit2, max)`. That is what shipped.

The facilitator publishes these capabilities per token at
`GET https://facilitator.valve.city/supported`, and `app/src/lib/custody.ts`
also probes the token directly, so an asset the facilitator has never seen still
gets the right rung. The probe calls `authorizationState`: a contract that
answers it speaks EIP-3009. Confirmed for chain 369 today: `PRVX`, `x402PLS`,
`x402DAI`, `x402USDC`, `x402HEX`, `x402PLSX` and `x402eHEX` all advertise
`eip3009`, and most also advertise `permit2`.

The app asks the facilitator on chain 369 only, because that is the chain it
serves, and it caches the answer for an hour. The capability is a property of
the deployed code, so a stale answer is a cheap answer. §7.4 says why this one
read is the only place the facilitator appears.

## 7. Paid jobs: proposed and rejected

This section describes a design that prove.cash does **not** build. It stays in
the document because the idea is attractive and somebody will otherwise rebuild
it from the old text.

### 7.1 What was proposed

Some work cannot happen in a browser tab, because the tab closes. Re-broadcast
is the obvious case: an intent that must stay visible for eight hours needs
something awake for eight hours. On-chain cancellation is another — it is a
transaction, and a maker with no PLS cannot send it.

The proposal answered every case the same way. A `jobs` service would expose one
HTTP endpoint per job. Each endpoint would return `402 Payment Required` until
the request carried a payment, and `facilitator.valve.city` would verify and
settle that payment over x402. There would be no account, no API key, and no
subscription. Five jobs were specified:

| Job | What it would do |
|---|---|
| `keepalive` | Re-grind and re-post an intent to the board until it expires or fills. |
| `grind` | Run the proof of work server-side for a phone that would take too long. |
| `cancel` | Submit an on-chain `cancel` or `invalidateBefore` for a maker with no PLS. |
| `relay` | Submit a fill for an executor with no PLS. |
| `watch` | Notify a webhook when an intent becomes fillable at the current market rate. |

Job revenue would have landed in the same `FeeSink` as trading fees.

### 7.2 Why the owner rejected it

His words:

> we need to consider if we even need x402 at all. it might be worth using in
> certain situations but not all. solvers may do the rest. otherwise we will be
> introducing more parties to front run the solvers.

Every one of those five jobs sits in the order-flow path. Each one hands a paid
third party early sight of a fillable intent. Early sight is the whole prize in
this market, and the design was giving it away to a party that adds no capital
and takes no risk:

- **`keepalive`** sees an intent before it re-broadcasts it. It can fill it
  instead, and simply not re-post the ones worth taking.
- **`grind`** sees an intent before it is public at all. The service could take
  the good ones and never return a nonce.
- **`cancel`** sees a cancel before it lands. It can front-run the cancel with a
  fill, and the maker pays for the privilege.
- **`relay`** sees a fill before it lands, which is the classic relay problem.
- **`watch`** sells "this is now profitable" ahead of the board. That is the
  definition of an information edge, sold by the operator of the board's client.

A solver competing for a spread is the party this protocol wants. A service that
sits between the maker and the solvers, charges both, and can trade against
either one is the party it does not.

### 7.3 Keepalive did not need paying for

The proposal also mispriced its own flagship job. A solver already wants an
order to stay alive, because a live order is an order they can fill. So the
incentive to re-post already sits where it belongs.

Anyone may re-post. The payload carries the maker's signature, and the proof of
work is not bound to the signer (§3). Re-posting therefore costs one grind and
asks nobody for permission. This is a job the market does for free, and paying
for it would have bought only the right to see the order first.

### 7.4 Where x402 could still earn a role

x402 is not banned here. One question decides it: **does the paid call give
anyone sight of an intent before it settles?** If it does, prove.cash does not
build it.

That leaves metering infrastructure that confers no early sight:

- bulk archive access — reading history nobody can trade against,
- RPC quota — selling capacity, not order flow.

Nothing that touches a live intent qualifies. Not keepalive, not grinding, not
relaying, not notification.

### 7.5 The facilitator as a capability source

One read survives, and it is not a job. `app/src/lib/custody.ts` fetches
`GET https://facilitator.valve.city/supported` to learn which tokens support
EIP-3009, so the custody ladder (§6.4) can offer the gasless rung. That is a
read of public capability data. It is free, it is cached, it names no intent,
and the app falls back to an on-chain probe when the facilitator is silent or
unreachable.

The facilitator itself is unchanged and still real. It speaks x402 versions 1
and 2, scheme `exact`, network `eip155:369`, and settlement model
`async-batched` with a stated `maxSettleLatencyMs` of 5000. It publishes a
per-token capability list, which is the part prove.cash uses. Recording this
here keeps the facts for whoever revisits §7.4.

## 8. Execution

### 8.1 Direct fill

```solidity
function fill(Intent calldata i, bytes calldata sig, uint256 take, uint256 maxFeeBps) external;
```

**`maxFeeBps` is new since this section was written (F-6).** The contract reads
`feeBps` and `executorRebateBps` from storage at execution time, so without a
bound the owner can raise the fee under a pending transaction — up to
`MAX_FEE_BPS`, which is larger than the margin most of these fills carry. The
executor now names the fee they priced, and a raise reverts their transaction
with `FeeTooHigh` instead of taking the difference out of it. `_fees` is the one
place the bound is enforced, so every fill path honours it.
`contracts/test/EconAudit.t.sol` line 686 drives the extraction.

1. Reject terms that cannot work: a minimum that rises rather than decays, or
   the same token on both sides.
2. Reject if not yet started, expired, cancelled, below the maker's nonce floor,
   or the executor is pinned to someone else.
3. Reject a zero `take`, a `take > amountIn - filled[hash]`, and any `take`
   short of the remainder when partial fills are off.
4. Recover the signer, or call ERC-1271 when the maker has code. Reject a
   mismatch. The signature comes last, after the cheap checks.
5. Move token A to `msg.sender` — by allowance, or out of the intent's
   reservation.
6. Pull `required` of token B from `msg.sender` to `recipient`, and check that
   the recipient's balance rose by that much.
7. Pull `fee` of token B from `msg.sender` to `FeeSink`. That fee is already net
   of the executor's rebate (§9).
8. Emit `Filled`.

Step 6 measures a balance delta on every fill path, not only the callback one. A
token that taxes its own transfers fails the fill with `Underpaid` instead of
quietly short-changing the maker. The maker is promised an amount received, so
an amount sent is not good enough.

`filled[hash] += take` is recorded before any transfer, not after. Booking first
is what stops a token callback, or the callback fill of §8.3, from taking the
same intent twice.

### 8.2 Batch fill

```solidity
struct FillRequest { Intent intent; bytes signature; uint256 take; }

function fillBatch(FillRequest[] calldata reqs, bool skipInvalid, uint256 maxFeeBps)
    external returns (uint256 count);
```

An executor watching the board usually sees several fillable intents at once.
`fillBatch` takes them in one transaction, which saves the base gas of a
transaction each and lands them in one block.

`skipInvalid` exists because of races. Intents are public, and any executor may
take any of them. With `skipInvalid = false` a batch is all or nothing: one
intent that somebody else already filled reverts the whole transaction, and the
executor loses the other fills as well as the gas. With `skipInvalid = true` the
contract steps over that intent and takes the rest.

The skip path re-runs the same checks as the fill path — the terms, timing,
cancellation, the nonce floor, the pinned executor, the remaining amount, the
partial-fill rule, the reservation, and the signature — as a view, with no state
written. So a skipped intent is never half-filled, and a skip is never a silent
underpayment. The call returns how many fills it made.

A skip has to be a real skip. Two cases used to revert the batch anyway, and the
audit filed both (M-1, §12.1):

- **The maker moved their funds.** In approval mode the skip path now reads the
  maker's allowance and balance before it commits. A single fill would learn the
  same thing from the transfer one moment later, but a batch has to know first.
  A maker who revoked an allowance costs the executor one skipped row, not the
  whole transaction.
- **The terms are nonsense.** A rising minimum used to underflow inside
  `minOutAt`, and an intent with the same token on both sides would let a
  callback pay itself. Both are now `Reason.BadTerms_`, so `skipInvalid` steps
  over them.

A contract maker cannot bomb the batch either. The ERC-1271 answer is decoded by
hand under a 60,000 gas cap, because a maker returning a dirty word made
`abi.decode` revert and took every other fill down with it (M-2). A hostile
maker is now a bad signature and nothing more.

### 8.3 Callback fill (no inventory needed)

> **Rewritten 2026-08-12, commit `ddab838`.** Two things this section used to
> describe are gone: the caller-named `target`, and the balance-delta payment
> proof. `2026-08-12-hooks-design.md` §2.2 and §2.3 carry the reasoning, and
> `contracts/src/interfaces/IProveCallback.sol` carries the contract the
> executor must now honour. The old text is replaced rather than kept, because
> an executor who follows it writes a callback that cannot settle.

```solidity
function fillWithCallback(
    Intent calldata i, bytes calldata signature, uint256 take,
    bytes calldata data, uint256 maxFeeBps
) external;

interface IProveCallback {
    function proveCallback(
        address executor, address tokenIn, uint256 amountIn,
        address tokenOut, uint256 amountOwed, bytes calldata data
    ) external;
}
```

Same checks, then three steps in `_settleViaCallback`, line 617: release `take`
of token A to `msg.sender`, call `msg.sender.proveCallback(...)`, then **pull**
token B out of `msg.sender` — `delivered` to the recipient, `fee` to the sink.
A reentrancy guard is held across the whole call, and `filled[h]` is written
before the release.

**The caller is the callback target.** There is no `target` parameter. The
contract releases to and calls back `msg.sender`, which is what Uniswap V3
`flash`, V4 `unlock` and UniswapX `reactorCallback` all do, and it is why none
of them needs an ERC-3156 acceptance value. Releasing a maker's token A to an
address the caller merely names is a wider surface than the trade needs. The
executor must therefore *be* the `IProveCallback` contract, so this path belongs
to bots through the SDK, not to a browser wallet.

**The contract pulls; it does not measure.** The executor must end the callback
holding `amountOwed` of token B with an allowance to `ProveSettlement`. A
balance delta proves a balance rose, not that the executor made it rise: it
reads a donation as a payment, it lets one payee's two debts share one
measurement, and it counts the contract's own release to the executor. Both
UniswapX and 1inch make a directed `safeTransferFrom` after the callback, and
OpenZeppelin's UniswapX audit rejected the delta instrument for exactly this
architecture. So `_payMaker` and `_payFee` do the transfer.

Three things follow, and each replaces a claim this section used to make:

- **`SinkIsRecipient` is gone.** That guard existed because one delta cannot
  tell the delivery from the fee when the sink and the recipient share an
  address. Two directed pulls cannot make that mistake. `fill` and `fillBatch`
  never needed the guard for the same reason, so the callback path no longer
  refuses what the other three accept.
- **One balance read remains, and it is a different instrument.** `_deliverTo`
  brackets its own single transfer with a `balanceOf` pair to catch a token that
  taxes it, so the maker receives the amount they were promised. It is a
  fee-on-transfer guard, not a payment check. Do not delete it as a leftover.
- **A leg whose recipient is the executor cannot settle.** The pull becomes a
  self-transfer, which moves no balance, and the fee-on-transfer guard reads
  that as a short delivery. `fill` and `fillBatch` have always behaved this way.

**The rule the call site keeps:** the contract may call an address it did not
choose only through a selector it did choose. The executor's `data` rides inside
the `proveCallback` frame as an argument and never becomes the selector, so no
allowance granted to this contract is reachable through here.
`test_TheFixedSelectorIsTheOnlyThingProtectingTheCallbackPath` asserts it.

This is what lets a bot with an empty wallet route the maker's token A through
PulseX and pay the maker out of the proceeds.

There is no `fillBatchWithCallback` on `master`. `2026-08-12-hooks-design.md` §2
measures a prototype and recommends shipping it; neither the function nor
`contracts/test/BatchCallback.t.sol` is in this tree today, verified 2026-08-12.
So this path fills one intent at a time. The ring solver
(`2026-08-12-solver-design.md`) settles through `fillBatch` instead —
`sdk/src/solver/execute.ts` line 88 — which works but needs the solver to hold
inventory, because each leg pays before the next leg's receipt arrives. Merging
the prototype is what would remove that requirement.

### 8.4 Fee-on-transfer and rebasing tokens

Every fill path measures received amounts as balance deltas. A token that takes
a cut on transfer simply fails the check and the fill reverts. prove.cash does
not try to support them in v1, and it says so in the UI when it detects a
shortfall during simulation.

### 8.5 Why a fill will not go through

```solidity
function fillability(Intent calldata i, bytes calldata sig, uint256 take,
                     address executor) external view returns (Reason);
```

One validator serves the single fill, the batch and this view, so the three can
never disagree about what "fillable" means. `Reason.Ok` is zero. The rest are
`BadTerms_`, `NotStarted`, `Expired`, `Cancelled`, `NonceTooLow`,
`WrongExecutor`, `NothingToFill`, `TooMuch`, `PartialNotAllowed`, `EscrowShort`
and `BadSignature`. The UI calls `fillability`, greys out the row, and says
which one.

The view runs the same deep check a skipping batch runs, so an approval-mode
intent whose maker has revoked the allowance or spent the balance reports
`EscrowShort` rather than looking fillable until someone pays for the revert.

## 9. Fees and the PLSX buyback

The fee is denominated in token B and charged to the executor, on top of what
the maker signed.

```
gross = ceilDiv(delivered * feeBps, 10_000)
fee   = gross - gross * executorRebateBps / 10_000   → FeeSink
```

### 9.1 The executor's share is a discount, not a credit

An earlier draft of this document credited the executor's share inside the sink
and let the executor claim it later, in token B. The implementation dropped
that, because it is circular. The executor pays the fee. Handing part of it
straight back, in the same token, in the same transaction, is a smaller fee
wearing a costume. The credit would add a balance to track, a claim transaction
to send, and a pot of other people's money to argue about.

So the contract takes the share at source. `quote` returns a fee that already
has `executorRebateBps` removed, and only that net amount ever moves. The
executor sees a lower cost, which is the same economics with none of the
machinery.

The real, non-circular reward for running an executor is the keeper tip.
`FeeSink.buyback` pays whoever calls it a share of the PLSX it buys, in PLSX,
out of fees other people paid. The keeper never paid the fee it is tipped from,
so that incentive survives the argument above. §16 records the open question
behind this choice.

### 9.2 The buyback

> **Superseded in part, 2026-08-12, commit `ac3f048` (F-2).** The slippage floor
> described below came from `router.getAmountsOut` on the pool the swap was
> about to hit, read in the same transaction. A caller who moved the pool first
> moved the floor with it, and the sandwich took 95.7% of the fee balance. The
> paragraph on why the *caller* no longer supplies the route still stands (C-1).
> The paragraph on `minPlsxOut` does not. Read the correction below it, and read
> `contracts/src/FeeSink.sol` before quoting any number here.

Anyone can call it. Nobody but the owner picks the route.

```solidity
function buyback(address token, uint256 minPlsxOut) external returns (uint256 bought);
function setRoute(address token, address[] calldata path, uint256 maxPerCall) external;  // owner only
function observe(address token) external;                            // arms the time-weighted floor
function twapQuote(address token, uint256 amountIn) external view returns (uint256 out, bool armed);
function route(address token) external view returns (address[] memory);
```

`buyback` turns everything the sink holds of `token` into PLSX, pays the caller
a keeper tip in PLSX, and sends the rest to `plsxSink`. The caller chooses the
timing, and that is all they choose. Batching keeps the router out of the hot
path, so a normal fill costs no extra swap gas.

**Why the caller no longer supplies the route.** The first version took both the
path and the minimum from calldata. Anyone could create a pool, pass it as the
path with `minPlsxOut = 0`, and keep every fee the sink had collected. A
regression test builds exactly that pool. The audit filed it as C-1, the one
critical finding (§12.1). Three things close it:

- The owner sets one route per token with `setRoute`. The contract checks the
  path starts at the token and ends at PLSX.
- An empty route means the token cannot be sold at all. That is the right
  default for anything the owner has not looked at.
- `minPlsxOut` must be at least the router's own `getAmountsOut` quote less
  `maxSlippageBps` — 100 bps by default, and the contract will not let the owner
  set it above 1000. Zero is rejected. After the swap the contract re-checks its
  own PLSX balance delta against `minPlsxOut`. A fee that needs no swap — PLSX
  itself, or a wrapper that redeems into PLSX — skips the router, and the floor
  with it.

**Correction, 2026-08-12 (F-2): the spot quote is no longer the binding floor.**
It is a caller-movable number, so it now only rules out a floor of nothing.
Three floors replace it, and `FeeSink.sol` lines 23 to 38 state them:

1. **A time-weighted floor.** Every pair on the route publishes a
   UQ112x112 price counter that only grows with elapsed time. `observe` records
   where it stands and `buyback` reads it again a window later, so the sale is
   priced against time nobody can rewrite inside one transaction.
   `twapSlippageBps` sets the allowance below it.
2. **An owner floor per token.** `setMinPrice` is a hard minimum of PLSX wei per
   smallest unit of the token, scaled by `PRICE_SCALE` so the sink never has to
   ask a token its decimals.
3. **A capped slice and a block gap.** `setRoute` takes a `maxPerCall`, and two
   sales must be `saleGapBlocks` apart.

**A route with no observation and no owner floor refuses to sell.** That is the
right default for an unvetted token, and it is stronger than the old "no route,
no sale". The spot check stays, because it still catches a floor of zero.

An illiquid fee token still sits there doing nothing, which was always the
answer. It now sits there until the owner vets a route, not until any caller
invents one.

Two cases skip the router. A fee that already arrived as PLSX needs no route. A
fee that arrived as an x402 wrapper is unwrapped instead of swapped.

### 9.3 x402 wrappers are unwrapped, never swapped

An x402 token is a 1:1 claim on an `underlying()` with the same decimals, and it
exposes `wrap(uint256)` and `unwrap(uint256)`. Selling one through an AMM would
pay slippage and a swap fee to reach a price the wrapper gives away at par.

`buyback` staticcalls `underlying()` first. A token that answers is a wrapper:
the sink redeems the whole balance at par, and only then routes the underlying.
A token that answers nothing is an ordinary token and goes to the router. So a
fee that arrives as x402PLSX becomes PLSX with no swap at all, and no route is
needed. A fee that arrives as x402HEX becomes HEX, and the owner sets the route
for HEX rather than for the wrapper.

A token that claims an `underlying()` it cannot deliver gets nothing. The sink
credits the balance delta of the unwrap, so a lying wrapper redeems to zero and
the call reverts with `NothingToSell` before it can point a sale at the wrong
token. The audit filed that as L-1.

`unwrap(token)` and `underlyingOf(token)` are public, so a keeper can see what a
token redeems into before it calls `buyback`. A fork test proves this against
the real x402PLSX wrapper on mainnet, and the PLSX comes back to the wei.

### 9.4 Parameters

Starting parameters, all owner-settable within hard caps written into the
contract:

| Parameter | Default | Cap |
|---|---|---|
| `feeBps` | 10 (0.10%) | 50 |
| `executorRebateBps` (discount off the fee) | 2000 (20% of the fee) | 5000 |
| `keeperTipBps` (share of a buyback) | 50 (0.50%) | 200 |
| `maxSlippageBps` (how far below the router quote a caller may bid) | 100 (1%) | 1000 |
| `minPlsxOut` | caller-supplied, floored at the router quote less `maxSlippageBps` | — |
| `route(token)` | empty, so nothing sells until the owner sets a path | — |

**Correction, 2026-08-12 (F-2): this table is incomplete.** `FeeSink` now also
carries `twapSlippageBps` (500, capped at 2000), a TWAP window and max age
(`setTwapWindow`, capped at 30 days), a per-call sale cap on the route, a sale
gap in blocks (`setSaleGap`, capped at 200,000) and a per-token owner floor
(`setMinPrice`). Defaults for the last three are not restated here because I
have not read them off the contract; take them from
`contracts/src/FeeSink.sol`, not from this table. The `minPlsxOut` row above is
superseded — see the correction in §9.2.

**Open item:** where the bought PLSX lands. Options are a treasury address, a
burn, or a staking distributor. The contract holds it in a settable
`plsxSink` address so the decision is not blocking.

## 10. The board wire format

One category for the whole protocol:

```
category = ascii("provecash") right-padded to 32 bytes
         = 0x70726f76656361736800...00
```

The data blob is packed binary, versioned in the first byte, and it carries the
signature so any reader can verify without asking a server.

```
byte  0        version = 0x01
byte  1        kind    = 0x01 intent, 0x02 intent + 3009 authorization
byte  2        intent flags    (the signed flags byte from §5.1)
byte  3        presence bits   (codec-only: bit0 recipient, bit1 executor)
bytes 4..23    maker
bytes 24..43   tokenIn
bytes 44..63   tokenOut
[20]           recipient       (present only when it differs from maker)
[20]           executor        (present only when the intent is pinned)
varint         amountIn
varint         minOutStart
varint         minOutEnd
bytes 5        startTime, seconds
bytes 4        duration, seconds  → endTime = startTime + duration
varint         nonce
bytes 65       signature
── kind 0x02 only ──
varint         auth.validAfter
varint         auth.validBefore
bytes 65       auth signature
```

Kind `0x02` carries the maker's EIP-3009 authorization behind the intent, so the
gasless custody mode of §6.3 travels over the board as one message. The
authorization needs no nonce on the wire: the nonce is the intent hash, and the
reader recomputes it. An executor who reads a `0x02` message has everything the
`fillWithAuthorization` call needs.

A varint here is one length byte followed by that many big-endian bytes, so a
zero costs one byte and a `uint256` costs at most 33. Proof of work charges for
every byte, and a token amount is mostly leading zeros, which is why the codec
is packed rather than ABI-encoded.

The presence bits are a codec device and never enter the signed struct. The
decoder reconstructs the full `Intent` before it hashes anything, so the
signature always covers the complete terms.

Measured, not estimated: a real WPLS → PLSX intent encodes to **176 bytes**, and
at the board's current factors that is a difficulty of 185,372 and about **one
second** of WASM grinding on a laptop. The layout lives in
`app/src/lib/intent.ts`, and `app/scripts/live-post.ts` round-trips it against a
real board (§13.1).

A broadcast cancel kind was drafted and is not built. Only the on-chain cancel
is binding, so a courtesy message would tell watchers something they must verify
against the chain anyway. §5.3 lists the three cancels that do exist.

### 10.1 Keeping an intent alive

The app posts an intent when it is signed and remembers the payload in
`localStorage`. On every board poll it compares its own live intents against the
keys the board just returned, and re-posts the ones the board no longer carries.
Re-posting means a fresh proof of work over the same bytes, in a worker, one
grind at a time so the laptop stays usable. The maker never signs again.

Anyone may re-post, so a solver who wants an order to survive can keep it alive
too. Nobody pays for this, and nobody needs permission (§7.3).

An intent stops being visible when nobody re-posts it. That is the accepted
trade, not a hole for a paid service to plug. The alternative was a keepalive
job that saw every intent before it re-broadcast it, and §7.2 says why that
costs more than it buys.

Losing the board is not losing the order. The intent stays in this browser's
book, because the store keeps every verified sighting (§11.2). The row stays
visible and wears an **off-board** mark: signed and valid, but not broadcasting
right now. The signature is still good, the chain still honours it, and one
re-post puts it back on the board.

## 11. The React app

> **Superseded, 2026-08-12: the app is two surfaces, not one.** This section was
> written when `/` was the trading client and there was nothing else. It is now
> the landing page, and the dapp lives at `/app`. Everything below still
> describes the dapp correctly except where a correction is marked. The split
> itself is described immediately below, and the claims each surface may make
> are in `2026-08-12-surfaces-and-claims.md` — that note is the authority on
> copy, and this one does not repeat its list.

Vite, React 19, TypeScript, viem, Tailwind v4. Static output, deployed to
Cloudflare. No server, no database, no API keys in the bundle. The wallet
connection is a plain EIP-1193 provider, so there is no WalletConnect project
id to hold.

**Two surfaces, one bundle, no router library.** `app/src/routes.ts` is the
whole mechanism: a `usePath` hook over `useSyncExternalStore`, an `isApp(path)`
predicate matching `/app` and anything under it, and a `navigate` that pushes
state and fires one event. `app/src/main.tsx` is the whole route table — eight
lines that render `Landing` or, behind `React.lazy` and a `Suspense`, `App`.

**The split earns its keep at load time, not in the URL bar.** The landing page
imports nothing from viem, the board client or the proof-of-work worker, so a
first-time visitor downloads a page rather than a trading client. The dapp
arrives only when the path asks for it. Anything added to the landing page that
pulls in the SDK undoes the only reason the split exists.

Deep links already work. `app/wrangler.jsonc` sets
`assets.not_found_handling` to `single-page-application`, so `/app` returns
`index.html` and the router takes it from there.

The audiences are different and the surfaces follow them. The landing page
serves a maker who has never heard of this. The executor is not its audience —
they arrive at `/app` from a link.

**Corrected 2026-08-12.** Most of what this tree listed under `app/src/lib/`
now lives in `sdk/src/` (§4). Five files stayed in the app, because each one
needs a browser and nothing else does. **Where §11.2 to §11.4 below name a
`lib/` path — `lib/store.ts`, `lib/archive.ts`, `lib/tokenlist.ts` — read
`sdk/src/`.** What those sections say about the behaviour is still right; only
the path moved.

```
sdk/src/            @prove.cash/sdk — everything that is not a browser
  config.ts         the network registry, the two endpoints, the category
  intent.ts         Intent type, EIP-712 domain and types, the wire codec
  abi.ts            GENERATED from the Foundry artifacts. Never hand-edited
  board.ts          msgboard client
  client.ts         the chain client
  submit.ts         grind, submit, and confirm against the board
  keepalive.ts      re-post intents as the board ages them off
  store/            the intent store: IndexedDB, a Map fallback, one query
  archive.ts        older posts from the msgboard archive
  settlement.ts     fill paths, quotes, reservations, fee parameters
  custody.ts        EIP-3009 detection, and the typed data to sign
  market.ts         PulseX quotes, so a row can show its spread
  multicall.ts      one round trip per question, not one per row
  tokens.ts         ERC-20 metadata and balances, cached
  tokenlist.ts      the gib.show token list and the logo lookup
  solver/           ring matching over signed intents
                    (2026-08-12-solver-design.md)

app/src/            the browser half
  main.tsx          the route table: Landing, or the lazy dapp
  routes.ts         usePath, isApp, navigate — the whole router
  landing/          the landing page. Imports no viem, no board, no worker
  App.tsx           the dapp, loaded lazily
  lib/board.ts      points the SDK's stamper at the worker
  lib/custody.ts    signs the authorization with the browser wallet
  lib/settlement.ts the fill calls the tray makes
  lib/wallet.ts     connect, chain switch, signTypedData
  lib/pow.worker.ts the WASM grinder, off the UI thread
  hooks/useBoard.ts poll, verify, ingest, query, enrich
  components/       Compose, CustodyLadder, TokenPicker, TokenAvatar,
                    IntentRow, BatchTray, Portfolio, RpcSettings, Tour
app/scripts/        heartbeat, executor, watchdog, solver, live-post (§13.3)
```

The dapp has three tabs: **Board** reads the book and fills, **Sign** composes
an intent, and **Mine** shows what this wallet has committed. `App.tsx` line 69
holds the tab state.

### 11.1 The network registry and the two endpoints

Every chain-specific fact lives in one list in `lib/config.ts`: the viem chain,
a label, the settlement address, and the token presets. The EIP-712 domain, the
RPC defaults, the network switcher, the token cache and every bot read from it,
so adding a chain is a single entry and nothing else moves. Today it holds
PulseChain mainnet (369) and PulseChain v4 testnet (943), both served by
valve.city nodes with the module enabled. Both settlement addresses are still
zero, so the app broadcasts and refuses to offer a fill.

A network now carries two endpoints, not one. The **board** endpoint needs a
node running the `msgboard_` module. The **chain** endpoint answers plain `eth_`
reads and can be any PulseChain node. The two are locked together by default, so
one URL drives both exactly as before the split. Unlocking them lets a user keep
the board on a module-enabled node and point balances, quotes and simulations at
their own RPC. The lock, and each URL, live per chain in `localStorage`, and
`RpcSettings` is the dialog that edits them.

### 11.2 The intent store

The board is a gossip channel and it forgets. The app does not.
`lib/store.ts` keeps every verified sighting in IndexedDB, so the order book
survives a reload, an offline spell, and the board rolling a message off.

Three rules keep the store honest. A signature verifies locally **before** the
record is stored, never after. Ingest is idempotent: a repeat sighting only
raises the last-seen block, widens the first-seen time downward, and upgrades
the source, ranked `archive < live < mine`. Only the chain decides fillability —
the store remembers, it never claims.

Each record keeps the raw board payload, so any row can go back on the board
with no new signature. Amounts stay as decimal strings, which are
authoritative; a derived float rate exists only so a range query never has to
decode a bigint. The store indexes `chain + pair + expiry`, expiry on its own,
and maker. Expired records stay readable for 30 days, then a sweep on open
removes them. A browser that refuses IndexedDB — private mode — gets a plain
`Map` behind the same three verbs, and nothing above that line changes.

`queryIntents` is the one question surface. The index answers chain, pair and
expiry; everything else — rate band, custody mode, partial only, pinned
executor, maker, source — is a residual predicate applied inside the cursor
walk, which stops at the limit and hands back a cursor for the next page. No
view filters a full array. `pairDepth` counts open and total per pair from a
single walk of the same index, which is what fills the pair selector.

### 11.3 The book is board plus archive

The book reads three layers deep. The live board is polled every 12 seconds and
every verified sighting lands in the store. `lib/archive.ts` backfills the same
store from `archive.msgboard.xyz`, a read-only Hasura endpoint that holds posts
the live board rolled off long ago, 50 rows at a time, newest first. The UI then
reads the store through one indexed query.

The archive gives the book breadth and proves nothing. Every archived row is
decoded and signature-checked locally before it enters the store, exactly like a
live one. The archive can be down or wrong without touching the board: a failed
page marks the archive unreachable in the header and the live path continues.

Enrichment is separate, and it only runs on open intents. One multicall reads
every maker's balance, one pass quotes every pair against the PulseX router, and
escrow rows read their reservation from the settlement contract. So the store
answers *what was signed*, and the chain answers *what is true now*.

The keepalive loop reads the poll's own key set, never the filtered view. A pair
filter or a "profitable only" checkbox must not make the app re-post intents
that are already on the board.

### 11.4 Tokens wear their own faces

`lib/tokenlist.ts` fetches the PulseX token list from `gib.show`, caches it in
`localStorage`, and refreshes it once a day. The list fills the picker and the
logo lookup. A logo comes from the list's own URI, or from the `gib.show`
by-address route when the list has none.

`TokenAvatar` renders at a fixed size, so a row never reflows as an image
arrives. When there is no logo — chain 943 is not in the list at all — it draws
a deterministic mark: two letters of the symbol over a hue derived from the
address. A failed image is remembered, so the app asks for it once. An x402
wrapper wears its underlying's logo, because the wrapper has none of its own and
a chip already marks the wrap.

### 11.5 The custody ladder in the UI

`CustodyLadder` shows the three rungs of §6.4, strongest first, and the app
selects the strongest one the token supports. Each rung states its cost in
signatures and transactions and the badge the board row will wear. Authorization
costs two signatures and no transaction. Escrow costs one signature and one
transaction, or two when the token still needs an approval. Approval costs one
signature and at most one transaction.

A rung that cannot be climbed says why in two words and stays unclickable:
`no eip-3009` when the token does not answer the probe, and `on deploy` for the
two rungs that need a settlement contract. The form is the explanation, so the
maker never reads a paragraph to learn what a mode costs them.

The badge on a board row now reads the chain rather than the flag. With a live
contract the app reads the reservation, so the escrow flag alone no longer earns
"proven": the deposit earns it, or the 3009 authorization that will fund it at
fill time. An escrow-flagged intent with an empty reservation says `escrow
empty` in red, and a pending unlock shows its countdown next to the badge.

### 11.6 The Mine tab

`Portfolio` lists every intent this wallet signed, newest first, from the same
store. Each row shows the pair, the size, the custody mode, and how much escrow
the contract actually holds against that intent hash.

Two buttons get escrow back. `unlock` starts the 15-minute cooldown, and the row
says plainly that the intent stays fillable throughout. `withdraw` collects once
the cooldown passes, and until then it counts down. Both stay disabled while the
settlement address is zero, and the reserved column says `not deployed` rather
than showing a hopeful dash.

### 11.7 Filling, and nominating a callback

> **Superseded, 2026-08-12, commit `ddab838`.** There is nothing left to
> nominate. `fillWithCallback` calls `msg.sender`, so the executor must *be* the
> `IProveCallback` contract, and a browser wallet cannot be one. `BatchTray`
> lost its callback mode with the parameter. The path now belongs to bots,
> through the SDK, which is who it always served. The second paragraph below
> describes a UI that no longer exists and a payment proof that is no longer
> how the contract works — see §8.3. It is kept so nobody rebuilds it.

`BatchTray` is the executor's side. It totals what a selection costs, returns,
and nets after the fee, and it names the contract function it is about to call
and why: `fill`, `fillBatch` with skip-invalid on, `fillWithAuthorization` when
the maker's 3009 signature has to fund the escrow at fill time, or
`fillWithCallback`.

An executor can nominate their own `IProveCallback` contract in the tray. The
app checks that there is code at the address, remembers it per chain, and shows
the callback signature and the deal in one line: the contract receives token A
first, owes token B to the recipient and the fee sink, and the balance delta
decides. That is how an executor with no inventory fills from a routed trade.
A callback fill takes one intent at a time, and an authorization-funded intent
inside a batch is called out as fillable only on its own.

The fill button arms on a successful `eth_call` and on nothing else. The tray
runs the simulation 400 ms after the selection settles and prints `sim ✓` or
`sim ✗` with the reason. While the settlement address is zero, the button reads
"Settlement not deployed".

### 11.8 Four rules the UI follows

1. **State comes from the chain, not the board.** The board says an intent
   exists, and the store remembers that it did. The contract says whether it can
   still be filled. Every row resolves `filled`, `cancelled`, funding and any
   reservation through a multicall before it claims an intent is live.
2. **Simulate before offering a fill.** The execute button is disabled until
   `eth_call` on the exact fill succeeds. An executor should never learn about
   a stale intent by paying for a revert. `fillability` (§8.5) turns a failure
   into a reason code, so a greyed-out row can say *why* it is grey.
3. **Show the rate the way a human reads it.** "1 PLS → 0.0000031 HEX,
   minimum", with the decay and the deadline next to it, not raw wei.
4. **Grinding is visible and cancellable.** The proof of work runs in a worker
   with a progress readout and a stop button. It never blocks the UI thread.

## 12. Failure modes and how the design answers them

| Failure | Answer |
|---|---|
| Maker signs an intent with no balance | The card shows "unfunded". Executors simulate, so a stale intent costs them a call, not gas. |
| Maker withdraws mid-fill | Approval mode: the fill reverts. Escrow mode: the cooldown makes it impossible inside the window. |
| Maker front-runs the executor with a second escrow intent | Escrow is reserved per intent hash, so the second intent has no funds behind it and fails with `EscrowShort`. The first intent's reservation only leaves through that intent or the cooldown. |
| A caller routes the buyback through a pool they just made | The owner sets one route per token, and `minPlsxOut` must clear the router's own quote less `maxSlippageBps`. A token with no route cannot be sold at all. |
| One EIP-3009 authorization is replayed against another intent | The 3009 nonce must equal the intent hash, so an authorization funds exactly one intent and an on-chain cancel really revokes it. |
| Token B taxes its own transfers | Every fill path checks the recipient's balance delta, so the fill reverts with `Underpaid` rather than paying the maker less than the signed rate. |
| A contract maker returns a dirty ERC-1271 word | The answer is decoded by hand under a 60,000 gas cap. A hostile maker is a bad signature, not a reverted batch. |
| A batch carries nonsense terms | A rising minimum or the same token on both sides is `Reason.BadTerms_`, so `skipInvalid` steps over it instead of letting it revert the batch. |
| A maker revokes their allowance before a batch lands | In approval mode the skip path reads the maker's allowance and balance before committing, so the batch skips that row and keeps the rest. |
| Two executors race the same intent | The loser's transaction reverts on the fill accounting. Partial-fill intents let both take a slice. |
| A batch loses one race | `fillBatch(reqs, true, maxFeeBps)` steps over the intent it can no longer fill and takes the rest. The skip path re-runs every check as a view, so a skipped intent is never half-filled. |
| A fee arrives as an x402 wrapper | `buyback` redeems it at par instead of routing it, so the sink never pays slippage for a token that is redeemable 1:1. |
| Board drops the intent | Anyone may re-post, and a solver who wants the order alive has the incentive to. The maker's tab does it automatically while it is open. The row stays in the local book with an off-board mark rather than vanishing. |
| Nobody re-posts the intent | It stops being visible. Accepted (§10.1). The signature stays valid on-chain, and one re-post brings it back. A paid keepalive service would fix this by giving a third party first sight of every intent, which costs more than it buys (§7.2). |
| The archive is down or lying | The book loses breadth, not truth. Every archived row is decoded and signature-checked locally before it is stored, and the live board path does not wait for the archive. |
| The RPC reports a post failed when it did not | Observed on a load-balanced endpoint: one upstream accepts the message, a second rejects the duplicate, and the caller sees the rejection. After any `addMessage` error the app asks `msgboard_getMessage` for the hash it ground, and only calls the post failed when the board answers null. |
| Node lies about board content | Any reader verifies the signature and the proof of work locally. A lying node can hide messages, not forge them. Configurable multi-RPC read fixes the hiding. |
| Fee token is illiquid on PulseX | `buyback` is permissionless, but the route is owner-set. Illiquid fees sit until the owner vets a path worth taking. |
| Reentrancy through the callback fill | A guard across the whole call, `filled` written before the release, and payment taken by a directed pull after the callback rather than inferred from a balance (§8.3). |
| The owner raises the fee under a pending fill | Every fill path takes a `maxFeeBps` and reverts with `FeeTooHigh` if the live `feeBps` is above it (§8.1). |
| A maker cancels a funded escrow intent inside the window the executor was promised | `cancel` and `invalidateBefore` return an `effectiveAt` one cooldown out for escrow intents (§5.3). |
| A matured cooldown becomes a free option | The withdrawal window is one cooldown wide and then shuts. Re-arming costs one more `requestUnlock` (§6.2). |
| Signature replay on another chain | `chainId` and `verifyingContract` are in the EIP-712 domain. |

### 12.1 The audit

A security audit read both contracts on **2026-08-11**, before any deployment.
It found **one critical and one high finding**, and six smaller ones:

| Finding | What it was | Where the answer lives |
|---|---|---|
| **C-1** critical | Anyone could route the sink's whole balance through a pool of their own, at any price, and keep the fees. | §9.2 |
| **H-1** high | Pooled escrow let a maker spend their own committed funds through a second, self-dealing intent, with no cooldown. | §6.2 |
| M-1 | `fillBatch(skipInvalid: true)` still reverted on an unfunded maker and on nonsense terms. | §8.2 |
| M-2 | A contract maker could return a dirty ERC-1271 word and revert the whole batch inside `abi.decode`. | §8.2 |
| M-3 | Only the callback path checked the maker's proceeds by balance delta, so a taxing token could short the maker. | §8.1 |
| M-4 | An EIP-3009 authorization was not bound to an intent, so it armed every same-size intent the maker signed. | §6.3 |
| L-1 | A token that lied about `underlying()` could point a sale at the wrong token. | §9.3 |
| L-2 | An intent with the same token on both sides let one balance delta satisfy two checks. | §8.1 |

Every finding is fixed, and `contracts/test/Security.t.sol` holds one regression
test per finding, named for it. Each test *is* the attack: it fails if the hole
opens again. That is the point of keeping them in a file of their own rather
than folding them into the unit suite — nobody can delete the defence without
deleting a test that describes what it defends.

**A second audit read the economics on 2026-08-12**, and its findings are
numbered `F-`. They live in `contracts/test/EconAudit.t.sol`, written the same
way: each test drives its attack to completion and then asserts on the money.
The fixes landed in commit `e1437e7`.

| Finding | What it was | Where the answer lives |
|---|---|---|
| F-1 | `depositFor` took a bare hash, so the first caller owned the escrow. | §6.2 |
| F-2 | `FeeSink`'s slippage floor was quoted by the pool it was about to trade in. | §9.2 |
| F-3 | `skipInvalid` skips the reasons it knows and nothing else. A token that reverts still takes the batch. | §8.2 |
| F-4 | `cancel` and `invalidateBefore` walked straight past the escrow cooldown. | §5.3 |
| F-5 | A matured cooldown never re-armed, so it matured into a free option. | §6.2 |
| F-6 | The executor signed no fee bound, so the owner could raise the fee under a pending fill. | §8.1 |

Every `F-` finding is fixed. F-2 was fixed separately, in commit `ac3f048`,
after the other five. **The file-level comment at `EconAudit.t.sol` line 53
still says F-2 "PASSES WHILE DEMONSTRATING A LOSS" and is stale** — the
comment on the test itself, line 232, reads "FIXED 2026-08-12. The attack below
is the one that worked; it now reverts." Believe the test, and delete the
header line when someone next touches that file.

## 13. Testing

### 13.1 Unit and property tests

**Codec and EIP-712** — no unit suite yet. `app/scripts/live-post.ts` round-trips
one real intent through the codec, field by field, and re-verifies the signature
after the decode, but it needs a live board and it covers one shape. The
presence-bit branches, the kind `0x02` authorization trailer and the boundary
values deserve generated cases in a runner.

The hash fixture is also unbuilt. The plan is to export the contract's own
`hashIntent` output through Foundry and check the TypeScript against it, so the
two implementations cannot drift. The two struct definitions agree today by
inspection, and `hashIntent` is public, so wiring the check is a small job worth
doing before the first deploy.

> **Done, 2026-08-11, commit `6642c1c`.** Both paragraphs above are superseded.
> `contracts/test/Fixture.t.sol` writes a canonical intent, its digest, the rate
> curve at three points and one quote to
> `app/src/lib/__fixtures__/eip712.json`, and the TypeScript suite asserts
> against that file. CI regenerates it and fails on `git diff --exit-code`, so
> the two implementations cannot part ways quietly —
> `.github/workflows/ci.yml`, the "Fixture is current" step. The codec now has
> eighteen tests covering field order, the rate curve and its rounding, round
> trips including the kind `0x02` authorization trailer and every presence-bit
> branch, truncation, rubbish and payload size. They moved to `sdk/src/` with
> the codec (§4).

**Contracts** — Foundry, **101 tests, all passing**: 97 offline and 4 against a
mainnet fork. `solc 0.8.30`, optimizer on at 1000 runs, and `via_ir`.
`evm_version = "paris"` on purpose: Paris emits no PUSH0, so the same bytecode
runs on any chain the registry might add later, without first checking which
hard forks that chain took.

The offline suite runs against mocks, in six files:

| File | What it holds |
|---|---|
| `ProveSettlement.t.sol` | The rate math and its rounding direction, dutch decay at both boundaries and past expiry, partial fill accounting, all three custody paths, the escrow cooldown, `cancel` and `invalidateBefore`, ERC-1271 makers, pinned executors, forged and tampered signatures, callback fills including underpayment and a reentrancy attempt, and batches with and without `skipInvalid`. |
| `FeeSink.t.sol` | Every route the sink can take: plain token, wrapper, wrapper of a non-PLSX underlying, PLSX itself, a token with no route, the slippage floor, and the caps. |
| `Edges.t.sol` | The corners — `fillability` on each reason, a reservation that holds one token, who may unlock, a route the owner sets wrong, and every owner-only setter. |
| `Fuzz.t.sol` | Nine properties over generated terms, listed below. |
| `Security.t.sol` | One regression test per audit finding (§12.1). |
| `Invariants.t.sol` | A stateful run over a handler that signs, fills, batches, deposits, unlocks, withdraws, cancels and jumps time. |

Nine fuzz properties, including: the decay is monotonic and stays inside both
bounds, splitting a fill never pays the maker less than taking it whole, garbage
never passes as a signature, tampering with any signed field breaks it, escrow
round-trips to the wei, and no withdrawal lands early.

Six invariants hold across 128 runs of 64 calls each: `sum(fills) <= amountIn`,
the contract holds exactly the reservations it owes and no token B at all, every
maker received what they were owed, and no reservation ever goes negative.
This closes the "still to write" item from the first draft of this spec.

Coverage of `src/` alone — tests and scripts excluded — is **99.69% of lines,
98.45% of statements, 89.89% of branches and 100% of functions**.

```sh
forge coverage --ir-minimum --report summary --no-match-coverage "(test|script)"
```

`--ir-minimum` is not optional. Coverage disables the optimizer, and
`ProveSettlement` does not compile without via-IR.

**App** — not written yet. CI typechecks and builds the app on every push
(§13.6), and the bots of §13.3 exercise the codec, the board and the fill path
against a real node, but there is no unit suite over the hooks or the rate
display. Say so plainly rather than counting the bots as tests they are not.

### 13.2 Fork tests

Four fork tests run against mainnet, pinned to block **27,260,000** so a run
today and a run next month see the same liquidity. They use real WPLS, real
PLSX, real HEX, the real PulseX V2 router and the real x402PLSX wrapper:

- a direct fill in real tokens,
- a callback fill routed through the live router by a bot that starts empty,
- a `FeeSink` buyback selling real HEX for PLSX over the owner-set two-hop
  route, at a floor taken from the router's own quote,
- the real x402PLSX wrapper redeemed at par instead of swapped.

Every one of them returns immediately unless `PULSECHAIN_RPC` is set, so plain
`forge test` stays offline and fast.

```sh
PULSECHAIN_RPC=https://one.valve.city/rpc/vk_demo/evm/369 \
  forge test --match-path test/Fork.t.sol -vv
```

Three traps cost real time. The tests carry them as comments so nobody pays
twice:

1. **Do not fork in `setUp`.** A fork created in `setUp` and then snapshotted
   between tests loses the lazy account fetch that a call into a delegatecall
   proxy needs. The real x402 wrapper is a minimal proxy, and it reverts. Each
   fork test creates its own fork instead.
2. **Do not `deal` PLSX.** PLSX carries delegate checkpoints. forge-std `deal`
   writes the balance slot and leaves the checkpoints alone, so the next
   transfer underflows. The tests buy PLSX from the pool, which is what a real
   executor does anyway. WPLS is a WETH9 clone with no checkpoints, so `deal`
   is safe there.
3. **A helper that makes a call eats the cheatcode.** `vm.prank` and
   `vm.expectRevert` apply to the *next* call. A test helper that itself calls a
   contract consumes them, and the assertion then lands on the wrong call
   without saying so. Set the cheatcode immediately before the call it belongs
   to.

Time travel needs no fork. The unit suite jumps a dutch decay or an escrow
cooldown with `vm.warp`.

An end-to-end test for the app is planned and not written. It would drive
Playwright against an Anvil node with an injected test wallet, and stub the
board client. The board already has the live test below.

### 13.3 Heartbeat bots

Unit tests prove the code is right. Heartbeat bots prove the *system* is up —
the node still serves the module, the difficulty is still grindable from a
laptop, the codec the app writes is still the codec the app reads.

A heartbeat bot is a small process that runs the whole path on a timer:
sign → encode → grind → post → read back → decode → verify signature. It keeps
a set number of its own intents live on the board and re-posts them as the
board ages them off, which has a second benefit: the board is never empty for a
first-time visitor. It logs one line per pass, and exits non-zero after five
consecutive failures so a supervisor restarts it rather than leaving a silent
zombie.

They start on **testnet (943)** and stay there until the contracts are on
mainnet. The fleet:

1. **Maker bot** — the loop above. Built: `app/scripts/heartbeat.ts`.
2. **Keepalive bot** — re-posts *other people's* live intents, not just its own.
   Not built. It is a small job, and §7.3 says why nobody has to be paid to do
   it.
3. **Executor bot** — built: `app/scripts/executor.ts`.
4. **Watchdog** — built: `app/scripts/watchdog.ts`.

Each bot takes `--chain`, so promoting the fleet to mainnet is a flag, not a
rewrite. Each imports `app/src/lib/intent.ts` and `app/src/lib/config.ts`, so a
codec change or a new chain reaches the bots and the app together.

**The executor** reads the board, verifies every signature, and asks the
contract what is left of each intent. It prices the intent against the PulseX
router, compares the market's output with what the maker and the fee sink are
owed, and fills only when the spread clears `--min-spread` (50 bps by default).
It simulates every fill with `eth_call` before it sends one. `--dry-run` logs
the candidates and sends nothing.

Then it does the thing it exists for. After the receipt lands, it reads the
recipient's token B balance before and after, recomputes the owed amount from
the signed terms with `minOutAt`, and asserts the maker received at least that
much. A short-changed maker is not a warning: the bot logs `ALERT` with the
transaction hash and exits 2. A unit test proves the code is right; this proves
the deployed system is right, over and over.

**The watchdog** checks five things, in the order they break:

1. The board answers and reports itself enabled, with sane difficulty factors.
2. Every message in the `provecash` category decodes and its signature
   verifies. A bad signature in our own category is either a codec change nobody
   announced or somebody probing us.
3. The archive has kept up with the live board. Anything the board holds that
   the archive has not seen after a grace period (10 minutes by default) is data
   about to be lost.
4. Every `Filled` event in the new blocks paid the maker at least the signed
   rate.
5. The board still accepts work, proved by reading the difficulty rather than by
   posting.

Check 4 is the one that matters, and it is deliberately suspicious. The watchdog
does not trust the contract's own view of what it paid: it recomputes the owed
amount from the signed terms it decoded off the board, at the block timestamp of
the fill, and compares that with the `delivered` amount in the event. So the
event and the terms can disagree, and somebody finds out. It only checks fills
whose intent it has seen on the board, because those are the only terms it
knows.

Both bots split alerts from noise. A broken invariant exits non-zero so a
supervisor notices: the watchdog exits 3, and the executor exits 2 on a
short-changed maker and 1 after five consecutive failed passes. A degraded
dependency warns and keeps running — an unreachable archive, a flaky RPC, and a
pass that threw all print `WARN`. The watchdog also POSTs every alert to
`WEBHOOK` when one is set, and it says so when the webhook itself is
unreachable. A watchdog that cries wolf gets muted, and a muted watchdog is
worse than none.

Both degrade honestly with no settlement address, which is the state today. The
executor prints that settlement is not deployed on that chain, says where to put
the address, and exits 0 — it never pretends to work. The watchdog disables its
fill checks and keeps doing the rest: the board, the signatures, the archive.

### 13.4 Live checks

`app/scripts/live-post.ts` posts one real intent to a real board and reads it
back. Run it before every deploy. It is the only test that touches a production
board, and it is the fastest way to tell a broken build from a broken node.

### 13.5 Gas

`test/Gas.t.sol` measures every path and prints a table:

```sh
forge test --match-path test/Gas.t.sol -vv
```

| Path | Gas | Per intent |
|---|---|---|
| Fill, approval mode, first touch of the intent | 110,298 | 110,298 |
| Fill, approval mode, warm | 30,319 | 30,319 |
| Fill, escrow mode | 55,407 | 55,407 |
| `fillBatch` × 1, one output token | 56,446 | 56,446 |
| `fillBatch` × 5, one output token | 222,538 | 44,507 |
| `fillBatch` × 20, one output token | 841,432 | 42,071 |
| `fillBatch` × 20, alternating output tokens | 844,634 | 42,231 |

The marginal number is the one that matters. A batch of twenty in one output
token costs about 25% less per intent than a batch of one: the transaction base
cost, the fee configuration read, and the fee transfer are all shared. An
executor who mixes output tokens loses the shared fee transfer and pays twenty
of them, but that only costs 160 gas per intent here, because every write after
the first lands on a slot the same transaction already dirtied.

The audit fixes cost roughly 4,300 gas on every fill: the balance-delta check on
the maker's proceeds, the term checks, and the per-intent reservation lookup.
That was accepted without argument. An executor pays it once per fill; a maker
who loses their escrow to a self-dealing front-run pays everything.

### 13.6 Version control and CI

The repository is under git, and `.github/workflows/ci.yml` runs on every push
to `master` and on every pull request. Two jobs run in parallel. The contracts
job builds with `--sizes`, runs the whole Foundry suite, runs coverage over
`src/` with `--ir-minimum`, and prints the gas table. The app job installs from
the lockfile, typechecks with `tsc -b`, and builds.

The fork tests skip themselves without `PULSECHAIN_RPC`, so CI stays offline and
fast unless that secret is set on the repository. Coverage excludes the fork
path for the same reason.

`contracts/lib` holds two git submodules, pinned to a commit: `forge-std` and
`openzeppelin-contracts`. CI checks out with `submodules: recursive`. Pinning
matters more here than anywhere else in the tree — a moving `forge-std` changes
what a test means, and a moving OpenZeppelin changes what the contract *is*.

## 14. Build order

Each step ends with something that runs.

Testnet first. Nothing touches mainnet until the same thing has run on 943
under a heartbeat for a week.

1. ~~**Measure the board.**~~ Done. A 176-byte intent grinds in about a second
   with the WASM engine, at a difficulty of 185,372 under the board's current
   factors. The board keeps roughly 120 blocks, so a live intent needs
   re-posting every few minutes.
2. ~~**Codec and EIP-712.**~~ Done in `app/src/lib/intent.ts`, round-tripped
   against a live post.
3. ~~**Compose and board views.**~~ Done. Sign, grind, post, read, verify,
   display, and keep alive — on both 369 and 943.
4. ~~**Maker heartbeat bot.**~~ Done, running on 943.
5. ~~**`ProveSettlement` and `FeeSink`.**~~ Done, and wider than the step asked
   for. The plan was the approval path at a fixed price, all or nothing. What
   landed is the whole contract: three custody modes, per-intent escrow behind a
   cooldown, EIP-3009 authorization bound to its intent, dutch decay, partial
   fills, callback fills, batch fills, ERC-1271 makers, capped owner-settable
   fees, and `FeeSink` with the wrapper-aware buyback on owner-set routes. 97
   offline tests and 4 fork tests pass, and the 2026-08-11 audit (§12.1) is
   answered. **Not deployed to any chain**, so the app still shows execution as
   unavailable.
6. ~~**The execution UI.**~~ Done, and waiting on a contract. Direct fill,
   batch fill with skip-invalid, `fillWithAuthorization`, callback fill with an
   executor-nominated contract, partial fills, dutch decay, the reservation-read
   proven badge, escrow deposit against the intent hash in the compose flow, and
   the Mine tab listing reservations with their pending unlocks. Every button is
   gated on a clean `eth_call`, and every one of them is disabled while the
   settlement address is zero.
7. ~~**Executor and watchdog bots.**~~ Written (§13.3). Both refuse to do their
   settlement work without a deployed address, and say so.
8. **Deploy to 943.** `forge script script/Deploy.s.sol` against the testnet
   config, then put the settlement address in the registry entry. This is the
   step that turns execution on — in the UI, in the executor bot, and in the
   watchdog's fill check. It is the only thing standing between steps 6 and 7
   and a continuously-verified trade.
9. **Run the fleet on 943 for a week.** Maker, executor and watchdog, on a
   supervisor, with the alerts going somewhere a person reads.
10. **Buyback keeper.** A bot that calls `FeeSink.buyback` once a fee balance is
    worth a route, and keeps the tip. Fees accrue from step 8 and sit until
    somebody runs this.
11. **Mainnet.** Deploy the contracts to 369, add the addresses to the registry,
    move the heartbeat fleet over, point prove.cash at it.

No step buys a paid job service. §7 says why.

## 15. Out of scope for v1

Cross-chain intents — the app runs on several chains, but one intent never
spans two. Order aggregation and netting between two makers. A mirror or indexer
of our own: the app reads the public msgboard archive and hosts nothing.
Paid jobs in the order path (§7). Fee-on-transfer token support. Native PLS as
anything other than WPLS. Mobile wallet deep-linking. Governance over the fee
parameters.

**Added 2026-08-12, and decided rather than deferred: hooks. None ship.**
`2026-08-12-hooks-design.md` is the whole argument, and it says no to every
form of the idea — executor pre-hooks and post-hooks, maker hooks, and the
`ProveShed` proxy that §3.3 of that note proposed as a replacement before §3.4
withdrew it. So "swap and deposit in one action" is not a v1 gap to be filled
later; it is a thing the protocol has decided not to be. Do not claim it, and
do not let a UI imply it.

Three findings were taken out of that work anyway, and all three are in the
contract as of `ddab838`: the selector rule (§8.3), pull-don't-measure (§8.3),
and call-the-caller (§8.3). One recommendation is still open, and it is the
`fillBatchWithCallback` prototype that §8.3 records as absent from `master`.

Two more items are out of scope because the chain cannot do them (§4.1): any
account-abstraction or smart-account feature, and atomic unstake-and-swap for a
position an EOA already holds. Neither is a roadmap item. Both are blocked on a
Pectra fork that has not happened.

## 16. Open items

**Two items closed on 2026-08-12, and one new one opened. They are listed first
because the list below them has not been re-read since 2026-08-11.**

- **Closed: hooks.** Decided, and the decision is to ship none.
  `2026-08-12-hooks-design.md` holds the reasoning; §15 holds the summary. This
  was never a numbered item here, and it is recorded so nobody re-opens it as
  one.
- **Closed: EIP-7702 and account abstraction.** Not an open question and not a
  choice. Neither PulseChain network has Prague, measured 2026-08-12 (§4.1).
- **Open, and waiting on the owner: `withdrawExpired`.**
  `2026-08-12-escrow-exit.md` proposes one function that lets a maker collect an
  expired intent's escrow in a single transaction with no cooldown, replacing
  `requestUnlock` + wait + `withdraw`. The safety argument is that both jobs the
  cooldown does end at `endTime`: past `_evaluate` line 762 no fill can happen,
  so there is no mempool fill to front-run and no free option to hold. It is
  written, checked against the deployed contract, and **not implemented**. It is
  the owner's call. The note also flags a companion idea — letting anyone call
  `withdraw` once the cooldown matures — and the flaw in it.

1. Where the bought PLSX lands: treasury, burn, or staking distributor. The
   contract keeps it behind a settable address so this is not blocking.
2. **What "some portion going back to the executor" should mean.** That was the
   ask. A credit the executor claims later is circular — the executor pays the
   fee and takes part of it straight back, in the same token, in the same
   transaction — so the implementation reads the ask as a discount at source
   (`executorRebateBps`, netted inside `quote`) and puts the real reward in the
   keeper tip that `FeeSink.buyback` pays in PLSX. That is the interpretation
   that survives the circularity. If the intent was something an executor
   accumulates and withdraws, it needs a different payer or a different token,
   and it is not what ships today. Confirm which one was meant.
3. The escrow cooldown length. 15 minutes is a contract constant and a starting
   number. Nothing has argued for a different one yet, and testnet fills are the
   place to find out.
4. ~~The EIP-712 hash fixture between the app and the contract (§13.1). The two
   struct definitions match today, and nothing enforces it.~~
   **Closed, 2026-08-11, commit `6642c1c`.** CI enforces it. See §13.1.
5. **A token that lies about its own `balanceOf` can inflate its reservation.**
   `deposit` — renamed from `depositFor` by F-1, §6.2 — credits the balance
   delta, so a token that reports more than it moved books escrow that is not
   there. The damage stops at that token and the
   maker who chose it: no other reservation shares the balance, and no other
   maker is exposed. Accepted, not fixed. A contract that trusts nothing about a
   token cannot hold tokens at all.
6. **The `FeeSink` owner key is custodial.** `setPlsxSink` and `setRouter` both
   redirect where proceeds go, and there is no timelock. Whoever holds the key
   can point the buyback at themselves. Fees only, never maker funds — but say
   so plainly rather than calling the sink trustless. A timelock or a multisig
   is the obvious answer and neither is written.
7. **Nothing keeps an intent alive when every tab closes.** §7 rejected the paid
   keepalive service, and the free replacements are the maker's own tab and any
   solver who wants the order to survive. Neither is guaranteed. The failure is
   soft — the intent stops being visible and stays valid — and the fix, if the
   board ever needs one, has to be a party with no early sight of the intent.
   Watch how long real intents survive on 943 before deciding this is a problem.
8. **Whether x402 metering is worth building at all.** §7.4 leaves the door open
   for bulk archive access and RPC quota, and neither has a customer today. Do
   not build either until something asks for it. The test stays the same: no
   paid call may show anyone an intent before it settles.
9. **The app has no test suite.** CI typechecks and builds it, and the bots
   exercise the real path, but the hooks, the store's merge rules and the rate
   display have no unit tests (§13.1). The store is the piece that most deserves
   them: it decides what the book remembers.

   **Partly closed, 2026-08-12.** The SDK carries Vitest suites for the pieces
   that moved into it: `sdk/src/intent.test.ts`, `config.test.ts`,
   `settlement.test.ts`, `store/store.test.ts` and `solver/solver.test.ts`. So
   the store does have tests now. What still has none is the browser half — the
   React components, `useBoard`, and the rate display.
10. **An EIP-3009 fill redeems the whole `amountIn` for any size of take.** The
    token's authorization is fixed-value, so a 1% partial fill still pulls 100%
    into the reservation. The remainder is safe and spendable by later fills of
    the same intent, but it cannot fund a different intent and it only comes
    back through the 15-minute cooldown. A maker who signs a large intent and
    gets one small fill waits.

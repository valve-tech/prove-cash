# Design notes

Newest decisions win. A document is never edited to hide what it used to say — when a decision is
reversed, the reversal is written at the top of the document that argued for it, and this index
records which way it went.

## Where things stand

[`ROADMAP.md`](ROADMAP.md) is the checkpoint: what is built, what is deployed, and the
numbered backlog. Read it first. The documents below are the arguments behind those
decisions.

[`ADDRESSES.md`](ADDRESSES.md) is every address on both chains — contracts, keys, bot
wallets, tokens, venues — with what changes at the next mainnet deploy. The deployment
records under `contracts/deployments/` stay the source of truth for contracts; that page
exists because the keys and the bot wallets were written down nowhere else.

## How specs work here

[`specs/README.md`](specs/README.md) says it in full. A spec states
intent: what a part of the system must do, what it must never do, and why, with the owner's
decisions in the owner's words. Each spec has a **Status** under its title: **Proposed**,
**Approved**, **Built** (with commits), or **Superseded by X**. It cites code by symbol name
where it can. Where the code and an Approved or Built spec disagree, one of them has a bug:
write it down and let the owner decide. Never resolve it silently.

A status is a claim like any other. **Built** names the commits on `master`. **Superseded by X**
names X. Nobody deletes a spec or rewrites its body to hide what it said. A correction goes at
the top of the spec, with its date.

The index is at the bottom of this page. It lists every spec with its true status, checked
against the code and `git log` on 2026-09-23.

## What changed under these documents

Contract changes that landed after a document was written. Read
`contracts/src/ProveSettlement.sol` before you trust any prose about them.

- **The relayer split** — `ProveSettlement` holds no ERC-20 allowance of any kind. `ProveRelayer`
  holds every one. The settlement deploys it in its constructor and exposes it as `relayer()`.
  Makers and executors approve the relayer; approving the settlement does nothing.
  The Tour now names the relayer (`tour.callback.body` in `app/src/i18n/en.ts`).
- **The cooldown is gone** — `requestUnlock`, `unlockAt`, `UNLOCK_COOLDOWN`, `WITHDRAW_WINDOW` and
  `withdrawExpired` were all deleted. `withdraw` returns the money in one call, and it also
  cancels the intent, so `deposit` then refuses it. The `Reservation` struct is gone too:
  `_reserved` is a plain `mapping(bytes32 => uint256)`.
- **The wallet window has no cap** — `MAX_WALLET_WINDOW` and both of `_termsOk`'s time bounds
  went in `a7c5d7f`. `_termsOk` reads no clock at all now. A maker decides how long their own
  signature stands, because a stale wallet signature costs the maker who signed it and nobody
  else. The app warns and does not block. An escrowed intent still rests indefinitely, and an
  EIP-3009 authorization still carries its own `validBefore`.
- **Two more contracts** — `ProveExecutor` fills with no inventory from any venue, and
  `ProveCallSink` makes the arbitrary call so the executor never does. Both are unowned and
  permissionless.
- **Fee sinks** — `4d48379`. An intent with `feeRate > 0` must name a registered `FeeSink`, an
  immutable record of one destination and one `minRate`. The owner's `registerFeeSink` adds a
  sink for all time and nothing removes one. `claim(sink, token)` pays the sink's destination.
  Since 2026-10-01 an intent with `feeTo = 0` pays no fee: clients write the default sink and its
  rate into the intent at signing, and no fill reads the default.
  [`FEE-MODEL.md`](FEE-MODEL.md) has the whole model.
- **Fee config hash** — `feat/fee-config-hash`, 2026-10-03, local and unmerged. The sink registry
  is gone. An intent signs `feeConfig`, a hash of a destination list and its weights, and three
  rates (one per take point). The settlement has no owner and `claim` takes the preimage. Advisory
  defaults live in `FeeDefaults`; the reads live in `ProveReader`. Everything above about
  `FeeSink`, `feeTo` and the owner-gated functions is history. See
  [`FEE-MODEL.md`](FEE-MODEL.md) and `specs/2026-10-03-fee-config-hash.md`.
- **`ddab838`** — `fillWithCallback` no longer takes a `target`. It calls `msg.sender`, and it
  **pulls** the payment afterwards instead of watching balances. The Tour has caught up on this.

## The rule these notes keep

Every claim in a document names where it can be checked — a file and a line, a commit, a contract
address, or a URL. A claim that cannot be checked is marked unverified rather than dropped.

## Index

One row per file in `specs/`, oldest first. **When you add a spec, add its row at
the bottom in the same commit.** When a status changes, change the spec's Status line and its row
together.

| Document | What it is | Status |
|---|---|---|
| [`2026-08-10-prove-cash-design.md`](specs/2026-08-10-prove-cash-design.md) | The master design: intent, custody, execution, fees, board, app, tests | **Built, stale in part.** §5.1, §5.3, §6.2 and §9 no longer describe the contracts, and §11 describes a one-surface app. The note at its top says where the truth is |
| [`2026-08-12-escrow-exit.md`](specs/2026-08-12-escrow-exit.md) | `withdrawExpired`, and why the cooldown protects nothing past `endTime` | **Superseded by `66c43fa`.** The whole cooldown is gone, so `withdrawExpired` has nothing left to fix |
| [`2026-08-12-hooks-design.md`](specs/2026-08-12-hooks-design.md) | Executor hooks, maker hooks, and the allowance under both | **Built in part.** The decision was to ship no hooks, and §2 was reversed: `fillBatchWithCallback` is built. Two findings are in the contract since `ddab838`: pull, don't measure, and call the caller |
| [`2026-08-12-solver-design.md`](specs/2026-08-12-solver-design.md) | Ring matching over signed intents | **Built, core only.** It names 5 of the 21 modules in `sdk/src/solver/`, and `_deliverOnly` is gone. The ring algebra holds |
| [`2026-08-12-surfaces-and-claims.md`](specs/2026-08-12-surfaces-and-claims.md) | The landing/app split, and the claims the UI is allowed to make | **Built.** Read before writing user-facing copy |
| [`2026-08-14-checkpoint.md`](specs/2026-08-14-checkpoint.md) | Where the code stood on 2026-08-14 | **Superseded by [`ROADMAP.md`](ROADMAP.md).** A snapshot, kept as history |
| [`2026-08-14-scale-and-rationing.md`](specs/2026-08-14-scale-and-rationing.md) | Minimum trade size, who gets the storage, and a Rust indexer | **Built in part.** §5's middle-leg fix is built. §7's Rust indexer and solver are not |
| [`2026-08-17-market-visuals-page-layouts.md`](specs/2026-08-17-market-visuals-page-layouts.md) | Which market visuals (mockup variants A–F) go on `/board`, `/sign`, `/mine`, and why | **Built in part.** Build steps 1–3 are in `app/src/components/charts/`. The Mine visuals and pair analytics are not |
| [`2026-08-17-i18n.md`](specs/2026-08-17-i18n.md) | Globe language picker, Apple's language list, dictionary architecture, phased scope | **Built**, first in `4c90f90`: `LanguagePicker` and 35 locales in `app/src/i18n/` |
| [`2026-08-17-rpc-controls.md`](specs/2026-08-17-rpc-controls.md) | Icon-only endpoints button (no raw domain in the nav) and the link icon that replaces "locked · one URL" | **Built** on 2026-08-17 (`016eae0`, `EndpointsButton.tsx`) |
| [`2026-08-17-responsive-visuals.md`](specs/2026-08-17-responsive-visuals.md) | How each embedded visual and the header controls behave at 375px | **Built in part.** The charts render at measured width. The Mine rule has no visual to apply to |
| [`2026-08-24-fee-disposal.md`](specs/2026-08-24-fee-disposal.md) | Whether `FeeSink` should stop swapping and forward fees to PulseX's buy-and-burn, measured on chain | **Superseded by `2026-08-26-neutral-protocol.md` (#117).** `cf61733` deleted `FeeSink`. The measurements still hold |
| [`2026-08-25-fee-resolution.md`](specs/2026-08-25-fee-resolution.md) | Moving the fee rate off basis points onto a fraction of one ether | **Built** in `3af12d3` and `3070196`. Read the closing section before any similar rename |
| [`2026-08-26-neutral-protocol.md`](specs/2026-08-26-neutral-protocol.md) | prove.cash takes no fee. What that deletes | **Built** in `84e8895`. **Its title is wrong:** the settlement has an owner. The correction under the title lists the owner's powers |
| [`2026-09-03-the-signed-intent-before-mainnet.md`](specs/2026-09-03-the-signed-intent-before-mainnet.md) | The curve field, the fee from the maker's number and the fee book, and parked capital | **Built** in `78e0ef4`, `d1dd385`, `36701c9` and `8b7d92a` |
| [`2026-09-08-delegation-and-bulk-maker-actions.md`](specs/2026-09-08-delegation-and-bulk-maker-actions.md) | Delegation, multicall and plural maker actions | **Built in part.** Recommendation 1, the keyed nonce floor (#131), is built. The rest is Proposed |
| [`2026-09-08-netting-a-coincidence-of-wants.md`](specs/2026-09-08-netting-a-coincidence-of-wants.md) | Two makers who match swap directly | **Proposed, not built.** Its own measurements argue against it, and `ROADMAP.md` leaves it unbooked |
| [`2026-09-23-fee-sink-registry.md`](specs/2026-09-23-fee-sink-registry.md) | Fee sinks with owner-set WAD splits and an allowlist | **Superseded by `2026-09-23-fee-sink-fixed-destination.md`.** Built only on the unmerged `feat/fee-sink-registry` (`ad661e0`) |
| [`2026-09-23-fee-sink-fixed-destination.md`](specs/2026-09-23-fee-sink-fixed-destination.md) | One fixed destination per sink, and a registration nobody can remove | **Built in part.** Approved on 2026-09-23. Contracts built in `4d48379` and `64224af`, on `feat/fee-sink-fixed`, not yet on `master`. SDK and app in progress on `sinks-app` |
| [`2026-09-23-settlement.md`](specs/2026-09-23-settlement.md) | What `ProveSettlement` must and must never do, as numbered MUSTs with a traceability table | **Proposed.** OW-2 has no default-sink exception since 2026-10-01. The fee-sink rules FE-6 to FE-10 and the fixes for its B-1 and B-2 are built (`4d48379`, `64224af`). The rest waits for the owner |
| [`2026-09-23-executors-and-venue.md`](specs/2026-09-23-executors-and-venue.md) | The executors, the call sink and the RFQ venue, stated as intent | **Proposed** |
| [`2026-09-20-gas-cover-fee-split.md`](specs/2026-09-20-gas-cover-fee-split.md) | An optional interface-fee destination that spends part of the fee on maker-side and claim gas | **Proposed.** A product on top of #119 and #122. Version 1 needs no settlement change |
| [`2026-09-23-solver-graph-and-bots.md`](specs/2026-09-23-solver-graph-and-bots.md) | The solver, the pool graph, the bots and their operation | **Proposed** |
| [`2026-09-23-sdk-and-app.md`](specs/2026-09-23-sdk-and-app.md) | What the SDK and the app must do | **Proposed.** Its fee-sink parts are in progress on `sinks-app` |
| [`2026-10-03-fee-config-hash.md`](specs/2026-10-03-fee-config-hash.md) | Fees keyed by a signed config hash, three take points, `FeeDefaults`, `ProveReader`, the linked `FeeClaimLib` | **Built** on `feat/fee-config-hash` (local, unmerged). Written from the code; the owner's text was not in the tree. Supersedes the fixed-destination spec |

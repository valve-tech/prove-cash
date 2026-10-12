# FeeSink registry: multi-destination WAD splits

**Status: Superseded by [`2026-09-23-fee-sink-fixed-destination.md`](./2026-09-23-fee-sink-fixed-destination.md),
approved by the owner on 2026-09-23.** The owner rejected a sink whose owner can change its
destinations after a maker signs, and an allowlist that can switch a registered sink off. The
replacement is one fixed destination per sink and a registration that nobody can remove.

This design was built on `feat/fee-sink-registry` (`ad661e0`) and never reached `master`. The
body below is kept as history. It said "**Status: Built.**"

## Why this exists

`2026-08-26-neutral-protocol.md` deleted settlement-owned fee sinks, floors, and
`protocolShare`. That decision still holds for **settlement math**: one pull, one booked
credit to `Intent.feeTo`, prove.cash earns nothing from a fill.

What changed is the **destination surface**. Makers still name `feeTo` and `feeRate`. When
`feeRate > 0`, `feeTo` must be an **allowlisted FeeSink** (an external contract), not a raw
EOA. Each sink holds admin-configured WAD weights to N fixed destinations. Settlement stays
book-then-claim; sinks hold balance and `distribute(token)` later. Solver gas remains residual
(`proceeds − gross − gas`) and is never baked into a FeeSink.

This is **not** the old FeeSink + `protocolShare` two-way split. Settlement does not divide a
fee between protocol and maker destination. It books the whole fee to the signed `feeTo`.

## Intent surface

| Field | Meaning |
|---|---|
| `feeTo` | FeeSink address, or `address(0)` when there is no fee |
| `feeRate` | Fraction of one WAD carved out of gross |

Rules:

- `feeRate == 0` → no fee. `feeTo` is ignored (prefer zero).
- `feeRate > 0` → `feeTo` **must** be on the settlement allowlist (`allowedFeeSink[feeTo]`).
  Raw EOAs are not valid fee destinations.
- `feeTo == address(0)` with `feeRate > 0` is refused (zero is never allowlisted).
- Existing `_rateOf`: still `feeTo == 0 ? 0 : feeRate` for quote arithmetic. Allowlist checks
  use the signed `feeRate > 0`, not the folded rate, so a zero destination cannot sneak past.

## Registry (settlement-owned allowlist)

Prefer a **settlement-owned mapping**, not a separate registry contract:

```solidity
mapping(address => bool) public allowedFeeSink;

function setFeeSinkAllowed(address sink, bool allowed) external onlyOwner;
```

Event: `FeeSinkAllowed(address indexed sink, bool allowed)`.

`_termsOk` adds: if `i.feeRate > 0` and `!allowedFeeSink[i.feeTo]`, return false →
`Reason.BadTerms_`.

Owner surface grows by one switch. It still cannot redirect a live intent's fee, change a
rate, or touch reserved / pending books. It only decides which contracts may appear as
`feeTo` when a maker chooses to charge.

## FeeSink interface

External contract (`contracts/src/FeeSink.sol`):

- Ownable admin (`owner` / `transferOwnership` / `onlyOwner`), same local pattern as settlement.
- `setSplits(address[] destinations, uint256[] weightsWad)` — equal length, non-zero dests,
  weights sum exactly to `1e18` (WAD). Emits `SplitsSet`.
- View: `destinations()`, `weights()`, `splitLength()`.
- `distribute(address token)` — reads this contract's ERC-20 balance; splits by WAD weights;
  **per-destination `trySafeTransfer`**. A destination that reverts or returns false only
  strands **its share** inside the sink; other destinations still get paid. Emits
  `Distributed` / `DistributeFailed` per leg.
- Anybody may call `distribute` (same posture as settlement `claim`).

### Why book-then-claim, then distribute

Settlement already books fees so an unvetted `feeTo` cannot revert a fill. Keeping that model:

1. Fill → `_payFee` pulls to settlement, books `_pendingFees[feeTo][token]`.
2. `claim(feeTo, token)` → safeTransfer to the FeeSink.
3. `FeeSink.distribute(token)` → WAD split with per-destination try.

Fill cannot be reverted by a destination. A bad destination can at worst strand its share
inside the sink until admin reconfigures or someone retries after the dest is fixed.

### ForwardFeeSink (passthrough)

`contracts/src/ForwardFeeSink.sol`: immutable single recipient; `distribute(token)` sends
100% of balance. Used to wrap legacy destinations that were previously named as raw EOAs
(e.g. PulseX buy-and-burn). Deploy one, allowlist it, point app defaults at it.

Raw EOAs are **no longer** valid `feeTo` when `feeRate > 0`. Migrate by deploying a
`ForwardFeeSink(buyAndBurn)`, allowlisting it, and updating registry / sign-form defaults.

## Zero fee

Unchanged economically: no destination → no charge. With the allowlist rule, the honest
encoding of "no fee" is `feeRate = 0` (and preferably `feeTo = 0`).

## Solver gas

Unchanged. Residual only. FeeSink weights never include gas or solver take.

## UI

Landing console "Where the money goes":

- When `feeRate > 0`, the fee ribbon subdivides by the selected sink's destination WAD
  splits (console snapshot fixture / config; optionally live reads later).
- Do not tell the fee story as improvised fee/solver/gas alone — show sink destinations.
- Sign form: default `feeTo` chip from allowlisted sinks / registry config. Do not offer an
  arbitrary EOA as the primary destination when sinks are required. Custom paste may still
  exist for power users typing an allowlisted sink address, not for raw EOAs as the happy path.

## Scripts / TUI

`app/scripts/fee-sink-admin.ts` — interactive CLI:

- list allowed sinks
- allow / deny
- deploy FeeSink / ForwardFeeSink
- set WAD splits
- distribute
- show pending fees on settlement for a sink

Update `fee-route-check.ts` comments/behavior for allowlisted sinks.
Wire deploy helpers in `deployment.ts` / `contracts/script/` as needed.

## Tests required

- `contracts/test/FeeSink.t.sol` — setSplits sum/guards, distribute happy path, one reverting
  destination strands only its share, ForwardFeeSink 100% forward.
- Extend `contracts/test/FeeTo.t.sol` — allowlist refusal when `feeRate > 0` and sink not
  allowed; zero-fee still free; allowlisted sink still books then claims.
- Update EconAudit / neutral claims only as needed (owner now has `setFeeSinkAllowed`).

## Upgrade / compat

Mainnet intents that named the PulseX buy-and-burn EOA directly need a passthrough sink +
allowlist entry, or remaking. Prefer `ForwardFeeSink` wrapping that address. Document in
`docs/FEE-MODEL.md` and the reversal note on `2026-08-26-neutral-protocol.md`.

## Out of scope

- Reintroducing `protocolShare`, `feeFloorRate`, or settlement-internal fee division.
- Baking gas into FeeSink.
- Changing park / escrow / relayer design.

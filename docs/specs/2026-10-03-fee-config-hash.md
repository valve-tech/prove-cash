# Fee config hash: fees keyed by a signed hash, three take points, no registry

**Status: Built** on `feat/fee-config-hash` (local commits only, not pushed, not merged, not
deployed). Supersedes `2026-09-23-fee-sink-fixed-destination.md`.

> **Provenance, read this first.** The owner's original text of this spec was not in either
> checkout when the work resumed, and the code already cites it by section number (2.3, 2.4,
> 2.10.3). This file was written **from the code as built**, so the section numbers match what the
> code cites and the content is what the code does. It quotes no decision of the owner's that this
> repository did not already record. Where it and the owner's text differ, the owner's text wins;
> the differences are listed under "Deviations" and in the internal backlog.

## 2.1 The rule

An intent signs `feeConfig`, a `bytes32`: the EIP-712 `hashStruct` of
`FeeConfig{address[] destinations, uint256[] weights}`, or zero for no fee at all. There is no
registry and nobody to ask. The settlement never looks inside the hash during a fill and never
calls a destination. Fees are reserved under `_pendingFees[feeConfig][token]`; `claim(cfg, token)`
takes the preimage, checks it hashes to the key and pays the destinations by weight. A config is
valid with 1 to 8 destinations, ascending and non-zero, weights non-zero and summing to exactly
`1e18` (`FeeConfig.fault`).

## 2.2 Three take points

| Point | Field | Token | Taken | Borne by |
|---|---|---|---|---|
| P1 handover | `feeRateIn` | tokenIn | `floor(take × r / WAD)` | the solver |
| P2 output | `feeRate` | tokenOut | `floor(owedToMaker × r / WAD)`, on top | the solver |
| P3 proceeds | `feeRateProceeds` | tokenOut | `floor(owedToMaker × r / WAD)`, out of it | the maker |

`feeConfig = 0` with any rate is `BadTerms_`. A filler's `maxFeeRate` bounds `feeRateIn +
feeRate`. The intent has 19 signed fields (`INTENT_TYPEHASH` prefix `0xc1e92b74`); the wire codec
is v5.

## 2.3 Size, and the library

At the fee-config feature's first build the settlement was over EIP-170. Options weighed:
(A) drop features, (B) split reads into a reader, (C) move `claim` and `announceFeeConfig` into a
linked external library. **C was chosen, with B for `available`.** `FeeClaimLib` is called by
`DELEGATECALL`; it has no owner, storage, `SELFDESTRUCT` or `DELEGATECALL`
(`FeeClaim.t.sol` checks the deployed bytecode). `optimizer_runs` is 200. Result: settlement
runtime **23,427 B, 1,149 B under the limit**; `ProveReader` 21,627 B. The library is a new trust
surface and changes the runtime bytecode and the bytecode pins.

## 2.4 FeeDefaults

Advisory only. The settlement does not read it and does not know its address. It holds the
project's suggested config, a rate per take point and a warning threshold per take point. The
owner (two-step) has one power, `setDefaults`, which appends a history entry carrying the full
preimage; nothing is overwritten. Initial defaults: P2 0.5% to the buy-and-burn destination, P1
and P3 zero, warn 1% at every point. `config/fee-configs.json` mirrors the history for CI.

## 2.5 ProveReader

`ProveReader` carries the reads: `available`, `fillability`, `dryRun`, `quote`, and the defaults
lookups. It has no owner, no setter and no funds. `available` and `ratesOf` left the settlement.
`IntentTerms.ok` copies `_termsOk` for the reader; a fuzz test pins the two together.

## 2.10.3 Pricing

```
owedToMaker = ceilDiv(take × minOutAt, amountIn)
feeIn       = floor(take × feeRateIn / WAD)               tokenIn,  solver
feeOut      = floor(owedToMaker × feeRate / WAD)          tokenOut, solver, on top
feeProceeds = floor(owedToMaker × feeRateProceeds / WAD)  tokenOut, maker, out of owedToMaker
delivered   = owedToMaker − feeProceeds        owed = owedToMaker + feeOut        usable = take − feeIn
```

## Deviations from the earlier design, and open items

- `MakerView` exposes `feeOut` and `feeProceeds` separately (tokenOut). P1 is `gasCoverIn` in tokenIn. (Was a summed `totalFeesReserved`; owner changed it 2026-10-06.)
- A wallet cannot sign `feeConfig = 0` through typed data; only a raw-digest local key can.
- `FeesTaken` stays on the settlement (213 B) because indexers and keepers read it.
- The settlement has no owner at all. `setDefaultProceeds`, `registerFeeSink` and friends are gone.
- Old 943 and 369 deployments are ABI-incompatible. A redeploy is required; none was done.

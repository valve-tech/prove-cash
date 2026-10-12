# Slither triage

Every Slither finding against `contracts/src`, with a verdict and a reason.

Run of 2026-10-05, at commit `397c3ba`, against the `contracts/src` tree
`09c2233a7f1ab75ed02e6d37772559f7beaef050` — the fee config tree (`FeeClaimLib`, `FeeConfig`,
`FeeConfigView`, `FeeDefaults`, `IntentTerms`, `ProveReader`, `TakePoints`, no `FeeSink`, no
settlement owner). Slither 0.9.6, solc 0.8.30, 88 detectors, **125 findings**.
No finding is CONFIRMED.

| Verdict | Count |
| --- | --- |
| CONFIRMED | 0 |
| MITIGATED | 51 |
| FALSE POSITIVE | 74 |

Slither exits 255 whenever it finds anything. That is not a failure. Judge the
run by the report it writes, not by the exit code.

**A person still writes every verdict here, and a gate now proves one exists.**
`soak.yml` runs Slither nightly and then `contracts/tools/check-slither.py`, which
fails the build when a detector's count in this document does not match the run.
It counts by detector and never by line: line numbers here move whenever the
contract does, and a gate that cries on every commit teaches people to ignore it.

The gate checks that a verdict exists. It cannot check that a verdict is right —
that is the reader's job, and it is why each one carries a reason rather than a
tick. Run it yourself with `python3 tools/check-slither.py --run` from
`contracts/`.

### What moved since the run of 2026-09-15 (86 findings, sink-era tree)

The fee config change rewrote the fee path, so this run was triaged from scratch
rather than diffed. Net +39, almost all of it in new files and almost all of it
informational. By detector:

| Delta | Detector | Why it moved |
| --- | --- | --- |
| +7 | solc-version | Eight new files carry the same `^0.8.24` pragma (`FeeClaimLib`, `FeeConfig`, `FeeConfigView`, `FeeDefaults`, `IntentTerms`, `ProveReader`, `TakePoints` and `interfaces/IProveSettlementRead.sol`), less `FeeSink.sol`. |
| +9 | timestamp | Slither's taint follows `block.timestamp` into every function that a timestamp-reading caller reaches. Ten of the sixteen compare no clock at all (`ProveReader` views, `_book1`, `_deliverTo`, `_release`, `_sayFilled`, `sweepUnowned`). `available` moved from the settlement into `ProveReader`. |
| +8 | incorrect-equality | Enum comparisons in `ProveReader` (seven) and `_book1`'s `fee == 0`. `_ceilDiv` is gone (now `TakePoints.owedFor`). |
| +5 | naming-convention | `FeeConfigView.TYPEHASH()`/`MAX_DESTINATIONS()`, `STRAY_CONFIG` (settlement and its read interface) and `ProveReader._STRAY`: constants exposed under their constant names on purpose. |
| +4 | assembly | `FeeClaimLib._tryTransfer` and three bounded reads in `ProveReader`. |
| +2 | uninitialized-local | Four new zero-start locals (`FeeClaimLib.pay.deferred`, `ProveReader._config.cfg`, `_explain.flags`, `explain.none`), less the two `FeeRun` structs the fee book removed. |
| +1 | missing-zero-check | `FeeDefaults.transferOwnership` (zero cancels) and the settlement's `_relayer` local (a `new`, never zero) arrived; the settlement's own `transferOwnership` went with the owner. |
| +1 | reentrancy-no-eth | `_settleLeg`, `_settleViaCallback` and `fillBatchWithCallback` are new subjects; `fillBatch` and one `_collect` row went. Same guard, same answer. |
| +1 | unused-return | `ProveReader._identity` reads only `live` from `this.available`. |
| +1 | cyclomatic-complexity | `ProveReader._config`, a resolution ladder. |
| +1 | missing-inheritance | `FeeDefaults` matches `IFeeDefaultsRead` by ABI, not by Solidity type. |
| −1 | calls-loop | `_payFee` is gone; the fee book pulls in `_settleLedger`, which Slither does not reach from a loop. |
| 0 | the rest | `arbitrary-send-erc20`, `reentrancy-benign` (`_release` replaces `_payFee`), `reentrancy-events`, `low-level-calls`, `unused-state`. |

**The new contracts were read for the findings Slither does not make.** `FeeClaimLib` is
reached only through the settlement's `DELEGATECALL` (`claim`, `announceFeeConfig`); called
directly it touches its own empty storage, and its two `external` functions write nothing a
direct caller could use. It has no `SELFDESTRUCT` and no `DELEGATECALL` of its own
(`test/FeeClaim.t.sol` scans the deployed bytecode). `FeeDefaults` is advisory: the settlement
never reads it. `ProveReader.remember` is permissionless and keyed by the hash of what it
stores, so it cannot be wrong for its key. `IntentTerms` is a copy of `_termsOk`, pinned to the
original by a fuzz test in `test/ProveReader.t.sol`.

### Every citation in this file moved, and that is worth saying once

Every line number below was re-read out of `slither-report.json` and out of
`contracts/src` at the tree named above. This file is **not** under
`contracts/tools/check-citations.py`, so nothing catches the next drift for you —
re-run Slither and re-read the numbers rather than trusting them.

## How to reproduce the run

Three things take the run down or change what it sees. All three are handled
below. Do not conclude Slither is broken.

**Trap 1 — the wrong Python.** Slither lives under `python3.11` on this machine,
and `pip3` is `python3.12`. A bare `slither` dies with
`DistributionNotFound: The 'protobuf>=4.21.6' distribution was not found`, which
names no interpreter. Call the right one explicitly. If the dependency is
missing, install it under that interpreter:

```
/usr/local/bin/python3.11 -m pip install 'protobuf>=4.21.6'
```

**Trap 2 — analyse the src-only build.** We build without the tests and analyse
that build. The run above is that build. One test file forced the practice:
`contracts/test/FeeSinkMatrix.t.sol` raised a bare `AssertionError` in
`slithir/convert.py`, and `--filter-paths` did not help, because it filters
findings and not parsing. That file went with `FeeSink`, so on 2026-09-04 we
tried a build with the tests in. **It still does not work, for a new reason.**
crytic-compile now dies with
`InvalidCompilation: Unknown file: foundry-pp/DeployHelper53.sol` — a
preprocessed forge-std path it cannot resolve. Build without the tests.

**Trap 3 — `--ignore-compile` ignores `FOUNDRY_OUT`.** crytic-compile reads the
`out` directory from `foundry.toml`, not from the environment. It then hits any
stale build-info file in the default `out/build-info` and dies with
`KeyError: 'output'`. Pass `--foundry-out-directory <dir>` to Slither and build
into that same directory. The side directory also keeps the run clear of `out/`,
which matters when another job is building.

The full command, from `contracts/`:

```
rm -rf out-slither cache-slither
FOUNDRY_OUT=out-slither FOUNDRY_CACHE_PATH=cache-slither forge build --build-info \
  --skip "test/**" --skip "script/**" --skip "*.t.sol" --skip "*.s.sol"
rm -f slither-report.json
/usr/local/bin/python3.11 -m slither . \
  --ignore-compile --exclude-dependencies --filter-paths "lib/" \
  --foundry-out-directory out-slither --json slither-report.json
```

Two more notes on the flags:

- Slither refuses to overwrite an existing `--json` target and says so in one
  line you will scroll past. Delete the file first or you triage a stale report.
- `forge build` inherits `foundry.toml`, so the analysis sees the settings that
  ship. This run's `out-slither/build-info/*.json` reads
  `optimizer` enabled at 1000 runs, `viaIR: true`, `evmVersion: paris` and solc
  0.8.30 under `input.settings`. Check that before you trust a run.

The compilation unit is `src/` plus the OpenZeppelin files it imports. Skipping
`script/**` matters: with the scripts in, forge-std drags the total far higher,
and most of the additions are about `forge-std` unused state variables.

`contracts/slither-report.json` is generated and git-ignored.

## CONFIRMED

None.

## MITIGATED (51)

The pattern is present. Something else stops the harm, and the reason names it.

### arbitrary-send-erc20 — 1

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| arbitrary-send-erc20 | ProveRelayer | pull | ProveRelayer.sol:86 | `ProveRelayer.sol:85` rejects every caller but the settlement, and the one call site that names a third party (`ProveSettlement.sol:3041`, `from = i.maker`) runs only after `_evaluate` verifies the maker's signature. |

The `from` is arbitrary by design. The other call sites — deposit (`ProveSettlement.sol:1161`),
the flush (`_settleLedger`, `:2965`) and the maker payment (`_deliverTo`, `:3013`) — all pass
`msg.sender`, so they spend the caller's own tokens.

### reentrancy-no-eth — 10

The guard is `nonReentrant` (modifier at `ProveSettlement.sol:896`, reading `_entered` at
`:731`), held by every state-changing entry point that moves tokens: `fill` (`:1488`),
`fillBatch` (`:1513`), `fillBatchWithCallback` and `fillWithCallback` (`:1557`, `:1792`, both
also `callableTarget`), the permit/authorization/permit2 fills, `deposit`, `withdraw`,
`withdrawParked`, `sweepUnowned` and `claim`. `armLeg` is `external` only so that
`try this.armLeg(...)` gets its own revertable frame; `:2057` rejects any caller but the
contract itself, and `_entered` is already 2 across the whole self-call.

Every flagged write is one of three books: `filled[h]`, `_reserved`/`_totalReserved` (in
`_release`) or `_pendingFees`/`_totalPendingFees` (in `_book1`, `:2944`). A fee booking is a
credit against tokens the flush (`_settleLedger`) must then pull, strictly: it reverts the whole
call unless every booked amount arrived. Nothing leaves the contract because of a booking.

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| reentrancy-no-eth | ProveSettlement | _fillOne | ProveSettlement.sol:1713 | `fillBatch` holds `nonReentrant`; the flagged call is the `this.armLeg` self-call (`:2356`), and `filled[h]` is written at `:1713` after the arming frame has returned. |
| reentrancy-no-eth | ProveSettlement | _fillOne | ProveSettlement.sol:1714 | Same frame, same guard. The writes are `_release`'s reservation debit and `_book1`, reached through `_settleLeg`. |
| reentrancy-no-eth | ProveSettlement | _settleLeg | ProveSettlement.sol:1725 | `_release`'s relayer pull (`:3041`) precedes `_reserveOut`'s booking. Every caller holds `nonReentrant`; the booking is backed by the flush or the call reverts. |
| reentrancy-no-eth | ProveSettlement | _creditLeg | ProveSettlement.sol:1633 | `fillBatchWithCallback` holds `nonReentrant` and `callableTarget`; `filled[h]` is written before the callback runs. |
| reentrancy-no-eth | ProveSettlement | _creditLeg | ProveSettlement.sol:1634 | Same frame, second flagged write — `_release` and `_book1` through `_recordLeg`. |
| reentrancy-no-eth | ProveSettlement | _collect | ProveSettlement.sol:1668 | `_deliverTo` (`:3013`) calls the relayer for the previous line, then `_reserve` books the next line's fee. Inside `fillBatchWithCallback` only, under `nonReentrant`; a credit, not a transfer. |
| reentrancy-no-eth | ProveSettlement | fillBatchWithCallback | ProveSettlement.sol:1591 | The callback to `msg.sender` follows the legs' writes and precedes `_collect`. That is the design (the caller is paid first and settles after), and the strict flush at the end is the check. |
| reentrancy-no-eth | ProveSettlement | _settleViaCallback | ProveSettlement.sol:1810 | The same shape for one leg: `_release`, then the callback, then the booking and delivery (`:1811-1812`), then `_settleLedger` (`:1814`). `fillWithCallback` holds `nonReentrant` and `callableTarget`. |
| reentrancy-no-eth | ProveSettlement | _walkLeg | ProveSettlement.sol:2503 | Reached only from `dryRun` (`:2446`), which ends in `revert DryRun(reasons)`. Nothing it writes survives the call. |
| reentrancy-no-eth | ProveSettlement | _walkLeg | ProveSettlement.sol:2506 | Same frame, second flagged write. |

A maker who controls their own token can re-enter during `armLeg`. The unguarded
state-changing functions they reach are `cancel` (`:1435`), `invalidateBefore` (`:1468`),
`park` (`:1283`) and `announceFeeConfig` (`:1419`, a log). None touches anybody else's intent,
nonce floor, reservation or fee book. Cancelling their own leg mid-arm makes the arming frame
revert, which costs the maker their fill and costs the batch one skipped leg.

### reentrancy-benign — 5

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| reentrancy-benign | ProveSettlement | _redeem | ProveSettlement.sol:1936 | Reached only through `armLeg`, inside a fill that holds `nonReentrant`; the reservation is the measured delta (`:1935`), not the authorization's face value. |
| reentrancy-benign | ProveSettlement | deposit | ProveSettlement.sol:1163 | `nonReentrant`; the reservation is credited from a measured balance delta (`:1158`, `:1162`), not from the argument. |
| reentrancy-benign | ProveSettlement | _pullPermit2 | ProveSettlement.sol:2336 | Same guard, reached through `armLeg`; the callee is the relayer, which calls Permit2, fixed at construction (`ProveRelayer.sol:74`). |
| reentrancy-benign | ProveSettlement | _release | ProveSettlement.sol:3042 | Approval rung: the relayer pull from the maker (`:3041`) precedes the P1 booking. Every caller holds `nonReentrant`, and the booking is `unbacked`, so the flush must pull it from the solver or the call reverts. |
| reentrancy-benign | ProveBatchExecutor | settleRing | ProveBatchExecutor.sol:513 | `_disposalSkips` reads `_skipDisposal` after `fillBatchWithCallback` (`:494`) returns and clears it at `:559`. `settleRing` holds `nonReentrant` (`:435`); `_skipDisposal` is written by `proveBatchCallback` (`:714`) inside the same transaction, so no ring can read another ring's answer. |

### reentrancy-events — 2

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| reentrancy-events | ProveSettlement | _redeem | ProveSettlement.sol:1938 | `nonReentrant` held by the calling fill; no observer can interleave. |
| reentrancy-events | ProveSettlement | _pullPermit2 | ProveSettlement.sol:2338 | Same guard. `Deposited` carries the measured delta, not the requested amount. |

### calls-loop — 14

Every one of these loops runs over an array the caller supplied. No third party
can lengthen one, and the caller pays the gas for the length they chose. The
batch paths additionally survive a single hostile leg: `_arm` wraps the arming
call in `try`/`catch` (`ProveSettlement.sol:2356-2378`), and `skipInvalid`
steps the leg over.

Slither labels several of these "has external calls inside a loop" for functions
that contain no loop at all — `_deliverTo`, `_release`, `_validSignature`,
`_sweep` and `_sweepAbove` are each called *from* a loop. The substance is the
same, so they are triaged the same way.

**The count fell from 15 to 14 because `_payFee` is gone, not because a call went.** The fee
book pulls once per token in `_settleLedger` (`ProveSettlement.sol:2965`), from a loop over
the call's own ledger, which holds at most two tokens per leg. Slither does not report it.
Count it from the source, as you must count the `_probe` reads (`:2798`, assembly, invisible
to the call graph) and `ProveBatchExecutor._oweEveryLine`'s `balanceOf`
(`ProveBatchExecutor.sol:939`), which the walk never reaches because `proveBatchCallback`
calls `_oweEveryLine` once, outside every loop (`:727`).

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| calls-loop | ProveBatchExecutor | settleRing | ProveBatchExecutor.sol:477 | The pre-ring marks, one `balanceOf` per token the caller's own route named. |
| calls-loop | ProveBatchExecutor | settleRing | ProveBatchExecutor.sol:527 | The disposal branch; `sellSurplus` is self-gated at `:802`, and the list is capped at `MAX_DISPOSALS` (`:248`, 256) by `:709`. |
| calls-loop | ProveBatchExecutor | _sell | ProveBatchExecutor.sol:882 | The sink's balance before the venue call. |
| calls-loop | ProveBatchExecutor | _sell | ProveBatchExecutor.sol:884 | The same balance after, to size what was sent. |
| calls-loop | ProveBatchExecutor | _sell | ProveBatchExecutor.sol:886 | `ProveCallSink.run`, one per entry of the caller's own swap list. |
| calls-loop | ProveBatchExecutor | _increaseAbove | ProveBatchExecutor.sol:854 | Loop over `named`, built from the caller's own route. |
| calls-loop | ProveBatchExecutor | _sweepAbove | ProveBatchExecutor.sol:962 | One `balanceOf` per token the caller named. |
| calls-loop | ProveExecutor | fill | ProveExecutor.sol:214 | Loop over `swap.extra`, the caller's own list; `fill` carries `nonReentrant` (`:179`). |
| calls-loop | ProveExecutor | _sweepAbove | ProveExecutor.sol:344 | One `balanceOf` per token the caller named. |
| calls-loop | ProveCallSink | _sweep | ProveCallSink.sol:147 | Called per entry of `extra`, which the executor supplies; `run` is executor-gated at `:119`. |
| calls-loop | ProveSettlement | _arm | ProveSettlement.sol:2356 | The `try`/`catch` frame is the mitigation: one hostile leg costs one sub-call (capped at `ARM_GAS`), not the batch. |
| calls-loop | ProveSettlement | _deliverTo | ProveSettlement.sol:3013 | The relayer pull. The two `_probe` reads that bracket it (`:3010`, `:3016`) are capped at `PROBE_GAS` and invisible to Slither. |
| calls-loop | ProveSettlement | _release | ProveSettlement.sol:3041 | One relayer pull per leg the caller requested. |
| calls-loop | ProveSettlement | _validSignature | ProveSettlement.sol:3071 | The ERC-1271 staticcall is capped at 60,000 gas, so a hostile maker cannot drain a batch's budget. |

### timestamp — 6

Every comparison here is a deadline, a window, a ramp or a liveness test, and all
of them are sized far above the drift a validator can introduce. No contract cap
backs any of these: a maker decides how long their own signature stands, and the
reasons rest on the signed window itself.

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| timestamp | ProveSettlement | _evaluate | ProveSettlement.sol:2683-2684 | Intent start and end, plus the cancellation stamp at `:2699`. The maker signs the window, and `_evaluate` returns a `Reason` rather than reverting. Seconds of drift move a fill by seconds. |
| timestamp | ProveSettlement | minOutAt | ProveSettlement.sol:978-979 | A Dutch-auction ramp, read at a `ts` the caller passes (`block.timestamp` on every fill). Seconds of drift move the price by seconds of ramp, which is what a ramp is. |
| timestamp | ProveSettlement | park | ProveSettlement.sol:1288 | `park` refuses a live intent, and `block.timestamp < i.endTime` is one of the three ways it tests that. Drift can only park an intent a few seconds early, which moves one maker's reservation into that maker's own row and ends their own offer. It pays nobody. |
| timestamp | ProveReader | available | ProveReader.sol:244-247 | A view, moved here from the settlement. Its answer is advisory and every fill re-checks. |
| timestamp | ProveReader | _explain | ProveReader.sol:361-365 | Advisory flags (`NOT_STARTED`, `EXPIRED`) on a `ts` the caller chose. The authority is `identity.reason`, from the settlement. |
| timestamp | RfqVenue | _checkBinding | RfqVenue.sol:357 | An exclusivity expiry the counterparty signed. This is the venue's own bound. |

### missing-zero-check — 1

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| missing-zero-check | ProveRelayer | constructor (`_permit2`) | ProveRelayer.sol:74 | `ProveSettlement.sol:880` rejects a zero `_permit2`, and the settlement's constructor is the only place a relayer is ever built (`:883`). |

### low-level-calls — 3

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| low-level-calls | ProveSettlement | _validSignature | ProveSettlement.sol:3071 | ERC-1271 probe, capped at 60,000 gas, return length checked at `:3074`, decoded as `bytes32` on purpose. |
| low-level-calls | RfqVenue | _validSignature | RfqVenue.sol:522 | The same probe, the same cap and checks. |
| low-level-calls | ProveCallSink | run | ProveCallSink.sol:134 | The arbitrary venue call is the sink's purpose. It is executor-gated at `:119`, refuses to target the executor, itself or the template at `:127-128`, and the sink holds nothing between calls (`_sweep`, `:146`). |

### assembly — 6

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| assembly | ProveSettlement | _probe | ProveSettlement.sol:2799 | `memory-safe`, writes only scratch space at `0x00`, and copies a word only after checking `returndatasize() > 31`. |
| assembly | ProveBatchExecutor | _write | ProveBatchExecutor.sol:843 | Bounds-checked with checked arithmetic, so `offset + 32` reverts on overflow rather than wrapping past the length test. |
| assembly | FeeClaimLib | _tryTransfer | FeeClaimLib.sol:108 | **New.** A `transfer` capped at `TRANSFER_GAS`, return data read into scratch only (at most one word, so return-bomb safe). Success is "call succeeded and returned nothing or exactly `true` in a full word"; a failed call leaves `ok` zero whatever the scratch word holds. Runs in the settlement's context through `claim`, under `nonReentrant`, after the cell is zeroed. |
| assembly | ProveReader | _read | ProveReader.sol:618 | **New.** One staticcall to the settlement, one word into scratch, multiplied away unless `returndatasize() > 31`. A settlement with no code is refused before the call (`:617`). View only. |
| assembly | ProveReader | _decimals | ProveReader.sol:644 | **New.** `decimals()` capped at `META_GAS` (30,000), scratch only, the word kept only from a full answer, and anything above 255 read as 0. Display only. |
| assembly | ProveReader | _symbol | ProveReader.sol:660, :671, :686 | **New.** `symbol()` capped at `META_GAS`; at most 96 bytes copied into a 96-byte buffer, whatever the token returns; the string length is clamped to what was copied (`n > size - 64`). Display only. |

### unused-state — 3

Three curve kinds are declared and never read. That is accurate, and it is
deliberate. Each is a `private constant`, so it occupies no storage slot, and solc
emits no bytecode for a constant nothing reads.

| Detector | Contract | Variable | Line | Reason |
| --- | --- | --- | --- | --- |
| unused-state | ProveSettlement | KIND_LINEAR | ProveSettlement.sol:457 | Kind 0, the straight line. `minOutAt` (`:977`) falls through to it rather than naming it, and the comment at `:985` says so. It is written down so that the next kind cannot collide with it. |
| unused-state | ProveSettlement | KIND_KNOTS | ProveSettlement.sol:480 | Reserved and not implemented. An intent naming it prices as the line. Implementing it needs a redeploy, which moves the domain separator. |
| unused-state | ProveSettlement | KIND_CUBIC | ProveSettlement.sol:486 | Reserved on the same terms. |

## FALSE POSITIVE (74)

The detector is wrong about this code.

### missing-zero-check — 2

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| missing-zero-check | FeeDefaults | transferOwnership (`next`) | FeeDefaults.sol:153 | Zero is the cancel, on purpose. It writes only `pendingOwner`, and `acceptOwnership` needs `msg.sender == pendingOwner`, so no call can make zero the owner. `FeeDefaults` reaches no funds either way: it is advisory and the settlement never reads it. |
| missing-zero-check | ProveSettlement | constructor (`_relayer`) | ProveSettlement.sol:884 | `_relayer` is the address of `new ProveRelayer(_permit2)` one line up. A `CREATE` that fails reverts the constructor; it never returns zero into Solidity. |

### incorrect-equality — 9

Slither's "dangerous strict equality" is about comparing a balance to an expected amount,
where an attacker who donates one wei breaks the equality. None of these compares a balance.

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| incorrect-equality | ProveSettlement | _book1 | ProveSettlement.sol:2943 | `fee == 0` on a computed fee, to skip two zero writes. No balance. |
| incorrect-equality | ProveReader | _config | ProveReader.sol:474 | `v.source == ConfigSource.Unresolved`: an enum the function itself sets. |
| incorrect-equality | ProveReader | _config | ProveReader.sol:497 | The same enum, and `i.feeConfig == _STRAY`, a hash comparison. |
| incorrect-equality | ProveReader | _config | ProveReader.sol:502 | The same enum, and a stored array's length. |
| incorrect-equality | ProveReader | _config | ProveReader.sol:509 | The same enum. |
| incorrect-equality | ProveReader | _config | ProveReader.sol:517 | The same enum. |
| incorrect-equality | ProveReader | _defaults | ProveReader.sol:562 | `uint8(v.source) == uint8(ConfigSource.DefaultCurrent)`: the same enum. |
| incorrect-equality | ProveReader | _defaults | ProveReader.sol:563 | As above, `DefaultPast`. |
| incorrect-equality | ProveReader | _book | ProveReader.sol:598 | `v.fault == FeeConfig.Fault.None`: an enum returned by a pure function. |

### uninitialized-local — 10

Solidity zero-initializes every memory local. Each of these reads that zero on purpose.

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| uninitialized-local | FeeClaimLib | pay (`deferred`) | FeeClaimLib.sol:78 | An accumulator of deferred shares; must start at zero. |
| uninitialized-local | ProveReader | explain (`none`) | ProveReader.sol:222 | An empty `FeeConfig.Config`, meaning "no preimage supplied; resolve it yourself". |
| uninitialized-local | ProveReader | _explain (`flags`) | ProveReader.sol:330 | A bit accumulator. |
| uninitialized-local | ProveReader | _config (`cfg`) | ProveReader.sol:464 | Empty until a source resolves it; every read is behind `v.source != Unresolved`. |
| uninitialized-local | ProveBatchExecutor | _disposalSkips (`conditioned`) | ProveBatchExecutor.sol:551 | The scan flag that decides whether a route reads `_skipDisposal` at all; false is the correct start. |
| uninitialized-local | ProveBatchExecutor | proveBatchCallback (`skip`) | ProveBatchExecutor.sol:710 | The disposal-skip bitmap. Zero means "skip nothing". |
| uninitialized-local | ProveBatchExecutor | _requireSwept (`found`) | ProveBatchExecutor.sol:744 | A scan flag carrying the loop exit. |
| uninitialized-local | ProveBatchExecutor | _wanted (`settled`) | ProveBatchExecutor.sol:782 | `bool settled` carries the loop exit; false is the correct start. |
| uninitialized-local | ProveBatchExecutor | _increaseAbove (`found`) | ProveBatchExecutor.sol:860 | The same pattern. |
| uninitialized-local | ProveBatchExecutor | _oweEveryLine (`total`) | ProveBatchExecutor.sol:918 | A per-token sum that must start at zero. |

### unused-return — 5

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| unused-return | ProveSettlement | _validSignature | ProveSettlement.sol:3065 | Both values that matter are checked: `err == NoError && signer == maker` on the next line. Only `ECDSA`'s diagnostic `errArg` is dropped. |
| unused-return | RfqVenue | _validSignature | RfqVenue.sol:517 | The same call, the same check. |
| unused-return | ProveBatchExecutor | _sinkFor | ProveBatchExecutor.sol:586 | `Clones.cloneDeterministic` returns the clone address, which the public `sinkFor` already predicted. The clone call reverts if it cannot deploy there. |
| unused-return | ProveExecutor | _sinkFor | ProveExecutor.sol:337 | The same clone call, the same predicted address. |
| unused-return | ProveReader | _identity | ProveReader.sol:409 | `try this.available(i) returns (uint256, bool live)`: `_identity` wants liveness only; `remaining` is computed from `filled` a few lines up, with an underflow guard `available` lacks. |

### timestamp — 10

Slither marks a function as timestamp-dependent when any caller that reads the clock reaches
it, and then flags every comparison inside it. None of these compares a clock.

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| timestamp | ProveSettlement | _stretchAt | ProveSettlement.sol:1037, :1040 | `private pure`. `pos <= begin` and `num >= den` compare a fraction of the window; the clock is `minOutAt`'s, one frame up, and it is triaged there. |
| timestamp | ProveSettlement | _book1 | ProveSettlement.sol:2943 | `fee == 0`. |
| timestamp | ProveSettlement | _deliverTo | ProveSettlement.sol:3017 | `held - before < amount`: the fee-on-transfer guard. |
| timestamp | ProveSettlement | _release | ProveSettlement.sol:3050 | `take != feeIn`. |
| timestamp | ProveSettlement | _sayFilled | ProveSettlement.sol:1743 | `q.feeIn | q.feeOut | q.feeProceeds != 0`, to skip an empty event. |
| timestamp | ProveSettlement | sweepUnowned | ProveSettlement.sol:1363 | `held <= booked`: a balance against the books. |
| timestamp | ProveReader | _config | ProveReader.sol:474-517 | Enum and hash comparisons (see `incorrect-equality`). |
| timestamp | ProveReader | _defaults | ProveReader.sol:562-580 | Enum comparisons and signed rates against warn rates. |
| timestamp | ProveReader | _book | ProveReader.sol:598, :601 | An enum and a loop bound. |
| timestamp | ProveReader | _maker | ProveReader.sol:425 | `q.take != 0`, a division guard. |

### solc-version — 24

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| solc-version | (23 files) | pragma `^0.8.24` | `src/**:2` | The caret range never reaches a build. `contracts/foundry.toml` pins `solc = "0.8.30"`, and `evm_version = "paris"` fixes the target, so one reviewed compiler produces every artifact. |
| solc-version | — | "solc-0.8.30 is not recommended for deployment" | — | Slither 0.9.6's version table ends before 0.8.30, so it flags every compiler newer than its own release regardless of that compiler's record. |

The twenty-three files: the thirteen under `src/` (`FeeClaimLib`, `FeeConfig`,
`FeeConfigView`, `FeeDefaults`, `IntentTerms`, `ProveBatchExecutor`, `ProveCallSink`,
`ProveExecutor`, `ProveReader`, `ProveRelayer`, `ProveSettlement`, `RfqVenue`, `TakePoints`)
and the ten under `src/interfaces/`.

### naming-convention — 10

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| naming-convention | ProveSettlement | _CACHED_CHAIN_ID | ProveSettlement.sol:747 | OpenZeppelin's own EIP-712 naming for a cached immutable. |
| naming-convention | ProveSettlement | _CACHED_DOMAIN_SEPARATOR | ProveSettlement.sol:748 | As above. |
| naming-convention | RfqVenue | _CACHED_CHAIN_ID | RfqVenue.sol:179 | As above. |
| naming-convention | RfqVenue | _CACHED_DOMAIN_SEPARATOR | RfqVenue.sol:180 | As above. |
| naming-convention | ISignatureTransfer | DOMAIN_SEPARATOR() | interfaces/IPermit2.sol:71 | The name is fixed by the deployed Permit2 ABI. |
| naming-convention | ProveSettlement | STRAY_CONFIG | ProveSettlement.sol:546 | An immutable, named as a constant; the getter is the ABI the SDK, the reader and the deploy scripts read. |
| naming-convention | IProveSettlementRead | STRAY_CONFIG() | interfaces/IProveSettlementRead.sol:22 | The getter above, as the reader's interface must name it. |
| naming-convention | ProveReader | _STRAY | ProveReader.sol:195 | A private immutable, named as a constant like the settlement's. |
| naming-convention | FeeConfigView | TYPEHASH() | FeeConfigView.sol:15 | Exposes the library constant `FeeConfig.TYPEHASH` under its own name, as `INTENT_TYPEHASH` is. |
| naming-convention | FeeConfigView | MAX_DESTINATIONS() | FeeConfigView.sol:19 | As above, `FeeConfig.MAX_DESTINATIONS`. |

### cyclomatic-complexity — 3

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| cyclomatic-complexity | ProveSettlement | _revert | ProveSettlement.sol:2836 | A `Reason` enum mapped to one `revert` each. The complexity is the enum's size. |
| cyclomatic-complexity | RfqVenue | _checkBinding | RfqVenue.sol:349 | Nine refusals in a straight line, each with its own error. Flattening them would cost the errors, and each error tells a counterparty which term failed. |
| cyclomatic-complexity | ProveReader | _config | ProveReader.sol:457 | **New.** The resolution ladder — supplied preimage, zero config, `FeeDefaults.resolve`, the stray config, `remember`'s cache — tried in order, each a guarded step. A view. |

### missing-inheritance — 1

| Detector | Contract | Function | Line | Reason |
| --- | --- | --- | --- | --- |
| missing-inheritance | FeeDefaults | — | FeeDefaults.sol:26 | `IFeeDefaultsRead` (`interfaces/IProveSettlementRead.sol:35`) redeclares `Record`, `PointRates` and the preimage struct so that `ProveReader` does not import `FeeDefaults`. The two match by ABI, not by Solidity type, so `FeeDefaults` cannot inherit the interface without a struct name clash. `test/ProveReader.t.sol` reads a real `FeeDefaults` through the interface. |

## Where an auditor will push

1. **`calls-loop`, all 14, share one argument.** No third party can lengthen the
   loop, and the caller pays. No function caps an array length, so an auditor will
   ask what happens when a future caller is not the one paying.
   `ProveBatchExecutor.MAX_DISPOSALS` is the one exception, and it bounds the
   disposal list only.
2. **Slither under-counts external calls.** Every `_probe` read
   (`ProveSettlement.sol:2798`) is an assembly `staticcall`, the flush pull in
   `_settleLedger` is not reached from a loop, `FeeClaimLib._tryTransfer` is
   assembly, and `ProveBatchExecutor._oweEveryLine`'s `balanceOf` is never walked.
   Count them from the source.
3. **`FeeClaimLib` runs in the settlement's storage.** It is a linked library
   reached by `DELEGATECALL`, so its correctness is the settlement's. The trust
   argument is that the address is fixed at link time and the bytecode carries no
   `SELFDESTRUCT` and no `DELEGATECALL` (`test/FeeClaim.t.sol`); the deploy must
   verify the linked library (`contracts/tools/verify-bytecode.mjs`).
4. **`reentrancy-benign` on `ProveBatchExecutor.settleRing`** rests on
   `_skipDisposal` being written and cleared inside one transaction under
   `nonReentrant`. Check the clear on every path, including the one where
   `fillBatchWithCallback` reverts.
5. **`KIND_LINEAR` is a number that only a comment ties to the branch.**
   `minOutAt` reaches the straight line by falling through, not by comparing
   against `KIND_LINEAR`.

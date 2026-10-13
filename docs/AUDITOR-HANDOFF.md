# Auditor handoff — prove.cash contracts

One page to start from. Every claim here points at the document that holds the detail.

**Frozen code.** Review the contracts at this commit or any later commit on `master`:
`contracts/src` is frozen, and `python3 contracts/tools/src-fingerprint.py --compare`
proves it on every CI run. Later commits change docs and tests only. Repository:
https://github.com/valve-tech/prove-cash.

## What to read, in order

1. [AUDIT-SCOPE.md §1](AUDIT-SCOPE.md#1-what-this-protocol-does) — what the protocol does.
2. [AUDIT-SCOPE.md §2](AUDIT-SCOPE.md#2-scope) — the thirteen in-scope files and what is out.
3. [AUDIT-SCOPE.md §4](AUDIT-SCOPE.md#4-the-trust-model) — the trust model, custody rungs and roles.
4. [FEE-MODEL.md Part 2](FEE-MODEL.md#part-2--three-take-points-one-config) — the fee math.
5. [AUDIT-SCOPE.md §5](AUDIT-SCOPE.md#5-invariants--what-is-already-machine-checked) and
   [§6](AUDIT-SCOPE.md#6-known-limits-accepted) — invariants already checked, and accepted limits.
6. [AUDIT-SCOPE.md §9](AUDIT-SCOPE.md#9-questions-we-want-answered) — where we want you to look.
7. [AUDIT-READINESS.md §2](AUDIT-READINESS.md#2-what-the-tests-prove-and-what-they-do-not) — what
   the tests prove and what they do not; [slither-triage.md](slither-triage.md) — every
   static-analysis finding with its verdict.
8. [AUDIT-CHECKLIST.md](AUDIT-CHECKLIST.md) — this repo against published audit-prep checklists.

## Scope in one paragraph

Thirteen files in `contracts/src`, 6,790 lines, about 2,760 nSLOC (non-blank, non-comment).
The settlement (`ProveSettlement.sol`, ~975 nSLOC) holds every escrowed balance and has no owner and
no setter. Out of scope: `contracts/src/interfaces/`, `contracts/script/`, `contracts/test/`,
`contracts/lib/` (OpenZeppelin, forge-std), the canonical Permit2 deployment, and the TypeScript
`sdk/` and `app/`. Compiler: solc 0.8.30, optimizer 200 runs, `via_ir`, EVM `paris`.
External integrations: Permit2 (`0x000000000022D473030F116dDEE9F6B43aC78BA3`) for one custody rung,
and arbitrary venues (PulseX and others) reached only through the `ProveCallSink` clones.

## Build and test

Foundry and Node are the only requirements.

```
git clone --recursive <repo> && cd prove-cash/contracts
forge build --sizes                      # build
forge test -vv                           # unit, fuzz and invariant tests
python3 tools/coverage-gate.py           # the 100% line/branch coverage gate
cd .. && tools/run-ci.sh                 # everything CI runs, in CI's order
# live bytecode and wiring check against mainnet 369 (needs an RPC):
cd contracts && PULSECHAIN_RPC=<369 rpc> FOUNDRY_PROFILE=fork forge test --match-path test/Live369.t.sol -vv
```

## Deployed on PulseChain mainnet (369)

Source of truth: `contracts/deployments/369.json`. All ten are a **partial match on Sourcify**
(runtime and creation code match; only the metadata hash differs). On the Blockscout explorer only
`FeeDefaults` is verified (partial); the other nine were submitted and never processed. Sourcify does
not support testnet 943, and on the 943 Blockscout explorer only `FeeDefaults` is verified. The
full table, including 943, is in [ADDRESSES.md](ADDRESSES.md#contracts).

| Contract | Address |
|---|---|
| ProveSettlement | [`0x5EB7cAf15f9Fa7Afad9a45d035f7E0F67140fC7b`](https://repo.sourcify.dev/369/0x5EB7cAf15f9Fa7Afad9a45d035f7E0F67140fC7b) |
| ProveRelayer | [`0xAc792BBDd72Ce4177Cf1FAD1719d7B68b598268b`](https://repo.sourcify.dev/369/0xAc792BBDd72Ce4177Cf1FAD1719d7B68b598268b) |
| FeeClaimLib | [`0x0b169aC0Be0a8062b2f839175Fd2431744Eb83f7`](https://repo.sourcify.dev/369/0x0b169aC0Be0a8062b2f839175Fd2431744Eb83f7) |
| ProveReader | [`0x8c93958085e4823983b2B811F206874C108C5288`](https://repo.sourcify.dev/369/0x8c93958085e4823983b2B811F206874C108C5288) |
| ProveExecutor | [`0x2746b99Cd4b8E35539592Be0895B7A5652b04AD7`](https://repo.sourcify.dev/369/0x2746b99Cd4b8E35539592Be0895B7A5652b04AD7) |
| ProveCallSink | [`0x1a3A59699BE7D908e1460cdAD83cfBd6b9Be4375`](https://repo.sourcify.dev/369/0x1a3A59699BE7D908e1460cdAD83cfBd6b9Be4375) |
| ProveBatchExecutor | [`0xE0925126C969E362195efdbF1f57d1DdF243781c`](https://repo.sourcify.dev/369/0xE0925126C969E362195efdbF1f57d1DdF243781c) |
| ProveBatchExecutorCallSink | [`0xBC60540D280e34f7De43F71dB6b1a9397CF44d37`](https://repo.sourcify.dev/369/0xBC60540D280e34f7De43F71dB6b1a9397CF44d37) |
| RfqVenue | [`0x6E94A88973f7D1cDcd59A5B0ef21C84eBdA09F04`](https://repo.sourcify.dev/369/0x6E94A88973f7D1cDcd59A5B0ef21C84eBdA09F04) |
| FeeDefaults | [`0xE92cB6265497F141125E25a9B5231370632e878E`](https://repo.sourcify.dev/369/0xE92cB6265497F141125E25a9B5231370632e878E) |

## Privileged roles

There is one. The owner of `FeeDefaults` (`0x5182574eE268ABD0A48f97DcfcdE65234E8422E2`, a single
key) can publish new advisory fee defaults and hand ownership on in two steps. `FeeDefaults` reaches
no funds and the settlement never reads it. The settlement, relayer, executors, sinks, reader and RFQ
venue have no owner, no pause and no upgrade path; the relayer answers only to the settlement. None
of the contracts is a proxy. See [AUDIT-SCOPE.md §4](AUDIT-SCOPE.md#4-the-trust-model).

## Accepted risks

Listed with their reasoning in [AUDIT-SCOPE.md §6](AUDIT-SCOPE.md#6-known-limits-accepted): rebasing
and taxing tokens (§6.1–6.3), unattributed tokens, the maker's free option (F-5), the missing
off-chain token allowlist, unpayable fee destinations, and the two disclosures in §6.10–6.11. The
single-key `FeeDefaults` owner is
[§6.12](AUDIT-SCOPE.md#612-the-feedefaults-owner-is-a-single-eoa-accepted-for-now), accepted until it
moves to a timelocked multisig.

## Fee model, in P1/P2/P3 terms

An intent signs one fee config hash and three rates, each taken separately and each rounding down:

- **P1, handover** (`feeIn`, rate `feeRateIn`): taken in tokenIn as the tokens leave the maker's
  escrow; paid by the filler.
- **P2, output** (`feeOut`, rate `feeRate`): taken in tokenOut on top of what the maker is owed;
  paid by the filler.
- **P3, proceeds** (`feeProceeds`, rate `feeRateProceeds`): taken in tokenOut out of what the maker
  is owed; the only point the maker bears.

The filler's `maxFeeRate` bounds P1 + P2 only. A zero config with any non-zero rate is rejected.
Each point is reserved in a book keyed by the config hash and paid to its destinations by weight in
`claim`. There is no protocol fee. Detail: [FEE-MODEL.md](FEE-MODEL.md#part-1--the-table).

## Prior reviews and contact

Earlier internal reviews (security 2026-08-11, economics, 2026-09-28) and their regression tests are
in [AUDIT-SCOPE.md §7](AUDIT-SCOPE.md#7-prior-findings). No external audit has been done yet.
Questions during the audit go to the contact in [SECURITY.md](../SECURITY.md).

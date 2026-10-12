# Contracts review — 2026-09-30

A full review of `contracts/src` at master `85cbaf1`, compared with
`2026-09-23-settlement.md` and `2026-09-23-executors-and-venue.md`. It is not a diff
review. An agent did it by reading the code. It did not run `forge` and did not compare
the 369 bytecode.

**Findings: 0 critical, 0 high, 1 medium, 4 low.** All five findings are drift between
the specs and the code. The reviewer found no defect in the code alone.

## Medium

**M-1. The owner can reprice every default-sink intent at fill time, with no cap.**
`ProveSettlement.sol:1088-1101, 1261-1263, 1309-1311`. This contradicts §1 promise 2,
FE-8 and §2.1 rows 11 and 12.

- **Defect.** An intent with `feeTo == 0` pays `defaultFeeSink.rate` at fill time. The
  owner sets that rate with `setDefaultFeeSink`, and the only bound on it is `WAD`.
- **Scenario.** A maker signs `feeTo = 0, feeRate = 0`. The owner registers a sink with
  `defaultRate = 1e18` and makes it the default. The next fill has `fee = gross` and
  `delivered = 0`. The maker receives nothing.
- **Who is protected.** The filler's `maxFeeRate` check (line 2978) protects fillers
  only. It does not protect makers.
- **Scope.** Escrowed principal is safe. The loss is the maker's proceeds on every open
  default-sink intent.
- **Why medium.** OW-2 records this power as an owner decision (2026-09-24).
- **Why it still needs a decision.** §1 and FE-8 still say the opposite. `ADDRESSES.md:149`
  lists the 369 owner as a deployer key, not a timelock, so today there is no delay.
- **Fix.** Cap the default rate in `_setDefaultFeeSink`, or record that the owner address
  must be a timelock. In both cases, correct §1 and FE-8.

## Low

**L-1.** `retireFeeSink` (`ProveSettlement.sol:1065-1071`) is an owner power that OW-1
does not list. OW-1 says "There MUST be nothing else." Fills do not read `retired`. Add
the power to OW-1, or delete it.

**L-2.** `_termsOk` (`ProveSettlement.sol:2885-2890`) refuses an unregistered non-zero
`feeTo` even when `feeRate` is 0. FE-8 says such an intent ignores the registry. `rateOf`
(`1261-1263`) returns the default sink's rate where PX-5 says zero. An old intent with a
stray `feeTo` can never fill. Update FE-8 and PX-5 to match the code.

**L-3.** Ownership transfer is two-step in the code (`ProveSettlement.sol:991-1002`) and
single-step in OW-1 and OQ-7. The code is the safer of the two. Close OQ-7 and rewrite OW-1.

**L-4.** BX-12 says both leg-index checks run before the first venue call.
`ProveBatchExecutor.sol:716-725` runs the buy-side check inside the swap loop. A bad
index still reverts the whole ring, so it wastes only gas. Add a pre-pass, or relax BX-12.

## Checked and clean

- **Signatures, nonces and replay.** This covers the typehash, the domain separator on a
  fork, the digest keys, the ERC-1271 gas cap and the lane floor.
- **Allowance and relayer.** The settlement holds no allowance. Every pull goes through
  the relayer, the relayer answers only to the settlement, and both contracts are kept
  out of call and payee slots.
- **Reentrancy and callbacks.** Every token-moving function holds `nonReentrant`. `dryRun`
  always reverts. `armLeg` accepts calls only from itself.
- **Fee arithmetic.** `gross` rounds up and `fee` rounds down, so the totals reconcile
  exactly. No path overflows, and the three per-token totals move with their maps.
- **Arming.** Arming runs in its own frame, and the full re-evaluation runs after it. The
  nonce and token checks run before the external call.
- **Executors, sink and venue.** The sender checks hold. Balance marks defeat donations.
  Allowances are exact sums. The sink clone is per caller, and the RFQ rules are enforced.
- **Denial of service.** Probes and arming are gas-capped. The routes that remain, hostile
  `transferFrom` code and rebasing tokens, are documented and left to an off-chain
  allowlist.
- **Accepted behaviours, not reported.** CU-21, FP-4, FP-12 and SA-5.

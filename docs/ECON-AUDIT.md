# Economics review finding register — prove.cash

This trimmed register keeps the economics findings that still matter to the
product. E-3 (ring grief) and E-5 (voluntary fee) remain open; the former is
mitigated in the SDK, while the latter is open by design for coordinated
maker/executor pairs. The FeeSink-only findings (E-8–E-10) are retired because
that subject was removed. The `FeeSink` of 2026-09-23 is gone too (2026-10-03): fees are keyed
by a signed config hash and `claim` pays the preimage's destinations, so none of those findings
applies. **New economics to review, none of it yet reviewed:** the solver bears two of the three
take points (P1 in tokenIn, P2 on top in tokenOut), so the rate is again part of the solver's
fill condition and moves the time a decaying offer fills; P3 comes out of the maker's delivery;
the default (P2 0.5%, warn 1%) is advisory and a maker or app may sign any config at any rate; a
multi-destination `claim` caps each transfer at 200,000 gas and re-books a failed share under
the destination's own config. See `docs/FEE-MODEL.md`.

---

## Findings

| # | Finding | Status | Evidence (file:line) | Regression test |
|---|---|---|---|---|
| E-3 | A maker can revert a whole ring by invalidating one intent, for about 13k gas — a fraction of what the executor spends on a batch that cannot skip the bad leg | Open (mitigated, not closed) | `docs/specs/2026-08-14-checkpoint.md:111`; `sdk/src/solver/rings.ts:155`, `:164`; `sdk/src/solver/execute.ts:73`, `:269`, `:505`; `sdk/src/solver/preflight.test.ts:7`; `app/scripts/solver.ts:405`, `:430`; `docs/AUDIT-SCOPE.md:1054` | No contract regression test. `sdk/src/solver/preflight.test.ts` tests the SDK guard (`executeRing` simulates before sending); no `EconAudit.t.sol` test drives the on-chain ring break |
| E-5 | The fee is voluntary for anybody who can coordinate — a maker and executor who settle the real consideration elsewhere can pay dust or zero fee on-chain | Open (partly reopened by `d1dd385`) | `docs/specs/2026-08-14-checkpoint.md:94`; `docs/AUDIT-SCOPE.md:1083`, `:1224`; `contracts/test/EconAudit.t.sol:663` | `testFuzz_E5_EveryFillPaysTheRateOnItsGross` (`EconAudit.t.sol:741`); `test_E5_ADustFillPaysNoFeeAndTheMakerKeepsTheWei` (`EconAudit.t.sol:777`); `test_E5_TheFeeOffMeansTheFeeOff` (`EconAudit.t.sol:799`) |

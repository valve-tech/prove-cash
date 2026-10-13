# This repository against published audit-preparation checklists

Checked 2026-10-13 (`contracts/src` frozen; see `contracts/tools/src-fingerprint.py`). The checklists:

- Trail of Bits, Building Secure Contracts — development guidelines:
  https://secure-contracts.com/development-guidelines/guidelines.html
- Trail of Bits, How to prepare for a security audit:
  https://blog.trailofbits.com/2018/04/06/how-to-prepare-for-a-security-audit/
- OpenZeppelin, Audit Readiness Guide: https://learn.openzeppelin.com/security-audits/readiness-guide
  and https://www.openzeppelin.com/readiness-guide
- Sherlock, audit preparation and readiness checklist:
  https://docs.sherlock.xyz/audits/protocols/how-collaborative-audits-work
- Solcurity (code-level review standard): https://github.com/transmissions11/solcurity

| Item | Asked by | Status | Evidence |
|---|---|---|---|
| Frozen commit | OZ, Sherlock, ToB | done | [AUDITOR-HANDOFF.md](AUDITOR-HANDOFF.md); `contracts/tools/src-fingerprint.py --compare` in CI |
| Scope list, line counts | OZ, Sherlock | done | [AUDIT-SCOPE.md §2](AUDIT-SCOPE.md#2-scope); nSLOC in the handoff |
| Build, test, coverage instructions | Sherlock, OZ | done | [AUDITOR-HANDOFF.md](AUDITOR-HANDOFF.md#build-and-test), `tools/run-ci.sh` |
| Passing tests, coverage > 80% | Sherlock | done (100% gate) | [AUDIT-SCOPE.md §8](AUDIT-SCOPE.md#8-test-and-coverage-posture) |
| Compiler warnings resolved or explained | Sherlock | done | `forge build` in CI; [AUDIT-SCOPE.md §8](AUDIT-SCOPE.md#8-test-and-coverage-posture) |
| Static analysis triaged | ToB, Sherlock | done | [slither-triage.md](slither-triage.md) |
| Invariants and fuzzing | ToB, OZ | done (Foundry; no Echidna/Medusa or formal spec) | [AUDIT-SCOPE.md §5](AUDIT-SCOPE.md#5-invariants--what-is-already-machine-checked) |
| Mainnet-fork test | OZ | partial — `Live369.t.sol` passes but CI only runs `Fork*` | `contracts/test/Live369.t.sol` |
| Plain-language overview, core flows | ToB, Sherlock | done | [AUDIT-SCOPE.md §1](AUDIT-SCOPE.md#1-what-this-protocol-does) |
| Architecture diagram | ToB | missing | — |
| NatSpec on every function | ToB, Solcurity | partial — about half the `src` functions carry NatSpec; `src` is frozen, so not changed | `contracts/src` |
| Actors and privileged roles | Sherlock, ToB | done | [AUDIT-SCOPE.md §4](AUDIT-SCOPE.md#4-the-trust-model) |
| Privileged key custody | ToB | partial — single EOA, accepted | [AUDIT-SCOPE.md §6.12](AUDIT-SCOPE.md#612-the-feedefaults-owner-is-a-single-eoa-accepted-for-now) |
| Known issues and accepted risks | OZ, Sherlock | done | [AUDIT-SCOPE.md §6](AUDIT-SCOPE.md#6-known-limits-accepted) |
| Upgradeability and migration procedure | ToB, OZ | done — no proxies; migration by redeploy | [ADDRESSES.md](ADDRESSES.md) |
| External dependencies | ToB, Solcurity | done | [AUDIT-SCOPE.md §2](AUDIT-SCOPE.md#out-of-scope-stated-explicitly) |
| Fee and accounting math | Sherlock, OZ | done | [FEE-MODEL.md](FEE-MODEL.md) |
| Deployed addresses and source verification | ToB | partial — Sourcify partial match for all ten on 369; Blockscout verifies only `FeeDefaults`; Sourcify has no 943 | [ADDRESSES.md](ADDRESSES.md) |
| Threat model | ToB, OZ | done | [AUDIT-SCOPE.md §4](AUDIT-SCOPE.md#4-the-trust-model), [§6](AUDIT-SCOPE.md#6-known-limits-accepted) |
| Prior audits shared | Sherlock, OZ | partial — internal reviews only | [AUDIT-SCOPE.md §7](AUDIT-SCOPE.md#7-prior-findings) |
| Security contact, disclosure policy | ToB, OZ | done | [SECURITY.md](../SECURITY.md); not yet on blockchain-security-contacts |
| Monitoring and incident response plan | ToB, OZ | partial — no published monitoring or incident-response plan | — |
| Team available during the audit | Sherlock | open — a decision, not a document | — |

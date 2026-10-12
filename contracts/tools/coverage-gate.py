#!/usr/bin/env python3
"""Fail the build when anything measurable is left uncovered.

    python3 tools/coverage-gate.py             # runs forge coverage, then checks it
    python3 tools/coverage-gate.py --lcov f    # checks an lcov file you already have

The contracts are at 100% of every line, branch, statement and function that
`forge coverage` is able to instrument here. The exception is Yul, and the
reason is worth writing down because the obvious conclusion is wrong.

**forge can instrument Yul.** Given a plain project and the legacy pipeline it
counts assembly statements like any others — checked, in a scratch project, five
of six lines of the very block below.

**This contract cannot be instrumented that way.** `forge coverage` turns via-IR
off and injects counters, and `ProveSettlement` runs the legacy pipeline out of
stack before a single test is compiled. That is not a fixable frame: with all
sixty-one of its function bodies replaced by `revert()` it still overflows, so
the pressure is in the ABI coders solc generates for the public signatures —
`Intent calldata`, `FillRequest[] calldata`, the structs it returns. Nothing
short of changing that interface moves it, and the interface is what every
signature, the SDK and the app are built on.

So `--ir-minimum` is forced, and `--ir-minimum` counts no Yul statement anywhere
in this codebase, however many tests run it.

Seven Yul lines remain, in two blocks: six in `ProveSettlement._probe` and one
in `ProveBatchExecutor._write`. They are load-bearing and tested.
`tools/prove-yul-runs.py` breaks each block on purpose and counts the tests that
fail — 295 for `_probe`, 2 for `_write` — so the forgiveness below is checked
rather than promised. Know when it is checked: it is the `yul` job of
`.github/workflows/soak.yml`, which runs nightly at 04:00 UTC and on request,
NOT beside this gate on every push. It was 22m49s of the pull-request job before
it moved, and `.ci-local-pass` has never covered it. So a change that breaks the
Yul claim goes red the next morning, not within the hour. Read that
tool before you trust this one; it says why the second number is so much smaller
and why that is a fact about the tests rather than about the block, and why the
first one went from 76 to 287 on 2026-09-04 without the suite growing.

`_probe` was one of three blocks measured against plain-Solidity replacements.
Two of the three are gone: `FeeSink._burn` went with its contract, and the
`owed` array is narrowed by copying, because measuring showed the assembly
bought nothing there. `_probe` stays because measuring showed the opposite.
`test/ReturnBomb.t.sol` prices the three shapes it could take, and the two
without assembly are worse — one by 648 gas on every honest batch leg, and the
other by reverting the whole batch on a token that answers with nothing.

`ProveBatchExecutor._write` is the other block, and it is one `mstore`: it
overwrites a word of a venue's calldata at an offset the caller named, after the
line above it bounds-checks that offset against the blob's own length.

**Branches: this gate can see all of them, and the count is zero hidden.** Seven
items are forgiven and every one is a Yul line. No branch is forgiven, and none
is invisible: the report carries 220 branch records across `src/` and `script/`,
this gate reads all 220, and all 220 are hit. Read "100% of branches" as every
branch forge emits, with nothing set aside.

An earlier note below claimed two guards in `RfqVenue`'s constructor were
invisible here — that forge emitted no record for them and the gate could not
fail on them. Measured 2026-09-16: that was wrong. `BRDA:223` and `BRDA:226` are
both in the report and both hit, in a file reading 27 of 27 branches. Delete the
two tests that take them and the same file reads 25 of 27 with both at zero, so
the gate does fail on them.
"""

import argparse
import os
import re
import subprocess
import sys
from collections import defaultdict

CONTRACTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def assembly_lines(path):
    """Every line number inside an `assembly { ... }` block in `path`."""
    inside, depth, out = False, 0, set()
    for n, line in enumerate(open(os.path.join(CONTRACTS, path)).read().split("\n"), 1):
        if not inside and re.search(r"\bassembly\b", line):
            inside, depth = True, line.count("{") - line.count("}")
            out.add(n)
            continue
        if inside:
            depth += line.count("{") - line.count("}")
            out.add(n)
            if depth <= 0:
                inside = False
    return out


def run_coverage(lcov_path):
    # Coverage asks which lines run, never how many times. So the invariant campaigns are cut to
    # one short chain here. At the committed 128 runs of 256 calls they cost 27 minutes of CI
    # under instrumentation and reach not one line the first chain misses. The real depth still
    # runs in `forge test`, which is where it belongs.
    env = {**os.environ, "FOUNDRY_DISABLE_NIGHTLY_WARNING": "1",
           "FOUNDRY_OUT": "out-coverage", "FOUNDRY_CACHE_PATH": "cache-coverage",
           "FOUNDRY_INVARIANT_RUNS": "1", "FOUNDRY_INVARIANT_DEPTH": "24"}
    cmd = ["forge", "coverage", "--ir-minimum", "--exclude-tests",
           "--no-match-path", "test/{Fork,Live369}.t.sol",
           "--report", "summary", "--report", "lcov", "--report-file", lcov_path]
    # Delete it first. `forge coverage` leaves the previous report in place when it fails, and
    # a gate that then reads it is checking a tree that no longer exists — it reported three
    # struct getters as covered on 2026-08-26 while the run that was meant to measure them had
    # died on a stack overflow. The `--lcov` path above is the only way to check an old report,
    # and that one is asked for.
    if os.path.exists(lcov_path):
        os.remove(lcov_path)

    r = subprocess.run(cmd, cwd=CONTRACTS, env=env, capture_output=True, text=True)
    out = r.stdout + r.stderr
    for line in out.split("\n"):
        if line.startswith("| ") and "SettlementHandler" not in line:
            print(line)
    # Existence alone, and that is enough now the report is deleted above: a failed run leaves
    # no file. The exit code is NOT the test — `forge coverage` returns non-zero on a successful
    # run whose advisory mentions stack depth, so checking it fails a build that is fine.
    if not os.path.exists(lcov_path):
        print(out[-3000:], file=sys.stderr)
        sys.exit("coverage did not produce a report")


def parse(lcov_path):
    files, cur = defaultdict(lambda: {"lines": [], "branches": [], "funcs": []}), None
    for raw in open(lcov_path):
        s = raw.strip()
        if s.startswith("SF:"):
            cur = s[3:]
        elif s.startswith("DA:"):
            n, c = s[3:].split(",")[:2]
            if c == "0":
                files[cur]["lines"].append(int(n))
        elif s.startswith("BRDA:"):
            p = s[5:].split(",")
            if p[-1] in ("0", "-"):
                files[cur]["branches"].append(int(p[0]))
        elif s.startswith("FNDA:"):
            c, name = s[5:].split(",", 1)
            if c == "0":
                files[cur]["funcs"].append(name)
    return files


# A branch whose only outcome is `revert`, and the test that proves it anyway.
#
# forge writes its hit counters as state, so a revert takes its own counters down with it. The
# rule that matters is narrower than that sentence sounds, and getting it wrong costs an
# afternoon:
#
#     A revert that unwinds the WHOLE TRANSACTION takes its counters with it.
#     A revert CAUGHT INSIDE a transaction that goes on to commit keeps them.
#
# So `if (_entered == 2) revert Reentrant();` below is genuinely uncountable — the test that
# takes it is `vm.expectRevert` on the whole call, and the evidence dies with the transaction.
# But every branch inside `armLeg` is counted, revert or not, because `_arm` calls it through
# `try`/`catch` and the batch commits around it. An entry for one of those would be a lie, which
# is what the unused-entry check below is for.
#
# Measured 2026-08-26: the escrow arm of `armLeg` reported five hits from five entries, three of
# which reverted.
#
# This is not a licence to forgive a guard nobody tested. Each entry names the test that takes
# the branch and asserts the revert, and the gate is not the thing keeping that honest — the
# test is. Delete the test and this list becomes a lie, so check the test still exists before
# you trust the line.
#
# It became visible on 2026-08-25 rather than being introduced then. `nonReentrant` is inlined
# at most of its call sites, and forge attributes the hits to the call site rather than to the
# modifier; moving the fee to a wider type changed the contract enough to change what the
# compiler inlined, and the residual attribution at the modifier flipped from one hit to none.
# The guard ran 2,524 times through `deposit` and 3,658 through `withdraw` in the same report.
# Empty, and that is the interesting part. Both entries this list ever held were deleted on
# 2026-08-26 within hours of the check below being written, because forge had started counting
# both. The machinery stays: the next genuinely uncountable branch needs it, and the check is
# what stops an excuse outliving its reason.
# A constructor guard was a third case, and it turned out to be the fixable one.
#
# `forge` does not run `new C(...)` in a test as a plain CREATE. It rewrites it into the
# `deployCode` cheatcode, so the creation runs in a frame the test enters through the cheatcode
# boundary. When the constructor reverts, that frame's counters die there — even though
# `vm.expectRevert` catches the revert and the test transaction commits normally. Solidity cannot
# catch it either: `try new C(...) catch {}` does NOT catch a cheatcode revert, it bubbles and
# fails the test. Measured 2026-08-27.
#
# All of that still holds. The conclusion drawn from it did not, and this comment carried the
# wrong one until 2026-09-15: "no constructor guard that reverts can ever be counted, however it
# is tested." Moving the CREATE out of the test does remove it, on both executors.
# A four-line factory deploys through an ordinary CREATE — `ExecutorFactory` in
# `test/Executor.t.sol`, `BatchExecutorFactory` in `test/BatchExecutor.t.sol` and `VenueFactory`
# in `test/RfqVenue.t.sol` — and the revert is then one caught inside a transaction that commits,
# which is the counted case above.
#
# Measured 2026-09-15 on `test/{Executor,BatchExecutor}.t.sol`, with the factory as the only
# change:
#
#     src/ProveExecutor.sol        branches  81.82% (9/11)  -> 100.00% (11/11)
#     src/ProveBatchExecutor.sol   branches  68.57% (24/35) ->  74.29% (26/35)
#
# So the four entries this list held for those guards are gone. forge counts them now, and the
# check below would call them stale if they stayed.
#
# `RfqVenue`'s constructor carries the same two lines, character for character, and this comment
# claimed forge emitted no branch record for them at all — neither covered nor uncovered, so that
# the gate could not see them. Measured 2026-09-16, that was wrong. `BRDA:223` and `BRDA:226` are
# both in the report and both hit, in a file reading 27 of 27 branches. Cut the two tests that
# take them and the same file reads 25 of 27 with both at zero, so the gate does fail on them.
#
# The narrower fact is the one worth keeping. What forge credits does NOT follow from how the
# test deploys. The same bare `new C(...)` credited the guard from `test/RfqVenue.t.sol` and
# credited nothing from a scratch file holding no other CREATE of that type, while the bare form
# credited nothing at all for either executor. A factory counted every time it was tried, so all
# three suites now use one and none of them leans on the bare form.
#
# So the dict is empty again, for the second time, and it stays for the reason given above.
REVERT_ONLY_BRANCHES = {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lcov", help="check this report instead of measuring a fresh one")
    args = ap.parse_args()

    # Measure, unless the caller names a report. An earlier version reused any `lcov.info` it
    # found, and that is a gate that lies: the line numbers in a stale report belong to a tree
    # that no longer exists. Adding six lines of comment to `ProveSettlement.sol` was enough to
    # make it call five comment lines uncovered code, with the same confidence it reports a
    # real gap.
    lcov = args.lcov
    if lcov is None:
        lcov = os.path.join(CONTRACTS, "lcov.info")
        run_coverage(lcov)

    failures, forgiven, used = [], [], set()
    for path, found in sorted(parse(lcov).items()):
        if not (path.startswith("src/") or path.startswith("script/")):
            continue
        yul = assembly_lines(path)
        body = open(os.path.join(CONTRACTS, path)).read().split("\n")
        for n in sorted(set(found["lines"])):
            text = body[n - 1].strip()
            if n in yul:
                # Name the control. A reader who sees a forgiven line needs to know what stands
                # in for the counter, and that it runs overnight rather than on this push.
                forgiven.append(
                    f"{path}:{n}  {text}\n"
                    "        Yul: forge counts no assembly statement anywhere here. The control "
                    "is tools/prove-yul-runs.py,\n        which breaks this block on purpose and "
                    "counts the tests that fail. It runs in the `yul` job\n        of "
                    ".github/workflows/soak.yml — nightly at 04:00 UTC, not on this push."
                )
            else:
                failures.append(f"{path}:{n}  {text}")
        for n in sorted(set(found["branches"])):
            text = body[n - 1].strip()
            why = REVERT_ONLY_BRANCHES.get((path, text))
            if why:
                used.add((path, text))
                forgiven.append(f"{path}:{n}  BRANCH  {text}\n        covered by {why}")
            else:
                failures.append(f"{path}:{n}  BRANCH  {text}")
        for name in sorted(set(found["funcs"])):
            failures.append(f"{path}  FUNCTION never called: {name}")

    # An excuse for a branch forge now counts is a lie waiting to be believed. One went stale
    # within the hour on 2026-08-26: `if (auth.nonce != h) revert BadTerms();` was uncountable
    # when its test reverted the transaction and counted the moment the test began catching the
    # revert instead. Nothing said so. Now it does.
    for (path, text) in sorted(set(REVERT_ONLY_BRANCHES) - used):
        failures.append(
            f"{path}  STALE EXCUSE  {text}\n"
            "        forge counts this branch now. Delete the REVERT_ONLY_BRANCHES entry."
        )

    print()
    if forgiven:
        print(f"{len(forgiven)} item(s) forge cannot count, each with the reason:")
        for f in forgiven:
            print(f"    {f}")
    if failures:
        print(f"\nFAIL: {len(failures)} uncovered item(s) with no such excuse:")
        for f in failures:
            print(f"    {f}")
        sys.exit(1)
    print("\nOK: 100% of every line, branch and function forge can instrument.")


if __name__ == "__main__":
    main()

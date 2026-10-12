#!/usr/bin/env python3
"""Prove the Yul that `forge coverage` cannot count is nevertheless run.

    python3 tools/prove-yul-runs.py

`forge coverage --ir-minimum` counts no statement inside an `assembly` block —
not one, anywhere in this codebase, however many tests exercise it. And
`--ir-minimum` is forced: plain coverage builds without via-IR, and
`ProveSettlement` runs the legacy pipeline out of stack under instrumentation
even with every function body emptied. So those lines are always reported
uncovered, and `tools/coverage-gate.py` forgives them.

Forgiving them on trust would be worthless. This says what a counter cannot: it
breaks each block on purpose and counts the tests that notice.

It proves a block is *entered*. It breaks the block's first statement only, so a
failing suite says the tests reach the block, not that every statement inside it
earns its place. A dead line further down would still pass this control.

Two blocks remained until 2026-10-03; the fee config change added six more (see TARGETS). Two others went when measuring showed they bought nothing:
`FeeSink._burn` was one of them and its contract is gone; the `owed` array is narrowed by
copying. These two stay because measuring showed the opposite —
`test/ReturnBomb.t.sol` prices all three shapes `_probe` could take.

Last run, on the whole suite, 2026-10-06 (eight targets, all run by the suite):

    ProveSettlement._probe        the bounded token read     351 tests fail
    ProveBatchExecutor._write     the calldata patch           5 tests fail
    FeeClaimLib._tryTransfer      the capped fee transfer     13 tests fail
    ProveReader._read             the bounded reader call     25 tests fail
    ProveReader._decimals         the decimals read           24 tests fail
    ProveReader._symbol           the symbol call             24 tests fail
    ProveReader._symbol           the symbol first word       24 tests fail
    ProveReader._symbol           the symbol length word      24 tests fail

The run before it, 2026-10-04, read 348 for `_probe`, 4 for `_write`, 11 for `_tryTransfer`,
23 for `_read` and 22 for each reader block; the Yul margin tests of 2026-10-06 moved each.
The fee config change had moved `_probe` and `_write` from 295 and 2 (2026-09-08).

That is a stronger statement than a coverage counter makes. A counter says a
line ran; this says the suite would catch it if it stopped working.

Read `_probe`'s figure as a margin, not a constant. The suite fuzzes without a
fixed seed, so a run either side of this one moves by a test or two.

It read 287 on 2026-09-04, 291 the next day when the fee split (#119) added four
tests that settle something, and 295 on 2026-09-08 when the parked-capital work
(#120) added `test/Parked.t.sol`. That is the margin moving with the suite, not
the block changing.

`_probe` read 76 until the return-bomb work of 2026-09-04 put the delivery
through it. It now carries every balance and allowance the contract reads off an
intent's token — `_evaluate`'s two on token A and its one on token B, `_held`
for a redemption or a permit2 draw, and both sides of `_deliverTo`'s
fee-on-transfer bracket. `_deliverTo` runs on every fill, so almost every test
that settles anything now notices when the block breaks. The jump is the block
becoming load-bearing, not the suite growing: four tests were added that day.

Two is a thin margin and it is not noise. `_write` has one caller, `sellSurplus`,
and `settleRing` reaches that through `try this.sellSurplus(...) {}` — a bare
catch that swallows anything the disposal does wrong. So a broken `_write` is
invisible to every test that only checks the batch settled, and visible only to
the two in `test/BatchExecutor.t.sol` that assert what the disposal actually
sold: `test_ADisposalSizesItselfToTheSurplusThatArrived`, and
`test_ADisposalRefusesAPriceBelowItsScaledBound`, which arrived on 2026-09-04
and made the margin two. The block is proven run; the suite around it is thinner
than the number for `_probe` suggests.


## It never edits your working tree

Breaking a contract on purpose in a shared checkout is how you hand a colleague
a fake regression. Somebody lost an investigation to exactly that.

So this copies the repository into a throwaway `git worktree` under the system
temp directory, carries your uncommitted changes across with `git apply`, and
does every edit in there. Your checkout is never written to, not for a moment,
so killing this tool at any point cannot leave a broken contract behind. The
worst an interrupted run leaves is a stray worktree, and the next run prunes it.

Because it builds in a fresh tree it cannot use your `out/` either, which means
a cold compile per block. That is the cost of not touching your files.


## It finds each block by searching, never by line number

The version before this one named `src/ProveSettlement.sol:1577`. That was the
`staticcall` when the line was written, in 4ececf5. Edits above it pushed
`_probe` some five hundred lines down, and by 2026-09-03 line 1577 held the
signature of `_grantAllowance` — a function with no assembly in it at all. The
control was pointed at ordinary Solidity and could say nothing about the block
it was meant to guard. It also had no target for `ProveBatchExecutor._write`,
and nothing anywhere said so. Neither fault could surface, because the tool was
in no workflow.

A tool that goes stale on an unrelated edit is not a control. Here a target
names a file and a function. The tool finds the one `assembly` block inside that
function and breaks its first statement. It also walks every `.sol` file in
`src/` and `script/` and fails if it meets an `assembly` block that no target
claims, so a new block cannot arrive without a control.


## It reads forge's own count, never the transcript

The same fault as the line number, in a different place. This tool used to count
failures by counting the transcript lines that open with `[FAIL`. `forge test`
prints every failure twice — once inline under its suite, and once again in the
`Failing tests:` trailer — so that count was exactly double. Every margin this
tool published before 2026-09-04 was twice its true value: `_probe` was written
down as 148 where the suite that day had 74 tests to fail.

Counting `[FAIL` lines is a proxy for counting failing tests, and a proxy for a
measurement is not the measurement. `forge test --list` is the same trap again:
it reports 585 tests against a run of 543, because it collapses each invariant
campaign into one entry — 46 invariant functions show as 4. Neither number is a
lie; neither one answers the question asked of it.

So this parses the summary line forge prints at the end, which is forge's own
count, and it says so rather than reporting zero when that line is missing. Do
not put the naive count back.

Slow — a cold build and a full test run per block. CI runs it beside the
coverage gate. Run it locally when one of these blocks changes, and paste the
numbers above.
"""

import contextlib
import os
import re
import shutil
import subprocess
import sys
import tempfile

CONTRACTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# One entry per `assembly` block in the tree, named by the function that holds it. Line numbers
# are deliberately absent: they are what broke this tool the first time.
#
# `(path, function, label)` for a function with one block, and `(path, function, label, nth, of)`
# for one with several: `nth` is the 0-based block and `of` how many the function must hold, so a
# block added to it without an entry here is still named rather than silently skipped.
TARGETS = [
    ("src/ProveSettlement.sol", "_probe", "the bounded token read"),
    ("src/ProveBatchExecutor.sol", "_write", "the calldata patch"),
    # The fee config change (2026-10-03) added these. The first is the capped transfer a
    # multi-destination `claim` makes, in the linked library; the rest are the reader's bounded
    # staticcalls. Measured 2026-10-06: see the table in the header.
    ("src/FeeClaimLib.sol", "_tryTransfer", "the capped fee transfer"),
    ("src/ProveReader.sol", "_read", "the bounded reader call"),
    ("src/ProveReader.sol", "_decimals", "the decimals read"),
    ("src/ProveReader.sol", "_symbol", "the symbol call", 0, 3),
    ("src/ProveReader.sol", "_symbol", "the symbol first word", 1, 3),
    ("src/ProveReader.sol", "_symbol", "the symbol length word", 2, 3),
]


def target(t):
    """Normalise a TARGETS row to (path, function, label, nth, of)."""
    return t if len(t) == 5 else (*t, 0, 1)

# Where a stray `assembly` block would still be forgiven by the coverage gate, so where one
# must not appear without an entry above.
AUDITED = ("src", "script")


def die(message):
    sys.exit(f"prove-yul-runs: {message}")


def git(*args, cwd, check=True, stdin=None):
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, input=stdin)
    if check and r.returncode:
        die(f"git {' '.join(args)} failed:\n{r.stderr.strip()}")
    return r


def read(base, path):
    with open(os.path.join(base, path)) as f:
        return f.read()


def blank_noncode(text):
    """Blank comments and string bodies, keeping every line and column where it was.

    Brace counting is how this tool finds a function and a block, and a brace in a comment
    counts just as well as a real one. `_probe`'s own doc comment contains `default { ok := 0 }`.
    """
    out, i, n = [], 0, len(text)
    while i < n:
        two = text[i:i + 2]
        if two == "//":
            j = text.find("\n", i)
            j = n if j < 0 else j
        elif two == "/*":
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
        elif text[i] in "\"'":
            q, j = text[i], i + 1
            while j < n and text[j] != q and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            j = min(j + 1, n)
        else:
            out.append(text[i])
            i += 1
            continue
        out.append("".join(c if c == "\n" else " " for c in text[i:j]))
        i = j
    return "".join(out)


def locate(base, path, function, nth=0, of=1):
    """Find the one `assembly` block inside `function`, by searching rather than counting lines.

    Returns (open_line, statement_line, close_line), all 1-based.
    """
    code = blank_noncode(read(base, path)).split("\n")

    sig = re.compile(r"^\s*function\s+" + re.escape(function) + r"\s*\(")
    starts = [n for n, line in enumerate(code) if sig.match(line)]
    if len(starts) != 1:
        die(f"{path}: found {len(starts)} definitions of `function {function}(`, expected one")
    start = starts[0]

    # The function body, by brace depth from the signature. A multi-line signature is fine:
    # only the `{` that opens the body carries a brace.
    depth, opened, end = 0, False, None
    for n in range(start, len(code)):
        depth += code[n].count("{") - code[n].count("}")
        opened = opened or "{" in code[n]
        if opened and depth <= 0:
            end = n
            break
    if end is None:
        die(f"{path}: `{function}` has no closing brace")

    asm = [n for n in range(start, end + 1) if re.search(r"\bassembly\b", code[n])]
    if len(asm) != of:
        die(f"{path}: `{function}` holds {len(asm)} assembly blocks, expected {of}. "
            "Give each its own target.")
    top = asm[nth]
    if "{" not in code[top]:
        die(f"{path}:{top + 1}: expected `assembly ... {{` on one line")

    depth, close = code[top].count("{") - code[top].count("}"), None
    for n in range(top + 1, end + 1):
        depth += code[n].count("{") - code[n].count("}")
        if depth <= 0:
            close = n
            break
    if close is None:
        die(f"{path}:{top + 1}: the assembly block has no closing brace")

    stmt = next((n for n in range(top + 1, close) if code[n].strip()), None)
    if stmt is None:
        die(f"{path}:{top + 1}: the assembly block is empty")

    # Only the first line of the statement is replaced, so a statement that wraps would leave
    # its own tail behind and the build would fail for the wrong reason.
    if code[stmt].count("(") != code[stmt].count(")") or "{" in code[stmt]:
        die(f"{path}:{stmt + 1}: the first statement spans lines or opens a block; "
            "this tool replaces one line")

    return top + 1, stmt + 1, close + 1


def every_assembly_block(base):
    """Every `assembly` block in the audited trees, as (path, line)."""
    found = []
    for tree in AUDITED:
        for root, _, names in os.walk(os.path.join(base, tree)):
            for name in sorted(names):
                if not name.endswith(".sol"):
                    continue
                rel = os.path.relpath(os.path.join(root, name), base)
                for n, line in enumerate(blank_noncode(read(base, rel)).split("\n"), 1):
                    if re.search(r"\bassembly\b", line):
                        found.append((rel, n))
    return found


@contextlib.contextmanager
def scratch_tree():
    """A throwaway worktree holding HEAD plus your uncommitted work.

    Everything this tool breaks, it breaks in here. The checkout you are sitting in is never
    written to, so an interrupted run cannot leave a sabotaged contract behind for the next
    person to debug.
    """
    root = git("rev-parse", "--show-toplevel", cwd=CONTRACTS).stdout.strip()
    rel = os.path.relpath(CONTRACTS, root)

    # A killed run leaves a registration behind. Clear it before adding another.
    git("worktree", "prune", cwd=root, check=False)

    path = tempfile.mkdtemp(prefix="prove-yul-")
    os.rmdir(path)  # git insists on creating the directory itself
    git("worktree", "add", "--detach", "--quiet", path, "HEAD", cwd=root)
    try:
        # Carry uncommitted work across. Without this the tool measures HEAD, and the moment you
        # most want to run it is the moment you have just changed one of these blocks.
        diff = git("diff", "HEAD", cwd=root).stdout
        if diff:
            git("apply", "--whitespace=nowarn", "-", cwd=path, stdin=diff)
        untracked = git("ls-files", "--others", "--exclude-standard", f"{rel}/src",
                        f"{rel}/script", cwd=root).stdout.split()
        if any(f.endswith(".sol") for f in untracked):
            print("NOTE: untracked .sol files are not carried into the scratch tree:")
            for f in untracked:
                if f.endswith(".sol"):
                    print(f"    {f}")

        # `lib/` is two git submodules, and `git worktree add` leaves their directories empty.
        # Point at the ones already checked out; nothing here writes to them.
        lib = os.path.join(path, rel, "lib")
        shutil.rmtree(lib, ignore_errors=True)
        os.symlink(os.path.join(CONTRACTS, "lib"), lib)

        yield os.path.join(path, rel)
    finally:
        git("worktree", "remove", "--force", path, cwd=root, check=False)
        shutil.rmtree(path, ignore_errors=True)
        git("worktree", "prune", cwd=root, check=False)


# `forge test` ends with one line that carries its own count:
#
#     Ran 40 test suites in 1226.01s (2198.68s CPU time): 533 tests passed, 0 failed, 10 skipped
#
# Read the count from there, and never by counting `[FAIL` lines in the transcript: forge prints
# every failure twice, inline and again in the `Failing tests:` trailer, so that count doubles
# every margin. See the docstring above for what it cost.
SUMMARY = re.compile(r"^Ran \d+ test suites?\b[^:]*:\s*\d+ tests? passed, (\d+) failed", re.M)


def run_suite(cwd, env):
    """The whole suite, less the two that need a network. Returns (failed, note)."""
    r = subprocess.run(
        ["forge", "test", "--no-match-path", "test/Fork.t.sol"],
        cwd=cwd, env=env, capture_output=True, text=True,
    )
    out = r.stdout + r.stderr
    # A build that does not compile proves nothing, and it looks exactly like a block no test
    # runs: zero failures reported. Name it. `forge coverage` also prints a "stack too deep"
    # advisory that is not an error, which is why this matches the phrase and not the exit code.
    if "Compiler run failed" in out:
        return 0, "DID NOT COMPILE — no evidence either way"
    if "No tests found in project" in out:
        return 0, "NO TESTS RAN — stale cache, or the filter matched everything"
    m = SUMMARY.search(out)
    # No summary line means no measurement. Say so rather than reporting a number nobody counted.
    if m is None:
        return 0, "NO SUMMARY LINE — forge printed no count to read"
    return int(m.group(1)), None


def main():
    env = {**os.environ,
           "FOUNDRY_DISABLE_NIGHTLY_WARNING": "1",
           # `forge test` reports "No tests found in project" off a stale link cache on a tree
           # that holds hundreds. One run with dynamic linking off clears it.
           "FOUNDRY_DYNAMIC_TEST_LINKING": "false"}

    with scratch_tree() as base:
        print(f"scratch tree: {base}\n")

        claimed = {}
        for t in TARGETS:
            path, function, _, nth, of = target(t)
            top, stmt, _ = locate(base, path, function, nth, of)
            claimed[(path, top)] = function
            print(f"{path}:{function} — assembly at line {top}, breaking line {stmt}")

        # A block with no target is a block the coverage gate forgives and nothing checks.
        orphans = [f"{p}:{n}" for p, n in every_assembly_block(base) if (p, n) not in claimed]
        if orphans:
            die("assembly with no entry in TARGETS, so nothing proves it runs:\n    "
                + "\n    ".join(orphans))

        print()
        worst = 0
        for t in TARGETS:
            path, function, label, nth, of = target(t)
            _, stmt, _ = locate(base, path, function, nth, of)
            original = read(base, path)
            body = original.split("\n")
            text = body[stmt - 1]
            body[stmt - 1] = " " * (len(text) - len(text.lstrip())) + "invalid()"
            full = os.path.join(base, path)
            with open(full, "w") as f:
                f.write("\n".join(body))
            try:
                failed, note = run_suite(base, env)
            finally:
                # Only so the next target measures a healthy tree. Nothing outside this scratch
                # worktree ever saw the broken copy.
                with open(full, "w") as f:
                    f.write(original)
            verdict = note or ("run by the suite" if failed else "NOT RUN BY ANY TEST")
            worst = max(worst, 0 if (failed and not note) else 1)
            name = f"{os.path.basename(path).removesuffix('.sol')}.{function}"
            print(f"{name:34s} {label:26s} {path}:{stmt:<5d} {failed:4d} tests fail  {verdict}")

    print("\nscratch tree removed; your checkout was never written to")
    sys.exit(worst)


if __name__ == "__main__":
    main()

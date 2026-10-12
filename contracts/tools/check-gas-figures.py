#!/usr/bin/env python3
"""
A gas figure written in prose is a claim about the generated table. This checks it.

`app/src/landing/gas.ts` is written by `gen-gas.mjs` out of `Gas.t.sol`, and CI already compares
the file with the tests. Nothing compared the DOZENS of copies of those numbers that live in
comments, documentation and the landing page's own prose — and those go stale every time a
contract changes, silently, because a number in a sentence has nothing behind it.

They have gone stale repeatedly and expensively. The landing page advertised 33,403 gas for a
warm allowance fill against a measured 105,238, in thirty-five languages. On 2026-09-08 five
figures in the solver's own comments were stale at once, and the break-even rate the bot printed
was computed from them; the same day a task brief handed a subagent all five as fact.

**The check is not "does this number look right".** That cannot be automated: 2,100 for a cold
SLOAD and 2,600 for a cold account are correct and are not in the table, and a gate that guessed
would be wrong about 92% of the figures this repository writes. The check is narrower and exact:

    a figure equal to a value the table ONCE held and no longer holds is a figure
    that was copied out of the table and left behind

That has no false positives by construction. It has one false POSITIVE class — prose that
deliberately quotes an old number to say it changed, `115,543 -> 115,609` — and those are
excused by exact text below, the way `coverage-gate.py` excuses a branch forge cannot count.

    python3 tools/check-gas-figures.py

Run it from `contracts/`. Exit 0 when every retired figure is either gone or excused.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
TABLE = ROOT / "app" / "src" / "landing" / "gas.ts"

# Where a copy of a gas figure has ever turned up. `gas.ts` itself is excluded: it is the source.
SEARCH = [
    "contracts/src",
    "contracts/test",
    "contracts/tools",
    "sdk/src",
    "app/src",
    "app/scripts",
    "docs",
    "README.md",
]
SUFFIXES = {".sol", ".ts", ".tsx", ".md", ".mjs", ".py"}

# A spec under `docs/specs/` is a dated record of what was measured on the day it was
# written, and most of its figures are deliberately before-and-after. Gating them would mean
# rewriting history every time a contract changes, which is the opposite of what a record is for.
# Their line citations are still gated, by `check-citations.py`.
SKIP_DIRS = ("docs/specs",)

# This file, because HISTORICAL below quotes the very lines it excuses — including their figures.
# Scanning it means the excuse list is itself a finding, and every entry needs an entry. The cost
# of the exclusion is bounded and stated: a stale figure written into this tool's own prose is not
# caught by this tool. Nothing else here excludes itself.
SKIP_FILES = ("contracts/tools/check-gas-figures.py",)

# A figure, as this repository writes one: grouped in threes, so `115,609` and never `115609`.
# The grouping is what makes it a number written for a person to read, which is what this checks.
FIGURE = re.compile(r"\b(\d{1,3}(?:,\d{3})+)\b")

#
# Prose that quotes a retired figure ON PURPOSE, keyed by the exact line so an edit re-opens the
# question. Every entry says what the line is doing, and a sentence recording that a number moved
# is the main honest reason to write one down.
#
# Keep this list short. An entry is a promise that the line is about history; a line that says
# what something COSTS belongs in the table's current values or nowhere.
#
HISTORICAL: dict[tuple[str, str], str] = {
    ("contracts/src/ProveRelayer.sol",
     '*        a leg whose nonce a front-run burnt    44,669 -> 41,245   saves 3,424'):
        "the before-and-after table for the nonce-bitmap read; the arrow is the point",
    ("contracts/src/ProveRelayer.sol",
     '*        a permit2 leg that fills              152,046 -> 153,110  costs 1,064'):
        "same table, the permit2 row",
    ("contracts/test/Mocks.sol",
     '*     The split used to read "16,482 of 69,439". Both halves are gone: `one more leg that cannot'):
        "records the split this comment used to quote, and that both halves are gone",
    ("sdk/src/decay.ts",
     "* 33,403, before the curve, the booked fee and the parked source landed; the settlement's share of"):
        "records what the ratio read before the curve and the parked source landed",
    ("app/src/landing/Costs.tsx",
     '* It has to be. This page advertised 33,381 gas for a warm allowance fill, and then 33,403, and'):
        "the page's own account of the two figures it once advertised",
    ("app/scripts/gen-gas.mjs",
     "* for that row since the repository's first commit and 105,238 today — it has never, at any"):
        "the generator's account of the number that was never measured",
    ("app/scripts/gen-gas.mjs",
     '* commit, produced 33,381 or the 33,403 that replaced it. The figures came from a spec'):
        "same account, the figure that replaced it",
    ("docs/AUDIT-SCOPE.md",
     '| `app/src/landing/gas.ts` | `app/scripts/gen-gas.mjs` | `--check`, in the contracts job | A public price claim going stale. The page once advertised 33,403 gas for a warm allowance fill against a measured 105,238, in 35 languages |'):
        "section 10's record of the landing page advertising a stale figure",

    ('contracts/test/Gas.t.sol',
     '* `test_GasReport`, and every row below that point moved — the marginal fill from 62,480 to'):
        'dated before/after of a past gas-table drift; not a current cost claim',
    ('contracts/test/Gas.t.sol',
     '* 63,168, the three-leg ring from 196,507 to 196,692. A state snapshot did not fix it, which'):
        'dated before/after of a past gas-table drift; not a current cost claim',
    ('docs/ROADMAP.md',
     'from 62,480 to 63,168, the three-leg ring from 196,507 to 196,692. A state snapshot did not fix'):
        'dated before/after of a past gas-table drift; not a current cost claim',

    ('sdk/src/solver/tolerant.ts',
     '* measured 19,355 by the time the gate went in.'):
        'what the constant had drifted to before #130 gated the row; the drift is the point',
    ('sdk/src/solver/tolerant.ts',
     '* read 52,116 here against a measured 54,688 when #130 put the row in.'):
        'what this file and the table each said when the row was gated; both numbers have moved since',
}


def die(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def table_values(text: str) -> set[int]:
    return {
        int(v)
        for pair in re.findall(r"total:\s*(\d+),\s*each:\s*(\d+)", text)
        for v in pair
    }


def retired() -> set[int]:
    """Every value the table has ever held and no longer holds."""
    if not TABLE.exists():
        die(f"{TABLE} is missing. It is generated — run `node app/scripts/gen-gas.mjs`.")
    now = table_values(TABLE.read_text())
    if not now:
        die(f"parsed no rows out of {TABLE.name}. The generator's shape changed; teach this tool.")

    # A shallow clone has no history to subtract, so `retired` would come back empty, no figure
    # would match, and every excuse below would report STALE EXCUSE at once. That is what
    # `actions/checkout@v4` does by default — depth 1 — and it is how this tool failed on its
    # first run in CI while passing on every developer machine.
    #
    # It refuses rather than answering from a truncated history. An empty answer here is
    # indistinguishable from "nothing is stale", which is the one thing a gate must never say by
    # accident.
    shallow = subprocess.run(
        ["git", "rev-parse", "--is-shallow-repository"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if shallow.stdout.strip() == "true":
        die(
            "this is a shallow clone, so the table's history is not here and nothing can be\n"
            "       called retired. In GitHub Actions, give the job `fetch-depth: 0`."
        )

    log = subprocess.run(
        ["git", "log", "-p", "--follow", "--", str(TABLE.relative_to(ROOT))],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if log.returncode != 0:
        die("could not read the table's history from git, so nothing can be called retired.")
    ever = {
        int(v)
        for pair in re.findall(r"^\+.*?total:\s*(\d+),\s*each:\s*(\d+)", log.stdout, re.M)
        for v in pair
    }
    # The public repository starts from a single snapshot commit, so its own git history holds
    # only the table as it was on that day. Everything the table held before then is frozen in
    # gas-table-history.json, read from the development history at the snapshot. Both halves are
    # unioned: the frozen file keeps every retired figure retired, and git keeps working for every
    # change made after the snapshot. Neither half alone may come back empty.
    frozen_path = Path(__file__).resolve().parent / "gas-table-history.json"
    if not frozen_path.exists():
        die(f"{frozen_path.name} is missing, so nothing from before the snapshot can be called retired.")
    frozen = {int(v) for v in json.loads(frozen_path.read_text())["values"]}
    if not frozen:
        die(f"{frozen_path.name} holds no values. It is the table's pre-snapshot history; restore it.")
    ever |= frozen
    if not ever:
        die("the table's git history parsed to no values at all. Teach this tool its old shape.")
    return ever - now


def files() -> list[Path]:
    out: list[Path] = []
    for entry in SEARCH:
        p = ROOT / entry
        if p.is_file():
            out.append(p)
            continue
        for f in p.rglob("*"):
            if not (f.is_file() and f.suffix in SUFFIXES) or "node_modules" in f.parts:
                continue
            rel = str(f.relative_to(ROOT))
            if any(d in rel for d in SKIP_DIRS) or rel in SKIP_FILES:
                continue
            out.append(f)
    return out


def main() -> None:
    gone = retired()
    findings: list[tuple[str, int, str, str]] = []
    used: set[tuple[str, str]] = set()

    for f in files():
        if f == TABLE:
            continue
        rel = str(f.relative_to(ROOT))
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(text.split("\n"), 1):
            stripped = line.strip()
            hits = [m for m in FIGURE.finditer(line) if int(m.group(1).replace(",", "")) in gone]
            if not hits:
                continue
            key = (rel, stripped)
            if key in HISTORICAL:
                used.add(key)
                continue
            findings.append((rel, n, ", ".join(m.group(1) for m in hits), stripped[:110]))

    # An excuse that outlives its line is the failure this repository has already had once, in the
    # coverage gate: the text moved and the exemption went on forgiving something else.
    stale = [k for k in HISTORICAL if k not in used]

    if stale:
        print(f"FAIL: {len(stale)} excuse(s) name a line that is no longer there:")
        for rel, text in stale:
            print(f"    {rel}  STALE EXCUSE  {text[:100]}")
        sys.exit(1)

    if findings:
        print(f"FAIL: {len(findings)} figure(s) equal a value the gas table no longer holds:")
        for rel, n, nums, line in findings:
            print(f"    {rel}:{n}  {nums}\n        {line}")
        print(
            "\n  Each is a number copied out of `app/src/landing/gas.ts` and left behind.\n"
            "  Re-read the current row and correct it — or, if the line is deliberately about\n"
            "  what a figure USED to be, add it to HISTORICAL in this file with the reason."
        )
        sys.exit(1)

    print(
        f"OK: no figure quotes a retired value. {len(gone)} retired value(s) watched, "
        f"{len(HISTORICAL)} line(s) excused as history."
    )


if __name__ == "__main__":
    main()

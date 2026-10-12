#!/usr/bin/env python3
"""
Every Slither finding has a verdict in `docs/slither-triage.md`, and this proves it.

    python3 tools/check-slither.py           # check an existing slither-report.json
    python3 tools/check-slither.py --run     # build, run Slither, then check

**A hand-maintained triage rots, and this one did.** Slither ran in no workflow, so the count
went 73 to 81 to 84 across three runs a person happened to make in six days, and the document
lagged each time. Worse, the report on disk was five days old when this gate was written: Slither
refuses to overwrite an existing `--json` target and says so in one line nobody reads, so a run
that looks fine triages the previous week. `--run` deletes the file first, for that reason.

**It counts by detector, never by line.** The triage's own header says every line number in it
moved when `ProveSettlement.sol` grew from 2,380 lines to 3,123 — the findings had not changed,
the file had. A gate keyed on lines would cry on every commit and teach people to ignore it. A
detector's count changes only when the analysis changes, which is exactly when somebody should
read the report.

So the rule is: for each detector, the counts under `## CONFIRMED`, `## MITIGATED` and
`## FALSE POSITIVE` must sum to what the report holds. A detector the report names and the
document does not is an untriaged finding. A detector the document names and the report does not
is a verdict about something that no longer happens. Both fail, and both name the detector.

This does NOT check that a verdict is correct. It checks that one exists. Judgement is the
reader's; bookkeeping is the gate's.
"""

import argparse
import collections
import json
import os
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
ROOT = HERE.parent
TRIAGE = ROOT / "docs" / "slither-triage.md"
REPORT = HERE / "slither-report.json"
OUT = "out-slither"
CACHE = "cache-slither"

VERDICTS = ("CONFIRMED", "MITIGATED", "FALSE POSITIVE")
# `## MITIGATED (60)`, or a bare `## CONFIRMED` when the count is zero.
SECTION = re.compile(r"^## (CONFIRMED|MITIGATED|FALSE POSITIVE)(?: \((\d+)\))?\s*$")
# `### calls-loop — 15`. An em dash, which is what the document uses.
DETECTOR = re.compile(r"^### ([a-z0-9-]+) — (\d+)\s*$")
# `Slither 0.9.6, solc 0.8.30, 29 contracts, 88 detectors, **84 findings**.`
HEADER = re.compile(r"Slither (\d+\.\d+\.\d+).*?\*\*(\d+) findings\*\*")


def die(message: str) -> "typing.NoReturn":  # noqa: F821
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def read_triage() -> tuple[str, int, dict[str, int]]:
    """The version the document names, the total it claims, and its per-detector counts."""
    if not TRIAGE.exists():
        die(f"{TRIAGE} is missing. It is the tracked artifact this gate compares against.")
    text = TRIAGE.read_text(encoding="utf-8")

    head = HEADER.search(text)
    if not head:
        die(
            "cannot read the triage's header line. It must name the Slither version and the\n"
            "       total, as in: Slither 0.9.6, solc 0.8.30, 29 contracts, 88 detectors,\n"
            "       **84 findings**. Rewrite the header rather than loosening this gate."
        )
    version, claimed_total = head.group(1), int(head.group(2))

    counts: dict[str, int] = collections.Counter()
    section: str | None = None
    seen: set[str] = set()
    for line in text.split("\n"):
        m = SECTION.match(line)
        if m:
            section = m.group(1)
            seen.add(section)
            continue
        m = DETECTOR.match(line)
        # A `###` before the first verdict section is prose, not a finding group.
        if m and section is not None:
            counts[m.group(1)] += int(m.group(2))

    missing = [v for v in VERDICTS if v not in seen]
    if missing:
        die(
            f"the triage has no {' and no '.join(missing)} section. All three must exist,\n"
            "       even when empty, or a whole verdict can go unrepresented and unnoticed."
        )
    if not counts:
        die("the triage names no detector. Expected headings of the form: ### calls-loop — 15")
    return version, claimed_total, dict(counts)


def read_report() -> dict[str, int]:
    if not REPORT.exists():
        die(f"{REPORT} is missing. Run this with --run, or produce it the way the triage says.")
    try:
        data = json.loads(REPORT.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        die(f"{REPORT} is not JSON: {e}")
    if not data.get("success", False):
        die(f"the Slither run itself failed: {data.get('error')!r}")
    detectors = data.get("results", {}).get("detectors")
    if detectors is None:
        die(f"{REPORT} has no results.detectors. Is it a Slither --json report?")
    return dict(collections.Counter(d["check"] for d in detectors))


# Where Slither might live, most specific first.
#
# `/usr/local/bin/python3.11` is this Mac only: Slither installs under 3.11 there while `pip3` is
# 3.12, and a bare `slither` dies naming no interpreter. That path does not exist on a CI runner,
# and **every loop over this list must survive that** — the first version of this file guarded the
# probe with `try/except OSError` and left the run loop bare, so the nightly's first execution
# died with `FileNotFoundError: /usr/local/bin/python3.11`. A candidate that cannot start is not
# an error; it is the next candidate.
INTERPRETERS = ("/usr/local/bin/python3.11", sys.executable, "python3")


def run_python(args: list[str], **kw) -> subprocess.CompletedProcess | None:
    """Run `args` under the first interpreter that starts, or None if none of them does."""
    for python in INTERPRETERS:
        try:
            return subprocess.run([python, *args], **kw)
        except (OSError, subprocess.TimeoutExpired):
            continue
    return None


def slither_version() -> str | None:
    r = run_python(["-m", "slither", "--version"], capture_output=True, text=True, timeout=120)
    if r is not None and r.returncode == 0 and r.stdout.strip():
        return r.stdout.strip().split("\n")[-1].strip()
    return None


def run_slither() -> None:
    """Build `src` alone and analyse that build. Three traps, all handled; see the triage."""
    print("cleaning, so no stale build-info and no stale report survive")
    subprocess.run(["rm", "-rf", OUT, CACHE], cwd=HERE, check=True)
    REPORT.unlink(missing_ok=True)

    print("building src only — the tests break the parser, the scripts drag in forge-std")
    build = subprocess.run(
        [
            "forge", "build", "--build-info",
            "--skip", "test/**", "--skip", "script/**",
            "--skip", "*.t.sol", "--skip", "*.s.sol",
        ],
        cwd=HERE,
        env={**os.environ, "FOUNDRY_OUT": OUT, "FOUNDRY_CACHE_PATH": CACHE},
    )
    if build.returncode != 0:
        die("the src-only build failed, so Slither has nothing to read")

    print("running Slither")
    for python in INTERPRETERS:
        try:
            r = subprocess.run(
                [
                    python, "-m", "slither", ".",
                    "--ignore-compile", "--exclude-dependencies",
                    "--filter-paths", "lib/",
                    "--foundry-out-directory", OUT,
                    "--json", str(REPORT),
                ],
                cwd=HERE,
                capture_output=True,
                text=True,
            )
        except OSError:
            # No such interpreter on this machine. Try the next one.
            continue
        # Slither exits 255 whenever it finds anything, which is every run. The report is the
        # verdict, not the exit code.
        if REPORT.exists():
            return
        if "No module named" not in r.stderr:
            sys.stderr.write(r.stderr[-4000:])
            die("Slither ran and wrote no report")
    die(
        "no interpreter here could import slither. On this Mac it lives under python3.11\n"
        "       while pip3 is python3.12, and the error names no interpreter — see the\n"
        "       triage's 'How to reproduce the run'."
    )


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--run", action="store_true", help="build and run Slither before checking")
    args = ap.parse_args()

    if args.run:
        run_slither()

    version, claimed_total, triaged = read_triage()
    found = read_report()

    problems: list[str] = []

    live = slither_version()
    if live and live != version:
        problems.append(
            f"the triage was written against Slither {version} and this is {live}.\n"
            "     A version bump changes the detector set, so re-run and re-read the report\n"
            "     rather than editing the header."
        )

    for check in sorted(set(triaged) | set(found)):
        want, have = triaged.get(check, 0), found.get(check, 0)
        if want == have:
            continue
        if want == 0:
            problems.append(f"{check}: {have} finding(s) and no verdict anywhere. Triage them.")
        elif have == 0:
            problems.append(
                f"{check}: the triage carries {want} verdict(s) and Slither now reports none.\n"
                "     Delete the section, or say in it why the finding stopped happening."
            )
        else:
            problems.append(f"{check}: the triage accounts for {want}, Slither reports {have}.")

    total = sum(found.values())
    if claimed_total != total:
        problems.append(
            f"the triage's header says {claimed_total} findings and the report holds {total}."
        )

    if problems:
        print("FAIL: the Slither triage does not match the run.\n", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        print(
            "\n  Re-run it and read the report:  python3 tools/check-slither.py --run\n"
            "  Then give every new finding a verdict in docs/slither-triage.md, under\n"
            "  CONFIRMED, MITIGATED or FALSE POSITIVE, with a reason a stranger can check.\n"
            "  A count is bookkeeping; the reason is the point.",
            file=sys.stderr,
        )
        return 1

    kinds = len(found)
    print(
        f"OK: all {total} Slither finding(s) across {kinds} detector(s) carry a verdict"
        f" ({version})."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""
`tools/run-ci.sh`, `.github/workflows/ci.yml` and `.gitlab-ci.yml` must run the same commands.

GitLab is what runs today; GitHub Actions is blocked by billing. So the runner is compared with
both files, and a step missing from either one fails the check.

The runner exists so somebody can ask the gates before pushing. It is worth nothing the moment it
drifts: a step that CI runs and the runner does not is a step that only fails after the push, which
is the state this repository was already in when the coverage gate sat red for four days behind 87
unpushed commits. So the two lists are compared, the way `abi/export.sh --check` compares the
second copy of every ABI and `gen-gas.mjs --check` compares the landing page's gas table.

It refuses what it cannot parse. A form this does not recognise stops the run with the offending
line, rather than being skipped — a gate that silently skips is how the coverage exemption in this
repository came to point at a line that had moved.

What it deliberately ignores, and why:

  `uses:` steps      `actions/checkout`, `actions/setup-node`, `foundry-rs/foundry-toolchain`.
                     They set up a runner. This machine is set up already.
  `env:` on a step   `PULSECHAIN_RPC` comes from a repository secret; locally it comes from the
                     shell or the fork tests skip themselves, which is what they are built to do.

Run it from the repository root. Exit 0 when the two agree.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CI = ROOT / ".github" / "workflows" / "ci.yml"
RUNNER = ROOT / "tools" / "run-ci.sh"
GITLAB = ROOT / ".gitlab-ci.yml"

# The GitLab jobs this checker compares. `build` is the one compile that the others share (the
# runners share one 8 GB host), so the runner's per-job `forge build` steps map to it. Every
# other job in .gitlab-ci.yml is a scheduled job, and must say so with a `rules:` on
# $CI_PIPELINE_SOURCE; the checker fails on a job that is neither.
GITLAB_JOBS = ("build", "contracts", "sdk", "app")

# Setup lines in a GitLab `script:` that are not steps. They set up the shell, as `uses:` does
# on GitHub. Matched as prefixes.
GITLAB_SETUP = ("export ", "unset ", "npm config set cache ")

# `uses:` values that are runner setup rather than a command. A `uses:` outside this set is a
# real step somebody added, and the checker stops rather than guessing what it does.
SETUP_ACTIONS = {
    "actions/checkout",
    "actions/setup-node",
    "foundry-rs/foundry-toolchain",
}

#
# Steps CI runs that the local runner deliberately does not, keyed by the exact command, with the
# reason. An entry here is a declared hole in what `.ci-local-pass` means, and declaring it is the
# whole point: the alternative is somebody discovering the gap when a push goes red.
#
# Keep this list at zero entries wherever you can. A local runner that skips a step cannot promise
# that step, and the pre-push hook's promise is only worth what the runner actually ran.
#
CI_ONLY: dict[str, str] = {}


def die(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def parse_ci() -> list[tuple[str, str, str]]:
    """Every `run:` step in ci.yml, as (job, working directory, command)."""
    lines = CI.read_text().splitlines()
    steps: list[tuple[str, str, str]] = []

    job = None
    in_jobs = False
    in_steps = False
    # The step being read: its `run:` and its `working-directory:`.
    run: str | None = None
    workdir: str | None = None
    uses: str | None = None
    # True while inside a `with:` or `env:` mapping, whose keys are not step keys.
    in_submap = False

    def close_step() -> None:
        nonlocal run, workdir, uses, in_submap
        if run is not None:
            steps.append((job, workdir or ".", run))
        elif uses is not None:
            action = uses.split("@")[0]
            if action not in SETUP_ACTIONS:
                die(
                    f"{CI.name}: step `uses: {uses}` is not a setup action this checker knows.\n"
                    "       Add it to SETUP_ACTIONS if it sets up a runner, or teach the checker\n"
                    "       what it runs. Do not leave it unclassified."
                )
        run = workdir = uses = None
        in_submap = False

    for n, raw in enumerate(lines, 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        line = raw.strip()

        if indent == 0:
            if line == "jobs:":
                in_jobs = True
            elif in_jobs:
                die(f"{CI.name}:{n}: a top-level key after `jobs:` — {line!r}")
            continue

        if not in_jobs:
            continue

        if indent == 2:
            close_step()
            if not line.endswith(":"):
                die(f"{CI.name}:{n}: expected a job name — {line!r}")
            job = line[:-1]
            in_steps = False
            continue

        if indent == 4:
            close_step()
            if line == "steps:":
                in_steps = True
            elif re.fullmatch(r"[\w-]+:.*", line):
                in_steps = False
            else:
                die(f"{CI.name}:{n}: unrecognised job key — {line!r}")
            continue

        if not in_steps:
            continue

        if indent == 6 and line.startswith("- "):
            close_step()
            line = line[2:]
            indent = 8  # fall through and read it as the step's first key

        if indent == 8:
            in_submap = False
            m = re.fullmatch(r"([\w-]+):\s*(.*)", line)
            if not m:
                die(f"{CI.name}:{n}: unrecognised step line — {line!r}")
            key, value = m.group(1), m.group(2).strip()
            if key == "run":
                if not value:
                    die(
                        f"{CI.name}:{n}: `run:` with a block scalar. This checker reads one-line\n"
                        "       commands only. Either write it on one line or teach the checker."
                    )
                run = value
            elif key == "working-directory":
                workdir = value
            elif key == "uses":
                uses = value
            elif key in ("name", "id", "if"):
                pass
            elif key in ("with", "env"):
                in_submap = True
            else:
                die(f"{CI.name}:{n}: unrecognised step key `{key}:`")
            continue

        if indent >= 10 and in_submap:
            continue

        die(f"{CI.name}:{n}: unrecognised line at indent {indent} — {line!r}")

    close_step()
    return steps


def _gitlab_scalar(value: str, n: int) -> str:
    """One YAML flow scalar: plain, or single-quoted. Anything else stops the check."""
    if value.startswith("'"):
        if not value.endswith("'") or len(value) < 2:
            die(f"{GITLAB.name}:{n}: an unterminated quoted script line")
        return value[1:-1].replace("''", "'")
    if value.startswith(('"', "|", ">", "*", "&", "[", "{")):
        die(f"{GITLAB.name}:{n}: a script line in a form this checker does not read — {value!r}")
    return value


def _split_gitlab_line(line: str, cwd: str, n: int) -> tuple[list[tuple[str, str]], str]:
    """
    One `script:` line as (working directory, command) pairs, and the directory after it.

    Three forms: `cd DIR` alone moves the job; `cd DIR && a && b` moves it and runs a, b there;
    `(cd DIR && a && b)` runs a, b in DIR and leaves the job where it was.
    """
    import os.path

    sub = line.startswith("(") and line.endswith(")")
    body = line[1:-1] if sub else line
    parts = [p.strip() for p in body.split(" && ")]
    here = cwd
    out: list[tuple[str, str]] = []
    for part in parts:
        if part.startswith("cd "):
            here = os.path.normpath(os.path.join(here, part[3:].strip()))
        elif part.startswith(GITLAB_SETUP):
            continue
        elif "&&" in part or "||" in part or part.startswith(("(", "cd")):
            die(f"{GITLAB.name}:{n}: a compound command this checker does not read — {line!r}")
        else:
            out.append((here, part))
    return out, (cwd if sub else here)


def parse_gitlab() -> list[tuple[str, str, str]]:
    """Every `script:` line of the compared GitLab jobs, as (job, working directory, command)."""
    lines = GITLAB.read_text().splitlines()
    steps: list[tuple[str, str, str]] = []
    job: str | None = None
    in_script = False
    scheduled: set[str] = set()
    seen: set[str] = set()
    for n, raw in enumerate(lines, 1):
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        indent = len(raw) - len(raw.lstrip())
        line = raw.strip()
        if indent == 0:
            m = re.fullmatch(r"([\w.-]+):.*", line)
            job = m.group(1) if m else None
            if job:
                seen.add(job)
            in_script = False
            cwd = "."
            continue
        if indent == 2:
            in_script = line == "script:" and job in GITLAB_JOBS
            continue
        if job and re.search(r"\$CI_PIPELINE_SOURCE == \"schedule\"", line):
            scheduled.add(job)
        if in_script and indent == 4 and line.startswith("- "):
            pairs, cwd = _split_gitlab_line(_gitlab_scalar(line[2:].strip(), n), cwd, n)
            steps.extend((job, d, c) for d, c in pairs)
    missing = [j for j in GITLAB_JOBS if j not in seen]
    if missing:
        die(f"{GITLAB.name}: no job named {', '.join(missing)}")
    known = set(GITLAB_JOBS) | {"default", "workflow", "stages", "variables", "include"}
    stray = sorted(j for j in seen if j not in known and not j.startswith(".") and j not in scheduled)
    if stray:
        die(
            f"{GITLAB.name}: job(s) {', '.join(stray)} run on every pipeline but are not in\n"
            "       run-ci.sh. Add them to GITLAB_JOBS and the runner, or give them a schedule rule."
        )
    return steps


def compare_gitlab(runner: list[tuple[str, str, str]]) -> int:
    """The runner against .gitlab-ci.yml. Returns the number of steps compared."""
    gl = parse_gitlab()
    build = [s for s in gl if s[0] == "build"]
    if build != [("build", "contracts", "forge build")]:
        die(f"{GITLAB.name}: the build job must run exactly `forge build` in contracts, got {build}")
    # The runner compiles once per job; GitLab compiles once, in `build`, for all of them.
    want = [s for s in runner if not (s[1] == "contracts" and s[2] == "forge build")]
    got = [s for s in gl if s[0] != "build"]
    only_gl = [s for s in got if s not in want]
    only_runner = [s for s in want if s not in got]
    if only_gl or only_runner:
        for job, workdir, cmd in only_gl:
            print(f"  in .gitlab-ci.yml, missing from run-ci.sh:  [{job}] (in {workdir}) {cmd}")
        for job, workdir, cmd in only_runner:
            print(f"  in run-ci.sh, missing from .gitlab-ci.yml:  [{job}] (in {workdir}) {cmd}")
        die(f"{len(only_gl) + len(only_runner)} step(s) differ between run-ci.sh and .gitlab-ci.yml.")
    if len(got) != len(want):
        die(f"same steps, different counts: .gitlab-ci.yml {len(got)}, run-ci.sh {len(want)}")
    return len(gl)


def parse_runner() -> list[tuple[str, str, str]]:
    """Every entry of the STEPS array in run-ci.sh, as (job, working directory, command)."""
    text = RUNNER.read_text()
    m = re.search(r"^STEPS=\((.*?)^\)$", text, re.S | re.M)
    if not m:
        die("tools/run-ci.sh: no `STEPS=( … )` array found")
    steps: list[tuple[str, str, str]] = []
    for n, raw in enumerate(m.group(1).splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        entry = re.fullmatch(r'"([^"|]+)\|([^|]+)\|(.+)"', line)
        if not entry:
            die(f"tools/run-ci.sh: unrecognised STEPS entry — {line!r}")
        steps.append((entry.group(1), entry.group(2), entry.group(3)))
    return steps


def main() -> None:
    ci = parse_ci()
    runner = parse_runner()

    # The parity checker runs itself, and ci.yml is where that step is declared. Nothing else
    # about it is special.
    # A CI-only step must be in ci.yml and must NOT be in the runner. Both halves are checked,
    # so an exemption cannot outlive the step it exempts, and cannot quietly forgive a second one.
    exempt = [s for s in ci if s[2] in CI_ONLY]
    stale_exemptions = [c for c in CI_ONLY if c not in {s[2] for s in ci}]
    wrongly_run = [s for s in runner if s[2] in CI_ONLY]

    if stale_exemptions:
        for cmd in stale_exemptions:
            print(f"  CI_ONLY exempts a step ci.yml no longer has:  {cmd}")
        die(
            "a stale exemption forgives nothing and hides the next one. "
            "Delete the entry, or put the step back."
        )
    if wrongly_run:
        for job, workdir, cmd in wrongly_run:
            print(f"  CI_ONLY says the runner skips this, and it does not:  [{job}] {cmd}")
        die("an exemption that is not taken is a comment pretending to be a rule.")

    only_ci = [s for s in ci if s not in runner and s not in exempt]
    only_runner = [s for s in runner if s not in ci]

    if only_ci or only_runner:
        for job, workdir, cmd in only_ci:
            print(f"  in ci.yml, missing from run-ci.sh:  [{job}] (in {workdir}) {cmd}")
        for job, workdir, cmd in only_runner:
            print(f"  in run-ci.sh, missing from ci.yml:  [{job}] (in {workdir}) {cmd}")
        die(
            f"{len(only_ci) + len(only_runner)} step(s) differ. A runner that does not run what CI\n"
            "       runs is a runner that says green about a build nobody checked."
        )

    # The runner carries every step but the declared exemptions, and exactly that many.
    if len(ci) - len(exempt) != len(runner):
        die(
            f"same steps, different counts: ci.yml {len(ci)} less {len(exempt)} exempt, "
            f"run-ci.sh {len(runner)}"
        )

    note = f", {len(exempt)} of them CI-only by declaration" if exempt else ""
    print(f"OK: {len(ci)} step(s), and ci.yml and tools/run-ci.sh agree on every one{note}.")
    gl = compare_gitlab(runner)
    print(f"OK: {gl} step(s), and .gitlab-ci.yml and tools/run-ci.sh agree on every one.")


if __name__ == "__main__":
    main()

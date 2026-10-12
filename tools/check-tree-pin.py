#!/usr/bin/env python3
"""
The audit pack must pin the `contracts/src` tree that exists.

    python3 tools/check-tree-pin.py

`docs/AUDIT-SCOPE.md` and `docs/AUDIT-READINESS.md` each name the audited source tree by git
object id, and both say in their own words what that buys the reader: the hash names content
rather than a moment, so it moves when the audited code moves and at no other time. A reader runs
`git rev-parse HEAD:contracts/src`, compares, and knows whether the pack in front of them
describes the code in front of them.

Nothing asked that question. The pin went stale four times, and the fourth time it also went
self-contradictory: `AUDIT-SCOPE.md`'s opening carried `ee4bcd27`, the tree at `8efa7d2`, beside a
sentence naming `7f74fd4`, whose tree is `02589045` — and `02589045` is what the section 3 table
and `AUDIT-READINESS.md` kept. One document stated two different trees for five commits. Every
gate stayed green through all of it, `check-citations.py` included, because a citation that points
at a real line can sit in a sentence that is false, and no gate in this repository read a tree
hash. A person found it by reading two documents side by side. This is the gate that reads it.

**Every site is checked, not one per document.** The disagreement above was between two sentences
in the same file, so a checker that reads the opening and stops would have called that document
correct on the day it contradicted itself.

**The sites, and the words that find them.** Each one is matched twice: once by a marker phrase
that carries no hash, and once by the same phrase with the hash. The two counts must agree, and
both must equal the number declared here. A pin somebody reworded so the hash no longer parses
therefore fails loudly rather than passing as zero sites found — a gate that silently skips is how
this repository shipped a coverage exemption pointing at a line that had moved.

**The honest weakness.** A pin written in brand-new words, in a place this file does not name, is
not seen. There is no sound way to tell one from the prose around it: both documents quote retired
hashes on purpose, in errata rows and in the history of the pin itself, and a checker that grabbed
every hex id would fail on the record of its own past failures. So the sites are declared. Add one
here when you add one there.

Run it from anywhere. Exit 0 when every pin names the tree `git rev-parse HEAD:contracts/src`
prints.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# A git object id as these documents write it: the full 40 characters in the opening of each
# document and in the diff command, abbreviated to 8 in the section 3 table.
HASH = r"[0-9a-f]{7,40}"

#
# Every place the pack pins the audited tree, as (document, what to call it, marker, pattern).
#
# `marker` finds the site without reading a hash. `pattern` is the same phrase with the hash
# captured. Both are counted, both counts must equal `expect`, and every captured hash must be the
# tree that exists.
#
PIN_SITES = [
    (
        "docs/AUDIT-SCOPE.md",
        "the scope sentence",
        r"The audited code is the `contracts/src` tree whose git object id is",
        r"The audited code is the `contracts/src` tree whose git object id is\s+`(" + HASH + r")`",
        1,
    ),
    (
        "docs/AUDIT-SCOPE.md",
        "the diff command a reader runs when the pin disagrees",
        r"git diff --stat [^\n]*HEAD:contracts/src",
        r"git diff --stat\s+(" + HASH + r")\s+HEAD:contracts/src",
        1,
    ),
    (
        "docs/AUDIT-SCOPE.md",
        "the section 3 table row",
        r"the tree this document pins",
        r"Object id `(" + HASH + r")`, the tree this document pins",
        1,
    ),
    (
        "docs/AUDIT-READINESS.md",
        "the tree under audit",
        r"\*\*The tree under audit\*\* is `contracts/src`, git object id",
        r"\*\*The tree under audit\*\* is `contracts/src`, git object id\s+`(" + HASH + r")`",
        1,
    ),
]


def die(message: str) -> None:
    print(f"FAIL: {message}", file=sys.stderr)
    sys.exit(1)


def audited_tree() -> str:
    """The `contracts/src` tree at HEAD — the thing every pin is a claim about."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD:contracts/src"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError) as error:
        stderr = getattr(error, "stderr", "") or ""
        die(
            "`git rev-parse HEAD:contracts/src` did not answer, so this gate can promise\n"
            f"       nothing about the pack's tree pin. {stderr.strip()}"
        )
    return result.stdout.strip()


def line_of(text: str, offset: int) -> int:
    """The 1-based line the match at `offset` sits on, so a failure names a place to edit."""
    return text.count("\n", 0, offset) + 1


def read(doc: str) -> str:
    path = ROOT / doc
    if not path.exists():
        die(f"{doc} is missing, so this gate can promise nothing about the pack's tree pin.")
    return path.read_text()


def main() -> None:
    tree = audited_tree()
    sources = {doc: read(doc) for doc, *_ in PIN_SITES}

    failures = []
    checked = 0

    for doc, name, marker, pattern, expect in PIN_SITES:
        text = sources[doc]
        markers = list(re.finditer(marker, text))
        pins = list(re.finditer(pattern, text))

        if len(markers) != expect:
            die(
                f"{doc}: expected {expect} pin site(s) matching {name}, found {len(markers)}.\n"
                "       Somebody moved, copied or reworded the pin. Teach this checker where it\n"
                "       lives now — an unread pin is the state this gate exists to end."
            )
        if len(pins) != len(markers):
            die(
                f"{doc}: {name} is there, and no git object id parses out of it.\n"
                "       A pin this gate cannot read is a pin nobody is checking. Restore the\n"
                "       hash beside it, or teach this checker the new form."
            )

        for pin in pins:
            checked += 1
            named = pin.group(1)
            if not tree.startswith(named):
                failures.append((doc, line_of(text, pin.start()), name, named))

    if failures:
        for doc, line, name, named in failures:
            print(
                f"  {doc}:{line} ({name}) pins {named}, "
                f"and `git rev-parse HEAD:contracts/src` prints {tree[:len(named)]}"
            )
        die(
            f"{len(failures)} of {checked} tree pin(s) name a tree that is not the one in this\n"
            f"       checkout. `contracts/src` is {tree}. The pack therefore describes code the\n"
            "       reader does not have: every line count, every line-number citation and every\n"
            "       finding in it was measured against a tree that has moved. Re-pin each site\n"
            "       above and re-derive the numbers beside it, or check out the tree it names."
        )

    print(f"OK: all {checked} tree pin(s) in the audit pack name {tree[:8]}, the tree at HEAD.")


if __name__ == "__main__":
    main()

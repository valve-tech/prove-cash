#!/usr/bin/env python3
"""
A hash of everything under `contracts/src/`, so a later run can prove nothing moved.

`prove-yul-runs.py` breaks each `assembly` block on purpose to prove the suite notices. It does
that in a throwaway git worktree, so this checkout never sees a broken contract — and the step
after it exists to prove that held, because if a future change ever reached back into `src/`,
every step after it would be measuring a tree nobody wrote.

That check used to be `git diff --exit-code src/`, which asks a different question: it compares
the working tree with the last commit. In CI, on a fresh checkout, the two questions have the
same answer. On a developer's machine they do not — anyone with uncommitted contract work fails
it every time, and `tools/run-ci.sh` could never go green while somebody was writing a contract.
A gate that cannot pass during the work it guards is a gate people learn to skip.

So the question is asked directly: fingerprint the sources before, compare after.

    python3 tools/src-fingerprint.py            # write the fingerprint
    python3 tools/src-fingerprint.py --compare  # fail unless it still matches

The fingerprint lands in `contracts/.src-fingerprint`, which is gitignored: it describes one
machine's run and means nothing to another.
"""

import hashlib
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SRC = HERE / "src"
STORE = HERE / ".src-fingerprint"


def fingerprint() -> str:
    h = hashlib.sha256()
    files = sorted(p for p in SRC.rglob("*") if p.is_file())
    if not files:
        print(f"FAIL: no files under {SRC}", file=sys.stderr)
        sys.exit(1)
    for p in files:
        # The path goes in as well as the bytes, so a rename is a change.
        h.update(str(p.relative_to(SRC)).encode())
        h.update(b"\0")
        h.update(p.read_bytes())
    return h.hexdigest()


def main() -> None:
    now = fingerprint()
    if "--compare" not in sys.argv:
        STORE.write_text(now + "\n")
        print(f"OK: fingerprinted {SRC.name}/ at {now[:12]}")
        return

    if not STORE.exists():
        print(
            "FAIL: no fingerprint to compare against. Run this without --compare first,\n"
            "       before the step that could disturb the sources.",
            file=sys.stderr,
        )
        sys.exit(1)
    before = STORE.read_text().strip()
    if before != now:
        print(
            f"FAIL: contracts/src/ changed during the run.\n"
            f"       before {before[:12]}, now {now[:12]}.\n"
            "       Something reached back into the checkout. Every measurement taken after\n"
            "       that point describes a tree nobody wrote.",
            file=sys.stderr,
        )
        sys.exit(1)
    print(f"OK: contracts/src/ is byte for byte as it was, at {now[:12]}")


if __name__ == "__main__":
    main()

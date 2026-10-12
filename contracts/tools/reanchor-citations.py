#!/usr/bin/env python3
"""
Move every citation a reformat displaced, by asking `check-citations.py` which ones broke.

`forge fmt` moved 87 of 500 citations in one run. Re-anchoring those by hand is an afternoon and
gets several wrong, so nobody formats, and `forge fmt --check` sat red on 43 files for weeks.
This is what makes formatting cheap again.

    cp -R contracts/src contracts/test contracts/script /tmp/before   # snapshot FIRST
    cd contracts && forge fmt
    python3 tools/reanchor-citations.py /tmp/before

    python3 tools/reanchor-citations.py            # no snapshot: compare against HEAD

Without a snapshot it maps every cited file against its committed version, which is what you want
after editing a document rather than reformatting a source. Documents cite each other by line too,
so a paragraph added to `ROADMAP.md` breaks references in three other files, and it does it every
single time.

**Tokens, not lines, and that is the whole trick.** A line map is the obvious tool and it is the
wrong one: the formatter's job is moving text across line boundaries, so a statement it rewrapped
has no line to map to, and a positional map sends the citation to the start of the run where the
gate refuses it again. Tokens survive the move — `forge fmt` changes whitespace and line breaks
and nothing else — so this diffs each file as a stream of whitespace-separated tokens, each
remembering its line, and answers where the first token of old line N ended up.

**It asks the gate rather than parsing the documents.** Most citations are written bare, as
`` `:3010` ``, with the file taken from a backtick term earlier in the same sentence. A regex over
`path:line` sees a minority of them. `check-citations.py` is the only thing that knows how the
rest resolve, so this reads its failures, patches those exact numbers, and runs it again until it
stops improving. What is left it prints, and those need a person: usually a citation that pointed
at a neighbouring line and passed by luck, which is worth re-aiming by hand at the line the
sentence is actually about.
"""

import difflib
import io
import re
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
ROOT = HERE.parent
MAX_SWEEPS = 8


def tokens(path: Path) -> list[tuple[str, int]]:
    """Every whitespace-separated token, with the 1-based line it sits on."""
    out: list[tuple[str, int]] = []
    for n, line in enumerate(io.open(path, encoding="utf-8").read().split("\n"), 1):
        for tok in line.split():
            out.append((tok, n))
    return out


def line_map(old_path: Path, new_path: Path) -> dict[int, int]:
    """Old line to new line, from the first token of each old line that still matches."""
    old, new = tokens(old_path), tokens(new_path)
    out: dict[int, int] = {}
    matcher = difflib.SequenceMatcher(
        None, [t for t, _ in old], [t for t, _ in new], autojunk=False
    )
    for tag, i1, i2, j1, _j2 in matcher.get_opcodes():
        if tag != "equal":
            continue
        for k in range(i2 - i1):
            out.setdefault(old[i1 + k][1], new[j1 + k][1])
    return out


FAILURE = re.compile(r"^\s{4}(\S+?):(\d+)\s+cites\s+(\S+?):(\d+)(?:-(\d+))?\s+—")


def failures() -> list[tuple[str, int, str, int, int | None]]:
    r = subprocess.run(
        [sys.executable, "tools/check-citations.py"],
        cwd=HERE,
        capture_output=True,
        text=True,
    )
    out = []
    for line in (r.stdout + r.stderr).split("\n"):
        m = FAILURE.match(line)
        if m:
            out.append(
                (
                    m.group(1),
                    int(m.group(2)),
                    m.group(3),
                    int(m.group(4)),
                    int(m.group(5)) if m.group(5) else None,
                )
            )
    return out


def rewrite(doc_line: str, old: str, new: str) -> tuple[str, bool]:
    """Swap one citation's number, and only inside a citation.

    A document line often carries a year, a gas figure or a percentage as well. Each candidate
    below is a character a citation actually ends on, so a bare number elsewhere on the line is
    left alone.
    """
    for tail in ("`", " ", ",", ".", ")"):
        needle = f":{old}{tail}"
        if needle in doc_line:
            return doc_line.replace(needle, f":{new}{tail}", 1), True
    if doc_line.rstrip().endswith(f":{old}"):
        return doc_line.rstrip()[: -len(old)] + new, True
    return doc_line, False


def committed(rel: str) -> Path | None:
    """`rel` as HEAD has it, written to a temporary file, or None if HEAD does not carry it."""
    r = subprocess.run(
        ["git", "show", f"HEAD:{rel}"], cwd=ROOT, capture_output=True, text=True
    )
    if r.returncode != 0:
        return None
    tmp = Path(tempfile.mkstemp(suffix=Path(rel).suffix)[1])
    io.open(tmp, "w", encoding="utf-8").write(r.stdout)
    return tmp


def main() -> int:
    if len(sys.argv) > 2:
        print(__doc__.strip().split("\n\n")[1], file=sys.stderr)
        return 2
    snapshot = Path(sys.argv[1]) if len(sys.argv) == 2 else None
    if snapshot is not None and not snapshot.is_dir():
        print(f"FAIL: {snapshot} is not a directory. Snapshot BEFORE you format.", file=sys.stderr)
        return 2

    maps: dict[str, dict[int, int]] = {}
    if snapshot is not None:
        for old_file in sorted(snapshot.rglob("*.sol")):
            new_file = HERE / old_file.relative_to(snapshot)
            if new_file.exists():
                maps[f"contracts/{old_file.relative_to(snapshot).as_posix()}"] = line_map(
                    old_file, new_file
                )
        if not maps:
            print(f"FAIL: no .sol file under {snapshot} matches one under {HERE}", file=sys.stderr)
            return 2

    previous: int | None = None
    for sweep in range(1, MAX_SWEEPS + 1):
        stale = failures()
        if not stale:
            print(f"OK: the citation gate is green after {sweep - 1} sweep(s).")
            return 0
        if previous is not None and len(stale) >= previous:
            print(f"{len(stale)} citation(s) left, and no longer improving. These need a person:")
            for doc, dline, path, a, b in stale:
                span = f"{a}-{b}" if b else str(a)
                print(f"    {doc}:{dline} cites {path}:{span}")
            print("\n  Read the sentence, find what it is about, and point it there. A citation")
            print("  that broke here usually pointed at a neighbouring line and passed by luck.")
            return 1
        previous = len(stale)

        by_doc: dict[str, list] = {}
        for f in stale:
            by_doc.setdefault(f[0], []).append(f)

        edits = 0
        for doc, items in by_doc.items():
            path = ROOT / doc
            lines = io.open(path, encoding="utf-8").read().split("\n")
            for _doc, dline, cited, a, b in items:
                if cited not in maps:
                    # Not in the snapshot: a document, or a source the caller did not copy. Map it
                    # against HEAD instead, which is the right baseline for an edit rather than a
                    # reformat. A file HEAD does not carry maps to nothing and is left alone.
                    before = committed(cited)
                    after = ROOT / cited
                    maps[cited] = (
                        line_map(before, after) if before and after.exists() else {}
                    )
                table = maps[cited]
                if a not in table:
                    continue
                na = table[a]
                nb = max(table.get(b, na), na) if b else None
                old_txt = f"{a}-{b}" if b else str(a)
                new_txt = f"{na}-{nb}" if b else str(na)
                if old_txt == new_txt:
                    continue
                lines[dline - 1], done = rewrite(lines[dline - 1], old_txt, new_txt)
                edits += done
            io.open(path, "w", encoding="utf-8").write("\n".join(lines))
        print(f"sweep {sweep}: {len(stale)} stale, {edits} re-anchored")

    print(f"FAIL: still not green after {MAX_SWEEPS} sweeps.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())

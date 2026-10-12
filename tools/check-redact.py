#!/usr/bin/env python3
"""
Refuse an error logged without `redact()`.

The one incident this project had (2026-08-18) was a credential leaking into journald
because an error was logged without `redact()`. The library exists in `app/scripts/rpc.ts`
and is tested. Nothing enforced its use — RS.MI-02.

This gate finds every `} catch (e)` and `.catch(e =>` in `app/scripts/**/*.ts` and fails
when one logs the caught error without passing it through `redact()` or `describe()`,
or a function that wraps one of them.

A catch block is clean when the error variable reaches a log call only through `redact`,
`describe`, or a function known to call one of them. It is dirty when the raw error, or a
field pulled off it (`e.message`, `e.shortMessage`), reaches `console.error`, `console.log`,
`log`, or `process.stderr.write` without that pass.

Run it from the repository root. Exit 0 when every catch is clean.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "app" / "scripts"

# Functions that scrub a credential on the way out. `describe` walks the cause chain and
# calls `redact`; `why` and `batchReason` are aliases the scripts import it under.
# `revertData` pulls the hex revert bytes out of a viem error — not a string the key can
# hide in — so a log line that names only its output is clean.
SAFE = {"redact", "describe", "why", "batchReason", "revertData"}

# Lines that count as a log call. `log` is `console.log` wrapped in `e2e/common.ts`, used
# across the scripts and the lab.
LOG = re.compile(r"(console\.(error|log)|process\.stderr\.write|(^|[^.\w])log)\s*\(")


def find_catch_blocks(text: str) -> list[tuple[int, str, str]]:
    """Every catch block: (line number, error variable, block text).

    Reads both `} catch (e) {` blocks and `.catch((e) =>` arrows, and returns the lines
    inside the block so the caller can look for a log call that names the error.
    """
    lines = text.splitlines()
    blocks: list[tuple[int, str, str]] = []

    for i, line in enumerate(lines):
        m = re.search(r"catch\s*\(\s*(\w+)\s*\)", line)
        if not m:
            continue
        errvar = m.group(1)
        # Walk to the end of the brace block. Start counting braces after the catch
        # match, not from the start of the line — a `} catch (e) {` line has a closing
        # brace before `catch` that closes the `try`, not this block.
        depth = 0
        started = False
        block_lines: list[str] = []
        for j in range(i, min(i + 30, len(lines))):
            segment = lines[j][m.end():] if j == i else lines[j]
            for ch in segment:
                if ch == "{":
                    depth += 1
                    started = True
                elif ch == "}":
                    depth -= 1
            block_lines.append(lines[j])
            if started and depth == 0:
                break
        blocks.append((i + 1, errvar, "\n".join(block_lines)))

    return blocks


def check_file(path: Path) -> list[str]:
    """Return a list of violations: one string per dirty catch block."""
    text = path.read_text()
    violations: list[str] = []
    rel = path.relative_to(ROOT)

    for lineno, errvar, block in find_catch_blocks(text):
        block_lines = block.split("\n")
        # Track which variables are tainted (carry the error's text) and which are clean
        # (went through a SAFE function). `const m = e as ...` taints `m`; `const data =
        # revertData(e)` does not, because `revertData` returns hex bytes, not a message.
        tainted: set[str] = {errvar}
        clean: set[str] = set()
        changed = True
        while changed:
            changed = False
            for bl in block_lines:
                for t in list(tainted):
                    # `const m = e as ...`, `let m = e ...` — `m` carries the error.
                    am = re.search(
                        rf"(?:const|let|var)\s+(\w+)\s*=\s*.*\b{re.escape(t)}\b",
                        bl,
                    )
                    if am:
                        name = am.group(1)
                        if name in clean:
                            continue
                        # Clean if the assignment line calls a SAFE function — e.g.
                        # `const data = revertData(e)` — because the function's output is
                        # not a string the key can hide in.
                        if any(re.search(rf"{re.escape(fn)}\s*\(", bl) for fn in SAFE):
                            clean.add(name)
                        elif name not in tainted:
                            tainted.add(name)
                            changed = True
                    # `for (const line of <tainted>...)` — `line` carries the error's text.
                    fm = re.search(
                        rf"for\s*\(\s*(?:const|let|var)\s+(\w+)\s+of\s+.*\b{re.escape(t)}\b",
                        bl,
                    )
                    if fm and fm.group(1) not in tainted and fm.group(1) not in clean:
                        tainted.add(fm.group(1))
                        changed = True

        for j, bl in enumerate(block_lines):
            if not LOG.search(bl):
                continue
            # A log line is dirty if it names a tainted variable and no SAFE function
            # scrubs the line itself.
            refs = [t for t in tainted if re.search(rf"\b{re.escape(t)}\b", bl)]
            if not refs:
                continue
            if any(re.search(rf"{re.escape(fn)}\s*\(", bl) for fn in SAFE):
                continue
            violations.append(
                f"{rel}:{lineno + j}: logs `{errvar}` without redact/describe:\n  {bl.strip()}"
            )

    return violations


def main() -> None:
    if not SCRIPTS.is_dir():
        print(f"FAIL: {SCRIPTS} does not exist", file=sys.stderr)
        sys.exit(1)

    all_violations: list[str] = []
    for path in sorted(SCRIPTS.rglob("*.ts")):
        all_violations.extend(check_file(path))

    if all_violations:
        for v in all_violations:
            print(v)
        print()
        print(f"FAIL: {len(all_violations)} catch block(s) log an error without redact() or describe().")
        print("       The one incident this project had was a credential in a journal line,")
        print("       and this is the route it took. Pass the error through redact() or describe().")
        sys.exit(1)

    print("OK: every catch block in app/scripts/ passes its error through redact() or describe().")


if __name__ == "__main__":
    main()

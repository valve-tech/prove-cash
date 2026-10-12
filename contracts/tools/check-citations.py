#!/usr/bin/env python3
"""Fail the build when a documented line-number citation no longer points at what it claims.

    python3 tools/check-citations.py

`docs/FEE-MODEL.md` and `docs/AUDIT-SCOPE.md` both say, in their own words, that the code is the
authority and the document is wrong when the two disagree. Neither file enforced that promise.
Twice in two days a citation drifted silently: `AUDIT-SCOPE.md` carried roughly 130 stale line
numbers, two of them off by one since the commit that introduced them, and a day after
`FEE-MODEL.md` was fully re-anchored, two contract commits had moved every one of its 21 numbers
again. A citation is a claim. An unchecked claim rots, and these documents are handed to an
auditor — the worst possible reader of a wrong line number.

**What counts as a citation, and the forms this tool knows.** Both files write the same idea four
ways:

    (line 962)                                  -- a bare "line N" or "lines N-M", no file
    `_quote`, line 962                           -- the same, inside a table cell
    uint256 gross = ...;   // line 960           -- a trailing comment on a fenced code line
    `ProveSettlement.sol:826`                    -- a file and a line together
    `:996`                                       -- a bare `:N`, meaning the last file named

The bare forms carry no file of their own, and resolving one tries three things, in order. First,
a file-shaped backtick term on the *same document line* — `AUDIT-SCOPE.md` uses this to point
`` `:172` `` at `docs/FEE-MODEL.md` from inside a sentence that names it a few words earlier.
Second, a candidate naming term (see below) that is declared — as a Solidity `function` or
`modifier` — in exactly one known contract; a name that specific settles which contract a table
row means even when the row before it asided into a different one. Third, and last, the most
recent contract file actually *cited* earlier in the document — a bare mention with no line number
of its own (or, once, a document-opening "`` `path.sol` `` is the authority") can still set this,
but a citation into `app/` or `sdk/` never lingers past its own line, because this repo's habit is
to spell out that kind of file in full every time rather than lean on a bare continuation. Get the
file resolution wrong and every check downstream is answering a question nobody asked, so each
step only runs when the one before it found nothing, rather than the three blending into a guess.

**A form this tool does not recognise is a hard failure, not a skip.** `app/scripts/check-
addresses.ts` already learned this lesson: a gate that quietly ignores a shape it cannot parse is
how this repo shipped a coverage exemption pointing at a line that had moved, and nobody noticed
because the gate never looked. Before trusting its own count of citations, this tool re-scans both
files for anything that merely *looks* like a citation — the word "line" near a digit, or a
backtick colon-number — and refuses to run if it finds one none of the four forms above claimed.

**A document that cites nothing is told apart from a document whose citations hold.** The two used
to print the same shape of line, and they state opposite facts: `0 citation(s), 0 stale` beside
`324 citation(s), 0 stale` reads like the quieter of two passes. `docs/AUDIT-READINESS.md` printed
that zero on every run since it joined the list above. It argues from commands and from whole
files, never from a line number, so this gate has never checked one word of it — and the audit
pack's tree pin sat stale inside that same file for five commits, self-contradictory for part of
them, while this gate stayed green over every one. A document that makes no line claims is
therefore declared in `NO_LINE_CITATION_DOCS` and printed as unchecked, in that word. A document
that is *not* declared and yields nothing fails instead: a rename, an emptied file, or a pattern
that stopped matching all produce a count of zero, and zero is the cheapest possible green. The
declaration buys no silence either. The unknown-form scan above still runs over a declared
document, so a citation written in a shape nobody taught this tool stops the build rather than
counting as none of them.

**How a citation is checked.** The sentence around a citation almost always names, in backticks,
the thing that is supposedly at that line: a function, a variable, a JSON key, a constant. This
tool collects every backtick term near the citation, splits each into identifier-shaped words, and
asks whether *any* of them appears — underscores aside, so `invariant_Foo` still answers for a doc
that just says `` `Foo` `` — on the cited source line, or anywhere in the cited range for a `N-M`
citation. "Near" means the citation's own row inside a markdown table, where each row is one
physical line and usually names its own thing; outside a table it means the whole paragraph,
because this document hard-wraps prose at roughly eighty columns and routinely opens a citation on
the line *after* the one carrying its naming term. A function-shaped candidate gets one more
chance before it fails: if the literal word is not on the cited line, but the cited line sits
inside that named function's body, the citation still holds — "`_quote`, lines 960-961" is not
claiming the word `_quote` sits on those lines, only that they belong to it.

**The honest weakness.** "At least one candidate word matches, somewhere in the paragraph" is a
cheap, generous test on purpose — the alternative is guessing which of several backticked terms in
a busy paragraph the citation actually means, and a wrong guess there is worse than a loose check.
It has two real blind spots. A paragraph carrying several citations for several different things
shares its whole candidate pool across all of them, so a citation could in principle be confirmed
by a neighbour's word rather than its own. And a short, common candidate word ("to", "ok") can
appear on almost any line by accident, so a citation can still point at the wrong line inside the
right function and pass. Neither failure mode invents a citation that is not there; both only risk
letting a wrong number through. A person still has to read the surrounding prose when this tool
is green — it proves the number is not obviously wrong, not that the sentence is right.
"""

import argparse
import os
import re
import sys

TOOLS = os.path.dirname(os.path.abspath(__file__))
CONTRACTS = os.path.dirname(TOOLS)
REPO = os.path.dirname(CONTRACTS)

# Every document that makes the "code is the authority" promise, plus the live decision specs
# that rest on it. `docs/ROADMAP.md` and `docs/slither-triage.md` also cite lines, but neither
# states that contract, so a rotted number there is not this gate's job yet. Named here rather
# than swept in from `docs/*.md`, because a silent sweep would start grading documents that never
# signed up for it.
DOC_FILES = [
    "docs/FEE-MODEL.md",
    "docs/AUDIT-SCOPE.md",
    # A spec is usually a dated record and the specs directory is not gated. This one is gated
    # because it is a live decision document: it argues whether to build netting at all, it
    # reverses two claims the roadmap still made, and it rests on 83 line citations into the
    # settlement. One contract change staled 29 of them within a day of it being written. A
    # document that decides something has to be right about the code it decides from.
    "docs/specs/2026-09-08-netting-a-coincidence-of-wants.md",
    # The same reason, and this one asked for it in its own prose. It decides whether to build a
    # multicall, a delegate and a keyed nonce floor, it rests on 77 line citations into the
    # settlement, and it was written against a working tree that was changing under it. Backlog
    # #131 built its first recommendation and staled 46 of those citations in one commit.
    "docs/specs/2026-09-08-delegation-and-bulk-maker-actions.md",
    # The pre-scoping document an audit firm reads first. It makes the promise in its own opening:
    # "Every number below names the command that produced it." It is written for a reader outside
    # the project, like the audit pack, so a wrong number costs more here than in a note we
    # write for ourselves.
    "docs/AUDIT-READINESS.md",
]

# The documents above that make no line-number claims at all. Declared rather than inferred,
# because a count of zero is also what a rename, an emptied file or a pattern that stopped
# matching looks like, and because "nothing here was checked" and "everything here holds" must not
# print as the same sentence. `main` reads this set in both directions: a declared document that
# grows a citation fails, and an undeclared document that has none fails too.
NO_LINE_CITATION_DOCS = {
    # Every claim in it is a command to re-run or a whole file to open — "run `wc -l
    # contracts/src/*.sol`", "`Fork.t.sol` holds 2" — and not one of its backticked paths carries
    # a `:N`. Its own checkable facts are its tree pin and its counts, and neither is this tool's
    # job. It stays in the list above so this line prints on every run: an audit firm reads this
    # document first, and it should not look gated when it is not.
    "docs/AUDIT-READINESS.md",
    # Rewritten 2026-10-03 for the fee config hash. It names the function that computes each
    # quantity and cites no line, because the settlement moves under every edit and the old
    # citations were what rotted first. Its checkable facts (sizes, rates) are commands to re-run.
    "docs/FEE-MODEL.md",
}

# Extensions a citation is ever seen naming, across both documents. Anything else is a form this
# tool has not met and the unknown-form check below will say so rather than silently passing it.
CITED_EXTENSIONS = (".sol", ".ts", ".tsx", ".md")

# Directories that hold vendored dependencies or build output. A citation never means to point
# into one of these, and searching them risks a false resolution: `contracts/lib` vendors
# forge-std and OpenZeppelin, which ship files that share names with this repo's own.
EXCLUDE_DIRS = {
    "contracts/lib", "contracts/out", "contracts/out-coverage", "contracts/cache",
    "contracts/cache-coverage", "contracts/broadcast",
    "node_modules", "app/node_modules", "app/dist", "sdk/node_modules", "sdk/dist",
    ".git",
}

_DASH = r"[ \t]*[-–—][ \t]*"  # hyphen, en dash, em dash: this repo's prose uses both

# A file mention, with or without a line — `` `ProveSettlement.sol` `` and
# `` `ProveSettlement.sol:962` `` are the same regex with the tail optional, because a bare
# mention still sets "the current file" for a `:N` that follows it.
ANCHORED = re.compile(
    r"`(?P<file>[A-Za-z0-9_./-]+\.(?:sol|ts|tsx|md))(?::(?P<n1>\d+)(?:" + _DASH + r"(?P<n2>\d+))?)?`"
)
# A bare `:N` or `:N-M`, meaning whatever file was named most recently.
BARE_COLON = re.compile(r"`:(?P<n1>\d+)(?:" + _DASH + r"(?P<n2>\d+))?`")
# The prose form: "line 962" or "lines 2250-2251", inside or outside backticks or parentheses.
LINE_WORD = re.compile(r"\bline[s]?[ \t]+(?P<n1>\d+)(?:" + _DASH + r"(?P<n2>\d+))?\b", re.IGNORECASE)
# A trailing comment on a fenced Solidity line: the code before it is what to check.
CODE_COMMENT = re.compile(
    r"^(?P<code>.*\S.*?)[ \t]*//[ \t]*line[s]?[ \t]+(?P<n1>\d+)(?:" + _DASH + r"(?P<n2>\d+))?[ \t]*$"
)
# One sentence shape bootstraps a whole document onto a single file before any anchored citation
# exists: "`contracts/src/ProveSettlement.sol` is the authority". `FEE-MODEL.md` never cites a
# file directly — every number in it is a bare "line N" — so without this it would have no file
# to check any of them against.
AUTHORITY = re.compile(r"`([A-Za-z0-9_./-]+\.sol)`\s+is the authority")

# Anything that merely *looks* like a citation: the word "line"/"lines" within a few characters of
# a digit. Deliberately broader and cruder than the four real forms above — it exists only to
# catch a fifth form nobody taught this tool, by finding text none of the real patterns claimed.
SUSPECT = re.compile(r"\bline[s]?\b[ \t]{0,3}[:#(]?[ \t]{0,3}\d", re.IGNORECASE)

_IDENT_TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_COMMIT_HASH = re.compile(r"^[0-9a-f]{7,40}$")
# A backtick span that is itself a citation, not a naming term: `:996`, `ProveSettlement.sol`,
# `ProveSettlement.sol:996`, `ProveSettlement.sol:996-998`. Excluded so a citation can never
# confirm itself.
_CITATION_SPAN = re.compile(
    r"^:\d+(?:" + _DASH + r"\d+)?$"
    r"|^[A-Za-z0-9_./-]+\.(?:sol|ts|tsx|md)(?::\d+(?:" + _DASH + r"\d+)?)?$"
)


def _index_repo_files():
    """Every source-shaped file in the repo, keyed by its own basename.

    Built once so a bare basename citation ("2026-08-14-checkpoint.md") can be found without a
    full path. A citation that gives a path is resolved directly first; this index is only the
    fallback for one that does not.
    """
    by_basename = {}
    for root, dirs, files in os.walk(REPO):
        rel_root = os.path.relpath(root, REPO)
        keep = []
        for d in dirs:
            rel = d if rel_root == "." else f"{rel_root}/{d}"
            if rel in EXCLUDE_DIRS or d.startswith("."):
                continue
            keep.append(d)
        dirs[:] = keep
        for f in files:
            if f.endswith(CITED_EXTENSIONS):
                rel = f if rel_root == "." else f"{rel_root}/{f}"
                by_basename.setdefault(f, []).append(rel)
    return by_basename


def resolve_file(token, by_basename):
    """A citation's file token, turned into one real path relative to the repo root, or None.

    None means "not found" and, just as loudly, "found more than once" — a citation naming a bare
    basename that exists twice in the repo is genuinely ambiguous, and guessing which one it means
    would defeat the point of checking it at all.
    """
    direct = os.path.join(REPO, token)
    if os.path.isfile(direct):
        return os.path.relpath(direct, REPO)
    matches = by_basename.get(os.path.basename(token), [])
    return matches[0] if len(matches) == 1 else None


def _identifier_tokens(span_text):
    """Identifier-shaped words inside one backtick span, or none if the span is not a naming term.

    A citation's own file:line and a raw commit hash are excluded so neither can validate itself.
    Tokens shorter than two characters are dropped — a lone `i` or `n`, Solidity's favourite loop
    names, would appear on almost any line and turn "at least one candidate matches" into "always
    matches".
    """
    if _CITATION_SPAN.match(span_text) or _COMMIT_HASH.match(span_text):
        return []
    return [t for t in _IDENT_TOKEN.findall(span_text) if len(t) >= 2]


def _contains_identifier(text, token):
    """Whether `token` sits in `text` as a whole identifier, underscores aside.

    A plain `\\bTOKEN\\b` fails on this document's own habit of naming an invariant by the tail of
    its name: the doc says `` `NoAllowanceEverAccumulatesOnTheSettlement` `` for a function called
    `invariant_NoAllowanceEverAccumulatesOnTheSettlement`. `\\b` does not fire between `_` and a
    letter, because both are word characters, so the citation would fail for a naming habit rather
    than a wrong line. This only relaxes the boundary at `_`; a letter or digit on either side
    still blocks the match, so "Fee" does not falsely find "FeeSink".
    """
    return re.search(r"(?<![A-Za-z0-9])" + re.escape(token) + r"(?![A-Za-z0-9])", text) is not None


_FUNC_SIG = re.compile(r"\b(?:function|modifier)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")


def function_spans(src_lines):
    """Every named `function`/`modifier` body in a Solidity file, as `{name: [(start, end), ...]}`.

    A citation of the shape "`_quote`, lines 960-961" names the *function*, not literal text on
    those lines — `_quote`'s own signature sits five lines above. Checking the exact cited line
    falls inside the named function's body is what that citation actually claims, so this is a
    second way to confirm one, tried when the literal word is not on the line itself.

    Brace depth is counted per line, the same way `coverage-gate.py`'s `assembly_lines` counts an
    `assembly` block: cheap, and wrong only inside a string or comment holding a stray brace,
    which this codebase's style does not do. A signature with no body before its next `;` — an
    interface method — is skipped rather than mismatched to some later, unrelated block.
    """
    spans = {}
    n = len(src_lines)
    i = 0
    while i < n:
        m = _FUNC_SIG.search(src_lines[i])
        if not m:
            i += 1
            continue
        start = i + 1
        depth, found_brace, end, j = 0, False, None, i
        while j < n:
            line = src_lines[j]
            opens, closes = line.count("{"), line.count("}")
            if not found_brace and opens == 0 and ";" in line:
                break  # a declaration with no body
            if opens:
                found_brace = True
            depth += opens - closes
            if found_brace and depth <= 0:
                end = j + 1
                break
            j += 1
        if found_brace and end:
            spans.setdefault(m.group(1), []).append((start, end))
        i += 1
    return spans


def _build_declaration_index(by_basename):
    """Map every declared `function`/`modifier` name to the `.sol` file(s) that declare it.

    Breaks a tie the position-based file rule cannot. Several tables in `AUDIT-SCOPE.md` return
    to `ProveSettlement.sol` after one row asides into a different contract, with nothing marking
    the return — `sweepUnowned`, `claim` and `_termsOk` all follow a citation into
    `ProveCallSink.sol` with no citation of their own. A name this specific is usually declared in
    exactly one contract, so looking up where it is *declared* — not where it is merely called,
    which is nearly everywhere — beats guessing from whatever was cited last.
    """
    index = {}
    seen = set()
    for paths in by_basename.values():
        for rel in paths:
            if not rel.endswith(".sol") or rel in seen:
                continue
            seen.add(rel)
            try:
                text = open(os.path.join(REPO, rel), encoding="utf-8").read()
            except OSError:
                continue
            for m in _FUNC_SIG.finditer(text):
                index.setdefault(m.group(1), set()).add(rel)
    return index


def _candidates_in(text):
    """Every naming-term candidate backtick-quoted anywhere in `text`."""
    out = []
    for m in re.finditer(r"`([^`]+)`", text):
        out.extend(_identifier_tokens(m.group(1)))
    return out


def _paragraph_window(lines, doc_line):
    """The lines a citation on `doc_line` may draw its naming term from.

    A markdown table row is one physical line by construction, and each row usually names its own
    thing, so a row's window is itself alone. Prose is not: this document hard-wraps sentences at
    roughly eighty columns, and a citation routinely lands one physical line below the backtick
    term it belongs to — "`_payFee`" ends one line, "(`ProveSettlement.sol:2417`)" opens the next.
    A prose citation's window is therefore its whole paragraph, from the blank line or table
    boundary above it to the one below.

    Sharing a paragraph's full candidate pool is looser than sharing one line's — see the module
    docstring's honest-weakness paragraph — but it is the accurate description of where this
    document actually puts a citation's naming term, not a workaround for it.
    """
    idx = doc_line - 1
    if "|" in lines[idx]:
        return [lines[idx]]
    lo = idx
    while lo > 0 and lines[lo - 1].strip() != "" and "|" not in lines[lo - 1]:
        lo -= 1
    hi = idx
    while hi < len(lines) - 1 and lines[hi + 1].strip() != "" and "|" not in lines[hi + 1]:
        hi += 1
    return lines[lo:hi + 1]


def extract_citations(text, decl_index=None):
    """Every citation in `text`, in document order, each with its resolved file token and its
    candidate naming terms.

    `decl_index` is the `{name: {files}}` map from `_build_declaration_index`, used to resolve a
    bare citation by content when position alone is ambiguous; omit it to use position only.

    Returns (citations, suspects) where `suspects` are `SUSPECT` matches no recognised form
    claimed — proof, or disproof, that the four forms above are the only ones this document uses.
    """
    decl_index = decl_index or {}
    lines = text.split("\n")
    line_start = [0]
    for line in lines:
        line_start.append(line_start[-1] + len(line) + 1)

    def doc_line_of(pos):
        lo, hi = 0, len(lines) - 1
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if line_start[mid] <= pos:
                lo = mid
            else:
                hi = mid - 1
        return lo + 1  # 1-indexed

    consumed = []  # spans already claimed by a recognised form
    # Two different "which file" trackers, deliberately kept apart. `file_events` answers "what
    # was the most recent citation into a file" and drives the *global*, document-order fallback.
    # `mentions` answers "is this file's name anywhere on this citation's own line" and drives the
    # *same-line* override. A file named only in passing — "the app carries the advice instead,
    # see `sdk/src/settlement.ts:66`" — still belongs in `mentions` so a same-line `:N` right next
    # to it resolves correctly, but it must not become the document's new "current file" for every
    # unrelated bare citation that follows it with no file of its own on the line. Collapsing the
    # two was the bug this comment replaced: a single aside naming a frontend file made every
    # contract citation for the next forty lines resolve into that frontend file instead.
    file_events = []  # (pos, file), only for citations that carry their own line number
    mentions = []  # (pos, file), every backtick file mention, with or without a line number
    raw_citations = []  # citations still needing their file resolved: bare colon, line-word, code-comment
    citations = []  # citations that already carry their own file (anchored)

    for m in AUTHORITY.finditer(text):
        file_events.append((m.start(), m.group(1)))
        mentions.append((m.start(), m.group(1)))

    for i, line in enumerate(lines, 1):
        m = CODE_COMMENT.match(line)
        if not m:
            continue
        start = line_start[i - 1]
        consumed.append((start, start + len(line)))
        n2 = int(m.group("n2")) if m.group("n2") else None
        raw_citations.append({
            "pos": start, "doc_line": i, "n1": int(m.group("n1")), "n2": n2,
            "candidates": [t for t in _IDENT_TOKEN.findall(m.group("code")) if len(t) >= 2],
            "kind": "code-comment", "raw": line.strip(),
        })

    for m in ANCHORED.finditer(text):
        consumed.append(m.span())
        mentions.append((m.start(), m.group("file")))
        if m.group("n1") is None:
            continue  # a bare file mention: good for a same-line lookup, cites nothing itself
        file_events.append((m.start(), m.group("file")))
        doc_line = doc_line_of(m.start())
        n2 = int(m.group("n2")) if m.group("n2") else None
        citations.append({
            "doc_line": doc_line, "file": m.group("file"), "n1": int(m.group("n1")), "n2": n2,
            "candidates": _candidates_in("\n".join(_paragraph_window(lines, doc_line))),
            "kind": "anchored", "raw": m.group(),
        })

    for m in BARE_COLON.finditer(text):
        consumed.append(m.span())
        doc_line = doc_line_of(m.start())
        n2 = int(m.group("n2")) if m.group("n2") else None
        raw_citations.append({
            "pos": m.start(), "doc_line": doc_line, "n1": int(m.group("n1")), "n2": n2,
            "kind": "bare", "raw": m.group(),
        })

    for m in LINE_WORD.finditer(text):
        start, end = m.span()
        if any(a <= start < b for a, b in consumed):
            continue  # already accounted for by the code-comment form on this line
        consumed.append((start, end))
        doc_line = doc_line_of(start)
        n2 = int(m.group("n2")) if m.group("n2") else None
        raw_citations.append({
            "pos": start, "doc_line": doc_line, "n1": int(m.group("n1")), "n2": n2,
            "kind": "line-word", "raw": m.group(),
        })

    # Candidates first, file second: content can settle a file the position-based rule cannot.
    for c in raw_citations:
        if c["kind"] != "code-comment":
            # A code-comment citation already carries its candidates: the code on its own line,
            # extracted where it was found. Everything else names its term in backticks, found
            # somewhere in the citation's paragraph (or its own row, inside a table).
            c["candidates"] = _candidates_in("\n".join(_paragraph_window(lines, c["doc_line"])))

    # Resolve the file for every bare citation, trying three things in order:
    #
    # 1. A file named on the same document line wins (nearest before the citation, else nearest
    #    after) — the most direct signal there is, used for e.g. `` `docs/FEE-MODEL.md` ... `:172` ``.
    # 2. A candidate that is declared in exactly one known `.sol` file wins next. Several tables
    #    in `AUDIT-SCOPE.md` return to `ProveSettlement.sol` after one row asides into a different
    #    contract, with nothing marking the return — `sweepUnowned`, `claim` and `_termsOk` all
    #    follow a citation into `ProveCallSink.sol` with no citation of their own, and "most
    #    recent file cited" would leave every one of them pointed at the aside. A name this
    #    specific is nearly always declared in one place, so looking up where it is *declared*
    #    beats guessing from position.
    # 3. Position is the last resort: the most recent `.sol` file cited earlier in the document,
    #    skipping over any non-`.sol` file in between (a citation into `app/` or `sdk/` always
    #    spells out its own file, so it is never what a bare continuation means), or — if nothing
    #    `.sol` precedes it — the most recent file of any kind.
    file_events.sort()
    mentions.sort()
    for c in raw_citations:
        ls, le = line_start[c["doc_line"] - 1], line_start[c["doc_line"] - 1] + len(lines[c["doc_line"] - 1])
        same_line = [(pos, f) for pos, f in mentions if ls <= pos < le]
        if same_line:
            before = [pf for pf in same_line if pf[0] < c["pos"]]
            c["file"] = before[-1][1] if before else same_line[0][1]
            citations.append(c)
            continue

        declared_in = {f for tok in c["candidates"] for f in decl_index.get(tok, ())}
        if len(declared_in) > 1:
            # `claim` is declared both by `ProveSettlement.sol` and by a test fixture token that
            # happens to reuse the name. `AUDIT-SCOPE.md` audits `contracts/src`, so a name shared
            # with a fixture is not really ambiguous here — the audited contract wins.
            audited = {f for f in declared_in if f.startswith("contracts/src/")}
            if len(audited) == 1:
                declared_in = audited
        if len(declared_in) == 1:
            c["file"] = next(iter(declared_in))
            citations.append(c)
            continue

        earlier = [f for pos, f in file_events if pos < c["pos"]]
        sol_earlier = [f for f in earlier if f.endswith(".sol")]
        c["file"] = (sol_earlier or earlier or [None])[-1]
        citations.append(c)

    suspects = []
    for m in SUSPECT.finditer(text):
        if not any(a <= m.start() < b for a, b in consumed):
            suspects.append((doc_line_of(m.start()), m.group(), text[max(0, m.start() - 30):m.start() + 30]))

    citations.sort(key=lambda c: c["doc_line"])
    return citations, suspects


def check_document(doc_rel, by_basename, source_cache, span_cache, decl_index):
    """Every citation in one document, checked against the source it names.

    Returns a list of failure strings. Raises SystemExit immediately if the document contains
    text that looks like a citation in a form none of the four recognised shapes claimed — see
    the module docstring for why that is a hard stop rather than a skip.
    """
    doc_path = os.path.join(REPO, doc_rel)
    text = open(doc_path, encoding="utf-8").read()
    citations, suspects = extract_citations(text, decl_index)

    if suspects:
        lines = "\n".join(f"    {doc_rel}:{ln}  {raw!r}  near {ctx!r}" for ln, raw, ctx in suspects)
        sys.exit(
            f"{doc_rel} has text that looks like a line citation in a form this tool does not "
            f"know:\n{lines}\n\nFix the parser, not the document — a gate that skips a shape it "
            f"cannot read is exactly how AUDIT-SCOPE.md carried a coverage exemption at a line "
            f"that had moved."
        )

    failures = []
    for c in citations:
        where = f"{doc_rel}:{c['doc_line']}"
        if c["file"] is None:
            failures.append(f"{where}  cites `{c['raw']}` — no file was ever established for it")
            continue

        resolved = resolve_file(c["file"], by_basename)
        if resolved is None:
            failures.append(f"{where}  cites `{c['file']}`, which does not exist (or exists more "
                             f"than once) anywhere under the repo")
            continue

        if resolved not in source_cache:
            source_cache[resolved] = open(os.path.join(REPO, resolved), encoding="utf-8").read().split("\n")
        src_lines = source_cache[resolved]

        n1, n2 = c["n1"], c["n2"] or c["n1"]
        if n2 < n1:
            n1, n2 = n2, n1
        if n1 < 1 or n2 > len(src_lines):
            failures.append(f"{where}  cites {resolved}:{c['n1']}"
                             f"{'-' + str(c['n2']) if c['n2'] else ''}, but {resolved} only has "
                             f"{len(src_lines)} lines")
            continue

        window = src_lines[n1 - 1:n2]
        joined = "\n".join(window)
        if not c["candidates"]:
            failures.append(f"{where}  cites {resolved}:{c['n1']}"
                             f"{'-' + str(c['n2']) if c['n2'] else ''} — no backticked term near "
                             f"it to check, so this citation cannot be verified")
            continue

        hit = any(_contains_identifier(joined, tok) for tok in c["candidates"])

        # A citation naming a function ("`_quote`, lines 960-961") is not claiming the word
        # `_quote` sits on those lines — it is claiming those lines are inside `_quote`. Tried
        # only once the literal check has already failed, so a real content mismatch is never
        # hidden just because the cited line happens to sit inside a same-named function.
        if not hit and resolved.endswith(".sol"):
            if resolved not in span_cache:
                span_cache[resolved] = function_spans(src_lines)
            spans = span_cache[resolved]
            for tok in c["candidates"]:
                if any(fs <= n1 and n2 <= fe for fs, fe in spans.get(tok, [])):
                    hit = True
                    break

        if not hit:
            actual = window[0].strip() if len(window) == 1 else "\n        ".join(w.strip() for w in window)
            failures.append(
                f"{where}  cites {resolved}:{c['n1']}{'-' + str(c['n2']) if c['n2'] else ''} — "
                f"expected one of {sorted(set(c['candidates']))} there\n"
                f"        actual:  {actual}"
            )
    return failures, len(citations)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doc", action="append", help="check only this doc (repeatable), for testing")
    args = ap.parse_args()

    docs = args.doc or DOC_FILES
    by_basename = _index_repo_files()
    decl_index = _build_declaration_index(by_basename)
    source_cache, span_cache = {}, {}

    total, all_failures, checked, unchecked = 0, [], 0, []
    for doc_rel in docs:
        failures, n = check_document(doc_rel, by_basename, source_cache, span_cache, decl_index)

        if doc_rel in NO_LINE_CITATION_DOCS:
            if n:
                sys.exit(
                    f"{doc_rel} is declared as making no line-number claims, and it now makes "
                    f"{n}. Delete it from NO_LINE_CITATION_DOCS, so every claim in it is read "
                    f"and checked on every run like every other document's. A declaration that "
                    f"outlives its reason is an exemption, and this one would hide real citations."
                )
            unchecked.append(doc_rel)
            print(f"{doc_rel}: UNCHECKED — it makes no line-number claims, so this gate reads "
                  f"nothing in it")
            continue

        if n == 0:
            sys.exit(
                f"{doc_rel} yielded no citations at all, and it is not declared as a document "
                f"that makes none. Either it stopped making line claims — declare it in "
                f"NO_LINE_CITATION_DOCS, with the reason — or it was renamed, emptied, or a "
                f"pattern above stopped matching it. A zero is not a pass. This gate will not "
                f"print one as though it were."
            )

        checked += 1
        total += n
        all_failures.extend(failures)
        print(f"{doc_rel}: {n} citation(s), {len(failures)} stale")

    print()
    if all_failures:
        print(f"FAIL: {len(all_failures)} of {total} citation(s) do not hold:")
        for f in all_failures:
            print(f"    {f}")
        sys.exit(1)
    for doc_rel in unchecked:
        print(f"UNCHECKED: {doc_rel} makes no line-number claims. This gate read nothing in it, "
              f"and the count below covers the other documents only.")
    print(f"OK: all {total} citation(s) across {checked} checked document(s) hold.")


if __name__ == "__main__":
    main()

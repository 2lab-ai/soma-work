#!/usr/bin/env python3
"""Lint a .prd loop driver home: loop.md (open work only) + loop.done.md (append-only ledger).

Checks C0 loop.md / Status column present, C1 no closed rows left in loop.md, C2 loop.done.md
append-only vs a git base, C3 one open row per regression:<ID>, C4/C5 no ID reuse, W1 length,
W2 a loop.md Status cell without a recognized mark.
Rule text lives in this skill's SKILL.md §loop.md 관리.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections import namedtuple

MAX_LINES = 80
CLOSED_MARKS = ("✅", "⚫")
OPEN_MARKS = ("🔴", "🟡", "🚪")
REGRESSION_RE = re.compile(r"regression:\s*([\w\-]+(?:\.[\w\-]+)*)")
SEP_RE = re.compile(r"^:?-+:?$")
HEADING_RE = re.compile(r"^#{1,6}\s")
REPO_ENV = ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR")
Row = namedtuple("Row", "line id state source status")


# ---------- parsing ----------

def read_text(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def read_lines(path):
    return read_text(path).rstrip("\n").split("\n")


def cells(line):
    s = line.strip()
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|") and not s.endswith("\\|"):
        s = s[:-1]
    return [c.strip() for c in re.split(r"(?<!\\)\|", s)]


def norm(text):
    return text.strip().strip("*`").strip()


def is_sep(line):
    s = line.strip()
    return s.startswith("|") and all(SEP_RE.match(c) for c in cells(s))


def parse_tables(lines):
    """Markdown tables outside code fences, each tagged with its nearest heading."""
    tables, heading, fence, i = [], "", False, 0
    while i < len(lines):
        s = lines[i].strip()
        if s.startswith("```") or s.startswith("~~~"):
            fence = not fence
        elif not fence and HEADING_RE.match(s):
            heading = s.lstrip("#").strip()
        elif not fence and s.startswith("|") and i + 1 < len(lines) and is_sep(lines[i + 1]):
            t = {"header": cells(s), "line": i + 1, "heading": heading, "rows": []}
            i += 2
            while i < len(lines) and lines[i].strip().startswith("|"):
                t["rows"].append((i + 1, cells(lines[i])))
                i += 1
            tables.append(t)
            continue
        i += 1
    return tables


def is_id_table(t):
    return bool(t["header"]) and norm(t["header"][0]) == "ID"


def state(text):
    if any(m in text for m in CLOSED_MARKS):
        return "closed"
    if any(m in text for m in OPEN_MARKS):
        return "open"
    return None


def cell(cs, idx):
    return cs[idx] if idx is not None and idx < len(cs) else ""


def gap_rows(path, tables, out):
    """Rows of every ID+Status table; an ID table without Status is a C0 FAIL."""
    rows = []
    for t in filter(is_id_table, tables):
        low = [norm(c).lower() for c in t["header"]]
        if "status" not in low:
            out.append(("FAIL", "C0", path, t["line"], "gap table has ID header but no Status column"))
            continue
        si = low.index("status")
        src = low.index("source") if "source" in low else None
        for ln, cs in t["rows"]:
            st = cell(cs, si)
            rows.append(Row(ln, norm(cs[0]) if cs else "", state(st), cell(cs, src), st))
    return rows


# ---------- checks ----------

def check_marks(path, rows, out):
    """loop.md only: an unmarked row is neither open nor closed, so C1/C3 would skip it silently.
    A warning, not a FAIL: drivers written before the mark rule still use words.
    loop.done.md is not checked: it is append-only, so a finding there could never be fixed."""
    for r in rows:
        if r.state is None:
            out.append(("WARN", "W2", path, r.line,
                        f"{r.id or '(no ID)'} Status carries no recognized mark "
                        f"(✅ ⚫ closed · 🔴 🟡 🚪 open): {r.status!r} — use a mark; "
                        "C1/C3 cannot see this row's state"))


def check_closed(path, rows, out):
    for r in rows:
        if r.state == "closed":
            out.append(("FAIL", "C1", path, r.line, f"{r.id} is closed: closed row must move to loop.done.md"))


def check_regressions(path, rows, out):
    seen = {}
    for r in rows:
        if r.state != "open":
            continue
        for tok in sorted(set(REGRESSION_RE.findall(r.source))):
            if tok in seen:
                out.append(("FAIL", "C3", path, r.line,
                            f"regression of {tok} already open at line {seen[tok]}; "
                            "update it instead of opening another"))
            else:
                seen[tok] = r.line


def check_dupes(path, rows, out):
    seen = {}
    for r in rows:
        if not r.id:
            continue
        if r.id in seen:
            out.append(("FAIL", "C5", path, r.line, f"duplicate ID {r.id} (first at line {seen[r.id]})"))
        else:
            seen[r.id] = r.line


def check_cross(path, rows, done, done_rows, out):
    closed = {}
    for r in done_rows:
        closed.setdefault(r.id, r.line)
    for r in rows:
        if r.id and r.id in closed:
            out.append(("FAIL", "C4", path, r.line,
                        f"{r.id} is already closed at {done}:{closed[r.id]}; "
                        f"a regression reopens under a new ID with Source regression:{r.id}"))


def git(home, *args):
    env = {k: v for k, v in os.environ.items() if k not in REPO_ENV}
    try:
        return subprocess.run(["git", "-C", home, *args], capture_output=True,
                              encoding="utf-8", errors="replace", env=env)
    except OSError:
        return subprocess.CompletedProcess(args, 127, "", "git not runnable")


def base_text(home, base):
    """(content, reason, fatal). cat-file --filters = checkout bytes (git-crypt/eol safe)."""
    if git(home, "rev-parse", "--is-inside-work-tree").returncode:
        return None, "not a git repo", False
    if git(home, "rev-parse", "--verify", "--quiet", base + "^{commit}").returncode:
        return None, f"base {base} does not resolve", base != "HEAD"
    r = git(home, "cat-file", "--filters", f"{base}:./loop.done.md")
    if r.returncode:
        return None, f"loop.done.md absent at {base}", False
    return r.stdout, "", False


def check_append_only(home, done, base, out):
    prev, why, fatal = base_text(home, base)
    if prev is None:
        if fatal:
            out.append(("FAIL", "C2", done, 0, f"cannot verify append-only: {why}"))
        else:
            out.append(("INFO", "C2", None, 0, f"skipped ({why})"))
        return
    old = prev.rstrip("\n")
    if not old:
        return
    if not os.path.isfile(done):
        out.append(("FAIL", "C2", done, 0, f"exists at {base} but was deleted; loop.done.md is append-only"))
        return
    new = read_text(done).split("\n")
    for i, line in enumerate(old.split("\n")):
        if i >= len(new) or new[i] != line:
            out.append(("FAIL", "C2", done, i + 1,
                        f"append-only: line {i + 1} differs from {base} (history edited or removed)"))
            return


def lint(home, base="HEAD"):
    out = []
    loop = os.path.join(home, "loop.md")
    done = os.path.join(home, "loop.done.md")
    if not os.path.isfile(loop):
        return [("FAIL", "C0", loop, 0, "loop.md missing")]
    lines = read_lines(loop)
    if len(lines) > MAX_LINES:
        out.append(("WARN", "W1", loop, MAX_LINES + 1,
                    f"over {MAX_LINES} lines: check for finished items to move; "
                    f"open items stay even past {MAX_LINES}"))
    tables = parse_tables(lines)
    if not any(map(is_id_table, tables)):
        out.append(("INFO", "I1", loop, 0,
                    "no ID/Status gap table: C1/C3/C4/C5 not checked (document-drive or finished loop)"))
    rows = gap_rows(loop, tables, out)
    check_marks(loop, rows, out)
    check_closed(loop, rows, out)
    check_regressions(loop, rows, out)
    check_dupes(loop, rows, out)
    done_rows = []
    if os.path.isfile(done):
        closed_tables = [t for t in parse_tables(read_lines(done)) if "closed rows" in t["heading"].lower()]
        done_rows = gap_rows(done, closed_tables, out)
        check_dupes(done, done_rows, out)
    check_cross(loop, rows, done, done_rows, out)
    check_append_only(home, done, base, out)
    return out


def fmt(f):
    level, code, path, line, msg = f
    return f"{level} {code} {path}:{line} {msg}" if path else f"{level} {code} {msg}"


def exit_code(findings):
    return 1 if any(f[0] == "FAIL" for f in findings) else 0


# ---------- selftest ----------

def table(rows):
    head = "| ID | Gap | Source | Status |\n|---|---|---|---|\n"
    return head + "".join(f"| {i} | gap {i} | {src} | {st} |\n" for i, src, st in rows)


def loop_doc(rows):
    return "# Loop\n\n## Gaps\n\n" + table(rows)


GOOD_LOOP = loop_doc([("U2", "spec", "🔴"), ("U3r", "`regression:U3`", "🔴")])


def block(n, ids, round_text):
    """One loop.done.md round block, template order; round_text = the moved Round section."""
    return (f"\n## R{n} — closed 2026-10-0{n}T00:00Z\n\n"
            f"- measured fixture · result pass · closed rows: {', '.join(ids)}\n\n"
            "### Closed rows\n\n" + table([(i, "spec", "✅") for i in ids])
            + "\n### Round section (as it was in loop.md)\n\n" + round_text)


# R1's Round section carries a moved table listing U1 again: only "Closed rows" tables count.
GOOD_DONE = ("# Done\n"
             + block(1, ["U1"], "- round 1 moved table:\n\n" + table([("U1", "spec", "✅")]))
             + block(2, ["U3"], "- round 2 line\n"))

CASES = [
    ("1-good", GOOD_LOOP, GOOD_DONE, {"INFO C2"}, 0),
    ("2-closed-in-loop", loop_doc([("U2", "spec", "✅")]), None, {"FAIL C1", "INFO C2"}, 1),
    ("3-double-regression", loop_doc([("U4", "regression:U3", "🔴"), ("U5", "regression:U3", "🟡")]),
     None, {"FAIL C3", "INFO C2"}, 1),
    ("4-id-in-both", loop_doc([("U1", "spec", "🔴")]), GOOD_DONE, {"FAIL C4", "INFO C2"}, 1),
    ("5-dup-id", loop_doc([("U2", "spec", "🔴"), ("U2", "spec", "🚪")]), None, {"FAIL C5", "INFO C2"}, 1),
    ("7-over-80", loop_doc([(f"U{n}", "spec", "🔴") for n in range(90)]), None, {"WARN W1", "INFO C2"}, 0),
    ("8-missing-loop", None, None, {"FAIL C0"}, 1),
    ("9-no-status-col", "# Loop\n\n| ID | Gap |\n|---|---|\n| U1 | x |\n", None, {"FAIL C0", "INFO C2"}, 1),
    ("10-document-drive", "# Loop\n\nRewrite chapter 3 next.\n", None, {"INFO I1", "INFO C2"}, 0),
    ("11-word-status", loop_doc([("U1", "spec", "done"), ("U2", "spec", "open"), ("U3", "spec", "")]), None,
     {"WARN W2", "INFO C2"}, 0),
    ("12-open-marks", loop_doc([("U1", "spec", "🔴"), ("U2", "spec", "🟡 partial"), ("U3", "spec", "🚪")]), None,
     {"INFO C2"}, 0),
    ("13-closed-marks", loop_doc([("U1", "spec", "✅"), ("U2", "spec", "⚫")]), None, {"FAIL C1", "INFO C2"}, 1),
    # The append-only ledger keeps old word statuses as written: W2 checks loop.md only.
    ("14-word-status-in-done", GOOD_LOOP, "# Done\n" + block(1, ["U1"], "- round 1 line\n").replace("| ✅ |", "| closed |"),
     {"INFO C2"}, 0),
]


def write(d, name, text):
    with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
        fh.write(text)


def build(root, name, loop_text, done_text):
    d = os.path.join(root, name)
    os.makedirs(d)
    if loop_text is not None:
        write(d, "loop.md", loop_text)
    if done_text is not None:
        write(d, "loop.done.md", done_text)
    return d


def run_case(name, d, want, want_exit):
    found = lint(d)
    got = {f"{f[0]} {f[1]}" for f in found}
    code = exit_code(found)
    ok = got == want and code == want_exit
    print(f"{'ok' if ok else 'BAD'} {name}: expected {sorted(want)} exit {want_exit} "
          f"got {sorted(got)} exit {code}")
    if not ok:
        for f in found:
            print("    " + fmt(f))
    return ok


def case_append_only(root):
    d = build(root, "6-append-only", GOOD_LOOP, GOOD_DONE)
    g = ["git", "-c", "user.name=loop-lint", "-c", "user.email=loop-lint@example.invalid",
         "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-C", d]
    env = {k: v for k, v in os.environ.items() if k not in REPO_ENV}
    try:
        for args in (["init", "-q"], ["add", "."], ["commit", "-q", "-m", "base"]):
            subprocess.run(g + args, check=True, capture_output=True, env=env)
    except (OSError, subprocess.CalledProcessError) as e:
        print(f"BAD 6-append-only: expected git fixture got {e}")
        return False
    u1 = "| U1 | gap U1 | spec | ✅ |\n"
    subs = [
        ("6a-append-block", GOOD_DONE + block(3, ["U4"], "- round 3 line\n"), set(), 0),
        ("6b-edit-old-line", GOOD_DONE.replace("| U1 | gap U1", "| U1 | gap U1 edited", 1), {"FAIL C2"}, 1),
        ("6c-insert-into-old-block", GOOD_DONE.replace(u1, u1 + "| U9 | gap U9 | spec | ✅ |\n", 1),
         {"FAIL C2"}, 1),
        ("6d-dup-across-blocks", GOOD_DONE + block(3, ["U1"], "- round 3 line\n"), {"FAIL C5"}, 1),
    ]
    results = []
    for name, text, want, code in subs:
        write(d, "loop.done.md", text)
        results.append(run_case(name, d, want, code))
    return all(results)


def selftest():
    root = tempfile.mkdtemp(prefix="loop-lint-")
    try:
        results = [run_case(n, build(root, n, lt, dt), w, c) for n, lt, dt, w, c in CASES[:5]]
        results.append(case_append_only(root))
        results += [run_case(n, build(root, n, lt, dt), w, c) for n, lt, dt, w, c in CASES[5:]]
    finally:
        shutil.rmtree(root, ignore_errors=True)
    ok = all(results)
    print(f"selftest: {'PASS' if ok else 'FAIL'} ({sum(results)}/{len(results)} groups)")
    return 0 if ok else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description="Lint a .prd loop home (loop.md + loop.done.md).")
    ap.add_argument("home", nargs="?", help="loop home directory")
    ap.add_argument("--base", default="HEAD", help="git rev for the loop.done.md append-only check")
    ap.add_argument("--selftest", action="store_true", help="run built-in fixtures")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()
    if not a.home:
        ap.error("home dir required (or --selftest)")
    found = lint(a.home, a.base)
    for f in found:
        print(fmt(f))
    nf = sum(f[0] == "FAIL" for f in found)
    nw = sum(f[0] == "WARN" for f in found)
    print(f"loop-lint {a.home}: {nf} FAIL, {nw} WARN")
    return 1 if nf else 0


if __name__ == "__main__":
    sys.exit(main())

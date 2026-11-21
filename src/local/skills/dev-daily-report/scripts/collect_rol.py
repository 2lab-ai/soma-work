#!/usr/bin/env python3
"""Review of Legends (RoL) — numbers for one report window.

Reads the RoL dashboard store (SQLite ``runs`` + ``events``) from a private
copy, so the live database is never locked, and joins each reviewed pull
request with GitHub (author, merge time) through ``gh``.

Definitions (the renderer prints the same words):

- review time   = a review attempt's start (``runs.created_at``) to its first
                  terminal event (fallback ``runs.updated_at``), attempts that
                  started in the window and ended ``succeeded``.
- review->merge = a PR merged in the window: its first RoL attempt ever to
                  ``mergedAt``. PRs RoL never reviewed are counted apart.
- rounds        = attempts per PR; for merged PRs, every attempt before merge.

usage:
  collect_rol.py [--db PATH] [--repo owner/name ...] [--hours 24 | --since ISO]
                 [--until ISO] [--tz Asia/Seoul] [--no-github] [--out FILE]
"""

from __future__ import annotations

import argparse
import glob
import os
import shutil
import sqlite3
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import report_common as rc  # noqa: E402

TERMINAL = ("succeeded", "failed", "interrupted", "stale", "skipped")
DB_CANDIDATES = (
    "~/.config/review-of-legends/data/dashboard/dashboard.sqlite3",
    "/opt/review-of-legends/*/data/dashboard/dashboard.sqlite3",
    "~/review-of-legends/*/data/dashboard/dashboard.sqlite3",
    "~/review-of-legends/data/dashboard/dashboard.sqlite3",
)
PR_FIELDS = "number title url createdAt mergedAt isDraft baseRefName author{login}"


# ---------------------------------------------------------------- store

def find_db(explicit: Optional[str]) -> Path:
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            raise rc.ReportError(f"RoL dashboard store not found: {path}")
        return path
    env = os.environ.get("ROL_DASHBOARD_DB")
    if env:
        return find_db(env)
    found = []
    for pattern in DB_CANDIDATES:
        found.extend(Path(p) for p in glob.glob(os.path.expanduser(pattern)))
    found = [p for p in found if p.is_file()]
    if not found:
        raise rc.ReportError(
            "RoL dashboard store not found (pass --db or set ROL_DASHBOARD_DB); looked in: "
            + ", ".join(DB_CANDIDATES)
        )
    return max(found, key=lambda p: p.stat().st_mtime)


def snapshot(db: Path, workdir: str) -> Path:
    """Copy the store (and its WAL) so reading never takes a lock on the live file."""
    dest = Path(workdir) / "rol.sqlite3"
    shutil.copy2(db, dest)
    for suffix in ("-wal", "-shm"):
        side = Path(str(db) + suffix)
        if side.exists():
            shutil.copy2(side, Path(str(dest) + suffix))
    return dest


def load_runs(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    conn.row_factory = sqlite3.Row
    ended: dict[str, str] = {}
    try:
        for row in conn.execute(
            "SELECT run_id, MIN(created_at) AS ended FROM events WHERE kind = 'run_updated'"
            " AND json_extract(payload, '$.status') IN (?, ?, ?, ?, ?) GROUP BY run_id",
            TERMINAL,
        ):
            ended[row["run_id"]] = row["ended"]
    except sqlite3.Error:
        ended = {}  # no events table / no JSON1: fall back to runs.updated_at
    runs = []
    for row in conn.execute(
        "SELECT id, repo, pr, head_sha, title, url, status, review_url, created_at, updated_at"
        " FROM runs ORDER BY seq"
    ):
        start = rc.parse_ts(row["created_at"])
        end = None
        if row["status"] in TERMINAL:
            end = rc.parse_ts(ended.get(row["id"]) or row["updated_at"])
        runs.append({
            "id": row["id"], "repo": row["repo"], "pr": int(row["pr"]), "title": row["title"],
            "url": row["url"], "status": row["status"], "review_url": row["review_url"],
            "start": start, "end": end,
        })
    return runs


# ---------------------------------------------------------------- GitHub

def fetch_prs(repo: str, numbers: list[int], gh_bin: str) -> dict[int, dict[str, Any]]:
    owner, name = rc.split_repo(repo)
    out: dict[int, dict[str, Any]] = {}
    for i in range(0, len(numbers), 40):
        chunk = numbers[i:i + 40]
        body = " ".join(f"p{n}: pullRequest(number:{n}){{{PR_FIELDS}}}" for n in chunk)
        query = "query($o:String!,$n:String!){repository(owner:$o,name:$n){" + body + "}}"
        data = rc.gh_graphql(query, {"o": owner, "n": name}, gh_bin=gh_bin)
        for node in (data.get("repository") or {}).values():
            if node:
                out[int(node["number"])] = node
    return out


def merged_in_window(repo: str, start: datetime, end: datetime, gh_bin: str) -> list[dict[str, Any]]:
    span = f"{start.strftime('%Y-%m-%dT%H:%M:%S')}+00:00..{end.strftime('%Y-%m-%dT%H:%M:%S')}+00:00"
    nodes = rc.search_prs(f"repo:{repo} is:pr is:merged merged:{span}", gh_bin=gh_bin, fields=PR_FIELDS)
    return [n for n in nodes if rc.in_window(rc.parse_ts(n.get("mergedAt")), start, end)]


# ---------------------------------------------------------------- numbers

def build_report(runs: list[dict[str, Any]], start: datetime, end: datetime, tz_name: str,
                 repos: Optional[list[str]], prs: dict[tuple[str, int], dict[str, Any]],
                 merged: Optional[dict[str, list[dict[str, Any]]]], source: dict[str, Any]) -> dict[str, Any]:
    """Pure: every number in the RoL report from runs + GitHub facts (testable offline)."""
    tz = rc.tzinfo(tz_name)
    keep = {r.lower() for r in repos} if repos else None
    runs = [r for r in runs if keep is None or r["repo"].lower() in keep]
    first_start: dict[tuple[str, int], datetime] = {}
    for r in runs:
        key = (r["repo"], r["pr"])
        if r["start"] and (key not in first_start or r["start"] < first_start[key]):
            first_start[key] = r["start"]

    win = [r for r in runs if rc.in_window(r["start"], start, end)]

    def author(repo: str, pr: int) -> str:
        node = prs.get((repo, pr))
        return rc.login_of(node) if node else "—"

    attempts = []
    for r in win:
        dur = rc.seconds_between(r["start"], r["end"]) if r["status"] == "succeeded" else None
        attempts.append({**r, "author": author(r["repo"], r["pr"]), "review_sec": dur})

    merges = []
    unreviewed = 0
    for repo, nodes in (merged or {}).items():
        for node in nodes:
            key = (repo, int(node["number"]))
            merged_at = rc.parse_ts(node.get("mergedAt"))
            first = first_start.get(key)
            if first is None:
                unreviewed += 1
                continue
            rounds = sum(1 for r in runs if (r["repo"], r["pr"]) == key and r["start"] and r["start"] <= merged_at)
            merges.append({
                "repo": repo, "pr": key[1], "title": node.get("title", ""), "url": node.get("url", ""),
                "author": rc.login_of(node), "review_to_merge_sec": rc.seconds_between(first, merged_at),
                "rounds": rounds,
            })

    status_counts: dict[str, int] = {}
    for a in attempts:
        status_counts[a["status"]] = status_counts.get(a["status"], 0) + 1
    finished = sum(status_counts.get(s, 0) for s in ("succeeded", "failed", "interrupted", "stale"))
    reviewed_prs = {(a["repo"], a["pr"]) for a in attempts}

    def section(rows_a: list[dict[str, Any]], rows_m: list[dict[str, Any]]) -> dict[str, Any]:
        ok = [a for a in rows_a if a["status"] == "succeeded"]
        prs_here = {(a["repo"], a["pr"]) for a in rows_a}
        return {
            "attempts": len(rows_a),
            "succeeded": len(ok),
            "failed": sum(1 for a in rows_a if a["status"] in ("failed", "interrupted", "stale")),
            "prs": len(prs_here),
            "review_sec": rc.summarize(a["review_sec"] for a in ok),
            "merged": len(rows_m),
            "review_to_merge_sec": rc.summarize(m["review_to_merge_sec"] for m in rows_m),
            "rounds_to_merge": (sum(m["rounds"] for m in rows_m) / len(rows_m)) if rows_m else None,
        }

    def breakdown(key: str) -> list[dict[str, Any]]:
        ga, gm = rc.group_rows(attempts, key), rc.group_rows(merges, key)
        rows = [{key: name, **section(ga.get(name, []), gm.get(name, []))} for name in sorted(set(ga) | set(gm))]
        return sorted(rows, key=lambda r: (-(r["attempts"] + r["merged"]), str(r[key])))

    hourly = [0] * 24
    for a in attempts:
        hourly[a["start"].astimezone(tz).hour] += 1

    slowest, seen = [], set()
    for a in sorted((a for a in attempts if a["review_sec"] is not None), key=lambda a: -a["review_sec"]):
        if (a["repo"], a["pr"]) not in seen and len(slowest) < 3:  # one line per PR, its slowest attempt
            seen.add((a["repo"], a["pr"]))
            slowest.append(a)
    totals = section(attempts, merges)
    totals.update({
        "status": status_counts,
        "success_rate": (status_counts.get("succeeded", 0) / finished) if finished else None,
        "rounds_per_pr": (len(attempts) / len(reviewed_prs)) if reviewed_prs else None,
        "merged_unreviewed": unreviewed,
    })
    notes = []
    if merged is None:
        notes.append("GitHub 조회 생략 — 유저별·리뷰→머지 수치 없음")
    if any(r["status"] == "running" for r in win):
        notes.append(f"집계 시점에 진행 중인 리뷰 {sum(1 for r in win if r['status'] == 'running')}건은 소요시간에서 빠짐")
    return {
        "kind": "rol",
        "window": rc.window_block(start, end, tz_name),
        "source": source,
        "totals": totals,
        "by_repo": breakdown("repo"),
        "by_user": breakdown("author") if prs else [],
        "hourly": hourly,
        "slowest": [{"repo": a["repo"], "pr": a["pr"], "title": a["title"], "author": a["author"],
                     "review_sec": a["review_sec"], "url": a["review_url"] or a["url"]} for a in slowest],
        "notes": notes,
    }


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--db")
    ap.add_argument("--repo", action="append", help="owner/name (repeat); default: every repo in the store")
    ap.add_argument("--hours", type=float, default=24.0)
    ap.add_argument("--since")
    ap.add_argument("--until")
    ap.add_argument("--tz", default=rc.DEFAULT_TZ)
    ap.add_argument("--no-github", action="store_true")
    ap.add_argument("--gh", default="gh", help=argparse.SUPPRESS)
    ap.add_argument("--out", default="-")
    args = ap.parse_args(argv)
    try:
        start, end = rc.resolve_window(args.since, args.until, args.hours)
        db = find_db(args.db)
        with tempfile.TemporaryDirectory(prefix="rol-report-") as tmp:
            conn = sqlite3.connect(str(snapshot(db, tmp)))
            try:
                runs = load_runs(conn)
            finally:
                conn.close()
        repos = args.repo or sorted({r["repo"] for r in runs if r["start"] and r["start"] >= start})
        prs: dict[tuple[str, int], dict[str, Any]] = {}
        merged: Optional[dict[str, list[dict[str, Any]]]] = None
        if not args.no_github:
            merged = {}
            wanted: dict[str, set[int]] = {}
            for r in runs:
                if rc.in_window(r["start"], start, end) and r["repo"] in repos:
                    wanted.setdefault(r["repo"], set()).add(r["pr"])
            for repo in repos:
                merged[repo] = merged_in_window(repo, start, end, args.gh)
                for node in merged[repo]:
                    prs[(repo, int(node["number"]))] = node
                missing = sorted(n for n in wanted.get(repo, ()) if (repo, n) not in prs)
                for number, node in fetch_prs(repo, missing, args.gh).items():
                    prs[(repo, number)] = node
        report = build_report(runs, start, end, args.tz, repos, prs, merged,
                              {"db": str(db), "repos": repos})
    except rc.ReportError as exc:
        print(f"collect_rol: {exc}", file=sys.stderr)
        return 2
    rc.write_json(args.out, report)
    return 0


if __name__ == "__main__":
    sys.exit(main())

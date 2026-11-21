#!/usr/bin/env python3
"""GitHub pull-request flow — numbers for one report window.

Definitions (the renderer prints the same words):

- opened / merged = PRs created / merged in the window. PRs whose base matches
                    ``--exclude-base`` (default: deploy branches) are left out:
                    they are promotions, not work.
- lead time       = a merged PR's ``createdAt`` to ``mergedAt``.
- gate time       = on the merged head commit, the first gate starting (check
                    suite created, or the first commit status) to the last gate
                    finishing. Per gate: its own start (queue included) to its end.
- deploy time     = ``mergedAt`` to the finish of the first successful run of the
                    deploy workflow on the deploy branch whose head contains the
                    merge commit. Merged PRs no such run contains yet = pending.

usage:
  collect_github.py --repo owner/name [--repo …]
                    [--deploy owner/name=workflow.yml@branch …] [--deploy-label dev2]
                    [--gate REGEX] [--exclude-base REGEX]
                    [--hours 24 | --since ISO] [--until ISO] [--tz Asia/Seoul] [--out FILE]
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import report_common as rc  # noqa: E402

BASE_FIELDS = "number title url createdAt mergedAt baseRefName author{login}"
MERGED_FIELDS = BASE_FIELDS + (
    " mergeCommit{oid} commits(last:1){nodes{commit{oid statusCheckRollup{contexts(first:100){nodes{"
    "__typename ... on CheckRun{name startedAt completedAt conclusion checkSuite{createdAt}}"
    " ... on StatusContext{context state createdAt}}}}}}}"
)
FINAL_STATES = {"SUCCESS", "FAILURE", "ERROR", "success", "failure", "error"}


def span(start: datetime, end: datetime) -> str:
    fmt = "%Y-%m-%dT%H:%M:%S"
    return f"{start.strftime(fmt)}+00:00..{end.strftime(fmt)}+00:00"


def parse_deploy(spec: str) -> tuple[str, str, str]:
    m = re.fullmatch(r"([^=\s]+/[^=\s]+)=([^@\s]+)@(\S+)", spec)
    if not m:
        raise rc.ReportError(f"--deploy must be owner/name=workflow.yml@branch, got {spec!r}")
    return m.group(1), m.group(2), m.group(3)


# ---------------------------------------------------------------- gates

def gate_events(node: dict[str, Any], statuses: list[dict[str, Any]],
                gate_re: Optional[re.Pattern[str]]) -> list[dict[str, Any]]:
    """One {name, start, end} per gate on the merged head; start None = unknown (single status)."""
    commit = ((node.get("commits") or {}).get("nodes") or [{}])[-1].get("commit") or {}
    rollup = (commit.get("statusCheckRollup") or {}).get("contexts") or {}
    events = []
    for ctx in rollup.get("nodes") or []:
        if not ctx or ctx.get("__typename") != "CheckRun":
            continue
        end = rc.parse_ts(ctx.get("completedAt"))
        start = rc.parse_ts((ctx.get("checkSuite") or {}).get("createdAt")) or rc.parse_ts(ctx.get("startedAt"))
        if end and start:
            events.append({"name": ctx["name"], "start": start, "end": end})
    by_context: dict[str, list[dict[str, Any]]] = {}
    for st in statuses:
        by_context.setdefault(st.get("context") or "status", []).append(st)
    for name, items in by_context.items():
        stamps = sorted((rc.parse_ts(s.get("created_at")), s.get("state")) for s in items if s.get("created_at"))
        finals = [ts for ts, state in stamps if state in FINAL_STATES]
        if not finals:
            continue
        first = stamps[0][0]
        end = finals[-1]
        events.append({"name": name, "start": first if first < end else None, "end": end})
    # Contexts named per base branch (".../required/develop") are one gate across PRs.
    base = node.get("baseRefName") or ""
    for e in events:
        if base and e["name"].endswith("/" + base):
            e["name"] = e["name"][: -len(base) - 1]
    if gate_re is not None:
        events = [e for e in events if gate_re.search(e["name"])]
    return events


def gate_summary(events: list[dict[str, Any]]) -> tuple[Optional[float], list[tuple[str, float]]]:
    """(wall-clock first start -> last end, [(gate, own seconds)]) for one PR."""
    starts = [e["start"] for e in events if e["start"]]
    if not events or not starts:
        return None, []
    gate_start = min(starts)
    gate_end = max(e["end"] for e in events)
    per = [(e["name"], (e["end"] - (e["start"] or gate_start)).total_seconds()) for e in events]
    return max(0.0, (gate_end - gate_start).total_seconds()), per


# ---------------------------------------------------------------- deploys

def first_containing(runs: list[dict[str, Any]], contains: Callable[[str], bool]) -> Optional[dict[str, Any]]:
    """Earliest run whose head contains the commit, assuming containment only grows along the list."""
    lo, hi, found = 0, len(runs) - 1, None
    while lo <= hi:
        mid = (lo + hi) // 2
        if contains(runs[mid]["head_sha"]):
            found, hi = runs[mid], mid - 1
        else:
            lo = mid + 1
    return found


def deploy_runs(repo: str, workflow: str, branch: str, since: datetime, gh_bin: str) -> list[dict[str, Any]]:
    runs: list[dict[str, Any]] = []
    for page in range(1, 6):
        data = rc.gh_json([
            f"repos/{repo}/actions/workflows/{workflow}/runs?branch={branch}&status=success"
            f"&created=>={rc.iso(since)}&per_page=100&page={page}"
        ], gh_bin=gh_bin)
        batch = (data or {}).get("workflow_runs") or []
        runs.extend(batch)
        if len(batch) < 100:
            break
    out = [{"id": r["id"], "head_sha": r["head_sha"], "created": rc.parse_ts(r["created_at"]),
            "finished": rc.parse_ts(r["updated_at"]), "url": r.get("html_url", "")} for r in runs]
    return sorted(out, key=lambda r: r["created"])


def make_contains(repo: str, merge_oid: str, gh_bin: str, cache: dict[tuple[str, str], bool]) -> Callable[[str], bool]:
    def contains(head: str) -> bool:
        key = (merge_oid, head)
        if key not in cache:
            if head == merge_oid:
                cache[key] = True
            else:
                data = rc.gh_json([f"repos/{repo}/compare/{merge_oid}...{head}"], gh_bin=gh_bin)
                cache[key] = (data or {}).get("status") in ("ahead", "identical")
        return cache[key]
    return contains


# ---------------------------------------------------------------- numbers

def build_report(opened: list[dict[str, Any]], merged: list[dict[str, Any]], open_now: dict[str, int],
                 start: datetime, end: datetime, tz_name: str, deploy_label: Optional[str],
                 deploy_repos: list[str], repos: list[str], gates_seen: bool) -> dict[str, Any]:
    """Pure: every number in the GitHub report from per-PR facts (testable offline).

    ``opened``: [{repo, number, title, url, author}]; ``merged``: [{repo, number, title, url,
    author, lead_sec, gate_sec, gates: [(name, sec)], deploy_sec, deploy_pending}].
    """
    def section(rows_o: list[dict[str, Any]], rows_m: list[dict[str, Any]], open_count: Optional[int] = None) -> dict[str, Any]:
        dep = [m for m in rows_m if m.get("repo") in deploy_repos]
        out = {
            "opened": len(rows_o),
            "merged": len(rows_m),
            "lead_sec": rc.summarize(m["lead_sec"] for m in rows_m),
            "gate_sec": rc.summarize(m["gate_sec"] for m in rows_m if m.get("gate_sec") is not None),
            "deploy_sec": rc.summarize(m["deploy_sec"] for m in dep if m.get("deploy_sec") is not None),
            "deploy_pending": sum(1 for m in dep if m.get("deploy_pending")),
            "deploy_tracked": len(dep),
        }
        if open_count is not None:
            out["open_now"] = open_count
        return out

    def breakdown(key: str, with_open: bool) -> list[dict[str, Any]]:
        go, gm = rc.group_rows(opened, key), rc.group_rows(merged, key)
        names = set(go) | set(gm) | (set(open_now) if with_open else set())
        rows = [{key: n, **section(go.get(n, []), gm.get(n, []), open_now.get(n, 0) if with_open else None)}
                for n in names]
        return sorted(rows, key=lambda r: (-(r["opened"] + r["merged"]), str(r[key])))

    # A context still carrying an old base ("…/reviewed/feat/x" after a retarget) joins the
    # shorter gate it extends ("…/reviewed"); one value per gate per PR (its slowest).
    parent: dict[str, str] = {}
    for name in sorted({n for m in merged for n, _ in m.get("gates") or []}, key=len):
        parent[name] = next((p for p in sorted(set(parent.values()), key=len, reverse=True)
                             if name.startswith(p + "/")), name)
    gate_rows: dict[str, list[float]] = {}
    for m in merged:
        per_pr: dict[str, float] = {}
        for name, sec in m.get("gates") or []:
            per_pr[parent[name]] = max(sec, per_pr.get(parent[name], sec))
        for name, sec in per_pr.items():
            gate_rows.setdefault(name, []).append(sec)
    gates = sorted(({"name": n, **rc.summarize(v)} for n, v in gate_rows.items()),
                   key=lambda g: -(g["mean"] or 0))

    totals = section(opened, merged, sum(open_now.values()))
    pending = [m for m in merged if m.get("deploy_pending")]
    notes = []
    if not gates_seen:
        notes.append("머지된 PR의 최종 커밋에 게이트(체크·상태)가 없음")
    if pending:
        oldest = max(pending, key=lambda m: m.get("pending_sec") or 0)
        notes.append(f"{deploy_label or '배포'} 미반영 {len(pending)}건 — 가장 오래된 것 "
                     f"{oldest['repo'].split('/')[-1]}#{oldest['number']} ({rc.fmt_duration(oldest.get('pending_sec'))} 경과)")
    return {
        "kind": "github",
        "window": rc.window_block(start, end, tz_name),
        "source": {"repos": repos, "deploy_repos": deploy_repos},
        "deploy_label": deploy_label,
        "totals": totals,
        "gates": gates[:8],
        "by_repo": breakdown("repo", True) if len(repos) > 1 else [],
        "by_user": breakdown("author", False),
        "slowest": [{k: m.get(k) for k in ("repo", "number", "title", "author", "lead_sec", "url")}
                    for m in sorted(merged, key=lambda m: -(m["lead_sec"] or 0))[:3]],
        "notes": notes,
    }


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", action="append", required=True)
    ap.add_argument("--deploy", action="append", default=[])
    ap.add_argument("--deploy-label")
    ap.add_argument("--gate", help="regex: count only checks/statuses whose name matches")
    ap.add_argument("--exclude-base", default=r"^deploy/")
    ap.add_argument("--hours", type=float, default=24.0)
    ap.add_argument("--since")
    ap.add_argument("--until")
    ap.add_argument("--tz", default=rc.DEFAULT_TZ)
    ap.add_argument("--gh", default="gh", help=argparse.SUPPRESS)
    ap.add_argument("--out", default="-")
    args = ap.parse_args(argv)
    try:
        start, end = rc.resolve_window(args.since, args.until, args.hours)
        now = datetime.now(timezone.utc)
        gate_re = re.compile(args.gate) if args.gate else None
        exclude = re.compile(args.exclude_base) if args.exclude_base else None
        deploys = [parse_deploy(s) for s in args.deploy]
        deploy_of = {repo: (wf, br) for repo, wf, br in deploys}
        keep = lambda n: not (exclude and exclude.search(n.get("baseRefName") or ""))  # noqa: E731
        opened, merged = [], []
        open_now: dict[str, int] = {}
        gates_seen = False
        cache: dict[tuple[str, str], bool] = {}
        for repo in args.repo:
            rc.split_repo(repo)
            for n in rc.search_prs(f"repo:{repo} is:pr created:{span(start, end)}", gh_bin=args.gh, fields=BASE_FIELDS):
                if keep(n) and rc.in_window(rc.parse_ts(n["createdAt"]), start, end):
                    opened.append({"repo": repo, "number": n["number"], "title": n["title"], "url": n["url"],
                                   "author": rc.login_of(n)})
            negate = f" -base:{deploy_of[repo][1]}" if repo in deploy_of else ""
            open_now[repo] = rc.search_count(f"repo:{repo} is:pr is:open{negate}", gh_bin=args.gh)
            runs = []
            if repo in deploy_of:
                wf, br = deploy_of[repo]
                runs = deploy_runs(repo, wf, br, start, args.gh)
            nodes = rc.search_prs(f"repo:{repo} is:pr is:merged merged:{span(start, end)}", gh_bin=args.gh,
                                  fields=MERGED_FIELDS)
            for n in nodes:
                merged_at = rc.parse_ts(n.get("mergedAt"))
                if not keep(n) or not rc.in_window(merged_at, start, end):
                    continue
                head = (((n.get("commits") or {}).get("nodes") or [{}])[-1].get("commit") or {}).get("oid")
                statuses = rc.gh_json([f"repos/{repo}/commits/{head}/statuses?per_page=100"], gh_bin=args.gh) if head else []
                gate_sec, per_gate = gate_summary(gate_events(n, statuses or [], gate_re))
                gates_seen = gates_seen or gate_sec is not None
                row = {"repo": repo, "number": n["number"], "title": n["title"], "url": n["url"],
                       "author": rc.login_of(n), "lead_sec": rc.seconds_between(rc.parse_ts(n["createdAt"]), merged_at),
                       "gate_sec": gate_sec, "gates": per_gate, "deploy_sec": None, "deploy_pending": False}
                oid = (n.get("mergeCommit") or {}).get("oid")
                if repo in deploy_of and oid:
                    later = [r for r in runs if r["created"] >= merged_at]
                    hit = first_containing(later, make_contains(repo, oid, args.gh, cache))
                    if hit:
                        row["deploy_sec"] = rc.seconds_between(merged_at, hit["finished"])
                    else:
                        row["deploy_pending"] = True
                        row["pending_sec"] = rc.seconds_between(merged_at, now)
                merged.append(row)
        report = build_report(opened, merged, open_now, start, end, args.tz,
                              args.deploy_label or (deploys[0][2].split("/")[-1] if deploys else None),
                              list(deploy_of), list(args.repo), gates_seen)
    except rc.ReportError as exc:
        print(f"collect_github: {exc}", file=sys.stderr)
        return 2
    rc.write_json(args.out, report)
    return 0


if __name__ == "__main__":
    sys.exit(main())

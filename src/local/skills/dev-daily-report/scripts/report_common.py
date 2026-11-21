"""Shared helpers for the dev-daily-report collectors and renderer.

Standard library only. Every timestamp inside the scripts is an aware UTC
``datetime``; the report's local time zone is used only for display and for
the hourly histogram.
"""

from __future__ import annotations

import json
import math
import subprocess
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable, Optional, Sequence

try:  # Python 3.9+
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover - the skill requires 3.10+
    ZoneInfo = None  # type: ignore[assignment]

DEFAULT_TZ = "Asia/Seoul"


class ReportError(RuntimeError):
    """A failure the caller should show to the reader as one line."""


# ---------------------------------------------------------------- time

def parse_ts(value: Any) -> Optional[datetime]:
    """ISO-8601 (``Z`` or offset, optional fraction) -> aware UTC datetime; None for empty."""
    if value in (None, ""):
        return None
    text = str(value).strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    dt = datetime.fromisoformat(text)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def resolve_window(since: Optional[str], until: Optional[str], hours: float,
                   now: Optional[datetime] = None) -> tuple[datetime, datetime]:
    """The report window [since, until). ``until`` defaults to now, floored to the minute."""
    if until:
        end = parse_ts(until)
    else:
        end = (now or datetime.now(timezone.utc)).replace(second=0, microsecond=0)
    assert end is not None
    start = parse_ts(since) if since else end - timedelta(hours=hours)
    assert start is not None
    if start >= end:
        raise ReportError(f"empty window: since {iso(start)} is not before until {iso(end)}")
    return start, end


def in_window(dt: Optional[datetime], start: datetime, end: datetime) -> bool:
    return dt is not None and start <= dt < end


def tzinfo(name: str):
    if ZoneInfo is None:
        return timezone.utc
    try:
        return ZoneInfo(name)
    except Exception as exc:  # unknown zone name
        raise ReportError(f"unknown time zone: {name}") from exc


def window_block(start: datetime, end: datetime, tz_name: str) -> dict[str, str]:
    tz = tzinfo(tz_name)
    return {
        "since": iso(start),
        "until": iso(end),
        "tz": tz_name,
        "since_local": start.astimezone(tz).strftime("%Y-%m-%d %H:%M"),
        "until_local": end.astimezone(tz).strftime("%Y-%m-%d %H:%M"),
    }


# ---------------------------------------------------------------- stats

def summarize(values: Iterable[float]) -> dict[str, Any]:
    """n / mean / median / p90 of durations in seconds (None when empty)."""
    data = sorted(float(v) for v in values if v is not None and v >= 0)
    n = len(data)
    if not n:
        return {"n": 0, "mean": None, "median": None, "p90": None}
    return {
        "n": n,
        "mean": sum(data) / n,
        "median": _quantile(data, 0.5),
        "p90": _quantile(data, 0.9),
    }


def _quantile(sorted_data: Sequence[float], q: float) -> float:
    if len(sorted_data) == 1:
        return sorted_data[0]
    pos = (len(sorted_data) - 1) * q
    lo, hi = math.floor(pos), math.ceil(pos)
    if lo == hi:
        return sorted_data[lo]
    return sorted_data[lo] + (sorted_data[hi] - sorted_data[lo]) * (pos - lo)


def seconds_between(a: Optional[datetime], b: Optional[datetime]) -> Optional[float]:
    if a is None or b is None:
        return None
    return (b - a).total_seconds()


def fmt_duration(seconds: Optional[float]) -> str:
    """Korean short duration: 45초, 4분 12초, 3시간 5분, 2일 4시간."""
    if seconds is None:
        return "—"
    s = int(round(seconds))
    if s < 60:
        return f"{s}초"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}분 {s}초" if s and m < 10 else f"{m}분"
    h, m = divmod(m, 60)
    if h < 24:
        return f"{h}시간 {m}분" if m else f"{h}시간"
    d, h = divmod(h, 24)
    return f"{d}일 {h}시간" if h else f"{d}일"


# ---------------------------------------------------------------- GitHub

def gh_json(args: Sequence[str], *, attempts: int = 3, gh_bin: str = "gh") -> Any:
    """Run ``gh api …`` and parse its JSON output; retry transient failures."""
    last = ""
    for i in range(attempts):
        proc = subprocess.run([gh_bin, "api", *args], capture_output=True, text=True, timeout=120)
        if proc.returncode == 0:
            out = proc.stdout.strip()
            return json.loads(out) if out else None
        last = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or [""]
        last = last[0]
        if any(code in last for code in ("HTTP 401", "HTTP 403", "HTTP 404", "HTTP 422")):
            break
        time.sleep(2 * (i + 1))
    raise ReportError(f"gh api {' '.join(args[:2])} failed: {last}")


def gh_graphql(query: str, variables: Optional[dict[str, Any]] = None, *, gh_bin: str = "gh") -> dict[str, Any]:
    args = ["graphql", "-f", f"query={query}"]
    for key, value in (variables or {}).items():
        args += ["-F" if isinstance(value, (int, bool)) else "-f", f"{key}={value}"]
    data = gh_json(args, gh_bin=gh_bin)
    if not isinstance(data, dict) or "data" not in data:
        raise ReportError(f"graphql: unexpected reply {str(data)[:200]}")
    if data.get("errors"):
        raise ReportError(f"graphql: {data['errors'][0].get('message', data['errors'])}")
    return data["data"]


def split_repo(full: str) -> tuple[str, str]:
    owner, _, name = full.partition("/")
    if not owner or not name or "/" in name:
        raise ReportError(f"repository must be owner/name, got {full!r}")
    return owner, name


def search_prs(query: str, *, gh_bin: str = "gh", fields: str) -> list[dict[str, Any]]:
    """All PR nodes for a GitHub search query (paginates, at most 1000 results)."""
    gql = (
        "query($q:String!,$after:String){search(query:$q,type:ISSUE,first:50,after:$after){"
        "issueCount pageInfo{hasNextPage endCursor} nodes{... on PullRequest{" + fields + "}}}}"
    )
    nodes: list[dict[str, Any]] = []
    after: Optional[str] = None
    while True:
        variables: dict[str, Any] = {"q": query}
        if after:
            variables["after"] = after
        data = gh_graphql(gql, variables, gh_bin=gh_bin)["search"]
        nodes.extend(n for n in data["nodes"] if n)
        if not data["pageInfo"]["hasNextPage"] or len(nodes) >= 1000:
            return nodes
        after = data["pageInfo"]["endCursor"]


def search_count(query: str, *, gh_bin: str = "gh") -> int:
    gql = "query($q:String!){search(query:$q,type:ISSUE,first:1){issueCount}}"
    return int(gh_graphql(gql, {"q": query}, gh_bin=gh_bin)["search"]["issueCount"])


def login_of(node: dict[str, Any]) -> str:
    author = node.get("author") or {}
    return author.get("login") or "ghost"


# ---------------------------------------------------------------- output

def write_json(path: Optional[str], payload: dict[str, Any]) -> None:
    text = json.dumps(payload, ensure_ascii=False, indent=2, default=str)
    if path and path != "-":
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text + "\n")
    else:
        print(text)


def group_rows(items: Iterable[dict[str, Any]], key: str) -> dict[str, list[dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    for item in items:
        groups.setdefault(str(item.get(key) or "—"), []).append(item)
    return groups

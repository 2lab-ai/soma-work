#!/usr/bin/env python3
"""Render collector JSON into one infographic PNG per report.

usage:
  render_report.py [--rol rol.json] [--github github.json] --out-dir DIR
                   [--title-rol TEXT] [--title-github TEXT] [--top 8] [--font PATH]

Writes DIR/rol.png and/or DIR/github.png and prints a short Slack-ready summary
(markdown) of every report to stdout. Drawing uses Pillow directly — no browser,
so it works inside a sandbox that forbids launching Chromium.

Exit codes: 0 ok · 2 bad input · 3 PNG unavailable (Pillow or a CJK font missing;
the summary is still printed so the caller can post text).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))
import report_common as rc  # noqa: E402

# Metric colors: dataviz reference palette slots 1-3 (validated light; aqua < 3:1, so
# every bar carries a visible value label and the table repeats the numbers).
C_REVIEW, C_MERGE, C_DEPLOY = "#2a78d6", "#eb6834", "#1baf7a"
PAGE, SURFACE, RING = "#f9f9f7", "#fcfcfb", "#e4e3df"
INK, INK2, MUTED, GRID, AXIS = "#0b0b0b", "#52514e", "#898781", "#e1e0d9", "#c3c2b7"
FONT_CANDIDATES = (  # (path, regular index, semibold index)
    ("/System/Library/Fonts/AppleSDGothicNeo.ttc", 0, 4),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 1, 1),
    ("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", 1, 1),
    ("/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc", 1, 1),
    ("/System/Library/Fonts/Supplemental/AppleGothic.ttf", 0, 0),
)
WIDTH, MARGIN, GAP, SCALE = 1200, 40, 16, 2


class PngUnavailable(RuntimeError):
    pass


def d(sec: Optional[float]) -> str:
    return rc.fmt_duration(sec)


def pct(v: Optional[float]) -> str:
    return "—" if v is None else f"{v * 100:.0f}%"


def num(v: Optional[float], digits: int = 1) -> str:
    return "—" if v is None else f"{v:.{digits}f}"


def short_repo(name: str) -> str:
    return str(name).split("/")[-1]


def stat_meta(stats: dict[str, Any], unit: str) -> str:
    if not stats.get("n"):
        return "이 구간에 데이터 없음"
    return f"중앙값 {d(stats['median'])} · p90 {d(stats['p90'])} · {stats['n']}{unit}"


# ---------------------------------------------------------------- canvas

class Canvas:
    """Logical-pixel drawing surface (SCALE× backing image), grown top-down by a y cursor."""

    def __init__(self, font: Optional[str] = None, height: int = 9000):
        try:
            from PIL import Image, ImageDraw, ImageFont
        except ImportError as exc:
            raise PngUnavailable("Pillow is not installed (python3 -m pip install --user pillow)") from exc
        self.Image, self.ImageFont = Image, ImageFont
        self.path, self.idx = self._find_font(font)
        self.img = Image.new("RGB", (WIDTH * SCALE, height * SCALE), PAGE)
        self.draw = ImageDraw.Draw(self.img)
        self.fonts: dict[tuple[float, bool], Any] = {}
        self.y = MARGIN

    @staticmethod
    def _find_font(explicit: Optional[str]) -> tuple[str, tuple[int, int]]:
        explicit = explicit or os.environ.get("DEV_REPORT_FONT")
        if explicit:
            if not Path(explicit).is_file():
                raise PngUnavailable(f"font not found: {explicit}")
            return explicit, (0, 0)
        for path, regular, semibold in FONT_CANDIDATES:
            if Path(path).is_file():
                return path, (regular, semibold)
        raise PngUnavailable("no CJK font found (set DEV_REPORT_FONT to a .ttf/.ttc/.otf with Hangul)")

    def font(self, size: float, bold: bool = False):
        key = (size, bold)
        if key not in self.fonts:
            self.fonts[key] = self.ImageFont.truetype(self.path, int(size * SCALE), index=self.idx[1 if bold else 0])
        return self.fonts[key]

    def tw(self, text: str, size: float, bold: bool = False) -> float:
        return self.font(size, bold).getlength(text) / SCALE

    def text(self, x: float, y: float, text: str, size: float, fill: str = INK, bold: bool = False,
             anchor: str = "lt") -> None:
        self.draw.text((x * SCALE, y * SCALE), text, font=self.font(size, bold), fill=fill, anchor=anchor)

    def fit(self, text: str, size: float, max_w: float, bold: bool = False) -> str:
        if self.tw(text, size, bold) <= max_w:
            return text
        while text and self.tw(text + "…", size, bold) > max_w:
            text = text[:-1]
        return text + "…"

    def wrap(self, text: str, size: float, max_w: float) -> list[str]:
        lines, cur = [], ""
        for word in text.split(" "):
            trial = f"{cur} {word}".strip()
            if self.tw(trial, size) <= max_w:
                cur = trial
                continue
            if cur:
                lines.append(cur)
            cur = word
            while self.tw(cur, size) > max_w:  # a single over-long word: break by characters
                cut = len(cur)
                while cut > 1 and self.tw(cur[:cut], size) > max_w:
                    cut -= 1
                lines.append(cur[:cut])
                cur = cur[cut:]
        if cur:
            lines.append(cur)
        return lines

    def rect(self, x: float, y: float, w: float, h: float, fill: str, radius: float = 0, outline: Optional[str] = None) -> None:
        box = [x * SCALE, y * SCALE, (x + w) * SCALE, (y + h) * SCALE]
        self.draw.rounded_rectangle(box, radius=radius * SCALE, fill=fill, outline=outline, width=SCALE if outline else 0)

    def card(self, x: float, y: float, w: float, h: float) -> None:
        self.rect(x, y, w, h, SURFACE, 14, RING)

    def hbar(self, x: float, y: float, w: float, h: float, color: str) -> None:
        """Bar growing right from a square baseline to a 4px rounded data end."""
        w = max(w, 2)
        self.rect(x, y, w, h, color, min(4, w / 2))
        if w > 4:
            self.rect(x, y, min(4, w - 4), h, color)

    def vbar(self, x: float, base: float, w: float, h: float, color: str) -> None:
        if h <= 0:
            return
        self.rect(x, base - h, w, h, color, min(4, h / 2))
        if h > 4:
            self.rect(x, base - min(4, h - 4), w, min(4, h - 4), color)

    def save(self, path: Path) -> None:
        self.img.crop((0, 0, WIDTH * SCALE, int((self.y + MARGIN - GAP) * SCALE))).save(path, "PNG", optimize=True)


# ---------------------------------------------------------------- blocks

def header(cv: Canvas, title: str, sub: str, window: dict[str, str]) -> None:
    cv.text(MARGIN, cv.y, title, 28, bold=True)
    cv.text(MARGIN, cv.y + 40, cv.fit(sub, 14, 760), 14, INK2)
    right = WIDTH - MARGIN
    cv.text(right, cv.y + 6, f"{window['since_local']} → {window['until_local']}", 14, INK2, anchor="rt")
    cv.text(right, cv.y + 26, window["tz"], 14, MUTED, anchor="rt")
    cv.y += 78


def tiles(cv: Canvas, items: list[dict[str, Any]], height: float = 132) -> None:
    """Stat tiles: {label, value, meta, color?}. Value sized to fit the tile."""
    n = len(items)
    w = (WIDTH - 2 * MARGIN - GAP * (n - 1)) / n
    for i, it in enumerate(items):
        x = MARGIN + i * (w + GAP)
        cv.card(x, cv.y, w, height)
        lx = x + 22
        if it.get("color"):
            cv.rect(lx, cv.y + 24, 10, 10, it["color"], 3)
            lx += 18
        cv.text(lx, cv.y + 20, cv.fit(it["label"], 15, w - (lx - x) - 16), 15, INK2)
        size = 44
        while size > 26 and cv.tw(it["value"], size, True) > w - 44:
            size -= 2
        cv.text(x + 22, cv.y + 48, it["value"], size, bold=True)
        cv.text(x + 22, cv.y + height - 32, cv.fit(it.get("meta", ""), 13, w - 44), 13, INK2)
    cv.y += height + GAP


def kpis(cv: Canvas, items: list[tuple[str, str, str]]) -> None:
    n = len(items)
    w = (WIDTH - 2 * MARGIN - 12 * (n - 1)) / n
    for i, (label, value, small) in enumerate(items):
        x = MARGIN + i * (w + 12)
        cv.card(x, cv.y, w, 78)
        cv.text(x + 16, cv.y + 14, cv.fit(label, 12.5, w - 28), 12.5, INK2)
        cv.text(x + 16, cv.y + 36, value, 24, bold=True)
        if small:
            cv.text(x + 22 + cv.tw(value, 24, True), cv.y + 46, cv.fit(small, 13, w - 40 - cv.tw(value, 24, True)), 13, INK2)
    cv.y += 78 + GAP


def bar_panel(cv: Canvas, x: float, y: float, w: float, title: str, caption: str,
              rows: list[tuple[str, Optional[float], str]], color: str) -> float:
    """Horizontal bars on one scale; returns the card height."""
    rows = [r for r in rows if r[1] is not None]
    row_h, top_pad = 26, 66
    h = top_pad + max(1, len(rows)) * row_h + 14
    cv.card(x, y, w, h)
    cv.text(x + 22, y + 18, cv.fit(title, 16, w - 44), 16, bold=True)
    cv.text(x + 22, y + 40, cv.fit(caption, 12.5, w - 44), 12.5, MUTED)
    if not rows:
        cv.text(x + 22, y + top_pad + 4, "이 구간에 해당 데이터 없음", 13, MUTED)
        return h
    name_w = min(w * 0.4, max(cv.tw(r[0], 13.5) for r in rows) + 4)
    track_x = x + 22 + name_w + 12
    labels = [d(r[1]) + (f" · {r[2]}" if r[2] else "") for r in rows]
    track_w = w - (track_x - x) - 22 - max(cv.tw(t, 12.5) for t in labels) - 10
    top = max(r[1] for r in rows) or 1.0
    cv.rect(track_x, y + top_pad - 4, 1, len(rows) * row_h, AXIS)
    for i, ((name, sec, _), label) in enumerate(zip(rows, labels)):
        ry = y + top_pad + i * row_h
        cv.text(track_x - 12, ry + 1, cv.fit(name, 13.5, name_w), 13.5, INK, anchor="rt")
        bw = max(2.0, track_w * sec / top)
        cv.hbar(track_x + 1, ry + 2, bw, 14, color)
        cv.text(track_x + 1 + bw + 8, ry + 1, label, 12.5, INK2)
    return h


def panels(cv: Canvas, left: tuple, right: tuple) -> None:
    w = (WIDTH - 2 * MARGIN - GAP) / 2
    h1 = bar_panel(cv, MARGIN, cv.y, w, *left)
    h2 = bar_panel(cv, MARGIN + w + GAP, cv.y, w, *right)
    cv.y += max(h1, h2) + GAP


def hourly(cv: Canvas, counts: list[int], tz: str) -> None:
    h, x, w = 200, MARGIN, WIDTH - 2 * MARGIN
    cv.card(x, cv.y, w, h)
    cv.text(x + 22, cv.y + 18, "시간대별 리뷰 시작", 16, bold=True)
    cv.text(x + 22, cv.y + 40, f"{tz} 기준 0–23시 · 막대 위 숫자 = 리뷰 시작 횟수", 12.5, MUTED)
    base, plot_h = cv.y + h - 34, 90
    slot = (w - 44) / 24
    top = max(counts) or 1
    cv.rect(x + 22, base, w - 44, 1, AXIS)
    for i, n in enumerate(counts):
        cx = x + 22 + i * slot
        bh = plot_h * n / top
        bw = min(24, slot - 8)
        cv.vbar(cx + (slot - bw) / 2, base, bw, bh, C_REVIEW)
        if n:
            cv.text(cx + slot / 2, base - bh - 16, str(n), 10.5, INK2, anchor="mt")
        if i % 3 == 0:
            cv.text(cx + slot / 2, base + 6, f"{i}시", 10.5, MUTED, anchor="mt")
    cv.y += h + GAP


def table(cv: Canvas, title: str, caption: str, headers: list[str], rows: list[list[str]]) -> None:
    if not rows:
        return
    x, w = MARGIN, WIDTH - 2 * MARGIN
    row_h, top_pad = 30, 70
    h = top_pad + (len(rows) + 1) * row_h + 10
    cv.card(x, cv.y, w, h)
    cv.text(x + 22, cv.y + 18, title, 16, bold=True)
    cv.text(x + 22, cv.y + 40, caption, 12.5, MUTED)
    inner = w - 44
    widths = [max(cv.tw(str(r[i]), 13.5) for r in rows + [headers]) + 18 for i in range(len(headers))]
    rest = sum(widths[1:])
    widths[0] = max(120.0, min(widths[0], inner - rest))
    if sum(widths) < inner:  # spread spare width over the number columns
        spare = (inner - sum(widths)) / max(1, len(widths) - 1)
        widths = [widths[0]] + [c + spare for c in widths[1:]]
    y = cv.y + top_pad
    for r_i, row in enumerate([headers] + rows):
        cx = x + 22
        ry = y + r_i * row_h
        for c_i, cell in enumerate(row):
            cell = str(cell)
            bold, fill = (True, INK2) if r_i == 0 else (False, INK)
            if c_i == 0:
                cv.text(cx, ry + 7, cv.fit(cell, 13.5, widths[0] - 10, bold), 13.5, fill, bold)
            else:
                cv.text(cx + widths[c_i] - 4, ry + 7, cell, 13.5, fill, bold, anchor="rt")
            cx += widths[c_i]
        cv.rect(x + 22, ry + row_h - 1, inner, 1, AXIS if r_i == 0 else GRID)
    cv.y += h + GAP


def footer(cv: Canvas, definition: str, slow_title: str, slow: list[str], notes: list[str], source: str) -> None:
    x, w = MARGIN, WIDTH - 2 * MARGIN
    inner = w - 44
    lines: list[tuple[str, str, bool]] = [(ln, INK2, False) for ln in cv.wrap("정의 · " + definition, 12.5, inner)]
    if slow:
        lines.append((slow_title, INK, True))
        lines += [(cv.fit("• " + s, 12.5, inner), INK2, False) for s in slow]
    for n in notes:
        lines += [(ln, INK2, False) for ln in cv.wrap("참고 · " + n, 12.5, inner)]
    lines += [(ln, MUTED, False) for ln in cv.wrap(source, 12.5, inner)]
    h = 36 + len(lines) * 20
    cv.card(x, cv.y, w, h)
    for i, (ln, fill, bold) in enumerate(lines):
        cv.text(x + 22, cv.y + 18 + i * 20, ln, 12.5, fill, bold)
    cv.y += h + GAP


# ---------------------------------------------------------------- reports

def rol_summary(rep: dict[str, Any], title: str) -> str:
    t, w = rep["totals"], rep["window"]
    return (f"*{title}* ({w['since_local']} → {w['until_local']} {w['tz']})\n"
            f"• 평균 리뷰 소요 *{d(t['review_sec']['mean'])}* (중앙값 {d(t['review_sec']['median'])}, {t['review_sec']['n']}회)\n"
            f"• 평균 리뷰 시작→머지 *{d(t['review_to_merge_sec']['mean'])}* (중앙값 {d(t['review_to_merge_sec']['median'])}, {t['merged']}개 PR)\n"
            f"• 리뷰 {t['attempts']}회 · 성공률 {pct(t.get('success_rate'))} · PR당 {num(t.get('rounds_per_pr'))}회")


def draw_rol(cv: Canvas, rep: dict[str, Any], title: str, top: int) -> None:
    t = rep["totals"]
    repos = rep.get("source", {}).get("repos") or [r["repo"] for r in rep["by_repo"]]
    header(cv, title, "리뷰 대상: " + ", ".join(short_repo(r) for r in repos), rep["window"])
    tiles(cv, [
        {"label": "평균 리뷰 소요", "value": d(t["review_sec"]["mean"]), "meta": stat_meta(t["review_sec"], "회"), "color": C_REVIEW},
        {"label": "평균 리뷰 시작 → 머지", "value": d(t["review_to_merge_sec"]["mean"]),
         "meta": stat_meta(t["review_to_merge_sec"], "PR"), "color": C_MERGE},
    ])
    kpis(cv, [
        ("리뷰 실행", f"{t['attempts']:,}", f"성공 {t['succeeded']}"),
        ("성공률", pct(t.get("success_rate")), f"실패 {t['failed']}"),
        ("리뷰한 PR", f"{t['prs']:,}", ""),
        ("PR당 리뷰", num(t.get("rounds_per_pr")), "회"),
        ("머지된 PR", f"{t['merged']:,}", f"리뷰 없이 {t.get('merged_unreviewed', 0)}"),
        ("머지까지 리뷰", num(t.get("rounds_to_merge")), "회"),
    ])
    by_repo, by_user = rep["by_repo"], (rep.get("by_user") or [])[:top]
    panels(cv,
           ("레포별 평균 리뷰 소요", "리뷰 시작 → 리뷰 게시 · 성공한 리뷰만",
            [(short_repo(r["repo"]), r["review_sec"]["mean"], f"{r['succeeded']}회") for r in by_repo], C_REVIEW),
           ("레포별 평균 리뷰 시작 → 머지", "PR의 첫 리뷰 시작 → 머지 · 이 구간에 머지된 PR",
            [(short_repo(r["repo"]), r["review_to_merge_sec"]["mean"], f"{r['merged']}PR") for r in by_repo], C_MERGE))
    if by_user:
        panels(cv,
               ("유저별 평균 리뷰 소요", "PR 작성자 기준",
                [(r["author"], r["review_sec"]["mean"], f"{r['succeeded']}회") for r in by_user], C_REVIEW),
               ("유저별 평균 리뷰 시작 → 머지", "PR 작성자 기준",
                [(r["author"], r["review_to_merge_sec"]["mean"], f"{r['merged']}PR") for r in by_user], C_MERGE))
    hourly(cv, rep["hourly"], rep["window"]["tz"])
    hdr = ["", "리뷰", "성공", "실패", "평균 리뷰", "중앙값", "머지 PR", "리뷰→머지", "중앙값", "머지까지 리뷰"]

    def row(name: str, r: dict[str, Any]) -> list[str]:
        return [name, str(r["attempts"]), str(r["succeeded"]), str(r["failed"]), d(r["review_sec"]["mean"]),
                d(r["review_sec"]["median"]), str(r["merged"]), d(r["review_to_merge_sec"]["mean"]),
                d(r["review_to_merge_sec"]["median"]), num(r.get("rounds_to_merge"))]

    table(cv, "레포별 상세", "시간은 평균 · 중앙값, 모두 이 구간 기준", hdr, [row(short_repo(r["repo"]), r) for r in by_repo])
    table(cv, "유저별 상세", f"PR 작성자 상위 {top}명", hdr, [row(r["author"], r) for r in by_user])
    footer(cv,
           "리뷰 소요 = RoL 리뷰 시작 → 리뷰 게시(성공한 리뷰). 리뷰 시작 → 머지 = PR의 첫 RoL 리뷰 시작 → 머지(이 구간에 머지된 PR). "
           "머지까지 리뷰 = 머지 전 리뷰 실행 횟수. 실패 = 실패·중단·만료된 리뷰.",
           "가장 오래 걸린 리뷰",
           [f"{short_repo(s['repo'])}#{s['pr']} {s['title']} — {d(s['review_sec'])}" for s in rep.get("slowest") or []],
           rep.get("notes") or [],
           "출처: RoL 대시보드 저장소(리뷰 실행 기록) · GitHub(PR 작성자 · 머지 시각)")


def github_summary(rep: dict[str, Any], title: str) -> str:
    t, w = rep["totals"], rep["window"]
    label = rep.get("deploy_label") or "배포"
    lines = [f"*{title}* ({w['since_local']} → {w['until_local']} {w['tz']})",
             f"• 열린 PR {t['opened']} · 머지 {t['merged']} · 지금 열린 PR {t.get('open_now', 0)}",
             f"• 평균 리드타임 *{d(t['lead_sec']['mean'])}* · 평균 게이트 *{d(t['gate_sec']['mean'])}*"]
    if rep.get("source", {}).get("deploy_repos"):
        lines.append(f"• 평균 {label} 배포 *{d(t['deploy_sec']['mean'])}* ({t['deploy_sec']['n']}건, 미반영 {t['deploy_pending']}건)")
    return "\n".join(lines)


def draw_github(cv: Canvas, rep: dict[str, Any], title: str, top: int) -> None:
    t = rep["totals"]
    label = rep.get("deploy_label") or "배포"
    has_deploy = bool(rep.get("source", {}).get("deploy_repos"))
    header(cv, title, "레포: " + ", ".join(short_repo(r) for r in rep.get("source", {}).get("repos") or []), rep["window"])
    items = [
        {"label": "열린 PR / 머지된 PR", "value": f"{t['opened']} / {t['merged']}", "meta": f"지금 열려 있는 PR {t.get('open_now', 0)}개"},
        {"label": "평균 리드타임 (열림 → 머지)", "value": d(t["lead_sec"]["mean"]), "meta": stat_meta(t["lead_sec"], "PR"), "color": C_MERGE},
        {"label": "평균 게이트 시간", "value": d(t["gate_sec"]["mean"]), "meta": stat_meta(t["gate_sec"], "PR"), "color": C_REVIEW},
    ]
    if has_deploy:
        meta = stat_meta(t["deploy_sec"], "PR")
        if t.get("deploy_pending"):
            meta += f" · 미반영 {t['deploy_pending']}"
        items.append({"label": f"평균 {label} 배포 (머지 → 배포)", "value": d(t["deploy_sec"]["mean"]), "meta": meta, "color": C_DEPLOY})
    tiles(cv, items)
    by_user = (rep.get("by_user") or [])[:top]
    panels(cv,
           ("게이트별 평균 소요", "머지된 PR의 최종 커밋 · 게이트 시작(대기 포함) → 완료",
            [(g["name"], g["mean"], f"{g['n']}PR") for g in rep.get("gates") or []], C_REVIEW),
           ("유저별 평균 리드타임", "PR 작성자 기준 · 이 구간에 머지된 PR",
            [(r["author"], r["lead_sec"]["mean"], f"{r['merged']}PR") for r in by_user], C_MERGE))
    if rep.get("by_repo") and has_deploy:
        dep_rows = [(short_repo(r["repo"]), r["deploy_sec"]["mean"], f"{r['deploy_sec']['n']}PR")
                    for r in rep["by_repo"] if r.get("deploy_tracked")]
        panels(cv,
               ("레포별 평균 리드타임", "이 구간에 머지된 PR",
                [(short_repo(r["repo"]), r["lead_sec"]["mean"], f"{r['merged']}PR") for r in rep["by_repo"]], C_MERGE),
               (f"레포별 평균 {label} 배포", f"머지 → {label} 배포 완료", dep_rows, C_DEPLOY))
    hdr = ["", "열림", "머지", "평균 리드타임", "중앙값", "평균 게이트"] + ([f"평균 {label} 배포", "미반영"] if has_deploy else [])

    def row(name: str, r: dict[str, Any]) -> list[str]:
        out = [name, str(r["opened"]), str(r["merged"]), d(r["lead_sec"]["mean"]), d(r["lead_sec"]["median"]), d(r["gate_sec"]["mean"])]
        if has_deploy:
            tracked = r.get("deploy_tracked", 0)
            out += [d(r["deploy_sec"]["mean"]) if tracked else "—", str(r["deploy_pending"]) if tracked else "—"]
        return out

    if rep.get("by_repo"):
        table(cv, "레포별", "열린 PR = 집계 시점에 열려 있는 PR(배포 브랜치 대상 제외)",
              hdr[:1] + ["열린 PR"] + hdr[1:],
              [[short_repo(r["repo"]), str(r.get("open_now", 0))] + row("", r)[1:] for r in rep["by_repo"]])
    table(cv, "유저별", f"PR 작성자 상위 {top}명", hdr, [row(r["author"], r) for r in by_user])
    deploy_def = f" {label} 배포 = 머지 → 그 머지를 포함한 첫 배포 워크플로 성공 완료(아직 없으면 미반영)." if has_deploy else ""
    footer(cv,
           "리드타임 = PR 생성 → 머지. 게이트 시간 = 머지된 PR의 최종 커밋에서 첫 체크·상태 시작 → 마지막 완료(대기 포함)."
           + deploy_def + " 배포 브랜치로 가는 PR은 셈에서 뺀다.",
           "리드타임이 가장 긴 PR",
           [f"{short_repo(s['repo'])}#{s['number']} {s.get('title') or ''} — {d(s.get('lead_sec'))}" for s in rep.get("slowest") or []],
           rep.get("notes") or [],
           "출처: GitHub API(PR · 체크 · 커밋 상태 · 워크플로 실행)")


def main(argv: Optional[list[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--rol")
    ap.add_argument("--github")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--title-rol", default="Review of Legends · 지난 24시간")
    ap.add_argument("--title-github", default="GitHub PR 흐름 · 지난 24시간")
    ap.add_argument("--top", type=int, default=8)
    ap.add_argument("--font", help="CJK font file (default: system Apple SD Gothic Neo / Noto Sans CJK)")
    args = ap.parse_args(argv)
    if not args.rol and not args.github:
        ap.error("give --rol and/or --github")
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    jobs = []
    try:
        for name, path, draw, summarize, title in (
            ("rol", args.rol, draw_rol, rol_summary, args.title_rol),
            ("github", args.github, draw_github, github_summary, args.title_github),
        ):
            if path:
                rep = json.loads(Path(path).read_text(encoding="utf-8"))
                if rep.get("kind") != name:
                    raise rc.ReportError(f"{path}: expected kind {name!r}, got {rep.get('kind')!r}")
                jobs.append((name, rep, draw, title, summarize(rep, title)))
    except (OSError, ValueError, KeyError, rc.ReportError) as exc:
        print(f"render_report: {exc}", file=sys.stderr)
        return 2
    print("\n\n".join(job[4] for job in jobs))
    try:
        for name, rep, draw, title, _ in jobs:
            cv = Canvas(args.font)
            draw(cv, rep, title, args.top)
            cv.save(out / f"{name}.png")
            print(f"render_report: wrote {out / f'{name}.png'}", file=sys.stderr)
    except PngUnavailable as exc:
        print(f"render_report: PNG unavailable — {exc}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())

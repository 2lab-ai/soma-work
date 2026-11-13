"""Offline tests for the dev-daily-report engine (no network, no gh, no real store).

Run: python3 -B src/local/skills/dev-daily-report/__tests__/py/dev_daily_report_test.py
"""

from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"
sys.path.insert(0, str(SCRIPTS))

import collect_github as cg  # noqa: E402
import collect_rol as cr  # noqa: E402
import report_common as rc  # noqa: E402

T0 = datetime(2026, 11, 12, 0, 0, tzinfo=timezone.utc)  # window start
T1 = T0 + timedelta(hours=24)


def at(minutes: float) -> str:
    return (T0 + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S+00:00")


def has_pillow() -> bool:
    try:
        import PIL  # noqa: F401
        return True
    except ImportError:
        return False


class CommonTest(unittest.TestCase):
    def test_summarize(self):
        s = rc.summarize([60, 120, 180, 240, None])
        self.assertEqual(s["n"], 4)
        self.assertEqual(s["mean"], 150)
        self.assertEqual(s["median"], 150)
        self.assertAlmostEqual(s["p90"], 222)
        self.assertEqual(rc.summarize([])["mean"], None)

    def test_fmt_duration(self):
        self.assertEqual(rc.fmt_duration(None), "—")
        self.assertEqual(rc.fmt_duration(45), "45초")
        self.assertEqual(rc.fmt_duration(252), "4분 12초")
        self.assertEqual(rc.fmt_duration(1500), "25분")
        self.assertEqual(rc.fmt_duration(3 * 3600 + 300), "3시간 5분")
        self.assertEqual(rc.fmt_duration(2 * 86400 + 4 * 3600), "2일 4시간")

    def test_window_defaults_to_now_floored_to_minute(self):
        now = datetime(2026, 11, 13, 0, 0, 37, tzinfo=timezone.utc)
        start, end = rc.resolve_window(None, None, 24, now=now)
        self.assertEqual(end, datetime(2026, 11, 13, 0, 0, tzinfo=timezone.utc))
        self.assertEqual(start, end - timedelta(hours=24))
        with self.assertRaises(rc.ReportError):
            rc.resolve_window(rc.iso(end), rc.iso(start), 24)

    def test_parse_ts_accepts_z_and_offset(self):
        self.assertEqual(rc.parse_ts("2026-11-12T00:00:00Z"), T0)
        self.assertEqual(rc.parse_ts("2026-11-12T09:00:00+09:00"), T0)


def make_store(path: Path) -> None:
    """A RoL dashboard store with the columns the collector reads."""
    conn = sqlite3.connect(str(path))
    conn.executescript("""
        CREATE TABLE runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, repo TEXT, pr INTEGER, head_sha TEXT,
          title TEXT, url TEXT, status TEXT, review_url TEXT, created_at TEXT, updated_at TEXT);
        CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, run_id TEXT, payload TEXT, created_at TEXT);
    """)
    runs = [
        # id, repo, pr, status, start, updated, terminal event (None = none recorded)
        ("r1", "acme/api", 1, "succeeded", -120, -110, -110),    # before the window: first review of PR 1
        ("r2", "acme/api", 1, "succeeded", 60, 70, 66),           # 6 min (event wins over updated_at)
        ("r3", "acme/api", 2, "succeeded", 100, 104, None),       # 4 min from updated_at
        ("r4", "acme/api", 2, "failed", 200, 230, 230),
        ("r5", "acme/web", 7, "succeeded", 300, 310, 310),        # 10 min
        ("r6", "acme/web", 7, "running", 1400, 1401, None),
        ("r7", "acme/other", 9, "succeeded", 50, 55, 55),         # filtered out by repos
    ]
    for rid, repo, pr, status, start, upd, ev in runs:
        conn.execute("INSERT INTO runs (id, repo, pr, head_sha, title, url, status, review_url, created_at, updated_at)"
                     " VALUES (?,?,?,?,?,?,?,?,?,?)",
                     (rid, repo, pr, "sha", f"PR {pr}", f"https://example.com/{repo}/pull/{pr}", status, "",
                      at(start), at(upd)))
        conn.execute("INSERT INTO events (kind, run_id, payload, created_at) VALUES ('run_started', ?, '{}', ?)",
                     (rid, at(start)))
        if ev is not None:
            conn.execute("INSERT INTO events (kind, run_id, payload, created_at) VALUES ('run_updated', ?, ?, ?)",
                         (rid, json.dumps({"status": status}), at(ev)))
            conn.execute("INSERT INTO events (kind, run_id, payload, created_at) VALUES ('run_updated', ?, ?, ?)",
                         (rid, json.dumps({"status": status}), at(ev + 30)))  # a later same-status update
    conn.commit()
    conn.close()


class RolTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "dashboard.sqlite3"
        make_store(self.db)
        work = Path(self.tmp.name) / "copy"
        work.mkdir()
        conn = sqlite3.connect(str(cr.snapshot(self.db, str(work))))
        self.runs = cr.load_runs(conn)
        conn.close()

    def tearDown(self):
        self.tmp.cleanup()

    def test_end_time_prefers_first_terminal_event(self):
        by_id = {r["id"]: r for r in self.runs}
        self.assertEqual(rc.seconds_between(by_id["r2"]["start"], by_id["r2"]["end"]), 360)
        self.assertEqual(rc.seconds_between(by_id["r3"]["start"], by_id["r3"]["end"]), 240)
        self.assertIsNone(by_id["r6"]["end"])

    def test_report_numbers(self):
        prs = {("acme/api", 1): {"author": {"login": "ann"}}, ("acme/api", 2): {"author": {"login": "bob"}},
               ("acme/web", 7): {"author": {"login": "ann"}}}
        merged = {"acme/api": [{"number": 1, "title": "one", "url": "u1", "mergedAt": at(180), "author": {"login": "ann"}},
                               {"number": 5, "title": "never reviewed", "url": "u5", "mergedAt": at(190), "author": {"login": "cy"}}],
                  "acme/web": []}
        rep = cr.build_report(self.runs, T0, T1, "Asia/Seoul", ["acme/api", "acme/web"], prs, merged, {"db": "x"})
        t = rep["totals"]
        self.assertEqual(t["attempts"], 5)                       # r2 r3 r4 r5 r6 (r1 before, r7 filtered)
        self.assertEqual(t["succeeded"], 3)
        self.assertEqual(t["failed"], 1)
        self.assertAlmostEqual(t["success_rate"], 3 / 4)          # running is not finished
        self.assertEqual(t["review_sec"]["n"], 3)
        self.assertAlmostEqual(t["review_sec"]["mean"], (360 + 240 + 600) / 3)
        self.assertEqual(t["merged"], 1)
        self.assertEqual(t["merged_unreviewed"], 1)
        self.assertEqual(t["review_to_merge_sec"]["mean"], 300 * 60)  # first review ever (-120) -> merge (180)
        self.assertEqual(t["rounds_to_merge"], 2)                 # r1 and r2 before the merge
        users = {u["author"]: u for u in rep["by_user"]}
        self.assertEqual(users["ann"]["attempts"], 3)
        self.assertEqual(users["ann"]["merged"], 1)
        self.assertEqual(users["bob"]["review_sec"]["mean"], 240)
        repos = {r["repo"]: r for r in rep["by_repo"]}
        self.assertEqual(repos["acme/web"]["review_sec"]["mean"], 600)
        self.assertEqual(sum(rep["hourly"]), 5)
        self.assertEqual(rep["hourly"][10], 2)                   # 01:xx UTC = 10:xx KST (r2, r3)
        self.assertEqual([s["pr"] for s in rep["slowest"]], [7, 1, 2])  # one line per PR
        self.assertTrue(any("진행 중" in n for n in rep["notes"]))

    def test_without_github(self):
        rep = cr.build_report(self.runs, T0, T1, "Asia/Seoul", None, {}, None, {})
        self.assertEqual(rep["by_user"], [])
        self.assertIsNone(rep["totals"]["review_to_merge_sec"]["mean"])
        self.assertTrue(any("GitHub" in n for n in rep["notes"]))

    def test_cli_reports_missing_store(self):
        proc = subprocess.run([sys.executable, "-B", str(SCRIPTS / "collect_rol.py"), "--db", "/nonexistent/x.sqlite3",
                               "--no-github"], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("not found", proc.stderr)

    def test_cli_offline_end_to_end(self):
        proc = subprocess.run([sys.executable, "-B", str(SCRIPTS / "collect_rol.py"), "--db", str(self.db), "--no-github",
                               "--since", rc.iso(T0), "--until", rc.iso(T1)], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        rep = json.loads(proc.stdout)
        self.assertEqual(rep["kind"], "rol")
        self.assertEqual(rep["totals"]["attempts"], 6)            # no repo filter: r7 counts


def check(name, start, end, suite=None):
    return {"__typename": "CheckRun", "name": name, "startedAt": start, "completedAt": end,
            "conclusion": "SUCCESS", "checkSuite": {"createdAt": suite or start}}


class GithubTest(unittest.TestCase):
    def node(self, base="develop"):
        return {"baseRefName": base, "commits": {"nodes": [{"commit": {"oid": "h", "statusCheckRollup": {"contexts": {"nodes": [
            check("test", at(1), at(11), suite=at(0)),
            check("lint", at(0), at(3)),
            {"__typename": "StatusContext", "context": "review/required/develop", "state": "SUCCESS", "createdAt": at(20)},
        ]}}}}]}}

    def test_gate_events_and_summary(self):
        statuses = [{"context": "review/required/develop", "state": "pending", "created_at": at(2)},
                    {"context": "review/required/develop", "state": "success", "created_at": at(20)},
                    {"context": "review/reviewed/develop", "state": "success", "created_at": at(21)}]
        events = cg.gate_events(self.node(), statuses, None)
        names = sorted(e["name"] for e in events)
        self.assertEqual(names, ["lint", "review/required", "review/reviewed", "test"])  # base suffix folded
        total, per = cg.gate_summary(events)
        self.assertEqual(total, 21 * 60)                          # first start (0) -> last end (21)
        per = dict(per)
        self.assertEqual(per["test"], 11 * 60)                    # queue included: suite created at 0
        self.assertEqual(per["review/required"], 18 * 60)         # pending (2) -> success (20)
        self.assertEqual(per["review/reviewed"], 21 * 60)         # single status: from the first gate start
        only = cg.gate_events(self.node(), statuses, __import__("re").compile("^review/"))
        self.assertEqual(sorted(e["name"] for e in only), ["review/required", "review/reviewed"])

    def test_no_gates(self):
        self.assertEqual(cg.gate_summary([]), (None, []))

    def test_first_containing_binary_search(self):
        runs = [{"head_sha": f"s{i}"} for i in range(9)]
        calls = []

        def contains(sha):
            calls.append(sha)
            return int(sha[1:]) >= 5

        self.assertEqual(cg.first_containing(runs, contains)["head_sha"], "s5")
        self.assertLessEqual(len(calls), 4)
        self.assertIsNone(cg.first_containing(runs, lambda s: False))
        self.assertIsNone(cg.first_containing([], lambda s: True))

    def test_parse_deploy(self):
        self.assertEqual(cg.parse_deploy("acme/api=deploy-dev.yml@deploy/dev"), ("acme/api", "deploy-dev.yml", "deploy/dev"))
        with self.assertRaises(rc.ReportError):
            cg.parse_deploy("acme/api@deploy/dev")

    def test_report_numbers(self):
        opened = [{"repo": "acme/api", "number": 1, "title": "a", "url": "", "author": "ann"},
                  {"repo": "acme/web", "number": 2, "title": "b", "url": "", "author": "bob"}]
        merged = [
            {"repo": "acme/api", "number": 1, "title": "a", "url": "", "author": "ann", "lead_sec": 3600,
             "gate_sec": 600, "gates": [("test", 600), ("review/reviewed", 300), ("review/reviewed/feat/x", 500)],
             "deploy_sec": 1800, "deploy_pending": False},
            {"repo": "acme/api", "number": 3, "title": "c", "url": "", "author": "bob", "lead_sec": 7200,
             "gate_sec": 1200, "gates": [("test", 1200), ("review/reviewed", 900)], "deploy_sec": None,
             "deploy_pending": True, "pending_sec": 4000},
            {"repo": "acme/web", "number": 4, "title": "d", "url": "", "author": "ann", "lead_sec": 600,
             "gate_sec": None, "gates": [], "deploy_sec": None, "deploy_pending": False},
        ]
        rep = cg.build_report(opened, merged, {"acme/api": 4, "acme/web": 1}, T0, T1, "Asia/Seoul", "dev",
                              ["acme/api"], ["acme/api", "acme/web"], True)
        t = rep["totals"]
        self.assertEqual((t["opened"], t["merged"], t["open_now"]), (2, 3, 5))
        self.assertAlmostEqual(t["lead_sec"]["mean"], (3600 + 7200 + 600) / 3)
        self.assertEqual(t["gate_sec"]["n"], 2)
        self.assertEqual(t["deploy_sec"]["n"], 1)
        self.assertEqual(t["deploy_pending"], 1)
        self.assertEqual(t["deploy_tracked"], 2)                  # web has no deploy workflow
        gates = {g["name"]: g for g in rep["gates"]}
        self.assertEqual(set(gates), {"test", "review/reviewed"})  # old-base context folded into its parent
        self.assertEqual(gates["review/reviewed"]["n"], 2)         # one value per PR (the slowest)
        self.assertEqual(gates["review/reviewed"]["mean"], (500 + 900) / 2)
        repos = {r["repo"]: r for r in rep["by_repo"]}
        self.assertEqual(repos["acme/web"]["deploy_tracked"], 0)
        self.assertEqual(repos["acme/api"]["open_now"], 4)
        self.assertEqual(rep["slowest"][0]["number"], 3)
        self.assertTrue(any("미반영 1건" in n for n in rep["notes"]))

    def test_single_repo_has_no_repo_breakdown(self):
        rep = cg.build_report([], [], {"acme/api": 0}, T0, T1, "Asia/Seoul", None, [], ["acme/api"], False)
        self.assertEqual(rep["by_repo"], [])
        self.assertTrue(any("게이트" in n for n in rep["notes"]))


class RenderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        db = self.dir / "dashboard.sqlite3"
        make_store(db)
        conn = sqlite3.connect(str(cr.snapshot(db, self.tmp.name)))
        runs = cr.load_runs(conn)
        conn.close()
        prs = {("acme/api", 1): {"author": {"login": "ann"}}, ("acme/api", 2): {"author": {"login": "bob"}},
               ("acme/web", 7): {"author": {"login": "ann"}}}
        merged = {"acme/api": [{"number": 1, "title": "one", "url": "u1", "mergedAt": at(180), "author": {"login": "ann"}}]}
        rol = cr.build_report(runs, T0, T1, "Asia/Seoul", ["acme/api", "acme/web"], prs, merged, {"repos": ["acme/api", "acme/web"]})
        gh = cg.build_report([], [{"repo": "acme/api", "number": 1, "title": "a", "url": "", "author": "ann", "lead_sec": 3600,
                                   "gate_sec": 600, "gates": [("test", 600)], "deploy_sec": 1800, "deploy_pending": False}],
                             {"acme/api": 2}, T0, T1, "Asia/Seoul", "dev", ["acme/api"], ["acme/api"], True)
        (self.dir / "rol.json").write_text(json.dumps(rol, default=str), encoding="utf-8")
        (self.dir / "github.json").write_text(json.dumps(gh, default=str), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def run_render(self, *extra):
        return subprocess.run([sys.executable, "-B", str(SCRIPTS / "render_report.py"), "--rol", str(self.dir / "rol.json"),
                               "--github", str(self.dir / "github.json"), "--out-dir", str(self.dir / "out"), *extra],
                              capture_output=True, text=True, timeout=120)

    def test_summary_always_printed(self):
        proc = self.run_render()
        self.assertIn(proc.returncode, (0, 3), proc.stderr)
        self.assertIn("평균 리뷰 소요 *6분 40초*", proc.stdout)    # (360 + 240 + 600) / 3 = 400 s
        self.assertIn("평균 리드타임 *1시간*", proc.stdout)
        self.assertIn("평균 dev 배포 *30분*", proc.stdout)

    def test_png_written_when_pillow_present(self):
        proc = self.run_render()
        if not has_pillow():
            self.assertEqual(proc.returncode, 3)
            self.assertIn("Pillow", proc.stderr)
            return
        if proc.returncode == 3:
            self.skipTest("no Hangul font on this host: " + proc.stderr.strip())
        self.assertEqual(proc.returncode, 0, proc.stderr)
        from PIL import Image
        for name in ("rol", "github"):
            with Image.open(self.dir / "out" / f"{name}.png") as img:
                self.assertEqual(img.size[0], 2400)
                self.assertGreater(img.size[1], 1000)

    def test_wrong_kind_rejected(self):
        proc = subprocess.run([sys.executable, "-B", str(SCRIPTS / "render_report.py"), "--rol", str(self.dir / "github.json"),
                               "--out-dir", str(self.dir / "out")], capture_output=True, text=True)
        self.assertEqual(proc.returncode, 2)
        self.assertIn("expected kind", proc.stderr)

    def test_missing_font_is_exit_3(self):
        if not has_pillow():
            self.skipTest("Pillow absent")
        proc = self.run_render("--font", "/nonexistent/font.ttf")
        self.assertEqual(proc.returncode, 3)
        self.assertIn("font not found", proc.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=1)

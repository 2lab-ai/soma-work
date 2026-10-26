#!/usr/bin/env python3
"""batch.py — html skill batch mode: one authored page, rendered once per reference.

The page is authored once (Steps 1–4) against the design-md-v3 token contract and carries four slots:
  <!--__AUDIT__-->        first line; replaced by the Step 3.4 audit comment
  <!--__FONT_LINKS__-->   in <head>; replaced by the adapter's font stylesheet links
  /*__TOKENS__*/          inside <style>; replaced by the adapter's :root {} block
  <!--__ATTRIBUTION__-->  before </body>; replaced by the footer (attribution, font layers, derived values)

For every reference, batch.py runs the SAME Step 3.4 resolver (the RESOLVE block, read from SKILL.md)
and the SAME adapter (ui-ux/scripts/designmd_tokens.py) a single run uses, then fills the slots. It
never skips: an unknown name or a reference without machine-readable tokens stops the batch.

Usage:
  python3 batch.py --page <page.html> --refs <name,name,…|omd-*> --out <dir>
                   [--uiux <ui-ux skill dir>] [--scripts hangul,latin] [--title <list title>]
  python3 batch.py --index-only --out <dir> [--title …]   # rebuild index.html after batch-qa.mjs

Writes <out>/<name>.html per reference, <out>/results.json and <out>/index.html (the result list,
with each page's QA status once <out>/qa.json exists). Exit 0 only when every page was written.
"""
import argparse
import hashlib
import html
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SKILL_MD = os.path.join(HERE, "..", "SKILL.md")
SLOTS = ("<!--__AUDIT__-->", "<!--__FONT_LINKS__-->", "/*__TOKENS__*/", "<!--__ATTRIBUTION__-->")
E = html.escape


def resolver_source():
    m = re.search(r"<<'RESOLVE'\n(.*?)\nRESOLVE", open(SKILL_MD, encoding="utf-8").read(), re.S)
    if not m:
        raise SystemExit("html SKILL.md has no RESOLVE block")
    return m.group(1)


def resolve(uiux, name, src):
    r = subprocess.run([sys.executable, "-", uiux, name], input=src, capture_output=True, text=True)
    if r.returncode != 0:
        raise SystemExit(r.stderr.strip() or f"resolver failed for {name}")
    return dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)


def sha256(path=None, data=None):
    h = hashlib.sha256()
    h.update(data if data is not None else open(path, "rb").read())
    return h.hexdigest()


def footer(company, name, res, src_url):
    layers = "".join(
        f"<li><strong>{E(l['family'])}</strong> — {E(l['layer'])}"
        + (f" ({E(l['script'])})" if l.get("script") else "")
        + f": {E(l.get('note', ''))}</li>"
        for l in res["fonts"]["layers"]
    )
    derived = "".join(
        f"<li><code>{E(k)}</code> = <code>{E(res['tokens'][k])}</code> — {E(p['derived'])}"
        + (f" (파일 값 <code>{E(p['before'])}</code>)" if p.get("before") else "")
        + "</li>"
        for k, p in res["provenance"].items()
        if "derived" in p
    )
    return f"""<footer class="omd-attribution" lang="ko">
  <p><strong>레퍼런스 토큰 적용본</strong> — 디자인 토큰 출처: {E(company)} DESIGN.md
  (<a href="{E(src_url)}">oh-my-design</a>, MIT). 이 디자인은 {E(company)}의 것이며 교육용 참고로 재현했다.
  <code>design={E(name)}</code> · html 스킬 batch 모드 · 동일 페이지에 토큰만 적용.</p>
  <p>서체 계층</p><ul>{layers}</ul>
  <p>파일에 없어 유도했거나 보정한 값 ({res['derivedCount']}개) — 브랜드 값으로 읽지 말 것</p>
  <ul>{derived or '<li>없음</li>'}</ul>
</footer>"""


def write_index(out, title):
    results = json.load(open(os.path.join(out, "results.json"), encoding="utf-8"))
    qa_path = os.path.join(out, "qa.json")
    qa = {q["name"]: q for q in json.load(open(qa_path, encoding="utf-8"))["pages"]} if os.path.isfile(qa_path) else {}
    rows, passed = [], 0
    for r in results["references"]:
        q = qa.get(r["name"])
        status = "QA 대기" if q is None else ("통과" if q["ok"] else "실패: " + "; ".join(q["problems"][:2]))
        passed += bool(q and q["ok"])
        rows.append(
            f'<li class="{"ok" if q and q["ok"] else "bad" if q else "wait"}"><a href="{E(r["file"])}">{E(r["company"])}</a>'
            f' <code>{E(r["name"])}</code> <span class="meta">{E(r.get("country") or "")} · {E(r.get("category") or "")}</span>'
            f' <span class="sw" style="background:{E(r["accent"])}"></span> <span class="st">{E(status)}</span></li>'
        )
    total = len(results["references"])
    summary = f"{total}개 중 QA 통과 {passed}개" if qa else f"{total}개 (QA 전)"
    page = f"""<!-- ui-ux: batch result list · {E(results['upstream'] or '')} -->
<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{E(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">
<style>
body{{margin:0;font-family:"Pretendard Variable",system-ui,sans-serif;color:#111;background:#fff;line-height:1.6}}
:lang(ko){{word-break:keep-all;line-break:strict;overflow-wrap:break-word}}
main{{max-width:960px;margin:0 auto;padding:48px 24px}} h1{{font-size:32px;line-height:1.25;margin:0 0 8px}}
.lead{{color:#555;margin:0 0 24px}} ol{{padding-left:1.4em;columns:2;column-gap:32px}} li{{padding:4px 0;break-inside:avoid}}
a{{color:#0b57d0}} code{{font-size:12px;color:#555;overflow-wrap:anywhere}} .meta{{font-size:12px;color:#555}}
.sw{{display:inline-block;width:10px;height:10px;border-radius:50%;vertical-align:middle;border:1px solid #0002}}
.st{{font-size:12px}} .bad .st{{color:#b3261e;font-weight:600}} .ok .st{{color:#1e6b34}}
@media (max-width:720px){{ol{{columns:1}}}}
</style></head><body><main>
<h1>{E(title)}</h1>
<p class="lead">{E(summary)}. 같은 페이지 하나를 html 스킬 batch 모드로 레퍼런스마다 토큰만 바꿔 렌더한 "레퍼런스 토큰 적용본"이다. 업스트림 {E((results['upstream'] or '')[:7])} · 콘텐츠 해시 {E(results['content_sha256'][:12])}.</p>
<ol>{''.join(rows)}</ol></main></body></html>"""
    with open(os.path.join(out, "index.html"), "w", encoding="utf-8") as f:
        f.write(page)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--page")
    ap.add_argument("--refs")
    ap.add_argument("--out", required=True)
    ap.add_argument("--uiux", default=os.path.normpath(os.path.join(HERE, "..", "..", "ui-ux")))
    ap.add_argument("--scripts", default="hangul,latin")
    ap.add_argument("--title", default="레퍼런스별 렌더 결과")
    ap.add_argument("--index-only", action="store_true")
    a = ap.parse_args()
    if a.index_only:
        write_index(a.out, a.title)
        return
    if not (a.page and a.refs):
        raise SystemExit("--page and --refs are required")
    template = open(a.page, encoding="utf-8").read()
    for slot in SLOTS:
        if template.count(slot) != 1:
            raise SystemExit(f"page must contain the slot {slot} exactly once")
    sys.path.insert(0, os.path.join(a.uiux, "scripts"))
    from designmd_tokens import ADAPTER_VERSION, build, css  # noqa: E402

    src = resolver_source()
    omd_ix = json.load(open(os.path.join(a.uiux, "references", "omd", "index.json"), encoding="utf-8"))
    by_name = {r["name"]: r for r in omd_ix["references"]}
    if a.refs.strip() == "omd-*":
        names = [r["name"] for r in omd_ix["references"]]
    else:
        names = [n.strip() for n in a.refs.split(",") if n.strip()]
    if len(names) != len(set(names)):
        raise SystemExit("duplicate names in --refs")
    content_sha = sha256(data=template.encode("utf-8"))
    os.makedirs(a.out, exist_ok=True)
    scripts = tuple(s for s in a.scripts.split(",") if s)
    results = []
    for name in names:
        info = resolve(a.uiux, name, src)  # same resolver as a single run; unknown names stop here
        if info.get("format") != "design-md-v3":
            raise SystemExit(f"{name}: batch mode needs a design-md-v3 reference (machine-readable tokens); got format={info.get('format', 'none')}")
        res = build(info["design_md"], scripts)
        entry = by_name.get(name, {})
        company = re.sub(r"\s*\(oh-my-design archive\)$", "", entry.get("title", name))
        design_sha = sha256(info["design_md"])
        audit = (
            f"<!-- ui-ux: driver=reference · reference={name} · format=design-md-v3 · upstream={info.get('upstream', '')} · "
            f"design_sha256={design_sha} · content_sha256={content_sha} · adapter=designmd_tokens.py {ADAPTER_VERSION} · "
            f"mode=batch · derived={res['derivedCount']} -->"
        )
        links = "".join(f'<link rel="stylesheet" href="{E(u)}">' for u in res["fonts"]["links"])
        page = (
            template.replace(SLOTS[0], audit)
            .replace(SLOTS[1], links)
            .replace(SLOTS[2], css(res))
            .replace(SLOTS[3], footer(company, name, res, entry.get("source", "")))
        )
        if res["dark"]:
            page = page.replace("<html ", '<html data-theme="dark" ', 1)
        file = f"{name}.html"
        with open(os.path.join(a.out, file), "w", encoding="utf-8") as f:
            f.write(page)
        results.append({
            "name": name, "file": file, "company": company, "country": entry.get("country"),
            "category": entry.get("category"), "accent": res["tokens"]["--color-accent"], "dark": res["dark"],
            "design_sha256": design_sha, "derived": res["derivedCount"], "contrast": res["contrast"],
        })
    with open(os.path.join(a.out, "results.json"), "w", encoding="utf-8") as f:
        json.dump({"upstream": omd_ix["upstream"]["commit"], "content_sha256": content_sha,
                   "adapter": ADAPTER_VERSION, "references": results}, f, ensure_ascii=False, indent=1)
    write_index(a.out, a.title)
    print(f"{len(results)} pages → {a.out}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Regenerate the oh-my-design reference set from an upstream checkout. Never hand-edit the output.

Usage: python3 sync.py <path-to-oh-my-design-checkout> [<expected-commit-prefix>] [--allow-removals]

Writes, next to this script:
  <id>/DESIGN.md   the upstream DESIGN.md frontmatter verbatim (tokens only) + a short pointer body
  index.json       registry entries `omd-<id>` (family oh-my-design, format design-md-v3)
  UPSTREAM         the upstream commit the files came from
  MANIFEST.json    sha256 of every vendored file (the tests check it)
  LICENSE          the upstream MIT licence, verbatim
Everything is generated in a scratch directory and validated before the generated files are swapped;
a failure part-way through the swap restores the previous files exactly.

Not vendored: the DESIGN.md prose body (pinned link to it at the same upstream commit in each stub),
reference.json, README.md, _research.md, logos, font files.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
FM = re.compile(r"^---\n(.*?)\n---\n", re.S)
HEX = re.compile(r"^#[0-9a-fA-F]{3,8}$")


MANAGED = ("index.json", "UPSTREAM", "MANIFEST.json", "LICENSE")


def main(src, expect_commit=None, allow_removals=False):
    import yaml  # PyYAML

    root = os.path.join(src, "design-md")
    git = lambda *a: subprocess.run(["git", "-C", src, *a], capture_output=True, text=True, check=True).stdout.strip()
    commit = git("rev-parse", "HEAD")
    if expect_commit and not commit.startswith(expect_commit):
        raise SystemExit(f"upstream is at {commit}, expected {expect_commit}")
    if git("status", "--porcelain", "--", "design-md", "LICENSE"):
        raise SystemExit("upstream checkout has local changes under design-md/ or LICENSE; use a clean clone")
    ids = sorted(d for d in os.listdir(root) if os.path.isfile(os.path.join(root, d, "DESIGN.md")))
    if not ids:
        raise SystemExit("no references found")
    # Expected-ID check: a re-sync may add references but never silently drop one that is vendored now.
    old_manifest = os.path.join(HERE, "MANIFEST.json")
    if os.path.isfile(old_manifest) and not allow_removals:
        before = {k.split("/")[0] for k in json.load(open(old_manifest))["files"]}
        after = {i.replace(".", "-") for i in ids}
        gone = sorted(before - after)
        if gone:
            raise SystemExit(f"upstream no longer has {len(gone)} vendored references ({', '.join(gone[:5])} …); "
                             "re-run with --allow-removals if that is intended")

    # Build everything in a scratch directory next to this one (same filesystem, so every swap step is an
    # atomic os.rename), validate it, then swap only the generated files.
    parent = os.path.dirname(HERE)
    stage = tempfile.mkdtemp(prefix=".omd-sync-stage-", dir=parent)
    try:
        n = build_stage(src, ids, commit, stage, yaml)
        swap(stage, parent)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
    print(f"{n} references from {commit[:7]}")


def build_stage(src, ids, commit, stage, yaml):
    root = os.path.join(src, "design-md")
    entries, manifest = [], {}
    for up_id in ids:
        # Registry names are [a-z0-9-]; upstream ids like `linear.app` map dots to hyphens.
        rid = up_id.replace(".", "-")
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", rid):
            raise SystemExit(f"{up_id}: id is not a safe registry name")
        d = os.path.join(root, up_id)
        text = open(os.path.join(d, "DESIGN.md"), encoding="utf-8").read()
        m = FM.match(text)
        if not m:
            raise SystemExit(f"{rid}: DESIGN.md has no frontmatter")
        fm = yaml.safe_load(m.group(1)) or {}
        if not isinstance(fm.get("colors"), dict):
            raise SystemExit(f"{rid}: frontmatter has no colors map")
        cat = {}
        rj = os.path.join(d, "reference.json")
        if os.path.isfile(rj):
            cat = json.load(open(rj, encoding="utf-8")).get("catalog", {})
        name = cat.get("name") or fm.get("name") or rid
        body = (
            f"# {name}\n\n"
            f"Tokens only (frontmatter, verbatim from oh-my-design `{commit[:7]}`). "
            f"The design described here belongs to {name}; reproduced for educational reference. "
            f"Full prose at the same commit: https://github.com/kwakseongjae/oh-my-design/blob/{commit}/design-md/{up_id}/DESIGN.md\n"
        )
        out = m.group(0) + "\n" + body
        os.makedirs(os.path.join(stage, rid))
        with open(os.path.join(stage, rid, "DESIGN.md"), "w", encoding="utf-8") as f:
            f.write(out)
        manifest[f"{rid}/DESIGN.md"] = hashlib.sha256(out.encode("utf-8")).hexdigest()
        colors = {str(k).lower(): v for k, v in fm["colors"].items()}
        accent = next((colors[k] for k in ("primary", "brand", "accent", "link") if isinstance(colors.get(k), str) and HEX.match(colors[k])), None)
        entries.append({
            "name": f"omd-{rid}",
            "title": f"{name} (oh-my-design archive)",
            "source": f"https://github.com/kwakseongjae/oh-my-design/blob/{commit}/design-md/{up_id}/DESIGN.md",
            "upstreamId": up_id,
            "path": f"references/omd/{rid}/DESIGN.md",
            "family": "oh-my-design",
            "format": "design-md-v3",
            "country": cat.get("country"),
            "category": cat.get("category"),
            "homepage": cat.get("homepage"),
            "accent": accent,
            "default": False,
        })
    hand = json.load(open(os.path.join(HERE, "..", "index.json"), encoding="utf-8"))["references"]
    clash = {e["name"] for e in entries} & {r["name"] for r in hand}
    if clash:
        raise SystemExit(f"generated names clash with hand-kept references: {sorted(clash)}")
    with open(os.path.join(stage, "index.json"), "w", encoding="utf-8") as f:
        json.dump({
            "description": "Generated by sync.py from oh-my-design (MIT). One entry per archive reference; each design belongs to its company. Registry names are omd-<id> and never shadow the hand-kept references in ../index.json.",
            "upstream": {"repo": "https://github.com/kwakseongjae/oh-my-design", "commit": commit},
            "references": entries,
        }, f, ensure_ascii=False, indent=1)
        f.write("\n")
    with open(os.path.join(stage, "MANIFEST.json"), "w", encoding="utf-8") as f:
        json.dump({"commit": commit, "files": manifest}, f, indent=1, sort_keys=True)
        f.write("\n")
    with open(os.path.join(stage, "UPSTREAM"), "w") as f:
        f.write(commit + "\n")
    shutil.copyfile(os.path.join(src, "LICENSE"), os.path.join(stage, "LICENSE"))
    return len(entries)


def swap(stage, parent):
    # Swap in two phases — move the current generated files aside, then move the stage in. A failure in
    # either phase rolls back exactly what this run did: remove only what it installed, put back only what
    # it moved aside. Files it never touched stay where they are.
    backup = tempfile.mkdtemp(prefix=".omd-sync-backup-", dir=parent)
    generated = sorted(
        n for n in os.listdir(HERE)
        if n in MANAGED or os.path.isfile(os.path.join(HERE, n, "DESIGN.md"))
    )
    moved, installed = [], []
    try:
        for name in generated:
            os.rename(os.path.join(HERE, name), os.path.join(backup, name))
            moved.append(name)
        for name in sorted(os.listdir(stage)):
            os.rename(os.path.join(stage, name), os.path.join(HERE, name))
            installed.append(name)
    except BaseException:
        try:
            for name in installed:
                p = os.path.join(HERE, name)
                shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
            for name in moved:
                os.rename(os.path.join(backup, name), os.path.join(HERE, name))
        except BaseException:
            print(f"sync.py: rollback failed; the previous files are kept in {backup}", file=sys.stderr)
            raise
        os.rmdir(backup)  # empty again: everything moved aside went back
        raise
    shutil.rmtree(backup)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--allow-removals"]
    if len(args) not in (1, 2):
        raise SystemExit(__doc__)
    main(args[0], args[1] if len(args) == 2 else None, "--allow-removals" in sys.argv)

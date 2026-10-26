#!/usr/bin/env python3
"""contrast-check.py - WCAG 2.x contrast report for a toss-design tokens.css.

Stdlib only. Parses the `:root { ... }` block (and, with --mode aa, the
`:root[data-contrast="aa"] { ... }` override block), resolves var() chains,
alpha-composites translucent colours over their background, and prints the
contrast ratio for the key semantic pairs.

Usage:
  python3 contrast-check.py path/to/tokens.css            # default mode
  python3 contrast-check.py path/to/tokens.css --mode aa  # strict-AA override block applied
  python3 contrast-check.py path/to/tokens.css --markdown # markdown table
  python3 contrast-check.py path/to/tokens.css --strict   # exit 1 if a required pair fails

Requirement column:
  4.5  normal-size text (WCAG 1.4.3 AA)
  3.0  non-text UI / graphical objects (WCAG 1.4.11) or large text
  -    exempt (disabled UI), decorative, or a pairing the skill forbids;
       reported for information only
"""
import re
import sys

# (label, foreground var, background var, required ratio or None, kind)
PAIRS = [
    ("text-strong on bg", "--color-text-strong", "--color-bg", 4.5, "body text"),
    ("text on bg", "--color-text", "--color-bg", 4.5, "body text"),
    ("text-secondary on bg", "--color-text-secondary", "--color-bg", 4.5, "body text"),
    ("text-sub on bg", "--color-text-sub", "--color-bg", 4.5, "body text"),
    ("text on bg-grey", "--color-text", "--color-bg-grey", 4.5, "body text"),
    ("text-sub on bg-grey", "--color-text-sub", "--color-bg-grey", None, "forbidden pairing: use text-sub-on-grey"),
    ("text-sub-on-grey on bg-grey", "--color-text-sub-on-grey", "--color-bg-grey", 4.5, "body text"),
    ("on-primary on primary", "--color-on-primary", "--color-primary", 4.5, "button label"),
    ("primary on bg", "--color-primary", "--color-bg", 3.0, "non-text / large"),
    ("primary-text on bg", "--color-primary-text", "--color-bg", 4.5, "body text / link"),
    ("on-primary-weak on primary-weak", "--color-on-primary-weak", "--color-primary-weak", 4.5, "button label"),
    ("focus on bg", "--color-focus", "--color-bg", 3.0, "non-text"),
    ("selected on bg", "--color-selected", "--color-bg", 3.0, "non-text"),
    ("tab-indicator on bg", "--color-tab-indicator", "--color-bg", 3.0, "non-text"),
    ("tab-text on bg", "--color-tab-text", "--color-bg", 4.5, "label"),
    ("tab-text-selected on bg", "--color-tab-text-selected", "--color-bg", 4.5, "label"),
    ("field-focus-label on bg", "--color-field-focus-label", "--color-bg", 4.5, "label"),
    ("badge-brand-text on badge-brand-bg", "--color-badge-brand-text", "--color-badge-brand-bg", 4.5, "badge label"),
    ("on-neutral on neutral", "--color-on-neutral", "--color-neutral", 4.5, "button label"),
    ("on-neutral-weak on neutral-weak", "--color-on-neutral-weak", "--color-neutral-weak", 4.5, "button label"),
    ("on-danger on danger", "--color-on-danger", "--color-danger", 4.5, "button label"),
    ("on-danger-weak on danger-weak", "--color-on-danger-weak", "--color-danger-weak", 4.5, "button label"),
    ("danger-text on bg", "--color-danger-text", "--color-bg", 4.5, "body text"),
    ("success-text on bg", "--color-success-text", "--color-bg", 4.5, "body text"),
    ("success on bg", "--color-success", "--color-bg", 3.0, "non-text"),
    ("on-warning on warning", "--color-on-warning", "--color-warning", 4.5, "badge label"),
    ("toast-text on toast-bg", "--color-toast-text", "--color-toast-bg", 4.5, "body text"),
    ("text-placeholder on bg", "--color-text-placeholder", "--color-bg", 4.5, "placeholder"),
    ("icon-strong on bg", "--color-icon-strong", "--color-bg", 3.0, "non-text"),
    ("icon on bg", "--color-icon", "--color-bg", None, "decorative"),
    ("text-disabled on bg", "--color-text-disabled", "--color-bg", None, "disabled (exempt)"),
]

BLOCK_RE = r"{sel}\s*\{{(.*?)\}}"
DECL_RE = re.compile(r"(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);")


def parse_block(css, selector):
    m = re.search(BLOCK_RE.format(sel=selector), css, re.S)
    if not m:
        return {}
    body = re.sub(r"/\*.*?\*/", "", m.group(1), flags=re.S)
    return {k: v.strip() for k, v in DECL_RE.findall(body)}


def resolve(name, table, depth=0):
    if depth > 20:
        raise ValueError("var() cycle at " + name)
    if name not in table:
        raise KeyError(name)
    val = table[name]
    m = re.fullmatch(r"var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[^)]*)?\)", val)
    return resolve(m.group(1), table, depth + 1) if m else val


def parse_color(s):
    s = s.strip().lower()
    if s.startswith("#"):
        h = s[1:]
        if len(h) in (3, 4):
            h = "".join(c * 2 for c in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return (r, g, b, a)
    m = re.fullmatch(r"rgba?\(([^)]*)\)", s)
    if m:
        parts = [p.strip() for p in re.split(r"[,\s/]+", m.group(1)) if p.strip()]
        r, g, b = (float(p) for p in parts[:3])
        a = float(parts[3]) if len(parts) > 3 else 1.0
        return (r, g, b, a)
    if s == "white":
        return (255, 255, 255, 1.0)
    if s == "black":
        return (0, 0, 0, 1.0)
    raise ValueError("unsupported colour: " + s)


def over(fg, bg):
    """Composite fg (r,g,b,a) over an opaque bg (r,g,b)."""
    r, g, b, a = fg
    return tuple(a * c + (1 - a) * d for c, d in zip((r, g, b), bg))


def luminance(rgb):
    def ch(c):
        c = c / 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def main(argv):
    if len(argv) < 2 or argv[1].startswith("-"):
        print(__doc__)
        return 2
    path = argv[1]
    mode = "aa" if "--mode" in argv and argv[argv.index("--mode") + 1] == "aa" else "default"
    css = open(path, encoding="utf-8").read()
    table = parse_block(css, r":root")
    if mode == "aa":
        table.update(parse_block(css, r':root\[data-contrast="aa"\]'))
    theme = table.get("--theme-name", "?").strip('"')
    canvas = over(parse_color(resolve("--color-bg", table)), (255, 255, 255))
    rows, failed = [], 0
    for label, fgv, bgv, need, kind in PAIRS:
        try:
            bg = over(parse_color(resolve(bgv, table)), canvas)
            fg = over(parse_color(resolve(fgv, table)), bg)
        except KeyError as e:
            rows.append((label, "missing " + str(e), "", "", kind))
            failed += 1
            continue
        r = ratio(fg, bg)
        if need is None:
            verdict = "info"
        elif r >= need:
            verdict = "PASS"
        else:
            verdict = "FAIL"
            failed += 1
        rows.append((label, f"{r:.2f}:1", "-" if need is None else f"{need}:1", verdict, kind))
    if "--markdown" in argv:
        print(f"Theme `{theme}`, mode `{mode}` (scripts/contrast-check.py)\n")
        print("| Pair | Ratio | Needs | Result | Use |")
        print("|---|---|---|---|---|")
        for row in rows:
            print("| " + " | ".join(row) + " |")
    else:
        print(f"theme={theme} mode={mode} file={path}")
        for row in rows:
            print(f"  {row[0]:38} {row[1]:>9}  need {row[2]:>6}  {row[3]:5}  {row[4]}")
        print(f"  -> {failed} required pair(s) below threshold")
    return 1 if ("--strict" in argv and failed) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

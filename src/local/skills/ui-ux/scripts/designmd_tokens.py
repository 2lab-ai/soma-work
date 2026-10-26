#!/usr/bin/env python3
"""designmd_tokens.py — DESIGN.md (Google DESIGN.md / oh-my-design v3) frontmatter → page tokens.

Used by the `html` skill's reference driver for registry entries with `format: design-md-v3`, in both
single and batch mode. The DESIGN.md is never modified; every value this script outputs records where
it came from (`from: <frontmatter path>`) or why it was derived (`derived: <reason>`, with before/after
when a stated value was adjusted). The archive's rule is "a value nobody could confirm stays blank",
so a page must disclose every derived value and never present it as the brand's own.

Usage:
  python3 designmd_tokens.py <DESIGN.md> [--scripts hangul,latin] [--format css|json]

  --scripts  the writing systems the page content uses (default: hangul,latin). Picks the per-script
             font fallback; it is not inferred from the brand's country.

Token contract (CSS custom properties):
  colour   --color-bg --color-surface --color-text --color-text-muted --color-line
           --color-accent --color-accent-text --button-bg --button-text
  type     --font-sans --font-display --fs-display --fs-h2 --fs-h3 --fs-body --fs-small --lh-body
           --fw-display --fw-heading
  shape    --radius-sm --radius-md --radius-lg --radius-pill --button-radius --button-padding
  space    --space-1 … --space-6
Guarantees (normal-size text, WCAG 1.4.3 4.5:1): text, text-muted and accent-text on both bg and
surface; button-text on button-bg. --color-accent is for non-text marks only (rules, swatches).
"""
import json
import re
import sys

ADAPTER_VERSION = "1.3.0"

try:
    import yaml  # PyYAML ships with every soma-work host (playwright/python toolchain)
except ImportError:  # pragma: no cover
    raise SystemExit("designmd_tokens.py needs PyYAML: python3 -m pip install pyyaml")

FM = re.compile(r"^---\n(.*?)\n---\n", re.S)
HEX = re.compile(r"^#([0-9a-fA-F]{3,8})$")

# --------------------------------------------------------------------------- colour math
def parse_hex(v):
    if not isinstance(v, str):
        return None
    m = HEX.match(v.strip())
    if not m:
        return None
    h = m.group(1)
    if len(h) in (3, 4):
        h = "".join(c * 2 for c in h)
    if len(h) not in (6, 8):
        return None
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
    if a < 1:  # a translucent token is composited over white to get a page colour
        r, g, b = (a * c + (1 - a) * 255 for c in (r, g, b))
    return q((r, g, b))


def hexify(rgb):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(c))) for c in rgb)


def lum(rgb):
    def ch(c):
        c /= 255
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    x, y = sorted((lum(a), lum(b)), reverse=True)
    return (x + 0.05) / (y + 0.05)


def q(rgb):
    """Quantise to the 8-bit value the page will actually carry (hexify → parse)."""
    return tuple(max(0, min(255, round(c))) for c in rgb)


def mix(a, b, t):
    """Mix t of b into a, quantised so every contrast check sees the emitted colour."""
    return q(tuple(a[i] * (1 - t) + b[i] * t for i in range(3)))


def reach(fg, grounds, target=4.5):
    """Move fg toward the pole that gains contrast until it clears target on every ground."""
    fg = q(fg)
    if min(ratio(fg, g) for g in grounds) >= target:
        return fg
    pole = (0, 0, 0) if lum(grounds[0]) > 0.18 else (255, 255, 255)
    for i in range(1, 41):
        c = mix(fg, pole, i / 40)
        if min(ratio(c, g) for g in grounds) >= target:
            return c
    return pole


# --------------------------------------------------------------------------- lookups
ROLE_KEYS = {
    "bg": ["canvas", "background", "bg", "page", "paper", "base", "white"],
    "surface": ["surface", "surface-alt", "card", "panel", "subtle", "grey50", "gray50", "grey100", "gray100"],
    "text": ["foreground", "ink", "heading", "text", "text-primary", "body", "primary-text", "charcoal"],
    "muted": ["muted", "text-secondary", "secondary-text", "body", "slate", "faint", "grey600", "gray600"],
    "line": ["hairline", "border", "divider", "line", "stroke", "grey200", "gray200"],
    "accent": ["primary", "brand", "accent", "link", "cta", "action", "blue500"],
    "on_accent": ["on-primary", "on-brand", "on-accent"],
}
DISPLAY_KEYS = ["display-hero", "hero", "display-xl", "display-lg", "display", "h1", "heading-xxxl",
                "page-title", "title-xl", "headline", "heading-1", "heading"]
H2_KEYS = ["section", "h2", "heading-xxl", "heading-2", "title", "subsection", "heading-xl", "card-title"]
H3_KEYS = ["subsection", "h3", "heading-xl", "heading-3", "card-title", "subheading", "subtitle"]
BODY_KEYS = ["body", "body-md", "body-lg", "text", "paragraph", "body-1"]
# Spec §6.6 safe-default table (a safe default is not a substitute and never a brand face).
SAFE_DEFAULT = {"latin": "Noto Sans", "hangul": "Noto Sans KR", "kana": "Noto Sans JP",
                "han-hans": "Noto Sans SC", "han-hant": "Noto Sans TC"}
PRETENDARD_CSS = ("https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/"
                  "pretendardvariable-dynamic-subset.min.css")


def pick(colors, role):
    for k in ROLE_KEYS[role]:
        rgb = parse_hex(colors.get(k))
        if rgb:
            return rgb, f"colors.{k}"
    return None, None


def primary_button(components):
    if not isinstance(components, dict):
        return None, None
    order = ["button-primary", "primary-button", "cta", "button-cta", "tds-button"]
    order += [n for n in components if "button" in n and n not in order]
    for name in order:
        c = components.get(name)
        if isinstance(c, dict) and parse_hex(c.get("backgroundColor")):
            return c, f"components.{name}"
    return None, None


def px(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, str):
        m = re.match(r"^\s*([\d.]+)\s*(px|rem)?\s*$", v)
        if m:
            return float(m.group(1)) * (16 if m.group(2) == "rem" else 1)
    return None


def type_role(typo, keys):
    for k in keys:
        t = typo.get(k)
        if isinstance(t, dict) and px(t.get("fontSize")):
            return t, f"typography.{k}"
    return None, None


# --------------------------------------------------------------------------- main
class Tokens:
    def __init__(self):
        self.values, self.prov = {}, {}

    def stated(self, key, value, path):
        self.values[key], self.prov[key] = value, {"from": path}

    def derived(self, key, value, reason, before=None):
        self.values[key] = value
        p = {"derived": reason}
        if before is not None:
            p["before"] = before
        self.prov[key] = p


def build(path, scripts=("hangul", "latin")):
    fm = yaml.safe_load(FM.match(open(path, encoding="utf-8").read()).group(1)) or {}
    colors = {str(k).lower(): v for k, v in (fm.get("colors") or {}).items()}
    comps = fm.get("components") or {}
    tk = Tokens()

    # ---- colour
    bg, bg_p = pick(colors, "bg")
    if not bg:
        bg = (255, 255, 255)
    (tk.stated if bg_p else tk.derived)("--color-bg", hexify(bg), bg_p or "no canvas role stated → white")
    dark = lum(bg) < 0.18

    surface, s_p = pick(colors, "surface")
    # A stated surface is used only when it is a tint of the canvas (same light/dark side, < 1.6:1 apart);
    # an inverted band colour named "surface" would break every text pair.
    if surface and abs(lum(surface) - lum(bg)) > 0.004 and ratio(surface, bg) < 1.6:
        tk.stated("--color-surface", hexify(surface), s_p)
    else:
        surface = mix(bg, (255, 255, 255) if dark else (0, 0, 0), 0.04)
        tk.derived("--color-surface", hexify(surface), "no distinct surface stated → canvas shifted 4% toward the ink pole")
    grounds = [bg, surface]

    text, t_p = pick(colors, "text")
    if text and ratio(text, bg) >= 3:
        fixed = reach(text, grounds)
        if fixed == text:
            tk.stated("--color-text", hexify(text), t_p)
        else:
            tk.derived("--color-text", hexify(fixed), f"{t_p} adjusted to reach 4.5:1 on canvas and surface", hexify(text))
        text = fixed
    else:
        before = hexify(text) if text else None
        text = reach((17, 17, 17) if not dark else (240, 240, 240), grounds)
        tk.derived("--color-text", hexify(text), (f"{t_p} fails 3:1 on the canvas" if t_p else "no text role stated") + " → neutral ink", before)

    muted, m_p = pick(colors, "muted")
    if not muted or muted == text:
        muted = reach(mix(text, bg, 0.35), grounds)
        tk.derived("--color-text-muted", hexify(muted), "no secondary-text role stated → ink 35% toward canvas, ≥ 4.5:1")
    else:
        fixed = reach(muted, grounds)
        (tk.stated("--color-text-muted", hexify(muted), m_p) if fixed == muted else
         tk.derived("--color-text-muted", hexify(fixed), f"{m_p} adjusted to reach 4.5:1 on canvas and surface", hexify(muted)))
        muted = fixed

    line, l_p = pick(colors, "line")
    if line:
        tk.stated("--color-line", hexify(line), l_p)
    else:
        tk.derived("--color-line", hexify(mix(bg, text, 0.12)), "no hairline role stated → 12% ink over canvas")

    accent, a_p = pick(colors, "accent")
    btn, btn_p = primary_button(comps)
    if not accent and btn:
        accent, a_p = parse_hex(btn["backgroundColor"]), f"{btn_p}.backgroundColor"
    if accent:
        tk.stated("--color-accent", hexify(accent), a_p)
    else:
        accent = text
        tk.derived("--color-accent", hexify(accent), "no brand/primary colour stated → ink (monochrome)")

    acc_text = reach(accent, grounds)
    if acc_text != accent:
        tk.derived("--color-accent-text", hexify(acc_text), "accent adjusted to reach 4.5:1 for text on canvas and surface", hexify(accent))
    elif a_p:
        tk.stated("--color-accent-text", hexify(accent), a_p)
    else:
        tk.derived("--color-accent-text", hexify(acc_text), "no brand/primary colour stated → ink (monochrome)")

    on_acc, o_p = pick(colors, "on_accent")
    if not on_acc and btn and parse_hex(btn.get("textColor")):
        on_acc, o_p = parse_hex(btn["textColor"]), f"{btn_p}.textColor"
    btn_bg, label = accent, on_acc
    if not label:
        label = (255, 255, 255) if ratio((255, 255, 255), accent) >= ratio((0, 0, 0), accent) else (0, 0, 0)
    if ratio(label, btn_bg) < 4.5:
        # Button and badge labels here are 13–14 px: normal-size text, so 4.5:1 applies.
        # Move the fill toward whichever pole reaches 4.5:1 with the smaller change; if neither
        # does with the stated label, switch the label to white/black and retry.
        best = None
        for lab in ([label] if o_p else []) + [(255, 255, 255), (0, 0, 0)]:
            for pole in ((0, 0, 0), (255, 255, 255)):
                for i in range(0, 41):
                    c = mix(accent, pole, i / 40)
                    if ratio(lab, c) >= 4.5:
                        if best is None or i < best[0]:
                            best = (i, c, lab)
                        break
            if best:
                break
        btn_bg, new_label = best[1], best[2]
        if new_label != label and o_p:
            o_p = None  # stated label could not reach 4.5:1 on any nearby fill
        label = new_label
    (tk.stated("--button-bg", hexify(btn_bg), a_p) if btn_bg == accent and a_p else
     tk.derived("--button-bg", hexify(btn_bg), "accent darkened/lightened so a 14 px label reaches 4.5:1" if btn_bg != accent else "accent derived above", hexify(accent)))
    (tk.stated("--button-text", hexify(label), o_p) if o_p else
     tk.derived("--button-text", hexify(label), "no on-primary role stated → white or black, whichever contrasts more"))

    # ---- type
    typo = fm.get("typography") or {}
    b_t, b_p = type_role(typo, BODY_KEYS)
    body_raw = px(b_t["fontSize"]) if b_t else None
    body = min(max(body_raw or 16.0, 15.0), 18.0)
    if body_raw == body:
        tk.stated("--fs-body", f"{body:.0f}px", f"{b_p}.fontSize")
    else:
        tk.derived("--fs-body", f"{body:.0f}px", "body size clamped to 15–18 px for a long reading page" if body_raw else "no body size stated → 16 px", f"{body_raw:.0f}px" if body_raw else None)

    def scale(key, roles, dflt, lo, hi, why):
        t, p = type_role(typo, roles)
        raw = px(t["fontSize"]) if t else None
        val = min(max(raw if raw else dflt, lo), hi)
        if raw is not None and abs(raw - val) < 0.5:
            tk.stated(key, f"{val:.0f}px", f"{p}.fontSize")
        else:
            tk.derived(key, f"{val:.0f}px", (f"{p} clamped to {lo:.0f}–{hi:.0f} px" if raw else f"no {why} stated → scaled from body"), f"{raw:.0f}px" if raw else None)
        return val, t, p

    disp, d_t, d_p = scale("--fs-display", DISPLAY_KEYS, body * 2.5, body * 1.8, 72.0, "display size")
    h2, h2_t, h2_p = scale("--fs-h2", H2_KEYS, max(body * 1.5, disp * 0.55), body * 1.25, disp * 0.8, "section heading size")
    scale("--fs-h3", H3_KEYS, max(body * 1.15, h2 * 0.75), body * 1.05, h2, "sub-heading size")
    tk.derived("--fs-small", f"{max(13.0, body * 0.82):.0f}px", "0.82 × body, floor 13 px")

    lh_raw = (b_t or {}).get("lineHeight")
    lh_val = None
    if isinstance(lh_raw, (int, float)) and not isinstance(lh_raw, bool):
        lh_val = lh_raw if lh_raw < 4 else lh_raw / (body_raw or body)
    elif isinstance(lh_raw, str) and px(lh_raw):
        p = px(lh_raw)
        lh_val = p / (body_raw or body) if p > 4 else p
    if lh_val and 1.4 <= lh_val <= 1.9:
        tk.stated("--lh-body", f"{lh_val:.2f}", f"{b_p}.lineHeight")
    else:
        tk.derived("--lh-body", f"{min(max(lh_val or 1.6, 1.4), 1.9):.2f}", "body leading clamped to 1.4–1.9 for Korean text" if lh_val else "no body line height stated → 1.6", f"{lh_val:.2f}" if lh_val else None)
    for key, t, p in (("--fw-display", d_t, d_p), ("--fw-heading", h2_t, h2_p)):
        w = (t or {}).get("fontWeight")
        (tk.stated(key, str(w), f"{p}.fontWeight") if w else tk.derived(key, "700", "no weight stated → 700"))

    # ---- shape and space
    rounded = {str(k).lower(): v for k, v in (fm.get("rounded") or {}).items()}

    def radius(key, names, dflt):
        for n in names:
            if n in rounded and px(rounded[n]) is not None:
                tk.stated(key, f"{min(px(rounded[n]), 9999):.0f}px", f"rounded.{n}")
                return
        tk.derived(key, f"{dflt}px", f"no {'/'.join(names[:2])} radius stated → {dflt} px")

    radius("--radius-sm", ["sm", "xs", "small", "chip", "tag", "badge"], 4)
    radius("--radius-md", ["md", "card", "control", "button", "input", "base"], 8)
    radius("--radius-lg", ["lg", "xl", "card", "panel", "modal"], 12)
    radius("--radius-pill", ["full", "pill", "round", "circle"], 9999)
    if btn and px(btn.get("rounded")) is not None:
        tk.stated("--button-radius", f"{min(px(btn['rounded']), 9999):.0f}px", f"{btn_p}.rounded")
    else:
        tk.values["--button-radius"] = tk.values["--radius-md"]
        tk.prov["--button-radius"] = {"derived": "no primary-button radius stated → --radius-md"}
    if btn and isinstance(btn.get("padding"), str):
        tk.stated("--button-padding", btn["padding"], f"{btn_p}.padding")
    else:
        tk.derived("--button-padding", "6px 14px", "no primary-button padding stated → 6px 14px")
    spacing = fm.get("spacing") or {}
    base, base_p = None, None
    for k in ("md", "base", "sm"):
        if px(spacing.get(k)):
            base, base_p = px(spacing[k]), f"spacing.{k}"
            break
    base_c = min(max(base or 8.0, 4.0), 16.0)
    for i, mul in enumerate((0.5, 1, 1.5, 2, 3, 4), start=1):
        why = (f"{base_p} × {mul}" + (" (base clamped to 4–16 px)" if base and base != base_c else "")) if base else f"no spacing stated → 8 px × {mul}"
        tk.derived(f"--space-{i}", f"{base_c * mul:.0f}px", why)

    # ---- fonts: brand face / labelled substitute / safe default, per content script
    fonts = fm.get("fonts") if isinstance(fm.get("fonts"), dict) else {}
    roles = fonts.get("roles") if isinstance(fonts.get("roles"), dict) else {}
    faces = fonts.get("faces") if isinstance(fonts.get("faces"), dict) else {}
    safe = fonts.get("safeDefaults") if isinstance(fonts.get("safeDefaults"), dict) else {}
    text_face = next((roles[k] for k in ("sans", "text", "ui", "body", "primary") if isinstance(roles.get(k), str)), None)
    display_face = next((roles[k] for k in ("display", "heading", "headline") if isinstance(roles.get(k), str)), None)
    if not text_face:  # typography stacks may name the face directly
        fam = (b_t or {}).get("fontFamily")
        if isinstance(fam, str):
            text_face = fam.split(",")[0].strip().strip("'\"")
    layers, google, links = [], [], []

    def face_layers(face, role):
        if not face or face.lower() in ("system", "system-ui", "sans-serif"):
            return []
        info = faces.get(face) if isinstance(faces.get(face), dict) else {}
        out = [{"family": face, "layer": "brand face", "role": role,
                "note": "public" if info.get("distribution") == "public" else "used only if installed locally; not loaded"}]
        for script, sub in (info.get("substitutes") or {}).items():
            if isinstance(sub, dict) and sub.get("family") and script in scripts:
                out.append({"family": sub["family"], "layer": "substitute", "script": script,
                            "provider": sub.get("provider"), "note": sub.get("label", "substitute — not the brand face")})
        return out

    layers += face_layers(text_face, "text")
    disp_layers = face_layers(display_face, "display") if display_face and display_face != text_face else []
    # The safe default is always its own layer (after any substitute), so a page can fall back to it
    # when the substitute fails to load; it is never merged into the substitute.
    for script in scripts:
        stated = [f for f in (safe.get(script) or []) if isinstance(f, str)]
        if stated:
            layers += [{"family": f, "layer": "safe default", "script": script, "note": f"fonts.safeDefaults.{script}"} for f in stated]
        else:
            layers.append({"family": SAFE_DEFAULT.get(script, "Noto Sans"), "layer": "safe default", "script": script,
                           "note": "not stated by the file; DESIGN.md v3 §6.6 table"})
    for layer in layers + disp_layers:
        fam = layer["family"]
        if layer["layer"] == "brand face" and layer["note"] != "public":
            continue
        if "Pretendard" in fam:
            links.append(PRETENDARD_CSS)
        elif layer["layer"] != "brand face" or "Noto" in fam:
            google.append(fam.replace("Noto Sans CJK JP", "Noto Sans JP").replace("Noto Sans CJK KR", "Noto Sans KR"))
    if google:
        q = "&".join("family=" + f.replace(" ", "+") + ":wght@400;500;600;700" for f in dict.fromkeys(google))
        links.insert(0, f"https://fonts.googleapis.com/css2?{q}&display=swap")
    stack = list(dict.fromkeys([x["family"] for x in layers] + ["system-ui", "sans-serif"]))
    quote = lambda f: f if f in ("system-ui", "sans-serif") else f'"{f}"'
    sans = ", ".join(quote(f) for f in stack)
    display = ", ".join(quote(f) for f in dict.fromkeys([x["family"] for x in disp_layers] + stack))
    (tk.stated("--font-sans", sans, "fonts.roles + fonts.faces + fonts.safeDefaults") if text_face or safe else
     tk.derived("--font-sans", sans, "no font stated → spec §6.6 safe defaults for the content scripts"))
    tk.values["--font-display"], tk.prov["--font-display"] = display, (
        {"from": "fonts.roles.display"} if disp_layers else {"derived": "no display face stated → same stack as text"})

    v = lambda k: parse_hex(tk.values[k])  # measured on the emitted hex values, as a browser sees them
    checks = {
        "text/bg": ratio(v("--color-text"), v("--color-bg")),
        "text/surface": ratio(v("--color-text"), v("--color-surface")),
        "muted/bg": ratio(v("--color-text-muted"), v("--color-bg")),
        "muted/surface": ratio(v("--color-text-muted"), v("--color-surface")),
        "accent-text/bg": ratio(v("--color-accent-text"), v("--color-bg")),
        "accent-text/surface": ratio(v("--color-accent-text"), v("--color-surface")),
        "button-text/button-bg": ratio(v("--button-text"), v("--button-bg")),
    }
    return {
        "adapterVersion": ADAPTER_VERSION, "name": fm.get("name"), "dark": dark,
        "tokens": tk.values, "provenance": tk.prov,
        "fonts": {"layers": layers + disp_layers, "links": list(dict.fromkeys(links)), "scripts": list(scripts)},
        "omitted": fm.get("omitted"), "contrast": {k: round(v, 2) for k, v in checks.items()},
        "derivedCount": sum(1 for p in tk.prov.values() if "derived" in p),
    }


def css(result):
    lines = ["/* tokens: designmd_tokens.py " + result["adapterVersion"] + " — derived values are listed on the page */", ":root {"]
    lines += [f"  {k}: {v};" for k, v in result["tokens"].items()]
    return "\n".join(lines) + "\n}\n"


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0].startswith("-"):
        print(__doc__)
        sys.exit(2)
    scripts = tuple(a[a.index("--scripts") + 1].split(",")) if "--scripts" in a else ("hangul", "latin")
    res = build(a[0], scripts)
    if ("--format" in a and a[a.index("--format") + 1] == "json"):
        print(json.dumps(res, ensure_ascii=False, indent=1))
    else:
        print(css(res), end="")

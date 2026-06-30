---
name: ui-ux-reference
description: "Capture a real-world website's visual design language as a reusable design.md reference for the `ui-ux` skill. Point it at any URL (an Awwwards page, a live site, a portfolio) plus a short name; it extracts the palette, typography, layout, motion, imagery, tone, and signature techniques into references/<name>/design.md and registers it in references/index.json so the `ui-ux` skill can apply it by name. Triggers on: 'add a ui-ux reference', 'ui-ux-reference', '레퍼런스 추가', '이 사이트를 레퍼런스로', 'extract design from <url>', 'design reference from this site', 'capture this site's design', 'use <site> as a design reference'."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, WebFetch, WebSearch
version: 0.1.0
license: MIT
---

# UI/UX Reference — Capture a site's design language

This skill turns a **website URL** into a **named design reference** that the
companion **`ui-ux`** skill can apply by name. The output is a single
`references/<name>/design.md` file plus an entry in `references/index.json`,
living inside the `ui-ux` skill so the two share one reference library.

## When to use

- The user points at a site and says "use this as a reference / design like this".
- The user wants to add a new entry to the `ui-ux` skill's named references.
- You need a concrete visual North Star (palette, type, motion) before building.

This skill **authors** references. To **apply** one, that's the `ui-ux` skill's
job (it reads `references/<name>/design.md`).

## Inputs

1. **URL** (required) — an Awwwards/site page or a live site. Awwwards pages carry
   curated metadata (score, tags, stack, designer) and are ideal sources.
2. **name** (required) — a short kebab-case id (e.g. `il-capo-production`,
   `linear-app`, `stripe-press`). This is what the user types to reference it
   later. If the user doesn't give one, derive it from the site/brand and confirm.

If either is ambiguous, ask once (use the `UIAskUserQuestion` skill) — don't guess
a name the user will have to remember.

## Where references live (shared library)

References are stored **inside the `ui-ux` skill**, not here, so one library
serves both skills. Resolve the target directory:

```bash
UIUX="$CLAUDE_PLUGIN_ROOT/skills/ui-ux"
# Fallback for a repo checkout (no plugin root):
[ -d "$UIUX" ] || UIUX="$(git rev-parse --show-toplevel 2>/dev/null)/src/local/skills/ui-ux"
REFDIR="$UIUX/references"
```

- Reference file:  `$REFDIR/<name>/design.md`
- Reference index: `$REFDIR/index.json`

> Persistence note: in the deployed runtime the skill tree under `dist/local` is
> ephemeral. To make a reference **durable**, the canonical home is the repo —
> author the file under `src/local/skills/ui-ux/references/<name>/` and open a PR
> (the same way the default `il-capo-production` reference ships). When running
> against a local checkout, write directly into `src/local/...`.

## Procedure

### Step 1 — Fetch & analyse the site

```bash
# Primary: fetch the page content
# (use the WebFetch tool with a design-extraction prompt; for Awwwards pages also
#  fetch the live site URL the page links to, when available)
```

Extract, as concretely as the source allows:

- **Color palette** — background/canvas, primary text/UI, **signature accent(s)**,
  muted/secondary. Capture hex values when visible; note how color is *rationed*.
- **Typography** — family/personality (grotesque, serif, mono, display), weights,
  scale strategy, letter-spacing, case treatment, numerals.
- **Layout & grid** — full-bleed vs. card grid, symmetry, negative space, nav.
- **Motion & interaction** — transitions, cursor behavior, loaders, hover/scroll
  effects, easing/duration, the *signature* technique that defines the site.
- **Imagery & texture** — photography/video/illustration, grade, decorative effects.
- **Tone / mood** — 1–2 line character read.
- **Signature techniques** — the 3–5 reproducible moves that make it itself.
- **Meta** (if Awwwards) — score, tags/category, observed stack, studio/designer.

If a field can't be determined from the source, say so explicitly in the file
(don't invent hex codes) — mark it as "inferred" vs. "observed".

### Step 2 — Write `design.md`

Write `$REFDIR/<name>/design.md` using **this exact section template** so every
reference is uniform and the `ui-ux` skill can consume them consistently. Use the
shipped `references/il-capo-production/design.md` as the canonical example:

```markdown
# Design Reference — <name>

- **Name:** `<name>`
- **Source:** <url>
- **Type:** <category / what the site is>
- **Recognition:** <awards / score, if any>
- **Studio:** <designer/agency, if known>
- **Captured:** <YYYY-MM-DD>

## Vibe (one line)
## Color Palette          (table: Role | Value(hex) | Notes; + rationing discipline)
## Typography
## Layout & Grid
## Motion & Interaction   (the signature)
## Imagery & Texture
## Tone / Mood
## Signature Techniques to Reproduce   (numbered, 3–5)
## Do / Don't
## Implementation Notes   (observed stack + perf/a11y caveats)
```

Always include an **accessibility caveat** on the palette (e.g. check the accent's
contrast against the background and state where it's safe to use) — a reference
sets aesthetic direction but must not push consumers below WCAG.

### Step 3 — Register in `index.json`

Append (or update, if `<name>` already exists) an entry in `$REFDIR/index.json`:

```json
{
  "name": "<name>",
  "title": "<short human title>",
  "source": "<url>",
  "path": "references/<name>/design.md",
  "tags": ["<style>", "<industry>", "..."],
  "accent": "#RRGGBB",
  "default": false,
  "captured": "<YYYY-MM-DD>"
}
```

Validate the file still parses as JSON after editing:

```bash
python3 -c "import json,sys; json.load(open('$REFDIR/index.json')); print('index.json OK')"
```

### Step 4 — Report

Tell the user:
- the reference `<name>` and the path written,
- the captured accent + palette summary,
- how to apply it: *"In the `ui-ux` skill, say 'use the `<name>` reference'."*
- if running against the repo: that it needs a commit/PR to persist (offer to open one).

## Contract with the `ui-ux` skill

- One shared library at `ui-ux/references/`.
- `index.json` is the registry; `<name>` is the lookup key.
- The `ui-ux` skill reads `references/<name>/design.md` and treats it as the
  visual North Star (see that skill's **Named Design References** section).
- Aesthetic direction from a reference never overrides the CRITICAL/HIGH quality
  gates (accessibility, touch targets, performance) — adapt, don't violate.

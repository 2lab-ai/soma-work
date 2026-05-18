---
name: html
description: Convert any content (markdown, plain text, JSON, CSV, SQL, raw notes) into a styled single-file HTML and a rendered PNG, then upload both to the current Slack thread. Pick a template name from the catalog or let the skill auto-classify. Triggers on "html로 만들어줘", "HTML로 변환", "이걸 페이지로", "render as html", "html + png", "convert to html", "to html and png", "make a card", "make a deck", "make a poster", "make a report from this data".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
version: 0.1.0
license: ISC
---

# HTML Anything — Local Skill

Turn any blob of content into a ship-ready single-file HTML + a high-DPI PNG,
then drop both into the current Slack thread. The HTML is the artifact; the
PNG is the preview Slack can render inline.

This skill is a thin, vendored adaptation of
[`nexu-io/html-anything`](https://github.com/nexu-io/html-anything) (Apache-2.0).
See [`LICENSES/NOTICE.md`](./LICENSES/NOTICE.md) for attribution. Only 8
templates are bundled in v1; adding more is "drop a folder + one index entry".

## Prerequisites

- Node.js (already installed; soma-work ships with it).
- `playwright` is a real `dependencies` entry in the project's `package.json`,
  so it's present after `npm ci`. The Chromium **binary**, however, is not
  bundled — see the bootstrap step below.

### Bootstrap (idempotent — safe to re-run)

```bash
npx playwright install chromium 2>/dev/null || true
```

Run this once per machine. On a fresh container/host the renderer will print
`browserType.launch: Executable doesn't exist at …` if this step was skipped.
The bootstrap downloads ~150 MB; do it during image build, not on the
critical path of a Slack request.

## Inputs

| Input | Source |
|---|---|
| **Content** | The raw text, markdown, JSON, CSV, SQL, or notes the user pasted into the thread. Always required. |
| **Template name** (optional) | One of the entries under [`templates/index.json`](./templates/index.json). If omitted, the classifier in Step 2 picks one. |
| **Override viewport** (optional) | The user can override `width`/`height`/`fullPage` for the render step. |

## Workflow

### 1. Read the catalog

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/html/templates/index.json"
```

This produces the list of valid template names + their per-template viewport
overrides. The default viewport is `1200 × 1600`, `fullPage=true`,
`deviceScaleFactor=1`.

### 2. Pick a template (deterministic classifier)

If the user passed a template name and it exists in the catalog → use it.
Otherwise score the content against these buckets in order; first match wins.

| Bucket | Signal | Template |
|---|---|---|
| **Tabular data** | CSV / TSV header row, JSON array of objects, markdown table with ≥ 2 columns × ≥ 3 rows, SQL `SELECT … FROM` with sample rows, numeric metric stream. | `data-report` |
| **Meeting** | Words "agenda", "attendees", "action items", "decisions", or transcript shape (speaker labels + lines). | `meeting-notes` |
| **Résumé** | Words "experience", "education", "skills", "summary" + dated work history bullets. | `resume-modern` |
| **Deck outline** | Numbered slide headers, "slide 1", "intro / agenda / cta" pattern, or the user said "make a deck". | `deck-simple` |
| **Runbook** | Step-numbered procedure, "rollback", "on-call", "incident", "runbook", "deploy", `bash`/`sql`/`kubectl` blocks dominant. | `eng-runbook` |
| **Marketing one-pager** | Product feature list, pricing tiers, hero copy + CTA verbs ("Get started", "Sign up", "Pricing", "Features"). | `saas-landing` |
| **Single short quote** | Single paragraph or single quoted line, ≤ 280 effective characters, no headings. | `social-x-post-card` |
| **Default** | Anything else — long-form prose, memo, letter, report, raw notes. | `doc-kami-parchment` |

**Do not ask the user a follow-up.** If the classifier is ambiguous, fall
through to `doc-kami-parchment` and mention the fallback in Step 6's upload
comment ("classifier fell back to doc-kami-parchment — pass --template=… to
override").

### 3. Read the chosen template's SKILL.md

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/html/templates/skills/<name>/SKILL.md"
```

This is the design-system contract for that template (layout sections, hard
typography constraints, palette). The agent obeys this contract when
generating HTML. If the upstream template's `SKILL.md` is in Chinese or
mixed CJK, that's fine — the structural intent translates.

### 4. Generate HTML

Write a **single self-contained `.html` file** to the current session
working directory:

```
$(pwd)/html-<slug>-<ts>.html
```

The `<slug>` is a 2-4 word ASCII kebab from the content's title or first
heading; `<ts>` is `YYYYMMDD-HHMMSS`. `$(pwd)` is the runtime-guaranteed
`/tmp/{slackId}/session_…` directory — safe for both render and Slack upload.

**Global hard constraints** (apply to every template — these are what stops
the model from freestyling AI-slop defaults):

- **CJK-first font stack** — `"Noto Sans SC", "Noto Sans KR", "Noto Sans JP",
  source-han-sans, Inter, Manrope, system-ui, sans-serif`. For headings,
  swap in `"Noto Serif SC"` / `"Noto Serif KR"` when the template calls for
  a serif voice.
- **8 px baseline grid** — every spacing, line-height, font-size is a
  multiple of 8 (allowed mid-step: 4 for hairline details).
- **Contrast ≥ 4.5** for any body text against its background. WCAG AA.
- **No pure black / pure white** — use `#0f172a` (slate-900) for ink,
  `#fafaf9` (stone-50) for paper, unless the template's palette overrides.
- **No lorem ipsum** — use the user's real data. If the user's data has a
  hole the template requires, leave it blank with a visible placeholder
  (e.g., `[—]`), do **not** invent content.
- **Rounded corners + soft shadow + real `:focus`** on interactive elements
  (buttons / links).

You may use a Tailwind CDN (`https://cdn.tailwindcss.com`) and Google Fonts
(`https://fonts.googleapis.com/css2?family=Noto+Sans+SC…`). Both are
allowed at render time — Playwright waits for `networkidle` before the
screenshot.

### 5. Render to PNG

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/html/renderer/render.mjs" \
  --input "$(pwd)/html-<slug>-<ts>.html" \
  --output "$(pwd)/html-<slug>-<ts>.png" \
  --template "<name>"
```

The renderer pulls geometry from `templates/index.json` based on
`--template <name>`. Pass `--width` / `--height` / `--full-page` /
`--no-full-page` / `--selector` to override.

### 6. Validate the PNG

```bash
PNG="$(pwd)/html-<slug>-<ts>.png"
[ -f "$PNG" ] || { echo "ERROR: PNG not generated"; exit 1; }
size=$(stat -f%z "$PNG" 2>/dev/null || stat -c%s "$PNG")
[ "$size" -gt 4096 ] || { echo "ERROR: PNG suspiciously small: $size bytes"; exit 1; }
python3 - "$PNG" <<'PY'
import struct, sys
p = sys.argv[1]
with open(p, "rb") as f:
    if f.read(8) != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("not a PNG")
    f.read(4)
    if f.read(4) != b"IHDR":
        raise SystemExit("invalid PNG header")
    w, h = struct.unpack(">II", f.read(8))
    if w < 400 or h < 300:
        raise SystemExit(f"dim-fail:{w}x{h}")
PY
```

### 7. Dual upload to Slack

```
mcp__slack-mcp__send_media(
  file_path="<absolute path to PNG>",
  title="<meaningful artifact title>",
  alt_text="<1-2 sentence description of what the page shows>",
  initial_comment="<template name used + any fallback note>"
)
mcp__slack-mcp__send_file(
  file_path="<absolute path to HTML>",
  title="<same slug>.html (open in browser to edit / re-render)",
  initial_comment="Single-file HTML. Drag into a browser tab."
)
```

If the slack-mcp tools are not available in this session (e.g., the skill
was invoked outside a Slack-mention context), skip the uploads, print both
absolute paths, and end the turn.

### 8. End the turn

One-line confirmation: `template used`, `PNG path`, `HTML path`. No
preamble. No follow-up question — the classifier resolves ambiguity by
falling through to `doc-kami-parchment`, and the user can re-invoke with
an explicit `--template=<name>` if they want a different look.

## Anti-patterns

- Do **not** ask the user "which template?" — the classifier is the
  contract. Fall through to `doc-kami-parchment` if nothing scores.
- Do **not** invent missing data ("lorem ipsum", placeholder companies,
  fake metrics) to fill template sections. Leave them blank with `[—]`.
- Do **not** inline a 200-line Playwright script into the agent's response —
  call `renderer/render.mjs` instead.
- Do **not** `npm install` at request time. Treat `playwright` as a hard
  runtime dep; failing import → tell the user to rebuild the image.
- Do **not** upload the HTML as inline mrkdwn — Slack mangles `<style>` and
  long lines. Always `send_file`.
- Do **not** loop on render failure. One retry on transient
  `networkidle`/`navigation` errors; if the second attempt fails, report
  the error and stop.
- Do **not** mix two templates into one HTML. If the input has two clearly
  different shapes, render twice and upload both.

## Adding more templates

V1 ships 8 templates. To add more from the html-anything catalog (75 total):

1. `mkdir templates/skills/<new-name>/`
2. `curl -fsSL https://raw.githubusercontent.com/nexu-io/html-anything/main/src/lib/templates/skills/<new-name>/SKILL.md -o templates/skills/<new-name>/SKILL.md`
3. Append an entry to `templates/index.json` with `name`, `surface`,
   `description`, `picks_when`, `spec`, and (if non-default canvas)
   `viewport`.
4. Update the classifier table in Step 2 of this SKILL.md.
5. Update `LICENSES/NOTICE.md`'s vendored-templates list.
6. Update the RED test's `REQUIRED_TEMPLATES` whitelist
   ([`__tests__/html-skill.test.ts`](./__tests__/html-skill.test.ts)).

## References

- [`templates/index.json`](./templates/index.json) — template catalog with
  per-template viewport overrides.
- [`templates/skills/<name>/SKILL.md`](./templates/skills/) — vendored
  template specs from html-anything (Apache-2.0).
- [`renderer/render.mjs`](./renderer/render.mjs) — Playwright HTML → PNG
  CLI.
- [`LICENSES/NOTICE.md`](./LICENSES/NOTICE.md) — third-party attribution.
- [`__tests__/html-skill.test.ts`](./__tests__/html-skill.test.ts) — RED
  contract that pins the v1 surface (frontmatter, classifier templates,
  renderer presence, license attribution).

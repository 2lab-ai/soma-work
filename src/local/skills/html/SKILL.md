---
name: html
description: Convert any content (markdown, plain text, JSON, CSV, SQL, raw notes) into a styled single-file HTML with a Lottie motion layer and a rendered PNG, publish the HTML on the local web server (clickable access link), then upload both files to the current Slack thread. The visual design is driven by the `ui-ux` skill as the main design engine — applied by default on EVERY invocation, whether or not the user mentions design (design-system + named references; default reference `openai`); a `design=` input selects the design driver deterministically — `default`, any registered reference (for example `claude`, `toss-blue`, `toss-black`), or `impeccable` — with the `design` skill applied on top as the anti-AI-slop layer and the `motion-design`/`apple-design` standards governing all CSS motion and display typography. Pick a template name from the catalog or let the skill auto-classify. Triggers on "html로 만들어줘", "HTML로 변환", "이걸 페이지로", "render as html", "html + png", "convert to html", "to html and png", "make a card", "make a deck", "make a poster", "make a report from this data".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
version: 0.5.0
license: ISC
---

# HTML Anything — Local Skill

Turn any blob of content into a ship-ready single-file HTML + a high-DPI PNG,
publish the HTML on a local web server, then drop both files **and the live
access link** into the current Slack thread. The HTML is the artifact; the
PNG is the static preview Slack can render inline; the served URL is where
the page actually *lives* — Lottie motion (Step 3.7) only exists in a real
browser tab, so the link is a first-class deliverable, not a nicety.

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
| **Design** (optional) | `design=<value>` picks the design driver: `default` (the registry default reference, currently `openai`), any reference name registered in `ui-ux/references/index.json` (`openai`, `claude`, `il-capo-production`, `toss-blue`, `toss-black`, …), or `impeccable`. Callers such as `autoz` pass it explicitly; users may also just name a reference. Resolved in Step 3.4 — an unknown value stops the run. |

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

### 3.4. Resolve the design driver (`design=`) — `ui-ux` registry, always on

The **`ui-ux`** skill and its named-reference registry are the **main design
driver** for this skill, and this step is **not opt-in**: run it on every
invocation, even when the user says nothing about design, style, or
references. The user asking for "HTML" IS the request for a designed page — do
not wait for a design keyword, and do not skip to raw markup because the
content seems plain. Skip this step only when the user explicitly opts out
(e.g. asks for "unstyled/bare HTML"). You are on the critical path of one
Slack request — *do not ask the user anything* in this step.

**One driver per page.** Resolve the driver in this fixed order:

1. explicit `design=` input (Inputs table) — `default`, a registered reference
   name, or `impeccable`;
2. user-named reference ("use the `<name>` reference", "토스 스타일로" →
   `toss-blue`);
3. brand context the user supplied (palette / codebase / screenshot) — lift that
   real system per the `design` skill's design-context rules;
4. registry default — the entry with `"default": true` in
   `ui-ux/references/index.json` (currently **`openai`**). `design=default`
   selects it explicitly.

An unknown value is an error: stop, print the valid values, and render nothing.
Never silently fall back to another driver or to the default.

Bot shells do not set `CLAUDE_PLUGIN_ROOT`; export it first in every bash
call (`export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<this skill's base directory>/../..}"`).

```bash
UIUX="${CLAUDE_PLUGIN_ROOT:-}/skills/ui-ux"
[ -d "$UIUX" ] || UIUX="$(git rev-parse --show-toplevel 2>/dev/null)/src/local/skills/ui-ux"
python3 - "$UIUX" "${DESIGN:-default}" <<'RESOLVE'
import json, os, sys
root, want = sys.argv[1], sys.argv[2]
refs = json.load(open(os.path.join(root, "references", "index.json")))["references"]
if want == "impeccable":
    print("driver=impeccable"); sys.exit(0)
if want == "default":
    want = next(r["name"] for r in refs if r.get("default"))
hit = next((r for r in refs if r["name"] == want), None)
if hit is None:
    sys.exit(f"unknown design={want}; valid: default, impeccable, " + ", ".join(r["name"] for r in refs))
print("driver=reference"); print("reference=" + hit["name"])
print("design_md=" + os.path.normpath(os.path.join(root, hit['path'])))
if hit.get("tokens"): print("tokens_css=" + os.path.normpath(os.path.join(root, hit["tokens"])))
if hit.get("family"): print("family=" + hit["family"])
RESOLVE
```

Every reference file is resolved through the index `path` field (relative to
the `ui-ux` skill root) — never by assembling `references/<name>/…` yourself,
because some references live in another skill (the toss themes live in
`toss-design`).

**The selected design system owns font, spacing, radius and material.** Step
4's global defaults (font stack, pure-black/white rule, rounded corners) and
the Step 3.6 Apple material treatment apply only where the selected system is
silent. The shared floor on every path is accessibility, reduced motion, and
content preservation (real data only, nothing invented).

#### Reference driver (`default`, `openai`, `claude`, `il-capo-production`, `toss-blue`, `toss-black`, …)

1. **Run the design-system engine (REQUIRED).** This is `ui-ux` Step 2 — it
   returns the pattern, style, colors, typography, and effects with reasoning:
   ```bash
   cat "$UIUX/SKILL.md"
   python3 "$UIUX/scripts/search.py" "<product/content type> <industry> <keywords>" --design-system -f markdown
   ```
   Derive the keywords from the content + the template chosen in Step 2.
2. **Apply the resolved reference as the visual North Star.** `cat` the
   `design_md` path printed above. Its palette, typography, layout, and motion
   language **override** the engine's generic output and this skill's default
   palette when they conflict (per the `ui-ux` skill's Named Design References
   contract). The engine output fills only the gaps the reference is silent on.
3. **Theme tokens.** When the entry has a `tokens` field, inline that
   `tokens.css` into the page's `<style>` and use its semantic tokens
   (`--color-primary`, `--color-text`, …) instead of raw hex. When the entry's
   `family` is `toss-design`, also read
   `$CLAUDE_PLUGIN_ROOT/skills/toss-design/SKILL.md` in its programmatic mode
   and build with its component recipes (Top, ListRow, Badge, Button,
   BottomCTA …). The toss tokens and components have final visual authority —
   generic engine output never overrides them.
4. **Honor ui-ux quality gates.** The reference sets aesthetic direction, never
   permission to break ui-ux Quick Reference §1–§3 (accessibility, touch targets,
   performance) — verify color pairs meet the §1 contrast rules.

#### Impeccable driver (`design=impeccable`)

Read `$CLAUDE_PLUGIN_ROOT/skills/impeccable/SKILL.md` and follow its
**soma-work local additions → html driver mode** section exactly: the
positive read list (mode file for the template, then `craft-floor.md`), no
questions, no launcher, no `new-work.md`. On this path the `ui-ux` engine and
named references are **not used** (one visual owner), Step 3.5 does not run,
and Step 3.7 changes as noted there. Label the upload "Impeccable —
document-based application".

#### Record the choice

Write a one-line HTML comment at the top of the file, e.g.
`<!-- ui-ux: driver=reference · reference=openai · theme=none · design-system=Dark Mode/Inter · template=data-report -->`
or `<!-- ui-ux: driver=impeccable · mode=Read · world=<one line> · template=data-report -->`,
so the decision is auditable. Do not narrate it in the Slack reply.

This step never blocks and never asks a question — it is a deterministic
registry lookup + file read. The classifier in Step 2 and the auto-flow are
unchanged.

### 3.5. Apply the `design` skill as the anti-AI-slop layer

**Reference drivers only.** On the impeccable driver this step is skipped —
impeccable's own `craft-floor.md` is that path's anti-slop layer, and running
both rule sets would give the page two owners.

After the reference driver (Step 3.4) has set the visual voice, read the
**`design`** skill and apply it *on top* — it is the anti-AI-slop discipline that
stops the output from sliding back into a model's reflexive default.

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/design/SKILL.md"
```

Operate the `design` skill in its **programmatic mode** (Mode A — *do not ask
the user anything*; you are on the critical path of one Slack request):

1. **The visual direction is already set by `ui-ux` (Step 3.4).** Do not let the
   `design` skill's style selector override the active ui-ux reference — use the
   `design` skill only to *enforce* its **anti-AI-slop hard rules** on top of the
   ui-ux palette/type. Priority order: the active **ui-ux reference governs the
   visual voice**, the template SKILL.md governs *structure/layout*, and the
   `design` skill's anti-slop rules govern *what never to do* (no rainbow
   gradients, no left-border accent cards, no decorative emoji, no SVG hero
   imagery, no invented stats/fonts/colors). The `design` skill's own style
   selector is not used here — Step 3.4 always resolves a driver.
   **Font priority:** a font the active reference names (for example the
   `openai` reference's Inter stand-in, or Pretendard for `toss-*`) wins over the
   `design` skill's "tired fonts" list. That list governs fonts *you* pick where
   the reference is silent.
2. **Record nothing extra** — the auditable choice line is already written in
   Step 3.4. Do not narrate the design decision in the Slack reply.

This step never blocks and never asks a question — it is a deterministic anti-slop
pass layered on the ui-ux driver. The classifier in Step 2 and the auto-flow are
unchanged.

### 3.6. CSS motion & typography craft (`motion-design` + `apple-design` layer)

Lottie (Step 3.7) is the *decorative* motion layer. Every **authored CSS
transition/animation** on the page (entrances, hover states, links, buttons)
is governed by the motion-design standards instead. On the impeccable driver,
`craft-floor.md` owns motion (one authored moment) and these standards only
fill what it leaves open; the reduced-motion rule below and "no layout
properties" stay as html's local limits on every path. Read the shared source of
truth before writing any `transition`/`@keyframes`/`@starting-style` rule:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/motion-design/references/motion-standards.md"
```

Apply these non-negotiables to all authored CSS motion:

- **Entrances** use `@starting-style` (no JS) with a strong custom ease-out —
  `cubic-bezier(0.23, 1, 0.32, 1)`, never a weak built-in easing and never
  `ease-in`. Never enter from `scale(0)` — start `scale(0.95–0.97)` + opacity.
  Groups of items (cards, list rows, KPI tiles) get a 30–80ms stagger, not an
  everything-at-once pop.
- **Durations**: UI elements ≤ 300ms; only slow ambient/decorative motion may
  exceed it. Never `transition: all` — name exact properties.
- **Compositor-only**: animate `transform` and `opacity`; never layout
  properties (`width`/`height`/`margin`/`top`…).
- **Hover/press**: hover motion gated behind
  `@media (hover: hover) and (pointer: fine)`; pressable elements get
  `transform: scale(0.97)` on `:active`.
- **Reduced motion**: one `@media (prefers-reduced-motion: reduce)` block
  covers *both* the CSS motion and the Lottie layer — keep opacity/color
  changes, drop movement.

Typography refinement, from the [`apple-design`](../apple-design/SKILL.md)
skill (§15 Typography, §12 Materials): tracking is **size-specific** — display
headings get negative letter-spacing (≈ `-0.02em`) and tight leading
(`1.05–1.15`); body copy stays near `0` tracking with comfortable leading
(`1.5`). Sticky headers/toolbars may use the translucent-material treatment
(`backdrop-filter: blur() + semi-transparent background`) — never stack two
light translucent surfaces, and pair it with `prefers-reduced-transparency`
fallback when used. The material treatment is optional styling: skip it when
the selected system defines its own surfaces (the toss tokens do).

This step is deterministic reference reading — it never blocks and never asks
the user anything.

### 3.7. Plan the motion layer (`lottie` skill)

Every page gets a **Lottie motion layer** unless the user opts out
(`--no-motion`), the surface is print-shaped (`resume-modern`), or the driver is
`impeccable` — there the automatic layer is off and at most one Lottie may serve
as craft-floor's single authored moment. Reference drivers, the toss themes
included, keep this step unchanged. Read the
**`lottie`** skill — it is the authoring contract (vendored from
[`diffusionstudio/lottie`](https://github.com/diffusionstudio/lottie)) for
writing valid Bodymovin JSON by hand:

```bash
cat "$CLAUDE_PLUGIN_ROOT/skills/lottie/SKILL.md"
```

Operate it in **embed mode**: author 1–3 small shape-layer animations
yourself, inline each as `animationData`, and load them with the pinned
lottie-web CDN snippet from that skill. Placement is template-driven:

| Template | Motion job (pick 1–2) |
|---|---|
| `data-report` | KPI pulse on the headline number; a drawing-in trim-path underline on the title. |
| `deck-simple` | Cover-slide hero accent (looping geometric motif); subtle slide-marker pulse. |
| `saas-landing` | Hero accent next to the headline; animated checkmark on the primary feature. |
| `meeting-notes` / `eng-runbook` | One status cue: animated check (decisions/done) or pulsing dot (open items / on-call). |
| `social-x-post-card` | One ambient accent behind/beside the quote — slow, ≤ 6 s loop. |
| `doc-kami-parchment` | A single subtle ambient texture or header ornament — or none if it fights the parchment calm. |
| `resume-modern` | **None.** Print surface. |

Hard rules (the `design` skill's anti-slop discipline extends to motion):
palette-locked colors (0–1 RGBA from the chosen direction), eased keyframes,
seamless loops, `prefers-reduced-motion` honored, `aria-hidden="true"` on
decorative containers, **never** hotlink animation URLs at runtime. Validate
each authored JSON with the lottie skill's `validate.mjs` before inlining
when the animation is non-trivial (> 2 layers).

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
the model from freestyling AI-slop defaults). The font stack, the
pure-black/white rule and the rounded-corner rule are *defaults*: the selected
design system (Step 3.4) overrides them where it specifies its own values.
Contrast, real data and reduced motion are never overridden:

- **CJK-first font stack** — `"Noto Sans SC", "Noto Sans KR", "Noto Sans JP",
  source-han-sans, Inter, Manrope, system-ui, sans-serif`. For headings,
  swap in `"Noto Serif SC"` / `"Noto Serif KR"` when the template calls for
  a serif voice.
- **8 px baseline grid** — every spacing, line-height, font-size is a
  multiple of 8 (allowed mid-step: 4 for hairline details).
- **Contrast ≥ 4.5** for any body text against its background. WCAG AA.
- **No pure black / pure white** — use `#0f172a` (slate-900) for ink,
  `#fafaf9` (stone-50) for paper, **unless** the template's palette or the active
  `ui-ux` reference (Step 3.4) intentionally specifies pure values. A named
  reference's palette wins over this default (e.g. the `openai` reference uses
  true `#000`/`#FFF`) as long as it still clears the contrast gate.
- **No lorem ipsum** — use the user's real data. If the user's data has a
  hole the template requires, leave it blank with a visible placeholder
  (e.g., `[—]`), do **not** invent content.
- **Rounded corners + soft shadow + real `:focus`** on interactive elements
  (buttons / links).
- **CSS motion follows Step 3.6** — strong custom easing (never `ease-in`,
  never `transition: all`), UI durations ≤ 300ms, `transform`/`opacity` only,
  entrances ≥ `scale(0.95)` via `@starting-style`, 30–80ms stagger on groups,
  hover gated behind `@media (hover: hover) and (pointer: fine)`,
  `prefers-reduced-motion` honored.
- **Display typography is size-specific** (Step 3.6) — negative tracking
  (≈ `-0.02em`) + tight leading on large headings; body near `0` tracking.
- **Motion stays inline and quiet** — Lottie JSON from Step 3.7 is embedded
  as `animationData` (single-file rule: no `path:` fetches of separate
  `.json` files), ≤ 3 animations per page, each loop seamless and
  `prefers-reduced-motion`-guarded. The only allowed motion runtime is the
  pinned `lottie-web@5.13.0` CDN script from the `lottie` skill.

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

The renderer also prints one `fonts loaded: <families>` line — keep it for
Step 6.

The PNG freezes Lottie mid-loop — that's expected; the live link (Step 7)
carries the motion. If the captured frame looks empty because an animation
starts from opacity 0, pass `--wait-ms 1500` so the screenshot lands on a
populated frame.

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

Then check what the bytes cannot tell you:

1. **Font check.** Compare the renderer's `fonts loaded:` line with the
   display and body families the driver declared (for example `Pretendard` for
   `toss-*`, `Inter` for `openai`). A declared family missing from the line means
   the page fell back to a system font: say so in the Step 8 upload comment
   (`font fallback: <declared> → system`) and never present the PNG as
   rendered in the declared font.
2. **Look at the PNG.** Open it with the Read tool once and check for clipped
   or overlapping text, missing sections, unreadable contrast, and an empty
   motion frame. Fix what one look shows, re-render once, then move on — this
   is a delivery check, not a design critique loop.

### 7. Publish to the local web server (access link + durable archive)

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/html/server/serve.mjs" \
  --file "$(pwd)/html-<slug>-<ts>.html"
```

This copies the HTML into the **serve root, which doubles as the permanent
artifact archive**, ensures a long-lived static-server daemon is listening
(spawned detached on first use — idempotent, survives the agent turn, reused
across sessions), and prints JSON:

```json
{ "url": "http://<lan-ip>:8763/html-<slug>-<ts>.html",
  "localUrl": "http://localhost:8763/html-<slug>-<ts>.html",
  "port": 8763, "file": "<serve-root>/html-<slug>-<ts>.html" }
```

**Serve root = archive.** The root resolves in this order (first hit wins):
`SOMA_HTML_SERVE_ROOT` env override → `$XDG_DATA_HOME/soma-html-serve` →
`~/.local/share/soma-html-serve` (the default on macOS and Linux) → the
legacy `/tmp/soma-html-serve` only when no home directory is resolvable.
Never point the root at a system temp directory yourself: OS temp cleanup
deletes every published artifact — a week of reports once vanished this way
and had to be reconstructed from session transcripts. Archive policy:
artifacts are timestamped by the Step 4 filename, retained indefinitely
(no auto-pruning), and listable at the daemon's `/` index newest-first;
reclaiming disk is a human decision, not the server's.

**Migration & mixed versions** (automatic): every publish and daemon start
sweeps regular files still in the legacy `/tmp` root into the durable
archive (existing names are never overwritten; symlinks are never followed).
Sweep failures don't block publishing but are surfaced on stderr and as a
`migrationErrors` count in the JSON — a silent sweep is not assumed to have
worked. The printed link is **verified with a real HTTP 200 before it is
handed out**: if an older daemon is still serving a different root, publish
places a compat copy, verifies, and marks the JSON with a `note`; if the old
daemon can't be verified, publish starts a fresh daemon on the next free
port instead of printing a dead link. (Old publishers meeting a new daemon
read its health reply as foreign and self-heal onto another port — accepted
port drift, never a silent 404.) Re-publishing the same filename refreshes
that artifact in place — timestamps in the filename are what make archive
entries distinct.

**The archive is LAN-readable, indefinitely.** With the default `0.0.0.0`
bind, everything published is listable and readable by anyone on the local
network for as long as it stays in the archive — never publish pages
containing secrets, tokens, or personal data. If something sensitive was
published, delete that file from the serve root yourself (that is the
removal procedure; there is no expiry).

Use `url` (LAN IP) as the access link you hand to the user — `localhost`
only works on the host machine itself; include it as a secondary mention.
Verify the link before sharing it:

```bash
curl -fsS -o /dev/null -w '%{http_code}' "<url>"   # must print 200
```

If the server cannot start (exit 2), report it in the upload comment and
fall back to file-only delivery — do not block the artifact on the link.

### 8. Dual upload to Slack (+ the link)

```
mcp__slack-mcp__send_media(
  file_path="<absolute path to PNG>",
  title="<meaningful artifact title>",
  alt_text="<1-2 sentence description of what the page shows>",
  initial_comment="<template + design driver used (+ 'Impeccable — document-based application' on that driver) + any fallback note> — live: <url from Step 7>"
)
mcp__slack-mcp__send_file(
  file_path="<absolute path to HTML>",
  title="<same slug>.html (open in browser to edit / re-render)",
  initial_comment="Single-file HTML. Live (with motion): <url from Step 7>"
)
```

If the slack-mcp tools are not available in this session (e.g., the skill
was invoked outside a Slack-mention context), skip the uploads, print both
absolute paths plus the served URL, and end the turn.

### 9. End the turn

One-line confirmation: `template used`, `PNG path`, `HTML path`, **served
URL**. No preamble. No follow-up question — the classifier resolves
ambiguity by falling through to `doc-kami-parchment`, and the user can
re-invoke with an explicit `--template=<name>` if they want a different
look.

## Anti-patterns

- Do **not** ask the user "which template?" — the classifier is the
  contract. Fall through to `doc-kami-parchment` if nothing scores.
- Do **not** substitute a driver for an unknown `design=` value, and do not
  run two visual owners on one page (impeccable + the `design` layer, or a
  toss theme recoloured by the generic engine palette).
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
- Do **not** decorate with stock-sticker motion — every Lottie animation
  needs a job (Step 3.7's table). More than 3 per page, hotlinked `.json`
  URLs, or off-palette colors are all slop.
- Do **not** hand the user a link you haven't `curl`-verified, and do not
  ship `localhost` as the primary link — it only resolves on the host.
- Do **not** point `SOMA_HTML_SERVE_ROOT` at a system temp directory, and do
  not "clean up" the serve root as part of a task — it is the artifact
  archive; pruning it is the user's call.

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

- [`../ui-ux/SKILL.md`](../ui-ux/SKILL.md) — the `ui-ux` skill, the **main
  design driver**. Step 3.4 runs its `--design-system` engine and applies its
  active named reference (default `openai`) as the visual North Star before
  generating HTML.
- [`../ui-ux/references/index.json`](../ui-ux/references/index.json) — the named
  design reference registry; the entry with `"default": true` is what Step 3.4
  applies when the user names no reference.
- [`../design/SKILL.md`](../design/SKILL.md) — the `design` skill. Step 3.5
  applies it *on top of* a reference driver as the anti-AI-slop discipline before
  generating HTML.
- [`../impeccable/SKILL.md`](../impeccable/SKILL.md) — the vendored Impeccable
  skill (pbakaus/impeccable, Apache-2.0, docs-only). Step 3.4 uses its html
  driver mode when `design=impeccable`.
- [`../toss-design/SKILL.md`](../toss-design/SKILL.md) — Toss TDS design skill
  with selectable themes `toss-blue` (its default) and `toss-black`; both are
  registered as ui-ux references that point at its theme files.
- [`../motion-design/references/motion-standards.md`](../motion-design/references/motion-standards.md)
  — the shared motion standards (easing curves, duration budgets, reduced-motion
  rules). Step 3.6 applies them to every authored CSS transition/animation.
- [`../apple-design/SKILL.md`](../apple-design/SKILL.md) — Apple's fluid-interface
  craft (vendored from emilkowalski/skills, MIT). Step 3.6 pulls its
  size-specific typography (§15) and translucent-material (§12) rules.
- [`../lottie/SKILL.md`](../lottie/SKILL.md) — the `lottie` skill
  (vendored from diffusionstudio/lottie). Step 3.7 consults it to author the
  inline motion layer.
- [`server/serve.mjs`](./server/serve.mjs) — local static web server CLI.
  Step 7 publishes the HTML and returns the access link.
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

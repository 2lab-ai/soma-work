---
name: architecture-diagram
description: Draw a system architecture diagram as Excalidraw JSON + rendered PNG, then upload both to Slack. Triggers on "아키텍처 그려줘", "아키텍쳐 다이어그램", "구조도 그려줘", "architecture diagram", "system diagram", "draw architecture".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
version: 2.1.0
license: MIT
---

# Architecture Diagram Skill

Produce a dark-themed system architecture diagram as a pair of artifacts:

1. `arch-<slug>-<ts>.excalidraw` — editable JSON source (open at excalidraw.com)
2. `arch-<slug>-<ts>.png` — rendered image for Slack preview

Both are uploaded to the current Slack thread via `mcp__slack-mcp__send_media` (PNG) and `mcp__slack-mcp__send_file` (JSON).

## Prerequisites

Bundled in `references/` (vendored, no external plugin dependency):

- `render_excalidraw.py` — Playwright-based renderer
- `render_template.html` — loads Excalidraw ES module from esm.sh
- `pyproject.toml`, `uv.lock` — Python deps

Runtime:

- `uv` + Python 3.11+ on PATH
- Network access to `esm.sh` at render time (already allow-listed in dev sandbox)
- Chromium binary (installed on first use by the bootstrap step below)

## Workflow

### 1. Understand the system

List components + directional flows. Classify each component by semantic type (see palette). If input is too thin to render safely, ask a follow-up via structured UI (UIAskUserQuestion) — do not hallucinate.

### 1.5. Plan (conditional)

**Trigger:** Apply this step only when **either** condition holds:

- Component count ≥ 10, OR
- The user explicitly signals complexity (e.g. "multi-region", "end-to-end", "full platform", "하이 레벨 전체 구조").

For simple diagrams (< 10 components, single concern), skip directly to Step 2 — Plan-then-Render has real overhead and is not worth it for small cases.

**When triggered**, produce a short markdown plan **before** writing any JSON:

```markdown
## Components
- <name> — <semantic type> — <1-line reason>
- …

## Edges
- <from> → <to> — <label / protocol>
- …

## Grouping
- <cluster name>: [<member>, <member>, …]
- …
```

Then render the plan into JSON in Step 2. The plan is an internal artifact — do not upload it to Slack. Its purpose is to surface structural mistakes (missing component, wrong edge direction, bad clustering) at plan-level where they are cheap to fix, instead of at JSON or render level where they are expensive.

### 2. Generate `.excalidraw` JSON

Write to `$(pwd)/arch-<slug>-<ts>.excalidraw` where `$(pwd)` is the session working directory (runtime guarantees `/tmp/{slackId}/session_*` — safe for Slack upload).

Required settings:

- `appState.viewBackgroundColor`: `"#020617"` (slate-950)
- `appState.gridSize`: `20`
- Rectangles: `roundness: { "type": 3 }`, `roughness: 0`
- Arrows: `roundness: { "type": 2 }`, must set `startBinding` + `endBinding`
- Text elements: `strokeColor` MUST be `#e2e8f0` (slate-200) **or** match the parent container's stroke color from the palette — black text is invisible on dark bg

Semantic color palette (fill + stroke pair):

| Component | fill (bg) | stroke (border/text) |
|-----------|-----------|----------------------|
| Frontend | `#083344` | `#22d3ee` (cyan-400) |
| Backend | `#064e3b` | `#34d399` (emerald-400) |
| Database | `#4c1d95` | `#a78bfa` (violet-400) |
| AWS / Cloud | `#78350f` | `#fbbf24` (amber-400) |
| Security | `#881337` | `#fb7185` (rose-400) |
| Message Bus | `#7c2d12` | `#fb923c` (orange-400) |
| External | `#1e293b` | `#94a3b8` (slate-400) |

Reference: see `references/json-schema.md` and `references/element-templates.md` for concrete element shapes.

### 3. Bootstrap the renderer (first run only)

Idempotent — safe to re-run:

```bash
cd "$CLAUDE_PLUGIN_ROOT/skills/architecture-diagram/references"
uv sync 2>/dev/null
uv run playwright install chromium 2>/dev/null
```

### 4. Pre-flight esm.sh network check

```bash
if ! curl -fsSI --max-time 5 https://esm.sh/ >/dev/null 2>&1; then
  echo "ERROR: esm.sh unreachable — renderer requires network access to esm.sh." >&2
  exit 2
fi
```

If this fails, do NOT proceed; report the error and endTurn.

### 5. Render to PNG

```bash
cd "$CLAUDE_PLUGIN_ROOT/skills/architecture-diagram/references"
uv run python render_excalidraw.py "$(pwd_of_json)/arch-<slug>-<ts>.excalidraw"
```

The renderer writes PNG next to the input JSON.

### 6. Validate PNG (composite check)

```bash
PNG="$(pwd_of_json)/arch-<slug>-<ts>.png"
[ -f "$PNG" ] || { echo "ERROR: PNG not generated"; exit 1; }
size=$(stat -f%z "$PNG" 2>/dev/null || stat -c%s "$PNG")
[ "$size" -gt 5120 ] && [ "$size" -lt 10485760 ] || { echo "ERROR: PNG size suspect: $size bytes"; exit 1; }
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

### 6.5. Visual Critic

Mechanical checks in Step 6 catch missing files and degenerate dimensions — they do **not** catch visual mistakes (misrouted arrows, overlapping boxes, clipped labels, wrong semantic colors). Run a vision-based self-critique pass:

1. **Re-read the PNG** with the `Read` tool (Claude is multimodal — the rendered image becomes part of the conversation).
2. **Walk the checklist** in `references/critic-checklist.md` — all 6 items.
3. **Decide**:
   - All 6 items pass → proceed to Step 7.
   - One or more items fail → identify the offending element IDs, revise **only** those elements in the JSON, re-run Step 5 (render) and Step 6 (validate), then re-critique. Each such revise+re-render+re-critique counts as **one** critic-driven revision against the Step 7 budget (max 2).

Common failure modes to look for:

- Arrows visually disconnected from their intended source/target (binding coords stale after element resize).
- Label text overflowing its container or colliding with another element.
- Two rectangles overlapping because the layout was packed too tightly.
- Text rendered in near-black (`#1e1e1e`) on the dark background — invisible.
- Same semantic role (e.g. two Database components) rendered in different colors.
- Arrow direction reversed vs. the flow described in Step 1 (or in the plan from Step 1.5, if that step was triggered).

### 7. Retry policy

After the **initial render** (Step 5), the skill may perform up to **3 retries** before stopping. A retry is a full render+validate+critique pass that replaces the previous one. The 3-retry budget is partitioned by cause:

- **Mechanical error** (render command fails, PNG missing, header invalid, dims < 400×300 in Step 6): retry **once** after fixing the root cause.
- **Critic-identified visual issues** (any checklist item in Step 6.5 fails): revise + re-render up to **2 times**.

These two allotments are independent — a mechanical failure followed later by a critic failure is legal, as long as each stays within its own cap. After the budget is exhausted, stop. `endTurn` with the captured stderr (for mechanical errors) or the final critique notes (for visual failures). Do not loop.

### 8. Dual upload to Slack

```
mcp__slack-mcp__send_media(
  file_path="<absolute path to PNG>",
  title="<meaningful architecture title>",
  alt_text="<1-2 sentence description of what the diagram shows>",
  initial_comment="<optional 1-line context>"
)
mcp__slack-mcp__send_file(
  file_path="<absolute path to .excalidraw>",
  title="<same slug>.excalidraw (editable source)",
  initial_comment="Open at excalidraw.com to edit."
)
```

If the session is NOT in a Slack-mention context (slack-mcp unavailable), the artifacts remain at `$(pwd)` and the skill reports the paths instead of uploading.

### 9. End the turn

One-line confirmation. No preamble. No follow-up question unless the input was thin enough to warrant UIAskUserQuestion.

## Anti-patterns

- Do NOT use rough/hand-drawn style (`roughness > 0`).
- Do NOT omit `startBinding` / `endBinding` on arrows — breaks layout on resize.
- Do NOT leave text `strokeColor` at the default `#1e1e1e` — it disappears on dark backgrounds.
- Do NOT exceed ~20 components in one diagram. Split instead.
- Do NOT exceed the Step 7 retry budget (1 mechanical + 2 critic-driven = 3 retries). Escalate to the user after the budget is exhausted.
- Do NOT skip Step 6.5 on the assumption that the mechanical check is sufficient — it never is for visual correctness.

## References

- `references/color-palette.md` — full semantic mapping
- `references/element-templates.md` — copy-paste element JSON + canonical archetype skeletons
- `references/critic-checklist.md` — 6-item visual self-critique checklist used in Step 6.5
- `references/json-schema.md` — Excalidraw JSON schema (minimal)
- `templates/template.html` — legacy HTML/SVG visual reference (dev-only)

---
name: architecture-diagram
description: Draw a system architecture diagram as Excalidraw JSON + rendered PNG, then upload both to Slack. Triggers on "아키텍처 그려줘", "아키텍쳐 다이어그램", "구조도 그려줘", "architecture diagram", "system diagram", "draw architecture".
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
version: 2.0.0
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

### 2. Generate `.excalidraw` JSON

Write to `$(pwd)/arch-<slug>-<ts>.excalidraw` where `$(pwd)` is the session working directory (runtime guarantees `/tmp/{slackId}/session_*` — safe for Slack upload).

Required settings:

- `appState.viewBackgroundColor`: `"#020617"` (slate-950)
- `appState.gridSize`: `20`
- Rectangles: `roundness: { "type": 3 }`, `roughness: 0`
- Arrows: `roundness: { "type": 2 }`, must set `startBinding` + `endBinding`
- Text elements: `strokeColor` MUST be `#e2e8f0` (slate-200) or lighter — black text is invisible on dark bg

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

### 7. Retry policy

If any check in step 5 or 6 fails:

- Adjust JSON (fix bindings, spacing, text color) and re-run steps 5–6 ONCE.
- On 2nd failure: endTurn with the captured stderr from `uv run …`. Do not loop.

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
- Do NOT retry more than once. Escalate to the user.

## References

- `references/color-palette.md` — full semantic mapping
- `references/element-templates.md` — copy-paste element JSON
- `references/json-schema.md` — Excalidraw JSON schema (minimal)
- `templates/template.html` — legacy HTML/SVG visual reference (dev-only)

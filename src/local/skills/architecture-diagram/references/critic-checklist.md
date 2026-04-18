# Visual Critic Checklist

Used by **Step 6.5** of the `architecture-diagram` skill. After the renderer produces a PNG, re-read that PNG with the `Read` tool and walk this checklist item by item. Each item is either a **pass** or a **fail** — do not rationalize borderline cases into passes.

The skill's retry budget (Step 7) allows **up to 2 critic-driven revisions**. Use them to fix the specific elements flagged here.

---

## 1. Binding integrity

- Every arrow's visual endpoint terminates exactly at its intended source and target shape.
- No arrow floats in empty space, overshoots its target, or stops short of it.
- Every arrow element has both `startBinding` and `endBinding` populated with the correct `elementId`.

**Fail signal:** an arrowhead visible in the middle of the canvas with no shape directly at its tip.

## 2. Label clarity

- Every text label fits inside its container — no clipping on right/bottom edge.
- No label overlaps the path of an arrow.
- Multi-word labels wrap cleanly; they do not get cut off mid-word.
- Container `width`/`height` is large enough for the `fontSize` actually used.

**Fail signal:** text visibly truncated with an ellipsis, or a label sitting on top of an arrow line.

## 3. Spatial composition

- No two component rectangles overlap.
- Whitespace is distributed evenly — no zone is crowded while another is empty.
- Components that belong to the same logical cluster are visually adjacent (or share a background frame).
- No arrow crosses a component rectangle it has no business crossing.

**Fail signal:** two boxes visibly intersecting, or three labels clustered in one corner while the rest of the canvas is blank.

## 4. Contrast on dark background

- Every stroke color is readable against `#020617` (slate-950).
- Every text `strokeColor` is `#e2e8f0` (slate-200) or lighter, **or** matches its container's stroke color from the palette.
- No element uses the Excalidraw default `#1e1e1e` — that color is effectively invisible on this background.

**Fail signal:** a component appears empty because its text is the same shade as the canvas.

## 5. Semantic palette consistency

- Every component of the same semantic role uses the **same** palette pair. Example: all Frontend components share `fill #083344` + `stroke #22d3ee`; all Database components share `fill #4c1d95` + `stroke #a78bfa`.
- Arrows between semantically identical pairs use the same stroke color.
- No "artistic" color mixing — the palette in `color-palette.md` is the single source of truth.

**Fail signal:** two databases in different colors, or a Frontend component rendered in emerald.

## 6. Flow direction

- Arrow head points in the direction of data/control flow described in the user's original request (or the plan from Step 1.5).
- No reversed arrows (common after copy-pasting templates).
- Bidirectional flows are represented either as two arrows or as one arrow with both `startArrowhead` and `endArrowhead` set — never as a single directed arrow that contradicts the semantics.

**Fail signal:** the user said "API Gateway calls Auth Service" but the arrow points from Auth to Gateway.

---

## Failure protocol

When an item fails:

1. **Identify** the specific element IDs responsible (e.g. `arrow-gw-to-auth`, `rect-db-2`).
2. **Revise only those elements** in the `.excalidraw` JSON. Do not rewrite the whole file — partial edits make diffs reviewable and reduce the risk of introducing new failures.
3. **Re-render** (Step 5) and **re-validate** (Step 6).
4. **Re-run this checklist** from item 1.

**Budget:** maximum **2** critic-driven revisions per diagram. If the 2nd revision still fails this checklist, `endTurn` with the remaining failure notes — do not spin.

---

## What this checklist is **not**

- It is not a correctness check for the *architecture itself* — that is the user's judgment, not the skill's.
- It is not a style guide — palette and spacing rules live in `color-palette.md` and `json-schema.md`.
- It is not a substitute for Step 6's mechanical validation — both run, in that order.

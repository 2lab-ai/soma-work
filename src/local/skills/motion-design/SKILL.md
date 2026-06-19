---
name: motion-design
description: Design-engineering advisor for UI animation and motion. Decides whether to animate at all, then which easing, duration, origin, and interruptibility make an interaction feel right instead of merely run. Supplies exact easing curves, duration budgets, spring configs, clip-path/gesture techniques, and performance/accessibility rules. Use when building or tuning transitions, drawers, toasts, popovers, drag gestures, or any motion; pairs with the review-motion skill for reviews. Triggers on "animation", "motion", "transition", "easing", "make it feel right", "애니메이션", "모션", "트랜지션", "이징", "동작 자연스럽게".
allowed-tools: Read, Grep, Glob, Edit, Write
version: 1.0.0
---

# Motion Design

You are a design engineer with craft sensibility for UI motion. In a world where
everyone's software is good enough, the way an interface *feels* is the
differentiator — and feel is built from invisible, aggregate correctness. Most
motion details users never consciously notice; that is the point. When a feature
moves exactly as someone assumes it should, they proceed without a second
thought.

This skill is a generalized distillation of Emil Kowalski's design-engineering
writing. The upstream's paid-course marketing and personal-brand framing are
intentionally **not** carried here — the skill stands on the engineering
principles. See [`LICENSES/NOTICE.md`](./LICENSES/NOTICE.md) for attribution.

## How to use this skill

1. Run the **Animation Decision Framework** below in order. Most of the value is
   in step 1 — many things should not animate at all.
2. For exact numbers (curves, durations, spring configs, a11y gates), read
   [`references/motion-standards.md`](./references/motion-standards.md). Quote the
   real values; never approximate.
3. For a specific interaction (clip-path reveal, drag dismissal, stagger, crossfade
   masking, building a loved component), read
   [`references/animation-techniques.md`](./references/animation-techniques.md).
4. To **review** existing motion code against this bar, use the sibling
   `review-motion` skill (it cites the same standards).

## The Animation Decision Framework

Answer these in order before writing any animation code.

### 1. Should this animate at all?

Match motion to how often the user sees it.

| Frequency | Decision |
| --- | --- |
| 100+ times/day (keyboard shortcuts, command-palette toggle) | **No animation. Ever.** |
| Tens of times/day (hover, list navigation) | Remove or drastically reduce |
| Occasional (modals, drawers, toasts) | Standard animation |
| Rare / first-time (onboarding, feedback, celebrations) | Can add delight |

**Never animate keyboard-initiated actions** — they repeat hundreds of times a
day; animation makes them feel slow and disconnected. If the only purpose is "it
looks cool" and the user sees it often, don't animate.

### 2. What is its purpose?

Every animation must answer "why does this animate?" Valid purposes: **spatial
consistency** (toast enters/exits from the same edge so swipe-to-dismiss feels
intuitive), **state indication** (a morphing button shows the change),
**explanation** (a marketing animation shows how a feature works), **feedback**
(a button scales down on press), **preventing a jarring change** (elements
appearing/disappearing without transition feel broken). No valid purpose → no
animation.

### 3. What easing?

- Entering or exiting → **`ease-out`** (starts fast, feels responsive)
- Moving / morphing on screen → **`ease-in-out`**
- Hover / color change → **`ease`**
- Constant motion (marquee, progress) → **`linear`**
- Default → **`ease-out`**

**Never `ease-in` on UI** — it delays the moment the user is watching most.
Built-in CSS easings are too weak; use strong custom cubic-beziers (exact values
in `references/motion-standards.md`).

### 4. How fast?

UI animations stay **under 300ms**. A 180ms dropdown feels more responsive than a
400ms one. Per-element budgets (button press 100–160ms, dropdowns 150–250ms,
modals/drawers 200–500ms) live in `references/motion-standards.md`. Perceived
speed matters as much as actual speed — `ease-out` at 200ms *feels* faster than
`ease-in` at 200ms.

## Non-negotiable craft rules

These hold regardless of framework. Exact code in the references.

- **Never `scale(0)`** — start from `scale(0.9–0.97)` + `opacity: 0`. Nothing in
  the real world appears from nothing.
- **Origin-aware popovers** — popovers/dropdowns/tooltips scale from their
  trigger (`transform-origin`), not center. Modals are exempt (keep centered).
- **Button press feedback** — `transform: scale(0.97)` on `:active`, ~160ms
  ease-out. Any pressable element.
- **Interruptibility** — rapidly-triggered or gesture-driven motion uses CSS
  transitions or springs that retarget from the current state, not keyframes that
  restart from zero.
- **GPU-only** — animate `transform` and `opacity` only. Layout properties
  (`width`/`height`/`margin`/`padding`/`top`/`left`) trigger layout + paint.
- **Asymmetric timing** — slow the deliberate phase (a press, a hold), snap the
  system's response.
- **Accessibility** — honor `prefers-reduced-motion` (gentler, not zero — keep
  opacity/color, drop movement); gate `:hover` motion behind
  `@media (hover: hover) and (pointer: fine)`.
- **Cohesion** — match motion to the component's personality and the rest of the
  product. When unsure whether motion feels right, deleting it is often the
  strongest move.

## When reviewing UI motion inline

If asked to review motion as part of building, output a single markdown table
with `| Before | After | Why |` columns — one row per issue — rather than a
"Before:/After:" list. For a full, opinionated review pass with a verdict, defer
to the `review-motion` skill.

| Before | After | Why |
| --- | --- | --- |
| `transition: all 300ms` | `transition: transform 200ms ease-out` | Name exact properties; `all` animates unintended props off-GPU |
| `transform: scale(0)` | `transform: scale(0.95); opacity: 0` | Nothing appears from nothing |
| `ease-in` on a dropdown | `ease-out` + custom curve | `ease-in` delays the moment the user watches most |
| `transform-origin: center` on a popover | trigger-anchored origin variable | Popovers scale from their trigger (modals exempt) |

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

See [`LICENSES/NOTICE.md`](./LICENSES/NOTICE.md) for source attribution.

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

- Entering / immediate feedback → **`ease-out`** (starts fast, feels responsive)
- Moving / morphing on screen → **`ease-in-out`**
- Exiting → usually **`ease-out`**; an accelerating **`ease-in`** is fine when
  the element is leaving and acceleration aids continuity
- Hover / color change → **`ease`**
- Constant motion (marquee, progress) → **`linear`**
- Default → **`ease-out`**

**Avoid `ease-in` on entrances and on user-triggered feedback** — it delays the
moment the user is watching most and feels sluggish. The browser's built-in
easings are weak; use strong custom cubic-beziers (exact values in
`references/motion-standards.md`).

### 4. How fast?

Default UI motion to **200–300ms or less**; a 180ms dropdown feels more
responsive than a 400ms one. Larger gesture-driven surfaces (modals, drawers) may
run **300–500ms** when the longer travel justifies it. Per-element budgets
(button press 100–160ms, dropdowns 150–250ms, modals/drawers 200–500ms) live in
`references/motion-standards.md`. Perceived speed matters as much as actual speed
— `ease-out` at 200ms *feels* faster than `ease-in` at 200ms.

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
- **Compositor-friendly properties** — prefer `transform` and `opacity` for
  routine motion; they skip layout and paint. Layout properties
  (`width`/`height`/`margin`/`padding`/`top`/`left`) trigger layout + paint.
  `clip-path` and `filter` are powerful (see techniques) but cost more — measure
  and use them with restraint.
- **Asymmetric timing** — slow the deliberate phase (a press, a hold), snap the
  system's response.
- **Accessibility** — honor `prefers-reduced-motion` (gentler, not zero — keep
  opacity/color, drop movement); gate `:hover` motion behind
  `@media (hover: hover) and (pointer: fine)`.
- **Cohesion** — match motion to the component's personality and the rest of the
  product. When unsure whether motion feels right, deleting it is often the
  strongest move.

## Reviewing existing motion

To audit motion code against this bar, use the sibling **`review-motion`** skill.
It applies the same standards as a dedicated review pass and produces a findings
table plus a Block/Approve verdict. Keep review output there rather than
duplicating it here.

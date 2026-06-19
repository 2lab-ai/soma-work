# Animation Techniques Reference

Concrete techniques that implement the principles in
[`motion-standards.md`](./motion-standards.md). Reach for these when building a
specific interaction. Framework names are labeled examples only.

## Transforms

- **`translate` percentages are relative to the element's own size.**
  `translateY(100%)` moves an element by its own height regardless of dimensions
  — the standard way to hide a toast/drawer off-screen before animating it in.
  Prefer percentages over hardcoded pixels; they adapt to content and are less
  error-prone.
  ```css
  .drawer-hidden { transform: translateY(100%); }  /* works at any drawer height */
  .toast-enter  { transform: translateY(-100%); }  /* works at any toast height  */
  ```
- **`scale()` scales children too** (font, icons, content). When scaling a button
  on press this is a feature, not a bug.
- **3D depth:** `rotateX()` / `rotateY()` with `transform-style: preserve-3d`
  create real 3D effects (orbit, coin-flip, depth) without JS.
- **`transform-origin`** is the anchor every transform executes from (default
  center). Set it to match where the trigger lives for origin-aware interactions.

## clip-path

`clip-path` is one of the most powerful animation tools in CSS, not just a
shape tool. `clip-path: inset(top right bottom left)` defines a rectangular
clipping region; each value "eats" into the element from that side.

```css
.hidden  { clip-path: inset(0 100% 0 0); }   /* fully hidden from the right */
.visible { clip-path: inset(0 0 0 0); }       /* fully visible */
```

Patterns:

- **Reveal on scroll** — start `inset(0 0 100% 0)` (hidden from bottom), animate
  to `inset(0 0 0 0)` when the element enters the viewport (IntersectionObserver
  / `useInView` with `{ once: true, margin: "-100px" }`).
- **Hold-to-delete** — colored overlay at `inset(0 100% 0 0)`; on `:active`
  transition to `inset(0 0 0 0)` over ~2s linear; snap back 200ms ease-out on
  release; add `scale(0.97)` on the button for press feedback.
- **Seamless tab color transition** — duplicate the tab list, style the copy as
  "active" (different bg/text color), clip the copy so only the active tab shows,
  animate the clip on tab change. Beats timing individual color transitions.
- **Comparison sliders** — overlay two images, clip the top one with
  `inset(0 50% 0 0)`, adjust the right inset from drag position. No extra DOM,
  fully hardware-accelerated.

## Gesture & drag

- **Momentum dismissal** — don't require crossing a distance threshold. Compute
  velocity (`Math.abs(distance) / elapsedMs`); dismiss if it exceeds ~0.11. A
  quick flick should be enough.
  ```js
  const velocity = Math.abs(swipeAmount) / timeTakenMs;
  if (Math.abs(swipeAmount) >= SWIPE_THRESHOLD || velocity > 0.11) dismiss();
  ```
- **Damping at boundaries** — dragging past a natural edge moves the element less
  the further you go (real things slow before stopping).
- **Pointer capture** — once dragging starts, capture pointer events so the drag
  continues even when the pointer leaves the element's bounds.
- **Multi-touch protection** — ignore extra touch points after the drag begins
  (`if (isDragging) return`) — prevents the element jumping to a new finger.
- **Friction over hard stops** — allow over-drag with rising resistance rather
  than an invisible wall; it feels more natural.

## Masking imperfect crossfades

When a crossfade shows two overlapping states despite tuning easing/duration, add
a subtle `filter: blur(2px)` during the transition to blend them into one
perceived transformation. Keep blur < 20px (heavy blur is expensive, especially
in Safari). Pairs well with `scale(0.97)` press feedback for a polished button
state change.

## Stagger

Stagger group entrances; 30–80ms between items. Longer delays feel slow. Stagger
is decorative — never block interaction while it plays.

```css
.item { opacity: 0; transform: translateY(8px); animation: fadeIn 300ms ease-out forwards; }
.item:nth-child(2) { animation-delay: 50ms; }
.item:nth-child(3) { animation-delay: 100ms; }
@keyframes fadeIn { to { opacity: 1; transform: translateY(0); } }
```

## Building components people love

Principles drawn from widely-loved components (e.g. Sonner, 13M+ weekly
downloads) that generalize to any component:

1. **Developer experience is the feature.** No hooks, no context, no complex
   setup. The less friction to adopt, the more it gets used.
2. **Good defaults beat options.** Ship beautiful out of the box; most users
   never customize. Default easing, timing, and visual design must be excellent.
3. **Naming creates identity.** A memorable name can be worth more than a
   descriptive one.
4. **Handle edge cases invisibly.** Pause toast timers when the tab is hidden;
   fill gaps between stacked items to keep hover state; capture pointer events
   during drag. Users never notice — exactly right.
5. **Use transitions, not keyframes, for dynamic UI.** Rapidly-added items
   (toasts) retarget smoothly with transitions; keyframes restart from zero.
6. **Let people touch it.** Interactive docs with ready-to-copy snippets lower
   the barrier to adoption.

## Debugging motion (recommend in reviews when feel is uncertain)

- **Slow motion** — bump duration 2–5× or use the DevTools animation inspector.
  Check colors crossfade cleanly (no two overlapping states), easing doesn't stop
  abruptly, `transform-origin` is right, and coordinated properties stay in sync.
- **Frame-by-frame** — the Chrome DevTools Animations panel reveals timing drift
  between coordinated properties invisible at full speed.
- **Real devices for gestures** (drawers, swipe) — connect a phone, hit the dev
  server by IP, use Safari remote devtools.
- **Fresh eyes next day** — imperfections invisible during development surface
  later. Review animations the next day.

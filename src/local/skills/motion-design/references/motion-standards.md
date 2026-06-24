# Motion Standards Reference

The precise values, curves, and rules behind UI motion craft. Cite these exact
numbers in reviews and code instead of approximating. This is the shared source
of truth for both the `motion-design` (knowledge) and `review-motion` (reviewer)
skills.

Distilled and generalized from Emil Kowalski's design-engineering writing; see
[`../LICENSES/NOTICE.md`](../LICENSES/NOTICE.md) for attribution. Framework names
(Radix, Base UI, Framer Motion, Sonner) appear only as labeled examples — the
principles are framework-agnostic.

## 1. Should it animate at all? (frequency gate)

Decide *whether* to animate before deciding *how*.

| Frequency | Decision |
| --- | --- |
| 100+ times/day (keyboard shortcuts, command-palette toggle) | **No animation. Ever.** |
| Tens of times/day (hover effects, list navigation) | Remove or drastically reduce |
| Occasional (modals, drawers, toasts) | Standard animation |
| Rare / first-time (onboarding, feedback, celebrations) | Can add delight |

**Never animate keyboard-initiated actions** — they repeat hundreds of times
daily; animation makes them feel slow and disconnected. (Example: Raycast has no
open/close animation — correct for something used hundreds of times a day.)

Valid purposes for motion: **spatial consistency, state indication, explanation,
feedback, preventing a jarring change.** "It looks cool" on a frequently-seen
element is not a valid purpose.

## 2. Easing

Decision order:

- Entering / immediate feedback → **`ease-out`** (starts fast, feels responsive)
- Moving / morphing on screen → **`ease-in-out`**
- Exiting → usually **`ease-out`**; an accelerating **`ease-in`** is acceptable
  when the element is leaving and acceleration aids continuity
- Hover / color change → **`ease`**
- Constant motion (marquee, progress) → **`linear`**
- Default → **`ease-out`**

**Avoid `ease-in` on entrances and on user-triggered feedback.** It starts slow,
delaying the exact moment the user is watching most; `ease-out` at 200ms *feels*
faster than `ease-in` at 200ms. (Exits are the one place an accelerating curve
can read as natural.)

Built-in CSS easings are too weak. Use strong custom curves:

```css
--ease-out: cubic-bezier(0.23, 1, 0.32, 1);        /* strong ease-out for UI */
--ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);    /* strong ease-in-out for on-screen movement */
--ease-drawer: cubic-bezier(0.32, 0.72, 0, 1);     /* iOS-like drawer curve (Ionic) */
```

Find curves at [easing.dev](https://easing.dev/) or [easings.co](https://easings.co/)
— don't hand-roll from scratch.

## 3. Duration

| Element | Duration |
| --- | --- |
| Button press feedback | 100–160ms |
| Tooltips, small popovers | 125–200ms |
| Dropdowns, selects | 150–250ms |
| Modals, drawers | 200–500ms |
| Marketing / explanatory | Can be longer |

**Rule: default UI motion to 200–300ms or less.** A 180ms dropdown feels more
responsive than a 400ms one. The **300–500ms** band is reserved for large,
gesture-driven overlays (modals, drawers) where the longer travel justifies it —
not for small controls, and never without a reason. Faster spinners make load
*feel* faster (same actual time). Instant tooltips after the first one (skip
delay + animation) make a toolbar feel faster.

## 4. Physicality

- **Never `scale(0)`.** Start from `scale(0.9–0.97)` + `opacity: 0`. Nothing in
  the real world appears from nothing.
- **Origin-aware popovers.** Scale from the trigger, not center:
  ```css
  .popover { transform-origin: var(--radix-popover-content-transform-origin); } /* Radix example */
  .popover { transform-origin: var(--transform-origin); }                       /* Base UI example */
  ```
  **Modals are exempt** — they appear centered in the viewport, so keep
  `transform-origin: center`.
- **Button press feedback.** `transform: scale(0.97)` on `:active`,
  `transition: transform 160ms ease-out`. Keep it subtle (0.95–0.98). Applies to
  any pressable element.

## 5. Springs

Springs feel natural because they simulate physics; they have no fixed duration
— they settle on parameters. Use them for: drag with momentum, "alive" elements
(e.g. Apple's Dynamic Island), interruptible gestures, decorative mouse-tracking.

```js
// Apple-style (easier to reason about) — recommended
{ type: "spring", duration: 0.5, bounce: 0.2 }

// Traditional physics (more control)
{ type: "spring", mass: 1, stiffness: 100, damping: 10 }
```

Keep bounce subtle (0.1–0.3); avoid bounce in most UI — reserve it for
drag-to-dismiss and playful interactions. Springs maintain velocity when
interrupted (keyframes restart from zero), so they're ideal for gestures the user
may reverse mid-motion. For mouse interactions, interpolate with a spring rather
than tying a value directly to pointer position (direct = artificial, no
momentum) — and only when the motion is decorative.

## 6. Interruptibility

CSS **transitions** can be interrupted and retargeted mid-animation;
**keyframes** restart from zero. For anything triggered rapidly (toasts being
added, toggles), transitions are smoother.

```css
/* Interruptible — good for dynamic UI */
.toast { transition: transform 400ms ease; }

/* Not interruptible — avoid for dynamic UI */
@keyframes slideIn { from { transform: translateY(100%); } to { transform: translateY(0); } }
```

Use `@starting-style` for entry without JS:

```css
.toast {
  opacity: 1; transform: translateY(0);
  transition: opacity 400ms ease, transform 400ms ease;
  @starting-style { opacity: 0; transform: translateY(100%); }
}
```

Legacy fallback: `useEffect(() => setMounted(true), [])` + a `data-mounted`
attribute.

## 7. Asymmetric timing

Slow where the user is deciding, fast where the system responds.

```css
.overlay { transition: clip-path 200ms ease-out; }            /* release: fast */
.button:active .overlay { transition: clip-path 2s linear; }  /* press: slow, deliberate */
```

## 8. Performance

- **Prefer `transform` and `opacity` for routine motion** — the compositor can
  animate them without layout or paint. `padding`/`margin`/`height`/`width`/
  `top`/`left` trigger all three rendering steps; avoid animating them.
  `clip-path` and `filter` (incl. `blur`) are not free — they can require paint or
  expensive compositor work, so measure before leaning on them in hot paths.
- **Don't drive child transforms via a CSS variable on the parent** — it recalcs
  styles for all children. Set `transform` directly on the element.
  ```js
  element.style.setProperty('--swipe-amount', `${d}px`); // bad: recalc on all children
  element.style.transform = `translateY(${d}px)`;        // good: only this element
  ```
- **Library shorthand props are scheduled on the main thread.** (Example: Framer
  Motion's `x`/`y`/`scale` resolve to `transform`, but they're driven via rAF on
  the main thread, so they drop frames while the page is busy. The transform
  itself is fine — the *scheduling* is the problem.) For predetermined motion,
  prefer a CSS transition / full transform string the compositor can own:
  ```jsx
  <motion.div animate={{ x: 100 }} />                          // rAF-scheduled; stutters under load
  <motion.div animate={{ transform: "translateX(100px)" }} />  // compositor can own it
  ```
- **CSS animations beat main-thread JS under load** — they run off the main
  thread; rAF-based animations stutter while the browser loads/scripts/paints.
  Use CSS for predetermined motion, JS/springs for dynamic/interruptible.
- **WAAPI** gives JS control through the browser's animation engine — no library,
  interruptible, and compositor-eligible properties (`transform`/`opacity`) can
  run off the main thread. Properties like `clip-path` are *not* compositor-only,
  so don't assume WAAPI makes them free:
  ```js
  element.animate([{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0 0)' }],
    { duration: 1000, fill: 'forwards', easing: 'cubic-bezier(0.77, 0, 0.175, 1)' });
  ```

## 9. Accessibility

```css
@media (prefers-reduced-motion: reduce) {
  .element { animation: fade 0.2s ease; } /* keep opacity/color, drop transform-based motion */
}
@media (hover: hover) and (pointer: fine) {
  .element:hover { transform: scale(1.05); } /* gate hover motion — touch fires false hovers on tap */
}
```

```jsx
const reduce = useReducedMotion();
const closedX = reduce ? 0 : '-100%';
```

Reduced motion means *fewer and gentler* animations, not zero — keep transitions
that aid comprehension, remove movement/position changes.

## 10. Cohesion

Match motion to the component's personality and to the rest of the product:
playful can be bouncier; a professional dashboard stays crisp and fast. Motion
feels right when easing, duration, and design are in harmony (example: Sonner is
slightly slower and uses `ease` rather than `ease-out` to feel elegant). The
opacity + height interplay for entering/exiting lists is trial and error — there
is no formula; adjust until it feels right. When unsure whether motion feels
right, the strongest move is often to **delete it**.

---
name: polishing-ui
description: "Use when a working UI looks slightly off and needs a measured detail pass before shipping — spacing, alignment, hit targets, text sizes, edges, hover, motion, accessible names — held to Apple's desktop and mobile numbers. Triggers: 'polishing-ui', 'ui-deslop', 'UI 폴리싱', 'UI 디테일 잡아줘', '수치로 다듬어'. Not for picking a visual direction (impeccable)."
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
version: 1.0.0
license: ISC
---

# polishing-ui — measure a working UI, fix what the numbers say, look again

In short: render the UI on a desktop and on a phone, measure it, and fix only what a number or a side-by-side look proves wrong. Haz's detail pass decides what to look at and in what order; Apple's published numbers decide what each value should be.

This is a finishing pass on UI that already works. It does not choose a style, restyle a page or add features — for a direction use `impeccable` or `ui-ux`, for worst-case data `break-ui`, for motion curves `motion-design` and `apple-design`, for phone quirks `mobile-native`.

## The pass at a glance

1. **Before** — render every state and theme on both presets, keep the screenshots, run the audit.
2. **Numbers** — fix what the audit marks red, decide each amber, against `reference/apple-metrics.md`.
3. **Detail** — Haz's ten steps, one component at a time: corners, gaps, surface, hover, open, motion, name, themes.
4. **Desktop and phone** — what must differ between the two and what must not.
5. **After** — the audit again, the same screenshots again, every value as `before → after`.

Read step 2 when you only have time for the measurable fixes; read step 3 for one component that "looks off"; read step 4 before changing anything that differs by screen size.

## 1. Before you start

- Render the real UI in a browser, not a mock. Every state it has (default, hover, focus, open, empty, busy) and every theme it supports (light, dark, increased contrast).
- Run the audit on both presets. It walks the page including open shadow roots and never edits anything:

```bash
export CLAUDE_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-<base directory>/../..}"
node "$CLAUDE_PLUGIN_ROOT/skills/polishing-ui/scripts/audit.mjs" <url> --preset both --out ./polish-before
#   --cookie name=value     sign in (repeatable)        --storage key=value   localStorage before load
#   --theme dark            prefers-color-scheme        --click <css>         open something first
#   --scope <css>           one component only          --engine webkit       Safari's engine for the phone
```

  Run it from a directory whose `node_modules` has `playwright` when the plugin install has none. Presets: desktop 1440×900 at 2x; phone 390×844 at 3x with touch.
- Keep `desktop.png`, `mobile.png` and `report.json` as the "before". Write every value you change as `before → after`.
- Work on one component at a time and look at it zoomed in. Measure in the units the code uses (px, rem, em); fractional values are fine. To land on whole pixels wrap the value: `padding: round(0.7em, 1px)`.

## 2. The numbers pass

The audit prints one table per preset. Red is a defect; amber is a decision you write down (fix, or why not).

| Check | Red when | Amber when | The number comes from |
|---|---|---|---|
| overflow-x | the page scrolls sideways | — | — |
| hit target | under 24×24 px and too close to another target | under 28 px on desktop, under 44 px on the phone | WCAG 2.5.8; HIG 28 pt macOS, 44 pt iOS |
| min text size | under 10 px on desktop, under 11 px on the phone | — | HIG smallest text style |
| input zoom | a phone field under 16 px | — | WebKit zooms into it on focus |
| hairline edge | a border thinner than 1 px | — | renders unevenly at 1x and fractional scale |
| row height | — | two or more controls on one line differ by more than 4 px | one bar, one control size |
| corner distance | — | an icon, badge or small control within 24 px of a corner sits unequally far from its two edges | Haz steps 1 and 3 |
| nested radius | — | an inner box near a corner is not concentric with it | HIG "concentric" |
| contrast | text under 4.5:1, or 3:1 for large text | — | WCAG 1.4.3; HIG |
| line length | — | a paragraph over 90 characters per line | 45–75 is the usual band |
| accessible name | a control with no name | a name over 80 characters, or with a time in it | Haz step 8 |
| type sizes in use | — | read it: many sizes a pixel apart means the scale drifted | your type scale |

The hit-target check counts a `::before`/`::after` that extends the box with negative insets — a 24 px chip with a 44 px invisible hit area passes on the phone. Colours are read through a canvas, so `oklch()` and `color()` work; an element over an image or gradient is skipped, not guessed. A page that does not load fails the run instead of auditing an empty page. Fix in this order: change a token, then a component rule, then one page rule. Never add a one-off override when the token is wrong.

## 3. The detail pass — Haz's ten steps

This is the order of fixes in Haz's video "Fixing a Claude-generated UI with obsessive attention to detail" (2026-11-15) and the rules he gave in its replies. Where the video shows a change but no rule or value, the step says so — do not fill that gap with your own number and call it the method.

1. **Corner element: equal distance to both edges.** Take the element in a container's top-left corner (an icon badge, an avatar). Measure from its rendered shape to the top edge and to the left edge and change the padding until the two match. Video: top 8, left 12 → 11.2 and 11.2. "It's not about the number, but about the values being the same on both axes." Keep it on any axis it shares with its siblings.
2. **Gap to the next element = the same distance.** The gap from that corner element to the content beside it equals the edge distance from step 1. Video: 6 → 11.2.
3. **Opposite corner control: equal distance to its two edges.** Measure the control's box, not only its glyph, to the top and the right edge, and make them equal. Video: 12 / 16 → 15.2 / 15.2 — a different value from step 1, unexplained; do not force both corners to one value unless your spacing system does.
   For a pill or row of text with an icon at the end, this keeps the space even around text and icon:

   ```css
   .item { --py: 0.875em; --px: calc(var(--py) + (1lh - 1cap) / 2); padding: var(--py) var(--px); }
   .item .icon { width: 1lh; height: 1lh; margin-right: calc(var(--py) - var(--px)); }
   ```

   `(1lh - 1cap) / 2` equals the space above the capitals only when the font's ascent minus its cap height equals its descent; elsewhere it is close.
4. **Whole component: type and surface.** Compare the whole component with its "before" at full size. Check every text size and row spacing against your own type scale and spacing tokens and replace values that drifted. The video also enlarges the text and turns the card from light grey to white — a choice for that card, not a rule. Edges: a 1 px outer shadow in light mode, a border in dark mode; never 0.5 px (lower the opacity to make an edge lighter); related lines share one width.
5. **Hover: nothing disappears into the hover background.** Step through hover slowly. Every element with its own backdrop on the hovered surface (a grey circle behind an icon) must change with the hover so it stays visible.
6. **Hover while open: no hard edge.** Open the component with the pointer on its header. If the header's hover fill stops in a hard line above the revealed body, fade it into the body. How strong the fade is is a judgment call.
7. **Motion: nothing opens or closes in 0 ms.** Animate both directions. Video: 0 → 300 ms on an eased S-curve (not named). Take the curve from `motion-design`; respect `prefers-reduced-motion`.
8. **Accessible name: what it is, nothing else.** Read the name in the accessibility tree, not the markup. Video: `"tobias commented 2 days ago"` → name `"tobias commented"`, description `"2 days ago"`. Secondary text goes to `aria-describedby`; when it sits inside the control, point `aria-labelledby` at the title too.
9. **Themes.** Switch to every theme the product has and look at every state again: dark, increased contrast (outlines instead of fills, brighter secondary text), any tint.
10. **Before and after.** Compare the final render with the "before" at the same size for every state and theme you touched.

## 4. Desktop and phone

The phone is not a smaller desktop. Apple's own numbers (`reference/apple-metrics.md`):

- **Targets grow.** A pointer needs 28 pt (macOS default control), a finger 44 pt (iOS) — 1.57 times. Grow the hit area on touch (`@media (pointer: coarse)`), not only under a width breakpoint: a tablet has a wide screen and a finger.
- **App text grows too.** iOS body is 17 pt where macOS body is 13 pt; most HIG text styles are about 1.3 times larger on the phone (the captions 1.1–1.2 times). A dashboard on a phone keeps or raises its text size. Do not shrink app text to fit a phone — wrap or drop a column instead.
- **Only display headlines shrink.** apple.com cuts its headlines 1.4–1.75 times on a phone (80 → 48, 64 → 40, 48 → 32) and keeps body text at 17 px at every width. That is a reading page's rule; it applies to a page title, not to UI text.
- **Fields are 16 px on touch.** Under 16 px iOS Safari zooms in on focus and stays zoomed.
- **Edges and safe areas.** Keep content inside `env(safe-area-inset-*)`. apple.com's phone margin is about 24 px a side (87.5% of the window); 16–24 px is the working range.
- **What does not change.** Contrast (4.5:1 text, 3:1 large text and controls), the 1 px edge, concentric corners, and the 12 pt clear space around a bezeled control (about 24 pt around one without a bezel) are the same on both.

One bar, one control height: controls side by side in a toolbar share a height and a corner shape on each preset — for example 28–32 px on desktop and 44 px on the phone. A 24 px chip beside a 40 px icon button in one row reads as two bars.

## 5. Done when

- The audit shows no red on either preset, and each remaining amber has a written reason.
- Every corner element in the components you touched is equally far from both edges, and its gap to the next element matches. Values recorded `before → after`.
- Controls on one line share a height on each preset; touch targets are 44 px on the phone; phone fields are 16 px.
- No edge is thinner than 1 px. Nested corners near an edge are concentric.
- Hover keeps every backdrop visible; open-while-hovered has no hard edge; open and close are animated both ways.
- Accessible names are the thing only; secondary text is in the description, checked in the accessibility tree.
- Every theme was rendered and looked at. Before and after screenshots exist for both presets and every state you changed.

## Sources

- The detail pass: Haz (@diegohaz), "Fixing a Claude-generated UI with obsessive attention to detail.", X, 2026-11-15, its replies, and his linked post "CSS 🤝🏽 Math — How to get even margins without ignoring line-height" (X, 2026-01-17). First written up at dosi.dev. See `LICENSES/NOTICE.md`.
- The numbers: Apple Human Interface Guidelines, apple.com's production stylesheets, WCAG 2.2 and WebKit, each cited in `reference/apple-metrics.md`.

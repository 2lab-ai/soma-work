---
name: lottie
description: "Use when the user asks to create, edit or fix a Lottie animation, asks for an animation in a page, or when the html skill needs a motion layer. Triggers: 'lottie', '애니메이션 만들어줘', 'animate this', 'add motion', '모션 넣어줘'."
allowed-tools: Read, Write, Edit, Bash, Glob, Grep
version: 0.1.0
license: ISC
---

# Lottie Authoring — Local Skill

Author **Lottie (Bodymovin) JSON** animations as code — no After Effects —
then either ship them standalone or embed them into HTML artifacts (the
`html` skill consumes this skill for its motion layer).

This skill is a vendored adaptation of
[`diffusionstudio/lottie`](https://github.com/diffusionstudio/lottie)'s
`text-to-lottie` skill (MIT). See [`LICENSES/NOTICE.md`](./LICENSES/NOTICE.md).
Upstream verifies with Skia/Skottie inside its own Vite player; this
adaptation verifies with **Playwright Chromium + lottie-web** (already
shipped in soma-work) so it works on the Slack request path with zero new
dependencies. The authoring rules below are kept strict to the **Skottie
subset** — JSON that satisfies Skottie renders correctly in lottie-web,
lottie-ios, lottie-android, and Flutter.

> This skill covers the *mechanics* — the JSON shape a strict renderer needs.
> For the *craft* (timing, easing, choreography), apply classic motion
> principles: ease in/out by default, 200–600 ms for UI accents, loop
> seamlessly. Convert milliseconds to frames with `frames = ms / 1000 * fr`.

## Two modes

| Mode | When | Deliverable |
|---|---|---|
| **Embed** (default) | The `html` skill or the user wants motion inside an HTML page. | Lottie JSON inlined as `animationData` in a self-contained HTML. |
| **Author** | The user wants a `.json` animation file itself (for their app, app intro, loader…). | A validated `lottie.json` (+ optional preview PNG). |

Either way: **author the JSON yourself with the rules below.** Do not
hotlink random LottieFiles URLs as the primary path — licenses are unclear,
links rot, and the output won't match the page's design system. Authored
shape-layer animations are deterministic, on-palette, and offline-safe.

## Required top-level shape

Every Lottie document is one JSON object with at least these fields:

```jsonc
{
  "v": "5.7.0",      // bodymovin version string
  "fr": 60,          // frame rate (fps)
  "ip": 0,           // in point (start frame)
  "op": 120,         // out point (end frame) — duration = (op - ip) / fr seconds
  "w": 512,          // composition width  (px)
  "h": 512,          // composition height (px)
  "assets": [],      // images / precomps; [] if none
  "layers": [ /* ... */ ]
}
```

Pick a square or sensible aspect ratio; the embedding container letterboxes.

## Layers

`layers` follows After Effects order: the **first** entry in the array is the
**topmost** layer, and later entries render underneath it. Each layer needs at
minimum:

```jsonc
{
  "ty": 4,           // layer type: 4 = shape layer (the common case)
  "nm": "circle",    // name (optional but helpful)
  "ip": 0,           // layer in point
  "op": 120,         // layer out point — must cover the frames you want it visible
  "st": 0,           // start time
  "ks": { /* transform — see below */ },
  "shapes": [ /* ... */ ]   // for shape layers
}
```

Common layer types: `4` shape, `2` image, `1` solid, `0` precomp, `5` text.
Prefer **shape layers (`ty: 4`)** for LLM-authored animations — no external
assets needed.

### The transform block (`ks`)

Every layer has a transform. Each property is either static
(`{ "a": 0, "k": value }`) or animated (`{ "a": 1, "k": [ ...keyframes ] }`).

```jsonc
"ks": {
  "o": { "a": 0, "k": 100 },                 // opacity 0–100
  "r": { "a": 0, "k": 0 },                   // rotation (degrees)
  "p": { "a": 0, "k": [256, 256, 0] },       // position [x, y, z]
  "a": { "a": 0, "k": [0, 0, 0] },           // anchor point [x, y, z]
  "s": { "a": 0, "k": [100, 100, 100] }      // scale (percent, per axis)
}
```

**Anchor matters:** rotation and scale pivot around the anchor `a`, expressed
in the layer's own coordinate space. To rotate a shape around its own center,
center the shape's geometry on the anchor.

## Shapes — the #1 strict-renderer gotcha

**Shape elements must be wrapped in a Group (`ty: "gr"`).** A flat list of
shapes + fills directly in `shapes` renders **blank** in Skottie and
inconsistently elsewhere. Always nest the geometry, fill/stroke, and a group
transform inside a group's `it` array:

```jsonc
"shapes": [
  {
    "ty": "gr",            // GROUP — required wrapper
    "nm": "ball",
    "it": [
      {
        "ty": "el",        // ellipse
        "p": { "a": 0, "k": [0, 0] },
        "s": { "a": 0, "k": [120, 120] }
      },
      {
        "ty": "fl",        // fill
        "c": { "a": 0, "k": [0.2, 0.6, 1, 1] },   // RGBA, each 0–1
        "o": { "a": 0, "k": 100 }
      },
      {
        "ty": "tr",        // GROUP TRANSFORM — include even if identity
        "p": { "a": 0, "k": [0, 0] },
        "a": { "a": 0, "k": [0, 0] },
        "s": { "a": 0, "k": [100, 100] },
        "r": { "a": 0, "k": 0 },
        "o": { "a": 0, "k": 100 }
      }
    ]
  }
]
```

Shape primitives inside `it`:
- `"el"` ellipse — `p` center, `s` [width, height]
- `"rc"` rectangle — `p` center, `s` [w, h], `r` corner radius
- `"sh"` custom path — `ks.k` is a bezier `{ "c": closed?, "v": verts, "i": inTangents, "o": outTangents }`
- `"st"` stroke — `c` color, `w` width, `o` opacity
- `"fl"` fill — `c` color (RGBA 0–1), `o` opacity
- `"tr"` the group's transform (always include it last)

**Colors are normalized 0–1 RGBA**, not 0–255. `[1, 0, 0, 1]` is opaque red.
Convert hex by dividing each channel by 255 (e.g. `#38bdf8` →
`[0.220, 0.741, 0.973, 1]`).

### Useful stroke modifiers

- `"tm"` trim paths — animate `s`/`e` (0–100) to draw a line/path in. The
  classic "checkmark draws itself" is a `sh` path + `st` stroke + animated `tm`.
- `"rd"` round corners, `"gf"`/`"gs"` gradient fill/stroke (use sparingly —
  the design skill's anti-slop rules apply to motion too).

## Animating a property (keyframes)

Set `"a": 1` and make `k` an array of keyframe objects. Each keyframe has a
time `t` (frame), a value `s` (start value for that segment, as an array), and
easing handles `i`/`o`:

```jsonc
"p": {
  "a": 1,
  "k": [
    { "t": 0,   "s": [256, 120], "i": { "x": [0.5], "y": [1] }, "o": { "x": [0.5], "y": [0] } },
    { "t": 60,  "s": [256, 400], "i": { "x": [0.5], "y": [1] }, "o": { "x": [0.5], "y": [0] } },
    { "t": 120, "s": [256, 120] }
  ]
}
```

- `t` is the frame number; the last keyframe usually has only `s` (it's the end).
- `s` is **always an array**, even for scalars like rotation: `"s": [360]`.
- `i`/`o` are bezier ease handles (incoming / outgoing), `x`/`y` arrays in
  `[0..1]`. Smooth ease: `i: {x:[0.5], y:[1]}`, `o: {x:[0.5], y:[0]}`.
  Linear: `i: {x:[1], y:[1]}`, `o: {x:[0], y:[0]}`.
- To **loop seamlessly**, make the last keyframe's value equal the first.

## Slots (editable properties) — author mode only

Upstream's player exposes a live properties panel via Lottie **slots**: a
top-level `"slots"` object plus `"sid"` references inside properties, with an
optional `controls.json` sidecar for labels/ranges. Keep slots when the
deliverable is a `.json` for the upstream player (see Deep mode); **resolve
slots to final inline values for embed mode** — pinned lottie-web 5.13.0
plays `sid`-referenced properties only partially, and a self-contained HTML
should not depend on player-side panels anyway.

## Validate before shipping

```bash
node "$CLAUDE_PLUGIN_ROOT/skills/lottie/validator/validate.mjs" \
  --input ./my-animation.json \
  [--screenshot ./preview.png] [--frame 30]
```

The validator loads the JSON into headless Chromium with pinned
`lottie-web@5.13.0`, and prints a JSON verdict:

- `ok: true` + `frames`, `duration`, `size`, `svgNodes` — safe to ship.
- `svgNodes` near zero → the blank-render gotcha: re-check that every shape
  sits inside a `"ty": "gr"` group ending with a `"tr"` transform.
- `ok: false` + `error` → the JSON failed to parse or load.
- `--screenshot` + `--frame N` renders the animation held at frame `N` —
  use it to verify a key pose ("is the ball at the bottom at frame 60?").

Checklist (same spirit as upstream's):

1. Valid JSON — no comments, no trailing commas.
2. Every primitive/fill is inside a `"ty": "gr"` group ending with `"tr"`.
3. Top-level `op` and each layer's `op` cover the animated frames.
4. Colors 0–1 RGBA; positions/sizes within the `w`×`h` composition.
5. Keyframe `s` values are arrays; loops repeat the first value at the end.
6. `validate.mjs` says `ok: true` with a plausible `svgNodes` count.

## Embedding in HTML (what the `html` skill calls)

Use pinned **lottie-web 5.13.0** from jsdelivr (UMD, global `lottie`) and
**inline the JSON** as `animationData` — never `path:` + a separate file; the
HTML artifact must stay single-file and work offline once loaded:

```html
<div id="anim-hero" aria-hidden="true" style="width:160px;height:160px"></div>
<script src="https://cdn.jsdelivr.net/npm/lottie-web@5.13.0/build/player/lottie.min.js"></script>
<script>
  const heroData = {/* …authored Lottie JSON, inlined… */};
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const anim = lottie.loadAnimation({
    container: document.getElementById("anim-hero"),
    renderer: "svg",            // crisp at any scale; "canvas" for many shapes
    loop: true,
    autoplay: !reduced,
    animationData: heroData
  });
  if (reduced) anim.goToAndStop(anim.totalFrames - 1, true);
</script>
```

Rules of taste (the `design` skill's anti-slop discipline extends to motion):

- **≤ 3 animations per page**, each with a job: hero accent, state/progress
  cue, or a single ambient texture. Decorative confetti everywhere is slop.
- **Palette-locked** — fills/strokes use the page's design-direction colors,
  converted to 0–1 RGBA. No rainbow gradients.
- **Subtle by default** — 2–6 s loops, eased, small displacement. Motion
  should read as crafted, not as a stock sticker.
- **`prefers-reduced-motion`** — always honor it (pattern above).
- **`aria-hidden="true"`** on decorative animation containers.

## Sourcing external animations (fallback only)

If the user explicitly asks for a specific famous animation and authoring is
impractical, these CDN URLs were verified hotlinkable (CORS `*`); inline the
fetched JSON rather than referencing the URL at runtime, and note the
LottieFiles asset license to the user:

```
https://assets1.lottiefiles.com/packages/lf20_V9t630.json
https://assets2.lottiefiles.com/packages/lf20_usmfx6bp.json
https://raw.githubusercontent.com/airbnb/lottie-web/master/demo/bodymovin/data.json
```

`assets7/8/9.lottiefiles.com` returned 403 at vendoring time; `lottie.host`
UUID URLs are not stable. Authored animations remain the primary path.

## Deep mode — the upstream interactive player

When the deliverable is a standalone animation the user will iterate on
(scrub, tweak sliders, inspect frames), scaffold the **official upstream
player** instead of hand-rolling a viewer — its slots panel, `?frame=N&paused=1`
URL controls, and Skottie parser only hold inside that exact project:

```bash
npx degit diffusionstudio/lottie my-animation
cd my-animation
npm install   # postinstall copies the CanvasKit wasm into /public
npm run dev   # then write the animation to public/lottie.json
```

- The app fetches `/lottie.json` at startup and hot-reloads on save.
- Pin a frame for inspection via `http://localhost:5173/?frame=60&paused=1`;
  the canvas carries `data-testid="lottie-canvas"`.
- Parse failures render on-screen ("CanvasKit could not parse the Lottie
  file."); a blank canvas with no error → re-check group wrapping.
- Upstream requires a background-color slot on every animation it hosts
  (full-composition `rc` as the last layer, `"sid": "bgColor"`, labeled in
  `public/controls.json`).

This mode is heavyweight (npm install on the request path) — only use it when
the user is iterating on the animation itself, not for embed mode.

## Anti-patterns

- Do **not** leave shape primitives outside a `"ty": "gr"` group — blank render.
- Do **not** use 0–255 colors — everything washes to white.
- Do **not** reference `path:` JSON files from embed-mode HTML — single-file rule.
- Do **not** hotlink animation URLs at runtime — inline the data.
- Do **not** ship without running `validate.mjs`.
- Do **not** stack loops of different periods that visibly beat against each
  other on one page.

## References

- [`validator/validate.mjs`](./validator/validate.mjs) — Playwright + lottie-web
  parse/render verdict CLI.
- [`../html/SKILL.md`](../html/SKILL.md) — the `html` skill; its motion-layer
  step consumes this skill.
- [`../design/SKILL.md`](../design/SKILL.md) — visual direction + anti-slop
  rules that govern motion taste.
- [`LICENSES/NOTICE.md`](./LICENSES/NOTICE.md) — MIT attribution for
  diffusionstudio/lottie.
- Upstream: <https://github.com/diffusionstudio/lottie> — the text-to-lottie
  harness this skill adapts.

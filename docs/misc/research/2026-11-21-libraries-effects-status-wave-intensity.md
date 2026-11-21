# Status-change waves on `<ui-agent-inbox>`: how loud, for whom, and when

**In one line:** every wave is a `center` ring that leaves the card's status icon in the status colour. Fable cards add the
lens, the gather beat, particles and a lingering edge, and run about 2.1–2.5 s. Every other model gets colour only (no
lens, no particles, no gather) and runs about 1.1–1.4 s. How loud a wave is also depends on the transition: →waiting is
loudest, then →failed, →done, →running, and →idle gets no wave at all for non-Fable cards. Caps on frequency, concurrency
and visibility matter more than any single knob.

## 1. The matrix

Every cell uses the same family: `type: 'center'`, `scale: 1` (so every length below is in CSS px), `focus: null`, the
default easing (0.22, 1, 0.36, 1), the palette set to **one hex**, which is the card's own resolved `--st-*` tone, and
the source set to the status icon (`.ib-tag-icon`, 12 px, bottom-left in the foot; `.ib-min-dot` when the card is
folded). The duration column comes from `duration()` in model.ts (checked by running the model).

| to → | **Fable (loud)** | ms | **any other model (quiet)** | ms |
|---|---|---|---|---|
| **waiting** (NEEDS YOU) | LOUD, amber. Lens and 36 particles. The edge holds longest (`linger 0.7`), so the card lands in NEEDS YOU still lit and hands over to the attention rail. | 2400 | QUIET, amber, `strength 0.34`, `rimStrength 0.4` | 1400 |
| **failed** | LOUD, red, but serious rather than festive: `aberration 0`, `particleCount 0`, `gatherDots 0`, `anticipation 0.2`, `amplitude 10` | 2100 | QUIET, red, `strength 0.34`, `rimStrength 0.4` | 1400 |
| **done** | LOUD, green, the celebration: `aberration 0.55`, 48 particles with `particleLife 2.2`, edge `linger 0.6` and `rimFade 1.4` | 2500 | QUIET-LOW, green (`strength 0.22`, `rimStrength 0.25`) | 1100 |
| **running** | LOUD-LITE, blue. Colour only, no gather, 16 particles, `strength 0.45`, `rimStrength 0.5` (this is the most frequent transition) | 1200 | QUIET-LOW, blue, `strength 0.18`, `rimStrength 0.2` | 1100 |
| **idle** (sleeping) | QUIET-LOW in the rest tone (`--ib-muted`), `strength 0.2` | 1100 | **no wave** | – |

Loud is captured (`capture: true`), except LOUD-LITE and the idle cell. Quiet is always `capture: false`.

**Keeping the family recognisable.** Loud and quiet share the ring shape, the source (the icon that changed), the colour,
the easing, and the same three beats: the front crosses, colour stays on the edges, then the edges clear outward from the
icon. Only the weight changes: lens on or off, particles, the gather beat, and strength, rim and duration. It works like
two weights of one typeface, the same idea as Carbon's productive and expressive modes of one motion system [C].

**Modifiers** (apply in this order):
- **Folded card** (40 px strip). Use `capture: false`, `rimWidth ≤ 2.5`, `rimUnevenness ≤ 0.3`, `particleCount 0`,
  `particleLife 0`, `strength ×0.8`, `lead 28`, `tail 64`, and take the source from `.ib-min-dot`. The reason is in the
  renderer: the edge band reaches `rimWidth·2.2·(1+1.9·uneven)` inward, and the rim's lumps can make it about 3× thicker
  still. With the default rim it would flood a 20 px half-height. Rendered and checked: the strip keeps a clean lit edge.
- **Theme.** Dark: `strength ×0.85`, `hairlineWhite 0.9`. Light: `strength ×1.15` (capped at 0.7), `hairlineWhite 0.15`.
  The front's core is mixed 70 % toward white, and the hairline is white. Both glow on `#242428` but disappear on `#fff`,
  so in light themes the colour has to carry the edge.
- **Mono** (`--chroma: 0`). Keep the hex, because tokens.ts allows status colour on "an icon, a dot, a bar or a border",
  and the rim is border-like. Apply `strength ×0.5`, because the front band is a fill, and mono scales fills away.
- **Optional, for the owner to decide.** If the viewer caused the change themselves (pressed the card's action under 5 s
  ago), play QUIET whatever the tier: it is feedback for something they are already looking at. If `attention === true`
  (the card waits on the viewer), play quiet →waiting at `strength 0.4` / `rimStrength 0.5`.

## 2. Timeline against the board (a 300×200 card, from model.ts)

The board keeps the new status in place for 900 ms. The icon pops (scale 0.6→1, 320 ms), and then the card glides with
FLIP (320 ms, ending at about 1220 ms). The waves are timed into those windows:

| | gather | front reaches the far corner | front colour gone | edge colour and hairline cleared |
|---|---|---|---|---|
| Loud →waiting | 0–300 ms: a ring inhales onto the icon **during the icon's pop** | 540 ms | ~1030 ms (glow is 0.28 at 900 ms) | 2400 ms, about 1.2 s after landing in NEEDS YOU |
| Quiet →waiting | none (leaves at once, like the library's Document-card wave) | 210 ms | 620 ms | 1400 ms, just after landing |

So the front does its work during the hold, before the glide starts. The coloured edge rides along with the glide,
because the canvas is a child of the card and FLIP's transform carries it. The edge then fades **in the new column**.
That fading edge is the useful part: it marks where the card went, and so counters change blindness after a move [V].
The front colour lasts `anticipation + 0.55·travel`, because `glow` settles between x = 0.2 and x = 0.55 of `travel` in
waveFront.

## 3. Why: principles and how they map

1. **Frequency sets the budget.** Emil Kowalski: "How often users will see an animation is a key factor in deciding
   whether to animate or not" [E]. Apple: "In apps, generally avoid adding motion to UI interactions that occur
   frequently", and "Aim for brevity and precision in feedback animations" [A]. Carbon: "Reserve expressive motion for
   occasional, important moments", and system alerts are "great cases for expressive motion"; productive motion stays
   "subtle and out of the way" [C]. Material 3 likewise has an expressive scheme for "hero moments and key interactions"
   and a standard one, and allows a swap per element for emphasis [M].
   → In this board, →running and →waiting each happen many times an hour. Only Fable cards get expressive motion, and the
   most frequent transition (→running) is light even for Fable.
2. **Motion in peripheral vision is close to always seen, so "subtle" still costs attention.** Bartram, Ware & Calvert
   found close to 100 % detection of motion in both the near and far periphery, while colour and shape cues fell off.
   They also found that motion type and speed drive distraction and irritation ("G7: Motion can contribute strongly to
   distraction and irritation") [B].
   → Even the quiet wave will be noticed. That is the request ("noticeable in peripheral vision"), but it is also why
   quiet must be *short* (≤ 1.4 s), and why caps and the "no wave for idle" rule count for more than amplitude does.
3. **Calm technology: let things move from the periphery to the centre only when it matters** [W]. Weiser & Brown's
   Dangling String is the model here: it whirls when the network is busy and only twitches when it is quiet. It is also
   *located* (their third sign), which here means the motion starts at the icon that changed. McCrickard & Chewar's
   interruption / reaction / comprehension framework [N] puts the transitions in a clear order:
   - →waiting needs a person to act: high reaction, moderate interruption.
   - →failed: high reaction, less urgent.
   - →done: comprehension (good news), little reaction needed.
   - →running: awareness only.
   - →idle: nothing to do.
4. **Habituation: a loud signal seen too often stops working.** fMRI and eye-tracking studies of repeated warnings show
   the response dropping off with repetition. Warnings whose appearance varies (polymorphic warnings) held up
   substantially better [H].
   → Keep loud rare: Fable only, at most once per card per minute, never in bursts. The loud presets also differ per
   transition (failed has no sparkle, done has the most particles), so loud never becomes one repeated signal.
5. **Never rely on motion alone.** Apple: "avoid using it as the only way to communicate important information" [A].
   Here the tag's word, the column, the count and the live announcement already carry the state. The wave is a
   decorative `aria-hidden` cue on top of them, and that is what makes it safe to drop under any cap.
6. **WCAG 2.2.2.** Motion that starts on its own and lasts more than 5 s alongside other content needs a pause, stop or
   hide control [P]. Each wave is ≤ 2.5 s (the library's own defaults run 3.6–7 s, too long). Board caps keep the total
   motion short. Also give the dashboard a setting: waves `all | loud only | off`.

**Colours** (from ui/src/core/tokens.json; the cards set `--st-color` by `data-status`):

| tone | light | dark | used for |
|---|---|---|---|
| `--st-wait` | `#c2780a` | `#f5a524` | →waiting (amber; mono themes keep it amber too) |
| `--st-fail` | `#d43a3a` | `#f26b6b` | →failed |
| `--st-done` | `#137a3e` | `#3fb968` | →done |
| `--st-run` | `#2f63e0` | `#6b93f2` | →running |
| `--ib-muted` | `#65656b` | `#93939b` | →idle (Fable only). `mono` is white and grey, which is invisible on a light card. |

Pass the hex as `palette`. `singlePalette()` makes the lighter fringe ahead (+45 % white) and the deeper one behind
(−30 % black). Read the tone with `getComputedStyle(card)` so that theme, mono and `data-design` all follow
automatically. Don't use the `colorful` palette: on a status board a rainbow says nothing about the state.

## 4. Knob facts from the source that drive these numbers

- **`capture: false` switches off the whole lens group.** The renderer multiplies `energy` and `gravity` by `gain`, and
  `gain` is 0 without a picture. So `amplitude`, `lensWidth`, `aberration`, `blur*` and `pull` do nothing in the quiet
  waves. Only the front's colour (`lead`, `tail`, `strength`), the rim, the hairline and the particles draw.
- **`particleLife` still counts in `duration()` when `particleCount` is 0.** With center defaults, a quiet wave would
  last 3.93 s. Quiet sets `particleLife: 0`.
- **`scale: 'auto'` is `clamp(√(w·h / (393·852)), 0.6, 2.2)`.** That comes out at 0.6 for every card up to about
  350×345 px, so default point values shrink to 60 %. `scale: 1` makes the table literal CSS px. It also keeps
  `hairlineWidth` and `particleSize` as given, because they are divided by √k.
- **Center-type defaults** are `aberration 0`, `gatherGlow 0`, `gatherDots 0` and the green palette. LOUD turns gather
  and aberration on deliberately.
- **The ring keeps its source sharp** (`heldAt`, from 0.9 to 1.8 times the source radius). The board's own icon pop stays
  live and unbent under the canvas.
- **Particles are always white** (`DOT_FRAG`). On a light card they only show over the coloured front, so in light themes
  the loud wave has to read through its rim and lens, not its dots.
- **The library's own "quiet" precedent** is the Document card on libraries.dev: center, `anticipation 0`, no pull or
  gather, `strength 0.3`, `rimStrength 0.3`, mono, starting from a corner. QUIET follows the same idea, shortened from
  4.9 s to 1.1–1.4 s.

## 5. Guard rails

| concern | rule |
|---|---|
| WebGL contexts | Each `WaveController` holds **one WebGL2 context**. It is made on the first play, or at idle by `prewarm`, or on `pointerenter` when capture is on. It is freed only after **30 s of rest** or by `destroy()`, which calls `WEBGL_lose_context`. Chrome caps a page at about 16 live contexts and Firefox at 16 per principal, and past the cap the *oldest* is lost silently, which may belong to another effect on the dashboard [G]. So: **create a controller per wave, not per card**; pass `prewarm: false`; call `destroy()` in `onFinish`; and allow **≤ 4 live** on the board. |
| per card | One wave in flight. A new change during a run: `update({ palette })` restyles the running wave (the model restyles mid-flight) rather than restarting it. Loud **at most once per card per 60 s**; a repeat inside that window plays the QUIET cell of the same transition (habituation [H]). |
| per board | ≤ 4 waves in flight, of which ≤ 2 loud. Start ≤ 1 wave per 150 ms (stagger). When over the cap, priority is: waiting > failed > done > running > idle, then Fable > others, then visible > not. Quiet waves over the cap are **dropped**: the icon pop and the glide still tell the change. Loud waves wait in a queue for up to 1.5 s and are then dropped. |
| first paint / reconnect | First paint: never (the board's `#painted` gate already covers it). **Burst** means more than 3 status changes in one data update (a reconnect or a snapshot): then no loud waves, and only →waiting / →failed get QUIET, at most 3, staggered 150 ms. A burst is a sync, not news. |
| off-screen | Start a wave only if ≥ 50 % of the card is inside the board's scroll viewport (an IntersectionObserver at 0.5). Never queue a wave for later. |
| hidden tab | `document.hidden` means no waves (the board also moves every card at once then). Don't replay missed changes on return. Optional: one QUIET →waiting wave on up to 3 cards that entered NEEDS YOU while the tab was hidden. |
| reduced motion | The library would crossfade, but with one view (no `revealedContent`) that crossfade is a **no-op**, so nothing shows. Give it a still cue instead, only for →waiting, →failed and Fable: the card border takes the status tone for 1.2 s and fades back over 300 ms (a colour change, no movement). The attention mark already stays under reduced motion. |
| attention ping | The 10 s ping ring on `.is-attention` cards should not fire under a wave. Add `is-waving` and hide `::after` the same way `.is-flying` does. |
| capture cost | Capture walks every node's computed style, writes XHTML into an SVG `foreignObject`, decodes it and uploads it. The **first** capture also embeds web fonts as data URLs, and Korean fonts can be MBs. Only loud captures. Call `prepare()` right after the face is patched; the 300 ms gather covers it, and a late picture eases in over 150 ms (`LENS_IN`). Set **`live: false`**: otherwise the tag's 1 Hz clock marks the picture stale and the run captures again every ≥ 90 ms. Measure `wave.debug.content.walk/raster` on the real dashboard. If it is > 120 ms, run loud with `capture: false`; it still reads as loud through the gather, rim and particles. |
| draw cost | One full-quad shader per wave over the card. The lens path takes 5 samples × 3 blur levels where aberration splits. Set `resolution: 1` for quiet (soft colour, 4× fewer pixels on a 2× display) and `≤ 2` for loud. |
| DOM | Root is the card `li`: it is already `position: relative`, it keeps its node for life, and FLIP's transform carries the canvas. Content is `.ib-face`. Check that the board never clears unknown children of the `li`, because the controller appends its canvas there (`data-dw-skip`, `aria-hidden`). |
| reading | The lens blurs text inside a band about 60–100 px wide for about 0.3 s. The renders showed that `blur 6`/`86` was wider than needed; the table uses `blur 4`, `blurAhead 24`, `blurBehind 60`. |

## 6. Paste-ready presets

```ts
import type { WaveStyleInput } from 'distortion-waves'; // or the ported engine's type

export type WaveTier = 'loud' | 'quiet';
export type WaveTo = 'waiting' | 'failed' | 'done' | 'running' | 'idle';
export interface StatusWave { capture: boolean; style: WaveStyleInput; ms: number }

/** Fable (claude-fable-5, -5-1, -5-2[1m] …) is loud; every other model is quiet. */
export const waveTier = (model?: string): WaveTier => (/fable/i.test(model ?? '') ? 'loud' : 'quiet');

/** Shared by every cell: the family. Lengths in CSS px (pass `scale: 1`). */
const FAMILY: WaveStyleInput = { launchGap: 0, orientation: 0, swell: 6, lead: 44, tail: 100, rimSoftness: 110, hairlineWidth: 1 };

const LOUD: WaveStyleInput = {
  ...FAMILY, anticipation: 0.3, travel: 1.4, pull: 6, inhale: 14, gatherGlow: 0.35, gatherDots: 1,
  amplitude: 12, lensWidth: 54, aberration: 0.45, blur: 4, blurAhead: 24, blurBehind: 60,
  strength: 0.6, rimWidth: 7, rimUnevenness: 1, rimStrength: 0.8, rimPulse: 0.6,
  hairlineOpacity: 0.8, hairlineLinger: 0.3, hairlineFade: 1.1, linger: 0.5, rimFade: 1.3,
  particleCount: 36, particleSize: 1.6, particleReach: 54, particleFlight: 11, particleGap: 7, particleLife: 1.8, particleSpread: 0.64,
};
const QUIET: WaveStyleInput = {
  ...FAMILY, anticipation: 0, travel: 1.2, pull: 0, inhale: 0, gatherGlow: 0, gatherDots: 0,
  amplitude: 0, aberration: 0, blur: 0, strength: 0.3, rimWidth: 4, rimUnevenness: 0.6, rimStrength: 0.35, rimPulse: 0.3,
  hairlineOpacity: 0.5, hairlineLinger: 0.2, hairlineFade: 1.0, linger: 0.2, rimFade: 1.2,
  particleCount: 0, particleLife: 0, // particleLife counts in duration() even with no particles
};
const QUIET_LOW: WaveStyleInput = { ...QUIET, strength: 0.22, rimStrength: 0.25, hairlineOpacity: 0.35, linger: 0.1, rimFade: 1.0, hairlineLinger: 0.1, hairlineFade: 0.9 };

export const STATUS_WAVES: Record<WaveTier, Record<WaveTo, StatusWave | null>> = {
  loud: {
    waiting: { capture: true, ms: 2400, style: { ...LOUD, linger: 0.7 } },
    failed: { capture: true, ms: 2100, style: { ...LOUD, anticipation: 0.2, amplitude: 10, aberration: 0, gatherDots: 0, particleCount: 0, particleLife: 0 } },
    done: { capture: true, ms: 2500, style: { ...LOUD, aberration: 0.55, linger: 0.6, rimFade: 1.4, hairlineFade: 1.2, particleCount: 48, particleLife: 2.2 } },
    running: { capture: false, ms: 1200, style: { ...LOUD, anticipation: 0, travel: 1.2, pull: 0, inhale: 0, gatherGlow: 0, gatherDots: 0,
      strength: 0.45, rimWidth: 5, rimStrength: 0.5, hairlineOpacity: 0.6, linger: 0.2, rimFade: 1.0, hairlineLinger: 0.1, hairlineFade: 0.9,
      particleCount: 16, particleLife: 1.1 } },
    idle: { capture: false, ms: 1100, style: { ...QUIET_LOW, strength: 0.2 } }, // tone: --ib-muted
  },
  quiet: {
    waiting: { capture: false, ms: 1400, style: { ...QUIET, strength: 0.34, rimStrength: 0.4 } },
    failed: { capture: false, ms: 1400, style: { ...QUIET, strength: 0.34, rimStrength: 0.4 } },
    done: { capture: false, ms: 1100, style: QUIET_LOW },
    running: { capture: false, ms: 1100, style: { ...QUIET_LOW, strength: 0.18, rimStrength: 0.2, hairlineOpacity: 0.3 } },
    idle: null,
  },
};

/** Theme, mono and fold, applied last. */
export function adjustWave(w: StatusWave, o: { dark: boolean; chroma: number; folded: boolean }): StatusWave {
  const s = { ...w.style };
  s.strength = Math.min((s.strength ?? 0.3) * (o.dark ? 0.85 : 1.15), 0.7) * (o.chroma > 0 ? 1 : 0.5);
  s.hairlineWhite = o.dark ? 0.9 : 0.15;
  if (!o.folded) return { ...w, style: s };
  return { capture: false, ms: w.ms, style: { ...s, rimWidth: Math.min(s.rimWidth ?? 4, 2.5), rimUnevenness: Math.min(s.rimUnevenness ?? 0.6, 0.3),
    particleCount: 0, particleLife: 0, strength: (s.strength ?? 0.3) * 0.8, lead: 28, tail: 64 } };
}
// Play: new WaveController(li, face, null).update({ type: 'center', scale: 1, source: icon, focus: null, palette: toneHex,
//   waveStyle: w.style, capture: w.capture, live: false, prewarm: false, resolution: w.capture ? Math.min(devicePixelRatio, 2) : 1,
//   onFinish: () => controller.destroy() }); then controller.play({ source: icon }).
// (ms values are duration() of each style. Recompute them if you change a time knob; duration() is exported.)
```

## 7. What was checked, and what was not

- **Numbers.** The durations and the timeline come from running the real `model.ts` (`duration`, `waveFront`), compiled
  with the project's esbuild, against a 300×200 card with the source at the bottom-left icon.
  Scripts: `(scratch scripts, not kept) final.mjs` and
  `sim.mjs`.
- **Renders.** The real `WaveController` (bundled from source) was rendered in Chromium with SwiftShader WebGL2, held
  with `scrub` at 0.42, 0.75 and 1.3 s, light and dark:
  `(receipt) light.png` and `dark.png`
  (the matrix rows), plus `light-2.png` and `dark-2.png` (the softer blur and the folded strip). What they show:
  - Loud reads as an event: a bent and blurred band, then thick lumpy amber or green edges that are still strong at 1.3 s.
  - Quiet →waiting is a clear but thin amber edge, nearly gone by 1.3 s.
  - Quiet →running is barely there, which is right for the most frequent transition.
  - Dark themes make every wave louder; this is why the theme factors exist.
- **Not measured.**
  - Capture time with the dashboard's real fonts and card markup inside the shadow root.
  - Feel in motion. The renders are stills, so tune `travel` for feel live.
  - The exact WebGL context cap on Safari.
  - Whether the board ever clears unknown children of the `li`.

## Sources

- [E] Emil Kowalski, "You don't need animations": https://emilkowal.ski/ui/you-dont-need-animations
- [A] Apple HIG, Motion: https://developer.apple.com/design/human-interface-guidelines/motion
- [C] IBM Carbon, Motion (productive vs expressive; duration tokens): https://carbondesignsystem.com/elements/motion/overview/
- [M] Material 3 motion: https://m3.material.io/styles/motion/overview/how-it-works · expressive motion schemes: https://m3.material.io/blog/m3-expressive-motion-theming
- [W] Weiser & Brown, "Designing Calm Technology" (1995): https://people.csail.mit.edu/rudolph/Teaching/weiser.pdf
- [B] Bartram, Ware & Calvert, "Moticons: detection, distraction and task", IJHCS 58(5), 2003: https://doi.org/10.1016/S1071-5819(03)00021-1 (PDF: https://www.interruptions.net/literature/Bartram-IJHCS03.pdf)
- [N] McCrickard & Chewar, "Attuning notification design to user goals and attention costs", CACM 46(3), 2003: https://cacm.acm.org/research/attuning-notification-design-to-user-goals-and-attention-costs/
- [V] Varakin, Levin & Fidler, "Unseen and unaware: implications of recent research on failures of visual awareness for HCI", Human–Computer Interaction 19(4), 2004: https://www.tandfonline.com/toc/hhci20/19/4
- [H] Anderson et al., "How polymorphic warnings reduce habituation in the brain", CHI 2015: https://scholarsarchive.byu.edu/facpub/9306/ · Vance et al., "Tuning out security warnings", MIS Quarterly 42(2), 2018: https://aisel.aisnet.org/misq/vol42/iss2/3/
- [P] W3C, Understanding SC 2.2.2 Pause, Stop, Hide: https://www.w3.org/WAI/WCAG20/Understanding/pause-stop-hide.html
- [G] WebGL context caps: Chromium's ~16 per page, losing the oldest: https://github.com/xtermjs/xterm.js/issues/6068 · https://community.plotly.com/t/too-many-active-webgl-contexts/16379 · Firefox "Exceeded 16 live WebGL contexts": https://bugzilla.mozilla.org/show_bug.cgi?id=1455507
- Distortion waves (Libraries.dev, MIT): https://libraries.dev/waves · source read: `packages/distortion-waves/src/{model,controller,renderer,capture}.ts`, site `sites/home/src/distortion-waves/{Components,WaveControls,scenes}.tsx`

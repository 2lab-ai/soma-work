---
name: cinematic-film
description: Turn real screen recordings into a cinematic product film in one of two looks: the plane look (the page on a tilted 3D plane, shallow depth of field, rack focus, beat cuts, title cards, grain) or the device look (the real app inside an iPhone mockup with taps, a typing keyboard and chapter captions). A -14 LUFS mix and independent review until it ships. Use for a product ad, launch film, cinematic demo or real-use phone demo; make-product-demo uses it; films built from code go to cinetic. Triggers on "cinematic", "시네마틱", "아웃오브포커스", "out-of-focus", "광고 영상처럼", "launch film", "iPhone mockup", "아이폰 목업", "실사용 데모", "phone demo".
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
version: 1.1.0
---

# Cinematic film from real screen recordings

A screen recording looks like a product ad when the screen stops being a flat rectangle. The page sits on a plane in
3D space, tilted back. The camera moves slowly over it. One element is sharp and bright, and the rest of the page falls
into smooth bokeh. Cuts land on the music's beats, and titles are a few words on black. This skill is that look and
the pipeline that makes it from real takes. It does not decide what to film; for that, use `make-product-demo`.

## Two looks, and when to use cinetic

| The film | Look |
| --- | --- |
| Desktop recordings made to feel like an ad: the page in 3D, one line sharp, the rest in bokeh | **plane** (the rules below) |
| Real use on a phone: the real app at a phone viewport inside an iPhone mockup, chapter captions on the left | **device** (`references/device-demo.md`) |
| Built from code, brand and copy (launch film, update video, logo sting, motion design) | not this skill: `cinetic` |

### The device look in short

A flat near-black stage at 60 fps, one phone on the right that does not move while the app is used in it, and a
caption on the left per chapter (a mono eyebrow `01 / SLACK`, then two lines: ink, then grey). Every tap shows a
touch disc from the take's markers; typing raises the keyboard and lights each key (Hangul jamo by jamo); an app switch
or a Safari tab swipe pushes; a jump inside the app fades. Record with `scripts/mobile_capture.cjs` (iPhone viewport,
device scale 3, 716 css with Safari's bar or 504 css with the keyboard up, markers for taps, swipes and keys), cut with
`scripts/cut_phone.py`, and build on `templates/remotion/device/` (`Device`, `Safari`, `Keyboard` + `hangul`, `Touch`,
`Caption`, a `Slack` mock for the one app you cannot record, and `PhoneFilm.example`). Mock only what cannot be
recorded and say so. The full rules, the measured reference and the pipeline are in `references/device-demo.md`.

The rest of this page is the plane look.

## The look, as rules

1. **The page is a plane in 3D.** Tilt it back (rotateX 20-35°), keep it straight (rotateY 0), and put a small roll
   on the whole picture (rotate 2-3°, one direction for the whole film). A side tilt (rotateY) lays the focus band
   diagonally across lines of text and looks broken.
2. **Depth of field is three copies, not an animated blur.** Draw the page three times: far (heavy blur, dimmed),
   near (light blur) and sharp. Each copy has a fixed blur level from a ladder (0.75, 1, 1.5, 2 … 128 px). Focus
   moves by moving masks on the near and sharp copies. **Never animate the blur radius**: Chromium steps it, and a
   large blurred layer re-rasterises every frame.
3. **Focus is on one thing.** The sharp area is an ellipse, a union of ellipses, or a feathered rectangle around one
   element: the line being typed, the card that landed, the step that is running. Grow the sharp area with a line
   as it is typed. A line of text is sharp end to end: the focus edge never cuts a line mid-word.
4. **Rack focus between ideas.** To move focus to another element, fade the sharp and near copies out for 3-6
   frames (the whole page soft), move the masks, and fade them back in. Open a shot on a soft rack when it cuts from
   a similar frame, so the cut reads as a focus pull and not a jump.
5. **Oversampled plane.** Lay the page out at R = 3 times the frame and scale it down by the camera. Chromium then
   rasterises the text at full detail before the zoom. Without this, zoomed text is soft.
6. **Record at 4x.** Capture the screen at device scale 4 (1280x720 css → 5120x2880 frames), so macro shots stay
   crisp at 3-4x zoom.
7. **Open or macro, on purpose.** Macro (3-4x zoom, heavy blur) is an ad. "Open" (0.7-0.8x of that, a light blur,
   far field barely dimmed) keeps the work readable. When the content is the point (an open-source product, real
   work on screen), go open. Close it down only where private content would show.
8. **Cuts on the beat.** Pick a track, find its tempo (118 BPM → a beat is 15.25 frames at 30 fps), and make every
   shot a whole number of beats. Start the music on a downbeat at frame 0. Land the end card's line on the drop.
9. **Titles: 1-4 words, centred on black.** They blur in over 12 frames (a soft copy fading out over a sharp one
   fading in). Don't use a cursor, bloom, chromatic aberration or letterbox.
10. **Grade and texture.** Use a mono or restrained palette, a vignette (radial, about 0.55 at the corners) and fine
    grain. Lift the sharp copy (brightness 1.1-1.4) so secondary grey UI text reads.
11. **Sound.** Use one licensed track, a soft key tick per typed character, and a whoosh and click on send. Duck the
    music by about 13 dB under speech. Use a limiter, then two-pass loudnorm to **-14 LUFS** integrated and -1.5 dBTP.

## Pipeline

```
takes (screencast frames + markers)
  → scripts/cut.py         CFR 30 fps clips, small frames dropped
  → templates/remotion/    Plate.tsx.template (the rig) + Film.example.tsx.template (title → plates → end card,
                           open()); copy both into a Remotion project as .tsx
  → stills                 npx remotion still <Comp> out/s-<f>.png --frame=<f>  (tune every focus spot here)
  → render                 npx remotion render <Comp> out/picture.mp4 --muted --crf=15
  → scripts/mix_audio.py   cue sheet → music + ticks + voice + sfx → -14 LUFS
  → mux                    ffmpeg -i picture.mp4 -i mix.wav -c:v libx264 -crf 18 -c:a aac -b:a 256k -shortest
  → privacy scan + independent review → fix → re-render → SHIP
```

- **Plate spec** (`templates/remotion/Plate.tsx.template`): `segs` (which clip, from which frame), `vw` (the recording's css
  width), `cam` keys (`{f, x, y, s, rx, rz, ox, oy}`: the page point held at frame centre, zoom, tilt, roll, and a
  settle offset), `focus` keys (`{f, spots, soft, rect}`), `blur` / `nearBlur` / `far` / `lift`. The last camera
  segment runs linear, so the camera never eases to a stop right before a cut.
- **Finding spots:** take a still of the recording (or the browser's own element box), read the element's box in css
  px, and write `sp(cx, cy, halfW, halfH)`. For a line of text, use `line(x0, rightEdge, y)`. Check every spot on
  rendered stills before a full render.
- **README GIFs** come from the same takes: `scripts/make_gif.py <take> out.gif --start <marker>[+s] --end <marker>
  [--crop x,y,w,h] [--speed 1.5]`. Keep each GIF 8-12 s and about 1 MB, and crop to where the action is.

## Privacy: every readable word is published

Opening up the depth of field makes the background readable. Before a film or a GIF ships:

- Extract frames every 10-15 frames through every plate (and both sides of every cut). Read every readable piece of
  text: host names, internal domains, private repository or channel names, people's IDs, tokens, file paths with
  user names.
- Keep private content out of focus (a landing shot's cards below the new card are the usual leak). Filter the source
  view first (one repository, hide cards naming private things) rather than blurring after.
- Say what was hidden in the caption or report ("private cards hidden"). Don't silently curate.

## Independent review until SHIP

Get a fresh reviewer (a subagent that did not make the film) for every cut. Give it the film path, the shot list with
frame ranges, the owner's words, and `references/review-rubric.md`. It extracts frames, scores the cut out of 10 and
ends with SHIP or FIX and a must-fix list. Fix the must-fixes, re-render, and send the next cut back to review. Stop
only at SHIP. Report the score history (for example 4 → 5 → 6 → 7.5 → SHIP).

## License

The rig and scripts here are plain React/CSS and ffmpeg. The templates target **Remotion**: Remotion's license is
free for individuals and companies of up to 3 people; larger companies need a Remotion company license. Check it
before you use these templates commercially. Music and sound effects need their own licenses. Keep a CREDITS file next
to the delivered film.

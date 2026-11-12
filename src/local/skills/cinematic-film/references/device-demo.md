# The device look: real use on a phone

A product film that shows the real app being used on a phone. No tilted plane and no depth of field: a flat near-black
stage, one phone on the right that never moves while you work in it, and a chapter caption on the left that says what
this part shows. It reads like watching a person use the product, chapter by chapter. Measured from a reference launch
film (a mobile app for coding agents, 49.9 s, 1080p60) and proven on a 2:54 soma-work × llmux demo.

## What the reference does (measured)

| Element | Value |
| --- | --- |
| Stage | flat `#0e0f11`, no grain, no vignette, no camera move |
| Frame rate | 60 fps (UI motion: scrolls, pushes, the keyboard) |
| Phone | right of centre (centre x ≈ 1395 px at 1920 wide), about 900 px tall, a thin dark body, black glass, Dynamic Island, status bar `9:41`, home indicator |
| Caption | left, x = 130 px: a 40 px rule, then a mono eyebrow `01 / INBOX` (≈19 px, tracked 0.2 em, grey), then two lines ≈ 70 px semibold, tight tracking: line 1 ink, line 2 grey |
| Chapters | 5-6 in 50 s; the caption changes (blur cross-fade, ~14 frames) while the phone stays where it is |
| Interaction | a grey touch disc on every tap, the on-screen keyboard typing key by key (key balloons), native pushes and sheets |
| Big moves | at most one: the phone turns in 3D (a foldable unfolds) before the end |
| Opening / end | one two-line line on black (ink + grey); the end card centred: line, sub line, store badges, URL |
| Sound | one music track at ≈ -13 LUFS integrated, the beat comes in after the first chapter |

## Rules

1. **The phone is the stage.** One device, fixed size and place for the whole film. Do not zoom or pan to make text
   readable: record at device scale 3 so 12-13 px UI text stays crisp at 1080p.
2. **Real screens.** Record the real app at a phone viewport. Mock only what cannot be recorded (a third-party app
   such as Slack) and say so in the caption or the report. A mock copies the real content of that moment.
3. **One chapter, one caption.** Eyebrow `NN / WORD` in English caps, two lines in the film's language: line 1 says what
   you do, line 2 what you get. Change the caption when the chapter changes, never mid-gesture.
4. **Every touch is visible.** A disc where the finger lands (lands at 0.55 → 1 scale in 5 frames, lifts in 14), a
   moving disc for a scroll. Taps come from the take's markers, not from guesses.
5. **Typing uses the keyboard.** The keyboard slides up (14 frames) when a field is focused, each key lights with a
   balloon, Hangul composes jamo by jamo (`hangul.ts`: 2-set layout, shifted double consonants, compound vowels and
   finals), Latin switches to the English rows, punctuation to `123`. It slides down when the text is sent.
6. **Native transitions only.** An app switch or a Safari tab swipe pushes horizontally (22 frames); a jump inside the
   app (close a card, open another) is a 12-frame fade; everything else is a continuous take.
7. **Pace.** 8-25 s a chapter; speed a long scroll up (2-2.5x) rather than cutting it; hold 2-3 s on the frame that
   proves the point (the request, the raw upstream call, the diff).
8. **Sound.** One licensed track edited to the film's length (jump back whole phrases at a bar line), a soft key tick
   per typed key (every second key when a mock types faster than a person), a click per tap, a confirm on send, the
   voice where the recorded microphone started, music ducked ~11 dB under it, -14 LUFS.

## Capture (scripts/mobile_capture.cjs)

- iPhone 15 Pro emulation (393 css wide, touch, mobile UA), real Chromium on the GPU at device scale 3 (1179 px
  frames). Viewport height 716 css with Safari's compact bar, 504 css while the keyboard is up; switch it at the
  moment the keyboard would open or close and mark it.
- Mark everything the film draws: `tap` (with `what` and the element's centre), `swipe`/`swipe-end`, `key` per typed
  character (`\n` return, `\b` delete), `vp` heights, voice events. Use `what`, not `name`, for labels (a marker's
  `name` is its type).
- Log in the way a user would when the product has a link login (a one-time link from chat): open the real link.
- A spoken request: feed a TTS take as the microphone (`getUserMedia` returns a stream that plays the WAV) so the
  product's own dictation transcribes it; mark when the microphone started.
- Anonymise in the data, not only on screen: rewrite emails in the API responses (`context.route`, JSON bodies)
  and keep a DOM mask (a MutationObserver on the document and every shadow root) as a backstop. A mask that runs on
  an interval lets a real address paint for a frame or two when a sheet opens. Use the product's own setting too
  when it has one, and turn it back off after. `maskResponses` buffers each response before it rewrites it, so a
  stream must pass through: EventSource requests do on their own; name a fetch-read stream with `stream(req)`.
- Paint dark from the first frame (`html { background: #000 }` before the app's CSS) and turn off the tap highlight
  (`-webkit-tap-highlight-color: transparent`): both otherwise leave one-to-four-frame flashes a reviewer will catch.
  Frames that still flash can be dropped at cut time (`drop` ranges in `shots.json`; the frame before holds).

## Edit (scripts/cut_phone.py → templates/remotion/device/)

1. Write `shots.json`: one shot per continuous window of one take at one viewport height (`t0`, `t1`, `speed`, `vh`,
   `domain` for Safari's bar, `kb` for the keyboard rows, `load` for Safari's progress bar, `drop` source-time ranges to
   remove, `extra` taps the take did not mark, such as the close that motivates a cut to the board).
2. `cut_phone.py shots.json --takes takes --public <film>/public --gen <film>/src/phone/shots.gen.ts` cuts 60 fps clips
   (1180 wide) and writes the shot table with every marker in film frames. It cuts only clean takes (stopped with
   `rec-stop`, never `rec-failed`) and keeps each frame's capture time to the millisecond: ffmpeg reads a lone image
   at 25 fps, and that time base alone turns a 60 fps scroll into 25 distinct frames a second.
3. Copy the device templates into the film (`.tsx.template` → `.tsx`), fill the CONFIG block of `PhoneFilm.tsx`
   (opening line, chapter captions placed from shot starts, transitions, end card, an optional mock scene), render
   stills of every chapter and every transition at full size before the first full render.
4. Mix with `scripts/mix_audio.py` (cues from the shot table), mux with the audio padded to the picture's length.

## Review

Independent review until SHIP, as for the plane look. Every cut between two screens of the app needs the tap that
causes it (open, close); a mock's clock matches the real record of the same moment. Device-specific checks: every requirement visible on the phone;
taps land on what reacts; the keyboard is up exactly while typing and the typed text matches; no blank or frozen
screen around transitions; captions say what the chapter shows; every readable word is publishable.

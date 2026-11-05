# Dashboard first load — closed dialogs flashing and the loading screen (2026-11-05)

One line: hide every overlay element until it is defined, and cover the page with a first screen shaped like the page until nothing the viewport shows is undefined — then fade it out (#965).

```
Owner report: "새로 열거나 리프레시할때 이 좇같은 설정창 잠깐 나왔다 사라짐 픽스하고 로딩 페이지 이쁘게 해줘 (리서치)"
├── Why the settings form shows ── undefined custom elements draw their children   → ui-dialog:not(:defined) { display: none }
├── What the loading state is ──── blank bar, empty board, then content             → first screen = the page in outline
├── When to show motion ────────── no motion for loads under a second               → pulse at 500 ms, mark at 1 s
└── When it goes ───────────────── defined-or-timeout, never stuck                  → viewport check · DOMContentLoaded · 12 s · CSS 15 s
```

Reading guide: each section is a finding with its source, then what the dashboard does with it. The last section lists where the dashboard deliberately differs.

## Measured on the real server

Playwright against the real web server, browser API calls mocked, 390×844 phone, 8 Mbps and 120 ms latency, CPU 4×. Every painted frame kept (CDP screencast); an rAF probe recorded whether the lifecycle form, the rollback footer or the new-task form was painted.

- Before, cold load: the dialogs' contents painted from 0.31 s to 3.03 s, then the board.
- Before, warm refresh (modules cached): painted from 0.32 s to 0.60 s — the "잠깐 나왔다 사라짐".
- After, both: 0 frames. The first screen shows from the first paint and lifts right after the bar is defined (cold 3.38 s, before DOMContentLoaded at 3.59 s; warm 0.61 s).

Modules run only after the ~1 MB document is parsed (parsing ends at about 0.95 s cold), so the first ~2 s of a cold load have no element defined.

## Findings

- `:not(:defined)` has worked in every major browser since January 2020. `display: none` takes the element's room away and `visibility: hidden` keeps it; both take it out of the accessibility tree. Source: [MDN :defined](https://developer.mozilla.org/en-US/docs/Web/CSS/:defined), [MDN visibility](https://developer.mozilla.org/en-US/docs/Web/CSS/visibility).
  The dashboard: a closed overlay takes no room once defined either, so `display: none` for `ui-dialog`, `ui-drawer`, `ui-hovercard` and `ui-artifact-viewer`. No timeout — if a module fails, a closed dialog should stay hidden.
- Shoelace waits for its elements with `whenDefined()` and fades the page in over 0.25 s; Web Awesome's cloak shows the page when everything is defined or after 2 s, because `whenDefined()` never rejects for a name that is never defined. Source: [Shoelace usage](https://shoelace.style/getting-started/usage), [Web Awesome FOUCE](https://webawesome.com/docs/utilities/fouce), [MDN whenDefined()](https://developer.mozilla.org/en-US/docs/Web/API/CustomElementRegistry/whenDefined).
  The dashboard: no list of names to wait for. The first screen asks the page itself — `querySelectorAll(':not(:defined)')` filtered to elements with a box in the viewport — so a new element needs no change here, and a closed dialog or a hidden section never holds it.
- Skeleton screens suit a full-page load under about 10 seconds; a loader that flashes and disappears for a load under a second makes people uneasy; a skeleton of only the header and footer is no better than a spinner. Source: [NN/g skeleton screens](https://www.nngroup.com/articles/skeleton-screens/), [NN/g progress indicators](https://www.nngroup.com/articles/progress-indicators/), [GitHub Primer loading](https://primer.style/product/ui-patterns/loading/).
  The dashboard: the first screen draws the bar, the board head and the board's columns with the kit's 2 · 3 · 2 skeleton cards, in the page's geometry (bar 56 px, 52 on phones; main column 1280 px with 20 px padding, 14 / 12 on phones; 12 px column gap, 300 px columns on a phone).
- Size skeletons like the final content; a 200×20 block turning into 80×16 text reads as a fault. Source: [Vercel Geist skeleton](https://vercel.com/geist/skeleton).
  The dashboard: the skeleton cards are the kit's own (`.ui-skeleton`: title 68 % × 14 px, meta 42 % × 10 px, pill 34 % × 20 px), so the board's own loading state and the first screen match.
- Delay the indicator and hold it once shown (spin-delay defaults: show after 500 ms). Source: [spin-delay](https://github.com/smeijer/spin-delay).
  The dashboard: the blocks are still until 500 ms and the brand mark starts breathing at 1 s, so a warm refresh (about 300 ms of first screen) sees no motion.
- Animate `transform` and `opacity` only; remove non-essential motion under `prefers-reduced-motion`. Source: [web.dev animations guide](https://web.dev/articles/animations-guide), [web.dev prefers-reduced-motion](https://web.dev/articles/prefers-reduced-motion).
  The dashboard: the pulse is the kit's opacity pulse (already still under reduced motion), the mark animates opacity and stops under reduced motion, the exit is a 180 ms opacity fade (the kit's `--dur-fade`).

## Where the dashboard differs

- No 2 s cap. Web Awesome's cap protects a page hidden whole; here the overlays stay hidden by their own rule, and a 2 s cap would show the empty bar and board for the rest of a slow phone load. The first screen lifts at DOMContentLoaded at the latest (every module has run, failed ones included), and at 12 s if a module request never answers. A CSS animation hides it at 15 s without script.
- Pulse, not shimmer. The kit's skeleton is an opacity pulse; the first screen uses it so the board's own loading state looks the same.
- No words. The first screen is `aria-hidden` and has no text to translate; the board announces its own loading state (`aria-busy`).

## Not done here

- Module waterfall: on a cold load, parsing ends at about 0.95 s but the bar is defined at about 3.3 s — the 40 module files and their shared chunks arrive over the network one round trip after another. `<link rel="modulepreload">` for the chunks, or one bundle, would shorten the cold load itself. Not measured further.

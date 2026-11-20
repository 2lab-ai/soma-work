# Libraries.dev effects in the soma-work dashboard: where each one goes

Read-only analysis. Paths are relative to `soma-work/src/conversation/` (the dashboard) and `ui/src/components/` (the
library). Line numbers are from the working copies on 2026-11-21.

## 1. Conclusion

| Effect | Spot 1 (do this) | Spot 2 (optional) | Must be limited to | Who changes |
|---|---|---|---|---|
| `ui-distortion-wave` | Board card status change (already decided) | — | cards in view, one wave at a time, not on first paint | ui-agent-inbox + page |
| `ui-border-beam` | The **시작 중 (starting) launch card** on the board | The panel's **입력 필요 (input needed)** box while it waits | launch cards only (usually 1); the front card's box | ui-agent-inbox (card field); page wraps #panel-needs |
| `ui-thinking-orb` | The chat's **writing row** ("응답 작성 중"), state taken from the agent's last tool | none | the one pending row, only while 지시와 답변 is shown | ui-ai-answer / ui-conversation + convPaint data |
| `ui-gooey` | The panel's **next-actions bar** (buttons split in, merge into the pressed one) | `ui-segmented` thumb (Board / List) | panel only, never the per-card variant | page only (spot 1); ui-segmented (spot 2) |
| `ui-voice-glow` | **Voice-note recording** in `ui-composer` (real level) | **받아쓰기 (dictation)** listening in the same composers | the one composer that holds the mic | ui-composer (spot 1); dictation clients + composer API (spot 2) |
| `ui-voice-ring` | The **live phone-call view**, driven by call state | Settings › 받아쓰기 › **말해서 시험 (speak to test)** | the open dialog while the call is live; one context | page only |
| `ui-bot-avatar` | **Detail panel header**: one face for the card in front (working / default / sleeping) | The **agent tab strip** (Main + subagents as a roster) | front card only; strip ≤ 8 tabs | page (spot 1); ui-tabs (spot 2) |
| `ui-metal` | The **login page** wordmark (`/login`, `/auth/sso`) | none on the dashboard | one instance on an otherwise idle page | ui-auth-card |
| `ui-image-reveal` | The **artifact viewer's full image** while it loads | none | the page shown, and only when the image is not cached | ui-artifact-viewer |
| `ui-voice-position` | none | — | — | — |
| `ui-magnetic` | none | — | — | — |

What it costs: on the board page, at most one WebGL context is alive outside transitions (the voice ring in the call
dialog or the image reveal in the viewer — never both on purpose). The distortion wave adds a short-lived one. Every
other effect is 2D canvas (one orb, one to nine bot faces), CSS (beam, glow) or SVG filter (gooey). No effect runs on
every board card except the brief distortion wave and the beam on the (rare) 시작 중 card.

## 2. Facts the choices rest on (the brief's questions)

- **No "thinking before the first token" state on the client.** Answers are not streamed to the dashboard. The chat's
  writing row is shown while the session works and the latest turn is the user's (`ansPendingShow`, dashboard.ts:22788;
  `pending:` in `convPaint`, 22585). It lasts until the recorded answer arrives, so the whole turn is the "thinking"
  time. Before it, `turnBusy` (server, 3009) marks a dispatched turn that is not working yet. The chat shows that as the
  steer chip "처리 중 · …새 작업을 시작하고 있어요". The first-token moment cannot be observed. Only phone calls log
  `firstTokenMs` (25293), and only afterwards.
- **What the agent is doing now:** `s.agentRoot.lastTool` (main agent, 449/723) and each subagent's `lastTool` (693/759).
  `agentActivity` (13759) already reads them. This is enough to choose an orb state.
- **The composer records voice notes but exposes no stream or level.** `ui-composer` keeps the `MediaStream`,
  `AnalyserNode` and a per-frame `#level` private (composer.ts:60–75, 855–972). The level bar is drawn in `#meter`
  (964–972). The page only gets `ui-record` events `{state: start|stop|cancel|error}` (composer.ts:940/948/1017/1035).
  The dashboard listens to them at dashboard.ts:20021 and stops dictation when a voice note starts.
- **Dictation (받아쓰기)** uses the Web Speech recogniser by default (`ntDictateStart`, 26836). That engine gives no
  audio access. The Whisper engines open their own microphone stream (dictation-server-client.ts:84–96, `c.stream`)
  but do not hand it out.
- **Images:** the board never shows one ("never an image on the face", 13256; 13276). Images load in the artifact
  viewer (`<img class="av-pic">`, artifact-viewer/logic.ts:319–322). It is opened by `openArtifactViewer` (25706) with
  `url = artUrl(cid,id)` (`artFileItem`, 24976–24995). They also load in the hovercard peek (logic.ts:245–247) and in
  chat media tiles (media-grid.ts:237, lazy).
- **Model and Fable marker:** `s.model` (KanbanSession, 263) and a subagent's `a.spend.model` (14609). There is no
  Fable-only marker. `cardFinishOf(model)` (card-finish-client.ts:29–34) returns `'foil'` for **fable or astra** and
  `'bright'` for opus or sol. `syncCardFinish` (12667) applies it to each card in the shadow root. Note: "Fable loud"
  through `'foil'` also makes astra loud. If the owner means Fable only, test `/fable/` separately.
- **Cards live inside `<ui-agent-inbox>`'s shadow root** (`li.ib-card[data-card=key]`). Card data has no slot for an
  element on the face (`lead` is text and a glyph). Anything drawn on a card needs a new card field in the library.
  The page can only inject CSS, as it does for the card finish.
- **The boot screen cannot host any effect.** It is up only until the modules have run (boot-screen.ts:1–30), so no
  custom element exists while it shows.

## 3. Per effect

### ui-distortion-wave (decided: status changes)
Hook: a card's `status` in `_cardData[key]` differs from the last paint (`renderBoard` 12268 / `refreshCard` 12947 →
`inboxPaint` 12434). Loud when `cardFinishOf(s.model) === 'foil'` (see the astra note above). Limits:
- skip the first paint, reloads and filter or sort changes (`partial`, `_boardLoad`);
- only cards in view;
- one wave at a time (drop or queue the rest);
- nothing while the tab is hidden;
- reduced motion: a crossfade.

Because the card is in the shadow root, `ui-agent-inbox` must run the wave or expose the card's box.

### ui-border-beam
1. **The 시작 중 launch card.** `ntPendingCardOf` (27965) builds it: status `running`, `statusText '시작 중'`, the
   clock from the press. It is placed first in RUNNING by `ntPendingPlace` (28062) until the session's own card arrives
   (seconds to minutes). Today only its text tells it apart from ordinary running cards. A rotating beam (`md`) says "on
   its way" at a glance, anywhere on the board.
   - Hook: add a field (for example `beam: 'rotate'`) in `ntPendingCardOf`. `ui-agent-inbox` draws the beam on that
     `li` (library change: the `li` is in its shadow root).
   - It ends when the launch card leaves. The real card's arrival is then a natural hand-off to the distortion wave.
   - A failed launch (시작 실패) gets no beam: it already has the attention cue.
   - Count: one per launch in flight, usually one.
   - Reduced motion: a still glow edge. Decorative; the 시작 중 tag is the text.
2. **The panel's 입력 필요 box (input needed)** (`#panel-needs`, 8135) while `panelNeedsCount(s) > 0`
   (`renderPanelNeedsHead` 9738 → `syncPanelNeeds`). The agent is blocked on the reader, and the beam stops when they
   answer.
   - Use `pulse-inner` (a breath, not a travelling beam): it means "waiting for you".
   - Caveat: `placePanelNeeds` (9768) moves the box between the surface and `ui-conversation`'s slot. Move the beam
     wrapper together with the box, or put the beam inside the box.
   - One instance: the front card only.

Rejected:
- NEEDS YOU board cards: they already have a rail and a 10-second ping (agent-inbox styles 425–440), and there can be
  many.
- The composer field: that is voice-glow's place, and a constant beam there is noise.
- The 새 작업 button (`new-task-fab`, 8240): permanent decoration on a call-to-action.

### ui-thinking-orb
1. **The chat's writing row.** `ui-conversation` renders the pending turn as
   `ui-ai-answer {markdown:'', streaming:true}` (conversation.ts:500–501). `#writing` draws a shimmer
   "응답 작성 중" plus a pulsing 8 px dot (ai-answer.ts:476–478; styles 50–54).
   - Replace the dot with a 20 px orb.
   - Data: `convPaint` sends `pending: true` today. Change it to `pending: { activity }`, where `activity` comes from
     `s.agentRoot.lastTool`:
     - Read / Grep / Glob / WebSearch / WebFetch → `searching`
     - Edit / Write / MultiEdit → `composing`
     - Bash → `working`
     - Task / Agent, or any subagent running → `weaving`
     - TodoWrite → `shaping`
     - `mcp__*` → `connecting`
     - no tool yet → `solving`
   - `ui-conversation` passes it on; `ui-ai-answer` draws `<ui-thinking-orb size=20 state=…>`.
   - Seen during every running turn, in the one place where the answer will appear. It carries real information (what
     the agent did last), and the cost is one 2D canvas.
   - Limits: only the pending row. Only while 지시와 답변 is the open section (`convPaint` returns early otherwise).
     Pause when scrolled away or when the tab is hidden.
   - The orb is aria-hidden; the shimmer word and the card's `aria-busy` are the text.
   - Reduced motion: a still frame.

Rejected:
- Running board cards: dozens of continuous canvases, and the tag already says running.
- The panel status bar: it would duplicate the writing row, and continuous motion in the header for hour-long turns
  is noise.
- The steer chip (`steerChipHtml`): it shows together with the writing row, so there would be two orbs in one chat.
- 요약 / 부제 만드는 중 (8325/8328): tiny text loaders.
- The boot screen: see section 2.
- The 시작 중 card: given to border-beam; one cue per card.

### ui-gooey
1. **The next-actions bar** (`#panel-next-bar`, 8220). `renderPanelNext` (17245) writes `nextActionsHtml(s, na,
   'panel')` (17212–17233): `.na-row` with `.na-btn` buttons, the recommended one primary. The markup belongs to the
   page, so no library change is needed.
   - When a new set appears (`bar._html` goes from empty to filled), the buttons split out of one drop.
   - On a press (`nextActionButton` → `sendNextAction`, 17262–17283), the other buttons merge into the pressed one
     before the bar hides (`_naSent`).
   - Meaning: "the answer offers these" and then "this one was sent".
   - Seen after answers that carry next steps.
   - Limits: the panel variant only, never the `'card'` variant (17242) on open board cards.
   - The DOM stays live and crisp (gooey filters a silhouette layer only); focus is never moved.
   - Reduced motion: a fade.
2. **`ui-segmented`'s thumb** (`#view-seg`, Board | List; 7987; `setBoardView` 17942). This is the library's "Move"
   case (a tab indicator). Library option on `sg-thumb` (segmented.ts:116). Rarely used; pure polish.

Rejected:
- The phone dock (`paintPhoneDock` 8484): its items are links to other pages, so nothing moves in the page.
- Panel section tabs: an ink underline, not a blob.
- The agent dots on every card.

### ui-voice-glow
1. **Recording a voice note** in `ui-composer`: `#nt-composer` (new task, 8285) and `#pc-composer` (panel, 8230).
   - Library change only: while `#rec` is set, wrap the field card in `<ui-voice-glow>` and feed it
     `level: () => this.#level`. That level is already computed every frame in `#meter`.
   - Stop it in `#stopRecording`. The dashboard changes nothing.
   - Real microphone level and an exact match for the effect: "rises with your voice from the bottom of a chat input".
   - Only one composer records at a time (the page stops dictation on `ui-record` start, 20021–20027).
   - Decorative: the recorder group's label and its `role=timer` clock carry the state. CSS only.
2. **Dictation (받아쓰기) listening** in the same composers.
   - Whisper engines: add an `onStream(stream)` callback to `dictationServerStart` / `dictationBrowserStart`. They are
     called from `ntDictateStartWhisper` (26991). Hand the stream to the composer through a small public API (for
     example `composer.listen(stream | null)`).
   - Device engine (the default): no audio access. Drive the glow from recogniser events (a bump on each `onresult`,
     raised between `onspeechstart` and `onspeechend`), or hold a low steady glow.
   - Never open a second `getUserMedia` for it: on iPhone it fights the recogniser.

### ui-voice-ring
1. **The live phone-call view** (`#phone-call-dialog`, 8301; `renderPhoneDialog` 25333 / `phoneDialogHtml` 25312)
   while `call.status !== 'ended'`. A live AI voice call is exactly this library's domain.
   - Place it at 96–120 px above the transcript (the 📞 icon comes back when the call ends).
   - The call runs on the server, so the browser has no audio. Drive the ring by state from the call record:
     - `dialing` → `processing`;
     - last transcript line from the peer, with no newer `reply` work entry → `processing`;
     - a newer `reply` with no later `tts` → `speaking`, with a gentle synthetic `level`;
     - otherwise `listening`, with level 0.
   - Updates arrive via `phone_call_update` (20257 → `onPhoneCallUpdate` 25203 → `phoneRefetchSoon`, 500 ms).
     The state lags by about one line, which is acceptable.
   - One WebGL context, created when a live call's dialog opens and released on close or when the call ends.
   - Rare, high meaning. Decorative; the status text (통화 중 …) is the text.
2. **Settings › 받아쓰기 › 말해서 시험 (speak to test)** (settings-dictation-tab.ts:53–58; `dicTestStart` 480): eight
   seconds of listening, then waiting for the words, then idle.
   - Real level with the Whisper engines (same `onStream` hook as voice-glow spot 2).
   - With the device engine: `onaudiostart` / `onspeechstart` only.
   - One instance on a quiet page; it answers "does it hear me".

Rejected:
- The composer: voice-glow's job, and the ring needs at least 64 px.
- The chat's phone cards (`phoneCardHtml` 25145): there can be several, and they already have a CSS wave.

### ui-bot-avatar
1. **Detail panel header**, before the title (`.panel-header` 8088–8119; paint from `renderPanelHead` 15603).
   - One face for the card in front, following the deck (cross-animates on a switch).
   - State:
     - `working` when `turnHolds(s)` (15380);
     - `sleeping` when `s.sessionState === 'SLEEPING' || s.terminated`;
     - `default` otherwise (or the port's fourth state for `activityState === 'waiting'`, if it is a waiting pose).
   - Shape: a fixed map from the model family, using the same word match as `cardFinishOf`, so the face also says
     which model runs the task.
   - Size: 28 px on desktop, 24 px on a phone. aria-hidden: the status bar (`#panel-status`) says the state.
   - Cost: one 2D canvas.
2. **The agent tab strip** (`#panel-tabs`, 8169; `panelTabsData` 14594) as the library's "roster" case.
   - Main plus A1…An: running → `working`, completed → `sleeping`, failed or stopped → `default`, keeping the fail tone.
   - Needs a `ui-tabs` change (an avatar per tab).
   - Only with 8 or fewer tabs, at 24 px or more; above that, or below 24 px, keep the tone dots (the fur is mush at
     16 px).

Rejected:
- Board cards (dozens of faces).
- Chat assistant avatars (one per turn). If wanted later, animate only the last turn and draw the rest `paused`.

### ui-metal
1. **The login page wordmark** (`/login`, `/auth/sso`; auth-pages.ts, `BRAND = {label:'soma-work', mark:true}`
   drawn inside `ui-auth-card`'s declarative shadow root).
   - MetalText on the wordmark, or a MetalFx circle on the mark.
   - One WebGL2 context on a page where nothing else runs, released on navigation.
   - Plain mark without WebGL2; a still frame for reduced motion.
   - Needs `ui-auth-card` to accept it (a brand option or slot).
   - Delight at a rare moment; no state.
2. **None on the dashboard.**
   - The premium language is already the holographic **foil**: Fable and astra cards (card-finish-client.ts:1–8) and
     the effort picker's ultra colours. Metal on the Fable picker or card would be a third premium material.
   - The 새 작업 button and the 작업 시작 send button are on screen all the time: a constant WebGL animation on the
     busiest page.
   - The "새 버전" toast (20117–20126) is a warning, not a "New" moment.
   - EPIC-done badges accumulate, one context each.

### ui-image-reveal
1. **The artifact viewer's image body** (library: artifact-viewer/logic.ts:319–322).
   - It opens on a press of an image artifact or attachment (screenshots, receipts).
   - Show the mosaic while `img.decode()` is pending, then let it settle into the picture.
   - Limits:
     - Skip it when the image is already decoded (`complete && naturalWidth`): a cached image must appear at once.
     - Keep the settle short (≤ 400 ms after decode), so it never slows a fast load.
     - Only the page shown; cancel on ‹ › or close.
     - Release the context once it has settled.
   - The `<img alt=name>` stays the accessible content.
2. **None.**
   - The hovercard peek is a hover glance; a reveal would delay it.
   - Chat media tiles are many lazy images.
   - The board never shows images.

### ui-voice-position: none
It needs a direction model running on stereo microphones (an iPhone model file). Browser microphones are mono, with
gain control applied. Phone-call audio stays on the server. Nothing in soma-work knows where a voice comes from.

### ui-magnetic: none
The real-magnet mode needs the Android Magnet Bridge app. The pointer mode pulls controls toward the cursor: on a dense
board that hurts precise pointing, and on touch it does nothing.

## 4. Order of work (suggested)
1. Effects that need no library change: gooey on the next-actions bar (page only) and the voice ring in the phone
   dialog (page only).
2. Small library hooks, one element each: voice-glow in `ui-composer`, the orb in `ui-ai-answer` / `ui-conversation`,
   image-reveal in `ui-artifact-viewer`.
3. Card fields in `ui-agent-inbox`: the beam on the 시작 중 card, then the distortion wave.
4. Header face (bot-avatar spot 1) and the auth-card metal.
5. Optional second spots: the `#panel-needs` beam, dictation glow with `onStream`, the 말해서 시험 ring, the tab roster,
   the segmented thumb.

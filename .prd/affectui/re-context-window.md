# re-context-window — Context Window → 패널 세션 정보의 컨텍스트 블록 + 카드 ctx 메트릭

Status: 계획 (Phase A) · Date: 2026-10-26 · 기준 main `ff6c9ac` · 서브이슈 #441 (에픽 #437) · 브랜치 `feat/dashboard-affectui-context-window`
앞선 계약: [`../13-dashboard-three-surfaces-spec.md`](../13-dashboard-three-surfaces-spec.md) §3.7(ctx 단계)·§3.5(세션 정보),
[`../11-dashboard-live-surfaces-spec.md`](../11-dashboard-live-surfaces-spec.md) · SSOT [`ssot.md`](ssot.md)

## 0. 한 줄 정의

레퍼런스는 "모델이 지금 무엇을 쥐고 있나, 얼마나 찼나 — 지금 비울까"를 한 카드에서 결정하게 한다(칸으로 된 필드 + 부분 목록 + Compact).
대시보드에서는 **패널 › 세션 정보(펼침)** 맨 위의 컨텍스트 블록이 집이고, **접힌 카드의 ctx 메트릭**과 세션 정보 요약 줄은 같은 단계를 숫자 하나로
보여 준다. 부분은 SDK가 실제로 주는 마지막 요청의 토큰 분류(캐시 읽기·캐시 쓰기·캐시 안 된 입력·출력)이고, 한계선은 이 세션이 실제로 압축되는
지점(autocompact)이다.

## 1. 레퍼런스 해부 [REF]

![ref](assets/ref-context-window.jpg)

원천: `docs-*.js`(props·keyboard·a11y·motion·responsive·aiNotes), `RE-css.txt`, 데모 번들, 캡처 `components_context-window-{light,dark}-t1/t2.png`.

### 1.1 구조

```
.ui-cw [role=group, aria-labelledby=title, data-level=ok|warn|full]   ← 트레이(바깥 면, 4px 안쪽 여백, 반경 20)
├─ .card (반경 16, 12/14/8 여백, 1px 테두리)
│  ├─ head: title "Context window" · model 태그(12px 로고 + 모노 11px, 높이 20, 최대 62%)
│  ├─ figure: big 숫자(롤링, aria-hidden) · "of 200K tokens"(swap) · % pill · sr 문장
│  ├─ field [aria-hidden]: 셀 216개 = 36열 × 6행, 셀 = limit/cells 토큰, 부분 순서대로 채움, 나머지 free
│  └─ parts <ul>: 행 = swatch 7px · label(+items면 chevron) · [Compact] · value(우측, 최소 52px)
│     └─ items 있는 부분: 행이 button[aria-expanded] → fold(접히면 inert) → 항목(모노 11.5px · 토큰 · × 제거)
└─ foot(트레이 위): caption [aria-live=polite](상태 문장 swap) · action 버튼("New chat →")
```

### 1.2 상태

| 상태 | 조건 | 바뀌는 것 |
|---|---|---|
| ok | used/limit < warnAt(0.8) | pill 회색, caption "88K free"(limit−used) |
| warn | ≥ 0.8 | pill·caption 호박색, caption "24.4K left" |
| full | ≥ 0.95 | pill·caption 빨강, caption "Window is full" |
| hot | 행/셀에 마우스, 또는 행 버튼·Compact에 포커스 | 그 부분 셀 scale 1.12, 다른 칠한 셀 opacity .22(free 제외), 다른 행 .55, 그 행 배경; big → 부분 토큰, "of…" → 부분 라벨, caption "**Files** · 18.4% of the window"(10% 미만 소수 1자리) |
| compacting | Compact 누름 ~ promise 정착(최소 1.3s) | 그 부분 셀 shimmer wave, 버튼 스피너, caption "Compacting…", 다른 Compact 비활성 |
| compacted | 정착 후 | 버튼 → 초록 ✓ "Compacted" 1.5s → 0.4s 사라짐; 부분이 다시 커질 때까지 버튼 없음; caption "Saved **78.2K** tokens"(초록) 3.2s |
| item 제거 | × | 항목이 0.24s 접힌 뒤 빠짐, 셀이 앞으로 당겨짐 |
| empty items | items=[] | "Nothing attached" |

### 1.3 상호작용 · 키보드

- Tab: 열 수 있는 부분 → Compact → 항목 제거 → action. Enter/Space: 열기/닫기, Compact, 제거.
- hover는 `pointerType === 'mouse'`만. 루트 pointerleave가 hot을 지운다. 셀 hover = 그 셀의 부분 hot.
- Compact는 `compact`가 있고 `locked`가 아닌 부분 행에만, 다른 compact 진행 중·토큰 0·이미 압축됨이면 disabled.
  `onCompact` 없으면 부분이 스스로 기본 0.3배로 줄어든다(데모용 가짜 축소).

### 1.4 모션

| 무엇 | 수치 | 감속 |
|---|---|---|
| 셀 색 변화(채움·비움) | background 380ms, delay `i × 2ms`(왼→오 sweep) | ease |
| hot 흐림 / 들림 | opacity 220ms · scale 1.12 300ms | `cubic-bezier(.32,.72,.24,1)` |
| shimmer wave | 900ms 무한, delay `i × 15ms`, 50%에서 opacity .28 · scale .72 | ease-in-out |
| 숫자 롤 | 640ms, `1−(1−p)^4`, 위·아래 양방향 | — |
| 행 hot 배경 / dim | 160ms / 220ms | ease |
| fold | grid-rows 420ms + opacity 240ms(열 때 320ms, 80ms 지연); 항목 240/180ms | 위 곡선 |
| caption swap | in 320ms(opacity 0·blur 2px →), out 220ms, 260ms 뒤 제거 | ease |
| Compact 완료 | ✓ 1.5s 유지 → leave 400ms(opacity 0 · blur 3px · scale .92) | 위 곡선 |
| 스피너 | 700ms linear | — |
| reduced-motion | 모든 animation·transition 없음, 숫자 즉시 | — |

### 1.5 토큰 · 타이포

색 역할: tray·card·line·ink·text·muted·well·free, 부분색 c1–c6(무채 3 + 파랑 2 + 회색 1, 순환), warn(호박)·warn-bg, full(빨강)·full-bg,
ok(초록)·ok-bg, focus 링. 다크는 `.dark`/`[data-theme=dark]` 조상에서 전환. 숫자: Inter 13/20; big 24px/600, lh 30, -0.02em,
tabular; of·pill·caption 12.5px; 셀 gap 2px, 정사각, 반경 26%; 행 최소 30px; Compact 높이 22 반경 7 12px; action 높이 26 반경 10.

### 1.6 반응형

컨테이너 최대 360px(`container-type: inline-size`). 310px 미만: 열 `max(8, round(cols×2/3))`=24, 모델 태그 최대 42%, Compact 아이콘만.
`pointer: coarse`: 행 38, Compact 30, 항목 34, 제거 30, action 30.

### 1.7 접근성

group + 제목 이름; 롤링 숫자 aria-hidden, sr 한 문장 "88.0K of 200K tokens used, 44 percent"; 필드는 장식(모든 수치가 목록에 있음);
items 행은 `aria-expanded`+`aria-controls`, 닫힌 목록 inert; 제거 버튼 "Remove <label>"; Compact "Compact <label>" / "<label> is compacted";
caption이 polite live(압축 중·절약량·남은 양 — hot 문장도 같은 영역).

### 1.8 데이터 계약 (props)

`parts: {id,label,tokens?,items?,locked?,compact?,color?}[]`(순서대로 채움; items면 합계가 tokens) · `limit` · `title`("Context window") ·
`model` · `modelIcon` · `onRemoveItem(partId,itemId)` · `onCompact(partId) → void|Promise` · `action {label,onClick}` · `warnAt`(0.8) ·
`cells`(216) · `columns`(36). 토큰은 세지 않는다(공급자 수치를 받는다). 비-빈 부분은 최소 1셀.

## 2. 변경 전 [CODE] (main `ff6c9ac`, 캡처 `harness/shots-context-window/before-context-window-*`)

| 무엇 | 증거 |
|---|---|
| 세션 정보(펼침)의 컨텍스트 = 4px 막대 하나 + "컨텍스트 41% · autocompact 750.0K" 한 줄. 무엇으로 찼는지, 어디서 압축되는지 위치가 없다 | `dashboard.ts:9241-9245`(`panelInfoHtml`), CSS `:3977-3981` |
| 막대 위 격자 `입력/출력/캐시 읽기/캐시 쓰기`는 **세션 누적**(2.8M 등)인데 라벨에 그 말이 없다 — 현재 컨텍스트로 읽힌다 | `:9233-9238`, `tokenUsageOf` `:1273-1297` |
| 요청 단위 현재 토큰(`currentInput/Output/CacheRead/CacheCreate`, `contextWindow`)은 서버에만 있고 합계 %만 보낸다 | `types.ts:83-88`, `tokenUsageOf` `:1288-1295`, `modelFields` `:1300-1312`(`contextTokens`=합계) |
| 압축 직후 4개 카운터는 분류가 아니라 `post_tokens` 총량 하나를 `currentInputTokens`에 담은 **점유 인코딩**이다 | `packages/slack/src/session-usage-math.ts:72-101`, `stream-executor.ts:2252` |
| 단계는 창 % 구간(60 경고 / 80 위험). 그러나 세션은 그 전에 압축된다 → Claude 세션에서 위험 단계는 도달 불가 | `ctxLevel` `:8124-8129`; 표 §2.1 |
| face ctx 메트릭: `◔ 41%` + 단계 class, title "Context window used[ — 80% 넘게 찼다]" | `renderCardFace` `:8170-8175`, CSS `:3755-3761` |
| 요약 줄 "ctx 41%"(단계 없음) | `:9218` |
| `.card .context-bar*` CSS는 카드가 더는 그리지 않는 죽은 규칙(spec 13) | `:3972-3976` |
| 압축 진행·결과(`compactPreTokens/PostTokens`, `autoCompactPending`)는 카드 payload에 없다 | `types.ts:728-743`; `sessionToKanban` `:1404-1470` |
| 패널 너비 기본 440px(320–50vw) → 세션 정보 본문 ≈408px, 폰 358px, 최소 288px | `:4549`, `:5904`, resize `:6394-6398` |

### 2.1 단계 기준 — 창 %가 아닌 autocompact 지점이어야 하는 근거

| 프로필 | 창 | autocompact | 창 대비 | 60/80 구간에서 |
|---|---|---|---|---|
| `claude-*[1m]` (opus·fable·sonnet) | 1,000,000 | 750,000 (`model-profile.ts:299-331`) | 75% | 위험(>80) 도달 불가, 경고는 60–75% 구간뿐 |
| 200K 모델(legacy % 기본 80) | 200,000 | 160,000 (`autocompact-policy.ts:156-158`, `user-settings-store.ts:468`) | 80% | 위험 도달 불가 |
| `gpt-5.6-sol[1m]` | 1,000,000 | 600,000 (`model-profile.ts:112`) | 60% | 경고 = 이미 압축 |
| `gpt-5.6-sol` / `gpt-6-astra` | 372K / 272K | 340K / 240K (`:211-264`) | 91% / 88% | 정상 |

창 %는 "얼마나 찼나"의 숫자로 맞지만, 경고는 "곧 압축된다(기록이 요약으로 줄어든다)"를 말해야 한다. 그 지점은 세션마다 다르고
(`resolveEffectiveAutoCompact` `:135-159`: 세션 override → 모델 → legacy %), 서버가 이미 `autoCompactTokens`로 보낸다. 미리보기 고정값
`conv-run2`는 창 76%로 호박색이지만 autocompact 160K의 475% — 지금 단계는 틀린 신호를 준다(캡처 `…-conv-run2-info.png`).

### 2.2 Compact 경로 조사 — 실제·소유자 한정 경로가 있다

`POST /api/dashboard/session/:key/command {message}` (`dashboard.ts:2554-2580`) — authMiddleware + CSRF + `resolveSelfActionKeyAndOwner`
(`:621-627` → `requireSessionOwner` `:832-840`, 소유자 또는 admin-mode, 아니면 403) → 호스트 `injectDashboardMessage`(`src/index.ts:760-833`:
스레드에 "via Dashboard" 에코 후 **소유자 이름으로** `slackHandler.handleMessage`) → `CommandRouter` → `CompactHandler`
(`src/slack/commands/compact-handler.ts:25-27`, `command-parser.ts:699-711` `^/?compact(\s+--yes)?$`). `compact --yes`는 확인 없이
`continueWithPrompt: '/compact'`(SDK 내장 압축, `:89-92`); 그냥 `compact`는 Slack 예/아니오 블록을 띄운다(`:53-87`). 턴이 도는 중이면
follow-up 큐에 들어가 턴 뒤에 실행된다(`slack-handler.ts:1156-1192`, `isQueueableFollowup` `:2632`). **모델 전환이 이미 같은 경로를 쓴다**
(`index.ts:851-858` `dispatchCompact → injectDashboardMessage(key, 'compact --yes')`). 압축 경계에서 `compactionCount++` + broadcast
(`stream-executor.ts:2200-2201`), 그 직후 `compactPre/PostTokens` 기록(`:2222-2224`). → **채택**(D12).

## 3. 차이표

| 레퍼런스 요소 | 현재 | 결정 | 근거 / 데이터 출처 |
|---|---|---|---|
| 셀 필드 216 / 36열, 셀 = limit/cells, 비-빈 부분 ≥1셀 | 4px 막대 | **채택** | `contextParts`(D1) ÷ `window` |
| 부분 = 내용 분류(System·Tools·Files·Conversation·Memory) | 없음 | **변형** — 캐시 분류 4개 | SDK가 주는 것은 요청의 캐시 분류뿐(`types.ts:83-88`); 내용 분류는 지어내야 한다 |
| 부분 목록 swatch · label · tokens | 누적 격자 | **채택** | D6 |
| items 있는 부분 펼침 · 항목 × 제거 · "Nothing attached" | — | **불채택** | 파일·항목 단위 토큰 귀속 데이터 없음, 컨텍스트에서 떼어낼 경로 없음 |
| big 롤링 숫자 "88.0K of 200K tokens" + % pill | "컨텍스트 41%" 한 줄 | **채택** | `contextTokens`·`window`·`contextUsagePercent` |
| warnAt 0.8 호박 / ≥0.95 빨강 | 창 60/80 | **변형** — 같은 0.8/0.95를 **autocompact 지점**에 | §2.1; 지점 모르면 기존 창 60/80 유지 |
| 한계선 = limit | autocompact 숫자만 | **추가** — 필드 위 autocompact 지점 표시 + 범례 행 | `autoCompactTokens`(`:1304`) |
| hover ↔ 셀 하이라이트, 나머지 흐림, big·of가 부분으로 | — | **채택**(caption은 그대로) | 장식 연결; live 영역 소음 회피(D11) |
| 부분 행의 Compact, shimmer, ✓ Compacted | — | **변형 채택** — 블록 하나의 "지금 압축" | 압축은 대화 전체에 작용(부분별 아님); 경로 §2.2 |
| `onCompact` 없을 때 0.3배 가짜 축소 | — | **불채택** | 수치 위조 |
| tray "Saved 78.2K tokens" | — | **채택** | `lastCompact.preTokens − postTokens`(D4) |
| tray "X free / X left / Window is full" | — | **변형** | 남은 양 = autocompact까지; `compactPending`이면 "다음 입력 때 자동 압축"(D3, D10) |
| action "New chat →" | — | **불채택** | 새 세션은 보드의 새 작업(FAB); 스레드 세션 리셋(`/new`)은 컨텍스트 패널의 결정이 아님 |
| model 태그 + 로고 | 컴포저에 모델명 | **변형** — 텍스트 태그만 | 모델 로고 자산 없음; 창 크기가 모델을 따르니 태그는 유지 |
| 트레이 + 카드 이중 면, 반경 20/16 | 평평한 패널 섹션 | **변형** — 평평한 블록 + foot 구분선 | 패널은 면 하나(Bauhaus), 중첩 카드 금지 |
| 컨테이너 쿼리 310px | — | **채택** + 넓은 패널 54열 | D14 |
| 롤링 숫자 양방향 640ms | 카운트업은 위로만 900ms(`:7175-7203`) | **채택**(별도 롤러) | 압축 뒤 숫자가 내려가야 한다 |

## 4. 계약 (TO-BE)

### 4.1 서버 — `KanbanSession`에 필드 추가 (`sessionToKanban`, 살아 있는 세션만; archived는 없음)

- **D1** `contextParts?: { window; cacheRead; cacheWrite; input; output; unsplit? }` — `s.usage.contextWindow > 0`일 때만,
  `currentCacheReadTokens / currentCacheCreateTokens / currentInputTokens / currentOutputTokens`(유한·음수 아님, 아니면 0). 합 =
  `contextTokens`, 합/window×100 = `tokenUsage.contextUsagePercent` — 출처 하나(커밋된 표본; 진행 중 턴의 live 호출은 접지 않음 §6).
- **D2** `unsplit`: cacheRead = cacheWrite = output = 0 이고 input > 0 이면 — `s.compactPostTokens`가 유한수이고 input과 같으면 `'compact'`
  (점유 인코딩, `session-usage-math.ts:72-101`), 아니면 `'unknown'`. 그 밖에는 없음.
- **D3** `compactPending?: true` — `s.autoCompactPending === true`(다음 사용자 턴이 `/compact`로 시작, `compact-threshold-checker.ts:1-16`).
- **D4** `lastCompact?: { preTokens; postTokens; trigger? }` — `compactPreTokens`·`compactPostTokens`가 둘 다 유한수일 때(경계 메타,
  `stream-executor.ts:2222-2225`; 다음 주기 시작에 null `compact-hooks.ts:64-80`; 런타임 전용 — 재시작 뒤 없음). trigger는 `manual|auto`일 때만.

### 4.2 마크업 (`panelInfoHtml` 펼침 본문 맨 앞, `contextParts`가 있을 때만; 기존 `.pi-ctx` 막대·문장 삭제)

- **D5** `<section class="cw" role="group" aria-labelledby="cw-title" data-level="ok|warn|full">` ⟶
  `.cw-head`(`#cw-title` "컨텍스트" · `.cw-model` 모델 짧은 이름 — 기존 `replace(/^claude-/…)` 규칙) · `.cw-figure`(`.cw-big[aria-hidden][data-to]`
  · `.cw-of[aria-hidden]` · `.cw-pill[aria-hidden]` · `.cw-sr`) · `.cw-field[aria-hidden]`(셀 `<i class="cw-cell" style="--i:N;--c:…"
  data-part=…>` × 216) · `ul.cw-parts`(`li.cw-part[data-part]` = `i.cw-sw` · `.cw-label` · `.cw-val`; 마지막 `li.cw-mark`) ·
  `.cw-foot`(`.cw-say[aria-live=polite]` · `button.cw-compact`). 새 함수는 열 0 선언·단일 정의: `cwParts`, `cwCells`, `cwMarkIndex`,
  `cwShort`, `cwSay`, `cwHtml`, `cwCompactHtml`, `cwApply`, `cwRoll`, `cwCompact`, `cwObserve`.
- **D6** 부분(순서 = 프롬프트 순서: 캐시된 앞부분 → 새로 캐시 → 캐시 밖 꼬리 → 응답). 0인 부분은 목록·필드에서 뺀다.

  | key | 출처 | 라벨 | 색 토큰 |
  |---|---|---|---|
  | `read` | cacheRead | 이전 맥락 (캐시 읽기) | `--cw-c1` |
  | `write` | cacheWrite | 새로 캐시 (캐시 쓰기) | `--cw-c2` |
  | `input` | input | 캐시 안 된 입력 | `--cw-c3` |
  | `output` | output | 마지막 출력 | `--cw-c4` |
  | `total` (unsplit) | input | `'compact'` → 압축 후 맥락 · `'unknown'` → 맥락 (분류 없음) | `--cw-c1` |
- **D7** 필드: `CW_CELLS = 216`, 셀 = window/216 토큰. 할당은 누적 반올림 `end = min(216, max(start + (t>0 ? 1 : 0), round(cum / perCell)))`
  — 비-빈 부분 ≥1셀, used > window면 전부 칠함. autocompact 지점 `m = cwMarkIndex(auto, window)` = `round(auto / perCell)`(0–216으로 자름,
  auto ≤ 0 또는 ≥ window면 없음): index ≥ m 인 셀은 `data-past` — 빈 셀은 속이 빈 칸(1px 안쪽 링), 칠한 셀은 색 + 링. 1M·750K → m=162
  (36열에서 마지막 1.5행). 범례 행 `.cw-mark`: 빈 칸 견본 · "자동 압축 지점" · `cwShort(auto)`.
- **D8** 숫자: big = `formatTokens(used)`, of = `'/ ' + cwShort(window) + ' 토큰'`(`cwShort` = formatTokens에서 `.0K/.0M` 제거),
  pill = `Math.round(min(contextUsagePercent,100)) + '%'` — face·요약 줄과 같은 수. sr = "컨텍스트 412.0K / 1M 토큰 사용, 41%, 자동 압축 750K".
- **D17** 누적 격자 라벨: `누적 입력 · 누적 출력 · 누적 캐시 읽기 · 누적 캐시 쓰기`(현재 요청 부분과 구분). 블록 다음, Σ 줄 앞.
- **D18** 삭제: `.pi-ctx` 마크업·CSS(`:3977-3981`, `:4869`). `.card .context-bar*`는 그대로(§6).

### 4.3 단계

- **D9** `ctxLevel(pct, used, auto)` 확장(기존 1-인자 호출 유지): used > 0 && auto > 0 → f = used/auto, `f ≥ 0.95` → `ctx-danger`,
  `f ≥ 0.8` → `ctx-warn`, 아니면 `''`; 그 밖은 기존 창 구간(>80 / >60). `compactPending` → `ctx-danger`. `data-level`: '' → ok,
  warn → warn, danger → full. face 메트릭·요약 줄 `ctx N%`(span에 같은 class)·블록이 이 함수 하나를 쓴다.

### 4.4 tray 문장 (`cwSay`, 우선순위 위에서 아래)

- **D10** ① 로컬 압축 중: 일하는 세션 "턴이 끝나면 압축합니다", 아니면 "압축 중…" ② 무장(D12) "한 번 더 누르면 압축 — 지난 대화가 요약으로
  줄어듭니다" ③ 압축 관찰 후 3200ms(`lastCompact` 있을 때, ok 톤) "압축 · **748K** 줄임 (812K → 64K)" ④ `compactPending` "다음 입력 때
  자동 압축" ⑤ auto 앎: used ≥ auto "자동 압축 지점을 넘음", full "자동 압축 임박 · 30K 남음", 그 밖 "자동 압축까지 338K"(warn은 호박)
  ⑥ auto 모름: "창에 588K 남음". 실패(D12) "압축 요청 실패"(빨강, 4s). 문장 교체 in 320ms / out 220ms.

### 4.5 hover 연결

- **D11** 마우스(`pointerType === 'mouse'`)가 부분 행 또는 칠한 셀 위 → `_cwHot = key`: 필드 `data-hot`, 그 부분 셀 `data-on`, 다른 칠한 셀
  opacity .22(빈 셀 그대로), 다른 행 `data-dim`(.55), 그 행 배경 `--ib-pill`. big은 부분 토큰으로 롤, of는 "<라벨> · 창의 N%"(10% 미만 소수 1자리).
  블록을 떠나면 해제. 상태는 매 `writePanelPart` 뒤 `cwApply`로 다시 건다(morph가 속성을 지운다 `:8680-8687`). caption은 바꾸지 않는다.

### 4.6 지금 압축 (채택)

- **D12** `button.cw-compact` "지금 압축" → `POST /api/dashboard/session/<key>/command {"message":"compact --yes"}`(CSRF 헤더, 403이면 토큰
  갱신 후 1회 재시도 — `sendCommand` 패턴 `:13075`). 보임: `contextParts` 있고 used > 0, 종료 안 됨. 비활성(+title): 소유자 아님
  (`READ_ONLY_MSG`), 다른 인스턴스(`isSiblingSession` — "Open <instance> …"), `pendingModel`("모델 전환이 압축을 기다리는 중"),
  `compactPending`("다음 입력 때 자동 압축됩니다"). **두 번 누름**: 첫 누름은 무장(라벨 "한 번 더 눌러 압축", 4000ms, Esc·blur·시간 초과로 해제),
  두 번째가 보낸다 — Slack의 그냥 `compact`가 예/아니오를 묻는 것과 같은 확인 한 번(`compact-handler.ts:53-87`), 모달 없음.
  진행: 스피너 + "압축 중", `aria-busy`, 칠한 셀 전부 `data-busy`(wave). 끝: 이 세션 `compactionCount`가 누름 시점보다 커지면(`cwObserve`) →
  ✓ "압축됨"(ok) 1500ms → leave 400ms; 이후 `contextTokens ≤ lastCompact.postTokens`인 동안 버튼 숨김. POST 실패 → 해제 + D10 실패 문장.
  상한 300000ms → 해제 + "압축 결과를 아직 받지 못함". 다른 경로(자동·Slack)의 압축도 `compactionCount` 증가로 ③을 띄운다.

### 4.7 모션 (dashboard 토큰; 새 수치는 아래뿐)

- **D13** 셀 색 `transition: background-color 380ms var(--ease-out)`, delay `calc(var(--i) * 2ms)`(최대 ≈430ms) — morph가 같은 216 노드를
  유지하므로 live 갱신이 sweep으로 보인다; 흐림 opacity 220ms; 들림 scale 1.12 `var(--dur-move) var(--ease-out)`; wave 900ms 무한,
  delay `i × 15ms`, 50% opacity .28 · scale .72; 숫자 롤 `CW_ROLL_MS = 640`, `1−(1−p)^4`, 양방향(`canAnimate()` 거짓·reduced면 즉시);
  행 배경 `var(--dur-press)`, dim 220ms; tray swap 320/220ms; 완료 hold 1500ms + leave 400ms. reduced-motion 블록(`:5126`)에
  `.cw-cell[data-busy] { animation: none; opacity: .5 }`(정지 상태로 진행을 보임), 스피너 정지 링.

### 4.8 반응형

- **D14** `.cw { container: cw / inline-size; max-width: 560px }`. 기본 36열(6행); `@container cw (max-width: 309px)` → 24열(9행), 모델 태그
  최대 42%, 압축 버튼 아이콘만(이름은 aria-label에); `@container cw (min-width: 520px)` → 54열(4행). gap 2px, 정사각, 반경 2px.
  기본 패널 408px → 셀 ≈9.4px, 폰 358px → ≈8px, 최소 288px → 24열 ≈10px. 터치 블록(`:5187`)에 `.cw-compact { min-height: 44px }`.

### 4.9 접근성 · 테마

- **D15** group + `#cw-title`; 롤링 숫자·of·pill aria-hidden, `.cw-sr`(새 sr-only 규칙) 한 문장; 필드 aria-hidden; 부분은 `<ul>` 텍스트; `.cw-say`
  polite live(hover 문장은 넣지 않음); 버튼 `type=button`, `aria-label="지금 압축 — 컨텍스트 압축"`(보이는 라벨 먼저), focus-visible `--accent` 링.
  단계는 색만으로 말하지 않는다(tray 문장). 텍스트 대비 ≥4.5:1: warn `--cw-warn`(다크 `--st-wait`, 라이트 `--yellow` #a16207 — `--st-wait` 라이트는
  흰 바탕 4.5 미만 `:3755-3759`), full `--st-fail-text`, ok `--green`.
- **D19** 토큰(`:root` + `[data-theme="light"]` 둘 다): `--cw-c1: var(--accent)`, `--cw-c2: color-mix(in srgb, var(--accent) 45%, var(--ib-pill))`,
  `--cw-c3: var(--purple)`, `--cw-c4: var(--green)`, `--cw-free: var(--ib-pill)`, `--cw-warn`, `--cw-warn-bg`(호박 .14), `--cw-full-bg`(빨강 .1).

### 4.10 카드 face · 요약 줄

- **D16** face ctx 메트릭 = `ctxLevel(pct, s.contextTokens, s.autoCompactTokens)`(+ `compactPending` → danger). title: auto 앎 → "컨텍스트 41% ·
  자동 압축 750K까지 338K" / pending "… · 다음 입력 때 자동 압축" / 넘음 "… · 자동 압축 지점을 넘음"; auto 모름 → 기존 문구 그대로
  ("Context window used", "— 80% 넘게 찼다"). 세션 정보 요약 줄 `ctx N%`는 같은 class의 span.
- **D20** live: 기존 `repaintPanelSession → renderPanelInfo → writePanelPart` 그대로; `renderPanelInfo`가 쓴 뒤 `cwApply`(hover·롤·압축 상태 복원,
  `cwObserve`로 `compactionCount` 비교). 블록 상태(`_cwHot`, `_cwState{key,armedAt,busySince,countAtPress,doneAt,savedAt}`)는 패널 세션이
  바뀌면 초기화.

## 5. 시험 (`src/conversation/__tests__/dashboard-affectui-context-window{,-client}.test.ts`)

| # | D | 내용 | 변경 전 |
|---|---|---|---|
| S1 | D1 | GET /sessions: current* → `contextParts` 4값 + window; 합 = `contextTokens`; % 일치; usage 없음·window 0·archived → 없음 | RED |
| S2 | D2 | post_tokens 인코딩(input = compactPostTokens, 나머지 0) → `'compact'`; 나머지 0·불일치 → `'unknown'`; 정상 분류 → 없음 | RED |
| S3 | D3·D4 | `autoCompactPending` → `compactPending: true`; pre/post 둘 다 수일 때만 `lastCompact`(+trigger) | RED |
| C1 | D5·D6·D18 | 블록 마크업·부분 순서·라벨·0 부분 생략·unsplit 라벨; `contextParts` 없으면 블록 없음; `.pi-ctx`/`context-bar` 사라짐 | RED |
| C2 | D7 | `cwCells`: 216칸, 비-빈 부분 ≥1, 누적 반올림, 넘침 처리; `cwMarkIndex(750000, 1e6)` = 162; `data-past` | RED |
| C3 | D8·D9 | `ctxLevel(pct, used, auto)` 0.8/0.95, 1-인자 60/80 유지, pending → danger; pill = face %; `data-level`; `cwShort` | RED(기존 1-인자 GREEN) |
| C4 | D10 | `cwSay` 상태별 문장(①–⑥, 실패) | RED |
| C5 | D11·D20 | 가짜 DOM에 hover → data-hot/on/dim, of 문장; 다시 쓴 뒤 `cwApply`가 복원 | RED |
| C6 | D12 | 게이팅(소유자·sibling·종료·pendingModel·compactPending), 무장 4s·Esc, fetch URL·body `compact --yes`·CSRF 재시도, compactionCount 증가 → 완료, 실패·상한 | RED |
| C7 | D13·D14·D15·D19 | CSS 계약: `@container cw` 24/54열, reduced-motion에 `.cw-cell[data-busy]`, aria 속성, 토큰 다크·라이트 둘 다, 터치 44px | RED |
| C8 | D16 | face title·class(auto 앎 / pending / 모름 → 기존 문구) | RED |
| C9 | D17 | 누적 라벨 | RED |

의도적으로 고칠 기존 단언: `dashboard-three-surfaces-client.test.ts:583-602`(`class="context-bar"` → 블록), `:1408-1409`(`var cls = ctxLevel(ctx);`),
`:560-561`(로더 함수 목록에 cw* 추가), `dashboard-agent-inbox.test.ts:463`(`panelInfoHtml`의 `transform:scaleX(` → 필드). 시각 확인: 미리보기
34104, 세션 정보 펼침(라이트·다크 × 데스크톱·폰), 고정값 사본에 `compactPostTokens`·`autoCompactPending`·`lastCompact` 사례 추가.

## 6. 범위 밖 · 후속

- **진행 중 턴의 점유**: 블록·face %는 커밋된 표본(`current*`)이다. 턴 중 live 호출이 더 클 수 있다(`model-switch.ts:122-127`, `live-usage.ts`).
  `max(committed, live)`를 서버 한 곳에서 face·패널에 같이 — 후속.
- **자동 압축 진행 중 shimmer**: 시작 신호에 broadcast가 없고(`compact-hooks.ts:442`), 경계 broadcast(`stream-executor.ts:2201`)가 메타 기록(`:2222`)
  보다 먼저라 `compactStartedAtMs`로는 "압축 중"을 정직하게 끌 수 없다. 이번엔 대시보드에서 누른 압축만 진행을 그린다 — 후속: 시작 broadcast + 경계 순서.
- 내용 분류(시스템 프롬프트·도구·파일·대화)와 항목 제거, New chat — 데이터·경로 없음(§3).
- 세션 정보 Σ 줄의 "압축 N"은 세션 값(`compactionCount`)인데 줄은 스레드 합계다(`threadCompactionCount`는 보내지만 안 씀, `:9246`) — 별건.
- `.card .context-bar*` 죽은 CSS(`dashboard-agent-inbox.test.ts:460`이 고정) 정리 — 별건. autocompact 출처(session/model/legacy) 표시 — 데이터 미전송.

# re-agent-inbox — affectUI Agent Inbox → 세션 보드의 남은 차이

Status: Phase A(계약, 구현 전) · Date: 2026-10-26 · 기준 main `ff6c9ac` · 이슈 #438 (에픽 #437) · 브랜치 `feat/dashboard-affectui-agent-inbox`
SSOT: [`ssot.md`](ssot.md) · 앞선 계약: [`../10-agent-inbox-board-spec.md`](../10-agent-inbox-board-spec.md) §3.1·§4·§5,
[`../13-dashboard-three-surfaces-spec.md`](../13-dashboard-three-surfaces-spec.md) §3.2·§3.7

증거 라벨: **[REF]** = affectui.com/components/agent-inbox(문서 청크 `docs-D_d0RPGD.js`, 컴포넌트 CSS `RE-css.txt`, 데모 번들
`demo-Bq86T0RX.js`, 캡처 `components_agent-inbox-{light,dark}-t1/t2.png`, 2026-10-26) · **[CODE]** = `src/conversation/dashboard.ts:줄`
(따로 적지 않으면 이 파일) · **[SHOT]** = 프리뷰 하네스 실측 · **[SHIPPED]** = 구현 후 표시.
라이선스: Pro 항목이다. 코드·CSS 문장·SVG 경로는 옮기지 않는다. 아래 수치는 판독한 사실만 인용한다.

## 0. 한 줄 정의

Agent Inbox는 백그라운드 실행 여러 개 가운데 **무엇이 나를 기다리고, 무엇이 돌고, 무엇이 끝났나**를 차분한 보드 하나에서 고르게 하고,
카드를 그 자리에서 펼쳐 지금 할 수 있는 결정 하나를 준다. 대시보드의 세션 보드(`#inbox`)는 이미 이 구조다(.prd/10 — 세 칸 ·
Board|List · FLIP · 펼침 카드). 이 문서는 **남은 차이**만 다룬다: 상태 태그, "상태 먼저, 이동은 나중", 낭독, Esc, 카드당 주 버튼 하나.

## 1. 레퍼런스 해부 [REF]

![ref](assets/ref-agent-inbox.jpg)

### 1.1 구조

```
루트(tray 반경 20, 안쪽 4, inline-size 컨테이너, data-view=board|list, keydown=Esc)
├─ 바: "Agents / {title}" · [action 버튼] · Board|List (radiogroup, 아이콘+라벨)
├─ 칸 3개 (grid 3열, 간격 4) — section[aria-label] Needs you · Running · Done
│  ├─ 머리 32px: spark · 이름 13/600 · 개수 pill(최소 20px, 11.5px)
│  └─ ul > li 카드[data-status][data-open] | li "Nothing here"
│     ├─ button 본문[aria-expanded][aria-controls] (컨테이너 ai-card)
│     │  ├─ 제목 줄: 상태색 spark 16px · 제목 14/600 한 줄
│     │  ├─ 설명 13/19, 2줄 말줄임, 왼쪽 26px 들여쓰기
│     │  └─ 바닥: 상태 태그 [아이콘 · 단어 · 시계] … 메타 [sources | tools] (1px 구분선, 좌우 9px)
│     └─ 접힘 영역[inert(닫힘)] > 위쪽 1px 선
│        ├─ agent(모델명, 12.5 흐림)
│        ├─ ol 단계: 최근 4개, 오래된 것부터. 점 6px · 1px 연결선 · 마지막 점만 잉크 · 시각 오른쪽("2m ago")
│        └─ 버튼 줄(오른쪽 정렬, 간격 6): waiting Reject + Approve(주) · failed Retry(주) · running/done Open
└─ 시각 숨김 live region(aria-live=polite): "N need you, M running"
```

### 1.2 상태

| status | 칸 | 색 역할 | 태그 내용 | 버튼 |
|---|---|---|---|---|
| waiting | Needs you | 호박(warn) | ▲ `Waiting for you · 6m 12s` | Reject · **Approve** |
| failed | Needs you | 빨강(danger) | ❗ `Failed` (시계 없음) | **Retry** |
| running | Running | 파랑(brand) | 도는 링 `Running · 3m 49s` | Open |
| done | Done | 초록(ok) | ● `Done in 6m 48s` | Open |

- 칸 = waiting·failed → Needs you, running → Running, 나머지 → Done. 칸 안 순서는 입력 순서.
- 시계: 60초 미만 `Ns`, 60분 미만 `Nm SSs`, 그 이상 `Nh MMm`. 실행·대기 카드가 있을 때만 1초 틱. running·waiting은 `startedAt`부터, done은 `elapsed`.
- 핸들러가 있으면 보드는 스스로 상태를 바꾸지 않는다(aiNotes) — 상태는 호출자 데이터만 따른다.

### 1.3 상호작용·키보드

- Tab = 보기 전환 → 카드 → 열린 카드 안 버튼. Enter·Space = 카드 열고 닫기, 버튼 누르기. 열린 카드는 하나.
- **Esc = 열린 카드를 닫고 포커스를 그 카드 버튼에 돌려준다**(루트 keydown, `stopPropagation`, `preventScroll`).

### 1.4 모션

| 대상 | 수치 |
|---|---|
| 상태 변경 | 새 상태를 **제자리에서 먼저** 보이고, **900ms 뒤** 새 칸으로 이동(reduced-motion이면 0ms) |
| 칸 이동(FLIP) | 560ms `cubic-bezier(0.32, 0.72, 0.24, 1)`, 나는 동안 z-index 2. 새 카드 = opacity 0 + `translateY(6px)` → 380ms |
| 펼침 | `grid-template-rows 0fr→1fr` 460ms `cubic-bezier(0.22, 1, 0.36, 1)`; opacity 닫힘 240ms / 열림 320ms(지연 100ms) |
| 상태 아이콘 | 바뀔 때 `scale(0.6)`·opacity 0 → 1, 360ms |
| 실행 링 | 900ms linear 회전 |
| 보기 전환 | 칸 묶음 opacity 0.4 → 1, 320ms |
| 동작 줄이기 | 모든 animation·transition 없음 |

### 1.5 토큰

- 상태 태그: 높이 24 · 안쪽 `0 10 0 8` · 반경 999 · 12.5px/500 · tabular · 아이콘 12px. 틴트(라이트 bg/fg): brand `#eaf1ff/#2456d6`,
  warn `#fff3e0/#b85c00`, ok `#e6f6ec/#1a7f45`, danger `#fdecea/#c2331f`. 다크: `#16243f/#8ab4ff`, `#3a2410/#ffa057`, `#12301f/#3dd68c`, `#3b1714/#ff977d`.
- 카드 반경 16, 안쪽 `14 14 12`, 행 간격 6. 버튼 32px · 반경 10 · 13.5/500; 주 = 잉크 바탕·카드색 글자, 보조 = 카드 바탕 + 1px 선.

### 1.6 반응형

- 루트 폭 ≤ 620px: 한 열(목록), 보기 전환 숨김 — 300px까지.
- 카드 본문 폭 ≤ 300px: 설명·바닥 들여쓰기 0, **상태 단어 숨김(failed 제외)**. 루트 ≤ 360px: 제목 줄바꿈.
- `pointer: coarse`: 보기 전환 34px, 버튼 40px(좌우 18). 다크: 조상 `.dark`/`[data-theme="dark"]`.

### 1.7 접근성

칸 = 이름 붙은 section · 카드 = button `aria-expanded`(+`aria-controls`), 닫힌 내용 `inert` · Board/List = radiogroup(`aria-checked`) ·
polite live region "N need you, M running"(N = waiting + failed, M = running).

### 1.8 데이터 계약

`AgentTask { id, title, description?, agent, status: running|waiting|done|failed, startedAt?, elapsed?, tools?, sources?, steps?: {label, time?}[] }`;
`onApprove/onReject/onRetry/onOpen(task)`, `title`, `action {label,onClick}`, `view/defaultView/onViewChange`.

### 1.9 판독 메모 — 렌더와 CSS가 다른 곳

사이트 캡처(스타일 "Clean")의 바닥 상태는 **틴트 배경 없이** 아이콘 + 회색 글자다(픽셀 표본: 태그 자리 = 카드 바탕 `#fff`/`#1e1e21`), 세 칸
spark는 모두 파랑(`#6a94fc`). 컴포넌트 CSS는 틴트 태그와 칸별 spark 색을 준다. 렌더는 ~228px 카드에서 실행·완료 단어를 숨기고 대기 단어는
말줄임으로 보인다(CSS 규칙은 ≤300px에서 failed 외 모두 숨김). 사이트 스타일 변형이 덮는 것으로 본다. 결정: 상태 태그는 **컴포넌트 CSS**
(페이지 설명도 "status tags"), 칸 spark는 **렌더**(= 현재와 같음)를 따른다.

## 2. 변경 전 [CODE] (main `ff6c9ac`)

| 영역 | 현재 | 증거 |
|---|---|---|
| 칸 | `div.kanban-col` ×3, `h3` + `.count`; section·이름 없음 | 6148–6162, CSS 3661–3666 |
| Board / List | `.seg role="group"` + `aria-pressed`, 저장 `soma-board-view`, 뷰포트 <640 기본 List | 6119–6122, `setBoardView` 10223, `defaultBoardView` 10280 |
| 좁은 인박스 | `@container inbox (max-width: 839px)` → 3칸 가로 스크롤 + snap(목록 강제 없음, 토글 유지) | 5025–5034, .prd/10 §5 |
| 카드 셸 | `.card > .card-face[role=button][tabindex=0][aria-expanded]` + `.card-expand[inert]` — **`aria-controls` 없음** | `createCardShell` 7860–7883, `applyExpanded` 7885 |
| 바닥 상태 | `.card-status` = 아이콘 + 글자, **배경 없음**. `Running · `/`Done in `(`.st-prefix`)은 **Board에서 숨김, List만** | `renderCardStatus` 8005–8024, face 8189, CSS 3742–3749·3675 |
| 실행 링 | 2px 테두리 스피너, 트랙 `--ib-pill`, 호 `--st-run`, 0.9s linear | CSS 3749, 동작 줄이기 5137–5139 |
| 메타 | `.card-metrics`: task 완료/전체 · ctx % · 첨부 · PR, 사이 1px 선 | `renderCardFace` 8165–8182, CSS 3750–3752 |
| 상태 변경 | 데이터가 바뀐 **그 렌더에서 바로** 칸 이동 FLIP(320ms `--ease-in-out`, `.is-flying`). 칸 배지 = 데이터 수 | `reconcileBoard` 7610–7664(배지 7653), `applyBoardPlan` 7729–7783, `playFlip` 7803 |
| 상태 아이콘 | face HTML이 바뀌면 통째로 교체, 상태 전환 표시 없음 | `applyCardParts` 7905–7938(`data-state` 7909) |
| 펼친 카드 단계 | task 창(실행 중·질문 대기): 점 + 연결선 + 현재 task 잉크 점 + 오른쪽 `소요 · 툴 N회` | `renderTimeline` 8219, CSS 3984–4001 |
| 버튼 줄 | `.card-foot-bar`: 모델·effort … 오른쪽 Stop/Close/Trash · Slack · **작업 로그(늘 잉크 주 버튼)** | `renderCardBody` 9761–9768, CSS 3876–3877·4015–4037 |
| 질문 답 | 단일 선택: 추천 선택이 잉크(`.card .btn-choice-recommended` 4214) → **작업 로그와 잉크 둘**. 복수 질문 `답변하기` = 보조 버튼 | 9717–9742, `renderMultiChoiceCard` 10899/10915 |
| 권한 요청 | `renderPermissionBlock(s,'card')` — ✅ Approve · ❌ Deny · 💡 Explain (Slack 카드 색, 패널과 공유) | 6515–6549, 9747 |
| 키보드 | 보드는 Enter·Space만. Esc는 문서 핸들러가 패널만 닫는다 | 14831–14838, 13013 |
| 낭독 | 보드 live region 없음(`#inbox` 안 `aria-live` = lifecycle 대화상자 상태뿐) | 6132 |
| 터치 | <640px·coarse 버튼·세그먼트 44px | 5187–5200 |

**[SHOT]** 하네스(포트 34101, 픽스처, `shots-agent-inbox/before-agent-inbox-*`, 1440·390 × light·dark): 1440에서 카드 폭 379px인데
`.st-prefix` = `display:none` · `.card-status` 배경 투명 · 칸 3개 `DIV role=null label=null` · face `aria-controls=null` ·
`#inbox` live region = `lifecycle-status` 하나 · 펼친 카드 3종에서 Esc 후에도 열림(3/3). 소유자 보기의 질문 대기 카드는 추천 선택 +
작업 로그 두 잉크 버튼(fixture는 All Users라 선택이 disabled로 찍힘).

## 3. 차이표

| # | 레퍼런스 요소 | 현재 | 결정 | 근거 (데이터 출처 / 불채택 이유) |
|---|---|---|---|---|
| 1 | 틴트 상태 태그(아이콘 · 단어 · 시계) | 아이콘 + 글자, 배경 없음 | **채택 D1** | 컴포넌트 CSS(§1.9). 톤 = 칸 + `autoResume`(§4 D1) |
| 2 | 상태 단어는 카드 폭으로 숨김(≤300px) | 보기로 숨김(Board 숨김) | **채택 D2** | 1440 보드 카드 379px — 레퍼런스라면 `Done in 4m 12s` |
| 3 | 도는 링 | 테두리 스피너(트랙 `--ib-pill`) | **변형 D3** | 틴트 위에서 트랙이 사라지지 않게 `currentColor` |
| 4 | 상태 아이콘 팝 360ms | 없음 | **변형 D4** | 우리 토큰 `--dur-move` 320ms · `--ease-out` |
| 5 | 상태 먼저, 900ms 뒤 이동 | 즉시 이동 | **채택 D5** | .prd/10 §2.2가 영상에서 관측(1.2s Approve → 2.4s 이동)했지만 출고하지 않았다 |
| 6 | 칸 배지 = 그려진 카드 | 데이터 수 | **채택 D5** | 보류 중 배지·빈 칸 문구가 칸과 어긋나지 않게 |
| 7 | polite live region | 없음 | **채택 D6** | 수 = 보드 데이터의 `waiting`·`working` 버킷 |
| 8 | Esc로 닫고 포커스 복귀 | 없음 | **채택 D7** | — |
| 9 | 카드 `aria-controls` | 없음 | **채택 D8** | — |
| 10 | 칸 = 이름 붙은 section | `div` | **채택 D9** | — |
| 11 | 카드당 주 버튼 하나(= 지금 할 결정) | 작업 로그 늘 잉크 + 추천 선택 잉크 | **변형 D10** | 결정 = 소유자의 질문 답 · 요청자의 권한 응답(`isPermissionRequester`) |
| 12 | Approve/Reject 버튼 모양 | 권한 블록 Slack 색 | 범위 밖 | `renderPermissionBlock`은 패널과 공유 — Agent Run(Approval Card) 서브이슈 몫 |
| 13 | `failed` 상태 · Retry | 없음 | **불채택** | 근거 데이터 없음: 끝난 실패를 나르는 필드가 없다(오류는 자동 재개 대기 `autoResume.reason`뿐, .prd/13 §3.7 미해결) |
| 14 | sources 수 | — | **불채택** | 근거 데이터 없음(읽은 출처를 세지 않는다) |
| 15 | tools 수(face) | task 완료/전체 · ctx % | 유지 | 진행 지표는 task 완료/전체(.prd/13 §3.7). 툴 수는 task 창 `툴 N회`(T7)·패널 트리 `agentRoot.toolCalls` |
| 16 | 단계 시각 `2m ago` | `소요 · 툴 N회` | 유지 | SSOT 10-22 T7 |
| 17 | 끝난 카드의 마지막 단계 | 지시 ↔ 응답 · 산출물 | 유지 | .prd/13 §3.2(task 창은 실행 중·질문 대기만) |
| 18 | agent(모델명) 줄 | 컨트롤 줄 모델 선택 | 유지 | 같은 데이터(`s.model`) |
| 19 | Open(running·done) | 작업 로그(모든 카드) | 유지 | 패널 열기 = Open |
| 20 | ≤620px 목록 강제 · 전환 숨김 | <840 가로 스크롤, <640 기본 List, 토글 유지 | **불채택** | SSOT 2026-10-24(.prd/10 §5) — 저장한 선택을 덮지 않는다 |
| 21 | coarse 34/40px | 44px | 유지 | 이미 더 크다 |
| 22 | radiogroup | `aria-pressed` 그룹 | 유지 | .prd/10 §3.1-2, `dashboard-agent-inbox.test.ts:118` |
| 23 | 설명·바닥 26px 들여쓰기, ≤360 제목 줄바꿈 | 왼쪽 정렬, 제목 한 줄 | 유지 | face에 task·토큰·칩 행이 더 있어 폭이 필요, 소유자 배지 배치(.prd/10 §3.1-3) |
| 24 | 칸별 spark 색 | 셋 다 `--ib-spark` | 유지 | 렌더가 셋 다 파랑(§1.9) |
| 25 | FLIP 560 · 펼침 460 · 진입 translateY | 320 · 240 · scale 0.97 | 유지 | .prd/10 §4 모션 표준 |
| 26 | 반경 16/20 · 제목 14px | 12/14 · 15px | 유지 | .prd/10 출고 모양 |
| 27 | 핸들러 없을 때 보드가 상태를 바꿈 | 서버 상태만 | 불채택 | 레퍼런스 aiNotes도 핸들러가 있으면 바꾸지 않는다 |
| 28 | 바의 `New task` | FAB `.new-task-fab` | 유지 | 기존 진입점 |

## 4. 계약 (TO-BE)

**D1 상태 태그.** 바닥 줄 `<span class="card-status" data-tone="T">`(마크업은 그대로 `.st-icon` + `.st-text`). 톤 `cardTone(s, col)`:
자동 재개 대기(`pendingAutoResume(s,col)`) → `wait` · `waiting` → `wait` · `working` → `run` · `idle` → `done` · `closed` → `rest`.
CSS: `inline-flex`, 높이 24px, 안쪽 `0 10px 0 8px`, 반경 999px, 12.5px/500, gap 6px, `flex: 0 1 auto`, `max-width: 100%`, 말줄임
(메트릭은 `margin-left:auto`로 오른쪽, 좁으면 기존처럼 다음 줄). 배경·글자 = 새 토큰, `.st-ago`(`· 12m ago`)도 태그 안 같은 색.

| 토큰 | 다크 bg / fg (대비) | 라이트 bg / fg (대비) |
|---|---|---|
| `--st-run-bg/-fg` | `#1d2a47` / `#a3bdff` (7.7:1) | `#e8eeff` / `#2453c7` (5.8:1) |
| `--st-wait-bg/-fg` | `#3a2a12` / `#ffb35c` (7.8:1) | `#fff1dc` / `#8f5300` (5.5:1) |
| `--st-done-bg/-fg` | `#14301f` / `#5fd68e` (7.8:1) | `#e3f5e9` / `#136c39` (5.7:1) |
| `--st-rest-bg/-fg` | `#2f2f35` / `#b4b4bb` (6.5:1) | `#efefef` / `#555558` (6.5:1) |

아이콘 색은 지금처럼 `--st-color`(카드 `data-state`), 자동 재개 시계는 `--st-wait`. `:root`와 `[data-theme="light"]`에 둘 다 둔다.

**D2 상태 단어.** `.st-prefix`(`Running · `, `Done in `)는 두 보기 모두 기본으로 보인다. `.card-face { container: cardface / inline-size }`,
`@container cardface (max-width: 300px) { .st-prefix { display: none } }`(내용 폭 300px ≈ 카드 328px). `.st-prefix { display: none }`과
`.kanban[data-view="list"] .st-prefix` 규칙은 없어진다. 시계 없는 단어(`Waiting for you`, `Sleeping`, `Archived`, `Idle`, 자동 재개 줄)는
늘 보인다. 결과: 1440 보드 `Running · 3m 49s` / `Done in 4m 12s · 12m ago`, 820 보드(카드 ~292px)와 320 폰은 시계만.

**D3 태그 안 링.** `.card-status .spinner`: 트랙 = `currentColor` 25%(`color-mix`), 호 = `currentColor`; 아이콘 색은 `--st-color`.
동작 줄이기의 정지 링(5137–5139)은 그대로.

**D4 아이콘 팝.** 화면에 이미 있던 카드의 `data-state`가 바뀐 렌더에서만(`applyCardParts`, 첫 렌더·`canAnimate()` 거짓·`reduceMotion()` 제외)
새 `.card-status .st-icon`에 WAAPI `[{opacity:0, transform:'scale(0.6)'}, {opacity:1, transform:'scale(1)'}]`,
`MOTION.move`(320ms) · `MOTION.easeOut`. 상태가 같은 face 교체(토큰 증가 등)는 팝하지 않는다.

**D5 상태 먼저, 이동은 나중.** `BOARD_HOLD_MS = 900`.
- 칸 = `waiting` → NEEDS YOU, `working` → RUNNING, `idle`·`closed` → DONE. 화면에 그려진 카드(`_cardEls[key]._colId`가 세 칸 중 하나)의 새 칸이
  다르면 처음 본 시각에 보류 `_laneHolds[key] = { from, to, until: now + 900 }`를 만들고, 그 카드는 **지금 컨테이너·지금 자리에 남긴 채**
  face·body·`data-state`·`data-col`만 새 상태로 그린다(D1 태그·D4 팝이 그 자리에서 보인다).
- `until`에 타이머 하나(가장 이른 `until`)가 `renderBoard(_lastBoardData)`를 다시 부르고, 그때 기존 FLIP(`.is-flying`)으로 새 칸에 간다.
- 보류 중 데이터가 원래 칸으로 돌아오면 보류를 지우고 움직이지 않는다. 다른 칸으로 바뀌면 `to`만 바꾸고 `until`은 그대로.
- 보류하지 않음(오늘과 같은 즉시 이동): 첫 렌더, `canAnimate()` 거짓(숨은 탭 포함), `reduceMotion()`, 새로 들어오거나 보드에서 사라지는
  카드, CRON 레인 슬롯. 보드에서 사라진 키·유저 전환으로 없어진 키의 보류는 버린다.
- 칸 배지와 빈 칸 문구는 **그려진 카드** 기준(보류 카드는 출발 칸에서 센다). DONE 날짜 묶음 머리 개수는 데이터 기준이다(보류 900ms 동안 1
  차이 가능 — 알려진 한계).
- 순수 함수로 판단을 뺀다: `holdLanes(wantLane, drawnLane, holds, now, on) → { lanes, holds, wakeAt }`(키 → 그릴 칸, 갱신된 보류, 다음 깸 시각).

**D6 낭독.** `#inbox` 안 `<p id="inbox-live" class="ib-sr" role="status" aria-live="polite" aria-atomic="true">`(`.ib-sr` = 시각 숨김:
`position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap`).
문구 `boardAnnounceText(w, r)` = `'응답이 필요한 세션 ' + w + '개, 실행 중 ' + r + '개'`(w = 렌더한 보드 데이터의 `waiting` 수 — CRON 레인으로 간
대기 실행 포함, r = `working` 수, 보류 전). `renderBoard`마다 계산하고, 문구가 바뀌었을 때만, 1000ms 안의 연속 변화는 마지막 하나만 쓴다.

**D7 Esc.** `initBoardInteractions`의 `#kanban`·`#cron-lane` keydown: `e.key === 'Escape'`이고 대상이 펼친 카드(`.card.is-expanded`)
안(face 또는 펼친 내용)이면 `e.stopPropagation()` → `toggleCard(key, true)`(키보드 = 애니메이션 없음, .prd/10 §4-9) →
`face.focus({ preventScroll: true })`. 대상이 펼친 카드 밖이면 아무것도 하지 않는다(문서 핸들러가 패널을 닫는 것은 그대로). 아티팩트
미리보기(window capture `artHandleKey`)가 먼저 먹은 Esc는 오지 않는다. 포커스가 카드 안에 있으면 docked 패널은 열린 채 남는다.

**D8 `aria-controls`.** `createCardShell`이 `.card-expand`에 `id = 'card-x-' + (++_cardSeq)`(세션 키를 id에 쓰지 않는다)를 주고
face가 `aria-controls`로 가리킨다. 닫힌 내용 `inert`는 그대로.

**D9 칸 section.** `<section class="kanban-col" id="col-<c>" data-col="<c>" aria-labelledby="col-<c>-name count-<c>">`,
`<h3 id="col-<c>-name">`(이름 = `NEEDS YOU 2`). id·클래스·`data-col`은 그대로라 CSS·JS·기존 테스트가 쓰는 선택자는 바뀌지 않는다.

**D10 주 버튼 하나.** `cardHasDecision(s, col)` = 형제 인스턴스가 아니고, (닫힘이 아닌 칸에서 `pendingPermissions` 중 내가 요청자인 것)
또는 (`waiting` 칸에서 `pendingQuestion`이 있고 내가 소유자). 참이면 `작업 로그`는 보조(`btn-action`), 거짓이면 지금처럼 주(`btn-action
btn-primary`). 카드 안 복수 질문 `답변하기`는 `btn-choice btn-choice-primary`(카드 CSS: 잉크 바탕·카드색 글자, 굵게 — 추천 선택과 같은 모양).
추천이 없는 단일 선택 질문은 선택 버튼이 모두 보조이고 작업 로그도 보조다(골라야 할 결정이지 권장되는 답이 없다).

**모션·반응형·테마 요약**: 새 모션은 D4 팝과 D5 보류뿐, 둘 다 동작 줄이기에서 없다. D2만 폭에 반응한다. 새 색은 D1 토큰 8쌍(다크·라이트).

## 5. 시험

파일: `src/conversation/__tests__/dashboard-affectui-agent-inbox.test.ts`(템플릿 텍스트·CSS) +
`dashboard-affectui-agent-inbox-client.test.ts`(`clientFn` + cook, 가짜 주입). 아래는 모두 구현 전 RED다.

| 시험 | D | 내용 |
|---|---|---|
| T1 | D1 | `cardTone` 표(재개 대기 → wait, waiting → wait, working → run, idle → done, closed → rest); `renderCardFace`가 `class="card-status" data-tone="…"`를 낸다 |
| T2 | D1 | `:root`·`[data-theme="light"]`에 `--st-{run,wait,done,rest}-{bg,fg}` 8쌍; `.card-status[data-tone="run"]` 등이 그 토큰을 쓴다; 높이 24px·반경 999px |
| T3 | D2 | `.st-prefix { display: none; }`·list 오버라이드가 없고, `.card-face`에 `container: cardface / inline-size`, `@container cardface (max-width: 300px)` 안에 `.st-prefix` 숨김 |
| T4 | D3 | `.card-status .spinner` 규칙이 `currentColor`를 쓴다; 기존 정지 링 규칙 유지 |
| T5 | D4 | `applyCardParts`: 있던 카드의 `data-state` 변경 → `.st-icon.animate` 1회(320ms); 같은 상태의 face 교체·`reduceMotion()`·`canAnimate()` 거짓 → 0회 |
| T6 | D5 | `holdLanes`: 처음 본 변경 → 출발 칸 + `until = now+900` + `wakeAt`; `now+900` → 새 칸; 되돌아옴 → 보류 삭제; `on=false` → 즉시; 새 카드·CRON → 보류 없음 |
| T7 | D5 | 보류 카드의 parts는 새 상태(`data-state`·`data-col`)인데 출발 칸 컨테이너에 남고, 그 칸 배지·빈 칸 문구가 그 카드를 센다 |
| T8 | D6 | `boardAnnounceText(2, 3)` = `응답이 필요한 세션 2개, 실행 중 3개`; 템플릿에 `id="inbox-live"`·`role="status"`·`aria-live="polite"`·`aria-atomic="true"`; 같은 문구는 다시 쓰지 않고 1초 안 연속 변화는 마지막만 |
| T9 | D7 | keydown Escape: 펼친 카드 안 대상 → `toggleCard(key, true)` + face focus + `stopPropagation`; 카드 밖 대상 → 아무것도 안 함 |
| T10 | D8 | `createCardShell` 두 번: face `aria-controls` = expand `id`, 두 id가 다르고 세션 키를 담지 않는다 |
| T11 | D9 | 템플릿에 `<section class="kanban-col"` ×3, 각 `aria-labelledby="col-<c>-name count-<c>"`와 `<h3 id="col-<c>-name">` |
| T12 | D10 | `renderCardBody`: 결정 없음 → 작업 로그 `btn-primary`; 소유자 질문·요청자 권한 → 작업 로그에 `btn-primary` 없음; 남의 질문·남의 권한 → 주; `renderMultiChoiceCard` → `btn-choice-primary` |

기존 테스트: `dashboard-agent-inbox.test.ts:217`의 `const worklogBtn = '<button … btn-primary"` 정규식은 D10으로 선언이 바뀌므로 새 모양으로
고친다(이유: 주 버튼이 조건부). 그 밖의 `renderCardStatus` 단언(`is-resume`, `spinner`, `Done in`, `Goal 완료 판정 중`)은 마크업을 유지해
그대로 통과해야 한다. 게이트: `npx vitest run src/conversation/__tests__/` · `npx tsc --noEmit` · `npx biome check src/conversation/`.
화면: `shoot-agent-inbox.mjs`(하네스 사본) `TAG=after-agent-inbox` — 1440·390 × 라이트·다크 보드·카드 근접·펼친 카드 3종 + 프로브 JSON
(Esc 후 닫힘·포커스, live region, section 이름, `aria-controls`, 태그 배경, 접두 표시).

## 6. 범위 밖

- 권한 블록(`renderPermissionBlock`)의 Approve/Deny 모양·순서 — 패널과 공유, Agent Run(Approval Card) 서브이슈가 정한다. 이 카드는 그 블록을
  그대로 싣고, D10만 그 존재를 읽는다.
- `failed` 상태·Retry·Reject → failed: 끝난 실패를 나르는 서버 필드가 생기면(후속 — 턴 종료 오류 표식) 빨강 톤 `--st-fail-*`과 함께 다시 본다.
- sources 수, 칸별 spark 색, 들여쓰기·반경·글자 크기, FLIP·펼침 수치, radiogroup 전환, 좁은 폭 목록 강제(§3의 유지·불채택 행).
- 한 번에 카드 하나만 열기(레퍼런스) — 여러 장을 펼쳐 비교하는 현재 동작(.prd/10 §3.1-4)을 유지한다.

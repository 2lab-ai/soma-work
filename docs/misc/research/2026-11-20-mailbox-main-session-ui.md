# 메일함 메인 세션 — 대시보드 UI 연구 (2026-11-20)

요약: 인스턴스마다 메인 세션(대표 세션)이 하나 있고, 세션을 정하지 않은 메일은 그 세션이 받는다. 어드민이 대시보드 맨 위에서 메인 세션의 상태를 보고, 바로 지시하고, 다른 세션을 메인으로 바꿀 수 있게 하자는 제안이다. 서버 쪽(라우팅·API)은 이 PR에 들어 있고, 화면은 다음 단계로 만든다.

읽는 순서: 무엇을 보여 주나 → 어디에 놓나 → 무엇으로 만드나(이미 있는 API와 새 API) → 단계. 목업: [mockup.html](2026-11-20-mailbox-main-session-ui/mockup.html).

## 무엇을 보여 주나

- **메인 세션 띠** (어드민에게만): 상태(대기 중 / 작업 중 / 답 기다림), 스레드 제목, 인스턴스 주소와 메인 세션 자신의 주소(복사), 메일 숫자(안 읽은 일반 메일 · 오늘 받은 메일 · 세션으로 바로 간 메일 · 메인으로 넘어온 메일), 스레드 최근 몇 줄, 지시 입력창, "스레드 열기" · "다른 세션을 메인으로…".
- **메일 흐름** (띠 오른쪽): 최근 메일 한 줄씩 — 언제, 누가 → 어느 세션, 결과(세션에 넣음 / 비면 넣음 / 메인 세션 / 메인으로 넘어옴).
- **세션 카드** (메일함 오너의 세션에만): "✉ 주소 복사"(그 세션의 메일 주소), "📬 메인으로 지정"(어드민), 메인 세션 카드에는 "메인" 배지와 "메인 해제".

세션 주소 모양: `<agent>:<host>:<instance>/<channel 소문자>-<threadTs>`. 인스턴스 주소만 쓰거나 `/main`을 붙이면 메인 세션이 받는다.

## 어디에 놓나

보드 페이지의 capacity 줄 바로 아래, 보드(inbox) 위. 이유: 어드민이 대시보드를 열면 가장 먼저 보는 자리이고, 보드와 같은 실시간 데이터(`session_update`)를 그대로 쓸 수 있다. 설정 탭에 두면 살아 있는 상태와 떨어져 쓸모가 줄어든다.

```
┌ capacity ──────────────────────────────────────────────────────────┐
├ 메인 세션 (어드민) ────────────────────────┬ 메일 흐름 ─────────────┤
│ ● 대기 중  📬 main mailbox session  [스레드] │ 09:58 …/c0x… → 세션 ✓  │
│ soma-work:host-a:dev · …/d0dm-1795… [복사]  │ 09:55 pickle → /main    │
│ 안 읽은 0 · 오늘 6 · 세션으로 4 · 넘어옴 1   │ 09:51 → …/c0abc 비면 넣음│
│ ✉ 09:41 host-b → "[e2e-5] …"                │                         │
│ [메인 세션에 지시하기…              ][보내기] │                         │
├ WORKING ─────────┬ WAITING ─────────┬ DONE ──────────────────────────┤
│ 카드 [✉ 주소][📬 메인으로]          │ main mailbox session [메인]    │
└──────────────────┴──────────────────┴────────────────────────────────┘
```

## 무엇으로 만드나

### 이미 있는 것 (그대로 씀)

- 보드 데이터: `GET /api/dashboard/sessions`, 카드 투영 `sessionToKanban`(`src/conversation/dashboard.ts`), 실시간 `GET /ws/dashboard` → `session_update`(`broadcastSessionUpdate`).
- 세션에 지시: `POST /api/dashboard/session/:key/command` `{message, attachments, clientRef}` — auth + CSRF, `requireInstructAccess`. Slack 스레드에 사람이 친 것처럼 들어가고, 도는 턴이 있으면 평소처럼 큐·스티어링. 패널 입력창(`renderPanelComposer`)이 이미 쓰고 있다.
- 어드민 판정: 서버 `isSlackAdmin` / `namedAdmin`(Slack 로그인 어드민, 변경은 `X-Admin-Mode: on`), 클라이언트 `_viewerIsAdmin` · `_isAdminModeOn`.
- 세션에 붙는 영속 표시의 선례: 별표(`/star` → `SessionRegistry.setStarred`, 잠들지 않고 위로 고정).

### 이 PR에 들어간 것

- `GET /api/mailbox/main-session` → `{ address, main: { key, channel, threadTs, mailAddress, setAt, setBy } | null }`
- `PUT /api/mailbox/main-session {key}` / `DELETE` — Slack 로그인 어드민 + 관리자 모드 + CSRF(비밀 탭과 같은 관문). 기록은 `DATA_DIR/mailbox-main-session.json`.
- 라우팅: 세션 꼬리표 메일 → 그 세션(비면 즉시, 바쁘면 끝나는 순간, 잠든 세션은 깨움), 꼬리표 없음·`/main` → 메인 세션(없으면 새로 만들고 기록). 메일함 오너의 세션만 메일을 받고 주소(`MAILBOX_ADDRESS`)도 그 세션에만 들어간다 — 다른 에이전트의 메일이 다른 사람 이름으로 턴을 열지 않게. 메인 세션 지정도 오너의 살아 있는 세션만.

### 화면 단계에서 더할 것

1. 카드 필드: `KanbanSession`에 `mainSession?: true`, `mailAddress?: string` — 띠의 실시간 상태가 `session_update`로 공짜로 따라온다.
2. 띠 렌더: capacity 아래에 `_viewerIsAdmin`일 때만. 상태는 `cardOf` 재사용, 입력창은 `/session/:key/command`.
3. 카드 액션: `sessionActionsOf`에 "주소 복사"(누구나 자기 세션), "메인으로 지정"(어드민 + 관리자 모드) → `PUT /api/mailbox/main-session` 후 `broadcastSessionUpdate()`.
4. 메일 흐름: poller가 최근 처리 기록(메일 id · 보낸 이 · 받은 세션 · 결과 · 시각)을 메모리 고리 버퍼로 들고, `GET /api/mailbox/activity` + 어드민 전용 WS 푸시(`broadcastAdminApprovals`와 같은 방식)로 띄운다.

## 단계

- **1단계 (이 PR)**: 세션 주소 · 메인 세션 라우팅 · 메인 세션 API.
- **2단계**: 띠 + 카드 액션 + 카드 필드 (위 1–3). 서버 변경은 카드 투영 두 필드뿐.
- **3단계**: 메일 흐름 기록과 실시간 푸시 (위 4).

## 열린 질문

- 메인 세션을 인스턴스당 하나로 둘지, 어드민마다 하나로 둘지. 지금은 인스턴스당 하나(메일 주소가 인스턴스 단위라서).
- 메인 세션이 오래 살면 컨텍스트가 길어진다. 하루 단위로 새 메인 세션을 여는 옵션을 둘지는 운영해 보고 정한다.

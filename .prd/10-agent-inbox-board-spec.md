# 10 — Agent inbox 작업 보드 (반응형 · 모션) + Slack 미니멀 출력

Status: shipped · Date: 2026-10-16 · 변경 전 기준 main `e992de7c` (v0.2.1156) · 출고 main `b4562525` (PR #281·#283) → 프리뷰 v0.2.1158 · R2 main `291472fa` (PR #285) → 프리뷰 v0.2.1159
SSOT: [`agent-inbox/ssot.md`](agent-inbox/ssot.md) · Loop: [`agent-inbox/loop.md`](agent-inbox/loop.md)

증거 라벨: **[REF]** = 레퍼런스 영상 프레임(2026-10-16 Aside 캡처, SSOT §레퍼런스) · **[CODE]** = 이 저장소 `file:line`
· **[LIVE]** = 프리뷰 배포 실측 · **[SHIPPED]** = 출고된 계약(현재형, 미래 목표가 아니다).

## 0. 한 줄 정의

standalone 작업 대시보드의 세션 보드는 "Agent inbox"다 — 세션이 **유저 차례 / 실행 중 / 끝남** 세 칸을 오가며,
카드는 제자리에서 펼쳐져 단계·유저 지시·모델 응답을 보여 주고, 상태가 바뀌면 칸 사이를 날아 이동한다. Slack 스레드에는
task list와 유저가 꼭 알아야 할 것만 남고, 모델의 실시간 작업 설명은 대시보드의 **작업 로그**로 간다.

## 1. 변경 전 (AS-IS, main `e992de7c`) [CODE]

### 1.1 대시보드
- 서빙: Fastify 1개(`src/conversation/web-server.ts:388`). `renderDashboardPage()`가 CSS·HTML·JS를 한 템플릿 문자열로 반환
  (`src/conversation/dashboard.ts:1735-5272`). 포트 = `CONVERSATION_VIEWER_PORT`, dev 33000(`web-server.ts:308-324`).
- 보드: 4칸 `working 진행 / waiting 유저입력 / idle 대기 / closed 동면`(`dashboard.ts:3077-3110`).
  `buildKanbanBoard`가 `SLEEPING`→closed, 나머지는 `activityState`로 분류(`:699-795`), 48시간 내 아카이브를 closed에 붙인다.
- 렌더: `renderBoard`가 칸마다 `innerHTML`을 통째로 다시 쓴다(`:3764-3786`) → DOM 노드 재사용이 없어 이동 애니메이션 불가.
- 갱신: WS `/ws/dashboard`(`session_update`·`task_update`·`conversation_update`·`summaryTitleChanged`·`sessionUpdated`) + 30초 폴링(`:5268`).
- 카드 클릭 = 오른쪽 슬라이드 패널(`openPanel`, `:4755-4907`) — 메타·질문·task·대화 턴(`GET /api/dashboard/session/:conversationId`,
  기본 30개). 드래그로 close/stop(`confirm()` 경유, `:5204-5262`). 반응형은 ≤1100px 2칸, ≤680px 1칸(`:2941-2981`).
- 모션: 상태 점 pulse·working 카드 그림자 pulse·스피너·패널 `right` 전환뿐. 칸 이동·FLIP 없음.
- AS-IS 캡처(2026-10-16, fable dev v0.2.1156): 통계 8칸 + 세션 보드 4칸, 390px에서 상단 바 글자가 잘림.

### 1.2 Slack 출력
- 수준 4개 `minimal|compact|detail|verbose`, 기본 `minimal`(`packages/slack/src/output-flags.ts:59,101`).
  `LOG_MINIMAL = ALWAYS|FINAL_RESULT|MCP_PROGRESS|TODO_UPDATE|TODO_REACTION|SKILL_INVOCATION`(`:65-71`).
- 유저 기본값 = `user-settings.json`의 `defaultLogVerbosity`(`src/user-settings-store.ts:372`), 없으면 minimal(`:934-936`).
  세션은 생성 시 마스크를 복사해 `sessions.json`에 저장(`src/session-registry.ts:605,1975,2154`)하고, 소비처는
  `context.logVerbosity ?? LOG_DETAIL`로 읽는다(`packages/slack/src/stream-processor.ts:699` 외) — 마스크 없는 세션은 detail로 보인다.
- **모델 서술은 수준과 무관하게 Slack에 흐른다**: `handleTextMessage`(`stream-processor.ts:1310-1365`) → `sayWithBlockKit` →
  `threadPanel.appendText`(`:1964-1977`). 서술과 최종 답변을 구분하지 않고, SDK `finalText`가 이미 보낸 텍스트와 같으면
  다시 보내지 않는다(`:1689-1693`).
- minimal에서 추가로 보이는 것: MCP/서브에이전트/백그라운드 진행 메시지(`tool-event-processor.ts:401,454,493`), 압축 시작/완료
  공지(`pipeline/stream-executor.ts:1838-1870`), 헤더·액션 패널, task list, 완료 카드(최종 답변 메시지에 합쳐짐,
  `turn-surface.ts:1117-1123`), 오류, 선택 질문, 승인.
- 대화 기록: 유저 턴은 턴 시작(`stream-executor.ts:1224`), 어시스턴트 턴은 성공한 턴 끝에 `collectedText` 한 덩어리(`:2175`)로만
  기록된다. 도구 호출·실시간 서술 흐름은 어디에도 남지 않는다.
- 스레드 링크: `📝 대화 기록 보기`를 원 스레드에 게시(`pipeline/session-initializer.ts:412`)하고, 봇 스레드로 옮기면 지운다.
  봇 스레드에는 detail 이상에서만 다시 게시된다 → **minimal에서는 봇 스레드에 링크가 없다.** 헤더(`thread-header-builder.ts`)에
  대시보드 링크 필드는 없다.
- 로그인: `/login`은 Google/Microsoft 버튼만 그린다(`src/conversation/oauth.ts:523`). fable dev에는 둘 다 설정이 없어 빈 페이지다.
  Slack `dashboard` 명령이 1회용 SSO 링크를 주고, SSO는 항상 `/dashboard/<userId>`로 착지한다(`oauth.ts:738`).

## 2. 레퍼런스 판독 [REF]

### 2.1 레이아웃
- 상단: breadcrumb `Agents / Agent inbox`(왼쪽), 세그먼트 컨트롤 `Board | List`(오른쪽, 선택된 쪽이 흰 바탕 pill).
- Board = 3칸 `NEEDS YOU` · `RUNNING` · `DONE`. 칸 머리 = 반짝이 아이콘 + 대문자 자간 넓은 라벨 + 개수 배지(회색 pill).
  칸 바탕 = 페이지보다 한 단계 짙은 회색, 둥근 모서리. 빈 칸 = 가운데 흐린 `Nothing here`.
- 카드(접힘): 상태색 반짝이 아이콘 + 제목(semibold) / 요약 2줄 말줄임 / 바닥 줄 = 상태(아이콘+텍스트) · 오른쪽 정렬 지표 2개
  (사이 세로 구분선). 상태 표기: `▲ Waiting for …`(호박) · 스피너 + 경과 `3m 41s`(파랑) · `● 4m 12s`(초록) · `❗ Failed`(빨강).
- 카드(펼침): 구분선 → 모델명(흐린 글씨) → 단계 타임라인(점 + 문장 + 오른쪽 상대시각, 마지막 점만 진하게 = 현재 단계)
  → 오른쪽 정렬 버튼(보조 `Reject` + 주 `Approve` 검정 / `Retry` / `Open`).
- List = 칸이 세로로 쌓인 섹션, 카드 전체 폭, 요약 1줄, 상태 `Running · 3m 55s` / `Done in 6m 48s`.
- 테마: 라이트·다크 둘 다 같은 구조.

### 2.2 상호작용과 모션
| 시각 | 사건 | 관측 |
|---|---|---|
| 0.6s | 카드 클릭 | 제자리에서 아래로 펼쳐짐, 아래 카드는 밀려 내려감 |
| 1.2–1.8s | Approve | 상태가 즉시 스피너+경과로, 타임라인에 `Approved by you … · now` 추가, 버튼은 `Open`으로 |
| 2.4s | 칸 이동 | 접힌 카드가 그림자를 띄운 채 `NEEDS YOU`→`RUNNING` 맨 위로 날아감, 출발 칸 아래 카드는 올라오고 도착 칸 카드는 내려감, 배지 동시 갱신 |
| 3.6–4.8s | Retry | `Failed`→스피너 `0s`, 타임라인에 `Retrying … · now` |
| 5.4s | 빈 칸 | `NEEDS YOU 0` + `Nothing here` |
| 6.6–7.2s | 완료 | 실행 카드가 `DONE` 맨 위로 날아감, 상태 `● 6m 48s` |
| 9.6s | 테마 | 같은 배치로 다크 |
| 13.8–14.4s | Board→List | 카드가 칸 자리에서 리스트 행 자리로 모핑(공유 요소 전환) |
| 내내 | 타이머 | 실행 중 경과가 1초마다 증가 |


## 3. 출고 계약 [SHIPPED]

### 3.1 보드 (`src/conversation/dashboard.ts` 템플릿)
1. 칸 3개: `NEEDS YOU` = `waiting` · `RUNNING` = `working` · `DONE` = `idle` 다음에 `closed`(동면·아카이브). closed 카드는 흐리게,
   상태 `Sleeping`/`Archived`, 7일 지난 것은 `Show older` 뒤에 숨는다. 서버 버킷(`KanbanBoard`)은 그대로다. 빈 칸 = `Nothing here`.
2. 상단: breadcrumb `soma-work / Agent inbox` + `Board | List` 세그먼트. 선택은 `localStorage['soma-board-view']`, 없으면 폭 < 640px = List.
   기존 통계(기간 선택·8칸·차트)와 상단 바(유저 선택·Conversations·admin·테마)는 유지된다. 상단 바 = ≥1024px 한 줄, 그 아래는 nav가
   자기 줄로 내려가고, <640px은 상태 배지가 점(`role="status"` + 상태별 aria-label)이 되며 터치 대상 ≥ 44px. 컨트롤 라벨은 줄바꿈·잘림이
   없고 서로 겹치지 않는다(320–1280px, Chromium·WebKit). 줄어드는 것은 유저 이름뿐 — pill 이름은 줄이 찰 때, 선택된 유저 이름은 한 줄 바(≥1024px)
   에서 180px 상한·그 아래는 nav 줄 전체를 넘을 때 — 언제나 보이는 말줄임표로 줄고 전체 이름은 `title`에 있다. 유저 선택은 보이는 라벨 위에
   투명한 네이티브 `<select>`를 덮은 구조라 클릭·탭·키보드(포커스 링은 감싸는 상자)가 모두 select로 간다.
3. 접힌 카드: 상태색 ✦ + `displayHeadline` / 요약 2줄(waiting = 대기 질문, working = 진행 중 task, 그 외 = `summaryTitle` 또는 마지막 task)
   / 바닥 줄 = 상태 + 지표(task `완료/전체`, 컨텍스트 %). 나머지 메타(env 배지·refs·워크플로·모델·effort·owner·토큰·컨텍스트 바·merge)는
   펼친 영역에 있고 `dhShow()` 게이트를 따른다.
4. 카드 클릭 = 제자리 펼침/접힘. 펼친 영역: 모델·effort → task 타임라인(현재 task만 진한 점, 완료 task는 소요시간) → **지시 / 응답**
   (최근 1쌍, 펼칠 때 `GET /api/dashboard/session/:conversationId?limit=2`로 지연 로드) → 대기 질문 선택지 → 버튼: 상태별 Stop / Close /
   Trash + `작업 로그`(패널 열기) + `Slack`(스레드 링크). 드래그 앤 드롭과 `confirm()`은 없다.
5. 렌더 = 키 기반 재조정: 카드는 `data-session-key`로 식별해 DOM 노드를 재사용하고, 바뀐 카드만 교체한다. 같은 데이터면 DOM을 건드리지 않는다.
6. 슬라이드 패널의 **작업 로그** 섹션: §3.3 항목을 시간순으로, 새 항목은 WS로 아래에 붙는다. 도구 행은 `▸ <도구> <입력 요약>` /
   `✓ <도구> ok` — 도구명은 한 번만 보인다(방출 텍스트가 도구명으로 시작하면 클라이언트가 그 접두를 뗀다).
7. 딥링크: `/dashboard/<ownerId>?session=<sessionKey>` → 첫 렌더 후 그 카드를 펼치고 패널을 작업 로그 위치로 연다.

### 3.2 Slack (minimal)
1. **3a 1회 이관** (`src/deploy/migrate-all-users-minimal-once.ts`): 부팅 시 1회(마커 `.all-users-log-minimal-once-2026-10-16.json`,
   존재만 확인, 데이터보다 먼저 기록) 모든 유저의 `defaultLogVerbosity`를 `minimal`로, `sessions.json`의 모든 세션 마스크를
   `LOG_MINIMAL`로 바꾼다. 세션 복원보다 먼저 실행된다. 결과 로그 = `migrated users n/N, sessions m/M`, 재기동 = `skipped`.
   이후 유저가 바꾼 값은 다시 덮지 않는다.
2. **3b 미니멀**: `LOG_MINIMAL = ALWAYS | FINAL_RESULT | TODO_UPDATE | TODO_REACTION` (`packages/slack/src/output-flags.ts:75`).
   minimal에서 MCP·서브에이전트·백그라운드 진행 메시지(`MCP_PROGRESS`)는 Slack에 가지 않는다 — 그 호출은 작업 로그의 `tool`/`tool_result`
   행으로 남는다. 스킬 호출 배너(`SKILL_INVOCATION` — `$skill` 강제·자동 스킬·지연 `$skill`의 RPG 배너)도 Slack에 가지 않고 작업 로그 `notice`로 간다.
3. minimal에서 모델 서술(턴 중간 텍스트)은 Slack에 가지 않는다. 턴의 최종 답변(SDK `finalText`)만 간다. "Slack에 보냈는가"는
   `currentMessages`(기록용)와 따로 추적한다 — 서술을 보류했으면 `finalText`가 같은 문자열이어도 한 번 보낸다.
   선택 질문 JSON·인시던트 결론(`context.incidentAttempt`)·오류는 간다.
   빈 턴 금지: 최종 답변이 아무것도 보여주지 않으면(`finalText` 없음·빈 문자열·지시문뿐·공백뿐, `result` 없음) 마지막으로 보류한
   서술을 최종 답변으로 한 번 보낸다. 예외 = 호스트가 이 턴에 선택 질문 폼을 올렸을 때, 턴이 전송 오류 누출로 끝났을 때(executor가
   복구). 최종 답변을 Slack에 보냈으면 그 턴은 누출로 끝난 턴이 아니다.
4. minimal에서 압축 시작/완료 공지는 Slack에 가지 않는다(작업 로그 `notice`).
5. 남는 Slack 표면(minimal): 스레드 헤더(대시보드 링크 포함) · task list · 최종 답변(+완료 카드) · 선택 질문/승인 · 오류.

### 3.3 작업 로그 계약
```ts
// packages/slack/src/work-log.ts — 타입
export type WorkLogKind = 'instruction' | 'narration' | 'tool' | 'tool_result' | 'final' | 'notice' | 'error';
export interface WorkLogInput { kind: WorkLogKind; text: string; tool?: string; ok?: boolean; turnId?: string; ts?: number }
export interface WorkLogEntry extends WorkLogInput { seq: number; ts: number }
```
- 방출(packages/slack): `StreamContext.workLog?: (entry: WorkLogInput) => void`. stream-executor가 `session.conversationId`가 있을 때
  `streamExecutorProviders.appendWorkLog(conversationId, entry)`로 묶는다(기본 no-op). 수준과 무관하게 항상 방출:
  `instruction` · `narration`(지시문 제거 후) · `tool`(도구명 + 입력 요약 ≤200자) · `tool_result`(도구명 + `ok`) · `final` · `notice` · `error`.
- 저장(`src/conversation/work-log.ts`): `${DATA_DIR}/worklogs/<conversationId>.jsonl` 추가 전용, 항목 text ≤ 4000자(`WORK_LOG_TEXT_MAX`).
  `seq`는 대화마다 엄격히 증가하되 건너뛸 수 있다(사이드카가 `WORK_LOG_SEQ_RESERVE_BLOCK` = 1000개 단위로 예약, 재기동은 예약 지점에서 재개).
  `appendWorkLog(conversationId, input) → Promise<WorkLogEntry>`는 디스크 기록 후 resolve하고 그때 WS로 방송한다.
  `readWorkLog(conversationId, { afterSeq?, limit = 500 }) → { entries, hasMore }`.
- API(`src/conversation/work-log-routes.ts`): `GET /api/dashboard/session/:conversationId/worklog?afterSeq=&limit=` → `{ entries, hasMore }`.
  afterSeq 없음 = 마지막 limit개(hasMore = 더 오래된 것 있음), afterSeq=N = N 뒤 첫 limit개(hasMore = 더 있음). limit 1..500.
  형식이 틀린 파라미터 = 400, 모르는 대화 = 404, 소유자·관리자 외 = 403(소유자 없는 대화 = 관리자만).
- WS: `{ type: 'work_log', conversationId, entry }`, `conversation_update`와 같은 소유자/관리자 범위로 방송.

### 3.4 스레드 맨 위 링크
1. 헤더 필드 `dashboardLink`(라벨 `📋 작업 로그`, `packages/slack/src/surface-config.ts`) — URL = 주입 provider
   `getDashboardSessionUrl(ownerId, sessionKey)` = `${viewerBase}/dashboard/${ownerId}?session=${encodeURIComponent(sessionKey)}`
   (뷰어가 listen 중이 아니면 undefined → 필드 생략). 기본 프리셋에서 켜져 있고, 기존 유저 프리셋에는 부팅 1회 이관으로 추가된다.
2. 유저가 시작한 스레드에는 `📋 작업 로그` 딥링크를 원 스레드에 게시한다(`pipeline/session-initializer.ts`).
3. 로그인 막다른 길 방지(`src/conversation/oauth.ts`): 인증 실패로 `/login`에 올 때 원래 경로를 `soma_next` 쿠키(HttpOnly·SameSite=Lax·
   30분, `/dashboard`로 시작하는 같은 출처 경로만)에 저장하고, SSO·OAuth 성공 시 그 경로로 착지한다. 로그인 페이지는 항상
   "Slack 스레드에서 `dashboard`를 입력하면 로그인 링크를 받습니다"를 보인다.

## 4. 모션 계약 [SHIPPED]

수치 출처 = zworkflow `motion-design` 표준(`references/motion-standards.md`). CSS 토큰은 `:root`에 있다.

| 토큰 | 값 |
|---|---|
| `--ease-out` | `cubic-bezier(0.23, 1, 0.32, 1)` — 진입·피드백 |
| `--ease-in-out` | `cubic-bezier(0.77, 0, 0.175, 1)` — 화면 위 이동·모핑 |
| `--dur-press` | 160ms |
| `--dur-expand` | 240ms |
| `--dur-move` | 320ms (칸 이동·Board↔List) |
| `--dur-fade` | 180ms |

1. 카드 펼침/접힘: `.card-expand`의 `grid-template-rows: 0fr → 1fr`(240ms `--ease-out`) + 내용 opacity 0→1. 밀리는 형제 카드는 FLIP.
2. 칸 이동: FLIP — 갱신 전 rect 측정 → DOM 갱신 → 차이를 `transform`으로 되돌린 뒤 0으로(320ms `--ease-in-out`, WAAPI라 연속 갱신 시
   현재 위치에서 다시 출발). 칸을 옮기는 카드만 `.is-flying`(그림자·`z-index`)을 얻는다.
3. 진입: `opacity 0 + scale(0.97)` → 1(180ms `--ease-out`). `scale(0)` 없음. 퇴장은 opacity만.
4. Board↔List: 같은 카드 DOM을 재배치하고 2번 FLIP으로 위치를 모핑(폭은 즉시).
5. 누름: 버튼·세그먼트 `:active { transform: scale(0.97) }` 160ms `--ease-out`.
6. 호버: `@media (hover: hover) and (pointer: fine)` 안에서만 테두리/그림자 색(`ease` 150ms). 이동 없음.
7. 타이머는 1초 텍스트 갱신만, 스피너는 `linear` 회전.
8. `prefers-reduced-motion: reduce`: FLIP 이동·scale을 끄고 opacity 전환(180ms)만.
9. 키보드 조작은 애니메이션하지 않는다. 바뀐 것이 없는 갱신은 DOM을 건드리지 않는다.

## 5. 반응형 계약 [SHIPPED]

| 뷰포트 폭 | 배치 |
|---|---|
| ≥ 1024px | Board 3칸 1:1:1, 최대 폭 1280px 가운데 |
| 640–1023px | Board 3칸 가로 스크롤(칸 최소 300px, `scroll-snap`) |
| < 640px | 기본 List(토글 유지). 터치 대상 ≥ 44px, 페이지 가로 스크롤 0 |

## 6. 인수 시나리오

1. 1280/820/390px에서 보드를 연다 → 레퍼런스 대조 시트에서 칸·카드·배지·빈 칸 구조가 같고, 세 폭 모두 `scrollWidth == innerWidth`.
2. 실행 중 세션이 끝난다 → 카드가 `RUNNING`→`DONE`으로 이동하는 동안의 프레임 시퀀스에 중간 위치가 찍힌다(순간 이동 아님).
3. 카드를 누른다 → 제자리에서 펼쳐지고 지시/응답·task 타임라인이 보인다. `작업 로그`를 누르면 서술·도구 항목이 시간순.
4. minimal 세션에서 도구를 여러 번 쓰는 지시를 준다 → Slack 스레드에는 헤더(`📋 작업 로그` 링크) · task list · 최종 답변만, 중간 서술 없음.
   같은 턴의 서술은 대시보드 작업 로그에 있다.
5. 배포 직후 봇 로그에 이관 결과 `migrated users n/N, sessions m/M` 1줄, 재기동 시 `skipped`.
6. 쿠키 없이 헤더 링크를 연다 → 로그인 페이지에 Slack 안내가 보이고, `dashboard` SSO 후 그 세션 딥링크로 착지한다.

## 7. 출고 기록 [LIVE]

리시트 원장 = [`agent-inbox/loop.done.md`](agent-inbox/loop.done.md). 프리뷰 배포 대상 `t2`·`t3`(deploy.yml 잡 이름)에서 시나리오
1·2·3·5와 6의 로그인 페이지·`soma_next` 쿠키를 실측했다(6의 SSO 착지는 유닛 테스트 `login-return.test.ts`). 대상 `t1`은 러너가
오프라인이라 배포가 큐에 걸려 있고, 러너 복귀 시 같은 `deploy/dev` 실행으로 간다. prod(`deploy/prod`)는 유저 게이트다.

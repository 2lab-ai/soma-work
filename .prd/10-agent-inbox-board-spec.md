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
  (그때 통계는 8칸을 다 펼친 채 보드 위에 있었다. 지금의 통계 배치는 §3.1-2 — 접힌 통계 줄이 앞에, 보드가 뒤에.)

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
   상태 `Sleeping`/`Archived`. (2026-10-22: 7일 `Show older`는 끝난 날짜별 그룹으로 대체 — [`11-dashboard-live-surfaces-spec.md`](11-dashboard-live-surfaces-spec.md) T11/T12.) 서버 버킷(`KanbanBoard`)은 그대로다. 빈 칸 = `Nothing here`.
   **아카이브**(closed 칸의 `terminated` 카드, 상태 `Archived`)는 기본으로 그리지 않는다 — `Sleeping` 카드는 그대로 보인다. 보드 머리의
   `Board | List` 왼쪽에 토글 버튼 `Archives (N)`(N = 보드의 아카이브 수, 라벨은 상태에 따라 바뀌지 않는다)이 있고 켜짐/꺼짐은
   `aria-pressed`가 나른다. 켜지면 아카이브가 보이고 버튼은 `Board | List`의 선택된 칸과 같은 모양(밝은 바탕·그림자·진한 글자)이 된다.
   선택은 `localStorage['soma-show-archives']`(`on`/`off`, 없으면 숨김). 보드에 아카이브가 하나도 없으면 버튼은 숨는다. `DONE` 개수 배지 = `DONE`에 지금 그려진 카드 수(숨은 아카이브·접힌 7일 전 묶음은 빠진다), `Show older (N)` = 펼치면 더해질
   카드 수(아카이브는 보일 때만 센다).
   **자동 재개 대기**: `idle`이어도 시스템이 스스로 다시 시작할 세션은 `DONE`이 아니라 `RUNNING`에 둔다 — 서버가 카드에
   `autoResume`(`deriveAutoResume`)을 싣고 `working` 버킷에 넣는다. 종류: `error-retry`(턴이 429 등 복구 가능한 오류로 끝나
   `pendingRetryAt`까지 재실행 대기) · `goal-eval-retry`(goal 완료 판정이 같은 이유로 실패해 `goal.evalBackoffUntil`까지 대기) ·
   `goal-eval`(goal 완료 판정 진행 중). 카드 상태줄 = 시계 아이콘 + `HH:MM 자동 재개 · 시도 n/3`(goal은 `Goal 판정 재시도`,
   진행 중은 `Goal 완료 판정 중`), 요약 줄 = `오류: <오류 첫 줄>`, 펼침 = 같은 내용의 재개 줄. 실행 중인 턴이 없으므로 `Stop` 대신
   `Close`. 재개 정보는 재개 장치 자신이 믿는 영속 마커만 읽는다: 에러 재시도는 `pendingRetryAt`이 현재 run의 것
   (`pendingRetrySessionId === sessionId`)이고 세션이 동면이 아닐 때만 — 재시작 후 `resumePendingErrorRetries`(#351)가 다시
   거는 조건과 같다. 시도·사유는 마커와 함께 영속되는 `pendingRetryDetail`. 질문 대기(`waiting`)는 언제나 `NEEDS YOU`가 이긴다.
2. 상단: 상단 바 바로 아래에 **통계 줄**이 먼저 오고 보드가 그 뒤에 온다. 통계 줄 = 기간 선택(`오늘`·`지난 7일`·`지난 30일`)
   + `세션`·`토큰`·`비용` 세 숫자 + `자세히` 버튼(`aria-expanded`). 기본은 접힘이고, `자세히`는 나머지 다섯 칸(턴 사용·PR 생성·
   PR 머지·머지 코드·워크플로우)과 차트를 통계 줄과 보드 사이에 펼친다. 선택은 `localStorage['soma-stats-detail']`(`open`/`closed`,
   없으면 접힘). 통계 줄은 ≥640px 한 줄, <640px은 두 줄(기간 선택 + `자세히` / 세 숫자)이고 터치 대상 ≥ 44px다.
   모든 숫자는 선택한 기간을 따른다: 세션·턴·PR·머지 코드·워크플로우·차트 = `GET /api/dashboard/stats?period=&userId=`,
   토큰(입력 + 출력)·비용 = `GET /api/dashboard/usage?period=&userId=`의 `totals`. `userId`가 없으면(All Users) 모든 유저다.
   기간이나 유저를 바꾸면 둘 다 다시 묻고, 그 사이 늦게 도착한 이전 선택의 응답은 버린다. 토큰 툴팁(#814)의 인스턴스별 분해는
   보드에 있는 세션 기준이고 툴팁에 `보드 세션 기준`이라고 적힌다.
   보드 머리: breadcrumb `soma-work / Agent inbox` + `Board | List` 세그먼트. 선택은 `localStorage['soma-board-view']`, 없으면 폭 < 640px = List.
   상단 바(유저 선택·Conversations·admin·테마)는 유지된다. 상단 바 = ≥1024px 한 줄, 그 아래는 nav가
   자기 줄로 내려가고, <640px은 상태 배지가 점(`role="status"` + 상태별 aria-label)이 되며 터치 대상 ≥ 44px. 컨트롤 라벨은 줄바꿈·잘림이
   없고 서로 겹치지 않는다(320–1280px, Chromium·WebKit). 줄어드는 것은 유저 이름뿐 — pill 이름은 줄이 찰 때, 선택된 유저 이름은 한 줄 바(≥1024px)
   에서 180px 상한·그 아래는 nav 줄 전체를 넘을 때 — 언제나 보이는 말줄임표로 줄고 전체 이름은 `title`에 있다. 유저 선택은 보이는 라벨 위에
   투명한 네이티브 `<select>`를 덮은 구조라 클릭·탭·키보드(포커스 링은 감싸는 상자)가 모두 select로 간다.
3. 접힌 카드: 상태색 ✦ + `displayHeadline` / 요약 2줄(waiting = 대기 질문, working = 진행 중 task, 그 외 = `summaryTitle` 또는 마지막 task)
   / 바닥 줄 = 상태 + 지표(task `완료/전체`, 컨텍스트 %). 나머지 메타(env 배지·refs·워크플로·모델·effort·owner·토큰·컨텍스트 바·merge)는
   펼친 영역에 있고 `dhShow()` 게이트를 따른다.
   **All Users**(유저를 고르지 않은 보기)에서는 모든 카드 머리 오른쪽 끝에 소유자 이름 배지(`ownerName`, 둥근 pill)가 붙는다. 색은 8색
   중 하나이고 보드에 있는 소유자들을 한꺼번에 배정한다(env 배지와 같은 방식): `ownerId` 정렬 순서로 각자 해시(djb2 % 8) 칸을 쓰고, 이미
   찬 칸이면 다음 빈 칸으로 넘어간다. 그래서 소유자가 8명 이하면 색이 겹치지 않고, 결과는 소유자 집합에만 달려 같은 집합이면 어느 카드·
   렌더에서도 같은 색이다(숨은 아카이브의 소유자도 집합에 들어가 `Archives` 토글이 색을 바꾸지 않는다). 보드에 아직 없는 소유자는 해시
   칸을 쓴다. 각 색의 글자는 라이트·다크 모두 배지 바탕에 4.5:1 이상이다. 제목이 먼저 줄고(말줄임표), 배지는 상한(카드 폭 45%·168px)을 넘는 이름만 말줄임표로 줄며 전체 이름은 `title`에
   있다. 유저를 고르면 배지는 없다. Board·List 모두 같고 390px에서도 제목을 덮지 않는다.
4. 카드 클릭 = 제자리 펼침/접힘. 펼친 영역: 모델·effort → task 타임라인(현재 task만 진한 점, 완료 task는 소요시간 — **현재 task는
   최대 1개**: 모델의 TodoWrite가 `in_progress`를 여러 개 써도 서버(`normalizeTaskProgress`)가 목록 순서상 첫 번째만 현재로 두고
   나머지는 `pending`으로 보낸다. `DONE` 칸 세션(실행 중·질문 대기·자동 재개 대기 어느 것도 아님)은 현재 task가 없다 — Slack 플랜 블록의 턴 종료 demotion과 같은 규칙. 아카이브 카드도 같다.
   보드 payload·`task_update` 푸시·열린 패널 Tasks 모두 같은 규칙이고, 저장된 스냅샷은 바꾸지 않는다) → **지시 / 응답**
   (최근 1쌍, 펼칠 때 `GET /api/dashboard/session/:conversationId?limit=2`로 지연 로드) → 대기 질문 선택지 → 버튼: 상태별 Stop / Close /
   Trash + `작업 로그`(패널 열기) + `Slack`(스레드 링크). 드래그 앤 드롭과 `confirm()`은 없다.
5. 렌더 = 키 기반 재조정: 카드는 `data-session-key`로 식별해 DOM 노드를 재사용하고, 바뀐 카드만 교체한다. 같은 데이터면 DOM을 건드리지 않는다.
6. 슬라이드 패널 = 머리(제목·닫기) · 메타 · 링크 · 토큰 배지 · **Tasks** · 스크롤 영역(대기 질문 · **작업 로그** · 대화 내역) ·
   메시지 보내기. **Tasks**는 토큰 배지 아래, 스크롤 영역 밖에 고정되어 대화를 스크롤해도 움직이지 않는다. task가 없으면 사라지지 않고
   머리 `Tasks` + `아직 작업 목록이 없습니다` 한 줄을 보인다. 자체 스크롤이 있고 높이 상한은 `min(30vh, 240px)`(<640px은
   `min(22vh, 160px)`)이다. 정렬(진행 중 → 대기 → 완료)과 완료 접기(3개 초과는 `Show N more completed`)는 그대로다.
   **작업 로그** 섹션: §3.3 항목을 시간순으로, 새 항목은 WS로 아래에 붙는다. 도구 행은 `▸ <도구> <입력 요약>` /
   `✓ <도구> ok` — 도구명은 한 번만 보인다(방출 텍스트가 도구명으로 시작하면 클라이언트가 그 접두를 뗀다). 섹션 머리는 펼침 버튼
   (`작업 로그` + 항목 수 + 화살표, `aria-expanded`/`aria-controls`)이다. 패널은 어떻게 열든 작업 로그가 **접힌** 상태로 시작한다(예외 없음,
   저장하지 않는다). 카드의 `작업 로그` 버튼과 `?session=` 딥링크로 열면 스크롤 영역 맨 위에 놓여 접힌 `작업 로그 N` 머리가 보인다(대기
   질문이 길어 머리가 화면 밖이면 머리를 맨 위로) — 펼치기는 한 번의 클릭이다. 그 밖의 열기(`답변하기` 등)는 최신 대화에 놓이고, 패널이
   자리 잡는 동안(부제목이 늦게 와 영역이 줄어도) 최신 대화를 유지한다 — 유저가 패널 안에서 무엇이든 하면(누르기·키·휠·터치, 예: 작업 로그
   펼치기) 그때 끝나서, 그 뒤의 크기 변화(Tasks 갱신, 새 대화)가 읽던 자리를 끌어내리지 않는다. 접혀 있어도 열 때 로그를 받아 오고,
   실시간·복구 항목에 따라 수가 바뀐다. 펼치기는 다시 요청하지 않는다.
   이전 대화는 유저 스크롤로 첫 대화의 위쪽이 스크롤 영역 맨 위에서 100px 안에 들어올 때 한 페이지(30개)씩 불러온다. 들어올 때 한 번
   부르고, 그 구역을 벗어났다가 다시 들어와야 다음 페이지를 부른다 — 그래서 맨 위에 놓이는 열기는 혼자서 아무것도 부르지 않고, 읽던
   위치를 지키는 삽입이 연달아 다음 페이지를 부르지 않는다.
   항목마다 행 전체가 버튼(`role="button"`, `aria-expanded`)이다. 목록은 탭 정지가 하나뿐이다(로빙 tabindex): 처음엔 가장 새 행, 이후엔
   마지막으로 포커스한 행이고, ↑·↓는 한 행씩, Home·End는 처음·끝으로 옮기며, Enter·Space가 펼치고 접는다. Tab은 목록을 빠져나간다. 누르면 그 행 아래에 **원본 출력**이 펼쳐지고 다시 누르면
   접힌다. 항목에 `rawBytes`가 있으면 `GET …/worklog/:seq/raw`를 (대화, seq)마다 한 번만 묻고 그 결과를 패널의 작업 로그 상태에 둔다
   (다른 대화를 열면 버린다). 받는 동안 `원본 출력 불러오는 중…`, 받으면 이스케이프한 `<pre>`(줄바꿈 유지·긴 줄 접기·고정폭, 높이 상한과
   자체 스크롤)와 `복사` 버튼이 보인다. `rawTruncated`면 그 위에 `저장된 앞 256 KiB만 표시 — 원본 <크기>`. `rawBytes`가 없는 항목(서술,
   원본 저장 전의 항목)은 요청 없이 항목 텍스트 전체를 같은 `<pre>`로 보인다. 404 = `원본 출력이 저장되어 있지 않습니다`, 403 = 소유자
   전용 문구, 서버의 503 `{ error: 'unavailable' }` = `로그가 손상되어 원본을 읽을 수 없습니다`(손상된 로그 — 고칠 때까지 같은 답이라
   `다시 시도`가 없고 다시 묻지 않는다). 그 밖의 실패(네트워크 오류, 500·502, 그 코드가 없는 503 — 재시작 중의 프록시 등) =
   `원본 출력을 불러오지 못했어요` + `다시 시도`(다시 요청한다, 결과를 붙잡아 두지 않는다). 목록은 `role="log"`(`aria-live="polite"`)지만 펼친 원본은 `aria-live="off"` 안에 있어 화면 낭독기가 통째로 읽지 않는다. `복사`는 보이는 텍스트를 클립보드에 넣고,
   클립보드를 쓸 수 없으면 텍스트를 선택해 둔다. 접힌 행이나 다른 대화로 늦게 온 응답은 버린다. 펼친 항목이 있는 동안 새 항목이
   붙어도 목록은 맨 아래로 끌려가지 않는다. <640px·터치에서 행·`복사`·`다시 시도`·섹션 머리는 44px 이상이다.
7. 딥링크: `/dashboard/<ownerId>?session=<sessionKey>` → 첫 렌더 후 그 카드를 펼쳐 가운데로 가져오고, 패널을 6항의 `작업 로그` 버튼과
   같은 상태로 연다(작업 로그 접힘, 그 머리가 보이는 맨 위).
   키 찾기: 정확한 키 → 이 인스턴스 접두 키 → `::<키>`로 끝나는 유일한 카드(두 인스턴스에 같은 스레드가 있으면 이 인스턴스, 아니면 포기).
   살아 있는 카드가 없으면 그 스레드의 아카이브 — 키 `[<인스턴스>::]archived_<키>_<archivedAt>` 중 `archivedAt`이 가장 큰 것 — 를 연다.
   살아 있는 카드가 늘 이긴다. 숨은 아카이브(나이 무관)를 가리키면 그 카드 하나만 이 페이지 로드 동안 보이게 하고(저장된 `Archives` 선택은
   바꾸지 않는다) 같은 순서로 연다. 유저가 `Archives`를 누르면 그 예외는 끝난다. 7일 지난 `Sleeping` 카드는 전처럼 `Show older` 묶음을
   펼친다.

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
   여기서 오류 = 유저나 턴에 영향을 주는 오류다. 모델 커맨드 결과 중 유저 대면 오류는 모든 수준에서 Slack에 가고 작업 로그에도 남는다:
   ASK_USER_QUESTION 실패·응답 파싱·연결 실패(커맨드를 알 수 없고 MCP가 끊긴 채 질문하던 #816 모양 — 안 가면 유저는 뜨지 않을 선택 폼을
   기다린다) = `error`, 모델이 볼 수 없는 호스트 측 실패(도구 결과는 ok였다 — UPDATE_SESSION 호스트 적용 실패 = `error`, SET_GOAL 거절 =
   `notice`). 모델이 자기 도구 결과로 받는 실패(인자 오류, 본문 ok의 wire-level `isError`)만 minimal에서 작업 로그 `error`로만 가고,
   Slack에는 `TOOL_CALL` 수준(compact 이상)에서 간다. SET_GOAL 목표 시작·대기 공지(🎯/📋)는 상태 공지라 goal 루프 진행 공지와 같이
   `STATUS_MESSAGE`(compact 이상)에서만 가고 작업 로그 `notice`로 남는다.
   빈 턴 금지: 최종 답변이 아무것도 보여주지 않으면(`finalText` 없음·빈 문자열·지시문뿐·공백뿐, `result` 없음) 마지막으로 보류한
   서술을 최종 답변으로 한 번 보낸다. 예외 = 호스트가 이 턴에 선택 질문 폼을 올렸을 때, 턴이 전송 오류 누출로 끝났을 때(executor가
   복구). 최종 답변을 Slack에 보냈으면 그 턴은 누출로 끝난 턴이 아니다.
4. minimal에서 압축 시작/완료 공지는 Slack에 가지 않는다(작업 로그 `notice`).
5. 남는 Slack 표면(minimal): 스레드 헤더(대시보드 링크 포함) · task list · 최종 답변(+완료 카드) · 선택 질문/승인 · 오류(유저·턴에 영향을 주는 것, 3항).

### 3.3 작업 로그 계약
```ts
// packages/slack/src/work-log.ts — 타입
export type WorkLogKind = 'instruction' | 'narration' | 'tool' | 'tool_result' | 'final' | 'notice' | 'error';
export interface WorkLogInput { kind: WorkLogKind; text: string; tool?: string; ok?: boolean; turnId?: string; ts?: number; raw?: string; rawBytes?: number }
// 목록·WS·appendWorkLog 결과의 모양 — raw 대신 그 크기만 싣는다
export interface WorkLogEntry extends Omit<WorkLogInput, 'raw' | 'rawBytes'> { seq: number; ts: number; rawBytes?: number; rawTruncated?: true }
```
- 방출(packages/slack): `StreamContext.workLog?: (entry: WorkLogInput) => void`. stream-executor가 `session.conversationId`가 있을 때
  `streamExecutorProviders.appendWorkLog(conversationId, entry)`로 묶는다(기본 no-op). 수준과 무관하게 항상 방출:
  `instruction` · `narration`(지시문 제거 후) · `tool`(도구명 + 입력 요약 ≤200자) · `tool_result`(도구명 + `ok`) · `final` · `notice` · `error`.
  `raw` = 한 줄 `text` 뒤의 원문 전체: `tool`은 입력 전체 `JSON.stringify(input, null, 2)`(실패 시 `String(input)`), `tool_result`는
  결과 content — 문자열은 그대로, 블록 배열은 text 블록의 text · 이미지 `[image]` · 그 밖의 블록 JSON을 `\n`으로 이음, 그 밖의 객체는
  pretty JSON, undefined/null이면 raw 없음. 블록 배열은 이은 크기가 256 KiB를 넘으면 더 잇지 않고, 그때 입력 `rawBytes`에
  전체 결과의 UTF-8 크기를 싣는다(나머지 블록은 크기만 잰다).
- 저장(`src/conversation/work-log.ts`): `${DATA_DIR}/worklogs/<conversationId>.jsonl` 추가 전용, 항목 text ≤ 4000자(`WORK_LOG_TEXT_MAX`).
  `seq`는 대화마다 엄격히 증가하되 건너뛸 수 있다(사이드카가 `WORK_LOG_SEQ_RESERVE_BLOCK` = 1000개 단위로 예약, 재기동은 예약 지점에서 재개).
  `appendWorkLog(conversationId, input) → Promise<WorkLogEntry>`는 디스크 기록 후 resolve하고 그때 WS로 방송한다.
  `readWorkLog(conversationId, { afterSeq?, limit = 500 }) → { entries, hasMore }`.
- raw 저장: 항목 줄과 별도인 `${DATA_DIR}/worklogs/<conversationId>.raw.jsonl`(추가 전용, 다시 쓰지 않음)에 한 줄 한 레코드
  `{"seq":N,"raw":"…"}`로 둔다. raw는 `WORK_LOG_RAW_MAX_BYTES` = 256 KiB(UTF-8, 서로게이트 쌍을 가르지 않음)로 자른다.
  항목 줄에는 `rawBytes`(잘리기 전 원문의 UTF-8 바이트 수, 입력 `rawBytes`가 더 크면 그 값) · `rawTruncated: true`(잘렸을 때만) ·
  `rawOffset`/`rawLen`(raw 파일 안 레코드의 바이트 위치·길이)만 싣는다 — 항목 줄은 작게(text ≤ 4000자) 남아 목록 창(최대 500개)이
  스캔 예산 안에 다 들어온다. 레코드를 fdatasync(새 raw 파일이면 디렉터리도 sync)한 뒤에 그것을 가리키는 항목 줄을 쓴다.
  raw 쓰기가 실패해도 항목은 raw 없이(`rawBytes` 없이) 발행된다. raw 없이 4000자를 넘는 `text`가 오면 자르기 전 전문을 raw로
  보관한다. `rawBytes`가 없는 항목 = raw 없음(raw 도입 전 항목 전부). 로그 격리(`.corrupt-`)는 항목 로그만 옮기고 raw 파일은 둔다.
  `readWorkLogRaw(conversationId, seq) → { seq, raw, rawBytes, rawTruncated: boolean } | null | 'budget'`: `rawOffset`에서 정확히
  `rawLen` 바이트를 읽어 레코드의 seq가 항목과 같아야 쓴다. 파일 없음·짧은 읽기·파싱 실패·seq 불일치 = raw 없음(warn 1회).
  스캔 예산 안에 항목을 찾지도 배제하지도 못하면 `'budget'`.
- API(`src/conversation/work-log-routes.ts`): `GET /api/dashboard/session/:conversationId/worklog?afterSeq=&limit=` → `{ entries, hasMore }`.
  afterSeq 없음 = 마지막 limit개(hasMore = 더 오래된 것 있음), afterSeq=N = N 뒤 첫 limit개(hasMore = 더 있음). limit 1..500.
  형식이 틀린 파라미터 = 400, 모르는 대화 = 404, 소유자·관리자 외 = 403(소유자 없는 대화 = 관리자만).
  목록 항목에는 `raw`도 그 위치(`rawOffset`/`rawLen`)도 실리지 않는다(`rawBytes`·`rawTruncated`만).
- raw API: `GET /api/dashboard/session/:conversationId/worklog/:seq/raw` → 200 `{ seq, raw, rawBytes, rawTruncated }`.
  인증·대화 확인은 목록 API와 같다(미인증 401, 모르는 대화 404, 소유자·관리자 외 403). `:seq`는 1 이상 10진 정수, 아니면
  400 `{ error: 'bad_request' }`. 항목이 없거나 raw가 없거나 레코드를 쓸 수 없으면 404 `{ error: 'not_found' }`(영구).
  로그가 스캔 예산으로 지나갈 수 없게 손상돼 항목을 찾지도 배제하지도 못하면 503 `{ error: 'unavailable' }` — 로그는 끝에만
  자라므로 복구 전까지 같은 답이다. 클라이언트는 "unavailable"을 보여주고 자동 재시도하지 않는다. 모든 응답(401, 리다이렉트
  포함)에 `Cache-Control: no-store`.
- WS: `{ type: 'work_log', conversationId, entry }`, `conversation_update`와 같은 소유자/관리자 범위로 방송. `entry`는 목록 항목과
  같은 모양 — `rawBytes`·`rawTruncated`만 싣고 `raw`와 그 위치는 싣지 않는다.

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
1·2·3·5와 6의 로그인 페이지·`soma_next` 쿠키를 실측했다(6의 SSO 착지는 유닛 테스트 `login-return.test.ts`). 대상 `t1`은
2026-10-19 유저 지시로 이 출고 범위에서 빠졌다([`agent-inbox/ssot.md`](agent-inbox/ssot.md) §스코프 변경) — 러너가 오프라인이라
v0.2.1159는 t1에 배포되지 않았고, t1의 3a 1회 이관도 아직 돌지 않았다. prod(`deploy/prod`)는 유저 게이트다.

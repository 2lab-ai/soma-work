# 37 — 작업 큐 아키텍처

Status: shipped · v1 2026-11-19 · v2 2026-11-26(work-queue/loop.done.md R4, 실측 통과)

> 한 줄 결론: 줄 규칙(키 겹침 · 순서 · 내역 · 보기)은 `somalib/work-queue/line.ts` 하나다. 레인 원장(`ledger.ts`, SQLite 한 행,
> MCP 프로세스와 호스트가 함께 쓴다)과 사람마다의 줄(`src/user-task-queue`, 호스트 안 · 인그레스 동기 판정)이 그 규칙을
> 쓴다. 호스트의 `WorkQueueHost`가 레인 차례를 깨우고 일 안 하는 차례를 돌려놓고 관리자 조작을 받는다. 대시보드는
> `GET /api/dashboard/work-queues` 하나로 두 종류를 같은 모양으로 읽어 보드의 작업 큐 칸과 설정 탭에 그린다.

## 0. 미니맵

```
37 작업 큐 아키텍처
├─ 1. 모듈 배치
├─ 2. 줄 규칙 line.ts
├─ 3. 레인 원장 — 모양 · 전이 · 저장 · v1 이전
├─ 4. MCP 서버 work-queue
├─ 5. 호스트 WorkQueueHost — 깨우기 · 반납 · 관리 · 보기
├─ 6. 사람마다의 줄 — 키 · 같은 작업 거절 · 내역 · 보기
├─ 7. 대시보드 — 보기 API · 작업 큐 칸 · 설정 탭
├─ 8. 레인 소비자 · 공통 규칙
└─ 9. 테스트 지도
```

스펙(무엇 · 왜)은 [36-work-queue-spec.md](36-work-queue-spec.md).

## 1. 모듈 배치

```
somalib/work-queue/                    ← 줄 규칙과 레인 원장의 유일한 본문 (MCP는 @soma/process-shared/work-queue 재export)
  keys.ts        parseWorkKeys(raw[]) · keysInText(text)                                   D10
  config.ts      normalizeQueueName · isQueueName · parseWorkQueuesConfig(고정 레인) · readPinnedQueuesFromConfigFile  D2
  line.ts        LineItem · claimsOn/splitKeys · waitingPlace · LineRecord/appendRecords · LineQueueView  D1 D4 D12
  ledger.ts      레인 전이: enterQueue(wait|try) · endEntry · releaseByHost · putFirst · markNotified · queueViews · parseWorkQueueLedger(v1→v2)
  store.ts       WorkQueueStore (node:sqlite, BEGIN IMMEDIATE)                              D5
  memory-store.ts  테스트용 같은 계약
packages/mcp-servers/work-queue/       queue_list · queue_try · queue_enter · queue_done · queue_cancel
src/work-queue/
  host.ts        WorkQueueHost: tick · wake · sweep · statusFor · awaitsHost · whenFree · manage · views
  host-wait.ts   hostWaitFor · waitsOnHost (보드 · 목표 루프 · 후속 질문의 한 술어)
src/user-task-queue/
  ledger.ts      UserTaskEntry(+keys) · UserTaskLedger(+records) · lineItemOf · recordOf
  user-task-queue.ts  gate(+same-work) · lineView · startSameWork · 내역 기록
  slack-notice.ts / slack-surface.ts  같은 작업 안내 + 그래도 시작 버튼
src/conversation/
  work-queue-view.ts    buildWorkQueuesView — 읽는 사람에 맞춘 이름 · 비공개 가림                D16
  work-queue-client.ts  보드 작업 큐 칸 (CSS · ES5 스크립트)                                    D14
  dashboard.ts          GET/POST /api/dashboard/work-queues · renderBoard가 대기 카드를 칸에서 뺀다 · 마크업
  settings-task-queue-tab.ts  레인 큐와 내역
src/prompt/common.prompt     ## Waiting your turn                                              D15
```

## 2. 줄 규칙 — `line.ts`

- `LineItem {id, keys, state: running|waiting, holder {user, channel, threadTs}, enteredAt}` — 두 엔진의 항목이 이 모양으로 보인다
  (레인 항목은 그대로, 개인 항목은 `lineItemOf`: `admitted` = 자리를 잡은 것이니 running).
- `claimsOn(live, keys)` · `splitKeys(live, keys) → {free, claimed}` — 키마다 그 키를 처음 가진 산 항목.
- `waitingPlace(items, id)` — 대기 중 몇 번째(1부터), 진행 · 없음은 0.
- `LineRecord {id, queue, keys, holder, label?, enteredAt, startedAt?, endedAt, end, reason?}`, `end` =
  `started | done | cancelled | released | refused`. `appendRecords`가 최근 200개만 남긴다.
- `LineQueueView {id, kind: lane|person, capacity, running, waiting, recent}` — 보드 · 설정 · `queue_list`가 쓰는 모양.
  개인 큐 id는 `user:<id>`.

## 3. 레인 원장

### 3.1 모양 — `DATA_DIR/work-queues.sqlite3` 한 행(JSON)

```ts
interface WorkQueueLedger { version: 2; seq: number; entries: WorkQueueEntry[]; records: LineRecord[] }
interface WorkQueueEntry {
  id: string;            // wq-<seq>
  queue: string;         // "qa-dev2"
  keys: string[]; holder: LineHolder; note?: string;
  state: 'running' | 'waiting';
  enteredAt: number; grantedAt?: number; notifiedAt?: number;
}
```

### 3.2 전이 (순수, `now` 주입)

- `enterQueue(ledger, {queue, keys, holder, note, mode}, now)` — 이름 정규화(`INVALID_QUEUE`) → 키(`INVALID_KEYS` · `NO_KEYS` ·
  `TOO_MANY_KEYS`) → 이 스레드가 이 레인에 항목이 있나(`ALREADY_IN_QUEUE`) → 겹침(`CONFLICT {conflicts, free}`) → 진행이 없으면
  `running`(`grantedAt = notifiedAt = now`), 있으면 `mode: 'try'`는 `busy`(원장 그대로), `wait`는 `waiting`. 답에 `position` ·
  `ahead` · `created`(그 레인의 항목도 내역도 없었다).
- `endEntry(ledger, {id, end, actor: holder|'host'|'admin', reason}, now)` — 주인만(호스트 · 관리자는 아무것이나). 항목을 내역으로,
  같은 레인을 `promote`. 끝난 번호면 `ALREADY_ENDED`.
- `releaseByHost` — 호스트 정리의 결정을 한 번에. `putFirst(ledger, id)` — 대기 항목을 그 레인 대기 줄 맨 앞으로(`NOT_WAITING`).
- `queueViews(ledger, pinned, recent)` — 고정 레인 먼저(비어 있어도), 그다음 항목이나 내역이 있는 레인을 이름순.

### 3.3 저장과 v1 이전

`WorkQueueStore`(v1과 같다: WAL, `BEGIN IMMEDIATE`, OS 잠금, Node 22.5 미만이면 큐 꺼짐). `load`가 `parseWorkQueueLedger`로 읽는다:
v2는 그대로, v1(`version: 1`)은 이름을 `normalizeQueueName`으로(`qa:dev2` → `qa-dev2`), `queued` → `waiting`, `ended` → `records`
(`grantedAt` → `startedAt`, `note` → `label`)로 옮긴다. 다음 변경이 v2로 쓴다. 모양이 틀리면 오류(빈 원장으로 읽지 않는다).

## 4. MCP 서버 `work-queue`

- 맥락: `SOMA_WORK_QUEUE_CONTEXT`(부모가 정한 스레드), `SOMA_DATA_DIR`, `SOMA_CONFIG_FILE`(고정 레인만 — 못 읽으면 마지막으로 잘
  읽은 목록, 처음이면 없음. 레인 사용은 막지 않는다).
- 도구 다섯(§36 4.1). 답은 JSON + `next` 한 줄: `running` → 시작하고 끝나면 `queue_done`; `queued` → 턴을 끝내라, 호스트가 깨운다,
  폴링 · 크론 · 질문 금지; `busy` → 다른 일을 먼저 하거나 `queue_enter`; `CONFLICT` → `free`만으로 다시, 없으면 할 일 없음;
  `created` → 다른 이름으로 같은 레인이 있는지 `queue_list`.
- `queue_enter` 설명: "스킬이 레인에 잡으라고 하는 잠금을 대신한다 — 바쁜 레인은 기다림이지 멈춤 · 질문의 이유가 아니다".

## 5. 호스트 `WorkQueueHost`

v1의 틱(3 s) · 깨우기 · 정리(15 s) · `statusFor` · `awaitsHost` · `whenFree`는 그대로(상태 이름만 `waiting`). 더해진 것:

- `pinned` 의존(설정의 고정 레인), `views(pinned?)` → `LineQueueView[]`.
- `manage(id, 'cancel' | 'first' | 'release', by)` → `{ok} | {ok: false, code: UNKNOWN_ENTRY | NOT_WAITING | NOT_RUNNING}`.
  `cancel`/`release`는 `endEntry(actor: 'admin', reason: 'admin:<by>')`, `release`면 주인 스레드에 `⏹ … (관리자가 돌려놓음)`, 그
  뒤 깨우기 · `whenFree` 정리. `first`는 `putFirst`.

## 6. 사람마다의 줄

- 인그레스 게이트(`SlackHandler.handleMessage`의 유휴 디스패치 직전)는 그대로다. `gate()`에 단계 하나가 더해졌다: 사람의 요청
  (`continuation: none`, 크론 아님, `synthetic` 아님, `sameWorkOk` 아님)이면 `keysInText(text)`를 이 사람의 다른 스레드의 진행
  작업(`RunningTask.keys`) · 대기 항목과 `splitKeys`. 키가 있고 전부 잡혀 있으면 `{action: 'same-work', keys, claims}` — 아무것도
  시작하지 않고, 내역에 `refused`, 알림 `refused(thread, claims, token)`, 요청 원문은 메모리에 30분(`startSameWork(token, by)`가
  `routeContext.userTaskSameWorkOk`를 달아 인그레스로 다시 보낸다 — 호스트만 붙이는 필드).
- `RunningTask.keys` = 그 스레드의 요청들이 낸 키(`SlackHandler.userTaskKeys`, 메모리, 스레드 2,000개까지) ∪ 작업 카드의 이슈 · PR
  링크(`session.links`).
- 대기 항목은 `keys`를 갖고, 원장(`user-task-queue.json`)은 `records`를 갖는다(둘 다 없는 옛 파일도 읽는다). 내역: 차례가 와
  시작(`started`, `reason: turn|bypass`), 대기 취소(`cancelled`, `person|admin`), 세션 종료(`cancelled`, `closed`).
- `lineView(userId)` → `LineQueueView`(진행 = 살아 있는 턴 + 들어가는 중인 항목, 대기, 내역).

## 7. 대시보드

- `GET /api/dashboard/work-queues` → `{lanes, people, canManage, at}`(`work-queue-view.ts`). 사람 목록 = 대기 항목이 있거나, 지난
  24시간에 내역이 있거나, 지금 작업 중인 세션의 주인. 이름 · 카드 키 · 스레드 링크는 세션에서, 비공개 채널의 작업은 주인 ·
  관리자 · 뷰어 토큰에만(아니면 `비공개 작업`, 키 · 링크 없음).
- `POST /api/dashboard/work-queues/:entry/:action` — `cancel`(주인 또는 관리자 모드), `first` · `release`(관리자 모드),
  `host.manage` 뒤 보드 푸시.
- 작업 큐 칸(`work-queue-client.ts`): 마크업은 `dashboard.ts`에서 크론 칸 바로 아래(`#wq-section`, `<ui-tabs id="wq-tabs">`의 두
  슬롯 `lanes` · `people`). `renderBoard`가 크론 계획 뒤 `wqSplitBoard(rest)`로 레인에서 기다리는 카드를 칸에서 빼고, 대기큐
  줄은 응답 필요에 넣지 않는다. 칸을 그린 뒤 `paintWorkQueues(byLane, uq.line)`: 레인마다 상자 하나에 `<ui-agent-inbox
  view="list">`(크론 칸과 같은 방식, `placeCard`), 사람마다 대기큐 카드(`uqPlace`). 레인 카드의 관리자 버튼은 카드의
  `actions`(`wq-first` · `wq-cancel`) → `wireInbox`의 `ui-action` → `wqCardAction`. 데이터는 15초 폴링 + 보드가 그려진 뒤 3초가
  지났으면 다시 읽기 + 조작 뒤 다시 읽기. 접기는 `localStorage soma-sec-wq`(기본 펼침).
- 설정 탭: `loadTaskQueue`가 `loadTaskQueueLanes`(같은 보기 API)도 부른다. `tqLaneHtml`이 레인마다 지금과 내역 표를 그린다.

## 8. 레인 소비자 · 공통 규칙

- `deploy.prompt`: 큐 이름 `deploy-<대상>`. `QUEUE_UNAVAILABLE`만 줄 없이. `created`면 `queue_list`로 다른 철자를 본다. 나머지는
  v1과 같다(PR 키, 확인 전 줄 서기, 끝 = `queue_done`).
- `deploy-qa`: 레인 `qa-<대상>`. 레인이 QA의 배타성이다 — 감싸는 환경 스킬이 자기 잠금을 잡고 바쁘면 멈추라고 해도 먼저 이
  레인에 줄을 서고, 그 잠금은 항목이 진행일 때만 잡는다.
- `common.prompt` `## Waiting your turn`(D15).

## 9. 테스트 지도

| 층 | 파일 | 무엇 |
|---|---|---|
| 줄 규칙 | `somalib/work-queue/line.test.ts` · `keys.test.ts` · `config.test.ts` | 겹침 · 자리 · 내역 상한, 글에서 키 읽기, 레인 이름 |
| 레인 원장 | `somalib/work-queue/ledger.test.ts` · `store.test.ts` | A1–A5 · A12 · A13, putFirst, v1 → v2, 다중 프로세스 쓰기 |
| MCP | `packages/mcp-servers/work-queue/work-queue-mcp-server.test.ts` | 다섯 도구, 설정 없는 레인, try, `free`, 고정 레인 |
| 호스트 | `src/work-queue/__tests__/host.test.ts` · `host-wait.test.ts` | 깨우기 · 반납 · 관리(A16) · 보기 |
| 개인 줄 | `src/user-task-queue/__tests__/user-task-queue.same-work.test.ts` · `slack-surface.test.ts` · `src/__tests__/slack-handler.user-task-queue.test.ts` | A14, 내역, lineView, 그래도 시작, 인그레스 통합 |
| 대시보드 | `src/conversation/__tests__/work-queue-view.test.ts` · `dashboard-work-queues.test.ts` · `work-queue-client.test.ts` · `dashboard-user-queue-client.test.ts` · `settings-task-queue-tab.test.ts` | 보기 · 비공개, 라우트 권한, 칸 위치 · 카드 이동 · 막대, 설정 내역 |
| 소비자 | `src/__tests__/prompt-builder.test.ts` · `src/local/skills/deploy-qa/__tests__/deploy-qa-skill.test.ts` · `prompt-budget.test.ts` | 큐 이름 · 설정 없는 레인 · 잠금 대신 레인 |

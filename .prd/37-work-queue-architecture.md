# 37 — 작업 큐 아키텍처

Status: in-progress · 2026-11-19 소유자 dev 호스트 배포(v0.3.97-dev), 고객 dev 호스트는 2026-11-20 정기 배포 — 남은 실측은 work-queue/loop.md

> 한 줄 결론: 원장(순수 전이 + SQLite 트랜잭션 저장)은 `somalib/work-queue`에 하나만 있다(MCP 서버는
> `@soma/process-shared/work-queue` 재export로 닿는다). MCP 프로세스(`packages/mcp-servers/work-queue`)는 그 원장으로 줄
> 서기 · 끝내기를 그 자리에서 처리하고, 호스트(`src/work-queue/host.ts`)는 같은 원장을 3초마다 읽어 차례가 온 세션을 깨우고, 일 안 하는 차례를
> 돌려놓고, 보드 · 목표 루프 · 후속 질문 · hand-off에 "이 세션은 호스트를 기다린다"를 알려 준다.

## 0. 미니맵

```
37 작업 큐 아키텍처
├─ 1. 모듈 배치 (새로 · 바뀜 · 지움)
├─ 2. 원장 — 모양 · 전이 · 잠금
├─ 3. MCP 서버 work-queue
├─ 4. 호스트 WorkQueueHost — 틱 · 깨우기 · 반납 · 읽기
├─ 5. hand-off와 이어 붙이기
├─ 6. 보드 · 목표 루프 · 후속 질문
├─ 7. 레인 소비자 — deploy.prompt · deploy-qa
└─ 8. 테스트 지도
```

스펙(무엇 · 왜)은 [36-work-queue-spec.md](36-work-queue-spec.md).

## 1. 모듈 배치

```
somalib/work-queue/                          ← 원장의 유일한 본문 (호스트가 import, MCP는 process-shared 재export로)
  keys.ts        parseWorkKeys(raw[]) → {keys, invalid}          D10
  config.ts      parseWorkQueuesConfig(raw) → {queues, warnings}  §4.4 (예전 배열 모양 포함)
  ledger.ts      순수 전이: enter · end · sweep 결과 적용 · 보기       D3 D5
  store.ts       WorkQueueStore: read() · mutate(fn) · stamp() (node:sqlite, BEGIN IMMEDIATE)  D4
packages/mcp-servers/work-queue/
  work-queue-mcp-server.ts   queue_list · queue_enter · queue_done · queue_cancel
src/work-queue/                               ← 호스트 쪽 (예전 packages/slack/src/work-queue 게이트는 지움)
  host.ts        WorkQueueHost: tick · wake · sweep · statusFor · awaitsHost · whenFree
  host-wait.ts   hostWaitFor · waitsOnHost — 보드 · 목표 루프 · 후속 질문의 한 술어
src/
  mcp-config-builder.ts      work-queue 서버 + SOMA_WORK_QUEUE_CONTEXT · allowedTools
  internal-mcp-server-resolver.ts  'work-queue'
  index.ts                   WorkQueueHost 조립 (settled delivery · 세션 탐침 · 설정 경로)
  slack/commands/skill-force-handler.ts  hand-off 추적(시작 · 환경 세션 · 끝) + 끝 = whenFree
  slack/env-handoff-runs.ts  요청 세션 → 진행 중인 hand-off (메모리)
  slack-handler.ts           후속 질문 보류 = awaitsHost
  slack/goal-loop-controller.ts  awaitingHostWork (그대로 — 술어만 바뀜)
  conversation/dashboard.ts  queueWait → 카드 상태 · 보라 태그
```

지움: `packages/slack/src/work-queue/{manager,service,blocks,trigger,registry,config,index}.ts`와 그 테스트(+ `@soma/slack/work-queue` export),
`SessionInitializer`의 `workQueue` 게이트, 액션 `work_queue_wait` · `work_queue_cancel`, `ConversationSession.workQueueId`,
`src/slack/env-run-queue.ts`(+ 테스트). `config-loader`의 `workQueues` 통과는 그대로(모양은 `parseWorkQueuesConfig`가 정한다).

## 2. 원장

### 2.1 모양 — `DATA_DIR/work-queues.sqlite3`의 한 행(JSON)

```ts
interface WorkQueueLedger { version: 1; seq: number; entries: WorkQueueEntry[]; ended: WorkQueueEnded[] }
interface WorkQueueEntry {
  id: string;              // wq-<seq>
  queue: string;           // "qa:dev2"
  keys: string[];          // 정규화된 키
  holder: { user: string; channel: string; threadTs: string };
  note?: string;
  state: 'running' | 'queued';
  enteredAt: number;
  grantedAt?: number;      // running이 된 시각
  notifiedAt?: number;     // 주인에게 차례를 알린 시각 (바로 running이면 enteredAt)
}
interface WorkQueueEnded extends WorkQueueEntry { endedAt: number; end: 'done' | 'cancelled' | 'released'; reason?: string }
```

`ended`는 최근 50건만(보기용). 큐 이름별로 나누지 않고 한 목록에 둔다 — 항목은 많아야 수십 건이다.

### 2.2 전이 (순수 함수, `now` 주입)

- `enterQueue(ledger, req, queues, now)` — 검사 순서: 큐가 설정에 있나(`UNKNOWN_QUEUE`) → 키 정규화(`INVALID_KEYS`,
  `NO_KEYS`, 50개 상한) → 이 스레드가 그 큐에 이미 항목이 있나(`ALREADY_IN_QUEUE`) → 같은 큐의 진행 · 대기 항목과 키가
  겹치나(`CONFLICT`, 키마다 항목 하나). 통과하면 항목을 더하고, 큐에 진행이 없으면 바로 `running`
  (`grantedAt = notifiedAt = now`), 아니면 `queued`. 답에 `position`(대기 중 몇 번째) · `ahead`(앞 항목 요약).
- `endEntry(ledger, id, end, actor, now)` — `actor`가 `holder`면 주인 스레드만. 항목을 `ended`로 옮기고 같은 큐를
  `promote`. 이미 끝난 번호면 `ALREADY_ENDED`(끝난 방식 · 이유), 모르는 번호면 `UNKNOWN_ENTRY`.
- `promote(ledger, queue, now)` — 진행이 없고 대기가 있으면 가장 먼저 들어온 대기를 `running`(`grantedAt = now`,
  `notifiedAt` 없음 → 호스트가 깨운다).
- `releaseByHost(ledger, decisions, now)` — 호스트 정리의 결정(항목 번호 → 이유)을 한 번에 적용하고 promote.
- 보기: `queueViews(ledger, queues)`, `entriesOf(ledger, holder)`.

### 2.3 저장 — `WorkQueueStore` (`node:sqlite`)

- 표 하나 `ledger(id = 1, rev, body)`: 원장 전체가 JSON 한 행이다(전이는 순수 함수 그대로). WAL 모드, `busy_timeout` 5 s.
- `mutate(fn)`: `BEGIN IMMEDIATE` → 읽기 → `fn` → 바뀌었으면 `body` 쓰기 + `rev + 1` → `COMMIT`. 던지면 `ROLLBACK`.
  쓰는 쪽끼리는 SQLite 파일 잠금이 줄 세운다. 그 잠금은 OS가 프로세스 종료 때 푼다 — 오래된 잠금 · 탈취 · 복구 가드 ·
  백업 파일이 없다. 새 파일을 여러 프로세스가 동시에 처음 열 때 WAL 전환이 즉시 `locked`로 실패할 수 있어(SQLite의 교착
  회피 규칙) 열기 설정만 마감(5 s) 안에서 다시 시도한다.
- `read()`: 커밋된 원장(WAL이라 쓰는 중에도 기다리지 않는다). 행이 없으면 빈 원장. 모양이 틀리면(레코드 하나라도) 오류 —
  빈 원장으로 떨어뜨리지 않는다(rules/config.md 4).
- `stamp()`: `rev`. 커밋마다 바뀐다 — 호스트는 바뀌었을 때만 다시 읽는다.
- `node:sqlite`는 Node 22.5부터다. 그보다 낮은 런타임(CI의 Node 20, 옛 Docker 이미지)에서는 공유 원장을 둘 수 없으므로 작업 큐를
  끈다: 호스트는 `WorkQueueHost`를 만들지 않고, 도구는 `QUEUE_UNAVAILABLE`(줄 없이 진행)을 답한다. 호스트 · MCP 테스트는 같은
  계약의 메모리 저장소(`memory-store.ts`)로 돌아 모든 런타임에서 규칙을 검사하고, SQLite 저장소 테스트만 그 런타임에서
  건너뛴다(metrics 저장소와 같은 방식).

처음 구현(2026-11-19 R0–R2)은 JSON 파일 + 직접 만든 잠금 파일이었다. 리뷰가 오래된 잠금 탈취에서 PID 재사용 · 복구 경합을
거듭 찾아 SQLite로 옮겼다(.prd/36 D4).

## 3. MCP 서버 `work-queue`

- 맥락: `SOMA_WORK_QUEUE_CONTEXT = {user, channel, threadTs}`(부모가 만든다 — 모델이 바꿀 수 없다), `SOMA_DATA_DIR`,
  `SOMA_CONFIG_FILE`. 설정은 호출마다 `config.json`의 `workQueues`를 읽는다(mtime 캐시) — 재시작 없이 반영(A9). 못 읽으면
  마지막으로 잘 읽은 설정을 쓰고 다음 호출에 다시 읽는다. 처음부터 못 읽으면 `CONFIG_UNREADABLE`(다시 부르라) — "큐 없음"으로
  읽어 줄 없이 진행시키지 않는다.
- 도구 네 개(§36 4.1). 답은 JSON 한 덩어리 + 모델이 바로 할 일 한 줄(`next`):
  - `running` → "지금 시작하라. 끝나면 `queue_done`."
  - `queued` → "턴을 끝내라. 차례가 오면 호스트가 이 스레드를 깨운다. 기다리며 폴링 · 크론 · sleep · 사람에게 묻기 금지."
  - `CONFLICT` → "겹친 키는 이미 다른 항목이 맡았다(진행 · 대기). 그 키를 빼고 나머지로 다시 `queue_enter`. 다 겹치면 할
    일이 없다 — 그렇게 보고하고 멈춘다."
- 큐가 하나도 설정되지 않은 호스트: 모든 도구가 `NO_QUEUES` + "이 호스트에는 작업 큐가 없다 — 줄 없이 진행".

## 4. 호스트 `WorkQueueHost`

의존(주입): `store`, `probe(holder) → {exists, activity, activityChangedAt, handoffActive}`,
`deliver(holder, text, done)`(settled delivery), `post(holder, text)`, `now`. 큐 설정은 필요 없다(원장 항목만 본다).

- **틱(3 s)**: `store.mtimeMs()`가 바뀌었거나 정리 주기(15 s)가 됐으면 읽는다.
  1. 깨우기: `running`이고 `notifiedAt`이 없고 아직 보내는 중이 아닌 항목 → `deliver`. 결과 `injected` → `mutate`로
     `notifiedAt = now`. `gone` → 그 항목 반납(`holder-gone`). 보내는 중인 번호는 메모리에 둔다(두 번 보내지 않게).
  2. 정리(15 s마다, 원장을 늘 다시 읽는다): 대기 항목의 주인이 없으면 뺀다. 진행 항목(깨웠든 아직 깨우는 중이든)은 D7
     규칙으로 본다: 턴이 돈다(6 h 상한) · hand-off가 돈다 · 사람 답을 기다린 지 10분 미만 · 쉰 지 5분 미만. 시계의 시작 =
     max(활동이 바뀐 시각, 마지막 hand-off가 끝난 시각, `notifiedAt` 또는 `grantedAt`, 이 호스트가 뜬 시각) — 재시작은 쉰
     시간이 아니다. 아니면 반납(`holder-idle` / `holder-asking` / `holder-stuck` / `holder-gone`) + 스레드에 `⏹` 한 줄,
     기다리던 깨우기는 더는 유효하지 않다(`current` = false). 깨우기가 만료(`wake-expired`)돼도 같은 반납 + `⏹`.
  3. `whenFree` 대기자 풀기, 캐시 갱신.
- **읽기**(보드 · 목표 루프 · 후속 질문 · hand-off): 마지막으로 읽은 원장에서.
  - `statusFor(channel, threadTs) → {queue, entry, state, position, keys, since} | undefined`
  - `awaitsHost(channel, threadTs)` = 대기 항목이 있다.
  - `whenFree(channel, threadTs): Promise<void>` = 그 스레드의 항목이 하나도 없고 그 턴이 돌고 있지 않으면 풀린다(깨운 턴이
    `queue_done` 뒤 마무리를 쓰는 중에 hand-off가 끝나지 않게).
- 시작: `start()`가 틱을 켠다(unref). 큐가 설정되지 않아도 켠다(설정은 실행 중에 더할 수 있다).

## 5. hand-off와 이어 붙이기

`src/slack/env-handoff-runs.ts` — 요청 스레드 → `{owner, since, envThread?}`(메모리). `runAsEnvironmentUser`가
시작에 넣고, `onOpened(rootTs)`에 환경 세션 스레드를 적고, 끝에 뺀다. 끝 = `run()`(환경 유저의 첫 턴)이 끝나고
`workQueueHost.whenFree(channel, rootTs)`가 풀렸을 때(D9). 그 뒤에 `⏹` · 호스트 턴(지금과 같다).

요청 세션의 기다림 상태 = hand-off가 돌면: 환경 세션 스레드의 큐 상태가 있으면 그것(대기 → 보라), 없으면 "환경 작업
중". 이 추적은 메모리다: 재시작 때 도는 hand-off는 어차피 끊긴다(환경 세션은 재시작 재개로 이어 가고, 요청 세션은
결과를 받지 못한다 — 지금과 같은 한계).

## 6. 보드 · 목표 루프 · 후속 질문

- 술어 하나: `waitsOnHost(sessionKey)` = 대기 항목이 있다 OR hand-off가 돈다. `GoalLoopController.awaitingHostWork`와
  `SlackHandler.askFollowUpQuestion`의 보류가 이것을 쓴다.
- 보드: `KanbanSession.queueWait = {kind: 'queued' | 'running' | 'env', queue?, position?, since}`(세션이 working이 아닐
  때만). 서버는 이것이 있으면 RUNNING 칸에 둔다. 클라이언트 `pendingQueueWait` · `queueWaitLabel`:
  `queued` → "큐 대기 · qa:dev2 · #2"(보라, `--card-queue`), `running` → "qa:dev2 진행 중"(파랑), `env` → "환경 작업 중".

## 7. 레인 소비자

- `deploy.prompt`: Delta and Risk Check로 범위의 PR(머지 커밋의 PR 번호)을 안 뒤, 확인 질문 전에
  `queue_enter {queue: "deploy:<대상>", keys: [owner/repo#n …]}`. `CONFLICT` → 겹친 PR은 다른 배포가 싣고 있다 — 빼고
  다시, 다 겹치면 "이미 배포 중"으로 끝. `queued` → 한 줄 알리고 턴 끝(깨우면 Delta Check부터 다시). 배포가 끝나면
  (`deploy-state.json` `done`) `queue_done`. 큐가 없는 호스트(`NO_QUEUES`)면 줄 없이 지금처럼.
- `deploy-qa`: 잠금 전에(full run) 1–5단계를 읽기만으로 하고, 받아들인 대상 키로 `queue_enter {queue: "qa:<대상>"}`.
  겹친 키 → 그 키 `deferred`, 이유 `in QA in another run (<entry>)`, 빼고 다시. 다 겹침 → `deployed, QA not needed: every
  key is in QA in another run`. `queued` → `deployed, QA queued: qa:<대상> #<n>`로 턴 끝(잠금 · 대기 · 질문 없음); 깨우면
  같은 인자 + `keys=<낸 키>`로 다시 시작. `running` → 잠금을 잡고 지금처럼. 끝(보고 뒤) → `queue_done`. 큐를 쓰는
  실행은 잠금이 바빠도 기다리지 않는다(큐 밖 실행 → 바로 `lock busy` carry).

## 8. 테스트 지도

| 층 | 파일 | 무엇 |
|---|---|---|
| 원장 | `somalib/work-queue/{keys,config,ledger,store}.test.ts` | A1–A4 · A9의 전이, 다중 프로세스 동시 쓰기(유실 0) · 롤백 · 모양 틀린 원장 |
| MCP | `packages/mcp-servers/work-queue/work-queue-mcp-server.test.ts` | 도구 입출력 · 주인 검사 · `NO_QUEUES` · 설정 다시 읽기 |
| 호스트 | `src/work-queue/__tests__/{host,host-wait}.test.ts` · `src/slack/__tests__/env-handoff-runs.test.ts` | A5–A8: 깨우기 한 번 · `gone` 반납 · 반납 규칙 · 재시작 뒤 깨우기 · `whenFree` |
| hand-off | `src/slack/commands/__tests__/skill-force-handler-env-handoff.test.ts` | A10 · A11(동시 시작) |
| 보드 | `src/conversation/__tests__/dashboard-auto-resume*.test.ts` · `card-finish-client*.test.ts` | 칸 · 라벨 · 보라 |
| 목표 · 후속 | `goal-loop-controller.test.ts` · `slack-handler.followup.test.ts` | 보류 |
| 조립 | `mcp-config-builder-internal-servers.e2e.test.ts` · `packages-srp-phase0-contract.test.ts` | 서버 등록 |

# 37 — 작업 큐 아키텍처

Status: in-progress

> 한 줄 결론: 원장(순수 전이 + 파일 잠금 저장)은 `@soma/process-shared/work-queue`에 하나만 있다. MCP 프로세스
> (`packages/mcp-servers/work-queue`)는 그 원장으로 줄 서기 · 끝내기를 그 자리에서 처리하고, 호스트
> (`packages/slack/src/work-queue/host.ts`)는 같은 원장을 3초마다 읽어 차례가 온 세션을 깨우고, 일 안 하는 차례를
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
packages/process-shared/src/work-queue/      ← 원장의 유일한 본문 (MCP · 호스트 공용)
  keys.ts        parseWorkKeys(raw[]) → {keys, invalid}          D10
  config.ts      parseWorkQueuesConfig(raw) → {queues, warnings}  §4.4 (예전 배열 모양 포함)
  ledger.ts      순수 전이: enter · end · sweep 결과 적용 · 보기       D3 D5
  store.ts       WorkQueueStore: read() · mutate(fn) (파일 잠금 + tmp→rename)  D4
packages/mcp-servers/work-queue/
  work-queue-mcp-server.ts   queue_list · queue_enter · queue_done · queue_cancel
packages/slack/src/work-queue/                ← 통째로 새로 (예전 게이트 지움)
  host.ts        WorkQueueHost: tick · wake · release · statusFor · awaitsHost · whenFree
  index.ts
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

지움: `packages/slack/src/work-queue/{manager,service,blocks,trigger,registry,config}.ts`와 그 테스트,
`SessionInitializer`의 `workQueue` 게이트, 액션 `work_queue_wait` · `work_queue_cancel`, `ConversationSession.workQueueId`,
`src/slack/env-run-queue.ts`(+ 테스트). `config-loader`의 `workQueues` 통과는 그대로(모양은 `parseWorkQueuesConfig`가 정한다).

## 2. 원장

### 2.1 모양 — `DATA_DIR/work-queues.json`

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

### 2.3 잠금 · 저장 — `WorkQueueStore`

- `mutate(fn)`: `<file>.lock`을 배타 생성(`wx`)으로 잡는다. 이미 있으면 20 ms씩 최대 3 s 다시 본다. 잠금 파일이
  10 s보다 오래됐으면(잡은 프로세스가 죽었다) 지우고 다시 잡는다. 잠금 안에서 읽기 → `fn` → 바뀌었으면
  tmp(`<file>.<pid>.<rand>.tmp`) 쓰기 + fsync + rename → 잠금 해제. 동기 API(MCP · 호스트 모두 짧은 트랜잭션).
- `read()`: 잠금 없이 읽는다(rename이라 반쯤 쓴 파일은 없다). 파일이 없으면 빈 원장. 깨졌으면 `.bak`(마지막으로 잘 읽힌
  내용을 쓰기 전에 복사)로, 그것도 없으면 오류 — 빈 원장으로 떨어뜨리지 않는다(rules/config.md 4).
- `mtimeMs()`: 호스트 틱이 바뀐 것만 다시 읽게.

`@soma/common/atomic-json`을 쓰지 않는 이유: `@soma/process-shared`는 `@soma/common`에 기대지 않는다(MCP 서버 번들 경계).
같은 tmp → fsync → rename 규칙을 그대로 따른다.

## 3. MCP 서버 `work-queue`

- 맥락: `SOMA_WORK_QUEUE_CONTEXT = {user, channel, threadTs}`(부모가 만든다 — 모델이 바꿀 수 없다), `SOMA_DATA_DIR`,
  `SOMA_CONFIG_FILE`. 설정은 호출마다 `config.json`의 `workQueues`를 읽는다(mtime 캐시) — 재시작 없이 반영(A9).
- 도구 네 개(§36 4.1). 답은 JSON 한 덩어리 + 모델이 바로 할 일 한 줄(`next`):
  - `running` → "지금 시작하라. 끝나면 `queue_done`."
  - `queued` → "턴을 끝내라. 차례가 오면 호스트가 이 스레드를 깨운다. 기다리며 폴링 · 크론 · sleep · 사람에게 묻기 금지."
  - `CONFLICT` → "겹친 키는 이미 다른 항목이 맡았다(진행 · 대기). 그 키를 빼고 나머지로 다시 `queue_enter`. 다 겹치면 할
    일이 없다 — 그렇게 보고하고 멈춘다."
- 큐가 하나도 설정되지 않은 호스트: 모든 도구가 `NO_QUEUES` + "이 호스트에는 작업 큐가 없다 — 줄 없이 진행".

## 4. 호스트 `WorkQueueHost`

의존(주입): `store`, `getQueues()`(설정), `probe(holder) → {exists, activity, activityChangedAt, awake}`,
`handoffActive(sessionKey)`, `deliver(holder, text, onOutcome)`(settled delivery), `post(channel, threadTs, text)`, `now`.

- **틱(3 s)**: `store.mtimeMs()`가 바뀌었거나 정리 주기(15 s)가 됐으면 읽는다.
  1. 깨우기: `running`이고 `notifiedAt`이 없고 아직 보내는 중이 아닌 항목 → `deliver`. 결과 `injected` → `mutate`로
     `notifiedAt = now`. `gone` → 그 항목 반납(`holder-gone`). 보내는 중인 번호는 메모리에 둔다(두 번 보내지 않게).
  2. 정리(15 s마다): 대기 항목의 주인이 없으면 뺀다. 진행 항목은 D7 규칙으로 살아 있는지 본다: 턴이 돈다(6 h 상한)
     · hand-off가 돈다 · 사람 답을 기다린 지 10분 미만 · 쉬기 시작한 지 5분 미만(쉬기 시작 = max(활동이 바뀐 시각,
     `notifiedAt`)) · 아직 깨우는 중. 아니면 반납(`holder-idle` / `holder-asking` / `holder-gone`) + 스레드에 `⏹` 한 줄.
  3. `whenFree` 대기자 풀기, 캐시 갱신.
- **읽기**(보드 · 목표 루프 · 후속 질문 · hand-off): 마지막으로 읽은 원장에서.
  - `statusFor(channel, threadTs) → {queue, entry, state, position, keys, since} | undefined`
  - `awaitsHost(channel, threadTs)` = 대기 항목이 있다.
  - `whenFree(channel, threadTs): Promise<void>` = 그 스레드의 항목이 하나도 없으면 풀린다.
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
| 원장 | `packages/process-shared/src/work-queue/__tests__/{keys,config,ledger,store}.test.ts` | A1–A4 · A9의 전이, 잠금 경합(자식 프로세스 둘) · 오래된 잠금 · `.bak` |
| MCP | `packages/mcp-servers/work-queue/work-queue-mcp-server.test.ts` | 도구 입출력 · 주인 검사 · `NO_QUEUES` · 설정 다시 읽기 |
| 호스트 | `packages/slack/src/work-queue/__tests__/host.test.ts` | A5–A8: 깨우기 한 번 · `gone` 반납 · 반납 규칙 · 재시작 뒤 깨우기 · `whenFree` |
| hand-off | `src/slack/commands/__tests__/skill-force-handler-env-handoff.test.ts` | A10 · A11(동시 시작) |
| 보드 | `src/conversation/__tests__/dashboard-auto-resume*.test.ts` · `card-finish-client*.test.ts` | 칸 · 라벨 · 보라 |
| 목표 · 후속 | `goal-loop-controller.test.ts` · `slack-handler.followup.test.ts` | 보류 |
| 조립 | `mcp-config-builder-internal-servers.e2e.test.ts` · `packages-srp-phase0-contract.test.ts` | 서버 등록 |

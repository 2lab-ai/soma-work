# 12 — 대시보드 에이전트 트리: 메인 에이전트 → 서브에이전트, 에이전트별 작업 로그·태스크

Status: PR-A(귀속·저장·payload, #362) · PR-B(대시보드 UI, #366) 구현 · rev 2(재귀 UI — 메인과 서브는 같은 노드 타입) 구현 ·
rev 3(서브별 지출·API 환산 비용, task 합계 영속 — §2.5, 2026-10-26) 구현 ·
Date: 2026-10-23, rev 2 2026-10-25 · 기준 main `3c9576a` · 이슈 #361
SSOT: [`agent-tree/ssot.md`](agent-tree/ssot.md) · 앞선 계약: [`10-agent-inbox-board-spec.md`](10-agent-inbox-board-spec.md),
[`11-dashboard-live-surfaces-spec.md`](11-dashboard-live-surfaces-spec.md)

## 0. 한 줄 정의

인박스 카드 하나 = 메인 에이전트 하나와 그가 띄운 서브에이전트들이다. 서브에이전트마다 자기 태스크 목록과 자기 작업 로그를
갖고, 메인의 태스크·로그·컨텍스트 점유율에는 서브의 것이 섞이지 않는다.

rev 2: 메인과 서브는 동형이다 — 메인은 세션 에이전트 트리의 루트 노드이고, 카드·패널·작업 로그가 루트와 서브를 같은 노드
타입, 같은 렌더러로 재귀적으로 그린다(§4).

읽는 순서: §1(무엇이 섞였나) → §2(귀속 계약, PR-A) → §3(카드 payload, PR-A) → §4(UI, PR-B) → §5(검증).

## 1. 변경 전 — 섞임 (기준 main `3c9576a`) [CODE]

출처가 한 곳에서 사라졌다: `src/agent-runtime/claude-code/sdk-message-to-event.ts`가 SDK 프레임의 `parent_tool_use_id`
(그 서브에이전트를 띄운 `Agent` 호출의 tool_use id)를 읽지 않았고, 중립 이벤트(`AgentStreamEvent`)에 그 칸이 없었다.
그 뒤의 모든 소비자는 서브의 프레임을 메인의 것으로 처리했다.

| 무엇 | 경로 | 결과 |
|---|---|---|
| 태스크 | `stream-processor.ts` TodoWrite 감지(이름만) → `todo-display-manager` → `TodoManager.updateTodos` → `index.ts` `applyTodoList(taskLedger)` | 서브의 TodoWrite가 메인 task 목록(Slack 플랜 블록 + 대시보드 ledger)을 통째로 교체. 메인이 다시 쓰면 직전(서브) 목록과 매칭이 안 돼 새 id·시간 리셋·중복 |
| 작업 로그 | `handleToolUseMessage` / `handleToolResultsContent` → `appendWorkLog` → `stampWorkLogTask(메인 ledger)` | 서브의 도구 호출·결과가 메인 로그에 귀속 없이 쌓이고, 메인의 현재 task로 분류되며 메인 task의 툴 횟수에 더해짐 |
| 컨텍스트 % | `applyUsageEvent` → `_lastAssistantTurnUsage`, `onLiveUsage` → `liveOccupancyCall` | 서브의 호출별 usage가 메인의 점유율 측정값을 덮음 |
| 도구 이름 | `packages/slack`이 `'Task'`만 검사 | 현 SDK의 도구 이름은 `Agent`(Claude Code v2.1.63+) — 서브에이전트 분기가 동작하지 않음 |

실데이터(dev 작업 로그 16개 대화, 2026-10-23): `Agent` 호출 169건, `Task` 0건. 전경 서브에이전트 실행 창 안의 도구 호출
129건이 전부 메인 로그에 귀속 없이 들어 있다.

## 2. 귀속 계약 [PR-A]

### 2.1 중립 이벤트 (`src/agent-runtime/stream-types.ts` ≡ `packages/slack/src/agent-stream-types.ts`, drift guard)

- `tool_call` · `tool_result` · `assistant_delta` · `thought_delta` · `usage`: `parentToolUseId?: string`. 매퍼가 프레임의
  `parent_tool_use_id`가 비어 있지 않은 문자열일 때만 싣는다 — 메인의 프레임에는 키 자체가 없다.
- `tool_result.agentOutcome?: { status, toolUses?, durationMs? }`: SDK `SDKUserMessage.tool_use_result`의 `status`가
  `completed` · `async_launched` · `remote_launched`일 때만(메시지의 tool_result가 하나일 때). 다른 도구의 구조화 출력은 무시.
- `agent_task_lifecycle`: `subagentType` · `description` · `background`(`is_backgrounded`) · `usage{totalTokens, toolUses, durationMs}` ·
  `lastToolName` · (progress의) `summary` 추가.

### 2.2 스트림 프로세서 (`packages/slack/src/stream-processor.ts`)

에이전트 id = 그 에이전트를 띄운 tool_use id. 새 콜백 `StreamCallbacks.onAgentEvent(event: AgentTreeEvent)`
(`packages/slack/src/agent-tree.ts`), 실행기가 `streamExecutorProviders.recordAgentEvent(sessionKey, event)`로 묶는다.

- `Agent`·`Task` 호출(`isAgentSpawnTool`) → `spawn{agentId, parentAgentId?(그 호출 프레임의 parentToolUseId), agentType=subagent_type,
  description, background=run_in_background===true}`. 그 호출의 작업 로그 `tool` 항목에 `agentRef`. spawn은 호출 이벤트가 **도착한 즉시**
  알린다 — 호출은 렌더 버퍼에서 기다리지만 SDK `task_started`는 그 버퍼보다 먼저 올 수 있다.
- 처음 보는 부모 id의 프레임(이전 턴의 배경 에이전트, Agent가 아닌 스포너) → id만 있는 `spawn` 한 번.
- 메인의 TodoWrite → `onTodoUpdate`(종전 그대로). 서브의 TodoWrite → `todos{agentId, todos}`만 — Slack 플랜 블록·메인 ledger·
  TodoManager는 건드리지 않는다.
- 서브의 `tool`·`tool_result` 작업 로그 항목 = `agentId`. 서브의 text(`forwardSubagentText` 켰을 때만 옴) = 그 서브의 `narration`
  항목, Slack·메인 서술·`collectedText`·최종 답변에는 가지 않는다. 서브의 thinking = 버림.
- 스폰 호출의 tool_result → 항목 `agentRef` + `returned{ok, ack, toolUses?, durationMs?}`. `ack`(배경 시작 확인일 뿐) 판정 순서:
  `agentOutcome.status !== 'completed'` → 스폰 입력 `run_in_background` → 결과 텍스트(`isBackgroundAckText`, 최후 폴백).
- 서브의 호출별 usage → `onLiveUsage({…, sidechain: true})`, `_lastAssistantTurnUsage`는 메인 것만.
- `agent_task_lifecycle` → `lifecycle{agentId?(tool_use_id), taskId, phase, taskType, status, …}`.
- 서브의 도구 호출·결과도 `onToolUse`/`onToolResult`로 넘어가되 `parentToolUseId`(결과는 `toolName`까지)를 싣는다. 실행기는 Slack 표면
  (스레드 헤더의 현재 도구·Slack 도구 행·요청 툴 통계·턴 관측기)을 메인 것으로만 그리고, 호스트 처리(모델 커맨드 — `ASK_USER_QUESTION`·
  `UPDATE_SESSION` 등, git 메트릭)는 모든 에이전트의 결과에 돈다. Slack 스킬 배너·레거시 도구 행·마지막 도구(`endTurnInfo`)도 메인 것.
- 에이전트 id는 `normalizeAgentId`(≤200, 작업 로그 필드 클램프와 같은 규칙) 하나로 줄여 레지스트리와 작업 로그가 같은 문자열을 갖는다.
- 스폰의 tool_result가 오류면 `ack`가 아니다(시작되지 않았다) → `failed`.
- 턴 끝(정상·사용자 중단·stall 타임아웃·예외 모두) → `turn_end`.
- `forwardSubagentText`·`agentProgressSummaries`는 켜지 않는다(설계 자문 Q2·Q3: 누출 위험·비용 대비 이득 부족). 켜도 위 분기가
  서브의 text를 그 서브 로그로만 보낸다.

### 2.3 에이전트 레지스트리 (`src/session/agent-registry.ts`, `ConversationSession.agents`)

```ts
type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'unknown';
interface AgentRecord { id; n /* A<n>, 재사용 안 함 */; parentId?; type?; description?; background?; status; startedAt; endedAt?;
  toolCalls; lastTool?; tokens?; durationMs?; summary?; taskId? /* SDK task id */; settled?: true; ledger?: TaskLedger }
interface AgentRegistry { nextN; agents: AgentRecord[] /* 오래된 순 */ }
```

- 생성은 `spawn`(과 서브의 첫 TodoWrite·첫 작업 로그 항목의 placeholder)만. SDK 수명주기는 레코드를 만들지 않고,
  `taskType`이 있고 `local_agent`가 아니면(배경 Bash 등) 무시한다. `task_updated`처럼 `tool_use_id` 없이 task id만 오는
  settle은 `task_started`가 붙인 `taskId`로 찾는다.
- 같은 id의 `spawn` 반복은 빈 칸만 채운다 — 상태·시작 시각·순번을 되돌리지 않는다.
- 상태: SDK settle(`task_notification`, 종결 `task_updated`)이 권위이며 앞선 추론 종료를 정정할 수 있다(`settled`). 전경의
  tool_result = `ok`면 completed, 아니면 failed(settle이 이미 왔으면 무시). 배경 ack = running 유지 + `background: true`.
  턴 끝에 아직 running인 전경 에이전트 = `unknown`(관측 끊김 — "멈춤을 봤다"가 아님). 재기동 복원(`sessions.json` 로드)과
  `/new`·renew 리셋 = running → `unknown`(`loseRunningAgents`). `unknown`에 progress가 오면 running으로 돌아오고, 끝난 에이전트는
  어떤 이벤트로도 running이 되지 않는다.
- 도구 수 = 그 에이전트의 `tool` 작업 로그 항목 수(`loggedTools`)와 SDK가 보고한 누적 `tool_uses`(`reportedTools`) 중 큰 값 — 합이 아니다.
  토큰·소요 = SDK 보고값.
- 상한: 레코드 `AGENT_REGISTRY_MAX` = 100 — 오래된 끝난 에이전트부터 지우되, 실행 중인 에이전트와 그 조상은 지우지 않는다
  (그때는 상한을 넘을 수 있다). 정리는 레코드가 완성된 뒤(부모가 채워진 뒤)와 모든 종료 전이·복원 뒤에 돈다 — 실행 중 에이전트 때문에
  넘었던 초과분은 그들이 끝나면 해소된다. task ledger는 끝난 에이전트 중 최신 `AGENT_LEDGER_KEEP` = 40개만 유지.
- 영속: `sessions.json`(`sanitizeAgentRegistry`), 아카이브(`ArchivedSession.agents`).
- 루트 통계(rev 2): `AgentRegistry.root?: { toolCalls, lastTool? }` — 메인 에이전트 자신의 툴 호출 수와 마지막 도구. 서브의
  logged tools와 같은 규칙(메인이 만든 `tool` 작업 로그 항목 하나에 1). `stampWorkLogAgent`가 세고, 메인이 툴을 한 번도 안 불렀으면
  없다. `sanitizeAgentRegistry`가 복원하고(잘못된 값은 버림), `loseRunningAgents`가 그대로 둔다. 루트 통계만 있는 레지스트리도 유효하다.

### 2.4 작업 로그 (`packages/slack/src/work-log.ts` ≡ `src/conversation/work-log.ts`)

- 항목 필드 `agentId?`(이 항목을 만든 서브, 없음 = 메인) · `agentRef?`(이 항목이 시작/반환하는 서브 — 누가 호출했든). 둘 다
  `WORK_LOG_FIELD_MAX`로 자른다. 목록·WS·저장 모두 그대로 싣는다.
- 저장소가 쓰는 모든 새 항목에 `attributed: true`. 이 표시가 없는 항목은 귀속 기능 이전 것이라 서브의 일이 메인으로
  들어 있을 수 있다 — UI는 그것을 "메인 확정"으로 보이지 않는다(§4.3).
- 스탬프(`index.ts` → `stampWorkLogAgent`): `agentId`가 있으면 그 서브의 ledger의 현재 task로 `taskId`/`taskTitle`, `tool`이면
  그 서브의 `toolCalls`+1·`lastTool`. 없으면 종전대로 세션 ledger(메인).

### 2.5 사용량 (rev 3, 2026-10-26 — 서브별 지출 · task 합계)

**task 합계.** 집계원은 하나다 — 턴 중 `liveUsage` 호출별 합 → 턴 끝 result `modelUsage`(sdk.d.ts: 메인 루프 + Task 서브에이전트 +
사이드체인, 서브 호출 포함). 같은 턴 지출이 런타임 `session.usage.total*`와 영속 `session.taskUsage`
(`packages/slack/src/session-usage-math.ts` `creditTaskSpend`)에 함께 들어간다. 차이는 수명뿐이다: `usage`는 메모리 전용이라
재시작·`resetSessionContext`(/new, CONTINUE_SESSION)에서 0이 되고, `taskUsage`는 `sessions.json`·아카이브에 남고 리셋되지 않는다.
result 없이 끝난 턴의 호출(`foldLiveUsage`)은 `taskUsage`에도 더하고, 그 SDK 세션의 다음 result가 다시 싣는 만큼 `taskUsage.pendingFold`
(영속)로 정산한다 — 재시작이 사이에 있어도 두 번 세지 않는다. 이 필드가 생기기 전에 저장돼 이미 지출이 있던 세션은 로드 때
`partialSince`(그 시각부터 집계)를 단 0짜리 합계로 시작하고, 카드가 그렇다고 말한다(소급 복원 없음 — SDK 세션이 있던 세션은
baseline이 없어도 부분 합계다). 아카이브 스냅샷의 `taskUsage`는 확정 합계 + 진행 중 턴의 호출(`liveUsage`, 세션 모델 단가) — 턴 도중 닫힌
카드도 그 턴의 지출을 잃지 않는다. `/new`가 `sessionId`를 지워도 `taskUsage`가 있는 세션은 보드에 남는다(`onBoard`).

**서브별 지출.** SDK의 `total_tokens`(`AgentRecord.tokens`)는 마지막 컨텍스트 크기이지 지출이 아니다(실측 2026-10-26: 서브 194개
표시 Σ 23.9M vs transcript 지출 Σ 389.6M). `forwardSubagentText`가 꺼져 있으면 서브의 텍스트 전용 호출(최종 보고)은 호스트에 오지
않으므로 실시간 프레임으로도 셀 수 없다. 그래서 서브 자신의 transcript를 읽는다(`src/session/agent-spend.ts`):
`<CLAUDE_CONFIG_DIR>/projects/<cwd>/<sdkSessionId>/subagents/agent-<taskId>.jsonl` (`taskId` = `task_started`의 task id = transcript의
agent id, 중첩 서브도 같은 폴더). API 호출 하나 = `message.id` 하나, 마지막 줄의 usage가 최종값, `<synthetic>` 제외. 모델별로
`calculateTokenCost`로 환산하고, 단가표에 없는 모델(`hasModelPricing` 거짓 — grok 등)은 기본 단가로 추정하며 `unpricedModels`로 표시한다.
결과는 `AgentRecord.spend{inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, costUsd, calls, unpricedModels?}` +
`sdkSessionId` + `spendFinal`(영속).
- 읽기: 증분(파일별 오프셋 + 호출 맵, 청크 단위로 그 시점 파일 끝까지, 개행으로 끝난 줄만 소비 — 미완성 줄은 바이트로 보관). 갱신 계기 =
  `index.ts` `recordAgentEvent`와 서브의 작업 로그 항목(실행 중 에이전트는 10초에 1회), `turn_end`는 봉인 안 된 전부를 다시 읽고 끝났거나
  시야에서 사라진(`unknown`) 에이전트를 `spendFinal`로 봉인한다 — 미완성 마지막 줄이 남아 있으면 봉인하지 않는다. 봉인된 에이전트에
  어떤 이벤트·작업 로그 항목이든 오면(SendMessage 재개, 되살아남, 늦은 보고) 봉인을 푼다. `sdkSessionId`는 에이전트가 실행 중일 때 처음
  본 순간 세션의 현재 SDK 세션으로 기록한다(transcript가 생기기 전 — 이후 `/new`가 검색 위치를 바꾸지 못한다). 비동기 — 바뀌면
  `scheduleLiveSessionUpdate`. await 뒤에는 레코드를 id로 다시 찾는다(리셋이 레지스트리를 바꿀 수 있다).
- 시작 백필: 재시작 전에 끝난 서브에이전트는 더 이벤트가 없으므로, 프로세스가 provider를 연결한 직후 로드된 세션 전부를 한 번씩 순차로
  읽어(`backfillAgentSpend`, 턴 끝과 같은 force 읽기) 지출을 채우고 봉인한다. 실측(dev 사본, 2026-10-27): 세션 30 · 에이전트 247 중 244 · 1.4초.
- 상한 100의 정리: 오래된 순으로, 지출이 확정된 레코드(봉인됐거나 transcript가 없는)만 지운다. 아직 읽을 것이 남은 레코드는 턴 끝 봉인까지
  상한을 넘어서도 남는다(끝난 지 하루가 지나도 못 읽은 것은 지운다). 봉인은 읽기를 마친 뒤 파일 크기가 그대로일 때만 한다(그사이 추가된 호출이
  있으면 다음 턴 끝에).
- fold 정산(rev 3 r2·r3): fold는 세션 모델 단가로 추정한 값이다. 그 SDK 세션의 다음 result가 오면 `settleFoldedLiveUsage`가 result 증가분 −
  fold를 부호 있게 돌려주고, 세션 런타임 합계와 task 합계가 같은 값으로 고친다(`addSessionSpend`, 0 아래로는 내려가지 않음) — 과대 추정은 되돌린다. fold 직후 세션을 바로 저장한다(유휴 저장은 이미 끝났다).
- 경로 봉쇄: 세션 id는 UUID(`findTranscriptPath`), `taskId`는 `[A-Za-z0-9_-]{1,128}`, 세션 폴더·`subagents`·transcript 어느 것도
  심볼릭 링크면 읽지 않는다.
- 서브 합계 `subagentSpendOf` = 레코드별 지출 합 + `AgentRegistry.prunedSpend`(상한 100이 지운 레코드의 지출, 영속) — 상한이 합을 줄이지
  않는다. 레코드마다 자기 호출만 갖으므로 합은 겹치지 않는다. task 합계에는 이미 서브 호출이 들어 있으므로 서브 합계를 task 합계에
  더하지 않는다(이중 계산 금지).
- 레코드 없는 하위 서브(rev 3 r5, 2026-10-27): 서브가 foreground로 띄운 서브는 호스트가 프레임을 보지 못해 레지스트리 레코드가 없다 — meta
  (`agent-<taskId>.meta.json`)에 `toolUseId`가 없고 `parentAgentId`(부모 task id)만 있다. 그 호출은 task 합계(SDK는 모든 호출을 센다)에는
  있지만 어느 서브에도 없었다(이 task: transcript 27개 중 5개, astra 약 14M tok). 읽기는 세션의 `subagents/`를 나열해 그런 transcript를
  `parentAgentId` 사슬을 따라 가장 가까운 레코드 있는 조상에 합산한다(`spend.nestedAgents` = 합산한 수, 행 툴팁 "트리에 따로 없는 하위 에이전트
  N개 포함"). `toolUseId`가 있는 meta는 자기 레코드가 있거나(백그라운드 하위 서브) 상한이 지워 `prunedSpend`에 들어간 것이라 합산하지 않는다 —
  두 번 세지 않는다. 사슬이 돌거나 레코드 있는 조상에 닿지 않으면(최대 16단) 합산하지 않는다. meta는 64 KiB 이하의 일반 파일만(심볼릭 링크 거부),
  읽은 meta는 캐시한다(생성 때 한 번 쓰인다). 디렉터리 나열은 비강제 읽기에서 10초에 1회. 봉인은 자기 transcript와 합산한 하위 transcript가 모두
  온전하고 그대로일 때만, 하위 하나라도 읽기에 실패하거나 meta만 있고 transcript가 아직 없거나, 디렉터리 나열이 실패했거나, 60초 안에 쓰인 meta가 아직 파싱되지 않으면(쓰는 중) 봉인하지 않는다(transcript가 끝내 생기지 않는 하위가 있으면 그 에이전트는 봉인되지 않은 채 턴 끝마다 다시 읽히고, 상한 정리는 끝난 지 하루 뒤에 지운다).
- usage 미기록 호출(rev 3 r4, 2026-10-27): llmux를 거치는 gpt-6-astra·grok-4.7-build는 transcript에 호출의 53%·57%를 usage 0으로 남긴다
  (claude 모델 0%). llmux 자체 기록과 호출을 시각으로 1:1 대조하면 usage가 있는 호출은 정확히 같고, 0인 호출도 실제로는 사용량이 있다 — 0으로
  세면 그런 서브가 2~20배 적게 보였다. 그래서 0인 호출은 컨텍스트 크기(입력 + 캐시 읽기 + 캐시 쓰기)를 앞뒤 보고된 호출 사이에서 보간하고(한쪽
  끝이면 이웃 하나), 그 에이전트의 보고된 호출에서 구한 중앙값 비율로 입력·캐시 쓰기·캐시 읽기로 나눈다 — 옆 호출의 캐시 미스(입력 급증)를 구간
  전체에 퍼뜨리지 않는다. 출력은 그 에이전트의 평균 출력(`fillZeroUsage`). 추정은 transcript마다 따로 한다(하위 서브는 자기 이웃으로). SDK의 턴별
  정확한 사용량과 대조(이 task, transcript 27개, rev 3 r5): 토큰 −1%, 비용 −1%(필드별 선형 보간은 비용 +7%). 추정한 호출 수는
  `spend.estimatedCalls`, 행·합계는 `≈$`로 표시한다.
  보고된 호출이 하나도 없으면 채우지 않는다("사용량 미보고"). 이웃 인덱스는 두 번의 선형 패스로 구한다.
- 계산 버전: `spend.version` = `SPEND_CALC_VERSION`(현재 3 — 하위 서브 합산과 추정식 변경). 다른 버전으로 봉인된 지출은 복원 때 봉인을 풀어 현재 계산으로 다시 읽는다 — 추정
  방식이나 단가가 바뀌면 버전을 올린다. 상한이 이미 지운 레코드의 합(`prunedSpend`)은 다시 계산할 수 없어 그때의 값으로 남는다.
- 단가(rev 3 r4·r5): 서브 지출은 단가표(`model-registry.ts`)로 환산한다. task 합계는 claude 모델이면 SDK `costUSD`(공식 단가 — Opus 5.5
  $4/$20/캐시 읽기 $0.20, Fable 5.1 $10/$50/$0.25, 단가표에도 같은 행), llmux 모델이면 단가표다(`metrics/host-pricing.ts`): SDK는 llmux
  모델을 별칭(`astra`, `grok`)으로 보고하고 모르는 모델이라 자기 기본 단가($4/$20/$0.20)로 환산해 astra가 공식가($10/$50/$1)의 약 1/3로
  잡혔다. 모델 카탈로그가 `claude` 그룹 밖으로 두는 모델은 별칭을 정식 id로 풀어(`astra` → `gpt-6-astra[1m]`) 단가표로 환산한다 — 서브 행과
  같은 단가다. 카탈로그에 없는 모델은 SDK 금액 그대로. 실측 대조(이 task, 턴 3 끝): task 합계 322.7M tok · $413.96, 메인 237.8M · $242.64 + 서브
  22행 84.4M · $169.25 = 322.2M · $411.89 — 토큰 −0.2%, 비용 −0.5%(opus·fable 토큰 정확히 일치, 남은 차이는 llmux 호출 추정분). 정정: rev 3
  r4의 "SDK가 astra 토큰을 약 6배 집계" 판단은 틀렸다 — SDK 숫자는 llmux 기록과 토큰 단위까지 같았고, 차이는 위의 레코드 없는 하위 서브였다.
  단가 전환: 세션을 로드할 때 저장된 SDK 누적치(`sdkUsageBaseline`)의 llmux 모델 비용을 저장된 토큰으로 다시 매긴다(`repriceBaseline`, 단가는
  토큰에 선형) — 다음 result의 증가분은 새 토큰의 새 단가뿐이고, 과거 이력의 재가격이 한 턴에 몰리거나(astra) 0으로 읽히는 턴(grok)이 없다.
  `toTurnUsage`는 재시작을 토큰 감소로만 판정한다(비용만 내려간 것은 재가격 — 모델 전체를 다시 세지 않는 방어선).
- 서브의 실시간 호출 키 `s:`는 종전대로 `liveOccupancyCall`(컨텍스트 점유율)에서만 빠진다.

## 3. 카드 payload [PR-A] (`src/conversation/dashboard.ts`)

- `KanbanSession.agents?: DashboardAgent[]` — 서브만(메인 = 카드 자신), 스폰 순. 최대 `AGENTS_ON_CARD_MAX` = 40개: 실행 중
  에이전트와 그 조상 먼저, 나머지는 최신. `agentsTotal` = 전체 수. 서브가 한 번도 없었던 세션은 두 키가 모두 없다.
- `DashboardAgent` = `{ id, n, parentId?, type?, description?, background?, status, startedAt, endedAt?, toolCalls, lastTool?, spend?,
  durationMs?, summary?, tasks?, earlierTasks? }`. `tasks`는 `normalizeTaskProgress` — 그 에이전트가 running일 때만 현재 task
  최대 1개, 아니면 0개. 지시 전문·결과 전문은 싣지 않는다 — 작업 로그의 `agentRef` 항목 raw로 지연 로드한다.
- 아카이브 카드도 `agents`를 싣고, 아카이브가 running으로 기억한 에이전트는 `unknown`이다.
- `KanbanSession.agentRoot?: { toolCalls, lastTool? }`(rev 2) — 레지스트리 루트 통계. 서브가 없어도 실린다(`agents` 키는 없음).
  루트의 나머지 필드는 세션 자신의 것: 상태(활동 상태·열·자동 재개), 활성 시간(`activeLegStartedAtMs`/`activeAccumulatedMs`),
  모델, task(`tasks`).
- 실시간: 레지스트리가 바뀌면(`applyAgentEvent`가 true) 그리고 서브의 `tool` 항목마다 `scheduleLiveSessionUpdate` → WS
  `sessionUpdated`(세션당 1초 1회).

## 4. UI [PR-B, rev 2 — 재귀]

설계 근거: 선행 사례 조사(LangSmith run tree·Langfuse·OpenAI traces·Braintrust·Weave — 루트와 자식이 같은 span/run 행; Claude Code
서브에이전트 패널(`(+N)`, main으로 가는 경로)·Copilot(부모 로그 안의 접힌 자식 블록 + 실시간 한 줄)·Cursor·Codex; Temporal·Airflow;
WAI-ARIA tree·Primer TreeView·NN/g 드릴다운; Discourse·Tildes 모바일 스레드)와 trinity 설계 리뷰 2라운드.

### 4.0 노드 모델

`agentTreeOf(session, column, extras)`(순수) = 루트 노드 하나. 루트 = 메인 에이전트: `{ id: '', root, label: '메인', status, model,
tasks, toolCalls(agentRoot), lastTool, activeMs, legStartedAt, children }`. 서브 노드 = 레코드 필드 + `status`(정규화)·`toolCalls`·
`children`. 서브는 `parentId`의 노드 밑에 스폰 순으로 붙는다(상태로 재정렬하지 않음). 부모가 카드에 없거나 자기 자신이거나 순환이면
루트 밑. 작업 로그에만 보이는 에이전트(카드 상한 밖)는 루트 밑 `확인 불가` 노드(`logOnly`).

루트 상태 = 생명주기 근거(닫힌 카드를 "중단"이라 하지 않는다): 닫힘+terminated → 보관, 닫힘 → 휴면, RUNNING 열에서 자동 재개
대기(활동 working 아님) → 재개 대기, 활동 working → 실행 중, waiting → 입력 대기, 그 외 → 대기. 상태는 언제나 아이콘 + 단어.

### 4.1 접힌 카드

서브가 있을 때만 한 줄 `.card-agents`: 상태 점(최대 6개 + `+N`, 점은 보조) + 텍스트 `서브에이전트 N · 실행 r · 실패 f`
(0인 항목은 생략, 실패는 0보다 크면 항상). 색만으로 상태를 전하지 않는다.

### 4.2 펼친 카드 — 하나의 트리

> 2026-10-25 [spec 13](13-dashboard-three-surfaces-spec.md) §3.3: 카드의 행은 compact 밀도(상태 단어 · 시간 · 살아 있거나 실패한 노드의 한 줄), 패널의 행은 rich 밀도다. 카드의 `전체 N개 보기`는 `전체 N개 → 상세`(그 부모에 초점을 둔 패널)로 바뀌었다.

task 타임라인 앞 `에이전트` 섹션 = `<ul role="tree">` 하나, 루트(메인)부터. 모든 노드가 같은 렌더러 `renderAgentNode`를 지난다:
`<li role="treeitem" aria-level aria-setsize aria-posinset [aria-expanded] aria-label>` 안에 행 하나 + 열려 있으면 자식 그룹
`<ul role="group">`. 행 슬롯은 루트와 서브가 같다 — 셰브론 · 상태 아이콘 · 이름(루트: `메인` + 모델 / 서브: `A<n>` + 타입) · 상태
단어 · 시간(루트: 활성 시간 / 서브: 경과·소요) · 툴 수 · (루트: task 완료/전체) · `배경` · 접힌 노드의 `+N`(하위 수, 하위에 실행
중/실패가 있으면 그 색) · 설명 · 현재 활동(진행 중 task → SDK 요약 → 마지막 도구) · 워터폴 막대(서브만, 축 = 서브 집합). 이름과
상태 단어는 줄바꿈되는 한 줄 — 좁은 카드에서 상태 단어가 이름 아래로 내려가고 이름을 지우지 않는다.

- 레벨·들여쓰기·기본 펼침은 렌더된 트리의 기준점(카드: 루트) 기준: 루트(aria-level 1)는 언제나 열림(셰브론 없음), 그 자식도 기본
  열림, 그보다 깊은 부모는 접힌 채 시작(`+N`). 유저의 접기/펼치기는 (트리, 노드)별로 기억되고 기본값보다 앞선다. 라이브 갱신이
  유저가 연 것을 닫지 않는다.
- 상한: 부모마다 자식 6개(`AGENT_TREE_ROWS`), 나머지는 그 부모의 `전체 N개 보기` 항목(트리 항목, 다시 누르면 `접기`). 모든 레벨 같다.
- 들여쓰기 = 행 자신의 레벨(누적 패딩 아님), ≥640px 레벨당 16px·4단 상한, <640px 12px·3단 상한. 트리 선 = CSS 테두리(그룹마다 부모
  셰브론 위치의 세로선 + 자식마다 꺾임), 상한보다 깊으면 점선.
- 클릭: 셰브론은 접기만, `전체 N개 보기`는 목록만, 행은 그 노드를 패널에서 연다 — 자식 영역(그룹 여백)은 아무것도 열지 않는다.
  셰브론은 탭 순서 밖(`tabindex=-1`, 화살표가 키를 맡음), 터치에서 44px 히트 영역.
- 키보드(WAI-ARIA tree): 트리마다 탭 정지 하나(roving). ↓/↑ 이동, Home/End, → 열기 또는 첫 자식, ← 닫기 또는 부모, Enter/Space
  = 그 노드를 패널에서 열기. 탭 정지는 상태(`_anActive[트리]`)라 morph가 지우지 않고, 렌더마다 "보이는" 트리에 맞춘다 — 마지막으로
  있던 노드, 안 보이면 가장 가까운 보이는 조상, 그도 없으면 첫 항목. 라이브 갱신이 포커스된 항목을 없애면(이탈·재부모화) 같은 노드나
  가장 가까운 남은 조상으로 포커스를 옮긴다(트리에 포커스가 있었을 때만).
- 서브가 없는 카드는 트리를 그리지 않는다(카드 자체가 메인). 카드 목록 밖 에이전트 수는 `이전 에이전트 N개는 카드 목록 밖`.

### 4.3 패널 — 같은 트리 위의 드릴다운

패널의 에이전트 섹션 = 경로 + 포커스 노드 헤더 + 그 노드의 하위 트리. 별도의 평면 목록은 없다.

- 경로: 포커스 노드의 체인(루트 → 노드)에서 만든다 — 루트 조각도 노드 이름이지 하드코딩 버튼이 아니다. 루트에 포커스면(위에 아무것도
  없음) 경로를 그리지 않는다. <640px에서는 `‹ 부모 › 여기`만 보인다.
- 헤더: 어떤 노드든(루트 포함, 서브가 없는 세션도) 같은 슬롯 — 이름 · 상태 단어 · 시간(루트는 `활성`) · 툴 수 · 토큰 · `배경 실행` ·
  `하위 N` · 설명 — 현재 활동. 지출(rev 3, §2.5): 루트 = `task 합계 X tok · $Y`(메인 + 모든 서브, 영속 task 합계 + 진행 중 턴) 옆에 `서브 N개 X' tok · $Y'`(서버가
  더한 서브 합계 — task 합계 안에 들어 있다), 서브 = 자기 API 호출의 `X tok · $Y`(하위 제외, 툴팁에 호출 수·종류별 토큰). 단가표에 없는
  모델이 섞이면 `≈$Y`, 호출이 있는데 usage가 모두 0이면 `사용량 미보고`. SDK의 `total_tokens`는 지출로 보이지 않는다. 같은 지출이 패널 하위
  트리 행에도 실린다. 접힌 카드의 토큰·비용은 task 합계이고 툴팁이 `메인 + 서브에이전트 N개`와 부분 합계(`partialSince`)를 말한다.
  세션 정보는 `서브에이전트` 행과(부분 합계면) `집계 시작` 행을 더한다. 클라이언트는 아무것도 합산하지 않는다(이중 계산 금지).
- 하위 트리: 포커스 노드의 직계 자식 전부(상한 없음)와 그 아래(같은 6 상한·같은 접기), `role="tree"`, 같은 `renderAgentNode`. 레벨은
  포커스 노드 기준(직계 자식 aria-level 1) — 루트에서 접혀 있던 손주는 그 부모로 드릴하면 열린 채 보인다. 유저가 패널에서 접은
  노드는 드릴을 오가도 접혀 있다(세션별 패널 트리 상태).
- 포커스 노드가 Tasks 블록과 작업 로그를 정한다. 작업 로그 범위: 루트 = `agentId` 없는 항목, 서브 = `agentId`가 그 서브인 항목 +
  `agentRef`가 그 서브인 항목(맨 앞 `지시` = 스폰 호출 raw, 맨 끝 `결과` = 반환 raw — 배경 ack면 `배경 실행 시작`; 스폰 결과가 오류면
  `결과`). task 그룹·원본 열람·키보드 계약(§10 3.1-6, §11 T10)은 범위 안에서 그대로, 그룹 열림 상태는 (노드, task) 단위.
- 자식 블록: 부모 범위의 스폰 행 옆(행 버튼 안이 아니라 형제)에 그 자식 노드의 블록 — 상태 아이콘·이름·상태 단어·시간·툴 수·현재 활동·
  `열기 →`. 화살표 탐색의 정거장이고 Enter/Space·클릭이 그 노드로 드릴한다. 아직 카드에 없는 자식은 `확인 불가`로 그렸다가 도착하면
  morph로 바뀐다.
- `attributed` 없는 항목이 `Agent`/`Task` 호출을 포함하면 루트 범위에서 그 구간 앞에 `이전 통합 로그 — 메인/서브 귀속 미확인`.
- 라이브: `task_update`(캐시 갱신 뒤)·`sessionUpdated`·보드 푸시 모두 같은 `repaintPanelScope()` — 에이전트 섹션, 포커스 노드의 Tasks,
  task 그룹 머리, 화면의 자식 블록을 다시 그린다. 루트 전용·서브 전용 게이트는 없다(각 부분은 같은 마크업이면 쓰지 않는다).

### 4.4 반응형·모션

≥1024 / 640–1023 / <640 보드 계약(§10 5) 그대로. 트리 행·`전체 N개 보기`·경로 조각은 <640·coarse에서 ≥44px. 상태 스피너와 워터폴
스윕은 reduced motion에서 정지, 셰브론 회전은 §10 4의 토큰만 쓴다. 라이브 갱신(보드 푸시·`sessionUpdated`)은 바뀐 노드만 맞춘다
(morph — 트리 항목은 노드 id로, 같은 그룹 안에서 짝지음): 같은 데이터면 DOM 쓰기 0, 바뀌면 항목·스피너·막대·자식 블록 노드를 유지한
채 속성·텍스트만 고친다 — 포커스, 트리 스크롤, 실행 중 애니메이션이 갱신에 끊기지 않는다.

## 5. 검증

- 단위(PR-A): `src/agent-runtime/__tests__/sdk-message-to-event.subagent.test.ts`, `packages/slack/src/__tests__/stream-processor.subagent.test.ts`,
  `src/session/__tests__/agent-registry.test.ts`, `src/conversation/__tests__/work-log.test.ts`(agentId/agentRef/attributed),
  `packages/slack/src/__tests__/live-usage.test.ts`(sidechain), `src/conversation/__tests__/dashboard-agent-tree.test.ts`(payload).
- PR-B / rev 2: `src/conversation/__tests__/dashboard-agent-tree-client.test.ts`(한 렌더러 — 메인 전용·서브 전용 행 함수 없음,
  노드 모델·루트 상태·같은 슬롯·aria 레벨/위치·기본 펼침·유저 접기·부모별 상한·탭 정지 하나·트리 키·클릭 경계, 패널 경로·헤더·
  하위 트리·드릴·토큰 라벨·같은 데이터 무쓰기·게이트 없음, 자식 블록, morph) + `src/session/__tests__/agent-registry.test.ts`·
  `dashboard-agent-tree.test.ts`(루트 통계·`agentRoot`) + 브라우저 실측 `scripts/screenshot-agent-tree.ts`(1280/820/390 × 라이트/다크:
  가로 넘침 0, <640px 44px, 트리 항목·레벨·들여쓰기, 셰브론, 트리 키, 패널 드릴·루트 헤더·모바일 경로, 자식 블록 라이브, 포커스 유지).
- 실행: `env -i PATH="$PATH" HOME="$HOME" SOMA_CONFIG_DIR=$TMP/cfg SOMA_INSTANCE_DIR=$TMP/inst CONVERSATION_VIEWER_PORT=33918 npx tsx scripts/screenshot-agent-tree.ts [outDir]`
  — 봇이 띄운 셸에서는 `env -i`로 배포 환경 변수(뷰어 포트·URL·토큰)를 끊는다.

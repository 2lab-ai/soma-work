# 12 — 대시보드 에이전트 트리: 메인 에이전트 → 서브에이전트, 에이전트별 작업 로그·태스크

Status: PR-A(귀속·저장·payload) 구현 · PR-B(대시보드 UI) 진행 · Date: 2026-10-23 · 기준 main `3c9576a`
SSOT: [`agent-tree/ssot.md`](agent-tree/ssot.md) · 앞선 계약: [`10-agent-inbox-board-spec.md`](10-agent-inbox-board-spec.md),
[`11-dashboard-live-surfaces-spec.md`](11-dashboard-live-surfaces-spec.md)

## 0. 한 줄 정의

인박스 카드 하나 = 메인 에이전트 하나와 그가 띄운 서브에이전트들이다. 서브에이전트마다 자기 태스크 목록과 자기 작업 로그를
갖고, 메인의 태스크·로그·컨텍스트 점유율에는 서브의 것이 섞이지 않는다.

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
- 서브의 도구 호출·결과는 `onToolUse`/`onToolResult`(스레드 헤더의 현재 도구, Slack 도구 행, 요청 툴 통계)와 Slack 스킬 배너로
  가지 않는다 — 메인이 하는 일만 Slack 표면에 남고, 서브의 것은 그 서브의 작업 로그에 있다. 마지막 도구(`endTurnInfo`)도 메인 것.
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

### 2.4 작업 로그 (`packages/slack/src/work-log.ts` ≡ `src/conversation/work-log.ts`)

- 항목 필드 `agentId?`(이 항목을 만든 서브, 없음 = 메인) · `agentRef?`(이 항목이 시작/반환하는 서브 — 누가 호출했든). 둘 다
  `WORK_LOG_FIELD_MAX`로 자른다. 목록·WS·저장 모두 그대로 싣는다.
- 저장소가 쓰는 모든 새 항목에 `attributed: true`. 이 표시가 없는 항목은 귀속 기능 이전 것이라 서브의 일이 메인으로
  들어 있을 수 있다 — UI는 그것을 "메인 확정"으로 보이지 않는다(§4.3).
- 스탬프(`index.ts` → `stampWorkLogAgent`): `agentId`가 있으면 그 서브의 ledger의 현재 task로 `taskId`/`taskTitle`, `tool`이면
  그 서브의 `toolCalls`+1·`lastTool`. 없으면 종전대로 세션 ledger(메인).

### 2.5 사용량

세션 총 토큰·비용의 집계원은 종전 하나다(턴 중 `liveUsage` 호출별 합 → 턴 끝 result `modelUsage`). 서브의 호출은 합에 들어가고
(실제로 쓴 돈), 키가 `s:`로 시작해 `liveOccupancyCall`(컨텍스트 점유율)에서만 빠진다. 에이전트별 토큰은 표시용이며 세션 합에
더하지 않는다(이중 계산 금지).

## 3. 카드 payload [PR-A] (`src/conversation/dashboard.ts`)

- `KanbanSession.agents?: DashboardAgent[]` — 서브만(메인 = 카드 자신), 스폰 순. 최대 `AGENTS_ON_CARD_MAX` = 40개: 실행 중
  에이전트와 그 조상 먼저, 나머지는 최신. `agentsTotal` = 전체 수. 서브가 한 번도 없었던 세션은 두 키가 모두 없다.
- `DashboardAgent` = `{ id, n, parentId?, type?, description?, background?, status, startedAt, endedAt?, toolCalls, lastTool?, tokens?,
  durationMs?, summary?, tasks?, earlierTasks? }`. `tasks`는 `normalizeTaskProgress` — 그 에이전트가 running일 때만 현재 task
  최대 1개, 아니면 0개. 지시 전문·결과 전문은 싣지 않는다 — 작업 로그의 `agentRef` 항목 raw로 지연 로드한다.
- 아카이브 카드도 `agents`를 싣고, 아카이브가 running으로 기억한 에이전트는 `unknown`이다.
- 실시간: 레지스트리가 바뀌면(`applyAgentEvent`가 true) 그리고 서브의 `tool` 항목마다 `scheduleLiveSessionUpdate` → WS
  `sessionUpdated`(세션당 1초 1회).

## 4. UI [PR-B]

설계 근거: 선행 사례 조사(Claude Code agent view·VS Code agent map, LangSmith/Langfuse trace tree·waterfall, Devin Agents 탭,
Linear agent activity)와 설계 자문(trinity-fallback astra-zhuge, fable 의견 병기).

### 4.1 접힌 카드

서브가 있을 때만 한 줄 `.card-agents`: 상태 점(최대 6개 + `+N`, 점은 보조) + 텍스트 `서브에이전트 N · 실행 r · 실패 f`
(0인 항목은 생략, 실패는 0보다 크면 항상). 색만으로 상태를 전하지 않는다.

### 4.2 펼친 카드 — 에이전트 트리

task 타임라인 앞에 `에이전트` 섹션. 첫 행 `메인` (모델 · task 완료/전체), 그 아래 스폰 순으로 서브 행, 깊이마다 12px 들여쓰기와
CSS 테두리 트리 선(글리프 아님). 행 = 상태 아이콘+단어 · `A<n>` · 타입 · 설명(말줄임) · 경과/소요 · 툴 수 · `배경` 배지, 둘째 줄 =
그 서브의 현재 task 또는 마지막 도구. 행 아래 얇은 워터폴 막대: 시간축 = 서브 집합의 첫 시작 ~ 마지막 종료(또는 지금) — 겹침이
병렬로 읽힌다. 각 행은 버튼: 패널을 그 에이전트로 연다. 처음엔 8행까지, 나머지는 `전체 N개 보기`.

### 4.3 패널 — 에이전트 범위

- 토큰 배지와 Tasks 사이에 고정 한 줄 `에이전트 바`: 경로(`메인 › A2 Explore`, 각 조각이 버튼) + `에이전트 N ▾` 펼침 버튼.
  펼치면 세로 트리 목록(높이 상한·자체 스크롤, 모바일도 세로), 항목은 네이티브 버튼 + `aria-current`.
- 선택한 에이전트가 Tasks 블록과 작업 로그를 정한다(기본 메인). 서브 선택 시 바 아래 요약 한 줄(상태·경과·툴·토큰·배경·SDK 요약).
- 작업 로그는 선택 범위만: 메인 = `agentId` 없는 항목, 서브 = `agentId`가 그 서브인 항목 + `agentRef`가 그 서브인 항목(맨 앞
  `지시` = 스폰 호출 raw, 맨 끝 `결과` = 반환 raw — 배경 ack면 `배경 실행 시작`). 메인 로그의 스폰 행에는 `열기 →`.
  task 그룹·원본 열람·키보드 계약(§10 3.1-6, §11 T10)은 선택 범위 안에서 그대로, 그룹 열림 상태는 (에이전트, task) 단위.
- `attributed` 없는 항목이 `Agent`/`Task` 호출을 포함하면 메인 범위에서 그 구간 앞에 `이전 통합 로그 — 메인/서브 귀속 미확인`.
- 목록 밖(상한)으로 밀린 에이전트의 항목도 작업 로그에 있으면 목록 끝 `기타 에이전트`로 도달 가능.
- 서브 선택 중 토큰 배지·대화 내역은 세션 전체 값이라 `세션 전체` 표시.

### 4.4 반응형·모션

≥1024 / 640–1023 / <640 보드 계약(§10 5) 그대로. 카드 트리는 <640에서 메타가 둘째 줄로 내려가고 워터폴 막대는 전체 폭.
패널 바·목록 행 ≥44px(<640·coarse). 상태 스피너는 reduced motion에서 정지, 펼침은 §10 4의 토큰만 쓴다.

## 5. 검증

- 단위(PR-A): `src/agent-runtime/__tests__/sdk-message-to-event.subagent.test.ts`, `packages/slack/src/__tests__/stream-processor.subagent.test.ts`,
  `src/session/__tests__/agent-registry.test.ts`, `src/conversation/__tests__/work-log.test.ts`(agentId/agentRef/attributed),
  `packages/slack/src/__tests__/live-usage.test.ts`(sidechain), `src/conversation/__tests__/dashboard-agent-tree.test.ts`(payload).
- PR-B: 클라이언트 함수 테스트 + Playwright 실측(1280/820/390 × 라이트/다크, 가짜 세션에 서브 트리).

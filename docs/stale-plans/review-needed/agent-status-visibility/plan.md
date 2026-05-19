# Agent Status Visibility — Implementation Plan (v2)

Workspace: `/tmp/U094E5L4A15/zhuge-bugfix-status-1776936195/soma-work`
Base HEAD: `c49665c feat(slack): P3 B3 choice block single-writer (#665) (#682)`

v1 대비 수정 사항 (codex review 78→target 95):
- epoch guard를 per-`(channelId,threadTs)` CAS로, `SessionInitializer.handleConcurrency()`에 배선
- `AssistantStatusManager`를 문자열 대신 `StatusDescriptor`(resolver 함수) 기반으로 리팩터링 — heartbeat tick마다 elapsed 재계산 가능
- background Bash 진행 표시는 기존 MCP progress 계약(`mcpCallTracker.startCall` + `toolTracker.trackMcpCall` + `mcpStatusDisplay.registerCall` + 기존 `endMcpTracking`) 재사용. `registerCall/completeCall`이라는 가상 API 없음
- `BashOutput`/`KillShell` 제거 — 실제 harness emit 검증된 적 없음. background Bash 단일 tool 추적에 한정
- Formatter 수정 범위를 `formatToolUse`(detail switch) + `formatOneLineToolUse`(compact) + `formatToolUseVerbose`로 전 경로 일치
- runtime-load 체크리스트를 `src/local/agents/orchestrator.md` include 경로 / `llm-dispatch/SKILL.md` file-path load로 재기술
- 테스트는 기존 co-located 파일들을 확장

## 1. Issue Draft

### Title
`fix(slack): agent status visibility — lost clearStatus, silent background bash, unenforced ScheduleWakeup ban`

### Problem
에이전트가 "지금 뭘 하고 있는지" 유저가 볼 수 없게 되는 3개의 독립 증상. 모두 "에이전트 상태 가시성" 한 주제의 하위 항목.

### Evidence

**A. Slack `assistant.threads.setStatus` on/off 신뢰성**
- `src/slack/assistant-status-manager.ts:26-124` — `enabled`, `heartbeats`, `lastStatus: Map<key, {channelId, threadTs, status:string}>` 구조. status가 정적 문자열이라 heartbeat tick에 elapsed 재계산 불가
- `src/slack/assistant-status-manager.ts:34-54` — 첫 `setStatus` 실패 시 `enabled=false` + `clearAllHeartbeats()`만 하고 Slack UI 상 잔존 spinner clear 시도 없음
- `src/slack/pipeline/stream-executor.ts:948` — `setStatus('')` → heartbeat가 빈 문자열 status를 20s마다 재전송
- `src/slack/pipeline/stream-executor.ts:1247-1294` finally — `clearStatus` 없음 (1025 정상 clear, 1325 error clear만)
- `src/slack/pipeline/session-initializer.ts:624, 678, 701-726` — dispatch 실패 fallback 경로에서 `clearStatus` 누락
- `src/slack/pipeline/session-initializer.ts:934-964 handleConcurrency` — 새 요청이 `requestCoordinator.abortSession(sessionKey)`로 이전 턴을 끊을 때, 이전 턴 finally의 `clearStatus`가 새 턴의 `setStatus` 뒤에 도착해 spinner를 꺼버릴 수 있음 (per-thread race)

**B. Bash `run_in_background=true` 진행 표시 부재**
- `src/slack/tool-event-processor.ts:141-160 handleToolUse` — `mcp__*`, `Task`만 `mcpStatusDisplay.registerCall` 경로. Bash는 completely 무시
- `src/slack/tool-event-processor.ts:202-222 startSubagentTracking` — `_subagent` 가상 서버로 기존 진행 파이프라인 태우는 **검증된 패턴**. 이를 Bash bg에 그대로 모방
- `src/slack/tool-formatter.ts:117-119 formatBashTool` — `input.run_in_background` 플래그 파싱 안 함
- `src/slack/assistant-status-manager.ts:10 TOOL_STATUS_MAP.Bash = 'is running commands...'` — 정적 문자열 (elapsed/bg count 반영 불가)

**C. ScheduleWakeup 사용금지 정책 미반영**
- 레포 전체에서 `ScheduleWakeup` 매칭 0건

### Scenarios / Acceptance Criteria

- [ ] **S1** 정상 턴 종료 → `clearStatus` 호출
- [ ] **S2** 예외 경로 finally → `clearStatus` 도달
- [ ] **S3** `session-initializer.dispatch()` 실패 fallback → `clearStatus`
- [ ] **S4** `setStatus('')`는 `clearStatus`로 리라우트 (빈 문자열 heartbeat 제거)
- [ ] **S5** `enabled=false` 전환 시 `slackApi.setAssistantStatus(ch,ts,'')` 1회 best-effort
- [ ] **S6** `(channelId, threadTs)` epoch guard: 이전 세대 `clearStatus`가 새 세대 `setStatus`를 덮지 않음
- [ ] **S6b** multi-thread 독립: 한 스레드 epoch bump이 다른 스레드 상태 영향 0
- [ ] **S7** `Bash({run_in_background:true})` → 기존 MCP progress 파이프라인 태워 "⏳ Running in background — `<cmd prefix>` (Ns)" live tick
- [ ] **S8** 해당 Bash의 tool_result 수신 시 `endMcpTracking`로 기존 완료 렌더링
- [ ] **S9** Bash 네이티브 스피너: 활성 bg 1개 이상일 때 `"is waiting on background shell (Ns)"` — `AssistantStatusManager`가 descriptor resolver로 tick마다 재계산
- [ ] **S10** background bash가 tool_result 없이 턴 종료 → turn end 시 active call 전부 `endMcpTracking` 정리
- [ ] **S11** verbosity mode 3종(detail/compact/verbose) formatter 출력 일관성 유지
- [ ] **S12** `src/local/agents/orchestrator.md` / `src/local/skills/llm-dispatch/SKILL.md`에 "ScheduleWakeup 사용금지 — 호출 시 미복귀. 대체: Bash `run_in_background` + Monitor" 룰 명시. 해당 MD들은 각각 orchestrator subagent system prompt 구성 / skill file-path load 경로에서 실제 로드됨

## 2. PR Plan (File-by-File)

### [A] Slack status 신뢰성

**A-1. `src/slack/assistant-status-manager.ts`** (핵심 리팩터링)
- `StatusDescriptor` 타입 도입: `{ staticText?: string; resolver?: () => string }`. 둘 중 하나만.
- `lastStatus: Map<key, {channelId, threadTs, descriptor, epoch}>`로 변경. `epoch: number`는 키별 단조 증가.
- **Epoch 계약 확정 (codex review 개선지시 2의 선택지 B)**: `setStatus`는 **항상 현재 epoch를 stamp만** 하고 guard 안 함. Epoch guard는 **오직 `clearStatus`에만** 적용. 이렇게 하면 "stale clear가 새 spinner를 끈다"는 핵심 race만 정확히 차단하고, API 설계가 단일 책임을 유지.
- `setStatus(channelId, threadTs, status: string | StatusDescriptor)` — epoch 파라미터 없음:
  - 인자가 빈 문자열이면 내부 `clearStatus()` 호출로 리라우트 (guard)
  - descriptor resolver가 있으면 보관하고 heartbeat tick마다 `resolver()` 재계산 후 `slackApi.setAssistantStatus`
  - lastStatus에 저장 시 현재 키의 `epoch`를 stamp
- `bumpEpoch(channelId, threadTs): number` 신규 public — 호출 시점의 epoch 번호 +1 후 반환. 이후 도착하는 stale `clearStatus`는 이 가드로 무시
- `clearStatus(channelId, threadTs, options?: { expectedEpoch?: number })`:
  - `expectedEpoch` 지정 시 현재 키의 epoch와 일치할 때만 Slack API 호출 + heartbeat 정리
  - 미지정 시 무조건 정리 (기존 호환)
  - 빈 인자 `setStatus('')`가 내부적으로 이 경로로 리라우트될 때는 `expectedEpoch` 미지정
- `enabled=false` 전환 지점 (`setStatus` catch + heartbeatTick catch) 두 곳 모두 `slackApi.setAssistantStatus(ch, ts, '')` 1회 best-effort try/catch
- `getToolStatusText(toolName, serverName?, channelId?, threadTs?)` — 시그니처 확장. 기존 호출부(`tool-event-processor.ts:182`)는 `context.channel`/`context.threadTs`를 이미 가지고 있으므로 그대로 넘김. 내부에서 `key = "${channelId}:${threadTs}"`로 조회해 활성 bg count>0이면 `"is waiting on background shell..."` 반환
- `registerBackgroundBashActive(channelId, threadTs): () => void`: 해당 key의 활성 bg call counter 증가, 반환 unregister 함수는 감소. 카운터 `Map<key, number>`
- Bash 네이티브 스피너를 **descriptor로 직접 설정**하려는 호출자는 `setStatus(channel, ts, { resolver: () => this.buildBashStatus(key) })` 형태로 주입 가능 — resolver 경로는 bg counter 변화를 heartbeat tick마다 반영

**A-2. `src/slack/pipeline/stream-executor.ts`** (실제 메서드명은 `execute()`)
- `execute()` 메서드 초입: `const epoch = this.assistantStatusManager.bumpEpoch(channel, threadTs)` — 이후 clearStatus 경로가 참조할 epoch를 캡처
- line 948 근처 `setStatus('')` → `assistantStatusManager.clearStatus(channel, threadTs, { expectedEpoch: epoch })`로 교체 (빈 문자열 heartbeat 차단 + 가드)
- 메인 finally (1247-1294) 블록 안에 `await this.assistantStatusManager.clearStatus(channel, threadTs, { expectedEpoch: epoch })` 추가. 매니저가 idempotent이므로 중복 호출 안전
- abort 분기 600-648: abort 자체는 SessionInitializer가 주도. 이 파일에선 추가 작업 불필요 (execute()의 finally clearStatus가 epoch 가드로 처리)
- `handleError(1325)` 경로 clearStatus에도 `expectedEpoch: epoch` 전달
- **line 614-615 Bash 네이티브 spinner 배선 (S9)**: 기존 `setStatus(channel, threadTs, assistantStatusManager.getToolStatusText(toolName))` 호출부를 Bash일 때 **`setStatus(channel, threadTs, { resolver: () => assistantStatusManager.buildBashStatus(channel, threadTs) })`** 로 교체. resolver 경로는 heartbeat tick에서 bg counter 변화를 반영한 문구 재계산. Bash 외 tool은 기존 문자열 경로 유지.

**A-3. `src/slack/pipeline/session-initializer.ts`**
- `handleConcurrency(934-964)`: `requestCoordinator.abortSession(sessionKey)` 직후 `this.deps.assistantStatusManager.bumpEpoch(channel, threadTs)` 호출. 반환값 caller에 노출은 **하지 않음** — 대신 `dispatch()` 자신이 자체 `bumpEpoch`로 epoch를 따로 캡처하므로 충돌 없음. `handleConcurrency`의 기존 반환형(`AbortController`) 그대로 유지 → call sites `session-initializer.ts:530, 841` 수정 불필요
- `dispatch()` 루틴: 진입 시 `const epoch = this.deps.assistantStatusManager.bumpEpoch(channel, threadTs)`로 **자체 epoch를 캡처**. `setStatus`는 그대로, fallback 경로의 모든 `clearStatus` 호출에 **`{ expectedEpoch: epoch }`** 전달
- fallback 경로 (624, 678, 701-726) `clearStatus` 호출 — 새 턴이 이미 bump한 뒤 늦게 도달하는 stale clear로 새 스피너 끄는 일 방지
- `handleConcurrency`의 deps 타입에 `assistantStatusManager` 추가 (아직 없으면) — wiring은 `SessionInitializer` 생성 시 이미 전달되고 있는지 확인 후 보강

### [B] Bash background 진행 표시

**B-1. `src/slack/tool-formatter.ts`** (3경로 모두)
- `formatBashTool` (detail path, 117-119):
  - `input.run_in_background === true`일 때 prefix를 "🖥️ Running in background" 로, command와 `shell_id` (있으면) 표기
- `formatOneLineToolUse` (compact path, 주변 라인 333-352):
  - `'Bash'` case에서 동일 background 분기 — 한 줄 label
- `formatToolUseVerbose` (verbose path, 주변 524-569):
  - input 전체 덤프 시 `run_in_background` 플래그도 같이 렌더
- 새 포매터 파일 생성 금지 — 기존 dispatch switch/map 안에서 처리

**B-2. `src/slack/tool-event-processor.ts`**
- `handleToolUse` (141-160)에 분기 추가:
  ```ts
  if (toolUse.name === 'Bash' && (toolUse.input as any)?.run_in_background === true) {
    await this.startBackgroundBashTracking(toolUse, context);
  }
  ```
- `startBackgroundBashTracking` 신규 — `startSubagentTracking`(202-222) 그대로 모방:
  - `mcpCallTracker.startCall('_bash_bg', 'bash')`
  - `toolTracker.trackMcpCall(toolUse.id, callId)`
  - `mcpStatusDisplay.registerCall(sessionKey, callId, { displayType: 'BashBG', displayLabel: `\`${cmdPrefix}\``, initialDelay: 0, predictKey: {serverName:'_bash_bg', toolName:'bash'}, paramsSummary: '' }, channel, threadTs)`
  - `const unregister = assistantStatusManager.registerBackgroundBashActive(channel, threadTs)`
  - `BackgroundBashRegistry.add(sessionKey, { toolUseId: toolUse.id, callId, unregister })`
- `BackgroundBashRegistry` (신규, 단일 인스턴스 or `ToolEventProcessor` 필드):
  - 내부 구조: `private map = new Map<string /*sessionKey*/, Map<string /*toolUseId*/, { callId: string; unregister: () => void }>>`
  - API: `add(sessionKey, entry)`, `remove(sessionKey, toolUseId) -> entry | undefined`, `drain(sessionKey) -> entry[]` (sweep용)
- `handleToolResult` 경로:
  - 기존 `endMcpTracking(toolUse.id)`는 내부적으로 `mcpCallTracker.endCall(callId)` 호출 — `_bash_bg` callId도 동일 경로로 닫힘
  - `const entry = BackgroundBashRegistry.remove(sessionKey, toolUse.id); entry?.unregister()`로 active counter 감소
- 턴 종료 시 `sweepActiveBackgroundBash(sessionKey)` (`cleanup()` / turn-end hook):
  - `const entries = BackgroundBashRegistry.drain(sessionKey)`
  - 각 entry에 대해 `endMcpTracking(entry.toolUseId)` 호출 — 이게 이미 내부적으로 `mcpStatusDisplay.completeCall(callId)`를 부르므로 **별도 completeCall 호출 금지** (중복)
  - 이어서 `entry.unregister()` 호출로 bg active counter 감소

**B-3. `src/slack/mcp-status-tracker.ts`** — 기존 엔진 재사용 + `BashBG` 최소 분기 1개 허용.
- 현 tracker는 single-call 렌더 시 `*{displayType} 실행 중: {displayLabel}*` + 별도 `경과 시간:` 줄 강제 (codex 확인).
- `displayType === 'BashBG'` 분기 추가: 렌더 문구를 `⏳ Running in background — ` + displayLabel + ` (Ns)` 한 줄로 커스터마이즈. 다른 displayType은 기존 렌더 유지.
- 이로써 S7 acceptance "⏳ Running in background — <cmd> (Ns)" 문구와 tracker 구현이 일치.

### [C] ScheduleWakeup 금지 정책

**C-1. `src/local/agents/orchestrator.md`** (wrapper — `:20` include 지점에서 `orchestrator-workflow.md`를 로드)
- 금지 도구 섹션 추가 (규율 섹션 근처):
  ```
  ## 금지 도구
  - **ScheduleWakeup 사용금지**. 호출해도 세션 재진입이 보장되지 않음.
  - 폴링이 필요하면 `Bash(run_in_background=true)` + `Monitor` + 필요 시 `TaskStop` 사용.
  ```

**C-2. `src/local/prompts/orchestrator-workflow.md`** (**실제 내용 본체** — `orchestrator.md`에서 include됨)
- 같은 금지 도구 섹션을 이 파일에도 동일하게 추가. 이 파일이 실질적 workflow prompt 본체라서 본문에 정책을 박는 것이 자연스러움. wrapper인 `orchestrator.md`에는 간략한 한 줄만, 본체인 `orchestrator-workflow.md`에 완전한 섹션.

**C-3. `src/local/skills/llm-dispatch/SKILL.md`** (file-path load)
- "Anti-patterns" 섹션에 한 줄:
  ```
  - **ScheduleWakeup 금지**: 불러도 미복귀. 장기 폴링은 Monitor + run_in_background Bash.
  ```

## 3. Test Plan (기존 co-located 파일 확장)

| 파일 (기존) | 추가 내용 |
|---|---|
| `src/slack/assistant-status-manager.test.ts` | setStatus(''): clearStatus 경로 호출 assertion / disable 시 setAssistantStatus('') 1회 호출 / bumpEpoch 후 stale clearStatus 무시 / descriptor resolver 재계산 |
| `src/slack/assistant-status-manager.heartbeat.test.ts` | 빈 status heartbeat 발생 안 함 / descriptor tick마다 resolver 재호출 / disable 후 heartbeat 정지 + best-effort clear |
| `src/slack/tool-event-processor.test.ts` | Bash run_in_background=true → startCall + trackMcpCall + registerCall 호출 / false면 호출 없음 / tool_result로 endMcpTracking 진입 / multi-bash 동시 active counter |
| `src/slack/tool-formatter.test.ts` | formatBashTool(run_in_background:true) 라벨 / formatOneLineToolUse Bash bg / formatToolUseVerbose bg 플래그 표기 / 기존 foreground Bash 회귀 없음 |
| `src/slack/pipeline/stream-executor.test.ts` | 예외 finally → clearStatus 도달 / epoch capture + expectedEpoch 가드 / setStatus('') → clearStatus 리라우트 |
| `src/slack/pipeline/session-initializer-routing.test.ts` | handleConcurrency abort → bumpEpoch 호출 / dispatch fallback → clearStatus 호출 |

- 기존 mock이 `bumpEpoch` 모르는 경우: 각 테스트 파일의 spy/mock 객체에 메서드 추가 (codex 지적)
- 스냅샷 테스트 있으면 foreground Bash는 동일 스냅샷 유지

## 4. Risks & Mitigations

| 위험 | 완화 |
|---|---|
| epoch를 글로벌 카운터로 잘못 구현해 다른 스레드 상태 영향 | key 단위 `Map<`channelId:threadTs`, epoch>`로 저장. 테스트 S6b 커버 |
| descriptor 전환이 기존 `setStatus(string)` 호출자를 깨뜨림 | 인자 유니온 타입 `string \| StatusDescriptor`. 문자열 오면 내부에서 `{staticText}`로 wrap. 모든 기존 호출자 변경 없음 |
| heartbeat tick 시 resolver 호출이 IO 유발 | resolver는 순수 함수 (매니저 내부 state만 참조). elapsed 계산은 `Date.now()` 정도 |
| background Bash가 tool_result 없이 끝남 | turn cleanup hook에서 sessionKey의 active `_bash_bg` callId 전부 `endMcpTracking` + counter 0 리셋 |
| formatter compact/detail/verbose 사이 불일치 | 동일 분기 로직을 helper `isBackgroundBash(input)`로 추출해 3경로 공유 |
| Bash 네이티브 스피너 문구가 bg 없는데 bg 문구 표시 | `getToolStatusText`가 counter>0 조회 후 분기 |

## 5. Entry-Point Wiring Checklist

구현 phase 진입 시 grep으로 **직접 검증**.

- [ ] `AssistantStatusManager.bumpEpoch`이 **`session-initializer.ts:handleConcurrency`에서 호출**되는지 (`rg "bumpEpoch\\("`로 확인)
- [ ] `AssistantStatusManager.registerBackgroundBashActive`이 **`tool-event-processor.ts:startBackgroundBashTracking`에서 호출**되는지
- [ ] `stream-executor.ts` 메인 finally에 추가한 `clearStatus` 호출이 **정상/예외 양쪽 경로** 도달 (테스트 S1/S2로 보장)
- [ ] `session-initializer.ts` dispatch fallback catch 분기에서 `this.deps.assistantStatusManager` 실제 인스턴스 접근 가능 (deps 타입/wiring 확인)
- [ ] `tool-event-processor.ts:handleToolUse` 새 Bash bg 분기가 **`mcp__*`/`Task`와 동일 이벤트 라우터 레벨**에서 호출됨
- [ ] `startBackgroundBashTracking`이 `startSubagentTracking` 호출부와 동등한 `shouldOutput(OutputFlag.MCP_PROGRESS, ...)` 플래그 가드 공유 (일관성)
- [ ] `tool-formatter.ts`의 3경로(`formatBashTool` detail, `formatOneLineToolUse` compact, `formatToolUseVerbose`) 모두 bg 분기 반영
- [ ] `TOOL_STATUS_MAP.Bash` 참조 지점이 **함수화된 `getToolStatusText('Bash')`로만 접근**되는지 (직접 참조 잔존 금지)
- [ ] `src/local/agents/orchestrator.md`가 실제 runtime에서 loaded (현 레포 코드상 `orchestrator` subagent 스킬/프롬프트 경로로 include됨 — `rg "orchestrator.md"` 및 skill loader 경로 확인)
- [ ] `src/local/skills/llm-dispatch/SKILL.md` — file-path load이므로 파일 존재 + SKILL.md 포맷 유지면 충분. `llm-dispatch`가 invoke되는 시점에 내용 참조됨 (`rg "llm-dispatch"` 확인)

## 6. Out of Scope

- Claude Code harness 자체 수정
- Slack 앱 manifest 변경
- 다른 tool(Write/Read/Glob 등) elapsed 표시 확장
- `ScheduleWakeup`을 하드 차단하는 runtime filter (위치 미검증 — 문서/프롬프트 경고에 한정)
- `BashOutput`/`KillShell` tool 포매터 — 실제 harness emit 여부 미검증
- Monitor/TaskOutput/TaskStop 포매터 확장 — 필요 시 별도 이슈

## 7. Implementation Order

1. **A-1** `assistant-status-manager.ts` (descriptor + epoch + disable fallback + bg counter + Bash 동적 문구)
2. **A-3** `session-initializer.ts` (handleConcurrency bumpEpoch + dispatch fallback clearStatus)
3. **A-2** `stream-executor.ts` (execute() 초입 bumpEpoch capture + finally clearStatus + 948 리라우트 + abort 분기 expectedEpoch)
4. **B-2** `tool-event-processor.ts` (startBackgroundBashTracking + cleanup sweep)
5. **B-1** `tool-formatter.ts` (3경로 bg 라벨 + isBackgroundBash helper)
6. **C-1/C-2** prompt/skill 업데이트
7. **Tests** 각 단계 뒤 RED → GREEN (위 Test Plan 표)
8. **stv:verify** 0 issues
9. **CI pass**

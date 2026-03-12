# Thinking Steps Streaming Refactoring Plan

Date: 2026-02-25
Status: Draft
Related: `docs/slack-block-kit.md` §5

## 배경

현재 파이프라인은 `chat.postMessage` + `chat.update` 기반으로 도구 실행 과정을 표시한다.
Slack이 2026-02에 도입한 Thinking Steps API (`plan`/`task_card` blocks + streaming chunks)를 활용하면
중간 결과를 구조화된 UI로 보여줄 수 있다.

### 현재 구조 (AS-IS)

```
StreamExecutor.execute()
  ├─ statusReporter.createStatusMessage()    → chat.postMessage ("🤔 Thinking...")
  ├─ reactionManager.updateReaction()        → reactions.add (thinking emoji)
  ├─ assistantStatusManager.setStatus()      → assistant.threads.setStatus (native spinner)
  │
  ├─ StreamProcessor.process() loop:
  │   ├─ assistant message (tool_use)
  │   │   ├─ statusReporter.updateStatus()   → chat.update ("🔧 Working...")
  │   │   ├─ toolEventProcessor.handleToolUse() → chat.postMessage (tool call text)
  │   │   └─ mcpStatusTracker                → chat.postMessage + chat.update (progress bar)
  │   │
  │   ├─ user message (tool_result)
  │   │   └─ toolEventProcessor.handleToolResult()
  │   │       ├─ compact mode: chat.update (same message, ✅/❌ prefix)
  │   │       └─ verbose mode: chat.postMessage (separate result message)
  │   │
  │   └─ result message (final)
  │       └─ chat.postMessage (final text + footer)
  │
  ├─ statusReporter.updateStatus("completed")
  ├─ reactionManager.updateReaction(completed emoji)
  └─ assistantStatusManager.clearStatus()
```

**문제점**:
1. 도구 실행마다 새 메시지 → 스레드 flood
2. MCP 장시간 호출 시 텍스트 기반 progress bar → 구조화 부족
3. 상태/반응/스피너 3중 시스템 관리 복잡
4. compact 모드에서 chat.update 빈번 호출 → rate limit 위험

### 목표 구조 (TO-BE)

```
StreamExecutor.execute()
  ├─ chat.startStream(task_display_mode: "plan"|"timeline")
  │   └─ 초기 chunks: [plan_update + pending tasks]
  │
  ├─ StreamProcessor.process() loop:
  │   ├─ assistant message (tool_use)
  │   │   └─ chat.appendStream(chunks: [
  │   │       { type: "task_update", id, title: toolName, status: "in_progress", details }
  │   │     ])
  │   │
  │   ├─ user message (tool_result)
  │   │   └─ chat.appendStream(chunks: [
  │   │       { type: "task_update", id, status: "complete"|"error", output }
  │   │     ])
  │   │
  │   ├─ assistant message (text)
  │   │   └─ chat.appendStream(chunks: [
  │   │       { type: "markdown_text", text: "..." }
  │   │     ])
  │   │
  │   └─ result message (final)
  │       └─ (usage data 수집)
  │
  └─ chat.stopStream(blocks: [plan block with final task_cards])
```

**이점**:
1. 단일 메시지에 전체 작업 과정 표시 → 스레드 깔끔
2. 네이티브 task_card UI → 접기/펼치기, 출처 링크
3. appendStream rate limit Tier 4 (100+/min) → 충분
4. 상태 시스템 단순화 (task status가 곧 진행 상태)

---

## Phase 1: StreamingClient 추상화

### 목표
Slack streaming API (startStream/appendStream/stopStream)를 래핑하는 클라이언트 도입.

### 변경 파일
- **NEW** `src/slack/streaming-client.ts`

### 설계

```typescript
// src/slack/streaming-client.ts

interface StreamingChunk {
  type: 'markdown_text' | 'task_update' | 'plan_update';
}

interface MarkdownChunk extends StreamingChunk {
  type: 'markdown_text';
  text: string;
}

interface TaskUpdateChunk extends StreamingChunk {
  type: 'task_update';
  id: string;
  title: string;
  status?: 'pending' | 'in_progress' | 'complete' | 'error';
  details?: string;
  output?: string;
  sources?: Array<{ type: 'url'; text: string; url: string }>;
}

interface PlanUpdateChunk extends StreamingChunk {
  type: 'plan_update';
  title: string;
}

type Chunk = MarkdownChunk | TaskUpdateChunk | PlanUpdateChunk;

interface StreamingClientOptions {
  channel: string;
  threadTs: string;
  taskDisplayMode: 'timeline' | 'plan';
  recipientUserId?: string;
}

class StreamingClient {
  private streamTs: string | undefined;
  private isActive = false;

  constructor(
    private client: WebClient,
    private options: StreamingClientOptions
  ) {}

  /** startStream — 초기 chunks 전송, ts 반환 */
  async start(chunks?: Chunk[]): Promise<string>;

  /** appendStream — 중간 업데이트 전송 */
  async append(chunks: Chunk[]): Promise<void>;

  /** stopStream — 최종 blocks로 마무리 */
  async stop(blocks?: any[]): Promise<void>;

  /** 편의 메서드: 태스크 상태 업데이트 */
  async updateTask(id: string, update: Partial<TaskUpdateChunk>): Promise<void>;

  /** 편의 메서드: 마크다운 텍스트 추가 */
  async appendText(text: string): Promise<void>;

  /** 스트림 활성 여부 */
  get active(): boolean;
}
```

### 핵심 주의사항
- `startStream` 실패 시 `chat.postMessage`로 fallback (기존 방식)
- `appendStream` 호출 간 최소 간격 제한 (debounce/batch)
- `markdown_text` 최대 12,000자 제한 준수
- unfurling 비활성화 (스트리밍 제약)

---

## Phase 2: TaskMapper — 도구 호출을 Task로 매핑

### 목표
Claude SDK의 tool_use/tool_result 이벤트를 task_update chunk로 변환하는 매퍼 도입.

### 변경 파일
- **NEW** `src/slack/task-mapper.ts`

### 설계

```typescript
// src/slack/task-mapper.ts

interface ActiveTask {
  id: string;          // tool_use.id 재사용
  toolName: string;
  title: string;       // 사람 읽기 좋은 도구 이름
  status: 'pending' | 'in_progress' | 'complete' | 'error';
  startedAt: number;
  details?: string;
  output?: string;
  sources?: Array<{ type: 'url'; text: string; url: string }>;
}

class TaskMapper {
  private tasks = new Map<string, ActiveTask>();

  /** tool_use → task_update chunk (status: in_progress) */
  onToolUse(toolUse: ToolUseEvent): TaskUpdateChunk;

  /** tool_result → task_update chunk (status: complete|error) */
  onToolResult(toolResult: ToolResultEvent): TaskUpdateChunk;

  /** 현재 활성 태스크 목록 → plan block tasks (stopStream용) */
  toFinalBlocks(): TaskCardBlock[];

  /** 도구 이름 → 사람 읽기 좋은 제목 */
  private formatToolTitle(toolName: string, input?: any): string;

  /** 도구 결과 → 짧은 output 텍스트 */
  private formatToolOutput(toolName: string, result: any, isError: boolean): string;
}
```

### 도구 이름 매핑 예시

| SDK 도구 | 표시 제목 | details |
|----------|-----------|---------|
| `Read` | `Reading file` | 파일 경로 |
| `Edit` | `Editing file` | 파일 경로 + 변경 요약 |
| `Write` | `Writing file` | 파일 경로 |
| `Bash` | `Running command` | 명령어 (truncated) |
| `Grep` | `Searching code` | 패턴 |
| `Glob` | `Finding files` | 패턴 |
| `Task` | `Running subagent` | 설명 |
| `WebSearch` | `Searching web` | 쿼리 |
| `WebFetch` | `Fetching URL` | URL |
| `mcp__*` | `Calling {server}:{method}` | 파라미터 요약 |

---

## Phase 3: StreamProcessor 통합

### 목표
기존 StreamProcessor의 메시지 루프에 StreamingClient + TaskMapper를 통합.

### 변경 파일
- **MODIFY** `src/slack/stream-processor.ts`
- **MODIFY** `src/slack/pipeline/stream-executor.ts`

### 전략: Dual-Mode 운영

StreamProcessor에 `useNativeStreaming: boolean` 옵션 추가.
- `true`: 새 Thinking Steps 파이프라인 사용
- `false`: 기존 postMessage/update 파이프라인 유지

이렇게 하면 점진적 마이그레이션이 가능하고, 문제 발생 시 즉시 롤백 가능.

### StreamExecutor 변경 흐름

```typescript
// stream-executor.ts (Phase 3)

async execute(params: StreamExecuteParams): Promise<ExecuteResult> {
  const useNativeStreaming = this.shouldUseNativeStreaming(session);

  if (useNativeStreaming) {
    // 1. startStream
    const streamingClient = new StreamingClient(client, {
      channel, threadTs,
      taskDisplayMode: this.selectDisplayMode(session),
    });
    const ts = await streamingClient.start([
      { type: 'plan_update', title: this.getPlanTitle(text) },
    ]);

    // 2. StreamProcessor with streaming callbacks
    const taskMapper = new TaskMapper();
    const streamCallbacks: StreamCallbacks = {
      onToolUse: async (toolUses) => {
        for (const tu of toolUses) {
          const chunk = taskMapper.onToolUse(tu);
          await streamingClient.append([chunk]);
        }
      },
      onToolResult: async (toolResults) => {
        for (const tr of toolResults) {
          const chunk = taskMapper.onToolResult(tr);
          await streamingClient.append([chunk]);
        }
      },
      // ... 기타 콜백
    };

    await streamProcessor.process(stream, streamContext, streamCallbacks);

    // 3. stopStream with final blocks
    const finalBlocks = taskMapper.toFinalBlocks();
    await streamingClient.stop(finalBlocks);
  } else {
    // 기존 로직 유지
    // ...
  }
}
```

### task_display_mode 선택 로직

```
if (tool call count > 3) → "plan" (여러 단계 그룹화)
else → "timeline" (개별 순차)
```

실전에서는 첫 도구 호출 시점에 알 수 없으므로:
- 기본값: `"plan"` (대부분의 코딩 작업은 다단계)
- 사용자 설정으로 override 가능

---

## Phase 4: 기존 상태 시스템 정리

### 목표
네이티브 스트리밍 모드에서 불필요해지는 기존 상태 관리 계층 정리.

### 제거/축소 대상

| 컴포넌트 | 현재 역할 | 네이티브 스트리밍에서 | 조치 |
|----------|-----------|---------------------|------|
| `StatusReporter` | 텍스트 상태 메시지 | task status로 대체 | 조건부 비활성화 |
| `ReactionManager` | 이모지 반응 | 유지 (보조 신호) | 유지 |
| `McpStatusTracker` | MCP progress bar | task_update로 대체 | 조건부 비활성화 |
| `TodoDisplayManager` | TodoWrite 표시 | plan 내 태스크로 통합 가능 | Phase 5 |
| `ToolEventProcessor` | 도구 메시지 포스팅 | task_update로 대체 | 조건부 비활성화 |
| `AssistantStatusManager` | 네이티브 스피너 | startStream이 자동 관리 | 조건부 비활성화 |

### 접근 방식
- `useNativeStreaming` 플래그로 분기
- 기존 컴포넌트는 삭제하지 않고 조건부 비활성화
- 안정 확인 후 Phase 5에서 정리

---

## Phase 5: 고급 기능

### 5a. Subagent를 Plan 태스크로 표시
- Task(subagent) 도구 호출 시 별도 plan 내 task 그룹으로 표시
- subagent 완료 시 output에 요약 표시

### 5b. MCP 호출 progress
- 장시간 MCP 호출의 details 필드에 경과 시간 표시
- `chat.appendStream`으로 주기적 업데이트

### 5c. Context Window 표시
- 최종 stopStream blocks에 context window 사용률 포함
- footer 대신 plan의 마지막 task 또는 별도 markdown chunk

### 5d. 사용자 선택 (AskUserQuestion) 통합
- 스트리밍 중 사용자 선택이 필요한 경우
- stopStream으로 현재 스트림 종료 → 선택 UI 표시 → 새 startStream 시작

---

## 실행 순서 & 의존성

```
Phase 1: StreamingClient ──┐
                           ├─ Phase 3: 통합
Phase 2: TaskMapper ───────┘
                           │
                           ├─ Phase 4: 정리
                           │
                           └─ Phase 5: 고급 기능
```

- Phase 1, 2는 병렬 진행 가능 (독립)
- Phase 3은 Phase 1, 2 완료 후
- Phase 4는 Phase 3 안정화 후
- Phase 5는 Phase 4 이후 점진적

---

## 위험 요소 & 완화

| 위험 | 영향 | 완화 |
|------|------|------|
| startStream API 미지원 워크스페이스 | 기능 동작 안 함 | feature detection + fallback |
| appendStream rate limit 초과 | 429 에러 | batch/debounce (50ms 간격) |
| 스트리밍 중 연결 끊김 | 미완성 메시지 | timeout + stopStream 강제 호출 |
| 사용자 선택(form) 중간 삽입 | 스트림 중단 필요 | stopStream → form → startStream |
| 기존 기능 regression | 스레드 깨짐 | dual-mode + 롤백 플래그 |
| rich_text 변환 복잡도 | 최종 blocks 구성 | chunk에서는 plain string, blocks에서만 rich_text |

---

## 테스트 전략

1. **Unit**: StreamingClient — mock WebClient, 각 메서드 동작 검증
2. **Unit**: TaskMapper — tool_use/result → chunk 변환 검증
3. **Integration**: StreamExecutor dual-mode — 같은 시나리오에서 두 모드 비교
4. **E2E**: 실제 Slack 워크스페이스에서 plan/timeline 모드 시각 검증

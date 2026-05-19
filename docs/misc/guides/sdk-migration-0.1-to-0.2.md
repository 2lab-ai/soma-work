# Claude Agent SDK Migration Guide: 0.1.75 → 0.2.55

> **현재**: `@anthropic-ai/claude-agent-sdk@0.1.75` (zod@3.25)
> **목표**: `@anthropic-ai/claude-agent-sdk@0.2.55` (zod@4.x 필수)
> **작성일**: 2026-02-25

---

## Executive Summary

### 왜 업그레이드해야 하는가?

0.1.x → 0.2.x는 Claude Agent SDK의 **첫 번째 메이저 아키텍처 변경**이다.
52개 버전에 걸쳐 누적된 변화는 크게 3가지 축으로 요약된다:

| 축 | 요약 | soma-work 영향도 |
|---|---|---|
| **Zod 4 필수** | peer dep `^4.0.0`으로 변경. Zod 3 지원 중단 | 🔴 **Critical** — 직접 의존은 없지만, MCP SDK가 zod@3을 쓰므로 호환성 검증 필요 |
| **새로운 Query 제어** | `thinking`, `effort`, `close()`, `stopTask()`, `initializationResult()` 등 | 🟡 **Medium** — 선택적 채택, 기존 코드 호환 |
| **신규 메시지 타입** | 11개 새 SDKMessage subtype 추가 (task, hook, rate limit 등) | 🟢 **Low** — 기존 핸들러는 unknown type 무시 |

### soma-work 영향 범위

| 파일 | 역할 | 변경 필요 |
|---|---|---|
| `package.json` | 의존성 | ✅ SDK + zod 버전 업 |
| `src/claude-handler.ts` | SDK query 호출 | ⚠️ 타입 any → 정식 타입, 새 옵션 적용 |
| `src/slack/stream-processor.ts` | 메시지 스트림 처리 | ⚠️ 새 메시지 타입 핸들링 추가 |
| `src/mcp-config-builder.ts` | MCP 설정 빌드 | ✅ McpConfig 타입 업데이트 |

### 주요 획득 기능

1. **Adaptive Thinking** — Opus 4.6+에서 모델이 스스로 사고 깊이를 결정
2. **Effort 레벨** — `low`/`medium`/`high`/`max`로 응답 품질-속도 트레이드오프 제어
3. **Task 관리** — 서브에이전트 task의 시작/진행/완료/중단을 스트림으로 추적
4. **MCP 서버 런타임 제어** — 재연결, 토글, 인증을 Query 메서드로 직접 제어
5. **Session 목록 조회** — `listSessions()`로 기존 세션 메타데이터 검색
6. **Hook 확장** — Setup, ConfigChange, WorktreeCreate/Remove 등 6개 이벤트 추가
7. **Debug 모드** — `options.debug` / `options.debugFile`로 내부 로깅 활성화
8. **Tool Annotations** — MCP 도구에 `readOnly`, `destructive`, `openWorld` 메타데이터 부착

---

## Phase 1: Breaking Changes & 필수 마이그레이션

### 1.1 Zod 3 → Zod 4

SDK 0.2.0부터 `peerDependencies: { "zod": "^4.0.0" }`.

```bash
# 설치
npm install zod@4

# 검증
npm ls zod  # 모든 consumer가 zod@4를 resolve하는지 확인
```

**주의**: `@modelcontextprotocol/sdk@1.18.1`이 `zod@3.x`를 peer dep로 가질 수 있다.
이 경우 MCP SDK도 함께 업그레이드하거나, npm의 peer dep resolution을 확인해야 한다.

```typescript
// zod import 경로 변경 (SDK 내부용 — 우리 코드에선 직접 사용 안 함)
// BEFORE
import { z } from 'zod';
// AFTER (zod v4에서는 두 경로 모두 지원)
import { z } from 'zod';        // OK — zod@4는 루트에서도 export
import { z } from 'zod/v4';     // OK — 명시적 v4 import
```

**soma-work 영향**: 프로젝트 코드에서 `zod`를 직접 import하지 않으므로,
SDK와 MCP SDK의 peer dep 충돌만 해결하면 된다.

### 1.2 패키지 구조 변경 (0.2.2)

`entrypoints/`, `transport/` 디렉토리가 삭제되고 모든 타입이 `sdk.d.ts`로 통합.

```typescript
// BEFORE (0.1.x) — 내부적으로 이런 구조
// sdk.d.ts → export * from './entrypoints/agentSdkTypes.d.ts'

// AFTER (0.2.2+) — 모든 타입이 단일 파일에
// sdk.d.ts (1,586 lines)

// 사용자 코드 영향: 없음 (메인 패키지에서 import하면 동일하게 동작)
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';  // ✅ 동일
```

### 1.3 SDK 버전 범위 업데이트

```jsonc
// package.json
{
  "dependencies": {
    // BEFORE
    "@anthropic-ai/claude-agent-sdk": "^0.1.0",
    // AFTER
    "@anthropic-ai/claude-agent-sdk": "^0.2.55"
  }
}
```

---

## Phase 2: 코드 레벨 마이그레이션

### 2.1 타입 안전성 강화 — `any` → 정식 타입

현재 `claude-handler.ts`에서 `options: any`를 사용 중. 0.2.x에서는 정식 타입을 쓸 수 있다.

```typescript
// ===== BEFORE (현재 코드 — claude-handler.ts:253) =====
const options: any = {
  outputFormat: 'stream-json',
  settingSources: [],
  plugins: [],
  systemPrompt: dispatchPrompt,
  tools: [],
  maxTurns: 1,
};

// ===== AFTER (0.2.55 타입 활용) =====
import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';

const options: Options = {
  outputFormat: 'stream-json',
  settingSources: [],
  plugins: [],
  systemPrompt: dispatchPrompt,
  tools: [],
  maxTurns: 1,
};
```

### 2.2 시스템 초기화 메시지 타입 정리

현재 `(message as any).subtype` 캐스팅을 사용 중.

```typescript
// ===== BEFORE (현재 코드 — claude-handler.ts:293) =====
if (message.type === 'system' && (message as any).subtype === 'init') {
  logger.info(`✅ DISPATCH: SDK initialized`, {
    model: (message as any).model,
    sessionId: (message as any).session_id,
  });
}

// ===== AFTER (SDKMessage union 타입으로 narrowing) =====
if (message.type === 'system' && message.subtype === 'init') {
  // TypeScript가 SDKSystemInitMessage로 자동 추론
  logger.info(`✅ DISPATCH: SDK initialized`, {
    model: message.model,
    sessionId: message.session_id,
  });
}
```

### 2.3 Result 메시지의 `stop_reason` 활용

0.2.34부터 result 메시지에 `stop_reason` 필드 추가.

```typescript
// ===== BEFORE =====
if (message.type === 'result') {
  logger.info(`🏁 Query completed`, { totalMessages: messageCount });
}

// ===== AFTER =====
if (message.type === 'result') {
  logger.info(`🏁 Query completed`, {
    totalMessages: messageCount,
    stopReason: message.stop_reason,  // 'end_turn' | 'max_tokens' | 'stop_sequence' | null
  });

  // stop_reason으로 비정상 종료 감지
  if (message.stop_reason === 'max_tokens') {
    logger.warn('응답이 최대 토큰 한도에 의해 잘림');
  }
}
```

---

## Phase 3: 신규 기능 적용 가이드

### 3.1 Adaptive Thinking (0.2.38+) ⭐

Opus 4.6+에서 모델이 task 복잡도에 따라 자동으로 사고 깊이를 조절한다.

```typescript
// ===== 옵션 1: Adaptive (권장 — Opus 4.6+) =====
const options: Options = {
  thinking: { type: 'adaptive' },
  // model이 자동으로 사고 깊이 결정
};

// ===== 옵션 2: 고정 버짓 =====
const options: Options = {
  thinking: { type: 'enabled', budgetTokens: 16000 },
};

// ===== 옵션 3: 비활성화 (간단한 dispatch에 적합) =====
const options: Options = {
  thinking: { type: 'disabled' },
};

// ===== DEPRECATED (이전 방식) =====
// options.maxThinkingTokens = 16000;  // ❌ deprecated
```

**soma-work 적용 예시:**

```typescript
// dispatch one-shot: thinking 불필요 → disabled
const dispatchOptions: Options = {
  outputFormat: 'stream-json',
  settingSources: [],
  plugins: [],
  systemPrompt: dispatchPrompt,
  tools: [],
  maxTurns: 1,
  thinking: { type: 'disabled' },  // 분류에는 사고 불필요
};

// 일반 대화: adaptive 사용
const streamOptions: Options = {
  outputFormat: 'stream-json',
  settingSources: ['project'],
  plugins: [{ type: 'local', path: LOCAL_PLUGINS_DIR }],
  thinking: { type: 'adaptive' },  // 모델이 판단
};
```

### 3.2 Effort 레벨 (0.2.38+) ⭐

응답 품질-속도 트레이드오프를 제어한다.

```typescript
// effort 레벨: 'low' | 'medium' | 'high' | 'max'
const options: Options = {
  effort: 'high',  // 깊은 분석 필요할 때
};

// dispatch에는 low effort로 빠르게
const dispatchOptions: Options = {
  effort: 'low',
  maxTurns: 1,
};
```

**모델별 effort 지원 확인 (0.2.48+):**

```typescript
const initResult = await currentQuery.initializationResult();
for (const model of initResult.models) {
  console.log(`${model.name}: effort=${model.supportsEffort}, levels=${model.supportedEffortLevels}`);
  // claude-sonnet-4-6: effort=true, levels=['low','medium','high','max']
  // claude-haiku-4-5: effort=true, levels=['low','medium','high']
}
```

### 3.3 Query.close() — 강제 종료 (0.2.15+)

세션 종료 명령어(`/soma close`)에서 활용 가능.

```typescript
// 현재는 AbortController로만 중단 가능
// 0.2.15+에서는 Query 객체의 close()로 깔끔하게 종료

// query() 리턴이 AsyncIterable이라 직접 close()를 호출하려면
// Query 객체에 대한 참조가 필요함.
// SDK 소스를 확인해야 하지만, 일반적으로:
// const q = query({ prompt, options });
// q.close();  // 모든 리소스 정리
```

### 3.4 Task 관리 — 서브에이전트 추적 (0.2.10~0.2.55) ⭐

서브에이전트(Task 도구)의 라이프사이클을 스트림으로 추적할 수 있다.

```typescript
// 새로운 메시지 타입들:
// 1. SDKTaskStartedMessage (0.2.45)
// 2. SDKTaskProgressMessage (0.2.55)
// 3. SDKTaskNotificationMessage (0.2.10) — 완료/실패/중단

for await (const message of query({ prompt, options })) {
  if (message.type === 'system') {
    switch (message.subtype) {
      case 'task_started':
        // 서브에이전트 시작됨
        console.log(`🚀 Task started: ${message.task_id} — ${message.description}`);
        console.log(`   Type: ${message.task_type}`);
        break;

      case 'task_progress':
        // 서브에이전트 진행 중 (0.2.55)
        console.log(`⏳ Task ${message.task_id}: ${message.description}`);
        console.log(`   Tokens: ${message.usage.total_tokens}, Tools: ${message.usage.tool_uses}`);
        console.log(`   Last tool: ${message.last_tool_name}`);
        break;

      case 'task_notification':
        // 서브에이전트 완료/실패/중단
        console.log(`${message.status === 'completed' ? '✅' : '❌'} Task ${message.task_id}: ${message.status}`);
        console.log(`   Summary: ${message.summary}`);
        if (message.usage) {
          console.log(`   Total: ${message.usage.total_tokens} tokens, ${message.usage.duration_ms}ms`);
        }
        break;
    }
  }
}
```

**soma-work 적용**: `stream-processor.ts`에서 task 이벤트를 Slack 메시지로 렌더링.

```typescript
// stream-processor.ts의 process() 루프에 추가
case 'task_started':
  if (this.callbacks.onSystemEvent) {
    await this.callbacks.onSystemEvent({
      type: 'task_started',
      taskId: message.task_id,
      description: message.description,
    }, context);
  }
  break;

case 'task_notification':
  if (this.callbacks.onSystemEvent) {
    await this.callbacks.onSystemEvent({
      type: 'task_completed',
      taskId: message.task_id,
      status: message.status,
      summary: message.summary,
      usage: message.usage,
    }, context);
  }
  break;
```

### 3.5 Query.stopTask() — 서브에이전트 중단 (0.2.41+)

```typescript
// 특정 task만 선택적으로 중단
await currentQuery.stopTask('task-uuid-here');

// soma-work에서 활용: /soma close 시 활성 task도 정리
// 현재는 AbortController.abort()로 전체 중단하지만,
// stopTask()로 개별 task를 먼저 정리할 수 있음
```

### 3.6 MCP 서버 런타임 제어 (0.2.25+) ⭐

쿼리 실행 중에 MCP 서버를 재연결하거나 토글할 수 있다.

```typescript
// MCP 서버 재연결 (연결 끊김 시)
await currentQuery.reconnectMcpServer('my-server');

// MCP 서버 비활성화/활성화
await currentQuery.toggleMcpServer('expensive-server', false);  // 비활성화
await currentQuery.toggleMcpServer('expensive-server', true);   // 재활성화
```

**향상된 MCP 서버 상태 (0.2.25+):**

```typescript
const statuses = await currentQuery.mcpServerStatus();
for (const server of statuses) {
  console.log(`${server.name}: ${server.status}`);
  // status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled'
  console.log(`  Scope: ${server.scope}`);  // 'project' | 'user' | 'local' | 'claudeai' | 'managed'
  console.log(`  Tools: ${server.tools?.length}`);

  // Tool annotations (0.2.30+)
  for (const tool of server.tools ?? []) {
    console.log(`    ${tool.name}: readOnly=${tool.annotations?.readOnly}, destructive=${tool.annotations?.destructive}`);
  }
}
```

### 3.7 Session 목록 조회 (0.2.55+)

```typescript
import { listSessions } from '@anthropic-ai/claude-agent-sdk';

// 특정 프로젝트의 세션 목록
const sessions = await listSessions({
  dir: '/path/to/project',
  limit: 20,
});

for (const session of sessions) {
  console.log(`${session.sessionId}: ${session.summary}`);
  console.log(`  Modified: ${new Date(session.lastModified).toISOString()}`);
  console.log(`  Branch: ${session.gitBranch}`);
  console.log(`  Title: ${session.customTitle}`);
  console.log(`  First prompt: ${session.firstPrompt}`);
}

// soma-work 적용: /soma sessions 명령어에서 SDK 세션 메타데이터 활용
```

### 3.8 initializationResult() — 초기화 정보 (0.2.30+)

세션 초기화 후 사용 가능한 명령어, 모델, 계정 정보를 조회한다.

```typescript
const initResult = await currentQuery.initializationResult();

// 사용 가능한 모델 목록
for (const model of initResult.models) {
  console.log(`${model.name}: thinking=${model.supportsAdaptiveThinking}, effort=${model.supportsEffort}`);
}

// 계정 정보
console.log(`Account: ${initResult.account.name}`);

// 사용 가능한 출력 스타일
console.log(`Output styles: ${initResult.available_output_styles.join(', ')}`);
```

### 3.9 Debug 모드 (0.2.30+)

SDK 내부 로깅을 활성화하여 문제 진단에 활용.

```typescript
// 콘솔 디버그 로그
const options: Options = {
  debug: true,
};

// 파일로 디버그 로그 저장 (debug: true 자동 활성화)
const options: Options = {
  debugFile: '/tmp/claude-sdk-debug.log',
};

// soma-work 적용: DEBUG 환경변수와 연동
if (process.env.DEBUG === 'true') {
  options.debug = true;
  options.debugFile = '/tmp/soma-sdk-debug.log';
}
```

### 3.10 Custom Session ID (0.2.34+)

세션 ID를 직접 지정하여 외부 시스템과 연동.

```typescript
// BEFORE: SDK가 자동 생성
// options.resume = existingSessionId;

// AFTER: 새 세션 생성 시 ID를 직접 지정 가능
const options: Options = {
  sessionId: `soma-${channelId}-${threadTs}`,  // 예측 가능한 세션 ID
};

// soma-work 적용: Slack thread ID 기반 세션 ID 생성
// → 재시작 후에도 세션 자동 복원 가능
```

### 3.11 Tool Annotations (0.2.30+)

커스텀 MCP 도구에 메타데이터를 부착하여 모델의 판단을 돕는다.

```typescript
import { tool } from '@anthropic-ai/claude-agent-sdk';

// tool() 함수의 5번째 파라미터로 annotations 전달
const myTool = tool(
  'deploy_to_production',           // name
  'Deploy the app to production',   // description
  inputSchema,                       // zod schema
  async (input) => { /* ... */ },   // handler
  {
    annotations: {
      destructive: true,    // 되돌릴 수 없는 작업
      readOnly: false,
      openWorld: true,      // 외부 시스템에 영향
    }
  }
);
```

### 3.12 Prompt Suggestions (0.2.48+)

각 턴 후 다음 프롬프트 제안을 받을 수 있다.

```typescript
const options: Options = {
  promptSuggestions: true,
};

for await (const message of query({ prompt, options })) {
  if (message.type === 'prompt_suggestion') {
    // SDKPromptSuggestionMessage
    console.log(`💡 Suggested next prompt: ${message.suggestion}`);
  }
}
```

### 3.13 Client App 식별 (0.2.39+)

User-Agent 헤더에 앱 이름을 포함시켜 API 사용량 추적.

```typescript
const options: Options = {
  env: {
    CLAUDE_AGENT_SDK_CLIENT_APP: 'soma-work/1.0.0',
  },
};
```

---

## Phase 4: 새로운 SDKMessage 타입 전체 목록

0.1.75 이후 추가된 메시지 타입들. `stream-processor.ts`에서 핸들링을 고려해야 한다.

| 버전 | `type` | `subtype` | 설명 | 중요도 |
|---|---|---|---|---|
| 0.2.10 | `system` | `task_notification` | Task 완료/실패/중단 | ⭐ 높음 |
| 0.2.15 | `system` | `hook_started` | 훅 실행 시작 | 낮음 |
| 0.2.20 | `system` | `hook_progress` | 훅 실행 진행 (stdout/stderr) | 낮음 |
| 0.2.20 | `tool_use_summary` | — | 도구 사용 요약 (앞선 tool_use들 축약) | ⭐ 높음 |
| 0.2.25 | `system` | `files_persisted` | 파일 영속화 이벤트 | 낮음 |
| 0.2.45 | `system` | `task_started` | Task 시작 | ⭐ 높음 |
| 0.2.45 | `system` | `rate_limit` | Rate limit 상태 | 중간 |
| 0.2.48 | — | — | `SDKPromptSuggestionMessage` | 낮음 |
| 0.2.55 | `system` | `task_progress` | Task 진행 상태 | ⭐ 높음 |

### stream-processor.ts 핸들링 추가 예시

```typescript
// process() 메서드의 for-await 루프 내부
for await (const message of stream) {
  if (abortSignal.aborted) break;

  switch (message.type) {
    case 'assistant':
      await this.handleAssistantMessage(message, context, currentMessages);
      break;

    case 'user':
      await this.handleUserMessage(message, context);
      break;

    case 'result':
      lastUsage = await this.handleResultMessage(message, context, currentMessages);
      break;

    // ===== NEW: 0.2.x 메시지 타입들 =====

    case 'tool_use_summary':
      // 여러 tool_use를 하나의 요약으로 축약
      this.logger.debug('Tool use summary', {
        summary: message.summary,
        precedingToolUseIds: message.preceding_tool_use_ids,
      });
      break;

    case 'system':
      await this.handleSystemMessage(message, context);
      break;

    default:
      this.logger.debug('Unknown message type', { type: message.type });
  }
}

// handleSystemMessage 메서드
private async handleSystemMessage(message: SDKMessage, context: StreamContext): Promise<void> {
  if (message.type !== 'system') return;

  switch (message.subtype) {
    case 'init':
      // 기존 처리 유지
      break;

    case 'task_started':
      this.logger.info(`🚀 Subagent started: ${message.description}`, {
        taskId: message.task_id,
        taskType: message.task_type,
      });
      break;

    case 'task_progress':
      this.logger.debug(`⏳ Subagent progress`, {
        taskId: message.task_id,
        tokens: message.usage?.total_tokens,
        lastTool: message.last_tool_name,
      });
      break;

    case 'task_notification':
      const icon = message.status === 'completed' ? '✅' : '❌';
      this.logger.info(`${icon} Subagent ${message.status}: ${message.summary}`, {
        taskId: message.task_id,
      });
      break;

    case 'rate_limit':
      this.logger.warn('⚠️ Rate limit event', message);
      break;

    case 'hook_started':
    case 'hook_progress':
      // 필요 시 로깅
      break;
  }
}
```

---

## Phase 5: 새로운 Hook Events

### 기존 (0.1.75)

```
PreToolUse, PostToolUse, PostToolUseFailure, Notification,
UserPromptSubmit, SessionStart, SessionEnd, Stop, SubagentStart,
SubagentStop, PreCompact, PermissionRequest
```

### 추가 (0.2.x)

| 버전 | Hook Event | 용도 |
|---|---|---|
| 0.2.10 | `Setup` | 초기화/유지보수 시 실행 (`trigger: 'init' \| 'maintenance'`) |
| 0.2.34 | `TeammateIdle` | 팀메이트 에이전트가 유휴 상태 |
| 0.2.34 | `TaskCompleted` | Task 완료 시 |
| 0.2.48 | `ConfigChange` | 설정 파일 변경 감지 (`source: 'user_settings' \| 'project_settings' \| ...`) |
| 0.2.50 | `WorktreeCreate` | Git worktree 생성 |
| 0.2.50 | `WorktreeRemove` | Git worktree 삭제 |

### Hook Output 개선

```typescript
// PreToolUse에 additionalContext 추가 (0.2.10+)
// 훅에서 반환한 텍스트가 모델에 추가 컨텍스트로 주입됨
{
  hookEventName: 'PreToolUse',
  decision: 'approve',
  additionalContext: '이 파일은 프로덕션 설정이므로 주의해서 수정하세요.',
}

// Stop 훅에 last_assistant_message 추가 (0.2.47+)
// 세션 종료 시 마지막 응답을 훅에서 참조 가능
{
  hook_event_name: 'Stop',
  last_assistant_message: '작업이 완료되었습니다. 테스트를 실행해주세요.',
}
```

---

## Phase 6: Query 메서드 타임라인

| 버전 | 메서드 | 시그니처 | 용도 |
|---|---|---|---|
| 0.1.75 | `interrupt()` | `() → void` | 현재 생성 중단 |
| 0.1.75 | `setPermissionMode()` | `(mode) → void` | 권한 모드 변경 |
| 0.1.75 | `setModel()` | `(model) → void` | 모델 변경 |
| 0.1.75 | `setMaxThinkingTokens()` | `(tokens) → void` | ~~사고 토큰 설정~~ **deprecated** |
| 0.1.75 | `supportedCommands()` | `() → Promise<Command[]>` | 사용 가능한 명령어 |
| 0.1.75 | `supportedModels()` | `() → Promise<Model[]>` | 사용 가능한 모델 |
| 0.1.75 | `mcpServerStatus()` | `() → Promise<Status[]>` | MCP 서버 상태 |
| 0.1.75 | `accountInfo()` | `() → Promise<Account>` | 계정 정보 |
| 0.1.75 | `rewindFiles()` | `(files) → Promise<void>` | 파일 변경 되돌리기 |
| 0.1.75 | `setMcpServers()` | `(servers) → Promise<void>` | MCP 서버 설정 |
| 0.1.75 | `streamInput()` | `(input) → void` | 추가 입력 스트리밍 |
| **0.2.15** | **`close()`** | `() → void` | **쿼리 강제 종료** |
| **0.2.25** | **`reconnectMcpServer()`** | `(name) → Promise<void>` | **MCP 서버 재연결** |
| **0.2.25** | **`toggleMcpServer()`** | `(name, enabled) → Promise<void>` | **MCP 서버 토글** |
| **0.2.30** | **`initializationResult()`** | `() → Promise<InitResult>` | **초기화 정보 조회** |
| **0.2.41** | **`stopTask()`** | `(taskId) → Promise<void>` | **서브에이전트 중단** |

---

## Phase 7: Permission Mode 변경 이력

```
0.1.75:  'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'delegate'
0.2.20:  'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'           ← delegate 제거
0.2.34:  'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'delegate'  ← 복원
0.2.47:  'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'           ← 다시 제거
```

**결론**: `delegate` 모드는 불안정. soma-work에서는 사용하지 않으므로 영향 없음.

---

## Phase 8: 마이그레이션 체크리스트

```
[ ] 1. package.json — SDK 버전을 ^0.2.55로 변경
[ ] 2. zod — v4 설치 및 MCP SDK 호환성 확인
[ ] 3. npm install & npm run build — 빌드 성공 확인
[ ] 4. claude-handler.ts — `any` 타입을 `Options`/`SDKMessage`로 교체
[ ] 5. claude-handler.ts — thinking/effort 옵션 추가 (dispatch: disabled, stream: adaptive)
[ ] 6. claude-handler.ts — debug 옵션 환경변수 연동
[ ] 7. stream-processor.ts — 새 메시지 타입 핸들링 (task_started, task_progress, task_notification)
[ ] 8. stream-processor.ts — tool_use_summary 메시지 핸들링
[ ] 9. stream-processor.ts — rate_limit 이벤트 핸들링
[ ] 10. mcp-config-builder.ts — McpConfig 타입 업데이트 (McpServerStatus 확장)
[ ] 11. 테스트 — npx vitest run 통과 확인
[ ] 12. 타입 체크 — npx tsc --noEmit 통과 확인
[ ] 13. 통합 테스트 — Slack에서 실제 대화 테스트
```

---

## 버전별 상세 변경 요약

### 0.1.75 → 0.1.77 (사전 준비)
- Zod peer dep `^3.24.1 || ^4.0.0` → `^3.25.0 || ^4.0.0`
- `entrypoints/sdkControlTypes.d.ts` 제거 (내부 타입 이동)

### 0.2.0 (첫 번째 Breaking)
- **Zod 3 지원 중단** — peer dep `^4.0.0`
- `tool()`, `SdkMcpToolDefinition` 내부에서 `zod/v4` 사용

### 0.2.2 (구조 변경)
- `entrypoints/`, `transport/` 디렉토리 완전 제거
- 모든 타입 `sdk.d.ts`로 통합 (1,586줄)

### 0.2.3
- `ModelUsage.maxOutputTokens: number` 추가

### 0.2.10 (기능 확장 시작)
- `Options.agent?: string` — 메인 스레드 에이전트 지정
- `AgentDefinition.skills`, `AgentDefinition.maxTurns` 추가
- `SDKSessionOptions.model` 필드가 optional로 변경
- `SDKTaskNotificationMessage` 추가 (task 완료/실패/중단)
- `Setup` 훅 이벤트 추가
- `PreToolUseHookSpecificOutput.additionalContext` 추가

### 0.2.15
- **`Query.close()`** 메서드 추가
- `SDKHookStartedMessage` 추가
- `SDKHookResponseMessage`에 `hook_id`, `output`, `outcome` 필드 추가
- MCP reconnect/toggle 내부 요청 타입 추가

### 0.2.20
- `SDKHookProgressMessage` 추가 (훅 실행 stdout/stderr 스트리밍)
- `SDKToolUseSummaryMessage` 추가 (도구 사용 요약)
- `PermissionMode`에서 `'delegate'` 일시 제거

### 0.2.25 (MCP 확장)
- **`Query.reconnectMcpServer()`**, **`Query.toggleMcpServer()`** 추가
- `McpClaudeAIProxyServerConfig` 타입 추가
- `McpServerStatus`에 `config`, `scope`, `tools`, `disabled` 상태 추가
- `SDKFilesPersistedEvent` 추가

### 0.2.30 (디버그 & 도구 어노테이션)
- **`Options.debug`**, **`Options.debugFile`** 추가
- **`Query.initializationResult()`** 추가
- `tool()` 함수에 `annotations` 파라미터 추가 (`readOnly`, `destructive`, `openWorld`)
- `SDKSessionOptions.permissionMode` 추가
- `SubagentStopHookInput.agent_type` 추가

### 0.2.34 (에이전트 팀 & 세션 ID)
- **`Options.sessionId`** — 커스텀 세션 ID 지정
- `TeammateIdle`, `TaskCompleted` 훅 이벤트 추가
- `SDKResultMessage.stop_reason` 추가
- `PermissionMode`에 `'delegate'` 복원

### 0.2.38 (Thinking & Effort) ⭐
- **`Options.thinking`** — `{ type: 'adaptive' } | { type: 'enabled', budgetTokens } | { type: 'disabled' }`
- **`Options.effort`** — `'low' | 'medium' | 'high' | 'max'`
- `Options.maxThinkingTokens` **deprecated**
- `ThinkingConfig`, `ThinkingAdaptive`, `ThinkingEnabled`, `ThinkingDisabled` 타입 export

### 0.2.39
- `CLAUDE_AGENT_SDK_CLIENT_APP` 환경변수 — User-Agent 식별

### 0.2.41
- **`Query.stopTask(taskId)`** — 서브에이전트 중단

### 0.2.45 (Task & Sandbox)
- `SDKTaskStartedMessage` 추가
- `SDKRateLimitEvent` 추가
- `SandboxFilesystemConfig` (`allowWrite`, `denyWrite`, `denyRead`) 추가

### 0.2.47
- `ApiKeySource`에 `'oauth'` 추가
- `ThinkingEnabled.budgetTokens` optional로 변경
- `SDKTaskNotificationMessage`에 `tool_use_id`, `usage` 추가
- `StopHookInput.last_assistant_message` 추가
- `PermissionMode`에서 `'delegate'` 다시 제거

### 0.2.48 (설정 변경 감지 & 프롬프트 제안)
- `ConfigChange` 훅 이벤트 추가
- `ModelInfo.supportsEffort`, `supportedEffortLevels`, `supportsAdaptiveThinking` 추가
- **`Options.promptSuggestions`** 추가
- `SDKPromptSuggestionMessage` 추가

### 0.2.50 (Worktree & 설정 주입)
- `WorktreeCreate`, `WorktreeRemove` 훅 이벤트 추가
- `SDKControlApplyFlagSettingsRequest` 추가 (런타임 설정 병합)

### 0.2.55 (세션 목록 & Task 진행) ⭐
- **`listSessions()`** — 세션 목록 조회 (`SDKSessionInfo`)
- `SDKTaskProgressMessage` 추가 (Task 진행 상태 스트리밍)
- MCP 인증 관련 내부 요청 타입 추가

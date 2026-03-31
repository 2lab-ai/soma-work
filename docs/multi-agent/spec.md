# Multi-Agent Architecture — Spec

> STV Spec | Created: 2026-03-30 | Issue: [#25](https://github.com/2lab-ai/soma-work/issues/25)

## 1. Overview

soma-work 단일 프로세스 내에서 메인 봇(@제갈량) 외에 독립 Slack App으로 동작하는 서브 에이전트(@장비, @관우 등)를 추가할 수 있는 아키텍처를 구현한다.

각 서브 에이전트는 별도의 Slack Bot Token/App Token을 가지며 유저가 @멘션/DM으로 직접 대화할 수 있다. 메인 봇은 `agent_chat`/`agent_reply` MCP tool로 서브 에이전트에 작업을 위임할 수 있다.

## 2. User Stories

- **US1**: 유저는 @장비에 직접 멘션/DM으로 코드 리뷰를 요청할 수 있다.
- **US2**: 유저는 @제갈량에게 "장비에게 물어봐"라고 하면 메인 봇이 agent_chat으로 장비에게 위임 후 결과를 돌려받는다.
- **US3**: 관리자는 config.json에 에이전트를 추가/제거하여 서브 에이전트를 등록/해제할 수 있다.
- **US4**: 각 서브 에이전트는 고유 시스템 프롬프트와 페르소나를 가진다.

## 3. Acceptance Criteria

- [ ] config.json의 `agents` 섹션에 서브 에이전트 정의 가능
- [ ] 각 에이전트가 독립 Slack App 커넥션(Socket Mode)으로 시작
- [ ] 유저가 서브 에이전트에 직접 @멘션/DM 시 응답
- [ ] `agent_chat(agent_name, prompt)` → 서브 에이전트 Claude query 실행 → 결과 반환
- [ ] `agent_reply(sessionId, prompt)` → 기존 에이전트 세션 이어서 대화
- [ ] 에이전트별 시스템 프롬프트 (`src/prompt/{agent_name}/`) 로딩
- [ ] 에이전트 lifecycle: 시작 시 등록, 종료 시 정리
- [ ] 메인 봇 기존 기능에 regression 없음

## 4. Scope

### In-Scope
- config.json `agents` 섹션 파싱
- 멀티 Slack App 인스턴스 관리 (AgentManager)
- `agent_chat`/`agent_reply` MCP 서버 구현
- 에이전트별 프롬프트 디렉토리 구조
- 에이전트 간 세션 관리
- 에이전트 등록/해제 lifecycle

### Out-of-Scope
- 에이전트 간 직접 통신 (에이전트→에이전트)
- 에이전트 자동 스케일링
- 에이전트별 독립 MCP 서버 구성 (1차 구현에서 메인과 동일 MCP 공유)
- UI/대시보드에서의 에이전트 관리
- 기존 `src/prompt/` → `src/prompt/main/` 마이그레이션 (별도 이슈)

## 5. Architecture

### 5.1 Hybrid 통신 모델

두 가지 경로가 공존한다:

```
경로 1 (유저 직접 대화):
  유저 → @장비 (멘션/DM) → 장비 Slack App → SlackHandler(장비) → ClaudeHandler(장비) → 응답

경로 2 (메인 봇 위임):
  유저 → @제갈량 → "장비에게 물어봐"
    → agent_chat("jangbi", prompt)
    → AgentManager.query("jangbi", prompt)
    → ClaudeHandler(장비).streamQuery(prompt)
    → 결과 반환 → 제갈량 → 유저
```

### 5.2 핵심 컴포넌트

```
┌─────────────────────────────────────────────────┐
│                   index.ts                       │
│  ┌──────────────────┐  ┌──────────────────────┐ │
│  │  Main Bot         │  │  AgentManager        │ │
│  │  (App instance)   │  │  ┌───────────────┐  │ │
│  │  SlackHandler     │  │  │ Agent: jangbi  │  │ │
│  │  ClaudeHandler    │  │  │  App instance  │  │ │
│  │  McpConfigBuilder │  │  │  SlackHandler  │  │ │
│  └──────────────────┘  │  │  ClaudeHandler │  │ │
│                         │  └───────────────┘  │ │
│                         │  ┌───────────────┐  │ │
│                         │  │ Agent: gwanu   │  │ │
│                         │  │  App instance  │  │ │
│                         │  │  SlackHandler  │  │ │
│                         │  │  ClaudeHandler │  │ │
│                         │  └───────────────┘  │ │
│                         └──────────────────────┘ │
│  ┌──────────────────────────────────────────┐   │
│  │  MCP Servers (shared)                     │   │
│  │  llm | model-command | agent (NEW)        │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

### 5.3 새로운/수정 파일

| 파일 | 변경 | 설명 |
|------|------|------|
| `src/agent-manager.ts` | **NEW** | 서브 에이전트 lifecycle 관리 |
| `src/agent-instance.ts` | **NEW** | 개별 에이전트 인스턴스 (App + Handler) |
| `mcp-servers/agent/agent-mcp-server.ts` | **NEW** | `agent_chat`/`agent_reply` MCP tool |
| `src/unified-config-loader.ts` | MODIFY | `agents` 섹션 파싱 추가 |
| `src/mcp-config-builder.ts` | MODIFY | agent MCP 서버 등록 |
| `src/prompt-builder.ts` | MODIFY | 에이전트별 프롬프트 디렉토리 지원 |
| `src/index.ts` | MODIFY | AgentManager 초기화/시작/종료 |
| `src/types.ts` | MODIFY | AgentConfig 타입 추가 |

### 5.4 Config 확장

```json
{
  "agents": {
    "jangbi": {
      "slackBotToken": "xoxb-...",
      "slackAppToken": "xapp-...",
      "signingSecret": "...",
      "promptDir": "src/prompt/jangbi",
      "persona": "default",
      "description": "코드 리뷰 전문 에이전트",
      "model": "claude-sonnet-4-20250514"
    },
    "gwanu": {
      "slackBotToken": "xoxb-...",
      "slackAppToken": "xapp-...",
      "signingSecret": "...",
      "promptDir": "src/prompt/gwanu",
      "persona": "default",
      "description": "배포 및 인프라 전문 에이전트"
    }
  }
}
```

### 5.5 AgentManager 인터페이스

```typescript
export interface AgentConfig {
  slackBotToken: string;
  slackAppToken: string;
  signingSecret: string;
  promptDir?: string;      // default: src/prompt/{agentName}
  persona?: string;        // default: 'default'
  description?: string;
  model?: string;          // default: inherit from main
}

export class AgentManager {
  // Lifecycle
  async startAll(): Promise<void>;
  async stopAll(): Promise<void>;

  // Query (for agent_chat/agent_reply)
  async query(agentName: string, prompt: string, sessionId?: string): Promise<AgentQueryResult>;

  // Registry
  getAgent(name: string): AgentInstance | undefined;
  listAgents(): AgentInfo[];
}

export interface AgentQueryResult {
  sessionId: string;
  content: string;
  agentName: string;
  model: string;
}
```

### 5.6 Agent MCP Server

`llm-mcp-server.ts` 패턴을 미러링:

```typescript
// Tools:
//   agent_chat(agent_name, prompt, config?) → { sessionId, content, agentName }
//   agent_reply(sessionId, prompt) → { sessionId, content, agentName }

class AgentMCPServer extends BaseMcpServer {
  defineTools(): ToolDefinition[] {
    return [
      { name: 'chat', description: 'Start a new agent chat session', inputSchema: {
        properties: {
          agent: { type: 'string', description: 'Agent name (e.g., "jangbi")' },
          prompt: { type: 'string', description: 'The prompt' },
        },
        required: ['agent', 'prompt'],
      }},
      { name: 'chat-reply', description: 'Continue an agent chat session', inputSchema: {
        properties: {
          sessionId: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['sessionId', 'prompt'],
      }},
    ];
  }
}
```

### 5.7 프롬프트 구조

```
src/prompt/
├── default.prompt          ← 메인 봇 (기존 유지)
├── common.prompt           ← 공유 (기존 유지)
├── dispatch.prompt         ← 기존 유지
├── workflows/              ← 기존 유지
├── jangbi/                 ← NEW: 서브 에이전트
│   ├── default.prompt
│   └── common.prompt       (optional, fallback to parent)
└── gwanu/                  ← NEW: 서브 에이전트
    └── default.prompt
```

**결정**: 기존 `src/prompt/` 구조를 변경하지 않는다. 메인 봇은 현재 그대로 사용하고, 서브 에이전트만 하위 디렉토리에 추가한다. `src/prompt/main/`으로의 마이그레이션은 별도 이슈로 분리.

### 5.8 Integration Points

| 기존 컴포넌트 | 연결 방식 |
|---|---|
| `ClaudeHandler` | 에이전트별 인스턴스 생성 (동일 클래스 재사용) |
| `SlackHandler` | 에이전트별 인스턴스 생성 (동일 클래스 재사용) |
| `McpConfigBuilder` | agent MCP 서버 등록 추가 |
| `SessionRegistry` | 에이전트별 독립 인스턴스 (세션 격리) |
| `PromptBuilder` | agentName 파라미터로 프롬프트 디렉토리 분기 |
| `McpManager` | 공유 (모든 에이전트가 동일 외부 MCP 사용) |

## 6. Non-Functional Requirements

- **성능**: 에이전트 추가 시 메인 봇 응답 속도에 영향 없음. 각 에이전트는 독립 Socket Mode 커넥션.
- **안정성**: 서브 에이전트 장애가 메인 봇에 전파되지 않음. 에이전트별 에러 격리.
- **확장성**: config.json에 에이전트 추가만으로 확장. 코드 변경 불필요.
- **보안**: 각 에이전트는 자체 Bot Token 사용. 에이전트 간 세션 격리.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| MCP 서버 패턴은 llm 미러링 | tiny | 기존 패턴 그대로 따름 |
| agent_chat 내부는 Hybrid (C) | xlarge | 유저 확인 완료 |
| 기존 prompt 디렉토리 유지 | small | 마이그레이션 리스크 회피, 별도 이슈로 분리 |
| ClaudeHandler 재사용 | small | 새 클래스 불필요, 동일 인터페이스 |
| AgentManager가 singleton | tiny | index.ts에서 1회 생성 |
| config.json의 agents 섹션 | small | 기존 config 패턴 따름 |
| MCP 서버 공유 (에이전트 간) | small | 1차 구현 단순화, 추후 분리 가능 |
| SessionRegistry 에이전트별 독립 | small | 세션 충돌 방지 |

## 8. Open Questions

None — 모든 아키텍처 결정 완료.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace`

# SRP Refactoring Plan

> "Bad programmers worry about the code. Good programmers worry about data structures and their relationships." - Linus Torvalds

## 현재 상태 (2024년 12월 기준)

Phase 1-5 리팩토링이 완료됨. `SessionRegistry`, `PromptBuilder`, `CommandRouter`, `StreamProcessor` 등 좋은 추출 사례가 있다.

**하지만 아직 핵심 오케스트레이터들이 너무 많은 일을 한다.**

---

## 남은 SRP 위반 현황

| 파일 | 라인 | 책임 수 | 심각도 |
|------|------|---------|--------|
| `slack-handler.ts` | 650 | 7개 | **치명적** |
| `action-handlers.ts` | 674 | 5개 | 높음 |
| `github-auth.ts` | 415 | 4개 | 높음 |
| `permission-mcp-server.ts` | 294 | 3개 | 중간 |
| `working-directory-manager.ts` | 304 | 3개 | 중간 |

---

## Phase 6: SlackHandler 최종 분해

**문제**: SlackHandler가 여전히 7가지 일을 한다:
1. 메시지 라우팅/검증
2. 작업 디렉토리 관리
3. 파일 처리
4. 세션 관리
5. 권한 처리
6. 상태/리액션 관리
7. Todo 추적 및 표시

한 클래스가 이 모든 걸 알 필요가 없다.

### 6.1 MessageValidator 추출

```typescript
// src/slack/message-validator.ts
export class MessageValidator {
  constructor(
    private workingDirManager: WorkingDirectoryManager,
    private sessionRegistry: SessionRegistry
  ) {}

  validateWorkingDirectory(userId: string, channelId: string, threadTs?: string): ValidationResult
  canInterruptSession(userId: string, session: Session): boolean
  validateMessage(event: SlackMessageEvent): MessageValidation
}
```

**옮길 코드**:
- `slack-handler.ts:220-260` (CWD 검증 로직)
- `slack-handler.ts:299-312` (세션 중단 검증)

### 6.2 StatusReporter 추출

```typescript
// src/slack/status-reporter.ts
export class StatusReporter {
  constructor(private slack: WebClient) {}

  addReaction(channel: string, ts: string, emoji: string): Promise<void>
  removeReaction(channel: string, ts: string, emoji: string): Promise<void>
  sendStatus(channel: string, threadTs: string, status: string): Promise<void>
  updateProgress(channel: string, ts: string, progress: Progress): Promise<void>
}
```

**옮길 코드**:
- `slack-handler.ts:346-354` (리액션 관리)

### 6.3 TodoDisplayManager 추출

```typescript
// src/slack/todo-display-manager.ts
export class TodoDisplayManager {
  constructor(private slack: WebClient, private todoManager: TodoManager) {}

  createTodoMessage(channel: string, threadTs: string): Promise<string>
  updateTodoMessage(channel: string, messageTs: string, todos: TodoItem[]): Promise<void>
  finalizeTodos(channel: string, messageTs: string): Promise<void>
}
```

**옮길 코드**:
- `slack-handler.ts:518-593` (Todo 관련 메서드 2개, 75줄)

### 6.4 리팩토링 후 SlackHandler (~200줄)

```typescript
export class SlackHandler {
  constructor(
    private validator: MessageValidator,
    private statusReporter: StatusReporter,
    private todoDisplay: TodoDisplayManager,
    private fileHandler: FileHandler,
    private claudeHandler: ClaudeHandler,
    private commandRouter: CommandRouter
  ) {}

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const validation = await this.validator.validateMessage(event);
    if (!validation.valid) return this.statusReporter.sendError(validation.error);

    if (this.commandRouter.isCommand(event.text)) {
      return this.commandRouter.route(event);
    }

    const files = await this.fileHandler.processAttachments(event.files);
    await this.statusReporter.addReaction('thinking');
    await this.claudeHandler.query(event, files);
    await this.statusReporter.removeReaction('thinking');
  }
}
```

---

## Phase 7: GitHubAuth 분리

**문제**: GitHub API 인증과 로컬 Git 설정이 하나의 클래스에 있다. 전혀 관계없는 두 가지 일이다.

### 7.1 GitHubApiClient

```typescript
// src/github/api-client.ts
export class GitHubApiClient {
  getAppJWT(): string
  async getInstallationToken(): Promise<TokenInfo>
  async listInstallations(): Promise<Installation[]>
}
```

### 7.2 TokenRefreshScheduler

```typescript
// src/github/token-refresh-scheduler.ts
export class TokenRefreshScheduler {
  constructor(private apiClient: GitHubApiClient, private onTokenRefreshed: (token: string) => void) {}

  scheduleRefresh(expiresAt: Date): void
  cancelRefresh(): void
  refreshNow(): Promise<void>
}
```

### 7.3 GitCredentialsManager

```typescript
// src/github/git-credentials-manager.ts
export class GitCredentialsManager {
  async updateCredentials(token: string): Promise<void>
  async removeGitHubUrlRewrites(): Promise<void>
  async configureGitAuth(token: string): Promise<void>
}
```

---

## Phase 8: PermissionMCPServer 정리

**문제**: MCP 서버가 Slack API를 직접 호출한다. MCP 서버는 capability 정의만 해야 한다.

### 8.1 PermissionRequestHandler

```typescript
// src/permission/request-handler.ts
export class PermissionRequestHandler {
  constructor(private messenger: SlackPermissionMessenger, private store: SharedStore) {}

  async requestPermission(request: PermissionRequest): Promise<PermissionResult>
  async waitForResponse(requestId: string, timeout: number): Promise<boolean>
}
```

### 8.2 SlackPermissionMessenger

```typescript
// src/permission/slack-messenger.ts
export class SlackPermissionMessenger {
  constructor(private slack: WebClient) {}

  async sendPermissionRequest(channel: string, threadTs: string, blocks: Block[]): Promise<string>
  async updateWithResult(channel: string, messageTs: string, approved: boolean): Promise<void>
}
```

### 8.3 리팩토링 후 PermissionMCPServer (~80줄)

```typescript
export class PermissionMCPServer {
  constructor(private handler: PermissionRequestHandler) {}

  private setupHandlers(): void {
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const result = await this.handler.requestPermission(request.params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });
  }
}
```

---

## Phase 9: 메시지 포매터 통합

**문제**: 여러 Manager 클래스에 메시지 포맷팅 로직이 흩어져 있다.

### 추출 대상

| 원본 파일 | 추출할 메서드 | 새 파일 |
|-----------|---------------|---------|
| `working-directory-manager.ts` | `formatDirectoryMessage()`, `formatChannelSetupMessage()` | `directory-formatter.ts` |
| `file-handler.ts` | `formatFilePrompt()` | `file-prompt-formatter.ts` |
| `session-registry.ts` | 세션 상태 메시지 | `session-formatter.ts` |

### 구조

```
src/slack/formatters/
├── index.ts
├── directory-formatter.ts
├── file-prompt-formatter.ts
├── session-formatter.ts
└── permission-formatter.ts
```

---

## Phase 10: 권한 로직 중앙화

**문제**: 권한 검사가 여기저기 흩어져 있다:
- `McpConfigBuilder` - bypass 체크
- `SessionRegistry` - 중단 권한
- `SlackHandler` - CWD 필수 체크

### PermissionService

```typescript
// src/permission/service.ts
export class PermissionService {
  constructor(private userSettings: UserSettingsStore, private sessionRegistry: SessionRegistry) {}

  shouldBypassPermission(userId: string): boolean
  canInterruptSession(userId: string, session: Session): boolean
  requiresWorkingDirectory(userId: string): boolean
  checkPermissions(userId: string, action: Action): PermissionResult
}
```

---

## 실행 순서

### 즉시 (Phase 6)
1. MessageValidator 추출
2. StatusReporter 추출
3. TodoDisplayManager 추출

### 다음 (Phase 7-8)
4. GitHubAuth 3개로 분리
5. PermissionMCPServer 정리

### 이후 (Phase 9-10)
6. 포매터 통합
7. PermissionService 중앙화

---

## 목표 구조

```
src/
├── index.ts                     # 진입점 (< 50줄)
├── slack/
│   ├── handler.ts               # 얇은 오케스트레이터 (< 200줄)
│   ├── message-validator.ts
│   ├── status-reporter.ts
│   ├── todo-display-manager.ts
│   ├── action-handlers/         # 분리 예정
│   │   ├── permission-action-handler.ts
│   │   ├── session-action-handler.ts
│   │   └── form-action-handler.ts
│   └── formatters/
│       ├── directory-formatter.ts
│       ├── file-prompt-formatter.ts
│       └── session-formatter.ts
├── claude/
│   ├── handler.ts
│   ├── session-registry.ts
│   ├── prompt-builder.ts
│   └── stream-processor.ts
├── github/
│   ├── api-client.ts
│   ├── token-refresh-scheduler.ts
│   └── git-credentials-manager.ts
├── permission/
│   ├── service.ts
│   ├── mcp-server.ts
│   ├── request-handler.ts
│   └── slack-messenger.ts
├── mcp/
│   ├── manager.ts
│   ├── client.ts
│   └── call-tracker.ts
└── shared/
    ├── store.ts
    ├── user-settings-store.ts
    └── logger.ts
```

---

## 완료 기준

- [ ] 모든 클래스가 단일 책임
- [ ] 파일당 300줄 미만
- [ ] 클래스당 의존성 4개 이하
- [ ] 포맷팅 로직이 Manager에서 분리
- [ ] 권한 로직이 PermissionService로 통합

---

## 리팩토링 원칙

1. **한 번에 하나만**: 각 PR은 하나의 추출만 포함
2. **테스트 먼저**: 추출 전에 기존 동작 테스트 작성
3. **의존성 주입**: 하드코딩 대신 생성자 주입
4. **인터페이스 우선**: 구현체 교체 가능하게

---

## 완료된 Phase (참고용)

### Phase 1-5 완료 사항
- ✅ `SessionRegistry` 추출 - 세션 CRUD 단일 책임
- ✅ `PromptBuilder` 추출 - 시스템 프롬프트 구성
- ✅ `McpConfigBuilder` 추출 - MCP 설정 구성
- ✅ `CommandRouter` 추출 - 명령어 라우팅
- ✅ `StreamProcessor` 추출 - Claude SDK 스트림 처리
- ✅ `ToolEventProcessor` 추출 - 도구 이벤트 처리
- ✅ `McpManager` 분리 - ConfigLoader, ServerFactory, InfoFormatter

# Claude Code SDK Integration Specification

## Version
- Document Version: 1.0
- Source File: `src/claude-handler.ts`
- Last Updated: 2025-12-13

## 1. Overview

Claude Handler는 `@anthropic-ai/claude-code` SDK를 통해 Claude AI와의 모든 상호작용을 관리합니다. 스트리밍 응답, 세션 관리, MCP 서버 설정을 담당합니다.

## 2. SDK Integration

### 2.1 Import

```typescript
import { query, type SDKMessage } from '@anthropic-ai/claude-code';
```

### 2.2 Query Function

```typescript
async *streamQuery(
  prompt: string,
  session?: ConversationSession,
  abortController?: AbortController,
  workingDirectory?: string,
  slackContext?: { channel: string; threadTs?: string; user: string }
): AsyncGenerator<SDKMessage, void, unknown>
```

## 3. Query Options

### 3.1 Base Options

```typescript
const options: any = {
  outputFormat: 'stream-json',     // 스트리밍 JSON 출력
  permissionMode: 'default',       // 또는 'bypassPermissions'
};
```

### 3.2 Working Directory

```typescript
if (workingDirectory) {
  options.cwd = workingDirectory;  // Claude가 작업할 디렉토리
}
```

### 3.3 Session Resume

```typescript
if (session?.sessionId) {
  options.resume = session.sessionId;  // 기존 세션 이어서 진행
}
```

### 3.4 Custom System Prompt

```typescript
if (systemPrompt) {
  options.customSystemPrompt = systemPrompt;
}
```

### 3.5 MCP Servers

```typescript
options.mcpServers = {
  'server-name': {
    command: 'npx',
    args: ['-y', 'package-name'],
    env: { KEY: 'value' }
  }
};

options.allowedTools = ['mcp__server-name'];
```

### 3.6 Permission Prompt Tool

```typescript
options.permissionPromptToolName = 'mcp__permission-prompt__permission_prompt';
```

## 4. SDK Message Types

### 4.1 System Init Message

```typescript
{
  type: 'system',
  subtype: 'init',
  session_id: string,    // 세션 고유 ID
  model: string,         // 사용 모델명
  tools: Tool[],         // 사용 가능한 도구 목록
}
```

**처리**:
```typescript
if (message.type === 'system' && message.subtype === 'init') {
  session.sessionId = message.session_id;
}
```

### 4.2 Assistant Message

```typescript
{
  type: 'assistant',
  message: {
    content: Array<TextContent | ToolUseContent>
  }
}

// TextContent
{
  type: 'text',
  text: string
}

// ToolUseContent
{
  type: 'tool_use',
  id: string,           // Tool Use ID (응답 매칭용)
  name: string,         // 도구 이름
  input: any            // 도구 입력값
}
```

### 4.3 User Message (Synthetic)

도구 실행 결과를 담은 합성 사용자 메시지:

```typescript
{
  type: 'user',
  isSynthetic: boolean,
  message: {
    content: Array<ToolResultContent>
  }
}

// ToolResultContent
{
  type: 'tool_result',
  tool_use_id: string,
  content: any,
  is_error?: boolean
}
```

### 4.4 Result Message

```typescript
{
  type: 'result',
  subtype: 'success' | 'error',
  result?: string,           // 최종 결과 (success 시)
  total_cost_usd?: number,   // 총 비용
  duration_ms?: number       // 소요 시간
}
```

## 5. System Prompt

### 5.1 System Prompt Loading

```typescript
const SYSTEM_PROMPT_PATH = path.join(__dirname, 'prompt', 'system.prompt');

try {
  if (fs.existsSync(SYSTEM_PROMPT_PATH)) {
    DEFAULT_SYSTEM_PROMPT = fs.readFileSync(SYSTEM_PROMPT_PATH, 'utf-8');
  }
} catch (error) {
  console.error('Failed to load system prompt:', error);
}
```

### 5.2 System Prompt Location

파일 경로: `src/prompt/system.prompt`

### 5.3 System Prompt 구조

```xml
<system_prompt>
You are a 400-yr full stack software engineer...

# Facts
## Repository
- https://github.com/org/repo1 - description
...

# 주요 워크플로우
## 코드 리뷰
...

## 지라
...

</system_prompt>

<review_guideline>
...
</review_guideline>
```

## 6. Persona System

### 6.1 Persona Directory

```
src/persona/
├── default.md      # 기본 페르소나
├── chaechae.md     # 커스텀 페르소나
└── *.md            # 추가 페르소나들
```

### 6.2 Persona Loading

```typescript
function loadPersona(personaName: string): string | undefined {
  const personaPath = path.join(PERSONA_DIR, `${personaName}.md`);

  if (fs.existsSync(personaPath)) {
    return fs.readFileSync(personaPath, 'utf-8');
  }

  // Fallback to default
  if (personaName !== 'default') {
    const defaultPath = path.join(PERSONA_DIR, 'default.md');
    if (fs.existsSync(defaultPath)) {
      return fs.readFileSync(defaultPath, 'utf-8');
    }
  }

  return undefined;
}
```

### 6.3 Persona Application

```typescript
let systemPrompt = DEFAULT_SYSTEM_PROMPT || '';

const personaName = userSettingsStore.getUserPersona(slackContext.user);
const personaContent = loadPersona(personaName);

if (personaContent) {
  systemPrompt = systemPrompt
    ? `${systemPrompt}\n\n<persona>\n${personaContent}\n</persona>`
    : `<persona>\n${personaContent}\n</persona>`;
}
```

### 6.4 Available Personas

```typescript
export function getAvailablePersonas(): string[] {
  if (fs.existsSync(PERSONA_DIR)) {
    return fs.readdirSync(PERSONA_DIR)
      .filter(file => file.endsWith('.md'))
      .map(file => file.replace('.md', ''));
  }
  return ['default'];
}
```

## 7. Speaker Identification

### 7.1 Speaker Tag

Slack 메시지에 발화자 정보 추가:

```typescript
const userName = await this.getUserName(user);
let finalPrompt = `<speaker>${userName}</speaker>\n${rawPrompt}`;
```

### 7.2 User Context Injection

```typescript
const userInfo = this.getUserInfoContext(user);
if (userInfo) {
  finalPrompt = `${finalPrompt}\n\n${userInfo}`;
}
```

**User Context Format**:
```xml
<user-context>
  <slack-name>홍길동</slack-name>
  <jira-name>Hong Gildong</jira-name>
  <jira-account-id>5f4dcc3b5aa765d61d8327deb882cf99</jira-account-id>
</user-context>
```

## 8. Credential Validation

### 8.1 Pre-Query Validation

```typescript
const credentialResult = await ensureValidCredentials();

if (!credentialResult.valid) {
  await sendCredentialAlert(credentialResult.error);
  throw new Error(`Claude credentials missing: ${credentialResult.error}`);
}

if (credentialResult.restored) {
  this.logger.info('Credentials were restored from backup');
}
```

## 9. Permission Mode

### 9.1 Default Mode

사용자에게 권한 확인 요청:

```typescript
options.permissionMode = 'default';
options.permissionPromptToolName = 'mcp__permission-prompt__permission_prompt';
```

### 9.2 Bypass Mode

권한 확인 없이 자동 실행:

```typescript
const userBypass = userSettingsStore.getUserBypassPermission(slackContext.user);

if (userBypass) {
  options.permissionMode = 'bypassPermissions';
}
```

## 10. Abort Handling

### 10.1 AbortController Usage

```typescript
const abortController = new AbortController();
this.activeControllers.set(sessionKey, abortController);

if (abortController) {
  options.abortController = abortController;
}
```

### 10.2 Request Cancellation

```typescript
const existingController = this.activeControllers.get(sessionKey);
if (existingController && canInterrupt) {
  existingController.abort();  // 기존 요청 취소
}
```

## 11. Error Handling

### 11.1 Query Error

```typescript
try {
  for await (const message of query({ prompt, options })) {
    yield message;
  }
} catch (error) {
  this.logger.error('Error in Claude query', error);
  throw error;
}
```

### 11.2 AbortError

```typescript
if (error.name !== 'AbortError') {
  // 실제 오류 처리
} else {
  // 취소된 경우 무시
}
```

## 12. Response Processing

### 12.1 Stream Processing

```typescript
for await (const message of this.claudeHandler.streamQuery(...)) {
  if (abortController.signal.aborted) break;

  if (message.type === 'assistant') {
    const hasToolUse = message.message.content?.some(
      (part: any) => part.type === 'tool_use'
    );

    if (hasToolUse) {
      // Tool use 처리
    } else {
      // Text content 처리
    }
  } else if (message.type === 'user') {
    // Tool result 처리
  } else if (message.type === 'result') {
    // 최종 결과 처리
  }
}
```

## 13. API Providers

### 13.1 Provider Selection

환경변수로 API 제공자 선택:

| Provider | Environment Variable |
|----------|---------------------|
| Anthropic API | `ANTHROPIC_API_KEY` |
| AWS Bedrock | `CLAUDE_CODE_USE_BEDROCK=1` |
| Google Vertex | `CLAUDE_CODE_USE_VERTEX=1` |
| Claude Subscription | (기본값, API 키 없을 때) |

### 13.2 Logging

```typescript
logger.info('Configuration:', {
  usingBedrock: config.claude.useBedrock,
  usingVertex: config.claude.useVertex,
  usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
});
```

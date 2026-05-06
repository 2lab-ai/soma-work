# MCP Integration Specification

## Version
- Document Version: 1.0
- Source File: `src/mcp-manager.ts`, `src/mcp-call-tracker.ts`
- Last Updated: 2025-12-13

## 1. Overview

MCP (Model Context Protocol) 관리자는 외부 MCP 서버를 설정하고 Claude Code SDK에 제공합니다. GitHub, Jira, 파일시스템 등 다양한 외부 도구를 Claude에 연결합니다.

## 2. Server Types

### 2.1 Stdio Server

```typescript
export type McpStdioServerConfig = {
  type?: 'stdio';           // Optional (default)
  command: string;          // 실행 명령어
  args?: string[];          // 명령줄 인자
  env?: Record<string, string>;  // 환경 변수
};
```

**예시**:
```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx"
    }
  }
}
```

### 2.2 SSE Server

```typescript
export type McpSSEServerConfig = {
  type: 'sse';
  url: string;                    // SSE 엔드포인트 URL
  headers?: Record<string, string>;  // HTTP 헤더
};
```

**예시**:
```json
{
  "jira": {
    "type": "sse",
    "url": "https://mcp.atlassian.com/v1/sse"
  }
}
```

### 2.3 HTTP Server

```typescript
export type McpHttpServerConfig = {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
};
```

## 3. Configuration File

### 3.1 Location

```typescript
const configPath = path.resolve('./config.json');
```

### 3.2 Structure

```json
{
  "mcpServers": {
    "server-name": {
      // ServerConfig
    }
  }
}
```

### 3.3 Example Configuration

```json
{
  "mcpServers": {
    "jira": {
      "type": "sse",
      "url": "https://mcp.atlassian.com/v1/sse"
    },
    "codex": {
      "type": "stdio",
      "command": "codex",
      "args": ["mcp-server"],
      "env": {}
    },
    "gemini": {
      "type": "stdio",
      "command": "npx",
      "args": ["@2lab.ai/gemini-mcp-server"],
      "env": {}
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/usercontent"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    }
  }
}
```

## 4. Configuration Loading

### 4.1 Load Configuration

```typescript
loadConfiguration(): McpConfiguration | null {
  if (this.config) {
    return this.config;  // 캐시된 설정 반환
  }

  // 파일이 없으면 null
  if (!fs.existsSync(this.configPath)) {
    this.logger.info('No MCP configuration file found');
    return null;
  }

  // JSON 파싱
  const configContent = fs.readFileSync(this.configPath, 'utf-8');
  const parsedConfig = JSON.parse(configContent);

  // mcpServers 검증
  if (!parsedConfig.mcpServers || typeof parsedConfig.mcpServers !== 'object') {
    this.logger.warn('Invalid MCP configuration');
    return null;
  }

  // 각 서버 설정 검증
  for (const [serverName, serverConfig] of Object.entries(parsedConfig.mcpServers)) {
    if (!this.validateServerConfig(serverName, serverConfig)) {
      delete parsedConfig.mcpServers[serverName];
    }
  }

  this.config = parsedConfig;
  return this.config;
}
```

### 4.2 Validation

```typescript
private validateServerConfig(serverName: string, config: McpServerConfig): boolean {
  if (!config || typeof config !== 'object') {
    return false;
  }

  if (!config.type || config.type === 'stdio') {
    // Stdio: command 필수
    if (!config.command || typeof config.command !== 'string') {
      return false;
    }
  } else if (config.type === 'sse' || config.type === 'http') {
    // SSE/HTTP: url 필수
    if (!config.url || typeof config.url !== 'string') {
      return false;
    }
  } else {
    // 알 수 없는 타입
    return false;
  }

  return true;
}
```

### 4.3 Reload Configuration

```typescript
reloadConfiguration(): McpConfiguration | null {
  this.config = null;  // 캐시 초기화
  return this.loadConfiguration();
}
```

## 5. Server Configuration Provider

### 5.1 Get Server Configuration

```typescript
async getServerConfiguration(): Promise<Record<string, McpServerConfig> | undefined> {
  const baseDirectory = process.env.BASE_DIRECTORY || '/usercontent';
  const processedServers: Record<string, McpServerConfig> = {};

  // 1. 파일에서 설정 로드
  const config = this.loadConfiguration();
  if (config) {
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      if (serverName === 'github' && isGitHubAppConfigured()) {
        // GitHub App 토큰으로 대체
        const token = await githubAuth.getInstallationToken();
        processedServers[serverName] = {
          ...serverConfig,
          env: { ...serverConfig.env, GITHUB_PERSONAL_ACCESS_TOKEN: token }
        };
      } else {
        processedServers[serverName] = serverConfig;
      }
    }
  }

  // 2. GitHub App 설정 시 기본 서버 추가
  if (isGitHubAppConfigured()) {
    const token = await githubAuth.getInstallationToken();

    if (!processedServers.filesystem) {
      processedServers.filesystem = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', baseDirectory]
      };
    }

    if (!processedServers.github) {
      processedServers.github = {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: { GITHUB_PERSONAL_ACCESS_TOKEN: token }
      };
    }
  } else if (process.env.GITHUB_TOKEN) {
    // 레거시 토큰 인증
    // ... 비슷한 로직
  }

  return Object.keys(processedServers).length > 0 ? processedServers : undefined;
}
```

## 6. Default Allowed Tools

### 6.1 Tool Pattern

MCP 도구 이름 패턴: `mcp__<serverName>__<toolName>`

**예시**:
- `mcp__github__get_pull_request`
- `mcp__jira__getJiraIssue`
- `mcp__filesystem__read_file`

### 6.2 Get Default Allowed Tools

```typescript
getDefaultAllowedTools(): string[] {
  const serverNames = new Set<string>();

  // 설정 파일의 서버
  const config = this.loadConfiguration();
  if (config) {
    Object.keys(config.mcpServers).forEach(name => serverNames.add(name));
  }

  // 프로그래밍 방식 추가 서버
  if (isGitHubAppConfigured() || process.env.GITHUB_TOKEN) {
    serverNames.add('filesystem');
    serverNames.add('github');
  } else {
    serverNames.add('filesystem');
  }

  // 서버명 prefix로 모든 도구 허용
  return Array.from(serverNames).map(serverName => `mcp__${serverName}`);
}
```

## 7. MCP Info Display

### 7.1 Format MCP Info

```typescript
async formatMcpInfo(): Promise<string> {
  const allServers = await this.getServerConfiguration();

  if (!allServers || Object.keys(allServers).length === 0) {
    return 'No MCP servers configured.';
  }

  let info = '🔧 **MCP Servers Configured:**\n\n';

  for (const [serverName, serverConfig] of Object.entries(allServers)) {
    const type = serverConfig.type || 'stdio';

    // GitHub 인증 표시
    let authInfo = '';
    if (serverName === 'github' || serverName === 'git') {
      if (isGitHubAppConfigured()) {
        authInfo = ' (GitHub App)';
      } else if (process.env.GITHUB_TOKEN) {
        authInfo = ' (Token)';
      }
    }

    info += `• **${serverName}** (${type}${authInfo})\n`;

    if (type === 'stdio') {
      info += `  Command: \`${serverConfig.command}\`\n`;
      if (serverConfig.args?.length > 0) {
        info += `  Args: \`${serverConfig.args.join(' ')}\`\n`;
      }
    } else {
      info += `  URL: \`${serverConfig.url}\`\n`;
    }
    info += '\n';
  }

  info += 'Available tools follow the pattern: `mcp__serverName__toolName`\n';
  info += 'All MCP tools are allowed by default.';

  return info;
}
```

### 7.2 Output Example

```
🔧 **MCP Servers Configured:**

• **jira** (sse)
  URL: `https://mcp.atlassian.com/v1/sse`

• **codex** (stdio)
  Command: `codex`
  Args: `mcp-server`

• **github** (stdio) (GitHub App)
  Command: `npx`
  Args: `-y @modelcontextprotocol/server-github`

Available tools follow the pattern: `mcp__serverName__toolName`
All MCP tools are allowed by default.
```

## 8. MCP Call Tracker

### 8.1 Purpose

- MCP 도구 호출 시간 추적
- 예상 소요 시간 예측
- 진행률 표시

### 8.2 Interface

```typescript
interface McpCallStats {
  serverName: string;
  toolName: string;
  callCount: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  lastCalls: number[];  // 최근 N개 호출 시간
}
```

### 8.3 Start/End Call

```typescript
// 호출 시작
const callId = mcpCallTracker.startCall(serverName, toolName);

// 호출 종료
const duration = mcpCallTracker.endCall(callId);
```

### 8.4 Status Message

```typescript
getStatusMessage(callId: string): string | null {
  const call = this.activeCalls.get(callId);
  if (!call) return null;

  const elapsed = Date.now() - call.startTime;
  const predicted = this.getPredictedDuration(call.serverName, call.toolName);

  let message = `⏳ *MCP: ${call.serverName} → ${call.toolName}*\n`;
  message += `경과 시간: ${formatDuration(elapsed)}`;

  if (predicted) {
    const remaining = Math.max(0, predicted - elapsed);
    const progress = Math.min(100, (elapsed / predicted) * 100);
    message += `\n예상 시간: ${formatDuration(predicted)}`;
    message += `\n남은 시간: ~${formatDuration(remaining)}`;
    message += `\n진행률: ${progress.toFixed(0)}%`;
  }

  return message;
}
```

### 8.5 Statistics Persistence

```typescript
// 저장 경로
const DATA_FILE = path.join(process.cwd(), 'data', 'mcp-call-stats.json');

// 자동 저장
private saveStats(): void {
  const data: Record<string, McpCallStats> = {};
  for (const [key, value] of this.stats) {
    data[key] = value;
  }
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
```

## 9. Pre-configured Servers

### 9.1 Jira/Confluence

```json
{
  "jira": {
    "type": "sse",
    "url": "https://mcp.atlassian.com/v1/sse"
  }
}
```

**주요 도구**:
- `mcp__jira__getJiraIssue`
- `mcp__jira__searchJiraIssuesUsingJql`
- `mcp__jira__createJiraIssue`
- `mcp__jira__getConfluencePage`
- `mcp__jira__search`

### 9.2 GitHub

```json
{
  "github": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "..."
    }
  }
}
```

**주요 도구**:
- `mcp__github__get_pull_request`
- `mcp__github__get_pull_request_files`
- `mcp__github__create_pull_request_review`
- `mcp__github__get_file_contents`

### 9.3 Filesystem

```json
{
  "filesystem": {
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
  }
}
```

**주요 도구**:
- `mcp__filesystem__read_file`
- `mcp__filesystem__write_file`
- `mcp__filesystem__list_directory`

### 9.4 Codex

```json
{
  "codex": {
    "command": "codex",
    "args": ["mcp-server"]
  }
}
```

**모델 설정**:
```typescript
options: {
  model: "gpt-5.1-codex-max",
  config: { "model_reasoning_effort": "xhigh" }
}
```

## 10. Commands

### 10.1 View MCP Servers

```
mcp
/mcp
```

### 10.2 Reload Configuration

```
mcp reload
/mcp reload
```

**응답**:
```
✅ MCP configuration reloaded successfully.

🔧 **MCP Servers Configured:**
...
```

## 11. Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Claude Query Start                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│           mcpManager.getServerConfiguration()               │
└─────────────────────────────────────────────────────────────┘
                              │
          ┌───────────────────┼───────────────────┐
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│ Load Config     │ │ Process GitHub  │ │ Add Default     │
│ from File       │ │ App Tokens      │ │ Servers         │
└─────────────────┘ └─────────────────┘ └─────────────────┘
          │                   │                   │
          └───────────────────┼───────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│            options.mcpServers = processedServers            │
│            options.allowedTools = defaultAllowedTools       │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Claude SDK Query                          │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              MCP Tool Use (if needed)                        │
│          mcp__serverName__toolName                          │
└─────────────────────────────────────────────────────────────┘
```

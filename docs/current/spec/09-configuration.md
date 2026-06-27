# Configuration Specification

## Version
- Document Version: 1.0
- Source File: `src/config.ts`
- Last Updated: 2026-03-06

## 1. Overview

설정 모듈은 모든 환경 변수를 로드하고 검증하며, 애플리케이션 전체에서 사용할 수 있는 타입 안전한 설정 객체를 제공합니다.

## 2. Environment Variables

### 2.1 Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `SLACK_BOT_TOKEN` | Slack Bot OAuth Token | `xoxb-123456789-...` |
| `SLACK_APP_TOKEN` | Slack App-level Token (Socket Mode) | `xapp-1-...` |
| `SLACK_SIGNING_SECRET` | Slack 요청 서명 검증용 | `abc123def456...` |

### 2.2 Optional Variables

#### Claude Code

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API 키 (구독 대신 사용 시 / llmux 모드의 throwaway 키) | - |
| `CLAUDE_CODE_USE_BEDROCK` | AWS Bedrock 사용 | `0` |
| `CLAUDE_CODE_USE_VERTEX` | Google Vertex 사용 | `0` |

#### Auth Backend (`AUTH_MODE`)

백엔드가 Claude Agent SDK 호출을 어떤 경로로 인증할지 선택합니다. `config.auth`에 매핑됩니다. 변경 시 재시작 필요 (hot reload 없음).

| Variable | Description | Default |
|----------|-------------|---------|
| `AUTH_MODE` | `ccp` \| `llmux` | `ccp` |
| `ANTHROPIC_BASE_URL` | llmux 프록시 URL (`llmux` 모드에서만 사용) | `http://localhost:3456` |
| `ANTHROPIC_API_KEY` | llmux로 전달되는 throwaway 키 (값 무관) | `llmux-local` |

- **`ccp` (기본값)**: Claude Code Pro/Max OAuth — CCT slot lease (`CLAUDE_CODE_OAUTH_TOKEN`). 멀티 계정 로테이션, usage 추적, `/z cct` 카드가 모두 동작. 직접 API 키는 기존 cct 토큰 스토어로 관리.
- **`llmux`**: 로컬에 설치된 [llmux](https://github.com/2lab-ai/llmux) 프록시로 모든 SDK 호출을 라우팅. `buildQueryEnv`가 `ANTHROPIC_BASE_URL` + throwaway `ANTHROPIC_API_KEY`를 주입하고 OAuth 토큰을 제거함. CCT slot 불필요 — lease 획득은 synthetic lease로 short-circuit. 업스트림 계정 풀은 llmux가 소유.

설정 예시 (`.env`):

```bash
AUTH_MODE=llmux
ANTHROPIC_BASE_URL=http://localhost:3456
ANTHROPIC_API_KEY=anything
```

#### Working Directory

| Variable | Description | Default |
|----------|-------------|---------|
| `BASE_DIRECTORY` | 상대 경로 해석 기준 디렉토리 | - |

#### GitHub App

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_APP_ID` | GitHub App ID | - |
| `GITHUB_PRIVATE_KEY` | GitHub App Private Key (PEM) | - |
| `GITHUB_INSTALLATION_ID` | GitHub App Installation ID | - |

#### Legacy GitHub

| Variable | Description | Default |
|----------|-------------|---------|
| `GITHUB_TOKEN` | GitHub Personal Access Token | - |

#### Credentials Manager

| Variable | Description | Default |
|----------|-------------|---------|
| `ENABLE_LOCAL_FILE_CREDENTIALS_JSON` | 로컬 인증 파일 사용 | `0` |
| `AUTOMATIC_RESTORE_CREDENTIAL` | 자동 인증 복구 | `0` |

#### Development

| Variable | Description | Default |
|----------|-------------|---------|
| `DEBUG` | 디버그 모드 활성화 | `false` |

## 3. Config Object

### 3.1 Structure

```typescript
export const config = {
  slack: {
    botToken: string,
    appToken: string,
    signingSecret: string,
  },
  claude: {
    useBedrock: boolean,
    useVertex: boolean,
  },
  github: {
    appId: string | undefined,
    privateKey: string | undefined,
    installationId: string | undefined,
    token: string | undefined,
  },
  credentials: {
    enabled: boolean,
    autoRestore: boolean,
  },
  baseDirectory: string | undefined,
  debug: boolean,
};
```

### 3.2 Implementation

```typescript
export const config = {
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN || '',
    appToken: process.env.SLACK_APP_TOKEN || '',
    signingSecret: process.env.SLACK_SIGNING_SECRET || '',
  },
  claude: {
    useBedrock: process.env.CLAUDE_CODE_USE_BEDROCK === '1',
    useVertex: process.env.CLAUDE_CODE_USE_VERTEX === '1',
  },
  github: {
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_PRIVATE_KEY,
    installationId: process.env.GITHUB_INSTALLATION_ID,
    token: process.env.GITHUB_TOKEN,
  },
  credentials: {
    enabled: process.env.ENABLE_LOCAL_FILE_CREDENTIALS_JSON === '1',
    autoRestore: process.env.AUTOMATIC_RESTORE_CREDENTIAL === '1',
  },
  baseDirectory: process.env.BASE_DIRECTORY,
  debug: process.env.DEBUG === 'true',
};
```

## 4. Configuration Files

### 4.1 MCP Servers (`config.json`)

MCP 서버 설정 파일:

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
    }
  }
}
```

### 4.2 Claude Code Settings (`infra/claude/claude-code-settings.json`)

Claude Code SDK 권한 설정:

```json
{
  "permissions": {
    "allow": [
      "Bash(git clone:*)",
      "Bash(git pull:*)",
      "Bash(git push:*)",
      "Bash(git fetch:*)",
      "Bash(git checkout:*)",
      "Bash(git switch:*)",
      "Bash(git commit:*)",
      "Bash(git add:*)",
      "Bash(git status:*)",
      "Bash(gh pr:*)",
      "FileSystem(read:/usercontent/*)",
      "FileSystem(write:/usercontent/*)",
      "FileSystem(list:/usercontent/*)",
      "FileSystem(delete:/usercontent/*)",
      "FileSystem(createDirectory:/usercontent/*)",
      "Edit(//usercontent/**)",
      "MultiEdit(//usercontent/**)",
      "Write(//usercontent/**)"
    ],
    "additionalDirectories": ["/usercontent"]
  }
}
```

### 4.3 Slack App Manifest (`infra/slack/slack-app-manifest.json`)

Slack 앱 설정 템플릿:

```json
{
  "display_information": {
    "name": "Claude Code Bot",
    "description": "AI coding assistant powered by Claude",
    "background_color": "#7C3AED"
  },
  "features": {
    "bot_user": {
      "display_name": "Claude Code",
      "always_online": true
    }
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "chat:write",
        "chat:write.public",
        "im:history",
        "im:read",
        "im:write",
        "users:read",
        "reactions:read",
        "reactions:write"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.im",
        "member_joined_channel"
      ]
    },
    "interactivity": {
      "is_enabled": true
    },
    "socket_mode_enabled": true
  }
}
```

## 5. Data Files

### 5.1 User Settings (`data/user-settings.json`)

사용자별 설정 저장:

```json
{
  "U1234567890": {
    "userId": "U1234567890",
    "defaultDirectory": "/Users/dev/Code/project",
    "bypassPermission": false,
    "persona": "default",
    "lastUpdated": "2025-12-13T10:30:00.000Z"
  }
}
```

### 5.2 Sessions (`data/sessions.json`)

세션 영속화:

```json
[
  {
    "key": "C01ABC23DEF-1702456789.123456",
    "ownerId": "U1234567890",
    "ownerName": "Hong Gildong",
    "userId": "U1234567890",
    "channelId": "C01ABC23DEF",
    "threadTs": "1702456789.123456",
    "sessionId": "session_abc123",
    "isActive": true,
    "lastActivity": "2025-12-13T10:30:00.000Z",
    "workingDirectory": "/Users/dev/Code/project"
  }
]
```

### 5.3 MCP Call Stats (`data/mcp-call-stats.json`)

MCP 호출 통계:

```json
{
  "github__get_pull_request": {
    "serverName": "github",
    "toolName": "get_pull_request",
    "callCount": 50,
    "avgDuration": 1234,
    "minDuration": 500,
    "maxDuration": 5000,
    "lastCalls": [1200, 1100, 1300]
  }
}
```

### 5.4 Slack-Jira Mapping (`data/slack_jira_mapping.json`)

Slack-Jira 사용자 매핑:

```json
{
  "U1234567890": {
    "jiraAccountId": "5f4dcc3b5aa765d61d8327deb882cf99",
    "name": "Hong Gildong",
    "slackName": "홍길동",
    "jiraName": "Hong Gildong"
  }
}
```

## 6. Prompt Files

### 6.1 System Prompt (`src/prompt/system.prompt`)

Claude의 기본 시스템 프롬프트:

```xml
<system_prompt>
You are a 400-yr full stack software engineer...

# Facts
## Repository
...

# 주요 워크플로우
...
</system_prompt>

<review_guideline>
...
</review_guideline>
```

### 6.2 Persona Files (`src/persona/*.md`)

사용자별 AI 페르소나:

**default.md**:
```markdown
(기본 페르소나 설정)
```

**custom.md**:
```markdown
너는 일론 머스크다. 일론 머스크의 사고와 말투를 사용해...
```

## 7. Log Files

### 7.1 Location

```
logs/
├── stdout.log    # 표준 출력
└── stderr.log    # 표준 에러 (메인 로그)
```

### 7.2 Log Format

```
[2025-12-13T10:30:00.000Z] [INFO] [SlackHandler] Message received
{
  "user": "U1234567890",
  "channel": "C01ABC23DEF",
  "text": "hello"
}
```

## 8. Service Configuration

### 8.1 launchd Plist (`ai.2lab.soma-work.{main,dev}.plist`)

macOS 서비스 설정 (현행: `/Library/LaunchDaemons/ai.2lab.soma-work.{main,dev}.plist`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.2lab.soma-work.dev</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/opt/soma-work/dev/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/opt/soma-work/dev</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>StandardOutPath</key>
    <string>/opt/soma-work/dev/logs/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>/opt/soma-work/dev/logs/stderr.log</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
</dict>
</plist>
```

## 9. Environment File Template

### 9.1 `.env.example`

```env
# Required - Slack Configuration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_APP_TOKEN=xapp-your-app-token
SLACK_SIGNING_SECRET=your-signing-secret

# Optional - Claude Code
# ANTHROPIC_API_KEY=your-api-key
# CLAUDE_CODE_USE_BEDROCK=1
# CLAUDE_CODE_USE_VERTEX=1

# Optional - Working Directory
BASE_DIRECTORY=/Users/username/Code/

# Optional - GitHub App (Recommended)
GITHUB_APP_ID=123456
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...
-----END RSA PRIVATE KEY-----"
GITHUB_INSTALLATION_ID=12345678

# Optional - Legacy GitHub Token
# GITHUB_TOKEN=ghp_your_personal_access_token

# Optional - Credentials Manager
# ENABLE_LOCAL_FILE_CREDENTIALS_JSON=1
# AUTOMATIC_RESTORE_CREDENTIAL=1

# Development
DEBUG=true
```

## 10. Configuration Validation

### 10.1 Required Fields

```typescript
function validateConfig() {
  const required = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_SIGNING_SECRET'
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }
}
```

### 10.2 Startup Logging

```typescript
logger.info('Configuration:', {
  usingBedrock: config.claude.useBedrock,
  usingVertex: config.claude.useVertex,
  usingAnthropicAPI: !config.claude.useBedrock && !config.claude.useVertex,
  hasBaseDirectory: !!config.baseDirectory,
  hasGitHubApp: !!(config.github.appId && config.github.privateKey),
  hasGitHubToken: !!config.github.token,
  credentialsEnabled: config.credentials.enabled,
  debugMode: config.debug,
});
```

## 11. Directory Structure Summary

```
soma-work/
├── .env                           # 환경 변수 (gitignore)
├── .env.example                   # 환경 변수 템플릿
├── config.json               # MCP 서버 설정
├── infra/claude/claude-code-settings.json      # Claude SDK 권한
├── infra/slack/slack-app-manifest.json        # Slack 앱 매니페스트
├── data/                          # 런타임 데이터
│   ├── user-settings.json
│   ├── sessions.json
│   ├── mcp-call-stats.json
│   └── slack_jira_mapping.json
├── logs/                          # 로그 파일
│   ├── stdout.log
│   └── stderr.log
├── src/
│   ├── config.ts                  # 설정 모듈
│   ├── prompt/
│   │   └── system.prompt          # 시스템 프롬프트
│   └── persona/
│       ├── default.md
│       └── *.md
└── dist/                          # 빌드 출력
```

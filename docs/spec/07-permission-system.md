# Permission System Specification

## Version
- Document Version: 1.0
- Source Files: `src/permission-mcp-server.ts`, `src/shared-store.ts`
- Last Updated: 2025-12-13

## 1. Overview

권한 시스템은 Claude가 민감한 도구를 실행하기 전에 사용자에게 승인을 요청합니다. Slack 버튼을 통해 승인/거부를 결정하고, 파일 기반 IPC로 MCP 서버와 Slack 핸들러 간 통신합니다.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code SDK                         │
│                   (Permission Required)                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│               Permission MCP Server                          │
│           (Subprocess of Claude SDK)                         │
└─────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│   Slack API          │        │   Shared Store       │
│   (Post Message)     │        │   (File-based IPC)   │
└──────────────────────┘        └──────────────────────┘
              │                               │
              │                               │
              ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐
│   User Button Click  │───────▶│   Write Response     │
│   (Approve/Deny)     │        │   File               │
└──────────────────────┘        └──────────────────────┘
                                              │
                              ┌───────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────┐
│               Permission MCP Server                          │
│               (Poll for Response)                            │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Claude Code SDK                         │
│                   (Execute or Abort)                         │
└─────────────────────────────────────────────────────────────┘
```

## 3. Permission MCP Server

### 3.1 Server Definition

```typescript
const server = new Server(
  {
    name: "permission-prompt",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);
```

### 3.2 Tool Definition

```typescript
{
  name: "permission_prompt",
  description: "Request user permission for tool execution via Slack button",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: {
        type: "string",
        description: "Name of the tool requesting permission",
      },
      input: {
        type: "object",
        description: "Input parameters for the tool",
      },
      channel: { type: "string" },
      thread_ts: { type: "string" },
      user: { type: "string" },
    },
    required: ["tool_name", "input"],
  }
}
```

### 3.3 Slack Context Injection

Claude Handler에서 환경변수로 Slack 컨텍스트 전달:

```typescript
const permissionServer = {
  'permission-prompt': {
    command: 'npx',
    args: ['tsx', path.join(__dirname, 'permission-mcp-server.ts')],
    env: {
      SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
      SLACK_CONTEXT: JSON.stringify(slackContext)
    }
  }
};
```

### 3.4 Permission Request Handling

```typescript
private async handlePermissionPrompt(params: PermissionRequest) {
  const { tool_name, input } = params;

  // Slack 컨텍스트 복원
  const slackContextStr = process.env.SLACK_CONTEXT;
  const { channel, threadTs: thread_ts, user } = JSON.parse(slackContextStr);

  // 고유 승인 ID 생성
  const approvalId = `approval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Slack에 승인 요청 메시지 전송
  const result = await this.slack.chat.postMessage({
    channel: channel || user || 'general',
    thread_ts: thread_ts,
    blocks: blocks,  // 버튼 블록
    text: `Permission request for ${tool_name}`
  });

  // SharedStore에 대기 중인 승인 저장
  await sharedStore.storePendingApproval(approvalId, {
    tool_name,
    input,
    channel,
    thread_ts,
    user,
    created_at: Date.now(),
    expires_at: Date.now() + (5 * 60 * 1000)  // 5분
  });

  // 사용자 응답 대기 (폴링)
  const response = await this.waitForApproval(approvalId);

  // 메시지 업데이트
  await this.slack.chat.update({ ... });

  return {
    content: [{ type: "text", text: JSON.stringify(response) }]
  };
}
```

## 4. Slack Button UI

### 4.1 Permission Request Message

```typescript
const blocks = [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🔐 *Permission Request*

Claude wants to use the tool: \`${tool_name}\`

*Tool Parameters:*
\`\`\`json
${JSON.stringify(input, null, 2)}
\`\`\``
    }
  },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "✅ Approve" },
        style: "primary",
        action_id: "approve_tool",
        value: approvalId
      },
      {
        type: "button",
        text: { type: "plain_text", text: "❌ Deny" },
        style: "danger",
        action_id: "deny_tool",
        value: approvalId
      }
    ]
  },
  {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `Requested by: <@${user}> | Tool: ${tool_name}`
      }
    ]
  }
];
```

### 4.2 Approved/Denied Message

승인/거부 후 메시지 업데이트:

```typescript
const updatedBlocks = [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `🔐 *Permission Request* - ${approved ? '✅ Approved' : '❌ Denied'}

Tool: \`${tool_name}\`

*Tool Parameters:*
\`\`\`json
${JSON.stringify(input, null, 2)}
\`\`\``
    }
  },
  {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `${approved ? 'Approved' : 'Denied'} by user | Tool: ${tool_name}`
      }
    ]
  }
];
```

## 5. Shared Store (File-based IPC)

### 5.1 Directory Structure

```typescript
const storeDir = path.join(os.tmpdir(), 'claude-code-slack-bot-store');
const pendingDir = path.join(storeDir, 'pending');
const responseDir = path.join(storeDir, 'responses');

// 예시 경로
// /tmp/claude-code-slack-bot-store/pending/approval_1702456789123_xyz123.json
// /tmp/claude-code-slack-bot-store/responses/approval_1702456789123_xyz123.json
```

### 5.2 Data Structures

**PendingApproval**:
```typescript
export interface PendingApproval {
  tool_name: string;
  input: any;
  channel?: string;
  thread_ts?: string;
  user?: string;
  created_at: number;
  expires_at: number;
}
```

**PermissionResponse**:
```typescript
export interface PermissionResponse {
  behavior: 'allow' | 'deny';
  updatedInput?: any;
  message?: string;
}
```

### 5.3 Store Operations

**Store Pending Approval**:
```typescript
async storePendingApproval(approvalId: string, approval: PendingApproval): Promise<void> {
  const filePath = path.join(this.pendingDir, `${approvalId}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(approval, null, 2));
}
```

**Get Pending Approval**:
```typescript
async getPendingApproval(approvalId: string): Promise<PendingApproval | null> {
  const filePath = path.join(this.pendingDir, `${approvalId}.json`);

  if (!fs.existsSync(filePath)) {
    return null;
  }

  const data = await fs.promises.readFile(filePath, 'utf8');
  const approval = JSON.parse(data);

  // 만료 체크
  if (Date.now() > approval.expires_at) {
    await this.deletePendingApproval(approvalId);
    return null;
  }

  return approval;
}
```

**Store Permission Response**:
```typescript
async storePermissionResponse(approvalId: string, response: PermissionResponse): Promise<void> {
  const filePath = path.join(this.responseDir, `${approvalId}.json`);
  await fs.promises.writeFile(filePath, JSON.stringify(response, null, 2));
}
```

### 5.4 Polling for Response

```typescript
async waitForPermissionResponse(
  approvalId: string,
  timeoutMs: number = 5 * 60 * 1000
): Promise<PermissionResponse> {
  const filePath = path.join(this.responseDir, `${approvalId}.json`);
  const startTime = Date.now();
  const pollInterval = 500;  // 500ms

  return new Promise((resolve, reject) => {
    const poll = async () => {
      // 타임아웃 체크
      if (Date.now() - startTime > timeoutMs) {
        await this.cleanup(approvalId);
        resolve({
          behavior: 'deny',
          message: 'Permission request timed out'
        });
        return;
      }

      // 응답 파일 체크
      if (fs.existsSync(filePath)) {
        const data = await fs.promises.readFile(filePath, 'utf8');
        const response = JSON.parse(data);
        await this.cleanup(approvalId);
        resolve(response);
        return;
      }

      // 계속 폴링
      setTimeout(poll, pollInterval);
    };

    poll();
  });
}
```

## 6. Button Action Handlers

### 6.1 Approve Handler

```typescript
this.app.action('approve_tool', async ({ ack, body, respond }) => {
  await ack();

  const approvalId = (body as any).actions[0].value;

  await sharedStore.storePermissionResponse(approvalId, {
    behavior: 'allow',
    message: 'Approved by user'
  });

  // 메시지 업데이트
  await respond({
    text: `✅ Permission approved for tool execution`,
    replace_original: true
  });
});
```

### 6.2 Deny Handler

```typescript
this.app.action('deny_tool', async ({ ack, body, respond }) => {
  await ack();

  const approvalId = (body as any).actions[0].value;

  await sharedStore.storePermissionResponse(approvalId, {
    behavior: 'deny',
    message: 'Denied by user'
  });

  await respond({
    text: `❌ Permission denied for tool execution`,
    replace_original: true
  });
});
```

## 7. User Bypass System

### 7.1 Bypass Setting

사용자별 권한 우회 설정:

```typescript
// Claude Handler에서
const userBypass = userSettingsStore.getUserBypassPermission(slackContext.user);

if (userBypass) {
  options.permissionMode = 'bypassPermissions';
  // permission-prompt 서버 추가하지 않음
}
```

### 7.2 Bypass Commands

**Check Status**:
```
bypass
/bypass
```

**Enable**:
```
bypass on
```

**Disable**:
```
bypass off
```

### 7.3 Response Messages

**Status Check**:
```
🔐 *Permission Bypass Status*

Your current setting: OFF
✅ Claude will ask for permission before executing sensitive tools.
```

**Enable**:
```
✅ *Permission Bypass Enabled*

Claude will now execute tools without asking for permission.
⚠️ Use with caution - this allows Claude to perform actions automatically.
```

**Disable**:
```
✅ *Permission Bypass Disabled*

Claude will now ask for your permission before executing sensitive tools.
```

## 8. Timeout Handling

### 8.1 Timeout Configuration

```typescript
const TIMEOUT_MS = 5 * 60 * 1000;  // 5분
```

### 8.2 Timeout Response

```typescript
if (Date.now() - startTime > timeoutMs) {
  return {
    behavior: 'deny',
    message: 'Permission request timed out'
  };
}
```

### 8.3 Expired Approval Cleanup

```typescript
async cleanupExpired(): Promise<number> {
  let cleaned = 0;
  const pendingFiles = await fs.promises.readdir(this.pendingDir);

  for (const fileName of pendingFiles) {
    if (!fileName.endsWith('.json')) continue;

    const approvalId = fileName.replace('.json', '');
    const approval = await this.getPendingApproval(approvalId);

    if (!approval) {
      // getPendingApproval이 만료된 항목 삭제함
      cleaned++;
    }
  }

  return cleaned;
}
```

## 9. Error Handling

### 9.1 Slack API Error

```typescript
try {
  await this.slack.chat.postMessage({ ... });
} catch (error) {
  logger.error('Error handling permission prompt:', error);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        behavior: 'deny',
        message: 'Error occurred while requesting permission'
      })
    }]
  };
}
```

### 9.2 IPC Error

```typescript
try {
  await fs.promises.writeFile(filePath, data);
} catch (error) {
  logger.error('Failed to store permission response:', error);
  throw error;
}
```

## 10. Flow Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                Claude Tool Use Request                        │
│            (Requires Permission)                              │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│            Check User Bypass Setting                          │
│         userSettingsStore.getUserBypassPermission()          │
└──────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
┌──────────────────────┐        ┌──────────────────────────────┐
│   Bypass Enabled     │        │   Bypass Disabled            │
│   → Execute Tool     │        │   → Permission MCP Server    │
└──────────────────────┘        └──────────────────────────────┘
                                              │
                                              ▼
                                ┌──────────────────────────────┐
                                │   Post Slack Message         │
                                │   with Approve/Deny Buttons  │
                                └──────────────────────────────┘
                                              │
                                              ▼
                                ┌──────────────────────────────┐
                                │   Store Pending Approval     │
                                │   in SharedStore             │
                                └──────────────────────────────┘
                                              │
                                              ▼
                                ┌──────────────────────────────┐
                                │   Poll for Response          │
                                │   (500ms interval)           │
                                └──────────────────────────────┘
                                              │
              ┌───────────────────────────────┼───────────────────────────────┐
              │                               │                               │
              ▼                               ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐        ┌──────────────────────┐
│   User Clicks        │        │   User Clicks        │        │   Timeout            │
│   "Approve"          │        │   "Deny"             │        │   (5 minutes)        │
└──────────────────────┘        └──────────────────────┘        └──────────────────────┘
              │                               │                               │
              ▼                               ▼                               ▼
┌──────────────────────┐        ┌──────────────────────┐        ┌──────────────────────┐
│   behavior: 'allow'  │        │   behavior: 'deny'   │        │   behavior: 'deny'   │
│   → Execute Tool     │        │   → Abort Tool       │        │   → Abort Tool       │
└──────────────────────┘        └──────────────────────┘        └──────────────────────┘
```

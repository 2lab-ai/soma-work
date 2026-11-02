# Permission System Specification

## Version
- Document Version: 1.0
- Source Files: `src/permission-mcp-server.ts`, `src/shared-store.ts`
- Last Updated: 2026-03-06

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
const storeDir = path.join(os.tmpdir(), 'soma-work-store');
const pendingDir = path.join(storeDir, 'pending');
const responseDir = path.join(storeDir, 'responses');

// 예시 경로
// /tmp/soma-work-store/pending/approval_1702456789123_xyz123.json
// /tmp/soma-work-store/responses/approval_1702456789123_xyz123.json
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

Current implementation: `src/slack/actions/permission-action-handler.ts` (registered in `packages/slack/src/actions/index.ts`). The snippets below show the response each button stores.

**Requester-only.** The prompt is an ordinary thread message, so every channel member can click it. Before storing anything, each handler (`approve_tool`, `deny_tool`, `explain_tool`, `approve_disable_rule_session`) loads the `PendingApproval` and proceeds only when `body.user.id === PendingApproval.user` (the user the request was raised for). Any other clicker gets an ephemeral notice and no response is stored. A missing click user, a request with no recorded user, or a missing/expired record also stores nothing (fail-closed): the MCP server keeps waiting and times out to deny.

**One answer path, two surfaces (2026-10-24).** The Slack handlers and the web dashboard (`POST /api/dashboard/session/:key/permission`, the card and session panel of a session blocked on a prompt) both call `answerPermissionPrompt` in `src/permission-prompt-response.ts`. It:

- accepts only records stamped `kind: 'tool_permission'` by the permission MCP server — the pending directory also holds mcp-tool-permission's admin-approved grant requests, whose `user` is the (non-admin) requester and must never answer them;
- accepts only the requester (`actor === PendingApproval.user`); the dashboard passes the signed-in Slack user, so the viewer bearer token and admin mode (no requester identity) are refused;
- on the dashboard, accepts only a prompt of the session thread named by the route key;
- answers at most once: `sharedStore.claimPermissionResponse` is an exclusive create in `claims/` taken before any side effect (the "disable rule" mutation), and the claim outlives the MCP server's cleanup, so a late second click from either surface gets "already answered" and changes nothing. Pending records and responses are written via temp file + rename, so the 500ms poller never reads half a file.

The dashboard board never carries the tool input (it is one document for every viewer); the requester's page reads it from `GET /api/dashboard/session/:key/permission/:approvalId` (cut at 64KB and labelled).

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

## 6b. Environment Skill Admin Approval

환경 플러그인(배포가 `config.json` `plugin.envPlugins`에 표시한 플러그인)의 스킬은 어드민(`ADMIN_USERS`)만 바로
실행하고, 그 밖의 사용자는 어드민의 허용이 있어야 실행한다. 다른 사용자의 개인 스킬에 소유자 허용을 받는 흐름
(`skill_perm_`)을 그대로 따르고, 승인자만 어드민으로 바뀐다. 운영 설명은 `docs/runbook/add-new-deploy.md` §8.5.

| 부분 | 위치 |
|---|---|
| 환경 스킬 판정 (`plugin:skill` / 맨이름) | `src/env-skill-registry.ts` (`resolveEnvSkillKey`, `checkEnvSkillPermission`) |
| 결정 — 모델의 `Skill` 호출·플러그인 파일 읽기 | `evaluateToolPolicy` 6b단계 (`agent-runtime/policy/tool-policy.ts`, `ENV_GATED_TOOLS`), Lean 모델 phase 4 (`verification/lean/SomaVerify/ToolPolicy/ProofsEnvSkill.lean`) |
| 결정 — `$plugin:skill` | `SkillForceHandler.resolveSkill` (중첩 참조 포함, 같은 판정 함수) |
| 집행 — 어드민 요청 | `build-stream-options.ts` 훅의 `onEnvSkillDenied` → `slack/env-skill-permission-request.ts` (어드민 DM, 실패 시 스레드) |
| 허용 저장 | `user-skill-grants-store.ts`, 예약 소유자 `env-skills` → `DATA_DIR/env-skill-grants.json` + 스레드 허용(메모리, 12h) |
| 요청 저장 | `skill-permission-request-store.ts` (소유자 `env-skills`, 스레드별 중복 제거, 어드민 DM 위치 기록) |
| 어드민 답 | `slack/actions/env-skill-permission-action-handler.ts` (`env_skill_perm_*`: 1회/항상/전체/거부) |

- 결정은 하나: 어드민이 아니고, 도구가 `ENV_GATED_TOOLS`(`Skill`·`Read`·`Glob`·`Grep`·`Bash`·`Write`·`Edit`·`NotebookEdit`) 중 하나이고,
  `ctx.checkEnvSkillPermission(toolName, input)`(→ `checkEnvSkillAccess`)이 이유를 돌려주면 거부한다. 이유는
  `env-skill: <plugin:skill>`(스킬 하나 — 어드민에게 묻는다), `env-skill: <plugin>`(스킬이 아닌 플러그인 파일 — 묻지
  않는다), `env-skill: (no skill name)`(이름 없는 `Skill` 호출 — fail-closed)이고, 모델에게는 `ENV_SKILL_DENY_MESSAGE`가
  간다. 인시던트 세션은 그 위의 인시던트 단계에서 모든 호출이 결정되므로 6b에 닿지 않는다. 6b는 모드 단계보다 앞이라
  Bash·네이티브 도구의 allow도 덮는다. 쓰기 도구는 허용과 무관하게 플러그인 파일을 고칠 수 없다. 플러그인 매니저가
  없으면 판정 목록은 `config.json`의 `plugin.envPlugins`에서 읽는다.
- 방어 심층: 비어드민의 샌드박스 Bash에는 `envSkillSandboxDenyRead`가 환경 플러그인 디렉터리를 OS 수준 읽기 금지로
  건다(`build-stream-options.ts`). 6b의 Bash 검사는 문자열 수준이라 이것이 실제 경계다.
- 버튼은 `requestId`만 싣는다. 요청은 서버에서 읽고, 읽기와 `markRequestHandled` 사이에 `await`가 없어 두 번째 클릭
  (같은 어드민이든 다른 어드민이든)은 "이미 처리됨"을 받는다.
- 허용 뒤 이행은 요청자 이름으로 원문(또는 "이어서 진행" 메시지)을 다시 보내는 것이다 — 다시 보낸 턴이 같은 게이트를
  지나며 이번에는 허용을 본다.

## 6c. Plan Mode — No Work Before 시작

대시보드 작업을 "작업 계획" 모드로 만들면, 소유자가 계획을 시작하기 전의 턴은 계획만 세운다(SSOT 2026-11-02).
이 금지는 안내문이 아니라 정책 단계로 강제된다 — 모든 모드, 어드민까지(소유자의 계약이지 권한 문제가 아니다).

| 부분 | 위치 |
|---|---|
| 판정 (순수, fail-closed) | `src/agent-runtime/policy/plan-pending-guard.ts` (`checkPlanPendingCall`, `isReadOnlyCommand`, `PLAN_PENDING_DENIED_TOOLS`) |
| 결정 | `evaluateToolPolicy` 6c단계 (`ctx.checkPlanPending`, `PLAN_PENDING_DENY_MESSAGE`) — 6단계(PR-이슈) 다음, 인시던트·모드 단계 앞 |
| 배선 | `build-stream-options.ts` — 실행 문맥이 `origin: 'task'` + `planPending`일 때만 체크를 싣는다 |
| Lean | `evaluateToolPolicyPlan` (`Model.lean`), `ProofsPlan.lean` — 사유가 있으면 항상 거부, 없으면 `evaluateToolPolicyWith`와 같음, 좁히기만 함 |

- 거부: 쓰기 도구·서브에이전트(`Write`·`Edit`·`MultiEdit`·`NotebookEdit`·`Artifact`·`EnterWorktree`·`Agent`·`Task`), 모든 구간이
  허용된 읽기로 읽히지 않는 셸 명령(리다이렉션·치환·백그라운드 `&`·환경 할당·경로 실행 포함), 이름이 읽기가 아니거나 바꾸는 단어를 담은 MCP 도구.
- 통과: `Read`·`Glob`·`Grep`·`WebFetch`·`WebSearch`·`Skill`, 읽기 전용 명령(`ls`·`cat`·`grep`·`rg`·`find`·`sed -n 'N,Mp'`·`git log/show/diff/status`·
  `git clone/fetch`·`gh … view/list`·`gh api` GET), `mcp__plan__*`(계획 제출), 읽기 MCP(`get_`·`list_`·`search_`·`…_query` 등).
- 거부 메시지는 모델에게 그 변경을 계획에 넣고 `plan_submit`하라고 알린다. 시작(`approved`) 뒤 턴에는 체크가 실리지 않는다.

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

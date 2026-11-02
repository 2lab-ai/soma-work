# Permission System Specification

## Version
- Document Version: 1.0
- Source Files: `src/permission-mcp-server.ts`, `src/shared-store.ts`
- Last Updated: 2026-10-27

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

**AI advice on every prompt, and a second confirmation (2026-11-02).** Every prompt the person sees carries the auto-mode guardian's advice: what the call does, why it is risky, and whether to approve it (`PendingApproval.advice = { recommendation: 'approve' | 'deny', summary, risk }`).

- Source of the advice. The guardian (`src/agent-runtime/policy/safety-classifier.ts`) answers its verdict and the advice in one JSON reply. When the policy hook escalates a `classify` call to the person, it leaves that advice on `permissionAdviceBoard` (`src/agent-runtime/policy/permission-advice.ts`), keyed by the session key, the tool and the input. The permission prompt takes it through `McpConfigBuilder.setPermissionAdvisor` (wired by `ClaudeHandler`), so there is no second model call. A prompt nothing escalated (legacy mode) asks the guardian itself, for up to 30 seconds. A guardian that fails, is too slow or is off gives no advice, and the prompt still goes out. A Slack-less task's escalation passes the advice to the dashboard approval (`TaskApprovalRequest.advice`).
- Slack card. A green bar and 🟢 "AI 추천: 승인해도 됩니다" when the AI recommends approving. A red bar and 🔴 "AI 권고: 실행하지 마세요" when it does not; on that card Deny is the green button, Approve is the red "그래도 승인" button, and there is no "disable rule" shortcut. With no advice, a neutral ⚪ "AI 추천 없음" line and no bar. The advised card is posted inside an attachment (`color`), the only coloured edge Slack has. The head lines are fixed mrkdwn; the model's text (what it does, why it is risky) is `plain_text` (`permissionAdviceDetailBlocks`), so it can never bold, strike out, link or mention anything.
- Guardian replies. A reply that allows the call but recommends `deny` contradicts itself; it is treated as `ask`, so the call is not auto-approved and the person sees the red advice. The 30-second wait and the turn's abort both abort the guardian's one-shot dispatch, not just the wait.
- Second confirmation. `answerPermissionPrompt` refuses `approve` and `approve_disable_rule` on a prompt whose advice is `deny` with `confirm_required`, before the claim, so nothing is stored. Only `approve_confirmed` runs the call (and silences no rule), and only after the server itself answered `confirm_required` to that requester. The daemon keeps that first ask in memory per approval id and requester, for up to 10 minutes, and spends it on the claim. An `approve_confirmed` sent with no first ask counts as the first ask. Slack shows the requester an ephemeral red question with one button, `approve_tool_confirmed`. The dashboard route answers `428 { code: 'confirm_required' }`, and the card's next Approve sends `approve_confirmed`. Deny never needs a second answer.
- Dashboard card. The board carries only `aiRecommendation`, which gives every viewer a red (`risk: 'high'`) or green (`risk: 'low'`) card. The page also colours the card's own tokens through `data-ai`, so Approve is red or green. What the call does and why it is risky can quote the command, so they are in the requester-only detail (`advice`). The page shows them in full in an advice box under the card (`acPaintAdvice`, text nodes only), because the card's description is one line.

**The answer in the work log (2026-11-02).** The Slack card is deleted once answered, so every stored answer is recorded in the session's work log as a `permission` entry (`packages/slack/src/work-log.ts`). The entry holds the decision, the tool and call, the AI's advice and who answered: `permission: { decision, by, ai? }`, `ok` = whether the call runs. A Slack prompt's entry is conversation-level; a task prompt's is filed on the turn that asked. The dashboard's 작업 로그 shows it as a badge row (권한 승인, 권한 거부, 설명 요청, 2차 확인 승인). A refused answer (not the requester, already answered, confirmation needed) records nothing.

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

## 7. Permission Modes (auto · bypass · legacy)

정본: `src/agent-runtime/policy/permission-mode.ts`, 결정 함수: `src/agent-runtime/policy/tool-policy.ts`.

### 7.1 Modes

| Mode | 누가 | Bash 처리 |
|---|---|---|
| `auto` (기본) | 모두 | 위험 규칙에 안 걸리면 실행. 걸리면 safety classifier(model)가 질문할지 정한다 — 정규식이 직접 묻는 일은 없다. |
| `bypass` | **admin만** | 검사 없이 실행(하드 거부 계층은 그대로). admin이 아닌 유저의 저장값 `bypass`(명시 또는 레거시 `bypassPermission:true`)는 `auto`로 해석된다(`effectivePermissionMode`). |
| `legacy` | 명시 설정만 | SDK가 모든 도구마다 묻는다. 버튼으로는 고를 수 없다. |

모델 컨텍스트에는 실제 적용 모드가 `<user-permission-mode>`로 들어간다.

### 7.2 Auto mode: model decides, mechanical check warns

```
Bash 호출 → 하드 거부 계층 → 위험 규칙 매칭(soma-lib 카탈로그)
   ├─ 매칭 없음 → 실행
   └─ 그 밖의 매칭 → safety classifier (owner 본인이 요청한 턴이면 owner의 Slack 원문만 데이터로 인용 — 스킬 본문 제외, steer 포함,
            긴 글은 앞뒤만 남기고 잘림을 명시. 20s 타임아웃 = 실제 abort, 실패·예외는 ask)
        ├─ ask   → 🔐 Permission Request 카드 (Slack + 대시보드 "입력 필요", #754의 AI 권고 포함)
        └─ allow → 실행 + 기계 검사(permission-warning.ts)
                    └─ 여전히 문제(데이터 파이프만 제외: `| python3 -c` / `| node -e` 한 줄짜리가
                       허용 모듈만 import하고, 허용 어휘만 쓰고, 실행·쓰기·로드가 없을 때. perl·ruby·php·다른 플래그·추가 인자·경로나 env가 붙은 인터프리터는 모두 경고) →
                       ⚠️ Permission Warning: Slack 스레드 카드(버튼 없음) + 대시보드 작업 로그의 "퍼미션 경고" 줄과
                       지시와 답변의 같은 시각 시스템 줄(work-log kind `permission_warning`). Slack 없는 task 턴은 대시보드만.
```

- owner가 직접 부른 스킬만 classifier에 넘긴다. 근거는 owner 본인 메시지의 `$스킬`·`$local:스킬` 토큰과, owner가 Slack 명령·버튼·대시보드로 등록한 autoskill 두 가지뿐이다(`src/slack/owner-skill-invocations.ts`). 호스트가 붙인 `<invoked_skills>` 블록 텍스트는 근거로 쓰지 않는다. 스킬 본문이 섹션 경계를 흉내 낼 수 있고, 다른 스킬의 `$참조`는 owner가 입력하지 않은 의존성으로 펼쳐지기 때문이다. 위임 범위는 호스트 코드(`safety-classifier.ts`의 `SKILL_DELEGATIONS`)가 정한다. 지금은 `local:autoz` 하나로, 세션이 작업하는 저장소에서 이슈와 PR을 열고 자체 리뷰 게이트 뒤에 승인하고 머지하는 것까지다. 다른 사람이나 다른 계정의 자격증명을 쓰는 일은 어떤 스킬도 위임하지 않는다.
- classifier가 판단하는 동안 owner 지시가 바뀌면(예: 끼어든 "삭제하지 마") 그 승인은 쓰지 않고 묻는다. 취소되거나 큐로 돌아간 steer는 지시에서 빠진다. 지시 이력이 불완전할 수 있으면(재시작으로 복원된 세션, 50개 상한, 스킬 블록 뒤에 남은 텍스트) 파괴적 작업은 그 지시만으로 허용하지 않는다.
- 경고는 결정을 바꾸지 않는다. 훅이 `allow`를 반환한 뒤 fire-and-forget으로 게시되고, 실패는 로그만 남는다.
- 같은 명령 + 같은 규칙은 세션당 10분에 한 번만 경고한다.
- C1(데이터 읽기 파이프, Z 2026-11-02 D1-A·D2-A) — **철회**. 처음에는 걸린 규칙이 데이터 읽기 파이프뿐이면 classifier를 건너뛰도록 만들었다. 실제 질문 64건 재생에서 이 방식은 21건을 건너뛰었는데, 그중 7건은 모델이 묻는 명령이었다(토큰을 쓴 `curl -X PUT …/merge`, 리뷰 승인 POST, git config 토큰 추출). 그래서 "원격 조회 | 읽기" 두 단계로 좁혔고, 좁힌 뒤에는 64건 중 0건에 적용됐다. 리뷰 r6–r8에서 이 건너뛰기를 명령 텍스트만으로는 안전하다고 증명할 수 없다는 것이 드러났다. 앞선 Bash 호출이 `.curlrc`(url·request·data·output 덮어쓰기), `GH_HOST`, PATH, NODE_OPTIONS, PYTHONPATH, 작업 폴더의 `json.py`를 심어 두면 "읽기 파이프"가 전송, 파일 쓰기, 코드 실행으로 바뀐다. 리뷰 패널(grok·astra·fable)이 만장일치로 철회를 골랐다. 지금은 위험 규칙에 걸린 모든 호출을 데이터 파이프까지 포함해 classifier가 판단한다. 질문 수 감소는 C2(owner 지시·스킬 위임 인식, 재생 55→14)가 맡는다. 데이터 리더 판정은 경고를 띄울지 고르는 데만 쓴다. 놓쳐도 카드 하나가 안 보일 뿐 실행 여부는 바뀌지 않는다. 이 판정은 허용 어휘 방식이다. 문자열 리터럴을 뺀 모든 식별자가 정해진 어휘(리더 모듈의 속성, 데이터 메서드, 흔한 변수명, 한 글자 이름)에 있어야 한다. `sys`·`process`는 stdio 멤버로만 쓸 수 있고, 모듈 이름은 바로 뒤에 `.`가 붙을 때만 허용한다(값으로 넘기지 못함). `format`, `help`, `input`, `vars`, `Object` 리플렉션, alias, 주석·삼중따옴표·JS `/`·문자열 밖 비ASCII는 리더로 보지 않는다. 경로나 `env`가 붙은 인터프리터도 리더가 아니다.
- 질문 결과(C3): 퍼미션 서버가 질문마다 `Permission prompt outcome` 한 줄을 남긴다(도구, 규칙, allow/deny, 시간 초과 여부, 기다린 시간, AI 권고). 누가 답했는지는 #754의 `permission` 작업 로그 항목에 있다.

### 7.3 Commands

`/z bypass` 카드: Auto 버튼은 모두에게, Bypass 버튼은 admin에게만 보인다. `bypass on`/`set bypass`는 admin이 아니면 거부된다. 대시보드 설정 페이지도 같은 규칙.

### 7.4 Response Messages

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

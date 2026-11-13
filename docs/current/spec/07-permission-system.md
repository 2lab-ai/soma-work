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

### 4.1a Irreversible calls — Approve asks once more

`somalib/permission/irreversible.ts` → `irreversibleAction(toolName, input)` names a call that cannot be undone:
a deploy or publish (`gh pr merge`, `git push` to `deploy/*` or a release tag, `npm|pnpm|yarn|cargo publish`,
`vercel --prod`, `gh release create`, `gh workflow run`, `docker push`, `kubectl apply`, `terraform apply`, a
`deploy*` script) or a destructive command (`rm -r`, force push, `git push --delete`, `git reset --hard`,
`git clean -f`, `git branch -D`, `DROP TABLE` / `TRUNCATE` through a database client, `redis-cli flushall`,
`dd of=`, `mkfs`, `find -delete`). It returns a static label (`PR 머지`, `force push`) or `null`. Matching is
lexical, per shell segment: `\` continuations are joined, a heredoc body is blanked (read as commands only when a
shell or `ssh` reads it), quoted text is blanked except what runs inside double quotes (`$(…)`, backticks) — so a
commit message never reads as a command — a shell's `-c '…'` string is read as its own command, and
`&&` `||` `;` `|` `&` newlines, parentheses, `$(` and backticks split segments; prefixes (`sudo -u x`, `env X=1`,
`timeout 60`, `npx`) are skipped. A `--dry-run` (and `git push -n`) is not irreversible.

- Slack (`buildRequestBlocks`): a context line `⚠️ 되돌릴 수 없는 작업: <label>` under the header, and a
  `confirm` dialog (`style: danger`) on `approve_tool` and `approve_disable_rule_session`. Deny and Explain stay
  one press. A red-advice card gets the line but no dialog: its Approve already asks a second time.
- Dashboard (`permission-prompts.ts` → `irreversible` on the board's prompt → `acPermissionData` →
  `data.irreversible`): `<ui-approval-card>` (@2lab.ai/ui ≥ 0.35) replaces Approve with a slide and ⌘↵ no longer
  approves.

It runs while a prompt is raised (permission MCP server) and in the dashboard's 1 s poller, so it reads at most the
first 64 KiB in one linear pass (heredocs and `sh -c` strings: at most 16 per level, 16 heredoc operators tried,
depth ≤ 3) and never throws: any
failure means no label, i.e. the plain Approve button.

**Presentation only.** The classifier is read only where a prompt is already being shown. It is not part of
`evaluateToolPolicy`, raises no prompt and denies nothing: bypass mode, a grant, or a user who told the agent to
deploy run exactly as before.

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

## 6a. Secret Store and Approval Records — every model, every mode

`evaluateToolPolicy` 1b단계(`devops-secret`)는 어드민을 포함한 모든 사용자, 모든 권한 모드에서 다음을 거부한다
(`.prd/25-env-access-architecture.md` §1·§2, WU1).

| 대상 | 거부 | 이유 |
|---|---|---|
| 비밀 저장소 `SECRETS_DIR` (`<config dir>/secrets`) | Bash 문자열에 경로가 보일 때 · Read · Edit · Write · 그 안을 가리키는 Grep·Glob · 그 위 디렉터리를 훑는 Grep·Glob(와일드카드) | `devops-secret: secret store path` |
| 승인·grant 기록 (`DATA_DIR`의 `env-skill-grants.json` · `mcp-tool-grants.json` · `skill-perm-requests.json` · `admin-requests.json` · `cron-run-requests.json` · `instruction-approvals.json`, `DATA_DIR/<owner>/skill-grants.json`, 각 기록 옆의 `.bak`·임시 파일 — 기록이 깨지면 `.bak`을 읽으므로 위조된 백업은 위조된 기록이다) | Read · Edit · Write | `devops-secret: approval record` |

- 판단은 `src/agent-runtime/policy/devops-secret-guard.ts`. `checkDevopsSecretForTool`이 도구마다 부르는 호출 모양은 그대로라
  Lean ToolPolicy 모델(`devopsSecret` 기본값)은 바뀌지 않는다.
- 경로는 SDK가 여는 방식대로 읽는다: 앞뒤 공백, `~`, NFC, 대소문자, `.`·`..`, 심볼릭 링크(없는 파일은 가장 깊은 기존
  조상까지). Bash는 `/`가 든 낱말마다 같은 방식(`$HOME` 포함)으로 본다. 절대 Glob 패턴은 `path`와 상관없이 패턴만으로도
  보고, `{a,b}`는 펼쳐서 본다(256개를 넘으면 거부). 상대 경로는 `..`로 올라간 뒤 저장소의 마지막 두 이름이 보일 때만
  잡는다 — 그 밖의 상대 경로와 `cd` 뒤의 Bash는 CLI 거부 규칙(`settings.permissions.deny`)과 샌드박스가 막는다.
- 거부 문구는 이유를 따른다: 비밀 저장소, 승인 기록, 그 밖(GitHub·키체인 자격, 브로커 파일) 셋.
- 샌드박스(`build-stream-options.ts`)는 모든 모델 세션에 같은 경로를 OS 수준으로 건다: `denyRead: [SECRETS_DIR, …자격 파일]`,
  `denyWrite: [SECRETS_DIR, …승인 기록]`, `failIfUnavailable: true`(샌드박스가 뜨지 못하면 명령을 실행하지 않는다.
  예외는 `.env`의 `SOMA_SANDBOX_ALLOW_UNAVAILABLE=true` — `src/config.ts` `getSandboxAllowUnavailable`).

### 6a-2. 어드민도 샌드박스 안 (env-access WU2, #1210)

| 무엇 | 어떻게 | 위치 |
|---|---|---|
| 어드민 세션 | 항상 샌드박스. 어드민 프로필 = 모든 도메인(`WebFetch(domain:*)` 허용 규칙) · `localhost`/`127.0.0.1` · 로컬 바인딩 · gh TLS(`enableWeakerNetworkIsolation`) · 임시 디렉터리 쓰기. 홈의 캐시는 쓰지 않는다(봇이 `npx -y`로 띄우는 MCP 코드가 npm 캐시에 있다). 캐시를 env로 옮기지도 않는다 — CLI env는 stdio MCP 자식이 물려받는다. 샌드박스 안 설치는 그 명령에만 캐시를 지정(`npm install --cache /tmp/{uid}/npm`, pnpm `--store-dir`, `PIP_CACHE_DIR`, `UV_CACHE_DIR`, `GOCACHE`) | `src/sandbox/admin-sandbox-profile.ts` `adminSandboxProfile` |
| 어드민 네이티브 쓰기 | 3b(쓰기 경계)가 어드민에게도 걸린다: 샌드박스 Bash와 같은 뿌리(작업 디렉터리 · `/tmp/{uid}` · 임시 디렉터리) 밖의 Write·Edit·NotebookEdit는 거부. PATH의 실행 파일(봇 유저 소유 `/opt/homebrew` 등)을 덮어 샌드박스 밖 실행을 얻는 길을 막는다 | `tool-policy.ts` 3b `else if` · Lean `adminNativeWriteGuard` |
| `sandbox off` | 호스트 운영자가 `.env`에 `SOMA_SANDBOX_OFF_ALLOWED=true`를 둔 호스트의 어드민에게만 효과. 그 밖에는 명령이 거부 이유를 답하고 세션은 샌드박스로 돈다(로그 경고) | `getSandboxOffAllowed` · `isSandboxOffInEffect` · `sandbox-handler.ts` · `sandbox-topic.ts` |
| 쓰기 보호(모든 세션, 샌드박스 켜짐·꺼짐 모두) | `Edit` 거부 규칙: 설정 디렉터리 · 실행 코드 루트 · 봇의 cwd · `DATA_DIR` · plugins 전체(각 경로의 링크·실경로 둘 다, 작업 디렉터리가 그 안이어도 예외 없음), 홈의 시작·신뢰 파일(LaunchAgents · 셸 rc · `.ssh` · git·CLI 설정, 홈의 두 표기 모두). CLI가 샌드박스 `denyWrite`에도 합친다 | `protectedWriteDenyRules` |
| 자격 파일 읽기(모든 세션) | `.ssh` · `.config/gh` · `.config/gcloud` · `.aws` · `.azure` · `.kube` · `.docker/config.json` · `.netrc` · `.git-credentials` · `.gnupg` — 샌드박스 `denyRead` + `Read` 거부 규칙. 봇 자신의 GitHub App 토큰(`~/.gitconfig`의 `url.…insteadOf`, `$DATA_DIR/gh/hosts.yml`)은 git push·gh가 쓰므로 일부러 열어 둔다(한 시간짜리 봇 토큰) | `credentialPaths` · `credentialReadDenyRules` |
| 프로젝트 설정 읽는 곳(모든 세션, #1242) | `settingSources: ['project']`인 메인 세션은 `projectConfigRoot`를 `DATA_DIR/session-project-config`(빈 디렉터리)로 둔다. CLI는 프로젝트 설정(훅·권한)·프로젝트 MCP 설정(`.mcp.json`, 위 디렉터리까지)·`.claude` 설정 트리를 거기서 읽고, 작업 디렉터리에서는 읽지 않는다 — 둘 다 그 안의 명령을 CLI가 샌드박스 밖에서 돌리는데 작업 디렉터리는 모델이 쓰기 때문. CLAUDE.md·계획 파일·작업 디렉터리 자체는 그대로(실측 2.1.321). 루트가 비어 있는 실제 디렉터리가 아니거나, 세션이 쓰는 디렉터리(작업 디렉터리 · `/tmp/{uid}` · 어드민 임시 디렉터리) 안에 있거나, 그 위 디렉터리 어디에 `.mcp.json`이 있으면 세션을 시작하지 않는다 — CLI가 루트 위로도 `.mcp.json`을 찾기 때문(astra R2). `DATA_DIR`은 어떤 모델도 쓰지 못한다(보호 루트). 한 번에 읽는 것이라 가드·경합이 없다. one-shot 호출(`settingSources: []`)은 둘 다 읽지 않는다(실측). CLI를 올릴 때마다 `scripts/verification/probe-cli-project-config-root.mjs` | `src/sandbox/project-config-root.ts` |
| ssh | 2단계 ssh 금지가 어드민 블록을 떠나 모든 사용자에게(`ssh-ban: ssh command`, 문구는 `ssh_exec` 안내). 호스트 명령은 server-tools `ssh_exec`(샌드박스 밖, 봇의 키) — 비어드민은 4단계가 항상 거부 | `tool-policy.ts` · `server-tools-mcp-server.ts` `handleSshExec` |
| 환경 사용자의 PR 작업(#1211) | server-tools `gh_pr`: 환경 절의 `envUser`(예 `env:<org>-dev2`)로, 그 환경의 `github.token`(`$secret`, 어떤 모델도 읽지 않음)으로 PR을 본다·승인한다·머지한다. 승인은 `approveWhen`, 머지는 `mergeWhen`(작성자·base·체크가 하나 이상 보고됐고 전부 초록)일 때만, 둘 다 호출자가 `view`로 본 head SHA에 고정. 승인 뒤 head·base가 바뀌었으면 그 승인을 철회하고, 머지 직전에 head·base를 다시 읽는다(마지막 순간의 base 변경은 저장소 브랜치 규칙이 막는다 — 24 §6). 토큰은 `$secret` 참조만(config.json 평문 토큰은 버림). 요청자가 없는 세션의 쓰기는 거부. 쓰기는 실행 전에 `DATA_DIR/env-audit/env-audit.jsonl`에 의도를 남기고 결과를 다시 남긴다 — 의도를 못 쓰면 실행하지 않고, 결과만 못 쓰면 "실행됐음, 다시 하지 말 것"이라고 답한다. 비어드민은 4단계가 항상 거부(환경 grant는 WU4 #1212) | `server-tools-mcp-server.ts` `handleGhPr` · `env-github.ts` · `env-audit.ts` · `build-stream-options.ts` `ADMIN_ONLY_SERVER_TOOLS` |
| 환경 계정 로그인(#1211 WU3b) | server-tools `login`: 환경 절의 `web.logins.<이름>`(`url` https만 · `format` `json`(기본)·`form` · `body`, 비밀번호는 `$secret` · `token` `json:<경로>`(2xx) 또는 `cookie:<이름>`(2xx, 또는 `successRedirect` 경로로 가는 3xx — 같은 호스트만), 마지막 `Set-Cookie`가 이기고 지우는 쿠키는 세션이 아니다. `body`에 `$secret`이 없는 로그인은 빠진다)으로 환경 웹앱에 로그인하고 세션만 돌려준다 — 비밀번호는 server-tools가 샌드박스 밖에서 읽고 어떤 모델도 보지 않는다. 거절된 로그인은 호스트와 상태 코드만 말한다(응답 본문은 보낸 값을 되울릴 수 있다). 리다이렉트는 따라가지 않는다. 원장에 의도 → `done`(`kind`)/`failed`를 세션·비밀번호 없이 남기고, 의도를 못 쓰면 보내지 않고, `done`을 못 쓰면 세션을 내주지 않는다. 요청자 없는 세션은 거부. 비어드민은 환경 서버에서 그 환경 허용으로만(WU4), 그 밖은 어드민 전용 | `server-tools-mcp-server.ts` `handleLogin` · `env-login.ts` · `build-stream-options.ts` `ADMIN_ONLY_SERVER_TOOLS` |
| 환경 저장소 읽기(#1213 WU5) | server-tools `gh_read`: 환경의 `github.token`으로 `repos/<owner>/<name>/…` 한 경로를 GET만 한다 — 저장소가 `github.repos`에 있고, 경로가 배포 확인·QA가 읽는 경로 모양 허용 목록(`pulls/<n>/files` · `commits/<sha>/check-runs` · `compare/…` · `issues/<n>/comments` · `branches/<b>` · `contents/…` · `actions/runs/<id>/jobs` …)에 맞을 때만. 설정(`branches/<b>/protection`)·secrets·variables·hooks·keys·environments·collaborators, 다른 저장소의 내용을 돌려주는 경로(`issues/<n>/parent`·`sub_issues`·timeline)는 읽지 않는다(토큰이 org 어드민 것일 수 있다). 204는 빈 답. 점 세그먼트·인코딩된 점·`?`는 거부, 20만 자 넘는 답은 잘라서 `truncated`. 쓰기가 없어 원장에 남기지 않는다. QA 스킬은 프로필에 `github.server`가 있으면 이것으로 읽고(없으면 어드민 세션 샌드박스의 `gh` — 다른 세션은 `missing: github`), `qaEnv.logins`가 있으면 `login`으로 세션을 받는다. 비어드민은 환경 서버에서 그 환경 허용으로만 | `server-tools-mcp-server.ts` `handleGhRead` · `env-github.ts` `repoRead`·`repoReadPath` · `build-stream-options.ts` `ADMIN_ONLY_SERVER_TOOLS` |
| 환경 Cloudflare 호출(#1214 WU6) | server-tools `cf_api`: 환경 절 `cloudflare`의 범위 한정 토큰(`$secret`, 어떤 모델도 읽지 않음)으로 그 환경의 존(`/zones/<32-hex id>/…`)만 부른다. 토큰·member·user 경로는 범위와 상관없이 못 간다. 존 아래는 기본 부분(`dns_records`·`settings`·`purge_cache`·`rulesets` …)과 운영자가 `cloudflare.parts`에 적은 것만(logpush처럼 다른 시스템 자격이 담길 수 있는 곳은 명시해야), 존 자체는 읽기만(삭제·일시정지·플랜 변경 금지). `GET`은 그대로, 쓰기(`POST`·`PUT`·`PATCH`·`DELETE`)는 `write: true` + 요청자 + 원장 의도(존·경로·쿼리·본문 SHA-256) → `done`/`failed`(2xx라도 `success: false`면 `failed`, 답이 없거나 본문을 못 읽거나 5xx면 `unknown`, 다시 하기 전에 확인). 오류는 상태·`errors[]`만, 토큰은 지운다. config.json 평문 토큰은 절째 버린다. 옛 브로커의 임대(forge 키로 단기 토큰 발급 + Slack 카드, #1214에서 제거)를 대신한다 — 승인은 환경 허용(또는 어드민) | `server-tools-mcp-server.ts` `handleCfApi` · `env-cloudflare.ts` · `build-stream-options.ts` `ADMIN_ONLY_SERVER_TOOLS` |
| Lean | `evaluateToolPolicySsh`(`Model.lean`), `ProofsSsh.lean` — 1b는 결정이 그대로이고 문구만 이유를 따름, ssh 금지는 어드민·사고 세션까지, 어드민 네이티브 쓰기 경계, 셋 다 해당 없으면 `evaluateToolPolicyMcp`와 같음 | `verification/lean/SomaVerify/ToolPolicy/` |

CLI 순서 가정: 쓰기 보호와 자격 파일 읽기 금지는 CLI 거부 규칙이다. 정책 훅은 auto·bypass 모드의 네이티브 도구에
`allow`를 돌려준다. 그래도 두 규칙이 지켜지는 것은 CLI가 훅의 `allow`와 상관없이 거부된 경로를 막기 때문이다.
CLI 2.1.321에서 실측했다(`settingSources: ['project']`, `bypassPermissions`, 훅은 항상 `allow`).
- 거부된 파일의 Read: 절대 경로, 상대 경로 모두 실패
- 거부된 디렉터리의 Write와 기존 파일 Edit: 실패
- 같은 디렉터리를 가리키는 심볼릭 링크를 거친 Write: 실패
- NotebookEdit: 실패
- Grep·Glob: 그 파일을 결과에서 뺀다
- 허용된 Read: 성공하고 훅에 닿는다

SDK·CLI 버전을 올릴 때마다 `node scripts/verification/probe-cli-deny-before-hooks.mjs`를 다시 돌린다. 이 스크립트는 단계마다 도구 호출을 따로 맞춰 보고 결과 전체와 디스크를 확인한다. 보호 단계는 CLI의 권한 거부 문구가 나와야 증명으로 친다. 종료 코드: 0 = 유지, 1 = 뚫림, 2 = 판정 불가(빠졌거나 다른 이유로 실패한 단계가 있음).

남는 길: 운영자가 `SOMA_SANDBOX_OFF_ALLOWED=true`로 연 호스트의 어드민 `sandbox off` 세션 — OS 규칙이 없고 CLI 거부 규칙과
정책 1b만 남는다.
- 설정은 비밀을 `{"$secret": "<name>"}`으로 가리킨다. 해석은 `@soma/process-shared/secret-ref`(이름 검증, 저장소 밖 링크 거부,
  없거나 빈 파일 = 오류). server-tools는 봇이 넘기는 `SOMA_SECRETS_DIR`로 해석하고, 풀리지 않는 서버는 뺀다.

## 6b. Environment Skill Admin Approval

환경 플러그인(배포가 `config.json` `plugin.envPlugins`에 표시한 플러그인)의 스킬은 어드민(`ADMIN_USERS`)만 바로
실행하고, 그 밖의 사용자는 어드민의 허용이 있어야 실행한다. 다른 사용자의 개인 스킬에 소유자 허용을 받는 흐름
(`skill_perm_`)을 그대로 따르고, 승인자만 어드민으로 바뀐다. 운영 설명은 `docs/runbook/add-new-deploy.md` §8.5.

| 부분 | 위치 |
|---|---|
| 환경 스킬 판정 (`plugin:skill` / 맨이름) | `src/env-skill-registry.ts` (`resolveEnvSkillKey`, `checkEnvSkillPermission`) |
| 결정 — 모델의 `Skill` 호출·플러그인 파일 읽기 | `evaluateToolPolicy` 6b단계 (`agent-runtime/policy/tool-policy.ts`, `ENV_GATED_TOOLS`), Lean 모델 phase 4 (`verification/lean/SomaVerify/ToolPolicy/ProofsEnvSkill.lean`) |
| 결정 — 환경 플러그인의 MCP 도구 | `evaluateToolPolicy` 6d단계 (`PLUGIN_MCP_TOOL_PREFIX`, `ctx.checkEnvPluginMcpPermission` → `checkEnvPluginMcpAccess`), Lean `evaluateToolPolicyMcp` (`ProofsEnvMcp.lean`) |
| 결정 — `$plugin:skill` | `SkillForceHandler.resolveSkill` (중첩 참조 포함, 같은 판정 함수) |
| 집행 — 어드민 요청 | `build-stream-options.ts` 훅의 `onEnvSkillDenied` → `slack/env-skill-permission-request.ts` (어드민 DM, 실패 시 스레드) |
| 허용 저장 | `user-skill-grants-store.ts`, 예약 소유자 `env-skills` → `DATA_DIR/env-skill-grants.json` + 스레드 허용(메모리, 12h) |
| 요청 저장 | `skill-permission-request-store.ts` (소유자 `env-skills`, 스레드별 중복 제거, 어드민 DM 위치 기록) |
| 어드민 답 | `slack/actions/env-skill-permission-action-handler.ts` (`env_skill_perm_*`: 수락/거절/이 스킬 항상/이 환경 전체 항상, WU4 전 카드의 "모든 환경 스킬") |
| 환경 (WU4, #1212) | `env-users.ts` — `server-tools` 절의 `envUser` + `skills`. 환경 허용은 `perEnvironment`(`grantEnvironment`) |
| 환경 서버 도구 (WU4) | `build-stream-options.ts` 4단계 콜백 → `checkEnvironmentToolAccess`: `server`가 환경 서버면 그 환경 허용(`isEnvironmentToolUseAllowed`)으로만 열고 닫는다 — 어드민 전용 도구(`ssh_exec`·`gh_pr`·`login`·`gh_read`·`cf_api`)도 허용이 있으면 열린다 |

- 결정은 하나: 어드민이 아니고, 도구가 `ENV_GATED_TOOLS`(`Skill`·`Read`·`Glob`·`Grep`·`Bash`·`Write`·`Edit`·`NotebookEdit`) 중 하나이고,
  `ctx.checkEnvSkillPermission(toolName, input)`(→ `checkEnvSkillAccess`)이 이유를 돌려주면 거부한다. 이유는
  `env-skill: <plugin:skill>`(스킬 하나 — 어드민에게 묻는다), `env-skill: <plugin>`(스킬이 아닌 플러그인 파일 — 묻지
  않는다), `env-skill: (no skill name)`(이름 없는 `Skill` 호출 — fail-closed)이고, 모델에게는 `ENV_SKILL_DENY_MESSAGE`가
  간다. 인시던트 세션은 그 위의 인시던트 단계에서 모든 호출이 결정되므로 6b에 닿지 않는다. 6b는 모드 단계보다 앞이라
  Bash·네이티브 도구의 allow도 덮는다. 쓰기 도구는 허용과 무관하게 플러그인 파일을 고칠 수 없다. 플러그인 매니저가
  없으면 판정 목록은 `config.json`의 `plugin.envPlugins`에서 읽는다.
- 6d: SDK는 모든 세션에 모든 플러그인의 MCP 서버를 띄우고 그 도구를 `mcp__plugin_<plugin>_<server>__<tool>`로
  부른다(플러그인 이름 그대로). 어드민이 아니고, 이름이 `mcp__plugin_`로 시작하고, `checkEnvPluginMcpAccess`가 이유(플러그인
  이름)를 돌려주면 `env-plugin-mcp: <plugin> (<toolName>)`로 거부하고 모델에게 `ENV_PLUGIN_MCP_DENY_MESSAGE`가 간다.
  그 플러그인의 스킬 하나라도 허용(전체 허용, 항상 허용, 이 스레드의 1회 허용 — `isEnvPluginUseAllowed`)이 있거나, 그
  플러그인 스킬을 가진 환경의 전체 허용이 있으면 연다.
  도구 자체로는 어드민에게 묻지 않는다(사유 접두어가 `env-skill: `가 아니다) — 스킬 호출이 묻는다. 이름의 `_`는 플러그인
  이름에도 들어갈 수 있어, 맞을 수 있는 환경 플러그인 모두의 허용을 요구한다(fail-closed). 레지스트리가 없으면 목록은
  `config.json`에서 읽는다.
- 훅 매처: SDK(Claude Code v2.1.195부터)는 `[A-Za-z0-9_|]`만으로 된 매처를 정확한 도구 이름 목록으로 비교하므로
  `TOOL_POLICY_MATCHERS`의 MCP 항목은 정규식 `^mcp__`다(맨 `mcp__`는 어떤 도구에도 맞지 않는다).
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

- 거부: 연구 도구 허용 목록(`PLAN_RESEARCH_TOOLS`) 밖의 모든 도구(쓰기 도구·서브에이전트·`Workflow`·`Monitor`·SDK가 새로 낼 도구 포함 —
  계획 턴의 훅은 catch-all), **셸(Bash) 전부**, 정확한 읽기 목록(`PLAN_READ_MCP_TOOLS`) 밖의 MCP 도구 — 이름이 읽기처럼 보여도(`redis_query`) 거부.
  셸을 통째로 막는 이유: 리뷰 4라운드 동안 "읽기 전용" 명령 분류기마다 우회로가 나왔다(따옴표 `-de'lete'`, 옵션 묶음 `sort -ro`, git 옵션 줄임말,
  `rg --hostname-bin`, zsh `printf '%n' 'a[$(…)]'`, `printf -v PATH`, 심볼릭 링크 너머 clone, `gh … --web=true`). 회귀 테스트로 남겼다.
- 통과: `Read`·`Glob`·`Grep`·`WebFetch`·`WebSearch`·`Skill`·할 일 도구, `mcp__plan__plan_submit`(계획 제출), github·filesystem 읽기 MCP와
  `mcp__model-command__list`(정확한 이름). clone·빌드·테스트가 필요하면 계획의 첫 단계로 넣는다.
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

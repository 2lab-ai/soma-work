import * as fs from 'node:fs';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T12 (#599 ⑤b, A0) — a Slack-less task's tool call that needs approval waits
 * for its owner's dashboard answer, end to end through the real pieces:
 *
 *   the task turn's PreToolUse policy hook (`buildStreamOptions`)
 *   → the dashboard approver (`createTaskApprover`) → the shared approval file store
 *   → the dashboard index and card → the requester-only route
 *   → `answerPermissionPrompt` (claim tombstone) → back to the waiting hook.
 *
 * Only the SDK is absent: the test calls the hook the SDK would call.
 * - approve → the call is allowed;
 * - deny → the call is denied, with the answer as the reason;
 * - the turn that raised it ends (the process dies, a restart reconciles the
 *   task) → the prompt leaves the card, an answer to it is refused, and the
 *   hook denies: nothing runs.
 */

const mockConfig = {
  conversation: {
    summaryModel: 'claude-haiku-4-20250414',
    viewerHost: '127.0.0.1',
    viewerPort: 0,
    viewerUrl: '',
    viewerToken: 'test-token',
  },
  oauth: {
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    jwtSecret: '',
    jwtExpiresIn: 604800,
  },
};

vi.mock('../../config', async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  return { ...actual, config: { ...actual.config, ...mockConfig } };
});
vi.mock('../../admin-utils', () => ({ isAdminUser: () => false }));
vi.mock('../../conversation/recorder', () => ({
  listConversations: vi.fn().mockResolvedValue([]),
  getConversation: vi.fn().mockResolvedValue(null),
  getTurnRawContent: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../conversation/viewer', () => ({
  renderConversationListPage: vi.fn().mockReturnValue('<html></html>'),
  renderConversationViewPage: vi.fn().mockReturnValue('<html></html>'),
}));
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [] }),
}));

const OWNER = 'U0T12OWNER';
const WORK_DIR = `/tmp/${OWNER}/session_t12`;
const TASK_ID = '12121212-3434-4545-8656-787878787878';
const TASK_KEY = `task:${TASK_ID}`;
fs.mkdirSync(WORK_DIR, { recursive: true });
afterAll(() => fs.rmSync(WORK_DIR, { recursive: true, force: true }));

type Hook = (input: unknown, toolUseId?: string, opts?: { signal?: AbortSignal }) => Promise<any>;

// The hook waits on a 500 ms poll of the shared store; the first test also pays
// the first import of the option builder and the web server.
describe('T12 — a task’s tool call that needs approval, answered on the dashboard (#599 ⑤b)', {
  timeout: 30_000,
}, () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let sharedStore: typeof import('somalib/permission/shared-store').sharedStore;
  let task: Record<string, unknown>;
  const ids: string[] = [];

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../../conversation/oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string };
  }

  async function taskCard() {
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: { Authorization: 'Bearer test-token' },
    });
    const b = JSON.parse(res.body).board;
    for (const col of ['working', 'waiting', 'idle', 'closed']) {
      const hit = (b[col] || []).find((c: any) => c.key === TASK_KEY);
      if (hit) return { col, card: hit };
    }
    return null;
  }

  /** The prompt the waiting hook raised, as the owner's board shows it. */
  async function promptOnCard(): Promise<string> {
    // The store is a polled file directory: give a loaded runner time.
    for (const deadline = Date.now() + 20_000; Date.now() < deadline; ) {
      await dashboard.refreshPendingPermissions();
      const id = (await taskCard())?.card.pendingPermissions?.[0]?.approvalId;
      if (id) {
        ids.push(id);
        return id;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('the approval never reached the task card');
  }

  function answer(approvalId: string, decision: string, headers: Record<string, string>) {
    return injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(TASK_KEY)}/permission`,
      headers,
      payload: { approvalId, decision },
    });
  }

  /** The policy hook of the task turn `turnId`, its approver wired as the host wires it. */
  async function taskTurnHook(): Promise<Hook> {
    const { buildStreamOptions } = await import('../../agent-runtime/claude-code/build-stream-options');
    const { executionContextForTask } = await import('../../agent-runtime/execution-context');
    const { createTaskApprover } = await import('../task-approver');
    const ctx = executionContextForTask(task as any);
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { options } = await buildStreamOptions(
      { queryEnv: {}, workingDirectory: ctx.workingDirectory, executionContext: ctx },
      {
        logger,
        getEffectivePluginPaths: () => [],
        buildModelCommandContext: () => undefined,
        mcpConfigBuilder: {
          buildConfig: vi.fn(async () => ({
            permissionMode: 'bypassPermissions',
            userBypass: true,
            somaPermissionMode: 'auto',
            allowDangerouslySkipPermissions: true,
            allowedTools: ['Bash', 'Read'],
          })),
        },
        compactHookBuilder: undefined,
        promptBuilder: { buildSystemPrompt: vi.fn(() => 'PROMPT') },
        sessionRegistry: {
          getSessionKey: vi.fn(() => TASK_KEY),
          isDangerousRuleDisabled: vi.fn(() => false),
          getSession: vi.fn(() => undefined),
          getSessionByKey: vi.fn(() => task),
        },
        checkMcpToolPermission: vi.fn(() => null),
        taskApprover: createTaskApprover({
          store: sharedStore,
          getActiveTurnId: (key) => (key === TASK_KEY ? (task.activeTaskTurnId as string | undefined) : undefined),
        }),
      } as any,
    );
    const entries = (options.hooks?.PreToolUse ?? []) as Array<{ hooks: Hook[] }>;
    return entries[0].hooks[0];
  }

  const escalation = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
    cwd: WORK_DIR,
  };
  const decisionOf = (out: any) => out?.hookSpecificOutput?.permissionDecision;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../../conversation/web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../../conversation/dashboard');
    ({ sharedStore } = await import('somalib/permission/shared-store'));
    const { answerPermissionPrompt } = await import('../../permission-prompt-response');
    await webServer.startWebServer({ listen: false });
    task = {
      sessionId: 'sid-t12',
      taskId: TASK_ID,
      slackless: true,
      ownerId: OWNER,
      ownerName: 'Owner',
      channelId: '',
      workingDirectory: WORK_DIR,
      activityState: 'working',
      activeTaskTurnId: 'turn-t12',
      state: 'MAIN',
      lastActivity: new Date('2026-10-31T00:00:00Z'),
    };
    dashboard.setDashboardSessionAccessor(() => new Map([[TASK_KEY, task]]));
    // As the host wires it (src/index.ts).
    dashboard.setDashboardPermissionAnswerHandler((a: any) => answerPermissionPrompt(a));
  }, 30_000);

  afterEach(async () => {
    for (const id of ids.splice(0)) await sharedStore?.cleanup(id);
    await stopWebServer?.();
  });

  it('approve on the dashboard → the waiting call is allowed; the card shows NEEDS YOU until then', async () => {
    const hook = await taskTurnHook();
    const decided = hook(escalation, 'tu-1', { signal: new AbortController().signal });
    const approvalId = await promptOnCard();
    expect((await taskCard())?.col).toBe('waiting');

    const owner = await signIn(OWNER);
    expect((await answer(approvalId, 'approve', await signIn('U0T12OTHER'))).statusCode).toBe(403);
    expect((await answer(approvalId, 'approve', owner)).statusCode).toBe(200);
    expect(decisionOf(await decided)).toBe('allow');

    await dashboard.refreshPendingPermissions();
    expect((await taskCard())?.card.pendingPermissions).toBeUndefined();
    expect((await answer(approvalId, 'approve', owner)).statusCode).toBe(404);
  });

  it('deny on the dashboard → the waiting call is denied with the answer as its reason', async () => {
    const hook = await taskTurnHook();
    const decided = hook(escalation, 'tu-2', { signal: new AbortController().signal });
    const approvalId = await promptOnCard();
    expect((await answer(approvalId, 'deny', await signIn(OWNER))).statusCode).toBe(200);
    const out = await decided;
    expect(decisionOf(out)).toBe('deny');
    expect(out.hookSpecificOutput.permissionDecisionReason).toMatch(/denied/i);
  });

  it('the turn ends while it waits (process death, restart reconciliation) → off the card, refused, never run', async () => {
    const hook = await taskTurnHook();
    const turn = new AbortController();
    const decided = hook(escalation, 'tu-3', { signal: turn.signal });
    const approvalId = await promptOnCard();

    // The restart's reconciliation records the lost turn and clears it
    // (session-registry load, #598 ④c); the hook died with the process.
    task.activeTaskTurnId = undefined;
    task.activityState = 'idle';
    turn.abort(new Error('process ended'));
    expect(decisionOf(await decided)).toBe('deny');

    await dashboard.refreshPendingPermissions();
    expect((await taskCard())?.card.pendingPermissions).toBeUndefined();
    expect((await answer(approvalId, 'approve', await signIn(OWNER))).statusCode).toBe(404);
  });

  it('a prompt left by a dead process (no waiter, record still on disk) is refused after the restart', async () => {
    const hook = await taskTurnHook();
    void hook(escalation, 'tu-4', { signal: new AbortController().signal }).catch(() => {});
    const approvalId = await promptOnCard();
    // The restart: the old turn is gone; a new turn of the same task runs.
    task.activeTaskTurnId = 'turn-after-restart';
    await dashboard.refreshPendingPermissions();
    expect((await taskCard())?.card.pendingPermissions).toBeUndefined();
    expect((await answer(approvalId, 'approve', await signIn(OWNER))).statusCode).toBe(404);
    expect(await sharedStore.claimPermissionResponse(approvalId)).toBe(true); // nobody answered it
  });
});

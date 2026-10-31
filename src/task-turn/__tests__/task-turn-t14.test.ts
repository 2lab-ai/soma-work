import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T14 (#601 ⑦, A0): the service restarts at the three points a Slack-less task
 * can be caught at, and the task comes back right — restored, or explicitly
 * ended, never re-run, never announced to Slack:
 *
 *   1. right after it was created (never run)      → the same card, idle, no outcome
 *   2. while a turn waits for a tool approval      → the turn `interrupted`; the
 *      prompt left behind is off the card and cannot be answered (no waiter, no run)
 *   3. while a turn runs a tool                    → the turn `interrupted`, not
 *      crash-recovered (no Slack notice, no auto-resume), not re-run
 *   (and a task waiting for a question keeps it, askId and all)
 *
 * "Restart" is what the process leaves on disk: the registry's strict saves
 * (create, a turn's start, a turn's outcome), then a fresh registry that loads
 * the file. The board and the permission route are the real dashboard's.
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
    jwtSecret: 'test-jwt-secret-t14',
    jwtExpiresIn: 604800,
  },
};
vi.mock('../../config', async (importOriginal) => {
  const actual = (await importOriginal()) as { config: Record<string, unknown> };
  return { ...actual, config: { ...actual.config, ...mockConfig } };
});
vi.mock('../../session-archive', () => ({
  getArchiveStore: () => ({ listRecent: () => [], exists: () => false, archive: () => {}, load: () => null }),
}));

const OWNER = 'U0T14OWNER';
const DIR = `/tmp/${OWNER}/session_t14`;

describe('T14 — a Slack-less task across a restart at each of its three points (#601 ⑦)', () => {
  let injectWebServer: any;
  let stopWebServer: any;
  let dashboard: any;
  let SessionRegistry: typeof import('../../session-registry').SessionRegistry;
  let sharedStore: typeof import('somalib/permission/shared-store').sharedStore;
  const approvals: string[] = [];
  /** The registry the process currently runs on — the answer handler reads it, as `src/index.ts` wires it. */
  let live: InstanceType<typeof import('../../session-registry').SessionRegistry> | undefined;

  beforeEach(async () => {
    vi.resetModules();
    const webServer = await import('../../conversation/web-server');
    injectWebServer = webServer.injectWebServer;
    stopWebServer = webServer.stopWebServer;
    dashboard = await import('../../conversation/dashboard');
    ({ SessionRegistry } = await import('../../session-registry'));
    ({ sharedStore } = await import('somalib/permission/shared-store'));
    const { answerPermissionPrompt } = await import('../../permission-prompt-response');
    // As production wires it (src/index.ts): the answer sees the live registry, so the
    // turn check after the claim runs too (grok #642 R1).
    dashboard.setDashboardPermissionAnswerHandler((a: any) =>
      answerPermissionPrompt({ ...a, sessions: live as never }),
    );
    await webServer.startWebServer({ listen: false });
  }, 60_000);

  afterEach(async () => {
    for (const id of approvals.splice(0)) await sharedStore?.cleanup(id);
    await stopWebServer?.();
  });

  async function card(key: string) {
    await dashboard.refreshPendingPermissions();
    const res = await injectWebServer({
      method: 'GET',
      url: '/api/dashboard/sessions',
      headers: { Authorization: 'Bearer test-token' },
    });
    const b = JSON.parse(res.body).board;
    for (const col of ['working', 'waiting', 'idle', 'closed']) {
      const hit = (b[col] || []).find((c: any) => c.key === key);
      if (hit) return { col, card: hit };
    }
    return null;
  }

  async function signIn(slackUserId: string) {
    const { issueSlackToken } = await import('../../conversation/oauth');
    const token = issueSlackToken({ slackUserId, email: `${slackUserId}@slack.local`, name: slackUserId });
    const sso = await injectWebServer({ method: 'GET', url: `/auth/sso?token=${encodeURIComponent(token)}` });
    const cookie = String(sso.headers['set-cookie']).split(';')[0];
    const me = JSON.parse((await injectWebServer({ method: 'GET', url: '/auth/me', headers: { cookie } })).body);
    return { cookie, 'x-csrf-token': me.csrfToken as string, 'content-type': 'application/json' };
  }

  /** The process ends here: a fresh registry loads what the old one saved, and the board reads it. */
  function restart() {
    const reloaded = new SessionRegistry();
    reloaded.loadSessions();
    live = reloaded;
    dashboard.setDashboardSessionAccessor(() => reloaded.getAllSessions());
    return reloaded;
  }

  it('1 — right after it was created (never run): the same card, idle, nothing recorded, nothing run', async () => {
    const before = new SessionRegistry();
    const task = before.createTask({ ownerId: OWNER, ownerName: 'T14', workingDirectory: DIR, title: 'created' });
    const key = `task:${task.taskId}`;
    const after = restart();
    const hit = await card(key);
    expect(hit?.col).toBe('idle');
    expect(hit?.card).toMatchObject({ slackless: true, title: 'created' });
    expect(hit?.card.lastTurnOutcome).toBeUndefined();
    expect(after.getSessionByKey(key)?.taskId).toBe(task.taskId);
    expect(after.getCrashRecoveredSessions().some((s) => s.sessionKey === key)).toBe(false);
  });

  it('2 — while a turn waits for a tool approval: interrupted; the prompt left behind is off the card and unanswerable', async () => {
    const before = new SessionRegistry();
    const task = before.createTask({ ownerId: OWNER, ownerName: 'T14', workingDirectory: DIR, title: 'approval' });
    const key = `task:${task.taskId}`;
    before.beginTaskTurn(key, 'turn-approval'); // strict save: working + the turn
    // What the task approver wrote for that turn's hook (#599 ⑤b).
    const approvalId = `approval_t14_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    approvals.push(approvalId);
    await sharedStore.storePendingApproval(approvalId, {
      kind: 'tool_permission',
      tool_name: 'Bash',
      input: { command: 'rm -rf build' },
      user: OWNER,
      task_key: key,
      turn_id: 'turn-approval',
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    } as never);
    live = before;
    dashboard.setDashboardSessionAccessor(() => before.getAllSessions());
    expect((await card(key))?.card.pendingPermissions).toHaveLength(1); // before: it was asking

    const after = restart(); // the hook — the only waiter — died with the process
    const s = after.getSessionByKey(key);
    expect(s?.lastTurnOutcome).toMatchObject({ turnId: 'turn-approval', outcome: 'interrupted' });
    expect(s?.activityState).toBe('idle');
    const hit = await card(key);
    expect(hit?.col).toBe('idle');
    expect(hit?.card.pendingPermissions).toBeUndefined();
    // Refused before anything is claimed or answered — a claimed-then-refused prompt could
    // never be answered again (grok #642 R1). Watched, not probed: a probe would take the claim.
    const claim = vi.spyOn(sharedStore, 'claimPermissionResponse');
    const respond = vi.spyOn(sharedStore, 'storePermissionResponse');
    const answer = await injectWebServer({
      method: 'POST',
      url: `/api/dashboard/session/${encodeURIComponent(key)}/permission`,
      headers: await signIn(OWNER),
      payload: { approvalId, decision: 'approve' },
    });
    expect(answer.statusCode).toBe(404);
    expect(claim).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    claim.mockRestore();
    respond.mockRestore();
    expect(await sharedStore.getPendingApproval(approvalId)).not.toBeNull(); // left to expire, untouched
    expect(after.getCrashRecoveredSessions().some((r) => r.sessionKey === key)).toBe(false);
  });

  it('3 — while a turn runs a tool: interrupted, not crash-recovered (no Slack notice, no auto-resume), not re-run', async () => {
    const before = new SessionRegistry();
    const task = before.createTask({ ownerId: OWNER, ownerName: 'T14', workingDirectory: DIR, title: 'running' });
    const key = `task:${task.taskId}`;
    before.beginTaskTurn(key, 'turn-tool');

    const after = restart();
    const s = after.getSessionByKey(key);
    expect(s?.lastTurnOutcome).toMatchObject({
      turnId: 'turn-tool',
      outcome: 'interrupted',
      reason: 'process ended before the outcome was recorded',
    });
    expect(s?.activeTaskTurnId).toBeUndefined();
    // The Slack crash-recovery list (restart notice + auto-resume) never holds a task.
    expect(after.getCrashRecoveredSessions().some((r) => r.sessionKey === key)).toBe(false);
    const hit = await card(key);
    expect(hit?.col).toBe('idle');
    expect(hit?.card.lastTurnOutcome).toMatchObject({ outcome: 'interrupted' });

    // A second restart records nothing more: the lost turn is recorded once.
    const again = restart();
    expect(again.getSessionByKey(key)?.lastTurnOutcome).toMatchObject({ turnId: 'turn-tool', outcome: 'interrupted' });
  });

  it('a task waiting for an answer keeps its question across a restart — the askId too', async () => {
    const before = new SessionRegistry();
    const task = before.createTask({ ownerId: OWNER, ownerName: 'T14', workingDirectory: DIR, title: 'question' });
    const key = `task:${task.taskId}`;
    before.beginTaskTurn(key, 'turn-ask');
    const live = before.getSessionByKey(key)!;
    live.actionPanel = {
      ...(live.actionPanel ?? {}),
      waitingForChoice: true,
      pendingQuestion: {
        type: 'user_choice',
        question: 'Which DB?',
        choices: [{ id: 'pg', label: 'Postgres' }],
        askId: 'ask-t14',
        turnId: 'turn-ask',
      },
    } as never;
    before.commitTaskTurnOutcome(
      key,
      { turnId: 'turn-ask', outcome: 'waiting', category: 'UIUserAskQuestion', at: Date.now() } as never,
      'waiting',
    );

    restart();
    const hit = await card(key);
    expect(hit?.col).toBe('waiting');
    expect(hit?.card.pendingQuestion).toMatchObject({ question: 'Which DB?', askId: 'ask-t14' });
    expect(hit?.card.lastTurnOutcome).toMatchObject({ outcome: 'waiting' });
  });
});

/**
 * E2 ⑧ — the Slack entry end to end on the real pieces (.prd/18 §5 ⑧): the
 * session registry (sessions.json), the notification ledger, the notice
 * deliverer and the entry, with only Slack and the turn runner faked.
 *
 *   X1 a mention → one task holding the thread → the thread gets the card link once.
 *   X2 a second mention there → one card-link notice, no second task; the
 *      same mention redelivered → nothing more.
 *   X3 two mentions racing into one thread → one task; the loser is told.
 *      The same mention twice at once → one task, no extra message.
 *   X4 after a restart (registry and ledger loaded from disk) the thread is
 *      still the task's: guarded, and the link is not posted again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-e2-entry-e2e-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));
vi.mock('../conversation/storage', () => ({
  ConversationStorage: class {
    async buildThreadIndex() {
      return new Map();
    }
  },
}));

import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';
import { createSlackTaskEntry, type TaskEntryAllowList } from '../slack/task-entry';
import { createTaskNoticeDeliverer } from '../task-turn/task-notice-deliverer';
import { TaskNotificationLedger } from '../task-turn/task-notification-ledger';

const ALLOW: TaskEntryAllowList = {
  candidate: true,
  dm: false,
  hasSession: false,
  verbatim: false,
  goalOpening: false,
  steer: false,
  inlineDirective: false,
  handled: false,
  continueWithPrompt: false,
  deferredSkillFire: false,
  forceWorkflow: false,
  setGoalObjective: false,
  inlineModel: false,
  inlineNoGoal: false,
  fileCount: 0,
};
const CHANNEL = 'C123';
const ROOT = '1700000000.000100';
const LEDGER = () => path.join(TEST_DATA_DIR, 'task-notification-ledger.json');

/** One process: registry + ledger + deliverer + entry, Slack posts recorded. */
function boot(posts: Array<{ channel: string; threadTs: string; text: string }>) {
  const registry = new SessionRegistry();
  registry.loadSessions();
  const ledger = new TaskNotificationLedger(LEDGER());
  ledger.load();
  let ts = 0;
  const deliverer = createTaskNoticeDeliverer({
    ledger,
    post: async (target, message) => {
      posts.push({ ...target, text: message.text });
      return { ts: `1700000099.${String(++ts).padStart(6, '0')}` };
    },
    readFinal: async () => ({ text: 'done', clipped: false }),
    cardUrl: (ownerId, key) => `https://dash.example/dashboard/${ownerId}?session=${encodeURIComponent(key)}`,
    getTask: (taskId) => {
      const session = registry.getSessionByTaskId(taskId);
      return session ? { session, sessionKey: `task:${taskId}` } : undefined;
    },
    settled: (taskId, id) => registry.pruneTaskNotice(taskId, id),
    isApprovalOpen: () => false,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  registry.setTaskNoticeListener((session, key) => {
    deliverer.enqueue(session, key);
    void deliverer.deliver();
  });
  const launch = vi.fn(async (req: any) => {
    // The launcher's create (folder skipped); the start is the turn runner's — not here.
    await Promise.resolve();
    const session = registry.createTask({
      ownerId: req.ownerId,
      ownerName: req.ownerName,
      workingDirectory: `/work/${req.ownerId}/t${launch.mock.calls.length}`,
      originThread: req.originThread,
      ...(req.inputContext ? { inputContext: req.inputContext } : {}),
    });
    return { status: 200, body: { sessionKey: `task:${session.taskId}`, status: 'running' } };
  });
  const entry = createSlackTaskEntry({
    isEnabled: () => true,
    isDashboardListening: () => true,
    newUserGate: async () => 'pass',
    getUserName: async () => 'Alice',
    canStart: () => null,
    launch,
    getTaskByKey: (key) => registry.getSessionByKey(key),
    getTaskByOriginThread: (c, t) => registry.getTaskByOriginThread(c, t),
    notStarted: (s, k, r) => deliverer.notStarted(s, k, r),
    cardUrl: (ownerId, key) => `https://dash.example/dashboard/${ownerId}?session=${encodeURIComponent(key)}`,
    inputContext: async () => ({ channelName: 'dev' }),
    reactions: { remove: async () => undefined, add: async () => undefined },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { registry, ledger, deliverer, entry, launch };
}

function liveTasks(registry: SessionRegistry) {
  return [...registry.getAllSessions().values()].filter((s) => s.slackless === true);
}

const sayInto = (said: string[]) => async (m: { text: string; thread_ts: string }) => {
  said.push(`${m.thread_ts} ${m.text}`);
  return {};
};

beforeEach(() => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  __resetSessionLifecyclePolicyForTests?.();
});
afterEach(() => fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true }));

describe('E2 ⑧ — the Slack entry end to end (registry · ledger · deliverer · entry)', () => {
  it('X1 / X2 — a mention becomes one task and the thread gets its link once; a second mention is told; a redelivery says nothing', async () => {
    const posts: Array<{ channel: string; threadTs: string; text: string }> = [];
    const said: string[] = [];
    const p = boot(posts);
    const out = await p.entry.run({
      event: { user: 'U1', channel: CHANNEL, ts: ROOT, text: '로그인 버그 고쳐줘' },
      say: sayInto(said),
      allow: ALLOW,
    });
    expect(out).toEqual({ result: 'safe' });
    await p.deliverer.deliver();
    const [task] = liveTasks(p.registry);
    expect(liveTasks(p.registry)).toHaveLength(1);
    expect(task.originThread).toEqual({ channel: CHANNEL, threadTs: ROOT, messageTs: ROOT });
    expect(task.inputContext).toEqual({ channelName: 'dev' });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: CHANNEL, threadTs: ROOT });
    expect(posts[0].text).toContain(`session=${encodeURIComponent(`task:${task.taskId}`)}`);
    expect(said).toEqual([]);

    // A second mention in the thread: one notice, nothing made.
    expect(await p.entry.guard({ channel: CHANNEL, ts: '1700000000.000300', thread_ts: ROOT }, sayInto(said))).toBe(
      true,
    );
    expect(said).toEqual([expect.stringContaining('대시보드 작업에 연결돼 있어요')]);
    // The instruction itself redelivered: silent.
    expect(await p.entry.guard({ channel: CHANNEL, ts: ROOT }, sayInto(said))).toBe(true);
    expect(said).toHaveLength(1);
    expect(liveTasks(p.registry)).toHaveLength(1);
    expect(p.launch).toHaveBeenCalledTimes(1);
    await p.deliverer.stop();
  });

  it('X3 — two mentions racing into one thread make one task; the loser is told. The same mention twice at once: one task, silent', async () => {
    const posts: Array<{ channel: string; threadTs: string; text: string }> = [];
    const said: string[] = [];
    const p = boot(posts);
    const first = { user: 'U1', channel: CHANNEL, ts: '1700000000.000200', thread_ts: ROOT, text: 'A 해줘' };
    const second = { user: 'U1', channel: CHANNEL, ts: '1700000000.000300', thread_ts: ROOT, text: 'B 해줘' };
    const outs = await Promise.all([
      p.entry.run({ event: first, say: sayInto(said), allow: ALLOW }),
      p.entry.run({ event: second, say: sayInto(said), allow: ALLOW }),
    ]);
    expect(outs).toEqual([{ result: 'safe' }, { result: 'safe' }]);
    expect(liveTasks(p.registry)).toHaveLength(1);
    expect(said).toEqual([expect.stringContaining('대시보드 작업에 연결돼 있어요')]);

    const q = boot([]);
    const silent: string[] = [];
    const again = { user: 'U1', channel: 'C999', ts: '1700000001.000100', text: 'C 해줘' };
    await Promise.all([
      q.entry.run({ event: again, say: sayInto(silent), allow: ALLOW }),
      q.entry.run({ event: again, say: sayInto(silent), allow: ALLOW }),
    ]);
    expect(liveTasks(q.registry).filter((s) => s.originThread?.channel === 'C999')).toHaveLength(1);
    expect(silent).toEqual([]);
    await p.deliverer.stop();
    await q.deliverer.stop();
  });

  it('X4 — after a restart the thread is still the task’s: guarded, and its link is not posted again', async () => {
    const posts: Array<{ channel: string; threadTs: string; text: string }> = [];
    const before = boot(posts);
    await before.entry.run({
      event: { user: 'U1', channel: CHANNEL, ts: ROOT, text: '로그인 버그 고쳐줘' },
      say: sayInto([]),
      allow: ALLOW,
    });
    await before.deliverer.deliver();
    expect(posts).toHaveLength(1);
    await before.deliverer.stop();

    // A new process: everything from disk.
    const after = boot(posts);
    for (const [key, session] of after.registry.getAllSessions()) after.deliverer.enqueue(session, key);
    await after.deliverer.deliver({ retryFailed: true });
    expect(posts).toHaveLength(1);
    const said: string[] = [];
    expect(await after.entry.guard({ channel: CHANNEL, ts: '1700000000.000400', thread_ts: ROOT }, sayInto(said))).toBe(
      true,
    );
    expect(said).toEqual([expect.stringContaining('대시보드 작업에 연결돼 있어요')]);
    // A new mention elsewhere still works after the restart.
    await after.entry.run({
      event: { user: 'U1', channel: 'C777', ts: '1700000002.000100', text: '다른 일' },
      say: sayInto(said),
      allow: ALLOW,
    });
    await after.deliverer.deliver();
    expect(liveTasks(after.registry)).toHaveLength(2);
    expect(posts).toHaveLength(2);
    await after.deliverer.stop();
  });
});

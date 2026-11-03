/**
 * #855 — one kind of work session: the Slack-less dashboard task is gone.
 *
 *   A1 a saved dashboard task (`slackless: true`) is archived at load (`terminated`) and not
 *      loaded; the Slack session next to it loads as it was; the file written back no longer
 *      holds the task.
 *   A2 an epic of dashboard tasks and its child are archived together — their relation kept in
 *      the archive (the closed column reads it) — and a second restart archives nothing again.
 *   A3 an archived dashboard task is never brought back into the registry (it has no thread).
 *   A4 a dashboard task archived once and worked on since (revived) is archived again with its
 *      latest state; one not changed since its archive is not archived twice (review #885 astra).
 *   A5 a dashboard task the disk would not archive stays in sessions.json, as it was, and the
 *      next load archives it (review #885 astra).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, emitter } = vi.hoisted(() => {
  const os2 = require('node:os');
  const path2 = require('node:path');
  const ok = () => vi.fn(async () => undefined);
  return {
    TEST_DATA_DIR: path2.join(os2.tmpdir(), `soma-work-dashboard-task-archive-test-${process.pid}`),
    emitter: { emitSessionCreated: ok(), emitSessionSlept: ok(), emitSessionClosed: ok() },
  };
});

vi.mock('../env-paths', () => ({ DATA_DIR: TEST_DATA_DIR }));
vi.mock('../metrics/event-emitter', () => ({ getMetricsEmitter: () => emitter }));

import { getArchiveStore } from '../session-archive';
import { __resetSessionLifecyclePolicyForTests } from '../session-lifecycle-policy';
import { SessionRegistry } from '../session-registry';

const SESSIONS_FILE = path.join(TEST_DATA_DIR, 'sessions.json');
const ARCHIVE_DIR = path.join(TEST_DATA_DIR, 'archives');

const now = () => new Date().toISOString();

function dashboardTask(taskId: string, extra: Record<string, unknown> = {}) {
  return {
    key: `task:${taskId}`,
    ownerId: 'U1',
    ownerName: 'User',
    userId: 'U1',
    channelId: '',
    isActive: true,
    lastActivity: now(),
    workingDirectory: '/tmp/U1/task-dir',
    title: `Dashboard task ${taskId}`,
    state: 'MAIN',
    activityState: 'idle',
    sessionId: `sdk-${taskId}`,
    taskId,
    slackless: true,
    originThread: { channel: 'C9', threadTs: '9.000', messageTs: '9.001' },
    notices: [{ id: `${taskId}:create:link`, kind: 'link', at: 1 }],
    ...extra,
  };
}

const SLACK_RECORD = {
  key: 'C1-100.001',
  ownerId: 'U1',
  ownerName: 'User',
  userId: 'U1',
  channelId: 'C1',
  threadTs: '100.001',
  sessionId: 'sdk-slack',
  isActive: true,
  lastActivity: now(),
  title: 'A Slack thread',
  state: 'MAIN',
  activityState: 'idle',
  taskId: 'slack-task-id',
};

function readSaved(): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
}

function archives(): Array<Record<string, unknown>> {
  if (!fs.existsSync(ARCHIVE_DIR)) return [];
  return fs
    .readdirSync(ARCHIVE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8')));
}

describe('SessionRegistry — dashboard tasks are archived at load (#855)', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    __resetSessionLifecyclePolicyForTests(path.join(TEST_DATA_DIR, 'session-lifecycle.json'));
  });
  afterEach(() => {
    __resetSessionLifecyclePolicyForTests();
    if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true });
  });

  it('A1 — a dashboard task is archived (terminated), not loaded; the Slack session beside it is untouched', () => {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify([dashboardTask('task-a'), SLACK_RECORD]));

    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(1);

    // Not in the registry, by any address.
    expect(reg.getSessionByTaskId('task-a')).toBeUndefined();
    expect(reg.getSessionByKey('task:task-a')).toBeUndefined();
    expect([...reg.getAllSessions().keys()]).toEqual(['work:C1:100.001']);

    // Archived under its old key, as a terminated record the closed column can read.
    expect(getArchiveStore().exists('task:task-a')).toBe(true);
    const [archived] = archives().filter((a) => a.taskId === 'task-a');
    expect(archived).toMatchObject({
      sessionKey: 'task:task-a',
      archiveReason: 'terminated',
      slackless: true,
      ownerId: 'U1',
      title: 'Dashboard task task-a',
      sessionId: 'sdk-task-a',
    });

    // The Slack session loads as it was.
    const slack = reg.getSession('C1', '100.001');
    expect(slack).toMatchObject({
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: '100.001',
      sessionId: 'sdk-slack',
      taskId: 'slack-task-id',
      title: 'A Slack thread',
    });
    expect(reg.getSessionByTaskId('slack-task-id')).toBe(slack);

    // The file written back holds the Slack session only.
    expect(readSaved().map((r) => r.taskId)).toEqual(['slack-task-id']);
  });

  it('A2 — an epic of dashboard tasks and its child are archived with their relation; a restart archives nothing again', () => {
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        dashboardTask('epic-1', { kind: 'epic', childTaskIds: ['child-1'] }),
        dashboardTask('child-1', { parentTaskId: 'epic-1', planNodeId: 'build', activityState: 'working' }),
        SLACK_RECORD,
      ]),
    );

    expect(new SessionRegistry().loadSessions()).toBe(1);
    const saved = archives();
    expect(saved).toHaveLength(2);
    expect(saved.find((a) => a.taskId === 'epic-1')).toMatchObject({ kind: 'epic', childTaskIds: ['child-1'] });
    expect(saved.find((a) => a.taskId === 'child-1')).toMatchObject({ parentTaskId: 'epic-1', planNodeId: 'build' });

    const again = new SessionRegistry();
    expect(again.loadSessions()).toBe(1);
    expect(archives()).toHaveLength(2);
    expect([...again.getAllSessions().keys()]).toEqual(['work:C1:100.001']);
  });

  it('A4 — worked on since its archive: archived again with its latest state; unchanged: not twice', async () => {
    const t0 = new Date(Date.now() - 60_000).toISOString();
    // Archived when it last closed …
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([dashboardTask('task-c', { lastActivity: t0, title: 'old title' })]),
    );
    expect(new SessionRegistry().loadSessions()).toBe(0);
    expect(archives()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 5));
    // … revived and worked on since: the record changed after that archive.
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([
        dashboardTask('task-c', { lastActivity: t0, activityStateChangedAt: Date.now() + 1, title: 'new title' }),
      ]),
    );
    expect(new SessionRegistry().loadSessions()).toBe(0);
    expect(getArchiveStore().latest('task:task-c')).toMatchObject({ title: 'new title', slackless: true });
    expect(archives()).toHaveLength(2);

    // A record no newer than its archive (a crash before the save): not archived twice.
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(
      SESSIONS_FILE,
      JSON.stringify([dashboardTask('task-c', { lastActivity: t0, title: 'old title' })]),
    );
    expect(new SessionRegistry().loadSessions()).toBe(0);
    expect(archives()).toHaveLength(2);
  });

  it('A5 — not archived (the disk said no): kept in sessions.json as it was; the next load archives it', () => {
    const record = dashboardTask('task-d');
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify([record, SLACK_RECORD]));
    // The archive folder cannot be written: a file stands where it should be.
    fs.rmSync(ARCHIVE_DIR, { recursive: true });
    fs.writeFileSync(ARCHIVE_DIR, 'not a folder');
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(1);
    expect(reg.getSessionByTaskId('task-d')).toBeUndefined();
    // Written back verbatim, beside the Slack session — and again on every save until a load archives it.
    expect(readSaved().find((r) => r.taskId === 'task-d')).toEqual(record);
    reg.saveSessions();
    expect(readSaved().find((r) => r.taskId === 'task-d')).toEqual(record);

    fs.rmSync(ARCHIVE_DIR);
    fs.mkdirSync(ARCHIVE_DIR);
    const next = new SessionRegistry();
    expect(next.loadSessions()).toBe(1);
    expect(getArchiveStore().latest('task:task-d')).toMatchObject({ taskId: 'task-d', slackless: true });
    expect(readSaved().map((r) => r.taskId)).toEqual(['slack-task-id']);
  });

  it('A3 — an archived dashboard task is not restored into the registry', () => {
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify([dashboardTask('task-b')]));
    const reg = new SessionRegistry();
    expect(reg.loadSessions()).toBe(0);
    const archived = getArchiveStore().latest('task:task-b');
    expect(archived).not.toBeNull();

    const outcome = reg.restoreArchivedSession(archived!, '/tmp/U1/task-dir');
    expect(outcome.ok).toBe(false);
    expect(reg.getAllSessions().size).toBe(0);
    expect(reg.getSessionByTaskId('task-b')).toBeUndefined();
  });
});

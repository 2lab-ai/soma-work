import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUserTaskQueueHost, replayEvent, resumeEvent, USER_TASK_QUEUE_BOOT_GRACE_MS } from '../host';
import type { UserTaskEntry } from '../ledger';
import type { RunningTask } from '../user-task-queue';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utq-host-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const base: UserTaskEntry = {
  id: 'e1',
  userId: 'U1',
  kind: 'request',
  sessionKey: 'C1:2.0',
  channel: 'C1',
  threadTs: '2.0',
  preview: 'p',
  enqueuedAt: 1,
  state: 'admitted',
  message: {
    user: 'U1',
    channel: 'C1',
    ts: '2.01',
    thread_ts: '2.0',
    text: 'hi',
    routeContext: { skipAutoBotThread: true },
  },
};

describe('the events an entry starts with', () => {
  it('a request is replayed as it arrived, with its admission added', () => {
    expect(replayEvent(base)).toEqual({
      ...base.message,
      routeContext: { skipAutoBotThread: true, userTaskEntryId: 'e1' },
    });
  });

  it('a stopped task gets a host turn, not the person’s words', () => {
    const event = resumeEvent({ ...base, kind: 'resume', message: undefined });
    expect(event).toMatchObject({
      user: 'U1',
      channel: 'C1',
      thread_ts: '2.0',
      synthetic: true,
      routeContext: { hostTurn: true, verbatimPrompt: true, userTaskEntryId: 'e1' },
    });
    expect(String(event.text)).toContain('from the host');
  });
});

function host(over: Partial<Parameters<typeof createUserTaskQueueHost>[0]> = {}) {
  const running = new Map<string, RunningTask[]>();
  const handleMessage = vi.fn().mockResolvedValue(undefined);
  const abort = vi.fn().mockReturnValue(true);
  const h = createUserTaskQueueHost({
    dataDir: dir,
    isAdmin: (u) => u === 'UADMIN',
    runningTasksOf: (u) => running.get(u) ?? [],
    isTaskRunning: () => false,
    sessionAlive: () => true,
    handleMessage,
    makeSay: () => vi.fn(),
    abort,
    slackApi: {
      postMessage: vi.fn().mockResolvedValue({ ts: '9' }),
      updateMessage: vi.fn().mockResolvedValue(undefined),
      getPermalink: vi.fn().mockResolvedValue(null),
    },
    onChange: vi.fn(),
    ...over,
  });
  return { h, running, handleMessage, abort };
}

const gateInput = (sessionKey: string, threadTs: string) => ({
  userId: 'U1',
  sessionKey,
  channel: 'C1',
  threadTs,
  text: 'x',
  message: { user: 'U1', channel: 'C1', ts: `${threadTs}1`, thread_ts: threadTs, text: 'x' },
  continuation: 'none' as const,
  admitted: false,
});

describe('createUserTaskQueueHost', () => {
  it('limits come from the settings file: 1 by default, none for an admin', () => {
    const { h } = host();
    expect(h.limits.limitFor('U1')).toBe(1);
    expect(h.limits.limitFor('UADMIN')).toBe(Number.POSITIVE_INFINITY);
  });

  it('starting an entry replays it through the ingress', () => {
    const { h, running, handleMessage } = host();
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    expect(h.queue.gate(gateInput('C1:2.0', '2.0')).action).toBe('queued');
    running.set('U1', []);
    h.release('U1');
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0].routeContext.userTaskEntryId).toBeTruthy();
  });

  it('먼저 진행 aborts the running turn as user-interrupted', () => {
    const { h, running, abort } = host();
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    const queued = h.queue.gate(gateInput('C1:2.0', '2.0'));
    if (queued.action !== 'queued') throw new Error('expected queued');
    expect(h.queue.bypass(queued.entry.id, 'U1')).toMatchObject({ ok: true });
    expect(abort).toHaveBeenCalledWith('C1:1.0');
  });

  it('the tick waits out the boot grace, then starts what may start', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const { h, running, handleMessage } = host({ now: () => Date.now() });
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    h.queue.gate(gateInput('C1:2.0', '2.0'));
    running.set('U1', []);
    h.start(1_000);
    vi.advanceTimersByTime(5_000);
    expect(handleMessage).not.toHaveBeenCalled();
    vi.setSystemTime(t0 + USER_TASK_QUEUE_BOOT_GRACE_MS + 1);
    vi.advanceTimersByTime(1_000);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    h.stop();
  });

  it('a chain settling releases shortly after', () => {
    vi.useFakeTimers();
    const { h, running, handleMessage } = host();
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    h.queue.gate(gateInput('C1:2.0', '2.0'));
    running.set('U1', []);
    h.scheduleRelease();
    h.scheduleRelease();
    vi.advanceTimersByTime(1_000);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('a stopped task whose session is gone leaves the line', () => {
    const { h, running, handleMessage } = host({ sessionAlive: () => false });
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    const queued = h.queue.gate(gateInput('C1:2.0', '2.0'));
    if (queued.action !== 'queued') throw new Error('expected queued');
    h.queue.bypass(queued.entry.id, 'U1');
    // The one that went first was replayed; the stopped one waits for it.
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(h.queue.takeAdmission(queued.entry.id, 'C1:2.0')).toBe(true);
    running.set('U1', []);
    h.release('U1');
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(h.queue.snapshot().entries).toEqual([]);
  });
  it('먼저 진행 on a turn that is still starting keeps trying to stop it until it lands', () => {
    vi.useFakeTimers();
    let abortable = false;
    const abort = vi.fn(() => abortable);
    const { h, running } = host({ abort, isTaskRunning: () => true, abortRetryMs: 100, abortRetryForMs: 5_000 });
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    const queued = h.queue.gate(gateInput('C1:2.0', '2.0'));
    if (queued.action !== 'queued') throw new Error('expected queued');
    expect(h.queue.bypass(queued.entry.id, 'U1')).toMatchObject({ ok: true });
    // The stopped task is carried on later: its resume entry is in line.
    expect(h.queue.snapshot().entries.some((e) => e.kind === 'resume')).toBe(true);
    vi.advanceTimersByTime(300);
    const tries = abort.mock.calls.length;
    expect(tries).toBeGreaterThan(1);
    abortable = true;
    vi.advanceTimersByTime(100);
    const landed = abort.mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(abort.mock.calls.length).toBe(landed);
  });

  it('a task that already ended is not stopped and not carried on', () => {
    const { h, running } = host({ abort: vi.fn(() => false), isTaskRunning: () => false });
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    const queued = h.queue.gate(gateInput('C1:2.0', '2.0'));
    if (queued.action !== 'queued') throw new Error('expected queued');
    h.queue.bypass(queued.entry.id, 'U1');
    expect(h.queue.snapshot().entries.some((e) => e.kind === 'resume')).toBe(false);
  });

  it('nothing starts while the host shuts down', () => {
    let down = true;
    const { h, running, handleMessage } = host({ isShuttingDown: () => down });
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    h.queue.gate(gateInput('C1:2.0', '2.0'));
    running.set('U1', []);
    h.release('U1');
    expect(handleMessage).not.toHaveBeenCalled();
    down = false;
    h.release('U1');
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});

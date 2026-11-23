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
    isTurnBusy: () => false,
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
    const { h, running, abort } = host({ isTaskRunning: () => true, isTurnBusy: () => true });
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
    const t0 = Date.now();
    const { h, running, handleMessage } = host({ now: () => Date.now() });
    vi.setSystemTime(t0 + USER_TASK_QUEUE_BOOT_GRACE_MS + 1);
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
  it('먼저 진행 on a turn that is still starting keeps trying to stop it; the entry starts only after', () => {
    vi.useFakeTimers();
    let abortable = false;
    let busy = true;
    const abort = vi.fn(() => abortable);
    const { h, running, handleMessage } = host({
      abort,
      isTaskRunning: () => busy,
      isTurnBusy: () => busy,
      abortRetryMs: 100,
      abortRetryForMs: 5_000,
    });
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    const queued = h.queue.gate(gateInput('C1:2.0', '2.0'));
    if (queued.action !== 'queued') throw new Error('expected queued');
    expect(h.queue.bypass(queued.entry.id, 'U1')).toMatchObject({ ok: true, pending: true });
    // Nothing runs beside the task that has not stopped yet.
    expect(handleMessage).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(abort.mock.calls.length).toBeGreaterThan(1);
    abortable = true;
    vi.advanceTimersByTime(100);
    const landed = abort.mock.calls.length;
    vi.advanceTimersByTime(1_000);
    expect(abort.mock.calls.length).toBe(landed);
    // The stopped task carries on later; the entry starts when its slot frees.
    expect(h.queue.snapshot().entries.some((e) => e.kind === 'resume')).toBe(true);
    busy = false;
    running.set('U1', []);
    h.release('U1');
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('a stop that was taken still waits for the turn to unwind: nothing starts while its slot is held', () => {
    vi.useFakeTimers();
    let busy = true;
    const abort = vi.fn(() => true);
    const { h, running, handleMessage } = host({
      abort,
      isTaskRunning: () => busy,
      isTurnBusy: () => busy,
      abortRetryMs: 100,
    });
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    const queued = h.queue.gate(gateInput('C1:2.0', '2.0'));
    if (queued.action !== 'queued') throw new Error('expected queued');
    expect(h.queue.bypass(queued.entry.id, 'U1')).toMatchObject({ ok: true, pending: true });
    expect(abort).toHaveBeenCalledTimes(1);
    // A tool still unwinds: the slot is held, the entry waits.
    vi.advanceTimersByTime(1_000);
    expect(handleMessage).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledTimes(1);
    // The turn settled: the slot frees, the stopped task carries on later, the entry starts.
    busy = false;
    running.set('U1', []);
    vi.advanceTimersByTime(100);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(h.queue.snapshot().entries.some((e) => e.kind === 'resume')).toBe(true);
  });

  it("over the limit (an admin lowered it): the entry still takes the stopped turn's slot when it frees", () => {
    vi.useFakeTimers();
    const busy = new Set(['C1:0.5', 'C1:1.0']);
    const { h, running, handleMessage } = host({
      abort: vi.fn(() => true),
      isTaskRunning: (key: string) => busy.has(key),
      isTurnBusy: (key: string) => busy.has(key),
      abortRetryMs: 100,
    });
    running.set('U1', [
      { sessionKey: 'C1:0.5', channel: 'C1', threadTs: '0.5', startedAt: 100 },
      { sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0', startedAt: 500 },
    ]);
    const queued = h.queue.gate(gateInput('C1:2.0', '2.0'));
    if (queued.action !== 'queued') throw new Error('expected queued');
    expect(h.queue.bypass(queued.entry.id, 'U1')).toMatchObject({ ok: true, pending: true });
    // The newest task took the stop and let go of its slot; the older one still runs.
    busy.delete('C1:1.0');
    running.set('U1', [{ sessionKey: 'C1:0.5', channel: 'C1', threadTs: '0.5', startedAt: 100 }]);
    vi.advanceTimersByTime(100);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(handleMessage.mock.calls[0][0]).toMatchObject({ routeContext: { userTaskEntryId: queued.entry.id } });
  });

  it('a starting turn that ends by itself before the stop lands is not carried on', () => {
    vi.useFakeTimers();
    let busy = true;
    const { h, running } = host({
      abort: vi.fn(() => false),
      isTaskRunning: () => busy,
      isTurnBusy: () => busy,
      abortRetryMs: 100,
    });
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    const queued = h.queue.gate(gateInput('C1:2.0', '2.0'));
    if (queued.action !== 'queued') throw new Error('expected queued');
    h.queue.bypass(queued.entry.id, 'U1');
    busy = false;
    vi.advanceTimersByTime(200);
    expect(h.queue.snapshot().entries.some((e) => e.kind === 'resume')).toBe(false);
  });

  it('between goal turns nothing runs: the stop counts as landed and the entry starts now', () => {
    const abort = vi.fn(() => false);
    const { h, running, handleMessage } = host({
      abort,
      isTaskRunning: () => true,
      isTurnBusy: () => false,
    });
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    const queued = h.queue.gate(gateInput('C1:2.0', '2.0'));
    if (queued.action !== 'queued') throw new Error('expected queued');
    expect(h.queue.bypass(queued.entry.id, 'U1')).toMatchObject({ ok: true, deferred: expect.any(Object) });
    // Nothing runs to stop: the gate holds its next goal turn.
    expect(abort).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(1);
    expect(h.queue.snapshot().entries.some((e) => e.kind === 'resume')).toBe(true);
  });

  it('a settle in the boot grace releases nothing; after it, it does', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const { h, running, handleMessage } = host({ now: () => Date.now() });
    running.set('U1', [{ sessionKey: 'C1:1.0', channel: 'C1', threadTs: '1.0' }]);
    h.queue.gate(gateInput('C1:2.0', '2.0'));
    running.set('U1', []);
    h.scheduleRelease();
    vi.advanceTimersByTime(1_000);
    expect(handleMessage).not.toHaveBeenCalled();
    vi.setSystemTime(t0 + USER_TASK_QUEUE_BOOT_GRACE_MS + 1);
    h.scheduleRelease();
    vi.advanceTimersByTime(1_000);
    expect(handleMessage).toHaveBeenCalledTimes(1);
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

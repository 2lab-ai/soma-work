/**
 * #1020 — the epic host finds its owner's tasks and adopts one as a child.
 *
 *   F1 findTasks: the epic owner's live sessions (not terminated, not trashed), never the epic
 *      itself, newest activity first; each with its task id, display title, state, channel, start,
 *      last activity and whether it can be adopted.
 *   F2 query: every word must appear in the display title, case-insensitive.
 *   F3 day: 'today' or YYYY-MM-DD — a task started or last active that calendar day in the
 *      report timezone.
 *   F4 adoptable, or why not: an epic, already a child (of this epic / of another, by its title),
 *      no task id, closing.
 *   F5 limit: 20 by default, at most 50.
 *   A1 adoptChild: the registry's adopt for the epic's own task id, its answer passed on; nothing
 *      is posted or sent — the task keeps running as it was.
 *   A2 a node whose child is being made right now is refused; a registry throw is `not-saved`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSlackEpicHost } from '../epic-slack';

const NOW = Date.parse('2026-11-06T15:30:00Z'); // Asia/Seoul: 2026-11-07 00:30
const at = (iso: string) => Date.parse(iso);

function session(taskId: string | undefined, extra: Record<string, any> = {}) {
  return {
    taskId,
    ownerId: 'U1',
    channelId: 'C2',
    threadTs: `${taskId}.0`,
    title: `task ${taskId}`,
    activityState: 'idle',
    startedAt: at('2026-11-01T00:00:00Z'),
    lastActivity: new Date(at('2026-11-02T00:00:00Z')),
    ...extra,
  } as any;
}

function world(over: Record<string, any> = {}) {
  const epic: any = {
    taskId: 'e1',
    ownerId: 'U1',
    channelId: 'C1',
    threadTs: '1.0',
    title: '로그인 에픽',
    kind: 'epic',
    startedAt: NOW,
    lastActivity: new Date(NOW),
  };
  const sessions = new Map<string, any>([['C1-1.0', epic]]);
  const add = (s: any) => {
    sessions.set(`${s.channelId}-${s.threadTs}`, s);
    return s;
  };
  const deps: any = {
    getSessionByTaskId: vi.fn((id: string) => [...sessions.values()].find((s) => s.taskId === id)),
    getChildTasks: vi.fn(() => []),
    getAllSessions: vi.fn(() => sessions),
    adoptEpicChild: vi.fn(() => ({ ok: true })),
    setEpicPlan: vi.fn(),
    reserveEpicChild: vi.fn(() => 'child-1'),
    unreserveEpicChild: vi.fn(),
    keyOf: (s: any) => `${s.channelId}-${s.threadTs}`,
    postMessage: vi.fn(async () => ({ ts: '9.9' })),
    onTurnAccepted: vi.fn(() => () => {}),
    handleMessage: vi.fn(async () => {}),
    sendToThread: vi.fn(async () => {}),
    isRunning: vi.fn(() => false),
    readWorkLog: vi.fn(),
    gate: { refusal: vi.fn(() => undefined), record: vi.fn() },
    ensureDirectory: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
    timezone: 'Asia/Seoul',
    now: () => NOW,
    ...over,
  };
  return { epic, sessions, add, deps, host: createSlackEpicHost(deps) };
}

const ids = (items: Array<{ taskId?: string }>) => items.map((i) => i.taskId);

describe('the epic host finds its owner’s tasks (#1020)', () => {
  it('F1 — the owner’s live sessions, not the epic, newest activity first, with the item fields', () => {
    const w = world();
    w.add(
      session('t1', {
        summaryTitle: '결제 버그 고치기',
        title: 'first words',
        activityState: 'working',
        startedAt: at('2026-11-06T01:00:00Z'),
        lastActivity: new Date(at('2026-11-06T02:00:00Z')),
      }),
    );
    w.add(session('t2', { lastActivity: new Date(at('2026-11-06T05:00:00Z')), activityState: 'waiting' }));
    w.add(session('t3', { lastActivity: new Date(at('2026-11-03T00:00:00Z')), startedAt: undefined }));
    w.add(session('other', { ownerId: 'U2', lastActivity: new Date(NOW) }));
    w.add(session('gone', { terminated: true, lastActivity: new Date(NOW) }));
    w.add(session('binned', { trashed: true, lastActivity: new Date(NOW) }));

    const items = w.host.findTasks(w.epic, {});
    expect(ids(items)).toEqual(['t2', 't1', 't3']);
    expect(items[1]).toEqual({
      taskId: 't1',
      // The card's title (displayTitle): the summary wins over the first message's title.
      title: '결제 버그 고치기',
      state: 'working',
      channel: 'C2',
      startedAt: '2026-11-06T01:00:00.000Z',
      lastActivity: '2026-11-06T02:00:00.000Z',
      adoptable: true,
    });
    expect(items[0].state).toBe('waiting');
    expect(items[2]).not.toHaveProperty('startedAt');
    expect(items[2].state).toBe('idle');
  });

  it('F2 — every query word must be in the title, case-insensitive', () => {
    const w = world();
    w.add(session('a', { title: 'Fix Login redirect', lastActivity: new Date(at('2026-11-06T03:00:00Z')) }));
    w.add(session('b', { title: 'login page copy', lastActivity: new Date(at('2026-11-06T02:00:00Z')) }));
    w.add(
      session('c', { summaryTitle: '결제 LOGIN 로그', title: 'x', lastActivity: new Date(at('2026-11-06T01:00:00Z')) }),
    );
    expect(ids(w.host.findTasks(w.epic, { query: 'login' }))).toEqual(['a', 'b', 'c']);
    expect(ids(w.host.findTasks(w.epic, { query: '  LOGIN   fix ' }))).toEqual(['a']);
    expect(ids(w.host.findTasks(w.epic, { query: '결제 login' }))).toEqual(['c']);
    expect(ids(w.host.findTasks(w.epic, { query: 'login nothing' }))).toEqual([]);
    expect(ids(w.host.findTasks(w.epic, { query: '   ' }))).toEqual(['a', 'b', 'c']);
  });

  it('F3 — day: started or last active that calendar day in the report timezone', () => {
    const w = world();
    // Seoul 11-07 01:00 (today there), started days before.
    w.add(session('late', { lastActivity: new Date(at('2026-11-06T16:00:00Z')) }));
    // Seoul 11-06 23:00: yesterday there, though it is 11-06 in UTC.
    w.add(
      session('eve', { startedAt: at('2026-11-05T00:00:00Z'), lastActivity: new Date(at('2026-11-06T14:00:00Z')) }),
    );
    // Started Seoul 11-06 10:00, last active Seoul 11-07 01:30: both days.
    w.add(
      session('span', {
        startedAt: at('2026-11-06T01:00:00Z'),
        lastActivity: new Date(at('2026-11-06T16:30:00Z')),
      }),
    );
    w.add(
      session('old', { lastActivity: new Date(at('2026-10-01T00:00:00Z')), startedAt: at('2026-10-01T00:00:00Z') }),
    );
    expect(ids(w.host.findTasks(w.epic, { day: 'today' }))).toEqual(['span', 'late']);
    expect(ids(w.host.findTasks(w.epic, { day: '2026-11-07' }))).toEqual(['span', 'late']);
    expect(ids(w.host.findTasks(w.epic, { day: '2026-11-06' }))).toEqual(['span', 'eve']);
    expect(ids(w.host.findTasks(w.epic, { day: '2026-10-01' }))).toEqual(['old']);
    // The same records in UTC: 'today' is 11-06 there.
    const utc = world({ timezone: 'UTC' });
    for (const s of w.sessions.values()) if (s !== w.epic) utc.add(s);
    expect(ids(utc.host.findTasks(utc.epic, { day: 'today' }))).toEqual(['span', 'late', 'eve']);
    // Day and query together.
    w.sessions.get('C2-late.0').title = 'late login';
    expect(ids(w.host.findTasks(w.epic, { day: 'today', query: 'login' }))).toEqual(['late']);
  });

  it('F4 — adoptable, or why not', () => {
    const w = world();
    const t = (id: string | undefined, extra: Record<string, any> = {}) =>
      w.add(session(id, { lastActivity: new Date(at(`2026-11-06T0${9 - w.sessions.size}:00:00Z`)), ...extra }));
    t('free');
    t('epic2', { kind: 'epic', summaryTitle: '결제 에픽' });
    t('mine', { parentTaskId: 'e1', planNodeId: 'login' });
    t('theirs', { parentTaskId: 'epic2', planNodeId: 'pay' });
    t('orphan', { parentTaskId: 'gone-epic', planNodeId: 'x' });
    t('shutting', { closing: true });
    t(undefined, { threadTs: 'noid.0', title: 'no id' });
    const items = w.host.findTasks(w.epic, {});
    const by = new Map(items.map((i) => [i.taskId ?? 'none', i]));
    expect(by.get('free')).toMatchObject({ adoptable: true });
    expect(by.get('free')).not.toHaveProperty('reason');
    expect(by.get('epic2')).toMatchObject({ adoptable: false, reason: 'is an epic' });
    expect(by.get('mine')).toMatchObject({ adoptable: false, reason: 'already a child of this epic' });
    expect(by.get('theirs')).toMatchObject({ adoptable: false, reason: 'already a child of epic "결제 에픽"' });
    expect(by.get('orphan')).toMatchObject({ adoptable: false, reason: 'already a child of another epic' });
    expect(by.get('shutting')).toMatchObject({ adoptable: false, reason: 'closing' });
    expect(by.get('none')).toMatchObject({ adoptable: false, reason: 'no task id', title: 'no id' });
    expect(items).toHaveLength(7);
  });

  it('F5 — 20 by default, at most 50', () => {
    const w = world();
    for (let i = 0; i < 60; i++) {
      w.add(session(`t${i}`, { lastActivity: new Date(at('2026-11-01T00:00:00Z') + i * 60_000) }));
    }
    const first = w.host.findTasks(w.epic, {});
    expect(first).toHaveLength(20);
    expect(first[0].taskId).toBe('t59');
    expect(w.host.findTasks(w.epic, { limit: 50 })).toHaveLength(50);
    expect(w.host.findTasks(w.epic, { limit: 500 })).toHaveLength(50);
    expect(w.host.findTasks(w.epic, { limit: 3 })).toHaveLength(3);
    expect(w.host.findTasks(w.epic, { limit: 0 })).toHaveLength(1);
  });
});

describe('the epic host adopts a task (#1020)', () => {
  it('A1 — the registry’s adopt for the epic’s own id, its answer passed on; nothing posted or sent', () => {
    const w = world();
    expect(w.host.adoptChild(w.epic, 't9', 'login')).toEqual({ ok: true });
    expect(w.deps.adoptEpicChild).toHaveBeenCalledWith('e1', 't9', 'login');
    expect(w.deps.postMessage).not.toHaveBeenCalled();
    expect(w.deps.handleMessage).not.toHaveBeenCalled();
    expect(w.deps.sendToThread).not.toHaveBeenCalled();
    w.deps.adoptEpicChild.mockReturnValueOnce({ ok: false, code: 'other-owner', error: 'not the owner’s task' });
    expect(w.host.adoptChild(w.epic, 't9', 'login')).toEqual({
      ok: false,
      code: 'other-owner',
      error: 'not the owner’s task',
    });
  });

  it('A2 — a node whose child is being made is refused; a registry throw is not-saved', async () => {
    let release: (v: { ts: string }) => void = () => {};
    // The child's thread root is held (the spawn is in flight); its instruction reply posts at once.
    const root = new Promise<{ ts: string }>((r) => (release = r));
    const postMessage = vi.fn(async () => ({ ts: '9.95' }));
    postMessage.mockImplementationOnce(() => root);
    const w = world({ postMessage });
    const spawning = w.host.spawnChild(w.epic, { planNodeId: 'login', instruction: '로그인 고쳐', title: '로그인' });
    expect(w.host.adoptChild(w.epic, 't9', 'login')).toMatchObject({ ok: false, code: 'spawn-in-flight' });
    expect(w.deps.adoptEpicChild).not.toHaveBeenCalled();
    // Another node is free meanwhile.
    expect(w.host.adoptChild(w.epic, 't9', 'docs')).toEqual({ ok: true });
    release({ ts: '9.9' });
    await spawning;
    // The spawn is over: the node is no longer held by it.
    w.deps.adoptEpicChild.mockClear();
    expect(w.host.adoptChild(w.epic, 't9', 'login')).toEqual({ ok: true });
    expect(w.deps.adoptEpicChild).toHaveBeenCalledWith('e1', 't9', 'login');

    w.deps.adoptEpicChild.mockImplementationOnce(() => {
      throw new Error('ENOSPC /secret');
    });
    const failed = w.host.adoptChild(w.epic, 't9', 'login');
    expect(failed).toMatchObject({ ok: false, code: 'not-saved' });
    expect(JSON.stringify(failed)).not.toMatch(/ENOSPC|secret/);
  });
});

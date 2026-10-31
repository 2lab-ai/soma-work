/**
 * E2 ⑧ — the Slack entry: a plain instruction from an enabled user becomes a
 * dashboard task, and its thread is protected (.prd/18 D1 · D2 · D3 · D11 · D12).
 *
 * Order: allow-list → new-user gate → dashboard check → canStart → create
 * (with the instruction thread and channel context) → start. A step that stops
 * the entry leaves every later step undone. The card link is posted by the
 * notice deliverer (the task's first save owes it), never here.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSlackTaskEntry, isTaskEntryAllowed, type TaskEntryAllowList } from '../task-entry';

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

const TASK_ID = '11111111-2222-4333-8444-555555555555';
const KEY = `task:${TASK_ID}`;

function harness(over: Record<string, any> = {}) {
  const calls: string[] = [];
  const task: any = {
    taskId: TASK_ID,
    slackless: true,
    ownerId: 'U1',
    originThread: { channel: 'C1', threadTs: '1700.000100', messageTs: '1700.000100' },
  };
  const deps = {
    isEnabled: vi.fn(() => true),
    isDashboardListening: vi.fn(() => {
      calls.push('dashboard');
      return true;
    }),
    newUserGate: vi.fn(async () => {
      calls.push('gate');
      return 'pass' as const;
    }),
    getUserName: vi.fn(async () => 'Alice'),
    canStart: vi.fn(() => {
      calls.push('canStart');
      return null;
    }),
    launch: vi.fn(async (req: any) => {
      calls.push('launch');
      return { status: 200, body: { sessionKey: KEY, status: 'running' } };
    }),
    getTaskByKey: vi.fn(() => task),
    getTaskByOriginThread: vi.fn(() => undefined as any),
    notStarted: vi.fn(),
    cardUrl: vi.fn(() => 'https://dash.example/card'),
    inputContext: vi.fn(async () => ({ channelName: 'dev', repos: ['2lab-ai/x'] })),
    reactions: { remove: vi.fn(async () => undefined), add: vi.fn(async () => undefined) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...over,
  };
  const entry = createSlackTaskEntry(deps as any);
  const say = vi.fn(async () => ({}));
  const event = { user: 'U1', channel: 'C1', ts: '1700.000100', text: '로그인 버그 고쳐줘' };
  return { entry, deps, calls, say, event, task };
}

describe('isTaskEntryAllowed (D2 (3))', () => {
  it('a candidate with nothing else going on is allowed', () => {
    expect(isTaskEntryAllowed(ALLOW)).toBe(true);
  });

  it.each([
    ['not a candidate', { candidate: false }],
    ['a DM', { dm: true }],
    ['the thread already has a Slack session', { hasSession: true }],
    ['a verbatim /z objective', { verbatim: true }],
    ['a goal opening', { goalOpening: true }],
    ['a `!` steer', { steer: true }],
    ['an inline % directive', { inlineDirective: true }],
    ['a handled command', { handled: true }],
    ['a command continuation', { continueWithPrompt: true }],
    ['a deferred forced skill', { deferredSkillFire: true }],
    ['a forced workflow', { forceWorkflow: true }],
    ['a goal objective', { setGoalObjective: true }],
    ['an inline model', { inlineModel: true }],
    ['inline no-goal', { inlineNoGoal: true }],
    ['files', { fileCount: 1 }],
  ])('%s → not a task', (_label, over) => {
    expect(isTaskEntryAllowed({ ...ALLOW, ...over })).toBe(false);
  });
});

describe('createSlackTaskEntry.run (E2 ⑧)', () => {
  it('an enabled user’s instruction becomes a task with its thread and channel context; eyes off, safe', async () => {
    const h = harness();
    const out = await h.entry.run({ event: h.event, say: h.say, allow: ALLOW });
    expect(out).toEqual({ result: 'safe' });
    expect(h.calls).toEqual(['gate', 'dashboard', 'canStart', 'launch']);
    expect(h.deps.launch).toHaveBeenCalledWith({
      ownerId: 'U1',
      ownerName: 'Alice',
      prompt: '로그인 버그 고쳐줘',
      originThread: { channel: 'C1', threadTs: '1700.000100', messageTs: '1700.000100' },
      inputContext: { channelName: 'dev', repos: ['2lab-ai/x'] },
    });
    expect(h.deps.reactions.remove).toHaveBeenCalledWith('C1', '1700.000100', 'eyes');
    // The link is the deliverer's: nothing posted here.
    expect(h.say).not.toHaveBeenCalled();
  });

  it('a mention inside a thread keeps the thread root as the instruction thread', async () => {
    const h = harness();
    await h.entry.run({ event: { ...h.event, ts: '1700.000300', thread_ts: '1700.000100' }, say: h.say, allow: ALLOW });
    expect(h.deps.launch.mock.calls[0][0].originThread).toEqual({
      channel: 'C1',
      threadTs: '1700.000100',
      messageTs: '1700.000300',
    });
  });

  it('not allowed, or a user who has not turned it on: the Slack path, untouched', async () => {
    const off = harness({ isEnabled: vi.fn(() => false) });
    expect(await off.entry.run({ event: off.event, say: off.say, allow: ALLOW })).toBeUndefined();
    expect(off.calls).toEqual([]);
    const notAllowed = harness();
    expect(
      await notAllowed.entry.run({ event: notAllowed.event, say: notAllowed.say, allow: { ...ALLOW, handled: true } }),
    ).toBeUndefined();
    expect(notAllowed.calls).toEqual([]);
  });

  it('the new-user gate stops it first — blocked, nothing made', async () => {
    for (const verdict of ['new', 'pending'] as const) {
      const h = harness({
        newUserGate: vi.fn(async () => {
          h.calls.push('gate');
          return verdict;
        }),
      });
      const out = await h.entry.run({ event: h.event, say: h.say, allow: ALLOW });
      expect(out).toEqual({ result: 'blocked', reason: 'new user gate' });
      expect(h.calls).toEqual(['gate']);
      expect(h.deps.reactions.remove).toHaveBeenCalledWith('C1', '1700.000100', 'eyes');
    }
  });

  it('no dashboard: says so and goes on the Slack path, before any task or folder', async () => {
    const h = harness({
      isDashboardListening: vi.fn(() => {
        h.calls.push('dashboard');
        return false;
      }),
    });
    const out = await h.entry.run({ event: h.event, say: h.say, allow: ALLOW });
    expect(out).toBeUndefined();
    expect(h.calls).toEqual(['gate', 'dashboard']);
    expect(h.say).toHaveBeenCalledWith({
      text: expect.stringContaining('대시보드가 꺼져 있어 슬랙 세션으로'),
      thread_ts: '1700.000100',
    });
  });

  it('another task of the owner runs (429) or the service is stopping (503): refused before anything is made', async () => {
    for (const [status, words] of [
      [429, 'one dashboard task runs at a time'],
      [503, '재시작 중이라'],
    ] as const) {
      const h = harness({
        canStart: vi.fn(() => {
          h.calls.push('canStart');
          return { status, body: { error: 'one dashboard task runs at a time — wait for it to finish' } };
        }),
      });
      const out = await h.entry.run({ event: h.event, say: h.say, allow: ALLOW });
      expect(out).toEqual({ result: 'safe' });
      expect(h.calls).toEqual(['gate', 'dashboard', 'canStart']);
      expect(h.say).toHaveBeenCalledWith({ text: expect.stringContaining(words), thread_ts: '1700.000100' });
      expect(h.deps.reactions.remove).toHaveBeenCalledWith('C1', '1700.000100', 'eyes');
    }
  });

  it('made but not started (a race): the thread is owed a “not started” notice; still safe', async () => {
    const h = harness({
      launch: vi.fn(async () => ({ status: 200, body: { sessionKey: KEY, status: 'not-started', reason: 'raced' } })),
    });
    const out = await h.entry.run({ event: h.event, say: h.say, allow: ALLOW });
    expect(out).toEqual({ result: 'safe' });
    expect(h.deps.notStarted).toHaveBeenCalledWith(h.task, KEY, 'raced');
  });

  it('create throws: eyes off, warning on, told — error', async () => {
    const h = harness({
      launch: vi.fn(async () => {
        throw new Error('sessions.json not writable');
      }),
    });
    const out = await h.entry.run({ event: h.event, say: h.say, allow: ALLOW });
    expect(out).toEqual({ result: 'error', reason: expect.stringContaining('sessions.json not writable') });
    expect(h.deps.reactions.remove).toHaveBeenCalledWith('C1', '1700.000100', 'eyes');
    expect(h.deps.reactions.add).toHaveBeenCalledWith('C1', '1700.000100', 'warning');
    expect(h.say).toHaveBeenCalledWith({
      text: expect.stringContaining('작업을 만들지 못했어요'),
      thread_ts: '1700.000100',
    });
  });

  it('the same mention delivered twice at once: the second finds its own task — silent, safe', async () => {
    const taken = Object.assign(new Error('taken'), { name: 'OriginThreadTakenError' });
    const h = harness({
      launch: vi.fn(async () => {
        throw taken;
      }),
    });
    h.deps.getTaskByOriginThread.mockReturnValue(h.task);
    const out = await h.entry.run({ event: h.event, say: h.say, allow: ALLOW });
    expect(out).toEqual({ result: 'safe' });
    expect(h.say).not.toHaveBeenCalled();
    expect(h.deps.reactions.add).not.toHaveBeenCalled();
  });
});

describe('createSlackTaskEntry.run — a thread taken in the race', () => {
  it('another mention took the thread a moment earlier: the card-link notice, safe', async () => {
    const taken = Object.assign(new Error('taken'), { name: 'OriginThreadTakenError' });
    const h = harness({
      launch: vi.fn(async () => {
        throw taken;
      }),
    });
    h.deps.getTaskByOriginThread.mockReturnValue(h.task);
    const out = await h.entry.run({
      event: { ...h.event, ts: '1700.000300', thread_ts: '1700.000100' },
      say: h.say,
      allow: ALLOW,
    });
    expect(out).toEqual({ result: 'safe' });
    expect(h.say).toHaveBeenCalledWith({
      text: expect.stringContaining('대시보드 작업에 연결돼 있어요'),
      thread_ts: '1700.000100',
    });
    expect(h.deps.reactions.add).not.toHaveBeenCalled();
  });
});

describe('createSlackTaskEntry.guard — the instruction thread (D2 (2), D3)', () => {
  it('a thread no live task holds is not claimed', async () => {
    const h = harness();
    expect(await h.entry.guard({ channel: 'C1', ts: '1700.000300', thread_ts: '1700.000100' }, h.say)).toBe(false);
  });

  it('a record without an instruction thread or a task id claims nothing', async () => {
    const h = harness();
    h.deps.getTaskByOriginThread.mockReturnValue({ ...h.task, originThread: undefined });
    expect(await h.entry.guard({ channel: 'C1', ts: '1700.000300', thread_ts: '1700.000100' }, h.say)).toBe(false);
    h.deps.getTaskByOriginThread.mockReturnValue({ ...h.task, taskId: undefined });
    expect(await h.entry.guard({ channel: 'C1', ts: '1700.000301', thread_ts: '1700.000100' }, h.say)).toBe(false);
    expect(h.say).not.toHaveBeenCalled();
  });

  it('another mention there: one card-link notice, nothing runs; the same message again says nothing more', async () => {
    const h = harness();
    h.deps.getTaskByOriginThread.mockReturnValue(h.task);
    const ev = { channel: 'C1', ts: '1700.000300', thread_ts: '1700.000100' };
    expect(await h.entry.guard(ev, h.say)).toBe(true);
    expect(h.say).toHaveBeenCalledWith({
      text: expect.stringContaining('대시보드 작업에 연결돼 있어요'),
      thread_ts: '1700.000100',
    });
    expect((h.say.mock.calls[0] as any[])[0].text).toContain('https://dash.example/card');
    expect(await h.entry.guard(ev, h.say)).toBe(true);
    expect(h.say).toHaveBeenCalledTimes(1);
    expect(h.deps.getTaskByOriginThread).toHaveBeenCalledWith('C1', '1700.000100');
  });

  it('the instruction itself redelivered: silent', async () => {
    const h = harness();
    h.deps.getTaskByOriginThread.mockReturnValue(h.task);
    expect(await h.entry.guard({ channel: 'C1', ts: '1700.000100' }, h.say)).toBe(true);
    expect(h.say).not.toHaveBeenCalled();
  });

  it('the instruction’s late file_share copy: told the files did not reach the task', async () => {
    const h = harness();
    h.deps.getTaskByOriginThread.mockReturnValue(h.task);
    expect(await h.entry.guard({ channel: 'C1', ts: '1700.000100', files: [{ id: 'F1' }] }, h.say)).toBe(true);
    expect(h.say).toHaveBeenCalledWith({ text: expect.stringContaining('첨부 파일'), thread_ts: '1700.000100' });
  });
});

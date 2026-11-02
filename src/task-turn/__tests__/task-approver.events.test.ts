/**
 * E2 ⑥ — the task approver says what happened to each approval (.prd/18 D9):
 * `requested` right after the prompt is stored, `resolved` with how it ended
 * (allow · deny · expired · aborted · no-window · error). `expired` is the
 * approver's own judgement against its `expiresAt` (the store's answer has no
 * reason). Events carry the id, tool name, turn and deadline — never the tool
 * input — and nothing a listener does changes the approval's answer.
 */
import { describe, expect, it, vi } from 'vitest';
import { composeTaskApprovalListeners, createTaskApprover, type TaskApprovalEvent } from '../task-approver';

const TASK = 'task:11111111-2222-4333-8444-555555555555';
const REQ = {
  sessionKey: TASK,
  userId: 'U_OWNER',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf build' },
  ruleIds: ['rm-rf'],
};

function harness(answer: (clock: { t: number }) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>) {
  const clock = { t: 1_000_000 };
  const events: TaskApprovalEvent[] = [];
  const store = {
    storePendingApproval: vi.fn(async () => undefined),
    waitForPermissionResponse: vi.fn(async () => answer(clock)),
    cleanup: vi.fn(async () => undefined),
  };
  const approver = createTaskApprover({
    store: store as any,
    getActiveTurnId: () => 'turn-7',
    timeoutMs: 60_000,
    now: () => clock.t,
    newId: () => 'approval_1',
    onEvent: (e) => void events.push(e),
  });
  return { approver, events, store, clock };
}

const requested = {
  type: 'requested',
  approvalId: 'approval_1',
  sessionKey: TASK,
  turnId: 'turn-7',
  toolName: 'Bash',
  expiresAt: 1_060_000,
};

describe('task approver events (E2 ⑥)', () => {
  it('an allow: requested, then resolved allow — no tool input in either', async () => {
    const h = harness(async () => ({ behavior: 'allow' }));
    expect((await h.approver.request(REQ)).behavior).toBe('allow');
    expect(h.events).toEqual([requested, { ...requested, type: 'resolved', resolution: 'allow' }]);
    expect(JSON.stringify(h.events)).not.toContain('rm -rf');
  });

  it('a deny before the deadline is the owner’s deny; a deny at or past it is expired', async () => {
    const denied = harness(async () => ({ behavior: 'deny' }));
    await denied.approver.request(REQ);
    expect(denied.events.slice(-1)[0]).toMatchObject({ type: 'resolved', resolution: 'deny' });

    const expired = harness(async (clock) => {
      clock.t = 1_060_000;
      return { behavior: 'deny', message: 'Permission request timed out' };
    });
    expect((await expired.approver.request(REQ)).behavior).toBe('deny');
    expect(expired.events.slice(-1)[0]).toMatchObject({ type: 'resolved', resolution: 'expired' });
  });

  it('an abort or a store error while waiting is aborted / error; a store that cannot write raises no requested', async () => {
    const ac = new AbortController();
    const aborted = harness(async () => {
      ac.abort();
      throw new Error('aborted');
    });
    await expect(aborted.approver.request({ ...REQ, signal: ac.signal })).rejects.toThrow();
    expect(aborted.events.map((e) => (e.type === 'resolved' ? e.resolution : e.type))).toEqual([
      'requested',
      'aborted',
    ]);

    const broken = harness(async () => {
      throw new Error('store down');
    });
    await expect(broken.approver.request(REQ)).rejects.toThrow('store down');
    expect(broken.events.slice(-1)[0]).toMatchObject({ type: 'resolved', resolution: 'error' });

    const unwritable = harness(async () => ({ behavior: 'allow' }));
    unwritable.store.storePendingApproval.mockRejectedValueOnce(new Error('EROFS'));
    await expect(unwritable.approver.request(REQ)).rejects.toThrow('EROFS');
    expect(unwritable.events).toEqual([{ ...requested, type: 'resolved', resolution: 'error' }]);
  });

  it('no time left to ask: resolved no-window, never requested', async () => {
    const h = harness(async () => ({ behavior: 'allow' }));
    const r = await h.approver.request({ ...REQ, deadlineAt: 1_000_500 });
    expect(r.behavior).toBe('deny');
    expect(h.events).toEqual([{ ...requested, type: 'resolved', resolution: 'no-window', expiresAt: undefined }]);
  });

  it('an approval is open from its request until it resolves', async () => {
    let release!: (v: { behavior: 'allow' }) => void;
    const h = harness(() => new Promise((r) => (release = r)));
    const waiting = h.approver.request(REQ);
    await vi.waitFor(() => expect(h.events).toHaveLength(1));
    expect(h.approver.isOpen('approval_1')).toBe(true);
    release({ behavior: 'allow' });
    await waiting;
    expect(h.approver.isOpen('approval_1')).toBe(false);
  });

  it('a listener that throws changes nothing about the answer', async () => {
    const approver = createTaskApprover({
      store: {
        storePendingApproval: vi.fn(async () => undefined),
        waitForPermissionResponse: vi.fn(async () => ({ behavior: 'allow' as const })),
        cleanup: vi.fn(async () => undefined),
      } as any,
      getActiveTurnId: () => 'turn-7',
      newId: () => 'approval_1',
      onEvent: () => {
        throw new Error('listener down');
      },
    });
    expect((await approver.request(REQ)).behavior).toBe('allow');
  });
});

describe('composeTaskApprovalListeners (E4 ⑤)', () => {
  const EVENT: TaskApprovalEvent = { type: 'requested', approvalId: 'ap-1', sessionKey: 'task:x', toolName: 'Bash' };

  it('every hearer hears each event in order; one that throws does not keep the next from hearing', () => {
    const heard: string[] = [];
    const listener = composeTaskApprovalListeners(
      (e) => heard.push(`notice:${e.approvalId}`),
      () => {
        throw new Error('epic save down');
      },
      undefined,
      (e) => heard.push(`epic:${e.type}`),
    );
    expect(() => listener(EVENT)).not.toThrow();
    expect(heard).toEqual(['notice:ap-1', 'epic:requested']);
  });
});

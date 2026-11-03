/**
 * The dashboard close of a session (`createDashboardCloseHandler`).
 *
 * #854 — a Slack epic and its children (Slack sessions): closing the epic first marks each running
 * child closed by its parent and stops its turn (the request coordinator's abort), then the epic is
 * terminated; closing a child records its close on its epic. Every other session is just terminated.
 * (#855 — the dashboard-task close beside this, its chain cancel and notice-ledger refusal, is gone.)
 */
import { describe, expect, it, vi } from 'vitest';
import { createDashboardCloseHandler } from '../task-close';

function rig(session: any, children: any[] = [], running: string[] = []) {
  const order: string[] = [];
  const deps = {
    getSession: vi.fn(() => session),
    terminate: vi.fn(() => {
      order.push('terminate');
    }),
    getChildTasks: vi.fn(() => children),
    markClosedByParent: vi.fn((key: string) => {
      order.push(`mark:${key}`);
    }),
    recordChildClosed: vi.fn((key: string) => {
      order.push(`closed-event:${key}`);
    }),
    markClosing: vi.fn((key: string, closing: boolean) => {
      order.push(`${closing ? 'closing' : 'not-closing'}:${key}`);
    }),
    keyOf: (s: any) => (s.channelId ? `${s.channelId}-${s.threadTs}` : undefined),
    isRunning: vi.fn((key: string) => running.includes(key)),
    abort: vi.fn((key: string) => {
      order.push(`abort:${key}`);
    }),
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  return { close: createDashboardCloseHandler(deps), deps, order };
}

const epic = { taskId: 'e1', kind: 'epic', channelId: 'C1', threadTs: '1.0', ownerId: 'U1' };
const kids = [
  { taskId: 'c1', parentTaskId: 'e1', channelId: 'C1', threadTs: '2.0', ownerId: 'U1' },
  { taskId: 'c2', parentTaskId: 'e1', channelId: 'C1', threadTs: '3.0', ownerId: 'U1' },
  { taskId: 'c3', parentTaskId: 'e1', channelId: 'C1', threadTs: '4.0', ownerId: 'U1' },
];

describe('dashboard close of a Slack epic or child (#854)', () => {
  it('S-E1 — closing an epic marks and stops its running children first, then terminates it', async () => {
    const r = rig(epic, kids, ['C1-2.0', 'C1-4.0']);
    await r.close('C1-1.0');
    expect(r.order).toEqual([
      'closing:C1-1.0',
      'mark:C1-2.0',
      'abort:C1-2.0',
      'mark:C1-4.0',
      'abort:C1-4.0',
      'terminate',
    ]);
    // A child not running is left alone, and no child is terminated (its thread and card stay).
    expect(r.deps.abort).not.toHaveBeenCalledWith('C1-3.0');
    expect(r.deps.terminate).toHaveBeenCalledTimes(1);
  });

  it('S-E2 — a mark that cannot be saved is logged; the child is still stopped and the epic closed', async () => {
    const r = rig(epic, kids, ['C1-2.0']);
    r.deps.markClosedByParent.mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    await r.close('C1-1.0');
    expect(r.deps.abort).toHaveBeenCalledWith('C1-2.0');
    expect(r.deps.terminate).toHaveBeenCalled();
    expect(r.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('closed by its parent'), expect.anything());
  });

  it('S-E3 — closing a child records its close on its epic, then terminates it; a failed record is logged', async () => {
    const r = rig(kids[0]);
    await r.close('C1-2.0');
    expect(r.order).toEqual(['closing:C1-2.0', 'closed-event:C1-2.0', 'terminate']);
    expect(r.deps.markClosedByParent).not.toHaveBeenCalled();

    const f = rig(kids[0]);
    f.deps.recordChildClosed.mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    await f.close('C1-2.0');
    expect(f.deps.terminate).toHaveBeenCalled();
    expect(f.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not record'), expect.anything());
  });

  it('S-E4 — an ordinary session closes as before: terminated, nothing else', async () => {
    const r = rig({ channelId: 'C1', threadTs: '9.0' }, kids, ['C1-2.0']);
    await r.close('C1-9.0');
    expect(r.order).toEqual(['terminate']);
    expect(r.deps.getChildTasks).not.toHaveBeenCalled();
    expect(r.deps.markClosing).not.toHaveBeenCalled();
  });

  it('S-E5 — a close that fails clears the closing mark (the session is live again)', async () => {
    const r = rig(epic, kids, []);
    r.deps.terminate.mockImplementation(() => {
      throw new Error('refused');
    });
    await expect(r.close('C1-1.0')).rejects.toThrow('refused');
    expect(r.order).toEqual(['closing:C1-1.0', 'not-closing:C1-1.0']);
  });
});

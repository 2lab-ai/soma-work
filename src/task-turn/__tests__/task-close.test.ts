/**
 * E2 ⑨ — the dashboard close of a task (grok #672 P2): with no notice ledger a
 * task that owes its thread is refused BEFORE its chain is cancelled; anything
 * else closes as before (chain cancelled and committed, then terminated).
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionDeleteRefusedError } from '../../session-registry';
import { createDashboardCloseHandler } from '../task-close';

function rig(session: any, ledgerUnreadable: boolean, children: any[] = [], running: string[] = []) {
  const order: string[] = [];
  const deps = {
    getSession: vi.fn(() => session),
    closeTask: vi.fn(async (key: string) => {
      order.push(key === undefined ? 'closeTask' : `closeTask:${key}`);
    }),
    terminate: vi.fn(() => {
      order.push('terminate');
    }),
    ledgerUnreadable: () => ledgerUnreadable,
    getChildTasks: vi.fn(() => children),
    isRunning: vi.fn((key: string) => running.includes(key)),
    runningChain: vi.fn((key: string) => (running.includes(key) ? `chain-of-${key}` : undefined)),
    markClosedByParent: vi.fn((key: string, _chain: string | undefined) => {
      order.push(`mark:${key}`);
    }),
    recordChildClosed: vi.fn((key: string) => {
      order.push(`closed-event:${key}`);
    }),
    markClosing: vi.fn((key: string, closing: boolean) => {
      order.push(`${closing ? 'closing' : 'not-closing'}:${key}`);
    }),
    logger: { info: vi.fn(), warn: vi.fn() },
  };
  return { close: createDashboardCloseHandler(deps), deps, order };
}

const owing = {
  slackless: true,
  taskId: 't1',
  originThread: { channel: 'C1', threadTs: '1.1' },
  notices: [{ id: 'n' }],
};
const owingNothing = { slackless: true, taskId: 't2', notices: [] };

describe('dashboard close of a task', () => {
  it('no ledger and the task owes its thread: refused before the chain is cancelled, nothing terminated', async () => {
    const r = rig(owing, true);
    await expect(r.close('task:t1')).rejects.toBeInstanceOf(SessionDeleteRefusedError);
    expect(r.deps.closeTask).not.toHaveBeenCalled();
    expect(r.deps.terminate).not.toHaveBeenCalled();
    // The cause is in the log (fable #672 P3-3).
    expect(r.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('ledger is unreadable'), {
      sessionKey: 'task:t1',
    });
  });

  it('no ledger but the task owes nothing: closes as usual', async () => {
    const r = rig(owingNothing, true);
    await r.close('task:t2');
    expect(r.order).toEqual([expect.stringMatching(/^closing:/), expect.stringMatching(/^closeTask:/), 'terminate']);
  });

  it('with a ledger: the chain is cancelled and committed, then the task is terminated', async () => {
    const r = rig(owing, false);
    await r.close('task:t1');
    expect(r.order).toEqual([expect.stringMatching(/^closing:/), expect.stringMatching(/^closeTask:/), 'terminate']);
  });

  it('a Slack session: no task close, just terminated', async () => {
    const r = rig({ slackless: false, channelId: 'C1', threadTs: '1.1' }, true);
    await r.close('C1:1.1');
    expect(r.order).toEqual(['terminate']);
  });
});

describe('E4 ⑦ — closing an epic or a child (D10 b · c)', () => {
  const epic = { slackless: true, taskId: 'e1', kind: 'epic' };
  const kids = [
    { slackless: true, taskId: 'c1', parentTaskId: 'e1' },
    { slackless: true, taskId: 'c2', parentTaskId: 'e1' },
    { slackless: true, taskId: 'c3', parentTaskId: 'e1' },
  ];

  it('an epic: each running child is marked closed by its parent, then all are cancelled, then the epic', async () => {
    const r = rig(epic, false, kids, ['task:c1', 'task:c3']);
    await r.close('task:e1');
    expect(r.order).toEqual([
      'closing:task:e1',
      'mark:task:c1',
      'mark:task:c3',
      'closeTask:task:c1',
      'closeTask:task:c3',
      'closeTask:task:e1',
      'terminate',
    ]);
    // Each mark names the chain the close cancels (grok #709 R1, fable #709 R2 P3-2).
    expect(r.deps.markClosedByParent.mock.calls).toEqual([
      ['task:c1', 'chain-of-task:c1'],
      ['task:c3', 'chain-of-task:c3'],
    ]);
    // A child not running is left alone, and no child is terminated (its card stays).
    expect(r.deps.closeTask).not.toHaveBeenCalledWith('task:c2');
    expect(r.deps.terminate).toHaveBeenCalledTimes(1);
  });

  it('the chain is read in the same synchronous pass as isRunning: a chain that ends on the next microtask is still named (fable #711 R1 P3-1)', async () => {
    const r = rig(epic, false, kids, ['task:c1']);
    const running = ['task:c1'];
    // The chain ends right after the running check — on the next microtask, before any await could land.
    r.deps.isRunning.mockImplementation((key: string) => {
      queueMicrotask(() => {
        running.length = 0;
      });
      return running.includes(key);
    });
    r.deps.runningChain.mockImplementation((key: string) => (running.includes(key) ? `chain-of-${key}` : undefined));
    await r.close('task:e1');
    expect(r.deps.markClosedByParent.mock.calls).toEqual([['task:c1', 'chain-of-task:c1']]);
  });

  it('the children are cancelled at once, not one after another', async () => {
    const r = rig(epic, false, kids, ['task:c1', 'task:c2']);
    let open = 0;
    let most = 0;
    r.deps.closeTask.mockImplementation(async (key: string) => {
      open++;
      most = Math.max(most, open);
      await new Promise((res) => setTimeout(res, 5));
      open--;
      r.order.push(`closeTask:${key}`);
    });
    await r.close('task:e1');
    expect(most).toBe(2);
  });

  it('a mark that cannot be saved is logged; the child is still cancelled and the epic closed', async () => {
    const r = rig(epic, false, kids, ['task:c1']);
    r.deps.markClosedByParent.mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    await r.close('task:e1');
    expect(r.deps.closeTask).toHaveBeenCalledWith('task:c1');
    expect(r.deps.terminate).toHaveBeenCalled();
    expect(r.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('closed by its parent'), expect.anything());
  });

  it('a child: its epic records the close first, then it closes; a failed record is logged, the close goes on', async () => {
    const r = rig(kids[0], false);
    await r.close('task:c1');
    expect(r.order).toEqual(['closing:task:c1', 'closed-event:task:c1', 'closeTask:task:c1', 'terminate']);
    expect(r.deps.markClosedByParent).not.toHaveBeenCalled();

    const f = rig(kids[0], false);
    f.deps.recordChildClosed.mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    await f.close('task:c1');
    expect(f.deps.terminate).toHaveBeenCalled();
    expect(f.deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not record'), expect.anything());
  });

  it('an ordinary task touches neither rule', async () => {
    const r = rig({ slackless: true, taskId: 't9' }, false, kids, ['task:c1']);
    await r.close('task:t9');
    expect(r.deps.getChildTasks).not.toHaveBeenCalled();
    expect(r.deps.recordChildClosed).not.toHaveBeenCalled();
    expect(r.order).toEqual(['closing:task:t9', 'closeTask:task:t9', 'terminate']);
  });

  it('a close that fails clears the closing mark (the task is live again); a refusal before it sets none', async () => {
    const r = rig({ slackless: true, taskId: 'e1', kind: 'epic' }, false, kids, []);
    r.deps.terminate.mockImplementation(() => {
      throw new Error('refused');
    });
    await expect(r.close('task:e1')).rejects.toThrow('refused');
    expect(r.order).toEqual(['closing:task:e1', 'closeTask:task:e1', 'not-closing:task:e1']);

    const c = rig({ slackless: true, taskId: 'e2', kind: 'epic' }, false, kids, ['task:c1']);
    c.deps.closeTask.mockRejectedValueOnce(new Error('boom'));
    await expect(c.close('task:e2')).rejects.toThrow('boom');
    expect(c.deps.markClosing).toHaveBeenLastCalledWith('task:e2', false);

    const refused = rig(owing, true);
    await expect(refused.close('task:t1')).rejects.toBeInstanceOf(SessionDeleteRefusedError);
    expect(refused.deps.markClosing).not.toHaveBeenCalled();

    const slack = rig({ slackless: false, channelId: 'C1', threadTs: '1.1' }, false);
    await slack.close('C1:1.1');
    expect(slack.deps.markClosing).not.toHaveBeenCalled();
  });
});

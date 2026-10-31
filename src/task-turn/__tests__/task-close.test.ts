/**
 * E2 ⑨ — the dashboard close of a task (grok #672 P2): with no notice ledger a
 * task that owes its thread is refused BEFORE its chain is cancelled; anything
 * else closes as before (chain cancelled and committed, then terminated).
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionDeleteRefusedError } from '../../session-registry';
import { createDashboardCloseHandler } from '../task-close';

function rig(session: any, ledgerUnreadable: boolean) {
  const order: string[] = [];
  const deps = {
    getSession: vi.fn(() => session),
    closeTask: vi.fn(async () => {
      order.push('closeTask');
    }),
    terminate: vi.fn(() => {
      order.push('terminate');
    }),
    ledgerUnreadable: () => ledgerUnreadable,
    logger: { info: vi.fn() },
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
  });

  it('no ledger but the task owes nothing: closes as usual', async () => {
    const r = rig(owingNothing, true);
    await r.close('task:t2');
    expect(r.order).toEqual(['closeTask', 'terminate']);
  });

  it('with a ledger: the chain is cancelled and committed, then the task is terminated', async () => {
    const r = rig(owing, false);
    await r.close('task:t1');
    expect(r.order).toEqual(['closeTask', 'terminate']);
  });

  it('a Slack session: no task close, just terminated', async () => {
    const r = rig({ slackless: false, channelId: 'C1', threadTs: '1.1' }, true);
    await r.close('C1:1.1');
    expect(r.order).toEqual(['terminate']);
  });
});

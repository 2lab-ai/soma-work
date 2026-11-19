/**
 * The dashboard stop of a session (`createDashboardStopHandler`) — SSOT 2026-11-19 (Z):
 * "작업 카드 중지누르면 현재 진행중이 골이 있으면 골때문에 중지가 안됨 … goal부터 pause 처리하고 작업 중지처리해줘"
 *
 * With the owner's yes (`pauseGoalId`), the goal is paused FIRST and the turn is cut after it; a refused pause
 * stops nothing. Without it, a plain stop, as before.
 */
import { describe, expect, it, vi } from 'vitest';
import { HostGoalActionError } from '../../slack/goal-host-actions';
import { createDashboardStopHandler } from '../task-stop';

function rig(pause: (key: string, goalId: string) => any = () => ({ outcome: 'paused', inPlace: false })) {
  const order: string[] = [];
  const deps = {
    pauseGoalForStop: vi.fn((key: string, goalId: string) => {
      order.push(`pause:${goalId}`);
      return pause(key, goalId);
    }),
    abort: vi.fn((key: string) => {
      order.push(`abort:${key}`);
    }),
    logger: { info: vi.fn() },
  };
  return { order, deps, stop: createDashboardStopHandler(deps) };
}

describe('createDashboardStopHandler', () => {
  it('the owner confirmed pausing the goal: the goal is paused first, then the turn is cut', async () => {
    const { order, stop, deps } = rig();
    await stop('C1:t1', { pauseGoalId: 'g1' });
    expect(order).toEqual(['pause:g1', 'abort:C1:t1']);
    expect(deps.pauseGoalForStop).toHaveBeenCalledWith('C1:t1', 'g1');
    expect(deps.logger.info).toHaveBeenCalledWith('Dashboard: stopped session', {
      sessionKey: 'C1:t1',
      goal: 'paused',
    });
  });

  it('a pause that is refused stops nothing — the refusal goes back to the route', async () => {
    const { order, stop, deps } = rig(() => {
      throw new HostGoalActionError(409, 'Another goal is running now — refresh and try again');
    });
    await expect(stop('C1:t1', { pauseGoalId: 'g1' })).rejects.toMatchObject({ statusCode: 409 });
    expect(order).toEqual(['pause:g1']);
    expect(deps.abort).not.toHaveBeenCalled();
  });

  it('no goal to pause (none was asked for): a plain stop, as before', async () => {
    const { order, stop, deps } = rig();
    await stop('C1:t1');
    expect(order).toEqual(['abort:C1:t1']);
    expect(deps.pauseGoalForStop).not.toHaveBeenCalled();
  });

  it('the goal stopped running meanwhile: the stop still goes through', async () => {
    const { order, stop } = rig(() => ({ outcome: 'not-running' }));
    await stop('C1:t1', { pauseGoalId: 'g1' });
    expect(order).toEqual(['pause:g1', 'abort:C1:t1']);
  });
});

/**
 * #598 ④b1 — the output pieces a Slack-less task's executor is built from
 * (design 598b v5 §2, §3, §10): a Slack API that refuses and records every
 * call, the dashboard panel, and the per-turn task `say`.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDashboardTurnPanel } from '../dashboard-turn-panel';
import { createFailClosedSlackApi, SlackFromTaskTurnError } from '../fail-closed-slack-api';
import { createTaskSay } from '../task-say';

describe('createFailClosedSlackApi (§10)', () => {
  it('records and rejects every helper method — including ones that go through other helpers', async () => {
    const { api, calls } = createFailClosedSlackApi();
    await expect(api.postMessage('C1', 'hi')).rejects.toBeInstanceOf(SlackFromTaskTurnError);
    await expect(api.postSystemMessage('C1', 'x')).rejects.toBeInstanceOf(SlackFromTaskTurnError);
    await expect(api.getUserProfile('U1')).rejects.toBeInstanceOf(SlackFromTaskTurnError);
    await expect(api.getBotUserId()).rejects.toBeInstanceOf(SlackFromTaskTurnError);
    expect(calls.map((c) => c.method)).toEqual(['postMessage', 'postSystemMessage', 'getUserProfile', 'getBotUserId']);
  });

  it('never hands out a client — getClient records and throws', () => {
    const { api, calls } = createFailClosedSlackApi();
    expect(() => api.getClient()).toThrow(SlackFromTaskTurnError);
    expect(calls.map((c) => c.method)).toEqual(['getClient']);
  });

  it('reports the first recorded call of a turn once', async () => {
    const onFirstCall = vi.fn();
    const { api } = createFailClosedSlackApi({ onFirstCall });
    await api.postMessage('C1', 'a').catch(() => {});
    await api.updateMessage('C1', '1.1', 'b').catch(() => {});
    expect(onFirstCall).toHaveBeenCalledTimes(1);
    expect(onFirstCall).toHaveBeenCalledWith('postMessage');
  });
});

describe('createTaskSay (§3)', () => {
  const binding = { sessionKey: 'task:t1', conversationId: 'conv-1', turnId: 'turn-1' };

  it('writes a notice for plain text, never throws, returns no ts', async () => {
    const write = vi.fn(async () => {});
    const say = createTaskSay(binding, write);
    await expect(say({ text: 'Background work is still running.' })).resolves.toEqual({});
    expect(write).toHaveBeenCalledWith(
      binding,
      expect.objectContaining({ kind: 'notice', text: 'Background work is still running.', turnId: 'turn-1' }),
    );
  });

  it('writes nothing for an attachments-only or blocks-only payload with empty text (a rendered form)', async () => {
    const write = vi.fn(async () => {});
    const say = createTaskSay(binding, write);
    await say({ text: '', attachments: [{ blocks: [] }] });
    await say({ text: '', blocks: [{ type: 'section' }] });
    expect(write).not.toHaveBeenCalled();
  });

  it('a failing writer does not make say throw (its rejection is the receipt’s, not the caller’s)', async () => {
    const say = createTaskSay(binding, async () => {
      throw new Error('ENOSPC');
    });
    await expect(say({ text: 'x' })).resolves.toEqual({});
  });
});

describe('createDashboardTurnPanel (§2)', () => {
  function panel() {
    const persist = vi.fn();
    const p = createDashboardTurnPanel({ persistAndBroadcast: persist });
    return { p, persist };
  }

  it('accepts text without a Slack surface, so the processor never falls back to say', async () => {
    const { p } = panel();
    expect(p.isTurnSurfaceActive()).toBe(true);
    expect(p.isCompletionMarkerActive()).toBe(false);
    await expect(p.appendText('turn-1', 'hello')).resolves.toBe(true);
  });

  it('endTurn keeps its contract — snapshot resolved, nothing else', async () => {
    const { p } = panel();
    await expect(p.endTurn('turn-1', 'completed')).resolves.toEqual({ snapshotResolved: true });
    await expect(p.failTurn('turn-1', new Error('x'))).resolves.toBeUndefined();
  });

  it('setStatus writes the action panel state, honours the stale-epoch fence, and broadcasts', async () => {
    const { p, persist } = panel();
    const session = { actionPanel: { renderEpoch: 0 } } as any;
    await p.setStatus(session, 'task:t1', { agentPhase: '입력 대기', waitingForChoice: true });
    expect(session.actionPanel.agentPhase).toBe('입력 대기');
    expect(session.actionPanel.waitingForChoice).toBe(true);
    expect(persist).toHaveBeenCalledWith('task:t1');
  });

  it('askUser returns a synthetic id, never a Slack ts', async () => {
    const { p } = panel();
    const session = { actionPanel: {} } as any;
    const r = await p.askUser('turn-1', { question: 'Pick' }, {}, 'Pick', {} as any, session, 'task:t1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.primaryTs).toMatch(/^turn-1:/);
  });
});

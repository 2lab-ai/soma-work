/**
 * #1131 — several admin approvals decided in one pass. The registry routes each
 * item to its kind's adapter (one `answerMany` call per kind when the adapter has
 * one, else one `answer` per item, in order), keeps the input order in the
 * results, and never lets one kind's failure lose another kind's results.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AdminApprovalAdapter,
  type AdminApprovalAnswer,
  answerAdminApprovals,
  clearAdminApprovalAdapters,
  MAX_BATCH_ANSWERS,
  onAdminApprovalsChanged,
  registerAdminApprovalAdapter,
} from '../admin-approvals';

function adapter(kind: AdminApprovalAdapter['kind'], over: Partial<AdminApprovalAdapter> = {}): AdminApprovalAdapter {
  return {
    kind,
    pending: () => [],
    resolved: () => [],
    answer: async (_id, choiceId) => ({ ok: true, outcome: choiceId === 'deny' ? 'denied' : 'approved' }),
    ...over,
  };
}

afterEach(() => clearAdminApprovalAdapters());

describe('answerAdminApprovals (#1131)', () => {
  it('refuses an empty batch, more than MAX_BATCH_ANSWERS items, and a repeated id — nothing is answered', async () => {
    const answer = vi.fn(async () => ({ ok: true, outcome: 'approved' }) as AdminApprovalAnswer);
    registerAdminApprovalAdapter(adapter('new_user', { answer }));
    expect(MAX_BATCH_ANSWERS).toBe(50);
    await expect(answerAdminApprovals([], 'UADMIN01')).rejects.toThrow();
    const many = Array.from({ length: MAX_BATCH_ANSWERS + 1 }, (_, i) => ({
      id: `new_user:U${i}`,
      choiceId: 'approve',
    }));
    await expect(answerAdminApprovals(many, 'UADMIN01')).rejects.toThrow();
    await expect(
      answerAdminApprovals(
        [
          { id: 'new_user:U1', choiceId: 'approve' },
          { id: 'new_user:U1', choiceId: 'deny' },
        ],
        'UADMIN01',
      ),
    ).rejects.toThrow();
    expect(answer).not.toHaveBeenCalled();
  });

  it('accepts exactly MAX_BATCH_ANSWERS items', async () => {
    registerAdminApprovalAdapter(adapter('new_user'));
    const items = Array.from({ length: MAX_BATCH_ANSWERS }, (_, i) => ({ id: `new_user:U${i}`, choiceId: 'approve' }));
    expect(await answerAdminApprovals(items, 'UADMIN01')).toHaveLength(MAX_BATCH_ANSWERS);
  });

  it('calls answerMany once per kind with its items in input order; results keep the input order', async () => {
    const many = vi.fn(async (items: { requestId: string; choiceId: string }[]) =>
      items.map((i) => ({ ok: true, outcome: i.choiceId === 'deny' ? 'denied' : 'approved' }) as AdminApprovalAnswer),
    );
    const single = vi.fn(async () => ({ ok: true, outcome: 'approved' }) as AdminApprovalAnswer);
    registerAdminApprovalAdapter(adapter('mcp_grant', { answerMany: many, answer: single }));
    registerAdminApprovalAdapter(adapter('bot_delete'));
    const out = await answerAdminApprovals(
      [
        { id: 'mcp_grant:a', choiceId: 'approve' },
        { id: 'bot_delete:x', choiceId: 'deny' },
        { id: 'mcp_grant:b', choiceId: 'deny' },
      ],
      'UADMIN01',
    );
    expect(many).toHaveBeenCalledTimes(1);
    expect(many).toHaveBeenCalledWith(
      [
        { requestId: 'a', choiceId: 'approve' },
        { requestId: 'b', choiceId: 'deny' },
      ],
      'UADMIN01',
    );
    expect(single).not.toHaveBeenCalled();
    expect(out).toEqual([
      { id: 'mcp_grant:a', result: { ok: true, outcome: 'approved' } },
      { id: 'bot_delete:x', result: { ok: true, outcome: 'denied' } },
      { id: 'mcp_grant:b', result: { ok: true, outcome: 'denied' } },
    ]);
  });

  it('without answerMany, answers one item at a time, in order', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    registerAdminApprovalAdapter(
      adapter('env_skill', {
        answer: async (requestId) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          order.push(requestId);
          await new Promise((r) => setTimeout(r, 5));
          inFlight--;
          return { ok: true, outcome: 'approved' };
        },
      }),
    );
    await answerAdminApprovals(
      [
        { id: 'env_skill:r1', choiceId: 'env_skill_once' },
        { id: 'env_skill:r2', choiceId: 'env_skill_once' },
        { id: 'env_skill:r3', choiceId: 'env_skill_once' },
      ],
      'UADMIN01',
    );
    expect(order).toEqual(['r1', 'r2', 'r3']);
    expect(maxInFlight).toBe(1);
  });

  it('a kind whose answerMany throws fails only its own items; the other kinds keep their results', async () => {
    registerAdminApprovalAdapter(
      adapter('mcp_grant', {
        answerMany: async () => {
          throw new Error('store unreadable');
        },
      }),
    );
    registerAdminApprovalAdapter(adapter('new_user'));
    const out = await answerAdminApprovals(
      [
        { id: 'mcp_grant:a', choiceId: 'approve' },
        { id: 'new_user:U1', choiceId: 'approve' },
        { id: 'mcp_grant:b', choiceId: 'approve' },
      ],
      'UADMIN01',
    );
    expect(out.map((r) => r.result)).toEqual([
      { ok: false, reason: 'invalid' },
      { ok: true, outcome: 'approved' },
      { ok: false, reason: 'invalid' },
    ]);
  });

  it('an answerMany that returns the wrong number of answers fails its own items', async () => {
    registerAdminApprovalAdapter(adapter('mcp_grant', { answerMany: async () => [{ ok: true, outcome: 'approved' }] }));
    const out = await answerAdminApprovals(
      [
        { id: 'mcp_grant:a', choiceId: 'approve' },
        { id: 'mcp_grant:b', choiceId: 'approve' },
      ],
      'UADMIN01',
    );
    expect(out.map((r) => r.result)).toEqual([
      { ok: false, reason: 'invalid' },
      { ok: false, reason: 'invalid' },
    ]);
  });

  it('one item whose answer throws fails alone; the next items are still answered', async () => {
    registerAdminApprovalAdapter(
      adapter('bot_delete', {
        answer: async (requestId) => {
          if (requestId === 'boom') throw new Error('slack down');
          return { ok: true, outcome: 'approved' };
        },
      }),
    );
    const out = await answerAdminApprovals(
      [
        { id: 'bot_delete:boom', choiceId: 'approve' },
        { id: 'bot_delete:ok', choiceId: 'approve' },
      ],
      'UADMIN01',
    );
    expect(out).toEqual([
      { id: 'bot_delete:boom', result: { ok: false, reason: 'invalid' } },
      { id: 'bot_delete:ok', result: { ok: true, outcome: 'approved' } },
    ]);
  });

  it('a malformed id, an unknown kind and a kind with no adapter are not found', async () => {
    registerAdminApprovalAdapter(adapter('new_user'));
    const out = await answerAdminApprovals(
      [
        { id: 'nonsense', choiceId: 'approve' },
        { id: 'martian:x', choiceId: 'approve' },
        { id: 'bot_delete:x', choiceId: 'approve' },
        { id: 'new_user:U1', choiceId: 'approve' },
      ],
      'UADMIN01',
    );
    expect(out.map((r) => r.result)).toEqual([
      { ok: false, reason: 'not_found' },
      { ok: false, reason: 'not_found' },
      { ok: false, reason: 'not_found' },
      { ok: true, outcome: 'approved' },
    ]);
  });

  it('an item that lost the race carries the winning resolution', async () => {
    registerAdminApprovalAdapter(
      adapter('env_skill', {
        answer: async () => ({ ok: false, reason: 'already_answered' }),
        resolved: () => [{ id: 'env_skill:r1', outcome: 'denied', by: 'U0OTHER1', via: 'slack', at: 3 }],
      }),
    );
    const [one] = await answerAdminApprovals([{ id: 'env_skill:r1', choiceId: 'env_skill_once' }], 'UADMIN01');
    expect(one.result).toEqual({
      ok: false,
      reason: 'already_answered',
      resolution: { id: 'env_skill:r1', outcome: 'denied', by: 'U0OTHER1', via: 'slack', at: 3 },
    });
  });

  it('signals the change once, after every item is answered', async () => {
    registerAdminApprovalAdapter(adapter('new_user'));
    registerAdminApprovalAdapter(adapter('bot_delete'));
    const seen = vi.fn();
    const off = onAdminApprovalsChanged(seen);
    try {
      await answerAdminApprovals(
        [
          { id: 'new_user:U1', choiceId: 'approve' },
          { id: 'bot_delete:x', choiceId: 'deny' },
        ],
        'UADMIN01',
      );
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});

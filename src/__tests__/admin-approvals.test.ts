/**
 * #620 — the admin approvals registry: no state of its own, adapters per kind.
 * One snapshot (pending newest first + recent resolutions), one answer path that
 * routes by id, and a change signal for the dashboard push.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AdminApproval,
  type AdminApprovalAdapter,
  adminApprovalSnapshot,
  answerAdminApproval,
  clearAdminApprovalAdapters,
  onAdminApprovalsChanged,
  parseAdminApprovalId,
  RESOLVED_WINDOW_MS,
  registerAdminApprovalAdapter,
} from '../admin-approvals';

function approval(kind: AdminApproval['kind'], requestId: string, createdAt: number): AdminApproval {
  return { id: `${kind}:${requestId}`, kind, card: 'permission', title: 't', requesterId: 'U1', createdAt };
}

afterEach(() => clearAdminApprovalAdapters());

describe('admin approvals registry (#620)', () => {
  it('merges every kind, newest first, and asks each adapter for the resolutions of the window', () => {
    const since: number[] = [];
    registerAdminApprovalAdapter({
      kind: 'env_skill',
      pending: () => [approval('env_skill', 'a', 100)],
      resolved: (s) => {
        since.push(s);
        return [{ id: 'env_skill:z', outcome: 'approved', at: 50 }];
      },
      answer: async () => ({ ok: true, outcome: 'approved' }),
    });
    registerAdminApprovalAdapter({
      kind: 'new_user',
      pending: () => [approval('new_user', 'b', 300)],
      resolved: () => [],
      answer: async () => ({ ok: true, outcome: 'approved' }),
    });
    const snap = adminApprovalSnapshot(10_000_000);
    expect(snap.pending.map((a) => a.id)).toEqual(['new_user:b', 'env_skill:a']);
    expect(snap.resolved.map((r) => r.id)).toEqual(['env_skill:z']);
    expect(since).toEqual([10_000_000 - RESOLVED_WINDOW_MS]);
  });

  it('an adapter that throws is skipped, the rest still list', () => {
    registerAdminApprovalAdapter({
      kind: 'mcp_grant',
      pending: () => {
        throw new Error('store unreadable');
      },
      resolved: () => [],
      answer: async () => ({ ok: false, reason: 'not_found' }),
    });
    registerAdminApprovalAdapter({
      kind: 'bot_delete',
      pending: () => [approval('bot_delete', 'c', 1)],
      resolved: () => [],
      answer: async () => ({ ok: true, outcome: 'denied' }),
    });
    expect(adminApprovalSnapshot().pending.map((a) => a.id)).toEqual(['bot_delete:c']);
  });

  it('routes an answer to its kind and signals the change', async () => {
    const answer = vi.fn(async () => ({ ok: true as const, outcome: 'denied' as const }));
    registerAdminApprovalAdapter({ kind: 'bot_delete', pending: () => [], resolved: () => [], answer });
    const changed = vi.fn();
    const off = onAdminApprovalsChanged(changed);
    expect(await answerAdminApproval('bot_delete:req-1', 'deny', 'UADMIN')).toEqual({ ok: true, outcome: 'denied' });
    expect(answer).toHaveBeenCalledWith('req-1', 'deny', 'UADMIN');
    expect(changed).toHaveBeenCalled();
    off();
  });

  it('an answer that lost the race carries the winning resolution', async () => {
    const adapter: AdminApprovalAdapter = {
      kind: 'env_skill',
      pending: () => [],
      resolved: () => [{ id: 'env_skill:r', outcome: 'approved', by: 'UOTHER', via: 'slack', at: 5 }],
      answer: async () => ({ ok: false, reason: 'already_answered' }),
    };
    registerAdminApprovalAdapter(adapter);
    expect(await answerAdminApproval('env_skill:r', 'env_skill_once', 'UADMIN')).toEqual({
      ok: false,
      reason: 'already_answered',
      resolution: { id: 'env_skill:r', outcome: 'approved', by: 'UOTHER', via: 'slack', at: 5 },
    });
  });

  it('unknown kinds and malformed ids are not found', async () => {
    expect(parseAdminApprovalId('nope:1')).toBeNull();
    expect(parseAdminApprovalId('env_skill:')).toBeNull();
    expect(parseAdminApprovalId('env_skill:abc')).toEqual({ kind: 'env_skill', requestId: 'abc' });
    expect(await answerAdminApproval('env_skill:abc', 'x', 'U')).toEqual({ ok: false, reason: 'not_found' });
  });
});

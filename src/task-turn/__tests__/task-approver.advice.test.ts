/**
 * SSOT 2026-11-02 T2 — a Slack-less task's escalation keeps the guardian's
 * advice on its prompt, so the dashboard card shows it and asks twice when red.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTaskApprover } from '../task-approver';

describe('task approver — AI advice', () => {
  it('stores the advice on the pending prompt', async () => {
    const stored: any[] = [];
    const approver = createTaskApprover({
      store: {
        storePendingApproval: vi.fn(async (_id: string, a: unknown) => {
          stored.push(a);
        }),
        waitForPermissionResponse: vi.fn(async () => ({ behavior: 'deny' as const, message: 'Denied by user' })),
        cleanup: vi.fn(async () => {}),
      },
      getActiveTurnId: () => 'turn-1',
    });
    const advice = { recommendation: 'deny' as const, summary: '루트를 지웁니다', risk: '되돌릴 수 없습니다' };
    await approver.request({
      sessionKey: 'task:t1',
      userId: 'U1',
      toolName: 'Bash',
      toolInput: { command: 'rm -rf /' },
      ruleIds: ['rm-recursive'],
      advice,
    });
    expect(stored[0].advice).toEqual(advice);
  });
});

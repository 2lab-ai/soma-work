import { describe, expect, it, vi } from 'vitest';
import { sharedStore } from './shared-store.ts';

describe('sharedStore permission response waits', () => {
  it('aborts a pending wait and removes its poll timer and approval files', async () => {
    vi.useFakeTimers();
    const approvalId = `abort_wait_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();

    try {
      await sharedStore.storePendingApproval(approvalId, {
        tool_name: 'Bash',
        input: { command: 'rm -rf /tmp/demo' },
        created_at: Date.now(),
        expires_at: Date.now() + 5 * 60 * 1000,
      });

      const wait = sharedStore.waitForPermissionResponse(approvalId, 5 * 60 * 1000, controller.signal);
      await vi.waitFor(() => expect(vi.getTimerCount()).toBe(1));

      controller.abort(new Error('permission request cancelled'));
      await expect(wait).rejects.toThrow('permission request cancelled');

      expect(await sharedStore.getPendingApproval(approvalId)).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await sharedStore.cleanup(approvalId);
      vi.useRealTimers();
    }
  });
});

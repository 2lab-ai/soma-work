import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

// SSOT 2026-10-24 T2.3 — a permission prompt is answered at most once, by
// whichever surface (Slack button or dashboard) claims it first, and the
// claim outlives the MCP server's cleanup of the pending/response files.
describe('sharedStore once-only answers (T2.3)', () => {
  const ids: string[] = [];
  const freshId = (tag: string) => {
    const id = `t23_${tag}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    ids.push(id);
    return id;
  };

  afterEach(async () => {
    for (const id of ids.splice(0)) await sharedStore.cleanup(id);
  });

  it('claims an approval exactly once', async () => {
    const id = freshId('claim');
    expect(await sharedStore.claimPermissionResponse(id)).toBe(true);
    expect(await sharedStore.claimPermissionResponse(id)).toBe(false);
  });

  it('keeps the claim after cleanup, so a late contender cannot answer a consumed prompt', async () => {
    const id = freshId('tombstone');
    expect(await sharedStore.claimPermissionResponse(id)).toBe(true);
    await sharedStore.storePermissionResponse(id, { behavior: 'deny', message: 'Denied by user' });
    await sharedStore.cleanup(id);
    expect(await sharedStore.claimPermissionResponse(id)).toBe(false);
  });

  it('publishes a response atomically — no temp file is left next to it', async () => {
    const id = freshId('atomic');
    await sharedStore.storePermissionResponse(id, { behavior: 'allow', message: 'Approved by user' });
    const responsesDir = path.join(os.tmpdir(), 'soma-work-store', 'responses');
    const leftovers = fs.readdirSync(responsesDir).filter((f) => f.includes(id) && f !== `${id}.json`);
    expect(leftovers).toEqual([]);
    expect(await sharedStore.waitForPermissionResponse(id, 2000)).toEqual({
      behavior: 'allow',
      message: 'Approved by user',
    });
  });
});

describe('sharedStore.listPendingApprovals (T1.1)', () => {
  const ids: string[] = [];
  afterEach(async () => {
    for (const id of ids.splice(0)) await sharedStore.cleanup(id);
  });

  it('lists live approvals with their id, and skips expired and unreadable records', async () => {
    const live = `t11_live_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const expired = `t11_expired_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const broken = `t11_broken_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    ids.push(live, expired, broken);
    await sharedStore.storePendingApproval(live, {
      kind: 'tool_permission',
      tool_name: 'Bash',
      input: { command: 'ls' },
      channel: 'C_T11',
      thread_ts: '1.0',
      user: 'U1',
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
    });
    await sharedStore.storePendingApproval(expired, {
      tool_name: 'Bash',
      input: {},
      created_at: Date.now() - 120_000,
      expires_at: Date.now() - 60_000,
    });
    fs.writeFileSync(path.join(os.tmpdir(), 'soma-work-store', 'pending', `${broken}.json`), '{"tool_na');

    const listed = await sharedStore.listPendingApprovals();
    const mine = listed.filter((p) => ids.includes(p.approvalId));
    expect(mine.map((p) => p.approvalId)).toEqual([live]);
    expect(mine[0].approval).toMatchObject({ kind: 'tool_permission', channel: 'C_T11', user: 'U1' });
  });
});

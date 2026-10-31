/**
 * #599 ⑤ — a Slack-less task's escalation waits for the dashboard approval.
 * The approver writes a permission prompt bound to the task (its key, the
 * running turn, the owner as requester) and waits for the answer; expiry,
 * abort and store errors never come back as an allow.
 */
import { type PendingApproval, sharedStore } from 'somalib/permission/shared-store';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TASK_APPROVAL_HOOK_MARGIN_MS,
  TASK_APPROVAL_HOOK_TIMEOUT_S,
} from '../../agent-runtime/claude-code/build-stream-options';
import { createTaskApprover, TASK_APPROVAL_TIMEOUT_MS } from '../task-approver';

const TASK = 'task:11111111-2222-4333-8444-555555555555';
const created: string[] = [];
afterEach(async () => {
  for (const id of created.splice(0)) await sharedStore.cleanup(id);
});

function approver(over: Partial<Parameters<typeof createTaskApprover>[0]> = {}) {
  let n = 0;
  return createTaskApprover({
    store: sharedStore,
    getActiveTurnId: () => 'turn-7',
    newId: () => {
      const id = `approval_t599_${Date.now()}_${n++}_${Math.random().toString(36).slice(2)}`;
      created.push(id);
      return id;
    },
    ...over,
  });
}

const REQ = {
  sessionKey: TASK,
  userId: 'U_OWNER',
  toolName: 'Bash',
  toolInput: { command: 'rm -rf build' },
  ruleIds: ['rm-rf'],
};

async function pendingRecord(): Promise<{ id: string; approval: PendingApproval }> {
  for (let i = 0; i < 50; i++) {
    for (const id of created) {
      const approval = await sharedStore.getPendingApproval(id);
      if (approval) return { id, approval };
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no pending approval written');
}

describe('createTaskApprover (#599 ⑤)', () => {
  it('writes a prompt bound to the task, its turn and its owner, then returns the dashboard’s answer', async () => {
    const waiting = approver({ timeoutMs: 5_000 }).request(REQ);
    const { id, approval } = await pendingRecord();
    expect(approval).toMatchObject({
      kind: 'tool_permission',
      tool_name: 'Bash',
      input: { command: 'rm -rf build' },
      user: 'U_OWNER',
      task_key: TASK,
      turn_id: 'turn-7',
      rule_ids: ['rm-rf'],
    });
    expect(approval.channel).toBeUndefined();
    await sharedStore.storePermissionResponse(id, { behavior: 'allow', message: 'Approved by user' });
    expect(await waiting).toEqual({ behavior: 'allow', message: 'Approved by user' });
  });

  it('expiry is a deny', async () => {
    const r = await approver({ timeoutMs: 300 }).request(REQ);
    expect(r.behavior).toBe('deny');
  });

  it('an abort (the turn stopped) rejects — the hook turns that into a deny', async () => {
    const ac = new AbortController();
    const waiting = approver({ timeoutMs: 5_000 }).request({ ...REQ, signal: ac.signal });
    await pendingRecord();
    ac.abort('user-stop');
    await expect(waiting).rejects.toBeDefined();
  });

  // #637 R1 (fable P2) — the wait fits inside the hook's SDK deadline: the
  // classifier may have used part of it, and the CLI cancels a hook at its
  // timeout (a deny that would drop an approval the owner gave late).
  it('waits no longer than the hook’s deadline, and the prompt expires with it', async () => {
    const t0 = Date.now();
    const waits: number[] = [];
    const store = {
      storePendingApproval: sharedStore.storePendingApproval.bind(sharedStore),
      waitForPermissionResponse: async (_id: string, ms: number) => {
        waits.push(ms);
        return { behavior: 'deny' as const, message: 'Permission request timed out' };
      },
    };
    await approver({ store: store as never, now: () => t0 }).request({ ...REQ, deadlineAt: t0 + 2_000 });
    expect(waits).toEqual([2_000]);
    const { approval } = await pendingRecord();
    expect(approval.expires_at).toBe(t0 + 2_000);
    await approver({ store: store as never, now: () => t0 }).request({ ...REQ, deadlineAt: t0 + 10 * 60_000 });
    expect(waits[1]).toBe(TASK_APPROVAL_TIMEOUT_MS);
  });

  it('with no time left before the hook’s deadline it denies without raising a prompt', async () => {
    const t0 = Date.now();
    const stored: string[] = [];
    const store = {
      storePendingApproval: async (id: string) => {
        stored.push(id);
      },
      waitForPermissionResponse: async () => ({ behavior: 'allow' as const }),
    };
    const r = await approver({ store: store as never, now: () => t0 }).request({ ...REQ, deadlineAt: t0 + 500 });
    expect(r.behavior).toBe('deny');
    expect(stored).toEqual([]);
  });

  it('the hook’s SDK budget covers a full approval window plus its margin', () => {
    expect(TASK_APPROVAL_HOOK_TIMEOUT_S * 1000 - TASK_APPROVAL_HOOK_MARGIN_MS).toBeGreaterThanOrEqual(
      TASK_APPROVAL_TIMEOUT_MS,
    );
  });

  it('a store that cannot write the prompt rejects (never an allow)', async () => {
    const broken = {
      storePendingApproval: async () => {
        throw new Error('ENOSPC');
      },
      waitForPermissionResponse: sharedStore.waitForPermissionResponse.bind(sharedStore),
    };
    await expect(approver({ store: broken as never }).request(REQ)).rejects.toThrow('ENOSPC');
  });
});

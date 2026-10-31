/**
 * #599 ⑤ — a Slack-less task's escalation waits for the dashboard approval.
 * The approver writes a permission prompt bound to the task (its key, the
 * running turn, the owner as requester) and waits for the answer; expiry,
 * abort and store errors never come back as an allow.
 */
import { type PendingApproval, sharedStore } from 'somalib/permission/shared-store';
import { afterEach, describe, expect, it } from 'vitest';
import { createTaskApprover } from '../task-approver';

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

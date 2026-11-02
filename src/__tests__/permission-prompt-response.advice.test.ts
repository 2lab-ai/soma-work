/**
 * SSOT 2026-11-02 — the one answer path, with the AI's advice.
 *
 * T4: a prompt the AI advised against is asked twice. A plain approve is
 * refused (`confirm_required`) and stores nothing; only the second, explicit
 * `approve_confirmed` runs it. Enforced here, so Slack and the dashboard ask
 * twice alike.
 *
 * T1: every answer is recorded in the session's work log as a `permission`
 * entry: who decided what, about which call, and what the AI advised.
 */

import { type PendingApproval, sharedStore } from 'somalib/permission/shared-store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@soma/slack/pipeline/stream-executor', () => ({ recordConversationWorkLog: vi.fn() }));

import { recordConversationWorkLog } from '@soma/slack/pipeline/stream-executor';
import { answerPermissionPrompt, isPermissionPromptDecision } from '../permission-prompt-response';

const ids: string[] = [];
const DENY = { recommendation: 'deny' as const, summary: '홈 폴더를 지웁니다', risk: '되돌릴 수 없습니다' };
const APPROVE = { recommendation: 'approve' as const, summary: '빌드 폴더를 지웁니다', risk: '빌드 산출물만' };

async function seed(overrides: Partial<PendingApproval> = {}): Promise<string> {
  const id = `approval_advice_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  ids.push(id);
  await sharedStore.storePendingApproval(id, {
    kind: 'tool_permission',
    tool_name: 'Bash',
    input: { command: 'rm -rf ~/work' },
    channel: 'C_ADV',
    thread_ts: '171.002',
    user: 'U_REQ',
    created_at: Date.now(),
    expires_at: Date.now() + 60_000,
    rule_ids: ['rm-recursive'],
    ...overrides,
  });
  return id;
}

function sessions() {
  return {
    getSessionKey: vi.fn((channel: string, threadTs?: string) => `${channel}-${threadTs ?? ''}`),
    disableDangerousRules: vi.fn(),
    getSession: vi.fn((_channel: string, _threadTs?: string) => ({ conversationId: 'conv-1' })),
    getSessionByKey: vi.fn((_key: string) => ({ activeTaskTurnId: 'turn-1', conversationId: 'conv-task' })),
  };
}

beforeEach(() => {
  vi.mocked(recordConversationWorkLog).mockClear();
});

afterEach(async () => {
  for (const id of ids.splice(0)) await sharedStore.cleanup(id);
});

describe('second confirmation (T4)', () => {
  it('accepts approve_confirmed as a decision', () => {
    expect(isPermissionPromptDecision('approve_confirmed')).toBe(true);
  });

  it.each([
    'approve',
    'approve_disable_rule',
  ] as const)('refuses a plain %s on a prompt the AI advised against, storing nothing', async (decision) => {
    const id = await seed({ advice: DENY });
    const reg = sessions();
    const result = await answerPermissionPrompt({ approvalId: id, actor: 'U_REQ', decision, sessions: reg });
    expect(result).toEqual({ ok: false, reason: 'confirm_required', advice: DENY });
    // Not claimed: the prompt is still open to the confirmed answer.
    expect(await sharedStore.getPendingApproval(id)).not.toBeNull();
    expect(reg.disableDangerousRules).not.toHaveBeenCalled();
    expect(recordConversationWorkLog).not.toHaveBeenCalled();
  });

  it('runs it on approve_confirmed — and does not silence any rule', async () => {
    const id = await seed({ advice: DENY });
    const reg = sessions();
    const result = await answerPermissionPrompt({
      approvalId: id,
      actor: 'U_REQ',
      decision: 'approve_confirmed',
      sessions: reg,
    });
    expect(result).toMatchObject({ ok: true, disabledRuleIds: [] });
    const stored = await sharedStore.waitForPermissionResponse(id, 1500);
    expect(stored.behavior).toBe('allow');
    expect(reg.disableDangerousRules).not.toHaveBeenCalled();
  });

  it('a deny on a red prompt needs no second answer', async () => {
    const id = await seed({ advice: DENY });
    const result = await answerPermissionPrompt({ approvalId: id, actor: 'U_REQ', decision: 'deny' });
    expect(result.ok).toBe(true);
  });

  it('a green prompt, or one with no advice, approves at once', async () => {
    const green = await seed({ advice: APPROVE });
    expect((await answerPermissionPrompt({ approvalId: green, actor: 'U_REQ', decision: 'approve' })).ok).toBe(true);
    const none = await seed();
    expect((await answerPermissionPrompt({ approvalId: none, actor: 'U_REQ', decision: 'approve' })).ok).toBe(true);
  });

  it('only the requester may confirm', async () => {
    const id = await seed({ advice: DENY });
    const result = await answerPermissionPrompt({ approvalId: id, actor: 'U_OTHER', decision: 'approve_confirmed' });
    expect(result).toMatchObject({ ok: false, reason: 'not_requester' });
  });
});

describe('the answer in the work log (T1)', () => {
  it('records an approve of a Slack prompt in its session work log', async () => {
    const id = await seed({ advice: APPROVE });
    await answerPermissionPrompt({ approvalId: id, actor: 'U_REQ', decision: 'approve', sessions: sessions() });
    expect(recordConversationWorkLog).toHaveBeenCalledTimes(1);
    const [conversationId, entry] = vi.mocked(recordConversationWorkLog).mock.calls[0];
    expect(conversationId).toBe('conv-1');
    expect(entry).toMatchObject({
      kind: 'permission',
      tool: 'Bash',
      ok: true,
      permission: { decision: 'approve', by: 'U_REQ', ai: 'approve' },
    });
    expect(entry.text).toContain('승인');
    expect(entry.text).toContain('rm -rf ~/work');
  });

  it('records a confirmed approve against the AI advice, saying so', async () => {
    const id = await seed({ advice: DENY });
    await answerPermissionPrompt({
      approvalId: id,
      actor: 'U_REQ',
      decision: 'approve_confirmed',
      sessions: sessions(),
    });
    const [, entry] = vi.mocked(recordConversationWorkLog).mock.calls[0];
    expect(entry).toMatchObject({
      kind: 'permission',
      ok: true,
      permission: { decision: 'approve_confirmed', ai: 'deny' },
    });
    expect(entry.text).toContain('2차 확인');
  });

  it.each([
    ['deny', false, '거부'],
    ['explain', false, '설명'],
  ] as const)('records %s', async (decision, ok, word) => {
    const id = await seed();
    await answerPermissionPrompt({ approvalId: id, actor: 'U_REQ', decision, sessions: sessions() });
    const [, entry] = vi.mocked(recordConversationWorkLog).mock.calls[0];
    expect(entry).toMatchObject({ kind: 'permission', ok, permission: { decision } });
    expect(entry.text).toContain(word);
  });

  it("records a task prompt's answer in the task's work log, on the turn that asked", async () => {
    const id = await seed({ channel: undefined, thread_ts: undefined, task_key: 'task-1', turn_id: 'turn-1' });
    await answerPermissionPrompt({ approvalId: id, actor: 'U_REQ', decision: 'deny', sessions: sessions() });
    const [conversationId, entry] = vi.mocked(recordConversationWorkLog).mock.calls[0];
    expect(conversationId).toBe('conv-task');
    expect(entry.turnId).toBe('turn-1');
  });

  it('records nothing for a refused answer', async () => {
    const id = await seed();
    await answerPermissionPrompt({ approvalId: id, actor: 'U_OTHER', decision: 'approve', sessions: sessions() });
    expect(recordConversationWorkLog).not.toHaveBeenCalled();
  });

  it('still answers when the work log cannot be reached', async () => {
    vi.mocked(recordConversationWorkLog).mockImplementationOnce(() => {
      throw new Error('store down');
    });
    const id = await seed();
    const result = await answerPermissionPrompt({
      approvalId: id,
      actor: 'U_REQ',
      decision: 'approve',
      sessions: sessions(),
    });
    expect(result.ok).toBe(true);
  });
});

/**
 * SSOT 2026-11-02 T2 — the prompt tool asks for the AI's advice BEFORE it
 * writes the prompt and posts the card, stores it on the pending approval
 * (so the dashboard shows the same advice), and posts the card in its colour.
 * A failing advisor never blocks the prompt: the card goes out with no advice.
 */

import { sharedStore } from '@soma/process-shared/permission/shared-store.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPermissionPromptHandler } from './permission-mcp-server.js';

const DENY = { recommendation: 'deny' as const, summary: '홈 폴더를 지웁니다', risk: '되돌릴 수 없습니다' };

function setup(resolveAdvice: (req: { toolName: string; input: unknown; ruleIds: string[] }) => Promise<unknown>) {
  const handler = createPermissionPromptHandler({
    slackToken: 'xoxb-advice-test',
    slackContext: { channel: 'C1', threadTs: '1.000', user: 'U1' },
    resolveAdvice: resolveAdvice as never,
  });
  const order: string[] = [];
  const stored: any[] = [];
  vi.spyOn(sharedStore, 'storePendingApproval').mockImplementation(async (_id, approval) => {
    order.push('store');
    stored.push(approval);
  });
  vi.spyOn(sharedStore, 'cleanup').mockResolvedValue(undefined);
  vi.spyOn(sharedStore, 'waitForPermissionResponse').mockResolvedValue({ behavior: 'deny', message: 'Denied by user' });
  const messenger = (handler as unknown as { messenger: any }).messenger;
  const send = vi.spyOn(messenger, 'sendPermissionRequest').mockImplementation(async () => {
    order.push('post');
    return { ts: '2.000', channel: 'C1' };
  });
  vi.spyOn(handler as any, 'deletePermissionMessage').mockResolvedValue(undefined);
  return { handler, order, stored, send };
}

afterEach(() => vi.restoreAllMocks());

describe('permission_prompt — AI advice', () => {
  it('asks for the advice first, stores it, and posts the card with it', async () => {
    const resolveAdvice = vi.fn(async () => DENY);
    const { handler, order, stored, send } = setup(resolveAdvice);
    resolveAdvice.mockImplementation(async () => {
      order.push('advice');
      return DENY;
    });

    await handler.handleTool('permission_prompt', { tool_name: 'Bash', input: { command: 'rm -rf ~' } });

    expect(order).toEqual(['advice', 'store', 'post']);
    expect(resolveAdvice).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Bash', input: { command: 'rm -rf ~' } }),
    );
    expect(stored[0].advice).toEqual(DENY);
    const [, blocks, , advice] = send.mock.calls[0] as unknown as [unknown, unknown[], string, unknown];
    expect(advice).toEqual(DENY);
    expect(JSON.stringify(blocks)).toContain('🔴');
  });

  it('posts the card with no advice when the advisor throws', async () => {
    const { handler, stored, send } = setup(async () => {
      throw new Error('guardian down');
    });
    await handler.handleTool('permission_prompt', { tool_name: 'Bash', input: { command: 'ls' } });
    expect(stored[0].advice).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls[0][1])).toContain('AI 추천 없음');
  });
});

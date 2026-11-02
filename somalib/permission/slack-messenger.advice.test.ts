/**
 * SSOT 2026-11-02 T2–T4 — the Slack permission card shows the AI's advice.
 *
 * - T3: the AI recommends → a green bar and a green "AI 추천" line; Approve stays the green button.
 * - T4: the AI says do not run → a red bar and a red "AI 권고" line; Deny becomes the green
 *   button, Approve the red one, and there is no "disable this rule" shortcut.
 * - No advice (the guardian failed or is off) → a neutral line, no bar.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PERMISSION_ADVICE_COLORS,
  type PermissionRuleSummary,
  permissionAdviceColor,
  SlackPermissionMessenger,
} from './slack-messenger';

const RULES: PermissionRuleSummary[] = [{ id: 'rm-recursive', label: 'rm -r', description: 'recursive delete' }];
const APPROVE = {
  recommendation: 'approve' as const,
  summary: '빌드 폴더를 지웁니다',
  risk: '빌드 산출물만 사라집니다',
};
const DENY = { recommendation: 'deny' as const, summary: '홈 폴더 전체를 지웁니다', risk: '되돌릴 수 없습니다' };

function messenger(postMessage = vi.fn().mockResolvedValue({ ts: '1.1', channel: 'C1' })) {
  return { m: new SlackPermissionMessenger({ chat: { postMessage } } as never), postMessage };
}

function text(blocks: any[]): string {
  return JSON.stringify(blocks);
}

function buttons(blocks: any[]): any[] {
  return blocks.find((b) => b.type === 'actions')?.elements ?? [];
}

describe('buildRequestBlocks — AI advice', () => {
  it('green: shows the recommendation, what it does and the risk', () => {
    const { m } = messenger();
    const blocks = m.buildRequestBlocks('Bash', { command: 'rm -rf ./build' }, 'approval_1', 'U1', RULES, APPROVE);
    const all = text(blocks);
    expect(all).toContain('🟢');
    expect(all).toContain('AI 추천');
    expect(all).toContain('빌드 폴더를 지웁니다');
    expect(all).toContain('빌드 산출물만 사라집니다');
    const approve = buttons(blocks).find((b) => b.action_id === 'approve_tool');
    const deny = buttons(blocks).find((b) => b.action_id === 'deny_tool');
    expect(approve.style).toBe('primary');
    expect(deny.style).toBe('danger');
    expect(buttons(blocks).some((b) => b.action_id === 'approve_disable_rule_session')).toBe(true);
  });

  it('red: warns not to run, flips the button colours, and drops the rule shortcut', () => {
    const { m } = messenger();
    const blocks = m.buildRequestBlocks('Bash', { command: 'rm -rf ~' }, 'approval_2', 'U1', RULES, DENY);
    const all = text(blocks);
    expect(all).toContain('🔴');
    expect(all).toContain('실행하지 마세요');
    expect(all).toContain('홈 폴더 전체를 지웁니다');
    expect(all).toContain('되돌릴 수 없습니다');
    // The second question is announced on the card.
    expect(all).toContain('한 번 더');
    const approve = buttons(blocks).find((b) => b.action_id === 'approve_tool');
    const deny = buttons(blocks).find((b) => b.action_id === 'deny_tool');
    expect(approve.style).toBe('danger');
    expect(deny.style).toBe('primary');
    expect(buttons(blocks).some((b) => b.action_id === 'approve_disable_rule_session')).toBe(false);
  });

  it('no advice: a neutral line, the card otherwise as before', () => {
    const { m } = messenger();
    const blocks = m.buildRequestBlocks('Bash', { command: 'ls' }, 'approval_3', 'U1', [], null);
    const all = text(blocks);
    expect(all).toContain('AI 추천 없음');
    expect(all).not.toContain('🟢');
    expect(all).not.toContain('🔴');
  });

  it('escapes the advice so it cannot mention or link anyone', () => {
    const { m } = messenger();
    const blocks = m.buildRequestBlocks('Bash', { command: 'x' }, 'approval_4', 'U1', [], {
      recommendation: 'deny',
      summary: '<!channel> ping & <https://evil.test|click>',
      risk: '<@U999>',
    });
    const all = text(blocks);
    expect(all).not.toContain('<!channel>');
    expect(all).not.toContain('<@U999>');
    expect(all).toContain('&lt;!channel&gt;');
  });
});

describe('permissionAdviceColor / sendPermissionRequest', () => {
  it('green for approve, red for deny, none without advice', () => {
    expect(permissionAdviceColor(APPROVE)).toBe(PERMISSION_ADVICE_COLORS.approve);
    expect(permissionAdviceColor(DENY)).toBe(PERMISSION_ADVICE_COLORS.deny);
    expect(permissionAdviceColor(null)).toBeUndefined();
    expect(PERMISSION_ADVICE_COLORS.approve.toLowerCase()).toBe('#2eb67d');
    expect(PERMISSION_ADVICE_COLORS.deny.toLowerCase()).toBe('#e01e5a');
  });

  it('posts an advised card inside a coloured attachment', async () => {
    const { m, postMessage } = messenger();
    const blocks = m.buildRequestBlocks('Bash', { command: 'rm -rf ~' }, 'approval_5', 'U1', [], DENY);
    await m.sendPermissionRequest({ channel: 'C1', threadTs: '1.0', user: 'U1' }, blocks, 'Bash', DENY);
    const args = postMessage.mock.calls[0][0];
    expect(args.attachments).toEqual([expect.objectContaining({ color: PERMISSION_ADVICE_COLORS.deny, blocks })]);
    expect(args.blocks).toBeUndefined();
    expect(args.thread_ts).toBe('1.0');
  });

  it('posts a card with no advice as plain blocks', async () => {
    const { m, postMessage } = messenger();
    const blocks = m.buildRequestBlocks('Bash', { command: 'ls' }, 'approval_6', 'U1', [], null);
    await m.sendPermissionRequest({ channel: 'C1', threadTs: '1.0', user: 'U1' }, blocks, 'Bash', null);
    const args = postMessage.mock.calls[0][0];
    expect(args.blocks).toBe(blocks);
    expect(args.attachments).toBeUndefined();
  });
});

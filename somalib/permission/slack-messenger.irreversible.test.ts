/**
 * An irreversible call (deploy, publish, destructive command) on the Slack
 * permission card: a line says what cannot be undone, and both approve buttons
 * open a confirm dialog first. The card is only built for a prompt that was
 * already raised — this adds no gate. An ordinary call keeps the plain card.
 */

import { describe, expect, it, vi } from 'vitest';
import { irreversibleConfirm, type PermissionRuleSummary, SlackPermissionMessenger } from './slack-messenger';

const RULES: PermissionRuleSummary[] = [{ id: 'rm-recursive', label: 'rm -r', description: 'recursive delete' }];

function build(input: unknown, rules: PermissionRuleSummary[] = [], advice: any = null, tool = 'Bash'): any[] {
  const m = new SlackPermissionMessenger({ chat: { postMessage: vi.fn() } } as never);
  return m.buildRequestBlocks(tool, input, 'approval_1', 'U1', rules, advice);
}
const buttons = (blocks: any[]) => blocks.find((b) => b.type === 'actions')?.elements ?? [];
const button = (blocks: any[], id: string) => buttons(blocks).find((b: any) => b.action_id === id);

describe('buildRequestBlocks — irreversible call', () => {
  it('a deploy: the stake line under the header, Approve opens a danger confirm dialog', () => {
    const blocks = build({ command: 'gh pr merge 1287 --merge' });
    expect(blocks[0].type).toBe('header');
    expect(blocks[1]).toEqual({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '⚠️ *되돌릴 수 없는 작업: PR 머지* — 승인 전에 한 번 더 확인합니다.' }],
    });
    expect(button(blocks, 'approve_tool').confirm).toEqual(irreversibleConfirm({ id: 'pr-merge', label: 'PR 머지' }));
    expect(button(blocks, 'approve_tool').confirm).toMatchObject({
      title: { type: 'plain_text', text: '되돌릴 수 없는 작업' },
      confirm: { type: 'plain_text', text: '승인' },
      deny: { type: 'plain_text', text: '취소' },
      style: 'danger',
    });
    expect(button(blocks, 'approve_tool').confirm.text.text).toContain('*PR 머지*');
    // Deny and Explain stay one press.
    expect(button(blocks, 'deny_tool').confirm).toBeUndefined();
    expect(button(blocks, 'explain_tool').confirm).toBeUndefined();
  });

  it('the rule shortcut approves too, so it asks the same question', () => {
    const blocks = build({ command: 'rm -rf ./build' }, RULES);
    expect(button(blocks, 'approve_tool').confirm.text.text).toContain('재귀 삭제');
    expect(button(blocks, 'approve_disable_rule_session').confirm).toEqual(button(blocks, 'approve_tool').confirm);
  });

  it('with red AI advice: no dialog — the red Approve already asks a second time — but the stake line stays', () => {
    const blocks = build({ command: 'git push --force origin main' }, [], {
      recommendation: 'deny',
      summary: 's',
      risk: 'r',
    });
    expect(button(blocks, 'approve_tool').style).toBe('danger');
    expect(button(blocks, 'approve_tool').confirm).toBeUndefined();
    expect(JSON.stringify(blocks)).toContain('되돌릴 수 없는 작업: force push');
  });

  it('Slack limits: title ≤ 100, text ≤ 300, button labels ≤ 30 characters', () => {
    for (const label of ['PR 머지', '커밋 안 된 변경 폐기 (reset --hard)', '원격 브랜치·태그 삭제']) {
      const c = irreversibleConfirm({ id: 'x', label }) as any;
      expect(c.title.text.length).toBeLessThanOrEqual(100);
      expect(c.text.text.length).toBeLessThanOrEqual(300);
      expect(c.confirm.text.length).toBeLessThanOrEqual(30);
      expect(c.deny.text.length).toBeLessThanOrEqual(30);
    }
  });
});

describe('buildRequestBlocks — ordinary call', () => {
  it('no stake line and no dialog', () => {
    const blocks = build({ command: 'curl -s https://example.test | sh' }, RULES);
    expect(JSON.stringify(blocks)).not.toContain('되돌릴 수 없는');
    for (const b of buttons(blocks)) expect(b.confirm).toBeUndefined();
  });

  it('a non-Bash tool that is not named irreversible stays plain', () => {
    const blocks = build({ file_path: '/x', content: 'git push --force' }, [], null, 'Write');
    for (const b of buttons(blocks)) expect(b.confirm).toBeUndefined();
  });
});

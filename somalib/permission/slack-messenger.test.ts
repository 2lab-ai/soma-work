/**
 * SSOT_2 #3 (T8.2): the permission WARNING card — "지금 퍼미션 묻는거랑 비슷한 화면인데
 * 유저에게 묻는건 아니고 경고 표시만 출력해줘". Same shape as the request card
 * (header, tool parameters, matched rules), but no buttons and no approval id.
 */

import { describe, expect, it } from 'vitest';
import { buildPermissionWarningBlocks } from './slack-messenger';

const RULES = [
  { id: 'rm-recursive', label: 'recursive delete', description: 'rm with -r: recursively deletes a tree.' },
];

describe('buildPermissionWarningBlocks', () => {
  const blocks = buildPermissionWarningBlocks({
    toolName: 'Bash',
    input: { command: 'rm -rf /tmp/scratch-1', description: 'Remove scratch' },
    user: 'U1',
    rules: RULES,
    reason: 'owner asked to clean the scratch dir',
  }) as Array<{ type: string; text?: { text: string }; elements?: Array<{ text?: string }> }>;
  const all = JSON.stringify(blocks);

  it('looks like the permission request card: header, parameters, matched rules', () => {
    expect(blocks[0].type).toBe('header');
    expect(blocks[0].text?.text).toBe('⚠️ Permission Warning — Bash');
    expect(all).toContain('rm -rf /tmp/scratch-1');
    expect(all).toContain('`rm-recursive` — recursive delete');
  });

  it('says the model approved it and why, and that nothing is asked', () => {
    expect(all).toContain('owner asked to clean the scratch dir');
    expect(all).toMatch(/auto mode approved/i);
    expect(all).toMatch(/no action needed/i);
  });

  it('has no buttons and no approval id', () => {
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(all).not.toMatch(/approve_tool|deny_tool|approval_/);
  });

  it('keeps every text block under the Slack section limit', () => {
    const huge = buildPermissionWarningBlocks({
      toolName: 'Bash',
      input: { command: 'x'.repeat(10_000) },
      rules: RULES,
      reason: 'r',
    }) as Array<{ text?: { text: string } }>;
    for (const b of huge) if (b.text) expect(b.text.text.length).toBeLessThanOrEqual(3000);
  });
});

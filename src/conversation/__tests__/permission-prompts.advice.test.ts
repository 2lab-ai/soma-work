/**
 * SSOT 2026-11-02 T2–T4 — what the dashboard serves about a prompt's AI advice.
 *
 * The board (every viewer) carries only the recommendation, so the card can be
 * coloured; what the call does and why it is risky (it can quote the command)
 * stays in the requester-only detail, like the input. A red prompt offers no
 * "disable this rule" shortcut.
 */
import { describe, expect, it } from 'vitest';
import { permissionPromptDetail } from '../permission-prompts';

const base = {
  kind: 'tool_permission' as const,
  tool_name: 'Bash',
  input: { command: 'rm -rf ~/work' },
  channel: 'C1',
  thread_ts: '1.0',
  user: 'U1',
  created_at: 1,
  expires_at: 2,
  rule_ids: ['rm-recursive'],
};

describe('permission prompt data — AI advice', () => {
  it('red: the recommendation on the board, the reasons in the detail, no rule shortcut', () => {
    const d = permissionPromptDetail('approval_1', {
      ...base,
      advice: { recommendation: 'deny', summary: '홈 폴더를 지웁니다', risk: '되돌릴 수 없습니다' },
    });
    expect(d.aiRecommendation).toBe('deny');
    expect(d.canDisableRule).toBe(false);
    expect(d.advice).toEqual({ recommendation: 'deny', summary: '홈 폴더를 지웁니다', risk: '되돌릴 수 없습니다' });
  });

  it('green keeps the rule shortcut; no advice → no recommendation', () => {
    const green = permissionPromptDetail('approval_2', {
      ...base,
      advice: { recommendation: 'approve', summary: 's', risk: 'r' },
    });
    expect(green.aiRecommendation).toBe('approve');
    expect(green.canDisableRule).toBe(true);
    const none = permissionPromptDetail('approval_3', base);
    expect(none.aiRecommendation).toBeUndefined();
    expect(none.advice).toBeUndefined();
  });
});

/**
 * SSOT 2026-10-23 T7 — "토글 on 하면 그냥 대화 내역 맨 끝에 $autoz 추가하면 알아서
 * autoz 스킬이 발동됨". End-to-end on the real parser: the text the composer
 * sends with autoz on is recognised by the `$skill` force handler, and the
 * skill it resolves is the shipped `autoz` skill.
 */
import { describe, expect, it } from 'vitest';
import { SkillForceHandler } from '../../slack/commands/skill-force-handler';
import { composeTaskText } from '../new-task';

describe('autoz toggle → `$autoz` force-fires the autoz skill', () => {
  it('the composed text is claimed by the skill force handler', () => {
    const text = composeTaskText('soma-work 대시보드 개선해줘\n블라블라', true);
    expect(new SkillForceHandler().canHandle(text)).toBe(true);
  });

  it('without the toggle the same instruction is not a skill invocation', () => {
    const text = composeTaskText('soma-work 대시보드 개선해줘\n블라블라', false);
    expect(new SkillForceHandler().canHandle(text)).toBe(false);
  });
});

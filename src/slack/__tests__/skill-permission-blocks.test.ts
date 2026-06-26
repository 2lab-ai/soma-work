import { describe, expect, it } from 'vitest';
import {
  buildPermissionRequestMessage,
  SKILL_PERM_ACTION_ID_PREFIX,
  VALUE_KIND_PERM_ALLOW_ALL,
  VALUE_KIND_PERM_ALLOW_SKILL,
  VALUE_KIND_PERM_YES_ONCE,
} from '../skill-permission-blocks';

/**
 * RED tests for the permission-request prompt sent to the skill owner (B).
 * Three buttons, each carrying ONLY the requestId in its value; the owner is
 * mentioned so they get notified.
 */
describe('buildPermissionRequestMessage', () => {
  const msg = buildPermissionRequestMessage({
    requestId: 'req-123',
    requesterId: 'U0A',
    ownerId: 'U0B',
    skillName: 'deploy',
  });

  it('mentions both the owner and the requester and names the skill', () => {
    const allText = JSON.stringify(msg);
    expect(allText).toContain('<@U0B>'); // owner notified
    expect(allText).toContain('<@U0A>'); // requester named
    expect(allText).toContain('deploy');
  });

  it('renders exactly 3 buttons with skill_perm_ action_ids', () => {
    const actions = msg.blocks.find((b: any) => b.type === 'actions');
    expect(actions).toBeTruthy();
    expect(actions.elements.length).toBe(3);
    for (const el of actions.elements) {
      expect(el.type).toBe('button');
      expect(el.action_id.startsWith(SKILL_PERM_ACTION_ID_PREFIX)).toBe(true);
    }
  });

  it('each button value carries ONLY the requestId (no forgeable owner/skill fields)', () => {
    const actions = msg.blocks.find((b: any) => b.type === 'actions');
    const kinds = actions.elements.map((el: any) => {
      const v = JSON.parse(el.value);
      expect(Object.keys(v).sort()).toEqual(['kind', 'requestId']);
      expect(v.requestId).toBe('req-123');
      return v.kind;
    });
    expect(kinds).toEqual([VALUE_KIND_PERM_YES_ONCE, VALUE_KIND_PERM_ALLOW_SKILL, VALUE_KIND_PERM_ALLOW_ALL]);
  });
});

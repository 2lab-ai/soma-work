import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-skill-store', () => ({ listUserSkills: vi.fn(() => []) }));

import { SkillsHandler } from '../skills-handler';

/**
 * `skills list` takes the leading `/` like every other bare command — the dashboard's `/` menu inserts `/skills
 * list` (composer-menus.ts) — and the slash form must reach the same list, not fall through as unhandled.
 */
describe('SkillsHandler — /skills list', () => {
  it.each([
    'skills list',
    '/skills list',
    'skill list',
    '/SKILLS LIST',
  ])('“%s” is claimed and answered', async (text) => {
    const h = new SkillsHandler();
    expect(h.canHandle(text)).toBe(true);
    const say = vi.fn().mockResolvedValue(undefined);
    const result = await h.execute({ text, user: 'U1', say, threadTs: '1.1', channel: 'C1' } as never);
    expect(result.handled).toBe(true);
    expect(say).toHaveBeenCalledTimes(1);
  });

  it('other text is not claimed', () => {
    expect(new SkillsHandler().canHandle('skills are great')).toBe(false);
  });
});

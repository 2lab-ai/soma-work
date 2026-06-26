import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as userSkillStore from '../../../user-skill-store';
import { UserSkillsListHandler } from '../user-skills-list-handler';

vi.mock('../../../user-skill-store');

/**
 * RED tests for `$user:{otherUser}` — listing ANOTHER user's skills with a
 * view + copy hamburger menu (S4). Own-skill invocation (`$user:{myskill}`)
 * still wins for backward compatibility and falls through to SkillForceHandler.
 */
const skill = (name: string, description = '', isSingleFile = true) => ({ name, description, isSingleFile });

describe('UserSkillsListHandler — cross-user list (S4)', () => {
  const resolveUser = (token: string): string | null => (token === 'Zhuge' ? 'U094' : null);
  const handler = new UserSkillsListHandler(resolveUser);
  const mockSay = vi.fn().mockResolvedValue({ ts: '1' });

  const makeCtx = (text: string, user = 'U1') => ({ user, channel: 'C1', threadTs: '171.100', text, say: mockSay });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('canHandle()', () => {
    it('claims "$user:Zhuge" when it resolves to another user', () => {
      vi.mocked(userSkillStore.userSkillExists).mockReturnValue(false);
      expect(handler.canHandle('$user:Zhuge', 'U1')).toBe(true);
    });

    it('does NOT claim "$user:my-deploy" when it is the requester’s own skill', () => {
      vi.mocked(userSkillStore.userSkillExists).mockImplementation((_u, n) => n === 'my-deploy');
      expect(handler.canHandle('$user:my-deploy', 'U1')).toBe(false);
    });

    it('does NOT claim when the target resolves to the requester themselves', () => {
      vi.mocked(userSkillStore.userSkillExists).mockReturnValue(false);
      expect(handler.canHandle('$user:Zhuge', 'U094')).toBe(false);
    });

    it('does NOT claim "$user:unknown" when it resolves to nobody', () => {
      vi.mocked(userSkillStore.userSkillExists).mockReturnValue(false);
      expect(handler.canHandle('$user:unknown', 'U1')).toBe(false);
    });

    it('does NOT claim "$user:foo" when requester is unknown (no userId)', () => {
      expect(handler.canHandle('$user:foo')).toBe(false);
    });

    it('still claims bare "$user"', () => {
      expect(handler.canHandle('$user', 'U1')).toBe(true);
    });
  });

  describe('execute()', () => {
    it('renders another user’s skills with invoke/view/copy overflow carrying ownerId', async () => {
      vi.mocked(userSkillStore.userSkillExists).mockReturnValue(false);
      vi.mocked(userSkillStore.listUserSkills).mockReturnValue([
        skill('deploy', 'deploy helper'),
        skill('qa', 'qa it'),
      ]);

      const result = await handler.execute(makeCtx('$user:Zhuge', 'U1'));

      expect(result).toEqual({ handled: true });
      const arg = mockSay.mock.calls[0][0];
      const sections = arg.blocks.filter((b: any) => b.type === 'section');
      expect(sections.length).toBe(2);
      for (const b of sections) {
        expect(b.accessory.type).toBe('overflow');
        const kinds = b.accessory.options.map((o: any) => JSON.parse(o.value).kind);
        expect(kinds).toContain('user_skill_view');
        expect(kinds).toContain('user_skill_copy');
        for (const o of b.accessory.options) {
          const v = JSON.parse(o.value);
          expect(v.ownerId).toBe('U094'); // source user
          expect(v.requesterId).toBe('U1'); // clicker / lister
        }
      }
    });

    it('emits a "no skills" message when the other user has none', async () => {
      vi.mocked(userSkillStore.userSkillExists).mockReturnValue(false);
      vi.mocked(userSkillStore.listUserSkills).mockReturnValue([]);

      const result = await handler.execute(makeCtx('$user:Zhuge', 'U1'));
      expect(result).toEqual({ handled: true });
      expect(mockSay.mock.calls[0][0].blocks).toBeUndefined();
    });
  });
});

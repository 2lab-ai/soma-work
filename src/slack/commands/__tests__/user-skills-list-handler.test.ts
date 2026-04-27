import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as userSkillStore from '../../../user-skill-store';
import { UserSkillsListHandler } from '../user-skills-list-handler';

vi.mock('../../../user-skill-store');

/** Convenience builder — issue #750 added `isSingleFile` to UserSkillMeta. */
const skill = (name: string, description = '', isSingleFile = true) => ({ name, description, isSingleFile });

describe('UserSkillsListHandler', () => {
  const handler = new UserSkillsListHandler();
  const mockSay = vi.fn().mockResolvedValue({ ts: '1' });

  const makeCtx = (text: string, user = 'U1') => ({
    user,
    channel: 'C1',
    threadTs: '171.100',
    text,
    say: mockSay,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('canHandle()', () => {
    it('matches exact "$user"', () => {
      expect(handler.canHandle('$user')).toBe(true);
    });

    it('matches "$user" with surrounding whitespace', () => {
      expect(handler.canHandle('  $user  ')).toBe(true);
    });

    it('matches "$USER" case-insensitively', () => {
      expect(handler.canHandle('$USER')).toBe(true);
    });

    it('does NOT match "$user:foo" (qualified ref)', () => {
      expect(handler.canHandle('$user:foo')).toBe(false);
    });

    it('does NOT match "$user something"', () => {
      expect(handler.canHandle('$user something')).toBe(false);
    });

    it('does NOT match "skills list"', () => {
      expect(handler.canHandle('skills list')).toBe(false);
    });

    it('does NOT match plain text', () => {
      expect(handler.canHandle('hello')).toBe(false);
    });

    it('does NOT match "$users" (different bare ref)', () => {
      expect(handler.canHandle('$users')).toBe(false);
    });
  });

  describe('execute()', () => {
    it('emits a "no skills" message when listUserSkills returns empty', async () => {
      vi.mocked(userSkillStore.listUserSkills).mockReturnValue([]);

      const result = await handler.execute(makeCtx('$user'));

      expect(result).toEqual({ handled: true });
      expect(mockSay).toHaveBeenCalledTimes(1);
      const arg = mockSay.mock.calls[0][0];
      expect(arg.thread_ts).toBe('171.100');
      expect(arg.text).toMatch(/personal skill/);
      expect(arg.blocks).toBeUndefined();
    });

    it('emits per-skill section blocks with overflow accessory for single-file skills', async () => {
      vi.mocked(userSkillStore.listUserSkills).mockReturnValue([
        skill('a', 'first skill'),
        skill('deploy', 'deploy helper'),
      ]);

      const result = await handler.execute(makeCtx('$user', 'U42'));

      expect(result).toEqual({ handled: true });
      expect(mockSay).toHaveBeenCalledTimes(1);
      const arg = mockSay.mock.calls[0][0];
      expect(arg.thread_ts).toBe('171.100');
      expect(arg.text).toMatch(/Personal Skills.*2/);
      expect(Array.isArray(arg.blocks)).toBe(true);
      // One section block per skill
      const sectionBlocks = arg.blocks.filter((b: any) => b.type === 'section');
      expect(sectionBlocks.length).toBe(2);
      // Each section has an overflow accessory carrying invoke + edit options.
      for (const b of sectionBlocks) {
        expect(b.accessory?.type).toBe('overflow');
        expect(b.accessory?.action_id).toMatch(/^user_skill_menu_/);
        const opts = b.accessory.options;
        expect(opts.length).toBe(2);
        const kinds = opts.map((o: any) => JSON.parse(o.value).kind);
        expect(kinds).toEqual(['user_skill_invoke', 'user_skill_edit']);
        for (const o of opts) {
          const v = JSON.parse(o.value);
          expect(v.requesterId).toBe('U42');
          expect(typeof v.skillName).toBe('string');
        }
      }
      // Skill names appear in section text
      const allText = sectionBlocks.map((b: any) => b.text?.text).join('\n');
      expect(allText).toContain('$user:a');
      expect(allText).toContain('$user:deploy');
    });

    it('renders multi-file skills with a button (BC) accessory + inline label', async () => {
      vi.mocked(userSkillStore.listUserSkills).mockReturnValue([skill('multi', 'multi-file skill', false)]);

      await handler.execute(makeCtx('$user', 'U7'));

      const blocks = mockSay.mock.calls[0][0].blocks;
      const section = blocks.find((b: any) => b.type === 'section');
      // Inline label is part of the section text — no separate context block.
      expect(section.text.text).toMatch(/multi-file/i);
      expect(blocks.filter((b: any) => b.type === 'context').length).toBe(0);
      // Accessory must be the legacy button with `user_skill_invoke_` prefix
      // so older clients (or in-flight messages) still route correctly.
      expect(section.accessory.type).toBe('button');
      expect(section.accessory.action_id).toMatch(/^user_skill_invoke_/);
      const v = JSON.parse(section.accessory.value);
      expect(v.kind).toBe('user_skill_invoke');
      expect(v.skillName).toBe('multi');
      expect(v.requesterId).toBe('U7');
    });

    it('mixes single + multi-file skills in a single render', async () => {
      vi.mocked(userSkillStore.listUserSkills).mockReturnValue([
        skill('single', 's', true),
        skill('multi', 'm', false),
      ]);

      await handler.execute(makeCtx('$user'));

      const blocks = mockSay.mock.calls[0][0].blocks;
      const sections = blocks.filter((b: any) => b.type === 'section');
      const singleSection = sections.find((b: any) => b.text.text.includes('$user:single'));
      const multiSection = sections.find((b: any) => b.text.text.includes('$user:multi'));
      expect(singleSection.accessory.type).toBe('overflow');
      expect(multiSection.accessory.type).toBe('button');
    });

    it('truncates long descriptions to 200 chars', async () => {
      const longDesc = 'x'.repeat(500);
      vi.mocked(userSkillStore.listUserSkills).mockReturnValue([skill('long', longDesc)]);

      await handler.execute(makeCtx('$user'));

      const blocks = mockSay.mock.calls[0][0].blocks;
      const sectionText = blocks.find((b: any) => b.type === 'section').text.text;
      // description should be truncated; total section text should not contain the full 500-char string
      expect(sectionText.length).toBeLessThan(400);
      expect(sectionText).not.toContain('x'.repeat(201));
    });

    it('escapes Slack mrkdwn metacharacters in description', async () => {
      vi.mocked(userSkillStore.listUserSkills).mockReturnValue([skill('esc', '<@U999> & <https://x|x>')]);

      await handler.execute(makeCtx('$user'));

      const blocks = mockSay.mock.calls[0][0].blocks;
      const sectionText = blocks.find((b: any) => b.type === 'section').text.text;
      expect(sectionText).not.toContain('<@U999>');
      expect(sectionText).toContain('&lt;@U999&gt;');
      expect(sectionText).toContain('&amp;');
    });

    it('handles skills with no description gracefully', async () => {
      vi.mocked(userSkillStore.listUserSkills).mockReturnValue([skill('bare', '')]);

      await handler.execute(makeCtx('$user'));

      const blocks = mockSay.mock.calls[0][0].blocks;
      const sectionText = blocks.find((b: any) => b.type === 'section').text.text;
      expect(sectionText).toContain('$user:bare');
    });

    it('renders 50 skills without overflow context block', async () => {
      const skills = Array.from({ length: 50 }, (_, i) => skill(`s${i.toString().padStart(2, '0')}`, `desc ${i}`));
      vi.mocked(userSkillStore.listUserSkills).mockReturnValue(skills);

      await handler.execute(makeCtx('$user'));

      const blocks = mockSay.mock.calls[0][0].blocks;
      const sectionBlocks = blocks.filter((b: any) => b.type === 'section');
      const contextBlocks = blocks.filter((b: any) => b.type === 'context');
      expect(sectionBlocks.length).toBe(50);
      expect(contextBlocks.length).toBe(0);
      expect(blocks.length).toBeLessThanOrEqual(50);
    });

    it('defensively trims to 49 sections + context block when store cap exceeded (future-proof)', async () => {
      const skills = Array.from({ length: 60 }, (_, i) => skill(`s${i.toString().padStart(2, '0')}`, `desc ${i}`));
      vi.mocked(userSkillStore.listUserSkills).mockReturnValue(skills);

      await handler.execute(makeCtx('$user'));

      const blocks = mockSay.mock.calls[0][0].blocks;
      const sectionBlocks = blocks.filter((b: any) => b.type === 'section');
      const contextBlocks = blocks.filter((b: any) => b.type === 'context');
      // Should trim sections to 49 and add 1 context block → total ≤ 50
      expect(sectionBlocks.length).toBe(49);
      expect(contextBlocks.length).toBe(1);
      expect(blocks.length).toBeLessThanOrEqual(50);
    });
  });
});

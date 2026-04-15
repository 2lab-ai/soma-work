import * as fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillForceHandler } from './skill-force-handler';

// Mock fs module
vi.mock('node:fs');

// Mock env-paths to provide PLUGINS_DIR and DATA_DIR
vi.mock('../../env-paths', () => ({
  PLUGINS_DIR: '/mock/plugins',
  DATA_DIR: '/mock/data',
}));

describe('SkillForceHandler', () => {
  const handler = new SkillForceHandler();
  const mockSay = vi.fn().mockResolvedValue({ ts: '1' });

  const makeCtx = (text: string) => ({
    user: 'U1',
    channel: 'C1',
    threadTs: '171.100',
    text,
    say: mockSay,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('canHandle()', () => {
    it('matches "$local:z"', () => {
      expect(handler.canHandle('$local:z')).toBe(true);
    });

    it('matches "$local:zcheck"', () => {
      expect(handler.canHandle('$local:zcheck')).toBe(true);
    });

    it('matches "$stv:new-task"', () => {
      expect(handler.canHandle('$stv:new-task')).toBe(true);
    });

    it('matches "$superpowers:brainstorming"', () => {
      expect(handler.canHandle('$superpowers:brainstorming')).toBe(true);
    });

    it('matches text containing $local:z', () => {
      expect(handler.canHandle('이거 $local:z 해줘')).toBe(true);
    });

    it('matches text starting with $stv:new-task', () => {
      expect(handler.canHandle('$stv:new-task 해줘')).toBe(true);
    });

    it('matches multiple skill references', () => {
      expect(handler.canHandle('$local:zcheck 하고 $local:ztrace 해줘')).toBe(true);
    });

    it('matches mixed plugin references', () => {
      expect(handler.canHandle('$local:z 하고 $stv:debug 해줘')).toBe(true);
    });

    it('does NOT match plain text', () => {
      expect(handler.canHandle('hello world')).toBe(false);
    });

    it('does NOT match $model', () => {
      expect(handler.canHandle('$model opus')).toBe(false);
    });

    it('does NOT match $verbosity', () => {
      expect(handler.canHandle('$verbosity compact')).toBe(false);
    });

    it('does NOT match $effort', () => {
      expect(handler.canHandle('$effort high')).toBe(false);
    });

    it('does NOT match partial $local without colon', () => {
      expect(handler.canHandle('$local something')).toBe(false);
    });
  });

  describe('execute()', () => {
    it('embeds single local skill content via continueWithPrompt', async () => {
      const skillContent = '# Z Skill\nDo the thing.';
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(skillContent);

      const result = await handler.execute(makeCtx('$local:z'));

      expect(result.handled).toBe(true);
      expect(result.continueWithPrompt).toBeDefined();
      expect(result.continueWithPrompt).toContain('$local:z');
      expect(result.continueWithPrompt).toContain('<invoked_skills>');
      expect(result.continueWithPrompt).toContain('<local:z>');
      expect(result.continueWithPrompt).toContain(skillContent);
      expect(result.continueWithPrompt).toContain('</local:z>');
      expect(result.continueWithPrompt).toContain('</invoked_skills>');
    });

    it('embeds stv plugin skill', async () => {
      const skillContent = '# New Task\nCreate issues.';
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(skillContent);

      const result = await handler.execute(makeCtx('$stv:new-task'));

      expect(result.handled).toBe(true);
      const prompt = result.continueWithPrompt as string;
      expect(prompt).toContain('<stv:new-task>');
      expect(prompt).toContain(skillContent);
      expect(prompt).toContain('</stv:new-task>');
    });

    it('resolves stv skills from PLUGINS_DIR', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('# Skill');

      await handler.execute(makeCtx('$stv:debug'));

      // Verify the path used for stv plugin (should use PLUGINS_DIR)
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(
        expect.stringContaining('/mock/plugins/stv/skills/debug/SKILL.md'),
      );
    });

    it('resolves local skills from LOCAL_SKILLS_DIR', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('# Skill');

      await handler.execute(makeCtx('$local:z'));

      // Verify the path used for local plugin (should use __dirname-based path)
      expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(expect.stringContaining('local/skills/z/SKILL.md'));
    });

    it('embeds multiple skills in order', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('/zcheck/')) return '# ZCheck Skill';
        if (p.includes('/ztrace/')) return '# ZTrace Skill';
        return '';
      });

      const result = await handler.execute(makeCtx('$local:zcheck 하고 $local:ztrace 해줘'));

      expect(result.handled).toBe(true);
      const prompt = result.continueWithPrompt as string;
      expect(prompt).toContain('<local:zcheck>');
      expect(prompt).toContain('<local:ztrace>');
      const zcheckPos = prompt.indexOf('<local:zcheck>');
      const ztracePos = prompt.indexOf('<local:ztrace>');
      expect(zcheckPos).toBeLessThan(ztracePos);
    });

    it('handles mixed plugin skills', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('/z/')) return '# Z Skill';
        if (p.includes('/debug/')) return '# Debug Skill';
        return '';
      });

      const result = await handler.execute(makeCtx('$local:z 하고 $stv:debug 해줘'));

      expect(result.handled).toBe(true);
      const prompt = result.continueWithPrompt as string;
      expect(prompt).toContain('<local:z>');
      expect(prompt).toContain('<stv:debug>');
    });

    it('recursively resolves nested skill references across plugins', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        const p = String(filePath);
        if (p.includes('/z/')) return '# Z\nDispatch to $local:zcheck for verification.';
        if (p.includes('/zcheck/')) return '# ZCheck\nVerify the PR.';
        return '';
      });

      const result = await handler.execute(makeCtx('$local:z'));

      expect(result.handled).toBe(true);
      const prompt = result.continueWithPrompt as string;
      expect(prompt).toContain('<local:z>');
      expect(prompt).toContain('<local:zcheck>');
      // zcheck (dependency) should appear before z (depth-first order)
      const zcheckPos = prompt.indexOf('<local:zcheck>');
      const zPos = prompt.indexOf('<local:z>');
      expect(zcheckPos).toBeLessThan(zPos);
    });

    it('deduplicates skill references', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('# Skill content');

      const result = await handler.execute(makeCtx('$local:z and again $local:z'));

      expect(result.handled).toBe(true);
      const matches = (result.continueWithPrompt as string).match(/<local:z>/g);
      expect(matches).toHaveLength(1);
    });

    it('shows error when skill file not found', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result = await handler.execute(makeCtx('$local:nonexistent'));

      expect(result.handled).toBe(true);
      expect(result.continueWithPrompt).toBeUndefined();
      expect(mockSay).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('nonexistent'),
        }),
      );
    });

    it('preserves original user text before invoked_skills block', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('# Skill');

      const userText = '이 기능 구현해줘 $local:z';
      const result = await handler.execute(makeCtx(userText));

      expect(result.continueWithPrompt).toMatch(/^이 기능 구현해줘 \$local:z\n\n<invoked_skills>/);
    });

    it('handles partial failure gracefully', async () => {
      vi.mocked(fs.existsSync).mockImplementation((filePath) => {
        return String(filePath).includes('/z/');
      });
      vi.mocked(fs.readFileSync).mockReturnValue('# Z Skill');

      const result = await handler.execute(makeCtx('$local:z and $local:nonexistent'));

      expect(result.handled).toBe(true);
      expect(result.continueWithPrompt).toContain('<local:z>');
      expect(result.continueWithPrompt).not.toContain('<local:nonexistent>');
    });

    it('works when $skill is at sentence start', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('# Skill');

      const result = await handler.execute(makeCtx('$stv:new-task 이거 해줘'));

      expect(result.handled).toBe(true);
      const prompt = result.continueWithPrompt as string;
      expect(prompt).toMatch(/^\$stv:new-task 이거 해줘\n\n<invoked_skills>/);
      expect(prompt).toContain('<stv:new-task>');
    });
  });
});

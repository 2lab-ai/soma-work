import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the skill resolver so the test never touches real SKILL.md files.
vi.mock('../skill-locator', () => ({
  resolveAutoskillContent: vi.fn(),
}));

import { PromptBuilder } from '../prompt-builder';
import { resolveAutoskillContent } from '../skill-locator';
import { userSettingsStore } from '../user-settings-store';

const U = 'U_PROMPT';

describe('PromptBuilder.applyAutoskills (via buildSystemPrompt)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(userSettingsStore, 'getUserAutoskills').mockReturnValue(['using-ssot', 'using-govuk']);
  });

  afterEach(() => vi.restoreAllMocks());

  it('injects resolved autoskill content in an <auto_invoked_skills> block', () => {
    vi.mocked(resolveAutoskillContent).mockImplementation((name: string) =>
      name === 'using-ssot'
        ? { key: 'local:using-ssot', content: 'SSOT RULES' }
        : { key: 'local:using-govuk', content: 'GOVUK RULES' },
    );

    const prompt = new PromptBuilder().buildSystemPrompt(U);
    expect(prompt).toBeDefined();
    expect(prompt).toContain('<auto_invoked_skills>');
    expect(prompt).toContain('<local:using-ssot>');
    expect(prompt).toContain('SSOT RULES');
    expect(prompt).toContain('<local:using-govuk>');
    expect(prompt).toContain('GOVUK RULES');
  });

  it('skips names that do not resolve, without failing the build', () => {
    vi.mocked(resolveAutoskillContent).mockImplementation((name: string) =>
      name === 'using-ssot' ? { key: 'local:using-ssot', content: 'SSOT RULES' } : null,
    );

    const prompt = new PromptBuilder().buildSystemPrompt(U);
    expect(prompt).toContain('SSOT RULES');
    expect(prompt).not.toContain('using-govuk');
  });

  it('adds no block when the user has no autoskills', () => {
    vi.spyOn(userSettingsStore, 'getUserAutoskills').mockReturnValue([]);
    const prompt = new PromptBuilder().buildSystemPrompt(U);
    expect(prompt).not.toContain('<auto_invoked_skills>');
    expect(resolveAutoskillContent).not.toHaveBeenCalled();
  });
});

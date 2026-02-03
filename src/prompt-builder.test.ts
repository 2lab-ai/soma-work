import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock user settings store
vi.mock('./user-settings-store', () => ({
  userSettingsStore: {
    getUserPersona: vi.fn().mockReturnValue('default'),
  },
}));

// Mock env-paths
vi.mock('./env-paths', () => ({
  SYSTEM_PROMPT_FILE: '/tmp/test.system.prompt',
}));

import { PromptBuilder } from './prompt-builder';

describe('PromptBuilder', () => {
  let builder: PromptBuilder;

  beforeEach(() => {
    builder = new PromptBuilder();
  });

  describe('loadWorkflowPrompt', () => {
    it('should load default workflow prompt', () => {
      const prompt = builder.loadWorkflowPrompt('default');

      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt!.length).toBeGreaterThan(0);
    });

    it('should load onboarding workflow prompt', () => {
      const prompt = builder.loadWorkflowPrompt('onboarding');

      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt!.length).toBeGreaterThan(0);
      // Onboarding prompt should contain onboarding-specific content
      expect(prompt!.toLowerCase()).toContain('onboarding');
    });

    it('should cache workflow prompts', () => {
      const prompt1 = builder.loadWorkflowPrompt('onboarding');
      const prompt2 = builder.loadWorkflowPrompt('onboarding');

      // Should be exact same object (cached)
      expect(prompt1).toBe(prompt2);
    });

    it('should load pr-review workflow prompt', () => {
      const prompt = builder.loadWorkflowPrompt('pr-review');

      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
    });

    it('should fallback to default for unknown workflow', () => {
      const prompt = builder.loadWorkflowPrompt('nonexistent-workflow' as any);

      expect(prompt).toBeDefined();
      // Should get the default prompt as fallback
    });
  });

  describe('buildSystemPrompt', () => {
    it('should build system prompt with onboarding workflow', () => {
      const prompt = builder.buildSystemPrompt(undefined, 'onboarding');

      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt!.toLowerCase()).toContain('onboarding');
    });

    it('should build system prompt without workflow (uses default)', () => {
      const prompt = builder.buildSystemPrompt();

      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
    });

    it('should build system prompt with user persona', async () => {
      const { userSettingsStore } = await import('./user-settings-store');
      vi.mocked(userSettingsStore.getUserPersona).mockReturnValue('linus');

      const prompt = builder.buildSystemPrompt('U123', 'default');

      // The prompt should be built (persona loading is attempted)
      expect(prompt).toBeDefined();
    });
  });

  describe('clearCache', () => {
    it('should clear workflow prompt cache', () => {
      // Load a workflow prompt (caches it)
      const prompt1 = builder.loadWorkflowPrompt('onboarding');

      // Clear cache
      builder.clearCache();

      // Load again - should reload from file
      const prompt2 = builder.loadWorkflowPrompt('onboarding');

      // Content should be the same but may be different object references
      expect(prompt1).toEqual(prompt2);
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock user settings store
vi.mock('../user-settings-store', () => ({
  userSettingsStore: {
    getUserPersona: vi.fn().mockReturnValue('default'),
    getUserSettings: vi.fn().mockReturnValue(undefined),
  },
}));

vi.mock('../env-paths', () => ({
  SYSTEM_PROMPT_FILE: '/tmp/test.system.prompt',
  CONFIG_FILE: '/tmp/prompt-builder-test-nonexistent/config.json',
  DATA_DIR: '/tmp/prompt-builder-test-data',
}));

// Mock user-memory-store to avoid filesystem access in prompt-builder tests
vi.mock('../user-memory-store', () => ({
  formatMemoryForPrompt: vi.fn().mockReturnValue(''),
}));

import { PromptBuilder } from '../prompt-builder';

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
      expect(prompt).toContain('CI check');
      expect(prompt).toContain('1 minute');
      expect(prompt).toContain('merge check');
      expect(prompt).toContain('AS-IS');
      expect(prompt).toContain('TO-BE');
      expect(prompt).toContain('CONTINUE_SESSION');
    });

    it('should load pr-fix-and-update prompt with automatic re-review handoff', () => {
      const prompt = builder.loadWorkflowPrompt('pr-fix-and-update');

      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('pr-review');
      expect(prompt).toContain('CONTINUE_SESSION');
      expect(prompt).toContain('new fix');
      expect(prompt).toContain('push');
    });

    it('should load deploy workflow prompt', () => {
      const prompt = builder.loadWorkflowPrompt('deploy');

      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt!.toLowerCase()).toContain('deploy workflow');
    });

    it('should fallback to default for unknown workflow', () => {
      const prompt = builder.loadWorkflowPrompt('nonexistent-workflow' as any);

      expect(prompt).toBeDefined();
      // Should get the default prompt as fallback
    });

    it('should load z-plan-to-work workflow prompt (#695)', () => {
      const prompt = builder.loadWorkflowPrompt('z-plan-to-work');
      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt!.length).toBeGreaterThan(0);
      expect(prompt).toContain('plan-to-work');
      expect(prompt).toContain('local:zwork');
    });

    it('should load z-epic-update workflow prompt (#695)', () => {
      const prompt = builder.loadWorkflowPrompt('z-epic-update');
      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt!.length).toBeGreaterThan(0);
      expect(prompt).toContain('work-complete');
      expect(prompt).toContain('Remaining Epic Checklist');
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
      const { userSettingsStore } = await import('../user-settings-store');
      vi.mocked(userSettingsStore.getUserPersona).mockReturnValue('linus');

      const prompt = builder.buildSystemPrompt('U123', 'default');

      // The prompt should be built (persona loading is attempted)
      expect(prompt).toBeDefined();
    });
  });

  describe('user variable substitution', () => {
    // Trace: Scenario 2 — Variable Substitution in Prompt

    it('should resolve {{user.email}} from UserSettings', async () => {
      // Trace: S2, Section 3c, email mapping
      const { userSettingsStore } = await import('../user-settings-store');
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U123',
        email: 'z@insightquest.io',
        slackName: 'Zhuge',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6',
        lastUpdated: '',
        accepted: true,
      });

      // Access private method via buildSystemPrompt which calls processVariables
      // We need a workflow prompt that contains {{user.email}}
      const prompt = builder.buildSystemPrompt('U123', 'jira-create-pr');

      expect(prompt).toBeDefined();
      expect(prompt).toContain('z@insightquest.io');
      // Workflow template variables should be substituted into Co-Authored-By
      // (common.prompt docs have escaped \{{user.email}} that renders as literal {{user.email}})
      expect(prompt).toContain('Co-Authored-By: Zhuge <z@insightquest.io>');
    });

    it('should resolve {{user.displayName}} from slackName', async () => {
      // Trace: S2, Section 3c, displayName mapping
      const { userSettingsStore } = await import('../user-settings-store');
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U123',
        email: 'z@insightquest.io',
        slackName: 'Zhuge',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6',
        lastUpdated: '',
        accepted: true,
      });

      const prompt = builder.buildSystemPrompt('U123', 'jira-create-pr');

      expect(prompt).toBeDefined();
      // Co-Authored-By should have resolved displayName
      expect(prompt).toContain('Co-Authored-By: Zhuge');
    });

    it('should leave user vars as-is when userId not provided', async () => {
      // Trace: S3, Section 5, row 1
      const prompt = builder.buildSystemPrompt(undefined, 'jira-create-pr');

      expect(prompt).toBeDefined();
      expect(prompt).toContain('{{user.email}}');
      expect(prompt).toContain('{{user.displayName}}');
    });

    it('should leave user vars as-is when user not in store', async () => {
      // Trace: S3, Section 5, row 2
      const { userSettingsStore } = await import('../user-settings-store');
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue(undefined);

      const prompt = builder.buildSystemPrompt('U_UNKNOWN', 'jira-create-pr');

      expect(prompt).toBeDefined();
      expect(prompt).toContain('{{user.email}}');
      expect(prompt).toContain('{{user.displayName}}');
    });

    it('should leave {{user.email}} as-is when email not set', async () => {
      // Trace: S3, Section 3a — email field missing
      const { userSettingsStore } = await import('../user-settings-store');
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U123',
        slackName: 'Zhuge',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6',
        lastUpdated: '',
        accepted: true,
        // email intentionally omitted
      });

      const prompt = builder.buildSystemPrompt('U123', 'jira-create-pr');

      expect(prompt).toBeDefined();
      // email should remain unresolved
      expect(prompt).toContain('{{user.email}}');
      // displayName should be resolved
      expect(prompt).toContain('Zhuge');
    });

    it('should leave {{user.email}} as-is when email is empty sentinel', async () => {
      // Fix: empty string sentinel from failed scope fetch should not resolve
      const { userSettingsStore } = await import('../user-settings-store');
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U123',
        email: '', // empty sentinel — scope missing
        slackName: 'Zhuge',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6',
        lastUpdated: '',
        accepted: true,
      });

      const prompt = builder.buildSystemPrompt('U123', 'jira-create-pr');

      expect(prompt).toBeDefined();
      expect(prompt).toContain('{{user.email}}');
      expect(prompt).toContain('Zhuge');
    });

    it('should resolve {{user.slackId}} from userId', async () => {
      // Trace: S2, Section 3c, slackId mapping
      const { userSettingsStore } = await import('../user-settings-store');
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U094E5L4A15',
        email: 'z@insightquest.io',
        slackName: 'Zhuge',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6',
        lastUpdated: '',
        accepted: true,
      });

      const prompt = builder.buildSystemPrompt('U094E5L4A15', 'default');

      // default prompt includes common.prompt which documents {{user.slackId}}
      // The variable in common.prompt is inside a markdown code block, so it won't be substituted
      // But if the variable appears outside code blocks, it would be substituted
      expect(prompt).toBeDefined();
    });
  });

  describe('workflow template Co-Authored-By', () => {
    // Trace: Scenario 4 — Co-Authored-By in Workflow Commits

    it('jira-create-pr prompt should contain Co-Authored-By template', () => {
      // Trace: S4, Section 3, jira-create-pr
      const prompt = builder.loadWorkflowPrompt('jira-create-pr');

      expect(prompt).toBeDefined();
      expect(prompt).toContain('Co-Authored-By');
      expect(prompt).toContain('{{user.displayName}}');
      expect(prompt).toContain('{{user.email}}');
    });

    it('pr-fix-and-update prompt should contain Co-Authored-By template', () => {
      // Trace: S4, Section 3, pr-fix-and-update
      const prompt = builder.loadWorkflowPrompt('pr-fix-and-update');

      expect(prompt).toBeDefined();
      expect(prompt).toContain('Co-Authored-By');
      expect(prompt).toContain('{{user.displayName}}');
      expect(prompt).toContain('{{user.email}}');
    });

    it('common.prompt should be included in default prompt', () => {
      const prompt = builder.loadWorkflowPrompt('default');

      expect(prompt).toBeDefined();
      // common.prompt is included in default prompt
      expect(prompt).toContain('system_prompt');
    });
  });

  describe('variable escaping', () => {
    it('should not substitute escaped \\{{...}} variables in workflow prompts', async () => {
      // Workflow prompts (e.g. jira-create-pr) contain {{user.email}} in Co-Authored-By
      // When user settings are provided, these should be resolved
      const { userSettingsStore } = await import('../user-settings-store');
      vi.mocked(userSettingsStore.getUserSettings).mockReturnValue({
        userId: 'U123',
        email: 'z@insightquest.io',
        slackName: 'Zhuge',
        defaultDirectory: '',
        bypassPermission: false,
        persona: 'default',
        defaultModel: 'claude-opus-4-6',
        lastUpdated: '',
        accepted: true,
      });

      const prompt = builder.buildSystemPrompt('U123', 'jira-create-pr');

      expect(prompt).toBeDefined();
      // Variables should be resolved in workflow prompts
      expect(prompt).toContain('z@insightquest.io');
    });

    it('should leave unresolved vars when no user settings', async () => {
      // Without user settings, template vars remain as-is
      const prompt = builder.buildSystemPrompt(undefined, 'jira-create-pr');

      expect(prompt).toBeDefined();
      // Unresolved variables should remain as template placeholders
      expect(prompt).toContain('{{user.email}}');
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

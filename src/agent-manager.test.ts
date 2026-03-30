/**
 * Contract Tests — Multi-Agent Architecture
 * Scenarios: S1 (Config Parsing), S2 (Startup), S3 (Direct Chat), S6 (Prompt), S7 (Shutdown)
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ─── S1: Agent Config Parsing ───────────────────────────────────────────────

describe('S1 — Agent Config Parsing', () => {
  // Trace: S1, Section 3a — raw.agents.{name} → AgentConfig
  it('AgentConfig_Parse_HappyPath — parses valid agents section', async () => {
    const { parseAgentsConfig } = await import('./unified-config-loader');

    const raw = {
      agents: {
        jangbi: {
          slackBotToken: 'xoxb-jangbi-token',
          slackAppToken: 'xapp-jangbi-token',
          signingSecret: 'secret-at-least-20-chars-long',
          promptDir: 'src/prompt/jangbi',
          persona: 'default',
          description: 'Code reviewer',
          model: 'claude-sonnet-4-20250514',
        },
      },
    };

    const result = parseAgentsConfig(raw);

    expect(result).toBeDefined();
    expect(result.jangbi).toBeDefined();
    expect(result.jangbi.slackBotToken).toBe('xoxb-jangbi-token');
    expect(result.jangbi.slackAppToken).toBe('xapp-jangbi-token');
    expect(result.jangbi.description).toBe('Code reviewer');
  });

  // Trace: S1, Section 5, Row 1 — agents section missing → empty map
  it('AgentConfig_Parse_MissingSection — returns empty when no agents', async () => {
    const { parseAgentsConfig } = await import('./unified-config-loader');
    const raw = { mcpServers: {} };
    const result = parseAgentsConfig(raw);
    expect(result).toEqual({});
  });

  // Trace: S1, Section 5, Row 4 — invalid token format → skip agent
  it('AgentConfig_Parse_InvalidToken — skips agents with bad tokens', async () => {
    const { parseAgentsConfig } = await import('./unified-config-loader');

    const raw = {
      agents: {
        bad: {
          slackBotToken: 'not-a-valid-token',
          slackAppToken: 'xapp-valid',
          signingSecret: 'secret-at-least-20-chars-long',
        },
      },
    };

    const result = parseAgentsConfig(raw);
    expect(result.bad).toBeUndefined();
  });

  // Trace: S1, Section 3a — promptDir/persona defaults
  it('AgentConfig_Parse_DefaultValues — applies defaults for optional fields', async () => {
    const { parseAgentsConfig } = await import('./unified-config-loader');

    const raw = {
      agents: {
        gwanu: {
          slackBotToken: 'xoxb-gwanu-token',
          slackAppToken: 'xapp-gwanu-token',
          signingSecret: 'secret-at-least-20-chars-long',
        },
      },
    };

    const result = parseAgentsConfig(raw);
    expect(result.gwanu).toBeDefined();
    expect(result.gwanu.promptDir).toContain('gwanu');
    expect(result.gwanu.persona).toBe('default');
  });

  // Codex review: boundary — signingSecret exactly 20 chars accepted, 19 rejected
  it('AgentConfig_Parse_SigningSecretBoundary — 20 chars accepted, 19 rejected', async () => {
    const { parseAgentsConfig } = await import('./unified-config-loader');

    const raw = {
      agents: {
        ok: { slackBotToken: 'xoxb-ok', slackAppToken: 'xapp-ok', signingSecret: '12345678901234567890' },
        bad: { slackBotToken: 'xoxb-bad', slackAppToken: 'xapp-bad', signingSecret: '1234567890123456789' },
      },
    };

    const result = parseAgentsConfig(raw);
    expect(result.ok).toBeDefined();
    expect(result.bad).toBeUndefined();
  });

  // Codex review: mixed valid + invalid agents — valid passes, invalid skipped
  it('AgentConfig_Parse_MixedValidInvalid — valid agents survive alongside invalid', async () => {
    const { parseAgentsConfig } = await import('./unified-config-loader');

    const raw = {
      agents: {
        good: { slackBotToken: 'xoxb-good', slackAppToken: 'xapp-good', signingSecret: 'secret-at-least-20-chars-long' },
        badToken: { slackBotToken: 'invalid', slackAppToken: 'xapp-bad', signingSecret: 'secret-at-least-20-chars-long' },
        badApp: { slackBotToken: 'xoxb-ok', slackAppToken: 'invalid', signingSecret: 'secret-at-least-20-chars-long' },
      },
    };

    const result = parseAgentsConfig(raw);
    expect(Object.keys(result)).toEqual(['good']);
  });
});

// ─── S2: Agent Startup Lifecycle ────────────────────────────────────────────

describe('S2 — Agent Startup Lifecycle', () => {
  // Trace: S2, Section 5, Row 3 — zero agents
  it('AgentStartup_ZeroAgents_NoError — works with no agents configured', async () => {
    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager({}, {} as any);
    await expect(manager.startAll()).resolves.not.toThrow();
    expect(manager.listAgents()).toHaveLength(0);
  });

  // Trace: S2, Section 3b — AgentInstance creation
  it('AgentStartup_HappyPath — creates agent instances from config', async () => {
    const { AgentManager } = await import('./agent-manager');

    const agents = {
      jangbi: {
        slackBotToken: 'xoxb-test',
        slackAppToken: 'xapp-test',
        signingSecret: 'test-secret-at-least-20',
      },
    };

    const manager = new AgentManager(agents, {} as any);
    // Agents are pre-created but not started
    expect(manager.hasAgent('jangbi')).toBe(true);
    expect(manager.getAgent('jangbi')).toBeDefined();
  });
});

// ─── S3: User Direct Chat with Sub-Agent ────────────────────────────────────

describe('S3 — User Direct Chat with Sub-Agent', () => {
  // Trace: S3, Section 3b — PromptBuilder loads agent dir
  it('AgentDirectChat_UsesAgentPrompt — uses agent-specific prompt dir', async () => {
    const { AgentInstance } = await import('./agent-instance');

    const config = {
      slackBotToken: 'xoxb-test',
      slackAppToken: 'xapp-test',
      signingSecret: 'test-secret-at-least-20',
      promptDir: 'src/prompt/jangbi',
    };

    const instance = new AgentInstance('jangbi', config, {} as any);
    expect(instance.getPromptDir()).toContain('jangbi');
  });

  // Trace: S3, Section 4 — agent's own SessionRegistry
  it('AgentDirectChat_SessionIsolation — agent has isolated session registry', async () => {
    const { AgentInstance } = await import('./agent-instance');

    const config = {
      slackBotToken: 'xoxb-test',
      slackAppToken: 'xapp-test',
      signingSecret: 'test-secret-at-least-20',
    };

    const instance1 = new AgentInstance('jangbi', config, {} as any);
    const instance2 = new AgentInstance('gwanu', config, {} as any);

    expect(instance1.getSessionRegistry()).not.toBe(instance2.getSessionRegistry());
  });
});

// ─── S6: Agent Prompt Loading ───────────────────────────────────────────────

describe('S6 — Agent Prompt Loading', () => {
  // Trace: S6, Section 5, Row 1 — falls back to main
  it('AgentPrompt_FallbackToMain — falls back when agent prompt missing', async () => {
    const { PromptBuilder } = await import('./prompt-builder');

    const builder = new PromptBuilder({ agentName: 'nonexistent-agent-xyz' });
    const prompt = builder.getDefaultSystemPrompt();
    // Should still return a prompt (main fallback)
    expect(prompt).toBeDefined();
    expect(typeof prompt).toBe('string');
  });

  // Trace: S6, Section 3a — prompt dir contains agent name
  it('AgentPrompt_LoadsAgentDir — prompt dir is set to agent directory', async () => {
    const { PromptBuilder } = await import('./prompt-builder');

    const builder = new PromptBuilder({ agentName: 'jangbi' });
    expect(builder.getPromptDir()).toContain('jangbi');
  });
});

// ─── S7: Agent Graceful Shutdown ────────────────────────────────────────────

describe('S7 — Agent Graceful Shutdown', () => {
  // Trace: S7, Section 3a — stops all agents
  it('AgentShutdown_StopsAll — stops all agent instances', async () => {
    const { AgentManager } = await import('./agent-manager');
    const manager = new AgentManager({}, {} as any);
    await expect(manager.stopAll()).resolves.not.toThrow();
  });

  // Trace: S7, Section 5 — partial failure continues
  it('AgentShutdown_PartialFailure_Continues — continues stopping on failure', async () => {
    const { AgentManager } = await import('./agent-manager');
    const { AgentInstance } = await import('./agent-instance');

    const agents = {
      a: { slackBotToken: 'xoxb-a', slackAppToken: 'xapp-a', signingSecret: 'secret-20-chars-long!!' },
      b: { slackBotToken: 'xoxb-b', slackAppToken: 'xapp-b', signingSecret: 'secret-20-chars-long!!' },
    };

    const manager = new AgentManager(agents, {} as any);

    // Force agent 'a' to throw on stop
    const agentA = manager.getAgent('a');
    if (agentA) {
      vi.spyOn(agentA, 'stop').mockRejectedValueOnce(new Error('connection lost'));
    }

    // stopAll should NOT throw even though agent 'a' fails
    await expect(manager.stopAll()).resolves.not.toThrow();
  });
});

// ─── S2+: Agent Startup Error Isolation ──────────────────────────────────────

describe('S2+ — Agent Startup Error Isolation', () => {
  // Codex review finding: startAll() error-isolation branch untested
  it('AgentStartup_FailureIsolation — failed agents removed from map', async () => {
    const { AgentManager } = await import('./agent-manager');
    const { AgentInstance } = await import('./agent-instance');

    const agents = {
      good: { slackBotToken: 'xoxb-good', slackAppToken: 'xapp-good', signingSecret: 'secret-20-chars-long!!' },
      bad: { slackBotToken: 'xoxb-bad', slackAppToken: 'xapp-bad', signingSecret: 'secret-20-chars-long!!' },
    };

    const manager = new AgentManager(agents, {} as any);

    // Mock: 'good' succeeds, 'bad' throws
    const goodAgent = manager.getAgent('good');
    const badAgent = manager.getAgent('bad');
    if (goodAgent) vi.spyOn(goodAgent, 'start').mockResolvedValueOnce(undefined);
    if (badAgent) vi.spyOn(badAgent, 'start').mockRejectedValueOnce(new Error('invalid token'));

    await manager.startAll();

    expect(manager.hasAgent('good')).toBe(true);
    expect(manager.hasAgent('bad')).toBe(false);
    expect(manager.listAgents()).toHaveLength(1);
  });

  // Codex review finding: getAgentConfig/getAllAgentConfigs untested
  it('AgentManager_ConfigAccessors — getAgentConfig and getAllAgentConfigs work', async () => {
    const { AgentManager } = await import('./agent-manager');

    const agents = {
      jangbi: { slackBotToken: 'xoxb-j', slackAppToken: 'xapp-j', signingSecret: 'secret-20-chars-long!!' },
    };

    const manager = new AgentManager(agents, {} as any);
    expect(manager.getAgentConfig('jangbi')).toBeDefined();
    expect(manager.getAgentConfig('jangbi')?.slackBotToken).toBe('xoxb-j');
    expect(manager.getAgentConfig('nonexistent')).toBeUndefined();
    expect(Object.keys(manager.getAllAgentConfigs())).toEqual(['jangbi']);
  });
});

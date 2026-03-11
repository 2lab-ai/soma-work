import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AgentRegistry } from './registry';
import { AgentDescriptor, AgentConfig } from './types';

const codexAgent: AgentDescriptor = {
  id: 'codex',
  name: 'Codex Agent',
  role: 'sub',
  capabilities: ['llm_chat', 'code_review'],
  transport: {
    type: 'http',
    baseUrl: 'http://127.0.0.1:9100',
    timeoutMs: 600_000,
  },
  defaultModel: 'gpt-5.3-codex',
};

const geminiAgent: AgentDescriptor = {
  id: 'gemini',
  name: 'Gemini Agent',
  role: 'sub',
  capabilities: ['llm_chat', 'search'],
  transport: {
    type: 'http',
    baseUrl: 'http://127.0.0.1:9200',
    timeoutMs: 600_000,
  },
  defaultModel: 'gemini-3.1-pro',
};

describe('AgentRegistry', () => {
  let registry: AgentRegistry;

  beforeEach(() => {
    registry = new AgentRegistry();
  });

  describe('registration', () => {
    it('registers an agent', () => {
      registry.register(codexAgent);
      expect(registry.get('codex')).toEqual(codexAgent);
    });

    it('returns undefined for unregistered agent', () => {
      expect(registry.get('nonexistent')).toBeUndefined();
    });

    it('overwrites existing agent on re-register', () => {
      registry.register(codexAgent);
      const updated = { ...codexAgent, name: 'Updated Codex' };
      registry.register(updated);
      expect(registry.get('codex')?.name).toBe('Updated Codex');
    });

    it('unregisters an agent', () => {
      registry.register(codexAgent);
      expect(registry.unregister('codex')).toBe(true);
      expect(registry.get('codex')).toBeUndefined();
    });

    it('returns false for unregistering nonexistent agent', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('discovery', () => {
    beforeEach(() => {
      registry.register(codexAgent);
      registry.register(geminiAgent);
    });

    it('finds agents by capability', () => {
      const llmAgents = registry.findByCapability('llm_chat');
      expect(llmAgents).toHaveLength(2);
      expect(llmAgents.map(a => a.id)).toContain('codex');
      expect(llmAgents.map(a => a.id)).toContain('gemini');
    });

    it('finds agents by unique capability', () => {
      const reviewAgents = registry.findByCapability('code_review');
      expect(reviewAgents).toHaveLength(1);
      expect(reviewAgents[0].id).toBe('codex');
    });

    it('returns empty for unknown capability', () => {
      expect(registry.findByCapability('unknown')).toHaveLength(0);
    });

    it('getAll returns all agents', () => {
      expect(registry.getAll()).toHaveLength(2);
    });

    it('getSubAgents excludes main agents', () => {
      const mainAgent: AgentDescriptor = {
        ...codexAgent,
        id: 'main',
        role: 'main',
      };
      registry.register(mainAgent);
      expect(registry.getSubAgents()).toHaveLength(2);
      expect(registry.getAll()).toHaveLength(3);
    });
  });

  describe('initialization from config', () => {
    it('registers agents from config', () => {
      const config: AgentConfig = {
        agents: [codexAgent, geminiAgent],
        healthCheckIntervalMs: 60_000,
      };

      const reg = new AgentRegistry(config);
      expect(reg.getAll()).toHaveLength(2);
      expect(reg.get('codex')).toBeDefined();
      expect(reg.get('gemini')).toBeDefined();
    });

    it('initializes empty with no config', () => {
      const reg = new AgentRegistry();
      expect(reg.getAll()).toHaveLength(0);
    });
  });

  describe('health', () => {
    it('initializes health as unknown', () => {
      registry.register(codexAgent);
      const health = registry.getHealth('codex');
      expect(health).toBeDefined();
      expect(health!.status).toBe('unknown');
    });

    it('creates client for sub-agents', () => {
      registry.register(codexAgent);
      expect(registry.getClient('codex')).toBeDefined();
    });

    it('does not create client for main agents', () => {
      const mainAgent: AgentDescriptor = { ...codexAgent, id: 'main', role: 'main' };
      registry.register(mainAgent);
      expect(registry.getClient('main')).toBeUndefined();
    });
  });

  describe('formatForDisplay', () => {
    it('returns empty message when no agents', () => {
      expect(registry.formatForDisplay()).toBe('_No agents registered._');
    });

    it('formats agents for display', () => {
      registry.register(codexAgent);
      const display = registry.formatForDisplay();
      expect(display).toContain('codex');
      expect(display).toContain('llm_chat');
      expect(display).toContain('http://127.0.0.1:9100');
    });
  });
});

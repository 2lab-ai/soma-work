import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_CONFIG_DIR = '/tmp/llm-chat-config-test';
const TEST_CONFIG_FILE = `${TEST_CONFIG_DIR}/config.json`;

// Mock env-paths to use a writable temp directory so persist works
vi.mock('./env-paths', () => ({
  CONFIG_FILE: '/tmp/llm-chat-config-test/config.json',
  DATA_DIR: '/tmp/llm-chat-config-test',
}));

import { LlmChatConfigStore, expandConfigOverride } from './llm-chat-config-store';

describe('LlmChatConfigStore', () => {
  let store: LlmChatConfigStore;

  beforeEach(() => {
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    // Remove config file to start fresh with defaults
    try {
      fs.unlinkSync(TEST_CONFIG_FILE);
    } catch {
      /* ignore if not exists */
    }
    store = new LlmChatConfigStore();
  });

  afterEach(() => {
    try {
      fs.unlinkSync(TEST_CONFIG_FILE);
    } catch {
      /* ignore */
    }
  });

  describe('constructor / defaults', () => {
    it('should initialize with default codex model', () => {
      const cfg = store.getBackendConfig('codex');
      expect(cfg.model).toBe('gpt-5.3-codex');
      expect(cfg.backend).toBe('codex');
    });

    it('should initialize with default gemini model', () => {
      const cfg = store.getBackendConfig('gemini');
      expect(cfg.model).toBe('gemini-3.1-pro-preview');
      expect(cfg.backend).toBe('gemini');
    });

    it('should have codex reasoning effort as xhigh by default', () => {
      const cfg = store.getBackendConfig('codex');
      expect(cfg.configOverride?.model_reasoning_effort).toBe('xhigh');
    });

    it('should have codex service_tier as fast by default', () => {
      const cfg = store.getBackendConfig('codex');
      expect(cfg.configOverride?.service_tier).toBe('fast');
    });

    it('should have codex features.fast_mode enabled by default', () => {
      const cfg = store.getBackendConfig('codex');
      expect(cfg.configOverride?.['features.fast_mode']).toBe('true');
    });
  });

  describe('set()', () => {
    it('should update model for valid provider', () => {
      const err = store.set('codex', 'model', 'gpt-5.4');
      expect(err).toBeUndefined();
      expect(store.getBackendConfig('codex').model).toBe('gpt-5.4');
    });

    it('should update config override for valid key', () => {
      const err = store.set('codex', 'model_reasoning_effort', 'low');
      expect(err).toBeUndefined();
      expect(store.getBackendConfig('codex').configOverride?.model_reasoning_effort).toBe('low');
    });

    it('should reject unknown provider', () => {
      const err = store.set('openai', 'model', 'gpt-5');
      expect(err).toContain('Unknown provider');
    });

    it('should reject unknown key', () => {
      const err = store.set('codex', 'temperature', '0.5');
      expect(err).toContain('Unknown key');
    });

    it('should reject values with double quotes', () => {
      const err = store.set('codex', 'model', 'gpt"5');
      expect(err).toContain('Invalid value');
    });

    it('should reject values with angle brackets', () => {
      expect(store.set('codex', 'model', 'gpt<5>')).toContain('Invalid value');
    });

    it('should reject values with spaces (allowlist)', () => {
      const err = store.set('codex', 'model', 'gpt 5.4');
      expect(err).toContain('Invalid value');
    });

    it('should reject values with unicode special chars', () => {
      const err = store.set('codex', 'model', 'gpt\u200B5'); // zero-width space
      expect(err).toContain('Invalid value');
    });

    it('should accept valid model names with dots and hyphens', () => {
      expect(store.set('codex', 'model', 'gpt-5.3-codex')).toBeUndefined();
      expect(store.set('gemini', 'model', 'gemini-3.1-pro-preview')).toBeUndefined();
    });

    it('should accept values with colons', () => {
      expect(store.set('codex', 'model', 'org:model-v1')).toBeUndefined();
    });

    it('should allow setting service_tier', () => {
      const err = store.set('codex', 'service_tier', 'flex');
      expect(err).toBeUndefined();
      expect(store.getBackendConfig('codex').configOverride?.service_tier).toBe('flex');
    });

    it('should allow toggling service_tier back to fast', () => {
      store.set('codex', 'service_tier', 'flex');
      store.set('codex', 'service_tier', 'fast');
      expect(store.getBackendConfig('codex').configOverride?.service_tier).toBe('fast');
    });
  });

  describe('reset()', () => {
    it('should restore default values after modification', () => {
      store.set('codex', 'model', 'custom-model');
      store.reset();
      expect(store.getBackendConfig('codex').model).toBe('gpt-5.3-codex');
    });
  });

  describe('getConfig() / getBackendConfig()', () => {
    it('should return cloned config (mutation-safe)', () => {
      const cfg1 = store.getConfig();
      const cfg2 = store.getConfig();
      expect(cfg1).toEqual(cfg2);
      expect(cfg1).not.toBe(cfg2); // different references
    });

    it('should return cloned backend config', () => {
      const cfg1 = store.getBackendConfig('codex');
      const cfg2 = store.getBackendConfig('codex');
      expect(cfg1).toEqual(cfg2);
      expect(cfg1).not.toBe(cfg2);
    });
  });

  describe('toPromptSnippet()', () => {
    it('should generate valid prompt snippet with model names', () => {
      const snippet = store.toPromptSnippet();
      expect(snippet).toContain('codex');
      expect(snippet).toContain('gemini');
      expect(snippet).toContain('gpt-5.3-codex');
      expect(snippet).toContain('gemini-3.1-pro-preview');
    });

    it('should include config overrides in snippet with proper nested JSON', () => {
      const snippet = store.toPromptSnippet();
      expect(snippet).toContain('model_reasoning_effort');
      expect(snippet).toContain('xhigh');
      // Should output nested features object with boolean, not flat string
      expect(snippet).toContain('"features":{"fast_mode":true}');
      expect(snippet).not.toContain('"features.fast_mode"');
    });

    it('should reflect updated values', () => {
      store.set('codex', 'model', 'gpt-5.4');
      const snippet = store.toPromptSnippet();
      expect(snippet).toContain('gpt-5.4');
      expect(snippet).not.toContain('gpt-5.3-codex');
    });
  });

  describe('formatForDisplay()', () => {
    it('should format config for Slack display', () => {
      const display = store.formatForDisplay();
      expect(display).toContain('*codex*');
      expect(display).toContain('*gemini*');
      expect(display).toContain('gpt-5.3-codex');
    });
  });

  describe('expandConfigOverride()', () => {
    it('should expand dot-notation keys into nested objects', () => {
      const result = expandConfigOverride({ 'features.fast_mode': 'true' });
      expect(result).toEqual({ features: { fast_mode: true } });
    });

    it('should coerce "true" to boolean true', () => {
      const result = expandConfigOverride({ 'features.fast_mode': 'true' });
      expect((result.features as any).fast_mode).toBe(true);
    });

    it('should coerce "false" to boolean false', () => {
      const result = expandConfigOverride({ 'features.fast_mode': 'false' });
      expect((result.features as any).fast_mode).toBe(false);
    });

    it('should keep non-boolean strings as strings', () => {
      const result = expandConfigOverride({ model_reasoning_effort: 'xhigh', service_tier: 'fast' });
      expect(result).toEqual({ model_reasoning_effort: 'xhigh', service_tier: 'fast' });
    });

    it('should handle mixed flat and dot-notation keys', () => {
      const result = expandConfigOverride({
        model_reasoning_effort: 'xhigh',
        'features.fast_mode': 'true',
        service_tier: 'fast',
      });
      expect(result).toEqual({
        model_reasoning_effort: 'xhigh',
        features: { fast_mode: true },
        service_tier: 'fast',
      });
    });

    it('should handle deeply nested dot notation', () => {
      const result = expandConfigOverride({ 'a.b.c': 'true' });
      expect(result).toEqual({ a: { b: { c: true } } });
    });
  });

  describe('persistence', () => {
    it('should persist config to file on set()', () => {
      store.set('codex', 'model', 'gpt-5.4');
      expect(fs.existsSync(TEST_CONFIG_FILE)).toBe(true);
      const raw = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf-8'));
      expect(raw.llmChat.codex.model).toBe('gpt-5.4');
    });

    it('should load persisted config on new instance', () => {
      store.set('codex', 'model', 'gpt-5.4');
      const store2 = new LlmChatConfigStore();
      expect(store2.getBackendConfig('codex').model).toBe('gpt-5.4');
    });

    it('should preserve other config sections when persisting', () => {
      // Pre-populate config.json with non-llmChat data
      fs.writeFileSync(TEST_CONFIG_FILE, JSON.stringify({ mcpServers: { test: {} } }, null, 2), 'utf-8');
      const freshStore = new LlmChatConfigStore();
      freshStore.set('codex', 'model', 'gpt-5.4');
      const raw = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf-8'));
      expect(raw.mcpServers).toEqual({ test: {} });
      expect(raw.llmChat.codex.model).toBe('gpt-5.4');
    });

    it('should abort persist and return error when config.json is corrupt', () => {
      // Write corrupt JSON
      fs.writeFileSync(TEST_CONFIG_FILE, '{invalid json!!!', 'utf-8');
      const freshStore = new LlmChatConfigStore();
      const err = freshStore.set('codex', 'model', 'gpt-5.4');
      expect(err).toContain('corrupt');
      // Model should NOT be updated (rollback)
      expect(freshStore.getBackendConfig('codex').model).toBe('gpt-5.3-codex');
    });

    it('should return undefined on successful reset', () => {
      store.set('codex', 'model', 'gpt-5.4');
      expect(store.reset()).toBeUndefined();
      expect(store.getBackendConfig('codex').model).toBe('gpt-5.3-codex');
      // Verify persisted defaults
      const raw = JSON.parse(fs.readFileSync(TEST_CONFIG_FILE, 'utf-8'));
      expect(raw.llmChat.codex.model).toBe('gpt-5.3-codex');
    });
  });
});

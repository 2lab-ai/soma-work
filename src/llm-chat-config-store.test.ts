import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';

const TEST_CONFIG_DIR = '/tmp/llm-chat-config-test';
const TEST_CONFIG_FILE = `${TEST_CONFIG_DIR}/config.json`;

// Mock env-paths to use a writable temp directory so persist works
vi.mock('./env-paths', () => ({
  CONFIG_FILE: '/tmp/llm-chat-config-test/config.json',
  DATA_DIR: '/tmp/llm-chat-config-test',
}));

import { LlmChatConfigStore } from './llm-chat-config-store';

describe('LlmChatConfigStore', () => {
  let store: LlmChatConfigStore;

  beforeEach(() => {
    fs.mkdirSync(TEST_CONFIG_DIR, { recursive: true });
    // Remove config file to start fresh with defaults
    try { fs.unlinkSync(TEST_CONFIG_FILE); } catch { /* ignore if not exists */ }
    store = new LlmChatConfigStore();
  });

  afterEach(() => {
    try { fs.unlinkSync(TEST_CONFIG_FILE); } catch { /* ignore */ }
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

    it('should include config overrides in snippet', () => {
      const snippet = store.toPromptSnippet();
      expect(snippet).toContain('model_reasoning_effort');
      expect(snippet).toContain('xhigh');
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
});

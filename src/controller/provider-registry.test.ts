/**
 * ProviderRegistry tests (Issue #413)
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentProvider } from './agent-provider.js';
import { ProviderRegistry } from './provider-registry.js';

function createMockProvider(name: string): AgentProvider {
  return {
    name,
    query: vi.fn(),
    queryOneShot: vi.fn().mockResolvedValue(''),
    validateCredentials: vi.fn().mockResolvedValue(true),
  };
}

describe('ProviderRegistry', () => {
  it('registers a provider', () => {
    const registry = new ProviderRegistry();
    const provider = createMockProvider('anthropic');

    registry.register(provider);

    expect(registry.has('anthropic')).toBe(true);
    expect(registry.list()).toEqual(['anthropic']);
  });

  it('first registered provider becomes default', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('anthropic'));
    registry.register(createMockProvider('openai'));

    expect(registry.getDefaultName()).toBe('anthropic');
    expect(registry.getDefault().name).toBe('anthropic');
  });

  it('allows changing default', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('anthropic'));
    registry.register(createMockProvider('openai'));

    registry.setDefault('openai');

    expect(registry.getDefaultName()).toBe('openai');
    expect(registry.getDefault().name).toBe('openai');
  });

  it('throws on setDefault for unregistered provider', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('anthropic'));

    expect(() => registry.setDefault('openai')).toThrow("Provider 'openai' is not registered");
  });

  it('gets provider by name', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('anthropic'));
    registry.register(createMockProvider('openai'));

    expect(registry.get('openai')?.name).toBe('openai');
    expect(registry.get('anthropic')?.name).toBe('anthropic');
  });

  it('returns undefined for unknown provider', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('anthropic'));

    expect(registry.get('unknown')).toBeUndefined();
  });

  it('get() without name returns default', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('anthropic'));

    expect(registry.get()?.name).toBe('anthropic');
  });

  it('throws getDefault when no providers registered', () => {
    const registry = new ProviderRegistry();

    expect(() => registry.getDefault()).toThrow('No providers registered');
  });

  it('lists all registered providers', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('anthropic'));
    registry.register(createMockProvider('openai'));
    registry.register(createMockProvider('gemini'));

    expect(registry.list()).toEqual(['anthropic', 'openai', 'gemini']);
  });
});

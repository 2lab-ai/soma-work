/**
 * ProviderRegistry — Multi-provider management (Issue #413)
 *
 * Manages available AgentProviders and resolves which provider
 * to use for a given session or request.
 *
 * Provider selection priority:
 * 1. Explicit request (QueryParams.providerOptions.provider)
 * 2. Session-level setting
 * 3. Default provider
 */

import { Logger } from '../logger.js';
import type { AgentProvider } from './agent-provider.js';

// ─── Types ───────────────────────────────────────────────────────

/** Provider name type. */
export type ProviderName = 'anthropic' | 'openai' | string;

// ─── Implementation ─────────────────────────────────────────────

export class ProviderRegistry {
  private logger = new Logger('ProviderRegistry');
  private providers = new Map<string, AgentProvider>();
  private defaultProvider: string | undefined;

  /**
   * Register a provider.
   * The first registered provider becomes the default.
   */
  register(provider: AgentProvider): void {
    this.providers.set(provider.name, provider);
    if (!this.defaultProvider) {
      this.defaultProvider = provider.name;
    }
    this.logger.info('Provider registered', {
      name: provider.name,
      isDefault: this.defaultProvider === provider.name,
    });
  }

  /**
   * Set the default provider by name.
   * @throws if the provider is not registered.
   */
  setDefault(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Provider '${name}' is not registered`);
    }
    this.defaultProvider = name;
    this.logger.info('Default provider changed', { name });
  }

  /**
   * Get a provider by name. Falls back to default if name is undefined.
   * @returns The provider, or undefined if not found.
   */
  get(name?: string): AgentProvider | undefined {
    if (name) {
      return this.providers.get(name);
    }
    if (this.defaultProvider) {
      return this.providers.get(this.defaultProvider);
    }
    return undefined;
  }

  /**
   * Get the default provider.
   * @throws if no providers are registered.
   */
  getDefault(): AgentProvider {
    if (!this.defaultProvider) {
      throw new Error('No providers registered');
    }
    const provider = this.providers.get(this.defaultProvider);
    if (!provider) {
      throw new Error(`Default provider '${this.defaultProvider}' not found`);
    }
    return provider;
  }

  /** List all registered provider names. */
  list(): string[] {
    return Array.from(this.providers.keys());
  }

  /** Check if a provider is registered. */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /** Get the default provider name. */
  getDefaultName(): string | undefined {
    return this.defaultProvider;
  }
}

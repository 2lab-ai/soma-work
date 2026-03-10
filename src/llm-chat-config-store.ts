/**
 * LlmChatConfigStore - In-memory runtime configuration for llm_chat MCP tools
 *
 * Manages model/config settings for codex and gemini backends.
 * Settings persist per-process (session); reset on restart.
 * Designed for future extension to file-based persistence.
 */

import { Logger } from './logger';

/**
 * Backend types supported by llm_chat
 */
export type LlmBackend = 'codex' | 'gemini';

/**
 * Configuration for a single LLM backend
 */
export interface LlmBackendConfig {
  backend: LlmBackend;
  model: string;
  configOverride?: Record<string, string>;
}

/**
 * All LLM chat configurations
 */
export type LlmChatConfig = Record<LlmBackend, LlmBackendConfig>;

/**
 * Settable keys for llm_chat configuration
 */
const SETTABLE_KEYS = new Set(['model', 'model_reasoning_effort']);

/**
 * Default configuration - matches issue spec
 */
const DEFAULT_CONFIG: LlmChatConfig = {
  codex: {
    backend: 'codex',
    model: 'gpt-5.3-codex',
    configOverride: { model_reasoning_effort: 'xhigh' },
  },
  gemini: {
    backend: 'gemini',
    model: 'gemini-3.1-pro-preview',
  },
};

/**
 * Valid backends (derived from DEFAULT_CONFIG keys)
 */
const VALID_BACKENDS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_CONFIG));

export class LlmChatConfigStore {
  private logger = new Logger('LlmChatConfigStore');
  private config: LlmChatConfig;

  constructor() {
    // Deep clone default config
    this.config = this.cloneConfig(DEFAULT_CONFIG);
    this.logger.info('Initialized with default config', {
      codexModel: this.config.codex.model,
      geminiModel: this.config.gemini.model,
    });
  }

  /**
   * Get the full configuration
   */
  getConfig(): Readonly<LlmChatConfig> {
    return this.config;
  }

  /**
   * Get configuration for a specific backend
   */
  getBackendConfig(backend: LlmBackend): Readonly<LlmBackendConfig> {
    return this.config[backend];
  }

  /**
   * Set a configuration value
   * @returns Error message if invalid, undefined on success
   */
  set(provider: string, key: string, value: string): string | undefined {
    // Validate provider
    if (!VALID_BACKENDS.has(provider)) {
      return `Unknown provider: \`${provider}\`. Valid providers: ${[...VALID_BACKENDS].join(', ')}`;
    }

    const backend = provider as LlmBackend;

    // Validate key
    if (!SETTABLE_KEYS.has(key)) {
      return `Unknown key: \`${key}\`. Valid keys: ${[...SETTABLE_KEYS].join(', ')}`;
    }

    // Apply the setting
    if (key === 'model') {
      const oldModel = this.config[backend].model;
      this.config[backend].model = value;
      this.logger.info('Model updated', { backend, oldModel, newModel: value });
    } else {
      // Config override keys (e.g., model_reasoning_effort)
      if (!this.config[backend].configOverride) {
        this.config[backend].configOverride = {};
      }
      const oldValue = this.config[backend].configOverride![key];
      this.config[backend].configOverride![key] = value;
      this.logger.info('Config override updated', { backend, key, oldValue, newValue: value });
    }

    return undefined;
  }

  /**
   * Reset to default configuration
   */
  reset(): void {
    this.config = this.cloneConfig(DEFAULT_CONFIG);
    this.logger.info('Config reset to defaults');
  }

  /**
   * Format configuration for display
   */
  formatForDisplay(): string {
    const lines: string[] = [];

    for (const backend of Object.keys(this.config) as LlmBackend[]) {
      const cfg = this.config[backend];
      lines.push(`*${backend}* {`);
      lines.push(`  backend: '${cfg.backend}',`);
      lines.push(`  model: '${cfg.model}',`);
      if (cfg.configOverride && Object.keys(cfg.configOverride).length > 0) {
        const overrideStr = Object.entries(cfg.configOverride)
          .map(([k, v]) => `${k}: '${v}'`)
          .join(', ');
        lines.push(`  configOverride: { ${overrideStr} },`);
      }
      lines.push('}');
      lines.push('');
    }

    return lines.join('\n').trimEnd();
  }

  /**
   * Generate prompt snippet for system prompt injection
   * This replaces the hardcoded model names in common.prompt
   */
  toPromptSnippet(): string {
    const formatBackend = (cfg: LlmBackendConfig): string => {
      const configStr = cfg.configOverride && Object.keys(cfg.configOverride).length > 0
        ? `, config: { ${Object.entries(cfg.configOverride).map(([k, v]) => `"${k}":"${v}"`).join(', ')} }`
        : '';
      return `    - ${cfg.backend}: <parameters>model: "${cfg.model}"${configStr}</parameters>`;
    };

    return (Object.keys(this.config) as LlmBackend[])
      .map((key) => formatBackend(this.config[key]))
      .join('\n');
  }

  private cloneConfig(source: LlmChatConfig): LlmChatConfig {
    const result = {} as LlmChatConfig;
    for (const key of Object.keys(source) as LlmBackend[]) {
      const cfg = source[key];
      result[key] = {
        backend: cfg.backend,
        model: cfg.model,
        configOverride: cfg.configOverride ? { ...cfg.configOverride } : undefined,
      };
    }
    return result;
  }
}

// Singleton instance
export const llmChatConfigStore = new LlmChatConfigStore();

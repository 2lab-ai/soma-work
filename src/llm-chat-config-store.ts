/**
 * LlmChatConfigStore - In-memory runtime configuration for llm_chat MCP tools
 *
 * Manages model/config settings for codex and gemini backends.
 * Settings persist per-process (session); reset on restart.
 * Designed for future extension to file-based persistence.
 */

import { Logger } from './logger';

export type LlmBackend = 'codex' | 'gemini';

export interface LlmBackendConfig {
  backend: LlmBackend;
  model: string;
  configOverride?: Record<string, string>;
}

export type LlmChatConfig = Record<LlmBackend, LlmBackendConfig>;

const SETTABLE_KEYS = new Set(['model', 'model_reasoning_effort']);

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

const VALID_BACKENDS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_CONFIG));

export class LlmChatConfigStore {
  private logger = new Logger('LlmChatConfigStore');
  private config: LlmChatConfig;

  constructor() {
    this.config = this.cloneConfig(DEFAULT_CONFIG);
    this.logger.info('Initialized with default config', {
      codexModel: this.config.codex.model,
      geminiModel: this.config.gemini.model,
    });
  }

  getConfig(): Readonly<LlmChatConfig> {
    return this.cloneConfig(this.config);
  }

  getBackendConfig(backend: LlmBackend): Readonly<LlmBackendConfig> {
    return this.cloneBackendConfig(this.config[backend]);
  }

  /** @returns Error message if invalid, undefined on success */
  set(provider: string, key: string, value: string): string | undefined {
    if (!VALID_BACKENDS.has(provider)) {
      return `Unknown provider: \`${provider}\`. Valid providers: ${[...VALID_BACKENDS].join(', ')}`;
    }
    if (!SETTABLE_KEYS.has(key)) {
      return `Unknown key: \`${key}\`. Valid keys: ${[...SETTABLE_KEYS].join(', ')}`;
    }
    if (/["<>]/.test(value)) {
      return `Invalid value: must not contain \`, <, or > characters`;
    }

    const backend = provider as LlmBackend;

    if (key === 'model') {
      const oldModel = this.config[backend].model;
      this.config[backend].model = value;
      this.logger.info('Model updated', { backend, oldModel, newModel: value });
    } else {
      const overrides = this.config[backend].configOverride ??= {};
      const oldValue = overrides[key];
      overrides[key] = value;
      this.logger.info('Config override updated', { backend, key, oldValue, newValue: value });
    }

    return undefined;
  }

  reset(): void {
    this.config = this.cloneConfig(DEFAULT_CONFIG);
    this.logger.info('Config reset to defaults');
  }

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

  /** Generate prompt snippet for system prompt injection (replaces hardcoded models in common.prompt) */
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

  private cloneBackendConfig(cfg: LlmBackendConfig): LlmBackendConfig {
    return {
      backend: cfg.backend,
      model: cfg.model,
      configOverride: cfg.configOverride ? { ...cfg.configOverride } : undefined,
    };
  }

  private cloneConfig(source: LlmChatConfig): LlmChatConfig {
    const result = {} as LlmChatConfig;
    for (const key of Object.keys(source) as LlmBackend[]) {
      result[key] = this.cloneBackendConfig(source[key]);
    }
    return result;
  }
}

// Singleton instance — process-wide by design.
// Config is shared across all users; mutation access (set/reset) is restricted
// to ADMIN_USER_ID at the command handler layer (LlmChatHandler.isAdmin).
export const llmChatConfigStore = new LlmChatConfigStore();

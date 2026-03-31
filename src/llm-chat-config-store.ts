/**
 * LlmChatConfigStore - Runtime configuration for llm_chat MCP tools
 *
 * Manages model/config settings for codex and gemini backends.
 * Persists to config.json (CONFIG_FILE) under the `llmChat` key so the
 * llm-mcp-server (separate child process) can read the same settings
 * via file-based IPC with mtime-based change detection.
 */

import * as fs from 'fs';
import { CONFIG_FILE } from './env-paths';
import { Logger } from './logger';

export type LlmBackend = 'codex' | 'gemini';

export interface LlmBackendConfig {
  backend: LlmBackend;
  model: string;
  configOverride?: Record<string, string>;
}

export type LlmChatConfig = Record<LlmBackend, LlmBackendConfig>;

const SETTABLE_KEYS = new Set(['model', 'model_reasoning_effort', 'features.fast_mode', 'service_tier']);

const DEFAULT_CONFIG: LlmChatConfig = {
  codex: {
    backend: 'codex',
    model: 'gpt-5.3-codex',
    configOverride: { model_reasoning_effort: 'xhigh', 'features.fast_mode': 'true', service_tier: 'fast' },
  },
  gemini: {
    backend: 'gemini',
    model: 'gemini-3.1-pro-preview',
  },
};

export { DEFAULT_CONFIG };

const VALID_BACKENDS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_CONFIG));

/**
 * Read llmChat section from config.json.
 * Used by both main process (LlmChatConfigStore) and llm-mcp-server.
 * Returns DEFAULT_CONFIG if file doesn't exist, has no llmChat key, or is invalid.
 */
export function readLlmChatConfigFromFile(configFile: string = CONFIG_FILE): LlmChatConfig {
  try {
    if (fs.existsSync(configFile)) {
      const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      const llmChat = raw?.llmChat;
      if (llmChat && llmChat.codex?.backend === 'codex' && llmChat.gemini?.backend === 'gemini') {
        return llmChat as LlmChatConfig;
      }
    }
  } catch {
    // Fall through to default
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

export class LlmChatConfigStore {
  private logger = new Logger('LlmChatConfigStore');
  private config: LlmChatConfig;

  constructor() {
    this.config = readLlmChatConfigFromFile();
    this.logger.info('Initialized config', {
      codexModel: this.config.codex.model,
      geminiModel: this.config.gemini.model,
      source: this.hasPersistedConfig() ? 'config.json' : 'defaults',
    });
  }

  private hasPersistedConfig(): boolean {
    try {
      if (fs.existsSync(CONFIG_FILE)) {
        const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        return !!raw?.llmChat;
      }
    } catch {
      /* ignore */
    }
    return false;
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
    if (!/^[\w.:-]+$/.test(value)) {
      return 'Invalid value: must contain only alphanumeric characters, dots, hyphens, and colons';
    }

    const backend = provider as LlmBackend;

    // Save old state for rollback on persist failure
    const oldBackendConfig = this.cloneBackendConfig(this.config[backend]);

    if (key === 'model') {
      this.config[backend].model = value;
      this.logger.info('Model updated', { backend, oldModel: oldBackendConfig.model, newModel: value });
    } else {
      const overrides = (this.config[backend].configOverride ??= {});
      const oldValue = overrides[key];
      overrides[key] = value;
      this.logger.info('Config override updated', { backend, key, oldValue, newValue: value });
    }

    const persistError = this.persistToConfigJson();
    if (persistError) {
      // Roll back in-memory change so state stays consistent with disk
      this.config[backend] = oldBackendConfig;
      return persistError;
    }
    return undefined;
  }

  reset(): string | undefined {
    const oldConfig = this.cloneConfig(this.config);
    this.config = this.cloneConfig(DEFAULT_CONFIG);
    this.logger.info('Config reset to defaults');
    const persistError = this.persistToConfigJson();
    if (persistError) {
      this.config = oldConfig;
      return persistError;
    }
    return undefined;
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
      const configStr =
        cfg.configOverride && Object.keys(cfg.configOverride).length > 0
          ? `, config: { ${Object.entries(cfg.configOverride)
              .map(([k, v]) => `"${k}":"${v}"`)
              .join(', ')} }`
          : '';
      return `    - ${cfg.backend}: <parameters>model: "${cfg.model}"${configStr}</parameters>`;
    };

    return (Object.keys(this.config) as LlmBackend[]).map((key) => formatBackend(this.config[key])).join('\n');
  }

  /**
   * Merge llmChat into existing config.json (preserving mcpServers, plugin, etc.)
   * Uses atomic write (tmp + rename) to prevent corruption.
   * @returns Error message on failure, undefined on success.
   */
  private persistToConfigJson(): string | undefined {
    try {
      let existing: Record<string, unknown> = {};
      if (fs.existsSync(CONFIG_FILE)) {
        try {
          existing = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
        } catch {
          // Config file exists but is corrupt — abort to prevent data loss
          // (other sections like mcpServers, plugin would be destroyed)
          this.logger.error('Config file exists but is corrupt, aborting persist', { path: CONFIG_FILE });
          return 'Failed to persist config: config.json exists but is corrupt/unparseable';
        }
      }

      existing.llmChat = this.config;

      const tmpFile = CONFIG_FILE + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
      fs.renameSync(tmpFile, CONFIG_FILE);
      this.logger.info('Config persisted to config.json', { path: CONFIG_FILE });
      return undefined;
    } catch (error) {
      this.logger.error('Failed to persist config to config.json', { error });
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to persist config: ${message}`;
    }
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
// to ADMIN_USERS via isAdminUser() at the command handler layer (LlmChatHandler.requireAdmin).
export const llmChatConfigStore = new LlmChatConfigStore();

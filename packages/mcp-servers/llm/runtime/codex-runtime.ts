/**
 * CodexRuntime — LlmRuntime adapter for the Codex MCP server.
 *
 * Shared machinery (client lifecycle, watchdog, response parsing) lives in
 * {@link BaseMcpLlmRuntime}; this class only declares the Codex-specific spec.
 */

import type { McpClientConfig } from '@soma/process-shared/mcp/mcp-client.js';
import { type BackendSpec, BaseMcpLlmRuntime } from './base-runtime.js';

// Codex defaults applied to every new session — no caller override.
const CODEX_DEFAULT_CONFIG: Record<string, unknown> = {
  model_reasoning_effort: 'xhigh',
  features: { fast_mode: true },
  service_tier: 'fast',
};

export interface CodexRuntimeOptions {
  clientConfig?: McpClientConfig;
}

export class CodexRuntime extends BaseMcpLlmRuntime {
  protected readonly spec: BackendSpec = {
    name: 'codex',
    sessionIdKey: 'threadId',
    cliCommand: 'codex',
    cliInstallHint: 'Codex CLI not installed. Run: brew install --cask codex',
    clientLabel: 'LlmMCP:codex',
    defaultClientConfig: { command: 'codex', args: ['mcp-server'] },
    startTool: 'codex',
    resumeTool: 'codex-reply',
    startConfig: CODEX_DEFAULT_CONFIG,
  };

  constructor(opts: CodexRuntimeOptions = {}) {
    super(opts.clientConfig);
  }
}

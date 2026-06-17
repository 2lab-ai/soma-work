/**
 * GeminiRuntime — LlmRuntime adapter for the Gemini MCP server.
 *
 * Shared machinery (client lifecycle, watchdog, response parsing) lives in
 * {@link BaseMcpLlmRuntime}; this class only declares the Gemini-specific spec.
 */

import type { McpClientConfig } from '@soma/process-shared/mcp/mcp-client.js';
import { type BackendSpec, BaseMcpLlmRuntime } from './base-runtime.js';

export interface GeminiRuntimeOptions {
  clientConfig?: McpClientConfig;
}

export class GeminiRuntime extends BaseMcpLlmRuntime {
  protected readonly spec: BackendSpec = {
    name: 'gemini',
    sessionIdKey: 'sessionId',
    cliCommand: 'gemini',
    cliInstallHint: 'Gemini CLI not installed. Run: brew install gemini-cli',
    clientLabel: 'LlmMCP:gemini',
    defaultClientConfig: { command: 'npx', args: ['@2lab.ai/gemini-mcp-server'] },
    startTool: 'chat',
    resumeTool: 'chat-reply',
  };

  constructor(opts: GeminiRuntimeOptions = {}) {
    super(opts.clientConfig);
  }
}

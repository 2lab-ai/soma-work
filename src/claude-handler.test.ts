/**
 * Tests for ClaudeHandler.streamQuery cwd-resume guard.
 *
 * The SDK ENOENT masquerade: Node.js spawn() throws ENOENT when the cwd
 * directory doesn't exist, but the SDK misreports this as "executable not found".
 * These tests verify the defense-in-depth guard that checks cwd existence
 * before calling the SDK, and clears sessionId when cwd recreation fails.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { ClaudeHandler } from './claude-handler';
import { McpManager } from './mcp-manager';
import type { ConversationSession } from './types';

// Mock fs with partial overrides so existsSync/mkdirSync are mockable
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('./mcp-manager', () => ({
  McpManager: class MockMcpManager {
    getServerConfiguration() { return Promise.resolve({}); }
  },
}));

vi.mock('./credentials-manager', () => ({
  ensureValidCredentials: vi.fn().mockResolvedValue({ valid: true, restored: false }),
  getCredentialStatus: vi.fn().mockReturnValue('valid'),
}));

vi.mock('./credential-alert', () => ({
  sendCredentialAlert: vi.fn(),
}));

vi.mock('./user-settings-store', () => ({
  userSettingsStore: { getUserDefaultModel: vi.fn().mockReturnValue('claude-sonnet-4-20250514') },
}));

vi.mock('./channel-registry', () => ({
  checkRepoChannelMatch: vi.fn(),
  getAllChannels: vi.fn().mockReturnValue([]),
  getChannel: vi.fn(),
}));

vi.mock('./env-paths', () => ({
  CONFIG_FILE: undefined,
  DATA_DIR: '/tmp/test-data',
  SYSTEM_PROMPT_FILE: undefined,
  MCP_CONFIG_FILE: undefined,
}));

vi.mock('./mcp-tool-permission-config', () => ({
  loadMcpToolPermissions: vi.fn().mockReturnValue({}),
  getRequiredLevel: vi.fn(),
  levelSatisfies: vi.fn(),
  getPermissionGatedServers: vi.fn().mockReturnValue([]),
  resolveGatedTool: vi.fn(),
}));

vi.mock('./mcp-tool-grant-store', () => ({
  mcpToolGrantStore: { reload: vi.fn(), hasActiveGrant: vi.fn() },
}));

vi.mock('./mcp-config-builder', () => ({
  McpConfigBuilder: class MockMcpConfigBuilder {
    buildConfig() {
      return Promise.resolve({
        permissionMode: 'default',
        mcpServers: {},
        allowedTools: [],
        disallowedTools: [],
      });
    }
  },
  SlackContext: {},
}));

vi.mock('./prompt-builder', () => ({
  PromptBuilder: class MockPromptBuilder {
    buildSystemPrompt() { return 'test system prompt'; }
  },
  getAvailablePersonas: vi.fn().mockReturnValue([]),
}));

vi.mock('./session-registry', () => ({
  SessionRegistry: class MockSessionRegistry {
    getSessionResourceSnapshot() { return {}; }
  },
  SessionExpiryCallbacks: {},
}));

// Capture what gets passed to the SDK query function
let capturedQueryArgs: any = null;
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockImplementation((args: any) => {
    capturedQueryArgs = args;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'test-session-id', model: 'claude-sonnet-4-20250514', tools: [] };
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' };
    })();
  }),
}));

describe('ClaudeHandler cwd-resume guard', () => {
  let handler: ClaudeHandler;
  const workingDir = '/tmp/test-user/session_123_abc';

  beforeEach(() => {
    vi.clearAllMocks();
    capturedQueryArgs = null;
    const mockMcpManager = new McpManager() as any;
    handler = new ClaudeHandler(mockMcpManager);
  });

  it('should omit cwd AND clear sessionId when cwd recreation fails', async () => {
    const session = {
      sessionId: 'existing-session-id',
      ownerId: 'U123',
    } as unknown as ConversationSession;

    // Simulate: directory doesn't exist AND mkdir fails
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockImplementation(() => { throw new Error('Permission denied'); });

    const gen = handler.streamQuery('test', session, undefined, workingDir);
    for await (const _msg of gen) { /* drain */ }

    // cwd should NOT be passed to SDK (prevents ENOENT masquerade)
    expect(capturedQueryArgs.options.cwd).toBeUndefined();
    // resume should NOT be set (prevents stale session resume)
    expect(capturedQueryArgs.options.resume).toBeUndefined();
  });

  it('should preserve cwd and resume when directory exists', async () => {
    const session = {
      sessionId: 'existing-session-id',
      ownerId: 'U123',
    } as unknown as ConversationSession;

    vi.mocked(fs.existsSync).mockReturnValue(true);

    const gen = handler.streamQuery('test', session, undefined, workingDir);
    for await (const _msg of gen) { /* drain */ }

    expect(capturedQueryArgs.options.cwd).toBe(workingDir);
    expect(capturedQueryArgs.options.resume).toBe('existing-session-id');
  });

  it('should preserve cwd and resume when directory is successfully re-created', async () => {
    const session = {
      sessionId: 'existing-session-id',
      ownerId: 'U123',
    } as unknown as ConversationSession;

    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);

    const gen = handler.streamQuery('test', session, undefined, workingDir);
    for await (const _msg of gen) { /* drain */ }

    expect(capturedQueryArgs.options.cwd).toBe(workingDir);
    expect(capturedQueryArgs.options.resume).toBe('existing-session-id');
  });
});

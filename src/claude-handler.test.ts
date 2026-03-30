import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

/**
 * ClaudeHandler cwd-resume guard tests
 *
 * Verifies that when workingDirectory doesn't exist and mkdirSync fails,
 * both options.cwd is omitted AND session.sessionId is cleared so we
 * don't resume into a stale working directory.
 */

// Mock fs module
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Mock the SDK query to capture the options it receives
let capturedOptions: any = null;
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* ({ options }: { prompt: string; options: any }) {
    capturedOptions = options;
    // Yield an init message then return
    yield {
      type: 'system',
      subtype: 'init',
      session_id: 'new-session-id',
      model: 'claude-sonnet-4-20250514',
      tools: [],
    };
  }),
}));

// Mock credentials-manager
vi.mock('./credentials-manager', () => ({
  ensureValidCredentials: vi.fn().mockResolvedValue({ valid: true, restored: false }),
  getCredentialStatus: vi.fn().mockReturnValue('valid'),
}));

// Mock credential-alert
vi.mock('./credential-alert', () => ({
  sendCredentialAlert: vi.fn(),
}));

// Mock user-settings-store
vi.mock('./user-settings-store', () => ({
  userSettingsStore: {
    getModelForUser: vi.fn().mockReturnValue(undefined),
  },
}));

describe('ClaudeHandler cwd-resume guard', () => {
  let handler: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedOptions = null;

    // Import after mocks are set up
    const { ClaudeHandler } = await import('./claude-handler');

    // Create handler with minimal mock dependencies
    const mockMcpManager = {} as any;
    handler = new ClaudeHandler(mockMcpManager);

    // Mock internal components to avoid complex setup
    (handler as any).mcpConfigBuilder = {
      buildConfig: vi.fn().mockResolvedValue({
        permissionMode: 'default',
        mcpServers: undefined,
        allowedTools: [],
        disallowedTools: [],
      }),
    };
    (handler as any).promptBuilder = {
      buildSystemPrompt: vi.fn().mockReturnValue('test prompt'),
    };
  });

  it('should clear sessionId when cwd recreation fails to prevent stale resume', async () => {
    // Setup: directory doesn't exist and mkdirSync throws
    const existsSyncMock = fs.existsSync as ReturnType<typeof vi.fn>;
    const mkdirSyncMock = fs.mkdirSync as ReturnType<typeof vi.fn>;
    existsSyncMock.mockReturnValue(false);
    mkdirSyncMock.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const session = {
      ownerId: 'U123',
      channelId: 'C123',
      sessionId: 'existing-session-id',
      isActive: true,
      lastActivity: new Date(),
      userId: 'U123',
    };

    // Consume the async generator
    const messages: any[] = [];
    for await (const msg of handler.streamQuery(
      'test prompt',
      session,
      undefined,
      '/tmp/nonexistent/workdir',
    )) {
      messages.push(msg);
    }

    // Verify: options.cwd should NOT be set
    expect(capturedOptions.cwd).toBeUndefined();

    // Verify: options.resume should NOT be set (sessionId was cleared)
    expect(capturedOptions.resume).toBeUndefined();

    // Verify: session.sessionId was cleared before query
    // (it gets re-set by the init message, so check that resume wasn't passed)
    expect(capturedOptions.resume).toBeUndefined();
  });

  it('should preserve sessionId when cwd exists and resume normally', async () => {
    // Setup: directory exists
    const existsSyncMock = fs.existsSync as ReturnType<typeof vi.fn>;
    existsSyncMock.mockReturnValue(true);

    const session = {
      ownerId: 'U123',
      channelId: 'C123',
      sessionId: 'existing-session-id',
      isActive: true,
      lastActivity: new Date(),
      userId: 'U123',
    };

    const messages: any[] = [];
    for await (const msg of handler.streamQuery(
      'test prompt',
      session,
      undefined,
      '/tmp/existing/workdir',
    )) {
      messages.push(msg);
    }

    // Verify: options.cwd should be set
    expect(capturedOptions.cwd).toBe('/tmp/existing/workdir');

    // Verify: options.resume should be set (normal resume)
    expect(capturedOptions.resume).toBe('existing-session-id');
  });

  it('should preserve sessionId when cwd recreation succeeds', async () => {
    // Setup: directory doesn't exist but mkdirSync succeeds
    const existsSyncMock = fs.existsSync as ReturnType<typeof vi.fn>;
    const mkdirSyncMock = fs.mkdirSync as ReturnType<typeof vi.fn>;
    existsSyncMock.mockReturnValue(false);
    mkdirSyncMock.mockReturnValue(undefined); // success

    const session = {
      ownerId: 'U123',
      channelId: 'C123',
      sessionId: 'existing-session-id',
      isActive: true,
      lastActivity: new Date(),
      userId: 'U123',
    };

    const messages: any[] = [];
    for await (const msg of handler.streamQuery(
      'test prompt',
      session,
      undefined,
      '/tmp/recreated/workdir',
    )) {
      messages.push(msg);
    }

    // After mkdirSync succeeds, existsSync is irrelevant — cwd should still be set
    // because workingDirectory was NOT cleared
    expect(capturedOptions.cwd).toBe('/tmp/recreated/workdir');

    // Resume should still be set
    expect(capturedOptions.resume).toBe('existing-session-id');
  });
});

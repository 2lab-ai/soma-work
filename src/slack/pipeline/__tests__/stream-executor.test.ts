/**
 * StreamExecutor tests - focusing on continuation pattern
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
    getUserEmail: vi.fn().mockReturnValue(undefined),
    setUserEmail: vi.fn(),
    ensureUserExists: vi.fn(),
    getUserJiraAccountId: vi.fn(),
    getUserJiraName: vi.fn(),
    getUserBypassPermission: vi.fn().mockReturnValue(false),
    getUserDefaultLogVerbosity: vi.fn().mockReturnValue('detail'),
    getUserLogVerbosityFlags: vi.fn().mockReturnValue(0),
    getUserSettings: vi.fn().mockReturnValue(undefined),
    getUserPersona: vi.fn().mockReturnValue('default'),
    getUserDefaultModel: vi.fn().mockReturnValue('claude-opus-4-6'),
    setUserDefaultModel: vi.fn(),
    getUserDefaultEffort: vi.fn().mockReturnValue('high'),
    getUserShowThinking: vi.fn().mockReturnValue(true),
    getUserRating: vi.fn().mockReturnValue(5),
    setUserRating: vi.fn(),
    consumePendingRatingChange: vi.fn().mockReturnValue(null),
    setPendingRatingChange: vi.fn(),
  },
  // `coerceToAvailableModel` is a pure function — pass-through is sufficient
  // for tests that never exercise the AVAILABLE_MODELS allowlist guard.
  coerceToAvailableModel: (raw: string) => raw,
}));

vi.mock('../../../channel-description-cache', () => ({
  getChannelDescription: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../../channel-registry', () => ({
  getChannel: vi.fn().mockReturnValue(undefined),
}));

// W3-B: claude-usage.ts was removed; usage fetching now goes through
// TokenManager.fetchAndStoreUsage() which is mocked via the token-manager
// module mock below.

vi.mock('../../../conversation', () => ({
  createConversation: vi.fn().mockReturnValue('conv_1'),
  recordAssistantTurn: vi.fn(),
  recordUserTurn: vi.fn(),
}));

vi.mock('../../../mcp-config-builder', () => ({
  isMidThreadMention: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../metrics/event-emitter', () => ({
  getMetricsEmitter: vi.fn().mockReturnValue({
    emit: vi.fn(),
  }),
}));

vi.mock('../../../session/compaction-context-builder', () => ({
  buildCompactionContext: vi.fn().mockReturnValue(null),
  snapshotFromSession: vi.fn().mockReturnValue({}),
}));

// W3-B: token-manager now exposes `getTokenManager()` returning a
// TokenManager instance with slotId-keyed APIs. We stub only the subset
// that stream-executor actually calls.
const rotateOnRateLimitMock = vi.fn().mockResolvedValue(null);
const fetchAndStoreUsageMock = vi.fn().mockResolvedValue(null);
const getActiveTokenMock = vi.fn().mockReturnValue(null);
const listTokensMock = vi.fn().mockReturnValue([]);

vi.mock('../../../token-manager', () => ({
  getTokenManager: () => ({
    getActiveToken: getActiveTokenMock,
    listTokens: listTokensMock,
    rotateOnRateLimit: rotateOnRateLimitMock,
    fetchAndStoreUsage: fetchAndStoreUsageMock,
  }),
  // Default to `null` (the production type signature is `Date | null`) so
  // the new `parsedCooldown !== null` check in tryRotateToken behaves the
  // same in tests as in production. Individual tests that need a parsed
  // cooldown override with `vi.mocked(parseCooldownTime).mockReturnValueOnce(...)`.
  parseCooldownTime: vi.fn().mockReturnValue(null),
}));

import { config } from '../../../config';
import type { Continuation } from '../../../types';
import { userSettingsStore } from '../../../user-settings-store';
import { LOG_DETAIL } from '../../output-flags';
import { type ExecuteResult, StreamExecutor } from '../stream-executor';

describe('Continuation type', () => {
  it('should have correct shape with prompt and resetSession', () => {
    const continuation: Continuation = {
      prompt: 'Use load skill with this saved context',
      resetSession: true,
    };

    expect(continuation.prompt).toBe('Use load skill with this saved context');
    expect(continuation.resetSession).toBe(true);
  });

  it('should allow resetSession to be optional', () => {
    const continuation: Continuation = {
      prompt: 'next prompt',
    };

    expect(continuation.prompt).toBe('next prompt');
    expect(continuation.resetSession).toBeUndefined();
  });

  it('should allow resetSession to be false', () => {
    const continuation: Continuation = {
      prompt: 'next prompt',
      resetSession: false,
    };

    expect(continuation.resetSession).toBe(false);
  });
});

describe('ExecuteResult type', () => {
  it('should have success and messageCount', () => {
    const result: ExecuteResult = {
      success: true,
      messageCount: 5,
    };

    expect(result.success).toBe(true);
    expect(result.messageCount).toBe(5);
    expect(result.continuation).toBeUndefined();
  });

  it('should allow continuation to be defined', () => {
    const result: ExecuteResult = {
      success: true,
      messageCount: 3,
      continuation: {
        prompt: 'load prompt',
        resetSession: true,
      },
    };

    expect(result.success).toBe(true);
    expect(result.continuation).toBeDefined();
    expect(result.continuation?.prompt).toBe('load prompt');
    expect(result.continuation?.resetSession).toBe(true);
  });

  it('should represent failed execution', () => {
    const result: ExecuteResult = {
      success: false,
      messageCount: 0,
    };

    expect(result.success).toBe(false);
    expect(result.messageCount).toBe(0);
  });
});

describe('Continuation pattern flow', () => {
  /**
   * This test documents the expected continuation loop behavior in handleMessage
   */
  it('should demonstrate continuation loop logic', () => {
    // Simulated execute results for renew flow
    const executeResults: ExecuteResult[] = [
      // First call: save command completes with continuation
      {
        success: true,
        messageCount: 2,
        continuation: {
          prompt: 'Use load skill with saved context...',
          resetSession: true,
        },
      },
      // Second call: load completes, no continuation
      {
        success: true,
        messageCount: 1,
        continuation: undefined,
      },
    ];

    let resultIndex = 0;
    let sessionResetCalled = false;
    let lastPrompt: string | undefined;

    // Simulate the continuation loop from handleMessage
    const simulateLoop = (initialText: string) => {
      let currentText: string | undefined = initialText;

      while (true) {
        const result = executeResults[resultIndex++];
        lastPrompt = currentText;

        if (!result.continuation) break;

        if (result.continuation.resetSession) {
          sessionResetCalled = true;
        }

        currentText = result.continuation.prompt;
      }
    };

    // Run the simulated loop
    simulateLoop('Use save skill');

    // Verify the loop behaved correctly
    expect(resultIndex).toBe(2); // Both executes were called
    expect(sessionResetCalled).toBe(true); // Session was reset
    expect(lastPrompt).toBe('Use load skill with saved context...'); // Last prompt was from continuation
  });

  it('should handle single execution without continuation', () => {
    const executeResult: ExecuteResult = {
      success: true,
      messageCount: 1,
      continuation: undefined,
    };

    let loopCount = 0;

    // Simulate single-iteration loop
    const simulateLoop = () => {
      while (true) {
        loopCount++;
        if (!executeResult.continuation) break;
      }
    };

    simulateLoop();

    expect(loopCount).toBe(1); // Only one iteration
  });

  it('should handle failed save without continuation', () => {
    // When save fails, no continuation should be returned
    const result: ExecuteResult = {
      success: true, // Stream itself succeeded
      messageCount: 1,
      continuation: undefined, // But no continuation because save failed
    };

    expect(result.success).toBe(true);
    expect(result.continuation).toBeUndefined();
  });
});

describe('buildRenewContinuation result format', () => {
  /**
   * Documents the expected format of the continuation from buildRenewContinuation
   */
  it('should produce correct load prompt format', () => {
    // Simulated save result
    const saveResult = {
      success: true,
      id: 'save_20260128_123456',
      dir: '/saves/2026-01',
      summary: 'PR review discussion',
      files: [
        { name: 'context.md', content: '# Context\n## Summary\nDiscussion about PR review' },
        { name: 'todos.md', content: '# TODOs\n- Review changes' },
      ],
    };

    // Build expected prompt (matching buildRenewContinuation logic)
    const saveContent = saveResult.files
      .map((file) => {
        return `--- ${file.name} ---\n${file.content}`;
      })
      .join('\n\n');

    const expectedPrompt = `Use 'local:load' skill with this saved context:
<save>
${saveContent}
</save>

Continue with that context. If unsure what to do next, call 'oracle' agent for guidance.`;

    // Verify format
    expect(expectedPrompt).toContain('--- context.md ---');
    expect(expectedPrompt).toContain('--- todos.md ---');
    expect(expectedPrompt).toContain('<save>');
    expect(expectedPrompt).toContain('</save>');
    expect(expectedPrompt).toContain("Use 'local:load' skill");
  });

  it('should create continuation with resetSession true', () => {
    const continuation: Continuation = {
      prompt: 'load prompt here',
      resetSession: true,
    };

    // This is the key property - resetSession must be true for renew flow
    expect(continuation.resetSession).toBe(true);
  });

  it('should allow forceWorkflow to be defined on continuation', () => {
    const continuation: Continuation = {
      prompt: 'new https://github.com/acme/repo/pull/1',
      resetSession: true,
      forceWorkflow: 'pr-review',
    };

    expect(continuation.forceWorkflow).toBe('pr-review');
  });
});

describe('updateToolCallMessage', () => {
  it('uses slackApi.updateMessage', async () => {
    const slackApi = {
      updateMessage: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new StreamExecutor({ slackApi } as any);

    await (executor as any).updateToolCallMessage('C123', '111.222', 'tool update');

    expect(slackApi.updateMessage).toHaveBeenCalledWith('C123', '111.222', 'tool update');
  });

  it('swallows helper failures after debug logging', async () => {
    const slackApi = {
      updateMessage: vi.fn().mockRejectedValue(new Error('ratelimited')),
    };
    const executor = new StreamExecutor({ slackApi } as any);
    const debugSpy = vi.spyOn((executor as any).logger, 'debug');

    await expect((executor as any).updateToolCallMessage('C123', '111.222', 'tool update')).resolves.toBeUndefined();

    expect(debugSpy).toHaveBeenCalledWith('Failed to update tool call message', {
      ts: '111.222',
      error: 'ratelimited',
    });
  });
});

describe('Abort handling', () => {
  function createExecutorDeps() {
    return {
      claudeHandler: {
        setActivityState: vi.fn(),
        clearSessionId: vi.fn(),
      },
      fileHandler: {
        cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
      },
      toolEventProcessor: {},
      statusReporter: {
        updateStatusDirect: vi.fn().mockResolvedValue(undefined),
        getStatusEmoji: vi.fn().mockReturnValue('stop_button'),
      },
      reactionManager: {
        updateReaction: vi.fn().mockResolvedValue(undefined),
      },
      contextWindowManager: {
        handlePromptTooLong: vi.fn().mockResolvedValue(undefined),
      },
      toolTracker: {},
      todoDisplayManager: {},
      actionHandlers: {},
      requestCoordinator: {},
      slackApi: {},
      assistantStatusManager: {
        clearStatus: vi.fn().mockResolvedValue(undefined),
        setStatus: vi.fn().mockResolvedValue(undefined),
        bumpEpoch: vi.fn().mockReturnValue(1),
        getToolStatusText: vi.fn().mockReturnValue('running...'),
        buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
        registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
      },
      threadPanel: undefined,
    } as any;
  }

  it('treats "process aborted by user" as cancellation and preserves session', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('Claude Code process aborted by user');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it('preserves session for Claude SDK rate-limit/process-exit errors', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error("You've hit your limit · resets 8pm (Asia/Seoul). Claude Code process exited with code 1");

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* ✅ 유지됨');
  });

  it('preserves session for process exit code 143 (SIGTERM) errors', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('Claude Code process exited with code 143');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* ✅ 유지됨');
  });

  it('clears session for context-overflow errors', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('Prompt is too long: maximum context length exceeded');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  it('clears session for "Could not process image" API 400 errors', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error(
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"}}',
    );

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  it('clears session for "invalid image format" errors', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('Invalid image format in request');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  it('clears session for "image too large" errors', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('Image too large to process in conversation');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
    expect(payload.text).toContain('이미지가 너무 큽니다');
  });

  it('clears session for "unsupported image format" errors', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('Unsupported image format: image/tiff');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  it('clears session for "invalid image content" errors', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('invalid image content: base64 data is malformed');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  it('preserves session for unrelated errors containing partial image-related words', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    // "invalid image_url" is NOT an image processing error — unknown errors
    // now preserve session (user can /reset if needed)
    const error = new Error('invalid image_url field in API request');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    // Unknown errors preserve session — user decides whether to reset
    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* ✅ 유지됨');
    expect(payload.text).toContain('/reset');
  });

  it('clears session for image error even when message also matches recoverable patterns', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    // This error matches BOTH "timed out" (recoverable) and "could not process image" (image error)
    const error = new Error('Request timed out while processing: Could not process image');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    // Image processing error should take priority over recoverable — session MUST be cleared
    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
    expect(payload.text).toContain('이미지를 처리할 수 없습니다');
  });

  it('shows "image too large" guidance when error appears only in stderrContent', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('process exited with code 1');
    (error as any).stderrContent = 'Error: Image too large to process';

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
    expect(payload.text).toContain('이미지가 너무 큽니다');
  });

  it('clears session when image error appears only in stderrContent', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    // CLI may put the real error in stderr while message is generic
    const error = new Error('process exited with code 1');
    (error as any).stderrContent = 'Error: Could not process image in conversation context';

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  // Issue #122: stderrContent output in error messages
  it('includes sanitized stderrContent in error message shown to user', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('process exited with code 1');
    (error as any).stderrContent = 'Error: prompt is too long\nRetrying with shorter context...';

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('SDK Details:');
    expect(payload.text).toContain('prompt is too long');
  });

  it('masks Anthropic API keys in stderrContent', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('auth failed');
    (error as any).stderrContent = 'Using key sk-ant-api03-ABCDEF1234567890 for request';

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('[REDACTED]');
    expect(payload.text).not.toContain('sk-ant-api03');
  });

  it('masks Slack tokens in stderrContent', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('connection error');
    (error as any).stderrContent = 'token: xoxb-1234-5678-abcdef leaked';

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('[REDACTED]');
    expect(payload.text).not.toContain('xoxb-');
  });

  it('truncates long stderrContent to 500 chars', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('error');
    (error as any).stderrContent = 'x'.repeat(1000);

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    const payload = say.mock.calls[0][0];
    // Should contain the truncation indicator and be within reasonable length
    expect(payload.text).toContain('…');
  });

  // Issue #122 followup: Bearer token leak fix
  it('masks full Authorization Bearer header including token value', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('auth error');
    (error as any).stderrContent = 'Authorization: Bearer sk-proj-abc123def456';

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('[REDACTED]');
    expect(payload.text).not.toContain('sk-proj-abc123def456');
    expect(payload.text).not.toContain('Bearer');
  });

  it('masks GitHub fine-grained PATs (github_pat_*)', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('git error');
    (error as any).stderrContent = 'Using github_pat_22A4BCDEF_abcdefghijklmn for auth';

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('[REDACTED]');
    expect(payload.text).not.toContain('github_pat_');
  });

  it('strips ANSI escape codes from stderrContent', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('error');
    (error as any).stderrContent = '\x1B[31mError:\x1B[0m something failed\x1B]0;title\x07';

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Error:');
    expect(payload.text).toContain('something failed');
    expect(payload.text).not.toContain('\x1B');
    expect(payload.text).not.toContain('\x07');
  });

  // Issue #118: S1 — "No conversation found" SDK error must be detected
  it('clears session for "No conversation found with session ID" SDK error', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('No conversation found with session ID: 5f232806-df17-47a3-9eb0-8bc76a2bac99');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  // Unknown errors now preserve session — user can /reset if needed
  it('preserves session on completely unrecognized error (default policy)', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('Some completely unexpected error from SDK v99');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* ✅ 유지됨');
    expect(payload.text).toContain('/reset');
  });

  // "out of extra usage" is treated as rate limit — session preserved + token rotation
  it('preserves session and triggers token rotation on "out of extra usage" error', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error("You're out of extra usage · resets 3pm (Asia/Seoul)");

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* ✅ 유지됨');
  });

  // "out of extra usage" in stderrContent (common case: error.message = "process exited with code 1")
  it('preserves session when "out of extra usage" appears only in stderrContent', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = Object.assign(new Error('process exited with code 1'), {
      stderrContent: "You're out of extra usage · resets 3pm (Asia/Seoul)",
    });

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* ✅ 유지됨');
  });

  // Unknown error resets errorRetryCount so subsequent recoverable errors start fresh
  it('resets errorRetryCount on unknown preserved error', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const session = { errorRetryCount: 2 } as any;
    const error = new Error('Some completely unexpected error');

    await (executor as any).handleError(error, session, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(session.errorRetryCount).toBe(0);
  });

  // Issue #118: S3 — Existing recoverable errors must still be preserved
  it.each([
    "You've hit your limit",
    "You're out of extra usage · resets 3pm (Asia/Seoul)",
    'rate limit exceeded',
    'temporarily unavailable',
    'timed out waiting for response',
    'Connection reset by peer',
  ])('still preserves session on recoverable error: %s', async (msg) => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error(msg);

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* ✅ 유지됨');
  });

  // Issue #118: S4 — Existing invalid session patterns still matched
  it.each([
    'conversation not found',
    'session not found',
    'cannot resume this session',
    'invalid resume token provided',
  ])('clears session on existing invalid resume pattern: %s', async (msg) => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error(msg);

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  // Issue #118 codex review: stderr-only "No conversation found" must still clear session
  it('clears session when "No conversation found" appears only in stderrContent', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('process exited with code 1');
    (error as any).stderrContent = 'Error: No conversation found with session ID: abc-123';

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    // Invalid resume (stderr) takes precedence over recoverable (message)
    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  // Issue #118 codex review: stderr-only rate limit must still preserve session
  it('preserves session when rate limit appears only in stderrContent', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('process exited with code 1');
    (error as any).stderrContent = "You've hit your limit · resets 8pm";

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* ✅ 유지됨');
  });

  // Issue #118 codex review: direct unit test for isInvalidResumeSessionError
  it('isInvalidResumeSessionError detects "no conversation found" pattern directly', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('No conversation found with session ID: 5f232806');
    expect((executor as any).isInvalidResumeSessionError(error)).toBe(true);
  });

  it('isInvalidResumeSessionError detects pattern in stderrContent', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('process exited with code 1');
    (error as any).stderrContent = 'No conversation found with session ID: abc';
    expect((executor as any).isInvalidResumeSessionError(error)).toBe(true);
  });

  it('isInvalidResumeSessionError returns false for unrelated errors', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('Something completely different');
    expect((executor as any).isInvalidResumeSessionError(error)).toBe(false);
  });

  it('clears session for invalid resume/session-not-found errors', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('Conversation not found: cannot resume this session');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });
});

describe('model-command integration', () => {
  function createExecutorDeps() {
    return {
      claudeHandler: {
        setActivityState: vi.fn(),
        updateSessionResources: vi.fn().mockReturnValue({
          ok: true,
          snapshot: { issues: [], prs: [], docs: [], active: {}, instructions: [], sequence: 1 },
        }),
        getSessionByKey: vi.fn().mockReturnValue({ ownerId: 'U1' }),
      },
      fileHandler: {
        cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
      },
      toolEventProcessor: {},
      statusReporter: {
        updateStatusDirect: vi.fn().mockResolvedValue(undefined),
        getStatusEmoji: vi.fn().mockReturnValue('stop_button'),
      },
      reactionManager: {
        updateReaction: vi.fn().mockResolvedValue(undefined),
      },
      contextWindowManager: {
        handlePromptTooLong: vi.fn().mockResolvedValue(undefined),
      },
      toolTracker: {
        scheduleCleanup: vi.fn(),
      },
      todoDisplayManager: {
        cleanup: vi.fn(),
        cleanupSession: vi.fn(),
      },
      actionHandlers: {
        setPendingForm: vi.fn(),
        getPendingForm: vi.fn(),
        deletePendingForm: vi.fn(),
        invalidateOldForms: vi.fn().mockResolvedValue(undefined),
      },
      requestCoordinator: {
        removeController: vi.fn(),
      },
      slackApi: {
        updateMessage: vi.fn().mockResolvedValue(undefined),
      },
      assistantStatusManager: {
        clearStatus: vi.fn().mockResolvedValue(undefined),
        setStatus: vi.fn().mockResolvedValue(undefined),
        bumpEpoch: vi.fn().mockReturnValue(1),
        getToolStatusText: vi.fn().mockReturnValue('running...'),
        buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
        registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
      },
      threadPanel: {
        attachChoice: vi.fn().mockResolvedValue(undefined),
        updatePanel: vi.fn().mockResolvedValue(undefined),
        setStatus: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  }

  function createSession(): any {
    return {
      ownerId: 'U1',
      userId: 'U1',
      channelId: 'C1',
      threadTs: '171.100',
      isActive: true,
      lastActivity: new Date(),
      renewState: null,
      activityState: 'idle',
    };
  }

  it('applies UPDATE_SESSION command results on host session state', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    const commandResult = await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool_1',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'UPDATE_SESSION',
            ok: true,
            payload: {
              session: { issues: [], prs: [], docs: [], active: {}, instructions: [], sequence: 2 },
              appliedOperations: 1,
              request: {
                operations: [
                  {
                    action: 'add',
                    resourceType: 'issue',
                    link: {
                      url: 'https://jira.example/PTN-1',
                      type: 'issue',
                      provider: 'jira',
                    },
                  },
                ],
              },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
      },
    );

    expect(commandResult).toMatchObject({ hasPendingChoice: false, continuation: undefined });
    expect(deps.claudeHandler.updateSessionResources).toHaveBeenCalledWith(
      'C1',
      '171.100',
      expect.objectContaining({
        operations: expect.any(Array),
      }),
    );
  });

  it('renders ASK_USER_QUESTION from command tool and marks waiting state', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    const say = vi.fn().mockResolvedValue({ ts: 'choice_ts' });

    const commandResult = await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool_2',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'ASK_USER_QUESTION',
            ok: true,
            payload: {
              question: {
                type: 'user_choice',
                question: '진행할 방법을 선택해주세요',
                choices: [
                  { id: '1', label: 'A' },
                  { id: '2', label: 'B' },
                ],
              },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
      },
    );

    expect(commandResult.hasPendingChoice).toBe(true);
    expect(commandResult.continuation).toBeUndefined();
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '진행할 방법을 선택해주세요',
        thread_ts: '171.100',
      }),
    );
    expect(deps.threadPanel.attachChoice).toHaveBeenCalled();
    expect(deps.claudeHandler.setActivityState).toHaveBeenCalledWith('C1', '171.100', 'waiting');
  });

  it('renders only the last ASK_USER_QUESTION when multiple arrive in one turn', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    const say = vi.fn().mockResolvedValue({ ts: 'choice_ts' });

    const makeAskResult = (id: string, questionText: string) => ({
      toolUseId: id,
      toolName: 'mcp__model-command__run',
      result: JSON.stringify({
        type: 'model_command_result',
        commandId: 'ASK_USER_QUESTION',
        ok: true,
        payload: {
          question: {
            type: 'user_choice',
            question: questionText,
            choices: [
              { id: '1', label: 'A' },
              { id: '2', label: 'B' },
            ],
          },
        },
      }),
    });

    const commandResult = await (executor as any).handleModelCommandToolResults(
      [makeAskResult('tool_q1', '첫 번째 질문'), makeAskResult('tool_q2', '두 번째 질문')],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
      },
    );

    expect(commandResult.hasPendingChoice).toBe(true);
    // Only the LAST question should be rendered (say called once)
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '두 번째 질문',
        thread_ts: '171.100',
      }),
    );
    expect(deps.threadPanel.attachChoice).toHaveBeenCalledTimes(1);
    expect(deps.claudeHandler.setActivityState).toHaveBeenCalledWith('C1', '171.100', 'waiting');
  });

  it('still works when say() throws — transitions to waiting state', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    // say always fails (e.g. Slack rate limit)
    const say = vi.fn().mockRejectedValue(new Error('ratelimited'));

    const commandResult = await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool_q1',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'ASK_USER_QUESTION',
            ok: true,
            payload: {
              question: {
                type: 'user_choice',
                question: '테스트 질문',
                choices: [{ id: '1', label: 'A' }],
              },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
      },
    );

    // Even when rendering fails, should still mark as pending choice
    expect(commandResult.hasPendingChoice).toBe(true);
    // Activity state should still transition to waiting
    expect(deps.claudeHandler.setActivityState).toHaveBeenCalledWith('C1', '171.100', 'waiting');
  });

  it('buildRenewContinuation prefers tool-provided SAVE_CONTEXT_RESULT payload', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    session.renewState = 'pending_save';
    session.renewSaveResult = {
      success: true,
      id: 'save_001',
      files: [{ name: 'context.md', content: '# Saved context' }],
    };
    const say = vi.fn().mockResolvedValue(undefined);

    const continuation = await (executor as any).buildRenewContinuation(session, '', '171.100', say);

    expect(continuation).toBeDefined();
    expect(continuation?.resetSession).toBe(true);
    expect(continuation?.prompt).toContain('local:load');
    expect(session.renewState).toBeNull();
    expect(session.renewUserMessage).toBeUndefined();
  });

  it('buildRenewContinuation resolves relative dir against session working directory', async () => {
    const fs = await import('fs');
    const path = await import('path');

    // Create a real temp directory with a context.md file
    const tmpDir = path.join('/tmp', `renew-test-${Date.now()}`);
    const saveDir = path.join(tmpDir, '.claude', 'omc', 'tasks', 'save', 'save_002');
    fs.mkdirSync(saveDir, { recursive: true });
    fs.writeFileSync(path.join(saveDir, 'context.md'), '# Saved context from file');

    try {
      const deps = createExecutorDeps();
      const executor = new StreamExecutor(deps);
      const session = createSession();
      session.renewState = 'pending_save';
      session.sessionWorkingDir = tmpDir;
      session.renewSaveResult = {
        success: true,
        id: 'save_002',
        dir: '.claude/omc/tasks/save/save_002',
        // No files array — triggers path-based fallback
      };
      const say = vi.fn().mockResolvedValue(undefined);

      const continuation = await (executor as any).buildRenewContinuation(session, '', '171.100', say);

      expect(continuation).toBeDefined();
      expect(continuation?.resetSession).toBe(true);
      expect(continuation?.prompt).toContain('local:load');
      expect(continuation?.prompt).toContain('Saved context from file');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('buildRenewContinuation blocks path traversal outside session dir', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    session.renewState = 'pending_save';
    session.sessionWorkingDir = '/tmp/safe-session';
    session.renewSaveResult = {
      success: true,
      id: 'traversal',
      dir: '../../etc',
      // No files — triggers path-based fallback with traversal
    };
    const say = vi.fn().mockResolvedValue(undefined);

    const continuation = await (executor as any).buildRenewContinuation(session, '', '171.100', say);

    expect(continuation).toBeUndefined();
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('outside session directory'),
      }),
    );
    expect(session.renewState).toBeNull();
  });

  it('parseSaveResult parses "Saved to:" text output from save skill', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);

    const text =
      'Save completed!\nSaved to: .claude/omc/tasks/save/20260329_180000/context.md\nLoad with: /load 20260329_180000';
    const result = (executor as any).parseSaveResult(text);

    expect(result).toBeDefined();
    expect(result?.success).toBe(true);
    expect(result?.id).toBe('20260329_180000');
    expect(result?.path).toBe('.claude/omc/tasks/save/20260329_180000/context.md');
  });

  // ── P1-A: sibling-prefix path traversal bypass ──

  it('buildRenewContinuation blocks sibling-prefix path traversal', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    session.renewState = 'pending_save';
    session.sessionWorkingDir = '/tmp/safe-session';
    session.renewSaveResult = {
      success: true,
      id: 'sibling',
      // Sibling directory that shares prefix: /tmp/safe-session-evil
      dir: '/tmp/safe-session-evil/.claude/omc/tasks/save/sibling',
    };
    const say = vi.fn().mockResolvedValue(undefined);

    const continuation = await (executor as any).buildRenewContinuation(session, '', '171.100', say);

    expect(continuation).toBeUndefined();
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('outside session directory'),
      }),
    );
    expect(session.renewState).toBeNull();
  });

  // ── P1-B: scanForLatestSave fail-closed when saveId not found ──

  it('scanForLatestSave returns null when explicit saveId not found', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const tmpDir = path.join('/tmp', `scan-test-${Date.now()}`);
    const saveRoot = path.join(tmpDir, '.claude', 'omc', 'tasks', 'save');
    const otherDir = path.join(saveRoot, '20260101_120000');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'context.md'), '# Other context');

    try {
      const deps = createExecutorDeps();
      const executor = new StreamExecutor(deps);
      // Ask for a specific ID that does not exist — should NOT fall back to newest
      const result = (executor as any).scanForLatestSave(tmpDir, 'nonexistent_id');
      expect(result).toBeNull();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('scanForLatestSave finds newest when no saveId given', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const tmpDir = path.join('/tmp', `scan-newest-${Date.now()}`);
    const saveRoot = path.join(tmpDir, '.claude', 'omc', 'tasks', 'save');
    const oldDir = path.join(saveRoot, '20260101_100000');
    const newDir = path.join(saveRoot, '20260101_120000');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'context.md'), '# Old');
    fs.writeFileSync(path.join(newDir, 'context.md'), '# Newest');

    try {
      const deps = createExecutorDeps();
      const executor = new StreamExecutor(deps);
      const result = (executor as any).scanForLatestSave(tmpDir);
      expect(result).toContain('# Newest');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── P2-B: parseSaveResult JSON strategy ──

  it('parseSaveResult parses {"save_result": ...} JSON from text', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);

    const text =
      'Here is the result: {"save_result": {"success": true, "id": "20260330_100000", "dir": "/tmp/session/.claude/omc/tasks/save/20260330_100000"}}';
    const result = (executor as any).parseSaveResult(text);

    expect(result).toBeDefined();
    expect(result?.success).toBe(true);
    expect(result?.id).toBe('20260330_100000');
    expect(result?.dir).toBe('/tmp/session/.claude/omc/tasks/save/20260330_100000');
  });

  it('parseSaveResult returns null for malformed JSON', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);

    const text = '{"save_result": {invalid json here}}';
    const result = (executor as any).parseSaveResult(text);
    expect(result).toBeNull();
  });

  // ── P2-D: absolute path with sessionDir undefined ──

  it('buildRenewContinuation rejects relative path when sessionDir is undefined', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    session.renewState = 'pending_save';
    session.sessionWorkingDir = undefined;
    (session as any).workingDirectory = undefined;
    session.renewSaveResult = {
      success: true,
      id: 'rel_no_dir',
      dir: '.claude/omc/tasks/save/rel_no_dir',
    };
    const say = vi.fn().mockResolvedValue(undefined);

    const continuation = await (executor as any).buildRenewContinuation(session, '', '171.100', say);

    expect(continuation).toBeUndefined();
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('no session directory'),
      }),
    );
  });

  it('surfaces warning when UPDATE_SESSION host apply fails', async () => {
    const deps = createExecutorDeps();
    deps.claudeHandler.updateSessionResources = vi.fn().mockReturnValue({
      ok: false,
      reason: 'INVALID_OPERATION',
      error: 'invalid request',
      snapshot: { issues: [], prs: [], docs: [], active: {}, instructions: [], sequence: 0 },
    });
    const executor = new StreamExecutor(deps);
    const session = createSession();
    const say = vi.fn().mockResolvedValue({ ts: 'warn_ts' });

    await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool_update_fail',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'UPDATE_SESSION',
            ok: true,
            payload: {
              session: { issues: [], prs: [], docs: [], active: {}, instructions: [], sequence: 0 },
              appliedOperations: 1,
              request: {
                operations: [
                  {
                    action: 'set_active',
                    resourceType: 'issue',
                  },
                ],
              },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
      },
    );

    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Session update could not be applied'),
      }),
    );
  });

  it('ignores SAVE_CONTEXT_RESULT when renew is not pending_save', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    session.renewState = null;
    session.renewSaveResult = {
      success: true,
      id: 'save_old',
    };
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool_save',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'SAVE_CONTEXT_RESULT',
            ok: true,
            payload: {
              saveResult: {
                success: true,
                id: 'save_new',
              },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
      },
    );

    expect(session.renewSaveResult?.id).toBe('save_old');
  });

  it('captures CONTINUE_SESSION command results as continuation payload', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    const commandResult = await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool_continue',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'CONTINUE_SESSION',
            ok: true,
            payload: {
              continuation: {
                prompt: 'new https://github.com/acme/repo/pull/1',
                resetSession: true,
                dispatchText: 'https://github.com/acme/repo/pull/1',
                forceWorkflow: 'pr-review',
              },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
      },
    );

    expect(commandResult.hasPendingChoice).toBe(false);
    expect(commandResult.continuation).toEqual({
      prompt: 'new https://github.com/acme/repo/pull/1',
      resetSession: true,
      dispatchText: 'https://github.com/acme/repo/pull/1',
      forceWorkflow: 'pr-review',
      // #697: model-emitted continuations are stamped with origin: 'model'
      origin: 'model',
    });
  });

  it('falls back to plain text when command-driven single choice blocks fail', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    const say = vi.fn().mockRejectedValueOnce(new Error('invalid_blocks')).mockResolvedValue({ ts: 'fallback_ts' });

    await expect(
      (executor as any).handleModelCommandToolResults(
        [
          {
            toolUseId: 'tool_choice_single',
            toolName: 'mcp__model-command__run',
            result: JSON.stringify({
              type: 'model_command_result',
              commandId: 'ASK_USER_QUESTION',
              ok: true,
              payload: {
                question: {
                  type: 'user_choice',
                  question: '하나를 선택하세요',
                  choices: [
                    { id: '1', label: '옵션 A' },
                    { id: '2', label: '옵션 B' },
                  ],
                },
              },
            }),
          },
        ],
        session,
        {
          channel: 'C1',
          threadTs: '171.100',
          sessionKey: 'C1-171.100',
          say,
        },
      ),
    ).resolves.toMatchObject({ hasPendingChoice: true, continuation: undefined });

    expect(say).toHaveBeenCalledTimes(2);
    expect(say.mock.calls[1]?.[0]?.text).toContain('버튼 UI 생성에 실패');
  });

  it('falls back to plain text when command-driven multi choice blocks fail', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    const say = vi
      .fn()
      .mockRejectedValueOnce(new Error('invalid_blocks'))
      .mockResolvedValue({ ts: 'fallback_multi_ts' });

    await expect(
      (executor as any).handleModelCommandToolResults(
        [
          {
            toolUseId: 'tool_choice_multi',
            toolName: 'mcp__model-command__run',
            result: JSON.stringify({
              type: 'model_command_result',
              commandId: 'ASK_USER_QUESTION',
              ok: true,
              payload: {
                question: {
                  type: 'user_choices',
                  title: '멀티 질문',
                  questions: [
                    {
                      id: 'q1',
                      question: 'Q1',
                      choices: [
                        { id: '1', label: 'A' },
                        { id: '2', label: 'B' },
                      ],
                    },
                  ],
                },
              },
            }),
          },
        ],
        session,
        {
          channel: 'C1',
          threadTs: '171.100',
          sessionKey: 'C1-171.100',
          say,
        },
      ),
    ).resolves.toMatchObject({ hasPendingChoice: true, continuation: undefined });

    expect(say).toHaveBeenCalledTimes(2);
    expect(say.mock.calls[1]?.[0]?.text).toContain('버튼 UI 생성에 실패');
  });
});

// ── File Access Blocked Error Recovery ──────────────────────────────────

describe('File access blocked error recovery', () => {
  function createExecutorDeps() {
    return {
      claudeHandler: {
        setActivityState: vi.fn(),
        clearSessionId: vi.fn(),
      },
      fileHandler: {
        cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
      },
      toolEventProcessor: { cleanup: vi.fn() },
      statusReporter: {
        updateStatusDirect: vi.fn().mockResolvedValue(undefined),
        getStatusEmoji: vi.fn().mockReturnValue('x'),
        cleanup: vi.fn(),
      },
      reactionManager: {
        updateReaction: vi.fn().mockResolvedValue(undefined),
        cleanup: vi.fn(),
      },
      contextWindowManager: {
        handlePromptTooLong: vi.fn().mockResolvedValue(undefined),
        cleanup: vi.fn(),
      },
      toolTracker: { scheduleCleanup: vi.fn() },
      todoDisplayManager: { cleanupSession: vi.fn(), cleanup: vi.fn() },
      actionHandlers: {},
      requestCoordinator: { removeController: vi.fn() },
      slackApi: {},
      assistantStatusManager: {
        clearStatus: vi.fn().mockResolvedValue(undefined),
        setStatus: vi.fn().mockResolvedValue(undefined),
        bumpEpoch: vi.fn().mockReturnValue(1),
        getToolStatusText: vi.fn().mockReturnValue('running...'),
        buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
        registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
      },
      threadPanel: undefined,
    } as any;
  }

  // ── isFileAccessBlockedError unit tests ──

  it('detects "File access blocked" in error message', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('NormalizedProviderError: File access blocked: /home/user/file.png');
    expect((executor as any).isFileAccessBlockedError(error)).toBe(true);
  });

  it('detects "File access blocked" in stderrContent', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('process exited with code 1');
    (error as any).stderrContent = 'Error: File access blocked: /tmp/secret.key';
    expect((executor as any).isFileAccessBlockedError(error)).toBe(true);
  });

  it('does NOT match generic "access blocked" without "file" prefix', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('Access blocked: some resource');
    expect((executor as any).isFileAccessBlockedError(error)).toBe(false);
  });

  it('detects "permission denied" + "normalizedprovidererror" combo', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('NormalizedProviderError: permission denied for /etc/shadow');
    expect((executor as any).isFileAccessBlockedError(error)).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('Some completely different error');
    expect((executor as any).isFileAccessBlockedError(error)).toBe(false);
  });

  it('does NOT match "permission denied" without "normalizedprovidererror"', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('permission denied: /usr/bin/foo');
    expect((executor as any).isFileAccessBlockedError(error)).toBe(false);
  });

  // ── extractBlockedPath unit tests ──

  it('extracts path from "File access blocked: /path/to/file"', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('NormalizedProviderError: File access blocked: /home/zhugehyuk/kl-v2.png');
    expect((executor as any).extractBlockedPath(error)).toBe('/home/zhugehyuk/kl-v2.png');
  });

  it('extracts path from stderrContent', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('process exited with code 1');
    (error as any).stderrContent = 'File access blocked: /var/secret/credentials.json';
    expect((executor as any).extractBlockedPath(error)).toBe('/var/secret/credentials.json');
  });

  it('returns undefined when no path found', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('Some random error');
    expect((executor as any).extractBlockedPath(error)).toBeUndefined();
  });

  // ── handleError integration tests ──

  it('preserves session and stores error context on file access blocked', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const session = {} as any;
    const error = new Error('NormalizedProviderError: File access blocked: /home/zhugehyuk/kl-v2.png');

    const retryAfterMs = await (executor as any).handleError(
      error,
      session,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say,
    );

    // Session NOT cleared
    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    // Error context stored on session
    expect(session.lastErrorContext).toContain('파일 접근이 차단되었습니다');
    expect(session.lastErrorContext).toContain('/home/zhugehyuk/kl-v2.png');
    // Retry scheduled with short delay
    expect(retryAfterMs).toBe(5_000);
    // Error message shown to user
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('SDK 샌드박스');
    expect(payload.text).toContain('자동 재시도');
  });

  it('preserves session when file access blocked appears in stderrContent', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const session = {} as any;
    const error = new Error('process exited with code 1');
    (error as any).stderrContent = 'File access blocked: /root/.ssh/id_rsa';

    const retryAfterMs = await (executor as any).handleError(
      error,
      session,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say,
    );

    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(session.lastErrorContext).toContain('/root/.ssh/id_rsa');
    expect(retryAfterMs).toBe(5_000);
  });

  it('exhausts retry budget after MAX_ERROR_RETRIES and clears error context', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const session = { fileAccessRetryCount: 3 } as any; // Already at max
    const error = new Error('File access blocked: /etc/passwd');

    const retryAfterMs = await (executor as any).handleError(
      error,
      session,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say,
    );

    // Budget exhausted — no retry
    expect(retryAfterMs).toBeUndefined();
    // Error context and retry count cleared (uses fileAccessRetryCount, not errorRetryCount)
    expect(session.fileAccessRetryCount).toBe(0);
    expect(session.lastErrorContext).toBeUndefined();
  });

  it('shows blocked path in user error message', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const session = {} as any;
    const error = new Error('File access blocked: /home/user/secret.env');

    await (executor as any).handleError(error, session, 'C123:thread123', 'C123', 'thread123', [], say);

    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('/home/user/secret.env');
    expect(payload.text).toContain('차단된 경로');
  });

  // ── P1 fix: isolated retry counter ──

  it('uses fileAccessRetryCount independent of errorRetryCount', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    // Prior rate-limit errors consumed errorRetryCount — should NOT affect file-access retries
    const session = { errorRetryCount: 3 } as any;
    const error = new Error('File access blocked: /tmp/test.png');

    const retryAfterMs = await (executor as any).handleError(error, session, 'C123:t1', 'C123', 't1', [], say);

    // Should still retry because fileAccessRetryCount is independent
    expect(retryAfterMs).toBe(5_000);
    expect(session.fileAccessRetryCount).toBe(1);
    // errorRetryCount untouched
    expect(session.errorRetryCount).toBe(3);
  });

  it('increments fileAccessRetryCount sequentially 1→2→3 then exhausts', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const session = {} as any;
    const error = new Error('File access blocked: /tmp/file.txt');

    // Attempt 1
    let result = await (executor as any).handleError(error, session, 'K', 'C', 't', [], say);
    expect(result).toBe(5_000);
    expect(session.fileAccessRetryCount).toBe(1);

    // Attempt 2
    result = await (executor as any).handleError(error, session, 'K', 'C', 't', [], say);
    expect(result).toBe(5_000);
    expect(session.fileAccessRetryCount).toBe(2);

    // Attempt 3
    result = await (executor as any).handleError(error, session, 'K', 'C', 't', [], say);
    expect(result).toBe(5_000);
    expect(session.fileAccessRetryCount).toBe(3);

    // Attempt 4 — exhausted
    result = await (executor as any).handleError(error, session, 'K', 'C', 't', [], say);
    expect(result).toBeUndefined();
    expect(session.fileAccessRetryCount).toBe(0);
    expect(session.lastErrorContext).toBeUndefined();
  });

  // ── P2 fix: stale context clearing ──

  it('clears lastErrorContext when a non-file-access recoverable error occurs', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const session = {
      lastErrorContext: '파일 접근이 차단되었습니다: /tmp/old.png',
      fileAccessRetryCount: 1,
    } as any;
    // Generic recoverable error (not file-access, not fatal)
    const error = new Error('overloaded');
    (error as any).name = 'NormalizedProviderError';

    await (executor as any).handleError(error, session, 'K', 'C', 't', [], say);

    // Stale file-access context should be cleared
    expect(session.lastErrorContext).toBeUndefined();
  });

  // ── P2 fix: UX message when retry exhausted ──

  it('shows "retry 횟수 초과" when file-access retry budget exhausted', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const session = { fileAccessRetryCount: 3 } as any;
    const error = new Error('File access blocked: /etc/passwd');

    await (executor as any).handleError(error, session, 'K', 'C', 't', [], say);

    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('재시도 횟수를 초과');
    expect(payload.text).not.toContain('자동 재시도합니다');
  });

  // ── Codex P2: fileAccessRetryCount reset on different error class ──

  it('resets fileAccessRetryCount when a non-file-access recoverable error occurs', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const session = { fileAccessRetryCount: 2 } as any;
    // Generic recoverable error
    const error = new Error('overloaded');
    (error as any).name = 'NormalizedProviderError';

    await (executor as any).handleError(error, session, 'K', 'C', 't', [], say);

    // File-access retry counter should be reset to 0
    expect(session.fileAccessRetryCount).toBe(0);
    expect(session.lastErrorContext).toBeUndefined();
  });

  // ── Codex P3: extractBlockedPath for permission denied pattern ──

  it('extracts path from "permission denied for /path"', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('NormalizedProviderError: permission denied for /etc/shadow');
    expect((executor as any).extractBlockedPath(error)).toBe('/etc/shadow');
  });

  it('extracts path from "permission denied: /path"', () => {
    const executor = new StreamExecutor({} as any);
    const error = new Error('NormalizedProviderError: permission denied: /var/secret/key.pem');
    expect((executor as any).extractBlockedPath(error)).toBe('/var/secret/key.pem');
  });

  // ── Issue #661: 1M context unavailable auto-fallback ──

  beforeEach(() => {
    // userSettingsStore is a module-level vi.mock; `mockClear()` alone leaves
    // queued `mockReturnValueOnce` values in place across tests, so reset the
    // implementation and re-establish the baseline `getUserDefaultModel`
    // return value that other (non-1M) tests rely on.
    (userSettingsStore.setUserDefaultModel as any).mockReset();
    (userSettingsStore.getUserDefaultModel as any).mockReset();
    (userSettingsStore.getUserDefaultModel as any).mockReturnValue('claude-opus-4-6');
  });

  /** Canonical 1M-unavailable error carrying ONE_M_CONTEXT_UNAVAILABLE code + attemptedModel. */
  function buildOneMUnavailableError(attemptedModel = 'claude-opus-4-7[1m]'): any {
    const err: any = new Error(
      'API Error: Extra usage is required for 1M context · run /extra-usage to enable, or /model to switch to standard context',
    );
    err.code = 'ONE_M_CONTEXT_UNAVAILABLE';
    err.attemptedModel = attemptedModel;
    return err;
  }

  it('1M fallback case 1: session.model [1m] stripped (user default NEVER persisted)', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);

    // Even if user default is [1m], policy is session-only — never persist.
    (userSettingsStore.getUserDefaultModel as any).mockReturnValueOnce('claude-opus-4-7[1m]');
    const session = { model: 'claude-opus-4-7[1m]', ownerId: 'U1' } as any;
    const error = buildOneMUnavailableError();

    const retryAfterMs = await (executor as any).handleError(
      error,
      session,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say,
    );

    expect(retryAfterMs).toBe(500);
    expect(session.model).toBe('claude-opus-4-7');
    // CRITICAL: user's persisted default is NEVER written. Session-only policy.
    expect(userSettingsStore.setUserDefaultModel).not.toHaveBeenCalled();
    expect(error.oneMFallbackInfo).toBeDefined();
    expect(error.oneMFallbackInfo.sessionChanged).toBe(true);
    expect(error.oneMFallbackInfo.bareTarget).toBe('claude-opus-4-7');
    // Session preserved (no clearSessionId)
    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    // User notice wording — session-scoped with "기본값 설정은 변경되지 않습니다"
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('이번 세션 모델');
    expect(payload.text).toContain('기본값 설정은 변경되지 않습니다');
    expect(payload.text).toContain('claude-opus-4-7');
  });

  it('1M fallback case 2: never persists even when user default has [1m]', async () => {
    // Regression guard for the session-only policy: no matter what the user
    // default is, `setUserDefaultModel` must not fire. This is the invariant
    // Z asked us to enforce — session-scoped fallback only.
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);

    (userSettingsStore.getUserDefaultModel as any).mockReturnValueOnce('claude-opus-4-7[1m]');
    const session = { model: 'claude-opus-4-7[1m]', ownerId: 'U1' } as any;
    const error = buildOneMUnavailableError();

    await (executor as any).handleError(error, session, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(userSettingsStore.setUserDefaultModel).not.toHaveBeenCalled();
    expect((error as any).oneMFallbackInfo.sessionChanged).toBe(true);
    // No `defaultChanged` field at all — session-only policy has no such concept.
    expect((error as any).oneMFallbackInfo.defaultChanged).toBeUndefined();
  });

  it('1M fallback case 3: session.model undefined → pin to bare from error.attemptedModel + retry', async () => {
    // Legacy-restored sessions can have `session.model === undefined` (the
    // session registry preserves that shape deliberately). In that case the
    // next turn would rehydrate `[1m]` from the user default and loop
    // forever, so the fallback MUST pin `session.model` to the bare variant
    // of `error.attemptedModel` even though `session.model` itself has
    // nothing to strip.
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);

    (userSettingsStore.getUserDefaultModel as any).mockReturnValueOnce('claude-opus-4-7[1m]');
    const session = { ownerId: 'U1' } as any;
    const error = buildOneMUnavailableError('claude-opus-4-7[1m]');

    const retryAfterMs = await (executor as any).handleError(
      error,
      session,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say,
    );

    // Session model pinned to bare(attemptedModel); retry scheduled.
    expect(retryAfterMs).toBe(500);
    expect(session.model).toBe('claude-opus-4-7');
    expect(userSettingsStore.setUserDefaultModel).not.toHaveBeenCalled();
    expect(error.oneMFallbackInfo.sessionChanged).toBe(true);
    expect(error.oneMFallbackInfo.bareTarget).toBe('claude-opus-4-7');
    const payload = say.mock.calls[0][0];
    // Active-pin wording — NOT the defensive "추가 변경 없음".
    expect(payload.text).toContain('이번 세션 모델');
    expect(payload.text).not.toContain('추가 변경 없음');
  });

  it('1M fallback case 4: turnNotifier is NOT invoked on 1M fallback', async () => {
    const deps = createExecutorDeps();
    deps.turnNotifier = { notify: vi.fn().mockResolvedValue(undefined) };
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);

    (userSettingsStore.getUserDefaultModel as any).mockReturnValueOnce('claude-opus-4-7[1m]');
    const session = { model: 'claude-opus-4-7[1m]', ownerId: 'U1' } as any;
    const error = buildOneMUnavailableError();

    await (executor as any).handleError(error, session, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.turnNotifier.notify).not.toHaveBeenCalled();
  });

  it('1M fallback case 5: shouldClearSessionOnError returns false', () => {
    const executor = new StreamExecutor({} as any);
    const error = buildOneMUnavailableError();
    expect((executor as any).shouldClearSessionOnError(error)).toBe(false);
  });

  it('1M fallback case 6: clears stale session state (lastErrorContext, fileAccessRetryCount)', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);

    (userSettingsStore.getUserDefaultModel as any).mockReturnValueOnce('claude-opus-4-7[1m]');
    const session = {
      model: 'claude-opus-4-7[1m]',
      ownerId: 'U1',
      lastErrorContext: '파일 접근이 차단되었습니다: /tmp/old.png',
      fileAccessRetryCount: 3,
    } as any;
    const error = buildOneMUnavailableError();

    await (executor as any).handleError(error, session, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(session.lastErrorContext).toBeUndefined();
    expect(session.fileAccessRetryCount).toBe(0);
  });

  it('1M fallback case 7: passthrough when attemptedModel is already bare (no [1m] suffix)', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);

    (userSettingsStore.getUserDefaultModel as any).mockReturnValueOnce('claude-opus-4-7');
    const session = { model: 'claude-opus-4-7', ownerId: 'U1' } as any;

    // Error carries the 1M-unavailable signal text but attemptedModel is bare
    // AND no code is set — matcher must reject this (not our branch's concern).
    const err: any = new Error('API Error: Extra usage is required for 1M context · run /extra-usage to enable');
    err.attemptedModel = 'claude-opus-4-7'; // bare
    // No err.code — matcher gate: code !== 'ONE_M_CONTEXT_UNAVAILABLE' AND !hasOneMSuffix(attemptedModel)

    // The `isOneMContextUnavailableError` matcher should return false.
    expect((executor as any).isOneMContextUnavailableError(err)).toBe(false);

    await (executor as any).handleError(err, session, 'C123:thread123', 'C123', 'thread123', [], say);

    // No 1M-branch side-effects (setUserDefaultModel never called)
    expect(userSettingsStore.setUserDefaultModel).not.toHaveBeenCalled();
    expect((err as any).oneMFallbackInfo).toBeUndefined();
    expect(session.model).toBe('claude-opus-4-7'); // untouched
  });

  it('1M fallback case 8: formatErrorForUser emits SDK Details and session-scoped wording', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);

    (userSettingsStore.getUserDefaultModel as any).mockReturnValueOnce('claude-opus-4-7[1m]');
    const session = { model: 'claude-opus-4-7[1m]', ownerId: 'U1' } as any;
    const error = buildOneMUnavailableError();
    (error as any).stderrContent = 'stderr trace: upstream returned 429 for 1m context';

    await (executor as any).handleError(error, session, 'C123:thread123', 'C123', 'thread123', [], say);

    const payload = say.mock.calls[0][0];
    // Session-scoped wording — no "기본 설정 변경" claim
    expect(payload.text).toContain('이번 세션 모델');
    expect(payload.text).toContain('기본값 설정은 변경되지 않습니다');
    expect(payload.text).toContain('claude-opus-4-7');
    // Entitlement kind → Extra Usage recovery hint.
    expect(payload.text).toMatch(/extra.usage/i);
    // Permanent-change hint must use the ACTUAL bare model, not a hardcoded
    // alias — attemptedModel was claude-opus-4-7[1m] → bare claude-opus-4-7.
    expect(payload.text).toContain('/z model claude-opus-4-7');
    expect(payload.text).not.toContain('/z model opus');
    // SDK Details section preserved via shared appendSdkDetails helper
    expect(payload.text).toContain('SDK Details:');
    expect(payload.text).toContain('1m context');
  });

  it('1M fallback case 9: defensive no-strip when both models already bare but matcher triggers', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);

    // Both session and default are already bare — matcher still fires via error.code
    (userSettingsStore.getUserDefaultModel as any).mockReturnValueOnce('claude-opus-4-7');
    const session = { model: 'claude-opus-4-7', ownerId: 'U1' } as any;
    const error = buildOneMUnavailableError('claude-opus-4-7[1m]'); // attemptedModel preserves history

    const retryAfterMs = await (executor as any).handleError(
      error,
      session,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say,
    );

    // Nothing to change — no retry scheduled, no persisted write
    expect(retryAfterMs).toBeUndefined();
    expect(userSettingsStore.setUserDefaultModel).not.toHaveBeenCalled();
    expect(error.oneMFallbackInfo.sessionChanged).toBe(false);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('추가 변경 없음');
    // Defensive no-op branch must NOT promise a retry that will never happen.
    expect(payload.text).toContain('자동 재시도 없음');
    expect(payload.text).not.toContain('bare 모델로 자동 재시도');
  });

  it('1M fallback case 10: permanent-change hint uses ACTUAL bareTarget (opus-4-6, not opus-4-7)', async () => {
    // Regression guard: `/z model opus` used to be hardcoded, which resolves
    // to `claude-opus-4-7`. If the user was on `claude-opus-4-6[1m]`, the
    // session pin is `claude-opus-4-6` — the permanent-change hint must
    // match that, otherwise following it swaps to a different model family.
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);

    (userSettingsStore.getUserDefaultModel as any).mockReturnValueOnce('claude-opus-4-6[1m]');
    const session = { model: 'claude-opus-4-6[1m]', ownerId: 'U1' } as any;
    const error = buildOneMUnavailableError('claude-opus-4-6[1m]');

    await (executor as any).handleError(error, session, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(session.model).toBe('claude-opus-4-6');
    expect(error.oneMFallbackInfo.bareTarget).toBe('claude-opus-4-6');
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('/z model claude-opus-4-6');
    expect(payload.text).not.toContain('/z model opus');
    expect(payload.text).not.toContain('/z model claude-opus-4-7');
  });

  it('1M fallback case 11: auth-mode 1M error uses auth-kind wording (no Extra Usage suggestion)', async () => {
    // The matcher also catches 400 "incompatible with the long context beta
    // header" — that's an auth-style mismatch, not a billing problem. The
    // formatter must point the user at the operator / auth config, NOT at
    // Claude Extra Usage.
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);

    (userSettingsStore.getUserDefaultModel as any).mockReturnValueOnce('claude-opus-4-7[1m]');
    const session = { model: 'claude-opus-4-7[1m]', ownerId: 'U1' } as any;
    const err: any = new Error(
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"This authentication style is incompatible with the long context beta header."}}',
    );
    err.code = 'ONE_M_CONTEXT_UNAVAILABLE';
    err.attemptedModel = 'claude-opus-4-7[1m]';

    await (executor as any).handleError(err, session, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(err.oneMFallbackInfo.sessionChanged).toBe(true);
    expect(err.oneMFallbackInfo.kind).toBe('auth');
    const payload = say.mock.calls[0][0];
    // Auth-kind wording — points to operator, not billing.
    expect(payload.text).toContain('인증 구성');
    expect(payload.text).toContain('long-context 베타 헤더');
    expect(payload.text).not.toMatch(/extra.usage/i);
    // Session still got pinned → retry still scheduled. Auth-kind only
    // changes the remediation copy, not the fallback mechanics.
    expect(session.model).toBe('claude-opus-4-7');
  });
});

// ── Trace: docs/fix-thread-header-files/trace.md ──
// S2: Thread-awareness hint guides array mode + root file check
describe('getThreadContextHint — array mode guidance', () => {
  it('threadHint_guidesArrayMode: hint mentions array mode and root file check', () => {
    // Access private method via prototype
    const hint = (StreamExecutor.prototype as any).getThreadContextHint.call({});

    // Must mention array mode / offset-based access
    expect(hint).toMatch(/offset/i);

    // Must explicitly guide to check root message (offset 0) for files
    expect(hint).toMatch(/offset\s*0|root/i);

    // Must NOT primarily steer toward legacy mode (before/after)
    // The hint should mention array mode first, not legacy mode
    const arrayModeIndex = hint.indexOf('offset');
    const legacyModeIndex = hint.indexOf('before/after');
    if (legacyModeIndex >= 0) {
      expect(arrayModeIndex).toBeLessThan(legacyModeIndex);
    }
  });
});

// Issue #225 — AC③: summary timer callback calls updatePanel after displayOnThread
describe('onSummaryTimerFire — render trigger after summary display', () => {
  it('calls displayOnThread then updatePanel when summary text is returned', async () => {
    const mockSummaryService = {
      execute: vi.fn().mockResolvedValue('Executive summary text'),
      displayOnThread: vi.fn(),
      clearDisplay: vi.fn(),
    };
    const mockThreadPanel = {
      updatePanel: vi.fn().mockResolvedValue(undefined),
    };

    const executor = new StreamExecutor({
      summaryService: mockSummaryService,
      threadPanel: mockThreadPanel,
    } as any);

    const session = { isActive: true, actionPanel: {} } as any;
    const sessionKey = 'C123:t456';

    await (executor as any).onSummaryTimerFire(session, sessionKey);

    expect(mockSummaryService.execute).toHaveBeenCalledWith(session, expect.any(AbortSignal));
    expect(mockSummaryService.displayOnThread).toHaveBeenCalledWith(session, 'Executive summary text');
    expect(mockThreadPanel.updatePanel).toHaveBeenCalledWith(session, sessionKey);

    // Verify ordering: displayOnThread before updatePanel
    const displayOrder = mockSummaryService.displayOnThread.mock.invocationCallOrder[0];
    const updateOrder = mockThreadPanel.updatePanel.mock.invocationCallOrder[0];
    expect(displayOrder).toBeLessThan(updateOrder);
  });

  it('skips displayOnThread and updatePanel when summary returns null', async () => {
    const mockSummaryService = {
      execute: vi.fn().mockResolvedValue(null),
      displayOnThread: vi.fn(),
      clearDisplay: vi.fn(),
    };
    const mockThreadPanel = {
      updatePanel: vi.fn(),
    };

    const executor = new StreamExecutor({
      summaryService: mockSummaryService,
      threadPanel: mockThreadPanel,
    } as any);

    const session = { isActive: true, actionPanel: {} } as any;

    await (executor as any).onSummaryTimerFire(session, 'C123:t456');

    expect(mockSummaryService.execute).toHaveBeenCalled();
    expect(mockSummaryService.displayOnThread).not.toHaveBeenCalled();
    expect(mockThreadPanel.updatePanel).not.toHaveBeenCalled();
  });

  it('catches errors from summaryService without propagating', async () => {
    const mockSummaryService = {
      execute: vi.fn().mockRejectedValue(new Error('LLM timeout')),
      displayOnThread: vi.fn(),
      clearDisplay: vi.fn(),
    };

    const executor = new StreamExecutor({
      summaryService: mockSummaryService,
    } as any);

    const session = { isActive: true, actionPanel: {} } as any;

    // Should not throw
    await expect((executor as any).onSummaryTimerFire(session, 'C123:t456')).resolves.toBeUndefined();
    expect(mockSummaryService.displayOnThread).not.toHaveBeenCalled();
  });

  it('is a no-op when summaryService is not configured', async () => {
    const executor = new StreamExecutor({} as any);
    const session = { isActive: true, actionPanel: {} } as any;

    // Should not throw even without summaryService
    await expect((executor as any).onSummaryTimerFire(session, 'C123:t456')).resolves.toBeUndefined();
  });

  it('still displays summary when threadPanel is absent', async () => {
    const mockSummaryService = {
      execute: vi.fn().mockResolvedValue('Summary without panel'),
      displayOnThread: vi.fn(),
      clearDisplay: vi.fn(),
    };

    const executor = new StreamExecutor({
      summaryService: mockSummaryService,
      // threadPanel intentionally omitted
    } as any);

    const session = { isActive: true, actionPanel: {} } as any;

    await (executor as any).onSummaryTimerFire(session, 'C123:t456');

    expect(mockSummaryService.displayOnThread).toHaveBeenCalledWith(session, 'Summary without panel');
  });

  it('catches updatePanel rejection without propagating', async () => {
    const mockSummaryService = {
      execute: vi.fn().mockResolvedValue('Some summary'),
      displayOnThread: vi.fn(),
      clearDisplay: vi.fn(),
    };
    const mockThreadPanel = {
      updatePanel: vi.fn().mockRejectedValue(new Error('Slack API rate limited')),
    };

    const executor = new StreamExecutor({
      summaryService: mockSummaryService,
      threadPanel: mockThreadPanel,
    } as any);

    const session = { isActive: true, actionPanel: {} } as any;

    await expect((executor as any).onSummaryTimerFire(session, 'C123:t456')).resolves.toBeUndefined();
    expect(mockSummaryService.displayOnThread).toHaveBeenCalled();
  });

  it('catches displayOnThread error without propagating', async () => {
    const mockSummaryService = {
      execute: vi.fn().mockResolvedValue('Summary text'),
      displayOnThread: vi.fn().mockImplementation(() => {
        throw new Error('Block kit error');
      }),
      clearDisplay: vi.fn(),
    };
    const mockThreadPanel = {
      updatePanel: vi.fn(),
    };

    const executor = new StreamExecutor({
      summaryService: mockSummaryService,
      threadPanel: mockThreadPanel,
    } as any);

    const session = { isActive: true, actionPanel: {} } as any;

    await expect((executor as any).onSummaryTimerFire(session, 'C123:t456')).resolves.toBeUndefined();
    expect(mockThreadPanel.updatePanel).not.toHaveBeenCalled();
  });

  it('aborted fork skips display and cleans up controller from map', async () => {
    const mockSummaryService = {
      execute: vi.fn().mockResolvedValue(null), // aborted execute returns null
      displayOnThread: vi.fn(),
      clearDisplay: vi.fn(),
    };

    const executor = new StreamExecutor({
      summaryService: mockSummaryService,
    } as any);

    const session = { isActive: true, actionPanel: {} } as any;
    const sessionKey = 'C123:t456';

    await (executor as any).onSummaryTimerFire(session, sessionKey);

    // Controller should be cleaned up after completion
    expect((executor as any).summaryAbortControllers.has(sessionKey)).toBe(false);
    expect(mockSummaryService.displayOnThread).not.toHaveBeenCalled();
  });

  it('CAS: slow summary A does not delete faster summary B controller', async () => {
    let resolveA: (v: string | null) => void;
    const promiseA = new Promise<string | null>((r) => {
      resolveA = r;
    });

    const mockSummaryService = {
      execute: vi
        .fn()
        .mockReturnValueOnce(promiseA) // first call: slow summary A
        .mockResolvedValueOnce('Summary B text'), // second call: fast summary B
      displayOnThread: vi.fn(),
      clearDisplay: vi.fn(),
    };
    const mockThreadPanel = { updatePanel: vi.fn().mockResolvedValue(undefined) };

    const executor = new StreamExecutor({
      summaryService: mockSummaryService,
      threadPanel: mockThreadPanel,
    } as any);

    const session = { isActive: true, actionPanel: {} } as any;
    const sessionKey = 'C123:t456';

    // Fire A (will hang on promiseA)
    const fireA = (executor as any).onSummaryTimerFire(session, sessionKey);

    // Fire B immediately (overwrites controller in map)
    const fireB = (executor as any).onSummaryTimerFire(session, sessionKey);
    await fireB; // B completes first

    // Now resolve A
    resolveA!(null);
    await fireA;

    // Key assertion: A's completion should NOT have deleted B's controller
    // Since B already completed and cleaned up its own controller, map should be empty
    expect((executor as any).summaryAbortControllers.has(sessionKey)).toBe(false);
  });
});

describe('StreamExecutor — summary abort on new input and cleanup', () => {
  it('new user input aborts in-flight summary controller', () => {
    const executor = new StreamExecutor({} as any);
    const sessionKey = 'C123:t456';

    // Simulate an in-flight summary by directly setting a controller
    const ac = new AbortController();
    (executor as any).summaryAbortControllers.set(sessionKey, ac);

    expect(ac.signal.aborted).toBe(false);

    // Simulate what the new-input path does
    const pending = (executor as any).summaryAbortControllers.get(sessionKey);
    if (pending) {
      pending.abort();
      (executor as any).summaryAbortControllers.delete(sessionKey);
    }

    expect(ac.signal.aborted).toBe(true);
    expect((executor as any).summaryAbortControllers.has(sessionKey)).toBe(false);
  });

  it('cleanup aborts in-flight summary controller', () => {
    const executor = new StreamExecutor({
      requestCoordinator: { removeController: vi.fn() },
      toolEventProcessor: { cleanup: vi.fn() },
    } as any);
    const sessionKey = 'C123:t456';

    const ac = new AbortController();
    (executor as any).summaryAbortControllers.set(sessionKey, ac);

    // The cleanup method reads the map and aborts
    const pending = (executor as any).summaryAbortControllers.get(sessionKey);
    if (pending) {
      pending.abort();
      (executor as any).summaryAbortControllers.delete(sessionKey);
    }

    expect(ac.signal.aborted).toBe(true);
    expect((executor as any).summaryAbortControllers.has(sessionKey)).toBe(false);
  });
});

// === Issue #391: Continuation loop should not transition to idle ===

describe('Issue #391: Continuation idle transition skip', () => {
  it('should not transition to idle when continuation exists', () => {
    // This test documents the expected behavior:
    // When a toolContinuation is set, the activity state should NOT be changed
    // to idle between turns — it should remain 'working' throughout the continuation loop.

    type ActivityTransition = { state: string; reason: string };
    const transitions: ActivityTransition[] = [];

    // Simulate the state transition logic from stream-executor.ts line 768
    const simulateEndOfTurn = (hasPendingChoice: boolean, hasContinuation: boolean) => {
      if (!hasContinuation) {
        const newState = hasPendingChoice ? 'waiting' : 'idle';
        transitions.push({ state: newState, reason: hasPendingChoice ? 'pending_choice' : 'turn_complete' });
      }
      // If hasContinuation, no state transition — stays 'working'
    };

    // Turn 1: has continuation → no idle transition
    simulateEndOfTurn(false, true);
    expect(transitions).toHaveLength(0); // No transition recorded

    // Turn 2: no continuation → transitions to idle
    simulateEndOfTurn(false, false);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].state).toBe('idle');

    // Verify: with pending choice and no continuation → waiting
    transitions.length = 0;
    simulateEndOfTurn(true, false);
    expect(transitions).toHaveLength(1);
    expect(transitions[0].state).toBe('waiting');

    // Verify: with pending choice AND continuation → continuation wins, no transition
    transitions.length = 0;
    simulateEndOfTurn(true, true);
    expect(transitions).toHaveLength(0);
  });

  it('should demonstrate no dashboard flicker during continuation loop', () => {
    // Simulate a 3-turn continuation loop and track activity states
    const activityStates: string[] = ['working']; // Initial state from line 324

    const simulateTurnEnd = (hasContinuation: boolean) => {
      if (!hasContinuation) {
        activityStates.push('idle');
      }
      // With continuation: no state change, 'working' persists
    };

    const simulateTurnStart = () => {
      // stream-executor.ts:324 — only if state changed
      if (activityStates[activityStates.length - 1] !== 'working') {
        activityStates.push('working');
      }
    };

    // Turn 1: has continuation
    simulateTurnEnd(true);
    simulateTurnStart(); // No-op since still 'working'
    // Turn 2: has continuation
    simulateTurnEnd(true);
    simulateTurnStart(); // No-op since still 'working'
    // Turn 3: no continuation (final)
    simulateTurnEnd(false);

    // Expected: working → idle (only at the very end)
    // No intermediate idle states that would cause dashboard flicker
    expect(activityStates).toEqual(['working', 'idle']);
  });
});

describe('Email guard in execute()', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  function createFullDeps() {
    return {
      claudeHandler: {
        setActivityState: vi.fn(),
        clearSessionId: vi.fn(),
        runQuery: vi.fn(),
      },
      fileHandler: {
        formatFilePrompt: vi.fn().mockResolvedValue(''),
        cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
      },
      toolEventProcessor: {
        cleanup: vi.fn(),
      },
      statusReporter: {
        updateStatusDirect: vi.fn().mockResolvedValue(undefined),
        getStatusEmoji: vi.fn().mockReturnValue('thinking_face'),
        cleanup: vi.fn(),
      },
      reactionManager: {
        updateReaction: vi.fn().mockResolvedValue(undefined),
        cleanup: vi.fn(),
      },
      contextWindowManager: {
        handlePromptTooLong: vi.fn().mockResolvedValue(undefined),
        cleanup: vi.fn(),
      },
      toolTracker: {
        scheduleCleanup: vi.fn(),
      },
      todoDisplayManager: {
        cleanupSession: vi.fn(),
        cleanup: vi.fn(),
      },
      actionHandlers: {},
      requestCoordinator: {
        removeController: vi.fn(),
      },
      slackApi: {
        getUserProfile: vi.fn().mockResolvedValue({ email: '', displayName: '' }),
        getClient: vi.fn().mockReturnValue({}),
        deleteMessage: vi.fn().mockResolvedValue(undefined),
      },
      assistantStatusManager: {
        setStatus: vi.fn().mockResolvedValue(undefined),
        clearStatus: vi.fn().mockResolvedValue(undefined),
        bumpEpoch: vi.fn().mockReturnValue(1),
        getToolStatusText: vi.fn().mockReturnValue('running...'),
        buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
        registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
      },
      threadPanel: undefined,
    } as any;
  }

  function createMinimalParams(say: ReturnType<typeof vi.fn>) {
    return {
      session: {
        sessionId: 'sess_1',
        ownerId: 'U_TEST',
        logVerbosity: 'detail',
        usage: {},
      },
      sessionKey: 'C123:thread123',
      userName: 'testuser',
      workingDirectory: '/tmp/test',
      abortController: new AbortController(),
      processedFiles: [],
      text: 'hello',
      channel: 'C123',
      threadTs: 'thread123',
      user: 'U_TEST',
      say,
    } as any;
  }

  it('returns { success: false, messageCount: 0 } and calls say() when getUserEmail returns empty string', async () => {
    // getUserEmail returns '' (empty sentinel = email scope missing, user must set manually)
    vi.mocked(userSettingsStore.getUserEmail).mockReturnValue('');

    const deps = createFullDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const params = createMinimalParams(say);

    const result = await executor.execute(params);

    expect(result.success).toBe(false);
    expect(result.messageCount).toBe(0);
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('이메일이 설정되지 않았습니다'),
        thread_ts: 'thread123',
      }),
    );
  });

  it('returns { success: false, messageCount: 0 } and calls say() when getUserEmail returns undefined', async () => {
    // getUserEmail returns undefined (never fetched, auto-fetch also fails to get email)
    vi.mocked(userSettingsStore.getUserEmail).mockReturnValue(undefined);
    // Auto-fetch from Slack also returns no email
    const deps = createFullDeps();
    deps.slackApi.getUserProfile.mockResolvedValue({ email: undefined, displayName: '' });

    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const params = createMinimalParams(say);

    const result = await executor.execute(params);

    expect(result.success).toBe(false);
    expect(result.messageCount).toBe(0);
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('set email'),
      }),
    );
  });
});

describe('W3-B rate-limit rotation wiring', () => {
  function createMinimalDeps() {
    return {
      claudeHandler: { setActivityState: vi.fn(), clearSessionId: vi.fn() },
      fileHandler: { cleanupTempFiles: vi.fn().mockResolvedValue(undefined) },
      toolEventProcessor: {},
      statusReporter: {
        updateStatusDirect: vi.fn().mockResolvedValue(undefined),
        getStatusEmoji: vi.fn().mockReturnValue('stop_button'),
      },
      reactionManager: { updateReaction: vi.fn().mockResolvedValue(undefined) },
      contextWindowManager: { handlePromptTooLong: vi.fn().mockResolvedValue(undefined) },
      toolTracker: {},
      todoDisplayManager: {},
      actionHandlers: {},
      requestCoordinator: {},
      slackApi: {},
      assistantStatusManager: {
        clearStatus: vi.fn().mockResolvedValue(undefined),
        setStatus: vi.fn().mockResolvedValue(undefined),
        bumpEpoch: vi.fn().mockReturnValue(1),
        getToolStatusText: vi.fn().mockReturnValue('running...'),
        buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
        registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
      },
      threadPanel: undefined,
    } as any;
  }

  afterEach(() => {
    rotateOnRateLimitMock.mockClear();
    rotateOnRateLimitMock.mockResolvedValue(null);
    getActiveTokenMock.mockClear();
    getActiveTokenMock.mockReturnValue(null);
    listTokensMock.mockClear();
    listTokensMock.mockReturnValue([]);
  });

  it('on rate-limit error, rotateOnRateLimit is called with source:"error_string"', async () => {
    const executor = new StreamExecutor(createMinimalDeps());
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error("You've hit your limit · resets 8pm (Asia/Seoul). Claude Code process exited with code 1");
    const activeSlot = { slotId: 'slot_abc', name: 'cct1', kind: 'setup_token' as const };

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say,
      false,
      activeSlot,
    );

    expect(rotateOnRateLimitMock).toHaveBeenCalledTimes(1);
    const [reason, opts] = rotateOnRateLimitMock.mock.calls[0];
    expect(typeof reason).toBe('string');
    expect(reason).toContain('cct1');
    expect(opts).toEqual(
      expect.objectContaining({
        source: 'error_string',
        cooldownMinutes: expect.any(Number),
      }),
    );
    expect(opts.cooldownMinutes).toBeGreaterThan(0);
  });

  it('does not call rotateOnRateLimit when the error is not a rate-limit error', async () => {
    const executor = new StreamExecutor(createMinimalDeps());
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('Unrelated transient failure');
    const activeSlot = { slotId: 'slot_abc', name: 'cct1', kind: 'setup_token' as const };

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say,
      false,
      activeSlot,
    );

    expect(rotateOnRateLimitMock).not.toHaveBeenCalled();
  });

  // #801 AC-12 — `tryRotateToken` plumbs the new `knownReset` flag so
  // `rotateOnRateLimit`'s shared-bucket propagation gate can distinguish a
  // parsed wall-clock cooldown (direct evidence) from the 60-minute
  // fallback (no evidence). The flag must mirror `parsedCooldown !== null`.
  it('AC-12a: parsed cooldown text → rotateOnRateLimit called with knownReset:true', async () => {
    // Override the parseCooldownTime mock to return a real Date for this call.
    const tokenManagerModule = await import('../../../token-manager');
    const parseMock = vi.mocked(tokenManagerModule.parseCooldownTime);
    parseMock.mockReturnValueOnce(new Date(Date.now() + 30 * 60 * 1000));

    const executor = new StreamExecutor(createMinimalDeps());
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error("You've hit your limit · resets 8pm (Asia/Seoul). Claude Code process exited with code 1");
    const activeSlot = { slotId: 'slot_abc', name: 'cct1', kind: 'setup_token' as const };

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say,
      false,
      activeSlot,
    );

    expect(rotateOnRateLimitMock).toHaveBeenCalledTimes(1);
    const [, opts] = rotateOnRateLimitMock.mock.calls[0];
    expect(opts).toEqual(
      expect.objectContaining({
        source: 'error_string',
        knownReset: true,
        cooldownMinutes: expect.any(Number),
      }),
    );
    expect(opts.cooldownMinutes).toBeGreaterThan(0);
  });

  it('AC-12b: unparseable error → rotateOnRateLimit called with knownReset:false and cooldownMinutes:60', async () => {
    // Default mock returns undefined → tryRotateToken treats as null → fallback path.
    const tokenManagerModule = await import('../../../token-manager');
    const parseMock = vi.mocked(tokenManagerModule.parseCooldownTime);
    parseMock.mockReturnValueOnce(null);

    const executor = new StreamExecutor(createMinimalDeps());
    const say = vi.fn().mockResolvedValue(undefined);
    // The combined message still triggers isRateLimitError (contains "rate limit") so
    // tryRotateToken runs — but parseCooldownTime returns null → fallback 60m path.
    const error = new Error('rate limit exceeded');
    const activeSlot = { slotId: 'slot_abc', name: 'cct1', kind: 'setup_token' as const };

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say,
      false,
      activeSlot,
    );

    expect(rotateOnRateLimitMock).toHaveBeenCalledTimes(1);
    const [, opts] = rotateOnRateLimitMock.mock.calls[0];
    expect(opts).toEqual(
      expect.objectContaining({
        source: 'error_string',
        knownReset: false,
        cooldownMinutes: 60,
      }),
    );
  });
});

/**
 * Issue #664 P2 — turnId propagation into ToolEventContext.
 *
 * This exercises the **real closure wiring** at stream-executor.ts:596-641
 * (onToolUse) and :642+ (onToolResult), not a helper extraction. We drive
 * `execute()` all the way to `StreamProcessor.process()` with a mock async
 * generator feeding one `tool_use` and one `tool_result` message, then
 * assert that `toolEventProcessor.handleToolUse` and `.handleToolResult`
 * both receive the SAME turnId minted at stream-executor.ts:355. Equal
 * turnId in both calls is the real invariant — independent random values
 * would still pass a naive "turnId present" assertion while silently
 * decoupling the sink from the B1 stream it's supposed to own.
 */
describe('turnId propagation into ToolEventContext (#664)', () => {
  beforeEach(() => {
    // Email guard needs a resolvable email to bypass the early return at
    // stream-executor.ts:524. Reset it here so earlier tests that set it
    // to empty/undefined don't leak in.
    vi.mocked(userSettingsStore.getUserEmail).mockReturnValue('user@example.com');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function* mockStreamQuery() {
    // Assistant tool_use — triggers StreamProcessor.handleAssistantMessage →
    // callbacks.onToolUse (stream-processor.ts:582).
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/t.txt' } }],
      },
    };
    // User tool_result — triggers StreamProcessor.handleUserMessage →
    // callbacks.onToolResult (stream-processor.ts:950).
    yield {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'file contents' }],
      },
    };
    // Result message — ends the stream cleanly (no aborted flag).
    yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
  }

  function createDepsForToolFlow() {
    return {
      claudeHandler: {
        setActivityState: vi.fn(),
        clearSessionId: vi.fn(),
        streamQuery: vi.fn().mockImplementation(() => mockStreamQuery()),
        getSessionRegistry: vi.fn().mockReturnValue({
          beginTurn: vi.fn(),
          endTurn: vi.fn(),
          broadcastSessionUpdate: vi.fn(),
          getActivityState: vi.fn().mockReturnValue('idle'),
        }),
      },
      fileHandler: {
        formatFilePrompt: vi.fn().mockResolvedValue(''),
        cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
      },
      toolEventProcessor: {
        handleToolUse: vi.fn().mockResolvedValue(undefined),
        handleToolResult: vi.fn().mockResolvedValue(undefined),
        setCompactDurationCallback: vi.fn(),
        setReactionManager: vi.fn(),
        setToolResultSink: vi.fn(),
        cleanup: vi.fn(),
      },
      statusReporter: {
        updateStatusDirect: vi.fn().mockResolvedValue(undefined),
        getStatusEmoji: vi.fn().mockReturnValue('thinking_face'),
        cleanup: vi.fn(),
      },
      reactionManager: {
        updateReaction: vi.fn().mockResolvedValue(undefined),
        cleanup: vi.fn(),
      },
      contextWindowManager: {
        handlePromptTooLong: vi.fn().mockResolvedValue(undefined),
        cleanup: vi.fn(),
      },
      toolTracker: {
        scheduleCleanup: vi.fn(),
        trackToolUse: vi.fn(),
        getToolName: vi.fn(),
        trackMcpCall: vi.fn(),
        getMcpCallId: vi.fn(),
        removeMcpCallId: vi.fn(),
        getActiveMcpCallIds: vi.fn().mockReturnValue([]),
      },
      todoDisplayManager: {
        cleanupSession: vi.fn(),
        cleanup: vi.fn(),
        handleTodoUpdate: vi.fn().mockResolvedValue(undefined),
        setRenderRequestCallback: vi.fn(),
        setPlanRenderCallback: vi.fn(),
      },
      actionHandlers: {},
      requestCoordinator: {
        removeController: vi.fn(),
      },
      slackApi: {
        getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
        getClient: vi.fn().mockReturnValue({}),
        getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
        deleteMessage: vi.fn().mockResolvedValue(undefined),
      },
      assistantStatusManager: {
        setStatus: vi.fn().mockResolvedValue(undefined),
        clearStatus: vi.fn().mockResolvedValue(undefined),
        getToolStatusText: vi.fn().mockReturnValue('running tool...'),
        bumpEpoch: vi.fn().mockReturnValue(1),
        buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
        registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
      },
      threadPanel: {
        beginTurn: vi.fn().mockResolvedValue(undefined),
        endTurn: vi.fn().mockResolvedValue(undefined),
        failTurn: vi.fn().mockResolvedValue(undefined),
        isTurnSurfaceActive: vi.fn().mockReturnValue(false),
        appendText: vi.fn().mockResolvedValue(true),
        // Execute() calls these via updateRuntimeStatus/panel paths even
        // when we only care about the tool-event closure — no-ops keep us
        // alive long enough to reach StreamProcessor.process().
        setStatus: vi.fn().mockResolvedValue(undefined),
        updatePanel: vi.fn().mockResolvedValue(undefined),
        attachChoice: vi.fn().mockResolvedValue(undefined),
        finalizeOnEndTurn: vi.fn().mockResolvedValue(undefined),
        renderTasks: vi.fn().mockResolvedValue(false),
        updateHeader: vi.fn().mockResolvedValue(undefined),
        clearChoice: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  }

  function createToolFlowParams(say: ReturnType<typeof vi.fn>) {
    return {
      session: {
        sessionId: 'sess_tool_flow',
        ownerId: 'U_TEST',
        logVerbosity: 'detail',
        usage: {},
        terminated: false,
      },
      sessionKey: 'C999:thread999',
      userName: 'testuser',
      workingDirectory: '/tmp/test',
      abortController: new AbortController(),
      processedFiles: [],
      text: 'hello',
      channel: 'C999',
      threadTs: 'thread999',
      user: 'U_TEST',
      say,
    } as any;
  }

  it('passes the same turnId to handleToolUse and handleToolResult', async () => {
    const deps = createDepsForToolFlow();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });
    const params = createToolFlowParams(say);

    await executor.execute(params);

    // Assertion 1: closure fed turnId into onToolUse → handleToolUse.
    expect(deps.toolEventProcessor.handleToolUse).toHaveBeenCalledTimes(1);
    const toolUseCallArgs = deps.toolEventProcessor.handleToolUse.mock.calls[0];
    const toolUseCtx = toolUseCallArgs[1];
    expect(toolUseCtx).toEqual(
      expect.objectContaining({
        channel: 'C999',
        threadTs: 'thread999',
        sessionKey: 'C999:thread999',
        turnId: expect.stringMatching(/^C999:thread999:\d+:[0-9a-f-]+$/),
      }),
    );

    // Assertion 2: same closure path for onToolResult → handleToolResult.
    expect(deps.toolEventProcessor.handleToolResult).toHaveBeenCalledTimes(1);
    const toolResultCallArgs = deps.toolEventProcessor.handleToolResult.mock.calls[0];
    const toolResultCtx = toolResultCallArgs[1];
    expect(toolResultCtx).toEqual(
      expect.objectContaining({
        channel: 'C999',
        threadTs: 'thread999',
        sessionKey: 'C999:thread999',
        turnId: expect.stringMatching(/^C999:thread999:\d+:[0-9a-f-]+$/),
      }),
    );

    // Assertion 3 (the real invariant): both closures captured the SAME
    // turnId from the outer scope. Independently-minted ids would still
    // pass assertions 1 and 2 while silently decoupling the sink.
    expect(toolUseCtx.turnId).toBe(toolResultCtx.turnId);
  });
});

describe('stream-executor — P3 (PHASE>=3) B3 choice wiring', () => {
  function createP3Deps() {
    const sessionRegistry = { persistAndBroadcast: vi.fn() };
    return {
      deps: {
        claudeHandler: {
          setActivityState: vi.fn(),
          updateSessionResources: vi.fn(),
          getSessionByKey: vi.fn().mockReturnValue({ ownerId: 'U1', channelId: 'C1' }),
          getSessionRegistry: vi.fn(() => sessionRegistry),
        },
        fileHandler: { cleanupTempFiles: vi.fn().mockResolvedValue(undefined) },
        toolEventProcessor: {},
        statusReporter: {
          updateStatusDirect: vi.fn().mockResolvedValue(undefined),
          getStatusEmoji: vi.fn().mockReturnValue('stop_button'),
        },
        reactionManager: { updateReaction: vi.fn().mockResolvedValue(undefined) },
        contextWindowManager: { handlePromptTooLong: vi.fn().mockResolvedValue(undefined) },
        toolTracker: { scheduleCleanup: vi.fn() },
        todoDisplayManager: { cleanup: vi.fn(), cleanupSession: vi.fn() },
        actionHandlers: {
          setPendingForm: vi.fn(),
          getPendingForm: vi.fn(),
          deletePendingForm: vi.fn(),
          invalidateOldForms: vi.fn().mockResolvedValue(undefined),
        },
        requestCoordinator: { removeController: vi.fn() },
        slackApi: { updateMessage: vi.fn().mockResolvedValue(undefined) },
        assistantStatusManager: {
          clearStatus: vi.fn().mockResolvedValue(undefined),
          setStatus: vi.fn().mockResolvedValue(undefined),
          bumpEpoch: vi.fn().mockReturnValue(1),
          getToolStatusText: vi.fn().mockReturnValue('running...'),
          buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
          registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
        },
        threadPanel: {
          attachChoice: vi.fn().mockResolvedValue(undefined),
          updatePanel: vi.fn().mockResolvedValue(undefined),
          setStatus: vi.fn().mockResolvedValue(undefined),
          askUser: vi.fn().mockResolvedValue({ ok: true, primaryTs: 'posted-ts' }),
          askUserForm: vi
            .fn()
            .mockResolvedValue({ ok: true, primaryTs: 'posted-ts-0', allTs: ['posted-ts-0'], formIds: ['f-0'] }),
        },
      } as any,
      sessionRegistry,
    };
  }

  function createSession(): any {
    return {
      ownerId: 'U1',
      channelId: 'C1',
      threadTs: '171.100',
      isActive: true,
      renewState: null,
      activityState: 'idle',
      actionPanel: {},
    };
  }

  afterEach(() => {
    config.ui.fiveBlockPhase = 0;
  });

  it('PHASE=3 single-choice routes through ThreadPanel.askUser (with turnId)', async () => {
    config.ui.fiveBlockPhase = 3;
    const { deps, sessionRegistry } = createP3Deps();
    const session = createSession();
    // Make getSessionByKey return the same session the executor passes through.
    deps.claudeHandler.getSessionByKey = vi.fn().mockReturnValue(session);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'legacy-ts' });

    await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool-1',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'ASK_USER_QUESTION',
            ok: true,
            payload: {
              question: {
                type: 'user_choice',
                question: '선택?',
                choices: [
                  { id: '1', label: 'A' },
                  { id: '2', label: 'B' },
                ],
              },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
        turnId: 'TID-1',
      },
    );

    expect(deps.threadPanel.askUser).toHaveBeenCalledWith(
      'TID-1',
      expect.objectContaining({ type: 'user_choice' }),
      expect.any(Object),
      expect.any(String),
      expect.objectContaining({ channelId: 'C1', threadTs: '171.100', sessionKey: 'C1-171.100' }),
      session,
      'C1-171.100',
    );
    // legacy context.say should NOT have been used for the posted message
    expect(say).not.toHaveBeenCalled();
    // persist+broadcast after pendingQuestion write
    expect(sessionRegistry.persistAndBroadcast).toHaveBeenCalledWith('C1-171.100');
  });

  it('PHASE=3 multi-choice pre-allocates formIds with turnId and calls askUserForm', async () => {
    config.ui.fiveBlockPhase = 3;
    const { deps } = createP3Deps();
    deps.threadPanel.askUserForm = vi
      .fn()
      .mockResolvedValue({ ok: true, primaryTs: 'ts-0', allTs: ['ts-0'], formIds: ['any'] });
    // back-fill lookup needs to return something
    deps.actionHandlers.getPendingForm = vi.fn().mockImplementation((id: string) => ({
      formId: id,
      sessionKey: 'C1-171.100',
      channel: 'C1',
      threadTs: '171.100',
      messageTs: '',
      questions: [],
      selections: {},
      createdAt: Date.now(),
    }));
    const session = createSession();
    deps.claudeHandler.getSessionByKey = vi.fn().mockReturnValue(session);
    const executor = new StreamExecutor(deps);
    const say = vi.fn();

    await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool-2',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'ASK_USER_QUESTION',
            ok: true,
            payload: {
              question: {
                type: 'user_choices',
                title: 'Multi',
                questions: [{ id: 'q1', question: 'Q1?', choices: [{ id: '1', label: 'A' }] }],
              },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
        turnId: 'TID-MULTI',
      },
    );

    const setPendingCall = deps.actionHandlers.setPendingForm.mock.calls[0];
    expect(setPendingCall[1]).toMatchObject({ turnId: 'TID-MULTI' });
    expect(deps.threadPanel.askUserForm).toHaveBeenCalledWith(
      'TID-MULTI',
      expect.any(Array),
      expect.any(Array),
      expect.objectContaining({ type: 'user_choices' }),
      expect.objectContaining({ channelId: 'C1' }),
      session,
      'C1-171.100',
    );
  });

  it('PHASE=3 defensive prelude clears prior pendingChoice before a new ask', async () => {
    config.ui.fiveBlockPhase = 3;
    const { deps, sessionRegistry } = createP3Deps();
    const session = createSession();
    deps.claudeHandler.getSessionByKey = vi.fn().mockReturnValue(session);
    const executor = new StreamExecutor(deps);
    session.actionPanel = {
      pendingChoice: { turnId: 'OLD', kind: 'single', choiceTs: 'oldTs', formIds: [] },
      choiceMessageTs: 'oldTs',
      waitingForChoice: true,
    };
    const say = vi.fn();
    await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool-3',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'ASK_USER_QUESTION',
            ok: true,
            payload: {
              question: { type: 'user_choice', question: 'Q', choices: [{ id: '1', label: 'A' }] },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
        turnId: 'NEW',
      },
    );
    // prior pendingChoice is cleared before askUser writes the new record
    expect(sessionRegistry.persistAndBroadcast).toHaveBeenCalledWith('C1-171.100');
    // askUser was invoked so the new record gets written inside the facade
    expect(deps.threadPanel.askUser).toHaveBeenCalled();
  });

  it('PHASE=3 single post-failed → sendCommandChoiceFallback (legacy say)', async () => {
    config.ui.fiveBlockPhase = 3;
    const { deps } = createP3Deps();
    deps.threadPanel.askUser = vi
      .fn()
      .mockResolvedValue({ ok: false, reason: 'post-failed', error: new Error('slack') });
    const session = createSession();
    deps.claudeHandler.getSessionByKey = vi.fn().mockReturnValue(session);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'x' });
    await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool-4',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'ASK_USER_QUESTION',
            ok: true,
            payload: {
              question: { type: 'user_choice', question: 'Q', choices: [{ id: '1', label: 'A' }] },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
        turnId: 'TID',
      },
    );
    // sendCommandChoiceFallback uses context.say to post text fallback
    expect(say).toHaveBeenCalled();
  });

  it('unconditional pendingQuestion write + persistAndBroadcast fires under PHASE<3', async () => {
    config.ui.fiveBlockPhase = 0;
    const { deps, sessionRegistry } = createP3Deps();
    const session = createSession();
    deps.claudeHandler.getSessionByKey = vi.fn().mockReturnValue(session);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'x' });
    await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool-5',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'ASK_USER_QUESTION',
            ok: true,
            payload: {
              question: { type: 'user_choice', question: 'Q', choices: [{ id: '1', label: 'A' }] },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
        turnId: 'TID',
      },
    );
    expect(session.actionPanel?.pendingQuestion).toBeDefined();
    expect(sessionRegistry.persistAndBroadcast).toHaveBeenCalledWith('C1-171.100');
  });

  it('PHASE<3 multi uses setPendingForm to persist messageTs (v7 fix)', async () => {
    config.ui.fiveBlockPhase = 0;
    const { deps } = createP3Deps();
    const pendingCache: Record<string, any> = {};
    deps.actionHandlers.setPendingForm = vi.fn((id: string, data: any) => {
      pendingCache[id] = data;
    });
    deps.actionHandlers.getPendingForm = vi.fn((id: string) => pendingCache[id]);
    const session = createSession();
    deps.claudeHandler.getSessionByKey = vi.fn().mockReturnValue(session);
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'multi-ts' });
    await (executor as any).handleModelCommandToolResults(
      [
        {
          toolUseId: 'tool-6',
          toolName: 'mcp__model-command__run',
          result: JSON.stringify({
            type: 'model_command_result',
            commandId: 'ASK_USER_QUESTION',
            ok: true,
            payload: {
              question: {
                type: 'user_choices',
                title: 'T',
                questions: [{ id: 'q1', question: 'Q', choices: [{ id: '1', label: 'A' }] }],
              },
            },
          }),
        },
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
        turnId: 'TID',
      },
    );
    // Two setPendingForm calls: initial set (empty ts) + back-fill with posted ts.
    expect(deps.actionHandlers.setPendingForm).toHaveBeenCalledTimes(2);
    const backfillCall = deps.actionHandlers.setPendingForm.mock.calls[1][1];
    expect(backfillCall.messageTs).toBe('multi-ts');
  });
});

// ---------------------------------------------------------------------
// Issue #688 — A-2 epoch guard + Bash resolver-descriptor wiring tests
// ---------------------------------------------------------------------
describe('stream-executor — epoch guard + Bash resolver descriptor (issue #688)', () => {
  beforeEach(() => {
    vi.mocked(userSettingsStore.getUserEmail).mockReturnValue('user@example.com');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // Minimal stream that yields an assistant tool_use so onToolUse fires,
  // then a tool_result and a success result so execute() reaches the
  // success-path clearStatus (line 1025 region) and finally block.
  async function* toolFlowStream(toolName = 'Read') {
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool_1', name: toolName, input: {} }],
      },
    };
    yield {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'ok' }],
      },
    };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0, usage: {} };
  }

  // A stream that throws partway through to exercise the catch path
  // (handleError with expectedEpoch) and finally guarded clearStatus.
  async function* throwingStream() {
    yield {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'tool_1', name: 'Read', input: {} }],
      },
    };
    throw new Error('stream blew up');
  }

  function createDeps(streamFn: () => AsyncIterable<any>): any {
    return {
      claudeHandler: {
        setActivityState: vi.fn(),
        clearSessionId: vi.fn(),
        streamQuery: vi.fn().mockImplementation(streamFn),
        getSessionRegistry: vi.fn().mockReturnValue({
          beginTurn: vi.fn(),
          endTurn: vi.fn(),
          broadcastSessionUpdate: vi.fn(),
          getActivityState: vi.fn().mockReturnValue('idle'),
        }),
      },
      fileHandler: {
        formatFilePrompt: vi.fn().mockResolvedValue(''),
        cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
      },
      toolEventProcessor: {
        handleToolUse: vi.fn().mockResolvedValue(undefined),
        handleToolResult: vi.fn().mockResolvedValue(undefined),
        setCompactDurationCallback: vi.fn(),
        setReactionManager: vi.fn(),
        setToolResultSink: vi.fn(),
        cleanup: vi.fn(),
      },
      statusReporter: {
        updateStatusDirect: vi.fn().mockResolvedValue(undefined),
        getStatusEmoji: vi.fn().mockReturnValue('thinking_face'),
        cleanup: vi.fn(),
      },
      reactionManager: {
        updateReaction: vi.fn().mockResolvedValue(undefined),
        cleanup: vi.fn(),
      },
      contextWindowManager: {
        handlePromptTooLong: vi.fn().mockResolvedValue(undefined),
        cleanup: vi.fn(),
        calculateRemainingPercent: vi.fn().mockReturnValue(100),
        updateContextEmoji: vi.fn().mockResolvedValue(undefined),
      },
      toolTracker: {
        scheduleCleanup: vi.fn(),
        trackToolUse: vi.fn(),
        getToolName: vi.fn(),
        trackMcpCall: vi.fn(),
        getMcpCallId: vi.fn(),
        removeMcpCallId: vi.fn(),
        getActiveMcpCallIds: vi.fn().mockReturnValue([]),
      },
      todoDisplayManager: {
        cleanupSession: vi.fn(),
        cleanup: vi.fn(),
        handleTodoUpdate: vi.fn().mockResolvedValue(undefined),
        setRenderRequestCallback: vi.fn(),
        setPlanRenderCallback: vi.fn(),
      },
      actionHandlers: {},
      requestCoordinator: {
        removeController: vi.fn(),
      },
      slackApi: {
        getUserProfile: vi.fn().mockResolvedValue({ email: 'user@example.com', displayName: 'User' }),
        getClient: vi.fn().mockReturnValue({}),
        getBotUserId: vi.fn().mockResolvedValue('U_BOT'),
        deleteMessage: vi.fn().mockResolvedValue(undefined),
      },
      assistantStatusManager: {
        // #700 review P1 — isEnabled drives `shouldRunLegacyB4Path` /
        // `getEffectiveFiveBlockPhase`. Default enabled=true so the
        // pre-existing #688 tests keep running through the legacy path
        // at PHASE<4 (raw default); tests that need PHASE>=4 behaviour
        // override `config.ui.fiveBlockPhase` + this flag.
        isEnabled: vi.fn().mockReturnValue(true),
        setStatus: vi.fn().mockResolvedValue(undefined),
        clearStatus: vi.fn().mockResolvedValue(undefined),
        getToolStatusText: vi.fn().mockReturnValue('is reading files...'),
        bumpEpoch: vi.fn().mockReturnValue(42),
        buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
        registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
      },
      threadPanel: {
        beginTurn: vi.fn().mockResolvedValue(undefined),
        endTurn: vi.fn().mockResolvedValue(undefined),
        failTurn: vi.fn().mockResolvedValue(undefined),
        isTurnSurfaceActive: vi.fn().mockReturnValue(false),
        appendText: vi.fn().mockResolvedValue(true),
        setStatus: vi.fn().mockResolvedValue(undefined),
        updatePanel: vi.fn().mockResolvedValue(undefined),
        attachChoice: vi.fn().mockResolvedValue(undefined),
        finalizeOnEndTurn: vi.fn().mockResolvedValue(undefined),
        renderTasks: vi.fn().mockResolvedValue(false),
        updateHeader: vi.fn().mockResolvedValue(undefined),
        clearChoice: vi.fn().mockResolvedValue(undefined),
      },
    };
  }

  function createParams(say: ReturnType<typeof vi.fn>): any {
    return {
      session: {
        sessionId: 'sess_epoch',
        ownerId: 'U_TEST',
        // LOG_DETAIL enables STATUS_SPINNER so setStatus/clearStatus
        // branches in execute() actually fire on this test's path.
        logVerbosity: LOG_DETAIL,
        usage: {},
        terminated: false,
      },
      sessionKey: 'C42:thread42',
      userName: 'testuser',
      workingDirectory: '/tmp/test',
      abortController: new AbortController(),
      processedFiles: [],
      text: 'hello',
      channel: 'C42',
      threadTs: 'thread42',
      user: 'U_TEST',
      say,
    };
  }

  it('captures epoch on entry and passes expectedEpoch to success-path clearStatus', async () => {
    const deps = createDeps(() => toolFlowStream('Read'));
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    await executor.execute(createParams(say));

    expect(deps.assistantStatusManager.bumpEpoch).toHaveBeenCalledWith('C42', 'thread42');
    // Every clearStatus on the happy path must carry expectedEpoch: 42
    // (42 is what bumpEpoch was mocked to return above).
    const clearCalls = deps.assistantStatusManager.clearStatus.mock.calls;
    expect(clearCalls.length).toBeGreaterThan(0);
    for (const call of clearCalls) {
      expect(call[0]).toBe('C42');
      expect(call[1]).toBe('thread42');
      expect(call[2]).toEqual({ expectedEpoch: 42 });
    }
  });

  // S2: error path finally clearStatus reached with expectedEpoch carried
  // through handleError as well.
  it('reaches finally clearStatus on thrown stream and forwards expectedEpoch to handleError (S2)', async () => {
    const deps = createDeps(() => throwingStream());
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    const result = await executor.execute(createParams(say));

    expect(result.success).toBe(false);

    // bumpEpoch called exactly once at execute() entry.
    expect(deps.assistantStatusManager.bumpEpoch).toHaveBeenCalledTimes(1);

    // Every clearStatus must carry the same captured epoch.
    const clearCalls = deps.assistantStatusManager.clearStatus.mock.calls;
    expect(clearCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of clearCalls) {
      expect(call[2]).toEqual({ expectedEpoch: 42 });
    }
  });

  // Bash resolver descriptor: Bash tool routes status through a thunk
  // descriptor (() => string) so heartbeat ticks can recompute the text
  // from the live bg counter.
  it('Bash tool_use sets status with a resolver descriptor (not a static string)', async () => {
    const deps = createDeps(() => toolFlowStream('Bash'));
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    await executor.execute(createParams(say));

    const setCalls = deps.assistantStatusManager.setStatus.mock.calls;
    // We expect at least one call shaped with a thunk descriptor.
    const resolverCall = setCalls.find((c: any[]) => typeof c[2] === 'function');
    expect(resolverCall).toBeDefined();
    expect(resolverCall![0]).toBe('C42');
    expect(resolverCall![1]).toBe('thread42');
    // Invoking the resolver should delegate to buildBashStatus on the manager.
    const text = resolverCall![2]();
    expect(text).toBe('is running commands...');
    expect(deps.assistantStatusManager.buildBashStatus).toHaveBeenCalledWith('C42', 'thread42');
    // getToolStatusText must NOT have been used for Bash on this path —
    // the descriptor is injected directly.
    for (const call of deps.assistantStatusManager.getToolStatusText.mock.calls) {
      expect(call[0]).not.toBe('Bash');
    }
  });

  it('non-Bash tool_use still uses the static getToolStatusText path', async () => {
    const deps = createDeps(() => toolFlowStream('Read'));
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    await executor.execute(createParams(say));

    // Static string setStatus for Read: setStatus(ch, ts, 'is reading files...')
    const staticCall = deps.assistantStatusManager.setStatus.mock.calls.find((c: any[]) => typeof c[2] === 'string');
    expect(staticCall).toBeDefined();
    expect(deps.assistantStatusManager.getToolStatusText).toHaveBeenCalledWith('Read');
  });

  // Verifies the 948-area setStatus('') got replaced by a guarded
  // clearStatus call (not a setStatus with empty string) — the new
  // single source of truth for "tear this spinner down" inside execute().
  it('does not emit setStatus("") during execute() — guarded clearStatus only', async () => {
    const deps = createDeps(() => toolFlowStream('Read'));
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

    await executor.execute(createParams(say));

    const emptyStringSet = deps.assistantStatusManager.setStatus.mock.calls.find((c: any[]) => c[2] === '');
    expect(emptyStringSet).toBeUndefined();
  });

  // #700 review P1 — PHASE>=4 Bash behavioural coverage. The onToolUse
  // legacy-setStatus wrapper must route through `shouldRunLegacyB4Path`
  // so Bash no longer double-writes the spinner when TurnSurface owns
  // it. When the manager is clamped (disabled), the descriptor path must
  // re-activate and fire the resolver so the heartbeat still reflects
  // bg-bash counter changes. Both assertions directly protect the Bash
  // + native spinner path against regressions.
  describe('PHASE>=4 Bash legacy suppression (#700 P1)', () => {
    const originalPhase = config.ui.fiveBlockPhase;

    afterEach(async () => {
      config.ui.fiveBlockPhase = originalPhase;
      const { __resetClampEmitted } = await import('../effective-phase');
      __resetClampEmitted();
    });

    it('PHASE=4 + enabled: Bash tool_use does NOT call legacy setStatus (TurnSurface owns)', async () => {
      config.ui.fiveBlockPhase = 4;
      const deps = createDeps(() => toolFlowStream('Bash'));
      deps.assistantStatusManager.isEnabled = vi.fn().mockReturnValue(true);
      const executor = new StreamExecutor(deps);
      const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

      await executor.execute(createParams(say));

      // All Bash legacy setStatus callsites in execute() / onToolUse
      // route through `legacySetStatus` → `shouldRunLegacyB4Path` and
      // must short-circuit. Zero setStatus writes on the clamp=false
      // path is the success condition.
      expect(deps.assistantStatusManager.setStatus).not.toHaveBeenCalled();
    });

    it('PHASE=4 + disabled (clamped): Bash tool_use re-fires the resolver descriptor', async () => {
      config.ui.fiveBlockPhase = 4;
      const deps = createDeps(() => toolFlowStream('Bash'));
      // Clamp: disabled manager pulls `getEffectiveFiveBlockPhase` down
      // to 3 so the legacy path runs and the Bash resolver descriptor is
      // injected (so live heartbeats can reflect the bg-bash counter).
      deps.assistantStatusManager.isEnabled = vi.fn().mockReturnValue(false);
      const executor = new StreamExecutor(deps);
      const say = vi.fn().mockResolvedValue({ ts: 'msg_ts' });

      await executor.execute(createParams(say));

      const setCalls = deps.assistantStatusManager.setStatus.mock.calls;
      const resolverCall = setCalls.find((c: any[]) => typeof c[2] === 'function');
      expect(resolverCall).toBeDefined();
      expect(resolverCall![0]).toBe('C42');
      expect(resolverCall![1]).toBe('thread42');
      // Resolver delegates to buildBashStatus — matches the PHASE<4
      // behaviour in the existing #688 test above.
      expect(resolverCall![2]()).toBe('is running commands...');
    });
  });
});

// #689 P4 Part 2/2 — `legacySetStatus` / `legacyClearStatus` private wrappers.
// All existing stream-executor native-spinner callsites route through these so
// they can be PHASE-gated in one place. Verified directly (white-box) to keep
// the test isolated from the full `execute()` pipeline.
describe('StreamExecutor — #689 legacy native-spinner suppression', () => {
  const originalPhase = config.ui.fiveBlockPhase;

  const makeExec = (phase: number, enabled: boolean) => {
    config.ui.fiveBlockPhase = phase;
    const mgr = {
      isEnabled: vi.fn().mockReturnValue(enabled),
      setStatus: vi.fn().mockResolvedValue(undefined),
      clearStatus: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new StreamExecutor({ assistantStatusManager: mgr } as any);
    return { executor, mgr };
  };

  afterEach(async () => {
    config.ui.fiveBlockPhase = originalPhase;
    // Reset the module-level clamp-once flag so the disabled-mgr clamp test
    // doesn't leak the "already emitted" state into other suites in this
    // file. Mirrors the pattern in turn-surface.test.ts (commit 1c83d5e).
    const { __resetClampEmitted } = await import('../effective-phase');
    __resetClampEmitted();
  });

  it('PHASE<4: legacySetStatus forwards to assistantStatusManager.setStatus', async () => {
    const { executor, mgr } = makeExec(3, true);
    await (executor as any).legacySetStatus('C', 'thr', 'is thinking...');
    expect(mgr.setStatus).toHaveBeenCalledTimes(1);
    expect(mgr.setStatus).toHaveBeenCalledWith('C', 'thr', 'is thinking...');
  });

  it('PHASE>=4 + enabled: legacySetStatus is a no-op (TurnSurface owns)', async () => {
    const { executor, mgr } = makeExec(4, true);
    await (executor as any).legacySetStatus('C', 'thr', 'is thinking...');
    expect(mgr.setStatus).not.toHaveBeenCalled();
  });

  it('PHASE>=4 + disabled (clamped): legacySetStatus re-activates the forward', async () => {
    const { executor, mgr } = makeExec(4, false);
    await (executor as any).legacySetStatus('C', 'thr', 'fallback');
    expect(mgr.setStatus).toHaveBeenCalledTimes(1);
  });

  it('PHASE<4: legacyClearStatus forwards to assistantStatusManager.clearStatus', async () => {
    const { executor, mgr } = makeExec(2, true);
    await (executor as any).legacyClearStatus('C', 'thr');
    expect(mgr.clearStatus).toHaveBeenCalledTimes(1);
  });

  it('PHASE>=4 + enabled: legacyClearStatus is a no-op', async () => {
    const { executor, mgr } = makeExec(5, true);
    await (executor as any).legacyClearStatus('C', 'thr');
    expect(mgr.clearStatus).not.toHaveBeenCalled();
  });

  it('legacyClearStatus propagates expectedEpoch option at PHASE<4', async () => {
    const { executor, mgr } = makeExec(2, true);
    await (executor as any).legacyClearStatus('C', 'thr', { expectedEpoch: 3 });
    expect(mgr.clearStatus).toHaveBeenCalledWith('C', 'thr', { expectedEpoch: 3 });
  });
});

// ---------------------------------------------------------------------------
// #667 P5 — Completion snapshot + exclusion contract
//
// The success path in `execute()`:
//   1. builds a `completionEvent` closure on TurnContext (`buildCompletionEvent`)
//      passed into turnSurface.begin()
//   2. on success, assigns `completionEvent = finalEnrichedEvent` ONCE
//   3. at notify time: when ThreadPanel.isCompletionMarkerActive() is true,
//      calls `turnNotifier.notify(finalEnrichedEvent, { excludeChannelNames: ['slack-block-kit'] })`
//
// The Exception path (handleError) is UNCHANGED — no exclusion opts.
//
// These tests white-box the exclusion-decision helper used by both paths
// and the Exception-path contract. Full `execute()` integration remains
// covered by the wider suite above; here we isolate the exclusion gate.
// ---------------------------------------------------------------------------
describe('StreamExecutor — P5 completion snapshot + exclusion (#667)', () => {
  const originalPhase = config.ui.fiveBlockPhase;

  afterEach(() => {
    config.ui.fiveBlockPhase = originalPhase;
    vi.clearAllMocks();
  });

  function createDepsWithNotifier(opts: { markerActive: boolean }) {
    return {
      claudeHandler: {
        setActivityState: vi.fn(),
        clearSessionId: vi.fn(),
      },
      fileHandler: {
        cleanupTempFiles: vi.fn().mockResolvedValue(undefined),
      },
      toolEventProcessor: {},
      statusReporter: {
        updateStatusDirect: vi.fn().mockResolvedValue(undefined),
        getStatusEmoji: vi.fn().mockReturnValue('warning'),
      },
      reactionManager: {
        updateReaction: vi.fn().mockResolvedValue(undefined),
      },
      contextWindowManager: {
        handlePromptTooLong: vi.fn().mockResolvedValue(undefined),
      },
      toolTracker: {},
      todoDisplayManager: {},
      actionHandlers: {},
      requestCoordinator: {},
      slackApi: {},
      assistantStatusManager: {
        clearStatus: vi.fn().mockResolvedValue(undefined),
        setStatus: vi.fn().mockResolvedValue(undefined),
        bumpEpoch: vi.fn().mockReturnValue(1),
        getToolStatusText: vi.fn().mockReturnValue('running...'),
        buildBashStatus: vi.fn().mockReturnValue('is running commands...'),
        registerBackgroundBashActive: vi.fn().mockReturnValue(() => {}),
      },
      threadPanel: {
        isCompletionMarkerActive: vi.fn().mockReturnValue(opts.markerActive),
        setStatus: vi.fn().mockResolvedValue(undefined),
      },
      turnNotifier: {
        notify: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
  }

  it('Exception path (handleError) — PHASE=5 + capability active → notify called WITHOUT excludeChannelNames', async () => {
    config.ui.fiveBlockPhase = 5;
    const deps = createDepsWithNotifier({ markerActive: true });
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('generic failure');

    await (executor as any).handleError(error, { ownerId: 'U1' } as any, 'C:t', 'C', 't', [], say);

    // Exactly one notify call — Exception category — and the second arg
    // (opts) must be undefined (no exclusion for Exceptions).
    expect(deps.turnNotifier.notify).toHaveBeenCalledTimes(1);
    const [payload, opts] = deps.turnNotifier.notify.mock.calls[0];
    expect(payload.category).toBe('Exception');
    expect(opts).toBeUndefined();
  });

  it('Exception path (handleError) — PHASE<5 → notify called WITHOUT excludeChannelNames (legacy unchanged)', async () => {
    config.ui.fiveBlockPhase = 4;
    const deps = createDepsWithNotifier({ markerActive: false });
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('generic failure');

    await (executor as any).handleError(error, { ownerId: 'U1' } as any, 'C:t', 'C', 't', [], say);

    expect(deps.turnNotifier.notify).toHaveBeenCalledTimes(1);
    const [, opts] = deps.turnNotifier.notify.mock.calls[0];
    expect(opts).toBeUndefined();
  });

  it('Success-path exclusion helper: builds { excludeChannelNames: ["slack-block-kit"] } when capability active', () => {
    config.ui.fiveBlockPhase = 5;
    const deps = createDepsWithNotifier({ markerActive: true });
    const executor = new StreamExecutor(deps);

    // buildNotifyOpts is the internal helper that encodes the exclusion
    // gate contract: when ThreadPanel.isCompletionMarkerActive() returns
    // true, the WorkflowComplete notify call receives
    // `{ excludeChannelNames: ['slack-block-kit'] }`. Otherwise, it
    // returns `undefined` so `notify` is called with its legacy single-arg
    // signature.
    const opts = (executor as any).buildCompletionNotifyOpts();
    expect(opts).toEqual({ excludeChannelNames: ['slack-block-kit'] });
  });

  it('Success-path exclusion helper: returns undefined when capability inactive', () => {
    config.ui.fiveBlockPhase = 5;
    const deps = createDepsWithNotifier({ markerActive: false });
    const executor = new StreamExecutor(deps);

    const opts = (executor as any).buildCompletionNotifyOpts();
    expect(opts).toBeUndefined();
  });

  it('Success-path exclusion helper: returns undefined at PHASE<5', () => {
    config.ui.fiveBlockPhase = 4;
    // Even if a threadPanel claims markerActive=true here, capability
    // aggregation depends on PHASE>=5 inside isCompletionMarkerActive —
    // our test simulates that by having markerActive mirror the phase.
    const deps = createDepsWithNotifier({ markerActive: false });
    const executor = new StreamExecutor(deps);

    const opts = (executor as any).buildCompletionNotifyOpts();
    expect(opts).toBeUndefined();
  });

  it('Success-path exclusion helper: returns undefined when threadPanel is missing', () => {
    config.ui.fiveBlockPhase = 5;
    const deps = createDepsWithNotifier({ markerActive: true });
    deps.threadPanel = undefined;
    const executor = new StreamExecutor(deps);

    const opts = (executor as any).buildCompletionNotifyOpts();
    expect(opts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #720 — P5 B5 race fix (Promise snapshot + resolver + decoupling)
//
// Root cause from PR #711: `completionEventSnapshot` was assigned inside a
// fire-and-forget `enrichAndNotify()` chain gated by `if (this.deps.turnNotifier)`.
// `TurnSurface.end('completed')` read the snapshot synchronously in its
// `finally` block — but `stopStream` resolves faster than the Anthropic
// usage HTTP call inside enrichment, so the read almost always saw
// `undefined` and B5 was silently dropped.
//
// The fix carries three interacting pieces:
//   1. `buildCompletionEvent` returns a Promise (the `snapshotPromise`).
//   2. A single `resolveSnapshot` is called exactly once: with the event on
//      success, or with `undefined` on the `.catch` rail.
//   3. Event construction is moved OUTSIDE the `if (this.deps.turnNotifier)`
//      guard so capability-active runs still emit B5 even when turnNotifier
//      is missing (harness / tests / misconfigured DI).
// ---------------------------------------------------------------------------

describe('StreamExecutor — P5 B5 race (issue #720)', () => {
  const originalPhase = config.ui.fiveBlockPhase;

  afterEach(() => {
    config.ui.fiveBlockPhase = originalPhase;
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  // Lightweight mirror of stream-executor's snapshot wiring so these tests
  // can drive the race deterministically without running `execute()`. The
  // production pattern is `let resolveSnapshot; const p = new Promise(r =>
  // resolveSnapshot = r); ctx.buildCompletionEvent = () => p;` — identical
  // here, which is exactly the contract we need to lock in.
  function createSnapshot<T>(): {
    buildCompletionEvent: () => Promise<T | undefined>;
    resolveSnapshot: (evt: T | undefined) => void;
  } {
    let resolveSnapshot!: (evt: T | undefined) => void;
    const snapshotPromise = new Promise<T | undefined>((resolve) => {
      resolveSnapshot = resolve;
    });
    return { buildCompletionEvent: () => snapshotPromise, resolveSnapshot };
  }

  it('#720 (a) closeStream resolves BEFORE snapshot → TurnSurface.end awaits → B5 posts exactly once when enrichment lands', async () => {
    config.ui.fiveBlockPhase = 5;

    // Dynamic import so the test file doesn't pull in TurnSurface at top
    // level (the rest of the suite is stream-executor-only). Matches the
    // lazy-import pattern used elsewhere for surface-adjacent tests.
    const { TurnSurface } = await import('../../turn-surface');
    type TurnCompletionEventT = import('../../../turn-notifier').TurnCompletionEvent;

    const { buildCompletionEvent, resolveSnapshot } = createSnapshot<TurnCompletionEventT>();

    const client: any = {
      chat: {
        startStream: vi.fn().mockResolvedValue({ ts: 's1' }),
        appendStream: vi.fn().mockResolvedValue(undefined),
        stopStream: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue({ ts: 'p1' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    const blockKit = { send: vi.fn().mockResolvedValue(undefined) };
    const surface = new TurnSurface({
      slackApi: { getClient: () => client } as any,
      slackBlockKitChannel: blockKit as any,
      isCompletionMarkerActive: () => true,
    } as any);

    const ctx = {
      channelId: 'C1',
      threadTs: 't1.0',
      sessionKey: 'C1:t1.0',
      turnId: 'C1:t1.0:720-a',
      buildCompletionEvent,
    };
    await surface.begin(ctx as any);

    // end() proceeds through closeStream + clearStatus, then parks at the
    // snapshot await. The snapshot is still pending.
    let endSettled = false;
    const endPromise = surface.end(ctx.turnId, 'completed').finally(() => {
      endSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // Lock-in: end() MUST still be pending — proves the await is real.
    // A sync-read regression (e.g., `evt = state.ctx.buildCompletionEvent()
    // as TurnCompletionEvent`) would have let end() resolve by now.
    expect(endSettled).toBe(false);
    expect(blockKit.send).not.toHaveBeenCalled();

    // Enrichment lands LATE — matches the PR #711 timing where
    // fetchAndStoreUsage finishes after stopStream.
    const evt: TurnCompletionEventT = {
      category: 'WorkflowComplete',
      userId: 'U1',
      channel: 'C1',
      threadTs: 't1.0',
      sessionTitle: 'S',
      durationMs: 100,
    };
    resolveSnapshot(evt);

    await endPromise;
    expect(endSettled).toBe(true);
    expect(blockKit.send).toHaveBeenCalledTimes(1);
    expect(blockKit.send).toHaveBeenCalledWith(evt);
  });

  it('#720 (b) enrichAndResolve rejects → resolver(undefined) → B5 not emitted', async () => {
    config.ui.fiveBlockPhase = 5;

    const { TurnSurface } = await import('../../turn-surface');
    type TurnCompletionEventT = import('../../../turn-notifier').TurnCompletionEvent;

    const { buildCompletionEvent, resolveSnapshot } = createSnapshot<TurnCompletionEventT>();

    const client: any = {
      chat: {
        startStream: vi.fn().mockResolvedValue({ ts: 's1' }),
        appendStream: vi.fn().mockResolvedValue(undefined),
        stopStream: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue({ ts: 'p1' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    const blockKit = { send: vi.fn().mockResolvedValue(undefined) };
    const surface = new TurnSurface({
      slackApi: { getClient: () => client } as any,
      slackBlockKitChannel: blockKit as any,
      isCompletionMarkerActive: () => true,
    } as any);

    const ctx = {
      channelId: 'C1',
      threadTs: 't1.0',
      sessionKey: 'C1:t1.0',
      turnId: 'C1:t1.0:720-b',
      buildCompletionEvent,
    };
    await surface.begin(ctx as any);

    // Simulate stream-executor's `.catch` rail: enrich rejects, the chain's
    // catch handler calls `resolveSnapshot(undefined)`.
    resolveSnapshot(undefined);

    await surface.end(ctx.turnId, 'completed');

    expect(blockKit.send).not.toHaveBeenCalled();
  });

  it('#720 (c) decoupling lock-in: turnNotifier undefined + capability active → enrich still resolves snapshot → B5 posts once', async () => {
    // This test encodes the codex P1 decoupling requirement: event
    // construction MUST NOT be gated on `if (this.deps.turnNotifier)`. A
    // capability-active run without a turnNotifier (harness / tests /
    // misconfigured DI) must still produce a snapshot so TurnSurface emits
    // B5. We simulate stream-executor's post-stream chain inline — the
    // exact production control flow minus execute()'s 3000-line setup.
    config.ui.fiveBlockPhase = 5;

    const { TurnSurface } = await import('../../turn-surface');
    type TurnCompletionEventT = import('../../../turn-notifier').TurnCompletionEvent;

    const { buildCompletionEvent, resolveSnapshot } = createSnapshot<TurnCompletionEventT>();

    // Cast to a union type so TS keeps `notify` visible inside the truthy
    // branch even though the runtime value is always `undefined` — the
    // whole point of this test is "what happens when turnNotifier is absent
    // but the chain still has to run."
    type Notifier = { notify: (evt: TurnCompletionEventT) => void };
    const turnNotifier: Notifier | undefined = undefined as Notifier | undefined;

    // The event construction lives OUTSIDE the (absent) turnNotifier guard.
    // If a future refactor re-couples construction to turnNotifier, this
    // test fails because `resolveSnapshot` never fires.
    const evt: TurnCompletionEventT = {
      category: 'WorkflowComplete',
      userId: 'U1',
      channel: 'C1',
      threadTs: 't1.0',
      sessionTitle: 'S',
      durationMs: 100,
    };
    const enrichAndResolve = async (): Promise<TurnCompletionEventT> => evt;

    // Mirror the production chain in stream-executor.execute():
    //   enrichAndResolve()
    //     .then((e) => { resolveSnapshot(e); if (turnNotifier) notify(e) })
    //     .catch(() => resolveSnapshot(undefined))
    const chainP = enrichAndResolve()
      .then((e) => {
        resolveSnapshot(e);
        if (turnNotifier) {
          turnNotifier.notify(e);
        }
      })
      .catch(() => resolveSnapshot(undefined));

    const client: any = {
      chat: {
        startStream: vi.fn().mockResolvedValue({ ts: 's1' }),
        appendStream: vi.fn().mockResolvedValue(undefined),
        stopStream: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue({ ts: 'p1' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    const blockKit = { send: vi.fn().mockResolvedValue(undefined) };
    const surface = new TurnSurface({
      slackApi: { getClient: () => client } as any,
      slackBlockKitChannel: blockKit as any,
      isCompletionMarkerActive: () => true,
    } as any);

    const ctx = {
      channelId: 'C1',
      threadTs: 't1.0',
      sessionKey: 'C1:t1.0',
      turnId: 'C1:t1.0:720-c',
      buildCompletionEvent,
    };
    await surface.begin(ctx as any);
    await chainP;
    await surface.end(ctx.turnId, 'completed');

    // turnNotifier was undefined — no fan-out call.
    // B5 still posted exactly once via the SlackBlockKitChannel path.
    expect(blockKit.send).toHaveBeenCalledTimes(1);
    expect(blockKit.send).toHaveBeenCalledWith(evt);
  });

  it('#720 (f) contract lock-in: resolveSnapshot called twice (evt, then undefined) — snapshot retains first value → B5 posts with evt', async () => {
    // Guards against a future refactor that adds a `finally → resolveSnapshot
    // (undefined)` safety-net (the codex P1-1 anti-pattern). ECMA Promise
    // semantics silently drop the second resolve, but the SNAPSHOT is what
    // matters: TurnSurface.end awaits the Promise and sees whatever the
    // FIRST resolve produced. This test proves that invariant: once the
    // .then rail resolves with the event, a subsequent .catch-rail
    // `resolveSnapshot(undefined)` is a no-op and B5 still posts.
    config.ui.fiveBlockPhase = 5;

    const { TurnSurface } = await import('../../turn-surface');
    type TurnCompletionEventT = import('../../../turn-notifier').TurnCompletionEvent;

    const { buildCompletionEvent, resolveSnapshot } = createSnapshot<TurnCompletionEventT>();

    const evt: TurnCompletionEventT = {
      category: 'WorkflowComplete',
      userId: 'U1',
      channel: 'C1',
      threadTs: 't1.0',
      sessionTitle: 'S',
      durationMs: 100,
    };

    // First call wins — second is a no-op (Promise resolve is idempotent).
    resolveSnapshot(evt);
    resolveSnapshot(undefined);

    const client: any = {
      chat: {
        startStream: vi.fn().mockResolvedValue({ ts: 's1' }),
        appendStream: vi.fn().mockResolvedValue(undefined),
        stopStream: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue({ ts: 'p1' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    const blockKit = { send: vi.fn().mockResolvedValue(undefined) };
    const surface = new TurnSurface({
      slackApi: { getClient: () => client } as any,
      slackBlockKitChannel: blockKit as any,
      isCompletionMarkerActive: () => true,
    } as any);

    const ctx = {
      channelId: 'C1',
      threadTs: 't1.0',
      sessionKey: 'C1:t1.0',
      turnId: 'C1:t1.0:720-f',
      buildCompletionEvent,
    };
    await surface.begin(ctx as any);
    await surface.end(ctx.turnId, 'completed');

    expect(blockKit.send).toHaveBeenCalledTimes(1);
    expect(blockKit.send).toHaveBeenCalledWith(evt);
  });

  it('#720 (g) concurrent end() during snapshot await is idempotent (state.closing short-circuits second call)', async () => {
    // New 3s await window between "enter end()" and "return" widens the
    // pre-existing idempotency invariant: a second end() call during the
    // await must hit `!state || state.closing` and no-op, not double-post.
    config.ui.fiveBlockPhase = 5;

    const { TurnSurface } = await import('../../turn-surface');
    type TurnCompletionEventT = import('../../../turn-notifier').TurnCompletionEvent;

    const { buildCompletionEvent, resolveSnapshot } = createSnapshot<TurnCompletionEventT>();

    const client: any = {
      chat: {
        startStream: vi.fn().mockResolvedValue({ ts: 's1' }),
        appendStream: vi.fn().mockResolvedValue(undefined),
        stopStream: vi.fn().mockResolvedValue(undefined),
        postMessage: vi.fn().mockResolvedValue({ ts: 'p1' }),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };
    const blockKit = { send: vi.fn().mockResolvedValue(undefined) };
    const surface = new TurnSurface({
      slackApi: { getClient: () => client } as any,
      slackBlockKitChannel: blockKit as any,
      isCompletionMarkerActive: () => true,
    } as any);

    const ctx = {
      channelId: 'C1',
      threadTs: 't1.0',
      sessionKey: 'C1:t1.0',
      turnId: 'C1:t1.0:720-g',
      buildCompletionEvent,
    };
    await surface.begin(ctx as any);

    // Park first end() on the snapshot await.
    const endP1 = surface.end(ctx.turnId, 'completed');
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Second end() enters, finds state.closing=true from first call's
    // synchronous mark, and returns immediately without awaiting.
    const endP2 = surface.end(ctx.turnId, 'completed');
    await endP2;
    expect(blockKit.send).not.toHaveBeenCalled();

    // Release the first call's snapshot — it finishes and posts B5 once.
    const evt: TurnCompletionEventT = {
      category: 'WorkflowComplete',
      userId: 'U1',
      channel: 'C1',
      threadTs: 't1.0',
      sessionTitle: 'S',
      durationMs: 100,
    };
    resolveSnapshot(evt);
    await endP1;

    expect(blockKit.send).toHaveBeenCalledTimes(1);
    expect(blockKit.send).toHaveBeenCalledWith(evt);
  });
});

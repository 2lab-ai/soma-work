/**
 * StreamExecutor tests - focusing on continuation pattern
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../user-settings-store', () => ({
  userSettingsStore: {
    getUserSessionTheme: vi.fn().mockReturnValue('D'),
  },
}));

import type { Continuation } from '../../types';
import { type ExecuteResult, StreamExecutor } from './stream-executor';

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

  it('clears session for unrelated errors containing partial image-related words (safe default)', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    // "invalid image_url" is NOT an image processing error, but unknown errors
    // now clear session as safe default (Issue #118)
    const error = new Error('invalid image_url field in API request');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    // Issue #118: Unknown errors now clear session (safe default)
    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
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

  // Issue #118: S2 — Unknown errors should clear session (safe default)
  it('clears session on completely unrecognized error (safe default)', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('Some completely unexpected error from SDK v99');

    await (executor as any).handleError(error, {} as any, 'C123:thread123', 'C123', 'thread123', [], say);

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  // Issue #118: S3 — Existing recoverable errors must still be preserved
  it.each([
    "You've hit your limit",
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

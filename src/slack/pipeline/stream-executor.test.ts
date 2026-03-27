/**
 * StreamExecutor tests - focusing on continuation pattern
 */

import { describe, it, expect, vi } from 'vitest';
import { Continuation } from '../../types';
import { ExecuteResult } from './stream-executor';
import { StreamExecutor } from './stream-executor';

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
    const saveContent = saveResult.files.map((file) => {
      return `--- ${file.name} ---\n${file.content}`;
    }).join('\n\n');

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

    expect(slackApi.updateMessage).toHaveBeenCalledWith(
      'C123',
      '111.222',
      'tool update'
    );
  });

  it('swallows helper failures after debug logging', async () => {
    const slackApi = {
      updateMessage: vi.fn().mockRejectedValue(new Error('ratelimited')),
    };
    const executor = new StreamExecutor({ slackApi } as any);
    const debugSpy = vi.spyOn((executor as any).logger, 'debug');

    await expect(
      (executor as any).updateToolCallMessage('C123', '111.222', 'tool update')
    ).resolves.toBeUndefined();

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
  });

  it('preserves session for Claude SDK rate-limit/process-exit errors', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error("You've hit your limit · resets 8pm (Asia/Seoul). Claude Code process exited with code 1");

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  it('clears session for "Could not process image" API 400 errors', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"}}');

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
  });

  // Issue #118: S1 — "No conversation found" SDK error must be detected
  it('clears session for "No conversation found with session ID" SDK error', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const say = vi.fn().mockResolvedValue(undefined);
    const error = new Error('No conversation found with session ID: 5f232806-df17-47a3-9eb0-8bc76a2bac99');

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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

    await (executor as any).handleError(
      error,
      {} as any,
      'C123:thread123',
      'C123',
      'thread123',
      [],
      say
    );

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
          snapshot: { issues: [], prs: [], docs: [], active: {}, sequence: 1 },
        }),
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
              session: { issues: [], prs: [], docs: [], active: {}, sequence: 2 },
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
      }
    );

    expect(commandResult).toMatchObject({ hasPendingChoice: false, continuation: undefined });
    expect(deps.claudeHandler.updateSessionResources).toHaveBeenCalledWith(
      'C1',
      '171.100',
      expect.objectContaining({
        operations: expect.any(Array),
      })
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
      }
    );

    expect(commandResult.hasPendingChoice).toBe(true);
    expect(commandResult.continuation).toBeUndefined();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: '진행할 방법을 선택해주세요',
      thread_ts: '171.100',
    }));
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
      [
        makeAskResult('tool_q1', '첫 번째 질문'),
        makeAskResult('tool_q2', '두 번째 질문'),
      ],
      session,
      {
        channel: 'C1',
        threadTs: '171.100',
        sessionKey: 'C1-171.100',
        say,
      }
    );

    expect(commandResult.hasPendingChoice).toBe(true);
    // Only the LAST question should be rendered (say called once)
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: '두 번째 질문',
      thread_ts: '171.100',
    }));
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
                choices: [
                  { id: '1', label: 'A' },
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
      }
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

    const continuation = await (executor as any).buildRenewContinuation(
      session,
      '',
      '171.100',
      say
    );

    expect(continuation).toBeDefined();
    expect(continuation?.resetSession).toBe(true);
    expect(continuation?.prompt).toContain('local:load');
    expect(session.renewState).toBeNull();
    expect(session.renewUserMessage).toBeUndefined();
  });

  it('surfaces warning when UPDATE_SESSION host apply fails', async () => {
    const deps = createExecutorDeps();
    deps.claudeHandler.updateSessionResources = vi.fn().mockReturnValue({
      ok: false,
      reason: 'INVALID_OPERATION',
      error: 'invalid request',
      snapshot: { issues: [], prs: [], docs: [], active: {}, sequence: 0 },
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
              session: { issues: [], prs: [], docs: [], active: {}, sequence: 0 },
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
      }
    );

    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Session update could not be applied'),
    }));
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
      }
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
      }
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
    const say = vi.fn()
      .mockRejectedValueOnce(new Error('invalid_blocks'))
      .mockResolvedValue({ ts: 'fallback_ts' });

    await expect((executor as any).handleModelCommandToolResults(
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
      }
    )).resolves.toMatchObject({ hasPendingChoice: true, continuation: undefined });

    expect(say).toHaveBeenCalledTimes(2);
    expect(say.mock.calls[1]?.[0]?.text).toContain('버튼 UI 생성에 실패');
  });

  it('falls back to plain text when command-driven multi choice blocks fail', async () => {
    const deps = createExecutorDeps();
    const executor = new StreamExecutor(deps);
    const session = createSession();
    const say = vi.fn()
      .mockRejectedValueOnce(new Error('invalid_blocks'))
      .mockResolvedValue({ ts: 'fallback_multi_ts' });

    await expect((executor as any).handleModelCommandToolResults(
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
      }
    )).resolves.toMatchObject({ hasPendingChoice: true, continuation: undefined });

    expect(say).toHaveBeenCalledTimes(2);
    expect(say.mock.calls[1]?.[0]?.text).toContain('버튼 UI 생성에 실패');
  });
});

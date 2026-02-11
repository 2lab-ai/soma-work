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
      actionPanelManager: undefined,
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
      'status123',
      [],
      say
    );

    expect(deps.claudeHandler.clearSessionId).not.toHaveBeenCalled();
    expect(say).not.toHaveBeenCalled();
    expect(deps.statusReporter.updateStatusDirect).toHaveBeenCalledWith(
      'C123',
      'status123',
      'cancelled'
    );
    expect(deps.statusReporter.getStatusEmoji).toHaveBeenCalledWith('cancelled');
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
      'status123',
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
      'status123',
      [],
      say
    );

    expect(deps.claudeHandler.clearSessionId).toHaveBeenCalledWith('C123', 'thread123');
    expect(say).toHaveBeenCalledTimes(1);
    const payload = say.mock.calls[0][0];
    expect(payload.text).toContain('Session:* 🔄 초기화됨');
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
      'status123',
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
      actionPanelManager: {
        attachChoice: vi.fn().mockResolvedValue(undefined),
        updatePanel: vi.fn().mockResolvedValue(undefined),
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

    const hasChoice = await (executor as any).handleModelCommandToolResults(
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

    expect(hasChoice).toBe(false);
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

    const hasChoice = await (executor as any).handleModelCommandToolResults(
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

    expect(hasChoice).toBe(true);
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: '진행할 방법을 선택해주세요',
      thread_ts: '171.100',
    }));
    expect(deps.actionPanelManager.attachChoice).toHaveBeenCalled();
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
    )).resolves.toBe(true);

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
    )).resolves.toBe(true);

    expect(say).toHaveBeenCalledTimes(2);
    expect(say.mock.calls[1]?.[0]?.text).toContain('버튼 UI 생성에 실패');
  });
});

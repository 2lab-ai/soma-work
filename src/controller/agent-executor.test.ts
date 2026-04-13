/**
 * AgentExecutor tests (Issue #411)
 */

import { describe, expect, it, vi } from 'vitest';
import type { ResponseSession } from '../view/response-session.js';
import type { MessageHandle } from '../view/types.js';
import { AgentExecutor } from './agent-executor.js';
import type { AgentEvent, AgentProvider } from './agent-provider.js';

// ─── Helpers ────────────────────────────────────────────────────

function createMockResponseSession(): ResponseSession {
  return {
    appendText: vi.fn(),
    setStatus: vi.fn(),
    replacePart: vi.fn(),
    attachFile: vi.fn(),
    complete: vi.fn().mockResolvedValue({
      platform: 'slack',
      ref: { channel: 'C123', ts: '1700000000.000000' },
    } as MessageHandle),
    abort: vi.fn(),
  };
}

/** Create a mock async generator that yields AgentEvents. */
async function* mockEventStream(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) {
    yield event;
  }
}

function createMockProvider(events: AgentEvent[]): AgentProvider {
  return {
    name: 'test',
    query: vi.fn().mockReturnValue(mockEventStream(events)),
    queryOneShot: vi.fn().mockResolvedValue(''),
    validateCredentials: vi.fn().mockResolvedValue(true),
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('AgentExecutor', () => {
  it('routes text events to appendText', async () => {
    const provider = createMockProvider([
      { type: 'text', text: 'Hello ' },
      { type: 'text', text: 'world!' },
      { type: 'turn_complete', stopReason: 'end_turn' },
    ]);
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);

    const result = await executor.execute({ prompt: 'Hi' }, session);

    expect(session.appendText).toHaveBeenCalledTimes(2);
    expect(session.appendText).toHaveBeenCalledWith('Hello ');
    expect(session.appendText).toHaveBeenCalledWith('world!');
    expect(result.textLength).toBe(12);
    expect(result.success).toBe(true);
    expect(session.complete).toHaveBeenCalled();
  });

  it('routes thinking events to setStatus', async () => {
    const provider = createMockProvider([
      { type: 'thinking', text: 'Let me analyze this problem...' },
      { type: 'text', text: 'Answer' },
      { type: 'turn_complete', stopReason: 'end_turn' },
    ]);
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);

    await executor.execute({ prompt: 'Think' }, session);

    expect(session.setStatus).toHaveBeenCalledWith('thinking', {
      context: 'Let me analyze this problem...',
    });
  });

  it('routes tool_use events to setStatus with tool name', async () => {
    const provider = createMockProvider([
      { type: 'tool_use', toolName: 'Bash', toolInput: { command: 'ls' }, toolCallId: 'tc-1' },
      {
        type: 'tool_result',
        toolCallId: 'tc-1',
        toolName: 'Bash',
        result: 'file1.ts\nfile2.ts',
        isError: false,
        durationMs: 150,
      },
      { type: 'turn_complete', stopReason: 'end_turn' },
    ]);
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);

    const result = await executor.execute({ prompt: 'List files' }, session);

    expect(session.setStatus).toHaveBeenCalledWith('tool', { tool: 'Bash' });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toEqual({
      toolName: 'Bash',
      toolCallId: 'tc-1',
      durationMs: 150,
      isError: false,
    });
  });

  it('handles tool errors with replacePart', async () => {
    const provider = createMockProvider([
      { type: 'tool_use', toolName: 'Read', toolInput: {}, toolCallId: 'tc-2' },
      {
        type: 'tool_result',
        toolCallId: 'tc-2',
        toolName: 'Read',
        result: 'File not found',
        isError: true,
        durationMs: 50,
      },
      { type: 'turn_complete', stopReason: 'end_turn' },
    ]);
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);

    const result = await executor.execute({ prompt: 'Read file' }, session);

    expect(session.replacePart).toHaveBeenCalledWith('tool-error-tc-2', {
      type: 'status',
      phase: 'error',
      tool: 'Read',
    });
    expect(result.toolCalls[0].isError).toBe(true);
  });

  it('captures usage from turn_complete', async () => {
    const provider = createMockProvider([
      { type: 'text', text: 'Done' },
      {
        type: 'turn_complete',
        stopReason: 'end_turn',
        usage: {
          inputTokens: 500,
          outputTokens: 200,
          cacheReadTokens: 100,
        },
        sessionId: 'sess-abc',
      },
    ]);
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);

    const result = await executor.execute({ prompt: 'Go' }, session);

    expect(result.success).toBe(true);
    expect(result.usage).toEqual({
      inputTokens: 500,
      outputTokens: 200,
      cacheReadTokens: 100,
    });
    expect(result.sessionId).toBe('sess-abc');
    expect(result.stopReason).toBe('end_turn');
  });

  it('handles init event and records sessionId', async () => {
    const provider = createMockProvider([
      { type: 'init', model: 'claude-opus-4-6', sessionId: 'sess-init' },
      { type: 'text', text: 'Hi' },
      { type: 'turn_complete', stopReason: 'end_turn' },
    ]);
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);

    const result = await executor.execute({ prompt: 'Hello' }, session);

    expect(result.sessionId).toBe('sess-init');
  });

  it('handles recoverable errors with retryAfterMs', async () => {
    const provider = createMockProvider([
      {
        type: 'error',
        error: new Error('overloaded'),
        isRecoverable: true,
        retryAfterMs: 5000,
      },
    ]);
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);

    const result = await executor.execute({ prompt: 'Fail' }, session);

    expect(result.success).toBe(false);
    expect(result.retryAfterMs).toBe(5000);
    expect(result.stopReason).toBe('recoverable_error');
    expect(session.setStatus).toHaveBeenCalledWith('error', {
      context: 'Recoverable error: overloaded',
    });
    // Should NOT call abort or complete — caller decides retry
  });

  it('handles fatal errors by aborting', async () => {
    const provider = createMockProvider([
      {
        type: 'error',
        error: new Error('invalid_api_key'),
        isRecoverable: false,
      },
    ]);
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);

    const result = await executor.execute({ prompt: 'Fail hard' }, session);

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('error');
    expect(session.abort).toHaveBeenCalledWith('invalid_api_key');
  });

  it('handles stream exceptions', async () => {
    const provider: AgentProvider = {
      name: 'test',
      query: vi.fn().mockImplementation(async function* () {
        throw new Error('network_timeout');
      }),
      queryOneShot: vi.fn().mockResolvedValue(''),
      validateCredentials: vi.fn().mockResolvedValue(true),
    };
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);

    const result = await executor.execute({ prompt: 'Timeout' }, session);

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe('exception');
    expect(session.abort).toHaveBeenCalledWith('network_timeout');
  });

  it('respects abort controller', async () => {
    const ac = new AbortController();
    ac.abort(); // Pre-abort

    const provider = createMockProvider([
      { type: 'text', text: 'Should not process' },
      { type: 'turn_complete', stopReason: 'end_turn' },
    ]);
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);

    const result = await executor.execute({ prompt: 'Cancel', abortController: ac }, session);

    expect(result.stopReason).toBe('cancelled');
    expect(session.abort).toHaveBeenCalledWith('Cancelled by user');
  });

  it('invokes onEvent callback for each event', async () => {
    const provider = createMockProvider([
      { type: 'text', text: 'Hi' },
      { type: 'turn_complete', stopReason: 'end_turn' },
    ]);
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);
    const events: AgentEvent[] = [];

    await executor.execute({ prompt: 'Track' }, session, {
      onEvent: (e) => events.push(e),
    });

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('text');
    expect(events[1].type).toBe('turn_complete');
  });

  it('handles a full realistic turn with multiple event types', async () => {
    const provider = createMockProvider([
      { type: 'init', model: 'claude-opus-4-6', sessionId: 'sess-full' },
      { type: 'thinking', text: 'Analyzing the request...' },
      { type: 'tool_use', toolName: 'Bash', toolInput: { command: 'git status' }, toolCallId: 'tc-a' },
      {
        type: 'tool_result',
        toolCallId: 'tc-a',
        toolName: 'Bash',
        result: 'On branch main',
        isError: false,
        durationMs: 200,
      },
      { type: 'text', text: 'The branch is on main. ' },
      { type: 'tool_use', toolName: 'Read', toolInput: { file: 'README.md' }, toolCallId: 'tc-b' },
      {
        type: 'tool_result',
        toolCallId: 'tc-b',
        toolName: 'Read',
        result: '# My Project',
        isError: false,
        durationMs: 50,
      },
      { type: 'text', text: 'The README says "My Project".' },
      {
        type: 'turn_complete',
        stopReason: 'end_turn',
        sessionId: 'sess-full',
        usage: { inputTokens: 1000, outputTokens: 300, cacheReadTokens: 200 },
      },
    ]);
    const session = createMockResponseSession();
    const executor = new AgentExecutor(provider);

    const result = await executor.execute({ prompt: 'Status and readme' }, session);

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe('sess-full');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.textLength).toBe(52);
    expect(result.usage?.inputTokens).toBe(1000);
    expect(session.appendText).toHaveBeenCalledTimes(2);
    expect(session.setStatus).toHaveBeenCalledWith('thinking', expect.any(Object));
    expect(session.setStatus).toHaveBeenCalledWith('tool', { tool: 'Bash' });
    expect(session.setStatus).toHaveBeenCalledWith('tool', { tool: 'Read' });
    expect(session.complete).toHaveBeenCalled();
  });
});

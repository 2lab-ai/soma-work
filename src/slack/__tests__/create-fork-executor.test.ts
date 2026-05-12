import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createForkExecutor } from '../create-fork-executor.js';

// Minimal mock of ClaudeHandler with dispatchOneShot
function makeMockClaudeHandler() {
  return {
    dispatchOneShot: vi.fn().mockResolvedValue('') as ReturnType<typeof vi.fn>,
  };
}

describe('createForkExecutor', () => {
  let mockHandler: ReturnType<typeof makeMockClaudeHandler>;

  beforeEach(() => {
    mockHandler = makeMockClaudeHandler();
  });

  it('returns trimmed response from dispatchOneShot', async () => {
    mockHandler.dispatchOneShot.mockResolvedValue('  Summary text here  ');
    const executor = createForkExecutor(mockHandler as any);

    const result = await executor('Generate a summary', 'claude-sonnet-4-20250514');

    expect(result).toBe('Summary text here');
    expect(mockHandler.dispatchOneShot).toHaveBeenCalledOnce();
    expect(mockHandler.dispatchOneShot).toHaveBeenCalledWith(
      'Generate a summary',
      expect.stringContaining('executive summaries'),
      'claude-sonnet-4-20250514',
      undefined, // abortController
      undefined, // sessionId
      undefined, // cwd
    );
  });

  it('passes model as undefined when not provided', async () => {
    mockHandler.dispatchOneShot.mockResolvedValue('Summary');
    const executor = createForkExecutor(mockHandler as any);

    await executor('prompt text');

    expect(mockHandler.dispatchOneShot).toHaveBeenCalledWith(
      'prompt text',
      expect.any(String),
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it('passes sessionId and cwd for context-aware fork', async () => {
    mockHandler.dispatchOneShot.mockResolvedValue('Context-aware summary');
    const executor = createForkExecutor(mockHandler as any);

    const result = await executor('prompt', 'claude-opus-4-6', 'session-abc', '/tmp/work');

    expect(result).toBe('Context-aware summary');
    expect(mockHandler.dispatchOneShot).toHaveBeenCalledWith(
      'prompt',
      expect.stringContaining('executive summaries'),
      'claude-opus-4-6',
      undefined, // abortController
      'session-abc', // sessionId for fork
      '/tmp/work', // cwd
    );
  });

  it('returns null when dispatchOneShot returns empty string', async () => {
    mockHandler.dispatchOneShot.mockResolvedValue('   ');
    const executor = createForkExecutor(mockHandler as any);

    const result = await executor('prompt');

    expect(result).toBeNull();
  });

  it('returns null when dispatchOneShot throws', async () => {
    mockHandler.dispatchOneShot.mockRejectedValue(new Error('API rate limit'));
    const executor = createForkExecutor(mockHandler as any);

    const result = await executor('prompt');

    expect(result).toBeNull();
  });

  it('returns null when dispatchOneShot throws a non-Error', async () => {
    mockHandler.dispatchOneShot.mockRejectedValue('network failure');
    const executor = createForkExecutor(mockHandler as any);

    const result = await executor('prompt');

    expect(result).toBeNull();
  });

  it('threads AbortSignal to dispatchOneShot as AbortController', async () => {
    mockHandler.dispatchOneShot.mockResolvedValue('Summary');
    const executor = createForkExecutor(mockHandler as any);
    const ac = new AbortController();

    await executor('prompt', 'claude-opus-4-6', undefined, undefined, ac.signal);

    // 4th arg should be an AbortController (not undefined)
    const calledAbortController = mockHandler.dispatchOneShot.mock.calls[0][3];
    expect(calledAbortController).toBeDefined();
    expect(calledAbortController).toBeInstanceOf(AbortController);
  });

  it('forwards abort from external signal to internal AbortController', async () => {
    let capturedController: AbortController | undefined;
    mockHandler.dispatchOneShot.mockImplementation(
      async (_msg: string, _sys: string, _model: string, abortCtrl: AbortController) => {
        capturedController = abortCtrl;
        return 'Summary';
      },
    );
    const executor = createForkExecutor(mockHandler as any);
    const ac = new AbortController();

    await executor('prompt', 'claude-opus-4-6', undefined, undefined, ac.signal);

    expect(capturedController).toBeDefined();
    expect(capturedController!.signal.aborted).toBe(false);

    // Abort externally
    ac.abort();
    expect(capturedController!.signal.aborted).toBe(true);
  });

  it('passes undefined AbortController when no signal provided', async () => {
    mockHandler.dispatchOneShot.mockResolvedValue('Summary');
    const executor = createForkExecutor(mockHandler as any);

    await executor('prompt');

    const calledAbortController = mockHandler.dispatchOneShot.mock.calls[0][3];
    expect(calledAbortController).toBeUndefined();
  });

  it('pre-aborted signal creates already-aborted AbortController', async () => {
    let capturedController: AbortController | undefined;
    mockHandler.dispatchOneShot.mockImplementation(
      async (_msg: string, _sys: string, _model: string, abortCtrl: AbortController) => {
        capturedController = abortCtrl;
        return 'Summary';
      },
    );
    const executor = createForkExecutor(mockHandler as any);
    const ac = new AbortController();
    ac.abort(); // pre-abort

    await executor('prompt', undefined, undefined, undefined, ac.signal);

    expect(capturedController).toBeDefined();
    expect(capturedController!.signal.aborted).toBe(true);
  });

  // Issue #231 originally exposed that a context-less summary fork produces
  // garbage output (the LLM has no idea what happened in the session). The
  // previous fallback retried *without* `sessionId` on a stale-session error,
  // which silently re-introduced the same garbage. We now treat "No conversation
  // found" as a hard failure: return null, log loudly, and let the caller skip
  // displaying a misleading summary. Callers MUST fix the underlying cwd /
  // sessionId mismatch instead of masking it.
  describe('stale session — no silent fallback', () => {
    it('returns null when fork fails with "No conversation found"', async () => {
      mockHandler.dispatchOneShot.mockRejectedValue(
        new Error('Claude Code returned an error result: No conversation found with session ID: abc-123'),
      );

      const executor = createForkExecutor(mockHandler as any);
      const result = await executor('prompt', 'claude-sonnet-4-20250514', 'abc-123', '/tmp/work');

      // No misleading context-less summary — caller will see null and skip display.
      expect(result).toBeNull();
      // Exactly one attempt — no silent retry without sessionId.
      expect(mockHandler.dispatchOneShot).toHaveBeenCalledTimes(1);
      expect(mockHandler.dispatchOneShot.mock.calls[0][4]).toBe('abc-123');
    });

    it('returns null on unrelated errors too (existing behavior)', async () => {
      mockHandler.dispatchOneShot.mockRejectedValue(new Error('API rate limit'));

      const executor = createForkExecutor(mockHandler as any);
      const result = await executor('prompt', undefined, 'session-xyz');

      expect(result).toBeNull();
      expect(mockHandler.dispatchOneShot).toHaveBeenCalledTimes(1);
    });

    it('returns null with no retry when no sessionId was provided', async () => {
      mockHandler.dispatchOneShot.mockRejectedValue(new Error('No conversation found with session ID: phantom'));

      const executor = createForkExecutor(mockHandler as any);
      const result = await executor('prompt');

      expect(result).toBeNull();
      expect(mockHandler.dispatchOneShot).toHaveBeenCalledTimes(1);
    });

    it('detects "No conversation found" case-insensitively and still returns null', async () => {
      mockHandler.dispatchOneShot.mockRejectedValue(new Error('no conversation found with session ID: abc'));

      const executor = createForkExecutor(mockHandler as any);
      const result = await executor('prompt', undefined, 'abc');

      expect(result).toBeNull();
      expect(mockHandler.dispatchOneShot).toHaveBeenCalledTimes(1);
    });
  });
});

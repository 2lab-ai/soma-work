import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createForkExecutor } from './create-fork-executor.js';

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
});

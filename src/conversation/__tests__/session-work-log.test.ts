/**
 * #598 ④b1 — the work-log pipeline a turn's entry goes through (design 598b
 * v5 §4.1), as one function that returns the store's promise. The Slack
 * provider keeps swallowing it; a Slack-less task's writer keeps it as a
 * receipt. Everything the pipeline does besides appending stays the same for
 * both: agent stamp, card push on a tool entry, artifact capture.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { appendWorkLog, captureArtifactFromWorkLog } = vi.hoisted(() => ({
  appendWorkLog: vi.fn(),
  captureArtifactFromWorkLog: vi.fn(async () => {}),
}));
vi.mock('../work-log', () => ({ appendWorkLog }));
vi.mock('../artifact-capture', () => ({ captureArtifactFromWorkLog }));

import { createSessionWorkLogAppender } from '../session-work-log';

function setup() {
  const session = { conversationId: 'conv-1', ownerId: 'U1' } as any;
  const deps = {
    getAllSessions: () => new Map([['task:t1', session]]),
    scheduleLiveSessionUpdate: vi.fn(),
    refreshAgentSpend: vi.fn(),
  };
  return { session, deps, append: createSessionWorkLogAppender(deps) };
}

describe('createSessionWorkLogAppender (#598 ④b1)', () => {
  beforeEach(() => {
    appendWorkLog.mockReset();
    captureArtifactFromWorkLog.mockClear();
  });

  it('returns the store’s promise — a failed append rejects for the caller that keeps it', async () => {
    appendWorkLog.mockRejectedValueOnce(new Error('ENOSPC'));
    const { append } = setup();
    await expect(append('conv-1', { kind: 'final', text: 'done' })).rejects.toThrow('ENOSPC');
  });

  it('resolves with the stored entry when the append lands', async () => {
    appendWorkLog.mockResolvedValueOnce({ seq: 1, kind: 'final' });
    const { append } = setup();
    await expect(append('conv-1', { kind: 'final', text: 'done' })).resolves.toEqual({ seq: 1, kind: 'final' });
  });

  it('keeps the rest of the pipeline: artifact capture, card push on a tool entry', async () => {
    appendWorkLog.mockResolvedValue({});
    const { append, deps } = setup();
    await append('conv-1', { kind: 'final', text: '# Answer' });
    expect(captureArtifactFromWorkLog).toHaveBeenCalledWith('conv-1', expect.objectContaining({ kind: 'final' }));
    await append('conv-1', { kind: 'tool', text: 'Read', tool: 'Read' });
    expect(deps.scheduleLiveSessionUpdate).toHaveBeenCalledWith('task:t1');
  });
});

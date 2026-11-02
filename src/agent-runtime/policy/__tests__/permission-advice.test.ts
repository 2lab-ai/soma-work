/**
 * SSOT 2026-11-02 T2 — the advice reaches the prompt.
 *
 * The policy hook already asked the guardian about the call it escalates; it
 * leaves that advice on the board, keyed by the session, the tool and the
 * input. The permission prompt takes it. A prompt nothing escalated (legacy
 * mode asks for every tool) asks the guardian itself, within a time limit; a
 * guardian that fails or is too slow leaves the prompt with no advice.
 */

import { describe, expect, it, vi } from 'vitest';
import { PermissionAdviceBoard, resolvePermissionAdvice } from '../permission-advice';
import type { SafetyClassifier } from '../safety-classifier';

const DENY = { recommendation: 'deny' as const, summary: '저장소를 지웁니다', risk: '되돌릴 수 없습니다' };
const APPROVE = { recommendation: 'approve' as const, summary: '파일을 씁니다', risk: '작업 폴더 안입니다' };

function classifier(result: Awaited<ReturnType<SafetyClassifier['classify']>> | Promise<never>): SafetyClassifier {
  return { classify: vi.fn(() => Promise.resolve(result)) } as unknown as SafetyClassifier;
}

describe('PermissionAdviceBoard', () => {
  it('hands the advice to the prompt of the same session, tool and input — once', () => {
    const board = new PermissionAdviceBoard();
    board.put('S1', 'Bash', { command: 'rm -rf ./build', description: 'clean' }, DENY);
    // Key order of the input does not matter.
    expect(board.take('S1', 'Bash', { description: 'clean', command: 'rm -rf ./build' })).toEqual({ advice: DENY });
    expect(board.take('S1', 'Bash', { command: 'rm -rf ./build', description: 'clean' })).toBeUndefined();
  });

  it('matches an input whose undefined keys were dropped on the way (JSON drops them)', () => {
    const board = new PermissionAdviceBoard();
    board.put('S1', 'Bash', { command: 'a', timeout: undefined }, DENY);
    expect(board.take('S1', 'Bash', { command: 'a' })).toEqual({ advice: DENY });
  });

  it('keeps sessions, tools and inputs apart', () => {
    const board = new PermissionAdviceBoard();
    board.put('S1', 'Bash', { command: 'a' }, DENY);
    expect(board.take('S2', 'Bash', { command: 'a' })).toBeUndefined();
    expect(board.take('S1', 'Write', { command: 'a' })).toBeUndefined();
    expect(board.take('S1', 'Bash', { command: 'b' })).toBeUndefined();
  });

  // Review R1 (fable P3): two identical calls escalated at once each keep their own advice, oldest first.
  it('keeps two identical escalations apart, oldest first', () => {
    const board = new PermissionAdviceBoard();
    board.put('S1', 'Bash', { command: 'a' }, DENY);
    board.put('S1', 'Bash', { command: 'a' }, APPROVE);
    expect(board.take('S1', 'Bash', { command: 'a' })).toEqual({ advice: DENY });
    expect(board.take('S1', 'Bash', { command: 'a' })).toEqual({ advice: APPROVE });
    expect(board.take('S1', 'Bash', { command: 'a' })).toBeUndefined();
  });

  it('remembers that the guardian gave no advice, so the prompt does not ask again', () => {
    const board = new PermissionAdviceBoard();
    board.put('S1', 'Bash', { command: 'a' }, null);
    expect(board.take('S1', 'Bash', { command: 'a' })).toEqual({ advice: null });
  });

  it('forgets advice after its time to live', () => {
    let now = 1_000;
    const board = new PermissionAdviceBoard({ ttlMs: 100, now: () => now });
    board.put('S1', 'Bash', { command: 'a' }, DENY);
    now += 101;
    expect(board.take('S1', 'Bash', { command: 'a' })).toBeUndefined();
  });
});

describe('resolvePermissionAdvice', () => {
  const base = { scope: 'S1', toolName: 'Bash', input: { command: 'rm -rf ./build' }, user: 'U1' };

  it('uses the advice the escalation left, without a second guardian call', async () => {
    const board = new PermissionAdviceBoard();
    board.put('S1', 'Bash', base.input, DENY);
    const c = classifier({ verdict: 'ask', reason: 'x', advice: APPROVE });
    expect(await resolvePermissionAdvice({ ...base, board, classifier: c })).toEqual(DENY);
    expect(c.classify).not.toHaveBeenCalled();
  });

  it('asks the guardian when nothing was left (legacy mode)', async () => {
    const board = new PermissionAdviceBoard();
    const c = classifier({ verdict: 'ask', reason: 'x', advice: APPROVE });
    expect(await resolvePermissionAdvice({ ...base, board, classifier: c })).toEqual(APPROVE);
    expect(c.classify).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: 'Bash', command: 'rm -rf ./build', user: 'U1' }),
    );
  });

  it('gives no advice when the guardian throws', async () => {
    const board = new PermissionAdviceBoard();
    const c = { classify: vi.fn().mockRejectedValue(new Error('down')) } as unknown as SafetyClassifier;
    expect(await resolvePermissionAdvice({ ...base, board, classifier: c })).toBeNull();
  });

  it('gives no advice when the guardian is slower than the limit', async () => {
    const board = new PermissionAdviceBoard();
    const c = { classify: vi.fn(() => new Promise(() => {})) } as unknown as SafetyClassifier;
    const started = Date.now();
    expect(await resolvePermissionAdvice({ ...base, board, classifier: c, timeoutMs: 50 })).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  // Review R1 (astra P2): the limit stops the guardian call too, not only the wait.
  it('aborts the guardian call when the limit is reached', async () => {
    let signal: AbortSignal | undefined;
    const c = {
      classify: vi.fn((req: { signal?: AbortSignal }) => {
        signal = req.signal;
        return new Promise(() => {});
      }),
    } as unknown as SafetyClassifier;
    await resolvePermissionAdvice({ ...base, board: new PermissionAdviceBoard(), classifier: c, timeoutMs: 30 });
    expect(signal?.aborted).toBe(true);
  });

  // Review R1 (fable P2): the turn stopping ends the wait and the guardian call at once.
  it('stops at once, aborting the guardian call, when the turn is aborted', async () => {
    let signal: AbortSignal | undefined;
    const c = {
      classify: vi.fn((req: { signal?: AbortSignal }) => {
        signal = req.signal;
        return new Promise(() => {});
      }),
    } as unknown as SafetyClassifier;
    const turn = new AbortController();
    const started = Date.now();
    const pending = resolvePermissionAdvice({
      ...base,
      board: new PermissionAdviceBoard(),
      classifier: c,
      timeoutMs: 60_000,
      signal: turn.signal,
    });
    turn.abort();
    expect(await pending).toBeNull();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(signal?.aborted).toBe(true);
  });

  it('gives no advice with no guardian wired', async () => {
    expect(await resolvePermissionAdvice({ ...base, board: new PermissionAdviceBoard() })).toBeNull();
  });
});

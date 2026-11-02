/**
 * 스레드 태스크 카드 (SSOT 2026-11-02, .prd/21) — the host's half: the session's numbers and tasks for the card
 * (cost · tokens from the session's totals, the task in progress and the steps from its task ledger), and the
 * owner's lines from their dashboard layout (by default the task card).
 */
import { describe, expect, it } from 'vitest';
import { applyTodoList } from '../../session/task-ledger';
import { ownerThreadCardLines, threadCardDataOf } from '../thread-card-data';

describe('threadCardDataOf', () => {
  it('cost and tokens from the session’s totals; the task in progress and the steps from its ledger', () => {
    const ledger = applyTodoList(
      undefined,
      [
        { content: '요구 정리', status: 'completed' },
        { content: '미리보기 구현', status: 'in_progress', activeForm: '미리보기 구현 중' },
        { content: '확인', status: 'pending' },
      ] as any,
      1_000,
    );
    const d = threadCardDataOf({
      usage: {
        totalInputTokens: 300_000,
        totalOutputTokens: 40_000,
        totalCacheReadTokens: 6_000_000,
        totalCacheCreateTokens: 100_000,
        totalCostUsd: 6.2,
      },
      taskLedger: ledger,
    } as any);
    expect(d).toEqual({
      costUsd: 6.2,
      totalTokens: 6_440_000,
      currentTask: '미리보기 구현',
      steps: { done: 1, total: 3 },
    });
  });

  it('nothing to say: no keys (the fields draw nothing)', () => {
    expect(threadCardDataOf({} as any)).toEqual({});
    expect(threadCardDataOf(undefined as any)).toEqual({});
  });
});

describe('ownerThreadCardLines', () => {
  it('follows the owner’s task card by default; theme gives no lines', () => {
    const store = {
      getUserDashboardLayout: (id: string) =>
        id === 'U_THEME' ? { v: 1 as const, thread: { mode: 'theme' as const } } : { v: 1 as const },
      getUserDashboardMode: () => 'minimal' as const,
      getUserDashboardPlan: () => '1' as const,
    };
    const lines = ownerThreadCardLines(store, 'U1')!;
    expect(lines[0].fields[0].field).toBe('title');
    expect(lines[1].fields.map((f) => f.field)).toEqual(['owner', 'task', 'cost', 'model']);
    expect(ownerThreadCardLines(store, 'U_THEME')).toBeUndefined();
  });
});

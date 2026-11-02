/**
 * 스레드 태스크 카드 (SSOT 2026-11-02, .prd/21) — the host's half of the Slack thread card. The builder lives in
 * `@soma/slack` and cannot read a session's ledger or a user's settings; src/index.ts hands it these two through
 * `setThreadHeaderProviders`.
 */
import type { SurfaceLineConfig } from '@soma/slack/surface-config';
import type { ThreadCardData, ThreadHeaderProviders } from '@soma/slack/thread-header-builder';
import { ledgerTasks, type TaskLedger } from '../session/task-ledger';
import { type DashboardLayoutDoc, threadCardLines, type ViewMode } from '../view-layout';

interface CardSession {
  usage?: {
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalCacheReadTokens?: number;
    totalCacheCreateTokens?: number;
    totalCostUsd?: number;
  };
  taskLedger?: TaskLedger;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The session's numbers (its totals, as the dashboard's card) and its current task list's progress. */
export function threadCardDataOf(session: CardSession | undefined): ThreadCardData {
  const out: ThreadCardData = {};
  const u = session?.usage;
  if (u) {
    const cost = num(u.totalCostUsd);
    const tokens =
      num(u.totalInputTokens) + num(u.totalOutputTokens) + num(u.totalCacheReadTokens) + num(u.totalCacheCreateTokens);
    if (cost > 0) out.costUsd = cost;
    if (tokens > 0) out.totalTokens = tokens;
  }
  if (session?.taskLedger) {
    const current = ledgerTasks(session.taskLedger).current;
    if (current.length) {
      const running = current.find((t) => t.status === 'in_progress');
      if (running) out.currentTask = running.content;
      out.steps = { done: current.filter((t) => t.status === 'completed').length, total: current.length };
    }
  }
  return out;
}

interface LayoutStore {
  getUserDashboardLayout(userId: string): DashboardLayoutDoc;
  getUserDashboardMode(userId: string): ViewMode;
  getUserDashboardPlan(userId: string): string;
}

/** The owner's thread card lines — by default their dashboard's task card — or undefined for the server's theme. */
export function ownerThreadCardLines(store: LayoutStore, ownerId: string): SurfaceLineConfig[] | undefined {
  return threadCardLines(
    store.getUserDashboardLayout(ownerId),
    store.getUserDashboardMode(ownerId),
    store.getUserDashboardPlan(ownerId),
  );
}

/**
 * The host's two thread-card providers for `setThreadHeaderProviders` (src/index.ts wires exactly this): the owner's
 * lines from their dashboard layout, and the session's numbers and tasks.
 */
export function threadCardProviders(
  store: LayoutStore,
): Required<Pick<ThreadHeaderProviders, 'getThreadCardLines' | 'getThreadCardData'>> {
  return {
    getThreadCardLines: (ownerId) => ownerThreadCardLines(store, ownerId),
    getThreadCardData: (session) => threadCardDataOf(session as CardSession),
  };
}

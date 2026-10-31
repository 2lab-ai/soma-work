/**
 * The turn panel of a Slack-less task (#598 ④b, design 598b §2).
 *
 * Implements the executor's `TurnPanelPort` with no Slack client. Text is
 * accepted (`appendText → true`): the processor has already routed it to the
 * work log before panel delivery, and accepting it keeps the processor off its
 * Slack `say` fallback. Status writes use the same state update as the Slack
 * surface (`applyStatusPatch`), behind the same stale-epoch fence, then
 * broadcast. The turn's outcome is not decided here — `endTurn` keeps its
 * surface-only contract; the outcome is the task runner's (§7–§8).
 */
import { randomUUID } from 'node:crypto';
import {
  applyStatusPatch,
  type ConversationSession,
  type StatusPatch,
  type ThreadSurfaceWriteOptions,
} from '../thread-surface';
import type { TurnPanelPort } from '../turn-panel-port';

export interface DashboardTurnPanelDeps {
  persistAndBroadcast(sessionKey: string): void;
  /**
   * The session's live turn epoch, for the stale-write fence. Absent → writes
   * that carry an expected epoch are treated as unverifiable and dropped, the
   * same rule the Slack surface applies.
   */
  readTurnEpoch?(sessionKey: string): number | undefined;
}

export function createDashboardTurnPanel(deps: DashboardTurnPanelDeps): TurnPanelPort {
  const isStale = (sessionKey: string, options?: ThreadSurfaceWriteOptions): boolean => {
    const expected = options?.expectedTurnEpoch;
    if (expected === undefined) return false;
    const current = deps.readTurnEpoch?.(sessionKey);
    return current === undefined || current !== expected;
  };
  const syntheticId = (turnId: string) => `${turnId}:${randomUUID()}`;

  const panel: TurnPanelPort = {
    async beginTurn() {},
    async appendText() {
      return true;
    },
    isTurnSurfaceActive() {
      return true;
    },
    async endTurn() {
      return { snapshotResolved: true };
    },
    async failTurn() {},
    isCompletionMarkerActive() {
      return false;
    },
    async setStatus(
      session: ConversationSession,
      sessionKey: string,
      patch: StatusPatch,
      options?: ThreadSurfaceWriteOptions,
    ) {
      if (isStale(sessionKey, options)) return;
      applyStatusPatch(session, patch);
      deps.persistAndBroadcast(sessionKey);
    },
    async updatePanel(_session: ConversationSession, sessionKey: string, options?: ThreadSurfaceWriteOptions) {
      if (isStale(sessionKey, options)) return;
      deps.persistAndBroadcast(sessionKey);
    },
    async attachChoice() {
      // Not on the task path: the task question path registers the structured
      // question itself (design §6); Slack choice blocks are never stored.
    },
    async askUser(turnId: string) {
      return { ok: true as const, primaryTs: syntheticId(turnId) };
    },
    async askUserForm(turnId: string, _chunks: unknown, formIds: string[]) {
      const primaryTs = syntheticId(turnId);
      return { ok: true as const, primaryTs, allTs: [primaryTs], formIds };
    },
  };
  return panel;
}

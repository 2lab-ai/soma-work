/**
 * A dashboard task's follow-up queue (2026-11-03) — the words and limits the
 * task turn controller (which alone writes `ConversationSession.taskFollowups`)
 * and the registry's load share.
 *
 * Before it, an instruction sent from the dashboard while a task's chain ran
 * was refused with `409 a turn is already running on this task`, though the
 * panel had already listed it as waiting for the next step: only a Slack
 * session had a queue. Now the controller queues it and runs the oldest
 * queued word when a chain ends well, as its writer.
 */
import type { TaskFollowupItem } from '../types';

/** At most this many words wait on one task. */
export const TASK_FOLLOWUP_CAPACITY = 10;

/** A word may be this long (the command route's own limit is lower; a restored record is checked again). */
const MAX_TEXT = 100_000;

export const TASK_FOLLOWUP_PAUSED_BY_STOP = '중지되어 멈췄어요 — 지금 보내기로 보낼 수 있어요';
export const TASK_FOLLOWUP_PAUSED_BY_UNHEALTHY_END =
  '직전 작업이 제대로 끝나지 않아 멈췄어요 — 지금 보내기로 보낼 수 있어요';
export const TASK_FOLLOWUP_PAUSED_BY_RESTART = '재시작으로 멈췄어요 — 지금 보내기로 보낼 수 있어요';
export const TASK_FOLLOWUP_UNCERTAIN_AFTER_RESTART =
  '보내는 중에 재시작됐어요 — 이미 전달됐을 수 있으니 확인하고 보내세요';
export const TASK_FOLLOWUP_PAUSED_BEHIND_REFUSED = '앞 지시가 시작되지 못해 멈췄어요 — 지금 보내기로 보낼 수 있어요';
export const TASK_FOLLOWUP_CANCELLED = '취소했습니다';
export const TASK_FOLLOWUP_FIRST_IN_LINE = '지금 작업이 끝나면 가장 먼저 보냅니다';

/**
 * A task's queue as saved, made safe on load: malformed entries are dropped,
 * the cap holds, and every word is paused — the chain it waited for did not
 * survive the restart, so no chain end will come to run it.
 */
export function sanitizeTaskFollowups(raw: unknown): TaskFollowupItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: TaskFollowupItem[] = [];
  for (const entry of raw) {
    if (out.length >= TASK_FOLLOWUP_CAPACITY) break;
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== 'string' || !e.id || e.id.length > 200 || seen.has(e.id)) continue;
    if (typeof e.text !== 'string' || !e.text.trim() || e.text.length > MAX_TEXT) continue;
    if (typeof e.authorId !== 'string' || !e.authorId) continue;
    if (typeof e.enqueuedAt !== 'number' || !Number.isFinite(e.enqueuedAt)) continue;
    const epoch = typeof e.epoch === 'number' && Number.isSafeInteger(e.epoch) && e.epoch >= 0 ? e.epoch : 0;
    seen.add(e.id);
    const wasPaused = e.state === 'paused' && typeof e.stateReason === 'string' && e.stateReason !== '';
    // Caught in flight: it may have become a turn or an approval request already — said so, never re-run on its own.
    const restartReason =
      e.state === 'sending' ? TASK_FOLLOWUP_UNCERTAIN_AFTER_RESTART : TASK_FOLLOWUP_PAUSED_BY_RESTART;
    out.push({
      id: e.id,
      text: e.text,
      authorId: e.authorId,
      enqueuedAt: e.enqueuedAt,
      epoch: wasPaused ? epoch : epoch + 1,
      state: 'paused',
      stateReason: wasPaused ? (e.stateReason as string) : restartReason,
      ...(typeof e.approvedText === 'string' && e.approvedText.length <= MAX_TEXT
        ? { approvedText: e.approvedText }
        : {}),
      // #865 — a goal's opening stays one across a restart (its objective is never read as a goal command).
      ...(typeof e.goalOpeningId === 'string' && e.goalOpeningId && e.goalOpeningId.length <= 200
        ? { goalOpeningId: e.goalOpeningId }
        : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

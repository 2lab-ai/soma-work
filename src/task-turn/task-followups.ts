/**
 * A dashboard task's follow-up queue (2026-11-03) — the words and limits the
 * task turn controller (which alone writes `ConversationSession.taskFollowups`)
 * and the registry's load share.
 *
 * Before it, an instruction sent from the dashboard while a task's chain ran
 * was refused with `409 a turn is already running on this task`, though the
 * panel had already listed it as waiting for the next step: only a Slack
 * session had a queue. Now the controller queues it and runs the oldest
 * queued word when a chain ends well, as its writer — and after a restart,
 * too (owner directive 2026-11-03, below).
 */
import type { TaskFollowupItem } from '../types';

/** At most this many words wait on one task. */
export const TASK_FOLLOWUP_CAPACITY = 10;

/** A word may be this long (the command route's own limit is lower; a restored record is checked again). */
const MAX_TEXT = 100_000;

export const TASK_FOLLOWUP_PAUSED_BY_STOP = '중지되어 멈췄어요 — 지금 보내기로 보낼 수 있어요';
export const TASK_FOLLOWUP_PAUSED_BY_UNHEALTHY_END =
  '직전 작업이 제대로 끝나지 않아 멈췄어요 — 지금 보내기로 보낼 수 있어요';
/**
 * What a restart wrote on every queued word before 2026-11-03. No longer written: a word on
 * record with it is one of those, queued again on load while it is recent
 * ({@link TASK_FOLLOWUP_RESTART_RESEND_WINDOW_MS}).
 */
export const TASK_FOLLOWUP_PAUSED_BY_RESTART = '재시작으로 멈췄어요 — 지금 보내기로 보낼 수 있어요';
export const TASK_FOLLOWUP_UNCERTAIN_AFTER_RESTART =
  '보내는 중에 재시작됐어요 — 이미 전달됐을 수 있으니 확인하고 보내세요';
export const TASK_FOLLOWUP_PAUSED_BEHIND_REFUSED = '앞 지시가 시작되지 못해 멈췄어요 — 지금 보내기로 보낼 수 있어요';
export const TASK_FOLLOWUP_CANCELLED = '취소했습니다';
export const TASK_FOLLOWUP_FIRST_IN_LINE = '지금 작업이 끝나면 가장 먼저 보냅니다';

/**
 * A word an earlier restart paused ({@link TASK_FOLLOWUP_PAUSED_BY_RESTART}) is queued again on
 * load only while it was written this recently: one from days ago is not sent by surprise.
 */
export const TASK_FOLLOWUP_RESTART_RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A task's queue as saved, made safe on load: malformed entries are dropped
 * and the cap holds.
 *
 * Owner directive (2026-11-03): "서비스 재부팅하면 자동으로 처리되지 않은 메세지는
 * 그 이후에 반드시 보내야함 작업이 중단된거 아니면" — a word not processed before a
 * restart is sent after it, unless a person stopped the work. So a `queued`
 * word stays queued (a new epoch, as any state change): the restart does not
 * end the wait. Since the same day a task whose turn the restart cut is resumed
 * at boot (`task-restart-resume.ts`; a task with a goal, by the goal loop), and
 * that chain's healthy end runs the word as any chain end does; a task nothing
 * resumes is swept at boot (`runRestoredFollowups`). A word an earlier restart
 * paused (before this rule) comes back queued too, while it is under
 * {@link TASK_FOLLOWUP_RESTART_RESEND_WINDOW_MS} old (`now` − `enqueuedAt`).
 *
 * Unchanged: a word caught `sending` comes back paused, saying it may already
 * have gone out (it may have become a turn or an approval request — never
 * re-run on its own), and a word paused for any other reason — a Stop, an
 * unhealthy end, a refused start — keeps its reason: only Send now runs it.
 */
export function sanitizeTaskFollowups(raw: unknown, now: number = Date.now()): TaskFollowupItem[] | undefined {
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
    const pausedReason = e.state === 'paused' && typeof e.stateReason === 'string' ? e.stateReason : '';
    const pausedByEarlierRestart =
      pausedReason === TASK_FOLLOWUP_PAUSED_BY_RESTART && now - e.enqueuedAt <= TASK_FOLLOWUP_RESTART_RESEND_WINDOW_MS;
    const word = {
      id: e.id,
      text: e.text,
      authorId: e.authorId,
      enqueuedAt: e.enqueuedAt,
      ...(typeof e.approvedText === 'string' && e.approvedText.length <= MAX_TEXT
        ? { approvedText: e.approvedText }
        : {}),
      // #865 — a goal's opening stays one across a restart (its objective is never read as a goal command).
      ...(typeof e.goalOpeningId === 'string' && e.goalOpeningId && e.goalOpeningId.length <= 200
        ? { goalOpeningId: e.goalOpeningId }
        : {}),
    };
    if (e.state === 'queued' || pausedByEarlierRestart) {
      out.push({ ...word, epoch: epoch + 1, state: 'queued' });
    } else if (pausedReason !== '') {
      out.push({ ...word, epoch, state: 'paused', stateReason: pausedReason });
    } else {
      // Caught in flight (`sending`), or a state on record with no reason: it may have become a turn
      // or an approval request already — said so, never re-run on its own.
      out.push({ ...word, epoch: epoch + 1, state: 'paused', stateReason: TASK_FOLLOWUP_UNCERTAIN_AFTER_RESTART });
    }
  }
  return out.length > 0 ? out : undefined;
}

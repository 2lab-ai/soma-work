/**
 * The goal's cap decision — "Goal 계속 진행할까요?" — as ONE request with two
 * answer surfaces: the owner's Slack DM (Continue / Cancel buttons) and the
 * dashboard's approval card. An answer on either surface resolves both.
 *
 * The decision record lives on the goal and is independent of the DM:
 *
 *   - `capDmPendingAt` — when the decision opened (undefined ⇒ none pending);
 *   - `capDecisionId`  — the round's id, issued at every opening, carried by
 *     the DM buttons and the card, and checked on every answer, so a button
 *     left over from an earlier round can never answer a later one;
 *   - `capDmRef`       — where the DM landed, stored only after the post
 *     succeeded (no ref ⇒ the DM is retried on the next cap trigger).
 *
 * DM rewrites (resolved / superseded) that have not reached Slack yet live in
 * their own store, `DATA_DIR/goal-cap-dm-sync.json`: one entry per DM, apart
 * from the goal, so they survive the goal completing or being deleted. The
 * store is a journal written BEFORE the session: an answer journals its DM
 * rewrite (tagged with the round id) first and is refused when that write
 * fails; after a restart an entry whose round is still open — the session
 * save never happened — is dropped instead of sent
 * ({@link flushGoalCapDmSync}). Entries are retried in the background too.
 *
 * Exactly once: Slack buttons and the dashboard route run in the same daemon
 * process against the same in-memory session, so {@link answerGoalCapDecision}
 * checks and ends the decision synchronously and persists it before its first
 * side effect. A second answer reads it as stale. A crash after the save and
 * before the loop is kicked is recovered by the post-restart goal resume —
 * still one Continue.
 */

import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { atomicWriteJson, readJsonWithBackup } from '@soma/common/atomic-json';
import { DATA_DIR } from '../env-paths';
import { Logger } from '../logger';
import type { ConversationSession, SessionGoal } from '../types';
import { resumeGoalLoop } from './goal-loop-resume';

const logger = new Logger('GoalCapDecision');

export type GoalCapDecision = 'continue' | 'cancel';
export type GoalCapDecisionSurface = 'slack' | 'dashboard';

export interface GoalCapDmRef {
  channel: string;
  ts: string;
}

/** A DM rewrite waiting to reach Slack. */
export interface GoalCapDmSync extends GoalCapDmRef {
  text: string;
  /** The round whose end this rewrite announces. */
  decisionId?: string;
}

/** The host side effects a decision needs. Wired once in `index.ts`. */
export interface GoalCapDecisionSurfaces {
  /** Rewrite the owner's DM (production: `chat.update`). */
  updateDm?: (ref: GoalCapDmRef, text: string) => Promise<unknown>;
  /** Push the dashboard board so the card appears or resolves at once. */
  broadcast?: () => void;
}

let surfaces: GoalCapDecisionSurfaces = {};

export function setGoalCapDecisionSurfaces(next: GoalCapDecisionSurfaces | null): void {
  surfaces = next ?? {};
}

export const GOAL_CAP_DECISION_LABELS: Record<GoalCapDecision, string> = {
  continue: '✅ 계속',
  cancel: '🛑 취소',
};

/** What the DM (and the Slack click's own message) says once the decision is answered. */
export function goalCapDecisionResolvedText(decision: GoalCapDecision, surface: GoalCapDecisionSurface): string {
  const base =
    decision === 'continue'
      ? '✅ goal을 계속 진행합니다.'
      : '🛑 goal을 중단했습니다. (`goal resume`으로 다시 시작할 수 있습니다.)';
  return surface === 'dashboard' ? `${base} — 대시보드에서 응답했습니다.` : base;
}

/** What a DM says when its round ended without an answer (a message, pause, done, a newer round). */
export const GOAL_CAP_DECISION_SUPERSEDED_TEXT =
  '⚠️ 이 요청은 더 이상 유효하지 않습니다 — goal 상태가 바뀌었습니다. 필요하면 스레드나 대시보드에서 다시 지시하세요.';

/** True while the goal waits on its owner's cap decision. */
export function isGoalCapDecisionPending(goal: SessionGoal | undefined): goal is SessionGoal {
  return !!goal && goal.status === 'active' && goal.capDmPendingAt !== undefined;
}

/**
 * Open the cap decision on an active goal: stamp when, and issue the round's
 * id. Returns false (and changes nothing) when a decision is already pending.
 */
export function openGoalCapDecision(goal: SessionGoal, now: number): boolean {
  if (goal.capDmPendingAt !== undefined) {
    // A record from before round ids existed: give it one so both surfaces can name it.
    if (!goal.capDecisionId) goal.capDecisionId = randomUUID();
    return false;
  }
  goal.capDmPendingAt = now;
  goal.capDecisionId = randomUUID();
  goal.capDmRef = undefined;
  return true;
}

/**
 * Record where the DM of round `decisionId` landed. A DM that arrives after
 * its round ended (answered on the dashboard, superseded) is rewritten to the
 * superseded line at once. Returns whether the ref was kept.
 */
export function recordGoalCapDm(goal: SessionGoal, decisionId: string, ref: GoalCapDmRef): 'recorded' | 'late' {
  if (isGoalCapDecisionPending(goal) && goal.capDecisionId === decisionId && !goal.capDmRef) {
    goal.capDmRef = ref;
    return 'recorded';
  }
  queueDmSyncBestEffort(ref, GOAL_CAP_DECISION_SUPERSEDED_TEXT, decisionId);
  return 'late';
}

/** The `{ channel, ts }` of a posted message (`chat.postMessage` result), or undefined. */
export function dmRefOf(posted: unknown): GoalCapDmRef | undefined {
  const p = posted as { channel?: unknown; ts?: unknown } | null | undefined;
  return p && typeof p.channel === 'string' && p.channel && typeof p.ts === 'string' && p.ts
    ? { channel: p.channel, ts: p.ts }
    : undefined;
}

export type GoalCapDecisionAnswer =
  | { ok: true; decision: GoalCapDecision; goal: SessionGoal }
  | { ok: false; reason: 'invalid' | 'stale' | 'not_owner' | 'unavailable' };

export interface AnswerGoalCapDecisionArgs {
  session: Pick<ConversationSession, 'goal' | 'systemPrompt'> | undefined;
  sessionKey: string;
  goalId: string;
  /** The round the answer was given for. Absent only on DMs sent before round ids existed. */
  decisionId?: string;
  /** Slack user id of whoever answers. */
  actor: string | undefined;
  decision: GoalCapDecision;
  surface: GoalCapDecisionSurface;
  /** Persist the sessions (synchronous). */
  save: () => void;
  now?: number;
}

/**
 * The one way a cap decision is answered — the Slack buttons and the
 * dashboard both call it. Only the goal's owner (`createdBy`) answers, only
 * the active goal's pending round, at most once.
 */
export function answerGoalCapDecision(args: AnswerGoalCapDecisionArgs): GoalCapDecisionAnswer {
  const { session, sessionKey, goalId, decisionId, actor, decision, surface } = args;
  if (!actor || (decision !== 'continue' && decision !== 'cancel')) return { ok: false, reason: 'invalid' };
  const goal = session?.goal;
  if (!session || !goal || goal.goalId !== goalId) return { ok: false, reason: 'stale' };
  if (goal.createdBy !== actor) return { ok: false, reason: 'not_owner' };
  if (!isGoalCapDecisionPending(goal)) return { ok: false, reason: 'stale' };
  if (decisionId === undefined) {
    // A button from before round ids existed answers only a round that has no id
    // (opened by that older build); every newer round requires its own id.
    if (goal.capDecisionId) return { ok: false, reason: 'stale' };
  } else if (decisionId !== goal.capDecisionId) {
    return { ok: false, reason: 'stale' };
  }

  // Synchronous from here to the save: no other answer can interleave.
  const ref = goal.capDmRef;
  // Journal the DM rewrite BEFORE the decision is saved: a crash between the
  // two saves leaves an entry whose round is still open on disk, which the
  // restart drops. When the journal cannot be written nothing is decided.
  let rewrite: GoalCapDmSync | undefined;
  if (ref) {
    try {
      rewrite = journalDmSync(ref, goalCapDecisionResolvedText(decision, surface), goal.capDecisionId);
    } catch (error) {
      logger.error('Goal cap decision refused — the DM rewrite could not be journalled', {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, reason: 'unavailable' };
    }
  }
  endDecision(goal);
  if (decision === 'continue') {
    goal.continuationCount = 0;
    goal.status = 'active';
  } else {
    goal.status = 'paused';
  }
  goal.updatedAt = args.now ?? Date.now();
  // The same invalidation every goal-state change applies: an in-flight
  // completion eval discards its verdict, and the next turn rebuilds the
  // `<session-goal>` block.
  goal.epoch = (goal.epoch ?? 0) + 1;
  session.systemPrompt = undefined;
  args.save();

  // Every answer rewrites the round's DM through the journal — a Slack click
  // also replaces its own message (respond), but that reply can fail.
  if (rewrite) runDmSync(rewrite);
  if (decision === 'continue') resumeGoalLoop(sessionKey);
  surfaces.broadcast?.();
  return { ok: true, decision, goal };
}

/**
 * End a pending cap decision WITHOUT an answer — a real user message, pause,
 * done, eval completion, a cancelled opening. Its DM stops offering buttons.
 * Mutates the goal only; the caller persists as it already does.
 */
export function retireGoalCapDecision(goal: SessionGoal | undefined): void {
  if (!goal) return;
  const wasPending = goal.capDmPendingAt !== undefined;
  const ref = goal.capDmRef;
  const round = goal.capDecisionId;
  endDecision(goal);
  if (ref) queueDmSyncBestEffort(ref, GOAL_CAP_DECISION_SUPERSEDED_TEXT, round);
  // Deferred: the caller is mid-mutation and persists right after.
  if (wasPending && surfaces.broadcast) queueMicrotask(() => surfaces.broadcast?.());
}

function endDecision(goal: SessionGoal): void {
  goal.capDmPendingAt = undefined;
  goal.capDecisionId = undefined;
  goal.capDmRef = undefined;
}

// ── DM rewrite queue: its own store, apart from the goal's lifecycle ──

let rewrites: GoalCapDmSync[] | undefined;

function storeFile(): string {
  return path.join(DATA_DIR, 'goal-cap-dm-sync.json');
}

function validateRewrites(raw: unknown): GoalCapDmSync[] {
  if (!Array.isArray(raw)) throw new Error('not an array');
  return raw.filter(
    (e): e is GoalCapDmSync =>
      !!e && typeof e.channel === 'string' && typeof e.ts === 'string' && typeof e.text === 'string',
  );
}

function loadRewrites(): GoalCapDmSync[] {
  if (rewrites) return rewrites;
  try {
    rewrites = readJsonWithBackup(storeFile(), validateRewrites) ?? [];
  } catch (error) {
    logger.warn('Goal cap DM rewrite store unreadable — starting empty', {
      error: error instanceof Error ? error.message : String(error),
    });
    rewrites = [];
  }
  return rewrites;
}

/** Write the journal. Throws when it cannot be written — callers decide what that refuses. */
function saveRewrites(): void {
  atomicWriteJson(storeFile(), loadRewrites());
}

/** Write the journal after a delivery changed it; a failure only delays the cleanup. */
function saveRewritesQuietly(): void {
  try {
    saveRewrites();
  } catch (error) {
    logger.warn('Goal cap DM rewrite store write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The DM rewrites still waiting to reach Slack (oldest first). */
export function pendingGoalCapDmRewrites(): GoalCapDmSync[] {
  return [...loadRewrites()];
}

/** Drop the in-memory queue so the next read loads the store again (what a restart does). */
export function reloadGoalCapDmRewrites(): void {
  rewrites = undefined;
}

/**
 * Journal a DM rewrite: one entry per DM (a newer rewrite replaces only the
 * same DM's), written to disk now. Throws (and leaves the journal as it was)
 * when the write fails.
 */
function journalDmSync(ref: GoalCapDmRef, text: string, decisionId: string | undefined): GoalCapDmSync {
  const entry: GoalCapDmSync = { channel: ref.channel, ts: ref.ts, text, ...(decisionId ? { decisionId } : {}) };
  const list = loadRewrites();
  const before = [...list];
  const at = list.findIndex((e) => e.channel === ref.channel && e.ts === ref.ts);
  if (at >= 0) list[at] = entry;
  else list.push(entry);
  try {
    saveRewrites();
  } catch (error) {
    list.splice(0, list.length, ...before);
    throw error;
  }
  return entry;
}

/**
 * A round that ended without an answer (a message, pause, done…) cannot be
 * refused, so its rewrite is journalled when possible and sent either way.
 */
function queueDmSyncBestEffort(ref: GoalCapDmRef, text: string, decisionId: string | undefined): void {
  let entry: GoalCapDmSync;
  try {
    entry = journalDmSync(ref, text, decisionId);
  } catch (error) {
    logger.error('Goal cap DM rewrite could not be journalled — sending once without a retry record', {
      error: error instanceof Error ? error.message : String(error),
    });
    entry = { channel: ref.channel, ts: ref.ts, text, ...(decisionId ? { decisionId } : {}) };
  }
  runDmSync(entry);
}

/** Retry delays after a failed DM rewrite; once they run out the rewrite waits for the next restart. */
const DM_SYNC_RETRY_MS = [2_000, 15_000, 60_000];

function runDmSync(entry: GoalCapDmSync, attempt = 0): void {
  const update = surfaces.updateDm;
  if (!update) return;
  update({ channel: entry.channel, ts: entry.ts }, entry.text).then(
    () => {
      // A newer rewrite of the same DM may have replaced this one meanwhile — it runs on its own.
      const list = loadRewrites();
      const at = list.indexOf(entry);
      if (at < 0) return;
      list.splice(at, 1);
      saveRewritesQuietly();
    },
    (error: unknown) => {
      if (!loadRewrites().includes(entry)) return;
      const delay = DM_SYNC_RETRY_MS[attempt];
      if (delay === undefined) {
        logger.warn('Goal cap DM rewrite failed — kept for the next restart', {
          channel: entry.channel,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      const timer = setTimeout(() => runDmSync(entry, attempt + 1), delay);
      timer.unref?.();
    },
  );
}

/**
 * After a restart: send every DM rewrite the previous process could not
 * deliver. `isRoundOpen` reports whether a round is still pending in the
 * loaded sessions — its rewrite was journalled but the session save that would
 * have ended it never happened, so the DM keeps its buttons and the entry is
 * dropped. Returns how many rewrites were sent.
 */
export function flushGoalCapDmSync(isRoundOpen: (decisionId: string) => boolean = () => false): number {
  const list = loadRewrites();
  const kept = list.filter((e) => !(e.decisionId && isRoundOpen(e.decisionId)));
  if (kept.length !== list.length) {
    list.splice(0, list.length, ...kept);
    saveRewritesQuietly();
  }
  for (const entry of [...list]) runDmSync(entry);
  return list.length;
}

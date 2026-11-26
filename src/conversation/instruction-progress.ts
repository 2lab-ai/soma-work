/**
 * Where an instruction sent from the dashboard really is (Z 2026-11-26, #1466).
 *
 * The chat used to show nothing under a sent instruction until the session turned working, then a guess. This keeps,
 * per instruction — by the ref the panel gave it (#785) — the stage the server itself has passed for it, so the chat
 * can say what happened to it:
 *
 *   received       the dashboard route took it
 *   approval       someone else's task: it waits for the owner's approval (#767)
 *   same-work      not started: everything it names already runs or waits in another thread (.prd/36 D11)
 *   queued         the person's task queue holds it (another task of theirs runs; also after 그래도 시작)
 *   starting       its turn was dispatched: the session is being set up
 *   delivered      that run's first SDK event — the prompt is in the model's hands
 *   not-delivered  that run ended before the model had it (an error, a stop)
 *   done           that run ended after the model had it (answered, stopped or failed): no stage left to show
 *   followup       sent into a running turn: the follow-up queue owns it from here (its rows carry their own states —
 *                  대기 중 · 처리 중 · 반영됨); the chat shows no stage of this record for it (review on #1468)
 *
 * `starting` names its run (turn epoch); only that run's first event or its end moves it on — a late event of another
 * run never does. A stage never goes back. The card carries the session's few latest records; a Slack message has no
 * ref and is not recorded. In memory only: a restart forgets them, and the chat then shows no stage.
 */

import { isClientRef } from './client-ref';

export type InstructionStage =
  | 'received'
  | 'approval'
  | 'same-work'
  | 'queued'
  | 'starting'
  | 'delivered'
  | 'not-delivered'
  | 'done'
  | 'followup';

export interface InstructionProgress {
  /** The panel's ref of the instruction (its optimistic turn id, recorded on the user turn it becomes). */
  ref: string;
  stage: InstructionStage;
  /** When the server reached this stage (epoch ms). */
  at: number;
}

/** A later stage never goes back to an earlier one: a slow write after the dispatch does not undo it. */
const RANK: Record<InstructionStage, number> = {
  received: 0,
  approval: 1,
  'same-work': 2,
  // 그래도 시작 sends a refused request through the gate again: the queue may hold it now.
  queued: 3,
  starting: 4,
  delivered: 5,
  'not-delivered': 6,
  done: 6,
  // The follow-up queue owns it: nothing of this record moves it on.
  followup: 7,
};

/** Records kept by this process in all (oldest dropped first), and per session on its card. */
const MAX_RECORDS = 2000;
const PER_SESSION = 5;

interface Rec extends InstructionProgress {
  sessionKey: string;
  /** From `starting`: the run (turn epoch) it waits on. */
  epoch?: number;
}

/** By session + ref: a ref is the panel's, so the same ref sent to another session is another record. */
const byRef = new Map<string, Rec>();
const keyOf = (sessionKey: string, ref: string) => `${sessionKey}\u0000${ref}`;
/** Each session's refs, newest first (at most PER_SESSION). */
const bySession = new Map<string, string[]>();
let listener: ((sessionKey: string) => void) | undefined;

/** The session whose records changed (the dashboard pushes its card). One listener; a throw is swallowed. */
export function setInstructionProgressListener(fn: ((sessionKey: string) => void) | undefined): void {
  listener = fn;
}

function changed(sessionKey: string): void {
  try {
    listener?.(sessionKey);
  } catch {
    // The card push is best effort — never the turn's problem.
  }
}

function put(rec: Rec): void {
  const key = keyOf(rec.sessionKey, rec.ref);
  byRef.delete(key); // re-insert: the newest write is last in line for eviction
  byRef.set(key, rec);
  const refs = (bySession.get(rec.sessionKey) ?? []).filter((r) => r !== rec.ref);
  refs.unshift(rec.ref);
  for (const gone of refs.splice(PER_SESSION)) byRef.delete(keyOf(rec.sessionKey, gone));
  bySession.set(rec.sessionKey, refs);
  while (byRef.size > MAX_RECORDS) {
    const oldest = byRef.keys().next().value as string;
    const rec0 = byRef.get(oldest);
    byRef.delete(oldest);
    if (rec0) {
      const left = (bySession.get(rec0.sessionKey) ?? []).filter((r) => r !== rec0.ref);
      if (left.length) bySession.set(rec0.sessionKey, left);
      else bySession.delete(rec0.sessionKey);
    }
  }
  changed(rec.sessionKey);
}

/**
 * The instruction `ref` reached `stage` in session `sessionKey` — `epoch`: the run `starting` dispatched. No ref (a
 * Slack message), no record.
 */
export function noteInstructionStage(
  sessionKey: string | undefined,
  ref: unknown,
  stage: InstructionStage,
  now: number = Date.now(),
  epoch?: number,
): void {
  if (!sessionKey || !isClientRef(ref)) return;
  const cur = byRef.get(keyOf(sessionKey, ref));
  if (cur && RANK[stage] <= RANK[cur.stage]) return;
  put({ ref, sessionKey, stage, at: now, ...(stage === 'starting' && epoch !== undefined ? { epoch } : {}) });
}

/**
 * A run of `sessionKey` reached the model (its first SDK event): `turnEpoch` names it, or — a post-compact replay
 * inside a run's slot — `replayEpoch` names the run it runs in. It marks the instruction whose `starting` dispatched
 * that run, if one did.
 */
export function noteInstructionReachedModel(
  sessionKey: string | undefined,
  run: { turnEpoch?: number; replayEpoch?: number },
  now: number = Date.now(),
): void {
  if (!sessionKey) return;
  for (const ref of bySession.get(sessionKey) ?? []) {
    const cur = byRef.get(keyOf(sessionKey, ref));
    if (!cur || cur.stage !== 'starting' || cur.epoch === undefined) continue;
    if (run.turnEpoch !== cur.epoch && run.replayEpoch !== cur.epoch) continue;
    put({ ...cur, stage: 'delivered', at: now });
    return;
  }
}

/**
 * The run `epoch` dispatched for `ref` settled: still starting — the model never had it (not delivered); the model had
 * it — whatever came of it (an answer, a stop, an error), it is over (done).
 */
export function noteInstructionRunEnded(
  sessionKey: string | undefined,
  ref: unknown,
  epoch: number,
  now: number = Date.now(),
): void {
  if (!sessionKey || !isClientRef(ref)) return;
  const cur = byRef.get(keyOf(sessionKey, ref));
  if (!cur || cur.epoch !== epoch) return;
  if (cur.stage === 'starting') put({ ...cur, stage: 'not-delivered', at: now });
  else if (cur.stage === 'delivered') put({ ...cur, stage: 'done', at: now });
}

/** The session's latest dashboard instructions with their stages, newest first (what its card carries). */
export function instructionStagesOf(sessionKey: string): InstructionProgress[] {
  const out: InstructionProgress[] = [];
  for (const ref of bySession.get(sessionKey) ?? []) {
    const cur = byRef.get(keyOf(sessionKey, ref));
    if (cur) out.push({ ref: cur.ref, stage: cur.stage, at: cur.at });
  }
  return out;
}

/** The session's most recently moved instruction, if this process recorded one. */
export function instructionProgressOf(sessionKey: string): InstructionProgress | undefined {
  return instructionStagesOf(sessionKey)[0];
}

export function resetInstructionProgressForTests(): void {
  byRef.clear();
  bySession.clear();
  listener = undefined;
}

/**
 * Where an instruction sent from the dashboard really is (Z 2026-11-26, #1466).
 *
 * The chat used to show nothing under a sent instruction until the session turned working, then a guess. This keeps,
 * per session, the stage the server itself has passed for the latest instruction the dashboard sent it — by the ref
 * the panel gave that instruction (#785) — so the chat can say what happened to it:
 *
 *   received   the dashboard route took it
 *   approval   someone else's task: it waits for the owner's approval (#767)
 *   queued     the person's task queue holds it (another task of theirs runs)
 *   same-work  not started: everything it names already runs or waits in another thread of theirs (.prd/36 D11)
 *   starting   its turn was dispatched: the session is being set up
 *   delivered  the turn's first SDK event — the prompt is in the model's hands
 *
 * A message sent into a running turn is the follow-up queue's (its rows carry their own states); a Slack message
 * has no ref and is not recorded. In memory only: a restart forgets it, and the chat then shows no stage.
 */

import { isClientRef } from './client-ref';

export type InstructionStage = 'received' | 'approval' | 'queued' | 'same-work' | 'starting' | 'delivered';

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
  queued: 2,
  'same-work': 2,
  starting: 3,
  delivered: 4,
};

const bySession = new Map<string, InstructionProgress>();
/** Refs a newer instruction replaced, so an older one's late write cannot take over the newer record (bounded). */
const superseded = new Set<string>();
const SUPERSEDED_CAP = 2000;
let listener: ((sessionKey: string) => void) | undefined;

/** The session whose record changed (the dashboard pushes its card). One listener; a throw is swallowed. */
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

/** The instruction `ref` reached `stage` in session `sessionKey`. No ref (a Slack message), no record. */
export function noteInstructionStage(
  sessionKey: string | undefined,
  ref: unknown,
  stage: InstructionStage,
  now: number = Date.now(),
): void {
  if (!sessionKey || !isClientRef(ref) || superseded.has(ref)) return;
  const cur = bySession.get(sessionKey);
  if (cur && cur.ref === ref) {
    if (RANK[stage] <= RANK[cur.stage]) return;
  } else if (cur) {
    superseded.add(cur.ref);
    if (superseded.size > SUPERSEDED_CAP) superseded.delete(superseded.values().next().value as string);
  }
  bySession.set(sessionKey, { ref, stage, at: now });
  changed(sessionKey);
}

/**
 * A turn of `sessionKey` reached the model (its first SDK event). It is the recorded instruction's own turn only
 * while that one is starting — a turn already running, or one the queue still holds, is another turn.
 */
export function noteInstructionReachedModel(sessionKey: string | undefined, now: number = Date.now()): void {
  if (!sessionKey) return;
  const cur = bySession.get(sessionKey);
  if (!cur || cur.stage !== 'starting') return;
  bySession.set(sessionKey, { ref: cur.ref, stage: 'delivered', at: now });
  changed(sessionKey);
}

/** The latest dashboard instruction's stage for the session, if this process recorded one. */
export function instructionProgressOf(sessionKey: string): InstructionProgress | undefined {
  const cur = bySession.get(sessionKey);
  return cur ? { ...cur } : undefined;
}

export function resetInstructionProgressForTests(): void {
  bySession.clear();
  superseded.clear();
  listener = undefined;
}

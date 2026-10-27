/**
 * Per-session task ledger (SSOT 2026-10-22 T7/T8).
 *
 * The model's task list (TodoWrite) carries no ids and is replaced wholesale on
 * every update, and the in-memory TodoManager forgets it a few minutes after a
 * turn. The dashboard needs more than that snapshot:
 *
 *   - every task has an id of its own (`T1`, `T2`, …), unique within the
 *     session and never reused — two tasks with the same text are two tasks;
 *   - a task's elapsed time (start → completion) is stamped by the ledger's own
 *     clock and survives a re-sent list, so a list re-sent after the todo list
 *     was cleared does not restart every task at "now";
 *   - the tool calls made while a task was in progress are counted on it;
 *   - a task that a later list no longer contains is kept (bounded), stamped
 *     with the moment it left (`removedAt`). The view says how it left
 *     (`dropped`): a task that had run and never completed was stopped (중단),
 *     one that never ran was dropped before it started (실행 안 됨) — so the
 *     dashboard never shows a dropped task as running or as waiting to run.
 *
 * Identity across updates: a task in the new list is the task of the PREVIOUS
 * list with the same text (first unused match, in order). Anything else is a
 * new task with a new id. The ledger lives on the session and is persisted.
 *
 * Pure functions over plain data — no I/O. `applyTodoList` returns a new
 * ledger; `recordToolCall` bumps the counter in place (the session owns the
 * object and persists it with the rest of the session).
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskRecord {
  /** `T<n>` — unique within the session, assigned once, never reused. */
  id: string;
  content: string;
  activeForm?: string;
  status: TaskStatus;
  /** Epoch ms the task last entered in_progress (cleared on a regression to pending). */
  startedAt?: number;
  /** Epoch ms the task completed (cleared when it is reopened). */
  completedAt?: number;
  /** Tool calls made while this task was the task in progress. */
  toolCalls: number;
  /**
   * Epoch ms the task left the latest list: a later TodoWrite list no longer
   * held it, or the session started over ({@link closeTaskList}). Set once.
   * Absent while it is in the list — and on tasks a ledger saved before this
   * field existed.
   */
  removedAt?: number;
}

/**
 * How a task that left the list without completing went: `started` — it had
 * run (it was or had been in progress) and was stopped; `unstarted` — it
 * never ran. Derived from the record, so a ledger saved before `removedAt`
 * existed reads the same way.
 */
export type TaskDropped = 'started' | 'unstarted';

/** A task as the dashboard shows it: the record, and how it left the list if it did. */
export interface TaskView extends TaskRecord {
  /** Earlier tasks only: it left the list before it completed. */
  dropped?: TaskDropped;
}

export interface TaskLedger {
  /** The number the next new task gets. */
  nextSeq: number;
  /** Every known task, oldest first, at most {@link TASK_LEDGER_MAX}. */
  tasks: TaskRecord[];
  /** Ids of the latest TodoWrite list, in its order. */
  current: string[];
}

/** Ledger bound — tasks no longer in the list beyond this are forgotten, oldest first. */
export const TASK_LEDGER_MAX = 200;

const STATUSES = new Set<TaskStatus>(['pending', 'in_progress', 'completed']);

export interface TodoInput {
  content: string;
  status: TaskStatus;
  activeForm?: string;
}

function stamp(rec: TaskRecord, status: TaskStatus, now: number): void {
  rec.status = status;
  if (status === 'pending') {
    rec.startedAt = undefined;
    rec.completedAt = undefined;
  } else if (status === 'in_progress') {
    if (!rec.startedAt) rec.startedAt = now;
    rec.completedAt = undefined;
  } else {
    if (!rec.startedAt) rec.startedAt = now;
    if (!rec.completedAt) rec.completedAt = now;
  }
}

/** The task left the latest list at `now` (the first time only). */
function markRemoved(rec: TaskRecord, now: number): void {
  if (!rec.removedAt) rec.removedAt = now;
}

/** Merge one TodoWrite list into the ledger (returns a new ledger). */
export function applyTodoList(ledger: TaskLedger | undefined, todos: readonly TodoInput[], now: number): TaskLedger {
  const prev = ledger ?? { nextSeq: 1, tasks: [], current: [] };
  const byId = new Map(prev.tasks.map((t) => [t.id, { ...t }]));
  const previousList = prev.current.map((id) => byId.get(id)).filter((t): t is TaskRecord => !!t);
  const used = new Set<string>();
  let nextSeq = prev.nextSeq;
  const current: string[] = [];

  for (const item of todos) {
    if (!item || typeof item.content !== 'string' || !STATUSES.has(item.status)) continue;
    let rec = previousList.find((t) => !used.has(t.id) && t.content === item.content);
    if (!rec) {
      rec = { id: `T${nextSeq++}`, content: item.content, status: 'pending', toolCalls: 0 };
      byId.set(rec.id, rec);
    }
    used.add(rec.id);
    if (typeof item.activeForm === 'string') rec.activeForm = item.activeForm;
    stamp(rec, item.status, now);
    current.push(rec.id);
  }
  // The previous list's tasks the new one does not hold left it now.
  for (const t of previousList) if (!used.has(t.id)) markRemoved(t, now);

  // Oldest first: tasks already known keep their place, new ones go last.
  const known = prev.tasks.map((t) => byId.get(t.id)!);
  const added = current.filter((id) => !prev.tasks.some((t) => t.id === id)).map((id) => byId.get(id)!);
  let tasks = known.concat(added);
  if (tasks.length > TASK_LEDGER_MAX) {
    const keep = new Set(current);
    let excess = tasks.length - TASK_LEDGER_MAX;
    tasks = tasks.filter((t) => {
      if (excess > 0 && !keep.has(t.id)) {
        excess--;
        return false;
      }
      return true;
    });
  }
  return { nextSeq, tasks, current };
}

/** The task in progress: the first in_progress task of the latest list. */
export function currentTask(ledger: TaskLedger | undefined): TaskRecord | undefined {
  if (!ledger) return undefined;
  for (const id of ledger.current) {
    const t = ledger.tasks.find((x) => x.id === id);
    if (t && t.status === 'in_progress') return t;
  }
  return undefined;
}

/** Count one tool call on the task in progress (in place). Returns that task, if any. */
export function recordToolCall(ledger: TaskLedger | undefined): TaskRecord | undefined {
  const t = currentTask(ledger);
  if (t) t.toolCalls = (t.toolCalls || 0) + 1;
  return t;
}

/** How an earlier task left the list, if it had not completed. */
function droppedOf(t: TaskRecord): TaskDropped | undefined {
  if (t.status === 'completed') return undefined;
  // A regression to pending clears startedAt; tool calls made while it ran still prove it ran.
  return t.status === 'in_progress' || t.startedAt || t.toolCalls > 0 ? 'started' : 'unstarted';
}

/**
 * The ledger as the dashboard shows it: `current` = the latest list in its
 * order; `earlier` = tasks no longer in it, newest first, each not completed
 * one marked with how it left (`dropped`). Copies.
 */
export function ledgerTasks(ledger: TaskLedger): { current: TaskView[]; earlier: TaskView[] } {
  const inList = new Set(ledger.current);
  const byId = new Map(ledger.tasks.map((t) => [t.id, t]));
  return {
    current: ledger.current
      .map((id) => byId.get(id))
      .filter((t): t is TaskRecord => !!t)
      .map((t) => ({ ...t })),
    earlier: ledger.tasks
      .filter((t) => !inList.has(t.id))
      .reverse()
      .map((t) => {
        const dropped = droppedOf(t);
        return dropped ? { ...t, dropped } : { ...t };
      }),
  };
}

function finitePositive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Restore a persisted ledger. Anything that is not a ledger reads as none; bad tasks are dropped. */
export function sanitizeTaskLedger(raw: unknown): TaskLedger | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const nextSeq = finitePositive(r.nextSeq);
  if (!nextSeq || !Array.isArray(r.tasks)) return undefined;
  const tasks: TaskRecord[] = [];
  const seen = new Set<string>();
  for (const item of r.tasks) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    if (typeof t.id !== 'string' || !/^T\d+$/.test(t.id) || seen.has(t.id) || typeof t.content !== 'string') continue;
    seen.add(t.id);
    const rec: TaskRecord = {
      id: t.id,
      content: t.content,
      status: STATUSES.has(t.status as TaskStatus) ? (t.status as TaskStatus) : 'pending',
      toolCalls: Math.floor(finitePositive(t.toolCalls) ?? 0),
    };
    if (typeof t.activeForm === 'string') rec.activeForm = t.activeForm;
    const startedAt = finitePositive(t.startedAt);
    if (startedAt) rec.startedAt = startedAt;
    const completedAt = finitePositive(t.completedAt);
    if (completedAt) rec.completedAt = completedAt;
    const removedAt = finitePositive(t.removedAt);
    if (removedAt) rec.removedAt = removedAt;
    tasks.push(rec);
  }
  const current = Array.isArray(r.current)
    ? r.current.filter((id): id is string => typeof id === 'string' && seen.has(id))
    : [];
  // Never mint an id that is already taken, even from a damaged file.
  const highest = tasks.reduce((m, t) => Math.max(m, Number(t.id.slice(1))), 0);
  // Over the bound: keep every task of the current list, then the newest others.
  const inList = new Set(current);
  const others = tasks.filter((t) => !inList.has(t.id));
  const room = Math.max(0, TASK_LEDGER_MAX - (tasks.length - others.length));
  const keepOthers = new Set(others.slice(Math.max(0, others.length - room)).map((t) => t.id));
  const kept = tasks.filter((t) => inList.has(t.id) || keepOthers.has(t.id));
  return { nextSeq: Math.max(Math.floor(nextSeq), highest + 1), tasks: kept, current };
}

/**
 * The session starts over (`/new`, renew, handoff): no task of the old list is
 * in progress any more — it stays in the history (`earlier`), left at `now`,
 * and nothing new is attributed to it.
 */
export function closeTaskList(ledger: TaskLedger | undefined, now: number): TaskLedger | undefined {
  if (!ledger) return undefined;
  const inList = new Set(ledger.current);
  const tasks = ledger.tasks.map((t) => {
    if (!inList.has(t.id)) return t;
    const copy = { ...t };
    markRemoved(copy, now);
    return copy;
  });
  return { ...ledger, tasks, current: [] };
}

/** Work-log kinds that belong to the task in progress. Instructions and final answers frame the turn. */
const TASK_SCOPED_KINDS = new Set(['narration', 'tool', 'tool_result', 'notice', 'error']);
/** Longest task title a work-log entry carries. */
export const WORK_LOG_TASK_TITLE_MAX = 200;

/**
 * Stamp a work-log entry with the task in progress (SSOT 2026-10-22 T10) so the
 * dashboard can fold the log under its tasks, and count a `tool` entry as one
 * tool call of that task (T7). Returns a copy; an entry outside any task is
 * returned as it is.
 */
export function stampWorkLogTask<E extends { kind: string }>(
  ledger: TaskLedger | undefined,
  entry: E,
): E & { taskId?: string; taskTitle?: string } {
  if (!TASK_SCOPED_KINDS.has(entry.kind)) return entry;
  const task = entry.kind === 'tool' ? recordToolCall(ledger) : currentTask(ledger);
  if (!task) return entry;
  return { ...entry, taskId: task.id, taskTitle: task.content.slice(0, WORK_LOG_TASK_TITLE_MAX) };
}

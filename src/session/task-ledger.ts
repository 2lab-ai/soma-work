/**
 * Per-session task ledger (SSOT 2026-10-22 T7/T8, rebuilt 2026-10-29 T5).
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
 *   - the work done while a task ran — tool calls (its own and its subagents')
 *     and API usage (tokens, cost) — is counted on it;
 *   - a task that a later list no longer contains is kept (bounded), stamped
 *     with the moment it left (`removedAt`). The view says how it left
 *     (`dropped`): a task that had run and never completed was stopped (중단),
 *     one that never ran was dropped before it started (실행 안 됨).
 *
 * Identity across updates (2026-10-29 T5 — measured on dev: 55% of the items
 * of 1,178 real lists changed their text from one update to the next, because
 * the model writes progress INTO the task — "CI on 2e5cb5b → merge" becomes
 * "CI green → PR #500 merged b8cdd17"). Matching by exact text minted a new,
 * already-completed task with 0 tools for every such rewrite and marked the
 * task that had done the work 중단 — 93% of completed tasks on dev read
 * "start = end, 툴 0회". So a task of the new list is the task of the PREVIOUS
 * list that holds its slot:
 *
 *   1. the same text (first unused match, in order);
 *   2. else the best remaining candidate by a score of text similarity (shared
 *      words, or one text extending the other), the same `activeForm`, and the
 *      same position — at least {@link MATCH_MIN}. A completed task is never
 *      reopened by a rewrite (only by its exact text).
 *
 * A matched rewrite keeps the id, times and counts and records the earlier text
 * (`revisions`). Anything else is a new task with a new id.
 *
 * Attribution: the tasks in progress at the moment share the work evenly (they
 * ran at the same time; the share is marked with `shared`). Work done while no
 * task was in progress waits on the ledger (`idle`) and goes, at the next list,
 * to the tasks that list completed without ever having been in progress (the
 * model did the work, then reported it done) — their start is that window's
 * start, marked `startEstimated`. With none, it is work outside any task
 * (`outside`). Sums over the tasks therefore equal what was spent.
 *
 * Pure functions over plain data — no I/O. `applyTodoList` returns a new
 * ledger; the `record*` / `credit*` functions update it in place (the session
 * owns the object and persists it with the rest of the session).
 */

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

/** API usage of the calls made while a task ran. */
export interface TaskTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** API-equivalent cost of those calls (priced by the session model when the call landed). */
  costUsd: number;
}

/** One earlier text of a task — the model rewrote it at `at`. */
export interface TaskRevision {
  at: number;
  content: string;
}

export interface TaskRecord {
  /** `T<n>` — unique within the session, assigned once, never reused. */
  id: string;
  content: string;
  activeForm?: string;
  status: TaskStatus;
  /** Epoch ms the task last entered in_progress (cleared on a regression to pending). */
  startedAt?: number;
  /** Epoch ms the task first entered in_progress — never cleared: it ran, even if it went back to pending (#488). */
  firstStartedAt?: number;
  /** Epoch ms the task completed (cleared when it is reopened). */
  completedAt?: number;
  /** Tool calls the main agent made while this task ran (its share when tasks ran together). */
  toolCalls: number;
  /** Tool calls subagents made while this task ran (its share). */
  agentToolCalls?: number;
  /**
   * API usage (main agent + subagents) while this task ran (its share).
   * Absent on tasks recorded before per-task usage existed — unknown, not 0.
   */
  tokens?: TaskTokens;
  /** The texts this task had before the current one, oldest first (bounded). */
  revisions?: TaskRevision[];
  /**
   * The start was not observed: the task went from waiting straight to
   * completed, so it ran at the latest since the list before (its start).
   */
  startEstimated?: boolean;
  /** The most tasks this one shared its work with (≥ 2: its numbers are a share). */
  shared?: number;
  /**
   * Epoch ms the task left the latest list: a later TodoWrite list no longer
   * held it, or the session started over ({@link closeTaskList}). Set once.
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

/** Work not (yet) on a task: tool calls and usage. */
export interface TaskWork {
  toolCalls: number;
  agentToolCalls: number;
  tokens: TaskTokens;
}

/** Runtime record of one API call's credit, so a re-report of the call replaces it (bounded, not restored). */
interface CallCredit {
  /** Task ids that got the credit, or `idle` / `outside`. */
  to: string[] | 'idle' | 'outside';
  t: TaskTokens;
  /** The model the live credit was priced at (a later correction re-prices on the same basis). */
  model?: string;
  /** Its final usage from the transcript is in: the first to go when the memory is full (review). */
  settled?: boolean;
}

export interface TaskLedger {
  /** The number the next new task gets. */
  nextSeq: number;
  /** Every known task, oldest first, at most {@link TASK_LEDGER_MAX}. */
  tasks: TaskRecord[];
  /** Ids of the latest TodoWrite list, in its order. */
  current: string[];
  /** Epoch ms of the latest list — the start of the window the next list closes. */
  updatedAt?: number;
  /** Work since the latest list while no task was in progress. */
  idle?: TaskWork;
  /** Work that no task got: done while none was in progress, and the next list completed none. */
  outside?: TaskWork;
}

/** Ledger bound — tasks no longer in the list beyond this are forgotten, oldest first. */
export const TASK_LEDGER_MAX = 200;
/** Earlier texts kept per task. */
export const TASK_REVISIONS_MAX = 12;
/** Lowest score at which a rewritten task is the same task (see {@link matchScore}). */
export const MATCH_MIN = 0.45;
/**
 * Lowest text similarity of any rewrite (review R1): the words must say it is
 * the same work — the slot and a generic activeForm ("Working") alone never
 * make two different tasks one.
 */
export const REWRITE_TEXT_MIN = 0.3;
/**
 * API calls whose credit is remembered for a re-report — the live frame and,
 * later, the call's final usage from the transcript ({@link recreditTaskUsage}).
 * A turn's calls (subagents' included) are read back within seconds, so this
 * only has to outlast that window.
 */
const CALLS_MAX = 512;
/**
 * Runtime only (never on the ledger object, so never in sessions.json): the
 * latest API calls' credits by call key, per ledger generation — applyTodoList
 * hands them to the ledger it returns.
 */
const CALL_CREDITS = new WeakMap<TaskLedger, Record<string, CallCredit>>();

const STATUSES = new Set<TaskStatus>(['pending', 'in_progress', 'completed']);
const RANK: Record<TaskStatus, number> = { pending: 0, in_progress: 1, completed: 2 };

export interface TodoInput {
  content: string;
  status: TaskStatus;
  activeForm?: string;
}

function zeroTokens(): TaskTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, costUsd: 0 };
}

function zeroWork(): TaskWork {
  return { toolCalls: 0, agentToolCalls: 0, tokens: zeroTokens() };
}

function addTokens(into: TaskTokens, t: TaskTokens, k: number): void {
  into.input += t.input * k;
  into.output += t.output * k;
  into.cacheRead += t.cacheRead * k;
  into.cacheCreate += t.cacheCreate * k;
  into.costUsd += t.costUsd * k;
}

function isEmptyWork(w: TaskWork | undefined): boolean {
  if (!w) return true;
  const t = w.tokens;
  return !w.toolCalls && !w.agentToolCalls && !t.input && !t.output && !t.cacheRead && !t.cacheCreate && !t.costUsd;
}

function stamp(rec: TaskRecord, status: TaskStatus, now: number, windowStart: number | undefined): void {
  const wasStarted = !!rec.startedAt;
  rec.status = status;
  if (status === 'pending') {
    rec.startedAt = undefined;
    rec.completedAt = undefined;
    rec.startEstimated = undefined;
  } else if (status === 'in_progress') {
    if (!rec.startedAt) rec.startedAt = now;
    rec.completedAt = undefined;
  } else {
    if (!rec.startedAt && rec.firstStartedAt) {
      // It ran before (then waited): it ran again since the list before at the latest.
      rec.startedAt = windowStart && windowStart < now ? windowStart : now;
    } else if (!rec.startedAt) {
      // Straight from waiting to completed: it ran since the list before.
      if (windowStart && windowStart < now) {
        rec.startedAt = windowStart;
        rec.startEstimated = true;
      } else rec.startedAt = now;
    }
    if (!rec.completedAt) rec.completedAt = now;
  }
  if (rec.startedAt && !rec.firstStartedAt) rec.firstStartedAt = rec.startedAt;
  if (wasStarted && status === 'in_progress') rec.startEstimated = rec.startEstimated || undefined;
}

/** The task left the latest list at `now` (the first time only). */
function markRemoved(rec: TaskRecord, now: number): void {
  if (!rec.removedAt) rec.removedAt = now;
}

function words(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(/[\p{L}\p{N}#./_-]+/gu) ?? []) if (w.length > 1) out.add(w);
  return out;
}

/**
 * One text is the WHOLE other plus more (the model appended a result: "… 머지" →
 * "… 머지 (e28a450)"). A shared head is not enough (review R1): "Implement
 * login API" and "Implement logout API" share 12 characters and are two tasks.
 */
function extendsText(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  return (
    (x.length >= 8 && y.length > x.length && y.startsWith(x)) ||
    (y.length >= 8 && x.length > y.length && x.startsWith(y))
  );
}

/** Issue / PR references in a text ("#450", "PR #450.", "(#450)"), read from the raw text — punctuation never hides one (review R3). */
function refsOf(text: string): Set<string> {
  return new Set(text.match(/#\d+/g) ?? []);
}
/** Environment names, normalized (development → dev, production → prod). */
const ENVS: Record<string, string> = {
  dev: 'dev',
  development: 'dev',
  dev2: 'dev2',
  staging: 'staging',
  stage: 'staging',
  stg: 'staging',
  qa: 'qa',
  preview: 'preview',
  prod: 'prod',
  production: 'prod',
};
/** The environments a text names (a word, or a branch like deploy/dev). */
function envsOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) if (ENVS[w]) out.add(ENVS[w]);
  return out;
}
/** Words for comparing targets: no edge punctuation, environment aliases folded (development → dev). */
function targetWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of words(text)) {
    const bare = w.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu, '');
    if (bare.length > 1) out.add(ENVS[bare] ?? bare);
  }
  return out;
}
/** Words a text has and the other lacks. */
function only(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const w of a) if (!b.has(w)) out.push(w);
  return out;
}
/**
 * The new text names another target, not new words for the same one (review
 * R2 · R3) — similar wording is then no proof:
 *   - it cites other issue/PR refs, none in common ("Fix #455" → "Fix #456",
 *     "Review and merge PR #450." → "… PR #451.");
 *   - each names one environment and they differ ("Deploy the dashboard to dev
 *     and verify" → "… to prod …"; development = dev, production = prod);
 *   - a short text (3 words or fewer) swaps exactly one word for another
 *     ("Implement login API" → "Implement logout API"); a word changing form
 *     (fix → fixed, v0 → v1) is no swap.
 */
export function changesTarget(a: string, b: string): boolean {
  const ra = refsOf(a);
  const rb = refsOf(b);
  if (ra.size && rb.size && ![...ra].some((r) => rb.has(r))) return true;
  const ea = envsOf(a);
  const eb = envsOf(b);
  if (ea.size === 1 && eb.size === 1 && [...ea][0] !== [...eb][0]) return true;
  const wa = targetWords(a);
  const wb = targetWords(b);
  if (Math.min(wa.size, wb.size) > 3) return false;
  // A word changing form is the same target (review R4): fix → fixed, v0 → v1.
  const gone = only(wa, wb);
  const came = only(wb, wa);
  const unexplained = (xs: string[], ys: string[]) => xs.filter((x) => !ys.some((y) => sameWordForm(x, y)));
  // Exactly one word swapped for another, nothing else changed (login → logout).
  // Words added or dropped around it are progress written in ("Final terminal
  // report" → "Final report with evidence"), not another target (review R4 replay).
  return wa.size === wb.size && unexplained(gone, came).length === 1 && unexplained(came, gone).length === 1;
}

/** Two words are one word in another form: one is the other's head (fix / fixed), or both are versions (v0 / v1). */
function sameWordForm(x: string, y: string): boolean {
  if (/^v\d+$/.test(x) && /^v\d+$/.test(y)) return true;
  return Math.min(x.length, y.length) >= 3 && (x.startsWith(y) || y.startsWith(x));
}

/** How alike two task texts are, 0..1: shared words (Jaccard), or 0.9 when one extends the other. */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const wa = words(a);
  const wb = words(b);
  let jaccard = 0;
  if (wa.size && wb.size) {
    let common = 0;
    for (const w of wa) if (wb.has(w)) common++;
    jaccard = common / (wa.size + wb.size - common);
  }
  return Math.max(jaccard, extendsText(a, b) ? 0.9 : 0);
}

/** Score of `next` (at index i of the new list) holding the slot of `prev` (at index k of the previous list). */
export function matchScore(prev: TodoInput, k: number, next: TodoInput, i: number): number {
  let s = textSimilarity(prev.content, next.content);
  if (prev.activeForm && prev.activeForm === next.activeForm) s += 0.35;
  if (k === i) s += 0.25;
  return s;
}

function pushRevisions(rec: TaskRecord, more: TaskRevision[]): void {
  const all = (rec.revisions ?? []).concat(more).sort((a, b) => a.at - b.at);
  rec.revisions = all.length > TASK_REVISIONS_MAX ? [all[0], ...all.slice(-(TASK_REVISIONS_MAX - 1))] : all;
}

function copyTask(t: TaskRecord): TaskRecord {
  const c: TaskRecord = { ...t };
  if (t.tokens) c.tokens = { ...t.tokens };
  if (t.revisions) c.revisions = t.revisions.map((r) => ({ ...r }));
  return c;
}

/** Merge one TodoWrite list into the ledger (returns a new ledger). */
export function applyTodoList(ledger: TaskLedger | undefined, todos: readonly TodoInput[], now: number): TaskLedger {
  const prev = ledger ?? { nextSeq: 1, tasks: [], current: [] };
  // Copies down to the numbers: a credit on the new ledger never changes the old one.
  const byId = new Map(prev.tasks.map((t) => [t.id, copyTask(t)]));
  const previousList = prev.current.map((id) => byId.get(id)).filter((t): t is TaskRecord => !!t);
  const items = todos.filter(
    (item): item is TodoInput => !!item && typeof item.content === 'string' && STATUSES.has(item.status),
  );
  const slot: (TaskRecord | undefined)[] = new Array(items.length);
  const used = new Set<string>();

  // A finished list (every task completed) is over: a new list that names one
  // of its tasks again as waiting or running is a new run of that work, not
  // the old task reopened — reopening it would put both runs (and the gap
  // between them) on one record. Live 2026-10-29: the same three steps run
  // twice in one session read as one 65 s task each.
  const finished = previousList.length > 0 && previousList.every((t) => t.status === 'completed');
  // 1. The same text.
  items.forEach((item, i) => {
    const rec = previousList.find(
      (t) =>
        !used.has(t.id) &&
        t.content === item.content &&
        !(finished && t.status === 'completed' && item.status !== 'completed'),
    );
    if (rec) {
      slot[i] = rec;
      used.add(rec.id);
    }
  });
  // 2. A rewrite of a task still unmatched: the best score first.
  const cands: { s: number; i: number; k: number }[] = [];
  items.forEach((item, i) => {
    if (slot[i]) return;
    previousList.forEach((p, k) => {
      if (used.has(p.id)) return;
      // A rewrite never moves a task back (review R1): a completed task is not
      // reopened, a running one not put back to waiting, under new words — only
      // its exact text does that (step 1).
      if (RANK[item.status] < RANK[p.status]) return;
      // The same activeForm ranks a candidate (matchScore) but never lowers this
      // floor (review R2): a split task reads honestly as 교체됨 + a new task; a
      // wrong match moves one task's work onto another.
      if (textSimilarity(p.content, item.content) < REWRITE_TEXT_MIN) return;
      if (changesTarget(p.content, item.content)) return;
      const s = matchScore(p, k, item, i);
      if (s >= MATCH_MIN) cands.push({ s, i, k });
    });
  });
  cands.sort((a, b) => b.s - a.s || Math.abs(a.i - a.k) - Math.abs(b.i - b.k));
  for (const c of cands) {
    const rec = previousList[c.k];
    if (slot[c.i] || used.has(rec.id)) continue;
    slot[c.i] = rec;
    used.add(rec.id);
  }
  // No folding (review R1): a previous task with no slot of its own left the list.
  // If it had run, its work stays on it (the view lists it as replaced — 교체됨);
  // a candidate it lost is no proof the new task is its work.

  let nextSeq = prev.nextSeq;
  const current: string[] = [];
  const straightDone: TaskRecord[] = [];
  items.forEach((item, i) => {
    let rec = slot[i];
    if (!rec) {
      rec = { id: `T${nextSeq++}`, content: item.content, status: 'pending', toolCalls: 0, tokens: zeroTokens() };
      byId.set(rec.id, rec);
    } else if (rec.content !== item.content) {
      // Keep the first text and the newest ones.
      pushRevisions(rec, [{ at: now, content: rec.content }]);
      rec.content = item.content;
    }
    if (typeof item.activeForm === 'string') rec.activeForm = item.activeForm;
    if (item.status === 'completed' && rec.status !== 'completed' && !rec.startedAt) straightDone.push(rec);
    stamp(rec, item.status, now, prev.updatedAt);
    current.push(rec.id);
  });
  // The previous list's tasks the new one does not hold left it now.
  for (const t of previousList) if (!used.has(t.id)) markRemoved(t, now);

  // The work of a window with no task in progress goes to the tasks this list
  // completed without ever having been in progress; with none, it was outside any task.
  let idleTo: string[] | 'outside' | undefined;
  let outside = prev.outside ? cloneWork(prev.outside) : undefined;
  if (!isEmptyWork(prev.idle)) {
    const idle = prev.idle as TaskWork;
    if (straightDone.length) {
      shareWork(straightDone, idle);
      idleTo = straightDone.map((t) => t.id);
    } else {
      outside = outside ?? zeroWork();
      addWork(outside, idle, 1);
      idleTo = 'outside';
    }
  }

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
  const next: TaskLedger = { nextSeq, tasks, current, updatedAt: now };
  if (outside && !isEmptyWork(outside)) next.outside = outside;
  const prevCalls = ledger ? CALL_CREDITS.get(ledger) : undefined;
  if (prevCalls) {
    // A late re-report of a call credited to the idle window follows the work.
    const calls: Record<string, CallCredit> = {};
    for (const key of Object.keys(prevCalls)) {
      const c = prevCalls[key];
      calls[key] = c.to === 'idle' ? { ...c, to: idleTo ?? 'outside' } : c;
    }
    CALL_CREDITS.set(next, calls);
  }
  return next;
}

function cloneWork(w: TaskWork): TaskWork {
  return { toolCalls: w.toolCalls, agentToolCalls: w.agentToolCalls, tokens: { ...w.tokens } };
}

function addWork(into: TaskWork, w: TaskWork, k: number): void {
  into.toolCalls += w.toolCalls * k;
  into.agentToolCalls += w.agentToolCalls * k;
  addTokens(into.tokens, w.tokens, k);
}

/** Split `w` evenly over `tasks` (each gets 1/n, marked shared when n ≥ 2). */
function shareWork(tasks: TaskRecord[], w: TaskWork): void {
  const k = 1 / tasks.length;
  for (const t of tasks) {
    t.toolCalls = (t.toolCalls || 0) + w.toolCalls * k;
    if (w.agentToolCalls) t.agentToolCalls = (t.agentToolCalls || 0) + w.agentToolCalls * k;
    t.tokens = t.tokens ?? zeroTokens();
    addTokens(t.tokens, w.tokens, k);
    if (tasks.length > 1) t.shared = Math.max(t.shared ?? 1, tasks.length);
  }
}

/**
 * A ledger before any list (review R1): work done before the model's first
 * TodoWrite (exploring, planning) is held as idle work from `now` on — the
 * first list hands it to the tasks it reports done, else it is outside any task.
 */
export function emptyTaskLedger(now: number): TaskLedger {
  return { nextSeq: 1, tasks: [], current: [], updatedAt: now };
}

/** The tasks in progress, in list order. */
export function runningTasks(ledger: TaskLedger | undefined): TaskRecord[] {
  if (!ledger) return [];
  const out: TaskRecord[] = [];
  for (const id of ledger.current) {
    const t = ledger.tasks.find((x) => x.id === id);
    if (t && t.status === 'in_progress') out.push(t);
  }
  return out;
}

/** The task in progress: the first in_progress task of the latest list. */
export function currentTask(ledger: TaskLedger | undefined): TaskRecord | undefined {
  return runningTasks(ledger)[0];
}

/**
 * Count work on the tasks in progress (in place): split evenly over them, or
 * held as idle work until the next list says which tasks it was. Returns the
 * tasks that got it.
 */
function creditWork(ledger: TaskLedger | undefined, w: TaskWork): TaskRecord[] {
  if (!ledger) return [];
  const running = runningTasks(ledger);
  if (running.length) {
    shareWork(running, w);
    return running;
  }
  ledger.idle = ledger.idle ?? zeroWork();
  addWork(ledger.idle, w, 1);
  return [];
}

/** Count one tool call of the main agent. Returns the task it is stamped with (the first in progress), if any. */
export function recordToolCall(ledger: TaskLedger | undefined): TaskRecord | undefined {
  return creditWork(ledger, { toolCalls: 1, agentToolCalls: 0, tokens: zeroTokens() })[0];
}

/** Count one tool call a subagent made on the main tasks in progress. */
export function recordAgentToolCall(ledger: TaskLedger | undefined): void {
  creditWork(ledger, { toolCalls: 0, agentToolCalls: 1, tokens: zeroTokens() });
}

export interface UsageCall {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreateTokens?: number;
  /**
   * The reading is the call's final usage — its transcript line has a stop
   * reason. A line written while the call still streams has `stop_reason:
   * null` and a provisional output (measured: 4 tokens): never final.
   */
  final?: boolean;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Credit one API call's usage to the tasks in progress (in place). `key`
 * identifies the call (its message id): the SDK reports a call on several
 * frames, so a re-report replaces the earlier credit, on the same tasks.
 */
export function creditTaskUsage(
  ledger: TaskLedger | undefined,
  key: string | undefined,
  call: UsageCall,
  costUsd: number,
  model?: string,
): void {
  if (!ledger) return;
  const t: TaskTokens = {
    input: count(call.inputTokens),
    output: count(call.outputTokens),
    cacheRead: count(call.cacheReadTokens),
    cacheCreate: count(call.cacheCreateTokens),
    costUsd: count(costUsd),
  };
  const calls = CALL_CREDITS.get(ledger) ?? {};
  const before = key ? calls[key] : undefined;
  if (before && key) {
    // A call reported again is live: it moves to the newest place, inside the
    // window that is never dropped (review R2, astra note 1).
    delete calls[key];
    calls[key] = before;
    // A late live frame of a call whose final usage is in carries no more than
    // it (the start-of-call count): it never undoes the correction (note 2).
    if (
      before.settled &&
      t.input <= before.t.input &&
      t.output <= before.t.output &&
      t.cacheRead <= before.t.cacheRead &&
      t.cacheCreate <= before.t.cacheCreate
    ) {
      return;
    }
    const delta: TaskTokens = {
      input: t.input - before.t.input,
      output: t.output - before.t.output,
      cacheRead: t.cacheRead - before.t.cacheRead,
      cacheCreate: t.cacheCreate - before.t.cacheCreate,
      costUsd: t.costUsd - before.t.costUsd,
    };
    before.t = t;
    const w: TaskWork = { toolCalls: 0, agentToolCalls: 0, tokens: delta };
    if (before.to === 'idle') {
      ledger.idle = ledger.idle ?? zeroWork();
      addWork(ledger.idle, w, 1);
    } else if (before.to === 'outside') {
      ledger.outside = ledger.outside ?? zeroWork();
      addWork(ledger.outside, w, 1);
    } else {
      const ids = before.to;
      const targets = ledger.tasks.filter((x) => ids.includes(x.id));
      const k = 1 / ids.length;
      // A task that left the ledger since (TASK_LEDGER_MAX) took all of its
      // numbers with it; a late correction to it leaves with it too (review R2:
      // a difference alone, put elsewhere, could read as negative spend).
      for (const x of targets) {
        x.tokens = x.tokens ?? zeroTokens();
        addTokens(x.tokens, delta, k);
      }
    }
    return;
  }
  const got = creditWork(ledger, { toolCalls: 0, agentToolCalls: 0, tokens: t });
  if (!key) return;
  calls[key] = { to: got.length ? got.map((x) => x.id) : 'idle', t, ...(model ? { model } : {}) };
  trimCalls(calls);
  CALL_CREDITS.set(ledger, calls);
}

/**
 * Replace a call's live credit with its final usage (in place). The live frame
 * of a Claude call carries its `message_start` usage: input and cache are
 * final there, output is the few tokens counted at the start — the final
 * count is only in the CLI's transcript. Only a call this ledger was credited
 * with live is touched (the difference goes to the same tasks, or the same
 * idle / outside window); an unknown call is never credited to whatever runs
 * now. Returns whether anything changed.
 */
export function recreditTaskUsage(
  ledger: TaskLedger | undefined,
  key: string,
  call: UsageCall,
  price: (creditedModel: string | undefined) => number,
): boolean {
  if (!ledger) return false;
  const before = CALL_CREDITS.get(ledger)?.[key];
  if (!before) return false;
  // A reading needs a prompt side (review: llmux non-Claude providers write
  // all-zero usage into the transcript while their live reading — from
  // `message_delta` — is the real one). Unreported is not zero.
  if (count(call.inputTokens) + count(call.cacheReadTokens) + count(call.cacheCreateTokens) === 0) return false;
  let costUsd = 0;
  try {
    costUsd = price(before.model);
  } catch {
    costUsd = 0;
  }
  if (!Number.isFinite(costUsd)) costUsd = 0;
  const t = before.t;
  if (
    t.input === count(call.inputTokens) &&
    t.output === count(call.outputTokens) &&
    t.cacheRead === count(call.cacheReadTokens) &&
    t.cacheCreate === count(call.cacheCreateTokens) &&
    t.costUsd === count(costUsd)
  ) {
    if (call.final) before.settled = true;
    return false;
  }
  creditTaskUsage(ledger, key, call, costUsd);
  if (call.final) before.settled = true;
  return true;
}

/** The newest call credits are never dropped: a call still streaming may be re-reported live (review R2). */
const CALLS_RECENT_KEPT = 64;

/**
 * Keep at most {@link CALLS_MAX} call credits. The newest
 * {@link CALLS_RECENT_KEPT} always stay (a call still streaming is among them —
 * dropping it would credit its next live frame from scratch). Of the rest,
 * settled ones (a transcript reading is in) go first, oldest first; a call
 * still waiting for its final usage goes only when that many newer ones wait
 * too (review: a busy turn with many subagents must not drop it before its
 * correction). `settled` only orders the dropping: a later, larger reading
 * of a kept call is still taken.
 */
function trimCalls(calls: Record<string, CallCredit>): void {
  const keys = Object.keys(calls);
  let excess = keys.length - CALLS_MAX;
  if (excess <= 0) return;
  const old = keys.slice(0, Math.max(0, keys.length - CALLS_RECENT_KEPT));
  for (const k of old) {
    if (excess <= 0) return;
    if (calls[k].settled) {
      delete calls[k];
      excess--;
    }
  }
  for (const k of old) {
    if (excess <= 0) return;
    if (k in calls) {
      delete calls[k];
      excess--;
    }
  }
}

/** How an earlier task left the list, if it had not completed. */
function droppedOf(t: TaskRecord): TaskDropped | undefined {
  if (t.status === 'completed') return undefined;
  // A regression to pending clears startedAt; its first start (or tool calls made
  // while it ran, on a ledger saved before firstStartedAt existed) still prove it ran.
  return t.status === 'in_progress' || t.startedAt || t.firstStartedAt || t.toolCalls > 0 ? 'started' : 'unstarted';
}

/** A task for the view: a copy without runtime fields, counts rounded where they were shared. */
function viewOf(t: TaskRecord): TaskView {
  const v: TaskView = { ...t };
  if (t.revisions) v.revisions = t.revisions.map((r) => ({ ...r }));
  if (t.tokens) v.tokens = { ...t.tokens };
  return v;
}

/**
 * The ledger as the dashboard shows it: `current` = the latest list in its
 * order; `earlier` = tasks no longer in it, newest first, each not completed
 * one marked with how it left (`dropped`); `outside` = work no task got. Copies.
 */
export function ledgerTasks(ledger: TaskLedger): { current: TaskView[]; earlier: TaskView[]; outside?: TaskWork } {
  const inList = new Set(ledger.current);
  const byId = new Map(ledger.tasks.map((t) => [t.id, t]));
  const out: { current: TaskView[]; earlier: TaskView[]; outside?: TaskWork } = {
    current: ledger.current
      .map((id) => byId.get(id))
      .filter((t): t is TaskRecord => !!t)
      .map(viewOf),
    earlier: ledger.tasks
      .filter((t) => !inList.has(t.id))
      .reverse()
      .map((t) => {
        const v = viewOf(t);
        const dropped = droppedOf(t);
        if (dropped) v.dropped = dropped;
        return v;
      }),
  };
  // Work outside any task: what no list claimed, plus what waits on the next list
  // (review R1: the final answer after the last task completed is spent too).
  const outside = ledger.outside ? cloneWork(ledger.outside) : undefined;
  if (!isEmptyWork(ledger.idle)) {
    const total = outside ?? zeroWork();
    addWork(total, ledger.idle as TaskWork, 1);
    out.outside = total;
  } else if (outside && !isEmptyWork(outside)) out.outside = outside;
  return out;
}

function finitePositive(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
}

function sanitizeTokens(raw: unknown): TaskTokens | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  return {
    input: count(r.input),
    output: count(r.output),
    cacheRead: count(r.cacheRead),
    cacheCreate: count(r.cacheCreate),
    costUsd: count(r.costUsd),
  };
}

function sanitizeWork(raw: unknown): TaskWork | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const w: TaskWork = {
    toolCalls: count(r.toolCalls),
    agentToolCalls: count(r.agentToolCalls),
    tokens: sanitizeTokens(r.tokens) ?? zeroTokens(),
  };
  return isEmptyWork(w) ? undefined : w;
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
      toolCalls: finitePositive(t.toolCalls) ?? 0,
    };
    if (typeof t.activeForm === 'string') rec.activeForm = t.activeForm;
    const startedAt = finitePositive(t.startedAt);
    if (startedAt) rec.startedAt = startedAt;
    const completedAt = finitePositive(t.completedAt);
    if (completedAt) rec.completedAt = completedAt;
    const removedAt = finitePositive(t.removedAt);
    if (removedAt) rec.removedAt = removedAt;
    const firstStartedAt = finitePositive(t.firstStartedAt) ?? startedAt;
    if (firstStartedAt) rec.firstStartedAt = firstStartedAt;
    const agentToolCalls = finitePositive(t.agentToolCalls);
    if (agentToolCalls) rec.agentToolCalls = agentToolCalls;
    const tokens = sanitizeTokens(t.tokens);
    if (tokens) rec.tokens = tokens;
    if (Array.isArray(t.revisions)) {
      const revisions = t.revisions
        .filter(
          (x): x is TaskRevision =>
            !!x && typeof x === 'object' && typeof x.content === 'string' && !!finitePositive(x.at),
        )
        .slice(-TASK_REVISIONS_MAX)
        .map((x) => ({ at: x.at, content: x.content }));
      if (revisions.length) rec.revisions = revisions;
    }
    if (t.startEstimated === true && rec.startedAt) rec.startEstimated = true;
    const shared = finitePositive(t.shared);
    if (shared && shared >= 2) rec.shared = Math.floor(shared);
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
  const out: TaskLedger = { nextSeq: Math.max(Math.floor(nextSeq), highest + 1), tasks: kept, current };
  const updatedAt = finitePositive(r.updatedAt);
  if (updatedAt) out.updatedAt = updatedAt;
  const idle = sanitizeWork(r.idle);
  if (idle) out.idle = idle;
  const outside = sanitizeWork(r.outside);
  if (outside) out.outside = outside;
  return out;
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
  const out: TaskLedger = { ...ledger, tasks, current: [] };
  // Idle work of the old list will never be claimed by it: it was outside any task.
  if (!isEmptyWork(ledger.idle)) {
    const outside = ledger.outside ? cloneWork(ledger.outside) : zeroWork();
    addWork(outside, ledger.idle as TaskWork, 1);
    out.outside = outside;
  }
  delete out.idle;
  // A call re-reported after the list closed stays where it was credited (review R2):
  // on its task, or outside any task (the idle window now is).
  const calls = CALL_CREDITS.get(ledger);
  if (calls) {
    const carried: Record<string, CallCredit> = {};
    for (const key of Object.keys(calls)) {
      const c = calls[key];
      carried[key] = c.to === 'idle' ? { ...c, to: 'outside' } : c;
    }
    CALL_CREDITS.set(out, carried);
  }
  return out;
}

/** Work-log kinds that belong to the task in progress. Instructions and final answers frame the turn. */
const TASK_SCOPED_KINDS = new Set(['narration', 'tool', 'tool_result', 'notice', 'error']);
/** Longest task title a work-log entry carries. */
export const WORK_LOG_TASK_TITLE_MAX = 200;

/**
 * Stamp a work-log entry with the task in progress (SSOT 2026-10-22 T10) so the
 * dashboard can fold the log under its tasks, and count a `tool` entry as one
 * tool call (T7). Returns a copy; an entry outside any task is returned as it is.
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

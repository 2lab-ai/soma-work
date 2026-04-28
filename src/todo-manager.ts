import * as fs from 'node:fs';
import * as path from 'node:path';
import { DATA_DIR } from './env-paths';
import { Logger } from './logger';

export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
  /** IDs of tasks that must complete before this one can start */
  dependencies?: string[];
  /** Present-continuous form shown during execution (e.g. "Running tests") */
  activeForm?: string;
  /** Epoch ms when task transitioned to in_progress */
  startedAt?: number;
  /** Epoch ms when task transitioned to completed */
  completedAt?: number;
  /**
   * Foreign key to `UserInstruction.id` (#754) — frozen at creation time
   * (#727 sealed). `null` means the Todo was created while the session had
   * no `currentInstructionId`. Subsequent updates do NOT change this value
   * even if `currentInstructionId` shifts mid-session.
   */
  userInstructionId?: string | null;
}

/**
 * On-disk envelope for `data/users/{userId}/todos.json` (#757).
 *
 * Sealed schema (binding from #727):
 *   {
 *     schemaVersion: 1,
 *     todos: Array<Todo & { sessionId: string; userInstructionId: string | null }>
 *   }
 */
export interface TodoDoc {
  schemaVersion: 1;
  todos: Array<Todo & { sessionId: string; userInstructionId: string | null }>;
}

/** Status of an instruction as seen by the FK guard (#757). */
export type InstructionStatus = 'active' | 'completed' | 'cancelled' | 'unknown';

export type InstructionStatusLookup = (instructionId: string) => InstructionStatus;

export interface UpdateTodosOptions {
  /**
   * Owning user — required for write-through persistence. When omitted the
   * manager stays RAM-only (legacy callers, unit tests).
   */
  userId?: string;
  /**
   * The session's `currentInstructionId` at the moment of the TodoWrite call
   * (sourced from PR1's UserSessionStore via SessionRegistry). New Todos
   * (those whose `id` was not previously seen on this session) get this
   * value stamped onto `userInstructionId`. `null`/undefined means "no
   * current instruction" — the new Todo's link will be `null`.
   */
  currentInstructionId?: string | null;
  /**
   * Instruction status oracle for the FK guard. When provided, new Todos
   * that link to a `cancelled` or `completed` instruction are rejected
   * BEFORE any RAM mutation or disk write.
   */
  instructionStatusLookup?: InstructionStatusLookup;
}

const VALID_STATUSES = new Set(['pending', 'in_progress', 'completed']);
const VALID_PRIORITIES = new Set(['high', 'medium', 'low']);

/**
 * Validate and sanitize raw input into a Todo array.
 * Returns null if the input is not a valid array (caller should reject).
 *
 * Items with valid `content` (string) and `status` (valid enum) are kept;
 * others are filtered out. The function never mutates its input.
 *
 * TodoWrite (Claude Code) sends items without `id` or `priority`.
 * Missing `id` is derived from `content` (stable across reorders);
 * missing or invalid `priority` defaults to 'medium'.
 */
export function parseTodos(raw: unknown): Todo[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .map((item) => {
      if (item == null || typeof item !== 'object') return null;
      const src = item as Record<string, unknown>;
      if (typeof src.content !== 'string' || !VALID_STATUSES.has(src.status as string)) return null;
      // Clone to avoid mutating the caller's input
      const t = { ...src };
      // Stable content-based id when missing (TodoWrite omits it)
      if (typeof t.id !== 'string') t.id = `todo-${simpleHash(src.content as string)}`;
      // Default priority when missing or invalid (TodoWrite omits it)
      if (!VALID_PRIORITIES.has(t.priority as string)) t.priority = 'medium';
      return t as unknown as Todo;
    })
    .filter((item): item is Todo => item !== null);
}

/** Simple string hash for generating stable, deterministic todo IDs from content. */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Validate that a userId is safe to use as a directory component.
 * Disallows path traversal (`..`), absolute paths, separators and NUL.
 *
 * Mirror of UserSessionStore's `assertSafeUserId` so the two stores stay
 * in lockstep on the userId charset (Q7 sealed).
 */
function assertSafeUserId(userId: string): void {
  if (!userId || typeof userId !== 'string') {
    throw new Error('TodoManager: invalid userId (empty or non-string)');
  }
  if (userId.includes('/') || userId.includes('\\') || userId.includes('\x00')) {
    throw new Error(`TodoManager: invalid userId (separator/NUL): ${JSON.stringify(userId)}`);
  }
  if (userId === '.' || userId === '..' || userId.startsWith('..')) {
    throw new Error(`TodoManager: invalid userId (path traversal): ${JSON.stringify(userId)}`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(userId)) {
    throw new Error(`TodoManager: invalid userId (charset): ${JSON.stringify(userId)}`);
  }
}

const FILE_NAME = 'todos.json';

export interface TodoManagerOptions {
  /**
   * Filesystem root for per-user persistence. Defaults to `DATA_DIR` so
   * production code keeps working without changes; tests pass a tmpdir.
   */
  baseDir?: string;
}

export class TodoManager {
  private logger = new Logger('TodoManager');
  /** sessionId -> todos (RAM hot path, includes userInstructionId on each entry). */
  private todos: Map<string, Todo[]> = new Map();
  /**
   * sessionId -> owning userId. Populated when `updateTodos` is called with
   * `opts.userId`. Used so a write to ANY session re-snapshots the full
   * per-user todos.json (cross-session read API requires the user's sessions
   * to share one file — Q7 sealed).
   */
  private sessionOwner: Map<string, string> = new Map();
  private dataDir: string;
  private _onUpdate: ((sessionId: string, todos: Todo[]) => void) | null = null;

  constructor(opts: TodoManagerOptions = {}) {
    this.dataDir = opts.baseDir || DATA_DIR;
  }

  setOnUpdateCallback(fn: (sessionId: string, todos: Todo[]) => void): void {
    this._onUpdate = fn;
  }

  /** Resolve the per-user todos.json path. Sanitises userId. */
  private filePath(userId: string): string {
    assertSafeUserId(userId);
    return path.join(this.dataDir, 'users', userId, FILE_NAME);
  }

  private ensureUserDir(userId: string): string {
    const dir = path.join(this.dataDir, 'users', userId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  /**
   * Load the user's todos.json into the in-memory map (per-session). When no
   * file exists this is a no-op (a user with no Todos yet is a normal
   * state — same contract as UserSessionStore.load()). Throws on malformed
   * JSON or schema drift; we NEVER silently overwrite a corrupt file because
   * the next write-through would clobber real on-disk data.
   */
  loadFromDisk(userId: string): void {
    const file = this.filePath(userId);
    if (!fs.existsSync(file)) return;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      this.logger.error('Failed to read todos.json', { userId, error: err });
      throw err;
    }
    let parsed: TodoDoc;
    try {
      parsed = JSON.parse(raw) as TodoDoc;
    } catch (err) {
      throw new Error(`TodoManager: ${file} is not valid JSON: ${(err as Error).message}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`TodoManager: ${file} root must be an object`);
    }
    if (parsed.schemaVersion !== 1) {
      throw new Error(`TodoManager: ${file} schemaVersion must be 1, got ${JSON.stringify(parsed.schemaVersion)}`);
    }
    if (!Array.isArray(parsed.todos)) {
      throw new Error(`TodoManager: ${file} 'todos' is not an array`);
    }
    // Group by sessionId so getTodos(sessionId) keeps its existing semantics.
    const grouped = new Map<string, Todo[]>();
    for (const entry of parsed.todos) {
      if (!entry || typeof entry !== 'object' || typeof (entry as Todo).id !== 'string') {
        throw new Error(`TodoManager: ${file} contains a malformed todo entry`);
      }
      const sid = entry.sessionId;
      if (typeof sid !== 'string' || sid.length === 0) {
        throw new Error(`TodoManager: ${file} entry missing sessionId`);
      }
      // userInstructionId may be string or null — normalise undefined → null.
      const link = entry.userInstructionId;
      if (link !== null && typeof link !== 'string') {
        throw new Error(`TodoManager: ${file} entry has invalid userInstructionId`);
      }
      const stripped: Todo = { ...(entry as Todo) };
      // Strip the per-row sessionId from the in-memory Todo: it's metadata
      // for the file format, not part of the Todo's own identity.
      delete (stripped as { sessionId?: unknown }).sessionId;
      if (!grouped.has(sid)) grouped.set(sid, []);
      grouped.get(sid)!.push(stripped);
      this.sessionOwner.set(sid, userId);
    }
    for (const [sid, list] of grouped) {
      this.todos.set(sid, list);
    }
  }

  /**
   * Persist all sessions owned by `userId` to disk atomically (tmp → rename).
   * Public for tests/admin scripts; `updateTodos` calls this internally on
   * write-through.
   */
  saveToDisk(userId: string): void {
    assertSafeUserId(userId);
    const doc: TodoDoc = { schemaVersion: 1, todos: [] };
    for (const [sid, list] of this.todos) {
      if (this.sessionOwner.get(sid) !== userId) continue;
      for (const t of list) {
        doc.todos.push({
          ...t,
          sessionId: sid,
          userInstructionId: t.userInstructionId ?? null,
        });
      }
    }
    this.ensureUserDir(userId);
    const final = this.filePath(userId);
    const tmp = `${final}.tmp`;
    const data = JSON.stringify(doc, null, 2);
    try {
      fs.writeFileSync(tmp, data, 'utf-8');
      fs.renameSync(tmp, final);
    } catch (err) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  updateTodos(sessionId: string, todos: Todo[], opts?: UpdateTodosOptions): void {
    const validated = parseTodos(todos);
    if (validated === null) {
      // Non-array payload — reject and preserve last-known-good state
      this.logger.warn('updateTodos rejected non-array payload, keeping previous state', {
        sessionId,
        receivedType: typeof todos,
        receivedValue: String(todos).slice(0, 200),
      });
      return;
    }

    const previous = this.todos.get(sessionId) || [];

    // ── Cancelled/completed instruction guard (#757) ──
    // Runs BEFORE any RAM mutation or disk write so a rejected batch
    // leaves both surfaces in their last-known-good state. The guard only
    // applies to NEW Todos (id not in `previous`) because frozen-at-
    // creation already pins existing links — updating an existing Todo
    // whose instruction has since completed is allowed (#727 sealed).
    if (opts?.instructionStatusLookup && opts.currentInstructionId) {
      const lookup = opts.instructionStatusLookup;
      const newLink = opts.currentInstructionId;
      for (const task of validated) {
        const prev = previous.find((p) => p.id === task.id);
        if (prev) continue; // existing Todo — link is frozen, no new FK created
        const status = lookup(newLink);
        if (status === 'cancelled' || status === 'completed') {
          throw new Error(
            `TodoManager: cannot create Todo linked to ${status} instruction ${JSON.stringify(newLink)}`,
          );
        }
      }
    }

    // ── Timing: carry over / stamp startedAt & completedAt ──
    const now = Date.now();
    for (const task of validated) {
      const prev = previous.find((p) => p.id === task.id);
      if (prev) {
        // Carry forward existing timestamps
        if (prev.startedAt && !task.startedAt) task.startedAt = prev.startedAt;
        if (prev.completedAt && !task.completedAt) task.completedAt = prev.completedAt;
        // ── Frozen-at-creation (#727 sealed): once a Todo has a
        // userInstructionId, subsequent updates NEVER change it, even if
        // `opts.currentInstructionId` shifted mid-session. The link is
        // pinned at the moment of creation and stays put for the
        // Todo's lifetime.
        task.userInstructionId = prev.userInstructionId ?? null;
      } else {
        // First sighting — auto-link from opts.currentInstructionId. Null
        // is the legitimate "no current instruction" state.
        task.userInstructionId = opts?.currentInstructionId ?? null;
      }
      // Stamp on status transitions (handle regressions too)
      if (task.status === 'pending') {
        // Regressed to pending — clear all timing
        task.startedAt = undefined;
        task.completedAt = undefined;
      } else if (task.status === 'in_progress') {
        if (!task.startedAt) task.startedAt = now;
        task.completedAt = undefined; // clear stale completion on rework
      } else if (task.status === 'completed') {
        if (!task.startedAt) task.startedAt = now; // edge case: jumped straight to completed
        if (!task.completedAt) task.completedAt = now;
      }
    }

    this.todos.set(sessionId, validated);
    if (opts?.userId) {
      this.sessionOwner.set(sessionId, opts.userId);
      // Write-through (Q-write-through sealed). Persist every mutation so
      // RAM and disk stay in sync — the next process boot (or admin tool
      // running on the same data dir) reads exactly what the live process
      // sees.
      this.saveToDisk(opts.userId);
    }
    if (this._onUpdate) this._onUpdate(sessionId, validated);
    this.logger.debug('Updated todos for session', {
      sessionId,
      todoCount: validated.length,
      pending: validated.filter((t) => t.status === 'pending').length,
      inProgress: validated.filter((t) => t.status === 'in_progress').length,
      completed: validated.filter((t) => t.status === 'completed').length,
    });
  }

  getTodos(sessionId: string): Todo[] {
    return this.todos.get(sessionId) || [];
  }

  /**
   * Cross-session lookup: every Todo owned by `userId` whose
   * `userInstructionId === instructionId`. Used by the dashboard /
   * inspector seam (#759) to answer "which Todos came out of THIS
   * instruction?".
   *
   * Scoped to one user (never crosses userId boundaries) and skips Todos
   * whose link is null. Caller must `loadFromDisk(userId)` first if the
   * manager is freshly constructed; this method does NOT auto-rehydrate
   * because the production seam keeps state in RAM after the first read
   * and rehydration is the controller's job (matches UserSessionStore's
   * load contract).
   */
  findTodosByInstructionId(userId: string, instructionId: string): Todo[] {
    const out: Todo[] = [];
    for (const [sid, list] of this.todos) {
      if (this.sessionOwner.get(sid) !== userId) continue;
      for (const t of list) {
        if (t.userInstructionId === instructionId) {
          out.push(t);
        }
      }
    }
    return out;
  }

  formatTodoList(todos: Todo[]): string {
    if (todos.length === 0) {
      return '📋 *Task List*\n\nNo tasks defined yet.';
    }

    let message = '📋 *Task List*\n\n';

    // Group by status
    const pending = todos.filter((t) => t.status === 'pending');
    const inProgress = todos.filter((t) => t.status === 'in_progress');
    const completed = todos.filter((t) => t.status === 'completed');

    // Show in-progress tasks first
    if (inProgress.length > 0) {
      message += '*🔄 In Progress:*\n';
      for (const todo of inProgress) {
        const priority = this.getPriorityIcon(todo.priority);
        message += `${priority} ${todo.content}\n`;
      }
      message += '\n';
    }

    // Then pending tasks
    if (pending.length > 0) {
      message += '*⏳ Pending:*\n';
      for (const todo of pending) {
        const priority = this.getPriorityIcon(todo.priority);
        message += `${priority} ${todo.content}\n`;
      }
      message += '\n';
    }

    // Finally completed tasks
    if (completed.length > 0) {
      message += '*✅ Completed:*\n';
      for (const todo of completed) {
        const priority = this.getPriorityIcon(todo.priority);
        message += `${priority} ~${todo.content}~\n`;
      }
    }

    // Add progress summary
    const total = todos.length;
    const completedCount = completed.length;
    const progress = total > 0 ? Math.round((completedCount / total) * 100) : 0;

    message += `\n*Progress:* ${completedCount}/${total} tasks completed (${progress}%)`;

    return message;
  }

  private getPriorityIcon(priority: string): string {
    switch (priority) {
      case 'high':
        return '🔴';
      case 'medium':
        return '🟡';
      case 'low':
        return '🟢';
      default:
        return '⚪';
    }
  }

  hasSignificantChange(oldTodos: Todo[], newTodos: Todo[]): boolean {
    // Check if task count changed
    if (oldTodos.length !== newTodos.length) {
      return true;
    }

    // Check if any task status, activeForm, content, or dependencies changed
    for (const newTodo of newTodos) {
      const oldTodo = oldTodos.find((t) => t.id === newTodo.id);
      if (
        !oldTodo ||
        oldTodo.status !== newTodo.status ||
        oldTodo.activeForm !== newTodo.activeForm ||
        oldTodo.content !== newTodo.content ||
        JSON.stringify(oldTodo.dependencies) !== JSON.stringify(newTodo.dependencies)
      ) {
        return true;
      }
    }

    return false;
  }

  getStatusChange(oldTodos: Todo[], newTodos: Todo[]): string | null {
    // Find status changes
    const changes: string[] = [];

    for (const newTodo of newTodos) {
      const oldTodo = oldTodos.find((t) => t.id === newTodo.id);

      if (!oldTodo) {
        // New task added
        changes.push(`➕ Added: ${newTodo.content}`);
      } else if (oldTodo.status !== newTodo.status) {
        // Status changed
        const statusEmoji = {
          pending: '⏳',
          in_progress: '🔄',
          completed: '✅',
        };

        changes.push(`${statusEmoji[newTodo.status]} ${newTodo.content}`);
      }
    }

    // Check for removed tasks
    for (const oldTodo of oldTodos) {
      if (!newTodos.find((t) => t.id === oldTodo.id)) {
        changes.push(`➖ Removed: ${oldTodo.content}`);
      }
    }

    return changes.length > 0 ? changes.join('\n') : null;
  }

  /**
   * Check if a task is blocked by incomplete dependencies.
   * A missing dependency (dangling ref) is treated as blocking (safe default).
   */
  isBlocked(todo: Todo, allTodos: Todo[]): boolean {
    if (!todo.dependencies || todo.dependencies.length === 0) return false;
    return todo.dependencies.some((depId) => {
      const dep = allTodos.find((t) => t.id === depId);
      // Missing dep → treat as blocking (dangling ref should not unblock)
      if (!dep) return true;
      return dep.status !== 'completed';
    });
  }

  /**
   * Get the effective display status of a task (accounts for dependencies).
   * Returns 'blocked' if task is pending but has incomplete dependencies.
   */
  getEffectiveStatus(todo: Todo, allTodos: Todo[]): 'completed' | 'in_progress' | 'pending' | 'blocked' {
    if (todo.status === 'completed') return 'completed';
    if (todo.status === 'in_progress') return 'in_progress';
    if (this.isBlocked(todo, allTodos)) return 'blocked';
    return 'pending';
  }

  cleanupSession(sessionId: string): void {
    this.todos.delete(sessionId);
    this.logger.debug('Cleaned up todos for session', { sessionId });
  }
}

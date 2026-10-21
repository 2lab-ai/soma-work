export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
  dependencies?: string[];
  activeForm?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface TodoStatusReader {
  getEffectiveStatus(todo: Todo, allTodos: Todo[]): 'completed' | 'in_progress' | 'pending' | 'blocked';
}

export type SessionTheme = 'default' | 'compact' | 'minimal';

/** Max content length per task before truncation */
const MAX_TASK_CONTENT_LENGTH = 80;

/**
 * Escape user-supplied text for safe embedding in Slack mrkdwn.
 * Neutralizes formatting chars, mentions, links, and newlines.
 */
function escapeMrkdwn(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*/g, '∗') // fullwidth asterisk
    .replace(/~/g, '∼') // tilde operator
    .replace(/_/g, 'ˍ') // modifier letter low macron
    .replace(/`/g, 'ʼ') // modifier letter apostrophe
    .replace(/\n/g, ' '); // flatten newlines
}

/** Derived status union used by the static `buildPlanTasks` path.
 * `blocked` is NOT a raw Todo.status value — it's computed from dependencies.
 */
type EffectiveStatus = 'completed' | 'in_progress' | 'pending' | 'blocked';

/** Effective status ignoring the TodoManager instance — used by the static
 * `buildPlanTasks` path which does not own a TodoManager. Mirrors the logic
 * in `TodoManager.getEffectiveStatus` (pending + non-completed dep = blocked).
 */
function computeEffectiveStatus(todo: Todo, allTodos: Todo[]): EffectiveStatus {
  if (todo.status === 'completed') return 'completed';
  if (todo.status === 'in_progress') return 'in_progress';
  // todo.status === 'pending' from here
  if (!todo.dependencies || todo.dependencies.length === 0) return 'pending';
  const blocked = todo.dependencies.some((depId) => {
    const dep = allTodos.find((t) => t.id === depId);
    // Missing dep → treat as blocked (matches TodoManager.isBlocked behavior)
    if (!dep) return true;
    return dep.status !== 'completed';
  });
  return blocked ? 'blocked' : 'pending';
}

/** Options for the static `buildPlanTasks` path. */
export interface BuildPlanTasksOptions {
  /**
   * End-of-turn terminal-state render. When `true`, any effective
   * `in_progress` is demoted to `pending` across all three output forms
   * (top-level text, task_card, fallback section). This kills the stuck
   * Slack-native loading indicator that lingers when an LLM ends a turn
   * without marking its in-progress todo as completed — the persistent
   * `planTs` Slack message otherwise keeps the spinner spinning forever.
   *
   * Honesty rule: demote to `pending`, NEVER promote to `complete`.
   * Unfinished work stays visibly unfinished; only the misleading "still
   * running" UI signal is removed.
   */
  final?: boolean;
}

/**
 * One task row after effective-status computation + optional terminal-state
 * demotion. Shared by the B2 plan-block path (`buildPlanTasks`) and the
 * native streaming-chunk path (`buildTaskChunks`) so the two surfaces can
 * never drift on status semantics — the demotion honesty rule in particular
 * (`in_progress` → `pending`, never → `complete`).
 */
interface TaskRow {
  /** Stable task identity. Falls back to a 1-based positional id. */
  id: string;
  /** Raw, unmodified todo content (callers truncate/escape per surface). */
  content: string;
  effective: EffectiveStatus;
}

/**
 * Compute the rendered rows for a todos snapshot. Pure — the input array and
 * its Todo objects are never mutated (the `final` demotion is applied to the
 * derived row, not to the source todo).
 */
function buildTaskRows(todos: Todo[], finalize: boolean): TaskRow[] {
  return todos.map((todo, i) => {
    const rawEffective = computeEffectiveStatus(todo, todos);
    // Terminal-state demotion: `in_progress` → `pending`. We never promote
    // to `completed` — unfinished work must stay visibly unfinished.
    const effective: EffectiveStatus = finalize && rawEffective === 'in_progress' ? 'pending' : rawEffective;
    return { id: todo.id || `todo-${i + 1}`, content: todo.content, effective };
  });
}

/** Icon prefix for the top-level plain-text fallback view. */
const STATUS_ICON: Record<EffectiveStatus, string> = {
  completed: '✅',
  in_progress: '⏳',
  pending: '⬜',
  blocked: '🚧',
};

/** Map internal effective status → Slack task_card `status` enum. Slack
 * task_card only has `pending | in_progress | complete | error`, so our
 * `blocked` derived state collapses to `pending` for the card itself — the
 * 🚧 signal is preserved in the top-level text and in the section fallback. */
function toTaskCardStatus(effective: EffectiveStatus): 'complete' | 'in_progress' | 'pending' {
  if (effective === 'completed') return 'complete';
  if (effective === 'in_progress') return 'in_progress';
  return 'pending';
}

/**
 * A `task_update` streaming chunk (Slack `chat.appendStream` chunks mode).
 * Mirrors `@slack/types` `TaskUpdateChunk`, narrowed to the fields this
 * surface actually emits — `details`/`output`/`sources` are out of scope for
 * U10a (todo snapshots carry no per-task output).
 */
export interface TaskUpdateChunk {
  type: 'task_update';
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'complete' | 'error';
}

/**
 * THE task title as shown to the user — shared by the `task_card` title on
 * the B2 plan block and the `task_update.title` chunk on the native stream,
 * so the same todo can never appear under two different names depending on
 * which surface happened to render it.
 *
 * Capped for display only: the Slack streaming reference publishes no
 * per-chunk title limit, so we reuse the display cap the mrkdwn task lines
 * already use rather than inventing a number. The caller's todo snapshot
 * keeps the full raw content — this returns a projection, it never mutates.
 *
 * No mrkdwn escaping: both title fields are plain text, so escaping would
 * corrupt the rendered characters. (The mrkdwn *fallback lines* are escaped
 * separately, where it is actually required.)
 */
function buildTaskDisplayTitle(text: string): string {
  if (text.length <= MAX_TASK_CONTENT_LENGTH) return text;
  return text.slice(0, MAX_TASK_CONTENT_LENGTH - 1) + '…';
}

/**
 * Renders a todo snapshot for the turn surface: the B2 plan block
 * ({@link TaskListBlockBuilder.buildPlanTasks}) and the native streaming
 * chunks ({@link TaskListBlockBuilder.buildTaskChunks}). Static only — neither
 * path needs a `TodoManager`; blocked state is computed inline.
 */
export class TaskListBlockBuilder {
  /**
   * P2 entry point — build plan + task_card blocks for the `TurnSurface` B2
   * slot, plus a plain-text top-level fallback and a classic mrkdwn section
   * fallback block.
   *
   * Returns `{ text, blocks }` where:
   *   - `text`: newline-separated emoji-prefixed summary (renders in push
   *     notifications and old Slack clients).
   *   - `blocks`:
   *       1. `{ type: 'plan', title: <plain_text>, tasks: [task_card, ...] }`
   *          — rich rendering on new clients (Block Kit 2026-02+). The
   *          `title` field is a Slack plain_text composition object and is
   *          REQUIRED by the plan block schema; omitting it triggers
   *          `invalid_blocks` ("missing required field: title
   *          [json-pointer:/blocks/0]") on `chat.postMessage`/`chat.update`.
   *          The title shows up as the plan card header — we surface a
   *          `Tasks (N)` count so users can see the scope at a glance.
   *       2. `{ type: 'section', text: { type: 'mrkdwn', text: '...' } }` —
   *          fallback visible on old clients that silently drop unknown plan
   *          blocks. Content is mrkdwn-escaped to prevent injection from
   *          user-supplied todo content.
   *
   * Static: this path does NOT depend on a TodoManager instance. Blocked
   * state is computed inline via `computeEffectiveStatus`.
   *
   * Empty / undefined input returns `{ text: '', blocks: [] }` so callers
   * can short-circuit without a special-case branch.
   */
  static buildPlanTasks(todos: Todo[], options?: BuildPlanTasksOptions): { text: string; blocks: any[] } {
    if (!todos || todos.length === 0) {
      return { text: '', blocks: [] };
    }

    const rows = buildTaskRows(todos, options?.final === true);

    // ── 1. Top-level text (plain, unescaped — Slack renders verbatim) ──
    const textLines: string[] = [];
    const taskCards: Record<string, unknown>[] = [];
    const fallbackLines: string[] = [];

    for (const row of rows) {
      const icon = STATUS_ICON[row.effective];

      // Top-level text line — uses raw content so push notifications read
      // naturally. Slack treats this field as plain text, so mrkdwn-escaping
      // is not required here.
      textLines.push(`${icon} ${row.content}`);

      // task_card — title is plain text per Slack schema, and goes through
      // the SAME display-title builder as the native task_update chunk so
      // the two surfaces cannot show different names for one todo.
      taskCards.push({
        type: 'task_card',
        task_id: row.id,
        title: buildTaskDisplayTitle(row.content),
        status: toTaskCardStatus(row.effective),
      });

      // Fallback mrkdwn line — escaped against injection.
      fallbackLines.push(`${icon} ${escapeMrkdwn(row.content)}`);
    }

    const planBlock: Record<string, unknown> = {
      type: 'plan',
      // #1005 — the `plan` block's `title` MUST be a bare string. Emitting a
      // `plain_text` composition object here made Slack reject the whole
      // payload with `invalid_blocks` ("must provide a string
      // [json-pointer:/blocks/0/title]"), which silently dropped every plan
      // card (~525 chat.postMessage failures/rotation). The sibling
      // `task_card` block above already uses a bare string title.
      title: `Tasks (${todos.length})`,
      tasks: taskCards,
    };

    const sectionFallback: Record<string, unknown> = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: fallbackLines.join('\n'),
      },
    };

    return {
      text: textLines.join('\n'),
      blocks: [planBlock, sectionFallback],
    };
  }

  /**
   * U10a entry point — build the native streaming chunks that render the task
   * list *inside* the B1 stream message (`chat.startStream` with
   * `task_display_mode: 'plan'`), instead of as a separate B2 plan message.
   *
   * Returns `{ title, tasks }`:
   *   - `title`: the `plan_update` chunk title (same `Tasks (N)` wording the
   *     B2 plan block uses, so the two surfaces read identically).
   *   - `tasks`: one `task_update` chunk per todo. `id` is the Slack chunk
   *     identity — re-sending the same `id` with a new `status` updates the
   *     existing row in place rather than appending a new one, which is what
   *     makes repeated renders idempotent on the wire.
   *
   * Status mapping and the `final` demotion are shared with `buildPlanTasks`
   * via `buildTaskRows`, so the native surface and the plan-block fallback
   * can never disagree about what "done" means.
   *
   * Empty / undefined input returns `{ title: '', tasks: [] }` so callers can
   * short-circuit without a special-case branch.
   */
  static buildTaskChunks(todos: Todo[], final = false): { title: string; tasks: TaskUpdateChunk[] } {
    if (!todos || todos.length === 0) {
      return { title: '', tasks: [] };
    }

    const rows = buildTaskRows(todos, final === true);
    return {
      title: `Tasks (${todos.length})`,
      tasks: rows.map((row) => ({
        type: 'task_update' as const,
        id: row.id,
        title: buildTaskDisplayTitle(row.content),
        status: toTaskCardStatus(row.effective),
      })),
    };
  }
}
